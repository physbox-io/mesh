import { Play, Square, Settings, X, RotateCcw, Trash2, Info, Menu, Save, Download, Upload, Undo, Redo, PanelRight, Printer, Sparkles, Sun, Moon, Image as ImageIcon, Share2, Frame } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { usePanels } from '../../store/panelsStore';
import { useSelectedNode } from '../../hooks/useSelectedNode';
import type { PresetActions } from '../../hooks/usePresetActions';
import { pressHistoryKey } from '../../utils/historyKeys';
import { SHOW_EXPORTS_EVENT } from '../BottomStatusBar';
import { AgentMachineBanner } from '../AgentMachineBanner';
import { UserProfileButton } from '../UserProfileButton';
import { AppLogo } from './AppLogo';
import { PresetPicker } from './PresetPicker';
import { useDialogs } from '../../store/dialogStore';
import { addReferencePicture } from '../../utils/addReferencePicture';

/** The top bar: presets, Run/Reset, files and history, and the app's switches. */
export function AppHeader({
  presets, onExportJson, onImportJson, onShare, darkMode, onToggleDarkMode,
}: {
  presets: PresetActions;
  onExportJson: () => void;
  onImportJson: () => void;
  onShare: () => void;
  darkMode: boolean;
  onToggleDarkMode: () => void;
}) {
  const { handleSavePresetClick } = presets;
  const isLeftSidebarOpen = usePanels((s) => s.isLeftSidebarOpen);
  const setIsLeftSidebarOpen = usePanels((s) => s.setLeftSidebarOpen);
  const isPropertiesOpen = usePanels((s) => s.isPropertiesOpen);
  const setIsPropertiesOpen = usePanels((s) => s.setPropertiesOpen);
  const isCopilotOpen = usePanels((s) => s.isCopilotOpen);
  const setCopilotOpen = usePanels((s) => s.setCopilotOpen);
  const openDocs = usePanels((s) => s.openDocs);
  const openStlImport = usePanels((s) => s.openStlImport);
  const openImageImport = usePanels((s) => s.openImageImport);
  const {
    isPlaying, togglePlay, isLoaded, resetSimulation,
    isSettingsOpen, setSettingsOpen,
    selectedNodeId, extraSelectedIds, sculptNodeId, latticeNodeId,
    canUndo, canRedo,
  } = useStore(useShallow((s) => ({
    isPlaying: s.isPlaying, togglePlay: s.togglePlay, isLoaded: s.isLoaded, resetSimulation: s.resetSimulation,
    isSettingsOpen: s.isSettingsOpen, setSettingsOpen: s.setSettingsOpen,
    selectedNodeId: s.selectedNodeId, extraSelectedIds: s.extraSelectedIds,
    sculptNodeId: s.sculptNodeId, latticeNodeId: s.latticeNodeId,
    canUndo: s.undoStack.length > 0, canRedo: s.redoStack.length > 0,
  })));
  const selectedNode = useSelectedNode();
  return (
    <>
      {/*
        Below `lg` the bar wraps onto as many rows as it needs rather than
        squeezing. Everything in here is a file operation, an export or a
        simulation control — deciding on the operator's behalf that they will
        not want to export an STL on a phone is how a mobile layout ends up
        being a demo of the app rather than the app.
      */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 px-3 md:px-6 py-2 flex items-center justify-between shadow-xs z-10 transition-colors shrink-0 max-lg:flex-wrap max-lg:justify-start max-lg:gap-y-1.5">
        {/* Left: Logo, Title & Preset Selector */}
        <div className="flex items-center gap-2 md:gap-4 min-w-0 max-lg:w-full">
          {/* Mobile Sidebar Toggle */}
          <button
            onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
            className="p-1.5 rounded-md text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200 transition-colors md:hidden focus:outline-none cursor-pointer flex-shrink-0"
            title="Toggle Sidebar"
          >
            {isLeftSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>

          {/* Logo & Title */}
          <AppLogo />

          <div className="h-5 w-px bg-slate-200 dark:bg-slate-800 hidden md:block" />

          <PresetPicker presets={presets} />
        </div>

        {/* Center/Right: Simulation Toolbar & Files */}
        <div className="flex items-center gap-2 md:gap-3 min-w-0 max-lg:w-full max-lg:flex-wrap max-lg:justify-between max-lg:gap-y-1.5">
          {/* Simulation Controller Block */}
          <div className={`flex items-center max-lg:shrink-0 p-0.5 rounded-lg border transition-all duration-300 ${
            isPlaying
              ? 'bg-emerald-50/80 dark:bg-emerald-950/35 border-emerald-400/60 dark:border-emerald-500/40 shadow-[0_0_12px_-2px_rgba(16,185,129,0.28)]'
              : 'bg-slate-100 dark:bg-slate-800/80 border-slate-200/80 dark:border-slate-700/60 shadow-inner'
          }`}>
            {/* Simulate / Stop */}
            <button 
              onClick={togglePlay}
              disabled={!isLoaded}
              className={`flex items-center justify-center gap-1.5 px-3 py-1 rounded-md font-semibold text-xs transition-all disabled:opacity-50 flex-shrink-0 cursor-pointer ${
                isPlaying
                  ? 'bg-red-500 hover:bg-red-600 text-white shadow-xs'
                  : 'hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-100'
              }`}
              title={isPlaying ? "Stop Simulation" : "Start Simulation"}
            >
              {isPlaying ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />}
              <span className="hidden md:inline">{isPlaying ? 'Stop' : 'Run'}</span>
            </button>

            {/* Reset */}
            <button 
              onClick={resetSimulation}
              disabled={!isLoaded}
              className="flex items-center justify-center gap-1.5 px-3 py-1 rounded-md font-semibold text-xs hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors disabled:opacity-50 flex-shrink-0 cursor-pointer"
              title="Reset Simulation"
            >
              <RotateCcw className="w-3 h-3" />
              <span className="hidden md:inline">Reset</span>
            </button>
          </div>

          {/* Files Segmented Group */}
          <div className="flex items-center max-lg:shrink-0 bg-slate-100 dark:bg-slate-800/80 p-0.5 rounded-lg border border-slate-200/80 dark:border-slate-700/60 shadow-inner">
            <button 
              onClick={handleSavePresetClick}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Save scene preset (Ctrl+S)"
            >
              <Save className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => {
                if (selectedNodeId) useStore.getState().deleteNodes([selectedNodeId, ...extraSelectedIds]);
              }}
              disabled={!selectedNodeId}
              className="flex items-center justify-center p-1 rounded-md hover:bg-red-50 dark:hover:bg-red-950/40 text-red-500 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title={selectedNodeId ? "Delete selected item (Delete / Backspace)" : "No item selected"}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={onExportJson}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="JSON"
            >
              <Download className="w-3.5 h-3.5" />
            </button>

            {/* Share: a link with the scene inside it. Next to the JSON
                download because it is one — the same scene, addressed to a
                browser instead of a disk. */}
            <button
              onClick={onShare}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-sky-600 dark:text-sky-400 transition-colors focus:outline-none cursor-pointer"
              title="Copy a share link — the scene travels inside it"
            >
              <Share2 className="w-3.5 h-3.5" />
            </button>

            {/* Exporting is done from the status bar, beside the machine it
                is exported for. This stays because it is where people look
                for it, and it sends them there. */}
            <button
              onClick={() => window.dispatchEvent(new CustomEvent(SHOW_EXPORTS_EVENT))}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Export for a printer, laser or router. The buttons are on the bottom bar, beside the machine and material they depend on."
            >
              <Printer className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => openImageImport()}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-fuchsia-600 dark:text-fuchsia-400 transition-colors focus:outline-none cursor-pointer"
              title="Import Image as 3D Relief (heightmap)"
            >
              <ImageIcon className="w-3.5 h-3.5" />
            </button>

            <label
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-fuchsia-600 dark:text-fuchsia-400 transition-colors cursor-pointer"
              title="Reference picture: pin a photo or drawing in the viewport to model from"
            >
              <Frame className="w-3.5 h-3.5" />
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) {
                    addReferencePicture(file).catch((err) =>
                      useDialogs.getState().showNotice('Could not add the picture', String(err?.message ?? err), 'amber'));
                  }
                }}
              />
            </label>

            <button
              onClick={() => openStlImport()}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Import STL (3D file)"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={onImportJson}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 transition-colors focus:outline-none cursor-pointer"
              title="Import JSON"
            >
              <Upload className="w-3.5 h-3.5" />
            </button>

            {/* The buttons press Ctrl+Z rather than calling the store, so they
                do exactly what the keys do: while sculpt or lattice is open
                that is the tool's own last step, falling through to the
                document once the tool's history is spent. Calling undo()
                directly stepped the document back from under the tool and
                threw its history away. */}
            <button
              onClick={() => pressHistoryKey(false)}
              disabled={!canUndo && !sculptNodeId && !latticeNodeId}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title="Undo"
            >
              <Undo className="w-3.5 h-3.5" />
            </button>

            <button
              onClick={() => pressHistoryKey(true)}
              disabled={!canRedo && !sculptNodeId && !latticeNodeId}
              className="flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-600 dark:text-slate-300 disabled:opacity-30 disabled:hover:bg-transparent transition-colors focus:outline-none cursor-pointer"
              title="Redo"
            >
              <Redo className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Right Utilities (Dark Mode, Docs, Settings, Copilot, User Profile, GitHub) */}
          <div className="flex items-center gap-1.5 max-lg:shrink-0">
            {/* Dark Mode Toggle - immediately left of Docs button */}
            <button
              onClick={onToggleDarkMode}
              className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title={darkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-indigo-500 dark:text-indigo-400" />}
            </button>

            {/*
              Properties inspector — a permanent column at `lg`, a drawer below
              it, opened from here. The mirror of the hierarchy hamburger on the
              other end of the bar: one button for the palette going in, one for
              the inspector coming out. Disabled rather than hidden with nothing
              selected, so the bar does not reflow as things are picked and
              dropped, and the button says why it is dark.
            */}
            <button
              onClick={() => setIsPropertiesOpen(!isPropertiesOpen)}
              disabled={!selectedNode || isPlaying}
              className={`lg:hidden flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs disabled:opacity-40 disabled:cursor-not-allowed ${
                isPropertiesOpen
                  ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900'
              }`}
              title={isPlaying ? 'Stop the simulation to edit properties' : selectedNode ? 'Properties' : 'Select a component to see its properties'}
            >
              <PanelRight className="w-4 h-4" />
            </button>

            {/* Docs (Info) */}
            <button
              onClick={() => openDocs('quickref')}
              className="flex items-center justify-center w-8 h-8 rounded-full border border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title="Documentation"
            >
              <Info className="w-4 h-4" />
            </button>

            {/* Settings */}
            <button 
              onClick={() => setSettingsOpen(!isSettingsOpen)}
              className={`flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs ${
                isSettingsOpen 
                  ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400' 
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
              title="Global Settings"
            >
              <Settings className="w-4 h-4" />
            </button>

            {/* AI Copilot */}
            <button
              onClick={() => setCopilotOpen(!isCopilotOpen)}
              className={`flex items-center justify-center w-8 h-8 rounded-full border transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs ${
                isCopilotOpen 
                  ? 'bg-blue-100 border-blue-400 text-blue-700 dark:bg-blue-950 dark:border-blue-700 dark:text-blue-400' 
                  : 'border-indigo-200 dark:border-indigo-800 text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-950/30 hover:bg-indigo-100 dark:hover:bg-indigo-900/40'
              }`}
              title="AI Copilot Expert"
            >
              <Sparkles className="w-4 h-4" />
            </button>

            {/* User Profile & Cloud Sync */}
            {/* Whether Claude may move the machine — see AgentMachineBanner */}
            <AgentMachineBanner />

            <UserProfileButton />

            {/* GitHub */}
            <a
              href="https://github.com/physbox-io/mesh"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
              title="View on GitHub"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
            </a>
          </div>
        </div>
      </header>
    </>
  );
}
