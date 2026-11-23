// ---------------------------------------------------------------------------
// 3MF export, with colour
// ---------------------------------------------------------------------------
//
// STL cannot carry colour. The two conventions that pretend otherwise both
// smuggle 15 bits into the per-facet attribute field, disagree with each other,
// and are ignored by most slicers — so a painted die exports as a grey die.
// 3MF is the format that actually carries it, and it is the one printers read.
//
// This writes colour twice, for two different readers, on the same triangles:
//
//  1. A `<m:colorgroup>` with one colour index per triangle CORNER. That is the
//     spec's own per-vertex colour, interpolated across the face, and it is what
//     a viewer, Blender, or any 3MF-aware CAD tool will show. It is as faithful
//     as the screen.
//
//  2. A `paint_color` attribute per triangle, the vendor convention Orca,
//     Bambu Studio and PrusaSlicer use for multi-material painting. A slicer
//     cannot print a gradient; it prints a triangle in one filament or another.
//     So the triangles are clustered into a handful of colours, each becoming an
//     extruder slot, and each triangle is stamped with the slot it belongs to.
//
// The two do not fight: a reader that does not know `paint_color` ignores the
// attribute, and a reader that does not know the material extension still gets
// the mesh. Nothing here is required to open the file.
//
// Honest limits, both worth knowing before trusting a print:
//  - `paint_color`'s encoding is a vendor format, not a spec. What is written
//    here is the whole-triangle case (see encodeTriangleState), checked
//    against Bambu/Orca's source, not yet against a file opened in a slicer.
//
// Each mesh is also a volume with its own filament, named in Bambu's and
// PrusaSlicer's config files, so a part made of several materials (a mesh's
// `object` key) prints each in its own; paint is stamped only where it
// differs from the volume's filament.
//  - A slicer's painting has at most a handful of filaments; anything past
//    `maxExtruders` is snapped to the nearest colour that fits.
// ---------------------------------------------------------------------------

import { zipStore, utf8, type ZipEntry } from './zipStore';
import { footprintGroups } from './footprintGroups';

const CORE_NS = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const MATERIAL_NS = 'http://schemas.microsoft.com/3dmanufacturing/material/2015/02';
/** PrusaSlicer's namespace, for the sibling attribute its own painting uses. */
const SLIC3R_NS = 'http://schemas.slic3r.org/3mf/2017/06';
const MODEL_REL = 'http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel';

/** One mesh to write, already in millimetres and Z-up. */
export interface ThreeMfMesh {
  name: string;
  /** x,y,z per vertex, in millimetres. */
  positions: ArrayLike<number>;
  /** Triangle indices, or null for a non-indexed mesh (every three positions is a face). */
  indices: ArrayLike<number> | null;
  /** Linear rgb per vertex, or null to use baseColor throughout. */
  colors: ArrayLike<number> | null;
  /** Linear rgb of the body itself, used where there are no vertex colours. */
  baseColor: number[];
  /**
   * Meshes with the same key are one printed object, each mesh a volume of
   * it printed in the filament its baseColor falls in: a part whose inside is
   * a different material from its outside. Absent: an object of its own,
   * unless it overlaps another on the bed (see printedObjects).
   */
  object?: string;
  /**
   * What the object is called in the file and in the slicer's list, where
   * `object` is only a key: a split section was listed by its node id,
   * "split_qvoc0s1n", where its part said "beam_part2". Absent: `object`.
   */
  objectName?: string;
  /**
   * Optional 1-based filament slot order for material-paired tooling (such as a
   * mold's rigid shell/holder = 1 and soluble liner/insert = 2) so corner counts
   * never swap which material lands on which extruder.
   */
  filamentOrder?: number;
}

export interface ThreeMfOptions {
  /**
   * How many filaments the target machine has.
   *
   * Five by default: an AMS and the external spool. Two AMS and the spool is
   * nine; the encoding goes to 32 (see encodeTriangleState). The cap is what
   * keeps the blends along a brushed mark's soft edge from each taking a
   * filament, so more is not free.
   */
  maxExtruders?: number;
  application?: string;
}

export interface ThreeMfPaletteEntry {
  /** sRGB hex, as written into the file. */
  hex: string;
  /** 1-based filament slot. Slot 1 is the unpainted body colour. */
  extruder: number;
  /** How many triangles ended up in this slot. */
  triangles: number;
}

export interface ThreeMfResult {
  data: Uint8Array;
  palette: ThreeMfPaletteEntry[];
  triangles: number;
}

/** Linear 0..1 to the sRGB byte a colour is written as. */
function linearToSrgbByte(value: number): number {
  const c = Math.min(1, Math.max(0, value));
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

function rgbToSrgbPacked(r: number, g: number, b: number): number {
  return (linearToSrgbByte(r) << 16) | (linearToSrgbByte(g) << 8) | linearToSrgbByte(b);
}

function srgbPackedToHex(packed: number): string {
  return `#${packed.toString(16).padStart(6, '0')}`;
}

export function linearToSrgbHex(rgb: number[]): string {
  return srgbPackedToHex(rgbToSrgbPacked(rgb[0] ?? 0, rgb[1] ?? 0, rgb[2] ?? 0));
}

/**
 * The `paint_color` value for a triangle painted entirely in one filament,
 * given that filament's 1-based number.
 *
 * The slicers encode a triangle's painting as a subdivision tree serialised
 * into hex nibbles, written last nibble first: the low bits say whether the
 * triangle is split, the rest carry the state, and a split triangle recurses.
 * The state of an unsplit triangle IS the filament number (Bambu Studio's and
 * OrcaSlicer's EnforcerBlockerType: Extruder1 = 1). Filaments 1 and 2 fit in
 * one nibble, `state << 2`; from 3 the nibble is 0b1100 and the next holds
 * state - 3, and from 18 that one is 0b1111 and a third holds state - 18. This
 * reproduces Bambu's own table (CONST_FILAMENTS in Model.cpp): "4", "8", "0C",
 * "1C" ... "EC", "0FC" ...
 *
 * Only the unsplit case is written, which is right for what this app
 * produces: the painted surface is tessellated finely enough that a mark's
 * boundary falls between triangles rather than across one. Returns null for 0,
 * "not painted", which prints in the volume's own filament.
 */
export function encodeTriangleState(extruder: number): string | null {
  if (!Number.isInteger(extruder) || extruder <= 0) return null;
  if (extruder <= 2) return ((extruder << 2) >>> 0).toString(16).toUpperCase();
  const hex = (n: number) => n.toString(16).toUpperCase();
  if (extruder <= 17) return `${hex(extruder - 3)}C`;
  if (extruder <= 32) return `${hex(extruder - 18)}FC`;
  return null;
}

// eslint-disable-next-line no-control-regex
const XML_ILLEGAL_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

const xmlEscape = (text: string) =>
  text
    .replace(XML_ILLEGAL_CONTROL_RE, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Quantises a coordinate to 0.1 µm (4 decimal places in mm), normalising -0 to 0. */
const quantizeCoord = (value: number): number => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? 0 : rounded;
};

/**
 * Streams XML fragments into UTF-8 byte chunks so dense sculpts never hit V8's
 * single-string length limit or allocate a 100+ MB intermediate UTF-16 string.
 */
class XmlByteBuilder {
  private chunks: Uint8Array[] = [];
  private buf: string[] = [];
  private bufLen = 0;
  private totalBytes = 0;
  private static readonly FLUSH_CHARS = 1 << 18;

  push(text: string): void {
    if (!text) return;
    this.buf.push(text);
    this.bufLen += text.length;
    if (this.bufLen >= XmlByteBuilder.FLUSH_CHARS) this.flush();
  }

  private flush(): void {
    if (this.buf.length === 0) return;
    const encoded = utf8(this.buf.join(''));
    this.chunks.push(encoded);
    this.totalBytes += encoded.byteLength;
    this.buf.length = 0;
    this.bufLen = 0;
  }

  toChunks(): Uint8Array[] {
    this.flush();
    return this.chunks;
  }

  get byteLength(): number {
    this.flush();
    return this.totalBytes;
  }
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

interface TriangleColor { r: number; g: number; b: number; }

/** 4 bits a channel packed into an integer: two colours this close are one filament. */
const colourKey3 = (r: number, g: number, b: number): number =>
  (Math.round(Math.fround(r) * 15) << 8) |
  (Math.round(Math.fround(g) * 15) << 4) |
  Math.round(Math.fround(b) * 15);

/** 4 bits a channel: two colours this close are one filament. */
const colourKey = (c: number[]) => colourKey3(c[0] ?? 0, c[1] ?? 0, c[2] ?? 0);

/**
 * Reduces every triangle in the export to a handful of filament colours.
 *
 * Frequency-first: the colour the most corners are, is the body colour, and
 * it becomes filament 1 — so an unpainted body needs no painting at all and a
 * die with pips needs one extra filament rather than two. Everything else snaps
 * to the nearest slot that fits.
 *
 * Counted over triangle CORNERS, not triangles. A triangle straddling a mark's
 * edge averages to a blend of the two colours either side, and the blends were
 * common enough that red letters on a grey plate took four filaments: grey,
 * red, and two shades of pink along the outline. A corner is a colour that was
 * actually laid down; the triangle is then given whichever slot is nearest its
 * average.
 */
function buildPalette(
  cornerColorArrays: Float32Array[],
  maxExtruders: number,
  required: number[][] = [],
  outerFirst: number[][] = [],
) {
  const buckets = new Map<number, { key: number; color: TriangleColor; count: number; order: number }>();
  let nextOrder = 0;
  for (const arr of cornerColorArrays) {
    for (let i = 0; i + 2 < arr.length; i += 3) {
      const r = arr[i], g = arr[i + 1], b = arr[i + 2];
      // Quantised to 4 bits a channel before counting, so the soft edge of a
      // brushed mark does not register as a hundred distinct colours.
      const key = colourKey3(r, g, b);
      const bucket = buckets.get(key);
      if (bucket) bucket.count++;
      else buckets.set(key, { key, color: { r, g, b }, count: 1, order: nextOrder++ });
    }
  }

  // Seed any required volume colour that has not yet appeared in corner buckets
  // so an explicit volume material is never silently dropped.
  const must = new Set<number>();
  for (const c of required) {
    const key = colourKey(c);
    must.add(key);
    if (!buckets.has(key)) {
      buckets.set(key, {
        key,
        color: { r: c[0] ?? 0, g: c[1] ?? 0, b: c[2] ?? 0 },
        count: 0,
        order: nextOrder++,
      });
    }
  }

  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count || a.order - b.order);
  // Volumes nested in one object (or material-paired mold parts) have a fixed
  // extruder order: shell/holder is filament 1 and soluble liner/insert is
  // filament 2, however fine the liner mesh is.
  const outerRank = new Map<number, number>();
  for (const c of outerFirst) {
    const k = colourKey(c);
    if (!outerRank.has(k)) outerRank.set(k, outerRank.size);
  }
  const rank = (b: { key: number }) => outerRank.get(b.key) ?? outerRank.size;
  // A volume's own colour is a material chosen on purpose, so it keeps a slot
  // ahead of a paint colour however few corners it has.
  const kept = ranked
    .filter((b) => must.has(b.key))
    .sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.order - b.order);
  const rest = ranked.filter((b) => !must.has(b.key));
  const room = Math.max(1, maxExtruders);
  const chosen = [...kept.slice(0, room), ...rest.slice(0, Math.max(0, room - kept.length))];
  const slots = chosen
    .sort((a, b) => rank(a) - rank(b) || b.count - a.count || a.order - b.order)
    .map((b) => b.color);

  const assignRgb = (r: number, g: number, b: number) => {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const dr = s.r - r, dg = s.g - g, db = s.b - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return best;
  };

  return { slots, assignRgb };
}

function meshBounds(positions: ArrayLike<number>): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < min[k]) min[k] = v;
      if (v > max[k]) max[k] = v;
    }
  }
  return { min, max };
}

/** Footprints must overlap by this much, mm; parts that only touch stay apart. */
const FOOTPRINT_OVERLAP_MM = 0.01;

/**
 * Which printed object each mesh belongs to.
 *
 * A slicer drops every object onto the bed on its own, so the objects of a file
 * keep their footprints and lose their heights. A liner that sits 7 mm up inside
 * its shell lands on the bed, inside the shell's floor, and the two print
 * through each other (Bambu calls that a G-code path conflict). Meshes whose
 * footprints overlap only keep their places as volumes of one object. Footprints
 * clear of each other stay separate objects, to be arranged however the user likes.
 */
function printedObjects(meshes: ThreeMfMesh[], positionsOf: ArrayLike<number>[]): string[] {
  const named = new Map<string, number[]>();
  meshes.forEach((m, i) => {
    if (m.object === undefined) return;
    const group = named.get(m.object);
    if (group) group.push(i);
    else named.set(m.object, [i]);
  });
  const groups = footprintGroups(positionsOf.map((p) => meshBounds(p)), {
    axes: [0, 1],
    minOverlap: FOOTPRINT_OVERLAP_MM,
    joined: named.values(),
  });
  return groups.map(String);
}

const MOLD_SHELL_NAME_RE = /(?:^|[\s_-])(?:shell|holder)(?:$|[\s_,-])/i;
const MOLD_LINER_NAME_RE = /(?:^|[\s_-])(?:liner|insert)(?:$|[\s_,-])/i;

/**
 * Material colours whose filament slot order is structural rather than by
 * triangle count:
 *  1. Explicit `filamentOrder` (e.g. mold shell/holder = 1, liner/insert = 2).
 *  2. Paired mold shell/holder + liner/insert meshes recognised by name even
 *     when separated onto different spots on the bed (`insert` construction).
 *  3. Volumes sharing one composite object, outermost bounding box first.
 */
function priorityMaterials(meshes: ThreeMfMesh[], positionsOf: ArrayLike<number>[], objectOf: string[]): number[][] {
  const explicit = new Map<number, { colour: number[]; order: number; size: number }>();
  const boxSize = (i: number) => {
    const { min, max } = meshBounds(positionsOf[i]);
    return (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
  };
  meshes.forEach((m, i) => {
    if (m.filamentOrder === undefined) return;
    const key = colourKey(m.baseColor);
    const size = boxSize(i);
    const prev = explicit.get(key);
    if (!prev || m.filamentOrder < prev.order || (m.filamentOrder === prev.order && size > prev.size)) {
      explicit.set(key, { colour: m.baseColor, order: m.filamentOrder, size });
    }
  });

  const ordered: number[][] = [...explicit.values()]
    .sort((a, b) => a.order - b.order || b.size - a.size)
    .map((e) => e.colour);

  const hasShell = meshes.some((m) => MOLD_SHELL_NAME_RE.test(m.name));
  const hasLiner = meshes.some((m) => MOLD_LINER_NAME_RE.test(m.name));
  if (hasShell && hasLiner) {
    const shells: { colour: number[]; size: number }[] = [];
    const liners: { colour: number[]; size: number }[] = [];
    meshes.forEach((m, i) => {
      if (MOLD_SHELL_NAME_RE.test(m.name)) shells.push({ colour: m.baseColor, size: boxSize(i) });
      else if (MOLD_LINER_NAME_RE.test(m.name)) liners.push({ colour: m.baseColor, size: boxSize(i) });
    });
    shells.sort((a, b) => b.size - a.size).forEach((s) => ordered.push(s.colour));
    liners.sort((a, b) => b.size - a.size).forEach((l) => ordered.push(l.colour));
  }

  const colours = new Map<string, Set<number>>();
  meshes.forEach((m, i) => {
    const set = colours.get(objectOf[i]) ?? new Set<number>();
    set.add(colourKey(m.baseColor));
    colours.set(objectOf[i], set);
  });
  const largest = new Map<number, { colour: number[]; size: number }>();
  meshes.forEach((m, i) => {
    if (colours.get(objectOf[i])!.size < 2) return;
    const size = boxSize(i);
    const key = colourKey(m.baseColor);
    if (size > (largest.get(key)?.size ?? -1)) largest.set(key, { colour: m.baseColor, size });
  });
  for (const entry of [...largest.values()].sort((a, b) => b.size - a.size)) {
    ordered.push(entry.colour);
  }
  return ordered;
}

/**
 * Shared Pass-1 mesh cleaner for both `exportThreeMf` and `exportThreeMfAssemblies`:
 * quantises coordinates to the 0.1 µm grid, drops non-finite, duplicate-vertex,
 * and collinear/zero-area (`|u × v|^2 <= 1e-20`) triangles, and welds vertices
 * that collapse to the same quantised coordinate so 3MF output stays manifold.
 */
function weldMeshTriangles(
  rawPositions: ArrayLike<number>,
  rawIndices: ArrayLike<number> | null,
  onValidTriangle?: (i0: number, i1: number, i2: number) => void,
): { positions: number[]; indices: number[] } {
  const rawVertexCount = Math.floor(rawPositions.length / 3);
  const rawIndexCount = rawIndices ? rawIndices.length : rawVertexCount;

  const weldedPositions: number[] = [];
  const vertexMap = new Map<string, number>();
  const weld = (x: number, y: number, z: number): number => {
    const key = `${x},${y},${z}`;
    let idx = vertexMap.get(key);
    if (idx === undefined) {
      idx = weldedPositions.length / 3;
      vertexMap.set(key, idx);
      weldedPositions.push(x, y, z);
    }
    return idx;
  };

  const indices: number[] = [];
  for (let t = 0; t + 2 < rawIndexCount; t += 3) {
    const i0 = rawIndices ? rawIndices[t] : t;
    const i1 = rawIndices ? rawIndices[t + 1] : t + 1;
    const i2 = rawIndices ? rawIndices[t + 2] : t + 2;
    if (i0 < 0 || i1 < 0 || i2 < 0 || i0 >= rawVertexCount || i1 >= rawVertexCount || i2 >= rawVertexCount) continue;

    const x0 = quantizeCoord(rawPositions[i0 * 3]);
    const y0 = quantizeCoord(rawPositions[i0 * 3 + 1]);
    const z0 = quantizeCoord(rawPositions[i0 * 3 + 2]);
    const x1 = quantizeCoord(rawPositions[i1 * 3]);
    const y1 = quantizeCoord(rawPositions[i1 * 3 + 1]);
    const z1 = quantizeCoord(rawPositions[i1 * 3 + 2]);
    const x2 = quantizeCoord(rawPositions[i2 * 3]);
    const y2 = quantizeCoord(rawPositions[i2 * 3 + 1]);
    const z2 = quantizeCoord(rawPositions[i2 * 3 + 2]);
    if (!Number.isFinite(x0 + y0 + z0 + x1 + y1 + z1 + x2 + y2 + z2)) continue;

    // Skip zero-area / collinear / duplicate-corner triangles on the 1e-4 grid.
    const ux = x1 - x0, uy = y1 - y0, uz = z1 - z0;
    const vx = x2 - x0, vy = y2 - y0, vz = z2 - z0;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz <= 1e-20) continue;

    const w0 = weld(x0, y0, z0);
    const w1 = weld(x1, y1, z1);
    const w2 = weld(x2, y2, z2);
    if (w0 === w1 || w1 === w2 || w2 === w0) continue;

    indices.push(w0, w1, w2);
    onValidTriangle?.(i0, i1, i2);
  }
  return { positions: weldedPositions, indices };
}

/** Zips a 3D model part with the package boilerplate every 3MF carries, plus any extra files. */
function packModel(model: Uint8Array, extra: ZipEntry[] = []): Uint8Array {
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    (extra.some((e) => e.path.endsWith('.config')) ? '<Default Extension="config" ContentType="text/xml"/>' : '') +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rel0" Target="/3D/3dmodel.model" Type="${MODEL_REL}"/>` +
    '</Relationships>';

  return zipStore([
    { path: '[Content_Types].xml', data: utf8(contentTypes) },
    { path: '_rels/.rels', data: utf8(rels) },
    { path: '3D/3dmodel.model', data: model },
    ...extra,
  ]);
}

/**
 * Packs meshes into a .3mf.
 *
 * Every object is one build item, which is how a slicer sees several separate
 * parts laid out on a plate rather than one welded lump. A mesh is an object of
 * its own unless `object` or an overlapping footprint says otherwise
 * (printedObjects). Positions are taken as given: in millimetres, Z-up, arranged
 * however the caller wants them.
 */
export function exportThreeMf(meshes: ThreeMfMesh[], options: ThreeMfOptions = {}): ThreeMfResult {
  const maxExtruders = Math.min(32, Math.max(1, Math.round(options.maxExtruders ?? 5)));

  // Pass one: weld rounded vertices per mesh, drop degenerate triangles, and
  // pack every valid triangle's corner & face colour into flat Float32Arrays
  // so dense meshes avoid allocating millions of 3-element JS arrays.
  interface Prepared {
    mesh: ThreeMfMesh;
    positions: number[];
    indices: number[];
    /** Flat [r0,g0,b0, r1,g1,b1, r2,g2,b2, ...] per valid triangle. */
    cornerColors: Float32Array;
    /** Flat [r,g,b, ...] per valid triangle. */
    triangleColors: Float32Array;
    /** False when a vertex-painted mesh has zero corners matching `mesh.baseColor`. */
    hasBaseColorCorner: boolean;
  }

  const prepared: Prepared[] = [];

  for (const mesh of meshes) {
    const baseR = mesh.baseColor[0] ?? 0.8;
    const baseG = mesh.baseColor[1] ?? 0.8;
    const baseB = mesh.baseColor[2] ?? 0.8;
    const baseKey = colourKey3(baseR, baseG, baseB);
    const colors = mesh.colors;
    const colorsLen = colors ? colors.length : 0;

    const cornerBuf: number[] = [];
    const triBuf: number[] = [];
    let hasBaseColorCorner = !colors;

    const { positions: weldedPositions, indices } = weldMeshTriangles(mesh.positions, mesh.indices, (i0, i1, i2) => {
      let r0 = baseR, g0 = baseG, b0 = baseB;
      let r1 = baseR, g1 = baseG, b1 = baseB;
      let r2 = baseR, g2 = baseG, b2 = baseB;
      if (colors) {
        if (i0 * 3 + 2 < colorsLen) { r0 = colors[i0 * 3]; g0 = colors[i0 * 3 + 1]; b0 = colors[i0 * 3 + 2]; }
        if (i1 * 3 + 2 < colorsLen) { r1 = colors[i1 * 3]; g1 = colors[i1 * 3 + 1]; b1 = colors[i1 * 3 + 2]; }
        if (i2 * 3 + 2 < colorsLen) { r2 = colors[i2 * 3]; g2 = colors[i2 * 3 + 1]; b2 = colors[i2 * 3 + 2]; }
        if (
          !hasBaseColorCorner &&
          (colourKey3(r0, g0, b0) === baseKey || colourKey3(r1, g1, b1) === baseKey || colourKey3(r2, g2, b2) === baseKey)
        ) {
          hasBaseColorCorner = true;
        }
      }
      cornerBuf.push(r0, g0, b0, r1, g1, b1, r2, g2, b2);
      // A slicer prints a whole triangle in one filament. Two corners alike
      // decide it, so a triangle across a hard-edged mark's boundary is one
      // colour or the other rather than a blend that snaps to some third
      // filament; otherwise the face's colour is the average of its corners,
      // which decides which side of a soft edge it falls on.
      const eq01 = r0 === r1 && g0 === g1 && b0 === b1;
      const eq02 = r0 === r2 && g0 === g2 && b0 === b2;
      const eq12 = r1 === r2 && g1 === g2 && b1 === b2;
      if (eq01 || eq02) triBuf.push(r0, g0, b0);
      else if (eq12) triBuf.push(r1, g1, b1);
      else triBuf.push((r0 + r1 + r2) / 3, (g0 + g1 + g2) / 3, (b0 + b1 + b2) / 3);
    });

    if (indices.length === 0) continue;
    prepared.push({
      mesh,
      positions: weldedPositions,
      indices,
      cornerColors: Float32Array.from(cornerBuf),
      triangleColors: Float32Array.from(triBuf),
      hasBaseColorCorner,
    });
  }

  const validMeshes = prepared.map((p) => p.mesh);
  const validPositions = prepared.map((p) => p.positions);
  const objectOf = printedObjects(validMeshes, validPositions);
  const requiredColors = prepared
    .filter((p) => p.hasBaseColorCorner || p.mesh.filamentOrder !== undefined)
    .map((p) => p.mesh.baseColor);
  const { slots, assignRgb } = buildPalette(
    prepared.map((p) => p.cornerColors),
    maxExtruders,
    requiredColors,
    priorityMaterials(validMeshes, validPositions, objectOf),
  );
  const slotCounts = new Array(slots.length).fill(0);
  const filamentOf = (rgb: number[]) => assignRgb(rgb[0] ?? 0.8, rgb[1] ?? 0.8, rgb[2] ?? 0.8) + 1;

  // Pass two: the XML. Colours are pooled across the export so one <m:color>
  // serves every triangle corner that is that colour — a painted die has a few
  // dozen distinct colours, not one per vertex.
  const colorIndex = new Map<number, number>();
  const colorList: string[] = [];
  const colorId = (r: number, g: number, b: number) => {
    const packed = rgbToSrgbPacked(r, g, b);
    let index = colorIndex.get(packed);
    if (index === undefined) {
      index = colorList.length;
      colorIndex.set(packed, index);
      colorList.push(srgbPackedToHex(packed));
    }
    return index;
  };

  const COLORGROUP_ID = 1;
  let nextObjectId = 2;
  const objectsXml = new XmlByteBuilder();
  let triangleTotal = 0;

  // Every mesh is written as a volume of an object, the way the mold liner's
  // assemblies are (see exportThreeMfAssemblies below), so that each volume can
  // name its filament in the slicers' config files. Only a triangle in some
  // other filament is stamped.
  interface Volume { id: number; name: string; extruder: number; triangles: number }
  const printed = new Map<string, { name: string; volumes: Volume[] }>();

  prepared.forEach(({ mesh, positions, indices, cornerColors, triangleColors, hasBaseColorCorner }, meshIndex) => {
    const objectId = nextObjectId++;
    const faceCount = indices.length / 3;
    const triSlots = new Uint8Array(faceCount);
    const localCounts = new Array<number>(slots.length).fill(0);

    for (let face = 0; face < faceCount; face++) {
      const slot = assignRgb(
        triangleColors[face * 3],
        triangleColors[face * 3 + 1],
        triangleColors[face * 3 + 2],
      );
      triSlots[face] = slot;
      localCounts[slot]++;
      slotCounts[slot]++;
    }

    // For a 100%-vertex-painted mesh with no corners in its baseColor (e.g. a
    // viewport-painted body whose Three.js material is white while its vertex
    // attribute holds the real colours), assign its dominant painted slot as
    // the volume's extruder instead of snapping an unused baseColor.
    let extruder: number;
    if (!hasBaseColorCorner && mesh.filamentOrder === undefined && slots.length > 0) {
      let dominant = 0;
      for (let s = 1; s < localCounts.length; s++) {
        if (localCounts[s] > localCounts[dominant]) dominant = s;
      }
      extruder = dominant + 1;
    } else {
      extruder = filamentOf(mesh.baseColor);
    }

    const vertexCount = positions.length / 3;
    objectsXml.push(
      `<object id="${objectId}" type="model" name="${xmlEscape(mesh.name)}" pid="${COLORGROUP_ID}" pindex="0"><mesh><vertices>`,
    );
    for (let v = 0; v < vertexCount; v++) {
      objectsXml.push(
        `<vertex x="${positions[v * 3]}" y="${positions[v * 3 + 1]}" z="${positions[v * 3 + 2]}"/>`,
      );
    }
    objectsXml.push('</vertices><triangles>');
    for (let face = 0; face < faceCount; face++) {
      const cOff = face * 9;
      const p1 = colorId(cornerColors[cOff], cornerColors[cOff + 1], cornerColors[cOff + 2]);
      const p2 = colorId(cornerColors[cOff + 3], cornerColors[cOff + 4], cornerColors[cOff + 5]);
      const p3 = colorId(cornerColors[cOff + 6], cornerColors[cOff + 7], cornerColors[cOff + 8]);

      const slot = triSlots[face];
      const painted = slot + 1 === extruder ? null : encodeTriangleState(slot + 1);
      const paint = painted ? ` paint_color="${painted}" slic3rpe:mmu_segmentation="${painted}"` : '';
      const t = face * 3;
      objectsXml.push(
        `<triangle v1="${indices[t]}" v2="${indices[t + 1]}" v3="${indices[t + 2]}" p1="${p1}" p2="${p2}" p3="${p3}"${paint}/>`,
      );
    }
    objectsXml.push('</triangles></mesh></object>');
    triangleTotal += faceCount;

    const key = objectOf[meshIndex];
    const entry = printed.get(key) ?? { name: mesh.objectName ?? mesh.object ?? mesh.name, volumes: [] };
    entry.volumes.push({ id: objectId, name: mesh.name, extruder, triangles: faceCount });
    printed.set(key, entry);
  });

  const items: string[] = [];
  const bambuObjects: string[] = [];
  const prusaObjects: string[] = [];
  for (const { name, volumes } of printed.values()) {
    const assemblyId = nextObjectId++;
    objectsXml.push(
      `<object id="${assemblyId}" type="model" name="${xmlEscape(name)}"><components>` +
      volumes.map((v) => `<component objectid="${v.id}"/>`).join('') +
      '</components></object>',
    );
    items.push(`<item objectid="${assemblyId}"/>`);
    bambuObjects.push(
      `  <object id="${assemblyId}">\n` +
      `    <metadata key="name" value="${xmlEscape(name)}"/>\n` +
      `    <metadata key="extruder" value="${volumes[0].extruder}"/>\n` +
      volumes.map((v) =>
        `    <part id="${v.id}" subtype="normal_part">\n` +
        `      <metadata key="name" value="${xmlEscape(v.name)}"/>\n` +
        `      <metadata key="extruder" value="${v.extruder}"/>\n` +
        '    </part>\n'
      ).join('') +
      '  </object>\n'
    );
    let firstId = 0;
    const prusaVolumes = volumes.map((v) => {
      const lastId = firstId + v.triangles - 1;
      const xml =
        `  <volume firstid="${firstId}" lastid="${lastId}">\n` +
        `   <metadata type="volume" key="name" value="${xmlEscape(v.name)}"/>\n` +
        '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n' +
        `   <metadata type="volume" key="extruder" value="${v.extruder}"/>\n` +
        '  </volume>\n';
      firstId = lastId + 1;
      return xml;
    });
    prusaObjects.push(
      ` <object id="${assemblyId}" instances_count="1">\n` +
      `  <metadata type="object" key="name" value="${xmlEscape(name)}"/>\n` +
      `  <metadata type="object" key="extruder" value="${volumes[0].extruder}"/>\n` +
      prusaVolumes.join('') +
      ' </object>\n'
    );
  }

  const colorGroupXml = colorList.length > 0
    ? `<m:colorgroup id="${COLORGROUP_ID}">${colorList.map((hex) => `<m:color color="${hex}"/>`).join('')}</m:colorgroup>`
    : '';
  const bambuMeta = bambuObjects.length > 0
    ? '<metadata name="BambuStudio:3mfVersion">1</metadata>'
    : '';

  const modelHeader = utf8(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:m="${MATERIAL_NS}" xmlns:slic3rpe="${SLIC3R_NS}">` +
    `<metadata name="Application">${xmlEscape(options.application ?? 'PhysBox Studio')}</metadata>` +
    bambuMeta +
    // The material extension is deliberately NOT in requiredextensions: colour
    // is decoration, and a reader that does not understand it should still open
    // the model rather than refuse the file.
    `<resources>${colorGroupXml}`,
  );
  const modelFooter = utf8(`</resources><build>${items.join('')}</build></model>`);
  const modelBytes = concatBytes([modelHeader, ...objectsXml.toChunks(), modelFooter]);

  const config = (body: string[]) => '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + body.join('') + '</config>\n';

  return {
    data: packModel(modelBytes, [
      { path: 'Metadata/model_settings.config', data: utf8(config(bambuObjects)) },
      { path: 'Metadata/Slic3r_PE_model.config', data: utf8(config(prusaObjects)) },
    ]),
    triangles: triangleTotal,
    palette: slots.map((color, i) => ({
      hex: linearToSrgbHex([color.r, color.g, color.b]),
      extruder: i + 1,
      triangles: slotCounts[i],
    })),
  };
}

// ---------------------------------------------------------------------------
// Objects made of parts, each part on its own extruder
// ---------------------------------------------------------------------------
//
// Painting (above) colours a SURFACE: a slicer takes a painted triangle a few
// layers deep and no further. A part that has to be a different material all
// the way through — a dissolvable liner inside a PLA mold — has to be its own
// VOLUME, and which extruder prints a volume is not something the 3MF core
// spec has a word for. Each slicer family keeps it in its own config file:
//
//  - Bambu Studio and OrcaSlicer read `Metadata/model_settings.config` (when
//    `<metadata name="BambuStudio:3mfVersion">1</metadata>` is present). An
//    object there is a 3MF object built from <components>, and each <part>
//    names the sub-object (by its id in 3dmodel.model) it configures. A part
//    given as a triangle range is parsed and then ignored — the importer
//    (`_generate_volumes_new`) matches parts to sub-objects only — so the
//    parts have to be objects of their own.
//  - PrusaSlicer reads `Metadata/Slic3r_PE_model.config`, keyed by the build
//    item's top-level <object> id (`assemblyId`). Its importer flattens the
//    assembly's <components> in order into one combined triangle buffer on that
//    ModelObject (keeping nested parts at their exact Z height above the bed)
//    and slices the buffer into ModelVolumes by `firstid..lastid`, each with
//    its own `extruder`.
//
// Both files are written and each slicer ignores the other's.

/** One solid of an assembly, already in millimetres, Z-up, where it prints. */
export interface ThreeMfPart {
  name: string;
  /** x,y,z per vertex, in millimetres. */
  positions: ArrayLike<number>;
  /** Triangle indices, wound outward. */
  indices: ArrayLike<number>;
  /** 1-based extruder (filament slot) that prints this part. */
  extruder: number;
}

/** A printed object made of several parts, e.g. a mold shell and its liner. */
export interface ThreeMfAssembly {
  name: string;
  parts: ThreeMfPart[];
}

export interface ThreeMfAssemblyResult {
  data: Uint8Array;
  triangles: number;
  /** The extruders the file asks for, ascending. */
  extruders: number[];
}

/** Packs assemblies into a .3mf whose parts each name their extruder, for Bambu/Orca and PrusaSlicer. */
export function exportThreeMfAssemblies(
  assemblies: ThreeMfAssembly[],
  options: { application?: string } = {},
): ThreeMfAssemblyResult {
  let nextId = 1;
  const objectsXml = new XmlByteBuilder();
  const items: string[] = [];
  const bambuObjects: string[] = [];
  const prusaObjects: string[] = [];
  const extruders = new Set<number>();
  let triangleTotal = 0;

  for (const assembly of assemblies) {
    const rawParts = assembly.parts.filter((p) => p.positions.length >= 9 && p.indices.length >= 3);
    if (rawParts.length === 0) continue;

    const partIds: number[] = [];
    const bambuParts: string[] = [];
    const prusaVolumes: string[] = [];
    let firstExtruder = rawParts[0].extruder;
    let firstSet = false;
    let firstId = 0;
    for (const part of rawParts) {
      // Share Pass-1 quantisation, finite guard, zero-area/collinear filtering,
      // and post-rounding vertex welding so sub-0.1 µm edges never emit
      // zero-area non-manifold triangles or NaN XML attributes.
      const { positions, indices } = weldMeshTriangles(part.positions, part.indices);
      const triangleCount = indices.length / 3;
      if (triangleCount === 0) continue;

      if (!firstSet) {
        firstExtruder = part.extruder;
        firstSet = true;
      }
      const id = nextId++;
      partIds.push(id);
      extruders.add(part.extruder);
      triangleTotal += triangleCount;

      const vertexCount = positions.length / 3;
      objectsXml.push(`<object id="${id}" type="model" name="${xmlEscape(part.name)}"><mesh><vertices>`);
      for (let v = 0; v < vertexCount; v++) {
        objectsXml.push(
          `<vertex x="${positions[v * 3]}" y="${positions[v * 3 + 1]}" z="${positions[v * 3 + 2]}"/>`,
        );
      }
      objectsXml.push('</vertices><triangles>');
      for (let t = 0; t + 2 < indices.length; t += 3) {
        objectsXml.push(`<triangle v1="${indices[t]}" v2="${indices[t + 1]}" v3="${indices[t + 2]}"/>`);
      }
      objectsXml.push('</triangles></mesh></object>');

      bambuParts.push(
        `    <part id="${id}" subtype="normal_part">\n` +
        `      <metadata key="name" value="${xmlEscape(part.name)}"/>\n` +
        `      <metadata key="extruder" value="${part.extruder}"/>\n` +
        '    </part>\n'
      );
      const lastId = firstId + triangleCount - 1;
      prusaVolumes.push(
        `  <volume firstid="${firstId}" lastid="${lastId}">\n` +
        `   <metadata type="volume" key="name" value="${xmlEscape(part.name)}"/>\n` +
        '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n' +
        `   <metadata type="volume" key="extruder" value="${part.extruder}"/>\n` +
        '  </volume>\n'
      );
      firstId = lastId + 1;
    }
    if (partIds.length === 0) continue;

    const assemblyId = nextId++;
    objectsXml.push(
      `<object id="${assemblyId}" type="model" name="${xmlEscape(assembly.name)}"><components>` +
      partIds.map((id) => `<component objectid="${id}"/>`).join('') +
      '</components></object>',
    );
    items.push(`<item objectid="${assemblyId}"/>`);
    bambuObjects.push(
      `  <object id="${assemblyId}">\n` +
      `    <metadata key="name" value="${xmlEscape(assembly.name)}"/>\n` +
      `    <metadata key="extruder" value="${firstExtruder}"/>\n` +
      bambuParts.join('') +
      '  </object>\n'
    );
    prusaObjects.push(
      ` <object id="${assemblyId}" instances_count="1">\n` +
      `  <metadata type="object" key="name" value="${xmlEscape(assembly.name)}"/>\n` +
      `  <metadata type="object" key="extruder" value="${firstExtruder}"/>\n` +
      prusaVolumes.join('') +
      ' </object>\n'
    );
  }

  const bambuMeta = bambuObjects.length > 0
    ? '<metadata name="BambuStudio:3mfVersion">1</metadata>'
    : '';

  const modelHeader = utf8(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">` +
    `<metadata name="Application">${xmlEscape(options.application ?? 'PhysBox Studio')}</metadata>` +
    bambuMeta +
    '<resources>',
  );
  const modelFooter = utf8(`</resources><build>${items.join('')}</build></model>`);
  const modelBytes = concatBytes([modelHeader, ...objectsXml.toChunks(), modelFooter]);

  const config = (body: string[]) => '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + body.join('') + '</config>\n';

  return {
    data: packModel(modelBytes, [
      { path: 'Metadata/model_settings.config', data: utf8(config(bambuObjects)) },
      { path: 'Metadata/Slic3r_PE_model.config', data: utf8(config(prusaObjects)) },
    ]),
    triangles: triangleTotal,
    extruders: [...extruders].sort((a, b) => a - b),
  };
}
