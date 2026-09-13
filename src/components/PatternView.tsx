import React, { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/** Positions (9 numbers per triangle) out of a binary STL, normals dropped. */
function stlToPositions(stl: Uint8Array): Float32Array {
  const dv = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
  if (stl.byteLength < 84) return new Float32Array(0);
  const count = dv.getUint32(80, true);
  if (stl.byteLength < 84 + count * 50) return new Float32Array(0);
  const pos = new Float32Array(count * 9);
  let o = 84;
  for (let t = 0; t < count; t++) {
    o += 12; // per-face normal, recomputed below for flat shading
    for (let v = 0; v < 9; v++) {
      pos[t * 9 + v] = dv.getFloat32(o, true);
      o += 4;
    }
    o += 2; // attribute byte count
  }
  return pos;
}

/**
 * A small static viewport for a printed pattern.
 *
 * It shows exactly the STL the Cast dialog will hand you, part plus gating, so
 * you can see the sprue and riser sit where they should before you print. The
 * renderer is built once for as long as the dialog is open and only the mesh is
 * swapped, the same lifecycle as the toolpath preview.
 *
 * The mount is `absolute inset-0` on a relative, definite-height box on purpose:
 * an in-flow canvas resolves its height against an indefinite parent, which both
 * blanks it and feeds a ResizeObserver a height that grows every frame.
 */
export function PatternView({ stl }: { stl: Uint8Array | null }) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<THREE.Group | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const userMovedRef = useRef(false);

  // Build the renderer once.
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100000);
    camera.up.set(0, 0, 1); // Z-up, so the pattern stands as it prints
    camera.position.set(1, -1.6, 1.1);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.domElement.style.display = 'block';
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    controls.addEventListener('start', () => { userMovedRef.current = true; });
    controlsRef.current = controls;

    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(-120, 160, 220);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xf59e0b, 0.35);
    fill.position.set(140, -120, -80);
    scene.add(fill);

    const group = new THREE.Group();
    contentRef.current = group;
    scene.add(group);

    const resize = () => {
      const w = mount.clientWidth || 600;
      const h = mount.clientHeight || 320;
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
      cameraRef.current = null;
      controlsRef.current = null;
    };
  }, []);

  // Swap the mesh whenever the pattern changes.
  useEffect(() => {
    const group = contentRef.current;
    if (!group) return;

    for (let i = group.children.length - 1; i >= 0; i--) {
      const child = group.children[i] as THREE.Mesh;
      child.geometry?.dispose?.();
      const mat = child.material as THREE.Material | undefined;
      mat?.dispose?.();
      group.remove(child);
    }

    const positions = stl ? stlToPositions(stl) : new Float32Array(0);
    if (positions.length === 0) return;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals(); // unshared verts, so this is flat per-face shading
    geo.computeBoundingBox();

    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        metalness: 0.1,
        roughness: 0.75,
        flatShading: true,
        side: THREE.DoubleSide,
      })
    );
    group.add(mesh);

    // Centre the group on the pattern and, until the user has orbited, frame it.
    const box = geo.boundingBox!;
    const centre = new THREE.Vector3();
    box.getCenter(centre);
    group.position.set(-centre.x, -centre.y, -centre.z);

    if (!userMovedRef.current && cameraRef.current && controlsRef.current) {
      const size = new THREE.Vector3();
      box.getSize(size);
      const radius = Math.max(size.x, size.y, size.z) || 50;
      const dist = radius * 2.2;
      cameraRef.current.position.set(dist * 0.55, -dist * 0.9, dist * 0.6);
      cameraRef.current.near = Math.max(0.1, radius / 100);
      cameraRef.current.far = radius * 50;
      cameraRef.current.updateProjectionMatrix();
      controlsRef.current.target.set(0, 0, 0);
      controlsRef.current.update();
    }
  }, [stl]);

  return (
    <div className="relative w-full h-72 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden">
      <div className="absolute inset-0" ref={mountRef} />
      {!stl && (
        <div className="absolute inset-0 flex items-center justify-center text-xs font-medium text-slate-400 pointer-events-none">
          <span className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-orange-400 animate-pulse" />
            Building the pattern…
          </span>
        </div>
      )}
      <div className="absolute bottom-2 left-2 bg-slate-900/80 backdrop-blur-md px-2 py-1 rounded text-[10px] text-slate-300 border border-slate-700 pointer-events-none">
        Drag to orbit · scroll to zoom
      </div>
    </div>
  );
}
