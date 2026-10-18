import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Loader2 } from 'lucide-react';
import { ensureFontPreview, fetchFontCatalogue, type FontOption } from '../utils/fontLibrary';
import { inputClass } from './PatternFields';

/** Rows drawn at once: matching thousands of families is pointless and slow. */
const SHOWN = 60;

/**
 * A searchable picker over the whole Google Fonts catalogue, as in Etch. Each
 * row is drawn in its own face, and a family's stylesheet is only asked for
 * while its row is on screen.
 */
export const FontPicker: React.FC<{ value: string; onChange: (family: string) => void }> = ({ value, onChange }) => {
  const [fonts, setFonts] = useState<FontOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let live = true;
    fetchFontCatalogue()
      .then((f) => { if (live) setFonts(f); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => { ensureFontPreview(value); }, [value]);

  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', down);
    return () => window.removeEventListener('mousedown', down);
  }, [open]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (q ? fonts.filter((f) => f.name.toLowerCase().includes(q) || f.category.includes(q)) : fonts).slice(0, SHOWN);
  }, [fonts, query]);

  useEffect(() => {
    if (open) for (const f of matches.slice(0, 30)) ensureFontPreview(f.name);
  }, [matches, open]);

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => { setOpen((o) => !o); setQuery(''); }}
        className={`${inputClass} flex items-center justify-between gap-2 text-left cursor-pointer`}
        style={{ fontFamily: `'${value}', sans-serif` }}
        title={value}
      >
        <span className="truncate text-sm">{value || 'Choose a font'}</span>
        <span className="text-slate-400 shrink-0">▾</span>
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
          <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-slate-200 dark:border-slate-700">
            <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={loading ? 'Loading the catalogue…' : `Search ${fonts.length} fonts…`}
              className="w-full bg-transparent outline-none text-xs text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
            />
            {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400 shrink-0" />}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {matches.length === 0 && !loading && (
              <p className="px-2.5 py-3 text-xs text-slate-400 text-center">No fonts match “{query}”.</p>
            )}
            {matches.map((f) => (
              <button
                key={f.name}
                type="button"
                onClick={() => { onChange(f.name); setOpen(false); }}
                className={`w-full text-left px-2.5 py-1.5 flex items-center justify-between gap-2 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                  f.name === value ? 'bg-fuchsia-50 dark:bg-fuchsia-950/40' : ''
                }`}
              >
                <span className="truncate text-sm text-slate-800 dark:text-slate-100" style={{ fontFamily: `'${f.name}', ${f.category}` }}>
                  {f.name}
                </span>
                <span className="text-[10px] text-slate-400 shrink-0">{f.category}</span>
              </button>
            ))}
            {!loading && matches.length === SHOWN && (
              <p className="px-2.5 py-1.5 text-[10px] text-slate-400 border-t border-slate-100 dark:border-slate-800">
                The first {SHOWN} — keep typing to narrow it down.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
