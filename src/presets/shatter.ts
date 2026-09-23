// Shatter: a wrecking ball, and things that come apart when it arrives.
//
// The demo for breakable welds, and the scene the rest of the break-and-deform
// work grows into — impact shatter, denting and crumple hinges each add a beat
// here rather than getting a preset of their own.
//
// Everything in it is real mechanics, per the house rule. The ball is not
// animated: it is a 20 kg mass on a hinge, started out horizontal, and what
// hits the tower is whatever gravity has made of it by the time it gets there —
// about 3 m/s, arriving near the top of the stack.
//
// The tower is a stack of free bodies welded to each other and to the plinth,
// rather than one body or a parented chain, because a weld is the only joint
// here that can be asked to let go. The thresholds are graded so the thing
// fails the way masonry does — the courses above the strike shear off and
// topple, the base holds — instead of disintegrating all at once.
//
// Four things happen, and all four are the same idea at different scales:
//
//   * the tower's welds SHEAR, and the parts come off
//   * the vase SHATTERS, and is replaced by pieces that add up to it
//   * the steel plate DENTS under one dropped weight and not under the other
//   * the shelf bracket CRUMPLES, and stays bent
//
// None of it is an edit. The saved scene still holds a whole vase on an intact
// tower, and Reset puts every bit of it back.

import { buildSolidLathe } from '../utils/lathe';
import { cylinderMeshForDenting } from '../utils/dentMesh';
import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';

const CERAMIC = [0.78, 0.38, 0.26, 1];
const CERAMIC_DARK = [0.66, 0.31, 0.21, 1];
const STEEL = [0.22, 0.23, 0.26, 1];
const FRAME = [0.42, 0.44, 0.50, 1];
const STONE = [0.55, 0.54, 0.52, 1];

/** Half-extent of a course, so a block is 0.12 m on a side. */
const R = 0.06;
const COURSES = 5;
/** Top of the plinth, where the first course sits. */
const PLINTH_TOP = 0.06;

/**
 * What each course's weld survives, in newtons.
 *
 * Standing still these carry very little, because the stack's weight goes down
 * through the contacts between the blocks rather than through the welds. What
 * they earn their keep on is SHEAR, which is exactly what a wrecking ball
 * delivers — so the numbers below look far larger than a 7.5 kg tower would
 * suggest, and a weld sized by the tower's own weight would be an order of
 * magnitude too weak to survive the blow.
 *
 * Measured rather than guessed. Run the scene with nothing allowed to break and
 * the peak each weld ever sees is roughly:
 *
 *              resting   struck
 *     course0    29.8 N   814 N
 *     course1    18.4 N   488 N
 *     course2    11.1 N   254 N
 *     course3     6.3 N   267 N
 *     course4     2.8 N    80 N
 *
 * all of the second column inside the 20 ms of the strike, and all of it with
 * the vase standing in the ball's path, since it takes a bite out of the blow
 * before the tower ever feels it.
 *
 * Each threshold sits several times over what its weld carries standing still
 * and several times under what the ball puts through it, rather than close to
 * either. That margin is the point: adding so much as one more body to this
 * scene shifts the contact ordering a little, and thresholds tuned to the edge
 * of the measured peak quietly stop breaking when it does.
 *
 * The base is the exception, deliberately out of reach — it takes by far the
 * most, the way the root of any cantilever does, and holding it is what leaves
 * a stump on the plinth with everything above it on the floor.
 */
const COURSE_BREAK_N = [1400, 120, 70, 45, 25];

const course = (i: number): SceneNode => ({
  id: `course${i}`,
  name: `course${i}`,
  type: 'body',
  pos: [0, 0, PLINTH_TOP + R + i * 2 * R],
  joints: [{ name: `course${i}_free`, type: 'free' }],
  geoms: [{
    name: `course${i}_geom`,
    type: 'box',
    size: [R, R, R],
    mass: 1.5,
    rgba: i % 2 === 0 ? CERAMIC : CERAMIC_DARK,
  }],
  children: [],
  // Each course is held to the one below it, and the first to the plinth.
  weldTargetId: i === 0 ? 'plinth' : `course${i - 1}`,
  weldBreakForceN: COURSE_BREAK_N[i],
  weldBreakHoldSteps: 3,
});

// ---------------------------------------------------------------------------
// The porcelain vase, and the steel plate beside it
// ---------------------------------------------------------------------------

const PORCELAIN = [0.90, 0.90, 0.87, 1];
const COBALT = [0.20, 0.30, 0.62, 1];
const PLATE_STEEL = [0.38, 0.40, 0.44, 1];
const LEAD = [0.30, 0.30, 0.34, 1];
const RUBBER = [0.18, 0.42, 0.30, 1];

/** Y-up (three.js) to the raw MuJoCo Z-up a dynamic mesh geom renders from. */
const toRenderVertices = (v: number[]): number[] => {
  const out = new Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    out[i] = v[i];
    out[i + 1] = -v[i + 2];
    out[i + 2] = v[i + 1];
  }
  return out;
};

const VASE_HEIGHT = 0.30;
/** Where the vase stands. The ball's arc puts it at z = 0.55 passing x = -0.30. */
const PEDESTAL_TOP = 0.40;
/**
 * How far out the handles sit.
 *
 * The vase is widest at 0.092 m, just above its middle, and the handles are
 * 0.010 m capsules — so anything under 0.102 buries them in the pot. That is not
 * a cosmetic problem: an embedded handle is in permanent contact with the body
 * it is welded to, and the weld spends 50 N holding the two apart before
 * anything has even happened. They sit a hair clear instead.
 */
const VASE_HANDLE_Y = 0.104;

/**
 * A vase profile: a foot, a swelling belly, a waisted neck and a flared lip.
 *
 * Built as a real hollow lathe rather than as a cylinder, because the point of
 * the thing is that it is porcelain. Its shards are cut from its convex hull —
 * see utils/fracture.ts for why — so the pieces read as pieces of a vessel
 * without every one of them having to be a shell.
 */
const vaseRadius = (z: number): number => {
  const t = z / VASE_HEIGHT;
  const foot = 0.040 + 0.012 * Math.exp(-Math.pow(t / 0.10, 2));
  const belly = 0.052 * Math.exp(-Math.pow((t - 0.38) / 0.28, 2));
  const lip = 0.022 * Math.exp(-Math.pow((t - 1.0) / 0.10, 2));
  return foot + belly + lip;
};

/**
 * Recentre a mesh on its own volume centroid, and say how far it moved.
 *
 * Not optional for a dynamic mesh geom. MuJoCo puts a body's origin on the mesh
 * centroid and `data.xpos` tracks THAT, while the renderer draws the geom's
 * vertices straight at xpos — so a mesh whose vertices are not already centred
 * is drawn one centroid-offset away from where it actually is. The lathe builds
 * from z = 0 upward, which for a 0.30 m vase is 0.12 m of offset: enough that
 * standing it on a plinth buries it inside, and a body that starts a tenth of a
 * metre inside a solid is ejected by the contact solver at the first step.
 *
 * The offset comes back so the caller can put the vase where it means to.
 */
const recentreOnCentroid = (vertices: number[], faces: number[]) => {
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ax = vertices[a], ay = vertices[a + 1], az = vertices[a + 2];
    const bx = vertices[b], by = vertices[b + 1], bz = vertices[b + 2];
    const cx3 = vertices[c], cy3 = vertices[c + 1], cz3 = vertices[c + 2];
    const d = ax * (by * cz3 - bz * cy3) - ay * (bx * cz3 - bz * cx3) + az * (bx * cy3 - by * cx3);
    vol += d;
    cx += (ax + bx + cx3) * d; cy += (ay + by + cy3) * d; cz += (az + bz + cz3) * d;
  }
  const centroid = Math.abs(vol) < 1e-15
    ? [0, 0, 0]
    : [cx / (4 * vol), cy / (4 * vol), cz / (4 * vol)];
  const out = vertices.slice();
  for (let i = 0; i < out.length; i += 3) {
    out[i] -= centroid[0]; out[i + 1] -= centroid[1]; out[i + 2] -= centroid[2];
  }
  return { vertices: out, centroid };
};

const vaseMesh = () => {
  const raw = buildSolidLathe(vaseRadius, VASE_HEIGHT, 28, 24, 0.22);
  const { vertices, centroid } = recentreOnCentroid(raw.vertices, raw.faces);
  return { vertices, faces: raw.faces, centroid };
};

/** How far the vase's base sits below its centroid, i.e. below its own origin. */
export const VASE_BASE_DROP = vaseMesh().centroid[1];

const vaseGeom = (): SceneGeom => {
  const { vertices, faces } = vaseMesh();
  return {
    name: 'vase_geom',
    type: 'mesh',
    size: [1],
    dynamic: true,
    vertices,
    renderVertices: toRenderVertices(vertices),
    faces,
    mass: 1.4,
    rgba: PORCELAIN,
  };
};

/** A plate, as a slab of mesh fine enough to take a visible crater. */
const slabMesh = (halfX: number, halfY: number, halfZ: number, nx: number, ny: number) => {
  // A dent is a displacement of vertices, so a six-vertex box cannot show one.
  // The top face is gridded; the rest of the slab is the four sides and a
  // floor, which is all it needs to be a closed solid.
  const vertices: number[] = [];
  const faces: number[] = [];
  const top: number[][] = [];
  for (let i = 0; i <= nx; i++) {
    top[i] = [];
    for (let j = 0; j <= ny; j++) {
      const x = -halfX + (2 * halfX * i) / nx;
      const z = -halfY + (2 * halfY * j) / ny;
      top[i][j] = vertices.length / 3;
      vertices.push(x, halfZ, z); // Y-up: the struck face looks up
    }
  }
  const bottom: number[][] = [];
  for (let i = 0; i <= nx; i++) {
    bottom[i] = [];
    for (let j = 0; j <= ny; j++) {
      const x = -halfX + (2 * halfX * i) / nx;
      const z = -halfY + (2 * halfY * j) / ny;
      bottom[i][j] = vertices.length / 3;
      vertices.push(x, -halfZ, z);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      faces.push(top[i][j], top[i][j + 1], top[i + 1][j]);
      faces.push(top[i + 1][j], top[i][j + 1], top[i + 1][j + 1]);
      faces.push(bottom[i][j], bottom[i + 1][j], bottom[i][j + 1]);
      faces.push(bottom[i + 1][j], bottom[i + 1][j + 1], bottom[i][j + 1]);
    }
  }
  // Skirt the four edges so the slab is a closed solid rather than two sheets.
  for (let i = 0; i < nx; i++) {
    faces.push(top[i][0], top[i + 1][0], bottom[i][0]);
    faces.push(bottom[i][0], top[i + 1][0], bottom[i + 1][0]);
    faces.push(top[i + 1][ny], top[i][ny], bottom[i + 1][ny]);
    faces.push(bottom[i + 1][ny], top[i][ny], bottom[i][ny]);
  }
  for (let j = 0; j < ny; j++) {
    faces.push(top[0][j + 1], top[0][j], bottom[0][j + 1]);
    faces.push(bottom[0][j + 1], top[0][j], bottom[0][j]);
    faces.push(top[nx][j], top[nx][j + 1], bottom[nx][j]);
    faces.push(bottom[nx][j], top[nx][j + 1], bottom[nx][j + 1]);
  }
  return { vertices, faces };
};


const PLATE_HALF_Z = 0.012;

const plateGeom = (): SceneGeom => {
  const { vertices, faces } = slabMesh(0.24, 0.16, PLATE_HALF_Z, 34, 24);
  return {
    name: 'plate_geom',
    type: 'mesh',
    size: [1],
    dynamic: true,
    vertices,
    renderVertices: toRenderVertices(vertices),
    faces,
    /*
     * Heavy. The blow is measured on whatever DELIVERS it — a falling weight
     * carries no constraint force until the instant it lands, so the whole of
     * the collision shows up there — which leaves the plate free to be as
     * immovable as a plate ought to be.
     */
    mass: 45,
    rgba: PLATE_STEEL,
    friction: [1.2, 0.01, 0.001],
    /*
     * Mild steel, near enough, and the number is measured rather than chosen:
     * from this height the steel weight lands about 6.0 N*s on the plate and the
     * rubber one about 3.1 N*s, so the yield sits between them. Below it the
     * plate is unmarked, which is the half of the demonstration that is easy to
     * forget — a surface that dents under EVERYTHING has said nothing about the
     * material it is made of.
     */
    /*
     * Dropped from 1.05 m, the steel slug lands 10.9 N*s on this plate and the
     * rubber one 5.6 N*s, so the yield sits between them: one marks it, the
     * other does not.
     */
    dentYieldNs: 6,
    /*
     * Chosen so the plate keeps ANSWERING over the range of blows it actually
     * receives, rather than saturating just past its yield. An earlier rate of
     * 0.012 m per N*s put the depth on its cap at an impulse of 5.3 — a hair
     * over the threshold — so every blow harder than "just enough" left an
     * identical crater and the weight's mass made no difference at all.
     *
     * Dropped from 1.05 m the slug lands about 10.9 N*s, which is 7 mm deep and
     * a third again as wide as the base radius; at twice the mass it is at the
     * cap in depth and twice as wide. Width carries most of that difference,
     * because depth is limited by the 24 mm the plate is thick and width is not.
     */
    dentDepthPerNs: 0.0015,
    dentRadius: 0.032,
    dentMaxDepth: 0.014,
  };
};

/**
 * A weight, dropped on the plate. `hard` decides what gives.
 *
 * Both are meshes, so either CAN deform; what differs is whether either does.
 * The steel slug has no yield of its own and marks the plate; the rubber one
 * yields at a third of what the plate does, so it squashes and the plate under
 * it is left clean. Two identical masses, two identical drops, and the material
 * is the only thing deciding which of the pair takes the damage.
 */
const weight = (id: string, x: number, hard: boolean): SceneNode => {
  const { vertices, faces } = cylinderMeshForDenting(0.038, 0.05);
  return {
    id,
    name: id,
    type: 'body',
    pos: [x, 0.34, 1.05],
    joints: [{ name: `${id}_free`, type: 'free' }],
    geoms: [{
      name: `${id}_geom`,
      type: 'mesh',
      size: [1],
      dynamic: true,
      vertices,
      renderVertices: toRenderVertices(vertices),
      faces,
      /*
       * Light enough to pick up and throw again afterwards, and dropped from
       * higher to make up the momentum. An 8 kg slug landed the same blow but
       * was immovable once it had, which made the plate a thing you watched
       * once.
       */
      mass: 3.5,
      rgba: hard ? LEAD : RUBBER,
      /*
       * Identical mass, identical drop. The ONLY difference is how long each
       * one takes to stop. Impulse is the same either way — momentum is
       * momentum — but the soft one spreads it over tens of milliseconds
       * instead of one or two, so it never puts enough through the plate to
       * mark it. That is the honest reason a rubber mallet does not dent what
       * a steel one does.
       *
       * solref's first number is the contact time constant, in seconds.
       */
      solref: hard ? [0.002, 1] : [0.03, 1.5],
      friction: [1, 0.02, 0.002],
      // Only the rubber one deforms, and it does so well below the plate's
      // yield — so it always marks itself and never the plate.
      /*
       * Only the rubber one deforms, and it yields well below the plate — so
       * the soft blow always marks the weight and never the plate, while the
       * hard blow marks the plate and leaves the slug untouched. Each of the
       * pair damages exactly one thing, and it is not the same thing.
       */
      ...(hard ? {} : {
        dentYieldNs: 3,
        dentDepthPerNs: 0.004,
        dentRadius: 0.030,
        dentMaxDepth: 0.020,
      }),
    }],
    children: [],
    // A solid cylinder is its own hull; there is nothing to decompose.
    collision: 'hull',
  };
};

export const shatterPreset: SceneGraph = {
  name: 'Shatter',
  nodes: [
    // --- The gantry. No joints, so it is scenery; the arm hanging off it is
    //     the only moving part of the rig.
    {
      id: 'gantry',
      name: 'gantry',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        { name: 'gantry_foot', type: 'box', size: [0.08, 0.12, 0.02], pos: [0.72, 0, 0.02], rgba: FRAME },
        { name: 'gantry_post', type: 'cylinder', size: [0.022, 0.49], pos: [0.72, 0, 0.49], rgba: FRAME },
        { name: 'gantry_beam', type: 'capsule', fromto: [0.72, 0, 0.98, 0, 0, 0.98], size: [0.018], rgba: FRAME },
        { name: 'gantry_brace', type: 'capsule', fromto: [0.72, 0, 0.70, 0.38, 0, 0.96], size: [0.012], rgba: FRAME },
      ],
      children: [
        // --- The ball, on a hinge at the end of the beam. It starts out
        //     horizontal on the far side and is released into the tower by
        //     gravity alone; nothing scripts it.
        {
          id: 'wrecking_arm',
          name: 'wrecking_arm',
          type: 'body',
          pos: [0, 0, 0.98],
          joints: [{ name: 'wrecking_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.02 }],
          geoms: [
            { name: 'wrecking_chain', type: 'capsule', fromto: [0, 0, 0, -0.52, 0, 0], size: [0.009], mass: 0.4, rgba: STEEL },
            { name: 'wrecking_ball', type: 'sphere', size: [0.075], pos: [-0.52, 0, 0], mass: 20, rgba: STEEL },
          ],
          children: [],
        },
      ],
    },

    // --- The plinth the tower is built on. Scenery, so the stack has something
    //     that does not move to shear away from.
    {
      id: 'plinth',
      name: 'plinth',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        { name: 'plinth_geom', type: 'box', size: [0.13, 0.13, 0.03], pos: [0, 0, 0.03], rgba: STONE },
      ],
      children: [],
    },

    ...Array.from({ length: COURSES }, (_, i) => course(i)),

    // --- The porcelain vase, on its own pedestal in the ball's path. Two
    //     handles welded on at almost nothing, and a body that comes apart.
    {
      id: 'vase_pedestal',
      name: 'vase_pedestal',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        /*
         * Tall on purpose. The ball's arc puts it at z = 0.55 as it passes
         * x = -0.30, so a vase on a low plinth is clipped across the rim and
         * barely touched. Standing the vase at 0.40 puts its belly in the path.
         */
        { name: 'vase_pedestal_geom', type: 'cylinder', size: [0.07, PEDESTAL_TOP / 2], pos: [-0.30, 0, PEDESTAL_TOP / 2], rgba: STONE },
      ],
      children: [],
    },
    {
      id: 'vase',
      name: 'vase',
      type: 'body',
      pos: [-0.30, 0, PEDESTAL_TOP + VASE_BASE_DROP],
      joints: [{ name: 'vase_free', type: 'free' }],
      geoms: [vaseGeom()],
      children: [],
      /*
       * A vase is brittle: it does not dent, it goes. The ball clips it at
       * about 1.7 N*s on its way to the tower, so the threshold sits under
       * that and far over anything the vase feels standing on its plinth.
       */
      shatterImpulseNs: 1.2,
      shatterPieces: 14,
      shatterSeed: 7,
      shatterPattern: 'radial',
      shatterSpread: 0.35,
      /*
       * The pieces break again when they land, and their pieces do not.
       *
       * Each shard inherits a threshold scaled to its own share of the vase,
       * so a chip that hits the floor comes apart the way porcelain does
       * rather than bouncing like a pebble. What keeps that affordable lives
       * in utils/runtimeShatter.ts: a shard comes apart into at most four
       * chips, chips never collide with one another (only with everything
       * else), and the world holds at most MAX_LIVE_SHARDS. Measured here, the
       * whole cascade steps in real time.
       */
      shatterDepth: 1,
      /*
       * Hulled rather than decomposed.
       *
       * Left on 'auto' this is a hollow lathe with a solidity around 0.3, so
       * every rebuild sends fourteen hundred vertices through V-HACD to work
       * out the shape of a cavity nothing ever goes into — and it re-runs on
       * every edit. The one thing this body is for is being hit hard enough to
       * stop existing, and what replaces it is fourteen convex shards.
       */
      collision: 'hull',
    },
    {
      id: 'vase_handle_l',
      name: 'vase_handle_l',
      type: 'body',
      pos: [-0.30, VASE_HANDLE_Y, PEDESTAL_TOP + 0.114],
      joints: [{ name: 'vase_handle_l_free', type: 'free' }],
      geoms: [{
        name: 'vase_handle_l_geom', type: 'capsule',
        fromto: [0, 0, -0.035, 0, 0, 0.035], size: [0.010], mass: 0.08, rgba: COBALT,
      }],
      children: [],
      weldTargetId: 'vase',
      weldBreakForceN: 12,
      weldBreakHoldSteps: 3,
    },
    {
      id: 'vase_handle_r',
      name: 'vase_handle_r',
      type: 'body',
      pos: [-0.30, -VASE_HANDLE_Y, PEDESTAL_TOP + 0.114],
      joints: [{ name: 'vase_handle_r_free', type: 'free' }],
      geoms: [{
        name: 'vase_handle_r_geom', type: 'capsule',
        fromto: [0, 0, -0.035, 0, 0, 0.035], size: [0.010], mass: 0.08, rgba: COBALT,
      }],
      children: [],
      weldTargetId: 'vase',
      weldBreakForceN: 12,
      weldBreakHoldSteps: 3,
    },

    // --- The steel plate, and the pair of weights above it. Same mass, same
    //     drop, different contact stiffness: one craters it, one does not.
    {
      id: 'plate',
      name: 'plate',
      type: 'body',
      pos: [0.33, 0.34, PLATE_HALF_Z],
      joints: [{ name: 'plate_free', type: 'free' }],
      geoms: [plateGeom()],
      children: [],
    },
    weight('hard_weight', 0.40, true),
    weight('soft_weight', 0.26, false),

    // --- A thin foil sheet on a frame, and a spike dropped through it. The
    //     other end of the same idea as the plate: a surface hit far past what
    //     it can absorb is not creased, it is holed — the material under the
    //     striker is gone rather than pushed aside.
    {
      id: 'foil_frame',
      name: 'foil_frame',
      type: 'body',
      pos: [-0.34, 0.36, 0],
      joints: [],
      geoms: [
        { name: 'foil_leg_a', type: 'box', size: [0.012, 0.012, 0.14], pos: [-0.13, -0.11, 0.14], rgba: FRAME },
        { name: 'foil_leg_b', type: 'box', size: [0.012, 0.012, 0.14], pos: [0.13, -0.11, 0.14], rgba: FRAME },
        { name: 'foil_leg_c', type: 'box', size: [0.012, 0.012, 0.14], pos: [-0.13, 0.11, 0.14], rgba: FRAME },
        { name: 'foil_leg_d', type: 'box', size: [0.012, 0.012, 0.14], pos: [0.13, 0.11, 0.14], rgba: FRAME },
      ],
      children: [],
    },
    {
      id: 'foil',
      name: 'foil',
      type: 'body',
      pos: [-0.34, 0.36, 0.29],
      joints: [{ name: 'foil_free', type: 'free' }],
      geoms: [(() => {
        const { vertices, faces } = slabMesh(0.15, 0.13, 0.004, 30, 26);
        return {
          name: 'foil_geom',
          type: 'mesh' as const,
          size: [1],
          dynamic: true,
          vertices,
          renderVertices: toRenderVertices(vertices),
          faces,
          mass: 8,
          rgba: [0.62, 0.60, 0.55, 1],
          friction: [1.2, 0.01, 0.001],
          /*
           * A wide gap between the two, so there is a real range in which this
           * behaves like a sheet: the spike arrives at roughly 9 N*s and goes
           * clean through, while anything gentler only marks it.
           */
          dentYieldNs: 2,
          dentDepthPerNs: 0.004,
          dentMaxDepth: 0.01,
          pierceImpulseNs: 7,
        };
      })()],
      children: [],
      collision: 'hull',
    },
    {
      id: 'spike',
      name: 'spike',
      type: 'body',
      pos: [-0.34, 0.36, 1.15],
      joints: [{ name: 'spike_free', type: 'free' }],
      geoms: [{
        name: 'spike_geom', type: 'cylinder', size: [0.018, 0.07],
        mass: 4, rgba: STEEL, solref: [0.002, 1], friction: [1, 0.02, 0.002],
      }],
      children: [],
    },

    // --- A shelf bracket, off on its own, with a crumple zone at the root of
    //     its arm: rigid until something too heavy lands on it, then it folds
    //     and STAYS folded. The fourth way a thing here stops being rigid, and
    //     the only one that is neither a break nor a mark.
    //
    //     A cantilever rather than an upright post, and deliberately so: a post
    //     standing straight up gives gravity no lever, so once its base yields
    //     it simply goes on standing there. An arm held out sideways is already
    //     carrying its own weight, and the moment its root gives, that weight
    //     finishes the job.
    //
    //     Set apart from the wrecking ball with its own load, because every
    //     other trigger in this scene is wreckage: debris that clouts the arm
    //     in passing releases the lock and is gone a few milliseconds later,
    //     leaving it released and still straight, and debris that comes to rest
    //     underneath simply props it up.
    {
      id: 'bracket_post',
      name: 'bracket_post',
      type: 'body',
      pos: [0.34, -0.34, 0],
      joints: [],
      geoms: [
        { name: 'bracket_foot', type: 'box', size: [0.06, 0.06, 0.012], pos: [0, 0, 0.012], rgba: FRAME },
        { name: 'bracket_mast', type: 'cylinder', size: [0.016, 0.21], pos: [0, 0, 0.21], rgba: FRAME },
      ],
      children: [
        {
          id: 'bracket_arm',
          name: 'bracket_arm',
          type: 'body',
          // Sits above the mast top (0.42) rather than on it, for the same
          // reason the capsule starts clear of it in x.
          pos: [0, 0, 0.45],
          joints: [{
            name: 'bracket_hinge',
            type: 'hinge',
            axis: [0, 1, 0],
            pos: [0, 0, 0],
            damping: 0.2,
            /*
             * The arm carries about 2.5 N*m of its own weight all day, so six
             * is enough headroom that it never sags on its own — and little
             * enough that the slug landing on its end goes straight through it.
             */
            crumpleTorqueNm: 6,
            // Down and forward: the direction its own weight takes it once the
            // root lets go. Verified against the engine rather than derived —
            // the sign of a hinge's travel depends on the axis AND on which way
            // the arm points off it, and getting it backwards does not look
            // like a backwards fold, it looks like nothing happening at all,
            // because the arm simply sits against the wrong end of its range.
            crumpleRangeDeg: [-80, 0],
            /*
             * Enough damping to settle into the new shape rather than swing
             * into it. Without it the arm reads as a gate coming off its latch
             * instead of as steel taking a set.
             */
            crumpleDampingAfter: 2.5,
          }],
          geoms: [
            /*
             * Starts clear of the mast, not flush against it.
             *
             * A body with no joints is welded to the world, so as far as
             * MuJoCo is concerned this arm's parent IS the world — and the
             * contact filter that normally ignores a body touching its own
             * parent does not apply. An arm whose inner end overlapped the mast
             * was simply propped up by it: the root released, the arm did not
             * move, and the constraint force holding it was a contact rather
             * than the lock. Three-and-a-half centimetres of daylight is enough.
             */
            { name: 'bracket_arm_g', type: 'capsule', fromto: [-0.035, 0, 0, -0.24, 0, 0], size: [0.012], mass: 1.2, rgba: FRAME },
            { name: 'bracket_shelf', type: 'box', size: [0.05, 0.05, 0.006], pos: [-0.20, 0, 0.018], mass: 0.4, rgba: STEEL },
          ],
          children: [],
        },
      ],
    },
    {
      id: 'shelf_load',
      name: 'shelf_load',
      type: 'body',
      pos: [0.14, -0.34, 0.84],
      joints: [{ name: 'shelf_load_free', type: 'free' }],
      geoms: [{
        name: 'shelf_load_geom', type: 'cylinder', size: [0.038, 0.05],
        mass: 3, rgba: LEAD, solref: [0.004, 1], friction: [1, 0.02, 0.002],
      }],
      children: [],
    },
  ],
};
