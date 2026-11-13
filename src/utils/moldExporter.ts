// ---------------------------------------------------------------------------
// 3D Printable Mold Export Engine (Two-Part Clamshell & Open Mold)
// ---------------------------------------------------------------------------
//
// Generates 3D printable casting molds (for silicone, epoxy resin, polyurethane,
// pewter, soap, candy, wax, etc.) from any 3D scene graph or relief heightmap.
//
// Features:
// - Two-Part Clamshell split mold (Top Core/Cavity + Bottom Cavity) or One-Part Open Mold
// - Automatic interlocking tapered registration pins on Top half
// - Matching clearance sockets on Bottom half with configurable 3D print tolerance
// - Asymmetric corner keying to prevent 180° reversed assembly
// - Tapered pour sprue funnel entering into the cavity for casting injection
// - Air riser vent channels at high points to exhaust bubbles
// - 45° chamfered corner pry notches on the parting line for easy demolding
// - Fast IEEE-754 Little-Endian Binary STL generator ready for 3D slicing
// ---------------------------------------------------------------------------

import type { SceneGraph } from '../types/scene';
import { collectSceneTriangles } from './contourSliceExporter';
import type { ManifoldToplevel, Manifold } from 'manifold-3d';
import { boundsOf, buildPartManifold, computeNormal, exportBinarySTL, manifoldToTriangles, sameFloat32, unsolidPartRefusal, type Mat4Tuple, type Triangle3D } from './moldManifold';
import { sampleColumns, choosePartingZ, type Grid, type ColumnField } from './moldColumns';
import { applyDraft, draftBreaksSide, shallowestDraft, type DraftMode } from './moldDraft';
import { choosePullDirection, rotateTrianglesForPull, SHALLOWER_PULL, type PullChoice, type PullDirection } from './moldPullDirection';
import { linerPartingChoice, linerPullChoice } from './moldRoofScore';
import { buildLinerMold, draftPart, DEFAULT_LINER_SKIN_MM, INSERT_CLEARANCE_MM, SEAL_RING_ROOM_MM, NO_MANIFOLD_REFUSAL, type LinerConstruction, type MoldLinerInfo } from './moldLiner';
import { castMaterial, defaultSprueFeed, type CastMaterialId } from './castMaterials';
import { linerPair, type LinerPairId } from './linerMaterials';
import { funnelClearDepths, gateDiaMm, planSprue, sprueNeckDiaMm, ventBoreDiaMm, withPourMouth, VENT_TAPER_MM } from './moldSprue';
import { bottomFillFloorMm, feedEdgeMm, cutHalfFeatures, cutHalfTriangles, everyOtherColumn, exactPourSpans, mouthSinkMm, planBottomFill, planPeakVents, rigidPourSpans, FEED_WALL_MM, type BoreCut, type BottomFill } from './moldGating';
import { fittedBlock, moldOutlines, notchesOnOutline, pinsOnRing, trimTriangles, type MoldOutlines } from './moldOutline';

export { computeNormal, exportBinarySTL } from './moldManifold';
export type { Triangle3D } from './moldManifold';

let lastPlannedOptions: MoldOptions | null = null;

/** Saves the mold options the export dialog last planned with. */
export function rememberMoldOptions(options: MoldOptions): void {
  lastPlannedOptions = { ...options };
}

/** Returns the mold options the export dialog last planned with, or null when it has not this session. */
export function lastMoldOptions(): MoldOptions | null {
  return lastPlannedOptions ? { ...lastPlannedOptions } : null;
}

export interface MoldOptions {
  /**
   * 'clamshell': two-part interlocking split mold; 'open': one-part open pour
   * mold; 'auto': the open mold when it keeps the part about as well as a
   * clamshell would, since it is one print and nothing to line up.
   */
  moldType: 'clamshell' | 'open' | 'auto';
  /**
   * Which of the part's directions the mold opens along. 'auto' (the default)
   * tries every axis and takes the one that fills in the least of the part; an
   * upright bust opens front to back, not top to bottom.
   */
  pullDirection?: 'auto' | PullDirection;
  /** Wall thickness around the part in mm. */
  wallMarginMm: number;
  /**
   * The block's plan: 'box' (default) the part's bounding box plus the wall,
   * 'fit' the part's own outline plus the wall, pins and notches moved onto
   * it (moldOutline.ts): round a round part, about half the print.
   */
  blockShape?: 'box' | 'fit';
  /** Floor/roof slab thickness behind the cavity in mm. */
  baseThicknessMm: number;
  /** Custom override for total cavity depth in mm (0 uses actual scene height). */
  cavityDepthMm: number;
  /**
   * Taper put on the cavity walls, in degrees off the pull direction. Zero
   * reproduces the part exactly and leaves vertical walls gripping the casting;
   * a couple of degrees costs depth x tan(angle) of lateral detail and is what
   * lets a rigid mold let go.
   */
  draftAngleDeg: number;
  /**
   * Which way the walls lean (utils/moldDraft.ts): 'remove' (default) keeps the
   * opening's size and takes the taper off the casting, 'add' keeps the bottom's
   * and puts it on, 'centre' pivots each wall about its mid-height.
   */
  draftMode?: DraftMode;
  /**
   * Keep 3D overhangs and undercuts inside the mold cavity (for flexible
   * silicone/TPU molds or sacrificial shells) instead of filling them in solid
   * so a rigid mold can release the part.
   */
  allowUndercuts?: boolean;
  /**
   * Print the mold as a rigid shell with a dissolvable liner (moldLiner.ts;
   * PLA + PVA unless `linerPair` says otherwise):
   * every undercut kept, and the shell still lifts off once the PVA has gone.
   * Exported as a two-material 3MF.
   */
  dissolvableLiner?: boolean;
  /** PVA skin between the PLA shell and the casting, mm (default 1.2, three beads). */
  linerSkinMm?: number;
  /** What is poured, which decides whether a liner can hold it (default epoxy). */
  castMaterial?: CastMaterialId;
  /** The liner's shell and soluble filament (linerMaterials.ts, default PLA + PVA). */
  linerPair?: LinerPairId;
  /**
   * 'combined' (default): shell and liner printed together, two filaments.
   * 'insert': the liner a separate insert in a reusable holder, four prints.
   */
  linerConstruction?: LinerConstruction;
  /** A tongue and groove round a lined clamshell's cavity, so the seam needs no tape (default on). */
  sealRidge?: boolean;
  /** Base diameter of alignment pins in mm. */
  pinDiameterMm: number;
  /** Height of alignment pins in mm. */
  pinHeightMm: number;
  /** Clearance tolerance between pin and socket in mm (e.g. 0.25 mm for FDM). */
  pinToleranceMm: number;
  /** Whether to include a pour sprue: a funnel in the lid's outer face and a neck to the cavity. */
  includeSprue: boolean;
  /** The funnel's mouth at the lid's outer face, mm (45°, as deep as the lid allows; moldSprue.ts). */
  sprueTopDiaMm: number;
  /** The neck into the cavity, mm; never under the cast material's least (castMaterials.ts sprueNeckMm). */
  sprueBottomDiaMm: number;
  /**
   * Where a clamshell is filled from (moldGating.ts); unset, as the cast
   * material wants it (castMaterials.ts defaultSprueFeed: plaster, concrete
   * and Jesmonite from the top, the rest from the bottom). 'bottom': a
   * down-sprue in the wall and a runner to the cavity's lowest point, so the
   * liquid rises and pushes the air out ahead of it. 'top': straight down
   * through the lid into the cavity.
   */
  sprueFeed?: 'bottom' | 'top';
  /** Whether to include air riser vent channels. */
  includeVents: boolean;
  /** Air vent diameter in mm; never under what the cast material needs (`ventBoreDiaMm`). */
  ventDiaMm: number;
  /** Whether to include corner pry notches on the parting seam. */
  includePryNotches: boolean;
  /**
   * Sample the cavity twice as fine, for a fine nozzle. A rigid mold's walls lie
   * half a grid cell off the part, and this halves that; it is four times the
   * triangles. A lined mold's cavity is exact already, so it changes nothing there.
   */
  highFidelity?: boolean;
}

export const DEFAULT_MOLD_OPTIONS: MoldOptions = {
  moldType: 'clamshell',
  pullDirection: 'auto',
  wallMarginMm: 10,
  baseThicknessMm: 5,
  cavityDepthMm: 0,
  draftAngleDeg: 0,
  allowUndercuts: false,
  pinDiameterMm: 6,
  pinHeightMm: 4,
  pinToleranceMm: 0.25,
  includeSprue: true,
  sprueTopDiaMm: 16,
  sprueBottomDiaMm: 6,
  includeVents: true,
  ventDiaMm: 4,
  includePryNotches: true,
};

export interface MoldMeshHalf {
  /**
   * With a dissolvable liner, the half's two materials apart; `triangles` is
   * both. An insert cut into pieces lists its liner piece after piece, bottom
   * first, `pieceTriangles` long each.
   */
  liner?: { shell: Triangle3D[]; liner: Triangle3D[]; pieceTriangles?: number[] };
  name: string;
  triangles: Triangle3D[];
  bounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  widthMm: number;
  depthMm: number;
  heightMm: number;
  /** Z height of the parting face on the build plate in mm (excludes pin rise). */
  partingZMm: number;
  triangleCount: number;
}

export interface MoldExportResult {
  success: boolean;
  /** The mold actually built, with 'auto' resolved. */
  moldType: 'clamshell' | 'open';
  /** The part's direction the mold opens along ('+z' is as placed). */
  pullDirection: PullDirection;
  /** Volume the mold fills in that the part does not have, as a share of the part's volume. */
  lostFraction: number;
  /**
   * True when the cavity half holds the part upside down relative to the pull
   * frame (it holds the top of the part, mirrored in Y to lie cavity up). The
   * cast simulation needs it to turn the casting back the way the part stands.
   */
  cavityHoldsTop: boolean;
  /** One plain sentence on how the mold was set up, when it was turned or chosen for the user. */
  setupNote?: string;
  /** Sprue, vents, pins, sockets and pry notches: what and where each is. */
  features?: MoldFeatureReport;
  binarySTL: Uint8Array;
  partBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  moldBounds: { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number };
  partWidthMm: number;
  partDepthMm: number;
  partHeightMm: number;
  moldWidthMm: number;
  moldDepthMm: number;
  moldHeightMm: number;
  totalTriangles: number;
  /** Deepest point of the deeper half's cavity, in mm. */
  cavityDepthMm: number;
  /**
   * The shallowest taper anywhere on the cavity walls, in degrees off the pull
   * direction. 0 is a dead vertical wall; 90 means the cavity has no walls to
   * speak of. This is what decides whether the mold can let go of the casting.
   */
  minDraftDeg: number;
  /** True when a rigid printed mold will not release this cavity on its own. */
  flexibleMoldAdvised: boolean;
  /** True when the whole part fell on one side and the lid is a plain plate. */
  lidIsBackingPlate: boolean;
  bottomHalf: MoldMeshHalf;
  topHalf?: MoldMeshHalf;
  combinedTriangles: Triangle3D[];
  warnings: string[];
  error?: string;
  /** The liner's figures, when the mold has one. */
  liner?: MoldLinerInfo;
  /** The two-material 3MF, when the mold has a liner. Encoded on first read. */
  threeMf?: Uint8Array;
}

function sameVertex(a: [number, number, number], b: [number, number, number]): boolean {
  return (
    Math.abs(a[0] - b[0]) < 1e-6 &&
    Math.abs(a[1] - b[1]) < 1e-6 &&
    Math.abs(a[2] - b[2]) < 1e-6
  );
}

/** Add a quad as two triangles, skipping degenerate triangles when an edge collapses. */
function addQuad(
  triangles: Triangle3D[],
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number],
  v3: [number, number, number]
) {
  const pinch = sameVertex(v0, v3) || sameVertex(v1, v2);
  if (!pinch && v1[2] + v3[2] > v0[2] + v2[2] + 1e-6) {
    if (!sameVertex(v0, v1) && !sameVertex(v1, v3) && !sameVertex(v0, v3)) {
      triangles.push({ a: v0, b: v1, c: v3, normal: computeNormal(v0, v1, v3) });
    }
    if (!sameVertex(v1, v2) && !sameVertex(v2, v3) && !sameVertex(v1, v3)) {
      triangles.push({ a: v1, b: v2, c: v3, normal: computeNormal(v1, v2, v3) });
    }
    return;
  }
  if (!sameVertex(v0, v1) && !sameVertex(v1, v2) && !sameVertex(v0, v2)) {
    triangles.push({ a: v0, b: v1, c: v2, normal: computeNormal(v0, v1, v2) });
  }
  if (!sameVertex(v0, v2) && !sameVertex(v2, v3) && !sameVertex(v0, v3)) {
    triangles.push({ a: v0, b: v2, c: v3, normal: computeNormal(v0, v2, v3) });
  }
}

// ---------------------------------------------------------------------------
// One mold half
// ---------------------------------------------------------------------------

export interface HalfFeatures {
  /** Tapered sockets sunk into the parting face. */
  sockets: Array<{ x: number; y: number; rimR: number; botR: number; depth: number }>;
  /** Tapered pins standing proud of the parting face. */
  pins: Array<{ x: number; y: number; baseR: number; topR: number; height: number }>;
  /** Round bores (down-sprue, runner, a vent's way up from a pocket), cut with the geometry engine. */
  bores?: BoreCut[];
  /** Channels bored from the outer face through to the cavity. */
  /**
   * `pocketZMm`, a vent's: how far it reaches, mm above the parting face (below
   * it, negative: the pocket is in the other half, and the vent goes through).
   */
  channels: Array<{ x: number; y: number; outerR: number; innerR: number; funnelDepth?: number; pocketZMm?: number }>;
  /** Vents bored from the open top face down to overhanging cavity roof (for open molds). */
  topVents?: Array<{ x: number; y: number; r: number; zRoof: number }>;
}

const NO_FEATURES: HalfFeatures = { sockets: [], pins: [], channels: [] };

/**
 * Where the pour sprue and the vents go: on the part's own footprint, so they
 * open into the cavity, with the sprue where the cavity is widest and the
 * vents at the far ends of it from the sprue, which is where the metal or
 * resin arrives last and the air is pushed to.
 *
 * Fixed spots relative to the bounding box missed any part with a hole in it:
 * the sprue at the box's centre poured into the solid boss a ring's hole
 * leaves in the mold, and the vents could land in it too.
 *
 * Each lands exactly on a grid column, so the column under its axis is void
 * and the cells around it open. Placed off the grid, a channel narrower than
 * the grid's diagonal could miss every column and the face closed over it: a
 * 1.5 mm vent on the 1.5 mm grid of a large mold came out sealed.
 *
 * Positions are in the sampling grid's frame, unmirrored.
 */
function placePourChannels(
  field: ColumnField,
  grid: Grid,
  ventR: number,
  ventCount: number,
  lidSideDepth?: Float64Array,
): { sprue: { x: number; y: number }; vents: Array<{ x: number; y: number }> } {
  const { cols, rows, stepX, stepY } = grid;
  const n = cols * rows;

  const xOf = (i: number) => -grid.halfW + (i % cols) * stepX;
  const yOf = (i: number) => -grid.halfD + Math.floor(i / cols) * stepY;

  // How far each column lies inside the footprint: a two-pass chamfer
  // distance to the nearest column the part misses.
  const inside = new Float64Array(n);
  for (let i = 0; i < n; i++) inside[i] = field.hit[i] ? Infinity : 0;
  const diag = Math.hypot(stepX, stepY);
  const relax = (i: number, c: number, r: number, dc: number, dr: number, w: number) => {
    const cc = c + dc;
    const rr = r + dr;
    const d = cc < 0 || rr < 0 || cc >= cols || rr >= rows ? w : inside[rr * cols + cc] + w;
    if (d < inside[i]) inside[i] = d;
  };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (inside[i] === 0) continue;
      relax(i, c, r, -1, 0, stepX);
      relax(i, c, r, 0, -1, stepY);
      relax(i, c, r, -1, -1, diag);
      relax(i, c, r, 1, -1, diag);
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (inside[i] === 0) continue;
      relax(i, c, r, 1, 0, stepX);
      relax(i, c, r, 0, 1, stepY);
      relax(i, c, r, 1, 1, diag);
      relax(i, c, r, -1, 1, diag);
    }
  }

  // The sprue: deepest inside, and of equally deep columns (a bar's whole
  // spine) the one nearest the middle.
  let sprue = -1;
  for (let i = 0; i < n; i++) {
    if (!field.hit[i]) continue;
    if (
      sprue < 0 ||
      inside[i] > inside[sprue] + 1e-9 ||
      (inside[i] > inside[sprue] - 1e-9 && Math.hypot(xOf(i), yOf(i)) < Math.hypot(xOf(sprue), yOf(sprue)))
    ) {
      sprue = i;
    }
  }
  if (sprue < 0) return { sprue: { x: 0, y: 0 }, vents: [] };

  // Vents want their whole bore over the cavity; on a part too thin for that,
  // as far in as it goes.
  const room = ventR + Math.max(stepX, stepY);
  let candidates: number[] = [];
  for (const need of [room, ventR, 0]) {
    candidates = [];
    for (let i = 0; i < n; i++) if (field.hit[i] && inside[i] >= need) candidates.push(i);
    if (candidates.length > 0) break;
  }

  let maxLidDepth = 0;
  if (lidSideDepth) {
    for (let i = 0; i < n; i++) if (lidSideDepth[i] > maxLidDepth) maxLidDepth = lidSideDepth[i];
  }

  const placed = [sprue];
  const vents: Array<{ x: number; y: number }> = [];
  for (let v = 0; v < ventCount; v++) {
    let best = -1;
    let bestScore = 0;
    for (const i of candidates) {
      let d = Infinity;
      for (const j of placed) d = Math.min(d, Math.hypot(xOf(i) - xOf(j), yOf(i) - yOf(j)));
      const heightBoost = lidSideDepth && maxLidDepth > 1e-6 ? 1 + lidSideDepth[i] / maxLidDepth : 1;
      const score = d * heightBoost;
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best < 0) break;
    placed.push(best);
    vents.push({ x: xOf(best), y: yOf(best) });
  }
  return { sprue: { x: xOf(sprue), y: yOf(sprue) }, vents };
}

/**
 * Places air riser vents for blind undercut pockets in a one-part open mold.
 * Each column's solid part spans are mapped into depth below the open pour face
 * (Z = 0 in half-space). Any span separated from the open pour face by mold
 * material (dStart > 0.1 mm) is a blind pocket; when a column has multiple
 * blind pockets, the deepest roof (`-max(dStart)`) is used so one riser vents
 * all of them without ever piercing the bottom floor of the mold.
 */
function placeOpenMoldBlindVents(
  field: ColumnField,
  grid: Grid,
  ventCount: number,
  partingZ: number,
  detailIsAbove: boolean,
  moldWidthMm: number,
): Array<{ x: number; y: number; zRoof: number }> {
  if (ventCount <= 0) return [];
  const { cols, rows, stepX, stepY } = grid;
  const n = cols * rows;
  const xOf = (i: number) => -grid.halfW + (i % cols) * stepX;
  const yOf = (i: number) => -grid.halfD + Math.floor(i / cols) * stepY;

  const zRoof = new Float64Array(n).fill(-Infinity);
  let hasBlindPockets = false;

  for (let i = 0; i < n; i++) {
    if (!field.hit[i]) continue;
    const sp = field.spans?.[i];
    let deepestPocketDepth = -Infinity;

    if (sp && sp.length >= 2) {
      for (let k = 0; k + 1 < sp.length; k += 2) {
        const z0 = sp[k];
        const z1 = sp[k + 1];
        const dStart = detailIsAbove ? z0 - partingZ : partingZ - z1;
        if (dStart > 0.1 && dStart > deepestPocketDepth) {
          deepestPocketDepth = dStart;
        }
      }
    } else {
      const dStart = detailIsAbove ? field.minZ[i] - partingZ : partingZ - field.maxZ[i];
      if (dStart > 0.1) {
        deepestPocketDepth = dStart;
      }
    }

    if (deepestPocketDepth > 0.1) {
      zRoof[i] = -deepestPocketDepth;
      hasBlindPockets = true;
    }
  }

  if (!hasBlindPockets) return [];

  const candidates: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (zRoof[i] <= -Infinity) continue;
      const val = zRoof[i];
      let isLocalMax = true;
      for (const [dc, dr] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const cc = c + dc, rr = r + dr;
        if (cc >= 0 && cc < cols && rr >= 0 && rr < rows) {
          const nb = rr * cols + cc;
          if (zRoof[nb] > val + 1e-4) {
            isLocalMax = false;
            break;
          }
        }
      }
      if (isLocalMax) candidates.push(i);
    }
  }

  candidates.sort((a, b) => zRoof[b] - zRoof[a]);
  const minDist = Math.max(15, moldWidthMm * 0.12);
  const blindVents: Array<{ x: number; y: number; zRoof: number }> = [];

  for (const i of candidates) {
    const x = xOf(i);
    const y = yOf(i);
    if (blindVents.every((v) => Math.hypot(x - v.x, y - v.y) >= minDist)) {
      blindVents.push({ x, y, zRoof: zRoof[i] });
      if (blindVents.length >= ventCount) break;
    }
  }

  return blindVents;
}

/**
 * Builds one mold half as a heightfield block, cavity facing up, parting face at
 * Z = 0 and outer face at Z = -blockHeight.
 *
 * Every feature is an edit to one of the two height arrays -- a pin raises the
 * upper surface, a socket lowers it, a sprue lifts the lower one until it breaks
 * through -- so the walls the mesher emits between solid and empty columns close
 * the surface no matter which features are on. That is what keeps each half a
 * watertight solid: a hole in a face is a hole, not a pocket hidden behind an
 * intact face that a slicer quietly fills back in.
 */
function buildHalf(
  grid: Grid,
  depth: Float64Array,
  baseThicknessMm: number,
  feats: HalfFeatures = NO_FEATURES,
  minBlockDepthMm: number = 0,
  /** Sockets, pins and channels only size the block: the geometry engine cuts them after. */
  cutAfter = false
): { triangles: Triangle3D[]; blockHeightMm: number; pinRiseMm: number } {
  const n = grid.cols * grid.rows;

  const xs = new Float64Array(grid.cols);
  for (let c = 0; c < grid.cols; c++) xs[c] = -grid.halfW + c * grid.stepX;
  xs[grid.cols - 1] = grid.halfW;

  const ys = new Float64Array(grid.rows);
  for (let r = 0; r < grid.rows; r++) ys[r] = -grid.halfD + r * grid.stepY;
  ys[grid.rows - 1] = grid.halfD;

  let maxDepth = minBlockDepthMm;
  for (let i = 0; i < n; i++) if (depth[i] > maxDepth) maxDepth = depth[i];

  let socketReach = 0;
  for (const s of feats.sockets) socketReach = Math.max(socketReach, s.depth + 1);
  let pinRise = 0;
  for (const p of feats.pins) pinRise = Math.max(pinRise, p.height);

  const blockHeight = Math.max(maxDepth + baseThicknessMm, socketReach + baseThicknessMm);
  const floorZ = -blockHeight;

  const zTop = new Float64Array(n);
  const zBot = new Float64Array(n);
  const solid = new Uint8Array(n);
  const edits = cutAfter ? NO_FEATURES : feats;

  for (let r = 0; r < grid.rows; r++) {
    const y = ys[r];
    for (let c = 0; c < grid.cols; c++) {
      const x = xs[c];
      const i = r * grid.cols + c;

      let top = -depth[i];

      for (const s of edits.sockets) {
        const d = Math.hypot(x - s.x, y - s.y);
        if (d >= s.rimR) continue;
        const t = d <= s.botR ? 1 : (s.rimR - d) / (s.rimR - s.botR);
        top = Math.min(top, -s.depth * t);
      }

      for (const p of edits.pins) {
        const d = Math.hypot(x - p.x, y - p.y);
        if (d >= p.baseR) continue;
        const t = d <= p.topR ? 1 : (p.baseR - d) / (p.baseR - p.topR);
        top = Math.max(top, p.height * t);
      }

      if (feats.topVents) {
        for (const v of feats.topVents) {
          const d = Math.hypot(x - v.x, y - v.y);
          if (d <= v.r) {
            top = Math.min(top, v.zRoof);
          }
        }
      }

      // A channel at a cell centre (planPeakVents) is up to half a grid diagonal
      // from its nearest vertex; innerR must reach that vertex or solid[i] stays 1
      // at all four corners and the heightfield lid closes the vent over with a skin.
      const minChannelR = 0.55 * Math.hypot(grid.stepX, grid.stepY);
      let bot = floorZ;
      for (const ch of edits.channels) {
        const reach = (ch.pocketZMm ?? 0) > 0 ? Math.min(top, -ch.pocketZMm!) : top;
        const innerR = Math.max(ch.innerR, minChannelR);
        const outerR = Math.max(ch.outerR, innerR + 0.2);
        const d = Math.hypot(x - ch.x, y - ch.y);
        if (d >= outerR) continue;
        // The funnel is wide at the outer face and narrows to innerR where it
        // breaks into the cavity, so the column is void from the outer face up
        // to wherever the cone wall passes it.
        if (ch.funnelDepth !== undefined) {
          // The sprue: a 45° funnel this deep, then the neck straight on.
          const h = d <= innerR ? reach - floorZ : ch.funnelDepth * (outerR - d) / (outerR - innerR);
          bot = Math.max(bot, floorZ + Math.min(h, reach - floorZ));
          continue;
        }
        const t = d <= innerR ? 1 : (outerR - d) / (outerR - innerR);
        bot = Math.max(bot, floorZ + (reach - floorZ) * t);
      }

      zTop[i] = top;
      zBot[i] = Math.min(bot, top);
      solid[i] = top - zBot[i] > 1e-6 ? 1 : 0;
    }
  }

  const cellCols = grid.cols - 1;
  const cellRows = grid.rows - 1;
  const cellSolid = new Uint8Array(cellCols * cellRows);
  for (let r = 0; r < cellRows; r++) {
    for (let c = 0; c < cellCols; c++) {
      const i00 = r * grid.cols + c;
      // All four corners, not any: a cell with a corner of no thickness has
      // its top and bottom meet there, and the welded mold comes out open.
      cellSolid[r * cellCols + c] =
        solid[i00] && solid[i00 + 1] && solid[i00 + grid.cols] && solid[i00 + grid.cols + 1] ? 1 : 0;
    }
  }
  const triangles: Triangle3D[] = [];
  const isSolidCell = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < cellCols && r < cellRows && cellSolid[r * cellCols + c] === 1;

  for (let r = 0; r < cellRows; r++) {
    const y0 = ys[r];
    const y1 = ys[r + 1];
    for (let c = 0; c < cellCols; c++) {
      if (!isSolidCell(c, r)) continue;
      const x0 = xs[c];
      const x1 = xs[c + 1];

      const i00 = r * grid.cols + c;
      const i10 = i00 + 1;
      const i01 = i00 + grid.cols;
      const i11 = i01 + 1;

      // Cavity-side surface, facing up.
      addQuad(
        triangles,
        [x0, y0, zTop[i00]],
        [x1, y0, zTop[i10]],
        [x1, y1, zTop[i11]],
        [x0, y1, zTop[i01]]
      );

      // Outer face, facing down.
      addQuad(
        triangles,
        [x0, y0, zBot[i00]],
        [x0, y1, zBot[i01]],
        [x1, y1, zBot[i11]],
        [x1, y0, zBot[i10]]
      );

      if (!isSolidCell(c, r - 1)) {
        addQuad(
          triangles,
          [x0, y0, zBot[i00]],
          [x1, y0, zBot[i10]],
          [x1, y0, zTop[i10]],
          [x0, y0, zTop[i00]]
        );
      }
      if (!isSolidCell(c, r + 1)) {
        addQuad(
          triangles,
          [x1, y1, zBot[i11]],
          [x0, y1, zBot[i01]],
          [x0, y1, zTop[i01]],
          [x1, y1, zTop[i11]]
        );
      }
      if (!isSolidCell(c - 1, r)) {
        addQuad(
          triangles,
          [x0, y1, zBot[i01]],
          [x0, y0, zBot[i00]],
          [x0, y0, zTop[i00]],
          [x0, y1, zTop[i01]]
        );
      }
      if (!isSolidCell(c + 1, r)) {
        addQuad(
          triangles,
          [x1, y0, zBot[i10]],
          [x1, y1, zBot[i11]],
          [x1, y1, zTop[i11]],
          [x1, y0, zTop[i10]]
        );
      }
    }
  }

  return { triangles, blockHeightMm: blockHeight, pinRiseMm: pinRise };
}

/** Lifts a half off its parting plane onto the build plate at X = offset. */
function toPlate(tris: Triangle3D[], xOffset: number, lift: number): Triangle3D[] {
  const move = (v: [number, number, number]): [number, number, number] => [v[0] + xOffset, v[1], v[2] + lift];
  // Moved, corners a cut left microns apart can land on one float32.
  return tris
    .map((t) => ({ a: move(t.a), b: move(t.b), c: move(t.c), normal: t.normal }))
    .filter((t) => !sameFloat32(t.a, t.b) && !sameFloat32(t.b, t.c) && !sameFloat32(t.a, t.c));
}

/**
 * A result with nothing in it. Exported because the export modal needs one to
 * hold while it is closed, and a copy of this shape written out by hand there is
 * a copy that stops compiling every time this one grows a field.
 */
export function emptyMoldResult(message?: string): MoldExportResult {
  const zero = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  return {
    success: false,
    moldType: 'clamshell',
    pullDirection: '+z',
    lostFraction: 0,
    cavityHoldsTop: false,
    binarySTL: new Uint8Array(84),
    partBounds: zero,
    moldBounds: zero,
    partWidthMm: 0,
    partDepthMm: 0,
    partHeightMm: 0,
    moldWidthMm: 0,
    moldDepthMm: 0,
    moldHeightMm: 0,
    totalTriangles: 0,
    cavityDepthMm: 0,
    minDraftDeg: 90,
    flexibleMoldAdvised: false,
    lidIsBackingPlate: false,
    bottomHalf: { name: 'bottom', triangles: [], bounds: zero, widthMm: 0, depthMm: 0, heightMm: 0, partingZMm: 0, triangleCount: 0 },
    combinedTriangles: [],
    warnings: message ? [message] : [],
    error: message,
  };
}

export interface CsgContext {
  setup: MoldSetupFields;
  /** The block plans when it follows the part (blockShape 'fit'), else null: a box. */
  outlines: MoldOutlines | null;
  wasm: ManifoldToplevel;
  tris: Float64Array;
  solidIds: number[];
  /** The body each solid id belongs to, for naming one that will not close. */
  solidNames: string[];
  partingZ: number;
  detailIsAbove: boolean;
  moldWidthMm: number;
  moldDepthMm: number;
  partHeightMm: number;
  rawCavityDepthMm: number;
  opts: MoldOptions;
  baseFeatures: HalfFeatures;
  lidFeatures: HalfFeatures;
  baseBlockHeight: number;
  lidBlockHeight: number;
  mnX: number;
  mxX: number;
  mnY: number;
  mxY: number;
  mnZ: number;
  mxZ: number;
  partWidthMm: number;
  partDepthMm: number;
  minDraftDeg: number;
  flexibleMoldAdvised: boolean;
  lidIsBackingPlate: boolean;
  undercutColumns: number;
  warnings: string[];
  grid: Grid;
  /** Undrafted cavity depth per column, each half in its own build frame; draftPart tapers from these. */
  rawBaseDepth: Float64Array;
  rawLidDepth: Float64Array;
}

function buildMoldCSG(ctx: CsgContext): MoldExportResult | { error: string } {
  const {
    wasm, tris, solidIds, solidNames, partingZ, detailIsAbove,
    moldWidthMm, moldDepthMm, partHeightMm, rawCavityDepthMm,
    opts, baseFeatures, lidFeatures,
    baseBlockHeight, lidBlockHeight,
    mnX, mxX, mnY, mxY, mnZ, mxZ,
    partWidthMm, partDepthMm,
    minDraftDeg, flexibleMoldAdvised, lidIsBackingPlate,
    warnings,
  } = ctx;

  const { part: rawPartManifold, unsolid } = buildPartManifold(wasm, tris, solidIds);
  if (!rawPartManifold) return { error: unsolidPartRefusal(unsolid, solidNames, 'the undercut-keeping mold') };

  const mw2 = moldWidthMm / 2;
  const md2 = moldDepthMm / 2;

  if (opts.moldType === 'open') {
    let partManifold: Manifold;
    if (detailIsAbove) {
      const mat: Mat4Tuple = [
        1, 0, 0, 0,
        0, -1, 0, 0,
        0, 0, -1, 0,
        0, 0, partingZ, 1,
      ];
      partManifold = rawPartManifold.transform(mat);
      rawPartManifold.delete();
    } else {
      partManifold = rawPartManifold.translate([0, 0, -partingZ]);
      rawPartManifold.delete();
    }
    const draftedPart = draftPart(wasm, partManifold, ctx.grid, ctx.rawBaseDepth, opts.draftAngleDeg, opts.draftMode);
    if (draftedPart !== partManifold) {
      partManifold.delete();
      partManifold = draftedPart;
    }

    const blockHeight = partHeightMm + opts.baseThicknessMm;
    const moldBlock = fittedBlock(wasm, wasm.Manifold.cube([moldWidthMm, moldDepthMm, blockHeight], false)
      .translate([-mw2, -md2, -blockHeight]), ctx.outlines?.base, -blockHeight, 0);

    const cutter = withPourMouth(wasm, partManifold, sprueNeckDiaMm(opts.sprueBottomDiaMm, opts.castMaterial));

    let openMold = moldBlock.subtract(cutter);
    moldBlock.delete();
    cutter.delete();

    // Subtract vertical vent cylinders for blind pockets (never piercing the bottom floor)
    if (baseFeatures.topVents && baseFeatures.topVents.length > 0) {
      for (const v of baseFeatures.topVents) {
        const zPocket = v.zRoof;
        if (zPocket < -0.1 && zPocket > -blockHeight + 0.5) {
          const cylH = 1.0 - zPocket;
          const cyl = wasm.Manifold.cylinder(cylH, v.r, v.r, 24, false).translate([v.x, v.y, zPocket]);
          const next = openMold.subtract(cyl);
          openMold.delete();
          cyl.delete();
          openMold = next;
        }
      }
    }

    // Lift onto plate
    const plated = openMold.translate([0, 0, blockHeight]);
    openMold.delete();

    const plateBottomTris = manifoldToTriangles(plated);
    plated.delete();

    let stlBytes: Uint8Array | null = null;
    const moldBounds = {
      minX: -moldWidthMm / 2,
      minY: -moldDepthMm / 2,
      minZ: 0,
      maxX: moldWidthMm / 2,
      maxY: moldDepthMm / 2,
      maxZ: blockHeight,
    };

    return {
      success: true,
      ...ctx.setup,
      get binarySTL() {
        if (!stlBytes) stlBytes = exportBinarySTL(plateBottomTris, 'PhysBox 3D Mold Plate');
        return stlBytes;
      },
      partBounds: { minX: mnX, minY: mnY, minZ: mnZ, maxX: mxX, maxY: mxY, maxZ: mxZ },
      moldBounds,
      partWidthMm: Math.round(partWidthMm * 10) / 10,
      partDepthMm: Math.round(partDepthMm * 10) / 10,
      partHeightMm: Math.round(partHeightMm * 10) / 10,
      moldWidthMm: Math.round(moldWidthMm * 10) / 10,
      moldDepthMm: Math.round(moldDepthMm * 10) / 10,
      moldHeightMm: Math.round(blockHeight * 10) / 10,
      totalTriangles: plateBottomTris.length,
      cavityDepthMm: Math.round(partHeightMm * 10) / 10,
      minDraftDeg: Math.round(minDraftDeg * 10) / 10,
      flexibleMoldAdvised,
      lidIsBackingPlate,
      bottomHalf: {
        name: 'Cavity Half',
        triangles: plateBottomTris,
        bounds: boundsOf(plateBottomTris),
        widthMm: moldWidthMm,
        depthMm: moldDepthMm,
        heightMm: Math.round(blockHeight * 10) / 10,
        partingZMm: Math.round(blockHeight * 100) / 100,
        triangleCount: plateBottomTris.length,
      },
      topHalf: undefined,
      combinedTriangles: plateBottomTris,
      warnings,
    };
  }

  // Clamshell mode in 3D CSG
  let basePart: Manifold;
  let lidPart: Manifold;

  if (detailIsAbove) {
    const mat: Mat4Tuple = [
      1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, -1, 0,
      0, 0, partingZ, 1,
    ];
    basePart = rawPartManifold.transform(mat);
    lidPart = rawPartManifold.translate([0, 0, -partingZ]);
    rawPartManifold.delete();
  } else {
    basePart = rawPartManifold.translate([0, 0, -partingZ]);
    const mat: Mat4Tuple = [
      1, 0, 0, 0,
      0, -1, 0, 0,
      0, 0, -1, 0,
      0, 0, partingZ, 1,
    ];
    lidPart = rawPartManifold.transform(mat);
    rawPartManifold.delete();
  }

  // The exact part, tapered as the depth-field mold would be.
  const taper = (m: Manifold, raw: Float64Array) => {
    const t = draftPart(wasm, m, ctx.grid, raw, opts.draftAngleDeg, opts.draftMode);
    if (t !== m) m.delete();
    return t;
  };
  basePart = taper(basePart, ctx.rawBaseDepth);
  lidPart = taper(lidPart, ctx.rawLidDepth);

  const baseBlock = fittedBlock(wasm, wasm.Manifold.cube([moldWidthMm, moldDepthMm, baseBlockHeight], false)
    .translate([-mw2, -md2, -baseBlockHeight]), ctx.outlines?.base, -baseBlockHeight, 0);

  const carvedBase = cutHalfFeatures(wasm, baseBlock.subtract(basePart), baseFeatures, baseBlockHeight);
  baseBlock.delete();
  basePart.delete();

  const lidBlock = fittedBlock(wasm, wasm.Manifold.cube([moldWidthMm, moldDepthMm, lidBlockHeight], false)
    .translate([-mw2, -md2, -lidBlockHeight]), ctx.outlines?.lid, -lidBlockHeight, 0);

  const carvedLid = cutHalfFeatures(wasm, lidBlock.subtract(lidPart), lidFeatures, lidBlockHeight);
  lidBlock.delete();
  lidPart.delete();

  const plateGapMm = 6;
  const plateOffset = moldWidthMm / 2 + plateGapMm / 2;
  const platedBase = carvedBase.translate([-plateOffset, 0, baseBlockHeight]);
  carvedBase.delete();
  const platedLid = carvedLid.translate([plateOffset, 0, lidBlockHeight]);
  carvedLid.delete();

  const plateBottomTris = manifoldToTriangles(platedBase);
  platedBase.delete();
  const plateTopTris = manifoldToTriangles(platedLid);
  platedLid.delete();

  const combinedTriangles = [...plateBottomTris, ...plateTopTris];
  let stlBytes: Uint8Array | null = null;
  const totalWidth = moldWidthMm * 2 + plateGapMm;
  const totalHeight = Math.max(
    baseBlockHeight,
    lidBlockHeight + opts.pinHeightMm
  );

  return {
    success: true,
    ...ctx.setup,
    get binarySTL() {
      if (!stlBytes) stlBytes = exportBinarySTL(combinedTriangles, 'PhysBox 3D Mold Plate');
      return stlBytes;
    },
    partBounds: { minX: mnX, minY: mnY, minZ: mnZ, maxX: mxX, maxY: mxY, maxZ: mxZ },
    moldBounds: {
      minX: -totalWidth / 2,
      minY: -moldDepthMm / 2,
      minZ: 0,
      maxX: totalWidth / 2,
      maxY: moldDepthMm / 2,
      maxZ: totalHeight,
    },
    partWidthMm: Math.round(partWidthMm * 10) / 10,
    partDepthMm: Math.round(partDepthMm * 10) / 10,
    partHeightMm: Math.round(partHeightMm * 10) / 10,
    moldWidthMm: Math.round(moldWidthMm * 10) / 10,
    moldDepthMm: Math.round(moldDepthMm * 10) / 10,
    moldHeightMm: Math.round(totalHeight * 10) / 10,
    totalTriangles: combinedTriangles.length,
    cavityDepthMm: Math.round(rawCavityDepthMm * 10) / 10,
    minDraftDeg: Math.round(minDraftDeg * 10) / 10,
    flexibleMoldAdvised,
    lidIsBackingPlate,
    bottomHalf: {
      name: 'Cavity Half',
      triangles: plateBottomTris,
      bounds: boundsOf(plateBottomTris),
      widthMm: moldWidthMm,
      depthMm: moldDepthMm,
      heightMm: Math.round(baseBlockHeight * 10) / 10,
      partingZMm: Math.round(baseBlockHeight * 100) / 100,
      triangleCount: plateBottomTris.length,
    },
    topHalf: {
      name: 'Lid Half (Pins, Sprue & Vents)',
      triangles: plateTopTris,
      bounds: boundsOf(plateTopTris),
      widthMm: moldWidthMm,
      depthMm: moldDepthMm,
      heightMm: Math.round((lidBlockHeight + opts.pinHeightMm) * 10) / 10,
      partingZMm: Math.round(lidBlockHeight * 100) / 100,
      triangleCount: plateTopTris.length,
    },
    combinedTriangles,
    warnings,
  };
}

/**
 * The features of a mold in words and numbers. The notches are the last
 * sockets on the cavity half (they are cut the same way, only shallower).
 */
function describeMoldFeatures(
  opts: MoldOptions,
  base: HalfFeatures,
  lid: HalfFeatures,
  notchCount: number,
  bottomFill: BottomFill | null = null,
): MoldFeatureReport {
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const at = (x: number, y: number): [number, number] => [r1(x), r1(y)];
  const open = opts.moldType === 'open';
  const baseHalf = open ? 'open mold' as const : 'cavity half' as const;
  const sockets = base.sockets.slice(0, base.sockets.length - notchCount);
  const notches = base.sockets.slice(base.sockets.length - notchCount);
  const channels = open ? [] : lid.channels;
  const sprue = opts.includeSprue && channels.length ? channels[0] : null;
  const vents = sprue ? channels.slice(1) : channels;
  return {
    frame: 'mm from the centre of each half, as it prints (parting face up); the lid is mirrored in Y against the cavity half, as it closes over it',
    sprue: sprue
      ? { half: 'lid half', atMm: at(sprue.x, sprue.y), diaMm: r1(sprue.outerR * 2), narrowDiaMm: r1(sprue.innerR * 2), depthMm: r1(sprue.funnelDepth ?? 0) }
      : null,
    feed: bottomFill ? 'bottom' : 'top',
    ...(bottomFill
      ? {
          downSprue: { half: 'cavity half' as const, atMm: at(bottomFill.down.x, bottomFill.down.y), diaMm: r1(bottomFill.r * 2), depthMm: r1(bottomFill.r - bottomFill.runnerZ) },
          gate: { half: 'cavity half' as const, atMm: at(bottomFill.gate.x, bottomFill.gate.y), diaMm: r1(bottomFill.gateR * 2), depthMm: r1(-bottomFill.gate.z) },
        }
      : {}),
    vents: vents.map((v) => ({ half: 'lid half' as const, atMm: at(v.x, v.y), diaMm: r1(v.innerR * 2), ...(v.pocketZMm !== undefined ? { pocketZMm: r1(v.pocketZMm) } : {}) })),
    blindVents: (base.topVents ?? []).map((v) => ({ half: baseHalf, atMm: at(v.x, v.y), diaMm: r1(v.r * 2), depthMm: r1(Math.abs(v.zRoof)) })),
    pins: lid.pins.map((p) => ({ half: 'lid half' as const, atMm: at(p.x, p.y), diaMm: r1(p.baseR * 2), narrowDiaMm: r1(p.topR * 2), heightMm: r1(p.height) })),
    sockets: sockets.map((k) => ({ half: baseHalf, atMm: at(k.x, k.y), diaMm: r1(k.rimR * 2), narrowDiaMm: r1(k.botR * 2), depthMm: r1(k.depth) })),
    pryNotches: notches.map((k) => ({ half: baseHalf, atMm: at(k.x, k.y), diaMm: r1(k.rimR * 2), depthMm: r1(k.depth) })),
  };
}

/** The feature report as short lines, for a note card. */
export function moldFeatureLines(f: MoldFeatureReport | undefined): string[] {
  if (!f) return [];
  const xy = (m: MoldFeature) => `(${m.atMm[0]}, ${m.atMm[1]})`;
  const list = (ms: MoldFeature[]) => ms.map(xy).join(', ');
  return [
    ...(f.sprue ? [`Sprue (pour hole): ⌀${f.sprue.diaMm} mm funnel ${f.sprue.depthMm ?? 0} mm deep, then a ⌀${f.sprue.narrowDiaMm} mm neck through the lid at ${xy(f.sprue)}`] : []),
    ...(f.feed === 'bottom' && f.downSprue && f.gate
      ? [`Bottom fill: on down the cavity half's wall at ${xy(f.downSprue)}, ${f.downSprue.depthMm} mm, along under the cavity, and up through a ⌀${f.gate.diaMm} mm gate into its lowest point at ${xy(f.gate)}`]
      : []),
    ...(f.vents.length ? [`Vents: ${f.vents.length}× ⌀${f.vents[0].diaMm} mm through the lid at ${list(f.vents)}`] : []),
    ...(f.blindVents.length ? [`Blind vents: ${f.blindVents.length}× ⌀${f.blindVents[0].diaMm} mm down from the top at ${list(f.blindVents)}`] : []),
    ...(f.pins.length ? [`Registration pins: ${f.pins.length}× ⌀${f.pins[0].diaMm} mm on the lid, sockets in the cavity half`] : []),
    ...(f.pryNotches.length ? [`Pry notches: ${f.pryNotches.length} on the seam at ${list(f.pryNotches)}, to lever the halves apart`] : []),
  ];
}

// ---------------------------------------------------------------------------
// Mold setup: which mold, opening which way
// ---------------------------------------------------------------------------

export type MoldSetupFields = Pick<
  MoldExportResult,
  'moldType' | 'pullDirection' | 'lostFraction' | 'cavityHoldsTop' | 'setupNote' | 'features'
>;

/** One hole or peg of a mold, where it is on its half. */
export interface MoldFeature {
  half: 'cavity half' | 'lid half' | 'open mold';
  /** From the centre of that half, mm, as it prints: parting face (or open top) up. */
  atMm: [number, number];
  diaMm: number;
  /** For a tapered one, the diameter at its narrow end. */
  narrowDiaMm?: number;
  depthMm?: number;
  heightMm?: number;
  /** A vent's: where it meets its pocket, mm above the parting face in the closed mold. */
  pocketZMm?: number;
}

/**
 * What every hole and peg on a mold is for, so nobody has to guess from the
 * shape: an agent once called the pry notches channels.
 */
export interface MoldFeatureReport {
  frame: string;
  /** Poured into: a funnel in the lid's outer face (diaMm wide, depthMm deep), then a neck (narrowDiaMm) to the cavity. */
  sprue: MoldFeature | null;
  /** 'bottom': the sprue goes on down the cavity half's wall (downSprue) and along its floor into the lowest point (gate). */
  feed: 'bottom' | 'top';
  downSprue?: MoldFeature;
  gate?: MoldFeature;
  /** Air out: through the lid from every high point of the cavity as poured (up through the cavity half too, for a pocket in it). */
  vents: MoldFeature[];
  /** Blind vents bored down from an open mold's top over a trapped pocket of air. */
  blindVents: MoldFeature[];
  /** Registration pins standing on the lid's parting face, one keyed off its corner. */
  pins: MoldFeature[];
  /** Their sockets in the cavity half's parting face. */
  sockets: MoldFeature[];
  /** Shallow cones on the seam at the two side edges: lever the halves apart there. */
  pryNotches: MoldFeature[];
}

/**
 * An open mold is one print with nothing to line up, so 'auto' takes it unless
 * a clamshell keeps more of the part than this share of its volume.
 */
export const OPEN_MOLD_ALLOWANCE = 0.01;

/**
 * The search tries every axis over the whole part, a few hundred milliseconds on
 * a scanned bust, and the dialog regenerates on every option change while the
 * scene stays put -- so the answer is kept per scene object.
 */
const pullCache = new WeakMap<SceneGraph, { open?: PullChoice; clamshell?: PullChoice }>();

function pullChoiceFor(scene: SceneGraph, tris: ArrayLike<number>, type: 'open' | 'clamshell'): PullChoice {
  let entry = pullCache.get(scene);
  if (!entry) {
    entry = {};
    pullCache.set(scene, entry);
  }
  if (!entry[type]) {
    // Metres in, millimetres to the sampler, whose tolerances are in mm.
    const mm = new Float64Array(tris.length);
    for (let i = 0; i < tris.length; i++) mm[i] = tris[i] * 1000;
    entry[type] = choosePullDirection(mm, type === 'open');
  }
  return entry[type];
}

const AXIS_WORDS: Record<PullDirection, string> = {
  '+z': 'top to bottom',
  '-z': 'top to bottom',
  '+y': 'front to back',
  '-y': 'front to back',
  '+x': 'side to side',
  '-x': 'side to side',
};

/**
 * Settles the mold type and the direction it opens along. A part prepared for
 * casting already has its draft cut for Z, so it keeps Z unless told otherwise.
 */
function resolveMoldSetup(
  scene: SceneGraph,
  sceneTris: ArrayLike<number>,
  opts: MoldOptions
): { moldType: 'clamshell' | 'open'; direction: PullDirection; note?: string } {
  const prepped = Boolean(scene.castPrep && scene.castPrep.draftDeg > 0);
  const fixedDirection: PullDirection | null =
    opts.pullDirection && opts.pullDirection !== 'auto' ? opts.pullDirection : prepped ? '+z' : null;

  const lossOf = (type: 'open' | 'clamshell') => {
    const choice = pullChoiceFor(scene, sceneTris, type);
    if (!fixedDirection) return { direction: choice.direction, lost: choice.lostFraction, depth: choice.depthMm };
    // A clamshell opens both ways at once, so it was only measured on +axes.
    const measured = type === 'open' ? fixedDirection : (`+${fixedDirection[1]}` as PullDirection);
    const c = choice.candidates.find((k) => k.direction === measured);
    return { direction: fixedDirection, lost: c ? c.lostFraction : choice.lostFraction, depth: c ? c.depthMm : choice.depthMm };
  };

  let moldType: 'clamshell' | 'open';
  let direction: PullDirection;
  if (opts.moldType === 'auto') {
    const open = lossOf('open');
    const clam = lossOf('clamshell');
    // Open unless a clamshell keeps clearly more of the part, or is clearly
    // shallower: a pin standing in an open mold is a 120 mm blind bore.
    moldType = open.lost <= clam.lost + OPEN_MOLD_ALLOWANCE && !(clam.depth < open.depth * SHALLOWER_PULL) ? 'open' : 'clamshell';
    direction = moldType === 'open' ? open.direction : clam.direction;
  } else {
    moldType = opts.moldType;
    direction = fixedDirection ?? lossOf(moldType).direction;
  }
  // A lined clamshell loses no undercut whichever way it opens; it is turned
  // to the axis that leaves least liner it cannot print over the casting.
  if (opts.dissolvableLiner && moldType === 'clamshell' && !fixedDirection) {
    const mm = new Float64Array(sceneTris.length);
    for (let i = 0; i < sceneTris.length; i++) mm[i] = sceneTris[i] * 1000;
    direction = linerPullChoice(mm, direction) ?? direction;
  }

  let note: string | undefined;
  const turned = !fixedDirection && direction !== '+z' && direction !== '-z';
  if (opts.moldType === 'auto' || turned) {
    note =
      moldType === 'open'
        ? turned
          ? `One-part open mold oriented ${AXIS_WORDS[direction]} to minimize undercuts.`
          : 'One-part open mold.'
        : `Two-part mold opening ${AXIS_WORDS[direction]}.`;
  }
  return { moldType, direction, note };
}

/**
 * Samples a 3D scene graph into a 2-part clamshell or 1-part open casting mold.
 */
export function generateMoldMeshes(
  scene: SceneGraph,
  options: Partial<MoldOptions> = {},
  wasm?: ManifoldToplevel | null
): MoldExportResult {
  const opts: MoldOptions = { ...DEFAULT_MOLD_OPTIONS, ...options };
  const warnings: string[] = [];
  const activeWasm = wasm ?? null;

  // Extract all world triangles in scene space (metres)
  const { tris: sceneTris, solidIds: sceneSolidIds, solidNames: sceneSolidNames, warnings: sceneWarnings } = collectSceneTriangles(scene);
  if (sceneWarnings?.length) warnings.push(...sceneWarnings);

  if (!sceneTris || sceneTris.length === 0) {
    return emptyMoldResult('Scene contains no visible 3D geometry to mold.');
  }

  // Everything below builds a mold that opens along +Z, so the part is turned
  // to put the chosen direction there first.
  const setup = resolveMoldSetup(scene, sceneTris, opts);
  opts.moldType = setup.moldType;
  const partTris = setup.direction === '+z' ? sceneTris : rotateTrianglesForPull(sceneTris, setup.direction);

  // Find model bounding box in mm
  let mnX = Infinity, mxX = -Infinity;
  let mnY = Infinity, mxY = -Infinity;
  let mnZ = Infinity, mxZ = -Infinity;

  for (let i = 0; i < partTris.length; i += 3) {
    const x = partTris[i] * 1000;
    const y = partTris[i + 1] * 1000;
    const z = partTris[i + 2] * 1000;
    if (x < mnX) mnX = x;
    if (x > mxX) mxX = x;
    if (y < mnY) mnY = y;
    if (y > mxY) mxY = y;
    if (z < mnZ) mnZ = z;
    if (z > mxZ) mxZ = z;
  }

  const partWidthMm = mxX - mnX || 10;
  const partDepthMm = mxY - mnY || 10;
  const rawPartHeightMm = mxZ - mnZ || 5;
  const partHeightMm = opts.cavityDepthMm > 0 ? opts.cavityDepthMm : rawPartHeightMm;
  const zScale = opts.cavityDepthMm > 0 && rawPartHeightMm > 0 ? opts.cavityDepthMm / rawPartHeightMm : 1.0;

  // Center the part on the origin in XY, and on its own mid-height in Z.
  const cx = (mnX + mxX) / 2;
  const cy = (mnY + mxY) / 2;
  const cz = (mnZ + mxZ) / 2;

  const triCount = partTris.length / 9;
  const tris = new Float64Array(partTris.length);
  for (let i = 0; i < partTris.length; i += 3) {
    tris[i] = partTris[i] * 1000 - cx;
    tris[i + 1] = partTris[i + 1] * 1000 - cy;
    tris[i + 2] = (partTris[i + 2] * 1000 - cz) * zScale;
  }

  const partHalfW = partWidthMm / 2;
  const partHalfD = partDepthMm / 2;
  const moldWidthMm = partWidthMm + 2 * opts.wallMarginMm;
  const moldDepthMm = partDepthMm + 2 * opts.wallMarginMm;
  const mw2 = moldWidthMm / 2;
  const md2 = moldDepthMm / 2;

  // One grid spans the whole block, not just the part, so a pin, a socket or a
  // vent out in the flange is the same kind of height edit as the cavity itself.
  const fineness = opts.highFidelity && !opts.dissolvableLiner ? 2 : 1;
  const target = 150 * fineness;
  const res = Math.min(1.5 / fineness, Math.max(0.3 / fineness, Math.max(moldWidthMm, moldDepthMm) / target));
  const cols = Math.max(8, Math.round(moldWidthMm / res) + 1);
  const rows = Math.max(8, Math.round(moldDepthMm / res) + 1);
  const grid: Grid = {
    cols,
    rows,
    stepX: moldWidthMm / (cols - 1),
    stepY: moldDepthMm / (rows - 1),
    halfW: mw2,
    halfD: md2,
  };

  const field = sampleColumns(tris, triCount, grid, partHalfW, partHalfD);
  if (field.hitColumns === 0) {
    return emptyMoldResult('The part is too thin along Z for the mold sampler to find a surface.');
  }

  const zMin = -partHeightMm / 2;
  const zMax = partHeightMm / 2;
  const zEps = Math.max(1e-6, partHeightMm * 1e-4);

  // In a one-part open mold there is no lid half, so the open pour face must sit
  // at one extreme of the part (whichever face has the larger footprint, ties to
  // the bottom) so the single cavity holds the whole height of the part instead
  // of slicing it at an interior equator and throwing half away.
  let partingZ: number;
  if (opts.moldType === 'open') {
    let covBottom = 0;
    let covTop = 0;
    for (let i = 0; i < field.hit.length; i++) {
      if (!field.hit[i]) continue;
      if (field.minZ[i] <= zMin + zEps) covBottom++;
      if (field.maxZ[i] >= zMax - zEps) covTop++;
    }
    partingZ = covTop > covBottom ? zMax : zMin;
  } else if (scene.castPrep?.partingZ !== undefined && scene.castPrep.draftDeg > 0 && setup.direction === '+z') {
    const preppedZ = (scene.castPrep.partingZ * 1000 - cz) * zScale;
    partingZ =
      preppedZ >= zMin - zEps && preppedZ <= zMax + zEps
        ? Math.max(zMin, Math.min(zMax, preppedZ))
        : choosePartingZ(field, zMin, zMax);
  } else {
    partingZ = choosePartingZ(field, zMin, zMax);
    // A lined mold keeps every undercut, so what matters is what it can print:
    // the plane that leaves least liner hanging over the casting (moldRoofScore).
    if (opts.dissolvableLiner && opts.moldType === 'clamshell') partingZ = linerPartingChoice(tris, zMin, zMax, partingZ).z;
  }

  if (scene.castPrep && scene.castPrep.draftDeg > 0 && opts.draftAngleDeg > 0) {
    warnings.push(
      `The model already carries ${scene.castPrep.draftDeg}\u00b0 of draft from Prepare for Casting; ` +
      `adding ${opts.draftAngleDeg}\u00b0 here tapers the cavity walls a second time.`
    );
  }

  // Cavity depth on each side of the parting plane, as a depth below the face
  // that half presents. Columns the part misses stay flat at the parting plane.
  // Any column whose material does not touch the parting plane at all has air
  // between the plane and the part that a flat-parted mold fills in solid.
  const n = cols * rows;
  const below = new Float64Array(n);
  const above = new Float64Array(n);
  let volBelow = 0;
  let volAbove = 0;
  let undercutColumns = field.undercutColumns;
  for (let i = 0; i < n; i++) {
    if (!field.hit[i]) continue;
    below[i] = Math.max(0, partingZ - field.minZ[i]);
    above[i] = Math.max(0, field.maxZ[i] - partingZ);
    volBelow += below[i];
    volAbove += above[i];
    if (
      !field.multiCrossings[i] &&
      (field.minZ[i] > partingZ + zEps || field.maxZ[i] < partingZ - zEps)
    ) {
      undercutColumns++;
    }
  }

  // The half holding the most of the part is the one that lies on the bench
  // cavity-up; the shallower half becomes the lid, and it is the lid that gets
  // the pour sprue and the vents, so the sprue stub lands on the back of the
  // casting rather than through the middle of its face.
  const detailIsAbove = volAbove > volBelow;

  // What the mold adds to the casting: each column casts solid from its lowest
  // surface to its highest (and on to the parting plane), the part only fills
  // its spans.
  let partLen = 0;
  let castLen = 0;
  for (let i = 0; i < n; i++) {
    if (!field.hit[i]) continue;
    const sp = field.spans[i];
    for (let k = 0; k + 1 < sp.length; k += 2) partLen += sp[k + 1] - sp[k];
    castLen += Math.max(field.maxZ[i], partingZ) - Math.min(field.minZ[i], partingZ);
  }
  const setupFields: MoldSetupFields = {
    moldType: setup.moldType,
    pullDirection: setup.direction,
    lostFraction: partLen > 0 ? Math.max(0, castLen - partLen) / partLen : 0,
    cavityHoldsTop: detailIsAbove,
    ...(setup.note ? { setupNote: setup.note } : {}),
  };
  const mirrorY = (src: Float64Array) => {
    const out = new Float64Array(n);
    for (let r = 0; r < rows; r++) {
      const sr = rows - 1 - r;
      for (let c = 0; c < cols; c++) out[r * cols + c] = src[sr * cols + c];
    }
    return out;
  };

  const rawBaseDepth = detailIsAbove ? mirrorY(above) : below;
  const rawLidDepth = detailIsAbove ? below : mirrorY(above);
  let rawCavityDepthMm = 0;
  for (let i = 0; i < n; i++) {
    if (rawBaseDepth[i] > rawCavityDepthMm) rawCavityDepthMm = rawBaseDepth[i];
    if (opts.moldType === 'clamshell' && rawLidDepth[i] > rawCavityDepthMm) rawCavityDepthMm = rawLidDepth[i];
  }

  // The lid is flipped over to mate, so it is built mirrored in Y relative to
  // the base half and its own features are mirrored with it.
  const baseDepth = applyDraft(rawBaseDepth, grid, opts.draftAngleDeg, opts.draftMode);
  const lidDepth = applyDraft(rawLidDepth, grid, opts.draftAngleDeg, opts.draftMode);
  if (draftBreaksSide(baseDepth, grid) || (opts.moldType === 'clamshell' && draftBreaksSide(lidDepth, grid))) {
    warnings.push(
      `The ${opts.draftAngleDeg}\u00b0 draft widens the cavity out through the mold's side wall; ` +
      'raise the wall margin or lower the draft.'
    );
  }

  let cavityDepthMm = 0;
  for (let i = 0; i < n; i++) {
    if (baseDepth[i] > cavityDepthMm) cavityDepthMm = baseDepth[i];
    if (opts.moldType === 'clamshell' && lidDepth[i] > cavityDepthMm) cavityDepthMm = lidDepth[i];
  }
  if (opts.draftAngleDeg > 0 && cavityDepthMm < rawCavityDepthMm - 0.5) {
    warnings.push(
      `A ${opts.draftAngleDeg}\u00b0 draft angle tapered narrow features enough to reduce peak cavity depth ` +
      `from ${rawCavityDepthMm.toFixed(1)} mm to ${cavityDepthMm.toFixed(1)} mm.`
    );
  }

  const minDraftDeg =
    opts.moldType === 'clamshell'
      ? Math.min(shallowestDraft(baseDepth, grid), shallowestDraft(lidDepth, grid))
      : shallowestDraft(baseDepth, grid);
  // A deep pocket with next to no taper grips the casting all the way round, and
  // no amount of release agent argues with that: it wants a mold that can bend.
  // 3 degrees is what rigid tooling is normally drafted to; below that, on a
  // pocket this deep, the mold has to bend to give the casting up.
  const flexibleMoldAdvised = cavityDepthMm >= 8 && minDraftDeg < 3;

  // Registration pins sit in the flange, with one corner's pin moved along the
  // bottom flange (in X only: it stays in the wall's band, clear of the cavity)
  // so the lid cannot be closed turned round. It was moved by 0.25 mm, the
  // socket's own clearance, and a lid turned 180° seated on all four. Now far
  // enough that a turned lid's pin lands on the flat face a millimetre past
  // the socket's rim, and stands off by the pin's height.
  const pinInsetX = opts.wallMarginMm / 2;
  const pinInsetY = opts.wallMarginMm / 2;
  const pinBaseR = opts.pinDiameterMm / 2;
  const pinTopR = Math.max(0.8, pinBaseR * 0.65);
  const socketRimR = pinBaseR + opts.pinToleranceMm;
  const socketBotR = pinTopR + opts.pinToleranceMm;
  const socketDepth = opts.pinHeightMm + 0.5;
  // As far as the next pin along leaves room for: both sockets and a millimetre between.
  const maxKeyOffsetX = Math.max(0, mw2 * 2 - 2 * pinInsetX - 2 * socketRimR - 1);
  const keyOffsetX = Math.min(maxKeyOffsetX, socketRimR + pinTopR + 1);

  // A block that follows the part: its plan, with the pins on a ring halfway
  // out into the wall (or clear of the cavity by a socket and a millimetre).
  const outlines: MoldOutlines | null = opts.blockShape === 'fit' && activeWasm
    ? moldOutlines(activeWasm, tris, sceneSolidIds, {
        wallMm: opts.wallMarginMm,
        pinRingMm: Math.max(opts.wallMarginMm / 2, socketRimR + 1),
        baseMirrored: detailIsAbove,
        // Draft added at the cavity's foot widens it by depth x tan(angle).
        extraMm: opts.draftMode === 'add' ? rawCavityDepthMm * Math.tan((opts.draftAngleDeg * Math.PI) / 180) : 0,
      })
    : null;
  if (opts.blockShape === 'fit' && !outlines) {
    warnings.push("The part's outline could not be traced (it is not one closed solid), so the block is a box.");
  }

  const pinPositions: Array<[number, number]> = outlines
    ? pinsOnRing(outlines.pinRing, Math.max(5, 2 * socketRimR + 1))
    : [
        [-mw2 + pinInsetX + keyOffsetX, -md2 + pinInsetY],
        [mw2 - pinInsetX, -md2 + pinInsetY],
        [mw2 - pinInsetX, md2 - pinInsetY],
        [-mw2 + pinInsetX, md2 - pinInsetY],
      ];

  const minWallMarginForPins = Math.ceil((opts.pinDiameterMm + 2 * opts.pinToleranceMm + 2) * 10) / 10;
  if (opts.moldType === 'clamshell' && opts.wallMarginMm < minWallMarginForPins) {
    warnings.push(
      `A ${opts.wallMarginMm} mm wall margin is narrower than the ${opts.pinDiameterMm} mm pins and sockets need ` +
      `(${minWallMarginForPins} mm minimum); widen the margin or use smaller pins so the sockets stay inside the flange.`
    );
  }

  // Pry notches sit at the midpoints of the left and right outer edges along the
  // parting seam, clear of all four corner registration pins and the cavity.
  const notchRimR = Math.min(3, Math.max(1.5, opts.wallMarginMm * 0.35));
  const notchPositions: Array<[number, number]> =
    opts.moldType === 'clamshell' && opts.includePryNotches
      ? outlines ? notchesOnOutline(outlines.base) : [[mw2 - 1, 0], [-mw2 + 1, 0]]
      : [];

  const baseFeatures: HalfFeatures = {
    sockets: [
      ...(opts.moldType === 'clamshell'
        ? pinPositions.map(([x, y]) => ({ x, y, rimR: socketRimR, botR: socketBotR, depth: socketDepth }))
        : []),
      ...notchPositions.map(([x, y]) => ({ x, y, rimR: notchRimR, botR: notchRimR * 0.5, depth: 1.5 })),
    ],
    pins: [],
    channels: [],
  };

  const ventDiaMm = ventBoreDiaMm(opts.ventDiaMm, opts.castMaterial);
  const ventR = ventDiaMm / 2;
  const ventMouthR = ventR + VENT_TAPER_MM;
  const pour = placePourChannels(field, grid, ventR, 0, detailIsAbove ? below : above);

  if (opts.moldType === 'open' && opts.includeVents && undercutColumns > 0) {
    const blindVents = placeOpenMoldBlindVents(
      field,
      grid,
      4,
      partingZ,
      detailIsAbove,
      moldWidthMm,
    );
    baseFeatures.topVents = blindVents.map((v) => ({
      x: v.x,
      y: detailIsAbove ? -v.y : v.y,
      r: ventR,
      zRoof: v.zRoof,
    }));
  }

  // `pour` is in the unmirrored `field` frame. When `detailIsAbove` is true,
  // `baseDepth` was mirrored in Y (`mirrorY(above)`) and `lidDepth` (`below`)
  // was NOT mirrored in Y, so on the lid's build grid the part sits at `+y`;
  // when `detailIsAbove` is false, `lidDepth` (`mirrorY(above)`) is at `-y`.
  const lidChannelY = (y: number) => (detailIsAbove ? y : -y);
  const baseTrueDepth = opts.moldType === 'open' ? partHeightMm : (detailIsAbove ? zMax - partingZ : partingZ - zMin);
  const lidTrueDepth = detailIsAbove ? partingZ - zMin : zMax - partingZ;
  // Filled from the bottom, the cavity half's floor holds the runner under the cavity;
  // lined, it holds the runner's own sleeve of liner too, with shell under that.
  const feed = opts.moldType === 'clamshell' && opts.includeSprue ? (opts.sprueFeed ?? defaultSprueFeed(opts.castMaterial ?? 'epoxy')) : 'top';
  const neckR = sprueNeckDiaMm(opts.sprueBottomDiaMm, opts.castMaterial) / 2;
  const linerSkinMm = opts.dissolvableLiner
    ? (opts.linerSkinMm && opts.linerSkinMm > 0 ? opts.linerSkinMm : DEFAULT_LINER_SKIN_MM)
    : 0;
  const baseFloorMm = feed === 'bottom'
    ? Math.max(opts.baseThicknessMm, bottomFillFloorMm(neckR, linerSkinMm))
    : Math.max(opts.baseThicknessMm, linerSkinMm > 0 ? linerSkinMm + 2 : 0);
  const lidFloorMm = Math.max(opts.baseThicknessMm, linerSkinMm > 0 ? linerSkinMm + 2 : 0);
  const baseBlockHeight = baseTrueDepth + baseFloorMm;
  const lidBlockHeight = lidTrueDepth + lidFloorMm;
  // Whatever cuts the lid deepest in each column, drafted or not: the funnel stays clear of all of it.
  const lidCavityDepth = lidDepth.map((d, i) => Math.max(d, rawLidDepth[i]));
  // Unlined, the funnel may sink to near the face where the other half is solid under it.
  const lidFunnelDepth = linerSkinMm > 0 ? lidCavityDepth : funnelClearDepths(lidCavityDepth, mirrorY(baseDepth), grid);

  // The closed mold as it is poured, lid up, in the cavity half's frame: the
  // exact part where undercuts are kept, the depth fields where they are filled.
  const clamshell = opts.moldType === 'clamshell';
  const exactCavity = Boolean(opts.dissolvableLiner) || Boolean(opts.allowUndercuts && undercutColumns > 0);
  const pourSpans = !clamshell ? null : exactCavity
    ? exactPourSpans(
        field,
        grid,
        partingZ,
        detailIsAbove,
        opts.draftAngleDeg > 0 ? baseDepth : undefined,
        opts.draftAngleDeg > 0 ? lidDepth : undefined,
      )
    : rigidPourSpans(baseDepth, lidDepth, grid);

  // A vent at every high point: up from the top of each pocket the rising
  // level would close over, through the cavity half if it is in it, and
  // through the lid (whose y is the cavity half's negated).
  const ventChannels: HalfFeatures['channels'] = [];
  const ventPeaks: Array<{ x: number; y: number }> = [];
  const baseBores: BoreCut[] = [];
  if (pourSpans && opts.includeVents) {
    const peaks = fineness > 1 ? planPeakVents(...everyOtherColumn(pourSpans, grid)) : planPeakVents(pourSpans, grid);
    const bubbleR = castMaterial(opts.castMaterial ?? 'epoxy').bubbleRiseMm / 2;
    for (const v of peaks) {
      // From the top of its pocket out, not on through to the parting face: a
      // bore wider than the feature under it would thicken all of it, as a
      // collar. Far enough inside the pocket to open as wide as air needs.
      const stop = v.z - mouthSinkMm(pourSpans, grid, v, ventR, -1, Math.PI * bubbleR * bubbleR, ventR);
      ventChannels.push({ x: v.x, y: -v.y, outerR: ventMouthR, innerR: ventR, pocketZMm: stop });
      ventPeaks.push({ x: v.x, y: v.y });
      if (exactCavity && v.z < -Math.min(grid.stepX, grid.stepY)) {
        baseBores.push({ a: [v.x, v.y, stop], b: [v.x, v.y, 1], r: ventR });
      }
    }
  }

  // The sprue: down through the lid into the cavity, or from the bottom.
  let sprueChannel: HalfFeatures['channels'][number] | null = null;
  let bottomFill: ReturnType<typeof planBottomFill> = null;
  if (opts.includeSprue && feed === 'bottom' && pourSpans && !opts.includeVents) {
    return {
      ...emptyMoldResult('Filled from the bottom, the mold needs its vents: the air rises to the top and has no other way out. Turn vents on, or fill from the top.'),
      ...setupFields,
    };
  }
  // A lined sprue wears a sleeve of liner inside its wall, and the sealing
  // ridge wants room past that. An insert's sleeve and its holder's pocket are
  // each held on the grid, a half cell's diagonal generous, plus the clearance.
  const sleeveMm = linerSkinMm > 0
    ? linerSkinMm + (opts.linerConstruction === 'insert' ? INSERT_CLEARANCE_MM + Math.hypot(grid.stepX, grid.stepY) : 0)
    : 0;
  const sealMm = linerSkinMm > 0 && clamshell && opts.sealRidge !== false ? SEAL_RING_ROOM_MM : 0;
  // The funnel keeps its sleeve inside the lid's edge. Only an insert carries
  // the funnel's full width down to the seam, where the seal goes round it.
  const funnelWallMm = opts.linerConstruction === 'insert' ? sleeveMm + sealMm : linerSkinMm;
  if (opts.includeSprue && feed === 'bottom' && pourSpans) {
    // With the seal, the ring has to pass between the down-sprue's sleeve and the pins too.
    const avoidAt = (extraMm: number) => baseFeatures.sockets.map((s) => ({ x: s.x, y: s.y, r: s.rimR + extraMm }));
    // Clear of the vents: a funnel that takes in a vent's mouth pours down the
    // vent, from the top, whenever it is full. With room for the whole funnel
    // if there is any; if not the funnel gives way (roomR, below), not the neck.
    const room = opts.blockShape === 'fit' ? opts.wallMarginMm : Infinity;
    const funnelR = Math.max(opts.sprueTopDiaMm / 2, neckR * 2);
    const ventsAt = (r: number) => ventPeaks.map((v) => ({ x: v.x, y: v.y, r }));
    const gateDia = gateDiaMm(opts.castMaterial);
    // Tried with room for the seal (and, in an insert, for the whole funnel's
    // sleeve down to the seam), then with less, then with none.
    const insertFunnelMm = opts.linerConstruction === 'insert' ? funnelR - neckR : 0;
    const ventRoomAt = (x: number, y: number) => Math.min(Infinity, ...ventPeaks.map((v) => Math.hypot(v.x - x, v.y - y) - ventMouthR));
    const funnelFits = (x: number, y: number, roomR: number) =>
      planSprue(x, -y, opts, grid, lidFunnelDepth, lidBlockHeight, Math.min(roomR, ventRoomAt(x, y)), funnelWallMm).outerR >= funnelR - 0.5;
    const tries: Array<{ keep: boolean; edgeMm: number; pinMm: number }> = sealMm > 0
      ? [
          ...(insertFunnelMm > 0 ? [{ keep: true, edgeMm: sleeveMm + sealMm + insertFunnelMm, pinMm: sleeveMm + sealMm + insertFunnelMm }] : []),
          { keep: true, edgeMm: sleeveMm + sealMm, pinMm: sleeveMm + sealMm },
          { keep: false, edgeMm: sleeveMm, pinMm: 0 },
        ]
      : [{ keep: false, edgeMm: sleeveMm, pinMm: 0 }];
    let sealRoomKept = false;
    for (const { keep, edgeMm, pinMm } of tries) {
      const avoid = avoidAt(pinMm);
      bottomFill = planBottomFill(pourSpans, grid, neckR, [...avoid, ...ventsAt(ventMouthR + funnelR - neckR)], room, gateDia, linerSkinMm, edgeMm, funnelFits)
        ?? planBottomFill(pourSpans, grid, neckR, [...avoid, ...ventsAt(ventMouthR)], room, gateDia, linerSkinMm, edgeMm, funnelFits);
      sealRoomKept = keep;
      if (bottomFill) break;
    }
    if (!bottomFill) {
      const need = Math.ceil((neckR + FEED_WALL_MM + feedEdgeMm(neckR, sleeveMm)) * 10) / 10;
      return {
        ...emptyMoldResult(
          `Bottom fill needs ${need} mm of wall beside the cavity for its down-sprue, clear of the pins; widen the wall margin, or fill from the top.`,
        ),
        ...setupFields,
      };
    }
    const { down, gate, runnerZ, r, gateR, gateTopZ } = bottomFill;
    const ventRoomR = ventRoomAt(down.x, down.y);
    // An insert carries the funnel's width down to the seam, so it stops short of the pins by the seal's room as well.
    const pinRoomR = opts.linerConstruction === 'insert' && sealRoomKept
      ? Math.min(Infinity, ...baseFeatures.sockets.map((k) => Math.hypot(k.x - down.x, k.y - down.y) - k.rimR - SEAL_RING_ROOM_MM - sleeveMm - 1))
      : Infinity;
    sprueChannel = planSprue(down.x, -down.y, opts, grid, lidFunnelDepth, lidBlockHeight, Math.min(bottomFill.roomR, ventRoomR, pinRoomR), funnelWallMm);
    baseBores.push(
      // Down the wall from the parting face...
      { a: [down.x, down.y, 1], b: [down.x, down.y, runnerZ], r, fluted: true },
      // ...along under the cavity...
      { a: [down.x, down.y, runnerZ], b: [gate.x, gate.y, runnerZ], r, ends: true },
      // ...and up into its lowest point, in as far as gives it a whole mouth.
      { a: [gate.x, gate.y, runnerZ], b: [gate.x, gate.y, gateTopZ], r: gateR },
    );
  } else if (opts.includeSprue && clamshell) {
    sprueChannel = planSprue(pour.sprue.x, lidChannelY(pour.sprue.y), opts, grid, lidFunnelDepth, lidBlockHeight, Infinity, funnelWallMm);
  }
  // A funnel gives way to fit; a wall that took most of it away is named, lined or not.
  // Unlined, a ⌀16 funnel down to ⌀6 in a 10 mm wall once went by with no word.
  const askedFunnelR = Math.max(opts.sprueTopDiaMm / 2, neckR * 2);
  if (sprueChannel && funnelWallMm <= 0 && askedFunnelR - sprueChannel.outerR > 1) {
    const roomMm = Math.ceil(opts.wallMarginMm + askedFunnelR - sprueChannel.outerR + 1);
    warnings.push(
      `The sprue's funnel is cut to ⌀${(sprueChannel.outerR * 2).toFixed(1)} mm to fit the mold beside the cavity; ` +
      `a ${roomMm} mm wall margin gives it the full ⌀${(askedFunnelR * 2).toFixed(1)} mm.`,
    );
  }
  if (sprueChannel && funnelWallMm > 0) {
    // A lined funnel keeps its sleeve (and an insert's, the seal) inside the edge, and gives way to do it.
    const askedR = askedFunnelR;
    const shortMm = askedR - sprueChannel.outerR;
    if (shortMm > 1) {
      warnings.push(
        `The sprue's funnel is cut to ⌀${(sprueChannel.outerR * 2).toFixed(1)} mm to keep its liner sleeve${opts.linerConstruction === 'insert' ? ' and the seal' : ''} inside the block's edge${opts.linerConstruction === 'insert' ? ' and clear of the pins' : ''}; ` +
        `a wider wall margin gives it the full ⌀${(askedR * 2).toFixed(1)} mm.`,
      );
    }
  }
  if (baseBores.length) baseFeatures.bores = baseBores;
  // A vent under the sprue's own mouth is the sprue: that air goes out up it.
  const clearOfSprue = (v: HalfFeatures['channels'][number]) =>
    !(sprueChannel && feed === 'top' && Math.hypot(v.x - sprueChannel.x, v.y - sprueChannel.y) < sprueChannel.outerR + v.outerR + 1);

  const lidFeatures: HalfFeatures = {
    sockets: [],
    // `pinPositions` are in `base`'s frame, so the lid always mirrors them in Y.
    pins: pinPositions.map(([x, y]) => ({ x, y: -y, baseR: pinBaseR, topR: pinTopR, height: opts.pinHeightMm })),
    channels: [...(sprueChannel ? [sprueChannel] : []), ...ventChannels.filter(clearOfSprue)],
  };

  setupFields.features = describeMoldFeatures(opts, baseFeatures, lidFeatures, notchPositions.length, bottomFill);

  const lidIsBackingPlate = Math.min(volBelow, volAbove) < 1e-6;
  const useExactCsg = Boolean(!opts.dissolvableLiner && opts.allowUndercuts && undercutColumns > 0);
  // A runner along the floor is a tunnel, which a depth field cannot hold.
  if (baseFeatures.bores?.length && !activeWasm) return { ...emptyMoldResult(NO_MANIFOLD_REFUSAL), ...setupFields };
  const effectiveFlexibleAdvised = flexibleMoldAdvised || useExactCsg;
  // Undercuts are kept only by cutting the exact part out of the block; the
  // depth-field mold below would fill them in, so without the engine say so.
  if (useExactCsg && !activeWasm) return { ...emptyMoldResult(NO_MANIFOLD_REFUSAL), ...setupFields };

  // What a rigid mold fills in is shown, not warned about: the pull direction
  // is already the one that loses least, and Simulate Cast lets the user judge
  // the result. Keeping undercuts is an expert's choice, and it does lock a
  // rigid print onto the casting, so that one is said.
  if (useExactCsg) {
    const pct = (100 * undercutColumns) / field.hitColumns;
    const pctText = pct < 1 ? 'Under 1' : pct.toFixed(0);
    warnings.push(
      `${pctText}% of the part has undercuts preserved in the cavity. Print in flexible TPU, cast a silicone negative, or use a sacrificial shell so the casting can release.`
    );
  }

  if (opts.moldType === 'clamshell' && lidIsBackingPlate) {
    warnings.push(
      'Part lies on one side of the parting plane; the lid is a flat backing plate. Switch to a one-part open mold unless a closed top face is needed.'
    );
  }

  const csgFields = {
    setup: setupFields,
    outlines,
    tris,
    solidIds: sceneSolidIds ?? [],
    solidNames: sceneSolidNames ?? [],
    partingZ,
    detailIsAbove,
    moldWidthMm,
    moldDepthMm,
    partHeightMm,
    rawCavityDepthMm,
    opts,
    baseFeatures,
    lidFeatures,
    baseBlockHeight,
    lidBlockHeight,
    mnX,
    mxX,
    mnY,
    mxY,
    mnZ,
    mxZ,
    partWidthMm,
    partDepthMm,
    minDraftDeg,
    lidIsBackingPlate,
    undercutColumns,
    grid,
    rawBaseDepth,
    rawLidDepth,
  };

  if (opts.dissolvableLiner) {
    if (!activeWasm) return { ...emptyMoldResult(NO_MANIFOLD_REFUSAL), ...setupFields };
    const lined = buildLinerMold({
      ...csgFields,
      wasm: activeWasm,
      flexibleMoldAdvised: false,
      warnings: [...warnings],
      field,
      skinMm: opts.linerSkinMm && opts.linerSkinMm > 0 ? opts.linerSkinMm : DEFAULT_LINER_SKIN_MM,
      castMaterial: opts.castMaterial ?? 'epoxy',
      linerPair: opts.linerPair,
      construction: opts.linerConstruction ?? 'combined',
      sealRidge: opts.sealRidge !== false,
    });
    return 'error' in lined ? { ...emptyMoldResult(lined.error), ...setupFields } : lined;
  }

  if (useExactCsg && activeWasm) {
    const csgRes = buildMoldCSG({
      ...csgFields,
      wasm: activeWasm,
      flexibleMoldAdvised: effectiveFlexibleAdvised,
      warnings: [...warnings],
    });
    // Not the depth-field mold instead: it fills in the undercuts that were asked to be kept.
    return 'error' in csgRes ? { ...emptyMoldResult(csgRes.error), ...setupFields } : csgRes;
  }

  // Pins, sockets, sprue and vents are exact, whatever the grid. Without the
  // engine only a top-filled mold gets here, and they are edits to the depths.
  const builtHalf = (depth: Float64Array, floor: number, feats: HalfFeatures, minDepth: number) => {
    const anyCut = feats.sockets.length + feats.pins.length + feats.channels.length + (feats.bores?.length ?? 0) > 0;
    if (activeWasm && anyCut) {
      const bare = buildHalf(grid, depth, floor, feats, minDepth, true);
      const cut = cutHalfTriangles(activeWasm, bare.triangles, feats, bare.blockHeightMm);
      if (cut) return { ...bare, triangles: cut };
      // Bores are tunnels, which the depths cannot hold.
      if (feats.bores?.length) return null;
    }
    return buildHalf(grid, depth, floor, feats, minDepth);
  };
  const builtBase = builtHalf(baseDepth, baseFloorMm, baseFeatures, baseTrueDepth);
  const builtLid = opts.moldType === 'clamshell' ? builtHalf(lidDepth, lidFloorMm, lidFeatures, lidTrueDepth) : null;
  if (!builtBase || (opts.moldType === 'clamshell' && !builtLid)) {
    return { ...emptyMoldResult("The mold half would not close into a solid, so its runner can't be cut; repair the part's mesh and try again."), ...setupFields };
  }
  // Cut to the part's outline when the block follows it.
  const base = outlines && activeWasm ? { ...builtBase, triangles: trimTriangles(activeWasm, builtBase.triangles, outlines.base) } : builtBase;
  const lid = builtLid && outlines && activeWasm ? { ...builtLid, triangles: trimTriangles(activeWasm, builtLid.triangles, outlines.lid) } : builtLid;

  // Both halves print cavity up: flat outer face on the bed, no support needed
  // under the pins, and the detail surface facing the nozzle. A single open mold
  // sits centered at X = 0 on the build plate.
  const plateGapMm = 6;
  const plateOffset = lid ? moldWidthMm / 2 + plateGapMm / 2 : 0;
  const plateBottomTris = toPlate(base.triangles, -plateOffset, base.blockHeightMm);
  const plateTopTris = lid ? toPlate(lid.triangles, plateOffset, lid.blockHeightMm) : [];

  const combinedTriangles = lid ? [...plateBottomTris, ...plateTopTris] : plateBottomTris;

  // Encoded on first read rather than here. Every option change regenerates the
  // mold, and on a relief that is eight megabytes of STL written out and thrown
  // away for a preview that never looks at a byte of it.
  let stlBytes: Uint8Array | null = null;

  const totalWidth = lid ? moldWidthMm * 2 + plateGapMm : moldWidthMm;
  const totalHeight = Math.max(
    base.blockHeightMm + base.pinRiseMm,
    lid ? lid.blockHeightMm + lid.pinRiseMm : 0
  );

  return {
    success: true,
    ...setupFields,
    get binarySTL() {
      if (!stlBytes) stlBytes = exportBinarySTL(combinedTriangles, 'PhysBox 3D Mold Plate');
      return stlBytes;
    },
    partBounds: { minX: mnX, minY: mnY, minZ: mnZ, maxX: mxX, maxY: mxY, maxZ: mxZ },
    moldBounds: {
      minX: -totalWidth / 2,
      minY: -moldDepthMm / 2,
      minZ: 0,
      maxX: totalWidth / 2,
      maxY: moldDepthMm / 2,
      maxZ: totalHeight,
    },
    partWidthMm: Math.round(partWidthMm * 10) / 10,
    partDepthMm: Math.round(partDepthMm * 10) / 10,
    partHeightMm: Math.round(partHeightMm * 10) / 10,
    moldWidthMm: Math.round(moldWidthMm * 10) / 10,
    moldDepthMm: Math.round(moldDepthMm * 10) / 10,
    moldHeightMm: Math.round(totalHeight * 10) / 10,
    totalTriangles: combinedTriangles.length,
    cavityDepthMm: Math.round(cavityDepthMm * 10) / 10,
    minDraftDeg: Math.round(minDraftDeg * 10) / 10,
    flexibleMoldAdvised,
    lidIsBackingPlate,
    bottomHalf: {
      name: 'Cavity Half',
      triangles: plateBottomTris,
      bounds: boundsOf(plateBottomTris),
      widthMm: moldWidthMm,
      depthMm: moldDepthMm,
      heightMm: Math.round((base.blockHeightMm + base.pinRiseMm) * 10) / 10,
      partingZMm: Math.round(base.blockHeightMm * 100) / 100,
      triangleCount: plateBottomTris.length,
    },
    topHalf: lid
      ? {
          name: 'Lid Half (Pins, Sprue & Vents)',
          triangles: plateTopTris,
          bounds: boundsOf(plateTopTris),
          widthMm: moldWidthMm,
          depthMm: moldDepthMm,
          heightMm: Math.round((lid.blockHeightMm + lid.pinRiseMm) * 10) / 10,
          partingZMm: Math.round(lid.blockHeightMm * 100) / 100,
          triangleCount: plateTopTris.length,
        }
      : undefined,
    combinedTriangles,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Crossing the worker boundary
// ---------------------------------------------------------------------------
//
// A mold is a few hundred thousand `Triangle3D` objects, and structured-cloning
// that many small objects out of a worker costs more than generating them did.
// So a worker sends back two things instead: a summary, which is small and plain
// enough to clone, and the halves as flat typed arrays that transfer with no
// copy at all and go straight into a BufferGeometry.

export type MoldHalfSummary = Omit<MoldMeshHalf, 'triangles' | 'liner'>;

export type MoldSummary = Omit<
  MoldExportResult,
  'binarySTL' | 'threeMf' | 'combinedTriangles' | 'bottomHalf' | 'topHalf'
> & {
  bottomHalf: MoldHalfSummary;
  topHalf?: MoldHalfSummary;
  /** What prints as a separate piece, in the STL's triangle order. */
  parts: MoldStlPart[];
};

/** One printed piece of a mold, as a run of the STL's triangles. */
export interface MoldStlPart {
  name: string;
  triangles: number;
  /** The rigid shell (or an unlined half), or the soluble liner. */
  role: 'shell' | 'liner';
  /** What it prints in: 'PLA', 'HIPS'. */
  material: string;
}

/**
 * The STL's triangles cut into the pieces that print: a half, or a lined
 * half's shell and liner. The STL holds them all, and a shell and its liner
 * share every face where they meet, so one mesh of both reads as thousands of
 * non-manifold edges though each piece is closed.
 */
export function moldStlParts(r: Pick<MoldExportResult, 'bottomHalf' | 'topHalf' | 'liner'>): MoldStlPart[] {
  const pair = linerPair(r.liner?.pair);
  const insert = r.liner?.construction === 'insert';
  const of = (h: MoldMeshHalf): MoldStlPart[] => {
    if (!h.liner) return [{ name: h.name, triangles: h.triangles.length, role: 'shell', material: 'PLA' }];
    const pieces = h.liner.pieceTriangles;
    return [
      { name: `${h.name} ${insert ? 'holder' : 'shell'}`, triangles: h.liner.shell.length, role: 'shell', material: pair.shell.name },
      ...(pieces && pieces.length > 1
        ? pieces.map((n, k): MoldStlPart => ({
            name: `${h.name} insert, piece ${k + 1} of ${pieces.length}${k === 0 ? ' (bottom)' : k === pieces.length - 1 ? ' (top)' : ''}`,
            triangles: n,
            role: 'liner',
            material: pair.liner.name,
          }))
        : [{ name: `${h.name} ${insert ? 'insert' : 'liner'}`, triangles: h.liner.liner.length, role: 'liner' as const, material: pair.liner.name }]),
    ];
  };
  return [...of(r.bottomHalf), ...(r.topHalf ? of(r.topHalf) : [])].filter((p) => p.triangles > 0);
}

/** Positions and per-vertex normals, ready for a BufferGeometry. */
export interface MoldHalfBuffers {
  positions: Float32Array;
  normals: Float32Array;
}

export function trianglesToBuffers(tris: Triangle3D[]): MoldHalfBuffers {
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);

  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const n = t.normal ?? computeNormal(t.a, t.b, t.c);
    const o = i * 9;
    for (let v = 0; v < 3; v++) {
      const src = v === 0 ? t.a : v === 1 ? t.b : t.c;
      positions[o + v * 3] = src[0];
      positions[o + v * 3 + 1] = src[1];
      positions[o + v * 3 + 2] = src[2];
      normals[o + v * 3] = n[0];
      normals[o + v * 3 + 1] = n[1];
      normals[o + v * 3 + 2] = n[2];
    }
  }
  return { positions, normals };
}

/**
 * A mold's halves as they are drawn. A lined mold is drawn as its two
 * materials, the shell in the half's own colour and the PVA apart from it;
 * the halves themselves (and so the STL and the cast simulation) hold both.
 */
export function moldPreviewBuffers(r: MoldExportResult): {
  bottom: MoldHalfBuffers;
  top: MoldHalfBuffers | null;
  liner: { bottom: MoldHalfBuffers; top: MoldHalfBuffers | null } | null;
} {
  const shellOf = (h: MoldMeshHalf) => trianglesToBuffers(h.liner ? h.liner.shell : h.triangles);
  return {
    bottom: shellOf(r.bottomHalf),
    top: r.topHalf ? shellOf(r.topHalf) : null,
    liner: r.bottomHalf.liner
      ? {
          bottom: trianglesToBuffers(r.bottomHalf.liner.liner),
          top: r.topHalf?.liner ? trianglesToBuffers(r.topHalf.liner.liner) : null,
        }
      : null,
  };
}

/** Everything about a mold except the geometry itself. */
export function moldSummary(r: MoldExportResult): MoldSummary {
  const half = (h: MoldMeshHalf): MoldHalfSummary => ({
    name: h.name,
    bounds: h.bounds,
    widthMm: h.widthMm,
    depthMm: h.depthMm,
    heightMm: h.heightMm,
    partingZMm: h.partingZMm,
    triangleCount: h.triangleCount,
  });

  return {
    success: r.success,
    moldType: r.moldType,
    pullDirection: r.pullDirection,
    lostFraction: r.lostFraction,
    cavityHoldsTop: r.cavityHoldsTop,
    setupNote: r.setupNote,
    ...(r.features ? { features: r.features } : {}),
    error: r.error,
    warnings: r.warnings,
    partBounds: r.partBounds,
    moldBounds: r.moldBounds,
    partWidthMm: r.partWidthMm,
    partDepthMm: r.partDepthMm,
    partHeightMm: r.partHeightMm,
    moldWidthMm: r.moldWidthMm,
    moldDepthMm: r.moldDepthMm,
    moldHeightMm: r.moldHeightMm,
    totalTriangles: r.totalTriangles,
    cavityDepthMm: r.cavityDepthMm,
    minDraftDeg: r.minDraftDeg,
    flexibleMoldAdvised: r.flexibleMoldAdvised,
    lidIsBackingPlate: r.lidIsBackingPlate,
    bottomHalf: half(r.bottomHalf),
    topHalf: r.topHalf ? half(r.topHalf) : undefined,
    parts: r.success ? moldStlParts(r) : [],
    ...(r.liner ? { liner: r.liner } : {}),
  };
}
