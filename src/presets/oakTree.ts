// ---------------------------------------------------------------------------
// English oak — a tree grown rather than modelled
// ---------------------------------------------------------------------------
//
// The first attempt at this was sculpted: a cylinder waisted into a trunk with
// four strokes pulled out of its shoulder and a green ball on top. It read as
// broccoli. The reason is not resolution — it is that a tree's shape is the
// record of how it grew, and no amount of pushing on a lump reproduces that.
//
// So this one branches. A trunk forks into limbs, limbs fork into boughs,
// boughs into branches, and the rule at every fork is the one real trees follow:
// the cross-sections of the children add up to the cross-section of the parent,
// so a limb that splits in two drops to about seven tenths of its radius rather
// than half. That single rule is what makes the taper look right.
//
// What makes it an OAK rather than a generic tree:
//   - a short, very stout trunk that forks low, at about a third of the height;
//   - first-order limbs that leave almost horizontally and only turn up later,
//     which is the candelabra silhouette an open-grown oak is known for;
//   - a crown slightly wider than the tree is tall;
//   - heavy sinuosity: oak branches wander, they do not run straight;
//   - foliage in discrete clumps at the ends of the twigs, not a single ball —
//     an oak crown reads as a pile of cauliflower florets with sky between them.
//
// Everything is seeded, so the tree is the same tree every time it loads.
// ---------------------------------------------------------------------------

import type { SceneGraph } from '../types/scene';
// The same deterministic PRNG the surface pattern generators use; it started
// here, and now has one home.
import { mulberry32 } from '../utils/patternNoise';

type Vec = [number, number, number];

const add = (a: Vec, b: Vec): Vec => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: Vec, k: number): Vec => [a[0] * k, a[1] * k, a[2] * k];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const len = (a: Vec) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: Vec): Vec => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Turn `v` towards `target` by `t`, renormalised. Used to bend a limb upward. */
const towards = (v: Vec, target: Vec, t: number): Vec =>
  norm([v[0] + (target[0] - v[0]) * t, v[1] + (target[1] - v[1]) * t, v[2] + (target[2] - v[2]) * t]);

/** A frame perpendicular to `axis`, picked so it never degenerates. */
function basis(axis: Vec): [Vec, Vec] {
  const ref: Vec = Math.abs(axis[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
  const u = norm(cross(axis, ref));
  return [u, cross(axis, u)];
}

interface MeshBuild { positions: number[]; faces: number[] }

/**
 * A tenth of a millimetre, which is finer than any tree needs.
 *
 * Full double precision writes coordinates like -2.6998304900677224, and a
 * scene is stored and sent as JSON: at 33,000 vertices that is megabytes of
 * digits nobody can see, and it is enough on its own to overflow the browser
 * storage a saved preset lives in.
 */
const q = (v: number) => Math.round(v * 1e4) / 1e4;

const emptyMesh = (): MeshBuild => ({ positions: [], faces: [] });

/**
 * ONE branch, as a single closed solid.
 *
 * This replaced a per-segment tube builder, and the reason is printing. That
 * version emitted every sub-segment as its own open-ended cylinder: consecutive
 * segments abutted without sharing a vertex and nothing was ever capped, so the
 * trunk alone contributed thousands of boundary edges. On screen it looked
 * perfect — the seams are hidden inside opaque geometry — and in a slicer it was
 * a soup of open tubes, which is the classic way to get a model that renders
 * beautifully and prints as shredded wheat.
 *
 * So a branch is now skinned in one pass: one ring of vertices per station,
 * quads between consecutive rings, and a fan cap at each end. No boundary edges,
 * no degenerate triangles, and the union of the branches is a solid because each
 * child starts buried inside its parent rather than merely touching it.
 *
 * The frame is rotation-minimising — each ring's reference vector is the last
 * one with the new tangent projected out, rather than rebuilt from scratch — so
 * the skin does not spiral where the branch curves.
 */
function addChain(out: MeshBuild, stations: { p: Vec; r: number }[], sides: number) {
  if (stations.length < 2) return;
  const n = stations.length;

  const tangents: Vec[] = [];
  for (let i = 0; i < n; i++) {
    const a = stations[Math.max(0, i - 1)].p;
    const b = stations[Math.min(n - 1, i + 1)].p;
    const t = sub(b, a);
    tangents.push(len(t) < 1e-9 ? [0, 0, 1] : norm(t));
  }

  const base = out.positions.length / 3;
  let u = basis(tangents[0])[0];
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      const t = tangents[i];
      const d = u[0] * t[0] + u[1] * t[1] + u[2] * t[2];
      const projected: Vec = [u[0] - t[0] * d, u[1] - t[1] * d, u[2] - t[2] * d];
      u = len(projected) < 1e-6 ? basis(t)[0] : norm(projected);
    }
    const v = cross(tangents[i], u);
    const { p, r } = stations[i];
    for (let sIdx = 0; sIdx < sides; sIdx++) {
      const th = (sIdx / sides) * Math.PI * 2;
      const c = Math.cos(th), sn = Math.sin(th);
      out.positions.push(
        q(p[0] + (u[0] * c + v[0] * sn) * r),
        q(p[1] + (u[1] * c + v[1] * sn) * r),
        q(p[2] + (u[2] * c + v[2] * sn) * r),
      );
    }
  }

  for (let i = 0; i < n - 1; i++) {
    for (let sIdx = 0; sIdx < sides; sIdx++) {
      const s1 = (sIdx + 1) % sides;
      const a0 = base + i * sides + sIdx, a1 = base + i * sides + s1;
      const b0 = base + (i + 1) * sides + sIdx, b1 = base + (i + 1) * sides + s1;
      out.faces.push(a0, a1, b1, a0, b1, b0);
    }
  }

  // The two caps. Wound opposite ways, because they face opposite ways.
  const startCentre = out.positions.length / 3;
  out.positions.push(q(stations[0].p[0]), q(stations[0].p[1]), q(stations[0].p[2]));
  for (let sIdx = 0; sIdx < sides; sIdx++) {
    const s1 = (sIdx + 1) % sides;
    out.faces.push(startCentre, base + s1, base + sIdx);
  }
  const last = n - 1;
  const endCentre = out.positions.length / 3;
  out.positions.push(q(stations[last].p[0]), q(stations[last].p[1]), q(stations[last].p[2]));
  for (let sIdx = 0; sIdx < sides; sIdx++) {
    const s1 = (sIdx + 1) % sides;
    out.faces.push(endCentre, base + last * sides + sIdx, base + last * sides + s1);
  }
}

/**
 * A lumpy ball of leaves, closed.
 *
 * The poles are single vertices with a triangle fan round each, not a ring of
 * coincident ones: a UV sphere built the naive way leaves a ring of duplicated
 * points at each pole, which is both an open rim and a row of zero-area
 * triangles — two more things a slicer has no idea what to do with.
 */
function addBlob(out: MeshBuild, centre: Vec, radius: number, squash: Vec, rnd: () => number) {
  const RINGS = 4, SECTORS = 7;
  const base = out.positions.length / 3;
  // Radius wobbles per vertex: foliage has no smooth surface, and it is the
  // cheapest thing that stops a clump reading as a sphere.
  const wobble = () => radius * (0.78 + rnd() * 0.44);

  const top = wobble();
  out.positions.push(q(centre[0]), q(centre[1]), q(centre[2] + top * squash[2]));
  for (let r = 1; r <= RINGS; r++) {
    const phi = (r / (RINGS + 1)) * Math.PI;
    for (let sIdx = 0; sIdx < SECTORS; sIdx++) {
      const th = (sIdx / SECTORS) * Math.PI * 2;
      const k = wobble();
      out.positions.push(
        q(centre[0] + Math.sin(phi) * Math.cos(th) * k * squash[0]),
        q(centre[1] + Math.sin(phi) * Math.sin(th) * k * squash[1]),
        q(centre[2] + Math.cos(phi) * k * squash[2]),
      );
    }
  }
  const bottomR = wobble();
  const bottom = out.positions.length / 3;
  out.positions.push(q(centre[0]), q(centre[1]), q(centre[2] - bottomR * squash[2]));

  // Wound for rings that run from the TOP down, which is the direction phi
  // increases. Using the tube's winding here would turn every clump inside out —
  // invisible on screen under the renderer's lighting, and a solid a slicer
  // reads as a hole.
  const ring = (r: number, sIdx: number) => base + 1 + (r - 1) * SECTORS + (sIdx % SECTORS);
  for (let sIdx = 0; sIdx < SECTORS; sIdx++) {
    out.faces.push(base, ring(1, sIdx), ring(1, sIdx + 1));
  }
  for (let r = 1; r < RINGS; r++) {
    for (let sIdx = 0; sIdx < SECTORS; sIdx++) {
      const a0 = ring(r, sIdx), a1 = ring(r, sIdx + 1);
      const b0 = ring(r + 1, sIdx), b1 = ring(r + 1, sIdx + 1);
      out.faces.push(a0, b1, a1, a0, b0, b1);
    }
  }
  for (let sIdx = 0; sIdx < SECTORS; sIdx++) {
    out.faces.push(bottom, ring(RINGS, sIdx + 1), ring(RINGS, sIdx));
  }
}

/** How far a limb wanders off its heading over one segment. */
const WANDER = 0.30;

interface GrowOpts {
  wood: MeshBuild;
  leaf: MeshBuild;
  rnd: () => number;
  /** Where each leaf clump sits and which twig it hangs on, for the print check. */
  foliage: { centre: Vec; radius: number; tip: Vec }[];
}

/**
 * Grow one branch and everything that comes off it.
 *
 * `upBias` is what turns an oak into an oak: the first-order limbs leave the
 * trunk nearly level and are given almost no upward pull, so they reach outward
 * and sag; every generation after them is pulled harder towards vertical, so the
 * outer crown rises. Do it the other way round and you get a poplar.
 */
function grow(
  o: GrowOpts,
  from: Vec,
  dir: Vec,
  length: number,
  radius: number,
  depth: number,
  upBias: number,
) {
  // Thin enough to be a twig: finish with a clump of leaves rather than more wood.
  if (depth === 0 || radius < 0.011) {
    const spread = 0.42 + o.rnd() * 0.22;
    const clumps = 1 + Math.floor(o.rnd() * 2);
    for (let i = 0; i < clumps; i++) {
      const blobR = spread * (0.62 + o.rnd() * 0.46);
      /*
       * The clump is offset from the twig, but never far enough to leave it.
       *
       * Offsetting by the clump's SPREAD, as this did, let the far corner of the
       * random cube exceed the clump's own radius, so some clumps floated with
       * no wood inside them at all. On screen a leaf clump hanging in space
       * beside a twig reads as foliage; on a print bed it is an island with
       * nothing under it. Bounding the offset to 0.26 of the radius keeps the
       * twig tip inside the clump even when all three axes are at their limit.
       */
      const reach = blobR * 0.26;
      const jitter: Vec = [
        (o.rnd() - 0.5) * 2 * reach,
        (o.rnd() - 0.5) * 2 * reach,
        (o.rnd() - 0.5) * 2 * reach * 0.6,
      ];
      o.foliage.push({ centre: add(from, jitter), radius: blobR, tip: from });
      addBlob(o.leaf, add(from, jitter), blobR, [1, 1, 0.88], o.rnd);
    }
    return;
  }

  // The branch, walked out in four steps so it can curve, and collected as
  // STATIONS rather than drawn as it goes: the whole branch is skinned in one
  // piece afterwards, which is what keeps it closed.
  const STEPS = 4;
  let p = from;
  let d = dir;
  let r = radius;
  const stepLen = length / STEPS;
  // 0.78 over the whole branch, not 0.62: too fast a taper and the tree runs
  // out of wood after three forks, which is a shrub.
  const taper = Math.pow(0.78, 1 / STEPS);
  // The first station is set BACK along the branch, so its end cap sits buried
  // inside the parent instead of on its surface. Two closed solids that merely
  // touch are two objects; two that overlap are one, and a slicer unions them
  // without being asked.
  const stations: { p: Vec; r: number }[] = [
    { p: add(from, mul(dir, -radius * 1.6)), r },
    { p: from, r },
  ];
  for (let i = 0; i < STEPS; i++) {
    d = towards(d, [0, 0, 1], upBias / STEPS);
    d = norm([
      d[0] + (o.rnd() - 0.5) * WANDER / STEPS,
      d[1] + (o.rnd() - 0.5) * WANDER / STEPS,
      d[2] + (o.rnd() - 0.5) * WANDER / STEPS * 0.6,
    ]);
    const next = add(p, mul(d, stepLen));
    const rNext = r * taper;
    stations.push({ p: next, r: rNext });
    p = next;
    r = rNext;
  }
  addChain(o.wood, stations, depth > 4 ? 8 : depth > 2 ? 6 : 4);

  // The fork. Two children usually, three now and then — and the radii are set
  // so their cross-sections add up to the parent's, which is what makes the
  // taper of a real tree.
  const kids = o.rnd() < 0.25 ? 3 : 2;
  const childR = r * Math.pow(1 / kids, 1 / 2.2);
  const [u, v] = basis(d);
  const roll = o.rnd() * Math.PI * 2;
  for (let i = 0; i < kids; i++) {
    const th = roll + (i / kids) * Math.PI * 2 + (o.rnd() - 0.5) * 0.5;
    // Wide forks low in the tree, tighter ones out at the twigs.
    const spreadAngle = (0.62 + o.rnd() * 0.28) * (depth / 6);
    const side = add(mul(u, Math.cos(th)), mul(v, Math.sin(th)));
    const childDir = norm(add(mul(d, Math.cos(spreadAngle)), mul(side, Math.sin(spreadAngle))));
    grow(
      o,
      p,
      childDir,
      length * (0.68 + o.rnd() * 0.12),
      childR * (0.92 + o.rnd() * 0.16),
      depth - 1,
      Math.min(0.72, upBias + 0.20),
    );
  }
}

/** Builds the tree in Z-up metres and hands back both meshes. */
export function buildOakTree(seed = 20260913) {
  const rnd = mulberry32(seed);
  const o: GrowOpts = { wood: emptyMesh(), leaf: emptyMesh(), rnd, foliage: [] };

  // The bole. Stout, tapering, and flaring hard into the ground over the lowest
  // 400 mm — the buttress is the most recognisable thing about an old oak at
  // eye level, and a trunk that meets the ground as a plain cylinder looks
  // pushed into it like a pencil.
  const FORK_HEIGHT = 1.75;
  const BASE_R = 0.25, FLARE_R = 0.44, FORK_R = 0.185;
  const TRUNK_STEPS = 7;
  // Flare over the bottom half-metre, then an ordinary taper above it.
  const rAt = (t: number) => {
    const z = t * FORK_HEIGHT;
    const flare = z < 0.5 ? (FLARE_R - BASE_R) * Math.pow(1 - z / 0.5, 2.0) : 0;
    return BASE_R + flare - (BASE_R - FORK_R) * t;
  };
  // Even the trunk leans a little; a plumb-straight bole reads as a post.
  const trunkAt = (t: number): Vec => [
    Math.sin(t * 1.4) * 0.055,
    Math.sin(t * 2.1 + 1.0) * 0.045,
    t * FORK_HEIGHT,
  ];
  const trunk: { p: Vec; r: number }[] = [];
  for (let i = 0; i <= TRUNK_STEPS; i++) {
    const t = i / TRUNK_STEPS;
    trunk.push({ p: trunkAt(t), r: rAt(t) });
  }
  // The bole is one closed solid from the ground to the fork, capped at both
  // ends. The bottom cap is what lets it sit flat on a print bed.
  addChain(o.wood, trunk, 10);
  const p = trunk[trunk.length - 1].p;

  // Five primary limbs, leaving over a range of heights rather than all from one
  // whorl — everything coming off a single point is what makes a tree look like
  // a palm. They leave nearly level (upBias 0.06) and reach out before rising.
  const LIMBS = 6;
  const roll = 0.7;
  for (let i = 0; i < LIMBS; i++) {
    const th = roll + (i / LIMBS) * Math.PI * 2 + (rnd() - 0.5) * 0.55;
    const drop = (rnd() - 0.2) * 0.45;
    const startZ = FORK_HEIGHT - drop;
    const start: Vec = [p[0] * 0.8, p[1] * 0.8, startZ];
    // Elevation of 20-40 degrees off horizontal at the shoulder.
    const elev = 0.35 + rnd() * 0.35;
    const dir = norm([Math.cos(th) * Math.cos(elev), Math.sin(th) * Math.cos(elev), Math.sin(elev)]);
    grow(o, start, dir, 1.02 + rnd() * 0.34, FORK_R * (0.60 + rnd() * 0.14), 6, 0.12);
  }

  return o;
}

/**
 * Z-up build coordinates to the Y-up world space a mesh geom's `vertices` are
 * in: (x, y, z) -> (x, z, -y).
 */
function toYup(zup: number[]): number[] {
  const out = new Array<number>(zup.length);
  for (let i = 0; i < zup.length; i += 3) {
    out[i] = zup[i];
    out[i + 1] = zup[i + 2];
    out[i + 2] = -zup[i + 1];
  }
  return out;
}

export const oakTreePreset: SceneGraph = (() => {
  const { wood, leaf } = buildOakTree();
  return {
    nodes: [{
      id: 'oak_tree',
      name: 'Oak Tree',
      type: 'body',
      // No joint: a tree stands where it grew. Scenery, so neither mesh
      // collides — the convex hull of a tree is a dome nothing should bump into.
      // Give it a joint and the store turns collision back on, because a body
      // that can move and cannot touch anything only falls through the floor.
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        {
          name: 'oak_wood',
          type: 'mesh',
          size: [1],
          rgba: [0.33, 0.26, 0.20, 1],
          // Green oak, in kg/m3. The trunk and limbs come to 0.87 m3, so the
          // timber of this tree weighs about 600kg — which, with the crown
          // below, is what decides how it stands and how it goes over.
          density: 700,
          contype: 0,
          conaffinity: 0,
          vertices: toYup(wood.positions),
          renderVertices: wood.positions,
          faces: wood.faces,
        },
        {
          name: 'oak_foliage',
          type: 'mesh',
          size: [1],
          rgba: [0.25, 0.42, 0.18, 1],
          // The clumps enclose 100 m3, and a crown is very nearly all air: the
          // leaves of a mature oak are a couple of hundred kilos spread through
          // it. Left at the default 1000 the canopy alone weighed 100 TONNES
          // and dragged the centre of mass up into the branches, which is what
          // made the tree behave like a top-heavy dome of water the moment it
          // was made movable.
          density: 3,
          contype: 0,
          conaffinity: 0,
          vertices: toYup(leaf.positions),
          renderVertices: leaf.positions,
          faces: leaf.faces,
        },
      ],
      children: [],
    }],
  } as unknown as SceneGraph;
})();
