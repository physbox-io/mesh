import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';

/** How far the pointer has to move before a press is a box rather than a click, px. */
const DRAG_PX = 5;

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
    let box: HTMLDivElement | null = null;
    let swallowClick = false;

    const rectOf = (e: PointerEvent) => {
      const x0 = Math.min(start!.x, e.clientX), x1 = Math.max(start!.x, e.clientX);
      const y0 = Math.min(start!.y, e.clientY), y1 = Math.max(start!.y, e.clientY);
      return { x0, x1, y0, y1 };
    };

    const down = (e: PointerEvent) => {
      if (e.button !== 0 || e.target !== canvas) return;
      start = { x: e.clientX, y: e.clientY };
    };
    const move = (e: PointerEvent) => {
      if (!start) return;
      if (!box && Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_PX) return;
      if (!box) {
        box = document.createElement('div');
        box.style.cssText = 'position:fixed;z-index:40;pointer-events:none;border:1px solid #10b981;background:rgba(16,185,129,0.12);border-radius:2px';
        document.body.appendChild(box);
      }
      const r = rectOf(e);
      Object.assign(box.style, { left: `${r.x0}px`, top: `${r.y0}px`, width: `${r.x1 - r.x0}px`, height: `${r.y1 - r.y0}px` });
    };
    const up = (e: PointerEvent) => {
      if (!start) return;
      if (box) {
        const r = rectOf(e);
        box.remove();
        box = null;
        swallowClick = true;
        useStore.getState().selectMany(bodiesIn(r), e.shiftKey);
      }
      start = null;
    };
    const click = (e: MouseEvent) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.stopPropagation();
      e.preventDefault();
    };

    /** Bodies whose on-screen middle is inside the rectangle (client px). */
    const bodiesIn = (r: { x0: number; x1: number; y0: number; y1: number }): string[] => {
      const bounds = canvas.getBoundingClientRect();
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
      const centreOf = new Map<string, THREE.Box3>();
      scene.updateMatrixWorld();
      scene.traverse((o) => {
        if (o.name && ids.has(o.name)) {
          const b = new THREE.Box3().setFromObject(o);
          if (!b.isEmpty()) centreOf.set(o.name, (centreOf.get(o.name) ?? new THREE.Box3()).union(b));
        }
        const inst = o as THREE.InstancedMesh;
        const owners = o.userData?.nodeIds as (string | undefined)[] | undefined;
        if (inst.isInstancedMesh && owners) {
          const m = new THREE.Matrix4();
          for (let i = 0; i < inst.count; i++) {
            const id = owners[i];
            if (!id) continue;
            inst.getMatrixAt(i, m);
            const p = new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(inst.matrixWorld);
            centreOf.set(id, (centreOf.get(id) ?? new THREE.Box3()).expandByPoint(p));
          }
        }
      });
      for (const [id, b] of centreOf) if (inside(b.getCenter(new THREE.Vector3()))) hit.push(id);
      return hit;
    };

    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('click', click, true);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('click', click, true);
      box?.remove();
    };
  }, [on, gl, camera, scene]);

  return null;
}
