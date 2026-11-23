import { Suspense, lazy } from 'react';
import { useStore } from '../store/useStore';
import { usePanels } from '../store/panelsStore';
import { usePcbHandoffLink } from '../hooks/usePcbHandoffLink';

// Heavy import & generator dialogs are code-split out of the cold-start entry.
const ImportStlModal = lazy(() =>
  import('./ImportStlModal').then((m) => ({ default: m.ImportStlModal })),
);
const ImportImageModal = lazy(() =>
  import('./ImportImageModal').then((m) => ({ default: m.ImportImageModal })),
);
const ImportProfileModal = lazy(() =>
  import('./ImportProfileModal').then((m) => ({ default: m.ImportProfileModal })),
);
const GeneratePatternModal = lazy(() =>
  import('./GeneratePatternModal').then((m) => ({ default: m.GeneratePatternModal })),
);
const MechanismBuilderModal = lazy(() =>
  import('./MechanismBuilderModal').then((m) => ({ default: m.MechanismBuilderModal })),
);
const ImportPcbModal = lazy(() =>
  import('./ImportPcbModal').then((m) => ({ default: m.ImportPcbModal })),
);

/** The STL, image and PCB importers, the pattern generators, and the gears builder. */
export function ImportModals() {
  const stlImport = usePanels((s) => s.stlImport);
  const imageImport = usePanels((s) => s.imageImport);
  const closeStlImport = usePanels((s) => s.closeStlImport);
  const closeImageImport = usePanels((s) => s.closeImageImport);
  const profileImport = usePanels((s) => s.profileImport);
  const closeProfileImport = usePanels((s) => s.closeProfileImport);
  const isMechanismBuilderOpen = usePanels((s) => s.isMechanismBuilderOpen);
  const setMechanismBuilderOpen = usePanels((s) => s.setMechanismBuilderOpen);
  const isPcbImportOpen = usePanels((s) => s.isPcbImportOpen);
  const setPcbImportOpen = usePanels((s) => s.setPcbImportOpen);
  const pcbHandoff = usePanels((s) => s.pcbHandoff);
  const patternGeneratorId = useStore((s) => s.patternGeneratorId);
  usePcbHandoffLink();
  return (
    <Suspense fallback={null}>
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

      {/* Surface pattern generators — mounted only once a pattern board is selected. */}
      {patternGeneratorId && <GeneratePatternModal />}

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

      {/* SVG / traced-outline importer — mounted only while open, like the others */}
      {profileImport && (
        <ImportProfileModal
          initialFile={profileImport.file}
          onClose={closeProfileImport}
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
        <ImportPcbModal
          key={pcbHandoff ?? 'preset'}
          onClose={() => setPcbImportOpen(false)}
          {...(pcbHandoff ? { initialSpec: pcbHandoff } : {})}
        />
      )}
    </Suspense>
  );
}
