// A casting keeps no section thinner than its material fills or a printed mold
// draws. An agent molded a gear with 0.4 mm tooth tips and 0.6 mm spokes and
// heard nothing; the DFM casting lens now says so, and CHECK_DFM tells an
// agent the same.

import { describe, it, expect } from 'vitest';
import { analyseDfm, PRINTED_DETAIL_MM } from '../src/utils/dfm';
import { castMaterial } from '../src/utils/castMaterials';
import { dfmCommands } from '../src/hooks/mcp/dfmCommands';
import { useStore } from '../src/store/useStore';
import type { SceneGraph } from '../src/types/scene';

/** A 40 x 40 mm plate `mm` thick. */
const plate = (mm: number): SceneGraph => ({
  nodes: [{ id: 'p', name: 'plate', type: 'body', pos: [0, 0, mm / 2000], joints: [], children: [],
    geoms: [{ name: 'g', type: 'box', size: [0.02, 0.02, mm / 2000] }] }],
});

const thin = (scene: SceneGraph, castMaterialId?: Parameters<typeof castMaterial>[0]) =>
  analyseDfm(scene, 'cast', castMaterialId ? { castMaterial: castMaterialId } : {}).findings.find((f) => f.id === 'cast_thin_section');

describe('the casting lens', () => {
  it('flags a section under what a printed mold draws', () => {
    const f = thin(plate(0.6));
    expect(f).toBeDefined();
    expect(f!.detail).toMatch(/0\.6\d mm/);
  });

  it('judges against the material: fine in resin, too thin in plaster', () => {
    expect(thin(plate(2))).toBeUndefined();
    const f = thin(plate(2), 'plaster');
    expect(f).toBeDefined();
    expect(f!.fix).toMatch(/3 mm/);
  });

  it('never asks for less than a printed mold can hold', () => {
    expect(castMaterial('silver').minSectionMm).toBeLessThanOrEqual(PRINTED_DETAIL_MM + 0.2);
    expect(thin(plate(0.7), 'silver')).toBeDefined();
  });
});

describe('CHECK_DFM', () => {
  const run = (scene: SceneGraph, msg: Record<string, unknown>) =>
    dfmCommands.CHECK_DFM(msg, { store: { ...useStore.getState(), sceneGraph: scene }, toId: (v: unknown) => v } as never) as Promise<Record<string, unknown>>;

  it('reports the findings of master_id for the process asked, in mm', async () => {
    const res = await run(plate(0.6), { process: 'cast', masterId: 'plate' });
    expect(res.ok).toBe(true);
    const findings = res.findings as { id: string; atMm: number[] }[];
    const f = findings.find((x) => x.id === 'cast_thin_section');
    expect(f).toBeDefined();
    expect(f!.atMm.every((v) => Math.abs(v) < 100)).toBe(true);
  });

  it('refuses a process or material it does not know', async () => {
    expect((await run(plate(2), { process: 'weld' })).ok).toBe(false);
    expect((await run(plate(2), { process: 'cast', castMaterial: 'cheese' })).ok).toBe(false);
  });
});
