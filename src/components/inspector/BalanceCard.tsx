import { useMemo, useState } from 'react';
import { Scale, RotateCcw, Crosshair } from 'lucide-react';
import type { SceneGraph, SceneNode } from '../../types/scene';
import { useStore } from '../../store/useStore';
import { useViewQuality } from '../../store/viewQualityStore';
import {
  analyzeStability,
  balanceBody,
  clearBalanceAdjustments,
  type BalanceMode,
} from '../../utils/balancePart';
import { resolveWaterSurfaceAt } from '../../utils/hydrostatics';
import { DocsInfoButton } from '../docs/DocsInfoButton';

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

function applyDiscreteNodeReplacement(nodeId: string, nextNode: SceneNode) {
  const state = useStore.getState();
  const nextGraph: SceneGraph = {
    ...state.sceneGraph,
    nodes: replaceNodeInTree(state.sceneGraph.nodes, nodeId, nextNode),
  };
  state.updateScene(nextGraph);
}

/**
 * Inverse Balance & Ballast ("Make It Stand / Spin / Float"):
 * Hollows an internal void and seats silent steel hex nuts (counted in Make → Parts list,
 * omitted from STL/3MF prints) so top-heavy sculptures stand, hinged rotors spin true,
 * and boats float upright without changing their outer silhouette.
 */
export function BalanceCard({ node }: { node: SceneNode }) {
  const sceneGraph = useStore((s) => s.sceneGraph);
  const waterLevel = useStore((s) => s.waterLevel);
  const showCog = useViewQuality((s) => s.showCenterOfGravity);
  const setShowCog = useViewQuality((s) => s.setShowCenterOfGravity);
  const [lastSummary, setLastSummary] = useState<string | null>(null);

  const effectiveWaterZ = useMemo(
    () => resolveWaterSurfaceAt(sceneGraph.nodes, node, waterLevel),
    [sceneGraph.nodes, node, waterLevel],
  );

  const isEligible = useMemo(() => {
    if (node.hardwarePart || node.simulation) return false;
    const solidGeoms = (node.geoms ?? []).filter(
      (g) => g.type !== 'plane' && !g.csgDerived && g.csg !== 'difference',
    );
    return solidGeoms.length > 0;
  }, [node]);

  const report = useMemo(
    () => (isEligible ? analyzeStability(node, effectiveWaterZ ?? 0) : null),
    [isEligible, node, effectiveWaterZ],
  );

  if (!isEligible || !report) return null;

  const hasAdjustments =
    (node.geoms ?? []).some((g) => g.name === 'balance_void') ||
    (node.children ?? []).some((c) => c.id.includes('_ballast_'));

  const runBalance = (mode: BalanceMode) => {
    const res = balanceBody(node, mode, { waterLevel: effectiveWaterZ ?? 0 });
    applyDiscreteNodeReplacement(node.id, res.node);
    setLastSummary(res.summary);
  };

  const handleReset = () => {
    const cleaned = clearBalanceAdjustments(node);
    applyDiscreteNodeReplacement(node.id, cleaned);
    setLastSummary(null);
  };

  return (
    <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2">
      <div className="flex items-center justify-between border-b border-slate-100 dark:border-slate-800 pb-1.5">
        <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <Scale className="w-3.5 h-3.5 text-indigo-500" /> Balance &amp; Ballast
          <DocsInfoButton tab="balance" />
        </h3>
        <div className="flex items-center gap-1.5">
          {hasAdjustments && (
            <button
              type="button"
              onClick={handleReset}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
              title="Remove internal balance cavity and seated ballast nuts"
            >
              <RotateCcw className="w-2.5 h-2.5" /> Reset
            </button>
          )}
          <button
            type="button"
            role="switch"
            aria-checked={showCog}
            onClick={() => setShowCog(!showCog)}
            className={`flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-semibold cursor-pointer transition-colors ${
              showCog
                ? 'bg-amber-50 dark:bg-amber-950/50 border-amber-300 dark:border-amber-700 text-amber-700 dark:text-amber-300'
                : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
            }`}
            title="Toggle 3D Centre of Gravity marker, plumb line, and support polygon in the viewport"
          >
            <Crosshair className="w-2.5 h-2.5" /> Show CoG
          </button>
        </div>
      </div>

      {/* Always-on Centre of Gravity readout */}
      <div className="flex flex-col gap-0.5 bg-slate-50 dark:bg-slate-800/60 rounded px-2 py-1.5 text-[10px] font-mono text-slate-600 dark:text-slate-300">
        <div className="flex justify-between items-center">
          <span className="font-sans font-semibold text-slate-500 dark:text-slate-400">Centre of Gravity</span>
          <span className="font-bold text-slate-700 dark:text-slate-100">
            X {(report.comWorld[0] * 1000).toFixed(1)} · Y {(report.comWorld[1] * 1000).toFixed(1)} · Z {(report.comWorld[2] * 1000).toFixed(1)} mm
          </span>
        </div>
        <div className="flex justify-between items-center text-slate-500 dark:text-slate-400">
          <span className="font-sans">Above base: {Math.max(0, (report.comWorld[2] - report.stand.baseZ) * 1000).toFixed(1)} mm</span>
          <span>
            {report.stand.edgeMarginMm >= 0
              ? `${report.stand.edgeMarginMm.toFixed(1)} mm inside base`
              : `${Math.abs(report.stand.edgeMarginMm).toFixed(1)} mm past edge`}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5 text-[10px]">
        <span
          className={`px-1.5 py-0.5 rounded font-medium ${
            report.stand.stands
              ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200/70 dark:border-emerald-800/60'
              : 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200/70 dark:border-amber-800/60'
          }`}
          title="Static floor stability margin and tilt-over angle"
        >
          {report.stand.stands ? `Stands (${report.stand.tipAngleDeg.toFixed(0)}° tip)` : 'Tips over'}
        </span>
        {report.spin.hasHinge && (
          <span
            className={`px-1.5 py-0.5 rounded font-medium ${
              report.spin.eccentricityMm < 0.5
                ? 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border border-emerald-200/70 dark:border-emerald-800/60'
                : 'bg-sky-50 dark:bg-sky-950/40 text-sky-700 dark:text-sky-300 border border-sky-200/70 dark:border-sky-800/60'
            }`}
            title="Radial centre-of-mass eccentricity from hinge axis"
          >
            Spin Δ {report.spin.eccentricityMm.toFixed(1)} mm
          </span>
        )}
        {effectiveWaterZ !== null && (
          <span
            className={`px-1.5 py-0.5 rounded font-medium ${
              report.float.floats && !report.float.flooded
                ? 'bg-cyan-50 dark:bg-cyan-950/40 text-cyan-700 dark:text-cyan-300 border border-cyan-200/70 dark:border-cyan-800/60'
                : 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border border-rose-200/70 dark:border-rose-800/60'
            }`}
            title="Hydrostatic flotation and trim offset"
          >
            {report.float.floats && !report.float.flooded
              ? `Floats (${report.float.freeboardMm.toFixed(0)} mm freeboard)`
              : report.float.flooded
                ? 'Swamps rim'
                : 'Sinks'}
          </span>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        <button
          type="button"
          onClick={() => runBalance('stand')}
          className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 hover:bg-indigo-50 dark:bg-slate-800 dark:hover:bg-indigo-950/40 text-[10px] font-semibold text-slate-700 dark:text-slate-200 hover:border-indigo-300 transition-colors cursor-pointer"
          title="Hollow upper interior and seat steel hex-nut ballast in the base so this part stands upright"
        >
          Stand
        </button>
        <button
          type="button"
          disabled={!report.spin.hasHinge}
          onClick={() => runBalance('spin')}
          className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 hover:bg-indigo-50 dark:bg-slate-800 dark:hover:bg-indigo-950/40 text-[10px] font-semibold text-slate-700 dark:text-slate-200 hover:border-indigo-300 disabled:opacity-40 disabled:pointer-events-none transition-colors cursor-pointer"
          title={report.spin.hasHinge ? 'Align centre of mass onto the hinge axis so this rotor spins without wobble' : 'Add a Hinge joint first to balance around its spin axis'}
        >
          Spin
        </button>
        <button
          type="button"
          onClick={() => runBalance('float')}
          className="px-2 py-1.5 rounded border border-slate-200 dark:border-slate-700 bg-slate-50 hover:bg-cyan-50 dark:bg-slate-800 dark:hover:bg-cyan-950/40 text-[10px] font-semibold text-slate-700 dark:text-slate-200 hover:border-cyan-300 transition-colors cursor-pointer"
          title="Enable water (if off) and trim internal void + keel ballast to float upright"
        >
          Float
        </button>
      </div>

      {lastSummary && (
        <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
          {lastSummary}
        </div>
      )}
    </div>
  );
}
