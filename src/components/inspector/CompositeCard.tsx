import { useMemo } from 'react';
import { Link2 } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { RangeInput } from '../RangeInput';
import { SliderValue } from '../SliderValue';

const CURVE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 's 0 0', label: 'Straight (+X)' },
  { value: '0 s 0', label: 'Straight (+Y)' },
  { value: '0 0 s', label: 'Vertical (+Z)' },
  { value: 's 0 c', label: 'Arched (X–Z)' },
  { value: 's s 0', label: 'Diagonal (X–Y)' },
];

export function CompositeCard({ node }: { node: SceneNode }) {
  const updateNodeComposite = useStore((s) => s.updateNodeComposite);
  const sceneGraph = useStore((s) => s.sceneGraph);

  const { otherBodies, parentNode } = useMemo(() => {
    const list: SceneNode[] = [];
    let foundParent: SceneNode | null = null;
    const walk = (nodes: SceneNode[], parent: SceneNode | null) => {
      for (const n of nodes || []) {
        if (n.id === node.id) {
          foundParent = parent;
        } else if (!n.isPulleyRope && !n.cloth) {
          list.push(n);
        }
        walk(n.children, n);
      }
    };
    walk(sceneGraph.nodes, null);
    return { otherBodies: list, parentNode: foundParent as SceneNode | null };
  }, [sceneGraph, node.id]);

  if (!node.isComposite) return null;

  const rawCount = parseInt((node.compositeCount || '15 1 1').trim().split(/\s+/)[0] || '15', 10);
  const segmentCount = Number.isFinite(rawCount) && rawCount >= 2 ? rawCount : 15;
  const rawLength = parseFloat(String(node.compositeSize ?? '1.5').trim().split(/\s+/)[0] || '1.5');
  const lengthM = Number.isFinite(rawLength) && rawLength > 0 ? rawLength : 1.5;
  const curve = (node.compositeCurve || 's 0 0').trim();
  const radiusMm = Math.round(((node.geoms?.[0]?.size?.[0] ?? 0.012) * 1000) * 10) / 10;
  const damping = node.joints?.[0]?.damping ?? 0.05;
  const stiffness = node.joints?.[0]?.stiffness ?? 0.0;
  const weldLastToId = node.weldLastToId || '';
  const weldRigid = !!node.weldRigid;

  const updateCableJoint = (patch: { damping?: number; stiffness?: number }) => {
    const existing = node.joints?.[0];
    const nextJoint = existing
      ? { ...existing, ...patch }
      : {
          name: `${node.name || node.id}_cable_joint`,
          type: 'ball' as const,
          ...patch,
        };
    updateNodeComposite(node.id, { joints: [nextJoint, ...(node.joints?.slice(1) || [])] });
  };

  const updateCableRadius = (radiusMmVal: number) => {
    const first = node.geoms?.[0];
    if (!first) return;
    const nextGeom = { ...first, size: [Math.max(0.002, radiusMmVal / 1000)] };
    updateNodeComposite(node.id, { geoms: [nextGeom, ...(node.geoms?.slice(1) || [])] });
  };

  return (
    <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col gap-2.5">
      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 border-b border-slate-100 dark:border-slate-800 pb-2 mb-0.5 flex items-center gap-1.5">
        <Link2 className="w-3.5 h-3.5 text-amber-500" /> Composite Rope / Cable
      </h3>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">
          Segments
          <SliderValue
            value={segmentCount}
            onChange={(v) => updateNodeComposite(node.id, { compositeCount: `${Math.max(3, Math.round(v))} 1 1` })}
            decimals={0}
            min={3}
            max={60}
          />
        </label>
        <RangeInput
          min="3"
          max="60"
          step="1"
          value={segmentCount}
          onChange={(v) => updateNodeComposite(node.id, { compositeCount: `${Math.max(3, Math.round(v))} 1 1` })}
          className="w-full accent-blue-500 cursor-pointer"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">
          Length
          <SliderValue
            value={lengthM}
            onChange={(v) => updateNodeComposite(node.id, { compositeSize: String(Math.max(0.05, v)) })}
            decimals={2}
            unit="m"
            min={0.05}
            max={5}
          />
        </label>
        <RangeInput
          min="0.1"
          max="3"
          step="0.02"
          value={lengthM}
          onChange={(v) => updateNodeComposite(node.id, { compositeSize: String(Math.max(0.05, v)) })}
          className="w-full accent-blue-500 cursor-pointer"
        />
      </div>

      {node.geoms && node.geoms.length > 0 && (
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">
            Radius
            <SliderValue
              value={radiusMm}
              onChange={updateCableRadius}
              decimals={1}
              unit="mm"
              min={2}
              max={50}
            />
          </label>
          <RangeInput
            min="2"
            max="40"
            step="0.5"
            value={radiusMm}
            onChange={updateCableRadius}
            className="w-full accent-blue-500 cursor-pointer"
          />
        </div>
      )}

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Curve</label>
        <select
          value={CURVE_OPTIONS.some((o) => o.value === curve) ? curve : 's 0 0'}
          onChange={(e) => updateNodeComposite(node.id, { compositeCurve: e.target.value })}
          className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 focus:border-blue-500 outline-none cursor-pointer"
        >
          {CURVE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">
          Joint Damping
          <SliderValue
            value={damping}
            onChange={(v) => updateCableJoint({ damping: Math.max(0, v) })}
            decimals={3}
            min={0}
            max={2}
          />
        </label>
        <RangeInput
          min="0"
          max="1"
          step="0.005"
          value={damping}
          onChange={(v) => updateCableJoint({ damping: Math.max(0, v) })}
          className="w-full accent-blue-500 cursor-pointer"
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400 flex justify-between">
          Bending Stiffness
          <SliderValue
            value={stiffness}
            onChange={(v) => updateCableJoint({ stiffness: Math.max(0, v) })}
            decimals={2}
            min={0}
            max={10}
          />
        </label>
        <RangeInput
          min="0"
          max="5"
          step="0.05"
          value={stiffness}
          onChange={(v) => updateCableJoint({ stiffness: Math.max(0, v) })}
          className="w-full accent-blue-500 cursor-pointer"
        />
      </div>

      <div className="flex flex-col gap-0.5 pt-1 border-t border-slate-100 dark:border-slate-800">
        <span className="text-xs font-medium text-slate-500 dark:text-slate-400">Start Anchored To</span>
        <span className="text-xs text-slate-700 dark:text-slate-200 px-2 py-1 rounded bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800">
          {parentNode ? `${parentNode.name || parentNode.id} (parent body)` : 'World (fixed at position)'}
        </span>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium text-slate-500 dark:text-slate-400">Anchor Far End To</label>
        <select
          value={weldLastToId}
          onChange={(e) => updateNodeComposite(node.id, { weldLastToId: e.target.value || undefined })}
          className="w-full px-2 py-1.5 text-xs border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 focus:border-blue-500 outline-none cursor-pointer"
        >
          <option value="">-- Free end --</option>
          {otherBodies.map((b) => (
            <option key={b.id} value={b.id}>{b.name || b.id}</option>
          ))}
        </select>
      </div>

      {weldLastToId && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400" title="Use a stiff weld constraint at the far anchor so heavy loads do not pull the end loose.">
            Rigid End Weld
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={weldRigid}
            onClick={() => updateNodeComposite(node.id, { weldRigid: !weldRigid })}
            className={`relative inline-flex h-4 w-7 shrink-0 cursor-pointer items-center rounded-full transition-colors ${weldRigid ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-700'}`}
          >
            <span className={`inline-block h-3 w-3 rounded-full bg-white shadow transition-transform ${weldRigid ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
          </button>
        </div>
      )}
    </div>
  );
}
