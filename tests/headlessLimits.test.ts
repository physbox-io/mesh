// A headless run says which bodies it leaves whole.
//
// A lattice chair set to shatter at 8 N·s shattered at 0.46 s when played
// live, and finished whole in physics_run_headless with nothing in
// get_breaks: shatter (and dent) are decided and cut on the main thread, which
// a headless run never hands an impact to.

import { describe, it, expect } from 'vitest';
import { headlessImpactWarning, unsimulatedImpacts } from '../src/utils/headlessLimits';
import type { SceneNode } from '../src/types/scene';

const body = (over: Partial<SceneNode>): SceneNode =>
  ({ id: over.name, type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms: [], ...over } as SceneNode);

describe('headless impact limits', () => {
  it('names the bodies that would shatter or dent', () => {
    const nodes = [
      body({ name: 'chair', shatterImpulseNs: 8 }),
      body({ name: 'can', geoms: [{ name: 'can_geom', type: 'cylinder', size: [0.03, 0.06], dentYieldNs: 2 }] }),
      body({ name: 'floor_box', children: [body({ name: 'vase', shatterImpulseNs: 1 })] }),
      body({ name: 'arm' }),
    ];
    expect(unsimulatedImpacts(nodes)).toEqual({ shatter: ['chair', 'vase'], dent: ['can'] });
    const warning = headlessImpactWarning(nodes)!;
    expect(warning).toMatch(/chair, vase are set to shatter/);
    expect(warning).toMatch(/can is set to dent/);
    expect(warning).toMatch(/physics_play/);
  });

  it('says nothing for a scene with nothing to shatter', () => {
    expect(headlessImpactWarning([body({ name: 'arm' })])).toBeNull();
  });
});
