import { describe, it, expect } from 'vitest';
import { applySurfaceTextures, textureIndexAt, type SurfaceTexture } from '../src/utils/surfaceTexture';
import { analyzeMesh } from '../src/utils/meshIntegrity';

/*
 * What these defend: a pattern laid on a face has to leave the part a closed,
 * outward-wound solid -- the exporters slice and raycast it, and an open seam
 * or a backwards triangle machines and prints as garbage, or draws as a
 * see-through body (CLAUDE.md, face winding). And it has to land on the face
 * that was picked, at the depth asked for, and nowhere else.
 */

/** An axis-aligned box as a triangle soup, every corner repeated, outward-wound. */
function box(hx: number, hy: number, hz: number): { positions: number[]; faces: number[] } {
  const c = (sx: number, sy: number, sz: number) => [sx * hx, sy * hy, sz * hz];
  const quads = [
    [c(-1, -1, 1), c(1, -1, 1), c(1, 1, 1), c(-1, 1, 1)], // +z
    [c(-1, 1, -1), c(1, 1, -1), c(1, -1, -1), c(-1, -1, -1)], // -z
    [c(1, -1, -1), c(1, 1, -1), c(1, 1, 1), c(1, -1, 1)], // +x
    [c(-1, -1, 1), c(-1, 1, 1), c(-1, 1, -1), c(-1, -1, -1)], // -x
    [c(-1, 1, -1), c(-1, 1, 1), c(1, 1, 1), c(1, 1, -1)], // +y
    [c(-1, -1, -1), c(1, -1, -1), c(1, -1, 1), c(-1, -1, 1)], // -y
  ];
  const positions: number[] = [];
  const faces: number[] = [];
  for (const [a, b, cc, d] of quads) {
    for (const tri of [[a, b, cc], [a, cc, d]]) {
      for (const p of tri) {
        faces.push(positions.length / 3);
        positions.push(...p);
      }
    }
  }
  return { positions, faces };
}

/** A closed cylinder along z, outward-wound, with shared vertices. */
function cylinder(r: number, hz: number, segments: number): { positions: number[]; faces: number[] } {
  const positions: number[] = [];
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    positions.push(r * Math.cos(t), r * Math.sin(t), -hz, r * Math.cos(t), r * Math.sin(t), hz);
  }
  const bottom = positions.length / 3;
  positions.push(0, 0, -hz);
  const top = bottom + 1;
  positions.push(0, 0, hz);
  const faces: number[] = [];
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const b0 = 2 * i, t0 = 2 * i + 1, b1 = 2 * j, t1 = 2 * j + 1;
    faces.push(b0, b1, t1, b0, t1, t0);
    faces.push(top, t0, t1);
    faces.push(bottom, b1, b0);
  }
  return { positions, faces };
}

function volumeOf(positions: number[], faces: number[]): number {
  let v = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3, b = faces[i + 1] * 3, c = faces[i + 2] * 3;
    v += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  return v;
}

const HX = 0.03, HY = 0.02, HZ = 0.01;
const fluted = (over: Partial<SurfaceTexture> = {}): SurfaceTexture => ({
  pattern: 'fluted',
  depthM: -0.002,
  cellM: 0.001,
  seedAt: [0, 0, HZ],
  seedNormal: [0, 0, 1],
  ...over,
});

describe('a pattern on the top of a box', () => {
  const { positions, faces } = box(HX, HY, HZ);
  const out = applySurfaceTextures(positions, faces, [fluted()]);
  const z = (i: number) => out.vertices[3 * i + 2];

  it('takes exactly the top face and nothing else', () => {
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    expect(r.areaM2).toBeCloseTo(4 * HX * HY, 9);
    expect(r.normal[2]).toBeCloseTo(1, 9);
    expect(r.flat).toBe(true);
    // Its long side runs along the box's long side.
    expect(r.extentM[0]).toBeCloseTo(2 * HX, 9);
    expect(r.extentM[1]).toBeCloseTo(2 * HY, 9);
    // Nothing below the top moved: every vertex is either on the box's own
    // sides and bottom or within the pattern's depth of the top.
    for (let i = 0; i < out.vertices.length / 3; i++) {
      const x = out.vertices[3 * i], y = out.vertices[3 * i + 1];
      if (z(i) < HZ - 0.002 - 1e-9) {
        expect(Math.abs(Math.abs(x) - HX) < 1e-9 || Math.abs(Math.abs(y) - HY) < 1e-9 || Math.abs(z(i) + HZ) < 1e-9).toBe(true);
      }
    }
  });

  it('stays a closed, outward-wound solid', () => {
    const check = analyzeMesh(out.vertices, out.faces)!;
    expect(check.closed).toBe(true);
    expect(check.consistentlyWound).toBe(true);
    expect(check.volume).toBeGreaterThan(0);
  });

  it('refines the face to the cell size asked for', () => {
    let longest = 0;
    for (let f = 0; f < out.faces.length; f += 3) {
      const tri = [out.faces[f], out.faces[f + 1], out.faces[f + 2]];
      // The top's own faces: every corner at or below the top and inside the rim.
      if (!tri.every((i) => z(i) > HZ - 0.0021)) continue;
      for (let e = 0; e < 3; e++) {
        const a = tri[e], b = tri[(e + 1) % 3];
        // In plan, which displacement straight down does not change.
        const d = Math.hypot(out.vertices[3 * a] - out.vertices[3 * b], out.vertices[3 * a + 1] - out.vertices[3 * b + 1]);
        longest = Math.max(longest, d);
      }
    }
    expect(longest).toBeLessThanOrEqual(0.001 + 1e-9);
  });

  it('leaves the rim untouched and cuts the full depth inside it', () => {
    let deepest = Infinity;
    for (let i = 0; i < out.vertices.length / 3; i++) {
      const x = out.vertices[3 * i], y = out.vertices[3 * i + 1];
      const onTop = z(i) > HZ - 0.0021;
      if (!onTop) continue;
      deepest = Math.min(deepest, z(i));
      // Within the 2 mm border, still the face it was.
      if (HX - Math.abs(x) < 0.0019 || HY - Math.abs(y) < 0.0019) expect(z(i)).toBeCloseTo(HZ, 12);
    }
    expect(deepest).toBeGreaterThanOrEqual(HZ - 0.002 - 1e-9);
    expect(deepest).toBeLessThan(HZ - 0.0018);
  });

  it('takes material away when it engraves and adds it when it embosses', () => {
    const solid = volumeOf(positions, faces);
    const up = applySurfaceTextures(positions, faces, [fluted({ depthM: 0.002 })]);
    expect(volumeOf(out.vertices, out.faces)).toBeLessThan(solid);
    expect(volumeOf(up.vertices, up.faces)).toBeGreaterThan(solid);
    const check = analyzeMesh(up.vertices, up.faces)!;
    expect(check.closed && check.consistentlyWound).toBe(true);
  });
});

describe('choosing the region', () => {
  const { positions, faces } = box(HX, HY, HZ);

  it('settles a pick on an edge by the normal it was made with', () => {
    const out = applySurfaceTextures(positions, faces, [fluted({ seedAt: [HX, 0, HZ], seedNormal: [1, 0, 0] })]);
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    expect(r.normal[0]).toBeCloseTo(1, 9);
    expect(r.areaM2).toBeCloseTo(4 * HY * HZ, 9);
  });

  it('puts a pattern on each of two faces', () => {
    const out = applySurfaceTextures(positions, faces, [
      fluted(),
      fluted({ pattern: 'kumiko', seedAt: [0, -HY, 0], seedNormal: [0, -1, 0] }),
    ]);
    expect(out.regions.map((r) => r.applied)).toEqual([true, true]);
    const check = analyzeMesh(out.vertices, out.faces)!;
    expect(check.closed && check.consistentlyWound).toBe(true);
  });

  it('refuses a second pattern on a face that already has one', () => {
    const out = applySurfaceTextures(positions, faces, [fluted(), fluted({ pattern: 'scales', seedAt: [0.01, 0, HZ] })]);
    expect(out.regions[0].applied).toBe(true);
    expect(out.regions[1].applied).toBe(false);
    expect(out.regions[1].reason).toMatch(/overlaps/);
  });

  it('reports a pick that is no longer on the part, and still applies the rest', () => {
    const out = applySurfaceTextures(positions, faces, [fluted({ seedAt: [0, 0, 0.5] }), fluted()]);
    expect(out.regions[0].applied).toBe(false);
    expect(out.regions[0].reason).toMatch(/no longer on the part/);
    expect(out.regions[1].applied).toBe(true);
  });

  it('refuses a pattern that cuts through a board', () => {
    const out = applySurfaceTextures(positions, faces, [fluted({ pattern: 'sliced' })]);
    expect(out.regions[0].applied).toBe(false);
    expect(out.faces.length).toBe(faces.length);
  });

  it('stops at the tilt limit on a surface with no crease', () => {
    const cyl = cylinder(0.02, 0.02, 96);
    const out = applySurfaceTextures(cyl.positions, cyl.faces, [
      fluted({ seedAt: [0.02, 0, 0], seedNormal: [1, 0, 0], maxTiltDeg: 45, depthM: -0.0005 }),
    ]);
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    // The pick is on a vertex, so the region may be a facet off centre.
    expect(r.normal[0]).toBeCloseTo(1, 2);
    // A quarter of the side, give or take a facet, not all of it.
    const side = 2 * Math.PI * 0.02 * 0.04;
    expect(r.areaM2).toBeGreaterThan(side * 0.22);
    expect(r.areaM2).toBeLessThan(side * 0.28);
  });
});

describe('picking a face that already has a pattern', () => {
  const { positions, faces } = box(HX, HY, HZ);
  const side = fluted({ seedAt: [HX, 0, 0], seedNormal: [1, 0, 0] });

  it('finds the pattern on the face picked, anywhere on that face', () => {
    const textures = [fluted(), side];
    expect(textureIndexAt(positions, faces, textures, [HX * 0.8, -HY * 0.7, HZ], [0, 0, 1])).toBe(0);
    expect(textureIndexAt(positions, faces, textures, [HX, HY * 0.5, HZ * 0.5], [1, 0, 0])).toBe(1);
  });

  it('finds none on a plain face, or off the part', () => {
    expect(textureIndexAt(positions, faces, [fluted()], [0, 0, -HZ], [0, 0, -1])).toBe(-1);
    expect(textureIndexAt(positions, faces, [fluted()], [1, 1, 1])).toBe(-1);
  });

  it('settles a pick on an edge by the way it faced', () => {
    const textures = [fluted(), side];
    expect(textureIndexAt(positions, faces, textures, [HX, 0, HZ], [0, 0, 1])).toBe(0);
    expect(textureIndexAt(positions, faces, textures, [HX, 0, HZ], [1, 0, 0])).toBe(1);
  });

  it('does not credit a pattern refused as an overlap with the face', () => {
    expect(textureIndexAt(positions, faces, [fluted(), fluted({ seedAt: [HX / 2, 0, HZ] })], [0, 0, HZ], [0, 0, 1])).toBe(0);
  });
});

describe('guards', () => {
  it('limits the depth on a surface that curves tightly', () => {
    const cyl = cylinder(0.004, 0.01, 64);
    const out = applySurfaceTextures(cyl.positions, cyl.faces, [
      fluted({ seedAt: [0.004, 0, 0], seedNormal: [1, 0, 0], depthM: -0.003, maxTiltDeg: 60 }),
    ]);
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    expect(Math.abs(r.depthM)).toBeLessThanOrEqual(0.002 + 1e-9);
    expect(out.warnings.some((w) => /curves too tightly/.test(w))).toBe(true);
    const check = analyzeMesh(out.vertices, out.faces)!;
    expect(check.closed && check.consistentlyWound).toBe(true);
  });

  it('refines more coarsely rather than past the triangle limit', () => {
    const { positions, faces } = box(HX, HY, HZ);
    const out = applySurfaceTextures(positions, faces, [fluted({ cellM: 0.0002 })], { maxTriangles: 20_000 });
    expect(out.faces.length / 3).toBeLessThanOrEqual(25_000);
    expect(out.regions[0].cellM).toBeGreaterThan(0.0002);
    expect(out.warnings.some((w) => /too many triangles/.test(w))).toBe(true);
  });

  it('paints a pattern that has a palette', () => {
    const { positions, faces } = box(HX, HY, HZ);
    const out = applySurfaceTextures(positions, faces, [fluted({ pattern: 'animal_print', depthM: -0.0005 })]);
    expect(out.paint).toBeDefined();
    const n = out.vertices.length / 3;
    expect(out.paint!.idx.every((i) => i >= 0 && i < n)).toBe(true);
    expect(out.paint!.rgba.length).toBe(out.paint!.idx.length * 4);
  });
});
