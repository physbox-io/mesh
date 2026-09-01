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
  moldSummary,
  trianglesToBuffers,
  type MoldOptions,
} from '../utils/moldExporter';
import type { SceneGraph } from '../types/scene';

type Incoming =
  | { type: 'GENERATE'; id: number; scene?: SceneGraph; options: Partial<MoldOptions> }
  | { type: 'STL'; id: number };

let scene: SceneGraph = { nodes: [] };
/** The last mold generated, kept so an STL can be encoded without redoing it. */
let last: ReturnType<typeof generateMoldMeshes> | null = null;

self.onmessage = (evt: MessageEvent<Incoming>) => {
  const msg = evt.data;

  if (msg.type === 'GENERATE') {
    if (msg.scene) scene = msg.scene;
    try {
      const result = generateMoldMeshes(scene, msg.options);
      last = result;

      const bottom = trianglesToBuffers(result.bottomHalf.triangles);
      const top = result.topHalf ? trianglesToBuffers(result.topHalf.triangles) : null;
      const transfer = [bottom.positions.buffer, bottom.normals.buffer];
      if (top) transfer.push(top.positions.buffer, top.normals.buffer);

      self.postMessage(
        { type: 'GENERATED', id: msg.id, summary: moldSummary(result), bottom, top },
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
  }
};
