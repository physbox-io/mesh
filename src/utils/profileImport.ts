// ---------------------------------------------------------------------------
// Profiles: a flat outline, from an SVG or traced from a picture, made into a
// part of some thickness
//
// THREE THINGS WORTH KNOWING
//
// 1. THE PART IS AN OPENSCAD BODY, NOT A MESH BUILT HERE. The outline goes into
//    `linear_extrude` with `thickness` as a customizer variable, so the
//    thickness is a slider after import, overlapping fills union the way they
//    look, the compile runs on the scad worker, and cutting the shape into
//    another part is the ordinary Combine -> difference. Nothing here makes
//    triangles.
//
// 2. A STROKE IS A PART EDGE. Laser and CNC files draw their cuts as strokes
//    with no fill, so a closed stroke-only path is read as an outline, and all
//    of them in the document nest even-odd: a circle drawn inside a rectangle
//    is a hole in it. Filled paths keep their own fill rule (SVGLoader's
//    createShapes). Open strokes enclose nothing and are reported, not guessed
//    at.
//
// 3. A PICTURE IS TRACED AGAINST ITS OWN BACKGROUND. Whatever touches the
//    border is background: a dark part on white paper and a white part on a
//    dark bench both come out as the part, with no setting. A PNG with real
//    transparency is traced by its alpha instead of its colour. The size comes
//    from one dimension of the part itself (not of the photo), since that is
//    the one a person can measure.
// ---------------------------------------------------------------------------

import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import type { SceneNode } from '../types/scene';
import type { Point2D } from './laserCutExporter';
import { isoContours } from './marchingSquares';
import { dropCollinear, simplifyLoop } from './loopSimplify';
import { nestingDepths, pointInPolygon, polygonArea } from './polygonOffset';

/** One solid region: its outline and the holes in it. mm, y up. */
export interface ProfileShape {
  outline: Point2D[];
  holes: Point2D[][];
}

export interface Profile {
  shapes: ProfileShape[];
  /** Regions cut out of the shapes after they are joined: an SVG's white knockout fills. */
  cutouts?: ProfileShape[];
  /** Bounding size of all the shapes, mm. The shapes are centred on the origin. */
  widthMm: number;
  heightMm: number;
  pointCount: number;
  /** Things the reader should know: open paths skipped, specks dropped. */
  notes: string[];
}

export type ProfileDetail = 'fine' | 'normal' | 'coarse';
export type ProfileSubject = 'auto' | 'dark' | 'light';

/** Shared by the dialog and physics_import_profile, so both start the same. */
export const PROFILE_DEFAULTS = {
  thicknessMm: 3,
  detail: 'normal' as ProfileDetail,
  subject: 'auto' as ProfileSubject,
  /** A traced picture with no size given: the part comes out this wide. */
  tracedWidthMm: 100,
};

/** Above this the OpenSCAD source gets unwieldy; tracing simplifies harder until under it. */
const MAX_POINTS = 20000;

// ---------------------------------------------------------------------------
// Loops -> shapes
// ---------------------------------------------------------------------------

/**
 * Sorts loops that never cross into solid regions by how they nest: even
 * depths are outlines, odd depths holes, and each hole belongs to the
 * smallest outline one level up that contains it.
 */
export function shapesFromLoops(loops: Point2D[][]): ProfileShape[] {
  const usable = loops.filter((l) => l.length >= 3);
  const depths = usable.map((loop, i) => usable.reduce((d, other, j) => d + (i !== j && insideOf(loop, other) ? 1 : 0), 0));
  const areas = usable.map((l) => Math.abs(polygonArea(l)));
  const shapes: ProfileShape[] = [];
  const shapeOf = new Map<number, ProfileShape>();
  usable.forEach((loop, i) => {
    if (depths[i] % 2 === 0) {
      const s = { outline: loop, holes: [] };
      shapes.push(s);
      shapeOf.set(i, s);
    }
  });
  usable.forEach((loop, i) => {
    if (depths[i] % 2 === 0) return;
    let owner = -1;
    for (let j = 0; j < usable.length; j++) {
      if (depths[j] !== depths[i] - 1 || !insideOf(loop, usable[j])) continue;
      if (owner < 0 || areas[j] < areas[owner]) owner = j;
    }
    if (owner >= 0) shapeOf.get(owner)!.holes.push(loop);
  });
  return shapes;
}

/**
 * Whether `loop` lies inside `other`, by a vote of three of its vertices: once
 * the two have been simplified independently a single vertex can land on the
 * wrong side of a nearby edge, and a hole was promoted to a solid that way.
 */
function insideOf(loop: Point2D[], other: Point2D[]): boolean {
  const n = loop.length;
  const votes = [0, Math.floor(n / 3), Math.floor((2 * n) / 3)].filter((v, i, a) => a.indexOf(v) === i);
  const ins = votes.reduce((c, k) => c + (pointInPolygon(loop[k], other) ? 1 : 0), 0);
  return ins * 2 > votes.length;
}

function hullArea(pts: Point2D[]): number {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return 0;
  const cross = (o: Point2D, a: Point2D, b: Point2D) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point2D[] = [], upper: Point2D[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return Math.abs(polygonArea([...lower.slice(0, -1), ...upper.slice(0, -1)]));
}

function bounds(shapes: ProfileShape[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of shapes) {
    for (const p of s.outline) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
  }
  return { minX, minY, maxX, maxY };
}

function countPoints(shapes: ProfileShape[]): number {
  return shapes.reduce((n, s) => n + s.outline.length + s.holes.reduce((m, h) => m + h.length, 0), 0);
}

/**
 * Scales shapes uniformly to the size asked for (width wins over height; with
 * neither, `scale` alone), flips y if asked, and centres them on the origin.
 */
function placeShapes(
  shapes: ProfileShape[],
  opts: { widthMm?: number; heightMm?: number; scale: number; flipY: boolean; cutouts?: ProfileShape[] },
  notes: string[],
): Profile {
  if (!shapes.length) throw new Error('No closed outline was found, so there is nothing to make a part from.');
  const b = bounds(shapes);
  const w = b.maxX - b.minX;
  const h = b.maxY - b.minY;
  let k = opts.scale;
  if (opts.widthMm && opts.widthMm > 0 && w > 0) k = opts.widthMm / w;
  else if (opts.heightMm && opts.heightMm > 0 && h > 0) k = opts.heightMm / h;
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const sy = opts.flipY ? -1 : 1;
  const map = (loop: Point2D[]) => loop.map((p) => ({ x: (p.x - cx) * k, y: sy * (p.y - cy) * k }));
  const place = (list: ProfileShape[]) => list.map((s) => ({ outline: map(s.outline), holes: s.holes.map(map) }));
  const placed = place(shapes);
  const cut = opts.cutouts?.length ? place(opts.cutouts) : undefined;
  return {
    shapes: placed,
    ...(cut ? { cutouts: cut } : {}),
    widthMm: w * k, heightMm: h * k,
    pointCount: countPoints(placed) + (cut ? countPoints(cut) : 0),
    notes,
  };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

/** Millimetres per SVG user unit, from the root's width/height and viewBox; 96 dpi when it says nothing. */
export function svgUnitMm(root: Element): number {
  const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0;
  const size = (attr: string): { mm: number; unit: number } | null => {
    const m = /^\s*([\d.]+(?:e[+-]?\d+)?)\s*([a-z]*)\s*$/i.exec(root.getAttribute(attr) || '');
    if (!m || !(m[2].toLowerCase() in UNIT_MM)) return null;
    const unit = UNIT_MM[m[2].toLowerCase()];
    const mm = parseFloat(m[1]) * unit;
    return mm > 0 ? { mm, unit } : null;
  };
  const w = size('width'), h = size('height');
  if (!hasViewBox) return (w ?? h)?.unit ?? UNIT_MM.px;
  // The viewBox is fitted inside width x height keeping its aspect (the
  // default preserveAspectRatio, "meet"), so the tighter of the two governs.
  const kw = w ? w.mm / viewBox[2] : Infinity;
  const kh = h ? h.mm / viewBox[3] : Infinity;
  if (/^\s*none/.test(root.getAttribute('preserveAspectRatio') || '')) return Number.isFinite(kw) ? kw : Number.isFinite(kh) ? kh : UNIT_MM.px;
  const k = Math.min(kw, kh);
  return Number.isFinite(k) ? k : UNIT_MM.px;
}

const isNone = (paint: unknown) =>
  paint === undefined || paint === null || paint === 'none' || paint === 'transparent' || paint === '' ||
  (typeof paint === 'string' && /^(rgba|hsla)\(.*,\s*0(\.0*)?\s*\)$/i.test(paint.replace(/\s+/g, ' ')));

/** Paper-coloured paint: a knockout when filled, a white-filled cut line when stroked too. */
const isWhite = (paint: unknown) => {
  if (typeof paint !== 'string') return false;
  const v = paint.trim().toLowerCase().replace(/\s+/g, '');
  return v === 'white' || v === '#fff' || v === '#ffffff' || v === '#ffff' || v === '#ffffffff' ||
    /^rgba?\(255,255,255(,1(\.0*)?)?\)$/.test(v) || /^rgba?\(100%,100%,100%/.test(v);
};

/**
 * Elements whose contents are never drawn where they stand. Not <defs> or
 * <symbol>: the loader already skips a defs' contents, and what a <use> draws
 * from either is reported with the node it copied, which lives there.
 */
const UNDRAWN = new Set(['clippath', 'mask', 'marker', 'pattern', 'title', 'desc', 'metadata']);

/** Whether an element, or anything round it, hides it: display, visibility, opacity, or an undrawn container. */
function isHidden(node: Element | null | undefined): boolean {
  for (let el: Element | null | undefined = node; el && el.nodeType === 1; el = el.parentElement) {
    const tag = el.nodeName.toLowerCase().replace(/^svg:/, '');
    if (UNDRAWN.has(tag)) return true;
    const style = (el.getAttribute('style') || '').toLowerCase();
    const prop = (name: string) => {
      const m = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`).exec(style);
      return (m?.[1] ?? el!.getAttribute(name) ?? '').trim().toLowerCase();
    };
    if (prop('display') === 'none') return true;
    const vis = prop('visibility');
    if (vis === 'hidden' || vis === 'collapse') return true;
    const op = prop('opacity');
    if (op !== '' && Number(op) === 0) return true;
  }
  return false;
}

/**
 * Joins open lines whose ends meet into closed loops: a rectangle drawn as four
 * <line>s, or a DXF conversion's separate segments. Returns the loops and how
 * many pieces were left open.
 */
function chainOpen(pieces: Point2D[][], tol: number): { loops: Point2D[][]; open: number } {
  const left = pieces.filter((p) => p.length >= 2).map((p) => [...p]);
  const loops: Point2D[][] = [];
  let open = 0;
  const near = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;
  while (left.length) {
    let chain = left.shift()!;
    let grew = true;
    while (grew && !(chain.length >= 3 && near(chain[0], chain[chain.length - 1]))) {
      grew = false;
      for (let i = 0; i < left.length; i++) {
        const p = left[i];
        const end = chain[chain.length - 1];
        if (near(end, p[0])) chain = [...chain, ...p.slice(1)];
        else if (near(end, p[p.length - 1])) chain = [...chain, ...[...p].reverse().slice(1)];
        else if (near(chain[0], p[p.length - 1])) chain = [...p.slice(0, -1), ...chain];
        else if (near(chain[0], p[0])) chain = [...[...p].reverse().slice(0, -1), ...chain];
        else continue;
        left.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (chain.length >= 3 && near(chain[0], chain[chain.length - 1])) loops.push(openRing(chain));
    else open++;
  }
  return { loops: loops.filter((l) => l.length >= 3), open };
}

/** Points of a closed loop without the repeated closing point. */
function openRing(pts: { x: number; y: number }[]): Point2D[] {
  const out = pts.map((p) => ({ x: p.x, y: p.y }));
  while (out.length > 1) {
    const a = out[0], z = out[out.length - 1];
    if (Math.hypot(a.x - z.x, a.y - z.y) > 1e-9) break;
    out.pop();
  }
  return out;
}

export interface SvgProfileOptions {
  /** Scale the whole drawing to this width, mm. Without it the drawing's own size is kept. */
  widthMm?: number;
  heightMm?: number;
}

export function svgProfile(svgText: string, opts: SvgProfileOptions = {}): Profile {
  // SVG 2 writes <use href>; three's loader reads only xlink:href.
  let text = svgText;
  if (/<use\b[^>]*\shref=/i.test(text)) {
    text = text.replace(/<use\b([^>]*?)\shref=/gi, '<use$1 xlink:href=');
    if (!/xmlns:xlink=/.test(text)) text = text.replace(/<svg\b/i, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }
  const loader = new SVGLoader();
  let data: ReturnType<SVGLoader['parse']>;
  try {
    data = loader.parse(text);
  } catch (e) {
    throw new Error(`Could not read the SVG: ${(e as Error)?.message || String(e)}`);
  }
  if (!data.xml || data.xml.nodeName.toLowerCase() !== 'svg') {
    throw new Error('That is not an SVG drawing (no <svg> element at the top).');
  }
  const root = data.xml as unknown as Element;
  const unit = svgUnitMm(root);
  const DIV = 24;
  const solids: ProfileShape[] = [];
  const cutouts: ProfileShape[] = [];
  const strokeSubs: { pts: Point2D[]; closed: boolean }[] = [];
  let hidden = 0;
  for (const path of data.paths) {
    const node = (path.userData as { node?: Element } | undefined)?.node;
    if (isHidden(node)) { hidden++; continue; }
    const style = (path.userData?.style ?? {}) as { fill?: string; stroke?: string; fillOpacity?: number; strokeOpacity?: number };
    const filled = !isNone(style.fill) && style.fillOpacity !== 0;
    const stroked = !isNone(style.stroke) && style.strokeOpacity !== 0;
    const tag = node?.nodeName.toLowerCase() ?? '';
    // A cut line is a stroke, whether or not the drawing filled it white; a
    // <line> or <polyline> encloses nothing to fill.
    if ((stroked && (!filled || isWhite(style.fill))) || tag === 'line' || tag === 'polyline') {
      for (const sub of path.subPaths) {
        const pts = sub.getPoints(DIV).map((q) => ({ x: q.x, y: q.y }));
        if (pts.length < 2) continue;
        strokeSubs.push({ pts, closed: !!(sub as unknown as { autoClose?: boolean }).autoClose });
      }
    } else if (filled) {
      const into = isWhite(style.fill) ? cutouts : solids;
      for (const shape of SVGLoader.createShapes(path)) {
        const outline = openRing(shape.getPoints(DIV));
        if (outline.length < 3) continue;
        into.push({ outline, holes: shape.holes.map((h) => openRing(h.getPoints(DIV))).filter((h) => h.length >= 3) });
      }
    }
  }

  // Ends that nearly meet are closed: a drawing's "closed" outline is often a
  // hair open, and separate segments that meet end to end are one outline.
  let lo = Infinity, hi = -Infinity, loY = Infinity, hiY = -Infinity;
  for (const sp of strokeSubs) for (const q of sp.pts) { lo = Math.min(lo, q.x); hi = Math.max(hi, q.x); loY = Math.min(loY, q.y); hiY = Math.max(hiY, q.y); }
  const tol = strokeSubs.length ? Math.max(1e-6, 0.002 * Math.hypot(hi - lo, hiY - loY)) : 0;
  const strokeLoops: Point2D[][] = [];
  const openPieces: Point2D[][] = [];
  for (const sp of strokeSubs) {
    const a = sp.pts[0], z = sp.pts[sp.pts.length - 1];
    const ring = openRing(sp.pts);
    if ((sp.closed || Math.hypot(a.x - z.x, a.y - z.y) <= tol) && ring.length >= 3) strokeLoops.push(ring);
    else openPieces.push(sp.pts);
  }
  const chained = chainOpen(openPieces, tol);
  strokeLoops.push(...chained.loops);
  const openStrokes = chained.open;
  solids.push(...shapesFromLoops(strokeLoops));

  // Curves come in as straight runs of points; points on a line add nothing.
  const tidy = (l: Point2D[]) => dropCollinear(l, 0.005 / unit);
  const clean = (list: ProfileShape[]) => list
    .map((sh) => ({ outline: tidy(sh.outline), holes: sh.holes.map(tidy).filter((h) => h.length >= 3) }))
    .filter((sh) => sh.outline.length >= 3);
  const cleaned = clean(solids);
  const cleanedCuts = clean(cutouts);
  const hasText = !!root.querySelector?.('text');
  const notes: string[] = [];
  if (openStrokes) {
    notes.push(`${openStrokes} open line${openStrokes === 1 ? '' : 's'} skipped: an open stroke encloses nothing. Close the path to make it an outline.`);
  }
  if (hidden) notes.push(`${hidden} hidden or clipping shape${hidden === 1 ? '' : 's'} left out.`);
  if (hasText && cleaned.length) notes.push('Text in the SVG is not imported: convert it to paths (Object to Path, Create Outlines) first.');
  if (cleanedCuts.length) notes.push(`${cleanedCuts.length} white shape${cleanedCuts.length === 1 ? '' : 's'} cut out of the others.`);
  if (!cleaned.length) {
    throw new Error(hasText
      ? 'The SVG\'s only content is text, which is not imported. Convert the text to paths (Object to Path in Inkscape, Create Outlines in Illustrator) and import it again.'
      : openStrokes
        ? 'The SVG has only open lines, which enclose nothing. Close the paths, or give them a fill.'
        : 'The SVG has no filled shapes and no closed outlines to make a part from.');
  }
  return placeShapes(cleaned, { ...opts, scale: unit, flipY: true, cutouts: cleanedCuts }, notes);
}

// ---------------------------------------------------------------------------
// Tracing a picture
// ---------------------------------------------------------------------------

export interface TraceOptions {
  /** 0-1 luminance level between part and background. Omitted: chosen from the picture (Otsu). */
  threshold?: number;
  /** Which tone is the part. 'auto': whatever does not touch the border. */
  subject?: ProfileSubject;
  detail?: ProfileDetail;
  /** The part's real width (or height), mm. Neither: PROFILE_DEFAULTS.tracedWidthMm wide. */
  widthMm?: number;
  heightMm?: number;
}

export interface TraceResult extends Profile {
  /** The threshold used, so a slider can start where the automatic choice put it. */
  threshold: number;
  /** Whether the dark tone was taken as the part. */
  darkSubject: boolean;
  /** Traced by alpha (a transparent PNG) rather than by colour. */
  byAlpha: boolean;
}

const DETAIL = {
  fine: { blur: 0, tol: 0.001 },
  normal: { blur: 1, tol: 0.0025 },
  coarse: { blur: 2, tol: 0.006 },
} as const;

/** Otsu's threshold over a 0-1 field: the split that best separates two tones. */
export function otsuThreshold(values: Float32Array): number {
  const BINS = 256;
  const hist = new Float64Array(BINS);
  for (let i = 0; i < values.length; i++) hist[Math.min(BINS - 1, Math.max(0, Math.round(values[i] * (BINS - 1))))]++;
  const total = values.length;
  let sumAll = 0;
  for (let b = 0; b < BINS; b++) sumAll += b * hist[b];
  let wB = 0, sumB = 0, best = -1, bestT = 127;
  for (let t = 0; t < BINS; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; bestT = t; }
  }
  return (bestT + 0.5) / (BINS - 1);
}

function boxBlur(src: Float32Array, w: number, h: number, passes: number): Float32Array {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(a.length);
    const out = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const l = a[y * w + Math.max(0, x - 1)], c = a[y * w + x], r = a[y * w + Math.min(w - 1, x + 1)];
        tmp[y * w + x] = (l + c + r) / 3;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const u = tmp[Math.max(0, y - 1) * w + x], c = tmp[y * w + x], d = tmp[Math.min(h - 1, y + 1) * w + x];
        out[y * w + x] = (u + c + d) / 3;
      }
    }
    a = out;
  }
  return a;
}

export interface Segmentation {
  /** 0 (dark, or opaque) to 1 (light, or clear), per pixel, blurred by the detail setting. */
  tone: Float32Array;
  threshold: number;
  darkSubject: boolean;
  byAlpha: boolean;
}

/**
 * Splits a picture into part and background: by alpha when it has real
 * transparency, else by brightness at the threshold given or Otsu's, with the
 * part being whichever side the border is not (unless `subject` says).
 */
export function segmentPicture(
  rgba: Uint8ClampedArray, width: number, height: number,
  opts: { threshold?: number; subject?: ProfileSubject; blur?: number; ignoreAlpha?: boolean } = {},
): Segmentation {
  const n = width * height;
  if (!n) throw new Error('The picture is empty.');
  const subject = opts.subject ?? PROFILE_DEFAULTS.subject;

  // A picture that is mostly see-through somewhere is a cut-out: trace its alpha.
  let clear = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 128) clear++;
  const byAlpha = subject === 'auto' && !opts.ignoreAlpha && clear > n * 0.02;

  const raw = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rgba[i * 4 + 3] / 255;
    if (byAlpha) raw[i] = 1 - a;
    else {
      const lum = (0.2126 * rgba[i * 4] + 0.7152 * rgba[i * 4 + 1] + 0.0722 * rgba[i * 4 + 2]) / 255;
      raw[i] = lum * a + (1 - a); // see-through reads as white paper
    }
  }
  const tone = boxBlur(raw, width, height, opts.blur ?? DETAIL[PROFILE_DEFAULTS.detail].blur);
  const threshold = Math.min(0.98, Math.max(0.02, opts.threshold ?? (byAlpha ? 0.5 : otsuThreshold(tone))));

  // The part is whichever side of the threshold the border is not.
  let darkSubject: boolean;
  if (byAlpha || subject === 'dark') darkSubject = true;
  else if (subject === 'light') darkSubject = false;
  else {
    let darkBorder = 0, border = 0;
    const visit = (i: number) => { border++; if (tone[i] < threshold) darkBorder++; };
    for (let x = 0; x < width; x++) { visit(x); visit((height - 1) * width + x); }
    for (let y = 1; y < height - 1; y++) { visit(y * width); visit(y * width + width - 1); }
    darkSubject = darkBorder <= border / 2;
  }
  return { tone, threshold, darkSubject, byAlpha };
}

/** 1 where the segmentation says part, 0 where background. */
export function segmentationMask(seg: Segmentation): Uint8Array {
  const out = new Uint8Array(seg.tone.length);
  for (let i = 0; i < out.length; i++) out[i] = (seg.tone[i] < seg.threshold) === seg.darkSubject ? 1 : 0;
  return out;
}

/** Mean tone of the pixels inside a loop given in the tracer's padded grid. */
function meanToneIn(loop: Point2D[], tone: Float32Array, width: number, height: number): number {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const q of loop) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
  const step = Math.max(1, Math.floor(Math.max(x1 - x0, y1 - y0) / 40));
  let sum = 0, n = 0;
  for (let y = Math.ceil(y0); y <= y1; y += step) {
    for (let x = Math.ceil(x0); x <= x1; x += step) {
      const px = x - 1, py = y - 1;
      if (px < 0 || py < 0 || px >= width || py >= height || !pointInPolygon({ x, y }, loop)) continue;
      sum += tone[py * width + px];
      n++;
    }
  }
  return n ? sum / n : 0.5;
}

function borderTone(tone: Float32Array, width: number, height: number): number {
  let sum = 0, n = 0;
  for (let x = 0; x < width; x++) { sum += tone[x] + tone[(height - 1) * width + x]; n += 2; }
  for (let y = 1; y < height - 1; y++) { sum += tone[y * width] + tone[y * width + width - 1]; n += 2; }
  return n ? sum / n : 0.5;
}

/** Traces the outline of the part in an RGBA picture. */
export function traceProfile(rgba: Uint8ClampedArray, width: number, height: number, opts: TraceOptions = {}): TraceResult {
  return traceWith(rgba, width, height, opts, false);
}

function traceWith(rgba: Uint8ClampedArray, width: number, height: number, opts: TraceOptions, ignoreAlpha: boolean): TraceResult {
  const detail = DETAIL[opts.detail ?? PROFILE_DEFAULTS.detail];
  const seg = segmentPicture(rgba, width, height, {
    threshold: opts.threshold, subject: opts.subject, blur: detail.blur, ignoreAlpha,
  });
  const { tone, threshold, byAlpha } = seg;
  let { darkSubject } = seg;

  // Inside is high. A ring of background round the edge closes every loop,
  // including a part that runs off the side of the picture.
  const cols = width + 2, rows = height + 2;
  const field = new Float32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const t = tone[y * width + x];
      field[(y + 1) * cols + x + 1] = darkSubject ? 1 - t : t;
    }
  }
  const level = darkSubject ? 1 - threshold : threshold;
  const rawLoops = isoContours(field, cols, rows, level);

  // Specks: an outline smaller than a square 1% of the picture's long side,
  // a hole smaller than one 0.3% across. A small bolt hole is a hole, not dirt.
  const side = Math.max(width, height);
  const rawDepths = nestingDepths(rawLoops);
  const kept = rawLoops.filter((l, i) => Math.abs(polygonArea(l)) >= (side * (rawDepths[i] % 2 ? 0.003 : 0.01)) ** 2);
  const dropped = rawLoops.length - kept.length;

  let tol = side * detail.tol;
  let loops: Point2D[][] = [];
  let shapes: ProfileShape[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    // No coarser than 3% of the loop's own size, so a small hole stays round.
    const thin = (l: Point2D[]) => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of l) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
      const t = Math.max(0.3, Math.min(tol, 0.03 * Math.hypot(x1 - x0, y1 - y0)));
      return dropCollinear(simplifyLoop(l, t), t * 0.5);
    };
    loops = kept.map(thin).filter((l) => l.length >= 3);
    shapes = shapesFromLoops(loops);
    if (countPoints(shapes) <= MAX_POINTS) break;
    tol *= 2;
  }

  const notes: string[] = [];
  // A part on a sheet of paper with the table showing round it: the border
  // vote takes the table for background and the paper for the part, with the
  // real part a hole in it. A large, convex light region holding a large hole
  // is that sheet; peel it off and the hole is the part.
  if ((opts.subject ?? 'auto') === 'auto' && !byAlpha && !darkSubject) {
    const picture = width * height;
    for (let peel = 0; peel < 2; peel++) {
      // What shows through a light washer's hole is the bench, the border's
      // tone; what fills the hole in a sheet of paper is the part, which is not.
      const sheet = shapes.find((sh) => {
        const a = Math.abs(polygonArea(sh.outline));
        if (a < 0.2 * picture || a < 0.95 * hullArea(sh.outline)) return false;
        const big = sh.holes.filter((h) => Math.abs(polygonArea(h)) >= 0.05 * a);
        return big.some((h) => Math.abs(meanToneIn(h, tone, width, height) - borderTone(tone, width, height)) > 0.15);
      });
      if (!sheet) break;
      loops = loops.filter((l) => l !== sheet.outline);
      shapes = shapesFromLoops(loops);
      darkSubject = !darkSubject;
      notes.push('Traced the part inside the sheet it lies on (the sheet is the background).');
    }
  }

  // A photo with a transparent margin or rounded corners is not a cut-out:
  // alpha gives back the opaque rectangle. Trace its colours instead.
  if (byAlpha && !ignoreAlpha && shapes.length === 1 && !shapes[0].holes.length) {
    const a = Math.abs(polygonArea(shapes[0].outline));
    const b = bounds(shapes);
    if (a >= 0.5 * width * height && a >= 0.9 * (b.maxX - b.minX) * (b.maxY - b.minY)) {
      return traceWith(rgba, width, height, opts, true);
    }
  }

  if (!shapes.length) {
    throw new Error('No outline stood out from the background. Try the threshold, or say which tone the part is.');
  }
  if (dropped) notes.push(`${dropped} speck${dropped === 1 ? '' : 's'} dropped (smaller than 1% of the picture's width, or 0.3% for a hole).`);
  const width0 = opts.widthMm ?? (opts.heightMm ? undefined : PROFILE_DEFAULTS.tracedWidthMm);
  const placed = placeShapes(shapes, { widthMm: width0, heightMm: opts.heightMm, scale: 1, flipY: true }, notes);
  return { ...placed, threshold, darkSubject, byAlpha };
}

// ---------------------------------------------------------------------------
// OpenSCAD
// ---------------------------------------------------------------------------

const fmt = (v: number) => {
  const s = v.toFixed(3);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
};

/**
 * The part as OpenSCAD: millimetres inside, scaled to the app's metres, with
 * `thickness` as a customizer slider. Each shape is one polygon (outline, then
 * its holes as further paths); the shapes are unioned.
 */
export function profileScad(profile: Profile, thicknessMm: number = PROFILE_DEFAULTS.thicknessMm, label = 'Profile'): string {
  const t = Math.max(0.1, thicknessMm);
  const polygons = (list: ProfileShape[], indent: string) => list.map((s) => {
    const loops = [s.outline, ...s.holes];
    const points: string[] = [];
    const paths: string[] = [];
    let k = 0;
    for (const loop of loops) {
      const idx: number[] = [];
      for (const p of loop) {
        points.push(`[${fmt(p.x)},${fmt(p.y)}]`);
        idx.push(k++);
      }
      paths.push(`[${idx.join(',')}]`);
    }
    return s.holes.length
      ? `${indent}polygon(points=[${points.join(',')}], paths=[${paths.join(',')}]);`
      : `${indent}polygon([${points.join(',')}]);`;
  });
  // Braces in a comment still count toward parseScadVariables' depth, and a
  // stray one hid the thickness slider.
  const title = label.replace(/[\r\n{}]+/g, ' ').trim();
  const body = profile.cutouts?.length
    ? ['scale(0.001) linear_extrude(height=thickness) difference() {', '  union() {', ...polygons(profile.shapes, '    '), '  }',
       '  union() {', ...polygons(profile.cutouts, '    '), '  }', '}']
    : ['scale(0.001) linear_extrude(height=thickness) union() {', ...polygons(profile.shapes, '    '), '}'];
  return [
    `// ${title}: ${fmt(profile.widthMm)} x ${fmt(profile.heightMm)} mm outline`,
    `thickness = ${fmt(t)}; // [0.4:0.2:${fmt(Math.max(50, t))}]`,
    '',
    ...body,
  ].join('\n');
}

/**
 * The body: an OpenSCAD node the scad worker compiles, lying flat on the
 * ground, free to move like any other import.
 */
export function profileNode(profile: Profile, opts: { name?: string; thicknessMm?: number; pos?: [number, number, number] } = {}): SceneNode {
  const name = (opts.name || 'profile').trim() || 'profile';
  const id = `profile_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    name,
    pos: opts.pos ?? [0, 0, 0.02],
    scad: profileScad(profile, opts.thicknessMm ?? PROFILE_DEFAULTS.thicknessMm, name),
    geoms: [{ name: `${id}_geom`, type: 'mesh', size: [1], dynamic: true }],
    joints: [{ name: `${id}_free`, type: 'free' }],
    children: [],
  } as SceneNode;
}
