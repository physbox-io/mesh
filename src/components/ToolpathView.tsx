import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Play, Pause } from 'lucide-react';
import type { ToolpathSegment } from '../utils/reliefCarveExporter';
import type { MachineState } from '../utils/webSerialManager';
import { clockMoves, formatDuration, type ClockedMove, type TimedMove } from '../utils/timeEstimate';
import type { MotionProfile } from '../utils/motionProfile';

/**
 * What the viewport needs to know about a job. A relief carve's result and a
 * solid machining side both satisfy it.
 */
export interface ToolpathPreviewResult {
  segments: ToolpathSegment[];
  estimatedTimeSeconds: number;
  /** Footprint the job occupies on the stock, in machine mm. */
  carveBounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** The settings the viewport draws or times the job with. */
export interface ToolpathPreviewOptions {
  stockWidthMm: number;
  stockDepthMm: number;
  stockThicknessMm: number;
  finishingToolDiaMm: number;
  roughingFeedrate: number;
  finishingFeedrate: number;
  finishingPlungeRate: number;
  safeZ: number;
  motionProfile: MotionProfile;
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
  result: ToolpathPreviewResult,
  options: ToolpathPreviewOptions
): { moves: ClockedMove[]; seconds: number } {
  const raw: TimedMove[] = [];
  let at: { x: number; y: number; z: number } | null = null;

  for (const seg of result.segments) {
    if (seg.points.length === 0) continue;
    const feed = seg.type === 'roughing' ? options.roughingFeedrate : options.finishingFeedrate;
    const head = seg.points[0];

    if (at) {
      /*
       * Up, across, down — the retract the exporter writes between passes.
       *
       * At the height the exporter actually chose, not at `safeZ`. It clears
       * only what stands between the two passes now, which on a raster of
       * closely spaced lines is a fraction of the full retract — and an
       * estimate still modelling the old round trip would quote a job hours
       * longer than the one about to run.
       */
      const hop = seg.traverseZ ?? options.safeZ;
      // Never below where the tool already is: the exporter does not descend
      // to traverse, it only lifts if it has to.
      const over = Math.max(hop, at.z);
      raw.push({ x1: at.x, y1: at.y, z1: at.z, x2: at.x, y2: at.y, z2: over, feed: RAPID_MM_MIN, rapid: true });
      raw.push({ x1: at.x, y1: at.y, z1: over, x2: head.x, y2: head.y, z2: over, feed: RAPID_MM_MIN, rapid: true });
      raw.push({ x1: head.x, y1: head.y, z1: over, x2: head.x, y2: head.y, z2: head.z, feed: Math.max(1, options.finishingPlungeRate), rapid: false });
    }

    for (let i = 0; i + 1 < seg.points.length; i++) {
      const a = seg.points[i];
      const b = seg.points[i + 1];
      raw.push({ x1: a.x, y1: a.y, z1: a.z, x2: b.x, y2: b.y, z2: b.z, feed, rapid: false });
    }
    at = seg.points[seg.points.length - 1];
  }

  // The machine's own dynamics, so the playhead crawls through the dense parts
  // and flies through the open ones in the same places the tool will. The total
  // is rescaled below either way, but the *shape* of the clock is only right if
  // the acceleration and corner tolerance are the ones the controller reported.
  const clocked = clockMoves(raw, { profile: options.motionProfile });
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

/**
 * A depth ramp: where the tool is on the surface, and where it is at the floor.
 *
 * Sampled from viridis, which is perceptually uniform — equal steps in depth
 * look like equal steps in colour — and keeps its ordering when read by a
 * colourblind eye or printed in grey. That matters more here than prettiness:
 * the whole reason to colour a relief by depth is to be able to see, at a
 * glance, that the tool goes deepest where the model is highest, and a ramp
 * with a bright band in the middle of it invents a feature that is not there.
 */
const DEPTH_RAMP: [number, number, number][] = [
  [0.267, 0.005, 0.329],
  [0.283, 0.141, 0.458],
  [0.254, 0.265, 0.530],
  [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558],
  [0.128, 0.567, 0.551],
  [0.135, 0.659, 0.518],
  [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318],
  [0.741, 0.873, 0.150],
  [0.993, 0.906, 0.144],
];

/**
 * Colour for a cut at height `z`, with the stock's top face at 0.
 *
 * `deepest` is taken from the path itself rather than from the carve depth
 * setting, so the ramp always spans what is actually on screen: a relief that
 * only uses half its allowance still gets the full range of colour, instead of
 * coming out uniformly pale against a scale nothing reaches the end of.
 */
function depthColour(z: number, deepest: number, out: THREE.Color): THREE.Color {
  const span = Math.abs(deepest);
  // Deep is the ramp's dark end, surface its bright one.
  const t = span > 1e-6 ? Math.min(1, Math.max(0, 1 - Math.abs(z) / span)) : 1;
  const pos = t * (DEPTH_RAMP.length - 1);
  const i = Math.min(DEPTH_RAMP.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = DEPTH_RAMP[i];
  const b = DEPTH_RAMP[i + 1];
  return out.setRGB(
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f
  );
}

/** Squared distance from a point to the segment a move sweeps. */
function distanceSqToMove(m: ClockedMove, x: number, y: number, z: number): number {
  const dx = m.x2 - m.x1;
  const dy = m.y2 - m.y1;
  const dz = m.z2 - m.z1;
  const lenSq = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (lenSq > 1e-12) {
    t = ((x - m.x1) * dx + (y - m.y1) * dy + (z - m.z1) * dz) / lenSq;
    t = Math.min(1, Math.max(0, t));
  }
  const px = m.x1 + dx * t - x;
  const py = m.y1 + dy * t - y;
  const pz = m.z1 + dz * t - z;
  return px * px + py * py + pz * pz;
}

/** How far off the path the machine may report before the search gives up and re-syncs, mm. */
const LIVE_SNAP_TOLERANCE_MM = 6;
/** How many moves ahead of the last match the forward search looks. */
const LIVE_SEARCH_WINDOW = 4000;

/**
 * Where on the program the machine actually is, from the position it reports.
 *
 * The obvious source — GRBL's line count, scaled onto the clock — is wrong
 * twice over, and both errors run the same way. Lines are counted as they are
 * *sent*, and the controller holds a planner buffer of them, so the count runs
 * ahead of the cutter by as much as the buffer is deep. And a line is not a
 * unit of time: a rapid across the stock is one line and a fraction of a
 * second, a raster pass is one line and several seconds, so mapping "62% of
 * the lines" onto "62% of the clock" skews wherever the two kinds are not
 * evenly mixed — which on a relief is everywhere, because roughing and
 * finishing have quite different mixes.
 *
 * The reported position has neither problem: it is where the tool is. So the
 * playhead is found by projecting that position onto the path and taking the
 * clock of the point it lands on.
 *
 * The search runs forward from the last match rather than over the whole path,
 * because a raster crosses its own neighbours constantly and the globally
 * nearest point to the spindle is very often on the pass beside the one being
 * cut, a stepover away. Going forward-only also stops the bright "already cut"
 * region flickering backwards. When nothing within the window is close enough
 * — after a jog, a resume, or a lost connection — it falls back to a search of
 * the whole path, which is the one case where being wrong about which pass is
 * worse than being slow.
 */
function projectOntoPath(
  moves: ClockedMove[],
  x: number,
  y: number,
  z: number,
  from: number
): { index: number; clock: number } | null {
  if (moves.length === 0) return null;

  const scan = (lo: number, hi: number) => {
    let bestI = -1;
    let bestD = Infinity;
    for (let i = lo; i < hi; i++) {
      const d = distanceSqToMove(moves[i], x, y, z);
      if (d < bestD) {
        bestD = d;
        bestI = i;
      }
    }
    return { bestI, bestD };
  };

  const start = Math.min(Math.max(0, from), moves.length - 1);
  const near = scan(start, Math.min(moves.length, start + LIVE_SEARCH_WINDOW));
  let bestI = near.bestI;

  if (near.bestD > LIVE_SNAP_TOLERANCE_MM * LIVE_SNAP_TOLERANCE_MM) {
    const global = scan(0, moves.length);
    if (global.bestI >= 0 && global.bestD < near.bestD) bestI = global.bestI;
  }
  if (bestI < 0) return null;

  // Interpolate the clock across the move, so the readout advances smoothly
  // along a long pass instead of stepping once per move.
  const m = moves[bestI];
  const dx = m.x2 - m.x1;
  const dy = m.y2 - m.y1;
  const dz = m.z2 - m.z1;
  const lenSq = dx * dx + dy * dy + dz * dz;
  let f = 0;
  if (lenSq > 1e-12) {
    f = ((x - m.x1) * dx + (y - m.y1) * dy + (z - m.z1) * dz) / lenSq;
    f = Math.min(1, Math.max(0, f));
  }
  return { index: bestI, clock: m.t0 + (m.t1 - m.t0) * f };
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
export function ToolpathView({
  result,
  options,
  machineState,
}: {
  result: ToolpathPreviewResult;
  options: ToolpathPreviewOptions;
  machineState: MachineState;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  /** Set by the geometry effect, read by the frame loop. */
  const cutRef = useRef<THREE.LineSegments | null>(null);
  const toolRef = useRef<THREE.Object3D | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  /** Set once the operator orbits, pans or zooms; stops the auto-fit taking over. */
  const userMovedRef = useRef(false);
  /** Lets the mount effect's `resize` reach the fit without depending on it. */
  const fitRef = useRef<(() => void) | null>(null);

  const path = useMemo(() => buildPreviewPath(result, options), [result, options]);

  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  /**
   * What the toolpath's colour means.
   *
   * Depth by default. A relief is a surface, and the question being asked of
   * this viewport is almost always "did the shape come out the way I meant it
   * to" — which the operation colours cannot answer at all, because the whole
   * finishing raster is one colour whatever it is cutting.
   */
  const [colourMode, setColourMode] = useState<'depth' | 'operation'>('depth');

  /**
   * The deepest cutting move in the path — the far end of the depth ramp.
   *
   * Rapids are left out: they run at the retract height, above the stock, and
   * including them would stretch the scale over air and wash out the range the
   * carve actually occupies.
   */
  const deepest = useMemo(() => {
    let z = 0;
    for (const m of path.moves) {
      if (m.rapid) continue;
      if (m.z1 < z) z = m.z1;
      if (m.z2 < z) z = m.z2;
    }
    return z;
  }, [path]);
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
    // A starting direction only. The distance is set by `fitView` once there is
    // geometry to frame — this pose on its own suits a 150 mm stock and nothing
    // else, which is what "the preview is not zoomed to fit" amounted to.
    camera.position.set(160, -200, 190);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    /*
     * The canvas needs a CSS size of its own, not just a backing-store size.
     *
     * `setSize(w, h, false)` below sets `canvas.width/height` — the drawing
     * buffer, which is `w * devicePixelRatio` — and deliberately leaves
     * `style.width/height` alone. Nothing else here sizes it, and a canvas with
     * no CSS size lays out at its intrinsic pixel size, so on a HiDPI screen it
     * rendered at twice its container, anchored top-left inside an
     * `overflow-hidden` parent. What you saw was the upper-left quadrant of a
     * correctly centred render: the toolpath looked zoomed in and shoved off
     * centre, and the cutter marker that follows a running job was usually off
     * the visible frame entirely.
     */
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
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
    controlsRef.current = controls;

    const group = new THREE.Group();
    contentRef.current = group;
    scene.add(group);

    // Any deliberate orbit, pan or zoom means the framing is the operator's
    // now, and re-fitting under them would be the viewport snatching the view
    // back every time a setting changed.
    const onUserMove = () => { userMovedRef.current = true; };
    controls.addEventListener('start', onUserMove);

    const resize = () => {
      const w = mount.clientWidth || 600;
      const h = mount.clientHeight || 360;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // A narrower viewport needs the camera further back for the same content,
      // so the fit is aspect-dependent and has to be redone on a resize.
      if (!userMovedRef.current) fitRef.current?.();
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
      controls.removeEventListener('start', onUserMove);
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
      cameraRef.current = null;
      controlsRef.current = null;
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
    const scratch = new THREE.Color();

    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      positions.set([m.x1, m.y1, m.z1, m.x2, m.y2, m.z2], i * 6);

      if (m.rapid) {
        // Travel stays grey in both modes. It is the one thing on screen that
        // is not cutting, and colouring it by the height it happens to fly at
        // would put it at the bright end of the depth ramp — the loudest
        // colour on the screen given to the moves that remove no material.
        colours.set([TRAVEL.r, TRAVEL.g, TRAVEL.b, TRAVEL.r, TRAVEL.g, TRAVEL.b], i * 6);
        continue;
      }

      if (colourMode === 'depth') {
        // Per end, not per move: a plunge or a ramp spans a range of depths,
        // and giving it one flat colour is exactly the moment the relief stops
        // reading as a surface.
        const a = depthColour(m.z1, deepest, scratch).clone();
        const b = depthColour(m.z2, deepest, scratch);
        colours.set([a.r, a.g, a.b, b.r, b.g, b.b], i * 6);
      } else {
        // The roughing pass and the finishing raster are told apart by feed.
        const c = m.feed === options.roughingFeedrate ? ROUGH : FINISH;
        colours.set([c.r, c.g, c.b, c.r, c.g, c.b], i * 6);
      }
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
    // ConeGeometry has its apex at +Y. Rotating -90° about X sends +Y to -Z, so
    // the point faces the work; +90° sends it to +Z, which drew the bit nose-up.
    tool.rotation.x = -Math.PI / 2;
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
    colourMode,
    deepest,
  ]);

  /**
   * Frames the stock and the toolpath, whatever size they are.
   *
   * The camera used to be posed once, by hand, in the mount effect: 45° of
   * vertical FOV at ~320 mm out, which frames about 265 mm. That happens to
   * suit the 150 mm default stock and is wrong for everything else — a
   * 50 x 40 mm carve was a speck in the middle of the viewport, and a 400 mm
   * one ran off the edges. Nothing recomputed it when the stock changed size,
   * and `controls.target` was never set at all, so the orbit centre stayed at
   * the world origin while the content sat below it.
   *
   * Both axes are checked. Fitting the vertical FOV alone is not enough in a
   * wide viewport, where the horizontal angle is the wider one and a
   * non-square stock overflows sideways while comfortably fitting top to
   * bottom; the distance taken is whichever of the two demands more room.
   */
  const fitView = useCallback(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    if (!camera || !controls) return;

    const w = options.stockWidthMm;
    const d = options.stockDepthMm;
    const t = options.stockThicknessMm;

    // The group is slid back by half the stock, so work coordinates land in the
    // viewport with the block straddling the origin in X and Y.
    const box = new THREE.Box3(
      new THREE.Vector3(-w / 2, -d / 2, -t),
      new THREE.Vector3(w / 2, d / 2, 0)
    );
    // Union with the cut itself, so a toolpath that reaches past the stock — or
    // deeper than it — is still framed rather than cropped.
    const cb = result.carveBounds;
    if (cb) {
      box.expandByPoint(new THREE.Vector3(cb.minX - w / 2, cb.minY - d / 2, deepest));
      box.expandByPoint(new THREE.Vector3(cb.maxX - w / 2, cb.maxY - d / 2, 0));
    }
    if (box.isEmpty()) return;

    const centre = box.getCenter(new THREE.Vector3());
    const radius = Math.max(1, box.getBoundingSphere(new THREE.Sphere()).radius);

    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * Math.max(0.0001, camera.aspect));
    const dist = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2)) * 1.15;

    // Keep whatever direction the camera is looking from, so a re-fit after a
    // settings change does not also spin the view back to the default corner.
    const dir = camera.position.clone().sub(controls.target);
    if (dir.lengthSq() < 1e-6) dir.set(160, -200, 190);
    dir.normalize();

    controls.target.copy(centre);
    camera.position.copy(centre).addScaledVector(dir, dist);
    camera.near = Math.max(0.1, dist / 1000);
    camera.far = dist * 10;
    camera.updateProjectionMatrix();
    controls.update();
  }, [options.stockWidthMm, options.stockDepthMm, options.stockThicknessMm, result.carveBounds, deepest]);

  useEffect(() => { fitRef.current = fitView; }, [fitView]);

  // A new path or a new stock size is a new thing to frame, and the operator's
  // own framing was for the old one — so the manual-override flag is cleared
  // and the view re-fitted.
  useEffect(() => {
    userMovedRef.current = false;
    fitView();
  }, [fitView, path]);

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
      // The apex sits half the cone's height below the mesh origin, so lift the
      // mesh by that much to put the tip on the path.
      tool.position.z += Math.max(5, options.finishingToolDiaMm * 3) / 2;
    }
  }, [options.finishingToolDiaMm]);

  useEffect(() => {
    applyClock(clock);
  }, [clock, applyClock, path]);

  // Named individually so the effect below depends on the three numbers it
  // actually reads, rather than on a `wpos` object rebuilt on every status poll.
  const { x: wposX, y: wposY, z: wposZ } = machineState.wpos;

  /**
   * Where the forward search starts. Reset when the job stops, so the next run
   * does not begin hunting from the end of the last one.
   */
  const liveIndexRef = useRef(0);
  useEffect(() => {
    if (!live) liveIndexRef.current = 0;
  }, [live]);

  // Follow the machine by where it says the tool is, not by how many lines have
  // been sent to it. See `projectOntoPath` for why the line count cannot do
  // this job.
  useEffect(() => {
    if (!live) return;
    const moves = pathRef.current.moves;
    if (moves.length === 0) return;

    const hit = projectOntoPath(moves, wposX, wposY, wposZ, liveIndexRef.current);
    if (!hit) return;

    liveIndexRef.current = hit.index;
    setClock(hit.clock);
  }, [live, wposX, wposY, wposZ]);

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
      <div className="relative w-full h-80 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden">
        <div className="absolute inset-0" ref={mountRef} />

        {/* What the colours mean, over the viewport rather than beside it —
            a scale the eye has to leave the picture to read is one nobody
            reads. */}
        <div className="absolute left-2 bottom-2 flex items-end gap-3 pointer-events-none">
          {colourMode === 'depth' ? (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-slate-900/80 border border-slate-700">
              <span className="text-[9px] font-mono text-slate-400">0</span>
              <div
                className="h-1.5 w-24 rounded-full"
                style={{
                  background: `linear-gradient(to left, ${DEPTH_RAMP.map(
                    ([r, g, b]) => `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
                  ).join(',')})`,
                }}
              />
              <span className="text-[9px] font-mono text-slate-400">
                {deepest.toFixed(1)} mm
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-slate-900/80 border border-slate-700">
              <span className="flex items-center gap-1 text-[9px] font-mono text-slate-400">
                <span className="w-2.5 h-1.5 rounded-sm bg-amber-500" /> Rough
              </span>
              <span className="flex items-center gap-1 text-[9px] font-mono text-slate-400">
                <span className="w-2.5 h-1.5 rounded-sm bg-blue-500" /> Finish
              </span>
            </div>
          )}
          <span className="flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-900/80 border border-slate-700 text-[9px] font-mono text-slate-400">
            <span className="w-2.5 h-1.5 rounded-sm bg-slate-600" /> Travel
          </span>
        </div>

        <div className="absolute right-2 top-2 flex items-center gap-0.5 p-0.5 rounded-lg bg-slate-900/80 border border-slate-700">
          {(
            [
              ['depth', 'Depth'],
              ['operation', 'Pass'],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              onClick={() => setColourMode(mode)}
              title={
                mode === 'depth'
                  ? 'Colour the toolpath by how deep each move cuts'
                  : 'Colour the toolpath by which pass each move belongs to'
              }
              className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                colourMode === mode
                  ? 'bg-blue-500 text-slate-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

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
