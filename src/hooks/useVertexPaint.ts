// ---------------------------------------------------------------------------
// The painting gesture
// ---------------------------------------------------------------------------
//
// Turns a surface into something you can draw on: pointer events in, dabs of
// coverage out, and the colour attribute updated in place as the brush moves.
//
// The split is the same one the sculpt tools make. During a stroke this owns
// the truth — a live canvas mutated per dab and uploaded straight to the GPU —
// and the scene graph only hears about it when the stroke ends. Committing per
// pointer event would put a few hundred numbers through the store sixty times a
// second to draw one dot.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../store/useStore';
import {
  applyDab,
  canvasFromLayer,
  layerFromCanvas,
  sampleColor,
  writeVertexColors,
  type PaintCanvas,
  type PaintLayer,
} from '../utils/vertexPaint';

/**
 * How far the brush travels between dabs, as a fraction of its radius.
 *
 * Same reasoning as the sculpt tools: a dab per pointer event is a dotted line
 * as soon as the mouse moves quickly, and a dab per millimetre never keeps up.
 */
const SPACING_FRACTION = 0.25;

export interface VertexPaintOptions {
  /** The body being painted. */
  nodeId?: string;
  /** The geom's name — how the stroke finds its way back into the scene graph. */
  name: string;
  /** The surface being painted, or null when this geom is not paintable. */
  geometry: THREE.BufferGeometry | null;
  /** The geom's own rgba, which shows through wherever coverage is short of full. */
  baseColor: number[];
  /** Stored paint, as it came out of the scene graph. */
  layer?: PaintLayer;
  /** The tessellation the surface was built at, kept with the stroke. */
  res: number[];
  /** Whether the brush is out. Handlers do nothing when it is not. */
  enabled: boolean;
  /** Stops the camera swinging while a stroke is being drawn. */
  setOrbitEnabled: (on: boolean) => void;
  /** Marks the stroke as in progress for the rest of the scene. */
  onStrokeStart: () => void;
}

export interface VertexPaintResult {
  /** Spread onto the painted mesh. Empty when painting is off. */
  handlers: Partial<{
    onPointerDown: (event: ThreeEvent<PointerEvent>) => void;
    onPointerMove: (event: ThreeEvent<PointerEvent>) => void;
    onPointerOut: () => void;
  }>;
  /** The ring showing where the brush will land, or null when it is elsewhere. */
  cursorRef: React.RefObject<THREE.Mesh | null>;
}

export function useVertexPaint({
  nodeId, name, geometry, baseColor, layer, res, enabled, setOrbitEnabled, onStrokeStart,
}: VertexPaintOptions): VertexPaintResult {
  const canvasRef = useRef<PaintCanvas | null>(null);
  const cursorRef = useRef<THREE.Mesh | null>(null);
  const dirtyRef = useRef(false);
  const lastPoint = useRef<THREE.Vector3 | null>(null);

  const vertexCount = geometry?.getAttribute('position')?.count ?? 0;

  /**
   * Loads the stored paint onto the surface.
   *
   * Runs on mount, whenever the body's own colour changes (paint is mixed over
   * it, so a new base has to be re-mixed), and whenever the geometry is rebuilt
   * — a resize keeps the segment counts, so the pips land back where they were.
   */
  useEffect(() => {
    if (!geometry || !vertexCount) return;
    const canvas = canvasFromLayer(layer, vertexCount, res);
    canvasRef.current = canvas;

    let attr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr || attr.count !== vertexCount) {
      attr = new THREE.BufferAttribute(new Float32Array(vertexCount * 3), 3);
      geometry.setAttribute('color', attr);
    }
    writeVertexColors(attr.array as Float32Array, baseColor, canvas);
    // A partial range left over from the last stroke would scope this upload to
    // whatever the brush happened to touch, and the rest of the surface would
    // keep the previous colours.
    attr.updateRanges.length = 0;
    attr.needsUpdate = true;
    dirtyRef.current = false;
    // baseColor is an array rebuilt each render by the caller, so it is compared
    // by its contents rather than by identity.
  }, [geometry, vertexCount, layer, res, baseColor[0], baseColor[1], baseColor[2]]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Pushes the canvas into the colour attribute over the range a dab touched. */
  const upload = useCallback((range: { lo: number; hi: number } | null) => {
    const canvas = canvasRef.current;
    if (!geometry || !canvas || !range) return;
    const attr = geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
    if (!attr) return;
    writeVertexColors(attr.array as Float32Array, baseColor, canvas);
    // Only the slice the brush reached goes back up to the GPU. On a dense
    // surface a dab moves a few dozen vertices out of tens of thousands.
    attr.updateRanges.length = 0;
    attr.addUpdateRange(range.lo * 3, (range.hi - range.lo + 1) * 3);
    attr.needsUpdate = true;
    dirtyRef.current = true;
  }, [geometry, baseColor]);

  /** Where the pointer is, in the surface's own space, plus the brush size there. */
  const resolve = useCallback((event: ThreeEvent<PointerEvent>) => {
    const object = event.object as THREE.Object3D;
    const point = object.worldToLocal(event.point.clone());
    const worldScale = object.getWorldScale(new THREE.Vector3());
    // An ellipsoid is drawn as a unit sphere stretched by its three radii, so
    // its local space is not to scale. The mean is what keeps a 6 mm brush
    // roughly 6 mm across on one; on everything else the scale is uniform and
    // this is exact.
    const scale = (worldScale.x + worldScale.y + worldScale.z) / 3 || 1;
    return { point, scale };
  }, []);

  const stamp = useCallback((point: THREE.Vector3, scale: number, erase: boolean) => {
    const canvas = canvasRef.current;
    const positions = geometry?.getAttribute('position')?.array;
    if (!canvas || !positions) return;
    const { paintColor, paintRadius, paintFlow } = useStore.getState();
    upload(applyDab(canvas, positions, {
      x: point.x, y: point.y, z: point.z,
      radius: Math.max(1e-5, paintRadius / scale),
      color: paintColor,
      flow: paintFlow,
      erase,
    }));
  }, [geometry, upload]);

  /** Moves the ring that shows where the brush will land. */
  const showCursor = useCallback((point: THREE.Vector3 | null, normal?: THREE.Vector3 | null, scale = 1) => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    if (!point) {
      cursor.visible = false;
      return;
    }
    cursor.visible = true;
    cursor.position.copy(point);
    if (normal) {
      cursor.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal.clone().normalize());
    }
    const size = Math.max(1e-4, useStore.getState().paintRadius / scale);
    cursor.scale.set(size, size, size);
  }, []);

  /** Writes the finished stroke into the scene graph. */
  const commit = useCallback(() => {
    if (!dirtyRef.current || !nodeId) return;
    const canvas = canvasRef.current;
    dirtyRef.current = false;
    if (!canvas) return;
    useStore.getState().setGeomPaint(nodeId, name, layerFromCanvas(canvas));
  }, [nodeId, name]);

  // A stroke can end anywhere — off the body, off the canvas, outside the
  // window — so the end of it is heard globally rather than waiting for a
  // pointerup this mesh may never see.
  useEffect(() => {
    if (!enabled) return;
    const end = () => {
      lastPoint.current = null;
      commit();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      // Unmounting mid-stroke (leaving paint mode, a recompile) must not throw
      // the stroke away.
      end();
    };
  }, [enabled, commit]);

  const handlers = useMemo(() => {
    if (!enabled || !geometry || !nodeId) return {};
    return {
      onPointerDown: (event: ThreeEvent<PointerEvent>) => {
        if (event.button !== 0) return;
        event.stopPropagation();
        const { point, scale } = resolve(event);

        // Alt picks a colour up instead of putting one down — the eyedropper
        // every painting tool hides under the same modifier, and the reason
        // there is no separate tool button for it.
        if (event.nativeEvent?.altKey) {
          const canvas = canvasRef.current;
          const positions = geometry.getAttribute('position')?.array;
          if (canvas && positions) {
            const picked = sampleColor(canvas, positions, baseColor, point.x, point.y, point.z);
            if (picked) useStore.getState().setPaintColor(picked);
          }
          return;
        }

        onStrokeStart();
        // On a touch screen the drag that paints is the drag that orbits, so
        // without this the model spins away from under the brush.
        setOrbitEnabled(false);
        lastPoint.current = point.clone();
        stamp(point, scale, !!(event.nativeEvent?.ctrlKey || event.nativeEvent?.metaKey));
        showCursor(point, event.face?.normal, scale);
      },

      onPointerMove: (event: ThreeEvent<PointerEvent>) => {
        const { point, scale } = resolve(event);
        const previous = lastPoint.current;
        if (!previous) {
          // Not painting — just showing where the brush would land.
          showCursor(point, event.face?.normal, scale);
          return;
        }
        event.stopPropagation();

        const erase = !!(event.nativeEvent?.ctrlKey || event.nativeEvent?.metaKey);
        // Interpolate along the drag so a fast stroke is a line rather than a
        // row of dots.
        const spacing = Math.max(1e-5, (useStore.getState().paintRadius / scale) * SPACING_FRACTION);
        const travelled = point.distanceTo(previous);
        const steps = Math.min(64, Math.floor(travelled / spacing));
        for (let i = 1; i <= steps; i++) {
          stamp(previous.clone().lerp(point, i / steps), scale, erase);
        }
        if (steps > 0) lastPoint.current = point.clone();
        showCursor(point, event.face?.normal, scale);
      },

      onPointerOut: () => {
        showCursor(null);
        // A stroke that leaves the body is finished, not paused: without this
        // the next dab jumps from wherever the pointer came back in.
        lastPoint.current = null;
        commit();
      },
    };
  }, [enabled, geometry, nodeId, baseColor, resolve, stamp, showCursor, commit, setOrbitEnabled, onStrokeStart]);

  return { handlers, cursorRef };
}
