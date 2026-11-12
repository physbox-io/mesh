import { describe, expect, it } from 'vitest';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import type { GarmentCurve, GarmentDraft } from '../src/types/cloth';
import { penCurve } from '../src/utils/cloth/garmentCurves';

const form = clampBodyForm({ figure: 'female' });
const L = bodyLandmarks(form);
const shell = (curves?: GarmentCurve[], more: Partial<GarmentDraft> = {}) => garmentShell({ garment: 'dress', fitTo: 'form', curves, ...more } as GarmentDraft, form);
const plain = shell();
// Where the plain dress's front is at (x, z): a point to draw through.
const onFront = (x: number, z: number): [number, number, number] => {
  let best = plain.points[0], bd = Infinity;
  for (const p of plain.points) { if (p[1] > 0) continue; const d = Math.hypot(p[0] - x, p[2] - z); if (d < bd) { bd = d; best = p; } }
  return [x, best[1], z];
};
const ring = (cx: number, cz: number, r: number, n = 16) => Array.from({ length: n }, (_, k) => onFront(cx + r * Math.cos((2 * Math.PI * k) / n), cz + r * Math.sin((2 * Math.PI * k) / n)));
const edgePoints = (sh: ReturnType<typeof shell>, name: string) => sh.edges.filter((e) => e.name === name).flatMap((e) => e.path.map((i) => sh.points[i]));
const used = (sh: ReturnType<typeof shell>) => { const u = new Set<number>(); for (const i of sh.tris) u.add(i); return [...u].map((i) => sh.points[i]); };

describe('curves drawn on a garment', () => {
  it('cuts a closed curve out: no cloth inside it, its edge named for it', () => {
    const cz = L.waistZ + 0.04, r = 0.05;
    const sh = shell([{ name: 'keyhole', kind: 'cut', closed: true, points: ring(0, cz, r) }]);
    const rim = edgePoints(sh, 'keyhole');
    expect(rim.length).toBeGreaterThan(20);
    for (const p of rim) expect(Math.abs(Math.hypot(p[0], p[2] - cz) - r)).toBeLessThan(0.012);
    const inside = used(sh).filter((p) => p[1] < 0 && Math.hypot(p[0], p[2] - cz) < 0.8 * r);
    expect(inside).toHaveLength(0);
    // The cloth round it is still there.
    expect(used(sh).filter((p) => p[1] < 0 && Math.hypot(p[0], p[2] - cz) < 1.5 * r).length).toBeGreaterThan(10);
  }, 120000);

  it('redraws an edge: an open cut from the neckline back to it takes away the cloth between', () => {
    const top = Math.max(...edgePoints(plain, 'neckline').filter((p) => p[1] < 0 && Math.abs(p[0]) < 0.03).map((p) => p[2]));
    const low = top - 0.12;
    // A deep square neckline, from one side of the round one to the other.
    const pts = [onFront(-0.07, top + 0.04), onFront(-0.07, low), onFront(0.07, low), onFront(0.07, top + 0.04)];
    const sh = shell([{ name: 'squareNeck', kind: 'cut', points: pts }]);
    const rim = edgePoints(sh, 'squareNeck');
    expect(rim.length).toBeGreaterThan(10);
    expect(Math.min(...rim.map((p) => p[2]))).toBeLessThan(low + 0.01);
    expect(used(sh).filter((p) => p[1] < 0 && Math.abs(p[0]) < 0.05 && p[2] > low + 0.015 && p[2] < top - 0.01)).toHaveLength(0);
  }, 120000);

  it('sews a curved seam across a panel, parting it there; left open, a slit', () => {
    const z = L.bustZ - 0.06;
    // From the side seam on one side to the other's, across the front in a wave.
    const sideAt = (sign: number): [number, number, number] => {
      const pts = plain.seams.filter((sm) => sm.name === 'side').flatMap((sm) => sm.path.map((i) => plain.points[i])).filter((p) => Math.sign(p[0]) === sign);
      const p = pts.reduce((b, q) => (Math.abs(q[2] - z) < Math.abs(b[2] - z) ? q : b));
      return [p[0], p[1], p[2]];
    };
    const wave = [sideAt(-1), ...Array.from({ length: 11 }, (_, k) => { const x = -0.12 + (0.24 * k) / 10; return onFront(x, z + 0.03 * Math.sin(x * 25)); }), sideAt(1)];
    const sh = shell([{ name: 'yoke', kind: 'seam', points: wave }]);
    expect(sh.seams.filter((s) => s.name === 'yoke').length).toBeGreaterThan(10);
    expect(sh.panels.length).toBeGreaterThan(plain.panels.length);
    const slit = shell([{ name: 'vent', kind: 'open', points: [onFront(0, L.hipZ - 0.1), onFront(0, L.hipZ - 0.3)] }]);
    const vent = slit.seams.filter((s) => s.name === 'vent');
    expect(vent.length).toBeGreaterThan(5);
    expect(vent.every((s) => s.open)).toBe(true);
  }, 120000);

  it('mirrors a curve, the pair named L and R', () => {
    const sh = shell([{ name: 'panel', kind: 'seam', mirror: true, points: [onFront(0.06, L.bustZ + 0.1), onFront(0.1, L.waistZ), onFront(0.08, L.hipZ - 0.2)] }]);
    const names = new Set(sh.seams.map((s) => s.name));
    expect(names.has('panelL')).toBe(true);
    expect(names.has('panelR')).toBe(true);
  }, 120000);

  it('makes a pen stroke a curve: closed when it comes back to its start, mirrored only off the centre, named afresh', () => {
    const loop = Array.from({ length: 40 }, (_, k) => [0.1 + 0.05 * Math.cos((2 * Math.PI * k) / 39), -0.1, 1 + 0.05 * Math.sin((2 * Math.PI * k) / 39)]);
    const c = penCurve(loop, 'cut', true, ['cut1'])!;
    expect(c.closed).toBe(true);
    expect(c.mirror).toBe(true);
    expect(c.name).toBe('cut2');
    const across = penCurve([[-0.1, -0.1, 1], [0, -0.12, 1], [0.1, -0.1, 1]], 'seam', true, [])!;
    expect(across.closed).toBeUndefined();
    expect(across.mirror).toBeUndefined();
    expect(penCurve([[0, 0, 1], [0.001, 0, 1]], 'seam', false, [])).toBeNull();
  });
});
