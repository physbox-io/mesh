import type { SceneNode } from '../../../types/scene';
import { ClothArrangePanel } from '../ClothArrangePanel';
import { ClothFastenPanel } from './ClothFastenPanel';
import { cardCls } from './garmentStyle';
import { useClothPieces, useGarmentWriters } from './useGarmentDraft';

/** A cloth's Physics tab: how it is arranged as it starts, and the points of it held together. */
export function ClothPhysicsCard({ node }: { node: SceneNode }) {
  const { setCloth } = useGarmentWriters(node);
  const pieces = useClothPieces(node).map((p) => p.piece);
  const cloth = node.cloth;
  if (!cloth) return null;
  return (
    <div className={cardCls}>
      <ClothArrangePanel nodeId={node.id} cloth={cloth} setCloth={setCloth} />
      <ClothFastenPanel cloth={cloth} pieces={pieces} setCloth={setCloth} />
    </div>
  );
}
