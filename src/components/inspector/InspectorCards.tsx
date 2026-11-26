import type { RefObject } from 'react';
import type * as THREE from 'three';
import type { SceneNode } from '../../types/scene';
import { useStore } from '../../store/useStore';
import { usePanels, type InspectorTab } from '../../store/panelsStore';
import { CavityCard } from '../CavityCard';
import { EdgesCard } from '../EdgesCard';
import { FacePatternEditor } from '../FacePatternEditor';
import { SurfacePatternsCard } from '../SurfacePatternsCard';
import { AerodynamicsCard, BodyBasicsCard } from './BodyBasicsCard';
import { AcousticTuningCard } from './AcousticTuningCard';
import { BalanceCard } from './BalanceCard';
import { ContainerWaterCard } from './ContainerWaterCard';
import { FlexureCard } from './FlexureCard';
import { MoldCard } from './MoldCard';
import { GarmentCard } from './GarmentCard';
import { ClothCard } from './ClothCard';
import { CompositeCard } from './CompositeCard';
import { GarmentDraftCard } from './GarmentDraftCard';
import { BodyFormCard } from './BodyFormCard';
import { GeomListingCard } from './GeomListingCard';
import { CollisionCard } from './CollisionCard';
import { CombineCard } from './CombineCard';
import { ConstraintsCard } from './ConstraintsCard';
import { CsgCard } from './CsgCard';
import { DeformationCard } from './DeformationCard';
import { JoinCard } from './JoinCard';
import { PartActions } from './ExportStlCard';
import { GearCard } from './GearCard';
import { HardwarePartCard } from './HardwarePartCard';
import { GeomPropertiesCard, SubGeomSelector } from './GeomPropertiesCard';
import { JointSettingsCard } from './JointSettingsCard';
import { JointTypeCard } from './JointTypeCard';
import { MeshGeomsCard } from './MeshGeomsCard';
import { ModellingTools } from './ModellingTools';
import { MotorCard } from './MotorCard';
import { PositionCard } from './PositionCard';
import { PulleyWheelCard } from './PulleyWheelCard';
import { ResizeCard } from './ResizeCard';
import { RopeCard } from './RopeCard';
import { ScadEditorCard } from './ScadEditorCard';
import { ScriptEditorCard } from './ScriptEditorCard';
import { TextureTabIntro } from './TextureTabIntro';

const TABS: { id: InspectorTab; label: string }[] = [
  { id: 'main', label: 'Main' },
  { id: 'shape', label: 'Shape' },
  { id: 'texture', label: 'Texture' },
  { id: 'physics', label: 'Physics' },
  { id: 'script', label: 'Script' },
];

/**
 * Every inspector card for the selected body, sorted into tabs: Main for what
 * nearly every part needs (name, place, size, colour, STL), then the modelling,
 * surface, simulation and scripting cards each in a tab of their own. Each
 * card still decides for itself whether it applies.
 */
export function InspectorCards({ node, threeSceneRef }: { node: SceneNode; threeSceneRef: RefObject<THREE.Scene | null> }) {
  const tab = usePanels((s) => s.inspectorTab);
  const setTab = usePanels((s) => s.setInspectorTab);
  const patterning = useStore((s) => s.facePatternTarget?.nodeId === node.id);

  // Cloth bodies are simulated by the XPBD solver rather than MuJoCo rigid
  // bodies, so rigid-body Shape/Texture/Physics/Script tabs do not apply;
  // fitted garments also follow their form's pose rather than `node.pos`.
  if (node.cloth) {
    return (
      <>
        <CombineCard node={node} />
        <BodyBasicsCard node={node} />
        <PartActions node={node} threeSceneRef={threeSceneRef} />
        <GarmentDraftCard node={node} />
        <ClothCard node={node} />
        <GarmentCard node={node} />
        {!node.cloth.garment?.fitTo && <PositionCard node={node} />}
      </>
    );
  }

  return (
    <>
      {/* Above the tabs: it acts on the whole selection, not this body. */}
      <CombineCard node={node} />

      <div role="tablist" className="flex gap-0.5 p-0.5 bg-slate-100 dark:bg-slate-800 rounded-lg">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              // Leaving Texture puts the pattern editor away. What was applied
              // stays on the part; a change not yet applied goes with it.
              if (t.id !== 'texture') useStore.getState().closeFacePattern();
              setTab(t.id);
            }}
            className={`flex-1 px-1 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
              tab === t.id
                ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm'
                : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'main' && (
        <>
          <BodyBasicsCard node={node} />
          <PartActions node={node} threeSceneRef={threeSceneRef} />
          <MoldCard node={node} />
          <BodyFormCard node={node} />
          <GarmentDraftCard node={node} />
          <ClothCard node={node} />
          <CompositeCard node={node} />
          <GarmentCard node={node} />
          <JoinCard node={node} />
          <HardwarePartCard node={node} />
          <PositionCard node={node} />
          <SubGeomSelector node={node} />
          <GeomListingCard node={node} />
          <ResizeCard node={node} />
          <GeomPropertiesCard node={node} part="main" />
        </>
      )}

      {tab === 'shape' && (
        <>
          <ModellingTools node={node} />
          <GeomPropertiesCard node={node} part="shape" />
          <EdgesCard node={node} />
          <CsgCard node={node} />
          <MeshGeomsCard node={node} />
          <ScadEditorCard node={node} />
          {/* The air inside a watertight body, for a speaker box in Volt. */}
          <CavityCard node={node} />
          <AcousticTuningCard node={node} />
        </>
      )}

      {tab === 'texture' && (
        <>
          {patterning ? <FacePatternEditor /> : <TextureTabIntro node={node} />}
          <SurfacePatternsCard node={node} />
        </>
      )}

      {tab === 'physics' && (
        <>
          <AerodynamicsCard node={node} />
          <GeomPropertiesCard node={node} part="physics" />
          <JointTypeCard node={node} />
          <FlexureCard node={node} />
          <MotorCard node={node} />
          <GearCard node={node} />
          <JointSettingsCard node={node} />
          <ConstraintsCard node={node} />
          <DeformationCard node={node} />
          <CollisionCard node={node} />
          <PulleyWheelCard node={node} />
          <RopeCard node={node} />
          <ContainerWaterCard node={node} />
          <BalanceCard node={node} />
        </>
      )}

      {tab === 'script' && <ScriptEditorCard node={node} />}
    </>
  );
}
