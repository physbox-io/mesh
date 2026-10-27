// ---------------------------------------------------------------------------
// Rigid: a printed mold, open or two halves, with the cast it makes
// ---------------------------------------------------------------------------

import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Info, AlertTriangle, Download } from 'lucide-react';
import type { SceneGraph } from '../../types/scene';
import {
  emptyMoldResult,
  moldSummary,
  rememberMoldOptions,
  DEFAULT_MOLD_OPTIONS,
  type MoldOptions,
  type MoldSummary,
} from '../../utils/moldExporter';
import { MoldWorkerClient, type MoldPreview } from '../../utils/moldWorkerClient';
import { DEFAULT_LINER_SKIN_MM } from '../../utils/moldLiner';
import { castMaterial, castMaterialWarnings, castWeightG, mixGrams, type CastMaterialId } from '../../utils/castMaterials';
import { ChainResult } from './ChainRun';
import { OPEN_MOLD_ALLOWANCE } from '../../utils/moldExporter';
import { soupVolume } from '../../utils/siliconeMold';
import { collectSceneTriangles } from '../../utils/contourSliceExporter';
import type { MoldCastSimulationResult } from '../../utils/moldCastSimulation';
import { NumberInput } from '@physbox-io/ui';
import { CastingGuide } from '../CastingGuide';
import { HintAnchor } from '../ExportFields';
import { AdvancedBlock, CastTopFields, MaterialNotes } from './CastTopFields';
import { useSettled } from '../../hooks/useSettled';
import { AddSimulationButton } from '../MachineJobControls';
import { sceneStockTransform, useAddSimulation } from '../../hooks/useAddSimulation';
import { stlToMesh } from '../../utils/stlMesh';
import type { SimulationPlacement } from '../../utils/simulatedPart';
import { useStore } from '../../store/useStore';
import { PanelBody, PanelFooter } from './CastDialogFrame';
import { MoldPreviewView } from './MoldPreviewView';
import { effectiveMoldView, type PreviewViewMode } from './moldViewMode';

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-purple-500 focus:outline-none disabled:opacity-40';

const sectionClass =
  'p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-4 min-w-0';

const sectionTitleClass =
  'text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

function Field({
  label,
  hint,
  hintAlign = 'start',
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  hintAlign?: 'start' | 'end';
  children: React.ReactNode;
  className?: string;
}) {
  // The bubble is portalled rather than absolutely positioned: this column
  // scrolls, and a scroll container clips its positioned descendants whatever
  // their z-index says, which is what cut the longer hints off at the card's edge.
  return (
    <div className={`space-y-1.5 min-w-0 relative ${className}`}>
      <HintAnchor hint={hint} align={hintAlign} className="flex items-center justify-between gap-1">
        <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 truncate">{label}</label>
        {hint && (
          <span
            tabIndex={0}
            aria-label={hint}
            className="shrink-0 text-slate-400 hover:text-slate-200 focus:text-slate-200 cursor-help p-0.5 focus:outline-none"
          >
            <Info className="w-3.5 h-3.5" />
          </span>
        )}
      </HintAnchor>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (val: T) => void;
  options: readonly (readonly [T, string])[];
}) {
  return (
    <div className="flex bg-slate-200 dark:bg-slate-700/60 p-0.5 rounded-lg text-xs font-medium min-w-0">
      {options.map(([optVal, label]) => (
        <button
          key={optVal}
          type="button"
          onClick={() => onChange(optVal)}
          className={`flex-1 py-1.5 px-2 rounded-md transition-all cursor-pointer truncate ${
            value === optVal
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

const EMPTY_SUMMARY: MoldSummary = moldSummary(emptyMoldResult());

interface RigidMoldPanelProps {
  /** What is being molded: the selection, or the whole scene. */
  scene: SceneGraph;
  material: CastMaterialId;
  onMaterial: (id: CastMaterialId) => void;
  /** Draft the model carries from Prepare for Casting, degrees; 0 for none. */
  bakedDraftDeg: number;
  onClose: () => void;
  /** Over to the Silicone tab, for a part a rigid mold locks onto. */
  onSilicone: () => void;
  /** The tab on show: a hidden one builds nothing. */
  active: boolean;
}

export const RigidMoldPanel: React.FC<RigidMoldPanelProps> = ({ scene, material, onMaterial, bakedDraftDeg, onClose, onSilicone, active }) => {
  // Prep rewrites the scene several times on its way through; build from where it lands.
  const prepBusy = useStore((s) => s.castPrepBusy);
  // 'auto' picks the simplest mold that keeps the part, and the direction it
  // opens along; both stay overridable below.
  const [chosen, setOptions] = useState<MoldOptions>({ ...DEFAULT_MOLD_OPTIONS, moldType: 'auto' });
  const set = <K extends keyof MoldOptions>(key: K, value: MoldOptions[K] | undefined) => {
    if (value === undefined) return;
    setOptions((prev) => ({ ...prev, [key]: value }));
  };
  const draftLocked = bakedDraftDeg > 0;
  // The pour is about the part's own volume until a cast preview measures it.
  const partVolumeMm3 = useMemo(() => Math.abs(soupVolume(collectSceneTriangles(scene).tris)) * 1e9, [scene]);
  // The material is the tab's, and draft the model already has is not cut again.
  const options = useMemo<MoldOptions>(
    () => ({ ...chosen, castMaterial: material, ...(draftLocked ? { draftAngleDeg: 0 } : {}) }),
    [chosen, material, draftLocked],
  );

  const [viewMode, setViewMode] = useState<PreviewViewMode>('clamshell_exploded');
  const [trimCastChannels, setTrimCastChannels] = useState(false);
  const [castPreview, setCastPreview] = useState<MoldCastSimulationResult | null>(null);
  const [castPreviewBusy, setCastPreviewBusy] = useState(false);

  // Mold generation runs in a worker, and the modal keeps showing the last mold
  // it finished while the next one is on its way — a preview that blanks on
  // every keystroke is worse than one that is a moment out of date.
  const clientRef = useRef<MoldWorkerClient | null>(null);
  const [preview, setPreview] = useState<MoldPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Every keystroke in a number field is a new options object and so a new
  // mold. Typing "12" into the wall margin asks for a mold at 1 mm and then at
  // 12; the first is work nobody wanted, and on a relief it is most of a
  // second of it.
  const settledOptions = useSettled(options, 250);

  useEffect(() => {
    const client = new MoldWorkerClient();
    clientRef.current = client;
    return () => {
      client.dispose();
      clientRef.current = null;
      setPreview(null);
    };
  }, []);

  useEffect(() => {
    const client = clientRef.current;
    if (!client || !active || prepBusy) return;

    rememberMoldOptions(settledOptions);
    let live = true;
    setBusy(true);
    client
      .generate(scene, settledOptions)
      .then((next) => {
        if (!live) return;
        setPreview(next);
        setFailure(null);
      })
      .catch((e: Error) => {
        if (live) setFailure(e.message);
      })
      .finally(() => {
        if (live) setBusy(false);
      });

    // The worker answers in order, so an unmounted or superseded request is
    // dropped here rather than racing the one that replaced it.
    return () => {
      live = false;
    };
  }, [scene, settledOptions, active, prepBusy]);

  const result = preview?.summary ?? EMPTY_SUMMARY;
  /** The mold actually built: 'auto' resolved by the exporter. */
  const moldType: 'clamshell' | 'open' =
    preview?.summary.success ? result.moldType : options.moldType === 'auto' ? 'clamshell' : options.moldType;

  const effectiveViewMode = effectiveMoldView(moldType, viewMode);
  // The auto choice still fills in more of the part than an open mold is
  // allowed to: a rigid mold would hold it in for good.
  const locksOn = result.success && !options.dissolvableLiner && !options.allowUndercuts
    && result.lostFraction > OPEN_MOLD_ALLOWANCE;

  useEffect(() => {
    const client = clientRef.current;
    if (!client || !active || !preview || !result.success || effectiveViewMode !== 'cast_preview') return;
    let live = true;
    setCastPreviewBusy(true);
    client
      .cast({ trimChannels: trimCastChannels })
      .then((res) => {
        if (live) setCastPreview(res);
      })
      .catch(() => {
        if (live) setCastPreview(null);
      })
      .finally(() => {
        if (live) setCastPreviewBusy(false);
      });
    return () => {
      live = false;
    };
  }, [active, preview, result.success, effectiveViewMode, trimCastChannels]);

  const [saving, setSaving] = useState(false);
  const [castBusy, setCastBusy] = useState(false);
  const [castError, setCastError] = useState<string | null>(null);
  const [castLines, setCastLines] = useState<string[] | null>(null);
  // A result is for the mold it was cast from: gone when the mold changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCastLines(null);
  }, [preview, material]);
  const addToScene = useAddSimulation();
  const addCastToScene = useAddSimulation();

  /** The halves as they print, flat side by side, beside the part they mold. */
  const handleAddToScene = async () => {
    const client = clientRef.current;
    if (!client) return;
    let bytes: Uint8Array;
    try {
      bytes = await client.stl();
    } catch (e) {
      setFailure((e as Error).message);
      return;
    }
    const added = await addToScene.add({
      mesh: stlToMesh(bytes),
      transform: sceneStockTransform(),
      kind: 'mold',
      label: 'Mold',
      placement: 'beside',
      select: false,
    });
    // Halves laid flat to print are not something to pour into or mold again.
    if (added) useStore.getState().selectMany([], false);
  };

  /** Simulates pouring into the closed mold and adds the resulting cast solid to the scene. */
  const handleSimulateCast = async (placement: SimulationPlacement) => {
    const client = clientRef.current;
    if (!client || !preview || !result.success) return;
    setCastBusy(true);
    setCastError(null);
    try {
      const castRes = await client.cast({ trimChannels: trimCastChannels }, true);
      if (!castRes.success) {
        setCastError(castRes.error || 'Could not simulate cast from mold.');
        return;
      }
      const grams = castWeightG(material, castRes.castVolumeMm3);
      const mix = mixGrams(material, grams);
      const lines = [
        `${Math.round(castRes.castVolumeMm3).toLocaleString()} mm³, ${Math.round(grams * 10) / 10} g of ${castMaterial(material).label.toLowerCase()}` +
          (mix ? ` (${Math.round(mix.a)} g ${mix.aLabel} + ${Math.round(mix.b)} g ${mix.bLabel})` : ''),
        ...(castRes.deviation ? [`From the master: ${castRes.deviation.maxMm} mm at most, ${castRes.deviation.meanMm} mm on average`] : []),
      ];
      setCastLines(lines);
      const added = await addCastToScene.add({
        mesh: castRes.mesh,
        transform: sceneStockTransform(),
        kind: 'cast',
        label: 'Mold cast',
        placement,
        material,
        details: [
          ...lines,
          `Cast dimensions: ${castRes.sizeMm.width} × ${castRes.sizeMm.depth} × ${castRes.sizeMm.height} mm`,
          `Mold type: ${moldType === 'open' ? 'One-part open mold' : 'Two-part clamshell mold'}`,
        ],
      });
      if (added && castRes.textures && castRes.textures.length > 0) {
        const addedNode = useStore.getState().sceneGraph.nodes.find((n) => n.id === added.id);
        const castGeom = addedNode?.geoms?.[0];
        if (castGeom) {
          useStore.getState().setGeomTextures(added.id, castGeom.name, castRes.textures);
        }
      }
    } catch (e) {
      setCastError((e as Error)?.message || 'Could not simulate cast from mold.');
    } finally {
      setCastBusy(false);
    }
  };

  const handleDownload = async (filename: string) => {
    const client = clientRef.current;
    if (!client) return;
    setSaving(true);
    try {
      // A lined mold is two materials, which only the 3MF can say.
      saveBytes(result.liner ? await client.threeMf() : await client.stl(), filename);
    } catch (e) {
      // A worker that died took the mold it held with it.
      setFailure((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const saveBytes = (bytes: Uint8Array, filename: string) => {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  };

  return (
    <>
      <PanelBody className="p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left Column: 3D WebGL Viewport */}
        <div className="lg:col-span-7 flex flex-col gap-3 min-w-0">
          <MoldPreviewView
            preview={preview}
            result={result}
            moldType={moldType}
            viewMode={viewMode}
            onViewMode={setViewMode}
            busy={busy}
            castPreview={castPreview}
            castPreviewBusy={castPreviewBusy}
            trimCastChannels={trimCastChannels}
            onTrimCastChannels={setTrimCastChannels}
          />

          {/* Geometry Info Stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
            <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
              <span className="text-slate-400 block text-[10px] uppercase font-semibold">Part Size</span>
              <span className="font-mono font-medium truncate block">
                {result.partWidthMm} × {result.partDepthMm} × {result.partHeightMm} mm
              </span>
            </div>
            <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
              <span className="text-slate-400 block text-[10px] uppercase font-semibold">Mold Block</span>
              <span className="font-mono font-medium text-purple-600 dark:text-purple-400 truncate block">
                {result.moldWidthMm} × {result.moldDepthMm} × {result.moldHeightMm} mm
              </span>
            </div>
            <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
              <span className="text-slate-400 block text-[10px] uppercase font-semibold">STL Triangles</span>
              <span className="font-mono font-medium">{result.totalTriangles.toLocaleString()}</span>
            </div>
            <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
              <span className="text-slate-400 block text-[10px] uppercase font-semibold">Cavity</span>
              <span className="font-mono font-medium truncate block">
                {result.cavityDepthMm} mm deep · {result.minDraftDeg}° draft
              </span>
            </div>
          </div>

          {result.success && result.setupNote && (
            <p className="text-[11px] leading-snug text-slate-500 dark:text-slate-400">{result.setupNote}</p>
          )}

          {failure && (
            <div className="flex items-start gap-2 text-[11px] leading-snug rounded-lg px-2.5 py-2 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 text-rose-800 dark:text-rose-200">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              <span>The mold could not be built: {failure}</span>
            </div>
          )}

          {result.warnings.length > 0 && (
            <div className="space-y-1.5">
              {result.warnings.map((w, i) => (
                <div
                  key={i}
                  className="flex items-start gap-2 text-[11px] leading-snug rounded-lg px-2.5 py-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200"
                >
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  <span>{w}</span>
                </div>
              ))}
              {result.lidIsBackingPlate && moldType === 'clamshell' && (
                <button
                  type="button"
                  onClick={() => set('moldType', 'open')}
                  className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-purple-300 dark:border-purple-800
                             text-purple-700 dark:text-purple-300 hover:bg-purple-50 dark:hover:bg-purple-950/40 cursor-pointer transition-colors"
                >
                  Drop the lid: switch to a one-part open mold
                </button>
              )}
            </div>
          )}
        </div>

        {/* Right Column: Mold Configuration Form */}
        <div className="lg:col-span-5 space-y-4 overflow-y-auto overflow-x-hidden pr-1 min-w-0">
          <div className={sectionClass}>
            <CastTopFields
              tab="rigid"
              material={material}
              onMaterial={onMaterial}
              draftDeg={draftLocked ? bakedDraftDeg : chosen.draftAngleDeg}
              onDraft={(v) => set('draftAngleDeg', v)}
              draftLocked={draftLocked}
              draftHint={
              'Taper on the cavity walls, off the pull direction. A vertical wall grips the casting; ' +
              'a couple of degrees lets a rigid mold let go. It costs depth x tan(angle) of lateral ' +
              `detail, here ${(result.cavityDepthMm * Math.tan((Math.max(chosen.draftAngleDeg, 0.0001) * Math.PI) / 180)).toFixed(2)} mm at the deepest wall. ` +
              'Set 0 to reproduce the part exactly and demold by hand.'
              }
            />
            <MaterialNotes notes={castMaterialWarnings(material, (castPreview?.castVolumeMm3 ?? partVolumeMm3) / 1000, { pla: true })} />

            {locksOn && (
              <div className="flex flex-wrap items-center gap-2 text-[11px] leading-snug rounded-lg px-2.5 py-2 bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-900 text-purple-800 dark:text-purple-200">
                <span className="basis-full">
                  {castMaterial(material).waterBased
                    ? `A rigid mold would lock on here, and ${castMaterial(material).label.toLowerCase()} dissolves a PVA liner: use Silicone.`
                    : 'A rigid mold would lock on here: tick the PVA liner, or use Silicone.'}
                </span>
                {!castMaterial(material).waterBased && (
                  <button type="button" onClick={() => set('dissolvableLiner', true)}
                    className="font-semibold px-2 py-1 rounded-md border border-purple-300 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/40 cursor-pointer">
                    PVA liner
                  </button>
                )}
                <button type="button" onClick={onSilicone}
                  className="font-semibold px-2 py-1 rounded-md border border-purple-300 dark:border-purple-800 hover:bg-purple-100 dark:hover:bg-purple-900/40 cursor-pointer">
                  Silicone
                </button>
              </div>
            )}

            <HintAnchor hint="PLA mold, PVA where the casting touches it. Every undercut is kept; the PVA dissolves and the PLA lifts off. Needs a two-filament printer.">
              <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(options.dissolvableLiner)}
                  onChange={(e) => set('dissolvableLiner', e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500"
                />
                Dissolvable PVA Liner (PLA + PVA 3MF)
              </label>
            </HintAnchor>
            {result.liner && (
              <div className="pl-6 text-[11px] leading-snug text-slate-600 dark:text-slate-300 space-y-1">
                <div>
                  PVA <strong>{result.liner.pvaGrams} g</strong> · PLA <strong>{result.liner.plaGrams} g</strong> ·
                  thickest PVA {result.liner.thickestPvaMm} mm, about {result.liner.dissolveHours} h to dissolve
                </div>
                <ol className="list-decimal pl-4 space-y-0.5 text-slate-500 dark:text-slate-400">
                  {result.liner.steps.map((step, i) => <li key={i}>{step}</li>)}
                </ol>
              </div>
            )}
          </div>

          <AdvancedBlock>
          <div className={sectionClass}>
            <div className={sectionTitleClass}>Mold Architecture</div>
            <Field label="Mold Style" hint="Auto uses a one-part open mold when that keeps the shape, and two interlocking halves when it does not.">
              <Segmented
                value={options.moldType}
                onChange={(v) => set('moldType', v)}
                options={[
                  ['auto', 'Auto'],
                  ['clamshell', 'Two-Part'],
                  ['open', 'One-Part Open'],
                ] as const}
              />
            </Field>
            <Field
              label="Opens Along"
              hint="The direction the mold pulls off the part. Auto tries every one and keeps the one that fills in the least of the shape."
            >
              <select
                value={options.pullDirection ?? 'auto'}
                onChange={(e) => set('pullDirection', e.target.value as MoldOptions['pullDirection'])}
                className={inputClass}
              >
                <option value="auto">Auto</option>
                <option value="+z">Top to bottom (Z)</option>
                <option value="+y">Front to back (Y)</option>
                <option value="+x">Side to side (X)</option>
                <option value="-z">Upside down (−Z)</option>
                <option value="-y">Back to front (−Y)</option>
                <option value="-x">Other side (−X)</option>
              </select>
            </Field>

            <div className="grid grid-cols-2 gap-3 min-w-0">
              <Field label="Wall Margin (mm)" hint="Perimeter flange width around the cast part." hintAlign="start">
                <NumberInput
                  min={4}
                  max={50}
                  step={1}
                  value={options.wallMarginMm}
                  onChange={(v) => set('wallMarginMm', v)}
                  className={inputClass}
                />
              </Field>
              <Field label="Base Floor (mm)" hint="Slab thickness behind the cavity floor/roof." hintAlign="end">
                <NumberInput
                  min={2}
                  max={30}
                  step={1}
                  value={options.baseThicknessMm}
                  onChange={(v) => set('baseThicknessMm', v)}
                  className={inputClass}
                />
              </Field>
            </div>

            <div className="grid grid-cols-2 gap-3 min-w-0">
              <Field label="Cavity Depth (mm)" hint="0 uses the scene's natural height. Set a value to scale total depth." hintAlign="start">
                <NumberInput
                  min={0}
                  /*
                   * This does not trim the mold, it *rescales the part in Z*
                   * — `moldExporter` divides it by the scene's own height to
                   * get a Z scale. A ceiling of 200 meant asking for 250 on a
                   * 250 mm scene silently squashed every Z dimension to 80%.
                   * No 200 mm limit exists anywhere in the exporter.
                   */
                  max={1000}
                  step={1}
                  value={options.cavityDepthMm}
                  onChange={(v) => set('cavityDepthMm', v)}
                  className={inputClass}
                />
              </Field>
            </div>

            <label className={`flex items-center gap-2 text-xs font-semibold ${options.dissolvableLiner ? 'opacity-50' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={Boolean(options.allowUndercuts) || Boolean(options.dissolvableLiner)}
                disabled={Boolean(options.dissolvableLiner)}
                onChange={(e) => set('allowUndercuts', e.target.checked)}
                className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500"
              />
              Keep 3D Undercuts (Flexible / Silicone Mold)
            </label>

            {options.dissolvableLiner && (
              <div className="grid grid-cols-2 gap-3 min-w-0">
                <Field label="PVA Skin (mm)" hint="PVA between the casting and the PLA. 1.2 mm is three beads." hintAlign="end">
                  <NumberInput
                    min={0.8}
                    max={4}
                    step={0.1}
                    value={options.linerSkinMm ?? DEFAULT_LINER_SKIN_MM}
                    onChange={(v) => set('linerSkinMm', v)}
                    className={inputClass}
                  />
                </Field>
              </div>
            )}
          </div>

          {/* Registration Pins & Tolerances (Clamshell only) */}
          {moldType === 'clamshell' && (
            <div className={sectionClass}>
              <div className={sectionTitleClass}>Interlocking Registration Pins</div>
              <div className="grid grid-cols-3 gap-2 min-w-0">
                <Field label="Pin Dia (mm)" hint="Base diameter of tapered alignment cone." hintAlign="start">
                  <NumberInput
                    min={3}
                    max={20}
                    step={0.5}
                    value={options.pinDiameterMm}
                    onChange={(v) => set('pinDiameterMm', v)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Height (mm)" hint="Pin height above parting plane." hintAlign="start">
                  <NumberInput
                    min={2}
                    max={15}
                    step={0.5}
                    value={options.pinHeightMm}
                    onChange={(v) => set('pinHeightMm', v)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Tolerance" hint="Clearance offset added to female sockets for 3D printer fit." hintAlign="end">
                  <NumberInput
                    min={0.1}
                    max={1.0}
                    step={0.05}
                    value={options.pinToleranceMm}
                    onChange={(v) => set('pinToleranceMm', v)}
                    className={inputClass}
                  />
                </Field>
              </div>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">
                Corner 1 is keyed with an asymmetric offset so the two halves cannot be assembled reversed.
              </p>
            </div>
          )}

          {/* Pour Sprue & Air Bleed Channels */}
          <div className={sectionClass}>
            <div className={sectionTitleClass}>Pouring & Vents</div>
            <div className="space-y-3 min-w-0">
              {moldType === 'clamshell' && (
                <>
                  <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.includeSprue}
                      onChange={(e) => set('includeSprue', e.target.checked)}
                      className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500"
                    />
                    Include Tapered Pour Sprue Funnel
                  </label>

                  {options.includeSprue && (
                    <div className="grid grid-cols-2 gap-3 pl-6 min-w-0">
                      <Field label="Inlet Dia (mm)" hintAlign="start">
                        <NumberInput
                          min={4}
                          max={30}
                          step={1}
                          value={options.sprueTopDiaMm}
                          onChange={(v) => set('sprueTopDiaMm', v)}
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Outlet Dia (mm)" hintAlign="end">
                        <NumberInput
                          min={2}
                          max={15}
                          step={0.5}
                          value={options.sprueBottomDiaMm}
                          onChange={(v) => set('sprueBottomDiaMm', v)}
                          className={inputClass}
                        />
                      </Field>
                    </div>
                  )}
                </>
              )}

              <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                <input
                  type="checkbox"
                  checked={options.includeVents}
                  onChange={(e) => set('includeVents', e.target.checked)}
                  className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500"
                />
                Include Air Riser Bleed Holes (Prevents Bubbles)
              </label>
              {options.includeVents && (
                <div className="pl-5 border-l-2 border-purple-200 dark:border-purple-900">
                  <Field label="Vent Dia (mm)">
                    <NumberInput
                      value={options.ventDiaMm}
                      min={0.8}
                      max={6}
                      step={0.1}
                      onChange={(v) => set('ventDiaMm', v)}
                      className={inputClass}
                    />
                  </Field>
                </div>
              )}

              {moldType === 'clamshell' && (
                <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                  <input
                    type="checkbox"
                    checked={options.includePryNotches}
                    onChange={(e) => set('includePryNotches', e.target.checked)}
                    className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500"
                  />
                  Include Side Demolding Pry Slots
                </label>
              )}
            </div>
          </div>
          </AdvancedBlock>
          <ChainResult title="Simulated: poured and taken out" lines={castLines} />
          <CastingGuide result={result} moldType={moldType} />
        </div>
      </PanelBody>

      {/* Footer Actions */}
      <PanelFooter>
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Export layout:{' '}
          <strong className="text-slate-700 dark:text-slate-200">
            {moldType === 'open'
              ? 'Single open mold flat on Z=0 build plate'
              : 'Both halves flat on Z=0 build plate'}
          </strong>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Cancel
          </button>

          <AddSimulationButton
            disabled={!result.success || result.totalTriangles === 0 || busy || saving || castBusy}
            onSimulate={(placement) => void handleSimulateCast(placement)}
            progress={castBusy ? 0.5 : addCastToScene.progress}
            error={castError ?? addCastToScene.error}
            label="Simulate Cast"
          />

          <AddSimulationButton
            disabled={!result.success || result.totalTriangles === 0 || busy || saving}
            onSimulate={() => void handleAddToScene()}
            progress={addToScene.progress}
            error={addToScene.error}
            label="Add Mold"
            besideOnly
          />

          <button
            onClick={() =>
              void handleDownload(
                result.liner
                  ? moldType === 'open' ? 'casting_mold_open_pva.3mf' : 'casting_mold_plate_pva.3mf'
                  : moldType === 'open' ? 'casting_mold_open.stl' : 'casting_mold_plate.stl'
              )
            }
            disabled={!result.success || result.totalTriangles === 0 || busy || saving}
            className="flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl shadow-md hover:shadow-lg disabled:opacity-50 transition-all cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>{result.liner ? (saving ? 'Encoding 3MF…' : 'Download 3MF') : saving ? 'Encoding STL…' : 'Download STL'}</span>
          </button>
        </div>
      </PanelFooter>
    </>
  );
};
