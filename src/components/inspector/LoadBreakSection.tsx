import { Activity, Hammer } from 'lucide-react';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { deformMaterial, loadStrengthOf } from '../../utils/deformMaterials';
import { memberKey } from '../../utils/breakKeys';
import { memberShape, sectionLimits } from '../../utils/memberStrength';
import { DocsInfoButton } from '../docs/DocsInfoButton';

/*
 * Breaks under load — part of the Deformation card. A long, thin
 * part (rod, strut, plank) loaded hard enough snaps, or, if it is
 * ductile, bends and stays bent. The limits come from the material
 * and the part's own cross-section; see utils/memberStrength.ts.
 */
export function LoadBreakSection({ node, onToggle }: { node: SceneNode; onToggle: (on: boolean) => void }) {
  const lastBreak = useStore((s) => s.lastBreak);
  const broken = useStore((s) => s.brokenConstraints.includes(memberKey(node.id)));
  const shape = memberShape(node);
  const free = (node.joints || []).some((j) => j.type === 'free');
  const strength = loadStrengthOf(node);
  const on = !!node.loadStrength;
  const usable = !!shape && free;
  const limits = shape && strength ? sectionLimits(shape, strength) : null;
  const ductile = !!strength?.ductile;
  const info = lastBreak?.key === memberKey(node.id) ? lastBreak : null;
  const material = deformMaterial(node.deformMaterial);

  const why = !usable
    ? 'Triggers when sustained force (N) exceeds the threshold over multiple steps.'
    : undefined;

  return (
    <>
      <label
        className={`flex items-center gap-2 text-xs ${usable ? 'text-slate-700 cursor-pointer' : 'text-slate-400'}`}
        title={why}
      >
        <input
          type="checkbox"
          checked={on}
          disabled={!usable && !on}
          onChange={(e) => onToggle(e.target.checked)}
          className="accent-violet-500 cursor-pointer disabled:cursor-not-allowed"
        />
        <Activity className="w-3 h-3 text-violet-500" /> Breaks under load
        {broken && <span className="ml-auto text-[10px] font-semibold text-rose-600">{ductile ? 'bent' : 'broken'}</span>}
      </label>
      {on && limits && (
        <div className="flex flex-col gap-1 pl-5">
          <p className="text-[10px] text-slate-500 leading-snug">
            {ductile ? 'Bends for good' : 'Snaps'} past <strong>{fmtNmm(limits.bendingNm)}</strong> of bending,
            buckles under <strong>{fmtN(limits.bucklingN)}</strong> end-on
            {ductile ? '' : <>, pulls apart at <strong>{fmtN(limits.tensionN)}</strong></>}.
            {material ? ` ${material.label}, at this size.` : ''}
          </p>
          {info && (
            <p className="text-[10px] text-rose-700 bg-rose-50 border border-rose-200 rounded px-2 py-1 leading-snug">
              {ductile ? 'Bent' : info.cause === 'buckled' ? 'Buckled' : info.cause === 'pulled' ? 'Pulled apart' : 'Snapped'} at {info.time.toFixed(2)} s. Reset puts it back.
            </p>
          )}
        </div>
      )}
      {on && !usable && (
        <p className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 leading-snug pl-5">{why}</p>
      )}
    </>
  );
}

function fmtNmm(nm: number) {
  return nm < 1 ? `${+(nm * 1000).toPrecision(3)} N·mm` : `${+nm.toPrecision(3)} N·m`;
}
function fmtN(n: number) {
  return n < 10 ? `${+n.toPrecision(2)} N` : `${Math.round(n)} N`;
}

/*
 * The Deformation card for a part that can only break under load:
 * a rod with nothing a dent could push in (a capsule, say).
 */
export function LoadOnlyCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);
  const material = deformMaterial(node.deformMaterial);
  const toggle = (on: boolean) =>
    updateNode(node.id, { loadStrength: on ? { ...(material ?? deformMaterial('hardwood')!).strength } : undefined });
  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 border-b border-slate-100 pb-2 mb-1 flex items-center gap-1.5">
        <Hammer className="w-3.5 h-3.5 text-amber-600" /> Deformation
        <DocsInfoButton tab="breaking" />
      </h3>
      <LoadBreakSection node={node} onToggle={toggle} />
    </div>
  );
}
