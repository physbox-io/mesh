import { useEffect } from 'react';
import type { GarmentDraft } from '../../types/cloth';
import { useGarmentSculpt } from '../../store/garmentSculptStore';
import { RangeInput } from '../RangeInput';
import { SliderValue } from '../SliderValue';

const label = 'text-xs text-slate-500 dark:text-slate-400 font-medium';

/**
 * The garment's silhouette, sculpted with a brush on the garment itself:
 * strokes push the cloth further off the body or draw it in, any shape.
 * Each stroke is saved as dabs in the draft's `sculpt` (as MCP writes them)
 * and the garment is cut again to what it makes.
 */
export function GarmentSculptPanel({ nodeId, draft, setDraft }: { nodeId: string; draft: GarmentDraft; setDraft: (d: GarmentDraft, settle?: boolean) => void }) {
  const brush = useGarmentSculpt();
  const on = brush.target === nodeId && brush.tool === 'sculpt';
  // Off when the garment is no longer the one shown.
  useEffect(() => () => { if (useGarmentSculpt.getState().target === nodeId) useGarmentSculpt.getState().set({ target: null }); }, [nodeId]);
  const dabs = draft.sculpt?.length ?? 0;
  const seg = (active: boolean) => `flex-1 py-1 transition-colors cursor-pointer ${active ? 'bg-purple-600 text-white' : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'}`;
  return (
    <div className="flex flex-col gap-1.5 pt-1 border-t border-slate-200/70 dark:border-slate-700/70">
      <label className="text-[10px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Silhouette</label>
      <button onClick={() => brush.set({ target: on ? null : nodeId, tool: 'sculpt' })}
        title="Drag on the garment with the left mouse button to sculpt its shape; Shift draws in. Each stroke cuts the garment again."
        className={`w-full text-xs font-semibold py-1.5 rounded-md border transition-colors cursor-pointer ${on ? 'bg-purple-600 border-purple-600 text-white' : 'bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'}`}>
        {on ? 'Sculpting: drag on the garment' : 'Sculpt on the garment'}
      </button>
      {on && (
        <>
          <div className="flex rounded-lg border border-slate-200 dark:border-slate-700 overflow-hidden text-[11px] font-semibold" title="Push the cloth out from the body, or draw it in (hold Shift for the other)">
            <button className={seg(!brush.pull)} onClick={() => brush.set({ pull: false })}>Push out</button>
            <button className={seg(brush.pull)} onClick={() => brush.set({ pull: true })}>Draw in</button>
          </div>
          <Slider title="Size" tip="Radius of the brush" value={brush.radius} min={0.02} max={0.3} step={0.005} onChange={(v) => brush.set({ radius: v })} />
          <Slider title="Amount" tip="How far one stroke moves the cloth" value={brush.strength} min={0.005} max={0.12} step={0.001} onChange={(v) => brush.set({ strength: v })} />
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer" title="Each stroke on both sides, mirrored across the centre">
            <input type="checkbox" className="accent-purple-600" checked={brush.mirror} onChange={(e) => brush.set({ mirror: e.target.checked })} />
            Both sides
          </label>
        </>
      )}
      {dabs > 0 && (
        <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400">
          <span>{dabs} dab{dabs === 1 ? '' : 's'} sculpted</span>
          <button className="text-purple-700 dark:text-purple-400 hover:underline cursor-pointer" title="Take away all the sculpting: back to the plain draft" onClick={() => setDraft({ ...draft, sculpt: undefined })}>Clear</button>
        </div>
      )}
    </div>
  );
}

function Slider({ title, tip, value, min, max, step, onChange }: { title: string; tip: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-col gap-1" title={tip}>
      <div className="flex items-center justify-between gap-1">
        <span className={label}>{title}</span>
        <SliderValue value={value} onChange={onChange} decimals={0} unit="mm" scale={1000} min={min} max={max} className="text-xs text-slate-500 dark:text-slate-400" />
      </div>
      <RangeInput min={min} max={max} step={step} value={value} onChange={onChange} className="w-full cursor-pointer accent-purple-600" />
    </div>
  );
}
