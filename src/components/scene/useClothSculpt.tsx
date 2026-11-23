/**
 * The garment tools on a piece of cloth (GarmentSculptPanel and
 * GarmentCurvesPanel turn them on): a ring under the pointer, and a
 * left-drag laying a stroke on the garment, saved when the button comes up:
 * the brush's as dabs in the draft's `sculpt`, the pen's as one of its
 * `curves` (closed when it ends where it began).
 * Points come off the cloth as drawn (the Z-up group's frame, MuJoCo's world)
 * and go into the garment's own frame, where its shell is modelled.
 */
import { useEffect, useRef, useState } from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { useGarmentSculpt } from '../../store/garmentSculptStore';
import { useOrbitEnable } from './useOrbitEnable';
import { walkBodiesWorld } from '../../utils/bodyWorld';
import { clothFrame } from '../../utils/cloth/clothFrame';
import { STROKE_SPACING, strokeDabs } from '../../utils/cloth/garmentSculpt';
import { PEN_STEP, penCurve } from '../../utils/cloth/garmentCurves';
import type { SceneNode } from '../../types/scene';
import type { ClothPull } from '../../types/cloth';
import type { FlexInfo } from '../../workers/physicsWorkerProtocol';

const Z = new THREE.Vector3(0, 0, 1);
const _ndc = new THREE.Vector2();
const _raycaster = new THREE.Raycaster();
const _planeHit = new THREE.Vector3();
const _normalScratch = new THREE.Vector3();
const _cornerScratch = new THREE.Vector3();
const PEN_RING = 0.008;
const RING_GEOM = new THREE.RingGeometry(0.9, 1, 48);
const RING_MAT = new THREE.MeshBasicMaterial({ color: 0xa855f7, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.85 });
const MARK_GEOM = new THREE.SphereGeometry(1, 8, 6);
const MARK_MAT = new THREE.MeshBasicMaterial({ color: 0xa855f7 });

/** The frame the garment is modelled in (its form's, when fitted to one), from the graph as it is now. */
function worldOf(id: string): THREE.Matrix4 | null {
  const nodes = useStore.getState().sceneGraph?.nodes;
  let found: THREE.Matrix4 | null = null;
  walkBodiesWorld(nodes, (n, w) => { if (n.id === id) found = clothFrame(nodes, n, w).clone(); });
  return found;
}


/** A drag's path as a pull's route: its interior points this far apart at least, metres. */
const ROUTE_STEP = 0.06;

export function useClothSculpt(node: SceneNode | undefined, flex: FlexInfo) {
  const rebuiltWith = flex;
  const { camera, gl } = useThree();
  const setOrbitEnabled = useOrbitEnable();
  const holdingOrbit = useRef(false);
  const releaseOrbit = () => {
    if (holdingOrbit.current) {
      holdingOrbit.current = false;
      setOrbitEnabled(true);
    }
  };
  // Arranging: the point grabbed (by its place on its piece's pattern), the plane it is dragged in, the path so far.
  const grab = useRef<{ piece: string; at: [number, number]; plane: THREE.Plane; obj: THREE.Object3D; path: THREE.Vector3[] } | null>(null);
  const isPlaying = useStore((s) => s.isPlaying);
  const toolTarget = useGarmentSculpt((s) => !!node && s.target === node.id);
  // Suspended while playing so left-dragging grabs the live cloth instead of sculpting.
  const active = toolTarget && !isPlaying;
  const pen = useGarmentSculpt((s) => s.tool === 'draw');
  const hand = useGarmentSculpt((s) => s.tool === 'arrange');
  const brushRadius = useGarmentSculpt((s) => s.radius);
  const radius = pen ? PEN_RING : brushRadius;
  const spacing = pen ? PEN_STEP : STROKE_SPACING * brushRadius;
  const ring = useRef<THREE.Mesh>(null);
  const stroke = useRef<{ points: THREE.Vector3[]; pull: boolean } | null>(null);
  // Where the strokes went, drawn until the garment is cut again with them.
  const [marksFor, setMarksFor] = useState<{ build: unknown; marks: THREE.Vector3[] }>({ build: rebuiltWith, marks: [] });
  const marks = marksFor.build === rebuiltWith ? marksFor.marks : [];
  const setMarks = (f: (m: THREE.Vector3[]) => THREE.Vector3[]) => setMarksFor((cur) => ({ build: rebuiltWith, marks: f(cur.build === rebuiltWith ? cur.marks : []) }));
  useEffect(() => {
    if (!active) {
      grab.current = null;
      stroke.current = null;
      if (holdingOrbit.current) {
        holdingOrbit.current = false;
        setOrbitEnabled(true);
      }
    }
  }, [active, setOrbitEnabled]);
  useEffect(() => () => {
    if (holdingOrbit.current) {
      holdingOrbit.current = false;
      setOrbitEnabled(true);
    }
  }, [setOrbitEnabled]);

  const local = (e: ThreeEvent<PointerEvent>) => e.object.worldToLocal(e.point.clone());
  const place = (e: ThreeEvent<PointerEvent>, at: THREE.Vector3) => {
    const r = ring.current;
    if (!r || !e.face) return;
    r.position.copy(at);
    _normalScratch.copy(e.face.normal).normalize();
    r.quaternion.setFromUnitVectors(Z, _normalScratch);
    r.visible = true;
  };

  // A pull from a drag: the grabbed point to where it was let go, through the way it went (ClothPull).
  const commitPull = () => {
    const g = grab.current;
    grab.current = null;
    releaseOrbit();
    if (!g || !node || g.path.length < 2) return;
    const world = worldOf(node.id);
    let cur: SceneNode | undefined;
    walkBodiesWorld(useStore.getState().sceneGraph?.nodes, (n) => { if (n.id === node.id) cur = n; });
    const cloth = cur?.cloth;
    if (!world || !cloth) return;
    const inv = world.clone().invert(), round = (v: number) => Math.round(v * 1e4) / 1e4;
    const inNode = (p: THREE.Vector3) => p.clone().applyMatrix4(inv).toArray().map(round) as [number, number, number];
    const via: [number, number, number][] = [];
    let last = g.path[0];
    for (const p of g.path.slice(1, -1)) if (p.distanceTo(last) >= ROUTE_STEP) { via.push(inNode(p)); last = p; }
    const pull: ClothPull = { piece: g.piece, at: g.at, to: inNode(g.path[g.path.length - 1]), ...(via.length ? { via } : {}) };
    setMarks((m) => [...m, ...g.path]);
    useStore.getState().updateNode(node.id, { cloth: { ...cloth, arrange: [...(cloth.arrange ?? []), pull] } } as Partial<SceneNode>);
  };
  // Where the pointer is on the plane the grabbed point is dragged in (the cloth's frame).
  const onPlane = (ev: PointerEvent): THREE.Vector3 | null => {
    const g = grab.current;
    if (!g) return null;
    const r = gl.domElement.getBoundingClientRect();
    _ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    _raycaster.setFromCamera(_ndc, camera);
    const hit = _raycaster.ray.intersectPlane(g.plane, _planeHit);
    return hit ? g.obj.worldToLocal(hit.clone()) : null;
  };
  const handHandlersRef = useRef({ onPlane, commitPull, releaseOrbit });
  useEffect(() => {
    handHandlersRef.current = { onPlane, commitPull, releaseOrbit };
  });
  useEffect(() => {
    if (!active || !hand) return;
    const move = (ev: PointerEvent) => {
      const g = grab.current, p = handHandlersRef.current.onPlane(ev);
      if (!g || !p) return;
      if (p.distanceTo(g.path[g.path.length - 1]) > 0.01) g.path.push(p);
    };
    const up = () => handHandlersRef.current.commitPull();
    const cancel = () => { grab.current = null; handHandlersRef.current.releaseOrbit(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [active, hand]);

  const commit = () => {
    if (hand) return;
    const s = stroke.current;
    stroke.current = null;
    releaseOrbit();
    if (!s || !node?.cloth?.garment || !s.points.length) return;
    const fresh = useStore.getState().sceneGraph?.nodes;
    let cur: SceneNode | undefined;
    walkBodiesWorld(fresh, (n) => { if (n.id === node.id) cur = n; });
    const world = worldOf(node.id);
    const cloth = cur?.cloth, draft = cloth?.garment;
    if (!world || !cloth || !draft) return;
    const inv = world.clone().invert();
    const { strength, mirror, tool, curveKind } = useGarmentSculpt.getState();
    const pts = s.points.map((p) => p.clone().applyMatrix4(inv).toArray());
    let next: typeof draft;
    if (tool === 'draw') {
      const curve = penCurve(pts, curveKind, mirror, (draft.curves ?? []).map((c) => c.name));
      if (!curve) return;
      next = { ...draft, curves: [...(draft.curves ?? []), curve] };
    } else {
      next = { ...draft, sculpt: [...(draft.sculpt ?? []), ...strokeDabs(pts, radius, s.pull ? -strength : strength, mirror)] };
    }
    // The mirrored marks too, so both sides show what is coming.
    const shown = mirror ? [...s.points, ...pts.map((p) => new THREE.Vector3(-p[0], p[1], p[2]).applyMatrix4(world))] : s.points;
    setMarks((m) => [...m, ...shown]);
    useStore.getState().updateNode(node.id, { cloth: { ...cloth, garment: next } } as Partial<SceneNode>);
  };
  const strokeHandlersRef = useRef({ commit, releaseOrbit });
  useEffect(() => {
    strokeHandlersRef.current = { commit, releaseOrbit };
  });
  // The button can come up off the garment.
  useEffect(() => {
    if (!active) return;
    const up = () => strokeHandlersRef.current.commit();
    const cancel = () => { stroke.current = null; strokeHandlersRef.current.releaseOrbit(); };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', cancel);
    };
  }, [active]);

  const handlers = active ? {
    onPointerDown: (e: ThreeEvent<PointerEvent>) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      if (hand) {
        // Grabbed by the nearest corner of the triangle under the pointer (either face of the slab).
        const at = local(e), N = flex.vertnum, pos = (e.object as THREE.Mesh).geometry.attributes.position as THREE.BufferAttribute;
        const corners = e.face ? [e.face.a, e.face.b, e.face.c] : [];
        let best = -1, bd = Infinity;
        for (const c of corners) { const d = at.distanceToSquared(_cornerScratch.set(pos.getX(c), pos.getY(c), pos.getZ(c))); if (d < bd) { bd = d; best = c % N; } }
        const uv = best >= 0 ? flex.flat?.uv?.[best] : undefined;
        if (!uv) return;
        holdingOrbit.current = true;
        setOrbitEnabled(false);
        const facing = camera.getWorldDirection(new THREE.Vector3());
        const sep = flex.name.lastIndexOf('__');
        const piece = sep >= 0 ? flex.name.slice(sep + 2) : flex.name;
        grab.current = { piece, at: [uv[0], uv[1]], plane: new THREE.Plane().setFromNormalAndCoplanarPoint(facing, e.point.clone()), obj: e.object, path: [at] };
        return;
      }
      holdingOrbit.current = true;
      setOrbitEnabled(false);
      const at = local(e);
      stroke.current = { points: [at], pull: useGarmentSculpt.getState().pull !== e.shiftKey };
      place(e, at);
    },
    onPointerMove: (e: ThreeEvent<PointerEvent>) => {
      e.stopPropagation();
      const at = local(e);
      place(e, at);
      const s = stroke.current;
      if (!s) return;
      const step = spacing, last = s.points[s.points.length - 1], d = last.distanceTo(at);
      // Evenly spaced along the drag, however fast it went.
      for (let k = 1; k * step <= d; k++) s.points.push(last.clone().lerp(at, (k * step) / d));
    },
    onPointerOut: () => { if (ring.current) ring.current.visible = false; },
  } : {};

  const overlay = active || marks.length ? (
    <>
      {active && <mesh ref={ring} geometry={RING_GEOM} material={RING_MAT} scale={radius} visible={false} renderOrder={10} />}
      {marks.map((p, i) => <mesh key={i} geometry={MARK_GEOM} material={MARK_MAT} position={p} scale={0.004} />)}
    </>
  ) : null;
  return { handlers, overlay };
}
