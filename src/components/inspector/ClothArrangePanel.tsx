import { useEffect } from 'react';
import type { ClothPull, ClothSpec, ClothTurn } from '../../types/cloth';
import { doneUp } from '../../utils/cloth/fastening';
import { useGarmentSculpt } from '../../store/garmentSculptStore';
import { RangeInput } from '../RangeInput';

/**
 * How the cloth is arranged as it starts (ClothSpec.arrange), as a wearer
 * arranges what they wear: drag a point of it in the viewport to where it
 * goes (a pull, kept with the way the drag went), and turn any piece sewn on
 * along a line about that line (a hood up, a collar turned up, a cuff turned
 * back), and do a zip or buttons up as far as they go (the trim's
 * `fastened`). MCP writes the same `arrange` list and trims.
 */
export function ClothArrangePanel({ nodeId, cloth, setCloth }: { nodeId: string; cloth: ClothSpec; setCloth: (c: ClothSpec) => void }) {
  const tool = useGarmentSculpt();
  const on = tool.target === nodeId && tool.tool === 'arrange';
  useEffect(() => () => { const st = useGarmentSculpt.getState(); if (st.target === nodeId && st.tool === 'arrange') st.set({ target: null }); }, [nodeId]);
  const arrange = cloth.arrange ?? [];
  const setArrange = (next: (ClothPull | ClothTurn)[]) => setCloth({ ...cloth, arrange: next.length ? next : undefined });
  const pulls = arrange.filter((a): a is ClothPull => 'at' in a);
  const sewnOn = (cloth.garment?.attached ?? []).map((a) => a.name);
  const turnOf = (piece: string) => arrange.find((a): a is ClothTurn => 'turn' in a && a.piece === piece)?.turn ?? 0;
  const setTurn = (piece: string, deg: number) => {
    const rest = arrange.filter((a) => !('turn' in a && a.piece === piece));
    setArrange(deg > 0 ? [...rest, { piece, turn: Math.round(deg) }] : rest);
  };
  // Zips and buttons, done up as far as the wearer has them.
  const trims = cloth.garment?.trims ?? [];
  const closures = trims.map((t, k) => ({ t, k })).filter(({ t }) => t.kind === 'zipper' || t.kind === 'button');
  const setDoneUp = (k: number, pct: number) => {
    const next = trims.map((t, j) => (j === k ? { ...t, fastened: pct >= 100 ? true : pct <= 0 ? false : pct / 100 } : t));
    setCloth({ ...cloth, garment: { ...cloth.garment!, trims: next } });
  };
  const label = 'text-xs text-slate-500 font-medium';
  return (
    <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-200/70">
      <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Arrange</label>
      <button onClick={() => tool.set({ target: on ? null : nodeId, tool: 'arrange' })}
        title="Drag a point of the cloth in the viewport with the left mouse button to where it goes; it is drawn there as the scene starts, then let go to settle."
        className={`w-full text-xs font-semibold py-1.5 rounded-md border transition-colors cursor-pointer ${on ? 'bg-purple-600 border-purple-600 text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'}`}>
        {on ? 'Arranging: drag the cloth' : 'Arrange by hand'}
      </button>
      {pulls.map((p, i) => (
        <div key={i} className="flex items-center gap-1.5 text-xs text-slate-600">
          <span className="flex-1 truncate" title={`Its point at ${p.at.map((v) => (v * 1000).toFixed(0)).join(', ')} mm on the pattern, drawn to ${p.to.map((v) => (v * 1000).toFixed(0)).join(', ')} mm${p.via?.length ? `, by way of ${p.via.length} points` : ''}`}>{p.piece} pulled</span>
          <button className="text-slate-400 hover:text-red-600 cursor-pointer px-1" title="Let it hang as it falls instead" onClick={() => setArrange(arrange.filter((a) => a !== p))}>×</button>
        </div>
      ))}
      {closures.map(({ t, k }) => (
        <div key={`c${k}`} className="flex flex-col gap-1" title="How far it is done up from the bottom: 100% all the way, 0 undone">
          <div className="flex items-center justify-between">
            <span className={label}>{t.kind === 'zipper' ? 'Zip' : 'Buttons'} on {t.along} done up</span>
            <span className="text-xs text-slate-500">{Math.round(doneUp(t) * 100)}%</span>
          </div>
          <RangeInput min={0} max={100} step={5} value={Math.round(doneUp(t) * 100)} onChange={(v) => setDoneUp(k, v)} className="w-full cursor-pointer accent-purple-600" />
        </div>
      ))}
      {sewnOn.map((piece) => (
        <div key={piece} className="flex flex-col gap-1" title="Turned about the line it is sewn along as it starts: 0 hanging as it falls, 90 straight out, about 165 up and over">
          <div className="flex items-center justify-between">
            <span className={label}>{piece} turned</span>
            <span className="text-xs text-slate-500">{turnOf(piece)}°</span>
          </div>
          <RangeInput min={0} max={180} step={5} value={turnOf(piece)} onChange={(v) => setTurn(piece, v)} className="w-full cursor-pointer accent-purple-600" />
        </div>
      ))}
    </div>
  );
}
