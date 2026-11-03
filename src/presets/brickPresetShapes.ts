// ---------------------------------------------------------------------------
// The shapes the brickwork presets are laid from, and what goes with them
// ---------------------------------------------------------------------------
//
// A smoker in UK brick and a castle in toy bricks, each a plain shape — boxes
// for the walls, the openings left out — laid by utils/brickwork.ts exactly as
// Build → Brick lays a model. The shapes keep to the brick's own measure
// (whole bricks along, whole courses up), as a builder would draw them.
//
// Laying them takes a few hundred milliseconds, too long to do on the page
// when a preset loads, so scripts/gen_brick_presets.ts lays them ahead of time
// into brickPresetData.ts; tests/brickPresets.test.ts lays them again and
// fails if that data is stale. Change a shape here, then run the script.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import type { BrickColour, BrickworkOptions, PlacedBrick } from '../utils/brickwork';

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
// a course. Outside 5 × 3½ bricks (1115 × 777.5), walls a brick thick, in
// stretcher bond, as a garden smoker is laid. Firebox below (courses 1-8), cooking chamber above (9-16),
// a concrete roof slab (17), and a chimney a brick and a half square (18-25).

const C = 0.075;
const SX = 0.5575, SY = 0.38875, T = 0.215;

export const SMOKER_OPTIONS: Partial<BrickworkOptions> = { standardId: 'uk', bond: 'stretcher' };

export const smokerShape = (): SceneGraph => {
  const front: SceneGeom[] = [
    // Firebox mouth 450 wide, four courses high, under a concrete lintel.
    span('fb_l', -SX, -0.225, -SY, -SY + T, 0, 4 * C), span('fb_r', 0.225, SX, -SY, -SY + T, 0, 4 * C),
    span('fb_lintel_l', -SX, -0.375, -SY, -SY + T, 4 * C, 5 * C), span('fb_lintel_r', 0.375, SX, -SY, -SY + T, 4 * C, 5 * C),
    span('mid', -SX, SX, -SY, -SY + T, 5 * C, 8 * C),
    // Door 600 wide, six courses, and its lintel.
    span('dr_l', -SX, -0.3, -SY, -SY + T, 8 * C, 14 * C), span('dr_r', 0.3, SX, -SY, -SY + T, 8 * C, 14 * C),
    span('dr_lintel_l', -SX, -0.45, -SY, -SY + T, 14 * C, 15 * C), span('dr_lintel_r', 0.45, SX, -SY, -SY + T, 14 * C, 15 * C),
    span('top', -SX, SX, -SY, -SY + T, 15 * C, 16 * C),
  ];
  const walls: SceneGeom[] = [
    ...front,
    span('back', -SX, SX, SY - T, SY, 0, 16 * C),
    span('left', -SX, -SX + T, -SY + T, SY - T, 0, 16 * C),
    span('right', SX - T, SX, -SY + T, SY - T, 0, 16 * C),
    // Chimney on the slab at the back, flue 122.5 square.
    span('ch_f', -0.16375, 0.16375, 0.0 - 0.06, 0.0425, 17 * C, 25 * C),
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
      { ...span('firebox_lintel', -0.375, 0.375, -SY, -SY + T, 4 * C, 5 * C - 0.01), rgba: concrete, density: 2400 },
      { ...span('door_lintel', -0.45, 0.45, -SY, -SY + T, 14 * C, 15 * C - 0.01), rgba: concrete, density: 2400 },
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
      id: 'smoker_door', name: 'Door', type: 'body', pos: [-0.31, -SY - 0.012, 8 * C],
      joints: [{ name: 'door_hinge', type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0], damping: 2, limited: true, range: [-110, 0] }],
      children: [],
      geoms: [
        { ...span('door_plate', 0, 0.62, -0.006, 0.006, 0.0, 6 * C - 0.01), rgba: steel, density: 7850 },
        { name: 'door_handle', type: 'capsule', size: [0.008], fromto: [0.56, -0.03, 0.12, 0.56, -0.03, 0.32], rgba: [0.1, 0.1, 0.1, 1], density: 7850 },
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
export const stone: BrickColour = (b, i) => {
  const h = Math.sin(i * 12.9898) * 43758.5453;
  const v = (h - Math.floor(h)) * 0.08 - 0.04;
  // The battlements a shade lighter, as weathered tops are.
  const top = b.z > 0.15 ? 0.04 : 0;
  return [0.6 + v + top, 0.6 + v + top, 0.58 + v + top, 1];
};

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

// --- The laid bricks, as numbers ---------------------------------------------
//
// Eight to a brick: x, y, z (mm, 0.01), length and depth (mm, 0.01), angle
// (radians, 1e-5), flags (1 header, 2 closer, 4 cut) and course.


const r2 = (v: number) => Math.round(v * 100) / 100 || 0;

export function encodeBricks(bricks: PlacedBrick[]): number[] {
  return bricks.flatMap((b) => [
    r2(b.x), r2(b.y), r2(b.z), r2(b.lengthMm), r2(b.depthMm), Math.round(b.angle * 1e5) / 1e5 || 0,
    (b.header ? 1 : 0) | (b.closer ? 2 : 0) | (b.cut ? 4 : 0), b.course,
  ]);
}

export function decodeBricks(data: readonly number[]): PlacedBrick[] {
  const out: PlacedBrick[] = [];
  for (let i = 0; i + 7 < data.length; i += 8) {
    out.push({
      x: data[i], y: data[i + 1], z: data[i + 2], lengthMm: data[i + 3], depthMm: data[i + 4], angle: data[i + 5],
      header: (data[i + 6] & 1) !== 0, closer: (data[i + 6] & 2) !== 0, cut: (data[i + 6] & 4) !== 0, course: data[i + 7],
    });
  }
  return out;
}
