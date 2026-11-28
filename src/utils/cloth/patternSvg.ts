/**
 * A garment's pieces laid out to cut: each flattened panel (garmentFlatten)
 * as an outline, side by side with its name, a grain line (up the body) and
 * how far it had to give to lie flat. Millimetres, as a cutter reads them.
 */

import { offsetLoop } from '../polygonOffset';
import { outlineDarts, type FlatEdge } from './patternEdges';

export interface PatternPiece {
  name: string;
  /** Flat positions, metres. */
  uv: [number, number][];
  /** Indices into `uv`, in order round the piece. */
  outline: number[];
  strain95: number;
  /** Trims on the piece, by point index. */
  marks?: { kind: string; particle: number; size: number }[];
  /** Boning channels, as runs of point indices. */
  lines?: number[][];
  /** Double-ended darts inside the outline, as loops of point indices: stitching lines, marked, never cut. */
  darts?: number[][];
  /** Each point's shell point (-1: its own): points with the same id on two pieces are sewn together. */
  ids?: number[];
  /** Each outline edge (outline[k] to outline[k + 1]): what it is on the garment. */
  edges?: FlatEdge[];
  /** The garment it is cut for. */
  garment?: string;
  /** Its fabric (a ClothMaterialName). */
  fabric?: string;
}

export interface PatternLayoutOptions {
  /** Outward seam allowance in millimetres (0 = net sewing lines only). */
  seamAllowanceMm?: number;
  /** The sheet's width, mm, margins included: the pieces are packed across it and the sheet runs as long as it must. Unset: about square. */
  widthMm?: number;
}

export interface PatternLayout {
  pieces: {
    name: string;
    strain95: number;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Outer cutting line when seamAllowanceMm > 0, else net sewing outline. */
    path: string;
    /** Inner net sewing line when seamAllowanceMm > 0, else undefined. */
    sewPath?: string;
    marks: { kind: string; x: number; y: number; r: number }[];
    channels: string[];
    /** Darts: their stitching lines (a double-ended dart's loop; a wedge's legs are on sewPath) and where to mark their points. */
    darts: { stitch?: string; points: { x: number; y: number }[] }[];
    /** The cutting line's points, placed. */
    outlinePts: { x: number; y: number }[];
  }[];
  width: number;
  height: number;
}

const MM = 1000, GAP = 15, MARGIN = 20;

/** Where a dart's point is marked: 10 mm back from it toward its middle (hidden in the stitching), or at it if the dart is short. */
function pointBack(tip: { x: number; y: number }, toward: { x: number; y: number }) {
  const d = Math.hypot(toward.x - tip.x, toward.y - tip.y);
  const back = d > 30 ? 10 / d : 0;
  return { x: tip.x + (toward.x - tip.x) * back, y: tip.y + (toward.y - tip.y) * back };
}


type Pt = { x: number; y: number };

/** A piece drawn in its own frame, mm, y down: everything about it but where it goes. */
interface Drawn {
  name: string;
  strain95: number;
  cut: Pt[][];
  sew?: Pt[];
  marks: { kind: string; x: number; y: number; r: number }[];
  channels: Pt[][];
  darts: { stitch?: Pt[]; points: Pt[] }[];
  /** What it covers, cutting line and all. */
  x0: number; y0: number; x1: number; y1: number;
}

/** Drawn pieces by piece and options: laying out again (another sheet width, another paper) does not offset every outline again. */
const drawnCache = new WeakMap<PatternPiece, Map<string, Drawn | null>>();

/** One piece in its own frame. */
function drawPiece(p: PatternPiece, sa: number): Drawn | null {
  const key = JSON.stringify([sa]);
  let byKey = drawnCache.get(p);
  if (!byKey) drawnCache.set(p, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key)!;
  const d = drawPieceNow(p, sa);
  byKey.set(key, d);
  return d;
}

function drawPieceNow(p: PatternPiece, sa: number): Drawn | null {
  if (p.outline.length < 3) return null;
  const at = (i: number): Pt => ({ x: p.uv[i][0] * MM, y: -p.uv[i][1] * MM });
  // A dart is folded and stitched, never cut: a wedge slit in from the edge
  // is bridged across its mouth on the cutting line (its legs stay on the
  // stitching line), and a double-ended dart is only drawn and marked. Cut
  // out, either left a hole with nothing to sew it by.
  const wedges = p.ids ? outlineDarts(p.ids, p.outline, p.edges) : [];
  const m = p.outline.length, inWedge = new Set<number>();
  for (const w of wedges) for (let q = -w.legs + 1; q <= w.legs - 1; q++) inWedge.add((((w.apex + q) % m) + m) % m);
  const cutIdx = p.outline.filter((_, k) => !inWedge.has(k));
  const darts: Drawn['darts'] = [];
  for (const w of wedges) {
    const apex = at(p.outline[w.apex]);
    const ma = at(p.outline[(((w.apex - w.legs) % m) + m) % m]), mb = at(p.outline[(w.apex + w.legs) % m]);
    darts.push({ points: [pointBack(apex, { x: (ma.x + mb.x) / 2, y: (ma.y + mb.y) / 2 })] });
  }
  for (const d of p.darts ?? []) {
    if (d.length < 3) continue;
    const pts = d.map(at);
    let ia = 0, ib = 1, far = -1;
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const dd = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
      if (dd > far) { far = dd; ia = i; ib = j; }
    }
    const mid = { x: (pts[ia].x + pts[ib].x) / 2, y: (pts[ia].y + pts[ib].y) / 2 };
    darts.push({ stitch: pts, points: [pointBack(pts[ia], mid), pointBack(pts[ib], mid)] });
  }
  const net = p.outline.map(at);
  let cut: Pt[][] = [cutIdx.map(at)];
  let sew: Pt[] | undefined = wedges.length ? net : undefined;
  if (sa > 0) {
    const grown = offsetLoop(cut[0], sa, { joinStyle: 'miter', miterLimit: 2.4 });
    if (grown.length > 0) { cut = grown; sew = net; }
  }
  // Placement marks for what is sewn on at a point; topstitching is sewn after, not marked.
  const marks = (p.marks ?? []).filter((mk) => mk.kind !== 'stitch').map((mk) => ({ kind: mk.kind, ...at(mk.particle), r: (mk.size * MM) / 2 }));
  const channels = (p.lines ?? []).map((run) => run.map(at));
  // Its extent from what is drawn, the cutting line's corners included: a
  // box padded by the allowance alone let mitred corners reach into the next piece.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of [...cut.flat(), ...net]) { x0 = Math.min(x0, q.x); y0 = Math.min(y0, q.y); x1 = Math.max(x1, q.x); y1 = Math.max(y1, q.y); }
  return { name: p.name, strain95: p.strain95, cut, sew, marks, channels, darts, x0, y0, x1, y1 };
}

const pathOf = (pts: Pt[], dx: number, dy: number, close = true) =>
  pts.map((q, k) => `${k ? 'L' : 'M'}${(q.x + dx).toFixed(1)} ${(q.y + dy).toFixed(1)}`).join(' ') + (close ? ' Z' : '');

/** A drawn piece put at (x, y), its box's top left corner. */
function place(d: Drawn, x: number, y: number): PatternLayout['pieces'][number] {
  const dx = x - d.x0, dy = y - d.y0;
  return {
    name: d.name, strain95: d.strain95, x, y, w: d.x1 - d.x0, h: d.y1 - d.y0,
    path: d.cut.map((l) => pathOf(l, dx, dy)).join(' '),
    sewPath: d.sew ? pathOf(d.sew, dx, dy) : undefined,
    marks: d.marks.map((mk) => ({ ...mk, x: mk.x + dx, y: mk.y + dy })),
    channels: d.channels.map((c) => pathOf(c, dx, dy, false)),
    darts: d.darts.map((dt) => ({ ...(dt.stitch ? { stitch: pathOf(dt.stitch, dx, dy) } : {}), points: dt.points.map((q) => ({ x: q.x + dx, y: q.y + dy })) })),
    outlinePts: d.cut[0].map((q) => ({ x: q.x + dx, y: q.y + dy })),
  };
}

/** Room under each piece for its label. */
const LABEL = 18;

/**
 * Rectangles packed into a strip `width` wide, each as high up as it will go
 * (a skyline, tallest first): where each goes, and how long the strip runs.
 * One wider than the strip is put at its left edge, over it.
 */
export function packRects(rects: { w: number; h: number }[], width: number, gap: number): { at: Pt[]; length: number } {
  let sky: { x: number; w: number; y: number }[] = [{ x: 0, w: Math.max(width, ...rects.map((r) => r.w)), y: 0 }];
  const at: Pt[] = new Array(rects.length);
  const order = rects.map((_, i) => i).sort((i, j) => rects[j].h - rects[i].h || rects[j].w - rects[i].w);
  let length = 0;
  for (const i of order) {
    const r = rects[i];
    let best: Pt | null = null;
    for (const seg of sky) {
      const x = seg.x;
      if (x + r.w > width + 1e-6 && x > 0) continue;
      let y = 0;
      for (const o of sky) if (o.x < x + r.w - 1e-9 && o.x + o.w > x + 1e-9) y = Math.max(y, o.y);
      if (!best || y < best.y - 1e-9 || (Math.abs(y - best.y) < 1e-9 && x < best.x)) best = { x, y };
    }
    const p = best ?? { x: 0, y: length };
    at[i] = p;
    length = Math.max(length, p.y + r.h);
    // The skyline raised over it, a gap clear.
    const x0 = p.x, x1 = p.x + r.w + gap, top = p.y + r.h + gap;
    const next: typeof sky = [];
    for (const o of sky) {
      if (o.x + o.w <= x0 || o.x >= x1) { next.push(o); continue; }
      if (o.x < x0) next.push({ x: o.x, w: x0 - o.x, y: o.y });
      if (o.x + o.w > x1) next.push({ x: x1, w: o.x + o.w - x1, y: o.y });
    }
    next.push({ x: x0, w: x1 - x0, y: top });
    next.sort((u, v) => u.x - v.x);
    // Neighbours at one height merged, so a later piece sees the run as one.
    sky = next.reduce<typeof sky>((acc, o) => {
      const last = acc[acc.length - 1];
      if (last && Math.abs(last.y - o.y) < 1e-9 && Math.abs(last.x + last.w - o.x) < 1e-9) last.w += o.w; else acc.push({ ...o });
      return acc;
    }, []);
  }
  return { at, length };
}

/** The pieces packed onto one sheet, grain down the page; everything in mm, y down the page. */
export function layoutPattern(pieces: PatternPiece[], options?: PatternLayoutOptions): PatternLayout {
  const sa = Math.max(0, options?.seamAllowanceMm ?? 0);
  const drawn = [...pieces].sort((a, b) => a.name.localeCompare(b.name)).map((p) => drawPiece(p, sa)).filter((d): d is Drawn => !!d);
  const rects = drawn.map((d) => ({ w: d.x1 - d.x0, h: d.y1 - d.y0 + LABEL }));
  const area = rects.reduce((acc, r) => acc + (r.w + GAP) * (r.h + GAP), 0);
  const widest = Math.max(0, ...rects.map((r) => r.w));
  const inner = Math.max(widest, options?.widthMm ? options.widthMm - 2 * MARGIN : Math.sqrt(area));
  const { at, length } = packRects(rects, inner, GAP);
  const out = drawn.map((d, i) => place(d, MARGIN + at[i].x, MARGIN + at[i].y));
  const used = Math.max(0, ...out.map((p) => p.x + p.w)) + MARGIN;
  return { pieces: out, width: Math.max(100, options?.widthMm ?? 0, used), height: length + 2 * MARGIN };
}

/** What of a layout is drawn on, label room included: the pages worth printing. */
export function layoutRects(L: PatternLayout): { x: number; y: number; w: number; h: number }[] {
  // Each piece in strips across it, as wide as it is at that height: a page
  // over a piece's empty corner is not worth printing.
  const STRIP = 15, out: { x: number; y: number; w: number; h: number }[] = [];
  for (const p of L.pieces) {
    const pts = p.outlinePts.length ? p.outlinePts : [{ x: p.x, y: p.y }, { x: p.x + p.w, y: p.y + p.h }];
    for (let y = p.y; y < p.y + p.h; y += STRIP) {
      const y1 = Math.min(p.y + p.h, y + STRIP);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (Math.max(a.y, b.y) < y || Math.min(a.y, b.y) > y1) continue;
        for (const yy of [Math.max(y, Math.min(a.y, b.y)), Math.min(y1, Math.max(a.y, b.y))]) {
          const t = Math.abs(b.y - a.y) < 1e-9 ? 0 : (yy - a.y) / (b.y - a.y);
          const xs = Math.abs(b.y - a.y) < 1e-9 ? [a.x, b.x] : [a.x + t * (b.x - a.x)];
          for (const x of xs) { lo = Math.min(lo, x); hi = Math.max(hi, x); }
        }
      }
      if (hi >= lo) out.push({ x: lo, y, w: hi - lo, h: y1 - y });
    }
    out.push({ x: p.x + Math.max(0, p.w / 2 - 70), y: p.y + p.h, w: Math.min(p.w, 140), h: LABEL });
  }
  return out;
}

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The layout as an SVG document, 1 unit = 1 mm. */
export function patternSvg(pieces: PatternPiece[], title = 'pattern', options?: PatternLayoutOptions): string {
  const sa = Math.max(0, options?.seamAllowanceMm ?? 0);
  const L = layoutPattern(pieces, options);
  const body = L.pieces.map((p) => {
    const gx = p.x + p.w / 2, g0 = p.y + p.h * 0.25, g1 = p.y + p.h * 0.75;
    const saLabel = sa > 0 ? ` · +${Math.round(sa)} mm seam` : '';
    return [
      `<path d="${p.path}" data-operation="cut" fill="none" stroke="#000" stroke-width="0.5"/>`,
      ...(p.sewPath ? [`<path d="${p.sewPath}" data-operation="etch" fill="none" stroke="#64748b" stroke-width="0.35" stroke-dasharray="2.5 1.5"><title>stitching line</title></path>`] : []),
      ...p.channels.map((d) => `<path d="${d}" data-operation="etch" fill="none" stroke="#000" stroke-width="0.4" stroke-dasharray="3 1.5"><title>boning channel</title></path>`),
      ...p.darts.flatMap((d) => [
        ...(d.stitch ? [`<path d="${d.stitch}" data-operation="etch" fill="none" stroke="#64748b" stroke-width="0.35" stroke-dasharray="2.5 1.5"><title>dart: fold and stitch, do not cut</title></path>`] : []),
        ...d.points.map((q) => `<path d="M${(q.x - 2).toFixed(1)} ${q.y.toFixed(1)} L${(q.x + 2).toFixed(1)} ${q.y.toFixed(1)} M${q.x.toFixed(1)} ${(q.y - 2).toFixed(1)} L${q.x.toFixed(1)} ${(q.y + 2).toFixed(1)}" data-operation="etch" fill="none" stroke="#000" stroke-width="0.4"><title>dart point: mark through</title></path>`),
      ]),
      ...p.marks.map((m) => `<circle cx="${m.x.toFixed(1)}" cy="${m.y.toFixed(1)}" r="${Math.max(0.8, m.r).toFixed(1)}" data-operation="etch" fill="${m.kind === 'zipper' ? '#000' : 'none'}" stroke="#000" stroke-width="0.4"><title>${escXml(m.kind)}</title></circle>`),
      `<line x1="${gx.toFixed(1)}" y1="${g1.toFixed(1)}" x2="${gx.toFixed(1)}" y2="${g0.toFixed(1)}" data-operation="etch" stroke="#888" stroke-width="0.4" marker-end="url(#arrow)"/>`,
      `<text x="${(p.x + p.w / 2).toFixed(1)}" y="${(p.y + p.h + 14).toFixed(1)}" data-operation="etch" font-size="8" font-family="sans-serif" text-anchor="middle">${escXml(p.name)} · ${Math.round(p.w)}×${Math.round(p.h)} mm${saLabel} · ease to lie flat ${(p.strain95 * 100).toFixed(0)}%</text>`,
    ].join('\n');
  }).join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width.toFixed(0)}mm" height="${L.height.toFixed(0)}mm" viewBox="0 0 ${L.width.toFixed(1)} ${L.height.toFixed(1)}">`,
    `<title>${escXml(title)}</title>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto"><path d="M0 0 L10 5 L0 10 z" fill="#888"/></marker></defs>`,
    body,
    `</svg>`,
  ].join('\n');
}
