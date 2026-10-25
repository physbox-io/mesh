import { useState } from 'react';
import { useStore } from '../../store/useStore';
import type { HardwarePart, SceneGraph, SceneNode } from '../../types/scene';
import { HARDWARE_PARTS, fastenTargetFor, seatFor } from '../../utils/hardwareParts';
import { O_RINGS, SEAL_CORDS } from '../../utils/hardwareSizes';
import { findNodeById } from '../../utils/sceneTree';
import { SettledNumberField } from '../SettledInputs';

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
  const addCarriage = useStore((s) => s.addCarriage);
  const graph = useStore((s) => s.sceneGraph);
  const spec = node.hardwarePart;
  if (!spec) return null;

  if (spec.piece) {
    // The part's owner is the body at the top of its pieces.
    let owner = findOwner(graph.nodes, node.id);
    while (owner?.hardwarePart?.piece) owner = findOwner(graph.nodes, owner.id);
    return (
      <div className="p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg text-[11px] text-slate-500 dark:text-slate-400">
        {PIECE_TEXT[spec.piece]}
        {spec.piece === 'carriage' && <Riders piece={node} />}
        {owner && (
          <button type="button" onClick={() => setSelectedNodeId(owner.id)} className="block mt-1 font-semibold text-blue-600 dark:text-blue-400 cursor-pointer">
            Select {owner.name}
          </button>
        )}
      </div>
    );
  }

  const info = HARDWARE_PARTS[spec.kind];
  // A bracket, plate or end-tap screw is sized by the profiles it joins, a
  // carriage by its V-slot: neither is in a cut.
  const joins = spec.seat === 'frame' || spec.seat === 'rail';
  const seatedInCut = !!spec.seat && spec.seat !== 'bore' && !joins;
  const inner = spec.kind === 'bearing' ? node.children.find((c) => c.hardwarePart?.piece === 'inner') : undefined;
  const hasShaft = !!inner?.children.some((c) => c.hardwarePart?.kind === 'shaft');
  const fastened = spec.fastens ? findNodeById(graph.nodes, spec.fastens) : null;
  const carriage = findPiece(node, 'carriage');
  // An O-ring's sizes are its groove's: stocked rings, or cord by the metre.
  const cord = spec.kind === 'oring' && !O_RINGS[spec.size];
  const sizes = spec.kind === 'oring' ? (cord ? SEAL_CORDS : Object.keys(O_RINGS)) : info.sizes;

  return (
    <div className="flex flex-col gap-2 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg">
      <div>
        <div className="text-xs font-semibold text-slate-700 dark:text-slate-200">{info.label}</div>
        <div className="text-[10px] text-slate-500 dark:text-slate-400 leading-snug">
          Bought, not made: simulated, and left out of every print and machining export.
        </div>
      </div>
      <div className="flex gap-1.5 items-end">
        <label className="flex-1 min-w-0" title={joins ? 'Sized by the profiles it joins.' : seatedInCut ? 'Sized by the cut it sits in: this changes the cut too.' : undefined}>
          <span className={labelClass}>Size</span>
          <select value={spec.size} disabled={joins} onChange={(e) => setHardwarePart(node.id, { size: e.target.value })} className={fieldClass}>
            {sizes.map((s) => <option key={s} value={s}>{spec.kind === 'shaft' ? `Ø${s} mm` : cord ? `Ø${s} cord` : s}</option>)}
          </select>
        </label>
        {info.cutToLength && (
          <label className="flex-1 min-w-0" title="Cut to any length, mm.">
            <span className={labelClass}>Length mm</span>
            <SettledNumberField value={spec.lengthMm ?? 0} min={10} onChange={(v) => v >= 10 && setHardwarePart(node.id, { lengthMm: Math.round(v * 10) / 10 })} className={fieldClass} />
          </label>
        )}
        {info.lengths && !joins && (
          <label className="flex-1 min-w-0" title={spec.kind === 'screw' ? 'Length under the head, as screws are sold.' : 'Overall length.'}>
            <span className={labelClass}>Length</span>
            <select value={spec.lengthMm} onChange={(e) => setHardwarePart(node.id, { lengthMm: Number(e.target.value) })} className={fieldClass}>
              {withCurrent(info.lengths, spec.lengthMm).map((l) => <option key={l} value={l}>{l} mm</option>)}
            </select>
          </label>
        )}
      </div>
      {cord && spec.lengthMm !== undefined && (
        <div className="text-[10px] text-slate-500 dark:text-slate-400">Cut {spec.lengthMm} mm of cord, and join its ends with cyanoacrylate.</div>
      )}
      {spec.kind === 'screw' && !seatedInCut && (
        <label className="flex items-center gap-1.5 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer" title="A plain ISO 7089 washer under the head. It raises the head by its thickness.">
          <input type="checkbox" checked={!!spec.washer} onChange={(e) => setHardwarePart(node.id, { washer: e.target.checked })} />
          Washer under the head
        </label>
      )}
      {spec.kind === 'screw' && seatedInCut && (
        <div className="text-[10px] text-slate-500 dark:text-slate-400">
          {fastened ? <>Holds this part to <span className="font-semibold">{fastened.name}</span>.</> : unheldReason(graph, node)}
        </div>
      )}
      {carriage && <Riders piece={carriage} />}
      {joins && fastened && (
        <div className="text-[10px] text-slate-500 dark:text-slate-400">
          Holds <span className="font-semibold">{fastened.name}</span> to the profile it is fixed to.
        </div>
      )}
      {spec.kind === 'extrusion' && spec.size === '2020V' && (
        <button
          type="button"
          onClick={() => addCarriage(node.id)}
          className="w-full py-1 rounded border border-slate-200 dark:border-slate-700 text-[11px] font-semibold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-800 hover:border-blue-300 cursor-pointer"
          title="A wheel plate on this profile, sliding along it between its ends"
        >
          Add carriage
        </button>
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

const PIECE_TEXT: Record<NonNullable<HardwarePart['piece']>, string> = {
  inner: 'The inner race, which turns on its hinge. Fix a shaft or a part to it and that turns with it.',
  carriage: 'The moving part, on a slide along its rail. Fix a part to it and that slides with it, stopping at the ends.',
  middle: 'The middle member, which slides out from the cabinet member and carries the drawer member out past it.',
};

/**
 * What rides a moving piece, and a menu to fix another part to it: the plate
 * on a rail's carriage, the block on a rod's bushing, the drawer on a runner.
 */
function Riders({ piece }: { piece: SceneNode }) {
  const graph = useStore((s) => s.sceneGraph);
  const fixToPiece = useStore((s) => s.fixToPiece);
  const unfixBody = useStore((s) => s.unfixBody);
  const [problem, setProblem] = useState<string | null>(null);
  const riding = allNodes(graph.nodes).filter((n) => n.weldTargetId === piece.id);
  const candidates = allNodes(graph.nodes).filter((n) => !n.hardwarePart && !n.weldTargetId && n.id !== piece.id);
  return (
    <div className="mt-1.5 flex flex-col gap-1">
      {riding.map((r) => (
        <div key={r.id} className="flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400">
          <span className="flex-1">Rides it: <span className="font-semibold">{r.name}</span></span>
          <button type="button" onClick={() => unfixBody(r.id)} className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase cursor-pointer bg-white dark:bg-slate-800 text-slate-400 hover:text-rose-600">Off</button>
        </div>
      ))}
      {candidates.length > 0 && (
        <select
          value=""
          onChange={(e) => { if (e.target.value) setProblem(fixToPiece(piece.id, e.target.value)); }}
          className={fieldClass}
          title="Weld a part to the moving piece, so it slides with it"
        >
          <option value="">Fix a part to it…</option>
          {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}
      {problem && <div className="text-[10px] text-rose-600 dark:text-rose-400 leading-snug">{problem}</div>}
    </div>
  );
}

function allNodes(nodes: SceneNode[], out: SceneNode[] = []): SceneNode[] {
  for (const n of nodes) { out.push(n); allNodes(n.children || [], out); }
  return out;
}

/** A part's moving piece by name, however deep it is. */
function findPiece(node: SceneNode, piece: NonNullable<HardwarePart['piece']>): SceneNode | null {
  for (const c of node.children || []) {
    if (c.hardwarePart?.piece === piece) return c;
    const below = c.hardwarePart?.piece ? findPiece(c, piece) : null;
    if (below) return below;
  }
  return null;
}

/**
 * Why a seated screw holds nothing: it reaches no other part, or the part it
 * reaches is already welded to something else, which a screw will not undo.
 */
function unheldReason(graph: SceneGraph, screw: SceneNode): string {
  const host = findOwner(graph.nodes, screw.id);
  const seat = host && screw.hardwarePart?.seat ? seatFor(host, screw.hardwarePart.seat, 'screw') : null;
  const target = host && seat?.gripM !== undefined ? fastenTargetFor(graph, host, screw, seat.gripM)?.node : null;
  if (!target) return 'Reaches nothing below to hold yet.';
  const other = target.weldTargetId ? findNodeById(graph.nodes, target.weldTargetId) : null;
  return `Reaches ${target.name}, which is already welded to ${other?.name ?? 'something else'}: take that off for the screw to hold it.`;
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
