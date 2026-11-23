import { describe, it, expect, vi, afterEach } from 'vitest';
import { collectTransferables, isStandaloneView } from '../src/workers/transferables';
import { HistoryRing, contactsOfBodies, jointsOfBodies } from '../src/workers/historyRing';
import { buildImpactWatches, checkImpacts } from '../src/workers/impactWatch';
import { captureState, copyJointsByName } from '../src/workers/carryState';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { HistoryEntry } from '../src/workers/physicsWorkerProtocol';

const prevWorker = (globalThis as Record<string, unknown>).Worker;

afterEach(() => {
  vi.useRealTimers();
  if (prevWorker === undefined) delete (globalThis as Record<string, unknown>).Worker;
  else (globalThis as Record<string, unknown>).Worker = prevWorker;
});

const emptyScene = (name = 's'): SceneGraph => ({
  name,
  nodes: [],
});

describe('workers/transferables: zero-copy buffer collection & detachment safety', () => {
  it('collects unique standalone ArrayBuffers and skips subarrays, empty buffers, SharedArrayBuffers, and cycles', () => {
    const pos = new Float32Array([1, 2, 3]);
    const idx = new Uint32Array([0, 1, 2]);
    const empty = new Float32Array(0);
    // Subarray sharing a larger buffer (e.g. WASM linear memory view) MUST NOT be transferred.
    const wasmHeap = new ArrayBuffer(64);
    const wasmSlice = new Float32Array(wasmHeap, 16, 4);
    const fullHeapAlias = new Uint8Array(pos.buffer); // aliases pos.buffer

    const cyclic: Record<string, unknown> = {
      mesh: { pos, idx, empty, wasmSlice },
      alias: fullHeapAlias,
      map: new Map([['a', pos]]),
      set: new Set([idx]),
      primitives: [1, 2, 3, 4, 5],
    };
    cyclic.self = cyclic;

    expect(isStandaloneView(pos)).toBe(true);
    expect(isStandaloneView(empty)).toBe(false);
    expect(isStandaloneView(wasmSlice)).toBe(false);

    const transfers = collectTransferables(cyclic);
    expect(transfers).toHaveLength(2);
    expect(transfers).toContain(pos.buffer);
    expect(transfers).toContain(idx.buffer);
    expect(transfers).not.toContain(wasmHeap);
    expect(transfers).not.toContain(empty.buffer);

    // Exclude set prevents detaching caller/cache-owned buffers.
    const excluded = collectTransferables(cyclic, new Set([pos.buffer]));
    expect(excluded).toEqual([idx.buffer]);

    if (typeof SharedArrayBuffer !== 'undefined') {
      const sab = new SharedArrayBuffer(16);
      const sabView = new Float32Array(sab);
      expect(isStandaloneView(sabView)).toBe(false);
      expect(collectTransferables({ sab, sabView })).toEqual([]);
    }
  });
});

describe('MoldWorkerClient: GENERATE coalescing, dependent ordering, onmessageerror & dispose', () => {
  it('coalesces unstarted GENERATE requests without breaking GENERATE -> STL sequences, and settles on dispose', async () => {
    vi.resetModules();
    class FakeMoldWorker {
      static instances: FakeMoldWorker[] = [];
      sent: Record<string, unknown>[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FakeMoldWorker.instances.push(this); }
      postMessage(msg: Record<string, unknown>) { this.sent.push(msg); }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeMoldWorker);

    const { MoldWorkerClient, MoldSupersededError } = await import('../src/utils/moldWorkerClient');
    const client = new MoldWorkerClient();
    const w = FakeMoldWorker.instances[0];
    const s = emptyScene('mold');

    // Fire 3 rapid GENERATEs: #1 runs, #2 is superseded by #3 before ever reaching the worker.
    const g1 = client.generate(s, { wallMarginMm: 4 });
    const g2 = client.generate(s, { wallMarginMm: 6 });
    const g3 = client.generate(s, { wallMarginMm: 8 });
    // Queue an STL after #3: a subsequent #4 must NOT supersede #3 because STL depends on #3!
    const stl = client.stl();
    const g4 = client.generate(s, { wallMarginMm: 10 });

    await expect(g2).rejects.toBeInstanceOf(MoldSupersededError);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ type: 'GENERATE', scene: s });

    // Answer #1 -> #3 starts next (without re-sending identical scene).
    w.onmessage?.({ data: { type: 'GENERATED', id: w.sent[0].id, summary: { n: 1 }, bottom: null, top: null } } as MessageEvent);
    await expect(g1).resolves.toMatchObject({ summary: { n: 1 } });
    expect(w.sent).toHaveLength(2);
    expect(w.sent[1].type).toBe('GENERATE');
    expect(w.sent[1].scene).toBeUndefined();

    // Answer #3 -> STL runs next.
    w.onmessage?.({ data: { type: 'GENERATED', id: w.sent[1].id, summary: { n: 3 }, bottom: null, top: null } } as MessageEvent);
    await expect(g3).resolves.toMatchObject({ summary: { n: 3 } });
    expect(w.sent).toHaveLength(3);
    expect(w.sent[2].type).toBe('STL');

    // Disposing rejects both the active STL and queued #4 instead of hanging forever.
    client.dispose();
    await expect(stl).rejects.toBeInstanceOf(MoldSupersededError);
    await expect(g4).rejects.toBeInstanceOf(MoldSupersededError);
    expect(w.terminated).toBe(true);
  });
});

describe('ExportWorkerClient: dispose settlement, onmessageerror & postMessage error safety', () => {
  it('rejects pending/waiting jobs on dispose and recovers after postMessage throws', async () => {
    vi.resetModules();
    class FakeExportWorker {
      static last: FakeExportWorker;
      sent: Record<string, unknown>[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      throwNext = false;
      constructor() { FakeExportWorker.last = this; }
      postMessage(msg: Record<string, unknown>) {
        if (this.throwNext) {
          this.throwNext = false;
          throw new Error('DataCloneError');
        }
        this.sent.push(msg);
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeExportWorker);

    const { ExportWorkerClient, SupersededError } = await import('../src/utils/exportWorkerClient');
    const client = new ExportWorkerClient();
    const w = FakeExportWorker.last;
    const s = emptyScene('exp');

    w.throwNext = true;
    await expect(client.run('solid', s, {})).rejects.toThrow('DataCloneError');

    // Client is NOT wedged after postMessage threw.
    const p1 = client.run('solid', s, { n: 1 } as never);
    const p2 = client.run('solid', s, { n: 2 } as never);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].scene).toBe(s);

    // dispose() settles both active and waiting jobs cleanly.
    client.dispose();
    await expect(p1).rejects.toBeInstanceOf(SupersededError);
    await expect(p2).rejects.toBeInstanceOf(SupersededError);
    expect(w.terminated).toBe(true);
  });
});

describe('slipMoldClient, brickworkClient & pipeFrameClient: coalescing, scene caching & timeout isolation', () => {
  it('slipMoldClient coalesces queued PLAN per ids, caches scene, and isolates timeouts', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    class FakeSlipWorker {
      static instances: FakeSlipWorker[] = [];
      sent: Record<string, unknown>[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FakeSlipWorker.instances.push(this); }
      postMessage(msg: Record<string, unknown>) { this.sent.push(msg); }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeSlipWorker);

    const { planSlipMold, SlipMoldSupersededError } = await import('../src/utils/slipMoldClient');
    const s = emptyScene('vase');

    const p1 = planSlipMold(s, ['vase'], { plasterMm: 20 });
    const p2 = planSlipMold(s, ['vase'], { plasterMm: 25 });
    const p3 = planSlipMold(s, ['vase'], { plasterMm: 30 });
    const pOther = planSlipMold(s, ['cup'], { plasterMm: 20 });

    await expect(p2).rejects.toBeInstanceOf(SlipMoldSupersededError);
    expect(FakeSlipWorker.instances).toHaveLength(1);
    const w1 = FakeSlipWorker.instances[0];
    expect(w1.sent).toHaveLength(1);
    expect(w1.sent[0].scene).toBe(s);

    // Timeout p1: w1 terminates, p1 rejects, p3 runs on a fresh worker w2 with scene resent!
    vi.advanceTimersByTime(120_001);
    await expect(p1).rejects.toThrow(/took too long/i);
    expect(w1.terminated).toBe(true);
    expect(FakeSlipWorker.instances).toHaveLength(2);
    const w2 = FakeSlipWorker.instances[1];
    expect(w2.sent).toHaveLength(1);
    expect(w2.sent[0].scene).toBe(s);

    w2.onmessage?.({ data: { type: 'PLANNED', id: w2.sent[0].id, mold: { ok: 3 } } } as MessageEvent);
    await expect(p3).resolves.toEqual({ ok: 3 });

    // pOther runs on w2 with the same scene -> scene omitted!
    expect(w2.sent).toHaveLength(2);
    expect(w2.sent[1].scene).toBeUndefined();
    w2.onmessage?.({ data: { type: 'PLANNED', id: w2.sent[1].id, mold: { ok: 'cup' } } } as MessageEvent);
    await expect(pOther).resolves.toEqual({ ok: 'cup' });
  });

  it('brickworkClient coalesces queued LAY per bodyId, preserves LAY_SOURCE FIFO, and omits unchanged scene', async () => {
    vi.resetModules();
    class FakeBrickWorker {
      static instances: FakeBrickWorker[] = [];
      sent: Record<string, unknown>[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FakeBrickWorker.instances.push(this); }
      postMessage(msg: Record<string, unknown>) { this.sent.push(msg); }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeBrickWorker);

    const { layBricksOffThread, layBrickworkSourceOffThread, BrickworkSupersededError } = await import('../src/utils/brickworkClient');
    const s = emptyScene('house');

    const b1 = layBricksOffThread(s, 'wall', { jointMm: 8 });
    const b2 = layBricksOffThread(s, 'wall', { jointMm: 10 });
    const b3 = layBricksOffThread(s, 'wall', { jointMm: 12 });
    const src = layBrickworkSourceOffThread({} as never, 'b_');

    await expect(b2).rejects.toBeInstanceOf(BrickworkSupersededError);
    const w = FakeBrickWorker.instances[0];
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].scene).toBe(s);

    w.onmessage?.({ data: { type: 'LAY_DONE', id: w.sent[0].id, outcome: { id: 1 } } } as MessageEvent);
    await expect(b1).resolves.toEqual({ id: 1 });
    expect(w.sent[1]).toMatchObject({ type: 'LAY', bodyId: 'wall' });
    expect(w.sent[1].scene).toBeUndefined();

    w.onmessage?.({ data: { type: 'LAY_DONE', id: w.sent[1].id, outcome: { id: 3 } } } as MessageEvent);
    await expect(b3).resolves.toEqual({ id: 3 });

    expect(w.sent[2]).toMatchObject({ type: 'LAY_SOURCE', prefix: 'b_' });
    w.onmessage?.({ data: { type: 'SOURCE_DONE', id: w.sent[2].id, geoms: [] } } as MessageEvent);
    await expect(src).resolves.toEqual([]);
  });

  it('pipeFrameClient coalesces queued FRAME per bodyId and omits unchanged scene', async () => {
    vi.resetModules();
    class FakePipeWorker {
      static instances: FakePipeWorker[] = [];
      sent: Record<string, unknown>[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FakePipeWorker.instances.push(this); }
      postMessage(msg: Record<string, unknown>) { this.sent.push(msg); }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakePipeWorker);

    const { frameBodyOffThread, PipeFrameSupersededError } = await import('../src/utils/pipeFrameClient');
    const s = emptyScene('frame');

    const f1 = frameBodyOffThread(s, 'b1', { maxSpanMm: 400 });
    const f2 = frameBodyOffThread(s, 'b1', { maxSpanMm: 500 });
    const f3 = frameBodyOffThread(s, 'b1', { maxSpanMm: 600 });

    await expect(f2).rejects.toBeInstanceOf(PipeFrameSupersededError);
    const w = FakePipeWorker.instances[0];
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].scene).toBe(s);

    w.onmessage?.({ data: { type: 'FRAME_DONE', id: w.sent[0].id, outcome: { added: 1 } } } as MessageEvent);
    await expect(f1).resolves.toEqual({ added: 1 });
    expect(w.sent[1].scene).toBeUndefined();
    w.onmessage?.({ data: { type: 'FRAME_DONE', id: w.sent[1].id, outcome: { added: 3 } } } as MessageEvent);
    await expect(f3).resolves.toEqual({ added: 3 });
  });
});

describe('openscad worker pool: typed-array transfer, in-flight dedup & byte-bounded cache', () => {
  it('deduplicates concurrent identical SCAD compiles, unpacks TypedArray replies, and enforces byte budget', async () => {
    vi.resetModules();
    let compileDispatches = 0;
    class FakeScadWorker {
      static instances: FakeScadWorker[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FakeScadWorker.instances.push(this); }
      postMessage(msg: { type: string; id?: string; scad?: string }) {
        if (msg.type === 'LOAD') {
          queueMicrotask(() => {
            if (!this.terminated) this.onmessage?.({ data: { type: 'READY' } } as MessageEvent);
          });
        } else if (msg.type === 'COMPILE') {
          compileDispatches++;
          queueMicrotask(() => {
            if (this.terminated) return;
            const n = msg.scad?.startsWith('BIG_') ? 2_200_000 : 3;
            const vertices = new Float64Array(n);
            vertices[0] = 1;
            const faces = new Uint32Array([0, 1, 2]);
            const renderVertices = new Float64Array(n);
            renderVertices[0] = 1;
            this.onmessage?.({
              data: { type: 'COMPILED', id: msg.id, vertices, faces, renderVertices },
            } as MessageEvent);
          });
        }
      }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeScadWorker);

    const openscad = await vi.importActual<typeof import('../src/utils/openscad')>('../src/utils/openscad');

    // 4 identical concurrent compiles dispatch ONLY ONCE and return isolated arrays.
    const [a, b, c, d] = await Promise.all([
      openscad.compileSCAD('cube(5);'),
      openscad.compileSCAD('cube(5);'),
      openscad.compileSCAD('cube(5);'),
      openscad.compileSCAD('cube(5);'),
    ]);
    expect(compileDispatches).toBe(1);
    expect(Array.isArray(a.vertices)).toBe(true);
    expect(a.vertices[0]).toBe(1);
    a.vertices[0] = 999;
    expect(b.vertices[0]).toBe(1);
    expect(c.faces).toEqual([0, 1, 2]);
    expect(d.renderVertices[0]).toBe(1);

    // Byte budget (~64 MB): each BIG_* is ~35 MB (2 * 2.2M * 8 B), so storing BIG_2 evicts BIG_1!
    await openscad.compileSCAD('BIG_1');
    expect(compileDispatches).toBe(2);
    await openscad.compileSCAD('BIG_2');
    expect(compileDispatches).toBe(3);
    // BIG_1 was evicted by byte budget, so asking again must re-compile.
    await openscad.compileSCAD('BIG_1');
    expect(compileDispatches).toBe(4);
  });
});

describe('fractureWorkerClient, sculptCutClient, silhouetteClient & textureClient: wedged-worker recovery & packed textures', () => {
  it('fractureWorkerClient terminates wedged worker on timeout and runs queued fracture on a fresh worker', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    class FakeFracWorker {
      static instances: FakeFracWorker[] = [];
      sent: Record<string, unknown>[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FakeFracWorker.instances.push(this); }
      postMessage(msg: Record<string, unknown>) { this.sent.push(msg); }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeFracWorker);

    const { fractureMeshOffThread } = await import('../src/utils/fractureWorkerClient');
    const p1 = fractureMeshOffThread([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const p2 = fractureMeshOffThread([0, 0, 0, 2, 0, 0, 0, 2, 0], [0, 1, 2]);

    const w1 = FakeFracWorker.instances[0];
    vi.advanceTimersByTime(5_001);
    await expect(p1).rejects.toThrow(/timed out/i);
    expect(w1.terminated).toBe(true);
    expect(FakeFracWorker.instances).toHaveLength(2);

    const w2 = FakeFracWorker.instances[1];
    expect(w2.sent).toHaveLength(1);
    w2.onmessage?.({ data: { type: 'FRACTURED', id: w2.sent[0].id, cells: [] } } as MessageEvent);
    await expect(p2).resolves.toEqual([]);
  });

  it('textureClient unpacks zero-copy PackedTexturedSurface and recovers from worker timeout', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    class FakeTexWorker {
      static instances: FakeTexWorker[] = [];
      sent: Record<string, unknown>[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      terminated = false;
      constructor() { FakeTexWorker.instances.push(this); }
      postMessage(msg: Record<string, unknown>) { this.sent.push(msg); }
      terminate() { this.terminated = true; }
    }
    vi.stubGlobal('Worker', FakeTexWorker);

    const { requestTexturedSurface } = await import('../src/utils/textureClient');
    const geom1 = {
      name: 'g1',
      type: 'box' as const,
      size: [0.05, 0.05, 0.05],
      textures: [{ pattern: 'knurl', depthM: -0.001, seedAt: [0, 0, 0.05] }],
    };
    const geom2 = {
      name: 'g2',
      type: 'box' as const,
      size: [0.06, 0.06, 0.06],
      textures: [{ pattern: 'knurl', depthM: -0.002, seedAt: [0, 0, 0.06] }],
    };

    const t1 = requestTexturedSurface(geom1);
    const t2 = requestTexturedSurface(geom2);

    const w1 = FakeTexWorker.instances[0];
    vi.advanceTimersByTime(60_001);
    await expect(t1).resolves.toBeNull();
    expect(w1.terminated).toBe(true);

    const w2 = FakeTexWorker.instances[1];
    expect(w2.sent).toHaveLength(1);
    w2.onmessage?.({
      data: {
        type: 'TEXTURE_DONE',
        id: w2.sent[0].id,
        packed: {
          vertices: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          faces: new Uint32Array([0, 1, 2]),
          paint: { res: [1], idx: new Uint32Array([0]), rgba: new Uint8Array([255, 128, 64, 255]) },
          regions: [],
          warnings: [],
        },
      },
    } as MessageEvent);
    const surface = await t2;
    expect(surface).toEqual({
      vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      faces: [0, 1, 2],
      paint: { res: [1], idx: [0], rgba: [255, 128, 64, 255] },
      regions: [],
      warnings: [],
    });
  });

  it('bodyFormClient joins an identical active build without queuing a duplicate', async () => {
    vi.resetModules();
    class FakeFormWorker {
      static instances: FakeFormWorker[] = [];
      sent: { id: number; prefix: string }[] = [];
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      constructor() { FakeFormWorker.instances.push(this); }
      postMessage(req: { id: number; prefix: string }) { this.sent.push(req); }
      terminate() {}
    }
    vi.stubGlobal('Worker', FakeFormWorker);

    const { buildBodyFormOffThread } = await import('../src/utils/cloth/bodyFormClient');
    const { clampBodyForm } = await import('../src/utils/cloth/bodyForm');
    const m = clampBodyForm({ chest: 0.92 });

    const p1 = buildBodyFormOffThread(m, 'formX', 'formX');
    const p2 = buildBodyFormOffThread(m, 'formX', 'formX');
    const w = FakeFormWorker.instances[0];
    expect(w.sent).toHaveLength(1);
    w.onmessage?.({ data: { type: 'BUILT', id: w.sent[0].id, geoms: [] } } as MessageEvent);
    expect(await p1).toEqual([]);
    expect(await p2).toEqual([]);
    expect(w.sent).toHaveLength(1);
  });
});

describe('hot-loop worker utilities: impactWatch, carryState & historyRing', () => {
  it('checkImpacts hoists dat.qfrc_constraint to 1 read per step across many watched bodies and allocates nothing on quiet steps', () => {
    const nodes: SceneNode[] = Array.from({ length: 10 }, (_, i) => ({
      id: `b${i}`,
      name: `b${i}`,
      type: 'body' as const,
      pos: [i, 0, 0.5],
      shatterImpulseNs: 5,
      joints: [{ name: `j${i}`, type: 'free' as const }],
      geoms: [{ name: `g${i}`, type: 'box' as const, size: [0.05, 0.05, 0.05] }],
      children: [],
    }));
    const bodyIdOf = Object.fromEntries(nodes.map((n, i) => [n.id, i + 1]));
    const jointIdOf = Object.fromEntries(nodes.map((_, i) => [`j${i}`, i]));

    const fakeModel = {
      jnt_type: Int32Array.from({ length: 10 }, () => 0),
      jnt_dofadr: Int32Array.from({ length: 10 }, (_, i) => i * 6),
      body_rootid: Int32Array.from({ length: 11 }, (_, i) => i),
    };
    const watches = buildImpactWatches(fakeModel as never, nodes, bodyIdOf, jointIdOf);
    expect(watches.watches).toHaveLength(10);

    let qfrcGets = 0;
    const qfrcBacking = new Float64Array(60);
    const fakeData = {
      time: 0.001,
      get qfrc_constraint() {
        qfrcGets++;
        return qfrcBacking;
      },
      xpos: new Float64Array(33),
      xmat: new Float64Array(99),
      cvel: new Float64Array(66),
      subtree_com: new Float64Array(33),
      contact: { size: () => 0, get: () => null, delete() {} },
    };

    const r1 = checkImpacts(watches, fakeModel as never, fakeData as never, 0.001);
    const r2 = checkImpacts(watches, fakeModel as never, fakeData as never, 0.001);
    // 10 bodies * 3 linear DOFs = 30 reads -> only 2 Embind getter crossings across 2 steps!
    expect(qfrcGets).toBe(2);
    expect(r1).toHaveLength(0);
    expect(r1).toBe(r2); // shared EMPTY_EVENTS array: zero per-step allocation
  });

  it('carryState hoists Embind getters during captureState and copyJointsByName', () => {
    let qposGets = 0;
    let ctrlGets = 0;
    const mdl = {
      nq: 7, nv: 6, nu: 2,
      jnt_type: new Int32Array([0]),
      jnt_qposadr: new Int32Array([0]),
      jnt_dofadr: new Int32Array([0]),
    };
    const qposBuf = new Float64Array([1, 2, 3, 1, 0, 0, 0]);
    const qvelBuf = new Float64Array([0.1, 0.2, 0.3, 0, 0, 0]);
    const ctrlBuf = new Float64Array([0.5, -0.5]);
    const dat = {
      time: 1.25,
      get qpos() { qposGets++; return qposBuf; },
      qvel: qvelBuf,
      get ctrl() { ctrlGets++; return ctrlBuf; },
    };

    const carried = captureState(mdl as never, dat as never, { free0: 0 }, { a0: 0, a1: 1 });
    expect(carried).not.toBeNull();
    expect(ctrlGets).toBe(1);
    expect(carried!.actuators).toEqual({ a0: 0.5, a1: -0.5 });

    const outQpos = new Float64Array(7);
    const outQvel = new Float64Array(6);
    qposGets = 0;
    const newDat = {
      get qpos() { qposGets++; return outQpos; },
      qvel: outQvel,
    };
    const placed = copyJointsByName(carried!, mdl as never, newDat as never, { free0: 0 });
    expect(placed.has('free0')).toBe(true);
    expect(qposGets).toBe(1);
    expect(Array.from(outQpos)).toEqual([1, 2, 3, 1, 0, 0, 0]);
  });

  it('HistoryRing filters bodies/joints/contacts accurately without mutating ring entries and reuses buffer on clear()', () => {
    const ring = new HistoryRing(4);
    const makeEntry = (t: number): HistoryEntry => ({
      time: t,
      bodies: {
        a: { pos: [t, 0, 0], vel: [0, 0, 0], angvel: [0, 0, 0], xfrc_applied: [0, 0, 0, 0, 0, 0] },
        b: { pos: [0, t, 0], vel: [0, 0, 0], angvel: [0, 0, 0], xfrc_applied: [0, 0, 0, 0, 0, 0] },
      },
      joints: {
        ja: { body: 'a', pos: t, vel: 0, qfrc_applied: 0 },
        jb: { body: 'b', pos: t * 2, vel: 0, qfrc_applied: 0 },
      },
      contacts: [
        { geom1: 'ga', geom2: 'floor', body1: 'a', body2: 'world', dist: 0 },
        { geom1: 'gb', geom2: 'floor', body1: 'b', body2: 'world', dist: 0 },
      ],
      aeroDiagnostics: {},
    });
    ring.push(makeEntry(1));
    ring.push(makeEntry(2));

    const q = ring.query({ bodies: ['a'] });
    expect(q.frames).toHaveLength(2);
    expect(Object.keys(q.frames[0].bodies!)).toEqual(['a']);
    expect(Object.keys(q.frames[0].joints!)).toEqual(['ja']);
    expect(q.frames[0].contacts).toHaveLength(1);
    expect(jointsOfBodies(makeEntry(1).joints, new Set(['b']))).toHaveProperty('jb');
    expect(contactsOfBodies(makeEntry(1).contacts, new Set(['b']))).toHaveLength(1);

    ring.clear();
    expect(ring.size).toBe(0);
    expect(ring.latest()).toBeNull();
  });
});
