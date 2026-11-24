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
import { normalizeMask, usablePhotoMask, viewDirection, type Mask, type View } from '../../utils/silhouette';
import { bestViewOffThread } from '../../utils/silhouetteClient';
import { renderViewportNow } from '../../utils/viewportCapture';
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
export const settle = (n: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  let rafId = 0;
  let settled = false;
  const done = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (rafId) cancelAnimationFrame(rafId);
    signal?.removeEventListener('abort', done);
    resolve();
  };
  const timer = setTimeout(done, 250);
  signal?.addEventListener('abort', done);
  const step = (left: number) => {
    if (settled) return;
    if (left <= 0) { done(); return; }
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      step(left - 1);
    });
  };
  step(n);
});

export const MAX_OUTLINE_CANVAS_SIDE = 256;
const OUTLINE_CANVAS_PAD = 2;

/** Bounded canvas dimensions + scale fitting traced mm geometry into <= 256 px preserving aspect. */
export function fitOutlineCanvas(widthMm: number, heightMm: number): { width: number; height: number; scale: number } | null {
  if (!(widthMm > 0) || !(heightMm > 0) || !Number.isFinite(widthMm) || !Number.isFinite(heightMm)) return null;
  const innerMax = MAX_OUTLINE_CANVAS_SIDE - OUTLINE_CANVAS_PAD * 2;
  const scale = innerMax / Math.max(widthMm, heightMm);
  const width = Math.max(4, Math.min(MAX_OUTLINE_CANVAS_SIDE, Math.ceil(widthMm * scale) + OUTLINE_CANVAS_PAD * 2));
  const height = Math.max(4, Math.min(MAX_OUTLINE_CANVAS_SIDE, Math.ceil(heightMm * scale) + OUTLINE_CANVAS_PAD * 2));
  return { width, height, scale };
}

/**
 * The first photo's outline, normalised: the tracer's, so a part lying on a
 * sheet of paper is the part and not the sheet. Null when nothing traces or
 * the traced mask fails usablePhotoMask().
 */
export async function photoOutline(photo: LlmImage): Promise<Mask | null> {
  try {
    const img = await decodeImageUrl(llmImageUrl(photo), 480);
    const t = traceProfile(img.data, img.width, img.height, { detail: 'normal', widthMm: 400 });
    const fitted = fitOutlineCanvas(t.widthMm, t.heightMm);
    if (!fitted || !t.shapes.length) return null;
    const { width: W, height: H, scale } = fitted;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    const path = new Path2D();
    for (const s of t.shapes) {
      for (const loop of [s.outline, ...s.holes]) {
        loop.forEach((q, i) => (i ? path.lineTo(q.x * scale + W / 2, H / 2 - q.y * scale) : path.moveTo(q.x * scale + W / 2, H / 2 - q.y * scale)));
        path.closePath();
      }
    }
    ctx.fill(path, 'evenodd');
    const px = ctx.getImageData(0, 0, W, H).data;
    const mask = new Uint8Array(W * H);
    for (let i = 0; i < mask.length; i++) mask[i] = px[i * 4 + 3] > 127 ? 1 : 0;
    if (!usablePhotoMask(mask, W, H)) return null;
    return normalizeMask(mask, W, H);
  } catch {
    return null;
  }
}

/** The viewport looking at the part from `view`, edges off, as a picture. */
async function renderFrom(view: View, signal?: AbortSignal): Promise<LlmImage | null> {
  if (signal?.aborted) return null;
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
    if (signal?.aborted) return null;
    const canvas = renderViewportNow();
    return canvas && canvas.width ? drawableToLlmImage(canvas, canvas.width, canvas.height, 1024) : null;
  } finally {
    const s = useStore.getState();
    if (before.edges && !s.showEdges) s.toggleShowEdges();
    if (before.wire && !s.wireframe) s.toggleWireframe();
    if (before.colliders) useViewQuality.getState().setShowColliders(true);
  }
}

export function usePictureToPart(sceneSystem: string) {
  const [progress, setProgress] = useState<LoopProgress | null>(null);
  const abort = useRef<AbortController | null>(null);
  // Closing the panel takes the Stop button with it: stop the loop too.
  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(async (request: string, photos: LlmImage[], maxRounds?: number): Promise<LoopReport> => {
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setProgress({ round: 1, maxRounds: maxRounds ?? 5, stage: 'building', rounds: [] });
    let expectedNodes: SceneNode[] | null = null;
    let isFirstApply = true;
    const externallyEdited = () => expectedNodes !== null && useStore.getState().sceneGraph.nodes !== expectedNodes;
    try {
      const photoMask = photos.length ? await photoOutline(photos[0]) : null;
      return await runPictureToPart({ request, photos, photoMask, sceneSystem, maxRounds }, {
        llm: (system, user, images) => callLlm({ system, user, images, signal: ctl.signal }),
        async apply(nodes: RawNode[]) {
          if (externallyEdited()) {
            ctl.abort();
            return { ok: false, error: 'The scene was modified externally.' };
          }
          const normalized = mergeAndNormalizeNodes(nodes, [], true);
          if (!normalized.length) return { ok: false, error: 'The nodes were empty once normalised.' };
          const replacesScene = isFirstApply;
          isFirstApply = false;
          const res = await settleScene(normalized as SceneNode[], { replacesScene, waitForColliders: false });
          expectedNodes = useStore.getState().sceneGraph.nodes;
          if (res.scadErrors?.length) {
            const failed = res.scadErrors.map((f) => `${f.name || f.id}: ${f.error.slice(0, 300)}`);
            return { ok: false, error: `OpenSCAD did not compile ${failed.join('; ')}` };
          }
          if (!res.ok) return { ok: false, error: res.error };
          if (!sizeMm(collectSceneTriangles(useStore.getState().sceneGraph).tris)) {
            return { ok: false, error: 'It built nothing solid.' };
          }
          return { ok: true };
        },
        sceneChanged: externallyEdited,
        partNodes: () => lean(useStore.getState().sceneGraph.nodes) as RawNode[],
        partTriangles: () => collectSceneTriangles(useStore.getState().sceneGraph).tris,
        render: (view) => renderFrom(view, ctl.signal),
        bestView: (tris, photo, near, signal) => bestViewOffThread(tris, photo, near, signal ?? ctl.signal),
        onProgress: (p) => { if (abort.current === ctl) setProgress(p); },
        signal: ctl.signal,
      });
    } finally {
      if (abort.current === ctl) {
        abort.current = null;
        setProgress(null);
      }
    }
  }, [sceneSystem]);

  const stop = useCallback(() => abort.current?.abort(), []);
  return { run, stop, progress };
}
