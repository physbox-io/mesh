// ---------------------------------------------------------------------------
// The lattice editor in the viewport
// ---------------------------------------------------------------------------
//
// While a body is being modelled this draws it instead of the ordinary mesh
// renderer, for the same reason SculptSurface does: the component holds the
// truth for the duration and the scene graph is told about whole operations.
//
// The interaction problem this exists to solve is depth. A click is a ray, and
// a ray through a three-dimensional grid passes near infinitely many points
// that all project to the same pixel — so "which dot did they mean" has no
// honest answer in general.
//
// It has an honest answer in the case that matters, though: a point that is
// ALREADY THERE. So the pointer resolves in two stages. Anything already drawn
// — every corner of the cage, and every dot in the field, which is drawn as a
// whole cube — is picked directly by nearness to the ray, whichever plane it
// happens to lie on, so any grid point can be connected to any other and a face
// can span depths freely.
// Only when the ray passes nothing already there does the active plane step in
// to say how deep a NEW point should be, which is the one case with nothing
// else to go on. The plane constrains where points are born, never what may be
// joined to what.
//
// Unlike the sculpt tools, geometry is rebuilt rather than mutated in place. A
// sculpt is a quarter of a million vertices changing sixty times a second; a
// cage is a few hundred changing when somebody clicks. Rebuilding is far easier
// to get right, and the frame it costs is a frame nobody is mid-gesture in.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { useStore } from '../store/useStore';
import {
  deserializeCage, serializeCage, cloneLattice, restoreLattice,
  toSceneGeom, cageEdges, coordOf, vertexAt, findVertex, addFace,
  removeFace, removeVertex, moveVertex, flipFace, setCrease, isCrease, creaseEdges, edgeKey, edgeLoop, extrudeFace, mirrorFace, findMirrorFace,
  faceNormal, faceCentre, dominantAxis, latticeStats, latticeBounds, mirrorCoord,
  AXIS_INDEX, type Axis, type Lattice, type LatticeCage, type LatticeCoord,
} from '../utils/latticeMesh';

/** Steps of empty grid drawn around whatever has been built so far. */
const FIELD_MARGIN = 6;

/**
 * Ceiling on dots per row.
 *
 * The field is a cube, so this is cubed: 25 is about fifteen thousand points,
 * which draws in one call and can be scanned per pointer-move without being
 * felt. It is also the point past which more dots stop helping — a volume dense
 * enough to be a fog is one you cannot pick anything out of anyway.
 */
const MAX_FIELD_SPAN = 25;

export interface LatticeSurfaceProps {
  nodeId: string;
  geomName: string;
  color: number[];
  mujoco: any;
  model: any;
  data: any;
  cage: LatticeCage;
  subdiv: number;
  thickness: number;
}

const OTHER_AXES: Record<Axis, [0 | 1 | 2, 0 | 1 | 2]> = {
  x: [1, 2],
  y: [0, 2],
  z: [0, 1],
};

/** A soft round dot, so the field reads as points rather than confetti. */
function makeDotTexture(): THREE.Texture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,1)');
  gradient.addColorStop(0.5, 'rgba(255,255,255,0.85)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export function LatticeSurface({
  nodeId, geomName, color, mujoco, model, data, cage, subdiv, thickness,
}: LatticeSurfaceProps) {
  const groupRef = useRef<THREE.Group>(null);
  /** The group everything in raw lattice coordinates hangs off. See `solid`. */
  const cageRef = useRef<THREE.Group>(null);

  const tool = useStore((s) => s.latticeTool);
  const plane = useStore((s) => s.latticePlane);
  const snap = useStore((s) => s.latticeSnap);
  const mirror = useStore((s) => s.latticeMirror);
  const wireframe = useStore((s) => s.wireframe);
  const applyLattice = useStore((s) => s.applyLattice);
  const nudgeLatticePlane = useStore((s) => s.nudgeLatticePlane);

  const { gl } = useThree();
  const getThree = useThree((state) => state.get);
  const setOrbitEnabled = useCallback((on: boolean) => {
    const controls = getThree().controls as { enabled?: boolean } | null;
    if (controls) controls.enabled = on;
  }, [getThree]);

  /**
   * The live cage.
   *
   * Built once. Deliberately not rebuilt when `cage` changes, because the
   * change that arrives is this component's own commit coming back round;
   * loading a genuinely different cage is done by remounting on
   * `latticeVersion` (see SceneLayer).
   */
  const lattice = useMemo<Lattice>(() => deserializeCage(cage), []); // eslint-disable-line react-hooks/exhaustive-deps
  const unit = lattice.unit;
  /**
   * Metres between two adjacent snapped points.
   *
   * Every mark drawn here is sized off this rather than off `unit`, because the
   * unit is 0.1 mm: dots and handles scaled to it would be specks on a part
   * being laid out in centimetres.
   */
  const step = unit * snap;

  // Bumped after every mutation, to rebuild the geometry that is derived from
  // the cage. The cage itself is a ref-like object, so nothing else would.
  const [revision, setRevision] = useState(0);

  const undoStack = useRef<Lattice[]>([]);
  const redoStack = useRef<Lattice[]>([]);

  const [pending, setPending] = useState<LatticeCoord[]>([]);
  const [hover, setHover] = useState<LatticeCoord | null>(null);
  /**
   * The cage corner under the pointer, if the hovered point is one.
   *
   * Kept so that Delete can act on what is under the cursor when nothing has
   * been explicitly selected. Removing a stray point is the commonest repair in
   * this mode, and requiring a tool change and a click first made it the
   * fiddliest.
   */
  const hoverVertex = hover ? findVertex(lattice, hover[0], hover[1], hover[2]) : -1;
  /**
   * Whether the pointer is locked to the work plane, by holding Ctrl (or Cmd).
   *
   * Everything about this mode reaches across depths on purpose — any point can
   * be joined to any other — and the cost of that is that the pointer keeps
   * finding things at other depths: the lit slice jumps away from the one being
   * worked on, and a click meant for empty space snaps to a corner behind it.
   * Held, this says "I mean THIS plane", which is the other half the freedom
   * needed.
   *
   * Tracked as state rather than read off each event because the lit slice has
   * to settle the moment the key goes down, not on the next mouse move.
   */
  const [locked, setLocked] = useState(false);

  const [selectedFace, setSelectedFace] = useState<number | null>(null);
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
  /**
   * The selected edges — usually one, or a whole loop once L has been pressed.
   *
   * A list rather than a single edge because the edges worth marking sharp come
   * in rings: the rim of a shell, the top of a cylinder. Creasing one of those
   * an edge at a time is a dozen clicks that all have to be right, and a single
   * missed edge in a hard rim shows up only after smoothing, as a dent.
   */
  const [selectedEdges, setSelectedEdges] = useState<[number, number][]>([]);

  /** What a drag is in the middle of doing, and what to rewind to per step. */
  const drag = useRef<
    | { kind: 'extrude'; face: number; axis: Axis; steps: number; snapshot: Lattice; centre: THREE.Vector3 }
    | { kind: 'vertex'; vertex: number; snapshot: Lattice; start: LatticeCoord }
    | null
  >(null);

  const commit = useCallback(() => {
    applyLattice(nodeId, serializeCage(lattice), subdiv);
    useStore.getState().setLatticeStats(latticeStats(lattice));
  }, [applyLattice, lattice, nodeId, subdiv]);

  /** Runs an edit with a snapshot taken first, then publishes it. */
  const mutate = useCallback((edit: () => void) => {
    undoStack.current.push(cloneLattice(lattice));
    // Cages are small, so the history can be generous where the sculpt tools'
    // has to be frugal — but not unbounded.
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current.length = 0;
    edit();
    setRevision((r) => r + 1);
    commit();
  }, [commit, lattice]);

  useEffect(() => {
    useStore.getState().setLatticeStats(latticeStats(lattice));
  }, [lattice]);

  // -----------------------------------------------------------------------
  // Where the body is
  // -----------------------------------------------------------------------

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
        0, 0, 0, 1,
      );
      groupRef.current.position.set(data.xpos[bodyId * 3], data.xpos[bodyId * 3 + 1], data.xpos[bodyId * 3 + 2]);
      groupRef.current.quaternion.setFromRotationMatrix(rotation.current);
    } catch {
      // The model is being swapped out from under us; next frame will be fine.
    }
  });

  // -----------------------------------------------------------------------
  // Derived geometry
  // -----------------------------------------------------------------------

  const position = useCallback((v: number): [number, number, number] => {
    const [i, j, k] = coordOf(lattice, v);
    return [i * unit, j * unit, k * unit];
  }, [lattice, unit]);

  /**
   * The shape as it will be exported: the cage, smoothed, and centred on its own
   * centre of mass exactly as the committed mesh geom is.
   *
   * `origin` is how far that centring moved it, and everything else drawn here
   * — the cage, the grid, the cursor — lives in raw lattice space, so it all
   * hangs off a group shifted by the same amount. Without that the cage would
   * sit beside the surface it describes the moment a shape grew away from the
   * body origin.
   */
  const solid = useMemo(() => {
    const { renderVertices, faces, origin } = toSceneGeom(lattice, subdiv, thickness);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(renderVertices, 3));
    geometry.setIndex(faces);
    geometry.computeVertexNormals();
    return { geometry, origin };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lattice, revision, subdiv, thickness]);

  /**
   * An invisible copy of the CAGE, for picking faces.
   *
   * The visible surface is subdivided, so its triangles have nothing to do with
   * the faces a person is editing — a click on it could report triangle 812 of
   * a shape that has six faces. This is the mesh that answers "which face",
   * kept unindexed so `faceIndex` maps straight through.
   */
  const pick = useMemo(() => {
    const positions: number[] = [];
    const triangleFace: number[] = [];
    lattice.faces.forEach((verts, f) => {
      if (!verts) return;
      for (let i = 1; i + 1 < verts.length; i++) {
        for (const v of [verts[0], verts[i], verts[i + 1]]) positions.push(...position(v));
        triangleFace.push(f);
      }
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return { geometry, triangleFace };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lattice, revision, position]);

  /**
   * The cage's edges, in three sets.
   *
   * Sharp edges have to look different from soft ones. A crease changes the
   * exported shape and nothing about the cage's position, so a cage that draws
   * them identically leaves the single most consequential property of the model
   * invisible until it is smoothed.
   */
  const wire = useMemo(() => {
    const build = (indices: number[]) => {
      const values: number[] = [];
      for (const v of indices) values.push(...position(v));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
      return geometry;
    };
    const creased = new Set<string>();
    const sharp = creaseEdges(lattice);
    for (let i = 0; i < sharp.length; i += 2) creased.add(edgeKey(sharp[i], sharp[i + 1]));

    const soft: number[] = [];
    const edges = cageEdges(lattice);
    for (let i = 0; i < edges.length; i += 2) {
      if (creased.has(edgeKey(edges[i], edges[i + 1]))) continue;
      soft.push(edges[i], edges[i + 1]);
    }
    return { soft: build(soft), sharp: build(sharp) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lattice, revision, position]);

  const edgeHighlight = useMemo(() => {
    if (selectedEdges.length === 0) return null;
    const values: number[] = [];
    for (const [a, b] of selectedEdges) values.push(...position(a), ...position(b));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(values, 3));
    return geometry;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, revision, selectedEdges]);

  /** The cage's own vertices, as draggable handles. */
  const handles = useMemo(() => {
    const used = new Set<number>();
    for (const verts of lattice.faces) {
      if (!verts) continue;
      for (const v of verts) used.add(v);
    }
    return [...used];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lattice, revision]);

  const handleMeshRef = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = handleMeshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    handles.forEach((v, i) => {
      const [x, y, z] = position(v);
      mesh.setMatrixAt(i, matrix.makeTranslation(x, y, z));
    });
    mesh.count = handles.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [handles, position, revision]);

  /** Where the dot field runs to, in grid steps, on each in-plane axis. */
  /**
   * The volume the grid is drawn over, in grid steps, on all three axes.
   *
   * All three, not the two in the work plane: the field is a cube of dots you
   * can see through and reach into, because the whole point of the mode is
   * joining a point to another point at a different depth, and a grid you
   * cannot see the depth of makes you take that on trust.
   */
  const field = useMemo(() => {
    const bounds = latticeBounds(lattice);
    const min: LatticeCoord = bounds ? [...bounds.min] : [0, 0, 0];
    const max: LatticeCoord = bounds ? [...bounds.max] : [0, 0, 0];
    const range = (axis: 0 | 1 | 2) => {
      // The margin is in steps of the CURRENT grid, so coarse work gets a
      // proportionally wide field and fine work gets a tight one — a fixed
      // margin in lattice units is invisible at 100 mm and a mile at 0.1 mm.
      let lo = Math.floor((min[axis] - FIELD_MARGIN * snap) / snap) * snap;
      let hi = Math.ceil((max[axis] + FIELD_MARGIN * snap) / snap) * snap;
      // Trimmed towards the middle rather than truncated at one end, so a big
      // model keeps its dots around where the work is instead of off to one side.
      const steps = (hi - lo) / snap + 1;
      if (steps > MAX_FIELD_SPAN) {
        const centre = Math.round(((min[axis] + max[axis]) / 2) / snap) * snap;
        const half = Math.floor(MAX_FIELD_SPAN / 2) * snap;
        lo = centre - half;
        hi = centre + half;
      }
      return { lo, hi };
    };
    return { ranges: [range(0), range(1), range(2)] as const };
  }, [lattice, revision, snap]); // eslint-disable-line react-hooks/exhaustive-deps

  const dotTexture = useMemo(() => makeDotTexture(), []);

  /**
   * The whole volume of dots, built once per field rather than per pointer move.
   *
   * Kept apart from the lit slice below so that following the pointer costs a
   * few hundred points rebuilt, not fifteen thousand.
   */
  const volume = useMemo(() => {
    const positions: number[] = [];
    // Every dot drawn is a dot that can be clicked, so the coordinates are kept
    // rather than thrown away with the buffer.
    const coords: LatticeCoord[] = [];
    const { ranges } = field;
    for (let i = ranges[0].lo; i <= ranges[0].hi; i += snap) {
      for (let j = ranges[1].lo; j <= ranges[1].hi; j += snap) {
        for (let k = ranges[2].lo; k <= ranges[2].hi; k += snap) {
          coords.push([i, j, k]);
          positions.push(i * unit, j * unit, k * unit);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return { geometry, coords };
  }, [field, snap, unit]);

  /**
   * Which slice of the volume is lit.
   *
   * The slice the POINTER is on, not a fixed one: a highlighted plane that
   * never moves is a plane nobody can explain — centre of what? — and this mode
   * is about depth, so the one thing worth picking out of a cube of identical
   * dots is the depth the cursor is currently at. It falls back to the work
   * plane when the pointer is off the model, which is where a new point in
   * empty space would be born.
   */
  const litIndex = locked || !hover ? plane.index : hover[AXIS_INDEX[plane.axis]];

  const slice = useMemo(() => {
    const positions: number[] = [];
    const { ranges } = field;
    const axis = AXIS_INDEX[plane.axis];
    const [a, b] = OTHER_AXES[plane.axis];
    for (let u = ranges[a].lo; u <= ranges[a].hi; u += snap) {
      for (let v = ranges[b].lo; v <= ranges[b].hi; v += snap) {
        const coord: LatticeCoord = [0, 0, 0];
        coord[axis] = litIndex;
        coord[a] = u;
        coord[b] = v;
        positions.push(coord[0] * unit, coord[1] * unit, coord[2] * unit);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }, [field, litIndex, plane.axis, snap, unit]);

  // -----------------------------------------------------------------------
  // Pointer -> grid
  // -----------------------------------------------------------------------

  /** The pointer ray in the body's own space, where the lattice lives. */
  const localRay = useCallback((event: ThreeEvent<PointerEvent>) => {
    const group = cageRef.current;
    if (!group) return null;
    const inverse = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const origin = event.ray.origin.clone().applyMatrix4(inverse);
    const direction = event.ray.direction.clone().transformDirection(inverse).normalize();
    return { origin, direction };
  }, []);

  /**
   * Where the ray crosses the work plane, rounded to the nearest grid node.
   *
   * Computed from the ray rather than read off the intersection the renderer
   * reports, so the answer is the same whatever size the invisible catcher
   * plane happens to be.
   */
  /**
   * The nearest already-existing point the ray passes, if it passes one.
   *
   * "Nearest" is perpendicular distance from the ray, not distance from the
   * camera, so pointing at a dot picks that dot rather than whatever happens to
   * be in front of it — and ties are broken towards the viewer, which is what
   * makes the near face of a box selectable instead of the far one. Corners of
   * the cage are given an edge over bare grid dots, because joining to a corner
   * that is already part of the model is nearly always the intent.
   */
  const pickExisting = useCallback((
    ray: { origin: THREE.Vector3; direction: THREE.Vector3 },
    onlyOnPlane = false,
  ): LatticeCoord | null => {
    // A fixed fraction of the grid step: tight enough that two adjacent dots are
    // never both candidates, loose enough to be hit without aiming.
    const threshold = unit * snap * 0.45;
    let best: { coord: LatticeCoord; score: number; along: number } | null = null;

    const consider = (coord: LatticeCoord, bias: number) => {
      // Locked, a point at another depth is not a candidate at all — which is
      // what stops a click meant for the plane being caught by the corner of
      // something behind it.
      if (onlyOnPlane && coord[AXIS_INDEX[plane.axis]] !== plane.index) return;
      const point = new THREE.Vector3(coord[0] * unit, coord[1] * unit, coord[2] * unit).sub(ray.origin);
      const along = point.dot(ray.direction);
      if (along <= 0) return;
      const perpendicular = point.sub(ray.direction.clone().multiplyScalar(along)).length();
      if (perpendicular > threshold) return;
      const score = perpendicular * bias;
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) < 1e-9 && along < best.along)) {
        best = { coord, score, along };
      }
    };

    // Corners of the model, wherever they are — this is what lets a face span
    // planes, and it is deliberately not limited to the drawn field.
    for (const v of handles) consider(coordOf(lattice, v), 0.6);
    for (const coord of volume.coords) consider(coord, 1);

    return best ? (best as { coord: LatticeCoord }).coord : null;
  }, [handles, lattice, plane, snap, unit, volume.coords]);

  /** Where the ray crosses the work plane, rounded to the nearest grid node. */
  const snapFromPlane = useCallback((ray: { origin: THREE.Vector3; direction: THREE.Vector3 }): LatticeCoord | null => {
    const axis = AXIS_INDEX[plane.axis];
    const o = ray.origin.toArray();
    const d = ray.direction.toArray();
    if (Math.abs(d[axis]) < 1e-9) return null;
    const t = (plane.index * unit - o[axis]) / d[axis];
    if (t <= 0) return null;
    const coord: LatticeCoord = [0, 0, 0];
    coord[axis] = plane.index;
    for (const other of OTHER_AXES[plane.axis]) {
      const at = o[other] + d[other] * t;
      coord[other] = Math.round(at / (unit * snap)) * snap;
    }
    return coord;
  }, [plane, snap, unit]);

  /**
   * The cage edge the ray passes closest to, if it passes one closely enough.
   *
   * Edges are picked rather than selected from a list because the thing being
   * marked sharp is a specific edge of a specific face, and there is no name for
   * it — "the one running along the top of the front" is a sentence, not an
   * identifier. Distance is measured between the ray and the SEGMENT, so a long
   * edge is no easier to hit near its middle than at its ends.
   */
  const pickEdge = useCallback((ray: { origin: THREE.Vector3; direction: THREE.Vector3 }): [number, number] | null => {
    const threshold = unit * snap * 0.4;
    const edges = cageEdges(lattice);
    let best: { edge: [number, number]; distance: number } | null = null;

    for (let i = 0; i < edges.length; i += 2) {
      const a = new THREE.Vector3(...position(edges[i]));
      const b = new THREE.Vector3(...position(edges[i + 1]));
      const ab = b.clone().sub(a);
      const ao = a.clone().sub(ray.origin);
      // Closest approach between the ray and the segment, clamped to both.
      const abLen = ab.lengthSq();
      const abd = ab.dot(ray.direction);
      const denominator = abLen - abd * abd;
      let t = 0;
      if (Math.abs(denominator) > 1e-12) {
        t = (abd * ao.dot(ray.direction) - ab.dot(ao)) / denominator;
      }
      t = Math.max(0, Math.min(1, t));
      const onEdge = a.clone().addScaledVector(ab, t);
      const along = onEdge.clone().sub(ray.origin).dot(ray.direction);
      if (along <= 0) continue;
      const distance = onEdge.distanceTo(ray.origin.clone().addScaledVector(ray.direction, along));
      if (distance > threshold) continue;
      if (!best || distance < best.distance) best = { edge: [edges[i], edges[i + 1]], distance };
    }
    return best ? best.edge : null;
  }, [lattice, position, snap, unit]);

  /**
   * What the pointer is on: something already there, or the work plane.
   *
   * Locked, only points ON the work plane count as "already there" — so
   * snapping to an existing corner still works, and only the ones at other
   * depths stop competing for the click.
   */
  const resolve = useCallback((ray: { origin: THREE.Vector3; direction: THREE.Vector3 }): LatticeCoord | null =>
    pickExisting(ray, locked) ?? snapFromPlane(ray),
  [locked, pickExisting, snapFromPlane]);

  // -----------------------------------------------------------------------
  // Placing
  // -----------------------------------------------------------------------

  /** Adds a face and, when mirroring is on, its reflection. */
  const addFaceMirrored = useCallback((verts: number[]) => {
    const face = addFace(lattice, verts);
    if (face !== -1 && mirror) mirrorFace(lattice, face, mirror);
    return face;
  }, [lattice, mirror]);

  const closePending = useCallback((points: LatticeCoord[]) => {
    if (points.length < 3) return;
    mutate(() => {
      addFaceMirrored(points.map(([i, j, k]) => vertexAt(lattice, i, j, k)));
    });
    setPending([]);
  }, [addFaceMirrored, lattice, mutate]);

  const placeAt = useCallback((coord: LatticeCoord) => {
    setPending((points) => {
      const same = (a: LatticeCoord, b: LatticeCoord) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      // Clicking the first point again is how a loop is closed — the same
      // gesture as every polygon tool, and it keeps the mouse on the model.
      if (points.length >= 3 && same(points[0], coord)) {
        closePending(points);
        return [];
      }
      if (points.some((p) => same(p, coord))) return points;
      const next = [...points, coord];
      // Four corners is the shape this mode wants; taking the quad
      // automatically saves a click on the overwhelmingly common case, and a
      // triangle is still reachable with Enter.
      if (next.length === 4) {
        closePending(next);
        return [];
      }
      return next;
    });
  }, [closePending]);

  // -----------------------------------------------------------------------
  // Dragging
  // -----------------------------------------------------------------------

  /**
   * The plane a drag along `axis` is measured on.
   *
   * The axis is a line in space and the pointer is on a screen, so the drag
   * needs a surface to be read off: the one containing the axis and facing the
   * camera as squarely as it can.
   */
  const dragPlane = useCallback((axis: Axis, through: THREE.Vector3) => {
    const group = cageRef.current!;
    const camera = getThree().camera;
    const inverse = new THREE.Matrix4().copy(group.matrixWorld).invert();
    const eye = camera.position.clone().applyMatrix4(inverse);
    const view = eye.sub(through).normalize();
    const a = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
    const normal = view.clone().sub(a.clone().multiplyScalar(view.dot(a)));
    if (normal.lengthSq() < 1e-9) normal.set(0, 0, 1); // looking straight down the axis
    normal.normalize();
    return new THREE.Plane().setFromNormalAndCoplanarPoint(normal, through);
  }, [getThree]);

  const beginExtrude = useCallback((face: number, event: ThreeEvent<PointerEvent>) => {
    const normal = faceNormal(lattice, face);
    const centre = faceCentre(lattice, face);
    if (!normal || !centre) return;
    const { axis } = dominantAxis(normal);
    drag.current = {
      kind: 'extrude',
      face,
      axis,
      steps: 0,
      snapshot: cloneLattice(lattice),
      centre: new THREE.Vector3(centre[0] * unit, centre[1] * unit, centre[2] * unit),
    };
    undoStack.current.push(cloneLattice(lattice));
    redoStack.current.length = 0;
    gl.domElement.setPointerCapture?.(event.pointerId);
    setOrbitEnabled(false);
  }, [gl, lattice, setOrbitEnabled, unit]);

  const updateExtrude = useCallback((event: ThreeEvent<PointerEvent>) => {
    const state = drag.current;
    if (state?.kind !== 'extrude') return;
    const ray = localRay(event);
    if (!ray) return;
    const surface = dragPlane(state.axis, state.centre);
    const hit = new THREE.Ray(ray.origin, ray.direction).intersectPlane(surface, new THREE.Vector3());
    if (!hit) return;

    const axis = AXIS_INDEX[state.axis];
    const travelled = (hit.toArray()[axis] - state.centre.toArray()[axis]) / unit;
    const normal = faceNormal(state.snapshot, state.face);
    const sign = normal ? dominantAxis(normal).sign : 1;
    const steps = Math.round(travelled * sign);
    if (steps === state.steps) return;

    // Re-run the extrusion from the snapshot rather than trying to adjust the
    // one already made: an extrude that has been dragged back to zero has to
    // leave no trace, and unpicking side walls in place is how stray faces are
    // left behind inside a solid.
    restoreLattice(lattice, state.snapshot);
    if (steps !== 0) {
      const partner = mirror ? findMirrorFace(lattice, state.face, mirror) : -1;
      extrudeFace(lattice, state.face, steps);
      if (partner !== -1) extrudeFace(lattice, partner, steps);
    }
    state.steps = steps;
    setRevision((r) => r + 1);
  }, [dragPlane, lattice, localRay, mirror, unit]);

  const beginVertexDrag = useCallback((vertex: number, event: ThreeEvent<PointerEvent>) => {
    drag.current = { kind: 'vertex', vertex, snapshot: cloneLattice(lattice), start: coordOf(lattice, vertex) };
    undoStack.current.push(cloneLattice(lattice));
    redoStack.current.length = 0;
    gl.domElement.setPointerCapture?.(event.pointerId);
    setOrbitEnabled(false);
  }, [gl, lattice, setOrbitEnabled]);

  const updateVertexDrag = useCallback((event: ThreeEvent<PointerEvent>) => {
    const state = drag.current;
    if (state?.kind !== 'vertex') return;
    const ray = localRay(event);
    if (!ray) return;
    // Dragging onto an existing point takes it whole — that is how a corner is
    // welded to another, and it is not confined to the work plane. Otherwise the
    // plane fixes only its own axis and the vertex keeps its depth, so a drag
    // never teleports a point onto the slice.
    const existing = pickExisting(ray, locked);
    const coord: LatticeCoord = [...state.start];
    if (existing) {
      coord[0] = existing[0]; coord[1] = existing[1]; coord[2] = existing[2];
    } else {
      const target = snapFromPlane(ray);
      if (!target) return;
      for (const other of OTHER_AXES[plane.axis]) coord[other] = target[other];
    }
    const current = coordOf(lattice, state.vertex);
    if (coord[0] === current[0] && coord[1] === current[1] && coord[2] === current[2]) return;

    restoreLattice(lattice, state.snapshot);
    moveVertex(lattice, state.vertex, coord[0], coord[1], coord[2]);
    setRevision((r) => r + 1);
  }, [lattice, localRay, locked, pickExisting, plane.axis, snapFromPlane]);

  const endDrag = useCallback((event?: ThreeEvent<PointerEvent>) => {
    if (!drag.current) return;
    const state = drag.current;
    drag.current = null;
    if (event && gl.domElement.hasPointerCapture?.(event.pointerId)) {
      gl.domElement.releasePointerCapture(event.pointerId);
    }
    setOrbitEnabled(true);
    // A drag that ended where it started changed nothing, so it should not cost
    // an undo step either.
    const moved = state.kind === 'extrude'
      ? state.steps !== 0
      : coordOf(lattice, state.vertex).some((c, i) => c !== state.start[i]);
    if (moved) commit();
    else undoStack.current.pop();
  }, [commit, gl, lattice, setOrbitEnabled]);

  // -----------------------------------------------------------------------
  // Pointer handlers
  // -----------------------------------------------------------------------

  const onPlaneMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (drag.current) {
      if (drag.current.kind === 'extrude') updateExtrude(event);
      else updateVertexDrag(event);
      return;
    }
    const ray = localRay(event);
    setHover(ray ? resolve(ray) : null);
  }, [localRay, resolve, updateExtrude, updateVertexDrag]);

  const onPlaneDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    const ray = localRay(event);
    if (tool === 'select') {
      // Off the model entirely: an edge seen against the background is still an
      // edge, and clicking empty space clears the selection.
      const edge = ray && pickEdge(ray);
      setSelectedEdges(edge ? [edge] : []);
      if (edge) {
        setSelectedFace(null);
        setSelectedVertex(null);
        event.stopPropagation();
      }
      return;
    }
    if (tool !== 'place') return;
    const coord = ray && resolve(ray);
    if (!coord) return;
    event.stopPropagation();
    // Working at a depth moves the work plane there, so the next point placed in
    // empty space appears beside the last one rather than back on whatever plane
    // the session started on.
    const axis = AXIS_INDEX[plane.axis];
    if (!locked && coord[axis] !== plane.index) {
      useStore.getState().setLatticePlane({ axis: plane.axis, index: coord[axis] });
    }
    placeAt(coord);
  }, [localRay, locked, pickEdge, placeAt, plane, resolve, tool]);

  const onFaceDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0 || event.faceIndex == null) return;
    const face = pick.triangleFace[event.faceIndex];
    if (face === undefined) return;
    if (tool === 'place') return; // placing goes through the plane, not the model
    event.stopPropagation();

    // An edge near the click beats the face behind it. Aiming at an edge is
    // aiming at a line a couple of pixels wide, and the face is a much bigger
    // target sitting right behind it — without this the edge is unhittable.
    if (tool === 'select') {
      const ray = localRay(event);
      const edge = ray && pickEdge(ray);
      if (edge) {
        setSelectedEdges([edge]);
        setSelectedFace(null);
        setSelectedVertex(null);
        return;
      }
    }

    setSelectedFace(face);
    setSelectedVertex(null);
    setSelectedEdges([]);
    if (tool === 'extrude') beginExtrude(face, event);
  }, [beginExtrude, localRay, pick.triangleFace, pickEdge, tool]);

  const onHandleDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0 || tool !== 'select' || event.instanceId == null) return;
    const vertex = handles[event.instanceId];
    if (vertex === undefined) return;
    event.stopPropagation();
    setSelectedVertex(vertex);
    setSelectedFace(null);
    setSelectedEdges([]);
    beginVertexDrag(vertex, event);
  }, [beginVertexDrag, handles, tool]);

  // -----------------------------------------------------------------------
  // Keys
  // -----------------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const key = event.key.toLowerCase();

      if ((event.metaKey || event.ctrlKey) && key === 'z') {
        const stack = event.shiftKey ? redoStack.current : undoStack.current;
        const other = event.shiftKey ? undoStack.current : redoStack.current;
        const snapshot = stack.pop();
        if (!snapshot) return;
        event.preventDefault();
        event.stopPropagation();
        other.push(cloneLattice(lattice));
        restoreLattice(lattice, snapshot);
        setSelectedFace(null);
        setSelectedVertex(null);
        setRevision((r) => r + 1);
        commit();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (key === 'escape') {
        setPending([]);
        setSelectedFace(null);
        setSelectedVertex(null);
        setSelectedEdges([]);
        return;
      }
      if (key === 'enter') {
        setPending((points) => {
          if (points.length >= 3) closePending(points);
          return [];
        });
        return;
      }
      if (key === '[' || key === ']') {
        event.preventDefault();
        nudgeLatticePlane((key === ']' ? 1 : -1) * snap * (event.shiftKey ? 5 : 1));
        return;
      }
      if (key === 'x' || key === 'y' || key === 'z') {
        useStore.getState().setLatticePlane({ axis: key as Axis, index: 0 });
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        // Swallowed whether or not there is anything to delete. The app's own
        // Delete removes the selected BODY, and while these tools are open that
        // is the entire lattice — one keypress away from losing the work,
        // reachable by aiming slightly wrong.
        event.preventDefault();
        event.stopPropagation();

        const vertex = selectedVertex !== null ? selectedVertex : hoverVertex !== -1 ? hoverVertex : null;
        if (selectedFace === null && vertex === null) return;

        mutate(() => {
          if (selectedFace !== null) {
            const partner = mirror ? findMirrorFace(lattice, selectedFace, mirror) : -1;
            removeFace(lattice, selectedFace);
            if (partner !== -1) removeFace(lattice, partner);
          } else if (vertex !== null) {
            const [i, j, k] = mirrorCoord(coordOf(lattice, vertex), mirror ?? 'x');
            const partner = mirror ? findVertex(lattice, i, j, k) : -1;
            removeVertex(lattice, vertex);
            if (partner !== -1 && partner !== vertex) removeVertex(lattice, partner);
          }
        });
        setSelectedFace(null);
        setSelectedVertex(null);
        return;
      }
      if (key === 'l' && selectedEdges.length > 0) {
        // Grow the selection to the whole ring the edge belongs to. Pressed on a
        // loop that has nowhere further to go, it simply stays put.
        const [a, b] = selectedEdges[0];
        const loop = edgeLoop(lattice, a, b);
        if (loop.length > 0) setSelectedEdges(loop);
        return;
      }

      if (key === 's' && (selectedEdges.length > 0 || selectedFace !== null)) {
        // Sharpen. The one control that makes smoothing usable for a part
        // rather than a pebble: everything rounds except what is marked.
        //
        // With a FACE selected it marks that face's whole border, which is the
        // only cheap way to reach the rim of a cap — the corners there are
        // three-way, so L finds no loop through them and never will. Selecting
        // the face and pressing S is four edges in one keystroke.
        const face = selectedEdges.length > 0 ? null : selectedFace;
        const edges: [number, number][] = selectedEdges.length > 0
          ? selectedEdges
          : (() => {
            const verts = face === null ? null : lattice.faces[face];
            if (!verts) return [];
            return verts.map((v, i) => [v, verts[(i + 1) % verts.length]] as [number, number]);
          })();
        if (edges.length === 0) return;

        // Softening only when the WHOLE selection is already sharp, so pressing
        // S on a rim that is half marked finishes the job rather than inverting
        // it edge by edge into a different half.
        const sharp = !edges.every(([a, b]) => isCrease(lattice, a, b));
        mutate(() => {
          for (const [a, b] of edges) {
            setCrease(lattice, a, b, sharp);
            if (!mirror) continue;
            const reflect = (v: number) => {
              const [i, j, k] = mirrorCoord(coordOf(lattice, v), mirror);
              return findVertex(lattice, i, j, k);
            };
            const [ma, mb] = [reflect(a), reflect(b)];
            if (ma !== -1 && mb !== -1) setCrease(lattice, ma, mb, sharp);
          }
        });
        return;
      }

      if (key === 'f' && selectedFace !== null) {
        // Flip: the fix for a face drawn from the wrong side, which is
        // otherwise invisible until it is exported and the solid has a hole.
        const face = selectedFace;
        mutate(() => {
          const partner = mirror ? findMirrorFace(lattice, face, mirror) : -1;
          flipFace(lattice, face);
          if (partner !== -1) flipFace(lattice, partner);
        });
      }
    };
    // Capture, so the app's own undo does not also fire while these tools are
    // open and own the shape.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closePending, commit, hoverVertex, lattice, mirror, mutate, nudgeLatticePlane, selectedEdges, selectedFace, selectedVertex, snap]);

  /**
   * Ctrl (or Cmd) held, tracked on its own.
   *
   * A modifier that only takes effect on the next pointer move is a modifier
   * nobody trusts: you press it to steady the plane, nothing happens, and you
   * move the mouse to check — which is exactly the movement it was meant to
   * make safe. Blur clears it, because a key-up that happens while the window
   * is not focused never arrives, and a lock stuck on is worse than no lock.
   */
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') setLocked(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'Control' || event.key === 'Meta') setLocked(false);
    };
    const clear = () => setLocked(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);

  useEffect(() => {
    useStore.getState().setLatticePlaneLocked(locked);
    return () => useStore.getState().setLatticePlaneLocked(false);
  }, [locked]);

  // A drag left open by an unmount would leave the camera disabled.
  useEffect(() => () => {
    if (drag.current) {
      drag.current = null;
      setOrbitEnabled(true);
    }
  }, [setOrbitEnabled]);

  // -----------------------------------------------------------------------
  // Drawing
  // -----------------------------------------------------------------------

  const rgb = new THREE.Color(color?.[0] ?? 0.55, color?.[1] ?? 0.68, color?.[2] ?? 0.85);

  /**
   * What catches rays that hit nothing else.
   *
   * A box around the field rather than a quad on the work plane, so the pointer
   * still resolves when the plane is edge-on to the camera — and drawn BACK
   * side only, which puts its surface behind everything in the model. A
   * front-facing wall would sit between the camera and the cage and swallow
   * every click meant for a face.
   */
  const catcher = useMemo(() => {
    const { ranges } = field;
    const pad = 2 * snap;
    const size = ranges.map((r) => (r.hi - r.lo + 2 * pad) * unit) as unknown as [number, number, number];
    const position = ranges.map((r) => ((r.hi + r.lo) / 2) * unit) as unknown as [number, number, number];
    return { size, position };
  }, [field, snap, unit]);

  const pendingLine = useMemo(() => {
    const points = [...pending];
    if (hover && pending.length > 0) points.push(hover);
    // Emitted as segments rather than a polyline: `line` is an SVG element as
    // far as React is concerned, and reaching for THREE.Line here would mean
    // constructing an object outside the reconciler to get one dashed edge.
    const positions: number[] = [];
    for (let n = 0; n + 1 < points.length; n++) {
      for (const [i, j, k] of [points[n], points[n + 1]]) positions.push(i * unit, j * unit, k * unit);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }, [hover, pending, unit]);

  const highlight = useMemo(() => {
    if (selectedFace === null) return null;
    const verts = lattice.faces[selectedFace];
    if (!verts) return null;
    const positions: number[] = [];
    for (let i = 1; i + 1 < verts.length; i++) {
      for (const v of [verts[0], verts[i], verts[i + 1]]) positions.push(...position(v));
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lattice, position, revision, selectedFace]);

  return (
    <group ref={groupRef} name={`${nodeId}_lattice`}>
      {/* The shape itself. */}
      <mesh name={geomName} geometry={solid.geometry} castShadow receiveShadow raycast={() => null}>
        <meshStandardMaterial color={rgb} roughness={0.6} metalness={0.05} side={THREE.DoubleSide} wireframe={wireframe} />
      </mesh>

      <group ref={cageRef} position={[-solid.origin[0], -solid.origin[1], -solid.origin[2]]}>
      {/* The cage over it: the thing actually being edited. */}
      <lineSegments geometry={wire.soft} raycast={() => null}>
        <lineBasicMaterial color="#0f172a" transparent opacity={0.5} depthTest={false} />
      </lineSegments>
      {/* Creases, which smoothing will hold sharp. */}
      <lineSegments geometry={wire.sharp} raycast={() => null}>
        <lineBasicMaterial color="#f59e0b" depthTest={false} />
      </lineSegments>
      {edgeHighlight && (
        <lineSegments geometry={edgeHighlight} raycast={() => null}>
          <lineBasicMaterial color="#38bdf8" depthTest={false} />
        </lineSegments>
      )}

      {/* Face picking. Invisible, but not `visible={false}` — that would stop it
          being raycast, which is its entire job. */}
      <mesh geometry={pick.geometry} onPointerDown={onFaceDown}>
        <meshBasicMaterial colorWrite={false} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>

      {selectedFace !== null && highlight && (
        <mesh geometry={highlight} raycast={() => null}>
          <meshBasicMaterial color="#38bdf8" transparent opacity={0.35} side={THREE.DoubleSide} depthTest={false} />
        </mesh>
      )}

      <instancedMesh
        ref={handleMeshRef}
        // The geometry and material come from the children; only the count has
        // to go through `args`, because it sizes the instance buffer.
        args={[undefined as unknown as THREE.BufferGeometry, undefined as unknown as THREE.Material, Math.max(1, handles.length)]}
        onPointerDown={onHandleDown}
      >
        <sphereGeometry args={[step * 0.12, 8, 6]} />
        <meshBasicMaterial color="#0ea5e9" depthTest={false} />
      </instancedMesh>

      {/* The grid, as a volume: the whole cube is drawn and the whole cube is
          clickable, with the slice under the pointer picked out of it. */}
      <points geometry={volume.geometry} raycast={() => null}>
        <pointsMaterial
          map={dotTexture} color="#94a3b8" size={step * 0.18} sizeAttenuation
          transparent opacity={0.22} depthWrite={false}
        />
      </points>
      <points geometry={slice} raycast={() => null}>
        {/* Lit blue while it is being held, so the lock is visible on the thing
            it locks rather than only in the panel. */}
        <pointsMaterial
          map={dotTexture} color={locked ? '#0284c7' : '#475569'}
          size={step * (locked ? 0.42 : 0.34)} sizeAttenuation
          transparent opacity={locked ? 1 : 0.9} depthWrite={false}
        />
      </points>

      {/* Where a click would land. */}
      {hover && (
        <mesh position={[hover[0] * unit, hover[1] * unit, hover[2] * unit]} raycast={() => null}>
          {/* Bigger and warmer over an existing corner, because that is the one
              the pointer will join to, weld onto or delete — and a cursor that
              looks the same whether or not it has caught something makes all
              three of those a guess. */}
          <sphereGeometry args={[hoverVertex !== -1 ? step * 0.24 : step * 0.15, 12, 8]} />
          <meshBasicMaterial color={hoverVertex !== -1 ? '#f59e0b' : '#38bdf8'} depthTest={false} />
        </mesh>
      )}

      {pending.length > 0 && (
        <lineSegments geometry={pendingLine} raycast={() => null}>
          <lineBasicMaterial color="#38bdf8" linewidth={2} depthTest={false} />
        </lineSegments>
      )}

      <mesh
        position={catcher.position}
        onPointerMove={onPlaneMove}
        onPointerDown={onPlaneDown}
        onPointerUp={endDrag}
        onPointerLeave={() => { setHover(null); endDrag(); }}
      >
        <boxGeometry args={catcher.size} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} side={THREE.BackSide} />
      </mesh>
      </group>
    </group>
  );
}

export default LatticeSurface;
