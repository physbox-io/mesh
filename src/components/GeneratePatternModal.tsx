import React, { useMemo, useRef, useState, useEffect } from 'react';
import { X, AlertCircle, Shuffle, Sparkles } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { useSettled } from './carveTooling';
import { drawHeightmapPreview } from '../utils/heightmapPreview';
import {
  buildPatternPlank,
  patternById,
  PANEL_BASE_MM,
  RELIEF_FLOOR_MM,
  DEFAULT_DEPTH_FRACTION,
  MIN_SENSIBLE_DEPTH_MM,
  type PatternOptions,
  type PatternSpec,
} from '../utils/surfacePatterns';
import type { SceneGraph } from '../types/scene';
import type { ReliefCarveOptions } from '../utils/reliefCarveExporter';

/**
 * The surface pattern generators, in the preset dropdown's Generators group.
 *
 * What this makes is not a pattern to be applied to something -- it is the
 * finished board. The body it puts in the scene is exactly the stock's
 * footprint, exactly the stock's thickness, and its top face is the pattern.
 * That is why the viewport shows one plank rather than a pattern hovering over
 * a block, and why the relief export needs no special case: it samples the
 * scene from above with Z0 at the stock's top face, so the peaks are untouched
 * original surface and only the valleys are cut.
 */

/** How fine a grid the mesh is built on. The preview uses a coarser one. */
const EXPORT_COLS = 420;
const PREVIEW_COLS = 240;

const inputClass =
  'w-full px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ' +
  'text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:border-fuchsia-500';

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({
  label, hint, children,
}) => (
  <label className="block space-y-1" title={hint}>
    <span className="block text-[11px] font-medium text-slate-500 dark:text-slate-400">{label}</span>
    {children}
  </label>
);

export const GeneratePatternModal: React.FC = () => {
  const patternId = useStore((s) => s.patternGeneratorId);
  const closePatternGenerator = useStore((s) => s.closePatternGenerator);
  const loadGeneratedScene = useStore((s) => s.loadGeneratedScene);
  const stock = useStore((s) => s.stock);
  const setStock = useStore((s) => s.setStock);

  const spec: PatternSpec | undefined = patternId ? patternById(patternId) : undefined;

  const [options, setOptions] = useState<PatternOptions>({});
  const [depthMm, setDepthMm] = useState<number>(6);
  /** Stop after the flat mill, or send the ball nose over it afterwards. */
  const [finish, setFinish] = useState<'rough' | 'smooth'>('smooth');
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /*
   * Re-seed the controls when a different generator is picked.
   *
   * Folded in during render rather than from an effect: an effect would draw
   * one frame of the new pattern's dialog carrying the previous pattern's
   * options, and those options index into a different set of fields entirely.
   */
  const [syncedId, setSyncedId] = useState<string | null>(null);
  if (spec && syncedId !== spec.id) {
    setSyncedId(spec.id);
    setOptions({ ...spec.defaults });
    setFinish(spec.flatTopped ? 'rough' : 'smooth');
    // Each pattern says how deep it wants to be read at; see `depthFraction`.
    const wanted = stock.thicknessMm * (spec.depthFraction ?? DEFAULT_DEPTH_FRACTION);
    const room = stock.thicknessMm - PANEL_BASE_MM - RELIEF_FLOOR_MM;
    setDepthMm(Math.round(Math.min(room, Math.max(MIN_SENSIBLE_DEPTH_MM, wanted)) * 10) / 10);
  }

  /*
   * The reaction-diffusion pattern runs a few thousand steps of a simulation,
   * which is a fraction of a second rather than the microseconds the others
   * take. Settling the inputs keeps a slider from queueing one run per frame.
   */
  const settledOptions = useSettled(options, 180);
  const settledDepth = useSettled(depthMm, 180);
  const settledStock = useSettled(stock, 180);

  const preview = useMemo(() => {
    if (!spec) return null;
    try {
      return {
        plank: buildPatternPlank(spec, settledOptions, settledStock, settledDepth, PREVIEW_COLS),
        error: null as string | null,
      };
    } catch (e) {
      return { plank: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [spec, settledOptions, settledStock, settledDepth]);

  useEffect(() => {
    if (preview?.plank && canvasRef.current) {
      drawHeightmapPreview(
        canvasRef.current,
        preview.plank.mesh,
        settledDepth / 1000,
        settledStock.widthMm / 1000,
        // The same palette the board is painted with, so the dialog shows the
        // thing that will appear in the scene rather than a grey rehearsal.
        spec?.palette ? (h) => spec.palette!(h, settledOptions) : undefined
      );
    }
  }, [preview, settledDepth, settledStock.widthMm, spec, settledOptions]);

  if (!spec) return null;

  const set = (key: string, value: number | string | undefined) => {
    if (value === undefined) return;
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  const plank = preview?.plank ?? null;
  const sizeNote = plank
    ? `${(plank.mesh.sizeM[0] * 1000).toFixed(0)} × ${(plank.mesh.sizeM[1] * 1000).toFixed(1)} × ` +
      `${(plank.mesh.sizeM[2] * 1000).toFixed(1)} mm`
    : '—';

  const handleGenerate = () => {
    let built;
    try {
      built = buildPatternPlank(spec, options, stock, depthMm, EXPORT_COLS);
    } catch {
      // The dialog already shows why, and the button is disabled in that case.
      return;
    }
    const scene: SceneGraph = { nodes: [built.node] };
    const carve: Partial<ReliefCarveOptions> = {
      stockWidthMm: stock.widthMm,
      stockDepthMm: stock.depthMm,
      stockThicknessMm: stock.thicknessMm,
      // The exporter takes its carve depth from the model's total height, and
      // that number drives the roughing layers and how far the cutter must
      // reach. The panel is the pattern plus its base, so this is that.
      carveDepthMm: depthMm + PANEL_BASE_MM,
      // The board is already the size of the stock, so there is nothing to fit
      // and nothing to rescale: cut it where it is, at the size it is.
      fitMode: 'manual',
      scalePercent: 100,
      // The exaggeration is in the pattern, not in the Z axis. 'fill' would
      // stretch whatever height range the pattern happened to use onto the
      // carve depth, which would make the depth control mean something
      // different for every pattern.
      verticalScaleMode: 'proportional',
      verticalExaggeration: 1,
      // The board covers the whole stock, so there is no background to take
      // down to the floor. 'carve' would cut a moat round nothing.
      backgroundMode: 'skip',
      // See `flatTopped`: a two-level pattern is finished by the roughing bit.
      finishingEnabled: finish === 'smooth',
    };
    loadGeneratedScene(scene, carve);

    /*
     * Replace the note card as well as the scene.
     *
     * The cards belong to App, not to the store, and the same global the MCP
     * bridge and the file loader use is how anything else reaches them. Without
     * this the previous preset's card is left sitting over a board it has
     * nothing to do with, explaining a double pendulum that is no longer there.
     */
    const settings = spec.fields
      .map((f) => `- **${f.label}:** ${options[f.key]}`)
      .join('\n');
    (window as unknown as {
      _physics_setNoteCards?: (cards: Array<{ id: string; markdown: string; minimized: boolean; x: number; y: number }>) => void;
    })._physics_setNoteCards?.([{
      id: `generated_${spec.id}`,
      markdown:
        `# ${spec.label}\n\n${spec.blurb}\n\n` +
        `${settings}\n- **Carve depth:** ${depthMm} mm\n` +
        `- **Cut:** ${finish === 'rough' ? 'roughing only, flat mill' : 'roughed, then ball-nose finish'}\n` +
        `- **Stock:** ${stock.widthMm} x ${stock.depthMm} x ${stock.thicknessMm} mm\n\n` +
        `The board is the panel, and the pattern is its top face. Relief carve is ` +
        `already set up for it — the peaks are untouched stock and only the valleys are cut.` +
        (spec.caveat ? `\n\n> ${spec.caveat}` : ''),
      minimized: false,
      x: 16,
      y: 16,
    }]);
  };

  const maxDepthMm = stock.thicknessMm - PANEL_BASE_MM - RELIEF_FLOOR_MM;
  const tooDeep = depthMm > maxDepthMm;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-xs">
      <div className="w-full max-w-3xl bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 overflow-hidden flex flex-col max-h-[90dvh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-fuchsia-500" />
            <div>
              <h3 className="font-bold text-slate-800 dark:text-slate-100 text-base">{spec.label}</h3>
              <p className="text-[11px] text-slate-500 dark:text-slate-400">{spec.blurb}</p>
            </div>
          </div>
          <button
            onClick={closePatternGenerator}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto flex-1 grid grid-cols-1 md:grid-cols-[1fr_1.1fr] gap-5">
          {/* Controls */}
          <div className="space-y-3">
            {spec.fields.map((f) => {
              if (f.kind === 'number') {
                return (
                  <Field key={f.key} label={f.unit ? `${f.label} (${f.unit})` : f.label} hint={f.hint}>
                    <NumberInput
                      min={f.min}
                      max={f.max}
                      step={f.step}
                      fallbackOnBlur={Number(spec.defaults[f.key])}
                      value={Number(options[f.key])}
                      onChange={(v) => set(f.key, v)}
                      className={inputClass}
                    />
                  </Field>
                );
              }
              if (f.kind === 'choice') {
                return (
                  <Field key={f.key} label={f.label} hint={f.hint}>
                    <select
                      value={String(options[f.key] ?? '')}
                      onChange={(e) => set(f.key, e.target.value)}
                      className={`${inputClass} cursor-pointer`}
                    >
                      {f.options.map((o) => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                      ))}
                    </select>
                  </Field>
                );
              }
              return (
                <Field key={f.key} label={f.label} hint={f.hint}>
                  <div className="flex items-center gap-1.5">
                    <NumberInput
                      min={1}
                      max={999999}
                      step={1}
                      fallbackOnBlur={1}
                      value={Number(options[f.key])}
                      onChange={(v) => set(f.key, v)}
                      className={inputClass}
                    />
                    <button
                      type="button"
                      onClick={() => set(f.key, Math.floor(Math.random() * 99999) + 1)}
                      title="Try another one of the same kind"
                      className="p-1.5 rounded-md border border-slate-200 dark:border-slate-700 text-slate-500 hover:text-fuchsia-500 hover:border-fuchsia-500 transition-colors cursor-pointer"
                    >
                      <Shuffle className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </Field>
              );
            })}

            <div className="pt-1 border-t border-slate-200 dark:border-slate-800" />

            <Field
              label="Carve depth (mm)"
              hint="How far the deepest point of the pattern goes below the surface of the board. Everything above it is untouched stock face."
            >
              <NumberInput
                min={0.1}
                max={Math.max(0.1, maxDepthMm)}
                step={0.5}
                fallbackOnBlur={6}
                value={depthMm}
                onChange={(v) => { if (v !== undefined) setDepthMm(v); }}
                className={inputClass}
              />
            </Field>

            <Field
              label="Cut"
              hint="Rough only: the flat mill leaves flat tops and floors and stepped walls, in about an hour. Finish: the ball nose then smooths every wall, which can take a day."
            >
              <select
                value={finish}
                onChange={(e) => setFinish(e.target.value as 'rough' | 'smooth')}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="rough">Rough only — flat mill, fast</option>
                <option value="smooth">Rough, then finish — ball nose, smooth walls, slow</option>
              </select>
            </Field>

            <Field
              label="Stock (mm)"
              hint="The board on the bench — the same one the status bar shows. The pattern is generated at exactly this size."
            >
              <div className="flex items-center gap-1.5">
                <NumberInput
                  min={1} max={3000} step={1} fallbackOnBlur={150}
                  value={stock.widthMm}
                  onChange={(v) => { if (v !== undefined) setStock({ widthMm: v }); }}
                  className={inputClass}
                  aria-label="Stock width in mm"
                />
                <span className="text-xs text-slate-400">×</span>
                <NumberInput
                  min={1} max={3000} step={1} fallbackOnBlur={150}
                  value={stock.depthMm}
                  onChange={(v) => { if (v !== undefined) setStock({ depthMm: v }); }}
                  className={inputClass}
                  aria-label="Stock depth in mm"
                />
                <span className="text-xs text-slate-400">×</span>
                <NumberInput
                  min={0.1} max={300} step={0.1} fallbackOnBlur={18}
                  value={stock.thicknessMm}
                  onChange={(v) => { if (v !== undefined) setStock({ thicknessMm: v }); }}
                  className={inputClass}
                  aria-label="Stock thickness in mm"
                />
              </div>
            </Field>
          </div>

          {/* Preview */}
          <div className="space-y-3">
            <div className="rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-800/60">
              {plank ? (
                <canvas
                  ref={canvasRef}
                  className="w-full block"
                  style={{ imageRendering: 'auto', aspectRatio: `${stock.widthMm} / ${stock.depthMm}` }}
                />
              ) : (
                <div className="p-8 text-center text-xs text-slate-500 dark:text-slate-400">
                  Nothing to show yet.
                </div>
              )}
            </div>

            {preview?.error && (
              <div className="flex items-start gap-2 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900/60">
                <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                <p className="text-[11px] text-amber-700 dark:text-amber-300 leading-relaxed">{preview.error}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 text-[11px]">
              <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                <div className="text-slate-400">Board</div>
                <div className="font-semibold text-slate-700 dark:text-slate-200">{sizeNote}</div>
              </div>
              <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                <div className="text-slate-400">Triangles</div>
                <div className="font-semibold text-slate-700 dark:text-slate-200">
                  {plank ? plank.mesh.triangleCount.toLocaleString() : '—'}
                </div>
              </div>
            </div>

            {spec.caveat && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">{spec.caveat}</p>
            )}

            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              The pattern runs to the edge of the stock, so the export will say it overhangs: the
              cutter cannot reach the outer half-diameter without leaving the material, and that
              band stays at full height. Trim or edge the panel afterwards, or drop the plan scale
              a couple of percent to pull the pattern inside it.
            </p>
            <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed">
              One object, not a pattern laid over a block: the panel is the footprint of the stock
              and the pattern is its top face, so the relief export cuts only the valleys and leaves
              the high points as untouched surface. It is {PANEL_BASE_MM} mm thick under the deepest
              cut — what it is cut <em>from</em> is the {stock.thicknessMm} mm stock on the bench.
            </p>
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-slate-200 dark:border-slate-800">
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Replaces whatever is in the scene.
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={closePatternGenerator}
              className="px-3 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleGenerate}
              disabled={!plank || tooDeep}
              className="px-4 py-1.5 text-xs font-bold text-white bg-fuchsia-600 hover:bg-fuchsia-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-lg transition-colors cursor-pointer"
            >
              Generate
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
