/** Presses Ctrl+Z (or Ctrl+Shift+Z) for the toolbar's undo and redo buttons. */
export function pressHistoryKey(redoing: boolean) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: redoing, bubbles: true, cancelable: true }));
}
