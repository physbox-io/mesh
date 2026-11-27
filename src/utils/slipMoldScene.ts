// The slip-cast mold (utils/slipCastMold.ts) as bodies in the scene: the
// plaster pieces assembled round the part, see-through so the part shows,
// and the printed cases beside it in a row, each stood as it prints. One undo
// step, and pure: the store end is slipMoldActions.ts.

import type { SceneGraph, SceneNode } from '../types/scene';
import { meshBody } from './pourBoxScene';
import type { SlipMesh, SlipMold } from './slipCastMold';
import { sameIds, withoutNodes } from './toolingReplace';

const PLASTER_RGBA = [0.96, 0.95, 0.9, 0.45];
const CASE_RGBA = [0.92, 0.55, 0.22, 1];
const CASE_WALL_RGBA = [0.84, 0.46, 0.16, 1];
const CASE_CLIP_RGBA = [0.30, 0.36, 0.44, 1];

function partRgba(role: 'case' | 'base' | 'wall' | 'clip'): number[] {
  if (role === 'wall') return CASE_WALL_RGBA;
  if (role === 'clip') return CASE_CLIP_RGBA;
  return CASE_RGBA;
}

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
export function sceneWithSlipMold(
  scene: SceneGraph, partName: string, mold: SlipMold, partIds: string[] = [],
): { scene: SceneGraph; plasterIds: string[]; caseIds: string[]; replaced: { id: string; name: string }[] } {
  // A mold made again round the same part replaces the one made before.
  const cleared = partIds.length ? withoutNodes(scene, (n) => Boolean(n.slipMold && sameIds(n.slipMold.partIds, partIds))) : { scene, removed: [] };
  scene = cleared.scene;
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
    added.push({ ...meshBody(id, `${partName}_plaster_${pieceKey(p.name)}`, p.plaster, PLASTER_RGBA), collision: 'hull', slipMold: { piece: p.name, role: 'plaster', slip, ...(partIds.length ? { partIds: [...partIds] } : {}) } });
    plasterIds.push(id);
  }
  const caseFloor = Math.max(0, floor);
  let x = maxX + 20;
  for (const p of mold.pieces) {
    const key = pieceKey(p.name);
    if (p.caseParts.length <= 1) {
      const b = bounds(p.casePrint);
      const placed = shifted(p.casePrint, [x - b.lo[0], midY - (b.lo[1] + b.hi[1]) / 2, caseFloor - b.lo[2]]);
      x += b.hi[0] - b.lo[0] + 20;
      const id = `slipcase_${key}_${tag}`;
      added.push({ ...meshBody(id, `${partName}_case_${key}`, placed, CASE_RGBA), collision: 'hull', slipMold: { piece: p.name, role: 'case', slip, ...(partIds.length ? { partIds: [...partIds] } : {}) } });
      caseIds.push(id);
    } else {
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const cp of p.caseParts) {
        const cb = bounds(cp.assembled);
        for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], cb.lo[a]); hi[a] = Math.max(hi[a], cb.hi[a]); }
      }
      const shift: [number, number, number] = [x - lo[0], midY - (lo[1] + hi[1]) / 2, caseFloor - lo[2]];
      x += hi[0] - lo[0] + 20;
      for (const cp of p.caseParts) {
        const placed = shifted(cp.assembled, shift);
        const id = `slipcase_${key}_${cp.key}_${tag}`;
        added.push({ ...meshBody(id, `${partName}_case_${key}_${cp.key}`, placed, partRgba(cp.role)), collision: 'hull', slipMold: { piece: p.name, role: 'case', slip, ...(partIds.length ? { partIds: [...partIds] } : {}) } });
        caseIds.push(id);
      }
    }
  }
  return { scene: { ...scene, nodes: [...scene.nodes, ...added] }, plasterIds, caseIds, replaced: cleared.removed };
}

/** Lines for the scene's note card. */
export function slipMoldNotes(partName: string, mold: SlipMold): string[] {
  const r = mold.report;
  const pieces = mold.pieces.map((p) => p.name).join(', ');
  const splitInstructions = r.splitCase
    ? `- Print each side case's seamless base, 2 U-wall halves, and 2 sliding clips${r.base ? ' (plus the base plug cup)' : ''} open side up. Slide the two wall halves onto each base and push the sliding clips down over the middle of the long edges to lock the seam, coat with mold release, then fill to the brim with pottery plaster: ${r.plasterPowderG} g powder into ${r.plasterWaterG} g water for all of them (100:70; mix ~10% extra).`
    : `- Print the ${mold.pieces.length} cases open side up. Coat them with mold release, then fill each to the brim with pottery plaster: ${r.plasterPowderG} g powder into ${r.plasterWaterG} g water for all of them (100:70; mix ~10% extra).`;
  const demoldInstructions = r.splitCase
    ? '- Once the plaster sets, tap the sliding clips upward off the rails, slide both wall halves outward, and lift the plaster off the flat base; dry the pieces for several days before the first cast.'
    : '- Demold once the plaster sets, then dry the pieces for several days before the first cast.';
  return [
    `## Slip-cast mold for ${partName}`,
    '',
    `- ${mold.pieces.length} plaster pieces (${pieces}); block ${r.blockMm[0]} × ${r.blockMm[1]} × ${r.blockMm[2]} mm.`,
    `- Grown ${((r.scale - 1) * 100).toFixed(1)}% for ${r.slipName.toLowerCase()}'s ${r.shrinkPercent}% shrink, so the fired piece comes out as modelled.`,
    splitInstructions,
    demoldInstructions,
    `- Assemble with the natches engaged${r.base ? ', the base plug seated in the sides' : ''}, strap tight, and fill through the spare: about ${r.slipMl} ml of slip.`,
    ...r.warnings.map((w) => `- ${w}`),
  ];
}
