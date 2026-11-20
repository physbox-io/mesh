/**
 * Editing a body form: merging a change into its measurements, telling
 * whether its geoms are out of date, and finishing the geoms a build made.
 * Shared by the store (updateNode), the background compiler, presets and MCP.
 */

import type { BodyFormMeasurements } from '../../types/cloth';
import type { SceneGeom, SceneNode } from '../../types/scene';
import { clampBodyForm } from './bodyForm';
import { promoteMeshGeomsToDynamic } from '../../store/meshGeomTransforms';

/**
 * A change merged into a form's measurements, clamped. Fields not given keep
 * their values, except when the figure changes: then the form starts again
 * from the new figure's typical measurements, plus whatever else was given,
 * so switching a male form to female does not give her his chest and neck.
 */
export function mergeBodyForm(prev: BodyFormMeasurements | undefined, patch: Partial<BodyFormMeasurements>): BodyFormMeasurements {
  const refigured = !prev || (patch.figure !== undefined && patch.figure !== prev.figure);
  return clampBodyForm(refigured ? { ...patch } : { ...prev, ...patch });
}

/** What a form's geoms are built from: its measurements alone (renaming renames geom prefixes in-place without re-meshing). */
export function bodyFormKey(node: Pick<SceneNode, 'bodyForm'>): string {
  const m = (node.bodyForm ?? {}) as unknown as Record<string, unknown>;
  return JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
}

/** Whether a form's geoms were built from something other than its measurements as they now are. */
export function needsBodyFormBuild(node: SceneNode): boolean {
  return !!node.bodyForm && (!node.geoms?.length || node.bodyFormBuilt !== bodyFormKey(node));
}

/**
 * Geoms fresh from bodyFormGeoms, made ready for this node: marked internal
 * (the tree lists the form, not its forty primitives), and its meshes drawn
 * at the body's transform. Their vertices are in the form's own frame, as the
 * compiler places them; drawn as static meshes (taken as world space) a form
 * standing anywhere but the origin had its torso, head and limbs drawn at the
 * origin, its capsule hands and feet where it stood.
 */
export function finishBodyFormGeoms(geoms: SceneGeom[]): SceneGeom[] {
  const holder = { geoms: geoms.map((g) => ({ ...g, internal: true })) } as unknown as SceneNode;
  promoteMeshGeomsToDynamic(holder);
  return holder.geoms;
}
