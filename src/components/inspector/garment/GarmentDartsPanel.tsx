import type { BodyHeight, GarmentDart, GarmentDraft, GarmentPoint } from '../../../types/cloth';
import { Check, FieldSlider, Heading } from './garmentUi';
import { labelCls, removeCls, selectCls, smallButtonCls } from './garmentStyle';

const HEIGHTS: BodyHeight[] = ['hps', 'shoulder', 'bust', 'waist', 'hip', 'crotch'];
const DIRECTIONS: { id: string; label: string; v: number[] }[] = [
  { id: 'down', label: 'Down', v: [0, 0, -1] }, { id: 'up', label: 'Up', v: [0, 0, 1] },
  { id: 'side', label: 'To the side', v: [1, 0, 0] }, { id: 'centre', label: 'To the centre', v: [-1, 0, 0] },
];
const LANDMARKS = ['bustPoint', 'shoulderPoint', 'armOrigin'] as const;
const dirId = (v?: number[]) => DIRECTIONS.find((d) => v && d.v.every((c, i) => Math.abs(c - (v[i] ?? 0)) < 1e-9))?.id ?? 'custom';

/**
 * The draft's own darts (GarmentDraft.darts), each where it points from and
 * to, as MCP writes them; and whether the bodice gets the plan's bust and
 * waist darts as well. A point given another way (on a limb, a raw point) is
 * kept as it is and shown as such.
 */
export function GarmentDartsPanel({ draft, setDraft }: { draft: GarmentDraft; setDraft: (d: GarmentDraft, settle?: boolean) => void }) {
  const own = Array.isArray(draft.darts) ? draft.darts : [];
  const setOwn = (list: GarmentDart[], settle = false) => setDraft({ ...draft, darts: list.length ? list : undefined }, settle);
  const patch = (i: number, p: Partial<GarmentDart>, settle = true) => setOwn(own.map((d, j) => (j === i ? { ...d, ...p } : d)), settle);
  const add = () => {
    const taken = new Set(own.map((d) => d.name));
    let n = own.length + 1;
    while (taken.has(`dart${n}`)) n++;
    setOwn([...own, { name: `dart${n}`, apex: { z: 'waist', dz: 0.06, x: 0.09 }, direction: [0, 0, -1], length: 0.12, mirror: true }]);
  };
  return (
    <div className="flex flex-col gap-2 pt-1 border-t border-slate-200/70 dark:border-slate-700/70">
      <Heading>Darts</Heading>
      <Check label="Bust and waist darts where needed" tip="The bodice's own darts, where its fit and fabric need them; off, its seams shape it instead (princess lines). Always on alongside darts of your own."
        checked={draft.darts !== false} disabled={own.length > 0} onChange={(v) => setDraft({ ...draft, darts: v ? undefined : false })} />
      {own.map((d, i) => <DartRow key={i} dart={d} onPatch={(p, settle) => patch(i, p, settle)} onRemove={() => setOwn(own.filter((_, j) => j !== i))} />)}
      <button type="button" className={smallButtonCls} onClick={add} title="A dart of your own: a pair at the waist pointing down to begin with; set where it is and which way it runs">Add dart</button>
    </div>
  );
}

function DartRow({ dart, onPatch, onRemove }: { dart: GarmentDart; onPatch: (p: Partial<GarmentDart>, settle?: boolean) => void; onRemove: () => void }) {
  const a = dart.apex as GarmentPoint;
  const atHeight = !Array.isArray(a) && 'z' in a ? a : null;
  const atLandmark = !Array.isArray(a) && 'landmark' in a ? a : null;
  const dir = dirId(dart.direction);
  return (
    <div className="flex flex-col gap-1.5 p-2 rounded-md bg-white/60 dark:bg-slate-800/40 border border-slate-200/70 dark:border-slate-700/70">
      <div className="flex items-center gap-1.5">
        <input className={`${selectCls} flex-1`} value={dart.name} title="Its name, as a garment line (a trim or rod can run along it)" onChange={(e) => onPatch({ name: e.target.value }, false)} />
        <button type="button" className={removeCls} title="Remove this dart" onClick={onRemove}>×</button>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex flex-col gap-1" title="Where its point is: at a height on the body, or at a landmark of the form">
          <span className={labelCls}>Point at</span>
          <select className={selectCls} value={atHeight && typeof atHeight.z !== 'number' ? `z:${atHeight.z}` : atLandmark ? `l:${atLandmark.landmark}` : 'custom'}
            onChange={(e) => { const [k, v] = e.target.value.split(':'); onPatch({ apex: k === 'z' ? { z: v as BodyHeight, dz: atHeight?.dz, x: atHeight?.x ?? 0.09, back: atHeight?.back } : { landmark: v as (typeof LANDMARKS)[number] } }, false); }}>
            {HEIGHTS.map((h) => <option key={h} value={`z:${h}`}>{h === 'hps' ? 'Neck point height' : `${h[0].toUpperCase()}${h.slice(1)} height`}</option>)}
            {LANDMARKS.map((l) => <option key={l} value={`l:${l}`}>{l === 'bustPoint' ? 'Bust point' : l === 'shoulderPoint' ? 'Shoulder point' : 'Arm root'}</option>)}
            {((atHeight && typeof atHeight.z === 'number') || (!atHeight && !atLandmark)) && <option value="custom">Custom point</option>}
          </select>
        </label>
        <label className="flex flex-col gap-1" title="Which way it runs from its point toward its open end">
          <span className={labelCls}>Runs</span>
          <select className={selectCls} value={dir} onChange={(e) => onPatch({ direction: DIRECTIONS.find((d) => d.id === e.target.value)?.v, to: undefined }, false)}>
            {DIRECTIONS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            {dir === 'custom' && <option value="custom">{dart.to ? 'Toward a point' : 'Custom'}</option>}
          </select>
        </label>
      </div>
      {atHeight && (
        <>
          <FieldSlider title="Across from centre" tip="How far across from the centre, either side when mirrored" value={atHeight.x ?? 0} min={0} max={0.25} step={0.002} onChange={(v) => onPatch({ apex: { ...atHeight, x: v } })} />
          <FieldSlider title="Above that height" tip="Raised (or lowered, below zero) from the named height" value={atHeight.dz ?? 0} min={-0.2} max={0.2} step={0.002} onChange={(v) => onPatch({ apex: { ...atHeight, dz: v } })} />
          <Check label="On the back" tip="On the back of the body instead of the front" checked={!!atHeight.back} onChange={(v) => onPatch({ apex: { ...atHeight, back: v } }, false)} />
        </>
      )}
      <FieldSlider title="Length" tip="How far it runs from its point; 0 runs on until it meets a seam or an edge (single-ended, open there)" value={dart.length ?? 0} min={0} max={0.4} step={0.005} onChange={(v) => onPatch({ length: v > 0 ? v : undefined })} />
      <FieldSlider title="Other end" tip="Double-ended (a fish-eye inside a panel): it also runs this far back the other way; 0 for single-ended" value={dart.back ?? 0} min={0} max={0.3} step={0.005} onChange={(v) => onPatch({ back: v > 0 ? v : undefined })} />
      <Check label="Pair, left and right" tip="Also its mirror image across the body's centre" checked={!!dart.mirror} onChange={(v) => onPatch({ mirror: v }, false)} />
    </div>
  );
}
