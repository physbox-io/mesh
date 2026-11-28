/**
 * A garment's sewing pattern, as every export path makes it: the Pattern card,
 * the bottom bar's Unfold, and MCP's physics_export_cut. One set of pieces,
 * one set of defaults, so the three cannot drift apart.
 *
 * Pure and store-free: the callers pass in the compiled flexes and the graph
 * the model was built from.
 */

import type { SceneNode } from '../../types/scene';
import type { ModelMirror } from '../../types/sceneLayer';
import { clothModel } from './clothModel';
import { clothWorldMatrix } from './clothFrame';
import { layoutPattern, layoutRects, patternSvg, type PatternLayout, type PatternLayoutOptions, type PatternPiece } from './patternSvg';
import { tileGeometry, tilePages, tileSvgForHomePrint, type PaperFormat } from '../tiledPaperPrint';

/** The pattern's defaults, shared by the editor and MCP. */
export const DEFAULT_PATTERN_OPTIONS = {
  /** Outward seam allowance, mm: 10 suits woven seams, 6 overlocked knits. */
  seamAllowanceMm: 10,
  /** Allowance on the hem, cuffs and leg ends, turned up, mm. */
  hemAllowanceMm: 25,
  /** Mirror pairs drawn once (cut 2), symmetric pieces halved on the fold (cut 1 on fold). */
  fold: true,
  /** The fabric's width the pieces are laid out on to cut, mm (150 cm, the commonest dressmaking width). */
  fabricWidthMm: 1500,
} as const;

/** Fabric widths sold by the metre, mm: 110 (quilting cotton), 140 and 150 cm. */
export const FABRIC_WIDTHS_MM = [1100, 1400, 1500] as const;

/** What an export of a pattern can be asked for, editor and MCP alike. */
export interface GarmentPatternOptions {
  seamAllowanceMm?: number;
  hemAllowanceMm?: number;
  /** Allowance by line name, mm, over the two above. */
  edgeAllowanceMm?: Record<string, number>;
  fold?: boolean;
  /** The fabric's width the cut layout is laid on, mm. */
  fabricWidthMm?: number;
  /** A cut layout per fabric and colour, not per fabric alone. */
  groupByColour?: boolean;
}

/** The layout options a pattern sheet is drawn with: the defaults under what was asked. */
export function patternLayoutOptions(o: GarmentPatternOptions = {}): PatternLayoutOptions {
  return {
    seamAllowanceMm: Math.max(0, o.seamAllowanceMm ?? DEFAULT_PATTERN_OPTIONS.seamAllowanceMm),
    hemAllowanceMm: Math.max(0, o.hemAllowanceMm ?? DEFAULT_PATTERN_OPTIONS.hemAllowanceMm),
    ...(o.edgeAllowanceMm && Object.keys(o.edgeAllowanceMm).length ? { edgeAllowanceMm: o.edgeAllowanceMm } : {}),
    fold: o.fold ?? DEFAULT_PATTERN_OPTIONS.fold,
  };
}

/** Every line name the pieces' edges lie on, for allowances by edge. */
export function patternLines(pieces: PatternPiece[]): string[] {
  return [...new Set(pieces.flatMap((p) => (p.edges ?? []).map((e) => e.line).filter((l): l is string => !!l)))].sort();
}

/**
 * A title block's lines: the garments, the form each is fitted to and its
 * measurements, the fabrics, the allowances, how to read the marks.
 */
export function patternTitle(clothNodes: SceneNode[], allSceneNodes: SceneNode[], pieces: PatternPiece[], o: PatternLayoutOptions): string[] {
  const forms = new Map<string, SceneNode>();
  const walk = (list: SceneNode[]) => { for (const n of list) { if (n.bodyForm) forms.set(n.name || n.id, n); if (n.children?.length) walk(n.children); } };
  walk(allSceneNodes);
  const lines = [`${clothNodes.map((n) => n.name || n.id).join(' + ')}: sewing pattern`];
  for (const fit of new Set(clothNodes.map((n) => n.cloth?.garment?.fitTo).filter((f): f is string => !!f))) {
    const m = forms.get(fit)?.bodyForm;
    if (m) lines.push(`Size: fitted to ${fit}, height ${Math.round(m.height * 1000)}, chest ${Math.round(m.chest * 1000)}, waist ${Math.round(m.waist * 1000)}, hip ${Math.round(m.hip * 1000)} mm`);
  }
  const fabrics = [...new Set(pieces.map((p) => p.fabric).filter((f): f is string => !!f))];
  if (fabrics.length) lines.push(`Fabric: ${fabrics.join(', ')}`);
  const sa = o.seamAllowanceMm ?? 0, hem = o.hemAllowanceMm ?? sa;
  const byLine = Object.entries(o.edgeAllowanceMm ?? {}).map(([k, v]) => `${k} ${v}`).join(', ');
  lines.push(sa > 0 ? `${sa} mm seam allowance included, hem ${hem} mm${byLine ? `; ${byLine} mm` : ''}` : `Net sewing lines: add your own allowance${hem > 0 ? ` (hem ${hem} mm included)` : ''}`);
  lines.push('Grain arrows parallel to the selvedge. Match notches;');
  lines.push('dashed: stitching lines and darts (fold, stitch, never cut).');
  return lines;
}

/** Every `cloth` node in a scene subtree. */
export function collectClothNodes(nodes: SceneNode[]): SceneNode[] {
  const out: SceneNode[] = [];
  const walk = (list: SceneNode[]) => {
    for (const n of list) {
      if (n.cloth) out.push(n);
      if (n.children?.length) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

const hexOf = (rgba: number[]) => '#' + rgba.slice(0, 3).map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');

const pieceOf = (flexName: string) => flexName.slice(flexName.lastIndexOf('__') + 2);
const bodyOf = (flexName: string) => flexName.slice(0, flexName.lastIndexOf('__'));

/**
 * The pieces of `clothNodes`: from the compiled model where it describes them,
 * else built from the graph. With several garments, each piece is named for
 * its garment too.
 */
export function garmentPatternPieces(
  clothNodes: SceneNode[],
  allSceneNodes: SceneNode[],
  modelFlexes: ModelMirror['flexes'] | undefined,
  options?: {
    /** Bodies the compiled model does not describe as they now stand: built from the graph instead. */
    stale?: Set<string>;
    /** Build a piece the model lacks from the graph (slow: the whole garment is modelled). Default true. */
    build?: boolean;
  },
): { pieces: PatternPiece[]; warnings: string[]; built: string[] } {
  const pieces: PatternPiece[] = [];
  const warnings: string[] = [];
  const built: string[] = [];
  const multi = clothNodes.length > 1;
  for (const node of clothNodes) {
    const bodyName = node.name || node.id;
    const named = (piece: string) => (multi ? `${bodyName}_${piece}` : piece);
    const live = options?.stale?.has(node.id)
      ? []
      : (modelFlexes ?? []).filter((f) => f.flat && f.name.lastIndexOf('__') > 0 && bodyOf(f.name) === bodyName);
    if (live.length > 0) {
      for (const f of live) pieces.push({ ...f.flat!, name: named(pieceOf(f.name)), garment: bodyName, ...(f.material ? { fabric: f.material } : {}), ...(f.rgba ? { colour: hexOf(f.rgba) } : {}) });
      continue;
    }
    if (options?.build === false) continue;
    try {
      const m = clothModel(node, clothWorldMatrix(allSceneNodes, node), allSceneNodes);
      if (m.warnings?.length) warnings.push(...m.warnings.map((w) => `${bodyName}: ${w}`));
      built.push(bodyName);
      for (const g of m.groups) {
        if (!g.flat) continue;
        const sep = g.name.lastIndexOf('__');
        pieces.push({ ...g.flat, name: named(sep > 0 ? g.name.slice(sep + 2) : g.name), garment: bodyName, ...(g.material ? { fabric: g.material } : {}), ...(g.rgba ? { colour: hexOf(g.rgba) } : {}) });
      }
    } catch (err) {
      warnings.push(`${bodyName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { pieces, warnings, built };
}

/**
 * The sheet width that prints the pattern on the fewest pages of `paper`:
 * the pieces packed into 1, 2, 3 ... pages across, the pages they leave
 * blank not printed.
 */
export function printWidth(pieces: PatternPiece[], options: PatternLayoutOptions, paper: PaperFormat): { widthMm: number; pages: number } {
  const g = tileGeometry(paper);
  let best: { widthMm: number; pages: number } | null = null;
  for (let k = 1; k <= 8; k++) {
    const widthMm = g.printableW + (k - 1) * g.stepX;
    const L = layoutPattern(pieces, { ...options, widthMm });
    if (L.width > widthMm + 0.5 && k < 8) continue;
    const pages = tilePages(L.width, L.height, paper, layoutRects(L)).count;
    if (!best || pages < best.pages) best = { widthMm, pages };
  }
  return best!;
}

export interface PatternPrint {
  paper: PaperFormat;
  /** Pages printed (blank ones left out). */
  pages: number;
  /** The print-ready packet: every page, tiled 1:1, with join marks and a test square. */
  html: string;
  /** Each printed page alone, as an SVG. */
  pageSvgs: string[];
}

/** The pattern laid out for `paper` and tiled onto its pages. */
export function printPattern(pieces: PatternPiece[], title: string, options: PatternLayoutOptions, paper: PaperFormat): PatternPrint & { svg: string; layout: PatternLayout } {
  const { widthMm } = printWidth(pieces, options, paper);
  const layout = layoutPattern(pieces, { ...options, widthMm });
  const svg = patternSvg(pieces, title, { ...options, widthMm });
  const doc = tileSvgForHomePrint(svg, { paper, title: `${title} sewing pattern`, occupied: layoutRects(layout) });
  return { paper, pages: doc.pages.length, html: doc.html, pageSvgs: doc.pages.map((p) => p.svg), svg, layout };
}

export interface ClothPatternUnfoldResult {
  ok: true;
  svg: string;
  layout: PatternLayout;
  seamAllowanceMm: number;
  pieceNames: string[];
  warnings: string[];
  /** The tiled home print, when a paper was asked for. */
  print?: PatternPrint;
  /** The fabrics the pieces are cut from. */
  fabrics: string[];
  /** The pieces, as cut. */
  pieces: PatternPiece[];
  /** The layout options used. */
  options: PatternLayoutOptions;
  /** The cut layout: each fabric's pieces on its width, and how much of each to buy. */
  cut: { layouts: FabricLayout[]; svg: string; sheets: { widthMm: number; heightMm: number }[]; fabricWidthMm: number };
}

export interface ClothPatternUnfoldError {
  ok: false;
  error: string;
  warnings: string[];
}

/** The sewing pattern of one or more `cloth` bodies, as an SVG in millimetres. */
export function exportClothPatternUnfold(
  clothNodes: SceneNode[],
  allSceneNodes: SceneNode[],
  modelFlexes: ModelMirror['flexes'] | undefined,
  options?: GarmentPatternOptions & { title?: string; stale?: Set<string>; paper?: PaperFormat },
): ClothPatternUnfoldResult | ClothPatternUnfoldError {
  const base = patternLayoutOptions(options);
  const seamAllowanceMm = base.seamAllowanceMm!;
  const { pieces, warnings } = garmentPatternPieces(clothNodes, allSceneNodes, modelFlexes, { stale: options?.stale });
  if (pieces.length === 0) {
    return { ok: false, error: 'No flat 2D garment pattern pieces could be extracted from the selected cloth bodies.', warnings };
  }
  const title = options?.title ?? (clothNodes.length === 1 ? `${clothNodes[0].name || clothNodes[0].id} pattern` : 'garment pattern');
  const fabrics = [...new Set(pieces.map((p) => p.fabric).filter((f): f is string => !!f))];
  const opts: PatternLayoutOptions = { ...base, titleBlock: patternTitle(clothNodes, allSceneNodes, pieces, base) };
  const fabricWidthMm = options?.fabricWidthMm ?? DEFAULT_PATTERN_OPTIONS.fabricWidthMm;
  const layouts = fabricLayouts(pieces, base, fabricWidthMm, !!options?.groupByColour);
  const cl = cutLayoutSvg(pieces, layouts, title, base);
  const cut = { layouts, svg: cl.svg, sheets: cl.sheets.map(({ widthMm, heightMm }) => ({ widthMm, heightMm })), fabricWidthMm };
  for (const l of layouts) if (l.tooWide.length) warnings.push(`${l.tooWide.join(', ')} ${l.tooWide.length === 1 ? 'is' : 'are'} wider than ${Math.round(fabricWidthMm / 10)} cm ${l.fabric}: choose a wider fabric or add a seam.`);
  if (options?.paper) {
    const pr = printPattern(pieces, title, opts, options.paper);
    if (pr.layout.pieces.length === 0) return { ok: false, error: 'Cloth pattern pieces had degenerate outlines (fewer than 3 points).', warnings };
    const { svg, layout, ...print } = pr;
    return { ok: true, svg, layout, seamAllowanceMm, pieceNames: pieces.map((p) => p.name), warnings, print, fabrics, pieces, options: opts, cut };
  }
  const layout = layoutPattern(pieces, opts);
  if (layout.pieces.length === 0) {
    return { ok: false, error: 'Cloth pattern pieces had degenerate outlines (fewer than 3 points).', warnings };
  }
  const svg = patternSvg(pieces, title, opts);
  return { ok: true, svg, layout, seamAllowanceMm, pieceNames: pieces.map((p) => p.name), warnings, fabrics, pieces, options: opts, cut };
}

/**
 * The garments among `clothNodes` whose compiled pattern is out of date: the
 * garment itself changed since the build (`staleIds`, from sceneSummary's
 * staleBodies), or the form it is fitted to did.
 */
export function stalePatternIds(clothNodes: SceneNode[], allSceneNodes: SceneNode[], staleIds: Set<string>): Set<string> {
  const out = new Set<string>();
  if (!staleIds.size) return out;
  const staleNames = new Set<string>();
  const walk = (list: SceneNode[]) => { for (const n of list) { if (staleIds.has(n.id)) staleNames.add(n.name || n.id); if (n.children?.length) walk(n.children); } };
  walk(allSceneNodes);
  for (const n of clothNodes) {
    const fit = n.cloth?.garment?.fitTo;
    if (staleIds.has(n.id) || (fit && staleNames.has(fit))) out.add(n.id);
  }
  return out;
}

/** One fabric's cut layout: its pieces laid on its width along the grain, single layer, and how much to buy. */
export interface FabricLayout {
  fabric: string;
  /** With pieces grouped by colour too: the colour, #rrggbb. */
  colour?: string;
  widthMm: number;
  /** The length the pieces take along the selvedge, mm. */
  lengthMm: number;
  /** What to buy: the length rounded up to the next 10 cm, and in yards to the next eighth. */
  metres: number;
  yards: number;
  pieces: string[];
  /** Pieces wider than the fabric (laid across it, they would be off grain). */
  tooWide: string[];
  layout: PatternLayout;
}

/**
 * Each fabric's pieces laid on its width, grain along the selvedge, every
 * piece whole and once (single layer, as a laser or a rotary cutter cuts):
 * the cut layout, and the length to buy.
 */
export function fabricLayouts(pieces: PatternPiece[], options: PatternLayoutOptions, fabricWidthMm: number, byColour = false): FabricLayout[] {
  const groups = new Map<string, PatternPiece[]>();
  for (const p of pieces) {
    const k = `${p.fabric ?? 'fabric'}${byColour ? `|${p.colour ?? ''}` : ''}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
  }
  return [...groups.entries()].map(([k, list]) => {
    const [fabric, colour] = k.split('|');
    const layout = layoutPattern(list, { ...options, fold: false, titleBlock: undefined, widthMm: fabricWidthMm, marginMm: 10 });
    const lengthMm = Math.ceil(layout.height);
    return {
      fabric, ...(byColour && colour ? { colour } : {}), widthMm: fabricWidthMm, lengthMm,
      metres: Math.ceil(lengthMm / 100) / 10,
      yards: Math.ceil((lengthMm / 914.4) * 8) / 8,
      pieces: list.map((p) => p.name),
      tooWide: layout.pieces.filter((p) => p.w > fabricWidthMm - 20).map((p) => p.name),
      layout,
    };
  });
}

/** The cut layouts as one SVG, 1 unit = 1 mm: each fabric its own width, stacked, selvedges drawn, how much to buy above it. */
export function cutLayoutSvg(pieces: PatternPiece[], layouts: FabricLayout[], title: string, options: PatternLayoutOptions): { svg: string; sheets: { widthMm: number; heightMm: number; y: number }[] } {
  const HEAD = 14, GAP_Y = 30;
  let y = 0;
  const parts: string[] = [], sheets: { widthMm: number; heightMm: number; y: number }[] = [];
  const width = Math.max(100, ...layouts.map((l) => l.layout.width));
  for (const l of layouts) {
    const group = pieces.filter((p) => l.pieces.includes(p.name));
    const one = patternSvg(group, title, { ...options, fold: false, titleBlock: undefined, widthMm: l.widthMm, marginMm: 10 });
    const inner = one.slice(one.indexOf('>', one.indexOf('<svg')) + 1, one.lastIndexOf('</svg>')).replace(/<title>[^<]*<\/title>\n?/, '');
    const head = `${l.fabric}${l.colour ? ` ${l.colour}` : ''}: ${Math.round(l.widthMm / 10)} cm wide, buy ${l.metres.toFixed(1)} m (${l.yards} yd); single layer, grain along the selvedge`;
    parts.push(`<text x="0" y="${(y + 9).toFixed(1)}" font-size="7" font-family="sans-serif">${head.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
    const top = y + HEAD;
    parts.push(`<g transform="translate(0 ${top.toFixed(1)})">`, inner, `</g>`);
    // The selvedges: the fabric's edges, along its length (a guide, not a cut).
    parts.push(`<rect x="0" y="${top.toFixed(1)}" width="${l.widthMm}" height="${l.lengthMm}" fill="none" stroke="#94a3b8" stroke-width="0.5" stroke-dasharray="6 3"><title>fabric: ${Math.round(l.widthMm / 10)} cm wide, selvedge to selvedge</title></rect>`);
    sheets.push({ widthMm: l.widthMm, heightMm: l.lengthMm, y: top });
    y = top + l.lengthMm + GAP_Y;
  }
  const height = Math.max(100, y - GAP_Y);
  return {
    svg: [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width.toFixed(0)}mm" height="${height.toFixed(0)}mm" viewBox="0 0 ${width.toFixed(1)} ${height.toFixed(1)}">`,
      `<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;')} cut layout</title>`,
      ...parts,
      `</svg>`,
    ].join('\n'),
    sheets,
  };
}
