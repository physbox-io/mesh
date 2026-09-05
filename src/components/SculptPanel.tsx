// ---------------------------------------------------------------------------
// The sculpting tool palette
// ---------------------------------------------------------------------------
//
// A sculpting UI lives or dies on how little of it you have to look at. The
// hand is on the model, the eyes are on the model, and every glance over here to
// find a brush is a glance away from the thing being made — so the panel is
// built to be learned once and then never read again: six brushes on the number
// keys, the two sliders that matter on the bracket keys, and everything else
// out of the way.
//
// What stays visible is what you cannot see by looking at the model: how dense
// the mesh has become, and whether the surface is still closed. Both decide
// whether the sculpt can be printed or machined, and neither shows up in the
// viewport until something downstream refuses the file.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import {
  Paintbrush, Expand, Waves, Minimize2, Magnet, Hand,
  FlipHorizontal2, Sparkles, Check, TriangleAlert, Boxes,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import type { BrushType } from '../utils/sculptMesh';

interface BrushDefinition {
  type: BrushType;
  label: string;
  key: string;
  icon: typeof Paintbrush;
  hint: string;
}

/**
 * The brushes, in the order they are reached for.
 *
 * Draw and grab are the two that make shape; smooth is the one used more than
 * both of them put together; the rest refine. The order is the order of the
 * number keys, so it is worth it being the order of use rather than the order
 * they happen to be implemented in.
 */
const BRUSHES: BrushDefinition[] = [
  { type: 'draw', label: 'Draw', key: '1', icon: Paintbrush, hint: 'Push the surface out along its normal. Hold Ctrl to carve in instead.' },
  { type: 'grab', label: 'Grab', key: '2', icon: Hand, hint: 'Take hold of the surface and drag it. The best brush for gross shape.' },
  { type: 'smooth', label: 'Smooth', key: '3', icon: Waves, hint: 'Average the surface towards its neighbours. Use it more than you think you need to.' },
  { type: 'inflate', label: 'Inflate', key: '4', icon: Expand, hint: 'Push every vertex along its own normal — swells a form rather than raising a ridge.' },
  { type: 'flatten', label: 'Flatten', key: '5', icon: Minimize2, hint: 'Pull the surface onto its own local plane. Makes a facet out of a bulge.' },
  { type: 'pinch', label: 'Pinch', key: '6', icon: Magnet, hint: 'Draw material sideways towards the cursor. Sharpens an edge that smoothing has softened.' },
];

const panelClass =
  'absolute top-20 left-4 z-30 w-60 rounded-xl border border-slate-200 dark:border-slate-800 ' +
  'bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-lg p-3 space-y-3 select-none';

const labelClass = 'text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

/** A slider with its value shown, because a slider alone is not a number. */
function Slider({
  label, value, min, max, step, onChange, format, hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  format: (v: number) => string;
  hint?: string;
}) {
  return (
    <label className="block" title={hint}>
      <div className="flex items-baseline justify-between mb-1">
        <span className={labelClass}>{label}</span>
        <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full accent-blue-500 cursor-pointer"
      />
    </label>
  );
}

function Toggle({
  label, active, onClick, icon: Icon, hint,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: typeof Paintbrush;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold transition-all border ${
        active
          ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
          : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300'
      }`}
    >
      <Icon className="w-3.5 h-3.5" />
      {label}
    </button>
  );
}

export function SculptPanel() {
  const sculptNodeId = useStore((s) => s.sculptNodeId);
  const stats = useStore((s) => s.sculptStats);
  const brush = useStore((s) => s.sculptBrush);
  const setBrush = useStore((s) => s.setSculptBrush);
  const setSculptNodeId = useStore((s) => s.setSculptNodeId);

  // Keyboard: the whole point of the palette is not having to use it.
  useEffect(() => {
    if (!sculptNodeId) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const chosen = BRUSHES.find((b) => b.key === event.key);
      if (chosen) {
        setBrush({ type: chosen.type });
        event.preventDefault();
        return;
      }

      // Bracket keys size the brush, the convention in every painting tool
      // there has ever been. Multiplicative, so the same keypress feels the
      // same whether the brush is tiny or huge.
      if (event.key === '[') {
        setBrush({ radius: Math.max(0.002, brush.radius / 1.15) });
        event.preventDefault();
      } else if (event.key === ']') {
        setBrush({ radius: Math.min(1, brush.radius * 1.15) });
        event.preventDefault();
      } else if (event.key.toLowerCase() === 'x') {
        setBrush({ symmetryX: !brush.symmetryX });
        event.preventDefault();
      } else if (event.key === 'Escape') {
        setSculptNodeId(null);
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sculptNodeId, brush.radius, brush.symmetryX, setBrush, setSculptNodeId]);

  // Ctrl inverts the brush for as long as it is held — the same gesture as
  // every sculpting tool, and the reason 'carve' is not a seventh button.
  useEffect(() => {
    if (!sculptNodeId) return;
    const down = (e: KeyboardEvent) => { if (e.key === 'Control' && !brush.invert) setBrush({ invert: true }); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Control' && brush.invert) setBrush({ invert: false }); };
    // A window that loses focus mid-hold never sees the keyup, and the brush
    // would stay inverted with nothing on screen explaining why.
    const blur = () => { if (brush.invert) setBrush({ invert: false }); };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [sculptNodeId, brush.invert, setBrush]);

  if (!sculptNodeId) return null;

  const active = BRUSHES.find((b) => b.type === brush.type) ?? BRUSHES[0];

  return (
    <div className={panelClass}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold text-slate-700 dark:text-slate-200">Sculpt</span>
        <button
          type="button"
          onClick={() => setSculptNodeId(null)}
          title="Leave the sculpt tools (Esc). The shape is already saved."
          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-[10px] font-bold"
        >
          <Check className="w-3 h-3" /> Done
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {BRUSHES.map(({ type, label, key, icon: Icon, hint }) => (
          <button
            key={type}
            type="button"
            onClick={() => setBrush({ type })}
            title={`${hint}  (${key})`}
            className={`relative flex flex-col items-center gap-1 py-2 rounded-lg border transition-all ${
              brush.type === type
                ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-slate-600'
            }`}
          >
            <Icon className="w-4 h-4" />
            <span className="text-[10px] font-semibold">{label}</span>
            <span className="absolute top-1 right-1.5 text-[8px] font-mono text-slate-300 dark:text-slate-600">{key}</span>
          </button>
        ))}
      </div>

      <p className="text-[10px] leading-snug text-slate-500 dark:text-slate-400">{active.hint}</p>

      <Slider
        label="Size"
        value={brush.radius}
        min={0.002}
        max={0.3}
        step={0.001}
        onChange={(radius) => setBrush({ radius })}
        format={(v) => `${(v * 1000).toFixed(0)} mm`}
        hint="Brush radius. [ and ] resize it without coming back here."
      />
      <Slider
        label="Strength"
        value={brush.strength}
        min={0.02}
        max={1}
        step={0.01}
        onChange={(strength) => setBrush({ strength })}
        format={(v) => `${Math.round(v * 100)}%`}
        hint="How far one dab moves the surface. Low and repeated beats high and once."
      />

      <div className="flex gap-1.5">
        {/*
          The toggle turns mirroring on; the letter beside it says in which
          plane, and cycles X → Y → Z.

          It used to be X and only X, which is the wrong plane for most of what
          gets sculpted here: every figure base faces +X, so a body's left and
          right lie along Y. Mirroring X on a head reflects front to back — the
          nose you are shaping grows a twin out of the back of the skull — and a
          matching pair of ears was not possible at all.
        */}
        <Toggle
          label="Symmetry"
          active={brush.symmetryX}
          onClick={() => setBrush({ symmetryX: !brush.symmetryX })}
          icon={FlipHorizontal2}
          hint="Mirror every stroke across a plane through the body's origin. The figure bases face +X, so Y is the plane that pairs left with right."
        />
        <button
          type="button"
          onClick={() => {
            const order = ['x', 'y', 'z'] as const;
            const next = order[(order.indexOf(brush.symmetryAxis ?? 'x') + 1) % order.length];
            setBrush({ symmetryAxis: next });
          }}
          title="Which plane symmetry mirrors in. Y pairs a figure's left and right."
          className={`px-2 rounded-md text-xs font-semibold uppercase transition-colors ${
            brush.symmetryX
              ? 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
              : 'bg-white/5 text-slate-500 hover:bg-white/10'
          }`}
        >
          {brush.symmetryAxis ?? 'x'}
        </button>
        <Toggle
          label="Detail"
          active={brush.dynamicTopology}
          onClick={() => setBrush({ dynamicTopology: !brush.dynamicTopology })}
          icon={Sparkles}
          hint="Add and remove triangles as the brush passes, so detail follows the tool. Off, the brush can only move the vertices that are already there."
        />
      </div>

      {brush.dynamicTopology && (
        <Slider
          label="Detail Size"
          value={brush.detail}
          min={0.08}
          max={0.6}
          step={0.01}
          onChange={(detail) => setBrush({ detail })}
          format={(v) => `${(brush.radius * v * 1000).toFixed(1)} mm`}
          hint="Target edge length, as a fraction of the brush. Finer means more triangles: the count below is the one to watch."
        />
      )}

      {stats && (
        <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="flex items-center gap-1 text-slate-400 dark:text-slate-500">
              <Boxes className="w-3 h-3" /> Mesh
            </span>
            <span className="font-mono text-slate-600 dark:text-slate-300">
              {stats.vertices.toLocaleString()} v · {stats.faces.toLocaleString()} f
            </span>
          </div>
          {stats.atBudget && (
            <div
              className="flex items-start gap-1 text-[10px] text-sky-600 dark:text-sky-400"
              title="Dynamic topology has stopped adding vertices. Lower the detail, use a smaller brush, or accept the density you have."
            >
              <TriangleAlert className="w-3 h-3 mt-px shrink-0" />
              <span>Detail limit reached — the brush is no longer adding density.</span>
            </div>
          )}
          {!stats.watertight && (
            <div
              className="flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400"
              title="Some edge is not shared by exactly two triangles. The viewport does not care; a slicer or a CAM job will refuse the file."
            >
              <TriangleAlert className="w-3 h-3 mt-px shrink-0" />
              <span>Surface is not closed — it will not print or machine.</span>
            </div>
          )}
        </div>
      )}

      <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500 pt-1 border-t border-slate-200 dark:border-slate-800">
        Drag on the model to sculpt · Ctrl inverts · Right-drag orbits · Ctrl+Z undoes a stroke
      </p>
    </div>
  );
}

export default SculptPanel;
