import type { SceneNode } from '../../../types/scene';
import { garmentSettings } from '../../../utils/cloth/garments';
import { GarmentDetails } from '../GarmentDetails';
import { GarmentSculptPanel } from '../GarmentSculptPanel';
import { GarmentCurvesPanel } from '../GarmentCurvesPanel';
import { GarmentDartsPanel } from './GarmentDartsPanel';
import { GarmentFullnessPanel } from './GarmentFullnessPanel';
import { cardCls } from './garmentStyle';
import { useGarmentWriters } from './useGarmentDraft';

/** A garment's Shape tab: its edges, collar and lapels, darts, gathers and pleats, pockets and belt, sculpt and drawn lines. */
export function GarmentShapeCard({ node }: { node: SceneNode }) {
  const { setDraft } = useGarmentWriters(node);
  const draft = node.cloth?.garment;
  if (!draft) return null;
  const s = garmentSettings(draft);
  return (
    <div className={cardCls}>
      <GarmentDetails draft={draft} s={s} setDraft={setDraft} />
      {!s.over && <GarmentDartsPanel draft={draft} setDraft={setDraft} />}
      <GarmentFullnessPanel draft={draft} setDraft={setDraft} />
      <GarmentSculptPanel nodeId={node.id} draft={draft} setDraft={setDraft} />
      <GarmentCurvesPanel nodeId={node.id} draft={draft} setDraft={setDraft} />
    </div>
  );
}
