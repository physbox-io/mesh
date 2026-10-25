import type React from 'react';
import { X } from 'lucide-react';
import { useStore } from '../../store/useStore';
import { usePanels } from '../../store/panelsStore';
import { useDialogs } from '../../store/dialogStore';
import { HARDWARE_KINDS } from '../../utils/hardwareCuts';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { findNodeById, getNodeWorldPos } from '../../utils/sceneTree';
import { sourcePositiveBounds } from '../../utils/csg';
import { HierarchyTree } from '../HierarchyTree';
import ColoringSection from '../ColoringSection';
import { ComponentPalette, type PaletteComponentType } from './ComponentPalette';

const handleDragStart = (e: React.DragEvent, type: string) => {
  e.dataTransfer.setData('type', type);
};

/**
 * The left column: the hierarchy, the parts palette and colouring. A
 * permanent column from `md` up; below that, a drawer over the workspace that
 * gets out of the way once something has been picked from it.
 *
 * The collapse effect in App finds this panel by `aside.glass-panel` and each
 * section by its `div > h3`, so the root stays that aside and the palette's
 * section headings stay direct children of their own divs.
 */
export function LeftSidebar({ onAddNoteCard }: { onAddNoteCard: () => void }) {
  const isOpen = usePanels((s) => s.isLeftSidebarOpen);
  const setOpen = usePanels((s) => s.setLeftSidebarOpen);
  const coarsePointer = useCoarsePointer();
  const selectedNode = useStore((s) => (s.selectedNodeId ? findNodeById(s.sceneGraph.nodes, s.selectedNodeId) : null));
  const addComponent = useStore((s) => s.addComponent);
  const addHardwareComponentNode = useStore((s) => s.addHardwareComponentNode);
  const close = () => setOpen(false);

  // A clicked part goes under the selected body, beside it (or below it, for
  // the things that hang); with nothing selected, just above the floor.
  const handleAddComponentClick = (type: PaletteComponentType) => {
    const { selectedNodeId, sceneGraph } = useStore.getState();
    if (selectedNodeId && findNodeById(sceneGraph.nodes, selectedNodeId)) {
      const worldPos = getNodeWorldPos(sceneGraph.nodes, selectedNodeId) || [0, 0, 0];
      const offset = (type === 'capsule' || type === 'bob') ? [0, 0, -0.6] : [0.5, 0, 0];
      addComponent(type, [worldPos[0] + offset[0], worldPos[1] + offset[1], worldPos[2] + offset[2]], selectedNodeId);
    } else {
      addComponent(type, [0, 0, 0.15]); // Spawn slightly above floor
    }
    close();
  };

  /**
   * Adds a box on the grid and opens the lattice tools on it.
   *
   * Nobody adds a lattice body in order to look at a cube, and leaving them to
   * go and find the tools afterwards makes two steps out of one intent.
   */
  const handleAddLatticeClick = () => {
    // At the origin, so the empty grid it opens on is centred there.
    const id = addComponent('lattice', [0, 0, 0], useStore.getState().selectedNodeId);
    close();
    useStore.getState().setLatticeNodeId(id);
  };

  /** Adds a ball of clay and opens the sculpt tools on it, for the same reason. */
  const handleAddSculptClick = () => {
    const id = addComponent('sculpt', [0, 0, 0.2], useStore.getState().selectedNodeId);
    close();
    useStore.getState().setSculptNodeId(id);
  };

  return (
    <>
      {/* Mobile Sidebar Backdrop Scrim. Covers the workspace, not the whole
          page: the header above it stays live, so the hamburger that opened
          the drawer is still the thing that closes it. */}
      {isOpen && (
        <div
          onClick={close}
          className="absolute inset-0 bg-slate-900/20 backdrop-blur-xs z-[115] md:hidden"
        />
      )}

      {/* Left Sidebar.
          `absolute inset-y-0` against the workspace, not `fixed inset-y-14`:
          below `lg` the header wraps onto as many rows as its contents need,
          so its height is not knowable here and anything pinned 3.5rem from
          the top of the page tucks under a two-row navbar. */}
      <aside className={`w-64 md:w-56 max-w-[85vw] shrink-0 glass-panel border-r border-slate-200 dark:border-slate-800 flex flex-col p-4 bg-white/90 dark:bg-slate-900/90 overflow-y-auto transition-transform duration-200 ease-in-out absolute md:relative inset-y-0 md:inset-auto left-0 z-20 max-md:z-[120] shadow-xl md:shadow-none ${
        isOpen ? 'flex translate-x-0' : 'hidden md:flex -translate-x-full md:translate-x-0'
      }`}>
        <div className="flex items-center justify-between mb-2.5">
          <h2 className="text-[10px] font-bold text-slate-400 dark:text-slate-500 uppercase tracking-wider">Hierarchy</h2>
          {/* As an overlay the drawer covers the model, so it carries its own
              way out rather than relying on the hamburger it came from. */}
          <button
            onClick={close}
            className="md:hidden p-1 -m-1 rounded text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            title="Close the hierarchy panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <HierarchyTree />

        <ComponentPalette
          coarsePointer={coarsePointer}
          selectedNodeName={selectedNode ? selectedNode.name : null}
          onDragStart={handleDragStart}
          onAddComponent={handleAddComponentClick}
          onAddSculpt={handleAddSculptClick}
          onAddLattice={handleAddLatticeClick}
          onAddHardwareNode={(node) => {
            addHardwareComponentNode(node);
            close();
          }}
          hardwareTarget={selectedNode && sourcePositiveBounds(selectedNode) ? selectedNode.name : null}
          onAddHardwareCut={(kind) => {
            if (!selectedNode) return;
            if (!useStore.getState().addHardwareCut(selectedNode.id, kind)) {
              // An O-ring groove with no room where it was asked for says why.
              const why = useStore.getState().hardwareCutProblemAt(selectedNode.id, kind);
              if (why) useDialogs.getState().showNotice(`No room for the ${HARDWARE_KINDS[kind].label.toLowerCase()} here`, why);
            }
            close();
          }}
          onAddHardwarePart={(kind) => {
            const { selectedNodeId, sceneGraph } = useStore.getState();
            // Runners go on a drawer, a pair at a time, sized to it.
            if (kind === 'drawer_runner' && selectedNodeId && !findNodeById(sceneGraph.nodes, selectedNodeId)?.hardwarePart) {
              const fitted = useStore.getState().addDrawerRunners(selectedNodeId);
              if (typeof fitted === 'string') useDialogs.getState().showNotice('No runners for that', fitted);
              close();
              return;
            }
            const at = selectedNodeId ? getNodeWorldPos(sceneGraph.nodes, selectedNodeId) : null;
            // Beside what is selected when it does not go into it, else just above the floor.
            useStore.getState().addHardwarePart(kind, at ? [at[0] + 0.05, at[1], at[2]] : [0, 0, 0.03], selectedNodeId);
            close();
          }}
          onAddNoteCard={() => {
            onAddNoteCard();
            close();
          }}
        />

        {/* Colour, which is looks only — see ColoringSection. */}
        <ColoringSection onArmed={close} />
      </aside>
    </>
  );
}
