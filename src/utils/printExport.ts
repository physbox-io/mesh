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
import { layoutSetsOnBed, mulMat3, poseMatrix, rotatePoints, type Mat3 } from './printPlate';

export type PrintFormat = 'stl' | '3mf';

/** The part of a body in one colour: in a 3MF, one volume on one filament. */
export interface PrintVolume {
  /** Optional display name for this sub-volume (e.g. a lined mold half's shell or liner). */
  name?: string;
  /** World triangles, metres, Z-up: nine numbers a triangle. */
  tris: number[];
  /** Linear rgb per corner where paint varies it, else null. */
  colors: number[] | null;
  /** Linear rgb, as the 3MF writer wants it. */
  colour: [number, number, number];
  /** Optional 1-based filament priority (1 = rigid shell/holder, 2 = soluble liner/insert). */
  filamentOrder?: number;
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
  /**
   * For a section made by Split for Print: the turn from the world to the way
   * it prints. Absent, a part prints the way it stands.
   */
  turn?: Mat3;
  /** For a section: the bed and margin it was split for. */
  cutFor?: { bedMm: [number, number, number]; marginMm: number };
}

export interface PrintExportOptions {
  format: PrintFormat;
  /** Bodies to export, with everything below them. Absent or empty: every body. */
  ids?: string[];
  /** One file per body rather than one file holding them all; a section's stands the way it prints. */
  separate?: boolean;
  /**
   * Lay the parts out on the bed (3MF only, with `bed`): sections made by Split
   * for Print each stood the way they print, as the 3MF button offers to, and
   * every other chosen body as it stands. Default: when any chosen body has a
   * print pose. With `separate`, each body's file is a plate of its own.
   */
  plate?: boolean;
  bed?: { widthMm: number; depthMm: number; heightMm?: number };
  /**
   * Kept clear round the plate's edge, mm. Default: the margin the sections
   * were split with (the least, if they differ), else 5.
   */
  marginMm?: number;
  /** File name without extension. */
  baseName?: string;
  /** Filaments the printer has, for a 3MF's colours: default 5 (an AMS and the external spool). */
  filaments?: number;
  /**
   * A generated mold's printed parts (every holder, shell, insert and insert
   * piece of a simulated mold body), each its own part, rather than leaving the
   * simulation out. They already stand the way they print.
   */
  moldParts?: boolean;
}

export interface PrintExportResult {
  files: { name: string; bytes: Uint8Array }[];
  parts: { id: string; name: string; triangles: number; sizeMm: [number, number, number] }[];
  plated: boolean;
  warnings: string[];
  /** Ids asked for that the scene does not have. */
  missing: string[];
  /**
   * A 3MF's filaments: number, sRGB colour and how many triangles print in
   * it, file by file in order. What to load in which slot.
   */
  filaments?: { extruder: number; hex: string; triangles: number }[][];
}

const linear = (rgba: number[] | undefined): [number, number, number] => {
  const c = new THREE.Color().setRGB(rgba?.[0] ?? 0.8, rgba?.[1] ?? 0.8, rgba?.[2] ?? 0.8, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};

/** One colour at every corner of `length / 3` corners. */
const solid = (length: number, colour: number[]): number[] =>
  Array.from({ length }, (_, i) => colour[i % 3]);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const humanizeSlug = (slug: string): string => {
  const words = slug.replace(/_/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : slug;
};

function moldGeomDisplayName(node: SceneNode, geomName: string): string {
  if (!geomName || geomName === `${node.id}_mesh`) return node.name || node.id;
  const runMatch = geomName.match(new RegExp(`^${escapeRegExp(node.id)}_\\d+_(.+)$`));
  if (runMatch) return humanizeSlug(runMatch[1]);
  return geomName;
}

type MoldPieceRole = 'shell' | 'liner' | 'holder' | 'insert' | 'other';

function classifyMoldPiece(label: string): { role: MoldPieceRole; halfLabel: string } {
  const clean = label.replace(/\s*\((?:PLA|PVA|BVOH|PVB|ABS|ASA|HIPS|PETG)[^)]*\)\s*$/i, '').trim();
  if (/(?:^|[\s_-])insert(?:$|[\s_,-])/i.test(clean)) return { role: 'insert', halfLabel: '' };
  if (/(?:^|[\s_-])holder(?:$|[\s_,-])/i.test(clean)) return { role: 'holder', halfLabel: '' };
  if (/(?:^|[\s_-])shell$/i.test(clean)) {
    return { role: 'shell', halfLabel: clean.replace(/[\s_-]*shell$/i, '').trim() };
  }
  if (/(?:^|[\s_-])liner$/i.test(clean)) {
    return { role: 'liner', halfLabel: clean.replace(/[\s_-]*liner$/i, '').trim() };
  }
  return { role: 'other', halfLabel: '' };
}

function moldPrintableParts(node: SceneNode, bodyMatrix: THREE.Matrix4): PrintPart[] {
  interface MoldPieceEntry {
    geomName: string;
    displayName: string;
    role: MoldPieceRole;
    halfLabel: string;
    halfKey: string;
    tris: number[];
    colors: number[] | null;
    colour: [number, number, number];
    box: { min: number[]; max: number[] };
  }

  const pieces: MoldPieceEntry[] = [];
  for (const geom of resolveCsgGeoms(node, 'render')) {
    if (geom.role === 'collision') continue;
    const frame = getGeomFrame(geom);
    const piece = colouredGeomTriangles(geom, frame.halfLen, new THREE.Matrix4().multiplyMatrices(bodyMatrix, frame.matrix));
    if (!piece || !piece.tris.length) continue;
    const displayName = moldGeomDisplayName(node, geom.name);
    const { role, halfLabel } = classifyMoldPiece(displayName);
    const defaultRgba = role === 'liner' || role === 'insert' ? [0.95, 0.93, 0.82, 1] : [0.86, 0.7, 0.48, 1];
    const colour = linear(geom.rgba ?? defaultRgba);
    const tris = Array.from(piece.tris);
    pieces.push({
      geomName: geom.name,
      displayName,
      role,
      halfLabel,
      halfKey: halfLabel.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''),
      tris,
      colors: piece.colors ? Array.from(piece.colors) : null,
      colour,
      box: bounds(tris),
    });
  }

  const hasCombinedShell = pieces.some((p) => p.role === 'shell');
  const hasCombinedLiner = pieces.some((p) => p.role === 'liner');
  const hasInsertPair = pieces.some((p) => p.role === 'holder') && pieces.some((p) => p.role === 'insert');

  // In `combined` construction, each half's rigid shell and soluble liner print
  // together as one multi-component assembly: keep them co-registered in Z and
  // XY rather than splitting the liner out onto Z = 0.
  if (hasCombinedShell && hasCombinedLiner) {
    const out: PrintPart[] = [];
    const shellEntries: { piece: MoldPieceEntry; part: PrintPart }[] = [];
    const consumed = new Set<number>();

    pieces.forEach((p, idx) => {
      if (p.role !== 'shell') return;
      consumed.add(idx);
      const partName = p.halfLabel || node.name || node.id;
      const part: PrintPart = {
        id: `${node.id}:${p.halfKey || p.geomName}`,
        name: partName,
        tris: [...p.tris],
        volumes: [{
          name: p.displayName,
          tris: p.tris,
          colors: p.colors,
          colour: p.colour,
          filamentOrder: 1,
        }],
      };
      shellEntries.push({ piece: p, part });
      out.push(part);
    });

    const xyOverlap = (a: { min: number[]; max: number[] }, b: { min: number[]; max: number[] }) =>
      Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]) > 1e-5 &&
      Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]) > 1e-5;

    pieces.forEach((p, idx) => {
      if (consumed.has(idx)) return;
      if (p.role === 'liner') {
        const matched =
          (p.halfKey ? shellEntries.find((s) => s.piece.halfKey === p.halfKey) : undefined) ??
          shellEntries.find((s) => xyOverlap(s.piece.box, p.box));
        if (matched) {
          consumed.add(idx);
          matched.part.volumes.push({
            name: p.displayName,
            tris: p.tris,
            colors: p.colors,
            colour: p.colour,
            filamentOrder: 2,
          });
          for (const t of p.tris) matched.part.tris.push(t);
          return;
        }
      }
      consumed.add(idx);
      const filamentOrder = p.role === 'holder' ? 1 : p.role === 'liner' || p.role === 'insert' ? 2 : undefined;
      out.push({
        id: `${node.id}:${p.geomName}`,
        name: p.displayName,
        tris: p.tris,
        volumes: [{
          name: p.displayName,
          tris: p.tris,
          colors: p.colors,
          colour: p.colour,
          ...(filamentOrder !== undefined ? { filamentOrder } : {}),
        }],
      });
    });
    return out;
  }

  // In `insert` construction (or an unlined mold), each holder, insert, insert
  // piece or mold half is its own object on Z = 0, with holder = Extruder 1 and
  // soluble insert = Extruder 2 regardless of triangle counts.
  return pieces.map((p) => {
    const filamentOrder = hasInsertPair
      ? (p.role === 'holder' ? 1 : p.role === 'insert' ? 2 : undefined)
      : undefined;
    return {
      id: `${node.id}:${p.geomName}`,
      name: p.displayName,
      tris: p.tris,
      volumes: [{
        tris: p.tris,
        colors: p.colors,
        colour: p.colour,
        ...(filamentOrder !== undefined ? { filamentOrder } : {}),
      }],
    };
  });
}

/** Every body's printable triangles, one part a body, world-placed. */
export function printableParts(scene: SceneGraph, ids?: string[], moldParts = false): { parts: PrintPart[]; warnings: string[]; missing: string[] } {
  const want = ids?.length ? new Set(ids) : null;
  const found = new Set<string>();
  const parts: PrintPart[] = [];
  const warnings: string[] = [];

  const traverse = (node: SceneNode, parentMatrix: THREE.Matrix4 | undefined, chosen: boolean) => {
    const inside = chosen || !want || want.has(node.id);
    if (want?.has(node.id)) found.add(node.id);
    const bodyMatrix = getNodeWorldTransform(node, parentMatrix);
    if (node.simulation) {
      if (inside && moldParts && node.simulation.kind === 'mold') {
        parts.push(...moldPrintableParts(node, bodyMatrix));
        return;
      }
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
        const part: PrintPart = { id: node.id, name: node.name || node.id, tris: volumes.flatMap((v) => v.tris), volumes };
        if (node.printPose) {
          // The pose is in the body's frame: undo the body's world turn first.
          // Row-major transpose of the rotation is three's column-major read as rows.
          const e = new THREE.Matrix4().extractRotation(bodyMatrix).elements;
          part.turn = mulMat3(poseMatrix(node.printPose), [e[0], e[1], e[2], e[4], e[5], e[6], e[8], e[9], e[10]]);
          if (node.printPose.cutFor) part.cutFor = node.printPose.cutFor;
        }
        parts.push(part);
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

export function exportPrintFiles(scene: SceneGraph, options: PrintExportOptions): PrintExportResult {
  const { parts, warnings, missing } = printableParts(scene, options.ids, options.moldParts);
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
  // would happily lay out itself. Plating only places parts — sections turned
  // the way they print, the rest as they stand — so each part keeps its
  // volumes and paint, and the file holds exactly the parts in `summary`.
  // `separate` still means one file a body: each is then a plate of one.
  const bed = options.bed;
  const plated = options.format === '3mf' && !!bed && options.plate !== false
    && (options.plate === true || parts.some((p) => p.turn));

  // A section was cut to fit inside the margin it was split with; plated with
  // a wider one it can spill onto a plate of its own.
  const cutFor = parts.flatMap((p) => (p.cutFor ? [p.cutFor] : []));
  const margin = options.marginMm ?? (cutFor.length ? Math.min(...cutFor.map((c) => c.marginMm)) : 5);
  if (plated) {
    const differs = (b: number[]) => Math.abs(b[0] - bed!.widthMm) > 1e-6 || Math.abs(b[1] - bed!.depthMm) > 1e-6
      || (bed!.heightMm !== undefined && Math.abs(b[2] - bed!.heightMm) > 1e-6);
    const other = [...new Set(cutFor.filter((c) => differs(c.bedMm)).map((c) => c.bedMm.join(' × ')))];
    if (other.length) {
      const here = [bed!.widthMm, bed!.depthMm, ...(bed!.heightMm !== undefined ? [bed!.heightMm] : [])].join(' × ');
      warnings.push(`Sections were split for a ${other.join(' mm or a ')} mm bed and are plated on a ${here} mm one: split them again for this printer if any does not fit.`);
    }
  }

  const groups = options.separate ? parts.map((p) => [p]) : [parts];
  const filaments: NonNullable<PrintExportResult['filaments']> = [];
  const used = new Map<string, number>();
  const files = groups.map((group) => {
    const mm = plated
      ? layoutSetsOnBed(group.map((p) => p.volumes.map((v) => (p.turn ? rotatePoints(p.turn, v.tris) : v.tris))), bed!, margin).flatMap((p) => p.sets)
      // A file of its own stands a section the way it prints; together, the
      // parts keep their places relative to each other.
      : toBedMm(group.flatMap((p) => p.volumes.map((v) => (options.separate && p.turn ? Array.from(rotatePoints(p.turn, v.tris)) : v.tris))));
    // Names are unique per body but not once lowercased and stripped.
    let name = options.separate ? safeName(group[0].name) : plated ? `${base}_plate` : base;
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
      name: v.name ?? (p.volumes.length > 1 ? `${p.name} ${linearToSrgbHex(v.colour)}` : p.name),
      positions: mm[at++],
      indices: null,
      colors: v.colors,
      baseColor: v.colour,
      ...(v.filamentOrder !== undefined ? { filamentOrder: v.filamentOrder } : {}),
      // A body is one object; its colours are its volumes.
      object: p.id,
      objectName: p.name,
    })));
    const result = exportThreeMf(meshes, { maxExtruders: options.filaments });
    filaments.push(result.palette);
    return { name: `${name}.3mf`, bytes: result.data };
  });
  return { files, parts: summary, plated, warnings, missing, ...(filaments.length ? { filaments } : {}) };
}
