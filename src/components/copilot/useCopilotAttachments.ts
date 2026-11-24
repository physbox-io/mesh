// The pictures waiting to go with the next copilot request: pasted, dropped
// on the prompt, or picked. One set per prompt box (the request box and the
// chat box each have their own). The tray that shows them is CopilotAttachments.tsx.

import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import type { LlmImage } from '../../utils/llmCall';
import { fileToLlmImage } from '../../utils/llmImageInput';

/** More than this is more tokens than help: front, side, top and a detail. */
export const MAX_COPILOT_IMAGES = 4;

export function useCopilotAttachments() {
  const [images, setImages] = useState<LlmImage[]>([]);
  const imagesCountRef = useRef(0);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    const allPictures = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (!allPictures.length) return false;

    const remaining = Math.max(0, MAX_COPILOT_IMAGES - imagesCountRef.current);
    if (remaining === 0) {
      setAttachError(`Up to ${MAX_COPILOT_IMAGES} pictures per request; remove one before adding more.`);
      return true;
    }

    const overflow = allPictures.length > remaining;
    const toDecode = allPictures.slice(0, remaining);
    setAttachError(null);

    const results = await Promise.allSettled(toDecode.map((f) => fileToLlmImage(f)));
    const decoded: LlmImage[] = [];
    const errors: string[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        decoded.push(r.value);
      } else {
        errors.push((r.reason as Error)?.message || String(r.reason));
      }
    }

    let clippedByState = false;
    if (decoded.length > 0) {
      setImages((prev) => {
        const next = [...prev, ...decoded];
        if (next.length > MAX_COPILOT_IMAGES) clippedByState = true;
        const clamped = next.slice(0, MAX_COPILOT_IMAGES);
        imagesCountRef.current = clamped.length;
        return clamped;
      });
    }

    const notices: string[] = [];
    if (overflow || clippedByState) {
      notices.push(`Up to ${MAX_COPILOT_IMAGES} pictures per request; the rest were left off.`);
    }
    if (errors.length > 0) {
      notices.push(
        errors.length === 1
          ? errors[0]
          : `${errors.length} pictures could not be decoded (${errors[0]}).`,
      );
    }
    if (notices.length > 0) {
      setAttachError(notices.join(' '));
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

  const remove = (i: number) => setImages((prev) => {
    const next = prev.filter((_, k) => k !== i);
    imagesCountRef.current = next.length;
    return next;
  });
  /** Hands the pictures to a request and empties the tray. */
  const take = (): LlmImage[] => {
    const out = images;
    imagesCountRef.current = 0;
    setImages([]);
    setAttachError(null);
    return out;
  };

  return { images, attachError, addFiles, onPaste, dropProps, remove, take };
}

export type CopilotAttachments = ReturnType<typeof useCopilotAttachments>;
