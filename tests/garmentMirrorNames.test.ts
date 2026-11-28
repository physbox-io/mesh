import { describe, expect, it } from 'vitest';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { draftLines, mirrorSide } from '../src/utils/cloth/garmentCurves';
import { dartLines } from '../src/utils/cloth/garmentDarts';
import type { GarmentCurve, GarmentDraft } from '../src/types/cloth';

const form = clampBodyForm({});
const L = bodyLandmarks(form);

describe('a mirrored pair through the centre line is named L and R', () => {
  it('picks the side by the first measure the mirror negates', () => {
    expect(mirrorSide([0, 0, 0.5])).toBe('L');
    expect(mirrorSide([0, -0.1, 0.5])).toBe('R');
    expect(mirrorSide([0, 0, 0])).toBeNull();
  });

  it('a slanted plane seam with its point on x = 0', () => {
    const draft = { garment: 'tshirt', fitTo: 'form', seams: [{ name: 'diag', point: [0, -0.1, L.waistZ + 0.1], normal: [0.5, 0, 1], mirror: true }] } as GarmentDraft;
    const names = new Set(garmentShell(draft, form).seams.map((s) => s.name));
    expect(names.has('diagL')).toBe(true);
    expect(names.has('diagR')).toBe(true);
  }, 240000);

  it('drawn curves and darts across the centre', () => {
    const curve = { name: 'c', kind: 'seam', mirror: true, points: [[-0.05, -0.15, 1.0], [0.05, -0.15, 1.1], [0, -0.15, 1.2]] } as unknown as GarmentCurve;
    expect(draftLines([curve]).map((l) => l.name).sort()).toEqual(['cL', 'cR']);
    const sym = { ...curve, points: [[0, -0.15, 1.0], [0, -0.15, 1.2]] } as unknown as GarmentCurve;
    expect(draftLines([sym]).map((l) => l.name)).toEqual(['c']);
    const darts = dartLines([{ name: 'd', apex: [0, -0.15, L.waistZ], direction: [0.3, 0, 1], length: 0.1, mirror: true }], form);
    expect(darts.map((d) => d.name).sort()).toEqual(['dL', 'dR']);
  });
});
