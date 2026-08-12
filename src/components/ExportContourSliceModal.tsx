import React, { useState, useMemo, useEffect } from 'react';
import { X, Download, AlertCircle, Layers, Mountain, Cpu, Play, Square, Home, ShieldAlert, RefreshCw, Info, ChevronRight } from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import { exportContourSliceSvg, type ContourSliceOptions } from '../utils/contourSliceExporter';
import { generateContourSliceGcode, DEFAULT_GCODE_OPTIONS } from '../utils/gcodeExporter';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { NumberInput } from './NumberInput';
import { MachineWorkOriginPanel } from './MachineWorkOriginPanel';

interface ExportContourSliceModalProps {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
  /** Opens the app's zeroing walkthrough from the machine panel. */
  onOpenDocs?: () => void;
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
function Advanced({ children }: { children: React.ReactNode }) {
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
        <span>Advanced</span>
      </button>
      {open && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">{children}</div>
      )}
    </div>
  );
}

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
          className={`flex-1 py-1 px-2 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
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
  onOpenDocs,
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
  const [machineMode, setMachineMode] = useState<'laser' | 'cnc'>('laser');
  const [cutFeedrate, setCutFeedrate] = useState<number>(1200);
  const [laserMaxPower, setLaserMaxPower] = useState<number>(DEFAULT_GCODE_OPTIONS.laserMaxPower);
  const [laserPower, setLaserPower] = useState<number>(DEFAULT_GCODE_OPTIONS.laserPower);
  const [laserPasses, setLaserPasses] = useState<number>(1);
  const [attachments, setAttachments] = useState<boolean>(DEFAULT_GCODE_OPTIONS.attachmentsEnabled);
  const [attachmentWidthMm, setAttachmentWidthMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentWidthMm);
  const [attachmentSpacingMm, setAttachmentSpacingMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentSpacingMm);
  const [attachmentHeightMm, setAttachmentHeightMm] = useState<number>(DEFAULT_GCODE_OPTIONS.attachmentHeightMm);
  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());

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
      laserPower,
      laserMaxPower,
      laserPasses,
      cutDepthZ: materialThicknessMm,
      zStepdown: Math.min(materialThicknessMm, 3.0),
      attachmentsEnabled: attachments,
      attachmentWidthMm,
      attachmentSpacingMm,
      attachmentHeightMm,
    });
  }, [exportResult, machineMode, cutFeedrate, laserPower, laserMaxPower, laserPasses, materialThicknessMm,
      attachments, attachmentWidthMm, attachmentSpacingMm, attachmentHeightMm]);

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

  const handleConnectUsb = async () => {
    if (machineState.connected) {
      await webSerialManager.disconnect();
    } else {
      await webSerialManager.connect();
    }
  };

  const handleStartJob = () => {
    if (!gcodeResult?.gcode) return;
    webSerialManager.startJob(gcodeResult.gcode);
  };

  const handleFrameTrace = async () => {
    if (!gcodeResult?.bounds) return;
    await webSerialManager.frameJob(gcodeResult.bounds, machineMode === 'laser' ? 5 : 0);
  };

  const mm = (m?: number) => `${((m ?? 0) * 1000).toFixed(0)} mm`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95vh] sm:max-h-[90vh] flex flex-col overflow-hidden">

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
                hint="Laser fires a beam straight through the sheet. CNC spins an end mill and cuts each layer in depth passes."
              >
                <Segmented
                  value={machineMode}
                  onChange={setMachineMode}
                  options={[['laser', 'Laser Cutter'], ['cnc', 'CNC Router']] as const}
                />
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
                label="Feedrate (mm/m)"
                hint="How fast the head travels while cutting, in mm per minute. It also drives the estimated job time."
              >
                <NumberInput
                  step="100" min={100} max={10000} integer
                  value={cutFeedrate}
                  onChange={setCutFeedrate}
                  className={inputClass}
                />
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

            <Advanced>
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
            </div>
          </div>

          {/* Interactive Pause Prompt */}
          {machineState.status.startsWith('PAUSED') && (
            <div className="p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500 flex flex-col space-y-3 animate-pulse text-amber-800 dark:text-amber-300">
              <div className="flex items-center space-x-3">
                <AlertCircle className="w-6 h-6 text-amber-500 flex-shrink-0" />
                <div>
                  <h4 className="font-bold text-sm font-sans">Material Sheet Swap Required</h4>
                  <p className="text-xs leading-relaxed font-semibold">{machineState.pauseMessage}</p>
                </div>
              </div>
              <div className="flex items-center justify-end space-x-3 pt-2 border-t border-amber-500/30">
                <button
                  onClick={() => webSerialManager.resumeJob()}
                  className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs rounded-lg flex items-center space-x-1.5"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Resume Next Sheet (Cycle Start)</span>
                </button>
              </div>
            </div>
          )}

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
                      Est. Time: {Math.round(gcodeResult.estimatedTimeSeconds / 60)} min
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

          {/* WebSerial USB Control Panel */}
          <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-white space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <Cpu className="w-5 h-5 text-emerald-400" />
                <div>
                  <h3 className="text-sm font-bold flex items-center space-x-2">
                    <span>WebSerial USB Machine Interface</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                      machineState.status === 'RUNNING' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' :
                      machineState.status.startsWith('PAUSED') ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse' :
                      machineState.connected ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {machineState.status}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    {machineState.connected ? `Connected via USB serial (${machineState.portName})` : 'Connect your USB machine to cut contour slice layers directly'}
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={handleConnectUsb}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer ${
                    machineState.connected ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-emerald-500 hover:bg-emerald-600 text-slate-950'
                  }`}
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>{machineState.connected ? 'Disconnect USB' : 'Connect USB Machine'}</span>
                </button>
              </div>
            </div>

            {/* Connected Controls */}
            {machineState.connected && (
              <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2 border-t border-slate-800">
                <div className="flex items-center space-x-2 bg-slate-950 p-2 rounded-lg border border-slate-800 text-xs font-mono">
                  <span className="text-slate-500">MPos:</span>
                  <span>X:{machineState.mpos.x.toFixed(1)} Y:{machineState.mpos.y.toFixed(1)} Z:{machineState.mpos.z.toFixed(1)}</span>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => webSerialManager.homeMachine()}
                    className="flex-1 py-1.5 px-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1"
                  >
                    <Home className="w-3.5 h-3.5 text-blue-400" />
                    <span>Home ($H)</span>
                  </button>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={handleFrameTrace}
                    disabled={!gcodeResult?.bounds}
                    className="flex-1 py-1.5 px-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Frame Laser</span>
                  </button>
                  <button
                    onClick={() => webSerialManager.unlockAlarm()}
                    className="py-1.5 px-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                    <span>Unlock ($X)</span>
                  </button>
                </div>

                <div className="flex items-center space-x-2">
                  {machineState.status === 'RUNNING' ? (
                    <button
                      onClick={() => webSerialManager.cancelJob()}
                      className="w-full py-1.5 px-3 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-lg flex items-center justify-center space-x-1.5"
                    >
                      <Square className="w-3.5 h-3.5" />
                      <span>E-Stop / Cancel</span>
                    </button>
                  ) : (
                    <button
                      onClick={handleStartJob}
                      disabled={!gcodeResult?.success}
                      className="w-full py-1.5 px-3 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg flex items-center justify-center space-x-1.5"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Start Cut Job</span>
                    </button>
                  )}
                </div>
              </div>
              <MachineWorkOriginPanel machineState={machineState} showZProbe={machineMode === 'cnc'} onOpenDocs={onOpenDocs} />
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
