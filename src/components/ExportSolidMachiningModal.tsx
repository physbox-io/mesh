import React, { useEffect, useMemo, useState } from 'react';
import { X, AlertCircle, Cpu, RefreshCw, Layers, Cuboid } from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import { recommendReliefTooling } from '../utils/reliefCarveExporter';
import {
  measurePart,
  sideDepthMm,
  DEFAULT_SOLID_OPTIONS,
  type SolidMachiningOptions,
  type UpAxis,
} from '../utils/solidMachiningExporter';
import { useExportJob } from '../utils/exportWorkerClient';
import { runSettings } from '../utils/runSettings';
import { webSerialManager } from '../utils/webSerialManager';
import { formatDuration } from '../utils/timeEstimate';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { AddSimulationButton, JobOverrides, JobPreflight, JobProgress, JobResumeBanner, JobTransport } from './MachineJobControls';
import { InlineJobPause } from './JobPauseModal';
import { MachineFaultBanner } from './MachineFaultBanner';
import { ToolpathView } from './ToolpathView';
import {
  inputClass, sectionClass, sectionTitleClass,
  Field, Segmented, PassesField, RoughingPassFields, FinishingPassFields, BedLevellingFields, PreviewPlaceholder,
} from './CarveFields';
import { toolingOnly, useAutoTooling, useBedProbe, useCarveTooling, useSettled, type SetTooling } from './carveTooling';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { useAddSimulation } from '../hooks/useAddSimulation';
import { useSimulationSteps } from '../hooks/useSimulationSteps';
import { SimulateStepsBar } from './SimulateStepsBar';
import { reliefSimulationTools } from '../utils/simulatedPart';
import { simulationSetups } from '../utils/solidSetups';
import { SetupCards } from './SetupCards';
import { SetupChangeDialog } from './SetupChangeDialog';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
  /** Options to start from, as the relief dialog hands a model with an undercut over. */
  seed?: Partial<SolidMachiningOptions> | null;
}

const UP_AXES: readonly (readonly [UpAxis, string])[] = [
  ['+z', '+Z up (as drawn)'],
  ['-z', '−Z up (upside down)'],
  ['+x', '+X up'],
  ['-x', '−X up'],
  ['+y', '+Y up'],
  ['-y', '−Y up'],
];

/** The dialog plans the setups itself unless told how many. */
const SOLID_DIALOG_DEFAULTS: SolidMachiningOptions = { ...DEFAULT_SOLID_OPTIONS, setups: 'auto' };

/** Hands the browser a file to save. */
/**
 * One id per generated program, so side B is matched to the side A it
 * follows. Kept per result rather than made in render: a timestamp taken
 * during render is not the same value twice.
 */
const sequenceIds = new WeakMap<object, string>();
function sequenceIdFor(result: object): string {
  let id = sequenceIds.get(result);
  if (!id) {
    id = `solid-${Date.now().toString(36)}`;
    sequenceIds.set(result, id);
  }
  return id;
}

function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Machine the model itself out of a block: one program per side, a flip in
 * between, and everything the operator needs to know to do that.
 *
 * Built from the same sections as the relief carve dialog, because the
 * tooling is the same tooling. What is different is up top — the part, the
 * stock, and what holds one to the other — and down the bottom, where there
 * are two programs to run instead of one.
 */
export const ExportSolidMachiningModal: React.FC<Props> = ({ isOpen, onClose, scene, seed }) => {
  useEscapeToClose(isOpen, onClose);
  const setMachineConfigOpen = useStore((s) => s.setMachineConfigOpen);
  // Which setup the preview shows and the footer's button cuts.
  const [sel, setSel] = useState(0);
  // The setup being turned to, while its step-by-step dialog is open.
  const [turning, setTurning] = useState<number | null>(null);
  // With Setups on Auto, whether the planner may also choose the way up.
  const [autoOrient, setAutoOrient] = useState(true);

  // Which way up is not tooling, and the part's height — which the feeds are
  // derated for — depends on it, so it is kept outside the tooling state and
  // measured first. The part is always cut at its modelled size, millimetre
  // for millimetre: to cut it bigger or smaller, resize it in the scene.
  const [up, setUp] = useState<UpAxis>(DEFAULT_SOLID_OPTIONS.up);
  const settledUp = useSettled(up, 250);
  const settledPlacement = useMemo(() => ({ up: settledUp, scalePercent: 100 }), [settledUp]);
  const placementSettled = settledUp === up;
  const part = useMemo(
    () => (isOpen ? measurePart(scene, up, 100) : null),
    [isOpen, scene, up]
  );
  const partHeight = part?.z ?? 10;

  const {
    options, setOptions, set, overrides, setOverrides, override, machineState, cuttingRateLimit,
    derived, effective, settled, pending, materialLabel, finishTool, roughTool, speedNote,
  } = useCarveTooling(isOpen, SOLID_DIALOG_DEFAULTS, (o) => sideDepthMm(partHeight, o));

  /*
   * The stock is the board on the bench, the status bar's, as for every other
   * export. The plan refuses it if it cannot hold the part, uses it as it is
   * if it is about the size the part wants, and otherwise says what to cut it
   * down to first. Folded in during render, as the relief dialog folds the
   * board in, so no plan is started against the previous board.
   */
  const bench = useStore((s) => s.stock);
  const [syncedBench, setSyncedBench] = useState<typeof bench | null>(null);
  if (syncedBench !== bench) {
    setSyncedBench(bench);
    setOptions((prev) => ({ ...prev, board: bench, stockWidthMm: 0, stockDepthMm: 0, stockThicknessMm: 0 }));
  }

  // Handed over from the relief dialog: the same board and bits, planned for setups.
  useEffect(() => {
    if (!isOpen || !seed) return;
    // A one-off handover from another dialog when this one opens, not state
    // derived during render: the exception JobHistoryModal documents.
    // Its board is the bench's, already folded in above.
    const { stockWidthMm: _w, stockDepthMm: _d, stockThicknessMm: _t, ...rest } = seed;
    setOptions((prev) => ({ ...prev, ...rest }));
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSel(0);
  }, [isOpen, seed, setOptions]);

  const bed = useBedProbe(() => set('applyMeshLeveling', true));
  const { probedGrid } = bed;
  const simulation = useAddSimulation();

  // Planning the job is the heaviest thing this app computes, and it used to run
  // synchronously in a useMemo right here — which froze the tab hard enough that
  // the browser offered to kill the page. It runs on a worker now, and the modal
  // shows the last plan it finished while the next is on its way.
  const { result, busy, failure } = useExportJob(
    isOpen,
    (client) =>
      client.run('solid', scene, {
        ...settled,
        ...settledPlacement,
        autoOrient,
        motionProfile: machineState.motion,
        meshLevelGrid: probedGrid,
        applyMeshLeveling: settled.applyMeshLeveling && probedGrid !== null,
      }),
    [scene, settled, settledPlacement, probedGrid, machineState.motion, autoOrient]
  );
  // Watch it being made: the stock, then the block after each setup.
  const steps = useSimulationSteps(result, settled);

  const recommendTooling = () => {
    if (!result?.success) return null;
    return {
      ...toolingOnly(recommendReliefTooling({
        reliefDepthMm: result.setups?.[0]?.depthMm ?? result.sides[0].depthMm,
        planWidthMm: result.partSizeMm.x,
        planDepthMm: result.partSizeMm.y,
        material: options.material,
        spindle: machineState.motion.spindle,
        maxFeedMmMin: cuttingRateLimit,
      })),
      // A part is machined to size, and a ball nose leaves scallops on every
      // flat and wall it touches. The recommendation is written for reliefs.
      finishingToolType: 'flat' as const,
      finishingStepoverPercent: 30,
      finishingStrategy: 'hybrid' as const,
    };
  };
  const applyTooling = (patch: Partial<typeof options>) => {
    setOverrides({});
    setOptions((prev) => ({ ...prev, ...patch }));
  };
  // Picked for the part on each new plan until the operator picks; see useAutoTooling.
  const { suggest: applyRecommendedTooling } = useAutoTooling(
    result?.success ? result : null, busy, options, recommendTooling, applyTooling, false
  );

  /*
   * The toolpath view's inputs, held still between renders.
   *
   * The viewport rebuilds its whole path whenever either changes identity, and
   * a rebuild puts the playhead back to zero and re-fits the camera. As object
   * literals in the JSX they changed on every render — and while a job runs
   * this modal renders on every status report — so the live trace was reset
   * several times a second and the view snapped back under any orbit.
   */
  const setups = result?.success ? result.setups ?? [] : [];
  const current = setups.length > 0 ? setups[Math.min(sel, setups.length - 1)] : null;
  const turned = !!current && (current.upFace === '+x' || current.upFace === '-x' || current.upFace === '+y' || current.upFace === '-y');
  const sequenceId = result ? sequenceIdFor(result) : 'solid-none';
  const previewResult = useMemo(
    () =>
      current && result?.success
        ? {
            segments: current.segments,
            estimatedTimeSeconds: current.estimatedTimeSeconds,
            carveBounds: turned ? current.windowBounds : result.partBounds,
          }
        : null,
    [current, result, turned]
  );
  const previewOptions = useMemo(
    () =>
      result?.success
        ? {
            ...settled,
            stockWidthMm: current?.stock.widthMm ?? result.stock.widthMm,
            stockDepthMm: current?.stock.depthMm ?? result.stock.depthMm,
            stockThicknessMm: current?.stock.thicknessMm ?? result.stock.thicknessMm,
          }
        : null,
    [settled, result, current]
  );

  if (!isOpen) return null;

  // Whether the job flips the block over: asked for, or chosen by the plan.
  const twoSided = options.setups === 2 || (options.setups === 'auto' && setups.some((q) => q.upFace === '-z'));
  const swaps = !!current?.toolChange;
  const preflight = {
    material: materialLabel,
    firstTool: settled.roughingEnabled ? roughTool : finishTool,
    secondTool: swaps ? finishTool : undefined,
    caveat: speedNote,
  };
  const canCut = !!current && machineState.connected && machineState.status === 'IDLE';
  /** Runs a setup. A later setup is refused by the runner until the turned block is zeroed again. */
  const runSetup = (i: number, pinsSeated = false) => {
    const s = setups[i];
    if (!s?.gcode) return;
    void webSerialManager.runJob(s.gcode, {
      name: `Solid part, setup ${s.index} of ${s.of}`,
      estimatedSeconds: s.estimatedTimeSeconds,
      setup: { sequenceId, index: s.index, of: s.of, locate: s.locate, pinsSeated },
      // The same preflight the operator is shown before pressing this, kept
      // for the archive: what it was cut from, with which bits, how hard.
      settings: runSettings({
        material: materialLabel,
        machine: 'cnc',
        tool: preflight.firstTool,
        secondTool: preflight.secondTool,
        spindleRpm: settled.spindleRpm,
        cutFeedrate: settled.finishingFeedrate,
        plungeRate: settled.finishingPlungeRate,
      }),
    });
  };

  /** Cut: the first setup straight away, any other through turning the block step by step. */
  const handleStart = (i = sel) => {
    const s = setups[i];
    if (!s) return;
    setSel(i);
    if (s.index === 1 && s.upFace === '+z') runSetup(i);
    else setTurning(i);
  };

  /**
   * Cuts both setups out of one block, side B turned over as the operator
   * turns it, and puts what comes off the machine in the scene: holes, tabs
   * and any step at the seam between the sides included.
   */
  const handleSimulate = (where: 'beside' | 'overlay') => {
    if (!result?.success || !result.stockTransform) return;
    const [a, b] = result.sides;
    void simulation.add({
      job: {
        gcode: a.gcode,
        gcodeB: b?.gcode,
        // A plan that turns the block onto its sides is simulated setup by setup.
        setups: simulationSetups(result),
        widthMm: result.stock.widthMm,
        depthMm: result.stock.depthMm,
        thicknessMm: result.stock.thicknessMm,
        ...reliefSimulationTools(settled),
        measureRect: result.partBounds,
        measureMask: result.footprint,
      },
      modelVolumeMm3: result.partVolumeMm3,
      transform: result.stockTransform,
      kind: 'machining',
      label: 'Solid part',
      placement: where,
      details: [
        result.plan?.text ?? (result.sides.length === 2 ? 'Two setups, side B flipped left to right' : 'One setup'),
        settled.roughingEnabled ? `Roughing: ${roughTool}` : null,
        `Finishing: ${finishTool}`,
        `Estimated ${formatDuration(result.estimatedTimeSeconds)} on the machine`,
        `${result.tabsPlaced} tab${result.tabsPlaced === 1 ? '' : 's'} hold it to the frame`,
      ].filter((d): d is string => !!d),
    });
  };

  const handleFrameTrace = async () => {
    if (!result?.success) return;
    await webSerialManager.frameJob(turned && current ? current.windowBounds : result.bounds, 0, { laserMode: false, safeZMm: options.safeZ });
  };

  const handleProbeBed = () => {
    if (!result?.success) return;
    void bed.probe(result.bounds);
  };

  /*
   * `set` is generic over THIS dialog's options; the field components take a
   * writer over CarveTooling, which those options extend. TypeScript cannot
   * relate `<K extends keyof T>` to `<K extends keyof CarveTooling>` for a
   * `T extends CarveTooling` it is not given, so the relationship is asserted
   * here. The fields only ever write CarveTooling keys.
   */
  const setTooling = set as SetTooling;

  const baseName = (scene.name || 'part').replace(/[^\w.-]+/g, '_');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg">
              <Cuboid className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Machine Solid Part on CNC
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Cut the model itself out of a block at true size, from as many sides as it needs
              </p>
            </div>
          </div>
          <button aria-label="Close" title="Close"
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-clip p-4 sm:p-6 space-y-5">

          {/* Part & stock */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Part &amp; Stock</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label="Setups"
                hint="How many times the block is clamped. Auto looks at the part from all six sides and picks the fewest setups that reach all of it: one for a part with nothing hidden from the top, the flip for shape underneath, and standing it on an end or a side for a slot that leans or a hole that goes in sideways. It shows each setup below with a picture."
              >
                <Segmented
                  value={String(options.setups ?? 'auto')}
                  onChange={(v) => {
                    set('setups', v === 'auto' ? 'auto' : v === '2' ? 2 : 1);
                    if (v !== 'auto') set('sides', v === '2' ? 2 : 1);
                    setSel(0);
                  }}
                  options={[['auto', 'Auto'], ['1', 'One Side'], ['2', 'Two Sides (flip)']] as const}
                />
              </Field>
              <Field
                className="lg:col-span-2"
                label="Which Way Up"
                hint="Which way the model lies in the block for the first setup. Auto lets the plan choose, which usually means the face with the most work on it faces the spindle. Otherwise pick the one that puts the part's flat face down and its tallest dimension across the bed rather than up: the deeper the cut the longer and whippier the cutter has to be."
              >
                <select
                  value={options.setups === 'auto' && autoOrient ? 'auto' : up}
                  onChange={(e) => {
                    if (e.target.value === 'auto') return setAutoOrient(true);
                    setAutoOrient(false);
                    setUp(e.target.value as UpAxis);
                  }}
                  className={inputClass}
                >
                  {options.setups === 'auto' && <option value="auto">Auto (the plan chooses)</option>}
                  {UP_AXES.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </Field>
              <Field
                className="lg:col-span-2"
                label="Part Size"
                hint="The part this way up, in mm: across, back, and tall. It is cut at its modelled size; resize it in the scene to change that. Tall is the depth the cutter has to reach, halved on a two-sided job."
              >
                <div className={`${inputClass} bg-slate-100 dark:bg-slate-800/60 border-transparent`}>
                  {part ? `${part.x.toFixed(1)} × ${part.y.toFixed(1)} × ${part.z.toFixed(1)}` : '—'}
                </div>
              </Field>

              <Field
                className="lg:col-span-2"
                label="Stock (mm)"
                hint="The board in the status bar, the same one every export uses. If it cannot hold the part the job is refused and says what it needs. If it is much bigger than the part wants, or a side setup needs the block flush with the part, it says what to cut the board down to first."
              >
                <div className={`${inputClass} bg-slate-100 dark:bg-slate-800/60 border-transparent`}>
                  {`${bench.widthMm} × ${bench.depthMm} × ${bench.thicknessMm}`}
                  {result?.success && result.boardPrep
                    ? ` → ${result.stock.widthMm.toFixed(0)} × ${result.stock.depthMm.toFixed(0)} × ${result.stock.thicknessMm.toFixed(0)}`
                    : ''}
                </div>
                {result?.success && result.boardPrep && (
                  <p className="mt-1 text-[10px] leading-snug text-amber-600 dark:text-amber-400">{result.boardPrep}</p>
                )}
              </Field>
              <Field
                label="Top Skin (mm)"
                hint="Stock above the part's top face, faced off at the start of each side. A sawn surface is neither flat nor at a known height, so the part is put a little below it and everything above is skimmed away."
              >
                <NumberInput
                  step={0.5} min={0} max={20}
                  value={options.topSkinMm}
                  onChange={(v) => set('topSkinMm', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Channel (mm)"
                hint="Width of the channel cut round the part down to the floor, which is where the cutter gets at the part's walls. 0 derives it from the roughing cutter: one and a half diameters, so it can get round every corner and clear its chips."
              >
                <NumberInput
                  step={1} min={0} max={100}
                  allowEmpty
                  placeholder="auto"
                  value={options.moatWidthMm || null}
                  onChange={(v) => set('moatWidthMm', v ?? 0)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Frame (mm)"
                hint="Stock left standing outside the channel all the way round. It is what the clamps hold, what the tabs hold the part to, and on a two-sided job where the registration pins go, so it must be wider than the pin with some to spare."
              >
                <NumberInput
                  step={1} min={0} max={100}
                  value={options.frameWidthMm}
                  onChange={(v) => set('frameWidthMm', v)}
                  className={inputClass}
                />
              </Field>
              {options.setups === 'auto' && (
                <Field
                  label="Room Under Spindle (mm)"
                  hint="From the bed to the bottom of the collet with Z all the way up. A block stood on its end has to fit under there with the bit in, so Auto will not plan a setup that does not. Leave empty if you do not know; you will be asked to check before the block is stood up."
                >
                  <NumberInput
                    step={5} min={0} max={1000}
                    allowEmpty
                    placeholder="unknown"
                    value={options.clearanceMm || null}
                    onChange={(v) => set('clearanceMm', v ?? 0)}
                    className={inputClass}
                  />
                </Field>
              )}
            </div>

            {result?.success && (
              <div className="rounded-lg bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2.5 py-2 space-y-1">
                <p className="font-mono text-[11px] text-slate-800 dark:text-slate-100">
                  Stock {result.stock.widthMm.toFixed(1)} × {result.stock.depthMm.toFixed(1)} × {result.stock.thicknessMm.toFixed(1)} mm {materialLabel} ·
                  part {result.partSizeMm.x.toFixed(1)} × {result.partSizeMm.y.toFixed(1)} × {result.partSizeMm.z.toFixed(1)} mm ·
                  {' '}{Math.round(result.partVolumeMm3).toLocaleString()} mm³ ·
                  {' '}{setups.length === 1 ? 'one setup' : `${setups.length} setups`}
                  {result.upChosen && result.upChosen !== up ? `, laid ${result.upChosen} up` : ''}
                </p>
                {!result.plan && (
                  <p className={`text-[10px] leading-snug ${result.unreachablePercent > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                    {result.unreachablePercent > 1
                      ? `The part comes out with ${result.unreachablePercent > 100 ? 'more than its own volume again' : `${result.unreachablePercent.toFixed(0)}% of its volume`} in material no side can reach. Set Setups to Auto to have it turned onto the faces that can.`
                      : 'Every part of the model is reachable from the sides being cut.'}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Holding */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Holding the Part</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                label="Tabs"
                hint="Bridges left across the channel, spread round the part, that hold it to the frame once the channel is through. Sawn or snapped off afterwards and the stubs filed. 0 leaves the part loose under a spinning cutter on its last pass, which is how parts and cutters get thrown."
              >
                <NumberInput
                  step={1} min={0} max={16} integer
                  value={options.tabCount}
                  onChange={(v) => set('tabCount', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Tab Width (mm)"
                hint="Width of each tab along the part's edge."
              >
                <NumberInput
                  step={1} min={1} max={30}
                  value={options.tabWidthMm}
                  onChange={(v) => set('tabWidthMm', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Tab Height (mm)"
                hint="How thick the tabs are, which is how much you have to saw through. On a two-sided job they sit across the middle of the block; on one side, at the bottom."
              >
                <NumberInput
                  step={0.5} min={0.5} max={20}
                  value={options.tabThicknessMm}
                  onChange={(v) => set('tabThicknessMm', v)}
                  className={inputClass}
                />
              </Field>

              {twoSided ? (
                <>
                  <Field
                    label="Registration"
                    hint="Bores two holes through the frame and into the spoilboard on the first side. Push dowels into them, flip the block over left to right, and drop it back onto the same dowels: the second side then lines up with the first to the accuracy of the holes rather than of your eye. Without pins, re-zero X and Y on the new near-left corner and hope the stock was cut square."
                  >
                    <Segmented
                      value={options.registrationPins ? 'on' : 'off'}
                      onChange={(v) => set('registrationPins', v === 'on')}
                      options={[['on', 'Pins'], ['off', 'None']] as const}
                    />
                  </Field>
                  <Field
                    label="Pin Ø (mm)"
                    hint="Dowel diameter. Bored with the roughing cutter, so it must be at least as wide as that. 8 mm dowel and a 1/4 inch mill is the usual pair."
                  >
                    <NumberInput
                      step={1} min={2} max={20}
                      disabled={!options.registrationPins}
                      value={options.pinDiaMm}
                      onChange={(v) => set('pinDiaMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field
                    label="Pin Depth (mm)"
                    hint="How far past the bottom of the stock the pin holes go, into the spoilboard. The dowels need something to stand in."
                  >
                    <NumberInput
                      step={1} min={2} max={30}
                      disabled={!options.registrationPins}
                      value={options.pinDepthMm}
                      onChange={(v) => set('pinDepthMm', v)}
                      className={inputClass}
                    />
                  </Field>
                </>
              ) : (
                <Field
                  label="Through Cut (mm)"
                  hint="How far below the bottom of the stock the channel goes, so the part is cut clean through rather than left on a skin. That much of whatever is under the stock gets cut too: use a spoilboard."
                >
                  <NumberInput
                    step={0.1} min={0} max={5}
                    value={options.throughCutMm}
                    onChange={(v) => set('throughCutMm', v)}
                    className={inputClass}
                  />
                </Field>
              )}
            </div>
            {result?.success && (
              <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                {result.tabsPlaced} tab{result.tabsPlaced === 1 ? '' : 's'} placed
                {result.pins.length > 0
                  ? ` · pins at X${result.pins[0].x.toFixed(1)} and X${result.pins[1].x.toFixed(1)}, Y${result.pins[0].y.toFixed(1)}`
                  : ''}
              </p>
            )}
          </div>

          <PassesField options={options} set={setTooling} />

          <RoughingPassFields
            options={options}
            effective={effective}
            derived={derived}
            overrides={overrides}
            set={setTooling}
            override={override}
            materialLabel={materialLabel}
            bitePercent={result?.success ? result.sides[0]?.roughingBitePercent ?? null : null}
          />

          <FinishingPassFields
            options={options}
            effective={effective}
            derived={derived}
            overrides={overrides}
            set={setTooling}
            override={override}
            materialLabel={materialLabel}
            speedNote={speedNote}
            passCount={current ? current.finishingRasterLines : null}
            onSuggestTooling={applyRecommendedTooling}
            canSuggest={!!result?.success}
          />

          <BedLevellingFields
            {...bed}
            onProbe={handleProbeBed}
            canProbe={!!result?.success}
            connected={machineState.connected}
            applyMeshLeveling={options.applyMeshLeveling}
            setApplyMeshLeveling={(on) => set('applyMeshLeveling', on)}
          />

          {((result && !result.success) || failure) && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/40 flex items-start space-x-2 text-xs text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{failure ?? (result && !result.success ? result.error : '')}</span>
            </div>
          )}

          {result && result.warnings.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-1.5">
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-start space-x-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Toolpath preview, one side at a time */}
          {result?.success && current && (
            <div className="space-y-3">
              <SimulateStepsBar steps={steps} disabled={busy || pending || !placementSettled} />
              <SetupCards
                setups={setups}
                firstStock={result.stock}
                pins={result.pins}
                plan={result.plan}
                selected={Math.min(sel, setups.length - 1)}
                onSelect={setSel}
                onDownload={(i) => downloadText(setups[i].gcode, `${baseName}_setup_${setups[i].index}_${setups[i].upFace.replace('+', 'p').replace('-', 'm')}.gcode`)}
                onRun={handleStart}
                canRun={canCut}
                simulatedThrough={steps.next - 1}
                onSimulateTo={(i) => void steps.addUpTo(i + 1)}
                simulating={steps.adding !== null}
              />

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600 dark:text-slate-400">
                <span className="flex items-center space-x-1.5 font-medium">
                  <Layers className="w-4 h-4 text-blue-500" />
                  <span>Setup {current.index}: {current.finishingRasterLines} finishing passes</span>
                </span>
                <span>{current.roughingPassCount} roughing layers</span>
                {current.toolChange && (
                  <span className="text-amber-600 dark:text-amber-400 font-medium">
                    Pauses for a tool change between passes
                  </span>
                )}
                {(busy || pending || !placementSettled) && <span className="text-slate-400 italic">recalculating…</span>}
              </div>

              {previewResult && previewOptions && (
                <ToolpathView result={previewResult} options={previewOptions} machineState={machineState} />
              )}

              <div className="flex items-center space-x-4 text-[11px] text-slate-500 dark:text-slate-400">
                <span>
                  Right-drag orbits, middle-drag pans, scroll zooms. The wireframe box is the stock
                  {current.index > 1 ? ' as it stands for this setup, after the turn' : ''}.
                </span>
              </div>
            </div>
          )}

          {/* Nothing has come back yet (an unsuccessful result shows the error
              card instead): keep the box on screen with a note rather than
              collapsing the dialog until the first plan arrives. */}
          {!result && !failure && (
            <PreviewPlaceholder label="Planning the part…" />
          )}

          {/* Machine */}
          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-white space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center space-x-3">
                <Cpu className="w-5 h-5 text-blue-400" />
                <div>
                  <h3 className="text-sm font-bold flex items-center space-x-2">
                    <span>Machine</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                      machineState.status === 'RUNNING' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' :
                      machineState.status.startsWith('PAUSED') ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse' :
                      machineState.connected ? 'bg-blue-500/20 text-blue-600 dark:text-blue-400 border border-blue-500/40' : 'bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400'
                    }`}>
                      {machineState.status}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-500 dark:text-slate-400">
                    {machineState.connected
                      ? `Connected via USB serial (${machineState.portName})`
                      : 'Not connected. Open Machine Setup to connect, home and zero.'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleFrameTrace}
                  disabled={!result?.success || !machineState.connected}
                  title="Trace the part's outline so you can check it lands on the stock"
                  className="py-1.5 px-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-40 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg flex items-center gap-1 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-blue-400" />
                  <span>Frame Job</span>
                </button>
                <button
                  onClick={() => setMachineConfigOpen(true)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold bg-blue-500 hover:bg-blue-600 text-slate-950 flex items-center gap-1.5 cursor-pointer"
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>Machine Setup</span>
                </button>
              </div>
            </div>

            {setups.length > 1 && (
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                <span className="font-semibold">Between setups:</span> leave the machine where it is. Pressing Cut on
                the next setup walks you through turning the block and finding its zero again, step by step, and it
                will not start until that is done.
              </p>
            )}

            <MachineFaultBanner machineState={machineState} />
            <InlineJobPause machineState={machineState} resumeLabel="Resume Cut (Cycle Start)" />
            <JobResumeBanner machineState={machineState} />
            <JobProgress machineState={machineState} />
            <JobOverrides machineState={machineState} />

            <JobPreflight
              machineState={machineState}
              tool={preflight.firstTool}
              secondTool={preflight.secondTool}
              rpm={settled.spindleRpm}
              material={preflight.material}
              origin="the near-left corner of the stock's top face"
              caveat={preflight.caveat}
              extent={result?.success ? (turned && current ? { ...current.windowBounds, minZ: -current.stock.thicknessMm, maxZ: 0 } : result.bounds) : undefined}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden lg:block text-xs text-slate-500 dark:text-slate-400">
            Zero the machine on the near-left corner of the stock's top face, then cut setup 1.
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              Close
            </button>

            <AddSimulationButton
              disabled={!result?.success || busy || pending || !placementSettled}
              onSimulate={handleSimulate}
              progress={simulation.progress}
              error={simulation.error}
            />

            {machineState.connected ? (
              <JobTransport
                machineState={machineState}
                canStart={canCut}
                onStart={() => handleStart()}
                startLabel={current ? `Cut Setup ${current.index}${current.of > 1 ? ` of ${current.of}` : ''}` : 'Cut'}
              />
            ) : (
              <button
                onClick={() => setMachineConfigOpen(true)}
                className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-blue-500 hover:bg-blue-600 text-slate-950 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
              >
                <Cpu className="w-4 h-4" />
                <span>Connect CNC to Cut</span>
              </button>
            )}
          </div>
        </div>

      </div>
      {turning !== null && setups[turning] && result?.success && (
        <SetupChangeDialog
          setup={setups[turning]}
          firstStock={result.stock}
          carved={setups.slice(0, turning).map((q) => q.upFace)}
          pins={result.pins}
          toolDiaMm={settled.finishingToolDiaMm}
          toolLabel={finishTool}
          stickoutMm={settled.toolStickoutMm}
          clearanceMm={options.clearanceMm ?? 0}
          safeZMm={options.safeZ}
          machineState={machineState}
          onClose={() => setTurning(null)}
          onStart={(pinsSeated) => {
            runSetup(turning, pinsSeated);
            setTurning(null);
          }}
        />
      )}
    </div>
  );
};
