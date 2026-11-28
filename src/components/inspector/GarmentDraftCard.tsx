import { useState } from 'react';
import { RangeInput } from '../RangeInput';
import { SliderValue } from '../SliderValue';
import { SettledColorInput } from '../SettledInputs';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import type { GarmentDraft, GarmentKind } from '../../types/cloth';
import { garmentSettings } from '../../utils/cloth/garments';
import { changeGarmentKind } from '../../utils/cloth/garmentKindChange';
import { ClothWarnings } from './ClothWarnings';
import { DRAFT_SLIDERS, DRAFT_SWITCHES, FABRICS, GARMENT_KINDS, LIMBS, sleevesApart, type DraftUnit } from './garmentFields';

const SCALE: Record<DraftUnit, number> = { mm: 1000, '%': 100, '×': 1, '': 1 };
const DECIMALS: Record<DraftUnit, number> = { mm: 0, '%': 0, '×': 2, '': 0 };
const hex = (rgba: number[]) => `#${rgba.slice(0, 3).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
const rgbaOf = (h: string, a: number) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).concat(a);

/**
 * A garment's draft, the common settings: what it is, its fabric and colour,
 * the layer it is worn as, and the lengths and switches its kind uses. Each
 * control writes the draft field MCP writes; unset fields show the kind's
 * default. Changing the kind keeps everything in the draft that still applies.
 */
export function GarmentDraftCard({ node }: { node: SceneNode }) {
  const updateNode = useStore((s) => s.updateNode);
  const [dropped, setDropped] = useState<{ id: string; kind: GarmentKind; list: string[] } | null>(null);
  const cloth = node.cloth, draft = cloth?.garment;
  if (!cloth || !draft) return null;
  const s = garmentSettings(draft);
  const setDraft = (next: GarmentDraft, settle = false) => updateNode(node.id, { cloth: { ...cloth, garment: next } } as Partial<SceneNode>, false, settle);
  const set = <K extends keyof GarmentDraft>(key: K, value: GarmentDraft[K], settle = false) => setDraft({ ...draft, [key]: value }, settle);
  // One edit, so one undo step; what has nothing to apply to on the new kind is said under the picker.
  const setKind = (kind: GarmentKind) => {
    const change = changeGarmentKind(draft, kind);
    setDropped({ id: node.id, kind, list: change.dropped });
    setDraft(change.draft);
  };
  const droppedNow = dropped && dropped.id === node.id && dropped.kind === draft.garment && dropped.list.length ? dropped.list : null;
  const top = s.top ?? 'neck';
  const label = 'text-xs text-slate-500 dark:text-slate-400 font-medium';
  const select = 'w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md px-1.5 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 cursor-pointer';
  return (
    <div className="flex flex-col gap-2.5 p-3 bg-slate-50 dark:bg-slate-900/40 border border-slate-200/60 dark:border-slate-800 rounded-lg">
      <label className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Garment</label>
      <ClothWarnings name={node.name || node.id} />
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1" title="What it is: that kind's settings under everything in this draft that still applies">
          <span className={label}>Kind</span>
          <select className={select} value={draft.garment} onChange={(e) => setKind(e.target.value as GarmentKind)}>
            {GARMENT_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1" title="The cloth: how it stretches, bends, drapes and shines">
          <span className={label}>Fabric</span>
          <select className={select} value={s.material} onChange={(e) => set('material', e.target.value as GarmentDraft['material'])}>
            {FABRICS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label className="flex items-center justify-between gap-2" title="Colour of the cloth">
          <span className={label}>Colour</span>
          <SettledColorInput value={hex(s.rgba)} onChange={(h) => set('rgba', rgbaOf(h, s.rgba[3] ?? 1), true)} className="w-8 h-6 border border-slate-200 dark:border-slate-700 rounded cursor-pointer bg-white dark:bg-slate-900" />
        </label>
        <label className="flex items-center justify-between gap-2" title="Worn over every garment of a lower layer: 0 next to the body, 1 over that, ...">
          <span className={label}>Layer</span>
          <SliderValue value={cloth.layer ?? 0} onChange={(v) => updateNode(node.id, { cloth: { ...cloth, layer: Math.max(0, Math.round(v)) } } as Partial<SceneNode>, false, true)} decimals={0} min={0} max={6} className="text-xs text-slate-500 dark:text-slate-400" />
        </label>
      </div>
      {droppedNow && (
        <div role="status" className="flex items-start gap-2 text-[11px] leading-snug text-slate-600 dark:text-slate-300 p-2 rounded-md bg-slate-100 dark:bg-slate-800/60">
          <span className="flex-1">Kept the rest of the draft. Left out: {droppedNow.join('; ')}. Undo brings them back.</span>
          <button type="button" onClick={() => setDropped(null)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer" aria-label="Dismiss">×</button>
        </div>
      )}
      {s.over ? (
        <label className="flex flex-col gap-1" title="The limb it goes round">
          <span className={label}>Over</span>
          <select className={select} value={s.over} onChange={(e) => set('over', e.target.value as GarmentDraft['over'])}>
            {LIMBS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        </label>
      ) : (
        <div className="flex flex-col gap-1" title="Where it starts: at the neck with a neckline, at a waistband, or a band at a height (strapless, hip-slung)">
          <span className={label}>Starts</span>
          <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px] font-semibold">
            {([['neck', 'Neck'], ['waist', 'Waist'], ['band', 'Band']] as const).map(([id, text]) => {
              const on = id === 'band' ? typeof top === 'number' : top === id;
              return (
                <button key={id} onClick={() => set('top', id === 'band' ? (typeof top === 'number' ? top : 1.25) : id)}
                  className={`flex-1 py-1 transition-colors cursor-pointer ${on ? 'bg-purple-600 text-white' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{text}</button>
              );
            })}
          </div>
          {typeof top === 'number' && <DraftSlider label="Band height" tip="Height of the band above the floor" value={top} min={0.5} max={1.7} step={0.005} unit="mm" onChange={(v) => set('top', v, true)} />}
        </div>
      )}
      {DRAFT_SLIDERS.filter((f) => f.shows(s)).map((f) => (
        <DraftSlider key={f.key} label={f.label} tip={f.tip} value={(s[f.key] as number | undefined) ?? f.unset?.(s) ?? 0} min={f.min} max={f.max} step={f.step} unit={f.unit}
          onChange={(v) => set(f.key, (f.unit === '' ? Math.round(v) : v) as never, true)} />
      ))}
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {DRAFT_SWITCHES.filter((f) => f.shows(s)).map((f) => (
          <label key={f.key} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer" title={f.tip}>
            <input type="checkbox" className="accent-purple-600" checked={!!s[f.key]} onChange={(e) => set(f.key, e.target.checked)} />
            {f.label}
          </label>
        ))}
        {!s.over && s.top === 'neck' && (
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer" title="Each sleeve its own length, 0 for none on that side (one-shoulder, asymmetric); off, both the Sleeve length">
            <input type="checkbox" className="accent-purple-600" checked={sleevesApart(s)}
              onChange={(e) => setDraft(e.target.checked
                ? { ...draft, sleeveL: s.sleeve, sleeveR: s.sleeve }
                : { ...draft, sleeve: Math.max(s.sleeveL ?? s.sleeve, s.sleeveR ?? s.sleeve), sleeveL: undefined, sleeveR: undefined })} />
            Each sleeve
          </label>
        )}
      </div>
    </div>
  );
}

function DraftSlider({ label, tip, value, min, max, step, unit, onChange }: { label: string; tip: string; value: number; min: number; max: number; step: number; unit: DraftUnit; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1" title={tip}>
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">{label}</span>
        <SliderValue value={value} onChange={onChange} decimals={DECIMALS[unit]} unit={unit || undefined} scale={SCALE[unit]} min={min} max={max} className="text-xs text-slate-500 dark:text-slate-400" />
      </div>
      <RangeInput min={min} max={max} step={step} value={value} onChange={onChange} className="w-full cursor-pointer accent-purple-600" />
    </div>
  );
}
