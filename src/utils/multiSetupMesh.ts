/**
 * The part left by several setups, each cut from a different face of the block.
 *
 * A 3-axis cut from one face removes everything above that face's cutter
 * envelope, so each setup is simulated as any other (`simulateMilling`, in its
 * own frame, on its own up-face grid) and gives a height map H_k. A point p of
 * the block (in setup 1's frame) is still there when it is under every one of
 * them:
 *
 *   f(p) = min( box(p), min_k ( H_k(x'_k, y'_k) - z'_k ) ),  (x', y', z')_k = R_k p + t_k
 *
 * f is continuous and exact to the height maps' resolution, so the part is its
 * f >= 0 region, meshed here with surface nets. No voxel is ever cut.
 */

import { simulateMilling, type CutResult, type MoveCut, type SimTool } from './cutSimulation';
import { enclosedVolume } from './simulationMesh';

export interface SimulationSetup {
  gcode: string;
  /** Setup 1's frame to this one's, row-major, and the offset: `p' = R p + t`. */
  rotation: number[];
  translation: [number, number, number];
  /** The block as it stands for this setup. */
  stock: { widthMm: number; depthMm: number; thicknessMm: number };
}

export interface MultiSetupCut {
  heights: CutResult[];
  cuts: MoveCut[];
  /** f at a point of setup 1's frame: >= 0 where material is left. */
  field: (x: number, y: number, z: number) => number;
}

/** Each setup cut out of a fresh block in its own frame. Rapids are checked per setup, so conservatively. */
export function cutSetups(
  setups: SimulationSetup[],
  tools: Record<number, SimTool>,
  initialTool: number,
  stock: { widthMm: number; depthMm: number; thicknessMm: number },
  cellMm?: number,
  onProgress?: (fraction: number) => void
): MultiSetupCut {
  const heights = setups.map((s, k) =>
    simulateMilling(s.gcode, {
      widthMm: s.stock.widthMm,
      depthMm: s.stock.depthMm,
      tools,
      initialTool,
      cellMm,
      onProgress: onProgress ? (f) => onProgress((k + f) / setups.length) : undefined,
    })
  );
  let cuts: MoveCut[] = [];
  for (const h of heights) cuts = cuts.concat(h.cuts);
  const { widthMm: W, depthMm: D, thicknessMm: T } = stock;
  const field = (x: number, y: number, z: number) => {
    let f = Math.min(x, W - x, y, D - y, -z, T + z);
    for (let k = 0; k < setups.length; k++) {
      const s = setups[k], R = s.rotation, t = s.translation;
      const px = R[0] * x + R[1] * y + R[2] * z + t[0];
      const py = R[3] * x + R[4] * y + R[5] * z + t[1];
      const pz = R[6] * x + R[7] * y + R[8] * z + t[2];
      const h = heights[k];
      // Off this setup's grid is off the block, which the box already says.
      if (px < 0 || py < 0 || px > s.stock.widthMm || py > s.stock.depthMm) continue;
      const v = h.at(px, py) - pz;
      if (v < f) f = v;
    }
    return f;
  };
  return { heights, cuts, field };
}

export interface FieldMesh {
  positions: Float32Array;
  faces: Uint32Array;
  cellMm: number;
  volumeMm3: number;
  /** Material over a plan rectangle of setup 1's frame, mm³, when asked for. */
  measure: (inside: (x: number, y: number) => boolean) => number;
}

/**
 * Surface nets over the block: one vertex per grid cell the surface passes
 * through, at the mean of where it crosses that cell's edges, and a quad
 * across every grid edge it crosses. Closed, and wound outward, because
 * every crossing edge has exactly the four cells round it and the quad's
 * order follows which end of the edge is inside.
 */
export function meshField(
  field: (x: number, y: number, z: number) => number,
  stock: { widthMm: number; depthMm: number; thicknessMm: number },
  opts: { minCellMm?: number; maxTriangles?: number } = {}
): FieldMesh {
  const { widthMm: W, depthMm: D, thicknessMm: T } = stock;
  const area = 2 * (W * D + W * T + D * T);
  const maxTriangles = opts.maxTriangles ?? 200_000;
  // A surface of area A drawn at cell h is about 2.6 A / h² triangles, carved
  // detail included; and never more than twelve million samples.
  const h = Math.max(opts.minCellMm ?? 0.1, Math.sqrt((2.6 * area) / maxTriangles), Math.cbrt((W * D * T) / 12e6));
  // One cell of air all round, so the surface closes on the block's own faces.
  const x0 = -h, y0 = -h, z0 = -T - h;
  const nx = Math.ceil((W + 2 * h) / h), ny = Math.ceil((D + 2 * h) / h), nz = Math.ceil((T + 2 * h) / h);
  const vx = nx + 1, vy = ny + 1, vz = nz + 1;
  const f = new Float32Array(vx * vy * vz);
  const vi = (i: number, j: number, k: number) => (k * vy + j) * vx + i;
  for (let k = 0; k < vz; k++) {
    const z = z0 + k * h;
    for (let j = 0; j < vy; j++) {
      const y = y0 + j * h;
      for (let i = 0; i < vx; i++) f[vi(i, j, k)] = field(x0 + i * h, y, z);
    }
  }

  // A vertex in every cell the surface crosses.
  const cellVertex = new Int32Array(nx * ny * nz).fill(-1);
  const ci = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const pos: number[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  const val = new Float32Array(8);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        let inside = 0;
        for (let c = 0; c < 8; c++) {
          val[c] = f[vi(i + corners[c][0], j + corners[c][1], k + corners[c][2])];
          if (val[c] >= 0) inside++;
        }
        if (inside === 0 || inside === 8) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of edges) {
          if ((val[a] >= 0) === (val[b] >= 0)) continue;
          const t = val[a] / (val[a] - val[b]);
          sx += corners[a][0] + t * (corners[b][0] - corners[a][0]);
          sy += corners[a][1] + t * (corners[b][1] - corners[a][1]);
          sz += corners[a][2] + t * (corners[b][2] - corners[a][2]);
          n++;
        }
        cellVertex[ci(i, j, k)] = pos.length / 3;
        pos.push(x0 + (i + sx / n) * h, y0 + (j + sy / n) * h, z0 + (k + sz / n) * h);
      }
    }
  }

  const faces: number[] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (flip) faces.push(a, d, c, a, c, b);
    else faces.push(a, b, c, a, c, d);
  };
  // Every grid edge the surface crosses, with the four cells round it. An
  // edge whose low end is inside has its outward normal along +axis.
  for (let k = 1; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const a = f[vi(i, j, k)] >= 0, b = f[vi(i + 1, j, k)] >= 0;
        if (a === b) continue;
        quad(cellVertex[ci(i, j - 1, k - 1)], cellVertex[ci(i, j, k - 1)], cellVertex[ci(i, j, k)], cellVertex[ci(i, j - 1, k)], !a);
      }
    }
  }
  for (let k = 1; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const a = f[vi(i, j, k)] >= 0, b = f[vi(i, j + 1, k)] >= 0;
        if (a === b) continue;
        quad(cellVertex[ci(i - 1, j, k - 1)], cellVertex[ci(i - 1, j, k)], cellVertex[ci(i, j, k)], cellVertex[ci(i, j, k - 1)], !a);
      }
    }
  }
  for (let k = 0; k < nz; k++) {
    for (let j = 1; j < ny; j++) {
      for (let i = 1; i < nx; i++) {
        const a = f[vi(i, j, k)] >= 0, b = f[vi(i, j, k + 1)] >= 0;
        if (a === b) continue;
        quad(cellVertex[ci(i - 1, j - 1, k)], cellVertex[ci(i, j - 1, k)], cellVertex[ci(i, j, k)], cellVertex[ci(i - 1, j, k)], !a);
      }
    }
  }

  const positions = Float32Array.from(pos);
  const faceArray = Uint32Array.from(faces);
  return {
    positions,
    faces: faceArray,
    cellMm: h,
    volumeMm3: enclosedVolume(positions, faceArray),
    measure: (inside) => {
      // Column by column, the length of each column inside the part: whole
      // spans between samples that are both inside, and where the surface
      // crosses a span, the part of it up to the crossing. Counting samples
      // instead put a whole sample spacing on every column.
      let v = 0;
      for (let j = 1; j < vy - 1; j++) {
        const y = y0 + j * h;
        for (let i = 1; i < vx - 1; i++) {
          const x = x0 + i * h;
          if (!inside(x, y)) continue;
          let len = 0;
          for (let k = 0; k + 1 < vz; k++) {
            const a = f[vi(i, j, k)], b = f[vi(i, j, k + 1)];
            if (a >= 0 && b >= 0) len += h;
            else if (a >= 0 || b >= 0) len += (h * Math.max(a, b)) / (Math.abs(a) + Math.abs(b) || 1);
          }
          v += len * h * h;
        }
      }
      return v;
    },
  };
}
