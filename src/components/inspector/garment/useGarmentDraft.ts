import { useStore } from '../../../store/useStore';
import type { SceneNode } from '../../../types/scene';
import type { ClothSpec, GarmentDraft } from '../../../types/cloth';
import type { ModelMirror } from '../../../types/sceneLayer';

/** How a garment card writes its node: the whole draft, or the whole cloth, each one edit (one undo step). */
export function useGarmentWriters(node: SceneNode) {
  const updateNode = useStore((s) => s.updateNode);
  const setCloth = (c: ClothSpec, settle = false) => updateNode(node.id, { cloth: c } as Partial<SceneNode>, false, settle);
  const setDraft = (d: GarmentDraft, settle = false) => { if (node.cloth) setCloth({ ...node.cloth, garment: d }, settle); };
  return { setCloth, setDraft };
}

/** Its pieces as last built, by name (`<body>__<piece>` in the model's flexes). */
export function useClothPieces(node: SceneNode) {
  const flexes = (useStore((s) => s.model) as ModelMirror | null)?.flexes;
  const name = node.name || node.id;
  return (flexes ?? []).filter((f) => f.name.slice(0, f.name.lastIndexOf('__')) === name)
    .map((f) => ({ ...f, piece: f.name.slice(f.name.lastIndexOf('__') + 2) }));
}
