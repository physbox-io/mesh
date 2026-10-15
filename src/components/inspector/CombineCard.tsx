import { Donut } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { findNodeById } from '../../utils/sceneTree';
import type { SceneNode } from '../../types/scene';

/*
 * Combining. A boolean is a program over ONE body's shapes, so
 * two bodies dragged in from the sidebar can never cut each
 * other however they overlap — the shapes have to be on one
 * body first. Shift-click a second body and this appears.
 */
export function CombineCard({ node }: { node: SceneNode }) {
  const combineBodies = useStore((s) => s.combineBodies);
  const extraSelectedIds = useStore((s) => s.extraSelectedIds);
  const sceneGraph = useStore((s) => s.sceneGraph);

  if (extraSelectedIds.length === 0) return null;
  return (
    <div className="p-3 bg-white dark:bg-slate-900 rounded-lg border border-indigo-200 dark:border-indigo-900 shadow-sm flex flex-col gap-2">
      <h3 className="text-sm font-medium text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
        <Donut className="w-3.5 h-3.5 text-indigo-500" />
        Combine {extraSelectedIds.length + 1} bodies
      </h3>
      <p className="text-[10px] text-slate-400 leading-snug">
        The other {extraSelectedIds.length === 1 ? 'body is' : 'bodies are'} merged into
        <strong> {node.name || node.id}</strong>, keeping
        {extraSelectedIds.length === 1 ? ' its' : ' their'} place in the world. One body
        comes out.
      </p>
      {/* Said out loud, because a merged body takes its subtree
          with it and losing a child body you spent time on is not
          something to find out afterwards. */}
      {(() => {
        const withKids = extraSelectedIds.filter((id) => {
          const n = findNodeById(sceneGraph.nodes, id);
          return (n?.children?.length ?? 0) > 0;
        });
        if (withKids.length === 0) return null;
        return (
          <p className="text-[10px] leading-snug text-amber-600 dark:text-amber-400">
            <strong>Anything parented to {withKids.length === 1 ? 'it' : 'them'} goes too.</strong>{' '}
            {withKids.join(', ')} {withKids.length === 1 ? 'has' : 'have'} child bodies, and
            merging removes the body they hang from. Undo puts it all back.
          </p>
        );
      })()}
      <div className="flex gap-1">
        {([
          ['union', '＋ Add', 'One body made of both shapes.'],
          ['difference', '－ Subtract', 'The other shapes are cut out of this one.'],
          ['intersection', '∩ Intersect', 'Only the overlap is kept.'],
        ] as const).map(([op, label, hint]) => (
          <button
            key={op}
            type="button"
            onClick={() => combineBodies(node.id, extraSelectedIds, op)}
            title={hint}
            className="flex-1 py-1.5 rounded-md text-[10px] font-semibold bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-indigo-100 dark:hover:bg-indigo-950/50 hover:text-indigo-700 dark:hover:text-indigo-300 cursor-pointer transition-colors"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
