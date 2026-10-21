// ---------------------------------------------------------------------------
// The export modal's end of the mold worker
// ---------------------------------------------------------------------------
//
// One worker per open modal, torn down with it. Requests are numbered and
// answered in order — the worker is single-threaded and handles one message at a
// time — so the caller can tell a stale answer from the current one by its id
// and drop what it no longer wants.
//
// Falls back to generating inline where there is no Worker at all (a test
// environment, an ancient browser). That path blocks, which is the thing this
// module exists to avoid, but a modal that works slowly beats one that does not
// work.

import {
  DEFAULT_MOLD_OPTIONS,
  generateMoldMeshes,
  lastMoldOptions,
  moldSummary,
  trianglesToBuffers,
  type MoldHalfBuffers,
  type MoldOptions,
  type MoldSummary,
} from './moldExporter';
import {
  simulateCastFromMoldNode,
  simulateCastFromMoldResult,
  type MoldCastSimulationOptions,
  type MoldCastSimulationResult,
} from './moldCastSimulation';
import type { SceneGraph, SceneNode } from '../types/scene';
import { loadManifold } from './sculptCut';
import { stlToMesh } from './stlMesh';
import { appendSolidTriangles } from './contourSliceExporter';
import { getNodeWorldTransform } from './laserCutExporter';
import { resolveCsgGeoms } from './csg';
import { addSimulationToScene, sceneStockTransform } from '../hooks/useAddSimulation';
import { useStore } from '../store/useStore';

export interface MoldPreview {
  summary: MoldSummary;
  bottom: MoldHalfBuffers;
  top: MoldHalfBuffers | null;
}

type Settle = { resolve: (v: never) => void; reject: (e: Error) => void };

export class MoldWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Settle>();
  /** The scene the worker already holds, so a slider drag sends options alone. */
  private sceneSent: SceneGraph | null = null;
  private lastResult: ReturnType<typeof generateMoldMeshes> | null = null;

  constructor() {
    if (typeof Worker === 'undefined') return;
    try {
      this.worker = new Worker(new URL('../workers/moldWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker.onmessage = (evt: MessageEvent) => {
        const msg = evt.data;
        const settle = this.pending.get(msg.id);
        if (!settle) return;
        this.pending.delete(msg.id);
        if (msg.type === 'FAILED') settle.reject(new Error(msg.message));
        else if (msg.type === 'GENERATED') {
          settle.resolve({ summary: msg.summary, bottom: msg.bottom, top: msg.top } as never);
        } else if (msg.type === 'STL') settle.resolve(msg.bytes as never);
        else if (msg.type === 'CAST') settle.resolve(msg.result as never);
      };
      // A worker that dies leaves every caller awaiting forever otherwise.
      this.worker.onerror = () => {
        const failed = new Error('The mold worker stopped.');
        for (const settle of this.pending.values()) settle.reject(failed);
        this.pending.clear();
        this.sceneSent = null;
      };
    } catch {
      this.worker = null;
    }
  }

  /** Numbers a request and hands back the promise its answer will settle. */
  private send<T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.worker!.postMessage({ ...message, id }, transfer);
    });
  }

  async generate(scene: SceneGraph, options: Partial<MoldOptions>): Promise<MoldPreview> {
    if (!this.worker) {
      const wasm = await loadManifold().catch(() => null);
      const result = generateMoldMeshes(scene, options, wasm);
      this.lastResult = result;
      return {
        summary: moldSummary(result),
        bottom: trianglesToBuffers(result.bottomHalf.triangles),
        top: result.topHalf ? trianglesToBuffers(result.topHalf.triangles) : null,
      };
    }

    const fresh = scene !== this.sceneSent;
    this.sceneSent = scene;
    return this.send<MoldPreview>({ type: 'GENERATE', options, ...(fresh ? { scene } : {}) });
  }

  /** The plate as binary STL, encoded from whatever was generated last. */
  stl(): Promise<Uint8Array> {
    if (!this.worker) return Promise.resolve(this.lastResult?.binarySTL ?? new Uint8Array(84));
    return this.send<Uint8Array>({ type: 'STL' });
  }

  /** Simulates the cast solid from whatever mold was generated last. */
  async cast(options?: MoldCastSimulationOptions): Promise<MoldCastSimulationResult> {
    if (!this.worker) {
      if (!this.lastResult) {
        return {
          success: false,
          error: 'No mold generated yet.',
          warnings: [],
          mesh: { positions: new Float32Array(0), faces: new Uint32Array(0) },
          castVolumeMm3: 0,
          sizeMm: { width: 0, depth: 0, height: 0 },
          cavityComponents: 0,
        };
      }
      return simulateCastFromMoldResult(this.lastResult, options);
    }
    return this.send<MoldCastSimulationResult>({ type: 'CAST', options });
  }

  /** Simulates the cast solid from an existing mold SceneNode off the main thread. */
  async castNode(node: SceneNode, options?: MoldCastSimulationOptions): Promise<MoldCastSimulationResult> {
    if (!this.worker) {
      return simulateCastFromMoldNode(node, options);
    }
    return this.send<MoldCastSimulationResult>({ type: 'CAST_NODE', node, options });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.sceneSent = null;
  }
}

export function moldOptionsFor(msg: Record<string, unknown>): {
  options: Partial<MoldOptions>;
  fromDialog: boolean;
} {
  const fromDialog = lastMoldOptions();
  return {
    fromDialog: Boolean(fromDialog),
    options: {
      ...(fromDialog ?? DEFAULT_MOLD_OPTIONS),
      ...(msg.moldType === 'open' || msg.moldType === 'clamshell' ? { moldType: msg.moldType } : {}),
      ...(typeof msg.wallMarginMm === 'number' ? { wallMarginMm: msg.wallMarginMm } : {}),
      ...(typeof msg.baseThicknessMm === 'number' ? { baseThicknessMm: msg.baseThicknessMm } : {}),
      ...(typeof msg.cavityDepthMm === 'number' ? { cavityDepthMm: msg.cavityDepthMm } : {}),
      ...(typeof msg.draftAngleDeg === 'number' ? { draftAngleDeg: msg.draftAngleDeg } : {}),
      ...(typeof msg.allowUndercuts === 'boolean' ? { allowUndercuts: msg.allowUndercuts } : {}),
      ...(typeof msg.includeSprue === 'boolean' ? { includeSprue: msg.includeSprue } : {}),
      ...(typeof msg.includeVents === 'boolean' ? { includeVents: msg.includeVents } : {}),
      ...(typeof msg.ventDiaMm === 'number' ? { ventDiaMm: msg.ventDiaMm } : {}),
      ...(typeof msg.includePryNotches === 'boolean' ? { includePryNotches: msg.includePryNotches } : {}),
    },
  };
}

export async function runMcpMoldSimulation(params: {
  msg: Record<string, unknown>;
  scene: SceneGraph;
  placement: 'beside' | 'overlay';
  toId: (s: string) => string;
  findNodeInScene: (nodes: SceneNode[], id: string) => SceneNode | null;
}): Promise<Record<string, unknown>> {
  const { msg, scene, placement, toId, findNodeInScene } = params;
  const { options: moldOpts, fromDialog } = moldOptionsFor(msg);
  const optionsFrom = fromDialog ? 'the Export Mold dialog' : 'the scene defaults';

  const withWorker = async <T,>(fn: (c: MoldWorkerClient) => Promise<T>): Promise<T> => {
    const client = new MoldWorkerClient();
    try {
      return await fn(client);
    } finally {
      client.dispose();
    }
  };

  if (msg.kind === 'mold_cast' || msg.kind === 'cast') {
    const rawBodyId =
      typeof msg.bodyId === 'string'
        ? msg.bodyId
        : typeof msg.targetId === 'string'
          ? msg.targetId
          : undefined;
    const targetId = rawBodyId ? toId(rawBodyId) : undefined;
    if (targetId) {
      const moldNode = findNodeInScene(scene.nodes, targetId);
      if (!moldNode) {
        return { ok: false, error: `No mold body with id '${rawBodyId}'.` };
      }
      const castRes = await withWorker((c) =>
        c.castNode(moldNode, {
          trimChannels: msg.trimChannels === true,
          orientUpright: msg.orientUpright !== false,
        }),
      );
      if (!castRes.success) {
        return {
          ok: false,
          error: castRes.error || 'Could not simulate casting from mold body.',
          warnings: castRes.warnings,
        };
      }
      const moldTrisM: number[] = [];
      const walkMold = (n: SceneNode, parentMat?: ReturnType<typeof getNodeWorldTransform>) => {
        const mat = getNodeWorldTransform(n, parentMat);
        for (const g of resolveCsgGeoms(n, 'render')) {
          if (g.role === 'collision') continue;
          appendSolidTriangles({ ...g, textures: undefined }, mat, moldTrisM);
        }
        for (const ch of n.children || []) walkMold(ch, mat);
      };
      walkMold(moldNode);
      const lo: [number, number, number] = [Infinity, Infinity, Infinity];
      const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < moldTrisM.length; i++) {
        const v = moldTrisM[i] * 1000;
        if (v < lo[i % 3]) lo[i % 3] = v;
        if (v > hi[i % 3]) hi[i % 3] = v;
      }
      if (!moldTrisM.length) {
        lo.fill(0);
        hi.fill(0);
      }
      const moldTransform = {
        modelOriginMm: [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]] as [number, number, number],
        workOriginMm: [0, 0, 0] as [number, number, number],
        scale: [1, 1, 1] as [number, number, number],
        modelMinMm: lo,
        modelMaxMm: hi,
      };
      const added = await addSimulationToScene({
        mesh: castRes.mesh,
        transform: moldTransform,
        kind: 'cast',
        label: `Cast from ${moldNode.name}`,
        placement,
        details: [
          `Simulated casting from mold: ${moldNode.name} (${moldNode.id})`,
          `Cast dimensions: ${castRes.sizeMm.width} × ${castRes.sizeMm.depth} × ${castRes.sizeMm.height} mm`,
        ],
      });
      if (castRes.textures && castRes.textures.length > 0) {
        const addedNode = findNodeInScene(useStore.getState().sceneGraph.nodes, added.id);
        const castGeom = addedNode?.geoms?.[0];
        if (castGeom) {
          useStore.getState().setGeomTextures(added.id, castGeom.name, castRes.textures);
        }
      }
      return {
        ok: true,
        id: added.id,
        name: added.name,
        kind: 'mold_cast',
        sourceMoldId: moldNode.id,
        placement,
        sizeMm: castRes.sizeMm,
        volumeMm3: Math.round(castRes.castVolumeMm3),
        cavityComponents: castRes.cavityComponents,
        warnings: castRes.warnings,
      };
    }

    if (!scene.nodes?.some((n) => !n.simulation)) {
      return {
        ok: false,
        error: 'The scene has nothing to mold but earlier simulations. Pass bodyId to cast from an existing mold body.',
      };
    }
    const { preview, castRes } = await withWorker(async (c) => {
      const p = await c.generate(scene, moldOpts);
      if (!p.summary.success) return { preview: p, castRes: null };
      const cr = await c.cast({
        trimChannels: msg.trimChannels === true,
        orientUpright: msg.orientUpright !== false,
      });
      return { preview: p, castRes: cr };
    });
    const moldRes = preview.summary;
    if (!moldRes.success || !castRes) {
      return { ok: false, error: moldRes.error || 'The mold could not be generated.', warnings: moldRes.warnings };
    }
    if (!castRes.success) {
      return {
        ok: false,
        error: castRes.error || 'The casting could not be simulated from the mold.',
        warnings: castRes.warnings,
      };
    }
    const added = await addSimulationToScene({
      mesh: castRes.mesh,
      transform: sceneStockTransform(),
      kind: 'cast',
      label: 'Mold cast',
      placement,
      details: [
        `Cast dimensions: ${castRes.sizeMm.width} × ${castRes.sizeMm.depth} × ${castRes.sizeMm.height} mm`,
        `Mold type: ${moldOpts.moldType === 'open' ? 'One-part open mold' : 'Two-part clamshell mold'}`,
      ],
    });
    return {
      ok: true,
      id: added.id,
      name: added.name,
      kind: 'mold_cast',
      placement,
      optionsFrom,
      moldType: moldOpts.moldType ?? 'clamshell',
      sizeMm: castRes.sizeMm,
      volumeMm3: Math.round(castRes.castVolumeMm3),
      cavityComponents: castRes.cavityComponents,
      warnings: [...moldRes.warnings, ...castRes.warnings],
    };
  }

  // msg.kind === 'mold'
  if (!scene.nodes?.some((n) => !n.simulation)) {
    return { ok: false, error: 'The scene has nothing to cut but earlier simulations.' };
  }
  const { preview, stl } = await withWorker(async (c) => {
    const p = await c.generate(scene, moldOpts);
    const bytes = p.summary.success ? await c.stl() : new Uint8Array(84);
    return { preview: p, stl: bytes };
  });
  const moldRes = preview.summary;
  if (!moldRes.success) {
    return { ok: false, error: moldRes.error || 'The mold could not be generated.', warnings: moldRes.warnings };
  }
  const added = await addSimulationToScene({
    mesh: stlToMesh(stl),
    transform: sceneStockTransform(),
    kind: 'mold',
    label: 'Mold',
    placement: 'beside',
    details: [
      `Mold block: ${moldRes.moldWidthMm} × ${moldRes.moldDepthMm} × ${moldRes.moldHeightMm} mm`,
      `Cavity depth: ${moldRes.cavityDepthMm} mm (${moldRes.minDraftDeg}° min draft)`,
    ],
  });
  return {
    ok: true,
    id: added.id,
    name: added.name,
    kind: 'mold',
    placement: 'beside',
    optionsFrom,
    moldType: moldOpts.moldType ?? 'clamshell',
    moldSizeMm: [moldRes.moldWidthMm, moldRes.moldDepthMm, moldRes.moldHeightMm],
    cavityDepthMm: moldRes.cavityDepthMm,
    minDraftDeg: moldRes.minDraftDeg,
    volumeMm3: Math.round(added.volumeMm3),
    warnings: moldRes.warnings,
  };
}
