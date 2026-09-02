import React, { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { User, LogOut, Radio, Sparkles, ShieldCheck, CheckCircle } from 'lucide-react';
import { getStoredUser, getStoredAuthToken, clearStoredAuth, fetchCurrentUser } from '../utils/apiClient';
import type { PhysBoxUser } from '../utils/apiClient';
import { signInWithGooglePopup, disableGoogleAutoSelect } from '../utils/googleAuth';
import { pullCloudState } from '../utils/cloudSync';
import { mergePulledPresets } from '../utils/userPresets';
import { RemoteMachiningModal } from './RemoteMachiningModal';
import { GuestListModal } from './GuestListModal';

export const UserProfileButton: React.FC = () => {
  const [user, setUser] = useState<PhysBoxUser | null>(getStoredUser());
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [showLoginModal, setShowLoginModal] = useState(false);
  const [showRemoteModal, setShowRemoteModal] = useState(false);
  const [showGuestModal, setShowGuestModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [syncSummary, setSyncSummary] = useState<string | null>(null);
  /** Set when the avatar will not load; the icon stands in for it. */
  const [avatarBroken, setAvatarBroken] = useState(false);
  /**
   * The avatar the sign-in window downloaded for us, as a data URI.
   *
   * Preferred over Google's URL because this document is cross-origin isolated:
   * an <img> pointing straight at googleusercontent is fetched in no-cors mode,
   * and COEP refuses it outright — that is the
   * ERR_BLOCKED_BY_RESPONSE.NotSameOriginAfterDefaultedToSameOriginByCoep in
   * the console. A data URI is same-origin, so none of it applies, and it
   * survives Google rotating the URL.
   */
  const [avatarData, setAvatarData] = useState<string | null>(
    () => localStorage.getItem('physbox_user_avatar')
  );
  /**
   * `crossOrigin` matters on the fallback and is not decoration: it is what
   * makes the request CORS-mode, which is the only way COEP will accept a
   * cross-origin image. Google answers with `access-control-allow-origin: *`.
   */
  const avatarSrc = avatarData ?? user?.picture ?? null;

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetchCurrentUser().then((u) => {
      if (u) setUser(u);
    });
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  /**
   * Pulls the account's settings and presets down.
   *
   * Runs on mount for an already-signed-in session as well as immediately after
   * signing in, because the sync only ever ran upwards before: a browser that
   * had never saved anything locally would show empty settings next to a menu
   * claiming sync was active.
   */
  const pullAccountState = React.useCallback(async () => {
    if (!getStoredAuthToken()) return;
    try {
      const { parameters, presets } = await pullCloudState();
      const added = mergePulledPresets(presets);
      setSyncSummary(
        parameters === 0 && added === 0
          ? 'Account is up to date'
          : `Restored ${parameters} setting${parameters === 1 ? '' : 's'}` +
              (added > 0 ? ` and ${added} preset${added === 1 ? '' : 's'}` : '')
      );
    } catch (e) {
      console.warn('[PhysBox Cloud] Could not pull account state:', e);
      setSyncSummary('Could not reach the sync service');
    }
  }, []);

  useEffect(() => {
    // The rule sees a setState reachable from an effect body, but every one of
    // them is behind an await on a network round-trip — this is a subscription
    // to an external system, not derived state computed during render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void pullAccountState();
  }, [pullAccountState]);

  /**
   * Google renders its own button, so it can only be drawn once the modal's
   * container is actually mounted.
   */
  /**
   * Signs in through the popup page, and picks up the session it leaves behind.
   *
   * The credential exchange happens over there — see `signInWithGooglePopup` —
   * because this document is cross-origin isolated and a popup opened from it
   * cannot talk back. What is left to do here is what the app cares about: the
   * profile, the cloud pull, and the early-access notice.
   */
  /*
   * A session appearing closes the modal, however it got there.
   *
   * `handleSignIn` already does this on its own success path, but that path is
   * one promise resolving — and when it rejected wrongly, the modal stayed open
   * over an account that was in fact signed in. This watches the state itself
   * rather than the flow that produced it, so the window agrees with reality
   * even if the flow above is wrong again.
   */
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'physbox_auth_handoff') return;
      const signedIn = getStoredUser();
      if (!signedIn) return;
      setUser(signedIn);
      setAvatarData(localStorage.getItem('physbox_user_avatar'));
      setAvatarBroken(false);
      setLoginError(null);
      setShowLoginModal(false);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const handleSignIn = React.useCallback(async () => {
    setIsLoading(true);
    setLoginError(null);
    try {
      await signInWithGooglePopup();
      const signedIn = getStoredUser();
      if (!signedIn) throw new Error('Sign in did not complete.');

      setUser(signedIn);
      setAvatarData(localStorage.getItem('physbox_user_avatar'));
      setAvatarBroken(false);
      setShowLoginModal(false);
      setDropdownOpen(false);
      await pullAccountState();
      if (localStorage.getItem('physbox_auth_is_admin') !== '1') {
        setShowGuestModal(true);
      }
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : 'Sign in failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  }, [pullAccountState]);

  const handleLogout = () => {
    clearStoredAuth();
    setAvatarData(null);
    setAvatarBroken(false);
    // Otherwise Google can hand the same account straight back on the next
    // visit, and signing out looks like it did nothing.
    disableGoogleAutoSelect();
    setUser(null);
    setSyncSummary(null);
    setDropdownOpen(false);
  };

  const isActiveSub = user?.subscription_tier === 'active';

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setDropdownOpen(!dropdownOpen)}
        className="relative flex items-center justify-center w-8 h-8 rounded-full border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors focus:outline-none flex-shrink-0 cursor-pointer shadow-xs"
        title={user ? `Account (${user.email})` : 'Sign In / Early Access'}
      >
        {avatarSrc && !avatarBroken ? (
          <img
            src={avatarSrc}
            alt="Avatar"
            crossOrigin={avatarData ? undefined : 'anonymous'}
            /*
             * `no-referrer` and a fallback, because a Google avatar fails in two
             * ways that both end as a broken-image glyph. It 403s when the
             * Referer is not one it expects, and the URL goes stale on its own
             * schedule. Neither is worth showing as a broken picture when there
             * is a perfectly good icon to fall back to.
             */
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full rounded-full object-cover"
            onError={() => setAvatarBroken(true)}
          />
        ) : (
          <User className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
        )}
        <span
          className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-white dark:border-slate-900 ${
            user ? (isActiveSub ? 'bg-emerald-400' : 'bg-amber-400') : 'bg-slate-400'
          }`}
        />
      </button>

      {/* Dropdown Menu */}
      {dropdownOpen && (
        /*
          Anchored to the avatar on a desktop. Below `lg` the top bar wraps, so
          the avatar can end up anywhere along a row — and `right-0` on an 18rem
          panel then hangs it off the edge of the screen. There is nothing to
          measure against reliably, so on a narrow screen it stops being a
          dropdown and becomes a centred sheet, like the settings popover.
        */
        <div className="absolute right-0 mt-2 w-72 max-lg:fixed max-lg:inset-x-2 max-lg:top-1/2 max-lg:mt-0 max-lg:-translate-y-1/2 max-lg:w-auto max-lg:max-h-[85dvh] max-lg:overflow-y-auto bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-xl shadow-2xl z-50 p-3 space-y-3 text-slate-800 dark:text-slate-100">
          {user ? (
            <>
              {/* Logged-In Profile Header */}
              <div className="p-2.5 rounded-lg bg-slate-50 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-3">
                  {avatarSrc && !avatarBroken ? (
                    <img
                      src={avatarSrc}
                      alt="Avatar"
                      crossOrigin={avatarData ? undefined : 'anonymous'}
                      referrerPolicy="no-referrer"
                      className="w-8 h-8 rounded-full border border-cyan-500/30"
                      onError={() => setAvatarBroken(true)}
                    />
                  ) : (
                    <div className="p-2 bg-cyan-50 dark:bg-cyan-500/20 text-cyan-600 dark:text-cyan-400 rounded-lg">
                      <User className="w-4 h-4" />
                    </div>
                  )}
                  <div className="overflow-hidden">
                    <p className="font-bold text-slate-800 dark:text-slate-100 text-xs truncate">{user.name || 'PhysBox Member'}</p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate">{user.email}</p>
                  </div>
                </div>

                <div className="mt-2.5 pt-2 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between">
                  <span className="text-[10px] text-slate-500 dark:text-slate-400">Subscription Status</span>
                  {isActiveSub ? (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-500/30"
                    >
                      <ShieldCheck className="w-3 h-3" /> Active Subscription
                    </span>
                  ) : (
                    <button
                      onClick={() => {
                        setDropdownOpen(false);
                        setShowGuestModal(true);
                      }}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 dark:bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-500/30 hover:bg-amber-100 dark:hover:bg-amber-500/20 transition cursor-pointer"
                    >
                      <Sparkles className="w-3 h-3" /> On the Guest List 🎉
                    </button>
                  )}
                </div>
              </div>

              {/* Navigation Options */}
              <div className="space-y-1">
                <button
                  onClick={() => {
                    setDropdownOpen(false);
                    setShowRemoteModal(true);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg transition cursor-pointer"
                >
                  <Radio className="w-4 h-4 text-cyan-600 dark:text-cyan-400" />
                  <span>View Remote Machining Telemetry</span>
                </button>

                <div className="px-3 py-1.5 text-[10px] text-slate-500 flex items-center gap-1.5">
                  <CheckCircle className="w-3 h-3 text-emerald-500 dark:text-emerald-400" />
                  <span>{syncSummary ?? 'Syncing parameters and presets…'}</span>
                </div>
              </div>

              {/* Logout Button */}
              <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
                <button
                  onClick={handleLogout}
                  className="w-full flex items-center gap-2 px-3 py-2 text-xs text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-lg transition cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Sign Out</span>
                </button>
              </div>
            </>
          ) : (
            /* Logged-Out Menu */
            <div className="space-y-3 p-1">
              <div className="text-center">
                <p className="font-bold text-slate-800 dark:text-slate-100 text-xs">PhysBox Account Sign In</p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Sign in to synchronize parameters, saved presets, and remote telemetry.</p>
              </div>

              <button
                onClick={() => {
                  setDropdownOpen(false);
                  setShowLoginModal(true);
                }}
                className="w-full py-2 px-3 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition shadow-md shadow-cyan-600/20 cursor-pointer"
              >
                <User className="w-4 h-4" />
                <span>Sign In / Early Access</span>
              </button>
            </div>
          )}
        </div>
      )}

      {/* Login Modal */}
      {showLoginModal &&
        ReactDOM.createPortal(
          <div
            className="fixed inset-0 z-[99999] bg-slate-900/50 dark:bg-black/75 backdrop-blur-md flex items-center justify-center p-4 overflow-y-auto"
            onClick={() => setShowLoginModal(false)}
          >
            <div
              className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-2xl w-full max-w-md p-6 space-y-4 shadow-2xl relative max-h-[90dvh] overflow-y-auto my-auto text-slate-800 dark:text-slate-100"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => setShowLoginModal(false)}
                className="absolute top-4 right-4 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 w-8 h-8 flex items-center justify-center rounded-full hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
                title="Close (Esc)"
              >
                ✕
              </button>
              <div className="text-center space-y-1">
                <h3 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">PhysBox Account Sign In</h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">Sign in with your Google account to sync your settings and saved scenes, or to join the early access guest list.</p>
              </div>
              {loginError && (
                <div className="p-2.5 rounded-lg bg-rose-50 dark:bg-rose-500/10 border border-rose-200 dark:border-rose-500/30 text-rose-600 dark:text-rose-300 text-xs text-center">
                  {loginError}
                </div>
              )}
              {/* Opens the sign-in window rather than drawing Google's button
                  here. This document is cross-origin isolated, and a popup it
                  opens cannot talk back to it — Google's own button would
                  produce a blank window that never returns a credential. See
                  `signInWithGooglePopup`. There is deliberately no email field:
                  a Google-signed token is the only thing the API accepts. */}
              <div className="flex justify-center pt-1">
                <button
                  onClick={() => void handleSignIn()}
                  disabled={isLoading}
                  className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-white dark:bg-slate-100 hover:bg-slate-50 dark:hover:bg-white border border-slate-300 text-slate-800 text-sm font-semibold shadow-sm disabled:opacity-50 cursor-pointer transition-colors"
                >
                  <svg className="w-4 h-4" viewBox="0 0 18 18" aria-hidden="true">
                    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z" />
                    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18z" />
                    <path fill="#FBBC05" d="M3.95 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33z" />
                    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58z" />
                  </svg>
                  <span>Sign in with Google</span>
                </button>
              </div>
              {isLoading && (
                <p className="text-center text-xs text-slate-500 dark:text-slate-400">Signing in…</p>
              )}
            </div>
          </div>,
          document.body
        )}

      <RemoteMachiningModal isOpen={showRemoteModal} onClose={() => setShowRemoteModal(false)} />
      <GuestListModal
        isOpen={showGuestModal}
        onClose={() => setShowGuestModal(false)}
        userEmail={user?.email || ''}
      />
    </div>
  );
};
