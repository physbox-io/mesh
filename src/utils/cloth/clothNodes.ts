/**
 * Scene nodes for body forms and the garments modelled on them. Shared by the
 * store, MCP and presets.
 */

import type { BodyFormMeasurements, GarmentDraft } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { bodyFormGeoms, clampBodyForm } from './bodyForm';
import { GARMENT_DEFAULTS } from './garments';

/** A static dress form standing at `pos`. */
export function bodyFormNode(id: string, name: string, measurements: Partial<BodyFormMeasurements> = {}, pos: number[] = [0, 0, 0]): SceneNode {
  const m = clampBodyForm(measurements);
  return { id, name, pos: [...pos], bodyForm: m, geoms: bodyFormGeoms(m, name), joints: [], children: [] } as unknown as SceneNode;
}

/** The node's geoms, regenerated from its measurements. */
export function rebuildBodyForm(node: SceneNode): void {
  if (!node.bodyForm) return;
  node.bodyForm = clampBodyForm(node.bodyForm);
  node.geoms = bodyFormGeoms(node.bodyForm, node.name || node.id);
}

/**
 * A garment modelled on `form`, standing where it stands. Its shape is not
 * stored: it is worked out from the draft and the form's measurements each
 * time the scene is built, so changing the form refits it.
 */
export function garmentNode(id: string, name: string, draft: Omit<GarmentDraft, 'fitTo'>, form: SceneNode): SceneNode {
  if (!form.bodyForm) throw new Error(`'${form.name}' is not a body form`);
  const garment: GarmentDraft = { ...draft, fitTo: form.name || form.id };
  return {
    id, name,
    pos: [...(form.pos ?? [0, 0, 0])],
    ...(form.quat ? { quat: [...form.quat] } : form.euler ? { euler: [...form.euler] } : {}),
    cloth: { garment, material: draft.material ?? GARMENT_DEFAULTS[draft.garment].material },
    geoms: [],
    joints: [],
    children: [],
  } as unknown as SceneNode;
}
