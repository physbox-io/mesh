import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Play, Pause } from 'lucide-react';
import type { MachineState } from '../utils/webSerialManager';
import { formatDuration } from '../utils/timeEstimate';
import {
  buildPreviewPath,
  type ToolpathPreviewOptions,
  type ToolpathPreviewResult,
} from '../utils/toolpathPreviewPath';
import { moveIndexAt, trackPlayhead, PLAYHEAD_START, type PlayheadState } from '../utils/livePlayhead';
import {
  DEPTH_RAMP_GRADIENT,
  computeDeepestCutZ,
  fillToolpathColours,
  fillToolpathPositions,
} from '../utils/toolpathBuffers';

/** How long a full simulated run takes on screen, before the speed multiplier. */
const PLAYBACK_SECONDS = 45;
/** Throttle React HUD readout updates during dry-run playback (3D canvas updates at full 60fps). */
const HUD_CLOCK_SYNC_MS = 80;

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
  const pathGeoRef = useRef<THREE.BufferGeometry | null>(null);
  const toolRef = useRef<THREE.Object3D | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  /** Demand-render trigger: wakes the single RAF loop only when something changed. */
  const requestRenderRef = useRef<() => void>(() => {});
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
  const colourModeRef = useRef(colourMode);
  useEffect(() => { colourModeRef.current = colourMode; }, [colourMode]);

  /**
   * The deepest cutting move in the path — the far end of the depth ramp.
   *
   * Rapids are left out: they run at the retract height, above the stock, and
   * including them would stretch the scale over air and wash out the range the
   * carve actually occupies.
   */
  const deepest = useMemo(() => computeDeepestCutZ(path.moves), [path]);
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

    // Render on demand: only schedule/draw when geometry, playhead, resize,
    // or OrbitControls damping moves the camera — zero idle GPU load when paused.
    let raf = 0;
    let dirty = true;
    const tick = () => {
      raf = 0;
      const moved = controls.update();
      if (dirty || moved) {
        dirty = false;
        renderer.render(scene, camera);
      }
      if (moved) {
        raf = requestAnimationFrame(tick);
      }
    };
    const scheduleRender = () => {
      dirty = true;
      if (!raf) raf = requestAnimationFrame(tick);
    };
    requestRenderRef.current = scheduleRender;

    // Any deliberate orbit, pan or zoom means the framing is the operator's
    // now, and re-fitting under them would be the viewport snatching the view
    // back every time a setting changed.
    const onUserMove = () => { userMovedRef.current = true; scheduleRender(); };
    controls.addEventListener('start', onUserMove);
    controls.addEventListener('change', scheduleRender);

    const resize = () => {
      const w = mount.clientWidth || 600;
      const h = mount.clientHeight || 360;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      // A narrower viewport needs the camera further back for the same content,
      // so the fit is aspect-dependent and has to be redone on a resize.
      if (!userMovedRef.current) fitRef.current?.();
      scheduleRender();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(mount);
    scheduleRender();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      requestRenderRef.current = () => {};
      observer.disconnect();
      controls.removeEventListener('start', onUserMove);
      controls.removeEventListener('change', scheduleRender);
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
      pathGeoRef.current = null;
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
    const positions = fillToolpathPositions(moves);
    const colours = fillToolpathColours(moves, colourModeRef.current, deepest);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
    pathGeoRef.current = geo;
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
    requestRenderRef.current();

    return () => {
      group.clear();
      cutRef.current = null;
      pathGeoRef.current = null;
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
    deepest,
  ]);

  // Refill vertex colours in place when toggling Depth / Pass without tearing
  // down or rebuilding the stock, grid, tool, or position buffer.
  useEffect(() => {
    const geo = pathGeoRef.current;
    if (!geo) return;
    const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!colorAttr) return;
    fillToolpathColours(path.moves, colourMode, deepest, colorAttr.array as Float32Array);
    colorAttr.needsUpdate = true;
    requestRenderRef.current();
  }, [colourMode, path, deepest]);

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
    requestRenderRef.current();
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
    requestRenderRef.current();
  }, [options.finishingToolDiaMm]);

  useEffect(() => {
    applyClock(clock);
  }, [clock, applyClock, path]);

  // Named individually so the effect below depends on the three numbers it
  // actually reads, rather than on a `wpos` object rebuilt on every status poll.
  const { x: wposX, y: wposY, z: wposZ } = machineState.wpos;

  /**
   * The live playhead's own state: where the forward search starts, and how
   * many reports have asked to take it backwards. Reset when the job stops, so
   * the next run does not begin hunting from the end of the last one.
   */
  const liveTrackRef = useRef<PlayheadState>(PLAYHEAD_START);
  useEffect(() => {
    if (!live) liveTrackRef.current = PLAYHEAD_START;
  }, [live]);
  // A new path puts the clock back to zero (above), and the tracker with it.
  useEffect(() => {
    liveTrackRef.current = PLAYHEAD_START;
  }, [path]);

  /**
   * Where the job is by the streamer's own reckoning: the line the cutter is on,
   * as a share of the program's time (see `progressPercent`). Read by the
   * tracker only when following the tool forwards has lost it, and kept in a
   * ref so a progress update does not re-run the projection.
   */
  const anchorsRef = useRef<number[]>([]);
  useEffect(() => {
    anchorsRef.current = [(machineState.progressPercent / 100) * path.seconds];
  }, [path, machineState.progressPercent]);

  // Follow the machine by where it says the tool is, not by how many lines have
  // been sent to it. See `trackPlayhead` for why the line count cannot do this
  // job on its own, and why the nearest point on the whole path cannot either.
  useEffect(() => {
    if (!live) return;
    const moves = pathRef.current.moves;
    if (moves.length === 0) return;

    const prev = liveTrackRef.current;
    const next = trackPlayhead(moves, wposX, wposY, wposZ, prev, anchorsRef.current);
    liveTrackRef.current = next;
    if (next.clock !== prev.clock) setClock(next.clock);
  }, [live, wposX, wposY, wposZ]);

  // The dry run. Compressed onto a fixed screen duration, because the thing
  // being previewed can be a four-hour carve. Advances the 3D playhead directly
  // at 60fps while throttling React scrubber/readout state updates to ~12Hz.
  useEffect(() => {
    if (live || !playing || path.seconds <= 0) return;
    let raf = 0;
    let last = performance.now();
    let lastHudSync = last;
    const step = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const advance = (path.seconds / PLAYBACK_SECONDS) * speed * dt;
      const rawNext = clockRef.current + advance;
      const wrapped = rawNext >= path.seconds;
      const next = wrapped ? 0 : rawNext;
      clockRef.current = next;
      applyClock(next);
      if (wrapped || now - lastHudSync >= HUD_CLOCK_SYNC_MS) {
        lastHudSync = now;
        setClock(next);
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(raf);
      setClock(clockRef.current);
    };
  }, [live, playing, speed, path, applyClock]);

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
                style={{ background: DEPTH_RAMP_GRADIENT }}
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
