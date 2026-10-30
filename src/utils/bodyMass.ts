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
// A concave mesh body that collides as convex pieces (convexDecomposition.ts)
// carries a mass worked out from its mesh's TRUE volume at the mesh's density,
// 1000 unless it said otherwise. Where MuJoCo can weigh the mesh exactly,
// resolveCsgGeoms keeps it in the model out of contact (role 'visual') holding
// all of that mass and the pieces weigh nothing; otherwise the pieces hold it,
// shared by hull volume. Either way a body density rescales whatever holds the
// mass of a mesh that stated neither, and a body mass scales it with
// everything else, so the centre of mass stays the solid's.
//
// A boolean body (csgEnabled, csgMass) is left to its own mass path in csg.ts,
// and a stated collisionMass to convexDecomposition.ts.

import type { SceneGeom, SceneNode } from '../types/scene';
import { geomVolume } from './deformMaterials';
import { primitiveVolume } from './geomMassDisplay';

const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

/**
 * Geoms MuJoCo weighs: not cutters, not a pin's zero-mass socket, and not
 * decoration, unless it was given a mass to carry (mjcf.ts emits a stated
 * mass on a visual geom; a decomposed mesh's mass carrier is one).
 */
const weighs = (g: SceneGeom) => g.csg !== 'difference' && g.csg !== 'intersection'
  && (g.role !== 'visual' || positive(g.mass));

/** A decomposed mesh kept out of contact to carry its pieces' mass (resolveCsgGeoms). */
const carriesPieceMass = (g: SceneGeom, authored: SceneGeom[]) => g.type === 'mesh' && g.role === 'visual'
  && positive(g.mass) && authored.some((a) => a.name === g.name && a.type === 'mesh' && a.role !== 'visual' && !a.csgDerived);

/** Whether the body's own mass or density belongs to another path. */
function handledElsewhere(node: SceneNode): boolean {
  return !!node.csgEnabled || node.csgMass !== undefined || node.collisionMass !== undefined;
}

/** The authored mesh a convex piece was cut from: by name, or (an older piece) the body's first mesh. */
function sourceOf(piece: SceneGeom, authored: SceneGeom[]): SceneGeom | undefined {
  const meshes = authored.filter((g) => g.type === 'mesh' && !g.csgDerived);
  return piece.colliderOf !== undefined ? meshes.find((g) => g.name === piece.colliderOf) : meshes[0];
}

/**
 * The geoms with the body's density and mass applied. The same array when the
 * body states neither (or its mass belongs to a boolean); otherwise new geom
 * objects, so nothing shared with the store is written to.
 *
 * `geoms` are the ones about to be emitted (after resolveCsgGeoms, which drops
 * or demotes a mesh its pieces stand in for); `authored` the body's own list,
 * where each piece's source mesh is still to be found. Both default to
 * node.geoms.
 */
export function applyBodyMass(
  node: SceneNode,
  geoms: SceneGeom[] = node.geoms ?? [],
  authored: SceneGeom[] = node.geoms ?? [],
): SceneGeom[] {
  const { mass, density } = node;
  if ((!positive(mass) && !positive(density)) || geoms.length === 0 || handledElsewhere(node)) return geoms;

  let out = geoms.map((g) => {
    if (!weighs(g) || !positive(density)) return g;
    if (g.csgDerived === 'collider' || carriesPieceMass(g, authored)) {
      // Weighed at its mesh's density when it was cut; at the body's now,
      // unless the mesh said otherwise.
      const src = g.csgDerived === 'collider' ? sourceOf(g, authored) : authored.find((a) => a.name === g.name);
      if (typeof g.mass !== 'number' || src?.mass !== undefined || src?.density !== undefined) return g;
      return { ...g, mass: +(g.mass * (density / 1000)).toPrecision(10) };
    }
    return g.mass === undefined && g.density === undefined ? { ...g, density } : g;
  });
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
