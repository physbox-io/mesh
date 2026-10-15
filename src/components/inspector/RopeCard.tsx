import { useMemo } from 'react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';

export function RopeCard({ node }: { node: SceneNode }) {
  const updateRopeParams = useStore((s) => s.updateRopeParams);
  const sceneGraph = useStore((s) => s.sceneGraph);

  const allPulleyWheels = useMemo(() => {
    const list: SceneNode[] = [];
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.isPulleyWheel) list.push(n);
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return list;
  }, [sceneGraph]);

  const allJointedNodes = useMemo(() => {
    const list: SceneNode[] = [];
    const traverse = (nodes: SceneNode[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        if (n.joints && n.joints.length > 0 && !n.isPulleyWheel) {
          list.push(n);
        }
        traverse(n.children);
      }
    };
    traverse(sceneGraph.nodes);
    return list;
  }, [sceneGraph]);

  if (!(node.isPulleyRope)) return null;
  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-3">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <span>🧵 Rope Properties</span>
      </h3>

      <p className="text-[10px] text-slate-400 leading-snug -mt-1">
        Connect two bodies directly, or optionally route through a Pulley Wheel for an Atwood-style coupling.
      </p>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold text-slate-500 flex justify-between">
          Body A <span className="font-normal text-rose-400">required</span>
        </label>
        <select
          value={node.leftTargetId || ''}
          onChange={(e) => updateRopeParams(node.id, { leftTargetId: e.target.value })}
          className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
        >
          <option value="">-- Select Body A --</option>
          {allJointedNodes.map(n => (
            <option key={n.id} value={n.id}>{n.id}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold text-slate-500 flex justify-between">
          Body B <span className="font-normal text-rose-400">required</span>
        </label>
        <select
          value={node.rightTargetId || ''}
          onChange={(e) => updateRopeParams(node.id, { rightTargetId: e.target.value })}
          className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
        >
          <option value="">-- Select Body B --</option>
          {allJointedNodes.map(n => (
            <option key={n.id} value={n.id}>{n.id}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-semibold text-slate-500 flex justify-between">
          Pulley Wheel <span className="font-normal text-slate-400">optional</span>
        </label>
        <select
          value={node.pulleyWheelId || ''}
          onChange={(e) => updateRopeParams(node.id, { pulleyWheelId: e.target.value })}
          className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
        >
          <option value="">-- None (direct coupling) --</option>
          {allPulleyWheels.map(wheel => (
            <option key={wheel.id} value={wheel.id}>
              {wheel.id} (r={( wheel.pulleyRadius || 0.4).toFixed(2)}m)
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
