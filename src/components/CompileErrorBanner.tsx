// ---------------------------------------------------------------------------
// Saying so when MuJoCo would not load the scene
// ---------------------------------------------------------------------------
//
// A rejected model is not a rejected edit. The document keeps the change —
// deliberately, so the panel still shows what was typed (see the `recompile`
// failure path) — while the worker goes on simulating and drawing the last
// model that DID load. Everything downstream then disagrees quietly: the
// viewport draws bodies from a model that no longer matches the document, the
// gizmo moves a body the renderer will not move, and a joint that was just
// changed does nothing at all.
//
// None of that looks like a load failure from the outside; it looks like the
// feature you just used is broken. A free joint set on a nested body — which
// MuJoCo refuses outright, "free joint can only be used on top level" — cost
// an afternoon being chased as a gizmo bug before this existed.
//
// So: not dismissible, because the mismatch does not go away by being
// acknowledged, and nothing else on screen would hint at it. It clears itself
// the moment a model loads, which is what `lastCompileError: null` on every
// success path means.
// ---------------------------------------------------------------------------

import { AlertTriangle } from 'lucide-react';
import { useStore } from '../store/useStore';

export function CompileErrorBanner() {
  const error = useStore((s) => s.lastCompileError);
  if (!error) return null;

  return (
    <div className="pointer-events-auto max-w-lg flex items-start gap-2 rounded-lg bg-red-50/95 dark:bg-red-950/90 border border-red-400 dark:border-red-700 px-3 py-2 text-[11px] leading-relaxed text-red-800 dark:text-red-200 shadow-lg backdrop-blur-md">
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <span>
        <strong className="font-bold">This scene would not load.</strong> The change is still in the
        document, but the simulation is running the last version that loaded — so what you see and
        what you edit no longer agree, and bodies will not respond until it builds. Undo, or put
        right what is named below.
        <span className="block mt-1 font-mono text-[10px] opacity-90 break-words">{error}</span>
      </span>
    </div>
  );
}
