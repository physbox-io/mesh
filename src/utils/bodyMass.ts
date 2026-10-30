// A body's own mass or density, passed down to the geoms that weigh it.
//
// MuJoCo weighs a body as the sum of its geoms; a body has no mass of its own
// in MJCF short of a full <inertial>, which would also need its centre of
// mass and inertia worked out here. So `mass` or `density` written on a body
// that has geoms used to be kept in the graph and read by nothing, and the
// body weighed its volume in water. Now the compiler hands them to the geoms:
//
// - `density` is each solid geom's density, unless the geom states a mass or
//   density of its own.
// - `mass` is the body's total. Each solid geom is weighed as MuJoCo would
//   (its stated mass, else volume x density), and every one is scaled by the
//   same factor so the total is the body's mass: the split between them, and
//   so the centre of mass, is what their own weights say it is.
//
// A boolean or decomposed body (csgMass, collisionMass, derived colliders) is
// left to its own mass path in csg.ts / convexDecomposition.ts.

import type { SceneGeom, SceneNode } from '../types/scene';
import { geomVolume } from './deformMaterials';
import { primitiveVolume } from './geomMassDisplay';

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Geoms MuJoCo weighs: not cutters, not decoration, not a pin's zero-mass socket. */
const weighs = (g: SceneGeom) => g.csg !== 'difference' && g.csg !== 'intersection' && g.role !== 'visual';

/** Whether the body's own mass or density has anything to do here. */
function handledElsewhere(node: SceneNode): boolean {
  return node.csgMass !== undefined || node.collisionMass !== undefined
    || (node.geoms ?? []).some((g) => g.csgDerived !== undefined);
}

/**
 * The geoms with the body's density and mass applied. The same array when the
 * body states neither (or its mass belongs to a boolean); otherwise new geom
 * objects, so nothing shared with the store is written to.
 */
export function applyBodyMass(node: SceneNode): SceneGeom[] {
  const geoms = node.geoms ?? [];
  const { mass, density } = node;
  if ((!positive(mass) && !positive(density)) || geoms.length === 0 || handledElsewhere(node)) return geoms;

  let out = geoms.map((g) => (
    weighs(g) && positive(density) && g.mass === undefined && g.density === undefined ? { ...g, density } : g
  ));
  if (!positive(mass)) return out;

  const solid = out.map(weighs);
  const weightOf = (g: SceneGeom) => {
    if (typeof g.mass === 'number') return Math.max(0, g.mass);
    const v = g.type === 'mesh' ? Math.abs(geomVolume(g)) : primitiveVolume(g);
    return Number.isFinite(v) ? v * (g.density ?? 1000) : 0;
  };
  const weights = out.map((g, i) => (solid[i] ? weightOf(g) : 0));
  const total = weights.reduce((a, b) => a + b, 0);
  const count = solid.filter(Boolean).length;
  if (count === 0) return geoms;
  out = out.map((g, i) => {
    if (!solid[i]) return g;
    const share = total > 0 ? weights[i] / total : 1 / count;
    return { ...g, mass: +(mass * share).toPrecision(10), density: undefined };
  });
  return out;
}
