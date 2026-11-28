import { SettledColorInput } from '../../SettledInputs';
import type { SceneNode } from '../../../types/scene';
import type { ClothMaterialName, GarmentPieceFabric } from '../../../types/cloth';
import { FABRICS } from '../garmentFields';
import { cardCls, Heading, hex, labelCls, removeCls, rgbaOf, selectCls } from './garmentUi';
import { useClothPieces, useGarmentWriters } from './useGarmentDraft';

/**
 * Each piece of a garment, its own panels and what is sewn on, in a fabric or
 * colour of its own (GarmentDraft.pieceFabrics, as MCP writes it), with its
 * flat size and how far it stretched to lie flat. Unset, a piece is the
 * garment's fabric and colour.
 */
export function GarmentPiecesCard({ node }: { node: SceneNode }) {
  const { setDraft } = useGarmentWriters(node);
  const pieces = useClothPieces(node);
  const draft = node.cloth?.garment;
  if (!draft) return null;
  const list = draft.pieceFabrics ?? [];
  const exact = (piece: string) => list.find((f) => f.piece === piece);
  const write = (piece: string, p: Partial<GarmentPieceFabric> | null) => {
    const rest = list.filter((f) => f.piece !== piece);
    const merged = p ? { ...exact(piece), ...p, piece } : null;
    const keep = merged && (merged.material || merged.rgba || merged.materialOverrides) ? [...rest, merged] : rest;
    setDraft({ ...draft, pieceFabrics: keep.length ? keep : undefined }, !!p?.rgba);
  };
  // Entries naming a pair or a group (front, pocket) that no piece is named exactly.
  const shared = list.filter((f) => !pieces.some((p) => p.piece === f.piece));
  return (
    <div className={cardCls}>
      <Heading>Pieces</Heading>
      {!pieces.length && <span className="text-xs text-slate-500 dark:text-slate-400">The pieces show here once the garment is built.</span>}
      {pieces.map((p) => {
        const own = exact(p.piece);
        const w = p.flat ? Math.round((Math.max(...p.flat.uv.map((q) => q[0])) - Math.min(...p.flat.uv.map((q) => q[0]))) * 1000) : null;
        const h = p.flat ? Math.round((Math.max(...p.flat.uv.map((q) => q[1])) - Math.min(...p.flat.uv.map((q) => q[1]))) * 1000) : null;
        return (
          <div key={p.piece} className="grid grid-cols-[1fr_auto_auto_auto] gap-1.5 items-center">
            <span className={`${labelCls} truncate`} title={w !== null ? `${w} × ${h} mm flat; stretched ${((p.flat?.strain95 ?? 0) * 100).toFixed(1)}% to lie flat` : p.piece}>
              {p.piece}{w !== null && <span className="text-slate-400"> · {w}×{h}</span>}
            </span>
            <select className={`${selectCls} w-24`} value={own?.material ?? ''} title="Its fabric; the garment's unless set" onChange={(e) => write(p.piece, { material: (e.target.value || undefined) as ClothMaterialName | undefined })}>
              <option value="">Garment's</option>
              {FABRICS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <SettledColorInput value={hex(own?.rgba ?? p.rgba)} onChange={(c) => write(p.piece, { rgba: rgbaOf(c, (own?.rgba ?? p.rgba)[3] ?? 1) })} className="w-7 h-6 border border-slate-200 dark:border-slate-700 rounded cursor-pointer bg-white dark:bg-slate-900" />
            <button type="button" className={removeCls} title="Back to the garment's fabric and colour" disabled={!own} style={{ visibility: own ? 'visible' : 'hidden' }} onClick={() => write(p.piece, null)}>×</button>
          </div>
        );
      })}
      {shared.map((f) => (
        <div key={f.piece} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
          <span className="flex-1 truncate" title="Set for every piece this names (a pair, or pieces numbered from it)">{f.piece} (all){f.material ? ` · ${f.material}` : ''}</span>
          {f.rgba && <span className="w-4 h-4 rounded border border-slate-300" style={{ background: hex(f.rgba) }} />}
          <button type="button" className={removeCls} onClick={() => write(f.piece, null)} title="Remove">×</button>
        </div>
      ))}
    </div>
  );
}
