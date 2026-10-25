// ---------------------------------------------------------------------------
// The hardware list: what to buy for the scene
//
// Every bought part, once per part however many bodies it is built of (a
// bearing's inner race is not a second bearing), counted by what it is. Parts
// cut from bar — extrusion — are also packed onto the bar lengths they are
// sold in, so the list says how many bars to order, not only how many pieces.
// ---------------------------------------------------------------------------

import type { HardwarePartKind, SceneGraph, SceneNode } from '../types/scene';
import { HARDWARE_PARTS, normalizePart, hardwarePartName } from './hardwareParts';

/** What is lost to the saw between two pieces cut from one bar, mm. */
export const SAW_KERF_MM = 3;

export interface HardwareListRow {
  kind: HardwarePartKind;
  /** As the hierarchy names one: "M3×12 cap screw". */
  name: string;
  size: string;
  /** Each piece's length, mm, for a part bought or cut to length. */
  lengthMm?: number;
  count: number;
}

export interface BarPlan {
  kind: HardwarePartKind;
  size: string;
  /** One entry per bar to buy: its length and the pieces cut from it, mm. */
  bars: { lengthMm: number; cutsMm: number[] }[];
  /** Pieces longer than any bar sold, which cannot be cut from one. */
  tooLongMm: number[];
}

export interface HardwareList {
  rows: HardwareListRow[];
  bars: BarPlan[];
}

/** Every part at the top of its pieces, wherever it is in the tree. */
function parts(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const n of nodes) {
    if (n.hardwarePart && !n.hardwarePart.piece) out.push(n);
    parts(n.children || [], out);
  }
  return out;
}

/**
 * Pieces packed onto bars: longest piece first onto the first bar it fits
 * (first-fit decreasing), each bar the longest sold; then the last bar is
 * swapped for the shortest length sold that still takes what is on it.
 */
export function packBars(cutsMm: number[], stockMm: readonly number[]): { bars: { lengthMm: number; cutsMm: number[] }[]; tooLongMm: number[] } {
  const longest = Math.max(...stockMm);
  const tooLongMm = cutsMm.filter((c) => c > longest);
  const bars: { lengthMm: number; cutsMm: number[]; used: number }[] = [];
  for (const cut of cutsMm.filter((c) => c <= longest).sort((a, b) => b - a)) {
    const bar = bars.find((b) => b.used + (b.cutsMm.length ? SAW_KERF_MM : 0) + cut <= b.lengthMm);
    if (bar) {
      bar.used += (bar.cutsMm.length ? SAW_KERF_MM : 0) + cut;
      bar.cutsMm.push(cut);
    } else {
      bars.push({ lengthMm: longest, cutsMm: [cut], used: cut });
    }
  }
  for (const bar of bars) {
    const shortest = [...stockMm].sort((a, b) => a - b).find((l) => l >= bar.used);
    if (shortest !== undefined) bar.lengthMm = shortest;
  }
  return { bars: bars.map(({ lengthMm, cutsMm }) => ({ lengthMm, cutsMm })), tooLongMm };
}

export function hardwareList(scene: SceneGraph): HardwareList {
  const rows = new Map<string, HardwareListRow>();
  const cuts = new Map<string, { kind: HardwarePartKind; size: string; cutsMm: number[] }>();
  for (const node of parts(scene.nodes || [])) {
    const p = normalizePart(node.hardwarePart!);
    const info = HARDWARE_PARTS[p.kind];
    const name = hardwarePartName(p);
    const row = rows.get(name);
    if (row) row.count++;
    else rows.set(name, { kind: p.kind, name, size: p.size, ...(p.lengthMm !== undefined ? { lengthMm: p.lengthMm } : {}), count: 1 });
    if (info.stockBarsMm && p.lengthMm) {
      const key = `${p.kind}:${p.size}`;
      const entry = cuts.get(key) ?? { kind: p.kind, size: p.size, cutsMm: [] };
      entry.cutsMm.push(p.lengthMm);
      cuts.set(key, entry);
    }
  }
  const bars: BarPlan[] = [...cuts.values()].map((c) => ({
    kind: c.kind, size: c.size, ...packBars(c.cutsMm, HARDWARE_PARTS[c.kind].stockBarsMm!),
  }));
  return {
    rows: [...rows.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, undefined, { numeric: true })),
    bars,
  };
}

/** The list as CSV, for a spreadsheet or an order form. */
export function hardwareListCsv(list: HardwareList): string {
  const q = (v: string | number) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const lines = ['Part,Size,Length mm,Quantity'];
  for (const r of list.rows) lines.push([r.name, r.size, r.lengthMm ?? '', r.count].map(q).join(','));
  for (const b of list.bars) {
    for (const bar of b.bars) lines.push([`${b.size} bar, cut to ${bar.cutsMm.join(' + ')} mm`, b.size, bar.lengthMm, 1].map(q).join(','));
  }
  return lines.join('\n') + '\n';
}
