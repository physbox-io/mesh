import { describe, it, expect } from 'vitest';
import {
  generateMoldMeshes,
  exportBinarySTL,
  computeNormal,
  DEFAULT_MOLD_OPTIONS,
  trianglesToBuffers,
  moldSummary,
  type Triangle3D,
} from '../src/utils/moldExporter';
import { MoldWorkerClient } from '../src/utils/moldWorkerClient';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

function bodyWith(geom: Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] }, pos = [0, 0, 0]): SceneGraph {
  return {
    nodes: [
      {
        id: 'b1',
        name: 'part',
        type: 'body',
        pos,
        geoms: [{ name: 'g1', ...geom } as SceneGeom],
        joints: [],
        children: [],
      },
    ],
  };
}

const dome = bodyWith({ type: 'sphere', size: [0.03] }, [0, 0, 0]); // 60mm diameter sphere
const box = bodyWith({ type: 'box', size: [0.025, 0.02, 0.015] }, [0, 0, 0.015]); // 50x40x30mm box

describe('Binary STL Exporter', () => {
  it('encodes valid Little-Endian Binary STL header, count, and triangles', () => {
    const tris: Triangle3D[] = [
      {
        a: [0, 0, 0],
        b: [10, 0, 0],
        c: [0, 10, 0],
        normal: [0, 0, 1],
      },
      {
        a: [10, 0, 0],
        b: [10, 10, 0],
        c: [0, 10, 0],
        normal: [0, 0, 1],
      },
    ];

    const bytes = exportBinarySTL(tris, 'Test Mold');
    expect(bytes.length).toBe(80 + 4 + 2 * 50); // 184 bytes

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getUint32(80, true)).toBe(2);

    // First triangle normal
    expect(view.getFloat32(84, true)).toBeCloseTo(0);
    expect(view.getFloat32(88, true)).toBeCloseTo(0);
    expect(view.getFloat32(92, true)).toBeCloseTo(1);

    // First triangle Vertex B (x=10)
    expect(view.getFloat32(84 + 24, true)).toBeCloseTo(10);
  });

  it('computes correct normal vector', () => {
    const norm = computeNormal([0, 0, 0], [1, 0, 0], [0, 1, 0]);
    expect(norm[0]).toBeCloseTo(0);
    expect(norm[1]).toBeCloseTo(0);
    expect(norm[2]).toBeCloseTo(1);
  });
});

describe('3D Mold Generator', () => {
  it('generates a 2-part clamshell mold with top/bottom halves, pins, sprue, and vents', () => {
    const res = generateMoldMeshes(dome, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'clamshell',
      wallMarginMm: 10,
      baseThicknessMm: 5,
      includeSprue: true,
      includeVents: true,
    });

    expect(res.success).toBe(true);
    expect(res.totalTriangles).toBeGreaterThan(100);
    expect(res.binarySTL.length).toBe(84 + res.totalTriangles * 50);

    expect(res.bottomHalf).toBeDefined();
    expect(res.bottomHalf.triangles.length).toBeGreaterThan(50);

    expect(res.topHalf).toBeDefined();
    expect(res.topHalf!.triangles.length).toBeGreaterThan(50);

    // Both halves come out in the one plate. They used to be serialised again
    // as a pair of separate STLs for a second download button; the slicer that
    // opens the plate lays both out anyway, so the extra copies were work done
    // for nothing on every export.
    expect(res.combinedTriangles.length).toBe(
      res.bottomHalf.triangles.length + res.topHalf!.triangles.length
    );

    // Mold dimensions enclose the 60mm dome + 20mm margin (10mm per side)
    expect(res.moldWidthMm).toBeGreaterThanOrEqual(75);
    expect(res.moldDepthMm).toBeGreaterThanOrEqual(75);
  });

  it('generates a 1-part open pour mold', () => {
    const res = generateMoldMeshes(box, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'open',
      wallMarginMm: 8,
      baseThicknessMm: 4,
    });

    expect(res.success).toBe(true);
    expect(res.bottomHalf).toBeDefined();
    expect(res.topHalf).toBeUndefined();
    expect(res.totalTriangles).toBe(res.bottomHalf.triangleCount);
  });

  it('handles empty scene gracefully', () => {
    const emptyScene: SceneGraph = { nodes: [] };
    const res = generateMoldMeshes(emptyScene);
    expect(res.success).toBe(false);
    expect(res.warnings.length).toBeGreaterThan(0);
  });
});

// A flat-backed part: a 40x40x4 mm plate with a 20x20x10 mm boss on top of it.
// This is the shape of every relief plaque -- all of the detail on one face,
// nothing at all behind it -- and it is what a mid-height parting plane wrecks.
const plaque: SceneGraph = {
  nodes: [
    {
      id: 'b1',
      name: 'plaque',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        { name: 'plate', type: 'box', size: [0.02, 0.02, 0.002], pos: [0, 0, 0.002] } as SceneGeom,
        { name: 'boss', type: 'box', size: [0.01, 0.01, 0.005], pos: [0, 0, 0.009] } as SceneGeom,
      ],
      joints: [],
      children: [],
    },
  ],
};

/** Counts half-edges that have no opposite twin, which is what leaks in an STL. */
function unpairedEdges(tris: Triangle3D[]): number {
  const key = (v: [number, number, number]) => v.map((x) => Math.round(x * 1000)).join(',');
  const counts = new Map<string, number>();
  for (const t of tris) {
    const vs = [t.a, t.b, t.c].map(key);
    for (let i = 0; i < 3; i++) {
      const a = vs[i];
      const b = vs[(i + 1) % 3];
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      counts.set(k, (counts.get(k) ?? 0) + (a < b ? 1 : -1));
    }
  }
  let bad = 0;
  for (const v of counts.values()) if (v !== 0) bad++;
  return bad;
}

function zRange(tris: Triangle3D[]) {
  let min = Infinity;
  let max = -Infinity;
  for (const t of tris) for (const v of [t.a, t.b, t.c]) { min = Math.min(min, v[2]); max = Math.max(max, v[2]); }
  return { min, max };
}

describe('Parting plane', () => {
  it('parts a flat-backed part at its back, not through its middle', () => {
    const res = generateMoldMeshes(plaque, {
      ...DEFAULT_MOLD_OPTIONS,
      wallMarginMm: 10,
      baseThicknessMm: 5,
      pinHeightMm: 4,
    });

    expect(res.success).toBe(true);

    // The whole 14 mm of part goes into one half: 14 mm of cavity over a 5 mm floor.
    expect(res.bottomHalf.heightMm).toBeCloseTo(19, 1);
    // The other half has nothing to hold, so it is a 5 mm plate with 4 mm pins.
    expect(res.topHalf!.heightMm).toBeCloseTo(9, 1);

    // Both steps of the part are cut into the cavity: the plate face 4 mm down
    // from the parting plane and the boss face 14 mm down. A mold parted at
    // mid-height flattens both of these to the parting plane.
    const cavityZ = res.bottomHalf.triangles
      .map((t) => (t.a[2] + t.b[2] + t.c[2]) / 3)
      .filter((z) => z > 1);
    expect(cavityZ.some((z) => Math.abs(z - 15) < 0.6)).toBe(true); // plate top
    expect(cavityZ.some((z) => Math.abs(z - 5) < 0.6)).toBe(true); // boss top
    expect(zRange(res.bottomHalf.triangles).max).toBeCloseTo(19, 1);

    expect(res.warnings.join(' ')).toContain('backing plate');
  });

  it('parts a sphere at its equator, where the silhouette is widest', () => {
    const res = generateMoldMeshes(dome, { ...DEFAULT_MOLD_OPTIONS, baseThicknessMm: 5 });
    // 30 mm of hemisphere in each half, over a 5 mm floor.
    expect(res.bottomHalf.heightMm).toBeCloseTo(35, 0);
    expect(res.topHalf!.heightMm).toBeCloseTo(39, 0); // + 4 mm pins
  });

  it('sinks the whole part into a one-part open mold', () => {
    const res = generateMoldMeshes(plaque, { ...DEFAULT_MOLD_OPTIONS, moldType: 'open', baseThicknessMm: 4 });
    expect(res.topHalf).toBeUndefined();
    // 14 mm cavity over a 4 mm floor -- not an empty plate.
    expect(res.bottomHalf.heightMm).toBeCloseTo(18, 1);
  });
});

describe('Printability', () => {
  it('gives each half a closed surface', () => {
    const res = generateMoldMeshes(plaque, DEFAULT_MOLD_OPTIONS);
    expect(unpairedEdges(res.bottomHalf.triangles)).toBe(0);
    expect(unpairedEdges(res.topHalf!.triangles)).toBe(0);
  });

  it('bores the sprue and vents right through the lid instead of sealing them in', () => {
    const res = generateMoldMeshes(plaque, {
      ...DEFAULT_MOLD_OPTIONS,
      includeSprue: true,
      sprueTopDiaMm: 8,
      sprueBottomDiaMm: 4,
      includeVents: true,
    });

    const lid = res.topHalf!.triangles;
    const { min } = zRange(lid);
    // The lid's outer face is open over the sprue axis: no floor triangle sits
    // across the hole. A pocket that never breaks through would leave one there,
    // and the slicer would print straight over the pour hole.
    const lidCentreX = res.topHalf!.bounds.minX + (res.topHalf!.bounds.maxX - res.topHalf!.bounds.minX) / 2;
    const overHole = lid.filter((t) => {
      const cx = (t.a[0] + t.b[0] + t.c[0]) / 3 - lidCentreX;
      const cy = (t.a[1] + t.b[1] + t.c[1]) / 3;
      const cz = (t.a[2] + t.b[2] + t.c[2]) / 3;
      return Math.hypot(cx, cy) < 1.5 && Math.abs(cz - min) < 0.01;
    });
    expect(overHole.length).toBe(0);

    // Turning the sprue off closes it back up.
    const solidLid = generateMoldMeshes(plaque, {
      ...DEFAULT_MOLD_OPTIONS,
      includeSprue: false,
      includeVents: false,
    }).topHalf!.triangles;
    const solidMin = zRange(solidLid).min;
    const covered = solidLid.filter((t) => {
      const cx = (t.a[0] + t.b[0] + t.c[0]) / 3 - lidCentreX;
      const cy = (t.a[1] + t.b[1] + t.c[1]) / 3;
      const cz = (t.a[2] + t.b[2] + t.c[2]) / 3;
      return Math.hypot(cx, cy) < 1.5 && Math.abs(cz - solidMin) < 0.01;
    });
    expect(covered.length).toBeGreaterThan(0);
  });
});

describe('Draft', () => {
  it('leaves the part alone at zero and reports the walls it actually has', () => {
    const res = generateMoldMeshes(plaque, { ...DEFAULT_MOLD_OPTIONS, draftAngleDeg: 0 });
    // The plate and boss walls are vertical, so the mold grips: within a grid
    // cell of dead vertical, which is as steep as a sampled heightfield gets.
    expect(res.minDraftDeg).toBeLessThan(3);
    expect(res.cavityDepthMm).toBeCloseTo(14, 1);
    expect(res.flexibleMoldAdvised).toBe(true);
    expect(res.warnings.join(' ')).toContain('TPU');
  });

  it('tapers the walls to the angle asked for without losing cavity depth', () => {
    const res = generateMoldMeshes(plaque, { ...DEFAULT_MOLD_OPTIONS, draftAngleDeg: 6 });
    expect(res.minDraftDeg).toBeCloseTo(6, 0);
    // The deepest point of the cavity is still the full height of the part: the
    // taper is cut back into the wall, not off the bottom of the pocket.
    expect(res.cavityDepthMm).toBeCloseTo(14, 1);
    expect(res.bottomHalf.heightMm).toBeCloseTo(19, 1);
    // Drafted walls are what let a rigid print release, so the advice changes.
    expect(res.flexibleMoldAdvised).toBe(false);
    expect(res.warnings.join(' ')).not.toContain('TPU');
  });

  it('keeps each half closed once the walls are tapered', () => {
    const res = generateMoldMeshes(plaque, { ...DEFAULT_MOLD_OPTIONS, draftAngleDeg: 6 });
    expect(unpairedEdges(res.bottomHalf.triangles)).toBe(0);
    expect(unpairedEdges(res.topHalf!.triangles)).toBe(0);
  });
});

describe('Worker boundary', () => {
  it('encodes the STL only when it is asked for', () => {
    const res = generateMoldMeshes(plaque, DEFAULT_MOLD_OPTIONS);
    // The preview never reads a byte of it, so nothing should be paid for it
    // until the download button. Reading twice must not encode twice.
    const first = res.binarySTL;
    expect(first).toBe(res.binarySTL);
    expect(first.length).toBe(84 + res.totalTriangles * 50);
  });

  it('flattens a half into transferable arrays that match its triangles', () => {
    const res = generateMoldMeshes(plaque, DEFAULT_MOLD_OPTIONS);
    const buf = trianglesToBuffers(res.bottomHalf.triangles);

    expect(buf.positions.length).toBe(res.bottomHalf.triangles.length * 9);
    expect(buf.normals.length).toBe(buf.positions.length);

    const t = res.bottomHalf.triangles[0];
    expect(Array.from(buf.positions.slice(0, 3))).toEqual(t.a.map((v) => Math.fround(v)));
    expect(Array.from(buf.positions.slice(3, 6))).toEqual(t.b.map((v) => Math.fround(v)));
    // One normal per vertex, all three the face's own.
    expect(Array.from(buf.normals.slice(0, 3))).toEqual(Array.from(buf.normals.slice(3, 6)));
  });

  it('summarises a mold without carrying its geometry across', () => {
    const res = generateMoldMeshes(plaque, DEFAULT_MOLD_OPTIONS);
    const summary = moldSummary(res);

    expect(summary.cavityDepthMm).toBe(res.cavityDepthMm);
    expect(summary.bottomHalf.triangleCount).toBe(res.bottomHalf.triangleCount);
    expect(summary.topHalf!.heightMm).toBe(res.topHalf!.heightMm);
    expect('triangles' in summary.bottomHalf).toBe(false);
    expect('binarySTL' in summary).toBe(false);
    // Whatever it holds has to survive being posted between threads.
    expect(() => structuredClone(summary)).not.toThrow();
  });

  it('generates inline where there is no Worker to hand', async () => {
    // Node has none, which is also the path an old browser takes.
    const client = new MoldWorkerClient();
    const out = await client.generate(plaque, DEFAULT_MOLD_OPTIONS);

    expect(out.summary.success).toBe(true);
    expect(out.bottom.positions.length).toBe(out.summary.bottomHalf.triangleCount * 9);
    expect(out.top!.positions.length).toBe(out.summary.topHalf!.triangleCount * 9);

    const stl = await client.stl();
    expect(stl.length).toBe(84 + out.summary.totalTriangles * 50);
    client.dispose();
  });
});

/** A square picture frame, `outer` mm across with `wall` mm sides, 6 mm tall: a part with a hole in it. */
function frame(outer: number, wall: number): SceneGraph {
  const h = outer / 2000;
  const t = wall / 2000;
  const z = 0.003;
  const geoms = [
    { name: 'n', type: 'box', size: [h, t, z], pos: [0, h - t, z] },
    { name: 's', type: 'box', size: [h, t, z], pos: [0, -h + t, z] },
    { name: 'e', type: 'box', size: [t, h - 2 * t, z], pos: [h - t, 0, z] },
    { name: 'w', type: 'box', size: [t, h - 2 * t, z], pos: [-h + t, 0, z] },
  ] as SceneGeom[];
  return { nodes: [{ id: 'b1', name: 'frame', type: 'body', pos: [0, 0, 0], geoms, joints: [], children: [] }] };
}

/**
 * The openings in a lid's outer face, as cells of a 0.5 mm raster in the
 * part's frame (the lid's mirror in Y undone), grouped into separate holes.
 */
function lidHoles(res: ReturnType<typeof generateMoldMeshes>): Array<Array<{ x: number; y: number }>> {
  const lid = res.topHalf!;
  const floorZ = zRange(lid.triangles).min;
  const cx = (lid.bounds.minX + lid.bounds.maxX) / 2;
  const step = 0.5;
  const halfW = res.moldWidthMm / 2;
  const halfD = res.moldDepthMm / 2;
  const nc = Math.ceil((2 * halfW) / step);
  const nr = Math.ceil((2 * halfD) / step);
  const covered = new Uint8Array(nc * nr);
  for (const t of lid.triangles) {
    if ([t.a, t.b, t.c].some((v) => Math.abs(v[2] - floorZ) > 1e-6)) continue;
    const xs = [t.a[0], t.b[0], t.c[0]].map((x) => x - cx + halfW);
    const ys = [t.a[1], t.b[1], t.c[1]].map((y) => y + halfD);
    for (let r = Math.floor(Math.min(...ys) / step); r < Math.ceil(Math.max(...ys) / step) && r < nr; r++) {
      for (let c = Math.floor(Math.min(...xs) / step); c < Math.ceil(Math.max(...xs) / step) && c < nc; c++) {
        covered[r * nc + c] = 1;
      }
    }
  }
  const seen = new Uint8Array(nc * nr);
  const holes: Array<Array<{ x: number; y: number }>> = [];
  for (let s = 0; s < nc * nr; s++) {
    if (covered[s] || seen[s]) continue;
    const cells: Array<{ x: number; y: number }> = [];
    const queue = [s];
    seen[s] = 1;
    while (queue.length) {
      const i = queue.pop()!;
      const c = i % nc;
      const r = Math.floor(i / nc);
      // Back into the part's frame: the lid is built mirrored in Y.
      cells.push({ x: (c + 0.5) * step - halfW, y: -((r + 0.5) * step - halfD) });
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cc = c + dc;
        const rr = r + dr;
        if (cc < 0 || rr < 0 || cc >= nc || rr >= nr) continue;
        const j = rr * nc + cc;
        if (!covered[j] && !seen[j]) {
          seen[j] = 1;
          queue.push(j);
        }
      }
    }
    holes.push(cells);
  }
  return holes;
}

describe('Pour channels', () => {
  const onFrame = (p: { x: number; y: number }, outer: number, wall: number) =>
    Math.max(Math.abs(p.x), Math.abs(p.y)) < outer / 2 && Math.max(Math.abs(p.x), Math.abs(p.y)) > outer / 2 - wall;

  it('pours and vents into a ring-shaped cavity, not into the hole in its middle', () => {
    const res = generateMoldMeshes(frame(40, 10), {
      ...DEFAULT_MOLD_OPTIONS,
      includeSprue: true,
      includeVents: true,
    });
    const holes = lidHoles(res);
    expect(holes.length).toBe(3);
    for (const hole of holes) {
      for (const cell of hole) expect(onFrame(cell, 40, 10)).toBe(true);
    }
  });

  it('opens a 1.5 mm vent on the coarse grid of a large mold', () => {
    // A 240 mm part gets the 1.5 mm grid, as wide as the vent itself.
    const res = generateMoldMeshes(frame(240, 40), {
      ...DEFAULT_MOLD_OPTIONS,
      includeSprue: false,
      includeVents: true,
      ventDiaMm: 1.5,
    });
    const holes = lidHoles(res);
    expect(holes.length).toBe(2);
    for (const hole of holes) {
      for (const cell of hole) expect(onFrame(cell, 240, 40)).toBe(true);
    }
    expect(unpairedEdges(res.topHalf!.triangles)).toBe(0);
  });

  it('aligns lid sprue and vents with an asymmetric Y-offset cavity when closed onto the base', () => {
    // Two unequal strips in Y: a thin reference bar at y = -15 mm and the main
    // casting bar at y = +10 mm. Both sit on z = 0 (`detailIsAbove === true`).
    // In the base half (`mirrorY(above)`), the main bar is at y around -10 mm.
    // When the lid is flipped around X (`y -> -y`) to close onto the base, a
    // hole at `y_lid` lands at `y_base = -y_lid`, so `lidHoles` (which records
    // `-y_lid` in part coordinates) must fall inside the main bar at y > 0.
    const asymmetricY: ParsedScene = {
      nodes: [
        {
          id: 'b1',
          name: 'asym',
          type: 'body',
          pos: [0, 0, 0],
          geoms: [
            { name: 'ref', type: 'box', size: [0.02, 0.0004, 0.004], pos: [0, -0.015, 0.004] } as SceneGeom,
            { name: 'main', type: 'box', size: [0.02, 0.008, 0.006], pos: [0, 0.01, 0.006] } as SceneGeom,
          ],
          joints: [],
          children: [],
        },
      ],
    };
    const res = generateMoldMeshes(asymmetricY, {
      ...DEFAULT_MOLD_OPTIONS,
      includeSprue: true,
      includeVents: true,
    });
    const holes = lidHoles(res);
    expect(holes.length).toBeGreaterThanOrEqual(2);
    // `lidHoles` returns `(x_lid, -y_lid)`, which is the exact `(x_base, y_base)`
    // coordinate where each hole lands when the lid is flipped around X (`y -> -y`)
    // to close onto the base. In `base` (`mirrorY(above)`), the `main` bar cavity
    // sits at `y_base < -2`, so every flipped hole cell must land inside `main`
    // (`cell.y < -2`), never on the uncarved mold wall at `y_base > 0`.
    for (const hole of holes) {
      for (const cell of hole) {
        expect(cell.y).toBeLessThan(-2);
      }
    }
  });
});

describe('One-part open mold and parting overhang checks', () => {
  it('preserves full part height in open mold mode and centers the mesh at X = 0', () => {
    const res = generateMoldMeshes(dome, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'open',
      draftAngleDeg: 0,
    });
    expect(res.success).toBe(true);
    expect(res.topHalf).toBeUndefined();
    // Full 60 mm sphere diameter (plus 0.3 mm Z clearance), not 30 mm half-sphere.
    expect(res.cavityDepthMm).toBeGreaterThan(58);
    // Centered on X = 0 matching moldBounds.
    const cx = (res.bottomHalf.bounds.minX + res.bottomHalf.bounds.maxX) / 2;
    expect(Math.abs(cx)).toBeLessThan(1e-3);
    expect(res.bottomHalf.bounds.minX).toBeCloseTo(res.moldBounds.minX, 3);
    expect(res.bottomHalf.bounds.maxX).toBeCloseTo(res.moldBounds.maxX, 3);
    expect(unpairedEdges(res.bottomHalf.triangles)).toBe(0);
    // Lower hemisphere undercuts in a 1-part open mold must warn.
    expect(res.warnings.some((w) => /undercut|overhang/i.test(w))).toBe(true);
  });

  it('warns when a feature overhangs the parting plane with empty space beneath it', () => {
    // Base block on z = [0, 10 mm] with an overhanging cantilever arm at z = [6, 10 mm]
    // sticking out in +X over empty air at z = 0 (parting plane is z = 0).
    const cantilever: ParsedScene = {
      nodes: [
        {
          id: 'b1',
          name: 'cantilever',
          type: 'body',
          pos: [0, 0, 0],
          geoms: [
            { name: 'stem', type: 'box', size: [0.01, 0.01, 0.005], pos: [0, 0, 0.005] } as SceneGeom,
            { name: 'ledge', type: 'box', size: [0.01, 0.01, 0.002], pos: [0.015, 0, 0.008] } as SceneGeom,
          ],
          joints: [],
          children: [],
        },
      ],
    };
    const res = generateMoldMeshes(cantilever, DEFAULT_MOLD_OPTIONS);
    expect(res.warnings.some((w) => /undercut|overhang/i.test(w))).toBe(true);
  });

  it('keeps the keyed corner pin and side pry notches outside a rectangular cavity', () => {
    // 40 x 40 x 12 mm rectangular block filling the entire inner footprint.
    const rectBlock: ParsedScene = {
      nodes: [
        {
          id: 'b1',
          name: 'block',
          type: 'body',
          pos: [0, 0, 0],
          geoms: [{ name: 'g1', type: 'box', size: [0.02, 0.02, 0.006], pos: [0, 0, 0.006] } as SceneGeom],
          joints: [],
          children: [],
        },
      ],
    };
    const res = generateMoldMeshes(rectBlock, {
      ...DEFAULT_MOLD_OPTIONS,
      includeKeys: true,
      includePryNotches: true,
    });
    expect(res.success).toBe(true);
    expect(unpairedEdges(res.bottomHalf.triangles)).toBe(0);
    expect(unpairedEdges(res.topHalf!.triangles)).toBe(0);

    // Every pin protrusion vertex on the lid (above its 5 mm backing plate parting face)
    // must remain at least 1.5 mm outside the 40 x 40 mm cavity footprint in both X and Y.
    const lidCx = (res.topHalf!.bounds.minX + res.topHalf!.bounds.maxX) / 2;
    const lidPartingFaceZ = res.topHalf!.heightMm - DEFAULT_MOLD_OPTIONS.pinHeightMm;
    let pinVertexCount = 0;
    for (const t of res.topHalf!.triangles) {
      for (const v of [t.a, t.b, t.c]) {
        if (v[2] > lidPartingFaceZ + 0.1) {
          pinVertexCount++;
          const lx = Math.abs(v[0] - lidCx);
          const ly = Math.abs(v[1]);
          expect(lx).toBeGreaterThan(21);
          expect(ly).toBeGreaterThan(21);
        }
      }
    }
    expect(pinVertexCount).toBeGreaterThan(0);
  });
});

