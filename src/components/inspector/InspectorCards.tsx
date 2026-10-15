import type { SceneNode } from '../../types/scene';
import { CavityCard } from '../CavityCard';
import { EdgesCard } from '../EdgesCard';
import { SurfacePatternsCard } from '../SurfacePatternsCard';
import { BodyBasicsCard } from './BodyBasicsCard';
import { CollisionCard } from './CollisionCard';
import { CombineCard } from './CombineCard';
import { ConstraintsCard } from './ConstraintsCard';
import { CsgCard } from './CsgCard';
import { DeformationCard } from './DeformationCard';
import { GearCard } from './GearCard';
import { GeomPropertiesCard } from './GeomPropertiesCard';
import { JointSettingsCard } from './JointSettingsCard';
import { JointTypeCard } from './JointTypeCard';
import { MeshGeomsCard } from './MeshGeomsCard';
import { ModellingTools } from './ModellingTools';
import { MotorCard } from './MotorCard';
import { PositionCard } from './PositionCard';
import { PulleyWheelCard } from './PulleyWheelCard';
import { ResizeCard } from './ResizeCard';
import { RopeCard } from './RopeCard';

/**
 * Every inspector card for the selected body, top to bottom. Each one decides
 * for itself whether it applies.
 */
export function InspectorCards({ node }: { node: SceneNode }) {
  return (
    <>
      <CombineCard node={node} />

      <ModellingTools node={node} />

      <BodyBasicsCard node={node} />

      <PositionCard node={node} />

      <ResizeCard node={node} />

      <JointTypeCard node={node} />

      <MotorCard node={node} />

      <GearCard node={node} />

      <JointSettingsCard node={node} />

      <GeomPropertiesCard node={node} />

      <ConstraintsCard node={node} />

      <DeformationCard node={node} />

      <CollisionCard node={node} />

      <EdgesCard node={node} />
      <SurfacePatternsCard node={node} />

      <CsgCard node={node} />

      {/* The air inside a watertight body, for a speaker box in Volt. */}
      <CavityCard node={node} />

      <MeshGeomsCard node={node} />

      <PulleyWheelCard node={node} />

      <RopeCard node={node} />
    </>
  );
}
