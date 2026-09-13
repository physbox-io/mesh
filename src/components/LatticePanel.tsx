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

import { useEffect, useRef, useState } from 'react';
import {
  PenLine, MousePointer2, MoveVertical, FlipHorizontal2,
  Boxes, TriangleAlert, Check, Spline, Scissors, Layers, Lock, LockOpen, RefreshCw, Circle, RotateCw,
  Keyboard, ChevronDown, Ruler, Pencil, Slash,
} from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import { useStore } from '../store/useStore';
import { CutControls, CutIcon } from './CutControls';
import type { SceneNode } from '../types/scene';
import { AXIS_INDEX, type Axis, type LatticeTool } from '../utils/latticeMesh';

interface ToolDefinition {
  tool: LatticeTool;
  label: string;
  key: string;
  icon: typeof PenLine;
  hint: string;
}

const TOOLS: ToolDefinition[] = [
  { tool: 'place', label: 'Place', key: '1', icon: PenLine, hint: 'Click grid points to draw a face, then click the first one again to close it (the cursor turns green when a click would). Enter closes it where it is; Esc abandons it.' },
  { tool: 'select', label: 'Select', key: '2', icon: MousePointer2, hint: 'Click a corner, face or edge to select it, or Shift/Ctrl-click to add it to what is already selected; drag a box to catch several (Shift adds to the selection), then drag any one of them to move the lot or Delete to remove them. L grows an edge to its whole loop, H holds it sharp under smoothing (on a face, its whole border), G moves the selection and S scales it, F turns a face inside out.' },
  { tool: 'extrude', label: 'Extrude', key: '3', icon: MoveVertical, hint: 'Drag a face along its own axis to push it out in whole grid steps.' },
  { tool: 'shape', label: 'Circle', key: '4', icon: Circle, hint: 'Click the centre, then move out to size it and click again. The result is an ordinary face: extrude it for a cylinder, revolve a profile past it, or dimension it in millimetres. Set the corner count below to draw a hexagon or a square instead.' },
  // The drawing tools hold the work plane still for as long as they are in
  // hand: a stroke is flat, and the freedom to reach other depths that the
  // place tool enjoys would let a curve wander through the part.
  { tool: 'freehand', label: 'Freehand', key: '5', icon: Pencil, hint: 'Drag on the held plane to draw; every grid point the pointer crosses becomes a corner, and backing up takes the last one off again. Let go on the first corner to close the face, or press Enter; let go anywhere else and the stroke stays as a wire you can carry on from either end. Holds the plane while it is in hand.' },
  { tool: 'line', label: 'Line', key: '6', icon: Slash, hint: 'Click corner to corner on the held plane; hold Shift to keep a line to the nearest 45°. Click the first corner again, or press Enter, to close the face; until then it is a wire, kept in the shape. Holds the plane while it is in hand.' },
  { tool: 'bezier', label: 'Bézier', key: '7', icon: Spline, hint: 'Click where the curve ends, then click twice to pull it into shape — out of its start, then into its end. The curve becomes grid corners on the held plane, kept as a wire: continue it from either end, select its edges and Turn it for a lathe, or bring it back round to its first corner for a face. Holds the plane while it is in hand.' },
];

const AXES: Axis[] = ['x', 'y', 'z'];

/*
 * `max-h` and a scroll, because the panel grows: the key list alone is longer
 * than the rest of it, and opening it on a laptop used to push the bottom half
 * of the panel — Keys included — off the screen with no way to reach it. The
 * height left is the viewport minus the panel's own top offset and a matching
 * gap underneath.
 */
const panelClass =
  'absolute top-20 left-4 z-30 w-60 rounded-xl border border-slate-200 dark:border-slate-800 ' +
  'bg-white/95 dark:bg-slate-900/95 backdrop-blur shadow-lg p-3 space-y-3 select-none ' +
  'max-h-[calc(100vh-6rem)] overflow-y-auto overscroll-contain';

const labelClass = 'text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

const fieldClass =
  'w-full px-1 py-0.5 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 ' +
  'text-[10px] font-mono text-slate-700 dark:text-slate-200 outline-none focus:border-sky-400 tabular-nums';

/** Millimetres, to as many places as the value actually needs and no more. */
function formatStep(mm: number): string {
  const rounded = Math.round(mm * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)} mm`;
}

/**
 * Every shortcut, grouped by what you would be doing when you wanted it.
 *
 * Written out rather than gathered from the handlers: the grouping and the
 * wording are the point, and a generated list would be alphabetical and useless.
 */
const KEYS: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Tools',
    keys: [
      ['1 2 3 4', 'Place, Select, Extrude, Circle'],
      ['5 6 7', 'Freehand, Line, Bézier — drawn on the held plane, kept as wires until closed'],
      ['Esc', 'Abandon the polygon being drawn, or clear the selection'],
    ],
  },
  {
    title: 'The grid',
    keys: [
      ['X Y Z', 'Turn the work plane, landing on whatever the pointer is on'],
      ['[ ]', 'Move it a step along its axis (Shift for five)'],
      ['Ctrl', 'Hold to stay on the plane you are pointing at'],
      ['Caps Lock', 'Hold the plane without holding a key (the lock button does the same)'],
    ],
  },
  {
    title: 'Placing',
    keys: [
      ['Click', 'Put a corner down. Nothing closes on its own'],
      ['Click 1st', 'Come back to the corner you started at to close the face'],
      ['Enter', 'Close it without going back (three corners or more)'],
      ['Shift', 'In the line tool, keeps the line to the nearest 45°'],
    ],
  },
  {
    title: 'Selecting',
    keys: [
      ['Drag', 'Box round several corners; Shift adds to what is selected'],
      ['Shift+Click', 'Add a corner, face or edge, or click one again to drop it'],
      ['Ctrl+Click', 'The same thing, if that is the hand you have free'],
      ['L', 'Grow a selected edge to its whole loop'],
    ],
  },
  {
    title: 'Changing the shape',
    keys: [
      ['Del', 'Remove the corner under the pointer, or whatever is selected'],
      ['B', 'Chamfer selected edges, or cut the corners off a selected face'],
      ['4', 'Circle: click the centre, move out to size it, click to keep it'],
      ['R', 'Round selected edges: the same cut, left soft so smoothing fillets it'],
      ['I', 'Inset a face: a smaller one inside it, ringed by quads'],
      ['S', 'Scale what is selected, about its own middle'],
      ['G or M', 'Move what is selected: a face, a loop, a boxful of corners'],
      ['J', 'Join two selected faces, or bore a tunnel between them'],
      ['Turn', 'Sweep a selected profile about an axis (the Revolve controls above)'],
      ['F', 'Turn a face inside out'],
      ['N', 'Turn every face the right way round'],
      ['H', 'Hold an edge sharp under smoothing (on a face, its whole border)'],
    ],
  },
  {
    title: 'Sizing G, I and S',
    keys: [
      ['Move', 'The pointer sizes it: out from the middle is bigger'],
      ['X Y Z', 'Hold it to one axis; press the same key again to free it'],
      ['Click', 'Keep it (or Enter). Esc and right-click put it back'],
    ],
  },
  {
    title: 'Dimensions',
    keys: [
      ['Type', 'A number in the Dimensions boxes sets the selection\u2019s size or place exactly'],
      ['Enter', 'Applies what you typed; Esc leaves the box without changing anything'],
      ['Cut', 'Lands on the selected face, square to it, at the depth you type'],
    ],
  },
  {
    title: 'Always',
    keys: [
      ['Ctrl+Z', 'Undo (Shift to redo)'],
      ['Right-drag', 'Orbit the camera'],
    ],
  },
];


// ---------------------------------------------------------------------------
// Dimensions
// ---------------------------------------------------------------------------
//
// The other half of the mode. Everything in the viewport sizes a shape by
// moving the pointer, which is how you find out what you want and a poor way to
// say it once you know: a bracket is 40 mm across because the thing it bolts to
// is, and no amount of dragging arrives at that number.
//
// So: select a face, a loop, an edge or a handful of corners, and its size and
// place are here in millimetres, in boxes you can type into. A size scales the
// selection about its own middle; a place moves it. Both land on the grid, like
// every other placement in the mode — a typed dimension can never introduce a
// corner the rest of the tools could not have made.
// ---------------------------------------------------------------------------

const SELECTION_NAME: Record<string, string> = {
  face: 'face', faces: 'faces', edge: 'edge', loop: 'loop', corner: 'corner', corners: 'corners',
};

/** Millimetres, to a tenth of a micron and no trailing noise. */
const dimMm = (value: number) => Math.round(value * 10000) / 10000;

function DimensionField({ axis, mode, value, disabled, title }: {
  axis: Axis;
  mode: 'size' | 'position';
  value: number;
  disabled?: boolean;
  title: string;
}) {
  const requestLatticeResize = useStore((s) => s.requestLatticeResize);
  // Typed, not applied. NumberInput reports every keystroke, and applying those
  // would scale the selection once per digit — "40" would arrive as a 4 mm
  // shape that is then stretched tenfold, with the rounding of both.
  const typed = useRef<number | undefined>(undefined);
  const abandoned = useRef(false);

  if (disabled) {
    return (
      <span
        className="flex-1 px-1 py-0.5 text-[10px] font-mono text-slate-300 dark:text-slate-600 text-center tabular-nums"
        title="This selection is flat on this axis, so it has a place but no size."
      >
        —
      </span>
    );
  }

  return (
    <NumberInput
      value={dimMm(value)}
      title={title}
      min={mode === 'size' ? 0 : undefined}
      onChange={(next) => { typed.current = next; }}
      onCommit={() => {
        const next = typed.current;
        typed.current = undefined;
        if (abandoned.current) { abandoned.current = false; return; }
        if (next !== undefined && next !== dimMm(value)) requestLatticeResize(axis, mode, next);
      }}
      onKeyDown={(event) => {
        // Enter commits by leaving the box, which is the one place the shared
        // field publishes a finished number. Esc leaves without one.
        if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        if (event.key === 'Escape') {
          abandoned.current = true;
          (event.target as HTMLInputElement).blur();
        }
      }}
      className={fieldClass + ' text-center'}
    />
  );
}

function Dimensions() {
  const selection = useStore((s) => s.latticeSelection);
  if (!selection) {
    return (
      <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
        Select a face, an edge, a loop or a few corners and its size turns up here in
        millimetres. Type one in to set it exactly.
      </p>
    );
  }

  return (
    <div className="space-y-1">
      <div className="grid grid-cols-[0.9rem_1fr_1fr] gap-1 items-baseline">
        <span />
        <span className="text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 text-center">Size</span>
        <span
          className="text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 text-center"
          title="Where the middle of the selection sits on the grid. For a face, that is the plane it lies in."
        >
          At
        </span>
      </div>
      {AXES.map((axis) => {
        const k = AXIS_INDEX[axis];
        const size = selection.maxMm[k] - selection.minMm[k];
        const at = (selection.minMm[k] + selection.maxMm[k]) / 2;
        return (
          <div key={axis} className="grid grid-cols-[0.9rem_1fr_1fr] gap-1 items-center">
            <span className="text-[10px] font-bold uppercase text-slate-400 dark:text-slate-500">{axis}</span>
            <DimensionField
              axis={axis} mode="size" value={size} disabled={size <= 0}
              title={`How far the selection reaches along ${axis.toUpperCase()}. Typing a number scales it about its own middle, so both ends move.`}
            />
            <DimensionField
              axis={axis} mode="position" value={at}
              title={`Where the middle of the selection sits along ${axis.toUpperCase()}. Typing a number moves the whole selection there.`}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * How many corners the circle tool's ring gets.
 *
 * Zero means "enough that nobody can tell" — the count is worked out from the
 * radius and the grid, so a 2 mm hole and a 60 mm disc are both round without
 * either being needlessly heavy. Setting it turns the same tool into a regular
 * polygon: six for a hex boss, four for a square post, three for a wedge.
 */
function ShapeSides() {
  const sides = useStore((s) => s.latticeShapeSides);
  const setSides = useStore((s) => s.setLatticeShapeSides);
  const typed = useRef<number | undefined>(undefined);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className={`${labelClass} flex items-center gap-1`}><Circle className="w-3 h-3" />Corners</span>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">
          {sides === 0 ? 'auto' : sides}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <NumberInput
          value={sides}
          min={0}
          title="0 works it out from the radius, so the ring is within half a grid step of a true circle. Any other number draws that regular polygon instead."
          onChange={(next) => { typed.current = next; }}
          onCommit={() => {
            if (typed.current !== undefined) setSides(typed.current);
            typed.current = undefined;
          }}
          onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
          className={fieldClass + ' text-center'}
        />
        {[0, 3, 4, 6, 8].map((count) => (
          <button
            key={count}
            type="button"
            onClick={() => setSides(count)}
            title={count === 0 ? 'As round as the grid allows' : `A regular ${count}-sided polygon`}
            className={`px-1.5 py-1 rounded-md text-[10px] font-semibold transition-colors cursor-pointer ${
              sides === count
                ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600'
            }`}
          >
            {count === 0 ? '○' : count}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Revolve: the profile-consuming operation the lattice was missing.
 *
 * Extrude drags a face along its normal, which makes prisms; bridging two faces
 * lofts between them. Neither makes a turned part, and a turned part — a boss,
 * a spigot, a knob, the bell of a horn — is the other half of what a sketch is
 * for. The axis is one of the body's own, because that is what putting the work
 * on a spindle means; the radius is how far the profile is from it.
 */
function Revolve() {
  const selection = useStore((s) => s.latticeSelection);
  const request = useStore((s) => s.requestLatticeRevolve);
  const [axis, setAxis] = useState<Axis>('z');
  const [degrees, setDegrees] = useState(360);
  const typed = useRef<number | undefined>(undefined);
  const ready = selection?.kind === 'edge' || selection?.kind === 'loop' || selection?.kind === 'face';

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className={`${labelClass} flex items-center gap-1`}><RotateCw className="w-3 h-3" />Revolve</span>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">about {axis.toUpperCase()}</span>
      </div>
      <div className="flex items-center gap-1">
        {AXES.map((a) => (
          <button
            key={a}
            type="button"
            onClick={() => setAxis(a)}
            title={`Spin the profile about the body's ${a.toUpperCase()} axis. How far the profile sits from that axis is the radius.`}
            className={`flex-1 py-1 rounded-md text-[10px] font-bold uppercase transition-colors cursor-pointer ${
              axis === a
                ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600'
            }`}
          >
            {a}
          </button>
        ))}
        <NumberInput
          value={degrees}
          min={1}
          max={360}
          title="How far round to sweep. 360 closes the shape onto itself; anything less leaves both ends open, which is how you get a half-pipe or a quadrant."
          onChange={(next) => { typed.current = next; }}
          onCommit={() => {
            if (typed.current !== undefined) setDegrees(Math.max(1, Math.min(360, typed.current)));
            typed.current = undefined;
          }}
          onKeyDown={(event) => { if (event.key === 'Enter') (event.target as HTMLInputElement).blur(); }}
          className={fieldClass + ' text-center'}
        />
        <button
          type="button"
          disabled={!ready}
          onClick={() => request(axis, degrees)}
          title="Sweep the selected profile about the axis. A run of edges makes a shell; a whole face makes a solid ring."
          className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-colors ${
            ready
              ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300 hover:bg-sky-500/25 cursor-pointer'
              : 'bg-slate-50 dark:bg-slate-900 text-slate-300 dark:text-slate-700 cursor-default'
          }`}
        >
          Turn
        </button>
      </div>
      {!ready && (
        <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
          Select the profile first: a run of edges for a shell, or one face for a solid.
          A point of it sitting on the axis becomes the pole, so a cone is two clicks.
        </p>
      )}
    </div>
  );
}

/**
 * Chamfer and fillet, on the edges the viewport has selected.
 *
 * Offered as a number and two buttons rather than as a pointer gesture, unlike
 * everything else in these tools. A radius is nearly always a number somebody
 * already has — the cutter they own, the clearance the mating part needs — and
 * dragging until the readout happens to say 3.00 is a poor way to ask for 3 mm.
 * The same number stays put between operations, because a part wants the same
 * radius on every edge of it.
 */
function EdgeRadius() {
  const selection = useStore((s) => s.latticeSelection);
  const mm = useStore((s) => s.latticeBevelMm);
  const setMm = useStore((s) => s.setLatticeBevelMm);
  const requestBevel = useStore((s) => s.requestLatticeBevel);
  const typed = useRef<number | undefined>(undefined);
  const edges = selection?.kind === 'edge' || selection?.kind === 'loop';

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className={`${labelClass} flex items-center gap-1`}><Spline className="w-3 h-3" />Edge radius</span>
        <span className="text-[10px] font-mono text-slate-400 dark:text-slate-500">mm</span>
      </div>
      <div className="flex items-center gap-1">
        <NumberInput
          value={mm}
          min={0}
          title="How much a chamfer or fillet takes off the edge. It is rounded to the nearest grid step, so the finest cut available is whatever the snap is set to."
          onChange={(next) => { typed.current = next; }}
          onCommit={() => {
            if (typed.current !== undefined) setMm(typed.current);
            typed.current = undefined;
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
          className={fieldClass + ' text-center'}
        />
        <button
          type="button"
          disabled={!edges}
          onClick={() => requestBevel('chamfer', mm)}
          title="Cut a flat strip off along the selected edges (B). The strip is held sharp, so smoothing keeps it a chamfer."
          className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-colors ${
            edges
              ? 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 cursor-pointer'
              : 'bg-slate-50 dark:bg-slate-900 text-slate-300 dark:text-slate-700 cursor-default'
          }`}
        >
          Chamfer
        </button>
        <button
          type="button"
          disabled={!edges}
          onClick={() => requestBevel('fillet', mm)}
          title="The same cut, left soft (R). A pass of smoothing rounds it into a fillet of about this radius."
          className={`px-2 py-1 rounded-md text-[10px] font-semibold transition-colors ${
            edges
              ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300 hover:bg-sky-500/25 cursor-pointer'
              : 'bg-slate-50 dark:bg-slate-900 text-slate-300 dark:text-slate-700 cursor-default'
          }`}
        >
          Fillet
        </button>
      </div>
      {!edges && (
        <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
          Select an edge (or press <kbd className="font-mono">L</kbd> for its whole loop) and these
          cut it back. A fillet wants at least one pass of smoothing to round.
        </p>
      )}
    </div>
  );
}

export function LatticePanel({ onOpenDocs }: { onOpenDocs?: () => void } = {}) {
  const [keysOpen, setKeysOpen] = useState(false);
  const latticeNodeId = useStore((s) => s.latticeNodeId);
  const tool = useStore((s) => s.latticeTool);
  const plane = useStore((s) => s.latticePlane);
  const mirror = useStore((s) => s.latticeMirror);
  const planeLocked = useStore((s) => s.latticePlaneLocked);
  const planeHold = useStore((s) => s.latticePlaneHold);
  const setPlaneHold = useStore((s) => s.setLatticePlaneHold);
  const stats = useStore((s) => s.latticeStats);
  const gestureStatus = useStore((s) => s.gestureStatus);
  const setTool = useStore((s) => s.setLatticeTool);
  const setPlane = useStore((s) => s.setLatticePlane);
  const setMirror = useStore((s) => s.setLatticeMirror);
  const setLatticeNodeId = useStore((s) => s.setLatticeNodeId);
  const setLatticeSubdiv = useStore((s) => s.setLatticeSubdiv);
  const setLatticeThickness = useStore((s) => s.setLatticeThickness);
  const requestLatticeOrient = useStore((s) => s.requestLatticeOrient);
  const separateLattice = useStore((s) => s.separateLattice);
  const selection = useStore((s) => s.latticeSelection);
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
  // Cuts, and how big the part they cut into is — the axis buttons re-length a
  // through-hole from this, and it is the same measurement the store sizes a
  // new cut from.
  const cuts = (node?.geoms ?? [])
    .map((geom, index) => ({ geom, index }))
    .filter(({ geom }) => geom.csg === 'difference' && !geom.csgDerived);
  // A boolean needs a solid to cut into. An open surface has no inside, and
  // OpenSCAD's answer to subtracting from one is not a part with a hole in it —
  // it is nothing at all, several seconds later.
  const solidEnough = !!stats && (stats.watertight || thicknessMm > 0);

  return (
    <div className={panelClass}>
      <div className="flex items-center justify-between">
        <span className={labelClass}>Lattice</span>
        {onOpenDocs && (
          <button
            type="button"
            onClick={onOpenDocs}
            title="What this mode is for, what every key does, and a worked example"
            className="ml-auto mr-2 text-[10px] font-semibold text-slate-400 hover:text-sky-600 dark:hover:text-sky-400 cursor-pointer"
          >
            Guide
          </button>
        )}
        <button
          type="button"
          onClick={() => setLatticeNodeId(null)}
          className="text-[10px] font-semibold text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 cursor-pointer"
        >
          Done
        </button>
      </div>

      {/* A gesture in progress, said where the eyes already are. The status bar
          carries the same words, but somebody who has just pressed a key they
          are unsure about is looking at the model and at this panel — and a
          gesture that gives no sign it started reads as a key that does
          nothing, which is exactly how I was reported broken. */}
      {gestureStatus && (
        <div className="rounded-lg border border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 px-2 py-1.5">
          <div className="text-[11px] font-bold text-amber-700 dark:text-amber-300 tabular-nums">{gestureStatus}</div>
          <div className="text-[10px] leading-snug text-amber-700/70 dark:text-amber-400/70">
            {/^(Move|Scale|Inset)/.test(gestureStatus) ? (
              <>
                Move the pointer to size it · <kbd className="font-mono">X/Y/Z</kbd> holds one axis ·
                click or <kbd className="font-mono">Enter</kbd> keeps · <kbd className="font-mono">Esc</kbd> puts it back
              </>
            ) : (
              <><kbd className="font-mono">Esc</kbd> abandons it</>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-4 gap-1">
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

      {/* Dimensions. The answer to "make it 40 mm", which the pointer cannot
          give however carefully it is dragged. Always on screen rather than
          folded away: a number you have to go looking for is a number people
          keep guessing at instead. */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className={`${labelClass} flex items-center gap-1`}><Ruler className="w-3 h-3" />Dimensions</span>
          {selection && (
            <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">
              {SELECTION_NAME[selection.kind] ?? selection.kind} · {selection.corners} pt
            </span>
          )}
        </div>
        <Dimensions />
      </div>

      <EdgeRadius />

      {tool === 'shape' && <ShapeSides />}

      <Revolve />

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
            title="Where a NEW point lands when you click empty space. Points that already exist can be clicked wherever they are, at any depth, unless Ctrl is held, which keeps everything on this plane."
          >
            {planeLocked && <Lock className="w-3 h-3" />}
            {planeLocked ? 'Locked To' : 'New Points At'}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">
              {plane.axis} = {formatStep(plane.index * unitMm)}
            </span>
            {/* The hold that stays on. Ctrl holds the plane for as long as it
                is held, which is one hand spoken for; this is for drawing on
                a plane for a while. Caps Lock is the same switch. */}
            <button
              type="button"
              onClick={() => setPlaneHold(!planeHold)}
              title={planeHold
                ? 'Let the plane follow the pointer again (Caps Lock)'
                : 'Hold the plane where it is: the lit slice stops moving, reaches far past the shape, and only points on it can be clicked (Caps Lock)'}
              className={`p-1 rounded-md transition-colors cursor-pointer ${
                planeHold
                  ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                  : 'text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800'
              }`}
            >
              {planeHold ? <Lock className="w-3 h-3" /> : <LockOpen className="w-3 h-3" />}
            </button>
          </span>
        </div>
        <div className="flex gap-1">
          {AXES.map((axis) => (
            <button
              key={axis}
              type="button"
              onClick={() => setPlane({ axis, index: 0 })}
              title={`Work on slices perpendicular to ${axis.toUpperCase()}. Press ${axis.toUpperCase()} to turn the plane; it lands at whatever the pointer is on.`}
              className={`flex-1 py-1 rounded-md text-[11px] font-bold uppercase transition-colors cursor-pointer ${
                plane.axis === axis
                  ? 'bg-sky-500/15 text-sky-600 dark:text-sky-300'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-400 hover:text-slate-600'
              }`}
            >
              {axis}
              <span className="ml-0.5 opacity-40">{axis.toUpperCase()}</span>
            </button>
          ))}
        </div>
        <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
          The lit slice follows your pointer. Hold <kbd className="font-mono">Ctrl</kbd> to
          stay on the one you are pointing at: it stops moving, reaches out past the shape,
          and only points on it can be clicked. The lock button or <kbd className="font-mono">Caps Lock</kbd> holds
          it without a key down; picking a drawing tool switches it on. Points snap to the
          grid chosen in the viewport's grid menu, bottom right.
          <kbd className="font-mono"> X</kbd>/<kbd className="font-mono">Y</kbd>/<kbd className="font-mono">Z</kbd> turns it,
          <kbd className="font-mono"> [</kbd> / <kbd className="font-mono">]</kbd> moves it a step, Shift for five.
        </p>
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
                ? 'Show and export the cage itself, with flat faces and hard edges.'
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
        {subdiv > 0 && (
          <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
            Four corners smooth to a rounded square and never to a circle. Cut the corners
            off first with <kbd className="font-mono">B</kbd>; eight corners read as round.
          </p>
        )}
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

      {/* Cuts. The grid gives you exact whole steps and nothing between them;
          this is where a real diameter comes from — a 6.35 mm bore is on no
          grid worth modelling at. The controls are the same ones every other
          body gets; only the reason they are needed is particular to a lattice. */}
      <div className="space-y-1.5">
        <div className="flex items-baseline justify-between">
          <span className={`${labelClass} flex items-center gap-1`}><CutIcon className="w-3 h-3" />Cut</span>
          {cuts.length > 0 && (
            <span className="text-[10px] font-mono text-slate-600 dark:text-slate-300">
              {cuts.length} in this part
            </span>
          )}
        </div>
        {node && (
          <CutControls
            node={node}
            disabled={!solidEnough}
            disabledReason="Close the surface first, or give it a wall. An open surface has no inside to cut into."
          />
        )}
        {cuts.length > 0 && (
          <p className="text-[10px] leading-snug text-slate-400 dark:text-slate-500">
            The cage is still what you edit. Move a face and the material around a cut
            moves with it, and the cut stays where you put it.
          </p>
        )}
      </div>

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
          {/* Inside-out faces. Worth a button rather than a note: nothing in the
              viewport used to show them, they cost nothing to fix, and the only
              other way to find out is to close the tools and watch half the
              part disappear. */}
          {stats.inconsistent > 0 && (
            <button
              type="button"
              onClick={requestLatticeOrient}
              title="Turn every face to agree with its neighbours and point outwards. A face drawn from the wrong side is invisible from outside and a hole in anything exported. The editor shows the back of one in red."
              className="flex items-center gap-1.5 w-full py-1.5 px-2 rounded-lg text-[10px] font-semibold transition-colors cursor-pointer bg-rose-50 dark:bg-rose-950/30 text-rose-600 dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/40"
            >
              <RefreshCw className="w-3 h-3 shrink-0" />
              <span className="text-left">
                {stats.inconsistent} face{stats.inconsistent === 1 ? '' : 's'} inside-out. Turn {stats.inconsistent === 1 ? 'it' : 'them'} out (N)
              </span>
            </button>
          )}
          {/* Several pieces in one cage. Modelling wants them together; moving
              one against another, or subtracting one from another, wants them
              apart — and the boolean controls only know bodies. */}
          {(stats.parts ?? 1) > 1 && (
            <button
              type="button"
              onClick={() => separateLattice(latticeNodeId)}
              title="Make each separate piece of this cage its own body, at the same place. Then each can be moved, and one can be added to or cut from another with the Combine controls in the inspector."
              className="flex items-center gap-1.5 w-full py-1.5 px-2 rounded-lg text-[10px] font-semibold transition-colors cursor-pointer bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300 hover:bg-sky-100 dark:hover:bg-sky-900/40"
            >
              <Boxes className="w-3 h-3 shrink-0" />
              <span className="text-left">{stats.parts} separate pieces. Split into {stats.parts} bodies</span>
            </button>
          )}
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
              <kbd className="font-mono"> H</kbd> to hold it sharp.
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
                  ? 'Open, but walled: the shell above closes it when the mesh is built.'
                  : 'Surface is not closed. Give it a wall above, or cap it by hand.'}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Every key, in one place. The mode has more of them than a tooltip can
          carry, and a shortcut nobody can find is a shortcut nobody has — which
          is how a tool that exists goes on being asked for. */}
      <div className="pt-2 border-t border-slate-200 dark:border-slate-800">
        <button
          type="button"
          onClick={() => setKeysOpen((open) => !open)}
          className="flex items-center gap-1 w-full text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
        >
          <Keyboard className="w-3 h-3" />
          Keys
          <ChevronDown className={`w-3 h-3 ml-auto transition-transform ${keysOpen ? 'rotate-180' : ''}`} />
        </button>

        {keysOpen && (
          <dl className="mt-2 space-y-2">
            {KEYS.map((group) => (
              <div key={group.title}>
                <dt className="text-[9px] font-bold uppercase tracking-wider text-slate-300 dark:text-slate-600 mb-0.5">
                  {group.title}
                </dt>
                {group.keys.map(([combo, what]) => (
                  <dd key={combo} className="flex gap-2 text-[10px] leading-snug text-slate-500 dark:text-slate-400">
                    <kbd className="font-mono font-semibold text-slate-600 dark:text-slate-300 shrink-0 w-14">{combo}</kbd>
                    <span className="flex-1">{what}</span>
                  </dd>
                ))}
              </div>
            ))}
          </dl>
        )}
      </div>

    </div>
  );
}

export default LatticePanel;
