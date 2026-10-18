import { Sparkles, Type } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { usePanels } from '../../store/panelsStore';
import type { SceneNode } from '../../types/scene';

/**
 * The Texture tab's way in: arms the same click-a-face pick as the mode
 * menu's "Pattern a face" (T), so laying a pattern needs neither the key nor
 * the pointer already over the face.
 */
export function TextureTabIntro({ node }: { node: SceneNode }) {
  // The mode menu offers it on the same terms: not while the lattice or
  // sculpt tools have the part.
  const busy = useStore((s) => !!s.latticeNodeId || !!s.sculptNodeId);
  const setPropertiesOpen = usePanels((s) => s.setPropertiesOpen);
  const patterned = (node.geoms ?? []).some((g) => g.textures?.length);
  const arm = (kind: 'pattern' | 'text') => {
    // On a phone the drawer covers the model; put it away so the face can be clicked.
    setPropertiesOpen(false);
    window.dispatchEvent(new CustomEvent('physbox:gesture', { detail: { kind } }));
  };

  return (
    <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-sm flex flex-col gap-2">
      <button
        onClick={() => arm('pattern')}
        disabled={busy}
        className="flex items-center justify-center gap-2 w-full py-2 border border-fuchsia-200 rounded-lg text-xs font-semibold text-fuchsia-700 bg-fuchsia-50 hover:bg-fuchsia-100 hover:border-fuchsia-300 disabled:opacity-40 transition-colors shadow-sm cursor-pointer"
        title="Then click the face of this part to carve or emboss a pattern into"
      >
        <Sparkles className="w-4 h-4" /> Pattern a face…
      </button>
      <button
        onClick={() => arm('text')}
        disabled={busy}
        className="flex items-center justify-center gap-2 w-full py-2 border border-fuchsia-200 rounded-lg text-xs font-semibold text-fuchsia-700 bg-white hover:bg-fuchsia-50 hover:border-fuchsia-300 disabled:opacity-40 transition-colors shadow-sm cursor-pointer"
        title="Then click the face of this part to engrave or emboss lettering on (Shift+T)"
      >
        <Type className="w-4 h-4" /> Text on a face…
      </button>
      <p className="text-[10px] text-slate-400 leading-snug">
        {busy
          ? 'Finish with the lattice or sculpt tools first.'
          : patterned
            ? 'Click it, then a face of the part. Click a patterned face to change its pattern.'
            : 'Click it, then a face of the part to carve or emboss a pattern into it.'}
      </p>
    </div>
  );
}
