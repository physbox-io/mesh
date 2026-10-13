import { describe, it, expect } from 'vitest';
import { applySurfaceTextures, patternRegionAt, splitSeams, textureIndexAt, type FaceSplit, type SurfaceTexture } from '../src/utils/surfaceTexture';
import { geomLocalSurface } from '../src/utils/geomSurface';
import type { SceneGeom } from '../src/types/scene';
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

describe('a face is covered whole', () => {
  it('takes a cylinder\'s whole side, with no limit asked for', () => {
    const cyl = cylinder(0.02, 0.02, 96);
    const out = applySurfaceTextures(cyl.positions, cyl.faces, [fluted({ seedAt: [0.02, 0, 0], seedNormal: [1, 0, 0], depthM: -0.0005 })]);
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    expect(r.capped).toBeUndefined();
    expect(r.areaM2).toBeGreaterThan(2 * Math.PI * 0.02 * 0.04 * 0.98);
  });

  it('stops short on a part with no edges, and says so', () => {
    const R = 0.03;
    const sphere = geomLocalSurface({ name: 's', type: 'sphere', size: [R] } as SceneGeom)!;
    const out = applySurfaceTextures(sphere.positions, sphere.faces, [fluted({ seedAt: [R, 0, 0], seedNormal: [1, 0, 0], depthM: -0.0005 })]);
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    expect(r.capped).toBe(true);
    // A cap 75 degrees round from the pick: 2πR²(1 − cos 75°), about 37 % of the sphere.
    expect(r.areaM2 / (4 * Math.PI * R * R)).toBeGreaterThan(0.3);
    expect(r.areaM2 / (4 * Math.PI * R * R)).toBeLessThan(0.45);
    expect(r.projection).toBe('unwrap');
  });
});

describe('a seam drawn with the knife', () => {
  const R = 0.03;
  const sphere = geomLocalSurface({ name: 's', type: 'sphere', size: [R] } as SceneGeom)!;
  const halves: FaceSplit[] = [{ at: [0, 0, 0], normal: [1, 0, 0], seeds: [[R, 0, 0]] }];
  const facing = (x: number) => fluted({ seedAt: [x, 0, 0], seedNormal: [Math.sign(x), 0, 0], depthM: -0.0005 });

  it('halves a sphere, and each half takes a pattern of its own, whole', () => {
    const out = applySurfaceTextures(sphere.positions, sphere.faces, [facing(R), facing(-R)], { splits: halves });
    for (const r of out.regions) {
      expect(r.applied).toBe(true);
      // A half has an edge now, so it is covered whole rather than capped.
      expect(r.capped).toBeUndefined();
      expect(r.areaM2 / (2 * Math.PI * R * R)).toBeGreaterThan(0.97);
    }
    const check = analyzeMesh(out.vertices, out.faces)!;
    expect(check.closed && check.consistentlyWound).toBe(true);
  });

  it('leaves the patterned half round, not a ball of flat panels', () => {
    // Next to no depth, so what is measured is the surface the pattern stands on.
    const out = applySurfaceTextures(sphere.positions, sphere.faces, [{ ...facing(R), depthM: -1e-9, cellM: 0.001 }], { splits: halves });
    let worst = 0;
    for (let i = 0; i < out.vertices.length; i += 3) {
      if (out.vertices[i] < 1e-4) continue;
      worst = Math.max(worst, Math.abs(Math.hypot(out.vertices[i], out.vertices[i + 1], out.vertices[i + 2]) - R));
    }
    // Left on the coarse facets it was 0.13 mm in at worst.
    expect(worst).toBeLessThan(0.02e-3);
  });

  it('runs all the way round the faces it was drawn over', () => {
    const [seam] = splitSeams(sphere.positions, sphere.faces, halves);
    // Every point on the plane, and together a loop the sphere's girth.
    let length = 0;
    for (let i = 0; i < seam.length; i += 6) {
      expect(Math.abs(seam[i])).toBeLessThan(1e-6);
      length += Math.hypot(seam[i + 3] - seam[i], seam[i + 4] - seam[i + 1], seam[i + 5] - seam[i + 2]);
    }
    expect(length).toBeGreaterThan(2 * Math.PI * R * 0.97);
    expect(length).toBeLessThan(2 * Math.PI * R * 1.01);
  });

  it('divides only the faces it was drawn over: across a box top, not the bottom', () => {
    const { positions, faces } = box(HX, HY, HZ);
    const split: FaceSplit = { at: [0, 0, 0], normal: [1, 0, 0], seeds: [[0.01, 0, HZ]] };
    const top = applySurfaceTextures(positions, faces, [fluted({ seedAt: [0.01, 0, HZ] })], { splits: [split] });
    expect(top.regions[0].areaM2).toBeCloseTo(2 * HX * HY, 9);
    const bottom = applySurfaceTextures(positions, faces, [fluted({ seedAt: [0.01, 0, -HZ], seedNormal: [0, 0, -1] })], { splits: [split] });
    expect(bottom.regions[0].areaM2).toBeCloseTo(4 * HX * HY, 9);
  });

  it('is what the hover lights up to', () => {
    const glow = patternRegionAt(sphere.positions, sphere.faces, [], [R, 0, 0], [1, 0, 0], halves)!;
    const whole = patternRegionAt(sphere.positions, sphere.faces, [], [R, 0, 0], [1, 0, 0])!;
    for (let i = 0; i < glow.triangles.length; i += 3) expect(glow.triangles[i]).toBeGreaterThan(-1e-6);
    // Capped at 75 degrees without the seam, the whole half with it.
    expect(glow.triangles.length).toBeGreaterThan(whole.triangles.length);
  });
});

describe('two patterns on a part with no edges', () => {
  it('lets the second stop at the first rather than refusing it', () => {
    const R = 0.03;
    const sphere = geomLocalSurface({ name: 's', type: 'sphere', size: [R] } as SceneGeom)!;
    const c = Math.SQRT1_2;
    const out = applySurfaceTextures(sphere.positions, sphere.faces, [
      fluted({ seedAt: [R, 0, 0], seedNormal: [1, 0, 0], depthM: -0.0005 }),
      fluted({ seedAt: [-R * c, R * c, 0], seedNormal: [-c, c, 0], depthM: -0.0005 }),
    ]);
    expect(out.regions.map((r) => r.applied)).toEqual([true, true]);
  });
});

describe('the face a pick would light up', () => {
  const { positions, faces } = box(HX, HY, HZ);

  it('is the whole face, edged all round', () => {
    const glow = patternRegionAt(positions, faces, [], [0.01, 0.005, HZ], [0, 0, 1])!;
    expect(glow.triangles.length).toBe(2 * 9);
    // Four edges, two ends each; the diagonal inside the face is not one.
    expect(glow.outline.length).toBe(4 * 2 * 3);
    for (let i = 2; i < glow.triangles.length; i += 3) expect(glow.triangles[i]).toBeCloseTo(HZ, 6);
  });

  it('is the pattern already there, when the pick lands in one', () => {
    const cyl = cylinder(0.02, 0.02, 96);
    const quarter = fluted({ seedAt: [0.02, 0, 0], seedNormal: [1, 0, 0], maxTiltDeg: 45 });
    const near = (t: number): number[] => [0.02 * Math.cos(t), 0.02 * Math.sin(t), 0];
    const inside = patternRegionAt(cyl.positions, cyl.faces, [quarter], near(0.3), [Math.cos(0.3), Math.sin(0.3), 0])!;
    const whole = patternRegionAt(cyl.positions, cyl.faces, [], near(0.3), [Math.cos(0.3), Math.sin(0.3), 0])!;
    expect(inside.triangles.length).toBeLessThan(whole.triangles.length * 0.3);
    expect(whole.triangles.length).toBe(96 * 2 * 9);
  });

  it('is nothing off the part', () => {
    expect(patternRegionAt(positions, faces, [], [0, 0, 0.5], [0, 0, 1])).toBeNull();
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

/**
 * The inside of a dish, open: a spherical pocket `a` across at its rim, on a
 * sphere of radius `rs`, ringed by a flat lip out to `b`. Wound so its normal
 * faces up out of the pocket, the way the inside of a soap dish faces.
 */
function dish(a: number, rs: number, b: number, segments = 48, rings = 16): { positions: number[]; faces: number[] } {
  const h0 = Math.sqrt(rs * rs - a * a);
  const radii: number[] = [];
  for (let i = 1; i <= rings; i++) radii.push((a * i) / rings);
  for (let i = 1; i <= 3; i++) radii.push(a + ((b - a) * i) / 3);
  const z = (r: number) => (r <= a + 1e-12 ? h0 - Math.sqrt(rs * rs - r * r) : 0);
  const positions = [0, 0, z(0)];
  for (const r of radii) {
    for (let k = 0; k < segments; k++) {
      const t = (k / segments) * Math.PI * 2;
      positions.push(r * Math.cos(t), r * Math.sin(t), z(r));
    }
  }
  const at = (ring: number, k: number) => 1 + ring * segments + (k % segments);
  const faces: number[] = [];
  for (let k = 0; k < segments; k++) faces.push(0, at(0, k), at(0, k + 1));
  for (let i = 0; i + 1 < radii.length; i++) {
    for (let k = 0; k < segments; k++) {
      faces.push(at(i, k), at(i + 1, k), at(i + 1, k + 1), at(i, k), at(i + 1, k + 1), at(i, k + 1));
    }
  }
  return { positions, faces };
}

/** A quarter of a torus, open at both ends: a bent tube, which no cylinder fits. */
function bentTube(R: number, r: number, along = 24, around = 32): { positions: number[]; faces: number[] } {
  const positions: number[] = [];
  for (let i = 0; i <= along; i++) {
    const phi = (i / along) * (Math.PI / 2);
    for (let j = 0; j < around; j++) {
      const th = (j / around) * Math.PI * 2;
      positions.push((R + r * Math.cos(th)) * Math.cos(phi), (R + r * Math.cos(th)) * Math.sin(phi), r * Math.sin(th));
    }
  }
  const at = (i: number, j: number) => i * around + (j % around);
  const faces: number[] = [];
  for (let i = 0; i < along; i++) {
    for (let j = 0; j < around; j++) {
      faces.push(at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j), at(i + 1, j + 1), at(i, j + 1));
    }
  }
  return { positions, faces };
}

describe('curved surfaces', () => {
  const R = 0.015;
  const cyl = cylinder(R, 0.03, 96);
  const allRound = (over: Partial<SurfaceTexture> = {}) =>
    fluted({ seedAt: [R, 0, 0], seedNormal: [1, 0, 0], maxTiltDeg: 180, ...over });

  it('picks the projection by the shape: flat, cylinder, or unwrapped', () => {
    const top = applySurfaceTextures(box(HX, HY, HZ).positions, box(HX, HY, HZ).faces, [fluted()]);
    expect(top.regions[0].projection).toBe('planar');
    const side = applySurfaceTextures(cyl.positions, cyl.faces, [allRound({ maxTiltDeg: 45 })]);
    expect(side.regions[0].projection).toBe('cylindrical');
    const bowl = dish(0.02, 0.025, 0.035);
    const inside = applySurfaceTextures(bowl.positions, bowl.faces, [fluted({ seedAt: [0, 0, 0.015 - 0.025], seedNormal: [0, 0, 1] })]);
    expect(inside.regions[0].projection).toBe('unwrap');
  });

  it('wraps a repeating pattern all the way round a cylinder, resized to meet itself', () => {
    const out = applySurfaceTextures(cyl.positions, cyl.faces, [allRound()]);
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    expect(r.projection).toBe('cylindrical');
    expect(r.wrap?.blended).toBe(false);
    // 12 mm flutes round a 94 mm circumference: eight of them, a couple of per cent smaller.
    expect(r.wrap!.scaled).toBeGreaterThan(0.9);
    expect(r.wrap!.scaled).toBeLessThan(1.1);
    expect(r.extentM[0]).toBeCloseTo(2 * Math.PI * R, 3);
    expect(r.stretch!).toBeLessThan(0.02);
    expect(out.warnings.some((w) => /stretches/.test(w))).toBe(false);
    const check = analyzeMesh(out.vertices, out.faces)!;
    expect(check.closed && check.consistentlyWound).toBe(true);

    // No step at the join: round the middle of the side, the surface moves as
    // smoothly across the cut (opposite the pick, at -x) as anywhere else.
    const ring: [number, number][] = [];
    for (let i = 0; i < out.vertices.length; i += 3) {
      const [x, y, z] = [out.vertices[i], out.vertices[i + 1], out.vertices[i + 2]];
      if (Math.abs(z) < 0.0003) ring.push([Math.atan2(y, x), Math.hypot(x, y)]);
    }
    ring.sort((a, b) => a[0] - b[0]);
    let worst = 0;
    for (let i = 1; i < ring.length; i++) worst = Math.max(worst, Math.abs(ring[i][1] - ring[i - 1][1]));
    const across = Math.abs(ring[0][1] - ring[ring.length - 1][1]);
    expect(across).toBeLessThanOrEqual(worst * 1.5 + 1e-6);
  });

  it('takes a cylinder\'s side all the way round by default, and only as far as asked when asked', () => {
    const round = applySurfaceTextures(cyl.positions, cyl.faces, [fluted({ seedAt: [R, 0, 0], seedNormal: [1, 0, 0] })]);
    expect(round.regions[0].areaM2).toBeCloseTo(2 * Math.PI * R * 0.06, 4);
    expect(round.regions[0].wrap).toBeDefined();
    const part = applySurfaceTextures(cyl.positions, cyl.faces, [fluted({ seedAt: [R, 0, 0], seedNormal: [1, 0, 0], maxTiltDeg: 75 })]);
    expect(part.regions[0].areaM2).toBeLessThan(0.5 * round.regions[0].areaM2);
    // A box's top is not a cylinder, and a bowl is not one either: both keep their regions.
    const top = applySurfaceTextures(box(HX, HY, HZ).positions, box(HX, HY, HZ).faces, [fluted()]);
    expect(top.regions[0].areaM2).toBeCloseTo(4 * HX * HY, 9);
  });

  // A 48-sided drum: each facet a flat face, so pushed along facet normals the
  // vertices either side of every edge went 3.75 degrees apart and folded.
  it('engraves a faceted drum to full depth all the way round', () => {
    const drum = cylinder(0.03, 0.05, 48);
    const out = applySurfaceTextures(drum.positions, drum.faces, [
      fluted({ seedAt: [0.03, 0, 0], seedNormal: [1, 0, 0], depthM: -0.001, options: { pitchMm: 6, meanderMm: 0 }, cellM: 0.003 }),
    ]);
    expect(out.regions[0].depthM).toBeCloseTo(-0.001, 9);
    expect(out.warnings.some((w) => /folded/.test(w))).toBe(false);
    const check = analyzeMesh(out.vertices, out.faces)!;
    expect(check.closed && check.consistentlyWound).toBe(true);
  });

  it('blends a pattern that does not repeat across the join', () => {
    const out = applySurfaceTextures(cyl.positions, cyl.faces, [allRound({ pattern: 'voronoi', depthM: -0.001 })]);
    expect(out.regions[0].wrap).toEqual({ scaled: 1, blended: true });
  });

  it('unwraps the inside of a bowl evenly, and stops at its rim', () => {
    const bowl = dish(0.02, 0.025, 0.035);
    const seed = { seedAt: [0, 0, 0.015 - 0.025], seedNormal: [0, 0, 1] };
    const unwrapped = applySurfaceTextures(bowl.positions, bowl.faces, [fluted({ ...seed, cellM: 0.0015 })]);
    const flat = applySurfaceTextures(bowl.positions, bowl.faces, [fluted({ ...seed, cellM: 0.0015, projection: 'planar' })]);
    const [r] = unwrapped.regions;
    expect(r.applied).toBe(true);
    // The pocket's own area, not the lip round it.
    const h = 0.025 - Math.sqrt(0.025 ** 2 - 0.02 ** 2);
    expect(r.areaM2).toBeLessThan(2 * Math.PI * 0.025 * h * 1.02);
    expect(r.stretch!).toBeLessThan(0.15);
    expect(flat.regions[0].stretch!).toBeGreaterThan(0.4);
    expect(flat.warnings.some((w) => /stretches the pattern/.test(w))).toBe(true);
    expect(analyzeMesh(unwrapped.vertices, unwrapped.faces)!.consistentlyWound).toBe(true);
  });

  it('cuts a bent tube open on the far side from the pick, and leaves the cut plain', () => {
    const tube = bentTube(0.04, 0.008);
    const c = Math.SQRT1_2;
    const out = applySurfaceTextures(tube.positions, tube.faces, [
      fluted({ seedAt: [0.048 * c, 0.048 * c, 0], seedNormal: [c, c, 0], maxTiltDeg: 180, depthM: -0.001, borderM: 0.001 }),
    ]);
    const [r] = out.regions;
    expect(r.applied).toBe(true);
    expect(r.projection).toBe('unwrap');
    expect(r.seam).toBe(true);
    expect(analyzeMesh(out.vertices, out.faces)!.consistentlyWound).toBe(true);

    // How far each original vertex moved, by which side of the tube it is on.
    const moved = (j: number) => {
      let most = 0;
      for (let i = 0; i <= 24; i++) {
        const v = 3 * (i * 32 + j);
        most = Math.max(most, Math.hypot(
          out.vertices[v] - tube.positions[v], out.vertices[v + 1] - tube.positions[v + 1], out.vertices[v + 2] - tube.positions[v + 2]));
      }
      return most;
    };
    // Some line along the inside of the bend (j near 16, round the back) never moved.
    const still = [12, 13, 14, 15, 16, 17, 18, 19, 20].filter((j) => moved(j) < 1e-9);
    expect(still.length).toBeGreaterThan(0);
    // ...while the side that was picked was cut.
    expect(moved(0)).toBeGreaterThan(0.0002);
  });
});
