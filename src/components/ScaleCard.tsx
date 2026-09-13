// ---------------------------------------------------------------------------
// Scaling a component
// ---------------------------------------------------------------------------
//
// The scale a body is at is not stored anywhere: geoms are scaled by rewriting
// their vertices and sizes, so there is no absolute figure to show. What is
// applied is always a multiplier on what is already there, which is why the
// control is a factor with an Apply beside it rather than a slider that snaps
// back to 1 the moment it is let go — that older version left no way to know
// what had just been applied, or to ask for exactly 1.25.
//
// Axes are the world's (Z up), the same ones the position and rotation rows
// above use. Turning two of them off scales the third alone, which is how a
// part gets made taller without getting fatter.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { Ruler } from 'lucide-react';
import { scaleNodeTree } from '../utils/scaleNode';
import { SliderValue } from './SliderValue';

const AXES = ['x', 'y', 'z'] as const;
type Axis = (typeof AXES)[number];

/**
 * The factor, the axes it applies to, and the button that applies it.
 *
 * Rendered on its own between the rotation and joint cards, and again inside
 * the Resize Component card next to the per-primitive dimensions.
 */
export function ScaleControls({ nodeId }: { nodeId: string }) {
  const [factor, setFactor] = useState(1);
  const [axes, setAxes] = useState<Record<Axis, boolean>>({ x: true, y: true, z: true });

  const active = AXES.filter((a) => axes[a]);
  const uniform = active.length === 3;
  const canApply = active.length > 0 && factor > 0 && factor !== 1;

  const apply = () => {
    if (!canApply) return;
    scaleNodeTree(
      nodeId,
      axes.x ? factor : 1,
      axes.y ? factor : 1,
      axes.z ? factor : 1,
    );
    setFactor(1);
  };

  const toggle = (axis: Axis) => setAxes((current) => {
    const next = { ...current, [axis]: !current[axis] };
    // All three off would be a button that does nothing; the last one held
    // turns the selection into "this axis alone" instead.
    if (!next.x && !next.y && !next.z) return { x: axis === 'x', y: axis === 'y', z: axis === 'z' };
    return next;
  });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-slate-500">
          Factor {uniform ? '(all axes)' : `(${active.map((a) => a.toUpperCase()).join(' ')} only)`}
        </label>
        <SliderValue
          value={factor}
          onChange={setFactor}
          decimals={2}
          unit="×"
          min={0.01}
          max={100}
          className="text-xs text-slate-600"
        />
      </div>

      <input
        type="range"
        min="0.1"
        max="3.0"
        step="0.01"
        value={Math.min(3, Math.max(0.1, factor))}
        onChange={(e) => setFactor(parseFloat(e.target.value))}
        className="w-full accent-violet-500 cursor-pointer"
      />

      <div className="flex items-center gap-1.5">
        <div className="flex gap-1 flex-1">
          {AXES.map((axis) => (
            <button
              key={axis}
              type="button"
              onClick={() => toggle(axis)}
              title={`Scale along the body's own ${axis.toUpperCase()}${axis === 'z' ? ' (up, when the body is upright)' : ''}. Turn the other two off to stretch this axis alone.`}
              className={`flex-1 py-1 rounded-md text-[11px] font-bold uppercase border transition-colors cursor-pointer ${
                axes[axis]
                  ? 'bg-violet-50 border-violet-300 text-violet-700'
                  : 'bg-slate-50 border-slate-200 text-slate-400 hover:text-slate-600'
              }`}
            >
              {axis}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={apply}
          disabled={!canApply}
          title="Multiply the component by this factor. Each Apply is relative to the size it is at now."
          className={`px-3 py-1 rounded-md text-[11px] font-semibold border transition-colors ${
            canApply
              ? 'bg-violet-500 border-violet-500 text-white hover:bg-violet-600 cursor-pointer'
              : 'bg-slate-50 border-slate-200 text-slate-300 cursor-not-allowed'
          }`}
        >
          Apply
        </button>
      </div>

      <p className="text-[10px] text-slate-400 leading-snug">
        Relative: each Apply multiplies the current size, and the factor returns to 1×.
        Axes are the body's own. A cylinder or a capsule takes <strong>X</strong> and <strong>Y</strong> as
        its radius and <strong>Z</strong> as its length; a sphere, having no axis at all, takes the average.
        Or press <kbd className="font-mono">S</kbd> in the viewport and size it by pointer.
      </p>
    </div>
  );
}

export function ScaleCard({ nodeId }: { nodeId: string }) {
  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1">
        <Ruler className="w-3.5 h-3.5" /> Scale
      </h3>
      <ScaleControls nodeId={nodeId} />
    </div>
  );
}

export default ScaleCard;
