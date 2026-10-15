import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import { makePresetNoteCard, type NoteCard } from '../utils/noteCards';
import { physicsGlobals, type CopilotMessage } from '../physicsGlobals';

/** Marks a clean point whose undo step has not landed yet. See markClean. */
const PENDING_CLEAN = Symbol('pending');

/**
 * The parts of a scene that are not in the store: its note cards and its
 * copilot chat — both saved, shared and exported with it — and whether any of
 * the scene has changed since it was last loaded, saved or imported.
 */
export function useSceneDocument() {
  const [noteCards, setNoteCards] = useState<NoteCard[]>(() => {
    const initialPreset = useStore.getState().activePreset;
    if (initialPreset && !initialPreset.startsWith('user:')) {
      const card = makePresetNoteCard(initialPreset);
      return card ? [card] : [];
    }
    return [];
  });
  const [copilotMessages, setCopilotMessages] = useState<CopilotMessage[]>([]);
  const [editingCardId, setEditingCardId] = useState<string | null>(null);

  // Expose noteCards and copilotMessages state to MCP bridge and noteCard manager
  useEffect(() => {
    physicsGlobals._physics_getNoteCards = () => noteCards;
    physicsGlobals._physics_setNoteCards = (cards: typeof noteCards) => setNoteCards(cards);
    physicsGlobals._physics_getCopilotMessages = () => copilotMessages;
    physicsGlobals._physics_setCopilotMessages = (msgs: typeof copilotMessages) => setCopilotMessages(msgs);
    physicsGlobals._physics_store = useStore;
  }, [noteCards, copilotMessages]);

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

  /** A scene just arrived (loaded or imported) with these notes and this chat: show them, and call it clean. */
  const replaceDocument = useCallback((notes: NoteCard[], chat: CopilotMessage[]) => {
    setNoteCards(notes);
    setCopilotMessages(chat);
    setEditingCardId(null);
    markClean(notes, chat);
  }, [markClean]);

  return {
    noteCards, setNoteCards,
    copilotMessages, setCopilotMessages,
    editingCardId, setEditingCardId,
    markClean, hasUnsavedWork, replaceDocument,
  };
}

export type SceneDocument = ReturnType<typeof useSceneDocument>;
