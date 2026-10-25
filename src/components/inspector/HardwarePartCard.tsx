import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { HARDWARE_PARTS } from '../../utils/hardwareParts';
import { findNodeById } from '../../utils/sceneTree';

const fieldClass = 'w-full px-1.5 py-1 border border-slate-200 dark:border-slate-700 rounded text-xs bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200';
const labelClass = 'block text-[9px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500';

/**
 * A bought part's size, length and washer. A part seated in a cut takes its
 * size from the cut, so changing it here changes the cut; its length is still
 * its own, since the same counterbore takes a 10 mm screw or a 30.
 */
export function HardwarePartCard({ node }: { node: SceneNode }) {
  const setHardwarePart = useStore((s) => s.setHardwarePart);
  const addHardwarePart = useStore((s) => s.addHardwarePart);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const graph = useStore((s) => s.sceneGraph);
  const spec = node.hardwarePart;
  if (!spec) return null;

  if (spec.piece === 'inner') {
    const owner = findOwner(graph.nodes, node.id);
    return (
      <div className="p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg text-[11px] text-slate-500 dark:text-slate-400">
        The inner race, which turns on its hinge. Fix a shaft or a part to it and that turns with it.
        {owner && (
          <button type="button" onClick={() => setSelectedNodeId(owner.id)} className="block mt-1 font-semibold text-blue-600 dark:text-blue-400 cursor-pointer">
            Select {owner.name}
          </button>
        )}
      </div>
    );
  }

  const info = HARDWARE_PARTS[spec.kind];
  const seatedInCut = !!spec.seat && spec.seat !== 'bore';
  const inner = spec.kind === 'bearing' ? node.children.find((c) => c.hardwarePart?.piece === 'inner') : undefined;
  const hasShaft = !!inner?.children.some((c) => c.hardwarePart?.kind === 'shaft');
  const fastened = spec.fastens ? findNodeById(graph.nodes, spec.fastens) : null;

  return (
    <div className="flex flex-col gap-2 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg">
      <div>
        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">{info.label}</div>
        <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
          Bought, not made: simulated, and left out of every print and machining export.
        </div>
      </div>
      <div className="flex gap-1.5 items-end">
        <label className="flex-1 min-w-0" title={seatedInCut ? 'Sized by the cut it sits in: this changes the cut too.' : undefined}>
          <span className={labelClass}>Size</span>
          <select value={spec.size} onChange={(e) => setHardwarePart(node.id, { size: e.target.value })} className={fieldClass}>
            {info.sizes.map((s) => <option key={s} value={s}>{spec.kind === 'shaft' ? `Ø${s} mm` : s}</option>)}
          </select>
        </label>
        {info.lengths && (
          <label className="flex-1 min-w-0" title={spec.kind === 'screw' ? 'Length under the head, as screws are sold.' : 'Overall length.'}>
            <span className={labelClass}>Length</span>
            <select value={spec.lengthMm} onChange={(e) => setHardwarePart(node.id, { lengthMm: Number(e.target.value) })} className={fieldClass}>
              {withCurrent(info.lengths, spec.lengthMm).map((l) => <option key={l} value={l}>{l} mm</option>)}
            </select>
          </label>
        )}
      </div>
      {spec.kind === 'screw' && !seatedInCut && (
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer" title="A plain ISO 7089 washer under the head. It raises the head by its thickness.">
          <input type="checkbox" checked={!!spec.washer} onChange={(e) => setHardwarePart(node.id, { washer: e.target.checked })} />
          Washer under the head
        </label>
      )}
      {spec.kind === 'screw' && seatedInCut && (
        <div className="text-[10px] text-slate-500 dark:text-slate-400">
          {fastened ? <>Holds this part to <span className="font-semibold">{fastened.name}</span>.</> : 'Reaches nothing below to hold yet.'}
        </div>
      )}
      {spec.kind === 'bearing' && !hasShaft && (
        <button
          type="button"
          onClick={() => addHardwarePart('shaft', [0, 0, 0], node.id)}
          className="w-full py-1 rounded border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 hover:border-blue-300 cursor-pointer"
          title="A shaft the size of its bore, fixed in the inner race, so it turns with it"
        >
          Add shaft
        </button>
      )}
    </div>
  );
}

/** The menu's lengths, with the one it has now even when it is not a standard one. */
function withCurrent(lengths: readonly number[], current?: number): number[] {
  return current !== undefined && !lengths.includes(current) ? [...lengths, current].sort((a, b) => a - b) : [...lengths];
}

function findOwner(nodes: SceneNode[], id: string, parent: SceneNode | null = null): SceneNode | null {
  for (const n of nodes) {
    if (n.id === id) return parent;
    const found = findOwner(n.children || [], id, n);
    if (found) return found;
  }
  return null;
}
