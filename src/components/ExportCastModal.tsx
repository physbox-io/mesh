import React, { useState } from 'react';
import { Droplet } from 'lucide-react';
import type { SceneNode } from '../types/scene';
import { useStore } from '../store/useStore';
import { useCastDialog } from '../store/castDialogStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { pourBoxIn, pourSelection } from '../utils/pourTarget';
import { selectedIds } from '../utils/moldSubject';
import { DEFAULT_TAB_MATERIAL } from '../utils/moldTabs';
import { castMaterial, type CastMaterialId } from '../utils/castMaterials';
import { CastDialogFrame, PanelBody } from './cast/CastDialogFrame';
import { PourPanel } from './cast/PourPanel';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Closes this and opens the Mold dialog on the same selection. */
  onOpenMold: () => void;
}

/**
 * The Cast button: pour into what is selected. A mold made in Mesh, one made
 * elsewhere and imported, or a master standing in its pour box — Mold makes
 * molds, Cast pours into them.
 */
export const ExportCastModal: React.FC<Props> = (props) => (props.isOpen ? <OpenCastModal {...props} /> : null);

/** Mounted each time the dialog opens, so the selection is read afresh. */
const OpenCastModal: React.FC<Props> = ({ onClose, onOpenMold }) => {
  useEscapeToClose(true, onClose);
  // Only the bodies touching the one clicked: the rest hold nothing with it.
  const [pour] = useState<{ node: SceneNode; apart: SceneNode[] } | null>(() => {
    const ids = selectedIds(useStore.getState());
    return ids.length > 0 ? pourSelection(useStore.getState().sceneGraph.nodes, ids) : null;
  });
  // A master in its pour box takes the silicone the box was planned for, and
  // that pick is not remembered: the next pour, into the silicone, is not silicone.
  const { materialByTab, rememberMaterial } = useCastDialog();
  const [boxSilicone] = useState(() => (pour ? pourBoxIn(pour.node)?.silicone ?? null : null));
  const [picked, setPicked] = useState<CastMaterialId | null>(null);
  const remembered = materialByTab.pour;
  // Never silicone by default: the pour box's own silicone is the only time it is the answer.
  const fallback = remembered && !castMaterial(remembered).silicone ? remembered : DEFAULT_TAB_MATERIAL.rigid;
  const material: CastMaterialId = picked ?? boxSilicone ?? fallback;
  const onMaterial = (id: CastMaterialId) => {
    setPicked(id);
    if (!boxSilicone) rememberMaterial('pour', id);
  };

  return (
    <CastDialogFrame
      icon={<Droplet className="w-5 h-5" />}
      iconClass="bg-gradient-to-br from-amber-500 to-orange-600"
      title="Cast"
      subtitle={pour ? <span title={pour.node.name}>Pouring into: {pour.node.name}</span> : 'Pour into a mold'}
      onClose={onClose}
      width="max-w-md"
    >
      {pour ? (
        <PourPanel
          moldNode={pour.node}
          apart={pour.apart}
          material={material}
          onMaterial={onMaterial}
          onClose={onClose}
          onMakeMold={onOpenMold}
        />
      ) : (
        <PanelBody>
          <p className="text-slate-600 dark:text-slate-300">
            Select the mold to pour into: a mold, or a master with its pour box (master, base and sleeve). To make a mold, use Mold.
          </p>
        </PanelBody>
      )}
    </CastDialogFrame>
  );
};
