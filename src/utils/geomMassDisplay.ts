/**
 * The mass the inspector shows for a geom that was not given one.
 *
 * A geom with no `mass` is weighed by MuJoCo from its volume and its density
 * (1000 kg/m³ unless it says otherwise) — every sculpt and lattice skin is
 * written that way on purpose (utils/generatedMeshMass.ts). The Mass slider
 * read `geom.mass ?? 0`, so a 64 g lattice arm showed 0.00 kg, and a nudge of
 * the slider from there set a mass of nearly nothing.
 *
 * A primitive's volume is known in closed form. A mesh's is what the solver
 * integrated (exactly, when it is closed; by its hull or its convex pieces
 * otherwise), so for a mesh the figure is the body's compiled mass, and it is
 * marked as the whole body's when the body has other geoms that weigh
 * something.
 */
import type { SceneGeom, SceneNode } from '../types/scene';

export interface DisplayedMass {
  kg: number;
  /** false: the geom states this mass. true: worked out from volume x density. */
  computed: boolean;
  /** 'body' when the figure is the whole body's compiled mass. */
  scope: 'geom' | 'body';
}

/** A primitive's volume in m³, or 0 when it has none that can be stated. */
export function primitiveVolume(geom: SceneGeom): number {
  const sz = geom.size || [0.1, 0.1, 0.1];
  const ft = geom.fromto;
  const halfLen = sz[1] ?? (ft ? Math.hypot(ft[3] - ft[0], ft[4] - ft[1], ft[5] - ft[2]) / 2 : undefined);
  let v = 0;
  if (geom.type === 'sphere') v = (4 / 3) * Math.PI * sz[0] ** 3;
  else if (geom.type === 'cylinder') v = Math.PI * sz[0] ** 2 * ((halfLen ?? 0) * 2);
  else if (geom.type === 'capsule') v = (4 / 3) * Math.PI * sz[0] ** 3 + Math.PI * sz[0] ** 2 * ((halfLen ?? 0) * 2);
  else if (geom.type === 'box') v = 8 * sz[0] * (sz[1] ?? sz[0]) * (sz[2] ?? sz[0]);
  else if (geom.type === 'ellipsoid') v = (4 / 3) * Math.PI * sz[0] * (sz[1] ?? sz[0]) * (sz[2] ?? sz[0]);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

const weighs = (g: SceneGeom) =>
  g.csg !== 'difference' && g.csg !== 'intersection' && g.role !== 'visual'
  && !(g.contype === 0 && g.conaffinity === 0 && g.mass === undefined && g.type === 'mesh');

/**
 * What to show for `node.geoms[index]`: its own mass, its volume times its
 * density, or (a mesh) its body's compiled mass. Null when there is nothing
 * honest to show yet (a mesh body not compiled).
 */
export function displayedGeomMass(
  node: SceneNode,
  index: number,
  bodyMassKg: number | null | undefined,
): DisplayedMass | null {
  const geom = node.geoms?.[index];
  if (!geom) return null;
  if (typeof geom.mass === 'number') return { kg: geom.mass, computed: false, scope: 'geom' };
  const density = typeof geom.density === 'number' ? geom.density : 1000;
  if (geom.type !== 'mesh') {
    const v = primitiveVolume(geom);
    return v > 0 ? { kg: v * density, computed: true, scope: 'geom' } : null;
  }
  if (typeof bodyMassKg !== 'number' || !Number.isFinite(bodyMassKg)) return null;
  // Convex pieces generated from this mesh carry its weight; anything else
  // that weighs something shares the body's figure.
  const others = (node.geoms ?? []).filter((g, i) => i !== index && !g.csgDerived && weighs(g));
  return { kg: bodyMassKg, computed: true, scope: others.length > 0 ? 'body' : 'geom' };
}
