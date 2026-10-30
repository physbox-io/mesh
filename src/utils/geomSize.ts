// A geom's size, checked rather than repaired.
//
// A size MuJoCo cannot use (negative, zero, NaN, text) used to be replaced
// with 0.1 m by the compiler without a word, so a box written with a negative
// half-extent came out 200 mm across and 0.32 kg. Now the MCP and the store
// refuse it with this message, and the compiler does too for a document that
// already holds one.

/** How many size entries each primitive reads: half-extents for a box, radius (and half-length) otherwise. */
const USED: Record<string, number> = { sphere: 1, capsule: 2, cylinder: 2, box: 3, ellipsoid: 3 };

const MEANING: Record<string, string> = {
  sphere: '[radius]',
  capsule: '[radius, half-length]',
  cylinder: '[radius, half-length]',
  box: '[half-x, half-y, half-z]',
  ellipsoid: '[radius-x, radius-y, radius-z]',
};

interface SizedGeom { name?: string; type?: string; size?: unknown; fromto?: unknown }

/**
 * What is wrong with this geom's size, or null when nothing is. A size left
 * out is fine (a default fills it), as is a short one (a box of [0.1] is a
 * cube); every entry the shape reads that IS given has to be a positive,
 * finite number. A mesh's size is unused, and a plane's may be 0 (infinite).
 */
export function geomSizeProblem(geom: SizedGeom, bodyName?: string): string | null {
  const type = geom.type ?? 'box';
  if (geom.size === undefined || type === 'mesh') return null;
  const where = `Geom "${geom.name ?? '(unnamed)'}"${bodyName ? ` on body "${bodyName}"` : ''}`;
  if (!Array.isArray(geom.size)) {
    return `${where}: size must be a list of numbers in metres, got ${JSON.stringify(geom.size)}.`;
  }
  const size = geom.size as unknown[];
  if (type === 'plane') {
    const bad = size.findIndex((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0);
    return bad < 0 ? null : `${where}: plane size[${bad}] is ${JSON.stringify(size[bad])}; it must be a number >= 0 (0 means infinite).`;
  }
  if (size.length === 0) return `${where}: size is empty; a ${type} needs ${MEANING[type] ?? 'a positive size'} in metres.`;
  // With fromto, a capsule or cylinder takes its length from the two points.
  const used = Math.min(size.length, (type === 'capsule' || type === 'cylinder') && geom.fromto ? 1 : (USED[type] ?? size.length));
  for (let i = 0; i < used; i++) {
    const v = size[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      return `${where}: size[${i}] is ${JSON.stringify(v)}; a ${type}'s size is ${MEANING[type] ?? 'its extent'} in metres and every entry must be a positive number.`;
    }
  }
  return null;
}

/** Throws geomSizeProblem's message for the first bad geom in the list. */
export function assertGeomSizes(geoms: readonly SizedGeom[] | undefined, bodyName?: string): void {
  for (const g of geoms ?? []) {
    const problem = geomSizeProblem(g, bodyName);
    if (problem) throw new Error(problem);
  }
}

/** Every body in the tree, as assertGeomSizes. */
export function assertSceneGeomSizes(nodes: readonly { name?: string; id?: string; geoms?: SizedGeom[]; children?: unknown[] }[] | undefined): void {
  for (const n of nodes ?? []) {
    assertGeomSizes(n.geoms, n.name ?? n.id);
    assertSceneGeomSizes(n.children as typeof nodes);
  }
}
