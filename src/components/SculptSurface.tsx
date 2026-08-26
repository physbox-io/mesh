// ---------------------------------------------------------------------------
// The sculptable surface in the viewport
// ---------------------------------------------------------------------------
//
// While a body is being sculpted this draws it instead of the ordinary mesh
// renderer, because the ordinary one rebuilds its geometry from the scene graph
// and the scene graph is deliberately a stroke behind: committing a 40 k-vertex
// mesh into the store on every pointer move would recompile the MuJoCo model
// sixty times a second to show a shape that is not finished being made.
//
// So during a stroke this owns the truth. It keeps a `SculptMesh`, mutates the
// GPU buffer in place as the brush moves, and hands the result to the store once
// on pointer-up. The scene graph sees whole strokes; the screen sees every dab.
// ---------------------------------------------------------------------------

import { useMemo, useRef, useState, useEffect, useCallback } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../store/useStore';
import {
  fromSceneGeom,
  toSceneGeom,
  beginStroke,
  applyBrush,
  endStroke,
  applyUndo,
  raycastMesh,
  recomputeNormals,
  isWatertight,
  type SculptMesh,
  type SculptSession,
  type SculptUndoEntry,
  type BrushSettings,
} from '../utils/sculptMesh';

/**
 * How far the brush travels between dabs, as a fraction of its radius.
 *
 * A dab per pointer event is a dotted line the moment the mouse moves quickly,
 * and a dab per millimetre is a stroke that never keeps up. A quarter of the
 * radius is close enough that consecutive falloffs overlap into one smooth
 * displacement and far enough that a fast drag across the model costs tens of
 * dabs rather than thousands.
 */
const SPACING_FRACTION = 0.25;

/** Where the pointer went, resolved onto the mesh. */
interface SurfacePoint {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
}

export interface SculptSurfaceProps {
  nodeId: string;
  geomName: string;
  color: number[];
  mujoco: any;
  model: any;
  data: any;
  renderVertices: number[];
  faces: number[];
}

export function SculptSurface({
  nodeId, geomName, color, mujoco, model, data, renderVertices, faces,
}: SculptSurfaceProps) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const cursorRef = useRef<THREE.Mesh>(null);

  const brush = useStore((s) => s.sculptBrush);
  // The viewport-wide wireframe applies here too — a sculpt is the one body
  // whose tessellation you most want to be able to look at.
  const wireframe = useStore((s) => s.wireframe);
  const updateNodeGeom = useStore((s) => s.updateNodeGeom);
  const { gl } = useThree();
  // Same trick the rest of the app uses to stop the camera mid-gesture: reach
  // the live controls through R3F's `get()` rather than a render value, because
  // `makeDefault` registers them after the scene's meshes have mounted.
  const getThree = useThree((state) => state.get);
  const setOrbitEnabled = useCallback((on: boolean) => {
    const controls = getThree().controls as { enabled?: boolean } | null;
    if (controls) controls.enabled = on;
  }, [getThree]);

  // The live mesh, built once on mount and mutated in place from then on.
  //
  // Deliberately NOT rebuilt when `renderVertices` changes: the change that
  // arrives after every stroke is this component's own commit coming back
  // round, and rebuilding on it would throw the mesh away mid-session. Opening
  // a different body remounts this component (the caller keys it by node id),
  // which is what loads a different mesh.
  const [mesh] = useState<SculptMesh>(() => fromSceneGeom(renderVertices, faces));

  const sessionRef = useRef<SculptSession | null>(null);
  const lastPoint = useRef<SurfacePoint | null>(null);
  const undoStack = useRef<SculptUndoEntry[]>([]);
  /** Whether this body has already been flagged as sculpted. */
  const markedEdited = useRef(false);
  const redoStack = useRef<SculptUndoEntry[]>([]);
  // The brush the next dab will use. Held in a ref so the pointer handlers do
  // not have to be rebuilt — and written in an effect rather than in render,
  // because a ref written during render is not a render output.
  const brushRef = useRef<BrushSettings>(brush);
  useEffect(() => { brushRef.current = brush; }, [brush]);

  // ---------------------------------------------------------------------
  // The GPU buffer
  // ---------------------------------------------------------------------

  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(0), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(0), 1));
    return geo;
    // One geometry for the life of the component; the buffers inside it are
    // reused across strokes and only grown when the mesh outgrows them.
  }, []);

  useEffect(() => () => geometry.dispose(), [geometry]);

  /**
   * Pushes the mesh into the buffer.
   *
   * Reallocating only when the mesh has outgrown what is there is the whole
   * point: a stroke that moves vertices without adding any writes into the
   * existing arrays and costs one upload, and dynamic topology's growth is
   * amortised by the doubling underneath.
   */
  const syncGeometry = useCallback((mesh: SculptMesh) => {
    const positionAttr = geometry.getAttribute('position') as THREE.BufferAttribute;
    const indexAttr = geometry.getIndex()!;

    const vertexFloats = mesh.vertexCount * 3;
    const indexCount = mesh.faceCount * 3;

    if (positionAttr.array.length < vertexFloats) {
      geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions.length), 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(mesh.normals.length), 3));
    }
    if (indexAttr.array.length < indexCount) {
      geometry.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.faces.length), 1));
    }

    const positions = geometry.getAttribute('position') as THREE.BufferAttribute;
    const normals = geometry.getAttribute('normal') as THREE.BufferAttribute;
    const index = geometry.getIndex()!;

    (positions.array as Float32Array).set(mesh.positions.subarray(0, vertexFloats));
    (normals.array as Float32Array).set(mesh.normals.subarray(0, vertexFloats));
    (index.array as Uint32Array).set(mesh.faces.subarray(0, indexCount));

    positions.needsUpdate = true;
    normals.needsUpdate = true;
    index.needsUpdate = true;
    geometry.setDrawRange(0, indexCount);
    geometry.computeBoundingSphere();
  }, [geometry]);

  /**
   * Publishes the counts the panel shows.
   *
   * Done at the end of a stroke rather than per dab: `isWatertight` walks every
   * edge in the mesh, which is a fine thing to do sixty times a minute and a
   * poor one to do sixty times a second.
   */
  const publishStats = useCallback((mesh: SculptMesh, atBudget = false) => {
    useStore.getState().setSculptStats({
      vertices: mesh.vertexCount,
      faces: mesh.faceCount,
      watertight: isWatertight(mesh),
      atBudget,
    });
  }, []);

  // First paint.
  useEffect(() => {
    syncGeometry(mesh);
    publishStats(mesh);
  }, [mesh, syncGeometry, publishStats]);

  // ---------------------------------------------------------------------
  // Where the body is
  // ---------------------------------------------------------------------

  const bodyId = useMemo(() => {
    if (!mujoco || !model) return -1;
    try {
      return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, nodeId);
    } catch {
      return -1;
    }
  }, [mujoco, model, nodeId]);

  const rotation = useRef(new THREE.Matrix4());
  useFrame(() => {
    if (!groupRef.current || bodyId === -1 || !data) return;
    try {
      const offset = bodyId * 9;
      const m = data.xmat;
      rotation.current.set(
        m[offset], m[offset + 1], m[offset + 2], 0,
        m[offset + 3], m[offset + 4], m[offset + 5], 0,
        m[offset + 6], m[offset + 7], m[offset + 8], 0,
        0, 0, 0, 1
      );
      groupRef.current.position.set(data.xpos[bodyId * 3], data.xpos[bodyId * 3 + 1], data.xpos[bodyId * 3 + 2]);
      groupRef.current.quaternion.setFromRotationMatrix(rotation.current);
    } catch {
      // The model is being swapped out from under us; next frame will be fine.
    }
  });

  // ---------------------------------------------------------------------
  // Pointer -> surface
  // ---------------------------------------------------------------------

  /**
   * The point under the cursor, in the mesh's own space.
   *
   * Deliberately not `event.point`: that comes from Three's raycast against the
   * buffer, which is one upload behind during a fast stroke, and a brush that
   * lands where the surface *was* digs a trench that lags the cursor. Casting
   * the same ray against the live mesh costs a scan of the triangles and lands
   * the dab where the user is actually pointing.
   */
  const resolve = useCallback((event: ThreeEvent<PointerEvent>): SurfacePoint | null => {
    const group = groupRef.current;
    if (!group) return null;

    const inverse = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const origin = event.ray.origin.clone().applyMatrix4(inverse);
    const direction = event.ray.direction.clone().transformDirection(inverse).normalize();

    const hit = raycastMesh(mesh, origin.x, origin.y, origin.z, direction.x, direction.y, direction.z);
    if (!hit) return null;
    return { x: hit.x, y: hit.y, z: hit.z, nx: hit.nx, ny: hit.ny, nz: hit.nz };
  }, [mesh]);

  /** Moves the ring that shows where the brush will land. */
  const showCursor = useCallback((point: SurfacePoint | null) => {
    const cursor = cursorRef.current;
    if (!cursor) return;
    if (!point) {
      cursor.visible = false;
      return;
    }
    cursor.visible = true;
    cursor.position.set(point.x, point.y, point.z);
    cursor.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(point.nx, point.ny, point.nz)
    );
    const scale = Math.max(1e-4, brushRef.current.radius);
    cursor.scale.set(scale, scale, scale);
  }, []);

  /** Commits the finished stroke to the scene graph. */
  const commit = useCallback((atBudget = false) => {
    const geom = toSceneGeom(mesh);
    updateNodeGeom(nodeId, { vertices: geom.vertices, renderVertices: geom.renderVertices, faces: geom.faces }, 0);

    // Marked once, not on every stroke: the flag exists so that changing the
    // base shape knows whether it is throwing work away, and writing it each
    // time would be a scene-graph update per stroke for a boolean that only
    // ever goes one way.
    if (!markedEdited.current) {
      markedEdited.current = true;
      useStore.getState().updateNode(nodeId, { sculptEdited: true });
    }

    publishStats(mesh, atBudget);
  }, [mesh, nodeId, updateNodeGeom, publishStats]);

  const stamp = useCallback((point: SurfacePoint, delta?: { x: number; y: number; z: number }) => {
    const session = sessionRef.current;
    if (!session) return;

    applyBrush(session, brushRef.current, {
      x: point.x, y: point.y, z: point.z,
      nx: point.nx, ny: point.ny, nz: point.nz,
      dx: delta?.x, dy: delta?.y, dz: delta?.z,
    });
    recomputeNormals(mesh);
    syncGeometry(mesh);
  }, [mesh, syncGeometry]);

  const onPointerDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    const point = resolve(event);
    if (!point) return;

    event.stopPropagation();
    gl.domElement.setPointerCapture?.(event.pointerId);
    // The camera must not swing while a stroke is being drawn — on a touch
    // screen the drag gesture is the orbit gesture, so this is the difference
    // between sculpting and spinning the model around.
    setOrbitEnabled(false);
    useStore.getState().setDraggedNodeId(nodeId);

    sessionRef.current = beginStroke(mesh, brushRef.current);
    lastPoint.current = point;
    redoStack.current.length = 0;
    stamp(point);
    showCursor(point);
  }, [mesh, resolve, stamp, showCursor, gl, setOrbitEnabled, nodeId]);

  const onPointerMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    const point = resolve(event);

    if (!sessionRef.current) {
      showCursor(point);
      return;
    }
    if (!point) return;
    event.stopPropagation();

    const previous = lastPoint.current;
    if (!previous) {
      lastPoint.current = point;
      return;
    }

    if (brushRef.current.type === 'grab') {
      // Grab is a displacement, not a position: what matters is how far the
      // cursor moved, and the caught vertices come with it.
      stamp(previous, { x: point.x - previous.x, y: point.y - previous.y, z: point.z - previous.z });
      lastPoint.current = point;
      showCursor(point);
      return;
    }

    // Interpolate along the drag so a fast stroke is a line, not a dotted one.
    const spacing = Math.max(1e-5, brushRef.current.radius * SPACING_FRACTION);
    const dx = point.x - previous.x;
    const dy = point.y - previous.y;
    const dz = point.z - previous.z;
    const travelled = Math.hypot(dx, dy, dz);
    const steps = Math.min(64, Math.floor(travelled / spacing));

    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      stamp({
        x: previous.x + dx * t,
        y: previous.y + dy * t,
        z: previous.z + dz * t,
        // The normal is interpolated rather than re-cast: between two points a
        // quarter of a brush apart the surface has not turned far, and casting
        // per interpolated dab would cost more than the dab itself.
        nx: previous.nx + (point.nx - previous.nx) * t,
        ny: previous.ny + (point.ny - previous.ny) * t,
        nz: previous.nz + (point.nz - previous.nz) * t,
      });
    }

    if (steps > 0) lastPoint.current = point;
    showCursor(point);
  }, [resolve, stamp, showCursor]);

  const finishStroke = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    const entry = endStroke(session);
    sessionRef.current = null;
    lastPoint.current = null;

    if (entry) {
      undoStack.current.push(entry);
      // The history is capped because a topology-changing stroke keeps a whole
      // mesh; fifty of those on a dense sculpt is real memory.
      if (undoStack.current.length > 50) undoStack.current.shift();
      commit(session.hitVertexBudget);
    }

    setOrbitEnabled(true);
    useStore.getState().setDraggedNodeId(null);
  }, [commit, setOrbitEnabled]);

  const onPointerUp = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (gl.domElement.hasPointerCapture?.(event.pointerId)) {
      gl.domElement.releasePointerCapture(event.pointerId);
    }
    finishStroke();
  }, [finishStroke, gl]);

  const onPointerLeave = useCallback(() => {
    showCursor(null);
    // A stroke that leaves the mesh is finished, not paused: keeping it open
    // means the next dab jumps from wherever the pointer re-enters.
    finishStroke();
  }, [showCursor, finishStroke]);

  // ---------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'z') return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const stack = event.shiftKey ? redoStack.current : undoStack.current;
      const other = event.shiftKey ? undoStack.current : redoStack.current;
      const entry = stack.pop();
      if (!entry) return;

      event.preventDefault();
      event.stopPropagation();
      other.push(applyUndo(mesh, entry));
      syncGeometry(mesh);
      commit();
    };
    // Capture, so the app's own history does not also fire for the same key
    // while the sculpt tools are open and owning the mesh.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mesh, syncGeometry, commit]);

  // A stroke left open by an unmount would leave the camera disabled.
  useEffect(() => () => {
    if (sessionRef.current) {
      endStroke(sessionRef.current);
      sessionRef.current = null;
      useStore.getState().setDraggedNodeId(null);
    }
  }, []);

  const rgb = new THREE.Color(color?.[0] ?? 0.82, color?.[1] ?? 0.72, color?.[2] ?? 0.62);

  return (
    <group ref={groupRef} name={`${nodeId}_sculpt`}>
      <mesh
        ref={meshRef}
        name={geomName}
        geometry={geometry}
        castShadow
        receiveShadow
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerLeave}
      >
        <meshStandardMaterial color={rgb} roughness={0.85} metalness={0.02} side={THREE.FrontSide} wireframe={wireframe} />
      </mesh>

      {/* The brush ring. Drawn on top of the surface so it stays readable in a
          hollow the surface would otherwise occlude it in. */}
      <mesh ref={cursorRef} visible={false} raycast={() => null}>
        <ringGeometry args={[0.92, 1, 48]} />
        <meshBasicMaterial color="#38bdf8" transparent opacity={0.9} side={THREE.DoubleSide} depthTest={false} />
      </mesh>
    </group>
  );
}

export default SculptSurface;
