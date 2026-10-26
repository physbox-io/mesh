import { useRef, type RefObject } from 'react';
import { SceneOpeningPill } from './SceneOpeningPill';
import type * as THREE from 'three';
import { Code, Zap } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { usePanels } from '../../store/panelsStore';
import { useViewQuality, usePathTraceStatus } from '../../store/viewQualityStore';
import type { SceneDocument } from '../../hooks/useSceneDocument';
import { CompileErrorBanner } from '../CompileErrorBanner';
import { VoltLinkBanner } from '../VoltLinkBanner';
import { EdgeRoundPanel } from '../EdgeRoundPanel';
import SculptPanel from '../SculptPanel';
import LatticePanel from '../LatticePanel';
import { DfmHUD } from '../DfmHUD';
import { NoteCardOverlay } from '../NoteCardOverlay';
import { ReferenceImagesCard } from '../ReferenceImagesCard';
import { SceneCanvas } from './SceneCanvas';
import { ViewControls } from './ViewControls';

/**
 * The middle of the app: the 3D canvas and everything floating over it —
 * status pills, the axis legend, the view buttons, the sculpt and lattice
 * palettes, the DFM HUD and the note cards.
 */
export function Viewport({ threeSceneRef, darkMode, doc, onImportSceneJson }: {
  threeSceneRef: RefObject<THREE.Scene | null>;
  darkMode: boolean;
  doc: SceneDocument;
  onImportSceneJson: (text: string, fileName: string, dropped: boolean) => void;
}) {
  const { noteCards, setNoteCards, editingCardId, setEditingCardId } = doc;
  const axisCanvasRef = useRef<HTMLCanvasElement>(null);
  const pathTrace = useViewQuality(s => s.pathTrace);
  const pathTracePhase = usePathTraceStatus(s => s.phase);
  const pathTraceSamples = usePathTraceStatus(s => s.samples);
  const openDocs = usePanels((s) => s.openDocs);
  const { isPlaying, isLoaded, mcpActiveCount, scadCompileCount } = useStore(useShallow((s) => ({
    isPlaying: s.isPlaying, isLoaded: s.isLoaded, mcpActiveCount: s.mcpActiveCount, scadCompileCount: s.scadCompileCount,
  })));
  return (
    <main className="flex-1 relative min-w-0 overflow-hidden">
      {/* Subtle Studio Cyclorama Edge Vignette */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 z-[5] bg-[radial-gradient(ellipse_at_50%_46%,transparent_50%,rgba(100,116,139,0.12)_100%)] dark:bg-[radial-gradient(ellipse_at_50%_46%,transparent_44%,rgba(2,6,23,0.48)_100%)] shadow-[inset_0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-[inset_0_1px_4px_rgba(0,0,0,0.45)]"
      />

      {/* Top-Edge Live Simulation Hairline & Soft Glow */}
      <div
        aria-hidden="true"
        className={`pointer-events-none absolute inset-x-0 top-0 z-[6] transition-opacity duration-500 ${
          isPlaying ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className="h-[2.5px] w-full bg-gradient-to-r from-transparent via-emerald-400 to-transparent" />
        <div className="h-7 w-full bg-gradient-to-b from-emerald-500/10 via-amber-400/[0.04] to-transparent dark:from-emerald-400/14 dark:via-amber-300/[0.05] dark:to-transparent" />
      </div>

      {!isLoaded && (
        <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none bg-slate-50/50 backdrop-blur-sm">
          <div className="text-slate-500 flex flex-col items-center gap-4 font-medium">
            <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
            Initializing Mesh...
          </div>
        </div>
      )}

      {/* Floating Status Indicators */}
      <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-20 flex flex-col gap-2 pointer-events-none items-center">
        {/* First in the stack: it explains why everything under it may be
            describing a scene that is not the one being drawn. */}
        <CompileErrorBanner />
        <VoltLinkBanner />
        <EdgeRoundPanel />
        <SceneOpeningPill />
        {scadCompileCount > 0 && (
          <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
            <div className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </div>
            <Code className="w-3.5 h-3.5 text-blue-500 dark:text-blue-400" />
            <span className="tracking-wide">SCAD Compiling</span>
          </div>
        )}
        {mcpActiveCount > 0 && (
          <div className="bg-white/90 dark:bg-slate-900/90 text-slate-800 dark:text-slate-100 border border-slate-200/80 dark:border-slate-800/80 px-3.5 py-1.5 rounded-full shadow-md flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md transition-all duration-300 pointer-events-auto">
            <div className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
            </div>
            <Zap className="w-3.5 h-3.5 text-emerald-500 dark:text-emerald-400" />
            <span className="tracking-wide">MCP Active</span>
          </div>
        )}
      </div>

      {/* Axis Legend — HTML overlay, drawn to from inside the R3F Canvas via shared ref */}
      <div
        style={{
          position: 'absolute',
          top: '0.75rem',
          right: '0.75rem',
          zIndex: 15,
          pointerEvents: 'none',
          borderRadius: '10px',
          boxShadow: '0 2px 10px rgba(0,0,0,0.10)',
          padding: '3px',
        }}
        className="bg-slate-50/85 dark:bg-slate-900/85 backdrop-blur-md border border-slate-200/70 dark:border-slate-800/70"
      >
        <canvas ref={axisCanvasRef} width={76} height={76} style={{ display: 'block', borderRadius: '7px' }} />
      </div>
  
      <SceneCanvas threeSceneRef={threeSceneRef} axisCanvasRef={axisCanvasRef} darkMode={darkMode} onImportSceneJson={onImportSceneJson} />

      {pathTrace && (
        <div className="absolute bottom-14 right-4 z-10 px-2 py-0.5 rounded text-[10px] font-medium tabular-nums bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200 dark:border-slate-800 text-slate-600 dark:text-slate-300 pointer-events-none">
          {isPlaying ? 'Render paused while playing'
            : pathTracePhase === 'waiting' ? 'Render: waiting for the view to settle'
            : pathTracePhase === 'building' ? 'Render: preparing scene'
            : pathTracePhase === 'rendering' ? `Render: ${pathTraceSamples} samples`
            : `Render: done, ${pathTraceSamples} samples`}
        </div>
      )}

      <ViewControls />
      <ReferenceImagesCard />

      {/* Sculpt tool palette — only mounted while a body is open for sculpting */}
      <SculptPanel />
      {/* Lattice tool palette — likewise, only while a cage is open */}
      <LatticePanel onOpenDocs={() => openDocs('lattice')} />

      {/* Floating Mechanical & 3D Print Failure HUD */}
      <DfmHUD />

      {/* Floating Note Card Overlays */}
      {noteCards.map(card => (
        <NoteCardOverlay
          key={card.id}
          card={card}
          isEditing={editingCardId === card.id}
          onToggleEdit={() => setEditingCardId(prev => prev === card.id ? null : card.id)}
          onToggleMinimize={() => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, minimized: !c.minimized } : c))}
          onMarkdownChange={(md) => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, markdown: md } : c))}
          onClose={() => { setNoteCards(prev => prev.filter(c => c.id !== card.id)); if (editingCardId === card.id) setEditingCardId(null); }}
          onMove={(x, y) => setNoteCards(prev => prev.map(c => c.id === card.id ? { ...c, x, y } : c))}
        />
      ))}
    </main>
  );
}
