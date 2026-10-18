import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  Download,
  FileText,
  Hammer,
  Layers,
  Loader2,
  Play,
  Puzzle,
  Scissors,
  X,
} from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { useSettled } from '../hooks/useSettled';
import { loadManifold } from '../utils/sculptCut';
import { collectIndividualPartSoups } from '../utils/timberBreakdown';
import {
  DEFAULT_TIMBER_JOINERY_OPTIONS,
  synthesizeTimberJoinery,
  type TenonCornerFit,
  type TimberBreakdownOutcome,
  type TimberEdgeProfile,
  type TimberJoineryOptions,
  type TimberJointMode,
} from '../utils/timberJoinery';
import { buildTimberCutPlan, type CncWindowSetup, type TimberCutPlan } from '../utils/timberCutList';
import { downloadBlob } from '../utils/downloadBlob';
import { utf8, zipStore } from '../utils/zipStore';
import { webSerialManager } from '../utils/webSerialManager';
import type { SceneNode } from '../types/scene';
import { Advanced, Field, Segmented, inputClass, sectionClass, sectionTitleClass } from './ExportFields';
import { AssemblyPreview, type PreviewSection } from './scene/AssemblyPreview';

const PREVIEW_COLOURS = [
  [0.78, 0.56, 0.34],
  [0.36, 0.55, 0.85],
  [0.4, 0.72, 0.5],
  [0.92, 0.6, 0.25],
  [0.78, 0.45, 0.72],
  [0.85, 0.78, 0.35],
  [0.35, 0.7, 0.75],
  [0.55, 0.5, 0.85],
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

const JOINT_MODE_OPTIONS = [
  ['mortise_tenon', 'Mortise & Tenon'],
  ['dowel', 'Twin Dowels'],
  ['dado', 'Dado / Housing'],
] as const;

const CORNER_FIT_OPTIONS = [
  ['dogbone', 'Dogbone (Bandsaw Tenon)'],
  ['round_tenon', 'Rounded Tenon (CNC Both)'],
  ['chisel_square', 'Square (Hand Chisel)'],
] as const;

const EDGE_PROFILE_OPTIONS = [
  ['roundover', 'Stopped Roundover'],
  ['chamfer', 'Stopped Chamfer'],
  ['square', 'Square Edges'],
] as const;

const TENON_METHOD_OPTIONS = [
  ['bandsaw', 'Bandsaw (4 Fence Cuts)'],
  ['cnc', 'CNC Router'],
] as const;

export const TimberBreakdownModal: React.FC<{ isOpen: boolean; onClose: () => void }> = ({ isOpen, onClose }) => {
  useEscapeToClose(isOpen, onClose);
  const sceneGraph = useStore((s) => s.sceneGraph);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const extraSelectedIds = useStore((s) => s.extraSelectedIds);
  const stock = useStore((s) => s.stock);
  const splitBodyForPrint = useStore((s) => s.splitBodyForPrint);

  const [joineryOpts, setJoineryOpts] = useState<Required<TimberJoineryOptions>>(DEFAULT_TIMBER_JOINERY_OPTIONS);
  const setOpt = <K extends keyof Required<TimberJoineryOptions>>(key: K, value: Required<TimberJoineryOptions>[K] | undefined) => {
    if (value === undefined) return;
    setJoineryOpts((prev) => ({ ...prev, [key]: value }));
  };

  const [stockLengthMm, setStockLengthMm] = useState(1800);
  const [explodeMm, setExplodeMm] = useState(32);
  const [isolatedPartIdx, setIsolatedPartIdx] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'cards' | 'bom' | 'glue'>('cards');
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TimberBreakdownOutcome | null>(null);

  // Target multi-selection, a multi-part assembly node, or all root nodes in the scene
  // so clicking a single leg or rail before opening Joinery still includes its mating parts.
  const targetIds = useMemo(() => {
    if (selectedNodeId && extraSelectedIds.length > 0) return [selectedNodeId, ...extraSelectedIds];
    if (selectedNodeId) {
      const selNode = findNode(sceneGraph.nodes, selectedNodeId);
      const userGeomCount = selNode?.geoms?.filter((g) => !g.csgDerived && g.role !== 'collision').length ?? 0;
      const isAssemblyNode = !!selNode && ((selNode.children?.length ?? 0) > 1 || userGeomCount > 1);
      if (isAssemblyNode) return [selectedNodeId];
    }
    return sceneGraph.nodes.map((n) => n.id);
  }, [selectedNodeId, extraSelectedIds, sceneGraph.nodes]);

  const primaryNode = useMemo(
    () => findNode(sceneGraph.nodes, targetIds[0] ?? null),
    [sceneGraph.nodes, targetIds],
  );

  const collected = useMemo(
    () => (isOpen && targetIds.length ? collectIndividualPartSoups(sceneGraph, targetIds) : { items: [], absorbed: [] }),
    [isOpen, sceneGraph, targetIds],
  );

  const settledOpts = useSettled(joineryOpts, 250);

  useEffect(() => {
    if (!isOpen || !collected.items.length) {
      setOutcome(null);
      return;
    }
    let cancelled = false;
    setBusy(true);
    void loadManifold()
      .then((wasm) => {
        if (cancelled) return;
        const soups = collected.items.map((it) => it.soup);
        const res = synthesizeTimberJoinery(wasm, soups, settledOpts);
        if (!cancelled) {
          setOutcome(res);
          setBusy(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setOutcome({ ok: false, error: err instanceof Error ? err.message : String(err) });
          setBusy(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, collected, settledOpts]);

  const breakdown = outcome?.ok ? outcome : null;

  const cutPlan: TimberCutPlan | null = useMemo(() => {
    if (!breakdown) return null;
    return buildTimberCutPlan(breakdown, {
      cncBedMm: [stock.widthMm, stock.depthMm, Math.max(40, stock.thicknessMm * 2)],
      defaultStockLengthMm: stockLengthMm,
    });
  }, [breakdown, stock.widthMm, stock.depthMm, stock.thicknessMm, stockLengthMm]);

  const previewSections: PreviewSection[] = useMemo(() => {
    if (!breakdown) return [];
    return breakdown.parts
      .filter((_, idx) => isolatedPartIdx === null || idx === isolatedPartIdx)
      .map((p, idx) => ({
        positions: p.section.positions,
        faces: p.section.faces,
        explode: isolatedPartIdx !== null ? [0, 0, 0] : p.section.explode,
        colour: PREVIEW_COLOURS[(isolatedPartIdx ?? idx) % PREVIEW_COLOURS.length],
        pose: { up: p.section.up, spin: p.section.spin },
      }));
  }, [breakdown, isolatedPartIdx]);

  if (!isOpen) return null;

  const handleDownloadGuide = () => {
    if (!cutPlan) return;
    const base = primaryNode?.name || 'timber_project';
    downloadBlob(new Blob([cutPlan.buildGuideMarkdown], { type: 'text/markdown;charset=utf-8' }), `${base}_build_guide.md`);
  };

  const handleDownloadSetup = (setup: CncWindowSetup) => {
    downloadBlob(new Blob([setup.gcode], { type: 'text/plain;charset=utf-8' }), setup.fileName);
  };

  const handleSendSetupToMachine = (setup: CncWindowSetup) => {
    void webSerialManager.runJob(setup.gcode);
  };

  const handleDownloadAllZip = () => {
    if (!cutPlan) return;
    const base = primaryNode?.name || 'timber_project';
    const entries = [
      { path: 'BUILD_GUIDE.md', data: utf8(cutPlan.buildGuideMarkdown) },
      ...cutPlan.allCncSetups.map((s) => ({
        path: `cnc/${s.fileName}`,
        data: utf8(s.gcode),
      })),
    ];
    const bytes = zipStore(entries);
    downloadBlob(new Blob([bytes as unknown as BlobPart], { type: 'application/zip' }), `${base}_joinery_kit.zip`);
  };

  const handleApplyToScene = () => {
    if (!breakdown || !primaryNode) return;
    const names = breakdown.parts.map((p) => p.member.id);
    splitBodyForPrint(primaryNode.id, breakdown.sections, collected.absorbed, {
      plain: false,
      names,
      centerOrigin: true,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-lg">
              <Hammer className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Timber Joinery &amp; Cut-List Breakdown
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Break down a table, chair, or flower stand into mortise-and-tenon parts, stopped edge roundovers, and a beginner-proof Bandsaw + CNC build guide
              </p>
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-clip p-4 sm:p-6 space-y-5">
          {!primaryNode || !collected.items.length ? (
            <p className="text-sm text-slate-500 dark:text-slate-400">
              Add or select a table, chair, or frame body first, then open Joinery Breakdown.
            </p>
          ) : (
            <>
              {/* Joinery & Edge Profile Controls */}
              <div className={sectionClass}>
                <h3 className={sectionTitleClass}>Joinery &amp; Edge Profiles</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <Field label="Joint Style" hint="Mortise & Tenon gives maximum anti-racking stability for tables, chairs, and tall stands.">
                    <Segmented
                      value={joineryOpts.jointMode}
                      onChange={(v) => setOpt('jointMode', v as TimberJointMode)}
                      options={JOINT_MODE_OPTIONS}
                    />
                  </Field>
                  <Field label="Corner Fit (Zero-Chisel)" hint="Dogbones inside the mortise let a square bandsawn tenon drop straight in and are hidden behind the rail's shoulder.">
                    <Segmented
                      value={joineryOpts.tenonCornerFit}
                      onChange={(v) => setOpt('tenonCornerFit', v as TenonCornerFit)}
                      options={CORNER_FIT_OPTIONS}
                    />
                  </Field>
                  <Field label="Tenon Cutting" hint="Straight tenons cut fastest on a bandsaw (4 fence cuts); angled chair/stand shoulders automatically switch to CNC.">
                    <Segmented
                      value={joineryOpts.tenonCutMethod}
                      onChange={(v) => setOpt('tenonCutMethod', v as 'bandsaw' | 'cnc')}
                      options={TENON_METHOD_OPTIONS}
                    />
                  </Field>
                  <Field label="Exposed Edge Profile" hint="Stops automatically before every mortise and joint shoulder so mating faces stay dead flat.">
                    <Segmented
                      value={joineryOpts.edgeProfile}
                      onChange={(v) => setOpt('edgeProfile', v as TimberEdgeProfile)}
                      options={EDGE_PROFILE_OPTIONS}
                    />
                  </Field>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 pt-2">
                  <Field label="End Mill Ø (mm)" hint="CNC router flat bit diameter used for mortises and dogbone corners.">
                    <NumberInput
                      step={0.5}
                      min={3}
                      max={16}
                      value={joineryOpts.cutterDiaMm}
                      onChange={(v) => setOpt('cutterDiaMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Tenon Length (mm)" hint="How deep the tenon reaches into the leg (auto-mitred at 45° when two corner rails meet).">
                    <NumberInput
                      step={1}
                      min={10}
                      max={50}
                      value={joineryOpts.tenonLengthMm}
                      onChange={(v) => setOpt('tenonLengthMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Shoulder (mm)" hint="Shoulder setback around the tenon that seats against the leg to prevent racking.">
                    <NumberInput
                      step={0.5}
                      min={2}
                      max={15}
                      value={joineryOpts.shoulderMm}
                      onChange={(v) => setOpt('shoulderMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Edge Radius (mm)" hint="Radius of the stopped roundover or chamfer along legs and rails.">
                    <NumberInput
                      step={0.5}
                      min={0}
                      max={15}
                      value={joineryOpts.edgeRadiusMm}
                      onChange={(v) => setOpt('edgeRadiusMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Stock Bar Len (mm)" hint="Standard timber board/bar length you are buying (e.g. 1800 mm = 6 ft, 2400 mm = 8 ft).">
                    <NumberInput
                      step={100}
                      min={600}
                      max={4800}
                      value={stockLengthMm}
                      onChange={(v) => v !== undefined && setStockLengthMm(v)}
                      className={inputClass}
                    />
                  </Field>
                </div>

                <Advanced>
                  <Field className="lg:col-span-2" label="Joint Clearance (mm)" hint="Side clearance added to mortises for a firm hand-push fit with PVA wood glue (default 0.15 mm).">
                    <NumberInput
                      step={0.05}
                      min={0}
                      max={1}
                      value={joineryOpts.clearanceMm}
                      onChange={(v) => setOpt('clearanceMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field className="lg:col-span-2" label="Stop Margin (mm)" hint="Distance before each mortise or shoulder where the edge roundover stops so the joint lands on a flat square face.">
                    <NumberInput
                      step={1}
                      min={4}
                      max={30}
                      value={joineryOpts.stopMarginMm}
                      onChange={(v) => setOpt('stopMarginMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field className="lg:col-span-2" label="Max Single Board Width (mm)" hint="Tabletops wider than this are split along the grain into edge-glued planks with alignment dowels.">
                    <NumberInput
                      step={10}
                      min={80}
                      max={600}
                      value={joineryOpts.maxBoardWidthMm}
                      onChange={(v) => setOpt('maxBoardWidthMm', v)}
                      className={inputClass}
                    />
                  </Field>
                </Advanced>
              </div>

              {/* 3D Exploded Preview & Part Isolation */}
              <div className={sectionClass}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <h3 className={sectionTitleClass}>3D Joinery Preview</h3>
                    {breakdown && (
                      <div className="flex flex-wrap items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setIsolatedPartIdx(null)}
                          className={`px-2 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
                            isolatedPartIdx === null
                              ? 'bg-amber-500 text-white'
                              : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          All ({breakdown.parts.length})
                        </button>
                        {breakdown.parts.map((p, idx) => (
                          <button
                            key={p.member.id}
                            type="button"
                            onClick={() => setIsolatedPartIdx(idx)}
                            className={`px-2 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors ${
                              isolatedPartIdx === idx
                                ? 'bg-amber-500 text-white'
                                : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700'
                            }`}
                          >
                            {p.member.id}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {isolatedPartIdx === null && (
                    <label className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                      Pull Apart
                      <input
                        type="range"
                        min={0}
                        max={80}
                        step={1}
                        value={explodeMm}
                        onChange={(e) => setExplodeMm(Number(e.target.value))}
                        className="w-28 accent-amber-500"
                      />
                    </label>
                  )}
                </div>

                <AssemblyPreview
                  sections={previewSections}
                  pins={[]}
                  explodeMm={isolatedPartIdx === null ? explodeMm : 0}
                  replay={null}
                />

                {busy && (
                  <p className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" /> Synthesizing timber members, mortises, tenons, and stopped edge profiles…
                  </p>
                )}
                {!busy && outcome && !outcome.ok && (
                  <p className="text-[11px] text-red-600 dark:text-red-400">{outcome.error}</p>
                )}
                {!busy && breakdown && cutPlan && (
                  <div className="space-y-1">
                    <p className="font-mono text-[11px] text-slate-800 dark:text-slate-100">
                      {breakdown.parts.length} timber part{breakdown.parts.length === 1 ? '' : 's'} ·{' '}
                      {breakdown.joints.length} structural joint{breakdown.joints.length === 1 ? '' : 's'} ·{' '}
                      {cutPlan.stockBars.length} stock bar{cutPlan.stockBars.length === 1 ? '' : 's'} ·{' '}
                      {cutPlan.allCncSetups.length} CNC window setup{cutPlan.allCncSetups.length === 1 ? '' : 's'} (for {stock.widthMm}×{stock.depthMm} mm bed)
                    </p>
                    {breakdown.warnings.map((w, i) => (
                      <p key={i} className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /> {w}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              {/* Shop Sheet & Per-Part Fabrication Cards */}
              {cutPlan && (
                <div className={sectionClass}>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
                    <div className="flex items-center gap-1.5">
                      {(
                        [
                          ['cards', `Per-Part Build Cards (${cutPlan.partCards.length})`, Scissors],
                          ['bom', `Stock BOM & Orientation Map (${cutPlan.stockBars.length} Bars)`, Layers],
                          ['glue', 'Two-Stage Glue-Up Guide', CheckCircle2],
                        ] as const
                      ).map(([tabKey, label, Icon]) => (
                        <button
                          key={tabKey}
                          type="button"
                          onClick={() => setActiveTab(tabKey)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
                            activeTab === tabKey
                              ? 'bg-amber-500 text-white'
                              : 'bg-slate-200/70 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300/70 dark:hover:bg-slate-700'
                          }`}
                        >
                          <Icon className="w-3.5 h-3.5" />
                          <span>{label}</span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {activeTab === 'cards' && (
                    <div className="space-y-4 pt-2">
                      {cutPlan.partCards.map((card) => (
                        <div
                          key={card.partId}
                          className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-3.5 space-y-2.5"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                            <div>
                              <span className="font-bold text-xs sm:text-sm text-slate-800 dark:text-slate-100">
                                Part {card.partIndex + 1}: {card.partTitle}
                              </span>
                              {card.mirrorOf && (
                                <span className="ml-2 px-2 py-0.5 rounded bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 text-[10px] font-mono">
                                  Mirror pair of {card.mirrorOf}
                                </span>
                              )}
                              <p className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                                Finished: {card.finishedDimsMm[0]} × {card.finishedDimsMm[1]} × {card.finishedDimsMm[2]} mm
                                {card.role === 'rail' ? ` (Shoulder-to-shoulder: ${card.shoulderToShoulderMm} mm)` : ''} · Rough Cut:{' '}
                                {card.roughBlankDimsMm[0]} × {card.roughBlankDimsMm[1]} × {card.roughBlankDimsMm[2]} mm from {card.stockBarRef}
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setIsolatedPartIdx(isolatedPartIdx === card.partIndex ? null : card.partIndex)}
                              className="px-2.5 py-1 rounded text-[11px] font-semibold border border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 cursor-pointer"
                            >
                              {isolatedPartIdx === card.partIndex ? 'Show All in 3D' : 'Isolate in 3D'}
                            </button>
                          </div>

                          <div className="rounded bg-amber-50/70 dark:bg-amber-950/30 border border-amber-200/70 dark:border-amber-800/50 px-2.5 py-1.5 text-[11px] text-amber-900 dark:text-amber-200">
                            <strong>Reference Faces (Mark with Pencil Triangle Δ):</strong> Face 1 = {card.face1Label} · Face 2 = {card.face2Label}
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px]">
                            <div className="space-y-1">
                              <p className="font-bold text-slate-700 dark:text-slate-200">1. Bandsaw Blank &amp; Tenon Cuts (Self-Cut)</p>
                              <ul className="list-disc pl-4 space-y-1 text-slate-600 dark:text-slate-300">
                                {card.bandsawSteps.map((s, k) => (
                                  <li key={k}>{s.replace(/\*\*/g, '')}</li>
                                ))}
                              </ul>
                            </div>

                            <div className="space-y-1">
                              <p className="font-bold text-slate-700 dark:text-slate-200">
                                {card.cncSetups.length ? '2. CNC Mortise & Slot Windows (While Square)' : '2. Tapers & Stopped Edge Profiles'}
                              </p>
                              {card.cncSetups.length > 0 ? (
                                <div className="space-y-2">
                                  {card.cncSetups.map((setup) => (
                                    <div
                                      key={setup.id}
                                      className="rounded border border-slate-200 dark:border-slate-800 p-2 bg-slate-50 dark:bg-slate-800/40 space-y-1"
                                    >
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="font-mono font-bold text-slate-800 dark:text-slate-100">
                                          {setup.fileName} (~{setup.estimatedMinutes} min)
                                        </span>
                                        <div className="flex items-center gap-1">
                                          <button
                                            type="button"
                                            onClick={() => handleDownloadSetup(setup)}
                                            className="flex items-center gap-1 px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 text-slate-800 dark:text-slate-100 text-[10px] font-semibold cursor-pointer"
                                            title="Download GRBL G-code (.nc) for this window setup"
                                          >
                                            <Download className="w-3 h-3" /> .nc
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => handleSendSetupToMachine(setup)}
                                            className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-[10px] font-semibold cursor-pointer"
                                            title="Stream this window setup directly to the connected CNC router"
                                          >
                                            <Play className="w-3 h-3" /> Run
                                          </button>
                                        </div>
                                      </div>
                                      <ul className="list-disc pl-4 text-[10px] text-slate-600 dark:text-slate-300 space-y-0.5">
                                        {setup.workholdingNotes.map((n, idx) => (
                                          <li key={idx}>{n.replace(/\*\*/g, '')}</li>
                                        ))}
                                        {setup.operationsSummary.map((o, idx) => (
                                          <li key={`op_${idx}`} className="text-emerald-700 dark:text-emerald-400">
                                            {o}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <ul className="list-disc pl-4 space-y-1 text-slate-600 dark:text-slate-300">
                                  {card.taperAndProfileSteps.map((s, k) => (
                                    <li key={k}>{s.replace(/\*\*/g, '')}</li>
                                  ))}
                                </ul>
                              )}
                            </div>
                          </div>

                          {card.cncSetups.length > 0 && (
                            <div className="pt-1 border-t border-slate-100 dark:border-slate-800 text-[11px]">
                              <p className="font-bold text-slate-700 dark:text-slate-200">
                                3. Tapers, Stopped Roundovers &amp; Push-Fit Check (After CNC Mortises)
                              </p>
                              <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                                {card.taperAndProfileSteps.map((s, k) => (
                                  <li key={k}>{s.replace(/\*\*/g, '')}</li>
                                ))}
                                {card.fitCheckSteps.map((s, k) => (
                                  <li key={`fit_${k}`}>{s.replace(/\*\*/g, '')}</li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {activeTab === 'bom' && (
                    <div className="space-y-4 pt-2 text-xs">
                      <div>
                        <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-2">
                          1D Timber Bar Nesting ({cutPlan.stockBars.length} Bar{cutPlan.stockBars.length === 1 ? '' : 's'})
                        </h4>
                        <div className="space-y-2">
                          {cutPlan.stockBars.map((bar) => (
                            <div
                              key={bar.barIndex}
                              className="rounded border border-slate-200 dark:border-slate-800 p-2.5 bg-white dark:bg-slate-900/60 space-y-1.5"
                            >
                              <div className="flex items-center justify-between font-mono text-[11px]">
                                <span className="font-bold text-slate-800 dark:text-slate-100">
                                  Bar #{bar.barIndex}: {bar.thicknessMm} × {bar.widthMm} × {bar.stockLengthMm} mm
                                </span>
                                <span className="text-slate-500">
                                  Used {bar.usedLengthMm} mm · Offcut {bar.offcutMm} mm ({bar.wastePercent}% waste)
                                </span>
                              </div>
                              <div className="w-full h-5 rounded bg-slate-200 dark:bg-slate-800 overflow-hidden flex">
                                {bar.cuts.map((c, idx) => (
                                  <div
                                    key={`${c.partId}_${idx}`}
                                    style={{ width: `${Math.max(4, (c.roughCutLengthMm / bar.stockLengthMm) * 100)}%` }}
                                    className="h-full bg-amber-500/80 border-r border-white dark:border-slate-900 flex items-center justify-center text-[9px] font-mono font-bold text-white truncate px-1"
                                    title={`${c.partId}: ${c.roughCutLengthMm} mm rough (${c.finishedLengthMm} mm finished)`}
                                  >
                                    {c.partId} ({c.roughCutLengthMm})
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div>
                        <h4 className="font-bold text-slate-800 dark:text-slate-100 mb-1.5">Hardware &amp; Shop Supplies</h4>
                        <ul className="list-disc pl-5 space-y-1 text-slate-600 dark:text-slate-300">
                          {cutPlan.hardwareBom.map((h, i) => (
                            <li key={i}>
                              <strong>
                                {h.quantity}× {h.item}
                              </strong>{' '}
                              — {h.note}
                            </li>
                          ))}
                        </ul>
                      </div>

                      {cutPlan.birdsEyeMapMarkdown && (
                        <div>
                          <pre className="p-3 rounded-lg bg-slate-900 text-amber-300 font-mono text-[11px] overflow-x-auto leading-snug">
                            {cutPlan.birdsEyeMapMarkdown}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}

                  {activeTab === 'glue' && (
                    <div className="pt-2">
                      <pre className="whitespace-pre-wrap font-sans text-xs text-slate-700 dark:text-slate-200 leading-relaxed bg-white dark:bg-slate-900/60 p-4 rounded-lg border border-slate-200 dark:border-slate-800">
                        {cutPlan.glueUpGuideMarkdown}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden lg:flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <Cpu className="w-3.5 h-3.5 text-amber-500" />
            <span>
              CNC windows sized for {stock.widthMm} × {stock.depthMm} mm bed · Apply puts the mortised &amp; tenoned parts into the scene.
            </span>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
            <button
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
            >
              Close
            </button>
            <button
              onClick={handleDownloadGuide}
              disabled={!cutPlan || busy}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors cursor-pointer"
              title="Download the beginner-proof Markdown Build Guide with BOM, Corner Map, and Per-Part Checklists"
            >
              <FileText className="w-4 h-4" />
              <span>Build Guide (.md)</span>
            </button>
            <button
              onClick={handleDownloadAllZip}
              disabled={!cutPlan || busy}
              className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-amber-500/40 text-amber-700 dark:text-amber-300 hover:bg-amber-500/10 disabled:opacity-40 transition-colors cursor-pointer"
              title="Download ZIP containing BUILD_GUIDE.md and all CNC window G-code (.nc) files"
            >
              <Download className="w-4 h-4" />
              <span>All CNC + Guide (.zip)</span>
            </button>
            <button
              onClick={handleApplyToScene}
              disabled={!breakdown || busy}
              className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
              title="Replace the model in the scene with the individual mortised legs and tenoned rails (one undo step)"
            >
              <Puzzle className="w-4 h-4" />
              <span>Apply Joinery to Scene</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

