import React, { useEffect, useMemo, useRef, useState } from 'react';
import { X, Puzzle, Loader2, CheckCircle2, XCircle, AlertTriangle, FlaskConical } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { useSettled } from '../hooks/useSettled';
import { filamentSpec } from '../utils/filaments';
import { MIN_PRINT_BED_MM, MAX_PRINT_BED_MM, DEFAULT_PRINT_BED } from '../utils/printBedSettings';
import { DEFAULT_JOINERY, type Joinery, type JoineryKind } from '../utils/printSplit';
import {
  selectionSoups, prewarmPrintSplit, splitOffThread, testAssemblyOffThread, type SplitOk, type SplitOutcome,
} from '../utils/printSplitClient';
import type { AssemblyPlan, StageResult } from '../utils/printAssembly';
import type { Vec3 } from '../utils/printPlate';
import type { SceneNode } from '../types/scene';
import { Advanced, Field, Segmented, inputClass, sectionClass, sectionTitleClass } from './ExportFields';
import { AssemblyPreview, type PreviewSection } from './scene/AssemblyPreview';

/** The same palette the store gives the applied sections, so the preview matches. */
const PREVIEW_COLOURS = [
  [0.36, 0.55, 0.85], [0.92, 0.6, 0.25], [0.4, 0.72, 0.5], [0.78, 0.45, 0.72],
  [0.85, 0.78, 0.35], [0.35, 0.7, 0.75], [0.7, 0.55, 0.42], [0.55, 0.5, 0.85],
];

function findNode(nodes: SceneNode[], id: string | null): SceneNode | null {
  if (!id) return null;
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNode(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

const JOINERY_OPTIONS = [['none', 'None'], ['dowel', 'Dowel Holes'], ['peg', 'Printed Pegs']] as const;

/**
 * Split for Print: cut the selected body into sections that fit the printer,
 * each turned the way up that needs the least support, with dowel holes or
 * printed pegs on the cut faces to line them up again.
 *
 * The search re-runs as the settings change, in a worker. Test Assembly puts
 * the result back together in MuJoCo, joint by joint, and Apply replaces the
 * body in the scene with its sections — one undo step.
 */
export const SplitForPrintModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  useEscapeToClose(isOpen, onClose);
  const sceneGraph = useStore((s) => s.sceneGraph);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const printBed = useStore((s) => s.printBed);
  const setPrintBed = useStore((s) => s.setPrintBed);
  const filament = useStore((s) => s.filament);
  const splitBodyForPrint = useStore((s) => s.splitBodyForPrint);

  const [marginMm, setMarginMm] = useState(5);
  const [joinery, setJoinery] = useState<Joinery>(DEFAULT_JOINERY);
  const setJ = <K extends keyof Joinery>(key: K, value: Joinery[K] | undefined) => {
    if (value === undefined) return;
    setJoinery((prev) => ({ ...prev, [key]: value }));
  };
  const [explodeMm, setExplodeMm] = useState(20);
  // What came back, and for which request: a request with no answer yet is
  // the search still running, and the last answer stays up meanwhile.
  const [landed, setLanded] = useState<{ request: object; outcome: SplitOutcome } | null>(null);
  // An assembly test belongs to the split it tested; a new split retires it.
  const [assemblyState, setAssembly] = useState<{ forSplit: SplitOk; plan: AssemblyPlan; results: StageResult[]; running: boolean; error?: string } | null>(null);
  const [replayRange, setReplayRange] = useState<{ from: number; to: number } | null>(null);

  // The body as it is when the dialog opens. Picked up again if the
  // selection changes underneath it.
  const node = useMemo(() => findNode(sceneGraph.nodes, selectedNodeId), [sceneGraph, selectedNodeId]);
  const extraSelectedIds = useStore((s) => s.extraSelectedIds);
  const part = useMemo(
    () => (isOpen && node ? selectionSoups(sceneGraph, [node.id, ...extraSelectedIds]) : { soups: [], absorbed: [] }),
    [isOpen, node, sceneGraph, extraSelectedIds],
  );
  const soups = part.soups;

  useEffect(() => { if (isOpen) prewarmPrintSplit(); }, [isOpen]);

  // One object per real change: useSettled waits on identity, and a fresh
  // object each render would never settle.
  const options = useMemo(
    () => ({ printBed, marginMm, joinery, overhangDeg: filamentSpec(filament).maxOverhangDeg }),
    [printBed, marginMm, joinery, filament],
  );
  const settled = useSettled(options, 300);
  const request = useMemo(() => ({ soups, settled }), [soups, settled]);
  const run = useRef<object | null>(null);
  useEffect(() => {
    if (!isOpen || !request.soups.length) return;
    run.current = request;
    void splitOffThread(request.soups, {
      bed: request.settled.printBed,
      marginMm: request.settled.marginMm,
      overhangDeg: request.settled.overhangDeg,
      joinery: request.settled.joinery,
    }).then((outcome) => {
      if (run.current === request) setLanded({ request, outcome });
    });
  }, [isOpen, request]);
  const outcome = landed?.outcome ?? null;
  const busy = isOpen && soups.length > 0 && landed?.request !== request;

  const split: SplitOk | null = outcome?.result.ok ? outcome.result : null;
  const assembly = assemblyState && assemblyState.forSplit === split ? assemblyState : null;
  const previewSections: PreviewSection[] = useMemo(() => (split?.sections ?? []).map((s, i) => ({
    positions: s.positions,
    faces: s.faces,
    explode: s.explode,
    colour: PREVIEW_COLOURS[i % PREVIEW_COLOURS.length],
    pose: { up: s.up, spin: s.spin },
  })), [split]);
  const pins: Vec3[] = useMemo(() => (split?.joints ?? []).flatMap((j) => j.pins), [split]);

  const dowelShape = useMemo(
    () => ({ radius: joinery.diameterMm / 2000, length: joinery.lengthMm / 1000 }),
    [joinery.diameterMm, joinery.lengthMm],
  );
  // Every stage, so the replay can show what earlier stages put together.
  const replayStages = useMemo(() => (assembly && !assembly.running
    ? assembly.plan.stages.map(({ scene: _scene, ...stage }, k) => {
      void _scene;
      return { stage, frames: assembly.results[k]?.frames ?? [] };
    })
    : null), [assembly]);
  const replay = useMemo(
    () => (replayStages && replayRange ? { stages: replayStages, ...replayRange } : null),
    [replayStages, replayRange],
  );

  if (!isOpen) return null;

  const supportCm2 = (split?.sections ?? []).reduce((a, s) => a + s.supportMm2, 0) / 100;
  const misfits = (split?.sections ?? []).filter((s) => !s.fits).length;
  const checks = outcome?.checks ?? null;

  const handleTest = () => {
    if (!split) return;
    setAssembly({ forSplit: split, plan: { stages: [] }, results: [], running: true });
    setReplayRange(null);
    void testAssemblyOffThread(split, (_done, _total, result) => {
      setAssembly((prev) => (prev ? { ...prev, results: [...prev.results, result] } : prev));
    }).then(({ plan, results }) => {
      setAssembly({ forSplit: split, plan, results, running: false });
      // The whole build, stage after stage.
      if (results.length) setReplayRange({ from: 0, to: results.length - 1 });
    }).catch((err: unknown) => {
      setAssembly((prev) => ({ forSplit: split, plan: prev?.plan ?? { stages: [] }, results: prev?.results ?? [], running: false, error: err instanceof Error ? err.message : String(err) }));
    });
  };

  const handleApply = () => {
    if (!split || !node) return;
    splitBodyForPrint(node.id, split.sections, part.absorbed);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-lg">
              <Puzzle className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">Split for Print</h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                {node
                  ? `Cut ${extraSelectedIds.length ? `${node.name || node.id} and ${extraSelectedIds.length} more, as one part,` : node.name || node.id} into sections that fit the bed, each turned to print with the least support`
                  : 'Select a body to split'}
              </p>
            </div>
          </div>
          <button aria-label="Close" title="Close" onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-clip p-4 sm:p-6 space-y-5">
          {!node || !soups.length ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {!node ? 'Select the body you want to split, then open this again.' : 'This body has no solid geometry to split.'}
            </p>
          ) : (
            <>
              <div className={sectionClass}>
                <h3 className={sectionTitleClass}>Printer</h3>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  {([['widthMm', 'Bed Width (mm)', 'X size of the build plate.'],
                    ['depthMm', 'Bed Depth (mm)', 'Y size of the build plate.'],
                    ['heightMm', 'Max Height (mm)', 'How tall a print the gantry clears.']] as const).map(([key, label, hint]) => (
                    <Field key={key} label={label} hint={hint}>
                      <NumberInput
                        step={1} min={MIN_PRINT_BED_MM} max={MAX_PRINT_BED_MM}
                        fallbackOnBlur={DEFAULT_PRINT_BED[key]}
                        value={printBed[key]}
                        onChange={(v) => { if (v !== undefined && Number.isFinite(v)) setPrintBed({ [key]: v }); }}
                        className={inputClass}
                      />
                    </Field>
                  ))}
                  <Field label="Margin (mm)" hint="Kept clear round the edge of the bed, for the skirt and the brim.">
                    <NumberInput step={1} min={0} max={50} value={marginMm} onChange={(v) => v !== undefined && setMarginMm(v)} className={inputClass} />
                  </Field>
                </div>
              </div>

              <div className={sectionClass}>
                <h3 className={sectionTitleClass}>Joints</h3>
                <Segmented value={joinery.kind} onChange={(v) => setJ('kind', v as JoineryKind)} options={JOINERY_OPTIONS} />
                {joinery.kind !== 'none' && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    <Field label={joinery.kind === 'dowel' ? 'Dowel Ø (mm)' : 'Peg Ø (mm)'} hint={joinery.kind === 'dowel' ? 'The dowels you have. The holes are this plus the clearance.' : 'The printed peg. Its hole is this plus the clearance.'}>
                      <NumberInput step={0.5} min={2} max={20} value={joinery.diameterMm} onChange={(v) => setJ('diameterMm', v)} className={inputClass} />
                    </Field>
                    <Field label={joinery.kind === 'dowel' ? 'Dowel Length (mm)' : 'Peg Length (mm)'} hint={joinery.kind === 'dowel' ? 'Each side gets a hole half this deep, and a little more.' : 'Twice what the peg stands proud; the hole is half this deep and a little more.'}>
                      <NumberInput step={1} min={4} max={100} value={joinery.lengthMm} onChange={(v) => setJ('lengthMm', v)} className={inputClass} />
                    </Field>
                  </div>
                )}
                {joinery.kind !== 'none' && (
                  <Advanced>
                    <Field className="lg:col-span-2" label="Clearance (mm)" hint="How much bigger a hole is than what goes in it. 0.2 is a snug fit on most printers; open it up if yours prints holes small.">
                      <NumberInput step={0.05} min={0} max={1} value={joinery.clearanceMm} onChange={(v) => setJ('clearanceMm', v)} className={inputClass} />
                    </Field>
                    <Field className="lg:col-span-2" label="Min Wall (mm)" hint="Least material between a hole and the edge of the face. A face too narrow for that gets no pin, and is glued flat.">
                      <NumberInput step={0.5} min={0.5} max={10} value={joinery.minWallMm} onChange={(v) => setJ('minWallMm', v)} className={inputClass} />
                    </Field>
                  </Advanced>
                )}
              </div>

              <div className={sectionClass}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className={sectionTitleClass}>{replay ? 'Assembly Replay' : 'Sections'}</h3>
                  {!replay && (
                    <label className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      Pull Apart
                      <input type="range" min={0} max={80} step={1} value={explodeMm} onChange={(e) => setExplodeMm(Number(e.target.value))} className="w-28 accent-emerald-500" />
                    </label>
                  )}
                  {replay && (
                    <button type="button" onClick={() => setReplayRange(null)} className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer">
                      Back to Sections
                    </button>
                  )}
                </div>
                <AssemblyPreview
                  sections={previewSections}
                  pins={pins}
                  explodeMm={explodeMm}
                  replay={replay}
                  dowel={dowelShape}
                />
                {busy && (
                  <p className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Finding the cuts…
                  </p>
                )}
                {!busy && outcome && !outcome.result.ok && (
                  <p className="text-[11px] text-red-600 dark:text-red-400">{outcome.result.error}</p>
                )}
                {!busy && split && (
                  <div className="space-y-1">
                    <p className="font-mono text-[11px] text-slate-800 dark:text-slate-100">
                      {split.sections.length} section{split.sections.length === 1 ? '' : 's'} · {split.cuts.length} cut{split.cuts.length === 1 ? '' : 's'} · {supportCm2.toFixed(1)} cm² of support
                      {joinery.kind !== 'none' ? ` · ${pins.length} ${joinery.kind === 'dowel' ? 'dowel' : 'peg'}${pins.length === 1 ? '' : 's'}` : ''}
                    </p>
                    {split.sections.length === 1 && (
                      <p className="text-[11px] text-slate-500 dark:text-slate-400">It fits the bed already, so nothing is cut; Apply just records the best way up for the 3MF export.</p>
                    )}
                    {misfits > 0 && (
                      <p className="text-[11px] text-red-600 dark:text-red-400">{misfits} section{misfits === 1 ? '' : 's'} still do not fit the bed.</p>
                    )}
                    {checks && !checks.ok && (
                      <p className="text-[11px] text-red-600 dark:text-red-400">
                        The exact check failed: {checks.interferenceMm3 > 0.01 ? `sections overlap by ${checks.interferenceMm3.toFixed(1)} mm³` : ''}
                        {checks.reunionErrorMm3 > 0.01 ? ` the sections differ from the part by ${checks.reunionErrorMm3.toFixed(1)} mm³` : ''}
                        {checks.misalignedPins ? ` ${checks.misalignedPins} pin${checks.misalignedPins === 1 ? ' has' : 's have'} no partner` : ''}.
                      </p>
                    )}
                    {split.warnings.map((w, i) => (
                      <p key={i} className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /> {w}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              {assembly && (
                <div className={sectionClass}>
                  <div className="flex items-center justify-between gap-3">
                    <h3 className={sectionTitleClass}>Assembly Test</h3>
                    {!assembly.running && assembly.results.length > 0 && (
                      <button type="button" onClick={() => setReplayRange({ from: 0, to: assembly.results.length - 1 })}
                        className="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer">
                        Replay All
                      </button>
                    )}
                  </div>
                  {assembly.error && <p className="text-[11px] text-red-600 dark:text-red-400">{assembly.error}</p>}
                  <table className="w-full text-[11px] font-mono">
                    <thead>
                      <tr className="text-left text-slate-400">
                        <th className="font-semibold py-1 pr-2" />
                        <th className="font-semibold py-1 pr-2">Stage</th>
                        <th className="font-semibold py-1 pr-2">Seat</th>
                        <th className="font-semibold py-1 pr-2">Play</th>
                        <th className="font-semibold py-1 pr-2">Twist</th>
                        <th className="font-semibold py-1" />
                      </tr>
                    </thead>
                    <tbody>
                      {assembly.results.map((r, i) => (
                        <tr key={i} className={`border-t border-slate-200 dark:border-slate-800 align-top ${replayRange && replayRange.from <= i && i <= replayRange.to ? 'bg-emerald-500/5' : ''}`}>
                          <td className="py-1 pr-2">
                            {r.ok
                              ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                              : <XCircle className="w-3.5 h-3.5 text-red-500" />}
                          </td>
                          <td className="py-1 pr-2 text-slate-700 dark:text-slate-200">
                            {r.label}
                            {r.notes.map((n, k) => <div key={k} className="font-sans text-[10px] text-amber-700 dark:text-amber-400">{n}</div>)}
                          </td>
                          <td className="py-1 pr-2 whitespace-nowrap">{Number.isFinite(r.gapMm) ? `${r.gapMm.toFixed(2)} mm` : '—'}</td>
                          <td className="py-1 pr-2 whitespace-nowrap">{r.kind === 'join' ? (r.playMm === null ? (r.seated ? 'free' : '—') : `${r.playMm.toFixed(2)} mm`) : ''}</td>
                          <td className="py-1 pr-2 whitespace-nowrap">{r.kind === 'join' ? (r.twistDeg === null ? (r.seated ? 'free' : '—') : `${r.twistDeg.toFixed(2)}°`) : ''}</td>
                          <td className="py-1 text-right">
                            {!assembly.running && (
                              <button type="button" onClick={() => setReplayRange({ from: i, to: i })} className="text-emerald-600 dark:text-emerald-400 hover:underline cursor-pointer">Replay</button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {assembly.running && (
                    <p className="flex items-center gap-1.5 text-[11px] text-emerald-700 dark:text-emerald-300">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Putting it back together…
                    </p>
                  )}
                  <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                    Each joint is dropped together under gravity in MuJoCo, with pins and holes colliding as their exact shapes. Seat is how far short of its place it came to rest; play and twist are how far it moves when pushed. A plain cut slides freely — glue holds it.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden lg:flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            {split && misfits === 0 && checks?.ok !== false && (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                <span>Every section fits. Apply puts them in the scene; the 3MF export lays them out on the bed.</span>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
            <button onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors">
              Close
            </button>
            <button onClick={handleTest} disabled={!split || busy || split.cuts.length === 0 || assembly?.running}
              title="Put the sections back together in the physics engine, joint by joint, and measure how well they seat"
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg border border-emerald-500/40 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/10 disabled:opacity-40 transition-colors cursor-pointer">
              <FlaskConical className="w-4 h-4" />
              <span>Test Assembly</span>
            </button>
            <button onClick={handleApply} disabled={!split || busy}
              className="flex items-center gap-2 px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer">
              <Puzzle className="w-4 h-4" />
              <span>Apply</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
