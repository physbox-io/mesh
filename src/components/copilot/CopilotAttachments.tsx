// The paperclip button and the thumbnails of pictures waiting to go with the
// next copilot request. The state is useCopilotAttachments.ts.

import React, { useRef } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { llmImageUrl } from '../../utils/llmImageInput';
import { MAX_COPILOT_IMAGES, type CopilotAttachments } from './useCopilotAttachments';

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
