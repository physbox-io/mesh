import { formatSceneDate, type ExampleEntry } from '../../utils/sceneCatalog';
import type { PatternSpec } from '../../utils/surfacePatterns';
import type { StockSize } from '../../utils/stockSettings';
import { PatternThumb } from './PatternThumb';
import { SceneThumb } from './SceneThumb';

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 mt-5 mb-2 first:mt-0">
      {children}
    </h3>
  );
}

const GRID = 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2';

/** A shelf of built-in examples. */
export function ExampleGrid({ entries, activeId, onOpen }: {
  entries: ExampleEntry[];
  activeId: string | null;
  onOpen: (id: string) => void;
}) {
  return (
    <div className={GRID}>
      {entries.map((e) => (
        <button
          key={e.id}
          onClick={() => onOpen(e.id)}
          className={`flex items-center gap-2.5 p-2.5 rounded-lg border text-left cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md ${
            e.id === activeId
              ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-700'
              : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700'
          }`}
          title={e.id === activeId ? 'Open now. Click to start it again.' : `Open ${e.name}`}
        >
          <span className="text-2xl leading-none shrink-0" aria-hidden>{e.emoji}</span>
          <span className="text-xs font-medium text-slate-700 dark:text-slate-200 leading-snug line-clamp-2">{e.name}</span>
        </button>
      ))}
    </div>
  );
}

/** Pattern generators, each with a thumbnail of its default board on the current stock. */
export function PatternGrid({ specs, stock, onPick }: {
  specs: PatternSpec[];
  stock: StockSize;
  onPick: (id: string) => void;
}) {
  return (
    <div className={GRID}>
      {specs.map((p) => (
        <button
          key={p.id}
          onClick={() => onPick(p.id)}
          className="flex flex-col gap-1.5 p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-left cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-700"
          title={p.blurb}
        >
          <PatternThumb spec={p} stock={stock} />
          <span className="px-1 text-xs font-medium text-slate-700 dark:text-slate-200">{p.label}</span>
          <span className="px-1 pb-0.5 text-[10px] leading-snug text-slate-400 dark:text-slate-500 line-clamp-2">{p.blurb}</span>
        </button>
      ))}
    </div>
  );
}

/** One thing opened lately, resolved to what it is. */
export type RecentItem =
  | { kind: 'saved'; id: string; name: string; thumbnail: string | null; at: number }
  | { kind: 'example'; id: string; entry: ExampleEntry; at: number }
  | { kind: 'pattern'; id: string; spec: PatternSpec; at: number };

/** The recents, as picture cards: a saved scene's last save, an example's emoji, a pattern's board. */
export function RecentGrid({ items, stock, activeId, onOpen }: {
  items: RecentItem[];
  stock: StockSize;
  activeId: string | null;
  onOpen: (item: RecentItem) => void;
}) {
  return (
    <div className={GRID}>
      {items.map((item) => {
        const label = item.kind === 'saved' ? item.name : item.kind === 'example' ? item.entry.name : item.spec.label;
        const kind = item.kind === 'saved' ? 'Saved scene' : item.kind === 'example' ? 'Example' : 'Pattern board';
        return (
          <button
            key={item.id}
            onClick={() => onOpen(item)}
            className={`flex flex-col gap-1.5 p-1.5 rounded-lg border text-left cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-md ${
              item.id === activeId
                ? 'border-blue-400 bg-blue-50 dark:bg-blue-950/30 dark:border-blue-700'
                : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-700'
            }`}
            title={`Open ${label}`}
          >
            {item.kind === 'pattern' ? (
              <PatternThumb spec={item.spec} stock={stock} />
            ) : item.kind === 'saved' ? (
              <SceneThumb url={item.thumbnail} className="aspect-[4/3] w-full rounded-md" fallback={<span className="text-3xl" aria-hidden>💾</span>} />
            ) : (
              <div className="aspect-[4/3] w-full rounded-md bg-slate-100 dark:bg-slate-800 flex items-center justify-center text-4xl" aria-hidden>
                {item.entry.emoji}
              </div>
            )}
            <span className="px-1 text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{label}</span>
            <span className="px-1 pb-0.5 text-[10px] text-slate-400 dark:text-slate-500">
              {kind} · {formatSceneDate(item.at)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
