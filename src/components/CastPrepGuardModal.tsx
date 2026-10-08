// ---------------------------------------------------------------------------
// Turning an edit away while draft is baked in
// ---------------------------------------------------------------------------
//
// With Prepare for Casting on, the drafted shapes in the scene are not the
// model: the originals are kept to one side so switching prep off can put
// them back. An edit now would land on the drafted shape and have nothing to
// go back to, so the store turns it away (see the guard in useStore) and this
// opens to say why and to offer the two ways out. The edit itself is not
// replayed after either: it was worked out against a shape that is about to
// change.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Flame } from 'lucide-react';
import { useStore } from '../store/useStore';

export function CastPrepGuardModal() {
  const open = useStore((s) => s.castPrepGuardOpen);
  const deg = useStore((s) => s.sceneGraph.castPrep?.draftDeg ?? 0);
  const close = useStore((s) => s.closeCastPrepGuard);
  const clearCastPrep = useStore((s) => s.clearCastPrep);
  const bakeCastPrep = useStore((s) => s.bakeCastPrep);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(); setDone(null); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, close]);

  if (!open && !done) return null;

  const dismiss = () => { close(); setDone(null); };

  // Portalled: it is mounted from the bottom bar, whose stacking context would
  // otherwise hold it under the rest of the app.
  return createPortal(
    <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4 font-sans" onClick={dismiss}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="The scene is prepared for casting"
        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-2xl max-w-md w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-orange-100 dark:bg-orange-950 flex items-center justify-center text-orange-600 shrink-0">
            <Flame className="w-5 h-5" />
          </div>
          <h2 className="font-bold text-slate-800 dark:text-slate-100 text-base">
            {done ? 'Now make your change again' : 'The scene is prepared for casting'}
          </h2>
        </div>
        <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed whitespace-normal">
          {done ?? `${deg}° of draft is baked into every part for sand casting. Editing now would edit the drafted shapes, and switching prep off would have nothing to put back — so that edit was not made.`}
        </div>
        <div className="flex flex-wrap justify-end gap-2 text-xs">
          {done ? (
            <button onClick={dismiss} className="px-4 py-2 font-semibold text-white bg-blue-500 hover:bg-blue-600 rounded-lg transition-colors cursor-pointer">
              OK
            </button>
          ) : (
            <>
              <button onClick={dismiss} className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors font-semibold cursor-pointer">
                Cancel
              </button>
              <button
                onClick={() => {
                  const { kept } = clearCastPrep();
                  setDone(kept.length > 0
                    ? `The original shapes are back, except ${kept.map((k) => k.name).join(', ')}. Make your change again.`
                    : 'The original shapes are back, and editable. Make your change again, then turn prep on in Cast.');
                }}
                className="px-4 py-2 font-semibold text-orange-700 dark:text-orange-300 hover:bg-orange-500/10 rounded-lg transition-colors cursor-pointer"
              >
                Leave Casting Prep
              </button>
              <button
                onClick={() => {
                  bakeCastPrep();
                  setDone('The drafted shapes are the model now. Make your change again — to them.');
                }}
                className="px-4 py-2 font-semibold text-white bg-orange-500 hover:bg-orange-600 rounded-lg transition-colors cursor-pointer"
              >
                Bake It In
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
