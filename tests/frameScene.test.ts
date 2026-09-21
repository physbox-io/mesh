import { describe, it, expect } from 'vitest';
import {
  sceneContentBounds,
  framingForBounds,
  gridCellForBounds,
  DEFAULT_VIEW_DISTANCE,
} from '../src/utils/frameScene';
import { PRESETS } from '../src/presets/presetScenes';
import type { SceneNode, SceneGeom } from '../src/types/scene';

function body(geoms: Partial<SceneGeom>[], pos: number[] = [0, 0, 0]): SceneNode {
  return {
    id: 'b',
    name: 'b',
    type: 'body',
    pos,
    geoms: geoms.map((g, i) => ({ name: `g${i}`, ...g }) as SceneGeom),
    joints: [],
    children: [],
  };
}

/** How far from the target the fitted camera ends up. */
function distance(nodes: SceneNode[]): number {
  const bounds = sceneContentBounds(nodes)!;
  const f = framingForBounds(bounds);
  return Math.hypot(
    f.position[0] - f.target[0],
    f.position[1] - f.target[1],
    f.position[2] - f.target[2]
  );
}

describe('sceneContentBounds', () => {
  it('bounds a box by its half-sizes, about the body it hangs off', () => {
    const b = sceneContentBounds([body([{ type: 'box', size: [0.01, 0.02, 0.03] }], [0, 0, 0.1])])!;
    expect(b.min).toEqual([-0.01, -0.02, 0.07]);
    expect(b.max).toEqual([0.01, 0.02, 0.13]);
  });

  it('includes a child body', () => {
    const parent = body([{ type: 'box', size: [0.01, 0.01, 0.01] }]);
    parent.children = [body([{ type: 'sphere', size: [0.005] }], [0, 0, 0.2])];
    const b = sceneContentBounds([parent])!;
    expect(b.max[2]).toBeCloseTo(0.205, 6);
  });

  it('ignores the ground plane, which has no bounds to frame', () => {
    expect(sceneContentBounds([body([{ type: 'plane', size: [0, 0, 1] }])])).toBeNull();
  });

  it('is null for an empty scene, so the default view is left alone', () => {
    expect(sceneContentBounds([])).toBeNull();
  });
});

describe('framingForBounds', () => {
  it('draws a millimetre the same size whatever the part is', () => {
    // Not a fit-to-window: a 2mm part and a 40mm part are both seen from the
    // default distance, so the small one reads as small — just not as a speck
    // in a window two thirds of a metre across.
    const tiny = distance([body([{ type: 'box', size: [0.001, 0.001, 0.001] }])]);
    const small = distance([body([{ type: 'box', size: [0.02, 0.02, 0.02] }])]);
    expect(tiny).toBeCloseTo(DEFAULT_VIEW_DISTANCE, 6);
    expect(small).toBeCloseTo(DEFAULT_VIEW_DISTANCE, 6);
  });

  it('shows about 250mm of world, well under the 0.8m the view used to open at', () => {
    expect(DEFAULT_VIEW_DISTANCE).toBeGreaterThan(0.25);
    expect(DEFAULT_VIEW_DISTANCE).toBeLessThan(0.35);
  });

  it('backs off for a scene too big for that window, rather than clipping it', () => {
    const d = distance([body([{ type: 'box', size: [1, 1, 1] }])]);
    expect(d).toBeGreaterThan(3);
  });

  it('looks at the centre of the content, not the world origin', () => {
    const bounds = sceneContentBounds([body([{ type: 'box', size: [0.01, 0.01, 0.01] }], [0, 0, 0.5])])!;
    expect(framingForBounds(bounds).target[2]).toBeCloseTo(0.5, 6);
  });

  it('keeps the front-right-above viewing angle', () => {
    const bounds = sceneContentBounds([body([{ type: 'box', size: [0.05, 0.05, 0.05] }])])!;
    const f = framingForBounds(bounds);
    expect(f.position[0]).toBeGreaterThan(0);
    expect(f.position[1]).toBeLessThan(0);
    expect(f.position[2]).toBeGreaterThan(0);
  });

  it('asks for more room in a tall window than a wide one', () => {
    const bounds = sceneContentBounds([body([{ type: 'box', size: [0.05, 0.05, 0.05] }])])!;
    const wide = framingForBounds(bounds, 2);
    const tall = framingForBounds(bounds, 0.5);
    expect(tall.position[2]).toBeGreaterThan(wide.position[2]);
  });
});

describe('gridCellForBounds', () => {
  it('draws millimetre paper under a coin-sized part', () => {
    expect(gridCellForBounds({ min: [0, 0, 0], max: [0.008, 0.008, 0.002] })).toBe(1);
  });

  it('draws 10mm cells under the sizes people usually cut', () => {
    expect(gridCellForBounds({ min: [0, 0, 0], max: [0.035, 0.03, 0.02] })).toBe(10);
    expect(gridCellForBounds({ min: [0, 0, 0], max: [0.25, 0.2, 0.02] })).toBe(10);
  });

  it('keeps 100mm cells under a room-sized scene', () => {
    expect(gridCellForBounds({ min: [0, 0, 0], max: [4, 4, 3] })).toBe(100);
  });

  it('falls back to 10mm when there is nothing to measure', () => {
    expect(gridCellForBounds(null)).toBe(10);
  });
});

describe('the presets this was noticed on', () => {
  it('measures the California relief, whose mesh only carries Y-up vertices', () => {
    // 50 x 40 x 40 mm, per CALIFORNIA_RELIEF_SETTINGS. A mesh written by hand
    // has no renderVertices, and reading nothing is how it ended up unframed.
    const b = sceneContentBounds(PRESETS['california_relief'].scene!.nodes)!;
    const extentMm = Math.max(...[0, 1, 2].map(a => (b.max[a] - b.min[a]) * 1000));
    expect(extentMm).toBeGreaterThan(20);
    expect(extentMm).toBeLessThan(80);
    expect(gridCellForBounds(b)).toBe(10);
  });

  it('pulls back for the pendulum, which is taller than the default window', () => {
    const d = distance(PRESETS['pendulum'].scene!.nodes);
    expect(d).toBeGreaterThan(DEFAULT_VIEW_DISTANCE);
  });
});
