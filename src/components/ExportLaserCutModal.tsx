import React, { useState, useMemo, useEffect } from 'react';
import {
  X, Download, AlertCircle, Layers, Scissors, Cpu, RefreshCw, Info, ChevronRight,
} from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import { exportLaserCutSvg, type LaserCutOptions } from '../utils/laserCutExporter';
import { generateLaserCutGcode, DEFAULT_GCODE_OPTIONS } from '../utils/gcodeExporter';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { NumberInput } from './NumberInput';
import { useStore } from '../store/useStore';
import { JobPauseBanner, JobPreflight, JobResumeBanner, JobTransport } from './MachineJobControls';
import { formatDuration } from '../utils/timeEstimate';
import {
  MATERIALS,
  describeSpeedRecommendation,
  materialSpec,
  recommendSpeeds,
} from '../utils/feedsAndSpeeds';
import { warpGcode, type ProbeGrid } from '../utils/meshLeveler';

interface ExportLaserCutModalProps {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
  /** Opens the app's zeroing walkthrough from the machine panel. */
}

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-amber-500 focus:outline-none disabled:opacity-40';

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
 * view. Fields in the last column pass `align="end"` to open leftward instead:
 * an absolutely positioned child still counts towards its scroll container's
 * width, and a bubble hanging off the right is what put a horizontal scrollbar
 * under the whole modal.
 */
const hintBubbleClass =
  'pointer-events-none absolute top-full z-30 mt-1.5 w-max max-w-[min(14rem,70vw)] rounded-lg ' +
  'bg-slate-900 dark:bg-slate-950 px-2.5 py-2 text-[11px] font-normal leading-snug text-slate-100 ' +
  'shadow-xl ring-1 ring-slate-700 opacity-0 transition-opacity ' +
  'group-hover:opacity-100 group-focus-within:opacity-100';

function HintIcon() {
  return (
    <Info
      className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 hover:text-amber-500 cursor-help"
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
                   dark:text-slate-500 hover:text-amber-600 dark:hover:text-amber-400 cursor-pointer transition-colors"
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
              ? 'bg-white dark:bg-slate-800 text-amber-600 dark:text-amber-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export const ExportLaserCutModal: React.FC<ExportLaserCutModalProps> = ({
  isOpen,
  onClose,
  scene,
  }) => {
  const [jointMode, setJointMode] = useState<'finger' | 'slot' | 'glue'>('finger');
  const [materialThicknessMm, setMaterialThicknessMm] = useState<number>(3.0);
  const [fingerWidthMm, setFingerWidthMm] = useState<number>(10.0);
  const [kerfMm, setKerfMm] = useState<number>(0.15);
  const [cornerRelief, setCornerRelief] = useState<'none' | 'dogbone' | 'tbone'>('none');
  const [bitDiameterMm, setBitDiameterMm] = useState<number>(3.175);
  const [tabOverhangMm, setTabOverhangMm] = useState<number>(0);
  const [jointClearanceMm, setJointClearanceMm] = useState<number>(0);
  const [sheetWidthMm, setSheetWidthMm] = useState<number>(600);
  const [sheetHeightMm, setSheetHeightMm] = useState<number>(400);
  const [autoScale, setAutoScale] = useState<boolean>(false);
  const [maxSheets, setMaxSheets] = useState<number>(2);
  const [customScalePct, setCustomScalePct] = useState<number>(100);
  const [annotations, setAnnotations] = useState<'all' | 'sheets' | 'none'>('all');

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
  const [laserMaxPower, setLaserMaxPower] = useState<number>(DEFAULT_GCODE_OPTIONS.laserMaxPower);
  const [laserPower, setLaserPower] = useState<number>(DEFAULT_GCODE_OPTIONS.laserPower);
  const [laserPasses, setLaserPasses] = useState<number>(1);
  const [attachments, setAttachments] = useState<boolean>(DEFAULT_GCODE_OPTIONS.attachmentsEnabled);
  const [attachmentWidthMm, setAttachmentWidthMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentWidthMm);
  const [attachmentSpacingMm, setAttachmentSpacingMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentSpacingMm);
  const [attachmentHeightMm, setAttachmentHeightMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentHeightMm);
  const [probedGrid, setProbedGrid] = useState<ProbeGrid | null>(null);
  const [isProbing, setIsProbing] = useState<boolean>(false);
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

  // Compute laser/cnc 2D panel export result
  const exportResult = useMemo(() => {
    if (!isOpen) return null;
    const options: Partial<LaserCutOptions> = {
      jointMode,
      materialThickness: materialThicknessMm / 1000,
      fingerWidth: fingerWidthMm / 1000,
      kerf: kerfMm / 1000,
      cornerRelief,
      bitDiameter: bitDiameterMm / 1000,
      tabOverhang: tabOverhangMm / 1000,
      jointClearance: jointClearanceMm / 1000,
      sheetWidth: Math.max(0.05, sheetWidthMm / 1000),
      sheetHeight: Math.max(0.05, sheetHeightMm / 1000),
      scaleFactor: customScalePct / 100,
      autoScale,
      maxSheets: autoScale ? maxSheets : 0,
      includeLabels: annotations === 'all',
      includeSheetOutline: annotations !== 'none',
    };
    return exportLaserCutSvg(scene, options);
  }, [isOpen, scene, jointMode, materialThicknessMm, fingerWidthMm, kerfMm, cornerRelief, bitDiameterMm, tabOverhangMm, jointClearanceMm, sheetWidthMm, sheetHeightMm, customScalePct, autoScale, maxSheets, annotations]);

  // Compute G-Code output result
  const gcodeResult = useMemo(() => {
    if (!exportResult?.success || !exportResult.panels) return null;
    const res = generateLaserCutGcode(exportResult.panels, {
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

    if (res.success && machineMode === 'cnc' && probedGrid) {
      res.gcode = warpGcode(res.gcode, probedGrid);
    }
    return res;
  }, [exportResult, machineMode, cutFeedrate, spindleRpm, machineState.motion, laserPower, laserMaxPower,
      laserPasses, materialThicknessMm, probedGrid, attachments, attachmentWidthMm, attachmentSpacingMm,
      attachmentHeightMm, bitDiameterMm]);

  // The sheet SVG is written at physical size — a 600 mm sheet is far wider than
  // the modal — so the preview is scaled to the panel instead of being dragged
  // around behind a scrollbar, and its hairlines thickened to stay visible.
  const previewSvg = useMemo(
    () =>
      (exportResult?.svg || '')
        .replace(/<svg width="[^"]*" height="[^"]*"/, '<svg width="100%"')
        .replace(/stroke-width="0.2"/g, 'stroke-width="0.6"'),
    [exportResult]
  );

  if (!isOpen) return null;

  const handleDownloadSvg = () => {
    if (!exportResult || !exportResult.success || !exportResult.svg) return;
    const blob = new Blob([exportResult.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `laser_cnc_export_${jointMode}${cornerRelief === 'none' ? '' : `_${cornerRelief}`}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };


  const handleStartJob = () => {
    if (!gcodeResult?.gcode) return;
    webSerialManager.startJob(gcodeResult.gcode, gcodeResult.estimatedTimeSeconds);
  };

  const handleFrameTrace = async () => {
    if (!gcodeResult?.bounds) return;
    await webSerialManager.frameJob(gcodeResult.bounds, machineMode === 'laser' ? 5 : 0);
  };

  /**
   * Probes the bed across the job's own bounds. The grid it returns is what
   * `warpGcode` rides the Z axis on, so a bed that is not flat still cuts to a
   * constant depth. Routing only — a laser has no Z to correct.
   */
  const handleProbeBed = async () => {
    if (!gcodeResult?.bounds) return;
    setIsProbing(true);
    try {
      setProbedGrid(await webSerialManager.probeGrid(gcodeResult.bounds, 3, 3));
    } finally {
      setIsProbing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-lg">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Export to Laser / CNC
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Unwrap 3D panel faces into 2D cut patterns — download the SVG, or cut straight from here over WebSerial USB (GRBL / Marlin)
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

        {/* Content Body */}
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
                hint="Thickness of the stock you are actually cutting. Finger length, slot depth and CNC cut depth are all derived from it."
              >
                <NumberInput
                  step="0.5" min={0.5} max={50}
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
                hintAlign="end"
                hint="How many times the laser retraces each cut path. Raise it when one pass scores but does not cut through; slowing the feedrate is the other lever."
              >
                <NumberInput
                  step="1" min={1} max={20} integer
                  disabled={machineMode !== 'laser'}
                  value={laserPasses}
                  onChange={setLaserPasses}
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
                className="lg:col-span-2"
                hintAlign="end"
                label="Bit Ø (mm)"
                hint={
                  machineMode === 'cnc'
                    ? 'Diameter of the end mill. In CNC mode every path is offset by half of this — outlines run outside the line and holes inside it — so that the cut edge lands where the model says. Get it wrong and every part is out by the difference.'
                    : 'Diameter of the end mill. It sets how far the relief cuts have to reach into each inside corner. Only read when corner relief is on.'
                }
              >
                <NumberInput
                  step="0.1" min={0.1} max={50}
                  disabled={machineMode !== 'cnc' && cornerRelief === 'none'}
                  value={bitDiameterMm}
                  onChange={setBitDiameterMm}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Feedrate (mm/m)"
                hint="How fast the head travels while cutting, in mm per minute. Slower burns/cuts deeper; it also sets the estimated job time."
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
                hint="Width of material the beam or bit removes. Cut paths are offset by half of it so parts come out at their drawn size."
              >
                <NumberInput
                  step="0.05" min={0} max={2.0}
                  value={kerfMm}
                  onChange={setKerfMm}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                label="Attachments"
                hint="Leaves short stretches of each panel outline uncut, so finished panels stay held in the sheet instead of dropping out or shifting mid-job. You snap or pare them off afterwards. Nothing to do with joint tabs — joint mortises are always cut clean. Affects the G-code only; the SVG download is unchanged."
              >
                <Segmented
                  value={attachments ? 'on' : 'off'}
                  onChange={(v) => setAttachments(v === 'on')}
                  options={[['off', 'Cut Free'], ['on', 'Hold In Sheet']] as const}
                />
              </Field>

              <Field
                label="Attach Size (mm)"
                hint="How long each attachment is along the outline. Big enough to hold the panel, small enough to snap — 2-5 mm suits thin ply and acrylic."
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
                hint="Target spacing between attachments around an outline. An outline too short for even one at this spacing gets none, and they are never packed closer than half the run they sit in."
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

          {/* Joints */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Joints</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-3"
                label="Joint Interlocking"
                hint="Finger joints comb both edges together. Tab & Slot cuts a tab on one panel and a mortise through the other. Glue leaves plain edges."
              >
                <Segmented
                  value={jointMode}
                  onChange={setJointMode}
                  options={[['finger', 'Finger Joints'], ['slot', 'Tab & Slot'], ['glue', 'Glue (Plain)']] as const}
                />
              </Field>

              <Field
                className="lg:col-span-3"
                hintAlign="end"
                label="Tab Width (mm)"
                hint="Nominal width of a single finger along the joint. Wider means fewer, chunkier fingers; narrower gives more glue area but more cutting."
              >
                <NumberInput
                  step="1" min={3} max={50}
                  disabled={jointMode === 'glue'}
                  value={fingerWidthMm}
                  onChange={setFingerWidthMm}
                  className={inputClass}
                />
              </Field>
            </div>

            <Advanced>
              <Field
                className="lg:col-span-3"
                label="Joint Fit (mm)"
                hint="Fit adjustment across each finger. Negative makes tabs wider than their slots for a press fit; positive leaves clearance for glue or a loose fit."
              >
                <NumberInput
                  step="0.05" min={-1} max={1}
                  disabled={jointMode === 'glue'}
                  value={jointClearanceMm}
                  onChange={setJointClearanceMm}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-3"
                hintAlign="end"
                label="Overhang (mm)"
                hint="Extra tab length past flush. At 0 a tab finishes level with the mating panel's outer face; raising it leaves tabs proud so they can be sanded back."
              >
                <NumberInput
                  step="0.5" min={0} max={20}
                  disabled={jointMode === 'glue'}
                  value={tabOverhangMm}
                  onChange={setTabOverhangMm}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-4"
                label="Inside Corner Relief"
                hint="A round end mill cannot cut a sharp inside corner, so a tab will not seat. Dogbone overcuts along the corner bisector; T-Bone hides the same overcut in the wall, keeping the mating face flat. Use None for a laser."
              >
                <Segmented
                  value={cornerRelief}
                  onChange={setCornerRelief}
                  options={[['none', 'Laser (None)'], ['dogbone', 'Dogbone'], ['tbone', 'T-Bone']] as const}
                />
              </Field>

            </Advanced>
          </div>

          {/* Sheet & nesting */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Sheet &amp; Nesting</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label="Sheet Size (mm)"
                hint="Usable cutting area of one sheet of stock, width by height. Panels are nested left to right; when a row no longer fits, nesting starts a new sheet below."
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
                hint="Manual keeps the model at the scale you set. Auto-Fit searches for the largest scale whose finished cut patterns — joints included — still land within the sheet limit."
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
                hint="How many sheets of stock the job may use. Auto-Fit shrinks the model until the nested parts fit within this many sheets."
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
                  <span role="tooltip" className={`${hintBubbleClass} left-0`}>
                    Manual scale applied to the model before nesting. Joint tabs and slots stay sized for
                    your stock thickness, so they do not shrink with it.
                  </span>
                  {exportResult?.scaleFactor && Math.abs(exportResult.scaleFactor - 1.0) > 1e-3 && (
                    <span className="text-[10px] font-bold text-amber-600 dark:text-amber-400 bg-amber-500/10 px-1.5 py-0.5 rounded">
                      Active: {(exportResult.scaleFactor * 100).toFixed(0)}%
                    </span>
                  )}
                </div>
                <input
                  type="range" min="10" max="200" step="5"
                  disabled={autoScale}
                  value={customScalePct}
                  onChange={(e) => setCustomScalePct(parseInt(e.target.value) || 100)}
                  className="mt-auto w-full h-1.5 bg-slate-300 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500 disabled:opacity-40"
                />
              </div>

            </div>
            <Advanced>
              <Field
                className="lg:col-span-3"
                hintAlign="end"
                label="Annotations"
                hint="What the SVG carries besides cut lines. Labels and sheet outlines help you sort parts, but they are engraved/drawn — strip them to Cut paths only before sending real material."
              >
                <Segmented
                  value={annotations}
                  onChange={(v) => setAnnotations(v)}
                  options={[['all', 'Labels'], ['sheets', 'Outlines'], ['none', 'Cuts only']] as const}
                />
              </Field>
            </Advanced>
          </div>

          {/* Interactive Tool / Material Change Pause */}
          <JobPauseBanner
            machineState={machineState}
            resumeLabel="Resume Job (Cycle Start)"
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

          {/* Nesting & joint warnings — these decide whether the cut is usable */}
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

          {/* Features the cutter is too fat to reach. Separate from the nesting
              warnings above because these are not a fit problem to be tuned —
              they are geometry that will not be on the finished part at all. */}
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

          {/* Results SVG Live Preview */}
          {exportResult && exportResult.success && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-600 dark:text-slate-400">
                <div className="flex items-center space-x-4">
                  <span className="flex items-center space-x-1.5 font-medium">
                    <Layers className="w-4 h-4 text-amber-500" />
                    <span>{exportResult.panels?.length || 0} Panels</span>
                  </span>
                  <span>Sheets: {exportResult.sheetCount}</span>
                  {gcodeResult && (
                    <span className="font-mono bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded text-[10px] uppercase font-bold text-amber-600 dark:text-amber-400">
                      Est. Time: {formatDuration(gcodeResult.estimatedTimeSeconds)} ({gcodeResult.totalCutDistanceMm} mm cut)
                    </span>
                  )}
                  {attachments && gcodeResult && (
                    <span title="Uncut bridges holding panels in the sheet. Snap or pare them off after the job.">
                      Attachments: {gcodeResult.attachmentCount}
                    </span>
                  )}
                </div>
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
              Connecting, homing, unlocking and zeroing moved to the shared
              Machine Setup dialog off the status bar — they are the machine's
              business and were repeated identically in every export modal.
              What stays is what cannot be answered without the job: which
              cutter it wants, where its outline falls, and starting it. */}
          <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-white space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center space-x-3">
                <Cpu className="w-5 h-5 text-amber-400" />
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
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-500 hover:bg-amber-600 text-slate-950 flex items-center gap-1.5 cursor-pointer"
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>Machine Setup</span>
              </button>
            </div>

            {machineState.connected && (
              <>
              <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800">
                <button
                  onClick={handleFrameTrace}
                  disabled={!gcodeResult?.bounds}
                  title="Trace the job's outline so you can check it lands on the sheet"
                  className="py-1.5 px-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
                  <span>Frame Laser</span>
                </button>
                {machineMode === 'cnc' && (
                  <button
                    onClick={handleProbeBed}
                    disabled={!gcodeResult?.bounds || isProbing}
                    title={probedGrid
                      ? 'Bed probed — cut depths follow the measured surface'
                      : 'Probe a 3x3 grid over the job so cut depth follows the bed'}
                    className="py-1.5 px-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1 cursor-pointer"
                  >
                    <Layers className={`w-3.5 h-3.5 ${probedGrid ? 'text-emerald-400' : 'text-blue-400'}`} />
                    <span>{isProbing ? 'Probing…' : probedGrid ? 'Bed Levelled' : 'Probe Bed'}</span>
                  </button>
                )}
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
                        // retract height down to the full depth of cut.
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

        {/* Modal Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden 2xl:block text-xs text-slate-500 dark:text-slate-400">
            Vector SVG opens in LightBurn, Inkscape, or any CAM tool — or cut it directly over USB.
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
              disabled={!exportResult || !exportResult.success}
              className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
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
