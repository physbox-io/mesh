import { describe, it, expect, vi } from 'vitest';
import { packMeshArrays, unpackMeshArrays } from '../src/utils/meshPacking';

/** A sphere-ish grid mesh: vertices in metres, faces as a scanned triangle strip. */
function gridMesh(rows: number, cols: number) {
  const vertices: number[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = (c / cols) * Math.PI * 2;
      const z = (r / rows) * 0.107;
      vertices.push(0.0529992 * Math.cos(a) + 1e-9 * r, 0.0529992 * Math.sin(a), z);
    }
  }
  const faces: number[] = [];
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c + 1 < cols; c++) {
      const i = r * cols + c;
      faces.push(i, i + cols, i + 1, i + 1, i + cols, i + cols + 1);
    }
  }
  return { vertices, faces };
}

function scene(rows = 120, cols = 200) {
  const { vertices, faces } = gridMesh(rows, cols);
  return {
    name: 'Candle',
    nodes: [{
      id: 'master', name: 'Master', pos: [0, 0, 0],
      geoms: [{ name: 'master_mesh', type: 'mesh', size: [1, 1, 1], rgba: [1, 1, 1, 1], vertices, faces }],
      children: [{
        id: 'pin', name: 'Pin', pos: [0, 0, 0.1],
        geoms: [{ name: 'pin', type: 'box', size: [0.001, 0.001, 0.01] }],
      }],
    }],
    noteCards: [{ title: 'Notes', body: 'vertices: keep this text' }],
  };
}

describe('packMeshArrays', () => {
  it('round-trips faces exactly and vertices to float32', () => {
    const s = scene();
    const back = unpackMeshArrays(JSON.parse(JSON.stringify(packMeshArrays(s))));
    const g = back.nodes[0].geoms[0];
    expect(g.faces).toEqual(s.nodes[0].geoms[0].faces);
    const v = s.nodes[0].geoms[0].vertices;
    expect(g.vertices).toHaveLength(v.length);
    v.forEach((x, i) => expect(g.vertices[i]).toBe(Math.fround(x)));
    // Everything that is not a big mesh array comes back as it went.
    expect(back.nodes[0].children).toEqual(s.nodes[0].children);
    expect(back.noteCards).toEqual(s.noteCards);
    expect(back.nodes[0].geoms[0].rgba).toEqual([1, 1, 1, 1]);
  });

  it('is under a third of the JSON it replaces', () => {
    const s = scene();
    const plain = JSON.stringify(s).length;
    const packed = JSON.stringify(packMeshArrays(s)).length;
    expect(packed).toBeLessThan(plain / 3);
  });

  it('is stable: packing what was unpacked gives the same text', () => {
    const once = JSON.stringify(packMeshArrays(scene()));
    const twice = JSON.stringify(packMeshArrays(unpackMeshArrays(JSON.parse(once))));
    expect(twice).toBe(once);
  });

  it('leaves the scene it was given alone', () => {
    const s = scene();
    const before = JSON.stringify(s);
    const packed = packMeshArrays(s);
    expect(JSON.stringify(s)).toBe(before);
    // Unchanged branches are shared rather than copied.
    expect(packed.nodes[0].children).toBe(s.nodes[0].children);
    expect(packed.noteCards).toBe(s.noteCards);
  });

  it('passes a scene saved before packing straight through', () => {
    const s = scene();
    expect(unpackMeshArrays(s)).toBe(s);
  });

  it('round-trips indices that jump backwards and past 2^31', () => {
    const faces = Array.from({ length: 300 }, (_, i) => (i % 3 === 0 ? 4_000_000_000 - i : i % 7 === 0 ? 0 : i * 1000));
    const back = unpackMeshArrays(packMeshArrays({ faces }));
    expect(back.faces).toEqual(faces);
  });

  it('leaves arrays it cannot represent as numbers', () => {
    const vertices = Array.from({ length: 120 }, (_, i) => (i === 50 ? NaN : i));
    const faces = Array.from({ length: 120 }, (_, i) => (i === 7 ? -1 : i));
    const packed = packMeshArrays({ vertices, faces, pos: Array.from({ length: 200 }, () => 0.1) });
    expect(packed.vertices).toBe(vertices);
    expect(packed.faces).toBe(faces);
    // Only the mesh keys are packed: a long array under any other name is not a mesh.
    expect(Array.isArray(packed.pos)).toBe(true);
  });

  it('says so when a newer version wrote a kind it does not know', () => {
    expect(() => unpackMeshArrays({ vertices: { $packed: 'f16', n: 3, b64: 'AAAA' } })).toThrow(/newer version/);
  });
});

describe('saved presets', () => {
  it('are stored packed and read back as numbers', async () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
    vi.doMock('../src/utils/cloudSync', () => ({
      saveCloudPreset: vi.fn(), removeCloudPreset: vi.fn(), fetchCloudPresetData: vi.fn(),
    }));
    const { writeLocalPreset, readUserPreset } = await import('../src/utils/userPresets');
    const s = scene(40, 60);
    expect(writeLocalPreset('candle', s as never)).toBe(true);
    const raw = [...map.values()].join('');
    expect(raw).toContain('"$packed":"f32"');
    expect(raw).not.toContain(String(s.nodes[0].geoms[0].vertices[3]));
    const back = readUserPreset('candle') as unknown as ReturnType<typeof scene>;
    expect(back.nodes[0].geoms[0].faces).toEqual(s.nodes[0].geoms[0].faces);
    expect(back.nodes[0].geoms[0].vertices[3]).toBe(Math.fround(s.nodes[0].geoms[0].vertices[3]));
    vi.unstubAllGlobals();
  });
});
