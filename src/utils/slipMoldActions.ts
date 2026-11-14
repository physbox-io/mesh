// The slip-cast mold's ends that touch the app: putting it into the scene
// (one undo step, a note card section) and handing over the cases' STLs.

import { useStore } from '../store/useStore';
import { physicsGlobals } from '../physicsGlobals';
import { findNodeById } from './sceneTree';
import { pourBoxStl } from './pourBoxActions';
import { planSlipMold } from './slipMoldClient';
import { pieceKey, sceneWithSlipMold, slipMoldNotes } from './slipMoldScene';
import type { SlipMold, SlipMoldOptions } from './slipCastMold';
import type { SlipCastResult } from './slipCastSimulation';
import { addSimulationToScene, sceneStockTransform } from '../hooks/useAddSimulation';

export interface AddedSlipMold {
  mold: SlipMold;
  plasterIds: string[];
  caseIds: string[];
}

/** Plans the mold round `ids` (unless given one planned) and adds it to the scene. */
export async function addSlipMoldToScene(ids: string[], options: Partial<SlipMoldOptions>, planned?: SlipMold): Promise<AddedSlipMold> {
  const mold = planned ?? await planSlipMold(useStore.getState().sceneGraph, ids, options);
  const scene = useStore.getState().sceneGraph;
  const name = ids.length === 1 ? findNodeById(scene.nodes, ids[0])?.name ?? 'part' : 'part';
  const out = sceneWithSlipMold(scene, name, mold);
  useStore.getState().updateScene(out.scene);

  const section = slipMoldNotes(name, mold).join('\n');
  const [card, ...rest] = physicsGlobals._physics_getNoteCards?.() ?? [];
  physicsGlobals._physics_setNoteCards?.(card
    ? [{ ...card, markdown: `${card.markdown.trimEnd()}\n\n${section}` }, ...rest]
    : [{ id: `note_card_${out.caseIds[0]}`, markdown: section, minimized: true, x: 16, y: 16 }]);
  // The cases are what goes to the printer next.
  useStore.getState().selectMany(out.caseIds, false);
  return { mold, plasterIds: out.plasterIds, caseIds: out.caseIds };
}

/** Each case as a binary STL, stood as it prints, with its file name stem. */
export function slipCaseStls(name: string, mold: SlipMold): { file: string; bytes: Uint8Array }[] {
  return mold.pieces.map((p) => ({ file: `${name}_slip_case_${pieceKey(p.name)}`, bytes: pourBoxStl(p.casePrint, `slip case ${p.name}`) }));
}

/** The input a cast simulation takes from a planned mold. */
export function slipCastInput(mold: SlipMold) {
  const r = mold.report;
  return { cavity: mold.cavity, partTopMm: r.partTopMm, footMm: r.footMm, scale: r.scale, slip: mold.slip };
}

/** The simulated casting beside the part, as it stands; selected. */
export async function addSlipCastToScene(cast: SlipCastResult, mold: SlipMold) {
  return addSimulationToScene({
    mesh: cast.mesh,
    transform: sceneStockTransform(),
    kind: 'cast',
    label: `${mold.report.slipName} slip casting`,
    placement: 'beside',
    details: [
      `${cast.weightG} g fired, ${cast.sizeMm[0]} × ${cast.sizeMm[1]} × ${cast.sizeMm[2]} mm`,
      ...cast.notes,
    ],
    material: mold.slip,
    select: true,
  });
}
