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
// So S scales the selected body and I bores into it. Both are modal: move the
// pointer to size it, click or Enter to keep it, Esc or right-click to put it
// back, and X/Y/Z confine it to one axis on the way.
//
// I is not the lattice tool's face inset, although it shares the key: a solid
// body has no faces to pick, only a shape to cut into. It bores in from the
// face under the pointer, right through or, with P, as a pocket with a floor.
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
import { scaleNodeTree, boreFactors, BORE_OVERSHOOT, type Bore } from '../../utils/scaleNode';
import { pickCutSpot, type CutSpot } from '../../utils/csg';
import { bodyPoseOf, toParentFrame } from './bodyPose';
import { solveScaleToFit, type MateFeature } from '../../utils/mateSnap';
import { bodyFeatures, neighbourFeatures, documentAxes, graphAxes } from '../../utils/mateFeatures';
import { snapToFloor, snapThreshold } from '../../utils/floorSnap';
import { useOrbitEnable } from './useOrbitEnable';

type Axis = 'x' | 'y' | 'z';

/** What a group looked like before the gesture touched it. */
interface Held {
  object: THREE.Object3D;
  position: THREE.Vector3;
}

interface Gesture {
  kind: 'scale' | 'inset' | 'move' | 'moveCut';
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
  /**
   * Move only: the `pos[2]` that rests this body's lowest point on the floor,
   * and how far away the camera was — the two things the floor snap needs. The
   * gizmo's arrows settle onto the ground the same way; a move made from the
   * keyboard is the same move and should land the same place.
   */
  groundZ?: number;
  distance?: number;
  /** Move-cut only: which of the body's geoms is the cut, and where it is going. */
  geomIndex?: number;
  spot?: CutSpot | null;
  /**
   * Scale only: the body's holes and bosses at the size it started, and the
   * ones around it, so the gesture can be pulled toward a size that fits.
   *
   * Read once when the gesture begins. The moving side is deliberately taken at
   * the START size — the factor is relative to that, so measuring it again mid
   * gesture would be measuring against a body that has already been scaled.
   */
  ownAxes?: MateFeature[];
  nearAxes?: MateFeature[];
  /**
   * Bore only. The body's rotation (body → the frame bodies are drawn in), the
   * camera in that frame, the body axis and face the pointer was on when the
   * key was pressed, and whether it stops short as a pocket.
   */
  rot?: THREE.Matrix3;
  eye?: THREE.Vector3;
  aim?: { axis: 0 | 1 | 2; side: 1 | -1 };
  pocket?: boolean;
}

const AXES: Axis[] = ['x', 'y', 'z'];

/** A body axis, as a direction in the frame bodies are drawn in. */
const bodyAxisDir = (rot: THREE.Matrix3, axis: number) => new THREE.Vector3().setFromMatrix3Column(rot, axis);

/** The component of a vector that is largest, and so the axis it most nearly is. */
const dominant = (v: THREE.Vector3): 0 | 1 | 2 => {
  const c = [Math.abs(v.x), Math.abs(v.y), Math.abs(v.z)];
  return (c[0] >= c[1] && c[0] >= c[2] ? 0 : c[1] >= c[2] ? 1 : 2);
};

/** The body axis that lies closest to a world axis. */
const bodyAxisNearest = (rot: THREE.Matrix3, world: number): 0 | 1 | 2 => {
  const e = rot.elements; // column-major: column i is body axis i
  let best = 0;
  for (let i = 1; i < 3; i++) if (Math.abs(e[i * 3 + world]) > Math.abs(e[best * 3 + world])) best = i;
  return best as 0 | 1 | 2;
};

/** A direction named as the world axis it is nearest, signed when that matters. */
const worldName = (dir: THREE.Vector3, signed: boolean) => {
  const k = dominant(dir);
  return `${signed ? (dir.getComponent(k) < 0 ? '−' : '+') : ''}${'XYZ'[k]}`;
};

/*
 * Which way the bore runs, and which face it opens on.
 *
 * From the face under the pointer when I was pressed: that is the face you
 * were looking at, and it was the only reasonable reading of "inset this" —
 * a bore that always ran along Z opened the top and bottom of a cube
 * whichever side you pointed at. X/Y/Z take over, and mean the WORLD's axes,
 * the ones on screen: on a rotated body the body axis nearest the one
 * pressed, opening on whichever of its two faces is towards the camera.
 */
function boreOf(state: Gesture): Bore {
  let aim = state.aim ?? { axis: 2 as const, side: 1 as const };
  if (state.axis && state.rot) {
    const axis = bodyAxisNearest(state.rot, AXES.indexOf(state.axis));
    const toEye = state.eye ? state.eye.clone().sub(state.pivot) : null;
    const side = toEye && bodyAxisDir(state.rot, axis).dot(toEye) < 0 ? -1 : 1;
    aim = { axis, side };
  }
  return { axis: aim.axis, open: state.pocket ? aim.side : 0 };
}

/**
 * Where a set of drawn objects starts and ends along a direction, in `parent`'s
 * frame. From each mesh's own bounding box, so a rotated body is measured along
 * its own axis rather than by a world-aligned box around it.
 */
const spanAlong = (objects: THREE.Object3D[], parent: THREE.Object3D, dir: THREE.Vector3): [number, number] | null => {
  const toParent = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const m = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let lo = Infinity;
  let hi = -Infinity;
  for (const object of objects) {
    object.updateMatrixWorld(true);
    object.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      const box = mesh.geometry.boundingBox;
      if (!box || box.isEmpty()) return;
      m.multiplyMatrices(toParent, mesh.matrixWorld);
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const t = p.set(x, y, z).applyMatrix4(m).dot(dir);
        if (t < lo) lo = t;
        if (t > hi) hi = t;
      }
    });
  }
  return hi > lo ? [lo, hi] : null;
};

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

/**
 * How far around a body to look for a hole worth matching, when scaling it.
 *
 * Generous, and deliberately more so than the mate snap's reach: a part is
 * usually sized BEFORE it is brought over to the thing it has to fit, so the
 * bore you mean is often still across the bench rather than under the part.
 */
const SCALE_REACH_M = 0.35;

/** How much wider the fit's band is than an ordinary snap's. See its use. */
const SCALE_BAND_WEIGHT = 3;

export const ObjectGestureController = () => {
  const { scene, camera, gl } = useThree();
  const gesture = useRef<Gesture | null>(null);
  const pointer = useRef({ x: 0, y: 0, alt: false });
  const setGestureStatus = useStore((s) => s.setGestureStatus);
  const setOrbitEnabled = useOrbitEnable();

  useEffect(() => {
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY, alt: event.altKey };
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
     * A bore runs INTO the body, along one of its axes.
     *
     * A copy shrunk on all three axes is a sealed cavity: correct arithmetic,
     * useless result. Nothing about the body changes on the outside, so it
     * reads as an operation that did not happen — which is exactly how it was
     * reported. So the copy shrinks across the bore and OVERSHOOTS along it,
     * at both ends or, as a pocket, at the face it opens on (see boreFactors).
     */
    return new THREE.Vector3(...boreFactors(state.factor, boreOf(state)));
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

    if (state.kind === 'moveCut') {
      /*
       * A hole slides over the part it is in. The pointer's ray is taken into
       * the body's own frame and probed against the body's SOURCE shapes — the
       * same probe a click uses to aim a new cut — so the hole lands on
       * whatever face is under the pointer, square to it, and cannot come off
       * the part: off the part there is nothing to hit, and the hole stays
       * where it last was.
       */
      const ghost = state.ghosts[0];
      const parent = ghost?.parent;
      if (!ghost || !parent) return;
      const node = findNode(useStore.getState().sceneGraph.nodes, state.nodeId);
      if (!node) return;
      const ray = rayIn(parent, pointer.current.x, pointer.current.y);
      const pose = bodyPoseOf(state.nodeId, node.pos);
      const toBody = pose.rot.clone().transpose();
      const origin = ray.origin.clone().sub(pose.pos).applyMatrix3(toBody);
      const direction = ray.direction.clone().applyMatrix3(toBody).normalize();
      const spot = pickCutSpot(node, origin.toArray(), direction.toArray());
      if (spot) state.spot = spot;
      const shown = state.spot;
      if (shown) {
        const at = new THREE.Vector3(...(shown.at as [number, number, number])).applyMatrix3(pose.rot).add(pose.pos);
        const normal = new THREE.Vector3(...(shown.normal as [number, number, number])).applyMatrix3(pose.rot).normalize();
        ghost.position.copy(at);
        ghost.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
        const mm = (v: number) => (v * 1000).toFixed(1);
        setGestureStatus(`Move cut · at ${shown.at.map(mm).join(', ')} mm`);
      } else {
        setGestureStatus('Move cut · point at the part');
      }
      return;
    }

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
      /*
       * Settle onto the floor on the way past, exactly as the gizmo's up arrow
       * does — the value almost everyone is after is "resting on the ground",
       * and it is the one a freehand move never lands on. Only while Z is free
       * to move: held to X or Y it does not change at all. Alt turns it off.
       */
      let resting = false;
      if ((!state.axis || state.axis === 'z') && state.groundZ !== undefined) {
        const snap = snapToFloor({
          z: to[2],
          groundZ: state.groundZ,
          threshold: pointer.current.alt
            ? 0
            : snapThreshold(
                (camera as THREE.PerspectiveCamera).fov ?? 50,
                state.distance ?? 1,
                gl.domElement.clientHeight,
              ),
        });
        to[2] = snap.z;
        resting = snap.locked;
      }
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
      setGestureStatus(
        (said.length === 0 ? 'Move' : `Move ${said.join(' · ')}`) +
        (resting ? ' · resting on floor' : ''),
      );
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

    /*
     * Pulled toward a size that actually fits something nearby.
     *
     * The concentric mate lines a peg up with a bore, but a peg of the wrong
     * diameter still will not go in, and closing that last fraction of a
     * millimetre meant reading one diameter off the model and typing the other.
     * So a scale near a hole is drawn to the factor that matches it, under the
     * same curve as every other snap — and Alt turns it off, like all of them.
     *
     * Skipped while an axis is held: X, Y or Z alone makes an ellipse of a
     * circle, and there is no single diameter left for it to be matching.
     */
    let fitted: ReturnType<typeof solveScaleToFit> = null;
    if (state.kind === 'scale' && !state.axis && !pointer.current.alt && state.ownAxes && state.nearAxes) {
      fitted = solveScaleToFit({
        moving: state.ownAxes,
        fixed: state.nearAxes,
        factor: state.factor,
        // Wider than a move's band, deliberately. Sizing is the coarser
        // gesture: a pixel of pointer travel is about a third of a millimetre
        // of radius here, so a band as tight as the floor snap's would be a
        // handful of pixels wide and would be crossed without being felt.
        threshold: SCALE_BAND_WEIGHT * snapThreshold(
          (camera as THREE.PerspectiveCamera).fov ?? 50,
          camera.position.distanceTo(state.pivot),
          gl.domElement.clientHeight,
        ),
      });
      if (fitted) state.factor = fitted.factor;
    }

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
    // A pocket slides the ghost along the bore until it stands just past the
    // face it opens on — the same slide insetNegatives gives the real cut.
    const bore = state.kind === 'inset' ? boreOf(state) : null;
    const boreDir = bore && state.rot ? bodyAxisDir(state.rot, bore.axis) : null;
    const parent = state.ghosts[0]?.parent;
    if (bore && bore.open !== 0 && boreDir && parent) {
      const body = spanAlong(state.held.map((h) => h.object), parent, boreDir);
      const ghost = spanAlong(state.ghosts, parent, boreDir);
      if (body && ghost) {
        const overshoot = BORE_OVERSHOOT * (body[1] - body[0]);
        const d = bore.open > 0 ? body[1] + overshoot - ghost[1] : body[0] - overshoot - ghost[0];
        for (const g of state.ghosts) g.position.addScaledVector(boreDir, d);
      }
    }
    const fitSaid = fitted?.locked
      // The diameter, because that is the number on the drawing and on the
      // drill bit — nobody asks for a six-millimetre-radius hole.
      ? ` · ⌀${(fitted.radius * 2000).toFixed(2)} mm · ${fitted.label}`
      : '';
    const boreSaid = !bore || !boreDir ? ''
      : bore.open === 0
        ? `Bore through ${worldName(boreDir, false)} ${state.factor.toFixed(2)}× · P for a pocket`
        : `Pocket from ${worldName(boreDir.clone().multiplyScalar(bore.open), true)} ${state.factor.toFixed(2)}× · P to go through`;
    setGestureStatus(state.kind === 'scale'
      ? `Scale ${state.factor.toFixed(2)}×${state.axis ? ` · ${state.axis.toUpperCase()}` : ''}${fitSaid}`
      : boreSaid);
  }, [camera, gl, planeHit, rayIn, setGestureStatus]);

  /**
   * Ends the gesture and takes the preview down.
   *
   * `restore` is what a CANCELLED move needs and a kept one must not have. The
   * preview is written into the physics state, so putting it back means writing
   * the start position into qpos — and the worker answers every such write with
   * a frame. Doing that on the way to keeping a move sent the body back to where
   * it started for one frame and then forward again, a flinch visible on the
   * body and unmissable on the gizmo drawn around it.
   */
  const clear = useCallback((restore = true) => {
    const state = gesture.current;
    if (!state) return;
    // A move previewed through the physics state has to be put back through it
    // as well, or a cancelled gesture leaves the body where the pointer left it
    // while the scene graph still says otherwise.
    if (restore && state.kind === 'move' && state.joint && state.startPos) {
      for (let axis = 0; axis < 3; axis++) getPhysicsWorkerClient().setQpos(state.joint, axis, state.startPos[axis]);
    }
    for (const held of state.held) {
      held.object.scale.set(1, 1, 1);
      held.object.position.copy(held.position);
    }
    for (const ghost of state.ghosts) ghost.removeFromParent();
    // A cutter's ghost owns the geometry made for it; an inset's ghosts are
    // clones sharing the body's own, which must not be disposed.
    if (state.kind === 'moveCut') for (const ghost of state.ghosts) (ghost as THREE.Mesh).geometry?.dispose();
    gesture.current = null;
    setGestureStatus(null);
    setOrbitEnabled(true);
  }, [setGestureStatus, setOrbitEnabled]);

  const end = useCallback((keep: boolean) => {
    const state = gesture.current;
    if (!state) return;
    const { kind, nodeId, factor } = state;
    const axis = state.axis;
    // Read before clear() ends the gesture it is read from.
    const bore = kind === 'inset' ? boreOf(state) : null;
    // The cancel path inside clear() puts a previewed move back; a kept move is
    // written from the numbers held here, which clear() does not touch — and
    // must not be put back first, or the body flinches to its old position for
    // a frame on the way to its new one.
    clear(!(keep && kind === 'move'));
    if (kind === 'moveCut') {
      if (!keep || !state.spot || state.geomIndex === undefined) return;
      useStore.getState().moveCutTo(nodeId, state.geomIndex, state.spot);
      return;
    }
    if (kind === 'move') {
      const to = state.to;
      if (!keep || !to || !state.startPos) return;
      if (to.every((v, i) => Math.abs(v - state.startPos![i]) < 1e-6)) return;
      // `pos` is relative to the parent body; `to` is where the pointer left
      // it, in the world. See toParentFrame.
      useStore.getState().updateNodePos(nodeId, toParentFrame(nodeId, to));
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
    if (!bore) return;
    useStore.getState().insetNodeGeoms(
      nodeId,
      boreFactors(factor, bore),
      bore.open === 0 ? undefined : { axis: bore.axis, side: bore.open },
    );
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
      // With a cut picked in the hierarchy, G moves the cut, not the body it
      // is in: a hole is the thing most often in the wrong place by a few
      // millimetres, and the body is not.
      const node = findNode(store.sceneGraph.nodes, nodeId);
      const cut = node?.geoms?.[store.activeGeomIndex];
      if (node && cut && cut.csg === 'difference' && !cut.csgDerived && cut.cutAt) {
        const parent = groups[0].parent;
        if (!parent) return;
        // A stub of the cutter, drawn where the pointer says the hole would
        // go. Three times its own radius long: enough to read as "this way
        // in", short enough not to hide the face it is on.
        const size = cut.size || [];
        const r = Math.max(1e-4, size[0] ?? 0.005);
        let geometry: THREE.BufferGeometry;
        if (cut.type === 'box') geometry = new THREE.BoxGeometry(2 * r, 2 * Math.max(1e-4, size[1] ?? r), 3 * r);
        else if (cut.type === 'sphere') geometry = new THREE.SphereGeometry(r, 24, 16);
        else geometry = new THREE.CylinderGeometry(r, r, 3 * r, 32).rotateX(Math.PI / 2);
        const ghost = new THREE.Mesh(geometry, GHOST_MATERIAL);
        parent.add(ghost);
        gesture.current = {
          kind: 'moveCut', nodeId, centre, pivot, held: [], ghosts: [ghost], axis: null, factor: 1,
          radius: 0, geomIndex: store.activeGeomIndex,
          spot: { at: [...cut.cutAt], normal: [...(cut.cutNormal ?? [0, 0, 1])] },
        };
        setOrbitEnabled(false);
        draw();
        return;
      }
      const parent = groups[0].parent;
      // `node` was found above, for the cut check.
      if (!parent || !node) return;
      // The body's own position, not the bounding box centre: that is the
      // number being changed, and a mesh's box centre is somewhere else.
      const startPos: [number, number, number] = [node.pos[0], node.pos[1], node.pos[2]];
      const through = new THREE.Vector3(...startPos);
      const from = planeHit(parent, pointer.current.x, pointer.current.y, through, null);
      if (!from) return;
      // The box is in world (Y-up) space; the move is in the Z-up frame the
      // groups' parent defines, so it is brought across before the body's
      // lowest point is subtracted from its position.
      const local = box.clone().applyMatrix4(parent.matrixWorld.clone().invert());
      gesture.current = {
        kind, nodeId, centre, pivot, held, ghosts: [], axis: null, factor: 1,
        radius: 0, from, startPos, to: [...startPos] as [number, number, number],
        joint: node.joints?.find((j) => j.type === 'free')?.name,
        groundZ: startPos[2] - local.min.z,
        distance: camera.position.distanceTo(worldPivot),
      };
      setOrbitEnabled(false);
      draw();
      return;
    }

    const ghosts: THREE.Object3D[] = [];
    let boreStart: Pick<Gesture, 'rot' | 'eye' | 'aim' | 'pocket'> = {};
    if (kind === 'inset') {
      const node = findNode(store.sceneGraph.nodes, nodeId);
      const rot = bodyPoseOf(nodeId, node?.pos ?? [0, 0, 0]).rot;
      const parent = groups[0].parent;
      const eye = parent ? parent.worldToLocal(camera.position.clone()) : camera.position.clone();
      // The face under the pointer, as a body axis and a side of it. Taken
      // before the ghosts exist, so the ray cannot land on one of them.
      const rect = gl.domElement.getBoundingClientRect();
      const caster = new THREE.Raycaster();
      caster.setFromCamera(new THREE.Vector2(
        ((pointer.current.x - rect.left) / rect.width) * 2 - 1,
        -(((pointer.current.y - rect.top) / rect.height) * 2 - 1),
      ), camera);
      const hit = caster.intersectObjects(groups, true).find((h) => h.face && (h.object as THREE.Mesh).isMesh);
      let aim: { axis: 0 | 1 | 2; side: 1 | -1 };
      if (hit && parent) {
        const normal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld)
          .transformDirection(new THREE.Matrix4().copy(parent.matrixWorld).invert())
          .applyMatrix3(rot.clone().transpose());
        const axis = dominant(normal);
        aim = { axis, side: normal.getComponent(axis) < 0 ? -1 : 1 };
      } else {
        // Off the body: the axis nearest up, opening towards the camera, which
        // on an unrotated body is the old default of Z.
        const axis = bodyAxisNearest(rot, 2);
        aim = { axis, side: bodyAxisDir(rot, axis).dot(eye.clone().sub(pivot)) < 0 ? -1 : 1 };
      }
      boreStart = { rot, eye, aim, pocket: false };
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

    /*
     * Only a scale is sized to fit, and only it pays for the hunt. An inset is
     * cutting a hole rather than matching one, and a move has its own snapping.
     */
    const groupsHere = groupsFor(nodeId);
    const here: [number, number, number] = [pivot.x, pivot.y, pivot.z];
    const graph = useStore.getState().sceneGraph?.nodes ?? [];
    const self = findNode(graph, nodeId);
    /*
     * From the drawn scene AND from the document. The drawn scene has the
     * cylinder a plain body is made of; only the document still has the cut
     * that made a hole, and a hole is the thing most worth sizing to.
     */
    const ownAxes = kind === 'scale'
      ? [
          ...bodyFeatures(groupsHere, nodeId),
          ...(self ? documentAxes(self, bodyPoseOf(nodeId, self.pos)) : []),
        ]
      : undefined;
    const nearAxes = kind === 'scale'
      ? [
          ...neighbourFeatures(scene, nodeId, here, SCALE_REACH_M),
          ...graphAxes(graph, bodyPoseOf, { exclude: nodeId, near: here, radius: SCALE_REACH_M }),
        ]
      : undefined;

    gesture.current = {
      kind, nodeId, centre, pivot, held, ghosts, axis: null, factor: 1,
      radius: Math.hypot(pointer.current.x - centre.x, pointer.current.y - centre.y),
      ownAxes,
      nearAxes,
      ...boreStart,
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
        } else if (key === 'p' && running.kind === 'inset') {
          running.pocket = !running.pocket;
          draw();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // While the simulation runs, letters belong to the control scripts:
      // the docs suggest WASD and arrows, and S here scaled the selection
      // while it was meant to steer a cart.
      if (useStore.getState().isPlaying) return;
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
      // Not under a running simulation, whoever asks: the solver moves the
      // body every step, and a gesture moving it too is the two fighting.
      if (useStore.getState().isPlaying) return;
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
      pointer.current = { x: event.clientX, y: event.clientY, alt: event.altKey };
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
