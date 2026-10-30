/**
 * The checks a body from an agent passes before it goes anywhere near MuJoCo.
 *
 * Three mistakes used to come back as MuJoCo's own words, which name an XML
 * line nobody wrote and neither the body nor the field: a geom type that is
 * not one ("XML Error: invalid keyword: 'cube'"), a coordinate that is not a
 * number ("bad format in attribute 'pos'", "does not have enough data"), and a
 * moving body too small to weigh ("mass and inertia of moving bodies must be
 * larger than mjMINVAL", which a 0.2 mm sphere trips). Each is caught here and
 * named, with what would do instead, and the scene is left as it was.
 */
import type { SceneGeom, SceneNode } from '../types/scene';
import { geomBounds } from './csg';

/** The geom types MuJoCo compiles. */
export const GEOM_TYPES = ['box', 'sphere', 'capsule', 'cylinder', 'ellipsoid', 'plane', 'mesh'] as const;

/** Shapes that are built into a mesh before compile (utils/geom.ts, PARAMETRIC_MESH_TYPES). */
const MESH_SHAPES = 'cone, pyramid, wedge, torus, tube, extrude (polygon), lathe (profile)';

/** The smallest a moving body may be across, metres. MuJoCo refuses a sphere of 0.2 mm. */
export const SMALLEST_MOVING_BODY_M = 0.001;

/** Where a number is wrong, or null. `length` is how many it must have, when that is fixed. */
function badNumbers(value: unknown, length?: number): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value)) return `is ${JSON.stringify(value)}, not a list of numbers`;
  if (length !== undefined && value.length < length) return `has ${value.length} numbers, not ${length}`;
  const i = value.findIndex((v) => typeof v !== 'number' || !Number.isFinite(v));
  return i < 0 ? null : `[${i}] is ${typeof value[i] === 'number' ? String(value[i]) : JSON.stringify(value[i])}, not a finite number`;
}

function checkGeom(body: string, g: SceneGeom): void {
  const where = `Body '${body}' geom '${g.name}'`;
  if (!(GEOM_TYPES as readonly string[]).includes(g.type as string)) {
    throw new Error(`${where} has type ${JSON.stringify(g.type)}, which is not a geom type. Use one of ${GEOM_TYPES.join(', ')}, or a shape that becomes a mesh: ${MESH_SHAPES}. A cube is a box with three equal half-sizes.`);
  }
  for (const [field, length] of [['size', undefined], ['pos', 3], ['quat', 4], ['euler', 3], ['fromto', 6]] as const) {
    const bad = badNumbers((g as unknown as Record<string, unknown>)[field], length);
    if (bad) throw new Error(`${where}: ${field}${bad.startsWith('[') ? '' : ' '}${bad}. Lengths are metres and angles degrees, written as plain numbers.`);
  }
}

/**
 * Throws a plain-words error for the first thing wrong with `node` itself (its
 * children are checked as they are filled in). `moves` is whether it has a
 * joint of its own.
 */
export function checkIncomingBody(node: SceneNode, moves: boolean): void {
  const body = node.name || node.id;
  for (const [field, length] of [['pos', 3], ['quat', 4], ['euler', 3]] as const) {
    const bad = badNumbers((node as unknown as Record<string, unknown>)[field], length);
    if (bad) throw new Error(`Body '${body}': ${field}${bad.startsWith('[') ? '' : ' '}${bad}. Positions are metres, angles degrees, written as plain numbers.`);
  }
  for (const j of node.joints || []) {
    for (const [field, length] of [['axis', 3], ['pos', 3], ['range', 2]] as const) {
      const bad = badNumbers((j as unknown as Record<string, unknown>)[field], length);
      if (bad) throw new Error(`Body '${body}' joint '${j.name}': ${field}${bad.startsWith('[') ? '' : ' '}${bad}.`);
    }
  }
  const geoms = node.geoms || [];
  for (const g of geoms) checkGeom(body, g);

  // Too small to weigh. Only a body with a joint of its own, whose solid geoms
  // can all be measured (a SCAD body's mesh is not built yet), and not a
  // composite, whose segments are generated, nor a shard of something broken.
  if (!moves || node.isComposite || node.scad || node.shatterFrom !== undefined) return;
  const solid = geoms.filter((g) => g.role !== 'visual' && g.csg !== 'difference' && g.type !== 'plane');
  if (solid.length === 0) return;
  let across = 0;
  for (const g of solid) {
    const b = geomBounds(g);
    if (!b) return;
    across = Math.max(across, ...[0, 1, 2].map((a) => b.max[a] - b.min[a]));
  }
  if (across < SMALLEST_MOVING_BODY_M) {
    throw new Error(`Body '${body}' is ${+(across * 1000).toFixed(3)} mm across at most, too small for MuJoCo to weigh as a moving body (it needs to be at least ${SMALLEST_MOVING_BODY_M * 1000} mm). Sizes are metres and half-sizes: a 5 mm cube is size [0.0025, 0.0025, 0.0025]. Make it bigger, or fix it in place (static: true).`);
  }
}
