/**
 * What each edge of a cut piece is on the garment: the line it lies on (a
 * seam, an opening, the hem), whether it is sewn, and the pieces it is sewn
 * to. The pattern draws its notches, seam names, darts and allowances from
 * this; the cloth model only knows it as shell points shared between pieces.
 */

/** One edge of a piece's outline, from outline[k] to outline[k + 1]. */
export interface FlatEdge {
  /** The seam or cut edge it lies on (sideL, shoulderR, hem, neckline, cuffL, ...). */
  line?: string;
  /** Sewn to another edge (a closed seam); false on a free edge or an opening. */
  sewn?: boolean;
  /** Left open (an opening's edge: a jacket's front, a slit). */
  open?: boolean;
  /** The pieces it is sewn to: its own name for a seam sewn to itself (a sleeve's underarm, a dart). */
  to?: string[];
}

export interface CutLine { name: string; path: number[]; open?: boolean; sewn: boolean }

const key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/**
 * Each piece's outline edges, classified. `ids` is each local point's shell
 * point (or -1 for a point of its own); `near`, where given, a shell point to
 * look a point's line up by when it has none of its own (a gathered piece's
 * points along its seam).
 */
export function cutEdges(
  pieces: { name: string; ids: number[]; outline: number[]; near?: number[] }[],
  lines: CutLine[],
): FlatEdge[][] {
  const lineOf = new Map<string, CutLine>();
  for (const ln of lines) for (let k = 1; k < ln.path.length; k++) {
    const kk = key(ln.path[k - 1], ln.path[k]);
    // A seam wins over a free edge drawn on the same points.
    const had = lineOf.get(kk);
    if (!had || (!had.sewn && ln.sewn)) lineOf.set(kk, ln);
  }
  const idAt = (p: (typeof pieces)[number], local: number) => {
    const g = p.ids[local];
    return g >= 0 ? g : (p.near?.[local] ?? -1);
  };
  // Every occurrence of each shell edge on any outline.
  const where = new Map<string, { piece: number; edge: number }[]>();
  pieces.forEach((p, pi) => {
    const m = p.outline.length;
    for (let k = 0; k < m; k++) {
      const a = idAt(p, p.outline[k]), b = idAt(p, p.outline[(k + 1) % m]);
      if (a < 0 || b < 0 || a === b) continue;
      const kk = key(a, b);
      (where.get(kk) ?? where.set(kk, []).get(kk)!).push({ piece: pi, edge: k });
    }
  });
  return pieces.map((p, pi) => {
    const m = p.outline.length;
    const out: (FlatEdge | null)[] = new Array(m).fill(null);
    for (let k = 0; k < m; k++) {
      const a = idAt(p, p.outline[k]), b = idAt(p, p.outline[(k + 1) % m]);
      if (a < 0 || b < 0 || a === b) continue;
      const kk = key(a, b), ln = lineOf.get(kk);
      const others = (where.get(kk) ?? []).filter((o) => !(o.piece === pi && o.edge === k));
      const to = [...new Set(others.map((o) => pieces[o.piece].name))];
      const sewn = ln ? ln.sewn : to.length > 0;
      out[k] = {
        ...(ln ? { line: ln.name } : {}),
        sewn,
        ...(ln?.open ? { open: true } : {}),
        ...(sewn && to.length ? { to } : {}),
      };
    }
    // Edges of points of its own (a gathered seam, meshed afresh): as the
    // edges either side of them, where those agree.
    for (let k = 0; k < m; k++) {
      if (out[k]) continue;
      let before: FlatEdge | null = null, after: FlatEdge | null = null;
      for (let j = 1; j < m && !before; j++) before = out[(k - j + m) % m];
      for (let j = 1; j < m && !after; j++) after = out[(k + j) % m];
      if (before && after && before.line === after.line && before.sewn === after.sewn) out[k] = { ...before };
    }
    return out.map((e) => e ?? {});
  });
}

/**
 * The darts cut into a piece's outline as wedges (a single-ended dart, slit
 * from the edge and sewn back on itself): the apex's outline position and how
 * many points each leg runs back from it. Found from the points alone: the
 * outline runs up one leg to the apex and back down the other over the same
 * shell points, every edge of it sewn.
 */
export function outlineDarts(ids: number[], outline: number[], edges?: FlatEdge[]): { apex: number; legs: number }[] {
  const m = outline.length, out: { apex: number; legs: number }[] = [];
  if (m < 5) return out;
  const id = (k: number) => ids[outline[((k % m) + m) % m]];
  const sewnEdge = (k: number) => !edges || !!edges[((k % m) + m) % m]?.sewn;
  for (let k = 0; k < m; k++) {
    if (id(k) < 0) continue;
    let j = 1;
    while (j < m / 2 && id(k - j) >= 0 && id(k - j) === id(k + j) && id(k - j) !== id(k)) j++;
    const legs = j - 1;
    if (legs < 1) continue;
    // Every edge of the wedge sewn (an opening's slit is cut, and stays).
    let sewn = true;
    for (let q = -legs; q < legs && sewn; q++) sewn = sewnEdge(k + q);
    if (sewn) out.push({ apex: k, legs });
  }
  return out;
}
