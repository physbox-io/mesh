import React, { useMemo, useState } from 'react';
import {
  X,
  Cpu,
  Box,
  CheckCircle2,
  AlertTriangle,
  Download,
  ExternalLink,
  Copy,
  Check,
  Layers,
  Sparkles,
} from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import type { HardwareBore, SceneNode } from '../types/scene';
import { Field, Segmented, inputClass, sectionClass, sectionTitleClass } from './ExportFields';
import {
  PCB_PRESETS,
  DEFAULT_PCB_ENCLOSURE_OPTIONS,
  buildPcbNode,
  generatePcbEnclosure,
  applyPcbToEnclosureBody,
  exportPcbFaceplateSvg,
  buildPcbFaceplateEtchUrl,
  encodePcbHandoff,
  decodePcbHandoff,
  type PcbMechanicalSpec,
  type PcbEnclosureFace,
} from '../utils/pcbEnclosureSync';

export interface ImportPcbModalProps {
  isOpen?: boolean;
  onClose: () => void;
  initialSpec?: PcbMechanicalSpec | string;
}

type SourceTab = 'preset' | 'handoff';
type BuildMode = 'enclosure_with_lid' | 'enclosure_open' | 'pcb_only' | 'apply_to_selected';

const SOURCE_OPTIONS = [
  ['preset', 'Preset Catalogue'],
  ['handoff', 'Volt Link / JSON'],
] as const;

const BORE_OPTIONS: readonly (readonly [HardwareBore, string])[] = [
  ['insert', 'Heat-Set Insert'],
  ['tapped', 'Tapped Thread'],
  ['clearance', 'Through Clearance'],
] as const;

const FACE_OPTIONS: readonly (readonly [PcbEnclosureFace, string])[] = [
  ['top', 'Top / Lid'],
  ['front', 'Front'],
  ['back', 'Back'],
  ['left', 'Left'],
  ['right', 'Right'],
] as const;

function findNodeById(nodes: SceneNode[], id: string | null): SceneNode | null {
  if (!id) return null;
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findNodeById(n.children || [], id);
    if (hit) return hit;
  }
  return null;
}

export const ImportPcbModal: React.FC<ImportPcbModalProps> = ({
  isOpen = true,
  onClose,
  initialSpec,
}) => {
  useEscapeToClose(isOpen, onClose);

  const sceneGraph = useStore((s) => s.sceneGraph);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const prepareForDiscreteChange = useStore((s) => s.prepareForDiscreteChange);

  const selectedNode = useMemo(
    () => findNodeById(sceneGraph.nodes, selectedNodeId),
    [sceneGraph.nodes, selectedNodeId],
  );

  const [sourceTab, setSourceTab] = useState<SourceTab>(
    typeof initialSpec === 'string' ? 'handoff' : 'preset',
  );
  const [presetKey, setPresetKey] = useState<string>('guitar_pedal_1590b');
  const [handoffInput, setHandoffInput] = useState<string>(() =>
    typeof initialSpec === 'string'
      ? initialSpec
      : initialSpec
        ? JSON.stringify(initialSpec, null, 2)
        : '',
  );

  // Enclosure parameters
  const [buildMode, setBuildMode] = useState<BuildMode>('enclosure_with_lid');
  const [standoffHeightMm, setStandoffHeightMm] = useState<number>(
    DEFAULT_PCB_ENCLOSURE_OPTIONS.standoffHeightMm,
  );
  const [wallThicknessMm, setWallThicknessMm] = useState<number>(
    DEFAULT_PCB_ENCLOSURE_OPTIONS.wallThicknessMm,
  );
  const [boardClearanceMm, setBoardClearanceMm] = useState<number>(
    DEFAULT_PCB_ENCLOSURE_OPTIONS.boardClearanceMm,
  );
  const [topClearanceMm, setTopClearanceMm] = useState<number>(
    DEFAULT_PCB_ENCLOSURE_OPTIONS.topClearanceMm,
  );
  const [boreType, setBoreType] = useState<HardwareBore>(
    DEFAULT_PCB_ENCLOSURE_OPTIONS.boreType,
  );

  // Faceplate SVG preview options
  const [previewFace, setPreviewFace] = useState<PcbEnclosureFace>('top');
  const [includeLabels, setIncludeLabels] = useState<boolean>(true);
  const [includeDialTicks, setIncludeDialTicks] = useState<boolean>(true);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);
  const [etchError, setEtchError] = useState<string | null>(null);

  const resolved = useMemo((): { spec: PcbMechanicalSpec | null; error: string | null } => {
    if (sourceTab === 'preset') {
      const spec = PCB_PRESETS[presetKey] ?? Object.values(PCB_PRESETS)[0];
      return { spec, error: null };
    }
    if (!handoffInput.trim()) {
      return {
        spec: null,
        error: 'Paste a Volt PCB handoff URL (#v=1&pcb=...) or JSON specification.',
      };
    }
    try {
      const decoded = decodePcbHandoff(handoffInput);
      return { spec: decoded, error: null };
    } catch (err) {
      return {
        spec: null,
        error: err instanceof Error ? err.message : 'Could not decode PCB specification.',
      };
    }
  }, [sourceTab, presetKey, handoffInput]);

  const activeSpec = resolved.spec;

  const enclosurePreview = useMemo(() => {
    if (!activeSpec) return null;
    return generatePcbEnclosure(activeSpec, {
      standoffHeightMm,
      wallThicknessMm,
      boardClearanceMm,
      topClearanceMm,
      includeLid: buildMode !== 'enclosure_open',
      boreType,
    });
  }, [
    activeSpec,
    standoffHeightMm,
    wallThicknessMm,
    boardClearanceMm,
    topClearanceMm,
    buildMode,
    boreType,
  ]);

  // The faceplate is the enclosure's own face, so it takes the same options.
  const faceplateOptions = useMemo(() => ({
    enclosure: {
      standoffHeightMm,
      wallThicknessMm,
      boardClearanceMm,
      topClearanceMm,
      includeLid: buildMode !== 'enclosure_open',
    },
    includeLabels,
    includeDialTicks,
    includeBoardOutline: true,
    thicknessMm: wallThicknessMm,
  }), [standoffHeightMm, wallThicknessMm, boardClearanceMm, topClearanceMm, buildMode, includeLabels, includeDialTicks]);

  const faceplate = useMemo(() => {
    if (!activeSpec) return null;
    return exportPcbFaceplateSvg(activeSpec, previewFace, faceplateOptions);
  }, [activeSpec, previewFace, faceplateOptions]);

  const svgDataUri = useMemo(() => {
    if (!faceplate?.svg) return '';
    return `data:image/svg+xml;utf8,${encodeURIComponent(faceplate.svg)}`;
  }, [faceplate]);

  if (!isOpen) return null;

  const handleDownloadSvg = () => {
    if (!faceplate || !activeSpec) return;
    const blob = new Blob([faceplate.svg], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeSpec.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${previewFace}_panel.svg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleOpenInEtch = async () => {
    if (!activeSpec) return;
    setEtchError(null);
    try {
      const url = await buildPcbFaceplateEtchUrl(activeSpec, previewFace, faceplateOptions);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      setEtchError(err instanceof Error ? err.message : 'Failed to open faceplate in Etch.');
    }
  };

  const handleCopyVoltLink = async () => {
    if (!activeSpec) return;
    const link = encodePcbHandoff(activeSpec, { format: 'fragment' });
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 1800);
    } catch {
      // Fallback if clipboard API is unavailable
    }
  };

  const handleAddToScene = () => {
    if (!activeSpec) return;
    prepareForDiscreteChange();
    const state = useStore.getState();
    const suffix = Math.random().toString(36).substring(2, 7);

    if (buildMode === 'apply_to_selected' && selectedNode) {
      const updatedHost = applyPcbToEnclosureBody(selectedNode, activeSpec, {
        standoffHeightMm,
        wallThicknessMm,
        boardClearanceMm,
        topClearanceMm,
        boreType,
      });
      const replaceInTree = (nodes: SceneNode[]): SceneNode[] =>
        nodes.map((n) =>
          n.id === selectedNode.id
            ? updatedHost
            : { ...n, children: replaceInTree(n.children || []) },
        );
      const nextScene = {
        ...state.sceneGraph,
        nodes: replaceInTree(state.sceneGraph.nodes),
      };
      useStore.setState({ sceneGraph: nextScene, selectedNodeId: updatedHost.id });
      state.recompile(nextScene, updatedHost.id, true);
      onClose();
      return;
    }

    if (buildMode === 'pcb_only') {
      const pcbNode = buildPcbNode(activeSpec, {
        id: `pcb_${suffix}`,
        pos: [0, 0, Math.max(0.01, activeSpec.thicknessMm / 2000)],
      });
      const nextScene = {
        ...state.sceneGraph,
        nodes: [...state.sceneGraph.nodes, pcbNode],
      };
      useStore.setState({ sceneGraph: nextScene, selectedNodeId: pcbNode.id });
      state.recompile(nextScene, pcbNode.id, true);
      onClose();
      return;
    }

    const generated = generatePcbEnclosure(activeSpec, {
      standoffHeightMm,
      wallThicknessMm,
      boardClearanceMm,
      topClearanceMm,
      includeLid: buildMode === 'enclosure_with_lid',
      boreType,
    });

    const baseNode: SceneNode = {
      ...generated.baseNode,
      id: `${generated.baseNode.id}_${suffix}`,
    };
    const pcbNode: SceneNode = {
      ...generated.pcbNode,
      id: `${generated.pcbNode.id}_${suffix}`,
    };
    const newNodes: SceneNode[] = [baseNode, pcbNode];
    if (generated.lidNode) {
      newNodes.push({
        ...generated.lidNode,
        id: `${generated.lidNode.id}_${suffix}`,
      });
    }

    const nextScene = {
      ...state.sceneGraph,
      nodes: [...state.sceneGraph.nodes, ...newNodes],
    };
    useStore.setState({ sceneGraph: nextScene, selectedNodeId: baseNode.id });
    state.recompile(nextScene, baseNode.id, true);
    onClose();
  };

  const report = enclosurePreview?.clearanceReport;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 rounded-lg">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Volt ↔ Mesh PCB &amp; Enclosure Co-Design
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Import a PCB layout from Volt or presets, generate CSG mounting bosses &amp; panel cutouts, and export a 1:1 Etch faceplate
              </p>
            </div>
          </div>
          <button
            aria-label="Close"
            title="Close"
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-clip p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-5">
          {/* Left Column: PCB Source & Enclosure Parameters */}
          <div className="lg:col-span-7 space-y-4">
            {/* Source Selection */}
            <div className={sectionClass}>
              <div className="flex items-center justify-between gap-2">
                <h3 className={sectionTitleClass}>1. PCB Mechanical Source</h3>
                {activeSpec && (
                  <button
                    type="button"
                    onClick={handleCopyVoltLink}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400 hover:underline"
                  >
                    {copiedLink ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedLink ? 'Copied Handoff Fragment' : 'Copy Volt Handoff'}</span>
                  </button>
                )}
              </div>

              <Segmented
                value={sourceTab}
                options={SOURCE_OPTIONS}
                onChange={(v) => setSourceTab(v)}
              />

              {sourceTab === 'preset' ? (
                <div className="space-y-3">
                  <Field
                    label="Board Preset"
                    hint="Standard reference PCBs with mounting holes, connectors, pots, and display cutouts."
                  >
                    <select
                      value={presetKey}
                      onChange={(e) => setPresetKey(e.target.value)}
                      className={inputClass}
                    >
                      {Object.entries(PCB_PRESETS).map(([key, spec]) => (
                        <option key={key} value={key}>
                          {spec.name} ({spec.widthMm} × {spec.depthMm} mm, {spec.mountingHoles.length} holes,{' '}
                          {spec.components.length} components)
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : (
                <div className="space-y-2">
                  <Field
                    label="Volt Handoff URL / Fragment / JSON"
                    hint="Paste a #v=1&pcb=... link from Volt or a raw PcbMechanicalSpec JSON object."
                  >
                    <textarea
                      rows={4}
                      value={handoffInput}
                      onChange={(e) => setHandoffInput(e.target.value)}
                      placeholder={'Paste #v=1&pcb=... or {"name":"My Board","widthMm":50,"depthMm":50,...}'}
                      className={`${inputClass} font-mono text-[11px]`}
                    />
                  </Field>
                  {resolved.error && (
                    <div className="flex items-center gap-2 text-xs text-rose-600 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/40 px-3 py-2 rounded-lg border border-rose-200 dark:border-rose-800/60">
                      <AlertTriangle className="w-4 h-4 flex-shrink-0" />
                      <span>{resolved.error}</span>
                    </div>
                  )}
                </div>
              )}

              {activeSpec && (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-1 text-xs">
                  <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[10px] uppercase text-slate-400">Board Size</div>
                    <div className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                      {activeSpec.widthMm} × {activeSpec.depthMm} mm
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[10px] uppercase text-slate-400">Thickness</div>
                    <div className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                      {activeSpec.thicknessMm} mm ({activeSpec.color ?? 'green'})
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[10px] uppercase text-slate-400">Mounting</div>
                    <div className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                      {activeSpec.mountingHoles.length}×{' '}
                      {activeSpec.mountingHoles[0]?.fastener ?? 'M3'}
                    </div>
                  </div>
                  <div className="p-2 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
                    <div className="text-[10px] uppercase text-slate-400">Panel Cutouts</div>
                    <div className="font-mono font-semibold text-slate-700 dark:text-slate-200">
                      {activeSpec.components.filter((c) => c.panelMount).length} features
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Enclosure & Standoff Settings */}
            <div className={sectionClass}>
              <h3 className={sectionTitleClass}>2. Enclosure &amp; Standoff Settings</h3>

              <Field
                label="Generation Mode"
                hint="Generate a full CSG enclosure with removable lid, an open-top tray, just the 3D PCB assembly, or punch bosses/cutouts into the selected body."
              >
                <select
                  value={buildMode}
                  onChange={(e) => setBuildMode(e.target.value as BuildMode)}
                  className={inputClass}
                >
                  <option value="enclosure_with_lid">Enclosure Base + Removable Lid + 3D PCB</option>
                  <option value="enclosure_open">Open-Top Enclosure Base + 3D PCB</option>
                  <option value="pcb_only">3D Populated PCB Assembly Only</option>
                  {selectedNode && (
                    <option value="apply_to_selected">
                      Apply Bosses &amp; Cutouts to Selected ({selectedNode.name || selectedNode.id})
                    </option>
                  )}
                </select>
              </Field>

              {buildMode !== 'pcb_only' && (
                <>
                  <Field
                    label="Mounting Boss Bore Style"
                    hint="Heat-set brass inserts, direct tapped plastic threads, or through-clearance holes."
                  >
                    <Segmented
                      value={boreType}
                      options={BORE_OPTIONS}
                      onChange={(v) => setBoreType(v)}
                    />
                  </Field>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Field
                      label="Standoff (mm)"
                      hint="Height of mounting bosses from the enclosure floor to the underside of the PCB."
                    >
                      <NumberInput
                        step={0.5}
                        min={2}
                        max={30}
                        value={standoffHeightMm}
                        onChange={(v) => v !== undefined && setStandoffHeightMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field
                      label="Wall (mm)"
                      hint="Thickness of the enclosure walls, floor, and removable lid."
                    >
                      <NumberInput
                        step={0.5}
                        min={1.2}
                        max={10}
                        value={wallThicknessMm}
                        onChange={(v) => v !== undefined && setWallThicknessMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field
                      label="XY Margin (mm)"
                      hint="Clearance around PCB perimeter to inner enclosure walls."
                    >
                      <NumberInput
                        step={0.5}
                        min={0.5}
                        max={20}
                        value={boardClearanceMm}
                        onChange={(v) => v !== undefined && setBoardClearanceMm(v)}
                        className={inputClass}
                      />
                    </Field>
                    <Field
                      label="Top Gap (mm)"
                      hint="Clearance above the tallest component to the underside of the lid."
                    >
                      <NumberInput
                        step={0.5}
                        min={0.5}
                        max={30}
                        value={topClearanceMm}
                        onChange={(v) => v !== undefined && setTopClearanceMm(v)}
                        className={inputClass}
                      />
                    </Field>
                  </div>
                </>
              )}

              {/* Clearance Verification Report */}
              {report && (
                <div
                  className={`p-3 rounded-lg border text-xs space-y-1.5 ${
                    report.ok
                      ? 'bg-emerald-50/70 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-200'
                      : 'bg-amber-50/80 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-200'
                  }`}
                >
                  <div className="flex items-center justify-between font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      {report.ok ? (
                        <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                      )}
                      {report.ok
                        ? 'Electro-Mechanical Clearance Check Passed'
                        : `${report.issues.length} Clearance Issue(s) Detected`}
                    </span>
                    <span className="font-mono text-[11px]">
                      Outer: {report.outerDimensionsMm.map((d) => d.toFixed(1)).join(' × ')} mm
                    </span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[11px] opacity-90 font-mono">
                    <span>Wall min: {report.minWallClearanceMm.toFixed(1)} mm</span>
                    <span>Boss keep-out: {report.minBossClearanceMm.toFixed(1)} mm</span>
                    <span>Top gap: {report.minTopClearanceMm.toFixed(1)} mm</span>
                  </div>
                  {report.issues.length > 0 && (
                    <ul className="list-disc list-inside space-y-0.5 pt-1 text-[11px]">
                      {report.issues.map((issue, idx) => (
                        <li key={idx}>{issue.message}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right Column: 2D Faceplate Preview & Etch Handoff */}
          <div className="lg:col-span-5 flex flex-col space-y-4">
            <div className={`${sectionClass} flex-1 flex flex-col`}>
              <div className="flex items-center justify-between">
                <h3 className={sectionTitleClass}>3. 1:1 Faceplate / Panel Preview</h3>
                {faceplate && (
                  <span className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
                    {faceplate.widthMm} × {faceplate.heightMm} mm · {faceplate.cutoutCount} cuts
                  </span>
                )}
              </div>

              <Segmented
                value={previewFace}
                options={FACE_OPTIONS}
                onChange={(v) => setPreviewFace(v)}
              />

              <div className="flex items-center gap-4 text-xs text-slate-600 dark:text-slate-300">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeLabels}
                    onChange={(e) => setIncludeLabels(e.target.checked)}
                    className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span>Engrave Labels</span>
                </label>
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeDialTicks}
                    onChange={(e) => setIncludeDialTicks(e.target.checked)}
                    className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span>Potentiometer Dial Ticks</span>
                </label>
              </div>

              {/* SVG Viewport */}
              <div className="flex-1 min-h-[220px] rounded-xl bg-white dark:bg-slate-950 border border-slate-200 dark:border-slate-800 p-4 flex items-center justify-center overflow-hidden">
                {svgDataUri ? (
                  <img
                    src={svgDataUri}
                    alt={`${previewFace} faceplate preview`}
                    className="max-w-full max-h-[250px] object-contain"
                  />
                ) : (
                  <span className="text-xs text-slate-400">No valid PCB selected</span>
                )}
              </div>

              {etchError && (
                <div className="text-xs text-rose-600 dark:text-rose-400">{etchError}</div>
              )}

              <div className="flex flex-wrap items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={!faceplate}
                  onClick={handleDownloadSvg}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Save 1:1 SVG</span>
                </button>
                <button
                  type="button"
                  disabled={!faceplate}
                  onClick={handleOpenInEtch}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border border-amber-500/30 hover:bg-amber-500/25 disabled:opacity-40 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  <span>Open Panel in Etch</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
            <Layers className="w-4 h-4 text-emerald-500" />
            <span>
              {enclosurePreview
                ? `${enclosurePreview.cutouts.length} panel cutouts & ${activeSpec?.mountingHoles.length ?? 0} mounting bosses ready`
                : 'Configure PCB source to generate'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200/60 dark:hover:bg-slate-700/60 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={!activeSpec}
              onClick={handleAddToScene}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm disabled:opacity-40 transition-colors"
            >
              {buildMode === 'pcb_only' ? (
                <>
                  <Cpu className="w-4 h-4" />
                  <span>Add 3D PCB to Scene</span>
                </>
              ) : buildMode === 'apply_to_selected' ? (
                <>
                  <Sparkles className="w-4 h-4" />
                  <span>Apply to Selected Body</span>
                </>
              ) : (
                <>
                  <Box className="w-4 h-4" />
                  <span>Add PCB + Enclosure to Scene</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImportPcbModal;
