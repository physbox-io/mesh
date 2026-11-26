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
    expect(model.match(/<item /g)?.length).toBe(2);
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

  it('sends split sections as a file each unless told otherwise, as the dialog offers first', async () => {
    const section = (id: string, x: number): SceneNode => ({
      id, name: id, type: 'body', pos: [x, 0, 0.005], joints: [], children: [],
      geoms: [{ name: 'g', type: 'box', size: [0.005, 0.005, 0.005] }],
      printPose: { up: [0, 0, 1], spin: 0 },
    } as SceneNode);
    const split = { ...store, sceneGraph: { nodes: [section('beam_part1', 0), section('beam_part2', 0.01)] } } as unknown as PhysicsState;
    const splitCtx = { store: split, toId: (v: unknown) => v };
    const asked = await castCommands.EXPORT_PRINT({ format: 'stl', includeFiles: false }, splitCtx) as { files: unknown[] };
    expect(asked.files.length).toBe(2);
    const one = await castCommands.EXPORT_PRINT({ format: 'stl', separate: false, includeFiles: false }, splitCtx) as { files: unknown[] };
    expect(one.files.length).toBe(1);
  });

  it('refuses an unknown format or body, and sends no bytes when they will not be kept', async () => {
    expect(await castCommands.EXPORT_PRINT({ format: 'obj' }, ctx)).toMatchObject({ ok: false });
    expect(await castCommands.EXPORT_PRINT({ ids: ['ghost'] }, ctx)).toMatchObject({ ok: false, error: 'No body called ghost.' });
    const reply = await castCommands.EXPORT_PRINT({ includeFiles: false }, ctx) as { files: { base64?: string }[] };
    expect(reply.files[0].base64).toBeUndefined();
  });
});

describe('colour and material in the 3MF', () => {
  const model3mf = (bytes: Uint8Array) => {
    const files = unzipSync(bytes) as Record<string, Uint8Array>;
    const text = (p: string) => new TextDecoder().decode(files[p]);
    return { model: text('3D/3dmodel.model'), bambu: text('Metadata/model_settings.config'), prusa: text('Metadata/Slic3r_PE_model.config') };
  };

  it('prints a core in another colour as its own volume on its own filament', () => {
    // A 30 mm grey shell round a 10 mm red core: one object, two materials.
    const lined: SceneGraph = {
      nodes: [{
        id: 'part', name: 'part', type: 'body', pos: [0, 0, 0.1], joints: [], children: [],
        geoms: [
          { name: 'shell', type: 'box', size: [0.015, 0.015, 0.015], rgba: [0.5, 0.5, 0.5, 1] },
          { name: 'core', type: 'box', size: [0.005, 0.005, 0.005], rgba: [1, 0, 0, 1] },
        ],
      }],
    };
    const result = exportPrintFiles(lined, { format: '3mf' });
    const { model, bambu, prusa } = model3mf(result.files[0].bytes);
    // One thing on the plate, made of two volumes
    expect(model.match(/<item /g)).toHaveLength(1);
    expect(model.match(/<component /g)).toHaveLength(2);
    const extruders = [...bambu.matchAll(/<part id="\d+"[\s\S]*?key="extruder" value="(\d+)"/g)].map((m) => m[1]);
    expect(extruders.sort()).toEqual(['1', '2']);
    expect(prusa.match(/key="extruder" value="2"/g)!.length).toBeGreaterThan(0);
    // A volume in its own filament needs no painting
    expect(model).not.toContain('paint_color');
  });

  it('carries paint, stamped with the filament Bambu numbers it by', async () => {
    const { buildPaintGeometry, paintArgsFromSize, paintResolution, emptyCanvas, applyDab, layerFromCanvas } =
      await import('../src/utils/vertexPaint');
    const size = [0.01, 0.01, 0.01];
    const args = paintArgsFromSize('box', size);
    const res = paintResolution('box', args);
    const surface = buildPaintGeometry('box', args, res)!;
    const positions = surface.getAttribute('position').array;
    const canvas = emptyCanvas(surface.getAttribute('position').count, res);
    // A red spot in the middle of the top face
    applyDab(canvas, positions, { x: 0, y: 0.01, z: 0, radius: 0.004, color: [1, 0, 0], flow: 1, erase: false }, surface.getIndex()?.array);
    const paint = layerFromCanvas(canvas)!;
    const die: SceneGraph = {
      nodes: [{
        id: 'die', name: 'die', type: 'body', pos: [0, 0, 0.1], joints: [], children: [],
        geoms: [{ name: 'die_g', type: 'box', size, rgba: [1, 1, 1, 1], paint }],
      }],
    };
    const { model, bambu } = model3mf(exportPrintFiles(die, { format: '3mf' }).files[0].bytes);
    // Red at the spot's centre, as the brush's soft edge leaves it
    expect(model).toMatch(/<m:color color="#ff0[0-9a-f]0[0-9a-f]"\/>/);
    // White body on filament 1, the spot on filament 2: "8", not "4"
    expect(bambu).toMatch(/<part id="\d+"[\s\S]*?key="extruder" value="1"/);
    expect(model).toMatch(/paint_color="8"/);
    expect(model).not.toMatch(/paint_color="4"/);
    // Finer than the plain box's 12 triangles, so the spot has somewhere to land
    expect(model.match(/<triangle /g)!.length).toBeGreaterThan(100);

    // Beside an orange part, the pink along the spot's soft edge must not
    // snap to orange: the spot prints red or the die white, nothing else.
    const withOrange: SceneGraph = { nodes: [...die.nodes, body('orange', [0.05, 0, 0.1], [0.005, 0.005, 0.005])] };
    withOrange.nodes[1].geoms[0].rgba = [1, 0.5, 0, 1];
    const mixed = model3mf(exportPrintFiles(withOrange, { format: '3mf' }).files[0].bytes).model;
    expect(new Set([...mixed.matchAll(/paint_color="(\w+)"/g)].map((m) => m[1])).size).toBe(1);
  });
});

describe('the plate', () => {
  const bed = { widthMm: 256, depthMm: 256 };
  const items = (bytes: Uint8Array) => {
    const model = new TextDecoder().decode((unzipSync(bytes) as Record<string, Uint8Array>)['3D/3dmodel.model']);
    return { model, items: model.match(/<item /g)?.length ?? 0, components: model.match(/<component /g)?.length ?? 0 };
  };
  /** A box as a mesh geom, Z-up, wound outward: what Split for Print leaves. */
  const meshBox = (name: string, [x, y, z]: number[], rgba: number[]) => ({
    name, type: 'mesh' as const, rgba,
    renderVertices: [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z],
    faces: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  });
  // A 20 x 40 x 10 mm section made of a grey shell and a red core, stood on
  // its side to print, and a 10 mm cube that was never split.
  const plateScene = (): SceneGraph => ({
    nodes: [
      {
        id: 'section', name: 'section', type: 'body', pos: [0, 0, 0.3], joints: [], children: [],
        printPose: { up: [1, 0, 0], spin: 0 },
        geoms: [
          meshBox('shell', [0.01, 0.02, 0.005], [0.5, 0.5, 0.5, 1]),
          { name: 'core', type: 'box', size: [0.002, 0.002, 0.002], rgba: [1, 0, 0, 1] },
        ],
      },
      body('cube', [0.1, 0, 0.3], [0.005, 0.005, 0.005]),
    ],
  });

  it('puts every chosen part on the plate, posed or not, with its colours, and the summary matches', () => {
    const result = exportPrintFiles(plateScene(), { format: '3mf', bed });
    expect(result.plated).toBe(true);
    expect(result.files.map((f) => f.name)).toEqual(['model_plate.3mf']);
    const { model, items: n, components } = items(result.files[0].bytes);
    expect(n).toBe(result.parts.length);
    expect(n).toBe(2);
    // The section's core is its own volume, as off the plate: two for it, one for the cube
    expect(components).toBe(3);
    expect(result.filaments?.[0].length).toBe(2);
    // The section stands on its side: 20 mm (its X) is now its height
    const zs = [...model.matchAll(/<vertex x="[^"]+" y="[^"]+" z="([^"]+)"/g)].map((m) => +m[1]);
    expect(Math.min(...zs)).toBeCloseTo(0, 4);
    expect(Math.max(...zs)).toBeCloseTo(20, 3);
    // Summary sizeMm and printedSizeMm reflect the plated orientation (Z = 20 mm, not un-rotated 10 mm).
    expect(result.parts[0].sizeMm[2]).toBeCloseTo(20, 2);
    expect(result.parts[0].printedSizeMm?.[2]).toBeCloseTo(20, 2);
    expect(result.parts[0].sizeMm.slice(0, 2).sort((a, b) => a - b)).toEqual([10, 40]);
  });

  it('plates sections inside the margin they were split with, and says when the bed has changed', () => {
    const scene = plateScene();
    scene.nodes[0].printPose = { up: [1, 0, 0], spin: 0, cutFor: { bedMm: [256, 256, 256], marginMm: 1 } };
    const xs = (r: ReturnType<typeof exportPrintFiles>) =>
      [...items(r.files[0].bytes).model.matchAll(/<vertex x="([^"]+)"/g)].map((m) => +m[1]);
    const kept = exportPrintFiles(scene, { format: '3mf', bed: { ...bed, heightMm: 256 } });
    expect(Math.min(...xs(kept))).toBeCloseTo(1, 3);
    expect(kept.warnings.join(' ')).not.toMatch(/split for a/);
    const moved = exportPrintFiles(scene, { format: '3mf', bed: { widthMm: 180, depthMm: 180, heightMm: 180 } });
    expect(moved.warnings.join(' ')).toMatch(/split for a 256 × 256 × 256 mm bed and are plated on a 180 × 180 × 180 mm one/);
    expect(Math.min(...xs(exportPrintFiles(scene, { format: '3mf', bed, marginMm: 7 })))).toBeCloseTo(7, 3);
  });

  it('with separate, an STL a body, a section stood the way it prints', () => {
    const result = exportPrintFiles(plateScene(), { format: 'stl', separate: true });
    expect(result.files.map((f) => f.name)).toEqual(['section.stl', 'cube.stl']);
    // Binary STL: 80-byte header, count, then 50 bytes a triangle (normal, three corners).
    const bytes = result.files[0].bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const zs: number[] = [];
    for (let t = 0; t < view.getUint32(80, true); t++) for (let c = 0; c < 3; c++) zs.push(view.getFloat32(84 + t * 50 + 12 + c * 12 + 8, true));
    // Stood on its side: the 20 mm X is its height, as on the plate.
    expect(Math.max(...zs) - Math.min(...zs)).toBeCloseTo(20, 3);
    expect(result.parts[0].sizeMm[2]).toBeCloseTo(20, 2);
    expect(result.parts[0].printedSizeMm?.[2]).toBeCloseTo(20, 2);
  });

  it('with separate, one plate file a body, each stood the way it prints', () => {
    const result = exportPrintFiles(plateScene(), { format: '3mf', bed, separate: true });
    expect(result.plated).toBe(true);
    expect(result.files.map((f) => f.name)).toEqual(['section.3mf', 'cube.3mf']);
    expect(result.files.map((f) => items(f.bytes).items)).toEqual([1, 1]);
  });
});

describe("a generated mold's printed parts", () => {
  const meshBox = (name: string, [cx, cy, cz]: number[], [x, y, z]: number[]) => ({
    name, type: 'mesh' as const, rgba: [0.9, 0.8, 0.6, 1],
    renderVertices: [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z].map((v, i) => v + [cx, cy, cz][i % 3]),
    faces: [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7],
  });
  // A holder and the two pieces of the insert stacked in it, as a mold body
  // lies in the scene, and the part it was made from.
  const moldScene = (): SceneGraph => ({
    nodes: [
      body('master', [0, 0.2, 0.01], [0.01, 0.01, 0.01]),
      {
        id: 'mold', name: 'Simulated: Mold', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        simulation: { kind: 'mold', createdAt: '2026-11-09T00:00:00Z' },
        geoms: [
          meshBox('Cavity Half holder', [0, 0, 0.01], [0.03, 0.03, 0.01]),
          meshBox('Cavity Half insert, piece 1 of 2 (bottom)', [0, 0, 0.012], [0.01, 0.01, 0.004]),
          meshBox('Cavity Half insert, piece 2 of 2 (top)', [0, 0, 0.018], [0.01, 0.01, 0.002]),
        ],
      } as unknown as SceneNode,
    ],
  });

  it('lays each out on the bed as an object of its own, without the master', () => {
    const result = exportPrintFiles(moldScene(), { format: '3mf', plate: true, bed: { widthMm: 256, depthMm: 256 }, ids: ['mold'], moldParts: true });
    expect(result.parts.map((p) => p.name)).toEqual(['Cavity Half holder', 'Cavity Half insert, piece 1 of 2 (bottom)', 'Cavity Half insert, piece 2 of 2 (top)']);
    const model = new TextDecoder().decode((unzipSync(result.files[0].bytes) as Record<string, Uint8Array>)['3D/3dmodel.model']);
    expect(model.match(/<item /g)).toHaveLength(3);
    // On the bed apart: no two parts' footprints overlap, and each sits on z = 0.
    const boxes = [...model.matchAll(/<object id="\d+"[^>]*>([\s\S]*?)<\/object>/g)]
      .map((m) => [...m[1].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((v) => [+v[1], +v[2], +v[3]]))
      .filter((pts) => pts.length)
      .map(extent);
    expect(boxes).toHaveLength(3);
    for (const b of boxes) expect(b.min[2]).toBeCloseTo(0, 3);
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [p, q] = [boxes[i], boxes[j]];
        const apart = p.max[0] <= q.min[0] || q.max[0] <= p.min[0] || p.max[1] <= q.min[1] || q.max[1] <= p.min[1];
        expect(apart, `parts ${i} and ${j}`).toBe(true);
      }
    }
  });

  it('leaves a mold out of an ordinary export, as before', () => {
    const result = exportPrintFiles(moldScene(), { format: '3mf' });
    expect(result.parts.map((p) => p.name)).toEqual(['master']);
  });

  it('keeps combined lined mold shell + liner co-registered as 2 composite assemblies on the bed while preserving non-mold bodies', () => {
    const SHELL_RGBA = [0.86, 0.7, 0.48, 1];
    const LINER_RGBA = [0.95, 0.93, 0.82, 1];
    const BRACKET_RGBA = [0.2, 0.45, 0.85, 1];

    // Subdivided box helper (`sub` slices along X) so liners/inserts can carry >2x triangles of shells/holders.
    const subdividedMeshBox = (name: string, [cx, cy, cz]: number[], [hx, hy, hz]: number[], rgba: number[], sub = 1) => {
      const renderVertices: number[] = [];
      const faces: number[] = [];
      const dx = (2 * hx) / sub;
      for (let i = 0; i < sub; i++) {
        const x0 = cx - hx + i * dx;
        const x1 = x0 + dx;
        const base = renderVertices.length / 3;
        renderVertices.push(
          x0, cy - hy, cz - hz, x1, cy - hy, cz - hz, x1, cy + hy, cz - hz, x0, cy + hy, cz - hz,
          x0, cy - hy, cz + hz, x1, cy - hy, cz + hz, x1, cy + hy, cz + hz, x0, cy + hy, cz + hz,
        );
        for (const t of [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]) {
          faces.push(base + t);
        }
      }
      return { name, type: 'mesh' as const, rgba, renderVertices, faces };
    };

    // Simulated mold with `simulatedBody`-style geom names (`mold_0_cavity_half_shell`, etc.):
    // Bottom liner sits at z = 7.3..26 mm inside Bottom shell (z = 0..26 mm),
    // Top liner sits at z = 3.8..11.5 mm inside Top shell (z = 0..11.5 mm),
    // alongside a non-mold printable body (`bracket`).
    const combinedScene: SceneGraph = {
      nodes: [
        body('bracket', [-0.15, 0, 0.02], [0.015, 0.01, 0.008], {
          geoms: [{ name: 'bracket_g', type: 'box', size: [0.015, 0.01, 0.008], rgba: BRACKET_RGBA }],
        }),
        {
          id: 'mold', name: 'Simulated: Mold', type: 'body', pos: [0, 0, 0], joints: [], children: [],
          simulation: { kind: 'mold', createdAt: '2026-11-17T00:00:00Z' },
          geoms: [
            subdividedMeshBox('mold_0_cavity_half_shell', [-0.035, 0, 0.013], [0.03, 0.03, 0.013], SHELL_RGBA, 1),
            subdividedMeshBox('mold_1_cavity_half_liner', [-0.035, 0, 0.01665], [0.02, 0.02, 0.00935], LINER_RGBA, 3),
            subdividedMeshBox('mold_2_lid_half_shell', [0.035, 0, 0.00575], [0.03, 0.03, 0.00575], SHELL_RGBA, 1),
            subdividedMeshBox('mold_3_lid_half_liner', [0.035, 0, 0.00765], [0.02, 0.02, 0.00385], LINER_RGBA, 3),
          ],
        } as unknown as SceneNode,
      ],
    };

    const result = exportPrintFiles(combinedScene, {
      format: '3mf',
      plate: true,
      bed: { widthMm: 256, depthMm: 256 },
      moldParts: true,
    });
    expect(result.plated).toBe(true);
    // 1 non-mold body + 2 composite mold half assemblies (NOT 4 split geoms!).
    expect(result.parts.map((p) => p.name)).toEqual(['bracket', 'Cavity half', 'Lid half']);

    const archive = unzipSync(result.files[0].bytes) as Record<string, Uint8Array>;
    const text = (p: string) => new TextDecoder().decode(archive[p]);
    const model = text('3D/3dmodel.model');
    const bambu = text('Metadata/model_settings.config');
    const prusa = text('Metadata/Slic3r_PE_model.config');

    expect(model).toContain('<metadata name="BambuStudio:3mfVersion">1</metadata>');
    const itemIds = [...model.matchAll(/<item objectid="(\d+)"\/>/g)].map((m) => m[1]);
    expect(itemIds).toHaveLength(3);

    // Parse mesh objects and composite assemblies from 3dmodel.model.
    const meshObjs = new Map<string, { name: string; pts: number[][] }>();
    for (const m of model.matchAll(/<object id="(\d+)" type="model" name="([^"]*)"[^>]*><mesh>([\s\S]*?)<\/mesh><\/object>/g)) {
      const pts = [...m[3].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((v) => [+v[1], +v[2], +v[3]]);
      meshObjs.set(m[1], { name: m[2], pts });
    }
    expect(meshObjs.size).toBe(5);

    const assemblies = [...model.matchAll(/<object id="(\d+)" type="model" name="([^"]*)"><components>([\s\S]*?)<\/components><\/object>/g)]
      .map((m) => ({
        id: m[1],
        name: m[2],
        compIds: [...m[3].matchAll(/<component objectid="(\d+)"\/>/g)].map((c) => c[1]),
      }));
    expect(assemblies.map((a) => [a.name, a.compIds.length])).toEqual([
      ['bracket', 1],
      ['Cavity half', 2],
      ['Lid half', 2],
    ]);

    // Verify liners remain nested at z = 7.3 mm and z = 3.8 mm inside their shells (never dropped to Z = 0).
    const cavityAsm = assemblies.find((a) => a.name === 'Cavity half')!;
    const cavityShellBox = extent(meshObjs.get(cavityAsm.compIds[0])!.pts);
    const cavityLinerBox = extent(meshObjs.get(cavityAsm.compIds[1])!.pts);
    expect(cavityShellBox.min[2]).toBeCloseTo(0, 3);
    expect(cavityLinerBox.min[2]).toBeCloseTo(7.3, 3);
    // Liner XY sits strictly inside its shell XY.
    expect(cavityLinerBox.min[0]).toBeGreaterThan(cavityShellBox.min[0]);
    expect(cavityLinerBox.max[0]).toBeLessThan(cavityShellBox.max[0]);
    expect(cavityLinerBox.min[1]).toBeGreaterThan(cavityShellBox.min[1]);
    expect(cavityLinerBox.max[1]).toBeLessThan(cavityShellBox.max[1]);

    const lidAsm = assemblies.find((a) => a.name === 'Lid half')!;
    const lidShellBox = extent(meshObjs.get(lidAsm.compIds[0])!.pts);
    const lidLinerBox = extent(meshObjs.get(lidAsm.compIds[1])!.pts);
    expect(lidShellBox.min[2]).toBeCloseTo(0, 3);
    expect(lidLinerBox.min[2]).toBeCloseTo(3.8, 3);

    // Shell = Extruder 1, Liner = Extruder 2 (even though liners have 3x the triangles of shells!).
    for (const asm of [cavityAsm, lidAsm]) {
      const bambuBlock = bambu.match(new RegExp(`<object id="${asm.id}">([\\s\\S]*?)<\\/object>`))![1];
      const partExtruders = [...bambuBlock.matchAll(/<part id="(\d+)"[\s\S]*?key="extruder" value="(\d+)"/g)].map((m) => [m[1], +m[2]]);
      expect(partExtruders).toEqual([[asm.compIds[0], 1], [asm.compIds[1], 2]]);
    }

    // Slic3r_PE_model.config object IDs match <build><item> IDs with contiguous volume triangle ranges.
    expect([...prusa.matchAll(/<object id="(\d+)" instances_count="1">/g)].map((m) => m[1])).toEqual(itemIds);
    expect(prusa).toMatch(
      new RegExp(
        `<object id="${cavityAsm.id}" instances_count="1">[\\s\\S]*?` +
        `<volume firstid="0" lastid="11">[\\s\\S]*?key="extruder" value="1"[\\s\\S]*?` +
        `<volume firstid="12" lastid="47">[\\s\\S]*?key="extruder" value="2"`,
      ),
    );
  });

  it('keeps holder = Extruder 1 and insert = Extruder 2 on insert molds even when insert has >2x triangles, while preserving non-mold bodies', () => {
    const HOLDER_RGBA = [0.86, 0.7, 0.48, 1];
    const INSERT_RGBA = [0.95, 0.93, 0.82, 1];
    const STANDOFF_RGBA = [0.25, 0.65, 0.35, 1];

    const subdividedMeshBox = (name: string, [cx, cy, cz]: number[], [hx, hy, hz]: number[], rgba: number[], sub = 1) => {
      const renderVertices: number[] = [];
      const faces: number[] = [];
      const dx = (2 * hx) / sub;
      for (let i = 0; i < sub; i++) {
        const x0 = cx - hx + i * dx;
        const x1 = x0 + dx;
        const base = renderVertices.length / 3;
        renderVertices.push(
          x0, cy - hy, cz - hz, x1, cy - hy, cz - hz, x1, cy + hy, cz - hz, x0, cy + hy, cz - hz,
          x0, cy - hy, cz + hz, x1, cy - hy, cz + hz, x1, cy + hy, cz + hz, x0, cy + hy, cz + hz,
        );
        for (const t of [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]) {
          faces.push(base + t);
        }
      }
      return { name, type: 'mesh' as const, rgba, renderVertices, faces };
    };

    // Holder has 12 triangles; the two insert pieces have 24 + 24 = 48 triangles (4x holder!),
    // and non-mold `standoff` has 60 triangles (5x holder!).
    const insertScene: SceneGraph = {
      nodes: [
        {
          id: 'standoff', name: 'Standoff', type: 'body', pos: [0.12, 0, 0.01], joints: [], children: [],
          geoms: [subdividedMeshBox('standoff_g', [0, 0, 0], [0.01, 0.01, 0.01], STANDOFF_RGBA, 5)],
        } as unknown as SceneNode,
        {
          id: 'mold', name: 'Simulated: Mold', type: 'body', pos: [0, 0, 0], joints: [], children: [],
          simulation: { kind: 'mold', createdAt: '2026-11-17T00:00:00Z' },
          geoms: [
            subdividedMeshBox('Cavity Half holder', [0, 0, 0.01], [0.03, 0.03, 0.01], HOLDER_RGBA, 1),
            subdividedMeshBox('Cavity Half insert, piece 1 of 2 (bottom)', [0, 0, 0.012], [0.01, 0.01, 0.004], INSERT_RGBA, 2),
            subdividedMeshBox('Cavity Half insert, piece 2 of 2 (top)', [0, 0, 0.018], [0.01, 0.01, 0.002], INSERT_RGBA, 2),
          ],
        } as unknown as SceneNode,
      ],
    };

    const result = exportPrintFiles(insertScene, {
      format: '3mf',
      plate: true,
      bed: { widthMm: 256, depthMm: 256 },
      moldParts: true,
    });
    expect(result.parts.map((p) => p.name)).toEqual([
      'Standoff',
      'Cavity Half holder',
      'Cavity Half insert, piece 1 of 2 (bottom)',
      'Cavity Half insert, piece 2 of 2 (top)',
    ]);

    // Palette slot 1 = holder (12 tris), slot 2 = inserts (48 tris), slot 3 = standoff (60 tris).
    expect(result.filaments?.[0].map((f) => [f.extruder, f.triangles])).toEqual([
      [1, 12],
      [2, 48],
      [3, 60],
    ]);

    const archive = unzipSync(result.files[0].bytes) as Record<string, Uint8Array>;
    const text = (p: string) => new TextDecoder().decode(archive[p]);
    const model = text('3D/3dmodel.model');
    const bambu = text('Metadata/model_settings.config');
    const prusa = text('Metadata/Slic3r_PE_model.config');

    expect(model.match(/<item /g)).toHaveLength(4);
    // All 4 parts rest on Z = 0 without overlapping on the bed.
    const boxes = [...model.matchAll(/<object id="\d+"[^>]*><mesh>([\s\S]*?)<\/mesh><\/object>/g)]
      .map((m) => extent([...m[1].matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((v) => [+v[1], +v[2], +v[3]])));
    expect(boxes).toHaveLength(4);
    for (const b of boxes) expect(b.min[2]).toBeCloseTo(0, 3);

    const partExtruder = (cfg: string, name: string) => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const m = cfg.match(new RegExp(`value="${escaped}"\\/>\\s*<metadata[^>]*key="extruder" value="(\\d+)"`));
      return m ? +m[1] : -1;
    };
    expect(partExtruder(bambu, 'Cavity Half holder')).toBe(1);
    expect(partExtruder(bambu, 'Cavity Half insert, piece 1 of 2 (bottom)')).toBe(2);
    expect(partExtruder(bambu, 'Cavity Half insert, piece 2 of 2 (top)')).toBe(2);
    expect(partExtruder(bambu, 'Standoff')).toBe(3);

    expect(partExtruder(prusa, 'Cavity Half holder')).toBe(1);
    expect(partExtruder(prusa, 'Cavity Half insert, piece 1 of 2 (bottom)')).toBe(2);
    expect(partExtruder(prusa, 'Cavity Half insert, piece 2 of 2 (top)')).toBe(2);
    expect(partExtruder(prusa, 'Standoff')).toBe(3);
  });

  it('welds non-indexed printExport meshes so a closed cube has 8 vertices and 12 triangles', () => {
    const result = exportPrintFiles(scene, { format: '3mf', ids: ['cube'] });
    const model = new TextDecoder().decode((unzipSync(result.files[0].bytes) as Record<string, Uint8Array>)['3D/3dmodel.model']);
    const verts = model.match(/<vertex /g)?.length ?? 0;
    const tris = model.match(/<triangle /g)?.length ?? 0;
    expect(verts).toBe(8);
    expect(tris).toBe(12);
    expect(verts).toBeLessThan(tris);
  });

  it('does not explode flat-walled painted meshes on STL or 3MF export and keeps 3MF watertight', async () => {
    const {
      paintMeshResolution, subdivideMeshForPaint, emptyCanvas, layerFromCanvas,
    } = await import('../src/utils/vertexPaint');

    // A 120 × 120 × 40 mm flat-walled mesh box (12 triangles) whose top face
    // (+Z = +0.02) is painted blue on a red body — the same PaintLayer shape
    // `sectionPaint` leaves on multi-colour Split for Print sections.
    const hx = 0.06, hy = 0.06, hz = 0.02;
    const renderVertices = [
      -hx, -hy, -hz,  hx, -hy, -hz,  hx,  hy, -hz, -hx,  hy, -hz,
      -hx, -hy,  hz,  hx, -hy,  hz,  hx,  hy,  hz, -hx,  hy,  hz,
    ];
    const faces = [
      0, 2, 1, 0, 3, 2, // bottom (-Z)
      4, 5, 6, 4, 6, 7, // top (+Z)
      0, 1, 5, 0, 5, 4,
      1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6,
      3, 0, 4, 3, 4, 7,
    ];
    const res = paintMeshResolution(renderVertices);
    const fullSub = subdivideMeshForPaint(renderVertices, faces, res);
    const fullTriCount = fullSub.faces.length / 3;
    // Sanity check: the raw paint subdivision IS huge (>10k tris on this box).
    expect(fullTriCount).toBeGreaterThan(10_000);

    const canvas = emptyCanvas(fullSub.positions.length / 3, res);
    for (let v = 0; v < canvas.count; v++) {
      // Paint the top face (+Z) blue.
      if (Math.abs(fullSub.positions[v * 3 + 2] - hz) < 1e-5) {
        canvas.data.set([0.1, 0.2, 0.9, 1], v * 4);
      }
    }
    const paint = layerFromCanvas(canvas)!;

    const paintedScene: SceneGraph = {
      nodes: [{
        id: 'section1', name: 'section1', type: 'body', pos: [0, 0, 0.02], joints: [], children: [],
        geoms: [{
          name: 'section1_mesh', type: 'mesh', rgba: [0.8, 0.1, 0.1, 1],
          dynamic: true, renderVertices, faces, paint,
        }],
      }],
    };

    // 1. Monochrome STL must skip paint subdivision completely: exact 12 triangles.
    const stlRes = exportPrintFiles(paintedScene, { format: 'stl' });
    expect(stlRes.parts[0].triangles).toBe(12);
    const stlView = new DataView(stlRes.files[0].bytes.buffer, stlRes.files[0].bytes.byteOffset, stlRes.files[0].bytes.byteLength);
    expect(stlView.getUint32(80, true)).toBe(12);

    // 2. 3MF must coarsen uniform flat faces (far below the full paint mesh),
    //    preserve both colours, and stay a closed 2-manifold (zero T-junctions).
    const threeMfRes = exportPrintFiles(paintedScene, { format: '3mf' });
    expect(threeMfRes.filaments?.[0].length).toBe(2);
    const model = new TextDecoder().decode((unzipSync(threeMfRes.files[0].bytes) as Record<string, Uint8Array>)['3D/3dmodel.model']);
    const triMatches = [...model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"([^>]*)\/>/g)];
    expect(triMatches.length).toBeLessThan(fullTriCount / 10);
    expect(model).toMatch(/paint_color="8"/);

    // Verify closed 2-manifold (every directed edge has an exact reverse partner).
    const edgeCounts = new Map<string, number>();
    for (const m of triMatches) {
      const vs = [+m[1], +m[2], +m[3]];
      for (let e = 0; e < 3; e++) {
        const a = vs[e], b = vs[(e + 1) % 3];
        const key = `${a}->${b}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of edgeCounts) {
      expect(count, `duplicate directed edge ${key}`).toBe(1);
      const [a, b] = key.split('->');
      expect(edgeCounts.get(`${b}->${a}`), `open/T-junction edge ${key}`).toBe(1);
    }

    // 3. A mesh whose paint is below the 0.5 print threshold collapses all the
    //    way back to the exact original 12 triangles in 3MF as well.
    const faintCanvas = emptyCanvas(fullSub.positions.length / 3, res);
    faintCanvas.data.set([0.1, 0.2, 0.9, 0.2], 0);
    const faintScene: SceneGraph = {
      nodes: [{
        id: 'section2', name: 'section2', type: 'body', pos: [0, 0, 0.02], joints: [], children: [],
        geoms: [{
          name: 'section2_mesh', type: 'mesh', rgba: [0.8, 0.1, 0.1, 1],
          dynamic: true, renderVertices, faces, paint: layerFromCanvas(faintCanvas)!,
        }],
      }],
    };
    const faintRes = exportPrintFiles(faintScene, { format: '3mf' });
    expect(faintRes.parts[0].triangles).toBe(12);
  });

  it('preserves all 6+ distinct body colours by default and warns when filaments explicitly caps them', () => {
    const colours: [number, number, number, number][] = [
      [1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, 0, 1, 1],
      [1, 1, 0, 1],
      [1, 0, 1, 1],
      [0, 1, 1, 1],
    ];
    const sixColourScene: SceneGraph = {
      nodes: colours.map((rgba, i) => ({
        id: `b${i}`,
        name: `Body ${i + 1}`,
        type: 'body',
        pos: [i * 0.03, 0, 0.01],
        joints: [],
        children: [],
        geoms: [{ name: `g${i}`, type: 'box', size: [0.005, 0.005, 0.005], rgba }],
      })),
    };

    const uncapped = exportPrintFiles(sixColourScene, { format: '3mf' });
    expect(uncapped.filaments?.[0]).toHaveLength(6);
    expect(uncapped.warnings.some((w) => /quantized/i.test(w))).toBe(false);

    const capped = exportPrintFiles(sixColourScene, { format: '3mf', filaments: 4 });
    expect(capped.filaments?.[0]).toHaveLength(4);
    expect(capped.warnings.some((w) => /quantized 6 distinct body colours into 4 filament slots/i.test(w))).toBe(true);
  });
});

describe('SPLIT_FOR_PRINT MCP metadata and naming', () => {
  it('exposes consistent 1-based section/cut/joint numbers alongside 0-based indices and supports name / scene-name defaults', async () => {
    const { useStore } = await import('../src/store/useStore');
    const longScene: SceneGraph = {
      name: 'Victorian Dollhouse',
      nodes: [
        body('floor1', [0, 0, 0.02], [0.15, 0.05, 0.02]),
        body('wall1', [0, 0, 0.06], [0.15, 0.05, 0.02]),
      ],
    };
    const fakeStore = {
      sceneGraph: longScene,
      selectedNodeId: 'floor1',
      printBed: { widthMm: 200, depthMm: 200, heightMm: 200 },
      filament: 'pla',
    } as unknown as PhysicsState;
    const ctx = { store: fakeStore, toId: (v: unknown) => v };

    // 1. Consistent 1-based numbering alongside 0-based indices (preview, no apply)
    const preview = await castCommands.SPLIT_FOR_PRINT({
      bodyId: 'floor1',
      joinery: 'peg',
      bedMm: [200, 200, 200],
    }, ctx) as {
      ok: boolean;
      sections: { index: number; sectionNumber: number }[];
      cuts: { index: number; cutNumber: number }[];
      joints: { between: number[]; betweenSections: number[]; pegsOn?: number; pegsOnSection?: number }[];
    };
    expect(preview.ok).toBe(true);
    expect(preview.sections.map((s) => [s.index, s.sectionNumber])).toEqual([[0, 1], [1, 2]]);
    expect(preview.cuts.map((c) => [c.index, c.cutNumber])).toEqual([[0, 1]]);
    expect(preview.joints[0].between).toEqual([0, 1]);
    expect(preview.joints[0].betweenSections).toEqual([1, 2]);
    expect(preview.joints[0].pegsOnSection).toBe((preview.joints[0].pegsOn ?? -1) + 1);

    // 2. Invalid empty name rejected
    const badName = await castCommands.SPLIT_FOR_PRINT({ bodyId: 'floor1', name: '   ' }, ctx) as { ok: boolean };
    expect(badName.ok).toBe(false);

    // 3. Naming behavior on apply: explicit `name`, `withIds` scene-name fallback, and single-body default
    const calls: { names?: string[] }[] = [];
    const origSplit = useStore.getState().splitBodyForPrint;
    useStore.setState({
      splitBodyForPrint: ((_id, secs, _absorbed, opts) => {
        calls.push({ names: opts?.names });
        return secs.map((_, i) => `id_${i}`);
      }) as PhysicsState['splitBodyForPrint'],
    });
    try {
      await castCommands.SPLIT_FOR_PRINT({ bodyId: 'floor1', name: 'Custom Shell', apply: true }, ctx);
      await castCommands.SPLIT_FOR_PRINT({ bodyId: 'floor1', withIds: ['wall1'], apply: true }, ctx);
      await castCommands.SPLIT_FOR_PRINT({ bodyId: 'floor1', apply: true }, ctx);
    } finally {
      useStore.setState({ splitBodyForPrint: origSplit });
    }
    expect(calls[0].names).toEqual(['Custom Shell_part1', 'Custom Shell_part2']);
    expect(calls[1].names).toEqual(['Victorian Dollhouse_part1', 'Victorian Dollhouse_part2']);
    expect(calls[2].names).toBeUndefined();
  });
});
