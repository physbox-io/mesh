// Pictures attached to the next copilot request: pasted, dropped on the
// prompt, or picked. One set for the panel, sent with whichever box sends next.

import React, { useCallback, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import type { LlmImage } from '../../utils/llmCall';
import { fileToLlmImage, llmImageUrl } from '../../utils/llmImageInput';

/** More than this is more tokens than help: front, side, top and a detail. */
export const MAX_COPILOT_IMAGES = 4;

export function useCopilotAttachments() {
  const [images, setImages] = useState<LlmImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    const pictures = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!pictures.length) return false;
    setAttachError(null);
    try {
      const decoded = await Promise.all(pictures.map((f) => fileToLlmImage(f)));
      setImages((prev) => {
        const next = [...prev, ...decoded];
        if (next.length > MAX_COPILOT_IMAGES) setAttachError(`Up to ${MAX_COPILOT_IMAGES} pictures per request; the rest were left off.`);
        return next.slice(0, MAX_COPILOT_IMAGES);
      });
    } catch (e) {
      setAttachError((e as Error)?.message || String(e));
    }
    return true;
  }, []);

  /** For a textarea's onPaste: takes pictures, leaves text to the textarea. */
  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      void addFiles(files);
    }
  }, [addFiles]);

  /** Drop props for a prompt box. Stops the drop reaching the viewport's importers. */
  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      if (Array.from(e.dataTransfer.items).some((i) => i.kind === 'file')) { e.preventDefault(); e.stopPropagation(); }
    },
    onDrop: (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer.files);
      if (files.some((f) => f.type.startsWith('image/'))) {
        e.preventDefault();
        e.stopPropagation();
        void addFiles(files);
      }
    },
  };

  const remove = (i: number) => setImages((prev) => prev.filter((_, k) => k !== i));
  /** Hands the pictures to a request and empties the tray. */
  const take = (): LlmImage[] => {
    const out = images;
    setImages([]);
    setAttachError(null);
    return out;
  };

  return { images, attachError, addFiles, onPaste, dropProps, remove, take };
}

export type CopilotAttachments = ReturnType<typeof useCopilotAttachments>;

/** The paperclip button and the thumbnails waiting to go. */
export const CopilotAttachmentTray: React.FC<{ att: CopilotAttachments; disabled?: boolean }> = ({ att, disabled }) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <input ref={input} type="file" accept="image/*" multiple className="hidden"
        onChange={(e) => { void att.addFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
      <button type="button" disabled={disabled || att.images.length >= MAX_COPILOT_IMAGES}
        onClick={() => input.current?.click()}
        title="Attach a picture: a photo, a sketch with dimensions written on it, a drawing. You can also paste or drop one on the box."
        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-semibold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40 transition-colors cursor-pointer">
        <ImagePlus className="w-3.5 h-3.5" /> Picture
      </button>
      {att.images.map((im, i) => (
        <div key={i} className="relative">
          <img src={llmImageUrl(im)} alt={`Attached picture ${i + 1}`} className="w-10 h-10 object-cover rounded-md border border-slate-200 dark:border-slate-700" />
          <button type="button" aria-label="Remove picture" onClick={() => att.remove(i)}
            className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-700 text-white flex items-center justify-center cursor-pointer">
            <X className="w-2.5 h-2.5" />
          </button>
        </div>
      ))}
      {att.attachError && <span className="text-[10px] text-amber-600 dark:text-amber-400">{att.attachError}</span>}
    </div>
  );
};
