/**
 * Summaries and 2D pattern-unfold export helpers for `cloth` and `bodyForm`
 * bodies. Pure and store-free so both MCP handlers and tests can call them
 * directly without pulling Zustand into workers.
 */

import type { BodyFormMeasurements } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import type { ModelMirror } from '../../types/sceneLayer';
import { bodyLandmarks } from './bodyForm';
import { legPose, proportions } from './formProportions';
import { clothModel } from './clothModel';
import { clothWorldMatrix } from './clothFrame';

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
      vertCount,
      triCount,
      ...(bboxMm ? { bboxMm } : {}),
    };
  }

  // Fallback when physics model flexes aren't populated yet (e.g. headless/unit calls):
  // build the cloth model directly from the scene graph.
  try {
    const built = clothModel(node, clothWorldMatrix(opts?.scene ?? [node], node), opts?.scene ?? [node]);
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

// The sewing-pattern export lives in patternExport; re-exported for older callers.
export { collectClothNodes, exportClothPatternUnfold, type ClothPatternUnfoldError, type ClothPatternUnfoldResult } from './patternExport';
