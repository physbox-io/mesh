/**
 * Summaries and 2D pattern-unfold export helpers for `cloth` and `bodyForm`
 * bodies. Pure and store-free so both MCP handlers and tests can call them
 * directly without pulling Zustand into workers.
 */

import * as THREE from 'three';
import type { BodyFormMeasurements, GarmentDraft } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import type { ModelMirror } from '../../types/sceneLayer';
import { bodyLandmarks } from './bodyForm';
import { legPose, proportions } from './formProportions';
import { clothModel } from './clothModel';
import { pieceDetails, resolvedGarmentDraft, type PieceDetail } from './garmentReadBack';
import { layoutPattern, patternSvg, type PatternLayout, type PatternPiece } from './patternSvg';

const r1 = (v: number) => +v.toFixed(1);
const r4 = (v: number) => +v.toFixed(4);

export interface BodyFormLandmarksReport {
  /** Anatomical landmark Z-heights in millimetres (Z-up from the floor). */
  landmarksMm: {
    crownZ: number;
    hpsZ: number;
    shoulderZ: number;
    bustZ: number;
    waistZ: number;
    hipZ: number;
    crotchZ: number;
    kneeZ: number;
    ankleZ: number;
    drop?: number;
  };
  /** Anatomical landmark Z-heights in metres (matching garment `cuts`/`seams` coordinates). */
  landmarks: {
    crownZ: number;
    hpsZ: number;
    shoulderZ: number;
    bustZ: number;
    waistZ: number;
    hipZ: number;
    crotchZ: number;
    kneeZ: number;
    ankleZ: number;
    drop?: number;
  };
}

/** Computes anatomical landmark Z-heights for a `bodyForm` node from its measurements. */
export function bodyFormLandmarksSummary(m: BodyFormMeasurements): BodyFormLandmarksReport {
  const L = bodyLandmarks(m);
  const P = proportions(m);
  const leg = legPose(m);
  const kneeZ = leg.knee ? leg.knee[2] : leg.kneeZ;
  const ankleZ = leg.footZ;
  const crownZ = P.crown;
  const raw = {
    crownZ,
    hpsZ: L.hpsZ,
    shoulderZ: L.shoulderZ,
    bustZ: L.bustZ,
    waistZ: L.waistZ,
    hipZ: L.hipZ,
    crotchZ: L.crotchZ,
    kneeZ,
    ankleZ,
  };
  return {
    landmarksMm: {
      crownZ: r1(raw.crownZ * 1000),
      hpsZ: r1(raw.hpsZ * 1000),
      shoulderZ: r1(raw.shoulderZ * 1000),
      bustZ: r1(raw.bustZ * 1000),
      waistZ: r1(raw.waistZ * 1000),
      hipZ: r1(raw.hipZ * 1000),
      crotchZ: r1(raw.crotchZ * 1000),
      kneeZ: r1(raw.kneeZ * 1000),
      ankleZ: r1(raw.ankleZ * 1000),
      ...(L.drop > 1e-5 ? { drop: r1(L.drop * 1000) } : {}),
    },
    landmarks: {
      crownZ: r4(raw.crownZ),
      hpsZ: r4(raw.hpsZ),
      shoulderZ: r4(raw.shoulderZ),
      bustZ: r4(raw.bustZ),
      waistZ: r4(raw.waistZ),
      hipZ: r4(raw.hipZ),
      crotchZ: r4(raw.crotchZ),
      kneeZ: r4(raw.kneeZ),
      ankleZ: r4(raw.ankleZ),
      ...(L.drop > 1e-5 ? { drop: r4(L.drop) } : {}),
    },
  };
}

export interface ClothSummaryReport {
  pieceCount: number;
  pieces: string[];
  /** Each piece as cut: fabric, colour, flat size, strain to lie flat. */
  pieceDetails?: PieceDetail[];
  /** A garment's draft as the builder reads it, every setting its kind fills in. */
  draftResolved?: GarmentDraft;
  vertCount: number;
  triCount: number;
  bboxMm?: {
    min: [number, number, number];
    max: [number, number, number];
    size: [number, number, number];
  };
}

function bboxFromCoords(pts: Iterable<[number, number, number]>): ClothSummaryReport['bboxMm'] | undefined {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  let any = false;
  for (const [x, y, z] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    any = true;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  if (!any) return undefined;
  return {
    min: [r1(minX * 1000), r1(minY * 1000), r1(minZ * 1000)],
    max: [r1(maxX * 1000), r1(maxY * 1000), r1(maxZ * 1000)],
    size: [r1((maxX - minX) * 1000), r1((maxY - minY) * 1000), r1((maxZ - minZ) * 1000)],
  };
}

function nodeWorldMatrix(node: SceneNode): THREE.Matrix4 {
  const pos = new THREE.Vector3(...(node.pos ?? [0, 0, 0]));
  const [w, x, y, z] = node.quat ?? [1, 0, 0, 0];
  return new THREE.Matrix4().compose(pos, new THREE.Quaternion(x, y, z, w), new THREE.Vector3(1, 1, 1));
}

/** Computes a concise cloth/garment summary for `physics_get_object`. */
export function clothNodeSummary(
  node: SceneNode,
  opts?: {
    model?: ModelMirror | null;
    data?: { flexvert_xpos?: ArrayLike<number> } | null;
    scene?: SceneNode[];
  },
): ClothSummaryReport | null {
  if (!node.cloth) return null;
  const bodyName = node.name || node.id;
  const flexes = (opts?.model?.flexes ?? []).filter((f) => {
    const sep = f.name.lastIndexOf('__');
    return sep > 0 && f.name.slice(0, sep) === bodyName;
  });

  if (flexes.length > 0) {
    const pieces = flexes.map((f) => f.name.slice(f.name.lastIndexOf('__') + 2));
    const vertCount = flexes.reduce((sum, f) => sum + f.vertnum, 0);
    const triCount = flexes.reduce((sum, f) => sum + Math.floor(f.elems.length / 3), 0);
    let bboxMm: ClothSummaryReport['bboxMm'];
    const xpos = opts?.data?.flexvert_xpos;
    if (xpos && xpos.length >= 3) {
      const coords: [number, number, number][] = [];
      for (const f of flexes) {
        for (let i = 0; i < f.vertnum; i++) {
          const base = (f.vertadr + i) * 3;
          if (base + 2 < xpos.length) coords.push([xpos[base], xpos[base + 1], xpos[base + 2]]);
        }
      }
      bboxMm = bboxFromCoords(coords);
    }
    return {
      pieceCount: pieces.length,
      pieces,
      pieceDetails: pieceDetails(flexes),
      ...(node.cloth.garment ? { draftResolved: resolvedGarmentDraft(node.cloth.garment) } : {}),
      vertCount,
      triCount,
      ...(bboxMm ? { bboxMm } : {}),
    };
  }

  // Fallback when physics model flexes aren't populated yet (e.g. headless/unit calls):
  // build the cloth model directly from the scene graph.
  try {
    const built = clothModel(node, nodeWorldMatrix(node), opts?.scene ?? [node]);
    const pieces = built.groups.map((g) => {
      const sep = g.name.lastIndexOf('__');
      return sep > 0 ? g.name.slice(sep + 2) : g.name;
    });
    const vertCount = Math.floor(built.x0.length / 3);
    const triCount = Math.floor(built.tris.length / 3);
    const coords: [number, number, number][] = [];
    for (let i = 0; i + 2 < built.x0.length; i += 3) {
      coords.push([built.x0[i], built.x0[i + 1], built.x0[i + 2]]);
    }
    const bboxMm = bboxFromCoords(coords);
    return {
      pieceCount: pieces.length,
      pieces,
      pieceDetails: pieceDetails(built.groups),
      ...(node.cloth.garment ? { draftResolved: resolvedGarmentDraft(node.cloth.garment) } : {}),
      vertCount,
      triCount,
      ...(bboxMm ? { bboxMm } : {}),
    };
  } catch {
    const fallbackPieces = (node.cloth.pieces ?? []).map((p) => p.name);
    return {
      pieceCount: fallbackPieces.length,
      pieces: fallbackPieces,
      vertCount: 0,
      triCount: 0,
    };
  }
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

/** Collects every `cloth` node in a scene subtree. */
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

/**
 * Exports 2D sewing pattern pieces for one or more `cloth` bodies as an SVG
 * document, reusing live `model.flexes` flat patterns when available and
 * falling back to `buildClothModel()` otherwise.
 */
export function exportClothPatternUnfold(
  clothNodes: SceneNode[],
  allSceneNodes: SceneNode[],
  modelFlexes: ModelMirror['flexes'] | undefined,
  options?: { seamAllowanceMm?: number; title?: string },
): ClothPatternUnfoldResult | ClothPatternUnfoldError {
  const seamAllowanceMm = Math.max(0, options?.seamAllowanceMm ?? 10);
  const pieces: PatternPiece[] = [];
  const warnings: string[] = [];
  const multi = clothNodes.length > 1;

  for (const node of clothNodes) {
    const bodyName = node.name || node.id;
    const fromFlexes: PatternPiece[] = (modelFlexes ?? [])
      .filter((f) => f.flat && f.name.lastIndexOf('__') > 0 && f.name.slice(0, f.name.lastIndexOf('__')) === bodyName)
      .map((f) => {
        const pieceName = f.name.slice(f.name.lastIndexOf('__') + 2);
        return {
          name: multi ? `${bodyName}_${pieceName}` : pieceName,
          ...f.flat!,
        };
      });

    if (fromFlexes.length > 0) {
      pieces.push(...fromFlexes);
      continue;
    }

    try {
      const built = clothModel(node, nodeWorldMatrix(node), allSceneNodes);
      if (built.warnings?.length) {
        warnings.push(...built.warnings.map((w) => `${bodyName}: ${w}`));
      }
      for (const g of built.groups) {
        if (!g.flat) continue;
        const sep = g.name.lastIndexOf('__');
        const pieceName = sep > 0 ? g.name.slice(sep + 2) : g.name;
        pieces.push({
          name: multi ? `${bodyName}_${pieceName}` : pieceName,
          ...g.flat,
        });
      }
    } catch (err) {
      warnings.push(`${bodyName}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (pieces.length === 0) {
    return {
      ok: false,
      error: 'No flat 2D garment pattern pieces could be extracted from the selected cloth bodies.',
      warnings,
    };
  }

  const title = options?.title ?? (clothNodes.length === 1 ? `${clothNodes[0].name || clothNodes[0].id} pattern` : 'garment pattern');
  const layout = layoutPattern(pieces, { seamAllowanceMm });
  if (layout.pieces.length === 0) {
    return {
      ok: false,
      error: 'Cloth pattern pieces had degenerate outlines (fewer than 3 points).',
      warnings,
    };
  }
  const svg = patternSvg(pieces, title, { seamAllowanceMm });
  return {
    ok: true,
    svg,
    layout,
    seamAllowanceMm,
    pieceNames: layout.pieces.map((p) => p.name),
    warnings,
  };
}
