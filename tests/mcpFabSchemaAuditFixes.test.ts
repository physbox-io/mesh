import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';

// Mock worker clients & settleScene so unit tests stay fast and deterministic.
let settleResult: { ok: boolean; error?: string } = { ok: true };
let settleCalls = 0;

vi.mock('../src/hooks/mcp/settleScene', () => ({
  settleScene: vi.fn(async () => {
    settleCalls++;
    return settleResult;
  }),
}));

vi.mock('../src/utils/exportWorkerClient', () => ({
  ExportWorkerClient: class {
    run(kind: string) {
      if (kind === 'relief') {
        return Promise.resolve({
          success: true,
          gcode: 'G21\nG90\nT1 M06\nG0 Z5\n',
          heightMode: 'model',
          scaleFactor: 1,
          reliefDepthMm: 5,
          roughingPassCount: 1,
          roughingBitePercent: 40,
          roughingTimeSeconds: 10,
          finishingRasterLines: 20,
          estimatedTimeSeconds: 30,
          totalCutDistanceMm: 100,
          toolChange: true,
          warnings: [],
        });
      }
      if (kind === 'solid') {
        return Promise.resolve({
          success: true,
          stock: { widthMm: 100, depthMm: 100, thicknessMm: 20 },
          partSizeMm: { x: 40, y: 40, z: 10 },
          partVolumeMm3: 16000,
          unreachablePercent: 0,
          tabsPlaced: 2,
          estimatedTimeSeconds: 60,
          totalCutDistanceMm: 200,
          sides: [{ side: 'A', depthMm: 10, gcode: 'G21\n' }],
          warnings: [],
        });
      }
      return Promise.reject(new Error(`mock worker failure for ${kind}`));
    }
    dispose() {}
  },
}));

vi.mock('../src/utils/brickworkClient', () => ({
  layBricksOffThread: vi.fn(async () => ({
    nodes: [{ id: 'brick_1', name: 'Brick', type: 'body', pos: [0, 0, 0], geoms: [], joints: [], children: [] }],
    result: {
      standard: { label: 'UK Standard' },
      bondType: 'stretcher',
      jointMm: 10,
      courses: 2,
      builtHeightMm: 150,
      modelHeightMm: 150,
      bricks: [{}],
      whole: 1,
      cutPieces: 0,
      closers: 0,
      toBuy: 1,
      cuts: 0,
      mortarLitres: 1,
      mortarBags: 1,
      lintels: 0,
      bond: 'stretcher',
      warnings: [],
    },
  })),
}));

const { useStore } = await import('../src/store/useStore');
const { reliefOptionsFor, machiningOptionsFor } = await import('../src/hooks/mcp/exportOptions');
const { machiningCommands } = await import('../src/hooks/mcp/machiningCommands');
const { cutCommands } = await import('../src/hooks/mcp/cutCommands');
const { castCommands } = await import('../src/hooks/mcp/castCommands');
const { slipCommands } = await import('../src/hooks/mcp/slipCommands');
const { partBuildCommands } = await import('../src/hooks/mcp/partBuildCommands');
const { brickCommands } = await import('../src/hooks/mcp/brickCommands');

const boxNode = (id: string, name: string, x = 0): SceneNode => ({
  id,
  name,
  type: 'body',
  pos: [x, 0, 0.02],
  joints: [],
  children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.02, 0.02, 0.02] }],
});

const scene: SceneGraph = {
  nodes: [
    // Deliberately put a node whose `name` matches another node's `id` earlier in DFS order
    boxNode('first_id', 'target_id', 0),
    boxNode('target_id', 'Real Target', 0.1),
  ],
};

function makeCtx(customScene = scene) {
  const store = { ...useStore.getState(), sceneGraph: customScene };
  // Exact-id-first toId resolver (matching useMCPBridge.ts)
  const toId = (v: unknown) => {
    if (typeof v !== 'string') return v;
    const byId = customScene.nodes.find((n) => n.id === v);
    if (byId) return byId.id;
    const byName = customScene.nodes.find((n) => n.name === v);
    return byName ? byName.id : v;
  };
  return { store, toId } as never;
}

beforeEach(() => {
  settleResult = { ok: true };
  settleCalls = 0;
  useStore.getState().setStock({ widthMm: 300, depthMm: 200, thicknessMm: 20 });
});

describe('1. Prototype-chain lookup fixes (Object.hasOwn)', () => {
  it('rejects Object.prototype keys in SYNC_PCB_ENCLOSURE, BREAKDOWN_PIPE_FRAME, BUILD_PIPE_FRAME, BUILD_BRICKWORK', async () => {
    const ctx = makeCtx();
    const pcb = await partBuildCommands.SYNC_PCB_ENCLOSURE({ preset: 'constructor' }, ctx) as { ok: boolean; error?: string };
    expect(pcb.ok).toBe(false);
    expect(pcb.error).toMatch(/Unknown PCB preset/);

    const bp = await partBuildCommands.BREAKDOWN_PIPE_FRAME({ pipeStandardId: 'toString' }, ctx) as { ok: boolean; error?: string };
    expect(bp.ok).toBe(false);
    expect(bp.error).toMatch(/Unknown pipeStandardId/);

    const buildPipe = await partBuildCommands.BUILD_PIPE_FRAME({ pipeStandardId: 'toString' }, ctx) as { ok: boolean; error?: string };
    expect(buildPipe.ok).toBe(false);
    expect(buildPipe.error).toMatch(/Unknown pipeStandardId/);

    const brick = await brickCommands.BUILD_BRICKWORK({ standardId: 'toString' }, ctx) as { ok: boolean; error?: string };
    expect(brick.ok).toBe(false);
    expect(brick.error).toMatch(/standardId is one of/);
  });
});

describe('2. Body-name resolution (toId), non-string masterId/bodyId rejection & withIds checks', () => {
  it('resolves arborId by body name in BUILD_MECHANISM', async () => {
    const arborScene: SceneGraph = {
      nodes: [{
        id: 'arbor_42',
        name: 'Main Shaft',
        type: 'body',
        pos: [0, 0, 0.05],
        joints: [{ name: 'arbor_hinge', type: 'hinge', axis: [0, 0, 1] }],
        children: [],
        geoms: [{ name: 'shaft_g', type: 'cylinder', size: [0.004, 0.02] }],
      }],
    };
    const res = await partBuildCommands.BUILD_MECHANISM(
      { family: 'gear', teeth: 16, moduleMm: 2, arborId: 'Main Shaft' },
      makeCtx(arborScene),
    ) as { ok: boolean; arborId?: string; error?: string };
    expect(res.ok).toBe(true);
    expect(res.arborId).toBe('arbor_42');
  });

  it('uses toId in EXPORT_RELIEF and EXPORT_MACHINING and rejects non-string masterId/bodyId', async () => {
    const ctx = makeCtx();
    const badRelief = await machiningCommands.EXPORT_RELIEF({ masterId: ['a'] }, ctx) as { ok: boolean; error?: string };
    expect(badRelief.ok).toBe(false);
    expect(badRelief.error).toMatch(/masterId must be a string/);

    const badMach = await machiningCommands.EXPORT_MACHINING({ masterId: 123 }, ctx) as { ok: boolean; error?: string };
    expect(badMach.ok).toBe(false);
    expect(badMach.error).toMatch(/masterId must be a string/);

    const badCast = await castCommands.EXPORT_CAST({ masterId: ['target_id'] }, ctx) as { ok: boolean; error?: string };
    expect(badCast.ok).toBe(false);
    expect(badCast.error).toMatch(/masterId must be a string/);

    const badSlip = await slipCommands.MAKE_SLIP_MOLD({ masterId: { id: 'a' } }, ctx) as { ok: boolean; error?: string };
    expect(badSlip.ok).toBe(false);
    expect(badSlip.error).toMatch(/must be a string/);

    const badBrick = await brickCommands.BUILD_BRICKWORK({ bodyId: 99 }, ctx) as { ok: boolean; error?: string };
    expect(badBrick.ok).toBe(false);
    expect(badBrick.error).toMatch(/bodyId must be a string/);

    const badCut = await cutCommands.EXPORT_CUT({ kind: 'unfold', masterId: ['a'] }, ctx) as { ok: boolean; error?: string };
    expect(badCut.ok).toBe(false);
    expect(badCut.error).toMatch(/masterId must be a string/);
  });

  it('rejects unknown withIds in TIMBER_BREAKDOWN and ADD_SIMULATION kind=timber', async () => {
    const ctx = makeCtx();
    const timberRes = await partBuildCommands.TIMBER_BREAKDOWN(
      { bodyId: 'target_id', withIds: ['nonexistent_rail'] },
      ctx,
    ) as { ok: boolean; error?: string };
    expect(timberRes.ok).toBe(false);
    expect(timberRes.error).toMatch(/No body called nonexistent_rail/);

    const simRes = await machiningCommands.ADD_SIMULATION(
      { kind: 'timber', bodyId: 'target_id', withIds: ['ghost_leg'] },
      ctx,
    ) as { ok: boolean; error?: string };
    expect(simRes.ok).toBe(false);
    expect(simRes.error).toMatch(/No body called ghost_leg/);
  });
});

describe('3. BREAKDOWN_PIPE_FRAME unknown preset does not wipe scene', () => {
  it('rejects unknown preset before calling settleScene', async () => {
    const res = await partBuildCommands.BREAKDOWN_PIPE_FRAME({ preset: 'bogus_tent' }, makeCtx()) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Unknown preset/);
    expect(settleCalls).toBe(0);
  });
});

describe('4. Strict numeric, range, material and enum validation', () => {
  it('exportOptions validates material, sides, finite positives, and enums', () => {
    expect(() => reliefOptionsFor({ material: 'steel' })).toThrow(/Unknown material/);
    expect(() => reliefOptionsFor({ material: 'aluminum' })).toThrow(/Unknown material/);
    expect(() => reliefOptionsFor({ carveDepthMm: Infinity })).toThrow(/positive finite/);
    expect(() => reliefOptionsFor({ roughingToolDiaMm: -2 })).toThrow(/positive finite/);
    expect(() => reliefOptionsFor({ roughingStrategy: 'spiral' })).toThrow(/roughingStrategy/);
    expect(() => reliefOptionsFor({ finishingToolType: 'cone' })).toThrow(/finishingToolType/);
    expect(() => reliefOptionsFor({ units: 'cm' })).toThrow(/units/);

    expect(() => machiningOptionsFor({ material: 'steel' }, scene)).toThrow(/Unknown material/);
    expect(() => machiningOptionsFor({ sides: 3 }, scene)).toThrow(/sides must be 1 or 2/);
    expect(() => machiningOptionsFor({ sides: NaN }, scene)).toThrow(/sides must be 1 or 2/);
    expect(() => machiningOptionsFor({ clearanceMm: -1 }, scene)).toThrow(/clearanceMm/);
    expect(() => machiningOptionsFor({ toolStickoutMm: Infinity }, scene)).toThrow(/toolStickoutMm/);
    expect(() => machiningOptionsFor({ toolDiaMm: 0 }, scene)).toThrow(/toolDiaMm/);
    expect(() => machiningOptionsFor({ setups: 'invalid' }, scene)).toThrow(/setups/);
  });

  it('EXPORT_RELIEF and EXPORT_MACHINING catch retired params & validation throws as { ok: false, error }', async () => {
    const ctx = makeCtx();
    const r1 = await machiningCommands.EXPORT_RELIEF({ stockWidthMm: 300 }, ctx) as { ok: boolean; error?: string };
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/physics_set_environment/);

    const r2 = await machiningCommands.EXPORT_MACHINING({ material: 'steel' }, ctx) as { ok: boolean; error?: string };
    expect(r2.ok).toBe(false);
    expect(r2.error).toMatch(/Unknown material/);

    const r3 = await machiningCommands.ADD_SIMULATION({ kind: 'machining', sides: 3 }, ctx) as { ok: boolean; error?: string };
    expect(r3.ok).toBe(false);
    expect(r3.error).toMatch(/sides must be 1 or 2/);
  });

  it('castCommands validates MAKE_POUR_BOX, EXPORT_CAST, SET_CAST_PREP, SPLIT_FOR_PRINT, EXPORT_PRINT', async () => {
    const ctx = makeCtx();
    expect(((await castCommands.MAKE_POUR_BOX({ baseMm: 0 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.MAKE_POUR_BOX({ wallMm: -1 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.MAKE_POUR_BOX({ floorMm: 0 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.MAKE_POUR_BOX({ holeAtMm: [NaN, 0] }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.MAKE_POUR_BOX({ parting: 'sideways' }, ctx)) as { ok: boolean }).ok).toBe(false);

    expect(((await castCommands.EXPORT_CAST({ partingFromBaseMm: -5 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_CAST({ partingFromBaseMm: Infinity }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_CAST({ partingFromBaseMm: 'bogus' }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_CAST({ sprueDiaMm: -1 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_CAST({ riserDiaMm: Infinity }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_CAST({ draftDeg: -2 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_CAST({ shrinkPercent: Infinity }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_CAST({ method: 'investment' }, ctx)) as { ok: boolean }).ok).toBe(false);

    expect(((await castCommands.SET_CAST_PREP({ draftDeg: NaN }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SET_CAST_PREP({ draftDeg: 20 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SET_CAST_PREP({ edgeSizeMm: 0 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SET_CAST_PREP({ partingFromBaseMm: -1 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SET_CAST_PREP({ method: 'wax' }, ctx)) as { ok: boolean }).ok).toBe(false);

    expect(((await castCommands.SPLIT_FOR_PRINT({ bodyId: 'target_id', diameterMm: -2 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SPLIT_FOR_PRINT({ bodyId: 'target_id', lengthMm: 0 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SPLIT_FOR_PRINT({ bodyId: 'target_id', minWallMm: 0 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SPLIT_FOR_PRINT({ bodyId: 'target_id', maxSections: 1 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SPLIT_FOR_PRINT({ bodyId: 'target_id', clearanceMm: -0.1 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SPLIT_FOR_PRINT({ bodyId: 'target_id', marginMm: -5 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.SPLIT_FOR_PRINT({ bodyId: 'target_id', connector: 'velcro' }, ctx)) as { ok: boolean }).ok).toBe(false);

    expect(((await castCommands.EXPORT_PRINT({ filaments: NaN }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_PRINT({ filaments: 33 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_PRINT({ bedMm: [200, -10] }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await castCommands.EXPORT_PRINT({ bedMm: [Infinity, 200, 200] }, ctx)) as { ok: boolean }).ok).toBe(false);
  });

  it('slipCommands validates positive and non-negative numeric parameters', async () => {
    const ctx = makeCtx();
    for (const key of ['plasterMm', 'plasterBudgetG', 'spareHeightMm', 'spareDiaMm', 'caseWallMm', 'natchDiaMm', 'castWallMm']) {
      expect(((await slipCommands.MAKE_SLIP_MOLD({ [key]: 0 }, ctx)) as { ok: boolean }).ok).toBe(false);
      expect(((await slipCommands.MAKE_SLIP_MOLD({ [key]: Infinity }, ctx)) as { ok: boolean }).ok).toBe(false);
    }
    for (const key of ['freeboardMm', 'baseTaperDeg', 'draftDeg', 'shrinkPercent', 'fillMm']) {
      expect(((await slipCommands.MAKE_SLIP_MOLD({ [key]: -1 }, ctx)) as { ok: boolean }).ok).toBe(false);
      expect(((await slipCommands.MAKE_SLIP_MOLD({ [key]: NaN }, ctx)) as { ok: boolean }).ok).toBe(false);
    }
    expect(((await slipCommands.ADD_DRAFT({ draftDeg: NaN }, ctx)) as { ok: boolean }).ok).toBe(false);
  });

  it('cutCommands and partBuildCommands reject Infinity, negative values, and bad tuples', async () => {
    const ctx = makeCtx();
    expect(((await cutCommands.EXPORT_CUT({ kind: 'unfold', thicknessMm: Infinity }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await cutCommands.EXPORT_CUT({ kind: 'unfold', scaleFactor: 0 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await cutCommands.EXPORT_CUT({ kind: 'unfold', bendRadiusMm: -1 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await cutCommands.EXPORT_CUT({ kind: 'unfold', seamAllowanceMm: Infinity }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await cutCommands.EXPORT_CUT({ kind: 'panels', jointMode: 'dovetail' }, ctx)) as { ok: boolean }).ok).toBe(false);

    expect(((await partBuildCommands.BREAKDOWN_PIPE_FRAME({ preset: 'carport', widthMm: -100 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await partBuildCommands.BREAKDOWN_PIPE_FRAME({ preset: 'carport', roofPitchDeg: NaN }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await partBuildCommands.BUILD_PIPE_FRAME({ maxSpanMm: Infinity }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await partBuildCommands.SYNC_PCB_ENCLOSURE({ wallThicknessMm: 0 }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await partBuildCommands.BUILD_MECHANISM({ family: 'gear', origin: [NaN, 0, 0] }, ctx)) as { ok: boolean }).ok).toBe(false);
    expect(((await partBuildCommands.BUILD_MECHANISM({ family: 'gear', axis: [0, Infinity, 1] }, ctx)) as { ok: boolean }).ok).toBe(false);
  });
});

describe('5. settleScene compile failure propagation & fresh store reads', () => {
  it('propagates settleScene failure in BUILD_BRICKWORK and SYNC_PCB_ENCLOSURE', async () => {
    settleResult = { ok: false, error: 'MJCF compile exploded' };
    const ctx = makeCtx();

    const brickRes = await brickCommands.BUILD_BRICKWORK({ placement: 'beside' }, ctx) as { ok: boolean; error?: string };
    expect(brickRes.ok).toBe(false);
    expect(brickRes.error).toContain('MJCF compile exploded');

    const pcbRes = await partBuildCommands.SYNC_PCB_ENCLOSURE({ pcbOnly: true }, ctx) as { ok: boolean; error?: string };
    expect(pcbRes.ok).toBe(false);
    expect(pcbRes.error).toContain('MJCF compile exploded');
  });

  it('uses fresh store.selectedNodeId after await in BUILD_BRICKWORK', async () => {
    settleResult = { ok: true };
    const clearSpy = vi.fn();
    useStore.setState({ selectedNodeId: 'stale_deleted_id', setSelectedNodeId: clearSpy } as never);
    // Pass a stale store snapshot with selectedNodeId: null, while live store has 'stale_deleted_id'
    const ctx = {
      store: { ...useStore.getState(), sceneGraph: scene, selectedNodeId: null },
      toId: (v: unknown) => v,
    } as never;
    const res = await brickCommands.BUILD_BRICKWORK({ placement: 'replace' }, ctx) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(clearSpy).toHaveBeenCalledWith(null);
  });
});
