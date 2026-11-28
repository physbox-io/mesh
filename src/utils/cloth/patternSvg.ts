/**
 * A garment's pieces laid out to cut and sew: each flattened panel
 * (garmentFlatten) with its cutting line (an allowance per edge, the hem its
 * own), stitching line, notches matched across every seam, the seam each edge
 * is and what it sews to, darts marked, a grain arrow, its name and how many
 * to cut (mirror pairs drawn once, symmetric pieces halved on the fold), and a
 * title block with a test square. Millimetres, as a cutter reads them.
 */

import { signedArea2 } from '../polygonOffset';
import { outlineDarts, type FlatEdge } from './patternEdges';
import { bounds, clipHalf, deepPoint, offsetEdges, sameShape, verticalChord, type Pt } from './patternGeometry';
import { edgeRuns, placeNotches } from './patternNotches';

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
  /** Its colour, #rrggbb. */
  colour?: string;
}

export interface PatternLayoutOptions {
  /** Outward seam allowance in millimetres (0 = net sewing lines only). */
  seamAllowanceMm?: number;
  /** Allowance on hem lines (the hem, cuffs, leg ends), mm. Unset: the seam allowance. */
  hemAllowanceMm?: number;
  /** Allowance by line name (sideL, neckline, hem ...), mm, over the two above. */
  edgeAllowanceMm?: Record<string, number>;
  /** The sheet's width, mm, margins included: the pieces are packed across it and the sheet runs as long as it must. Unset: about square. */
  widthMm?: number;
  /** Draw each mirror pair once (cut 2) and halve each symmetric piece on its fold (cut 1 on fold). Default false: every piece whole. */
  fold?: boolean;
  /** Lines for a title block (garment, size, fabric, allowances), drawn with a 50 mm test square. */
  titleBlock?: string[];
  /** Clear border round the sheet, mm (default 20). */
  marginMm?: number;
}

export interface PatternLayout {
  pieces: {
    name: string;
    strain95: number;
    x: number;
    y: number;
    w: number;
    h: number;
    /** Outer cutting line when an allowance is on, else net sewing outline. */
    path: string;
    /** Inner net sewing line when an allowance is on (or a dart is cut into the edge), else undefined. */
    sewPath?: string;
    marks: { kind: string; x: number; y: number; r: number }[];
    channels: string[];
    /** Darts: their stitching lines (a double-ended dart's loop; a wedge's legs are on sewPath) and where to mark their points. */
    darts: { stitch?: string; points: { x: number; y: number }[] }[];
    /** The cutting line's points, placed. */
    outlinePts: { x: number; y: number }[];
    /** The pieces it stands for: one, or a mirror pair. */
    names: string[];
    /** How many to cut, and how: 'Cut 1', 'Cut 2 (mirror pair)', 'Cut 1 on fold'. */
    cut: string;
    /** Notches: a line from the stitching line to the cutting line at each matching point. */
    notches: { x1: number; y1: number; x2: number; y2: number }[];
    /** Each run of edge named along it, inside the stitching line: the seam and what it sews to, the hem's turn-up. */
    seamLabels: { x: number; y: number; angle: number; text: string }[];
    /** Where its name goes, well inside it. */
    label: { x: number; y: number };
    /** Its grain arrow, up and down the page (the body's up). */
    grain?: { x: number; y0: number; y1: number };
    /** Its fold line, when halved on it. */
    fold?: { x: number; y0: number; y1: number };
    /** Allowances and how far it must stretch to fit, for its label. */
    info: string;
    garment?: string;
    fabric?: string;
  }[];
  /** The title block, when asked for. */
  title?: { x: number; y: number; w: number; h: number; lines: string[] };
  width: number;
  height: number;
}

const MM = 1000, GAP = 15, MARGIN = 20;

/** Lines that are hemmed rather than seamed: the hem, a sleeve's cuff, a leg's or tube's end (garmentShell's names for those cuts). */
export const isHemLine = (line: string | undefined) => !!line && (line === 'hem' || line === 'end' || line.startsWith('cuff'));

/** Where a dart's point is marked: 10 mm back from it toward its middle (hidden in the stitching), or at it if the dart is short. */
function pointBack(tip: Pt, toward: Pt) {
  const d = Math.hypot(toward.x - tip.x, toward.y - tip.y);
  const back = d > 30 ? 10 / d : 0;
  return { x: tip.x + (toward.x - tip.x) * back, y: tip.y + (toward.y - tip.y) * back };
}

/** A piece drawn in its own frame, mm, y down: everything about it but where it goes. */
interface Drawn {
  name: string;
  names: string[];
  cut: string;
  strain95: number;
  cutLines: Pt[][];
  sew?: Pt[];
  marks: { kind: string; x: number; y: number; r: number }[];
  channels: Pt[][];
  darts: { stitch?: Pt[]; points: Pt[] }[];
  notches: [Pt, Pt][];
  seamLabels: { x: number; y: number; angle: number; text: string }[];
  label: Pt;
  grain?: { x: number; y0: number; y1: number };
  fold?: { x: number; y0: number; y1: number };
  info: string;
  garment?: string;
  fabric?: string;
  /** What it covers, cutting line and all. */
  x0: number; y0: number; x1: number; y1: number;
}

interface DrawOptions {
  sa: number;
  hem: number;
  byLine: Record<string, number>;
  notches: { k: number; t: number }[];
  /** Halve it on the line x = foldAt (mm, its own frame), keeping x >= foldAt. */
  foldAt?: number;
  names: string[];
  cut: string;
}

/** The piece's outline in its own frame, mm, y down. */
const netOf = (p: PatternPiece): Pt[] => p.outline.map((i) => ({ x: p.uv[i][0] * MM, y: -p.uv[i][1] * MM }));

/** Edges of the wedge darts cut into its outline: they are stitched, and break its runs. */
function wedgeEdges(p: PatternPiece) {
  const wedges = p.ids ? outlineDarts(p.ids, p.outline, p.edges) : [];
  const m = p.outline.length, edges = new Set<number>();
  for (const w of wedges) for (let q = -w.legs; q < w.legs; q++) edges.add((((w.apex + q) % m) + m) % m);
  return { wedges, edges };
}

/** Drawn pieces by piece and options: laying out again (another sheet width, another paper) does not offset every outline again. */
const drawnCache = new WeakMap<PatternPiece, Map<string, Drawn | null>>();

function drawPiece(p: PatternPiece, o: DrawOptions): Drawn | null {
  const key = JSON.stringify(o);
  let byKey = drawnCache.get(p);
  if (!byKey) drawnCache.set(p, (byKey = new Map()));
  if (byKey.has(key)) return byKey.get(key)!;
  const d = drawPieceNow(p, o);
  byKey.set(key, d);
  return d;
}

function drawPieceNow(p: PatternPiece, o: DrawOptions): Drawn | null {
  if (p.outline.length < 3) return null;
  const at = (i: number): Pt => ({ x: p.uv[i][0] * MM, y: -p.uv[i][1] * MM });
  const m = p.outline.length;
  const net = netOf(p);
  const edge = (k: number): FlatEdge => p.edges?.[((k % m) + m) % m] ?? {};
  const allowance = (e: FlatEdge) => Math.max(0, (e.line !== undefined ? o.byLine[e.line] : undefined) ?? (isHemLine(e.line) ? o.hem : o.sa));
  // Outward from the outline (it runs either way round).
  const ccw = signedArea2(net) > 0;
  const outward = (k: number) => {
    const a = net[k], b = net[(k + 1) % m], l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    return ccw ? { x: (b.y - a.y) / l, y: -(b.x - a.x) / l } : { x: -(b.y - a.y) / l, y: (b.x - a.x) / l };
  };
  const kept = (q: Pt) => o.foldAt === undefined || q.x >= o.foldAt - 0.5;

  // A dart is folded and stitched, never cut: a wedge slit in from the edge
  // is bridged across its mouth on the cutting line (its legs stay on the
  // stitching line), and a double-ended dart is only drawn and marked. Cut
  // out, either left a hole with nothing to sew it by.
  const { wedges, edges: wedgeSet } = wedgeEdges(p);
  const inWedge = new Set<number>(), mouth = new Set<number>();
  for (const w of wedges) {
    for (let q = -w.legs + 1; q <= w.legs - 1; q++) inWedge.add((((w.apex + q) % m) + m) % m);
    mouth.add((((w.apex - w.legs) % m) + m) % m);
  }
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

  // The cutting line before its allowance: the outline with each wedge bridged,
  // each point carrying the allowance of the edge leaving it (a bridge, the
  // allowance of the edge the dart was cut into).
  let cutPts: Pt[] = [], cutD: number[] = [];
  for (let k = 0; k < m; k++) {
    if (inWedge.has(k)) continue;
    cutPts.push(net[k]);
    cutD.push(allowance(edge(mouth.has(k) ? k - 1 : k)));
  }
  let shown = net;
  let fold: Drawn['fold'];
  if (o.foldAt !== undefined) {
    const c = o.foldAt;
    ({ pts: cutPts, attrs: cutD } = clipHalf(cutPts, cutD, c, 0));
    shown = clipHalf(net, net.map(() => 0), c, 0).pts;
    const onFold = shown.filter((q) => Math.abs(q.x - c) < 0.5).map((q) => q.y);
    if (onFold.length >= 2) fold = { x: c, y0: Math.min(...onFold), y1: Math.max(...onFold) };
  }
  const anyAllowance = cutD.some((x) => x > 0);
  let cutLines: Pt[][] = [cutPts];
  if (anyAllowance) {
    const grown = offsetEdges(cutPts, cutD, 2);
    if (grown.length) cutLines = grown;
  }
  const sew = anyAllowance || wedges.length || o.foldAt !== undefined ? shown : undefined;

  // Notches from the stitching line out to the cutting line (inward, with no allowance to cut into).
  const notches: [Pt, Pt][] = [];
  for (const { k, t } of o.notches) {
    const a = net[k], b = net[(k + 1) % m], P = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    if (!kept(P)) continue;
    const n = outward(k), dd = allowance(edge(k));
    notches.push(dd > 0 ? [P, { x: P.x + n.x * dd, y: P.y + n.y * dd }] : [P, { x: P.x - n.x * 4, y: P.y - n.y * 4 }]);
  }

  // Each run of edge named along it, just inside the stitching line.
  const seamLabels: Drawn['seamLabels'] = [];
  for (const r of edgeRuns(p, wedgeSet)) {
    const e = r.edge;
    if (!e.line || r.length * MM < 40) continue;
    // Its middle, or the middle of what is left of it on a half cut on the fold.
    const at2 = (f: number) => {
      let goal = f * r.length;
      for (let j = 0; j < r.count; j++) {
        const kk = (r.start + j) % m, a = p.uv[p.outline[kk]], b = p.uv[p.outline[(kk + 1) % m]], l = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (goal <= l || j === r.count - 1) { const t = l > 0 ? Math.min(1, goal / l) : 0; return { k: kk, t, P: { x: net[kk].x + (net[(kk + 1) % m].x - net[kk].x) * t, y: net[kk].y + (net[(kk + 1) % m].y - net[kk].y) * t } }; }
        goal -= l;
      }
      return { k: r.start, t: 0, P: net[r.start] };
    };
    const samples = Array.from({ length: 21 }, (_, i) => at2((i + 0.5) / 21)).filter((q) => kept(q.P) && (o.foldAt === undefined || q.P.x > o.foldAt + 15));
    if (!samples.length) continue;
    const { k, P } = samples[Math.floor(samples.length / 2)];
    const a = net[k], b = net[(k + 1) % m];
    const n = outward(k);
    let angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
    if (angle > 90) angle -= 180;
    if (angle <= -90) angle += 180;
    const others = (e.to ?? []).filter((x) => x !== p.name);
    const text = e.sewn
      ? `${e.line} \u2192 sews to ${others.length ? others.join(', ') : 'itself'}`
      : e.open ? `${e.line} (opening)`
        : isHemLine(e.line) ? `${e.line}: turn up ${Math.round(allowance(e))} mm`
          : e.line;
    seamLabels.push({ x: P.x - n.x * 5, y: P.y - n.y * 5, angle: +angle.toFixed(1), text });
  }

  // Placement marks for what is sewn on at a point; topstitching is sewn after, not marked.
  const marks = (p.marks ?? []).filter((mk) => mk.kind !== 'stitch').map((mk) => ({ kind: mk.kind, ...at(mk.particle), r: (mk.size * MM) / 2 })).filter(kept);
  const channels = (p.lines ?? []).map((run) => run.map(at).filter(kept)).filter((c) => c.length > 1);
  const keptDarts = darts.map((dt) => ({ ...dt, points: dt.points.filter(kept) })).filter((dt) => dt.points.length || (dt.stitch && dt.stitch.some(kept)));

  const label = deepPoint(shown);
  const chord = verticalChord(shown, label.x, label.y);
  const grain = chord ? { x: label.x, y0: chord[0] + 0.12 * (chord[1] - chord[0]), y1: chord[1] - 0.12 * (chord[1] - chord[0]) } : undefined;
  const sa = o.sa, hem = o.hem;
  const hasHem = (p.edges ?? []).some((e) => isHemLine(e.line));
  const info = [
    sa > 0 ? `+${Math.round(sa)} mm seam` : 'net, no seam allowance',
    ...(hasHem && hem !== sa ? [`${Math.round(hem)} mm hem`] : []),
    ...(p.strain95 >= 0.02 ? [`stretch to fit ${(p.strain95 * 100).toFixed(0)}%`] : []),
  ].join(' \u00b7 ');
  // Its extent from what is drawn, the cutting line's corners included: a
  // box padded by the allowance alone let mitred corners reach into the next piece.
  const b = bounds([...cutLines.flat(), ...shown, ...notches.flat()]);
  return {
    name: o.names.join(' + '), names: o.names, cut: o.cut, strain95: p.strain95,
    cutLines, sew, marks, channels, darts: keptDarts, notches, seamLabels, label, grain, fold, info,
    garment: p.garment, fabric: p.fabric, ...b,
  };
}

const pathOf = (pts: Pt[], dx: number, dy: number, close = true) =>
  pts.map((q, k) => `${k ? 'L' : 'M'}${(q.x + dx).toFixed(1)} ${(q.y + dy).toFixed(1)}`).join(' ') + (close ? ' Z' : '');

/** A drawn piece put at (x, y), its box's top left corner. */
function place(d: Drawn, x: number, y: number): PatternLayout['pieces'][number] {
  const dx = x - d.x0, dy = y - d.y0;
  const mv = (q: Pt) => ({ x: q.x + dx, y: q.y + dy });
  return {
    name: d.name, names: d.names, cut: d.cut, strain95: d.strain95, x, y, w: d.x1 - d.x0, h: d.y1 - d.y0,
    path: d.cutLines.map((l) => pathOf(l, dx, dy)).join(' '),
    sewPath: d.sew ? pathOf(d.sew, dx, dy) : undefined,
    marks: d.marks.map((mk) => ({ ...mk, x: mk.x + dx, y: mk.y + dy })),
    channels: d.channels.map((c) => pathOf(c, dx, dy, false)),
    darts: d.darts.map((dt) => ({ ...(dt.stitch ? { stitch: pathOf(dt.stitch, dx, dy) } : {}), points: dt.points.map(mv) })),
    outlinePts: d.cutLines[0].map(mv),
    notches: d.notches.map(([a, b]) => ({ x1: a.x + dx, y1: a.y + dy, x2: b.x + dx, y2: b.y + dy })),
    seamLabels: d.seamLabels.map((l) => ({ ...l, x: l.x + dx, y: l.y + dy })),
    label: mv(d.label),
    ...(d.grain ? { grain: { x: d.grain.x + dx, y0: d.grain.y0 + dy, y1: d.grain.y1 + dy } } : {}),
    ...(d.fold ? { fold: { x: d.fold.x + dx, y0: d.fold.y0 + dy, y1: d.fold.y1 + dy } } : {}),
    info: d.info,
    ...(d.garment ? { garment: d.garment } : {}),
    ...(d.fabric ? { fabric: d.fabric } : {}),
  };
}

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

/** How the pieces are cut: mirror pairs drawn once, symmetric pieces halved on the fold. */
function cutPlan(pieces: PatternPiece[], fold: boolean): { piece: PatternPiece; names: string[]; cut: string; foldAt?: number }[] {
  if (!fold) return pieces.map((p) => ({ piece: p, names: [p.name], cut: 'Cut 1' }));
  const nets = pieces.map(netOf);
  const boxes = nets.map(bounds);
  const norm = (pts: Pt[], b: ReturnType<typeof bounds>, mirror: boolean) => pts.map((q) => ({ x: mirror ? b.x1 - q.x : q.x - b.x0, y: q.y - b.y0 }));
  const tolOf = (b: ReturnType<typeof bounds>) => Math.max(4, 0.015 * Math.max(b.x1 - b.x0, b.y1 - b.y0));
  const used = new Set<number>(), out: ReturnType<typeof cutPlan> = [];
  for (let i = 0; i < pieces.length; i++) {
    if (used.has(i) || pieces[i].outline.length < 3) continue;
    const bi = boxes[i], tol = tolOf(bi);
    let mate = -1;
    for (let j = i + 1; j < pieces.length && mate < 0; j++) {
      if (used.has(j) || pieces[j].garment !== pieces[i].garment || (pieces[j].fabric ?? '') !== (pieces[i].fabric ?? '')) continue;
      const bj = boxes[j];
      if (Math.abs((bi.x1 - bi.x0) - (bj.x1 - bj.x0)) > 2 * tol || Math.abs((bi.y1 - bi.y0) - (bj.y1 - bj.y0)) > 2 * tol) continue;
      if (sameShape(norm(nets[i], bi, false), norm(nets[j], bj, true), tol)) mate = j;
    }
    used.add(i);
    if (mate >= 0) {
      used.add(mate);
      out.push({ piece: pieces[i], names: [pieces[i].name, pieces[mate].name], cut: 'Cut 2 (a mirrored pair)' });
      continue;
    }
    // The same either side of its middle, marks and all: cut on the fold.
    const c = (bi.x0 + bi.x1) / 2;
    const marks = (pieces[i].marks ?? []).filter((mk) => mk.kind !== 'stitch').map((mk) => ({ kind: mk.kind, x: pieces[i].uv[mk.particle][0] * MM, y: -pieces[i].uv[mk.particle][1] * MM }));
    const marksMirror = marks.every((mk) => marks.some((q) => q.kind === mk.kind && Math.hypot(q.x - (2 * c - mk.x), q.y - mk.y) <= 2 * tol));
    const mirrored = nets[i].map((q) => ({ x: 2 * c - q.x, y: q.y }));
    if (marksMirror && sameShape(nets[i], mirrored, tol)) out.push({ piece: pieces[i], names: [pieces[i].name], cut: 'Cut 1 on fold', foldAt: c });
    else out.push({ piece: pieces[i], names: [pieces[i].name], cut: 'Cut 1' });
  }
  return out;
}

const TITLE_W = 190;
const titleHeight = (lines: string[]) => Math.max(68, 16 + 6.5 * lines.length);

/** The pieces packed onto one sheet, grain down the page; everything in mm, y down the page. */
export function layoutPattern(pieces: PatternPiece[], options?: PatternLayoutOptions): PatternLayout {
  const sa = Math.max(0, options?.seamAllowanceMm ?? 0);
  const hem = Math.max(0, options?.hemAllowanceMm ?? sa);
  const byLine = options?.edgeAllowanceMm ?? {};
  const sorted = [...pieces].sort((a, b) => a.name.localeCompare(b.name));
  const notches = placeNotches(sorted, sorted.map((p) => wedgeEdges(p).edges));
  const notchOf = new Map(sorted.map((p, i) => [p, notches[i]]));
  const drawn = cutPlan(sorted, !!options?.fold)
    .map((c) => drawPiece(c.piece, { sa, hem, byLine, notches: notchOf.get(c.piece) ?? [], names: c.names, cut: c.cut, ...(c.foldAt !== undefined ? { foldAt: c.foldAt } : {}) }))
    .filter((d): d is Drawn => !!d);
  const rects = drawn.map((d) => ({ w: d.x1 - d.x0, h: d.y1 - d.y0 }));
  // The title block ends with the cut list, wrapped to its width.
  let title = options?.titleBlock?.length ? [...options.titleBlock] : undefined;
  if (title) {
    let line = 'Cut:';
    for (const d of drawn) {
      const item = ` ${d.name} ${d.cut.replace(/^Cut /, '\u00d7')}${d === drawn[drawn.length - 1] ? '' : ';'}`;
      if ((line + item).length > 62) { title.push(line); line = ' '; }
      line += item;
    }
    title.push(line);
  }
  if (title) rects.push({ w: TITLE_W, h: titleHeight(title) });
  const M = Math.max(0, options?.marginMm ?? MARGIN);
  const area = rects.reduce((acc, r) => acc + (r.w + GAP) * (r.h + GAP), 0);
  const widest = Math.max(0, ...rects.map((r) => r.w));
  const inner = Math.max(widest, options?.widthMm ? options.widthMm - 2 * M : Math.sqrt(area));
  const { at, length } = packRects(rects, inner, GAP);
  const out = drawn.map((d, i) => place(d, M + at[i].x, M + at[i].y));
  const titleAt = title ? { x: M + at[drawn.length].x, y: M + at[drawn.length].y, w: TITLE_W, h: titleHeight(title), lines: title } : undefined;
  const used = Math.max(0, ...out.map((p) => p.x + p.w), titleAt ? titleAt.x + titleAt.w : 0) + M;
  return { pieces: out, ...(titleAt ? { title: titleAt } : {}), width: Math.max(100, options?.widthMm ?? 0, used), height: length + 2 * M };
}

/** What of a layout is drawn on: the pages worth printing. */
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
  }
  if (L.title) out.push({ x: L.title.x, y: L.title.y, w: L.title.w, h: L.title.h });
  return out;
}

const escXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (v: number) => v.toFixed(1);


/** The layout as an SVG document, 1 unit = 1 mm. */
export function patternSvg(pieces: PatternPiece[], title = 'pattern', options?: PatternLayoutOptions): string {
  const L = layoutPattern(pieces, options);
  const body = L.pieces.map((p) => {
    const lx = p.label.x, ly = p.label.y;
    const sub = [p.cut, ...(p.fabric ? [p.fabric] : [])].join(' \u00b7 ');
    return [
      `<path d="${p.path}" data-operation="cut" fill="none" stroke="#000" stroke-width="0.5"/>`,
      ...(p.sewPath ? [`<path d="${p.sewPath}" data-operation="etch" fill="none" stroke="#64748b" stroke-width="0.35" stroke-dasharray="2.5 1.5"><title>stitching line</title></path>`] : []),
      ...p.notches.map((n) => `<line x1="${f1(n.x1)}" y1="${f1(n.y1)}" x2="${f1(n.x2)}" y2="${f1(n.y2)}" data-operation="etch" stroke="#000" stroke-width="0.5"><title>notch: match to the same notch on the piece it sews to</title></line>`),
      ...p.channels.map((d) => `<path d="${d}" data-operation="etch" fill="none" stroke="#000" stroke-width="0.4" stroke-dasharray="3 1.5"><title>boning channel</title></path>`),
      ...p.darts.flatMap((d) => [
        ...(d.stitch ? [`<path d="${d.stitch}" data-operation="etch" fill="none" stroke="#64748b" stroke-width="0.35" stroke-dasharray="2.5 1.5"><title>dart: fold and stitch, do not cut</title></path>`] : []),
        ...d.points.map((q) => `<path d="M${f1(q.x - 2)} ${f1(q.y)} L${f1(q.x + 2)} ${f1(q.y)} M${f1(q.x)} ${f1(q.y - 2)} L${f1(q.x)} ${f1(q.y + 2)}" data-operation="etch" fill="none" stroke="#000" stroke-width="0.4"><title>dart point: mark through</title></path>`),
      ]),
      ...p.marks.map((m) => `<circle cx="${f1(m.x)}" cy="${f1(m.y)}" r="${Math.max(0.8, m.r).toFixed(1)}" data-operation="etch" fill="${m.kind === 'zipper' ? '#000' : 'none'}" stroke="#000" stroke-width="0.4"><title>${escXml(m.kind)}</title></circle>`),
      ...(p.fold ? (() => {
        const f = p.fold!, bx = f.x + 8, len = f.y1 - f.y0, a = f.y0 + 0.2 * len, b = f.y1 - 0.2 * len;
        return [
          `<path d="M${f1(f.x)} ${f1(a)} L${f1(bx)} ${f1(a)} L${f1(bx)} ${f1(b)} L${f1(f.x)} ${f1(b)}" data-operation="etch" fill="none" stroke="#000" stroke-width="0.4" marker-start="url(#arrow)" marker-end="url(#arrow)"><title>place on fold</title></path>`,
          `<text x="${f1(bx + 4)}" y="${f1((a + b) / 2)}" transform="rotate(-90 ${f1(bx + 4)} ${f1((a + b) / 2)})" data-operation="etch" font-size="5" font-family="sans-serif" text-anchor="middle">PLACE ON FOLD</text>`,
        ];
      })() : []),
      ...p.seamLabels.map((l) => `<text x="${f1(l.x)}" y="${f1(l.y)}" transform="rotate(${l.angle} ${f1(l.x)} ${f1(l.y)})" data-operation="etch" font-size="3.6" font-family="sans-serif" text-anchor="middle" dominant-baseline="middle" fill="#334155">${escXml(l.text)}</text>`),
      // The grain arrow, broken round the label so it does not cross the words out.
      ...(p.grain ? (() => {
        const g = p.grain!, gapTop = ly - 13, gapBottom = ly + 13;
        const segs: [number, number][] = g.y0 < gapTop && g.y1 > gapBottom ? [[g.y0, gapTop], [gapBottom, g.y1]] : [[g.y0, g.y1]];
        return segs.map(([a, b], i) => `<line x1="${f1(g.x)}" y1="${f1(i ? a : b)}" x2="${f1(g.x)}" y2="${f1(i ? b : a)}" data-operation="etch" stroke="#555" stroke-width="0.4" marker-end="url(#arrow)"><title>grain: parallel to the selvedge</title></line>`);
      })() : []),
      ...([[ly - 4, 8, 'font-weight="bold" ', p.name], [ly + 4, 5, '', sub], [ly + 10, 4, '', `${p.info} \u00b7 grain \u2195`]] as const).flatMap(([y, size, weight, text]) => [
        `<text x="${f1(lx)}" y="${f1(y)}" data-operation="etch" font-size="${size}" ${weight}font-family="sans-serif" text-anchor="middle">${escXml(text)}</text>`,
      ]),
    ].join('\n');
  }).join('\n');
  const t = L.title;
  const titleBlock = t ? [
    `<rect x="${f1(t.x)}" y="${f1(t.y)}" width="${f1(t.w)}" height="${f1(t.h)}" data-operation="etch" fill="none" stroke="#000" stroke-width="0.4"/>`,
    ...t.lines.map((line, i) => `<text x="${f1(t.x + 5)}" y="${f1(t.y + 10 + 6.5 * i)}" data-operation="etch" font-size="${i === 0 ? 6 : 4}" ${i === 0 ? 'font-weight="bold" ' : ''}font-family="sans-serif">${escXml(line)}</text>`),
    `<rect x="${f1(t.x + t.w - 57)}" y="${f1(t.y + 7)}" width="50" height="50" data-operation="etch" fill="none" stroke="#000" stroke-width="0.4"><title>test square: 50 mm</title></rect>`,
    `<text x="${f1(t.x + t.w - 32)}" y="${f1(t.y + 32)}" data-operation="etch" font-size="4" font-family="sans-serif" text-anchor="middle">50 \u00d7 50 mm</text>`,
    `<text x="${f1(t.x + t.w - 32)}" y="${f1(t.y + 38)}" data-operation="etch" font-size="3" font-family="sans-serif" text-anchor="middle">measure: printed at 100%?</text>`,
  ].join('\n') : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${L.width.toFixed(0)}mm" height="${L.height.toFixed(0)}mm" viewBox="0 0 ${L.width.toFixed(1)} ${L.height.toFixed(1)}">`,
    `<title>${escXml(title)}</title>`,
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#555"/></marker></defs>`,
    body,
    titleBlock,
    `</svg>`,
  ].join('\n');
}
