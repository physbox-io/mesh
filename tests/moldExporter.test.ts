import { describe, it, expect } from 'vitest';
import {
  generateMoldMeshes,
  exportBinarySTL,
  computeNormal,
  DEFAULT_MOLD_OPTIONS,
  type Triangle3D,
} from '../src/utils/moldExporter';
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
