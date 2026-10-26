import { useEffect, useState, type RefObject } from 'react';
import type * as THREE from 'three';
import { useStore } from '../store/useStore';
import { usePanels } from '../store/panelsStore';
import type { NoteCard } from '../utils/noteCards';
import { useMeshExport } from '../hooks/useMeshExport';
import { webSerialManager } from '../utils/webSerialManager';
import { ExportLaserCutModal } from './ExportLaserCutModal';
import { ExportContourSliceModal } from './ExportContourSliceModal';
import { ExportReliefCarveModal } from './ExportReliefCarveModal';
import { ExportMoldModal } from './ExportMoldModal';
import { ExportSolidMachiningModal } from './ExportSolidMachiningModal';
import type { SolidMachiningOptions } from '../utils/solidMachiningExporter';
import { ExportCastModal } from './ExportCastModal';
import { SplitForPrintModal } from './SplitForPrintModal';
import { TimberBreakdownModal } from './TimberBreakdownModal';
import { ExportSheetUnfoldModal } from './ExportSheetUnfoldModal';
import { ImportPcbModal } from './ImportPcbModal';
import { MechanismBuilderModal } from './MechanismBuilderModal';
import { ExportTubeAndWireModal } from './ExportTubeAndWireModal';
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
  // What the relief dialog hands solid machining when a model has an undercut.
  const [solidSeed, setSolidSeed] = useState<Partial<SolidMachiningOptions> | null>(null);
  const [isCastModalOpen, setIsCastModalOpen] = useState(false);
  const [isSplitModalOpen, setIsSplitModalOpen] = useState(false);
  const [isJoineryModalOpen, setIsJoineryModalOpen] = useState(false);
  const [isSheetUnfoldModalOpen, setIsSheetUnfoldModalOpen] = useState(false);
  const [isPcbModalOpen, setIsPcbModalOpen] = useState(false);
  const [isMechanismModalOpen, setIsMechanismModalOpen] = useState(false);
  const [isTubeAndWireModalOpen, setIsTubeAndWireModalOpen] = useState(false);

  // Subscribe to sceneGraph only while a scene-consuming export modal is open,
  // so editing the scene does not re-render the bottom bar or closed modals.
  const anySceneModalOpen =
    isLaserCutModalOpen ||
    isContourSliceModalOpen ||
    isReliefCarveModalOpen ||
    isMoldModalOpen ||
    isSolidModalOpen ||
    isCastModalOpen ||
    isSheetUnfoldModalOpen ||
    isTubeAndWireModalOpen;
  const sceneGraph = useStore((s) => (anySceneModalOpen ? s.sceneGraph : null));

  // Resume a previously connected USB or cloud machine once on app startup
  // even while MachineConfigModal is not mounted.
  useEffect(() => {
    if (webSerialManager.getState().connected) return;
    const link = localStorage.getItem('physbox.machineLink') || 'usb';
    if (link !== 'cloud') {
      void webSerialManager.autoConnect().catch(() => {});
      return;
    }
    const selectedDevice = localStorage.getItem('physbox.cloudDeviceId') || '';
    if (!selectedDevice) return;
    void webSerialManager.connect({ kind: 'cloud', deviceId: selectedDevice }).catch(() => {});
  }, []);

  const { exportStl, export3mf } = useMeshExport(threeSceneRef, noteCards);
  return (
    <>
      {/* Mounted only while open so closed modals do not run hooks, worker
          settle timers, or scene tree walks on every edit. */}
      {isLaserCutModalOpen && sceneGraph && (
        <ExportLaserCutModal
          isOpen={isLaserCutModalOpen}
          onClose={() => setIsLaserCutModalOpen(false)}
          scene={sceneGraph}
        />
      )}

      {isContourSliceModalOpen && sceneGraph && (
        <ExportContourSliceModal
          isOpen={isContourSliceModalOpen}
          onClose={() => setIsContourSliceModalOpen(false)}
          scene={sceneGraph}
        />
      )}

      {isReliefCarveModalOpen && sceneGraph && (
        <ExportReliefCarveModal
          isOpen={isReliefCarveModalOpen}
          onClose={() => setIsReliefCarveModalOpen(false)}
          scene={sceneGraph}
          onMachineAsPart={(seed) => {
            setIsReliefCarveModalOpen(false);
            setSolidSeed(seed);
            setIsSolidModalOpen(true);
          }}
        />
      )}

      {isMoldModalOpen && sceneGraph && (
        <ExportMoldModal
          isOpen={isMoldModalOpen}
          onClose={() => setIsMoldModalOpen(false)}
          scene={sceneGraph}
        />
      )}

      {isSolidModalOpen && sceneGraph && (
        <ExportSolidMachiningModal
          isOpen={isSolidModalOpen}
          onClose={() => {
            setIsSolidModalOpen(false);
            setSolidSeed(null);
          }}
          scene={sceneGraph}
          seed={solidSeed}
        />
      )}

      {isCastModalOpen && sceneGraph && (
        <ExportCastModal
          isOpen={isCastModalOpen}
          onClose={() => setIsCastModalOpen(false)}
          scene={sceneGraph}
        />
      )}

      {isSplitModalOpen && (
        <SplitForPrintModal
          isOpen={isSplitModalOpen}
          onClose={() => setIsSplitModalOpen(false)}
        />
      )}

      {isJoineryModalOpen && (
        <TimberBreakdownModal
          isOpen={isJoineryModalOpen}
          onClose={() => setIsJoineryModalOpen(false)}
        />
      )}

      {isSheetUnfoldModalOpen && sceneGraph && (
        <ExportSheetUnfoldModal
          isOpen={isSheetUnfoldModalOpen}
          onClose={() => setIsSheetUnfoldModalOpen(false)}
          scene={sceneGraph}
        />
      )}

      {isPcbModalOpen && (
        <ImportPcbModal
          isOpen={isPcbModalOpen}
          onClose={() => setIsPcbModalOpen(false)}
        />
      )}

      {isMechanismModalOpen && (
        <MechanismBuilderModal
          isOpen={isMechanismModalOpen}
          onClose={() => setIsMechanismModalOpen(false)}
        />
      )}

      {isTubeAndWireModalOpen && sceneGraph && (
        <ExportTubeAndWireModal
          isOpen={isTubeAndWireModalOpen}
          onClose={() => setIsTubeAndWireModalOpen(false)}
          scene={sceneGraph}
        />
      )}

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
          joinery: () => setIsJoineryModalOpen(true),
          unfold: () => setIsSheetUnfoldModalOpen(true),
          pcb: () => setIsPcbModalOpen(true),
          mechanisms: () => setIsMechanismModalOpen(true),
          pipes: () => setIsTubeAndWireModalOpen(true),
        }}
      />

      {isMachineConfigOpen && (
        <MachineConfigModal
          isOpen={isMachineConfigOpen}
          onClose={() => setMachineConfigOpen(false)}
          onOpenDocs={() => openDocs('zeroing')}
          machineTarget={machineTarget}
        />
      )}
    </>
  );
}
