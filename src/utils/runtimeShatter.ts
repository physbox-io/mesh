// Turning a body that has just been hit into the pieces of a body.
//
// The pieces are ordinary SceneNodes — a free joint and one mesh geom each — so
// nothing downstream needs to know they are shards. They render, collide, get
// picked and get exported exactly like anything else. What makes them transient
// is WHERE they live: the store keeps them in a runtime overlay graph, never in
// the document, so the saved scene still contains the whole vase and Reset gets
// it back. See `runtimeGraph` in the store.
//
// Two things here are less obvious than they look.
//
// The first is the frame. A cell comes out of utils/fracture.ts in the source
// mesh's own vertex space, and MuJoCo recentres every mesh on its volume
// centroid, so a shard's offset from the body's origin is (cell centroid -
// mesh centroid) rotated into the world. Getting that wrong does not look like
// an offset — it looks like the vase teleporting a few centimetres as it breaks.
//
// The second is the velocity. A shard does not inherit the body's velocity: it
// inherits the velocity OF THE POINT IT WAS, which is v + w x r. Without the
// cross-product term a spinning body shatters into pieces that all drift the
// same way and the spin vanishes, which reads as the pieces being glued to an
// invisible frame. That velocity rides out on the free joint's initialVelocity,
// which the worker's build already applies by joint name — no new machinery.

import type { FractureCell } from './fracture';
import type { SceneGeom, SceneNode } from '../types/scene';

/** Where the body was, and how it was moving, when it broke. All MuJoCo Z-up. */
export interface ShatterFrame {
  /** World position of the body frame (MuJoCo's recentred origin). */
  pos: [number, number, number];
  /** Body orientation as a row-major 3x3, straight out of `data.xmat`. */
  xmat: number[];
  vel: [number, number, number];
  angvel: [number, number, number];
}

/** Hard ceiling on how many times pieces may break again. See SceneNode.shatterDepth. */
export const MAX_SHATTER_DEPTH = 2;

/**
 * The most shards that may be in the world at once, across every break.
 *
 * Stepping cost is set by contacts, and contacts grow with the body count, not
 * with anything a break does. Measured on the Shatter vase: fourteen shards
 * step in 0.6 ms of every simulated millisecond, which is real time; letting
 * each of those come apart into seven more (95 bodies) cost 6 to 16 ms, so the
 * cascade ran in slow motion. The store cuts fewer pieces, or none, rather
 * than go over this.
 */
export const MAX_LIVE_SHARDS = 60;

/**
 * A shard smaller than this share of what broke is final however deep the
 * recursion runs: breaking dust into more dust is a body per grain and nothing
 * anyone can see.
 */
const MIN_BREAKABLE_SHARE = 0.02;

/**
 * Collision-hull corners kept per shard. A Voronoi cell averages about 25, and
 * mesh-on-mesh collision costs per corner; at 12 a settled heap of 95 chips
 * stepped 2.5 times faster, with no difference anyone can see at that size.
 */
const SHARD_HULL_VERTS = 12;

/**
 * Contact bits for a final-generation chip.
 *
 * MuJoCo lets two geoms collide when `(contype1 & conaffinity2) ||
 * (contype2 & conaffinity1)`. Everything else keeps the default 1/1, so a
 * chip (2/1) still lands on the floor and on other bodies, but two chips never
 * test against each other: 2&1 and 2&1 are both zero.
 *
 * This is the single largest cost in a cascade. Voronoi cells share their
 * faces exactly, so every chip is born pressed flat against its siblings, and
 * resolving that heap of face-to-face contacts took 15 ms a step. Without chip
 * contact the same burst took 1.4 ms. It is limited to the second generation
 * and beyond: the first pieces of a vase are large enough that seeing them
 * pass through one another would be noticed, and there are few enough of them
 * to afford.
 */
const CHIP_CONTYPE = 2;
const CHIP_CONAFFINITY = 1;

export interface ShatterOptions {
  /** Extra outward speed given to each shard, m/s. Sells the burst. */
  spread?: number;
  /**
   * Make the pieces breakable in their turn.
   *
   * Each shard gets a threshold scaled by its share of the body, because the
   * alternative reads as armour plating: a chip weighing a fourteenth of the
   * vase, held to the vase's own threshold, can hardly ever be hit hard enough
   * and simply bounces. Scaled, it breaks when it lands, which is what
   * porcelain does.
   */
  recursion?: {
    /** The generation these shards belong to. */
    generation: number;
    /** The authored ceiling. */
    depth: number;
    impulseNs: number;
    /** The wall `impulseNs` is rated for; see shatterLimit in breakThresholds.ts. */
    thicknessRef?: number;
    pieces: number;
    pattern?: 'uniform' | 'radial';
    spread?: number;
    seed?: number;
  };
  /** Mass of the body that broke, split between shards by volume. */
  totalMass?: number;
  rgba?: number[];
  friction?: number[];
  solref?: number[];
  solimp?: number[];
}

export interface ShatterResult {
  shards: SceneNode[];
  /** Ids of the bodies the shards replace, so the caller can drop them. */
  replacedNodeId: string;
}

/**
 * The volume centroid of a closed mesh — the point MuJoCo will put the body
 * origin on. Duplicated from csg.meshVolumeAndCentroid deliberately: csg.ts
 * pulls in three.js and the ConvexHull addon, and this is four lines of
 * arithmetic that the shatter path should not drag that in for.
 */
export function volumeCentroid(verts: number[], faces: number[]): { volume: number; centroid: [number, number, number] } {
  let vol = 0, cx = 0, cy = 0, cz = 0;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
    const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
    const cxx = verts[c], cyy = verts[c + 1], czz = verts[c + 2];
    const d = ax * (by * czz - bz * cyy) - ay * (bx * czz - bz * cxx) + az * (bx * cyy - by * cxx);
    vol += d;
    cx += (ax + bx + cxx) * d;
    cy += (ay + by + cyy) * d;
    cz += (az + bz + czz) * d;
  }
  if (Math.abs(vol) < 1e-15) return { volume: 0, centroid: [0, 0, 0] };
  return { volume: vol / 6, centroid: [cx / (4 * vol), cy / (4 * vol), cz / (4 * vol)] };
}

/** Rotate a body-local vector into the world by a row-major `data.xmat`. */
export function rotate(xmat: number[], v: [number, number, number]): [number, number, number] {
  return [
    xmat[0] * v[0] + xmat[1] * v[1] + xmat[2] * v[2],
    xmat[3] * v[0] + xmat[4] * v[1] + xmat[5] * v[2],
    xmat[6] * v[0] + xmat[7] * v[1] + xmat[8] * v[2],
  ];
}

/** A row-major 3x3 as the [w,x,y,z] quaternion a SceneNode carries. */
export function matToQuat(m: number[]): [number, number, number, number] {
  const trace = m[0] + m[4] + m[8];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return [s / 4, (m[7] - m[5]) / s, (m[2] - m[6]) / s, (m[3] - m[1]) / s];
  }
  if (m[0] > m[4] && m[0] > m[8]) {
    const s = Math.sqrt(1 + m[0] - m[4] - m[8]) * 2;
    return [(m[7] - m[5]) / s, s / 4, (m[1] + m[3]) / s, (m[2] + m[6]) / s];
  }
  if (m[4] > m[8]) {
    const s = Math.sqrt(1 + m[4] - m[0] - m[8]) * 2;
    return [(m[2] - m[6]) / s, (m[1] + m[3]) / s, s / 4, (m[5] + m[7]) / s];
  }
  const s = Math.sqrt(1 + m[8] - m[0] - m[4]) * 2;
  return [(m[3] - m[1]) / s, (m[2] + m[6]) / s, (m[5] + m[7]) / s, s / 4];
}

/** A [w,x,y,z] quaternion as a row-major 3x3. */
export function quatToMat(q: ArrayLike<number>): number[] {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  const w = q[0] / n, x = q[1] / n, y = q[2] / n, z = q[3] / n;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
  ];
}

function quatMul(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number, number] {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

const cross = (a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number] =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** The transpose of a row-major 3x3 applied to v: world to local. */
const unrotate = (m: number[], v: ArrayLike<number>): [number, number, number] => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

/** Where the broken body's free joint is NOW, straight out of qpos/qvel. */
export interface FreeJointState {
  /** qpos[0..3]: world position. */
  pos: ArrayLike<number>;
  /** qpos[3..7]: orientation, [w,x,y,z]. */
  quat: ArrayLike<number>;
  /** qvel[0..3]: linear velocity, world frame. */
  vel: ArrayLike<number>;
  /** qvel[3..6]: angular velocity, in the BODY's frame, as MuJoCo keeps it. */
  angvelLocal: ArrayLike<number>;
}

/**
 * A shard's free-joint qpos and qvel, re-based onto its parent's current pose.
 *
 * The shard was placed for the instant of the break. Its model is built later
 * — a coalescing window, then a compile, then the worker's build — and the old
 * model goes on stepping all the while. Measured on the Shatter preset, the vase
 * had been knocked 0.75 m by the time its pieces arrived, which read as the vase
 * vanishing and its pieces appearing out of nowhere where it used to be.
 *
 * So the shard keeps its place and motion RELATIVE to the parent: the same
 * offset, turned by however much the parent has turned since, and the velocity
 * of that point of the parent now (v + w x r), plus the outward spread it was
 * given, turned the same way.
 */
export function rebaseShard(
  shard: { pos: ArrayLike<number>; quat: ArrayLike<number>; initialVelocity?: ArrayLike<number> },
  from: NonNullable<SceneNode['shatterFrom']>,
  now: FreeJointState,
): { qpos: number[]; qvel: number[] } {
  const rNow = quatToMat(now.quat);
  const qDelta = quatMul(now.quat, [from.quat[0], -from.quat[1], -from.quat[2], -from.quat[3]]);
  const rDelta = quatToMat(qDelta);

  const rOld: [number, number, number] = [shard.pos[0] - from.pos[0], shard.pos[1] - from.pos[1], shard.pos[2] - from.pos[2]];
  const rNew = rotate(rDelta, rOld);
  const quat = quatMul(qDelta, shard.quat);

  // What the shard was given on top of the point velocity it inherited: the
  // outward spread. Kept, and turned with the body.
  const init = shard.initialVelocity ?? [0, 0, 0, 0, 0, 0];
  const inherited = cross(from.angvel, rOld);
  const extra = rotate(rDelta, [
    init[0] - from.vel[0] - inherited[0],
    init[1] - from.vel[1] - inherited[1],
    init[2] - from.vel[2] - inherited[2],
  ]);

  const wWorld = rotate(rNow, [now.angvelLocal[0], now.angvelLocal[1], now.angvelLocal[2]]);
  const spin = cross(wWorld, rNew);
  // A free joint's angular velocity is in the body's own frame.
  const wLocal = unrotate(quatToMat(quat), wWorld);

  return {
    qpos: [now.pos[0] + rNew[0], now.pos[1] + rNew[1], now.pos[2] + rNew[2], ...quat],
    qvel: [
      now.vel[0] + spin[0] + extra[0],
      now.vel[1] + spin[1] + extra[1],
      now.vel[2] + spin[2] + extra[2],
      ...wLocal,
    ],
  };
}

/** MuJoCo Z-up back to the Three.js Y-up a SceneGeom stores in `vertices`. */
export function zupToYup(verts: number[]): number[] {
  const out = new Array(verts.length);
  for (let i = 0; i < verts.length; i += 3) {
    out[i] = verts[i];
    out[i + 1] = verts[i + 2];
    out[i + 2] = -verts[i + 1];
  }
  return out;
}

/**
 * Build the bodies that replace `node` once it has shattered.
 *
 * `cells` are in the same space as `sourceRenderVertices` — MuJoCo Z-up, as the
 * geom stores them. `frame` is where the body actually is right now, which is
 * not where the document says it is: it has been falling for a second.
 */
export function buildShatterGraph(
  node: SceneNode,
  sourceRenderVertices: number[],
  sourceFaces: number[],
  cells: FractureCell[],
  frame: ShatterFrame,
  opts: ShatterOptions = {},
): ShatterResult {
  const { centroid: meshCentroid } = volumeCentroid(sourceRenderVertices, sourceFaces);
  const totalVolume = cells.reduce((s, c) => s + c.volume, 0) || 1;
  const totalMass = opts.totalMass && opts.totalMass > 0 ? opts.totalMass : 1;
  const spread = opts.spread ?? 0;
  const quat = matToQuat(frame.xmat);
  // The body's own free joint, so the worker can find where it has got to by
  // the time the shards are built. See `rebaseShard`.
  const parentJoint = node.joints?.find((j) => j.type === 'free')?.name;

  const shards: SceneNode[] = cells.map((cell, i) => {
    // Where this piece sits relative to the body origin MuJoCo is tracking.
    const rLocal: [number, number, number] = [
      cell.centroid[0] - meshCentroid[0],
      cell.centroid[1] - meshCentroid[1],
      cell.centroid[2] - meshCentroid[2],
    ];
    const rWorld = rotate(frame.xmat, rLocal);
    const pos: [number, number, number] = [
      frame.pos[0] + rWorld[0],
      frame.pos[1] + rWorld[1],
      frame.pos[2] + rWorld[2],
    ];

    // v + w x r: the velocity of the point this shard used to be, not of the
    // body's origin. This is what carries the spin through the break.
    const [wx, wy, wz] = frame.angvel;
    let vx = frame.vel[0] + (wy * rWorld[2] - wz * rWorld[1]);
    let vy = frame.vel[1] + (wz * rWorld[0] - wx * rWorld[2]);
    let vz = frame.vel[2] + (wx * rWorld[1] - wy * rWorld[0]);

    if (spread > 0) {
      const len = Math.hypot(rWorld[0], rWorld[1], rWorld[2]);
      if (len > 1e-9) {
        vx += (rWorld[0] / len) * spread;
        vy += (rWorld[1] / len) * spread;
        vz += (rWorld[2] / len) * spread;
      }
    }

    // Each shard's mesh is recentred on its own centroid, so its vertices are
    // about its own origin the way every other mesh geom's are.
    const local = new Array(cell.verts.length);
    for (let v = 0; v < cell.verts.length; v += 3) {
      local[v] = cell.verts[v] - cell.centroid[0];
      local[v + 1] = cell.verts[v + 1] - cell.centroid[1];
      local[v + 2] = cell.verts[v + 2] - cell.centroid[2];
    }

    /*
     * The id and the name have to be THE SAME STRING.
     *
     * MJCF names a body from `node.name` (mjcf.ts: `node.name || node.id`),
     * while the renderer looks that body up with
     * `mj_name2id(model, mjOBJ_BODY, nodeId)` — by node ID. Every preset in the
     * repo happens to set the two to the same value, so nothing had ever
     * exercised the difference. Shards with an id of `vase__shard0` and a name
     * of `vase_shard0` resolved to body -1, and a dynamic mesh geom with no
     * body falls back to the identity transform: the whole vase reappeared as a
     * heap of pieces at the world origin, half of it under the floor.
     */
    const name = `${node.name}_shard${i}`;
    const r = opts.recursion;
    // A shard of a shard: small, many, and born face to face with its siblings.
    const isChip = !!r && r.generation >= 2;
    const geom: SceneGeom = {
      name: `${name}_geom`,
      type: 'mesh',
      size: [1],
      dynamic: true,
      renderVertices: local,
      vertices: zupToYup(local),
      faces: cell.faces.slice(),
      mass: (totalMass * cell.volume) / totalVolume,
      rgba: opts.rgba ? [...opts.rgba] : undefined,
      friction: opts.friction ? [...opts.friction] : undefined,
      solref: opts.solref ? [...opts.solref] : undefined,
      solimp: opts.solimp ? [...opts.solimp] : undefined,
      maxHullVert: SHARD_HULL_VERTS,
      stableMesh: true,
      ...(isChip ? { contype: CHIP_CONTYPE, conaffinity: CHIP_CONAFFINITY } : {}),
    };

    // Far fewer pieces each time round: a chip of a chip that comes apart
    // into seven more is gravel, and it costs a body and contacts each. A
    // third, capped at four, keeps a second-generation break reading as a
    // break without multiplying the body count by seven.
    const nextPieces = r ? Math.max(2, Math.min(4, Math.round(r.pieces / 3))) : 0;
    // `depth` counts how many times pieces may break AGAIN, so the first
    // generation of shards is breakable at depth 1 and final at depth 0.
    const breakable = !!r
      && r.generation <= Math.min(r.depth, MAX_SHATTER_DEPTH)
      && cell.volume / totalVolume >= MIN_BREAKABLE_SHARE;

    return {
      id: name,
      name,
      type: 'body',
      pos,
      quat,
      ...(breakable ? {
        shatterGeneration: r!.generation,
        shatterDepth: r!.depth,
        shatterImpulseNs: r!.impulseNs * (cell.volume / totalVolume),
        shatterThicknessRef: r!.thicknessRef,
        shatterPieces: nextPieces,
        shatterPattern: r!.pattern,
        shatterSpread: r!.spread,
        // Offset per shard, so the pieces of two shards do not come apart in
        // exactly the same pattern.
        shatterSeed: (r!.seed ?? 1) + i + 1,
      } : {}),
      ...(parentJoint ? {
        shatterFrom: {
          joint: parentJoint,
          pos: [frame.pos[0], frame.pos[1], frame.pos[2]],
          quat,
          vel: [frame.vel[0], frame.vel[1], frame.vel[2]],
          angvel: [frame.angvel[0], frame.angvel[1], frame.angvel[2]],
        },
      } : {}),
      geoms: [geom],
      joints: [{
        name: `${name}_free`,
        type: 'free',
        initialVelocity: [vx, vy, vz, wx, wy, wz],
      }],
      children: [],
      // A shard is convex by construction, so hulling it is exact and
      // decomposing it would only buy contact pairs.
      collision: 'hull',
    };
  });

  return { shards, replacedNodeId: node.id };
}
