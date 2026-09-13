import React, { useEffect, useState } from 'react';
import {
  Box, ChevronUp, Cpu, Cuboid, Flame, Layers, Layers2, MousePointer2, Mountain, Package, Pause, Play, Printer, Scissors, Square, Wrench,
} from 'lucide-react';
import { useStore, type MachineTarget } from '../store/useStore';
import { FILAMENTS, filamentSpec, type FilamentId } from '../utils/filaments';
import { FdmNotice } from './FdmNotice';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { MATERIALS, type MaterialId } from '../utils/feedsAndSpeeds';
import { formatDuration } from '../utils/timeEstimate';
import type { SceneGraph } from '../types/scene';
import type { LatticeTool } from '../utils/latticeMesh';

/**
 * Counts geoms and vertices for the scene readout.
 *
 * Walks the same way the compiler does — a node with an explicit `geoms` array
 * contributes one per entry, and a node without one still contributes itself —
 * so the number here matches what actually reaches MuJoCo rather than counting
 * tree nodes.
 */
/** Only the fields the count actually reads; a scene geom carries many more. */
interface CountableGeom {
  type?: string;
  vertices?: number[];
  renderVertices?: number[];
}

interface CountableNode {
  geoms?: CountableGeom[];
  meshVertices?: number[];
  children?: CountableNode[];
}

function sceneMetrics(scene: SceneGraph | undefined): { geoms: number; vertices: number } {
  let geoms = 0;
  let vertices = 0;

  const countGeomVerts = (g: CountableGeom | undefined) => {
    if (!g) return;
    if (Array.isArray(g.vertices) && g.vertices.length > 0) {
      vertices += Math.floor(g.vertices.length / 3);
    } else if (Array.isArray(g.renderVertices) && g.renderVertices.length > 0) {
      vertices += Math.floor(g.renderVertices.length / 3);
    } else if (g.type === 'box' || g.type === 'cube' || g.type === 'plane') {
      vertices += 24;
    } else if (g.type === 'capsule') {
      vertices += 48;
    } else if (g.type === 'cylinder') {
      vertices += 64;
    } else if (g.type === 'sphere' || g.type === 'ellipsoid') {
      vertices += 128;
    } else {
      vertices += 24;
    }
  };

  const walk = (nodes: CountableNode[]) => {
    if (!Array.isArray(nodes)) return;
    for (const n of nodes) {
      if (Array.isArray(n.geoms) && n.geoms.length > 0) {
        geoms += n.geoms.length;
        n.geoms.forEach(countGeomVerts);
      } else {
        geoms += 1;
        if (Array.isArray(n.meshVertices) && n.meshVertices.length > 0) {
          vertices += Math.floor(n.meshVertices.length / 3);
        } else {
          vertices += 24;
        }
      }
      if (n.children) walk(n.children);
    }
  };

  walk((scene?.nodes ?? []) as CountableNode[]);
  return { geoms, vertices };
}

/**
 * What the app is in the middle of, said in one phrase.
 *
 * Modal editing has one failure that dwarfs the rest: not knowing which mode
 * you are in. A key that scaled the selection last time does something else
 * now, and the only evidence is what happens when you press it. The tool
 * palettes each say what THEY are doing, but they are per-mode panels — the
 * bar is on screen whatever is open, so this is the one place the answer is
 * always in the same spot.
 *
 * Ordered by what has the keyboard: a running gesture outranks the tool it was
 * started from, and a tool outranks the mode it lives in.
 */
function modeLabel(state: {
  gestureStatus: string | null;
  draggedNodeId: string | null;
  latticeNodeId: string | null;
  latticeTool: string;
  sculptNodeId: string | null;
  sculptBrush: string;
  paintMode: boolean;
  measureMode: string | null;
}): { text: string; tone: string } {
  const title = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
  // Measuring outranks the gesture line it writes into, so the chip stays amber
  // with a reading in it rather than flicking back to the mode underneath.
  if (state.measureMode) return { text: state.gestureStatus ?? `Measure · ${title(state.measureMode)}`, tone: 'amber' };
  if (state.gestureStatus) return { text: state.gestureStatus, tone: 'amber' };
  if (state.draggedNodeId) return { text: 'Grab', tone: 'amber' };
  if (state.latticeNodeId) return { text: `Lattice · ${title(state.latticeTool)}`, tone: 'indigo' };
  if (state.sculptNodeId) return { text: `Sculpt · ${title(state.sculptBrush)}`, tone: 'sky' };
  if (state.paintMode) return { text: 'Paint', tone: 'violet' };
  return { text: 'Select', tone: 'slate' };
}

/**
 * The modes the chip can put you into from here.
 *
 * Every one of these is a key, and a key is faster once you know it. That is
 * exactly the problem: a modal keyboard is unusable until somebody has told you
 * what the keys are, and nothing on screen tells you. So the readout that says
 * what mode you are in is also the menu that changes it — the one place a
 * person already looks when they are wondering what the keyboard is doing.
 */
interface ModeChoice {
  key: string;
  label: string;
  hint: string;
  /** A lattice tool to switch to, or a gesture to start. */
  tool?: LatticeTool;
  gesture?: 'move' | 'scale' | 'inset' | 'measure-distance' | 'measure-angle';
}

const LATTICE_TOOLS: ModeChoice[] = [
  { key: '1', label: 'Place', tool: 'place', hint: 'Click grid points to draw a face' },
  { key: '2', label: 'Select', tool: 'select', hint: 'Pick corners, faces and edges; drag a box for several' },
  { key: '3', label: 'Extrude', tool: 'extrude', hint: 'Drag a face along its own axis' },
  { key: '4', label: 'Circle', tool: 'shape', hint: 'Click the centre, move out to size it, click again' },
  { key: '5', label: 'Freehand', tool: 'freehand', hint: 'Drag on the held plane; let go on the first corner to close' },
  { key: '6', label: 'Line', tool: 'line', hint: 'Click corner to corner on the held plane; Shift holds 45°' },
  { key: '7', label: 'Bézier', tool: 'bezier', hint: 'Click the end, then pull it into shape with two more clicks' },
];

const GESTURES: ModeChoice[] = [
  { key: 'G', label: 'Move', gesture: 'move', hint: 'Move it with the pointer; X/Y/Z holds one axis' },
  { key: 'S', label: 'Scale', gesture: 'scale', hint: 'Resize it with the pointer; X/Y/Z holds one axis' },
  { key: 'I', label: 'Inset', gesture: 'inset', hint: 'A lattice face insets; a solid body gets a hole bored through it' },
];

/**
 * Measuring, which is not modelling and is offered whether anything is selected
 * or not.
 *
 * It sits in the same list as the modelling modes because it answers the same
 * question — what is the pointer about to do — and because the alternative is a
 * toolbar button somewhere else that nobody would find. A measurement needs no
 * selection: what it acts on is whatever you click.
 */
const MEASURE: ModeChoice[] = [
  { key: 'D', label: 'Measure distance', gesture: 'measure-distance', hint: 'Click two points; snaps to corners, edge midpoints and hole centres' },
  { key: 'A', label: 'Measure angle', gesture: 'measure-angle', hint: 'Click along one arm, the corner, then the other arm' },
];

const MODE_TONES: Record<string, string> = {
  amber: 'bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800',
  indigo: 'bg-indigo-100 dark:bg-indigo-950/50 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800',
  sky: 'bg-sky-100 dark:bg-sky-950/50 text-sky-700 dark:text-sky-300 border-sky-300 dark:border-sky-800',
  violet: 'bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-300 border-violet-300 dark:border-violet-800',
  slate: 'bg-slate-100 dark:bg-slate-900 text-slate-500 dark:text-slate-400 border-slate-200 dark:border-slate-800',
};

/**
 * The ways a scene can leave the app for a machine, one callback each.
 *
 * They live in App because the STL and 3MF writers need the compiled scene and
 * the rest open modals App owns. The bar only decides which of them to show.
 */
export interface ExportActions {
  stl: () => void;
  threeMf: () => void;
  mold: () => void;
  /** Unwrap panel faces into a 2D SVG, or cut them straight from the machine panel. */
  unwrap: () => void;
  contourSlices: () => void;
  reliefCarve: () => void;
  /** Machine the model itself out of a block, one side at a time. */
  solid: () => void;
  /** Print a green-sand casting pattern to cast the part in metal. */
  cast: () => void;
}

/** Fired by anything that wants the export buttons pointed out — the navbar's print button, for one. */
export const SHOW_EXPORTS_EVENT = 'physbox:show-exports';

/**
 * The status bar along the bottom of the app.
 *
 * Two jobs. It reports the scene, and it holds the two settings that describe
 * the workshop rather than any one export — what the job is cut on, and what
 * it is cut out of. Those were previously chosen inside each export modal,
 * which meant answering them once per operation and being able to answer them
 * inconsistently between operations.
 *
 * The export buttons sit next to those settings, and only the ones that make
 * sense for the machine chosen are shown: a printer wants a solid, a laser
 * wants sheets, a router wants either sheets or a block. They used to be a
 * row of nine in the navbar, most of them wrong for whatever was on the bench.
 * The machine connection lives here for the same reason — it is the machine
 * that was just chosen, and a printer has nothing to connect to.
 *
 * The running-job controls are out here on purpose. A cutter does not stop
 * because you closed a dialog, so the stop button must be reachable with every
 * modal shut.
 */
export const BottomStatusBar: React.FC<{ onOpenMachineConfig: () => void; exports: ExportActions }> = ({
  onOpenMachineConfig,
  exports,
}) => {
  const sceneGraph = useStore((s) => s.sceneGraph);
  const isPlaying = useStore((s) => s.isPlaying);
  const machineTarget = useStore((s) => s.machineTarget);
  const setMachineTarget = useStore((s) => s.setMachineTarget);
  const material = useStore((s) => s.material);
  const setMaterial = useStore((s) => s.setMaterial);
  const filament = useStore((s) => s.filament);
  const setFilament = useStore((s) => s.setFilament);
  const printing = machineTarget === 'fdm';

  const gestureStatus = useStore((s) => s.gestureStatus);
  const latticeNodeId = useStore((s) => s.latticeNodeId);
  const latticeTool = useStore((s) => s.latticeTool);
  const sculptNodeId = useStore((s) => s.sculptNodeId);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const setLatticeTool = useStore((s) => s.setLatticeTool);
  const measureMode = useStore((s) => s.measureMode);
  const mode = modeLabel({
    gestureStatus,
    draggedNodeId: useStore((s) => s.draggedNodeId),
    latticeNodeId,
    latticeTool,
    sculptNodeId: sculptNodeId,
    sculptBrush: useStore((s) => s.sculptBrush.type),
    paintMode: useStore((s) => s.paintMode),
    measureMode,
  });

  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  // Gestures need something to act on: the body being modelled, or the body
  // selected in the scene. Sculpting has its own brushes in its own palette.
  const canGesture = !!latticeNodeId || (!sculptNodeId && !!selectedNodeId);
  const choices: ModeChoice[] = [
    ...(latticeNodeId ? LATTICE_TOOLS : []),
    ...(canGesture ? GESTURES : []),
    ...MEASURE,
  ];

  const choose = (choice: ModeChoice) => {
    setModeMenuOpen(false);
    if (choice.tool) {
      setLatticeTool(choice.tool);
      // A lattice tool is not a gesture, but choosing one is just as much a
      // decision to stop measuring.
      useStore.getState().setMeasureMode(null);
    }
    // The gesture belongs to whichever surface is listening — the lattice tools
    // when they are open, the viewport otherwise. Announced rather than called,
    // because the status bar has no business knowing which of them is mounted.
    if (choice.gesture) {
      window.dispatchEvent(new CustomEvent('physbox:gesture', { detail: { kind: choice.gesture } }));
    }
  };

  // Seeded from the manager rather than a literal, so a bar that mounts after a
  // connection shows the real state instead of a disconnected one.
  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());
  useEffect(() => webSerialManager.addListener(setMachineState), []);

  // A brief pulse on the export group when something elsewhere sends the user
  // here. Time-limited so a bar that is glanced at later is not still glowing.
  const [exportsHighlighted, setExportsHighlighted] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onShow = () => {
      setExportsHighlighted(true);
      clearTimeout(timer);
      timer = setTimeout(() => setExportsHighlighted(false), 2400);
    };
    window.addEventListener(SHOW_EXPORTS_EVENT, onShow);
    return () => {
      window.removeEventListener(SHOW_EXPORTS_EVENT, onShow);
      clearTimeout(timer);
    };
  }, []);

  const { geoms, vertices } = sceneMetrics(sceneGraph);
  const running = machineState.status === 'RUNNING' || machineState.status.startsWith('PAUSED');
  const paused = machineState.status.startsWith('PAUSED');
  const parked = machineState.status === 'PAUSED_PARKED';

  const selectClass =
    'bg-transparent text-slate-800 dark:text-slate-200 font-semibold rounded px-1 py-0.5 outline-none cursor-pointer border-none';
  const exportButtonClass = (tone: string) =>
    `flex items-center justify-center p-1 rounded-md hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus:outline-none cursor-pointer ${tone}`;

  /**
   * What the chosen machine can be given. The laser list is the router list
   * without the relief carve and the solid part, which need a Z axis a laser
   * does not have.
   */
  const exportButtons: { label: string; title: string; tone: string; icon: React.ReactNode; run: () => void }[] =
    machineTarget === 'fdm'
      ? [
          { label: 'STL', title: '3D Print (STL), geometry only. STL cannot carry colour; use 3MF if the model is painted.', tone: 'text-slate-600 dark:text-slate-300', icon: <Printer className="w-3.5 h-3.5" />, run: exports.stl },
          { label: '3MF', title: '3D Print in colour (3MF). Carries painted colour two ways: per-vertex for viewers, and a filament slot per triangle for a multi-material slicer.', tone: 'text-fuchsia-600 dark:text-fuchsia-400', icon: <Package className="w-3.5 h-3.5" />, run: exports.threeMf },
          { label: 'Mold', title: 'Export 3D Printable Casting Mold (STL)', tone: 'text-purple-600 dark:text-purple-400', icon: <Box className="w-3.5 h-3.5" />, run: exports.mold },
          { label: 'Cast', title: 'Cast in metal — print a green-sand casting pattern with shrink and gating', tone: 'text-orange-600 dark:text-orange-400', icon: <Flame className="w-3.5 h-3.5" />, run: exports.cast },
        ]
      : [
          { label: 'SVG', title: 'Unwrap panel faces into 2D cut patterns (SVG), or cut them straight from here', tone: 'text-amber-600 dark:text-amber-400', icon: <Scissors className="w-3.5 h-3.5" />, run: exports.unwrap },
          { label: 'Contour', title: 'Contour Slices (Stacked Relief Map, SVG)', tone: 'text-emerald-600 dark:text-emerald-400', icon: <Layers className="w-3.5 h-3.5" />, run: exports.contourSlices },
          ...(machineTarget === 'cnc'
            ? [
                { label: 'Relief', title: '3D Relief Carve (CNC Router)', tone: 'text-blue-600 dark:text-blue-400', icon: <Mountain className="w-3.5 h-3.5" />, run: exports.reliefCarve },
                { label: 'Solid', title: 'Machine the part itself out of a block at true size: one side, flip, the other side', tone: 'text-indigo-600 dark:text-indigo-400', icon: <Cuboid className="w-3.5 h-3.5" />, run: exports.solid },
              ]
            : []),
        ];

  return (
    /*
      Below `lg` the bar wraps rather than squeezing. The material and the
      machine are what the feeds are derived from and a running job's stop
      button is a safety control, so none of it is dropped on a narrow screen.
    */
    <footer className="h-8 shrink-0 w-full bg-white dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800/80 px-4 flex items-center justify-between z-20 text-[11px] text-slate-500 dark:text-slate-400 font-mono select-none transition-colors max-lg:h-auto max-lg:flex-wrap max-lg:justify-start max-lg:px-2 max-lg:py-1 max-lg:gap-x-3 max-lg:gap-y-1">
      {/* Scene metrics */}
      <div className="flex items-center gap-3 max-lg:shrink-0">
        {/* First thing in the bar, because "which mode am I in" is the question
            asked most often and the one a modal keyboard makes expensive to
            get wrong. */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setModeMenuOpen((open) => !open)}
            disabled={choices.length === 0}
            className={`flex items-center gap-1 px-2 py-0.5 rounded-md border font-semibold tabular-nums transition-colors ${MODE_TONES[mode.tone]} ${choices.length > 0 ? 'cursor-pointer hover:brightness-95' : 'cursor-default'}`}
            title={'What the keyboard is doing right now. Click to pick a mode instead. A gesture in progress shows how far it has gone; click or Enter keeps it, Esc puts it back.'}
          >
            <MousePointer2 className="w-3 h-3" />
            {mode.text}
            {choices.length > 0 && <ChevronUp className={`w-3 h-3 opacity-50 transition-transform ${modeMenuOpen ? 'rotate-180' : ''}`} />}
          </button>

          {modeMenuOpen && choices.length > 0 && (
            <>
              {/* Anything outside closes it, including a click into the
                  viewport — which would otherwise both close the menu and
                  answer whatever gesture it had just started. */}
              <div className="fixed inset-0 z-40" onClick={() => setModeMenuOpen(false)} />
              <div className="absolute bottom-full left-0 mb-1.5 z-50 w-64 rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-lg p-1">
                {choices.map((choice) => (
                  <button
                    key={choice.label}
                    type="button"
                    onClick={() => choose(choice)}
                    title={choice.hint}
                    className={`w-full flex items-start gap-2 px-2 py-1.5 rounded-md text-left transition-colors hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer ${
                      (choice.tool && choice.tool === latticeTool) ||
                      (measureMode && choice.gesture === `measure-${measureMode}`)
                        ? 'bg-indigo-50 dark:bg-indigo-950/40'
                        : ''
                    }`}
                  >
                    <kbd className="mt-px font-mono font-bold text-[10px] text-slate-500 dark:text-slate-400 w-4 shrink-0">{choice.key}</kbd>
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-700 dark:text-slate-200">{choice.label}</span>
                      <span className="block text-[10px] leading-snug text-slate-400 dark:text-slate-500 whitespace-normal">{choice.hint}</span>
                    </span>
                  </button>
                ))}
                <p className="px-2 py-1 text-[10px] leading-snug text-slate-400 dark:text-slate-500 border-t border-slate-100 dark:border-slate-800 mt-1">
                  Pick one, move the pointer to size it, then click to keep it, or Esc to put it back.
                  Measuring takes clicks instead: Esc puts the tape away.
                </p>
              </div>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-700 dark:text-slate-300">
            Components: {sceneGraph?.nodes?.length || 0}
          </span>
          <span>·</span>
          <span>Geoms: {geoms}</span>
          <span>·</span>
          <span>Vertices: {vertices.toLocaleString()}</span>
        </div>
      </div>

      {/* What it is cut on, and what out of */}
      <div className="flex items-center gap-2 max-lg:shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <Cpu className="w-3.5 h-3.5 text-amber-500" />
          <select
            value={machineTarget}
            onChange={(e) => setMachineTarget(e.target.value as MachineTarget)}
            title="What is on the bench. A laser has no Z depth; a router does; a printer is not driven from here at all."
            className={selectClass}
          >
            <option value="fdm">3D Printer (FDM)</option>
            <option value="cnc">CNC Router</option>
            <option value="laser">Laser</option>
          </select>

          <div className="w-px h-3 bg-slate-200 dark:bg-slate-800 mx-0.5" />

          <Layers2 className="w-3.5 h-3.5 text-emerald-500" />
          {/* Two lists, because they are two different questions. A filament
              has no surface speed and no chip load, so it cannot be an option
              in the list the feeds arithmetic reads from. */}
          {printing ? (
            <select
              value={filament}
              onChange={(e) => setFilament(e.target.value as FilamentId)}
              title={filamentSpec(filament).note}
              className={selectClass}
            >
              {FILAMENTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          ) : (
            <select
              value={material}
              onChange={(e) => setMaterial(e.target.value as MaterialId)}
              title="What the stock is. Feeds, speeds and spindle RPM are derived from it."
              className={selectClass}
            >
              {MATERIALS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}

          <div className="w-px h-3 bg-slate-200 dark:bg-slate-800 mx-0.5" />

          {/* The exports this machine can take. Labelled as well as iconed:
              a row of small coloured glyphs is what the navbar had, and it
              needed hovering to read. */}
          <div
            className={`flex items-center gap-0.5 rounded-md transition-shadow ${
              exportsHighlighted ? 'ring-2 ring-emerald-500 ring-offset-1 ring-offset-white dark:ring-offset-slate-950' : ''
            }`}
          >
            {exportButtons.map((b) => (
              <button
                key={b.label}
                type="button"
                onClick={b.run}
                title={b.title}
                className={`${exportButtonClass(b.tone)} gap-1 px-1.5 font-semibold`}
              >
                {b.icon}
                {b.label}
              </button>
            ))}
          </div>

          {/* Said here as well as in the export dialogs, because this is where
              the printer was chosen and the bar is on screen the whole time. */}
          {printing ? (
            <>
              <div className="w-px h-3 bg-slate-200 dark:bg-slate-800 mx-0.5" />
              <FdmNotice compact />
            </>
          ) : (
            <>
              <div className="w-px h-3 bg-slate-200 dark:bg-slate-800 mx-0.5" />
              {/* The connection, beside the machine it is a connection to. Not
                  shown for a printer, which is never driven from here. */}
              <span
                className={`w-2 h-2 rounded-full ${
                  machineState.connected ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400 dark:bg-slate-600'
                }`}
              />
              <span>Machine:</span>
              <span
                className={
                  machineState.connected
                    ? 'text-emerald-600 dark:text-emerald-400 font-bold'
                    : 'text-slate-400'
                }
              >
                {machineState.status}
              </span>
              {/* Next to the status it acts on. A disconnected machine is the
                  moment someone wants this button. */}
              <button
                onClick={onOpenMachineConfig}
                className="p-1 rounded text-amber-600 dark:text-amber-400 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                title="Connect the machine, home it, and set the work origin"
              >
                <Wrench className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Running job and simulation status */}
      <div className="flex items-center gap-3 max-lg:shrink-0">

        {/* A running job stays visible and stoppable with every panel closed. */}
        {running && (
          <div className="flex items-center gap-2">
            <span className="text-slate-700 dark:text-slate-200">
              {parked ? 'Parked' : paused ? 'Paused' : 'Cutting'}
            </span>
            {/* Time, not lines. See `elapsedSeconds` in webSerialManager for why
                the line count cannot answer "how much longer". The line count
                is still shown, labelled as what it is — lines sent, which is
                what to quote when something has gone wrong and you need to know
                where in the file it is. */}
            <span className="tabular-nums text-slate-700 dark:text-slate-200">
              {formatDuration(machineState.elapsedSeconds)}
              {machineState.estimatedSeconds !== null && (
                <>
                  {' / '}
                  {formatDuration(machineState.estimatedSeconds)}
                  <span className="text-slate-400">
                    {' '}
                    ({formatDuration(Math.max(0, machineState.estimatedSeconds - machineState.elapsedSeconds))} left)
                  </span>
                </>
              )}
            </span>
            <div
              className="w-20 h-1.5 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden"
              title={
                machineState.estimatedSeconds !== null
                  ? 'Elapsed against the estimated run time'
                  : 'Lines sent to the controller (the job did not quote a run time)'
              }
            >
              <div
                className="h-full bg-emerald-500 transition-all"
                style={{
                  width: `${
                    machineState.estimatedSeconds
                      ? Math.min(100, (machineState.elapsedSeconds / machineState.estimatedSeconds) * 100)
                      : machineState.progressPercent
                  }%`,
                }}
              />
            </div>
            <span className="text-slate-400">
              line {machineState.currentLine}/{machineState.totalLines} sent
            </span>
            {/* Why it stopped, next to the button that restarts it — a tool
                change is an instruction, and it is no use only in a panel the
                operator has closed. */}
            {machineState.pauseMessage && (
              <span className="text-amber-600 dark:text-amber-400 truncate max-w-[22rem]">
                {machineState.pauseMessage}
              </span>
            )}
            <button
              onClick={() => (paused ? webSerialManager.resumeJob() : webSerialManager.pauseJob())}
              title={paused ? 'Resume the job' : 'Pause the job'}
              className="p-0.5 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white cursor-pointer"
            >
              {paused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => webSerialManager.cancelJob()}
              title="Stop the job"
              className="p-0.5 text-red-500 hover:text-red-600 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-slate-100 dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
          <span className={`w-2 h-2 rounded-full ${isPlaying ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
          <span className="text-slate-700 dark:text-slate-300 font-semibold">
            {isPlaying ? 'Simulation Running' : 'Simulation Paused'}
          </span>
        </div>
      </div>
    </footer>
  );
};
