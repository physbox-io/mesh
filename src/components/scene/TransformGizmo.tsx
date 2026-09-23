// ---------------------------------------------------------------------------
// Moving and turning a body by hand, while the sim is paused
// ---------------------------------------------------------------------------
//
// Until now a body was moved either from three sliders in the sidebar — a long
// way from the model, and in numbers rather than in the scene — or through the
// modal `g`/`m` keyboard gesture, which you have to know about first. Neither
// is the thing people reach for, which is a handle on the object.
//
// So while the sim is paused the selected body gets arrows to drag, and `r`
// swaps them for rings to turn it by. Paused is the whole point: while the sim
// runs, MuJoCo owns where everything is, and a handle that fights it every
// frame would be a lie.
//
// Three things here are not obvious, and each of them was a bug first:
//
// 1. THE GIZMO IS ON A PROXY, NOT ON THE BODY. A dynamic body's group is
//    rewritten from `data.xpos` every frame whether or not the sim is playing
//    (SceneLayer's per-geom useFrame), so a gizmo attached to the group is
//    overwritten sixty times a second and the drag goes nowhere. The proxy is
//    an empty Object3D the gizmo owns; the drag is *pushed* out of it into the
//    world, never read back from the body.
//
// 2. THE PROXY IS INSIDE THE Z-UP GROUP AND THE CONTROL IS NOT. The scene is
//    drawn inside a group rotated `[-PI/2, 0, 0]` to turn MuJoCo's Z-up into
//    Three's Y-up, and inside it local coordinates ARE MuJoCo world
//    coordinates — which is what lets the drag arithmetic below be written in
//    MuJoCo's frame with no conversions. But `TransformControls` writes the
//    attached object's WORLD transform into its OWN LOCAL one, so it only works
//    as a child of the scene root: parented to the Z-up group it applied that
//    rotation twice and laid the blue Z handle flat along the ground, pointing
//    at MuJoCo −Y while the orientation legend in the corner showed Z up.
//
// 3. IT DOES NOT TOUCH THE STORE UNTIL THE DRAG ENDS. Every `updateNodePos` is
//    a rebuild of the model, so a drag that wrote per frame would be unusable.
//    The preview goes through whichever channel the body has — qpos, the group
//    transform, or a ghost — and the scene graph hears about it once, on mouse
//    up. See ObjectGestures, which solves the same problem for the keyboard
//    gestures and is the source of the preview and commit shapes used here.
// ---------------------------------------------------------------------------

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Line, TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import { useStore, getPhysicsWorkerClient } from '../../store/useStore';
import type { SceneNode } from '../../types/scene';
import { positiveBounds } from '../../utils/csg';
import { snapToFloor, snapThreshold } from '../../utils/floorSnap';
import { getStickyRotation } from '../../utils/geom';
import { solveMate, solveAlignAboutAxis, type MateFeature, type MateSolution, type AlignSolution } from '../../utils/mateSnap';
import { bodyFeatures, neighbourFeatures, transformFeatures, documentAxes, graphAxes } from '../../utils/mateFeatures';
import { bodyPoseOf } from './bodyPose';
import { setGizmoBusy } from './gizmoBusy';

/** Turning while Shift is held lands on these, the way a protractor does. */
const ROTATION_SNAP_DEG = 15;

/**
 * What is drawn while a snap is holding the drag.
 *
 * One union rather than two overlays, because only ever one of them is live —
 * a mate that fires takes the drag over, and the floor is left with whatever
 * directions the mate did not constrain. Two hints on screen at once would be
 * two claims about where the part is going.
 */
type Hint =
  | { type: 'floor'; x: number; y: number; r: number; strength: number }
  | {
      type: 'mate';
      kind: MateSolution['kind'];
      from: [number, number, number];
      to: [number, number, number];
      strength: number;
      axis?: { point: number[]; dir: number[]; radius: number };
      plane?: { point: number[]; normal: number[]; extent: number };
    }
  | { type: 'align'; from: AlignSolution['from']; to: AlignSolution['to']; strength: number };

/** The hint's colours, matching the measure tool's so a snap reads the same everywhere. */
const HINT_COLOUR: Record<string, number> = {
  point: 0x22d3ee,
  axis: 0xf59e0b,
  face: 0x38bdf8,
  align: 0xa78bfa,
};

/**
 * How far out to look for something to mate with, around the dragged body.
 *
 * Its own size plus a margin in snap-bands: a part only mates with what it is
 * nearly touching, so the reach only has to cover the band plus however far the
 * drag may wander before the gather is refreshed. Capped so that a crowded
 * scene cannot turn one mouse-down into a circle fit on every mesh in it.
 */
const GATHER_MARGIN_BANDS = 8;
const MAX_GATHER_M = 0.5;

/**
 * How a drag is shown before it is committed.
 *
 * `qpos` is the good case: a free body has a joint whose position can be
 * written straight into the running model, and the worker runs `mj_forward` and
 * posts a frame, so a paused body redraws at once. `group` is for a body MuJoCo
 * does not move — its `useFrame` early-returns, so writing the group transform
 * sticks. `ghost` is the awkward one: a hinged or sliding body is driven per
 * frame but has no free joint to write, so the drag is shown as a translucent
 * copy and the body itself catches up when the rebuild lands.
 */
type Channel = 'qpos' | 'group' | 'ghost';

/** The two sets of handles, both drawn at once. */
type Mode = 'translate' | 'rotate';

interface Drag {
  nodeId: string;
  /** Which set of handles was grabbed — the arrows or the rings. */
  mode: Mode;
  /** Whether the pointer actually took the body anywhere. */
  moved: boolean;
  channel: Channel;
  joint?: string;
  /**
   * Where the handles started — the body's visual centre, not its origin.
   *
   * These are different things for most bodies, and the handles belong on the
   * one you can see. The store and MuJoCo both want the other, so the drag is
   * measured here as a delta and added to `originStart` on the way out.
   */
  startPos: [number, number, number];
  /** Where the BODY started: its origin, which is what qpos and `pos` mean. */
  originStart: [number, number, number];
  /** The handles' own start orientation — world axes, so effectively identity. */
  startQuat: THREE.Quaternion;
  /** The BODY's start orientation, which a turn is composed onto. */
  startBodyQuat: THREE.Quaternion;
  /** The `pos[2]` that puts the body's lowest point on z = 0. */
  groundZ: number;
  /** How far the camera was from the body — the snap band is sized from it. */
  distance: number;
  /** Half the body's footprint, so the floor hint is drawn around it. */
  radius: number;
  held: { object: THREE.Object3D; position: THREE.Vector3; quaternion: THREE.Quaternion }[];
  ghosts: THREE.Object3D[];
  /**
   * The dragged body's own matable features, as they were when the drag began.
   *
   * Carried forward each frame by `transformFeatures` rather than re-read,
   * because mid-drag the scene is showing a preview: reading it back would
   * measure the body against where the drag has already put it.
   */
  moving: MateFeature[];
  /** Everything else's features. Nothing but this body moves while a drag runs. */
  fixed: MateFeature[];
  /** Where `fixed` was gathered, and how far around — so it can be refreshed. */
  gatheredAt: THREE.Vector3;
  gatherRadius: number;
}

const findNode = (nodes: SceneNode[], id: string): SceneNode | null => {
  for (const node of nodes) {
    if (node.id === id) return node;
    const child = findNode(node.children ?? [], id);
    if (child) return child;
  }
  return null;
};

/** Where the drag has put the body's ORIGIN, as opposed to its handles. */
const originOf = (state: Drag, position: THREE.Vector3): THREE.Vector3 =>
  position.clone().sub(new THREE.Vector3(...state.startPos)).add(new THREE.Vector3(...state.originStart));

/** How far the handles have been turned from where they started. */
const turnOf = (state: Drag, quaternion: THREE.Quaternion): THREE.Quaternion =>
  quaternion.clone().multiply(state.startQuat.clone().invert());

/**
 * Which ring is being dragged, as a direction in the frame the drag works in.
 *
 * `TransformControls` names the handle under the pointer — 'X', 'Y', 'Z', or
 * 'XYZE' for the outer ring that turns about the view. The named ones are the
 * proxy's OWN axes, because the controls are in `space="local"` and the proxy
 * lives inside the Z-up group, so its local frame is MuJoCo's world. The free
 * ring is left alone: a drag with no axis to confine the nudge to is exactly
 * the case the confinement exists to avoid.
 */
const ringAxis = (
  controls: { axis?: string | null } | null,
  proxy: THREE.Object3D,
): THREE.Vector3 | null => {
  let unit: THREE.Vector3;
  switch (controls?.axis) {
    case 'X': unit = new THREE.Vector3(1, 0, 0); break;
    case 'Y': unit = new THREE.Vector3(0, 1, 0); break;
    case 'Z': unit = new THREE.Vector3(0, 0, 1); break;
    default: return null;
  }
  /*
   * Through the proxy's own orientation, because the handles are LOCAL: the
   * blue ring on a body that has been turned on its side is not world Z. The
   * proxy lives inside the Z-up group, whose local coordinates are MuJoCo's
   * world, so this comes out in the frame the drag arithmetic uses.
   */
  return unit.applyQuaternion(proxy.quaternion).normalize();
};

/**
 * The body's orientation, as opposed to the handles'.
 *
 * The handles sit on world axes and never tilt, so what a ring drag produces
 * is a DELTA. The body's orientation is that delta applied to whatever it was
 * already at — which is the only form qpos and the store's Euler angles will
 * take.
 */
const bodyQuatOf = (state: Drag, quaternion: THREE.Quaternion): THREE.Quaternion =>
  turnOf(state, quaternion).multiply(state.startBodyQuat);


/*
 * The handles, in the app's own axis colours.
 *
 * `TransformControls` ships pure 0xff0000 / 0x00ff00 / 0x0000ff, which sit
 * beside the orientation legend in the corner of the viewport reading as a
 * different set of axes rather than the same ones — the hues agree but nothing
 * else does. These are the legend's exact colours (AxisLegendDrawer in App.tsx:
 * X red, Y green, Z blue, MuJoCo's axes), so the handle you grab looks like the
 * axis the corner is pointing at.
 *
 * Both `color` and `tempColor` are written. The control re-copies `tempColor`
 * over `color` every frame to undo its own hover highlight, and captures it
 * lazily the first time — so setting only `color` would survive one frame.
 */
const AXIS_COLOURS: [from: number, to: number][] = [
  [0xff0000, 0xef4444], // X
  [0x00ff00, 0x22c55e], // Y
  [0x0000ff, 0x3b82f6], // Z
];

type TintedMaterial = THREE.MeshBasicMaterial & { tempColor?: THREE.Color };

const paintHandles = (controls: THREE.Object3D) => {
  controls.traverse((object) => {
    const material = (object as THREE.Mesh).material as TintedMaterial | undefined;
    if (!material?.color) return;
    for (const [from, to] of AXIS_COLOURS) {
      if (material.color.getHex() !== from) continue;
      material.color.setHex(to);
      material.tempColor = material.color.clone();
      return;
    }
  });
};

/**
 * The union box of everything drawing this body, in the frame its groups live
 * in — which is the Z-up group, so the box is in MuJoCo world coordinates.
 *
 * `null` when there is nothing drawn yet: a body between its creation and its
 * first compile, or one of the static boxes that share a single InstancedMesh
 * and so have no group of their own to measure.
 */
const drawnBox = (groups: THREE.Object3D[]): THREE.Box3 | null => {
  if (groups.length === 0) return null;
  const parent = groups[0].parent;
  if (!parent) return null;
  const box = new THREE.Box3();
  for (const group of groups) box.union(new THREE.Box3().setFromObject(group));
  if (box.isEmpty()) return null;
  // Group boxes come out in world (Y-up) space; the drag happens in the Z-up
  // frame their parent defines. Mixing the two sent an earlier version's snap
  // sideways.
  return box.applyMatrix4(parent.matrixWorld.clone().invert());
};

/**
 * How wide to draw the floor hint: the body's own footprint, so it reads as
 * "this lands here" rather than as a fixed decal that a large part swallows.
 */
const ringRadius = (box: THREE.Box3 | null): number => {
  if (!box) return 0.05;
  const size = box.getSize(new THREE.Vector3());
  return THREE.MathUtils.clamp(Math.max(size.x, size.y) * 0.75, 0.02, 2);
};

const GHOST_MATERIAL = new THREE.MeshBasicMaterial({
  color: 0x38bdf8, transparent: true, opacity: 0.35, depthWrite: false,
});

/**
 * A small marker, sized in world units rather than pixels.
 *
 * The measure tool sizes its markers per frame from the camera; a drag hint is
 * only ever seen at the distance the drag is happening at, so a fraction of the
 * snap band it belongs to is steadier and costs nothing.
 */
const MARKER_R = 0.0016;

/** The dashed line and end markers of a mate that is pulling the drag. */
const MateHint = ({ hint }: { hint: Extract<Hint, { type: 'mate' }> }) => {
  const colour = HINT_COLOUR[hint.kind] ?? HINT_COLOUR.point;
  const opacity = 0.85 * hint.strength;
  const from = new THREE.Vector3(...hint.from);
  const to = new THREE.Vector3(...hint.to);
  // Rings are built in the XY plane, so one turn puts them on the face or
  // across the hole they belong to.
  const facing = (dir: number[]) =>
    new THREE.Quaternion().setFromUnitVectors(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(dir[0], dir[1], dir[2]).normalize(),
    );
  const axisEnds = hint.axis
    ? (() => {
        const dir = new THREE.Vector3(...hint.axis!.dir).normalize();
        const at = new THREE.Vector3(...hint.axis!.point);
        const reach = Math.max(hint.axis!.radius * 3, 0.01);
        return [at.clone().addScaledVector(dir, -reach), at.clone().addScaledVector(dir, reach)];
      })()
    : null;

  return (
    <group raycast={() => null} renderOrder={999}>
      {[from, to].map((at, i) => (
        <mesh key={i} position={at} raycast={() => null} renderOrder={999}>
          <sphereGeometry args={[MARKER_R, 12, 12]} />
          <meshBasicMaterial color={colour} transparent opacity={opacity} depthTest={false} toneMapped={false} />
        </mesh>
      ))}
      {axisEnds && (
        <Line
          points={axisEnds}
          color={colour}
          lineWidth={1.5}
          dashed
          dashSize={0.002}
          gapSize={0.002}
          transparent
          opacity={opacity}
          depthTest={false}
          toneMapped={false}
        />
      )}
      {hint.axis && (
        <mesh position={hint.axis.point as [number, number, number]} quaternion={facing(hint.axis.dir)} raycast={() => null} renderOrder={999}>
          <ringGeometry args={[hint.axis.radius * 0.92, hint.axis.radius, 48]} />
          <meshBasicMaterial color={colour} transparent opacity={opacity} depthTest={false} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      )}
      {hint.plane && (
        <mesh position={hint.plane.point as [number, number, number]} quaternion={facing(hint.plane.normal)} raycast={() => null} renderOrder={999}>
          <ringGeometry args={[hint.plane.extent * 0.88, hint.plane.extent, 56]} />
          <meshBasicMaterial color={colour} transparent opacity={opacity} depthTest={false} side={THREE.DoubleSide} toneMapped={false} />
        </mesh>
      )}
    </group>
  );
};

/** Two short normals, leaning toward each other as the turn comes into line. */
const AlignHint = ({ hint }: { hint: Extract<Hint, { type: 'align' }> }) => {
  const opacity = 0.85 * hint.strength;
  const arm = (at: number[], dir: number[]) => {
    const from = new THREE.Vector3(at[0], at[1], at[2]);
    const along = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize().multiplyScalar(0.012);
    return [from, from.clone().add(along)];
  };
  return (
    <group raycast={() => null} renderOrder={999}>
      {[arm(hint.from.point, hint.from.dir), arm(hint.to.point, hint.to.dir)].map((points, i) => (
        <Line
          key={i}
          points={points}
          color={HINT_COLOUR.align}
          lineWidth={1.5}
          dashed
          dashSize={0.0015}
          gapSize={0.0015}
          transparent
          opacity={opacity}
          depthTest={false}
          toneMapped={false}
        />
      ))}
    </group>
  );
};

export const TransformGizmo = () => {
  const { scene, camera, gl } = useThree();

  const isPlaying = useStore((s) => s.isPlaying);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const extraSelectedIds = useStore((s) => s.extraSelectedIds);
  const sceneGraph = useStore((s) => s.sceneGraph);
  const recompileId = useStore((s) => s.recompileId);
  const paintMode = useStore((s) => s.paintMode);
  const measureMode = useStore((s) => s.measureMode);
  const latticeNodeId = useStore((s) => s.latticeNodeId);
  const sculptNodeId = useStore((s) => s.sculptNodeId);
  const draggedNodeId = useStore((s) => s.draggedNodeId);
  const gestureStatus = useStore((s) => s.gestureStatus);
  const setGestureStatus = useStore((s) => s.setGestureStatus);
  /*
   * One set of handles at a time. Both at once was a thicket — the rings ran
   * through the arrowheads and neither could be aimed at confidently. A second
   * click on the body already selected swaps them (SceneLayer's click handler),
   * and `g` and `r` ask for one directly.
   */
  const mode = useStore((s) => s.gizmoMode);
  const setMode = useStore((s) => s.setGizmoMode);

  /*
   * The proxy is a ref, because the whole job here is to mutate it — and a
   * mounted flag beside it, because `TransformControls` attaches in a layout
   * effect and so needs a render in which the object already exists. Passing
   * the ref itself to the controls (they take one) keeps the render from having
   * to read it.
   */
  const proxyRef = useRef<THREE.Object3D>(null);
  /*
   * The controls themselves, kept only so the rotate snap can ask which ring is
   * under the pointer. Painting the handles already had the instance in hand.
   */
  const controlsRef = useRef<{ axis?: string | null } | null>(null);
  const [proxyMounted, setProxyMounted] = useState(false);
  const drag = useRef<Drag | null>(null);
  // Alt and Shift are read at the moment of a pointer move rather than
  // subscribed to, so picking one up mid-drag takes effect on the next move.
  const keys = useRef({ alt: false, shift: false });
  const pointer = useRef({ x: 0, y: 0 });
  /** The keyboard turn, while one is running — see `beginTurn` below. */
  const modal = useRef<{ axis: 'x' | 'y' | 'z'; centre: { x: number; y: number }; from: number } | null>(null);
  /*
   * A drag is otherwise invisible to render — it lives in a ref, because it is
   * mutated per pointer move. These two are the parts render needs: that a drag
   * is running at all, and where to draw the floor hint and how strongly.
   */
  const [dragging, setDragging] = useState(false);
  const [hint, setHint] = useState<Hint | null>(null);

  const node = selectedNodeId ? findNode(sceneGraph?.nodes ?? [], selectedNodeId) : null;

  /*
   * Every mode that owns the pointer, and the one selection shape this cannot
   * do yet. Moving several bodies means one `updateNodePos` and one rebuild
   * each; it wants a batched store action, so for now the gizmo steps aside and
   * the sidebar still works.
   */
  const suppressed =
    isPlaying || !node || extraSelectedIds.length > 0 ||
    paintMode || measureMode !== null || latticeNodeId !== null ||
    sculptNodeId !== null || draggedNodeId !== null;

  /*
   * A modal gesture — the `g` move, `r` turn, `s` scale — has the pointer, so
   * the handles must not answer it. They stay ON SCREEN though, following the
   * body as it goes: hiding them meant they vanished at the start of a move and
   * came back at the end still drawn around where the body used to be, which
   * read as the gizmo losing track of the object.
   */
  const foreignGesture = gestureStatus !== null && !dragging;

  /** Every group drawing this body. One per geom — see DynamicGeom. */
  const groupsFor = useCallback((nodeId: string) => {
    const found: THREE.Object3D[] = [];
    scene.traverse((object) => {
      if (object.name === nodeId && object.type === 'Group') found.push(object);
    });
    return found;
  }, [scene]);

  /*
   * Where the handles sit on the body: its VISUAL CENTRE, not its origin.
   *
   * Those coincide for a plain box and for almost nothing else — a mesh is
   * positioned by its centroid, a compound body's origin is wherever its first
   * geom's frame happens to be, and a cut body's is offset again. Parking on
   * the origin put the handles off the object, sometimes outside it entirely.
   *
   * Held in the body's OWN frame, so it stays right as the body turns, and
   * measured only when the body itself might have changed shape — a union box
   * over every drawn vertex is far too much to do per frame.
   */
  const centreOffset = useRef(new THREE.Vector3());
  // Reset only when the body itself changes: an offset measured on one body is
  // meaningless on the next, but is the best thing available for this one until
  // a fresh measurement can be taken.
  useEffect(() => { centreOffset.current.set(0, 0, 0); }, [selectedNodeId]);

  /*
   * Where the drag left the body, kept until the rebuild agrees.
   *
   * A commit is a `recompile`, and that is settled by ~180 ms — during which
   * the live pose is still the OLD one, so following it frame by frame snapped
   * the handles back to where the body started and then jumped them forward
   * when the rebuild landed. Holding the committed pose until `recompileId`
   * moves covers exactly that gap.
   */
  const settling = useRef<{ pos: THREE.Vector3; quat: THREE.Quaternion } | null>(null);
  useEffect(() => { settling.current = null; }, [recompileId, selectedNodeId]);
  /*
   * Measured in `useFrame`, NOT in an effect, and this is the whole reason:
   *
   * the offset is a difference between two things that have to be read at the
   * same instant — a box around what is DRAWN, and the pose that drew it. An
   * effect runs between a store change and the next frame, which is precisely
   * when those two disagree. Ending a modal move is the case that showed it:
   * `ObjectGestures.clear()` puts the body's groups back to where the gesture
   * started, `updateNodePos` then reports the new position, and an effect firing
   * in between measured the old box against the new pose — an offset short by
   * exactly the move, so the handles sat at the body's old position until the
   * rebuild arrived and corrected them. The body never flinched, because its
   * groups are rewritten from the live data on the very next frame.
   *
   * A whole frame is allowed to pass first, rather than relying on this
   * component's `useFrame` running after the ones that write the groups.
   * `SceneVisuals` used to remount on every rebuild and re-register its
   * callbacks after this one, flipping the ordering exactly when the
   * measurement mattered most, and any body mounting later still does. Counting
   * down a frame is immune to it,
   * and costs nothing: the previous offset is still right in the meantime,
   * since what changed is where the body is, not its shape.
   */
  const remeasure = useRef(1);
  useEffect(() => { remeasure.current = 2; }, [proxyMounted, node, recompileId, suppressed]);

  /*
   * Follow the body every frame, unless this gizmo is the thing moving it.
   *
   * Parking only on selection and recompile was not enough: the modal `g` move
   * writes qpos and defers the rebuild, MCP commands and the sidebar sliders
   * move a body without changing its identity, and a paused body still settles
   * a little when the model is rebuilt. Each of those left the handles behind,
   * floating where the body used to be. Reading the live pose is a couple of
   * array lookups, so it may as well be read every frame and never be wrong.
   */
  useFrame(() => {
    const proxy = proxyRef.current;
    if (!proxy || !node || drag.current) return;
    const held = settling.current;
    if (held) {
      proxy.position.copy(held.pos);
      proxy.quaternion.copy(held.quat);
      return;
    }
    const pose = bodyPoseOf(node.id, node.pos);
    /*
     * A rebuild replaces the model and the data, and for the frame or two in
     * between every body lookup falls back to the authored position with an
     * IDENTITY rotation. Following that put the handles on an upright body at
     * its origin and then back again — a flick of the gizmo with no matching
     * flinch from the body, because the body is drawn from the same data and
     * simply was not redrawn at all. Staying put through the gap is right:
     * where the body was last seen is where it still is.
     */
    if (!pose.live) return;
    if (remeasure.current > 0) {
      remeasure.current -= 1;
      if (remeasure.current === 0) {
        const box = drawnBox(groupsFor(node.id));
        if (box) {
          centreOffset.current = box.getCenter(new THREE.Vector3())
            .sub(pose.pos)
            .applyMatrix3(pose.rot.clone().invert());
        } else {
          // Nothing drawn yet. Keep the last good offset — treating the centre
          // as the origin would put the handles off the body — and look again
          // next frame.
          remeasure.current = 1;
        }
      }
    }
    proxy.position.copy(centreOffset.current).applyMatrix3(pose.rot).add(pose.pos);
    /*
     * The handles are NOT turned with the body. They stay on MuJoCo's world
     * axes — which, inside this Z-up group, is the identity — so red is always
     * the X the orientation legend shows, green always Y, blue always Z.
     *
     * `space="local"` on a proxy that carried the body's rotation gave the
     * other convention, handles aligned to the body's own axes. That is
     * standard enough elsewhere, but not here: the colours are matched to a
     * legend showing world axes, and since a mesh body's rotation is baked into
     * its vertices while a primitive's is carried on the body frame, the same
     * turn would have tilted the handles for one and not the other. A drag is
     * read as a delta and composed onto the body's real orientation instead —
     * see `bodyQuatOf`.
     */
    proxy.quaternion.identity();
  });

  /**
   * The `pos[2]` at which this body rests on the floor.
   *
   * Measured from what is drawn rather than from the node's own numbers, so it
   * is right for the cases where `pos` is not the base: a mesh positioned by
   * its centroid, a compound body, a body that has been rotated. Falls back to
   * the authored bounds for a body with nothing drawn yet — an instanced static
   * box has no group of its own to measure.
   */
  const groundZFor = useCallback((
    target: SceneNode,
    handlePos: THREE.Vector3,
    box: THREE.Box3 | null,
  ): number => {
    // Expressed as the HANDLE's z, because that is what the drag moves — the
    // offset from it to the body's lowest point is what actually matters, and
    // it is the same whether the handles sit on the centre or the origin.
    if (box) return handlePos.z - box.min.z;
    const bounds = positiveBounds(target);
    if (bounds) return handlePos.z - (bounds.min[2] + (target.pos?.[2] ?? 0));
    return handlePos.z;
  }, []);

  /** Show where the drag has got to, without telling the store about it. */
  const preview = useCallback((state: Drag, position: THREE.Vector3, quaternion: THREE.Quaternion) => {
    if (state.channel === 'qpos' && state.joint) {
      const client = getPhysicsWorkerClient();
      // qpos is the body origin. The handles are on its centre, so the move is
      // taken as a delta and applied to where the origin was.
      const origin = originOf(state, position);
      client.setQpos(state.joint, 0, origin.x);
      client.setQpos(state.joint, 1, origin.y);
      client.setQpos(state.joint, 2, origin.z);
      // A free joint's qpos is [x, y, z, qw, qx, qy, qz] — MuJoCo puts the
      // scalar first, Three puts it last.
      const body = bodyQuatOf(state, quaternion);
      client.setQpos(state.joint, 3, body.w);
      client.setQpos(state.joint, 4, body.x);
      client.setQpos(state.joint, 5, body.y);
      client.setQpos(state.joint, 6, body.z);
      return;
    }
    /*
     * A body is drawn as one group per geom, each with its own origin, so a
     * turn has to be applied ABOUT THE BODY — rotate each group's offset from
     * the body origin as well as the group itself. Rotating the groups alone
     * left a compound body's parts spinning in place instead of swinging round
     * together. For a straight move the delta rotation is identity and this
     * reduces to adding the offset.
     */
    const start = new THREE.Vector3(...state.startPos);
    const delta = position.clone().sub(start);
    const turn = turnOf(state, quaternion);
    const targets = state.channel === 'ghost' ? state.ghosts : state.held.map((h) => h.object);
    targets.forEach((object, i) => {
      const held = state.held[i];
      if (!held) return;
      object.position.copy(held.position).sub(start).applyQuaternion(turn).add(start).add(delta);
      object.quaternion.copy(turn).multiply(held.quaternion);
    });
  }, []);

  const finish = useCallback((state: Drag) => {
    modal.current = null;
    for (const ghost of state.ghosts) ghost.removeFromParent();
    drag.current = null;
    setDragging(false);
    setHint(null);
    setGestureStatus(null);
    // Cleared a tick late, because the click synthesised after a mouse-up on a
    // handle is what would otherwise clear the selection.
    setTimeout(() => setGizmoBusy(false), 0);
  }, [setGestureStatus]);

  /** Put a drag back where it started, and end it without telling the store. */
  const cancel = useCallback(() => {
    const state = drag.current;
    const proxy = proxyRef.current;
    if (!state) return;
    if (proxy) {
      proxy.position.set(...state.startPos);
      proxy.quaternion.copy(state.startQuat);
      // Through the same channel the drag was shown in, so the cancel undoes
      // exactly what the preview did and no more.
      preview(state, proxy.position, proxy.quaternion);
    }
    for (const held of state.held) {
      held.object.position.copy(held.position);
      held.object.quaternion.copy(held.quaternion);
    }
    finish(state);
  }, [finish, preview]);

  const handleMouseDown = useCallback((mode: Mode) => {
    const proxy = proxyRef.current;
    const target = node;
    if (!proxy || !target) return;

    useStore.getState().flushPendingUndo();
    setGizmoBusy(true);
    setDragging(true);

    const groups = groupsFor(target.id);
    const box = drawnBox(groups);
    const freeJoint = target.joints?.find((j) => j.type === 'free')?.name;
    const allStatic = groups.length > 0 && !!target.geoms?.every((g) => !g.dynamic);
    const channel: Channel = freeJoint ? 'qpos' : allStatic ? 'group' : 'ghost';

    const held = groups.map((object) => ({
      object,
      position: object.position.clone(),
      quaternion: object.quaternion.clone(),
    }));

    const ghosts: THREE.Object3D[] = [];
    if (channel === 'ghost') {
      for (const group of groups) {
        const ghost = group.clone(true);
        /*
         * Stripped of the body's name, and it matters. Every geom is drawn
         * inside a `<group name={nodeId}>`, and that name is how the measure
         * and snap stack tells the model from the scenery — so a clone keeping
         * it would offer the dragged body its own features back, one frame
         * behind, and the part would try to mate with a copy of itself.
         * `preview` addresses the ghosts by index, never by name.
         */
        ghost.name = '';
        ghost.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (mesh.isMesh) mesh.material = GHOST_MATERIAL;
        });
        // Beside the group it was copied from: a clone's transform means what
        // its parent says it means, and the scene root is a different frame.
        (group.parent ?? scene).add(ghost);
        ghosts.push(ghost);
      }
    }

    const pose = bodyPoseOf(target.id, target.pos);
    const origin = pose.pos;

    /*
     * Both feature sets are read ONCE, here. Nothing but the dragged body moves
     * while a drag runs — the gizmo is suppressed whenever the sim is playing —
     * so the stationary side cannot go stale in place, only out of reach, and
     * `handleObjectChange` re-gathers when the drag wanders far enough.
     */
    const band = snapThreshold(
      (camera as THREE.PerspectiveCamera).fov ?? 50,
      camera.position.distanceTo(proxy.getWorldPosition(new THREE.Vector3())),
      gl.domElement.clientHeight,
    );
    const here = proxy.position.clone();
    const gatherRadius = Math.min(
      MAX_GATHER_M,
      (box ? box.getSize(new THREE.Vector3()).length() / 2 : 0.05) + band * GATHER_MARGIN_BANDS,
    );

    drag.current = {
      nodeId: target.id,
      mode,
      moved: false,
      channel,
      joint: freeJoint,
      startPos: [proxy.position.x, proxy.position.y, proxy.position.z],
      originStart: [origin.x, origin.y, origin.z],
      startQuat: proxy.quaternion.clone(),
      startBodyQuat: new THREE.Quaternion().setFromRotationMatrix(
        new THREE.Matrix4().setFromMatrix3(pose.rot),
      ),
      groundZ: groundZFor(target, proxy.position, box),
      distance: camera.position.distanceTo(proxy.getWorldPosition(new THREE.Vector3())),
      radius: ringRadius(box),
      held,
      ghosts,
      /*
       * The drawn scene and the document both. A hole that a boolean has
       * already evaluated leaves nothing on screen but a ring of vertices, and
       * the cut that made it is still in the document with its exact radius and
       * axis — which is what makes a peg go into a DRILLED hole rather than
       * only into another cylinder.
       */
      moving: [
        ...bodyFeatures(groups, target.id),
        ...documentAxes(target, pose),
      ],
      fixed: [
        ...neighbourFeatures(scene, target.id, [here.x, here.y, here.z], gatherRadius),
        ...graphAxes(sceneGraph?.nodes ?? [], bodyPoseOf, {
          exclude: target.id, near: [here.x, here.y, here.z], radius: gatherRadius,
        }),
      ],
      gatheredAt: here,
      gatherRadius,
    };
  }, [camera, gl, groundZFor, groupsFor, node, scene]);

  /**
   * Re-gather the stationary features when the drag has left where they were
   * found.
   *
   * Rate-limited by DISTANCE rather than by time, which is the honest measure:
   * a drag that is holding still cannot run out of neighbours however long it
   * holds, and one thrown across the scene needs new ones immediately. Half the
   * reach is the trigger, so the set is always good for at least the band it is
   * being asked about.
   */
  const refreshNeighbours = useCallback((state: Drag, at: THREE.Vector3) => {
    if (at.distanceTo(state.gatheredAt) < state.gatherRadius / 2) return;
    const near: [number, number, number] = [at.x, at.y, at.z];
    state.fixed = [
      ...neighbourFeatures(scene, state.nodeId, near, state.gatherRadius),
      ...graphAxes(useStore.getState().sceneGraph?.nodes ?? [], bodyPoseOf, {
        exclude: state.nodeId, near, radius: state.gatherRadius,
      }),
    ];
    state.gatheredAt = at.clone();
  }, [scene]);

  const handleObjectChange = useCallback(() => {
    const state = drag.current;
    const proxy = proxyRef.current;
    if (!state || !proxy) return;
    const mode = state.mode;
    state.moved = true;

    let resting = false;
    let mated: MateSolution | null = null;
    let aligned: AlignSolution | null = null;
    /*
     * The order the body will be REBUILT in, which is not the same for every
     * body — see the note in `commit`. Snapping in any other order lands on
     * angles that are round here and are not round once the model comes back.
     */
    const squaringOrder = (): 'ZYX' | 'XYZ' => (
      !!node?.geoms?.length && node.geoms.every((g) => g.type === 'mesh') ? 'ZYX' : 'XYZ'
    );
    if (mode === 'translate') {
      // Alt is the usual "no snapping" modifier, and a drag that cannot be
      // talked out of the floor would be worse than no snap at all.
      const off = keys.current.alt;
      const threshold = off
        ? 0
        : snapThreshold(
            (camera as THREE.PerspectiveCamera).fov ?? 50,
            state.distance,
            gl.domElement.clientHeight,
          );
      const snap = snapToFloor({ z: proxy.position.z, groundZ: state.groundZ, threshold });
      // Written back so the handle shows the snapped height, not the raw one.
      proxy.position.z = snap.z;
      resting = snap.locked;

      /*
       * The mate runs after the floor and is allowed to overrule it, because it
       * is the more specific thing to have meant: the floor is where a part
       * goes when nothing else is nearby, and a face to sit on is something
       * else being nearby. What the mate does NOT constrain is then handed back
       * to the floor — so a peg dropped into an upright hole comes out
       * concentric AND seated, which is the whole gesture in one drag.
       */
      if (threshold > 0) {
        refreshNeighbours(state, proxy.position);
        const delta = proxy.position.clone().sub(new THREE.Vector3(...state.startPos));
        const moving = transformFeatures(
          state.moving,
          turnOf(state, proxy.quaternion),
          new THREE.Vector3(...state.startPos),
          delta,
        );
        mated = solveMate({
          moving,
          fixed: state.fixed,
          position: [proxy.position.x, proxy.position.y, proxy.position.z],
          threshold,
        });
      }

      if (mated) {
        proxy.position.set(mated.position[0], mated.position[1], mated.position[2]);
        // The floor still gets the directions the mate left alone. Applied only
        // on Z, because that is the only one the ground plane has an opinion
        // about — a mate that frees Z is a face standing on its edge.
        const freeInZ = mated.free.some((d) => Math.abs(d[2]) > 0.9);
        if (freeInZ) {
          const settle = snapToFloor({ z: proxy.position.z, groundZ: state.groundZ, threshold });
          proxy.position.z = settle.z;
          resting = settle.locked;
        } else {
          resting = false;
        }
        setHint({
          type: 'mate',
          kind: mated.kind,
          from: mated.from as [number, number, number],
          to: mated.to as [number, number, number],
          strength: mated.strength,
          ...(mated.axis ? { axis: mated.axis } : {}),
          ...(mated.plane ? { plane: mated.plane } : {}),
        });
      } else {
        setHint(snap.strength > 0
          ? { type: 'floor', x: proxy.position.x, y: proxy.position.y, r: state.radius, strength: snap.strength }
          : null);
      }
    } else if (keys.current.shift) {
      /*
       * Snapped on the BODY's resulting angles rather than the handles' delta —
       * landing on 15° means the body sitting at 15°, not turned by it — and in
       * the order the body will be rebuilt in, per the note in `commit`. The
       * snapped result is then written back as a delta, because a delta is what
       * the handles hold.
       */
      const order = squaringOrder();
      const euler = new THREE.Euler().setFromQuaternion(bodyQuatOf(state, proxy.quaternion), order);
      const step = THREE.MathUtils.degToRad(ROTATION_SNAP_DEG);
      euler.set(
        Math.round(euler.x / step) * step,
        Math.round(euler.y / step) * step,
        Math.round(euler.z / step) * step,
        order,
      );
      proxy.quaternion
        .setFromEuler(euler)
        .multiply(state.startBodyQuat.clone().invert())
        .multiply(state.startQuat);
    } else if (!keys.current.alt) {
      /*
       * The gentle half of the bargain the translate snap makes.
       *
       * A move never turns the part, so a face mate only fires between faces
       * that already agree — which would be no use at all if getting them to
       * agree meant typing angles. So the rings pull the last few degrees onto
       * a neighbour's face, under the same curve as everything else.
       *
       * Confined to the ring under the pointer, and that is the point: a nudge
       * about a free axis would tip the part off the handle being held, which
       * is exactly how a gizmo comes to feel possessed. Shift is untouched
       * above — asking for a protractor and getting a magnet instead would be
       * two snaps fighting over one drag.
       */
      const ring = ringAxis(controlsRef.current, proxy);
      if (ring) {
        const turn = turnOf(state, proxy.quaternion);
        const start = new THREE.Vector3(...state.startPos);
        const moving = transformFeatures(state.moving, turn, start, new THREE.Vector3());
        const faces = moving.filter((f): f is Extract<MateFeature, { kind: 'face' }> => f.kind === 'face');
        const fixedFaces = state.fixed.filter(
          (f): f is Extract<MateFeature, { kind: 'face' }> => f.kind === 'face',
        );
        aligned = solveAlignAboutAxis({
          moving: faces,
          fixed: fixedFaces,
          axis: [ring.x, ring.y, ring.z],
          quaternion: [proxy.quaternion.x, proxy.quaternion.y, proxy.quaternion.z, proxy.quaternion.w],
        });
        if (aligned) {
          proxy.quaternion.set(
            aligned.quaternion[0], aligned.quaternion[1], aligned.quaternion[2], aligned.quaternion[3],
          );
          setHint({ type: 'align', from: aligned.from, to: aligned.to, strength: aligned.strength });
        }
      }

      /*
       * And failing a neighbour to line up with, square to the world.
       *
       * Almost every part in a scene is meant to sit along an axis, and a turn
       * dragged by hand lands on 89.4°. The sidebar's angles have always been
       * held to the quarters by `getStickyRotation` — a magnetic band rather
       * than a step — so the handles use the very same function, and a body
       * turned by either route settles on the same numbers.
       *
       * Only when no face alignment fired: a part being lined up with the thing
       * beside it should not also be tugged toward the world's axes, or the two
       * would argue over the last degree.
       */
      if (!aligned) {
        const order = squaringOrder();
        const euler = new THREE.Euler().setFromQuaternion(bodyQuatOf(state, proxy.quaternion), order);
        const sticky = ([euler.x, euler.y, euler.z] as const).map(
          (rad) => THREE.MathUtils.degToRad(getStickyRotation(THREE.MathUtils.radToDeg(rad))),
        );
        euler.set(sticky[0], sticky[1], sticky[2], order);
        proxy.quaternion
          .setFromEuler(euler)
          .multiply(state.startBodyQuat.clone().invert())
          .multiply(state.startQuat);
      }
    }

    // A turn that is not being pulled anywhere leaves nothing to draw. Cleared
    // here rather than in each branch above, so holding Shift or Alt mid-turn
    // cannot leave the last frame's hint on screen.
    if (mode !== 'translate' && !aligned) setHint(null);

    preview(state, proxy.position, proxy.quaternion);

    if (mode === 'translate') {
      const d = proxy.position.clone().sub(new THREE.Vector3(...state.startPos));
      const mm = (v: number) => `${(v * 1000).toFixed(1)} mm`;
      setGestureStatus(
        `Move · ${mm(d.x)}, ${mm(d.y)}, ${mm(d.z)}` +
        // Only once it is HELD. A line that appeared and vanished as the part
        // drifted through the band would be read as flicker, not as news.
        (mated?.locked ? ` · ${mated.label}` : '') +
        (resting ? ' · resting on floor' : '') +
        (state.channel === 'ghost' ? ' · snaps into place on release' : ''),
      );
    } else {
      const e = new THREE.Euler().setFromQuaternion(bodyQuatOf(state, proxy.quaternion), 'ZYX');
      const deg = (v: number) => `${Math.round(THREE.MathUtils.radToDeg(v))}°`;
      setGestureStatus(
        `Turn · ${deg(e.x)}, ${deg(e.y)}, ${deg(e.z)}` +
        (aligned?.locked ? ` · ${aligned.label}` : '') +
        (state.channel === 'ghost' ? ' · snaps into place on release' : ''),
      );
    }
  }, [camera, gl, node, preview, refreshNeighbours, setGestureStatus]);

  const commit = useCallback(() => {
    const state = drag.current;
    const proxy = proxyRef.current;
    if (!state || !proxy) return;
    const store = useStore.getState();

    /*
     * A press and release that never moved anything is a CLICK ON THE GIZMO,
     * and it swaps the handles over.
     *
     * Clicking the body was the only way back from the rings, and the rings are
     * drawn right across the body — so the thing you had to hit was mostly
     * covered by the thing you were trying to get rid of. The gizmo itself is
     * the biggest target on screen and always exactly where you are looking.
     * `g` and `r` still ask for one outright.
     */
    if (!state.moved) {
      // Not for the keyboard turn: `r` then an immediate click is a turn of
      // nothing, and should simply end rather than swap the handles as well.
      if (!modal.current) store.cycleGizmoMode();
      finish(state);
      return;
    }

    if (state.mode === 'translate') {
      // `pos` is the body origin, like qpos — so the drag is a delta on where
      // the origin was, not the handle position.
      const moved = originOf(state, proxy.position);
      const to: [number, number, number] = [moved.x, moved.y, moved.z];
      // A click that did not drag is a click, not a move — and a no-op
      // `updateNodePos` would still cost a rebuild and an undo entry.
      if (to.some((v, i) => Math.abs(v - state.originStart[i]) > 1e-6)) {
        store.updateNodePos(state.nodeId, to);
        if (state.joint) {
          for (let axis = 0; axis < 3; axis++) getPhysicsWorkerClient().setQpos(state.joint, axis, to[axis]);
        }
      }
    } else if (!turnOf(state, proxy.quaternion).equals(new THREE.Quaternion())) {
      /*
       * WHICH EULER ORDER depends on what the body is made of, because the app
       * has two and they disagree.
       *
       * A mesh body's rotation is baked into its vertices by
       * `rotateMeshGeomsAbsolute`, which builds Rz·Ry·Rx — Three's 'ZYX'.
       * Everything else reaches the renderer through MJCF's `euler` attribute,
       * and `mjcf.ts` sets no `eulerseq`, so MuJoCo reads it as its default
       * intrinsic xyz: Rx·Ry·Rz, Three's 'XYZ'. The two agree while only one
       * axis is turned and part company as soon as two are.
       *
       * So the quaternion is decomposed the way the body will be rebuilt, or a
       * turn about one axis comes back as a tumble about three. The disagreement
       * itself is older than this gizmo — the sidebar's rotation sliders feed
       * the same two paths — and is left alone here rather than changed under
       * every preset in the app.
       *
       * Three calls, one per axis, because that is the action the store has.
       * They collapse into a single rebuild: `updateNodeRotation` asks the
       * recompile to settle for exactly this reason.
       */
      const baked = !!node?.geoms?.length && node.geoms.every((g) => g.type === 'mesh');
      const euler = new THREE.Euler().setFromQuaternion(bodyQuatOf(state, proxy.quaternion), baked ? 'ZYX' : 'XYZ');
      const degrees = [euler.x, euler.y, euler.z].map((rad) => {
        const deg = THREE.MathUtils.radToDeg(rad);
        return ((deg % 360) + 360) % 360; // The sidebar's sliders run 0–360.
      });
      ([0, 1, 2] as const).forEach((axis) => store.updateNodeRotation(state.nodeId, axis, degrees[axis]));
      // As with a move: the scene graph now agrees, so put the live sim there
      // too rather than waiting for the rebuild to show the turn.
      if (state.joint) {
        const q = bodyQuatOf(state, proxy.quaternion);
        const client = getPhysicsWorkerClient();
        client.setQpos(state.joint, 3, q.w);
        client.setQpos(state.joint, 4, q.x);
        client.setQpos(state.joint, 5, q.y);
        client.setQpos(state.joint, 6, q.z);
      }
    }

    // Position only, really: the handles go back to the world axes the moment
    // the drag ends, whatever the body was turned to.
    settling.current = { pos: proxy.position.clone(), quat: new THREE.Quaternion() };
    finish(state);
  }, [finish, node]);

  const handleMouseUp = commit;

  /*
   * The keyboard turn: `r`, then move the pointer, then click to keep it.
   *
   * The same modal shape as `g`'s move in ObjectGestures — and deliberately not
   * implemented there. A turn has to be previewed through whichever channel the
   * body has, because MuJoCo rewrites a dynamic body's orientation every frame
   * and a group write would be gone before it was seen; all three channels
   * already live here, with the commit that goes with them.
   *
   * Angle is read as the pointer's bearing about the body on screen, which is
   * the reading that holds whichever way the camera is pointing. X, Y and Z
   * pick the axis to turn about; Z to start with, being the one a part usually
   * turns about on a bench.
   */
  const bearing = useCallback((x: number, y: number) => {
    const centre = modal.current?.centre;
    return centre ? Math.atan2(y - centre.y, x - centre.x) : 0;
  }, []);

  const turnTo = useCallback((x: number, y: number) => {
    const state = drag.current;
    const spin = modal.current;
    const proxy = proxyRef.current;
    if (!state || !spin || !proxy) return;

    let angle = bearing(x, y) - spin.from;
    if (keys.current.shift) {
      const step = THREE.MathUtils.degToRad(ROTATION_SNAP_DEG);
      angle = Math.round(angle / step) * step;
    }
    const axis = new THREE.Vector3(spin.axis === 'x' ? 1 : 0, spin.axis === 'y' ? 1 : 0, spin.axis === 'z' ? 1 : 0);
    // Turned about the WORLD axis, not the body's own: "rotate about Z" means
    // the Z the orientation legend shows, which is what X/Y/Z name here.
    proxy.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(axis, angle)).multiply(state.startQuat);
    preview(state, proxy.position, proxy.quaternion);
    setGestureStatus(
      `Turn ${spin.axis.toUpperCase()} ${Math.round(THREE.MathUtils.radToDeg(angle))}°` +
      (state.channel === 'ghost' ? ' · snaps into place on release' : ''),
    );
  }, [bearing, preview, setGestureStatus]);

  const beginTurn = useCallback(() => {
    const proxy = proxyRef.current;
    if (!proxy || drag.current) return;
    setMode('rotate');
    handleMouseDown('rotate');
    if (!drag.current) return;
    // Where the body is on screen, which is what the pointer's angle is
    // measured about.
    const projected = proxy.getWorldPosition(new THREE.Vector3()).project(camera);
    const rect = gl.domElement.getBoundingClientRect();
    const centre = {
      x: rect.left + ((projected.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - projected.y) / 2) * rect.height,
    };
    modal.current = { axis: 'z', centre, from: 0 };
    modal.current.from = bearing(pointer.current.x, pointer.current.y);
    setGestureStatus('Turn Z 0° · X/Y/Z picks the axis, click to keep it');
  }, [bearing, camera, gl, handleMouseDown, setGestureStatus, setMode]);

  useEffect(() => {
    const track = (event: KeyboardEvent) => {
      keys.current = { alt: event.altKey, shift: event.shiftKey };
    };
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    return () => {
      window.removeEventListener('keydown', track);
      window.removeEventListener('keyup', track);
    };
  }, []);

  /*
   * Bound ahead of the JSX rather than inline: an arrow written in the props
   * reads as a fresh function on every render, and the rules-of-hooks lint
   * cannot see that it only touches refs from inside an event.
   */
  const tint = useCallback((controls: THREE.Object3D | null) => {
    controlsRef.current = controls as unknown as { axis?: string | null } | null;
    if (controls) paintHandles(controls);
  }, []);
  const begin = useCallback(() => handleMouseDown(mode), [handleMouseDown, mode]);

  /*
   * `r` turns the selected body, the way `g` moves it (ObjectGestures) — press,
   * move the pointer, click to keep it, Esc to put it back, X/Y/Z to hold one
   * axis. `g` is not touched here: it belongs to the move gesture, and starting
   * one sets the arrows on the body so the handles agree with what the keyboard
   * just did.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
      const key = event.key.toLowerCase();

      // A turn in progress answers first, and swallows the key so nothing else
      // in the app acts on it as well.
      if (modal.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (key === 'escape') cancel();
        else if (key === 'enter' || key === ' ') commit();
        else if (key === 'x' || key === 'y' || key === 'z') {
          modal.current.axis = key;
          turnTo(pointer.current.x, pointer.current.y);
        }
        return;
      }

      if (key === 'escape') { cancel(); return; }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (suppressed || drag.current) return;
      // `g` starts the move gesture over in ObjectGestures; all that is needed
      // here is for the handles to be the ones it is about to move by.
      if (key === 'g') setMode('translate');
      else if (key === 'r') beginTurn();
    };
    // Capture, so a turn in progress reads the key before the modal gestures'
    // own capture-phase listener does.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [beginTurn, cancel, commit, setMode, suppressed, turnTo]);

  /*
   * Registered once and reading the callbacks out of a ref, for the reason
   * ObjectGestures gives at length: these depend on the camera, and R3F gives
   * the camera a new identity on a resize or a view change, so re-registering
   * would tear the listeners down mid-turn and silently cancel it.
   */
  const live = useRef({ turnTo, commit, cancel });
  useEffect(() => { live.current = { turnTo, commit, cancel }; }, [cancel, commit, turnTo]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (modal.current) live.current.turnTo(event.clientX, event.clientY);
    };
    const down = (event: PointerEvent) => {
      if (!modal.current) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 0) live.current.commit();
      else live.current.cancel();
    };
    const swallow = (event: Event) => {
      if (!modal.current) return;
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
    };
  }, []);

  // A drag left running when the gizmo goes away — the sim started, the
  // selection changed, a tool took the pointer — is put back rather than half
  // applied, and the canvas gets its clicks back. Without this the app is left
  // unable to deselect anything.
  useEffect(() => {
    if (suppressed) cancel();
  }, [suppressed, cancel]);

  if (suppressed || !node) return null;

  return (
    <>
      {/* The proxy and the floor hint are in MuJoCo's frame; the handles are
          not, and cannot be — see the note on TransformControls below. */}
      <group rotation={[-Math.PI / 2, 0, 0]}>
        <object3D
          ref={(object) => {
            proxyRef.current = object;
            setProxyMounted(object !== null);
          }}
        />
        {/*
          Where the body would rest. Drawn on the ground plane under it and faded
          by how strongly the drag is being held there, so settling onto the floor
          is something you watch happen rather than something you discover after
          letting go. `raycast` is stubbed out: it is a hint, not a target, and a
          hint that swallows the click that ends the drag is worse than none.
        */}
        {hint?.type === 'floor' && (
          <mesh position={[hint.x, hint.y, 0.0005]} raycast={() => null}>
            <ringGeometry args={[hint.r * 0.88, hint.r, 56]} />
            <meshBasicMaterial
              color={HINT_COLOUR.face}
              transparent
              opacity={0.85 * hint.strength}
              depthWrite={false}
              side={THREE.DoubleSide}
            />
          </mesh>
        )}
        {/*
          A mate in progress: the feature on the part, the place it is going,
          and the line between them. Drawn over everything, because the
          interesting end of a mate is usually inside the material — the middle
          of a hole, or the face two parts are about to close on. The floor ring
          above is the same grammar, and deliberately: the floor IS one of these.
        */}
        {hint?.type === 'mate' && <MateHint hint={hint} />}
        {hint?.type === 'align' && <AlignHint hint={hint} />}
      </group>

      {/*
        OUTSIDE the Z-up group, unlike everything above, and it has to be.

        `TransformControls` writes the attached object's WORLD position into its
        own LOCAL `position` (three-stdlib TransformControls.js:1032) — so it
        assumes its own parent is the scene root. Put it inside the Z-up group
        and that −90° about X is applied a second time, which points the blue Z
        handle along world −Y: flat along the ground, while the orientation
        legend in the corner correctly shows Z up. Out here, `space="local"`
        takes the proxy's world quaternion — the Z-up rotation and the body's
        own — so the handles line up with the legend and with MuJoCo's axes.

        No `makeDefault` either: these controls already switch the orbit
        controls off while dragging, and making them the default would overwrite
        `state.controls`, which useOrbitEnable and the live-camera registry both
        read — and the MCP camera commands with them.

        `mode` decides whether a drag commits as a move or a turn, and the drag
        records it at mouse-down rather than reading it at mouse-up — the two
        are the same today, and would stop being the same the moment anything
        could swap the handles mid-drag.
      */}
      {proxyMounted && (
        <TransformControls
          ref={tint}
          object={proxyRef as React.RefObject<THREE.Object3D>}
          mode={mode}
          space="local"
          size={0.75}
          enabled={!foreignGesture}
          onMouseDown={begin}
          onObjectChange={handleObjectChange}
          onMouseUp={handleMouseUp}
        />
      )}
    </>
  );
};
