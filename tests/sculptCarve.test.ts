import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { applyBrush, beginStroke, DEFAULT_BRUSH, endStroke, icosphere, isWatertight, recomputeNormals, type SculptMesh } from '../src/utils/sculptMesh';
import { cutSculpt, cutSculptWith, loadManifold } from '../src/utils/sculptCut';
import { closestOnSurface, grooveAlongSurface, type CarveProfile, type GrooveSpec } from '../src/utils/sculptCarve';
import { createSculptMesh, splitComponents } from '../src/utils/sculptMesh';

const R = 0.035; // pumpkin-sized clay

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

/** A 20 mm arc round the clay's equator, on the -X side, as a mouth would be. */
function arc(points = 21): { path: number[][]; normals: number[][] } {
  const path: number[][] = [], normals: number[][] = [];
  for (let i = 0; i < points; i++) {
    const a = Math.PI + (-0.3 + (0.6 * i) / (points - 1));
    const n = [Math.cos(a), Math.sin(a), 0];
    normals.push(n);
    path.push([n[0] * R, n[1] * R, 0]);
  }
  return { path, normals };
}

function groove(profile: CarveProfile, extra: Partial<GrooveSpec> = {}): GrooveSpec {
  return { kind: 'groove', ...arc(), width: 0.003, depth: 0.0025, profile, ...extra };
}

function carve(spec: GrooveSpec): SculptMesh {
  const result = cutSculptWith(wasm, icosphere(R, 4), spec);
  if (!result.ok) throw new Error(result.error);
  return result.mesh;
}

/** How far inside the sphere the deepest point is, mm. */
function deepestMm(mesh: SculptMesh): number {
  let deepest = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    deepest = Math.max(deepest, R - Math.hypot(mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]));
  }
  return deepest * 1000;
}

/** How wide the groove is at mid-arc, across it (along Z), mm: the furthest cut vertex either side. */
function widthMm(mesh: SculptMesh): number {
  let half = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const [x, y, z] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    if (x > 0 || Math.abs(y) > 0.0005) continue;
    if (R - Math.hypot(x, y, z) < 1e-4) continue; // not cut into
    half = Math.max(half, Math.abs(z));
  }
  return half * 2 * 1000;
}

describe('carving a groove', () => {
  for (const profile of ['round', 'v', 'flat'] as const) {
    it(`${profile}: exactly as deep as asked, and the clay stays closed`, () => {
      const mesh = carve(groove(profile));
      expect(deepestMm(mesh)).toBeGreaterThan(2.45);
      // A flat floor under a curved surface is a hair deeper at its edges.
      expect(deepestMm(mesh)).toBeLessThan(2.55);
      expect(isWatertight(mesh)).toBe(true);
    });
  }

  it('opens as wide as asked where it meets the surface', () => {
    // A flat cutter's wall is vertical, so its rim is its width.
    expect(widthMm(carve(groove('flat')))).toBeGreaterThan(2.9);
    expect(widthMm(carve(groove('flat')))).toBeLessThanOrEqual(3.01);
  });

  it('a single point is a pit', () => {
    const one = groove('round', { path: [[-R, 0, 0]], normals: [[-1, 0, 0]], depth: 0.0015 });
    const mesh = carve(one);
    expect(deepestMm(mesh)).toBeGreaterThan(1.45);
    expect(deepestMm(mesh)).toBeLessThan(1.52);
  });

  it('mirrors the path when asked', () => {
    // The arc is on -X; mirrored in X it is cut on +X too.
    const mesh = carve(groove('round', { mirror: 'x' }));
    let deepestPlusX = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const [x, y, z] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
      if (x > 0) deepestPlusX = Math.max(deepestPlusX, R - Math.hypot(x, y, z));
    }
    expect(deepestPlusX * 1000).toBeGreaterThan(2.45);
  });

  it('refuses a carve that misses the clay', () => {
    const away = groove('round', { path: [[0.2, 0, 0]], normals: [[1, 0, 0]] });
    const result = cutSculptWith(wasm, icosphere(R, 4), away);
    expect(result.ok).toBe(false);
  });

  it('fills a closed outline: the whole area comes out at the depth, not just its rim', () => {
    // A 12 x 6 mm rectangle on the -Y face, as a mouth would be.
    const clay = icosphere(R, 4);
    const outline = [[-6, -3], [6, -3], [6, 3], [-6, 3]].map(([x, z]) => [x / 1000, -R, z / 1000]);
    const { spec } = grooveAlongSurface(clay, outline, { width: 0.002, depth: 0.002, profile: 'round', fill: true });
    expect(spec.extra?.length).toBeGreaterThan(2);
    const result = cutSculptWith(wasm, clay, spec);
    if (!result.ok) throw new Error(result.error);
    const mesh = result.mesh;
    expect(isWatertight(mesh)).toBe(true);
    // Every vertex over the middle of the area is down at the floor: none of
    // the original surface is left standing between the scanlines.
    let inside = 0, shallow = 0;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const [x, y, z] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
      if (y > 0 || Math.abs(x) > 0.004 || Math.abs(z) > 0.002) continue;
      inside++;
      if (R - Math.hypot(x, y, z) < 0.0018) shallow++;
    }
    expect(inside).toBeGreaterThan(10);
    expect(shallow).toBe(0);
  });

  it('Smooth fills a carved groove in, as it would any other dent', () => {
    // It used to average each vertex with its own neighbours, an edge away,
    // and count every vertex once: a carve's dense groove outvoted the clay
    // beside it, and three passes left a 2 mm groove deeper than they found it.
    const clay = icosphere(R, 4);
    const path = Array.from({ length: 11 }, (_, i) => { const a = -0.3 + 0.06 * i; return [0, -R * Math.cos(a), R * Math.sin(a)]; });
    const { spec } = grooveAlongSurface(clay, path, { width: 0.005, depth: 0.002, profile: 'round' });
    const cut = cutSculptWith(wasm, clay, spec);
    if (!cut.ok) throw new Error(cut.error);
    const mesh = cut.mesh;
    recomputeNormals(mesh);
    const grooveDepthMm = () => {
      let inn = 0, ni = 0, out = 0, no = 0;
      for (let i = 0; i < mesh.vertexCount; i++) {
        const [x, y, z] = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
        if (y > 0 || Math.abs(z) > 0.004) continue;
        const r = Math.hypot(x, y, z);
        if (Math.abs(x) < 0.0006) { inn += r; ni++; } else if (Math.abs(x) > 0.005 && Math.abs(x) < 0.007) { out += r; no++; }
      }
      return (out / no - inn / ni) * 1000;
    };
    expect(grooveDepthMm()).toBeGreaterThan(1.9);
    const brush = { ...DEFAULT_BRUSH, type: 'smooth' as const, radius: 0.0045, strength: 1 };
    for (let pass = 0; pass < 3; pass++) {
      const session = beginStroke(mesh, brush);
      for (const p of path) for (let k = 0; k < 4; k++) applyBrush(session, brush, { x: p[0], y: p[1] * 0.97, z: p[2], nx: 0, ny: -1, nz: 0 });
      endStroke(session);
    }
    expect(grooveDepthMm()).toBeLessThan(1.6);
    expect(isWatertight(mesh)).toBe(true);
  });

  it('a tapered groove is full depth in the middle and fades towards its ends', () => {
    const clay = icosphere(R, 4);
    // Down the -Y face along Z, so depth can be read off by height.
    const path = Array.from({ length: 21 }, (_, i) => { const a = -0.5 + 0.05 * i; return [0, -R * Math.cos(a), R * Math.sin(a)]; });
    const { spec } = grooveAlongSurface(clay, path, { width: 0.004, depth: 0.003, profile: 'round', taper: 0.4 });
    const cut = cutSculptWith(wasm, clay, spec);
    if (!cut.ok) throw new Error(cut.error);
    const depthNear = (zc: number) => {
      let d = 0;
      for (let i = 0; i < cut.mesh.vertexCount; i++) {
        const [x, y, z] = [cut.mesh.positions[i * 3], cut.mesh.positions[i * 3 + 1], cut.mesh.positions[i * 3 + 2]];
        if (y < 0 && Math.abs(x) < 0.001 && Math.abs(z - zc) < 0.0015) d = Math.max(d, R - Math.hypot(x, y, z));
      }
      return d * 1000;
    };
    const middle = depthNear(0);
    const end = depthNear(R * Math.sin(0.45));
    expect(middle).toBeGreaterThan(2.8);
    expect(end).toBeLessThan(middle * 0.5);
    expect(isWatertight(cut.mesh)).toBe(true);
  });

  it('Add joins a tapered tube onto the clay, off the surface as drawn', () => {
    const clay = icosphere(R, 4);
    // A stem: from inside the top, straight up 12 mm.
    const path = [0, 3, 6, 9, 12, 15].map((h) => [0, 0, R - 0.002 + h / 1000]);
    const { spec } = grooveAlongSurface(clay, path, { width: 0.006, depth: 0, profile: 'round', add: true, taper: 0.3 });
    const result = cutSculptWith(wasm, clay, spec);
    if (!result.ok) throw new Error(result.error);
    let top = 0;
    for (let i = 0; i < result.mesh.vertexCount; i++) top = Math.max(top, result.mesh.positions[i * 3 + 2]);
    expect(top * 1000).toBeGreaterThan(R * 1000 + 10);
    expect(result.pieces).toBe(1);
    expect(isWatertight(result.mesh)).toBe(true);
  });

  it('Add roots a tube whose first point is off the surface (was a body of its own)', () => {
    const clay = icosphere(R, 4);
    // A tail starting 5 mm off the side and running away from it: drawn
    // as given it never touched the clay.
    const path = [5, 10, 15, 20].map((h) => [R + h / 1000, 0, 0]);
    const { spec } = grooveAlongSurface(clay, path, { width: 0.006, depth: 0, profile: 'round', add: true, taper: 0.3 });
    const result = cutSculptWith(wasm, clay, spec);
    if (!result.ok) throw new Error(result.error);
    expect(splitComponents(result.mesh).length).toBe(1);
    expect(isWatertight(result.mesh)).toBe(true);
  });

  it('Add with flatten makes a blade, thin across the direction given', () => {
    const clay = icosphere(R, 4);
    const path = [-2, 5, 10, 15].map((h) => [R + h / 1000, 0, 0]);
    const { spec } = grooveAlongSurface(clay, path, {
      width: 0.006, depth: 0, profile: 'round', add: true, flatten: { normal: [0, 0, 1], ratio: 0.3 },
    });
    const result = cutSculptWith(wasm, clay, spec);
    if (!result.ok) throw new Error(result.error);
    let y = 0, z = 0;
    for (let i = 0; i < result.mesh.vertexCount; i++) {
      if (result.mesh.positions[i * 3] < R + 0.004) continue;
      y = Math.max(y, Math.abs(result.mesh.positions[i * 3 + 1]));
      z = Math.max(z, Math.abs(result.mesh.positions[i * 3 + 2]));
    }
    expect(y * 1000).toBeGreaterThan(2.7);
    expect(z * 1000).toBeLessThan(1.1);
    expect(splitComponents(result.mesh).length).toBe(1);
    expect(isWatertight(result.mesh)).toBe(true);
  });

  it('snaps to the true nearest point past zero-area slivers', () => {
    // A unit triangle in z = 0, then a sliver whose corners are in a line
    // (Manifold leaves these in what it cuts). Its weights divided by zero, the
    // NaN distance beat nothing and lost to everything after it, and the snap
    // returned whichever face came last: a carve's path landed millimetres
    // off, and an eye ring grew a tail.
    const mesh = createSculptMesh(
      [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0.02, 0.02, 0.005, 0.03, 0.03, 0.005, 0.04, 0.04, 0.005, 0.05, 0.05, 0.03],
      [0, 1, 2, 3, 4, 5, 2, 1, 6],
    );
    recomputeNormals(mesh);
    const hit = closestOnSurface(mesh, [0.002, 0.002, 0.001], 0.1)!;
    expect(hit.distance).toBeCloseTo(0.001, 6);
    expect(hit.point[2]).toBeCloseTo(0, 6);
  });

  it('a cut that leaves a speck drops it instead of making it a piece', () => {
    // A block taken out of the front of the clay with a 0.5 mm hollow inside
    // it: the clay in the hollow is left floating, a speck, and goes too.
    const block = wasm.Manifold.cube([0.02, 0.02, 0.02], true).translate([0, -R, 0]);
    const hollow = wasm.Manifold.cube([0.0005, 0.0005, 0.0005], true).translate([0, -R + 0.004, 0]);
    const cutter = block.subtract(hollow);
    try {
      const result = cutSculpt(wasm, icosphere(R, 4), cutter);
      if (!result.ok) throw new Error(result.error);
      expect(result.pieces).toBe(1);
    } finally {
      block.delete(); hollow.delete(); cutter.delete();
    }
  });
});

