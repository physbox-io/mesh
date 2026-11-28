import type { GarmentCollar, GarmentDraft, GarmentLapels } from '../../../types/cloth';
import { COLLAR_DEFAULTS, LAPEL_DEFAULTS } from '../../../utils/cloth/garmentCollars';
import { Check, FieldSlider } from './garmentUi';

/**
 * A collar's and lapels' own numbers, under the Collar picker: the same
 * fields MCP writes, with the same defaults (COLLAR_DEFAULTS, LAPEL_DEFAULTS).
 * A picked style is only a start; anything set here keeps the rest.
 */
export function GarmentCollarFields({ draft, setDraft }: { draft: GarmentDraft; setDraft: (d: GarmentDraft, settle?: boolean) => void }) {
  const c = draft.collar, l = draft.lapels;
  if (!c && !l) return null;
  const setC = (patch: Partial<GarmentCollar>, settle = true) => setDraft({ ...draft, collar: { ...c, ...patch } }, settle);
  const setL = (patch: Partial<GarmentLapels>, settle = true) => setDraft({ ...draft, lapels: { ...l, ...patch } }, settle);
  const set = <T extends object>(o: T | undefined) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null)) as Partial<T>;
  const cv = { ...COLLAR_DEFAULTS, ...set(c) }, lv = { ...LAPEL_DEFAULTS, ...set(l) };
  return (
    <div className="flex flex-col gap-2 pl-2 border-l-2 border-slate-200 dark:border-slate-700">
      {c && (
        <>
          <FieldSlider title="Stand" tip="Up the neck from the neckline to the fold (roll line); 0 lies flat from the seam" value={cv.stand} min={0} max={0.08} step={0.001} onChange={(v) => setC({ stand: v })} />
          <FieldSlider title="Stand at front" tip="The stand at the collar's front ends, easing to it from the centre back" value={c.standFront ?? cv.stand} min={0} max={0.08} step={0.001} onChange={(v) => setC({ standFront: v })} />
          <FieldSlider title="Fall" tip="From the fold over and down onto the garment; 0 for a band collar" value={cv.fall} min={0} max={0.15} step={0.001} onChange={(v) => setC({ fall: v })} />
          <FieldSlider title="Point" tip="How far the fall's front corners reach past the ends of the neckline; negative holds them back (a spread collar)" value={cv.point} min={-0.05} max={0.06} step={0.001} onChange={(v) => setC({ point: v })} />
          <FieldSlider title="Corner round" tip="Radius the fall's front corners are rounded to; 0 square" value={cv.round} min={0} max={0.08} step={0.001} onChange={(v) => setC({ round: v })} />
          <Check label="Separate stand" tip="The stand cut as a piece of its own, sewn to the fall along the roll line (a shirt's collar band)" checked={cv.separateStand} onChange={(v) => setC({ separateStand: v }, false)} />
        </>
      )}
      {l && (
        <>
          <FieldSlider title="Lapel break" tip="Where the lapel starts to turn back, below the neck point" value={lv.break} min={0.05} max={0.5} step={0.005} onChange={(v) => setL({ break: v })} />
          <FieldSlider title="Lapel width" tip="Across the lapel at its top, from the roll line to its point" value={lv.width} min={0.02} max={0.16} step={0.001} onChange={(v) => setL({ width: v })} />
          <FieldSlider title="Peak" tip="How far the lapel's point stands above square to the roll line: about 0 notched, more a peak lapel" value={lv.peak} min={-0.02} max={0.06} step={0.001} onChange={(v) => setL({ peak: v })} />
          <FieldSlider title="Notch" tip="How much of the lapel's top edge stands free of the collar; the rest is sewn to it" value={lv.notch} min={0} max={0.08} step={0.001} onChange={(v) => setL({ notch: v })} />
          <FieldSlider title="Roll line at" tip="Where the roll line meets the neckline, out from the centre front to the neck's side" value={lv.rollAt} min={0.3} max={1} step={0.01} unit="%" scale={100} onChange={(v) => setL({ rollAt: v })} />
          <Check label="Shawl" tip="The lapels run on round the back of the neck, cut in one with the fronts" checked={lv.shawl} onChange={(v) => setL({ shawl: v }, false)} />
        </>
      )}
    </div>
  );
}
