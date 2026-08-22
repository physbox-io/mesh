import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  X, AlertCircle, Cpu, Play, Home, ShieldAlert, RefreshCw, Info, ChevronRight, Layers, Mountain, Pause,
} from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import {
  generateReliefCarveGcode,
  DEFAULT_RELIEF_OPTIONS,
  deriveReliefFeeds,
  describeCutter,
  recommendReliefTooling,
  type ReliefCarveOptions,
  type ReliefCarveResult,
  type ReliefOverrides,
} from '../utils/reliefCarveExporter';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { clockMoves, formatDuration, type ClockedMove, type TimedMove } from '../utils/timeEstimate';
import { MATERIALS, describeSpeedRecommendation, recommendSpeeds } from '../utils/feedsAndSpeeds';
import { getGridStats, type ProbeGrid } from '../utils/meshLeveler';
import { NumberInput } from './NumberInput';
import { MachineWorkOriginPanel } from './MachineWorkOriginPanel';
import { JobOverrides, JobPauseBanner, JobPreflight, JobTransport } from './MachineJobControls';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
  /** Opens the app's zeroing walkthrough from the machine panel. */
  onOpenDocs?: () => void;
}

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:opacity-40';

const labelClass = 'text-xs font-semibold text-slate-600 dark:text-slate-300';

const sectionClass =
  'p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-4';

const sectionTitleClass =
  'text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

const hintBubbleClass =
  'pointer-events-none absolute top-full z-30 mt-1.5 w-max max-w-[min(14rem,70vw)] rounded-lg ' +
  'bg-slate-900 dark:bg-slate-950 px-2.5 py-2 text-[11px] font-normal leading-snug text-slate-100 ' +
  'shadow-xl ring-1 ring-slate-700 opacity-0 transition-opacity ' +
  'group-hover:opacity-100 group-focus-within:opacity-100';

function HintIcon() {
  return (
    <Info
      className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 hover:text-blue-500 cursor-help"
      tabIndex={0}
      aria-label="What is this?"
    />
  );
}

function Field({
  label, hint, hintAlign = 'start', className, children,
}: {
  label: string;
  hint: string;
  hintAlign?: 'start' | 'end';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col min-w-0 ${className ?? ''}`}>
      <div className="group relative flex items-center space-x-1 mb-1.5">
        <label className={labelClass}>{label}</label>
        <HintIcon />
        <span role="tooltip" className={`${hintBubbleClass} ${hintAlign === 'end' ? 'right-0' : 'left-0'}`}>
          {hint}
        </span>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

/**
 * What the job will actually do, in the units the machine uses.
 *
 * The counterpart to hiding the feeds: a beginner should not have to fill six
 * numbers in, but they should be able to see the six numbers that were chosen
 * for them, and be told when one of them is a compromise. Modelled on the same
 * card in the sibling editor, so the two apps read alike.
 */
function DerivedRecipe({
  title, line, notes,
}: { title: string; line: string; notes?: (string | null | undefined)[] }) {
  const real = (notes ?? []).filter(Boolean) as string[];
  return (
    <div className="rounded-lg bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2.5 py-2">
      <span className="text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">
        {title}
      </span>
      <p className="mt-0.5 font-mono text-[11px] text-slate-800 dark:text-slate-100">{line}</p>
      {real.map((n) => (
        <p
          key={n}
          className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400 leading-snug"
        >
          <AlertCircle className="w-3 h-3 mt-px flex-shrink-0" />
          <span>{n}</span>
        </p>
      ))}
    </div>
  );
}

function Advanced({ label = 'Advanced', children }: { label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center space-x-1 text-[11px] font-bold uppercase tracking-wider text-slate-400
                   dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">{children}</div>
      )}
    </div>
  );
}

/**
 * A two- or three-way switch that fits the column it is put in.
 *
 * `min-w-0` and `truncate` rather than `whitespace-nowrap`: a flex child will
 * not shrink below its content's width unless it is told it may, so a label a
 * few characters too long for its grid cell used to push the whole control out
 * past the field beside it. Now it ellipsizes instead, and the `title` keeps
 * the full text reachable.
 *
 * That is the backstop, not the plan — a label people have to hover to read is
 * a label that is too long. Keep them short enough that the ellipsis never
 * appears at the widths these grids actually use.
 */
function Segmented<T extends string>({
  value, options, onChange,
}: { value: T; options: readonly (readonly [T, string])[]; onChange: (v: T) => void }) {
  return (
    <div className="flex bg-slate-200 dark:bg-slate-700/60 p-0.5 rounded-lg">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          title={label}
          className={`flex-1 min-w-0 py-1 px-2 rounded-md text-xs font-medium transition-all truncate ${
            value === v
              ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Drops the settings a recommendation makes that are derived elsewhere.
 *
 * `recommendReliefTooling` answers one question — which cutters to fit — and
 * returns a whole options patch. Writing the feeds it also computes into state
 * would leave numbers sitting in `options` that `deriveReliefFeeds` immediately
 * shadows, which is the kind of thing that reads as a bug six months later.
 */
const DERIVED_KEYS = [
  'spindleRpm',
  'finishingFeedrate',
  'finishingPlungeRate',
  'finishingStepoverPercent',
  'finishingStepdownMm',
  'roughingFeedrate',
  'roughingPlungeRate',
  'roughingStepdownMm',
  'roughingAllowanceMm',
] as const;

function toolingOnly(patch: Partial<ReliefCarveOptions>): Partial<ReliefCarveOptions> {
  const out = { ...patch };
  for (const key of DERIVED_KEYS) delete out[key];
  return out;
}

/**
 * Holds a value still until edits stop.
 *
 * Regenerating the carve means re-sampling the whole surface and dilating it by
 * the cutter, which is a few hundred milliseconds of solid work — far too much
 * to run between two keystrokes in a stock-size box.
 */
function useSettled<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return settled;
}

/** Rapid traverse the preview animates retracts at, mm/min. */
const RAPID_MM_MIN = 3000;

/** How long a full simulated run takes on screen, before the speed multiplier. */
const PLAYBACK_SECONDS = 45;

/**
 * The order the tool visits the preview's points, as one flat list of moves.
 *
 * The decimated segments are already in program order, so walking them and
 * putting a rapid between each pair reproduces the shape of the program: cut
 * the pass, lift, fly to the head of the next one, drop in. Those rapids are a
 * real share of a raster job's clock and a real part of what the animation has
 * to show, because a job whose retracts are invisible looks like it is cutting
 * continuously when in fact it spends a third of its life in the air.
 *
 * This is a preview of the toolpath rather than a second parse of the file: the
 * points are decimated and the lead-in ramps are not in them. The total is
 * therefore rescaled to the exporter's own figure, which *is* taken off the
 * finished program — so the clock at the bottom of the animation and the "Est.
 * Time" above it are the same number, and the playhead's local pace still slows
 * where the machine will slow.
 */
function buildPreviewPath(
  result: ReliefCarveResult,
  options: ReliefCarveOptions
): { moves: ClockedMove[]; seconds: number } {
  const raw: TimedMove[] = [];
  let at: { x: number; y: number; z: number } | null = null;

  for (const seg of result.segments) {
    if (seg.points.length === 0) continue;
    const feed = seg.type === 'roughing' ? options.roughingFeedrate : options.finishingFeedrate;
    const head = seg.points[0];

    if (at) {
      // Up, across, down — the retract the exporter writes between passes.
      raw.push({ x1: at.x, y1: at.y, z1: at.z, x2: at.x, y2: at.y, z2: options.safeZ, feed: RAPID_MM_MIN, rapid: true });
      raw.push({ x1: at.x, y1: at.y, z1: options.safeZ, x2: head.x, y2: head.y, z2: options.safeZ, feed: RAPID_MM_MIN, rapid: true });
      raw.push({ x1: head.x, y1: head.y, z1: options.safeZ, x2: head.x, y2: head.y, z2: head.z, feed: Math.max(1, options.finishingPlungeRate), rapid: false });
    }

    for (let i = 0; i + 1 < seg.points.length; i++) {
      const a = seg.points[i];
      const b = seg.points[i + 1];
      raw.push({ x1: a.x, y1: a.y, z1: a.z, x2: b.x, y2: b.y, z2: b.z, feed, rapid: false });
    }
    at = seg.points[seg.points.length - 1];
  }

  const clocked = clockMoves(raw);
  if (clocked.length === 0) return { moves: clocked, seconds: 0 };

  const previewTotal = clocked[clocked.length - 1].t1;
  const trueTotal = result.estimatedTimeSeconds;
  const scale = previewTotal > 1e-6 && trueTotal > 0 ? trueTotal / previewTotal : 1;
  if (scale !== 1) {
    for (const m of clocked) {
      m.t0 *= scale;
      m.t1 *= scale;
    }
  }
  return { moves: clocked, seconds: clocked[clocked.length - 1].t1 };
}

/** The move in flight at time `t`, by binary search over the cumulative clock. */
function moveIndexAt(moves: ClockedMove[], t: number): number {
  let lo = 0;
  let hi = moves.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (moves[mid].t1 < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Interactive toolpath viewport, with a dry run of the cut and a live trace of
 * the real one.
 *
 * The renderer is built once for as long as the modal is open and only its
 * contents are swapped, because tearing a WebGL context down and standing a new
 * one up on every parameter change leaks canvases and GPU buffers.
 *
 * The whole path goes into one buffer in program order, so revealing "what has
 * been cut so far" is a `setDrawRange` on a second pass over the same geometry
 * rather than a rebuild every frame. At sixty thousand points a rebuild is the
 * difference between an animation and a slideshow.
 *
 * Two things drive the playhead. With no machine running it is a simulation:
 * the job's own clock, compressed into `PLAYBACK_SECONDS`, so a four-hour carve
 * can be watched in under a minute and still spends its time where the machine
 * will. With a job on the wire it is the machine — the marker sits at the
 * position the controller is reporting, and the bright path is what has
 * actually been cut. That is the view worth having open while a carve runs:
 * where the tool is, and how much of the picture is already in the wood.
 */
function ToolpathView({
  result,
  options,
  machineState,
}: {
  result: ReliefCarveResult;
  options: ReliefCarveOptions;
  machineState: MachineState;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  /** Set by the geometry effect, read by the frame loop. */
  const cutRef = useRef<THREE.LineSegments | null>(null);
  const toolRef = useRef<THREE.Object3D | null>(null);

  const path = useMemo(() => buildPreviewPath(result, options), [result, options]);

  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  /** Job seconds, not wall-clock seconds. */
  const [clock, setClock] = useState(0);

  // A job on the machine takes the playhead over. Nothing simulated is worth
  // watching while the real thing is running two feet away.
  const live =
    machineState.status === 'RUNNING' || machineState.status.startsWith('PAUSED');

  // Mirrors of the three things the animation frame and the imperative Three.js
  // code need to read but must not be restarted by. They are written in effects
  // rather than during render, and declared in the order the readers below
  // expect to find them fresh.
  const pathRef = useRef(path);
  const clockRef = useRef(0);
  const liveRef = useRef({ live, wpos: machineState.wpos });

  useEffect(() => { pathRef.current = path; }, [path]);
  useEffect(() => { clockRef.current = clock; }, [clock]);
  useEffect(() => { liveRef.current = { live, wpos: machineState.wpos }; }, [live, machineState.wpos]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(45, 1, 1, 4000);
    camera.up.set(0, 0, 1);
    camera.position.set(160, -200, 190);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    // The same mapping as the main editor: middle drag pans, right drag orbits,
    // and left is left alone. Two viewports in one app that answer the same
    // gesture differently is worse than either mapping on its own — the hand
    // that has learned the scene view arrives here and the model spins when it
    // meant to pan.
    controls.mouseButtons = {
      LEFT: 99 as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };

    const group = new THREE.Group();
    contentRef.current = group;
    scene.add(group);

    const resize = () => {
      const w = mount.clientWidth || 600;
      const h = mount.clientHeight || 360;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);

    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      renderer.dispose();
      renderer.domElement.remove();
      contentRef.current = null;
      sceneRef.current = null;
      cutRef.current = null;
      toolRef.current = null;
    };
  }, []);

  useEffect(() => {
    const group = contentRef.current;
    if (!group) return;

    group.clear();
    const dispose: (THREE.BufferGeometry | THREE.Material)[] = [];

    // Everything inside the group is in work coordinates, where zero is the
    // stock's near-left corner. The camera orbits the viewport's origin, so the
    // group is slid back by half the stock to keep the block centred on screen.
    group.position.set(-options.stockWidthMm / 2, -options.stockDepthMm / 2, 0);

    const stock = new THREE.BoxGeometry(options.stockWidthMm, options.stockDepthMm, options.stockThicknessMm);
    const stockMat = new THREE.MeshBasicMaterial({ color: 0x94a3b8, wireframe: true, transparent: true, opacity: 0.35 });
    const stockMesh = new THREE.Mesh(stock, stockMat);
    // Work zero is the stock's near-left corner, so the block sits in the +X +Y
    // quadrant rather than straddling the origin.
    stockMesh.position.set(
      options.stockWidthMm / 2,
      options.stockDepthMm / 2,
      -options.stockThicknessMm / 2
    );
    group.add(stockMesh);
    dispose.push(stock, stockMat);

    // One buffer, in program order, two vertices per move. Everything the
    // animation does — reveal, rewind, follow the machine — is then a draw
    // range on this, and the colours say what each move is for.
    const moves = path.moves;
    const positions = new Float32Array(moves.length * 6);
    const colours = new Float32Array(moves.length * 6);
    const ROUGH = new THREE.Color(0xf59e0b);
    const FINISH = new THREE.Color(0x3b82f6);
    const TRAVEL = new THREE.Color(0x475569);
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      positions.set([m.x1, m.y1, m.z1, m.x2, m.y2, m.z2], i * 6);
      // A cut above the stock's top face can only be a plunge or a link; the
      // roughing pass and the finishing raster are told apart by their feed.
      const c = m.rapid
        ? TRAVEL
        : m.feed === options.roughingFeedrate
          ? ROUGH
          : FINISH;
      colours.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    dispose.push(geo);

    // The whole path, faint: where the tool is going.
    const planMat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.18 });
    group.add(new THREE.LineSegments(geo, planMat));
    dispose.push(planMat);

    // The same path at full strength, clipped to what has been cut. Drawn over
    // the top without a depth test, because the two are the same line and would
    // otherwise fight for the pixel.
    const cutMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false });
    const cut = new THREE.LineSegments(geo, cutMat);
    cut.renderOrder = 1;
    cut.frustumCulled = false;
    group.add(cut);
    cutRef.current = cut;
    dispose.push(cutMat);

    // The tool itself: a cone pointing down at where the tip is.
    const toolGeo = new THREE.ConeGeometry(
      Math.max(1.2, options.finishingToolDiaMm / 2),
      Math.max(5, options.finishingToolDiaMm * 3),
      12
    );
    const toolMat = new THREE.MeshBasicMaterial({ color: 0xf1f5f9, transparent: true, opacity: 0.85 });
    const tool = new THREE.Mesh(toolGeo, toolMat);
    tool.rotation.x = Math.PI / 2; // cone's axis is +Y by default; this points it down -Z
    tool.renderOrder = 2;
    group.add(tool);
    toolRef.current = tool;
    dispose.push(toolGeo, toolMat);

    const grid = new THREE.GridHelper(
      Math.max(options.stockWidthMm, options.stockDepthMm) * 1.5,
      20, 0x64748b, 0x475569
    );
    grid.rotation.x = Math.PI / 2;
    grid.position.set(options.stockWidthMm / 2, options.stockDepthMm / 2, -options.stockThicknessMm);
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    group.add(grid);

    return () => {
      group.clear();
      cutRef.current = null;
      toolRef.current = null;
      for (const d of dispose) d.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    };
  }, [
    path,
    options.stockWidthMm,
    options.stockDepthMm,
    options.stockThicknessMm,
    options.finishingToolDiaMm,
    options.roughingFeedrate,
  ]);

  // A new carve is a new path, so the playhead goes back to the start rather
  // than sitting at a time the new job may not even have. Done during render
  // rather than in an effect, so no frame is ever drawn with the old clock
  // against the new geometry.
  const [clockedPath, setClockedPath] = useState(path);
  if (clockedPath !== path) {
    setClockedPath(path);
    setClock(0);
  }

  /**
   * Moves the drawn state to a point on the job clock.
   *
   * Split out of the frame loop because the scrub bar and the machine both need
   * it, and neither of them ticks.
   */
  const applyClock = useCallback((t: number) => {
    const moves = pathRef.current.moves;
    const cut = cutRef.current;
    const tool = toolRef.current;
    if (!cut || moves.length === 0) return;

    const i = moveIndexAt(moves, t);
    const m = moves[i];
    const span = m.t1 - m.t0;
    const f = span > 0 ? Math.min(1, Math.max(0, (t - m.t0) / span)) : 1;

    cut.geometry.setDrawRange(0, i * 2 + 2);

    if (tool) {
      const state = liveRef.current;
      // While a job is on the machine the tool marker is the machine's own
      // reported position, not the simulation's: the point of watching it is to
      // see where the spindle actually is, including the moments it is not
      // where the program thinks.
      if (state.live) {
        tool.position.set(state.wpos.x, state.wpos.y, state.wpos.z);
      } else {
        tool.position.set(
          m.x1 + (m.x2 - m.x1) * f,
          m.y1 + (m.y2 - m.y1) * f,
          m.z1 + (m.z2 - m.z1) * f
        );
      }
      // The cone's tip is at its base, half its height below the origin.
      tool.position.z += Math.max(5, options.finishingToolDiaMm * 3) / 2;
    }
  }, [options.finishingToolDiaMm]);

  useEffect(() => {
    applyClock(clock);
  }, [clock, applyClock, path]);

  // Follow the machine. Line count is what GRBL's progress is reported in and
  // the program is very nearly one move per line, so it maps onto the path
  // closely enough to show which passes are done.
  useEffect(() => {
    if (!live) return;
    const moves = pathRef.current.moves;
    if (moves.length === 0) return;
    const frac = Math.min(1, Math.max(0, machineState.progressPercent / 100));
    setClock(pathRef.current.seconds * frac);
  }, [live, machineState.progressPercent, machineState.wpos.x, machineState.wpos.y, machineState.wpos.z]);

  // The dry run. Compressed onto a fixed screen duration, because the thing
  // being previewed can be a four-hour carve.
  useEffect(() => {
    if (live || !playing || path.seconds <= 0) return;
    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const advance = (path.seconds / PLAYBACK_SECONDS) * speed * dt;
      const next = clockRef.current + advance;
      setClock(next >= path.seconds ? 0 : next);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [live, playing, speed, path]);

  const done = path.seconds > 0 ? Math.round((clock / path.seconds) * 100) : 0;

  return (
    <div className="space-y-2">
      <div className="w-full h-80 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden" ref={mountRef} />

      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={() => setPlaying((p) => !p)}
          disabled={live}
          title={live ? 'The machine is driving the playhead' : playing ? 'Pause the preview' : 'Play the preview'}
          className="p-1.5 rounded-lg bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {playing && !live ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
        </button>

        <input
          type="range"
          min={0}
          max={Math.max(0.001, path.seconds)}
          step={Math.max(0.001, path.seconds / 2000)}
          value={Math.min(clock, path.seconds)}
          disabled={live}
          onChange={(e) => {
            setPlaying(false);
            setClock(parseFloat(e.target.value));
          }}
          aria-label="Scrub the toolpath preview"
          className="flex-1 min-w-[8rem] accent-blue-500 disabled:opacity-50"
        />

        <span className="font-mono text-[11px] tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
          {formatDuration(clock)} / {formatDuration(path.seconds)} ({done}%)
        </span>

        {live ? (
          <span className="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/20 text-emerald-500 border border-emerald-500/40 whitespace-nowrap">
            Tracing the machine
          </span>
        ) : (
          <div className="flex items-center space-x-1">
            {([1, 4, 16] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSpeed(s)}
                className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  speed === s
                    ? 'bg-blue-500 text-slate-950'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {s}&times;
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const ExportReliefCarveModal: React.FC<Props> = ({ isOpen, onClose, scene, onOpenDocs }) => {
  const [options, setOptions] = useState<ReliefCarveOptions>(DEFAULT_RELIEF_OPTIONS);
  const set = <K extends keyof ReliefCarveOptions>(key: K, value: ReliefCarveOptions[K]) =>
    setOptions((prev) => ({ ...prev, [key]: value }));

  /**
   * Feeds and speeds the operator has taken over.
   *
   * Empty by default, and every field in it stays empty until somebody types in
   * it — at which point that one number stops tracking the material and the bit
   * and does exactly what it was told, including things the cutter will not
   * survive. Everything not in here is worked out afresh on every change, so
   * switching from pine to aluminium moves the whole recipe rather than leaving
   * a pine feed sitting in a box above an aluminium job.
   */
  const [overrides, setOverrides] = useState<ReliefOverrides>({});
  /** Typing a number takes a field over; clearing it hands it back to the recipe. */
  const override = <K extends keyof ReliefOverrides>(key: K, value: number | null) =>
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  const _override = <K extends keyof ReliefOverrides>(key: K, value: number | null) =>
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === null) delete next[key];
      else next[key] = value;
      return next;
    });
  void _override;

  const [probeCols, setProbeCols] = useState(3);
  const [probeRows, setProbeRows] = useState(3);
  const [isProbing, setIsProbing] = useState(false);
  const [probeProgress, setProbeProgress] = useState({ current: 0, total: 0 });
  const [probedGrid, setProbedGrid] = useState<ProbeGrid | null>(null);
  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());

  useEffect(() => {
    if (!isOpen) return;
    return webSerialManager.addListener(setMachineState);
  }, [isOpen]);

  /** What the bits and the material imply, before anyone overrides anything. */
  /**
   * Fastest the gantry tracks while cutting, mm/min.
   *
   * The lower of the machine's own X and Y maximum rates. A cut is a
   * two-axis move, so the slower of the pair is the one that governs it.
   */
  const cuttingRateLimit = Math.min(machineState.motion.maxRate.x, machineState.motion.maxRate.y);

  // Deliberately narrow: naming `options` entire would recompute the recipe on
  // every keystroke in an unrelated box and restart the 250 ms settle behind it.
  const {
    material, finishingToolDiaMm, finishingFlutes, roughingToolDiaMm, roughingFlutes, carveDepthMm,
  } = options;
  const derived = useMemo(
    () =>
      deriveReliefFeeds(
        { material, finishingToolDiaMm, finishingFlutes, roughingToolDiaMm, roughingFlutes, carveDepthMm },
        machineState.motion.spindle,
        cuttingRateLimit
      ),
    [
      cuttingRateLimit,
      material,
      finishingToolDiaMm,
      finishingFlutes,
      roughingToolDiaMm,
      roughingFlutes,
      carveDepthMm,
      machineState.motion.spindle,
    ]
  );

  // What the job is actually cut with: the chosen tooling, the derived recipe
  // for it, and then whatever the operator has said otherwise.
  const effective = useMemo<ReliefCarveOptions>(
    () => ({ ...options, ...derived, ...overrides }),
    [options, derived, overrides]
  );

  const settled = useSettled(effective, 250);
  const pending = settled !== effective;

  const result = useMemo(() => {
    if (!isOpen) return null;
    return generateReliefCarveGcode(scene, {
      ...settled,
      // The connected machine's own acceleration and traverse limits, so the
      // run-time estimate sharpens from a guess into a measurement the moment
      // the USB lead goes in.
      motionProfile: machineState.motion,
      meshLevelGrid: probedGrid,
      applyMeshLeveling: settled.applyMeshLeveling && probedGrid !== null,
    });
  }, [isOpen, scene, settled, probedGrid, machineState.motion]);

  // Tooling is a function of the carve, not of the model, so it is derived from
  // what the carve actually came out as — the relief's real depth and the plan
  // it landed on — rather than shipped alongside the mesh.
  const applyRecommendedTooling = () => {
    if (!result?.success) return;
    // Clearing the overrides is the point as much as the tooling is: a feed
    // typed for the old bit must not survive a change of bit.
    setOverrides({});
    setOptions((prev) => ({
      ...prev,
      // Tooling only. Feeds and speeds follow from it and are derived rather
      // than stored, so the ones this returns are dropped instead of being
      // written into state where they would sit shadowed and misleading.
      ...toolingOnly(recommendReliefTooling({
        reliefDepthMm: result.reliefDepthMm,
        planWidthMm: result.carveBounds.maxX - result.carveBounds.minX,
        planDepthMm: result.carveBounds.maxY - result.carveBounds.minY,
        material: prev.material,
        // What this spindle can be dialled to, from the controller when it said.
        spindle: machineState.motion.spindle,
        maxFeedMmMin: cuttingRateLimit,
      })),
    }));
  };

  if (!isOpen) return null;

  // What the operator has to do to the machine before this file will cut what
  // it says it cuts. Derived from the settled options rather than the live ones
  // so it describes the program that would actually be sent.
  const materialLabel = (MATERIALS.find((m) => m.id === settled.material)?.label ?? settled.material).toLowerCase();
  const finishTool = describeCutter(
    settled.finishingToolDiaMm,
    settled.finishingToolType,
    settled.finishingFlutes,
    settled.finishingGeometry,
    settled.finishingVBitAngleDeg
  );
  const roughTool = describeCutter(
    settled.roughingToolDiaMm,
    'flat',
    settled.roughingFlutes,
    settled.roughingGeometry
  );
  const swaps = !!result?.toolChange;
  const idealSpeeds = recommendSpeeds({
    diameterMm: settled.finishingToolDiaMm,
    flutes: settled.finishingFlutes,
    material: settled.material,
    spindle: machineState.motion.spindle,
    maxFeedMmMin: cuttingRateLimit,
  });
  // Said once, on the finishing card and again before the start button: the
  // recommendation had to give something up, or the number in the box is not
  // the number the material and the bit ask for.
  const speedNote =
    overrides.spindleRpm !== undefined && Math.abs(idealSpeeds.rpm - effective.spindleRpm) > idealSpeeds.rpm * 0.15
      ? `Overridden. ${describeSpeedRecommendation(idealSpeeds, settled.material, settled.finishingToolDiaMm)}`
      : idealSpeeds.clampedBy
        ? describeSpeedRecommendation(idealSpeeds, settled.material, settled.finishingToolDiaMm)
        : null;

  const preflight = {
    material: materialLabel,
    firstTool: settled.roughingEnabled ? roughTool : finishTool,
    secondTool: swaps ? finishTool : undefined,
    // Only worth saying when the number in the box is not the number the
    // material and the bit ask for, or when the recommendation itself had to
    // give something up.
    caveat: speedNote,
  };

  const stats = probedGrid ? getGridStats(probedGrid) : null;
  const canCarve = !!result?.success && machineState.connected && machineState.status === 'IDLE';

  const handleConnectUsb = async () => {
    if (machineState.connected) await webSerialManager.disconnect();
    else await webSerialManager.connect();
  };

  const handleStartCarve = () => {
    if (!result?.gcode) return;
    webSerialManager.startJob(result.gcode);
  };

  const handleFrameTrace = async () => {
    if (!result?.carveBounds) return;
    await webSerialManager.frameJob(result.carveBounds, 0);
  };

  /**
   * Probes the bed across the carve's own footprint. A relief's finishing pass
   * can be a couple of tenths deep at its shallowest, so a bed half a millimetre
   * out of true is the difference between a surface and a scratch.
   */
  const handleProbeBed = async () => {
    if (!result?.carveBounds) return;
    setIsProbing(true);
    setProbeProgress({ current: 0, total: probeCols * probeRows });
    try {
      const grid = await webSerialManager.probeGrid(
        result.carveBounds,
        probeCols,
        probeRows,
        (current, total) => setProbeProgress({ current, total })
      );
      setProbedGrid(grid);
      set('applyMeshLeveling', true);
    } finally {
      setIsProbing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-2 sm:p-4 animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] sm:max-h-[90dvh] flex flex-col overflow-hidden">

        {/* Header */}
        <div className="flex items-start justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="flex items-center space-x-2.5 min-w-0">
            <div className="hidden sm:block p-2 bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-lg">
              <Mountain className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-slate-800 dark:text-slate-100">
                Carve 3D Relief on CNC
              </h2>
              <p className="hidden sm:block text-xs text-slate-500 dark:text-slate-400">
                Squash the model's height into the face of a block and cut it over WebSerial USB (GRBL / Marlin)
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-200/50 dark:hover:bg-slate-700/50 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto overflow-x-clip p-4 sm:p-6 space-y-5">

          {/* Stock & relief */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Stock &amp; Relief</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-3"
                label="Stock Block (mm)"
                hint="Width, depth and thickness of the block clamped on the bed. The job's origin is the near-left corner of its top face, so zero the machine there before you start — the whole carve runs +X and +Y from zero."
              >
                <div className="flex items-center space-x-1.5">
                  <NumberInput
                    step="10" min={10} max={2000}
                    value={options.stockWidthMm}
                    onChange={(v) => set('stockWidthMm', v)}
                    className={`${inputClass} px-2`}
                    aria-label="Stock width in mm"
                  />
                  <span className="text-xs font-medium text-slate-400">&times;</span>
                  <NumberInput
                    step="10" min={10} max={2000}
                    value={options.stockDepthMm}
                    onChange={(v) => set('stockDepthMm', v)}
                    className={`${inputClass} px-2`}
                    aria-label="Stock depth in mm"
                  />
                  <span className="text-xs font-medium text-slate-400">&times;</span>
                  <NumberInput
                    step="1" min={1} max={300}
                    value={options.stockThicknessMm}
                    onChange={(v) => set('stockThicknessMm', v)}
                    className={`${inputClass} px-2`}
                    aria-label="Stock thickness in mm"
                  />
                </div>
              </Field>

              <Field
                className="lg:col-span-3"
                label="Material"
                hint="What is clamped on the bed. It is the one setting here that is not a property of the model, and every feed and speed follows from it: surface speed over cutter diameter gives the spindle RPM, and chip-per-tooth times teeth times RPM gives the feed. 18,000 RPM is right for pine and ruinous for aluminium, and nothing about a mesh can tell the difference."
              >
                <select
                  value={options.material}
                  onChange={(e) => set('material', e.target.value as typeof options.material)}
                  className={`${inputClass} cursor-pointer`}
                >
                  {MATERIALS.map((mat) => (
                    <option key={mat.id} value={mat.id}>{mat.label}</option>
                  ))}
                </select>
              </Field>

              <Field
                className="lg:col-span-2"
                label="Height Scale"
                hint="Fill Depth stretches the model's height range onto the relief depth, so the carve is always exactly that deep — but Z is then unrelated to X and Y, and fitting the model onto smaller stock shrinks the plan while leaving the height alone, which multiplies the exaggeration by the same factor. Proportional puts Z on the plan scale instead, so the carve keeps the shape the model was authored with and the exaggeration is the number you set, not one that falls out of the stock size."
              >
                <Segmented
                  value={options.verticalScaleMode}
                  onChange={(v) => set('verticalScaleMode', v)}
                  options={[['fill', 'Fill Depth'], ['proportional', 'Proportional']] as const}
                />
              </Field>


              <Field
                label="Relief Depth (mm)"
                hint="How deep the lowest point of the carve sits below the top face. The model's whole height is compressed into this — that compression is what makes it a relief instead of a full 3D machining job."
              >
                <NumberInput
                  step="1" min={0.5} max={200}
                  value={options.carveDepthMm}
                  onChange={(v) => set('carveDepthMm', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Background"
                hint="What happens to the stock the model does not cover. Carve takes it down to the floor so the model stands proud of a flat field; Leave keeps it at full height and only cuts where the model dips, which is far quicker."
              >
                <Segmented
                  value={options.backgroundMode}
                  onChange={(v) => set('backgroundMode', v)}
                  options={[['carve', 'Carve Away'], ['skip', 'Leave At Top']] as const}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Relief Polarity"
                hint="Standard (Cameo) raises peaks toward the stock surface. Invert (Intaglio / Mold) carves peaks deepest into the block as negative cavities — ideal for casting molds or sunken engravings."
              >
                <Segmented
                  value={options.invertRelief ? 'invert' : 'normal'}
                  onChange={(v) => set('invertRelief', v === 'invert')}
                  options={[['normal', 'Cameo (Raised)'], ['invert', 'Intaglio (Sunken)']] as const}
                />
              </Field>



              <Field
                className="lg:col-span-3"
                hintAlign="end"
                label="Fitted Size"
                hint="The footprint the carve actually occupies on the stock at the current scale."
              >
                <div className="px-3 py-1.5 text-xs font-mono text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800/60 border border-slate-200 dark:border-slate-700 rounded-lg">
                  {result?.success
                    ? `${(result.carveBounds.maxX - result.carveBounds.minX).toFixed(1)} × ` +
                      `${(result.carveBounds.maxY - result.carveBounds.minY).toFixed(1)} mm ` +
                      `at ${(result.scaleFactor * 100).toFixed(0)}%`
                    : '—'}
                </div>
              </Field>
            </div>
            <Advanced>
              <Field
                label="Exaggeration (×)"
                hint="How much the height is stretched relative to the plan when using Model Proportions. 1 is the model's own shape. Terrain wants more than that — real mountains over a map-sized plan are a flat board — but the exaggeration stays what you asked for instead of drifting with the stock size."
              >
                <NumberInput
                  step="0.5" min={0.01} max={100}
                  value={options.verticalExaggeration}
                  onChange={(v) => set('verticalExaggeration', v)}
                  className={inputClass}
                  disabled={options.verticalScaleMode !== 'proportional'}
                />
              </Field>
              <Field
                className="lg:col-span-2"
                label="Plan Scale"
                hint="Fit to Stock sizes the model to the block. Manual holds a fixed scale, where 100% means one metre of scene is one millimetre of stock — anything hanging over the edge is cropped."
              >
                <Segmented
                  value={options.fitMode}
                  onChange={(v) => set('fitMode', v)}
                  options={[['fit', 'Fit to Stock'], ['manual', 'Manual']] as const}
                />
              </Field>
              <Field
                label="Scale (%)"
                hint="Manual plan-view scale. The relief depth is set separately, so changing this does not change how deep the carve goes."
              >
                <NumberInput
                  step="5" min={1} max={1000}
                  disabled={options.fitMode !== 'manual'}
                  value={options.scalePercent}
                  onChange={(v) => set('scalePercent', v)}
                  className={inputClass}
                />
              </Field>
            </Advanced>
          </div>

          {/* Finishing */}
          <div className={sectionClass}>
            <div className="flex items-center justify-between gap-4">
              <h3 className={sectionTitleClass}>Finishing Pass</h3>
              <button
                type="button"
                onClick={applyRecommendedTooling}
                disabled={!result?.success}
                title="Pick bits, stepdowns and feeds that suit this relief's depth and size"
                className="text-xs px-2 py-1 rounded border border-neutral-600 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                Suggest tooling
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-3"
                label="Cutter Shape"
                hint="A ball nose leaves a smooth surface on curves, and the toolpath is lifted to keep its round tip on the surface. A flat mill has to clear the highest point under its whole diameter, so it rounds off fine detail. A V-bit is a cone: it drops into corners and grooves no round cutter can enter and holds detail far finer than its diameter, which is why lettering and ornament are cut with one — but it only cuts as deep as the cone is tall, and it leaves a ridge between passes."
              >
                <Segmented
                  value={options.finishingToolType}
                  onChange={(v) => set('finishingToolType', v)}
                  options={[['ball_nose', 'Ball-Nose'], ['flat', 'Flat'], ['v_bit', 'V-Bit']] as const}
                />
              </Field>

              {options.finishingToolType === 'v_bit' && (
                <Field
                  label="V Angle (deg)"
                  hint="Included point angle, as it is written on the bit — 60 for a 60 degree V. It sets two things at once: how deep the bit can cut before the cone runs out and only the shank is left, and how tall a ridge the stepover leaves. Narrow holds finer detail and is more fragile."
                >
                  <Segmented
                    value={String(options.finishingVBitAngleDeg)}
                    onChange={(v) => set('finishingVBitAngleDeg', parseInt(v, 10))}
                    options={[['30', '30'], ['60', '60'], ['90', '90']] as const}
                  />
                </Field>
              )}

              <Field
                label="Bit Ø (mm)"
                hint="Diameter of the finishing cutter. It sets both the stepover and how much detail survives — nothing narrower than the bit can be cut. For a V-bit this is the diameter at the top of the cone, which is only reached at full depth."
              >
                <NumberInput
                  step="0.1" min={0.1} max={30}
                  value={options.finishingToolDiaMm}
                  onChange={(v) => set('finishingToolDiaMm', v)}
                  className={inputClass}
                />
              </Field>







            </div>

            <DerivedRecipe
              title={`Derived for ${materialLabel}`}
              line={
                `${effective.spindleRpm.toLocaleString()} RPM · ${effective.finishingFeedrate} mm/min · ` +
                `${((effective.finishingToolDiaMm * effective.finishingStepoverPercent) / 100).toFixed(2)} mm stepover · ` +
                `${result?.success ? result.finishingRasterLines : '—'} passes`
              }
              notes={[speedNote]}
            />
            <Advanced label="Advanced — override the derived feeds">
              <Field
                label="Flutes"
                hint="Cutting edges on the bit. Feed rate is chip-per-tooth x flutes x RPM, so the same feed is twice the load per edge on a two-flute cutter as on a four — this is what the app checks the feedrate against, and it is written into the file's header so the right bit gets fitted."
              >
                <NumberInput
                  step="1" min={1} max={8} integer
                  value={options.finishingFlutes}
                  onChange={(v) => set('finishingFlutes', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                className="lg:col-span-3"
                label="Helix"
                hint="Which way the flutes throw the chip. Upcut lifts it out of the cut and is what clears depth. Downcut presses it down: a clean top edge, but the chips pack into the bottom of a deep relief and burn. Compression is upcut low and downcut high, which in a relief means it never leaves its upcut section. This does not change the coordinates, but it does change what the app will let a feed, a plunge and a stepdown be without warning you."
              >
                <Segmented
                  value={options.finishingGeometry}
                  onChange={(v) => set('finishingGeometry', v)}
                  options={[['upcut', 'Up'], ['downcut', 'Down'], ['compression', 'Compr.'], ['straight', 'Straight']] as const}
                />
              </Field>
              <Field
                className="lg:col-span-2"
                label="Depth Strategy"
                hint="One Sweep is depth-first: each point is cut to its final height the first time the raster reaches it. It is the quicker one, and the right choice when a roughing pass has already taken the waste out or the relief is shallow. Layered repeats the raster at lower and lower limits so the bit never has to swallow the whole relief at once — slower, but it is what keeps a small cutter alive when the finishing pass is clearing the relief on its own. Auto picks One Sweep when roughing is on and Layered when it is off."
              >
                <Segmented
                  value={options.finishingDepthMode}
                  onChange={(v) => set('finishingDepthMode', v)}
                  options={[['auto', 'Auto'], ['single', 'One Sweep'], ['layered', 'Layered']] as const}
                />
              </Field>
              <Field
                label="Stepdown (mm)"
                hint="Most depth one layered sweep may take. 0 uses the bit diameter. Ignored when the depth strategy is One Sweep."
              >
                <NumberInput
                  step="0.5" min={0} max={20}
                  allowEmpty
                  placeholder={String(derived.finishingStepdownMm)}
                  value={overrides.finishingStepdownMm ?? null}
                  onChange={(v) => override('finishingStepdownMm', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Stepover (%)"
                hint="Spacing between passes, as a percentage of bit diameter. Lower is smoother and slower: 10% is a show surface, 40% leaves visible ridges you will have to sand."
              >
                <NumberInput
                  step="5" min={2} max={50}
                  allowEmpty
                  placeholder={String(derived.finishingStepoverPercent)}
                  value={overrides.finishingStepoverPercent ?? null}
                  onChange={(v) => override('finishingStepoverPercent', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Feedrate (mm/m)"
                hint="How fast the cutter travels through the finishing pass, in mm per minute."
              >
                <NumberInput
                  step="100" min={50} max={10000} integer
                  allowEmpty
                  placeholder={String(derived.finishingFeedrate)}
                  value={overrides.finishingFeedrate ?? null}
                  onChange={(v) => override('finishingFeedrate', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                hintAlign="end"
                label="Sweep Axis"
                hint="Which way the parallel passes run. Sweeping across a feature's long axis rather than along it usually leaves a better surface."
              >
                <Segmented
                  value={options.finishingDirection}
                  onChange={(v) => set('finishingDirection', v)}
                  options={[['x', 'X'], ['y', 'Y']] as const}
                />
              </Field>
              <Field
                className="lg:col-span-2"
                label="Plunge Rate (mm/m)"
                hint="How fast the cutter is driven straight down into the material at the start of a pass. Slower than the cutting feedrate, because the tip of an end mill cuts badly."
              >
                <NumberInput
                  step="50" min={10} max={2000} integer
                  allowEmpty
                  placeholder={String(derived.finishingPlungeRate)}
                  value={overrides.finishingPlungeRate ?? null}
                  onChange={(v) => override('finishingPlungeRate', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                label="Shank & Holder Clearance"
                hint="A bit is only slim for the length of its flutes — above that is a fatter shank, and above that the collet nut. With this on, the path is held clear of anything those would hit, so a pocket the bit cannot physically reach comes out with material left standing. Turn it off and only the cutting end is checked: the job will cut the pocket, by dragging the shank through the wall."
              >
                <Segmented
                  value={options.toolBodyClearance ? 'on' : 'off'}
                  onChange={(v) => set('toolBodyClearance', v === 'on')}
                  options={[['on', 'Keep Clear'], ['off', 'Flutes Only']] as const}
                />
              </Field>

              <Field
                label="Shank Ø (mm)"
                hint="Diameter of the finishing bit above its flutes. 0 assumes the usual: bits under 3.175 mm are ground on a 3.175 mm blank, anything bigger is its own diameter."
              >
                <NumberInput
                  step="0.1" min={0} max={30}
                  value={options.finishingShankDiaMm}
                  onChange={(v) => set('finishingShankDiaMm', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Flute Length (mm)"
                hint="How far up the finishing bit the cutting edges actually run — below this it cuts, above it only rubs. 0 assumes three diameters, which is about what catalogue bits carry."
              >
                <NumberInput
                  step="1" min={0} max={100}
                  value={options.finishingFluteLengthMm}
                  onChange={(v) => set('finishingFluteLengthMm', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Stickout (mm)"
                hint="Tip of the tool to the face of the collet nut. Together with the holder diameter it is what decides whether the nut clears a tall feature standing next to a deep cut. 0 leaves the holder unchecked."
              >
                <NumberInput
                  step="1" min={0} max={200}
                  value={options.toolStickoutMm}
                  onChange={(v) => set('toolStickoutMm', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Holder Ø (mm)"
                hint="Widest part of the collet nut or tool holder — about 19 mm for ER11, 28 mm for ER16. 0 leaves the holder unchecked."
              >
                <NumberInput
                  step="1" min={0} max={200}
                  value={options.holderDiaMm}
                  onChange={(v) => set('holderDiaMm', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                label="Lead-In Angle (°)"
                hint="How steeply the cutter descends into the material at the head of a pass. A bit cuts badly straight down — that is the move that snaps small ones — so it ramps in along the path instead, then backs up to clear what the ramp rode over. 0 goes back to plunging straight down."
              >
                <NumberInput
                  step="5" min={0} max={45}
                  value={options.leadInAngleDeg}
                  onChange={(v) => set('leadInAngleDeg', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                label="Safe Z (mm)"
                hint="Retract height above the stock's top face for moves between passes. It has to clear the clamps."
              >
                <NumberInput
                  step="1" min={1} max={100}
                  value={options.safeZ}
                  onChange={(v) => set('safeZ', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Spindle (RPM)"
                hint="The speed to set before you press start. On a router with a dial rather than a controlled spindle the S word in the file does nothing at all, so this is a number you turn by hand — which is why the file writes it out as a comment and the machine panel repeats it. It comes from the material's surface speed and the finishing bit's diameter; Suggest tooling sets it."
              >
                <NumberInput
                  step="1000" min={0} max={60000} integer
                  allowEmpty
                  placeholder={String(derived.spindleRpm)}
                  value={overrides.spindleRpm ?? null}
                  onChange={(v) => override('spindleRpm', v)}
                  className={inputClass}
                />
              </Field>
            </Advanced>
          </div>

          {/* Roughing */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Roughing Pass</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label="Waste Clearing"
                hint="A layered pass with a bigger flat mill that clears the bulk before the finishing raster. Skipping it means the finishing bit takes the full depth in one go, which snaps small cutters."
              >
                <Segmented
                  value={options.roughingEnabled ? 'on' : 'off'}
                  onChange={(v) => set('roughingEnabled', v === 'on')}
                  options={[['on', 'Rough First'], ['off', 'Finish Only']] as const}
                />
              </Field>

              <Field
                label="Flat End Mill Ø (mm)"
                hint="Diameter of the roughing mill. The roughing path is planned around a flat bottom — every layer is a flat floor at a fixed Z — so this pass wants a flat end mill and nothing else: a ball nose fitted here would leave the corner of every layer uncut and the finishing pass would find more material than it was told to expect. If the diameter differs from the finishing bit the job pauses for a tool change between the two passes."
              >
                <NumberInput
                  step="0.1" min={0.1} max={30}
                  disabled={!options.roughingEnabled}
                  value={options.roughingToolDiaMm}
                  onChange={(v) => set('roughingToolDiaMm', v)}
                  className={inputClass}
                />
              </Field>





            </div>

            <DerivedRecipe
              title={`Derived for ${materialLabel}`}
              line={
                effective.roughingEnabled
                  ? `${effective.spindleRpm.toLocaleString()} RPM · ${effective.roughingFeedrate} mm/min · ` +
                    `${effective.roughingStepdownMm} mm/pass · ${effective.roughingAllowanceMm} mm left on`
                  : 'Skipped — the finishing bit clears the whole relief on its own'
              }
            />
            <Advanced label="Advanced — override the derived feeds">
              <Field
                label="Flutes"
                hint="Cutting edges on the roughing mill, used to check the feedrate makes a chip rather than a rub, and written into the file so the right bit is fitted."
              >
                <NumberInput
                  step="1" min={1} max={8} integer
                  disabled={!options.roughingEnabled}
                  value={options.roughingFlutes}
                  onChange={(v) => set('roughingFlutes', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                className="lg:col-span-3"
                label="Helix"
                hint="Roughing wants an upcut: the whole job of this pass is to get waste out of a pocket, and upcut is the only geometry that lifts it. A downcut here packs its own chips into the floor it is trying to clear."
              >
                <Segmented
                  value={options.roughingGeometry}
                  onChange={(v) => set('roughingGeometry', v)}
                  options={[['upcut', 'Up'], ['downcut', 'Down'], ['compression', 'Compr.'], ['straight', 'Straight']] as const}
                />
              </Field>
              <Field
                label="Stepdown (mm)"
                hint="How much depth each roughing layer takes. Deeper is quicker but loads the cutter harder; 1–2 mm suits most wood on a hobby router."
              >
                <NumberInput
                  step="0.5" min={0.1} max={20}
                  disabled={!options.roughingEnabled}
                  allowEmpty
                  placeholder={String(derived.roughingStepdownMm)}
                  value={overrides.roughingStepdownMm ?? null}
                  onChange={(v) => override('roughingStepdownMm', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                label="Leave On (mm)"
                hint="Material the roughing pass leaves above the finished surface for the finishing bit to take off. Too little and the roughing marks show through."
              >
                <NumberInput
                  step="0.1" min={0} max={5}
                  disabled={!options.roughingEnabled}
                  allowEmpty
                  placeholder={String(derived.roughingAllowanceMm)}
                  value={overrides.roughingAllowanceMm ?? null}
                  onChange={(v) => override('roughingAllowanceMm', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                hintAlign="end"
                label="Feedrate (mm/m)"
                hint="Cutting feedrate for the roughing layers, in mm per minute."
              >
                <NumberInput
                  step="100" min={50} max={10000} integer
                  disabled={!options.roughingEnabled}
                  allowEmpty
                  placeholder={String(derived.roughingFeedrate)}
                  value={overrides.roughingFeedrate ?? null}
                  onChange={(v) => override('roughingFeedrate', v)}
                  className={inputClass}
                />
              </Field>
              <Field
                className="lg:col-span-2"
                label="Plunge Rate (mm/m)"
                hint="How fast the roughing bit is driven down into the stock at the start of each cut."
              >
                <NumberInput
                  step="50" min={10} max={2000} integer
                  disabled={!options.roughingEnabled}
                  allowEmpty
                  placeholder={String(derived.roughingPlungeRate)}
                  value={overrides.roughingPlungeRate ?? null}
                  onChange={(v) => override('roughingPlungeRate', v)}
                  className={inputClass}
                />
              </Field>
            </Advanced>
          </div>

          {/* Bed levelling */}
          <div className={sectionClass}>
            <h3 className={sectionTitleClass}>Bed Levelling</h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
              <Field
                className="lg:col-span-2"
                label="Probe Grid"
                hint="How many points across and up the bed are touched off with G38.2. A finishing pass can be a couple of tenths deep at its shallowest, so half a millimetre of bed tilt is the difference between a surface and a scratch."
              >
                <div className="flex items-center space-x-1.5">
                  <NumberInput
                    step="1" min={2} max={15} integer
                    value={probeCols}
                    onChange={setProbeCols}
                    className={`${inputClass} px-2`}
                    aria-label="Probe points across X"
                  />
                  <span className="text-xs font-medium text-slate-400">&times;</span>
                  <NumberInput
                    step="1" min={2} max={15} integer
                    value={probeRows}
                    onChange={setProbeRows}
                    className={`${inputClass} px-2`}
                    aria-label="Probe points across Y"
                  />
                </div>
              </Field>

              <Field
                className="lg:col-span-2"
                label="Measure Bed"
                hint="Runs the probe over the carve's own footprint. The machine must be connected and zeroed, with a probe lead on the cutter."
              >
                <button
                  type="button"
                  onClick={handleProbeBed}
                  disabled={isProbing || !result?.success}
                  className="w-full py-1.5 px-3 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600
                             disabled:opacity-40 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg
                             flex items-center justify-center space-x-1.5 cursor-pointer transition-colors"
                >
                  <RefreshCw className={`w-3.5 h-3.5 text-blue-500 ${isProbing ? 'animate-spin' : ''}`} />
                  <span>
                    {isProbing
                      ? `Probing ${probeProgress.current}/${probeProgress.total}…`
                      : `Probe ${probeCols}×${probeRows} Grid`}
                  </span>
                </button>
              </Field>

              <Field
                className="lg:col-span-2"
                hintAlign="end"
                label="Depth Compensation"
                hint="Rides the measured surface so the carve keeps a constant depth over a bed or a board that is not flat. Needs a probed grid."
              >
                <Segmented
                  value={options.applyMeshLeveling && probedGrid ? 'on' : 'off'}
                  onChange={(v) => set('applyMeshLeveling', v === 'on')}
                  options={[['off', 'Off'], ['on', probedGrid ? 'Follow Bed' : 'Needs Probe']] as const}
                />
              </Field>
            </div>

            {stats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
                <div>Min Z: {stats.minZ.toFixed(3)} mm</div>
                <div>Max Z: {stats.maxZ.toFixed(3)} mm</div>
                <div>Total warp: {stats.spanZ.toFixed(3)} mm</div>
                <div>Average: {stats.avgZ.toFixed(3)} mm</div>
              </div>
            )}
          </div>

          {result && !result.success && (
            <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/40 flex items-start space-x-2 text-xs text-red-700 dark:text-red-300">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span className="leading-relaxed">{result.error}</span>
            </div>
          )}

          {result && result.warnings.length > 0 && (
            <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-1.5">
              {result.warnings.map((w, i) => (
                <div key={i} className="flex items-start space-x-2 text-xs text-amber-800 dark:text-amber-300">
                  <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
                  <span className="leading-relaxed">{w}</span>
                </div>
              ))}
            </div>
          )}

          {/* Machine paused mid-job — the tool change between passes lands here */}
          <JobPauseBanner machineState={machineState} resumeLabel="Resume Carve (Cycle Start)" />

          {/* Toolpath preview */}
          {result?.success && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
                <span className="flex items-center space-x-1.5 font-medium">
                  <Layers className="w-4 h-4 text-blue-500" />
                  <span>{result.finishingRasterLines} finishing passes</span>
                </span>
                <span>{result.roughingPassCount} roughing layers</span>
                <span className="font-mono bg-slate-200 dark:bg-slate-800 px-2 py-0.5 rounded text-[10px] uppercase font-bold text-blue-600 dark:text-blue-400">
                  Est. Time: {formatDuration(result.estimatedTimeSeconds)}
                  ({(result.totalCutDistanceMm / 1000).toFixed(1)} m cut)
                </span>
                {result.toolChange && (
                  <span className="text-amber-600 dark:text-amber-400 font-medium">
                    Pauses for a tool change between passes
                  </span>
                )}
                {pending && <span className="text-slate-400 italic">recalculating…</span>}
              </div>

              <ToolpathView result={result} options={settled} machineState={machineState} />

              <div className="flex items-center space-x-4 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
                  <span>Roughing</span>
                </span>
                <span className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" />
                  <span>Finishing</span>
                </span>
                <span className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-slate-600 inline-block" />
                  <span>Rapids</span>
                </span>
                <span>Right-drag orbits, middle-drag pans, scroll zooms — the same as the scene view. The wireframe box is the stock.</span>
              </div>
            </div>
          )}

          {/* Machine */}
          <div className="p-4 rounded-xl bg-slate-900 border border-slate-800 text-white space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <Cpu className="w-5 h-5 text-blue-400" />
                <div>
                  <h3 className="text-sm font-bold flex items-center space-x-2">
                    <span>WebSerial USB Machine Interface</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase ${
                      machineState.status === 'RUNNING' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' :
                      machineState.status.startsWith('PAUSED') ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 animate-pulse' :
                      machineState.connected ? 'bg-blue-500/20 text-blue-400 border border-blue-500/40' : 'bg-slate-800 text-slate-400'
                    }`}>
                      {machineState.status}
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400">
                    {machineState.connected
                      ? `Connected via USB serial (${machineState.portName})`
                      : webSerialManager.isSupported()
                        ? 'Connect your CNC router (GRBL/Marlin/FluidNC) to carve straight from the browser'
                        : 'WebSerial is not available in this browser — use Chrome, Edge, or Opera to carve'}
                  </p>
                </div>
              </div>

              <button
                onClick={handleConnectUsb}
                disabled={!webSerialManager.isSupported()}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all flex items-center space-x-1.5 cursor-pointer disabled:opacity-40 ${
                  machineState.connected ? 'bg-slate-800 hover:bg-slate-700 text-slate-300' : 'bg-blue-500 hover:bg-blue-600 text-slate-950'
                }`}
              >
                <Cpu className="w-3.5 h-3.5" />
                <span>{machineState.connected ? 'Disconnect USB' : 'Connect USB Machine'}</span>
              </button>
            </div>

            {machineState.connected && (
              <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 pt-2 border-t border-slate-800">
                <div className="flex items-center space-x-2 bg-slate-950 p-2 rounded-lg border border-slate-800 text-xs font-mono">
                  <span className="text-slate-500">MPos:</span>
                  <span>X:{machineState.mpos.x.toFixed(1)} Y:{machineState.mpos.y.toFixed(1)} Z:{machineState.mpos.z.toFixed(1)}</span>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={() => webSerialManager.homeMachine()}
                    className="flex-1 py-1.5 px-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1"
                  >
                    <Home className="w-3.5 h-3.5 text-blue-400" />
                    <span>Home ($H)</span>
                  </button>
                </div>

                <div className="flex items-center space-x-2">
                  <button
                    onClick={handleFrameTrace}
                    disabled={!result?.success}
                    title="Trace the carve's outline so you can check it lands on the stock"
                    className="flex-1 py-1.5 px-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1"
                  >
                    <RefreshCw className="w-3.5 h-3.5 text-blue-400" />
                    <span>Frame Job</span>
                  </button>
                  <button
                    onClick={() => webSerialManager.unlockAlarm()}
                    className="py-1.5 px-2 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold rounded-lg flex items-center justify-center space-x-1"
                  >
                    <ShieldAlert className="w-3.5 h-3.5 text-red-400" />
                    <span>Unlock ($X)</span>
                  </button>
                </div>
              </div>
              <JobPreflight
                machineState={machineState}
                tool={preflight.firstTool}
                secondTool={preflight.secondTool}
                rpm={settled.spindleRpm}
                material={preflight.material}
                origin="the near-left corner of the stock's top face"
                caveat={preflight.caveat}
              />
              <JobOverrides machineState={machineState} />
              <MachineWorkOriginPanel machineState={machineState} onOpenDocs={onOpenDocs} />
              </>
            )}

            {machineState.status === 'RUNNING' && (
              <div className="space-y-1 pt-2 border-t border-slate-800">
                <div className="flex justify-between text-[11px] font-mono text-slate-400">
                  <span>Line {machineState.currentLine} of {machineState.totalLines}</span>
                  <span>{machineState.progressPercent}%</span>
                </div>
                <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 transition-all"
                    style={{ width: `${machineState.progressPercent}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 px-4 sm:px-6 py-3 sm:py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50">
          <div className="hidden lg:block text-xs text-slate-500 dark:text-slate-400">
            Zero the machine on the near-left corner of the stock's top face, then carve.
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3 sm:ml-auto">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 rounded-lg transition-colors"
            >
              Close
            </button>

            {machineState.connected ? (
              <JobTransport
                machineState={machineState}
                canStart={canCarve}
                onStart={handleStartCarve}
                startLabel="Start Carving"
              />
            ) : (
              <button
                onClick={handleConnectUsb}
                disabled={!webSerialManager.isSupported()}
                className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
              >
                <Cpu className="w-4 h-4" />
                <span>Connect CNC to Carve</span>
              </button>
            )}
          </div>
        </div>

      </div>
    </div>
  );
};
