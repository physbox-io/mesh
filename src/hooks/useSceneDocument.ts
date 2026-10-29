import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { makePresetNoteCard, type NoteCard } from '../utils/noteCards';
import { syncedSetter, type Update } from '../utils/syncedSetter';
import { physicsGlobals, type CopilotMessage } from '../physicsGlobals';
import { cloudAutosave } from '../utils/cloudDocuments';
import { unloadIsAllowed } from '../utils/rescueScene';

/** Marks a clean point whose undo step has not landed yet. See markClean. */
const PENDING_CLEAN = Symbol('pending');

/**
 * The parts of a scene that are not in the store: its note cards and its
 * copilot chat — both saved, shared and exported with it — and whether any of
 * the scene has changed since it was last loaded, saved or imported.
 */
export function useSceneDocument() {
  const [noteCards, setNoteCardsState] = useState<NoteCard[]>(() => {
    const initialPreset = useStore.getState().activePreset;
    if (initialPreset && !initialPreset.startsWith('user:')) {
      const card = makePresetNoteCard(initialPreset);
      return card ? [card] : [];
    }
    return [];
  });
  /*
   * The cards as last SET, not as last rendered. The MCP bridge sets the cards
   * and reads them back in the same tick (LOAD_PRESET installs the preset's
   * card, then refreshes its bounding boxes), and a getter closed over the
   * rendered state handed back the card from before the set: loading 'empty'
   * over the double pendulum wrote "Double Pendulum" straight back.
   */
  const noteCardsRef = useRef<NoteCard[]>(noteCards);
  // The ref is read when the setter is called, never while rendering.
  const setNoteCards = useCallback(
    (next: Update<NoteCard[]>) => syncedSetter(noteCardsRef, setNoteCardsState)(next),
    [],
  );
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>([]);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);

  // Expose noteCards and copilotMessages state to MCP bridge and noteCard manager
  useEffect(() => {
    physicsGlobals._physics_getNoteCards = () => noteCardsRef.current;
    physicsGlobals._physics_setNoteCards = (cards: typeof noteCards) => setNoteCards(cards);
    physicsGlobals._physics_getCopilotMessages = () => copilotMessages;
    physicsGlobals._physics_setCopilotMessages = (msgs: typeof copilotMessages) => setCopilotMessages(msgs);
    physicsGlobals._physics_store = useStore;
  }, [noteCards, copilotMessages, setNoteCards]);

  /*
   * What the scene looked like when it was last loaded, saved or imported, so
   * picking another preset can ask before throwing work away. Undo brings the
   * geometry back after a load, but not the note cards or the copilot chat,
   * which live here rather than in the store's history.
   *
   * An edit is read off the undo stack — a new top entry, or one still being
   * gathered — rather than off the scene object, which also changes when a
   * boolean compiles or colliders land without anyone touching anything.
   */
  const cleanRef = useRef<{ top: unknown; notes: unknown; chat: unknown } | null>(null);
  const stopWatchingClean = useRef<(() => void) | null>(null);
  const markClean = useCallback((notes: unknown, chat: unknown) => {
    stopWatchingClean.current?.();
    stopWatchingClean.current = null;
    // A load's own undo step lands a tick or a build later, so the top of the
    // stack is only read once nothing is still being gathered; until then the
    // scene counts as the one just loaded.
    const clean = { top: PENDING_CLEAN as unknown, notes, chat };
    cleanRef.current = clean;
    const settle = (state: { tempUndoState: unknown; undoStack: unknown[] }) => {
      if (state.tempUndoState !== null) return false;
      clean.top = state.undoStack.at(-1) ?? null;
      return true;
    };
    if (settle(useStore.getState())) return;
    const unsubscribe = useStore.subscribe((state) => {
      if (!settle(state)) return;
      unsubscribe();
      stopWatchingClean.current = null;
    });
    stopWatchingClean.current = unsubscribe;
  }, []);
  const hasUnsavedWork = (): boolean => {
    const clean = cleanRef.current;
    const { undoStack: undoNow, tempUndoState } = useStore.getState();
    if (!clean) return undoNow.length > 0 || copilotMessages.length > 0;
    if (noteCards !== clean.notes || copilotMessages !== clean.chat) return true;
    if (clean.top === PENDING_CLEAN) return false;
    return (undoNow.at(-1) ?? null) !== clean.top || tempUndoState !== null;
  };

  /*
   * Closing or reloading the tab with unsaved work asks first, as picking
   * another preset does. A reload starts from a blank scene, so it is the same
   * loss. Not when the account's autosave already holds the latest scene.
   * Read through a ref: the listener is bound once, and the check closes over
   * this render's note cards and chat. Off under the dev server, whose own
   * full reloads after an edit would stop on the question every time.
   */
  const unsavedRef = useRef(hasUnsavedWork);
  useEffect(() => {
    unsavedRef.current = hasUnsavedWork;
  });
  useEffect(() => {
    if (import.meta.env.DEV) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (unloadIsAllowed() || !unsavedRef.current() || cloudAutosave.holdsLatest()) return;
      e.preventDefault();
      // Older Chromium and Safari still want the legacy field set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /** A scene just arrived (loaded or imported) with these notes and this chat: show them, and call it clean. */
  const replaceDocument = useCallback((notes: NoteCard[], chat: CopilotMessage[]) => {
    setNoteCards(notes);
    setCopilotMessages(chat);
    setEditingCardId(null);
    markClean(notes, chat);
  }, [markClean, setNoteCards]);

  return {
    noteCards, setNoteCards,
    copilotMessages, setCopilotMessages,
    editingCardId, setEditingCardId,
    markClean, hasUnsavedWork, replaceDocument,
  };
}

export type SceneDocument = ReturnType<typeof useSceneDocument>;
