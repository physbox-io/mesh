import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { normalToySize, TOY_SIZES, type ToyInventory } from '../utils/toyBricks';

const field = 'bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded px-1.5 py-0.5 text-xs text-slate-900 dark:text-white';

/**
 * The toy bricks to build with: every size sold, and any the builder adds,
 * each ticked to use and with how many they have (blank: as many as it
 * takes). A size not ticked is never used; one they have too few of is used
 * up to what they have, and the count says what it is short of.
 */
export function ToyInventoryEditor({ inventory, onChange }: { inventory: ToyInventory; onChange: (next: ToyInventory) => void }) {
  const [adding, setAdding] = useState('');
  const sizes = [...TOY_SIZES, ...Object.keys(inventory).filter((s) => !(TOY_SIZES as readonly string[]).includes(s))];
  const set = (size: string, have: number | null | undefined) => {
    const next = { ...inventory };
    if (have === undefined) delete next[size];
    else next[size] = have;
    onChange(next);
  };
  const add = () => {
    const size = normalToySize(adding);
    if (!size) return;
    set(size, inventory[size] ?? null);
    setAdding('');
  };
  return (
    <fieldset className="col-span-2 md:col-span-3 space-y-1">
      <legend className="text-[11px] text-slate-500 dark:text-slate-400" title="Tick the sizes to build with, and say how many you have of any you are short of. Blank: as many as it takes.">
        Bricks to build with (studs, and how many you have)
      </legend>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-x-3 gap-y-1">
        {sizes.map((size) => {
          const used = size in inventory;
          const custom = !(TOY_SIZES as readonly string[]).includes(size);
          return (
            <div key={size} className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" checked={used} onChange={() => set(size, used ? undefined : null)} aria-label={`Use ${size}`} />
              <span className="w-9 tabular-nums">{size.replace('x', '×')}</span>
              <input
                type="number" min={0} step={1} placeholder="any" disabled={!used}
                value={used && inventory[size] !== null ? String(inventory[size]) : ''}
                onChange={(e) => set(size, e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))))}
                className={`${field} w-12 disabled:opacity-40`}
                aria-label={`How many ${size} you have`}
              />
              {custom && (
                <button type="button" onClick={() => set(size, undefined)} title="Remove this size" className="text-slate-400 hover:text-red-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-1 pt-1">
        <input
          value={adding} onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
          placeholder="Another size, e.g. 2x12" className={`${field} w-36`} aria-label="Add a size"
        />
        <button type="button" onClick={add} disabled={!normalToySize(adding)} className="flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300 disabled:opacity-40">
          <Plus className="w-3 h-3" /> Add
        </button>
      </div>
    </fieldset>
  );
}
