// ---------------------------------------------------------------------------
// The measure tool
// ---------------------------------------------------------------------------
//
// Distance between two points, or the angle at a corner between three. The
// arithmetic is trivial and lives in utils/measureSnap.ts; everything here is
// about the only part that is not, which is deciding what the two points ARE.
//
// A click does not measure where the ray hit the surface. It looks at what is
// near where the ray hit — the triangle's corners, the midpoints of its edges,
// the centre of any circle the neighbouring vertices turn out to lie on, the
// axis of a cylinder — and takes the most interesting of them within a pixel
// or two of the pointer. That is the difference between a tool that answers
// "how far apart are those two holes" and one that answers "how far apart were
// the two places you happened to click".
//
// Left-click is safe to take for picking: the viewport orbits on the RIGHT
// button (see CameraController's mouseButtons), so swallowing button 0 while
// the tool is out costs nothing. It is swallowed in the capture phase, which is
// what stops a pick from also selecting a body or dropping a lattice point.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Html, Line } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import {
  chooseSnap, detectCircle, formatMm, measureAngle, measureDistance, nearbyVertices,
  type SnapCandidate, type Vec3,
} from '../../utils/measureSnap';

/** How near the pointer something has to be, in pixels, to be what was meant. */
const SNAP_PIXELS = 18;
/** How far around the hit to look for a circle, in pixels at the hit's depth. */
const SAMPLE_PIXELS = 44;

const KIND_COLOUR: Record<string, string> = {
  centre: '#f59e0b',
  vertex: '#22d3ee',
  midpoint: '#a78bfa',
  edge: '#a78bfa',
  surface: '#94a3b8',
};

/**
 * True when this object is part of a body rather than part of the scenery.
 *
 * Every geom is drawn inside a `<group name={nodeId}>` (see SceneVisuals), and
 * nothing else in the canvas is. That one fact separates the model from the
 * infinite floor grid, the gizmos and the overlays, without this file having to
 * keep a list of them.
 */
function isBodyGeometry(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) {
    if (node.type === 'Group' && node.name) return true;
  }
  return false;
}

/** The three world-space corners of the triangle a raycast hit. */
function triangleOf(mesh: THREE.Mesh, faceIndex: number): Vec3[] {
  const position = mesh.geometry.getAttribute('position');
  if (!position) return [];
  const index = mesh.geometry.getIndex();
  const corners: Vec3[] = [];
  for (let k = 0; k < 3; k++) {
    const at = index ? index.getX(faceIndex * 3 + k) : faceIndex * 3 + k;
    if (at >= position.count) return [];
    const point = new THREE.Vector3().fromBufferAttribute(position as THREE.BufferAttribute, at);
    mesh.localToWorld(point);
    corners.push([point.x, point.y, point.z]);
  }
  return corners;
}

/**
 * The centres a primitive has by construction.
 *
 * A hole in this app is a cylinder cut out of a solid, and a boss is a cylinder
 * added to one, so the axis of a cylinder is the single most measured thing in
 * the model. Reading it off the geometry's own parameters is exact, and does
 * not depend on how finely the cylinder happened to be tessellated.
 */
function analyticCentres(mesh: THREE.Mesh): SnapCandidate[] {
  const parameters = (mesh.geometry as unknown as { parameters?: Record<string, number> }).parameters;
  const type = mesh.geometry.type;
  const out: SnapCandidate[] = [];
  const world = (x: number, y: number, z: number): Vec3 => {
    const point = mesh.localToWorld(new THREE.Vector3(x, y, z));
    return [point.x, point.y, point.z];
  };

  if (type === 'SphereGeometry') {
    out.push({ point: world(0, 0, 0), kind: 'centre', label: 'Sphere centre', radius: parameters?.radius });
  } else if (type === 'CylinderGeometry' || type === 'CapsuleGeometry') {
    const half = ((parameters?.height ?? parameters?.length ?? 0) as number) / 2;
    const radius = (parameters?.radiusTop ?? parameters?.radius) as number | undefined;
    // The geometry is built along its own Y, whatever the group holding it has
    // been rotated to; localToWorld is what puts that back into the viewport.
    out.push({ point: world(0, 0, 0), kind: 'centre', label: 'Axis centre', radius });
    if (half > 0) {
      out.push({ point: world(0, half, 0), kind: 'centre', label: 'End centre', radius });
      out.push({ point: world(0, -half, 0), kind: 'centre', label: 'End centre', radius });
    }
  }
  return out;
}

export const MeasureTool = () => {
  const { scene, camera, gl } = useThree();
  const measureMode = useStore((s) => s.measureMode);
  const setMeasureMode = useStore((s) => s.setMeasureMode);

  const [picks, setPicks] = useState<SnapCandidate[]>([]);
  const [hover, setHover] = useState<SnapCandidate | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  const wanted = measureMode === 'angle' ? 3 : 2;

  // Read by the key handler, which is registered once and must not be torn down
  // and rebuilt on every pick — and must not decide what Esc means from inside
  // a state updater, which React is free to run twice.
  const picksNow = useRef(picks);
  useEffect(() => {
    picksNow.current = picks;
  }, [picks]);

  /** Where a world point lands on the screen, in the same pixels as the pointer. */
  const project = useCallback((p: Vec3) => {
    const rect = gl.domElement.getBoundingClientRect();
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
    if (v.z > 1) return null; // behind the camera
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
    };
  }, [camera, gl]);

  /**
   * World units per screen pixel at a given point, so a window measured in
   * pixels can be turned into one measured in metres.
   *
   * Perspective means that conversion changes with depth; taking it at the hit
   * is what keeps the search window the same size on screen whether the camera
   * is across the room or nose-down on a 2 mm boss.
   */
  const metresPerPixel = useCallback((at: THREE.Vector3) => {
    const rect = gl.domElement.getBoundingClientRect();
    const perspective = camera as THREE.PerspectiveCamera;
    if (perspective.isPerspectiveCamera) {
      const depth = camera.position.distanceTo(at);
      return (2 * Math.tan((perspective.fov * Math.PI) / 360) * depth) / Math.max(1, rect.height);
    }
    const orthographic = camera as unknown as THREE.OrthographicCamera;
    return (orthographic.top - orthographic.bottom) / (orthographic.zoom * Math.max(1, rect.height));
  }, [camera, gl]);

  /** Everything worth snapping to near where the pointer is aiming. */
  const candidatesNow = useCallback((): SnapCandidate | null => {
    const rect = gl.domElement.getBoundingClientRect();
    const caster = new THREE.Raycaster();
    caster.setFromCamera(
      new THREE.Vector2(
        ((pointer.current.x - rect.left) / rect.width) * 2 - 1,
        -(((pointer.current.y - rect.top) / rect.height) * 2 - 1),
      ),
      camera,
    );
    const hit = caster.intersectObjects(scene.children, true).find((i) => isBodyGeometry(i.object));
    if (!hit) return null;

    const mesh = hit.object as THREE.Mesh;
    const candidates: SnapCandidate[] = [
      { point: [hit.point.x, hit.point.y, hit.point.z], kind: 'surface', label: 'On the face' },
    ];

    if (mesh.isMesh && mesh.geometry) {
      if (hit.faceIndex !== undefined && hit.faceIndex !== null) {
        const corners = triangleOf(mesh, hit.faceIndex);
        for (const corner of corners) candidates.push({ point: corner, kind: 'vertex', label: 'Corner' });
        for (let i = 0; i < corners.length; i++) {
          const next = corners[(i + 1) % corners.length];
          candidates.push({
            point: [
              (corners[i][0] + next[0]) / 2, (corners[i][1] + next[1]) / 2, (corners[i][2] + next[2]) / 2,
            ],
            kind: 'midpoint',
            label: 'Edge midpoint',
          });
        }
      }

      candidates.push(...analyticCentres(mesh));

      // The circle hunt, on whatever the mesh's own vertices say. This is what
      // finds the middle of a hole that a boolean left behind, where nothing in
      // the document remembers there was ever a cylinder there.
      const position = mesh.geometry.getAttribute('position');
      if (position && position.count <= 400_000) {
        const local = mesh.worldToLocal(hit.point.clone());
        // The scale between local and world, so a window in metres on screen is
        // the right number of local units to search in.
        const spread = new THREE.Vector3();
        mesh.getWorldScale(spread);
        const perUnit = Math.max(1e-9, (Math.abs(spread.x) + Math.abs(spread.y) + Math.abs(spread.z)) / 3);
        const radius = (SAMPLE_PIXELS * metresPerPixel(hit.point)) / perUnit;
        const near = nearbyVertices(position.array as ArrayLike<number>, [local.x, local.y, local.z], radius);
        const circle = detectCircle(near);
        if (circle) {
          const centre = mesh.localToWorld(new THREE.Vector3(...circle.centre));
          candidates.push({
            point: [centre.x, centre.y, centre.z],
            kind: 'centre',
            label: 'Circle centre',
            radius: circle.radius * perUnit,
          });
        }
      }
    }

    return chooseSnap(candidates, project, pointer.current, SNAP_PIXELS);
  }, [camera, gl, metresPerPixel, project, scene]);

  // Pointer tracking and picking. Left button only: the viewport orbits on the
  // right one, which is what makes it safe to take the left for picks.
  useEffect(() => {
    if (!measureMode) return;
    // At most one hunt per frame. A pointer move fires far more often than the
    // screen refreshes, and each hunt is a raycast through the whole scene plus
    // a scan of the hit mesh's vertices — cheap once, and jank sixty times.
    let queued = 0;
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      if (queued) return;
      queued = requestAnimationFrame(() => {
        queued = 0;
        setHover(candidatesNow());
      });
    };
    // Only clicks on the canvas itself are picks. The listeners sit on the
    // window so that no overlay can slip a click past them, but that also
    // means they see the clicks meant for the mode menu in the status bar —
    // and swallowing those made the tool impossible to put away by mouse.
    const onCanvas = (event: PointerEvent) => event.target === gl.domElement;
    const down = (event: PointerEvent) => {
      if (event.button !== 0 || !onCanvas(event)) return;
      event.preventDefault();
      event.stopPropagation();
      pointer.current = { x: event.clientX, y: event.clientY };
      const snap = candidatesNow();
      // Clicking off the model puts the last reading away. A measurement that
      // could only be cleared by taking another one left the last number
      // hanging over the part while you tried to look at something else, which
      // is exactly what was reported.
      if (!snap) {
        setPicks([]);
        return;
      }
      setPicks((was) => {
        // A finished measurement stays on screen until the next pick, which is
        // what makes it readable — then that pick starts the next one rather
        // than adding a fourth point to a finished triangle.
        const from = was.length >= wanted ? [] : was;
        return [...from, snap];
      });
    };
    const swallow = (event: PointerEvent) => {
      if (event.button !== 0 || !onCanvas(event)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', swallow, true);
    window.addEventListener('click', swallow as EventListener, true);
    return () => {
      if (queued) cancelAnimationFrame(queued);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', swallow, true);
      window.removeEventListener('click', swallow as EventListener, true);
    };
  }, [candidatesNow, gl, measureMode, wanted]);

  // D measures a distance, A an angle, Esc puts the tool away. Pressing the
  // same key again is how you get out of it without reaching for Esc.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      const mode = useStore.getState().measureMode;
      if (mode && key === 'escape') {
        event.stopImmediatePropagation();
        // Esc clears the marks first and only puts the tool away once there is
        // nothing left to clear, so taking one measurement after another never
        // costs you the tool.
        if (picksNow.current.length === 0) setMeasureMode(null);
        setPicks([]);
        return;
      }
      if (key !== 'd' && key !== 'a') return;
      // Nothing modal may be interrupted: a running gesture owns the keyboard,
      // and the sculpt brushes have their own idea of what a letter means.
      const state = useStore.getState();
      if (state.gestureStatus || state.draggedNodeId || state.sculptNodeId || state.paintMode) return;
      event.stopImmediatePropagation();
      const asked = key === 'd' ? 'distance' : 'angle';
      setPicks([]);
      setMeasureMode(mode === asked ? null : asked);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [setMeasureMode]);

  // Asked for by name from the status bar's mode menu, for anybody who has not
  // learned the keys. Picking any OTHER mode there puts the tape away: the menu
  // is the one place a person goes to stop measuring by mouse, and a Move
  // chosen while the tool was still out would have had its clicks eaten.
  useEffect(() => {
    const onAsked = (event: Event) => {
      const kind = (event as CustomEvent<{ kind: string }>).detail?.kind;
      setPicks([]);
      if (kind === 'measure-distance' || kind === 'measure-angle') {
        setMeasureMode(kind === 'measure-distance' ? 'distance' : 'angle');
      } else {
        setMeasureMode(null);
      }
    };
    window.addEventListener('physbox:gesture', onAsked);
    return () => window.removeEventListener('physbox:gesture', onAsked);
  }, [setMeasureMode]);

  /**
   * The reading, and where to hang it.
   *
   * Deltas are quoted in the DOCUMENT's frame, not the viewport's: bodies are
   * drawn inside a Z-up→Y-up group, so a Three.js y here is the model's z. A
   * readout that said otherwise would disagree with every other number in the
   * app.
   */
  const reading = useMemo(() => {
    if (picks.length < wanted) return null;
    const toDoc = (p: Vec3): Vec3 => [p[0], -p[2], p[1]];
    if (measureMode === 'distance') {
      const { distance, delta } = measureDistance(toDoc(picks[0].point), toDoc(picks[1].point));
      const parts = (['X', 'Y', 'Z'] as const)
        .map((name, i) => (Math.abs(delta[i]) < 1e-7 ? null : `Δ${name} ${formatMm(delta[i])}`))
        .filter(Boolean)
        .join('  ');
      const bores = picks
        .filter((p) => p.radius)
        .map((p) => `⌀${formatMm(p.radius! * 2)}`)
        .join('  ');
      return {
        headline: formatMm(distance),
        detail: [parts, bores].filter(Boolean).join('   ·   '),
        at: picks[0].point.map((v, i) => (v + picks[1].point[i]) / 2) as Vec3,
      };
    }
    const angle = measureAngle(picks[0].point, picks[1].point, picks[2].point);
    if (angle === null) return null;
    return {
      headline: `${angle.toFixed(2)}°`,
      detail: `${formatMm(measureDistance(picks[1].point, picks[0].point).distance)}  ·  ${formatMm(measureDistance(picks[1].point, picks[2].point).distance)}`,
      at: picks[1].point,
    };
  }, [measureMode, picks, wanted]);

  // The prompt is the other half of a modal tool: without it, a tool waiting
  // for a third click and a tool that has finished look identical.
  useEffect(() => {
    if (!measureMode) return;
    const noun = measureMode === 'distance' ? 'Distance' : 'Angle';
    if (reading) {
      useStore.getState().setGestureStatus(`Measure · ${noun} ${reading.headline}. Click away or Esc to clear`);
    } else {
      const left = wanted - picks.length;
      const asked = measureMode === 'angle' && picks.length === 1 ? 'the corner' : left === 1 ? 'one more point' : `${left} points`;
      useStore.getState().setGestureStatus(`Measure · ${noun}: click ${asked}`);
    }
    return () => useStore.getState().setGestureStatus(null);
  }, [measureMode, picks.length, reading, wanted]);

  if (!measureMode) return null;

  const marks = hover && picks.length < wanted ? [...picks, hover] : picks;
  const line = marks.map((m) => new THREE.Vector3(...m.point));

  return (
    <group>
      {/* Drawn over everything: a hole centre is inside the material by
          definition, and a marker the part hides is a marker nobody can aim
          with. */}
      {marks.map((mark, i) => (
        <mesh key={i} position={mark.point} raycast={() => null} renderOrder={999}>
          <sphereGeometry args={[Math.max(1e-4, metresPerPixel(new THREE.Vector3(...mark.point)) * 4), 12, 12]} />
          <meshBasicMaterial color={KIND_COLOUR[mark.kind] ?? '#94a3b8'} depthTest={false} toneMapped={false} />
        </mesh>
      ))}

      {line.length >= 2 && (
        <Line
          points={line}
          color="#f59e0b"
          lineWidth={1.5}
          dashed={!reading}
          dashSize={0.002}
          gapSize={0.002}
          depthTest={false}
          renderOrder={998}
        />
      )}

      {hover && picks.length < wanted && (
        <Html position={hover.point} center style={{ pointerEvents: 'none', transform: 'translate(0, -22px)' }}>
          <span className="px-1.5 py-0.5 rounded bg-slate-900/85 text-[10px] font-mono text-slate-100 whitespace-nowrap">
            {hover.label}
            {hover.radius ? ` ⌀${formatMm(hover.radius * 2)}` : ''}
          </span>
        </Html>
      )}

      {reading && (
        <Html position={reading.at} center style={{ pointerEvents: 'none' }}>
          <div className="px-2 py-1 rounded-md bg-amber-500 text-white shadow-lg whitespace-nowrap text-center">
            <div className="text-[12px] font-mono font-bold tabular-nums">{reading.headline}</div>
            {reading.detail && (
              <div className="text-[9px] font-mono opacity-90 tabular-nums">{reading.detail}</div>
            )}
          </div>
        </Html>
      )}
    </group>
  );
};

export default MeasureTool;
