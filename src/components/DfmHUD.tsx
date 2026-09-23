import { useCallback, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight, ChevronUp, Ruler, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { dfmLensFor, type DfmFinding, type DfmProcess, type DfmReport } from '../utils/dfm';
import { type WeakSpot } from '../utils/printAnalysis';
import { analyseDfmShared, analyzeWeaknessesShared } from '../utils/analysisCache';
import { materialSpec } from '../utils/feedsAndSpeeds';
import { filamentSpec } from '../utils/filaments';

/**
 * What the DFM overlay says, in words, beside the heat map that says it in
 * colour.
 *
 * Every finding carries the measurement that triggered it and what to do about
 * it, because "this part has overhangs" is not actionable and "31% of the
 * surface leans past 45°, turn it on the plate" is.
 *
 * The machine lens is not chosen here — it follows the bench. Casting is the
 * exception: a real Mesh workflow but not a machine, so it sits at the bottom,
 * collapsed, and expanding it takes the heat map with it.
 *
 * Draggable and roll-up-able, on the same pointer-event pattern as the note
 * cards in App.tsx: this panel sits over the model it is describing, and being
 * unable to move it out of the way is the difference between a tool and an
 * obstruction.
 */

const PROCESS_LABEL: Record<DfmProcess, string> = {
  print: '3D print',
  cnc: '3-axis CNC',
  cast: 'Casting',
};

const SEVERITY_STYLE: Record<DfmFinding['severity'], string> = {
  critical: 'border-rose-300 bg-rose-50 text-rose-900 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-200',
  warning: 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200',
  info: 'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-200',
};

type Entry = { key: string; severity: DfmFinding['severity']; title: string; detail: string; fix: string };

const fromFinding = (f: DfmFinding): Entry =>
  ({ key: f.id, severity: f.severity, title: f.title, detail: f.detail, fix: f.fix });
const fromWeakSpot = (w: WeakSpot): Entry =>
  ({ key: w.id, severity: w.severity, title: w.title, detail: w.description, fix: w.recommendation });

function Findings({ entries }: { entries: Entry[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {entries.map(e => (
        <li key={e.key} className={`rounded border px-2.5 py-2 ${SEVERITY_STYLE[e.severity]}`}>
          <p className="text-xs font-semibold">{e.title}</p>
          <p className="mt-0.5 text-[11px] leading-snug opacity-90">{e.detail}</p>
          <p className="mt-1 text-[11px] leading-snug font-medium">{e.fix}</p>
        </li>
      ))}
    </ul>
  );
}

const scoreTone = (score: number) => score >= 85 ? 'text-emerald-600 dark:text-emerald-400'
  : score >= 60 ? 'text-amber-600 dark:text-amber-400'
    : 'text-rose-600 dark:text-rose-400';

export function DfmHUD() {
  const sceneGraph = useStore(state => state.sceneGraph);
  const dfmEnabled = useStore(state => state.dfmEnabled);
  const setDfmEnabled = useStore(state => state.setDfmEnabled);
  const castOpen = useStore(state => state.dfmCastOpen);
  const setCastOpen = useStore(state => state.setDfmCastOpen);
  const panel = useStore(state => state.dfmPanel);
  const setPanel = useStore(state => state.setDfmPanel);
  const machineTarget = useStore(state => state.machineTarget);
  const material = useStore(state => state.material);
  const filament = useStore(state => state.filament);
  const stock = useStore(state => state.stock);
  const selectedNodeId = useStore(state => state.selectedNodeId);

  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  // Pointer events, not mouse events, so a finger and a stylus move the panel
  // through the same code path a mouse does. Same as NoteCardOverlay.
  const onTitlePointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    // Undragged, the panel is anchored to the bottom edge and has no x/y yet.
    // Take its real position off the DOM so the first drag does not jump.
    const box = (e.currentTarget as HTMLElement).parentElement?.getBoundingClientRect();
    const parent = (e.currentTarget as HTMLElement).offsetParent?.getBoundingClientRect();
    const origX = panel.x ?? ((box?.left ?? 0) - (parent?.left ?? 0));
    const origY = panel.y ?? ((box?.top ?? 0) - (parent?.top ?? 0));
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX, origY };
    const move = (me: PointerEvent) => {
      if (!dragRef.current) return;
      setPanel({
        x: dragRef.current.origX + me.clientX - dragRef.current.startX,
        y: dragRef.current.origY + me.clientY - dragRef.current.startY,
      });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const selectedName = useMemo(() => {
    if (!selectedNodeId || !sceneGraph) return null;
    const find = (ns: typeof sceneGraph.nodes): string | null => {
      for (const n of ns || []) {
        if (n.id === selectedNodeId) return n.name || n.id;
        const hit = find(n.children || []);
        if (hit) return hit;
      }
      return null;
    };
    return find(sceneGraph.nodes);
  }, [sceneGraph, selectedNodeId]);

  // The machine lens is not a setting: it follows the bench.
  const lens = dfmEnabled ? dfmLensFor(machineTarget) : null;
  const bench = useMemo(
    () => ({ material, filament, stock, nodeId: selectedNodeId }),
    [material, filament, stock, selectedNodeId],
  );

  const analyse = useCallback((process: DfmProcess | null, when: boolean): DfmReport | null => {
    if (!process || !when || !sceneGraph) return null;
    try {
      return analyseDfmShared(sceneGraph, process, bench);
    } catch {
      return null;
    }
  }, [sceneGraph, bench]);

  const open = dfmEnabled && !panel.minimized;
  const report = useMemo(
    () => analyse(lens, open),
    [analyse, lens, open],
  );
  // Only paid for while the section is expanded: sampling the scene again on
  // every keystroke for a section nobody opened is not free.
  const castReport = useMemo(
    () => analyse('cast', open && castOpen),
    [analyse, open, castOpen],
  );

  /**
   * The structural checks are process-independent — a column that buckles
   * buckles however it was made — so they ride along with whatever is open
   * rather than needing a lens of their own. This is where the old "Weak Spots"
   * button's findings went.
   */
  const structural = useMemo(() => {
    if (!open || !sceneGraph) return [] as WeakSpot[];
    try {
      return analyzeWeaknessesShared(sceneGraph).weakSpots
        .filter(w => w.category !== 'manufacturing');
    } catch {
      return [] as WeakSpot[];
    }
  }, [sceneGraph, open]);

  if (!dfmEnabled) return null;

  return (
    <div
      style={{
        position: 'absolute', zIndex: 25,
        // Bottom left until someone moves it: out of the way of the model, and
        // beside the bench controls whose choices it is reporting on.
        ...(panel.x === null || panel.y === null
          ? { left: 16, bottom: 16 }
          : { left: panel.x, top: panel.y }),
        width: 'min(30rem, calc(100vw - 2rem))', touchAction: 'none',
      }}
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95"
    >
      <div
        className="flex cursor-move select-none items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/40"
        onPointerDown={onTitlePointerDown}
      >
        <Ruler className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        {/* Fabrication is per part, and a Mesh scene is usually a simulation.
            Naming the body is what stops the answers being mysterious when
            nothing is selected and the whole gear train gets measured. */}
        <span className="truncate text-xs font-semibold text-slate-700 dark:text-slate-300">
          DFM: {selectedName ?? 'whole scene'}
          {lens && report && (
            <> · {PROCESS_LABEL[lens]} in {lens === 'print' ? filamentSpec(filament).label : materialSpec(material).label}</>
          )}
        </span>
        {lens && report && (
          <span className={`text-xs font-bold tabular-nums ${scoreTone(report.score)}`}>{report.score}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={() => setPanel({ minimized: !panel.minimized })}
            className="rounded p-0.5 transition-colors hover:bg-slate-200 dark:hover:bg-slate-800"
            title={panel.minimized ? 'Expand' : 'Minimize'}
          >
            {panel.minimized
              ? <ChevronDown className="h-3 w-3 text-slate-500 dark:text-slate-400" />
              : <ChevronUp className="h-3 w-3 text-slate-500 dark:text-slate-400" />}
          </button>
          <button
            onClick={() => setDfmEnabled(false)}
            className="rounded p-0.5 transition-colors hover:bg-red-100 dark:hover:bg-red-950/40"
            title="Close"
          >
            <X className="h-3 w-3 text-slate-500 hover:text-red-500 dark:text-slate-400" />
          </button>
        </div>
      </div>

      {!panel.minimized && (
        <div className="max-h-[40vh] overflow-y-auto px-3 py-2">
          <p className="mb-1.5 truncate text-[10px] text-slate-400">
            {castOpen && castReport ? castReport.legend : report?.legend}
          </p>

          {/* A laser has no Z depth, so overhang, undercut and reach mean
              nothing to it. Better no answer than a confident one from the
              wrong lens — and casting below is still worth offering. */}
          {!lens && (
            <p className="py-1 text-xs text-slate-500 dark:text-slate-400">
              DFM covers the printer and the router. There is no laser check yet.
            </p>
          )}

          {lens && report && (
            report.findings.length === 0
              ? <p className="py-1 text-xs text-emerald-700 dark:text-emerald-300">{report.summary}</p>
              : <Findings entries={report.findings.map(fromFinding)} />
          )}

          {structural.length > 0 && (
            <>
              <p className="mt-2.5 mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                Whatever it is made of
              </p>
              <Findings entries={structural.map(fromWeakSpot)} />
            </>
          )}

          {report?.warnings.map(w => (
            <p key={w} className="mt-2 text-[10px] leading-snug text-slate-400">{w}</p>
          ))}

          {/* Casting is not a machine, so it cannot follow the bench like the
              others. Collapsed by default: most parts are not being cast, and a
              section nobody opened should cost nothing to have. */}
          <button
            onClick={() => setCastOpen(!castOpen)}
            className="mt-3 flex w-full items-center gap-1 border-t border-slate-100 pt-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400 transition-colors hover:text-slate-600 dark:border-slate-800 dark:hover:text-slate-300"
          >
            {castOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            If it were cast
            {castOpen && castReport && (
              <span className={`ml-auto text-xs font-bold tabular-nums ${scoreTone(castReport.score)}`}>
                {castReport.score}
              </span>
            )}
          </button>

          {castOpen && castReport && (
            <div className="mt-2">
              {castReport.findings.length === 0
                ? <p className="py-1 text-xs text-emerald-700 dark:text-emerald-300">{castReport.summary}</p>
                : <Findings entries={castReport.findings.map(fromFinding)} />}
              <p className="mt-2 text-[10px] leading-snug text-slate-400">
                Judged against a flat parting plane at mid-height, pulled along Z. The mould and cast-pattern
                exports search for a better line than that.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
