import { useState } from 'react';
import { useStore } from '../../store/useStore';
import { isTopLevel, findNodeById } from '../../utils/sceneTree';
import type { SceneJoint, SceneNode } from '../../types/scene';
import { ConfirmModal } from '../ConfirmModal';
import { SettledTextInput } from '../SettledInputs';
import { RangeInput } from '../RangeInput';
import { DocsInfoButton } from '../docs/DocsInfoButton';

/** Joint Type Configuration */
export function JointTypeCard({ node }: { node: SceneNode }) {
  const sceneGraph = useStore((s) => s.sceneGraph);
  const updateNodeJoint = useStore((s) => s.updateNodeJoint);
  const updateNodeJointsList = useStore((s) => s.updateNodeJointsList);
  // Set when Free is picked for a body that hangs under another: MuJoCo only
  // allows a free joint at the top level, so the body has to be detached
  // first and that is not something to do behind someone's back.
  const [detachForFree, setDetachForFree] = useState<{ id: string; joints: SceneJoint[] } | null>(null);

  return (
    <>
      <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
        <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
          <span className="flex items-center gap-1">🔗 Joint Type</span>
          <DocsInfoButton tab="gravity" />
        </h3>
        <select 
          value={node.joints?.length > 0 ? node.joints[0].type : 'fixed'}
          onChange={(e) => {
            const jointType = e.target.value;
            let newJoints: SceneJoint[] = [];
            if (jointType !== 'fixed') {
              const name = `${node.id}_joint`;
              if (jointType === 'free') {
                newJoints = [{ name, type: 'free' }];
              } else if (jointType === 'hinge') {
                newJoints = [{ name, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }];
              } else if (jointType === 'slide') {
                newJoints = [{ name, type: 'slide', axis: [0, 0, 1], pos: [0, 0, 0], damping: 0.5 }];
              } else if (jointType === 'ball') {
                newJoints = [{ name, type: 'ball', pos: [0, 0, 0], damping: 0.5 }];
              }
            }
            // A free joint is only legal on a top-level body. Asked
            // for on a nested one, MuJoCo refuses the entire model and
            // the app carries on with the last one that worked, so the
            // body stops responding with nothing said. Offer the
            // detach that would make it legal instead.
            if (jointType === 'free' && !isTopLevel(sceneGraph.nodes, node.id)) {
              setDetachForFree({ id: node.id, joints: newJoints });
              return;
            }
            updateNodeJointsList(node.id, newJoints);
          }}
          className="w-full px-2 py-1.5 border border-slate-200 rounded text-sm bg-white font-medium text-slate-700 outline-none focus:border-blue-500 cursor-pointer"
        >
          <option value="fixed">Fixed / Welded to Parent</option>
          <option value="free">Free (6-DOF Movable)</option>
          <option value="hinge">Hinge (Rotational Joint)</option>
          <option value="slide">Slider (Prismatic Joint)</option>
          <option value="ball">Ball Joint (Spherical)</option>
        </select>

        {node.joints?.length > 0 && (
          <div className="mt-2 flex flex-col gap-1.5 p-2 bg-slate-50 rounded-lg border border-slate-150">
            <div className="flex justify-between items-center">
              <label className="text-[9px] font-semibold text-slate-400 uppercase tracking-wider">Joint Name (for API)</label>
              <span className="font-mono text-[9px] text-blue-600 font-semibold bg-blue-50 px-1 py-0.5 rounded cursor-pointer select-all border border-blue-100" title="Joint API Reference. Click to select/copy.">
                api.getJointPosition('{node.joints[0].name}')
              </span>
            </div>
            <SettledTextInput
              value={node.joints[0].name || ''}
              clean={(raw) => raw.replace(/[^a-zA-Z0-9_]/g, '_')}
              onChange={(cleanName) => updateNodeJoint(node.id, { name: cleanName })}
              className="w-full px-2 py-1 border border-slate-200 rounded text-xs font-mono bg-white text-slate-800 outline-none focus:border-blue-500 shadow-sm"
              placeholder="e.g. cart_slide"
            />
          </div>
        )}

        {/* Free Joint Launch Velocity */}
        {node.joints?.length > 0 && node.joints[0].type === 'free' && (
          <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-slate-100">
            <h3 className="text-xs font-semibold text-slate-600 mb-1 flex items-center gap-1.5">
              <span>Launch Velocity (m/s)</span>
              <DocsInfoButton tab="launch" size="w-3 h-3" />
            </h3>
            {['X (Forward)', 'Y (Side)', 'Z (Up)'].map((label, i) => (
              <div key={label} className="flex flex-col gap-1">
                <label className="text-xs font-medium text-slate-500 flex justify-between">
                  {label} <span>{node.joints[0].initialVelocity?.[i] || 0}</span>
                </label>
                <RangeInput
                  min="-20"
                  max="20"
                  step="0.5"
                  value={node.joints[0].initialVelocity?.[i] || 0}
                  onChange={(v) => {
                    const vel = [...(node.joints[0].initialVelocity || [0,0,0,0,0,0])];
                    vel[i] = v;
                    updateNodeJoint(node.id, { ...node.joints[0], initialVelocity: vel });
                  }}
                  className="w-full accent-blue-500 cursor-pointer"
                />
              </div>
            ))}

            <h3 className="text-xs font-semibold text-slate-600 mt-2 mb-1 pt-2 border-t border-slate-100 flex items-center gap-1.5">
              <span>Launch Spin / Angular Velocity (rad/s)</span>
              <DocsInfoButton tab="launch" size="w-3 h-3" />
            </h3>
            {['X (Roll)', 'Y (Pitch)', 'Z (Yaw)'].map((label, i) => {
              const idx = i + 3;
              return (
                <div key={label} className="flex flex-col gap-1">
                  <label className="text-xs font-medium text-slate-500 flex justify-between">
                    {label} <span>{node.joints[0].initialVelocity?.[idx] || 0}</span>
                  </label>
                  <RangeInput
                    min="-50"
                    max="50"
                    step="0.5"
                    value={node.joints[0].initialVelocity?.[idx] || 0}
                    onChange={(v) => {
                      const vel = [...(node.joints[0].initialVelocity || [0,0,0,0,0,0])];
                      vel[idx] = v;
                      updateNodeJoint(node.id, { ...node.joints[0], initialVelocity: vel });
                    }}
                    className="w-full accent-blue-500 cursor-pointer"
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {detachForFree && (() => {
        const body = findNodeById(sceneGraph.nodes, detachForFree.id);
        return (
          <ConfirmModal
            title="Detach this body to make it free?"
            confirmLabel="Detach and make free"
            body={
              <>
                <p>
                  <strong>{body?.name || detachForFree.id}</strong> hangs inside another body, and a
                  6-DOF body has to sit at the top of the scene — MuJoCo will not load a model with a
                  free joint anywhere else.
                </p>
                <p>
                  It will be lifted out of its parent and left exactly where it is now, free to fall
                  and be pushed around. Anything hanging under it comes too. Its parent keeps
                  everything else.
                </p>
              </>
            }
            onCancel={() => setDetachForFree(null)}
            onConfirm={() => {
              const { id, joints } = detachForFree;
              setDetachForFree(null);
              if (useStore.getState().detachToTopLevel(id)) updateNodeJointsList(id, joints);
            }}
          />
        );
      })()}
    </>
  );
}
