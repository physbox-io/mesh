import { Link2, Unlink } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { DEFAULT_HOLD_STEPS, isBreakable, weldKey } from '../../utils/breakThresholds';
import type { SceneNode } from '../../types/scene';
import { SettledNumberInput } from '../SettledInputs';

/*
 * Constraints — welding one body to another, and what it takes to
 * shear it off again. Both the weld itself and the break
 * thresholds were reachable only over MCP before this.
 */
export function ConstraintsCard({ node }: { node: SceneNode }) {
  const brokenConstraints = useStore((s) => s.brokenConstraints);
  const lastBreak = useStore((s) => s.lastBreak);
  const restoreConstraint = useStore((s) => s.restoreConstraint);
  const sceneGraph = useStore((s) => s.sceneGraph);
  const updateNode = useStore((s) => s.updateNode);

  // A body cannot be welded to itself or to anything hanging off
  // it: MuJoCo's equality would be fighting the body hierarchy
  // that already holds them together.
  const excluded = new Set<string>();
  const markSubtree = (n: SceneNode) => {
    excluded.add(n.id);
    (n.children || []).forEach(markSubtree);
  };
  markSubtree(node);

  const candidates: SceneNode[] = [];
  const collect = (nodes: SceneNode[]) => {
    for (const n of nodes || []) {
      if (!excluded.has(n.id)) candidates.push(n);
      collect(n.children || []);
    }
  };
  collect(sceneGraph.nodes);
  if (candidates.length === 0) return null;

  const welded = !!node.weldTargetId;
  const breakable = isBreakable(node);
  const key = welded ? weldKey(node.id, node.weldTargetId!) : '';
  const isBroken = welded && brokenConstraints.includes(key);
  const breakInfo = isBroken && lastBreak?.key === key ? lastBreak : null;
  const targetName = candidates.find((c) => c.id === node.weldTargetId)?.name;

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <Link2 className="w-3.5 h-3.5 text-indigo-500" /> Constraints
        {isBroken && <span className="ml-auto text-[10px] font-semibold text-amber-600">broken</span>}
      </h3>

      <label className="text-[10px] font-medium text-slate-500">Welded to</label>
      <select
        value={node.weldTargetId || ''}
        onChange={(e) => updateNode(node.id, { weldTargetId: e.target.value || undefined })}
        className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
        title="Holds this body rigidly to another one, wherever the two happen to be. Use it to fix a handle to a mug or a leg to a table."
      >
        <option value="">— not welded —</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      <label className="text-[10px] font-medium text-slate-500 mt-1">Pinned to (ball joint)</label>
      <select
        value={node.connectTargetId || ''}
        onChange={(e) => updateNode(node.id, { connectTargetId: e.target.value || undefined })}
        className="w-full px-2.5 py-1.5 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500 cursor-pointer font-medium"
        title="Holds one point of this body to another body, but lets it swivel about that point — a pin rather than a weld."
      >
        <option value="">— not pinned —</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>

      {welded && (
        <>
          <label className="flex items-center gap-2 text-xs text-slate-700 mt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={breakable}
              onChange={(e) => updateNode(node.id, e.target.checked
                ? { weldBreakForceN: 100, weldBreakHoldSteps: DEFAULT_HOLD_STEPS }
                : { weldBreakForceN: undefined, weldBreakTorqueNm: undefined, weldBreakHoldSteps: undefined })}
              className="accent-indigo-500 cursor-pointer"
            />
            This weld can shear off
          </label>

          {breakable && (
            <>
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-slate-500 w-20 shrink-0">Pull limit</label>
                <SettledNumberInput
                  step="10"
                  min={0}
                  value={node.weldBreakForceN ?? 0}
                  onChange={(v) => updateNode(node.id, { weldBreakForceN: v })}
                  className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                />
                <span className="text-[10px] text-slate-400 w-8 shrink-0">N</span>
              </div>
              <div className="flex items-center gap-2">
                <label className="text-[10px] text-slate-500 w-20 shrink-0">Twist limit</label>
                <SettledNumberInput
                  step="1"
                  min={0}
                  value={node.weldBreakTorqueNm ?? 0}
                  onChange={(v) => updateNode(node.id, { weldBreakTorqueNm: v || undefined })}
                  className="flex-1 min-w-0 px-2 py-1 border border-slate-200 rounded text-xs bg-white text-slate-700 outline-none focus:border-blue-500"
                  placeholder="none"
                />
                <span className="text-[10px] text-slate-400 w-8 shrink-0">N·m</span>
              </div>
              <p className="text-[10px] text-slate-400 leading-snug">
                Connects two bodies by distance or rigid weld to close kinematic loops.
              </p>
            </>
          )}

          {isBroken && (
            <div className="flex items-center gap-2 text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug">
              <Unlink className="w-3 h-3 shrink-0" />
              <span className="flex-1">
                {breakInfo
                  ? `Sheared off ${targetName ? `from ${targetName} ` : ''}at ${breakInfo.time.toFixed(2)} s, carrying ${breakInfo.forceN.toFixed(0)} N.`
                  : 'This weld has sheared off.'}
              </span>
              <button
                onClick={() => restoreConstraint(key)}
                className="shrink-0 px-1.5 py-0.5 rounded border border-amber-300 hover:bg-amber-100 font-medium"
              >
                Restore
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
