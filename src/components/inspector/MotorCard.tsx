import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { RangeInput } from '../RangeInput';

/** Motor Actuator Option for Hinge/Slide joints */
export function MotorCard({ node }: { node: SceneNode }) {
  const updateNodeJoint = useStore((s) => s.updateNodeJoint);

  if (!(node.joints?.length > 0 && (node.joints[0].type === 'hinge' || node.joints[0].type === 'slide'))) return null;
  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1">⚡ Joint Actuator / Motor</h3>
      <label className="text-xs font-semibold text-slate-500 flex items-center gap-2 cursor-pointer py-1">
        <input 
          type="checkbox" 
          checked={!!node.joints[0].actuator}
          onChange={(e) => {
            const enabled = e.target.checked;
            const updatedJoint = {
              ...node.joints[0],
              actuator: enabled ? { type: 'velocity' as const, kv: 10, ctrlValue: 0 } : undefined
            };
            updateNodeJoint(node.id, updatedJoint);
          }}
          className="w-4 h-4 rounded text-blue-500 focus:ring-blue-400 accent-blue-500 cursor-pointer"
        />
        Enable Motor Drive
      </label>

      {node.joints[0].actuator && (
        <div className="flex flex-col gap-2.5 mt-1 pt-2 border-t border-slate-100">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Actuator Type</label>
            <select
              value={node.joints[0].actuator.type}
              onChange={(e) => {
                const type = e.target.value as 'velocity' | 'motor';
                updateNodeJoint(node.id, {
                  ...node.joints[0],
                  actuator: { ...node.joints[0].actuator, type, kv: type === 'velocity' ? 10 : undefined }
                });
              }}
              className="w-full px-2 py-1.5 border border-slate-200 rounded text-xs bg-white font-medium text-slate-700 outline-none cursor-pointer focus:border-blue-500"
            >
              <option value="velocity">Velocity Drive (Target Speed)</option>
              <option value="motor">Torque Drive (Direct Force)</option>
            </select>
          </div>

          {node.joints[0].actuator.type === 'velocity' && (
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium text-slate-500 flex justify-between">
                Velocity Gain (kv) <span>{node.joints[0].actuator.kv || 10}</span>
              </label>
              <RangeInput
                min="0.5"
                max="100"
                step="0.5"
                value={node.joints[0].actuator.kv || 10}
                onChange={(v) => {
                  updateNodeJoint(node.id, {
                    ...node.joints[0],
                    actuator: { ...node.joints[0].actuator!, kv: v }
                  });
                }}
                className="w-full accent-blue-500 cursor-pointer"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
