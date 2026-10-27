// ---------------------------------------------------------------------------
// The rigid mold's 3D preview: the halves, exploded or on the plate, and the
// cast they make
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Eye, EyeOff } from 'lucide-react';
import type { MoldHalfBuffers, MoldSummary } from '../../utils/moldExporter';
import type { MoldPreview } from '../../utils/moldWorkerClient';
import type { MoldCastSimulationResult } from '../../utils/moldCastSimulation';
import type { IndexedMesh } from '../../utils/stlMesh';

export type PreviewViewMode = 'clamshell_exploded' | 'plate' | 'bottom_only' | 'top_only' | 'cast_preview';

/** The view asked for, or the plate where an open mold has no lid to show. */
export function effectiveMoldView(moldType: 'clamshell' | 'open', viewMode: PreviewViewMode): PreviewViewMode {
  return moldType === 'open' && (viewMode === 'clamshell_exploded' || viewMode === 'top_only') ? 'plate' : viewMode;
}

/** Wraps the worker's transferred arrays as geometry, without copying them. */
function buffersToGeometry(buf: MoldHalfBuffers): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(buf.positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(buf.normals, 3));
  return geo;
}

function indexedMeshToGeometry(mesh: IndexedMesh): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.faces, 1));
  geo.computeVertexNormals();
  return geo;
}

export function MoldPreviewView({
  preview, result, moldType, viewMode, onViewMode, busy, castPreview, castPreviewBusy, trimCastChannels, onTrimCastChannels,
}: {
  preview: MoldPreview | null;
  result: MoldSummary;
  moldType: 'clamshell' | 'open';
  viewMode: PreviewViewMode;
  onViewMode: (mode: PreviewViewMode) => void;
  /** A new mold is on its way. */
  busy: boolean;
  castPreview: MoldCastSimulationResult | null;
  castPreviewBusy: boolean;
  trimCastChannels: boolean;
  onTrimCastChannels: (trim: boolean) => void;
}) {
  const [isXRay, setIsXRay] = useState(false);
  const [explodeGap, setExplodeGap] = useState(30); // mm separation in exploded view
  const mountRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const effectiveViewMode = effectiveMoldView(moldType, viewMode);

  // Setup WebGL Three.js Scene and OrbitControls
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const threeScene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(40, 1, 1, 3000);
    camera.up.set(0, 0, 1); // Z-up coordinate space matching PhysBox
    camera.position.set(130, -180, 140);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    // `setSize(w, h, false)` below sets only the drawing buffer, so the canvas
    // needs its own CSS size or it lays out at `w * devicePixelRatio` and is
    // clipped from the top-left. See the same fix in ExportReliefCarveModal.
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
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
      // A tab not on show draws nothing.
      if (mount.offsetParent === null) return;
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
    };
  }, []);

  // Update Three.js meshes whenever result, viewMode, isXRay, or explodeGap changes
  useEffect(() => {
    const group = contentRef.current;
    if (!group || !result.success) return;

    const disposeGroup = (g: THREE.Group) => {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose?.();
      });
      g.clear();
    };
    disposeGroup(group);

    const bottomBuf = preview?.bottom ?? null;
    const topBuf = preview?.top ?? null;
    const linerBottomBuf = preview?.liner?.bottom ?? null;
    const linerTopBuf = preview?.liner?.top ?? null;

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

    // The PVA liner: what dissolves, drawn pale so the shell reads as the mold.
    const linerMat = new THREE.MeshStandardMaterial({
      color: 0xf1f5f9,
      roughness: 0.6,
      metalness: 0,
      transparent: isXRay,
      opacity: isXRay ? 0.5 : 1.0,
      depthWrite: !isXRay,
      side: THREE.DoubleSide,
    });

    /** A half's shell, and its liner placed the same way. */
    const addHalf = (
      buf: MoldHalfBuffers | null,
      linerBuf: MoldHalfBuffers | null,
      mat: THREE.Material,
      place: (m: THREE.Mesh) => void = () => {},
    ) => {
      for (const [b, m] of [[buf, mat], [linerBuf, linerMat]] as const) {
        if (!b) continue;
        const mesh = new THREE.Mesh(buffersToGeometry(b), m);
        place(mesh);
        group.add(mesh);
      }
    };

    const castMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b, // Amber / Cast Plaster-Resin
      roughness: 0.35,
      metalness: 0.08,
      transparent: isXRay,
      opacity: isXRay ? 0.5 : 1.0,
      depthWrite: !isXRay,
      side: THREE.DoubleSide,
    });

    const botCenterX = (result.bottomHalf.bounds.minX + result.bottomHalf.bounds.maxX) / 2;
    const topCenterX = result.topHalf
      ? (result.topHalf.bounds.minX + result.topHalf.bounds.maxX) / 2
      : 0;

    if (effectiveViewMode === 'plate') {
      // Build Plate Layout: Both halves flat side-by-side at Z=0
      addHalf(bottomBuf, linerBottomBuf, bottomMat);
      if (moldType === 'clamshell') addHalf(topBuf, linerTopBuf, topMat);
    } else if (effectiveViewMode === 'clamshell_exploded') {
      // Exploded View: Bottom cavity at Z=0, Top core/lid elevated above it facing downward
      addHalf(bottomBuf, linerBottomBuf, bottomMat, (m) => m.position.set(-botCenterX, 0, 0));
      if (topBuf) {
        const botTopZ = result.bottomHalf.bounds.maxZ;
        const lidTopZ = result.topHalf ? result.topHalf.bounds.maxZ : result.moldHeightMm;
        addHalf(topBuf, linerTopBuf, topMat, (m) => {
          m.rotation.x = Math.PI;
          m.position.set(-topCenterX, 0, botTopZ + lidTopZ + explodeGap);
        });
      }
    } else if (effectiveViewMode === 'bottom_only') {
      addHalf(bottomBuf, linerBottomBuf, bottomMat, (m) => m.position.set(-botCenterX, 0, 0));
    } else if (effectiveViewMode === 'top_only') {
      addHalf(topBuf, linerTopBuf, topMat, (m) => m.position.set(-topCenterX, 0, 0));
    } else if (effectiveViewMode === 'cast_preview') {
      if (castPreview?.success && castPreview.mesh.positions.length > 0) {
        const castMesh = new THREE.Mesh(indexedMeshToGeometry(castPreview.mesh), castMat);
        group.add(castMesh);
      }
    }

    // Grid on Z=0
    const gridDim = Math.max(120, result.moldWidthMm * 2.5);
    const grid = new THREE.GridHelper(gridDim, 24, 0x94a3b8, 0x334155);
    grid.rotation.x = Math.PI / 2; // Lie flat in XY plane
    group.add(grid);
  }, [preview, result, effectiveViewMode, isXRay, explodeGap, moldType, castPreview]);

  return (
    <>
      {/* Viewport Toolbar */}
      <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
        {/* View mode buttons */}
        <div className="flex bg-slate-200 dark:bg-slate-800 p-0.5 rounded-lg">
          {moldType === 'clamshell' && (
            <button
              type="button"
              onClick={() => onViewMode('clamshell_exploded')}
              className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
                effectiveViewMode === 'clamshell_exploded'
                  ? 'bg-white dark:bg-slate-900 text-purple-600 dark:text-purple-400 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Exploded Clamshell
            </button>
          )}
          <button
            type="button"
            onClick={() => onViewMode('plate')}
            className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
              effectiveViewMode === 'plate'
                ? 'bg-white dark:bg-slate-900 text-purple-600 dark:text-purple-400 shadow-xs font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Print Plate (Flat Z=0)
          </button>
          <button
            type="button"
            onClick={() => onViewMode('bottom_only')}
            className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
              effectiveViewMode === 'bottom_only'
                ? 'bg-white dark:bg-slate-900 text-purple-600 dark:text-purple-400 shadow-xs font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Bottom
          </button>
          {moldType === 'clamshell' && (
            <button
              type="button"
              onClick={() => onViewMode('top_only')}
              className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
                effectiveViewMode === 'top_only'
                  ? 'bg-white dark:bg-slate-900 text-purple-600 dark:text-purple-400 shadow-xs font-semibold'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
              }`}
            >
              Top
            </button>
          )}
          <button
            type="button"
            onClick={() => onViewMode('cast_preview')}
            className={`px-2.5 py-1 rounded-md transition-all cursor-pointer font-medium ${
              effectiveViewMode === 'cast_preview'
                ? 'bg-white dark:bg-slate-900 text-amber-600 dark:text-amber-400 shadow-xs font-semibold'
                : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Cast Part
          </button>
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
        {/* Absolute, not `w-full h-full`: in the flow the canvas resolves
            its `height:100%` against the grid cell's indefinite height,
            which renders it blank AND feeds the ResizeObserver a height
            that grows every frame. Taken out of the flow it fills the
            relative box instead and cannot push it taller. Same reason
            ToolpathView mounts its canvas this way. */}
        <div ref={mountRef} className="absolute inset-0 cursor-grab active:cursor-grabbing" />

        {/* Explode Distance Slider (when in exploded view) */}
        {effectiveViewMode === 'clamshell_exploded' && moldType === 'clamshell' && (
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

        {/* Cast Preview Controls (when in cast_preview view) */}
        {effectiveViewMode === 'cast_preview' && (
          <div className="absolute top-3 left-3 bg-slate-900/85 backdrop-blur-md px-3 py-2 rounded-lg text-xs text-slate-300 border border-slate-700 flex items-center gap-3 shadow-lg">
            <label className="flex items-center gap-1.5 cursor-pointer font-medium text-[11px]">
              <input
                type="checkbox"
                checked={trimCastChannels}
                onChange={(e) => onTrimCastChannels(e.target.checked)}
                className="rounded border-slate-600 text-amber-500 focus:ring-amber-500"
              />
              <span>Trim sprue &amp; vents</span>
            </label>
            {castPreview?.success && (
              <span className="font-mono text-[11px] text-amber-400">
                {(castPreview.castVolumeMm3 / 1000).toFixed(1)} cm³
              </span>
            )}
          </div>
        )}

        {/* Says the preview is a moment behind, without blanking it. */}
        {(busy || castPreviewBusy) && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 bg-slate-900/85 backdrop-blur-md px-2.5 py-1 rounded-md text-[10px] font-semibold text-slate-200 border border-slate-700 flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-purple-400 animate-pulse" />
            Rebuilding
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
          {effectiveViewMode === 'cast_preview' ? (
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-400" />
              <span className="text-slate-200">Simulated Cast Part</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-cyan-400" />
                <span className="text-slate-200">Bottom Cavity</span>
              </div>
              {moldType === 'clamshell' && (
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-purple-400" />
                  <span className="text-slate-200">Top Lid (Pins &amp; Sprue)</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
