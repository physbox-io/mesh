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
import { layoutPattern, patternSvg, type PatternLayout, type PatternPiece } from './patternSvg';

/** The pattern's defaults, shared by the editor and MCP. */
export const DEFAULT_PATTERN_OPTIONS = {
  /** Outward seam allowance, mm: 10 suits woven seams, 6 overlocked knits. */
  seamAllowanceMm: 10,
} as const;

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
      for (const f of live) pieces.push({ ...f.flat!, name: named(pieceOf(f.name)), garment: bodyName, ...(f.material ? { fabric: f.material } : {}) });
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
        pieces.push({ ...g.flat, name: named(sep > 0 ? g.name.slice(sep + 2) : g.name), garment: bodyName, ...(g.material ? { fabric: g.material } : {}) });
      }
    } catch (err) {
      warnings.push(`${bodyName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { pieces, warnings, built };
}

export interface ClothPatternUnfoldResult {
  ok: true;
  svg: string;
  layout: PatternLayout;
  seamAllowanceMm: number;
  pieceNames: string[];
  warnings: string[];
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
  options?: { seamAllowanceMm?: number; title?: string; stale?: Set<string> },
): ClothPatternUnfoldResult | ClothPatternUnfoldError {
  const seamAllowanceMm = Math.max(0, options?.seamAllowanceMm ?? DEFAULT_PATTERN_OPTIONS.seamAllowanceMm);
  const { pieces, warnings } = garmentPatternPieces(clothNodes, allSceneNodes, modelFlexes, { stale: options?.stale });
  if (pieces.length === 0) {
    return { ok: false, error: 'No flat 2D garment pattern pieces could be extracted from the selected cloth bodies.', warnings };
  }
  const title = options?.title ?? (clothNodes.length === 1 ? `${clothNodes[0].name || clothNodes[0].id} pattern` : 'garment pattern');
  const layout = layoutPattern(pieces, { seamAllowanceMm });
  if (layout.pieces.length === 0) {
    return { ok: false, error: 'Cloth pattern pieces had degenerate outlines (fewer than 3 points).', warnings };
  }
  const svg = patternSvg(pieces, title, { seamAllowanceMm });
  return { ok: true, svg, layout, seamAllowanceMm, pieceNames: layout.pieces.map((p) => p.name), warnings };
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
