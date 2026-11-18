/**
 * Cloth taken hold of while the scene runs: press on it and drag, and the
 * point under the pointer follows (a hood pulled down, a hem lifted, a
 * scarf thrown back), let go where it is when released. The drag itself is
 * the body drag's (DragInteractionController moves the target and lets go);
 * this only tells the worker which point of the cloth it holds. Pressed on a
 * zip's slider or the pull below it, the drag runs the slider along the zip
 * instead (ClothSim.grabZip), doing it up or undoing it as it goes.
 */
import * as THREE from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import type { FlexInfo } from '../../workers/physicsWorkerProtocol';
import { useOrbitEnable } from './useOrbitEnable';

export function useClothGrab(nodeId: string | undefined, flex: FlexInfo) {
  const setOrbitEnabled = useOrbitEnable();
  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    const st = useStore.getState();
    if (!nodeId || !st.isPlaying || st.paintMode || !e.face) return;
    e.stopPropagation();
    // The corner of the triangle hit nearest the point hit: the cloth's point there
    // (its two faces are drawn from the same points, the back face's offset by N).
    const pos = (e.object as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute;
    const v = new THREE.Vector3();
    let best = e.face.a, bd = Infinity;
    for (const c of [e.face.a, e.face.b, e.face.c]) {
      v.fromBufferAttribute(pos, c).applyMatrix4(e.object.matrixWorld);
      const d = v.distanceToSquared(e.point);
      if (d < bd) { bd = d; best = c; }
    }
    const local = best % flex.vertnum;
    // Where it was pressed too: on a zip's slider or its pull, the worker takes
    // the slider instead, and the drag moves it along the zip.
    getPhysicsWorkerClient().setClothGrab(flex.vertadr + local, [e.point.x, -e.point.z, e.point.y]);
    setOrbitEnabled(false);
    st.setDraggedNodeId(nodeId);
    st.setDragDistance(e.distance);
    // Three's Y-up to the sim's Z-up.
    st.setDragTarget({ x: e.point.x, y: -e.point.z, z: e.point.y });
    const canvasEl = e.nativeEvent?.target as HTMLElement;
    try { canvasEl?.setPointerCapture?.(e.pointerId); } catch { /* capture is best-effort */ }
  };
  return { onPointerDown };
}
