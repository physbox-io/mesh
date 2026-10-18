// ---------------------------------------------------------------------------
// Google Fonts, for lettering on a part. The same sources Etch uses:
//
// - the catalogue (~1800 families) from Fontsource's API, which mirrors
//   Google's and, unlike fonts.google.com/metadata, is served with CORS;
// - the font files as plain TTF from Fontsource's jsDelivr mirror: one file
//   per weight and per script subset, so only the scripts the text uses are
//   fetched, and a bold is a real static bold. Not Google's variable files:
//   opentype.js applies a variable font's deltas wrongly to some glyphs --
//   Montserrat's bold "o" came out a wobbling hairline ring. Those are only
//   the fallback, from the google/fonts repository. Never the woff2 on
//   fonts.gstatic.com: decoding that needs a Brotli decoder whose usual
//   browser build never initialises (see Etch's textVectorizer.ts);
// - a fonts.googleapis.com stylesheet, only so the picker can show each
//   family in its own face.
//
// opentype.js is imported lazily, so its weight loads with the first lettering.
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
const GH_FONTS = 'https://cdn.jsdelivr.net/gh/google/fonts@main';
const FONTSOURCE_API = 'https://api.fontsource.org/v1/fonts';
const FONTSOURCE_FILES = 'https://cdn.jsdelivr.net/fontsource/fonts';
/** google/fonts files each family under its licence. */
const LICENCE_DIRS = ['ofl', 'apache', 'ufl'];

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

interface FontFile { url: string; weight: number; style: string; variable: boolean }

const families = new Map<string, Promise<FontFile[]>>();

/**
 * A family's files, from its METADATA.pb: the names cannot be guessed (static
 * `Family-Bold.ttf`, variable `Family[wght].ttf`, `Family[wdth,wght].ttf` ...).
 */
function familyFiles(family: string): Promise<FontFile[]> {
  const slug = family.toLowerCase().replace(/[^a-z0-9]/g, '');
  const hit = families.get(slug);
  if (hit) return hit;
  const p = (async () => {
    for (const licence of LICENCE_DIRS) {
      const base = `${GH_FONTS}/${licence}/${slug}`;
      let res: Response;
      try {
        res = await fetch(`${base}/METADATA.pb`);
      } catch {
        continue;
      }
      if (!res.ok) continue;
      const text = await res.text();
      const files: FontFile[] = [];
      for (const block of text.split(/fonts\s*\{/).slice(1)) {
        const filename = block.match(/filename:\s*"([^"]+)"/)?.[1];
        if (!filename || !/\.(ttf|otf)$/i.test(filename)) continue;
        files.push({
          url: `${base}/${encodeURIComponent(filename)}`,
          weight: parseInt(block.match(/weight:\s*(\d+)/)?.[1] ?? '400', 10),
          style: block.match(/style:\s*"([^"]+)"/)?.[1] ?? 'normal',
          variable: filename.includes('['),
        });
      }
      if (files.length) return files;
    }
    throw new FontUnavailableError(`"${family}" is not in the Google Fonts library.`);
  })();
  p.catch(() => families.delete(slug));
  families.set(slug, p);
  return p;
}

/** The upright file nearest the weight; a variable one covers them all. */
function pick(files: FontFile[], weight: number): FontFile {
  const upright = files.filter((f) => f.style === 'normal');
  const pool = upright.length ? upright : files;
  return pool.find((f) => f.variable)
    ?? pool.reduce((a, b) => (Math.abs(b.weight - weight) < Math.abs(a.weight - weight) ? b : a));
}

interface FontsourceMeta {
  id: string;
  weights: number[];
  subsets: string[];
  defSubset: string;
  unicodeRange?: Record<string, string>;
}

const metas = new Map<string, Promise<FontsourceMeta>>();

function fontsourceMeta(family: string): Promise<FontsourceMeta> {
  const id = family.trim().toLowerCase().replace(/\s+/g, '-');
  const hit = metas.get(id);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(`${FONTSOURCE_API}/${encodeURIComponent(id)}`);
    if (!res.ok) throw new FontUnavailableError(`"${family}" is not in the Google Fonts library.`);
    const meta = (await res.json()) as FontsourceMeta;
    if (!meta.weights?.length || !meta.subsets?.length) throw new FontUnavailableError(`"${family}" lists no font files.`);
    return meta;
  })();
  p.catch(() => metas.delete(id));
  metas.set(id, p);
  return p;
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

/** The subsets the text needs: the family's default, then any covering a character it does not. */
export function subsetsFor(meta: FontsourceMeta, text: string): string[] {
  const chosen = [meta.defSubset && meta.subsets.includes(meta.defSubset) ? meta.defSubset : meta.subsets[0]];
  const ranges = new Map(Object.entries(meta.unicodeRange ?? {}).map(([k, v]) => [k, parseUnicodeRange(v)]));
  const covers = (subset: string, cp: number) => (ranges.get(subset) ?? []).some(([a, b]) => cp >= a && cp <= b);
  for (const ch of new Set(text)) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80 || /\s/.test(ch) || chosen.some((sub) => covers(sub, cp))) continue;
    const extra = meta.subsets.find((sub) => covers(sub, cp));
    if (extra) chosen.push(extra);
  }
  return chosen;
}

const files = new Map<string, Promise<FontLike>>();

function fetchFont(url: string): Promise<FontLike> {
  const hit = files.get(url);
  if (hit) return hit;
  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new FontUnavailableError(`Could not download a font file (HTTP ${res.status}).`);
    const opentype = await import('opentype.js');
    return opentype.parse(await res.arrayBuffer()) as unknown as FontLike;
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
 * A Google font at a weight, parsed, with the scripts `text` needs. Static
 * files from Fontsource; the google/fonts files when Fontsource has none.
 */
export async function loadFont(family: string, weight = 400, text = ''): Promise<FontLike> {
  let meta: FontsourceMeta | null = null;
  try {
    meta = await fontsourceMeta(family);
  } catch {
    /* fall back to google/fonts below */
  }
  if (meta) {
    const w = meta.weights.reduce((a, b) => (Math.abs(b - weight) < Math.abs(a - weight) ? b : a));
    const urls = subsetsFor(meta, text).map((sub) => `${FONTSOURCE_FILES}/${meta!.id}@latest/${sub}-${w}-normal.ttf`);
    try {
      return chain(await Promise.all(urls.map(fetchFont)));
    } catch {
      /* fall back to google/fonts below */
    }
  }
  return fetchFont(pick(await familyFiles(family), weight).url);
}
