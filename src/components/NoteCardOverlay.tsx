import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Edit3, FileText, X } from 'lucide-react';
import { parseNoteMarkdown } from '../utils/noteMarkdown';

// Floating note card overlay component
export function NoteCardOverlay({ card, isEditing, onToggleEdit, onToggleMinimize, onMarkdownChange, onClose, onMove }: {
  card: { id: string; markdown: string; minimized: boolean; x: number; y: number };
  isEditing: boolean;
  onToggleEdit: () => void;
  onToggleMinimize: () => void;
  onMarkdownChange: (md: string) => void;
  onClose: () => void;
  onMove: (x: number, y: number) => void;
}) {
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);

  /*
   * A drag and a draft are held here and handed up when they settle.
   *
   * The cards live in App's state, so reporting every pointer move or keystroke
   * re-rendered the whole app and re-offered the scene to auto-save each time.
   * The card follows the pointer from its own state and reports where it was
   * dropped; the text is reported once typing pauses, and on blur.
   */
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitDraft = (md: string | null) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = null;
    if (md !== null) onMarkdownChange(md);
    setDraft(null);
  };
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  const draftRef = useRef(draft);
  useEffect(() => {
    onMarkdownChangeRef.current = onMarkdownChange;
    draftRef.current = draft;
  });
  // Leaving edit mode or closing the card must not drop what was typed last.
  useEffect(() => () => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    if (draftRef.current !== null) onMarkdownChangeRef.current(draftRef.current);
  }, []);
  const x = dragPos?.x ?? card.x;
  const y = dragPos?.y ?? card.y;

  // Pointer events, not mouse events: a finger and a stylus move the card
  // through exactly the same code path as a mouse, which listening for
  // mousedown alone left with no way to move a card at all.
  const handleTitleMouseDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: card.x, origY: card.y };
    let last: { x: number; y: number } | null = null;
    const handleMouseMove = (me: PointerEvent) => {
      if (!dragRef.current) return;
      last = { x: dragRef.current.origX + me.clientX - dragRef.current.startX, y: dragRef.current.origY + me.clientY - dragRef.current.startY };
      setDragPos(last);
    };
    const handleMouseUp = () => {
      dragRef.current = null;
      if (last) onMove(last.x, last.y);
      setDragPos(null);
      window.removeEventListener('pointermove', handleMouseMove);
      window.removeEventListener('pointerup', handleMouseUp);
      window.removeEventListener('pointercancel', handleMouseUp);
    };
    window.addEventListener('pointermove', handleMouseMove);
    window.addEventListener('pointerup', handleMouseUp);
    window.addEventListener('pointercancel', handleMouseUp);
  };

  return (
    <div
      // `min(300px, ...)` so a card dropped near the right edge of a phone is
      // still readable rather than a 300px card hanging half off the screen.
      style={{ position: 'absolute', left: x, top: y, zIndex: 25, width: 'min(300px, calc(100vw - 2rem))', touchAction: 'none' }}
      className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md border border-slate-200 dark:border-slate-800 shadow-2xl rounded-2xl overflow-hidden"
    >
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-slate-50/80 dark:bg-slate-950/40 border-b border-slate-100 dark:border-slate-800 cursor-move select-none"
        onPointerDown={handleTitleMouseDown}
      >
        <div className="flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
          <span className="text-xs font-semibold text-slate-700 dark:text-slate-300">Note Card</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={onToggleEdit} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors" title={isEditing ? 'Preview' : 'Edit'}>
            <Edit3 className="w-3 h-3 text-slate-500 dark:text-slate-400" />
          </button>
          <button onClick={onToggleMinimize} className="p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors" title={card.minimized ? 'Expand' : 'Minimize'}>
            {card.minimized ? <ChevronDown className="w-3 h-3 text-slate-500 dark:text-slate-400" /> : <ChevronUp className="w-3 h-3 text-slate-500 dark:text-slate-400" />}
          </button>
          <button onClick={onClose} className="p-0.5 rounded hover:bg-red-100 dark:hover:bg-red-950/40 transition-colors" title="Close">
            <X className="w-3 h-3 text-slate-500 dark:text-slate-400 hover:text-red-500" />
          </button>
        </div>
      </div>

      {/* Body */}
      {!card.minimized && (
        <div className="p-3">
          {isEditing ? (
            <textarea
              autoFocus
              rows={8}
              value={draft ?? card.markdown}
              onChange={(e) => {
                const md = e.target.value;
                setDraft(md);
                if (draftTimer.current) clearTimeout(draftTimer.current);
                draftTimer.current = setTimeout(() => commitDraft(md), 400);
              }}
              onBlur={() => commitDraft(draft)}
              className="w-full px-2 py-1.5 border border-slate-200 dark:border-slate-800 rounded text-xs bg-white dark:bg-slate-950 text-slate-700 dark:text-slate-200 outline-none focus:border-violet-400 font-mono resize-y shadow-sm"
              placeholder="Write markdown here..."
            />
          ) : (
            <div
              className="prose-sm dark:prose-invert max-h-64 overflow-y-auto text-slate-700 dark:text-slate-300"
              dangerouslySetInnerHTML={{ __html: parseNoteMarkdown(card.markdown) }}
            />
          )}
        </div>
      )}
    </div>
  );
}
