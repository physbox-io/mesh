import { useEffect, useMemo, useState, type RefObject } from 'react';
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
import { ExportTubeAndWireModal } from './ExportTubeAndWireModal';
import { BrickworkModal } from './BrickworkModal';
import { BottomStatusBar } from './BottomStatusBar';
import { MachineConfigModal } from './MachineConfigModal';
import { moldSubject, selectedIds } from '../utils/moldSubject';
import { openSceneInEtch } from '../utils/etchSceneHandoff';

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
  const [isTubeAndWireModalOpen, setIsTubeAndWireModalOpen] = useState(false);
  const [isBrickModalOpen, setIsBrickModalOpen] = useState(false);

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
  // What every export works on, as the Mold dialog molds: the selection when
  // the dialog opened, else every body. Read once on opening, since adding a
  // simulation selects it.
  const [subjectIds, setSubjectIds] = useState<string[]>([]);
  const opening = (open: (v: boolean) => void) => () => {
    setSubjectIds(selectedIds(useStore.getState()));
    open(true);
  };
  const subject = useMemo(() => (sceneGraph ? moldSubject(sceneGraph, subjectIds) : null), [sceneGraph, subjectIds]);
  const subjectScene = subject?.scene ?? null;

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

  // Etch, in one click: the selection (or every body) laid flat for the
  // bench's machine, out of the bench's stock (utils/etchSceneHandoff.ts).
  const [etchBusy, setEtchBusy] = useState(false);
  const [etchError, setEtchError] = useState<string | null>(null);
  useEffect(() => {
    if (!etchError) return;
    const t = setTimeout(() => setEtchError(null), 10000);
    return () => clearTimeout(t);
  }, [etchError]);
  const sendToEtch = () => {
    const state = useStore.getState();
    const subject = moldSubject(state.sceneGraph, selectedIds(state));
    if (!subject.ids.length) {
      setEtchError('Nothing to send: the scene has no parts.');
      return;
    }
    setEtchBusy(true);
    setEtchError(null);
    openSceneInEtch({
      scene: subject.scene,
      name: subject.label,
      machine: state.machineTarget === 'laser' ? 'laser' : 'cnc',
      stock: state.stock,
    })
      .catch((e: Error) => setEtchError(e.message))
      .finally(() => setEtchBusy(false));
  };
  return (
    <>
      {/* Mounted only while open so closed modals do not run hooks, worker
          settle timers, or scene tree walks on every edit. */}
      {isLaserCutModalOpen && subjectScene && (
        <ExportLaserCutModal
          isOpen={isLaserCutModalOpen}
          onClose={() => setIsLaserCutModalOpen(false)}
          scene={subjectScene!}
          subjectLabel={subject!.label}
        />
      )}

      {isContourSliceModalOpen && subjectScene && (
        <ExportContourSliceModal
          isOpen={isContourSliceModalOpen}
          onClose={() => setIsContourSliceModalOpen(false)}
          scene={subjectScene!}
          subjectLabel={subject!.label}
        />
      )}

      {isReliefCarveModalOpen && subjectScene && (
        <ExportReliefCarveModal
          isOpen={isReliefCarveModalOpen}
          onClose={() => setIsReliefCarveModalOpen(false)}
          scene={subjectScene!}
          subjectLabel={subject!.label}
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

      {isSolidModalOpen && subjectScene && (
        <ExportSolidMachiningModal
          isOpen={isSolidModalOpen}
          onClose={() => {
            setIsSolidModalOpen(false);
            setSolidSeed(null);
          }}
          scene={subjectScene!}
          subjectLabel={subject!.label}
          seed={solidSeed}
        />
      )}

      {isCastModalOpen && sceneGraph && (
        <ExportCastModal
          isOpen={isCastModalOpen}
          onClose={() => setIsCastModalOpen(false)}
          onOpenMold={() => {
            setIsCastModalOpen(false);
            setIsMoldModalOpen(true);
          }}
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

      {isSheetUnfoldModalOpen && subjectScene && (
        <ExportSheetUnfoldModal
          isOpen={isSheetUnfoldModalOpen}
          onClose={() => setIsSheetUnfoldModalOpen(false)}
          scene={subjectScene!}
          subjectLabel={subject!.label}
        />
      )}

      {isTubeAndWireModalOpen && subjectScene && (
        <ExportTubeAndWireModal
          isOpen={isTubeAndWireModalOpen}
          onClose={() => setIsTubeAndWireModalOpen(false)}
          scene={subjectScene!}
          subjectLabel={subject!.label}
        />
      )}

      {isBrickModalOpen && (
        <BrickworkModal isOpen={isBrickModalOpen} onClose={() => setIsBrickModalOpen(false)} />
      )}

      <BottomStatusBar
        onOpenMachineConfig={() => setMachineConfigOpen(true)}
        exports={{
          stl: exportStl,
          threeMf: export3mf,
          mold: () => setIsMoldModalOpen(true),
          unwrap: opening(setIsLaserCutModalOpen),
          contourSlices: opening(setIsContourSliceModalOpen),
          reliefCarve: opening(setIsReliefCarveModalOpen),
          solid: opening(setIsSolidModalOpen),
          cast: () => setIsCastModalOpen(true),
          split: () => setIsSplitModalOpen(true),
          joinery: () => setIsJoineryModalOpen(true),
          unfold: opening(setIsSheetUnfoldModalOpen),
          pipes: opening(setIsTubeAndWireModalOpen),
          brick: () => setIsBrickModalOpen(true),
          etch: { run: sendToEtch, busy: etchBusy, error: etchError },
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
