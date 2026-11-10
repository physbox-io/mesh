// The picture-to-part loop (utils/pictureToPart.ts) wired to the app: the
// copilot's model, the scene, the part's triangles and the viewport.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import { useViewQuality } from '../../store/viewQualityStore';
import { callLlm, type LlmImage } from '../../utils/llmCall';
import { drawableToLlmImage, llmImageUrl } from '../../utils/llmImageInput';
import { decodeImageUrl } from '../../utils/decodeImage';
import { mergeAndNormalizeNodes, type RawNode } from '../../utils/sceneNodes';
import { collectSceneTriangles } from '../../utils/contourSliceExporter';
import { traceProfile } from '../../utils/profileImport';
import { normalizeMask, viewDirection, type Mask, type View } from '../../utils/silhouette';
import { bestViewOffThread } from '../../utils/silhouetteClient';
import { renderViewportNow } from '../../utils/viewportCapture';
import { compileSCAD } from '../../utils/openscad';
import { settleScene } from '../../hooks/mcp/settleScene';
import { runPictureToPart, sizeMm, type LoopProgress, type LoopReport } from '../../utils/pictureToPart';
import type { SceneNode } from '../../types/scene';

/** Mesh arrays and compile results: the builder needs the program, not its output. */
const BULKY = new Set([
  'vertices', 'renderVertices', 'faces', 'colliderVertices', 'colliderFaces', 'verticesZUp',
  'csgMesh', 'colliders', 'collisionHash', 'csgHash', 'latticeCage', 'sculpt',
]);

function lean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(lean);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (BULKY.has(k)) continue;
    out[k] = lean(v);
  }
  return out;
}

/**
 * A few frames for the camera to move, but never more than a quarter of a
 * second: a hidden tab gets no animation frames at all, and the loop sat at
 * "matching view" until the tab came back, deaf to Stop.
 */
const settle = (n: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, 250);
  signal?.addEventListener('abort', done);
  const step = (left: number) => (left <= 0 ? done() : requestAnimationFrame(() => step(left - 1)));
  step(n);
});

/**
 * The first photo's outline, normalised: the tracer's, so a part lying on a
 * sheet of paper is the part and not the sheet. Null when nothing traces.
 */
async function photoOutline(photo: LlmImage): Promise<Mask | null> {
  try {
    const img = await decodeImageUrl(llmImageUrl(photo), 480);
    const t = traceProfile(img.data, img.width, img.height, { detail: 'normal', widthMm: 400 });
    const W = Math.ceil(t.widthMm) + 4, H = Math.ceil(t.heightMm) + 4;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    const path = new Path2D();
    for (const s of t.shapes) {
      for (const loop of [s.outline, ...s.holes]) {
        loop.forEach((q, i) => (i ? path.lineTo(q.x + W / 2, H / 2 - q.y) : path.moveTo(q.x + W / 2, H / 2 - q.y)));
        path.closePath();
      }
    }
    ctx.fill(path, 'evenodd');
    const px = ctx.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;
    return normalizeMask(mask, W, H);
  } catch {
    return null;
  }
}

/** The viewport looking at the part from `view`, edges off, as a picture. */
async function renderFrom(view: View, signal?: AbortSignal): Promise<LlmImage | null> {
  const tris = collectSceneTriangles(useStore.getState().sceneGraph).tris;
  if (tris.length < 9) return null;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      lo[a] = Math.min(lo[a], tris[i + a]);
      hi[a] = Math.max(hi[a], tris[i + a]);
    }
  }
  const centre = [0, 1, 2].map((a) => (lo[a] + hi[a]) / 2) as [number, number, number];
  const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 0.1;
  // A hair off the pole: the viewport's camera has no up to look straight down by.
  const d = viewDirection({ ...view, elevationDeg: Math.min(view.elevationDeg, 89) });
  const dist = diag * 1.8;
  const store = useStore.getState();
  const before = { edges: store.showEdges, wire: store.wireframe, colliders: useViewQuality.getState().showColliders };
  try {
    if (before.edges) store.toggleShowEdges();
    if (before.wire) store.toggleWireframe();
    if (before.colliders) useViewQuality.getState().setShowColliders(false);
    store.setCameraOverride({ position: [centre[0] + d[0] * dist, centre[1] + d[1] * dist, centre[2] + d[2] * dist], target: centre });
    await settle(3, signal);
    const canvas = renderViewportNow();
    return canvas && canvas.width ? drawableToLlmImage(canvas, canvas.width, canvas.height, 1024) : null;
  } finally {
    const s = useStore.getState();
    if (before.edges && !s.showEdges) s.toggleShowEdges();
    if (before.wire && !s.wireframe) s.toggleWireframe();
    if (before.colliders) useViewQuality.getState().setShowColliders(true);
  }
}

/** SCAD bodies left without a mesh after the build, with what the compiler said. */
async function scadFailures(nodes: SceneNode[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (list: SceneNode[]) => {
    for (const n of list) {
      if (n.scad && !(n.geoms ?? []).some((g) => (g.renderVertices?.length ?? g.vertices?.length ?? 0) > 0)) {
        let why = 'it compiled to nothing';
        try { await compileSCAD(n.scad); } catch (e) { why = ((e as Error)?.message || String(e)).slice(0, 300); }
        out.push(`${n.name || n.id}: ${why}`);
      }
      await walk(n.children ?? []);
    }
  };
  await walk(nodes);
  return out;
}

export function usePictureToPart(sceneSystem: string) {
  const [progress, setProgress] = useState<LoopProgress | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Closing the panel takes the Stop button with it: stop the loop too.
  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(async (request: string, photos: LlmImage[], maxRounds?: number): Promise<LoopReport> => {
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress({ round: 1, maxRounds: maxRounds ?? 5, stage: 'building', rounds: [] });
    try {
      const photoMask = photos.length ? await photoOutline(photos[0]) : null;
      return await runPictureToPart({ request, photos, photoMask, sceneSystem, maxRounds }, {
        llm: (system, user, images) => callLlm({ system, user, images, signal: ctl.signal }),
        async apply(nodes: RawNode[]) {
          const normalized = mergeAndNormalizeNodes(nodes, [], true);
          if (!normalized.length) return { ok: false, error: 'The nodes were empty once normalised.' };
          const res = await settleScene(normalized as SceneNode[], { replacesScene: false, waitForColliders: false });
          if (!res.ok) return { ok: false, error: res.error };
          const failed = await scadFailures(useStore.getState().sceneGraph.nodes || []);
          if (failed.length) return { ok: false, error: `OpenSCAD did not compile ${failed.join('; ')}` };
          if (!sizeMm(collectSceneTriangles(useStore.getState().sceneGraph).tris)) {
            return { ok: false, error: 'It built nothing solid.' };
          }
          return { ok: true };
        },
        partNodes: () => lean(useStore.getState().sceneGraph.nodes) as RawNode[],
        partTriangles: () => collectSceneTriangles(useStore.getState().sceneGraph).tris,
        render: (view) => renderFrom(view, ctl.signal),
        bestView: bestViewOffThread,
        onProgress: setProgress,
        signal: ctl.signal,
      });
    } finally {
      abort.current = null;
      setProgress(null);
    }
  }, [sceneSystem]);

  const stop = useCallback(() => abort.current?.abort(), []);
  return { run, stop, progress };
}
