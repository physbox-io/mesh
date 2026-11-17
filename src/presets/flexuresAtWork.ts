import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { applyFlexureToNode } from '../utils/flexure';

/**
 * Flexures at Work: the four compliant joints doing real jobs on one bench.
 *   1. Cross-strip pivot  → a letter scale: a frictionless pivot whose spring
 *      rate *is* the calibration. A lead-screw feeder pushes 10 g weights into the pan
 *      one by one; the needle steps across a dial marked from the flexure's
 *      own stiffness.
 *   2. Blade hinge        → a non-return flap in a ball chute: balls push it
 *      open and pass, it springs shut, and a ball rolling back is stopped.
 *   3. Serpentine slide   → a keyswitch on an endurance rig: a motor-driven
 *      eccentric cam presses the key, the folded springs return it, the
 *      script counts strokes.
 *   4. Bistable slide     → a drop/shock indicator on a drop tester: drops
 *      below its threshold leave it alone; one hard landing snaps it over and
 *      it stays tripped (red flag) until the reset pin pushes it back.
 */

type V3 = [number, number, number];
type RGBA = [number, number, number, number];

const FRAME: RGBA = [0.27, 0.3, 0.36, 1];
const DARK: RGBA = [0.12, 0.13, 0.16, 1];
const DIAL: RGBA = [0.93, 0.92, 0.86, 1];
const BRASS: RGBA = [0.86, 0.68, 0.3, 1];
const STEEL: RGBA = [0.74, 0.76, 0.8, 1];
const PETG_BLUE: RGBA = [0.22, 0.58, 0.86, 1];
const PETG_ORANGE: RGBA = [0.92, 0.52, 0.18, 1];
const RED: RGBA = [0.86, 0.16, 0.14, 1];
const GREEN: RGBA = [0.2, 0.7, 0.35, 1];
const BASE_TOP = 0.012;

/** A static frame part: drawn and, unless `solid` is false, collided. */
function part(name: string, size: number[], pos: V3, rgba: RGBA = FRAME, extra: Partial<SceneGeom> = {}): SceneGeom {
  return { name, type: 'box', size, pos, rgba, ...extra };
}
const ghost = { contype: 0, conaffinity: 0 } as const;

/** A box laid as a floor from (y0,z0) to (y1,z1) at x, top surface on that line. */
function floor(name: string, x: number, halfW: number, ya: number, za: number, yb: number, zb: number, halfT = 0.0015): SceneGeom {
  // Laid toward +y whichever way it was given, so the normal below points up.
  const [y0, z0, y1, z1] = ya <= yb ? [ya, za, yb, zb] : [yb, zb, ya, za];
  const dy = y1 - y0, dz = z1 - z0;
  const len = Math.hypot(dy, dz);
  const a = Math.atan2(dz, dy);
  // Top face on the line: centre sits half a thickness below it, along the normal.
  const ny = -Math.sin(a), nz = Math.cos(a);
  return part(name, [halfW, len / 2 + 0.0008, halfT], [x, (y0 + y1) / 2 - ny * halfT, (z0 + z1) / 2 - nz * halfT], FRAME, {
    euler: [(a * 180) / Math.PI, 0, 0],
  });
}

const freeBody = (id: string, name: string, pos: V3, geom: SceneGeom): SceneNode => ({
  id, name, type: 'body', pos, joints: [{ name: `${id}_free`, type: 'free' }], geoms: [geom], children: [],
});

// ---------------------------------------------------------------------------
// 1. Letter scale on a cross-strip pivot
// ---------------------------------------------------------------------------
const SX = -0.16;
const PIVOT: V3 = [SX, 0, 0.1];
const ARM = 0.05; // beam tip (stirrup pivot), body frame
const BEAM_Z = -0.0115;
const WEIGHT_HALF = 0.0053; // 10.6 mm brass cube: 10 g
const WEIGHT_MASS = 0.01;
const NEEDLE_LEN = 0.07;
// Stirrup pivot down to the pan's top face: long enough that the beam's tip, dipping
// as the scale loads, stays clear of weights coming off the shelf at the full 30 g.
const HANG = 0.048;
const TRAY_HALF = 0.017; // square tray, inside
const TRAY_DEPTH = 0.014; // deep enough to hold three weights however they pile

const scaleMasses = { hub: 0.001, beam: 0.003, needle: 0.0005, hanger: 0.006 };
// Counterweight balances the empty beam and pan about the pivot: the needle reads 0 unloaded.
const CW_X = -0.045;
const cwMass = (scaleMasses.beam * 0.0025 + scaleMasses.hanger * ARM) / -CW_X;

// The pan hangs from a stirrup pivot at the beam tip, so whatever it carries acts
// at that one point: a weight reads the same wherever in the tray it lands.
const trayWalls: SceneGeom[] = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dy], i) => ({
  name: `tray_wall_${i}`, type: 'box' as const,
  size: dx ? [0.0008, TRAY_HALF + 0.0016, TRAY_DEPTH / 2] : [TRAY_HALF + 0.0016, 0.0008, TRAY_DEPTH / 2],
  pos: [dx * (TRAY_HALF + 0.0008), dy * (TRAY_HALF + 0.0008), -HANG + TRAY_DEPTH / 2], mass: 0.0005, rgba: STEEL,
}));
const panHanger: SceneNode = {
  id: 'scale_pan',
  name: 'Scale Pan',
  type: 'body',
  pos: [ARM, 0, BEAM_Z],
  joints: [{ name: 'pan_stirrup', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.001 }],
  geoms: [
    { name: 'stirrup_bar', type: 'box', size: [0.023, 0.002, 0.0015], pos: [0, 0, -0.0035], mass: 0.0006, rgba: DARK },
    { name: 'stirrup_rod_a', type: 'box', size: [0.001, 0.0015, (HANG - 0.005) / 2], pos: [0.0215, 0, -0.005 - (HANG - 0.005) / 2], mass: 0.0003, rgba: DARK },
    { name: 'stirrup_rod_b', type: 'box', size: [0.001, 0.0015, (HANG - 0.005) / 2], pos: [-0.0215, 0, -0.005 - (HANG - 0.005) / 2], mass: 0.0003, rgba: DARK },
    { name: 'tray_floor', type: 'box', size: [TRAY_HALF + 0.0016, TRAY_HALF + 0.0016, 0.0015], pos: [0, 0, -HANG - 0.0015], mass: scaleMasses.hanger - 0.0012 - 0.002, rgba: STEEL },
    ...trayWalls,
  ],
  children: [],
};

const rawBeam: SceneNode = {
  id: 'scale_beam',
  name: 'Scale Beam',
  type: 'body',
  pos: PIVOT,
  joints: [{ name: 'scale_pivot', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0] }],
  geoms: [
    { name: 'beam_hub', type: 'box', size: [0.0075, 0.006, 0.0025], pos: [0, 0, -0.0065], mass: scaleMasses.hub, rgba: PETG_BLUE },
    { name: 'beam_bar', type: 'box', size: [0.0525, 0.003, 0.0025], pos: [0.0025, 0, BEAM_Z], mass: scaleMasses.beam, rgba: PETG_BLUE },
    { name: 'beam_counterweight', type: 'box', size: [0.006, 0.006, 0.006], pos: [CW_X, 0, BEAM_Z], mass: cwMass, rgba: BRASS },
    { name: 'beam_needle', type: 'box', size: [0.0007, 0.0007, NEEDLE_LEN / 2], pos: [0, -0.009, -0.006 - NEEDLE_LEN / 2], mass: scaleMasses.needle, rgba: RED },
  ],
  children: [panHanger],
};
const scaleFlex = applyFlexureToNode(rawBeam, {
  kind: 'cross_pivot', filament: 'petg', thicknessMm: 0.65, lengthMm: 16, widthMm: 12,
})!;
const scaleBeam = scaleFlex.node;
// A real balance damps its beam with a vane (an eddy-current damper here), or it
// would ring for a minute after every weight.
scaleBeam.joints[0].damping = 0.004;

/** Beam angle (rad) at rest carrying `grams` in the pan: flexure torque = gravity torque. */
function scaleAngle(grams: number): number {
  const k = scaleBeam.flexure!.stiffness;
  const pts: [number, number, number][] = [
    [scaleMasses.hub, 0, -0.0065], [scaleMasses.beam, 0.0025, BEAM_Z], [cwMass, CW_X, BEAM_Z],
    [scaleMasses.needle, 0, -0.006 - NEEDLE_LEN / 2],
    // The pan and its load hang from the stirrup: their weight acts at its pivot.
    [scaleMasses.hanger + grams / 1000, ARM, BEAM_Z],
  ];
  let th = 0;
  for (let it = 0; it < 60; it++) {
    // Torque about +y from gravity on a body-frame point (x, z) turned by th: m·g·x_world.
    let tau = 0, dtau = 0;
    for (const [m, x, z] of pts) {
      tau += m * 9.81 * (x * Math.cos(th) + z * Math.sin(th));
      dtau += m * 9.81 * (-x * Math.sin(th) + z * Math.cos(th));
    }
    th -= (k * th - tau) / (k - dtau);
  }
  return th;
}

// Dial ticks every 5 g, long ones every 10 g, where the needle tip rests.
const dialTicks: SceneGeom[] = [];
for (let g = 0; g <= 30; g += 5) {
  const th = scaleAngle(g);
  const major = g % 10 === 0;
  const r = NEEDLE_LEN + 0.006 - (major ? 0.004 : 0.0025);
  dialTicks.push(part(`dial_tick_${g}g`, [0.0005, 0.0006, major ? 0.004 : 0.0025],
    [PIVOT[0] - Math.sin(th) * r, -0.0055, PIVOT[2] - Math.cos(th) * r], DARK, { ...ghost, euler: [0, (th * 180) / Math.PI, 0] }));
}

// Weight feeder: weights in a lane on a shelf, pushed off its edge into the tray.
const SHELF_X = SX + ARM;
const SHELF_EDGE_Y = 0.01;
// The thin shelf clears the tray's walls by ~1 mm.
const SHELF_TOP = PIVOT[2] + BEAM_Z - HANG + TRAY_DEPTH + 0.0025;
const SHELF_END_Y = 0.086;
const LANE_END_Y = 0.074;
// Lead-screw linear actuator beside the lane: rail, carriage, motor at the far end.
const WEIGHT_FEED_RAIL_X = SHELF_X + 0.0185;
const WEIGHT_FEED_RAIL_Y0 = 0.004;
const WEIGHT_FEED_MOTOR_Y0 = 0.0705;
const WEIGHT_PITCH = 2 * WEIGHT_HALF + 0.001;
const LANE_HALF = WEIGHT_HALF + 0.0012; // lane walls keep the cubes square to the pusher
const weightYs = [0, 1, 2].map((i) => SHELF_EDGE_Y + WEIGHT_HALF + 0.001 + i * WEIGHT_PITCH);
const weights = weightYs.map((y, i) => freeBody(`weight_${i + 1}`, `10 g Weight ${i + 1}`, [SHELF_X, y, SHELF_TOP + WEIGHT_HALF + 0.0002], {
  name: `weight_${i + 1}_cube`, type: 'box', size: [WEIGHT_HALF, WEIGHT_HALF, WEIGHT_HALF], mass: WEIGHT_MASS, rgba: BRASS,
}));
const weightPusher: SceneNode = {
  id: 'weight_pusher',
  name: 'Weight Feeder',
  type: 'body',
  pos: [SHELF_X, weightYs[2] + WEIGHT_HALF + 0.0016, SHELF_TOP + 0.0045],
  joints: [{ name: 'weight_feed_slide', type: 'slide', axis: [0, -1, 0], pos: [0, 0, 0], limited: true, range: [0, 0.06], damping: 0.5 }],
  geoms: [
    { name: 'pusher_blade', type: 'box', size: [WEIGHT_HALF, 0.0015, 0.0035], mass: 0.01, rgba: DARK },
    // Arm over the lane wall to the actuator's carriage on the rail.
    { name: 'pusher_arm', type: 'box', size: [0.0095, 0.002, 0.0012], pos: [0.00925, 0, 0.0045], mass: 0.005, rgba: DARK, ...ghost },
    { name: 'pusher_carriage', type: 'box', size: [0.004, 0.004, 0.0036], pos: [WEIGHT_FEED_RAIL_X - SHELF_X, 0, 0.0021], mass: 0.025, rgba: [0.55, 0.58, 0.62, 1], ...ghost },
  ],
  children: [],
};

const scaleFrame: SceneGeom[] = [
  part('scale_tower', [0.012, 0.012, (PIVOT[2] + 0.0107 - BASE_TOP) / 2], [SX, 0.022, (PIVOT[2] + 0.0107 + BASE_TOP) / 2], FRAME, ghost),
  part('scale_bracket', [0.0085, 0.012, 0.0025], [SX, 0.002, PIVOT[2] + 0.0082], FRAME, ghost),
  // Dial face standing on the bench behind the needle.
  part('scale_dial', [0.026, 0.0008, (0.05 - BASE_TOP) / 2], [SX - 0.012, -0.0045, (0.05 + BASE_TOP) / 2], DIAL, ghost),
  ...dialTicks,
  // Shelf plate, lane and the feed actuator, on one post.
  part('weight_shelf', [0.01775, (SHELF_END_Y - SHELF_EDGE_Y) / 2, 0.0006], [SHELF_X + 0.00675, (SHELF_END_Y + SHELF_EDGE_Y) / 2, SHELF_TOP - 0.0006]),
  part('weight_rail_deck', [0.006, (SHELF_EDGE_Y - WEIGHT_FEED_RAIL_Y0) / 2 + 0.0005, 0.0006], [WEIGHT_FEED_RAIL_X, (SHELF_EDGE_Y + WEIGHT_FEED_RAIL_Y0) / 2, SHELF_TOP - 0.0006]),
  part('weight_lane_l', [0.0012, (LANE_END_Y - SHELF_EDGE_Y - 0.012) / 2, 0.003], [SHELF_X - LANE_HALF - 0.0012, (LANE_END_Y + SHELF_EDGE_Y + 0.012) / 2, SHELF_TOP + 0.003]),
  part('weight_lane_r', [0.0012, (LANE_END_Y - SHELF_EDGE_Y - 0.012) / 2, 0.003], [SHELF_X + LANE_HALF + 0.0012, (LANE_END_Y + SHELF_EDGE_Y + 0.012) / 2, SHELF_TOP + 0.003]),
  part('weight_rail', [0.0025, (WEIGHT_FEED_MOTOR_Y0 - WEIGHT_FEED_RAIL_Y0) / 2, 0.0015], [WEIGHT_FEED_RAIL_X, (WEIGHT_FEED_MOTOR_Y0 + WEIGHT_FEED_RAIL_Y0) / 2, SHELF_TOP + 0.0015], STEEL, ghost),
  part('weight_feed_motor', [0.0055, 0.007, 0.006], [WEIGHT_FEED_RAIL_X, WEIGHT_FEED_MOTOR_Y0 + 0.007, SHELF_TOP + 0.006], DARK, ghost),
  part('weight_shelf_post', [0.008, 0.004, (SHELF_TOP - 0.0012 - BASE_TOP) / 2], [SHELF_X + 0.004, SHELF_END_Y - 0.005, (SHELF_TOP - 0.0012 + BASE_TOP) / 2], FRAME, ghost),
];

// ---------------------------------------------------------------------------
// 2. Non-return flap on a blade hinge
// ---------------------------------------------------------------------------
const CX = -0.045;
const BALL_R = 0.008;
const LANE_TOP = 0.066;
const CH_HALF = 0.0095; // channel half width
// Floor profile along y: lane (flat) → drop → run → return ramp.
const P_LANE_END: [number, number] = [0.036, LANE_TOP];
const P_DROP_END: [number, number] = [0.006, 0.05];
const P_VALLEY: [number, number] = [-0.062, 0.038];
const P_RAMP_END: [number, number] = [-0.086, 0.06];
const FLAP_Y = -0.002;
const floorZ = (y: number) => {
  const [y0, z0] = P_DROP_END, [y1, z1] = P_VALLEY;
  return z0 + ((y - y0) / (y1 - y0)) * (z1 - z0);
};
const FLAP_LEN = 0.021;
const HINGE_Z = floorZ(FLAP_Y) + FLAP_LEN + 0.0012;

const rawFlap: SceneNode = {
  id: 'check_flap',
  name: 'Non-Return Flap',
  type: 'body',
  pos: [CX, FLAP_Y, HINGE_Z],
  joints: [{ name: 'flap_hinge', type: 'hinge', axis: [1, 0, 0], pos: [0, 0, 0] }],
  geoms: [
    // Printed PETG on steel slides easily: the flap must not pin a ball as it rolls under.
    { name: 'flap_plate', type: 'box', size: [0.0078, 0.0012, FLAP_LEN / 2], pos: [0, 0, -FLAP_LEN / 2], friction: [0.15, 0.005, 0.0001], rgba: PETG_ORANGE },
  ],
  children: [],
};
const flapFlex = applyFlexureToNode(rawFlap, {
  kind: 'blade', filament: 'tpu', thicknessMm: 0.6, lengthMm: 14, widthMm: 6,
})!;
const checkFlap = flapFlex.node;
{
  // The flap opens downstream (−y, negative angle) only: the stop bar upstream of it
  // holds it shut. The joint's own limit sits past the bar, as a backstop.
  const j = checkFlap.joints[0];
  j.range = [j.range![0], 15];
}
const balls = [0.044, 0.044 + 2 * BALL_R + 0.0004, 0.044 + 4 * BALL_R + 0.0008].map((y, i) =>
  freeBody(`ball_${i + 1}`, `Steel Ball ${i + 1}`, [CX, y, LANE_TOP + BALL_R + 0.0003], {
    name: `ball_${i + 1}_sphere`, type: 'sphere', size: [BALL_R], density: 7850, rgba: STEEL,
  }));
const WALL_TOP = 0.076;
const WALL_X = CH_HALF + 0.0012; // chute wall centre, from the chute's axis
// Motor at the downstream end of the rail, so the carriage starts on the rail.
const BALL_MOTOR_Y0 = 0.0145;
const BALL_RAIL_Y0 = 0.0285;
const BALL_RAIL_Y1 = 0.0875;
const ballPusher: SceneNode = {
  id: 'ball_pusher',
  name: 'Ball Pusher',
  type: 'body',
  pos: [CX, 0.044 + 4 * BALL_R + 0.0008 + BALL_R + 0.0018, LANE_TOP + 0.00725],
  joints: [{ name: 'ball_pusher_slide', type: 'slide', axis: [0, -1, 0], pos: [0, 0, 0], limited: true, range: [0, 0.06], damping: 0.5 }],
  geoms: [
    { name: 'ball_pusher_blade', type: 'box', size: [0.0075, 0.0015, 0.00625], mass: 0.01, rgba: DARK },
    // Arm over the chute wall to the actuator's carriage, which runs on a rail on the wall's top.
    { name: 'ball_pusher_arm', type: 'box', size: [WALL_X / 2 + 0.002, 0.002, 0.0012], pos: [WALL_X / 2, 0, 0.0074], mass: 0.005, rgba: DARK, ...ghost },
    { name: 'ball_pusher_carriage', type: 'box', size: [0.004, 0.004, 0.0035], pos: [WALL_X, 0, 0.0825 - (LANE_TOP + 0.00725)], mass: 0.025, rgba: [0.55, 0.58, 0.62, 1], ...ghost },
  ],
  children: [],
};
const chuteLen = 0.088 - P_RAMP_END[0];
const chuteMid = (0.088 + P_RAMP_END[0]) / 2;
// Top of the blade's upper pad, where the crossbar holds it.
const flapTop = Math.max(...checkFlap.geoms.filter((g) => g.bend).map((g) => Math.max(g.bend!.from[2], g.bend!.to[2]))) + HINGE_Z;
const flapFrame: SceneGeom[] = [
  part('lane_floor', [CH_HALF + 0.0012, (0.088 - P_LANE_END[0]) / 2, 0.0015], [CX, (0.088 + P_LANE_END[0]) / 2, LANE_TOP - 0.0015]),
  floor('chute_drop', CX, CH_HALF + 0.0012, ...P_LANE_END, ...P_DROP_END),
  floor('chute_run', CX, CH_HALF + 0.0012, ...P_DROP_END, ...P_VALLEY),
  floor('chute_return', CX, CH_HALF + 0.0012, ...P_VALLEY, ...P_RAMP_END),
  part('chute_wall_l', [0.0012, chuteLen / 2, 0.016], [CX - WALL_X, chuteMid, WALL_TOP - 0.016], [0.7, 0.85, 0.95, 0.35]),
  part('chute_wall_r', [0.0012, chuteLen / 2, 0.016], [CX + WALL_X, chuteMid, WALL_TOP - 0.016], [0.7, 0.85, 0.95, 0.35]),
  part('chute_leg_a', [0.008, 0.004, (LANE_TOP - BASE_TOP) / 2], [CX, 0.08, (LANE_TOP + BASE_TOP) / 2], FRAME, ghost),
  part('chute_leg_b', [0.008, 0.004, (P_VALLEY[1] - BASE_TOP) / 2 - 0.002], [CX, P_VALLEY[0], (P_VALLEY[1] + BASE_TOP) / 2 - 0.002], FRAME, ghost),
  // Crossbar the blade hangs from, on posts standing on the chute walls.
  part('flap_crossbar', [CH_HALF + 0.0024, 0.004, 0.0025], [CX, FLAP_Y, flapTop + 0.0025], FRAME, ghost),
  part('flap_post_l', [0.0012, 0.004, (flapTop - WALL_TOP) / 2 + 0.0002], [CX - WALL_X, FLAP_Y, (flapTop + WALL_TOP) / 2], FRAME, ghost),
  part('flap_post_r', [0.0012, 0.004, (flapTop - WALL_TOP) / 2 + 0.0002], [CX + WALL_X, FLAP_Y, (flapTop + WALL_TOP) / 2], FRAME, ghost),
  part('ball_rail', [0.003, (BALL_RAIL_Y1 - BALL_RAIL_Y0) / 2, 0.0015], [CX + WALL_X, (BALL_RAIL_Y1 + BALL_RAIL_Y0) / 2, WALL_TOP + 0.0015], STEEL, ghost),
  part('ball_feed_motor', [0.0055, 0.007, 0.006], [CX + WALL_X, (BALL_MOTOR_Y0 + BALL_RAIL_Y0) / 2, WALL_TOP + 0.006], DARK, ghost),
  // The stop bar the flap closes against: a ball rolling back cannot open it.
  part('flap_stop', [CH_HALF, 0.0012, 0.0015], [CX, FLAP_Y + 0.0024, HINGE_Z - 0.003], DARK, { solref: [0.002, 1] }), // touching the flap, above the balls' tops
];

// ---------------------------------------------------------------------------
// 3. Keyswitch on serpentine springs, on a cam-driven endurance rig
// ---------------------------------------------------------------------------
const KX = 0.055;
const KEY_Z = 0.042;
const rawKey: SceneNode = {
  id: 'keycap',
  name: 'Keycap',
  type: 'body',
  pos: [KX, 0, KEY_Z],
  joints: [{ name: 'key_slide', type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0] }],
  geoms: [{ name: 'keycap_body', type: 'box', size: [0.009, 0.009, 0.004], rgba: [0.94, 0.94, 0.92, 1] }],
  children: [],
};
const keyFlex = applyFlexureToNode(rawKey, {
  kind: 'serpentine', filament: 'petg', thicknessMm: 0.45, lengthMm: 18, widthMm: 6, folds: 3,
})!;
const keycap = keyFlex.node;
// Where the folded springs' anchor pads land: last leg, outer end, both sides.
const keyAnchors = keycap.geoms.filter((g) => g.name.startsWith('flexure_anchor_')).map((g) => g.pos!);
const CAM_R = 0.008;
const CAM_E = 0.003;
const SHAFT_Z = KEY_Z + 0.004 + 0.0005 + (CAM_R - CAM_E);
const cam: SceneNode = {
  id: 'key_cam',
  name: 'Eccentric Cam',
  type: 'body',
  pos: [KX, 0, SHAFT_Z],
  joints: [{ name: 'cam_shaft', type: 'hinge', axis: [1, 0, 0], pos: [0, 0, 0], damping: 0.0005, actuator: { type: 'velocity', kv: 0.05, ctrlValue: 4 } }],
  geoms: [
    // Eccentric points up at rest, so the key starts clear of it.
    { name: 'cam_disc', type: 'cylinder', size: [CAM_R, 0.004], pos: [0, 0, CAM_E], euler: [0, 90, 0], rgba: STEEL },
    { name: 'cam_shaft_rod', type: 'cylinder', size: [0.0015, 0.022], pos: [0, 0, 0], euler: [0, 90, 0], rgba: DARK, contype: 0, conaffinity: 0 },
  ],
  children: [],
};
const keyFrame: SceneGeom[] = [
  ...keyAnchors.map((p, i) => part(`key_anchor_post_${i}`, [0.004, 0.003, (KEY_Z + p[2] + 0.004 - BASE_TOP) / 2],
    [KX + p[0], p[1] + Math.sign(p[1]) * 0.0042, (KEY_Z + p[2] + 0.004 + BASE_TOP) / 2], FRAME, ghost)),
  part('cam_motor', [0.008, 0.009, 0.009], [KX + 0.026, 0, SHAFT_Z], DARK, ghost),
  part('cam_motor_mount', [0.006, 0.006, (SHAFT_Z - 0.009 - BASE_TOP) / 2 + 0.0002], [KX + 0.026, 0, (SHAFT_Z - 0.009 + BASE_TOP) / 2], FRAME, ghost),
  part('cam_bearing', [0.002, 0.005, (SHAFT_Z - BASE_TOP) / 2 + 0.004], [KX - 0.018, 0, (SHAFT_Z + BASE_TOP) / 2 + 0.002], FRAME, ghost),
];

// ---------------------------------------------------------------------------
// 4. Shock indicator (bistable) on a drop tester
// ---------------------------------------------------------------------------
const DX = 0.17;
const CARRIAGE_Z = 0.042;
const CARR_HALF: V3 = [0.03, 0.008, 0.014];
const BUMPER_TOP = CARRIAGE_Z - CARR_HALF[2];
const SH_Y = -CARR_HALF[1] - 0.0035; // indicator in front of the carriage face
const rawIndicator: SceneNode = {
  id: 'shock_indicator',
  name: 'Shock Indicator',
  type: 'body',
  pos: [0, SH_Y, 0],
  // Turned 90° about z so its arches span x along the carriage face.
  quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2],
  // Trips downward: a hard landing carries the proof mass on past the arches' hill.
  joints: [{ name: 'indicator_slide', type: 'slide', axis: [0, 0, -1], pos: [0, 0, 0] }],
  geoms: [
    // Local x is world y here; local y is world −x.
    { name: 'proof_mass', type: 'box', size: [0.003, 0.0055, 0.0075], density: 8500, rgba: GREEN },
    { name: 'tripped_flag', type: 'box', size: [0.0031, 0.005, 0.0025], pos: [0, 0, 0.01], mass: 0.0002, rgba: RED },
  ],
  children: [],
};
const indicatorFlex = applyFlexureToNode(rawIndicator, {
  kind: 'bistable', filament: 'petg', thicknessMm: 0.45, lengthMm: 20, widthMm: 2, archRiseMm: 2.5,
})!;
const indicator = indicatorFlex.node;
// The housing stops the proof mass at both ends of its travel.
indicator.joints[0].hardStop = true;
const archReach = 0.0055 + 0.02; // proof mass half-width + leaf span
// Rails stand behind the carriage; the carriage and the lift fork run on them in linear bearings.
const RAIL_Y = CARR_HALF[1] + 0.0035;
const RAIL_X = CARR_HALF[0] + 0.003;
const CARR_RGBA: RGBA = [0.35, 0.4, 0.5, 1];
const carriage: SceneNode = {
  id: 'drop_carriage',
  name: 'Drop Carriage',
  type: 'body',
  pos: [DX, 0, CARRIAGE_Z],
  joints: [{ name: 'drop_rail', type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0], limited: true, range: [-0.008, 0.08], damping: 0.02 }],
  geoms: [
    { name: 'carriage_housing', type: 'box', size: CARR_HALF, rgba: CARR_RGBA },
    { name: 'carriage_bearing_l', type: 'box', size: [0.0045, 0.0045, 0.008], pos: [-RAIL_X, RAIL_Y, 0], rgba: STEEL, ...ghost },
    { name: 'carriage_bearing_r', type: 'box', size: [0.0045, 0.0045, 0.008], pos: [RAIL_X, RAIL_Y, 0], rgba: STEEL, ...ghost },
    { name: 'carriage_ear_l', type: 'box', size: [0.0016, 0.003, 0.0045], pos: [-archReach - 0.0012, SH_Y, -0.0015], rgba: CARR_RGBA },
    { name: 'carriage_ear_r', type: 'box', size: [0.0016, 0.003, 0.0045], pos: [archReach + 0.0012, SH_Y, -0.0015], rgba: CARR_RGBA },
    // Flag housing on the carriage face: encloses the red flag until the proof mass drops out of it.
    { name: 'flag_housing', type: 'box', size: [0.0085, (SH_Y + CARR_HALF[1]) / -2 + 0.0045 / 2 + 0.0001, 0.0031], pos: [0, (SH_Y - 0.0045 - CARR_HALF[1]) / 2, 0.0106], rgba: CARR_RGBA, ...ghost },
  ],
  children: [indicator],
};
// Lift fork: rides the rails on a lead screw. It lifts the carriage by lugs under
// its ends (clear of the bumper), then drives down faster than gravity, so the
// carriage falls free onto the bumper.
const FORK_Z = BUMPER_TOP - 0.007 - 0.003; // lug tops 7 mm under the resting carriage
const FORK_REACH = 0.007; // fork travel before its lugs meet the carriage
const liftFork: SceneNode = {
  id: 'lift_fork',
  name: 'Lift Fork',
  type: 'body',
  pos: [DX, RAIL_Y, FORK_Z],
  joints: [{ name: 'fork_screw', type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0], limited: true, range: [-0.001, 0.07], hardStop: true, damping: 0.05 }],
  geoms: [
    { name: 'fork_yoke', type: 'box', size: [RAIL_X + 0.0045, 0.0025, 0.003], mass: 0.015, rgba: DARK, ...ghost },
    { name: 'fork_nut', type: 'box', size: [0.004, 0.0028, 0.004], mass: 0.005, rgba: STEEL, ...ghost },
    { name: 'fork_lug_l', type: 'box', size: [0.0035, (RAIL_Y + 0.006) / 2, 0.003], pos: [-0.0255, -(RAIL_Y + 0.006) / 2 + 0.0025, 0], mass: 0.005, rgba: DARK },
    { name: 'fork_lug_r', type: 'box', size: [0.0035, (RAIL_Y + 0.006) / 2, 0.003], pos: [0.0255, -(RAIL_Y + 0.006) / 2 + 0.0025, 0], mass: 0.005, rgba: DARK },
  ],
  children: [],
};
// Reset plunger: stands under the proof mass; pushes it back over the arches' hill.
const PLUNGER_Z = BASE_TOP + 0.0065 + 0.003;
const resetPlunger: SceneNode = {
  id: 'reset_plunger',
  name: 'Reset Plunger',
  type: 'body',
  pos: [DX, SH_Y, PLUNGER_Z],
  joints: [{ name: 'reset_slide', type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0], limited: true, range: [0, 0.012], hardStop: true, damping: 0.05 }],
  geoms: [{ name: 'plunger_pin', type: 'box', size: [0.0025, 0.0025, 0.003], mass: 0.01, rgba: STEEL }],
  children: [],
};
// Hold-down clamp: a servo arm that swings down onto the carriage and holds it on
// the bumper while the plunger pushes the proof mass back. Pushing the proof mass
// up from below would otherwise just lift the carriage.
const CARRIAGE_TOP = CARRIAGE_Z + CARR_HALF[2];
const CLAMP_PIVOT: V3 = [DX - 0.045, 0, CARRIAGE_TOP + 0.002];
const resetClamp: SceneNode = {
  id: 'reset_clamp',
  name: 'Hold-Down Clamp',
  type: 'body',
  pos: CLAMP_PIVOT,
  // At rest the arm stands up, clear of the carriage; +90° lays it across the carriage's top.
  joints: [{ name: 'clamp_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], limited: true, range: [-5, 110], damping: 0.004 }],
  geoms: [{ name: 'clamp_arm', type: 'box', size: [0.0015, 0.003, 0.016], pos: [0, 0, 0.016], mass: 0.04, rgba: DARK }],
  children: [],
};
const CROSSHEAD_Z = BASE_TOP + 0.143;
const dropFrame: SceneGeom[] = [
  part('drop_bumper', [0.02, CARR_HALF[1], (BUMPER_TOP - BASE_TOP) / 2], [DX, 0, (BUMPER_TOP + BASE_TOP) / 2], DARK, { solref: [0.004, 1] }),
  part('drop_rail_l', [0.003, 0.003, (CROSSHEAD_Z - BASE_TOP) / 2], [DX - RAIL_X, RAIL_Y, (CROSSHEAD_Z + BASE_TOP) / 2], STEEL, ghost),
  part('drop_rail_r', [0.003, 0.003, (CROSSHEAD_Z - BASE_TOP) / 2], [DX + RAIL_X, RAIL_Y, (CROSSHEAD_Z + BASE_TOP) / 2], STEEL, ghost),
  part('drop_crosshead', [RAIL_X + 0.006, 0.004, 0.003], [DX, RAIL_Y, CROSSHEAD_Z + 0.003], FRAME, ghost),
  { name: 'lift_screw', type: 'cylinder', size: [0.0018, (CROSSHEAD_Z - BASE_TOP) / 2], pos: [DX, RAIL_Y, (CROSSHEAD_Z + BASE_TOP) / 2], rgba: STEEL, ...ghost },
  part('lift_motor', [0.008, 0.008, 0.009], [DX, RAIL_Y, CROSSHEAD_Z + 0.006 + 0.009], DARK, ghost),
  part('plunger_housing', [0.004, 0.004, 0.00325], [DX, SH_Y, BASE_TOP + 0.00325], FRAME, ghost),
  part('clamp_servo', [0.006, 0.006, 0.006], [CLAMP_PIVOT[0], 0.009, CLAMP_PIVOT[2]], DARK, ghost),
  part('clamp_post', [0.005, 0.005, (CLAMP_PIVOT[2] - 0.006 - BASE_TOP) / 2 + 0.0002], [CLAMP_PIVOT[0], 0.009, (CLAMP_PIVOT[2] - 0.006 + BASE_TOP) / 2], FRAME, ghost),
];

// ---------------------------------------------------------------------------
// The bench, and the script that runs all four rigs
// ---------------------------------------------------------------------------
const benchScript = `// Runs the four rigs' actuators: two lead-screw feeders, the drop tester's
// lift screw and its reset plunger. The cam has its own velocity motor.
const t = api.getTime();
const s = api.state;
if (s.presses === undefined) { s.presses = 0; s.keyDown = false; s.tripped = false; s.drop = 0; }

// Servo: drive a slide to a target that moves no faster than 25 mm/s.
function servo(joint, target, kp, kd, hold = 0) {
  const q = api.getJointPosition(joint), v = api.getJointVelocity(joint);
  api.applyJointForce(joint, hold + kp * (target - q) - kd * v);
}
function ramp(t0, step, period, count) {
  const k = Math.min(count, Math.max(0, Math.floor((t - t0) / period) + 1));
  const into = t - (t0 + (k - 1) * period);
  if (k <= 0) return 0;
  // 3 mm of extra stroke, so the front weight or ball always goes over the edge.
  const from = k === 1 ? 0 : (k - 1) * step + 0.003;
  return Math.min(k * step + 0.003, from + Math.max(0, into) * 0.025);
}

// 1. Weight feeder: one 10 g weight into the scale's tray every 3 s.
servo('weight_feed_slide', ramp(1.0, ${WEIGHT_PITCH}, 3.0, 3), 200, 5);

// 2. Ball feeder: one ball down the chute every 2.5 s.
servo('ball_pusher_slide', ramp(0.5, ${(2 * BALL_R + 0.0004).toFixed(4)}, 2.5, 3), 200, 5);

// 3. Count keystrokes past the 2 mm actuation point.
const key = api.getJointPosition('key_slide');
if (!s.keyDown && key < -0.002) { s.keyDown = true; s.presses++; }
if (s.keyDown && key > -0.001) s.keyDown = false;

// 4. Drop tester: the fork lifts the carriage, then drives down out from under
// it; 10, 20 then 50 mm drops, then the reset plunger, and round again.
const heights = [0.01, 0.02, 0.05];
const cycle = 3.0, n = Math.floor(t / cycle), tc = t - n * cycle;
const h = heights[n % heights.length];
const forkQ = api.getJointPosition('fork_screw');
const forkWeight = api.getMass('lift_fork') * 9.81;
const load = forkQ > ${(FORK_REACH - 0.001).toFixed(4)} ? (api.getMass('drop_carriage') + api.getMass('shock_indicator')) * 9.81 : 0;
if (tc < 1.6) servo('fork_screw', Math.min(${FORK_REACH} + h, tc * 0.05), 400, 4, forkWeight + load);
else servo('fork_screw', -0.001, 400, 4, forkWeight);
const trip = api.getJointPosition('indicator_slide') > 0.0025;
if (trip && !s.tripped) { s.tripped = true; api.log('Shock indicator TRIPPED by the ' + (h * 1000) + ' mm drop'); }
if (!trip && s.tripped) s.tripped = false;
// Reset, after the 50 mm drop: the clamp holds the carriage down on the bumper,
// the plunger pushes the proof mass back over the hill, then both stand clear.
const resetWindow = n % heights.length === 2;
const clamping = resetWindow && tc > 2.0 && tc < 2.85;
const pushing = resetWindow && tc > 2.25 && tc < 2.75;
const clampAngle = api.getJointPosition('clamp_hinge');
// Closed is a little past touching, so the arm presses; open is straight up, clear of the carriage.
api.applyJointForce('clamp_hinge', 0.3 * ((clamping ? 1.82 : 0) - clampAngle) - 0.04 * 9.81 * 0.016 * Math.sin(clampAngle)); // minus the arm's own weight
// The plunger rises at 30 mm/s: a slow, firm push, not a hammer blow.
servo('reset_slide', pushing ? Math.min(0.011, (tc - 2.25) * 0.03) : 0, 400, 2, api.getMass('reset_plunger') * 9.81);
`;

const bench: SceneNode = {
  id: 'flexure_bench',
  name: 'Test Bench',
  type: 'body',
  pos: [0, 0, 0],
  script: benchScript,
  joints: [],
  geoms: [
    part('bench_plate', [0.235, 0.088, 0.006], [0, 0, 0.006], [0.2, 0.22, 0.26, 1]),
    ...scaleFrame,
    ...flapFrame,
    ...keyFrame,
    ...dropFrame,
  ],
  children: [scaleBeam, weightPusher, checkFlap, ballPusher, keycap, cam, carriage, liftFork, resetPlunger, resetClamp],
};

export const flexuresAtWorkPreset: SceneGraph = { nodes: [bench, ...weights, ...balls] };
