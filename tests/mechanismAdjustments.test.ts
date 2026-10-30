// physics_build_mechanism held a leadscrew's lead to 1 mm and its length to
// 40 mm without a word: a 0.5 mm lead came back ok:true and ran twice the
// travel the caller had worked out. Every figure a builder changes is listed.

import { describe, it, expect } from 'vitest';
import { buildMechanism, type MechanismBuild } from '../src/utils/buildMechanism';
import { adjustmentWarnings } from '../src/utils/mechanismAdjustments';

const ok = (r: MechanismBuild | { error: string }): MechanismBuild => {
  if ('error' in r) throw new Error(r.error);
  return r;
};

describe('a mechanism built other than as asked', () => {
  it('lists a leadscrew\'s clamped lead and length', () => {
    const b = ok(buildMechanism({ family: 'leadscrew', leadMm: 0.5, lengthMm: 20 }, []));
    expect(b.adjusted).toEqual([
      { field: 'lengthMm', requested: 20, used: 40 },
      { field: 'leadMm', requested: 0.5, used: 1 },
    ]);
    const w = adjustmentWarnings(b.family, b.adjusted);
    expect(w[1]).toMatch(/^leadMm 0.5 was changed to 1/);
  });

  it('lists nothing for a request it built as written, odd leads included', () => {
    expect(ok(buildMechanism({ family: 'leadscrew', leadMm: 3, lengthMm: 120 }, [])).adjusted).toEqual([]);
    expect(ok(buildMechanism({ family: 'gear_pair', driverTeeth: 16, drivenTeeth: 32, moduleMm: 1 }, [])).adjusted).toEqual([]);
  });

  it('lists a gear\'s teeth, flat or in its own spec', () => {
    expect(ok(buildMechanism({ family: 'gear', teeth: 3, moduleMm: 3, boreKind: 'none' }, [])).adjusted).toEqual([{ field: 'teeth', requested: 3, used: 6 }]);
    expect(ok(buildMechanism({ family: 'gear_pair', driver: { teeth: 4, moduleMm: 3, boreKind: 'none' }, driven: { teeth: 30, moduleMm: 3 } }, [])).adjusted)
      .toEqual([{ field: 'driver.teeth', requested: 4, used: 6 }]);
    expect(ok(buildMechanism({ family: 'gt2_belt', driverTeeth: 8, boreDiameterMm: 3 }, [])).adjusted).toEqual([{ field: 'driverTeeth', requested: 8, used: 12 }]);
  });
});
