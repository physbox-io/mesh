import { useEffect } from 'react';
import type { GarmentCurve, GarmentDraft } from '../../types/cloth';
import { useGarmentSculpt } from '../../store/garmentSculptStore';

const KINDS: { id: GarmentCurve['kind']; label: string; tip: string }[] = [
  { id: 'seam', label: 'Seam', tip: 'Cut and sewn back: the pieces part along it. Ended inside a piece, it is sewn shut, like a dart.' },
  { id: 'open', label: 'Opening', tip: 'Cut and left open: a slit, a vent, an opening.' },
  { id: 'cut', label: 'Cut away', tip: 'Cut, and the smaller part it cuts off taken away: round on itself, a cut-out; from an edge back to an edge, a new line for it (a neckline, a hem).' },
];

/**
 * Curves drawn on the garment with a pen: seams, openings and cuts along any
 * line. Each is saved in the draft's `curves` (as MCP writes them) and the
 * garment is cut again along it; the list below changes what one is or
 * takes it away.
 */
export function GarmentCurvesPanel({ nodeId, draft, setDraft }: { nodeId: string; draft: GarmentDraft; setDraft: (d: GarmentDraft) => void }) {
  const tool = useGarmentSculpt();
  const on = tool.target === nodeId && tool.tool === 'draw';
  useEffect(() => () => { const st = useGarmentSculpt.getState(); if (st.target === nodeId && st.tool === 'draw') st.set({ target: null }); }, [nodeId]);
  const curves = draft.curves ?? [];
  const setCurves = (next: GarmentCurve[]) => setDraft({ ...draft, curves: next.length ? next : undefined });
  const seg = (active: boolean) => `flex-1 py-1 transition-colors cursor-pointer ${active ? 'bg-purple-600 text-white' : 'bg-white text-slate-600 hover:bg-slate-100'}`;
  const select = 'text-[11px] border border-slate-200 rounded px-1 py-0.5 bg-white text-slate-700 cursor-pointer';
  return (
    <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-200/70">
      <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Lines</label>
      <button onClick={() => tool.set({ target: on ? null : nodeId, tool: 'draw' })}
        title="Drag on the garment with the left mouse button to draw a line along it; end where you started to close it round. Each line cuts the garment again."
        className={`w-full text-xs font-semibold py-1.5 rounded-md border transition-colors cursor-pointer ${on ? 'bg-purple-600 border-purple-600 text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
        {on ? 'Drawing: drag on the garment' : 'Draw on the garment'}
      </button>
      {on && (
        <>
          <div className="flex rounded-lg border border-slate-200 overflow-hidden text-[11px] font-semibold">
            {KINDS.map((k) => <button key={k.id} title={k.tip} className={seg(tool.curveKind === k.id)} onClick={() => tool.set({ curveKind: k.id })}>{k.label}</button>)}
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer" title="Each line on both sides, mirrored across the centre">
            <input type="checkbox" className="accent-purple-600" checked={tool.mirror} onChange={(e) => tool.set({ mirror: e.target.checked })} />
            Both sides
          </label>
        </>
      )}
      {curves.map((c, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs text-slate-600">
          <span className="flex-1 truncate" title={`${c.points.length} points${c.closed ? ', closed' : ''}${c.mirror ? ', both sides' : ''}`}>{c.name}</span>
          <select className={select} value={c.kind} onChange={(e) => setCurves(curves.map((x, j) => (j === i ? { ...x, kind: e.target.value as GarmentCurve['kind'] } : x)))}>
            {KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
          <button className="text-slate-400 hover:text-red-600 cursor-pointer px-1" title="Take this line away" onClick={() => setCurves(curves.filter((_, j) => j !== i))}>×</button>
        </div>
      ))}
    </div>
  );
}
