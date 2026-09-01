/**
 * Real Google sign-in, via Google Identity Services.
 *
 * The sign-in form here used to be an email textbox next to a button labelled
 * "Sign In with Google", which sent that typed address to the API and got a
 * session back. Nothing about it involved Google, and nothing established that
 * the person typing owned the address. This module fetches an actual Google ID
 * token — signed by Google, minted for this specific client id — which is the
 * only thing the API will now accept.
 *
 * Ported from `etch/src/utils/googleAuth.ts`, which fixed this first. The API
 * was hardened at the same time (`physbox_api/src/routes/auth.ts` now rejects a
 * bare email with a 400), so until this landed every sign-in here failed and
 * apiClient's offline fallback quietly minted a local session instead — which
 * is why the account menu could claim an active subscription while nothing had
 * ever reached the server.
 */

import { getStoredAuthToken } from './apiClient';

const GSI_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleCredentialResponse {
  credential?: string;
}

interface GoogleAccountsId {
  initialize(config: {
    client_id: string;
    callback: (response: GoogleCredentialResponse) => void;
    auto_select?: boolean;
    cancel_on_tap_outside?: boolean;
    use_fedcm_for_prompt?: boolean;
  }): void;
  renderButton(
    parent: HTMLElement,
    options: {
      type?: 'standard' | 'icon';
      theme?: 'outline' | 'filled_blue' | 'filled_black';
      size?: 'small' | 'medium' | 'large';
      text?: 'signin_with' | 'signup_with' | 'continue_with';
      shape?: 'rectangular' | 'pill' | 'circle' | 'square';
      logo_alignment?: 'left' | 'center';
      width?: number;
    }
  ): void;
  disableAutoSelect(): void;
}

declare global {
  interface Window {
    google?: { accounts: { id: GoogleAccountsId } };
  }
}

/**
 * The OAuth Web client id for the PhysBox suite.
 *
 * Deliberately committed to source rather than kept in a `.env`. It is public
 * by construction — Vite substitutes it into the shipped JavaScript, so anyone
 * can read it out of the bundle — and it *identifies* the application rather
 * than authenticating it; the security comes from the authorised-origins list
 * on the Google side and from the API verifying the audience on every
 * credential. Holding it here means a fresh checkout builds a working sign-in
 * with no untracked setup step, and leaves `.env` gitignored and free for
 * things that genuinely are secret.
 *
 * It must stay identical to the `GOOGLE_CLIENT_ID` the API runs with, and to
 * the id the sibling apps present (`etch/src/utils/googleAuth.ts`,
 * `physbox_static/auth.js`). The API verifies the audience on every credential
 * against a single configured id, so if any of them drift, every sign-in from
 * that app fails as a wrong-audience error.
 */
const DEFAULT_GOOGLE_CLIENT_ID = '454740079598-5kjau5ikk21c0touvj83qpunnonao4vp.apps.googleusercontent.com';

/**
 * The client id this build signs in against.
 *
 * `VITE_GOOGLE_CLIENT_ID` overrides the default, for pointing a local build or
 * a fork at a different OAuth client without editing source.
 */
export function getGoogleClientId(): string {
  const override = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  if (typeof override === 'string' && override.trim()) return override.trim();
  return DEFAULT_GOOGLE_CLIENT_ID.trim();
}

export function isGoogleSignInConfigured(): boolean {
  return getGoogleClientId().length > 0;
}

let scriptPromise: Promise<void> | null = null;

/** Injects the GSI script once, and resolves when it is usable. */
export function loadGoogleIdentity(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`);
    const script = existing ?? document.createElement('script');

    const settle = () => {
      if (window.google?.accounts?.id) resolve();
      else reject(new Error('Google sign-in loaded but did not initialise.'));
    };

    script.addEventListener('load', settle);
    script.addEventListener('error', () => {
      // Let a later attempt retry rather than caching the failure forever —
      // this is usually a blocked script or a dropped connection, not a
      // permanent condition.
      scriptPromise = null;
      reject(new Error('Could not reach Google sign-in. Check your connection or any script blocker.'));
    });

    if (!existing) {
      script.src = GSI_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    } else if (window.google?.accounts?.id) {
      settle();
    }
  });

  return scriptPromise;
}

/**
 * Draws Google's own sign-in button into `container` and reports the credential
 * it produces.
 *
 * Google's rendered button is used rather than One Tap's `prompt()` because it
 * degrades predictably: it is a visible control the user clicks, so a suppressed
 * or dismissed One Tap can't leave the modal looking broken with nothing in it.
 */
export async function renderGoogleSignInButton(
  container: HTMLElement,
  onCredential: (credential: string) => void,
  onError: (message: string) => void
): Promise<void> {
  const clientId = getGoogleClientId();
  if (!clientId) {
    onError('Google sign-in is not configured for this build (VITE_GOOGLE_CLIENT_ID is unset).');
    return;
  }

  await loadGoogleIdentity();
  const id = window.google?.accounts?.id;
  if (!id) {
    onError('Google sign-in is unavailable.');
    return;
  }

  id.initialize({
    client_id: clientId,
    callback: (response) => {
      if (response.credential) onCredential(response.credential);
      else onError('Google did not return a credential. Please try again.');
    },
    auto_select: false,
    cancel_on_tap_outside: true,
  });

  container.replaceChildren();
  id.renderButton(container, {
    type: 'standard',
    theme: document.documentElement.classList.contains('dark') ? 'filled_black' : 'outline',
    size: 'large',
    text: 'signin_with',
    shape: 'pill',
    logo_alignment: 'left',
    width: 320,
  });
}

/**
 * Stops Google from silently re-authenticating on the next visit.
 *
 * Without this, signing out clears our session but leaves Google's, so One Tap
 * can hand the same account straight back and the sign-out looks like it failed.
 */
export function disableGoogleAutoSelect(): void {
  try {
    window.google?.accounts?.id?.disableAutoSelect();
  } catch {
    // Nothing to disable if the script never loaded.
  }
}

// ---------------------------------------------------------------------------
// Signing in from a cross-origin isolated page
// ---------------------------------------------------------------------------

/** Where the popup leaves the finished session; see `public/signin.html`. */
const HANDOFF_KEY = 'physbox_auth_handoff';

/**
 * Signs in through `public/signin.html`, in a window of its own.
 *
 * The app sends `Cross-Origin-Opener-Policy: same-origin` — that is what earns
 * it `SharedArrayBuffer`, and what lets the physics worker run on shared memory
 * rather than copying a snapshot of the world every frame. The same header
 * severs `window.opener` for a cross-origin popup, so Google's sign-in window
 * came up blank: its script had nothing to post the credential back to.
 *
 * Both requirements cannot hold in one document, so they are met in two. The
 * sign-in page is served without the isolation headers, does the ordinary
 * Google flow there, and leaves the session in `localStorage` — shared by every
 * same-origin document whether isolated or not, and needing no window handle.
 *
 * Resolves when the session lands, rejects if the window is closed first.
 */
export function signInWithGooglePopup(): Promise<void> {
  const clientId = getGoogleClientId();
  if (!clientId) {
    return Promise.reject(
      new Error('Google sign-in is not configured for this build (VITE_GOOGLE_CLIENT_ID is unset).')
    );
  }

  /*
   * What the handoff key held before we started.
   *
   * Completion is "this value changed", not "a token exists" — somebody signing
   * in to a second account already has a token, and would otherwise be reported
   * as finished the instant the window opened.
   */
  const before = localStorage.getItem(HANDOFF_KEY);

  const url = `/signin.html?client_id=${encodeURIComponent(clientId)}`;
  // The handle is opened and then deliberately not relied upon; see below.
  const popup = window.open(url, 'physbox-signin', 'width=460,height=620,menubar=no,toolbar=no');
  if (!popup) {
    return Promise.reject(
      new Error('Your browser blocked the sign-in window. Allow pop-ups for this site and try again.')
    );
  }

  /*
   * `popup.closed` is not usable here, and no amount of checking makes it so.
   *
   * The sign-in page carries a different COOP value from this one — that is the
   * entire point of it — and differing COOP swaps the browsing context group,
   * severing the handle the opener was given. The trap is the timing: at the
   * moment `window.open` returns, the window is still `about:blank` and shares
   * this document's COOP, so it looks perfectly healthy. The swap happens when
   * it *navigates* to the sign-in page a moment later, and `closed` then reads
   * true for a window that is open and working.
   *
   * Checking the handle "right after opening" therefore proves nothing, which
   * is why that attempt still announced a cancellation the instant the popup
   * appeared. The window reports its own liveness instead, by writing a
   * timestamp to localStorage every second.
   */
  const ALIVE_KEY = 'physbox_auth_alive';
  /** No pulse for this long means the window is gone. */
  const ALIVE_TIMEOUT_MS = 4000;
  /** Grace while the page is still loading and has not pulsed yet. */
  const STARTUP_GRACE_MS = 8000;
  /** How long to wait before giving up. Long: a password and 2FA take a while. */
  const TIMEOUT_MS = 5 * 60 * 1000;

  return new Promise<void>((resolve, reject) => {
    const startedAt = Date.now();
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('storage', onStorage);
      clearInterval(timer);
      if (err) reject(err);
      else resolve();
    };

    const done = () => localStorage.getItem(HANDOFF_KEY) !== before && Boolean(getStoredAuthToken());

    // `storage` fires in other same-origin documents, which the sign-in page
    // is. This is the fast path.
    const onStorage = (event: StorageEvent) => {
      if (event.key === HANDOFF_KEY && done()) finish();
    };
    window.addEventListener('storage', onStorage);

    /*
     * And a poll behind it, because the event is not guaranteed to arrive: a
     * background tab may have it coalesced, and the popup closes itself
     * immediately after writing. Reading the value directly is cheap and does
     * not depend on being woken.
     */
    const timer = setInterval(() => {
      if (done()) {
        finish();
        return;
      }

      const age = Date.now() - startedAt;
      if (age > TIMEOUT_MS) {
        finish(new Error('Sign-in timed out. Please try again.'));
        return;
      }

      // Only once the window has had time to load and start pulsing. Before
      // that a missing heartbeat means nothing.
      if (age < STARTUP_GRACE_MS) return;

      const beat = Number(localStorage.getItem(ALIVE_KEY) ?? 0);
      if (!beat || Date.now() - beat > ALIVE_TIMEOUT_MS) {
        finish(new Error('Sign-in was cancelled.'));
      }
    }, 300);
  });
}
