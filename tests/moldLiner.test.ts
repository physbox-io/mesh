import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, exportBinarySTL, DEFAULT_MOLD_OPTIONS, moldSummary, type MoldOptions, type Triangle3D } from '../src/utils/moldExporter';
import { envelopeDepth, envelopeSolid, thickestPvaMm, WATER_BASED_REFUSAL, METAL_REFUSAL, castMaterialCheck } from '../src/utils/moldLiner';
import { exportThreeMfAssemblies } from '../src/utils/threeMfExporter';
import type { SceneGraph, SceneGeom } from '../src/types/scene';
import { stlToMesh } from '../src/utils/stlMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { loadManifold } from '../src/utils/sculptCut';
import type { Grid } from '../src/utils/moldColumns';
import { moldOptionsFor } from '../src/utils/moldWorkerClient';

const box = (name: string, half: number[], z: number): SceneGeom =>
  ({ name, type: 'box', size: half, pos: [0, 0, z] }) as SceneGeom;

/**
 * An hourglass: a 40 mm square foot, a 14 mm waist, a 40 mm square head. Poured
 * from either end in one piece, the far end overhangs the waist: an undercut a
 * rigid mold fills in and an exact one locks onto.
 */
const hourglass: SceneGraph = {
  nodes: [
    {
      id: 'b1',
      name: 'hourglass',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        box('foot', [0.02, 0.02, 0.0075], 0.0075),
        box('waist', [0.007, 0.007, 0.0085], 0.0225),
        box('head', [0.02, 0.02, 0.005], 0.036),
      ],
      joints: [],
      children: [],
    },
  ],
};

/** A 50 mm ball: a clamshell whose halves both hold some of it. */
const ball: SceneGraph = {
  nodes: [{ id: 'b1', name: 'ball', type: 'body', pos: [0, 0, 0.03], geoms: [{ name: 'g', type: 'sphere', size: [0.025] } as SceneGeom], joints: [], children: [] }],
};

const OPEN: Partial<MoldOptions> = {
  ...DEFAULT_MOLD_OPTIONS,
  moldType: 'open',
  pullDirection: '+z',
  draftAngleDeg: 0,
  includeVents: false,
  includeSprue: false,
  wallMarginMm: 10,
  baseThicknessMm: 5,
};

const LINED: Partial<MoldOptions> = { ...OPEN, dissolvableLiner: true, linerSkinMm: 1.2, castMaterial: 'epoxy' };

/** Signed volume of a triangle soup, mm³. */
function volumeOf(tris: Triangle3D[]): number {
  let v = 0;
  for (const t of tris) {
    const [a, b, c] = [t.a, t.b, t.c];
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

/** Where a vertical line at (x, y) crosses the soup, ascending. */
function crossings(tris: Triangle3D[], x: number, y: number): number[] {
  const out: number[] = [];
  for (const t of tris) {
    const [a, b, c] = [t.a, t.b, t.c];
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    out.push(l1 * a[2] + l2 * b[2] + l3 * c[2]);
  }
  return out.sort((p, q) => p - q);
}

function integrity(tris: Triangle3D[]) {
  const mesh = stlToMesh(exportBinarySTL(tris));
  return analyzeMesh(Array.from(mesh.positions), Array.from(mesh.faces))!;
}

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

describe('PVA-lined mold', () => {
  it('splits the exact mold into a shell and a liner that add back up to it', () => {
    const lined = generateMoldMeshes(hourglass, LINED, wasm);
    const exact = generateMoldMeshes(hourglass, { ...OPEN, allowUndercuts: true }, wasm);
    expect(lined.success).toBe(true);
    expect(exact.success).toBe(true);
    const half = lined.bottomHalf.liner!;
    expect(half).toBeDefined();

    const shellV = volumeOf(half.shell);
    const linerV = volumeOf(half.liner);
    const exactV = volumeOf(exact.bottomHalf.triangles);
    expect(Math.abs(shellV + linerV - exactV) / exactV).toBeLessThan(0.01);
    expect(lined.liner!.pvaVolumeMm3).toBeCloseTo(linerV, -1);
    expect(lined.liner!.pvaGrams).toBeCloseTo((linerV / 1000) * 1.23, 0);
    // The undercut under the head is held by PVA, not filled in by PLA.
    expect(linerV).toBeGreaterThan(0.25 * (40 * 40 - 14 * 14) * 17);
  });

  it('gives the PLA shell a cavity with no undercut along the pull', () => {
    const res = generateMoldMeshes(hourglass, LINED, wasm);
    const shell = res.bottomHalf.liner!.shell;
    let checked = 0;
    for (let x = -24.7; x <= 24.7; x += 1.31) {
      for (let y = -24.3; y <= 24.3; y += 1.37) {
        const zs = crossings(shell, x, y);
        // Solid from the bed up to the cavity floor, once: no shelf of PLA over any of the cavity.
        expect(zs.length === 0 || zs.length === 2).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('keeps at least the skin of PVA between the casting and the PLA', () => {
    const res = generateMoldMeshes(hourglass, LINED, wasm);
    const { shell, liner } = res.bottomHalf.liner!;
    // Under the far end of the part, the PVA between the PLA floor and the casting.
    for (const [x, y] of [[0.3, 0.2], [12.1, -9.7], [-17.9, 17.3], [5.3, 18.9]]) {
      const floor = crossings(shell, x, y)[1];
      const lin = crossings(liner, x, y);
      expect(lin[0]).toBeCloseTo(floor, 3);
      expect(lin[1] - lin[0]).toBeGreaterThanOrEqual(1.2 - 0.05);
    }
    // Just past the part's side, PVA rather than PLA.
    for (const [x, y] of [[20.6, 0.3], [-0.4, -20.5]]) {
      expect(crossings(liner, x, y).length).toBeGreaterThanOrEqual(2);
    }
  });

  it('builds both solids closed and wound outward', () => {
    for (const [scene, moldType] of [[hourglass, 'open'], [ball, 'clamshell']] as const) {
      const res = generateMoldMeshes(scene, { ...LINED, moldType, includeVents: true, includeSprue: true }, wasm);
      expect(res.success).toBe(true);
      for (const half of [res.bottomHalf, res.topHalf].filter(Boolean)) {
        for (const tris of [half!.liner!.shell, half!.liner!.liner]) {
          const a = integrity(tris);
          expect(a.closed).toBe(true);
          expect(a.consistentlyWound).toBe(true);
          expect(a.volume).toBeGreaterThan(0);
        }
      }
    }
  });

  it('refuses a water-based cast, and warns about a big epoxy pour', () => {
    const res = generateMoldMeshes(hourglass, { ...LINED, castMaterial: 'plaster' }, wasm);
    expect(res.success).toBe(false);
    expect(res.error).toBe(WATER_BASED_REFUSAL);
    expect(castMaterialCheck('concrete', 10).error).toBe(WATER_BASED_REFUSAL);
    expect(castMaterialCheck('epoxy', 150).warnings).toHaveLength(0);
    expect(castMaterialCheck('epoxy', 250).warnings[0]).toMatch(/60 °C/);
    expect(castMaterialCheck('platinum', 900)).toEqual({ warnings: [] });
    expect(castMaterialCheck('aluminium', 10).error).toBe(METAL_REFUSAL);
  });

  it('fails in one sentence without the geometry engine', () => {
    const res = generateMoldMeshes(hourglass, LINED, null);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/geometry engine/);
  });

  it('reports the liner, and says how long it takes to dissolve', () => {
    const res = generateMoldMeshes(hourglass, LINED, wasm);
    const info = moldSummary(res).liner!;
    expect(info.castVolumeMl).toBeCloseTo((40 * 40 * 15 + 14 * 14 * 17 + 40 * 40 * 10) / 1000, 0);
    // The PVA under the head reaches 13 mm in from its rim to the waist.
    expect(info.thickestPvaMm).toBeGreaterThan(10);
    expect(info.thickestPvaMm).toBeLessThan(20);
    expect(info.dissolveHours).toBeGreaterThanOrEqual(Math.ceil(info.thickestPvaMm));
    expect(info.steps.join(' ')).toMatch(/filament 2/);
  });

  it('writes a 3MF with the shell on extruder 1 and the liner on extruder 2', () => {
    const res = generateMoldMeshes(ball, { ...LINED, moldType: 'clamshell' }, wasm);
    expect(res.topHalf?.liner?.liner.length).toBeGreaterThan(0);
    const files = unzipSync(res.threeMf!);
    const model = strFromU8(files['3D/3dmodel.model']);
    const bambu = strFromU8(files['Metadata/model_settings.config']);
    const prusa = strFromU8(files['Metadata/Slic3r_PE_model.config']);
    // Two halves, each an object of two mesh parts.
    expect(model.match(/<components>/g)).toHaveLength(2);
    expect(model.match(/<mesh>/g)).toHaveLength(4);
    expect(bambu.match(/<part id="\d+" subtype="normal_part">/g)).toHaveLength(4);
    expect(bambu.match(/key="extruder" value="2"/g)).toHaveLength(2);
    expect(prusa.match(/<object id="\d+"/g)).toHaveLength(4);
    expect(prusa.match(/type="volume" key="extruder" value="2"/g)).toHaveLength(2);
  });

  it('leaves an unlined mold exactly as it was', () => {
    const res = generateMoldMeshes(hourglass, OPEN, wasm);
    expect(res.liner).toBeUndefined();
    expect(res.threeMf).toBeUndefined();
    expect(res.bottomHalf.liner).toBeUndefined();
  });
});

describe('liner envelope', () => {
  const grid: Grid = { cols: 21, rows: 21, stepX: 1, stepY: 1, halfW: 10, halfD: 10 };

  it('grows a cavity by the skin, out and down', () => {
    const depth = new Float64Array(21 * 21);
    depth[10 * 21 + 10] = 5;
    const env = envelopeDepth(depth, grid, 1.2, 100);
    expect(env[10 * 21 + 10]).toBeCloseTo(6.2);
    // Within the skin plus half a grid diagonal of the hole it is as deep; beyond, untouched.
    expect(env[10 * 21 + 11]).toBeCloseTo(6.2);
    expect(env[11 * 21 + 11]).toBeCloseTo(6.2);
    expect(env[10 * 21 + 12]).toBe(0);
    // And never through the floor.
    expect(envelopeDepth(depth, grid, 1.2, 4)[10 * 21 + 10]).toBe(4);
  });

  it('is a closed solid wound outward', () => {
    const depth = new Float64Array(21 * 21);
    for (let r = 5; r < 15; r++) for (let c = 5; c < 15; c++) depth[r * 21 + c] = 3;
    const solid = envelopeSolid(wasm, grid, depth);
    expect(solid.status()).toBe('NoError');
    expect(solid.volume()).toBeGreaterThan(20 * 20 * 0.5);
    solid.delete();
  });

  it('measures how far water has to get into the PVA', () => {
    // A 9 x 9 mm block of PVA, 4 mm deep, with nothing cast in it: water on
    // every side once the shell is off, so nowhere is more than 2 mm in.
    const env = new Float64Array(21 * 21);
    for (let r = 6; r <= 14; r++) for (let c = 6; c <= 14; c++) env[r * 21 + c] = 4;
    const none = new Array(21 * 21).fill(new Float64Array(0));
    const open = thickestPvaMm(env, none, grid);
    expect(open).toBeGreaterThan(1.5);
    expect(open).toBeLessThan(2.6);
    // Cast a 1 mm skin over all of its top and water no longer gets in from
    // there: the middle is then 3 mm from the bottom.
    const cast = none.map((_, i) => (env[i] > 0 ? Float64Array.from([-1, 0]) : new Float64Array(0)));
    expect(thickestPvaMm(env, cast, grid)).toBeGreaterThan(2.5);
  });
});

describe('3MF assemblies', () => {
  it('names each part its extruder and keeps the triangle ranges whole', () => {
    const tetra = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), indices: new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]) };
    const res = exportThreeMfAssemblies([
      { name: 'Mold', parts: [{ name: 'shell', extruder: 1, ...tetra }, { name: 'liner', extruder: 2, ...tetra }] },
    ]);
    expect(res.extruders).toEqual([1, 2]);
    expect(res.triangles).toBe(8);
    const files = unzipSync(res.data);
    const model = strFromU8(files['3D/3dmodel.model']);
    expect(model).toContain('<object id="3" type="model" name="Mold"><components><component objectid="1"/><component objectid="2"/></components></object>');
    expect(model).toContain('<item objectid="3"/>');
    const bambu = strFromU8(files['Metadata/model_settings.config']);
    expect(bambu).toContain('<object id="3">');
    expect(bambu).toMatch(/<part id="2" subtype="normal_part">\s*<metadata key="name" value="liner"\/>\s*<metadata key="extruder" value="2"\/>/);
    const prusa = strFromU8(files['Metadata/Slic3r_PE_model.config']);
    expect(prusa).toMatch(/<object id="2" instances_count="1">[\s\S]*?<volume firstid="0" lastid="3">/);
    expect(strFromU8(files['[Content_Types].xml'])).toContain('Extension="config"');
  });
});

describe('MCP mold options', () => {
  it('passes the liner through, and refuses a cast material it does not know', () => {
    const { options } = moldOptionsFor({ kind: 'mold', dissolvableLiner: true, linerSkinMm: 1.6, castMaterial: 'plaster' });
    expect(options).toMatchObject({ dissolvableLiner: true, linerSkinMm: 1.6, castMaterial: 'plaster' });
    const lava = moldOptionsFor({ castMaterial: 'lava', linerSkinMm: -1 });
    expect(lava.options).not.toHaveProperty('castMaterial');
    expect(lava.error).toMatch(/cast_material is one of epoxy, polyurethane, platinum/);
    expect(moldOptionsFor({ castMaterial: 'bronze' }).error).toMatch(/metals go in sand/);
    expect(moldOptionsFor({ castMaterial: 'silicone' }).options.castMaterial).toBe('platinum');
    expect(moldOptionsFor({ linerSkinMm: -1 }).options).not.toHaveProperty('linerSkinMm');
  });
});
