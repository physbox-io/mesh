import { getStickyRotation } from '../../utils/geom';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { SliderValue } from '../SliderValue';
import { SettledNumberInput } from '../SettledInputs';
import { RangeInput } from '../RangeInput';
import { DocsInfoButton } from '../docs/DocsInfoButton';

/** Damping, Limits, and Actuator Target Speed properties */
export function JointSettingsCard({ node }: { node: SceneNode }) {
  const brokenConstraints = useStore((s) => s.brokenConstraints);
  const isPlaying = useStore((s) => s.isPlaying);
  const lastBreak = useStore((s) => s.lastBreak);
  const restoreConstraint = useStore((s) => s.restoreConstraint);
  const updateNodeJoint = useStore((s) => s.updateNodeJoint);

  return (
    <>
      {node.joints?.map((joint, i) => (
        <div key={`joint-${i}`} className="flex flex-col gap-4">
          {(joint.damping !== undefined || joint.type === 'free') && (
            <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
              <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                <span className="flex items-center gap-1">🔗 Joint Damping</span>
                <DocsInfoButton tab="damping" />
              </h3>
              <label className="text-xs font-medium text-slate-500 flex justify-between">Damping <SliderValue value={joint.damping !== undefined ? joint.damping : 0.0} onChange={(v) => updateNodeJoint(node.id, {damping: v})} decimals={2} min={0} /></label>
              <RangeInput 
                min="0" 
                max={joint.type === 'free' ? "5.0" : "500"} 
                step={joint.type === 'free' ? "0.01" : "0.1"} 
                value={joint.damping !== undefined ? joint.damping : 0.0} 
                onChange={(v) => updateNodeJoint(node.id, {damping: v})} 
                className="w-full accent-blue-500 cursor-pointer" 
              />
            </div>
          )}

          {/* Crumple — a joint that is rigid until it is overloaded,
              and then folds and stays folded. Held still by an
              auto-emitted weld; releasing it is the same one-byte write
              that shears a weld off. See utils/breakThresholds.ts. */}
          {(joint.type === 'hinge' || joint.type === 'slide') && (() => {
            const on = joint.crumpleTorqueNm !== undefined;
            const key = `crumple:${joint.name}`;
            const given = brokenConstraints.includes(key);
            const info = given && lastBreak?.key === key ? lastBreak : null;
            const range = joint.crumpleRangeDeg ?? [-80, 0];
            return (
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                  <span className="flex items-center gap-1">🪗 Crumple Zone</span>
                  {given
                    ? <span className="text-[10px] font-semibold text-amber-600">folded</span>
                    : <DocsInfoButton tab="breaking" />}
                </h3>

                <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => updateNodeJoint(node.id, e.target.checked
                      ? { crumpleTorqueNm: 10, crumpleRangeDeg: [-80, 0], crumpleDampingAfter: 5 }
                      : { crumpleTorqueNm: undefined, crumpleRangeDeg: undefined, crumpleDampingAfter: undefined })}
                    className="accent-amber-500 cursor-pointer"
                  />
                  This joint can take a permanent set
                </label>

                {on && (
                  <>
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-500 w-20 shrink-0">Gives at</label>
                      <SettledNumberInput
                        step="1" min={0}
                        value={joint.crumpleTorqueNm ?? 0}
                        onChange={(v) => updateNodeJoint(node.id, { crumpleTorqueNm: v })}
                        className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                      />
                      <span className="text-[10px] text-slate-400 w-8 shrink-0">N·m</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-500 w-20 shrink-0">Folds to</label>
                      <SettledNumberInput
                        step="5"
                        value={range[0]}
                        onChange={(v) => updateNodeJoint(node.id, { crumpleRangeDeg: [v, range[1]] })}
                        className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                      />
                      <SettledNumberInput
                        step="5"
                        value={range[1]}
                        onChange={(v) => updateNodeJoint(node.id, { crumpleRangeDeg: [range[0], v] })}
                        className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                      />
                      <span className="text-[10px] text-slate-400 w-8 shrink-0">deg</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="text-[10px] text-slate-500 w-20 shrink-0">Stiffness after</label>
                      <SettledNumberInput
                        step="1" min={0}
                        value={joint.crumpleDampingAfter ?? 0}
                        onChange={(v) => updateNodeJoint(node.id, { crumpleDampingAfter: v })}
                        className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                      />
                      <span className="text-[10px] text-slate-400 w-8 shrink-0">N·m·s</span>
                    </div>
                    <p className="text-[10px] text-slate-400 leading-snug">
                      Held rigid until the torque on it passes the limit, then it folds
                      within the range above and <strong className="text-slate-500">stays
                      folded</strong> — a spring comes back, a crumpled bracket does not.
                      Give it enough stiffness after that it settles into its new shape
                      instead of swinging into it. Reset straightens it.
                    </p>
                    {info && (
                      <div className="flex items-center gap-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
                        <span className="flex-1">
                          Gave at {info.time.toFixed(2)} s, carrying {info.torqueNm.toFixed(1)} N·m.
                        </span>
                        <button
                          onClick={() => restoreConstraint(key)}
                          className="shrink-0 px-1.5 py-0.5 rounded border border-amber-300 hover:bg-amber-100 font-medium"
                        >
                          Straighten
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            );
          })()}

          {(joint.type === 'hinge' || joint.type === 'slide' || joint.type === 'ball') && (
            <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
              <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                <span className="flex items-center gap-1">🌸 Joint Springs</span>
                <DocsInfoButton tab="springs" />
              </h3>

              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">
                  Spring Stiffness (K) <SliderValue value={joint.stiffness || 0} onChange={(v) => updateNodeJoint(node.id, { stiffness: v })} decimals={0} unit={joint.type === 'slide' ? 'N/m' : 'N·m/rad'} min={0} max={5000} />
                </label>
                <RangeInput 
                  min="0" 
                  max="5000" 
                  step="10" 
                  value={joint.stiffness || 0} 
                  onChange={(v) => updateNodeJoint(node.id, { stiffness: v })}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>

              {(joint.stiffness || 0) > 0 && (joint.type === 'hinge' || joint.type === 'slide') && (
                <div className="flex flex-col gap-1 mt-1 border-t border-slate-50 pt-2">
                  <label className="text-xs font-medium text-slate-500 flex justify-between">
                    Spring Rest Position <span>{(joint.springref || 0).toFixed(joint.type === 'slide' ? 2 : 0)}{joint.type === 'slide' ? ' m' : '°'}</span>
                  </label>
                  <RangeInput 
                    min={joint.type === 'slide' ? -20.0 : -360} 
                    max={joint.type === 'slide' ? 20.0 : 360} 
                    step={joint.type === 'slide' ? 0.05 : 1} 
                    value={joint.springref || 0} 
                    onChange={(v) => {
                      const raw = v;
                      const val = joint.type === 'slide' ? raw : getStickyRotation(raw);
                      updateNodeJoint(node.id, { springref: val });
                    }}
                    className="w-full accent-blue-500 cursor-pointer" 
                  />
                </div>
              )}
            </div>
          )}

          {(joint.type === 'hinge' || joint.type === 'slide') && (
            <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
              <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
                <span className="flex items-center gap-1">🔒 Joint Limits</span>
                <DocsInfoButton tab="springs" />
              </h3>

              <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
                <input 
                  type="checkbox" 
                  checked={joint.limited === true || (joint.limited as unknown) === 'true'}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    const defaultRange = joint.type === 'slide' ? [-1.0, 1.0] : [-90, 90];
                    updateNodeJoint(node.id, { 
                      limited: enabled,
                      range: enabled ? (joint.range || defaultRange) : undefined
                    });
                  }}
                  className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
                />
                Enable Range Limits
              </label>

              {/* A scene loaded from JSON can carry the string rather than the
                  boolean, and always could; the cast only says so. */}
              {(joint.limited === true || (joint.limited as unknown) === 'true') && (() => {
                const range = joint.range || (joint.type === 'slide' ? [-1.0, 1.0] : [-90, 90]);
                const isSlide = joint.type === 'slide';
                const minVal = range[0];
                const maxVal = range[1];

                return (
                  <div className="flex flex-col gap-3 mt-1 border-t border-slate-50 pt-2">
                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-medium text-slate-500 flex justify-between">
                        Minimum Limit <span>{minVal.toFixed(isSlide ? 2 : 0)}{isSlide ? ' m' : '°'}</span>
                      </label>
                      <RangeInput 
                        min={isSlide ? -20.0 : -360}
                        max={isSlide ? 20.0 : 360}
                        step={isSlide ? 0.05 : 1}
                        list={!isSlide ? 'rotation-snaps' : undefined}
                        value={minVal}
                        onChange={(v) => {
                          const raw = v;
                          const val = isSlide ? raw : getStickyRotation(raw);
                          const newMin = Math.min(val, maxVal);
                          updateNodeJoint(node.id, { range: [newMin, maxVal] });
                        }}
                        className="w-full accent-blue-500 cursor-pointer" 
                      />
                    </div>

                    <div className="flex flex-col gap-1">
                      <label className="text-xs font-medium text-slate-500 flex justify-between">
                        Maximum Limit <span>{maxVal.toFixed(isSlide ? 2 : 0)}{isSlide ? ' m' : '°'}</span>
                      </label>
                      <RangeInput 
                        min={isSlide ? -20.0 : -360}
                        max={isSlide ? 20.0 : 360}
                        step={isSlide ? 0.05 : 1}
                        list={!isSlide ? 'rotation-snaps' : undefined}
                        value={maxVal}
                        onChange={(v) => {
                          const raw = v;
                          const val = isSlide ? raw : getStickyRotation(raw);
                          const newMax = Math.max(val, minVal);
                          updateNodeJoint(node.id, { range: [minVal, newMax] });
                        }}
                        className="w-full accent-blue-500 cursor-pointer" 
                      />
                    </div>
                  </div>
                );
              })()}
            </div>
          )}

          {joint.actuator && (() => {
            const isTorque = joint.actuator.type === 'motor';

            return (
              <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
                <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">
                  {isTorque ? '💪 Target Torque/Force' : '⚡ Target Velocity'}
                </h3>
                <label className="text-xs font-medium text-slate-500 flex justify-between">
                  {isTorque ? 'Control Force' : 'Control Speed'}
                  <span>{joint.actuator.ctrlValue || 0}</span>
                </label>
                <input 
                  type="range" 
                  min={isTorque ? "-1000" : "-100"} 
                  max={isTorque ? "1000" : "100"} 
                  step={isTorque ? "1" : "0.1"} 
                  value={joint.actuator.ctrlValue || 0} 
                  onChange={(e) => {
                    const val = parseFloat(e.target.value);
                    if (isPlaying) {
                      getPhysicsWorkerClient().setCtrl(`${joint.name}_actuator`, val);
                    }
                    updateNodeJoint(node.id, { actuator: { ...joint.actuator!, ctrlValue: val } });
                  }}
                  className="w-full accent-blue-500 cursor-pointer" 
                />
              </div>
            );
          })()}
        </div>
      ))}
    </>
  );
}
