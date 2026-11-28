import { describe, expect, it } from 'vitest';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { garmentPlan } from '../src/utils/cloth/garmentPlan';
import type { GarmentDraft } from '../src/types/cloth';

const form = clampBodyForm({ figure: 'female' });
const L = bodyLandmarks(form);
const darts = (draft: GarmentDraft) => garmentPlan(draft, form).seams.flatMap((s) => (s.kind === 'dart' ? [s.name] : [])).sort();

describe('the bodice darts give way only to a seam that reaches them', () => {
  it('a seam scoped to a sleeve, or kept to one side, leaves the darts it does not reach', () => {
    expect(darts({ garment: 'dress' } as GarmentDraft)).toEqual(expect.arrayContaining(['waistDartFrontL', 'waistDartFrontR']));
    // A seam across the waist darts' middles: it shapes there, and they go.
    const across = { name: 'band', point: [0, -0.1, (L.hipZ + L.bustZ) / 2], normal: [0, 0, 1] };
    const crossed = darts({ garment: 'dress', seams: [across] } as GarmentDraft);
    expect(crossed).not.toContain('waistDartFrontL');
    expect(crossed).not.toContain('waistDartFrontR');
    // The same plane on a sleeve only: it never reaches the bodice.
    expect(darts({ garment: 'dress', sleeve: 0.2, seams: [{ ...across, on: 'sleeveL' }] } as GarmentDraft)).toEqual(expect.arrayContaining(['waistDartFrontL', 'waistDartFrontR']));
    // Kept to the wearer's right: the left's darts stay.
    const right = darts({ garment: 'dress', seams: [{ ...across, x: [-1, -0.02] }] } as GarmentDraft);
    expect(right).toContain('waistDartFrontL');
    expect(right).not.toContain('waistDartFrontR');
  });
});
