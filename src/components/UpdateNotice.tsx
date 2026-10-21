// ---------------------------------------------------------------------------
// Saying so when this tab has outlived a deploy
// ---------------------------------------------------------------------------
//
// A deploy renames every worker and chunk, and a tab opened before it can no
// longer load them: the next export, cut or compile fails with what looks like
// a bug in that feature. `utils/staleBuild.ts` finds out when a worker dies and
// the server is serving a newer build; this says so, over whatever is open.
//
// The reload is a button, never automatic: the scene in this tab may exist
// nowhere else, and a reload throws it away.
// ---------------------------------------------------------------------------

import ReactDOM from 'react-dom';
import { RefreshCw, X } from 'lucide-react';
import { useUpdateNotice } from '../utils/staleBuild';

export function UpdateNotice() {
  const show = useUpdateNotice((s) => s.stale && !s.dismissed);
  const dismiss = useUpdateNotice((s) => s.dismiss);
  if (!show) return null;

  return ReactDOM.createPortal(
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[99999] w-[calc(100%-2rem)] max-w-md" role="alert">
      <div className="flex items-start gap-2 rounded-lg bg-amber-50/95 dark:bg-amber-950/90 border border-amber-400 dark:border-amber-700 px-3 py-2 text-[11px] leading-relaxed text-amber-900 dark:text-amber-100 shadow-lg backdrop-blur-md">
        <RefreshCw className="w-4 h-4 shrink-0 mt-0.5" />
        <span className="flex-1">
          <strong className="font-bold">Mesh has been updated.</strong> This tab is running the
          version from before, and can no longer load its tools. Save your scene, then reload.
        </span>
        <button
          onClick={() => window.location.reload()}
          className="shrink-0 px-2 py-1 rounded-md bg-amber-600 hover:bg-amber-500 text-white font-bold cursor-pointer"
        >
          Reload
        </button>
        <button onClick={dismiss} aria-label="Dismiss" className="shrink-0 p-1 rounded-md hover:bg-amber-100 dark:hover:bg-amber-900 cursor-pointer">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>,
    document.body,
  );
}
