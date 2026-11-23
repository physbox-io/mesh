import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { useDialogs } from '../store/dialogStore';
import type { NoteCard } from '../utils/noteCards';
import {
  buildShareLink,
  readShareLink,
  clearShareFragment,
  buildAccountShareLink,
  shareTokenInUrl,
  readAccountShareLink,
  clearShareToken,
  ShareTooLargeError,
  type ShareLink,
  type SharedScene,
} from '../utils/shareLink';
import { PhysBoxApiError, revokeShare, isProRequired } from '../utils/apiClient';
import {
  listUserPresetNames,
  normalizePresetName,
  rememberCloudOnlyPreset,
  saveUserPreset,
  takeLastWriteError,
} from '../utils/userPresets';
import { SIGNED_IN_EVENT } from '../components/UserProfileButton';
import { getSyncedSceneGraph } from '../utils/mujocoSync';
import { readEnvironment } from '../store/sceneEnvironment';

/**
 * Only permanently dead/invalid share links (404, 410, 400, wrong app, or unreadable payload)
 * should be stripped from the address bar; transient offline/5xx failures keep `?share=` intact
 * so the user can reload once connectivity returns.
 */
export function shouldClearShareTokenOnError(err: unknown): boolean {
  if (err instanceof PhysBoxApiError) {
    return err.status === 404 || err.status === 410 || err.status === 400;
  }
  if (err instanceof TypeError) return false;
  return err instanceof Error && !/network|offline|failed to fetch|load failed|timeout|abort/i.test(err.message);
}

/*
 * Sharing the scene as a link.
 *
 * The only way to give someone a scene was the JSON file, which is a file:
 * it goes in an email, not in a message, and the person on the other end has
 * to save it, find it and import it.
 *
 * Also the other end of it: a scene arriving by link opens from here.
 */
export function useShareScene(noteCards: NoteCard[], loadUserPresetWithCard: (name: string) => void) {
  const { model, data, mujoco, activePreset, sceneGraph } = useStore(useShallow((s) => ({
    model: s.model, data: s.data, mujoco: s.mujoco, activePreset: s.activePreset, sceneGraph: s.sceneGraph,
  })));
  const openDialog = useDialogs((s) => s.openDialog);
  const closeDialog = useDialogs((s) => s.closeDialog);

  const [share, setShare] = useState<ShareLink | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [shareTooBig, setShareTooBig] = useState<ShareTooLargeError | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const shareSeqRef = useRef(0);
  const openingSharedPresetRef = useRef<string | null>(null);
  const prevPresetRef = useRef<string | undefined>(activePreset);

  // Clear stale share portal state whenever a different scene is loaded, while
  // preserving an intentional quota warning for a shared scene currently being opened.
  useEffect(() => {
    const clearPortalForSwap = (nextPreset: string | undefined) => {
      shareSeqRef.current += 1;
      setShare(null);
      setShareTooBig(null);
      setShareCopied(false);
      setShareBusy(false);
      if (openingSharedPresetRef.current && openingSharedPresetRef.current === nextPreset) {
        openingSharedPresetRef.current = null;
      } else {
        setShareError(null);
      }
    };
    if (prevPresetRef.current !== activePreset) {
      prevPresetRef.current = activePreset;
      clearPortalForSwap(activePreset);
    }
    const onPresetLoaded = (e: Event) => {
      const name = (e as CustomEvent<{ name?: string }>).detail?.name;
      clearPortalForSwap(name);
    };
    window.addEventListener('physics:preset-loaded', onPresetLoaded);
    return () => window.removeEventListener('physics:preset-loaded', onPresetLoaded);
  }, [activePreset]);

  const copyShareLink = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setShareCopied(true);
    } catch {
      // No clipboard on an insecure origin, and none in some embedded views.
      // The link is in a selectable field beside this for exactly that case.
      setShareCopied(false);
    }
  }, []);

  /**
   * Copies a link that opens this scene in someone else's browser.
   *
   * `getSyncedSceneGraph` is the same reader the save and the JSON export use,
   * so a link, a saved preset and a file all carry the same scene — positions
   * included, which is what "synced" means: the graph on its own still holds
   * where every body *started*, not where the simulation has put it.
   *
   * The copilot conversation is deliberately left out. It is the author's
   * working notes rather than part of the scene, it is usually the largest
   * thing in a saved preset, and the person opening the link wants the model,
   * not the argument that produced it. Note cards do travel: they are
   * annotations written on the scene.
   */
  /** The scene as it would be shared, read the same way the save reads it. */
  const sceneToShare = useCallback((): SharedScene => {
    const synced = getSyncedSceneGraph(sceneGraph, model, data, mujoco);
    const name = activePreset?.startsWith('user:')
      ? activePreset.slice('user:'.length)
      : synced.name || 'Shared scene';
    const { simFidelity, referenceImages, brickwork } = synced;
    return {
      name, nodes: synced.nodes, noteCards,
      environment: readEnvironment(useStore.getState()),
      ...(simFidelity ? { simFidelity } : {}),
      ...(referenceImages?.length ? { referenceImages } : {}),
      ...(brickwork ? { brickwork } : {}),
    };
  }, [sceneGraph, model, data, mujoco, noteCards, activePreset]);

  const handleShare = useCallback(async () => {
    const seq = ++shareSeqRef.current;
    setShareError(null);
    setShareTooBig(null);
    setShareCopied(false);
    try {
      const link = await buildShareLink(sceneToShare());
      if (seq !== shareSeqRef.current) return;
      setShare(link);
      await copyShareLink(link.url);
    } catch (e) {
      if (seq !== shareSeqRef.current) return;
      setShare(null);
      /*
       * A scene that will not fit in a link is the ordinary case for anything
       * sculpted, not an error to apologise for — so it is kept apart from a
       * real failure. The panel turns it into the offer that actually solves
       * it: leave the scene with an account and send a short link instead.
       */
      if (e instanceof ShareTooLargeError) setShareTooBig(e);
      else setShareError(e instanceof Error ? e.message : 'That scene could not be made into a link.');
    }
  }, [sceneToShare, copyShareLink]);

  /**
   * Leaves the scene with the account and copies the short link for it.
   *
   * Offered only after the link-sized route has failed. It is the heavier
   * option — it needs an account, and it puts a copy of the scene on a server
   * — and offering it first would make an account look required for something
   * that mostly is not.
   */
  const handleAccountShare = useCallback(async () => {
    const seq = ++shareSeqRef.current;
    setShareError(null);
    setShareBusy(true);
    try {
      const link = await buildAccountShareLink(sceneToShare());
      if (seq !== shareSeqRef.current) return;
      setShareTooBig(null);
      setShare(link);
      await copyShareLink(link.url);
    } catch (e) {
      if (seq !== shareSeqRef.current) return;
      // A free account is expected to work here; sharing is deliberately not a
      // Pro route. If that ever changes server-side, say so plainly rather than
      // showing a bare 403.
      setShareError(
        isProRequired(e)
          ? 'Sharing from your account needs PhysBox Pro.'
          : e instanceof Error
            ? e.message
            : 'That scene could not be shared from your account.'
      );
    } finally {
      if (seq === shareSeqRef.current) setShareBusy(false);
    }
  }, [sceneToShare, copyShareLink]);

  /*
   * Signing in was the answer to "this scene is too big for a link", so the
   * share is finished off rather than leaving the panel sitting there with the
   * same button on it — the person already said what they wanted.
   */
  useEffect(() => {
    const done = (e: Event) => {
      if ((e as CustomEvent<{ reason?: string }>).detail?.reason !== 'share') return;
      void handleAccountShare();
    };
    window.addEventListener(SIGNED_IN_EVENT, done);
    return () => window.removeEventListener(SIGNED_IN_EVENT, done);
  }, [handleAccountShare]);

  /** Turns off a link that points at the account. A link with the scene inside it cannot be recalled. */
  const handleStopSharing = useCallback(async (token: string) => {
    setShareBusy(true);
    const ok = await revokeShare(token);
    setShareBusy(false);
    if (!ok) {
      setShareError('That link could not be turned off. Try again in a moment.');
      return;
    }
    setShare(null);
    setShareCopied(false);
  }, []);

  /**
   * Puts a shared scene into the app, however the link carried it.
   *
   * Saved under its name and then loaded, rather than pushed into the store.
   * Every other way into a scene goes through the preset loader, which resets
   * the lattice and sculpt sessions, the camera and the physics worker in one
   * known order, and a second path into `recompile` would be a second place for
   * that order to drift. It also means a shared scene is *kept*: a Mesh scene
   * is hours of work to rebuild, and losing one to a reload would be worse than
   * an unasked-for entry in the preset list.
   *
   * Declinable, and the fragment stays in the URL until it is accepted, so
   * "no" means "not now" rather than "thrown away".
   */
  const openSharedScene = useCallback((shared: SharedScene) => {
    openDialog({
      title: `Open "${shared.name}"?`,
      confirmLabel: 'Open shared scene',
      cancelLabel: 'Keep current scene',
      body: (
        <>
          <p>
            It is saved under that name and replaces the scene on screen. Save what you have first if
            you want it back.
          </p>
          <p>
            Keeping your current scene leaves the link in the address bar, so you can reload to open
            it later.
          </p>
        </>
      ),
      onCancel: closeDialog,
      onConfirm: () => {
        closeDialog();
        // Never over the top of a scene already saved under that name: a link from
        // someone whose "bracket" is not your "bracket" would otherwise overwrite
        // yours on open, with nothing said.
        const taken = new Set(listUserPresetNames());
        const baseName = normalizePresetName(typeof shared.name === 'string' ? shared.name : '') || 'Shared scene';
        let name = baseName;
        for (let n = 2; taken.has(name); n++) name = `${baseName} (${n})`;

        const { name: _name, noteCards: notes, ...scene } = shared;
        const preset = { ...scene, noteCards: notes ?? [] };
        if (!saveUserPreset(name, preset)) {
          takeLastWriteError();
          // Hold in session memory (cloudOnly) so loadUserPresetWithCard opens large
          // shared scenes cleanly even when localStorage is full.
          rememberCloudOnlyPreset(name, preset);
          openingSharedPresetRef.current = `user:${name}`;
          setShareError(
            `"${name}" opened but could not be saved — browser storage is full. ` +
              'Export the JSON now if you want to keep it.'
          );
        }
        loadUserPresetWithCard(`user:${name}`);
        clearShareFragment();
        clearShareToken();
      },
    });
  }, [loadUserPresetWithCard, openDialog, closeDialog]);

  /**
   * A scene arriving as a token — the account route, for scenes too big to put
   * in a link — or in the URL fragment (`#scene=`). Token takes precedence when
   * both are present so they never race on mount.
   */
  useEffect(() => {
    const token = shareTokenInUrl();
    if (token) {
      readAccountShareLink(token)
        .then((shared) => openSharedScene(shared))
        .catch((err) => {
          if (shouldClearShareTokenOnError(err)) clearShareToken();
          setShareError(err?.message || 'That shared link could not be opened.');
        });
      return;
    }
    readShareLink()
      .then((shared) => {
        if (!shared) return;
        openSharedScene(shared);
      })
      .catch((err) => {
        clearShareFragment();
        setShareError(err?.message || 'That link could not be read.');
      });
    // Once, on mount: opening the scene takes the token/fragment out of the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const dismiss = useCallback(() => {
    shareSeqRef.current += 1;
    setShare(null);
    setShareError(null);
    setShareTooBig(null);
    setShareBusy(false);
  }, []);

  return {
    share, shareError, shareCopied, shareTooBig, shareBusy,
    handleShare, handleAccountShare, handleStopSharing, copyShareLink, dismiss,
  };
}

export type ShareState = ReturnType<typeof useShareScene>;
