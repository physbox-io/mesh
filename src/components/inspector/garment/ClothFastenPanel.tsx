import type { ClothFastening, ClothPoint, ClothSpec, GarmentTrim } from '../../../types/cloth';
import { TRIM_KINDS } from '../../../utils/cloth/clothValidate';
import { Heading } from './garmentUi';
import { labelCls, removeCls, selectCls, smallButtonCls } from './garmentStyle';

const mm = (v: number) => Math.round(v * 1000);

/**
 * Points of the cloth held together (ClothSpec.fasten), as MCP writes them:
 * each a point on one piece and one on another (or the same), by where it is
 * on the flat piece in mm, drawn closed over the sew time; a trim drawn where
 * it fastens (a button, a snap's stud). A wrap's corner to its side, a flap
 * to its front, a tab to its sleeve.
 */
export function ClothFastenPanel({ cloth, pieces, setCloth }: { cloth: ClothSpec; pieces: string[]; setCloth: (c: ClothSpec, settle?: boolean) => void }) {
  const list = cloth.fasten ?? [];
  const setList = (next: ClothFastening[], settle = false) => setCloth({ ...cloth, fasten: next.length ? next : undefined }, settle);
  const patch = (i: number, p: Partial<ClothFastening>, settle = false) => setList(list.map((f, j) => (j === i ? { ...f, ...p } : f)), settle);
  const names = (cur: string) => [...new Set([...pieces, cur])];
  const point = (i: number, end: 'a' | 'b', f: ClothFastening) => {
    const pt = f[end];
    const set = (p: Partial<ClothPoint>, settle = false) => { const next = { ...pt, ...p }; patch(i, end === 'a' ? { a: next } : { b: next }, settle); };
    return (
      <div className="grid grid-cols-[1fr_3.5rem_3.5rem] gap-1 items-end">
        <label className="flex flex-col gap-1" title="The piece the point is on">
          <span className={labelCls}>{end === 'a' ? 'This' : 'To'}</span>
          <select className={selectCls} value={pt.piece} onChange={(e) => set({ piece: e.target.value })}>
            {names(pt.piece).map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        {[0, 1].map((c) => (
          <label key={c} className="flex flex-col gap-1" title={c === 0 ? 'Across the flat piece, mm' : 'Up the flat piece, mm'}>
            <span className={labelCls}>{c === 0 ? 'u mm' : 'v mm'}</span>
            <input type="number" className={selectCls} value={mm(pt.at[c])} onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) set({ at: (c === 0 ? [v / 1000, pt.at[1]] : [pt.at[0], v / 1000]) as [number, number] }, true); }} />
          </label>
        ))}
      </div>
    );
  };
  return (
    <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-200/70 dark:border-slate-700/70">
      <Heading>Fastenings</Heading>
      {list.map((f, i) => (
        <div key={i} className="flex flex-col gap-1.5 p-2 rounded-md bg-white/60 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/70">
          {point(i, 'a', f)}
          {point(i, 'b', f)}
          <div className="flex items-center gap-1.5">
            <select className={`${selectCls} flex-1`} value={f.trim?.kind ?? ''} title="What is drawn where it fastens" onChange={(e) => patch(i, { trim: e.target.value ? { ...f.trim, kind: e.target.value as GarmentTrim['kind'] } : undefined })}>
              <option value="">Nothing shown</option>
              {TRIM_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <button type="button" className={removeCls} title="Remove" onClick={() => setList(list.filter((_, j) => j !== i))}>×</button>
          </div>
        </div>
      ))}
      <button type="button" className={smallButtonCls} disabled={!pieces.length}
        onClick={() => setList([...list, { a: { piece: pieces[0], at: [0, 0] }, b: { piece: pieces[Math.min(1, pieces.length - 1)], at: [0, 0] }, trim: { kind: 'button' } }])}
        title="Hold a point of one piece to a point of another, drawn together as the scene starts">Add fastening</button>
    </div>
  );
}
