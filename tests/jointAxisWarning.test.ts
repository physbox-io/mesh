// A hinge or slide with no axis is built about the body's Z, and now says so.
// A seesaw meant to swing about Y was written without one and never moved.

import { describe, it, expect } from 'vitest';
import { jointAxisWarnings } from '../src/utils/jointAxisCheck';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneNode } from '../src/types/scene';

const seesaw = (axis?: number[]) => fillBodyDefaults({
  id: 'beam', name: 'beam', pos: [0, 0, 0.5],
  joints: [{ name: 'pivot', type: 'hinge', ...(axis ? { axis } : {}) }],
  geoms: [{ name: 'plank', type: 'box', size: [1, 0.1, 0.02] }],
});

describe('a hinge or slide with no axis', () => {
  it('is left on MuJoCo default, as before', () => {
    const xml = compileToMJCF({ nodes: [seesaw()] });
    expect(xml).toMatch(/<joint name="pivot" type="hinge" \/>/);
  });

  it('is named in a warning that says which way it turns', () => {
    const w = jointAxisWarnings([seesaw()]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("'pivot' on 'beam' is a hinge with no axis");
    expect(w[0]).toContain("body's own Z");
  });

  it('is found at any depth, slides included, and a zero axis counts as none', () => {
    const parent = { ...seesaw([0, 1, 0]), children: [
      { id: 'carriage', name: 'carriage', pos: [0, 0, 0], joints: [{ name: 'rail', type: 'slide', axis: [0, 0, 0] }], geoms: [] },
    ] } as SceneNode;
    const w = jointAxisWarnings([parent]);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("'rail' on 'carriage' is a slide with no axis it can use");
  });

  it('says nothing of a joint with an axis, or of free and ball joints', () => {
    const ball = { ...seesaw([0, 1, 0]), joints: [{ name: 'b', type: 'ball' }, { name: 'f', type: 'free' }] } as SceneNode;
    expect(jointAxisWarnings([seesaw([0, 1, 0]), ball])).toEqual([]);
  });
});
