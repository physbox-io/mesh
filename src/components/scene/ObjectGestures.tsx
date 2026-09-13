// ---------------------------------------------------------------------------
// Scale and inset, on an ordinary body
// ---------------------------------------------------------------------------
//
// The lattice tools grew two gestures — a key that starts an operation and a
// pointer that sizes it — and they turned out to be the fastest way to work in
// the app. There is no reason they should belong to lattice bodies: a primitive
// or an imported mesh is just as often the wrong size, and the sidebar slider
// is a long way from the model.
//
// So S scales the selected body and I hollows it. Both are modal: move the
// pointer to size it, click or Enter to keep it, Esc or right-click to put it
// back, and X/Y/Z confine it to one axis on the way.
//
// The preview is the SCENE, not the document. Scaling a real mesh means
// rewriting every vertex and rebuilding its buffers, which is far too much to
// do per pointer-move; scaling the Three.js group that draws it costs nothing
// and looks identical. Only when the gesture is kept does the change go into
// the scene graph, once.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { scaleNodeTree } from '../../utils/scaleNode';
import { useOrbitEnable } from './useOrbitEnable';

type Axis = 'x' | 'y' | 'z';

/** What a group looked like before the gesture touched it. */
interface Held {
  object: THREE.Object3D;
  position: THREE.Vector3;
}

interface Gesture {
  kind: 'scale' | 'inset' | 'move';
  nodeId: string;
  /** Screen position of the body, and how far the pointer was from it. */
  centre: { x: number; y: number };
  radius: number;
  /** World point the preview scales about. */
  pivot: THREE.Vector3;
  held: Held[];
  ghosts: THREE.Object3D[];
  axis: Axis | null;
  factor: number;
  /** Move only: where the body was, and where the pointer was on its plane. */
  from?: THREE.Vector3;
  startPos?: [number, number, number];
  /** Move only: the free joint whose qpos previews the move, if there is one. */
  joint?: string;
  /** Move only: where the body has been moved to, as the pointer stands. */
  to?: [number, number, number];
}

/** The node with this id, anywhere in the tree. */
const findNode = (nodes: SceneNode[], id: string): SceneNode | null => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children ?? [], id);
    if (child) return child;
  }
  return null;
};

const GHOST_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0xef4444, transparent: true, opacity: 0.35, depthWrite: false,
});

export const ObjectGestureController = () => {
  const { scene, camera, gl } = useThree();
  const gesture = useRef<Gesture | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const setGestureStatus = useStore((s) => s.setGestureStatus);
  const setOrbitEnabled = useOrbitEnable();

  useEffect(() => {
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', track);
    return () => window.removeEventListener('pointermove', track);
  }, []);

  /** Every group drawing this body. One per geom — see DynamicGeom. */
  const groupsFor = useCallback((nodeId: string) => {
    const found: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (object.name === nodeId && object.type === 'Group') found.push(object);
    });
    return found;
  }, [scene]);

  /**
   * Where a scale of `factor` puts a group that started at `position`.
   *
   * Scaling a group scales it about its OWN origin, which for a body drawn as
   * several geoms is each geom's centre rather than the body's. Moving the
   * group as well pins the whole thing to one pivot, so a compound body grows
   * as one object instead of each part swelling in place.
   */
  const place = (object: THREE.Object3D, start: THREE.Vector3, pivot: THREE.Vector3, s: THREE.Vector3) => {
    object.scale.copy(s);
    object.position.set(
      pivot.x * (1 - s.x) + start.x * s.x,
      pivot.y * (1 - s.y) + start.y * s.y,
      pivot.z * (1 - s.z) + start.z * s.z,
    );
  };

  /*
   * Per-axis factors in the frame the groups actually live in.
   *
   * Bodies are drawn inside a group rotated Z-up→Y-up (see SceneVisuals), so
   * inside it the axes ARE the scene graph's: x, y, z with no swap. Getting
   * this wrong is not subtle — asking a cylinder to grow along Z made it
   * fatter instead of longer.
   *
   * They are the body's own axes rather than the world's, which is the same
   * thing until the body is rotated, and is the only frame a box's half-extents
   * or a mesh's vertices are expressed in.
   */
  const factors = (state: Gesture): THREE.Vector3 => {
    if (state.kind === 'scale') {
      return new THREE.Vector3(
        !state.axis || state.axis === 'x' ? state.factor : 1,
        !state.axis || state.axis === 'y' ? state.factor : 1,
        !state.axis || state.axis === 'z' ? state.factor : 1,
      );
    }
    /*
     * Inset bores a hole THROUGH the body, along one axis.
     *
     * A copy shrunk on all three axes is a sealed cavity: correct arithmetic,
     * useless result. Nothing about the body changes on the outside, so it
     * reads as an operation that did not happen — which is exactly how it was
     * reported. So the copy shrinks across the bore and OVERSHOOTS along it:
     * a flush cut leaves coincident faces, which is the one thing a boolean
     * evaluator cannot decide about (see the ring component for the same note).
     *
     * The axis keys pick which way the bore runs; Z by default, which is the
     * axis a cylinder and a capsule are already built along.
     */
    const bore = state.axis ?? 'z';
    const through = 1.05;
    return new THREE.Vector3(
      bore === 'x' ? through : state.factor,
      bore === 'y' ? through : state.factor,
      bore === 'z' ? through : state.factor,
    );
  };

  /**
   * A ray from the pointer, in the frame bodies actually live in.
   *
   * The camera is in the outer Y-up scene and the scene graph is drawn inside a
   * Z-up group, so the ray is brought into that group's frame — after which
   * every number here is a MuJoCo world coordinate and can be handed to the
   * store as it stands.
   */
  const rayIn = useCallback((parent: THREE.Object3D, x: number, y: number) => {
    const rect = gl.domElement.getBoundingClientRect();
    const caster = new THREE.Raycaster();
    caster.setFromCamera(
      new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -(((y - rect.top) / rect.height) * 2 - 1)),
      camera,
    );
    const inverse = new THREE.Matrix4().copy(parent.matrixWorld).invert();
    return new THREE.Ray(
      caster.ray.origin.clone().applyMatrix4(inverse),
      caster.ray.direction.clone().transformDirection(inverse).normalize(),
    );
  }, [camera, gl]);

  /**
   * Where the pointer is, on the surface a move is measured against.
   *
   * Unconstrained that is the plane facing the camera through the body, so the
   * body follows the pointer wherever it goes. Held to an axis it is the plane
   * containing that axis and facing the camera as squarely as it can, which is
   * the only way a line in space can be read off a flat screen.
   */
  const planeHit = useCallback((parent: THREE.Object3D, x: number, y: number, through: THREE.Vector3, axis: Axis | null) => {
    const ray = rayIn(parent, x, y);
    const eye = ray.origin.clone().sub(through);
    let normal: THREE.Vector3;
    if (axis) {
      const along = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
      normal = eye.clone().sub(along.clone().multiplyScalar(eye.dot(along)));
      if (normal.lengthSq() < 1e-9) normal.set(0, 0, 1); // looking down the axis
    } else {
      normal = eye.clone();
    }
    normal.normalize();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
    return ray.intersectPlane(plane, new THREE.Vector3());
  }, [rayIn]);

  const draw = useCallback(() => {
    const state = gesture.current;
    if (!state) return;

    if (state.kind === 'move') {
      const parent = state.held[0]?.object.parent;
      if (!parent || !state.from || !state.startPos) return;
      const hit = planeHit(parent, pointer.current.x, pointer.current.y, state.from, state.axis);
      if (!hit) return;
      const delta = hit.clone().sub(state.from);
      if (state.axis) {
        // One axis only: the other two keep the number they started with.
        const keep = state.axis;
        delta.set(keep === 'x' ? delta.x : 0, keep === 'y' ? delta.y : 0, keep === 'z' ? delta.z : 0);
      }
      const to: [number, number, number] = [
        state.startPos[0] + delta.x, state.startPos[1] + delta.y, state.startPos[2] + delta.z,
      ];
      // Previewed through the physics state rather than the drawn position: a
      // dynamic body's group is rewritten from MuJoCo every frame, so anything
      // written here would be gone before it was seen. A body with no free
      // joint has no qpos to write, and shows the move when it is kept.
      if (state.joint) {
        for (let axis = 0; axis < 3; axis++) getPhysicsWorkerClient().setQpos(state.joint, axis, to[axis]);
      }
      state.to = to;
      const mm = (v: number) => `${(v * 1000).toFixed(1)} mm`;
      const said = (['x', 'y', 'z'] as const)
        .map((name, k) => (Math.abs(to[k] - state.startPos![k]) < 5e-5 ? null : `${name.toUpperCase()} ${mm(to[k] - state.startPos![k])}`))
        .filter(Boolean);
      setGestureStatus(said.length === 0 ? 'Move' : `Move ${said.join(' · ')}`);
      return;
    }

    const away = Math.hypot(pointer.current.x - state.centre.x, pointer.current.y - state.centre.y);
    // Clamped both ways: a pointer that happens to sit on the middle of the
    // body would make every pixel a doubling, and one started from across the
    // window — from the mode menu in the status bar, say — would need the width
    // of the screen to do anything.
    const reference = Math.min(240, Math.max(48, state.radius));
    // Identity where the pointer started, so nothing jumps when the key is
    // pressed. Inset counts the other way — a pointer pulled in towards the
    // body is a thicker wall — and stops short of nothing left to cut.
    const travel = (away - state.radius) / reference;
    state.factor = state.kind === 'scale'
      ? Math.max(0.01, 1 + travel)
      : Math.min(0.98, Math.max(0.02, 1 - travel));

    const scale = factors(state);
    // A body drawn as ONE group is scaled about its own origin and never moved:
    // its position is rewritten from the physics state every frame, and writing
    // it here as well would have the two fighting each other. Only a compound
    // body, whose parts have to swell about a shared point, needs the move.
    const anchored = state.held.length > 1;
    if (state.kind === 'scale') {
      for (const held of state.held) place(held.object, held.position, anchored ? state.pivot : held.position, scale);
    }
    // An inset leaves the body ALONE and moves only the ghost: the body is what
    // the hole is being judged against, and shrinking it too made the thing
    // being cut disappear along with the thing cutting it.
    for (let i = 0; i < state.ghosts.length; i++) {
      const start = state.held[i].position;
      place(state.ghosts[i], start, anchored ? state.pivot : start, scale);
    }
    setGestureStatus(state.kind === 'scale'
      ? `Scale ${state.factor.toFixed(2)}×${state.axis ? ` · ${state.axis.toUpperCase()}` : ''}`
      : `Inset ${state.factor.toFixed(2)}× · bore ${(state.axis ?? 'z').toUpperCase()}`);
  }, [planeHit, setGestureStatus]);

  const clear = useCallback(() => {
    const state = gesture.current;
    if (!state) return;
    // A move previewed through the physics state has to be put back through it
    // as well, or a cancelled gesture leaves the body where the pointer left it
    // while the scene graph still says otherwise.
    if (state.kind === 'move' && state.joint && state.startPos) {
      for (let axis = 0; axis < 3; axis++) getPhysicsWorkerClient().setQpos(state.joint, axis, state.startPos[axis]);
    }
    for (const held of state.held) {
      held.object.scale.set(1, 1, 1);
      held.object.position.copy(held.position);
    }
    for (const ghost of state.ghosts) ghost.removeFromParent();
    gesture.current = null;
    setGestureStatus(null);
    setOrbitEnabled(true);
  }, [setGestureStatus, setOrbitEnabled]);

  const end = useCallback((keep: boolean) => {
    const state = gesture.current;
    if (!state) return;
    const { kind, nodeId, factor } = state;
    const axis = state.axis;
    // The cancel path inside clear() puts a previewed move back; a kept move is
    // written from the numbers held here, which clear() does not touch.
    clear();
    if (kind === 'move') {
      const to = state.to;
      if (!keep || !to || !state.startPos) return;
      if (to.every((v, i) => Math.abs(v - state.startPos![i]) < 1e-6)) return;
      useStore.getState().updateNodePos(nodeId, to);
      // The scene graph now agrees with where the body is; put the live sim
      // there too, since updateNodePos alone would wait for a reset.
      if (state.joint) {
        for (let axis = 0; axis < 3; axis++) getPhysicsWorkerClient().setQpos(state.joint, axis, to[axis]);
      }
      return;
    }
    if (!keep || Math.abs(factor - 1) < 0.001) return;
    if (kind === 'scale') {
      const per = (a: Axis) => (axis === null || axis === a ? factor : 1);
      scaleNodeTree(nodeId, per('x'), per('y'), per('z'));
      return;
    }
    // The same numbers the ghost was drawn with, so what is cut is what was
    // shown. `scale` was computed from the live gesture, which `clear` has
    // already ended, so it is recomputed from what was kept.
    const bore = axis ?? 'z';
    const through = 1.05;
    useStore.getState().insetNodeGeoms(nodeId, [
      bore === 'x' ? through : factor,
      bore === 'y' ? through : factor,
      bore === 'z' ? through : factor,
    ]);
  }, [clear]);

  const begin = useCallback((kind: 'scale' | 'inset' | 'move') => {
    if (gesture.current) return;
    const store = useStore.getState();
    const nodeId = store.selectedNodeId;
    // The lattice and sculpt tools have their own S and I, on the thing being
    // edited rather than on the body as a whole.
    if (!nodeId || store.latticeNodeId || store.sculptNodeId || store.paintMode) return;
    // Measuring is a mode of its own, and it has the pointer.
    if (store.measureMode) return;
    const groups = groupsFor(nodeId);
    if (groups.length === 0) return;

    const box = new THREE.Box3();
    for (const group of groups) box.union(new THREE.Box3().setFromObject(group));
    if (box.isEmpty()) return;
    const worldPivot = box.getCenter(new THREE.Vector3());
    // Group positions are in their PARENT's frame, which is the Z-up group the
    // whole scene graph is drawn inside — so the pivot has to be brought into
    // that frame before it is arithmetic with them. Mixing the two is what sent
    // the preview sideways.
    const parent = groups[0].parent;
    const pivot = parent ? parent.worldToLocal(worldPivot.clone()) : worldPivot.clone();

    const projected = worldPivot.clone().project(camera);
    const rect = gl.domElement.getBoundingClientRect();
    const centre = {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
    };

    const held = groups.map((object) => ({ object, position: object.position.clone() }));

    if (kind === 'move') {
      const parent = groups[0].parent;
      const node = findNode(store.sceneGraph.nodes, nodeId);
      if (!parent || !node) return;
      // The body's own position, not the bounding box centre: that is the
      // number being changed, and a mesh's box centre is somewhere else.
      const startPos: [number, number, number] = [node.pos[0], node.pos[1], node.pos[2]];
      const through = new THREE.Vector3(...startPos);
      const from = planeHit(parent, pointer.current.x, pointer.current.y, through, null);
      if (!from) return;
      gesture.current = {
        kind, nodeId, centre, pivot, held, ghosts: [], axis: null, factor: 1,
        radius: 0, from, startPos, to: [...startPos] as [number, number, number],
        joint: node.joints?.find((j) => j.type === 'free')?.name,
      };
      setOrbitEnabled(false);
      draw();
      return;
    }

    const ghosts: THREE.Object3D[] = [];
    if (kind === 'inset') {
      // A hole is easier to judge as a shape than as a number, and the body it
      // is being cut out of stays where it is while you judge it.
      for (const group of groups) {
        const ghost = group.clone(true);
        ghost.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) mesh.material = GHOST_MATERIAL;
        });
        // Beside the group it was copied from, not at the root: the clone's
        // transform means what its parent says it means, and the scene root is
        // a different frame from the one bodies are drawn in.
        (group.parent ?? scene).add(ghost);
        ghosts.push(ghost);
      }
    }

    gesture.current = {
      kind, nodeId, centre, pivot, held, ghosts, axis: null, factor: 1,
      radius: Math.hypot(pointer.current.x - centre.x, pointer.current.y - centre.y),
    };
    setOrbitEnabled(false);
    draw();
  }, [camera, draw, gl, groupsFor, planeHit, scene, setOrbitEnabled]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      const running = gesture.current;
      if (running) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (key === 'escape') end(false);
        else if (key === 'enter' || key === ' ') end(true);
        else if (key === 'x' || key === 'y' || key === 'z') {
          running.axis = running.axis === key ? null : (key as Axis);
          draw();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (key === 'g' || key === 'm') { begin('move'); return; }
      if (key !== 's' && key !== 'i') return;
      begin(key === 's' ? 'scale' : 'inset');
    };
    // Capture, so a gesture in progress answers the key before anything else
    // in the app reads it.
    window.addEventListener('keydown', onKey, true);
    // The status bar's mode menu asks for the same gestures by name, for
    // anybody who has not learned the keys — or has no keyboard to hand.
    const onAsked = (event: Event) => {
      // The same event carries the measure tool's modes (see MeasureTool), so
      // the kinds this controller owns are named rather than assumed.
      const kind = (event as CustomEvent<{ kind: string }>).detail?.kind;
      if (kind === 'move' || kind === 'scale' || kind === 'inset') begin(kind);
    };
    window.addEventListener('physbox:gesture', onAsked);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('physbox:gesture', onAsked);
    };
  }, [begin, draw, end]);

  /*
   * The pointer handlers are registered ONCE and read the current callbacks out
   * of a ref, rather than being re-registered whenever one of them changes.
   *
   * They used to depend on [clear, draw, end], and the cleanup of that effect
   * puts a running gesture back. `draw` is rebuilt whenever the camera object
   * changes identity — which react-three-fiber does on a camera override, a
   * view switch, a canvas resize — so a re-render at the wrong moment tore the
   * listeners down mid-drag and silently cancelled the move. It looked like the
   * body simply refusing to move: the gesture starts, the readout says "Move",
   * and then nothing tracks the pointer.
   *
   * Registering once removes the race entirely, and the gesture is still put
   * back on unmount, which is the case the cleanup was there for.
   */
  const handlers = useRef({ draw, end, clear });
  useEffect(() => {
    handlers.current = { draw, end, clear };
  }, [clear, draw, end]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!gesture.current) return;
      pointer.current = { x: event.clientX, y: event.clientY };
      handlers.current.draw();
    };
    const down = (event: PointerEvent) => {
      if (!gesture.current) return;
      event.preventDefault();
      event.stopPropagation();
      handlers.current.end(event.button === 0);
    };
    const swallow = (event: Event) => {
      if (!gesture.current) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', swallow, true);
    window.addEventListener('contextmenu', swallow, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', swallow, true);
      window.removeEventListener('contextmenu', swallow, true);
      handlers.current.clear();
    };
  }, []);

  return null;
};

export default ObjectGestureController;
