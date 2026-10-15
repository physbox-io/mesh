import { useState, type RefObject } from 'react';
import type * as THREE from 'three';
import { useStore } from '../store/useStore';
import { usePanels } from '../store/panelsStore';
import type { NoteCard } from '../utils/noteCards';
import { useMeshExport } from '../hooks/useMeshExport';
import { ExportLaserCutModal } from './ExportLaserCutModal';
import { ExportContourSliceModal } from './ExportContourSliceModal';
import { ExportReliefCarveModal } from './ExportReliefCarveModal';
import { ExportMoldModal } from './ExportMoldModal';
import { ExportSolidMachiningModal } from './ExportSolidMachiningModal';
import { ExportCastModal } from './ExportCastModal';
import { SplitForPrintModal } from './SplitForPrintModal';
import { BottomStatusBar } from './BottomStatusBar';
import { MachineConfigModal } from './MachineConfigModal';

/**
 * The bottom bar and everything it opens: the fabrication exports, Split for
 * Print and the machine setup. STL and 3MF are written from the viewport's
 * three.js scene, hence `threeSceneRef`; `noteCards` name the files.
 */
export function FabricationModals({ threeSceneRef, noteCards }: {
  threeSceneRef: RefObject<THREE.Scene | null>;
  noteCards: NoteCard[];
}) {
  const sceneGraph = useStore((s) => s.sceneGraph);
  // The machine setup lives in the store rather than in local state: the bottom
  // bar opens it, and the export modals link to it when a job needs a machine
  // that is not connected yet.
  const isMachineConfigOpen = useStore((s) => s.isMachineConfigOpen);
  const setMachineConfigOpen = useStore((s) => s.setMachineConfigOpen);
  const machineTarget = useStore((s) => s.machineTarget);
  const openDocs = usePanels((s) => s.openDocs);
  const [isLaserCutModalOpen, setIsLaserCutModalOpen] = useState(false);
  const [isContourSliceModalOpen, setIsContourSliceModalOpen] = useState(false);
  const [isReliefCarveModalOpen, setIsReliefCarveModalOpen] = useState(false);
  const [isMoldModalOpen, setIsMoldModalOpen] = useState(false);
  const [isSolidModalOpen, setIsSolidModalOpen] = useState(false);
  const [isCastModalOpen, setIsCastModalOpen] = useState(false);
  const [isSplitModalOpen, setIsSplitModalOpen] = useState(false);
  const { exportStl, export3mf } = useMeshExport(threeSceneRef, noteCards);
  return (
    <>
      {/* The zeroing walkthrough is deep-linked from the shared Machine Setup
          dialog now, rather than from a copy of the machine panel in each of
          these — see MachineConfigModal below. */}
      <ExportLaserCutModal
        isOpen={isLaserCutModalOpen}
        onClose={() => setIsLaserCutModalOpen(false)}
        scene={sceneGraph}
      />

      <ExportContourSliceModal
        isOpen={isContourSliceModalOpen}
        onClose={() => setIsContourSliceModalOpen(false)}
        scene={sceneGraph}
      />

      <ExportReliefCarveModal
        isOpen={isReliefCarveModalOpen}
        onClose={() => setIsReliefCarveModalOpen(false)}
        scene={sceneGraph}
      />

      <ExportMoldModal
        isOpen={isMoldModalOpen}
        onClose={() => setIsMoldModalOpen(false)}
        scene={sceneGraph}
      />
      <ExportSolidMachiningModal
        isOpen={isSolidModalOpen}
        onClose={() => setIsSolidModalOpen(false)}
        scene={sceneGraph}
      />
      <ExportCastModal
        isOpen={isCastModalOpen}
        onClose={() => setIsCastModalOpen(false)}
        scene={sceneGraph}
      />
      <SplitForPrintModal
        isOpen={isSplitModalOpen}
        onClose={() => setIsSplitModalOpen(false)}
      />

      <BottomStatusBar
        onOpenMachineConfig={() => setMachineConfigOpen(true)}
        exports={{
          stl: exportStl,
          threeMf: export3mf,
          mold: () => setIsMoldModalOpen(true),
          unwrap: () => setIsLaserCutModalOpen(true),
          contourSlices: () => setIsContourSliceModalOpen(true),
          reliefCarve: () => setIsReliefCarveModalOpen(true),
          solid: () => setIsSolidModalOpen(true),
          cast: () => setIsCastModalOpen(true),
          split: () => setIsSplitModalOpen(true),
        }}
      />

      <MachineConfigModal
        isOpen={isMachineConfigOpen}
        onClose={() => setMachineConfigOpen(false)}
        onOpenDocs={() => openDocs('zeroing')}
        machineTarget={machineTarget}
      />
    </>
  );
}
