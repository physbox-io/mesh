// The pour box's two ends that touch the app: putting it into the scene (one
// undo step, a note card section) and handing over its STLs. The geometry is
// utils/siliconeMold.ts and the scene edit utils/pourBoxScene.ts, both pure.

import { useStore } from '../store/useStore';
import { putNoteSection } from './noteSection';
import { exportBinarySTL, type Triangle3D } from './moldExporter';
import { planPourBox, pourBoxNotes, sceneWithPourBox } from './pourBoxScene';
import type { PourBox, PourBoxMesh, PourBoxOptions } from './siliconeMold';
import { findNodeById } from './sceneTree';

export interface AddedPourBox {
  box: PourBox;
  baseId: string;
  sleeveId: string;
  holePinId?: string;
  /** Left selected: master, base and sleeve, which is what Cast pours the silicone into. */
  selected: string[];
  /** The box made before round the same masters, which this one replaced. */
  replaced: { id: string; name: string }[];
}

/** Plans the pour box round `ids` and adds it to the scene. */
export async function addPourBoxToScene(ids: string[], options: Partial<PourBoxOptions>, planned?: PourBox): Promise<AddedPourBox> {
  const store = useStore.getState();
  const box = planned ?? await planPourBox(store.sceneGraph, ids, options);
  const out = sceneWithPourBox(useStore.getState().sceneGraph, ids, box, options);
  useStore.getState().updateScene(out.scene);

  const name = findNodeById(out.scene.nodes, ids[0])?.name ?? 'the master';
  putNoteSection(pourBoxNotes(name, box, Boolean(out.holePinId)).join('\n'), `note_card_${out.baseId}`);
  // The next step is pouring the silicone, so the bodies it is poured into are
  // left selected, the master first.
  const selected = [...ids, out.baseId, out.sleeveId];
  useStore.getState().selectMany(selected, false);
  return { box, baseId: out.baseId, sleeveId: out.sleeveId, ...(out.holePinId ? { holePinId: out.holePinId } : {}), selected, replaced: out.replaced };
}

/**
 * One printed piece as a binary STL, in mm, standing on z = 0 and centred in
 * plan as every printed export is, not wherever the master stood in the scene.
 */
export function pourBoxStl(mesh: PourBoxMesh, label: string): Uint8Array {
  const p = mesh.positions;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) { lo[i % 3] = Math.min(lo[i % 3], p[i]); hi[i % 3] = Math.max(hi[i % 3], p[i]); }
  const shift = p.length ? [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]] : [0, 0, 0];
  const at = (i: number): [number, number, number] => [p[i * 3] - shift[0], p[i * 3 + 1] - shift[1], p[i * 3 + 2] - shift[2]];
  const tris: Triangle3D[] = [];
  for (let f = 0; f + 2 < mesh.faces.length; f += 3) {
    tris.push({ a: at(mesh.faces[f]), b: at(mesh.faces[f + 1]), c: at(mesh.faces[f + 2]) });
  }
  return exportBinarySTL(tris, `PhysBox pour box ${label}`.slice(0, 78));
}
