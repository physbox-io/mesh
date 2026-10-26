import { describe, it, expect } from 'vitest';
import { autoToolingStep, type AutoToolingMemo } from '../src/components/carveTooling';

type Opts = { material: string; finishingToolDiaMm: number; roughingToolDiaMm: number; stockWidthMm: number };
const memo = (): AutoToolingMemo<Opts> => ({ lastAuto: null, manual: false, seen: null });
const start: Opts = { material: 'hardwood', finishingToolDiaMm: 3.175, roughingToolDiaMm: 6.35, stockWidthMm: 150 };
// A recommendation that depends on the result, as the real one depends on the carve.
const rec = (finish: number) => () => ({ material: 'hardwood', finishingToolDiaMm: finish, roughingToolDiaMm: 3.175 });

describe('autoToolingStep', () => {
  it('applies the recommendation to the first finished result', () => {
    const m = memo();
    expect(autoToolingStep(m, { id: 1 }, false, start, rec(1), false)).toEqual(rec(1)());
  });

  it('waits out a result that is still being replaced', () => {
    const m = memo();
    expect(autoToolingStep(m, { id: 1 }, true, start, rec(1), false)).toBeNull();
    expect(autoToolingStep(m, null, false, start, rec(1), false)).toBeNull();
  });

  it('acts once per result, and settles once the options hold the patch', () => {
    const m = memo();
    const r = { id: 1 };
    const patch = autoToolingStep(m, r, false, start, rec(1), false)!;
    const applied = { ...start, ...patch };
    expect(autoToolingStep(m, r, false, applied, rec(1), false)).toBeNull();
    // The re-run that applying it caused: same answer, nothing to apply.
    expect(autoToolingStep(m, { id: 2 }, false, applied, rec(1), false)).toBeNull();
  });

  it('follows a new model while the tooling is still its own pick', () => {
    const m = memo();
    const applied = { ...start, ...autoToolingStep(m, { id: 1 }, false, start, rec(1), false)! };
    expect(autoToolingStep(m, { id: 2 }, false, applied, rec(2), false)).toEqual(rec(2)());
  });

  it('leaves a bit the operator picked alone, for later models too', () => {
    const m = memo();
    const applied = { ...start, ...autoToolingStep(m, { id: 1 }, false, start, rec(1), false)! };
    const picked = { ...applied, finishingToolDiaMm: 0.8 };
    expect(autoToolingStep(m, { id: 2 }, false, picked, rec(2), false)).toBeNull();
    expect(autoToolingStep(m, { id: 3 }, false, picked, rec(3), false)).toBeNull();
  });

  it('does not take a change of material for a change of bit', () => {
    const m = memo();
    const applied = { ...start, ...autoToolingStep(m, { id: 1 }, false, start, rec(1), false)! };
    const oak = { ...applied, material: 'aluminium' };
    expect(autoToolingStep(m, { id: 2 }, false, oak, rec(2), false)).toEqual(rec(2)());
  });

  it('keeps the bits a scene asked for', () => {
    expect(autoToolingStep(memo(), { id: 1 }, false, start, rec(1), true)).toBeNull();
  });
});
