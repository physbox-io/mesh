import { describe, it, expect } from 'vitest';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { zipStore, crc32, utf8 } from '../src/utils/zipStore';
import {
  exportThreeMf,
  exportThreeMfAssemblies,
  encodeTriangleState,
  linearToSrgbHex,
  type ThreeMfMesh,
} from '../src/utils/threeMfExporter';
import { filterVisibleScene, resolveExportMeshLabel } from '../src/hooks/useMeshExport';
import type { SceneNode } from '../src/types/scene';

/** Reads a stored-entry ZIP back out, which is all a 3MF reader has to do. */
function unzip(data: Uint8Array): Map<string, string> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const decoder = new TextDecoder();
  const files = new Map<string, string>();

  // Walk the local headers rather than the central directory — this is a
  // deliberate second implementation, so a bug in the writer's offsets shows up
  // as a mismatch between the two rather than being agreed with.
  let offset = 0;
  while (offset + 4 <= data.length && view.getUint32(offset, true) === 0x04034b50) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decoder.decode(data.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    const body = data.subarray(start, start + size);

    expect(view.getUint32(offset + 14, true)).toBe(crc32(body));
    files.set(name, decoder.decode(body));
    offset = start + size;
  }

  // ...and the central directory has to agree about how many there were.
  expect(view.getUint32(offset, true)).toBe(0x02014b50);
  return files;
}

/** One triangle, its three corners the colours given. */
function triangle(colors: number[][] | null, baseColor = [0.5, 0.5, 0.5]): ThreeMfMesh {
  return {
    name: 'part',
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
    colors: colors ? new Float32Array(colors.flat()) : null,
    baseColor,
  };
}

describe('zipStore', () => {
  it('writes an archive that reads back', () => {
    const zip = zipStore([
      { path: 'a.txt', data: utf8('hello') },
      { path: 'nested/b.xml', data: utf8('<x/>') },
    ]);
    const files = unzip(zip);

    expect(files.get('a.txt')).toBe('hello');
    expect(files.get('nested/b.xml')).toBe('<x/>');
    expect(files.size).toBe(2);
  });

  it('ends with a central directory naming every entry', () => {
    const zip = zipStore([{ path: 'a.txt', data: utf8('hello') }]);
    const view = new DataView(zip.buffer);
    // End-of-central-directory is the last 22 bytes of a comment-less archive.
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(1);
  });

  it('is byte-identical for identical input, so two exports can be compared', () => {
    const once = zipStore([{ path: 'a.txt', data: utf8('hello') }]);
    const again = zipStore([{ path: 'a.txt', data: utf8('hello') }]);
    expect(Array.from(once)).toEqual(Array.from(again));
  });

  it('agrees with the known CRC-32 of a standard string', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
  });
});

describe('colour conversion', () => {
  it('writes sRGB hex, which is what a 3MF colour is', () => {
    expect(linearToSrgbHex([0, 0, 0])).toBe('#000000');
    expect(linearToSrgbHex([1, 1, 1])).toBe('#ffffff');
    // Mid-grey in linear light is well above half in sRGB — writing the linear
    // value straight out would export every colour noticeably too dark.
    expect(parseInt(linearToSrgbHex([0.5, 0.5, 0.5]).slice(1, 3), 16)).toBeGreaterThan(180);
  });
});

describe('the painted-triangle encoding', () => {
  it('leaves an unpainted triangle unstamped', () => {
    expect(encodeTriangleState(0)).toBeNull();
  });

  it('numbers filaments as Bambu Studio and OrcaSlicer do (CONST_FILAMENTS)', () => {
    const bambu = ['4', '8', '0C', '1C', '2C', '3C', '4C', '5C', '6C', '7C', '8C', '9C', 'AC', 'BC', 'CC', 'DC',
      'EC', '0FC', '1FC', '2FC', '3FC', '4FC', '5FC', '6FC', '7FC', '8FC', '9FC', 'AFC', 'BFC', 'CFC', 'DFC', 'EFC'];
    bambu.forEach((code, i) => expect(encodeTriangleState(i + 1)).toBe(code));
  });

  it('declines a filament it cannot encode rather than writing a wrong one', () => {
    expect(encodeTriangleState(33)).toBeNull();
  });
});

describe('exportThreeMf', () => {
  it('opens in a real unzip implementation, not just ours', () => {
    // fflate is the library three's own 3MFLoader reads packages with, so this
    // is the closest thing to opening the file in a slicer that a unit test
    // can do — and it is checking the writer, not the reader above it.
    const files = unzipSync(exportThreeMf([triangle(null)]).data) as Record<string, Uint8Array>;
    const model = new TextDecoder().decode(files['3D/3dmodel.model']);

    expect(Object.keys(files).sort()).toEqual([
      '3D/3dmodel.model', 'Metadata/Slic3r_PE_model.config', 'Metadata/model_settings.config', '[Content_Types].xml', '_rels/.rels',
    ]);
    expect(model).toContain('<model unit="millimeter"');
  });

  it('produces a package with the three parts a reader looks for', () => {
    const files = unzip(exportThreeMf([triangle(null)]).data);

    expect([...files.keys()].slice(0, 3)).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    expect(files.get('[Content_Types].xml')).toContain('3dmanufacturing-3dmodel+xml');
    expect(files.get('_rels/.rels')).toContain('/3D/3dmodel.model');
  });

  it('writes the mesh in millimetres with a build item pointing at it', () => {
    const model = unzip(exportThreeMf([triangle(null)]).data).get('3D/3dmodel.model')!;

    expect(model).toContain('unit="millimeter"');
    expect(model).toContain('<vertex x="10" y="0" z="0"/>');
    // The mesh is a volume of the object the build places
    expect(model).toMatch(/<object id="(\d+)"[^>]*>[\s\S]*<component objectid="\1"\/>[\s\S]*<build><item objectid="\d+"\/><\/build>/);
  });

  it('gives each corner its own colour index', () => {
    const model = unzip(exportThreeMf([
      triangle([[1, 0, 0], [0, 1, 0], [0, 0, 1]]),
    ]).data).get('3D/3dmodel.model')!;

    expect(model).toContain('<m:colorgroup');
    expect(model).toContain('<m:color color="#ff0000"/>');
    expect(model).toContain('<m:color color="#00ff00"/>');
    // Three different corners must be three different indices, or the gradient
    // the screen shows collapses to a flat face in the file.
    const face = model.match(/<triangle [^>]*p1="(\d+)" p2="(\d+)" p3="(\d+)"/)!;
    expect(new Set([face[1], face[2], face[3]]).size).toBe(3);
  });

  it('leaves an unpainted model with no filament stamps at all', () => {
    const result = exportThreeMf([triangle(null)]);
    const model = unzip(result.data).get('3D/3dmodel.model')!;

    expect(model).not.toContain('paint_color');
    expect(result.palette).toHaveLength(1);
    expect(result.palette[0].extruder).toBe(1);
  });

  it('makes the commonest colour the default filament and stamps the rest', () => {
    // Three grey faces and one red one: grey is the body, red is the mark.
    const grey = [[0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5]];
    const red = [[1, 0, 0], [1, 0, 0], [1, 0, 0]];
    const quadTris = (n: number) =>
      new Float32Array(Array.from({ length: n }, (_, t) => [t * 10, 0, 0, t * 10 + 5, 0, 0, t * 10, 5, 0]).flat());
    const mesh: ThreeMfMesh = {
      name: 'die',
      positions: quadTris(4),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      colors: new Float32Array([...grey, ...grey, ...grey, ...red].flat()),
      baseColor: [0.5, 0.5, 0.5],
    };

    const result = exportThreeMf([mesh]);
    const model = unzip(result.data).get('3D/3dmodel.model')!;

    expect(result.palette[0].hex).toBe(linearToSrgbHex([0.5, 0.5, 0.5]));
    expect(result.palette[0].triangles).toBe(3);
    expect(result.palette[1].hex).toBe('#ff0000');
    // Exactly one triangle carries a stamp, filament 2, in both vendors' spelling.
    expect(model.match(/paint_color="8"/g)).toHaveLength(1);
    expect(model.match(/slic3rpe:mmu_segmentation="8"/g)).toHaveLength(1);
  });

  it('snaps colours past the machine\'s filament count onto the ones that fit', () => {
    const face = (c: number[]) => [c, c, c];
    const quadTris = (n: number) =>
      new Float32Array(Array.from({ length: n }, (_, t) => [t * 10, 0, 0, t * 10 + 5, 0, 0, t * 10, 5, 0]).flat());
    const mesh: ThreeMfMesh = {
      name: 'many',
      positions: quadTris(5),
      indices: new Uint32Array(Array.from({ length: 15 }, (_, i) => i)),
      colors: new Float32Array([
        ...face([0.5, 0.5, 0.5]),
        ...face([1, 0, 0]),
        ...face([0, 1, 0]),
        ...face([0, 0, 1]),
        ...face([0.98, 0.02, 0.02]),  // nearly the red above
      ].flat()),
      baseColor: [0.5, 0.5, 0.5],
    };

    const result = exportThreeMf([mesh], { maxExtruders: 2 });

    expect(result.palette).toHaveLength(2);
    // Everything is accounted for — nothing is silently dropped from the file.
    expect(result.palette.reduce((sum, p) => sum + p.triangles, 0)).toBe(5);
    expect(result.triangles).toBe(5);
  });

  it('handles a non-indexed mesh, which is what an unwelded export is', () => {
    const model = unzip(exportThreeMf([{
      name: 'loose',
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: null,
      colors: null,
      baseColor: [1, 1, 1],
    }]).data).get('3D/3dmodel.model')!;

    expect(model).toContain('<triangle v1="0" v2="1" v3="2"');
  });

  it('escapes a name that would otherwise break the XML', () => {
    const mesh = triangle(null);
    mesh.name = 'lid & <body>';
    const model = unzip(exportThreeMf([mesh]).data).get('3D/3dmodel.model')!;

    expect(model).toContain('name="lid &amp; &lt;body&gt;"');
  });
});

describe('what a slicer treats as one object', () => {
  /** A box's corners as a triangle soup, `tris` triangles long: enough for the bounds. */
  const box = (name: string, min: number[], max: number[], baseColor: number[], tris = 2): ThreeMfMesh => {
    const positions: number[] = [];
    for (let i = 0; i < tris; i++) positions.push(...min, ...max, max[0], min[1], max[2]);
    return { name, positions, indices: null, colors: null, baseColor };
  };
  const WOOD = [0.7, 0.45, 0.2];
  const CREAM = [0.9, 0.85, 0.65];
  const objects = (config: string) => [...config.matchAll(/<object id="\d+">[\s\S]*?<\/object>/g)].map((m) => ({
    parts: [...m[0].matchAll(/<part id="\d+"[^>]*>\s*<metadata key="name" value="([^"]*)"\/>\s*<metadata key="extruder" value="(\d+)"/g)]
      .map((p) => [p[1], Number(p[2])]),
  }));

  it('keeps a liner where it sits in its shell, and the two halves of a mold apart', () => {
    // Two objects dropped to the bed apart put the liner 7 mm down, through the shell's floor.
    const { data } = exportThreeMf([
      box('cavity shell', [-62, -30, 0], [-3, 30, 26], WOOD),
      box('cavity liner', [-53, -21, 7.3], [-12, 21, 26], CREAM, 3),
      box('lid shell', [3, -30, 0], [62, 30, 11.5], WOOD),
      box('lid liner', [12, -21, 3.8], [53, 21, 7.5], CREAM, 3),
    ]);
    const files = unzip(data);

    expect(files.get('3D/3dmodel.model')!.match(/<item /g)).toHaveLength(2);
    expect(objects(files.get('Metadata/model_settings.config')!).map((o) => o.parts)).toEqual([
      [['cavity shell', 1], ['cavity liner', 2]],
      [['lid shell', 1], ['lid liner', 2]],
    ]);
  });

  it('holds together what overlaps only through a third part', () => {
    const { data } = exportThreeMf([
      box('a', [0, 0, 0], [10, 10, 5], WOOD),
      box('b', [5, 0, 0], [15, 10, 5], WOOD),
      box('c', [12, 0, 0], [20, 10, 5], WOOD),
    ]);
    expect(unzip(data).get('3D/3dmodel.model')!.match(/<item /g)).toHaveLength(1);
  });

  it('leaves parts side by side, even touching, as objects to arrange', () => {
    const { data } = exportThreeMf([
      box('a', [0, 0, 0], [10, 10, 5], WOOD),
      box('b', [10, 0, 0], [20, 10, 5], CREAM, 5),
      box('c', [30, 0, 0], [40, 10, 5], WOOD),
    ]);
    const files = unzip(data);
    expect(files.get('3D/3dmodel.model')!.match(/<item /g)).toHaveLength(3);
    // Nothing nested, so the commonest colour is filament 1 as ever.
    expect(objects(files.get('Metadata/model_settings.config')!)[1].parts).toEqual([['b', 1]]);
  });
});

describe('shared-vertex welding, degenerate/empty guards, and slicer assembly metadata', () => {
  /** Closed outward-wound cube as an unindexed 12-triangle soup (36 raw vertices). */
  function cubeSoup([x0, y0, z0]: number[], [x1, y1, z1]: number[], jitter = 0): Float32Array {
    const c = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    const faces = [
      [0, 2, 1], [0, 3, 2],
      [4, 5, 6], [4, 6, 7],
      [0, 1, 5], [0, 5, 4],
      [1, 2, 6], [1, 6, 5],
      [2, 3, 7], [2, 7, 6],
      [3, 0, 4], [3, 4, 7],
    ];
    const out: number[] = [];
    faces.forEach((f, fi) => {
      for (const vi of f) {
        // Tiny sub-0.01 µm noise that rounds to the same 1e-4 mm vertex.
        const eps = jitter ? ((fi % 2 === 0 ? 1 : -1) * jitter) : 0;
        out.push(c[vi][0] + eps, c[vi][1] - eps, c[vi][2] + eps);
      }
    });
    return new Float32Array(out);
  }

  it('welds identical rounded vertices on a non-indexed closed cube into a shared-vertex manifold (vertices < triangles)', () => {
    const soup = cubeSoup([0, 0, 0], [20, 20, 20], 1e-6);
    const result = exportThreeMf([{
      name: 'cube',
      positions: soup,
      indices: null,
      colors: null,
      baseColor: [0.6, 0.6, 0.6],
    }]);
    expect(result.triangles).toBe(12);
    const model = unzip(result.data).get('3D/3dmodel.model')!;
    const verts = [...model.matchAll(/<vertex /g)];
    const tris = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)];
    expect(verts).toHaveLength(8);
    expect(tris).toHaveLength(12);
    expect(verts.length).toBeLessThan(tris.length);

    // Every directed edge (u -> v) on the closed cube has its twin (v -> u).
    const directed = new Set<string>();
    for (const m of tris) {
      const [a, b, c] = [+m[1], +m[2], +m[3]];
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(c).not.toBe(a);
      directed.add(`${a}->${b}`);
      directed.add(`${b}->${c}`);
      directed.add(`${c}->${a}`);
    }
    expect(directed.size).toBe(36);
    for (const edge of directed) {
      const [u, v] = edge.split('->');
      expect(directed.has(`${v}->${u}`)).toBe(true);
    }
  });

  it('filters out duplicate-vertex and collinear zero-area triangles and guards empty meshes', () => {
    const empty = exportThreeMf([
      { name: 'empty', positions: new Float32Array(0), indices: null, colors: null, baseColor: [0.5, 0.5, 0.5] },
      { name: 'collinear', positions: new Float32Array([0, 0, 0, 5, 0, 0, 10, 0, 0]), indices: null, colors: null, baseColor: [0.5, 0.5, 0.5] },
      { name: 'collapsed', positions: new Float32Array([1, 1, 1, 1 + 1e-6, 1, 1, 2, 3, 4]), indices: null, colors: null, baseColor: [0.5, 0.5, 0.5] },
    ]);
    expect(empty.triangles).toBe(0);
    expect(empty.palette).toEqual([]);
    const emptyModel = unzip(empty.data).get('3D/3dmodel.model')!;
    expect(emptyModel).not.toContain('<m:colorgroup');
    expect(emptyModel).not.toContain('pindex="0"');
    expect(emptyModel).toContain('<build></build>');

    // Mixed degenerate + valid triangles inside one mesh keeps only the valid face.
    const mixedPositions = new Float32Array([
      0, 0, 0, 0, 0, 0, 5, 5, 0,         // duplicate vertex
      0, 0, 0, 2, 2, 2, 4, 4, 4,         // collinear
      0, 0, 0, 10, 0, 0, 0, 10, 0,       // valid triangle
    ]);
    const mixed = exportThreeMf([{ name: 'mixed', positions: mixedPositions, indices: null, colors: null, baseColor: [0.8, 0.2, 0.2] }]);
    expect(mixed.triangles).toBe(1);
    const mixedModel = unzip(mixed.data).get('3D/3dmodel.model')!;
    expect(mixedModel.match(/<vertex /g)).toHaveLength(3);
    expect(mixedModel.match(/<triangle /g)).toHaveLength(1);
  });

  it('emits BambuStudio:3mfVersion and aligns Slic3r_PE_model.config object IDs and volume ranges with build items', () => {
    const shell = cubeSoup([0, 0, 0], [40, 40, 25]);
    const liner = cubeSoup([5, 5, 7.3], [35, 35, 25]);
    const res = exportThreeMf([
      { name: 'Bottom shell', positions: shell, indices: null, colors: null, baseColor: [0.7, 0.45, 0.2], object: 'half_bottom', objectName: 'Bottom' },
      { name: 'Bottom liner', positions: liner, indices: null, colors: null, baseColor: [0.9, 0.85, 0.65], object: 'half_bottom', objectName: 'Bottom' },
    ]);
    const files = unzip(res.data);
    const model = files.get('3D/3dmodel.model')!;
    const bambu = files.get('Metadata/model_settings.config')!;
    const prusa = files.get('Metadata/Slic3r_PE_model.config')!;

    expect(model).toContain('<metadata name="BambuStudio:3mfVersion">1</metadata>');

    const buildIds = [...model.matchAll(/<item objectid="(\d+)"\/>/g)].map((m) => m[1]);
    expect(buildIds).toHaveLength(1);
    const assemblyId = buildIds[0];

    // Both Bambu and PrusaSlicer configs key <object id="..."> by the <build><item> assemblyId.
    expect([...bambu.matchAll(/<object id="(\d+)">/g)].map((m) => m[1])).toEqual([assemblyId]);
    expect([...prusa.matchAll(/<object id="(\d+)" instances_count="1">/g)].map((m) => m[1])).toEqual([assemblyId]);
    expect(prusa).toMatch(
      new RegExp(
        `<object id="${assemblyId}" instances_count="1">[\\s\\S]*?` +
        `<volume firstid="0" lastid="11">[\\s\\S]*?key="extruder" value="1"[\\s\\S]*?` +
        `<volume firstid="12" lastid="23">[\\s\\S]*?key="extruder" value="2"`,
      ),
    );

    // exportThreeMfAssemblies follows the exact same contract.
    const tetra = {
      positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]),
      indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]),
    };
    const asmRes = exportThreeMfAssemblies([
      { name: 'Cavity half', parts: [{ name: 'Cavity shell', extruder: 1, ...tetra }, { name: 'Cavity liner', extruder: 2, ...tetra }] },
    ]);
    const asmFiles = unzip(asmRes.data);
    const asmModel = asmFiles.get('3D/3dmodel.model')!;
    const asmPrusa = asmFiles.get('Metadata/Slic3r_PE_model.config')!;
    expect(asmModel).toContain('<metadata name="BambuStudio:3mfVersion">1</metadata>');
    expect(asmModel).toContain('<item objectid="3"/>');
    expect([...asmPrusa.matchAll(/<object id="(\d+)" instances_count="1">/g)].map((m) => m[1])).toEqual(['3']);
    expect(asmPrusa).toMatch(/<volume firstid="0" lastid="3">[\s\S]*?key="extruder" value="1"/);
    expect(asmPrusa).toMatch(/<volume firstid="4" lastid="7">[\s\S]*?key="extruder" value="2"/);
  });

  it('names viewport-exported meshes after human-readable node.name (and geom.name when multi-geom)', () => {
    const singleBody: SceneNode = {
      id: 'body_9f81a2',
      name: 'Mounting Bracket',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        { name: 'box_1', type: 'box', size: [0.01, 0.01, 0.01] },
        { name: 'hole_1', type: 'cylinder', size: [0.002, 0.01], csg: 'difference' },
      ],
      joints: [],
      children: [],
    };
    expect(resolveExportMeshLabel(singleBody, singleBody.id, 'box_1', 'part_0')).toEqual({ name: 'Mounting Bracket' });

    const multiBody: SceneNode = {
      id: 'body_77c4e0',
      name: 'Gear Housing',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        { name: 'shell', type: 'box', size: [0.02, 0.02, 0.01] },
        { name: 'bushing', type: 'cylinder', size: [0.005, 0.01] },
      ],
      joints: [],
      children: [],
    };
    expect(resolveExportMeshLabel(multiBody, multiBody.id, 'shell', 'part_0')).toEqual({
      name: 'Gear Housing (shell)',
      objectName: 'Gear Housing',
    });
    expect(resolveExportMeshLabel(multiBody, multiBody.id, 'bushing', 'part_1')).toEqual({
      name: 'Gear Housing (bushing)',
      objectName: 'Gear Housing',
    });

    const filtered = filterVisibleScene({ name: 'Demo', nodes: [singleBody, multiBody] }, new Set(['body_9f81a2']));
    expect(filtered.name).toBe('Demo');
    expect(filtered.nodes.map((n) => n.id)).toEqual(['body_77c4e0']);
  });
});
