// ---------------------------------------------------------------------------
// Lettering, as outlines a surface pattern can be drawn from.
//
// Text is laid out once, on the main thread where the font is (see
// fontLibrary.ts), into closed contours in millimetres, and those contours
// are saved with the pattern as a string. The pattern's build then only has
// to fill them in on its grid -- so the texture worker, the exporters, a
// reloaded scene and the tests never need the font, or the network.
//
// Contours are y-up, in mm, centred on the origin, and filled by the nonzero
// rule: a variable font's glyphs are drawn from overlapping pieces, and the
// even-odd rule punches a hole wherever two of them cross.
//
// Pure: no store, no three, no DOM.
// ---------------------------------------------------------------------------

/** One closed outline, as x0, y0, x1, y1, ... in mm. Closed implicitly. */
export type Contour = number[];

// --- the slice of opentype.js used here ---------------------------------------

export interface GlyphLike {
  advanceWidth?: number;
  getPath(x: number, y: number, fontSize: number, options?: object, font?: unknown): { commands: PathCommand[] };
}

export interface FontLike {
  unitsPerEm: number;
  ascender: number;
  descender: number;
  charToGlyph(ch: string): GlyphLike;
  getKerningValue?(left: GlyphLike, right: GlyphLike): number;
  tables?: { os2?: { sCapHeight?: number }; fvar?: { axes?: { tag: string; minValue: number; maxValue: number }[] } };
}

export interface PathCommand {
  type: string;
  x?: number;
  y?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

// --- flattening ----------------------------------------------------------------

/** Points along a quadratic or cubic, enough that no chord strays more than `tol`. */
function bezierSteps(span: number, tol: number): number {
  return Math.max(2, Math.min(64, Math.ceil(Math.sqrt(span / Math.max(1e-9, tol)))));
}

/** opentype.js path commands (absolute, y-down) to contours (y-down, same units). */
export function flattenCommands(commands: PathCommand[], tol: number): Contour[] {
  const out: Contour[] = [];
  let cur: Contour = [];
  let x = 0, y = 0;
  const close = () => {
    if (cur.length >= 6) out.push(cur);
    cur = [];
  };
  for (const c of commands) {
    if (c.type === 'M') {
      close();
      x = c.x ?? 0; y = c.y ?? 0;
      cur.push(x, y);
    } else if (c.type === 'L') {
      x = c.x ?? x; y = c.y ?? y;
      cur.push(x, y);
    } else if (c.type === 'Q') {
      const x1 = c.x1 ?? x, y1 = c.y1 ?? y, ex = c.x ?? x, ey = c.y ?? y;
      const n = bezierSteps(Math.hypot(x1 - x, y1 - y) + Math.hypot(ex - x1, ey - y1), tol);
      for (let i = 1; i <= n; i++) {
        const t = i / n, s = 1 - t;
        cur.push(s * s * x + 2 * s * t * x1 + t * t * ex, s * s * y + 2 * s * t * y1 + t * t * ey);
      }
      x = ex; y = ey;
    } else if (c.type === 'C') {
      const x1 = c.x1 ?? x, y1 = c.y1 ?? y, x2 = c.x2 ?? x, y2 = c.y2 ?? y, ex = c.x ?? x, ey = c.y ?? y;
      const n = bezierSteps(Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(ex - x2, ey - y2), tol);
      for (let i = 1; i <= n; i++) {
        const t = i / n, s = 1 - t;
        cur.push(
          s * s * s * x + 3 * s * s * t * x1 + 3 * s * t * t * x2 + t * t * t * ex,
          s * s * s * y + 3 * s * s * t * y1 + 3 * s * t * t * y2 + t * t * t * ey,
        );
      }
      x = ex; y = ey;
    } else if (c.type === 'Z' || c.type === 'z') {
      close();
    }
  }
  close();
  // A contour that ends where it began repeats that point; drop the copy.
  for (const k of out) {
    const n = k.length;
    if (n >= 4 && Math.abs(k[0] - k[n - 2]) < 1e-9 && Math.abs(k[1] - k[n - 1]) < 1e-9) k.length = n - 2;
  }
  return out.filter((k) => k.length >= 6);
}

/**
 * An SVG path's `d` as polylines, in its own units, y-down as written. Every
 * command is understood, relative and absolute, arcs included, since a path
 * pasted from Inkscape or Etch uses all of them. Open subpaths are kept open:
 * text runs along a guide, it does not fill it.
 */
export function flattenSvgPath(d: string, tol: number): number[][] {
  const tokens = d.match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) ?? [];
  const out: number[][] = [];
  let cur: number[] = [];
  let i = 0;
  let cmd = '';
  let x = 0, y = 0, sx = 0, sy = 0;
  // The last control point, for S and T's reflection.
  let cx = 0, cy = 0, lastCmd = '';
  const isCmd = (t: string | undefined) => !!t && /^[a-zA-Z]$/.test(t);
  const num = () => {
    const t = tokens[i++];
    const v = Number(t);
    if (t === undefined || !Number.isFinite(v)) throw new Error('A path ran out of numbers part way through a command.');
    return v;
  };
  const flush = () => {
    if (cur.length >= 4) out.push(cur);
    cur = [];
  };
  const pushCubic = (x1: number, y1: number, x2: number, y2: number, ex: number, ey: number) => {
    const n = bezierSteps(Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(ex - x2, ey - y2), tol);
    for (let k = 1; k <= n; k++) {
      const t = k / n, s = 1 - t;
      cur.push(
        s * s * s * x + 3 * s * s * t * x1 + 3 * s * t * t * x2 + t * t * t * ex,
        s * s * s * y + 3 * s * s * t * y1 + 3 * s * t * t * y2 + t * t * t * ey,
      );
    }
  };
  const pushQuad = (x1: number, y1: number, ex: number, ey: number) => {
    const n = bezierSteps(Math.hypot(x1 - x, y1 - y) + Math.hypot(ex - x1, ey - y1), tol);
    for (let k = 1; k <= n; k++) {
      const t = k / n, s = 1 - t;
      cur.push(s * s * x + 2 * s * t * x1 + t * t * ex, s * s * y + 2 * s * t * y1 + t * t * ey);
    }
  };
  const pushArc = (rx: number, ry: number, phiDeg: number, large: boolean, sweep: boolean, ex: number, ey: number) => {
    // SVG's endpoint parameterisation to a centre and two angles (SVG 1.1 F.6.5).
    rx = Math.abs(rx); ry = Math.abs(ry);
    if (rx === 0 || ry === 0 || (x === ex && y === ey)) { cur.push(ex, ey); return; }
    const phi = (phiDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    const dx = (x - ex) / 2, dy = (y - ey) / 2;
    const x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    const num2 = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
    const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
    let co = Math.sqrt(Math.max(0, num2 / den));
    if (large === sweep) co = -co;
    const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
    const ccx = cp * cxp - sp * cyp + (x + ex) / 2, ccy = sp * cxp + cp * cyp + (y + ey) / 2;
    const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
    let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!sweep && dt > 0) dt -= 2 * Math.PI;
    if (sweep && dt < 0) dt += 2 * Math.PI;
    const r = Math.max(rx, ry);
    const n = Math.max(2, Math.min(256, Math.ceil(Math.abs(dt) / (2 * Math.acos(Math.max(-1, 1 - tol / r))))));
    for (let k = 1; k <= n; k++) {
      const t = t1 + (dt * k) / n;
      const px = rx * Math.cos(t), py = ry * Math.sin(t);
      cur.push(cp * px - sp * py + ccx, sp * px + cp * py + ccy);
    }
  };

  while (i < tokens.length) {
    if (isCmd(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new Error('A path has to start with a command such as M.');
    const rel = cmd === cmd.toLowerCase();
    const ox = rel ? x : 0, oy = rel ? y : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        flush();
        x = ox + num(); y = oy + num();
        sx = x; sy = y;
        cur.push(x, y);
        // Pairs after a moveto are linetos.
        cmd = rel ? 'l' : 'L';
        lastCmd = 'M';
        continue;
      }
      case 'L': { x = ox + num(); y = oy + num(); cur.push(x, y); break; }
      case 'H': { x = ox + num(); cur.push(x, y); break; }
      case 'V': { y = oy + num(); cur.push(x, y); break; }
      case 'C': {
        const x1 = ox + num(), y1 = oy + num(), x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
        pushCubic(x1, y1, x2, y2, ex, ey);
        cx = x2; cy = y2; x = ex; y = ey;
        lastCmd = 'C';
        continue;
      }
      case 'S': {
        const x1 = lastCmd === 'C' ? 2 * x - cx : x, y1 = lastCmd === 'C' ? 2 * y - cy : y;
        const x2 = ox + num(), y2 = oy + num(), ex = ox + num(), ey = oy + num();
        pushCubic(x1, y1, x2, y2, ex, ey);
        cx = x2; cy = y2; x = ex; y = ey;
        lastCmd = 'C';
        continue;
      }
      case 'Q': {
        const x1 = ox + num(), y1 = oy + num(), ex = ox + num(), ey = oy + num();
        pushQuad(x1, y1, ex, ey);
        cx = x1; cy = y1; x = ex; y = ey;
        lastCmd = 'Q';
        continue;
      }
      case 'T': {
        const x1 = lastCmd === 'Q' ? 2 * x - cx : x, y1 = lastCmd === 'Q' ? 2 * y - cy : y;
        const ex = ox + num(), ey = oy + num();
        pushQuad(x1, y1, ex, ey);
        cx = x1; cy = y1; x = ex; y = ey;
        lastCmd = 'Q';
        continue;
      }
      case 'A': {
        const rx = num(), ry = num(), rot = num(), large = num() !== 0, sweep = num() !== 0;
        const ex = ox + num(), ey = oy + num();
        pushArc(rx, ry, rot, large, sweep, ex, ey);
        x = ex; y = ey;
        break;
      }
      case 'Z': {
        if (x !== sx || y !== sy) cur.push(sx, sy);
        x = sx; y = sy;
        flush();
        cur.push(x, y);
        break;
      }
      default:
        throw new Error(`A path command "${cmd}" is not one SVG has.`);
    }
    lastCmd = cmd.toUpperCase();
  }
  flush();
  return out;
}

// --- the line the text runs along ----------------------------------------------

/** Where a distance along a guide is, and which way it runs there. y-up. */
interface GuideSample { x: number; y: number; tx: number; ty: number }

export interface Guide {
  length: number;
  at(s: number): GuideSample;
}

/** A polyline as a guide, extended straight past either end. */
export function polylineGuide(pts: number[]): Guide {
  const n = pts.length / 2;
  const cum = [0];
  for (let k = 1; k < n; k++) cum.push(cum[k - 1] + Math.hypot(pts[2 * k] - pts[2 * k - 2], pts[2 * k + 1] - pts[2 * k - 1]));
  const length = cum[n - 1] ?? 0;
  const seg = (k: number, s: number): GuideSample => {
    const ax = pts[2 * k], ay = pts[2 * k + 1], bx = pts[2 * k + 2], by = pts[2 * k + 3];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    const t = s - cum[k];
    return { x: ax + ((bx - ax) * t) / l, y: ay + ((by - ay) * t) / l, tx: (bx - ax) / l, ty: (by - ay) / l };
  };
  return {
    length,
    at(s) {
      if (n < 2) return { x: pts[0] ?? 0, y: pts[1] ?? 0, tx: 1, ty: 0 };
      if (s <= 0) return seg(0, s);
      if (s >= length) return seg(n - 2, s);
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= s) lo = mid; else hi = mid;
      }
      // Skip zero-length pieces, whose direction is undefined.
      while (lo < n - 2 && cum[lo + 1] - cum[lo] < 1e-12) lo++;
      return seg(lo, s);
    },
  };
}

/**
 * A circle of radius r about the origin, as a guide: over the top running
 * clockwise, or under the bottom running anticlockwise -- either way left to
 * right, so the text reads upright. s = 0 is the top (or bottom) point.
 */
export function circleGuide(r: number, side: 'top' | 'bottom'): Guide {
  const C = 2 * Math.PI * r;
  return {
    length: C,
    at(s) {
      const a = s / r;
      if (side === 'top') {
        const t = Math.PI / 2 - a;
        return { x: r * Math.cos(t), y: r * Math.sin(t), tx: Math.sin(t), ty: -Math.cos(t) };
      }
      const t = -Math.PI / 2 + a;
      return { x: r * Math.cos(t), y: r * Math.sin(t), tx: -Math.sin(t), ty: Math.cos(t) };
    },
  };
}

// --- laying text out ------------------------------------------------------------

export type TextAlign = 'left' | 'centre' | 'right';
export type TextPath = 'straight' | 'arc' | 'wave' | 'custom';

export interface TextLayout {
  text: string;
  /** Height of a capital letter, mm. */
  heightMm: number;
  /** Extra space between letters, mm. */
  letterSpacingMm?: number;
  /** Baseline to baseline, as a multiple of the letter height. */
  lineSpacing?: number;
  align?: TextAlign;
  /** A weight on the font's wght axis, for a variable font. */
  weight?: number;
  path?: TextPath;
  /** Arc: radius of the circle the letters stand on (inner edge of the lettering), mm. */
  arcRadiusMm?: number;
  arcSide?: 'top' | 'bottom';
  waveAmpMm?: number;
  waveLengthMm?: number;
  /** Custom: an SVG path, in mm, y-down as SVG draws it. */
  pathD?: string;
  /** Where along the path the text sits: its start, middle or end. */
  pathAlign?: 'start' | 'centre' | 'end';
  /** Slides the text along the path, mm. */
  pathOffsetMm?: number;
  /** A rectangle round straight text, this thick, mm; 0 for none. */
  boxMm?: number;
  /** Gap between the text and the box, mm. */
  boxPadMm?: number;
}

/** The capital height as a fraction of the em: the OS/2 table's, or measured off an H. */
export function capFraction(font: FontLike): number {
  const os2 = font.tables?.os2?.sCapHeight;
  if (os2 && os2 > 0) return os2 / font.unitsPerEm;
  try {
    const cmds = font.charToGlyph('H').getPath(0, 0, font.unitsPerEm).commands;
    let top = 0;
    for (const c of cmds) if (typeof c.y === 'number') top = Math.min(top, c.y);
    if (top < 0) return -top / font.unitsPerEm;
  } catch {
    /* no H in this font: fall through */
  }
  return 0.7;
}

interface Run {
  /** Glyph outlines, y-up, baseline at y = 0, starting at x = 0. */
  contours: Contour[];
  /** Where each glyph's own middle is along the run, and its contours. */
  glyphs: { mid: number; from: number; to: number }[];
  width: number;
}

/** One line of glyphs, kerned, with tracking. Ligatures are not formed: a run always exists. */
function setRun(font: FontLike, line: string, em: number, tracking: number, weight: number | undefined, tol: number): Run {
  const scale = em / font.unitsPerEm;
  const wght = font.tables?.fvar?.axes?.find((a) => a.tag === 'wght');
  const options = wght && weight
    ? { variation: { wght: Math.max(wght.minValue, Math.min(wght.maxValue, weight)) } }
    : undefined;
  const chars = [...line];
  const contours: Contour[] = [];
  const glyphs: Run['glyphs'] = [];
  let x = 0;
  for (let i = 0; i < chars.length; i++) {
    const glyph = font.charToGlyph(chars[i]);
    const advance = (glyph.advanceWidth ?? font.unitsPerEm * 0.5) * scale;
    const from = contours.length;
    let commands: PathCommand[] = [];
    try {
      commands = glyph.getPath(x, 0, em, options, font).commands;
    } catch {
      /* a glyph opentype.js cannot draw is left as a space */
    }
    for (const k of flattenCommands(commands, tol)) {
      for (let j = 1; j < k.length; j += 2) k[j] = -k[j];
      contours.push(k);
    }
    glyphs.push({ mid: x + advance / 2, from, to: contours.length });
    x += advance;
    const next = chars[i + 1];
    if (next !== undefined) {
      x += tracking;
      if (typeof font.getKerningValue === 'function') {
        try {
          const kern = font.getKerningValue(glyph, font.charToGlyph(next));
          if (Number.isFinite(kern)) x += kern * scale;
        } catch {
          /* no kerning table */
        }
      }
    }
  }
  return { contours, glyphs, width: x };
}

const bounds = (contours: Contour[]) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of contours) {
    for (let j = 0; j < k.length; j += 2) {
      x0 = Math.min(x0, k[j]); x1 = Math.max(x1, k[j]);
      y0 = Math.min(y0, k[j + 1]); y1 = Math.max(y1, k[j + 1]);
    }
  }
  return { x0, y0, x1, y1 };
};

/** A rectangle's outline with the same winding as `inner`'s outside, or opposite. */
function rect(x0: number, y0: number, x1: number, y1: number, ccw: boolean): Contour {
  return ccw ? [x0, y0, x1, y0, x1, y1, x0, y1] : [x0, y0, x0, y1, x1, y1, x1, y0];
}

/** Signed area, positive anticlockwise (y-up). */
function signedArea(k: Contour): number {
  let a = 0;
  for (let j = 0; j < k.length; j += 2) {
    const n = (j + 2) % k.length;
    a += k[j] * k[n + 1] - k[n] * k[j + 1];
  }
  return a / 2;
}

/**
 * The text as contours in mm, y-up, centred on the origin -- straight text
 * on its block's middle, an arc on its circle's centre, any other path on the
 * middle of its own bounds.
 */
export function layoutText(font: FontLike, o: TextLayout): Contour[] {
  const height = Math.max(0.1, o.heightMm);
  const em = height / capFraction(font);
  const tracking = o.letterSpacingMm ?? 0;
  const tol = Math.max(0.004, height * 0.0025);
  const path = o.path ?? 'straight';

  if (path === 'straight') {
    const lines = o.text.split(/\r?\n/);
    const pitch = height * (o.lineSpacing ?? 1.6);
    const runs = lines.map((l) => setRun(font, l, em, tracking, o.weight, tol));
    const widest = Math.max(0, ...runs.map((r) => r.width));
    const out: Contour[] = [];
    runs.forEach((run, i) => {
      const dx = o.align === 'left' ? -widest / 2 : o.align === 'right' ? widest / 2 - run.width : -run.width / 2;
      // The block is centred on its capitals: first line's cap top to last line's baseline.
      const top = (height + (lines.length - 1) * pitch) / 2;
      const dy = top - height - i * pitch;
      for (const k of run.contours) {
        const m = k.slice();
        for (let j = 0; j < m.length; j += 2) { m[j] += dx; m[j + 1] += dy; }
        out.push(m);
      }
    });
    const box = o.boxMm ?? 0;
    if (box > 0 && out.length) {
      const pad = Math.max(0, o.boxPadMm ?? 3);
      const b = bounds(out);
      // Wound to add to the letters' fill: whichever way the font winds its outsides.
      const lettersCcw = out.reduce((s, k) => s + signedArea(k), 0) >= 0;
      const ix0 = b.x0 - pad, iy0 = b.y0 - pad, ix1 = b.x1 + pad, iy1 = b.y1 + pad;
      out.push(rect(ix0 - box, iy0 - box, ix1 + box, iy1 + box, lettersCcw));
      out.push(rect(ix0, iy0, ix1, iy1, !lettersCcw));
    }
    return out;
  }

  // On a path: one line, every glyph turned to the path where its middle falls.
  const run = setRun(font, o.text.replace(/\s*\r?\n\s*/g, ' '), em, tracking, o.weight, tol);
  let guide: Guide;
  let along0: number;
  let centreOnBounds = true;
  if (path === 'arc') {
    const side = o.arcSide ?? 'top';
    const r = Math.max(height, o.arcRadiusMm ?? 30);
    // Both sides fill the same ring, from r out to r + height: bottom text
    // hangs from the outer circle with its capitals pointing in.
    guide = circleGuide(side === 'top' ? r : r + height, side);
    along0 = -run.width / 2;
    centreOnBounds = false;
  } else if (path === 'wave') {
    const amp = o.waveAmpMm ?? 4;
    const wl = Math.max(1, o.waveLengthMm ?? 40);
    const span = run.width + 2 * wl;
    const pts: number[] = [];
    const n = Math.max(32, Math.ceil(span / Math.max(0.05, tol * 4)));
    for (let k = 0; k <= n; k++) {
      const x = -span / 2 + (span * k) / n;
      pts.push(x, amp * Math.sin((2 * Math.PI * x) / wl));
    }
    guide = polylineGuide(pts);
    along0 = span / 2 - run.width / 2;
  } else {
    const lines = flattenSvgPath(o.pathD ?? '', tol);
    if (!lines.length) throw new Error('The custom path is empty: give an SVG path such as "M 0 0 C 30 -30 70 -30 100 0", in mm.');
    const pts: number[] = [];
    for (const l of lines) for (let j = 0; j < l.length; j += 2) pts.push(l[j], -l[j + 1]);
    guide = polylineGuide(pts);
    const align = o.pathAlign ?? 'centre';
    along0 = align === 'start' ? 0 : align === 'end' ? guide.length - run.width : (guide.length - run.width) / 2;
  }
  along0 += o.pathOffsetMm ?? 0;

  const out: Contour[] = [];
  for (const g of run.glyphs) {
    const p = guide.at(along0 + g.mid);
    // Left of the direction of travel is up for the letter.
    const nx = -p.ty, ny = p.tx;
    for (let c = g.from; c < g.to; c++) {
      const k = run.contours[c];
      const m: Contour = new Array(k.length);
      for (let j = 0; j < k.length; j += 2) {
        const dx = k[j] - g.mid, dy = k[j + 1];
        m[j] = p.x + dx * p.tx + dy * nx;
        m[j + 1] = p.y + dx * p.ty + dy * ny;
      }
      out.push(m);
    }
  }
  if (centreOnBounds && out.length) {
    const b = bounds(out);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    for (const k of out) for (let j = 0; j < k.length; j += 2) { k[j] -= cx; k[j + 1] -= cy; }
  }
  return out;
}

// --- saving ---------------------------------------------------------------------

/** Contours as text: "x,y x,y ...;x,y ..." to 0.01 mm. */
export function encodeContours(contours: Contour[]): string {
  const r = (v: number) => {
    const s = (Math.round(v * 100) / 100).toString();
    return s === '-0' ? '0' : s;
  };
  return contours
    .map((k) => {
      const pts: string[] = [];
      for (let j = 0; j < k.length; j += 2) {
        const p = `${r(k[j])},${r(k[j + 1])}`;
        if (pts[pts.length - 1] !== p) pts.push(p);
      }
      return pts.join(' ');
    })
    .filter((s) => s.split(' ').length >= 3)
    .join(';');
}

const decoded = new Map<string, Contour[]>();

export function decodeContours(s: string): Contour[] {
  const hit = decoded.get(s);
  if (hit) return hit;
  const out: Contour[] = [];
  for (const part of s.split(';')) {
    const k: Contour = [];
    for (const p of part.trim().split(/\s+/)) {
      const [x, y] = p.split(',').map(Number);
      if (Number.isFinite(x) && Number.isFinite(y)) k.push(x, y);
    }
    if (k.length >= 6) out.push(k);
  }
  if (decoded.size > 32) decoded.clear();
  decoded.set(s, out);
  return out;
}

// --- filling ----------------------------------------------------------------------

/**
 * How much of each grid cell the contours cover, 0..1, by the nonzero rule.
 * Cell (c, r) is centred on (x0 + c * dx, y0 + r * dy), in the contours' units.
 * Four scanlines a row and exact span ends across it, so an edge comes out as
 * a ramp one cell wide rather than a staircase.
 */
export function fillContours(contours: Contour[], cols: number, rows: number, x0: number, y0: number, dx: number, dy: number): Float32Array {
  const out = new Float32Array(cols * rows);
  // Every edge, lowest end first, with its winding.
  const edges: { ya: number; yb: number; xa: number; slope: number; dir: number }[] = [];
  for (const k of contours) {
    for (let j = 0; j < k.length; j += 2) {
      const n = (j + 2) % k.length;
      const ax = k[j], ay = k[j + 1], bx = k[n], by = k[n + 1];
      if (ay === by) continue;
      const up = by > ay;
      const lo = up ? [ax, ay] : [bx, by], hi = up ? [bx, by] : [ax, ay];
      edges.push({ ya: lo[1], yb: hi[1], xa: lo[0], slope: (hi[0] - lo[0]) / (hi[1] - lo[1]), dir: up ? 1 : -1 });
    }
  }
  if (!edges.length) return out;
  edges.sort((a, b) => a.ya - b.ya);

  const SUB = 4;
  const half = dx / 2;
  let next = 0;
  let active: typeof edges = [];
  const xs: { x: number; dir: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let s = 0; s < SUB; s++) {
      const y = y0 + (r - 0.5 + (s + 0.5) / SUB) * dy;
      while (next < edges.length && edges[next].ya <= y) active.push(edges[next++]);
      active = active.filter((e) => e.yb > y);
      xs.length = 0;
      for (const e of active) if (e.ya <= y) xs.push({ x: e.xa + (y - e.ya) * e.slope, dir: e.dir });
      if (xs.length < 2) continue;
      xs.sort((a, b) => a.x - b.x);
      let wind = 0;
      for (let q = 0; q < xs.length - 1; q++) {
        wind += xs[q].dir;
        if (wind === 0) continue;
        const a = xs[q].x, b = xs[q + 1].x;
        if (b <= a) continue;
        // Cells this span touches, each by how much of its width it covers.
        const c0 = Math.max(0, Math.floor((a - x0 + half) / dx));
        const c1 = Math.min(cols - 1, Math.floor((b - x0 + half) / dx));
        for (let c = c0; c <= c1; c++) {
          const lo = x0 + c * dx - half, hi = lo + dx;
          const cover = (Math.min(hi, b) - Math.max(lo, a)) / dx;
          if (cover > 0) out[r * cols + c] += cover / SUB;
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (out[i] > 1) out[i] = 1;
  return out;
}
