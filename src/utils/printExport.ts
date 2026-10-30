// ---------------------------------------------------------------------------
// STL and 3MF from the scene graph, for an agent
// ---------------------------------------------------------------------------
//
// The toolbar's Export STL / Export 3MF (hooks/useMeshExport.tsx) read what the
// viewport draws, which is the right source for a person at the screen and no
// source at all for an MCP command: there is no dialog to answer, and nothing
// says the canvas has drawn the latest edit. This builds the same files from
// the graph instead — the same triangles the slicer, mold and cast exports
// use (collectSceneTriangles' per-geom path: CSG results, patterns on faces,
// bought-in hardware left out) — at true size, in millimetres, Z-up.
//
// One part per body. A body's children are their own parts, so choosing a
// body chooses everything fixed below it, as the inspector's Export STL does.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../types/scene';
import { resolveCsgGeoms } from './csg';
import { getNodeWorldTransform } from './laserCutExporter';
import { uncompiledCsgWarning } from './contourSliceExporter';
import { getGeomFrame } from './laserCutExporter';
import { colouredGeomTriangles } from './printColours';
import { isBoughtIn } from './boughtIn';
import { exportBinarySTL, type Triangle3D } from './moldManifold';
import { exportThreeMf, linearToSrgbHex, type ThreeMfMesh } from './threeMfExporter';
import { layoutOnBed, type PosedPart } from './printPlate';

export type PrintFormat = 'stl' | '3mf';

/** The part of a body in one colour: in a 3MF, one volume on one filament. */
export interface PrintVolume {
  /** World triangles, metres, Z-up: nine numbers a triangle. */
  tris: number[];
  /** Linear rgb per corner where paint varies it, else null. */
  colors: number[] | null;
  /** Linear rgb, as the 3MF writer wants it. */
  colour: [number, number, number];
}

export interface PrintPart {
  id: string;
  name: string;
  /** Every volume's triangles together, for an STL and for measuring. */
  tris: number[];
  /**
   * One per geom colour. A body whose geoms differ in colour, such as a shell
   * round a core in another material, prints each in its own filament.
   */
  volumes: PrintVolume[];
}

export interface PrintExportOptions {
  format: PrintFormat;
  /** Bodies to export, with everything below them. Absent or empty: every body. */
  ids?: string[];
  /** One file per body rather than one file holding them all. */
  separate?: boolean;
  /**
   * Lay sections made by Split for Print out on the bed, each stood the way it
   * prints, as the 3MF button offers to. Default: when any chosen body has a
   * print pose. Only those bodies go on the plate.
   */
  plate?: boolean;
  bed?: { widthMm: number; depthMm: number };
  /** File name without extension. */
  baseName?: string;
}

export interface PrintExportResult {
  files: { name: string; bytes: Uint8Array }[];
  parts: { id: string; name: string; triangles: number; sizeMm: [number, number, number] }[];
  plated: boolean;
  warnings: string[];
  /** Ids asked for that the scene does not have. */
  missing: string[];
}

const linear = (rgba: number[] | undefined): [number, number, number] => {
  const c = new THREE.Color().setRGB(rgba?.[0] ?? 0.8, rgba?.[1] ?? 0.8, rgba?.[2] ?? 0.8, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};

/** One colour at every corner of `length / 3` corners. */
const solid = (length: number, colour: number[]): number[] =>
  Array.from({ length }, (_, i) => colour[i % 3]);

/** Every body's printable triangles, one part a body, world-placed. */
export function printableParts(scene: SceneGraph, ids?: string[]): { parts: PrintPart[]; warnings: string[]; missing: string[] } {
  const want = ids?.length ? new Set(ids) : null;
  const found = new Set<string>();
  const parts: PrintPart[] = [];
  const warnings: string[] = [];

  const traverse = (node: SceneNode, parentMatrix: THREE.Matrix4 | undefined, chosen: boolean) => {
    const inside = chosen || !want || want.has(node.id);
    if (want?.has(node.id)) found.add(node.id);
    const bodyMatrix = getNodeWorldTransform(node, parentMatrix);
    if (node.simulation) {
      if (inside) warnings.push(`${node.name || node.id}: a simulated cut, so it is left out.`);
      return;
    }
    if (inside && !isBoughtIn(node)) {
      const uncompiled = uncompiledCsgWarning(node);
      if (uncompiled) warnings.push(uncompiled);
      const byColour = new Map<string, PrintVolume>();
      for (const geom of resolveCsgGeoms(node, 'render')) {
        if (geom.role === 'collision') continue;
        const frame = getGeomFrame(geom);
        const piece = colouredGeomTriangles(geom, frame.halfLen, new THREE.Matrix4().multiplyMatrices(bodyMatrix, frame.matrix));
        if (!piece) continue;
        const colour = linear(geom.rgba);
        const key = colour.map((c) => c.toFixed(4)).join(',');
        const volume = byColour.get(key) ?? { tris: [], colors: null, colour };
        // Corner colours for the whole volume once any piece of it is painted.
        if (piece.colors && !volume.colors) volume.colors = solid(volume.tris.length, colour);
        if (volume.colors) for (const c of piece.colors ?? solid(piece.tris.length, colour)) volume.colors.push(c);
        for (const t of piece.tris) volume.tris.push(t);
        byColour.set(key, volume);
      }
      const volumes = [...byColour.values()];
      if (volumes.length) {
        parts.push({ id: node.id, name: node.name || node.id, tris: volumes.flatMap((v) => v.tris), volumes });
      }
    }
    for (const child of node.children || []) traverse(child, bodyMatrix, inside);
  };
  for (const root of scene.nodes) traverse(root, undefined, false);

  const missing = want ? [...want].filter((id) => !found.has(id)) : [];
  return { parts, warnings, missing };
}

function bounds(tris: ArrayLike<number>): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = tris[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/**
 * Millimetres, moved so the set sits on z = 0 centred on the origin — where a
 * slicer puts a part anyway, and the scene's own placement (a body floating
 * 40 mm up) means nothing to a printer. Parts in one file keep their places
 * relative to each other.
 */
function toBedMm(sets: number[][]): Float32Array[] {
  const all = bounds(sets.flat());
  const shift = [-(all.min[0] + all.max[0]) / 2, -(all.min[1] + all.max[1]) / 2, -all.min[2]];
  return sets.map((tris) => {
    const out = new Float32Array(tris.length);
    for (let i = 0; i < tris.length; i++) out[i] = (tris[i] + shift[i % 3]) * 1000;
    return out;
  });
}

function stlBytes(mm: Float32Array, name: string): Uint8Array {
  const triangles: Triangle3D[] = [];
  for (let i = 0; i + 8 < mm.length; i += 9) {
    triangles.push({ a: [mm[i], mm[i + 1], mm[i + 2]], b: [mm[i + 3], mm[i + 4], mm[i + 5]], c: [mm[i + 6], mm[i + 7], mm[i + 8]] });
  }
  return exportBinarySTL(triangles, `PhysBox ${name}`.slice(0, 78));
}

const safeName = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'part';

/** Posed sections on the bed, for a 3MF; null when none of the parts has a pose. */
function platedMeshes(scene: SceneGraph, parts: PrintPart[], bed: { widthMm: number; depthMm: number }): ThreeMfMesh[] | null {
  const chosen = new Set(parts.map((p) => p.id));
  const posed: PosedPart[] = [];
  const walk = (nodes: SceneNode[]) => {
    for (const n of nodes) {
      const mesh = chosen.has(n.id) && n.printPose
        ? (n.geoms || []).find((g) => g.type === 'mesh' && g.role !== 'collision' && g.renderVertices?.length && g.faces?.length)
        : undefined;
      if (mesh) {
        posed.push({ name: n.name || n.id, positions: mesh.renderVertices!, faces: mesh.faces!, pose: n.printPose!, colour: linear(mesh.rgba) });
      }
      walk(n.children || []);
    }
  };
  walk(scene.nodes);
  if (!posed.length) return null;
  return layoutOnBed(posed, bed).map((p) => ({ name: p.name, positions: p.positions, indices: p.indices, colors: null, baseColor: p.colour }));
}

export function exportPrintFiles(scene: SceneGraph, options: PrintExportOptions): PrintExportResult {
  const { parts, warnings, missing } = printableParts(scene, options.ids);
  const base = safeName(options.baseName ?? 'model');
  const summary = parts.map((p) => {
    const b = bounds(p.tris);
    return {
      id: p.id,
      name: p.name,
      triangles: p.tris.length / 9,
      sizeMm: [0, 1, 2].map((k) => +((b.max[k] - b.min[k]) * 1000).toFixed(2)) as [number, number, number],
    };
  });
  if (!parts.length) return { files: [], parts: summary, plated: false, warnings, missing };

  // The plate is a 3MF thing: an STL has no way to say "these are separate
  // objects on one bed" beyond being one file of shells, which a slicer
  // would happily lay out itself.
  if (options.format === '3mf' && options.plate !== false && options.bed) {
    const plated = platedMeshes(scene, parts, options.bed);
    if (plated) {
      const result = exportThreeMf(plated);
      return { files: [{ name: `${base}_plate.3mf`, bytes: result.data }], parts: summary, plated: true, warnings, missing };
    }
  }

  const groups = options.separate ? parts.map((p) => [p]) : [parts];
  const used = new Map<string, number>();
  const files = groups.map((group) => {
    const mm = toBedMm(group.flatMap((p) => p.volumes.map((v) => v.tris)));
    // Names are unique per body but not once lowercased and stripped.
    let name = options.separate ? safeName(group[0].name) : base;
    const seen = used.get(name) ?? 0;
    used.set(name, seen + 1);
    if (seen) name = `${name}_${seen + 1}`;
    if (options.format === 'stl') {
      // One shell list per file; STL has no objects, so a whole group is one soup.
      // (Every volume, every part: colour is the one thing an STL cannot say.)
      const joined = new Float32Array(mm.reduce((n, a) => n + a.length, 0));
      let at = 0;
      for (const a of mm) { joined.set(a, at); at += a.length; }
      return { name: `${name}.stl`, bytes: stlBytes(joined, name) };
    }
    let at = 0;
    const meshes: ThreeMfMesh[] = group.flatMap((p) => p.volumes.map((v) => ({
      name: p.volumes.length > 1 ? `${p.name} ${linearToSrgbHex(v.colour)}` : p.name,
      positions: mm[at++],
      indices: null,
      colors: v.colors,
      baseColor: v.colour,
      // A body is one object; its colours are its volumes.
      object: p.id,
    })));
    const result = exportThreeMf(meshes);
    return { name: `${name}.3mf`, bytes: result.data };
  });
  return { files, parts: summary, plated: false, warnings, missing };
}
