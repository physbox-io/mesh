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
    };

    const r = opts.recursion;
    // Fewer pieces each time round: a chip of a chip that comes apart into
    // fourteen more is gravel, and it costs a body and a contact pair each.
    const nextPieces = r ? Math.max(2, Math.round(r.pieces / 2)) : 0;
    // `depth` counts how many times pieces may break AGAIN, so the first
    // generation of shards is breakable at depth 1 and final at depth 0.
    const breakable = !!r && r.generation <= Math.min(r.depth, MAX_SHATTER_DEPTH);

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
        shatterPieces: nextPieces,
        shatterPattern: r!.pattern,
        shatterSpread: r!.spread,
        // Offset per shard, so the pieces of two shards do not come apart in
        // exactly the same pattern.
        shatterSeed: (r!.seed ?? 1) + i + 1,
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
