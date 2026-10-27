import { useStore } from '../store/useStore';
import { usePanels } from '../store/panelsStore';
import { ImportStlModal } from './ImportStlModal';
import { ImportImageModal } from './ImportImageModal';
import { GeneratePatternModal } from './GeneratePatternModal';
import { MechanismBuilderModal } from './MechanismBuilderModal';
import { ImportPcbModal } from './ImportPcbModal';

/** The STL, image and PCB importers, the pattern generators, and the gears builder. */
export function ImportModals() {
  const stlImport = usePanels((s) => s.stlImport);
  const imageImport = usePanels((s) => s.imageImport);
  const closeStlImport = usePanels((s) => s.closeStlImport);
  const closeImageImport = usePanels((s) => s.closeImageImport);
  const isMechanismBuilderOpen = usePanels((s) => s.isMechanismBuilderOpen);
  const setMechanismBuilderOpen = usePanels((s) => s.setMechanismBuilderOpen);
  const isPcbImportOpen = usePanels((s) => s.isPcbImportOpen);
  const setPcbImportOpen = usePanels((s) => s.setPcbImportOpen);
  return (
    <>
      {/* Import STL Modal — mounted only while open so each import starts clean */}
      {stlImport && (
      <ImportStlModal
        isOpen
        initialFile={stlImport.file}
        onClose={closeStlImport}
        onImportNode={(newNode) => {
          const currentNodes = useStore.getState().sceneGraph.nodes || [];
          useStore.getState().updateScene({ ...useStore.getState().sceneGraph, nodes: [...currentNodes, newNode] });
        }}
      />
      )}

      {/* Surface pattern generators. Reads its own open/closed state from the
          store, so there is nothing to pass and nothing to keep in step. */}
      <GeneratePatternModal />

      {/* Image heightmap importer — mounted only while open, like the STL one */}
      {imageImport && (
      <ImportImageModal
        isOpen
        initialFile={imageImport.file}
        onClose={closeImageImport}
        onImportNode={(newNode) => {
          const currentNodes = useStore.getState().sceneGraph.nodes || [];
          useStore.getState().updateScene({ ...useStore.getState().sceneGraph, nodes: [...currentNodes, newNode] });
        }}
      />
      )}

      {isMechanismBuilderOpen && (
        <MechanismBuilderModal onClose={() => setMechanismBuilderOpen(false)} />
      )}

      {isPcbImportOpen && (
        <ImportPcbModal onClose={() => setPcbImportOpen(false)} />
      )}
    </>
  );
}
