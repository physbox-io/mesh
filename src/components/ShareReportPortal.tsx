import { createPortal } from 'react-dom';
import { Share2, Copy, Check } from 'lucide-react';
import { canShareViaAccount } from '../utils/shareLink';
import { SIGN_IN_REQUESTED_EVENT } from './UserProfileButton';
import type { ShareState } from '../hooks/useShareScene';

/*
 * Share link report.
 *
 * Portalled to the body: the toolbar it is triggered from sits inside a
 * stacking context of its own, so a z-index set in there is only a rank
 * among that context's siblings. z-[105] puts it above the note cards
 * (zIndex 25) and below the dialogs.
 *
 * The link is in a selectable field as well as on the clipboard: a
 * clipboard write is refused on an insecure origin, and a share button
 * that silently did nothing is indistinguishable from one that
 * worked.
 */
export function ShareReportPortal({ share: state }: { share: ShareState }) {
  const {
    share, shareError, shareCopied, shareTooBig, shareBusy,
    handleAccountShare, handleStopSharing, copyShareLink, dismiss,
  } = state;
  if (!(share || shareError || shareTooBig)) return null;
  return createPortal(
    <div className="fixed top-16 right-4 max-lg:top-1/2 max-lg:right-1/2 max-lg:translate-x-1/2 max-lg:-translate-y-1/2 z-[105] w-[28rem] max-w-[90vw] p-3 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl text-xs">
      <div className="flex items-start justify-between gap-3">
        <p className="font-bold text-slate-800 dark:text-slate-100">
          {shareTooBig
            ? 'This scene is too big to put in a link'
            : shareError
              ? 'This scene could not be shared as a link'
              : shareCopied
                ? 'Link copied'
                : 'Share link'}
        </p>
        <button
          onClick={dismiss}
          className="text-slate-400 hover:text-slate-700 dark:hover:text-white font-bold cursor-pointer px-1"
          title="Dismiss"
        >
          ✕
        </button>
      </div>

      {shareError && (
        <p className="mt-1.5 text-[11px] text-amber-700 dark:text-amber-400">{shareError}</p>
      )}

      {/* The offer, not an apology.

          A sculpt or an imported mesh will never fit in a URL — the
          vertices are in the scene — so "too big" is the ordinary outcome
          for half the things worth showing somebody. The one thing that
          fixes it is an account, and this is the moment it is worth
          having one, so it is asked for here rather than left to be
          discovered behind the avatar in the corner. */}
      {shareTooBig && (
        <div className="mt-1.5 space-y-2">
          <p className="text-[11px] text-slate-600 dark:text-slate-300">{shareTooBig.message}</p>
          {canShareViaAccount() ? (
            <>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                Your account can hold it instead, and the link becomes a short one.
              </p>
              <button
                onClick={handleAccountShare}
                disabled={shareBusy}
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white font-semibold cursor-pointer transition-colors"
              >
                <Share2 className="w-3 h-3" />
                {shareBusy ? 'Storing the scene…' : 'Share from your account'}
              </button>
            </>
          ) : (
            <>
              <p className="text-[11px] text-slate-600 dark:text-slate-300">
                Sign in and your account can hold the scene instead — the link becomes a short
                one, anyone can open it without an account, and you can turn it off later.
                It is free; there is nothing to buy.
              </p>
              <button
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent(SIGN_IN_REQUESTED_EVENT, { detail: { reason: 'share' } })
                  )
                }
                className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer transition-colors"
              >
                Sign in to share this scene
              </button>
            </>
          )}
          <p className="text-[11px] text-slate-500 dark:text-slate-400">
            Or export STL and send the file.
          </p>
        </div>
      )}

      {share && (
        <>
          <div className="mt-2 flex items-center gap-1.5">
            <input
              readOnly
              value={share.url}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-w-0 px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-mono text-[10px] outline-none"
            />
            <button
              onClick={() => copyShareLink(share.url)}
              className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md bg-sky-600 hover:bg-sky-500 text-white font-semibold cursor-pointer transition-colors"
              title="Copy link"
            >
              {shareCopied ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              {shareCopied ? 'Copied' : 'Copy'}
            </button>
            {share.travelsWell && typeof navigator !== 'undefined' && 'share' in navigator && (
              <button
                onClick={() => {
                  void navigator.share({ title: 'Mesh scene', url: share.url }).catch(() => {
                    // Cancelled, or refused for a URL this long. The copy is already made.
                  });
                }}
                className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 font-semibold cursor-pointer transition-colors"
                title="Send it to a message, a post or another app"
              >
                <Share2 className="w-3 h-3" />
                Send
              </button>
            )}
          </div>
          <ul className="mt-1.5 space-y-1 text-[11px] text-slate-500 dark:text-slate-400 list-disc list-inside">
            {share.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
          {/* Only for a link that points at the account. A link with the
              scene inside it is already out there and cannot be recalled;
              offering to turn one off would be a lie. */}
          {share.token && (
            <button
              onClick={() => handleStopSharing(share.token!)}
              disabled={shareBusy}
              className="mt-2 text-[11px] text-red-600 dark:text-red-400 hover:underline disabled:opacity-50 cursor-pointer"
            >
              {shareBusy ? 'Turning it off…' : 'Stop sharing this link'}
            </button>
          )}
        </>
      )}
    </div>,
    document.body
  );
}
