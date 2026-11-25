// ---------------------------------------------------------------------------
// Filling in what an agent left out of a body, geom or joint
//
// build_scene and add_object take shorthand: these turn it into a complete
// SceneNode, and queue the features (cuts, rounds, patterns, paint) that can
// only be applied once the body exists.
// ---------------------------------------------------------------------------

import {
  generateCurveGeoms, normalizeMeshGeomData, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH,
  DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS,
} from '../../utils/geom';
import { SCULPT_BASES, buildSculptBase, buildSculptBaseSized, type SculptBaseId } from '../../utils/sculptBases';
import { toSceneGeom } from '../../utils/sculptMesh';
import { applySculptStroke } from '../../utils/sculptCommands';
import { resolveLoadStrength } from '../../utils/deformMaterials';
import { JOIN_MATERIALS, joinMaterial } from '../../utils/joinMaterials';
import type { SceneNode, SceneGeom, SceneJoint } from '../../types/scene';
import type { RawGeom, RawJoint, RawNode } from '../../utils/sceneNodes';
import {
  boxLattice, createLattice, deserializeCage, serializeCage, toSceneGeom as latticeToSceneGeom,
  DEFAULT_UNIT as LATTICE_UNIT,
} from '../../utils/latticeMesh';
import { generatedMeshMass } from '../../utils/generatedMeshMass';
import { isFiniteNumber, isFiniteVec3, isPlainObject, pointList, toRenderVertices } from './bridgeUtils';
import { type LatticeOpSpec, runLatticeOps } from './latticeState';
import { latticeBodyPos } from '../../utils/latticeFrame';
import { sceneContentBounds } from '../../utils/frameScene';
import { checkIncomingBody, normalizeAcousticFields } from '../../utils/incomingBodyCheck';
import { noteToHz, tuneBodyToPitch, tuneWindInstrumentToPitch } from '../../utils/acousticTuning';
import { tuneStringToPitch } from '../../utils/stringAcoustics';
import { tuneMembraneToPitch } from '../../utils/membraneAcoustics';
import { tuneResonatorTubeToPitch } from '../../utils/resonatorAcoustics';
import { geomSizeProblem } from '../../utils/geomSize';
import { withoutNulls } from '../../utils/withoutNulls';
import { applyFlexureToNode, type FlexureDesignInput } from '../../utils/flexure';
import { clampBodyForm } from '../../utils/cloth/bodyForm';
import type { BodyFormMeasurements } from '../../types/cloth';

export interface PendingDeclarativeOps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sculptCuts?: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cuts?: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  roundEdges?: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patterns?: Record<string, any>[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paint?: Record<string, any>[];
}

export const pendingDeclarativeOps = new Map<string, PendingDeclarativeOps>();

/** Removes any queued declarative ops for `nodes` and all their descendants. */
export function clearPendingDeclarativeOps(
  nodes: SceneNode[],
  opsMap: Map<string, PendingDeclarativeOps> = pendingDeclarativeOps,
): void {
  const walk = (list: SceneNode[] | undefined) => {
    for (const n of list || []) {
      opsMap.delete(n.id);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
}

export const normalizeRgba = (
  rgba: unknown,
  fallbackAlpha = 1,
): [number, number, number, number] | undefined => {
  if (!Array.isArray(rgba) || (rgba.length !== 3 && rgba.length !== 4)) return undefined;
  for (let i = 0; i < rgba.length; i++) {
    const v = rgba[i];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) return undefined;
  }
  const alpha = rgba.length === 4 ? (rgba[3] as number) : fallbackAlpha;
  if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha < 0 || alpha > 1) return undefined;
  return [rgba[0] as number, rgba[1] as number, rgba[2] as number, alpha];
};

const PARAMETRIC_POSITIVE_DIM_KEYS = [
  'radius', 'height', 'width', 'depth', 'majorRadius', 'minorRadius',
  'tubeRadius', 'innerRadius', 'outerRadius', 'wallThickness',
] as const;

const PARAMETRIC_SEGMENT_KEYS = ['segments', 'radialSegments', 'tubularSegments'] as const;
const MAX_PARAMETRIC_SEGMENTS = 512;

export const fillGeomDefaults = (rawG: RawGeom, bodyName: string, idx: number, bodyIsJointed: boolean): SceneGeom => {
  if (!isPlainObject(rawG)) {
    throw new Error(`Geom ${idx} on body "${bodyName}" must be a plain object.`);
  }
  // A null field is an unset one (utils/withoutNulls.ts).
  const g: RawGeom = withoutNulls({ ...rawG });
  const geomName = g.name ?? `${bodyName}_geom_${idx}`;
  if (g.rgba !== undefined && !normalizeRgba(g.rgba)) {
    throw new Error(`Geom "${geomName}" on body "${bodyName}": rgba must be [r, g, b] or [r, g, b, a], each a finite number in 0..1.`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gAny = g as Record<string, any>;
  for (const key of PARAMETRIC_POSITIVE_DIM_KEYS) {
    if (gAny[key] !== undefined && (!isFiniteNumber(gAny[key]) || gAny[key] <= 0)) {
      throw new Error(`Geom "${geomName}" on body "${bodyName}": ${key} must be a positive finite number.`);
    }
  }
  for (const key of PARAMETRIC_SEGMENT_KEYS) {
    if (gAny[key] !== undefined && (!isFiniteNumber(gAny[key]) || !Number.isInteger(gAny[key]) || gAny[key] < 3 || gAny[key] > MAX_PARAMETRIC_SEGMENTS)) {
      throw new Error(`Geom "${geomName}" on body "${bodyName}": ${key} must be an integer between 3 and ${MAX_PARAMETRIC_SEGMENTS}.`);
    }
  }
  // Refused, not repaired: a negative or text size used to compile as 0.1 m.
  const sizeProblem = geomSizeProblem({ ...g, name: geomName }, bodyName);
  if (sizeProblem) throw new Error(sizeProblem);
  normalizeMeshGeomData(g);
  const isMesh = (g.type ?? 'box') === 'mesh';
  const dynamic = g.dynamic !== undefined ? g.dynamic : (isMesh ? true : (bodyIsJointed ? undefined : undefined));
  const renderVertices = g.renderVertices !== undefined
    ? g.renderVertices
    : (dynamic && Array.isArray(g.vertices) ? toRenderVertices(g.vertices) : undefined);
  return {
    // Everything the caller wrote is kept, and only what needs a default is
    // filled in. This was a whitelist, which fell behind the schema: density,
    // margin, gap, paint, thread and the dent and pierce fields were dropped
    // without a word, so a documented `density: 700` weighed as water.
    ...(g as SceneGeom),
    name:    geomName,
    type:    g.type    ?? 'box',
    size:    g.size    ?? [0.25, 0.25, 0.25],
    rgba:    normalizeRgba(g.rgba) ?? [0.6, 0.6, 0.9, 1],
    ...(g.pos         !== undefined ? { pos: g.pos }         : {}),
    ...(g.quat        !== undefined ? { quat: g.quat }       : {}),
    ...(g.euler       !== undefined ? { euler: g.euler }     : {}),
    ...(g.fromto      !== undefined ? { fromto: g.fromto }   : {}),
    ...(g.mass        !== undefined ? { mass: g.mass }       : {}),
    ...(g.friction    !== undefined ? { friction: g.friction }: {}),
    ...(g.contype     !== undefined ? { contype: g.contype } : {}),
    ...(g.conaffinity !== undefined ? { conaffinity: g.conaffinity } : {}),
    ...(g.condim      !== undefined ? { condim: g.condim }   : {}),
    ...(g.solref      !== undefined ? { solref: g.solref }   : {}),
    ...(g.solimp      !== undefined ? { solimp: g.solimp }   : {}),
    ...(g.vertices    !== undefined ? { vertices: g.vertices }: {}),
    ...(g.faces       !== undefined ? { faces: g.faces }     : {}),
    ...(dynamic         !== undefined ? { dynamic } : {}),
    ...(renderVertices  !== undefined ? { renderVertices } : {}),
    ...(g.csg         !== undefined ? { csg: g.csg }           : {}),
    ...(g.role        !== undefined ? { role: g.role }         : {}),
  };
};

export const GEOM_SHAPE_KEYS = [
  'type', 'size', 'fromto', 'vertices', 'verticesZUp', 'renderVertices',
  'radius', 'width', 'height', 'depth', 'polygon', 'profile',
  'majorRadius', 'minorRadius', 'tubeRadius', 'innerRadius', 'outerRadius',
] as const;

export const GEOM_STRUCTURAL_KEYS = [
  ...GEOM_SHAPE_KEYS, 'faces', 'pos', 'quat', 'euler', 'csg', 'thread',
] as const;

/**
 * Merges `updates.geoms` against `target.geoms` for `physics_update_object`.
 *
 * A partial geom (such as `{ name, rgba }` or `{ rgba }`) merges into the
 * matching existing geom rather than replacing it with a default 0.25 m box;
 * if a partial geom names a geom that does not exist on the body, the call is
 * rejected instead of silently destroying the body's geometry.
 */
export function resolveUpdatedGeoms(
  target: SceneNode,
  rawGeoms: RawGeom[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  updates: Record<string, any> = {},
): { ok: true; geoms: SceneGeom[] } | { ok: false; error: string } {
  const existingGeoms = target.geoms ?? [];
  const authoredGeoms = existingGeoms.filter((g) => !g.csgDerived);
  const indexableGeoms = authoredGeoms.length > 0 ? authoredGeoms : existingGeoms;
  const moves = (updates.joints ?? target.joints ?? []).length > 0;
  const bodyName = updates.name ?? target.name ?? target.id;
  const bodyRgba = normalizeRgba(updates.rgba);

  const resolvedList: SceneGeom[] = [];
  const matchedMap = new Map<SceneGeom, SceneGeom>();
  let allPartialPatches = rawGeoms.length > 0;
  let anyStructuralChange = false;

  for (let i = 0; i < rawGeoms.length; i++) {
    if (!isPlainObject(rawGeoms[i])) {
      return { ok: false, error: `Geom at index ${i} on object "${target.id}" must be a plain object.` };
    }
    // A null in the patch removes that field from the geom it merges into.
    const patch = rawGeoms[i] as RawGeom;
    const cleared = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] === null);
    const g = withoutNulls(patch);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gAny = g as Record<string, any>;
    const hasOwnShape = GEOM_SHAPE_KEYS.some((k) => gAny[k] !== undefined);
    const hasStructural = GEOM_STRUCTURAL_KEYS.some((k) => gAny[k] !== undefined || cleared.includes(k));
    if (hasStructural) anyStructuralChange = true;

    let existing: SceneGeom | undefined;
    if (typeof g.name === 'string' && g.name.length > 0) {
      existing = existingGeoms.find((eg) => eg.name === g.name);
      if (!existing && !hasOwnShape) {
        const known = indexableGeoms.map((eg) => eg.name).join(', ') || 'none';
        return {
          ok: false,
          error: `Object "${target.id}" has no geom named "${g.name}" (existing geoms: ${known}). Pass an existing geom name to update it, or specify type and size for a new geom.`,
        };
      }
    } else if (!hasOwnShape) {
      existing = indexableGeoms[i];
      if (!existing) {
        return {
          ok: false,
          error: `Partial geom at index ${i} has no type or size, and object "${target.id}" has no existing geom at index ${i} to merge into.`,
        };
      }
    } else if (g.name === undefined && g.type === undefined && indexableGeoms[i]) {
      existing = indexableGeoms[i];
    }

    if (existing) {
      const changesType = g.type !== undefined && g.type !== existing.type;
      const changesVertices =
        gAny.vertices !== undefined ||
        gAny.verticesZUp !== undefined ||
        gAny.renderVertices !== undefined ||
        gAny.polygon !== undefined ||
        gAny.profile !== undefined;
      if (g.type !== undefined) allPartialPatches = false;

      let resolved: SceneGeom;
      if (!changesType && !changesVertices && existing.type === 'mesh') {
        let nextRgba: [number, number, number, number] | number[] | undefined;
        if (g.rgba !== undefined) {
          const norm = normalizeRgba(g.rgba, existing.rgba?.[3] ?? 1);
          if (!norm) {
            return { ok: false, error: 'rgba must be [r, g, b] or [r, g, b, a], each a finite number in 0..1' };
          }
          nextRgba = norm;
        } else {
          nextRgba = bodyRgba ?? existing.rgba;
        }
        resolved = {
          ...existing,
          ...(g as Partial<SceneGeom>),
          ...(nextRgba ? { rgba: nextRgba } : {}),
        };
        for (const k of cleared) delete (resolved as unknown as Record<string, unknown>)[k];
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const base: RawGeom & Record<string, any> = { ...existing, ...g };
        for (const k of cleared) delete base[k];
        if (gAny.verticesZUp !== undefined) {
          delete base.vertices;
          delete base.renderVertices;
        } else if (gAny.vertices !== undefined && gAny.renderVertices === undefined) {
          delete base.renderVertices;
        } else if (gAny.renderVertices !== undefined && gAny.vertices === undefined) {
          delete base.vertices;
        }
        if (changesType && g.type !== 'mesh') {
          delete base.vertices;
          delete base.faces;
          delete base.renderVertices;
          delete base.baseVertices;
          delete base.baseRenderVertices;
          delete base.paint;
        }
        if (g.rgba === undefined && bodyRgba !== undefined) base.rgba = bodyRgba;
        resolved = fillGeomDefaults(base, bodyName, i, moves);
      }
      resolvedList.push(resolved);
      matchedMap.set(existing, resolved);
    } else {
      allPartialPatches = false;
      const base: RawGeom = { ...g };
      if (base.rgba === undefined && bodyRgba !== undefined) base.rgba = bodyRgba;
      resolvedList.push(fillGeomDefaults(base, bodyName, i, moves));
    }
  }

  // When every entry was a partial patch onto an existing geom (e.g.
  // `geoms: [{ name: 'pumpkin_sculpt', rgba: [...] }]`), update those geoms in
  // place so sibling geoms and non-stale convex colliders on the body are kept.
  if (allPartialPatches && matchedMap.size === rawGeoms.length) {
    const baseList = anyStructuralChange
      ? existingGeoms.filter((eg) => eg.csgDerived !== 'collider')
      : existingGeoms;
    return {
      ok: true,
      geoms: baseList.map((eg) => matchedMap.get(eg) ?? eg),
    };
  }

  return { ok: true, geoms: resolvedList };
}

export const fillJointDefaults = (rawJ: RawJoint, bodyName: string, idx: number): SceneJoint => fillJoint(withoutNulls(rawJ), bodyName, idx);

const fillJoint = (j: RawJoint, bodyName: string, idx: number): SceneJoint => ({
  // As for geoms: springref and the crumple fields were dropped by a whitelist.
  ...(j as SceneJoint),
  name:    j.name    ?? `${bodyName}_joint_${idx}`,
  type:    j.type    ?? 'free',
  ...(j.axis     !== undefined ? { axis: j.axis }         : {}),
  ...(j.pos      !== undefined ? { pos: j.pos }           : {}),
  ...(j.damping  !== undefined ? { damping: j.damping }   : {}),
  ...(j.stiffness!== undefined ? { stiffness: j.stiffness}: {}),
  ...(j.limited  !== undefined ? { limited: j.limited }   : {}),
  ...(j.range    !== undefined ? { range: j.range }       : {}),
  ...(j.actuator !== undefined ? { actuator: j.actuator } : {}),
});

/**
 * `parentMoves` is null for a top-level body. For a nested one it says whether
 * anything above it has a joint, which decides whether its meshes are drawn
 * from the body's transform.
 */
/**
 * The break-under-load and join-blob fields of a body as an agent wrote them,
 * resolved in place: `loadStrength` from its shorthands (see
 * resolveLoadStrength), `joinMaterial` checked against the list. An error
 * message, or null when all is well.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const resolveBreakFields = (fields: Record<string, any>, materialId: string | undefined): string | null => {
  if ('loadStrength' in fields) {
    const r = resolveLoadStrength(fields.loadStrength, fields.deformMaterial ?? materialId);
    if ('error' in r) return r.error;
    fields.loadStrength = r.value;
  }
  if ('joinMaterial' in fields && fields.joinMaterial !== undefined && fields.joinMaterial !== null) {
    if (!joinMaterial(fields.joinMaterial)) {
      return `joinMaterial '${fields.joinMaterial}' is not one of ${JOIN_MATERIALS.map((m) => m.id).join(', ')}.`;
    }
  } else if ('joinMaterial' in fields) fields.joinMaterial = undefined;
  return null;
};

/** A declarative `tuneTo`, parsed: the pitch to tune a body to, in Hz. */
export interface TuneToSpec { hz: number; drillNodalHole: boolean }

/**
 * `tuneTo` as an agent writes it: a note ('A4', 'F#3'), a number of Hz, or
 * { note | hz, drillNodalHole? }; a body-level `drillNodalHole` also counts.
 * Throws an Error saying what is accepted.
 */
export function parseTuneTo(raw: unknown, drill?: unknown): TuneToSpec {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
  const value = obj ? (obj.hz ?? obj.note) : raw;
  let hz: number | null = null;
  if (typeof value === 'number') hz = value;
  else if (typeof value === 'string') hz = noteToHz(value) ?? (Number.isFinite(Number(value)) && value.trim() !== '' ? Number(value) : null);
  if (hz === null || !Number.isFinite(hz) || hz <= 0) {
    throw new Error(`tuneTo is ${JSON.stringify(raw)}, not a note like 'A4' or 'F#3' or a pitch in Hz above 0 (or { note | hz, drillNodalHole }).`);
  }
  return { hz, drillNodalHole: (obj?.drillNodalHole ?? drill) === true };
}

/**
 * Tunes `node` to the spec with the tuner for what it is: a string's tension
 * and gauge, a head's tension, a resonator tube's or wind bore's length, and
 * for any other body (a bar, chime, plate) its dimensions. `sceneNodes` lets a
 * string know the soundbox span it is coupled to.
 */
export function applyTuneTo(node: SceneNode, spec: TuneToSpec, sceneNodes?: SceneNode[]): SceneNode {
  try {
    if (node.acousticString) return tuneStringToPitch(node, spec.hz, sceneNodes);
    if (node.acousticMembrane) return tuneMembraneToPitch(node, spec.hz, sceneNodes);
    if (node.resonatorTube) return tuneResonatorTubeToPitch(node, spec.hz);
    if (node.windInstrument) return tuneWindInstrumentToPitch(node, spec.hz);
    return tuneBodyToPitch(node, spec.hz, { drillNodalHole: spec.drillNodalHole, sceneNodes }).node;
  } catch (err) {
    throw new Error(`Body '${node.name || node.id}' could not be tuned to ${spec.hz} Hz: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

/**
 * Strings and heads are tuned as their body is filled in, before the rest of
 * the scene exists; the ones that were are retuned here with it in view (the
 * soundbox a string is coupled to changes the span it vibrates over).
 */
const retuneWithScene = new WeakMap<SceneNode, TuneToSpec>();

/** `nodes` with every string and head that came in with a `tuneTo` retuned against the whole of `nodes`. */
export function applyPendingTuneTo(nodes: SceneNode[]): SceneNode[] {
  const walk = (list: SceneNode[]): SceneNode[] => {
    let changed = false;
    const out = list.map((n) => {
      const children = n.children?.length ? walk(n.children) : n.children;
      let next = children === n.children ? n : { ...n, children };
      const spec = retuneWithScene.get(n);
      if (spec) {
        next = applyTuneTo(next, spec, nodes);
        retuneWithScene.delete(n);
      }
      if (next !== n) changed = true;
      return next;
    });
    return changed ? out : list;
  };
  return walk(nodes);
}

export const fillBodyDefaults = (
  rawB: RawNode,
  parentMoves: boolean | null = null,
  opsMap: Map<string, PendingDeclarativeOps> = pendingDeclarativeOps,
): SceneNode => {
  if (!isPlainObject(rawB)) {
    throw new Error('Each body descriptor must be a plain object.');
  }
  const b = withoutNulls({ ...rawB });
  const name = b.name ?? b.id ?? `body_${Math.random().toString(36).slice(2, 7)}`;
  const id   = b.id   ?? name;
  const breakError = resolveBreakFields(b as Record<string, unknown>, undefined);
  if (breakError) throw new Error(breakError);
  if (b.rgba !== undefined && !normalizeRgba(b.rgba)) {
    throw new Error(`Body '${name}': rgba must be [r, g, b] or [r, g, b, a], each a finite number in 0..1.`);
  }
  if (b.geoms !== undefined && (!Array.isArray(b.geoms) || !b.geoms.every(isPlainObject))) {
    throw new Error(`Body '${name}': geoms must be an array of plain objects.`);
  }
  if (b.joints !== undefined && (!Array.isArray(b.joints) || !b.joints.every(isPlainObject))) {
    throw new Error(`Body '${name}': joints must be an array of plain objects.`);
  }
  if (b.children !== undefined && (!Array.isArray(b.children) || !b.children.every(isPlainObject))) {
    throw new Error(`Body '${name}': children must be an array of plain objects.`);
  }
  const nested = parentMoves !== null;
  // MuJoCo allows a free joint only on a top-level body; written inside another
  // one it fails the whole compile with a message that names neither body.
  if (nested && (b.joints ?? []).some((j: RawJoint) => j.type === 'free')) {
    throw new Error(`Body '${name}' has a free joint but sits inside another body. A free joint is only allowed at the top level: leave joints out to fix it rigidly to its parent, or give it a hinge or slide.`);
  }
  // Curve (rigid curved track): generate convex box segments from the spline
  // params so agents can author curves declaratively without hand-placing geoms.
  if (b.isCurve === true) {
    if (b.curveSegments !== undefined && (!isFiniteNumber(b.curveSegments) || !Number.isInteger(b.curveSegments) || b.curveSegments < 1 || b.curveSegments > 500)) {
      throw new Error(`Body '${name}': curveSegments must be an integer between 1 and 500.`);
    }
    if (b.curveWidth !== undefined && (!isFiniteNumber(b.curveWidth) || b.curveWidth <= 0)) {
      throw new Error(`Body '${name}': curveWidth must be a positive finite number.`);
    }
    if (b.curveThickness !== undefined && (!isFiniteNumber(b.curveThickness) || b.curveThickness <= 0)) {
      throw new Error(`Body '${name}': curveThickness must be a positive finite number.`);
    }
    if (b.curveBank !== undefined && !isFiniteNumber(b.curveBank)) {
      throw new Error(`Body '${name}': curveBank must be a finite number.`);
    }
  }
  const curveGeoms = (b.isCurve === true && b.geoms === undefined)
    ? generateCurveGeoms(
        id,
        b.curvePoints ?? DEFAULT_CURVE_POINTS,
        b.curveWidth ?? DEFAULT_CURVE_WIDTH,
        b.curveThickness ?? DEFAULT_CURVE_THICKNESS,
        b.curveSegments ?? DEFAULT_CURVE_SEGMENTS,
        normalizeRgba(b.rgba) ?? [0.85, 0.45, 0.15, 1],
        b.curveClosed === true,
        b.curveBank ?? 0
      )
    : null;
  // Flags an agent may write on a body to mean "does not move", none of which
  // is a SceneNode field: honoured here so the body gets no free joint.
  const flags = b as RawNode & { dynamic?: boolean; static?: boolean; fixed?: boolean };
  const isFixed = flags.dynamic === false ||
    flags.static === true ||
    flags.fixed === true ||
    (Array.isArray(b.geoms) && b.geoms.length > 0 && b.geoms.every(g => g.dynamic === false));
  // A rope is a logical node, not a body: the compiler emits nothing for it,
  // so a default free joint and 0.25 m box were ghosts that only the scene
  // summary showed. Cloth likewise: its pieces are its substance, and its
  // vertices move, not the body.
  // A dress form is generated: its geoms are built from its measurements
  // (compileCsgNodes, in a worker) and it stands still, so it gets neither a
  // default box nor a free joint.
  const generated = (b as { bodyForm?: unknown }).bodyForm != null && typeof (b as { bodyForm?: unknown }).bodyForm === 'object';
  const logical = b.isPulleyRope === true || (b.cloth != null && typeof b.cloth === 'object') || generated;
  // A nested body with no joints given is fixed rigidly to its parent.
  const defaultJoints: RawJoint[] = (b.isCurve === true || isFixed || nested || logical) ? [] : [{ type: 'free' }];
  const resolvedJoints = (b.joints ?? defaultJoints)
    .map((j: RawJoint, i: number) => fillJointDefaults(j, name, i));
  const moves = resolvedJoints.length > 0 || parentMoves === true;

  // Declarative lattice spec on body (`lattice: { sizeMm?, empty?, subdiv?, thicknessMm?, ops?: [...] }`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const latSpec = (b as any).lattice as {
    sizeMm?: number;
    empty?: boolean;
    subdiv?: number;
    thicknessMm?: number;
    ops?: LatticeOpSpec[];
  } | undefined;
  let latticeFields: Partial<SceneNode> | null = null;
  let latticeGeoms: RawGeom[] | null = null;
  if ((b as Record<string, unknown>).lattice !== undefined && !isPlainObject((b as Record<string, unknown>).lattice)) {
    throw new Error(`Body '${name}': lattice must be a plain object.`);
  }
  if (latSpec && typeof latSpec === 'object') {
    if (latSpec.sizeMm !== undefined && (!isFiniteNumber(latSpec.sizeMm) || latSpec.sizeMm < 0 || latSpec.sizeMm > 10_000)) {
      throw new Error(`Body '${name}': lattice.sizeMm must be a finite number between 0 and 10000.`);
    }
    if (latSpec.subdiv !== undefined && (!isFiniteNumber(latSpec.subdiv) || !Number.isInteger(latSpec.subdiv) || latSpec.subdiv < 0 || latSpec.subdiv > 4)) {
      throw new Error(`Body '${name}': lattice.subdiv must be an integer between 0 and 4.`);
    }
    if (latSpec.thicknessMm !== undefined && (!isFiniteNumber(latSpec.thicknessMm) || latSpec.thicknessMm < 0)) {
      throw new Error(`Body '${name}': lattice.thicknessMm must be a non-negative finite number.`);
    }
    const firstOp = Array.isArray(latSpec.ops) && latSpec.ops.length > 0
      ? String(latSpec.ops[0]?.op ?? latSpec.ops[0]?.type ?? '').toLowerCase()
      : '';
    const startEmpty = latSpec.empty === true || latSpec.sizeMm === 0 || (latSpec.sizeMm === undefined && firstOp === 'revolve');
    const size = typeof latSpec.sizeMm === 'number' && latSpec.sizeMm > 0 ? latSpec.sizeMm : 40;
    const halfSteps = Math.max(1, Math.round((size / 2) / (LATTICE_UNIT * 1000)));
    const lat = startEmpty ? createLattice(LATTICE_UNIT) : boxLattice(LATTICE_UNIT, halfSteps);
    const { subdiv, thicknessMm } = runLatticeOps(
      lat,
      Array.isArray(latSpec.ops) ? latSpec.ops : [],
      Number(latSpec.subdiv ?? b.latticeSubdiv ?? 0),
      Number(latSpec.thicknessMm ?? (b.latticeThickness ? b.latticeThickness * 1000 : 0)),
    );
    const cage = serializeCage(lat);
    const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(deserializeCage(cage), subdiv, thicknessMm / 1000);
    latticeFields = {
      isLattice: true,
      latticeCage: cage,
      latticeSubdiv: subdiv,
      ...(thicknessMm > 0 ? { latticeThickness: thicknessMm / 1000 } : {}),
      latticeVersion: 1,
      latticeOrigin: origin,
    };
    latticeGeoms = [{
      name: `${id}_mesh`,
      type: 'mesh',
      size: [1],
      rgba: normalizeRgba(b.rgba) ?? [0.55, 0.68, 0.85, 1],
      ...generatedMeshMass(b as { mass?: unknown; density?: unknown }),
      condim: 3,
      dynamic: true,
      latticeGeom: true,
      vertices,
      faces,
      renderVertices,
    }];
  }

  // Declarative sculpt spec on body (`sculpt: { base?: SculptBaseId, strokes?: [...], cuts?: [...] }`)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sculptSpec = (b as any).sculpt as {
    base?: SculptBaseId;
    /**
     * Longest side in mm, applied before the strokes. Omitted, the base stays
     * at BASE_SIZE (240 mm): scenes written before clay had a size place their
     * strokes on that, and would miss on anything smaller.
     */
    sizeMm?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    strokes?: Record<string, any>[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cuts?: Record<string, any>[];
  } | undefined;
  let sculptFields: Partial<SceneNode> | null = null;
  let sculptGeoms: RawGeom[] | null = null;
  if ((b as Record<string, unknown>).sculpt !== undefined && !isPlainObject((b as Record<string, unknown>).sculpt)) {
    throw new Error(`Body '${name}': sculpt must be a plain object.`);
  }
  if (sculptSpec && typeof sculptSpec === 'object') {
    if (sculptSpec.sizeMm !== undefined && (!isFiniteNumber(sculptSpec.sizeMm) || sculptSpec.sizeMm <= 0 || sculptSpec.sizeMm > 10_000)) {
      throw new Error(`Body '${name}': sculpt.sizeMm must be a positive finite number up to 10000.`);
    }
    const baseId = (sculptSpec.base ?? b.sculptBase ?? 'sphere') as SculptBaseId;
    if (!SCULPT_BASES.some((sb) => sb.id === baseId)) {
      throw new Error(`Unknown sculpt base '${baseId}'. Available: ${SCULPT_BASES.map((sb) => sb.id).join(', ')}`);
    }
    const mesh = typeof sculptSpec.sizeMm === 'number' && sculptSpec.sizeMm > 0
      ? buildSculptBaseSized(baseId, sculptSpec.sizeMm / 1000)
      : buildSculptBase(baseId);
    if (Array.isArray(sculptSpec.strokes)) {
      for (const s of sculptSpec.strokes) {
        if (!s || typeof s !== 'object') continue;
        const pts = pointList(s.at);
        if (!pts.length || pts.some((p: unknown) => !isFiniteVec3(p))) {
          throw new Error("sculpt stroke 'at' must be [x, y, z] or a list of them, with finite numbers in the body's own frame (metres)");
        }
        applySculptStroke(mesh, {
          brush: s.brush,
          at: pts,
          // An unsized base keeps the 40 mm brush it always had, so an old
          // scene's strokes come out as they did; sized clay gets one in
          // proportion (defaultRadiusFor).
          radius: s.radius ?? (sculptSpec.sizeMm ? undefined : 0.04),
          strength: s.strength,
          invert: s.invert,
          symmetryX: s.symmetryX,
          symmetry: s.symmetry,
          detail: s.detail,
          dynamicTopology: s.dynamicTopology,
          delta: s.delta,
          depthMm: s.depthMm,
          hardness: s.hardness,
        });
      }
    }
    const { vertices, renderVertices, faces } = toSceneGeom(mesh);
    sculptFields = {
      isSculpt: true,
      sculptBase: baseId,
      sculptEdited: Boolean(sculptSpec.strokes?.length || sculptSpec.cuts?.length),
      sculptVersion: 1,
    };
    sculptGeoms = [{
      name: `${id}_sculpt`,
      type: 'mesh',
      size: [0.12, 0.12, 0.12],
      rgba: normalizeRgba(b.rgba) ?? [0.82, 0.72, 0.62, 1],
      ...generatedMeshMass(b as { mass?: unknown; density?: unknown }),
      condim: 3,
      dynamic: true,
      vertices,
      faces,
      renderVertices,
    }];
  }

  // Record declarative post-body-creation ops (cuts, roundEdges, patterns, paint, sculpt.cuts)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bAny = b as Record<string, any>;
  const rawCuts = Array.isArray(bAny.cuts) ? bAny.cuts : undefined;
  const rawRoundEdges = bAny.roundEdges !== undefined ? bAny.roundEdges : bAny.roundings;
  const normRoundEdges = Array.isArray(rawRoundEdges)
    ? rawRoundEdges
    : rawRoundEdges && typeof rawRoundEdges === 'object'
      ? [rawRoundEdges]
      : undefined;
  const rawPatterns = Array.isArray(bAny.patterns)
    ? bAny.patterns
    : bAny.pattern && typeof bAny.pattern === 'object'
      ? [bAny.pattern]
      : undefined;
  const rawPaint = Array.isArray(bAny.paint)
    ? bAny.paint
    : bAny.paint && typeof bAny.paint === 'object'
      ? [bAny.paint]
      : undefined;
  const rawSculptCuts = Array.isArray(sculptSpec?.cuts) && sculptSpec!.cuts.length > 0
    ? sculptSpec!.cuts
    : undefined;

  const declarativeOps: PendingDeclarativeOps | null =
    (rawCuts || normRoundEdges || rawPatterns || rawPaint || rawSculptCuts)
      ? {
          ...(rawSculptCuts ? { sculptCuts: rawSculptCuts } : {}),
          ...(rawCuts ? { cuts: rawCuts } : {}),
          ...(normRoundEdges ? { roundEdges: normRoundEdges } : {}),
          ...(rawPatterns ? { patterns: rawPatterns } : {}),
          ...(rawPaint ? { paint: rawPaint } : {}),
        }
      : null;

  const bodyRgba = normalizeRgba(b.rgba);

  // Synthesize single geom when body-level geom properties are supplied without `geoms`
  const synthesizedSingleGeom: RawGeom[] = b.scad !== undefined
    ? [{
        type: 'mesh',
        size: [1],
        dynamic: true,
        ...(bodyRgba !== undefined ? { rgba: bodyRgba } : {}),
        ...(bAny.mass !== undefined ? { mass: bAny.mass } : {}),
        ...(bAny.density !== undefined ? { density: bAny.density } : {}),
        ...(bAny.friction !== undefined ? { friction: bAny.friction } : {}),
        ...(bAny.contype !== undefined ? { contype: bAny.contype } : {}),
        ...(bAny.conaffinity !== undefined ? { conaffinity: bAny.conaffinity } : {}),
        ...(bAny.condim !== undefined ? { condim: bAny.condim } : {}),
        ...(bAny.solref !== undefined ? { solref: bAny.solref } : {}),
        ...(bAny.solimp !== undefined ? { solimp: bAny.solimp } : {}),
      }]
    : [{
        type: (bAny.type && bAny.type !== 'body') ? bAny.type : 'box',
        ...(bAny.size !== undefined ? { size: bAny.size } : {}),
        ...(bodyRgba !== undefined ? { rgba: bodyRgba } : {}),
        ...(bAny.fromto !== undefined ? { fromto: bAny.fromto } : {}),
        ...(bAny.mass !== undefined ? { mass: bAny.mass } : {}),
        ...(bAny.density !== undefined ? { density: bAny.density } : {}),
        ...(bAny.friction !== undefined ? { friction: bAny.friction } : {}),
        ...(bAny.contype !== undefined ? { contype: bAny.contype } : {}),
        ...(bAny.conaffinity !== undefined ? { conaffinity: bAny.conaffinity } : {}),
        ...(bAny.condim !== undefined ? { condim: bAny.condim } : {}),
        ...(bAny.solref !== undefined ? { solref: bAny.solref } : {}),
        ...(bAny.solimp !== undefined ? { solimp: bAny.solimp } : {}),
        ...(bAny.radius !== undefined ? { radius: bAny.radius } : {}),
        ...(bAny.height !== undefined ? { height: bAny.height } : {}),
        ...(bAny.width !== undefined ? { width: bAny.width } : {}),
        ...(bAny.depth !== undefined ? { depth: bAny.depth } : {}),
        ...(bAny.majorRadius !== undefined ? { majorRadius: bAny.majorRadius } : {}),
        ...(bAny.minorRadius !== undefined ? { minorRadius: bAny.minorRadius } : {}),
        ...(bAny.tubeRadius !== undefined ? { tubeRadius: bAny.tubeRadius } : {}),
        ...(bAny.innerRadius !== undefined ? { innerRadius: bAny.innerRadius } : {}),
        ...(bAny.outerRadius !== undefined ? { outerRadius: bAny.outerRadius } : {}),
        ...(bAny.wallThickness !== undefined ? { wallThickness: bAny.wallThickness } : {}),
        ...(bAny.segments !== undefined ? { segments: bAny.segments } : {}),
        ...(bAny.radialSegments !== undefined ? { radialSegments: bAny.radialSegments } : {}),
        ...(bAny.tubularSegments !== undefined ? { tubularSegments: bAny.tubularSegments } : {}),
        ...(bAny.polygon !== undefined ? { polygon: bAny.polygon } : {}),
        ...(bAny.holes !== undefined ? { holes: bAny.holes } : {}),
        ...(bAny.centered !== undefined ? { centered: bAny.centered } : {}),
        ...(bAny.profile !== undefined ? { profile: bAny.profile } : {}),
        ...(bAny.vertices !== undefined ? { vertices: bAny.vertices } : {}),
        ...(bAny.verticesZUp !== undefined ? { verticesZUp: bAny.verticesZUp } : {}),
        ...(bAny.renderVertices !== undefined ? { renderVertices: bAny.renderVertices } : {}),
        ...(bAny.faces !== undefined ? { faces: bAny.faces } : {}),
        ...(bAny.thread !== undefined ? { thread: bAny.thread } : {}),
      }];

  // As for geoms, the caller's fields are kept (shatter settings, sculpt
  // flags...) - all but the transient declarative/shorthand fields above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rest = { ...b } as Record<string, any>;
  if (bodyRgba) rest.rgba = bodyRgba;
  delete rest.tuneTo;
  delete rest.drillNodalHole;
  delete rest.dynamic;
  delete rest.static;
  delete rest.fixed;
  delete rest.lattice;
  delete rest.sculpt;
  delete rest.cuts;
  delete rest.roundEdges;
  delete rest.roundings;
  delete rest.patterns;
  delete rest.pattern;
  delete rest.paint;
  delete rest.polygon;
  delete rest.holes;
  delete rest.centered;
  delete rest.profile;
  delete rest.vertices;
  delete rest.verticesZUp;
  delete rest.renderVertices;
  delete rest.faces;
  delete rest.majorRadius;
  delete rest.minorRadius;
  delete rest.tubeRadius;
  delete rest.innerRadius;
  delete rest.outerRadius;
  delete rest.wallThickness;
  delete rest.radialSegments;
  delete rest.tubularSegments;

  const chosenGeoms = curveGeoms ?? latticeGeoms ?? sculptGeoms ?? b.geoms ?? (logical ? [] : synthesizedSingleGeom);
  const resolvedGeoms = chosenGeoms.map((g: RawGeom, i: number) =>
    fillGeomDefaults(
      g.rgba === undefined && bodyRgba !== undefined && g.csg !== 'difference'
        ? { ...g, rgba: bodyRgba }
        : g,
      name,
      i,
      moves,
    ),
  );

  const builtChildren: SceneNode[] = [];
  try {
    for (const c of b.children ?? []) {
      builtChildren.push(fillBodyDefaults(c, moves, opsMap));
    }
  } catch (err) {
    clearPendingDeclarativeOps(builtChildren, opsMap);
    throw err;
  }

  const node: SceneNode = {
    ...(rest as SceneNode),
    ...(generated ? { bodyForm: clampBodyForm((b as { bodyForm: Partial<BodyFormMeasurements> }).bodyForm) } : {}),
    ...(latticeFields ?? {}),
    ...(sculptFields ?? {}),
    id,
    name,
    type:     'body',
    // A nested body's pos is relative to its parent, so the top-level
    // default (a metre up, to drop onto the floor) would float it off the part.
    // A body that falls is dropped from a metre up; one that cannot move (a
    // frame, a wall) stays where it is drawn, rather than floating a metre up.
    pos:      latticeFields
      // A declarative lattice's `pos` names its cage origin, as
      // physics_create_lattice's does (utils/latticeFrame.ts).
      ? latticeBodyPos(b.pos ?? (nested || !moves ? [0, 0, 0] : [0, 0, 1]), latticeFields.latticeOrigin, b)
      : b.pos ?? (nested || !moves ? [0, 0, 0] : [0, 0, 1]),
    ...(b.quat  !== undefined ? { quat: b.quat }   : {}),
    ...(b.euler !== undefined ? { euler: b.euler } : {}),
    geoms:    resolvedGeoms,
    joints:   resolvedJoints,
    children: builtChildren,
    ...(b.coupleTargetId  !== undefined ? { coupleTargetId: b.coupleTargetId }   : {}),
    ...(b.coupleRatio     !== undefined ? { coupleRatio: b.coupleRatio }         : {}),
    ...(b.weldTargetId    !== undefined ? { weldTargetId: b.weldTargetId }       : {}),
    ...(b.connectTargetId !== undefined ? { connectTargetId: b.connectTargetId } : {}),
    ...(b.connectAnchor   !== undefined ? { connectAnchor: b.connectAnchor }     : {}),
    ...(b.weldBreakForceN    !== undefined ? { weldBreakForceN: b.weldBreakForceN }       : {}),
    ...(b.weldBreakTorqueNm  !== undefined ? { weldBreakTorqueNm: b.weldBreakTorqueNm }   : {}),
    ...(b.weldBreakHoldSteps !== undefined ? { weldBreakHoldSteps: b.weldBreakHoldSteps } : {}),
    ...(b.script          !== undefined ? { script: b.script }                   : {}),
    ...(b.scad            !== undefined ? { scad: b.scad }                       : {}),
    ...(b.isComposite     !== undefined ? { isComposite: b.isComposite }         : {}),
    ...(b.compositeType   !== undefined ? { compositeType: b.compositeType }     : {}),
    ...(b.compositeCount  !== undefined ? { compositeCount: b.compositeCount }   : {}),
    ...(b.compositeSize   !== undefined ? { compositeSize: b.compositeSize }     : {}),
    ...(b.compositePrefix !== undefined ? { compositePrefix: b.compositePrefix } : {}),
    ...(b.compositeCurve  !== undefined ? { compositeCurve: b.compositeCurve }   : {}),
    ...(b.weldLastToId    !== undefined ? { weldLastToId: b.weldLastToId }       : {}),
    // Boolean modifiers: a body whose geoms carry csg:'difference' is compiled
    // into a single mesh (see utils/csg.ts). csgEnabled is inferred when the
    // caller marked a negative but forgot the flag, since a negative geom is
    // meaningless without it and silently rendering it as a solid is worse.
    // Rounded and bevelled edges are a boolean too (utils/edgeRound.ts), and
    // so is a threaded rod, which MuJoCo can only draw as a plain cylinder.
    ...((b.csgEnabled === true || resolvedGeoms.some((g: SceneGeom) => g.csg === 'difference' || g.csg === 'intersection' ||
      (g.type === 'cylinder' && (g.thread?.pitch ?? 0) > 0)) ||
      (Array.isArray(b.edgeRounds) && b.edgeRounds.length > 0))
      ? { csgEnabled: true } : {}),
    ...(Array.isArray(b.edgeRounds) ? { edgeRounds: b.edgeRounds } : {}),
    ...(b.csgCollision !== undefined ? { csgCollision: b.csgCollision } : {}),
    // How ANY mesh body collides — see utils/convexDecomposition.ts. Supersedes
    // csgCollision, which is still accepted above so older callers keep working.
    ...(b.collision      !== undefined ? { collision: b.collision }           : {}),
    ...(b.collisionHulls !== undefined ? { collisionHulls: b.collisionHulls } : {}),
    ...(b.collisionResolution !== undefined ? { collisionResolution: b.collisionResolution } : {}),
    ...(b.collisionMass  !== undefined ? { collisionMass: b.collisionMass }   : {}),
    ...(b.csgSectors   !== undefined ? { csgSectors: b.csgSectors }     : {}),
    ...(b.csgHoleAxis  !== undefined ? { csgHoleAxis: b.csgHoleAxis }   : {}),
    ...(b.csgMass      !== undefined ? { csgMass: b.csgMass }           : {}),
    ...(b.csgFn        !== undefined ? { csgFn: b.csgFn }               : {}),
    ...(b.isCurve === true ? {
      isCurve: true,
      curvePoints:    b.curvePoints    ?? DEFAULT_CURVE_POINTS.map((p: number[]) => [...p]),
      curveWidth:     b.curveWidth     ?? DEFAULT_CURVE_WIDTH,
      curveThickness: b.curveThickness ?? DEFAULT_CURVE_THICKNESS,
      curveSegments:  b.curveSegments  ?? DEFAULT_CURVE_SEGMENTS,
      curveClosed:    b.curveClosed === true,
      curveBank:      b.curveBank      ?? 0,
    } : {}),
  };
  // A body free to move, given no pos, stands on the floor where it is drawn
  // instead of falling from a metre up; a metre up only while its extent is
  // not known (an OpenSCAD body not compiled yet).
  if (b.pos === undefined && !nested && moves && !latticeFields) {
    const own = sceneContentBounds([{ ...node, pos: [0, 0, 0] }]);
    if (own && Number.isFinite(own.min[2]) && own.max[2] > own.min[2]) node.pos = [0, 0, Math.round(-own.min[2] * 1e6) / 1e6];
  }
  // Acoustic specs are filled and checked, then `tuneTo` (transient: it is a
  // request, not a field; tunedPitchHz records what it did) is applied.
  try {
    normalizeAcousticFields(node);
    let out = node;
    if (bAny.tuneTo !== undefined) {
      const spec = parseTuneTo(bAny.tuneTo, bAny.drillNodalHole);
      out = applyTuneTo(node, spec);
      if (node.acousticString || node.acousticMembrane) retuneWithScene.set(out, spec);
    }
    if (isPlainObject(bAny.flexure)) {
      const applied = applyFlexureToNode(out, bAny.flexure as FlexureDesignInput);
      if (applied) out = applied.node;
    }
    checkIncomingBody(out, resolvedJoints.length > 0);
    if (declarativeOps) opsMap.set(id, declarativeOps);
    return out;
  } catch (err) {
    clearPendingDeclarativeOps(builtChildren, opsMap);
    throw err;
  }
};
