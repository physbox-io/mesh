import { useRef, useState } from 'react';
import { ChevronDown, Eye, EyeOff, Frame, ImagePlus, Trash2 } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { useDialogs } from '../store/dialogStore';
import type { ReferenceImage, ReferencePlane } from '../types/scene';
import { REFERENCE_PLANES, referenceHeight } from '../utils/referenceImages';
import { addReferencePicture } from '../utils/addReferencePicture';

const PLANE_LABEL: Record<ReferencePlane, string> = { front: 'Front', side: 'Side', top: 'Top' };
const AXES = ['X', 'Y', 'Z'] as const;

/**
 * The scene's reference images, over the viewport above the view buttons.
 * Mounted only while the scene has one; they are added from the palette's Others.
 *
 * Every field writes straight through so the picture moves as you type or
 * drag. Focusing a field or pressing on the slider arms one undo step, taken
 * with the first change that follows: the store drops a step that nothing
 * changes in the same tick, so it cannot be taken on focus itself.
 */
export function ReferenceImagesCard() {
  const images = useStore((s) => s.sceneGraph.referenceImages);
  const [open, setOpen] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const showNotice = useDialogs((s) => s.showNotice);
  const armed = useRef(false);
  if (!images?.length) return null;

  const write = (id: string, patch: Partial<ReferenceImage>, recordUndo: boolean) => {
    const list = useStore.getState().sceneGraph.referenceImages ?? [];
    useStore.getState().setReferenceImages(list.map((r) => (r.id === id ? { ...r, ...patch } : r)), recordUndo);
  };
  const beginEdit = () => { armed.current = true; };
  /** A frame of a continuous edit: the first after beginEdit is the undo step. */
  const drag = (id: string, patch: Partial<ReferenceImage>) => {
    write(id, patch, armed.current);
    armed.current = false;
  };

  return (
    <div className="absolute bottom-16 right-4 z-10 w-64 rounded-xl border border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-slate-900/95 shadow-lg backdrop-blur-md text-xs">
      <div className="flex items-center gap-1.5 px-2.5 py-1.5 border-b border-slate-100 dark:border-slate-800">
        <Frame className="w-3.5 h-3.5 text-fuchsia-500" />
        <span className="font-semibold text-slate-700 dark:text-slate-200 flex-1">Reference</span>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
          title="Add another picture"
        >
          <ImagePlus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
          title={open ? 'Collapse' : 'Expand'}
        >
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? '' : '-rotate-90'}`} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) addReferencePicture(file).catch((err) => showNotice('Could not add the picture', String(err?.message ?? err), 'amber'));
          }}
        />
      </div>
      {open && (
        <div className="max-h-[50vh] overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800">
          {images.map((img) => (
            <div key={img.id} className="p-2.5 flex flex-col gap-2">
              <div className="flex items-center gap-1.5">
                <span className="flex-1 truncate font-medium text-slate-600 dark:text-slate-300" title={img.name}>{img.name}</span>
                <button
                  type="button"
                  onClick={() => write(img.id, { hidden: !img.hidden }, true)}
                  className="p-1 rounded hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-500 cursor-pointer"
                  title={img.hidden ? 'Show' : 'Hide'}
                >
                  {img.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
                <button
                  type="button"
                  onClick={() => useStore.getState().setReferenceImages(images.filter((r) => r.id !== img.id))}
                  className="p-1 rounded hover:bg-red-50 dark:hover:bg-red-950/40 text-slate-400 hover:text-red-500 cursor-pointer"
                  title="Remove this picture. Ctrl+Z brings it back."
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="grid grid-cols-3 gap-1" role="radiogroup" aria-label="View">
                {REFERENCE_PLANES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="radio"
                    aria-checked={img.plane === p}
                    onClick={() => img.plane !== p && write(img.id, { plane: p }, true)}
                    className={`py-1 rounded-md border text-[10px] font-semibold cursor-pointer ${
                      img.plane === p
                        ? 'bg-fuchsia-50 border-fuchsia-400 text-fuchsia-700 dark:bg-fuchsia-950/40 dark:text-fuchsia-300'
                        : 'border-slate-200 dark:border-slate-700 text-slate-500 hover:border-slate-300'
                    }`}
                    title={`Stand the picture in the ${PLANE_LABEL[p].toLowerCase()} view's plane`}
                  >
                    {PLANE_LABEL[p]}
                  </button>
                ))}
              </div>

              <label className="flex items-center gap-2 text-slate-500">
                <span className="w-14">Opacity</span>
                <input
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={img.opacity}
                  onPointerDown={beginEdit}
                  onKeyDown={beginEdit}
                  onChange={(e) => drag(img.id, { opacity: Number(e.target.value) })}
                  className="flex-1 accent-fuchsia-500"
                />
                <span className="w-8 text-right tabular-nums">{Math.round(img.opacity * 100)}%</span>
              </label>

              <label className="flex items-center gap-2 text-slate-500" onFocusCapture={beginEdit}>
                <span className="w-14">Width</span>
                <NumberInput
                  value={+(img.width * 1000).toFixed(2)}
                  min={1}
                  max={20000}
                  onChange={(v) => v !== undefined && v > 0 && drag(img.id, { width: v / 1000 })}
                  className="w-20 px-1.5 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-transparent tabular-nums"
                />
                <span className="text-slate-400 tabular-nums">mm × {(referenceHeight(img) * 1000).toFixed(1)}</span>
              </label>

              <div className="flex items-center gap-2 text-slate-500" onFocusCapture={beginEdit}>
                <span className="w-14" title="Centre of the picture">Centre</span>
                <div className="flex-1 grid grid-cols-3 gap-1">
                  {AXES.map((a, i) => (
                    <NumberInput
                      key={a}
                      aria-label={`Centre ${a} (mm)`}
                      title={`${a}, mm`}
                      value={+(img.pos[i] * 1000).toFixed(2)}
                      onChange={(v) => {
                        if (v === undefined) return;
                        const pos = [...img.pos] as [number, number, number];
                        pos[i] = v / 1000;
                        drag(img.id, { pos });
                      }}
                      className="w-full px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-transparent tabular-nums"
                    />
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 text-slate-500 cursor-pointer" title="Draw the picture over the model so you can trace it. Off, the model hides it.">
                <input
                  type="checkbox"
                  checked={img.overlay}
                  onChange={(e) => write(img.id, { overlay: e.target.checked }, true)}
                  className="accent-fuchsia-500"
                />
                Show over the model
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
