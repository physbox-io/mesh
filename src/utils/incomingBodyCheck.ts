/**
 * The checks a body from an agent passes before it goes anywhere near MuJoCo.
 *
 * Three mistakes used to come back as MuJoCo's own words, which name an XML
 * line nobody wrote and neither the body nor the field: a geom type that is
 * not one ("XML Error: invalid keyword: 'cube'"), a coordinate that is not a
 * number ("bad format in attribute 'pos'", "does not have enough data"), and a
 * moving body too small to weigh ("mass and inertia of moving bodies must be
 * larger than mjMINVAL", which anything under 0.2 mm trips even with the
 * inertia floor below). Each is caught here and
 * named, with what would do instead, and the scene is left as it was.
 */
import type { SceneGeom, SceneNode } from '../types/scene';
import { geomBounds } from './csg';
import { DEFORM_MATERIALS } from './deformMaterials';
import { STRING_MATERIALS } from './stringAcoustics';
import { MEMBRANE_MATERIALS } from './membraneAcoustics';

/** The geom types MuJoCo compiles. */
export const GEOM_TYPES = ['box', 'sphere', 'capsule', 'cylinder', 'ellipsoid', 'plane', 'mesh'] as const;

/** Shapes that are built into a mesh before compile (utils/geom.ts, PARAMETRIC_MESH_TYPES). */
const MESH_SHAPES = 'cone, pyramid, wedge, torus, tube, extrude (polygon), lathe (profile)';

/**
 * The smallest a moving body may be across, metres: a fine FDM print's detail.
 * MuJoCo refuses anything whose inertia is under 1e-15 kg*m^2 (a 0.2 mm cube
 * has 1e-17), so a scene with a moving body under 1 mm is compiled with a
 * floor on inertia, SMALL_BODY_INERTIA_FLOOR, by utils/mjcf.ts.
 */
export const SMALLEST_MOVING_BODY_M = 0.0002;

/**
 * kg*m^2. Above MuJoCo's 1e-15 and below a 1 mm cube's own 1.7e-13, so it
 * lets a sub-mm part load and leaves every bigger one exactly as it was.
 */
export const SMALL_BODY_INERTIA_FLOOR = 1e-14;

/** Across, metres, of a node's solid geoms at their widest; null if one cannot be measured. */
function solidAcross(node: SceneNode): number | null {
  const solid = (node.geoms || []).filter((g) => g.role !== 'visual' && g.csg !== 'difference' && g.type !== 'plane');
  if (solid.length === 0) return null;
  let across = 0;
  for (const g of solid) {
    const b = geomBounds(g);
    if (!b) return null;
    across = Math.max(across, ...[0, 1, 2].map((a) => b.max[a] - b.min[a]));
  }
  return across;
}

/** Whether any body with a joint of its own is under 1 mm across, so needs the inertia floor. */
export function hasSubMillimetreMovingBody(nodes: SceneNode[]): boolean {
  return nodes.some((n) => {
    if ((n.joints?.length ?? 0) > 0 && !n.isComposite) {
      const across = solidAcross(n);
      if (across !== null && across < 0.001) return true;
    }
    return hasSubMillimetreMovingBody(n.children || []);
  });
}

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
  const across = solidAcross(node);
  if (across !== null && across < SMALLEST_MOVING_BODY_M) {
    throw new Error(`Body '${body}' is ${+(across * 1000).toFixed(3)} mm across at most, too small for MuJoCo to weigh as a moving body (it needs to be at least ${SMALLEST_MOVING_BODY_M * 1000} mm). Sizes are metres and half-sizes: a 5 mm cube is size [0.0025, 0.0025, 0.0025]. Make it bigger, or fix it in place (static: true).`);
  }
}

// ---------------------------------------------------------------------------
// Acoustic fields. A partial `windInstrument: { exciter: 'reed' }` used to be
// stored as written, and the first thing to read breathKPa or embouchureHz got
// undefined (a NaN bore, a worker that never answered). Every acoustic spec is
// filled and checked as it comes in; the error names the field and what is valid.
// ---------------------------------------------------------------------------

const WIND_EXCITERS = ['reed', 'brass_lip', 'flute_jet', 'flap_valve'] as const;
const TUBE_ENDS = ['open_closed', 'open_open'] as const;
const MEMBRANE_SHAPES = ['circular', 'rectangular'] as const;
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Spec = Record<string, unknown>;

/** The spec as a plain object, nulls dropped, or an error naming the field. */
function specOf(body: string, field: string, value: unknown): Spec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Body '${body}': ${field} must be an object (see physics_get_schema nodeFields.acoustics), not ${JSON.stringify(value)}.`);
  }
  const out: Spec = {};
  for (const [k, v] of Object.entries(value as Spec)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

/** A number the spec may omit: the value or `fallback`; error if given and not a finite number. */
function num(body: string, field: string, spec: Spec, key: string, fallback: number | undefined, positive = false): number | undefined {
  if (!has(spec, key)) return fallback;
  const v = spec[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || (positive && v <= 0)) {
    throw new Error(`Body '${body}': ${field}.${key} is ${JSON.stringify(v)}, not a finite number${positive ? ' above 0' : ''}.`);
  }
  return v;
}

function oneOf<T extends string>(body: string, field: string, key: string, v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`Body '${body}': ${field}.${key} is ${JSON.stringify(v)}, not one of ${allowed.join(', ')}.`);
  }
  return v as T;
}

function str(body: string, field: string, spec: Spec, key: string): void {
  if (has(spec, key) && (typeof spec[key] !== 'string' || spec[key] === '')) {
    throw new Error(`Body '${body}': ${field}.${key} must be a body or joint name (text), not ${JSON.stringify(spec[key])}.`);
  }
}

/** The body's first solid geom a bow or pluck actually touches. */
function primarySolidGeom(node: SceneNode): SceneGeom | undefined {
  return (node.geoms || []).find((g) => g.role !== 'visual' && g.csg !== 'difference' && !g.csgDerived && g.type !== 'plane');
}

/**
 * Fills defaults into, and checks, every acoustic field of `node`
 * (deformMaterial, acousticString, windInstrument, acousticMembrane,
 * nonlinearPlate, resonatorTube, acousticBow). Mutates and returns `node`;
 * throws an Error that names the field and the valid values when one is wrong,
 * and leaves the node as it was on that field. `only` names the fields to check. An acousticBow stamps horsehair
 * contact (condim 3, rosin friction, a soft solref) on the first solid geom
 * that has none of its own.
 */
export function normalizeAcousticFields(node: SceneNode, only?: readonly string[]): SceneNode {
  const body = node.name || node.id;
  const n = node as unknown as Record<string, unknown>;
  // `only` limits the check to the fields an update touched, so editing a
  // colour on a body with a legacy spec is not refused for the spec.
  const on = (k: string) => n[k] !== undefined && (!only || only.includes(k));

  if (on('deformMaterial')) {
    const ids = DEFORM_MATERIALS.map((m) => m.id);
    if (typeof n.deformMaterial !== 'string' || ![...ids, 'custom'].includes(n.deformMaterial)) {
      throw new Error(`Body '${body}': deformMaterial is ${JSON.stringify(n.deformMaterial)}, not one of ${ids.join(', ')}, custom.`);
    }
  }

  if (on('acousticString')) {
    const f = 'acousticString';
    const s = specOf(body, f, n[f]);
    const material = has(s, 'material') ? s.material : 'bronze';
    if (typeof material !== 'string' || !has(STRING_MATERIALS, material)) {
      throw new Error(`Body '${body}': ${f}.material is ${JSON.stringify(material)}, not one of ${Object.keys(STRING_MATERIALS).join(', ')}.`);
    }
    s.material = material;
    s.diameterMm = num(body, f, s, 'diameterMm', 0.65, true);
    s.tensionN = num(body, f, s, 'tensionN', 50, true);
    const pluck = num(body, f, s, 'pluckPos', undefined);
    if (pluck !== undefined) s.pluckPos = clamp(pluck, 0.03, 0.5);
    str(body, f, s, 'resonatorNodeId');
    if (has(s, 'nonlinearPitchDroop') && typeof s.nonlinearPitchDroop !== 'boolean'
      && !(typeof s.nonlinearPitchDroop === 'number' && Number.isFinite(s.nonlinearPitchDroop))) {
      throw new Error(`Body '${body}': ${f}.nonlinearPitchDroop must be true, false or a finite number.`);
    }
    n[f] = s;
  }

  if (on('windInstrument')) {
    const f = 'windInstrument';
    const s = specOf(body, f, n[f]);
    s.exciter = oneOf(body, f, 'exciter', s.exciter, WIND_EXCITERS);
    const breath = num(body, f, s, 'breathKPa', 0);
    if (breath! < 0) throw new Error(`Body '${body}': ${f}.breathKPa is ${breath}, which is below 0 (0 is silent; playing is 1.5 to 7 kPa).`);
    s.breathKPa = breath;
    s.embouchureHz = num(body, f, s, 'embouchureHz', s.exciter === 'flap_valve' ? 55 : 260, true);
    for (const k of ['boreLengthM', 'mouthRadiusM', 'bellRadiusM', 'flareExponent']) num(body, f, s, k, undefined, true);
    for (const [k, fields] of [['toneholeJoints', ['axialFraction', 'diameterMm']], ['valveJoints', ['semitones']]] as const) {
      if (!has(s, k)) continue;
      const list = s[k];
      const ok = Array.isArray(list) && list.every((e) => e && typeof e === 'object' && typeof (e as Spec).jointName === 'string'
        && fields.every((q) => typeof (e as Spec)[q] === 'number' && Number.isFinite((e as Spec)[q] as number)));
      if (!ok) throw new Error(`Body '${body}': ${f}.${k} must be a list of { jointName, ${fields.join(', ')} }.`);
    }
    n[f] = s;
  }

  if (on('acousticMembrane')) {
    const f = 'acousticMembrane';
    const s = specOf(body, f, n[f]);
    const material = has(s, 'material') ? s.material : 'mylar';
    if (typeof material !== 'string' || !has(MEMBRANE_MATERIALS, material)) {
      throw new Error(`Body '${body}': ${f}.material is ${JSON.stringify(material)}, not one of ${Object.keys(MEMBRANE_MATERIALS).join(', ')}.`);
    }
    s.material = material;
    s.tensionNPerM = num(body, f, s, 'tensionNPerM', 1800, true);
    s.thicknessMm = num(body, f, s, 'thicknessMm', 0.19, true);
    if (has(s, 'shape')) s.shape = oneOf(body, f, 'shape', s.shape, MEMBRANE_SHAPES);
    str(body, f, s, 'shellNodeId');
    for (const k of ['kettleCoupling', 'snareBuzz']) {
      const v = num(body, f, s, k, undefined);
      if (v !== undefined) s[k] = clamp(v, 0, 1);
    }
    const glide = num(body, f, s, 'nonlinearGlide', undefined);
    if (glide !== undefined) s.nonlinearGlide = clamp(glide, 0, 2);
    num(body, f, s, 'pitchGlideSemitones', undefined);
    num(body, f, s, 'pitchGlideDecayMs', undefined, true);
    n[f] = s;
  }

  if (on('nonlinearPlate')) {
    const f = 'nonlinearPlate';
    const s = specOf(body, f, n[f]);
    if (has(s, 'enabled') && typeof s.enabled !== 'boolean') throw new Error(`Body '${body}': ${f}.enabled must be true or false.`);
    for (const k of ['crashSensitivity', 'bloomDelayMs', 'pitchGlideCents', 'shimmerMix', 'archRatio']) num(body, f, s, k, undefined);
    n[f] = s;
  }

  if (on('resonatorTube')) {
    const f = 'resonatorTube';
    const s = specOf(body, f, n[f]);
    if (has(s, 'endCondition')) s.endCondition = oneOf(body, f, 'endCondition', s.endCondition, TUBE_ENDS);
    str(body, f, s, 'coupledBarNodeId');
    str(body, f, s, 'vaneJointName');
    const occ = num(body, f, s, 'vaneMaxOcclusion', undefined);
    if (occ !== undefined) s.vaneMaxOcclusion = clamp(occ, 0, 1);
    num(body, f, s, 'tuningHz', undefined, true);
    n[f] = s;
  }

  if (on('acousticBow')) {
    const f = 'acousticBow';
    const s = specOf(body, f, n[f]);
    const ranges: [string, number, number][] = [['rosinFriction', 0.2, 0.65], ['hairWidthMm', 3, 18], ['rosinGrip', 0.2, 2]];
    for (const [k, lo, hi] of ranges) {
      const v = num(body, f, s, k, undefined);
      if (v !== undefined) s[k] = clamp(v, lo, hi);
    }
    num(body, f, s, 'forceScale', undefined, true);
    n[f] = s;
    const hair = primarySolidGeom(node);
    if (hair) {
      const mu = typeof s.rosinFriction === 'number' ? s.rosinFriction : 0.38;
      const stamp: Partial<SceneGeom> = {
        ...(hair.condim === undefined ? { condim: 3 } : {}),
        ...(hair.friction === undefined ? { friction: [mu, 0.004, 0.0004] } : {}),
        ...(hair.solref === undefined ? { solref: [0.005, 1.25] } : {}),
      };
      // A new geom, not an edit: `node.geoms` may be the stored scene's own.
      if (Object.keys(stamp).length > 0) node.geoms = (node.geoms || []).map((g) => (g === hair ? { ...g, ...stamp } : g));
    }
  }
  return node;
}
