import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { useStore, setPhysicsFrameListener } from '../../store/useStore';
import { useDentStore } from '../../store/dentStore';

/**
 * Asks for a frame whenever the picture may have changed, so a paused scene
 * can stop drawing.
 *
 * The Canvas renders on demand while the simulation is stopped (see
 * `frameloop` on the Canvas in App.tsx). Before that it drew every frame forever: shadow map,
 * scene, ambient occlusion and the axis legend, sixty-plus times a second over
 * a scene where nothing was moving. On demand, something has to say when a
 * frame is needed, and nearly everything that changes the picture passes
 * through one of four places: the scene store, the dent store, a physics
 * frame, or a pointer or key event on the page. The tools that write straight
 * into three objects mid-drag (sculpt, gizmo, measure) are all driven by
 * pointer events, so listening for those covers them without each one having
 * to remember.
 * OrbitControls asks for its own frames, damping included.
 *
 * Not every pointer or key event on the page, though: moving the mouse over
 * the sidebar or typing in a panel field drew full frames of a scene nothing
 * had touched. A pointer event counts when it is over the viewport, when a
 * button is held (a drag that has wandered off it), or while a keyboard
 * gesture or the measure tool is following the mouse; a key counts unless it
 * was typed into a field.
 */
export const RenderOnChange = () => {
  const invalidate = useThree((state) => state.invalidate);
  const viewport = useThree((state) => state.gl.domElement.parentElement);
  useEffect(() => {
    const ask = () => invalidate();
    const onPointer = (e: PointerEvent | WheelEvent) => {
      if (e.buttons !== 0) return invalidate();
      const target = e.target as Node | null;
      if (viewport && target && viewport.contains(target)) return invalidate();
      const s = useStore.getState();
      if (s.gestureStatus || s.measureMode) invalidate();
    };
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      invalidate();
    };
    const unsubscribe = useStore.subscribe(ask);
    const unsubscribeDents = useDentStore.subscribe(ask);
    setPhysicsFrameListener(ask);
    const pointerEvents = ['pointermove', 'pointerdown', 'pointerup', 'wheel'] as const;
    const keyEvents = ['keydown', 'keyup'] as const;
    for (const e of pointerEvents) window.addEventListener(e, onPointer, { passive: true });
    for (const e of keyEvents) window.addEventListener(e, onKey, { passive: true });
    return () => {
      unsubscribe();
      unsubscribeDents();
      setPhysicsFrameListener(null);
      for (const e of pointerEvents) window.removeEventListener(e, onPointer);
      for (const e of keyEvents) window.removeEventListener(e, onKey);
    };
  }, [invalidate, viewport]);
  return null;
};
