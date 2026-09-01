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

export interface MoldOptions {
  /** 'clamshell': two-part interlocking split mold; 'open': one-part open pour mold. */
  moldType: 'clamshell' | 'open';
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
  wallMarginMm: 10,
  baseThicknessMm: 5,
  cavityDepthMm: 0,
  draftAngleDeg: 0,
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
  triangleCount: number;
}

export interface MoldExportResult {
  success: boolean;
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

/** Add a quad as two triangles. */
function addQuad(
  triangles: Triangle3D[],
  v0: [number, number, number],
  v1: [number, number, number],
  v2: [number, number, number],
  v3: [number, number, number]
) {
  triangles.push({ a: v0, b: v1, c: v2, normal: computeNormal(v0, v1, v2) });
  triangles.push({ a: v0, b: v2, c: v3, normal: computeNormal(v0, v2, v3) });
}

// ---------------------------------------------------------------------------
// Column sampling
// ---------------------------------------------------------------------------
//
// Everything below works on vertical columns through the part: for each (x, y)
// on a grid, the lowest and the highest point of the part's surface. A mold half
// is then a block with one of those surfaces sunk into its face, which is what
// makes the whole build a heightfield and lets pins, sockets, sprues and vents
// be written as edits to the same two height arrays.

interface Grid {
  cols: number;
  rows: number;
  stepX: number;
  stepY: number;
  /** Half extents of the mold block the grid spans, so x = -halfW + c * stepX. */
  halfW: number;
  halfD: number;
}

interface ColumnField {
  /** Lowest surface point in the column; only meaningful where hit is 1. */
  minZ: Float64Array;
  /** Highest surface point in the column. */
  maxZ: Float64Array;
  hit: Uint8Array;
  /** Columns whose line enters and leaves the part more than once. */
  undercutColumns: number;
  hitColumns: number;
}

/**
 * Buckets triangles by their XY footprint so a column only tests the handful
 * that can possibly be over it. Without this the sampler is columns x triangles,
 * which on a terrain relief is hundreds of millions of point-in-triangle tests.
 */
function binTriangles(tris: Float64Array, triCount: number, halfW: number, halfD: number, nx: number, ny: number) {
  const bins: number[][] = new Array(nx * ny);
  for (let i = 0; i < bins.length; i++) bins[i] = [];
  const spanX = 2 * halfW || 1;
  const spanY = 2 * halfD || 1;

  for (let t = 0; t < triCount; t++) {
    const i = t * 9;
    const minX = Math.min(tris[i], tris[i + 3], tris[i + 6]);
    const maxX = Math.max(tris[i], tris[i + 3], tris[i + 6]);
    const minY = Math.min(tris[i + 1], tris[i + 4], tris[i + 7]);
    const maxY = Math.max(tris[i + 1], tris[i + 4], tris[i + 7]);

    const c0 = Math.max(0, Math.min(nx - 1, Math.floor(((minX + halfW) / spanX) * nx)));
    const c1 = Math.max(0, Math.min(nx - 1, Math.floor(((maxX + halfW) / spanX) * nx)));
    const r0 = Math.max(0, Math.min(ny - 1, Math.floor(((minY + halfD) / spanY) * ny)));
    const r1 = Math.max(0, Math.min(ny - 1, Math.floor(((maxY + halfD) / spanY) * ny)));

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) bins[r * nx + c].push(i);
    }
  }
  return { bins, nx, ny, spanX, spanY, halfW, halfD };
}

/** Samples the part's lowest and highest surface over every grid column. */
function sampleColumns(
  tris: Float64Array,
  triCount: number,
  grid: Grid,
  partHalfW: number,
  partHalfD: number
): ColumnField {
  const n = grid.cols * grid.rows;
  const minZ = new Float64Array(n);
  const maxZ = new Float64Array(n);
  const hit = new Uint8Array(n);

  const nx = Math.max(1, Math.min(96, Math.round(Math.sqrt(triCount / 4)) || 1));
  const binned = binTriangles(tris, triCount, partHalfW, partHalfD, nx, nx);

  let undercutColumns = 0;
  let hitColumns = 0;
  const eps = 1e-6;

  for (let r = 0; r < grid.rows; r++) {
    const py = -grid.halfD + r * grid.stepY;
    if (py < -partHalfD - eps || py > partHalfD + eps) continue;
    const by = Math.max(0, Math.min(nx - 1, Math.floor(((py + partHalfD) / (2 * partHalfD || 1)) * nx)));

    for (let c = 0; c < grid.cols; c++) {
      const px = -grid.halfW + c * grid.stepX;
      if (px < -partHalfW - eps || px > partHalfW + eps) continue;
      const bx = Math.max(0, Math.min(nx - 1, Math.floor(((px + partHalfW) / (2 * partHalfW || 1)) * nx)));

      const bucket = binned.bins[by * nx + bx];
      let lo = Infinity;
      let hi = -Infinity;
      let crossings = 0;

      for (let k = 0; k < bucket.length; k++) {
        const i = bucket[k];
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bxv = tris[i + 3], byv = tris[i + 4], bz = tris[i + 5];
        const cxv = tris[i + 6], cyv = tris[i + 7], cz = tris[i + 8];

        if (Math.max(ax, bxv, cxv) < px || Math.min(ax, bxv, cxv) > px) continue;
        if (Math.max(ay, byv, cyv) < py || Math.min(ay, byv, cyv) > py) continue;

        const v0x = cxv - ax, v0y = cyv - ay;
        const v1x = bxv - ax, v1y = byv - ay;
        const v2x = px - ax, v2y = py - ay;

        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue;

        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;

        const z = az + u * (cz - az) + v * (bz - az);
        if (z < lo) lo = z;
        if (z > hi) hi = z;
        crossings++;
      }

      if (crossings === 0) continue;
      const idx = r * grid.cols + c;
      minZ[idx] = lo;
      maxZ[idx] = hi;
      hit[idx] = 1;
      hitColumns++;
      // Two crossings is a column that goes in one face and out the other. More
      // than that is an overhang or a hollow, and a heightfield cavity cannot
      // hold it: the mold fills it in solid.
      if (crossings > 2) undercutColumns++;
    }
  }

  return { minZ, maxZ, hit, undercutColumns, hitColumns };
}

/**
 * Picks the parting plane: the height whose cross-section covers the most of the
 * part's footprint, which is the plane the two halves pull apart along with the
 * least material trapped behind an edge. Ties go to the lowest such plane, so a
 * relief or any other flat-backed part parts at its flat back and puts all of
 * its detail in one half rather than being sliced through the middle.
 */
function choosePartingZ(field: ColumnField, zMin: number, zMax: number): number {
  const span = zMax - zMin;
  if (!(span > 1e-9)) return zMin;

  const SAMPLES = 128;
  const eps = span * 1e-6;
  let best = -1;
  let bestZ = zMin;

  const coverageAt = (z: number) => {
    let n = 0;
    for (let i = 0; i < field.hit.length; i++) {
      if (field.hit[i] && field.minZ[i] <= z + eps && field.maxZ[i] >= z - eps) n++;
    }
    return n;
  };

  for (let s = 0; s <= SAMPLES; s++) {
    const z = zMin + (span * s) / SAMPLES;
    const cov = coverageAt(z);
    // Strictly greater, so a run of equally good planes keeps the lowest one.
    if (cov > best * 1.0001) {
      best = cov;
      bestZ = z;
    }
  }
  return bestZ;
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
}

const NO_FEATURES: HalfFeatures = { sockets: [], pins: [], channels: [] };

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
  feats: HalfFeatures = NO_FEATURES
): { triangles: Triangle3D[]; blockHeightMm: number; pinRiseMm: number } {
  const n = grid.cols * grid.rows;

  let maxDepth = 0;
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
    const y = -grid.halfD + r * grid.stepY;
    for (let c = 0; c < grid.cols; c++) {
      const x = -grid.halfW + c * grid.stepX;
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
      cellSolid[r * cellCols + c] =
        solid[i00] && solid[i00 + 1] && solid[i00 + grid.cols] && solid[i00 + grid.cols + 1] ? 1 : 0;
    }
  }

  const triangles: Triangle3D[] = [];
  const isSolidCell = (c: number, r: number) =>
    c >= 0 && r >= 0 && c < cellCols && r < cellRows && cellSolid[r * cellCols + c] === 1;

  for (let r = 0; r < cellRows; r++) {
    const y0 = -grid.halfD + r * grid.stepY;
    const y1 = y0 + grid.stepY;
    for (let c = 0; c < cellCols; c++) {
      if (!isSolidCell(c, r)) continue;
      const x0 = -grid.halfW + c * grid.stepX;
      const x1 = x0 + grid.stepX;

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
    bottomHalf: { name: 'bottom', triangles: [], bounds: zero, widthMm: 0, depthMm: 0, heightMm: 0, triangleCount: 0 },
    combinedTriangles: [],
    warnings: message ? [message] : [],
    error: message,
  };
}

/**
 * Samples a 3D scene graph into a 2-part clamshell or 1-part open casting mold.
 */
export function generateMoldMeshes(
  scene: SceneGraph,
  options: Partial<MoldOptions> = {}
): MoldExportResult {
  const opts: MoldOptions = { ...DEFAULT_MOLD_OPTIONS, ...options };
  const warnings: string[] = [];

  // Extract all world triangles in scene space (metres)
  const { tris: sceneTris, warnings: sceneWarnings } = collectSceneTriangles(scene);
  if (sceneWarnings?.length) warnings.push(...sceneWarnings);

  if (!sceneTris || sceneTris.length === 0) {
    return emptyMoldResult('Scene contains no visible 3D geometry to mold.');
  }

  // Find model bounding box in mm
  let mnX = Infinity, mxX = -Infinity;
  let mnY = Infinity, mxY = -Infinity;
  let mnZ = Infinity, mxZ = -Infinity;

  for (let i = 0; i < sceneTris.length; i += 3) {
    const x = sceneTris[i] * 1000;
    const y = sceneTris[i + 1] * 1000;
    const z = sceneTris[i + 2] * 1000;
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

  const triCount = sceneTris.length / 9;
  const tris = new Float64Array(sceneTris.length);
  for (let i = 0; i < sceneTris.length; i += 3) {
    tris[i] = sceneTris[i] * 1000 - cx;
    tris[i + 1] = sceneTris[i + 1] * 1000 - cy;
    tris[i + 2] = (sceneTris[i + 2] * 1000 - cz) * zScale;
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

  const partingZ = choosePartingZ(field, -partHeightMm / 2, partHeightMm / 2);

  // Cavity depth on each side of the parting plane, as a depth below the face
  // that half presents. Columns the part misses stay flat at the parting plane.
  const n = cols * rows;
  const below = new Float64Array(n);
  const above = new Float64Array(n);
  let volBelow = 0;
  let volAbove = 0;
  for (let i = 0; i < n; i++) {
    if (!field.hit[i]) continue;
    below[i] = Math.max(0, partingZ - field.minZ[i]);
    above[i] = Math.max(0, field.maxZ[i] - partingZ);
    volBelow += below[i];
    volAbove += above[i];
  }

  // The half holding the most of the part is the one that lies on the bench
  // cavity-up; the shallower half becomes the lid, and it is the lid that gets
  // the pour sprue and the vents, so the sprue stub lands on the back of the
  // casting rather than through the middle of its face.
  const detailIsAbove = volAbove > volBelow;
  const mirrorY = (src: Float64Array) => {
    const out = new Float64Array(n);
    for (let r = 0; r < rows; r++) {
      const sr = rows - 1 - r;
      for (let c = 0; c < cols; c++) out[r * cols + c] = src[sr * cols + c];
    }
    return out;
  };

  // The lid is flipped over to mate, so it is built mirrored in Y and its own
  // features are mirrored with it.
  const baseDepth = applyDraft(detailIsAbove ? mirrorY(above) : below, grid, opts.draftAngleDeg);
  const lidDepth = applyDraft(detailIsAbove ? below : mirrorY(above), grid, opts.draftAngleDeg);

  let cavityDepthMm = 0;
  for (let i = 0; i < n; i++) if (baseDepth[i] > cavityDepthMm) cavityDepthMm = baseDepth[i];
  const minDraftDeg = Math.min(shallowestDraft(baseDepth, grid), shallowestDraft(lidDepth, grid));
  // A deep pocket with next to no taper grips the casting all the way round, and
  // no amount of release agent argues with that: it wants a mold that can bend.
  // 3 degrees is what rigid tooling is normally drafted to; below that, on a
  // pocket this deep, the mold has to bend to give the casting up.
  const flexibleMoldAdvised = cavityDepthMm >= 8 && minDraftDeg < 3;

  // Registration pins sit in the flange, with one corner keyed inwards so the
  // halves cannot be closed 180 degrees around.
  const pinInsetX = opts.wallMarginMm / 2;
  const pinInsetY = opts.wallMarginMm / 2;
  const pinBaseR = opts.pinDiameterMm / 2;
  const pinTopR = Math.max(0.8, pinBaseR * 0.65);
  const socketRimR = pinBaseR + opts.pinToleranceMm;
  const socketBotR = pinTopR + opts.pinToleranceMm;
  const socketDepth = opts.pinHeightMm + 0.5;

  const pinPositions: Array<[number, number]> = [
    [-mw2 + pinInsetX + 2, -md2 + pinInsetY + 2],
    [mw2 - pinInsetX, -md2 + pinInsetY],
    [mw2 - pinInsetX, md2 - pinInsetY],
    [-mw2 + pinInsetX, md2 - pinInsetY],
  ];

  if (opts.moldType === 'clamshell' && opts.wallMarginMm < opts.pinDiameterMm + 2) {
    warnings.push(
      `A ${opts.wallMarginMm} mm wall margin is narrower than the ${opts.pinDiameterMm} mm pins need; ` +
      'widen the margin or use smaller pins so the pins stay inside the flange.'
    );
  }

  const notchPositions: Array<[number, number]> =
    opts.moldType === 'clamshell' && opts.includePryNotches
      ? [[mw2 - 1, -md2 + 1], [-mw2 + 1, md2 - 1]]
      : [];

  const baseFeatures: HalfFeatures = {
    sockets: [
      ...(opts.moldType === 'clamshell'
        ? pinPositions.map(([x, y]) => ({ x, y, rimR: socketRimR, botR: socketBotR, depth: socketDepth }))
        : []),
      ...notchPositions.map(([x, y]) => ({ x, y, rimR: 3, botR: 1.5, depth: 1.5 })),
    ],
    pins: [],
    channels: [],
  };

  const lidFeatures: HalfFeatures = {
    sockets: [],
    // Mirrored in Y, because the lid is flipped over to close onto the base.
    pins: pinPositions.map(([x, y]) => ({ x, y: -y, baseR: pinBaseR, topR: pinTopR, height: opts.pinHeightMm })),
    channels: [
      ...(opts.includeSprue
        ? [{ x: 0, y: 0, outerR: opts.sprueTopDiaMm / 2, innerR: Math.min(opts.sprueBottomDiaMm / 2, opts.sprueTopDiaMm / 2 - 0.4) }]
        : []),
      ...(opts.includeVents
        ? [
            { x: -partHalfW * 0.6, y: partHalfD * 0.6, outerR: opts.ventDiaMm * 0.8, innerR: opts.ventDiaMm / 2 },
            { x: partHalfW * 0.6, y: -partHalfD * 0.6, outerR: opts.ventDiaMm * 0.8, innerR: opts.ventDiaMm / 2 },
          ]
        : []),
    ],
  };

  const base = buildHalf(grid, baseDepth, opts.baseThicknessMm, baseFeatures);
  const lid =
    opts.moldType === 'clamshell'
      ? buildHalf(grid, lidDepth, opts.baseThicknessMm, lidFeatures)
      : null;

  // Both halves print cavity up: flat outer face on the bed, no support needed
  // under the pins, and the detail surface facing the nozzle.
  const plateGapMm = 6;
  const plateOffset = moldWidthMm / 2 + plateGapMm / 2;
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

  if (field.undercutColumns > 0) {
    const pct = (100 * field.undercutColumns) / field.hitColumns;
    warnings.push(
      `${pct < 1 ? 'Under 1' : pct.toFixed(0)}% of the part sits behind an overhang or a hollow, which a ` +
      'two-sided mold cannot reach. Those spots come out filled in on the casting.'
    );
  }

  const lidIsBackingPlate = Math.min(volBelow, volAbove) < 1e-6;
  if (opts.moldType === 'clamshell' && lidIsBackingPlate) {
    warnings.push(
      'The whole part lies on one side of the parting plane, so the lid holds none of its shape and ' +
      'comes out as a flat backing plate. Print it only if you want a flat, glossy back on the casting; ' +
      'otherwise switch to the one-part open mold and pour into the cavity half alone.'
    );
  }

  if (flexibleMoldAdvised) {
    warnings.push(
      `The cavity is ${cavityDepthMm.toFixed(1)} mm deep with only ${minDraftDeg.toFixed(1)}\u00b0 of taper on its ` +
      'steepest wall, which a rigid PLA or PETG mold will not let go of. Print it in TPU, or cast a ' +
      'silicone negative off the printed mold and cast into that.'
    );
  }

  return {
    success: true,
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
    triangleCount: h.triangleCount,
  });

  return {
    success: r.success,
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
