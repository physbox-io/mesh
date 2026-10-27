// What a joint is made of: putty, glue, a marshmallow.
//
// A join blob is an ordinary body with an ellipsoid geom and `joinMaterial`
// set. The compiler welds every part that reaches into it (see
// utils/breakModel.ts), and this table is what those welds can carry.
//
// One number does most of the work: how much shear a square millimetre of the
// stuff holds against what is stuck into it. A rod pulled out of a blob slides
// along everything it is buried in, so the pull it survives is that shear over
// the rod's buried surface — and a blob twice the size buries twice the rod and
// holds twice the pull, which is exactly how putty joints behave in the hand.
//
// The other is whether it turns. Glue and epoxy hold rigid and then let go
// all at once. Putty and marshmallow hardly resist turning at all: a rod in
// them is on a pin, held until it is pulled out or pushed out sideways. A
// triangle of pins still stands and a square of them folds, which is the whole
// lesson of a spaghetti tower.
//
// PURE: no store, no MuJoCo. The physics worker never reads it; the limits it
// computes travel inside the compiled model.

import type { SceneNode } from '../types/scene';

export type JoinMaterialId = 'putty' | 'marshmallow' | 'hotGlue' | 'pva' | 'epoxy';

export interface JoinMaterial {
  id: JoinMaterialId;
  label: string;
  /** kg/m3, for the blob's own weight. */
  density: number;
  rgba: [number, number, number, number];
  /** Shear strength against what is stuck into it, kPa. */
  shearKPa: number;
  /** True: holds what is in it on a pin, until pulled out. False: rigid until it lets go. */
  yields: boolean;
  /** One line, for the dropdown's tooltip. */
  note: string;
}

// Shear strengths are for dry spaghetti pushed in: a 1.8 mm strand 5 mm deep
// in putty pulls out at about half a newton, in a marshmallow at a tenth of
// that, and out of hot glue only by snapping the pasta first.
export const JOIN_MATERIALS: JoinMaterial[] = [
  {
    id: 'putty', label: 'Putty / plasticine', density: 1800, rgba: [0.35, 0.62, 0.9, 1],
    shearKPa: 50, yields: true,
    note: 'Holds a rod but lets it turn, like a pin. Triangles stand; squares fold.',
  },
  {
    id: 'marshmallow', label: 'Marshmallow', density: 250, rgba: [0.97, 0.95, 0.9, 1],
    shearKPa: 12, yields: true,
    note: 'Like putty, but holds about a quarter as much.',
  },
  {
    id: 'hotGlue', label: 'Hot glue', density: 950, rgba: [0.93, 0.93, 0.85, 0.85],
    shearKPa: 2000, yields: false,
    note: 'Rigid until it lets go. Thin rods usually snap before the glue does.',
  },
  {
    id: 'pva', label: 'Wood glue (PVA)', density: 1100, rgba: [0.96, 0.92, 0.75, 1],
    shearKPa: 3000, yields: false,
    note: 'Set wood glue: stronger than hot glue, and as rigid.',
  },
  {
    id: 'epoxy', label: 'Epoxy', density: 1200, rgba: [0.85, 0.8, 0.55, 0.9],
    shearKPa: 10000, yields: false,
    note: 'Stronger than most things you can stick into it.',
  },
];

export const DEFAULT_JOIN_MATERIAL: JoinMaterialId = 'putty';

export function joinMaterial(id: string | undefined): JoinMaterial | undefined {
  return JOIN_MATERIALS.find((m) => m.id === id);
}

export function isJoinBlob(node: SceneNode): boolean {
  return !!joinMaterial(node.joinMaterial) && (node.geoms || []).some((g) => g.type === 'ellipsoid' || g.type === 'sphere');
}

/** What one part stuck into a blob can carry. */
export interface JoinLimits {
  /** Pull that drags it out, N: along a rod, or any way for anything else. */
  pullN: number;
  /** Sideways push a rod survives, N. Undefined for anything that is not a rod. */
  lateralN?: number;
  /** Twist or lean the joint resists before it yields or lets go, N*m. */
  torqueNm: number;
}

/**
 * The limits for a rod of diameter `diameterM` buried `embedM` deep.
 *
 * Pull: shear over the buried surface, pi * d * L. Sideways: the rod bears
 * on a strip d wide and L long, taken at twice the shear figure (a soft solid
 * yields in compression at about twice what it does in shear). Lean: that
 * same bearing, the same shear figure on the strip, acting a quarter of L
 * either side of the middle. Pushing a rod further in has no limit here.
 */
export function rodJoinLimits(m: JoinMaterial, diameterM: number, embedM: number): JoinLimits {
  const tau = m.shearKPa * 1000;
  const L = Math.max(embedM, diameterM);
  return {
    pullN: tau * Math.PI * diameterM * L,
    lateralN: 2 * tau * diameterM * L,
    torqueNm: (tau * diameterM * L * L) / 4,
  };
}

/**
 * The limits for anything else pressed into a blob — a block, a ball, a mesh.
 *
 * Without a rod to measure, the bond is taken as the blob's own cross-section,
 * gripping at half its radius.
 */
export function faceJoinLimits(m: JoinMaterial, blobRadiusM: number): JoinLimits {
  const tau = m.shearKPa * 1000;
  const pullN = tau * Math.PI * blobRadiusM * blobRadiusM;
  return { pullN, torqueNm: (pullN * blobRadiusM) / 2 };
}
