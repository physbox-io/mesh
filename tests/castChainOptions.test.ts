import { describe, it, expect, vi } from 'vitest';
import type { SceneGeom, SceneNode, SceneGraph } from '../src/types/scene';

// The chains themselves are tested in castChain.test.ts; here only what the
// MCP command hands them.
const seen: { box?: Record<string, unknown>; metal?: Record<string, unknown> } = {};
vi.mock('../src/utils/castChain', async (orig) => ({
  ...(await orig<typeof import('../src/utils/castChain')>()),
  siliconeChain: async (_s: unknown, _ids: unknown, box: Record<string, unknown>) => {
    seen.box = box;
    return { ok: false, error: 'stop' };
  },
  metalChain: async (_s: unknown, options: Record<string, unknown>) => {
    seen.metal = options;
    return { ok: false, error: 'stop' };
  },
}));

const { runMcpMoldSimulation } = await import('../src/utils/moldWorkerClient');
const { sceneWithPourBox, planPourBox } = await import('../src/utils/pourBoxScene');
const { rememberCastOptions, DEFAULT_CAST_OPTIONS } = await import('../src/utils/castPatternExporter');

const candle = {
  id: 'candle', name: 'candle', type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: 'c', type: 'box', size: [0.01, 0.01, 0.015], pos: [0, 0, 0.015] } as SceneGeom],
} as unknown as SceneNode;

const run = (scene: SceneGraph, msg: Record<string, unknown>) =>
  runMcpMoldSimulation({
    msg: { kind: 'mold_cast', ...msg },
    scene,
    placement: 'beside',
    toId: (s) => s,
    findNodeInScene: (nodes, id) => nodes.find((n) => n.id === id) ?? null,
  });

describe('the one-click chains over MCP', () => {
  it('silicone: plans the pour box already round the master, as physics_make_pour_box made it', async () => {
    const options = { coverMm: 12, wallMm: 3, hole: 'wick' as const };
    const scene = sceneWithPourBox({ nodes: [candle] }, ['candle'], await planPourBox({ nodes: [candle] }, ['candle'], options), options).scene;
    await run(scene, { method: 'silicone', masterId: 'candle' });
    expect(seen.box).toMatchObject(options);
    // An explicit hole still wins, 'none' included.
    await run(scene, { method: 'silicone', masterId: 'candle', hole: 'none' });
    expect(seen.box).toMatchObject({ coverMm: 12, hole: null });
  });

  it('silicone: with no box in the scene, the defaults', async () => {
    await run({ nodes: [candle] }, { method: 'silicone', masterId: 'candle' });
    expect(seen.box?.coverMm).toBeUndefined();
  });

  it('sand: keeps the riser, sprue and parting last planned for that method', async () => {
    rememberCastOptions({ ...DEFAULT_CAST_OPTIONS, method: 'sand', metalId: 'bronze', partingFromBaseMm: 7, sprueDiaMm: 9, addRiser: false, draftDeg: 3 });
    await run({ nodes: [candle] }, { method: 'sand', masterId: 'candle' });
    expect(seen.metal).toMatchObject({ method: 'sand', metalId: 'bronze', partingFromBaseMm: 7, sprueDiaMm: 9, addRiser: false, draftDeg: 3 });
    // What the call names wins.
    await run({ nodes: [candle] }, { method: 'sand', masterId: 'candle', castMaterial: 'brass', draftDeg: 1 });
    expect(seen.metal).toMatchObject({ metalId: 'brass', draftDeg: 1, partingFromBaseMm: 7 });
    // Another method's choices are not carried over.
    await run({ nodes: [candle] }, { method: 'lost-pla', masterId: 'candle' });
    expect(seen.metal).toMatchObject({ method: 'lost-pla', metalId: 'aluminium', draftDeg: 0 });
    expect(seen.metal?.sprueDiaMm).toBeUndefined();
  });
});
