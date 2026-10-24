// ---------------------------------------------------------------------------
// The sculpting tool palette
// ---------------------------------------------------------------------------
//
// A sculpting UI lives or dies on how little of it you have to look at. The
// hand is on the model, the eyes are on the model, and every glance over here to
// find a brush is a glance away from the thing being made — so the panel is
// built to be learned once and then never read again: seven tools on the number
// keys, the two sliders that matter on the bracket keys, and everything else
// out of the way.
//
// What stays visible is what you cannot see by looking at the model: how dense
// the mesh has become, and whether the surface is still closed. Both decide
// whether the sculpt can be printed or machined, and neither shows up in the
// viewport until something downstream refuses the file.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react';
import { NumberInput } from '@physbox-io/ui';
import {
  Paintbrush, Expand, Waves, Minimize2, Magnet, Hand,
  FlipHorizontal2, Sparkles, Check, TriangleAlert, Boxes, Scissors, PaintBucket, Loader2, Info, Slice,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import { fromSceneGeom, splitComponents, type BrushType } from '../utils/sculptMesh';
import type { SceneGeom, SceneNode } from '../types/scene';
import { MAX_SCULPT_SIZE, MIN_SCULPT_SIZE } from '../utils/sculptBases';

const findNode = (nodes: SceneNode[] | undefined, id: string): SceneNode | null => {
  for (const node of nodes || []) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
};

/**
 * Splits the sculpt being worked on into one body per piece. For a sculpt
 * that was cut apart before cuts did this by themselves, and so is still one
 * body in several pieces.
 */
function separatePieces(nodeId: string) {
  const store = useStore.getState();
  const node = findNode(store.sceneGraph.nodes, nodeId);
  const geom = node?.geoms?.find((g: SceneGeom) => g.type === 'mesh' && !g.csgDerived);
  if (!geom?.renderVertices?.length || !geom.faces?.length) return;
  const pieces = splitComponents(fromSceneGeom(geom.renderVertices, geom.faces));
  if (pieces.length < 2) return;
  store.separateSculpt(nodeId, pieces, geom.name);
  store.setSculptNotice({
    text: `Now ${pieces.length} separate bodies. Press Done, then select a piece to move or delete it.`,
    tone: 'info',
  });
}

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
  { type: 'inflate', label: 'Inflate', key: '4', icon: Expand, hint: 'Push every vertex along its own normal. Swells a form rather than raising a ridge.' },
  { type: 'flatten', label: 'Flatten', key: '5', icon: Minimize2, hint: 'Pull the surface onto its own local plane. Makes a facet out of a bulge.' },
  { type: 'pinch', label: 'Pinch', key: '6', icon: Magnet, hint: 'Draw material sideways towards the cursor. Sharpens an edge that smoothing has softened.' },
  { type: 'scissors', label: 'Scissors', key: '7', icon: Scissors, hint: 'Draw a loop, on or off the model: everything inside it is cut away, straight through. Hold Ctrl to keep only the inside.' },
  { type: 'carve', label: 'Carve', key: '8', icon: Slice, hint: 'Drag a line on the clay and a cutter follows it: a clean groove, as wide as the brush and as deep as Depth. With Fill outline on, drag a loop and the whole area inside is cut out.' },
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

/**
 * The brush's range, in metres. 0.1 mm at the bottom because a resin printer
 * holds detail finer than that; it used to stop at 2 mm, and a pupil or a wink
 * slit under it could not be made.
 */
const MIN_RADIUS = 0.0001;
const MAX_RADIUS = 0.3;
/**
 * The Size slider is logarithmic: each step of travel scales the brush by the
 * same ratio. Linear over 0.1-300 mm, everything under a millimetre was the
 * first pixel of the track.
 */
const radiusToSlider = (r: number) => Math.log(r / MIN_RADIUS) / Math.log(MAX_RADIUS / MIN_RADIUS);
const sliderToRadius = (t: number) => MIN_RADIUS * Math.pow(MAX_RADIUS / MIN_RADIUS, t);

const mm = (v: number) => `${(v * 1000).toFixed(v < 0.001 ? 2 : v < 0.01 ? 1 : 0)} mm`;

/** One axis of the clay's size, typed in mm and applied when committed (Enter or leaving the box). */
function AxisSize({ label, value, onCommit }: { label: string; value: number; onCommit: (mm: number) => void }) {
  // Reset from the clay by the key it is rendered with, not by an effect.
  const shown = +(value * 1000).toFixed(1);
  const [draft, setDraft] = useState<number | undefined>(shown);
  return (
    <label className="flex items-center gap-0.5" title={`${label}: the clay's extent along this axis`}>
      <span className="text-[9px] font-bold text-slate-400">{label}</span>
      <NumberInput
        aria-label={`Clay ${label} (mm)`}
        value={draft}
        min={MIN_SCULPT_SIZE * 1000}
        max={MAX_SCULPT_SIZE * 1000}
        onChange={setDraft}
        onCommit={() => {
          if (draft !== undefined && draft > 0 && Math.abs(draft - shown) > 0.05) onCommit(draft);
        }}
        className="w-11 px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-transparent text-right font-mono tabular-nums text-[10px] text-slate-700 dark:text-slate-200"
      />
    </label>
  );
}

/**
 * The clay's size along X, Y and Z, in mm. Each box scales only its own axis,
 * about the body's origin, so a ball becomes a squat pumpkin or a tall egg;
 * typing applies on Enter or on leaving the box, so 70 never passes through 7.
 */
function ClaySize({ nodeId }: { nodeId: string }) {
  const geom = useStore((s) => findNode(s.sceneGraph.nodes, nodeId)?.geoms?.find((g: SceneGeom) => g.type === 'mesh' && !g.csgDerived));
  const resizeSculpt = useStore((s) => s.resizeSculpt);
  const size = useMemo(() => {
    const v = geom?.renderVertices;
    if (!v?.length) return null;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < v.length; i++) { lo[i % 3] = Math.min(lo[i % 3], v[i]); hi[i % 3] = Math.max(hi[i % 3], v[i]); }
    return [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  }, [geom?.renderVertices]);
  if (!size) return null;
  const axis = (i: number) => (mm: number) => {
    const target: (number | null)[] = [null, null, null];
    target[i] = mm / 1000;
    resizeSculpt(nodeId, target);
  };
  return (
    <div className="flex items-center justify-between gap-1" title="The clay's size in mm. Each box scales only its own axis, everything sculpted included, about the body's origin.">
      <span className={labelClass}>Clay mm</span>
      <span className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <AxisSize key={`${i}:${size[i].toFixed(5)}`} label={'XYZ'[i]} value={size[i]} onCommit={axis(i)} />
        ))}
      </span>
    </div>
  );
}

export function SculptPanel() {
  const sculptNodeId = useStore((s) => s.sculptNodeId);
  const stats = useStore((s) => s.sculptStats);
  const brush = useStore((s) => s.sculptBrush);
  const setBrush = useStore((s) => s.setSculptBrush);
  const setSculptNodeId = useStore((s) => s.setSculptNodeId);
  const notice = useStore((s) => s.sculptNotice);
  const scissors = brush.type === 'scissors';
  const carving = brush.type === 'carve';

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
        setBrush({ radius: Math.max(MIN_RADIUS, brush.radius / 1.15) });
        event.preventDefault();
      } else if (event.key === ']') {
        setBrush({ radius: Math.min(MAX_RADIUS, brush.radius * 1.15) });
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
  // every sculpting tool, and the reason 'carve' is not a button of its own.
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

      <ClaySize nodeId={sculptNodeId} />

      {scissors ? (
        <div className="flex gap-1.5">
          <Toggle
            label="Fill cut"
            active={brush.capCut ?? true}
            onClick={() => setBrush({ capCut: !(brush.capCut ?? true) })}
            icon={PaintBucket}
            hint="Close the cut with a new face, so the clay stays solid. Off leaves the hole open: you can see inside, and it will not print."
          />
        </div>
      ) : (<>
      <Slider
        label="Size"
        value={radiusToSlider(brush.radius)}
        min={0}
        max={1}
        step={0.002}
        onChange={(t) => setBrush({ radius: sliderToRadius(t) })}
        format={(t) => (carving ? `${mm(sliderToRadius(t) * 2)} wide` : mm(sliderToRadius(t)))}
        hint={carving ? 'How wide the cutter is. [ and ] resize it.' : 'Brush radius. [ and ] resize it without coming back here.'}
      />
      {carving && (<>
        <div className="flex gap-1">
          {(['round', 'v', 'flat'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setBrush({ carveProfile: p })}
              title={p === 'round' ? 'A ball-nosed U, with a rounded floor' : p === 'v' ? 'A V, for creases and lines' : 'Square walls and a flat floor'}
              className={`flex-1 py-1 rounded-md text-[10px] font-semibold border ${
                (brush.carveProfile ?? 'round') === p
                  ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                  : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400'
              }`}
            >
              {p === 'round' ? 'Round' : p === 'v' ? 'V' : 'Flat'}
            </button>
          ))}
        </div>
        <Toggle
          label="Fill outline"
          active={brush.carveFill === true}
          onClick={() => setBrush({ carveFill: !brush.carveFill })}
          icon={PaintBucket}
          hint="Cut out the whole area inside the loop you drag, to the depth, with a rounded edge: an eye socket, a mouth. Off, only a groove along the line."
        />
      </>)}
      {!carving && (
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
      )}
      {brush.type !== 'grab' && !carving && (
        <Slider
          label="Hardness"
          value={brush.hardness ?? 0}
          min={0}
          max={0.9}
          step={0.05}
          onChange={(hardness) => setBrush({ hardness })}
          format={(v) => (v === 0 ? 'soft' : `${Math.round(v * 100)}%`)}
          hint="How much of the brush works at full strength before its edge falls away. Soft blends; hard leaves a crisp edge, for sockets and slits."
        />
      )}
      {(brush.type === 'draw' || carving) && (
        <Slider
          label="Depth"
          value={(brush.depth ?? 0) * 1000}
          min={carving ? 0.1 : 0}
          max={20}
          step={0.1}
          onChange={(v) => setBrush({ depth: v / 1000 })}
          format={(v) => (v === 0 ? (carving ? '2.0 mm' : 'no limit') : `${v.toFixed(1)} mm`)}
          hint={carving
            ? 'How deep the cutter goes below the surface where you drag it.'
            : 'The most one stroke raises or carves, measured from the surface where it started. Brush on and it stops there: a flat floor at an exact depth. Ctrl carves.'}
        />
      )}

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
        {!carving && <Toggle
          label="Detail"
          active={brush.dynamicTopology}
          onClick={() => setBrush({ dynamicTopology: !brush.dynamicTopology })}
          icon={Sparkles}
          hint="Add and remove triangles as the brush passes, so detail follows the tool. Off, the brush can only move the vertices that are already there."
        />}
      </div>

      {brush.dynamicTopology && !carving && (
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
      </>)}

      {notice && (
        <div
          className={`flex items-start gap-1 text-[10px] leading-snug ${
            notice.tone === 'error' ? 'text-amber-600 dark:text-amber-400' : 'text-sky-600 dark:text-sky-400'
          }`}
        >
          {notice.tone === 'busy'
            ? <Loader2 className="w-3 h-3 mt-px shrink-0 animate-spin" />
            : notice.tone === 'error'
              ? <TriangleAlert className="w-3 h-3 mt-px shrink-0" />
              : <Info className="w-3 h-3 mt-px shrink-0" />}
          <span>{notice.text}</span>
        </div>
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
              <span>Detail limit reached. The brush is not adding density.</span>
            </div>
          )}
          {(stats.pieces ?? 1) > 1 && (
            <button
              type="button"
              onClick={() => separatePieces(sculptNodeId)}
              title="This body is in several pieces that are not joined. Make each piece its own body, so it can be moved or deleted, and brushed without dragging the others."
              className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[11px] font-semibold border bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:border-slate-300"
            >
              <Scissors className="w-3.5 h-3.5" /> Separate {stats.pieces} pieces
            </button>
          )}
          {!stats.watertight && (
            <div
              className="flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400"
              title="Some edge is not shared by exactly two triangles. The viewport does not care; a slicer or a CAM job will refuse the file."
            >
              <TriangleAlert className="w-3 h-3 mt-px shrink-0" />
              <span>Surface is not closed. It will not print or machine.</span>
            </div>
          )}
        </div>
      )}

      <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500 pt-1 border-t border-slate-200 dark:border-slate-800">
        {scissors
          ? 'Drag a loop to cut · Ctrl keeps the inside · Esc drops the loop · Ctrl+Z undoes a cut'
          : carving
            ? 'Drag on the clay to carve · Right-drag orbits · Ctrl+Z undoes a carve'
            : 'Drag on the model to sculpt · Ctrl inverts · Right-drag orbits · Ctrl+Z undoes a stroke'}
      </p>
    </div>
  );
}

export default SculptPanel;
