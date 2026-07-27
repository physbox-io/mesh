import { create } from 'zustand';
import type { SceneGraph, SceneNode, CsgOp } from '../types/scene';
import { type CsgResult, CSG_DEFAULT_SECTORS } from '../utils/csg';
import { compileToMJCF } from '../utils/mjcf';
import { PRESETS, pendulumPreset, generateGearGeoms } from '../presets/presetScenes';
import { PhysicsWorkerClient, type BuiltResult, type FrameSnapshot } from './physicsWorkerClient';
import { generatePyramidMeshData, generateConeMeshData, generateTorusMeshData, generateTubeMeshData, generateCurveGeoms, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS } from '../utils/geom';

const initialScene: SceneGraph = pendulumPreset;

// The live MuJoCo module/model/data now live inside a dedicated Worker (see
// src/workers/physicsWorker.ts) so that on unrecoverable WASM memory
// exhaustion the worker can be terminated and a fresh one spawned — a real
// memory reclaim, since a Worker is a separate JS realm, unlike reinstantiating
// a WASM module in place on the main thread (which doesn't reliably return
// abandoned linear memory to the OS). `mujoco`/`model`/`data` in the store are
// now plain-JS mirrors kept in sync via postMessage, not live WASM objects —
// this shim preserves the exact field names/shapes the rest of the app
// (DynamicGeom, PulleyRopesRenderer, MouseDragForceRenderer, getSyncedSceneGraph,
// etc.) already reads, so those call sites need no changes.
const MUJOCO_SHIM = {
  mjtObj: {
    mjOBJ_BODY: { value: 'body' },
    mjOBJ_JOINT: { value: 'joint' },
    mjOBJ_GEOM: { value: 'geom' },
    mjOBJ_ACTUATOR: { value: 'actuator' },
  },
  mj_name2id: (model: any, typeVal: string, name: string) => model?._idMaps?.[typeVal]?.[name] ?? -1,
  mj_id2name: (model: any, typeVal: string, id: number) => model?._idMaps?.[`${typeVal}Rev`]?.[id] ?? null,
  // Nothing on the main thread should call these directly anymore — the worker
  // owns stepping/forward-kinematics. Kept as safe no-ops in case of a stray call.
  mj_step: () => {},
  mj_forward: () => {},
};

const buildModelMirror = (built: BuiltResult) => ({
  nq: built.nq, nv: built.nv, nu: built.nu, ngeom: built.ngeom, nbody: built.nbody,
  opt: { timestep: built.timestep },
  geom_size: built.geom_size,
  geom_type: built.geom_type,
  geom_rgba: built.geom_rgba,
  body_mass: built.body_mass,
  body_inertia: built.body_inertia,
  body_dofnum: built.body_dofnum,
  body_parentid: built.body_parentid,
  jnt_qposadr: built.jnt_qposadr,
  jnt_dofadr: built.jnt_dofadr,
  _idMaps: built.idMaps,
});

// A stable object whose typed-array contents get mutated in place on every
// FRAME message (see getPhysicsWorkerClient below) rather than replaced —
// existing per-frame readers (DynamicGeom etc.) already fetch `data` via
// `useStore.getState().data` inside useFrame (not a reactive selector), so
// mutating in place keeps the exact same performance characteristics as the
// original live-WASM-view approach: no React re-render on every physics tick.
const buildDataMirror = (built: BuiltResult | FrameSnapshot) => ({
  time: built.time,
  qpos: built.qpos!, qvel: built.qvel!, ctrl: built.ctrl!,
  xfrc_applied: built.xfrc_applied!, qfrc_applied: built.qfrc_applied!,
  xpos: built.xpos!, xmat: built.xmat!, cvel: built.cvel!,
  geom_xpos: built.geom_xpos!, geom_xmat: built.geom_xmat!,
});

// Proactive recycling: WASM linear memory only ever grows within a worker's
// lifetime, and heavy scenes (many dynamic SCAD/mesh bodies) can eat through
// the 2^31-byte ceiling in surprisingly few rebuilds. Rather than wait for a
// hard "enlarge memory" failure, swap in a fresh worker on a schedule so
// exhaustion is never actually reached during normal use — the same
// terminate+respawn mechanism as the reactive recovery path, just run
// preemptively. Any respawn (proactive or reactive) resets this counter.
const RECYCLE_EVERY_N_BUILDS = 4;
let buildsSinceRecycle = 0;

let physicsWorkerClientSingleton: PhysicsWorkerClient | null = null;
const recycleWorker = () => {
  physicsWorkerClientSingleton?.terminate();
  physicsWorkerClientSingleton = null;
  buildsSinceRecycle = 0;
};
export const getPhysicsWorkerClient = (): PhysicsWorkerClient => {
  if (!physicsWorkerClientSingleton) {
    const client = new PhysicsWorkerClient();
    client.onFrame = (snap) => {
      const data = useStore.getState().data;
      if (data) {
        data.time = snap.time;
        if (!snap.isShared && snap.qpos && snap.qvel && snap.ctrl && snap.xfrc_applied && snap.qfrc_applied && snap.xpos && snap.xmat && snap.cvel && snap.geom_xpos && snap.geom_xmat) {
          data.qpos.set(snap.qpos); data.qvel.set(snap.qvel); data.ctrl.set(snap.ctrl);
          data.xfrc_applied.set(snap.xfrc_applied); data.qfrc_applied.set(snap.qfrc_applied);
          data.xpos.set(snap.xpos); data.xmat.set(snap.xmat); data.cvel.set(snap.cvel);
          data.geom_xpos.set(snap.geom_xpos); data.geom_xmat.set(snap.geom_xmat);
        }
      }
    };
    client.onError = (message, fatal, lastState) => {
      console.error('[PhysicsWorker]', message);
      if (fatal) {
        useStore.getState().recoverFromFatalWorkerError(message, lastState);
      } else {
        useStore.setState({ isPlaying: false, lastCompileError: message });
      }
    };
    physicsWorkerClientSingleton = client;
  }
  return physicsWorkerClientSingleton;
};

// Returns true if every geom on a node is a mesh (so pos/euler are meaningless for rendering)
const isAllMeshNode = (node: any) =>
  node.geoms?.length > 0 && node.geoms.every((g: any) => g.type === 'mesh');

const isDynamicMesh = (g: any) => g.type === 'mesh' && g.dynamic && g.renderVertices;
const isStaticMesh  = (g: any) => g.type === 'mesh' && !g.dynamic && g.vertices;

// Apply a function to flat vertex array in-place
const mapVerts = (v: number[], fn: (x: number, y: number, z: number) => [number,number,number]) => {
  for (let i = 0; i < v.length; i += 3) {
    const [nx, ny, nz] = fn(v[i], v[i+1], v[i+2]);
    v[i] = nx; v[i+1] = ny; v[i+2] = nz;
  }
  return v;
};

// Translate static mesh geom vertices (Y-up world space)
const translateMeshGeoms = (node: any, dx: number, dy: number, dz: number) => {
  for (const g of node.geoms) {
    if (isStaticMesh(g)) {
      g.vertices = mapVerts([...g.vertices], (x,y,z) => [x+dx, y+dy, z+dz]);
    }
    // Dynamic meshes are positioned via body pos — no vertex transform needed
  }
};

// Rotate static mesh geom vertices around axis (degrees) about their centroid
// Dynamic mesh renderVertices are centroid-local — rotate them directly around origin
const rotateMeshGeoms = (node: any, axis: 0 | 1 | 2, deltaDeg: number) => {
  const rad = (deltaDeg * Math.PI) / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);

  const rotateAboutOrigin = (v: number[]) => mapVerts(v, (x, y, z) => {
    if (axis === 0) return [x,  y*cos - z*sin,  y*sin + z*cos];
    if (axis === 1) return [x*cos + z*sin,  y,  -x*sin + z*cos];
    return [x*cos - y*sin,  x*sin + y*cos,  z];
  });

  for (const g of node.geoms) {
    if (isStaticMesh(g)) {
      const v = [...g.vertices] as number[];
      let cx = 0, cy = 0, cz = 0;
      const n = v.length / 3;
      for (let i = 0; i < v.length; i += 3) { cx += v[i]; cy += v[i+1]; cz += v[i+2]; }
      cx /= n; cy /= n; cz /= n;
      // Translate to origin, rotate, translate back
      const centred = mapVerts([...v], (x,y,z) => [x-cx, y-cy, z-cz]);
      const rotated = rotateAboutOrigin(centred);
      g.vertices = mapVerts(rotated, (x,y,z) => [x+cx, y+cy, z+cz]);
    }
    if (isDynamicMesh(g)) {
      // renderVertices are already centroid-local — rotate directly
      // Note: renderVertices are Z-up (MuJoCo space), so axis mapping is different:
      // UI axis 0=X, 1=Y(up in Three.js = Z in MuJoCo), 2=Z(depth in Three.js = -Y in MuJoCo)
      const mujocoAxis = axis === 1 ? 2 : axis === 2 ? 1 : 0;
      const v = [...g.renderVertices] as number[];
      const rotateZup = mapVerts(v, (x, y, z) => {
        if (mujocoAxis === 0) return [x,  y*cos - z*sin,  y*sin + z*cos];
        if (mujocoAxis === 1) return [x*cos + z*sin,  y,  -x*sin + z*cos];
        return [x*cos - y*sin,  x*sin + y*cos,  z];
      });
      g.renderVertices = rotateZup;
    }
  }
};

// Scale mesh geoms about their centroid (uniformly or per-axis)
export const scaleMeshGeoms = (node: any, sx: number, sy: number = sx, sz: number = sx) => {
  for (const g of node.geoms) {
    if (isStaticMesh(g)) {
      const v = [...g.vertices] as number[];
      let cx = 0, cy = 0, cz = 0;
      const n = v.length / 3;
      for (let i = 0; i < v.length; i += 3) { cx += v[i]; cy += v[i+1]; cz += v[i+2]; }
      cx /= n; cy /= n; cz /= n;
      g.vertices = mapVerts(v, (x,y,z) => [cx+(x-cx)*sx, cy+(y-cy)*sy, cz+(z-cz)*sz]);
    }
    if (isDynamicMesh(g)) {
      // renderVertices are raw Z-up — scale about origin
      g.renderVertices = mapVerts([...g.renderVertices], (x,y,z) => [x*sx, y*sy, z*sz]);
      // Also scale the MuJoCo collision vertices (Y-up world space) about their centroid
      if (g.vertices) {
        const v = [...g.vertices] as number[];
        let cx = 0, cy = 0, cz = 0;
        const n = v.length / 3;
        for (let i = 0; i < v.length; i += 3) { cx += v[i]; cy += v[i+1]; cz += v[i+2]; }
        cx /= n; cy /= n; cz /= n;
        g.vertices = mapVerts(v, (x,y,z) => [cx+(x-cx)*sx, cy+(y-cy)*sy, cz+(z-cz)*sz]);
      }
    }
  }
};

// Structural clone of a scene graph that SHARES the large mesh arrays
// (vertices/faces/renderVertices) by reference instead of copying them.
// Every code path that changes mesh data replaces these arrays wholesale
// (scaleMeshGeoms, update*Params, scad compile) rather than mutating them in
// place, so sharing is safe — and it turns per-edit cloning from O(mesh bytes)
// into O(node count). This matters: the old JSON.parse(JSON.stringify(...))
// ran on every slider tick / handle drag and every undo snapshot, copying
// potentially megabytes of SCAD mesh data each time.
const cloneGeom = (g: any): any => {
  const { vertices, faces, renderVertices, ...rest } = g;
  const out: any = JSON.parse(JSON.stringify(rest));
  if (vertices !== undefined) out.vertices = vertices;
  if (faces !== undefined) out.faces = faces;
  if (renderVertices !== undefined) out.renderVertices = renderVertices;
  return out;
};

const cloneNode = (n: any): any => {
  const { geoms, children, ...rest } = n;
  const out: any = JSON.parse(JSON.stringify(rest));
  out.geoms = (geoms || []).map(cloneGeom);
  out.children = (children || []).map(cloneNode);
  return out;
};

export const cloneSceneGraph = (sg: SceneGraph): SceneGraph => ({
  ...sg,
  nodes: (sg.nodes || []).map(cloneNode),
});

const getNodeWorldPos = (nodes: any[], targetId: string, currentOffset: [number, number, number] = [0, 0, 0]): [number, number, number] | null => {
  for (const node of nodes) {
    const nodeWorld: [number, number, number] = [
      currentOffset[0] + node.pos[0],
      currentOffset[1] + node.pos[1],
      currentOffset[2] + node.pos[2]
    ];
    if (node.id === targetId) return nodeWorld;
    if (node.children) {
      const childResult = getNodeWorldPos(node.children, targetId, nodeWorld);
      if (childResult) return childResult;
    }
  }
  return null;
};

const findNode = (nodes: any[], id: string): any | null => {
  for (const node of nodes || []) {
    if (node.id === id || node.name === id) return node;
    const child = findNode(node.children, id);
    if (child) return child;
  }
  return null;
};

const addChildNode = (nodes: any[], parentId: string, newNode: any): boolean => {
  for (const node of nodes) {
    if (node.id === parentId) {
      if (!node.children) node.children = [];
      node.children.push(newNode);
      return true;
    }
    if (node.children && addChildNode(node.children, parentId, newNode)) {
      return true;
    }
  }
  return false;
};

export interface UndoRedoState {
  sceneGraph: SceneGraph;
  gravityZ: number;
  windX: number;
  windY: number;
  density: number;
  floorFriction: number;
  floorBounce: number;
  selectedNodeId: string | null;
}

export interface PhysicsState {
  mujoco: any;
  model: any;
  data: any;
  
  // History State
  undoStack: UndoRedoState[];
  redoStack: UndoRedoState[];
  tempUndoState: UndoRedoState | null;
  historyDebounceTimer: any | null;
  lastInteractionType: string | null;

  // History Actions
  undo: () => void;
  redo: () => void;
  recordInteraction: (type: string) => void;
  flushPendingUndo: () => void;
  prepareForDiscreteChange: () => void;
  
  isPlaying: boolean;
  isLoaded: boolean;
  lastCompileError: string | null;
  isSettingsOpen: boolean;
  cameraView: 'perspective' | 'topDown';
  // When set, CameraController points the camera at this explicit pose instead
  // of the cameraView preset. Position/target are in MuJoCo world space (same
  // convention as every other pos field in the app) — CameraController converts
  // to Three.js space itself. Set by the MCP SET_CAMERA bridge command so an
  // agent can frame a specific body without guessing preset rotations.
  cameraOverride: { position: [number, number, number]; target: [number, number, number] } | null;
  mcpActiveCount: number;
  scadCompileCount: number;
  
  // Environment
  gravityZ: number;
  windX: number;
  windY: number;
  density: number;
  floorFriction: number;
  floorBounce: number;
  
  // Scene
  sceneGraph: SceneGraph;
  selectedNodeId: string | null;
  recompileId: number;
  parentUnderSelected: boolean;
  activePreset: string;
  
  draggedNodeId: string | null;
  dragTarget: { x: number; y: number; z: number } | null;
  dragDistance: number;
  
  // Actions
  togglePlay: () => void;
  setLoaded: (loaded: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setCameraView: (view: 'perspective' | 'topDown') => void;
  setCameraOverride: (override: { position: [number, number, number]; target: [number, number, number] } | null) => void;
  setEnvironment: (env: Partial<{gravityZ: number, windX: number, windY: number, density: number, floorFriction: number, floorBounce: number}>) => void;
  
  setSelectedNodeId: (id: string | null) => void;
  updateScene: (sceneGraph: SceneGraph, skipRecompile?: boolean) => void;
  updateNodePos: (id: string, newPos: [number, number, number]) => void;
  updateNodeGeom: (id: string, updates: any, geomIndex?: number) => void;
  updateNodeJoint: (id: string, updates: any) => void;
  updateGearTeeth: (id: string, teeth: number) => void;
  updateNodeRotation: (id: string, axis: 0 | 1 | 2, deg: number) => void;
  updateNodeScript: (id: string, script: string) => void;
  updateNode: (id: string, updates: Partial<SceneNode>) => void;

  renameNode: (id: string, newName: string) => void;
  updateNodeJointsList: (id: string, joints: any[]) => void;
  deleteNode: (id: string) => void;
  addPusherPeg: (gearId: string) => void;
  deletePusherPeg: (gearId: string) => void;
  updatePusherPeg: (gearId: string, updates: { offset?: number, size?: [number, number] }) => void;
  
  setDraggedNodeId: (id: string | null) => void;
  setDragTarget: (target: { x: number; y: number; z: number } | null) => void;
  setDragDistance: (distance: number) => void;
  updateWedgeParams: (id: string, params: { width?: number; depth?: number; height?: number; wedgeAngle?: number }) => void;
  updatePyramidParams: (id: string, params: { width?: number; depth?: number; height?: number }) => void;
  updateConeParams: (id: string, params: { radius?: number; height?: number }) => void;
  updateTorusParams: (id: string, params: { majorRadius?: number; tubeRadius?: number }) => void;
  updateTubeParams: (id: string, params: { innerRadius?: number; outerRadius?: number; height?: number }) => void;
  updateCurveParams: (id: string, params: { points?: number[][]; width?: number; thickness?: number; segments?: number; closed?: boolean; bank?: number }) => void;
  updatePulleyParams: (id: string, params: { leftTargetId?: string; rightTargetId?: string; pulleyRadius?: number }) => void;
  updateRopeParams: (id: string, params: { pulleyWheelId?: string; leftTargetId?: string; rightTargetId?: string }) => void;
  updateNodeComposite: (id: string, params: Partial<any>) => void;
  
  setParentUnderSelected: (val: boolean) => void;
  addComponent: (type: 'box' | 'sphere' | 'capsule' | 'cylinder' | 'bob' | 'gear' | 'wedge' | 'pulley_wheel' | 'pulley_rope' | 'mesh' | 'openscad' | 'pyramid' | 'cone' | 'torus' | 'tube' | 'ellipsoid' | 'curve' | 'ring', position: number[]) => void;
  updateNodeScad: (id: string, scadCode: string, compiledData: { vertices: number[], faces: number[], renderVertices: number[] }, skipRecompile?: boolean) => void;
  // --- CSG (boolean modifiers) ---
  deleteNodeGeom: (nodeId: string, geomIndex: number) => void;
  setGeomCsgOp: (nodeId: string, geomIndex: number, csg: CsgOp) => void;
  applyNodeCsg: (nodeId: string, result: CsgResult, skipRecompile?: boolean) => void;
  setNodeCsgError: (nodeId: string, error: string | null, hash?: string) => void;
  recompile: (overrideScene?: SceneGraph, overrideSelectedId?: string | null, forceReset?: boolean, keepPreset?: boolean) => Promise<void>;
  loadPreset: (name: string) => void;
  resetSimulation: () => void;
  recoverFromFatalWorkerError: (message: string, lastState?: { qpos: number[]; qvel: number[]; time: number }) => Promise<void>;
  recycleWorkerSeamlessly: () => Promise<void>;
  incrementMcpActive: () => void;
  decrementMcpActive: () => void;
  incrementScadCompile: () => void;
  decrementScadCompile: () => void;
}
export const useStore = create<PhysicsState>()((set, get) => ({
  mujoco: null,
  model: null,
  data: null,
  recompileId: 0,

  // History State
  undoStack: [],
  redoStack: [],
  tempUndoState: null,
  historyDebounceTimer: null,
  lastInteractionType: null,

  // History Actions
  recordInteraction: (type: string) => {
    const state = get();
    if (state.lastInteractionType && state.lastInteractionType !== type) {
      state.flushPendingUndo();
    }

    if (!get().tempUndoState) {
      const snapshot: UndoRedoState = {
        sceneGraph: cloneSceneGraph(get().sceneGraph),
        gravityZ: get().gravityZ,
        windX: get().windX,
        windY: get().windY,
        density: get().density,
        floorFriction: get().floorFriction,
        floorBounce: get().floorBounce,
        selectedNodeId: get().selectedNodeId
      };
      set({
        tempUndoState: snapshot,
        lastInteractionType: type
      });
    }

    if (get().historyDebounceTimer) {
      clearTimeout(get().historyDebounceTimer);
    }

    const timer = setTimeout(() => {
      get().flushPendingUndo();
    }, 800);

    set({ historyDebounceTimer: timer });
  },

  flushPendingUndo: () => {
    const { tempUndoState, undoStack, historyDebounceTimer } = get();
    if (historyDebounceTimer) {
      clearTimeout(historyDebounceTimer);
    }

    if (tempUndoState) {
      const current = get();
      const isDifferent =
        tempUndoState.gravityZ !== current.gravityZ ||
        tempUndoState.windX !== current.windX ||
        tempUndoState.windY !== current.windY ||
        tempUndoState.density !== current.density ||
        tempUndoState.floorFriction !== current.floorFriction ||
        tempUndoState.floorBounce !== current.floorBounce ||
        JSON.stringify(tempUndoState.sceneGraph) !== JSON.stringify(current.sceneGraph);

      if (isDifferent) {
        const newUndoStack = [...undoStack, tempUndoState];
        if (newUndoStack.length > 20) {
          newUndoStack.shift();
        }
        set({
          undoStack: newUndoStack,
          redoStack: [],
          tempUndoState: null,
          lastInteractionType: null,
          historyDebounceTimer: null
        });
      } else {
        set({
          tempUndoState: null,
          lastInteractionType: null,
          historyDebounceTimer: null
        });
      }
    }
  },

  prepareForDiscreteChange: () => {
    get().flushPendingUndo();
    const { sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId, undoStack } = get();
    const snapshot: UndoRedoState = {
      sceneGraph: cloneSceneGraph(sceneGraph),
      gravityZ,
      windX,
      windY,
      density,
      floorFriction,
      floorBounce,
      selectedNodeId
    };
    const newUndoStack = [...undoStack, snapshot];
    if (newUndoStack.length > 20) {
      newUndoStack.shift();
    }
    set({
      undoStack: newUndoStack,
      redoStack: [],
      tempUndoState: null,
      lastInteractionType: null
    });
  },

  undo: () => {
    get().flushPendingUndo();
    const { undoStack, redoStack, sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId } = get();
    if (undoStack.length === 0) return;

    const previousState = undoStack[undoStack.length - 1];
    const newUndoStack = undoStack.slice(0, -1);

    const currentStateSnapshot: UndoRedoState = {
      sceneGraph: cloneSceneGraph(sceneGraph),
      gravityZ,
      windX,
      windY,
      density,
      floorFriction,
      floorBounce,
      selectedNodeId
    };

    set({
      sceneGraph: previousState.sceneGraph,
      gravityZ: previousState.gravityZ,
      windX: previousState.windX,
      windY: previousState.windY,
      density: previousState.density,
      floorFriction: previousState.floorFriction,
      floorBounce: previousState.floorBounce,
      selectedNodeId: previousState.selectedNodeId,
      undoStack: newUndoStack,
      redoStack: [...redoStack, currentStateSnapshot],
      isPlaying: false
    });

    get().recompile(previousState.sceneGraph, previousState.selectedNodeId, true, true);
  },

  redo: () => {
    get().flushPendingUndo();
    const { undoStack, redoStack, sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce, selectedNodeId } = get();
    if (redoStack.length === 0) return;

    const nextState = redoStack[redoStack.length - 1];
    const newRedoStack = redoStack.slice(0, -1);

    const currentStateSnapshot: UndoRedoState = {
      sceneGraph: cloneSceneGraph(sceneGraph),
      gravityZ,
      windX,
      windY,
      density,
      floorFriction,
      floorBounce,
      selectedNodeId
    };

    set({
      sceneGraph: nextState.sceneGraph,
      gravityZ: nextState.gravityZ,
      windX: nextState.windX,
      windY: nextState.windY,
      density: nextState.density,
      floorFriction: nextState.floorFriction,
      floorBounce: nextState.floorBounce,
      selectedNodeId: nextState.selectedNodeId,
      undoStack: [...undoStack, currentStateSnapshot],
      redoStack: newRedoStack,
      isPlaying: false
    });

    get().recompile(nextState.sceneGraph, nextState.selectedNodeId, true, true);
  },  isPlaying: false,
  isLoaded: false,
  lastCompileError: null,
  isSettingsOpen: false,
  cameraView: 'perspective',
  cameraOverride: null,
  mcpActiveCount: 0,
  scadCompileCount: 0,
  
  gravityZ: -9.81,
  windX: 0,
  windY: 0,
  density: 0,
  floorFriction: 1.0,
  floorBounce: 0.0,
  
  sceneGraph: initialScene,
  selectedNodeId: null,
  parentUnderSelected: false,
  activePreset: 'pendulum',
  draggedNodeId: null,
  dragTarget: null,
  dragDistance: 0,

  setParentUnderSelected: (val) => set({ parentUnderSelected: val }),
  incrementMcpActive: () => set((state) => ({ mcpActiveCount: state.mcpActiveCount + 1 })),
  decrementMcpActive: () => set((state) => ({ mcpActiveCount: Math.max(0, state.mcpActiveCount - 1) })),
  incrementScadCompile: () => set((state) => ({ scadCompileCount: state.scadCompileCount + 1 })),
  decrementScadCompile: () => set((state) => ({ scadCompileCount: Math.max(0, state.scadCompileCount - 1) })),

  togglePlay: () => set((state) => {
    const isPlaying = !state.isPlaying;
    getPhysicsWorkerClient().setPlaying(isPlaying);
    return { isPlaying };
  }),
  setLoaded: (loaded) => set({ isLoaded: loaded }),
  setSettingsOpen: (open) => set({ isSettingsOpen: open }),
  setCameraView: (view) => set({ cameraView: view, cameraOverride: null }),
  setCameraOverride: (override) => set({ cameraOverride: override }),
  
  resetSimulation: () => {
    getPhysicsWorkerClient().setPlaying(false);
    set({ isPlaying: false });
    get().recompile(undefined, undefined, true, true);
  },
  
  loadPreset: (name) => {
    const prev = get().activePreset;
    get().prepareForDiscreteChange();
    getPhysicsWorkerClient().setPlaying(false);
    set({ isPlaying: false, selectedNodeId: null, activePreset: name });
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('physics:preset-loaded', { detail: { name, prev } }));
    }
    if (name.startsWith('user:')) {
      const presetName = name.replace('user:', '');
      try {
        const userPresets = JSON.parse(localStorage.getItem('physics_user_presets') || '{}');
        const savedScene = userPresets[presetName];
        if (savedScene) {
          get().recompile(savedScene, null, true, true);
        }
      } catch (e) {
        console.error('Failed to load user preset', e);
      }
      return;
    }
    const preset = PRESETS[name as keyof typeof PRESETS] as any;
    if (!preset) return;
    if (preset.environment) {
      set({ windX: 0, windY: 0, floorBounce: 0, ...preset.environment });
    } else {
      set({ windX: 0, windY: 0, floorBounce: 0 });
    }
    get().recompile(preset.scene, null, true, true);
  },
  
  setEnvironment: (env) => {
    get().recordInteraction('environment');
    set(env);
    get().recompile(get().sceneGraph);
  },
  
  setSelectedNodeId: (id) => set({ selectedNodeId: id }),
  
  setDraggedNodeId: (id) => {
    if (id !== null && get().draggedNodeId === null) {
      get().recordInteraction('drag-node');
    }
    set({ draggedNodeId: id });
    getPhysicsWorkerClient().setDrag(id, get().dragTarget);
  },
  setDragTarget: (target) => {
    set({ dragTarget: target });
    getPhysicsWorkerClient().setDrag(get().draggedNodeId, target);
  },
  setDragDistance: (distance) => set({ dragDistance: distance }),

  updateWedgeParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.width !== undefined) {
            node.width = params.width;
            // Recalculate wedgeAngle
            const h = node.height || 0.5;
            node.wedgeAngle = Math.atan(h / node.width) * 180 / Math.PI;
          }
          if (params.height !== undefined) {
            node.height = params.height;
            // Recalculate wedgeAngle
            const w = node.width || 2.0;
            node.wedgeAngle = Math.atan(node.height / w) * 180 / Math.PI;
          }
          if (params.depth !== undefined) {
            node.depth = params.depth;
          }
          if (params.wedgeAngle !== undefined) {
            node.wedgeAngle = params.wedgeAngle;
            // Recalculate height
            const w = node.width || 2.0;
            node.height = w * Math.tan(node.wedgeAngle * Math.PI / 180);
          }
          
          // Update first geom size
          if (node.geoms && node.geoms.length > 0) {
            const w = node.width || 2.0;
            const h = node.height || 0.5;
            const L = Math.sqrt(w * w + h * h);
            const d = node.depth || 1.0;
            node.geoms[0].size = [L / 2, d / 2, 0.025];
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },
  
  updatePyramidParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.width !== undefined) node.width = params.width;
          if (params.depth !== undefined) node.depth = params.depth;
          if (params.height !== undefined) node.height = params.height;
          
          if (node.geoms && node.geoms.length > 0) {
            const w = node.width || 0.5;
            const d = node.depth || 0.5;
            const h = node.height || 0.5;
            const { vertices, faces, renderVertices } = generatePyramidMeshData(w, d, h);
            node.geoms[0].vertices = vertices;
            node.geoms[0].faces = faces;
            node.geoms[0].renderVertices = renderVertices;
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateConeParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.radius !== undefined) node.radius = params.radius;
          if (params.height !== undefined) node.height = params.height;
          
          if (node.geoms && node.geoms.length > 0) {
            const r = node.radius || 0.3;
            const h = node.height || 0.6;
            const { vertices, faces, renderVertices } = generateConeMeshData(r, h, 16);
            node.geoms[0].vertices = vertices;
            node.geoms[0].faces = faces;
            node.geoms[0].renderVertices = renderVertices;
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateTorusParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.majorRadius !== undefined) node.majorRadius = params.majorRadius;
          if (params.tubeRadius !== undefined) node.tubeRadius = params.tubeRadius;
          
          if (node.geoms && node.geoms.length > 0) {
            const R = node.majorRadius || 0.4;
            const r = node.tubeRadius || 0.1;
            const { vertices, faces, renderVertices } = generateTorusMeshData(R, r, 24, 16);
            node.geoms[0].vertices = vertices;
            node.geoms[0].faces = faces;
            node.geoms[0].renderVertices = renderVertices;
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateTubeParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.innerRadius !== undefined) node.innerRadius = params.innerRadius;
          if (params.outerRadius !== undefined) node.outerRadius = params.outerRadius;
          if (params.height !== undefined) node.height = params.height;
          
          if (node.geoms && node.geoms.length > 0) {
            const r1 = node.innerRadius || 0.2;
            const r2 = node.outerRadius || 0.3;
            const h = node.height || 0.5;
            const { vertices, faces, renderVertices } = generateTubeMeshData(r1, r2, h, 24);
            node.geoms[0].vertices = vertices;
            node.geoms[0].faces = faces;
            node.geoms[0].renderVertices = renderVertices;
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateCurveParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.points !== undefined) node.curvePoints = params.points.map((p: number[]) => [...p]);
          if (params.width !== undefined) node.curveWidth = params.width;
          if (params.thickness !== undefined) node.curveThickness = params.thickness;
          if (params.segments !== undefined) node.curveSegments = Math.round(params.segments);
          if (params.closed !== undefined) node.curveClosed = params.closed;
          if (params.bank !== undefined) node.curveBank = params.bank;

          const rgba = node.geoms?.[0]?.rgba || [0.85, 0.45, 0.15, 1];
          node.geoms = generateCurveGeoms(
            node.id,
            node.curvePoints || DEFAULT_CURVE_POINTS,
            node.curveWidth || DEFAULT_CURVE_WIDTH,
            node.curveThickness || DEFAULT_CURVE_THICKNESS,
            node.curveSegments || DEFAULT_CURVE_SEGMENTS,
            rgba,
            node.curveClosed === true,
            node.curveBank || 0
          );
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updatePulleyParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.leftTargetId !== undefined) node.leftTargetId = params.leftTargetId;
          if (params.rightTargetId !== undefined) node.rightTargetId = params.rightTargetId;
          if (params.pulleyRadius !== undefined) {
            node.pulleyRadius = params.pulleyRadius;
            if (node.geoms && node.geoms.length === 3) {
              node.geoms[0].size[0] = params.pulleyRadius * 0.8;
              node.geoms[1].size[0] = params.pulleyRadius;
              node.geoms[2].size[0] = params.pulleyRadius;
            } else if (node.geoms && node.geoms.length > 0) {
              node.geoms[0].size[0] = params.pulleyRadius;
            }
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene);
  },

  updateRopeParams: (id, params) => {
    get().recordInteraction('node-params');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          if (params.pulleyWheelId !== undefined) node.pulleyWheelId = params.pulleyWheelId;
          if (params.leftTargetId !== undefined) node.leftTargetId = params.leftTargetId;
          if (params.rightTargetId !== undefined) node.rightTargetId = params.rightTargetId;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    get().recompile(newScene, get().selectedNodeId);
  },

  updateNodeComposite: (id, params) => {
    get().recordInteraction('node-composite');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const findAndMutate = (nodes: any[]): boolean => {
      if (!nodes) return false;
      for (const n of nodes) {
        if (n.id === id) {
          Object.assign(n, params);
          return true;
        }
        if (n.children && findAndMutate(n.children)) return true;
      }
      return false;
    };
    findAndMutate(newScene.nodes);
    get().recompile(newScene, id, false, true);
  },
  
  updateScene: (newScene, skipRecompile) => {
    get().prepareForDiscreteChange();
    set({ sceneGraph: newScene });
    if (!skipRecompile) {
      get().recompile(newScene);
    }
  },
  
  renameNode: (id, newName) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          node.name = newName;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene);
  },
  
  updateNodePos: (id, newPos) => {
    get().recordInteraction('node-pos');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id) {
          if (isAllMeshNode(node)) {
            // Mesh vertices are baked in world space — translate them directly
            const [ox, oy, oz] = node.pos as number[];
            translateMeshGeoms(node, newPos[0] - ox, newPos[1] - oy, newPos[2] - oz);
          }
          node.pos = newPos;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, false);
  },

  updateNodeRotation: (id, axis, deg) => {
    get().recordInteraction('node-rotation');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          const currentEuler = node.euler ? [...node.euler] : [0, 0, 0];
          const prevDeg = currentEuler[axis] || 0;
          currentEuler[axis] = deg;
          node.euler = currentEuler as [number, number, number];
          delete node.quat;
          if (isAllMeshNode(node)) {
            // Rotate mesh vertices in-place around their centroid
            rotateMeshGeoms(node, axis, deg - prevDeg);
            // Keep node.euler purely for UI display — it doesn't affect rendering
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      get().recompile(newScene, undefined, true);
    }
  },

  updateNodeGeom: (id, updates, geomIndex) => {
    get().recordInteraction('node-geom');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id && node.geoms?.length > 0) {
          if (id.includes('gear')) {
            const centerGeom = node.geoms[0];
            const currentRadius = centerGeom.size[0];
            const currentTeeth = node.geoms.length - 1;
            const currentColor = centerGeom.rgba || [0.5, 0.5, 0.5, 1];
            const currentContype = centerGeom.contype !== undefined ? centerGeom.contype : 0;
            const currentConaffinity = centerGeom.conaffinity !== undefined ? centerGeom.conaffinity : 0;
            
            let newRadius = currentRadius;
            if (updates.size && Array.isArray(updates.size)) {
              newRadius = updates.size[0];
            }
            
            let newColor = currentColor;
            if (updates.rgba) {
              newColor = updates.rgba;
            }

            let newContype = currentContype;
            if (updates.contype !== undefined) {
              newContype = updates.contype;
            }

            let newConaffinity = currentConaffinity;
            if (updates.conaffinity !== undefined) {
              newConaffinity = updates.conaffinity;
            }
            
            const gearNum = parseInt(id.replace(/\D/g, '')) || 1;
            const isSecondGear = gearNum % 2 === 0;
            
            node.geoms = generateGearGeoms(id, newRadius, currentTeeth, newColor, isSecondGear, newContype, newConaffinity);
          } else {
            let targetGeom = node.geoms[0];
            if (geomIndex !== undefined && geomIndex >= 0 && geomIndex < node.geoms.length) {
              targetGeom = node.geoms[geomIndex];
            } else {
              const mainGeom = node.geoms.find((g: any) => g.type === 'sphere' || g.type === 'box' || g.type === 'cylinder');
              if (mainGeom) {
                targetGeom = mainGeom;
              }
            }
            if (updates.fromto && targetGeom.fromto) {
              const oldFromto = targetGeom.fromto;
              const newFromto = updates.fromto;
              const oldLen = Math.sqrt((oldFromto[3]-oldFromto[0])**2 + (oldFromto[4]-oldFromto[1])**2 + (oldFromto[5]-oldFromto[2])**2) || 1.0;
              const newLen = Math.sqrt((newFromto[3]-newFromto[0])**2 + (newFromto[4]-newFromto[1])**2 + (newFromto[5]-newFromto[2])**2) || 1.0;
              const ratio = newLen / oldLen;
              if (node.children) {
                node.children.forEach((child: any) => {
                  child.pos = [child.pos[0] * ratio, child.pos[1] * ratio, child.pos[2] * ratio];
                });
              }
            }
            Object.assign(targetGeom, updates);
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile(newScene, undefined, true);
  },

  updateGearTeeth: (id, teeth) => {
    get().recordInteraction('gear-teeth');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id && node.geoms?.length > 0) {
          const centerGeom = node.geoms[0];
          const radius = centerGeom.size[0];
          const color = centerGeom.rgba || [0.5, 0.5, 0.5, 1];
          const gearNum = parseInt(id.replace(/\D/g, '')) || 1;
          const isSecondGear = gearNum % 2 === 0;
          const contype = centerGeom.contype !== undefined ? centerGeom.contype : 0;
          const conaffinity = centerGeom.conaffinity !== undefined ? centerGeom.conaffinity : 0;
          
          node.geoms = generateGearGeoms(id, radius, teeth, color, isSecondGear, contype, conaffinity);
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, id);
    }
  },

  addPusherPeg: (gearId) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === gearId && node.geoms?.length > 0) {
          const hasPeg = node.geoms.some((g: any) => g.name.includes('peg'));
          if (!hasPeg) {
            const radius = node.geoms[0].size[0];
            node.geoms.push({
              name: `${gearId}_pusher_peg`,
              type: 'cylinder',
              size: [0.03, 0.08], // radius, half-height
              pos: [radius * 0.8, 0, 0.09], // relative offset
              rgba: [0.9, 0.2, 0.2, 1], // red color
              mass: 0.05,
              condim: 3
            });
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, gearId);
    }
  },

  deletePusherPeg: (gearId) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === gearId && node.geoms?.length > 1) {
          node.geoms = node.geoms.filter((g: any) => !g.name.includes('peg'));
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, gearId);
    }
  },

  updatePusherPeg: (gearId, updates) => {
    get().recordInteraction('pusher-peg');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === gearId && node.geoms?.length > 1) {
          const peg = node.geoms.find((g: any) => g.name.includes('peg'));
          if (peg) {
            if (updates.offset !== undefined) {
              peg.pos = [updates.offset, 0, peg.pos[2]];
            }
            if (updates.size !== undefined) {
              peg.size = updates.size; // [radius, half_height]
              peg.pos = [peg.pos[0], 0, updates.size[1] + 0.01]; // adjust Z pos dynamically so bottom touches the disc
            }
          }
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, gearId);
    }
  },

  updateNodeJoint: (id, updates) => {
    get().recordInteraction('node-joint');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false; for (const node of nodes) {
        if (node.id === id && node.joints?.length > 0) {
          Object.assign(node.joints[0], updates);
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    get().recompile();
  },

  updateNodeScript: (id, script) => {
    get().recordInteraction('node-script');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          node.script = script;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    traverse(newScene.nodes);
    set({ sceneGraph: newScene });
    // Note: Live updates do not force model recompiles to support hot-editing of
    // control gains! The worker keeps its own copy of the scene for script
    // execution, so it needs telling directly rather than via a recompile.
    getPhysicsWorkerClient().updateScript(id, script);
  },

  updateNodeScad: (id, scad, compiledData, skipRecompile) => {
    get().recordInteraction('node-scad');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]) => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id || node.name === id) {
          node.scad = scad;
          if (!node.geoms) {
            node.geoms = [];
          }
          let meshGeom = node.geoms.find((g: any) => g.type === 'mesh');
          if (!meshGeom && node.geoms.length > 0) {
            meshGeom = node.geoms[0];
          }
          if (!meshGeom) {
            meshGeom = {
              id: `geom_${Math.random().toString(36).substring(2, 8)}`,
              name: `${node.name || id}_mesh`,
              type: 'mesh',
              dynamic: true,
              rgba: [0.3, 0.6, 0.9, 1],
              mass: 1
            };
            node.geoms.push(meshGeom);
          }
          meshGeom.type = 'mesh';
          meshGeom.dynamic = true;
          meshGeom.vertices = compiledData.vertices;
          meshGeom.faces = compiledData.faces;
          meshGeom.renderVertices = compiledData.renderVertices;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      // Bulk callers (e.g. compiling several scad bodies in sequence) pass
      // skipRecompile: firing a recompile per node here creates overlapping,
      // unawaited MJCF/WASM builds that race - a stale one (compiled before a
      // later node's mesh existed) can finish last and silently overwrite the
      // correct final state. Bulk callers run a single recompile after all
      // nodes are updated instead.
      if (!skipRecompile) {
        get().recompile(newScene, id, true);
      }
    }
  },

  // --- CSG (boolean modifiers) ---------------------------------------------
  // A negative geom is an ordinary primitive with csg:'difference' — it's the
  // node's csgEnabled flag plus that marker that turn the body into a boolean.
  // Shapes get onto a body the ordinary ways (drag-in, presets, MCP); flipping
  // one to 'difference' is what makes it a hole.
  deleteNodeGeom: (nodeId, geomIndex) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node || !node.geoms || geomIndex < 0 || geomIndex >= node.geoms.length) return;
    node.geoms = node.geoms.filter((_: any, i: number) => i !== geomIndex);
    // Losing the last boolean operator leaves an ordinary compound body; drop
    // the derived mesh with it so the primitives come back into view.
    if (node.csgEnabled && !node.geoms.some((g: any) => !g.csgDerived && (g.csg === 'difference' || g.csg === 'intersection'))) {
      node.geoms = node.geoms.filter((g: any) => !g.csgDerived);
      node.csgEnabled = false;
      delete node.csgHash;
    }
    set({ sceneGraph: newScene });
    get().recompile(newScene, nodeId, false);
  },

  setGeomCsgOp: (nodeId, geomIndex, csg) => {
    get().recordInteraction('geom-csg-op');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node?.geoms?.[geomIndex]) return;
    // There has to be something left to cut into. Subtracting a body's only
    // shape would leave it with no positive geometry at all: nothing to render,
    // nothing to collide, and a MuJoCo body with no geoms. Refuse instead.
    if (csg !== 'union') {
      const positivesLeft = node.geoms.filter((g: any, i: number) =>
        !g.csgDerived && i !== geomIndex && (!g.csg || g.csg === 'union')).length;
      if (positivesLeft === 0) return;
    }
    node.geoms[geomIndex].csg = csg;
    const hasOps = node.geoms.some((g: any) => !g.csgDerived && (g.csg === 'difference' || g.csg === 'intersection'));
    node.csgEnabled = hasOps;
    if (hasOps) {
      if (node.csgCollision === undefined) node.csgCollision = 'auto';
      if (node.csgSectors === undefined) node.csgSectors = CSG_DEFAULT_SECTORS;
    } else {
      // Back to an ordinary compound body — the stale boolean mesh would
      // otherwise keep drawing over the primitives.
      node.geoms = node.geoms.filter((g: any) => !g.csgDerived);
      delete node.csgHash;
    }
    set({ sceneGraph: newScene });
    get().recompile(newScene, nodeId, false);
  },

  // Installs the output of evaluateNodeCsg: derived geoms replace the previous
  // ones wholesale, source primitives are untouched.
  applyNodeCsg: (nodeId, result, skipRecompile) => {
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    const source = (node.geoms || []).filter((g: any) => !g.csgDerived);
    node.geoms = [...source, ...result.geoms];
    node.csgHash = result.hash;
    node.csgScad = result.scad;
    node.csgVolume = result.volume;
    node.csgHullVolume = result.hullVolume;
    node.csgCentroid = result.centroid;
    node.csgCollision = node.csgCollision ?? 'auto';
    if (result.warning) node.csgWarning = result.warning; else delete node.csgWarning;
    delete node.csgError;
    set({ sceneGraph: newScene });
    // Bulk callers recompile once at the end — see the same note on updateNodeScad.
    if (!skipRecompile) get().recompile(newScene, undefined, false);
  },

  setNodeCsgError: (nodeId, error, hash) => {
    const newScene = cloneSceneGraph(get().sceneGraph);
    const node = findNode(newScene.nodes, nodeId);
    if (!node) return;
    if (error) node.csgError = error; else delete node.csgError;
    // Record the hash that failed so the auto-compiler doesn't retry the same
    // broken shape on every store update — only a real edit re-arms it.
    if (error && hash) node.csgHash = hash;
    set({ sceneGraph: newScene });
  },

  updateNode: (id, updates) => {
    get().recordInteraction('node');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]): boolean => {
      for (const node of nodes) {
        if (node.id === id) { Object.assign(node, updates); return true; }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      set({ sceneGraph: newScene });
      // Recompile so aerodynamics flag propagates to physics loop
      get().recompile(newScene, undefined, false);
    }
  },

  updateNodeJointsList: (id, joints) => {
    get().recordInteraction('node-joints-list');
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverse = (nodes: any[]): boolean => {
      if (!nodes) return false;
      for (const node of nodes) {
        if (node.id === id) {
          node.joints = joints;
          return true;
        }
        if (traverse(node.children)) return true;
      }
      return false;
    };
    if (traverse(newScene.nodes)) {
      get().recompile(newScene, id);
    }
  },

  deleteNode: (id) => {
    get().prepareForDiscreteChange();
    const newScene = cloneSceneGraph(get().sceneGraph);
    const traverseAndRemove = (nodes: any[]): boolean => {
      if (!nodes) return false;
      for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].id === id) {
          nodes.splice(i, 1);
          return true;
        }
        if (traverseAndRemove(nodes[i].children)) return true;
      }
      return false;
    };
    if (traverseAndRemove(newScene.nodes)) {
      set({ sceneGraph: newScene, selectedNodeId: null });
      get().recompile(newScene, null);
    }
  },

  addComponent: (type, position) => {
    get().prepareForDiscreteChange();
    const { sceneGraph, selectedNodeId, parentUnderSelected } = get();
    const newScene = cloneSceneGraph(sceneGraph);
    
    // 8-character random unique suffix (no millisecond timestamp)
    const id = `${type}_${Math.random().toString(36).substring(2, 10)}`;
    
    // Determine target local position
    let localPos: [number, number, number] = [position[0], position[1], position[2]];
    
    const isChild = !!(selectedNodeId && parentUnderSelected);
    
    if (isChild && selectedNodeId) {
      // Find parent world position to make drop coordinates relative to parent!
      const parentWorldPos = getNodeWorldPos(newScene.nodes, selectedNodeId);
      if (parentWorldPos) {
        localPos = [
          position[0] - parentWorldPos[0],
          position[1] - parentWorldPos[1],
          position[2] - parentWorldPos[2]
        ];
      }
    }

    let geomType: any = type;
    let size: number[] = [0.2];
    let rgba = [0.5, 0.5, 0.5, 1];
    let mass = 1;
    let joints: any[] = [];
    let geoms: any[] = [];
    
    const isChildJoint = isChild;
    
    if (type === 'gear') {
      const radius = 0.1;
      const teeth = 12;
      const color = [0.5, 0.5, 0.5, 1];
      geoms = generateGearGeoms(id, radius, teeth, color, false);
      joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 0, 1], damping: 0.5 }];
    } else if (type === 'pulley_wheel') {
      const r = 0.08;
      const thickness = 0.04;
      const spindle_r = r * 0.8;
      const spindle_h = thickness / 2 - 0.005;
      const flange_h = 0.005;
      
      geoms = [
        { name: `${id}_spindle`, type: 'cylinder', size: [spindle_r, spindle_h], pos: [0, 0, 0], euler: [90, 0, 0], rgba: [0.3, 0.4, 0.6, 1], mass: 0.5 },
        { name: `${id}_flange_l`, type: 'cylinder', size: [r, flange_h], pos: [0, -spindle_h - flange_h / 2, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 },
        { name: `${id}_flange_r`, type: 'cylinder', size: [r, flange_h], pos: [0, spindle_h + flange_h / 2, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 }
      ];
      joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.2 }];
    } else if (type === 'pulley_rope') {
      geoms = [];
      joints = [];
    } else if (type === 'curve') {
      // Rigid curved track: spline through control points, decomposed into
      // convex box segments so collision follows the real curve.
      geoms = generateCurveGeoms(id, DEFAULT_CURVE_POINTS, DEFAULT_CURVE_WIDTH, DEFAULT_CURVE_THICKNESS, DEFAULT_CURVE_SEGMENTS);
      joints = []; // static — welded to world like the wedge
      localPos = [localPos[0], localPos[1], 0]; // tracks sit on the ground, not in the air
    } else {
      if (type === 'box') {
        geomType = 'box';
        size = [0.05, 0.05, 0.05];
        rgba = [0.8, 0.2, 0.2, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'sphere') {
        geomType = 'sphere';
        size = [0.05];
        rgba = [0.2, 0.8, 0.2, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'capsule') {
        geomType = 'capsule';
        size = [0.02, 0.15];
        rgba = [0.6, 0.6, 0.6, 1];
        // Standalone poles are free bodies and fall like any other shape; only
        // when nested under a parent does a hinge (pendulum rod) make sense.
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'cylinder') {
        geomType = 'cylinder';
        size = [0.05, 0.04];
        rgba = [0.9, 0.6, 0.1, 1];
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'bob') {
        geomType = 'sphere';
        size = [0.06];
        rgba = [0.2, 0.6, 1.0, 1];
        mass = 10.0;
        joints = [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }];
      } else if (type === 'wedge') {
        geomType = 'box';
        size = [0.2, 0.1, 0.08];
        rgba = [0.8, 0.5, 0.2, 1];
        // A wedge is a solid object, not a fixture: it falls and can be tipped
        // over like anything else. Set the joint to Fixed to weld it in place.
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'mesh') {
        // Dynamic icosahedron: radius 0.3, centred at body origin.
        // body pos = localPos handles spawn placement.
        // vertices: Y-up centred at (0,0,0) for the Three.js static render path fallback.
        // renderVertices: Z-up centred at (0,0,0) — icosahedron centroid is exactly (0,0,0).
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.5, 0.7, 0.9, 1],
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices: [-0.1577,0.2552,0,0.1577,0.2552,0,-0.1577,-0.2552,0,0.1577,-0.2552,0,0,-0.1577,0.2552,0,0.1577,0.2552,0,-0.1577,-0.2552,0,0.1577,-0.2552,0.2552,0,-0.1577,0.2552,0,0.1577,-0.2552,0,-0.1577,-0.2552,0,0.1577],
          // renderVertices: raw Z-up (Y↔Z swap only: Y-up (x,y,z)→(x,-z,y)), no centroid subtraction
          renderVertices: [-0.1577,0,0.2552,0.1577,0,0.2552,-0.1577,0,-0.2552,0.1577,0,-0.2552,0,-0.2552,-0.1577,0,-0.2552,0.1577,0,0.2552,-0.1577,0,0.2552,0.1577,0.2552,0.1577,0,0.2552,-0.1577,0,-0.2552,0.1577,0,-0.2552,-0.1577,0],
          faces: [0,11,5,0,5,1,0,1,7,0,7,10,0,10,11,1,5,9,5,11,4,11,10,2,10,7,6,7,1,8,3,9,4,3,4,2,3,2,6,3,6,8,3,8,9,4,9,5,2,4,11,6,2,10,8,6,7,9,8,1],
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'openscad') {
        // Default cube shape, will compile into a custom CSG mesh on render/edit
        geoms = [{
          name: `${id}_geom`,
          type: 'mesh',
          size: [1],
          rgba: [0.3, 0.6, 0.9, 1], // beautiful blue
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices: [
            -0.25, -0.25, -0.25,
             0.25, -0.25, -0.25,
             0.25,  0.25, -0.25,
            -0.25,  0.25, -0.25,
            -0.25, -0.25,  0.25,
             0.25, -0.25,  0.25,
             0.25,  0.25,  0.25,
            -0.25,  0.25,  0.25
          ],
          renderVertices: [
            -0.25,  0.25, -0.25,
             0.25,  0.25, -0.25,
             0.25,  0.25,  0.25,
            -0.25,  0.25,  0.25,
            -0.25, -0.25, -0.25,
             0.25, -0.25, -0.25,
             0.25, -0.25,  0.25,
            -0.25, -0.25,  0.25
          ],
          faces: [
            0, 2, 1,  0, 3, 2,
            4, 5, 6,  4, 6, 7,
            0, 1, 5,  0, 5, 4,
            1, 2, 6,  1, 6, 5,
            2, 3, 7,  2, 7, 6,
            3, 0, 4,  3, 4, 7
          ]
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'pyramid') {
        const w = 0.2;
        const d = 0.2;
        const h = 0.2;
        const { vertices, faces, renderVertices } = generatePyramidMeshData(w, d, h);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.85, 0.35, 0.15, 1], // reddish orange
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'cone') {
        const r = 0.1;
        const h = 0.2;
        const { vertices, faces, renderVertices } = generateConeMeshData(r, h, 16);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.15, 0.65, 0.85, 1], // cyan blue
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'torus') {
        const R = 0.15;
        const r = 0.04;
        const { vertices, faces, renderVertices } = generateTorusMeshData(R, r, 24, 16);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.55, 0.35, 0.85, 1], // purple
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'tube') {
        const r1 = 0.06;
        const r2 = 0.1;
        const h = 0.15;
        const { vertices, faces, renderVertices } = generateTubeMeshData(r1, r2, h, 24);
        geoms = [{
          name: `${id}_mesh`,
          type: 'mesh',
          size: [1],
          rgba: [0.35, 0.75, 0.35, 1], // green
          mass: 1,
          condim: 3,
          dynamic: true,
          vertices,
          faces,
          renderVertices
        }];
        joints = [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'ellipsoid') {
        geomType = 'ellipsoid';
        size = [0.12, 0.08, 0.06];
        rgba = [0.85, 0.55, 0.15, 1]; // yellow/orange
        joints = isChildJoint ? [{ name: `${id}_hinge`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.5 }] : [{ name: `${id}_free`, type: 'free' }];
      } else if (type === 'ring') {
        // The canonical boolean: a flattened ellipsoid with a slimmer ellipsoid
        // punched through it along Z. The negative is only a little taller than
        // the disc: it has to pierce right through (a flush cut leaves coincident
        // faces), but overshooting by multiples just makes a big outline in the
        // editor for no benefit. Nothing here is special-cased downstream —
        // it's just two ordinary primitives and a csg marker, so every slider in
        // the panel reshapes it and the mesh is regenerated from scratch.
        geoms = [
          { name: `${id}_body`, type: 'ellipsoid', size: [0.12, 0.12, 0.04], mass: 1, rgba: [0.85, 0.65, 0.2, 1], condim: 3 },
          { name: `${id}_hole`, type: 'ellipsoid', size: [0.06, 0.06, 0.07], csg: 'difference', pos: [0, 0, 0], rgba: [0.9, 0.25, 0.35, 1] },
        ];
        joints = [{ name: `${id}_free`, type: 'free' }];
      }
      if (type !== 'mesh' && type !== 'openscad' && type !== 'pyramid' && type !== 'cone' && type !== 'torus' && type !== 'tube' && type !== 'ring') {
        geoms = [{ name: `${id}_geom`, type: geomType, size, mass, rgba }];
      }
    }

    const newNode: SceneNode = {
      id, name: id, type: 'body', pos: localPos,
      joints,
      geoms,
      children: [],
      ...(type === 'wedge' ? {
        isWedge: true,
        width: 2.0,
        depth: 1.0,
        height: 0.5,
        wedgeAngle: 14.036
      } : {}),
      ...(type === 'pyramid' ? {
        isPyramid: true,
        width: 0.5,
        depth: 0.5,
        height: 0.5
      } : {}),
      ...(type === 'cone' ? {
        isCone: true,
        radius: 0.3,
        height: 0.6
      } : {}),
      ...(type === 'torus' ? {
        isTorus: true,
        majorRadius: 0.4,
        tubeRadius: 0.1
      } : {}),
      ...(type === 'tube' ? {
        isTube: true,
        innerRadius: 0.2,
        outerRadius: 0.3,
        height: 0.5
      } : {}),
      ...(type === 'pulley_wheel' ? {
        isPulleyWheel: true,
        // Must match the flange geoms above (r = 0.08). It was 0.4, so a
        // dragged-in wheel drew its rope on a 0.4m rim around an 0.08m wheel
        // and coupled the rope kinematics to the wrong radius.
        pulleyRadius: 0.08
      } : {}),
      ...(type === 'pulley_rope' ? {
        isPulleyRope: true,
        pulleyWheelId: '',
        leftTargetId: '',
        rightTargetId: ''
      } : {}),
      ...(type === 'openscad' ? {
        scad: `// Example OpenSCAD Code\ndifference() {\n  cube([0.5, 0.5, 0.5], center=true);\n  sphere(d=0.6, $fn=16);\n}`
      } : {}),
      ...(type === 'ring' ? {
        csgEnabled: true,
        csgCollision: 'auto' as const,
        csgSectors: CSG_DEFAULT_SECTORS,
        csgMass: 1,
      } : {}),
      ...(type === 'curve' ? {
        isCurve: true,
        curvePoints: DEFAULT_CURVE_POINTS.map(p => [...p]),
        curveWidth: DEFAULT_CURVE_WIDTH,
        curveThickness: DEFAULT_CURVE_THICKNESS,
        curveSegments: DEFAULT_CURVE_SEGMENTS
      } : {}),
    };

    if (isChild && selectedNodeId) {
      addChildNode(newScene.nodes, selectedNodeId, newNode);
    } else {
      newScene.nodes.push(newNode);
    }
    
    const selectId = typeof window !== 'undefined' && (window as any).NO_SELECT ? null : id;
    get().recompile(newScene, selectId);
  },
  
  recompile: async (overrideScene?: SceneGraph, overrideSelectedId?: string | null, forceReset?: boolean, _keepPreset?: boolean) => {
    // We only debounce if it's NOT a force reset (which is used by presets/loaders)
    if (!forceReset) {
      if ((window as any)._recompileTimeoutId) clearTimeout((window as any)._recompileTimeoutId);
      await new Promise(resolve => {
        (window as any)._recompileTimeoutId = setTimeout(resolve, 50);
      });
    }

    if (typeof window !== 'undefined') {
      (window as any).DISABLE_USEFRAME = false;
    }
    const { gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    const sceneGraph = overrideScene ?? get().sceneGraph;

    const applyBuilt = (built: BuiltResult) => {
      console.log(`[PhysicsWorker] Model built successfully. Shared memory (COOP/COEP) active: ${!!built.isShared}`);
      const updates: Partial<PhysicsState> = {
        mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built),
        sceneGraph, recompileId: Date.now(), lastCompileError: null, isLoaded: true,
      };
      if (overrideSelectedId !== undefined) updates.selectedNodeId = overrideSelectedId;
      requestAnimationFrame(() => set(updates));
    };

    try {
      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
      if (typeof window !== 'undefined') {
        (window as any).compiledXML = xml;
      }

      // Proactively recycle before the ceiling is ever reached, rather than
      // only reacting to a hard failure — see RECYCLE_EVERY_N_BUILDS comment.
      buildsSinceRecycle++;
      if (buildsSinceRecycle > RECYCLE_EVERY_N_BUILDS) {
        console.warn(`Proactively recycling the physics worker after ${RECYCLE_EVERY_N_BUILDS} builds to stay well clear of the WASM heap ceiling.`);
        recycleWorker();
        buildsSinceRecycle = 1;
      }

      const client = getPhysicsWorkerClient();
      client.setEnv(windX, windY);
      const built = await client.build(xml, sceneGraph, !forceReset);
      if (!built.ok) {
        throw new Error(built.error || 'Unknown physics worker build error');
      }
      applyBuilt(built);
    } catch (e) {
      console.error("Failed to compile MJCF:", e);
      const msg = String(e instanceof Error ? e.message : e);
      if (/Aborted|enlarge memory|abort|bad_alloc/i.test(msg)) {
        // The WASM module's linear memory only ever grows across a session, and
        // the @mujoco/mujoco build has a hard 2^31-byte ceiling it can never
        // exceed. Reinstantiating a module in the SAME worker/realm isn't
        // guaranteed to actually return that memory to the OS, so recover by
        // terminating the whole worker (a separate JS realm) and spawning a
        // fresh one — a real reclaim — then rebuilding the same scene against
        // it. Only reload the page if that also fails.
        try {
          console.warn('MuJoCo WASM heap exhausted — terminating and respawning the physics worker (keeping scene/camera).');
          recycleWorker();
          const freshClient = getPhysicsWorkerClient();
          freshClient.setEnv(windX, windY);
          const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
          const built = await freshClient.build(xml, sceneGraph, false);
          if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error');
          applyBuilt(built);
          return;
        } catch (recoveryError) {
          console.error('Worker respawn recovery failed, falling back to full page reload:', recoveryError);
          alert('The physics engine ran out of memory and could not recover, even after restarting the physics worker.\n\nThe page will reload to free memory — your scene will be lost unless you saved it first.');
          window.location.reload();
          return;
        }
      }
      // Still update the sceneGraph so the UI reflects the change even if MuJoCo rejects it
      const updates: Partial<PhysicsState> = { sceneGraph, lastCompileError: msg };
      if (overrideSelectedId !== undefined) updates.selectedNodeId = overrideSelectedId;
      set(updates);
    }
  },

  recoverFromFatalWorkerError: async (message, lastState) => {
    // Mirrors recompile()'s memory-exhaustion recovery, but triggered from a
    // fatal error reported by the worker mid-simulation (not during a build):
    // terminate the exhausted worker (real memory reclaim) and rebuild the
    // current scene fresh, reseeding the last qpos/qvel/time the worker
    // reported right before it died (best-effort — if that report itself
    // failed to arrive, this falls back to the as-built initial pose).
    console.warn('Fatal physics worker error — terminating and respawning worker:', message);
    const wasPlaying = get().isPlaying;
    recycleWorker();
    set({ isPlaying: false });
    const { sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    try {
      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
      const client = getPhysicsWorkerClient();
      client.setEnv(windX, windY);
      const built = await client.build(xml, sceneGraph, false, lastState);
      if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error');
      set({ mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built), recompileId: Date.now(), lastCompileError: null });
      if (wasPlaying) { client.setPlaying(true); set({ isPlaying: true }); }
    } catch (e) {
      console.error('Recovery rebuild after fatal worker error failed:', e);
    }
  },

  recycleWorkerSeamlessly: async () => {
    // Periodic proactive recycle while actively simulating: MuJoCo's own
    // internal contact/constraint memory can grow over the course of a long
    // play session — not just across explicit rebuilds — and, like
    // everything else in a WASM realm, never shrinks back down on its own.
    // Swap in a fresh worker before that ever becomes a problem, carrying
    // over the exact current qpos/qvel/time (from the live `data` mirror,
    // kept up to date by FRAME messages) so it's invisible rather than a
    // visible reset. See the periodic timer below this store definition.
    // isPlaying is deliberately read later via get(), not destructured here: the
    // await below means the snapshot could be stale by the time it's used.
    const { data, sceneGraph, gravityZ, windX, windY, density, floorFriction, floorBounce } = get();
    if (!data) return;
    const seedState = {
      qpos: Array.from(data.qpos as Float64Array),
      qvel: Array.from(data.qvel as Float64Array),
      ctrl: Array.from(data.ctrl as Float64Array),
      time: data.time as number,
    };
    recycleWorker();
    try {
      const xml = compileToMJCF(sceneGraph, gravityZ, floorFriction, windX, windY, density, floorBounce);
      const client = getPhysicsWorkerClient();
      client.setEnv(windX, windY);
      const built = await client.build(xml, sceneGraph, false, seedState);
      if (!built.ok) throw new Error(built.error || 'Unknown physics worker build error');
      set({ mujoco: MUJOCO_SHIM, model: buildModelMirror(built), data: buildDataMirror(built), recompileId: Date.now(), lastCompileError: null });
      if (get().isPlaying) client.setPlaying(true);
    } catch (e) {
      console.error('Seamless proactive worker recycle failed:', e);
    }
  },
}));

if (typeof window !== 'undefined') {
  // Every 20s while actively playing, seamlessly recycle the physics worker
  // (see recycleWorkerSeamlessly above) — this is what actually addresses
  // memory growth from long-running simulation, as opposed to the
  // build-counter recycle in recompile() which only helps across rebuilds.
  setInterval(() => {
    if (useStore.getState().isPlaying) {
      useStore.getState().recycleWorkerSeamlessly();
    }
  }, 20000);
}
