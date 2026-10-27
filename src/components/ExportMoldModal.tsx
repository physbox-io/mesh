import React, { useMemo, useState } from 'react';
import { Box } from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import { useStore } from '../store/useStore';
import { useCastDialog } from '../store/castDialogStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { moldSubject, selectedIds } from '../utils/moldSubject';
import { MOLD_TABS, tabDefaults, type MoldTab } from '../utils/moldTabs';
import type { CastMaterialId } from '../utils/castMaterials';
import { CastDialogFrame } from './cast/CastDialogFrame';
import { RigidMoldPanel } from './cast/RigidMoldPanel';
import { SiliconeBoxPanel } from './cast/SiliconeBoxPanel';
import { PatternPanel } from './cast/PatternPanel';

interface ExportMoldModalProps {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
}

/**
 * The Mold button: one dialog, a tab for each kind of mold. Every tab molds
 * the selected part, or the whole scene when nothing is selected. Pouring
 * into a mold that already exists is the Cast button's job.
 */
export const ExportMoldModal: React.FC<ExportMoldModalProps> = (props) =>
  props.isOpen ? <OpenMoldModal {...props} /> : null;

/** Mounted each time the dialog opens, so the selection is read afresh. */
const OpenMoldModal: React.FC<ExportMoldModalProps> = ({ onClose, scene }) => {
  useEscapeToClose(true, onClose);
  const [ids] = useState<string[]>(() => selectedIds(useStore.getState()));
  const subject = useMemo(() => moldSubject(scene, ids), [scene, ids]);
  // A preset by its name; anything else (an import, an unsaved scene) by its
  // first body, so one scene's tab is not every new scene's.
  const activePreset = useStore((s) => s.activePreset);
  const sceneKey = activePreset ? `preset:${activePreset}` : `body:${scene.nodes.find((n) => !n.simulation)?.id ?? ''}`;
  const { tabByScene, materialByTab, rememberTab, rememberMaterial } = useCastDialog();
  const bakedDraftDeg = scene.castPrep?.draftDeg ?? 0;

  // The Cast prep badge asks for the tab prep is switched off on, Advanced open.
  const [request] = useState(() => useCastDialog.getState().takeRequest());
  const [tab, setTabState] = useState<MoldTab>(() => request?.tab ?? tabDefaults({ rememberedTab: tabByScene[sceneKey] }).tab);
  // Tabs once opened stay mounted, so switching back finds them as they were.
  const [visited, setVisited] = useState<MoldTab[]>([tab]);
  const setTab = (next: MoldTab) => {
    setTabState(next);
    setVisited((v) => (v.includes(next) ? v : [...v, next]));
    rememberTab(sceneKey, next);
  };
  const materialOf = (t: MoldTab) => tabDefaults({ tab: t, rememberedMaterials: materialByTab }).material;
  const onMaterial = (t: MoldTab) => (id: CastMaterialId) => rememberMaterial(t, id);

  const tabs = (
    <div role="tablist" className="flex gap-1 px-6 pt-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 overflow-x-auto">
      {MOLD_TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={tab === t.id}
          onClick={() => setTab(t.id)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-t-lg border-b-2 -mb-px transition-colors cursor-pointer whitespace-nowrap ${
            tab === t.id
              ? 'border-purple-500 text-purple-700 dark:text-purple-300 bg-white dark:bg-slate-900'
              : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  const panel = (t: MoldTab) => {
    if (t === 'rigid') {
      return (
        <RigidMoldPanel
          scene={subject.scene}
          material={materialOf('rigid')}
          onMaterial={onMaterial('rigid')}
          bakedDraftDeg={bakedDraftDeg}
          onClose={onClose}
          onSilicone={() => setTab('silicone')}
          active={tab === 'rigid'}
        />
      );
    }
    if (t === 'silicone') {
      return (
        <SiliconeBoxPanel
          ids={subject.ids}
          name={subject.label}
          material={materialOf('silicone')}
          onMaterial={onMaterial('silicone')}
          bakedDraftDeg={bakedDraftDeg}
          active={tab === 'silicone'}
          onClose={onClose}
        />
      );
    }
    return (
      <PatternPanel
        scene={subject.scene}
        method={t}
        material={materialOf(t)}
        onMaterial={onMaterial(t)}
        bakedDraftDeg={bakedDraftDeg}
        active={tab === t}
        advancedOpen={request?.tab === t && request.advanced}
        onClose={onClose}
      />
    );
  };

  return (
    <CastDialogFrame
      icon={<Box className="w-5 h-5" />}
      iconClass="bg-gradient-to-br from-purple-500 to-indigo-600"
      title="Mold"
      subtitle={<span title={subject.label}>Molding: {subject.label}</span>}
      onClose={onClose}
      tabs={tabs}
    >
      {subject.ids.length === 0 ? (
        <div className="p-6 text-sm text-slate-500 dark:text-slate-400">
          There is nothing to mold: the scene holds only earlier simulations. Add the part first.
        </div>
      ) : (
        visited.map((t) => (
          <div key={t} role="tabpanel" hidden={t !== tab} className={t === tab ? 'flex flex-col flex-1 min-h-0' : ''}>
            {panel(t)}
          </div>
        ))
      )}
    </CastDialogFrame>
  );
};
