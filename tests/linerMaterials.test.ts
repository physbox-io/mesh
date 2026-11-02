// A lined mold in the filaments the printer has: PLA + PVA, PLA + BVOH,
// PETG + PVA or ABS + HIPS. The 3MF, the weights, the solvent, the dissolve
// time and what may be poured in all follow from the pair.

import { describe, it, expect, beforeAll } from 'vitest';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, moldSummary, DEFAULT_MOLD_OPTIONS, type MoldOptions } from '../src/utils/moldExporter';
import { castMaterialCheck, WATER_BASED_REFUSAL } from '../src/utils/moldLiner';
import { resolveLinerPair, linerPair } from '../src/utils/linerMaterials';
import { moldOptionsFor } from '../src/utils/moldWorkerClient';
import { loadManifold } from '../src/utils/sculptCut';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

const box = (name: string, half: number[], z: number): SceneGeom => ({ name, type: 'box', size: half, pos: [0, 0, z] }) as SceneGeom;
const hourglass: SceneGraph = {
  nodes: [{ id: 'b1', name: 'hourglass', type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms: [
    box('foot', [0.02, 0.02, 0.0075], 0.0075), box('waist', [0.007, 0.007, 0.0085], 0.0225), box('head', [0.02, 0.02, 0.005], 0.036),
  ] }],
};
const LINED: Partial<MoldOptions> = {
  ...DEFAULT_MOLD_OPTIONS, moldType: 'open', pullDirection: '+z', includeVents: false, includeSprue: false,
  dissolvableLiner: true, castMaterial: 'epoxy',
};

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

describe('liner pairs', () => {
  it('names the filaments, the solvent and the weights for the pair', () => {
    const res = generateMoldMeshes(hourglass, { ...LINED, linerPair: 'abs_hips' }, wasm);
    const info = res.liner!;
    expect([info.shellMaterial, info.linerMaterial, info.solvent]).toEqual(['ABS', 'HIPS', 'd-limonene']);
    expect(info.linerGrams).toBeCloseTo((info.linerVolumeMm3 / 1000) * 1.04, 0);
    expect(info.steps.join(' ')).toMatch(/HIPS liner in d-limonene/);
    const model = strFromU8(unzipSync(res.threeMf!)['3D/3dmodel.model']);
    expect(model).toContain('shell (ABS)');
    expect(model).toContain('liner (HIPS)');
    expect(moldSummary(res).parts.map((p) => p.material)).toEqual(['ABS', 'HIPS']);
  });

  it('takes its dissolve time from the liner: BVOH faster than PVA, HIPS slower', () => {
    const hours = (linerPairId: MoldOptions['linerPair']) => generateMoldMeshes(hourglass, { ...LINED, linerPair: linerPairId }, wasm).liner!.dissolveHours;
    expect(hours('pla_bvoh')).toBeLessThan(hours('pla_pva'));
    expect(hours('abs_hips')).toBeGreaterThan(hours('pla_pva'));
  });

  it('lets a water-based cast into a liner water does not dissolve', () => {
    expect(castMaterialCheck('plaster', 50, 'pla_pva').error).toBe(WATER_BASED_REFUSAL);
    expect(castMaterialCheck('plaster', 50, 'abs_hips').error).toBeUndefined();
    const res = generateMoldMeshes(hourglass, { ...LINED, linerPair: 'abs_hips', castMaterial: 'plaster' }, wasm);
    expect(res.success).toBe(true);
  });

  it('warns of a hot pour against the pair, not always against PLA', () => {
    expect(castMaterialCheck('wax', 50, 'pla_pva').warnings.join(' ')).toMatch(/60 °C/);
    expect(castMaterialCheck('wax', 50, 'abs_hips').warnings.join(' ')).not.toMatch(/softening/);
  });

  it('is taken over MCP in any reasonable spelling, and refused when unknown', () => {
    expect(resolveLinerPair('ABS + HIPS')).toBe('abs_hips');
    expect(resolveLinerPair('petg-pva')).toBe('petg_pva');
    expect(moldOptionsFor({ linerMaterial: 'PLA+BVOH' }).options.linerPair).toBe('pla_bvoh');
    expect(moldOptionsFor({ linerMaterial: 'nylon' }).error).toMatch(/liner_material is one of/);
    expect(linerPair(undefined).id).toBe('pla_pva');
  });
});
