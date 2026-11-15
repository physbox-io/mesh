// ---------------------------------------------------------------------------
// Sheet parts as cut: laser and router panels, and contour layers
// ---------------------------------------------------------------------------
//
// A sheet job's parts are flat: an outline and its holes, cut through stock of
// one thickness. What comes off the machine is that outline extruded, with one
// correction for a router. A round bit cannot cut a sharp inside corner, and
// cannot get into a slot narrower than itself, so what it leaves is the outline
// grown by the bit's radius and shrunk back again: inside corners filled to the
// bit's radius, slots too narrow for it never cut. A laser's kerf is
// compensated in the program, so its parts are the outlines as drawn.
//
// Each part is placed by a frame: an origin and two in-plane axes, in the
// scene's Z-up millimetres, and a slab from `zFrom` to `zTo` along their
// normal. A laser panel is a slab about its mid-plane in its place in the
// assembly; a contour layer is a slab on the one below it.

import { ShapeUtils, Vector2 } from 'three';
import { nestingDepths, offsetNestedLoops, pointInPolygon, signedArea2 } from './polygonOffset';
import type { LaserPanel, Point2D, SheetSpec } from './laserCutExporter';
import type { ContourLayer } from './contourSliceExporter';
import type { StockTransform } from './reliefCarveExporter';
import { enclosedVolume } from './simulationMesh';

export interface SheetPart {
  /** Outlines, holes and islands, mm in the part's plane. Nesting, not winding, says which is which. */
  loops: Point2D[][];
  origin: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  /** The slab, along u x v from the origin, mm. */
  zFrom: number;
  zTo: number;
  /**
   * A gap left off the bottom of the slab so it shows as a separate sheet, mm.
   * Drawn only: the volume still counts the full slab.
   */
  seamMm?: number;
}

export interface SheetJobOptions {
  parts: SheetPart[];
  /** A router's bit radius, mm; 0 or absent for a laser. */
  routerRadiusMm?: number;
}

export interface SheetJobResult {
  positions: Float32Array;
  faces: Uint32Array;
  volumeMm3: number;
  /** Area of the outlines as drawn and as the machine leaves them, mm². */
  drawnAreaMm2: number;
  cutAreaMm2: number;
}

const area = (loop: Point2D[]) => signedArea2(loop) / 2;

/**
 * A loop without a repeated last point, or points on top of each other. Three's
 * triangulator drops those itself, which would shift its indices off ours.
 */
function cleanLoop(loop: Point2D[]): Point2D[] {
  const out: Point2D[] = [];
  for (const p of loop) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= 1e-6) out.pop();
  return out;
}

/** What a round bit of `radius` leaves of a region: grown, then shrunk back. */
export function routerClosing(loops: Point2D[][], radius: number): Point2D[][] {
  if (!(radius > 0)) return loops;
  const grown = offsetNestedLoops(loops, radius).paths;
  return offsetNestedLoops(grown, -radius).paths;
}

/** Net area of a region, holes taken off, mm². */
export function regionArea(loops: Point2D[][]): number {
  const depths = nestingDepths(loops);
  return loops.reduce((s, l, i) => s + (depths[i] % 2 ? -1 : 1) * Math.abs(area(l)), 0);
}

export function runSheetJob(o: SheetJobOptions, onProgress?: (fraction: number) => void): SheetJobResult {
  const positions: number[] = [];
  const faces: number[] = [];
  let drawnAreaMm2 = 0, cutAreaMm2 = 0, seamVolumeMm3 = 0;

  o.parts.forEach((part, p) => {
    onProgress?.(p / o.parts.length);
    const drawn = part.loops.map(cleanLoop).filter((l) => l.length >= 3);
    const loops = routerClosing(drawn, o.routerRadiusMm ?? 0).map(cleanLoop).filter((l) => l.length >= 3);
    drawnAreaMm2 += regionArea(drawn);
    cutAreaMm2 += regionArea(loops);
    if (loops.length === 0) return;

    // Material on the left of every loop: outlines anticlockwise, holes clockwise.
    const depths = nestingDepths(loops);
    const oriented = loops.map((l, i) => {
      const hole = depths[i] % 2 === 1;
      return (area(l) > 0) === !hole ? l : [...l].reverse();
    });

    const [ox, oy, oz] = part.origin;
    const [ux, uy, uz] = part.u;
    const [vx, vy, vz] = part.v;
    // The normal the slab is measured along; u, v, n right-handed, so a loop
    // anticlockwise in (u, v) is anticlockwise seen from +n.
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    nx /= nl; ny /= nl; nz /= nl;
    const at = (pt: Point2D, z: number) => {
      positions.push(
        ox + pt.x * ux + pt.y * vx + z * nx,
        oy + pt.x * uy + pt.y * vy + z * ny,
        oz + pt.x * uz + pt.y * vz + z * nz
      );
      return positions.length / 3 - 1;
    };

    // Each loop's vertices, bottom and top, in order.
    const bottom: number[][] = [], top: number[][] = [];
    const seam = Math.max(0, Math.min(part.seamMm ?? 0, (part.zTo - part.zFrom) / 2));
    seamVolumeMm3 += regionArea(loops) * seam;
    for (const loop of oriented) {
      bottom.push(loop.map((pt) => at(pt, part.zFrom + seam)));
      top.push(loop.map((pt) => at(pt, part.zTo)));
    }

    // Walls.
    oriented.forEach((loop, l) => {
      for (let i = 0; i < loop.length; i++) {
        const j = (i + 1) % loop.length;
        const ta = top[l][i], tb = top[l][j], ba = bottom[l][i], bb = bottom[l][j];
        faces.push(ta, ba, bb, ta, bb, tb);
      }
    });

    // Caps: each outline with the holes directly inside it.
    oriented.forEach((outer, l) => {
      if (depths[l] % 2 === 1) return;
      const holes = oriented
        .map((_, h) => h)
        .filter((h) => depths[h] === depths[l] + 1 && pointInPolygon(oriented[h][0], outer));
      const contour = outer.map((pt) => new Vector2(pt.x, pt.y));
      const holePts = holes.map((h) => oriented[h].map((pt) => new Vector2(pt.x, pt.y)));
      const tris = ShapeUtils.triangulateShape(contour, holePts);
      const flatIndex = [l, ...holes];
      const lookup = (k: number, layer: number[][]) => {
        for (const idx of flatIndex) {
          if (k < oriented[idx].length) return layer[idx][k];
          k -= oriented[idx].length;
        }
        throw new Error('triangulation index out of range');
      };
      const flat = [outer, ...holes.map((h) => oriented[h])].flat();
      for (const [a, b, c] of tris) {
        const pa = flat[a], pb = flat[b], pc = flat[c];
        const ccw = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x) > 0;
        const [i0, i1, i2] = ccw ? [a, b, c] : [a, c, b];
        faces.push(lookup(i0, top), lookup(i1, top), lookup(i2, top));
        faces.push(lookup(i0, bottom), lookup(i2, bottom), lookup(i1, bottom));
      }
    });
  });
  onProgress?.(1);

  const pos = new Float32Array(positions);
  const tri = new Uint32Array(faces);
  return { positions: pos, faces: tri, volumeMm3: enclosedVolume(pos, tri) + seamVolumeMm3, drawnAreaMm2, cutAreaMm2 };
}

/**
 * Laser or router panels, each back in its place in the assembly, at the
 * thickness of the sheet it is nested on (or faced down to its drawn thickness
 * when CNC `faceToThickness` machines off thicker rack stock).
 */
export function laserSheetParts(
  panels: LaserPanel[],
  sheets?: SheetSpec[],
  options?: { faceToThickness?: boolean }
): SheetPart[] {
  return panels.map((panel) => {
    const off = panel.modelOffset2D ?? { x: 0, y: 0 };
    // The loops as cut are normalised to the sheet, and maybe turned a
    // quarter to fit it; undone, they are in the panel's own (u, v) frame.
    const w = panel.width2D ?? 0;
    const back = (pt: Point2D): Point2D => {
      const x = panel.turnedOnSheet ? pt.y : pt.x;
      const y = panel.turnedOnSheet ? w - pt.x : pt.y;
      return { x: x + off.x, y: y + off.y };
    };
    const drawnMm = panel.thickness * 1000;
    const stockMm = sheets?.[panel.sheetIndex ?? 0]?.thicknessMm ?? drawnMm;
    const t = options?.faceToThickness && stockMm - drawnMm > 0.1 ? drawnMm : stockMm;
    const o = panel.origin3D, u = panel.uAxis3D, v = panel.vAxis3D;
    return {
      loops: [panel.outerPolygon2D, ...panel.innerCutouts2D].map((l) => l.map(back)),
      origin: [o.x * 1000, o.y * 1000, o.z * 1000],
      u: [u.x, u.y, u.z],
      v: [v.x, v.y, v.z],
      zFrom: -t / 2,
      zTo: t / 2,
    };
  });
}

/** Where a laser assembly at `scale` came from: the model, `scale` times smaller. */
export function laserStockTransform(panels: LaserPanel[], scale: number): StockTransform {
  const safeScale = scale > 0 ? scale : 1;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const include3D = (x: number, y: number, z: number, n: { x: number; y: number; z: number }, halfThickM: number) => {
    for (const sign of [-1, 1]) {
      const px = ((x + sign * halfThickM * n.x) * 1000) / safeScale;
      const py = ((y + sign * halfThickM * n.y) * 1000) / safeScale;
      const pz = ((z + sign * halfThickM * n.z) * 1000) / safeScale;
      lo[0] = Math.min(lo[0], px); hi[0] = Math.max(hi[0], px);
      lo[1] = Math.min(lo[1], py); hi[1] = Math.max(hi[1], py);
      lo[2] = Math.min(lo[2], pz); hi[2] = Math.max(hi[2], pz);
    }
  };
  for (const p of panels) {
    const nl = Math.hypot(p.normal3D.x, p.normal3D.y, p.normal3D.z) || 1;
    const n = { x: p.normal3D.x / nl, y: p.normal3D.y / nl, z: p.normal3D.z / nl };
    const halfThickM = Math.max(0, p.thickness / 2);
    if (p.edges3D.length > 0) {
      for (const e of p.edges3D) {
        include3D(e.p1.x, e.p1.y, e.p1.z, n, halfThickM);
        include3D(e.p2.x, e.p2.y, e.p2.z, n, halfThickM);
      }
    } else {
      const off = p.modelOffset2D ?? { x: 0, y: 0 };
      const w = p.width2D ?? 0;
      for (const pt of p.outerPolygon2D) {
        const uMm = (p.turnedOnSheet ? pt.y : pt.x) + off.x;
        const vMm = (p.turnedOnSheet ? w - pt.x : pt.y) + off.y;
        include3D(
          p.origin3D.x + (uMm / 1000) * p.uAxis3D.x + (vMm / 1000) * p.vAxis3D.x,
          p.origin3D.y + (uMm / 1000) * p.uAxis3D.y + (vMm / 1000) * p.vAxis3D.y,
          p.origin3D.z + (uMm / 1000) * p.uAxis3D.z + (vMm / 1000) * p.vAxis3D.z,
          n,
          halfThickM
        );
      }
    }
  }
  if (!Number.isFinite(lo[0])) {
    lo[0] = lo[1] = lo[2] = 0;
    hi[0] = hi[1] = hi[2] = 0;
  }
  return {
    modelOriginMm: [0, 0, 0],
    workOriginMm: [0, 0, 0],
    scale: [safeScale, safeScale, safeScale],
    modelMinMm: lo as [number, number, number],
    modelMaxMm: hi as [number, number, number],
  };
}

/**
 * Contour layers, each stacked on the one below. Identical layers stacked flush
 * drew as one solid block, so a stack of six sheets looked like nothing had
 * been sliced; every layer but the bottom one stands on a hairline seam.
 */
export function contourSheetParts(layers: ContourLayer[], thicknessMm: number): SheetPart[] {
  const seamMm = Math.min(1, thicknessMm * 0.05);
  const parts: SheetPart[] = [];
  let zMm = 0;
  for (const layer of layers) {
    const loops = (layer.nominalLoops ?? layer.loops).filter((l) => l.length >= 3);
    if (loops.length === 0) continue;
    const slabMm = layer.facedToMm !== undefined && layer.facedToMm > 0 ? layer.facedToMm : thicknessMm;
    parts.push({
      seamMm: parts.length > 0 ? seamMm : 0,
      loops,
      origin: [0, 0, zMm],
      u: [1, 0, 0],
      v: [0, 1, 0],
      zFrom: 0,
      // The top layer as faced down to the model's top.
      zTo: slabMm,
    });
    zMm += slabMm;
  }
  return parts;
}
