import { describe, it, expect, vi } from 'vitest';

/** A worker that records what it was sent and answers when told to. */
class FakeWorker {
  static last: FakeWorker;
  static count = 0;
  sent: { id: number; type: string; scene?: unknown }[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor() { FakeWorker.last = this; FakeWorker.count++; }
  postMessage(m: { id: number; type: string; scene?: unknown }) { this.sent.push(m); }
  terminate() { this.terminated = true; }
}
vi.stubGlobal('Worker', FakeWorker);

const { MoldWorkerClient, runMcpMoldSimulation } = await import('../src/utils/moldWorkerClient');
const { slipCommands } = await import('../src/hooks/mcp/slipCommands');
const { describeFiles, findNodeInScene } = await import('../src/hooks/mcp/bridgeUtils');
const { useStore } = await import('../src/store/useStore');
const { CastingGuide } = await import('../src/components/CastingGuide');
const React = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');

/*
 * A tab left open across a deploy asks for a worker file that no longer
 * exists, and the worker dies on load. The client kept the dead worker, and
 * every later request waited on it for good.
 */
describe('the mold worker client, when its worker dies', () => {
  it('fails what was asked, refuses what needed the lost mold, and regenerates on a new worker', async () => {
    const client = new MoldWorkerClient();
    const scene = { nodes: [] };
    const dead = FakeWorker.last;
    const a = client.generate(scene, {});
    const before = FakeWorker.count;
    dead.onerror?.();
    await expect(a).rejects.toThrow('The mold worker stopped.');
    expect(dead.terminated).toBe(true);
    // Not at once: on an out-of-date tab that would load, die and respawn for good.
    expect(FakeWorker.count).toBe(before);

    // The mold the dead worker held is gone; an STL of nothing would be worse than an error.
    await expect(client.stl()).rejects.toThrow('The mold worker stopped.');
    expect(FakeWorker.count).toBe(before);

    const b = client.generate(scene, {});
    const fresh = FakeWorker.last;
    expect(fresh).not.toBe(dead);
    expect(fresh.sent).toHaveLength(1);
    // The new worker holds no scene, so it is sent again.
    expect(fresh.sent[0]).toMatchObject({ type: 'GENERATE', scene });
    fresh.onmessage?.({ data: { type: 'GENERATED', id: fresh.sent[0].id, summary: 's', bottom: 'b', top: null } });
    await expect(b).resolves.toMatchObject({ summary: 's' });

    const stl = client.stl();
    fresh.onmessage?.({ data: { type: 'STL', id: fresh.sent[1].id, bytes: 'bytes' } });
    await expect(stl).resolves.toBe('bytes');
  });
});

describe('MCP mold export, chain options, Cast Prep hint & CastingGuide safety', () => {
  it('exports casting-mold.stl for unlined kind=mold (with base64 gated by includeFiles !== false) and .3mf for lined', async () => {
    // Inline fallback (no Worker) exercises real mold generation end-to-end.
    vi.unstubAllGlobals();
    try {
      const boxScene = {
        nodes: [{
          id: 'part1', name: 'part1', type: 'body' as const, pos: [0, 0, 0.01],
          geoms: [{ name: 'g', type: 'box' as const, size: [0.012, 0.012, 0.01] }],
          joints: [], children: [],
        }],
      };
      useStore.getState().updateScene(boxScene);

      const unlinedWithBytes = await runMcpMoldSimulation({
        msg: { kind: 'mold', moldType: 'open', includeSprue: false, includeVents: false },
        scene: useStore.getState().sceneGraph,
        placement: 'beside',
        toId: (s) => s,
        findNodeInScene,
        describeFiles,
      });
      expect(unlinedWithBytes.ok).toBe(true);
      const filesWith = unlinedWithBytes.files as { name: string; bytes: number; base64?: string }[];
      expect(filesWith).toHaveLength(1);
      expect(filesWith[0].name).toBe('casting-mold.stl');
      expect(filesWith[0].bytes).toBeGreaterThan(84);
      expect(typeof filesWith[0].base64).toBe('string');

      const unlinedMetaOnly = await runMcpMoldSimulation({
        msg: { kind: 'mold', moldType: 'open', includeSprue: false, includeVents: false, includeFiles: false },
        scene: useStore.getState().sceneGraph,
        placement: 'beside',
        toId: (s) => s,
        findNodeInScene,
        describeFiles,
      });
      expect(unlinedMetaOnly.ok).toBe(true);
      const filesMeta = unlinedMetaOnly.files as { name: string; bytes: number; base64?: string }[];
      expect(filesMeta).toHaveLength(1);
      expect(filesMeta[0].name).toBe('casting-mold.stl');
      expect(filesMeta[0].base64).toBeUndefined();
    } finally {
      vi.stubGlobal('Worker', FakeWorker);
    }
  });

  it('forwards split_sleeve, cover_mm, silicone_budget_g and shape to siliconeChain and validates shape', async () => {
    const boxScene = {
      nodes: [{
        id: 'part1', name: 'part1', type: 'body' as const, pos: [0, 0, 0.01],
        geoms: [{ name: 'g', type: 'box' as const, size: [0.01, 0.01, 0.01] }],
        joints: [], children: [],
      }],
    };
    const badShape = await runMcpMoldSimulation({
      msg: { kind: 'mold_cast', method: 'silicone', shape: 'hexagon' },
      scene: boxScene,
      placement: 'beside',
      toId: (s) => s,
      findNodeInScene,
    });
    expect(badShape).toEqual({ ok: false, error: "shape is 'fit', 'round' or 'box'." });

    const pending = runMcpMoldSimulation({
      msg: {
        kind: 'mold_cast',
        method: 'silicone',
        split_sleeve: false,
        cover_mm: 12,
        silicone_budget_g: 350,
        shape: 'round',
      },
      scene: boxScene,
      placement: 'beside',
      toId: (s) => s,
      findNodeInScene,
    });
    const w = FakeWorker.last;
    expect(w.sent[0]).toMatchObject({
      type: 'CHAIN_SILICONE',
      boxOptions: {
        splitSleeve: false,
        coverMm: 12,
        siliconeBudgetG: 350,
        shape: 'round',
      },
    });
    w.onmessage?.({ data: { type: 'CHAIN', id: w.sent[0].id, result: { ok: false, error: 'stopped' } } });
    await expect(pending).resolves.toEqual({ ok: false, error: 'stopped' });
  });

  it('ADD_DRAFT points to physics_set_cast_prep off: true when Cast Prep draft is active', async () => {
    const store = {
      ...useStore.getState(),
      sceneGraph: {
        nodes: [{
          id: 'p', name: 'p', type: 'body' as const, pos: [0, 0, 0],
          geoms: [{ name: 'g', type: 'box' as const, size: [0.01, 0.01, 0.01] }],
          joints: [], children: [],
        }],
        castPrep: { draftDeg: 2, draftMode: 'add' as const, partingZ: 0, edges: null, originals: {}, skipped: [], sharpEdges: 0 },
      },
    };
    const reply = await slipCommands.ADD_DRAFT({ draftDeg: 2 }, { store: store as never, toId: (s) => s });
    expect(reply).toMatchObject({ ok: false });
    expect(String((reply as { error?: string }).error)).toContain('physics_set_cast_prep off: true');
    expect(String((reply as { error?: string }).error)).not.toContain('enabled: false');
  });

  it('CastingGuide hides when dissolvableLiner is active and adapts copy by material and moldType', () => {
    const facts = { cavityDepthMm: 25, minDraftDeg: 0, flexibleMoldAdvised: true, lidIsBackingPlate: false };
    expect(
      renderToStaticMarkup(React.createElement(CastingGuide, { result: facts, moldType: 'clamshell', material: 'epoxy', dissolvableLiner: true })),
    ).toBe('');

    const closedEpoxy = renderToStaticMarkup(
      React.createElement(CastingGuide, { result: facts, moldType: 'clamshell', material: 'epoxy' }),
    );
    expect(closedEpoxy).not.toContain('brushing details');
    expect(closedEpoxy).toContain('deep-pour');

    const chocolateHtml = renderToStaticMarkup(
      React.createElement(CastingGuide, { result: facts, moldType: 'open', material: 'chocolate' }),
    );
    expect(chocolateHtml).not.toMatch(/Seal FDM layer lines with/i);
    expect(chocolateHtml).toContain('cocoa butter');

    const plasterHtml = renderToStaticMarkup(
      React.createElement(CastingGuide, { result: facts, moldType: 'open', material: 'plaster' }),
    );
    expect(plasterHtml).not.toContain('epoxy sealer');
    expect(plasterHtml).toContain('plaster');
  });
});
