/**
 * The 3D scene layer.
 *
 * Extracted from App.tsx unchanged: the geom renderers, the controllers that
 * own camera and pointer behaviour inside the canvas, and the paint-stroke flag
 * they share. Everything here runs inside the R3F canvas and talks to MuJoCo
 * through the store rather than through props from App.
 */
import React, { useRef, useMemo, useState, useEffect } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { registerLiveCamera } from '../../utils/liveCamera';
import { useStore } from '../../store/useStore';
import { useOrbitEnable } from './useOrbitEnable';
import { CsgNegativeGhosts } from './CsgGhosts';
import { PulleyRopesRenderer } from './PulleyRopes';
import SculptSurface from '../SculptSurface';
import { PrintAnalysisOverlay } from '../PrintAnalysisOverlay';
import { useCoarsePointer } from '../../hooks/useCoarsePointer';
import { useVertexPaint } from '../../hooks/useVertexPaint';
import { buildPaintGeometry, isPaintable, paintArgsFromSize, paintResolution, type PaintLayer } from '../../utils/vertexPaint';
import { sampleCatmullRom } from '../../utils/geom';
import { resolveCsgGeoms } from '../../utils/csg';

/**
 * Ends a paint stroke wherever it is let go.
 *
 * A stroke starts on a body's own pointerdown, but it can end anywhere — over
 * empty space, over a panel, or outside the window entirely. Left open it would
 * keep colouring every body the cursor merely passed over, with the camera
 * still frozen from when the stroke began.
 */
export const PaintStrokeController = () => {
  const paintMode = useStore(state => state.paintMode);
  const setOrbitEnabled = useOrbitEnable();

  useEffect(() => {
    const end = () => {
      if (!paintStrokeActive) return;
      paintStrokeActive = false;
      setOrbitEnabled(true);
    };
    // Leaving paint mode mid-stroke is the same as letting go of it.
    if (!paintMode) end();

    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    // A window that loses focus mid-stroke never sees the pointerup, and the
    // camera would stay dead with nothing on screen explaining why.
    window.addEventListener('blur', end);
    return () => {
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      end();
    };
  }, [paintMode, setOrbitEnabled]);

  return null;
};

export const CameraController = () => {
  const { camera } = useThree();
  const cameraView = useStore(state => state.cameraView);
  const controlsRef = useRef<any>(null);
  
  useEffect(() => {
    if (cameraView === 'topDown') {
      camera.position.set(0, 1.8, 0);
      camera.up.set(0, 0, -1);
      camera.lookAt(0, 0, 0);
      if (controlsRef.current) {
        controlsRef.current.target.set(0, 0, 0);
        controlsRef.current.update();
      }
    } else {
      camera.position.set(0.8, 0.6, 0.8);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0.15, 0);
      if (controlsRef.current) {
        controlsRef.current.target.set(0, 0.15, 0);
        controlsRef.current.update();
      }
    }
    camera.updateProjectionMatrix();
  }, [cameraView, camera]);

  // Explicit pose from the MCP SET_CAMERA bridge command. The store held this
  // field (and GET_CAMERA reported it) but nothing ever applied it to the
  // actual camera. Values are MuJoCo world space; convert Z-up→Y-up here:
  // (x, y, z) → (x, z, -y).
  const cameraOverride = useStore(state => state.cameraOverride);
  useEffect(() => {
    if (!cameraOverride) return;
    const [px, py, pz] = cameraOverride.position;
    const [tx, ty, tz] = cameraOverride.target;
    camera.up.set(0, 1, 0);
    camera.position.set(px, pz, -py);
    if (controlsRef.current) {
      controlsRef.current.target.set(tx, tz, -ty);
      controlsRef.current.update();
    } else {
      camera.lookAt(tx, tz, -ty);
    }
    camera.updateProjectionMatrix();
  }, [cameraOverride, camera]);

  const draggedNodeId = useStore((state) => state.draggedNodeId);
  /*
   * Hand the live camera and orbit target to the MCP bridge.
   *
   * utils/liveCamera.ts was written for exactly this and its registration was
   * never called from anywhere, so physics_get_camera has always answered
   * without a position or a target — while documenting that it returns both.
   * An agent asking where the camera is pointing got nothing back and no error,
   * which is the least useful of the possible answers.
   *
   * References, not snapshots: OrbitControls mutates these in place as a person
   * drags, so a read at any later moment reflects the view actually on screen.
   */
  useEffect(() => {
    if (controlsRef.current) registerLiveCamera(camera, controlsRef.current.target);
  }, [camera, controlsRef.current]);

  return <OrbitControls enabled={draggedNodeId === null} ref={controlsRef} makeDefault enableDamping dampingFactor={0.1} mouseButtons={{ LEFT: 99 as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }} />;
};

export const WedgeGeometry = ({ width = 2.0, depth = 1.0, height = 0.5 }: { width: number; depth: number; height: number }) => {
  const vertices = useMemo(() => {
    const halfW = width / 2;
    const halfD = depth / 2;

    // Three.js Y-up space (Y = UP, Z = DEPTH, X = RIGHT):
    return new Float32Array([
      -halfW, height, -halfD, // 0: back-left top
      -halfW, height,  halfD, // 1: back-right top
       halfW, 0,      -halfD, // 2: toe-left bottom
       halfW, 0,       halfD, // 3: toe-right bottom
      -halfW, 0,      -halfD, // 4: back-left bottom
      -halfW, 0,       halfD, // 5: back-right bottom
    ]);
  }, [width, depth, height]);

  const indices = useMemo(() => {
    // Must match generateWedgeMeshData's faces exactly — this is the render copy
    // of the same prism, and computeVertexNormals() below derives its normals
    // from this winding.
    return new Uint16Array([
      0, 1, 3,  0, 3, 2, // Slanted top face
      4, 2, 3,  4, 3, 5, // Bottom flat face
      4, 5, 1,  4, 1, 0, // Back vertical wall
      4, 0, 2,           // Front triangle side (y = -halfD)
      5, 3, 1            // Back triangle side (y = +halfD)
    ]);
  }, []);

  const geomRef = useRef<THREE.BufferGeometry>(null);
  useEffect(() => {
    if (geomRef.current) {
      geomRef.current.computeVertexNormals();
    }
  }, [vertices]);

  return (
    <bufferGeometry ref={geomRef}>
      <bufferAttribute
        attach="attributes-position"
        args={[vertices, 3]}
      />
      <bufferAttribute
        attach="index"
        args={[indices, 1]}
      />
    </bufferGeometry>
  );
};


/**
 * Whether a paint stroke is currently down.
 *
 * Module scope rather than store state on purpose: every geom in the scene
 * needs to see it, it changes twice per stroke, and nothing renders from it —
 * putting it in the store would re-render every body in the viewport at the
 * start and end of every stroke to no visible effect. PaintStrokeController
 * owns clearing it.
 */
let paintStrokeActive = false;

const beginPaintStroke = () => { paintStrokeActive = true; };

// Dynamic Geom Renderer
export const DynamicGeom = ({ nodeId, name, type, color, mujoco, model, data, selectedNodeId, setSelectedNodeId, vertices, faces, dynamic: isDynamic, providedGeomId, staticBody }: any) => {
  const meshRef = useRef<THREE.Group>(null);
  const isPlaying = useStore(state => state.isPlaying);
  
  const node = useStore(state => {
    if (!nodeId) return null;
    const find = (nodes: any[]): any => {
      if (!nodes) return null;
      for (const n of nodes) {
        if (n.id === nodeId) return n;
        const c = find(n.children);
        if (c) return c;
      }
      return null;
    };
    return find(state.sceneGraph.nodes);
  });
  
  const geomId = useMemo(() => {
    if (providedGeomId !== undefined) return providedGeomId;
    if (!model || !mujoco) return -1;
    const id = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, name);
    return id;
  }, [providedGeomId, model, mujoco, name]);

  const geometryArgs = useMemo(() => {
    if (geomId === -1 || !model) return [];
    try {
      const ngeom = model.ngeom;
      if (geomId >= ngeom) return [];

      const r = model.geom_size[geomId * 3];
      const hl = model.geom_size[geomId * 3 + 1];
      const hz = model.geom_size[geomId * 3 + 2];
      
      if (type === 'sphere') return [r, 32, 32];
      if (type === 'box') return [r * 2, hl * 2, hz * 2];
      if (type === 'capsule') return [r, hl * 2, 4, 16];
      if (type === 'cylinder') return [r, hl];
      if (type === 'ellipsoid') return [r, hl, hz];
      return [r];
    } catch (e) {
      console.error(`[DynamicGeom ${name}] geometryArgs Error:`, e);
      return [];
    }
  }, [geomId, type, model]);

  const rotationMatrix = useMemo(() => new THREE.Matrix4(), []);
  const isSelected = selectedNodeId === nodeId;

  // A geom's rgba carries an alpha, and until now every material dropped it and
  // drew fully opaque. A jar authored at 0.35 alpha then hides the very thing it
  // exists to contain — a glass jar rendered as a solid white tub with whatever
  // was inside it sealed invisibly away. depthWrite goes off with it, so what
  // sits behind a translucent geom still reaches the frame buffer instead of
  // being depth-rejected, and two coplanar translucent faces blend rather than
  // z-fighting into stripes.
  // Defaulted, not indexed blind: this hook runs for every geom, including the
  // ones the early returns below drop, and a geom without an rgba would take
  // the whole canvas down with it.
  const alpha = color?.[3] ?? 1;
  const wireframe = useStore(state => state.wireframe);

  // --- Painting -------------------------------------------------------------
  // A geom holds paint on its vertices, so it has to be drawn from a surface
  // dense enough to carry it (see utils/vertexPaint). That denser surface is
  // built while the brush is out, and kept from then on by anything that has
  // been painted — a body nobody has painted goes straight back to six quads
  // the moment the brush is put down.
  const paintMode = useStore(state => state.paintMode);
  const geomEntry = useMemo(
    () => node?.geoms?.find((g: any) => g.name === name),
    [node, name]
  );
  const paintLayer = geomEntry?.paint as PaintLayer | undefined;
  const showPaint = !!nodeId && isPaintable(type, !!node?.isWedge) && (paintMode || !!paintLayer);
  const materialProps = useMemo(() => {
    const [r, g, b] = color ?? [0.8, 0.8, 0.8];
    return {
      color: new THREE.Color(r, g, b),
      emissive: isSelected ? '#3b82f6' : '#000',
      emissiveIntensity: isSelected ? 0.2 : 0,
      // Every geom in the scene funnels through this one memo, so the whole
      // viewport switches to wireframe from a single flag. Note this is the
      // material's own wireframe — every triangle of the tessellation, the
      // diagonals included — which is the point here: it is a view of the mesh
      // the machine sees, not the tidied silhouette CsgGhostOutline draws.
      wireframe,
      // Painted surfaces carry their colour per vertex, and Three multiplies the
      // material's colour into it — so the material goes white and the body's
      // own colour is mixed into the attribute instead. That is what keeps the
      // base colour live: change it in the properties panel and the paint stays
      // exactly where it is, over the new colour.
      ...(showPaint ? { vertexColors: true, color: new THREE.Color(1, 1, 1) } : {}),
      ...(alpha < 1 ? { transparent: true, opacity: alpha, depthWrite: false } : {}),
    };
  }, [color, isSelected, alpha, wireframe, showPaint]);

  // Handlers for physical spring dragging, mapped from Three.js coordinates to MuJoCo coordinate space
  const setOrbitEnabled = useOrbitEnable();
  const dragHandlers = useMemo(() => ({
    onClick: (e: any) => {
      e.stopPropagation();
      // A paint dab is not a selection: swapping the properties panel out from
      // under every body you colour would make a colouring pass unusable.
      if (useStore.getState().paintMode) return;
      setSelectedNodeId(nodeId);
    },
    onPointerDown: (e: any) => {
      if (isPlaying) {
        e.stopPropagation();
        setOrbitEnabled(false);
        useStore.getState().setDraggedNodeId(nodeId);
        useStore.getState().setDragDistance(e.distance);
        
        const pt = e.point;
        // Transform standard Three.js world coordinates (Y-up) to MuJoCo coordinate space (Z-up)
        useStore.getState().setDragTarget({ x: pt.x, y: -pt.z, z: pt.y });
        const canvasEl = e.nativeEvent?.target as HTMLElement;
        if (canvasEl && typeof canvasEl.setPointerCapture === 'function') {
          try {
            canvasEl.setPointerCapture(e.pointerId);
          } catch (err) {}
        }
      }
    },
    onPointerUp: (e: any) => {
      if (useStore.getState().draggedNodeId === nodeId) {
        e.stopPropagation();
        const canvasEl = e.nativeEvent?.target as HTMLElement;
        if (canvasEl && typeof canvasEl.releasePointerCapture === 'function') {
          try {
            canvasEl.releasePointerCapture(e.pointerId);
          } catch (err) {}
        }
        useStore.getState().setDraggedNodeId(null);
        useStore.getState().setDragTarget(null);
        setOrbitEnabled(true);
      }
    },
    onPointerCancel: (e: any) => {
      if (useStore.getState().draggedNodeId === nodeId) {
        e.stopPropagation();
        const canvasEl = e.nativeEvent?.target as HTMLElement;
        if (canvasEl && typeof canvasEl.releasePointerCapture === 'function') {
          try {
            canvasEl.releasePointerCapture(e.pointerId);
          } catch (err) {}
        }
        useStore.getState().setDraggedNodeId(null);
        useStore.getState().setDragTarget(null);
        setOrbitEnabled(true);
      }
    }
  }), [isPlaying, nodeId, name, setSelectedNodeId, setOrbitEnabled]);

  // For dynamic meshes, use body xpos/xmat so renderVertices (centroid-local) align correctly.
  const bodyId = useMemo(() => {
    if (!isDynamic || !model || !mujoco) return -1;
    return mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, nodeId);
  }, [isDynamic, model, mujoco, nodeId]);

  // Compute initial position and rotation from the model/data
  const [initialPos, initialQuat] = useMemo(() => {
    if (!model || !data) return [[0, 0, 0] as [number, number, number], [0, 0, 0, 1] as [number, number, number, number]];
    try {
      // Dynamic meshes: use body xpos/xmat (renderVertices are in body-local space)
      if (isDynamic && bodyId !== -1) {
        const px = data.xpos[bodyId * 3];
        const py = data.xpos[bodyId * 3 + 1];
        const pz = data.xpos[bodyId * 3 + 2];
        const m = data.xmat;
        const offset = bodyId * 9;
        const mat = new THREE.Matrix4().set(
          m[offset], m[offset+1], m[offset+2], 0,
          m[offset+3], m[offset+4], m[offset+5], 0,
          m[offset+6], m[offset+7], m[offset+8], 0,
          0, 0, 0, 1
        );
        const q = new THREE.Quaternion().setFromRotationMatrix(mat);
        return [[px, py, pz] as [number, number, number], [q.x, q.y, q.z, q.w] as [number, number, number, number]];
      }
      if (geomId === -1) return [[0, 0, 0] as [number, number, number], [0, 0, 0, 1] as [number, number, number, number]];
      const ngeom = model.ngeom;
      if (geomId >= ngeom) return [[0, 0, 0] as [number, number, number], [0, 0, 0, 1] as [number, number, number, number]];

      const px = data.geom_xpos[geomId * 3];
      const py = data.geom_xpos[geomId * 3 + 1];
      const pz = data.geom_xpos[geomId * 3 + 2];

      const m = data.geom_xmat;
      const offset = geomId * 9;
      const mat = new THREE.Matrix4().set(
        m[offset],     m[offset + 1], m[offset + 2], 0,
        m[offset + 3], m[offset + 4], m[offset + 5], 0,
        m[offset + 6], m[offset + 7], m[offset + 8], 0,
        0,             0,             0,             1
      );
      const q = new THREE.Quaternion().setFromRotationMatrix(mat);
      return [[px, py, pz] as [number, number, number], [q.x, q.y, q.z, q.w] as [number, number, number, number]];
    } catch (e) {
      return [[0, 0, 0] as [number, number, number], [0, 0, 0, 1] as [number, number, number, number]];
    }
  }, [isDynamic, bodyId, geomId, model, data]);

  useFrame(() => {
    // Safety check: ensure closure model/data match current store active ones
    const activeModel = useStore.getState().model;
    const activeData = useStore.getState().data;
    if (model !== activeModel || data !== activeData) return;

    if ((window as any).DISABLE_USEFRAME) return;
    // Jointless bodies (and bodies under jointless ancestors) can never move —
    // their transform was already set once via initialPos/initialQuat, so
    // skip the per-frame geom_xpos/geom_xmat read + matrix rebuild entirely.
    // A 48-segment curve otherwise costs 48 of these every frame for nothing.
    if (staticBody) return;
    if (type === 'mesh' && !isDynamic) return;
    if (!meshRef.current || !model || !data) return;

    try {
      // Dynamic meshes: track body xpos/xmat (renderVertices are in body-local space)
      if (isDynamic && bodyId !== -1) {
        const px = data.xpos[bodyId * 3];
        const py = data.xpos[bodyId * 3 + 1];
        const pz = data.xpos[bodyId * 3 + 2];
        const m = data.xmat;
        const offset = bodyId * 9;
        rotationMatrix.set(
          m[offset], m[offset+1], m[offset+2], 0,
          m[offset+3], m[offset+4], m[offset+5], 0,
          m[offset+6], m[offset+7], m[offset+8], 0,
          0, 0, 0, 1
        );
        meshRef.current.position.set(px, py, pz);
        meshRef.current.quaternion.setFromRotationMatrix(rotationMatrix);
        return;
      }

      if (geomId === -1) return;
      const ngeom = model.ngeom;
      if (geomId >= ngeom) return;

      const px = data.geom_xpos[geomId * 3];
      const py = data.geom_xpos[geomId * 3 + 1];
      const pz = data.geom_xpos[geomId * 3 + 2];

      const m = data.geom_xmat;
      const offset = geomId * 9;
      rotationMatrix.set(
        m[offset],     m[offset + 1], m[offset + 2], 0,
        m[offset + 3], m[offset + 4], m[offset + 5], 0,
        m[offset + 6], m[offset + 7], m[offset + 8], 0,
        0,             0,             0,             1
      );

      meshRef.current.position.set(px, py, pz);
      meshRef.current.quaternion.setFromRotationMatrix(rotationMatrix);
    } catch (e) {
      // Safely ignore deleted object or transition errors
    }
  });

  // Build Three.js BufferGeometry from inline vertex/face arrays for mesh type
  const meshBufferGeometry = useMemo(() => {
    if (type !== 'mesh' || !vertices || !faces) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vertices), 3));
    geo.setIndex(new THREE.BufferAttribute(new Uint32Array(faces), 1));
    geo.computeVertexNormals();
    return geo;
  }, [type, vertices, faces]);

  // The argument list buildPaintGeometry needs, taken from the geom's own
  // half-extents rather than from geometryArgs — the same rule the MCP bridge
  // paints by, so an agent's dab and a user's stroke land on the same surface.
  const paintArgs = useMemo(() => {
    if (geomId === -1 || !model?.geom_size) return [];
    return paintArgsFromSize(type, [
      model.geom_size[geomId * 3],
      model.geom_size[geomId * 3 + 1],
      model.geom_size[geomId * 3 + 2],
    ]);
  }, [geomId, model, type]);

  // The stored tessellation wins over a freshly computed one. Resizing a
  // painted die rebuilds the box at the new size with the same subdivisions, so
  // vertex N is still the same point on the same face and the pips scale with
  // it instead of being dropped for a length mismatch.
  const paintRes = useMemo(
    () => (paintLayer?.res?.length ? paintLayer.res : paintResolution(type, paintArgs)),
    [paintLayer, type, paintArgs]
  );

  const paintGeometry = useMemo(() => {
    if (!showPaint) return null;
    // A mesh already has vertices of its own, at whatever density it was made
    // or sculpted at; there is nothing to re-tessellate.
    if (type === 'mesh') return meshBufferGeometry;
    if (!paintArgs.length || paintArgs.some((a: number) => a === undefined || isNaN(a))) return null;
    return buildPaintGeometry(type, paintArgs, paintRes);
  }, [showPaint, type, meshBufferGeometry, paintArgs, paintRes]);

  useEffect(() => {
    // Only the geometries built here are ours to free — the mesh branch hands
    // back one it owns and disposes itself.
    if (!paintGeometry || type === 'mesh') return;
    return () => paintGeometry.dispose();
  }, [paintGeometry, type]);

  const { handlers: paintHandlers, cursorRef } = useVertexPaint({
    nodeId,
    name,
    geometry: paintGeometry,
    baseColor: color ?? [0.8, 0.8, 0.8, 1],
    layer: paintLayer,
    res: paintRes,
    enabled: showPaint && paintMode,
    setOrbitEnabled,
    onStrokeStart: beginPaintStroke,
  });

  // The ring showing where the brush will land. Drawn on top of the surface so
  // it stays readable in a hollow that would otherwise occlude it.
  const brushCursor = showPaint && paintMode ? (
    <mesh ref={cursorRef} visible={false} raycast={() => null}>
      <ringGeometry args={[0.9, 1, 48]} />
      <meshBasicMaterial color="#f0abfc" transparent opacity={0.95} side={THREE.DoubleSide} depthTest={false} toneMapped={false} />
    </mesh>
  ) : null;

  if (type === 'mesh') {
    if (!meshBufferGeometry) return null;
    const renderedMaterial = (
      <meshStandardMaterial key={`${alpha < 1 ? 'blend' : 'solid'}:${showPaint}`} {...materialProps} side={THREE.FrontSide} />
    );

    if (isDynamic) {
      return (
        <group name={nodeId} ref={meshRef} position={initialPos} quaternion={new THREE.Quaternion(...initialQuat)}>
          <mesh castShadow receiveShadow geometry={meshBufferGeometry} {...dragHandlers} {...paintHandlers}>
            {renderedMaterial}
            {brushCursor}
          </mesh>
        </group>
      );
    }
    // Static mesh: vertices baked in Three.js world space — no position/rotation applied.
    return (
      <group name={nodeId}>
        <mesh castShadow receiveShadow geometry={meshBufferGeometry} {...dragHandlers} {...paintHandlers}>
          {renderedMaterial}
          {brushCursor}
        </mesh>
      </group>
    );
  }

  if (geomId === -1 || !geometryArgs || geometryArgs.length === 0 || geometryArgs.some(arg => arg === undefined || isNaN(arg))) {
    return null;
  }

  const renderedGeomMaterial = (
    <meshStandardMaterial key={`${alpha < 1 ? 'blend' : 'solid'}:${showPaint}`} {...materialProps} />
  );

  if (paintGeometry) {
    return (
      <group
        name={nodeId}
        ref={meshRef}
        position={initialPos}
        quaternion={new THREE.Quaternion(...initialQuat)}
      >
        <mesh
          castShadow
          receiveShadow
          geometry={paintGeometry}
          // The same orientation and scaling the JSX primitives are given, so
          // that turning the brush on does not move the body a millimetre.
          rotation={type === 'capsule' || type === 'cylinder' ? [Math.PI / 2, 0, 0] : undefined}
          scale={type === 'ellipsoid' ? [geometryArgs[0], geometryArgs[1], geometryArgs[2]] : undefined}
          {...dragHandlers}
          {...paintHandlers}
        >
          {renderedGeomMaterial}
          {brushCursor}
        </mesh>
      </group>
    );
  }

  return (
    <group
      name={nodeId}
      ref={meshRef}
      position={initialPos}
      quaternion={new THREE.Quaternion(...initialQuat)}
    >
      {node?.isWedge ? (
        <mesh castShadow receiveShadow {...dragHandlers}>
          <WedgeGeometry width={node.width || 2.0} depth={node.depth || 1.0} height={node.height || 0.5} />
          {renderedGeomMaterial}
        </mesh>
      ) : type === 'sphere' ? (
        <mesh castShadow receiveShadow {...dragHandlers}>
          <sphereGeometry args={geometryArgs as any} />
          {renderedGeomMaterial}
        </mesh>
      ) : type === 'box' ? (
        <>
          <mesh castShadow receiveShadow {...dragHandlers}>
            <boxGeometry args={geometryArgs as any} />
            {renderedGeomMaterial}
          </mesh>
        </>
      ) : type === 'ellipsoid' ? (
        <mesh castShadow receiveShadow scale={[geometryArgs[0], geometryArgs[1], geometryArgs[2]]} {...dragHandlers}>
          <sphereGeometry args={[1, 32, 32]} />
          {renderedGeomMaterial}
        </mesh>
      ) : null}
      {type === 'capsule' && (
        <mesh castShadow receiveShadow rotation={[Math.PI / 2, 0, 0]} {...dragHandlers}>
          <capsuleGeometry args={geometryArgs as any} />
          {renderedGeomMaterial}
        </mesh>
      )}
      {type === 'cylinder' && (
        <mesh castShadow receiveShadow rotation={[Math.PI / 2, 0, 0]} {...dragHandlers}>
          <cylinderGeometry args={[geometryArgs[0], geometryArgs[0], geometryArgs[1] * 2, 32]} />
          {renderedGeomMaterial}
        </mesh>
      )}
    </group>
  );
};



// Drag interaction controller that handles window-level mouse/pointer movements
export const DragInteractionController = () => {
  const { camera, raycaster, gl } = useThree();
  const setOrbitEnabled = useOrbitEnable();

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const { draggedNodeId, dragDistance } = useStore.getState();
      if (!draggedNodeId) return;

      // Project mouse screen coordinates relative to canvas bounding client rect
      const rect = gl.domElement.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      
      const ndcX = (x / rect.width) * 2 - 1;
      const ndcY = -(y / rect.height) * 2 + 1;

      raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
      
      const targetPt = new THREE.Vector3();
      raycaster.ray.at(dragDistance, targetPt);

      // Transform standard Three.js world coordinates (Y-up) to MuJoCo coordinate space (Z-up)
      useStore.getState().setDragTarget({
        x: targetPt.x,
        y: -targetPt.z,
        z: targetPt.y
      });
    };

    const handlePointerUp = () => {
      const { draggedNodeId } = useStore.getState();
      if (draggedNodeId) {
        useStore.getState().setDraggedNodeId(null);
        useStore.getState().setDragTarget(null);
        // Whoever turned the camera off owes it an on again — a finger lifted
        // outside the body it grabbed comes through here rather than through
        // the geom's own pointerup.
        setOrbitEnabled(true);
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [camera, raycaster, gl, setOrbitEnabled]);

  return null;
};


// Real-time mouse drag physical spring force line renderer
export const MouseDragForceRenderer = ({ model, data, mujoco }: any) => {
  const draggedNodeId = useStore((state) => state.draggedNodeId);
  const dragTarget = useStore((state) => state.dragTarget);
  const lineRef = useRef<any>(null);
  const bodyIdCache = useRef<Record<string, number>>({});
  useEffect(() => {
    if (!model || !mujoco) return;
    const c: Record<string, number> = {};
    for (let b = 0; b < model.nbody; b++) {
      const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_BODY.value, b);
      if (name) c[name] = b;
    }
    const sceneGraph = useStore.getState().sceneGraph;
    const mapIds = (nodes: any[]) => {
      if (!nodes) return;
      for (const n of nodes) {
        const bId = c[n.name] ?? c[n.id];
        if (bId !== undefined) {
          c[n.id] = bId;
          if (n.name) c[n.name] = bId;
        }
        mapIds(n.children);
      }
    };
    mapIds(sceneGraph?.nodes || []);
    bodyIdCache.current = c;
  }, [model, mujoco]);

  useFrame(() => {
    const activeModel = useStore.getState().model;
    const activeData = useStore.getState().data;
    if (model !== activeModel || data !== activeData) return;
    if ((window as any).DISABLE_USEFRAME) return;
    if (!model || !data || !mujoco || !draggedNodeId || !dragTarget || !lineRef.current) return;

    try {
      const bId = bodyIdCache.current[draggedNodeId] ?? -1;
      if (bId === -1) return;

      const px = data.xpos[bId * 3];
      const py = data.xpos[bId * 3 + 1];
      const pz = data.xpos[bId * 3 + 2];

      // Parent group has rotation={[-Math.PI / 2, 0, 0]} which converts MuJoCo Z-up space to Three.js Y-up.
      // Inside this group, local coordinates ARE MuJoCo Z-up (x, y, z).
      const points = [
        new THREE.Vector3(px, py, pz),
        new THREE.Vector3(dragTarget.x, dragTarget.y, dragTarget.z)
      ];
      lineRef.current.geometry.setFromPoints(points);
    } catch (e) {
      // Safe check
    }
  });

  if (!draggedNodeId || !dragTarget) return null;

  return (
    <line ref={lineRef}>
      <bufferGeometry />
      <lineBasicMaterial color="#f43f5e" linewidth={4} transparent opacity={0.9} />
    </line>
  );
};



export const SceneCapture = ({ sceneRef }: { sceneRef: React.MutableRefObject<THREE.Scene | null> }) => {
  const { scene } = useThree();
  useEffect(() => { sceneRef.current = scene; }, [scene, sceneRef]);
  return null;
};

// Draggable control-point handles + spline preview for the selected curve
// body. Rendered INSIDE the Z-up→Y-up rotated group, so all positions here are
// raw MuJoCo Z-up coords. Left-drag is free for handle dragging because
// OrbitControls maps LEFT to a no-op in this app — a single *touch*, though,
// is the orbit gesture, so the drag has to switch the controls off for its
// duration or the camera swings while the point is being placed.
export const CurveControlHandles = () => {
  const sceneGraph = useStore(s => s.sceneGraph);
  const selectedNodeId = useStore(s => s.selectedNodeId);
  const isPlaying = useStore(s => s.isPlaying);
  const updateCurveParams = useStore(s => s.updateCurveParams);
  const { camera } = useThree();
  const setOrbitEnabled = useOrbitEnable();
  const coarsePointer = useCoarsePointer();
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const dragPlane = useRef(new THREE.Plane());

  // Find the selected curve node and its accumulated world offset (curve
  // bodies are static, so parent offsets are pure translations).
  const found = useMemo(() => {
    let result: { node: any; world: number[] } | null = null;
    const walk = (nodes: any[], base: number[]) => {
      if (!nodes || result) return;
      for (const n of nodes) {
        const world = [base[0] + (n.pos?.[0] || 0), base[1] + (n.pos?.[1] || 0), base[2] + (n.pos?.[2] || 0)];
        if (n.id === selectedNodeId && n.isCurve) { result = { node: n, world }; return; }
        walk(n.children, world);
        if (result) return;
      }
    };
    walk(sceneGraph?.nodes, [0, 0, 0]);
    return result as { node: any; world: number[] } | null;
  }, [sceneGraph, selectedNodeId]);

  const splineLine = useMemo(() => {
    if (!found) return null;
    const closed = found.node.curveClosed === true;
    const pts = sampleCatmullRom(found.node.curvePoints || [], 120, closed);
    const arr = pts.map((p: number[]) => new THREE.Vector3(found.world[0] + p[0], found.world[1] + p[1], found.world[2] + p[2]));
    if (closed && arr.length) arr.push(arr[0].clone());
    const geo = new THREE.BufferGeometry().setFromPoints(arr);
    const mat = new THREE.LineBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.8, depthTest: false });
    return new THREE.Line(geo, mat);
  }, [found]);

  if (!found || isPlaying) return null;
  const pts: number[][] = found.node.curvePoints || [];

  const toWorldMj = (p: number[]) => [found.world[0] + p[0], found.world[1] + p[1], found.world[2] + p[2]];

  const startDrag = (i: number, e: any) => {
    e.stopPropagation();
    setOrbitEnabled(false);
    try { (e.target as HTMLElement).setPointerCapture(e.pointerId); } catch (err) {}
    // Camera-facing drag plane through the handle (in Three.js world space:
    // MuJoCo (x,y,z) → three (x, z, -y))
    const w = toWorldMj(pts[i]);
    const p3 = new THREE.Vector3(w[0], w[2], -w[1]);
    const normal = new THREE.Vector3();
    camera.getWorldDirection(normal);
    dragPlane.current.setFromNormalAndCoplanarPoint(normal, p3);
    setDragIdx(i);
  };

  const moveDrag = (e: any) => {
    if (dragIdx === null) return;
    e.stopPropagation();
    const hit = new THREE.Vector3();
    if (!e.ray.intersectPlane(dragPlane.current, hit)) return;
    // three world → MuJoCo: (x, y, z) → (x, -z, y)
    const local = [
      Math.round((hit.x - found.world[0]) * 1000) / 1000,
      Math.round((-hit.z - found.world[1]) * 1000) / 1000,
      Math.round((hit.y - found.world[2]) * 1000) / 1000,
    ];
    const newPts = pts.map(p => [...p]);
    newPts[dragIdx] = local;
    updateCurveParams(found.node.id, { points: newPts });
  };

  const endDrag = (e: any) => {
    if (dragIdx === null) return;
    e.stopPropagation();
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch (err) {}
    setDragIdx(null);
    setOrbitEnabled(true);
  };

  return (
    <group>
      {splineLine && <primitive object={splineLine} />}
      {pts.map((p, i) => {
        const w = toWorldMj(p);
        const active = dragIdx === i || hoverIdx === i;
        return (
          <mesh
            key={i}
            position={[w[0], w[1], w[2]]}
            onPointerDown={(e) => startDrag(i, e)}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerOver={(e) => { e.stopPropagation(); setHoverIdx(i); }}
            onPointerOut={() => setHoverIdx(h => (h === i ? null : h))}
          >
            {/* A control point sized for a cursor is smaller than the
                fingertip trying to grab it, so touch gets a bigger sphere. */}
            <sphereGeometry args={[(active ? 0.08 : 0.06) * (coarsePointer ? 1.8 : 1), 16, 16]} />
            <meshBasicMaterial color={dragIdx === i ? '#f59e0b' : '#3b82f6'} depthTest={false} transparent opacity={0.9} />
          </mesh>
        );
      })}
    </group>
  );
};

// All static (jointless, under jointless ancestors) box geoms drawn as ONE
// InstancedMesh: one draw call instead of one mesh+material per segment. This
// is the common repeated-primitive case — curve tracks (28-48 boxes each),
// bridges, scenery. Transforms are read from MuJoCo once per model build, not
// per frame. Clicking an instance selects its owning body; the selected
// body's boxes drop back to individual DynamicGeoms so the highlight and
// per-geom selection still work.
export const StaticBoxInstances = ({ geoms, model, data, mujoco, setSelectedNodeId }: any) => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const nodeIdByInstance = useMemo(() => geoms.map((g: any) => g.nodeId), [geoms]);
  const wireframe = useStore(state => state.wireframe);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh || !model || !data || !mujoco) return;
    const mat = new THREE.Matrix4();
    const scale = new THREE.Matrix4();
    const color = new THREE.Color();
    geoms.forEach((g: any, idx: number) => {
      const gid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_GEOM.value, g.name);
      if (gid === -1 || gid >= model.ngeom) {
        mesh.setMatrixAt(idx, mat.makeScale(0, 0, 0));
        return;
      }
      const m = data.geom_xmat;
      const o = gid * 9;
      mat.set(
        m[o],     m[o + 1], m[o + 2], data.geom_xpos[gid * 3],
        m[o + 3], m[o + 4], m[o + 5], data.geom_xpos[gid * 3 + 1],
        m[o + 6], m[o + 7], m[o + 8], data.geom_xpos[gid * 3 + 2],
        0, 0, 0, 1
      );
      const so = gid * 3;
      mat.multiply(scale.makeScale(model.geom_size[so] * 2, model.geom_size[so + 1] * 2, model.geom_size[so + 2] * 2));
      mesh.setMatrixAt(idx, mat);
      const c = g.rgba || [0.8, 0.8, 0.8, 1];
      mesh.setColorAt(idx, color.setRGB(c[0], c[1], c[2]));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [geoms, model, data, mujoco]);

  if (geoms.length === 0) return null;
  return (
    <instancedMesh
      key={geoms.length}
      ref={meshRef}
      args={[undefined, undefined, geoms.length]}
      castShadow
      receiveShadow
      onClick={(e: any) => {
        e.stopPropagation();
        if (useStore.getState().paintMode) return;
        const nid = nodeIdByInstance[e.instanceId];
        if (nid) setSelectedNodeId(nid);
      }}
    >
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial wireframe={wireframe} />
    </instancedMesh>
  );
};


/** Depth-first lookup by id, for the renderer's own use. */
const findSceneNode = (nodes: any[], id: string): any | null => {
  for (const node of nodes || []) {
    if (node.id === id) return node;
    const found = findSceneNode(node.children, id);
    if (found) return found;
  }
  return null;
};

export const SceneVisuals = ({ model, data, mujoco, sceneGraph, selectedNodeId, setSelectedNodeId, activeWeakSpot, setActiveWeakSpot }: any) => {
  // Every geom name the scene graph accounts for, drawn or not. The implicit-geom
  // pass below uses this — NOT the render list — to decide what in the MuJoCo
  // model is unexplained. A collision-only geom (a boolean body's source
  // primitives, in 'primitives' mode) is deliberately not rendered, and treating
  // it as unexplained would draw the solid ellipsoid right over the mesh whose
  // hole is the entire point.
  const knownGeomNames = useMemo(() => {
    const names = new Set<string>();
    const walk = (nodes: any[]) => {
      for (const node of nodes || []) {
        for (const g of node.geoms || []) if (g.name) names.add(g.name);
        walk(node.children);
      }
    };
    walk(sceneGraph?.nodes || []);
    return names;
  }, [sceneGraph]);

  // Subscribed rather than read once: entering and leaving the sculpt tools has
  // to swap which renderer draws the body.
  const sculptNodeId = useStore((state) => state.sculptNodeId);
  // Static boxes are drawn as one InstancedMesh, which shares a single geometry
  // between every box in it — there is nowhere for one box's paint to live. So
  // they come out of the instancing while the brush is out, and stay out for
  // good once they carry paint.
  const paintMode = useStore((state) => state.paintMode);

  const geoms = useMemo(() => {
    if (!sceneGraph) return [];
    const list: any[] = [];
    const traverse = (nodes: any[], ancestorJointed: boolean) => {
      if (!nodes) return;
      for (const node of nodes) {
        const jointed = ancestorJointed || (node.joints && node.joints.length > 0) || node.isComposite === true;
        if (node.geoms) {
          // Boolean bodies draw their generated mesh instead of the primitives it
          // was cut from, and never draw the negatives (those are ghosts, below).
          for (const geom of resolveCsgGeoms(node, 'render')) {
            // isWedge bodies draw a bespoke triangular prism via WedgeGeometry.
            // Their MJCF geom is only a thin slab along the slanted face, so they
            // must never fall through to a generic box renderer.
            list.push({ nodeId: node.id, staticBody: !jointed, customRender: !!node.isWedge, ...geom });
          }
        }
        traverse(node.children, jointed);
      }
    };
    traverse(sceneGraph.nodes, false);
    return list;
  }, [sceneGraph]);

  if (!model || !data || !mujoco) return null;

  const allPrimitiveGeoms = geoms.filter(g => g.type !== 'mesh');
  // Static boxes not on the selected body render as one InstancedMesh.
  const instancedBoxGeoms = paintMode
    ? []
    : allPrimitiveGeoms.filter(g => g.type === 'box' && g.staticBody && !g.customRender && g.nodeId !== selectedNodeId && !g.paint);
  const instancedNames = new Set(instancedBoxGeoms.map(g => g.name));
  const primitiveGeoms = allPrimitiveGeoms.filter(g => !instancedNames.has(g.name));
  // The body under the sculpt tools is drawn by SculptSurface, which owns the
  // live mesh mid-stroke; the ordinary renderer would draw the last committed
  // stroke right through it.
  const sculptGeom = sculptNodeId ? geoms.find(g => g.type === 'mesh' && g.nodeId === sculptNodeId) : undefined;
  // Picking a different base replaces the mesh wholesale, so the sculpting
  // surface has to be remounted rather than left holding the old one.
  const sculptVersion = sculptNodeId ? (findSceneNode(sceneGraph?.nodes ?? [], sculptNodeId)?.sculptVersion ?? 1) : 1;
  const staticMeshGeoms = geoms.filter(g => g.type === 'mesh' && !g.dynamic && g !== sculptGeom);
  const dynamicMeshGeoms = geoms.filter(g => g.type === 'mesh' && g.dynamic && g !== sculptGeom);

  const implicitGeoms = useMemo(() => {
    if (!model || !mujoco || !model.geom_type) return [];
    const list: any[] = [];
    const ngeom = model.ngeom;
    for (let i = 0; i < ngeom; i++) {
      const name = mujoco.mj_id2name(model, mujoco.mjtObj.mjOBJ_GEOM.value, i);
      if (name && !knownGeomNames.has(name) && name !== 'floor') {
        const typeId = model.geom_type[i];
        let typeStr = 'sphere';
        if (typeId === 2) typeStr = 'sphere';
        else if (typeId === 3) typeStr = 'capsule';
        else if (typeId === 4) typeStr = 'ellipsoid';
        else if (typeId === 5) typeStr = 'cylinder';
        else if (typeId === 6) typeStr = 'box';
        else if (typeId === 7) typeStr = 'mesh';
        
        const offset = i * 4;
        const color = model.geom_rgba 
          ? Array.from(model.geom_rgba.slice(offset, offset + 4)) 
          : [0.6, 0.4, 0.8, 1];

        list.push({
          providedGeomId: i,
          name,
          type: typeStr,
          rgba: color,
        });
      }
    }
    return list;
  }, [model, mujoco, knownGeomNames]);

  return (
    <>
      {/* Primitive geoms and dynamic meshes live in a Z-up→Y-up rotated group */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        {primitiveGeoms.map(g => (
          <DynamicGeom
            key={g.name}
            nodeId={g.nodeId}
            name={g.name}
            type={g.type}
            color={g.rgba || [0.8,0.8,0.8,1]}
            mujoco={mujoco}
            model={model}
            data={data}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
            staticBody={g.staticBody}
          />
        ))}
        <StaticBoxInstances geoms={instancedBoxGeoms} model={model} data={data} mujoco={mujoco} setSelectedNodeId={setSelectedNodeId} />
        {implicitGeoms.map(g => (
          <DynamicGeom
            key={g.name}
            providedGeomId={g.providedGeomId}
            name={g.name}
            type={g.type}
            color={g.rgba}
            mujoco={mujoco}
            model={model}
            data={data}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
          />
        ))}
        {dynamicMeshGeoms.map(g => (
          <DynamicGeom
            key={g.name}
            nodeId={g.nodeId}
            name={g.name}
            type={g.type}
            color={g.rgba || [0.8,0.8,0.8,1]}
            mujoco={mujoco}
            model={model}
            data={data}
            selectedNodeId={selectedNodeId}
            setSelectedNodeId={setSelectedNodeId}
            vertices={g.renderVertices}
            faces={g.faces}
            dynamic={true}
            staticBody={g.staticBody}
          />
        ))}
        {sculptGeom && (
          <SculptSurface
            key={`${sculptGeom.nodeId}:${sculptVersion}`}
            nodeId={sculptGeom.nodeId}
            geomName={sculptGeom.name}
            color={sculptGeom.rgba || [0.82, 0.72, 0.62, 1]}
            mujoco={mujoco}
            model={model}
            data={data}
            renderVertices={sculptGeom.renderVertices || []}
            faces={sculptGeom.faces || []}
          />
        )}
        <PulleyRopesRenderer model={model} data={data} mujoco={mujoco} sceneGraph={sceneGraph} />
        <CsgNegativeGhosts model={model} data={data} mujoco={mujoco} sceneGraph={sceneGraph} selectedNodeId={selectedNodeId} />
        <MouseDragForceRenderer model={model} data={data} mujoco={mujoco} />
        <CurveControlHandles />
        <PrintAnalysisOverlay activeSpotId={activeWeakSpot?.id} onSelectSpot={setActiveWeakSpot} />
      </group>
      {/* Static mesh geoms: vertices already in Three.js Y-up space, no rotation needed */}
      {staticMeshGeoms.map(g => (
        <DynamicGeom
          key={g.name}
          nodeId={g.nodeId}
          name={g.name}
          type={g.type}
          color={g.rgba || [0.8,0.8,0.8,1]}
          mujoco={mujoco}
          model={model}
          data={data}
          selectedNodeId={selectedNodeId}
          setSelectedNodeId={setSelectedNodeId}
          vertices={g.vertices}
          faces={g.faces}
        />
      ))}
    </>
  );
};
