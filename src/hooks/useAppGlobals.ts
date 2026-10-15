import { useEffect } from 'react';
import { useStore } from '../store/useStore';
import { loadCompiler } from '../utils/openscad';

/** Delete / Backspace deletes the selection; Ctrl-Z undoes, Ctrl-Y and Ctrl-Shift-Z redo. */
export function useEditShortcuts() {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        return;
      }
      if ((e.target as HTMLElement)?.isContentEditable) return;

      if (e.key === 'Delete' || e.key === 'Backspace') {
        // Not while a tool has hold of the body. Lattice swallows the key
        // itself; sculpting, painting, measuring and a keyboard gesture did
        // not, so a stray Backspace deleted the body being worked on and threw
        // away its stroke history with it.
        const s = useStore.getState();
        if (s.sculptNodeId || s.latticeNodeId || s.paintMode || s.measureMode || s.gestureStatus) return;
        // Nor from inside a dialog: every modal is a full-screen `fixed inset-0`
        // overlay, and Backspace on one of its buttons deleted the selected
        // body hidden behind it.
        if ((e.target as HTMLElement).closest?.('.fixed.inset-0')) return;
        const ids = [...(s.selectedNodeId ? [s.selectedNodeId] : []), ...s.extraSelectedIds];
        if (ids.length > 0) s.deleteNodes(ids);
        return;
      }

      /*
        Undo and redo on the keyboard.

        There has been an undo BUTTON in the toolbar since the beginning and
        never a shortcut for it, which is the one place a person does not look:
        Ctrl-Z is muscle memory, and when it does nothing the conclusion is that
        the app cannot undo rather than that it is on a button.

        Bubble phase on purpose. The lattice and sculpt tools each keep their own
        history and take Ctrl-Z in the CAPTURE phase while they are open, so
        while you are modelling it takes back modelling; they stop the event only
        when they actually had something to undo, so once their history runs out
        it arrives here and steps the document back instead.
      */
      if (!(e.metaKey || e.ctrlKey)) return;
      const key = e.key.toLowerCase();
      // Ctrl-Y as well as Ctrl-Shift-Z: the first is what Windows does, the
      // second is what everything else does, and both are cheap to answer.
      const redoing = key === 'y' || (key === 'z' && e.shiftKey);
      if (!redoing && key !== 'z') return;
      e.preventDefault();
      const store = useStore.getState();
      if (redoing) store.redo();
      else store.undo();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}

/*
 * Pre-load the OpenSCAD compiler in the background, so the first boolean is
 * quick — but only once physics is up and the page is idle.
 *
 * It is 11 MB of wasm and 8 MB of fonts. On a fixed two-second timer it went
 * out while MuJoCo's own 9 MB could still be downloading on a slow link, and
 * the scene the user came to see waited behind a compiler it may never need.
 * A scene with booleans in it does not wait for this either way: compiling
 * starts the pool itself.
 */
export function useCompilerPreload() {
  const mujoco = useStore((s) => s.mujoco);
  useEffect(() => {
    if (!mujoco) return;
    const preload = () => {
      loadCompiler().catch(err => console.warn('Failed to pre-load OpenSCAD compiler in background:', err));
    };
    if (typeof window.requestIdleCallback === 'function') {
      const handle = window.requestIdleCallback(preload, { timeout: 10000 });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = setTimeout(preload, 3000);
    return () => clearTimeout(timer);
  }, [mujoco]);
}
