// ---------------------------------------------------------------------------
// A geom's printable triangles with the colours it is drawn in
// ---------------------------------------------------------------------------
//
// The viewport paints on a finer copy of a geom's surface (utils/vertexPaint),
// and a stroke is stored against that copy's vertices. So a painted geom is
// exported as that copy, coloured exactly as the screen mixes it, rather than
// as its plain triangles — a box is twelve of those, and the pips on a die
// would have nowhere to land. Coloured as it will print, not quite as the
// screen mixes it: each vertex is the brush's colour or the body's. A geom with a pattern on its face keeps the
// pattern's triangles and takes each corner's colour from the nearest painted
// vertex.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGeom } from '../types/scene';
import { appendGeomTriangles, texturedSurfaceOf } from './geomSurface';
import { yupVertsToZup } from './laserCutExporter';
import {
  buildPaintGeometry, canvasFromLayer, coarsenPaintedMesh, paintArgsFromSize,
  subdivideMeshForPaintWithTree, writeVertexColors,
} from './vertexPaint';

export interface ColouredTriangles {
  /** World triangles, metres: nine numbers a triangle. */
  tris: number[];
  /** Linear rgb per corner, nine numbers a triangle; null when the geom is one colour. */
  colors: number[] | null;
}

/** The painted surface in the geom's own Z-up frame, with each vertex's linear colour. */
function paintedSurface(geom: SceneGeom, halfLen: number | undefined, coarsen: boolean) {
  if (!geom.paint) return null;
  const dynamicMesh = geom.type === 'mesh' && (geom.dynamic !== false || !geom.vertices?.length);

  let positions: number[];
  let faces: ArrayLike<number>;
  let count: number;
  let colors: Float32Array;

  if (geom.type === 'mesh') {
    // The same surface the brush was given, in utils/vertexPaint and the MCP paint command.
    const raw = dynamicMesh ? (geom.renderVertices ?? geom.vertices) : geom.vertices;
    if (!raw?.length || !geom.faces?.length) return null;
    const sub = subdivideMeshForPaintWithTree(raw, geom.faces, geom.paint.res);
    count = Math.floor(sub.positions.length / 3);
    if (!count || sub.faces.length < 3) return null;

    // A printer lays down one filament or another, so a brush's soft edge is
    // decided at half coverage: the file then shows what will print, and the
    // blend along a mark's edge cannot snap to some other part's filament.
    const canvas = canvasFromLayer(geom.paint, count, geom.paint.res);
    const hard = { ...canvas, data: canvas.data.slice() };
    for (let i = 3; i < hard.data.length; i += 4) hard.data[i] = hard.data[i] >= 0.5 ? 1 : 0;
    colors = new Float32Array(count * 3);
    writeVertexColors(colors, geom.rgba ?? [0.8, 0.8, 0.8, 1], hard);

    // Collapse uniformly coloured regions back to coarse triangles (keeping
    // watertight conforming edges along colour seams) so flat-walled painted or
    // split meshes do not explode to 65k triangles on 3MF export.
    faces = coarsen ? coarsenPaintedMesh(sub, colors) : sub.faces;
    positions = Array.from(sub.positions);
    if (!dynamicMesh) positions = yupVertsToZup(positions);
    return { positions, faces, colors };
  }

  const size = halfLen !== undefined && (geom.type === 'cylinder' || geom.type === 'capsule')
    ? [geom.size?.[0] ?? 0.01, halfLen]
    : geom.size || [];
  const args = paintArgsFromSize(geom.type, size);
  const built = buildPaintGeometry(geom.type, args, geom.paint.res);
  if (!built) return null;
  const position = built.getAttribute('position');
  count = position?.count ?? 0;
  if (!count) { built.dispose(); return null; }
  positions = Array.from(position.array as ArrayLike<number>);
  const index = built.getIndex();
  faces = index ? Array.from(index.array as ArrayLike<number>) : Array.from({ length: count }, (_, i) => i);
  built.dispose();

  if (geom.type === 'ellipsoid') {
    // A unit sphere, scaled by the radii as the renderer does.
    positions = positions.map((v, i) => v * (args[i % 3] ?? 1));
  }
  // Cylinders and capsules are built Y-up; the geom frame is Z-up.
  if (geom.type === 'cylinder' || geom.type === 'capsule') {
    positions = yupVertsToZup(positions);
  }

  // A printer lays down one filament or another, so a brush's soft edge is
  // decided at half coverage: the file then shows what will print, and the
  // blend along a mark's edge cannot snap to some other part's filament.
  const canvas = canvasFromLayer(geom.paint, count, geom.paint.res);
  const hard = { ...canvas, data: canvas.data.slice() };
  for (let i = 3; i < hard.data.length; i += 4) hard.data[i] = hard.data[i] >= 0.5 ? 1 : 0;
  colors = new Float32Array(count * 3);
  writeVertexColors(colors, geom.rgba ?? [0.8, 0.8, 0.8, 1], hard);
  return { positions, faces, colors };
}

function signedVolume(tris: number[]): number {
  let v = 0;
  for (let i = 0; i + 8 < tris.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.slice(i, i + 9);
    v += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return v / 6;
}

/** Swaps every triangle's last two corners, in the positions and colours alike. */
function flip(...arrays: (number[] | null)[]) {
  for (const a of arrays) {
    if (!a) continue;
    for (let i = 0; i + 8 < a.length; i += 9) {
      for (let k = 3; k < 6; k++) [a[i + k], a[i + k + 3]] = [a[i + k + 3], a[i + k]];
    }
  }
}

/** Nearest of `points` (xyz flat) to each query, by a uniform grid. */
function nearestIndex(points: number[], cell: number) {
  const grid = new Map<string, number[]>();
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < points.length / 3; i++) {
    const k = key(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]);
    const list = grid.get(k);
    if (list) list.push(i); else grid.set(k, [i]);
  }
  return (x: number, y: number, z: number): number => {
    const [gx, gy, gz] = [x, y, z].map((v) => Math.floor(v / cell));
    let best = -1;
    let bestD = Infinity;
    // Widen the search ring until something is found and nothing nearer can be outside it.
    for (let r = 0; r < 64; r++) {
      for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) for (let k = -r; k <= r; k++) {
        if (Math.max(Math.abs(i), Math.abs(j), Math.abs(k)) !== r) continue;
        for (const p of grid.get(`${gx + i},${gy + j},${gz + k}`) ?? []) {
          const d = (points[p * 3] - x) ** 2 + (points[p * 3 + 1] - y) ** 2 + (points[p * 3 + 2] - z) ** 2;
          if (d < bestD) { bestD = d; best = p; }
        }
      }
      if (best >= 0 && Math.sqrt(bestD) <= r * cell) break;
    }
    return best;
  };
}

/**
 * The geom's solid triangles placed by `matrix` (body times geom frame), with
 * its paint when it has any (unless `includePaint` is false, e.g. monochrome
 * STL export). Null when the geom has no surface.
 */
export function colouredGeomTriangles(
  geom: SceneGeom,
  halfLen: number | undefined,
  matrix: THREE.Matrix4,
  options?: { includePaint?: boolean },
): ColouredTriangles | null {
  const includePaint = options?.includePaint !== false;
  const textured = texturedSurfaceOf(geom, halfLen);
  const patterned = !!textured && textured.regions.some((r) => r.applied);
  const painted = includePaint ? paintedSurface(geom, halfLen, !patterned) : null;
  const v = new THREE.Vector3();

  const tris: number[] = [];
  let colors: number[] | null = null;
  if (painted && !patterned) {
    colors = [];
    for (let i = 0; i < painted.faces.length; i++) {
      const f = painted.faces[i];
      v.set(painted.positions[f * 3], painted.positions[f * 3 + 1], painted.positions[f * 3 + 2]).applyMatrix4(matrix);
      tris.push(v.x, v.y, v.z);
      colors.push(painted.colors[f * 3], painted.colors[f * 3 + 1], painted.colors[f * 3 + 2]);
    }
  } else {
    if (!appendGeomTriangles(geom, halfLen, matrix, tris)) return null;
    if (painted) {
      const world: number[] = [];
      for (let i = 0; i < painted.positions.length; i += 3) {
        v.set(painted.positions[i], painted.positions[i + 1], painted.positions[i + 2]).applyMatrix4(matrix);
        world.push(v.x, v.y, v.z);
      }
      const box = new THREE.Box3().setFromArray(world);
      const span = box.getSize(new THREE.Vector3()).length() || 1e-3;
      const nearest = nearestIndex(world, span / 40);
      colors = [];
      for (let i = 0; i < tris.length; i += 3) {
        const p = nearest(tris[i], tris[i + 1], tris[i + 2]);
        colors.push(painted.colors[p * 3], painted.colors[p * 3 + 1], painted.colors[p * 3 + 2]);
      }
    }
  }
  if (tris.length < 9) return null;
  // As appendSolidTriangles does: a solid that encloses negative volume is inside out.
  if (signedVolume(tris) < 0) flip(tris, colors);
  return { tris, colors };
}
