import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Crosshair, Ruler, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import {
  dfmLensFor,
  type DfmAction,
  type DfmFinding,
  type DfmProcess,
  type DfmReport,
} from '../utils/dfm';
import type { SceneNode } from '../types/scene';
import { livePoses } from './scene/bodyPose';
import {
  clearDfmFocus,
  getLivePosedScene,
  setActiveDfmFinding,
  setDfmCheckAllAsPlate,
  setHoveredDfmFinding,
  useDfmFocus,
  useDfmReport,
  type DfmFocusTarget,
} from '../utils/dfmWorkerClient';
import { materialSpec } from '../utils/feedsAndSpeeds';
import { filamentSpec } from '../utils/filaments';
import { useCastDialog } from '../store/castDialogStore';

/**
 * What the DFM overlay says, in words, beside the heat map that says it in
 * colour.
 *
 * Every finding carries the measurement that triggered it, where on the model
 * it sits (hover to pin, click to focus/select), and 1-click actions wired to
 * Mesh's fabrication and editing tools.
 *
 * The machine lens is not chosen here — it follows the bench. Casting is the
 * exception: a real Mesh workflow but not a machine, so it sits at the bottom,
 * collapsed, and expanding it takes the heat map with it.
 *
 * Draggable and roll-up-able, on the same pointer-event pattern as the note
 * cards in App.tsx, clamped inside the viewport so resizing never strands it.
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

const PANEL_MARGIN_PX = 8;
const PANEL_MIN_VISIBLE_H = 48;

function findNodeInTree(nodes: SceneNode[], id: string): SceneNode | null {
  for (const n of nodes || []) {
    if (n.id === id) return n;
    const hit = findNodeInTree(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

function clampPanelPos(
  x: number,
  y: number,
  width: number,
  viewportW: number,
  viewportH: number,
): { x: number; y: number } {
  const maxX = Math.max(PANEL_MARGIN_PX, viewportW - Math.max(200, width) - PANEL_MARGIN_PX);
  const maxY = Math.max(PANEL_MARGIN_PX, viewportH - PANEL_MIN_VISIBLE_H);
  return {
    x: Math.min(maxX, Math.max(PANEL_MARGIN_PX, x)),
    y: Math.min(maxY, Math.max(PANEL_MARGIN_PX, y)),
  };
}

function toFocusTarget(f: DfmFinding): DfmFocusTarget {
  return {
    id: f.id,
    title: f.title,
    detail: f.detail,
    fix: f.fix,
    severity: f.severity,
    position: f.position,
    nodeId: f.nodeId,
    process: f.process,
  };
}

const scoreTone = (score: number) => score >= 85 ? 'text-emerald-600 dark:text-emerald-400'
  : score >= 60 ? 'text-amber-600 dark:text-amber-400'
    : 'text-rose-600 dark:text-rose-400';

function PassedBadges({ passed }: { passed: DfmFinding[] }) {
  if (passed.length === 0) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {passed.map((f) => (
        <span
          key={f.id}
          title={f.detail}
          onMouseEnter={() => setHoveredDfmFinding(toFocusTarget(f))}
          onMouseLeave={() => setHoveredDfmFinding(null)}
          className="inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-[10px] font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300"
        >
          <CheckCircle2 className="h-3 w-3 shrink-0" />
          <span>{f.title}</span>
        </span>
      ))}
    </div>
  );
}

interface FindingsListProps {
  findings: DfmFinding[];
  activeId: string | null;
  onSelectFinding: (finding: DfmFinding) => void;
  onRunAction: (finding: DfmFinding, action: DfmAction) => void;
}

function FindingsList({ findings, activeId, onSelectFinding, onRunAction }: FindingsListProps) {
  return (
    <ul className="flex flex-col gap-2">
      {findings.map((f) => {
        const isActive = activeId === f.id;
        return (
          <li
            key={f.id}
            onMouseEnter={() => setHoveredDfmFinding(toFocusTarget(f))}
            onMouseLeave={() => setHoveredDfmFinding(null)}
            onClick={() => onSelectFinding(f)}
            className={`cursor-pointer rounded border px-2.5 py-2 transition-shadow ${SEVERITY_STYLE[f.severity]} ${isActive ? 'ring-2 ring-amber-500/80 dark:ring-amber-400/80' : 'hover:shadow-sm'}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-xs font-semibold">{f.title}</p>
              <Crosshair
                className={`mt-0.5 h-3 w-3 shrink-0 transition-opacity ${isActive ? 'opacity-100' : 'opacity-40'}`}
                aria-hidden="true"
              />
            </div>
            <p className="mt-0.5 text-[11px] leading-snug opacity-90">{f.detail}</p>
            {f.fix && (
              <p className="mt-1 text-[11px] leading-snug font-medium">{f.fix}</p>
            )}
            {f.actions && f.actions.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {f.actions.map((action, idx) => (
                  <button
                    key={`${action.kind}:${action.label}:${idx}`}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRunAction(f, action);
                    }}
                    className="cursor-pointer rounded-md border border-current/25 bg-white/80 px-2 py-0.5 text-[10px] font-semibold transition-colors hover:bg-white dark:bg-slate-900/70 dark:hover:bg-slate-900"
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface ReportBodyProps {
  report: DfmReport;
  activeId: string | null;
  onSelectFinding: (finding: DfmFinding) => void;
  onRunAction: (finding: DfmFinding, action: DfmAction) => void;
}

function ReportBody({ report, activeId, onSelectFinding, onRunAction }: ReportBodyProps) {
  const issues = useMemo(() => report.findings.filter((f) => !f.passed), [report.findings]);
  const passed = useMemo(() => report.findings.filter((f) => f.passed), [report.findings]);

  return (
    <>
      <PassedBadges passed={passed} />
      {report.needsPartSelection && (
        <div className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-800/70 dark:text-slate-200">
          <span>
            Select a part to check fabrication ({report.needsPartSelection.bodyCount} parts in scene).
          </span>
          <button
            type="button"
            onClick={() => setDfmCheckAllAsPlate(true)}
            className="shrink-0 cursor-pointer rounded-md border border-amber-400/60 bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950/60 dark:text-amber-200 dark:hover:bg-amber-900/60"
          >
            Check all parts
          </button>
        </div>
      )}
      {issues.length === 0 ? (
        !report.needsPartSelection && (
          <p className="py-1 text-xs text-emerald-700 dark:text-emerald-300">{report.summary}</p>
        )
      ) : (
        <FindingsList
          findings={issues}
          activeId={activeId}
          onSelectFinding={onSelectFinding}
          onRunAction={onRunAction}
        />
      )}
    </>
  );
}

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
  const setFilament = useStore(state => state.setFilament);
  const stock = useStore(state => state.stock);
  const setStock = useStore(state => state.setStock);
  const printBed = useStore(state => state.printBed);
  const printer = useStore(state => state.printer);
  const setPrinter = useStore(state => state.setPrinter);
  const selectedNodeId = useStore(state => state.selectedNodeId);
  const setSelectedNodeId = useStore(state => state.setSelectedNodeId);
  const updateNode = useStore(state => state.updateNode);
  const startEdgeRound = useStore(state => state.startEdgeRound);
  const updateEdgeRoundDraft = useStore(state => state.updateEdgeRoundDraft);
  const recompileId = useStore(state => state.recompileId);
  const isPlaying = useStore(state => state.isPlaying);

  const { active: activeFinding, checkAllAsPlate } = useDfmFocus();
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number; width: number } | null>(null);
  const [viewport, setViewport] = useState(() => ({
    w: typeof window !== 'undefined' ? window.innerWidth : 1280,
    h: typeof window !== 'undefined' ? window.innerHeight : 720,
  }));

  // Keep dragged panel clamped inside the viewport whenever the window resizes.
  useEffect(() => {
    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      setViewport({ w, h });
      const current = useStore.getState().dfmPanel;
      if (current.x !== null && current.y !== null) {
        const panelWidth = panelRef.current?.getBoundingClientRect().width ?? 480;
        const clamped = clampPanelPos(current.x, current.y, panelWidth, w, h);
        if (clamped.x !== current.x || clamped.y !== current.y) {
          useStore.getState().setDfmPanel(clamped);
        }
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

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
    const width = box?.width ?? 480;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX, origY, width };
    const move = (me: PointerEvent) => {
      if (!dragRef.current) return;
      const rawX = dragRef.current.origX + me.clientX - dragRef.current.startX;
      const rawY = dragRef.current.origY + me.clientY - dragRef.current.startY;
      const parentRect = panelRef.current?.offsetParent?.getBoundingClientRect();
      const vw = parentRect?.width ?? window.innerWidth;
      const vh = parentRect?.height ?? window.innerHeight;
      setPanel(clampPanelPos(rawX, rawY, dragRef.current.width, vw, vh));
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

  const open = dfmEnabled && !panel.minimized;

  // Selecting a specific part automatically exits whole-plate mode; closing or
  // minimizing the panel clears stale 3D pins.
  useEffect(() => {
    if (selectedNodeId && checkAllAsPlate) setDfmCheckAllAsPlate(false);
  }, [selectedNodeId, checkAllAsPlate]);

  useEffect(() => {
    if (!open) clearDfmFocus();
  }, [open]);

  useEffect(() => {
    setHoveredDfmFinding(null);
    if (activeFinding && selectedNodeId && activeFinding.nodeId && activeFinding.nodeId !== selectedNodeId) {
      setActiveDfmFinding(null);
    }
    // Only clear stale pins belonging to a different part when selection changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodeId]);

  useEffect(() => {
    clearDfmFocus();
  }, [machineTarget]);

  useEffect(() => {
    if (!castOpen && activeFinding?.process === 'cast') {
      setActiveDfmFinding(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [castOpen]);

  const selectedName = useMemo(() => {
    if (!selectedNodeId || !sceneGraph) return null;
    const hit = findNodeInTree(sceneGraph.nodes || [], selectedNodeId);
    return hit ? (hit.name || hit.id) : null;
  }, [sceneGraph, selectedNodeId]);

  // The machine lens is not a setting: it follows the bench.
  const lens = dfmEnabled ? dfmLensFor(machineTarget) : null;
  // What the Mold dialog's Rigid tab last poured: the casting lens's thinnest
  // section is the material's (epoxy fills a millimetre, plaster three).
  const castMaterial = useCastDialog((s) => s.materialByTab.rigid);
  const bench = useMemo(
    () => ({
      material,
      filament,
      stock,
      printBed,
      printer,
      nodeId: selectedNodeId,
      ...(!selectedNodeId && checkAllAsPlate ? { checkAllAsPlate: true } : {}),
      ...(castMaterial ? { castMaterial } : {}),
    }),
    [material, filament, stock, printBed, printer, selectedNodeId, checkAllAsPlate, castMaterial],
  );

  // When physics has moved any body, align the scene sent to the worker with
  // the live MuJoCo poses so heatmap triangles, hardware checks, and 3D pins
  // all sit where the bodies actually are in the viewport.
  const live = useMemo(() => {
    // Re-read mutable MuJoCo poses after a sim pause or reset (`recompileId`).
    void recompileId;
    if (!open || isPlaying || !sceneGraph) return null;
    return livePoses(sceneGraph.nodes || []);
  }, [open, sceneGraph, recompileId, isPlaying]);
  const effectiveScene = useMemo(
    () => (sceneGraph ? getLivePosedScene(sceneGraph, live) : null),
    [sceneGraph, live],
  );

  // Worked out off the main thread; an edit on the same part leaves the last
  // report standing until the new one is in, while switching parts clears it.
  const report = useDfmReport(effectiveScene, open ? lens : null, bench);
  // Only paid for while the section is expanded: sampling the scene again on
  // every keystroke for a section nobody opened is not free.
  const castReport = useDfmReport(effectiveScene, open && castOpen ? 'cast' : null, bench);

  // Run closes the panel: its findings are for the parts as they stand, and
  // they are about to move. Opening it again reads them where they stopped.
  const wasPlaying = useRef(isPlaying);
  useEffect(() => {
    if (isPlaying && !wasPlaying.current && useStore.getState().dfmEnabled) setDfmEnabled(false);
    wasPlaying.current = isPlaying;
  }, [isPlaying, setDfmEnabled]);

  const handleSelectFinding = (finding: DfmFinding) => {
    if (finding.nodeId) setSelectedNodeId(finding.nodeId);
    const next = activeFinding?.id === finding.id ? null : toFocusTarget(finding);
    setActiveDfmFinding(next);
  };

  const handleRunAction = (finding: DfmFinding, action: DfmAction) => {
    switch (action.kind) {
      case 'open_split': {
        const targetId = action.nodeId ?? finding.nodeId;
        if (targetId) setSelectedNodeId(targetId);
        window.dispatchEvent(new CustomEvent('physbox:open-fab', { detail: { modal: 'split' } }));
        break;
      }
      case 'apply_print_pose': {
        updateNode(
          action.nodeId,
          { printPose: { up: [...action.up] as [number, number, number], spin: action.spin } },
          true,
        );
        break;
      }
      case 'set_filament': {
        setFilament(action.filament);
        break;
      }
      case 'set_nozzle': {
        setPrinter({ ...printer, nozzleMm: action.nozzleMm });
        break;
      }
      case 'fit_stock': {
        setStock({
          ...stock,
          widthMm: action.widthMm,
          depthMm: action.depthMm,
          thicknessMm: action.thicknessMm,
        });
        break;
      }
      case 'open_fab': {
        if (finding.nodeId) setSelectedNodeId(finding.nodeId);
        window.dispatchEvent(
          new CustomEvent('physbox:open-fab', {
            detail: {
              modal: action.modal,
              ...(action.moldTab ? { moldTab: action.moldTab } : {}),
            },
          }),
        );
        break;
      }
      case 'open_edge_round': {
        const targetId = action.nodeId ?? finding.nodeId ?? selectedNodeId;
        if (targetId) {
          setSelectedNodeId(targetId);
          startEdgeRound(targetId);
          if (action.radiusMm !== undefined && Number.isFinite(action.radiusMm) && action.radiusMm > 0) {
            updateEdgeRoundDraft({ size: action.radiusMm / 1000 });
          }
        }
        break;
      }
      case 'thicken_boss': {
        const target = sceneGraph ? findNodeInTree(sceneGraph.nodes || [], action.nodeId) : null;
        if (target) {
          updateNode(action.nodeId, {
            hardwareSpec: {
              ...(target.hardwareSpec ?? {}),
              outerDiameterMm: action.outerDiameterMm,
            },
          });
        }
        break;
      }
    }
  };

  if (!dfmEnabled) return null;

  const clampedPos =
    panel.x !== null && panel.y !== null
      ? clampPanelPos(panel.x, panel.y, Math.min(480, viewport.w - 32), viewport.w, viewport.h)
      : null;

  const processDescriptor =
    lens === 'print'
      ? printer.process === 'resin'
        ? 'Resin print'
        : `${PROCESS_LABEL.print} in ${filamentSpec(filament).label}`
      : lens
        ? `${PROCESS_LABEL[lens]} in ${materialSpec(material).label}`
        : null;

  return (
    <div
      ref={panelRef}
      style={{
        position: 'absolute',
        zIndex: 25,
        // Bottom left until someone moves it: out of the way of the model, and
        // beside the bench controls whose choices it is reporting on.
        ...(clampedPos === null
          ? { left: 16, bottom: 16 }
          : { left: clampedPos.x, top: clampedPos.y }),
        width: 'min(30rem, calc(100vw - 2rem))',
        touchAction: 'none',
      }}
      className="overflow-hidden rounded-2xl border border-slate-200 bg-white/95 shadow-2xl backdrop-blur-md dark:border-slate-800 dark:bg-slate-900/95"
    >
      <div
        className="flex cursor-move select-none items-center gap-2 border-b border-slate-100 bg-slate-50/80 px-3 py-2 dark:border-slate-800 dark:bg-slate-950/40"
        onPointerDown={onTitlePointerDown}
      >
        <Ruler className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="truncate text-xs font-semibold text-slate-700 dark:text-slate-300">
          DFM: {selectedName ?? (checkAllAsPlate ? 'all parts' : 'scene')}
          {lens && !report && !panel.minimized && (
            <span className="ml-1.5 font-normal italic text-slate-400 dark:text-slate-500">Analyzing…</span>
          )}
          {lens && report && processDescriptor && (
            <> · {processDescriptor}</>
          )}
        </span>
        {lens && report && !report.needsPartSelection && (
          <span className={`text-xs font-bold tabular-nums ${scoreTone(report.score)}`}>{report.score}</span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <button
            onClick={() => setPanel({ minimized: !panel.minimized })}
            className="rounded p-0.5 transition-colors hover:bg-slate-200 dark:hover:bg-slate-800"
            title={panel.minimized ? 'Expand' : 'Minimize'}
            aria-label={panel.minimized ? 'Expand DFM panel' : 'Minimize DFM panel'}
          >
            {panel.minimized
              ? <ChevronDown className="h-3 w-3 text-slate-500 dark:text-slate-400" />
              : <ChevronUp className="h-3 w-3 text-slate-500 dark:text-slate-400" />}
          </button>
          <button
            onClick={() => {
              clearDfmFocus();
              setDfmEnabled(false);
            }}
            className="rounded p-0.5 transition-colors hover:bg-red-100 dark:hover:bg-red-950/40"
            title="Close"
            aria-label="Close DFM panel"
          >
            <X className="h-3 w-3 text-slate-500 hover:text-red-500 dark:text-slate-400" />
          </button>
        </div>
      </div>

      {!panel.minimized && (
        <div className="max-h-[40vh] overflow-y-auto px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <p className="truncate text-[10px] text-slate-400">
              {castOpen && castReport ? castReport.legend : report?.legend}
            </p>
            {report?.judgedPoseLabel && !castOpen && (
              <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">
                {report.judgedPoseLabel}
              </span>
            )}
          </div>

          {!selectedNodeId && checkAllAsPlate && (
            <div className="mb-2 flex items-center justify-between rounded bg-slate-50 px-2 py-1 text-[10px] text-slate-500 dark:bg-slate-800/50 dark:text-slate-400">
              <span>Checking all parts as a plate</span>
              <button
                type="button"
                onClick={() => setDfmCheckAllAsPlate(false)}
                className="cursor-pointer font-semibold text-amber-600 hover:underline dark:text-amber-400"
              >
                Per-part mode
              </button>
            </div>
          )}

          {/* A laser has no Z depth, so overhang, undercut and reach mean
              nothing to it. Better no answer than a confident one from the
              wrong lens — and casting below is still worth offering. */}
          {!lens && (
            <p className="py-1 text-xs text-slate-500 dark:text-slate-400">
              DFM covers the printer and the router. There is no laser check yet.
            </p>
          )}

          {lens && !report && (
            <p className="py-1 text-xs italic text-slate-400 dark:text-slate-500">Analyzing…</p>
          )}

          {lens && report && (
            <ReportBody
              report={report}
              activeId={activeFinding?.id ?? null}
              onSelectFinding={handleSelectFinding}
              onRunAction={handleRunAction}
            />
          )}

          {live && (
            <p className="mt-2 text-[10px] leading-snug text-slate-400">
              Judged where the sim has put the parts. Reset to judge them as drawn.
            </p>
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
            {castOpen && castReport && !castReport.needsPartSelection && (
              <span className={`ml-auto text-xs font-bold tabular-nums ${scoreTone(castReport.score)}`}>
                {castReport.score}
              </span>
            )}
          </button>

          {castOpen && castReport && (
            <div className="mt-2">
              <ReportBody
                report={castReport}
                activeId={activeFinding?.id ?? null}
                onSelectFinding={handleSelectFinding}
                onRunAction={handleRunAction}
              />
              <p className="mt-2 text-[10px] leading-snug text-slate-400">
                Judged against a flat two-part parting line across all six draw axes and heights. Undercuts only lock a
                rigid draw mould — a dissolvable liner, silicone pour box, or lost-PLA burnout keeps them.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
