// The pictures waiting to go with the next copilot request: pasted, dropped
// on the prompt, or picked. One set for the panel, sent with whichever box
// sends next. The tray that shows them is CopilotAttachments.tsx.

import type React from 'react';
import { useCallback, useState } from 'react';
import type { LlmImage } from '../../utils/llmCall';
import { fileToLlmImage } from '../../utils/llmImageInput';

/** More than this is more tokens than help: front, side, top and a detail. */
export const MAX_COPILOT_IMAGES = 4;

export function useCopilotAttachments() {
  const [images, setImages] = useState<LlmImage[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    // Only as many as there is room for, before decoding any: ten phone photos are a lot of pixels.
    const pictures = Array.from(files).filter((f) => f.type.startsWith('image/')).slice(0, MAX_COPILOT_IMAGES);
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

  /**
   * For a textarea's onPaste: takes pictures, leaves text to the textarea.
   * Cells copied from a spreadsheet or a paragraph from Word come with a
   * picture of themselves as well; the text is what was meant.
   */
  const onPaste = useCallback((e: React.ClipboardEvent) => {
    if ((e.clipboardData?.getData('text/plain') ?? '').trim()) return;
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
