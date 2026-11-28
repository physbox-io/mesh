/**
 * Editing a body form: merging a change into its measurements, telling
 * whether its geoms are out of date, and finishing the geoms a build made.
 * Shared by the store (updateNode), the background compiler, presets and MCP.
 */

import type { BodyFormMeasurements } from '../../types/cloth';
import type { SceneGeom, SceneNode } from '../../types/scene';
import { clampBodyForm, skinToneRgba } from './bodyForm';
import { promoteMeshGeomsToDynamic } from '../../store/meshGeomTransforms';

/**
 * A change merged into a form's measurements, clamped. Fields not given keep
 * their values, except when the figure changes: then the form starts again
 * from the new figure's typical measurements, plus whatever else was given,
 * so switching a male form to female does not give her his chest and neck
 * (preserving visual `skinTone` unless explicitly changed).
 */
export function mergeBodyForm(prev: BodyFormMeasurements | undefined, patch: Partial<BodyFormMeasurements>): BodyFormMeasurements {
  const refigured = !prev || (patch.figure !== undefined && patch.figure !== prev.figure);
  const keptTone = refigured && prev?.skinTone !== undefined && !('skinTone' in patch) ? { skinTone: prev.skinTone } : {};
  return clampBodyForm(refigured ? { ...keptTone, ...patch } : { ...prev, ...patch });
}

/**
 * What a form's 3D mesh geoms are built from: its anatomical measurements and
 * pose alone (renaming renames geom prefixes in-place, and changing `skinTone`
 * recolours `geoms` in O(1) without re-meshing or re-settling garments).
 */
export function bodyFormKey(node: Pick<SceneNode, 'bodyForm'>): string {
  const m = (node.bodyForm ?? {}) as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(m).filter((k) => k !== 'skinTone').sort().map((k) => [k, m[k]]));
}

/** Whether a form's geoms were built from something other than its measurements as they now are. */
export function needsBodyFormBuild(node: SceneNode): boolean {
  return !!node.bodyForm && (!node.geoms?.length || node.bodyFormBuilt !== bodyFormKey(node));
}

/** Update every geom's visual `rgba` in O(1) (sharing vertex/face buffers by reference) for a new `skinTone`. */
export function applySkinTone(geoms: SceneGeom[], skinTone?: number | null): SceneGeom[] {
  const rgba = skinToneRgba(skinTone);
  return geoms.map((g) => ({ ...g, rgba: [...rgba] }));
}

/**
 * Geoms fresh from bodyFormGeoms, made ready for this node: marked internal
 * (the tree lists the form, not its forty primitives), and its meshes drawn
 * at the body's transform. Their vertices are in the form's own frame, as the
 * compiler places them; drawn as static meshes (taken as world space) a form
 * standing anywhere but the origin had its torso, head and limbs drawn at the
 * origin, its capsule hands and feet where it stood.
 */
export function finishBodyFormGeoms(geoms: SceneGeom[], skinTone?: number | null): SceneGeom[] {
  const rgba = skinTone !== undefined ? skinToneRgba(skinTone) : undefined;
  // Its meshes are made from its measurements and replaced, not edited, when they change: each goes
  // into the physics worker's file cache on its first build (sent as XML text, a form was 4.5 MB of it).
  const holder = { geoms: geoms.map((g) => ({ ...g, internal: true, ...(g.type === 'mesh' ? { stableMesh: true } : {}), ...(rgba ? { rgba: [...rgba] } : {}) })) } as unknown as SceneNode;
  promoteMeshGeomsToDynamic(holder);
  return holder.geoms;
}
