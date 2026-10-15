import { useCallback, useState } from 'react';
import { SlidersHorizontal, Trash2, X } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { usePanels } from '../../store/panelsStore';
import { useSelectedNode } from '../../hooks/useSelectedNode';
import { InspectorCards } from './InspectorCards';

/**
 * The properties inspector on the right: the drawer, its resize handle and its
 * header, the cards and the Delete button.
 */
export function InspectorPanel() {
  const selectedNode = useSelectedNode();
  const isPlaying = useStore((s) => s.isPlaying);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  const deleteNode = useStore((s) => s.deleteNode);
  const isPropertiesOpen = usePanels((s) => s.isPropertiesOpen);
  const setIsPropertiesOpen = usePanels((s) => s.setPropertiesOpen);
  const [propertiesWidth, setPropertiesWidth] = useState(380);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const handleMouseMove = (moveEvent: MouseEvent) => {
      const newWidth = window.innerWidth - moveEvent.clientX;
      if (newWidth >= 280 && newWidth <= 800) {
        setPropertiesWidth(newWidth);
      }
    };
    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, []);

  return (
    <>
      {/* Dimmer behind the inspector drawer. Only exists below `lg`, where
          the inspector is an overlay; tapping the model puts it away. */}
      {isPropertiesOpen && selectedNode && !isPlaying && (
        <div
          className="lg:hidden absolute inset-0 z-[105] bg-slate-950/30"
          onClick={() => setIsPropertiesOpen(false)}
        />
      )}

      {/* Contextual Properties Sidebar. Nothing is editable while the
          simulation runs, so it stays away rather than sliding in whenever a
          body is clicked; the selection survives, and the panel comes back
          with it when the run stops. */}
      {selectedNode && !isPlaying && (
        /*
          Below `lg` there is not room for a permanent 380px column beside a
          3D viewport, so the inspector slides in over it instead.

          Written as `max-lg:` overrides on top of the original classes, so
          that at desktop width this element carries exactly what it always
          did — in particular no stray transform, which would otherwise make
          the aside a containing block and re-anchor the absolutely
          positioned popovers inside it. The drag-to-resize width is an
          inline style, so the mobile width has to out-rank it explicitly.
        */
        <aside
          style={{ width: `${propertiesWidth}px` }}
          className={`shrink-0 glass-panel border-l border-slate-200 dark:border-slate-800 flex flex-col p-4 z-20 bg-white/55 dark:bg-slate-900/55 overflow-y-auto relative max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-[110] max-lg:w-80! max-lg:max-w-[80vw] max-lg:shadow-xl max-lg:bg-white/95 max-lg:dark:bg-slate-900/95 max-lg:transition-transform max-lg:duration-200 ${
            // Below `lg` the drawer waits off the right-hand edge until it is
            // asked for. `pointer-events-none` as well as the translate, so a
            // panel parked off screen cannot swallow taps meant for the model.
            isPropertiesOpen ? 'max-lg:translate-x-0' : 'max-lg:translate-x-full max-lg:pointer-events-none'
          }`}
        >
          {/* Elegant Resize Handle */}
          <div
            onMouseDown={handleMouseDown}
            className="absolute top-0 left-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/20 active:bg-blue-500/40 transition-colors z-20 group hidden lg:flex items-center justify-center"
            title="Drag to resize panel"
          >
            <div className="w-[2px] h-8 bg-slate-300 dark:bg-slate-700 group-hover:bg-blue-500 group-active:bg-blue-600 rounded transition-colors" />
          </div>

          <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4 flex items-center justify-between">
            <span className="flex items-center gap-2"><SlidersHorizontal className="w-4 h-4" /> Properties</span>
            {/* Closes the drawer and leaves the component selected: the top
                bar's bin, undo and the keyboard all act on the selection, so
                putting the panel away must not throw that away too. The
                desktop column has nowhere to go, so there its X deselects,
                exactly as it always did. */}
            <button
              onClick={() => setIsPropertiesOpen(false)}
              className="lg:hidden cursor-pointer"
              title="Close Properties"
            >
              <X className="w-4 h-4 text-slate-400 hover:text-slate-600" />
            </button>
            <button onClick={() => setSelectedNodeId(null)} className="hidden lg:block cursor-pointer" title="Deselect"><X className="w-4 h-4 text-slate-400 hover:text-slate-600" /></button>
          </h2>

          <div className="flex flex-col gap-4">
            <InspectorCards node={selectedNode} />

            {/* Delete Component Button */}
            <button
              onClick={() => deleteNode(selectedNode.id)}
              className="mt-2 flex items-center justify-center gap-2 w-full py-2 border border-red-200 rounded-lg text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 hover:border-red-300 transition-colors shadow-sm cursor-pointer"
            >
              <Trash2 className="w-4 h-4" /> Delete Component
            </button>
          </div>
        </aside>
      )}
    </>
  );
}
