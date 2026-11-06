// ---------------------------------------------------------------------------
// Brickwork presets: a garden smoker to build in UK brick, and a castle to
// build in toy bricks
// ---------------------------------------------------------------------------
//
// Each starts as a model: the walls as one solid body, drawn the way a
// builder draws a job to the brick's own measure (whole and half bricks
// along, whole courses up), with what is not brick beside it. Select the
// walls and Make → Brick lays them in brick (or toy bricks), in their place.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import type { BrickworkOptions } from '../utils/brickwork';

/** A box from its two corners, metres. */
const span = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): SceneGeom => ({
  name, type: 'box',
  size: [(x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2],
  pos: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
});

const shape = (geoms: SceneGeom[]): SceneGraph =>
  ({ nodes: [{ id: 'shape', name: 'Shape', type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms }] }) as SceneGraph;

// --- Smoker ----------------------------------------------------------------
//
// UK brick: 215 × 102.5 × 65, 10 mm joints, so 225 mm a brick along and 75 mm
// a course. A single leaf, half a brick thick, in stretcher bond, as a garden
// smoker is built: outside 5 × 4 bricks (1115 × 890), so the corners turn on
// whole bricks. Firebox below (courses 1-8), cooking chamber above (9-16), a
// concrete roof slab (17), and a chimney a brick and a half square (18-25).

const C = 0.075;
const SX = 0.5575, SY = 0.445, T = 0.1025;
/**
 * Half-widths: the firebox mouth (piers a brick and a half), its lintel
 * (bearing half a brick), the door (piers a brick) and its lintel.
 */
const FB = 0.23, FBL = 0.3425, DR = 0.3425, DRL = 0.455;

export const SMOKER_OPTIONS: Partial<BrickworkOptions> = { standardId: 'uk', bond: 'stretcher' };

export const smokerShape = (): SceneGraph => {
  const front: SceneGeom[] = [
    span('fb_l', -SX, -FB, -SY, -SY + T, 0, 4 * C), span('fb_r', FB, SX, -SY, -SY + T, 0, 4 * C),
    span('fb_lintel_l', -SX, -FBL, -SY, -SY + T, 4 * C, 5 * C), span('fb_lintel_r', FBL, SX, -SY, -SY + T, 4 * C, 5 * C),
    span('mid', -SX, SX, -SY, -SY + T, 5 * C, 8 * C),
    span('dr_l', -SX, -DR, -SY, -SY + T, 8 * C, 14 * C), span('dr_r', DR, SX, -SY, -SY + T, 8 * C, 14 * C),
    span('dr_lintel_l', -SX, -DRL, -SY, -SY + T, 14 * C, 15 * C), span('dr_lintel_r', DRL, SX, -SY, -SY + T, 14 * C, 15 * C),
    span('top', -SX, SX, -SY, -SY + T, 15 * C, 16 * C),
  ];
  const walls: SceneGeom[] = [
    ...front,
    span('back', -SX, SX, SY - T, SY, 0, 16 * C),
    span('left', -SX, -SX + T, -SY + T, SY - T, 0, 16 * C),
    span('right', SX - T, SX, -SY + T, SY - T, 0, 16 * C),
    // Chimney on the slab at the back, half a brick thick round a flue 122.5 square.
    span('ch_f', -0.16375, 0.16375, -0.06, 0.0425, 17 * C, 25 * C),
    span('ch_b', -0.16375, 0.16375, 0.165, 0.2675, 17 * C, 25 * C),
    span('ch_l', -0.16375, -0.06125, 0.0425, 0.165, 17 * C, 25 * C),
    span('ch_r', 0.06125, 0.16375, 0.0425, 0.165, 17 * C, 25 * C),
  ];
  return shape(walls);
};

/** The concrete, the steel and the door: what is not brick. */
export const smokerExtras = (): SceneNode[] => {
  const concrete = [0.62, 0.61, 0.58, 1];
  const steel = [0.22, 0.23, 0.25, 1];
  const fixed = (id: string, name: string, geoms: SceneGeom[]): SceneNode => ({ id, name, type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms });
  const extras: SceneNode[] = [
    fixed('smoker_lintels', 'Lintels', [
      { ...span('firebox_lintel', -FBL + 0.005, FBL - 0.005, -SY, -SY + T, 4 * C, 5 * C - 0.01), rgba: concrete, density: 2400 },
      { ...span('door_lintel', -DRL + 0.005, DRL - 0.005, -SY, -SY + T, 14 * C, 15 * C - 0.01), rgba: concrete, density: 2400 },
    ]),
    fixed('smoker_slab', 'Roof slab', [
      { ...span('slab', -SX - 0.03, SX + 0.03, -SY - 0.03, SY + 0.03, 16 * C - 0.01, 17 * C - 0.01), rgba: concrete, density: 2400 },
    ]),
    // The baffle the firebox heats, open at the back for the smoke to rise
    // past; and the grate, both resting on the brickwork's inner faces.
    fixed('smoker_steel', 'Baffle and grate', [
      { ...span('baffle', -SX + T, SX - T, -SY + T, SY - T - 0.12, 8 * C - 0.016, 8 * C - 0.01), rgba: steel, density: 7850 },
      { ...span('grate', -SX + T, SX - T, -SY + T, SY - T, 11 * C - 0.016, 11 * C - 0.01), rgba: [0.35, 0.36, 0.38, 1], density: 2000 },
    ]),
    {
      // A steel door on a hinge down its left edge; push it and it swings.
      id: 'smoker_door', name: 'Door', type: 'body', pos: [-DR - 0.01, -SY - 0.012, 8 * C],
      joints: [{ name: 'door_hinge', type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0], damping: 2, limited: true, range: [-110, 0] }],
      children: [],
      geoms: [
        { ...span('door_plate', 0, 2 * DR + 0.02, -0.006, 0.006, 0.0, 6 * C - 0.01), rgba: steel, density: 7850 },
        { name: 'door_handle', type: 'capsule', size: [0.008], fromto: [2 * DR - 0.04, -0.03, 0.12, 2 * DR - 0.04, -0.03, 0.32], rgba: [0.1, 0.1, 0.1, 1], density: 7850 },
      ],
    },
  ];
  return extras;
};

// --- Castle ----------------------------------------------------------------
//
// Toy bricks on the 8 mm stud grid, 9.6 mm a course. 40 × 40 studs: four
// towers 10 studs square and 25 courses tall, curtain walls 2 studs thick
// and 17 courses, battlements on both, and a gateway with a drawbridge down.

const P = 0.008, H = 0.0096;

export const CASTLE_OPTIONS: Partial<BrickworkOptions> = { standardId: 'toy' };

export const castleShape = (): SceneGraph => {
  const g: SceneGeom[] = [];
  const at = (n: number) => n * P;
  const box = (name: string, i0: number, i1: number, j0: number, j1: number, k0: number, k1: number) =>
    g.push(span(name, at(i0), at(i1), at(j0), at(j1), k0 * H, k1 * H));
  // Towers at the corners, studs 0-10 and 30-40, with merlons on top.
  for (const [ti, tj] of [[0, 0], [30, 0], [0, 30], [30, 30]]) {
    box(`tower_${ti}_${tj}`, ti, ti + 10, tj, tj + 10, 0, 23);
    for (let m = 0; m < 10; m += 4) {
      box(`merlon_${ti}_${tj}_a${m}`, ti + m, ti + m + 2, tj, tj + 2, 23, 25);
      box(`merlon_${ti}_${tj}_b${m}`, ti + m, ti + m + 2, tj + 8, tj + 10, 23, 25);
      box(`merlon_${ti}_${tj}_c${m}`, ti, ti + 2, tj + m, tj + m + 2, 23, 25);
      box(`merlon_${ti}_${tj}_d${m}`, ti + 8, ti + 10, tj + m, tj + m + 2, 23, 25);
    }
  }
  // Curtain walls between the towers, battlements along the top.
  const wall = (name: string, i0: number, i1: number, j0: number, j1: number, along: 'x' | 'y', gate = false) => {
    if (gate) {
      // A gateway 8 studs wide and 10 courses high in the middle.
      box(`${name}_l`, i0, 16, j0, j1, 0, 10);
      box(`${name}_r`, 24, i1, j0, j1, 0, 10);
      box(`${name}_over`, i0, i1, j0, j1, 10, 15);
    } else {
      box(name, i0, i1, j0, j1, 0, 15);
    }
    for (let m = 0; m < 20; m += 4) {
      if (along === 'x') box(`${name}_m${m}`, i0 + m, i0 + m + 2, j0, j1, 15, 17);
      else box(`${name}_m${m}`, i0, i1, j0 + m, j0 + m + 2, 15, 17);
    }
  };
  wall('wall_front', 10, 30, 0, 2, 'x', true);
  wall('wall_back', 10, 30, 38, 40, 'x');
  wall('wall_left', 0, 2, 10, 30, 'y');
  wall('wall_right', 38, 40, 10, 30, 'y');

  return shape(g);
};

export const castleExtras = (): SceneNode[] => {
  const at = (n: number) => n * P;
  // A drawbridge on a hinge at the gate's sill, lowered onto the ground.
  const drawbridge: SceneNode = {
    id: 'castle_drawbridge', name: 'Drawbridge', type: 'body', pos: [at(20), 0, 0.002],
    joints: [{ name: 'drawbridge_hinge', type: 'hinge', axis: [1, 0, 0], pos: [0, 0, 0], damping: 0.002, limited: true, range: [0, 90] }],
    children: [],
    geoms: [{ ...span('planks', -at(4) + 0.001, at(4) - 0.001, -0.07, -0.001, -0.002, 0.002), rgba: [0.45, 0.3, 0.16, 1], density: 600 }],
  };
  return [drawbridge];
};

/** The model of the brickwork: one solid body, to be laid in brick. */
const model = (id: string, name: string, shapeScene: SceneGraph, rgba: number[]): SceneNode => ({
  id, name, type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: shapeScene.nodes[0].geoms.map((g) => ({ ...g, rgba })),
});

export const smokerPreset: SceneGraph = {
  nodes: [model('smoker_walls', 'Smoker walls', smokerShape(), [0.66, 0.31, 0.22, 1]), ...smokerExtras()],
  brickwork: SMOKER_OPTIONS,
};

export const toyCastlePreset: SceneGraph = {
  nodes: [model('castle', 'Castle', castleShape(), [0.62, 0.62, 0.6, 1]), ...castleExtras()],
  brickwork: CASTLE_OPTIONS,
};
