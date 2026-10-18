import { X } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { lengthSpan } from '../../utils/sliderSpan';
import type { SceneNode } from '../../types/scene';
import { SliderValue } from '../SliderValue';
import { RangeInput } from '../RangeInput';

/** A curved track's section and control points. Part of the Resize card. */
export function CurveFields({ node }: { node: SceneNode }) {
  const updateCurveParams = useStore((s) => s.updateCurveParams);

  if (!(node.isCurve)) return null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 flex justify-between">Track Width <SliderValue value={node.curveWidth || 0.5} onChange={(v) => {
            const val = v;
            updateCurveParams(node.id, { width: val });
          }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
        <RangeInput
          {...lengthSpan(node.curveWidth || 0.5)}
          value={node.curveWidth || 0.5}
          onChange={(v) => {
            const val = v;
            updateCurveParams(node.id, { width: val });
          }}
          className="w-full accent-blue-500 cursor-pointer"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 flex justify-between">Thickness <SliderValue value={node.curveThickness || 0.06} onChange={(v) => {
            const val = v;
            updateCurveParams(node.id, { thickness: val });
          }} decimals={1} unit="mm" scale={1000} min={0.01} /></label>
        <RangeInput
          {...lengthSpan(node.curveThickness || 0.06)}
          value={node.curveThickness || 0.06}
          onChange={(v) => {
            const val = v;
            updateCurveParams(node.id, { thickness: val });
          }}
          className="w-full accent-blue-500 cursor-pointer"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 flex justify-between">Smoothness <span>{node.curveSegments || 28} segments</span></label>
        <RangeInput
          min="6"
          max="60"
          step="1"
          value={node.curveSegments || 28}
          onChange={(v) => {
            const val = Math.round(v);
            updateCurveParams(node.id, { segments: val });
          }}
          className="w-full accent-blue-500 cursor-pointer"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 flex justify-between">Bank Angle <SliderValue value={node.curveBank || 0} onChange={(v) => {
            const val = v;
            updateCurveParams(node.id, { bank: val });
          }} decimals={0} unit="°" min={-45} max={45} /></label>
        <RangeInput
          min="-45"
          max="45"
          step="1"
          value={node.curveBank || 0}
          onChange={(v) => {
            const val = v;
            updateCurveParams(node.id, { bank: val });
          }}
          className="w-full accent-blue-500 cursor-pointer"
        />
      </div>
      <label className="flex items-center gap-2 text-xs font-medium text-slate-500 cursor-pointer">
        <input
          type="checkbox"
          checked={node.curveClosed === true}
          onChange={(e) => {
            updateCurveParams(node.id, { closed: e.target.checked });
          }}
          className="accent-blue-500"
        />
        Closed loop (join ends)
      </label>
      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-slate-500">Control Points (x, y, z, mm). Drag the blue handles in the viewport, or edit here.</label>
        {(node.curvePoints || []).map((pt: number[], pi: number) => (
          <div key={pi} className="flex items-center gap-1">
            {[0, 1, 2].map((axis) => (
              <input
                key={axis}
                type="number"
                step="10"
                value={Math.round(pt[axis] * 1e5) / 100}
                onChange={(e) => {
                  // Shown in mm, stored in metres.
                  const val = parseFloat(e.target.value) / 1000;
                  if (isNaN(val)) return;
                  const pts = (node.curvePoints || []).map((p: number[]) => [...p]);
                  pts[pi][axis] = val;
                  updateCurveParams(node.id, { points: pts });
                }}
                className="w-full min-w-0 px-1.5 py-1 text-xs rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-300"
              />
            ))}
            <button
              onClick={() => {
                const pts = (node.curvePoints || []).map((p: number[]) => [...p]);
                if (pts.length <= 2) return; // spline needs at least 2 points
                pts.splice(pi, 1);
                updateCurveParams(node.id, { points: pts });
              }}
              disabled={(node.curvePoints || []).length <= 2}
              className="p-1 text-slate-400 hover:text-red-500 disabled:opacity-30 disabled:hover:text-slate-400"
              title="Remove point"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        <button
          onClick={() => {
            const pts = (node.curvePoints || []).map((p: number[]) => [...p]);
            const n = pts.length;
            // extend past the last point along the last span direction
            const last = pts[n - 1];
            const prev = pts[n - 2] || [last[0] - 1, last[1], last[2]];
            pts.push([last[0] + (last[0] - prev[0]), last[1] + (last[1] - prev[1]), last[2] + (last[2] - prev[2])]);
            updateCurveParams(node.id, { points: pts });
          }}
          className="mt-1 px-2 py-1 text-xs font-medium rounded border border-dashed border-slate-300 dark:border-slate-700 text-slate-500 hover:border-blue-400 hover:text-blue-500 transition-colors"
        >
          + Add Point
        </button>
      </div>
    </div>
  );
}
