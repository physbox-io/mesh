import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type * as THREE from 'three';
import { jobPauseKind } from '@physbox-io/ui';
import { LeftSidebar } from './components/palette/LeftSidebar';
import { InspectorPanel } from './components/inspector/InspectorPanel';
import { useMuJoCoInit } from './hooks/useMuJoCo';
import { useStore } from './store/useStore';
import { setScadCompileListener } from './utils/openscad';
import { useCsgAutoCompile } from './hooks/useCsgCompile';
import { AppDialogs } from './components/AppDialogs';
import { useVoltLink } from './hooks/useVoltLink';
import { PresetSaveNotice } from './components/PresetSaveNotice';
import { UpdateNotice } from './components/UpdateNotice';
import { useEscapeToClose } from './hooks/useEscapeToClose';
import { usePanels } from './store/panelsStore';
import { useDarkMode } from './hooks/useDarkMode';
import { useSceneDocument } from './hooks/useSceneDocument';
import { usePresetActions } from './hooks/usePresetActions';
import { useShareScene } from './hooks/useShareScene';
import { useSceneIo } from './hooks/useSceneIo';
import { useEditShortcuts, useCompilerPreload } from './hooks/useAppGlobals';
import { useCardCollapse } from './hooks/useCardCollapse';
import { AppHeader } from './components/header/AppHeader';
import { SettingsPopover } from './components/header/SettingsPopover';
import { Viewport } from './components/scene/Viewport';
import { ImportModals } from './components/ImportModals';
import { FabricationModals } from './components/FabricationModals';
import { parseMeshDeepLink, stripMeshDeepLinkSearch, START_TOUR_EVENT } from './utils/deepLink';
import { webSerialManager, type MachineState } from './utils/webSerialManager';
import { restoreInterruptedJob } from './utils/jobRestore';

// Lazy-loaded panels, overlays and the MCP bridge stay out of the critical
// cold-start entry chunk and `index.html` modulepreload list.
const AICopilotPanel = lazy(() => import('./components/AICopilotPanel'));
const DocsModal = lazy(() =>
  import('./components/docs/DocsModal').then((m) => ({ default: m.DocsModal })),
);
const SceneBrowser = lazy(() =>
  import('./components/files/SceneBrowser').then((m) => ({ default: m.SceneBrowser })),
);
const ShareReportPortal = lazy(() =>
  import('./components/ShareReportPortal').then((m) => ({ default: m.ShareReportPortal })),
);
const SavePresetModal = lazy(() =>
  import('./components/SavePresetModal').then((m) => ({ default: m.SavePresetModal })),
);
const WelcomeTourOverlay = lazy(() =>
  import('./components/WelcomeTourOverlay').then((m) => ({ default: m.WelcomeTourOverlay })),
);
const JobRestoreModal = lazy(() =>
  import('./components/JobRestoreModal').then((m) => ({ default: m.JobRestoreModal })),
);
const JobSucceededModal = lazy(() =>
  import('./components/JobSucceededModal').then((m) => ({ default: m.JobSucceededModal })),
);
const JobPauseModal = lazy(() =>
  import('./components/JobPauseModal').then((m) => ({ default: m.JobPauseModal })),
);
const ToolChangeModal = lazy(() =>
  import('./components/ToolChangeModal').then((m) => ({ default: m.ToolChangeModal })),
);
const McpBridgeMount = lazy(() =>
  import('./hooks/useMCPBridge').then((m) => ({
    default: function McpBridgeMount() {
      m.useMCPBridge();
      return null;
    },
  })),
);

const TOUR_STORAGE_KEY = 'mesh_onboarding_tour_v1';

function shouldAutoOpenTour(): boolean {
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('tour') === '1' || params.get('tour') === 'true') return true;
  if (params.get('mcp') || params.get('s') || params.get('open') || params.get('modal')) return false;
  if (window.location.hash.length > 2) return false;
  try {
    return !localStorage.getItem(TOUR_STORAGE_KEY);
  } catch {
    return false;
  }
}

function TourReplayTrigger({ active, onConsumed }: { active: boolean; onConsumed: () => void }) {
  useEffect(() => {
    if (!active) return;
    onConsumed();
    window.dispatchEvent(new CustomEvent(START_TOUR_EVENT));
  }, [active, onConsumed]);
  return null;
}

/**
 * Keeps the returning-user cold start free of the tour chunk while preserving
 * both first-visit auto-open and `START_TOUR_EVENT` replay on the first click.
 */
function LazyWelcomeTour() {
  const [mounted, setMounted] = useState<boolean>(shouldAutoOpenTour);
  const [pendingReplay, setPendingReplay] = useState(false);

  useEffect(() => {
    if (mounted) return;
    const onStart = () => {
      setPendingReplay(true);
      setMounted(true);
    };
    window.addEventListener(START_TOUR_EVENT, onStart);
    return () => window.removeEventListener(START_TOUR_EVENT, onStart);
  }, [mounted]);

  if (!mounted) return null;
  return (
    <Suspense fallback={null}>
      <WelcomeTourOverlay />
      {pendingReplay && <TourReplayTrigger active onConsumed={() => setPendingReplay(false)} />}
    </Suspense>
  );
}

/**
 * Top-level machine job modals (`JobRestoreModal`, `JobSucceededModal`,
 * `JobPauseModal`, `ToolChangeModal`), lazy-loaded only when the connected
 * machine enters a state that needs them so `MachineJobControls` stays off the
 * cold-start path.
 */
function LazyJobModals() {
  const [machineState, setMachineState] = useState<MachineState>(() => webSerialManager.getState());
  useEffect(() => webSerialManager.addListener(setMachineState), []);

  // Mirrors JobRestoreModal's tab-return check even before the chunk loads.
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState === 'visible') void restoreInterruptedJob();
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    };
  }, []);

  const hasRestore = Boolean(machineState.resume?.restored && machineState.resume?.from);
  const hasSucceeded = Boolean(machineState.lastCompletedJob);
  const hasPause = Boolean(jobPauseKind(machineState.status));
  const hasToolChange = machineState.status === 'PAUSED_TOOL';

  if (!hasRestore && !hasSucceeded && !hasPause && !hasToolChange) return null;

  return (
    <Suspense fallback={null}>
      {hasRestore && <JobRestoreModal />}
      {hasSucceeded && <JobSucceededModal />}
      {hasPause && <JobPauseModal />}
      {hasToolChange && <ToolChangeModal />}
    </Suspense>
  );
}

// The status bar's "SCAD Compiling" pill counts compiles in flight. openscad.ts
// reports them through a listener rather than importing the store; see there.
setScadCompileListener((delta) => {
  const s = useStore.getState();
  if (delta > 0) s.incrementScadCompile();
  else s.decrementScadCompile();
});

function App() {
  useMuJoCoInit();
  const [darkMode, toggleDarkMode] = useDarkMode();

  const isDocsOpen = usePanels((s) => s.isDocsOpen);
  const docsTab = usePanels((s) => s.docsTab);
  const setDocsTab = usePanels((s) => s.setDocsTab);
  const closeDocs = usePanels((s) => s.closeDocs);
  useEscapeToClose(isDocsOpen, closeDocs);
  const isCopilotOpen = usePanels((s) => s.isCopilotOpen);
  const setCopilotOpen = usePanels((s) => s.setCopilotOpen);
  const isSceneBrowserOpen = usePanels((s) => s.sceneBrowser !== null);
  const [mountMcpBridge, setMountMcpBridge] = useState(false);

  const doc = useSceneDocument();
  const { noteCards, setNoteCards, copilotMessages, setCopilotMessages, setEditingCardId, hasUnsavedWork } = doc;

  useCompilerPreload();
  useEditShortcuts();
  useCardCollapse();

  useEffect(() => {
    // Load the MCP bridge chunk after initial render so its command modules
    // and fabrication exporters stay off the cold-start critical path.
    const timer = setTimeout(() => setMountMcpBridge(true), 0);
    return () => clearTimeout(timer);
  }, []);

  const presets = usePresetActions(doc);
  const shareState = useShareScene(noteCards, presets.loadUserPresetWithCard);
  const { exportJson, importSceneJson, importJson } = useSceneIo(doc);

  // Apply deep-link URL query parameters once on initial mount (`?preset=...&machine=...&open=...`).
  useEffect(() => {
    const link = parseMeshDeepLink(window.location.search);
    if (!link) return;
    if (link.preset) presets.loadPresetWithCard(link.preset);
    if (link.machine) useStore.getState().setMachineTarget(link.machine);
    if (link.run && !useStore.getState().isPlaying) useStore.getState().togglePlay();
    if (link.tour) window.dispatchEvent(new CustomEvent(START_TOUR_EVENT));
    if (link.open) {
      const openModal = link.open;
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('physbox:open-fab', {
            detail: { modal: openModal, moldTab: link.moldTab, unfoldMode: link.unfoldMode },
          })
        );
      }, 80);
    }
    window.history.replaceState(null, '', stripMeshDeepLinkSearch(window.location.href));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The three.js scene, captured inside the canvas; the STL and 3MF exports read it.
  const threeSceneRef = useRef<THREE.Scene | null>(null);

  useVoltLink();
  // Regenerates a boolean body's mesh whenever its primitives change.
  useCsgAutoCompile();

  const hasShareReport = Boolean(shareState.share || shareState.shareError || shareState.shareTooBig);

  return (
    /*
      `h-dvh`, not `h-screen`: on a phone `100vh` is the viewport with the URL
      bar hidden, so the foot of the app sat underneath the browser chrome and
      could not be reached. On a desktop the two are the same number.
    */
    <div className={`flex flex-col h-dvh w-screen transition-colors duration-200 ${darkMode ? 'dark bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans`}>
      <AppHeader
        presets={presets}
        onExportJson={exportJson}
        onImportJson={importJson}
        onShare={shareState.handleShare}
        darkMode={darkMode}
        onToggleDarkMode={toggleDarkMode}
      />

      <div className="flex flex-1 overflow-hidden relative">
        <SettingsPopover />

        <LeftSidebar
          onAddNoteCard={() => {
            const id = `card_${Date.now()}`;
            setNoteCards((prev) => [
              ...prev,
              { id, markdown: '# Note\n\nWrite your notes here.', minimized: false, x: 80, y: 80 },
            ]);
            setEditingCardId(id);
          }}
        />

        <Viewport threeSceneRef={threeSceneRef} darkMode={darkMode} doc={doc} onImportSceneJson={importSceneJson} />

        <InspectorPanel threeSceneRef={threeSceneRef} />

        {isCopilotOpen && (
          <Suspense fallback={null}>
            <AICopilotPanel
              onClose={() => setCopilotOpen(false)}
              messages={copilotMessages}
              setMessages={setCopilotMessages}
            />
          </Suspense>
        )}
      </div>

      {isDocsOpen && (
        <Suspense fallback={null}>
          <DocsModal tab={docsTab} onTab={setDocsTab} onClose={closeDocs} />
        </Suspense>
      )}

      {hasShareReport && (
        <Suspense fallback={null}>
          <ShareReportPortal share={shareState} />
        </Suspense>
      )}

      <AppDialogs />

      {presets.saveModal.isOpen && (
        <Suspense fallback={null}>
          <SavePresetModal {...presets.saveModal} />
        </Suspense>
      )}

      {isSceneBrowserOpen && (
        <Suspense fallback={null}>
          <SceneBrowser presets={presets} hasUnsavedWork={hasUnsavedWork} onImportJson={importJson} />
        </Suspense>
      )}

      <ImportModals />

      <FabricationModals threeSceneRef={threeSceneRef} noteCards={noteCards} />

      <LazyWelcomeTour />

      <LazyJobModals />

      {mountMcpBridge && (
        <Suspense fallback={null}>
          <McpBridgeMount />
        </Suspense>
      )}

      <PresetSaveNotice />
      {/* This tab outlived a deploy and its workers no longer load. */}
      <UpdateNotice />
    </div>
  );
}

export default App;
