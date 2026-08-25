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

/** Add a tapered frustum / cone pin (positive) pointing in +Z or -Z direction. */
function addTaperedPin(
  triangles: Triangle3D[],
  baseCenter: [number, number, number],
  baseRadius: number,
  topRadius: number,
  height: number,
  segments = 16
) {
  const [cx, cy, cz] = baseCenter;
  const topZ = cz + height;

  const basePoints: [number, number, number][] = [];
  const topPoints: [number, number, number][] = [];

  for (let i = 0; i < segments; i++) {
    const a = (i * 2 * Math.PI) / segments;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    basePoints.push([cx + baseRadius * cos, cy + baseRadius * sin, cz]);
    topPoints.push([cx + topRadius * cos, cy + topRadius * sin, topZ]);
  }

  // Side walls
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    addQuad(triangles, basePoints[i], basePoints[next], topPoints[next], topPoints[i]);
  }

  // Top cap
  for (let i = 1; i < segments - 1; i++) {
    triangles.push({
      a: topPoints[0],
      b: topPoints[i],
      c: topPoints[i + 1],
      normal: [0, 0, height >= 0 ? 1 : -1],
    });
  }
}

/** Add a tapered socket (negative cavity) inset into a planar surface at z = cz. */
function addTaperedSocket(
  triangles: Triangle3D[],
  rimCenter: [number, number, number],
  rimRadius: number,
  bottomRadius: number,
  depth: number,
  segments = 16
) {
  const [cx, cy, cz] = rimCenter;
  const botZ = cz - depth;

  const rimPoints: [number, number, number][] = [];
  const botPoints: [number, number, number][] = [];

  for (let i = 0; i < segments; i++) {
    const a = (i * 2 * Math.PI) / segments;
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    rimPoints.push([cx + rimRadius * cos, cy + rimRadius * sin, cz]);
    botPoints.push([cx + bottomRadius * cos, cy + bottomRadius * sin, botZ]);
  }

  // Inverted side walls facing inward
  for (let i = 0; i < segments; i++) {
    const next = (i + 1) % segments;
    addQuad(triangles, rimPoints[i], botPoints[i], botPoints[next], rimPoints[next]);
  }

  // Bottom cap facing up
  for (let i = 1; i < segments - 1; i++) {
    triangles.push({
      a: botPoints[0],
      b: botPoints[i + 1],
      c: botPoints[i],
      normal: [0, 0, 1],
    });
  }
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
    return {
      success: false,
      binarySTL: new Uint8Array(84),
      partBounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      moldBounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
      partWidthMm: 0,
      partDepthMm: 0,
      partHeightMm: 0,
      moldWidthMm: 0,
      moldDepthMm: 0,
      moldHeightMm: 0,
      totalTriangles: 0,
      bottomHalf: { name: 'bottom', triangles: [], bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }, widthMm: 0, depthMm: 0, heightMm: 0, triangleCount: 0 },
      combinedTriangles: [],
      warnings: ['Scene contains no visible 3D geometry to mold.'],
      error: 'Scene is empty.',
    };
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

  // Center model at origin in XY, parted at midpoint along Z
  const cx = (mnX + mxX) / 2;
  const cy = (mnY + mxY) / 2;
  const cz = (mnZ + mxZ) / 2;

  // Outer mold dimensions
  const moldWidthMm = partWidthMm + 2 * opts.wallMarginMm;
  const moldDepthMm = partDepthMm + 2 * opts.wallMarginMm;

  // Split parting plane: Z = 0
  const zHalf = partHeightMm / 2;
  const bottomBoxHeight = zHalf + opts.baseThicknessMm;
  const topBoxHeight = zHalf + opts.baseThicknessMm;

  // Sample grid resolution for heightmap cavity (0.5 mm default)
  const res = Math.min(1.0, Math.max(0.2, Math.max(partWidthMm, partDepthMm) / 120));
  const cols = Math.max(16, Math.ceil(partWidthMm / res) + 1);
  const rows = Math.max(16, Math.ceil(partDepthMm / res) + 1);

  const stepX = partWidthMm / (cols - 1);
  const stepY = partDepthMm / (rows - 1);

  // Normalized tris in centered mm
  const triCount = sceneTris.length / 9;
  const tris = new Float64Array(sceneTris.length);
  for (let i = 0; i < sceneTris.length; i += 3) {
    tris[i] = sceneTris[i] * 1000 - cx;
    tris[i + 1] = sceneTris[i + 1] * 1000 - cy;
    tris[i + 2] = (sceneTris[i + 2] * 1000 - cz) * zScale;
  }

  // Heightmaps: topZ (highest point above z=0) and botZ (lowest point below z=0)
  const topHeights = new Float32Array(cols * rows).fill(0);
  const botHeights = new Float32Array(cols * rows).fill(0);

  // Raycast vertical columns to extract top and bottom cavity surfaces
  const halfW = partWidthMm / 2;
  const halfD = partDepthMm / 2;

  for (let r = 0; r < rows; r++) {
    const py = -halfD + r * stepY;
    for (let c = 0; c < cols; c++) {
      const px = -halfW + c * stepX;
      let maxHit = 0;
      let minHit = 0;

      for (let t = 0; t < triCount; t++) {
        const i = t * 9;
        const ax = tris[i], ay = tris[i + 1], az = tris[i + 2];
        const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5];
        const cx_ = tris[i + 6], cy_ = tris[i + 7], cz_ = tris[i + 8];

        if (Math.max(ax, bx, cx_) < px || Math.min(ax, bx, cx_) > px) continue;
        if (Math.max(ay, by, cy_) < py || Math.min(ay, by, cy_) > py) continue;

        const v0x = cx_ - ax, v0y = cy_ - ay;
        const v1x = bx - ax, v1y = by - ay;
        const v2x = px - ax, v2y = py - ay;

        const den = v0x * v1y - v1x * v0y;
        if (den === 0) continue;

        const u = (v2x * v1y - v1x * v2y) / den;
        const v = (v0x * v2y - v2x * v0y) / den;
        if (u < 0 || v < 0 || u + v > 1) continue;

        const hitZ = az + u * (cz_ - az) + v * (bz - az);
        if (hitZ > maxHit) maxHit = hitZ;
        if (hitZ < minHit) minHit = hitZ;
      }

      const idx = r * cols + c;
      topHeights[idx] = Math.max(0, maxHit);
      botHeights[idx] = Math.min(0, minHit);
    }
  }

  // --- 1. BUILD BOTTOM HALF MOLD -------------------------------------------
  // Parting plane is at Z = 0 (top face of bottom block).
  // Bottom block floor is at Z = -bottomBoxHeight.
  // The cavity sinks down to botHeights[idx] (which is negative).
  const bottomTris: Triangle3D[] = [];
  const mw2 = moldWidthMm / 2;
  const md2 = moldDepthMm / 2;
  const floorZ = -bottomBoxHeight;

  // A. Outer bottom base (facing -Z)
  addQuad(
    bottomTris,
    [-mw2, -md2, floorZ],
    [mw2, -md2, floorZ],
    [mw2, md2, floorZ],
    [-mw2, md2, floorZ]
  );

  // B. Outer vertical side walls
  // -Y wall
  addQuad(bottomTris, [-mw2, -md2, floorZ], [-mw2, -md2, 0], [mw2, -md2, 0], [mw2, -md2, floorZ]);
  // +Y wall
  addQuad(bottomTris, [mw2, md2, floorZ], [mw2, md2, 0], [-mw2, md2, 0], [-mw2, md2, floorZ]);
  // -X wall
  addQuad(bottomTris, [-mw2, md2, floorZ], [-mw2, md2, 0], [-mw2, -md2, 0], [-mw2, -md2, floorZ]);
  // +X wall
  addQuad(bottomTris, [mw2, -md2, floorZ], [mw2, -md2, 0], [mw2, md2, 0], [mw2, md2, floorZ]);

  // C. Parting border rim (from mold outer perimeter to cavity perimeter at Z=0)
  // -Y rim
  addQuad(bottomTris, [-mw2, -md2, 0], [-halfW, -halfD, 0], [halfW, -halfD, 0], [mw2, -md2, 0]);
  // +Y rim
  addQuad(bottomTris, [halfW, halfD, 0], [-halfW, halfD, 0], [-mw2, md2, 0], [mw2, md2, 0]);
  // -X rim
  addQuad(bottomTris, [-mw2, -md2, 0], [-mw2, md2, 0], [-halfW, halfD, 0], [-halfW, -halfD, 0]);
  // +X rim
  addQuad(bottomTris, [halfW, -halfD, 0], [halfW, halfD, 0], [mw2, md2, 0], [mw2, -md2, 0]);

  // D. Cavity surface grid (facing upward toward parting plane)
  for (let r = 0; r < rows - 1; r++) {
    const y0 = -halfD + r * stepY;
    const y1 = -halfD + (r + 1) * stepY;
    for (let c = 0; c < cols - 1; c++) {
      const x0 = -halfW + c * stepX;
      const x1 = -halfW + (c + 1) * stepX;

      const z00 = botHeights[r * cols + c];
      const z10 = botHeights[r * cols + (c + 1)];
      const z01 = botHeights[(r + 1) * cols + c];
      const z11 = botHeights[(r + 1) * cols + (c + 1)];

      const v00: [number, number, number] = [x0, y0, z00];
      const v10: [number, number, number] = [x1, y0, z10];
      const v01: [number, number, number] = [x0, y1, z01];
      const v11: [number, number, number] = [x1, y1, z11];

      bottomTris.push({ a: v00, b: v10, c: v11, normal: computeNormal(v00, v10, v11) });
      bottomTris.push({ a: v00, b: v11, c: v01, normal: computeNormal(v00, v11, v01) });
    }
  }

  // Registration pin positions on the border flange
  // 4 corners, with corner 0 offset (keyed) by 3mm inward to guarantee 1-way mating
  const pinInsetX = opts.wallMarginMm / 2;
  const pinInsetY = opts.wallMarginMm / 2;
  const pinRadius = opts.pinDiameterMm / 2;
  const pinTopRadius = Math.max(1, pinRadius * 0.65); // Tapered cone
  const socketRimRadius = pinRadius + opts.pinToleranceMm;
  const socketBotRadius = pinTopRadius + opts.pinToleranceMm;
  const socketDepth = opts.pinHeightMm + 0.5; // 0.5mm bottom clearance

  const pinPositions: Array<[number, number]> = [
    [-mw2 + pinInsetX + 2, -md2 + pinInsetY + 2], // Asymmetric key offset
    [mw2 - pinInsetX, -md2 + pinInsetY],
    [mw2 - pinInsetX, md2 - pinInsetY],
    [-mw2 + pinInsetX, md2 - pinInsetY],
  ];

  if (opts.moldType === 'clamshell') {
    // Add female sockets on bottom half rim
    for (const [px, py] of pinPositions) {
      addTaperedSocket(bottomTris, [px, py, 0], socketRimRadius, socketBotRadius, socketDepth);
    }
  }

  // Corner demolding pry slots (45-degree chamfered notches on the parting line)
  if (opts.includePryNotches) {
    const prySize = 3;
    const pryDepth = 1.5;
    // Notch at corner 1 and corner 3
    addTaperedSocket(bottomTris, [mw2 - 1, -md2 + 1, 0], prySize, prySize * 0.5, pryDepth, 8);
    addTaperedSocket(bottomTris, [-mw2 + 1, md2 - 1, 0], prySize, prySize * 0.5, pryDepth, 8);
  }

  // --- 2. BUILD TOP HALF MOLD (For Two-Part Clamshell) ----------------------
  const topTris: Triangle3D[] = [];
  if (opts.moldType === 'clamshell') {
    // Top mold parting plane is at Z = 0 (bottom face of top block).
    // Top block roof is at Z = topBoxHeight.
    // The cavity rises into the block up to topHeights[idx].
    const roofZ = topBoxHeight;

    // A. Outer roof face (facing +Z)
    addQuad(
      topTris,
      [-mw2, md2, roofZ],
      [mw2, md2, roofZ],
      [mw2, -md2, roofZ],
      [-mw2, -md2, roofZ]
    );

    // B. Outer vertical side walls
    // -Y wall
    addQuad(topTris, [-mw2, -md2, 0], [-mw2, -md2, roofZ], [mw2, -md2, roofZ], [mw2, -md2, 0]);
    // +Y wall
    addQuad(topTris, [mw2, md2, 0], [mw2, md2, roofZ], [-mw2, md2, roofZ], [-mw2, md2, 0]);
    // -X wall
    addQuad(topTris, [-mw2, md2, 0], [-mw2, md2, roofZ], [-mw2, -md2, roofZ], [-mw2, -md2, 0]);
    // +X wall
    addQuad(topTris, [mw2, -md2, 0], [mw2, -md2, roofZ], [mw2, md2, roofZ], [mw2, md2, 0]);

    // C. Parting border rim (facing -Z / downward at Z=0)
    // -Y rim
    addQuad(topTris, [-mw2, -md2, 0], [mw2, -md2, 0], [halfW, -halfD, 0], [-halfW, -halfD, 0]);
    // +Y rim
    addQuad(topTris, [mw2, md2, 0], [-mw2, md2, 0], [-halfW, halfD, 0], [halfW, halfD, 0]);
    // -X rim
    addQuad(topTris, [-mw2, md2, 0], [-mw2, -md2, 0], [-halfW, -halfD, 0], [-halfW, halfD, 0]);
    // +X rim
    addQuad(topTris, [mw2, -md2, 0], [mw2, md2, 0], [halfW, halfD, 0], [halfW, -halfD, 0]);

    // D. Cavity surface grid (facing downward toward parting plane)
    for (let r = 0; r < rows - 1; r++) {
      const y0 = -halfD + r * stepY;
      const y1 = -halfD + (r + 1) * stepY;
      for (let c = 0; c < cols - 1; c++) {
        const x0 = -halfW + c * stepX;
        const x1 = -halfW + (c + 1) * stepX;

        const z00 = topHeights[r * cols + c];
        const z10 = topHeights[r * cols + (c + 1)];
        const z01 = topHeights[(r + 1) * cols + c];
        const z11 = topHeights[(r + 1) * cols + (c + 1)];

        const v00: [number, number, number] = [x0, y0, z00];
        const v10: [number, number, number] = [x1, y0, z10];
        const v01: [number, number, number] = [x0, y1, z01];
        const v11: [number, number, number] = [x1, y1, z11];

        // Inverted orientation so normals face inside the cavity (-Z)
        topTris.push({ a: v00, b: v11, c: v10, normal: computeNormal(v00, v11, v10) });
        topTris.push({ a: v00, b: v01, c: v11, normal: computeNormal(v00, v01, v11) });
      }
    }

    // Male alignment pins protruding from parting plane (facing -Z into bottom sockets)
    for (const [px, py] of pinPositions) {
      addTaperedPin(topTris, [px, py, 0], pinRadius, pinTopRadius, -opts.pinHeightMm);
    }

    // Pour Sprue Funnel (tapered tunnel from top roof at Z=roofZ down into cavity)
    if (opts.includeSprue) {
      const sprueTopR = opts.sprueTopDiaMm / 2;
      const sprueBotR = opts.sprueBottomDiaMm / 2;
      // Inset funnel from top roof
      addTaperedSocket(topTris, [0, 0, roofZ], sprueTopR, sprueBotR, roofZ);
    }

    // Air Risers / Vents (bleed holes running from highest cavity points to top roof)
    if (opts.includeVents) {
      const ventR = opts.ventDiaMm / 2;
      const ventOffsets: Array<[number, number]> = [
        [-halfW * 0.6, -halfD * 0.6],
        [halfW * 0.6, halfD * 0.6],
      ];
      for (const [vx, vy] of ventOffsets) {
        addTaperedSocket(topTris, [vx, vy, roofZ], ventR, ventR, roofZ, 8);
      }
    }
  }

  // --- 3. BUILD COMBINED BUILD PLATE ----------------------------------------
  // Lay both halves flat on the build plate (Z=0).
  // Bottom half: flipped so its flat outer base is at Z=0, parting face at Z=bottomBoxHeight.
  // Top half: laid next to it with a 6mm gap, flat outer roof at Z=0.
  const plateGapMm = 6;
  const plateOffset = moldWidthMm / 2 + plateGapMm / 2;

  // Transform bottom half to sit flat on plate at X = -plateOffset
  const plateBottomTris: Triangle3D[] = bottomTris.map((tri) => ({
    a: [tri.a[0] - plateOffset, tri.a[1], tri.a[2] - floorZ],
    b: [tri.b[0] - plateOffset, tri.b[1], tri.b[2] - floorZ],
    c: [tri.c[0] - plateOffset, tri.c[1], tri.c[2] - floorZ],
    normal: tri.normal,
  }));

  const combinedTriangles: Triangle3D[] = [];
  for (let i = 0; i < plateBottomTris.length; i++) {
    combinedTriangles.push(plateBottomTris[i]);
  }

  let plateTopTris: Triangle3D[] = [];
  if (opts.moldType === 'clamshell' && topTris.length > 0) {
    // Transform top half: flip upside down so its flat roof is at Z=0, placed at X = +plateOffset
    plateTopTris = topTris.map((tri) => {
      // Rotate 180 around X (x, -y, -z) and offset Z by roofZ
      const roofZ = topBoxHeight;
      const flip = (v: [number, number, number]): [number, number, number] => [
        v[0] + plateOffset,
        -v[1],
        roofZ - v[2],
      ];
      const fa = flip(tri.a);
      const fb = flip(tri.b);
      const fc = flip(tri.c);
      return {
        a: fa,
        b: fc, // Swap winding on reflection
        c: fb,
        normal: computeNormal(fa, fc, fb),
      };
    });
    for (let i = 0; i < plateTopTris.length; i++) {
      combinedTriangles.push(plateTopTris[i]);
    }
  }

  const binarySTL = exportBinarySTL(combinedTriangles, 'PhysBox 3D Mold Plate');

  const totalWidth = opts.moldType === 'clamshell' ? moldWidthMm * 2 + plateGapMm : moldWidthMm;
  const totalHeight = Math.max(bottomBoxHeight, topBoxHeight);

  return {
    success: true,
    binarySTL,
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
    bottomHalf: {
      name: 'Bottom Half (Cavity)',
      triangles: plateBottomTris,
      bounds: { minX: -moldWidthMm, minY: -md2, minZ: 0, maxX: 0, maxY: md2, maxZ: bottomBoxHeight },
      widthMm: moldWidthMm,
      depthMm: moldDepthMm,
      heightMm: bottomBoxHeight,
      triangleCount: plateBottomTris.length,
    },
    topHalf:
      opts.moldType === 'clamshell'
        ? {
            name: 'Top Half (Core / Lid)',
            triangles: plateTopTris,
            bounds: { minX: 0, minY: -md2, minZ: 0, maxX: moldWidthMm, maxY: md2, maxZ: topBoxHeight },
            widthMm: moldWidthMm,
            depthMm: moldDepthMm,
            heightMm: topBoxHeight,
            triangleCount: plateTopTris.length,
          }
        : undefined,
    combinedTriangles,
    warnings,
  };
}
