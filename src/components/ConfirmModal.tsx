// ---------------------------------------------------------------------------
// Asking before something structural happens
// ---------------------------------------------------------------------------
//
// `window.confirm` blocks the whole tab, looks like nothing else in the app,
// and on some browsers is suppressed outright after the first one — which
// turns a question into a silent yes. This is the same question, drawn the way
// the rest of the dialogs are, and it says what will happen rather than
// whether to proceed.
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

export function ConfirmModal({
  title,
  body,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  hideCancel = false,
  tone = 'blue',
  onConfirm,
  onCancel,
}: {
  title: string;
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  hideCancel?: boolean;
  tone?: 'blue' | 'red' | 'amber';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Escape cancels, as it does everywhere else a dialog is open. Bound on
  // keydown so it beats anything the viewport does with the same key.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', onKey, true);
    confirmRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const confirmBtnClass =
    tone === 'red'
      ? 'bg-red-500 hover:bg-red-600 text-white'
      : tone === 'amber'
        ? 'bg-amber-500 hover:bg-amber-600 text-slate-950'
        : 'bg-blue-500 hover:bg-blue-600 text-white';

  const iconBadgeClass =
    tone === 'red'
      ? 'bg-red-100 dark:bg-red-950/60 text-red-600 dark:text-red-400'
      : 'bg-amber-100 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400';

  const modal = (
    <div
      className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-2xl max-w-md w-full p-6 flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3">
          <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${iconBadgeClass}`}>
            <AlertTriangle className="w-5 h-5" />
          </div>
          <h2 className="font-bold text-slate-800 dark:text-slate-100 text-base">{title}</h2>
        </div>
        <div className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed flex flex-col gap-2">{body}</div>
        <div className="flex justify-end gap-2 text-xs">
          {!hideCancel && (
            <button
              onClick={onCancel}
              className="px-4 py-2 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition-colors font-semibold cursor-pointer"
            >
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            onClick={onConfirm}
            className={`px-4 py-2 font-semibold rounded-lg transition-colors cursor-pointer ${confirmBtnClass}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(modal, document.body) : modal;
}

