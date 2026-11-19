import { describe, expect, it } from 'vitest';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { sculptField, strokeDabs } from '../src/utils/cloth/garmentSculpt';
import { angleDeficits } from '../src/utils/cloth/sculptDarts';
import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { GarmentDraft, GarmentSculpt } from '../src/types/cloth';

const form = clampBodyForm({ figure: 'female' });
const L = bodyLandmarks(form);
const shell = (sculpt?: GarmentSculpt[], more: Partial<GarmentDraft> = {}) => garmentShell({ garment: 'dress', fitTo: 'form', sculpt, ...more } as GarmentDraft, form);
// The surface's furthest point out along a direction, near a point.
const furthest = (sh: ReturnType<typeof shell>, near: number[], dir: number[], within = 0.025) => {
  let best = -Infinity;
  for (const p of sh.points) {
    const off = [p[0] - near[0], p[1] - near[1], p[2] - near[2]];
    const along = off[0] * dir[0] + off[1] * dir[1] + off[2] * dir[2];
    const across = Math.hypot(off[0] - along * dir[0], off[1] - along * dir[1], off[2] - along * dir[2]);
    if (across < within) best = Math.max(best, along);
  }
  return best;
};
const area = (sh: ReturnType<typeof shell>) => {
  let a = 0;
  for (let t = 0; t < sh.tris.length; t += 3) {
    const [p, q, r] = [sh.points[sh.tris[t]], sh.points[sh.tris[t + 1]], sh.points[sh.tris[t + 2]]];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    a += 0.5 * Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  }
  return a;
};

describe('sculpted silhouettes', () => {
  it('adds dabs up, each falling smoothly to nothing at its radius, mirrored unless told not to', () => {
    const f = sculptField([{ at: [0.1, 0, 1], radius: 0.1, amount: 0.04 }]);
    expect(f.at([0.1, 0, 1])).toBeCloseTo(0.04);
    expect(f.at([-0.1, 0, 1])).toBeCloseTo(0.04);
    expect(f.at([0.1, 0.05, 1])).toBeCloseTo(0.04 * 0.75 * 0.75);
    expect(f.at([0.1, 0.1, 1])).toBe(0);
    expect(sculptField([{ at: [0.1, 0, 1], radius: 0.1, amount: 0.04, mirror: false }]).at([-0.1, 0, 1])).toBe(0);
    expect(sculptField([{ at: [0, 0, 1], radius: 0.1, amount: 0.02 }, { at: [0, 0, 1], radius: 0.1, amount: 0.02 }]).at([0, 0, 1])).toBeCloseTo(0.04);
    // On the centre line a dab and its mirror are one dab, not two.
    expect(sculptField([{ at: [0.01, 0, 1], radius: 0.1, amount: 0.04 }]).at([0, 0, 1])).toBeCloseTo(0.04 * 0.99 * 0.99);
  });

  it('makes a stroke a ridge as high as one dab', () => {
    const pts = Array.from({ length: 30 }, (_, i) => [i * 0.3 * 0.1, 0, 1]);
    const f = sculptField(strokeDabs(pts, 0.1, 0.05, false));
    expect(f.at([0.45, 0, 1])).toBeGreaterThan(0.045);
    expect(f.at([0.45, 0, 1])).toBeLessThan(0.055);
    expect(sculptField(strokeDabs([[0, 0, 1]], 0.1, 0.05, false)).at([0, 0, 1])).toBeCloseTo(0.05);
  });

  it('pushes the cloth out round a dab by its amount, and leaves it alone away from it', () => {
    const plain = shell();
    const front = [0, -0.05, L.waistZ], fwd = [0, -1, 0];
    const dab: GarmentSculpt = { at: [0, -L.chestDepth, L.waistZ], radius: 0.14, amount: 0.07 };
    const bubbled = shell([dab]);
    const moved = furthest(bubbled, front, fwd) - furthest(plain, front, fwd);
    expect(moved).toBeGreaterThan(0.055);
    expect(moved).toBeLessThan(0.085);
    // The back at the waist, well past the radius, unmoved.
    const back = [0, 0.05, L.waistZ];
    expect(Math.abs(furthest(bubbled, back, [0, 1, 0]) - furthest(plain, back, [0, 1, 0]))).toBeLessThan(0.006);
    // More cloth for it (the front already hangs off the bust over most of it).
    expect(area(bubbled)).toBeGreaterThan(area(plain) + 0.004);
  }, 120000);

  it('draws the cloth in, but never inside where it would rest on the form', () => {
    const at = [L.hipHalf, 0, L.hipZ - 0.15];
    const out = [1, 0, 0];
    const plain = furthest(shell(), at, out);
    const drawn = furthest(shell([{ at: at as [number, number, number], radius: 0.15, amount: -0.3 }]), at, out);
    expect(drawn).toBeLessThan(plain - 0.005);
    // Resting on the hip below, at about its clearance: not through it.
    expect(drawn).toBeGreaterThan(-0.02);
  }, 120000);

  it('measures curvature as angle deficit: a closed sphere holds a full 4π', () => {
    const g = new THREE.IcosahedronGeometry(0.1, 3);
    g.deleteAttribute('normal'); g.deleteAttribute('uv');
    const merged = BufferGeometryUtils.mergeVertices(g, 1e-6);
    const pos = merged.attributes.position, idx = merged.index!;
    const points = Array.from({ length: pos.count }, (_, i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
    const { deficit } = angleDeficits(points, Array.from(idx.array));
    expect(deficit.reduce((a, b) => a + b, 0)).toBeCloseTo(4 * Math.PI, 3);
  });

  it('darts a sculpted dome that cannot lie flat, the same either side, and nothing that is not sculpted', () => {
    const sp = L.shoulderPoint;
    const plain = shell().seams.filter((sm) => sm.name.startsWith('shape'));
    expect(plain).toHaveLength(0);
    // On the back below the shoulder blade of a garment with no darts of its
    // own, where no seam shapes it: no dart is added where a seam already
    // does (over the shoulder a set-in sleeve's armhole seam takes the dome;
    // on a fitted dress, its back waist darts).
    const sh = shell([{ at: [sp[0] * 0.5, 0.12, sp[2] - 0.12], radius: 0.08, amount: 0.05 }], { garment: 'tshirt', sleeve: 0.25 });
    const names = new Set(sh.seams.filter((sm) => sm.name.startsWith('shape')).map((sm) => sm.name));
    expect(names.size).toBeGreaterThan(0);
    for (const n of names) if (n.endsWith('L')) expect(names.has(`${n.slice(0, -1)}R`)).toBe(true);
    const panelNames = sh.panels.map((p) => p.name);
    expect(panelNames.filter((n) => n.includes('L')).length).toBe(panelNames.filter((n) => n.includes('R')).length);
  }, 120000);
});
