import { useMemo } from 'react';
import { GitCommitHorizontal, RotateCcw, AlertTriangle } from 'lucide-react';
import type { FlexureKind, SceneGraph, SceneNode } from '../../types/scene';
import { useStore } from '../../store/useStore';
import { RangeInput } from '../RangeInput';
import {
  allowedFlexureKindsForJoint,
  applyFlexureToNode,
  evaluateFlexureSpec,
  FLEXURE_FILAMENT_PROPS,
  revertFlexure,
  type FlexureDesignInput,
} from '../../utils/flexure';

const KIND_LABELS: Record<FlexureKind, string> = {
  blade: 'Blade Leaf',
  cross_pivot: 'Cross-Strip Pivot',
  serpentine: 'Serpentine Spring',
  bistable: 'Bistable Snap Toggle',
};

function replaceNodeInTree(nodes: SceneNode[], targetId: string, next: SceneNode): SceneNode[] {
  return nodes.map((n) => {
    if (n.id === targetId) return next;
    if (n.children?.length) {
      const updatedChildren = replaceNodeInTree(n.children, targetId, next);
      if (updatedChildren !== n.children) return { ...n, children: updatedChildren };
    }
    return n;
  });
}

function applyDiscreteFlexure(nodeId: string, nextNode: SceneNode) {
  const state = useStore.getState();
  const nextGraph: SceneGraph = {
    ...state.sceneGraph,
    nodes: replaceNodeInTree(state.sceneGraph.nodes, nodeId, nextNode),
  };
  state.updateScene(nextGraph);
}

/**
 * Monolithic Compliant Mechanisms ("Replace Joint with Flexure"):
 * Rendered ONLY when the selected body has a `hinge` or `slide` joint.
 * Converts the rigid joint into a printable compliant blade, cross-strip pivot,
 * serpentine spring, or bistable Von Mises toggle sized from filament modulus.
 */
export function FlexureCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);

  const primaryJoint = useMemo(
    () => (node.joints ?? []).find((j) => j.type === 'hinge' || j.type === 'slide') ?? null,
    [node.joints],
  );

  const evaluation = useMemo(() => {
    if (!primaryJoint || !node.flexure) return null;
    return evaluateFlexureSpec(node.flexure, primaryJoint.type as 'hinge' | 'slide');
  }, [primaryJoint, node.flexure]);

  if (!primaryJoint || node.hardwarePart || node.simulation) return null;

  const jointType = primaryJoint.type as 'hinge' | 'slide';
  const allowedKinds = allowedFlexureKindsForJoint(jointType);

  const handleConvert = () => {
    const res = applyFlexureToNode(node, {
      kind: allowedKinds[0],
      filament: 'petg',
    });
    if (res) applyDiscreteFlexure(node.id, res.node);
  };

  const handleParamChange = (patch: FlexureDesignInput, discrete = false) => {
    const res = applyFlexureToNode(node, patch);
    if (!res) return;
    if (discrete) {
      applyDiscreteFlexure(node.id, res.node);
    } else {
      updateNode(node.id, {
        geoms: res.node.geoms,
        joints: res.node.joints,
        flexure: res.node.flexure,
      });
    }
  };

  const handleRevert = () => {
    applyDiscreteFlexure(node.id, revertFlexure(node));
  };

  if (!node.flexure || !evaluation) {
    return (
      <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
            <GitCommitHorizontal className="w-3.5 h-3.5 text-teal-500 shrink-0" />
            Compliant Flexure
          </div>
          <div className="text-[10px] text-slate-400 leading-snug">
            Replace {jointType === 'hinge' ? 'pin hinge' : 'slider'} with a printable 1-piece flexure
          </div>
        </div>
        <button
          type="button"
          onClick={handleConvert}
          className="px-2.5 py-1.5 rounded bg-teal-50 hover:bg-teal-100 dark:bg-teal-950/50 dark:hover:bg-teal-900/60 border border-teal-200 dark:border-teal-800 text-[10px] font-semibold text-teal-700 dark:text-teal-300 shrink-0 cursor-pointer transition-colors"
        >
          Convert
        </button>
      </div>
    );
  }

  const { spec, snapForceN, peakStressMPa, warnings } = evaluation;

  return (
    <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2">
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-1.5">
        <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <GitCommitHorizontal className="w-3.5 h-3.5 text-teal-500" /> Compliant Flexure
        </h3>
        <button
          type="button"
          onClick={handleRevert}
          className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          title="Remove printable flexure leaves and restore standard joint"
        >
          <RotateCcw className="w-2.5 h-2.5" /> Revert
        </button>
      </div>

      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Topology</span>
          <select
            value={spec.kind}
            onChange={(e) => handleParamChange({ kind: e.target.value as FlexureKind }, true)}
            className="w-full px-1.5 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 cursor-pointer"
          >
            {allowedKinds.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5">
          <span className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">Polymer</span>
          <select
            value={spec.filament}
            onChange={(e) => handleParamChange({ filament: e.target.value }, true)}
            className="w-full px-1.5 py-1 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 cursor-pointer"
          >
            {Object.keys(FLEXURE_FILAMENT_PROPS).map((fid) => (
              <option key={fid} value={fid}>
                {fid.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-slate-500 dark:text-slate-400 flex justify-between">
          <span>Leaf Thickness</span>
          <span className="font-mono text-slate-700 dark:text-slate-200">{spec.thicknessMm.toFixed(2)} mm</span>
        </label>
        <RangeInput
          min="0.4"
          max="2.4"
          step="0.05"
          value={spec.thicknessMm}
          onChange={(v) => handleParamChange({ thicknessMm: v })}
          className="w-full accent-teal-500 cursor-pointer"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-[11px] text-slate-500 dark:text-slate-400 flex justify-between">
          <span>Leaf Span</span>
          <span className="font-mono text-slate-700 dark:text-slate-200">{spec.lengthMm.toFixed(1)} mm</span>
        </label>
        <RangeInput
          min="6"
          max="45"
          step="0.5"
          value={spec.lengthMm}
          onChange={(v) => handleParamChange({ lengthMm: v })}
          className="w-full accent-teal-500 cursor-pointer"
        />
      </div>

      {spec.kind === 'bistable' && (
        <div className="flex flex-col gap-1">
          <label className="text-[11px] text-slate-500 dark:text-slate-400 flex justify-between">
            <span>Arch Rise (Snap Stroke {(2 * (spec.archRiseMm ?? 2.4)).toFixed(1)} mm)</span>
            <span className="font-mono text-slate-700 dark:text-slate-200">{(spec.archRiseMm ?? 2.4).toFixed(1)} mm</span>
          </label>
          <RangeInput
            min="1.0"
            max="6.0"
            step="0.2"
            value={spec.archRiseMm ?? 2.4}
            onChange={(v) => handleParamChange({ archRiseMm: v })}
            className="w-full accent-teal-500 cursor-pointer"
          />
        </div>
      )}

      <div className="text-[10px] text-slate-600 dark:text-slate-300 bg-slate-50 dark:bg-slate-800/60 rounded px-2 py-1.5 flex flex-wrap justify-between gap-x-2 gap-y-0.5">
        {spec.kind === 'bistable' ? (
          <span>Snap force <b>{snapForceN.toFixed(2)} N</b></span>
        ) : (
          <span>
            Stiffness <b>{spec.stiffness.toPrecision(3)} {jointType === 'hinge' ? 'N·m/rad' : 'N/m'}</b>
          </span>
        )}
        <span>
          Safe travel <b>±{spec.maxTravel.toFixed(1)}{jointType === 'hinge' ? '°' : ' mm'}</b>
        </span>
        <span className="text-slate-400">σ {peakStressMPa.toFixed(0)} MPa</span>
      </div>

      {warnings.map((w, i) => (
        <div
          key={i}
          className="flex items-start gap-1.5 text-[10px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-800/60 rounded px-2 py-1 leading-snug"
        >
          <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
          <span>{w}</span>
        </div>
      ))}
    </div>
  );
}
