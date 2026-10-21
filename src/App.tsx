import { useRef } from 'react';
import type * as THREE from 'three';
import { LeftSidebar } from './components/palette/LeftSidebar';
import { InspectorPanel } from './components/inspector/InspectorPanel';
import { useMuJoCoInit } from './hooks/useMuJoCo';
import { useMCPBridge } from './hooks/useMCPBridge';
import { useStore } from './store/useStore';
import AICopilotPanel from './components/AICopilotPanel';
import { DocsModal } from './components/docs/DocsModal';
import { setScadCompileListener } from './utils/openscad';
import { useCsgAutoCompile } from './hooks/useCsgCompile';
import { AppDialogs } from './components/AppDialogs';
import { useVoltLink } from './hooks/useVoltLink';
import { JobRestoreModal } from './components/JobRestoreModal';
import { JobSucceededModal } from './components/JobSucceededModal';
import { JobPauseModal } from './components/JobPauseModal';
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
import { ShareReportPortal } from './components/ShareReportPortal';
import { SavePresetModal } from './components/SavePresetModal';
import { ImportModals } from './components/ImportModals';
import { FabricationModals } from './components/FabricationModals';

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

  const doc = useSceneDocument();
  const { noteCards, setNoteCards, copilotMessages, setCopilotMessages, setEditingCardId, hasUnsavedWork } = doc;

  useCompilerPreload();
  useEditShortcuts();
  useCardCollapse();

  const presets = usePresetActions(doc);
  const shareState = useShareScene(noteCards, presets.loadUserPresetWithCard);
  const { exportJson, importSceneJson, importJson } = useSceneIo(doc);

  // The three.js scene, captured inside the canvas; the STL and 3MF exports read it.
  const threeSceneRef = useRef<THREE.Scene | null>(null);

  useMCPBridge();
  useVoltLink();
  // Regenerates a boolean body's mesh whenever its primitives change.
  useCsgAutoCompile();

  return (
    /*
      `h-dvh`, not `h-screen`: on a phone `100vh` is the viewport with the URL
      bar hidden, so the foot of the app sat underneath the browser chrome and
      could not be reached. On a desktop the two are the same number.
    */
    <div className={`flex flex-col h-dvh w-screen transition-colors duration-200 ${darkMode ? 'dark bg-slate-950 text-slate-100' : 'bg-slate-50 text-slate-900'} font-sans`}>
      <AppHeader
        presets={presets}
        hasUnsavedWork={hasUnsavedWork}
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
          <AICopilotPanel
            onClose={() => setCopilotOpen(false)}
            messages={copilotMessages}
            setMessages={setCopilotMessages}
          />
        )}
      </div>

      {isDocsOpen && (
        <DocsModal tab={docsTab} onTab={setDocsTab} onClose={closeDocs} />
      )}

      <ShareReportPortal share={shareState} />

      <AppDialogs />

      <SavePresetModal {...presets.saveModal} />

      <ImportModals />

      <FabricationModals threeSceneRef={threeSceneRef} noteCards={noteCards} />

      {/* A job that was still cutting when this browser last closed. Mounted at
          the top level and not inside an export modal, because the session that
          opened that modal is the session that went away. */}
      <JobRestoreModal />
      {/* A job that ran to its last line, wherever it was started from. */}
      <JobSucceededModal />
      {/* A job stopped for a tool or sheet change, over whatever is open. */}
      <JobPauseModal />
      <PresetSaveNotice />
      {/* This tab outlived a deploy and its workers no longer load. */}
      <UpdateNotice />
    </div>
  );
}

export default App;
