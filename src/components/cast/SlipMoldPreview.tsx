// ---------------------------------------------------------------------------
// The Slip Cast tab's 3D preview: the plaster pieces pulled apart, the cases
// as they print, or the casting they make
// ---------------------------------------------------------------------------

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { SlipMesh, SlipMold } from '../../utils/slipCastMold';
import type { SlipCastResult } from '../../utils/slipCastSimulation';

export type SlipPreviewMode = 'mold' | 'cases' | 'cast';

/** One colour per piece, so the joints read. */
const PIECE_COLOURS = [0xf5f0e6, 0xd9e6f2, 0xe8dcef, 0xdcefe0, 0xf2e2d2, 0xe0e0e0, 0xefe8c8];
const CASE_COLOUR = 0xeb8c38;

function geometryOf(m: SlipMesh | { positions: Float32Array; faces: Uint32Array }): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(m.positions instanceof Float32Array ? m.positions : Float32Array.from(m.positions), 3));
  geo.setIndex(new THREE.BufferAttribute(m.faces instanceof Uint32Array ? m.faces : Uint32Array.from(m.faces), 1));
  geo.computeVertexNormals();
  return geo;
}

function disposeGroup(g: THREE.Group) {
  g.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose?.();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose?.();
  });
  g.clear();
}

export function SlipMoldPreview({ mold, cast, mode, busy }: {
  mold: SlipMold | null;
  cast: SlipCastResult | null;
  mode: SlipPreviewMode;
  /** A new mold is on its way: what is drawn is the last one. */
  busy: boolean;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const frameRef = useRef<((box: THREE.Box3) => void) | null>(null);
  const [gap, setGap] = useState(30);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
    camera.up.set(0, 0, 1);
    camera.position.set(200, -300, 220);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    scene.add(new THREE.AmbientLight(0xffffff, 0.65));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-150, -200, 300);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(200, 150, -100);
    scene.add(fill);
    const group = new THREE.Group();
    groupRef.current = group;
    scene.add(group);

    frameRef.current = (box: THREE.Box3) => {
      if (box.isEmpty()) return;
      const centre = box.getCenter(new THREE.Vector3());
      const size = box.getSize(new THREE.Vector3()).length();
      const dir = camera.position.clone().sub(controls.target).normalize();
      controls.target.copy(centre);
      camera.position.copy(centre).addScaledVector(dir, size * 1.25);
      camera.near = size / 100;
      camera.far = size * 20;
      camera.updateProjectionMatrix();
    };

    const resize = () => {
      const w = mount.clientWidth || 600, h = mount.clientHeight || 300;
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
      if (mount.offsetParent === null) return;
      controls.update();
      renderer.render(scene, camera);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      controls.dispose();
      disposeGroup(group);
      renderer.dispose();
      renderer.domElement.remove();
      groupRef.current = null;
      frameRef.current = null;
    };
  }, []);

  // Reframed when what is shown changes, not when the gap slides.
  const shown = `${mode}|${mold ? mold.report.blockMm.join(',') : ''}|${cast ? cast.volumeMm3 : ''}`;
  const lastShown = useRef('');

  useEffect(() => {
    const group = groupRef.current;
    if (!group) return;
    disposeGroup(group);
    if (mode === 'cast') {
      if (cast) {
        const mat = new THREE.MeshStandardMaterial({ color: 0xf3efe7, roughness: 0.55, side: THREE.DoubleSide });
        group.add(new THREE.Mesh(geometryOf(cast.mesh), mat));
      }
    } else if (mold && mode === 'mold') {
      mold.pieces.forEach((p, i) => {
        const mat = new THREE.MeshStandardMaterial({ color: PIECE_COLOURS[i % PIECE_COLOURS.length], roughness: 0.8, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geometryOf(p.plaster), mat);
        mesh.position.set(p.pull[0] * gap, p.pull[1] * gap, p.pull[2] * gap);
        group.add(mesh);
      });
    } else if (mold && mode === 'cases') {
      let x = 0;
      for (const p of mold.pieces) {
        const geo = geometryOf(p.casePrint);
        geo.computeBoundingBox();
        const bb = geo.boundingBox!;
        const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: CASE_COLOUR, roughness: 0.6, side: THREE.DoubleSide }));
        mesh.position.set(x - bb.min.x, 0, 0);
        x += bb.max.x - bb.min.x + 15;
        group.add(mesh);
      }
    }
    if (lastShown.current !== shown) {
      lastShown.current = shown;
      frameRef.current?.(new THREE.Box3().setFromObject(group));
    }
  }, [mold, cast, mode, gap, shown]);

  const empty = mode === 'cast' ? !cast : !mold;
  return (
    <div className="space-y-1">
      <div className="relative h-64 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-950 overflow-hidden">
        <div ref={mountRef} className={`absolute inset-0 ${busy ? 'opacity-50' : ''}`} />
        {empty && (
          <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500 dark:text-slate-400 pointer-events-none">
            {mode === 'cast' ? 'Press Simulate Cast to see what the slip makes in the strapped-up mold.' : busy ? 'Planning…' : ''}
          </div>
        )}
      </div>
      {mode === 'mold' && mold && (
        <label className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
          <span>Pull apart</span>
          <input type="range" min={0} max={100} value={gap} onChange={(e) => setGap(Number(e.target.value))} className="flex-1 accent-purple-500" />
        </label>
      )}
    </div>
  );
}
