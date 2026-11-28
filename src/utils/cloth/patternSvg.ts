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

const ptsToPath = (pts: { x: number; y: number }[]) =>
  pts.map((p, k) => `${k ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') + ' Z';

/** The pieces in a row, each in its own box; everything in mm, y down the page. */
export function layoutPattern(pieces: PatternPiece[], options?: PatternLayoutOptions): PatternLayout {
  const sa = Math.max(0, options?.seamAllowanceMm ?? 0);
  let x = MARGIN, height = 0;
  const out: PatternLayout['pieces'] = [];
  for (const p of [...pieces].sort((a, b) => a.name.localeCompare(b.name))) {
    if (p.outline.length < 3) continue;
    const pts = p.outline.map((i) => p.uv[i]);
    const u0 = Math.min(...pts.map((q) => q[0])), u1 = Math.max(...pts.map((q) => q[0]));
    const v0 = Math.min(...pts.map((q) => q[1])), v1 = Math.max(...pts.map((q) => q[1]));
    const pad = sa;
    const w = (u1 - u0) * MM + 2 * pad, h = (v1 - v0) * MM + 2 * pad;
    const X = (u: number) => x + pad + (u - u0) * MM, Y = (v: number) => MARGIN + pad + (v1 - v) * MM;
    const loop = (ids: number[]) => ids.map((i, k) => `${k ? 'L' : 'M'}${X(p.uv[i][0]).toFixed(1)} ${Y(p.uv[i][1]).toFixed(1)}`).join(' ') + ' Z';
    const at = (i: number) => ({ x: X(p.uv[i][0]), y: Y(p.uv[i][1]) });
    // A dart is folded and stitched, never cut: a wedge slit in from the edge
    // is bridged across its mouth on the cutting line (its legs stay on the
    // stitching line), and a double-ended dart is only drawn and marked. Cut
    // out, either left a hole with nothing to sew it by.
    const wedges = p.ids ? outlineDarts(p.ids, p.outline, p.edges) : [];
    const m = p.outline.length, inWedge = new Set<number>();
    for (const w of wedges) for (let q = -w.legs + 1; q <= w.legs - 1; q++) inWedge.add((((w.apex + q) % m) + m) % m);
    const cutIdx = p.outline.filter((_, k) => !inWedge.has(k));
    const darts: PatternLayout['pieces'][number]['darts'] = [];
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
      darts.push({ stitch: loop(d), points: [pointBack(pts[ia], mid), pointBack(pts[ib], mid)] });
    }
    let cutPath = loop(cutIdx);
    let sewPath: string | undefined = wedges.length ? loop(p.outline) : undefined;
    if (sa > 0) {
      const baseLoop = cutIdx.map(at);
      const grown = offsetLoop(baseLoop, sa, { joinStyle: 'miter', miterLimit: 2.4 });
      if (grown.length > 0) {
        cutPath = grown.map(ptsToPath).join(' ');
        sewPath = loop(p.outline);
      }
    }
    // Placement marks for what is sewn on at a point; topstitching is sewn after, not marked.
    const marks = (p.marks ?? []).filter((m) => m.kind !== 'stitch').map((m) => ({ kind: m.kind, x: X(p.uv[m.particle][0]), y: Y(p.uv[m.particle][1]), r: (m.size * MM) / 2 }));
    const channels = (p.lines ?? []).map((run) => run.map((i, k) => `${k ? 'L' : 'M'}${X(p.uv[i][0]).toFixed(1)} ${Y(p.uv[i][1]).toFixed(1)}`).join(' '));
    out.push({ name: p.name, strain95: p.strain95, x, y: MARGIN, w, h, path: cutPath, sewPath, marks, channels, darts });
    x += w + GAP;
    height = Math.max(height, h);
  }
  return { pieces: out, width: Math.max(100, x - GAP + MARGIN), height: height + 2 * MARGIN + 24 };
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
