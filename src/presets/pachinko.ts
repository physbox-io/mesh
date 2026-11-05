// ---------------------------------------------------------------------------
// Pachinko — a tabletop ball machine that runs itself
// ---------------------------------------------------------------------------
//
// A 360 x 500 mm cabinet leaning back 8° on a stand, so 11 mm steel balls ride
// the backboard under a glass front. Everything is mechanics:
//
//   hammer    a sprung slide held down by a solenoid (the script's force). Let
//             go, it comes up between two rails and throws the ball seated on
//             them up the launch lane.
//   arc       the ball runs round the inside of the top rail and drops into
//             the pins wherever it has slowed to.
//   field     brass pins, two free-spinning windmills and three tulips.
//   ramp      everything lands on a floor falling to the left, which rolls it
//             under the lane wall and onto the rails. So it never runs out.
//
// The arc and the tulips are curved meshes, hollow side towards the ball. As
// convex hulls they would fill the top of the cabinet, and they collide as
// exact pieces instead (utils/reflexCuts.ts).
//
// Hold Space to pull the hammer yourself; let go to fire. Left alone it plays,
// each shot a different strength.
//
// The cabinet is one tilted body and its coordinates are its own: x across, z
// up the board, y through it with the backboard's face at 0 and the glass
// towards -y. Balls are in the world, so they go through `world()`.
// ---------------------------------------------------------------------------

import { ShapeUtils, Vector2 } from 'three';
import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';

const TILT_DEG = -8;
const CABINET_POS = [0, 0, 0.02];

const BALL_R = 0.0055;
/** Clear depth in the launch lane: a ball and a little. */
const LANE_DEPTH = 0.0116;
/** Clear depth between backboard and glass, and the middle of it. */
const DEPTH = 0.013;
const MID_Y = -DEPTH / 2;
/** A ball leans on the backboard, so this is where its centre runs. */
const BALL_Y = -BALL_R;

/** The arc's centre, and the walls it runs down into. */
const ARC_Z = 0.3;
const WALL_X = 0.165;
const LANE_WALL_X = -0.148;
const LANE_WALL_TOP = 0.285;
const LANE_WALL_FOOT = 0.075;

/** Where the ramp's surface ends at the lane, and its fall. */
const RAMP_LEFT_X = -0.149;
const RAMP_LEFT_Z = 0.05;
const RAMP_SLOPE = 0.09;
const rampZ = (x: number) => RAMP_LEFT_Z + (x - RAMP_LEFT_X) * RAMP_SLOPE;

/** The ball's seat, on two rails 7 mm apart either side of the hammer. */
const SEAT_X = -WALL_X + BALL_R + 0.0002;
const RAIL_TOP = RAMP_LEFT_Z - 0.0003;
const RAIL_GAP = 0.0035;
const SEAT_Z = RAIL_TOP + Math.sqrt(BALL_R ** 2 - RAIL_GAP ** 2);

// Short enough that pulled right down, the head is still clear of the stand.
const HAMMER_Z = 0.037;
const HAMMER_HEAD_HALF = 0.005;
const HEAD_R = 0.0021;
const HAMMER_K = 170;
const HAMMER_REF = 0.05;
const HAMMER_RANGE = [-0.03, 0.022];

/** Lively contact: steel on brass rings off, where the default would sink in. */
const HARD = { solref: [0.003, 0.45], friction: [0.15, 0.002, 0.0001] };

const BOARD = [0.025, 0.012, 0.07, 1];
const CASE = [0.02, 0.02, 0.03, 1];
const YELLOW = [1, 0.92, 0.1, 1];
const MAGENTA = [1, 0.05, 0.75, 1];
const CYAN = [0.05, 0.9, 1, 1];
const LIME = [0.35, 1, 0.1, 1];
const ORANGE = [1, 0.4, 0.03, 1];
const VIOLET = [0.55, 0.15, 1, 1];
/** How hard the tubes shine: the frame brightest, the pins a sparkle. */
const TUBE = { glow: 1 };
const SPARK = { glow: 0.55 };

type Point = [number, number];

const box = (name: string, pos: number[], size: number[], rgba: number[], extra: Partial<SceneGeom> = {}): SceneGeom =>
  ({ name, type: 'box', pos, size, rgba, ...HARD, ...extra });

/**
 * A closed outline in the board's x-z plane, anticlockwise from the front,
 * stood through the playing depth as a Z-up mesh. Winding comes from that
 * outline: the near cap faces -y, the far +y, and each side away from the
 * outline's inside (the mesh-winding trap in CLAUDE.md).
 */
export function prismMesh(outline: Point[], y0 = -DEPTH, y1 = 0) {
  const n = outline.length;
  const renderVertices = [...outline.flatMap(([x, z]) => [x, y0, z]), ...outline.flatMap(([x, z]) => [x, y1, z])];
  const faces: number[] = [];
  for (const [a, b, c] of ShapeUtils.triangulateShape(outline.map(([x, z]) => new Vector2(x, z)), [])) {
    faces.push(a, b, c, n + a, n + c, n + b);
  }
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    faces.push(i, n + j, j, i, n + i, n + j);
  }
  // Three's Y-up, as every mesh geom carries both.
  const vertices: number[] = [];
  for (let i = 0; i < renderVertices.length; i += 3) vertices.push(renderVertices[i], renderVertices[i + 2], -renderVertices[i + 1]);
  return { renderVertices, vertices, faces };
}

/** A curved band between two radii, angles in degrees and rising. */
export function arcBand(cx: number, cz: number, inner: number, outer: number, fromDeg: number, toDeg: number, steps: number): Point[] {
  const at = (r: number, deg: number): Point => {
    const t = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(t), cz + r * Math.sin(t)];
  };
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) out.push(at(outer, fromDeg + ((toDeg - fromDeg) * i) / steps));
  for (let i = steps; i >= 0; i--) out.push(at(inner, fromDeg + ((toDeg - fromDeg) * i) / steps));
  return out;
}

const bandGeom = (name: string, outline: Point[], rgba: number[]): SceneGeom =>
  ({ name, type: 'mesh', size: [1], dynamic: true, rgba, ...TUBE, ...HARD, ...prismMesh(outline) });

const TULIPS: Point[] = [[-0.075, 0.15], [0.085, 0.15], [0.005, 0.235]];
const TULIP_COLOURS = [LIME, ORANGE, CYAN];
const WINDMILLS: Point[] = [[-0.06, 0.315], [0.075, 0.315]];

function pins(): SceneGeom[] {
  const out: SceneGeom[] = [];
  const clear = (x: number, z: number) =>
    TULIPS.every(([tx, tz]) => Math.hypot(x - tx, z - tz) > 0.03)
    && WINDMILLS.every(([wx, wz]) => Math.hypot(x - wx, z - wz) > 0.036)
    && Math.hypot(x, z - ARC_Z) < 0.15 + (z < ARC_Z ? 1 : 0);
  let row = 0;
  for (let z = 0.095; z < 0.44; z += 0.019, row++) {
    for (let x = -0.13 + (row % 2) * 0.01; x < 0.155; x += 0.02) {
      if (!clear(x, z)) continue;
      out.push({ name: `pin_${out.length}`, type: 'cylinder', pos: [x, MID_Y, z], euler: [90, 0, 0], size: [0.0013, DEPTH / 2], rgba: YELLOW, ...SPARK, ...HARD });
    }
  }
  return out;
}

const windmill = (i: number, [x, z]: Point): SceneNode => ({
  id: `windmill_${i}`, name: `windmill_${i}`, type: 'body', pos: [x, MID_Y, z], children: [],
  joints: [{ name: `windmill_${i}_axle`, type: 'hinge', axis: [0, 1, 0], damping: 0.000004 }],
  geoms: [
    { name: `windmill_${i}_hub`, type: 'cylinder', euler: [90, 0, 0], size: [0.004, DEPTH / 2 - 0.0007], rgba: YELLOW, ...TUBE, density: 2000, ...HARD },
    ...[0, 45, 90, 135].map((deg, k) => ({
      name: `windmill_${i}_blade_${k}`, type: 'box', euler: [0, deg, 0], size: [0.024, DEPTH / 2 - 0.0007, 0.0012], rgba: i ? LIME : VIOLET, ...TUBE, density: 900, ...HARD,
    } as SceneGeom)),
  ],
});

/**
 * The solenoid. `pull` sits below the rails, where the next ball can roll in;
 * every `PERIOD` it lets go for long enough to fire. Strength comes from how
 * far it had pulled, and the golden-ratio walk spreads that evenly over shots.
 * Space overrides: held, it pulls right down, and letting go fires.
 */
const HAMMER_SCRIPT = `
const PERIOD = 0.9, FIRE = 0.09, K = ${HAMMER_K}, REF = ${HAMMER_REF};
const q = api.getJointPosition('hammer_slide');
const v = api.getJointVelocity('hammer_slide');
const t = api.getTime();
const shot = Math.floor(t / PERIOD);
const held = api.isKeyPressed('space');
const firing = !held && t % PERIOD < FIRE;
if (!firing) {
  const strength = ((shot + 1) * 0.618034) % 1;
  const pull = held ? -0.03 : -0.02 - 0.01 * strength;
  api.applyJointForce('hammer_slide', K * (q - REF) + 900 * (pull - q) - 30 * v);
}
`;

const hammer: SceneNode = {
  id: 'hammer', name: 'hammer', type: 'body', pos: [SEAT_X, BALL_Y, HAMMER_Z], children: [],
  joints: [{
    name: 'hammer_slide', type: 'slide', axis: [0, 0, 1], limited: true, range: HAMMER_RANGE, hardStop: true,
    stiffness: HAMMER_K, springref: HAMMER_REF, damping: 0.02,
  }],
  script: HAMMER_SCRIPT,
  geoms: [
    // Rounded, not a box. A contact pushes a ball out of a capsule along the
    // line between them, which stays in the board's plane. A ball landing on
    // the rising head of a thin box could end up with its centre inside it, and
    // a box pushes that out of its nearest face, here the front: through the
    // glass at 100 m/s.
    { name: 'hammer_head', type: 'capsule', pos: [0, 0, HAMMER_HEAD_HALF - HEAD_R], euler: [0, 90, 0], size: [HEAD_R, 0.0025], mass: 0.03, rgba: ORANGE, ...TUBE, solref: [0.004, 1], friction: [0.2, 0.002, 0.0001] },
    { name: 'hammer_rod', type: 'box', pos: [0, 0, -0.002], size: [0.002, 0.0016, HAMMER_HEAD_HALF - 0.002], mass: 0.001, rgba: ORANGE, contype: 0, conaffinity: 0 },
  ],
};

const cabinet: SceneNode = {
  id: 'cabinet', name: 'cabinet', type: 'body', pos: CABINET_POS, euler: [TILT_DEG, 0, 0],
  joints: [],
  geoms: [
    // Thick enough that no ball crosses either in one 1 ms step.
    box('backboard', [0, 0.006, 0.25], [0.18, 0.006, 0.25], BOARD),
    box('glass', [0, -DEPTH - 0.005, 0.25], [0.18, 0.005, 0.25], [0.6, 0.8, 1, 0.06]),
    // Takes the lane down to a ball's depth. With the field's 2 mm of play, a
    // ball could lie off the hammer's line, and the head then caught its lower
    // edge and wedged it against the glass: the stiff contact threw the ball
    // through the glass at 99 m/s.
    box('lane_liner', [(LANE_WALL_X - WALL_X) / 2, -(DEPTH + LANE_DEPTH) / 2, (LANE_WALL_TOP + RAIL_TOP) / 2], [(WALL_X + LANE_WALL_X) / 2, (DEPTH - LANE_DEPTH) / 2, (LANE_WALL_TOP - RAIL_TOP) / 2], [0.6, 0.8, 1, 0.06]),
    box('left_wall', [-WALL_X - 0.0075, MID_Y, ARC_Z / 2], [0.0075, DEPTH / 2, ARC_Z / 2], MAGENTA, TUBE),
    box('right_wall', [WALL_X + 0.0075, MID_Y, ARC_Z / 2], [0.0075, DEPTH / 2, ARC_Z / 2], MAGENTA, TUBE),
    box('lane_wall', [LANE_WALL_X, MID_Y, (LANE_WALL_TOP + LANE_WALL_FOOT) / 2], [0.002, DEPTH / 2, (LANE_WALL_TOP - LANE_WALL_FOOT) / 2], CYAN, TUBE),
    box('ramp', [(RAMP_LEFT_X + WALL_X) / 2, MID_Y, rampZ((RAMP_LEFT_X + WALL_X) / 2) - 0.003], [(WALL_X - RAMP_LEFT_X) / 2 + 0.002, DEPTH / 2, 0.003], CYAN,
      { ...TUBE, euler: [0, -(Math.atan(RAMP_SLOPE) * 180) / Math.PI, 0] }),
    // The hammer comes up between these, and a ball seats across them.
    box('rail_near', [(SEAT_X + RAMP_LEFT_X) / 2 - 0.002, BALL_Y - RAIL_GAP, RAIL_TOP - 0.003], [0.008, 0.00075, 0.003], CYAN, SPARK),
    box('rail_far', [(SEAT_X + RAMP_LEFT_X) / 2 - 0.002, BALL_Y + RAIL_GAP, RAIL_TOP - 0.003], [0.008, 0.00075, 0.003], CYAN, SPARK),
    bandGeom('arc', arcBand(0, ARC_Z, WALL_X, WALL_X + 0.015, 0, 180, 48), MAGENTA),
    ...TULIPS.flatMap(([x, z], i) => [
      bandGeom(`tulip_${i}_left`, arcBand(x, z, 0.012, 0.0145, 130, 235, 12), TULIP_COLOURS[i]),
      bandGeom(`tulip_${i}_right`, arcBand(x, z, 0.012, 0.0145, -55, 50, 12), TULIP_COLOURS[i]),
    ]),
    ...pins(),
  ],
  children: [hammer, ...WINDMILLS.map((p, i) => windmill(i, p))],
};

/** The cabinet's own coordinates in the world. */
export function pachinkoWorld([x, y, z]: number[]): number[] {
  const t = (TILT_DEG * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  return [CABINET_POS[0] + x, CABINET_POS[1] + c * y - s * z, CABINET_POS[2] + s * y + c * z];
}

export const PACHINKO_BALLS = 14;
const BALL_COLOURS = [CYAN, MAGENTA, YELLOW, LIME, ORANGE, VIOLET];

function ball(i: number): SceneNode {
  const x = i === 0 ? SEAT_X : RAMP_LEFT_X + 0.0005 + (i - 0.5) * 0.0116;
  const local = [x, BALL_Y, i === 0 ? SEAT_Z : rampZ(x) + BALL_R + 0.0002];
  return {
    id: `ball_${i}`, name: `ball_${i}`, type: 'body', pos: pachinkoWorld(local), children: [],
    joints: [{ name: `ball_${i}_free`, type: 'free' }],
    geoms: [{ name: `ball_${i}_g`, type: 'sphere', size: [BALL_R], mass: 0.0055, rgba: BALL_COLOURS[i % BALL_COLOURS.length], glow: 0.8, ...HARD }],
  };
}

/** Rear struts from the base plate to the cabinet's back, one each side. */
function stand(): SceneNode {
  const top = pachinkoWorld([0, 0.012, 0.3]);
  const foot = [0, 0.17, 0.02];
  const dy = top[1] - foot[1], dz = top[2] - foot[2];
  const half = Math.hypot(dy, dz) / 2;
  const euler = [(Math.atan2(-dy, dz) * 180) / Math.PI, 0, 0];
  const strut = (x: number, name: string): SceneGeom =>
    ({ name, type: 'box', pos: [x, (top[1] + foot[1]) / 2, (top[2] + foot[2]) / 2], euler, size: [0.008, 0.006, half], rgba: CASE });
  return {
    id: 'stand', name: 'stand', type: 'body', pos: [0, 0, 0], joints: [], children: [],
    geoms: [
      { name: 'base_plate', type: 'box', pos: [0, 0.07, 0.01], size: [0.2, 0.12, 0.01], rgba: CASE },
      strut(-0.15, 'strut_left'),
      strut(0.15, 'strut_right'),
    ],
  };
}

export const pachinkoPreset: SceneGraph = {
  nodes: [stand(), cabinet, ...Array.from({ length: PACHINKO_BALLS }, (_, i) => ball(i))],
};
