/// <reference lib="webworker" />

// Owns mold generation, off the main thread.
//
// Generating a mold is a few hundred milliseconds of column sampling and mesh
// building on a relief, and the export modal regenerates on every keystroke and
// every drag of a slider. Inline on the main thread that is a frozen dialog: the
// preview cannot redraw, the number input cannot echo what was typed, and the
// modal reads as broken rather than busy.
//
// The scene is cached here between calls. It is the largest thing crossing the
// boundary — a relief carries its whole vertex array — and dragging a slider
// changes the options, never the scene, so it is sent once and reused until the
// client says otherwise.

import {
  generateMoldMeshes,
  moldPreviewBuffers,
  moldSummary,
  type MoldOptions,
} from '../utils/moldExporter';
import {
  simulateCastFromMoldNode,
  simulateCastFromMoldResult,
  type MoldCastSimulationOptions,
} from '../utils/moldCastSimulation';
import type { SceneGraph, SceneNode } from '../types/scene';
import { loadManifold } from '../utils/sculptCut';
import { deviationMm, masterSoup, metalChain, siliconeChain } from '../utils/castChain';
import type { CastOptions } from '../utils/castPatternExporter';
import type { PourBoxOptions } from '../utils/siliconeMold';
import type { CastMaterialId } from '../utils/castMaterials';

type Incoming =
  | { type: 'GENERATE'; id: number; scene?: SceneGraph; options: Partial<MoldOptions> }
  | { type: 'STL'; id: number }
  | { type: 'THREEMF'; id: number }
  | { type: 'CAST'; id: number; options?: MoldCastSimulationOptions; measure?: boolean }
  | { type: 'CHAIN_SILICONE'; id: number; scene: SceneGraph; ids: string[]; boxOptions: Partial<PourBoxOptions>; material: CastMaterialId }
  | { type: 'CHAIN_METAL'; id: number; scene: SceneGraph; options: Partial<CastOptions> }
  | { type: 'CAST_NODE'; id: number; node: SceneNode; options?: MoldCastSimulationOptions };

let scene: SceneGraph = { nodes: [] };
/** The last mold generated, kept so an STL can be encoded without redoing it. */
let last: ReturnType<typeof generateMoldMeshes> | null = null;

self.onmessage = async (evt: MessageEvent<Incoming>) => {
  const msg = evt.data;

  if (msg.type === 'GENERATE') {
    if (msg.scene) scene = msg.scene;
    try {
      const wasm = await loadManifold().catch(() => null);
      const result = generateMoldMeshes(scene, msg.options, wasm);
      last = result;

      const { bottom, top, liner } = moldPreviewBuffers(result);
      const transfer = [bottom.positions.buffer, bottom.normals.buffer];
      if (top) transfer.push(top.positions.buffer, top.normals.buffer);
      if (liner) transfer.push(liner.bottom.positions.buffer, liner.bottom.normals.buffer);
      if (liner?.top) transfer.push(liner.top.positions.buffer, liner.top.normals.buffer);

      self.postMessage(
        { type: 'GENERATED', id: msg.id, summary: moldSummary(result), bottom, top, liner },
        transfer
      );
    } catch (e) {
      last = null;
      self.postMessage({ type: 'FAILED', id: msg.id, message: (e as Error)?.message ?? String(e) });
    }
    return;
  }

  if (msg.type === 'STL') {
    // Reading .binarySTL is what encodes it, and it is encoded at most once per
    // mold however many times the download button is pressed.
    const bytes = last ? last.binarySTL : new Uint8Array(84);
    const copy = new Uint8Array(bytes); // transferred away, so the cache keeps its own
    self.postMessage({ type: 'STL', id: msg.id, bytes: copy }, [copy.buffer]);
    return;
  }

  if (msg.type === 'THREEMF') {
    const bytes = last?.threeMf;
    if (!bytes) {
      self.postMessage({ type: 'FAILED', id: msg.id, message: 'This mold has no liner, so there is no two-material 3MF.' });
      return;
    }
    const copy = new Uint8Array(bytes);
    self.postMessage({ type: 'STL', id: msg.id, bytes: copy }, [copy.buffer]);
    return;
  }

  if (msg.type === 'CAST') {
    if (!last) {
      self.postMessage({ type: 'FAILED', id: msg.id, message: 'No mold generated yet.' });
      return;
    }
    try {
      const castResult = await simulateCastFromMoldResult(last, msg.options);
      // Set against the part it was molded from, both taken as they stand.
      // The sprue and vent stubs are cut off a casting before anyone compares it
      // with the part, so the measure is taken on a trimmed one.
      if (msg.measure && castResult.success) {
        const measured = msg.options?.trimChannels ? castResult : await simulateCastFromMoldResult(last, { ...msg.options, trimChannels: true });
        if (measured.success) {
          const soup = new Float64Array(measured.mesh.faces.length * 3);
          measured.mesh.faces.forEach((v, i) => soup.set(measured.mesh.positions.subarray(v * 3, v * 3 + 3), i * 3));
          castResult.deviation = deviationMm(soup, masterSoup(await loadManifold(), scene)) ?? undefined;
        }
      }
      const transfer: Transferable[] = [];
      if (castResult.mesh.positions.byteLength > 0) transfer.push(castResult.mesh.positions.buffer);
      if (castResult.mesh.faces.byteLength > 0) transfer.push(castResult.mesh.faces.buffer);
      self.postMessage({ type: 'CAST', id: msg.id, result: castResult }, transfer);
    } catch (e) {
      self.postMessage({ type: 'FAILED', id: msg.id, message: (e as Error)?.message ?? String(e) });
    }
    return;
  }

  if (msg.type === 'CHAIN_SILICONE' || msg.type === 'CHAIN_METAL') {
    try {
      const result = msg.type === 'CHAIN_SILICONE'
        ? await siliconeChain(msg.scene, msg.ids, msg.boxOptions, msg.material)
        : await metalChain(msg.scene, msg.options);
      self.postMessage({ type: 'CHAIN', id: msg.id, result });
    } catch (e) {
      self.postMessage({ type: 'FAILED', id: msg.id, message: (e as Error)?.message ?? String(e) });
    }
    return;
  }

  if (msg.type === 'CAST_NODE') {
    try {
      const castResult = await simulateCastFromMoldNode(msg.node, msg.options);
      const transfer: Transferable[] = [];
      if (castResult.mesh.positions.byteLength > 0) transfer.push(castResult.mesh.positions.buffer);
      if (castResult.mesh.faces.byteLength > 0) transfer.push(castResult.mesh.faces.buffer);
      self.postMessage({ type: 'CAST', id: msg.id, result: castResult }, transfer);
    } catch (e) {
      self.postMessage({ type: 'FAILED', id: msg.id, message: (e as Error)?.message ?? String(e) });
    }
  }
};
