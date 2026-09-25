import React, { useState } from 'react';
import { useStore } from '../store/useStore';
import { useBodyEdges } from '../hooks/useBodyEdges';
import { findNodeById } from '../utils/sceneTree';
import { maxSizeFor, sameEdge, selectEdges, type EdgeGroup } from '../utils/featureEdges';
import { RangeInput } from './RangeInput';
import { SettledNumberField } from './SettledInputs';

/**
 * Round edges: the floating panel.
 *
 * Everything a first-time user needs is on it and nothing else: round or
 * bevel, how big, which edges, keep it or not. The words are the ones a
 * person uses — "Round" and "Bevel"; fillet and chamfer are in the tooltips
 * for anyone who knows them. The size can never be dragged past what fits,
 * and a typed size that does not fit is brought back to the largest that does,
 * with a sentence saying so, rather than a boolean failing somewhere offstage.
 *
 * The edges themselves are picked in the viewport (EdgeRoundTool).
 */
const GROUPS: { id: EdgeGroup; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Every outside edge of the part' },
  { id: 'top', label: 'Top', hint: 'The outside edges round the faces that point up' },
  { id: 'bottom', label: 'Bottom', hint: 'The outside edges round the faces that point down' },
  { id: 'vertical', label: 'Vertical', hint: 'The upright outside edges' },
  { id: 'inside', label: 'Inside corners', hint: 'Where two faces meet in a valley: rounding one fills it in, which makes a bracket or a boss stronger' },
];

const mm = (m: number) => Math.round(m * 1e5) / 100;

export const EdgeRoundPanel: React.FC = () => {
  const session = useStore((s) => s.edgeRoundSession);
  const node = useStore((s) => (s.edgeRoundSession ? findNodeById(s.sceneGraph.nodes, s.edgeRoundSession.nodeId) : null));
  const printing = useStore((s) => s.machineTarget === 'fdm');
  const { edges: body, error, loading } = useBodyEdges(session ? node : null);
  const [notice, setNotice] = useState<string | null>(null);

  if (!session) return null;
  const store = useStore.getState();

  const pickedCandidates = body ? body.edges.filter((c) => session.picked.some((p) => sameEdge(p, c.edge))) : [];
  const most = pickedCandidates.length ? maxSizeFor(pickedCandidates, session.mode) : body ? maxSizeFor(body.edges, session.mode) : 0;
  const sizeMm = mm(session.size);
  const mostMm = Math.floor(most * 1e5) / 100;

  const setSize = (metres: number) => {
    if (most > 0 && metres > most + 1e-9) {
      setNotice(`${mm(metres)} mm is too big for ${pickedCandidates.length === 1 ? 'this edge' : 'these edges'} — ${mostMm} mm is the most that fits, so it is set to that.`);
      store.updateEdgeRoundDraft({ size: Math.floor(most * 1e5) / 1e5 });
      return;
    }
    setNotice(null);
    store.updateEdgeRoundDraft({ size: Math.max(0.0001, metres) });
  };

  const pickGroup = (group: EdgeGroup) => {
    if (!body) return;
    setNotice(null);
    store.updateEdgeRoundDraft({ picked: selectEdges(body.edges, group).picked.map((c) => c.edge) });
  };

  const setMode = (mode: 'fillet' | 'chamfer') => {
    // Switching can shrink what fits (a fillet on a shallow corner needs more
    // room than a bevel of the same size), so bring the size inside it.
    const fits = pickedCandidates.length ? maxSizeFor(pickedCandidates, mode) : most;
    store.updateEdgeRoundDraft({ mode, ...(fits > 0 && session.size > fits ? { size: Math.floor(fits * 1e5) / 1e5 } : {}) });
  };

  const bottomBevel = () => {
    if (!body) return;
    const bottom = selectEdges(body.edges, 'bottom').picked;
    const fits = maxSizeFor(bottom, 'chamfer');
    store.updateEdgeRoundDraft({ mode: 'chamfer', picked: bottom.map((c) => c.edge), size: Math.min(0.0005, fits) });
  };

  const groupsHere = body ? GROUPS.filter((g) => selectEdges(body.edges, g.id).picked.length > 0) : [];
  const failed = node?.csgError;
  const blocked = !!error && !body;

  return (
    <div className="pointer-events-auto w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 shadow-lg backdrop-blur-md p-3 text-xs text-slate-700 dark:text-slate-200">
      <div className="flex items-center justify-between mb-2">
        <span className="font-semibold text-slate-800 dark:text-slate-100">
          Round edges{node?.name ? <span className="font-normal text-slate-400"> · {node.name}</span> : null}
        </span>
        <span className="text-[10px] text-slate-400">{blocked ? '' : loading ? 'Finding edges…' : `${session.picked.length} picked`}</span>
      </div>

      {blocked ? (
        <p className="text-slate-500 dark:text-slate-400 leading-snug">{error}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1 p-0.5 rounded-lg bg-slate-100 dark:bg-slate-800 mb-3" role="radiogroup" aria-label="Round or bevel">
            {([['fillet', 'Round', 'A smooth curve (a fillet)'], ['chamfer', 'Bevel', 'A flat cut across the corner (a chamfer)']] as const).map(([mode, label, hint]) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={session.mode === mode}
                title={hint}
                onClick={() => setMode(mode)}
                className={`py-1 rounded-md font-semibold transition-colors cursor-pointer ${
                  session.mode === mode ? 'bg-white dark:bg-slate-950 shadow-sm text-slate-900 dark:text-white' : 'text-slate-500 hover:text-slate-700 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="flex items-center justify-between gap-2 mb-1 font-medium text-slate-500 dark:text-slate-400">
            {session.mode === 'fillet' ? 'Radius' : 'Size'}
            <span className="flex items-center gap-1">
              <SettledNumberField
                value={sizeMm}
                min={0.1}
                onChange={(v) => setSize(v / 1000)}
                className="w-16 text-right"
              />
              <span>mm</span>
            </span>
          </label>
          <RangeInput
            min={0.1}
            max={Math.max(0.2, mostMm)}
            step={0.1}
            value={Math.min(sizeMm, Math.max(0.2, mostMm))}
            onChange={(v) => setSize(v / 1000)}
            disabled={!body || most <= 0}
            className="w-full accent-amber-500 cursor-pointer"
            title="Hold Alt for fine steps"
          />
          <div className="flex justify-between text-[10px] text-slate-400 mb-3">
            <span>0.1 mm</span>
            <span>{mostMm > 0 ? `${mostMm} mm fits` : ''}</span>
          </div>

          <div className="flex flex-wrap items-center gap-1 mb-2">
            <span className="text-[10px] text-slate-400 mr-1">Pick</span>
            {groupsHere.map((g) => (
              <button
                key={g.id}
                type="button"
                title={g.hint}
                onClick={() => pickGroup(g.id)}
                className="px-2 py-0.5 rounded-full border border-slate-200 dark:border-slate-700 hover:border-amber-400 hover:text-amber-700 dark:hover:text-amber-300 cursor-pointer"
              >
                {g.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => store.updateEdgeRoundDraft({ picked: [] })}
              className="px-2 py-0.5 rounded-full text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
            >
              Clear
            </button>
          </div>
          <p className="text-[10px] leading-snug text-slate-400 mb-2">
            Or click edges on the part, or a face to take all its edges. Click again to drop one.
          </p>

          {printing && body && body.edges.some((e) => e.bottom) && (
            <p className="text-[10px] leading-snug text-sky-700 dark:text-sky-300 bg-sky-50 dark:bg-sky-950/40 rounded-md px-2 py-1 mb-2">
              Printing? Bevel the bottom edges rather than rounding them — a rounded bottom edge overhangs.{' '}
              <button type="button" onClick={bottomBevel} className="underline font-semibold cursor-pointer">Bevel bottom 0.5 mm</button>
            </p>
          )}

          {(notice || failed) && (
            <p className="text-[10px] leading-snug text-amber-700 dark:text-amber-300 mb-2">
              {notice ?? 'Those edges could not be rounded at this size — try a smaller one, or fewer edges.'}
            </p>
          )}
          {body && body.other.length > 0 && (
            <p className="text-[10px] leading-snug text-slate-400 mb-2">
              {body.other.length} curved edge{body.other.length === 1 ? '' : 's'} on this part can’t be rounded yet, only straight edges and round rims.
            </p>
          )}
        </>
      )}

      <div className="flex justify-end gap-2 mt-1">
        <button
          type="button"
          onClick={() => store.cancelEdgeRound()}
          className="px-3 py-1 rounded-md text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          title="Put the part back as it was (Esc)"
        >
          Cancel
        </button>
        {!blocked && (
          <button
            type="button"
            onClick={() => store.applyEdgeRound()}
            className="px-3 py-1 rounded-md bg-amber-500 hover:bg-amber-600 text-white font-semibold cursor-pointer disabled:opacity-50"
            title="Keep it (Enter)"
          >
            Apply
          </button>
        )}
      </div>
    </div>
  );
};

export default EdgeRoundPanel;
