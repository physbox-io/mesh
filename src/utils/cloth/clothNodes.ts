/**
 * Scene nodes for body forms and the garments modelled on them. Shared by the
 * store, MCP and presets.
 */

import type { BodyFormMeasurements, GarmentDraft } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { bodyFormGeoms, clampBodyForm } from './bodyForm';
import { GARMENT_DEFAULTS } from './garments';
import { bodyFormKey, finishBodyFormGeoms } from './bodyFormEdit';
import { bodyLocalMatrix, walkBodiesWorld } from '../bodyWorld';
import * as THREE from 'three';

/** A static dress form standing at `pos`. */
export function bodyFormNode(id: string, name: string, measurements: Partial<BodyFormMeasurements> = {}, pos: number[] = [0, 0, 0]): SceneNode {
  const m = clampBodyForm(measurements);
  const node = { id, name, pos: [...pos], bodyForm: m, geoms: finishBodyFormGeoms(bodyFormGeoms(m, name)), joints: [], children: [] } as unknown as SceneNode;
  node.bodyFormBuilt = bodyFormKey(node);
  return node;
}

/**
 * A dress form authored as measurements alone (`geoms: []`), so presets load
 * at once without meshing on the main thread; `useCsgCompile` (and headless
 * `prepareScene`) builds its geoms when the scene is opened or compiled.
 */
export function lazyBodyFormNode(id: string, name: string, measurements: Partial<BodyFormMeasurements> = {}, pos: number[] = [0, 0, 0]): SceneNode {
  const m = clampBodyForm(measurements);
  return { id, name, pos: [...pos], bodyForm: m, geoms: [], joints: [], children: [] } as unknown as SceneNode;
}

/**
 * The node's geoms, regenerated from its measurements, here and now. The
 * editor rebuilds a changed form in a worker instead (useCsgCompile).
 */
export function rebuildBodyForm(node: SceneNode): void {
  if (!node.bodyForm) return;
  node.bodyForm = clampBodyForm(node.bodyForm);
  node.geoms = finishBodyFormGeoms(bodyFormGeoms(node.bodyForm, node.name || node.id));
  node.bodyFormBuilt = bodyFormKey(node);
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

/**
 * A garment on no form, cut to `measurements` and standing at `pos` as it
 * would be worn on a form of them there: with nothing inside it, it falls
 * when the scene plays.
 */
export function looseGarmentNode(id: string, name: string, draft: Omit<GarmentDraft, 'fitTo' | 'form'>, measurements: Partial<BodyFormMeasurements>, pos: number[]): SceneNode {
  const garment: GarmentDraft = { ...draft, form: clampBodyForm(measurements) };
  return {
    id, name, pos: [...pos],
    cloth: { garment, material: draft.material ?? GARMENT_DEFAULTS[draft.garment].material },
    geoms: [], joints: [], children: [],
  } as unknown as SceneNode;
}

/**
 * `nodes` with every garment fitted to one of `forms` let go of it: cut to
 * that form's measurements as it was, on no form. How deleting a form leaves
 * what it wore to fall, rather than naming a form that is not there (the
 * scene would not build).
 */
export function releaseGarments(nodes: SceneNode[], forms: SceneNode[]): SceneNode[] {
  const worldPose = new Map<string, THREE.Matrix4>();
  const recordPose = (list: SceneNode[]) => walkBodiesWorld(list, (f, w) => {
    if (f.bodyForm) worldPose.set(f.name || f.id, w);
  });
  recordPose(forms);
  recordPose(nodes);
  const by = new Map(forms.filter((f) => f.bodyForm).map((f) => [f.name || f.id, { m: f.bodyForm!, form: f, world: worldPose.get(f.name || f.id) }]));
  if (!by.size) return nodes;
  const walk = (list: SceneNode[], parentWorld = new THREE.Matrix4()): SceneNode[] => {
    const out = list.map((n) => one(n, parentWorld));
    return out.every((n, i) => n === list[i]) ? list : out;
  };
  const one = (n: SceneNode, parentWorld: THREE.Matrix4): SceneNode => {
    const ownWorld = parentWorld.clone().multiply(bodyLocalMatrix(n));
    const children = n.children?.length ? walk(n.children, ownWorld) : n.children;
    const draft = n.cloth?.garment, hit = draft?.fitTo ? by.get(draft.fitTo) : undefined;
    if (!hit && children === n.children) return n;
    if (!hit) return { ...n, children };
    const { fitTo: _fitTo, ...rest } = draft!;
    // Preserve the deleted form's world pose on the released garment so it falls in place rather than teleporting to [0, 0, 0].
    let pos: number[] = [...(hit.form.pos ?? n.pos ?? [0, 0, 0])];
    let quat: number[] | undefined = hit.form.quat ? [...hit.form.quat] : undefined;
    let euler: number[] | undefined = !quat && hit.form.euler ? [...hit.form.euler] : undefined;
    if (hit.world) {
      const localM = parentWorld.clone().invert().multiply(hit.world);
      const lp = new THREE.Vector3(), lq = new THREE.Quaternion(), ls = new THREE.Vector3();
      localM.decompose(lp, lq, ls);
      pos = [lp.x, lp.y, lp.z];
      const isIdentity = Math.abs(lq.w - 1) < 1e-9 && Math.abs(lq.x) < 1e-9 && Math.abs(lq.y) < 1e-9 && Math.abs(lq.z) < 1e-9;
      if (!isIdentity) {
        if (!hit.form.quat && hit.form.euler && parentWorld.equals(new THREE.Matrix4())) {
          quat = undefined;
          euler = [...hit.form.euler];
        } else {
          quat = [lq.w, lq.x, lq.y, lq.z];
          euler = undefined;
        }
      } else {
        quat = undefined;
        euler = undefined;
      }
    }
    const next: SceneNode = { ...n, pos, children, cloth: { ...n.cloth!, garment: { ...rest, form: structuredClone(hit.m) } } };
    if (quat) { next.quat = quat; delete next.euler; }
    else if (euler) { next.euler = euler; delete next.quat; }
    else { delete next.quat; delete next.euler; }
    return next;
  };
  return walk(nodes);
}
