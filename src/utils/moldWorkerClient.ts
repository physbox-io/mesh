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
  moldPreviewBuffers,
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
import {
  CAST_MATERIALS,
  castMaterial as castMaterialSpec,
  castMaterialWarnings,
  castWeightG,
  mixGrams,
  resolveCastMaterial,
  type CastMaterialId,
} from './castMaterials';
import { stlToMesh } from './stlMesh';
import { appendSolidTriangles } from './contourSliceExporter';
import { getNodeWorldTransform } from './laserCutExporter';
import { resolveCsgGeoms } from './csg';
import { addSimulationToScene, sceneStockTransform } from '../hooks/useAddSimulation';
import { useStore } from '../store/useStore';
import { workerStoppedError } from './staleBuild';
import { isSiliconeMold, pourBoxIn, pourSelection } from './pourTarget';
import { pourBoxOptionsFor } from './pourBoxScene';
import { mcpMoldSubject } from './moldSubject';
import { metalChain, siliconeChain, type ChainPiece, type ChainResult, type MetalChain, type SiliconeChain } from './castChain';
import { addMetalChain, addSiliconeChain } from './castChainActions';
import { DEFAULT_TAB_DRAFT, DEFAULT_TAB_MATERIAL, materialFitsTab, tabMaterials } from './moldTabs';
import type { PourBoxOptions } from './siliconeMold';
import { lastCastOptions, type CastOptions } from './castPatternExporter';
import { POUR_DIRECTIONS, type PourDirection, type PourInfo } from './pourCast';

export interface MoldPreview {
  summary: MoldSummary;
  /** Each half as drawn: with a liner, its PLA shell only. */
  bottom: MoldHalfBuffers;
  top: MoldHalfBuffers | null;
  /** The PVA liner of each half, when the mold has one. */
  liner: { bottom: MoldHalfBuffers; top: MoldHalfBuffers | null } | null;
}

type Settle = { resolve: (v: never) => void; reject: (e: Error) => void };

export class MoldWorkerClient {
  private worker: Worker | null = null;
  private seq = 0;
  private pending = new Map<number, Settle>();
  /** The scene the worker already holds, so a slider drag sends options alone. */
  private sceneSent: SceneGraph | null = null;
  private lastResult: ReturnType<typeof generateMoldMeshes> | null = null;
  /** Why the worker died, until a request that carries its own inputs starts another. */
  private stopped: Promise<Error> | null = null;

  constructor() {
    this.spawn();
  }

  private spawn() {
    if (typeof Worker === 'undefined') return;
    try {
      const worker = new Worker(new URL('../workers/moldWorker.ts', import.meta.url), {
        type: 'module',
      });
      this.worker = worker;
      worker.onmessage = (evt: MessageEvent) => {
        const msg = evt.data;
        const settle = this.pending.get(msg.id);
        if (!settle) return;
        this.pending.delete(msg.id);
        if (msg.type === 'FAILED') settle.reject(new Error(msg.message));
        else if (msg.type === 'GENERATED') {
          settle.resolve({ summary: msg.summary, bottom: msg.bottom, top: msg.top, liner: msg.liner ?? null } as never);
        } else if (msg.type === 'STL') settle.resolve(msg.bytes as never);
        else if (msg.type === 'CAST' || msg.type === 'CHAIN') settle.resolve(msg.result as never);
      };
      // A worker that dies leaves every caller awaiting forever otherwise. It
      // is replaced, not kept: one that never loaded drops every later message
      // unanswered. Most often it never loaded because the tab outlived a
      // deploy, and the error then says so.
      worker.onerror = () => {
        const settles = [...this.pending.values()];
        this.pending.clear();
        this.sceneSent = null;
        worker.terminate();
        if (this.worker !== worker) return;
        const stopped = workerStoppedError('The mold worker stopped.');
        this.stopped = stopped;
        void stopped.then((failed) => {
          for (const settle of settles) settle.reject(failed);
        });
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

  /**
   * A fresh worker for a request that carries everything it needs. Not started
   * from onerror, which would loop load-fail-respawn on an out-of-date tab.
   */
  private revive() {
    if (!this.stopped) return;
    this.stopped = null;
    this.spawn();
  }

  async generate(scene: SceneGraph, options: Partial<MoldOptions>): Promise<MoldPreview> {
    this.revive();
    if (!this.worker) {
      const wasm = await loadManifold().catch(() => null);
      const result = generateMoldMeshes(scene, options, wasm);
      this.lastResult = result;
      return {
        summary: moldSummary(result),
        ...moldPreviewBuffers(result),
      };
    }

    const fresh = scene !== this.sceneSent;
    this.sceneSent = scene;
    return this.send<MoldPreview>({ type: 'GENERATE', options, ...(fresh ? { scene } : {}) });
  }

  /** The plate as binary STL, encoded from whatever was generated last. */
  async stl(): Promise<Uint8Array> {
    if (!this.worker) return this.lastResult?.binarySTL ?? new Uint8Array(84);
    // The mold the dead worker held is gone with it.
    if (this.stopped) throw await this.stopped;
    return this.send<Uint8Array>({ type: 'STL' });
  }

  /** The lined mold as a two-material 3MF (PLA shell on filament 1, PVA liner on 2). */
  async threeMf(): Promise<Uint8Array> {
    if (!this.worker) {
      const bytes = this.lastResult?.threeMf;
      if (!bytes) throw new Error('This mold has no liner, so there is no two-material 3MF.');
      return bytes;
    }
    if (this.stopped) throw await this.stopped;
    return this.send<Uint8Array>({ type: 'THREEMF' });
  }

  /**
   * The silicone chain: pour the silicone round the master in its box, turn the
   * mold over, vent it, and pour the material in (castChain.ts).
   */
  async siliconeChain(scene: SceneGraph, ids: string[], boxOptions: Partial<PourBoxOptions>, material: CastMaterialId): Promise<ChainResult<SiliconeChain>> {
    this.revive();
    if (!this.worker) return siliconeChain(scene, ids, boxOptions, material);
    return this.send<ChainResult<SiliconeChain>>({ type: 'CHAIN_SILICONE', scene, ids, boxOptions, material });
  }

  /** The metal chain: pattern in its flask, filled round, burnt or drawn out, and poured (castChain.ts). */
  async metalChain(scene: SceneGraph, options: Partial<CastOptions>): Promise<ChainResult<MetalChain>> {
    this.revive();
    if (!this.worker) return metalChain(scene, options);
    return this.send<ChainResult<MetalChain>>({ type: 'CHAIN_METAL', scene, options });
  }

  /** Simulates the cast solid from whatever mold was generated last; `measure` sets it against the part. */
  async cast(options?: MoldCastSimulationOptions, measure = false): Promise<MoldCastSimulationResult> {
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
    // The mold the dead worker held is gone with it.
    if (this.stopped) throw await this.stopped;
    return this.send<MoldCastSimulationResult>({ type: 'CAST', options, measure });
  }

  /** Simulates the cast solid from an existing mold SceneNode off the main thread. */
  async castNode(node: SceneNode, options?: MoldCastSimulationOptions): Promise<MoldCastSimulationResult> {
    this.revive();
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
    this.stopped = null;
  }
}

const PULL_DIRECTIONS: readonly string[] = ['auto', '+z', '-z', '+y', '-y', '+x', '-x'];

export function moldOptionsFor(msg: Record<string, unknown>): {
  options: Partial<MoldOptions>;
  fromDialog: boolean;
  /** Set when an option names something that does not exist. */
  error?: string;
} {
  const fromDialog = lastMoldOptions();
  const castMaterial = resolveCastMaterial(msg.castMaterial);
  const badMaterial = msg.castMaterial !== undefined && (!castMaterial || castMaterialSpec(castMaterial).metal);
  return {
    ...(badMaterial
      ? { error: `cast_material is one of ${CAST_MATERIALS.filter((m) => !m.metal).map((m) => m.id).join(', ')}; metals go in sand or investment (physics_export_cast).` }
      : {}),
    fromDialog: Boolean(fromDialog),
    options: {
      // Without the dialog's choice, an agent gets what the dialog would give a
      // newcomer: the simplest mold that keeps the part.
      ...(fromDialog ?? { ...DEFAULT_MOLD_OPTIONS, moldType: 'auto' as const }),
      ...(msg.moldType === 'open' || msg.moldType === 'clamshell' || msg.moldType === 'auto'
        ? { moldType: msg.moldType }
        : {}),
      ...(typeof msg.pullDirection === 'string' && PULL_DIRECTIONS.includes(msg.pullDirection)
        ? { pullDirection: msg.pullDirection as MoldOptions['pullDirection'] }
        : {}),
      ...(typeof msg.wallMarginMm === 'number' ? { wallMarginMm: msg.wallMarginMm } : {}),
      ...(typeof msg.baseThicknessMm === 'number' ? { baseThicknessMm: msg.baseThicknessMm } : {}),
      ...(typeof msg.cavityDepthMm === 'number' ? { cavityDepthMm: msg.cavityDepthMm } : {}),
      // draft_deg is the tool's name for it, as on the metal chains.
      ...(typeof msg.draftAngleDeg === 'number' ? { draftAngleDeg: msg.draftAngleDeg }
        : typeof msg.draftDeg === 'number' ? { draftAngleDeg: msg.draftDeg } : {}),
      ...(msg.draftMode === 'remove' || msg.draftMode === 'add' || msg.draftMode === 'centre' ? { draftMode: msg.draftMode } : {}),
      ...(typeof msg.allowUndercuts === 'boolean' ? { allowUndercuts: msg.allowUndercuts } : {}),
      ...(typeof msg.includeSprue === 'boolean' ? { includeSprue: msg.includeSprue } : {}),
      ...(typeof msg.includeVents === 'boolean' ? { includeVents: msg.includeVents } : {}),
      ...(typeof msg.ventDiaMm === 'number' ? { ventDiaMm: msg.ventDiaMm } : {}),
      ...(typeof msg.includePryNotches === 'boolean' ? { includePryNotches: msg.includePryNotches } : {}),
      ...(typeof msg.dissolvableLiner === 'boolean' ? { dissolvableLiner: msg.dissolvableLiner } : {}),
      ...(typeof msg.linerSkinMm === 'number' && msg.linerSkinMm > 0 ? { linerSkinMm: msg.linerSkinMm } : {}),
      ...(castMaterial ? { castMaterial } : {}),
    },
  };
}

/** Words for the side a pour came from, as the mold stands in the scene. */
export function pourSideLabel(dir: PourDirection): string {
  return {
    '+z': 'from the top',
    '-z': 'from underneath, the mold turned over',
    '+x': 'from the +X side, the mold on its side',
    '-x': 'from the -X side, the mold on its side',
    '+y': 'from the +Y side, the mold on its side',
    '-y': 'from the -Y side, the mold on its side',
  }[dir];
}

/** The undercut warning, or null when a rigid mold lets go. */
export function pourUndercutWarning(pour: PourInfo): string | null {
  return pour.undercutMm2 > 0
    ? `Undercut (${pour.undercutMm2.toLocaleString()} mm² held in): fine when the mold or the casting is flexible, ` +
      'like silicone; a rigid mold and a rigid casting will not come apart.'
    : null;
}

/** The hole that has to be stopped before pouring, or null. */
export function pourPlugNote(pour: PourInfo): string | null {
  return pour.plugMm2
    ? `Open underneath through ${pour.plugMm2} mm²: plug it before pouring (a wick through it does).`
    : null;
}

function pourDetails(pour: PourInfo): string[] {
  const warning = pourUndercutWarning(pour);
  const plug = pourPlugNote(pour);
  return [
    `Poured ${pourSideLabel(pour.direction)}, ${pour.filledMm} mm deep of ${pour.depthMm} mm`,
    ...(plug ? [plug] : []),
    ...(warning ? [warning] : []),
  ];
}

/**
 * Adds what was poured into a mold body (or a group of them) to the scene, set
 * beside the mold or over it.
 */
export async function addPourToScene(
  moldNode: SceneNode,
  castRes: MoldCastSimulationResult,
  placement: 'beside' | 'overlay',
  material?: CastMaterialId,
): Promise<{ id: string; name: string }> {
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
  // A simulated mold's name carries its own 'Simulated:' and time stamp, which
  // the cast's name would otherwise repeat inside its own.
  const moldName = moldNode.name
    .replace(/^Simulated: /, '')
    .replace(/ \d{4}-\d{2}-\d{2} \d{2}:\d{2}(_\d+)?$/, '');
  const added = await addSimulationToScene({
    mesh: castRes.mesh,
    transform: moldTransform,
    kind: 'cast',
    label: `Cast from ${moldName}`,
    placement,
    ...(material ? { material } : {}),
    details: [
      `Simulated casting from mold: ${moldNode.name} (${moldNode.id})`,
      `Cast dimensions: ${castRes.sizeMm.width} × ${castRes.sizeMm.depth} × ${castRes.sizeMm.height} mm`,
      ...(castRes.pour ? pourDetails(castRes.pour) : []),
    ],
  });
  if (castRes.textures && castRes.textures.length > 0) {
    const castGeom = useStore.getState().sceneGraph.nodes.find((n) => n.id === added.id)?.geoms?.[0];
    if (castGeom) {
      useStore.getState().setGeomTextures(added.id, castGeom.name, castRes.textures);
    }
  }
  return added;
}

/** A chain's piece as an MCP reply. */
function pieceReply(p: ChainPiece): Record<string, unknown> {
  return {
    castMaterial: p.material,
    volumeMm3: p.volumeMm3,
    weightG: p.weightG,
    ...(p.mix ? { mixG: { [p.mix.aLabel]: Math.round(p.mix.a * 10) / 10, [p.mix.bLabel]: Math.round(p.mix.b * 10) / 10 } } : {}),
    ...(p.gating ? { gating: p.gating } : {}),
    ...(p.deviation ? { deviationMm: p.deviation } : {}),
    ...(p.notes.length ? { materialNotes: p.notes } : {}),
  };
}

/** method 'silicone', 'sand' or 'lost-pla': the whole job to the finished piece. */
async function runMcpChain(
  msg: Record<string, unknown>,
  scene: SceneGraph,
  pickSubject: () => ReturnType<typeof mcpMoldSubject>,
): Promise<Record<string, unknown>> {
  const subject = pickSubject();
  if ('error' in subject) return { ok: false, error: subject.error };
  const method = msg.method as 'silicone' | 'sand' | 'lost-pla';
  const tab = method;
  const named = resolveCastMaterial(msg.castMaterial);
  if (msg.castMaterial !== undefined && (!named || !materialFitsTab(tab, named))) {
    return { ok: false, error: `For method '${method}', cast_material is one of ${tabMaterials(tab).map((m) => m.id).join(', ')}.` };
  }
  const remembered = method === 'silicone' ? null : lastCastOptions(method);
  const material = named ?? (remembered?.metalId as CastMaterialId | undefined) ?? DEFAULT_TAB_MATERIAL[tab];
  const client = new MoldWorkerClient();
  try {
    if (method === 'silicone') {
      // The box already round the master as physics_make_pour_box made it,
      // else one at its default sizes, with any hole through the silicone asked for.
      const madeBox = pourBoxOptionsFor(scene, subject.ids);
      const boxOptions: Partial<PourBoxOptions> = { ...madeBox };
      if (msg.hole === 'wick' || msg.hole === 'pour' || msg.hole === 'fixing') boxOptions.hole = msg.hole;
      else if (msg.hole === 'none') boxOptions.hole = null;
      else if (msg.hole !== undefined && msg.hole !== null) {
        return { ok: false, error: "hole is 'wick', 'pour', 'fixing' or 'none'." };
      }
      if (typeof msg.holeDiaMm === 'number' && msg.holeDiaMm > 0) boxOptions.holeDiaMm = msg.holeDiaMm;
      if (Array.isArray(msg.holeAtMm) && msg.holeAtMm.length === 2 && msg.holeAtMm.every((v) => typeof v === 'number')) {
        boxOptions.holeAtMm = msg.holeAtMm as [number, number];
      }
      const silicone = resolveCastMaterial(msg.silicone);
      if (silicone && castMaterialSpec(silicone).silicone) boxOptions.silicone = silicone as PourBoxOptions['silicone'];
      const r = await client.siliconeChain(scene, subject.ids, boxOptions, material);
      if (!r.ok) return { ok: false, error: r.error };
      const added = await addSiliconeChain(r);
      return {
        ok: true, kind: 'mold_cast', method,
        molded: { label: subject.label, ids: subject.ids },
        id: added.piece.id, name: added.piece.name,
        siliconeMold: { id: added.siliconeMold!.id, name: added.siliconeMold!.name, selected: true, vents: r.vents, silicone: r.silicone },
        pouredThrough: r.pouredThrough,
        pourBoxFrom: madeBox ? 'the pour box in the scene' : 'the defaults',
        ...pieceReply(r.piece),
        warnings: r.warnings,
      };
    }
    // The parting, riser, sprue and gating last planned for this method, as
    // the rigid mold takes the Rigid tab's.
    const options: Partial<CastOptions> = {
      ...remembered,
      method,
      metalId: material,
      draftDeg: typeof msg.draftDeg === 'number' ? msg.draftDeg : remembered?.draftDeg ?? DEFAULT_TAB_DRAFT[tab],
      ...(typeof msg.shrinkPercent === 'number' && msg.shrinkPercent >= 0 ? { shrinkPercent: msg.shrinkPercent } : {}),
      ...(typeof msg.addGating === 'boolean' ? { addGating: msg.addGating } : {}),
    };
    const r = await client.metalChain(subject.scene, options);
    if (!r.ok) return { ok: false, error: r.error };
    const added = await addMetalChain(r, method);
    return {
      ok: true, kind: 'mold_cast', method,
      molded: { label: subject.label, ids: subject.ids },
      id: added.piece.id, name: added.piece.name,
      flask: r.flask,
      optionsFrom: remembered ? 'the pattern last planned (Mold dialog or physics_export_cast)' : 'the defaults',
      ...(method === 'sand' ? { sandG: r.fillG } : { investmentPowderG: r.fillG }),
      filledShare: r.filledShare,
      ...pieceReply(r.piece),
      warnings: r.warnings,
    };
  } finally {
    client.dispose();
  }
}

/** What a pour weighs in this material, and how to mix it. */
function pourWeight(material: CastMaterialId, volumeMm3: number): Record<string, unknown> {
  const grams = castWeightG(material, volumeMm3);
  const mix = mixGrams(material, grams);
  const notes = castMaterialWarnings(material, volumeMm3 / 1000, { pla: false });
  return {
    castMaterial: material,
    weightG: Math.round(grams * 10) / 10,
    ...(mix ? { mixG: { [mix.aLabel]: Math.round(mix.a * 10) / 10, [mix.bLabel]: Math.round(mix.b * 10) / 10 } } : {}),
    ...(notes.length ? { materialNotes: notes } : {}),
  };
}

export async function runMcpMoldSimulation(params: {
  msg: Record<string, unknown>;
  scene: SceneGraph;
  placement: 'beside' | 'overlay';
  toId: (s: string) => string;
  findNodeInScene: (nodes: SceneNode[], id: string) => SceneNode | null;
  /** The bridge's file packer, for a lined mold's 3MF. */
  describeFiles?: (files: { name: string; bytes: Uint8Array }[], include: boolean) => unknown[];
}): Promise<Record<string, unknown>> {
  const { msg, placement, toId, findNodeInScene, describeFiles } = params;
  const fullScene = params.scene;
  // A new mold is of master_id, else every body.
  const pickSubject = () => mcpMoldSubject(fullScene, msg.masterId, (id) => findNodeInScene(fullScene.nodes, toId(id)));

  // The Silicone, Sand and Lost PLA tabs' one-click chains: a new mold only,
  // never a pour into one that body_id names.
  if (msg.method !== undefined && msg.method !== 'rigid') {
    if (msg.method !== 'silicone' && msg.method !== 'sand' && msg.method !== 'lost-pla') {
      return { ok: false, error: "method is 'rigid', 'silicone', 'sand' or 'lost-pla'." };
    }
    if (msg.kind !== 'mold_cast' && msg.kind !== 'cast') return { ok: false, error: "method goes with kind 'mold_cast'." };
    if (msg.bodyId !== undefined || msg.targetId !== undefined) {
      return { ok: false, error: 'method makes a new mold of the master; body_id pours into one already in the scene. Pass one or the other.' };
    }
    return runMcpChain(msg, fullScene, pickSubject);
  }
  const { options: moldOpts, fromDialog, error: optionError } = moldOptionsFor(msg);
  if (optionError) return { ok: false, error: optionError };
  const optionsFrom = fromDialog ? "the Mold dialog's Rigid tab" : 'the scene defaults';

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
    // Several bodies, comma separated, pour as one mold: a master and its sleeve.
    const rawIds = rawBodyId ? rawBodyId.split(',').map((s) => s.trim()).filter(Boolean) : [];
    if (rawIds.length > 0) {
      const missing = rawIds.filter((id) => !findNodeInScene(fullScene.nodes, toId(id)));
      if (missing.length > 0) {
        return { ok: false, error: `No mold body with id '${missing.join("', '")}'.` };
      }
      const picked = pourSelection(fullScene.nodes, rawIds.map(toId));
      if (!picked) {
        return { ok: false, error: `No mold body with id '${rawBodyId}'.` };
      }
      if (picked.apart.length > 0) {
        return {
          ok: false,
          error: `${picked.apart.map((n) => `'${n.id}'`).join(', ')} ${picked.apart.length === 1 ? 'does' : 'do'} not touch '${rawIds[0]}', `
            + 'so together they hold nothing: pass only bodies that make one mold, such as a master and its sleeve.',
        };
      }
      const moldNode = picked.node;
      if (msg.castMaterial !== undefined && moldOpts.castMaterial && castMaterialSpec(moldOpts.castMaterial).silicone && isSiliconeMold(moldNode)) {
        return { ok: false, error: 'That mold is silicone, and silicone sticks to silicone: pour resin, wax, plaster or another cast_material into it.' };
      }
      // A master in its pour box fills to the box's line from the top, unless told otherwise.
      const box = pourBoxIn(moldNode);
      const fillMm = typeof msg.fillMm === 'number' && msg.fillMm > 0 ? msg.fillMm : box?.pourDepthMm;
      const castRes = await withWorker((c) =>
        c.castNode(moldNode, {
          trimChannels: msg.trimChannels === true,
          orientUpright: msg.orientUpright !== false,
          pour: {
            direction: POUR_DIRECTIONS.includes(msg.pourDirection as PourDirection) ? (msg.pourDirection as PourDirection) : box ? '+z' : 'auto',
            ...(fillMm ? { fillMm } : {}),
          },
        }),
      );
      if (!castRes.success) {
        return {
          ok: false,
          error: castRes.error || 'Could not simulate casting from mold body.',
          warnings: castRes.warnings,
        };
      }
      const added = await addPourToScene(moldNode, castRes, placement, msg.castMaterial !== undefined ? moldOpts.castMaterial : undefined);
      return {
        ok: true,
        id: added.id,
        name: added.name,
        kind: 'mold_cast',
        sourceMoldId: moldNode.id,
        ...(castRes.pour ? { pour: castRes.pour } : {}),
        placement,
        fillFrom: typeof msg.fillMm === 'number' && msg.fillMm > 0 ? 'fill_mm' : box ? 'pour box' : 'rim',
        sizeMm: castRes.sizeMm,
        volumeMm3: Math.round(castRes.castVolumeMm3),
        ...(moldOpts.castMaterial && msg.castMaterial !== undefined ? pourWeight(moldOpts.castMaterial, castRes.castVolumeMm3) : {}),
        cavityComponents: castRes.cavityComponents,
        warnings: castRes.warnings,
      };
    }

    const subject = pickSubject();
    if ('error' in subject) {
      return { ok: false, error: subject.error };
    }
    const scene = subject.scene;
    const { preview, castRes } = await withWorker(async (c) => {
      const p = await c.generate(scene, moldOpts);
      if (!p.summary.success) return { preview: p, castRes: null };
      const cr = await c.cast({
        trimChannels: msg.trimChannels === true,
        orientUpright: msg.orientUpright !== false,
      }, true);
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
        `Mold type: ${moldRes.moldType === 'open' ? 'One-part open mold' : 'Two-part clamshell mold'}`,
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
      placement,
      molded: { label: subject.label, ids: subject.ids },
      optionsFrom,
      method: 'rigid',
      moldType: moldRes.moldType,
      pullDirection: moldRes.pullDirection,
      ...(moldRes.setupNote ? { setupNote: moldRes.setupNote } : {}),
      sizeMm: castRes.sizeMm,
      volumeMm3: Math.round(castRes.castVolumeMm3),
      ...(castRes.deviation ? { deviationMm: castRes.deviation } : {}),
      ...(moldOpts.castMaterial && msg.castMaterial !== undefined ? pourWeight(moldOpts.castMaterial, castRes.castVolumeMm3) : {}),
      cavityComponents: castRes.cavityComponents,
      warnings: [...moldRes.warnings, ...castRes.warnings],
    };
  }

  // msg.kind === 'mold'
  const subject = pickSubject();
  if ('error' in subject) return { ok: false, error: subject.error };
  const scene = subject.scene;
  const { preview, stl, threeMf } = await withWorker(async (c) => {
    const p = await c.generate(scene, moldOpts);
    const bytes = p.summary.success ? await c.stl() : new Uint8Array(84);
    const lined = p.summary.success && p.summary.liner ? await c.threeMf() : null;
    return { preview: p, stl: bytes, threeMf: lined };
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
    molded: { label: subject.label, ids: subject.ids },
    optionsFrom,
    moldType: moldRes.moldType,
    pullDirection: moldRes.pullDirection,
    ...(moldRes.setupNote ? { setupNote: moldRes.setupNote } : {}),
    moldSizeMm: [moldRes.moldWidthMm, moldRes.moldDepthMm, moldRes.moldHeightMm],
    cavityDepthMm: moldRes.cavityDepthMm,
    minDraftDeg: moldRes.minDraftDeg,
    volumeMm3: Math.round(added.volumeMm3),
    ...(moldRes.liner ? { liner: moldRes.liner } : {}),
    warnings: moldRes.warnings,
    // The two-material print file; its bytes only when the caller keeps them.
    ...(threeMf && describeFiles
      ? {
          files: describeFiles(
            [{ name: moldRes.moldType === 'open' ? 'casting_mold_open_pva.3mf' : 'casting_mold_plate_pva.3mf', bytes: threeMf }],
            msg.includeFiles === true,
          ),
        }
      : {}),
  };
}
