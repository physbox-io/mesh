import { describe, it, expect } from 'vitest';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { zipStore, crc32, utf8 } from '../src/utils/zipStore';
import { exportThreeMf, encodeTriangleState, linearToSrgbHex, type ThreeMfMesh } from '../src/utils/threeMfExporter';

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
  it('leaves the default filament unstamped', () => {
    expect(encodeTriangleState(0)).toBeNull();
  });

  it('stamps the painted filaments', () => {
    expect(encodeTriangleState(1)).toBe('4');
    expect(encodeTriangleState(2)).toBe('8');
    expect(encodeTriangleState(3)).toBe('C');
  });

  it('declines a filament it cannot encode rather than writing a wrong one', () => {
    expect(encodeTriangleState(4)).toBeNull();
  });
});

describe('exportThreeMf', () => {
  it('opens in a real unzip implementation, not just ours', () => {
    // fflate is the library three's own 3MFLoader reads packages with, so this
    // is the closest thing to opening the file in a slicer that a unit test
    // can do — and it is checking the writer, not the reader above it.
    const files = unzipSync(exportThreeMf([triangle(null)]).data) as Record<string, Uint8Array>;
    const model = new TextDecoder().decode(files['3D/3dmodel.model']);

    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    expect(model).toContain('<model unit="millimeter"');
  });

  it('produces a package with the three parts a reader looks for', () => {
    const files = unzip(exportThreeMf([triangle(null)]).data);

    expect([...files.keys()]).toEqual(['[Content_Types].xml', '_rels/.rels', '3D/3dmodel.model']);
    expect(files.get('[Content_Types].xml')).toContain('3dmanufacturing-3dmodel+xml');
    expect(files.get('_rels/.rels')).toContain('/3D/3dmodel.model');
  });

  it('writes the mesh in millimetres with a build item pointing at it', () => {
    const model = unzip(exportThreeMf([triangle(null)]).data).get('3D/3dmodel.model')!;

    expect(model).toContain('unit="millimeter"');
    expect(model).toContain('<vertex x="10" y="0" z="0"/>');
    expect(model).toMatch(/<object id="(\d+)"[^>]*>[\s\S]*<build><item objectid="\1"\/><\/build>/);
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
    const mesh: ThreeMfMesh = {
      name: 'die',
      positions: new Float32Array(4 * 3 * 3).map((_, i) => i % 7),
      indices: new Uint32Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
      colors: new Float32Array([...grey, ...grey, ...grey, ...red].flat()),
      baseColor: [0.5, 0.5, 0.5],
    };

    const result = exportThreeMf([mesh]);
    const model = unzip(result.data).get('3D/3dmodel.model')!;

    expect(result.palette[0].hex).toBe(linearToSrgbHex([0.5, 0.5, 0.5]));
    expect(result.palette[0].triangles).toBe(3);
    expect(result.palette[1].hex).toBe('#ff0000');
    // Exactly one triangle carries a stamp, and it carries both vendors' spelling.
    expect(model.match(/paint_color="4"/g)).toHaveLength(1);
    expect(model.match(/slic3rpe:mmu_segmentation="4"/g)).toHaveLength(1);
  });

  it('snaps colours past the machine\'s filament count onto the ones that fit', () => {
    const face = (c: number[]) => [c, c, c];
    const mesh: ThreeMfMesh = {
      name: 'many',
      positions: new Float32Array(5 * 3 * 3).map((_, i) => i % 7),
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
