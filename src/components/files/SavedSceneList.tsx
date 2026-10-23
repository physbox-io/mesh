import { useState } from 'react';
import { Cloud, HardDrive, Pencil, Copy, Trash2, Check, X } from 'lucide-react';
import { formatBytes } from '../../utils/presetStorage';
import { formatSceneDate } from '../../utils/sceneCatalog';
import { SceneThumb } from './SceneThumb';

export interface SavedScene {
  name: string;
  /** Held only by the account, not by this browser. */
  cloudOnly: boolean;
  /** Bytes in this browser; unknown for a scene only the account holds. */
  bytes: number | null;
  /** When it was last saved; null for scenes saved before that was kept. */
  savedAt: number | null;
  /** Its picture from the last save; null for one saved before they were kept, or not yet fetched from the account. */
  thumbnail: string | null;
}

/**
 * The user's saved scenes as rows: click to open, and rename, copy or delete
 * from the buttons that show on hover (always, on a touch screen).
 */
export function SavedSceneList({
  scenes, activeName, onOpen, onRename, onDuplicate, onDelete,
}: {
  scenes: SavedScene[];
  activeName: string | null;
  onOpen: (name: string) => void;
  onRename: (from: string, to: string) => Promise<boolean>;
  onDuplicate: (name: string) => void;
  onDelete: (name: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const commitRename = async () => {
    if (!renaming) return;
    if (await onRename(renaming, draft)) setRenaming(null);
  };

  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800 rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden">
      {scenes.map((s) => {
        const active = s.name === activeName;
        const editing = renaming === s.name;
        return (
          <li
            key={s.name}
            className={`group flex items-center gap-3 px-3 py-2 ${active ? 'bg-blue-50 dark:bg-blue-950/30' : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'}`}
          >
            <SceneThumb
              url={s.thumbnail}
              className="w-16 h-12 rounded shrink-0"
              fallback={s.cloudOnly ? <Cloud className="w-4 h-4 text-sky-500" /> : <HardDrive className="w-4 h-4 text-slate-400" />}
            />

            {editing ? (
              <form
                className="flex-1 flex items-center gap-1 min-w-0"
                onSubmit={(e) => { e.preventDefault(); void commitRename(); }}
              >
                <input
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setRenaming(null); } }}
                  className="flex-1 min-w-0 text-sm px-2 py-1 rounded border border-blue-400 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-100 outline-none"
                  aria-label="New name"
                />
                <button type="submit" className="p-1 rounded text-emerald-600 hover:bg-emerald-50 dark:hover:bg-emerald-950/40 cursor-pointer" title="Rename">
                  <Check className="w-4 h-4" />
                </button>
                <button type="button" onClick={() => setRenaming(null)} className="p-1 rounded text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer" title="Cancel">
                  <X className="w-4 h-4" />
                </button>
              </form>
            ) : (
              <button
                onClick={() => onOpen(s.name)}
                onDoubleClick={() => onOpen(s.name)}
                className="flex-1 min-w-0 text-left cursor-pointer"
                title={active ? 'Open now. Click to reload the saved copy.' : `Open “${s.name}”`}
              >
                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{s.name}</span>
                <span className="flex items-center gap-1 text-[10px] text-slate-400">
                  {s.cloudOnly
                    ? <Cloud className="w-3 h-3 text-sky-500" aria-label="In your account" />
                    : <HardDrive className="w-3 h-3" aria-label="In this browser" />}
                  {[
                    active ? 'Open now' : null,
                    s.savedAt != null ? formatSceneDate(s.savedAt) : null,
                    s.cloudOnly ? 'In your account' : s.bytes != null ? formatBytes(s.bytes) : null,
                  ].filter(Boolean).join(' · ')}
                </span>
              </button>
            )}

            {!editing && (
              <div className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100 transition-opacity">
                <button
                  onClick={() => { setRenaming(s.name); setDraft(s.name); }}
                  className="p-1.5 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                  title="Rename"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onDuplicate(s.name)}
                  className="p-1.5 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer"
                  title="Make a copy"
                >
                  <Copy className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => onDelete(s.name)}
                  className="p-1.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 cursor-pointer"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
