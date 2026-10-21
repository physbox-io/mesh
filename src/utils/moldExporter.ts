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
import { toManifold } from './sculptCut';
import { createSculptMesh } from './sculptMesh';
import { repairMesh } from './meshRepair';
import { sampleColumns, choosePartingZ, type Grid, type ColumnField } from './moldColumns';
import { choosePullDirection, rotateTrianglesForPull, type PullChoice, type PullDirection } from './moldPullDirection';

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
   * Keep 3D overhangs and undercuts inside the mold cavity (for flexible
   * silicone/TPU molds or sacrificial shells) instead of filling them in solid
   * so a rigid mold can release the part.
   */
  allowUndercuts?: boolean;
  /** Base diameter of alignment pins in mm. */
  pinDiameterMm: number;
  /** Height of alignment pins in mm. */
  pinHeightMm: number;
  /** Clearance tolerance between pin and socket in mm (e.g. 0.25 mm for FDM). */
  pinToleranceMm: number;
  /** Whether to include a tapered pour sprue funnel. */
  includeSprue: boolean;
  /** Pour sprue inlet diameter at the top outer face in mm. */
  sprueTopDiaMm: number;
  /** Pour sprue outlet diameter entering the cavity in mm. */
  sprueBottomDiaMm: number;
  /** Whether to include air riser vent channels. */
  includeVents: boolean;
  /** Air vent diameter in mm. */
  ventDiaMm: number;
  /** Whether to include corner pry notches on the parting seam. */
  includePryNotches: boolean;
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
  sprueTopDiaMm: 8,
  sprueBottomDiaMm: 4,
  includeVents: true,
  ventDiaMm: 1.5,
  includePryNotches: true,
};

export interface Triangle3D {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  normal?: [number, number, number];
}

export interface MoldMeshHalf {
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
}

/** Compute face normal of a 3D triangle. */
export function computeNormal(a: [number, number, number], b: [number, number, number], c: [number, number, number]): [number, number, number] {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * Fast IEEE-754 Little-Endian Binary STL generator.
 * Standard format: 80-byte header + 4-byte uint32 triangle count + 50 bytes per triangle.
 */
export function exportBinarySTL(triangles: Triangle3D[], headerText = 'PhysBox 3D Mold Exporter'): Uint8Array {
  const triCount = triangles.length;
  const bufferSize = 80 + 4 + triCount * 50;
  const buffer = new ArrayBuffer(bufferSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 80-byte ASCII header
  const title = headerText.slice(0, 79);
  for (let i = 0; i < title.length; i++) {
    bytes[i] = title.charCodeAt(i);
  }

  // 4-byte little-endian triangle count
  view.setUint32(80, triCount, true);

  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    const tri = triangles[i];
    const norm = tri.normal ?? computeNormal(tri.a, tri.b, tri.c);

    // Normal vector [nx, ny, nz]
    view.setFloat32(offset, norm[0], true);
    view.setFloat32(offset + 4, norm[1], true);
    view.setFloat32(offset + 8, norm[2], true);

    // Vertex A [x, y, z]
    view.setFloat32(offset + 12, tri.a[0], true);
    view.setFloat32(offset + 16, tri.a[1], true);
    view.setFloat32(offset + 20, tri.a[2], true);

    // Vertex B [x, y, z]
    view.setFloat32(offset + 24, tri.b[0], true);
    view.setFloat32(offset + 28, tri.b[1], true);
    view.setFloat32(offset + 32, tri.b[2], true);

    // Vertex C [x, y, z]
    view.setFloat32(offset + 36, tri.c[0], true);
    view.setFloat32(offset + 40, tri.c[1], true);
    view.setFloat32(offset + 44, tri.c[2], true);

    // 2-byte attribute byte count (0)
    view.setUint16(offset + 48, 0, true);

    offset += 50;
  }

  return bytes;
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

/**
 * Tapers the cavity walls so a rigid mold can let go.
 *
 * A cavity is a depth field, and a wall's steepness is that field's gradient, so
 * draft is a slope limit: no column may be deeper than its neighbour by more
 * than one step's worth of the taper. Sweeping the limit forwards and then
 * backwards propagates it across the whole field in two passes, and it only ever
 * makes the cavity shallower -- the taper is cut back into the deep side, which
 * is what leaves the opening the widest part of the pocket.
 *
 * The cost is real and worth stating: a wall loses depth x tan(angle) of lateral
 * detail, so 2 degrees over an 18 mm cavity rounds the top millimetre of every
 * cliff. Set the angle to zero to reproduce the part exactly and demold by hand.
 */
function applyDraft(depth: Float64Array, grid: Grid, draftDeg: number): Float64Array {
  if (!(draftDeg > 0)) return depth;

  const cot = 1 / Math.tan((draftDeg * Math.PI) / 180);
  const wx = grid.stepX * cot;
  const wy = grid.stepY * cot;
  const wd = Math.hypot(grid.stepX, grid.stepY) * cot;
  const d = Float64Array.from(depth);
  const { cols, rows } = grid;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c > 0) d[i] = Math.min(d[i], d[i - 1] + wx);
      if (r > 0) d[i] = Math.min(d[i], d[i - cols] + wy);
      if (r > 0 && c > 0) d[i] = Math.min(d[i], d[i - cols - 1] + wd);
      if (r > 0 && c < cols - 1) d[i] = Math.min(d[i], d[i - cols + 1] + wd);
    }
  }
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c;
      if (c < cols - 1) d[i] = Math.min(d[i], d[i + 1] + wx);
      if (r < rows - 1) d[i] = Math.min(d[i], d[i + cols] + wy);
      if (r < rows - 1 && c < cols - 1) d[i] = Math.min(d[i], d[i + cols + 1] + wd);
      if (r < rows - 1 && c > 0) d[i] = Math.min(d[i], d[i + cols - 1] + wd);
    }
  }
  return d;
}

/** The shallowest taper on any cavity wall, in degrees off the pull direction. */
function shallowestDraft(depth: Float64Array, grid: Grid): number {
  let steepest = 0;
  const { cols, rows } = grid;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (c + 1 < cols) steepest = Math.max(steepest, Math.abs(depth[i + 1] - depth[i]) / grid.stepX);
      if (r + 1 < rows) steepest = Math.max(steepest, Math.abs(depth[i + cols] - depth[i]) / grid.stepY);
    }
  }
  if (steepest <= 1e-9) return 90;
  return (Math.atan(1 / steepest) * 180) / Math.PI;
}

// ---------------------------------------------------------------------------
// One mold half
// ---------------------------------------------------------------------------

interface HalfFeatures {
  /** Tapered sockets sunk into the parting face. */
  sockets: Array<{ x: number; y: number; rimR: number; botR: number; depth: number }>;
  /** Tapered pins standing proud of the parting face. */
  pins: Array<{ x: number; y: number; baseR: number; topR: number; height: number }>;
  /** Channels bored from the outer face through to the cavity. */
  channels: Array<{ x: number; y: number; outerR: number; innerR: number }>;
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
  minBlockDepthMm: number = 0
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

  for (let r = 0; r < grid.rows; r++) {
    const y = ys[r];
    for (let c = 0; c < grid.cols; c++) {
      const x = xs[c];
      const i = r * grid.cols + c;

      let top = -depth[i];

      for (const s of feats.sockets) {
        const d = Math.hypot(x - s.x, y - s.y);
        if (d >= s.rimR) continue;
        const t = d <= s.botR ? 1 : (s.rimR - d) / (s.rimR - s.botR);
        top = Math.min(top, -s.depth * t);
      }

      for (const p of feats.pins) {
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

      let bot = floorZ;
      for (const ch of feats.channels) {
        const d = Math.hypot(x - ch.x, y - ch.y);
        if (d >= ch.outerR) continue;
        // The funnel is wide at the outer face and narrows to innerR where it
        // breaks into the cavity, so the column is void from the outer face up
        // to wherever the cone wall passes it.
        const t = d <= ch.innerR ? 1 : (ch.outerR - d) / (ch.outerR - ch.innerR);
        bot = Math.max(bot, floorZ + (top - floorZ) * t);
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
  return tris.map((t) => ({ a: move(t.a), b: move(t.b), c: move(t.c), normal: t.normal }));
}

function boundsOf(tris: Triangle3D[]) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const t of tris) {
    for (const v of [t.a, t.b, t.c]) {
      if (v[0] < minX) minX = v[0];
      if (v[0] > maxX) maxX = v[0];
      if (v[1] < minY) minY = v[1];
      if (v[1] > maxY) maxY = v[1];
      if (v[2] < minZ) minZ = v[2];
      if (v[2] > maxZ) maxZ = v[2];
    }
  }
  if (tris.length === 0) return { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  return { minX, minY, minZ, maxX, maxY, maxZ };
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

type Mat4Tuple = [
  number, number, number, number,
  number, number, number, number,
  number, number, number, number,
  number, number, number, number
];

function manifoldToTriangles(m: Manifold): Triangle3D[] {
  const mesh = m.getMesh();
  const tris: Triangle3D[] = [];
  const numTris = mesh.triVerts.length / 3;
  const stride = mesh.numProp;
  const p = mesh.vertProperties;
  for (let t = 0; t < numTris; t++) {
    const i0 = mesh.triVerts[t * 3];
    const i1 = mesh.triVerts[t * 3 + 1];
    const i2 = mesh.triVerts[t * 3 + 2];
    if (i0 === i1 || i1 === i2 || i0 === i2) continue;
    const a: [number, number, number] = [p[i0 * stride], p[i0 * stride + 1], p[i0 * stride + 2]];
    const b: [number, number, number] = [p[i1 * stride], p[i1 * stride + 1], p[i1 * stride + 2]];
    const c: [number, number, number] = [p[i2 * stride], p[i2 * stride + 1], p[i2 * stride + 2]];
    if (
      (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) ||
      (b[0] === c[0] && b[1] === c[1] && b[2] === c[2]) ||
      (a[0] === c[0] && a[1] === c[1] && a[2] === c[2])
    ) {
      continue;
    }
    tris.push({ a, b, c, normal: computeNormal(a, b, c) });
  }
  return tris;
}

function buildPartManifold(
  wasm: ManifoldToplevel,
  tris: Float64Array,
  solidIds?: number[]
): Manifold | null {
  const triCount = tris.length / 9;
  if (triCount === 0) return null;

  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const sid = solidIds && solidIds.length === triCount ? solidIds[t] : 0;
    let g = groups.get(sid);
    if (!g) {
      g = [];
      groups.set(sid, g);
    }
    g.push(t);
  }

  let combined: Manifold | null = null;

  for (const triIndices of groups.values()) {
    const vMap = new Map<string, number>();
    const positions: number[] = [];
    const faces: number[] = [];

    for (const t of triIndices) {
      const i = t * 9;
      const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
      const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
      const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8];

      const d1x = bx - ax, d1y = by - ay, d1z = bz - az;
      const d2x = cx - ax, d2y = cy - ay, d2z = cz - az;
      const cpx = d1y * d2z - d1z * d2y;
      const cpy = d1z * d2x - d1x * d2z;
      const cpz = d1x * d2y - d1y * d2x;
      if (cpx * cpx + cpy * cpy + cpz * cpz < 1e-12) continue;

      const ka = `${Math.round(ax * 1000)},${Math.round(ay * 1000)},${Math.round(az * 1000)}`;
      const kb = `${Math.round(bx * 1000)},${Math.round(by * 1000)},${Math.round(bz * 1000)}`;
      const kc = `${Math.round(cx * 1000)},${Math.round(cy * 1000)},${Math.round(cz * 1000)}`;
      if (ka === kb || kb === kc || ka === kc) continue;

      let va = vMap.get(ka);
      if (va === undefined) {
        va = positions.length / 3;
        vMap.set(ka, va);
        positions.push(ax, ay, az);
      }
      let vb = vMap.get(kb);
      if (vb === undefined) {
        vb = positions.length / 3;
        vMap.set(kb, vb);
        positions.push(bx, by, bz);
      }
      let vc = vMap.get(kc);
      if (vc === undefined) {
        vc = positions.length / 3;
        vMap.set(kc, vc);
        positions.push(cx, cy, cz);
      }
      faces.push(va, vb, vc);
    }

    if (faces.length < 3) continue;

    let solidManifold: Manifold | null = null;
    const sculptMesh = createSculptMesh(positions, faces);
    const mRes = toManifold(wasm, sculptMesh);
    if (mRes.ok) {
      solidManifold = mRes.manifold;
    } else {
      const repaired = repairMesh(positions, faces, {
        weldTolerance: 0.02,
        fillHoles: true,
        fixWinding: true,
      });
      if (repaired.faces.length >= 12) {
        const rMesh = createSculptMesh(repaired.positions, repaired.faces);
        const rRes = toManifold(wasm, rMesh);
        if (rRes.ok) {
          solidManifold = rRes.manifold;
        }
      }
      if (!solidManifold) {
        try {
          const direct = new wasm.Manifold(
            new wasm.Mesh({
              numProp: 3,
              vertProperties: Float32Array.from(positions),
              triVerts: Uint32Array.from(faces),
            })
          );
          if (direct.status() === 'NoError') {
            solidManifold = direct;
          } else {
            direct.delete();
          }
        } catch {
          solidManifold = null;
        }
      }
    }

    if (!solidManifold) continue;

    if (!combined) {
      combined = solidManifold;
    } else {
      const next: Manifold = combined.add(solidManifold);
      combined.delete();
      solidManifold.delete();
      combined = next;
    }
  }

  if (combined && combined.status() === 'NoError' && !combined.isEmpty()) {
    return combined;
  }
  combined?.delete();
  return null;
}

interface CsgContext {
  setup: MoldSetupFields;
  wasm: ManifoldToplevel;
  tris: Float64Array;
  solidIds: number[];
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
}

function buildMoldCSG(ctx: CsgContext): MoldExportResult | null {
  const {
    wasm, tris, solidIds, partingZ, detailIsAbove,
    moldWidthMm, moldDepthMm, partHeightMm, rawCavityDepthMm,
    opts, baseFeatures, lidFeatures,
    baseBlockHeight, lidBlockHeight,
    mnX, mxX, mnY, mxY, mnZ, mxZ,
    partWidthMm, partDepthMm,
    minDraftDeg, flexibleMoldAdvised, lidIsBackingPlate,
    warnings,
  } = ctx;

  const rawPartManifold = buildPartManifold(wasm, tris, solidIds);
  if (!rawPartManifold) return null;

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

    const blockHeight = partHeightMm + opts.baseThicknessMm;
    const moldBlock = wasm.Manifold.cube([moldWidthMm, moldDepthMm, blockHeight], false)
      .translate([-mw2, -md2, -blockHeight]);

    // pour_ext: cross section at open face Z = -0.01 extruded Z in [-0.5, +2.0]
    let pour_ext: Manifold | null = null;
    try {
      let slice = partManifold.slice(-0.01);
      if (slice.isEmpty()) {
        slice.delete();
        slice = partManifold.slice(-0.1);
      }
      if (!slice.isEmpty()) {
        pour_ext = wasm.Manifold.extrude(slice, 2.5).translate([0, 0, -0.5]);
      }
      slice.delete();
    } catch {
      pour_ext = null;
    }

    let cutter = partManifold;
    if (pour_ext) {
      cutter = partManifold.add(pour_ext);
      partManifold.delete();
      pour_ext.delete();
    }

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

  const baseBlock = wasm.Manifold.cube([moldWidthMm, moldDepthMm, baseBlockHeight], false)
    .translate([-mw2, -md2, -baseBlockHeight]);

  let carvedBase = baseBlock.subtract(basePart);
  baseBlock.delete();
  basePart.delete();

  for (const s of baseFeatures.sockets) {
    const sock = wasm.Manifold.cylinder(s.depth + 0.5, s.botR, s.rimR, 24, false)
      .translate([s.x, s.y, -s.depth]);
    const next = carvedBase.subtract(sock);
    carvedBase.delete();
    sock.delete();
    carvedBase = next;
  }

  const lidBlock = wasm.Manifold.cube([moldWidthMm, moldDepthMm, lidBlockHeight], false)
    .translate([-mw2, -md2, -lidBlockHeight]);

  let carvedLid = lidBlock.subtract(lidPart);
  lidBlock.delete();
  lidPart.delete();

  for (const p of lidFeatures.pins) {
    const pin = wasm.Manifold.cylinder(p.height + 0.5, p.baseR, p.topR, 24, false)
      .translate([p.x, p.y, -0.5]);
    const next = carvedLid.add(pin);
    carvedLid.delete();
    pin.delete();
    carvedLid = next;
  }

  for (const ch of lidFeatures.channels) {
    const chH = lidBlockHeight + 2;
    const chan = wasm.Manifold.cylinder(chH, ch.outerR, ch.innerR, 24, false)
      .translate([ch.x, ch.y, -lidBlockHeight - 1]);
    const next = carvedLid.subtract(chan);
    carvedLid.delete();
    chan.delete();
    carvedLid = next;
  }

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

// ---------------------------------------------------------------------------
// Mold setup: which mold, opening which way
// ---------------------------------------------------------------------------

type MoldSetupFields = Pick<
  MoldExportResult,
  'moldType' | 'pullDirection' | 'lostFraction' | 'cavityHoldsTop' | 'setupNote'
>;

/**
 * An open mold is one print with nothing to line up, so 'auto' takes it unless
 * a clamshell keeps more of the part than this share of its volume.
 */
const OPEN_MOLD_ALLOWANCE = 0.01;

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
    if (!fixedDirection) return { direction: choice.direction, lost: choice.lostFraction };
    // A clamshell opens both ways at once, so it was only measured on +axes.
    const measured = type === 'open' ? fixedDirection : (`+${fixedDirection[1]}` as PullDirection);
    const c = choice.candidates.find((k) => k.direction === measured);
    return { direction: fixedDirection, lost: c ? c.lostFraction : choice.lostFraction };
  };

  let moldType: 'clamshell' | 'open';
  let direction: PullDirection;
  if (opts.moldType === 'auto') {
    const open = lossOf('open');
    const clam = lossOf('clamshell');
    moldType = open.lost <= clam.lost + OPEN_MOLD_ALLOWANCE ? 'open' : 'clamshell';
    direction = moldType === 'open' ? open.direction : clam.direction;
  } else {
    moldType = opts.moldType;
    direction = fixedDirection ?? lossOf(moldType).direction;
  }

  let note: string | undefined;
  const turned = !fixedDirection && direction !== '+z' && direction !== '-z';
  if (opts.moldType === 'auto' || turned) {
    note =
      moldType === 'open'
        ? turned
          ? `One-part open mold, with the part turned to open ${AXIS_WORDS[direction]}: that way keeps the most of its shape.`
          : 'One-part open mold: this part comes out of one cleanly.'
        : `Two-part mold opening ${AXIS_WORDS[direction]}${turned ? ', the way that keeps the most of the shape' : ''}.`;
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
  const { tris: sceneTris, solidIds: sceneSolidIds, warnings: sceneWarnings } = collectSceneTriangles(scene);
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
  const target = 150;
  const res = Math.min(1.5, Math.max(0.3, Math.max(moldWidthMm, moldDepthMm) / target));
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
  const baseDepth = applyDraft(rawBaseDepth, grid, opts.draftAngleDeg);
  const lidDepth = applyDraft(rawLidDepth, grid, opts.draftAngleDeg);

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

  // Registration pins sit in the flange, with one corner keyed along the bottom
  // flange (shifted in X only, not diagonally into the cavity corner) so the
  // halves cannot be closed 180 degrees around while keeping full Y clearance
  // from the cavity.
  const pinInsetX = opts.wallMarginMm / 2;
  const pinInsetY = opts.wallMarginMm / 2;
  const pinBaseR = opts.pinDiameterMm / 2;
  const pinTopR = Math.max(0.8, pinBaseR * 0.65);
  const socketRimR = pinBaseR + opts.pinToleranceMm;
  const socketBotR = pinTopR + opts.pinToleranceMm;
  const socketDepth = opts.pinHeightMm + 0.5;
  const maxKeyOffsetX = Math.max(0, pinInsetX - socketRimR - 1.5);
  const keyOffsetX = Math.min(maxKeyOffsetX, Math.min(4, Math.max(2, partHalfW * 0.4)));

  const pinPositions: Array<[number, number]> = [
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
      ? [[mw2 - 1, 0], [-mw2 + 1, 0]]
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

  const pour = placePourChannels(
    field,
    grid,
    opts.ventDiaMm / 2,
    opts.includeVents ? 2 : 0,
    detailIsAbove ? below : above,
  );

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
      r: opts.ventDiaMm / 2,
      zRoof: v.zRoof,
    }));
  }

  // `pour` is in the unmirrored `field` frame. When `detailIsAbove` is true,
  // `baseDepth` was mirrored in Y (`mirrorY(above)`) and `lidDepth` (`below`)
  // was NOT mirrored in Y, so on the lid's build grid the part sits at `+y`;
  // when `detailIsAbove` is false, `lidDepth` (`mirrorY(above)`) is at `-y`.
  const lidChannelY = (y: number) => (detailIsAbove ? y : -y);
  const lidFeatures: HalfFeatures = {
    sockets: [],
    // `pinPositions` are in `base`'s frame, so the lid always mirrors them in Y.
    pins: pinPositions.map(([x, y]) => ({ x, y: -y, baseR: pinBaseR, topR: pinTopR, height: opts.pinHeightMm })),
    channels: [
      ...(opts.includeSprue
        ? [{
            x: pour.sprue.x,
            y: lidChannelY(pour.sprue.y),
            outerR: opts.sprueTopDiaMm / 2,
            innerR: Math.min(opts.sprueBottomDiaMm / 2, opts.sprueTopDiaMm / 2 - 0.4),
          }]
        : []),
      ...pour.vents.map((v) => ({
        x: v.x,
        y: lidChannelY(v.y),
        outerR: opts.ventDiaMm * 0.8,
        innerR: opts.ventDiaMm / 2,
      })),
    ],
  };

  const baseTrueDepth = opts.moldType === 'open' ? partHeightMm : (detailIsAbove ? zMax - partingZ : partingZ - zMin);
  const lidTrueDepth = detailIsAbove ? partingZ - zMin : zMax - partingZ;
  const baseBlockHeight = baseTrueDepth + opts.baseThicknessMm;
  const lidBlockHeight = lidTrueDepth + opts.baseThicknessMm;

  const lidIsBackingPlate = Math.min(volBelow, volAbove) < 1e-6;
  const useExactCsg = Boolean(activeWasm && opts.allowUndercuts && undercutColumns > 0);
  const effectiveFlexibleAdvised = flexibleMoldAdvised || useExactCsg;

  // What a rigid mold fills in is shown, not warned about: the pull direction
  // is already the one that loses least, and Simulate Cast lets the user judge
  // the result. Keeping undercuts is an expert's choice, and it does lock a
  // rigid print onto the casting, so that one is said.
  if (useExactCsg) {
    const pct = (100 * undercutColumns) / field.hitColumns;
    const pctText = pct < 1 ? 'Under 1' : pct.toFixed(0);
    warnings.push(
      `${pctText}% of the part sits behind an overhang or undercut. Because undercuts are kept in the cavity, ` +
      'a rigid mold will mechanically lock onto the casting — print in flexible TPU, cast a silicone negative, or use a sacrificial shell.'
    );
  }

  if (opts.moldType === 'clamshell' && lidIsBackingPlate) {
    warnings.push(
      'The whole part lies on one side of the parting plane, so the lid holds none of its shape and ' +
      'comes out as a flat backing plate. Print it only if you want a flat, glossy back on the casting; ' +
      'otherwise switch to the one-part open mold and pour into the cavity half alone.'
    );
  }

  if (useExactCsg && activeWasm) {
    const csgRes = buildMoldCSG({
      setup: setupFields,
      wasm: activeWasm,
      tris,
      solidIds: sceneSolidIds ?? [],
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
      flexibleMoldAdvised: effectiveFlexibleAdvised,
      lidIsBackingPlate,
      undercutColumns,
      warnings: [...warnings],
    });
    if (csgRes) return csgRes;
  }

  const base = buildHalf(grid, baseDepth, opts.baseThicknessMm, baseFeatures, baseTrueDepth);
  const lid =
    opts.moldType === 'clamshell'
      ? buildHalf(grid, lidDepth, opts.baseThicknessMm, lidFeatures, lidTrueDepth)
      : null;

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

export type MoldHalfSummary = Omit<MoldMeshHalf, 'triangles'>;

export type MoldSummary = Omit<
  MoldExportResult,
  'binarySTL' | 'combinedTriangles' | 'bottomHalf' | 'topHalf'
> & {
  bottomHalf: MoldHalfSummary;
  topHalf?: MoldHalfSummary;
};

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
  };
}
