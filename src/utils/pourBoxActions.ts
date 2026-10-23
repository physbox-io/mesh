// The pour box's two ends that touch the app: putting it into the scene (one
// undo step, a note card section) and handing over its STLs. The geometry is
// utils/siliconeMold.ts and the scene edit utils/pourBoxScene.ts, both pure.

import { useStore } from '../store/useStore';
import { physicsGlobals } from '../physicsGlobals';
import { exportBinarySTL, type Triangle3D } from './moldExporter';
import { planPourBox, pourBoxNotes, sceneWithPourBox } from './pourBoxScene';
import type { PourBox, PourBoxMesh, PourBoxOptions } from './siliconeMold';
import { findNodeById } from './sceneTree';

export interface AddedPourBox {
  box: PourBox;
  baseId: string;
  sleeveId: string;
  pinId?: string;
}

/** Plans the pour box round `ids` and adds it to the scene. */
export async function addPourBoxToScene(ids: string[], options: Partial<PourBoxOptions>, planned?: PourBox): Promise<AddedPourBox> {
  const store = useStore.getState();
  const box = planned ?? await planPourBox(store.sceneGraph, ids, options);
  const out = sceneWithPourBox(useStore.getState().sceneGraph, ids, box);
  useStore.getState().updateScene(out.scene);

  const name = findNodeById(out.scene.nodes, ids[0])?.name ?? 'the master';
  const section = pourBoxNotes(name, box).join('\n');
  const [card, ...rest] = physicsGlobals._physics_getNoteCards?.() ?? [];
  physicsGlobals._physics_setNoteCards?.(card
    ? [{ ...card, markdown: `${card.markdown.trimEnd()}\n\n${section}` }, ...rest]
    : [{ id: `note_card_${out.baseId}`, markdown: section, minimized: true, x: 16, y: 16 }]);
  return { box, baseId: out.baseId, sleeveId: out.sleeveId, ...(out.pinId ? { pinId: out.pinId } : {}) };
}

/** One printed piece as a binary STL, in mm. */
export function pourBoxStl(mesh: PourBoxMesh, label: string): Uint8Array {
  const p = mesh.positions;
  const at = (i: number): [number, number, number] => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const tris: Triangle3D[] = [];
  for (let f = 0; f + 2 < mesh.faces.length; f += 3) {
    tris.push({ a: at(mesh.faces[f]), b: at(mesh.faces[f + 1]), c: at(mesh.faces[f + 2]) });
  }
  return exportBinarySTL(tris, `PhysBox pour box ${label}`.slice(0, 78));
}
