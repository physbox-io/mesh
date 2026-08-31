import React, { useState, useMemo, useEffect } from 'react';
import {
  X, Download, AlertCircle, Layers, Mountain, Cpu, RefreshCw, Info, ChevronRight,
} from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import { exportContourSliceSvg, type ContourSliceOptions } from '../utils/contourSliceExporter';
import { generateContourSliceGcode, DEFAULT_GCODE_OPTIONS } from '../utils/gcodeExporter';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { NumberInput } from './NumberInput';
import { useStore } from '../store/useStore';
import { JobPauseBanner, JobPreflight, JobResumeBanner, JobTransport } from './MachineJobControls';
import { MachineFaultBanner } from './MachineFaultBanner';
import { formatDuration } from '../utils/timeEstimate';
import {
  MATERIALS,
  describeSpeedRecommendation,
  materialSpec,
  recommendSpeeds,
} from '../utils/feedsAndSpeeds';

interface ExportContourSliceModalProps {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
  /** Opens the app's zeroing walkthrough from the machine panel. */
}

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-emerald-500 focus:outline-none disabled:opacity-40';

const labelClass = 'text-xs font-semibold text-slate-600 dark:text-slate-300';

const sectionClass =
  'p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-4';

const sectionTitleClass =
  'text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

/**
 * Hover/focus bubble that explains one control, so the labels can stay short.
 *
 * It is positioned against the field's label row rather than the icon, so it
 * starts at the cell's own left edge and a narrow screen cannot push it out of
 * view. Fields in the last column pass `hintAlign="end"` to open leftward: an
 * absolutely positioned child still counts towards its scroll container's
 * width, and a bubble hanging off the right drags a horizontal scrollbar under
 * the whole modal.
 */
const hintBubbleClass =
  'pointer-events-none absolute top-full z-30 mt-1.5 w-max max-w-[min(14rem,70vw)] rounded-lg ' +
  'bg-slate-900 dark:bg-slate-950 px-2.5 py-2 text-[11px] font-normal leading-snug text-slate-100 ' +
  'shadow-xl ring-1 ring-slate-700 opacity-0 transition-opacity ' +
  'group-hover:opacity-100 group-focus-within:opacity-100';

function HintIcon() {
  return (
    <Info
      className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 hover:text-emerald-500 cursor-help"
      tabIndex={0}
      aria-label="What is this?"
    />
  );
}

function Field({
  label, hint, hintAlign = 'start', className, children,
}: {
  label: string;
  hint: string;
  hintAlign?: 'start' | 'end';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col min-w-0 ${className ?? ''}`}>
      <div className="group relative flex items-center space-x-1 mb-1.5">
        <label className={labelClass}>{label}</label>
        <HintIcon />
        <span role="tooltip" className={`${hintBubbleClass} ${hintAlign === 'end' ? 'right-0' : 'left-0'}`}>
          {hint}
        </span>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

/**
 * Collapsed tail of a section, holding the controls whose defaults are already
 * right for most jobs. The point is that a first-time user can read a section
 * top to bottom without meeting kerf compensation or GRBL's `$30`.
 */
function Advanced({ label = 'Advanced', children }: { label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center space-x-1 text-[11px] font-bold uppercase tracking-wider text-slate-400
                   dark:text-slate-500 hover:text-emerald-600 dark:hover:text-emerald-400 cursor-pointer transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">{children}</div>
      )}
    </div>
  );
}

/**
 * A two- or three-way switch that fits the column it is put in.
 *
 * `min-w-0` and `truncate` rather than `whitespace-nowrap`: a flex child will
 * not shrink below its content's width unless it is told it may, so a label a
 * few characters too long for its grid cell used to push the whole control out
 * past the field beside it. Now it ellipsizes instead, and the `title` keeps
 * the full text reachable.
 *
 * That is the backstop, not the plan — a label people have to hover to read is
 * a label that is too long. Keep them short enough that the ellipsis never
 * appears at the widths these grids actually use.
 */
function Segmented<T extends string>({
  value, options, onChange,
}: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="flex bg-slate-200 dark:bg-slate-700/60 p-0.5 rounded-lg">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          title={label}
          className={`flex-1 min-w-0 py-1 px-2 rounded-md text-xs font-medium transition-all truncate ${
            value === v
              ? 'bg-white dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export const ExportContourSliceModal: React.FC<ExportContourSliceModalProps> = ({
  isOpen,
  onClose,
  scene,
  }) => {
  const [materialThicknessMm, setMaterialThicknessMm] = useState(3.0);
  const [layerOverride, setLayerOverride] = useState('');
  const [slicePosition, setSlicePosition] = useState<ContourSliceOptions['slicePosition']>('middle');
  const [kerfMm, setKerfMm] = useState(0.15);
  const [pinCount, setPinCount] = useState(2);
  const [pinDiameterMm, setPinDiameterMm] = useState(3.0);
  const [sheetWidthMm, setSheetWidthMm] = useState<number>(600);
  const [sheetHeightMm, setSheetHeightMm] = useState<number>(400);
  const [autoScale, setAutoScale] = useState<boolean>(false);
  const [maxSheets, setMaxSheets] = useState<number>(2);
  const [customScalePct, setCustomScalePct] = useState<number>(100);
  const [annotations, setAnnotations] = useState<'all' | 'sheets' | 'none'>('all');
  const [preview, setPreview] = useState<'sheets' | 'map'>('sheets');

  // G-Code & WebSerial States
  /*
   * The machine and the material describe the bench, not this export, so they
   * are chosen once in the status bar and read from the store here. They used
   * to be local state in each modal, which let a laser cut and a contour slice
   * of the same scene disagree about what they were being cut on.
   */
  const machineMode = useStore((s) => s.machineTarget);
  const material = useStore((s) => s.material);
  const setMachineConfigOpen = useStore((s) => s.setMachineConfigOpen);
  /** What is on the bed. Routing feeds and spindle speed both come from it. */
  /**
   * Spindle speed, or null to take the one the material and the bit imply.
   *
   * Null by default because this is not a number a beginner should have to
   * produce: it is surface speed over cutter diameter, and getting it wrong
   * burns the work. Someone who wants to override it can, under Advanced.
   */
  const [spindleRpmOverride, setSpindleRpmOverride] = useState<number | null>(null);
  /**
   * Cutting feed, or null to take the one the material and the bit imply.
   *
   * Null by default in routing mode for the same reason the spindle speed is:
   * feed is chip-per-tooth times teeth times RPM, and a beginner asked to pick
   * one in a box will pick the number that was already there. The laser keeps a
   * plain default, since a beam has no chipload.
   */
  const [cutFeedrateOverride, setCutFeedrateOverride] = useState<number | null>(null);
  /** Cutter diameter, for the feeds-and-speeds arithmetic in routing mode. */
  const [bitDiameterMm, setBitDiameterMm] = useState<number>(3.175);
  const [laserMaxPower, setLaserMaxPower] = useState<number>(DEFAULT_GCODE_OPTIONS.laserMaxPower);
  const [laserPower, setLaserPower] = useState<number>(DEFAULT_GCODE_OPTIONS.laserPower);
  const [laserPasses, setLaserPasses] = useState<number>(1);
  const [attachments, setAttachments] = useState<boolean>(DEFAULT_GCODE_OPTIONS.attachmentsEnabled);
  const [attachmentWidthMm, setAttachmentWidthMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentWidthMm);
  const [attachmentSpacingMm, setAttachmentSpacingMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentSpacingMm);
  const [attachmentHeightMm, setAttachmentHeightMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentHeightMm);
  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());

  /**
   * What to run the spindle and the feed at, from the material and the cutter.
   *
   * The machine's own `$30`/`$31` bound it when a controller is connected — a
   * recommendation of 24,000 RPM is no use to someone whose spindle tops out at
   * 12,000, and the feed has to come down with it.
   */
  const speeds = useMemo(
    () =>
      recommendSpeeds({
        diameterMm: bitDiameterMm,
        flutes: 2,
        material,
        spindle: machineState.motion.spindle,
        // A cut is a two-axis move, so the slower of X and Y governs it.
        maxFeedMmMin: Math.min(machineState.motion.maxRate.x, machineState.motion.maxRate.y),
      }),
    [bitDiameterMm, material, machineState.motion.spindle, machineState.motion.maxRate]
  );

  const spindleRpm = spindleRpmOverride ?? speeds.rpm;
  const cutFeedrate =
    cutFeedrateOverride ?? (machineMode === 'cnc' ? speeds.feedMmMin : 1200);

  useEffect(() => {
    if (!isOpen) return;
    const unsub = webSerialManager.addListener(setMachineState);
    return () => unsub();
  }, [isOpen]);

  // $30 is a machine setting, not a power change: retarget the S-value so the
  // percentage the user dialled in survives the switch.
  const handleLaserMaxPowerChange = (next: number) => {
    const ceiling = Math.max(1, next);
    const fraction = laserPower / Math.max(1, laserMaxPower);
    setLaserMaxPower(ceiling);
    setLaserPower(Math.max(0, Math.min(ceiling, Math.round(fraction * ceiling))));
  };

  const exportResult = useMemo(() => {
    if (!isOpen) return null;
    const override = parseInt(layerOverride, 10);
    return exportContourSliceSvg(scene, {
      materialThickness: materialThicknessMm / 1000,
      sliceCount: Number.isFinite(override) && override > 0 ? override : null,
      slicePosition,
      kerf: kerfMm / 1000,
      pinHoles: pinCount > 0,
      pinCount,
      pinDiameter: pinDiameterMm / 1000,
      sheetWidth: Math.max(0.05, sheetWidthMm / 1000),
      sheetHeight: Math.max(0.05, sheetHeightMm / 1000),
      scaleFactor: customScalePct / 100,
      autoScale,
      maxSheets: autoScale ? maxSheets : 0,
      includeLabels: annotations === 'all',
      includeSheetOutline: annotations !== 'none',
    });
  }, [isOpen, scene, materialThicknessMm, layerOverride, slicePosition, kerfMm,
      pinCount, pinDiameterMm, sheetWidthMm, sheetHeightMm, customScalePct, autoScale, maxSheets, annotations]);

  // Compute G-Code output result
  const gcodeResult = useMemo(() => {
    if (!exportResult?.success || !exportResult.layers) return null;
    return generateContourSliceGcode(exportResult, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode,
      cutFeedrate,
      spindleRpm,
      motionProfile: machineState.motion,
      laserPower,
      laserMaxPower,
      laserPasses,
      cutDepthZ: materialThicknessMm,
      zStepdown: Math.min(materialThicknessMm, 3.0),
      attachmentsEnabled: attachments,
      attachmentWidthMm,
      attachmentSpacingMm,
      attachmentHeightMm,
      bitDiameterMm,
    });
  }, [exportResult, machineMode, cutFeedrate, spindleRpm, machineState.motion, laserPower, laserMaxPower, laserPasses, materialThicknessMm,
      attachments, attachmentWidthMm, attachmentSpacingMm, attachmentHeightMm, bitDiameterMm]);

  const previewSvg = useMemo(() => {
    if (!exportResult?.success) return '';
    if (preview === 'map') return exportResult.mapSvg || '';
    return (exportResult.svg || '')
      .replace(/<svg width="[^"]*" height="[^"]*"/, '<svg width="100%"')
      .replace(/stroke-width="0.2"/, 'stroke-width="0.9"');
  }, [exportResult, preview]);

  if (!isOpen) return null;

  const handleDownloadSvg = () => {
    if (!exportResult?.success || !exportResult.svg) return;
    const blob = new Blob([exportResult.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `contour_slices_${exportResult.layers?.length ?? 0}x${materialThicknessMm}mm.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };


  const handleStartJob = () => {
    if (!gcodeResult?.gcode) return;
    void webSerialManager.runJob(gcodeResult.gcode, {
      name: 'Contour slices',
      estimatedSeconds: gcodeResult.estimatedTimeSeconds,
    });
  };

  const handleFrameTrace = async () => {
    if (!gcodeResult?.bounds) return;
    await webSerialManager.frameJob(gcodeResult.bounds, machineMode === 'laser' ? 5 : 0);
  };

  const mm = (m?: number) => `${((m ?? 0) * 1000).toFixed(0)} mm`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-lg">
              <Mountain className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Export Contour Slices
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Cut the model into stacked layers — download the SVG, or cut straight from here over WebSerial USB
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
          {/* Machine & material */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Machine &amp; Material</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label="Target Cutter Type"
                hint="Chosen in the status bar along the bottom of the window, because it is the same machine for every export. Laser fires a beam and cuts sharp inside corners. CNC spins an end mill, so it needs corner relief and cuts in depth passes."
              >
                <div className={`${inputClass} flex items-center justify-between`}>
                  <span className="font-semibold">{machineMode === 'laser' ? 'Laser Cutter' : 'CNC Router'}</span>
                  <span className="text-[10px] text-slate-500">set in the status bar</span>
                </div>
              </Field>

              <Field
                label="Thickness (mm)"
                hint="Thickness of the stock. Each layer is one sheet thick, so this also sets how far apart the model is sliced."
              >
                <NumberInput
                  step="0.5" min={0.1} max={50}
                  value={materialThicknessMm}
                  onChange={setMaterialThicknessMm}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Material"
                hint="What is on the bed, chosen in the status bar. In routing mode it sets the spindle speed and the feed: surface speed over cutter diameter gives the RPM, and chip-per-tooth times teeth times RPM gives the feed. Both are shown under Before You Start once a machine is connected."
              >
                <div className={`${inputClass} flex items-center justify-between`}>
                  <span className="font-semibold">
                    {MATERIALS.find((m) => m.id === material)?.label ?? material}
                  </span>
                  <span className="text-[10px] text-slate-500">set in the status bar</span>
                </div>
              </Field>


              <Field
                label="Laser Power"
                hint={`Beam power as a GRBL S-value — currently ${Math.round((laserPower / Math.max(1, laserMaxPower)) * 100)}% of this machine's S${laserMaxPower} maximum. Ignored on a CNC router.`}
              >
                <NumberInput
                  step={laserMaxPower >= 10000 ? 500 : 50} min={0} max={laserMaxPower} integer
                  disabled={machineMode !== 'laser'}
                  value={laserPower}
                  onChange={setLaserPower}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Passes"
                hint="How many times the laser retraces each contour. Raise it when one pass scores but does not cut through; slowing the feedrate is the other lever."
              >
                <NumberInput
                  step="1" min={1} max={20} integer
                  disabled={machineMode !== 'laser'}
                  value={laserPasses}
                  onChange={setLaserPasses}
                  className={inputClass}
                />
              </Field>

              <Field
                hintAlign="end"
                label="Layers"
                hint="Leave empty to slice one layer per sheet thickness — the stack then matches the model's height. A number overrides that, which stretches or squashes the finished stack."
              >
                <input
                  type="number" min="1" max="600"
                  placeholder={`auto (${exportResult?.layers?.length ?? 0})`}
                  value={layerOverride}
                  onChange={(e) => setLayerOverride(e.target.value)}
                  className={inputClass}
                />
              </Field>
            </div>

            {machineMode === 'cnc' && (
              <div className="rounded-lg bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2.5 py-2">
                <span className="text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">
                  Derived for {materialSpec(material).label.toLowerCase()}
                </span>
                <p className="mt-0.5 font-mono text-[11px] text-slate-800 dark:text-slate-100">
                  {spindleRpm.toLocaleString()} RPM · {cutFeedrate} mm/min ·{' '}
                  {speeds.chiploadMm.toFixed(3)} mm per tooth
                </p>
                {speeds.clampedBy && (
                  <p className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400 leading-snug">
                    <AlertCircle className="w-3 h-3 mt-px flex-shrink-0" />
                    <span>{describeSpeedRecommendation(speeds, material, bitDiameterMm)}</span>
                  </p>
                )}
              </div>
            )}

            <Advanced label="Advanced — override the derived feeds">
              <Field
                label="Feedrate (mm/m)"
                hint="How fast the head travels while cutting, in mm per minute. It also drives the estimated job time."
              >
                <NumberInput
                  step="100" min={100} max={10000} integer
                  allowEmpty
                  placeholder={String(machineMode === 'cnc' ? speeds.feedMmMin : 1200)}
                  value={cutFeedrateOverride}
                  onChange={setCutFeedrateOverride}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Spindle (RPM)"
                hint="Routing only. Blank takes the speed the material and the cutter imply — surface speed over diameter — which is almost always the right answer. Set a number only if your spindle disagrees, and remember that on a router with a dial the S word in the file does nothing: this is what you turn the knob to."
              >
                <NumberInput
                  step="1000" min={0} max={60000} integer
                  disabled={machineMode !== 'cnc'}
                  allowEmpty
                  placeholder={String(speeds.rpm)}
                  value={spindleRpmOverride}
                  onChange={setSpindleRpmOverride}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Bit Ø (mm)"
                hint="Routing only. The cutter that will do the cutting — it is what the spindle speed and the feed are worked out from, since both scale with diameter."
              >
                <NumberInput
                  step="0.1" min={0.1} max={30}
                  disabled={machineMode !== 'cnc'}
                  value={bitDiameterMm}
                  onChange={setBitDiameterMm}
                  className={inputClass}
                />
              </Field>
              <Field
                className="lg:col-span-2"
                label="Max S-value ($30)"
                hint="Your controller's maximum spindle/laser S-value. Most diode boards ship 10000; stock GRBL is 1000. Getting it too low is what makes a strong laser act weak — send S1000 to a 10000 machine and you get 10% power. Run $$ on the machine and match its $30 line."
              >
                <select
                  disabled={machineMode !== 'laser'}
                  value={laserMaxPower}
                  onChange={(e) => handleLaserMaxPowerChange(parseInt(e.target.value) || 10000)}
                  className={`${inputClass} font-sans cursor-pointer`}
                >
                  <option value={10000}>10000 (most diode boards)</option>
                  <option value={1000}>1000 (stock GRBL)</option>
                  <option value={255}>255</option>
                </select>
              </Field>

              <Field
                label="Kerf (mm)"
                hint="Width of material the beam or bit removes. Contours are offset by half of it so each layer comes out at its true size."
              >
                <NumberInput
                  step="0.05" min={0} max={2}
                  value={kerfMm}
                  onChange={setKerfMm}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                label="Attachments"
                hint="Leaves short stretches of each contour uncut, so a cut layer stays held in the sheet instead of dropping out or shifting mid-job. You snap or pare them off before gluing the stack. Affects the G-code only; the SVG download is unchanged."
              >
                <Segmented
                  value={attachments ? 'on' : 'off'}
                  onChange={(v) => setAttachments(v === 'on')}
                  options={[['off', 'Cut Free'], ['on', 'Hold In Sheet']] as const}
                />
              </Field>

              <Field
                label="Attach Size (mm)"
                hint="How long each attachment is along a contour. Big enough to hold the layer, small enough to snap — 2-5 mm suits thin ply and card."
              >
                <NumberInput
                  step="0.5" min={0.5} max={30}
                  disabled={!attachments}
                  value={attachmentWidthMm}
                  onChange={setAttachmentWidthMm}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Attach Every (mm)"
                hint="Target spacing between attachments around a contour. A contour too short for even one at this spacing gets none, and they are never packed closer than half the run they sit in."
              >
                <NumberInput
                  step="10" min={5} max={1000}
                  disabled={!attachments}
                  value={attachmentSpacingMm}
                  onChange={setAttachmentSpacingMm}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Attach Depth (mm)"
                hintAlign="end"
                hint="CNC only: stock left under the bit as it rides over an attachment. The cutter ramps up and back down so it never plunges into uncut material. A laser has no Z, so it just stops firing for the attachment's length."
              >
                <NumberInput
                  step="0.1" min={0.1} max={10}
                  disabled={!attachments || machineMode !== 'cnc'}
                  value={attachmentHeightMm}
                  onChange={setAttachmentHeightMm}
                  className={inputClass}
                />
              </Field>
            </Advanced>
          </div>

          {/* Slicing & alignment */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Slicing &amp; Alignment</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-3"
                label="Sample Height"
                hint="Where inside its own slab each layer is measured. Bottom keeps every layer at least as big as the model (good for sanding back), top undercuts it, middle splits the difference."
              >
                <Segmented
                  value={slicePosition}
                  onChange={setSlicePosition}
                  options={[['bottom', 'Bottom'], ['middle', 'Middle'], ['top', 'Top']] as const}
                />
              </Field>

              <Field
                label="Dowels"
                hint="Alignment holes cut through every layer so the stack cannot shift as you glue it. Optional — set None to glue up freehand against the printed layer map."
              >
                <select
                  value={pinCount}
                  onChange={(e) => setPinCount(parseInt(e.target.value, 10))}
                  className={`${inputClass} font-sans cursor-pointer`}
                >
                  <option value={0}>None (glue only)</option>
                  <option value={1}>1 pin</option>
                  <option value={2}>2 pins</option>
                  <option value={3}>3 pins</option>
                </select>
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Dowel ⌀ (mm)"
                hint="Diameter of the rod you will thread the stack onto. Holes are cut a kerf undersize so the dowel is a push fit. A dowel only fits where every layer has material to spare around it."
              >
                <NumberInput
                  step="0.5" min={0.5} max={20}
                  disabled={pinCount === 0}
                  value={pinDiameterMm}
                  onChange={setPinDiameterMm}
                  className={inputClass}
                />
              </Field>
            </div>
          </div>

          {/* Sheet & nesting */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Sheet &amp; Nesting</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label="Sheet Size (mm)"
                hint="Usable cutting area of one sheet of stock, width by height. Layers are nested left to right; when a row no longer fits, nesting starts a new sheet below."
              >
                <div className="flex items-center space-x-1.5">
                  <NumberInput
                    step="10" min={50} max={5000}
                    value={sheetWidthMm}
                    onChange={setSheetWidthMm}
                    className={`${inputClass} px-2`}
                    aria-label="Sheet width in mm"
                  />
                  <span className="text-xs font-medium text-slate-400">&times;</span>
                  <NumberInput
                    step="10" min={50} max={5000}
                    value={sheetHeightMm}
                    onChange={setSheetHeightMm}
                    className={`${inputClass} px-2`}
                    aria-label="Sheet height in mm"
                  />
                </div>
              </Field>

              <Field
                className="lg:col-span-2"
                label="Auto-Scale Mode"
                hint="Manual keeps the model at the scale you set. Auto-Fit searches for the largest scale whose nested layers still land within the sheet limit."
              >
                <Segmented
                  value={autoScale ? 'auto' : 'manual'}
                  onChange={(v) => setAutoScale(v === 'auto')}
                  options={[['manual', 'Manual'], ['auto', 'Auto-Fit']] as const}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Max Sheet Limit"
                hint="How many sheets of stock the job may use. Auto-Fit shrinks the model until every layer fits within this many."
              >
                <div className="flex items-center space-x-2">
                  <NumberInput
                    min={1} max={20} step="1" integer
                    disabled={!autoScale}
                    value={maxSheets}
                    onChange={setMaxSheets}
                    className={`${inputClass} px-2`}
                  />
                  <span className="text-xs text-slate-500 font-medium whitespace-nowrap">sheet(s)</span>
                </div>
              </Field>

              <div className="flex flex-col min-w-0 lg:col-span-3">
                <div className="group relative flex justify-between items-center mb-1.5">
                  <div className="flex items-center space-x-1">
                    <label className={labelClass}>Scale Factor ({customScalePct}%)</label>
                    <HintIcon />
                  </div>
                  {exportResult?.scaleFactor && Math.abs(exportResult.scaleFactor - 1.0) > 1e-3 && (
                    <span className="text-[10px] font-bold text-emerald-600 dark:text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded">
                      Active: {(exportResult.scaleFactor * 100).toFixed(0)}%
                    </span>
                  )}
                  <span role="tooltip" className={`${hintBubbleClass} left-0`}>
                    Manual scale applied to the model before slicing. The layer count follows the model's
                    height, so scaling down cuts smaller — and fewer — layers.
                  </span>
                </div>
                <input
                  type="range" min="10" max="200" step="5"
                  disabled={autoScale}
                  value={customScalePct}
                  onChange={(e) => setCustomScalePct(parseInt(e.target.value) || 100)}
                  className="mt-auto w-full h-1.5 bg-slate-300 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-emerald-500 disabled:opacity-40"
                />
              </div>

            </div>
            <Advanced>
              <Field
                className="lg:col-span-3"
                hintAlign="end"
                label="Annotations"
                hint="What the SVG carries besides cut lines. Layer numbers and sheet outlines are what let you stack the pieces in order, but they are engraved — strip to Cuts only before sending real material."
              >
                <Segmented
                  value={annotations}
                  onChange={setAnnotations}
                  options={[['all', 'Numbers'], ['sheets', 'Outlines'], ['none', 'Cuts only']] as const}
                />
              </Field>
            </Advanced>
          </div>

          {/* Interactive Pause Prompt */}
          <JobPauseBanner
            machineState={machineState}
            resumeLabel="Resume Next Sheet (Cycle Start)"
            showZTools={machineMode === 'cnc'}
          />

          {/* The offer to pick a stopped job back up rather than recut it all */}
          <JobResumeBanner machineState={machineState} showZTools={machineMode === 'cnc'} />

          {exportResult && !exportResult.success && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/40 flex items-start space-x-2 text-xs text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{exportResult.error}</span>
            </div>
          )}

          {exportResult?.success && exportResult.warnings && exportResult.warnings.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-1.5">
              {exportResult.warnings.map((w, i) => (
                <div key={i} className="flex items-start space-x-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Contours the cutter is too fat to follow. Not a fit problem to be
              tuned like the warnings above — this is geometry that will not be
              on the finished stack at all. */}
          {gcodeResult?.warnings && gcodeResult.warnings.length > 0 && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/40 space-y-1.5">
              <div className="text-[10px] uppercase font-semibold tracking-wide text-red-700 dark:text-red-300">
                Left out of the program
              </div>
              {gcodeResult.warnings.map((w, i) => (
                <div key={i} className="flex items-start space-x-2 text-xs text-red-800 dark:text-red-300">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{w}</span>
                </div>
              ))}
            </div>
          )}

          {exportResult?.success && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-slate-600 dark:text-slate-400">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="flex items-center space-x-1.5 font-medium">
                    <Layers className="w-4 h-4 text-emerald-500" />
                    <span>{exportResult.layers?.length ?? 0} layers</span>
                  </span>
                  <span>Sheets: {exportResult.sheetCount}</span>
                  <span>Model {mm(exportResult.modelHeight)} tall → stack {mm(exportResult.stackHeight)}</span>
                  {gcodeResult && (
                    <span className="font-mono bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded text-[10px] uppercase font-bold text-emerald-600 dark:text-emerald-400">
                      Est. Time: {formatDuration(gcodeResult.estimatedTimeSeconds)}
                    </span>
                  )}
                  {attachments && gcodeResult && (
                    <span title="Uncut bridges holding cut layers in the sheet. Snap or pare them off before gluing the stack.">
                      Attachments: {gcodeResult.attachmentCount}
                    </span>
                  )}
                </div>
                <Segmented
                  value={preview}
                  onChange={setPreview}
                  options={[['sheets', 'Cut sheets'], ['map', 'Relief map']] as const}
                />
              </div>

              <div className="w-full h-80 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 p-4 overflow-y-auto overflow-x-hidden">
                <div
                  className="w-full [&>svg]:w-full [&>svg]:h-auto"
                  dangerouslySetInnerHTML={{ __html: previewSvg }}
                />
              </div>
            </div>
          )}

          {/* What this job needs of the machine.
              Connecting, homing, unlocking and zeroing live in the shared
              Machine Setup dialog off the status bar — they describe the
              machine rather than this job, and were repeated identically in
              every export modal. What stays is job-specific: the cutter, where
              the outline falls, and starting it. */}
          <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-white space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center space-x-3">
                <Cpu className="w-5 h-5 text-emerald-400" />
                <div>
                  <h3 className="text-sm font-bold flex items-center space-x-2">
                    <span>Machine</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                      machineState.status === 'RUNNING' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' :
                      machineState.status.startsWith('PAUSED') ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse' :
                      machineState.connected ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {machineState.status}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    {machineState.connected
                      ? `Connected via USB serial (${machineState.portName})`
                      : 'Not connected. Open Machine Setup to connect, home and zero.'}
                  </p>
                </div>
              </div>

              <button
                onClick={() => setMachineConfigOpen(true)}
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500 hover:bg-emerald-600 text-slate-950 flex items-center gap-1.5 cursor-pointer"
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>Machine Setup</span>
              </button>
            </div>

            {machineState.connected && (
              <>
              <MachineFaultBanner machineState={machineState} />
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800">
                <button
                  onClick={handleFrameTrace}
                  disabled={!gcodeResult?.bounds}
                  title="Trace the job's outline so you can check it lands on the sheet"
                  className="py-1.5 px-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Frame Laser</span>
                </button>
                <div className="ml-auto">
                  <JobTransport
                    machineState={machineState}
                    canStart={!!gcodeResult?.success}
                    onStart={handleStartJob}
                    startLabel="Start Cut Job"
                    variant="inline"
                  />
                </div>
              </div>
              <JobPreflight
                machineState={machineState}
                tool={machineMode === 'cnc' ? `${bitDiameterMm} mm flat end mill, 2-flute upcut` : undefined}
                rpm={machineMode === 'cnc' ? spindleRpm : undefined}
                material={materialSpec(material).label.toLowerCase()}
                origin={
                  machineMode === 'cnc'
                    ? "the near-left corner of the sheet's top face"
                    : 'the near-left corner of the sheet'
                }
                caveat={
                  machineMode === 'cnc' && speeds.clampedBy
                    ? describeSpeedRecommendation(speeds, material, bitDiameterMm)
                    : null
                }
                extent={
                  gcodeResult
                    ? {
                        ...gcodeResult.bounds,
                        // A laser has no Z to check; a router sweeps from its
                        // retract height down through the sheet.
                        ...(machineMode === 'cnc'
                          ? { minZ: -materialThicknessMm, maxZ: DEFAULT_GCODE_OPTIONS.safeZ }
                          : {}),
                      }
                    : undefined
                }
              />
              </>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden xl:block text-xs text-slate-500 dark:text-slate-400">
            Stack layers in number order, thread onto dowels, and glue.
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleDownloadSvg}
              disabled={!exportResult?.success}
              className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Download SVG</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
