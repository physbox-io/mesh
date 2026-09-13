import React from 'react';
import { X, AlertCircle, Cpu, RefreshCw, Layers, Mountain } from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import {
  DEFAULT_RELIEF_OPTIONS,
  recommendReliefTooling,
} from '../utils/reliefCarveExporter';
import { webSerialManager } from '../utils/webSerialManager';
import { formatDuration } from '../utils/timeEstimate';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { JobPauseBanner, JobPreflight, JobProgress, JobResumeBanner, JobTransport } from './MachineJobControls';
import { MachineFaultBanner } from './MachineFaultBanner';
import { ToolpathView } from './ToolpathView';
import {
  inputClass, sectionClass, sectionTitleClass,
  Field, Advanced, Segmented, FinishingPassFields, RoughingPassFields, BedLevellingFields, PreviewPlaceholder,
} from './CarveFields';
import { toolingOnly, useBedProbe, useCarveTooling } from './carveTooling';
import { useExportJob } from '../utils/exportWorkerClient';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
}

export const ExportReliefCarveModal: React.FC<Props> = ({ isOpen, onClose, scene }) => {
  const setMachineConfigOpen = useStore((s) => s.setMachineConfigOpen);

  // The feeds are derated for the depth of the carve, which here is one of the
  // options rather than something measured off the part.
  const {
    options, setOptions, set, overrides, setOverrides, override, machineState, cuttingRateLimit,
    derived, effective, settled, pending, materialLabel, finishTool, roughTool, speedNote,
  } = useCarveTooling(isOpen, DEFAULT_RELIEF_OPTIONS, (o) => o.carveDepthMm);

  const bed = useBedProbe(() => set('applyMeshLeveling', true));
  const { probedGrid } = bed;

  // Sampling the surface and dilating it by the cutter is a few hundred
  // milliseconds of solid work, and on a large relief at a fine stepover a good
  // deal more — enough to freeze the tab if it ran on the main thread. It runs
  // on a worker instead, and the modal keeps the last carve it finished on
  // screen while the next is on its way.
  const { result, busy, failure } = useExportJob(
    isOpen,
    (client) =>
      client.run('relief', scene, {
        ...settled,
        // The connected machine's own acceleration and traverse limits, so the
        // run-time estimate sharpens from a guess into a measurement the moment
        // the USB lead goes in.
        motionProfile: machineState.motion,
        meshLevelGrid: probedGrid,
        applyMeshLeveling: settled.applyMeshLeveling && probedGrid !== null,
      }),
    [scene, settled, probedGrid, machineState.motion]
  );

  // Tooling is a function of the carve, not of the model, so it is derived from
  // what the carve actually came out as — the relief's real depth and the plan
  // it landed on — rather than shipped alongside the mesh.
  const applyRecommendedTooling = () => {
    if (!result?.success) return;
    // Clearing the overrides is the point as much as the tooling is: a feed
    // typed for the old bit must not survive a change of bit.
    setOverrides({});
    setOptions((prev) => ({
      ...prev,
      // Tooling only. Feeds and speeds follow from it and are derived rather
      // than stored, so the ones this returns are dropped instead of being
      // written into state where they would sit shadowed and misleading.
      ...toolingOnly(recommendReliefTooling({
        reliefDepthMm: result.reliefDepthMm,
        planWidthMm: result.carveBounds.maxX - result.carveBounds.minX,
        planDepthMm: result.carveBounds.maxY - result.carveBounds.minY,
        material: prev.material,
        // What this spindle can be dialled to, from the controller when it said.
        spindle: machineState.motion.spindle,
        maxFeedMmMin: cuttingRateLimit,
      })),
    }));
  };

  if (!isOpen) return null;

  const swaps = !!result?.toolChange;
  const preflight = {
    material: materialLabel,
    firstTool: settled.roughingEnabled ? roughTool : finishTool,
    secondTool: swaps ? finishTool : undefined,
    // Only worth saying when the number in the box is not the number the
    // material and the bit ask for, or when the recommendation itself had to
    // give something up.
    caveat: speedNote,
  };

  const canCarve = !!result?.success && machineState.connected && machineState.status === 'IDLE';

  const handleStartCarve = () => {
    if (!result?.gcode) return;
    void webSerialManager.runJob(result.gcode, {
      name: 'Relief carve',
      estimatedSeconds: result.estimatedTimeSeconds,
    });
  };

  const handleFrameTrace = async () => {
    if (!result?.carveBounds) return;
    // A carve is always a router, and it frames at the same clearance height
    // the toolpath itself retracts to.
    await webSerialManager.frameJob(result.carveBounds, 0, {
      laserMode: false,
      safeZMm: options.safeZ,
    });
  };

  /**
   * Probes the bed across the carve's own footprint. A relief's finishing pass
   * can be a couple of tenths deep at its shallowest, so a bed half a millimetre
   * out of true is the difference between a surface and a scratch.
   */
  const handleProbeBed = () => {
    if (!result?.carveBounds) return;
    void bed.probe(result.carveBounds);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg">
              <Mountain className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Carve 3D Relief on CNC
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Squash the model's height into the face of a block and cut it over WebSerial USB (GRBL / Marlin)
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

          {/* Stock & relief */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Stock &amp; Relief</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-3"
                label="Stock Block (mm)"
                hint="Width, depth and thickness of the block clamped on the bed. The job's origin is the near-left corner of its top face, so zero the machine there before you start. The whole carve runs +X and +Y from zero."
              >
                <div className="flex items-center space-x-1.5">
                  <NumberInput
                    step={10} min={10} max={2000}
                    value={options.stockWidthMm}
                    onChange={(v) => set('stockWidthMm', v)}
                    className={`${inputClass} px-2`}
                    aria-label="Stock width in mm"
                  />
                  <span className="text-xs font-medium text-slate-400">&times;</span>
                  <NumberInput
                    step={10} min={10} max={2000}
                    value={options.stockDepthMm}
                    onChange={(v) => set('stockDepthMm', v)}
                    className={`${inputClass} px-2`}
                    aria-label="Stock depth in mm"
                  />
                  <span className="text-xs font-medium text-slate-400">&times;</span>
                  <NumberInput
                    step={1} min={1} max={300}
                    value={options.stockThicknessMm}
                    onChange={(v) => set('stockThicknessMm', v)}
                    className={`${inputClass} px-2`}
                    aria-label="Stock thickness in mm"
                  />
                </div>
              </Field>

              {/* Material is set once, in the status bar, and every export reads
                  it from there — it describes what is clamped on the bed rather
                  than anything about this carve. Named here anyway, because
                  every feed and speed below is derived from it and a number
                  whose origin is off-screen looks arbitrary. */}
              <Field
                className="lg:col-span-3"
                label="Material"
                hint="What is clamped on the bed, chosen in the status bar along the bottom of the window. Every feed and speed follows from it: surface speed over cutter diameter gives the spindle RPM, and chip-per-tooth times teeth times RPM gives the feed. 18,000 RPM is right for pine and ruinous for aluminium, and nothing about a mesh can tell the difference."
              >
                <div className={`${inputClass} flex items-center justify-between`}>
                  <span className="font-semibold">
                    {MATERIALS.find((m) => m.id === options.material)?.label ?? options.material}
                  </span>
                  <span className="text-[10px] text-slate-500">set in the status bar</span>
                </div>
              </Field>

              <Field
                className="lg:col-span-2"
                label="Height Scale"
                hint="Fill Depth stretches the model's height range onto the relief depth, so the carve is always exactly that deep, but Z is then unrelated to X and Y and fitting onto smaller stock raises the exaggeration. Proportional puts Z on the plan scale, so the carve keeps the model's shape and the exaggeration is the number you set."
              >
                <Segmented
                  value={options.verticalScaleMode}
                  onChange={(v) => set('verticalScaleMode', v)}
                  options={[['fill', 'Fill Depth'], ['proportional', 'Proportional']] as const}
                />
              </Field>


              <Field
                label="Relief Depth (mm)"
                hint="How deep the lowest point of the carve sits below the top face. The model's whole height is compressed into this."
              >
                <NumberInput
                  step={1} min={0.5} max={200}
                  value={options.carveDepthMm}
                  onChange={(v) => set('carveDepthMm', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Background"
                hint="What happens to the stock the model does not cover. Carve takes it down to the floor so the model stands proud of a flat field; Leave keeps it at full height and only cuts where the model dips, which is far quicker."
              >
                <Segmented
                  value={options.backgroundMode}
                  onChange={(v) => set('backgroundMode', v)}
                  options={[['carve', 'Carve Away'], ['skip', 'Leave At Top']] as const}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Relief Polarity"
                hint="Standard (Cameo) raises peaks toward the stock surface. Invert (Intaglio / Mold) carves peaks deepest into the block as negative cavities, for casting molds or sunken engravings."
              >
                <Segmented
                  value={options.invertRelief ? 'invert' : 'normal'}
                  onChange={(v) => set('invertRelief', v === 'invert')}
                  options={[['normal', 'Cameo (Raised)'], ['invert', 'Intaglio (Sunken)']] as const}
                />
              </Field>



              <Field
                className="lg:col-span-3"
                hintAlign="end"
                label="Fitted Size"
                hint="The footprint the carve actually occupies on the stock at the current scale."
              >
                <div className="px-3 py-1.5 text-xs font-mono text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg">
                  {result?.success
                    ? `${(result.carveBounds.maxX - result.carveBounds.minX).toFixed(1)} × ` +
                      `${(result.carveBounds.maxY - result.carveBounds.minY).toFixed(1)} mm ` +
                      `at ${(result.scaleFactor * 100).toFixed(0)}%`
                    : '—'}
                </div>
              </Field>
            </div>
            <Advanced>
              <Field
                label="Exaggeration (×)"
                hint="How much the height is stretched relative to the plan when using Model Proportions. 1 is the model's own shape. Terrain wants more than that, since real mountains over a map-sized plan are a flat board."
              >
                <NumberInput
                  step={0.5} min={0.01} max={100}
                  value={options.verticalExaggeration}
                  onChange={(v) => set('verticalExaggeration', v)}
                  className={inputClass}
                  disabled={options.verticalScaleMode !== 'proportional'}
                />
              </Field>
              <Field
                className="lg:col-span-2"
                label="Plan Scale"
                hint="Fit to Stock sizes the model to the block. Manual holds a fixed scale, where 100% means one metre of scene is one millimetre of stock. Anything hanging over the edge is cropped."
              >
                <Segmented
                  value={options.fitMode}
                  onChange={(v) => set('fitMode', v)}
                  options={[['fit', 'Fit to Stock'], ['manual', 'Manual']] as const}
                />
              </Field>
              <Field
                label="Scale (%)"
                hint="Manual plan-view scale. The relief depth is set separately, so changing this does not change how deep the carve goes."
              >
                <NumberInput
                  step={5} min={1} max={1000}
                  disabled={options.fitMode !== 'manual'}
                  value={options.scalePercent}
                  onChange={(v) => set('scalePercent', v)}
                  className={inputClass}
                />
              </Field>
            </Advanced>
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
            passCount={result?.success ? result.finishingRasterLines : null}
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

          {/* Toolpath preview */}
          {result?.success && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
                <span className="flex items-center space-x-1.5 font-medium">
                  <Layers className="w-4 h-4 text-blue-500" />
                  <span>{result.finishingRasterLines} finishing passes</span>
                </span>
                <span>{result.roughingPassCount} roughing layers</span>
                <span className="font-mono bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded text-[10px] uppercase font-bold text-blue-600 dark:text-blue-400">
                  Est. Time: {formatDuration(result.estimatedTimeSeconds)}
                  ({(result.totalCutDistanceMm / 1000).toFixed(1)} m cut)
                </span>
                {result.toolChange && (
                  <span className="text-amber-600 dark:text-amber-400 font-medium">
                    Pauses for a tool change between passes
                  </span>
                )}
                {(busy || pending) && <span className="text-slate-400 italic">recalculating…</span>}
              </div>

              <ToolpathView result={result} options={settled} machineState={machineState} />

              <div className="flex items-center space-x-4 text-[11px] text-slate-500 dark:text-slate-400">
                <span>Right-drag orbits, middle-drag pans, scroll zooms, the same as the scene view. The wireframe box is the stock.</span>
              </div>
            </div>
          )}

          {/* Nothing has come back yet (an unsuccessful result shows the error
              card instead): keep the box on screen with a note rather than
              collapsing the dialog until the first carve arrives. */}
          {!result && !failure && (
            <PreviewPlaceholder label="Calculating the carve…" />
          )}

          {/* What this job needs of the machine.
              Connecting, homing and zeroing are the machine's business rather
              than this carve's, and live in the setup dialog off the status
              bar. What is left here is what cannot be answered without the
              job: which cutters it wants, and whether its outline lands on the
              stock. */}

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
                  title="Trace the carve's outline so you can check it lands on the stock"
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

            <MachineFaultBanner machineState={machineState} />

            {/* The pause prompt belongs with the machine, not a scroll above
                it: a carve stopped for its tool change said so in one place and
                offered the way out of it in another. */}
            <JobPauseBanner machineState={machineState} resumeLabel="Resume Carve (Cycle Start)" />

            {/* A relief is the longest job this app produces and the one that
                hurts most to restart from scratch. */}
            <JobResumeBanner machineState={machineState} />

            {/* Takes over from the preflight checklist the moment the job
                starts: this modal covers the status bar's progress readout, so
                without it a running carve reports nothing at all. */}
            <JobProgress machineState={machineState} />

            <JobPreflight
              machineState={machineState}
              tool={preflight.firstTool}
              secondTool={preflight.secondTool}
              rpm={settled.spindleRpm}
              material={preflight.material}
              origin="the near-left corner of the stock's top face"
              caveat={preflight.caveat}
              extent={result?.bounds}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden lg:block text-xs text-slate-500 dark:text-slate-400">
            Zero the machine on the near-left corner of the stock's top face, then carve.
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
                canStart={canCarve}
                onStart={handleStartCarve}
                startLabel="Start Carving"
              />
            ) : (
              /* Opens the shared setup rather than connecting here: which wire
                 to use — the USB cable or a Tekno Box over WiFi — is a choice
                 that lives there, and a button that silently picked USB would
                 be wrong for half the benches. */
              <button
                onClick={() => setMachineConfigOpen(true)}
                className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-blue-500 hover:bg-blue-600 text-slate-950 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
              >
                <Cpu className="w-4 h-4" />
                <span>Connect CNC to Carve</span>
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
