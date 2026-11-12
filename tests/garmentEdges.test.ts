import { describe, expect, it } from 'vitest';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { formLimbs } from '../src/utils/cloth/formLimbs';
import { profileAt } from '../src/utils/cloth/edgeProfile';
import type { GarmentDraft } from '../src/types/cloth';

const form = clampBodyForm({ figure: 'female' });
// Where each edge point was cut (before it was let down to hang).
const edgePts = (draft: Omit<GarmentDraft, 'fitTo'>, name: RegExp) => {
  const sh = garmentShell({ ...draft, fitTo: 'form' } as GarmentDraft, form);
  const at = (i: number) => [sh.points[i][0], sh.points[i][1], sh.points[i][2] + (sh.hang?.[i] ?? 0)];
  return sh.edges.filter((e) => name.test(e.name)).flatMap((e) => e.path.map(at));
};

describe('edge profiles', () => {
  it('reads a profile straight between its points, level past them, repeated', () => {
    const pr = { points: [[0, 0], [0.5, 1], [1, 0]] };
    expect(profileAt(pr, 0.25)).toBeCloseTo(0.5);
    expect(profileAt({ points: [[0.2, 3], [0.8, 5]] }, 0)).toBe(3);
    expect(profileAt({ ...pr, repeat: 2 }, 0.25)).toBeCloseTo(1);
  });

  it('cuts a V neckline: straight from its point to the shoulder, where a round one is fuller', () => {
    const base = { garment: 'tshirt' as const, neckline: 0.16 };
    const front = (pts: number[][]) => pts.filter((p) => p[1] < 0);
    const round = front(edgePts(base, /^neckline/)), vee = front(edgePts({ ...base, edges: [{ along: 'neckline', profile: { points: [[0, 1], [1, 0]] } }] }, /^neckline/));
    const half = Math.max(...vee.map((p) => Math.abs(p[0])));
    const zAt = (pts: number[][], x: number) => pts.reduce((b, p) => (Math.abs(Math.abs(p[0]) - x) < Math.abs(Math.abs(b[0]) - x) ? p : b))[2];
    const low = Math.min(...vee.map((p) => p[2]));
    // Same depth at the centre.
    expect(Math.abs(low - Math.min(...round.map((p) => p[2])))).toBeLessThan(0.012);
    // Halfway across, a V has come up half its depth; a round neckline much less.
    const top = Math.max(...vee.map((p) => p[2]));
    const vMid = (zAt(vee, half / 2) - low) / (top - low), rMid = (zAt(round, half / 2) - low) / (top - low);
    expect(vMid).toBeGreaterThan(0.35);
    expect(vMid).toBeLessThan(0.65);
    expect(rMid).toBeLessThan(vMid - 0.1);
  });

  it('cuts a high-low hem: longer at the back by what the profile says', () => {
    const pts = edgePts({ garment: 'dress', train: 0, edges: [{ along: 'hem', profile: { points: [[0, 0], [0.5, 0.2], [1, 0]] } }] }, /^hem/);
    const L = bodyLandmarks(form);
    const cy = (p: number[]) => p[1] - (L.waistZ ? 0 : 0);
    const frontZ = Math.min(...pts.filter((p) => cy(p) < -0.05 && Math.abs(p[0]) < 0.05).map((p) => p[2]));
    const backZ = Math.min(...pts.filter((p) => cy(p) > 0.05 && Math.abs(p[0]) < 0.05).map((p) => p[2]));
    expect(frontZ - backZ).toBeGreaterThan(0.15);
    expect(frontZ - backZ).toBeLessThan(0.25);
  });

  it('draws a sleeve out to a point: its underside reaches past the rest of the cuff by the profile', () => {
    const point = { points: [[0, 0.2], [0.12, 0], [0.88, 0], [1, 0.2]] };
    const pts = edgePts({ garment: 'tshirt', sleeve: 0.35, cuff: 0.5, edges: [{ along: 'cuff', profile: point }] }, /^cuffL/);
    const arm = formLimbs(form).armL;
    const along = pts.map((p) => arm.path.closest(p, arm.length + 0.2).s);
    const reach = Math.max(...along) - Math.min(...along);
    expect(reach).toBeGreaterThan(0.14);
    // The furthest point hangs below the arm.
    const far = pts[along.indexOf(Math.max(...along))], c = arm.path.at(Math.max(...along));
    expect(far[2]).toBeLessThan(c[2]);
  });
});
