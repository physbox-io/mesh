// The picture-to-part loop (utils/pictureToPart.ts) wired to the app: the
// copilot's model, the scene, the part's triangles and the viewport.

import { useCallback, useRef, useState } from 'react';
import { useStore } from '../../store/useStore';
import { useViewQuality } from '../../store/viewQualityStore';
import { callLlm, type LlmImage } from '../../utils/llmCall';
import { drawableToLlmImage, llmImageUrl } from '../../utils/llmImageInput';
import { decodeImageUrl } from '../../utils/decodeImage';
import { mergeAndNormalizeNodes, type RawNode } from '../../utils/sceneNodes';
import { collectSceneTriangles } from '../../utils/contourSliceExporter';
import { segmentPicture, segmentationMask } from '../../utils/profileImport';
import { normalizeMask, usablePhotoMask, viewDirection, type Mask, type View } from '../../utils/silhouette';
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

const frames = (n: number) => new Promise<void>((resolve) => {
  const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(n);
});

/** The first photo's outline, normalised, if it has one worth scoring against. */
async function photoOutline(photo: LlmImage): Promise<Mask | null> {
  try {
    const img = await decodeImageUrl(llmImageUrl(photo), 480);
    const mask = segmentationMask(segmentPicture(img.data, img.width, img.height));
    return usablePhotoMask(mask, img.width, img.height) ? normalizeMask(mask, img.width, img.height) : null;
  } catch {
    return null;
  }
}

/** The viewport looking at the part from `view`, edges off, as a picture. */
async function renderFrom(view: View): Promise<LlmImage | null> {
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
  const d = viewDirection(view);
  const dist = diag * 1.8;
  const store = useStore.getState();
  const edgesWere = store.showEdges;
  const wireWas = store.wireframe;
  const collidersWere = useViewQuality.getState().showColliders;
  if (edgesWere) store.toggleShowEdges();
  if (wireWas) store.toggleWireframe();
  if (collidersWere) useViewQuality.getState().setShowColliders(false);
  store.setCameraOverride({ position: [centre[0] + d[0] * dist, centre[1] + d[1] * dist, centre[2] + d[2] * dist], target: centre });
  await frames(3);
  const canvas = renderViewportNow();
  const image = canvas && canvas.width ? drawableToLlmImage(canvas, canvas.width, canvas.height, 1024) : null;
  const s = useStore.getState();
  if (edgesWere && !s.showEdges) s.toggleShowEdges();
  if (wireWas && !s.wireframe) s.toggleWireframe();
  if (collidersWere) useViewQuality.getState().setShowColliders(true);
  return image;
}

export function usePictureToPart(sceneSystem: string) {
  const [progress, setProgress] = useState<LoopProgress | null>(null);
  const abort = useRef<AbortController | null>(null);

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
          if (!sizeMm(collectSceneTriangles(useStore.getState().sceneGraph).tris)) {
            return { ok: false, error: 'It built nothing solid: check the SCAD compiles to a closed shape.' };
          }
          return { ok: true };
        },
        partNodes: () => lean(useStore.getState().sceneGraph.nodes) as RawNode[],
        partTriangles: () => collectSceneTriangles(useStore.getState().sceneGraph).tris,
        render: renderFrom,
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
