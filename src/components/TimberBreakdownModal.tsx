import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Box,
  CheckCircle2,
  Cpu,
  Grid,
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
import { useExportJob } from '../utils/exportWorkerClient';
import {
  collectIndividualPartSoups,
  DEFAULT_TIMBER_PLANK_OPTIONS,
  packPartsLayFlatMetres,
  type GrainAxis,
  type PlankJointType,
  type TimberPlank,
  type TimberPlankBreakdownOutcome,
  type TimberPlankOptions,
} from '../utils/timberBreakdown';
import {
  DEFAULT_TIMBER_JOINERY_OPTIONS,
  type TenonCornerFit,
  type TimberBreakdownOutcome,
  type TimberEdgeProfile,
  type TimberJoineryOptions,
  type TimberJointMode,
} from '../utils/timberJoinery';
import type { CncWindowSetup, TimberCutPlan } from '../utils/timberCutList';
import type { SolidMachiningOptions } from '../utils/solidMachiningExporter';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import type { SceneGraph, SceneNode } from '../types/scene';
import type { Vec3 } from '../utils/printPlate';
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

function dominantAxisOf(v: Vec3): GrainAxis {
  const ax = Math.abs(v[0]), ay = Math.abs(v[1]), az = Math.abs(v[2]);
  if (ax >= ay && ax >= az) return 'x';
  if (ay >= ax && ay >= az) return 'y';
  return 'z';
}

const BREAKDOWN_MODE_OPTIONS = [
  ['auto', 'Auto'],
  ['frame', 'Frame (Legs & Rails)'],
  ['planks', 'Box / Planks'],
] as const;

const PLANK_JOINT_TYPE_OPTIONS = [
  ['glue', 'Glue'],
  ['butt', 'Dowels'],
  ['rabbet', 'Rabbet'],
  ['miter', '45° Miter'],
  ['finger', 'Finger / Box'],
] as const;

const HOLLOW_INTERIOR_OPTIONS = [
  ['hollow', 'Hollow Shell'],
  ['solid', 'Solid Layers'],
] as const;

const JOINT_MODE_OPTIONS = [
  ['butt', 'Glue'],
  ['dowel', 'Dowels'],
  ['mortise_tenon', 'Mortise & Tenon'],
  ['dado', 'Dado / Slot'],
] as const;

const USE_CNC_OPTIONS = [
  ['off', 'No (Shop Tools)'],
  ['on', 'Optional CNC'],
] as const;

const CORNER_FIT_OPTIONS = [
  ['dogbone', 'Dogbone (Saw Tenon)'],
  ['round_tenon', 'Rounded Tenon (CNC)'],
  ['chisel_square', 'Square (Chisel)'],
] as const;

const EDGE_PROFILE_OPTIONS = [
  ['roundover', 'Stopped Roundover'],
  ['chamfer', 'Stopped Chamfer'],
  ['square', 'Square Edges'],
] as const;

const TENON_METHOD_OPTIONS = [
  ['bandsaw', 'Saw (4 Straight Cuts)'],
  ['cnc', 'CNC Router'],
] as const;

const PLACEMENT_OPTIONS = [
  ['replace', 'Replace Body'],
  ['beside', 'Place Beside'],
] as const;

function describePlankSawCut(
  plank: TimberPlank,
  opts: Required<TimberPlankOptions>,
  cncBed: { widthMm: number; depthMm: number; heightMm: number },
): {
  sawSteps: string[];
  cncNote: string | null;
  exceedsCnc: boolean;
} {
  const [L, W, T] = plank.dimensionsMm;
  const sawSteps: string[] = [
    `Cut ${L} × ${W} × ${T} mm board (grain along ${plank.grainAxis.toUpperCase()}-axis).`,
  ];
  let cncNote: string | null = null;
  let exceedsCnc = false;

  if (opts.jointType === 'rabbet') {
    const rabbetDepth = +(T * 0.5).toFixed(1);
    sawSteps.push(`Cut ${rabbetDepth} × ${rabbetDepth} mm rabbet step along perimeter mating edges on table saw or router table.`);
  } else if (opts.jointType === 'miter') {
    sawSteps.push(`Bevel perimeter mating edges at 45° on table or miter saw.`);
  } else if (opts.jointType === 'finger') {
    const maxBedSpan = Math.max(cncBed.widthMm, cncBed.depthMm);
    const fitsCncEdge = W <= maxBedSpan && T <= cncBed.heightMm;
    exceedsCnc = !fitsCncEdge;
    cncNote = fitsCncEdge
      ? `Interlocking ${opts.fingerWidthMm} mm box-joint fingers along ${W} × ${T} mm edge (fits on ${cncBed.widthMm} × ${cncBed.depthMm} × ${cncBed.heightMm} mm CNC bed).`
      : `Interlocking ${opts.fingerWidthMm} mm box-joint fingers: ${W} × ${T} mm edge exceeds ${cncBed.widthMm} × ${cncBed.depthMm} × ${cncBed.heightMm} mm CNC bed — cut fingers with a table-saw or router box-joint jig.`;
  }

  if (plank.dowelHoles.length > 0) {
    sawSteps.push(
      `Drill ${plank.dowelHoles.length}× Ø${opts.dowelDiaMm} × ${plank.dowelHoles[0].depthMm} mm dowel holes on mating seam edges.`,
    );
  }

  return { sawSteps, cncNote, exceedsCnc };
}

export interface TimberBreakdownModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Optional legacy callback kept for prop compatibility. */
  onMachinePlank?: (plankScene: SceneGraph, seed?: Partial<SolidMachiningOptions>) => void;
}

export const TimberBreakdownModal: React.FC<TimberBreakdownModalProps> = ({
  isOpen,
  onClose,
}) => {
  useEscapeToClose(isOpen, onClose);
  const sceneGraph = useStore((s) => s.sceneGraph);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const extraSelectedIds = useStore((s) => s.extraSelectedIds);
  const cncBed = useStore((s) => s.cncBed);
  const setMachineConfigOpen = useStore((s) => s.setMachineConfigOpen);
  const splitBodyForPrint = useStore((s) => s.splitBodyForPrint);
  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());
  useEffect(() => webSerialManager.addListener(setMachineState), []);

  const [modeSetting, setModeSetting] = useState<'auto' | 'planks' | 'frame'>('auto');
  const [useCnc, setUseCnc] = useState<'off' | 'on'>('on');
  const [plankOpts, setPlankOpts] = useState<Required<TimberPlankOptions>>(DEFAULT_TIMBER_PLANK_OPTIONS);
  const setPlankOpt = <K extends keyof Required<TimberPlankOptions>>(
    key: K,
    value: Required<TimberPlankOptions>[K] | undefined,
  ) => {
    if (value === undefined) return;
    setPlankOpts((prev) => ({
      ...prev,
      [key]: value,
      ...(key === 'boardThicknessMm' && prev.wallThicknessMm === prev.boardThicknessMm
        ? { wallThicknessMm: value as number }
        : {}),
    }));
    if (key === 'jointType') {
      if (value === 'glue') {
        setJoineryOpts((prev) => ({ ...prev, jointMode: 'butt' }));
      } else if (value === 'butt') {
        setJoineryOpts((prev) => ({ ...prev, jointMode: 'dowel' }));
      } else if (value === 'rabbet') {
        setJoineryOpts((prev) => ({ ...prev, jointMode: 'dado' }));
      } else if (value === 'finger' || value === 'miter') {
        setJoineryOpts((prev) => ({ ...prev, jointMode: 'mortise_tenon' }));
      }
    }
  };

  const [joineryOpts, setJoineryOpts] = useState<Required<TimberJoineryOptions>>(DEFAULT_TIMBER_JOINERY_OPTIONS);
  const setOpt = <K extends keyof Required<TimberJoineryOptions>>(
    key: K,
    value: Required<TimberJoineryOptions>[K] | undefined,
  ) => {
    if (value === undefined) return;
    setJoineryOpts((prev) => ({ ...prev, [key]: value }));
    if (key === 'jointMode') {
      if (value === 'butt') {
        setPlankOpts((prev) => ({ ...prev, jointType: 'glue' }));
      } else if (value === 'dowel') {
        setPlankOpts((prev) => ({ ...prev, jointType: 'butt' }));
      } else if (value === 'dado') {
        setPlankOpts((prev) => ({ ...prev, jointType: 'rabbet' }));
      } else if (value === 'mortise_tenon') {
        setPlankOpts((prev) =>
          prev.jointType === 'butt' || prev.jointType === 'glue' ? { ...prev, jointType: 'rabbet' } : prev,
        );
      }
    }
  };

  const [explodeMm, setExplodeMm] = useState(32);
  const [viewMode, setViewMode] = useState<'3d' | 'sheet'>('3d');
  const [placement, setPlacement] = useState<'replace' | 'beside'>('replace');
  const [isolatedPartIdx, setIsolatedPartIdx] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<'cards' | 'bom' | 'glue'>('cards');

  const targetIds = useMemo(() => {
    if (selectedNodeId && extraSelectedIds.length > 0) return [selectedNodeId, ...extraSelectedIds];
    if (selectedNodeId) {
      const selNode = findNode(sceneGraph.nodes, selectedNodeId);
      const userGeomCount = selNode?.geoms?.filter((g) => !g.csgDerived && g.role !== 'collision').length ?? 0;
      const isAssemblyNode = !!selNode && ((selNode.children?.length ?? 0) > 1 || userGeomCount > 1);
      if (isAssemblyNode || sceneGraph.nodes.length === 1) return [selectedNodeId];
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
  const soups = useMemo(() => collected.items.map((it) => it.soup), [collected.items]);

  const settledJoineryOpts = useSettled(joineryOpts, 250);
  const settledPlankOpts = useSettled(plankOpts, 250);
  const cncBedMm = useMemo<[number, number, number]>(
    () => [cncBed.widthMm, cncBed.depthMm, cncBed.heightMm],
    [cncBed.widthMm, cncBed.depthMm, cncBed.heightMm],
  );

  const workerMode = modeSetting === 'planks' ? 'planks' : undefined;

  const { result: timberJob, busy, failure } = useExportJob(
    isOpen,
    (client) =>
      soups.length
        ? client.run('timber', sceneGraph, {
            mode: workerMode,
            soups,
            joineryOptions: settledJoineryOpts,
            plankOptions: settledPlankOpts,
            cncBedMm,
            defaultStockLengthMm: 2400,
          })
        : null,
    [workerMode, soups, settledJoineryOpts, settledPlankOpts, cncBedMm],
  );

  const frameOutcome: TimberBreakdownOutcome | null = useMemo(
    () => (failure ? { ok: false, error: failure } : (timberJob?.outcome ?? null)),
    [failure, timberJob?.outcome],
  );
  const plankOutcome: TimberPlankBreakdownOutcome | null = useMemo(
    () => (failure ? { ok: false, error: failure } : (timberJob?.plankOutcome ?? null)),
    [failure, timberJob?.plankOutcome],
  );

  const effectiveMode: 'planks' | 'frame' = useMemo(() => {
    if (modeSetting === 'planks') return 'planks';
    if (modeSetting === 'frame') return 'frame';
    if (
      frameOutcome?.ok &&
      frameOutcome.parts.length > 1 &&
      frameOutcome.parts.some((p) => p.member.role === 'rail')
    ) {
      return 'frame';
    }
    if (plankOutcome?.ok) return 'planks';
    return 'frame';
  }, [modeSetting, frameOutcome, plankOutcome]);

  const breakdown = effectiveMode === 'frame' && frameOutcome?.ok ? frameOutcome : null;
  const cutPlan: TimberCutPlan | null = effectiveMode === 'frame' ? (timberJob?.cutPlan ?? null) : null;
  const plankBreakdown = effectiveMode === 'planks' && plankOutcome?.ok ? plankOutcome : null;

  const frameLayFlat = useMemo(() => {
    if (!breakdown) return null;
    return packPartsLayFlatMetres(
      breakdown.parts.map((p) => ({
        positionsM: p.section.positions,
        upNormal: p.member.face1.normal,
        grainAxis: dominantAxisOf(p.member.axes[0]),
      })),
    );
  }, [breakdown]);

  const previewSections: PreviewSection[] = useMemo(() => {
    if (effectiveMode === 'planks' && plankBreakdown) {
      return plankBreakdown.planks
        .filter((_, idx) => isolatedPartIdx === null || idx === isolatedPartIdx)
        .map((plank, idx) => {
          const origIdx = isolatedPartIdx ?? idx;
          const partNum = `${origIdx + 1}`;
          const explodeScale = Math.hypot(
            plank.explodedOffsetMm[0],
            plank.explodedOffsetMm[1],
            plank.explodedOffsetMm[2],
          );
          const explodeUnit: Vec3 =
            explodeScale > 1e-3
              ? [
                  plank.explodedOffsetMm[0] / 45,
                  plank.explodedOffsetMm[1] / 45,
                  plank.explodedOffsetMm[2] / 45,
                ]
              : plank.section.explode;
          const n = plank.upNormal;
          return {
            positions: viewMode === 'sheet' ? plank.layFlatPositionsM : plank.section.positions,
            faces: plank.section.faces,
            explode: viewMode === 'sheet' || isolatedPartIdx !== null ? [0, 0, 0] : explodeUnit,
            colour: PREVIEW_COLOURS[origIdx % PREVIEW_COLOURS.length],
            pose: { up: plank.section.up, spin: plank.section.spin },
            faceLabels:
              viewMode === 'sheet'
                ? [{ text: partNum, normal: [0, 0, 1] }]
                : [
                    { text: partNum, normal: n },
                    { text: partNum, normal: [-n[0], -n[1], -n[2]] },
                  ],
          };
        });
    }
    if (!breakdown) return [];
    return breakdown.parts
      .filter((_, idx) => isolatedPartIdx === null || idx === isolatedPartIdx)
      .map((p, idx) => {
        const origIdx = isolatedPartIdx ?? idx;
        const partNum = origIdx + 1;
        const flatPos = frameLayFlat?.layFlatPositionsM[origIdx];
        const f1 = p.member.face1.normal;
        const f2 = p.member.face2.normal;
        const f3: Vec3 = [-f1[0], -f1[1], -f1[2]];
        const f4: Vec3 = [-f2[0], -f2[1], -f2[2]];
        const prefix = isolatedPartIdx !== null ? '' : `${partNum}·`;
        return {
          positions: viewMode === 'sheet' && flatPos ? flatPos : p.section.positions,
          faces: p.section.faces,
          explode: viewMode === 'sheet' || isolatedPartIdx !== null ? [0, 0, 0] : p.section.explode,
          colour: PREVIEW_COLOURS[origIdx % PREVIEW_COLOURS.length],
          pose: { up: p.section.up, spin: p.section.spin },
          faceLabels:
            viewMode === 'sheet' && flatPos
              ? [{ text: `${partNum}`, normal: [0, 0, 1] }]
              : p.member.role === 'panel'
                ? [
                    { text: `${partNum}`, normal: f1 },
                    { text: `${partNum}`, normal: f3 },
                  ]
                : [
                    { text: `${prefix}F1`, normal: f1 },
                    { text: `${prefix}F2`, normal: f2 },
                    { text: `${prefix}F3`, normal: f3 },
                    { text: `${prefix}F4`, normal: f4 },
                  ],
        };
      });
  }, [effectiveMode, plankBreakdown, breakdown, frameLayFlat, isolatedPartIdx, viewMode]);

  if (!isOpen) return null;

  const partFilterList =
    effectiveMode === 'planks' && plankBreakdown
      ? plankBreakdown.planks.map((p) => ({ id: p.id, name: p.name }))
      : breakdown
        ? breakdown.parts.map((p) => ({ id: p.member.id, name: p.member.title }))
        : [];

  const handleSendSetupToMachine = (setup: CncWindowSetup) => {
    if (!machineState.connected) {
      setMachineConfigOpen(true);
      return;
    }
    void webSerialManager.runJob(setup.gcode, {
      name: setup.id,
      estimatedSeconds: setup.estimatedMinutes * 60,
    });
  };

  const handleApplyToScene = () => {
    if (!primaryNode) return;
    if (effectiveMode === 'planks' && plankBreakdown) {
      const names = plankBreakdown.planks.map((p) => p.id);
      splitBodyForPrint(primaryNode.id, plankBreakdown.sections, collected.absorbed, {
        plain: false,
        names,
        centerOrigin: true,
        placement,
      });
      onClose();
      return;
    }
    if (!breakdown) return;
    const names = breakdown.parts.map((p) => p.member.id);
    splitBodyForPrint(primaryNode.id, breakdown.sections, collected.absorbed, {
      plain: false,
      names,
      centerOrigin: true,
      placement,
    });
    onClose();
  };

  const activeError =
    effectiveMode === 'planks'
      ? plankOutcome && !plankOutcome.ok
        ? plankOutcome.error
        : null
      : frameOutcome && !frameOutcome.ok
        ? frameOutcome.error
        : null;

  const hasValidResult =
    (effectiveMode === 'planks' && !!plankBreakdown) ||
    (effectiveMode === 'frame' && !!breakdown);

  const showCnc = useCnc === 'on';
  const cncPartCount =
    showCnc && cutPlan ? cutPlan.partCards.filter((c) => c.cncSetups.length > 0).length : 0;
  const sawOnlyPartCount = cutPlan ? cutPlan.partCards.length - cncPartCount : 0;

  const isGlueFrame = effectiveMode === 'frame' && joineryOpts.jointMode === 'butt';
  const isDowelFrame = effectiveMode === 'frame' && joineryOpts.jointMode === 'dowel';
  const isDadoFrame = effectiveMode === 'frame' && joineryOpts.jointMode === 'dado';
  const headerSubtitle =
    effectiveMode === 'planks'
      ? plankOpts.jointType === 'finger' && showCnc
        ? 'Cut parts to size on a saw — CNC Needed: interlocking finger joints (or cut with a shop jig)'
        : plankOpts.jointType === 'butt'
          ? 'Cut parts to size on a saw and drill dowel holes — no CNC needed'
          : 'Cut parts to size on a saw — no CNC needed'
      : isGlueFrame
        ? 'Cut parts to size on a saw and glue — no CNC needed'
        : isDowelFrame
          ? 'Cut parts to size on a saw and drill dowel holes — no CNC needed'
          : !showCnc
            ? 'Cut parts and joints using shop tools — CNC disabled'
            : isDadoFrame
              ? 'Cut parts to size on a saw — CNC Needed (optional): dadoes and slots'
              : 'Cut parts to size on a saw — CNC Needed (optional): mortises and slots';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-6xl max-h-[95dvh] sm:max-h-[92dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 shrink-0">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-lg">
              <Hammer className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Wood Cut List &amp; Joinery
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                {headerSubtitle}
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
        <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden p-3 sm:p-4 flex flex-col gap-3">
          {!primaryNode || !collected.items.length ? (
            <p className="text-sm text-slate-500 dark:text-slate-400 p-2">
              Add or select a solid body, table, chair, or box first, then open Wood Cut List &amp; Joinery.
            </p>
          ) : (
            <>
              {/* Compact Settings Bar */}
              <div className={`${sectionClass} shrink-0 !p-3 !space-y-2.5`}>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-12 gap-3 items-end">
                  <div className="lg:col-span-3">
                    <Field label="Breakdown Type">
                      <Segmented
                        value={modeSetting}
                        onChange={(v) => {
                          setModeSetting(v as 'auto' | 'planks' | 'frame');
                          setIsolatedPartIdx(null);
                        }}
                        options={BREAKDOWN_MODE_OPTIONS}
                      />
                    </Field>
                  </div>

                  {effectiveMode === 'planks' ? (
                    <>
                      <div className="lg:col-span-5">
                        <Field label="Joint Style">
                          <Segmented
                            value={plankOpts.jointType}
                            onChange={(v) => setPlankOpt('jointType', v as PlankJointType)}
                            options={PLANK_JOINT_TYPE_OPTIONS}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-2">
                        <Field label="Interior">
                          <Segmented
                            value={plankOpts.hollowInterior ? 'hollow' : 'solid'}
                            onChange={(v) => setPlankOpt('hollowInterior', v === 'hollow')}
                            options={HOLLOW_INTERIOR_OPTIONS}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-2">
                        <Field
                          label="CNC"
                          hint="Optional: finger joints can be cut on a CNC or with a table-saw/router jig."
                        >
                          <Segmented
                            value={useCnc}
                            onChange={(v) => setUseCnc(v as 'off' | 'on')}
                            options={USE_CNC_OPTIONS}
                          />
                        </Field>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="lg:col-span-5">
                        <Field label="Joint Style">
                          <Segmented
                            value={joineryOpts.jointMode}
                            onChange={(v) => setOpt('jointMode', v as TimberJointMode)}
                            options={JOINT_MODE_OPTIONS}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-2">
                        <Field
                          label="CNC"
                          hint="Optional: mortises, dadoes, and slots can be cut with shop tools (drill press, router, chisel) or run on a CNC."
                        >
                          <Segmented
                            value={isGlueFrame || isDowelFrame ? 'off' : useCnc}
                            onChange={(v) => setUseCnc(v as 'off' | 'on')}
                            options={USE_CNC_OPTIONS}
                          />
                        </Field>
                      </div>
                      <div className="lg:col-span-2">
                        {!isGlueFrame ? (
                          <Field
                            label={isDowelFrame ? 'Dowel Depth (mm)' : isDadoFrame ? 'Dado Depth (mm)' : 'Tenon Len (mm)'}
                            hint={
                              isDowelFrame
                                ? 'Target engagement depth for dowel pins in each mating member.'
                                : isDadoFrame
                                  ? 'How deep each rail tongue seats inside its dado slot.'
                                  : 'How deep each rail tenon sits inside its leg mortise.'
                            }
                          >
                            <NumberInput
                              step={1}
                              min={10}
                              max={50}
                              value={joineryOpts.tenonLengthMm}
                              onChange={(v) => setOpt('tenonLengthMm', v)}
                              className={inputClass}
                            />
                          </Field>
                        ) : (
                          <Field label="Edge Profile">
                            <Segmented
                              value={joineryOpts.edgeProfile}
                              onChange={(v) => setOpt('edgeProfile', v as TimberEdgeProfile)}
                              options={EDGE_PROFILE_OPTIONS}
                            />
                          </Field>
                        )}
                      </div>
                    </>
                  )}
                </div>

                {effectiveMode === 'planks' ? (
                  <Advanced>
                    <Field label="Board Thick (mm)">
                      <NumberInput
                        step={1}
                        min={4}
                        max={100}
                        value={plankOpts.boardThicknessMm}
                        onChange={(v) => setPlankOpt('boardThicknessMm', v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Wall Thick (mm)" hint="Shell wall thickness when Hollow Shell is enabled.">
                      <NumberInput
                        step={1}
                        min={4}
                        max={120}
                        value={plankOpts.wallThicknessMm}
                        onChange={(v) => setPlankOpt('wallThicknessMm', v)}
                        disabled={!plankOpts.hollowInterior}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Split Wide Boards At (mm)" hint="Optional width limit; wider walls split into edge-glued planks.">
                      <NumberInput
                        step={10}
                        min={40}
                        max={1200}
                        value={plankOpts.maxBoardWidthMm}
                        onChange={(v) => setPlankOpt('maxBoardWidthMm', v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Max Board Len (mm)" hint="Optional length limit before splicing along the grain.">
                      <NumberInput
                        step={50}
                        min={100}
                        max={4800}
                        value={plankOpts.maxBoardLengthMm}
                        onChange={(v) => setPlankOpt('maxBoardLengthMm', v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Finger Width (mm)" hint="Box-joint finger width when Finger / Box is selected.">
                      <NumberInput
                        step={2}
                        min={8}
                        max={80}
                        value={plankOpts.fingerWidthMm}
                        onChange={(v) => setPlankOpt('fingerWidthMm', v)}
                        disabled={plankOpts.jointType !== 'finger'}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Dowel Ø (mm)" hint="Alignment dowel diameter across seams (0 to disable).">
                      <NumberInput
                        step={1}
                        min={0}
                        max={16}
                        value={plankOpts.dowelDiaMm}
                        onChange={(v) => setPlankOpt('dowelDiaMm', v)}
                        disabled={plankOpts.jointType === 'glue'}
                        className={inputClass}
                      />
                    </Field>
                  </Advanced>
                ) : (
                  <Advanced>
                    {!isDowelFrame && !isGlueFrame && (
                      <>
                        <Field className="lg:col-span-2" label={isDadoFrame ? 'Dado Corner Fit' : 'Mortise Corner Fit'}>
                          <Segmented
                            value={joineryOpts.tenonCornerFit}
                            onChange={(v) => setOpt('tenonCornerFit', v as TenonCornerFit)}
                            options={CORNER_FIT_OPTIONS}
                          />
                        </Field>
                        <Field className="lg:col-span-2" label={isDadoFrame ? 'Tongue Cutting' : 'Tenon Cutting'}>
                          <Segmented
                            value={joineryOpts.tenonCutMethod}
                            onChange={(v) => setOpt('tenonCutMethod', v as 'bandsaw' | 'cnc')}
                            options={TENON_METHOD_OPTIONS}
                          />
                        </Field>
                      </>
                    )}
                    <Field className="lg:col-span-2" label="Edge Profile">
                      <Segmented
                        value={joineryOpts.edgeProfile}
                        onChange={(v) => setOpt('edgeProfile', v as TimberEdgeProfile)}
                        options={EDGE_PROFILE_OPTIONS}
                      />
                    </Field>
                    {!isDowelFrame && !isGlueFrame && (
                      <Field label="Shoulder (mm)">
                        <NumberInput
                          step={0.5}
                          min={2}
                          max={15}
                          value={joineryOpts.shoulderMm}
                          onChange={(v) => setOpt('shoulderMm', v)}
                          className={inputClass}
                        />
                      </Field>
                    )}
                    {showCnc && !isDowelFrame && !isGlueFrame && (
                      <Field
                        label="CNC Bit Ø (mm)"
                        hint="End mill diameter used when routing mortises, dadoes, or slots on CNC."
                      >
                        <NumberInput
                          step={0.5}
                          min={3}
                          max={16}
                          value={joineryOpts.cutterDiaMm}
                          onChange={(v) => setOpt('cutterDiaMm', v)}
                          className={inputClass}
                        />
                      </Field>
                    )}
                    <Field label="Edge Radius (mm)">
                      <NumberInput
                        step={0.5}
                        min={0}
                        max={15}
                        value={joineryOpts.edgeRadiusMm}
                        onChange={(v) => setOpt('edgeRadiusMm', v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Split Wide Panels At (mm)" hint="Tabletops wider than this split into edge-glued planks.">
                      <NumberInput
                        step={10}
                        min={80}
                        max={1200}
                        value={joineryOpts.maxBoardWidthMm}
                        onChange={(v) => setOpt('maxBoardWidthMm', v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field label="Clearance (mm)">
                      <NumberInput
                        step={0.05}
                        min={0}
                        max={1}
                        value={joineryOpts.clearanceMm}
                        onChange={(v) => setOpt('clearanceMm', v)}
                        className={inputClass}
                      />
                    </Field>
                  </Advanced>
                )}
              </div>

              {/* Side-by-Side: 3D Preview (Left) & Cut List / Instructions (Right) */}
              <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-4 items-stretch">
                {/* LEFT COLUMN: 3D Joinery Preview */}
                <div className={`${sectionClass} lg:col-span-5 xl:col-span-6 flex flex-col min-h-0 !p-3 !space-y-2.5`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <h3 className={sectionTitleClass}>3D Preview</h3>
                      <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px] font-semibold">
                        <button
                          type="button"
                          onClick={() => setViewMode('3d')}
                          className={`flex items-center gap-1 px-2 py-1 cursor-pointer transition-colors ${
                            viewMode === '3d'
                              ? 'bg-amber-500 text-white'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          <Box className="w-3 h-3" /> 3D
                        </button>
                        <button
                          type="button"
                          onClick={() => setViewMode('sheet')}
                          className={`flex items-center gap-1 px-2 py-1 cursor-pointer transition-colors ${
                            viewMode === 'sheet'
                              ? 'bg-amber-500 text-white'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                          }`}
                        >
                          <Grid className="w-3 h-3" /> Lay-Flat
                        </button>
                      </div>
                    </div>

                    {isolatedPartIdx === null && viewMode === '3d' && (
                      <label className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
                        <span>Explode</span>
                        <input
                          type="range"
                          min={0}
                          max={80}
                          step={1}
                          value={explodeMm}
                          onChange={(e) => setExplodeMm(Number(e.target.value))}
                          className="w-24 accent-amber-500"
                        />
                      </label>
                    )}
                  </div>

                  <AssemblyPreview
                    sections={previewSections}
                    pins={[]}
                    explodeMm={isolatedPartIdx === null && viewMode === '3d' ? explodeMm : 0}
                    replay={null}
                  />

                  {partFilterList.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1 max-h-20 overflow-y-auto">
                      <button
                        type="button"
                        onClick={() => setIsolatedPartIdx(null)}
                        className={`px-2 py-0.5 rounded text-[10px] font-semibold cursor-pointer transition-colors ${
                          isolatedPartIdx === null
                            ? 'bg-amber-500 text-white'
                            : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                        }`}
                      >
                        All ({partFilterList.length})
                      </button>
                      {partFilterList.map((p, idx) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setIsolatedPartIdx(isolatedPartIdx === idx ? null : idx)}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono cursor-pointer transition-colors ${
                            isolatedPartIdx === idx
                              ? 'bg-amber-500 text-white'
                              : 'bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700'
                          }`}
                        >
                          {p.id}
                        </button>
                      ))}
                    </div>
                  )}

                  {busy && (
                    <p className="flex items-center gap-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Calculating wood cuts and joinery…
                    </p>
                  )}
                  {!busy && activeError && (
                    <p className="text-[11px] text-red-600 dark:text-red-400">{activeError}</p>
                  )}
                  {!busy && effectiveMode === 'planks' && plankBreakdown && (
                    <div className="space-y-1">
                      <p className="font-mono text-[11px] text-slate-700 dark:text-slate-200">
                        {plankBreakdown.planks.length} board{plankBreakdown.planks.length === 1 ? '' : 's'} ·{' '}
                        {plankBreakdown.options.jointType === 'glue'
                          ? 'GLUE edges · Straight saw cuts + glue (no CNC required)'
                          : plankBreakdown.options.jointType === 'butt'
                            ? 'DOWEL joints · Saw cuts + dowel holes (no CNC required)'
                            : plankBreakdown.options.jointType === 'finger'
                              ? showCnc
                                ? 'FINGER joints · Saw cut boards + CNC needed for finger joints'
                                : 'FINGER joints · Saw cut boards + box-joint jig for finger joints'
                              : `${plankBreakdown.options.jointType.toUpperCase()} edges · Saw cuts only (no CNC required)`}
                      </p>
                      {plankBreakdown.warnings.map((w, i) => (
                        <p key={i} className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /> {w}
                        </p>
                      ))}
                    </div>
                  )}
                  {!busy && effectiveMode === 'frame' && breakdown && cutPlan && (
                    <div className="space-y-1">
                      <p className="font-mono text-[11px] text-slate-700 dark:text-slate-200">
                        {!showCnc || cncPartCount === 0
                          ? `${breakdown.parts.length} parts (saw cuts${isGlueFrame ? ' + glue' : isDowelFrame ? ' + dowel holes' : ' + shop joinery'} only, no CNC required)`
                          : `${breakdown.parts.length} parts (${sawOnlyPartCount} saw-cut only, ${cncPartCount} with CNC Needed)`}
                        {showCnc && cncPartCount > 0 ? ` · ${cncBed.widthMm}×${cncBed.depthMm}×${cncBed.heightMm} mm CNC bed` : ''}
                      </p>
                      {breakdown.warnings.map((w, i) => (
                        <p key={i} className="flex items-start gap-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                          <AlertTriangle className="w-3.5 h-3.5 mt-px shrink-0" /> {w}
                        </p>
                      ))}
                    </div>
                  )}
                </div>

                {/* RIGHT COLUMN: Side-by-Side Cut List & Instructions */}
                <div className={`${sectionClass} lg:col-span-7 xl:col-span-6 flex flex-col min-h-0 max-h-[60dvh] lg:max-h-full !p-3 !space-y-2.5 overflow-hidden`}>
                  {effectiveMode === 'planks' && plankBreakdown && (
                    <>
                      <div className="flex items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-2 shrink-0">
                        <div>
                          <h3 className={sectionTitleClass}>
                            Cut List &amp; Instructions ({plankBreakdown.planks.length} Boards)
                          </h3>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400">
                            {plankBreakdown.options.jointType === 'finger'
                              ? showCnc
                                ? 'Cut boards to size on a saw. CNC Needed only for interlocking finger joints.'
                                : 'Cut boards to size on a saw and cut finger joints on a box-joint jig.'
                              : 'Simple saw cuts only — cut each board to Length × Width × Thickness.'}
                          </p>
                        </div>
                      </div>

                      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
                        {plankBreakdown.planks.map((plank, idx) => {
                          const { sawSteps, cncNote, exceedsCnc } = describePlankSawCut(
                            plank,
                            plankBreakdown.options,
                            cncBed,
                          );
                          const showPlankCnc = showCnc && Boolean(cncNote);
                          const isSelected = isolatedPartIdx === idx;
                          return (
                            <div
                              key={plank.id}
                              onClick={() => setIsolatedPartIdx(isSelected ? null : idx)}
                              className={`rounded-lg border p-3 space-y-1.5 transition-colors cursor-pointer ${
                                isSelected
                                  ? 'border-amber-500 bg-amber-500/10 dark:bg-amber-500/15'
                                  : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 hover:border-slate-300 dark:hover:border-slate-700'
                              }`}
                            >
                              <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-center gap-2">
                                  <span
                                    className="w-2.5 h-2.5 rounded-full shrink-0"
                                    style={{
                                      backgroundColor: `rgb(${PREVIEW_COLOURS[idx % PREVIEW_COLOURS.length].map((c) => Math.round(c * 255)).join(',')})`,
                                    }}
                                  />
                                  <span className="font-bold text-xs text-slate-800 dark:text-slate-100">
                                    {idx + 1}. {plank.name}
                                  </span>
                                  <span className="text-[10px] font-mono text-slate-400">({plank.id})</span>
                                </div>

                                <div className="flex items-center gap-1.5">
                                  <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 font-mono font-bold text-xs">
                                    Cut: {plank.dimensionsMm[0]} × {plank.dimensionsMm[1]} × {plank.dimensionsMm[2]} mm
                                  </span>
                                  <span
                                    className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                      showPlankCnc && exceedsCnc
                                        ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300'
                                        : showPlankCnc
                                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                          : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                                    }`}
                                  >
                                    {showPlankCnc && exceedsCnc
                                      ? 'Too Large for CNC (Use Jig)'
                                      : showPlankCnc
                                        ? 'CNC Needed: Finger Joint'
                                        : plankBreakdown.options.jointType === 'glue'
                                          ? 'Saw + Glue'
                                          : 'Saw Cut Only'}
                                  </span>
                                </div>
                              </div>

                              <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-slate-600 dark:text-slate-300">
                                {sawSteps.map((step, sIdx) => (
                                  <li key={sIdx}>{step}</li>
                                ))}
                              </ul>

                              {showPlankCnc && cncNote && (
                                <div
                                  className={`rounded border px-2.5 py-1.5 text-[11px] ${
                                    exceedsCnc
                                      ? 'bg-amber-500/10 border-amber-500/30 text-amber-900 dark:text-amber-200'
                                      : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-800 dark:text-emerald-200'
                                  }`}
                                >
                                  <strong>{exceedsCnc ? 'Exceeds CNC Capacity:' : 'CNC Needed:'}</strong> {cncNote}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {effectiveMode === 'frame' && cutPlan && (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-2 shrink-0">
                        <div className="flex items-center gap-1.5">
                          {(
                            [
                              ['cards', `Cut List & Steps (${cutPlan.partCards.length})`, Scissors],
                              ['bom', 'Hardware & Orientation', Layers],
                              ['glue', 'Glue-Up Guide', CheckCircle2],
                            ] as const
                          ).map(([tabKey, label, Icon]) => (
                            <button
                              key={tabKey}
                              type="button"
                              onClick={() => setActiveTab(tabKey)}
                              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer transition-colors ${
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
                        <div className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-1">
                          <div className="rounded-lg bg-slate-100 dark:bg-slate-800/60 px-3 py-2 text-[11px] text-slate-600 dark:text-slate-300">
                            <strong>How to read this list:</strong> Part numbers (<span className="font-mono font-semibold">1, 2…</span>) and face numbers (<span className="font-mono font-semibold">F1–F4</span>) are shown directly on the 3D preview faces.{' '}
                            {!showCnc || cncPartCount === 0 ? (
                              <>
                                Cut each part to its listed <span className="font-mono font-semibold">L × W × T mm</span> size on a saw
                                {isGlueFrame
                                  ? ' and glue the joints flush (no CNC required).'
                                  : isDowelFrame
                                    ? ' and drill the listed dowel holes (no CNC required).'
                                    : ' and cut the listed pockets/slots with shop tools (or switch CNC to Optional CNC).'}
                              </>
                            ) : (
                              <>
                                Cut each part to its listed <span className="font-mono font-semibold">L × W × T mm</span> size first; CNC bed dimensions (
                                <span className="font-mono">{cncBed.widthMm} × {cncBed.depthMm} × {cncBed.heightMm} mm</span>) govern how parts with{' '}
                                <span className="text-emerald-700 dark:text-emerald-400 font-semibold">
                                  CNC Needed
                                </span>{' '}
                                clamp on the bed.
                              </>
                            )}
                          </div>

                          {cutPlan.partCards.map((card) => {
                            const hasCnc = showCnc && card.cncSetups.length > 0;
                            const exceedsCnc = showCnc && card.cncAttachment === 'exceeds_cnc';
                            const isSelected = isolatedPartIdx === card.partIndex;
                            return (
                              <div
                                key={card.partId}
                                onClick={() => setIsolatedPartIdx(isSelected ? null : card.partIndex)}
                                className={`rounded-lg border p-3 space-y-2 transition-colors cursor-pointer ${
                                  isSelected
                                    ? 'border-amber-500 bg-amber-500/10 dark:bg-amber-500/15'
                                    : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 hover:border-slate-300 dark:hover:border-slate-700'
                                }`}
                              >
                                {/* Part Header + Cut Dimensions Badge */}
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className="w-2.5 h-2.5 rounded-full shrink-0"
                                      style={{
                                        backgroundColor: `rgb(${PREVIEW_COLOURS[card.partIndex % PREVIEW_COLOURS.length].map((c) => Math.round(c * 255)).join(',')})`,
                                      }}
                                    />
                                    <span className="font-bold text-xs text-slate-800 dark:text-slate-100">
                                      {card.partIndex + 1}. {card.partTitle}
                                    </span>
                                  </div>

                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-800 dark:text-amber-300 font-mono font-bold text-xs">
                                      Cut: {card.finishedDimsMm[0]} × {card.finishedDimsMm[1]} × {card.finishedDimsMm[2]} mm
                                    </span>
                                    <span
                                      className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                        exceedsCnc
                                          ? 'bg-amber-500/20 text-amber-800 dark:text-amber-300'
                                          : hasCnc
                                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                                            : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'
                                      }`}
                                    >
                                      {exceedsCnc
                                        ? 'Too Large for CNC'
                                        : hasCnc
                                          ? card.cncAttachment === 'sliding_pass_through'
                                            ? `CNC Needed (Pass-Through, ${card.cncSetups.length} setups)`
                                            : `CNC Needed (Fits on Bed, ${card.cncSetups.length} setup${card.cncSetups.length === 1 ? '' : 's'})`
                                          : isGlueFrame
                                            ? 'Saw + Glue'
                                            : isDowelFrame
                                              ? 'Saw + Drill Dowels'
                                              : 'Saw + Shop Tools'}
                                    </span>
                                  </div>
                                </div>

                                {/* Saw Cuts (Always simple dimensions) */}
                                <div className="text-[11px] space-y-1">
                                  <ul className="list-disc pl-4 space-y-0.5 text-slate-600 dark:text-slate-300">
                                    {card.bandsawSteps.map((s, k) => (
                                      <li key={k}>{s}</li>
                                    ))}
                                    {card.taperAndProfileSteps.map((s, k) => (
                                      <li key={`tp_${k}`}>{s}</li>
                                    ))}
                                  </ul>
                                </div>

                                {exceedsCnc && card.cncFitNote && (
                                  <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-900 dark:text-amber-200">
                                    <strong>Exceeds CNC Attachment Limit:</strong> {card.cncFitNote}
                                  </div>
                                )}

                                {/* CNC Joinery (ONLY rendered if CNC is enabled and this part has CNC setups!) */}
                                {hasCnc && (
                                  <div
                                    onClick={(e) => e.stopPropagation()}
                                    className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-2.5 space-y-2 text-[11px]"
                                  >
                                    <div className="flex flex-wrap items-center justify-between gap-2">
                                      <span className="font-bold text-emerald-800 dark:text-emerald-300">
                                        {card.cncSectionTitle}
                                      </span>
                                      <span className="text-[10px] text-slate-500">
                                        Ø{card.cncSetups[0].cutterDiaMm} mm end mill
                                      </span>
                                    </div>
                                    {card.cncFitNote && (
                                      <p className="text-[10px] text-slate-500 dark:text-slate-400">
                                        {card.cncFitNote}
                                      </p>
                                    )}

                                    <div className="space-y-1.5">
                                      {card.cncSetups.map((setup) => (
                                        <div
                                          key={setup.id}
                                          className="rounded border border-slate-200 dark:border-slate-800 p-2 bg-white dark:bg-slate-900/80 space-y-1"
                                        >
                                          <div className="flex items-center justify-between gap-2">
                                            <span className="font-mono font-bold text-slate-800 dark:text-slate-100">
                                              {setup.id} (~{setup.estimatedMinutes} min)
                                            </span>
                                            <button
                                              type="button"
                                              onClick={() => handleSendSetupToMachine(setup)}
                                              className="flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-700 dark:text-emerald-300 text-[10px] font-semibold cursor-pointer"
                                              title={
                                                machineState.connected
                                                  ? 'Run this joinery setup directly on the connected CNC'
                                                  : 'Open Machine Setup to connect your CNC'
                                              }
                                            >
                                              <Play className="w-3 h-3" />{' '}
                                              {machineState.connected ? 'Run on CNC' : 'Connect CNC'}
                                            </button>
                                          </div>
                                          <ul className="list-disc pl-4 text-[10px] text-slate-600 dark:text-slate-300 space-y-0.5">
                                            {setup.operationsSummary.map((o, idx) => (
                                              <li key={`op_${idx}`} className="font-medium text-emerald-700 dark:text-emerald-400">
                                                {o}
                                              </li>
                                            ))}
                                            {setup.workholdingNotes.map((n, idx) => (
                                              <li key={idx}>{n}</li>
                                            ))}
                                          </ul>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {activeTab === 'bom' && (
                        <div className="flex-1 min-h-0 overflow-y-auto space-y-4 pr-1 text-xs">
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

                          {cutPlan.partCards.some((c) => c.role === 'leg') && (
                            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-3 space-y-2.5">
                              <div>
                                <h4 className="font-bold text-slate-800 dark:text-slate-100">
                                  Corner Leg Orientation (Top-Down View)
                                </h4>
                                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                                  On every leg, faces <strong>F1 &amp; F2</strong> are the outer show faces and faces <strong>F3 &amp; F4</strong> are the inner{' '}
                                  {isGlueFrame ? 'rail-mating' : isDowelFrame ? 'dowel-drilled' : isDadoFrame ? 'dado' : 'mortised'} faces (shown directly on the 3D preview).
                                </p>
                              </div>

                              <div className="grid grid-cols-2 gap-3 p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200/70 dark:border-slate-800 text-[11px]">
                                {(
                                  [
                                    {
                                      id: 'Leg_BL',
                                      title: 'Back-Left (Leg_BL)',
                                      exterior: 'F1, F2 (Back +Y, Left −X)',
                                      mortises: 'F3, F4 (Right +X, Front −Y)',
                                    },
                                    {
                                      id: 'Leg_BR',
                                      title: 'Back-Right (Leg_BR)',
                                      exterior: 'F1, F2 (Back +Y, Right +X)',
                                      mortises: 'F3, F4 (Left −X, Front −Y)',
                                    },
                                    {
                                      id: 'Leg_FL',
                                      title: 'Front-Left (Leg_FL)',
                                      exterior: 'F1, F2 (Front −Y, Left −X)',
                                      mortises: 'F3, F4 (Right +X, Back +Y)',
                                    },
                                    {
                                      id: 'Leg_FR',
                                      title: 'Front-Right (Leg_FR)',
                                      exterior: 'F1, F2 (Front −Y, Right +X)',
                                      mortises: 'F3, F4 (Left −X, Back +Y)',
                                    },
                                  ] as const
                                ).map((corner) => {
                                  const matchCard = cutPlan.partCards.find((c) => c.partId === corner.id);
                                  const isSel = matchCard && isolatedPartIdx === matchCard.partIndex;
                                  return (
                                    <div
                                      key={corner.id}
                                      onClick={() => {
                                        if (matchCard) {
                                          setIsolatedPartIdx(isSel ? null : matchCard.partIndex);
                                        }
                                      }}
                                      className={`rounded-md border p-2 space-y-0.5 transition-colors ${
                                        matchCard ? 'cursor-pointer' : ''
                                      } ${
                                        isSel
                                          ? 'border-amber-500 bg-amber-500/10'
                                          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900'
                                      }`}
                                    >
                                      <div className="font-bold text-slate-800 dark:text-slate-100 font-mono">
                                        {matchCard ? `${matchCard.partIndex + 1}. ` : ''}
                                        {corner.title}
                                      </div>
                                      <div className="text-[10px] text-slate-500 dark:text-slate-400">
                                        Show faces: {corner.exterior}
                                      </div>
                                      <div className="text-[10px] text-emerald-700 dark:text-emerald-400 font-medium">
                                        {isGlueFrame ? 'Joint faces' : isDowelFrame ? 'Dowel faces' : isDadoFrame ? 'Dado faces' : 'Mortise faces'}: {corner.mortises}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}

                      {activeTab === 'glue' && (
                        <div className="flex-1 min-h-0 overflow-y-auto space-y-2.5 pr-1 text-xs">
                          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2 text-[11px] text-amber-900 dark:text-amber-200">
                            <strong>Tip:</strong> Wood glue gives you 5–10 minutes of open working time. Never glue all legs and rails at once — glue the two flat side frames first, let them cure, then join them together.
                          </div>

                          {[
                            {
                              step: '1. Complete Full Dry-Fit First (No Glue)',
                              details: [
                                'Assemble the entire frame dry without glue and pull the joint shoulders tight with clamps.',
                                isGlueFrame
                                  ? 'Confirm every rail end sits square and flush against its mating leg face with no gaps.'
                                  : isDowelFrame
                                    ? 'Confirm every dowel pin seats cleanly in its mating leg and rail holes with no gaps or twisted rails.'
                                    : isDadoFrame
                                      ? 'Confirm every rail tongue seats cleanly in its dado slot with no gaps or twisted rails.'
                                      : 'Confirm every tenon seats cleanly in its mortise with no gaps or twisted rails.',
                              ],
                            },
                            {
                              step: '2. Stage 1 — Glue the Two Flat Side Sub-Assemblies',
                              details: [
                                'Glue and clamp the Left Frame (Leg_FL + Leg_BL + Left rails/stretchers) flat on your bench.',
                                'Glue and clamp the Right Frame (Leg_FR + Leg_BR + Right rails/stretchers) flat on your bench.',
                                'Wipe squeezed-out glue with a damp cloth and let cure for 30–45 minutes.',
                              ],
                            },
                            {
                              step: '3. Stage 2 — Join Side Frames with Front & Back Rails',
                              details: [
                                'Stand both cured side frames upright on a flat surface and glue the Front and Back rails between them.',
                                'Measure corner-to-corner diagonals (Leg_FL to Leg_BR vs. Leg_FR to Leg_BL) and adjust clamp pressure until both diagonals match within 1 mm.',
                              ],
                            },
                            {
                              step: '4. Stage 3 — Attach Tabletop / Panel',
                              details: [
                                'If the top was split into planks, edge-glue the planks together first.',
                                isGlueFrame || isDowelFrame
                                  ? 'Place the finished top face-down, center the frame on it, and secure with figure-8 expansion washers (do not glue a solid wood top directly to the aprons).'
                                  : 'Place the finished top face-down, center the frame on it, and secure with Z-Clip expansion fasteners in the apron slots (do not glue a solid wood top directly to the aprons).',
                              ],
                            },
                          ].map((stage) => (
                            <div
                              key={stage.step}
                              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-3 space-y-1"
                            >
                              <h4 className="font-bold text-slate-800 dark:text-slate-100">{stage.step}</h4>
                              <ul className="list-disc pl-4 space-y-0.5 text-[11px] text-slate-600 dark:text-slate-300">
                                {stage.details.map((d, idx) => (
                                  <li key={idx}>{d}</li>
                                ))}
                              </ul>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Cpu className="w-3.5 h-3.5 text-amber-500 shrink-0" />
            <span className="hidden xl:inline">Scene placement:</span>
            <div className="w-48">
              <Segmented
                value={placement}
                onChange={(v) => setPlacement(v as 'replace' | 'beside')}
                options={PLACEMENT_OPTIONS}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-2.5 sm:ml-auto">
            <button
              onClick={onClose}
              className="px-3 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
            >
              Close
            </button>
            <button
              onClick={handleApplyToScene}
              disabled={!hasValidResult || busy}
              className="flex items-center gap-1.5 px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
              title="Split into individual timber parts in the scene (one undo step)"
            >
              <Puzzle className="w-4 h-4" />
              <span>Split into Scene Bodies</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
