import { Box, Grid3x3, Aperture } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../../store/useStore';
import { useViewQuality } from '../../store/viewQualityStore';

/** The floating buttons at the viewport's bottom right: camera views, overlays, render modes, grid size. */
export function ViewControls() {
  const pathTrace = useViewQuality(s => s.pathTrace);
  const setPathTrace = useViewQuality(s => s.setPathTrace);
  const {
    cameraView, setCameraView,
    dimsEnabled, setDimsEnabled, cameraOffAxis,
    dfmEnabled, setDfmEnabled,
    wireframe, toggleWireframe, showEdges, toggleShowEdges,
    gridCellSizeMm, setGridCellSizeMm,
  } = useStore(useShallow((s) => ({
    cameraView: s.cameraView, setCameraView: s.setCameraView,
    dimsEnabled: s.dimsEnabled, setDimsEnabled: s.setDimsEnabled, cameraOffAxis: s.cameraOffAxis,
    dfmEnabled: s.dfmEnabled, setDfmEnabled: s.setDfmEnabled,
    wireframe: s.wireframe, toggleWireframe: s.toggleWireframe, showEdges: s.showEdges, toggleShowEdges: s.toggleShowEdges,
    gridCellSizeMm: s.gridCellSizeMm, setGridCellSizeMm: s.setGridCellSizeMm,
  })));
  return (
    <div className="absolute bottom-4 right-4 z-10 flex items-center gap-1 bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border border-slate-200 dark:border-slate-800 p-1 rounded-lg shadow-sm">
      {([
        ['perspective', 'Perspective', 'The free view'],
        ['topDown', 'Top Down', 'Looking straight down, drawn flat (orthographic)'],
        ['front', 'Front', 'Looking at the front, drawn flat (orthographic)'],
        ['side', 'Side', 'Looking at the right-hand side, drawn flat (orthographic)'],
      ] as const).map(([view, label, title]) => (
        <button
          key={view}
          onClick={() => setCameraView(view)}
          title={title}
          className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer ${
            // Orbited off a drawing view, its button is no longer lit:
            // the view on screen is not that one, and a click puts it back.
            cameraView === view && !(view !== 'perspective' && cameraOffAxis)
              ? 'bg-blue-500 text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          {label}
        </button>
      ))}
      {/* Only in the flat views: a dimension means something there at
          every depth, and the overlay draws nothing anywhere else. */}
      {cameraView !== 'perspective' && (
        <button
          onClick={() => setDimsEnabled(!dimsEnabled)}
          title="Dimensions in mm for the selected part, or every part when none is selected"
          className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer ${
            dimsEnabled
              ? 'bg-amber-500 text-white shadow-xs'
              : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
          }`}
        >
          Dims
        </button>
      )}
      {/* Checks the selected part against how it will actually be made.
          No process picker: the machine and the material are already
          chosen in the bottom bar, and asking again is how two controls
          end up disagreeing. */}
      <button
        onClick={() => setDfmEnabled(!dfmEnabled)}
        title="Checks the selected part against the machine and material on the bench: what a printer cannot support, what a router cannot reach."
        className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1 ${
          dfmEnabled
            ? 'bg-amber-500 text-white shadow-xs'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
      >
        DFM
      </button>
      <button
        onClick={() => toggleWireframe()}
        title="Draw every body as the edges of its triangles. Shows the tessellation a slicer or CAM job receives, and lets you see through the model."
        className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1 ${
          wireframe
            ? 'bg-violet-500 text-white shadow-xs'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
      >
        <Grid3x3 className="w-3 h-3" />
        Wireframe
      </button>
      <button
        onClick={() => toggleShowEdges()}
        title="Draw a line along every real corner, so two faces lit the same still read as two. Only edges sharper than about 20°."
        className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1 ${
          showEdges
            ? 'bg-violet-500 text-white shadow-xs'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
      >
        <Box className="w-3 h-3" />
        Edges
      </button>
      <button
        onClick={() => setPathTrace(!pathTrace)}
        title="Path trace the view whenever it is still: real soft shadows and reflections. Uses the whole GPU until the image settles, so leave it off while working."
        className={`px-2.5 py-1 rounded text-[10px] font-bold tracking-wide transition-all cursor-pointer flex items-center gap-1 ${
          pathTrace
            ? 'bg-violet-500 text-white shadow-xs'
            : 'text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800'
        }`}
      >
        <Aperture className="w-3 h-3" />
        Render
      </button>
      <select
        value={gridCellSizeMm}
        onChange={(e) => setGridCellSizeMm(parseFloat(e.target.value))}
        title="Grid cell size (display only; does not change any body's dimensions)"
        className="px-1.5 py-1 rounded text-[10px] font-bold tracking-wide bg-transparent text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer outline-none border-none"
      >
        <option value={1}>1mm grid</option>
        <option value={10}>10mm grid</option>
        <option value={100}>100mm grid</option>
      </select>

    </div>
  );
}
