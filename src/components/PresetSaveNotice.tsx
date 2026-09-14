import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom';
import { Check, Cloud, CloudOff, Loader2, AlertTriangle, Download, Trash2, Sparkles, LogIn } from 'lucide-react';
import { subscribeToPresetNotices, type PresetNotice } from '../utils/presetNotices';
import { formatBytes, presetToFile, type PresetRemedy } from '../utils/presetStorage';
import { deleteUserPreset } from '../utils/userPresets';

/**
 * What happened to the preset you just saved.
 *
 * Two shapes, because two very different things can happen and they deserve
 * very different amounts of the screen.
 *
 * A save that worked is a toast: it says so, and if there is an account it then
 * says whether the account has it too. That second half is the bit worth having
 * — "Saved" alone leaves you wondering whether the work exists anywhere but this
 * browser, and the honest answer takes a network round trip, so the toast starts
 * with what it knows and finishes the sentence when the upload lands.
 *
 * A save that FAILED is a dialog with buttons, because it needs a decision. The
 * browser's storage is a few megabytes shared with everything else the origin
 * keeps, one scene with a sculpt or a generated mesh in it can be over a
 * megabyte, and until now hitting that limit wrote a line to the console and
 * threw the work away. Every remedy the save could think of is offered here, and
 * the download is always among them because it is the one that cannot fail.
 */

const AUTO_HIDE_MS = 4000;

/**
 * Where "what is Pro" is answered, matching the link JobHistoryModal already
 * uses. It is a page to READ, not a checkout: there is no purchase flow yet, and
 * an account is created in the app from the account menu, so this invites rather
 * than sells.
 */
const PRO_URL = 'https://physbox.io/pro.html';

export const PresetSaveNotice: React.FC = () => {
  const [notice, setNotice] = useState<PresetNotice | null>(null);
  /** null while the upload is in flight, then whether the account took it. */
  const [cloud, setCloud] = useState<boolean | null>(null);
  const [dismissedIds, setDismissedIds] = useState<number[]>([]);

  useEffect(() => subscribeToPresetNotices((next) => {
    setNotice(next);
    setCloud(next.cloudPending ? null : false);
  }), []);

  // Follow the upload for THIS notice only: a second save while the first is
  // still in the air must not have the older answer land on top of it.
  useEffect(() => {
    if (!notice?.cloudPending) return;
    let live = true;
    void notice.cloudPending.then(
      (ok) => { if (live) setCloud(ok); },
      () => { if (live) setCloud(false); },
    );
    return () => { live = false; };
  }, [notice]);

  const failed = !!notice && !notice.result.ok;

  // A toast gets out of the way on its own. A dialog does not — it is asking a
  // question, and questions wait.
  useEffect(() => {
    if (!notice || failed) return;
    const timer = setTimeout(() => setNotice(null), AUTO_HIDE_MS);
    return () => clearTimeout(timer);
  }, [notice, failed, cloud]);

  const download = useCallback(() => {
    if (!notice) return;
    const { filename, json } = presetToFile(notice.name, notice.preset);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    // Revoked on the next tick rather than immediately: Safari has not always
    // finished reading the blob by the time click() returns.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [notice]);

  const deleteAndRetry = useCallback((names: string[]) => {
    for (const n of names) deleteUserPreset(n);
    setNotice(null);
    // Not retried automatically: the save is cheap to repeat and doing it behind
    // the user's back after deleting their presets is too much initiative.
  }, []);

  if (!notice || dismissedIds.includes(notice.id)) return null;
  const dismiss = () => setDismissedIds((ids) => [...ids, notice.id]);

  const { result } = notice;

  if (!failed) {
    const toCloud = result.savedTo === 'cloud';
    return ReactDOM.createPortal(
      <div
        className="fixed bottom-4 left-4 z-[99998] max-w-sm text-xs pointer-events-auto"
        role="status"
        aria-live="polite"
      >
        <div className="inline-flex items-start gap-2 px-3 py-2 rounded-xl bg-white/95 dark:bg-slate-900/95 border border-slate-200 dark:border-slate-700 shadow-lg text-slate-600 dark:text-slate-300">
          <Check className="w-3.5 h-3.5 mt-0.5 text-emerald-500 shrink-0" />
          <div className="space-y-0.5">
            <div className="font-bold text-slate-700 dark:text-slate-200">
              Saved “{notice.name}”
            </div>
            {toCloud ? (
              <div className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
                <Cloud className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  to your account — this browser is full ({formatBytes(result.storeBytes)} of presets)
                </span>
              </div>
            ) : cloud === null && result.cloudPending ? (
              <div className="flex items-center gap-1.5 opacity-70">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Saving to your account…</span>
              </div>
            ) : cloud ? (
              <div className="flex items-center gap-1.5 text-cyan-600 dark:text-cyan-400">
                <Cloud className="w-3.5 h-3.5" />
                <span>and to your account</span>
              </div>
            ) : result.signedIn ? (
              <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <CloudOff className="w-3.5 h-3.5" />
                <span>on this device only — your account could not be reached</span>
              </div>
            ) : (
              <div className="opacity-70">on this device</div>
            )}
          </div>
        </div>
      </div>,
      document.body,
    );
  }

  const remedy = (kind: PresetRemedy['kind']) => result.remedies.find((r) => r.kind === kind);
  const del = remedy('delete') as { kind: 'delete'; names: string[]; freesBytes: number } | undefined;

  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/40 p-4" role="alertdialog" aria-modal="true">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-900 border border-amber-300 dark:border-amber-500/40 shadow-2xl p-4 space-y-3 text-sm text-slate-700 dark:text-slate-200">
        <div className="flex items-start gap-2 font-bold text-amber-700 dark:text-amber-400">
          <AlertTriangle className="w-5 h-5 mt-0.5 shrink-0" />
          <span>“{notice.name}” was not saved</span>
        </div>

        <p className="leading-relaxed text-xs">{result.message}</p>

        {result.largest.length > 0 && (
          <div className="text-xs rounded-lg border border-slate-200 dark:border-slate-700 divide-y divide-slate-100 dark:divide-slate-800">
            {result.largest.slice(0, 4).map((p) => (
              <div key={p.name} className="flex items-center justify-between px-2.5 py-1.5">
                <span className="truncate">{p.name}</span>
                <span className="tabular-nums opacity-60 shrink-0 ml-2">{formatBytes(p.bytes)}</span>
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap gap-1.5 pt-0.5">
          <button
            onClick={download}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-bold cursor-pointer text-xs"
          >
            <Download className="w-3.5 h-3.5" /> Download as a file
          </button>

          {del && del.names.length > 0 && (
            <button
              onClick={() => deleteAndRetry(del.names)}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800 font-bold cursor-pointer text-xs"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete {del.names.length === 1 ? `“${del.names[0]}”` : `${del.names.length} presets`} ({formatBytes(del.freesBytes)})
            </button>
          )}

          {remedy('upgrade') && (
            <a
              href={PRO_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-amber-300 dark:border-amber-500/40 text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-500/10 font-bold cursor-pointer text-xs"
            >
              <Sparkles className="w-3.5 h-3.5" /> See PhysBox Pro
            </a>
          )}

          {remedy('signIn') && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs opacity-80">
              <LogIn className="w-3.5 h-3.5" /> Sign in from the account menu to keep presets in your account
            </span>
          )}

          <button
            onClick={dismiss}
            className="ml-auto px-2.5 py-1.5 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800 font-bold cursor-pointer text-xs opacity-70"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
