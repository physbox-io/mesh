// ---------------------------------------------------------------------------
// Thread
//
// The thread on any cylinder: a hole is tapped, anything else becomes a
// threaded rod. One control for both, because which one it is follows from
// the cylinder — whether it takes material away or is material — and not
// from a choice the user should have to make twice.
//
// A bolt size sets the diameter and the coarse pitch together, so a rod and a
// hole both picked as "M8" screw together as drawn. Fit opens that up by a
// clearance, for whoever wants one; it starts at nothing.
// ---------------------------------------------------------------------------

import { SettledNumberField } from './SettledInputs';
import { useStore } from '../store/useStore';
import { METRIC_THREADS, metricThread, metricThreadOf, pitchForDiameterMm, type GeomThreadSpec } from '../utils/metricThreads';
import type { SceneGeom, SceneNode } from '../types/scene';

const round = (mm: number) => Math.round(mm * 10000) / 10000;

const fieldClass =
  'w-full px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ' +
  'text-[10px] font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 tabular-nums text-center';
const labelClass = 'block text-[9px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500';

export function ThreadField({ node, geom, index }: { node: SceneNode; geom: SceneGeom; index: number }) {
  const setGeomThread = useStore((s) => s.setGeomThread);
  if (geom.type !== 'cylinder') return null;

  const hole = geom.csg === 'difference';
  const thread = geom.thread;
  const pitchMm = thread?.pitch ? round(thread.pitch * 1000) : 0;
  const spec: GeomThreadSpec = {
    pitchMm,
    left: !!thread?.left,
    fitMm: thread?.fit ? round(thread.fit * 1000) : 0,
  };
  const choice = pitchMm > 0 ? (metricThreadOf(geom)?.[0] ?? 'custom') : 'none';
  const write = (next: Partial<GeomThreadSpec>, diameterMm?: number) =>
    setGeomThread(node.id, index, { ...spec, ...next }, diameterMm);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1 items-end">
        <label
          className="flex-1 min-w-0"
          title={hole
            ? 'Tap the hole. A bolt size sets the diameter and the coarse pitch, so a bolt of that size threads straight in.'
            : 'Thread the cylinder into a rod. A bolt size sets the diameter and the coarse pitch, so it screws into a hole tapped the same size.'}
        >
          <span className={labelClass}>Thread</span>
          <select
            value={choice}
            onChange={(e) => {
              const pick = e.target.value;
              if (pick === 'none') { setGeomThread(node.id, index, null); return; }
              const found = metricThread(pick);
              if (found) write({ pitchMm: found[2] }, found[1]);
              else write({ pitchMm: pitchForDiameterMm((geom.size?.[0] ?? 0) * 2000) });
            }}
            className={fieldClass}
          >
            <option value="none">None</option>
            {METRIC_THREADS.map(([name]) => <option key={name} value={name}>{name}</option>)}
            <option value="custom">Custom</option>
          </select>
        </label>
        {pitchMm > 0 && (
          <label className="flex-1 min-w-0" title="Distance from one thread to the next. M6 coarse is 1 mm, M8 is 1.25.">
            <span className={labelClass}>Pitch mm</span>
            <SettledNumberField value={pitchMm} min={0.05} onChange={(v) => write({ pitchMm: v })} className={fieldClass} />
          </label>
        )}
      </div>
      {pitchMm > 0 && (
        <div className="flex gap-1 items-end">
          <div className="flex-1 min-w-0" title="Right-hand tightens clockwise, like almost every bolt. Left-hand is the reverse.">
            <span className={labelClass}>Hand</span>
            <div className="flex gap-0.5">
              {([false, true] as const).map((left) => (
                <button
                  key={String(left)}
                  type="button"
                  onClick={() => write({ left })}
                  className={`flex-1 px-1 py-0.5 rounded text-[9px] font-bold uppercase cursor-pointer transition-colors ${
                    spec.left === left
                      ? 'bg-sky-500/20 text-sky-700 dark:text-sky-300'
                      : 'bg-white dark:bg-slate-800 text-slate-400 hover:text-slate-600'
                  }`}
                >
                  {left ? 'Left' : 'Right'}
                </button>
              ))}
            </div>
          </div>
          <label
            className="flex-1 min-w-0"
            title={hole
              ? 'Clearance across the diameter, added to the hole. 0 is the nominal size.'
              : 'Clearance across the diameter, taken off the rod. 0 is the nominal size.'}
          >
            <span className={labelClass}>Fit mm</span>
            <SettledNumberField value={spec.fitMm ?? 0} min={0} onChange={(v) => write({ fitMm: v })} className={fieldClass} />
          </label>
        </div>
      )}
    </div>
  );
}
