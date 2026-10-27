import React, { useState, useMemo } from 'react';
import {
  X,
  Download,
  AlertCircle,
  Layers,
  Scissors,
  ExternalLink,
  Info,
  ChevronRight,
} from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import type { SceneGraph } from '../types/scene';
import {
  exportSheetUnfold,
  buildSheetUnfoldEtchUrl,
  DEFAULT_SHEET_UNFOLD_OPTIONS,
  type SheetUnfoldMode,
  type SheetUnfoldOptions,
} from '../utils/sheetUnfoldExporter';
import { useStore } from '../store/useStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { HintAnchor } from './ExportFields';
import { AddSimulationButton } from './MachineJobControls';
import { useAddSimulation } from '../hooks/useAddSimulation';
import { sheetFoldSimulationRequest } from '../utils/sheetFoldSimulation';

export interface ExportSheetUnfoldModalProps {
  isOpen: boolean;
  onClose: () => void;
  scene?: SceneGraph;
}

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-purple-500 focus:outline-none disabled:opacity-40';

const labelClass = 'text-xs font-semibold text-slate-600 dark:text-slate-300';

const sectionClass =
  'p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-4';

const sectionTitleClass =
  'text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

function HintIcon() {
  return (
    <Info
      className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 hover:text-purple-500 cursor-help"
      tabIndex={0}
      aria-label="What is this?"
    />
  );
}

function Field({
  label,
  hint,
  hintAlign = 'start',
  className,
  children,
}: {
  label: string;
  hint: string;
  hintAlign?: 'start' | 'end';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col min-w-0 ${className ?? ''}`}>
      <HintAnchor hint={hint} align={hintAlign} className="flex items-center space-x-1 mb-1.5">
        <label className={labelClass}>{label}</label>
        <HintIcon />
      </HintAnchor>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

function Advanced({ label = 'Advanced', children }: { label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center space-x-1 text-[11px] font-bold uppercase tracking-wider text-slate-400
                   dark:text-slate-500 hover:text-purple-600 dark:hover:text-purple-400 cursor-pointer transition-colors"
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

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex bg-slate-200 dark:bg-slate-700/60 p-0.5 rounded-lg">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          title={label}
          className={`flex-1 min-w-0 py-1 px-2 rounded-md text-xs font-medium transition-all truncate cursor-pointer ${
            value === v
              ? 'bg-white dark:bg-slate-800 text-purple-600 dark:text-purple-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export const ExportSheetUnfoldModal: React.FC<ExportSheetUnfoldModalProps> = ({
  isOpen,
  onClose,
  scene: sceneProp,
}) => {
  useEscapeToClose(isOpen, onClose);
  const storeScene = useStore((s) => s.sceneGraph);
  const scene = sceneProp ?? storeScene;

  const [mode, setMode] = useState<SheetUnfoldMode>(DEFAULT_SHEET_UNFOLD_OPTIONS.mode);
  const [coplanarToleranceDeg, setCoplanarToleranceDeg] = useState<number>(
    DEFAULT_SHEET_UNFOLD_OPTIONS.coplanarToleranceDeg
  );
  const [tabWidthMm, setTabWidthMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.tabWidthMm);
  const [tabAngleDeg, setTabAngleDeg] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.tabAngleDeg);
  const [thicknessMm, setThicknessMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.thicknessMm);
  const [bendRadiusMm, setBendRadiusMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.bendRadiusMm);
  const [kFactor, setKFactor] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.kFactor);
  const [bendReliefWidthMm, setBendReliefWidthMm] = useState<number>(
    DEFAULT_SHEET_UNFOLD_OPTIONS.bendReliefWidthMm
  );
  const [bendReliefDepthMm, setBendReliefDepthMm] = useState<number>(
    DEFAULT_SHEET_UNFOLD_OPTIONS.bendReliefDepthMm
  );
  const [seamAllowanceMm, setSeamAllowanceMm] = useState<number>(
    DEFAULT_SHEET_UNFOLD_OPTIONS.seamAllowanceMm
  );
  const [stitchPitchMm, setStitchPitchMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.stitchPitchMm);
  const [notchLengthMm, setNotchLengthMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.notchLengthMm);
  const [sheetWidthMm, setSheetWidthMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.sheetWidthMm);
  const [sheetHeightMm, setSheetHeightMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.sheetHeightMm);
  const [marginMm, setMarginMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.marginMm);
  const [partSpacingMm, setPartSpacingMm] = useState<number>(DEFAULT_SHEET_UNFOLD_OPTIONS.partSpacingMm);
  const [scalePct, setScalePct] = useState<number>(100);
  const [includeLabels, setIncludeLabels] = useState<boolean>(true);
  const [includeSheetOutline, setIncludeSheetOutline] = useState<boolean>(true);
  const [previewActualSize, setPreviewActualSize] = useState<boolean>(false);
  const [etchError, setEtchError] = useState<string | null>(null);

  const options: SheetUnfoldOptions = useMemo(
    () => ({
      mode,
      coplanarToleranceDeg,
      tabWidthMm,
      tabAngleDeg,
      thicknessMm,
      bendRadiusMm,
      kFactor,
      bendReliefWidthMm,
      bendReliefDepthMm,
      seamAllowanceMm,
      stitchPitchMm,
      notchLengthMm,
      sheetWidthMm,
      sheetHeightMm,
      marginMm,
      partSpacingMm,
      scaleFactor: scalePct / 100,
      includeLabels,
      includeSheetOutline,
    }),
    [
      mode,
      coplanarToleranceDeg,
      tabWidthMm,
      tabAngleDeg,
      thicknessMm,
      bendRadiusMm,
      kFactor,
      bendReliefWidthMm,
      bendReliefDepthMm,
      seamAllowanceMm,
      stitchPitchMm,
      notchLengthMm,
      sheetWidthMm,
      sheetHeightMm,
      marginMm,
      partSpacingMm,
      scalePct,
      includeLabels,
      includeSheetOutline,
    ]
  );

  const simulation = useAddSimulation();

  const exportResult = useMemo(() => {
    if (!isOpen || !scene) return null;
    return exportSheetUnfold(scene, options);
  }, [isOpen, scene, options]);

  const previewSvg = useMemo(
    () =>
      (exportResult?.svg || '')
        .replace(/<svg width="[^"]*" height="[^"]*"/, '<svg width="100%"')
        .replace(/stroke-width="0.25"/g, 'stroke-width="0.55"')
        .replace(/stroke-width="0.3"/g, 'stroke-width="0.65"')
        .replace(/stroke-width="0.35"/g, 'stroke-width="0.75"'),
    [exportResult]
  );

  if (!isOpen) return null;

  /** The net folded back up along its own lines, beside or over the model. */
  const handleSimulate = (placement: 'beside' | 'overlay') => {
    if (!exportResult?.success) return;
    void simulation.add({ ...sheetFoldSimulationRequest(exportResult, options).request, placement });
  };

  const handleDownloadSvg = () => {
    if (!exportResult || !exportResult.success || !exportResult.svg) return;
    const blob = new Blob([exportResult.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `sheet_unfold_${mode}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleOpenInEtch = async () => {
    if (!exportResult || !exportResult.success || !exportResult.svg) return;
    setEtchError(null);
    try {
      const url = await buildSheetUnfoldEtchUrl(exportResult, options);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setEtchError(err instanceof Error ? err.message : 'Could not send flat pattern to Etch.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-purple-500/10 text-purple-600 dark:text-purple-400 rounded-lg">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Unfold 3D to 2D Flat Pattern (Sheet Goods &amp; Etch)
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Unwrap 3D meshes and lattice cages into flat 2D nets for papercraft/packaging, brake-bent sheet metal, or stitched leather &amp; soft goods.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-5">
          {/* Fabrication Mode & Mode-Specific Parameters */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Fabrication Mode &amp; Allowance</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-4"
                label="Unfolding Mode"
                hint="Papercraft adds trapezoidal glue tabs and edge-pair numbers along split seams. Sheet Metal inserts K-factor bend allowance zones and UP/DN bend callouts. Soft Goods adds an outward seam allowance, alignment notches, and laser/pricking stitch holes."
              >
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    ['papercraft', 'Papercraft / Packaging'],
                    ['sheet_metal', 'Sheet Metal (K-Factor)'],
                    ['soft_goods', 'Soft Goods / Leather'],
                  ] as const}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Stock Thickness (mm)"
                hint="Material thickness T in mm. Used directly in Sheet Metal bend allowance BA = θ(R + K·T) and sent to Etch for laser/cutter feed calculation."
              >
                <NumberInput
                  step={0.1}
                  min={0.05}
                  max={50}
                  value={thicknessMm}
                  onChange={(v) => v !== undefined && setThicknessMm(v)}
                  className={inputClass}
                />
              </Field>

              {mode === 'papercraft' && (
                <>
                  <Field
                    className="lg:col-span-2"
                    label="Glue Tab Width (mm)"
                    hint="Height of trapezoidal glue tabs generated along split seam edges (one tab per split edge pair). Set to 0 for butt-joint nets without tabs."
                  >
                    <NumberInput
                      step={0.5}
                      min={0}
                      max={40}
                      value={tabWidthMm}
                      onChange={(v) => v !== undefined && setTabWidthMm(v)}
                      className={inputClass}
                    />
                  </Field>

                  <Field
                    className="lg:col-span-2"
                    label="Tab Taper Angle (°)"
                    hint="Miter angle at both ends of each trapezoidal glue tab so adjacent tabs do not collide when folded."
                  >
                    <NumberInput
                      step={5}
                      min={15}
                      max={80}
                      value={tabAngleDeg}
                      onChange={(v) => v !== undefined && setTabAngleDeg(v)}
                      className={inputClass}
                    />
                  </Field>

                  <Field
                    className="lg:col-span-2"
                    hintAlign="end"
                    label="Coplanar Merge (°)"
                    hint="Adjacent triangles whose normals differ by less than this angle are merged into a single polygon face before unfolding."
                  >
                    <NumberInput
                      step={0.5}
                      min={0.1}
                      max={30}
                      value={coplanarToleranceDeg}
                      onChange={(v) => v !== undefined && setCoplanarToleranceDeg(v)}
                      className={inputClass}
                    />
                  </Field>
                </>
              )}

              {mode === 'sheet_metal' && (
                <>
                  <Field
                    className="lg:col-span-2"
                    label="Inside Bend Radius R (mm)"
                    hint="Inside radius of the press-brake punch. Enters bend allowance as BA = θ · (R + K · T)."
                  >
                    <NumberInput
                      step={0.25}
                      min={0}
                      max={50}
                      value={bendRadiusMm}
                      onChange={(v) => v !== undefined && setBendRadiusMm(v)}
                      className={inputClass}
                    />
                  </Field>

                  <Field
                    className="lg:col-span-2"
                    label="K-Factor (0–1)"
                    hint="Neutral-axis ratio K = t / T inside the bend (typically 0.33 for tight air bends, 0.44 for standard mild steel/aluminium)."
                  >
                    <NumberInput
                      step={0.01}
                      min={0.1}
                      max={0.9}
                      value={kFactor}
                      onChange={(v) => v !== undefined && setKFactor(v)}
                      className={inputClass}
                    />
                  </Field>

                  <Field
                    className="lg:col-span-1"
                    label="Relief W (mm)"
                    hint="Width of rectangular bend-relief notches where two bend lines meet. Set 0 to disable."
                  >
                    <NumberInput
                      step={0.5}
                      min={0}
                      max={20}
                      value={bendReliefWidthMm}
                      onChange={(v) => v !== undefined && setBendReliefWidthMm(v)}
                      className={inputClass}
                    />
                  </Field>

                  <Field
                    className="lg:col-span-1"
                    hintAlign="end"
                    label="Relief D (mm)"
                    hint="Depth of rectangular bend-relief notches at bend intersections."
                  >
                    <NumberInput
                      step={0.5}
                      min={0}
                      max={20}
                      value={bendReliefDepthMm}
                      onChange={(v) => v !== undefined && setBendReliefDepthMm(v)}
                      className={inputClass}
                    />
                  </Field>
                </>
              )}

              {mode === 'soft_goods' && (
                <>
                  <Field
                    className="lg:col-span-2"
                    label="Seam Allowance (mm)"
                    hint="Outward margin added around the stitched seam perimeter of each unfolded pattern piece."
                  >
                    <NumberInput
                      step={0.5}
                      min={0}
                      max={40}
                      value={seamAllowanceMm}
                      onChange={(v) => v !== undefined && setSeamAllowanceMm(v)}
                      className={inputClass}
                    />
                  </Field>

                  <Field
                    className="lg:col-span-2"
                    label="Stitch Pitch (mm)"
                    hint="Equidistant spacing between laser stitch-hole punches along the original seam line (e.g. 3.38, 3.85, 4.0, 5.0 mm for leather pricking irons, or 0 to disable)."
                  >
                    <NumberInput
                      step={0.25}
                      min={0}
                      max={25}
                      value={stitchPitchMm}
                      onChange={(v) => v !== undefined && setStitchPitchMm(v)}
                      className={inputClass}
                    />
                  </Field>

                  <Field
                    className="lg:col-span-2"
                    hintAlign="end"
                    label="Alignment Notch (mm)"
                    hint="Length of perpendicular registration tick marks along mating seam edges."
                  >
                    <NumberInput
                      step={0.5}
                      min={0}
                      max={15}
                      value={notchLengthMm}
                      onChange={(v) => v !== undefined && setNotchLengthMm(v)}
                      className={inputClass}
                    />
                  </Field>
                </>
              )}
            </div>
          </div>

          {/* Sheet & Nesting */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Sheet Layout &amp; Nesting</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label="Sheet Size (mm)"
                hint="Width × height of each stock sheet in mm. Unfolded islands are packed onto one or more sheets automatically."
              >
                <div className="flex items-center space-x-1.5">
                  <NumberInput
                    step={10}
                    min={50}
                    max={5000}
                    value={sheetWidthMm}
                    onChange={(v) => v !== undefined && setSheetWidthMm(v)}
                    className={`${inputClass} px-2`}
                    aria-label="Sheet width in mm"
                  />
                  <span className="text-xs font-medium text-slate-400">&times;</span>
                  <NumberInput
                    step={10}
                    min={50}
                    max={5000}
                    value={sheetHeightMm}
                    onChange={(v) => v !== undefined && setSheetHeightMm(v)}
                    className={`${inputClass} px-2`}
                    aria-label="Sheet height in mm"
                  />
                </div>
              </Field>

              <Field
                className="lg:col-span-2"
                label={`Scale (${scalePct}%)`}
                hint="Uniform scale applied to the 3D geometry before unfolding."
              >
                <input
                  type="range"
                  min={10}
                  max={250}
                  step={5}
                  value={scalePct}
                  onChange={(e) => setScalePct(parseInt(e.target.value, 10) || 100)}
                  className="mt-auto w-full h-1.5 bg-slate-300 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Annotations"
                hint="Show or hide edge-pair match numbers, bend angle callouts, and dashed sheet borders."
              >
                <Segmented
                  value={includeLabels ? 'all' : includeSheetOutline ? 'sheets' : 'none'}
                  onChange={(v) => {
                    setIncludeLabels(v === 'all');
                    setIncludeSheetOutline(v !== 'none');
                  }}
                  options={[
                    ['all', 'Labels + Numbers'],
                    ['sheets', 'Sheets Only'],
                    ['none', 'Paths Only'],
                  ] as const}
                />
              </Field>
            </div>

            <Advanced>
              <Field
                className="lg:col-span-2"
                label="Sheet Margin (mm)"
                hint="Uncut border left around the perimeter of every stock sheet."
              >
                <NumberInput
                  step={1}
                  min={0}
                  max={50}
                  value={marginMm}
                  onChange={(v) => v !== undefined && setMarginMm(v)}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                label="Part Spacing (mm)"
                hint="Minimum clearance between nested flat-pattern islands on the sheet."
              >
                <NumberInput
                  step={1}
                  min={0}
                  max={50}
                  value={partSpacingMm}
                  onChange={(v) => v !== undefined && setPartSpacingMm(v)}
                  className={inputClass}
                />
              </Field>
            </Advanced>
          </div>

          {/* Errors & Warnings */}
          {exportResult && !exportResult.success && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/40 flex items-start space-x-2 text-xs text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{exportResult.error}</span>
            </div>
          )}

          {exportResult?.warnings && exportResult.warnings.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-1.5">
              {exportResult.warnings.map((w, i) => (
                <div
                  key={i}
                  className="flex items-start space-x-2 text-xs text-amber-800 dark:text-amber-300"
                >
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Live SVG Preview & Summary Telemetry */}
          {exportResult && exportResult.success && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-400">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="flex items-center space-x-1.5 font-medium">
                    <Layers className="w-4 h-4 text-purple-500" />
                    <span>
                      {exportResult.totalFaces} Faces ({exportResult.islands.length} Island
                      {exportResult.islands.length === 1 ? '' : 's'})
                    </span>
                  </span>
                  <span>Folds: {exportResult.foldCount}</span>
                  <span>Cut Seams: {exportResult.seamCount}</span>
                  {mode === 'papercraft' && <span>Glue Tabs: {exportResult.glueTabCount}</span>}
                  {mode === 'sheet_metal' && (
                    <span>
                      Total Bend Allowance: {exportResult.totalBendAllowanceMm.toFixed(2)} mm
                    </span>
                  )}
                  {mode === 'soft_goods' && (
                    <span>Stitch Holes: {exportResult.stitchHoleCount}</span>
                  )}
                  <span>Sheets: {exportResult.sheets.length}</span>
                </div>

                <div className="flex items-center gap-3">
                  <span className="hidden md:inline-flex items-center gap-2 text-[11px] text-slate-500">
                    <span className="inline-block w-2.5 h-0.5 bg-rose-600" /> Cut
                    <span className="inline-block w-2.5 h-0.5 bg-blue-600" /> Mountain
                    <span className="inline-block w-2.5 h-0.5 bg-green-600" /> Valley
                    <span className="inline-block w-2.5 h-0.5 bg-purple-600" /> Tab/Seam
                  </span>
                  <button
                    type="button"
                    onClick={() => setPreviewActualSize((v) => !v)}
                    className="text-[11px] text-purple-600 dark:text-purple-400 hover:underline cursor-pointer whitespace-nowrap"
                  >
                    {previewActualSize ? 'Fit to width' : 'Actual size'}
                  </button>
                </div>
              </div>

              <div className="relative w-full h-80 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-4 overflow-auto">
                <div
                  className={
                    previewActualSize
                      ? '[&>svg]:w-auto [&>svg]:h-auto [&>svg]:max-w-none'
                      : 'w-full [&>svg]:w-full [&>svg]:h-auto'
                  }
                  dangerouslySetInnerHTML={{ __html: previewSvg }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden xl:block text-xs text-slate-500 dark:text-slate-400">
            Layered SVG carries separate cut, mountain fold, valley fold, and seam/stitch layers for Etch or LightBurn.
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
            >
              Close
            </button>
            {etchError && (
              <span className="text-[11px] text-red-600 dark:text-red-400 max-w-xs leading-snug">
                {etchError}
              </span>
            )}
            <AddSimulationButton
              disabled={!exportResult?.success}
              onSimulate={handleSimulate}
              progress={simulation.progress}
              error={simulation.error}
            />
            <button
              onClick={handleOpenInEtch}
              disabled={!exportResult || !exportResult.success}
              title="Open this unfolded flat pattern in Etch with stock thickness preconfigured"
              className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-40 text-slate-800 dark:text-slate-100 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
            >
              <ExternalLink className="w-4 h-4" />
              <span>Open in Etch</span>
            </button>
            <button
              onClick={handleDownloadSvg}
              disabled={!exportResult || !exportResult.success}
              className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:opacity-40 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
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
