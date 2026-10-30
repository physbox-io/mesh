// The key light's shadow box follows the scene. It was a fixed ±0.8 m on the
// origin, so of three levers laid a metre apart only one cast a shadow.

import { describe, it, expect } from 'vitest';
import { shadowFrame, MIN_SHADOW_HALF, MAX_SHADOW_HALF } from '../src/utils/shadowFrame';
import { sceneContentBounds } from '../src/utils/frameScene';
import type { SceneNode } from '../src/types/scene';

const plank = (id: string, x: number, y: number): SceneNode => ({
  id, name: id, pos: [x, y, 0.5], joints: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.75, 0.08, 0.02] }],
} as unknown as SceneNode);

describe('the shadow frame', () => {
  it('is the bench box on the origin for an empty scene or a bench-sized part', () => {
    expect(shadowFrame(null)).toMatchObject({ center: [0, 0], half: MIN_SHADOW_HALF });
    const part = sceneContentBounds([{ ...plank('p', 0, 0), geoms: [{ name: 'p_g', type: 'box', size: [0.05, 0.05, 0.05] }] } as SceneNode]);
    expect(shadowFrame(part)).toMatchObject({ center: [0, 0], half: MIN_SHADOW_HALF });
  });

  it('covers every plank of three levers a metre apart', () => {
    const nodes = [plank('a', 0, -1), plank('b', 0.75, 0), plank('c', 0.75, 1)];
    const f = shadowFrame(sceneContentBounds(nodes));
    for (const n of nodes) {
      // MuJoCo (x, y) is three's (x, -z); each plank's ends, and its shadow's reach at 0.5 m up.
      const [x, y] = n.pos;
      for (const dx of [-0.75, 0.75]) {
        expect(Math.abs(x + dx - f.center[0])).toBeLessThanOrEqual(f.half);
        expect(Math.abs(-y - f.center[1]) + 0.08).toBeLessThanOrEqual(f.half);
      }
    }
    expect(f.far).toBeGreaterThan(Math.hypot(1.5, 3, 1.5) + f.half);
  });

  it('stops at a ceiling for a scene kilometres wide', () => {
    expect(shadowFrame({ min: [-1000, -1000, 0], max: [1000, 1000, 1] }).half).toBe(MAX_SHADOW_HALF);
  });
});
