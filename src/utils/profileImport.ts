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
  const depths = nestingDepths(usable);
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
      if (depths[j] !== depths[i] - 1 || !pointInPolygon(loop[0], usable[j])) continue;
      if (owner < 0 || areas[j] < areas[owner]) owner = j;
    }
    if (owner >= 0) shapeOf.get(owner)!.holes.push(loop);
  });
  return shapes;
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
  opts: { widthMm?: number; heightMm?: number; scale: number; flipY: boolean },
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
  const placed = shapes.map((s) => ({ outline: map(s.outline), holes: s.holes.map(map) }));
  return { shapes: placed, widthMm: w * k, heightMm: h * k, pointCount: countPoints(placed), notes };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, '': 25.4 / 96 };

/** Millimetres per SVG user unit, from the root's width/height and viewBox; 96 dpi when it says nothing. */
export function svgUnitMm(root: Element): number {
  const viewBox = (root.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite) && viewBox[2] > 0;
  for (const [attr, vbIndex] of [['width', 2], ['height', 3]] as const) {
    const m = /^\s*([\d.]+)\s*([a-z]*)\s*$/i.exec(root.getAttribute(attr) || '');
    if (!m || !(m[2].toLowerCase() in UNIT_MM)) continue;
    const sizeMm = parseFloat(m[1]) * UNIT_MM[m[2].toLowerCase()];
    if (!(sizeMm > 0)) continue;
    return hasViewBox ? sizeMm / viewBox[vbIndex] : UNIT_MM[m[2].toLowerCase()];
  }
  return UNIT_MM.px;
}

const isNone = (paint: unknown) =>
  paint === undefined || paint === null || paint === 'none' || paint === 'transparent' || paint === '';

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
  const loader = new SVGLoader();
  let data: ReturnType<SVGLoader['parse']>;
  try {
    data = loader.parse(svgText);
  } catch (e) {
    throw new Error(`Could not read the SVG: ${(e as Error)?.message || String(e)}`);
  }
  if (!data.xml || data.xml.nodeName.toLowerCase() !== 'svg') {
    throw new Error('That is not an SVG drawing (no <svg> element at the top).');
  }
  const unit = svgUnitMm(data.xml as unknown as Element);
  const DIV = 16;
  const shapes: ProfileShape[] = [];
  const strokeLoops: Point2D[][] = [];
  let openStrokes = 0;
  for (const path of data.paths) {
    const style = (path.userData?.style ?? {}) as { fill?: string; stroke?: string; fillOpacity?: number };
    const filled = !isNone(style.fill) && style.fillOpacity !== 0;
    if (filled) {
      for (const shape of SVGLoader.createShapes(path)) {
        const outline = openRing(shape.getPoints(DIV));
        if (outline.length < 3) continue;
        shapes.push({ outline, holes: shape.holes.map((h) => openRing(h.getPoints(DIV))).filter((h) => h.length >= 3) });
      }
    } else if (!isNone(style.stroke)) {
      for (const sub of path.subPaths) {
        const pts = sub.getPoints(DIV);
        if (pts.length < 2) continue;
        const a = pts[0], z = pts[pts.length - 1];
        const closed = (sub as unknown as { autoClose?: boolean }).autoClose || Math.hypot(a.x - z.x, a.y - z.y) < 1e-6;
        const ring = openRing(pts);
        if (closed && ring.length >= 3) strokeLoops.push(ring);
        else if (!closed) openStrokes++;
      }
    }
  }
  shapes.push(...shapesFromLoops(strokeLoops));
  // Curves come in as straight runs of 16 points; points on a line add nothing.
  const tidy = (l: Point2D[]) => dropCollinear(l, 0.005 / unit);
  const cleaned = shapes
    .map((s) => ({ outline: tidy(s.outline), holes: s.holes.map(tidy).filter((h) => h.length >= 3) }))
    .filter((s) => s.outline.length >= 3);
  const notes: string[] = [];
  if (openStrokes) {
    notes.push(`${openStrokes} open line${openStrokes === 1 ? '' : 's'} skipped: an open stroke encloses nothing. Close the path to make it an outline.`);
  }
  if (!cleaned.length) {
    throw new Error(openStrokes
      ? 'The SVG has only open lines, which enclose nothing. Close the paths, or give them a fill.'
      : 'The SVG has no filled shapes and no closed outlines to make a part from.');
  }
  return placeShapes(cleaned, { ...opts, scale: unit, flipY: true }, notes);
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
  opts: { threshold?: number; subject?: ProfileSubject; blur?: number } = {},
): Segmentation {
  const n = width * height;
  if (!n) throw new Error('The picture is empty.');
  const subject = opts.subject ?? PROFILE_DEFAULTS.subject;

  // A picture that is mostly see-through somewhere is a cut-out: trace its alpha.
  let clear = 0;
  for (let i = 0; i < n; i++) if (rgba[i * 4 + 3] < 128) clear++;
  const byAlpha = subject === 'auto' && clear > n * 0.02;

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

/** Traces the outline of the part in an RGBA picture. */
export function traceProfile(rgba: Uint8ClampedArray, width: number, height: number, opts: TraceOptions = {}): TraceResult {
  const detail = DETAIL[opts.detail ?? PROFILE_DEFAULTS.detail];
  const { tone, threshold, darkSubject, byAlpha } = segmentPicture(rgba, width, height, {
    threshold: opts.threshold, subject: opts.subject, blur: detail.blur,
  });

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

  // Specks: anything smaller than a square 1% of the picture across.
  const speck = (Math.max(width, height) * 0.01) ** 2;
  const kept = rawLoops.filter((l) => Math.abs(polygonArea(l)) >= speck);
  const dropped = rawLoops.length - kept.length;

  let tol = Math.max(width, height) * detail.tol;
  let shapes: ProfileShape[] = [];
  for (let attempt = 0; attempt < 6; attempt++) {
    const thin = (l: Point2D[]) => dropCollinear(simplifyLoop(l, tol), tol * 0.5);
    shapes = shapesFromLoops(kept.map(thin).filter((l) => l.length >= 3));
    if (countPoints(shapes) <= MAX_POINTS) break;
    tol *= 2;
  }
  if (!shapes.length) {
    throw new Error('No outline stood out from the background. Try the threshold, or say which tone the part is.');
  }
  const notes: string[] = [];
  if (dropped) notes.push(`${dropped} speck${dropped === 1 ? '' : 's'} smaller than 1% of the picture dropped.`);
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
  const polys = profile.shapes.map((s) => {
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
      ? `    polygon(points=[${points.join(',')}], paths=[${paths.join(',')}]);`
      : `    polygon([${points.join(',')}]);`;
  });
  return [
    `// ${label.replace(/[\r\n]+/g, ' ')}: ${fmt(profile.widthMm)} x ${fmt(profile.heightMm)} mm outline`,
    `thickness = ${fmt(t)}; // [0.4:0.2:${fmt(Math.max(50, t))}]`,
    '',
    'scale(0.001) linear_extrude(height=thickness) union() {',
    ...polys,
    '}',
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
