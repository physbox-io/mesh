// A headless run says which bodies' damage it does not feel.
//
// Shatter and dent are simulated headless now (tests/headlessShatter.test.ts),
// but a surface set to deformCollision is rebuilt around its damage only live.

import { describe, it, expect } from 'vitest';
import { headlessImpactWarning, unsimulatedImpacts } from '../src/utils/headlessLimits';
import type { SceneNode } from '../src/types/scene';

const body = (over: Partial<SceneNode>): SceneNode =>
  ({ id: over.name, type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms: [], ...over } as SceneNode);

describe('headless impact limits', () => {
  it('names only the bodies whose damage is real to the solver', () => {
    const nodes = [
      body({ name: 'chair', shatterImpulseNs: 8 }),
      body({ name: 'can', geoms: [{ name: 'can_geom', type: 'cylinder', size: [0.03, 0.06], dentYieldNs: 2 }] }),
      body({ name: 'floor_box', children: [body({ name: 'plate', geoms: [{ name: 'p', type: 'box', size: [0.1, 0.1, 0.01], dentYieldNs: 2, deformCollision: true }] })] }),
      body({ name: 'arm' }),
    ];
    expect(unsimulatedImpacts(nodes)).toEqual(['plate']);
    const warning = headlessImpactWarning(nodes)!;
    expect(warning).toMatch(/plate has deformCollision set/);
    expect(warning).not.toMatch(/chair|can/);
    expect(warning).toMatch(/physics_play/);
  });

  it('says nothing for a scene that only shatters and dents cosmetically', () => {
    expect(headlessImpactWarning([body({ name: 'chair', shatterImpulseNs: 8 }), body({ name: 'arm' })])).toBeNull();
  });
});
