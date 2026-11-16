import { useMemo } from 'react';
import { Volume2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { SceneNode, StringMaterialId } from '../../types/scene';
import { RangeInput } from '../RangeInput';
import { hzToNoteInfo } from '../../utils/acousticTuning';
import { playModalImpact } from '../../utils/modalAudio';
import { findNodeById } from '../../utils/sceneTree';
import { analyzeSoundboxResonance, STRING_MATERIALS } from '../../utils/stringAcoustics';

export function RopeCard({ node }: { node: SceneNode }) {
  const updateRopeParams = useStore((s) => s.updateRopeParams);
  const updateNode = useStore((s) => s.updateNode);
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
              {wheel.id} (r={((wheel.pulleyRadius || 0.08) * 1000).toFixed(0)} mm)
            </option>
          ))}
        </select>
      </div>

      <div className="flex gap-2" title="Strands holding each end: 2 for a load in a movable pulley, 4 for a four-fall block and tackle">
        {(['leftStrands', 'rightStrands'] as const).map((field, i) => (
          <label key={field} className="flex-1 flex flex-col gap-1 text-xs font-semibold text-slate-500">
            Strands on {i === 0 ? 'A' : 'B'}
            <select
              value={node[field] ?? 1}
              onChange={(e) => updateRopeParams(node.id, { [field]: Number(e.target.value) })}
              className="w-full text-xs border border-slate-200 rounded p-1.5 bg-slate-50 font-medium text-slate-700 focus:border-blue-500 outline-none"
            >
              {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
        ))}
      </div>

      {/* Musical String Tensioning on any direct 2-body Rope (no pulley wheel) */}
      {!node.pulleyWheelId && node.leftTargetId && node.rightTargetId && (() => {
        const bodyA = findNodeById(sceneGraph.nodes, node.leftTargetId);
        const bodyB = findNodeById(sceneGraph.nodes, node.rightTargetId);
        const spanM = bodyA && bodyB
          ? Math.max(0.03, Math.hypot(
              (bodyB.pos[0] ?? 0) - (bodyA.pos[0] ?? 0),
              (bodyB.pos[1] ?? 0) - (bodyA.pos[1] ?? 0),
              (bodyB.pos[2] ?? 0) - (bodyA.pos[2] ?? 0),
            ))
          : 0.32;
        const spec = node.acousticString;
        const mat = STRING_MATERIALS[spec?.material ?? 'bronze'];
        const r = (spec?.diameterMm ?? 0.65) / 2000;
        const mu = mat.densityKgM3 * Math.PI * r * r;
        const tension = spec?.tensionN ?? 55;
        const f0 = Math.sqrt(tension / mu) / (2 * spanM);
        const noteInfo = hzToNoteInfo(f0);
        const boxA = bodyA ? analyzeSoundboxResonance(bodyA) : null;
        const boxB = bodyB ? analyzeSoundboxResonance(bodyB) : null;
        const bestBox = boxA?.hasHollowCavity ? boxA : boxB?.hasHollowCavity ? boxB : null;

        return (
          <div className="pt-2 border-t border-slate-100 flex flex-col gap-2">
            <label className="flex items-center justify-between text-xs font-semibold text-slate-600 cursor-pointer">
              <span>🎸 Tension as Musical String</span>
              <input
                type="checkbox"
                checked={!!spec}
                onChange={(e) => {
                  if (e.target.checked) {
                    updateNode(node.id, {
                      acousticString: { material: 'bronze', diameterMm: 0.65, tensionN: 55 },
                    });
                  } else {
                    updateNode(node.id, { acousticString: undefined });
                  }
                }}
              />
            </label>
            {spec && (
              <>
                <div className="flex items-center justify-between bg-slate-50 rounded px-2 py-1 text-xs">
                  <span>
                    <b>{noteInfo.note}</b> ({f0.toFixed(1)} Hz · {(spanM * 1000).toFixed(0)} mm)
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      const voices = Array.from({ length: 8 }, (_, k) => ({
                        freqHz: +(f0 * (k + 1)).toFixed(2),
                        gain: +(0.8 / Math.pow(k + 1, 1.3)).toFixed(3),
                        decaySec: +(1.6 / (1 + 0.35 * k)).toFixed(3),
                      }));
                      playModalImpact(
                        {
                          fundamentalHz: f0,
                          overtoneRatio: 2,
                          regime: 'tube',
                          material: { label: mat.label, density: mat.densityKgM3, modulusGPa: mat.modulusGPa, qualityQ: mat.intrinsicQ, brightness: mat.brightness },
                          contactDurationSec: 0.00075,
                          modes: voices,
                        },
                        0.35,
                        true,
                      );
                    }}
                    className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-violet-50 hover:bg-violet-100 border border-violet-200 text-[10px] font-semibold text-violet-700 cursor-pointer"
                  >
                    <Volume2 className="w-3 h-3" /> Pluck
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <select
                    value={spec.material}
                    onChange={(e) => updateNode(node.id, { acousticString: { ...spec, material: e.target.value as StringMaterialId } })}
                    className="text-xs border border-slate-200 rounded p-1 bg-white text-slate-700"
                  >
                    {Object.values(STRING_MATERIALS).map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                  <div className="flex flex-col justify-center">
                    <span className="text-[10px] text-slate-500">Tension {tension.toFixed(0)} N</span>
                    <RangeInput
                      min="10"
                      max="150"
                      step="1"
                      value={tension}
                      onChange={(v) => updateNode(node.id, { acousticString: { ...spec, tensionN: v } })}
                      className="w-full accent-violet-500 cursor-pointer"
                    />
                  </div>
                </div>
                {bestBox && (
                  <div className="text-[10px] text-amber-700 bg-amber-50/70 rounded px-2 py-1">
                    Coupled to <b>{bestBox.hostName}</b> ({bestBox.cavityVolumeLitres} L{bestBox.helmholtzHz ? ` · Helmholtz ${bestBox.helmholtzHz} Hz` : ''})
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}
    </div>
  );
}
