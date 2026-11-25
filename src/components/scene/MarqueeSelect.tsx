import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';

/** How far the pointer has to move before a press is a box rather than a click, px. */
const DRAG_PX = 5;

/**
 * Whether a marquee drag covers enough screen distance to commit a selection.
 * Rejects zero-size or sub-threshold drags (including dragging out and back
 * to the origin) and non-finite coordinates.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function isValidMarqueeDrag(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  minPx = DRAG_PX,
): boolean {
  if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    return false;
  }
  return Math.hypot(x1 - x0, y1 - y0) >= minPx;
}

function isFiniteBox(box: THREE.Box3): boolean {
  return (
    Number.isFinite(box.min.x) && Number.isFinite(box.min.y) && Number.isFinite(box.min.z) &&
    Number.isFinite(box.max.x) && Number.isFinite(box.max.y) && Number.isFinite(box.max.z)
  );
}

/** True when every material on a mesh is hidden or fully transparent. */
function isMaterialHidden(material: THREE.Material | THREE.Material[] | undefined): boolean {
  if (!material) return false;
  const mats = Array.isArray(material) ? material : [material];
  return mats.length > 0 && mats.every((m) => m.visible === false || (m.opacity ?? 1) <= 0);
}

/**
 * Computes each visible body's world-space bounding box from its OWN visible
 * meshes (without letting child `<group name=...>` bodies skew their parent's
 * centre), skipping `visible === false` objects/ancestors and zero-scale
 * `(0,0,0)` hidden `InstancedMesh` slots.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function collectVisibleBodyBounds(
  scene: THREE.Object3D,
  nodeIds: Set<string>,
): Map<string, THREE.Box3> {
  const centreOf = new Map<string, THREE.Box3>();
  scene.updateMatrixWorld(true);
  const instMat = new THREE.Matrix4();
  const scaleVec = new THREE.Vector3();
  const posVec = new THREE.Vector3();
  const meshBox = new THREE.Box3();

  const walk = (o: THREE.Object3D, ownerId: string | null) => {
    if (!o.visible || o.userData?.isOverlay || o.userData?.isBackground) return;
    const currentOwner = o.name && nodeIds.has(o.name) ? o.name : ownerId;

    const inst = o as THREE.InstancedMesh;
    const owners = o.userData?.nodeIds as (string | undefined)[] | undefined;
    if (inst.isInstancedMesh && Array.isArray(owners)) {
      if (!isMaterialHidden(inst.material)) {
        for (let i = 0; i < inst.count; i++) {
          const id = owners[i];
          if (!id || !nodeIds.has(id)) continue;
          inst.getMatrixAt(i, instMat);
          scaleVec.setFromMatrixScale(instMat);
          if (scaleVec.lengthSq() < 1e-12) continue;
          posVec.setFromMatrixPosition(instMat).applyMatrix4(inst.matrixWorld);
          centreOf.set(id, (centreOf.get(id) ?? new THREE.Box3()).expandByPoint(posVec));
        }
      }
      return;
    }

    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && mesh.geometry && currentOwner && !isMaterialHidden(mesh.material)) {
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.geometry.boundingBox && !mesh.geometry.boundingBox.isEmpty()) {
        meshBox.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
        if (!meshBox.isEmpty() && isFiniteBox(meshBox)) {
          centreOf.set(currentOwner, (centreOf.get(currentOwner) ?? new THREE.Box3()).union(meshBox));
        }
      }
    }

    for (const child of o.children) walk(child, currentOwner);
  };

  walk(scene, null);
  return centreOf;
}

/**
 * Select Multiple's box: drag across the viewport with the left button and
 * every body whose middle lands inside the box is selected. Shift keeps what
 * was selected already. A press that does not move is left alone, so a click
 * still adds or removes one body.
 *
 * Plain DOM listeners on the window, in the capture phase, rather than R3F
 * events: the box has to start over empty space as readily as over a body,
 * and the click the browser sends after a drag has to be swallowed before the
 * viewport reads it as a click on whatever is under the pointer.
 *
 * Bodies are found the way the selection outline finds them: every body draws
 * inside a group named after its node. Boxes are the exception, drawn as one
 * instanced mesh whose instances say which body each belongs to.
 */
export function MarqueeSelect() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const on = useStore((s) => s.multiSelectMode);

  useEffect(() => {
    if (!on) return;
    const canvas = gl.domElement;
    let start: { x: number; y: number } | null = null;
    let activePointerId: number | null = null;
    let box: HTMLDivElement | null = null;
    let swallowClick = false;
    let swallowTimer: ReturnType<typeof setTimeout> | null = null;

    const clearSwallow = () => {
      swallowClick = false;
      if (swallowTimer !== null) {
        clearTimeout(swallowTimer);
        swallowTimer = null;
      }
    };

    const cancelDrag = () => {
      if (box) {
        box.remove();
        box = null;
      }
      start = null;
      activePointerId = null;
    };

    const rectOf = (e: PointerEvent) => {
      const x0 = Math.min(start!.x, e.clientX), x1 = Math.max(start!.x, e.clientX);
      const y0 = Math.min(start!.y, e.clientY), y1 = Math.max(start!.y, e.clientY);
      return { x0, x1, y0, y1 };
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.target !== canvas || activePointerId !== null) return;
      start = { x: e.clientX, y: e.clientY };
      activePointerId = e.pointerId;
    };
    const move = (e: PointerEvent) => {
      if (!start || e.pointerId !== activePointerId) return;
      if (!box && !isValidMarqueeDrag(start.x, start.y, e.clientX, e.clientY)) return;
      if (!box) {
        box = document.createElement('div');
        box.style.cssText = 'position:fixed;z-index:40;pointer-events:none;border:1px solid #10b981;background:rgba(16,185,129,0.12);border-radius:2px';
        document.body.appendChild(box);
      }
      const r = rectOf(e);
      Object.assign(box.style, { left: `${r.x0}px`, top: `${r.y0}px`, width: `${r.x1 - r.x0}px`, height: `${r.y1 - r.y0}px` });
    };
    const up = (e: PointerEvent) => {
      if (!start || e.pointerId !== activePointerId || e.button !== 0) return;
      const hadBox = box !== null;
      const r = rectOf(e);
      const valid = hadBox && isValidMarqueeDrag(start.x, start.y, e.clientX, e.clientY);
      cancelDrag();
      if (hadBox) {
        clearSwallow();
        swallowClick = true;
        // Clear on the next macrotask so releasing off-canvas (where no
        // synthetic click fires) never swallows the user's next click.
        swallowTimer = setTimeout(() => {
          swallowClick = false;
          swallowTimer = null;
        }, 0);
        if (valid) {
          useStore.getState().selectMany(bodiesIn(r), e.shiftKey || e.ctrlKey || e.metaKey);
        }
      }
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (activePointerId !== null && e.pointerId !== activePointerId) return;
      cancelDrag();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && start) {
        e.preventDefault();
        e.stopImmediatePropagation();
        cancelDrag();
      }
    };
    const click = (e: MouseEvent) => {
      if (!swallowClick) return;
      clearSwallow();
      e.stopPropagation();
      e.preventDefault();
    };

    /** Bodies whose on-screen middle is inside the rectangle (client px). */
    const bodiesIn = (r: { x0: number; x1: number; y0: number; y1: number }): string[] => {
      const bounds = canvas.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) return [];
      const inside = (world: THREE.Vector3) => {
        const p = world.clone().project(camera);
        if (p.z > 1 || p.z < -1) return false;
        const x = bounds.left + (p.x + 1) / 2 * bounds.width;
        const y = bounds.top + (1 - p.y) / 2 * bounds.height;
        return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1;
      };
      const ids = new Set<string>();
      const walk = (nodes: SceneNode[]) => { for (const n of nodes) { ids.add(n.id); walk(n.children || []); } };
      walk(useStore.getState().sceneGraph.nodes);

      const hit: string[] = [];
      const centreOf = collectVisibleBodyBounds(scene, ids);
      for (const [id, b] of centreOf) if (inside(b.getCenter(new THREE.Vector3()))) hit.push(id);
      return hit;
    };

    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', cancelDrag);
    window.addEventListener('click', click, true);
    return () => {
      clearSwallow();
      cancelDrag();
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', cancelDrag);
      window.removeEventListener('click', click, true);
    };
  }, [on, gl, camera, scene]);

  return null;
}
