import { useStore } from '../store/useStore';
import { sceneContentBounds } from './frameScene';
import { normalizeReferencePicture, upsertReferenceImage } from './referenceImages';
import type { SceneNode } from '../types/scene';

/** The selected body if it is a top-level one (a child's bounds are in its parent's frame), else everything. */
function selectedOrAll(nodes: SceneNode[], selectedId: string | null): SceneNode[] {
  const picked = selectedId ? nodes.find((n) => n.id === selectedId) : undefined;
  return picked ? [picked] : nodes;
}

/**
 * Pins a picture file into the scene as a reference image, in the front view,
 * at the scale of the selected body, or with nothing selected of everything in
 * the scene. One undo step. Returns its id.
 */
export async function addReferencePicture(file: File): Promise<string> {
  const { src, aspect } = await normalizeReferencePicture(file);
  const store = useStore.getState();
  const { images, image } = upsertReferenceImage(
    store.sceneGraph.referenceImages,
    undefined,
    { src, aspect, name: file.name.replace(/\.[^.]+$/, '') || 'Reference' },
    sceneContentBounds(selectedOrAll(store.sceneGraph.nodes, store.selectedNodeId)),
  );
  store.setReferenceImages(images);
  return image.id;
}
