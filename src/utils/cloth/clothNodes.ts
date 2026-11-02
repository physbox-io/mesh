/**
 * Scene nodes for body forms and the garments drafted onto them, and the
 * redraft that keeps the two in step. Shared by the store, MCP and presets.
 */

import type { BodyFormMeasurements, GarmentDraft } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { bodyFormGeoms, clampBodyForm } from './bodyForm';
import { draftGarment } from './garments';

/** A static dress form standing at `pos`. */
export function bodyFormNode(id: string, name: string, measurements: Partial<BodyFormMeasurements> = {}, pos: number[] = [0, 0, 0]): SceneNode {
  const m = clampBodyForm(measurements);
  return { id, name, pos: [...pos], bodyForm: m, geoms: bodyFormGeoms(m, name), joints: [] } as SceneNode;
}

/** The node's geoms, regenerated from its measurements. */
export function rebuildBodyForm(node: SceneNode): void {
  if (!node.bodyForm) return;
  node.bodyForm = clampBodyForm(node.bodyForm);
  node.geoms = bodyFormGeoms(node.bodyForm, node.name || node.id);
}

/** A garment cut for `form`, placed in the form's frame. */
export function garmentNode(id: string, name: string, draft: Omit<GarmentDraft, 'fitTo'>, form: SceneNode): SceneNode {
  if (!form.bodyForm) throw new Error(`'${form.name}' is not a body form`);
  const full: GarmentDraft = { ...draft, fitTo: form.name || form.id };
  return {
    id, name,
    pos: [...(form.pos ?? [0, 0, 0])],
    ...(form.quat ? { quat: [...form.quat] } : form.euler ? { euler: [...form.euler] } : {}),
    cloth: draftGarment(full, form.bodyForm),
    joints: [],
  } as SceneNode;
}

/**
 * Redraft every garment fitted to `form` (a top-level node list is enough:
 * forms and garments are placed side by side). Mutates the nodes given.
 */
export function redraftGarmentsFor(nodes: SceneNode[], form: SceneNode): void {
  if (!form.bodyForm) return;
  const formName = form.name || form.id;
  const visit = (list: SceneNode[]) => {
    for (const n of list) {
      const d = n.cloth?.draft;
      if (d && d.fitTo === formName) {
        const keep = n.cloth!;
        n.cloth = { ...draftGarment(d, form.bodyForm!), sewTime: keep.sewTime, selfCollide: keep.selfCollide, ...(keep.spacing ? { spacing: keep.spacing } : {}) };
        n.pos = [...(form.pos ?? [0, 0, 0])];
      }
      if (n.children) visit(n.children);
    }
  };
  visit(nodes);
}
