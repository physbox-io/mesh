// Does a ball dropped into a cup stay in the cup?
//
// This is the whole point of the feature, and it is the one question none of the
// other tests can answer: MuJoCo decides it, not us. So this runs the real
// engine, headlessly, on a hollow body and asserts where the ball comes to rest.
//
// The control matters as much as the test. Without it, "the ball ended up at
// z = 0.05" proves nothing — it could be resting on anything. Run the SAME cup
// with its convex pieces removed and the ball stops dead at the rim, on the
// invisible lid that is MuJoCo's convex hull of a hollow shape. That difference
// is the bug, and the two assertions together are the fix.
//
// The pieces come from a pure fixture generator rather than from the decomposer,
// so this suite needs no wasm and no Worker and runs in the default vitest pass.

import { describe, it, expect, afterAll } from 'vitest';
import { hullsToColliderGeoms, meshVolumeAndCentroid, type Hull } from '../src/utils/csg';
import { boxMesh, openTopBoxMesh, openTopBoxSlabs, zupToYupFlat } from './helpers/meshes';
import { simulate, type Sim } from './helpers/simulate';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const OUTER = 0.10;
const WALL = 0.02;
const HEIGHT = 0.12;
const BALL_R = 0.03;
const DROP_Z = 0.30;

/** Where the cavity floor and the rim actually are, in world Z. */
const CAVITY_FLOOR_Z = WALL;
const RIM_Z = HEIGHT;
/** The inner half-width the ball has to stay within to be "in the cup". */
const INNER = OUTER - WALL;

const cupHulls = (): Hull[] => openTopBoxSlabs({ outer: OUTER, wall: WALL, height: HEIGHT }).map(s => {
  const m = boxMesh(s.c, s.h);
  const { volume, centroid } = meshVolumeAndCentroid(m.verts, m.faces);
  return { verts: m.verts, faces: m.faces, volume, centroid };
});

/**
 * A static cup sitting on the floor, plus a ball above its rim.
 *
 * `decomposed` is the only difference between the scene under test and its
 * control: the cup's mesh, its position and the ball are identical either way.
 */
function cupScene(decomposed: boolean): SceneGraph {
  const shell = openTopBoxMesh({ outer: OUTER, wall: WALL, height: HEIGHT });
  const mesh: SceneGeom = {
    name: 'cup_mesh',
    type: 'mesh',
    size: [1],
    rgba: [0.3, 0.6, 0.9, 1],
    renderVertices: shell.verts,
    vertices: zupToYupFlat(shell.verts),
    faces: shell.faces,
  };

  const cup: SceneNode = {
    id: 'cup', name: 'cup', type: 'body', pos: [0, 0, 0], children: [], joints: [],
    geoms: decomposed
      ? [mesh, ...hullsToColliderGeoms(cupHulls(), 'cup', undefined, 1)]
      : [mesh],
  };

  const ball: SceneNode = {
    id: 'ball', name: 'ball', type: 'body', pos: [0, 0, DROP_Z], children: [],
    joints: [{ name: 'ball_free', type: 'free' }],
    geoms: [{ name: 'ball_geom', type: 'sphere', size: [BALL_R], mass: 0.05, rgba: [1, 0.3, 0.2, 1] }],
  };

  return { nodes: [cup, ball] } as SceneGraph;
}

describe('a ball dropped into a hollow cup', () => {
  const sims: Sim[] = [];
  const run = async (decomposed: boolean) => {
    const sim = await simulate(cupScene(decomposed));
    sims.push(sim);
    sim.run(2.5);
    return sim.bodyPos('ball');
  };
  afterAll(() => { for (const s of sims) s.dispose(); });

  it('lands INSIDE the cup once the shape collides as convex pieces', async () => {
    const [x, y, z] = await run(true);

    // Below the rim: it actually went in.
    expect(z).toBeLessThan(RIM_Z);
    // Resting on the cavity floor, not sunk through it and not on the ground.
    expect(z).toBeGreaterThan(CAVITY_FLOOR_Z);
    expect(z).toBeCloseTo(CAVITY_FLOOR_Z + BALL_R, 2);
    // Still in the cup, not squeezed out through a wall.
    expect(Math.hypot(x, y)).toBeLessThan(INNER);
    // And the solver did not blow up doing it.
    expect(Number.isFinite(z)).toBe(true);
  });

  it('rests on thin air at the rim when the same cup collides as one hull', async () => {
    // The bug, reproduced. MuJoCo hulls the mesh, the hull has no cavity, and
    // the ball stops on top of a cup it should have fallen into.
    const [, , z] = await run(false);
    expect(z).toBeGreaterThan(RIM_Z);
    expect(z).toBeCloseTo(RIM_Z + BALL_R, 2);
  });

  it('is the pieces that make the difference, not the drop', async () => {
    const [, , inside] = await run(true);
    const [, , onTop] = await run(false);
    expect(onTop - inside).toBeGreaterThan(HEIGHT - WALL - 0.01);
  });
});
