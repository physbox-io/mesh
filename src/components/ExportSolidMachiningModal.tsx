import React, { useMemo, useState } from 'react';
import { X, AlertCircle, Cpu, RefreshCw, Layers, Cuboid, Download } from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import { recommendReliefTooling } from '../utils/reliefCarveExporter';
import {
  measurePart,
  sideDepthMm,
  DEFAULT_SOLID_OPTIONS,
  type UpAxis,
} from '../utils/solidMachiningExporter';
import { useExportJob } from '../utils/exportWorkerClient';
import { webSerialManager } from '../utils/webSerialManager';
import { formatDuration } from '../utils/timeEstimate';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { JobPauseBanner, JobPreflight, JobProgress, JobResumeBanner, JobTransport } from './MachineJobControls';
import { MachineFaultBanner } from './MachineFaultBanner';
import { ToolpathView } from './ToolpathView';
import {
  inputClass, sectionClass, sectionTitleClass,
  Field, Segmented, FinishingPassFields, RoughingPassFields, BedLevellingFields, PreviewPlaceholder,
} from './CarveFields';
import { toolingOnly, useBedProbe, useCarveTooling, useSettled } from './carveTooling';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
}

const UP_AXES: readonly (readonly [UpAxis, string])[] = [
  ['+z', '+Z up (as drawn)'],
  ['-z', '−Z up (upside down)'],
  ['+x', '+X up'],
  ['-x', '−X up'],
  ['+y', '+Y up'],
  ['-y', '−Y up'],
];

/** Hands the browser a file to save. */
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
export const ExportSolidMachiningModal: React.FC<Props> = ({ isOpen, onClose, scene }) => {
  const setMachineConfigOpen = useStore((s) => s.setMachineConfigOpen);
  const [side, setSide] = useState<0 | 1>(0);

  // Which way up and how big are not tooling, and the part's height — which
  // the feeds are derated for — depends on them, so they are kept outside the
  // tooling state and measured first.
  const [placement, setPlacement] = useState<{ up: UpAxis; scalePercent: number }>({
    up: DEFAULT_SOLID_OPTIONS.up,
    scalePercent: DEFAULT_SOLID_OPTIONS.scalePercent,
  });
  const part = useMemo(
    () => (isOpen ? measurePart(scene, placement.up, placement.scalePercent) : null),
    [isOpen, scene, placement]
  );
  const partHeight = part?.z ?? 10;

  const {
    options, setOptions, set, overrides, setOverrides, override, machineState, cuttingRateLimit,
    derived, effective, settled, pending, materialLabel, finishTool, roughTool, speedNote,
  } = useCarveTooling(isOpen, DEFAULT_SOLID_OPTIONS, (o) => sideDepthMm(partHeight, o));
  const settledPlacement = useSettled(placement, 250);

  const bed = useBedProbe(() => set('applyMeshLeveling', true));
  const { probedGrid } = bed;

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
        motionProfile: machineState.motion,
        meshLevelGrid: probedGrid,
        applyMeshLeveling: settled.applyMeshLeveling && probedGrid !== null,
      }),
    [scene, settled, settledPlacement, probedGrid, machineState.motion]
  );

  const applyRecommendedTooling = () => {
    if (!result?.success) return;
    setOverrides({});
    setOptions((prev) => ({
      ...prev,
      ...toolingOnly(recommendReliefTooling({
        reliefDepthMm: result.sides[0].depthMm,
        planWidthMm: result.partSizeMm.x,
        planDepthMm: result.partSizeMm.y,
        material: prev.material,
        spindle: machineState.motion.spindle,
        maxFeedMmMin: cuttingRateLimit,
      })),
      // A part is machined to size, and a ball nose leaves scallops on every
      // flat and wall it touches. The recommendation is written for reliefs.
      finishingToolType: 'flat',
      finishingStepoverPercent: 30,
    }));
  };

  if (!isOpen) return null;

  const current = result?.success ? result.sides[Math.min(side, result.sides.length - 1)] : null;
  const twoSided = options.sides === 2;
  const swaps = !!current?.toolChange;
  const preflight = {
    material: materialLabel,
    firstTool: settled.roughingEnabled ? roughTool : finishTool,
    secondTool: swaps ? finishTool : undefined,
    caveat: speedNote,
  };
  const canCut = !!current && machineState.connected && machineState.status === 'IDLE';

  const handleStart = () => {
    if (!current?.gcode) return;
    void webSerialManager.runJob(current.gcode, {
      name: `Solid part, side ${current.side}`,
      estimatedSeconds: current.estimatedTimeSeconds,
    });
  };

  const handleFrameTrace = async () => {
    if (!result?.success) return;
    await webSerialManager.frameJob(result.partBounds, 0, { laserMode: false, safeZMm: options.safeZ });
  };

  const handleProbeBed = () => {
    if (!result?.success) return;
    void bed.probe(result.partBounds);
  };

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
                Cut the model itself out of a block at true size: one side, then flip it and cut the other
              </p>
            </div>
          </div>
          <button
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
                label="Sides"
                hint="A part with a flat bottom (a bracket lying on its plate, a plaque) is finished from one side, held by tabs at the bottom of the channel. Anything with shape underneath needs the block turned over and cut again from the other side. The job tells you below how much of the part one side cannot reach."
              >
                <Segmented
                  value={String(options.sides)}
                  onChange={(v) => set('sides', v === '2' ? 2 : 1)}
                  options={[['1', 'One Side'], ['2', 'Two Sides (flip)']] as const}
                />
              </Field>
              <Field
                className="lg:col-span-2"
                label="Which Way Up"
                hint="Which axis of the model points at the spindle for the first side. Pick the one that puts the part's flat face down and its tallest dimension across the bed rather than up: the deeper the cut the longer and whippier the cutter has to be."
              >
                <select
                  value={placement.up}
                  onChange={(e) => setPlacement((p) => ({ ...p, up: e.target.value as UpAxis }))}
                  className={inputClass}
                >
                  {UP_AXES.map(([v, label]) => (
                    <option key={v} value={v}>{label}</option>
                  ))}
                </select>
              </Field>
              <Field
                label="Scale (%)"
                hint="100 cuts the part the size it was drawn, 1 m in the scene to 1 mm on the bench, the same rule as every other export."
              >
                <NumberInput
                  step={10} min={1} max={10000}
                  value={placement.scalePercent}
                  onChange={(v) => v !== undefined && setPlacement((p) => ({ ...p, scalePercent: v }))}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Part Size"
                hint="The part this way up, at this scale, in mm: across, back, and tall. Tall is the depth the cutter has to reach, halved on a two-sided job."
              >
                <div className={`${inputClass} bg-slate-100 dark:bg-slate-800/60 border-transparent`}>
                  {part ? `${part.x.toFixed(1)} × ${part.y.toFixed(1)} × ${part.z.toFixed(1)}` : '—'}
                </div>
              </Field>

              <Field
                label="Stock W (mm)"
                hint="Width of the block, or 0 to make it the part plus a channel and a frame on each side. The job needs at least the number shown greyed. Bigger stock is fine: the part is centred in it, and on a two-sided job the pins keep the flip honest whatever size the block is."
              >
                <NumberInput
                  step={5} min={0} max={2000}
                  allowEmpty
                  placeholder={result?.success ? result.stock.widthMm.toFixed(1) : 'auto'}
                  value={options.stockWidthMm || null}
                  onChange={(v) => set('stockWidthMm', v ?? 0)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Stock D (mm)"
                hint="Depth of the block, front to back, or 0 for the part plus channel and frame."
              >
                <NumberInput
                  step={5} min={0} max={2000}
                  allowEmpty
                  placeholder={result?.success ? result.stock.depthMm.toFixed(1) : 'auto'}
                  value={options.stockDepthMm || null}
                  onChange={(v) => set('stockDepthMm', v ?? 0)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Stock T (mm)"
                hint="Thickness of the block, or 0 for the part's height plus a skin on every machined face. It must be at least the part's height this way up."
              >
                <NumberInput
                  step={1} min={0} max={300}
                  allowEmpty
                  placeholder={result?.success ? result.stock.thicknessMm.toFixed(1) : 'auto'}
                  value={options.stockThicknessMm || null}
                  onChange={(v) => set('stockThicknessMm', v ?? 0)}
                  className={inputClass}
                />
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
            </div>

            {result?.success && (
              <div className="rounded-lg bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2.5 py-2 space-y-1">
                <p className="font-mono text-[11px] text-slate-800 dark:text-slate-100">
                  Stock {result.stock.widthMm.toFixed(1)} × {result.stock.depthMm.toFixed(1)} × {result.stock.thicknessMm.toFixed(1)} mm {materialLabel} ·
                  part {result.partSizeMm.x.toFixed(1)} × {result.partSizeMm.y.toFixed(1)} × {result.partSizeMm.z.toFixed(1)} mm ·
                  {' '}{(result.partVolumeMm3 / 1000).toFixed(1)} cm³ ·
                  {' '}{result.sides.length === 2 ? 'two setups' : 'one setup'}, {result.sides[0].depthMm.toFixed(1)} mm deep each
                </p>
                <p className={`text-[10px] leading-snug ${result.unreachablePercent > 1 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  {result.unreachablePercent > 1
                    ? `The part comes out with ${result.unreachablePercent > 100 ? 'more than its own volume again' : `${result.unreachablePercent.toFixed(0)}% of its volume`} in material no side can reach. Turn it, or cut both sides.`
                    : 'Every part of the model is reachable from the sides being cut.'}
                </p>
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

          <FinishingPassFields
            options={options}
            effective={effective}
            derived={derived}
            overrides={overrides}
            set={set}
            override={override}
            materialLabel={materialLabel}
            speedNote={speedNote}
            passCount={current ? current.finishingRasterLines : null}
            onSuggestTooling={applyRecommendedTooling}
            canSuggest={!!result?.success}
          />

          <RoughingPassFields
            options={options}
            effective={effective}
            derived={derived}
            overrides={overrides}
            set={set}
            override={override}
            materialLabel={materialLabel}
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
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-slate-600 dark:text-slate-400">
                {result.sides.length > 1 && (
                  <div className="w-44">
                    <Segmented
                      value={String(side)}
                      onChange={(v) => setSide(v === '1' ? 1 : 0)}
                      options={[['0', 'Side A'], ['1', 'Side B (flipped)']] as const}
                    />
                  </div>
                )}
                <span className="flex items-center space-x-1.5 font-medium">
                  <Layers className="w-4 h-4 text-blue-500" />
                  <span>{current.finishingRasterLines} finishing passes</span>
                </span>
                <span>{current.roughingPassCount} roughing layers</span>
                <span className="font-mono bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded text-[10px] uppercase font-bold text-blue-600 dark:text-blue-400">
                  Side {current.side}: {formatDuration(current.estimatedTimeSeconds)}
                  {result.sides.length > 1 && ` · both: ${formatDuration(result.estimatedTimeSeconds)}`}
                </span>
                {current.toolChange && (
                  <span className="text-amber-600 dark:text-amber-400 font-medium">
                    Pauses for a tool change between passes
                  </span>
                )}
                {(busy || pending || settledPlacement !== placement) && <span className="text-slate-400 italic">recalculating…</span>}
                <span className="ml-auto flex items-center gap-2">
                  {result.sides.map((s) => (
                    <button
                      key={s.side}
                      type="button"
                      onClick={() => downloadText(s.gcode, `${baseName}_side_${s.side}.gcode`)}
                      title={`Save side ${s.side}'s program as a G-code file`}
                      className="py-1 px-2 bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg flex items-center gap-1 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5 text-blue-400" />
                      <span>Side {s.side} .gcode</span>
                    </button>
                  ))}
                </span>
              </div>

              <ToolpathView
                result={{ segments: current.segments, estimatedTimeSeconds: current.estimatedTimeSeconds, carveBounds: result.partBounds }}
                options={{
                  ...settled,
                  stockWidthMm: result.stock.widthMm,
                  stockDepthMm: result.stock.depthMm,
                  stockThicknessMm: result.stock.thicknessMm,
                }}
                machineState={machineState}
              />

              <div className="flex items-center space-x-4 text-[11px] text-slate-500 dark:text-slate-400">
                <span>
                  Right-drag orbits, middle-drag pans, scroll zooms. The wireframe box is the stock
                  {current.side === 'B' ? ', seen after the flip: what was on the left is now on the right' : ''}.
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

            {twoSided && (
              <p className="text-xs leading-relaxed text-slate-600 dark:text-slate-300">
                <span className="font-semibold">Between the sides:</span> when side A finishes, leave X and Y zeroed.
                {options.registrationPins && result?.pins.length
                  ? ' Push dowels into the two pin holes, lift the block, turn it over left to right, and drop it back onto the dowels.'
                  : ' Turn the block over left to right and re-zero X and Y on the new near-left corner.'}
                {' '}Re-zero Z on the new top face, then run side B.
              </p>
            )}

            <MachineFaultBanner machineState={machineState} />
            <JobPauseBanner machineState={machineState} resumeLabel="Resume Cut (Cycle Start)" />
            <JobResumeBanner machineState={machineState} />
            <JobProgress machineState={machineState} />

            <JobPreflight
              machineState={machineState}
              tool={preflight.firstTool}
              secondTool={preflight.secondTool}
              rpm={settled.spindleRpm}
              material={preflight.material}
              origin="the near-left corner of the stock's top face"
              caveat={preflight.caveat}
              extent={result?.success ? result.bounds : undefined}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden lg:block text-xs text-slate-500 dark:text-slate-400">
            Zero the machine on the near-left corner of the stock's top face, then cut side A.
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              Close
            </button>

            {machineState.connected ? (
              <JobTransport
                machineState={machineState}
                canStart={canCut}
                onStart={handleStart}
                startLabel={current ? `Cut Side ${current.side}` : 'Cut'}
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
    </div>
  );
};
