import { useStore } from '../../store/useStore';
import type { SceneGeom, SceneNode } from '../../types/scene';
import { RangeInput } from '../RangeInput';
import { DocsInfoButton } from '../docs/DocsInfoButton';

/** Material Properties Card */
export function MaterialCard({ node, geom, activeIndex }: { node: SceneNode; geom: SceneGeom; activeIndex: number }) {
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <span className="flex items-center gap-1">🧪 Physical Material</span>
        <DocsInfoButton tab="material" />
      </h3>

      {/* Contact spring timeconst — solref[0] */}
      {(() => {
        const val = geom.solref ? Math.max(0.001, geom.solref[0]) : 0.02;
        return (
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-semibold text-slate-500 flex justify-between">
              Contact Stiffness <span className="text-[10px] font-normal text-slate-400">solref[0]</span>
              <span className="text-blue-600 font-bold">{val.toFixed(3)}s</span>
            </label>
            <RangeInput min="0.001" max="0.1" step="0.001" className="w-full accent-blue-500 cursor-pointer"
              value={val}
              onChange={(v) => {
                const sr = geom.solref ? [...geom.solref] : [0.02, 1.0];
                sr[0] = v;
                updateNodeGeom(node.id, { solref: sr as [number,number] }, activeIndex);
              }}
            />
            <span className="text-[10px] text-slate-400 leading-tight">Time constant of the contact spring. Lower = stiffer contact. Keep ≥ 5× timestep (0.005s) to avoid instability.</span>
          </div>
        );
      })()}

      {/* Damping ratio — solref[1] */}
      {(() => {
        const val = geom.solref ? Math.max(0, Math.min(1, geom.solref[1])) : 1.0;
        return (
          <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
            <label className="text-xs font-semibold text-slate-500 flex justify-between">
              Damping Ratio (Bounciness) <span className="text-[10px] font-normal text-slate-400">solref[1]</span>
              <span className="text-blue-600 font-bold">{val.toFixed(2)}</span>
            </label>
            <RangeInput min="0.0" max="1.0" step="0.01" className="w-full accent-blue-500 cursor-pointer"
              value={val}
              onChange={(v) => {
                const dr = v;
                const sr = geom.solref ? [...geom.solref] : [0.02, 1.0];
                sr[1] = dr;
                updateNodeGeom(node.id, {
                  solref: sr as [number,number],
                  solimp: [0.99, 0.9999, 0.0001, 0.5, 2]
                }, activeIndex);
              }}
            />
            <span className="text-[10px] text-slate-400 leading-tight">0 = max bounce (underdamped). 1 = no bounce (critically damped). ~0.2 gives lively bouncing.</span>
          </div>
        );
      })()}

      {/* Contact impedance — solimp[0] */}
      {(() => {
        const val = geom.solimp ? geom.solimp[0] : 0.99;
        return (
          <div className="flex flex-col gap-1.5 mt-1 border-t border-slate-100 pt-2">
            <label className="text-xs font-semibold text-slate-500 flex justify-between">
              Contact Impedance <span className="text-[10px] font-normal text-slate-400">solimp[0]</span>
              <span className="text-blue-600 font-bold">{val.toFixed(3)}</span>
            </label>
            <RangeInput min="0.8" max="0.9999" step="0.001" className="w-full accent-blue-500 cursor-pointer"
              value={val}
              onChange={(v) => {
                const si = geom.solimp ? [...geom.solimp] : [0.99, 0.9999, 0.0001, 0.5, 2];
                si[0] = v;
                updateNodeGeom(node.id, { solimp: si }, activeIndex);
              }}
            />
            <span className="text-[10px] text-slate-400 leading-tight">Controls how much the contact force can deviate from ideal. Higher = harder, less penetration.</span>
          </div>
        );
      })()}

      {/* Friction Sliders */}
      {(() => {
        const fr = geom.friction ?? [0.7, 0.005, 0.0001];
        return (
          <div className="flex flex-col gap-2 mt-1 border-t border-slate-100 pt-2">
            {[
              { label: 'Sliding Friction', key: 0, min: 0, max: 2, step: 0.01, hint: 'Tangential friction. High = rubbery, low = icy.' },
              { label: 'Torsional Friction', key: 1, min: 0, max: 0.05, step: 0.001, hint: 'Spin friction around the contact normal.' },
              { label: 'Rolling Friction', key: 2, min: 0, max: 0.01, step: 0.0001, hint: 'Resistance to rolling. Keeps balls from rolling forever.' },
            ].map(({ label, key, min, max, step, hint }) => (
              <div key={key} className="flex flex-col gap-1.5">
                <label className="text-xs font-semibold text-slate-500 flex justify-between">
                  {label} <span className="text-[10px] font-normal text-slate-400">friction[{key}]</span>
                  <span className="text-blue-600 font-bold">{fr[key].toFixed(key === 2 ? 4 : 3)}</span>
                </label>
                <RangeInput min={min} max={max} step={step} className="w-full accent-blue-500 cursor-pointer"
                  value={fr[key]}
                  onChange={(v) => {
                    const newFr = [...fr] as [number,number,number];
                    newFr[key] = v;
                    updateNodeGeom(node.id, { friction: newFr }, activeIndex);
                  }}
                />
                <span className="text-[10px] text-slate-400 leading-tight">{hint}</span>
              </div>
            ))}
          </div>
        );
      })()}
    </div>
  );
}
