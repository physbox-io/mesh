import React, { useState, useMemo, useEffect } from 'react';
import { X, Download, AlertCircle, Layers, Scissors, Cpu, Play, Square, Home, ShieldAlert, Navigation, RefreshCw, Info } from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import { exportLaserCutSvg, type LaserCutOptions } from '../utils/laserCutExporter';
import { generateLaserCutGcode, DEFAULT_GCODE_OPTIONS } from '../utils/gcodeExporter';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';

interface ExportLaserCutModalProps {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
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
  const [sheetPreset, setSheetPreset] = useState<'600x400' | '300x300' | '150x150' | 'custom'>('600x400');
  const [sheetWidthMm, setSheetWidthMm] = useState<number>(600);
  const [sheetHeightMm, setSheetHeightMm] = useState<number>(400);
  const [autoScale, setAutoScale] = useState<boolean>(false);
  const [maxSheets, setMaxSheets] = useState<number>(2);
  const [customScalePct, setCustomScalePct] = useState<number>(100);
  const [annotations, setAnnotations] = useState<'all' | 'sheets' | 'none'>('all');

  // G-Code & WebSerial States
  const [machineMode, setMachineMode] = useState<'laser' | 'cnc'>('laser');
  const [cutFeedrate, setCutFeedrate] = useState<number>(1200);
  const [laserPower, setLaserPower] = useState<number>(1000);
  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());

  useEffect(() => {
    if (!isOpen) return;
    const unsub = webSerialManager.addListener(setMachineState);
    return () => unsub();
  }, [isOpen]);

  const handleSheetPresetChange = (preset: '600x400' | '300x300' | '150x150' | 'custom') => {
    setSheetPreset(preset);
    if (preset === '600x400') {
      setSheetWidthMm(600);
      setSheetHeightMm(400);
    } else if (preset === '300x300') {
      setSheetWidthMm(300);
      setSheetHeightMm(300);
    } else if (preset === '150x150') {
      setSheetWidthMm(150);
      setSheetHeightMm(150);
    }
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
    return generateLaserCutGcode(exportResult.panels, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode,
      cutFeedrate,
      laserPower,
      cutDepthZ: materialThicknessMm,
      zStepdown: Math.min(materialThicknessMm, 3.0),
    });
  }, [exportResult, machineMode, cutFeedrate, laserPower, materialThicknessMm]);

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

  const handleDownloadGcode = () => {
    if (!gcodeResult || !gcodeResult.success || !gcodeResult.gcode) return;
    const blob = new Blob([gcodeResult.gcode], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `physbox_cut_${machineMode}_${jointMode}.nc`;
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95vh] sm:max-h-[90vh] flex flex-col overflow-hidden">
        
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-amber-500/10 text-amber-600 dark:text-amber-400 rounded-lg">
              <Scissors className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Export to Laser / CNC (SVG &amp; G-Code)
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Unwrap 3D panel faces into 2D cut patterns &amp; stream live G-code directly over WebSerial USB (GRBL / Marlin)
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
                hint="Laser fires a beam and cuts sharp inside corners. CNC spins an end mill, so it needs corner relief and cuts in depth passes."
              >
                <Segmented
                  value={machineMode}
                  onChange={setMachineMode}
                  options={[['laser', 'Laser Cutter'], ['cnc', 'CNC Router / Mill']] as const}
                />
              </Field>

              <Field
                label="Thickness (mm)"
                hint="Thickness of the stock you are actually cutting. Finger length, slot depth and CNC cut depth are all derived from it."
              >
                <input
                  type="number" step="0.5" min="0.5" max="50"
                  value={materialThicknessMm}
                  onChange={(e) => setMaterialThicknessMm(parseFloat(e.target.value) || 3.0)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Feedrate (mm/m)"
                hint="How fast the head travels while cutting, in mm per minute. Slower burns/cuts deeper; it also sets the estimated job time."
              >
                <input
                  type="number" step="100" min="100" max="10000"
                  value={cutFeedrate}
                  onChange={(e) => setCutFeedrate(parseInt(e.target.value) || 1200)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Laser Power"
                hint="Beam power written as GRBL S-value, 0–1000 (S1000 = full power). Ignored on a CNC router."
              >
                <input
                  type="number" step="50" min="10" max="1000"
                  disabled={machineMode !== 'laser'}
                  value={laserPower}
                  onChange={(e) => setLaserPower(parseInt(e.target.value) || 1000)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Kerf (mm)"
                hintAlign="end"
                hint="Width of material the beam or bit removes. Cut paths are offset by half of it so parts come out at their drawn size."
              >
                <input
                  type="number" step="0.05" min="0.00" max="2.0"
                  value={kerfMm}
                  onChange={(e) => setKerfMm(parseFloat(e.target.value) || 0.15)}
                  className={inputClass}
                />
              </Field>
            </div>
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
                label="Tab Width (mm)"
                hint="Nominal width of a single finger along the joint. Wider means fewer, chunkier fingers; narrower gives more glue area but more cutting."
              >
                <input
                  type="number" step="1" min="3" max="50"
                  disabled={jointMode === 'glue'}
                  value={fingerWidthMm}
                  onChange={(e) => setFingerWidthMm(parseFloat(e.target.value) || 10.0)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Joint Fit (mm)"
                hint="Fit adjustment across each finger. Negative makes tabs wider than their slots for a press fit; positive leaves clearance for glue or a loose fit."
              >
                <input
                  type="number" step="0.05" min="-1" max="1"
                  disabled={jointMode === 'glue'}
                  value={jointClearanceMm}
                  onChange={(e) => setJointClearanceMm(parseFloat(e.target.value) || 0)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Overhang (mm)"
                hint="Extra tab length past flush. At 0 a tab finishes level with the mating panel's outer face; raising it leaves tabs proud so they can be sanded back."
              >
                <input
                  type="number" step="0.5" min="0" max="20"
                  disabled={jointMode === 'glue'}
                  value={tabOverhangMm}
                  onChange={(e) => setTabOverhangMm(Math.max(0, parseFloat(e.target.value) || 0))}
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

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Bit Ø (mm)"
                hint="Diameter of the end mill. It sets how far the relief cuts have to reach into each inside corner. Only read when corner relief is on."
              >
                <input
                  type="number" step="0.1" min="0.1"
                  disabled={cornerRelief === 'none'}
                  value={bitDiameterMm}
                  onChange={(e) => setBitDiameterMm(Math.max(0.1, parseFloat(e.target.value) || 0.1))}
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
                label="Sheet Preset"
                hint="Common bed sizes. Picking one fills in the width and height below; typing your own switches this to Custom."
              >
                <select
                  value={sheetPreset}
                  onChange={(e) => handleSheetPresetChange(e.target.value as any)}
                  className={`${inputClass} font-sans cursor-pointer`}
                >
                  <option value="600x400">600 x 400 mm (Standard)</option>
                  <option value="300x300">300 x 300 mm (K40 / Small)</option>
                  <option value="150x150">150 x 150 mm (Micro)</option>
                  <option value="custom">Custom Size</option>
                </select>
              </Field>

              <Field
                label="Sheet W (mm)"
                hint="Usable cutting width of one sheet. Panels are nested left to right within it."
              >
                <input
                  type="number" step="10" min="50" max="5000"
                  value={sheetWidthMm}
                  onChange={(e) => {
                    setSheetWidthMm(Math.max(10, parseFloat(e.target.value) || 100));
                    setSheetPreset('custom');
                  }}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Sheet H (mm)"
                hintAlign="end"
                hint="Usable cutting depth of one sheet. When a row no longer fits, the nesting starts a new sheet below."
              >
                <input
                  type="number" step="10" min="50" max="5000"
                  value={sheetHeightMm}
                  onChange={(e) => {
                    setSheetHeightMm(Math.max(10, parseFloat(e.target.value) || 100));
                    setSheetPreset('custom');
                  }}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Annotations"
                hint="What the SVG carries besides cut lines. Labels and sheet outlines help you sort parts, but they are engraved/drawn — strip them to Cut paths only before sending real material."
              >
                <Segmented
                  value={annotations}
                  onChange={setAnnotations}
                  options={[['all', 'Labels'], ['sheets', 'Outlines'], ['none', 'Cuts only']] as const}
                />
              </Field>
            </div>

            <div className="pt-3 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-3 gap-4">
              <Field
                label="Auto-Scale Mode"
                hint="Manual keeps the model at the scale you set. Auto-Fit searches for the largest scale whose finished cut patterns — joints included — still land within the sheet limit below."
              >
                <Segmented
                  value={autoScale ? 'auto' : 'manual'}
                  onChange={(v) => setAutoScale(v === 'auto')}
                  options={[['manual', 'Manual / Off'], ['auto', 'Auto-Fit to Sheet(s)']] as const}
                />
              </Field>

              <Field
                label="Max Sheet Limit"
                hint="How many sheets of stock the job may use. Auto-Fit shrinks the model until the nested parts fit within this many sheets."
              >
                <div className="flex items-center space-x-2">
                  <input
                    type="number" min="1" max="20" step="1"
                    disabled={!autoScale}
                    value={maxSheets}
                    onChange={(e) => setMaxSheets(Math.max(1, parseInt(e.target.value) || 1))}
                    className={inputClass}
                  />
                  <span className="text-xs text-slate-500 font-medium whitespace-nowrap">sheet(s)</span>
                </div>
              </Field>

              <div>
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
                <div className="flex items-center space-x-2">
                  <input
                    type="range" min="10" max="200" step="5"
                    disabled={autoScale}
                    value={customScalePct}
                    onChange={(e) => setCustomScalePct(parseInt(e.target.value) || 100)}
                    className="flex-1 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-lg appearance-none cursor-pointer accent-amber-500 disabled:opacity-40"
                  />
                  <input
                    type="number" min="10" max="200" step="5"
                    disabled={autoScale}
                    value={customScalePct}
                    onChange={(e) => setCustomScalePct(Math.max(10, parseInt(e.target.value) || 100))}
                    className={`${inputClass} w-16 px-2 py-1`}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* WebSerial USB Control Panel */}
          <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-white space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <Cpu className="w-5 h-5 text-amber-400" />
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
                    {machineState.connected ? `Connected via USB serial (${machineState.portName})` : 'Connect your USB machine (GRBL/Marlin/FluidNC) to cut directly from your browser'}
                  </p>
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={handleConnectUsb}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer ${
                    machineState.connected ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-amber-500 hover:bg-amber-600 text-slate-950'
                  }`}
                >
                  <Cpu className="w-3.5 h-3.5" />
                  <span>{machineState.connected ? 'Disconnect USB' : 'Connect USB Machine'}</span>
                </button>
              </div>
            </div>

            {/* Connected Machine Controls */}
            {machineState.connected && (
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
                  <button
                    onClick={() => webSerialManager.zeroXY()}
                    className="flex-1 py-1.5 px-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1"
                  >
                    <Navigation className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Zero XY</span>
                  </button>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={handleFrameTrace}
                    disabled={!gcodeResult?.bounds}
                    className="flex-1 py-1.5 px-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
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
            )}
          </div>

          {/* Interactive Tool / Material Change Pause Modal Overlay */}
          {machineState.status.startsWith('PAUSED') && (
            <div className="p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500 flex flex-col space-y-3 animate-pulse text-amber-800 dark:text-amber-300">
              <div className="flex items-center space-x-3">
                <AlertCircle className="w-6 h-6 text-amber-500 flex-shrink-0" />
                <div>
                  <h4 className="font-bold text-sm">Action Required: Machine Paused</h4>
                  <p className="text-xs leading-relaxed font-semibold">{machineState.pauseMessage}</p>
                </div>
              </div>
              <div className="flex items-center justify-end space-x-3 pt-2 border-t border-amber-500/30">
                {machineState.status === 'PAUSED_TOOL' && (
                  <button
                    onClick={() => webSerialManager.zeroZ(15.0)}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold rounded-lg"
                  >
                    Auto-Zero Z (Touch Plate)
                  </button>
                )}
                <button
                  onClick={() => webSerialManager.resumeJob()}
                  className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs rounded-lg flex items-center space-x-1.5"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Resume Job (Cycle Start)</span>
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
                      Est. Time: {Math.round(gcodeResult.estimatedTimeSeconds / 60)} min ({gcodeResult.totalCutDistanceMm} mm cut)
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
        </div>

        {/* Modal Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden 2xl:block text-xs text-slate-500 dark:text-slate-400">
            Vector SVG &amp; G-Code compatible with LightBurn, Inkscape, GRBL, Marlin, &amp; CNC routers.
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              Close
            </button>
            <button
              onClick={handleDownloadGcode}
              disabled={!gcodeResult || !gcodeResult.success}
              className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Download G-Code (.nc)</span>
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
