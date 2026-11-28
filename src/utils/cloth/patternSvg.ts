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
  }[];
  width: number;
  height: number;
}

const MM = 1000, GAP = 30, MARGIN = 20;

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

/** One piece in its own frame. */
function drawPiece(p: PatternPiece, sa: number): Drawn | null {
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
  };
}

/** Room under each piece for its label. */
const LABEL = 18;

/** The pieces in a row, each in its own box; everything in mm, y down the page. */
export function layoutPattern(pieces: PatternPiece[], options?: PatternLayoutOptions): PatternLayout {
  const sa = Math.max(0, options?.seamAllowanceMm ?? 0);
  let x = MARGIN, height = 0;
  const out: PatternLayout['pieces'] = [];
  for (const p of [...pieces].sort((a, b) => a.name.localeCompare(b.name))) {
    const d = drawPiece(p, sa);
    if (!d) continue;
    const placed = place(d, x, MARGIN);
    out.push(placed);
    x += placed.w + GAP;
    height = Math.max(height, placed.h + LABEL);
  }
  return { pieces: out, width: Math.max(100, x - GAP + MARGIN), height: height + 2 * MARGIN };
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
