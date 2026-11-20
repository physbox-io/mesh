import type { GarmentDraft, GarmentEdge } from '../../types/cloth';
import type { GarmentSettings } from '../../utils/cloth/garments';
import { edgeOf } from '../../utils/cloth/edgeProfile';
import { RangeInput } from '../RangeInput';
import { SliderValue } from '../SliderValue';
import { COLLARS, FASTENINGS, HEMS, LIMB_ENDS, NECKLINES, edgeStyle, withEdge, type ChoiceStyle, type EdgeStyle } from './garmentStyles';

const label = 'text-xs text-slate-500 dark:text-slate-400 font-medium';
const select = 'w-full text-xs border border-slate-200 dark:border-slate-700 rounded-md px-1.5 py-1 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 cursor-pointer';

/**
 * The Garment card's details: how its edges are shaped, its collar, how it
 * fastens, pockets and a belt. Each picker is a preset over the draft's own
 * data; what none of them says (an agent's custom profile) shows as Custom
 * and stays as it is until another style is picked.
 */
export function GarmentDetails({ draft, s, setDraft }: { draft: GarmentDraft; s: GarmentSettings & GarmentDraft; setDraft: (d: GarmentDraft, settle?: boolean) => void }) {
  const fromNeck = !s.over && s.top === 'neck';
  const merged = { ...draft, trims: s.trims };
  const pocketsOn = (panel: string) => (draft.pockets ?? []).some((p) => p.panel === panel);
  const togglePockets = (panel: string, at: [number, number], on: boolean) => {
    const rest = (draft.pockets ?? []).filter((p) => p.panel !== panel);
    const pockets = on ? [...rest, { panel, at }] : rest;
    setDraft({ ...draft, pockets: pockets.length ? pockets : undefined });
  };
  const belt = draft.belt ? (typeof draft.belt === 'object' ? draft.belt : {}) : null;
  return (
    <div className="flex flex-col gap-2.5 pt-1 border-t border-slate-200/70 dark:border-slate-700/70">
      <label className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Details</label>
      {fromNeck && <EdgePicker title="Neckline" along="neckline" styles={NECKLINES} draft={draft} setDraft={setDraft} />}
      {!s.over && <EdgePicker title="Hem" along="hem" styles={HEMS} draft={draft} setDraft={setDraft} max={0.6} />}
      {!s.over && s.top !== 'neck' && <EdgePicker title="Top edge" along="top" styles={HEMS} draft={draft} setDraft={setDraft} max={0.3} />}
      {fromNeck && s.sleeve > 0 && <EdgePicker title="Sleeve ends" along="cuff" styles={LIMB_ENDS} draft={draft} setDraft={setDraft} max={0.6} />}
      {s.over && !s.cap && <EdgePicker title="End" along="end" styles={LIMB_ENDS} draft={draft} setDraft={setDraft} max={0.4} />}
      {fromNeck && <ChoicePicker title="Collar" styles={COLLARS} draft={merged} setDraft={setDraft} />}
      {fromNeck && s.opening && <ChoicePicker title="Fastening" styles={FASTENINGS} draft={merged} setDraft={setDraft} />}
      {!s.over && (
        <div className="flex flex-col gap-1">
          <span className={label}>Pockets</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {([['front', 'Front', [0.6, s.legs ? 0.82 : 0.3]], ['back', 'Back', [0.5, s.legs ? 0.8 : 0.3]]] as const).map(([panel, text, at]) => (
              <label key={panel} className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer" title={`Patch pockets on the ${panel}, a pair where it is cut in two`}>
                <input type="checkbox" className="accent-purple-600" checked={pocketsOn(panel)} onChange={(e) => togglePockets(panel, [at[0], at[1]], e.target.checked)} />
                {text}
              </label>
            ))}
          </div>
        </div>
      )}
      {!s.over && (
        <div className="flex flex-col gap-1.5">
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer" title="A belt of cloth round it, drawn in so it cinches, through loops sewn on">
            <input type="checkbox" className="accent-purple-600" checked={!!belt} onChange={(e) => setDraft({ ...draft, belt: e.target.checked ? {} : undefined })} />
            Belt
          </label>
          {belt && (
            <>
              <Slider title="Cinch" tip="How tight: its length against the way round where it goes. Lower draws the garment in." value={belt.ratio ?? 0.97} min={0.8} max={1} step={0.005} unit="%" scale={100} onChange={(v) => setDraft({ ...draft, belt: { ...belt, ratio: v } }, true)} />
              <Slider title="Width" tip="Width of the strap" value={belt.width ?? 0.032} min={0.01} max={0.12} step={0.002} unit="mm" scale={1000} onChange={(v) => setDraft({ ...draft, belt: { ...belt, width: v } }, true)} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function EdgePicker({ title, along, styles, draft, setDraft, max = 0.3 }: { title: string; along: GarmentEdge['along']; styles: EdgeStyle[]; draft: GarmentDraft; setDraft: (d: GarmentDraft, settle?: boolean) => void; max?: number }) {
  const edge = edgeOf(draft, along);
  const cur = edgeStyle(styles, edge);
  const style = styles.find((st) => st.id === cur.id);
  const amount = cur.amount > 0 ? cur.amount : Math.min(max, 0.15);
  const sized = along !== 'neckline' && !!style?.profile;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1">
        <span className={label}>{title}</span>
        <select className={select} value={cur.id} title={style?.tip ?? 'Shaped by its own profile (set by an agent or over MCP)'}
          onChange={(e) => setDraft(withEdge(draft, along, styles.find((st) => st.id === e.target.value), amount))}>
          {styles.map((st) => <option key={st.id} value={st.id} title={st.tip}>{st.label}</option>)}
          {cur.id === 'custom' && <option value="custom">Custom</option>}
        </select>
      </label>
      {sized && <Slider title="Longest by" tip="How much longer it is where it is longest" value={amount} min={0.005} max={max} step={0.005} unit="mm" scale={1000} onChange={(v) => setDraft(withEdge(draft, along, style, v), true)} />}
    </div>
  );
}

function ChoicePicker({ title, styles, draft, setDraft }: { title: string; styles: ChoiceStyle[]; draft: GarmentDraft; setDraft: (d: GarmentDraft, settle?: boolean) => void }) {
  const cur = styles.find((st) => st.is(draft));
  return (
    <label className="flex flex-col gap-1">
      <span className={label}>{title}</span>
      <select className={select} value={cur?.id ?? 'custom'} title={cur?.tip ?? 'Set by an agent or over MCP'}
        onChange={(e) => { const st = styles.find((x) => x.id === e.target.value); if (st) setDraft(st.apply(draft)); }}>
        {styles.map((st) => <option key={st.id} value={st.id} title={st.tip}>{st.label}</option>)}
        {!cur && <option value="custom">Custom</option>}
      </select>
    </label>
  );
}

function Slider({ title, tip, value, min, max, step, unit, scale, onChange }: { title: string; tip: string; value: number; min: number; max: number; step: number; unit: string; scale: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1" title={tip}>
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs text-slate-500 dark:text-slate-400 font-medium truncate">{title}</span>
        <SliderValue value={value} onChange={onChange} decimals={0} unit={unit} scale={scale} min={min} max={max} className="text-xs text-slate-500 dark:text-slate-400" />
      </div>
      <RangeInput min={min} max={max} step={step} value={value} onChange={onChange} className="w-full cursor-pointer accent-purple-600" />
    </div>
  );
}
