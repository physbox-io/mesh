import React, { useState, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  X, AlertCircle, Cpu, Play, Square, Home, ShieldAlert, RefreshCw,
  Info, ChevronRight, Layers, Mountain,
} from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import {
  generateReliefCarveGcode,
  DEFAULT_RELIEF_OPTIONS,
  recommendReliefTooling,
  type ReliefCarveOptions,
  type ReliefCarveResult,
} from '../utils/reliefCarveExporter';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { getGridStats, type ProbeGrid } from '../utils/meshLeveler';
import { NumberInput } from './NumberInput';
import { MachineWorkOriginPanel } from './MachineWorkOriginPanel';

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

function Advanced({ children }: { children: React.ReactNode }) {
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
        <span>Advanced</span>
      </button>
      {open && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">{children}</div>
      )}
    </div>
  );
}

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
          className={`flex-1 py-1 px-2 rounded-md text-xs font-medium transition-all whitespace-nowrap ${
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

/**
 * Interactive toolpath viewport.
 *
 * The renderer is built once for as long as the modal is open and only its
 * contents are swapped, because tearing a WebGL context down and standing a new
 * one up on every parameter change leaks canvases and GPU buffers.
 */
function ToolpathView({ result, options }: { result: ReliefCarveResult; options: ReliefCarveOptions }) {
  const mountRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);

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

    // Every pass of one kind goes into a single buffer: a few hundred separate
    // Line objects is a few hundred draw calls for the same picture.
    for (const [type, color] of [['roughing', 0xf59e0b], ['finishing', 0x3b82f6]] as const) {
      const positions: number[] = [];
      for (const seg of result.segments) {
        if (seg.type !== type) continue;
        for (let i = 0; i + 1 < seg.points.length; i++) {
          const a = seg.points[i];
          const b = seg.points[i + 1];
          positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
        }
      }
      if (positions.length === 0) continue;

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const mat = new THREE.LineBasicMaterial({ color, transparent: type === 'roughing', opacity: 0.55 });
      group.add(new THREE.LineSegments(geo, mat));
      dispose.push(geo, mat);
    }

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
      for (const d of dispose) d.dispose();
      grid.geometry.dispose();
      (grid.material as THREE.Material).dispose();
    };
  }, [result, options.stockWidthMm, options.stockDepthMm, options.stockThicknessMm]);

  return <div ref={mountRef} className="w-full h-80 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden" />;
}

export const ExportReliefCarveModal: React.FC<Props> = ({ isOpen, onClose, scene, onOpenDocs }) => {
  const [options, setOptions] = useState<ReliefCarveOptions>(DEFAULT_RELIEF_OPTIONS);
  const set = <K extends keyof ReliefCarveOptions>(key: K, value: ReliefCarveOptions[K]) =>
    setOptions((prev) => ({ ...prev, [key]: value }));

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

  const settled = useSettled(options, 250);
  const pending = settled !== options;

  const result = useMemo(() => {
    if (!isOpen) return null;
    return generateReliefCarveGcode(scene, {
      ...settled,
      meshLevelGrid: probedGrid,
      applyMeshLeveling: settled.applyMeshLeveling && probedGrid !== null,
    });
  }, [isOpen, scene, settled, probedGrid]);

  // Tooling is a function of the carve, not of the model, so it is derived from
  // what the carve actually came out as — the relief's real depth and the plan
  // it landed on — rather than shipped alongside the mesh.
  const applyRecommendedTooling = () => {
    if (!result?.success) return;
    setOptions((prev) => ({
      ...prev,
      ...recommendReliefTooling({
        reliefDepthMm: result.reliefDepthMm,
        planWidthMm: result.carveBounds.maxX - result.carveBounds.minX,
        planDepthMm: result.carveBounds.maxY - result.carveBounds.minY,
        spindleRpm: prev.spindleRpm,
      }),
    }));
  };

  if (!isOpen) return null;

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
                label="Height Scale"
                hint="Fill Depth stretches the model's height range onto the relief depth, so the carve is always exactly that deep — but Z is then unrelated to X and Y, and fitting the model onto smaller stock shrinks the plan while leaving the height alone, which multiplies the exaggeration by the same factor. Model Proportions puts Z on the plan scale instead, so the carve keeps the shape the model was authored with and the exaggeration is the number you set, not one that falls out of the stock size."
              >
                <Segmented
                  value={options.verticalScaleMode}
                  onChange={(v) => set('verticalScaleMode', v)}
                  options={[['fill', 'Fill Depth'], ['proportional', 'Model Proportions']] as const}
                />
              </Field>

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
                className="lg:col-span-2"
                label="Cutter Shape"
                hint="A ball nose leaves a smooth surface on curves, and the toolpath is lifted to keep its round tip on the surface. A flat mill has to clear the highest point under its whole diameter, so it rounds off fine detail."
              >
                <Segmented
                  value={options.finishingToolType}
                  onChange={(v) => set('finishingToolType', v)}
                  options={[['ball_nose', 'Ball-Nose'], ['flat', 'Flat End Mill']] as const}
                />
              </Field>

              <Field
                label="Bit Ø (mm)"
                hint="Diameter of the finishing cutter. It sets both the stepover and how much detail survives — nothing narrower than the bit can be cut."
              >
                <NumberInput
                  step="0.1" min={0.1} max={30}
                  value={options.finishingToolDiaMm}
                  onChange={(v) => set('finishingToolDiaMm', v)}
                  className={inputClass}
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
                  value={options.finishingStepdownMm}
                  onChange={(v) => set('finishingStepdownMm', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Stepover (%)"
                hint="Spacing between passes, as a percentage of bit diameter. Lower is smoother and slower: 10% is a show surface, 40% leaves visible ridges you will have to sand."
              >
                <NumberInput
                  step="5" min={2} max={50}
                  value={options.finishingStepoverPercent}
                  onChange={(v) => set('finishingStepoverPercent', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Feedrate (mm/m)"
                hint="How fast the cutter travels through the finishing pass, in mm per minute."
              >
                <NumberInput
                  step="100" min={50} max={10000} integer
                  value={options.finishingFeedrate}
                  onChange={(v) => set('finishingFeedrate', v)}
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
                  options={[['x', 'Along X'], ['y', 'Along Y']] as const}
                />
              </Field>
            </div>

            <Advanced>
              <Field
                className="lg:col-span-2"
                label="Plunge Rate (mm/m)"
                hint="How fast the cutter is driven straight down into the material at the start of a pass. Slower than the cutting feedrate, because the tip of an end mill cuts badly."
              >
                <NumberInput
                  step="50" min={10} max={2000} integer
                  value={options.finishingPlungeRate}
                  onChange={(v) => set('finishingPlungeRate', v)}
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
                hint="Spindle speed sent with M3. Ignored by machines whose spindle is switched by hand."
              >
                <NumberInput
                  step="1000" min={0} max={60000} integer
                  value={options.spindleRpm}
                  onChange={(v) => set('spindleRpm', v)}
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
                label="Bit Ø (mm)"
                hint="Diameter of the roughing mill. If it differs from the finishing bit the job pauses for a tool change between the two passes."
              >
                <NumberInput
                  step="0.1" min={0.1} max={30}
                  disabled={!options.roughingEnabled}
                  value={options.roughingToolDiaMm}
                  onChange={(v) => set('roughingToolDiaMm', v)}
                  className={inputClass}
                />
              </Field>

              <Field
                label="Stepdown (mm)"
                hint="How much depth each roughing layer takes. Deeper is quicker but loads the cutter harder; 1–2 mm suits most wood on a hobby router."
              >
                <NumberInput
                  step="0.5" min={0.1} max={20}
                  disabled={!options.roughingEnabled}
                  value={options.roughingStepdownMm}
                  onChange={(v) => set('roughingStepdownMm', v)}
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
                  value={options.roughingAllowanceMm}
                  onChange={(v) => set('roughingAllowanceMm', v)}
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
                  value={options.roughingFeedrate}
                  onChange={(v) => set('roughingFeedrate', v)}
                  className={inputClass}
                />
              </Field>
            </div>

            <Advanced>
              <Field
                className="lg:col-span-2"
                label="Plunge Rate (mm/m)"
                hint="How fast the roughing bit is driven down into the stock at the start of each cut."
              >
                <NumberInput
                  step="50" min={10} max={2000} integer
                  disabled={!options.roughingEnabled}
                  value={options.roughingPlungeRate}
                  onChange={(v) => set('roughingPlungeRate', v)}
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
          {machineState.status.startsWith('PAUSED') && (
            <div className="p-4 rounded-xl bg-amber-500/10 border-2 border-amber-500 flex flex-col space-y-3 animate-pulse text-amber-800 dark:text-amber-300">
              <div className="flex items-center space-x-3">
                <AlertCircle className="w-6 h-6 text-amber-500 flex-shrink-0" />
                <div>
                  <h4 className="font-bold text-sm">Action Required: Machine Paused</h4>
                  <p className="text-xs leading-relaxed font-semibold">{machineState.pauseMessage}</p>
                </div>
              </div>
              <div className="flex items-center justify-end space-x-3 pt-2 border-t border-amber-500/30">
                {machineState.status === 'PAUSED_TOOL' && (
                  <button
                    onClick={() => webSerialManager.zeroZ(12.0)}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-semibold rounded-lg"
                  >
                    Auto-Zero Z (Touch Plate)
                  </button>
                )}
                <button
                  onClick={() => webSerialManager.resumeJob()}
                  className="px-4 py-1.5 bg-amber-500 hover:bg-amber-600 text-slate-950 font-bold text-xs rounded-lg flex items-center space-x-1.5"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
                  <span>Resume Carve (Cycle Start)</span>
                </button>
              </div>
            </div>
          )}

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
                  Est. Time: {Math.round(result.estimatedTimeSeconds / 60)} min
                  ({(result.totalCutDistanceMm / 1000).toFixed(1)} m cut)
                </span>
                {result.toolChange && (
                  <span className="text-amber-600 dark:text-amber-400 font-medium">
                    Pauses for a tool change between passes
                  </span>
                )}
                {pending && <span className="text-slate-400 italic">recalculating…</span>}
              </div>

              <ToolpathView result={result} options={settled} />

              <div className="flex items-center space-x-4 text-[11px] text-slate-500 dark:text-slate-400">
                <span className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-amber-500 inline-block" />
                  <span>Roughing</span>
                </span>
                <span className="flex items-center space-x-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block" />
                  <span>Finishing</span>
                </span>
                <span>Drag to orbit — the wireframe box is the stock.</span>
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

            {machineState.status === 'RUNNING' || machineState.status.startsWith('PAUSED') ? (
              <button
                onClick={() => webSerialManager.cancelJob()}
                className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-red-600 hover:bg-red-700 text-white font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
              >
                <Square className="w-4 h-4" />
                <span>E-Stop / Cancel Carve</span>
              </button>
            ) : machineState.connected ? (
              <button
                onClick={handleStartCarve}
                disabled={!canCarve}
                className="flex items-center space-x-2 whitespace-nowrap px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-slate-950 font-bold text-xs rounded-lg shadow-sm transition-all cursor-pointer"
              >
                <Play className="w-4 h-4 fill-current" />
                <span>Start Carving</span>
              </button>
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
