// Through-cuts: which pieces come loose, and the tabs that hold them in the sheet.

import type { Heightmap } from './reliefHeightmap';

/** Cells cut down to the bottom of the stock or below are gone. */
export const isCutThrough = (z: number, stockBottomZ: number): boolean => z <= stockBottomZ + 1e-6;

/**
 * Group the material a through-cut leaves into pieces, by edge-adjacency.
 *
 * `label` is the piece each cell belongs to, or -1 for a cell cut through;
 * `sizes` is each piece's cell count.
 */
function labelPieces(surface: Heightmap, stockBottomZ: number): { label: Int32Array; sizes: number[] } {
  const { cols, z } = surface;
  const label = new Int32Array(z.length).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < z.length; start++) {
    if (label[start] !== -1 || isCutThrough(z[start], stockBottomZ)) continue;
    const id = sizes.length;
    let size = 0;
    label[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const c = i % cols;
      for (const n of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
        if (n < 0 || n >= z.length || label[n] !== -1 || isCutThrough(z[n], stockBottomZ)) continue;
        label[n] = id;
        stack.push(n);
      }
    }
    sizes.push(size);
  }
  return { label, sizes };
}

/** The smallest piece worth calling a part: a square millimetre, in cells. */
const minPieceCells = (resolutionMm: number): number => 1 / Math.max(1e-6, resolutionMm * resolutionMm);

/**
 * How many pieces of a through-cut come away from the main body of the board.
 *
 * Every piece but the largest is one the cutter will free. Specks under a
 * square millimetre are left out -- a sliver between two samples is sampling,
 * not a part.
 */
export function countLoosePieces(surface: Heightmap, stockBottomZ: number, resolutionMm: number): number {
  const { sizes } = labelPieces(surface, stockBottomZ);
  const sorted = [...sizes].sort((p, q) => q - p);
  return sorted.slice(1).filter((n) => n >= minPieceCells(resolutionMm)).length;
}

export interface HoldingTabOptions {
  /** How far the tab stands above the bottom of the stock, mm. */
  heightMm: number;
  /** Length of the tab along the slot, mm. The cutter's radius adds to it. */
  widthMm: number;
  /** Tabs along one slot are at least this far apart, mm. */
  spacingMm: number;
}

/**
 * Bridge every loose piece of a through-cut back to its neighbours with tabs.
 *
 * A tab is a short length of slot left uncut at the bottom: the cutter goes
 * through either side of it and stops `heightMm` above the spoilboard over it,
 * so the piece hangs on that bridge rather than coming free and being thrown.
 * They are snapped off or sawn through after the job.
 *
 * Where to put them is found from the slots themselves. Growing every piece
 * out across the cut-through cells at once, the places two growths meet are
 * the middle of the slot between those two pieces -- a seam. A tab centred on
 * a seam point, as wide as the slot is there, joins the pieces on either
 * side. Seams are only tabbed where a loose piece is on one side of them, and
 * each loose piece gets at least two tabs wherever its seams allow, since a
 * piece on one tab pivots into the cutter.
 *
 * Edits `surface` in place and says how many tabs it left and how many
 * pieces are still loose (a piece walled in by nothing but board edge has
 * no seam to tab across).
 */
export function addHoldingTabs(
  surface: Heightmap,
  stockBottomZ: number,
  resolutionMm: number,
  tab: HoldingTabOptions
): { tabs: number; loose: number } {
  const { cols, rows, z } = surface;
  const { label, sizes } = labelPieces(surface, stockBottomZ);
  const minCells = minPieceCells(resolutionMm);
  let main = -1;
  for (let i = 0; i < sizes.length; i++) if (main < 0 || sizes[i] > sizes[main]) main = i;
  const isLoose = (id: number) => id >= 0 && id !== main && sizes[id] >= minCells;
  if (!sizes.some((_, id) => isLoose(id))) return { tabs: 0, loose: 0 };

  /*
   * Grown from where each piece is at least as thick as a tab.
   *
   * A piece whose edge tapers to the spoilboard still counts as piece where it
   * is a tenth of a millimetre thick, and grown from its outermost cells the
   * seam - and so the tab - sat between the two rims: the piece hung on its
   * own foil, which tears as soon as the cutter pushes on it. Grown from the
   * cells that are as thick as the tab, the tab reaches across the taper to
   * material it can hold. A piece thinner than a tab everywhere is grown from
   * all of itself, since it has nothing better.
   */
  const thickZ = stockBottomZ + Math.max(0.1, tab.heightMm) - 1e-6;
  const hasThick = new Uint8Array(sizes.length);
  for (let i = 0; i < z.length; i++) if (label[i] >= 0 && z[i] >= thickZ) hasThick[label[i]] = 1;
  const seed = (i: number) =>
    label[i] >= 0 && sizes[label[i]] >= minCells && (z[i] >= thickZ || !hasThick[label[i]]);

  // Grow every real piece out across the cut cells, breadth first, so each cut
  // cell learns which piece is nearest and how far away it is.
  const owner = new Int32Array(z.length).fill(-1);
  const dist = new Float32Array(z.length).fill(Infinity);
  let queue: number[] = [];
  for (let i = 0; i < z.length; i++) {
    if (seed(i)) {
      owner[i] = label[i];
      dist[i] = 0;
      queue.push(i);
    }
  }
  while (queue.length) {
    const next: number[] = [];
    for (const i of queue) {
      const c = i % cols;
      for (const n of [c > 0 ? i - 1 : -1, c < cols - 1 ? i + 1 : -1, i - cols, i + cols]) {
        if (n < 0 || n >= z.length || owner[n] !== -1) continue;
        owner[n] = owner[i];
        dist[n] = dist[i] + 1;
        next.push(n);
      }
    }
    queue = next;
  }

  // Seams: neighbouring cells owned by different pieces, one of them loose.
  const seams = new Map<string, number[]>();
  for (let i = 0; i < z.length; i++) {
    const c = i % cols;
    for (const n of [c < cols - 1 ? i + 1 : -1, i + cols < z.length ? i + cols : -1]) {
      if (n < 0) continue;
      const a = owner[i], b = owner[n];
      if (a < 0 || b < 0 || a === b || !(isLoose(a) || isLoose(b))) continue;
      const at = dist[i] >= dist[n] ? i : n;
      if (seed(at)) continue; // a seam is in the slot (or a taper), not in a piece
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!seams.has(key)) seams.set(key, []);
      seams.get(key)!.push(at);
    }
  }

  const spacing = Math.max(1, tab.spacingMm / resolutionMm);
  const centres: number[] = [];
  const perPiece = new Map<number, number[]>();
  const far = (i: number, js: number[], d: number) =>
    js.every((j) => Math.hypot((i % cols) - (j % cols), Math.floor(i / cols) - Math.floor(j / cols)) >= d);
  const place = (i: number, key: string) => {
    centres.push(i);
    for (const id of key.split(':').map(Number)) {
      if (!perPiece.has(id)) perPiece.set(id, []);
      perPiece.get(id)!.push(i);
    }
  };
  for (const [key, cells] of seams) {
    const mine: number[] = [];
    for (const i of cells) {
      if (far(i, mine, spacing)) {
        mine.push(i);
        place(i, key);
      }
    }
  }
  // A loose piece left on one tab gets a second, as far from the first as
  // its seams reach.
  for (const [key, cells] of seams) {
    for (const id of key.split(':').map(Number)) {
      if (!isLoose(id) || (perPiece.get(id)?.length ?? 0) >= 2) continue;
      const have = perPiece.get(id) ?? [];
      let best = -1;
      let bestD = -1;
      for (const i of cells) {
        const d = Math.min(...have.map((j) => Math.hypot((i % cols) - (j % cols), Math.floor(i / cols) - Math.floor(j / cols))));
        if (d > bestD) { bestD = d; best = i; }
      }
      // Two tabs on top of each other are one tab.
      if (best >= 0 && bestD > tab.widthMm / resolutionMm) place(best, key);
    }
  }

  // Raise the slot floor over each tab: a disc wide enough to span the slot
  // where it sits, and at least the tab's own width.
  const topZ = stockBottomZ + Math.max(0.1, tab.heightMm);
  for (const centre of centres) {
    const radius = Math.max(tab.widthMm / 2 / resolutionMm, dist[centre] + 1.5);
    const r0 = Math.floor(centre / cols);
    const c0 = centre % cols;
    const reach = Math.ceil(radius);
    for (let r = Math.max(0, r0 - reach); r <= Math.min(rows - 1, r0 + reach); r++) {
      for (let c = Math.max(0, c0 - reach); c <= Math.min(cols - 1, c0 + reach); c++) {
        if (Math.hypot(r - r0, c - c0) > radius) continue;
        const i = r * cols + c;
        if (z[i] < topZ) z[i] = topZ;
      }
    }
  }

  return { tabs: centres.length, loose: countLoosePieces(surface, stockBottomZ, resolutionMm) };
}
