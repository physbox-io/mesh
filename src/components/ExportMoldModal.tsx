import React, { useState, useMemo, useRef, useEffect } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  X,
  Download,
  Box,
  Info,
  Eye,
  EyeOff,
} from 'lucide-react';
import type { SceneGraph } from '../types/scene';
import {
  generateMoldMeshes,
  computeNormal,
  DEFAULT_MOLD_OPTIONS,
  type MoldOptions,
  type MoldExportResult,
  type Triangle3D,
} from '../utils/moldExporter';
import { NumberInput } from './NumberInput';

interface ExportMoldModalProps {
  isOpen: boolean;
  onClose: () => void;
  scene: SceneGraph;
}

type PreviewViewMode = 'clamshell_exploded' | 'plate' | 'bottom_only' | 'top_only';

const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-purple-500 focus:outline-none disabled:opacity-40';

const sectionClass =
  'p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-4 min-w-0';

const sectionTitleClass =
  'text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

function Field({
  label,
  hint,
  hintAlign = 'start',
  children,
  className = '',
}: {
  label: string;
  hint?: string;
  hintAlign?: 'start' | 'end';
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`space-y-1.5 min-w-0 relative ${className}`}>
      <div className="flex items-center justify-between gap-1">
        <label className="text-xs font-semibold text-slate-600 dark:text-slate-300 truncate">{label}</label>
        {hint && (
          <div className="relative group/hint shrink-0">
            <button
              type="button"
              tabIndex={-1}
              className="text-slate-400 hover:text-slate-200 cursor-help focus:outline-none p-0.5"
            >
              <Info className="w-3.5 h-3.5" />
            </button>
            <div
              className={`pointer-events-none absolute top-full z-50 mt-1.5 w-max max-w-[min(14rem,65vw)] rounded-lg bg-slate-900 dark:bg-slate-950 px-2.5 py-2 text-[11px] font-normal leading-snug text-slate-100 shadow-xl ring-1 ring-slate-700 opacity-0 transition-opacity group-hover/hint:opacity-100 group-focus-within/hint:opacity-100 ${
                hintAlign === 'end' ? 'right-0' : 'left-0'
              }`}
            >
              {hint}
            </div>
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (val: T) => void;
  options: readonly (readonly [T, string])[];
}) {
  return (
    <div className="flex bg-slate-200 dark:bg-slate-700/60 p-0.5 rounded-lg text-xs font-medium min-w-0">
      {options.map(([optVal, label]) => (
        <button
          key={optVal}
          type="button"
          onClick={() => onChange(optVal)}
          className={`flex-1 py-1.5 px-2 rounded-md transition-all cursor-pointer truncate ${
            value === optVal
              ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs font-semibold'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Converts Triangle3D array into Three.js BufferGeometry. */
function trianglesToBufferGeometry(tris: Triangle3D[]): THREE.BufferGeometry {
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 9);

  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    const n = t.normal ?? computeNormal(t.a, t.b, t.c);
    const idx = i * 9;

    positions[idx] = t.a[0];
    positions[idx + 1] = t.a[1];
    positions[idx + 2] = t.a[2];

    positions[idx + 3] = t.b[0];
    positions[idx + 4] = t.b[1];
    positions[idx + 5] = t.b[2];

    positions[idx + 6] = t.c[0];
    positions[idx + 7] = t.c[1];
    positions[idx + 8] = t.c[2];

    for (let k = 0; k < 3; k++) {
      normals[idx + k * 3] = n[0];
      normals[idx + k * 3 + 1] = n[1];
      normals[idx + k * 3 + 2] = n[2];
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geo;
}

export const ExportMoldModal: React.FC<ExportMoldModalProps> = ({ isOpen, onClose, scene }) => {
  const [options, setOptions] = useState<MoldOptions>(DEFAULT_MOLD_OPTIONS);
  const set = <K extends keyof MoldOptions>(key: K, value: MoldOptions[K]) =>
    setOptions((prev) => ({ ...prev, [key]: value }));

  const [viewMode, setViewMode] = useState<PreviewViewMode>('clamshell_exploded');
  const [isXRay, setIsXRay] = useState(false);
  const [explodeGap, setExplodeGap] = useState(30); // mm separation in exploded view

  const mountRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);

  // Generate mold meshes when options or scene changes
  const result: MoldExportResult = useMemo(() => {
    if (!isOpen) {
      return {
        success: false,
        binarySTL: new Uint8Array(0),
        partBounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
        moldBounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
        partWidthMm: 0,
        partDepthMm: 0,
        partHeightMm: 0,
        moldWidthMm: 0,
        moldDepthMm: 0,
        moldHeightMm: 0,
        totalTriangles: 0,
        bottomHalf: { name: 'bottom', triangles: [], bounds: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 }, widthMm: 0, depthMm: 0, heightMm: 0, triangleCount: 0 },
        combinedTriangles: [],
        warnings: [],
      };
    }
    return generateMoldMeshes(scene, options);
  }, [isOpen, scene, options]);

  // Setup WebGL Three.js Scene and OrbitControls
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !isOpen) return;

    const threeScene = new THREE.Scene();
    sceneRef.current = threeScene;

    const camera = new THREE.PerspectiveCamera(40, 1, 1, 3000);
    camera.up.set(0, 0, 1); // Z-up coordinate space matching PhysBox
    camera.position.set(130, -180, 140);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    // Standard PhysBox mapping: Left/Right rotate, Middle pan, Wheel zoom
    controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.ROTATE,
    };

    // Lighting setup
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
    threeScene.add(ambientLight);

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 0.9);
    dirLight1.position.set(-150, 200, 250);
    threeScene.add(dirLight1);

    const dirLight2 = new THREE.DirectionalLight(0xa855f7, 0.4);
    dirLight2.position.set(150, -150, -100);
    threeScene.add(dirLight2);

    const group = new THREE.Group();
    contentRef.current = group;
    threeScene.add(group);

    const resize = () => {
      const w = mount.clientWidth || 600;
      const h = mount.clientHeight || 400;
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
      renderer.render(threeScene, camera);
    };
    tick();

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      threeScene.traverse((o) => {
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
  }, [isOpen]);

  // Update Three.js meshes whenever result, viewMode, isXRay, or explodeGap changes
  useEffect(() => {
    const group = contentRef.current;
    if (!group || !result.success) return;

    group.clear();

    const bottomTris = result.bottomHalf.triangles;
    const topTris = result.topHalf?.triangles;

    // Materials
    const bottomMat = new THREE.MeshStandardMaterial({
      color: 0x06b6d4, // Cyan
      roughness: 0.3,
      metalness: 0.1,
      transparent: isXRay,
      opacity: isXRay ? 0.4 : 1.0,
      depthWrite: !isXRay,
      side: THREE.DoubleSide,
    });

    const topMat = new THREE.MeshStandardMaterial({
      color: 0xa855f7, // Purple
      roughness: 0.3,
      metalness: 0.1,
      transparent: isXRay,
      opacity: isXRay ? 0.4 : 1.0,
      depthWrite: !isXRay,
      side: THREE.DoubleSide,
    });

    if (viewMode === 'plate' || options.moldType === 'open') {
      // Build Plate Layout: Both halves flat side-by-side at Z=0
      if (bottomTris.length > 0) {
        const botGeo = trianglesToBufferGeometry(bottomTris);
        group.add(new THREE.Mesh(botGeo, bottomMat));
      }
      if (topTris && topTris.length > 0 && options.moldType === 'clamshell') {
        const topGeo = trianglesToBufferGeometry(topTris);
        group.add(new THREE.Mesh(topGeo, topMat));
      }
    } else if (viewMode === 'clamshell_exploded') {
      // Exploded View: Bottom cavity at Z=0, Top core/lid elevated above it facing downward
      if (bottomTris.length > 0) {
        // Center bottom half at origin
        const botGeo = trianglesToBufferGeometry(bottomTris);
        const botMesh = new THREE.Mesh(botGeo, bottomMat);
        const mb = result.moldWidthMm / 2;
        botMesh.position.set(mb, 0, 0); // Undo plate offset
        group.add(botMesh);
      }
      if (topTris && topTris.length > 0) {
        // Un-plate and position elevated facing down
        const topGeo = trianglesToBufferGeometry(topTris);
        const topMesh = new THREE.Mesh(topGeo, topMat);
        const mb = result.moldWidthMm / 2;
        // Flip back and lift by explodeGap
        topMesh.rotation.x = Math.PI;
        topMesh.position.set(-mb, 0, result.moldHeightMm + explodeGap);
        group.add(topMesh);
      }
    } else if (viewMode === 'bottom_only') {
      if (bottomTris.length > 0) {
        const botGeo = trianglesToBufferGeometry(bottomTris);
        const botMesh = new THREE.Mesh(botGeo, bottomMat);
        botMesh.position.set(result.moldWidthMm / 2, 0, 0);
        group.add(botMesh);
      }
    } else if (viewMode === 'top_only') {
      if (topTris && topTris.length > 0) {
        const topGeo = trianglesToBufferGeometry(topTris);
        const topMesh = new THREE.Mesh(topGeo, topMat);
        topMesh.position.set(-result.moldWidthMm / 2, 0, 0);
        group.add(topMesh);
      }
    }

    // Grid on Z=0
    const gridDim = Math.max(120, result.moldWidthMm * 2.5);
    const grid = new THREE.GridHelper(gridDim, 24, 0x94a3b8, 0x334155);
    grid.rotation.x = Math.PI / 2; // Lie flat in XY plane
    group.add(grid);

  }, [result, viewMode, isXRay, explodeGap, options.moldType]);

  const handleDownload = (bytes: Uint8Array, filename: string) => {
    const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-slate-900/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-5xl max-h-[95dvh] flex flex-col overflow-hidden text-slate-800 dark:text-slate-100">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center text-white shadow-md">
              <Box className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base">Export 3D Printable Casting Mold</h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Split clamshell & open molds with interlocking alignment pins, pour sprue & vents
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Body */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 grid grid-cols-1 lg:grid-cols-12 gap-6 min-h-0">
          {/* Left Column: 3D WebGL Viewport */}
          <div className="lg:col-span-7 flex flex-col gap-3 min-w-0">
            {/* Viewport Toolbar */}
            <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
              {/* View mode buttons */}
              <div className="flex bg-slate-200 dark:bg-slate-800 p-0.5 rounded-lg">
                {options.moldType === 'clamshell' && (
                  <button
                    type="button"
                    onClick={() => setViewMode('clamshell_exploded')}
                    className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
                      viewMode === 'clamshell_exploded'
                        ? 'bg-white dark:bg-slate-900 text-purple-600 dark:text-purple-400 shadow-xs font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    Exploded Clamshell
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setViewMode('plate')}
                  className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
                    viewMode === 'plate'
                      ? 'bg-white dark:bg-slate-900 text-purple-600 dark:text-purple-400 shadow-xs font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  Print Plate (Flat Z=0)
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('bottom_only')}
                  className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
                    viewMode === 'bottom_only'
                      ? 'bg-white dark:bg-slate-900 text-purple-600 dark:text-purple-400 shadow-xs font-semibold'
                      : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                  }`}
                >
                  Bottom
                </button>
                {options.moldType === 'clamshell' && (
                  <button
                    type="button"
                    onClick={() => setViewMode('top_only')}
                    className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
                      viewMode === 'top_only'
                        ? 'bg-white dark:bg-slate-900 text-purple-600 dark:text-purple-400 shadow-xs font-semibold'
                        : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                    }`}
                  >
                    Top
                  </button>
                )}
              </div>

              {/* X-Ray / Transparent View toggle */}
              <button
                type="button"
                onClick={() => setIsXRay(!isXRay)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs font-semibold transition-all cursor-pointer ${
                  isXRay
                    ? 'bg-purple-100 dark:bg-purple-950/60 border-purple-400 text-purple-700 dark:text-purple-300'
                    : 'bg-white dark:bg-slate-800 border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-100'
                }`}
                title="See through outer walls to inspect internal cavity & pins"
              >
                {isXRay ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
                <span>X-Ray Shell</span>
              </button>
            </div>

            {/* Three.js Canvas Container */}
            <div
              className="relative flex-1 min-h-[300px] lg:min-h-[420px] rounded-xl overflow-hidden border border-slate-200 dark:border-slate-800 bg-slate-950 select-none"
            >
              <div ref={mountRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

              {/* Explode Distance Slider (when in exploded view) */}
              {viewMode === 'clamshell_exploded' && options.moldType === 'clamshell' && (
                <div className="absolute top-3 left-3 bg-slate-900/85 backdrop-blur-md px-3 py-2 rounded-lg text-xs text-slate-300 border border-slate-700 flex items-center gap-2.5 shadow-lg">
                  <span className="font-semibold text-[11px] text-slate-400">Separation:</span>
                  <input
                    type="range"
                    min={5}
                    max={100}
                    step={1}
                    value={explodeGap}
                    onChange={(e) => setExplodeGap(Number(e.target.value))}
                    className="w-24 accent-purple-500 cursor-pointer h-1.5"
                  />
                  <span className="font-mono text-purple-400">{explodeGap} mm</span>
                </div>
              )}

              {/* Mouse Controls Hint */}
              <div className="absolute bottom-3 left-3 bg-slate-900/80 backdrop-blur-md px-2.5 py-1 rounded-md text-[10px] text-slate-300 border border-slate-700 flex items-center gap-2">
                <span>Left/Right: Rotate</span>
                <span>•</span>
                <span>Middle: Pan</span>
                <span>•</span>
                <span>Wheel: Zoom</span>
              </div>

              {/* Halves Legend */}
              <div className="absolute top-3 right-3 flex flex-col gap-1 text-[11px] bg-slate-900/85 backdrop-blur-md p-2 rounded-lg border border-slate-700 shadow-lg">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
                  <span className="text-slate-200">Bottom Cavity</span>
                </div>
                {options.moldType === 'clamshell' && (
                  <div className="flex items-center gap-1.5">
                    <span className="w-2.5 h-2.5 rounded-full bg-purple-400" />
                    <span className="text-slate-200">Top Lid (Pins & Sprue)</span>
                  </div>
                )}
              </div>
            </div>

            {/* Geometry Info Stats */}
            <div className="grid grid-cols-3 gap-2 text-xs">
              <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                <span className="text-slate-400 block text-[10px] uppercase font-semibold">Part Size</span>
                <span className="font-mono font-medium truncate block">
                  {result.partWidthMm} × {result.partDepthMm} × {result.partHeightMm} mm
                </span>
              </div>
              <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                <span className="text-slate-400 block text-[10px] uppercase font-semibold">Mold Block</span>
                <span className="font-mono font-medium text-purple-600 dark:text-purple-400 truncate block">
                  {result.moldWidthMm} × {result.moldDepthMm} × {result.moldHeightMm} mm
                </span>
              </div>
              <div className="bg-slate-100 dark:bg-slate-800 p-2.5 rounded-lg">
                <span className="text-slate-400 block text-[10px] uppercase font-semibold">STL Triangles</span>
                <span className="font-mono font-medium">{result.totalTriangles.toLocaleString()}</span>
              </div>
            </div>
          </div>

          {/* Right Column: Mold Configuration Form */}
          <div className="lg:col-span-5 space-y-4 overflow-y-auto overflow-x-hidden pr-1 min-w-0">
            {/* Mold Style */}
            <div className={sectionClass}>
              <div className={sectionTitleClass}>Mold Architecture</div>
              <Field label="Mold Style" hint="Two-Part Clamshell creates front and back interlocking halves. One-Part Open creates a single top-fill mold.">
                <Segmented
                  value={options.moldType}
                  onChange={(v) => set('moldType', v)}
                  options={[
                    ['clamshell', 'Two-Part Clamshell'],
                    ['open', 'One-Part Open Mold'],
                  ] as const}
                />
              </Field>

              <div className="grid grid-cols-2 gap-3 min-w-0">
                <Field label="Wall Margin (mm)" hint="Perimeter flange width around the cast part." hintAlign="start">
                  <NumberInput
                    min={4}
                    max={50}
                    step="1"
                    value={options.wallMarginMm}
                    onChange={(v) => set('wallMarginMm', v)}
                    className={inputClass}
                  />
                </Field>
                <Field label="Base Floor (mm)" hint="Slab thickness behind the cavity floor/roof." hintAlign="end">
                  <NumberInput
                    min={2}
                    max={30}
                    step="1"
                    value={options.baseThicknessMm}
                    onChange={(v) => set('baseThicknessMm', v)}
                    className={inputClass}
                  />
                </Field>
              </div>

              <Field label="Cavity Depth (mm)" hint="0 uses the scene's natural height. Set a value to scale total depth." hintAlign="end">
                <NumberInput
                  min={0}
                  max={200}
                  step="1"
                  value={options.cavityDepthMm}
                  onChange={(v) => set('cavityDepthMm', v)}
                  className={inputClass}
                />
              </Field>
            </div>

            {/* Registration Pins & Tolerances (Clamshell only) */}
            {options.moldType === 'clamshell' && (
              <div className={sectionClass}>
                <div className={sectionTitleClass}>Interlocking Registration Pins</div>
                <div className="grid grid-cols-3 gap-2 min-w-0">
                  <Field label="Pin Dia (mm)" hint="Base diameter of tapered alignment cone." hintAlign="start">
                    <NumberInput
                      min={3}
                      max={20}
                      step="0.5"
                      value={options.pinDiameterMm}
                      onChange={(v) => set('pinDiameterMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Height (mm)" hint="Pin height above parting plane." hintAlign="start">
                    <NumberInput
                      min={2}
                      max={15}
                      step="0.5"
                      value={options.pinHeightMm}
                      onChange={(v) => set('pinHeightMm', v)}
                      className={inputClass}
                    />
                  </Field>
                  <Field label="Tolerance" hint="Clearance offset added to female sockets for 3D printer fit." hintAlign="end">
                    <NumberInput
                      min={0.1}
                      max={1.0}
                      step="0.05"
                      value={options.pinToleranceMm}
                      onChange={(v) => set('pinToleranceMm', v)}
                      className={inputClass}
                    />
                  </Field>
                </div>
                <p className="text-[11px] text-slate-500 dark:text-slate-400">
                  Corner 1 is keyed with an asymmetric offset so the two halves cannot be assembled reversed.
                </p>
              </div>
            )}

            {/* Pour Sprue & Air Bleed Channels */}
            {options.moldType === 'clamshell' && (
              <div className={sectionClass}>
                <div className={sectionTitleClass}>Pouring & Vents</div>
                <div className="space-y-3 min-w-0">
                  <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.includeSprue}
                      onChange={(e) => set('includeSprue', e.target.checked)}
                      className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500"
                    />
                    Include Tapered Pour Sprue Funnel
                  </label>

                  {options.includeSprue && (
                    <div className="grid grid-cols-2 gap-3 pl-6 min-w-0">
                      <Field label="Inlet Dia (mm)" hintAlign="start">
                        <NumberInput
                          min={4}
                          max={30}
                          step="1"
                          value={options.sprueTopDiaMm}
                          onChange={(v) => set('sprueTopDiaMm', v)}
                          className={inputClass}
                        />
                      </Field>
                      <Field label="Outlet Dia (mm)" hintAlign="end">
                        <NumberInput
                          min={2}
                          max={15}
                          step="0.5"
                          value={options.sprueBottomDiaMm}
                          onChange={(v) => set('sprueBottomDiaMm', v)}
                          className={inputClass}
                        />
                      </Field>
                    </div>
                  )}

                  <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.includeVents}
                      onChange={(e) => set('includeVents', e.target.checked)}
                      className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500"
                    />
                    Include Air Riser Bleed Holes (Prevents Bubbles)
                  </label>

                  <label className="flex items-center gap-2 text-xs font-semibold cursor-pointer">
                    <input
                      type="checkbox"
                      checked={options.includePryNotches}
                      onChange={(e) => set('includePryNotches', e.target.checked)}
                      className="rounded border-slate-300 dark:border-slate-700 text-purple-600 focus:ring-purple-500"
                    />
                    Include Corner Demolding Pry Slots
                  </label>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer Actions */}
        <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex items-center justify-between flex-wrap gap-3">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Export layout: <strong className="text-slate-700 dark:text-slate-200">Both halves flat on Z=0 build plate</strong>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-medium text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors cursor-pointer"
            >
              Cancel
            </button>

            <button
              onClick={() => handleDownload(result.binarySTL, 'casting_mold_plate.stl')}
              disabled={!result.success || result.totalTriangles === 0}
              className="flex items-center gap-2 px-5 py-2 text-xs font-semibold text-white bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 rounded-xl shadow-md hover:shadow-lg disabled:opacity-50 transition-all cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>Download STL</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
