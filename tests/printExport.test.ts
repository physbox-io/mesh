import { describe, it, expect } from 'vitest';
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { exportPrintFiles } from '../src/utils/printExport';
import { castCommands } from '../src/hooks/mcp/castCommands';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { PhysicsState } from '../src/store/useStore';

/** Corners of a binary STL, as [x, y, z] in the file's units. */
function stlPoints(bytes: Uint8Array): number[][] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  expect(bytes.byteLength).toBe(84 + count * 50);
  const out: number[][] = [];
  for (let t = 0; t < count; t++) {
    for (let v = 0; v < 3; v++) {
      const at = 84 + t * 50 + 12 + v * 12;
      out.push([view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]);
    }
  }
  return out;
}

function extent(points: number[][]) {
  const min = [0, 1, 2].map((k) => Math.min(...points.map((p) => p[k])));
  const max = [0, 1, 2].map((k) => Math.max(...points.map((p) => p[k])));
  return { min, max, size: [0, 1, 2].map((k) => max[k] - min[k]) };
}

const body = (id: string, pos: number[], size: number[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, type: 'body', pos,
  geoms: [{ name: `${id}_g`, type: 'box', size, rgba: [1, 0, 0, 1] }],
  joints: [], children: [], ...extra,
});

// A 20 x 40 x 10 mm block floating 0.3 m up, a 10 mm cube beside it, and a
// bought-in nut that must never reach a print file.
const scene: SceneGraph = {
  nodes: [
    body('block', [0, 0, 0.3], [0.01, 0.02, 0.005], {
      children: [body('nut', [0, 0, 0.01], [0.003, 0.003, 0.002], { hardwarePart: { kind: 'nut', size: 'M3' } } as unknown as Partial<SceneNode>)],
    }),
    body('cube', [0.1, 0, 0.3], [0.005, 0.005, 0.005]),
  ],
};

describe('exportPrintFiles', () => {
  it('writes the chosen body at true size in mm, standing on z = 0', () => {
    const result = exportPrintFiles(scene, { format: 'stl', ids: ['block'] });
    expect(result.missing).toEqual([]);
    expect(result.files).toHaveLength(1);
    const { min, size } = extent(stlPoints(result.files[0].bytes));
    expect(size[0]).toBeCloseTo(20, 3);
    expect(size[1]).toBeCloseTo(40, 3);
    expect(size[2]).toBeCloseTo(10, 3);
    expect(min[2]).toBeCloseTo(0, 6);
    expect(result.parts.map((p) => p.id)).toEqual(['block']);
    expect(result.parts[0].sizeMm).toEqual([20, 40, 10]);
  });

  it('keeps bodies in place relative to each other in one file, and one file each with separate', () => {
    const one = exportPrintFiles(scene, { format: 'stl' });
    expect(one.files).toHaveLength(1);
    const { size } = extent(stlPoints(one.files[0].bytes));
    expect(size[0]).toBeCloseTo(100 + 10 + 5, 3); // block's half (10) + 100 mm gap to the cube's centre + its half (5)
    const each = exportPrintFiles(scene, { format: 'stl', separate: true });
    expect(each.files.map((f) => f.name)).toEqual(['block.stl', 'cube.stl']);
  });

  it('leaves bought-in hardware out', () => {
    const result = exportPrintFiles(scene, { format: 'stl' });
    expect(result.parts.map((p) => p.id)).not.toContain('nut');
  });

  it('writes a 3MF with one object per body', () => {
    const result = exportPrintFiles(scene, { format: '3mf', baseName: 'Two Parts' });
    expect(result.files[0].name).toBe('two_parts.3mf');
    const files = unzipSync(result.files[0].bytes);
    const model = new TextDecoder().decode(files['3D/3dmodel.model']);
    expect(model.match(/<object /g)?.length).toBe(2);
  });

  it('names ids it does not have', () => {
    expect(exportPrintFiles(scene, { format: 'stl', ids: ['nope'] }).missing).toEqual(['nope']);
  });
});

describe('EXPORT_PRINT', () => {
  const store = { sceneGraph: scene, printBed: { widthMm: 256, depthMm: 256, heightMm: 256 }, activePreset: 'x' } as unknown as PhysicsState;
  const ctx = { store, toId: (v: unknown) => v };

  it('hands the files back as base64 with a summary', async () => {
    const reply = await castCommands.EXPORT_PRINT({ ids: ['cube'], format: 'stl' }, ctx) as {
      ok: boolean; summary: { units: string; parts: { sizeMm: number[] }[] }; files: { name: string; base64?: string; bytes: number }[];
    };
    expect(reply.ok).toBe(true);
    expect(reply.summary.units).toBe('mm');
    expect(reply.summary.parts[0].sizeMm).toEqual([10, 10, 10]);
    expect(reply.files[0].base64).toBeTruthy();
    expect(reply.files[0].bytes).toBe(84 + 12 * 50);
  });

  it('refuses an unknown format or body, and sends no bytes when they will not be kept', async () => {
    expect(await castCommands.EXPORT_PRINT({ format: 'obj' }, ctx)).toMatchObject({ ok: false });
    expect(await castCommands.EXPORT_PRINT({ ids: ['ghost'] }, ctx)).toMatchObject({ ok: false, error: 'No body called ghost.' });
    const reply = await castCommands.EXPORT_PRINT({ includeFiles: false }, ctx) as { files: { base64?: string }[] };
    expect(reply.files[0].base64).toBeUndefined();
  });
});
