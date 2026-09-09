// ---------------------------------------------------------------------------
// The lattice tool palette
// ---------------------------------------------------------------------------
//
// Same rule as the sculpting palette: the hand and the eyes are on the model,
// so everything here is on a key and the panel is for the things a person
// cannot see by looking at the viewport.
//
// Two of those matter. The first is which slice of the grid clicks are landing
// on — the readout is the whole reason the mode is usable, because a plane
// three steps behind where you think it is puts every point in the wrong place
// and looks perfectly reasonable from the front. The second is whether the
// surface has closed, which decides whether this shape can be printed or
// machined and which nothing in the viewport shows.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import {
  PenLine, MousePointer2, MoveVertical, Grid3x3, FlipHorizontal2,
  Boxes, TriangleAlert, Check, Spline, Scissors, Layers, Lock,
} from 'lucide-react';
import { useStore } from '../store/useStore';
import type { SceneNode } from '../types/scene';
import { SNAP_MULTIPLES, type Axis, type LatticeTool, type SnapMultiple } from '../utils/latticeMesh';

interface ToolDefinition {
  tool: LatticeTool;
  label: string;
  key: string;
  icon: typeof PenLine;
  hint: string;
}

const TOOLS: ToolDefinition[] = [
  { tool: 'place', label: 'Place', key: '1', icon: PenLine, hint: 'Click grid points to draw a face. Four corners closes it automatically; Enter closes a triangle; Esc abandons it.' },
  { tool: 'select', label: 'Select', key: '2', icon: MousePointer2, hint: 'Drag a corner to move it; click a face or an edge to select it. L grows an edge to its whole loop, S keeps it sharp under smoothing (on a face, its whole border), F turns a face inside out.' },
  { tool: 'extrude', label: 'Extrude', key: '3', icon: MoveVertical, hint: 'Drag a face along its own axis to push it out in whole grid steps — the fastest way to get from a plate to a solid.' },
];

const AXES: Axis[] = ['x', 'y', 'z'];

const panelClass =
  'absolute top-20 left-4 z-30 w-60 rounded-xl border border-slate-200 dark:border-slate-800 ' +
  'bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-lg p-3 space-y-3 select-none';

const labelClass = 'text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

/** Millimetres, to as many places as the value actually needs and no more. */
function formatStep(mm: number): string {
  const rounded = Math.round(mm * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} mm`;
}

export function LatticePanel() {
  const latticeNodeId = useStore((s) => s.latticeNodeId);
  const tool = useStore((s) => s.latticeTool);
  const plane = useStore((s) => s.latticePlane);
  const snap = useStore((s) => s.latticeSnap);
  const mirror = useStore((s) => s.latticeMirror);
  const planeLocked = useStore((s) => s.latticePlaneLocked);
  const stats = useStore((s) => s.latticeStats);
  const setTool = useStore((s) => s.setLatticeTool);
  const setPlane = useStore((s) => s.setLatticePlane);
  const setSnap = useStore((s) => s.setLatticeSnap);
  const setMirror = useStore((s) => s.setLatticeMirror);
  const setLatticeNodeId = useStore((s) => s.setLatticeNodeId);
  const setLatticeSubdiv = useStore((s) => s.setLatticeSubdiv);
  const setLatticeThickness = useStore((s) => s.setLatticeThickness);
  const node = useStore((s) => {
    const find = (nodes: SceneNode[]): SceneNode | null => {
      for (const n of nodes) {
        if (n.id === s.latticeNodeId) return n;
        const child = find(n.children ?? []);
        if (child) return child;
      }
      return null;
    };
    return s.latticeNodeId ? find(s.sceneGraph.nodes) : null;
  });

  // The tool keys. Plane and grid keys live with the viewport, which is where
  // the rest of the keyboard for this mode is handled.
  useEffect(() => {
    if (!latticeNodeId) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const chosen = TOOLS.find((t) => t.key === event.key);
      if (chosen) {
        setTool(chosen.tool);
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [latticeNodeId, setTool]);

  if (!latticeNodeId) return null;

  const unitMm = (node?.latticeCage?.unit ?? 0.005) * 1000;
  const subdiv = node?.latticeSubdiv ?? 0;
  const thicknessMm = Math.round((node?.latticeThickness ?? 0) * 1000 * 10) / 10;

  return (
    <div className={panelClass}>
      <div className="flex items-center justify-between">
        <span className={labelClass}>Lattice</span>
        <button
          type="button"
          onClick={() => setLatticeNodeId(null)}
          className="text-[10px] font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
        >
          Done
        </button>
      </div>

      <div className="grid grid-cols-3 gap-1">
        {TOOLS.map((t) => (
          <button
            key={t.tool}
            type="button"
            onClick={() => setTool(t.tool)}
            title={`${t.hint} (${t.key})`}
            className={`flex flex-col items-center gap-1 py-2 rounded-lg border text-[10px] font-semibold transition-all cursor-pointer ${
              tool === t.tool
                ? 'bg-blue-50 dark:bg-blue-950/40 border-blue-400 dark:border-blue-700 text-blue-700 dark:text-blue-300'
                : 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:border-slate-300'
            }`}
          >
            <t.icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>

      {/* The work plane. Not a constraint on what may be joined to what —
          anything already drawn is clickable wherever it sits — but the answer
          to how deep a point that does not exist YET should be born. Worth
          keeping on screen because a plane three steps behind where you think it
          is looks perfectly reasonable from the front. The lit slice in the
          viewport follows the pointer rather than this, and clicking at a depth
          brings this with it. */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span
            className={`${labelClass} flex items-center gap-1 ${planeLocked ? 'text-sky-500 dark:text-sky-400' : ''}`}
            title="Where a NEW point lands when you click empty space. Points that already exist can be clicked wherever they are, at any depth — unless Ctrl is held, which keeps everything on this plane."
          >
            {planeLocked && <Lock className="w-3 h-3" />}
            {planeLocked ? 'Locked To' : 'New Points At'}
          </span>
          <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">
            {plane.axis} = {formatStep(plane.index * unitMm)}
          </span>
        </div>
        <div className="flex gap-1">
          {AXES.map((axis) => (
            <button
              key={axis}
              type="button"
              onClick={() => setPlane({ axis, index: 0 })}
              title={`Work on slices perpendicular to ${axis.toUpperCase()} (${axis})`}
              className={`flex-1 py-1 rounded-md text-[11px] font-bold uppercase transition-colors cursor-pointer ${
                plane.axis === axis
                  ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600'
              }`}
            >
              {axis}
            </button>
          ))}
        </div>
        <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
          The lit slice follows your pointer; clicking at a depth sets this to it.
          Hold <kbd className="font-mono">Ctrl</kbd> to stay on this one — the slice stops
          moving and only points on it can be clicked.
          <kbd className="font-mono"> [</kbd> / <kbd className="font-mono">]</kbd> moves it a step, Shift for five.
        </p>
      </div>

      {/* Snapping, in decades. Each step is a whole multiple of the finer ones,
          which is what keeps a coarse corner exactly on the fine grid; a step
          that did not divide would put its points between the fine ones, and
          faces built on the two would meet along a crack. */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className={labelClass}><Grid3x3 className="w-3 h-3 inline mr-1" />Grid</span>
          <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">{formatStep(snap * unitMm)}</span>
        </div>
        <div className="flex gap-1">
          {SNAP_MULTIPLES.map((multiple) => (
            <button
              key={multiple}
              type="button"
              onClick={() => setSnap(multiple as SnapMultiple)}
              title={`Snap to a ${formatStep(multiple * unitMm)} grid. Each step is a whole multiple of the finer ones, so coarse corners stay exactly on the fine grid and earlier work never has to move.`}
              className={`flex-1 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                snap === multiple
                  ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600'
              }`}
            >
              {formatStep(multiple * unitMm)}
            </button>
          ))}
        </div>
      </div>

      {/* Mirror. Exact rather than nearly exact, because a lattice vertex is a
          triple of integers and its reflection is the same triple negated. */}
      <div className="flex items-center gap-1">
        <span className={`${labelClass} flex items-center gap-1 flex-1`}>
          <FlipHorizontal2 className="w-3 h-3" />Mirror
        </span>
        {AXES.map((axis) => (
          <button
            key={axis}
            type="button"
            onClick={() => setMirror(mirror === axis ? null : axis)}
            title={`Mirror every face across the ${axis.toUpperCase()} = 0 plane through the body's origin`}
            className={`px-2 py-1 rounded-md text-[10px] font-bold uppercase transition-colors cursor-pointer ${
              mirror === axis
                ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600'
            }`}
          >
            {axis}
          </button>
        ))}
      </div>

      {/* Smoothing. The answer to "how do I get a curve out of a grid" — not a
          finer grid, which is thousands of points placed by hand, but a coarse
          cage that gets subdivided. */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className={`${labelClass} flex items-center gap-1`}><Spline className="w-3 h-3" />Smoothing</span>
          <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">
            {subdiv === 0 ? 'off' : `${subdiv}×`}
          </span>
        </div>
        <div className="flex gap-1">
          {[0, 1, 2].map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => latticeNodeId && setLatticeSubdiv(latticeNodeId, level)}
              title={level === 0
                ? 'Show and export the cage itself — flat faces and hard edges.'
                : `Round the cage off with ${level} Catmull-Clark pass${level > 1 ? 'es' : ''}. The cage stays what you edit, and edges marked sharp stay sharp.`}
              className={`flex-1 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                subdiv === level
                  ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600'
              }`}
            >
              {level === 0 ? 'Faceted' : `${level}×`}
            </button>
          ))}
        </div>
      </div>

      {/* Wall thickness. A lattice is a surface, and a surface has no inside
          for a slicer or a CAM job to fill — this is what turns the skin you
          drew into a part with a wall. Only offered while the shape is open,
          because thickening a closed solid is a different question (hollowing
          it, and where does the material get out?). */}
      {stats && !stats.watertight && (
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between">
            <span className={`${labelClass} flex items-center gap-1`}><Layers className="w-3 h-3" />Wall</span>
            <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">
              {thicknessMm === 0 ? 'none' : `${thicknessMm} mm`}
            </span>
          </div>
          <div className="flex gap-1">
            {[0, 1, 2, 3].map((mm) => (
              <button
                key={mm}
                type="button"
                onClick={() => latticeNodeId && setLatticeThickness(latticeNodeId, mm)}
                title={mm === 0
                  ? 'Leave it a surface. Fine to model with, and refused by anything that has to make it.'
                  : `Thicken the surface into a ${mm} mm shell, offset inwards so the shape keeps the dimensions you drew. The rim is held sharp, and the wall follows the smoothed surface rather than the cage.`}
                className={`flex-1 py-1 rounded-md text-[11px] font-semibold transition-colors cursor-pointer ${
                  thicknessMm === mm
                    ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                    : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600'
                }`}
              >
                {mm === 0 ? 'None' : `${mm}mm`}
              </button>
            ))}
          </div>
        </div>
      )}

      {stats && (
        <div className="pt-2 border-t border-slate-200 dark:border-slate-800 space-y-1">
          <div className="flex items-center justify-between text-[10px]">
            <span className="flex items-center gap-1 text-slate-400 dark:text-slate-500">
              <Boxes className="w-3 h-3" /> Cage
            </span>
            <span className="font-mono text-slate-600 dark:text-slate-300">
              {stats.vertices} v · {stats.quads} q{stats.tris > 0 ? ` · ${stats.tris} t` : ''}
            </span>
          </div>
          {stats.creases > 0 && (
            <div
              className="flex items-center justify-between text-[10px]"
              title="Edges marked sharp. Smoothing rounds everything except these, which is what lets one cage be a curved shell with a crisp rim."
            >
              <span className="flex items-center gap-1 text-amber-500"><Scissors className="w-3 h-3" /> Sharp edges</span>
              <span className="font-mono text-slate-600 dark:text-slate-300">{stats.creases}</span>
            </div>
          )}
          {stats.creases === 0 && subdiv > 0 && (
            <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
              Smoothing rounds every edge. Select one, <kbd className="font-mono">L</kbd> for its whole loop,
              <kbd className="font-mono"> S</kbd> to hold it sharp.
            </p>
          )}
          {stats.tris > 0 && subdiv > 0 && (
            <div
              className="flex items-start gap-1 text-[10px] text-sky-600 dark:text-sky-400"
              title="Catmull-Clark leaves an extraordinary vertex at every triangle corner, which shows up as a dimple once the surface catches a light."
            >
              <TriangleAlert className="w-3 h-3 mt-px shrink-0" />
              <span>Triangles smooth less cleanly than quads.</span>
            </div>
          )}
          {stats.watertight ? (
            <div className="flex items-center gap-1 text-[10px] text-emerald-600 dark:text-emerald-400">
              <Check className="w-3 h-3" />
              <span>Surface is closed.</span>
            </div>
          ) : (
            <div
              className="flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400"
              title="Some edge is not shared by exactly two faces. The viewport does not care; a slicer or a CAM job will refuse the file."
            >
              <TriangleAlert className="w-3 h-3 mt-px shrink-0" />
              <span>
                {thicknessMm > 0
                  ? 'Open, but walled — the shell above closes it when the mesh is built.'
                  : 'Surface is not closed — give it a wall above, or cap it by hand.'}
              </span>
            </div>
          )}
        </div>
      )}

      <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500 pt-1 border-t border-slate-200 dark:border-slate-800">
        <kbd className="font-mono">X</kbd>/<kbd className="font-mono">Y</kbd>/<kbd className="font-mono">Z</kbd> turns the plane · <kbd className="font-mono">Del</kbd> removes the corner
        under the pointer, or whatever is selected · Right-drag orbits · <kbd className="font-mono">Ctrl+Z</kbd> undoes an edit
      </p>
    </div>
  );
}

export default LatticePanel;
