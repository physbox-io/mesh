// ---------------------------------------------------------------------------
// Presets built from bought hardware
//
// Each is assembled the way a user would assemble it — cut the seat, put the
// part in it, fix what rides on what — by the same pure functions the panels
// and MCP call, so a preset is also a check that those functions still put
// things where they belong. Nothing moves that a real part would not let move:
// drawers run on their runners, the plotter's head on its rails, the platter
// on its bearing, the launcher on its spring.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { HardwarePart, SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { cutGeometry } from '../utils/csg';
import { hardwareCutGeoms, type HardwareCutSpec } from '../utils/hardwareCuts';
import { fasten, hardwarePartNode, rebuildPart, screwFit, seatFor, seatPart } from '../utils/hardwareParts';
import { addDrawerRunners, fixToPiece } from '../utils/linearPlacement';
import { carriageRange, joinPose, meeting, type JoinKind } from '../utils/extrusionParts';

const WOOD: number[] = [0.6, 0.42, 0.27, 1];
const WOOD_FRONT: number[] = [0.72, 0.53, 0.35, 1];
const PLA_GREY: number[] = [0.3, 0.33, 0.37, 1];
const PLA_ORANGE: number[] = [0.95, 0.45, 0.12, 1];
const PLA_TEAL: number[] = [0.1, 0.6, 0.6, 1];

const box = (name: string, half: number[], pos: number[], rgba: number[], mass?: number, extra: Partial<SceneGeom> = {}): SceneGeom => ({
  name, type: 'box', size: half, pos, rgba: [...rgba], ...(mass !== undefined ? { mass } : {}), ...extra,
});

const body = (id: string, pos: number[], geoms: SceneGeom[], free: boolean, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, type: 'body', pos, geoms, children: [], joints: free ? [{ name: `${id}_free`, type: 'free' }] : [], ...extra,
});

/** A hardware cut, as the store's writeHardwareGroup makes one. */
function cut(node: SceneNode, spec: Omit<HardwareCutSpec, 'group'>, group: string): string {
  node.csgEnabled = true;
  node.csgCollision = node.csgCollision ?? 'auto';
  for (const piece of hardwareCutGeoms({ ...spec, group }, node.id, node)) {
    node.geoms.push(piece);
    Object.assign(piece, cutGeometry(node, piece));
  }
  return group;
}

/** A bought part seated in a host's cut. */
function seat(host: SceneNode, group: string, part: HardwarePart, id: string): SceneNode {
  const node = hardwarePartNode(part, id);
  host.children.push(node);
  if (!seatPart(node, host, group, part.lengthMm)) throw new Error(`preset: ${id} does not seat in ${host.id}/${group}`);
  return node;
}

function must<T extends { ok: boolean }>(r: T, what: string): T {
  if (!r.ok) throw new Error(`preset: ${what}: ${(r as unknown as { problem: string }).problem}`);
  return r;
}

// ---------------------------------------------------------------------------
// Chest of drawers
// ---------------------------------------------------------------------------

const CHEST = { inside: 0.4, depth: 0.42, wall: 0.018, drawers: 4, pitch: 0.15 };

function chestOfDrawers(): SceneGraph {
  const { inside: W, depth: D, wall: t, drawers: N, pitch: P } = CHEST;
  const H = N * P + 0.01;
  const chest = body('chest', [0, 0, 0], [
    box('chest_left', [t / 2, D / 2, H / 2 + t], [-W / 2 - t / 2, 0, H / 2 + t], WOOD, 3),
    box('chest_right', [t / 2, D / 2, H / 2 + t], [W / 2 + t / 2, 0, H / 2 + t], WOOD, 3),
    box('chest_bottom', [W / 2, D / 2, t / 2], [0, 0, t / 2], WOOD, 2),
    box('chest_top', [W / 2 + t, D / 2 + t / 2, t / 2], [0, t / 2, H + 1.5 * t], WOOD, 2.5),
    box('chest_back', [W / 2, t / 2, H / 2], [0, D / 2 + t / 2, t + H / 2], WOOD, 1.5),
  ], false);
  const scene: SceneGraph = { nodes: [chest] } as SceneGraph;

  const Wd = W - 2 * 0.0127; // the drawer box: 12.7 mm each side for its runners
  const hd = 0.1;
  for (let i = 0; i < N; i++) {
    const id = `drawer_${i + 1}`;
    const zc = t + 0.02 + i * P + hd / 2;
    const ply = 0.012;
    const drawer = body(id, [0, -D / 2 + 0.2, zc], [
      box(`${id}_bottom`, [Wd / 2, 0.2, ply / 2], [0, 0, -hd / 2 + ply / 2], WOOD, 0.6),
      box(`${id}_left`, [ply / 2, 0.2, hd / 2], [-Wd / 2 + ply / 2, 0, 0], WOOD, 0.35),
      box(`${id}_right`, [ply / 2, 0.2, hd / 2], [Wd / 2 - ply / 2, 0, 0], WOOD, 0.35),
      box(`${id}_back`, [Wd / 2 - ply, ply / 2, hd / 2], [0, 0.2 - ply / 2, 0], WOOD, 0.25),
      box(`${id}_inner_front`, [Wd / 2 - ply, ply / 2, hd / 2], [0, -0.2 + ply / 2, 0], WOOD, 0.25),
    ], true, {
      // Each drawer opens and shuts in its turn: pulled out, left, pushed home.
      script: `const turn = ${i} * 2;
const phase = (api.getTime() + 8 - turn) % 8;
if (phase < 1.2) api.applyForce([0, -14, 0]);
else if (phase >= 4 && phase < 6) api.applyForce([0, 14, 0]);`,
    });
    // The face, overlaid on the cabinet's front edges, with a knob: a rigid
    // child, so the drawer's box alone is what the runners are sized to.
    drawer.children.push(body(`${id}_face`, [0, -0.2 - 0.001 - 0.009, (t + i * P + P / 2) - zc], [
      box(`${id}_face_panel`, [(W + 2 * t - 0.003) / 2, 0.009, (P - 0.006) / 2], [0, 0, 0], WOOD_FRONT, 0.6),
      { name: `${id}_knob`, type: 'cylinder', size: [0.012, 0.01], pos: [0, -0.019, 0], quat: [Math.SQRT1_2, Math.SQRT1_2, 0, 0], rgba: [0.75, 0.6, 0.3, 1], mass: 0.05 } as SceneGeom,
    ], false));
    scene.nodes.push(drawer);
    let k = 0;
    must(addDrawerRunners(scene, id, () => `${id}_runner_${k++}`), `runners for ${id}`);
  }
  return scene;
}

// ---------------------------------------------------------------------------
// XY plotter on linear rails
// ---------------------------------------------------------------------------

function xyPlotter(): SceneGraph {
  const base = body('base', [0, 0, 0.006], [
    box('base_plate', [0.26, 0.15, 0.006], [0, 0, 0], PLA_GREY, 0.9),
    // The sheet it draws on.
    box('base_paper', [0.13, 0.09, 0.0002], [0.072, 0.01, 0.0062], [0.97, 0.97, 0.95, 1], 0.01, { contype: 0, conaffinity: 0 }),
  ], false);
  const xSeat = cut(base, { kind: 'rail_seat', size: 'MGN15', lengthMm: 450, bore: 'insert', at: [0, -0.11, 0.006], normal: [0, 0, 1] }, 'x_seat');
  const xRail = seat(base, xSeat, { kind: 'mgn_rail', size: 'MGN15', lengthMm: 450 }, 'x_rail');

  // The cross slide: a printed plate on the X carriage, carrying the Y rail.
  // The X carriage's top is 16 mm over the rail's underside, which beds 1.5 mm down.
  const crossZ = 0.006 + (0.006 - 0.0015) + 0.016 + 0.005;
  // Its middle 120 mm along from the X carriage: the Y rail overhangs the base's back half.
  const cross = body('cross_slide', [0, -0.11 + 0.12, crossZ], [box('cross_plate', [0.035, 0.15, 0.005], [0, 0, 0], PLA_ORANGE, 0.15)], true);
  const ySeat = cut(cross, { kind: 'rail_seat', size: 'MGN12', lengthMm: 250, turned: true, bore: 'insert', at: [0, 0, 0.005], normal: [0, 0, 1] }, 'y_seat');
  const yRail = seat(cross, ySeat, { kind: 'mgn_rail', size: 'MGN12', lengthMm: 250 }, 'y_rail');

  // The pen head: on the Y carriage, the pen out past the cross slide's edge.
  const headZ = crossZ + 0.005 - 0.0015 + 0.013 + 0.004;
  const head = body('pen_head', [0, 0.01, headZ], [
    box('head_plate', [0.022, 0.02, 0.004], [0, 0, 0], PLA_TEAL, 0.03),
    box('head_arm', [0.03, 0.008, 0.004], [0.05, 0, 0], PLA_TEAL, 0.015),
    { name: 'head_pen', type: 'cylinder', size: [0.004, 0.022], pos: [0.072, 0, -0.022 + 0.004], rgba: [0.1, 0.2, 0.8, 1], mass: 0.008, contype: 0, conaffinity: 0 } as SceneGeom,
  ], true, {
    // A Lissajous figure, 3 across to 2 along, each axis held to it by a PD
    // loop on its carriage: the force a belt drive would give it.
    // The damping acts on how far off the pen's speed is, not on its speed, or
    // the pen would trail its figure by centimetres.
    script: `const w = 0.7, s = api.getTime() * w;
const tx = 0.11 * Math.sin(3 * s), tvx = 0.11 * 3 * w * Math.cos(3 * s);
const ty = 0.075 * Math.sin(2 * s + 0.6), tvy = 0.075 * 2 * w * Math.cos(2 * s + 0.6);
const x = api.getJointPosition('x_rail_travel'), vx = api.getJointVelocity('x_rail_travel');
const y = api.getJointPosition('y_rail_travel'), vy = api.getJointVelocity('y_rail_travel');
api.applyJointForce('x_rail_travel', 400 * (tx - x) + 30 * (tvx - vx));
api.applyJointForce('y_rail_travel', 200 * (ty - y) + 15 * (tvy - vy));`,
  });

  const scene = { nodes: [base, cross, head] } as SceneGraph;
  must(fixToPiece(scene, `${xRail.id}_carriage`, cross.id), 'cross slide on X');
  must(fixToPiece(scene, `${yRail.id}_carriage`, head.id), 'pen head on Y');
  return scene;
}

// ---------------------------------------------------------------------------
// Stepper turntable on a bearing
// ---------------------------------------------------------------------------

function stepperTurntable(): SceneGraph {
  const legs = [[-1, -1], [-1, 1], [1, -1], [1, 1]].map(([sx, sy], i) =>
    box(`stand_leg${i}`, [0.008, 0.008, 0.025], [sx * 0.07, sy * 0.07, 0.025], PLA_GREY, 0.02));
  const stand = body('stand', [0, 0, 0], [box('stand_deck', [0.08, 0.08, 0.006], [0, 0, 0.056], PLA_GREY, 0.12), ...legs], false);
  const pocket = cut(stand, { kind: 'bearing', size: '6001', at: [0, 0, 0.062], normal: [0, 0, 1] }, 'bearing_seat');
  const bearing = seat(stand, pocket, { kind: 'bearing', size: '6001' }, 'bearing');

  // The motor under the deck, its shaft up into the bore, coupled to the
  // bearing's inner race joint for joint: the coupler between them.
  const motor = hardwarePartNode({ kind: 'stepper', size: 'NEMA17 40' }, 'motor');
  motor.pos = [0, 0, 0.05];
  motor.joints = [];
  for (const g of motor.geoms) if (g.role !== 'visual') { g.contype = 0; g.conaffinity = 0; }
  const shaft = motor.children[0];
  shaft.coupleTargetId = `${bearing.id}_inner`;
  shaft.coupleRatio = 1;
  stand.children.push(motor);

  // Two millimetres clear of the deck: it rides on the bearing, not on the deck.
  const platter = body('platter', [0, 0, 0.062 + 0.002 + 0.003], [
    // PLA on PLA grips at about 0.4, not MuJoCo's default of 1.
    { name: 'platter_disc', type: 'cylinder', size: [0.11, 0.003], rgba: [...PLA_TEAL], mass: 0.28, friction: [0.4, 0.005, 0.0001] } as SceneGeom,
  ], true, {
    // Up to speed and back down: the stepper drives, the bearing carries it,
    // and what rides on it slides off as soon as its grip runs out.
    script: `const t = api.getTime() % 14;
const speed = t < 9 ? 1.8 * t : Math.max(0, 16 - 4 * (t - 9));
api.setActuatorControl('motor_spin_actuator', speed);`,
  });
  const riders = [
    body('cube_near', [0.05, 0, 0.0735 + 0.008], [box('cube_near_g', [0.008, 0.008, 0.008], [0, 0, 0], PLA_ORANGE, 0.008, { friction: [0.4, 0.005, 0.0001] })], true),
    body('cube_mid', [0, 0.075, 0.0735 + 0.008], [box('cube_mid_g', [0.008, 0.008, 0.008], [0, 0, 0], [0.9, 0.8, 0.1, 1], 0.008, { friction: [0.4, 0.005, 0.0001] })], true),
    body('cube_far', [-0.095, 0, 0.0735 + 0.008], [box('cube_far_g', [0.008, 0.008, 0.008], [0, 0, 0], [0.85, 0.2, 0.3, 1], 0.008, { friction: [0.4, 0.005, 0.0001] })], true),
  ];
  const scene = { nodes: [stand, platter, ...riders] } as SceneGraph;
  must(fixToPiece(scene, `${bearing.id}_inner`, platter.id), 'platter on the bearing');
  return scene;
}

// ---------------------------------------------------------------------------
// Spring launcher
// ---------------------------------------------------------------------------

function springLauncher(): SceneGraph {
  // Where the ball lands, contact is stiff: at the soft default a ball coming
  // back at nearly 4 m/s sinks tens of millimetres before it is stopped, and
  // goes straight through a cup floor a few millimetres thick.
  const HARD = { solref: [0.003, 1] };
  const base = body('base', [0, 0, 0.006], [box('base_plate', [0.05, 0.05, 0.006], [0, 0, 0], PLA_GREY, 0.2, HARD)], false);
  const spring = hardwarePartNode({ kind: 'spring', size: 'Ø16×50' }, 'spring');
  spring.pos = [0, 0, 0.006];
  spring.joints = [];
  base.children.push(spring);
  // The cup the ball sits in, fixed on the spring's top.
  const top = spring.children.find((c) => c.id === 'spring_carriage')!;
  top.children.push(body('cup', [0, 0, 0.005], [
    { name: 'cup_floor', type: 'cylinder', size: [0.02, 0.005], pos: [0, 0, 0], rgba: [...PLA_ORANGE], mass: 0.03, ...HARD } as SceneGeom,
    ...[0, 1, 2, 3, 4, 5].map((k) => box(`cup_lip${k}`, [0.004, 0.0015, 0.008], [0.019 * Math.cos((k * Math.PI) / 3), 0.019 * Math.sin((k * Math.PI) / 3), 0.008], PLA_ORANGE, 0.002, {
      quat: [Math.cos((k * Math.PI) / 6 + Math.PI / 4), 0, 0, Math.sin((k * Math.PI) / 6 + Math.PI / 4)], ...HARD,
    })),
  ], false));
  // In the cup: the base's top is 12 mm up, the spring 50 mm on that, the cup's floor 10 mm.
  const ball = body('ball', [0, 0, 0.012 + 0.05 + 0.01 + 0.0125 + 0.0005], [
    { name: 'ball_g', type: 'sphere', size: [0.0125], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, ...HARD } as SceneGeom,
  ], true, {
    // Cocked down 20 mm for two seconds, then let go: the spring's own rate
    // throws the ball, and it falls back into the cup to be thrown again.
    script: `const t = api.getTime() % 4;
if (t < 2) api.applyJointForce('spring_compress', -40);`,
  });
  return { nodes: [base, ball] } as SceneGraph;
}

// ---------------------------------------------------------------------------
// A jar that seals
// ---------------------------------------------------------------------------

function sealedJar(): SceneGraph {
  const jar = body('jar', [0, 0, 0], [
    { name: 'jar_wall', type: 'cylinder', size: [0.035, 0.04], pos: [0, 0, 0.04], rgba: [...PLA_TEAL] } as SceneGeom,
    { name: 'jar_cavity', type: 'cylinder', size: [0.03, 0.0375], pos: [0, 0, 0.0435], csg: 'difference', rgba: [0.9, 0.25, 0.35, 1] } as SceneGeom,
  ], false);
  const groove = cut(jar, { kind: 'oring', size: '', at: [0.0325, 0, 0.08], normal: [0, 0, 1] }, 'lid_seal');
  const ringSize = jar.geoms.find((g) => g.hardware?.group === groove)!.hardware!.size;
  seat(jar, groove, { kind: 'oring', size: ringSize }, 'jar_oring');
  const lid = body('lid', [0, 0, 0.08 + 0.003], [
    { name: 'lid_disc', type: 'cylinder', size: [0.035, 0.003], rgba: [...PLA_ORANGE], mass: 0.02 } as SceneGeom,
    { name: 'lid_knob', type: 'cylinder', size: [0.008, 0.005], pos: [0, 0, 0.008], rgba: [...PLA_ORANGE], mass: 0.004 } as SceneGeom,
  ], true);
  return { nodes: [jar, lid] } as SceneGraph;
}

// ---------------------------------------------------------------------------
// An extrusion frame with a carriage on it
// ---------------------------------------------------------------------------

/** A profile `lengthMm` long, its axis along `axis`, centred at `at` (m). */
function profile(id: string, size: string, lengthMm: number, axis: 'x' | 'y' | 'z', at: number[]): SceneNode {
  const node = hardwarePartNode({ kind: 'extrusion', size, lengthMm }, id);
  // Named for where it is, so twelve profiles are not twelve "2020 × 300 extrusion"s.
  node.name = `${id.replace(/_/g, ' ')} (${node.name})`;
  node.pos = at.map((v) => +v.toFixed(6));
  const q = axis === 'x' ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
    : axis === 'y' ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2)
      : new THREE.Quaternion();
  node.quat = [q.w, q.x, q.y, q.z].map((v) => +v.toFixed(9));
  return node;
}

/** As joinProfiles does it: the piece in the corner, a child of the side met, welding the other. */
function join(scene: SceneGraph, a: string, b: string, kind: JoinKind, id: string) {
  const m = meeting(scene, a, b);
  if ('problem' in m) throw new Error(`preset: ${a}/${b}: ${m.problem}`);
  const pose = joinPose(m, kind);
  if ('problem' in pose) throw new Error(`preset: ${a}/${b}: ${pose.problem}`);
  const part = hardwarePartNode({ kind, size: pose.size, ...(pose.lengthMm ? { lengthMm: pose.lengthMm } : {}), seat: 'frame', fastens: m.a.id }, id);
  part.pos = pose.pos;
  part.quat = pose.quat;
  part.joints = [];
  for (const g of part.geoms) if (g.role !== 'visual') { g.contype = 0; g.conaffinity = 0; }
  part.weldTargetId = m.a.id;
  part.weldRigid = true;
  m.b.children.push(part);
}

function extrusionFrame(): SceneGraph {
  const S = 0.3; // outside, m
  const h = 0.01; // half a 20 mm profile
  const L = 300;
  const inner = (S - 4 * h) * 1000; // between two sides
  const lift = 0.0005;
  const nodes: SceneNode[] = [
    // Bottom and top squares: two along X the full width, two along Y between them.
    profile('bottom_front', '2020', L, 'x', [0, -S / 2 + h, h + lift]),
    profile('bottom_back', '2020', L, 'x', [0, S / 2 - h, h + lift]),
    profile('bottom_left', '2020', inner, 'y', [-S / 2 + h, 0, h + lift]),
    profile('bottom_right', '2020', inner, 'y', [S / 2 - h, 0, h + lift]),
    // Four uprights standing on the bottom square's corners, one of them V-slot.
    profile('post_fl', '2020V', L - 40, 'z', [-S / 2 + h, -S / 2 + h, 2 * h + (L - 40) / 2000 + lift]),
    profile('post_fr', '2020', L - 40, 'z', [S / 2 - h, -S / 2 + h, 2 * h + (L - 40) / 2000 + lift]),
    profile('post_bl', '2020', L - 40, 'z', [-S / 2 + h, S / 2 - h, 2 * h + (L - 40) / 2000 + lift]),
    profile('post_br', '2020', L - 40, 'z', [S / 2 - h, S / 2 - h, 2 * h + (L - 40) / 2000 + lift]),
  ];
  const topZ = 2 * h + (L - 40) / 1000 + h + lift;
  nodes.push(
    profile('top_front', '2020', L, 'x', [0, -S / 2 + h, topZ]),
    profile('top_back', '2020', L, 'x', [0, S / 2 - h, topZ]),
    profile('top_left', '2020', inner, 'y', [-S / 2 + h, 0, topZ]),
    profile('top_right', '2020', inner, 'y', [S / 2 - h, 0, topZ]),
  );
  const scene = { nodes } as SceneGraph;
  let n = 0;
  const bracket = (a: string, b: string) => join(scene, a, b, 'corner_bracket', `bracket_${n++}`);
  for (const level of ['bottom', 'top']) {
    for (const side of ['left', 'right']) {
      bracket(`${level}_${side}`, `${level}_front`);
      bracket(`${level}_${side}`, `${level}_back`);
    }
  }
  for (const [post, x] of [['post_fl', 'front'], ['post_fr', 'front'], ['post_bl', 'back'], ['post_br', 'back']] as const) {
    bracket(post, `bottom_${x}`);
    bracket(post, `top_${x}`);
  }
  // A wheel carriage on the V-slot post, run up and down it.
  const post = nodes.find((p) => p.id === 'post_fl')!;
  const carriage = hardwarePartNode({ kind: 'vslot_carriage', size: '20', seat: 'rail' }, 'lift');
  carriage.joints = [{ name: 'lift_slide', type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0], limited: true, range: carriageRange(L - 40, 0), damping: 0.05, hardStop: true }];
  for (const g of carriage.geoms) if (g.role !== 'visual') { g.contype = 0; g.conaffinity = 0; }
  // Held to a slow rise and fall, its own weight carried, as a belt would.
  carriage.script = `const target = 0.09 * Math.sin(api.getTime() * 0.9);
const z = api.getJointPosition('lift_slide'), v = api.getJointVelocity('lift_slide');
api.applyJointForce('lift_slide', 400 * (target - z) - 25 * v + api.getMass() * 9.81);`;
  post.children.push(carriage);
  return scene;
}

// ---------------------------------------------------------------------------
// A cart on skate bearings, its deck screwed on
// ---------------------------------------------------------------------------

function bearingCart(): SceneGraph {
  // A ramp falling 10° toward +X, and the cart a quarter of the way down it.
  const a = (10 * Math.PI) / 180;
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
  const down = new THREE.Vector3(1, 0, 0).applyQuaternion(tilt);
  const up = new THREE.Vector3(0, 0, 1).applyQuaternion(tilt);
  const rampCentre = new THREE.Vector3(0, 0, 0.4 * Math.sin(a) + 0.01);
  const ramp = body('ramp', rampCentre.toArray(), [box('ramp_board', [0.42, 0.12, 0.01], [0, 0, 0], WOOD, 2)], false, {
    quat: [tilt.w, tilt.x, tilt.y, tilt.z],
  });
  const onRamp = rampCentre.clone().addScaledVector(down, -0.28).addScaledVector(up, 0.01);
  const q = [tilt.w, tilt.x, tilt.y, tilt.z];
  const at = (local: number[]) => onRamp.clone().addScaledVector(up, 0.025).add(new THREE.Vector3(...(local as [number, number, number])).applyQuaternion(tilt)).toArray().map((v) => +v.toFixed(6));

  // The chassis, with four tapping holes for the deck's screws, and the axles drawn.
  const axles = [-1, 1].map((sx) => ({
    name: `chassis_axle_${sx > 0 ? 'front' : 'back'}`, type: 'cylinder', size: [0.004, 0.049], pos: [sx * 0.06, 0, 0],
    quat: [Math.SQRT1_2, -Math.SQRT1_2, 0, 0], rgba: [0.74, 0.76, 0.79, 1], contype: 0, conaffinity: 0, mass: 0.01,
  } as SceneGeom));
  const chassis = body('chassis', at([0, 0, 0]), [box('chassis_plate', [0.08, 0.035, 0.006], [0, 0, 0], PLA_GREY, 0.3), ...axles], true, { quat: q });
  chassis.csgEnabled = true;
  chassis.csgCollision = 'auto';
  const corners = [[-0.05, -0.02], [-0.05, 0.02], [0.05, -0.02], [0.05, 0.02]];
  corners.forEach(([x, y], i) => {
    const hole = { name: `chassis_tap${i}`, type: 'cylinder', size: [0.00125, 0], csg: 'difference', cutAt: [x, y, 0.006], cutNormal: [0, 0, 1], cutDepth: 0.008, rgba: [0.9, 0.25, 0.35, 1] } as SceneGeom;
    chassis.geoms.push(hole);
    Object.assign(hole, cutGeometry(chassis, hole));
  });

  // The deck, counterbored for M3 cap screws over the chassis's holes.
  const deck = body('deck', at([0, 0, 0.006 + 0.005]), [box('deck_plate', [0.075, 0.032, 0.005], [0, 0, 0], PLA_ORANGE, 0.08)], true, { quat: q });
  const scene = { nodes: [ramp, chassis, deck] } as SceneGraph;
  corners.forEach(([x, y], i) => {
    const group = cut(deck, { kind: 'counterbore', size: 'M3', at: [x, y, 0.005], normal: [0, 0, 1] }, `screw${i}`);
    const screw = seat(deck, group, { kind: 'screw', size: 'M3' }, `deck_bolt${i}`);
    const fit = screwFit(scene, deck, screw, seatFor(deck, group, 'screw')!.gripM!);
    rebuildPart(screw, { ...screw.hardwarePart!, lengthMm: fit.lengthMm });
    if (!fit.target || !fasten(screw, deck, fit.target)) throw new Error('preset: a deck screw reaches nothing');
  });

  // Four wheels, each on a 608 pressed into its inner face, the inner race fixed to the chassis.
  for (const [sx, sy] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
    const id = `wheel_${sx > 0 ? 'front' : 'back'}_${sy > 0 ? 'left' : 'right'}`;
    const wheel = body(id, at([sx * 0.06, sy * 0.049, 0]), [
      { name: `${id}_tyre`, type: 'cylinder', size: [0.025, 0.01], quat: [Math.SQRT1_2, -Math.SQRT1_2, 0, 0], rgba: [0.12, 0.12, 0.13, 1], mass: 0.04 } as SceneGeom,
    ], true, { quat: q });
    const group = cut(wheel, { kind: 'bearing', size: '608', at: [0, -sy * 0.01, 0], normal: [0, -sy, 0] }, 'bearing_seat');
    const bearing = seat(wheel, group, { kind: 'bearing', size: '608' }, `${id}_bearing`);
    const inner = bearing.children[0];
    inner.weldTargetId = chassis.id;
    inner.weldRigid = true;
    scene.nodes.push(wheel);
  }
  return scene;
}

// ---------------------------------------------------------------------------

export const bearingCartPreset = bearingCart();
export const chestOfDrawersPreset = chestOfDrawers();
export const xyPlotterPreset = xyPlotter();
export const stepperTurntablePreset = stepperTurntable();
export const springLauncherPreset = springLauncher();
export const sealedJarPreset = sealedJar();
export const extrusionFramePreset = extrusionFrame();
