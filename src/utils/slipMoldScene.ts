// The slip-cast mold (utils/slipCastMold.ts) as bodies in the scene: the
// plaster pieces assembled round the part, see-through so the part shows,
// and the printed cases beside it in a row, each stood as it prints. One undo
// step, and pure: the store end is slipMoldActions.ts.

import type { SceneGraph, SceneNode } from '../types/scene';
import { meshBody } from './pourBoxScene';
import type { SlipMesh, SlipMold } from './slipCastMold';

const PLASTER_RGBA = [0.96, 0.95, 0.9, 0.45];
const CASE_RGBA = [0.92, 0.55, 0.22, 1];

function bounds(m: SlipMesh): { lo: number[]; hi: number[] } {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < m.positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], m.positions[i]);
    hi[i % 3] = Math.max(hi[i % 3], m.positions[i]);
  }
  return { lo, hi };
}

function shifted(m: SlipMesh, d: [number, number, number]): SlipMesh {
  return { positions: m.positions.map((v, i) => v + d[i % 3]), faces: m.faces };
}

/** File-safe piece name: 'side 1' -> 'side1'. */
export const pieceKey = (name: string) => name.replace(/\s+/g, '');

/**
 * The scene with the mold added: plaster pieces in place, cases in a row past
 * the mold's +X side, gaps of 20 mm, standing on the mold's floor.
 */
export function sceneWithSlipMold(scene: SceneGraph, partName: string, mold: SlipMold): { scene: SceneGraph; plasterIds: string[]; caseIds: string[] } {
  const tag = Math.random().toString(36).slice(2, 7);
  const slip = mold.report.slipName;
  const added: SceneNode[] = [];
  const plasterIds: string[] = [], caseIds: string[] = [];
  let maxX = -Infinity, floor = Infinity, midY = 0;
  for (const p of mold.pieces) {
    const b = bounds(p.plaster);
    maxX = Math.max(maxX, b.hi[0]);
    floor = Math.min(floor, b.lo[2]);
    midY += (b.lo[1] + b.hi[1]) / 2 / mold.pieces.length;
  }
  for (const p of mold.pieces) {
    const id = `slipplaster_${pieceKey(p.name)}_${tag}`;
    added.push({ ...meshBody(id, `${partName}_plaster_${pieceKey(p.name)}`, p.plaster, PLASTER_RGBA), slipMold: { piece: p.name, role: 'plaster', slip } });
    plasterIds.push(id);
  }
  let x = maxX + 20;
  for (const p of mold.pieces) {
    const b = bounds(p.casePrint);
    const placed = shifted(p.casePrint, [x - b.lo[0], midY - (b.lo[1] + b.hi[1]) / 2, floor - b.lo[2]]);
    x += b.hi[0] - b.lo[0] + 20;
    const id = `slipcase_${pieceKey(p.name)}_${tag}`;
    added.push({ ...meshBody(id, `${partName}_case_${pieceKey(p.name)}`, placed, CASE_RGBA), slipMold: { piece: p.name, role: 'case', slip } });
    caseIds.push(id);
  }
  return { scene: { ...scene, nodes: [...scene.nodes, ...added] }, plasterIds, caseIds };
}

/** Lines for the scene's note card. */
export function slipMoldNotes(partName: string, mold: SlipMold): string[] {
  const r = mold.report;
  const pieces = mold.pieces.map((p) => p.name).join(', ');
  return [
    `## Slip-cast mold for ${partName}`,
    '',
    `- ${mold.pieces.length} plaster pieces (${pieces}); block ${r.blockMm[0]} × ${r.blockMm[1]} × ${r.blockMm[2]} mm.`,
    `- Grown ${((r.scale - 1) * 100).toFixed(1)}% for ${r.slipName.toLowerCase()}'s ${r.shrinkPercent}% shrink, so the fired piece comes out as modelled.`,
    `- Print the ${mold.pieces.length} cases open side up. Coat them with mold release, then fill each to the brim with pottery plaster: ${r.plasterPowderG} g powder into ${r.plasterWaterG} g water for all of them (100:70; mix ~10% extra).`,
    '- Demold once the plaster sets, then dry the pieces for several days before the first cast.',
    `- Assemble with the natches engaged${r.base ? ', the base plug seated in the sides' : ''}, strap tight, and fill through the spare: about ${r.slipMl} ml of slip.`,
    ...r.warnings.map((w) => `- ${w}`),
  ];
}
