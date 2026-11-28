import type { ClothMaterialName, GarmentDraft, GarmentFullness } from '../../../types/cloth';
import { capEase } from '../../../utils/cloth/garmentFullness';
import { garmentSettings } from '../../../utils/cloth/garments';
import { FULLNESS_KINDS } from '../../../utils/cloth/clothValidate';
import { Check, FieldSlider, Heading, labelCls, removeCls, selectCls, smallButtonCls } from './garmentUi';

const KIND_LABEL: Record<NonNullable<GarmentFullness['kind']>, string> = { ease: 'Eased', gather: 'Gathered', knife: 'Knife pleats', box: 'Box pleats', inverted: 'Inverted pleats' };
const pleated = (k?: GarmentFullness['kind']) => k === 'knife' || k === 'box' || k === 'inverted';
/** The ratio the builder takes when none is given (garmentFullness: the fabric's own ease, gathers 2, pleats 3). */
const defaultRatio = (k: GarmentFullness['kind'], material: ClothMaterialName) => (k === 'ease' ? 1 + capEase(material) : (k ?? 'gather') === 'gather' ? 2 : 3);

/**
 * Fullness sewn into seams (GarmentDraft.fullness): ease, gathers, pleats and
 * tucks, each along a seam by name, as MCP writes them. The seam names are the
 * garment's (waist, armhole, a draft seam's or drawn curve's); a name that
 * matches no seam is said on the Garment card.
 */
export function GarmentFullnessPanel({ draft, setDraft }: { draft: GarmentDraft; setDraft: (d: GarmentDraft, settle?: boolean) => void }) {
  const list = draft.fullness ?? [];
  const material = garmentSettings(draft).material;
  const setList = (next: GarmentFullness[], settle = false) => setDraft({ ...draft, fullness: next.length ? next : undefined }, settle);
  const patch = (i: number, p: Partial<GarmentFullness>, settle = true) => setList(list.map((f, j) => (j === i ? { ...f, ...p } : f)), settle);
  const seams = [...new Set(['waist', 'armhole', ...(draft.seams ?? []).map((s) => s.name), ...(draft.curves ?? []).filter((c) => c.kind === 'seam').map((c) => c.name)])];
  return (
    <div className="flex flex-col gap-2 pt-1 border-t border-slate-200/70 dark:border-slate-700/70">
      <Heading>Gathers and pleats</Heading>
      <datalist id="garment-seams">{seams.map((s) => <option key={s} value={s} />)}</datalist>
      {list.map((f, i) => (
        <div key={i} className="flex flex-col gap-1.5 p-2 rounded-md bg-white/60 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/70">
          <div className="grid grid-cols-[1fr_1fr_auto] gap-1.5 items-end">
            <label className="flex flex-col gap-1" title="The seam the fuller cloth is sewn into, by name (a seam between panels, not an edge)">
              <span className={labelCls}>Into seam</span>
              <input className={selectCls} list="garment-seams" value={f.along} onChange={(e) => patch(i, { along: e.target.value }, false)} />
            </label>
            <label className="flex flex-col gap-1" title="How the extra goes in">
              <span className={labelCls}>As</span>
              <select className={selectCls} value={f.kind ?? 'gather'} onChange={(e) => patch(i, { kind: e.target.value as GarmentFullness['kind'] }, false)}>
                {FULLNESS_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </select>
            </label>
            <button type="button" className={removeCls} title="Remove" onClick={() => setList(list.filter((_, j) => j !== i))}>×</button>
          </div>
          <FieldSlider title="Fullness" tip="Cloth along the seam over the seam's length: ease about 1.03, gathers 1.5 to 2.5, knife pleats edge to edge 3" value={f.ratio ?? defaultRatio(f.kind, material)} min={1} max={4} step={0.01} unit="×" scale={1} decimals={2} onChange={(v) => patch(i, { ratio: v })} />
          {pleated(f.kind) && (
            <>
              <FieldSlider title="Pleats per panel" tip="Pleats on each panel, evenly spaced; 0 for about one every 8 cm" value={f.count ?? 0} min={0} max={30} step={1} unit="" scale={1} onChange={(v) => patch(i, { count: v >= 1 ? Math.round(v) : undefined })} />
              <FieldSlider title="Stitched down" tip="Pleats stitched down this far from the seam (pressed pleats, release tucks); open below" value={f.stitched ?? 0} min={0} max={0.3} step={0.005} onChange={(v) => patch(i, { stitched: v > 0 ? v : undefined })} />
              <Check label="Pressed to the hem" tip="Their creases set all the way down; off, folded only as far as stitched, falling open below" checked={f.pressed !== false} onChange={(v) => patch(i, { pressed: v ? undefined : false }, false)} />
              {f.kind === 'knife' && <Check label="Facing left" tip="Which way the folds face as you look at a panel's outside (default right)" checked={f.facing === 'left'} onChange={(v) => patch(i, { facing: v ? 'left' : undefined }, false)} />}
            </>
          )}
          {f.kind === 'gather' || f.kind === undefined ? (
            <div className="grid grid-cols-2 gap-1.5">
              <FieldSlider title="From" tip="Gathered only over this stretch of each panel's seam, from its left" value={f.from ?? 0} min={0} max={1} step={0.01} unit="%" scale={100} onChange={(v) => patch(i, { from: v > 0 ? v : undefined })} />
              <FieldSlider title="To" tip="...to here" value={f.to ?? 1} min={0} max={1} step={0.01} unit="%" scale={100} onChange={(v) => patch(i, { to: v < 1 ? v : undefined })} />
            </div>
          ) : null}
          <label className="flex flex-col gap-1" title="Which side of the seam carries it: the panels below it (a skirt from a waist) or above (tucks up a bodice); unset, the sleeve at an armhole, else below">
            <span className={labelCls}>Carried by</span>
            <select className={selectCls} value={f.side ?? 'auto'} onChange={(e) => patch(i, { side: e.target.value === 'auto' ? undefined : e.target.value as 'below' | 'above' }, false)}>
              <option value="auto">Usual side</option><option value="below">Panels below</option><option value="above">Panels above</option>
            </select>
          </label>
        </div>
      ))}
      <button type="button" className={smallButtonCls} onClick={() => setList([...list, { along: 'waist', kind: 'gather', ratio: 1.5 }])} title="More cloth sewn into a seam: gathered or pleated. A dress needs a seam at the waist first (Lines).">Add gathers or pleats</button>
    </div>
  );
}
