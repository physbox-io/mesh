// ---------------------------------------------------------------------------
// Cuts
// ---------------------------------------------------------------------------
//
// Putting a hole in a part, on any body that is made of shapes.
//
// This exists because there was no way to do it. A body's geoms ARE its boolean
// program, and nothing in the app could add a geom to a body — dragging a shape
// in while one was selected made a child body, whose geoms belong to a
// different program entirely and are invisible to the parent's. So a hole could
// be authored in a preset, in OpenSCAD or over MCP, and nowhere else, while the
// panel cheerfully advised dragging one in from the sidebar.
//
// Two decisions carry the design:
//
//   A cut is stated by WHERE it goes into the part and how deep, not by where
//   its middle is and how long it is. Those are what the primitive underneath
//   is made of, and converting between them — a 10 mm hole in the top of a
//   40 mm cube is a 12 mm cylinder centred at 16 — is arithmetic no one should
//   be doing in their head. See cutGeometry in utils/csg.ts, which does it.
//
//   The spot is picked, not chosen from a list. Click the surface — or select
//   the face, in the lattice editor — and the hole goes there, square to it,
//   however that surface happens to be angled. There is no set of axis buttons
//   because there is no set of axes: a lattice VERTEX is three integers, but a
//   face joining any three of them can point anywhere, and a bevelled,
//   smoothed or imported surface certainly does.
//
//   And the depth is measured from the MATERIAL, by casting a ray back down the
//   cut's own line. Measuring from a bounding box is right on a cube and wrong
//   on everything else: on an L-bracket a hole over the low arm would be
//   measured from the top of the tall one, and if the step were deeper than the
//   hole, the cutter would never reach the material and the hole would silently
//   not happen.
// ---------------------------------------------------------------------------

import { Circle, Square, Donut, Trash2 } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { cutDepthOf, sourcePositiveBounds } from '../utils/csg';
import type { SceneGeom, SceneNode } from '../types/scene';

const SHAPES = [
  ['cylinder', 'Hole', Circle, 'A round hole at a diameter you type, square to the surface you last clicked. Goes right through until you give it a depth.'],
  ['box', 'Slot', Square, 'A rectangular pocket or slot, sized in millimetres, square to the surface you last clicked.'],
  ['sphere', 'Dish', Circle, 'A spherical scoop: a seat for a ball, or a rounded pocket. Always blind.'],
] as const;

/** Metres in, millimetres out, to a tenth of a micron and no trailing noise. */
const mm = (metres: number | undefined) => Math.round((metres ?? 0) * 1000 * 10000) / 10000;
const metres = (millimetres: number | undefined) => (millimetres ?? 0) / 1000;

const fieldClass =
  'w-full px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ' +
  'text-[10px] font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 tabular-nums text-center';

function CutField({ label, value, onChange, title, min }: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  title?: string;
  min?: number;
}) {
  return (
    <label className="flex-1 min-w-0" title={title}>
      <span className="block text-[9px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
        {label}
      </span>
      <NumberInput value={value} onChange={(v) => v !== undefined && onChange(v)} min={min} className={fieldClass} />
    </label>
  );
}

function CutRow({ node, geom, index }: {
  node: SceneNode;
  geom: SceneGeom;
  index: number;
}) {
  const deleteNodeGeom = useStore((s) => s.deleteNodeGeom);
  const setCutDepth = useStore((s) => s.setCutDepth);
  const setCutSection = useStore((s) => s.setCutSection);
  const moveCutTo = useStore((s) => s.moveCutTo);
  const spot = useStore((s) => s.cutSpot);

  const through = !(geom.cutDepth && geom.cutDepth > 0);
  const size = geom.size || [];
  const at = geom.cutAt || [0, 0, 0];
  const label = geom.type === 'cylinder' ? 'Hole' : geom.type === 'box' ? 'Slot' : 'Dish';
  // Measured against the material under this hole, exactly as the store does
  // when it derives the cutter — so a through hole in a stepped part reads as
  // the thickness it actually passes through, not the height of the whole part.
  const depth = cutDepthOf(node, geom);
  // A spot picked on this body that this cut is not already on: the offer to
  // move it there is worth making, because otherwise re-placing a hole means
  // deleting it and cutting another.
  const elsewhere = spot?.nodeId === node.id
    && (geom.cutAt || []).some((v, a) => Math.abs(v - (spot.at[a] ?? 0)) > 1e-6);

  return (
    <div className="rounded-lg border border-rose-200 dark:border-rose-900/60 bg-rose-50/50 dark:bg-rose-950/20 p-1.5 space-y-1">
      <div className="flex items-center gap-1">
        <span className="flex-1 text-[10px] font-semibold text-rose-600 dark:text-rose-400">{label}</span>
        {elsewhere && (
          <button
            type="button"
            onClick={() => moveCutTo(node.id, index, { at: spot!.at, normal: spot!.normal })}
            title="Move this cut to the spot you last clicked, square to the surface there"
            className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase cursor-pointer bg-white dark:bg-slate-800 text-slate-400 hover:text-rose-600 transition-colors"
          >
            Move here
          </button>
        )}
        <button
          type="button"
          onClick={() => deleteNodeGeom(node.id, index)}
          title="Remove this cut. The material comes back"
          className="p-0.5 rounded text-slate-400 hover:text-rose-600 cursor-pointer"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      <div className="flex gap-1 items-end">
        {geom.type === 'box'
          ? ([0, 1] as const).map((i) => (
            <CutField
              key={i}
              label={i === 0 ? 'Wide mm' : 'Long mm'}
              min={0.01}
              value={mm((size[i] ?? 0) * 2)}
              title="The slot's own width and breadth, across the surface it is cut into."
              onChange={(v) => setCutSection(node.id, index, [
                i === 0 ? metres(v) / 2 : size[0] ?? 0.005,
                i === 1 ? metres(v) / 2 : size[1] ?? 0.005,
              ])}
            />
          ))
          : (
            <CutField
              label="Ø mm"
              min={0.01}
              value={mm((size[0] ?? 0) * 2)}
              title="Diameter. This is the number a drill or a bearing is specified by, so it is the number you type."
              onChange={(v) => setCutSection(node.id, index, [metres(v) / 2])}
            />
          )}

        {/* Depth of the HOLE, measured into the material — never the length of
            the cutter, which is longer and is worked out for you. */}
        <CutField
          label="Deep mm"
          min={0.01}
          value={mm(depth)}
          title="How far into the material the cut goes, measured from the surface under the middle of the hole. The cutter itself runs a little past that surface, because a flush cut leaves coincident faces and a boolean of those is not reliably a solid."
          onChange={(v) => setCutDepth(node.id, index, v)}
        />

        {geom.type !== 'sphere' && (
          <button
            type="button"
            onClick={() => setCutDepth(node.id, index, through ? mm(depth) / 2 : 0)}
            title={through
              ? 'Going right through. Press to make it a blind hole half the depth, then type the depth you want.'
              : 'Make it go right through, however thick the part is or becomes.'}
            className={`px-1.5 py-1 rounded text-[9px] font-bold uppercase cursor-pointer transition-colors ${
              through
                ? 'bg-rose-500/20 text-rose-600 dark:text-rose-300'
                : 'bg-white dark:bg-slate-800 text-slate-400 hover:text-slate-600'
            }`}
          >
            Thru
          </button>
        )}
      </div>

      {/* Where it is and which way it runs. A readout rather than fields: the
          spot is a point on a surface, and three boxes of millimetres cannot
          say "on that face" — clicking the face can, so that is how it moves. */}
      <div
        className="flex items-center gap-1 text-[9px] font-mono text-slate-400 dark:text-slate-500 tabular-nums"
        title="Where the cut enters, and the direction it runs, in the body's own axes. Click somewhere else on the part to move it."
      >
        <span>at {at.map((v) => mm(v).toFixed(1)).join(', ')}</span>
        <span className="ml-auto">↧ {(geom.cutNormal ?? [0, 0, 1]).map((v) => v.toFixed(2)).join(', ')}</span>
      </div>
    </div>
  );
}

/**
 * The Cut controls for one body: the shapes you can take out of it, and the
 * ones already taken.
 *
 * `disabled` is for a shape with no inside yet — an open lattice surface. A
 * boolean needs a solid to cut into, and OpenSCAD's answer to subtracting from
 * a surface is not a part with a hole in it; it is nothing at all, several
 * seconds later.
 */
export function CutControls({ node, disabled, disabledReason, compact }: {
  node: SceneNode;
  disabled?: boolean;
  disabledReason?: string;
  compact?: boolean;
}) {
  const addBodyCut = useStore((s) => s.addBodyCut);
  const bounds = sourcePositiveBounds(node);
  const cuts = (node.geoms || [])
    .map((geom, index) => ({ geom, index }))
    .filter(({ geom }) => geom.csg === 'difference' && !geom.csgDerived);

  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {SHAPES.map(([shape, name, Icon, hint]) => (
          <button
            key={shape}
            type="button"
            disabled={disabled || !bounds}
            onClick={() => addBodyCut(node.id, shape)}
            title={disabled ? (disabledReason ?? 'There is nothing solid to cut into yet.') : hint}
            className={`flex-1 flex items-center justify-center gap-1 py-1 rounded-md text-[10px] font-semibold transition-colors ${
              disabled || !bounds
                ? 'bg-slate-50 dark:bg-slate-800/40 text-slate-300 dark:text-slate-600 cursor-not-allowed'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-500 hover:text-rose-600 dark:hover:text-rose-400 cursor-pointer'
            }`}
          >
            <Icon className="w-3 h-3" />{name}
          </button>
        ))}
      </div>

      {bounds && cuts.length > 0 && (
        <div className="space-y-1">
          {cuts.map(({ geom, index }) => (
            <CutRow key={geom.name || index} node={node} geom={geom} index={index} />
          ))}
          {!compact && (
            <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
              A cut is drawn as a red outline. Click anywhere on the part to aim the next one, or to move one you have.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** The heading icon, so both hosts label the section the same way. */
export const CutIcon = Donut;

export default CutControls;
