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
   * a different material from its outside. Absent: an object of its own.
   */
  object?: string;
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

export function linearToSrgbHex(rgb: number[]): string {
  const hex = (v: number) => linearToSrgbByte(v).toString(16).padStart(2, '0');
  return `#${hex(rgb[0] ?? 0)}${hex(rgb[1] ?? 0)}${hex(rgb[2] ?? 0)}`;
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
function buildPalette(cornerColors: number[][], maxExtruders: number, required: number[][] = []) {
  const buckets = new Map<string, { color: TriangleColor; count: number }>();
  for (const [r, g, b] of cornerColors) {
    const c = { r, g, b };
    // Quantised to 4 bits a channel before counting, so the soft edge of a
    // brushed mark does not register as a hundred distinct colours.
    const key = `${Math.round(c.r * 15)},${Math.round(c.g * 15)},${Math.round(c.b * 15)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.count++;
    else buckets.set(key, { color: c, count: 1 });
  }

  const ranked = [...buckets.values()].sort((a, b) => b.count - a.count);
  // A volume's own colour is a material chosen on purpose, so it keeps a slot
  // ahead of a paint colour however few corners it has.
  const keyOf = (c: number[]) => `${Math.round(c[0] * 15)},${Math.round(c[1] * 15)},${Math.round(c[2] * 15)}`;
  const must = new Set(required.map(keyOf));
  const kept = ranked.filter((b) => must.has(keyOf([b.color.r, b.color.g, b.color.b])));
  const rest = ranked.filter((b) => !must.has(keyOf([b.color.r, b.color.g, b.color.b])));
  const room = Math.max(1, maxExtruders);
  const chosen = [...kept.slice(0, room), ...rest.slice(0, Math.max(0, room - kept.length))];
  const slots = chosen.sort((a, b) => b.count - a.count).map((b) => b.color);

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

/** Zips a 3D model part with the package boilerplate every 3MF carries, plus any extra files. */
function packModel(model: string, extra: ZipEntry[] = []): Uint8Array {
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
    { path: '3D/3dmodel.model', data: utf8(model) },
    ...extra,
  ]);
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
  const maxExtruders = Math.min(32, Math.max(1, Math.round(options.maxExtruders ?? 5)));

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
  const allCornerColors: number[][] = [];

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
      // A slicer prints a whole triangle in one filament. Two corners alike
      // decide it, so a triangle across a hard-edged mark's boundary is one
      // colour or the other rather than a blend that snaps to some third
      // filament; otherwise the face's colour is the average of its corners,
      // which decides which side of a soft edge it falls on.
      const same = (p: number[], q: number[]) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
      const two = same(a, b) || same(a, c) ? a : same(b, c) ? b : null;
      triangleColors.push(two
        ? { r: two[0], g: two[1], b: two[2] }
        : { r: (a[0] + b[0] + c[0]) / 3, g: (a[1] + b[1] + c[1]) / 3, b: (a[2] + b[2] + c[2]) / 3 });
    }

    prepared.push({ mesh, indices, cornerColors, triangleColors });
    for (const c of cornerColors) allCornerColors.push(c);
  }

  const { slots, assign } = buildPalette(
    allCornerColors,
    maxExtruders,
    meshes.map((m) => m.baseColor),
  );
  const slotCounts = new Array(slots.length).fill(0);
  const filamentOf = (rgb: number[]) => assign({ r: rgb[0] ?? 0.8, g: rgb[1] ?? 0.8, b: rgb[2] ?? 0.8 }) + 1;

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
  let triangleTotal = 0;

  // Every mesh is written as a volume of an object, the way the mold liner's
  // assemblies are (see exportThreeMfAssemblies below), so that each volume can
  // name its filament in the slicers' config files. Only a triangle in some
  // other filament is stamped.
  interface Volume { id: number; name: string; extruder: number; triangles: number }
  const printed = new Map<string, { name: string; volumes: Volume[] }>();

  prepared.forEach(({ mesh, indices, cornerColors, triangleColors }, meshIndex) => {
    const objectId = nextObjectId++;
    const extruder = filamentOf(mesh.baseColor);
    const vertexCount = Math.floor(mesh.positions.length / 3);

    const vertexLines: string[] = [];
    for (let v = 0; v < vertexCount; v++) {
      vertexLines.push(
        `<vertex x="${num(mesh.positions[v * 3])}" y="${num(mesh.positions[v * 3 + 1])}" z="${num(mesh.positions[v * 3 + 2])}"/>`
      );
    }

    const triangleLines: string[] = [];
    let face = 0;
    for (let t = 0; t + 2 < indices.length; t += 3, face++) {
      const p1 = colorId(cornerColors[face * 3]);
      const p2 = colorId(cornerColors[face * 3 + 1]);
      const p3 = colorId(cornerColors[face * 3 + 2]);

      const slot = assign(triangleColors[face]);
      slotCounts[slot]++;
      const painted = slot + 1 === extruder ? null : encodeTriangleState(slot + 1);
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
    const key = mesh.object ?? `\u0000${meshIndex}`;
    const entry = printed.get(key) ?? { name: mesh.object ?? mesh.name, volumes: [] };
    entry.volumes.push({ id: objectId, name: mesh.name, extruder, triangles: face });
    printed.set(key, entry);
  });

  const items: string[] = [];
  const bambuObjects: string[] = [];
  const prusaObjects: string[] = [];
  for (const { name, volumes } of printed.values()) {
    const assemblyId = nextObjectId++;
    objects.push(
      `<object id="${assemblyId}" type="model" name="${xmlEscape(name)}"><components>` +
      volumes.map((v) => `<component objectid="${v.id}"/>`).join('') +
      '</components></object>'
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
    for (const v of volumes) {
      prusaObjects.push(
        ` <object id="${v.id}" instances_count="1">\n` +
        `  <metadata type="object" key="name" value="${xmlEscape(v.name)}"/>\n` +
        `  <metadata type="object" key="extruder" value="${v.extruder}"/>\n` +
        `  <volume firstid="0" lastid="${Math.max(0, v.triangles - 1)}">\n` +
        `   <metadata type="volume" key="name" value="${xmlEscape(v.name)}"/>\n` +
        '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n' +
        `   <metadata type="volume" key="extruder" value="${v.extruder}"/>\n` +
        '  </volume>\n' +
        ' </object>\n'
      );
    }
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

  const config = (body: string[]) => '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + body.join('') + '</config>\n';

  return {
    data: packModel(model, [
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
//  - Bambu Studio and OrcaSlicer read `Metadata/model_settings.config`. An
//    object there is a 3MF object built from <components>, and each <part>
//    names the sub-object (by its id in 3dmodel.model) it configures. A part
//    given as a triangle range is parsed and then ignored — the importer
//    (`_generate_volumes_new`) matches parts to sub-objects only — so the
//    parts have to be objects of their own.
//  - PrusaSlicer reads `Metadata/Slic3r_PE_model.config`, keyed by MESH object
//    id. Handed an object built from components it makes each component a
//    model object of its own, in place, so the shell and the liner arrive as
//    two objects sitting where they belong, each with its extruder set.
//
// Both files are written and each slicer ignores the other's. The formats were
// read from the importers' source (OrcaSlicer bbs_3mf.cpp, PrusaSlicer
// 3mf.cpp), not copied from a sample file, and no file from here has yet been
// opened in a real slicer.

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
  const objects: string[] = [];
  const items: string[] = [];
  const bambuObjects: string[] = [];
  const prusaObjects: string[] = [];
  const extruders = new Set<number>();
  let triangleTotal = 0;

  for (const assembly of assemblies) {
    const parts = assembly.parts.filter((p) => p.indices.length >= 3);
    if (parts.length === 0) continue;

    const partIds: number[] = [];
    const bambuParts: string[] = [];
    for (const part of parts) {
      const id = nextId++;
      partIds.push(id);
      extruders.add(part.extruder);

      const vertexCount = Math.floor(part.positions.length / 3);
      const vertexLines: string[] = [];
      for (let v = 0; v < vertexCount; v++) {
        vertexLines.push(
          `<vertex x="${num(part.positions[v * 3])}" y="${num(part.positions[v * 3 + 1])}" z="${num(part.positions[v * 3 + 2])}"/>`
        );
      }
      const triangleCount = Math.floor(part.indices.length / 3);
      const triangleLines: string[] = [];
      for (let t = 0; t < triangleCount; t++) {
        triangleLines.push(
          `<triangle v1="${part.indices[t * 3]}" v2="${part.indices[t * 3 + 1]}" v3="${part.indices[t * 3 + 2]}"/>`
        );
      }
      triangleTotal += triangleCount;

      objects.push(
        `<object id="${id}" type="model" name="${xmlEscape(part.name)}">` +
        `<mesh><vertices>${vertexLines.join('')}</vertices>` +
        `<triangles>${triangleLines.join('')}</triangles></mesh></object>`
      );
      bambuParts.push(
        `    <part id="${id}" subtype="normal_part">\n` +
        `      <metadata key="name" value="${xmlEscape(part.name)}"/>\n` +
        `      <metadata key="extruder" value="${part.extruder}"/>\n` +
        '    </part>\n'
      );
      prusaObjects.push(
        ` <object id="${id}" instances_count="1">\n` +
        `  <metadata type="object" key="name" value="${xmlEscape(part.name)}"/>\n` +
        `  <metadata type="object" key="extruder" value="${part.extruder}"/>\n` +
        `  <volume firstid="0" lastid="${triangleCount - 1}">\n` +
        `   <metadata type="volume" key="name" value="${xmlEscape(part.name)}"/>\n` +
        '   <metadata type="volume" key="volume_type" value="ModelPart"/>\n' +
        `   <metadata type="volume" key="extruder" value="${part.extruder}"/>\n` +
        '  </volume>\n' +
        ' </object>\n'
      );
    }

    const assemblyId = nextId++;
    objects.push(
      `<object id="${assemblyId}" type="model" name="${xmlEscape(assembly.name)}"><components>` +
      partIds.map((id) => `<component objectid="${id}"/>`).join('') +
      '</components></object>'
    );
    items.push(`<item objectid="${assemblyId}"/>`);
    bambuObjects.push(
      `  <object id="${assemblyId}">\n` +
      `    <metadata key="name" value="${xmlEscape(assembly.name)}"/>\n` +
      `    <metadata key="extruder" value="${parts[0].extruder}"/>\n` +
      bambuParts.join('') +
      '  </object>\n'
    );
  }

  const model =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<model unit="millimeter" xml:lang="en-US" xmlns="${CORE_NS}">` +
    `<metadata name="Application">${xmlEscape(options.application ?? 'PhysBox Studio')}</metadata>` +
    `<resources>${objects.join('')}</resources>` +
    `<build>${items.join('')}</build></model>`;

  const config = (body: string[]) => '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n' + body.join('') + '</config>\n';

  return {
    data: packModel(model, [
      { path: 'Metadata/model_settings.config', data: utf8(config(bambuObjects)) },
      { path: 'Metadata/Slic3r_PE_model.config', data: utf8(config(prusaObjects)) },
    ]),
    triangles: triangleTotal,
    extruders: [...extruders].sort((a, b) => a - b),
  };
}
