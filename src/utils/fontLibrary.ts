// ---------------------------------------------------------------------------
// Google Fonts, for lettering on a part.
//
// - The font files come from Google: the fonts.googleapis.com CSS API names a
//   static file per weight and per script subset on fonts.gstatic.com, so a
//   bold is a real bold and only the scripts the text uses are fetched. Not
//   the variable TTFs in the google/fonts repository, which Etch reads:
//   opentype.js misapplies a variable font's deltas to some glyphs --
//   Montserrat's bold "o" came out a wobbling hairline ring.
// - A browser is served those files as woff2, which opentype.js cannot read,
//   so they are decoded by woff2-encoder (WebAssembly, inlined; loaded with
//   the first lettering). Etch found the usual decoder, wawoff2, never
//   initialises in a browser; this one does. Anything that is not a browser
//   is served TTF and needs no decoding.
// - The catalogue (~1800 family names) is Fontsource's mirror of Google's,
//   because Google's own (fonts.google.com/metadata) is served without CORS.
//   Only names and weights come from it.
//
// Browser only: the pattern itself is built from saved outlines (textOutline.ts).
// ---------------------------------------------------------------------------

import type { FontLike, GlyphLike } from './textOutline';

export type FontCategory = 'sans-serif' | 'serif' | 'display' | 'handwriting' | 'monospace';

export interface FontOption {
  name: string;
  category: FontCategory;
  /** Weights the family ships. */
  weights?: number[];
}

/** Offline fallback, so the picker is never empty and the default always resolves. */
export const BUILT_IN_FONTS: FontOption[] = [
  { name: 'Roboto', category: 'sans-serif' },
  { name: 'Montserrat', category: 'sans-serif' },
  { name: 'Oswald', category: 'sans-serif' },
  { name: 'Playfair Display', category: 'serif' },
  { name: 'Cinzel', category: 'serif' },
  { name: 'Roboto Slab', category: 'serif' },
  { name: 'Bebas Neue', category: 'display' },
  { name: 'Black Ops One', category: 'display' },
  { name: 'Pacifico', category: 'handwriting' },
  { name: 'Lobster', category: 'handwriting' },
  { name: 'Great Vibes', category: 'handwriting' },
  { name: 'Roboto Mono', category: 'monospace' },
];

export const DEFAULT_FONT = 'Roboto';

const CATALOGUE_KEY = 'mesh_font_catalogue_v1';
const CATALOGUE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CATALOGUE_URL = 'https://api.fontsource.org/v1/fonts';
const GOOGLE_CSS = 'https://fonts.googleapis.com/css2';

const CATEGORIES: ReadonlySet<string> = new Set(['sans-serif', 'serif', 'display', 'handwriting', 'monospace']);
const category = (c: string): FontCategory => (CATEGORIES.has(c) ? (c as FontCategory) : 'sans-serif');

let catalogue: Promise<FontOption[]> | null = null;

/** The whole catalogue, cached for a week; the built-in list when offline. */
export function fetchFontCatalogue(): Promise<FontOption[]> {
  if (catalogue) return catalogue;
  catalogue = (async () => {
    try {
      const raw = localStorage.getItem(CATALOGUE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as { at: number; fonts: FontOption[] };
        if (Date.now() - cached.at < CATALOGUE_TTL_MS && cached.fonts?.length) return cached.fonts;
      }
    } catch {
      /* no storage, or a corrupt entry: fetch it */
    }
    try {
      const res = await fetch(CATALOGUE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { family: string; category: string; weights: number[] }[];
      const fonts = data
        .filter((f) => f.family)
        .map((f) => ({ name: f.family, category: category(f.category), weights: f.weights }))
        .sort((a, b) => a.name.localeCompare(b.name));
      if (!fonts.length) throw new Error('empty catalogue');
      try {
        localStorage.setItem(CATALOGUE_KEY, JSON.stringify({ at: Date.now(), fonts }));
      } catch {
        /* over quota: it still works for this session */
      }
      return fonts;
    } catch (e) {
      console.warn('[Mesh] Font catalogue unavailable, using the built-in list:', e);
      catalogue = null;
      return BUILT_IN_FONTS;
    }
  })();
  return catalogue;
}

const styled = new Set<string>();

/** The family's stylesheet, so the picker can draw its name in it. */
export function ensureFontPreview(family: string) {
  if (!family || styled.has(family) || typeof document === 'undefined') return;
  styled.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}&display=swap`;
  document.head.appendChild(link);
}

export class FontUnavailableError extends Error {}

/** One @font-face of Google's stylesheet: a file and the characters it holds. */
export interface FontFace {
  url: string;
  /** [from, to] code points; empty when the face holds the whole font. */
  ranges: [number, number][];
}

/** "U+0460-052F,U+20B4,U+4??" as [from, to] pairs. */
export function parseUnicodeRange(range: string): [number, number][] {
  const out: [number, number][] = [];
  for (const part of range.split(',')) {
    const m = part.trim().match(/^U\+([0-9A-F?]+)(?:-([0-9A-F]+))?$/i);
    if (!m) continue;
    if (m[2]) out.push([parseInt(m[1], 16), parseInt(m[2], 16)]);
    else out.push([parseInt(m[1].replace(/\?/g, '0'), 16), parseInt(m[1].replace(/\?/g, 'F'), 16)]);
  }
  return out;
}

/** The @font-face rules of a Google Fonts stylesheet. */
export function parseFontFaces(css: string): FontFace[] {
  const faces: FontFace[] = [];
  for (const block of css.split('@font-face').slice(1)) {
    const url = block.match(/url\(\s*['"]?([^'")]+)['"]?\s*\)/)?.[1];
    if (!url) continue;
    const range = block.match(/unicode-range:\s*([^;}]+)/)?.[1];
    faces.push({ url, ranges: range ? parseUnicodeRange(range) : [] });
  }
  return faces;
}

const covers = (face: FontFace, cp: number) => !face.ranges.length || face.ranges.some(([a, b]) => cp >= a && cp <= b);

/**
 * The faces the text needs: the one holding "H" first, whose metrics the
 * lettering is measured by, then whichever holds each character it does not.
 */
export function facesFor(faces: FontFace[], text: string): FontFace[] {
  if (!faces.length) return [];
  const chosen = [faces.find((f) => covers(f, 0x48)) ?? faces[0]];
  for (const ch of new Set(text)) {
    const cp = ch.codePointAt(0)!;
    if (/\s/.test(ch) || chosen.some((f) => covers(f, cp))) continue;
    const face = faces.find((f) => covers(f, cp));
    if (face) chosen.push(face);
  }
  return chosen;
}

const sheets = new Map<string, Promise<FontFace[] | null>>();

/** Google's stylesheet for one weight of a family; null when the family has no such weight. */
function stylesheet(family: string, weight: number): Promise<FontFace[] | null> {
  const key = `${family}::${weight}`;
  const hit = sheets.get(key);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`${GOOGLE_CSS}?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${weight}`);
    // 400 is Google's answer to a family or a weight it does not have.
    if (res.status === 400) return null;
    if (!res.ok) throw new FontUnavailableError(`Google Fonts did not answer (HTTP ${res.status}).`);
    const faces = parseFontFaces(await res.text());
    return faces.length ? faces : null;
  })();
  p.catch(() => sheets.delete(key));
  sheets.set(key, p);
  return p;
}

const files = new Map<string, Promise<FontLike>>();

/** One font file, woff2 decoded where it is one. */
function fetchFont(url: string): Promise<FontLike> {
  const hit = files.get(url);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new FontUnavailableError(`Could not download a font file (HTTP ${res.status}).`);
    let bytes: Uint8Array = new Uint8Array(await res.arrayBuffer());
    // "wOF2"
    if (bytes[0] === 0x77 && bytes[1] === 0x4f && bytes[2] === 0x46 && bytes[3] === 0x32) {
      const { default: decompress } = await import('woff2-encoder/decompress');
      bytes = await decompress(bytes);
    }
    const opentype = await import('opentype.js');
    return opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) as unknown as FontLike;
  })();
  p.catch(() => files.delete(url));
  files.set(url, p);
  return p;
}

type IndexedGlyph = GlyphLike & { index?: number };

/**
 * Several subset files as one font: a character comes from the first file
 * that has it. Metrics are the first file's; kerning only between two glyphs
 * of the same file.
 */
function chain(parts: FontLike[]): FontLike {
  if (parts.length === 1) return parts[0];
  const owner = new WeakMap<GlyphLike, FontLike>();
  const [first] = parts;
  return {
    unitsPerEm: first.unitsPerEm,
    ascender: first.ascender,
    descender: first.descender,
    tables: first.tables,
    charToGlyph(ch) {
      let fallback: IndexedGlyph | null = null;
      for (const font of parts) {
        const g = font.charToGlyph(ch) as IndexedGlyph;
        if (!fallback) fallback = g;
        if (g.index) {
          // Drawn at the scale of its own file.
          const scaled: GlyphLike = {
            advanceWidth: ((g.advanceWidth ?? 0) * first.unitsPerEm) / font.unitsPerEm,
            getPath: (x, y, size, options) => g.getPath(x, y, size, options, font),
          };
          owner.set(scaled, font);
          return scaled;
        }
      }
      return fallback!;
    },
    getKerningValue(a, b) {
      const fa = owner.get(a), fb = owner.get(b);
      return fa && fa === fb && fa.getKerningValue ? fa.getKerningValue(a, b) : 0;
    },
  };
}

/**
 * A Google font at a weight, with the scripts `text` needs. A weight the
 * family lacks becomes its nearest (from the catalogue), then its default.
 */
export async function loadFont(family: string, weight = 400, text = ''): Promise<FontLike> {
  let name = family.trim();
  let faces = await stylesheet(name, weight);
  if (!faces) {
    const entry = (await fetchFontCatalogue()).find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (entry) name = entry.name;
    const weights = entry?.weights?.length ? entry.weights : [400];
    const nearest = weights.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
    for (const w of new Set([nearest, 400])) {
      if (faces) break;
      if (w !== weight || name !== family.trim()) faces = await stylesheet(name, w);
    }
  }
  if (!faces) throw new FontUnavailableError(`"${name}" is not in the Google Fonts library.`);
  return chain(await Promise.all(facesFor(faces, text).map((f) => fetchFont(f.url))));
}
