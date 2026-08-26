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
//    here is the whole-triangle case (see encodeTriangleState) and it has not
//    been checked against a real slicer from this codebase.
//  - A slicer's painting has at most a handful of filaments; anything past
//    `maxExtruders` is snapped to the nearest colour that fits.
// ---------------------------------------------------------------------------

import { zipStore, utf8, type ZipEntry } from './zipStore';

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
}

export interface ThreeMfOptions {
  /**
   * How many filaments the target machine has.
   *
   * Four is an AMS. The encoding below is only defined for the first few slots
   * anyway — see encodeTriangleState.
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

export function linearToSrgbHex(rgb: number[]): string {
  const hex = (v: number) => linearToSrgbByte(v).toString(16).padStart(2, '0');
  return `#${hex(rgb[0] ?? 0)}${hex(rgb[1] ?? 0)}${hex(rgb[2] ?? 0)}`;
}

/**
 * The `paint_color` value for a triangle painted entirely in one filament.
 *
 * The slicers encode a triangle's painting as a subdivision tree serialised
 * into hex nibbles: the low bits say whether the triangle is split, the rest
 * carry the state, and a split triangle recurses. A triangle that is not split
 * is therefore a single nibble of `state << 2`, which is where "4" for the
 * second filament and "8" for the third come from.
 *
 * Only the unsplit case is written here, and only for the states that fit in
 * one nibble. That is exactly right for what this app produces: the painted
 * surface is tessellated finely enough that a mark's boundary falls between
 * triangles rather than across one, so no triangle needs splitting. Returns
 * null when there is nothing to stamp — state 0 is the default filament, and
 * writing it on every triangle would be noise in the file.
 */
export function encodeTriangleState(state: number): string | null {
  if (state <= 0) return null;
  if (state > 3) return null;
  return ((state << 2) >>> 0).toString(16).toUpperCase();
}

const xmlEscape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Trims a coordinate to something a file does not need eight decimals of. */
const num = (value: number) => {
  const rounded = Math.round(value * 1e4) / 1e4;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

interface TriangleColor { r: number; g: number; b: number; }

/**
 * Reduces every triangle in the export to a handful of filament colours.
 *
 * Frequency-first: the colour the most triangles are, is the body colour, and
 * it becomes filament 1 — so an unpainted body needs no painting at all and a
 * die with pips needs one extra filament rather than two. Everything else snaps
 * to the nearest slot that fits.
 */
function buildPalette(triangleColors: TriangleColor[], maxExtruders: number) {
  const buckets = new Map<string, { color: TriangleColor; count: number }>();
  for (const c of triangleColors) {
    // Quantised to 4 bits a channel before counting, so the soft edge of a
    // brushed mark does not register as a hundred distinct colours.
    const key = `${Math.round(c.r * 15)},${Math.round(c.g * 15)},${Math.round(c.b * 15)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.count++;
    else buckets.set(key, { color: c, count: 1 });
  }

  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count);
  const slots = ranked.slice(0, Math.max(1, maxExtruders)).map((b) => b.color);

  const assign = (c: TriangleColor) => {
    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const d = (s.r - c.r) ** 2 + (s.g - c.g) ** 2 + (s.b - c.b) ** 2;
      if (d < bestDistance) { bestDistance = d; best = i; }
    }
    return best;
  };

  return { slots, assign };
}

/**
 * Packs meshes into a .3mf.
 *
 * Every mesh becomes one object and every object one build item, which is how a
 * slicer sees several separate parts laid out on a plate rather than one welded
 * lump. Positions are taken as given: in millimetres, Z-up, arranged however
 * the caller wants them.
 */
export function exportThreeMf(meshes: ThreeMfMesh[], options: ThreeMfOptions = {}): ThreeMfResult {
  const maxExtruders = options.maxExtruders ?? 4;

  // Pass one: every triangle's colour, so the palette can be decided across the
  // whole export rather than per object — the same red has to be the same
  // filament on the lid as on the box.
  interface Prepared {
    mesh: ThreeMfMesh;
    indices: number[];
    cornerColors: number[][];    // three linear rgb triples per triangle
    triangleColors: TriangleColor[];
  }

  const prepared: Prepared[] = [];
  const allTriangleColors: TriangleColor[] = [];

  for (const mesh of meshes) {
    const vertexCount = Math.floor(mesh.positions.length / 3);
    const indices: number[] = [];
    if (mesh.indices) {
      for (let i = 0; i < mesh.indices.length; i++) indices.push(mesh.indices[i]);
    } else {
      for (let i = 0; i < vertexCount; i++) indices.push(i);
    }

    const colorAt = (v: number): number[] => {
      if (!mesh.colors) return mesh.baseColor;
      return [mesh.colors[v * 3], mesh.colors[v * 3 + 1], mesh.colors[v * 3 + 2]];
    };

    const cornerColors: number[][] = [];
    const triangleColors: TriangleColor[] = [];
    for (let t = 0; t + 2 < indices.length; t += 3) {
      const a = colorAt(indices[t]);
      const b = colorAt(indices[t + 1]);
      const c = colorAt(indices[t + 2]);
      cornerColors.push(a, b, c);
      // A slicer prints a whole triangle in one filament, so the face's colour
      // is the average of its corners — which is also what decides which side of
      // a mark's soft edge the triangle falls on.
      triangleColors.push({
        r: (a[0] + b[0] + c[0]) / 3,
        g: (a[1] + b[1] + c[1]) / 3,
        b: (a[2] + b[2] + c[2]) / 3,
      });
    }

    prepared.push({ mesh, indices, cornerColors, triangleColors });
    allTriangleColors.push(...triangleColors);
  }

  const { slots, assign } = buildPalette(allTriangleColors, maxExtruders);
  const slotCounts = new Array(slots.length).fill(0);

  // Pass two: the XML. Colours are pooled across the export so one <m:color>
  // serves every triangle corner that is that colour — a painted die has a few
  // dozen distinct colours, not one per vertex.
  const colorIndex = new Map<string, number>();
  const colorList: string[] = [];
  const colorId = (rgb: number[]) => {
    const hex = linearToSrgbHex(rgb);
    let index = colorIndex.get(hex);
    if (index === undefined) {
      index = colorList.length;
      colorIndex.set(hex, index);
      colorList.push(hex);
    }
    return index;
  };

  const COLORGROUP_ID = 1;
  let nextObjectId = 2;
  const objects: string[] = [];
  const items: string[] = [];
  let triangleTotal = 0;

  for (const { mesh, indices, cornerColors, triangleColors } of prepared) {
    const objectId = nextObjectId++;
    const vertexCount = Math.floor(mesh.positions.length / 3);

    const vertexLines: string[] = [];
    for (let v = 0; v < vertexCount; v++) {
      vertexLines.push(
        `<vertex x="${num(mesh.positions[v * 3])}" y="${num(mesh.positions[v * 3 + 1])}" z="${num(mesh.positions[v * 3 + 2])}"/>`
      );
    }

    const triangleLines: string[] = [];
    for (let t = 0, face = 0; t + 2 < indices.length; t += 3, face++) {
      const p1 = colorId(cornerColors[face * 3]);
      const p2 = colorId(cornerColors[face * 3 + 1]);
      const p3 = colorId(cornerColors[face * 3 + 2]);

      const slot = assign(triangleColors[face]);
      slotCounts[slot]++;
      const painted = encodeTriangleState(slot);
      const paint = painted ? ` paint_color="${painted}" slic3rpe:mmu_segmentation="${painted}"` : '';

      triangleLines.push(
        `<triangle v1="${indices[t]}" v2="${indices[t + 1]}" v3="${indices[t + 2]}" p1="${p1}" p2="${p2}" p3="${p3}"${paint}/>`
      );
      triangleTotal++;
    }

    objects.push(
      `<object id="${objectId}" type="model" name="${xmlEscape(mesh.name)}" pid="${COLORGROUP_ID}" pindex="0">` +
      `<mesh><vertices>${vertexLines.join('')}</vertices>` +
      `<triangles>${triangleLines.join('')}</triangles></mesh></object>`
    );
    items.push(`<item objectid="${objectId}"/>`);
  }

  const colorNodes = colorList.map((hex) => `<m:color color="${hex}"/>`).join('');

  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}" xmlns:m="${MATERIAL_NS}" xmlns:slic3rpe="${SLIC3R_NS}">` +
    `<metadata name="Application">${xmlEscape(options.application ?? 'PhysBox Studio')}</metadata>` +
    // The material extension is deliberately NOT in requiredextensions: colour
    // is decoration, and a reader that does not understand it should still open
    // the model rather than refuse the file.
    `<resources><m:colorgroup id="${COLORGROUP_ID}">${colorNodes}</m:colorgroup>${objects.join('')}</resources>` +
    `<build>${items.join('')}</build></model>`;

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
    '</Types>';

  const rels =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rel0" Target="/3D/3dmodel.model" Type="${MODEL_REL}"/>` +
    '</Relationships>';

  const entries: ZipEntry[] = [
    { path: '[Content_Types].xml', data: utf8(contentTypes) },
    { path: '_rels/.rels', data: utf8(rels) },
    { path: '3D/3dmodel.model', data: utf8(model) },
  ];

  return {
    data: zipStore(entries),
    triangles: triangleTotal,
    palette: slots.map((color, i) => ({
      hex: linearToSrgbHex([color.r, color.g, color.b]),
      extruder: i + 1,
      triangles: slotCounts[i],
    })),
  };
}
