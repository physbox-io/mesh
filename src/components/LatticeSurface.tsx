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
  removeFace, removeVertex, moveVertex, moveVertices, flipFace, setCrease, isCrease, creaseEdges, edgeKey, edgeLoop, extrudeFace, mirrorFace, findMirrorFace,
  faceNormal, faceCentre, dominantAxis, latticeStats, latticeBounds, mirrorCoord, orientFaces, vertexCount,
  bridgeFaces, insetFace, bevelFace, bevelEdges, scaleVertices, ringCoords, revolveChain, chainFromEdges, triangulate, curveCoords,
  addWire, removeWire, wireEndingAt, removeWireEdge, wireEdges,
  AXIS_INDEX, DRAWING_TOOLS, type Axis, type Lattice, type LatticeCage, type LatticeCoord,
} from '../utils/latticeMesh';
import { dimensionMm, selectionBoundsMm } from '../utils/latticeCommands';
import { splitHostAround, fuseFlushFaces, resolveExtrusion, unionOverlappingPieces } from '../utils/latticeSketch';
import type { SceneNode } from '../types/scene';

/**
 * Whether a click adds to the selection rather than replacing it.
 *
 * Shift and Ctrl (Cmd on a Mac) both, because both are what people reach for
 * and neither means anything else on a click here — Ctrl's other job in this
 * mode is holding the work plane still while the pointer moves, which a click
 * that lands on something already drawn does not go near.
 */
const additiveFrom = (event: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) =>
  event.shiftKey || event.ctrlKey || event.metaKey;

const sameCoord = (a: LatticeCoord, b: LatticeCoord) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** The same edge with its ends the other way round is the same edge. */
const withoutEdge = (edges: [number, number][], edge: [number, number]) =>
  edges.filter(([a, b]) => edgeKey(a, b) !== edgeKey(edge[0], edge[1]));

/** Toggle an edge in or out of a selection, or replace the selection with it. */
const chooseEdge = (current: [number, number][], edge: [number, number], additive: boolean): [number, number][] => {
  if (!additive) return [edge];
  const without = withoutEdge(current, edge);
  return without.length === current.length ? [...current, edge] : without;
};

/**
 * The edges a click on an edge means: the edge, or, on a wire, the whole
 * wire. A wire is one thing — a curve, a profile — and nobody selecting a
 * sampled curve wants the fortieth of it they happened to hit.
 */
const edgesMeant = (lattice: Lattice, edge: [number, number]): [number, number][] => {
  for (const chain of lattice.wires) {
    for (let i = 1; i < chain.length; i++) {
      const p = chain[i - 1];
      const q = chain[i];
      if ((p === edge[0] && q === edge[1]) || (p === edge[1] && q === edge[0])) {
        return chain.slice(1).map((v, n) => [chain[n], v] as [number, number]);
      }
    }
  }
  return [edge];
};

/**
 * Cuts every wire that passes THROUGH this corner into two at it, so the
 * corner becomes an end of each. Returns whether any wire was cut.
 */
function splitWireAt(lattice: Lattice, vertex: number): boolean {
  let cut = false;
  const wires: number[][] = [];
  for (const chain of lattice.wires) {
    const at = chain.indexOf(vertex);
    if (at <= 0 || at >= chain.length - 1) {
      wires.push(chain);
      continue;
    }
    cut = true;
    wires.push(chain.slice(0, at + 1), chain.slice(at));
  }
  if (cut) {
    lattice.wires = wires;
    lattice.revision++;
  }
  return cut;
}

/**
 * The shortest run of existing edges from the last corner of `run` back to
 * its first, as corners, or null if the model does not join them. Edges of
 * faces and of wires alike; corners already on the run are not passed
 * through, or the way back would cut across the outline it is closing.
 */
function shortestWayBack(lattice: Lattice, run: number[]): number[] | null {
  const from = run[run.length - 1];
  const to = run[0];
  if (from === to) return null;
  const next = new Map<number, number[]>();
  const edges = cageEdges(lattice);
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i];
    const b = edges[i + 1];
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    (next.get(b) ?? next.set(b, []).get(b)!).push(a);
  }
  const blocked = new Set(run.slice(1, -1));
  const cameFrom = new Map<number, number>([[from, -1]]);
  const queue = [from];
  while (queue.length > 0) {
    const here = queue.shift()!;
    if (here === to) {
      const path: number[] = [];
      for (let v = to; v !== -1; v = cameFrom.get(v)!) path.push(v);
      return path.reverse();
    }
    for (const n of next.get(here) ?? []) {
      if (blocked.has(n) || cameFrom.has(n)) continue;
      cameFrom.set(n, here);
      queue.push(n);
    }
  }
  return null;
}

/** Millimetres, to as many places as the number needs and no more. */
const mmText = (metres: number) => {
  const mm = Math.round(metres * 1000 * 100) / 100;
  return `${Number.isInteger(mm) ? mm : mm.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} mm`;
};

/** The node this editor is mounted on, wherever it sits in the tree. */
function findLatticeNode(nodes: SceneNode[], id: string): SceneNode | null {
  for (const node of nodes || []) {
    if (node.id === id) return node;
    const child = findLatticeNode(node.children ?? [], id);
    if (child) return child;
  }
  return null;
}

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

/**
 * How far the lit slice reaches out from where the pointer is working, in grid
 * steps, while the plane is held.
 *
 * Held, the plane is a drawing surface, and a drawing surface that stops at the
 * edge of what has been drawn so far is a sheet of paper the size of the
 * sketch. A slice is two-dimensional, so this can be generous where the volume
 * cannot: sixty steps across is under four thousand dots.
 */
const SLICE_REACH = 30;

/**
 * Ceiling on dots per row of the lit slice. Squared, not cubed, so it can be
 * far more generous than the volume's: 161 is under twenty-six thousand.
 */
const MAX_SLICE_SPAN = 161;

/**
 * What the editor is holding that is not in the cage, kept across remounts.
 *
 * Every commit recompiles the scene, and the scene's visuals are keyed on the
 * compile — so this component is torn down and built again after each of its
 * own edits. Undo history, and an outline half drawn as a wire, both live in
 * component state, and both were vanishing on the very commit that should have
 * kept them: draw a curve, and the next click could not carry it on because the
 * hand that held it had been replaced. So the parts that must outlive a mount
 * live here instead, keyed by the cage they belong to. Coordinates rather than
 * vertex indices, because the cage is compacted on the way through the store.
 */
interface EditorMemory {
  undo: Lattice[];
  redo: Lattice[];
  pending: LatticeCoord[];
  wire: number;
}
const memories = new Map<string, EditorMemory>();

function rememberedFor(key: string): EditorMemory {
  // Anything remembered for another cage — an earlier version, a body that
  // has since been closed — is stale, and a new mount is the moment to say so.
  for (const other of [...memories.keys()]) if (other !== key) memories.delete(other);
  let found = memories.get(key);
  if (!found) {
    found = { undo: [], redo: [], pending: [], wire: -1 };
    memories.set(key, found);
  }
  return found;
}

/** Writes part of a record back; the map is the owner, so the write lives here. */
function noteMemory(key: string, patch: Partial<EditorMemory>) {
  Object.assign(rememberedFor(key), patch);
}

import type { DataMirror, ModelMirror, MujocoShim } from '../types/sceneLayer';

export interface LatticeSurfaceProps {
  nodeId: string;
  /** The cage's version; a new one is a new document, with nothing to remember. */
  version: number;
  geomName: string;
  color: number[];
  mujoco: MujocoShim | null;
  model: ModelMirror | null;
  data: DataMirror | null;
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
  nodeId, version, geomName, color, mujoco, model, data, cage, subdiv, thickness,
}: LatticeSurfaceProps) {
  // A plain lookup, not a hook: the map is the store, and the same key gives
  // the same record on every render for as long as this cage is open.
  const memoryKey = `${nodeId}:${version}`;
  const memory = rememberedFor(memoryKey);
  useEffect(() => () => {
    // Closed for good, not remounted: forget it.
    if (useStore.getState().latticeNodeId !== nodeId) memories.delete(`${nodeId}:${version}`);
  }, [nodeId, version]);
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
  // Bumped after every mutation, to rebuild the geometry that is derived from
  // the cage. The cage itself is a ref-like object, so nothing else would.
  const [revision, setRevision] = useState(0);

  const undoStack = useRef<Lattice[]>(memory.undo);
  const redoStack = useRef<Lattice[]>(memory.redo);

  const [pending, setPending] = useState<LatticeCoord[]>(memory.pending);
  useEffect(() => { noteMemory(memoryKey, { pending }); }, [memoryKey, pending]);
  /**
   * The centre of the ring the shape tool is drawing, and the plane it is being
   * drawn on — remembered rather than read back off the work plane, so turning
   * the plane halfway through does not turn the circle with it.
   */
  const [shape, setShape] = useState<{ coord: LatticeCoord; axis: Axis } | null>(null);
  const [hover, setHoverState] = useState<LatticeCoord | null>(null);
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
   * Whether a click here would close the polygon being drawn.
   *
   * Worth its own colour: closing is the one click in this mode that finishes
   * something rather than adding to it, and hunting for the corner you started
   * at is a poor use of anybody's attention.
   */
  const wouldClose = !!hover && pending.length >= 3
    && pending[0][0] === hover[0] && pending[0][1] === hover[1] && pending[0][2] === hover[2];
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
  const [ctrlHeld, setCtrlHeld] = useState(false);
  /** The lock without a key held: the panel's button, or Caps Lock. */
  const hold = useStore((s) => s.latticePlaneHold);
  /** Whether a drawing tool is in hand. Picking one up turns the hold on (see the store). */
  const drawing = DRAWING_TOOLS.has(tool);
  const locked = ctrlHeld || hold;
  /**
   * The Bézier curve in progress: its end once that is clicked, then its first
   * handle. The start is wherever the polygon being drawn currently ends, so
   * curves chain onto lines and onto each other without a tool change.
   */
  const [stroke, setStroke] = useState<{ end: LatticeCoord; control?: LatticeCoord } | null>(null);
  /** Whether a freehand stroke is being dragged out. */
  const [freehand, setFreehand] = useState(false);
  /**
   * The hovered point, for handlers that outlive a render.
   *
   * The key handlers below are registered once and have to know where the
   * pointer is NOW: both "lock to this plane" and "switch axis" mean the plane
   * through whatever is under the cursor, and a stale closure would put them on
   * the plane it was under when the listener was made.
   */
  const hoverRef = useRef<LatticeCoord | null>(null);

  /**
   * The selected faces. One for most work, two when joining them.
   *
   * Plural because bridging needs a pair, and because the operations that act
   * on a face — crease its border, flip it, inset it — are as reasonable to want
   * on several as on one.
   */
  const [selectedFaces, setSelectedFaces] = useState<number[]>([]);
  /** The face under the pointer, so extrude shows what it is about to move. */
  const [hoveredFace, setHoveredFace] = useState<number | null>(null);
  /**
   * The selected corners. Usually one, or a boxful after a drag across them.
   *
   * A set rather than a single corner because the repairs that matter are
   * plural: a row of points left behind by a change of mind, the whole end of a
   * shape that should be a step further out. One at a time, each of those is a
   * click and a keypress repeated until it is easier to start again.
   */
  const [selectedVertices, setSelectedVertices] = useState<number[]>([]);
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
    | { kind: 'vertex'; vertex: number; moving: number[]; snapshot: Lattice; start: LatticeCoord }
    | null
  >(null);

  const [focus, setFocus] = useState<LatticeCoord | null>(null);

  const setHover = useCallback((coord: LatticeCoord | null) => {
    hoverRef.current = coord;
    setHoverState(coord);
    if (!coord) return;
    // The field's window follows the pointer in jumps — see `focus` below.
    const reach = Math.floor(MAX_FIELD_SPAN / 4) * snap;
    setFocus((current) => (
      !current || coord.some((c, k) => Math.abs(c - current[k]) > reach)
        ? coord.map((c) => Math.round(c / snap) * snap) as LatticeCoord
        : current
    ));
  }, [snap]);

  const setGestureStatus = useStore((s) => s.setGestureStatus);

  const commit = useCallback(() => {
    // A part pushed into another part of the same body fuses with it — see
    // utils/latticeSketch. Here rather than in the extrude alone, because a
    // move or a typed dimension can land a face flush against another just
    // as well as a drag can.
    let reshaped = fuseFlushFaces(lattice) > 0;
    // And a separate piece moved INTO another becomes part of it — the
    // overlap is a union, whatever moved it there.
    const united = unionOverlappingPieces(lattice);
    if (united) {
      restoreLattice(lattice, united);
      reshaped = true;
    }
    if (reshaped) {
      setSelectedFaces([]);
      setSelectedEdges([]);
      setSelectedVertices([]);
      setRevision((r) => r + 1);
    }
    applyLattice(nodeId, serializeCage(lattice), subdiv);
    useStore.getState().setLatticeStats(latticeStats(lattice));
  }, [applyLattice, lattice, nodeId, subdiv]);

  /**
   * Runs an edit with a snapshot taken first, then publishes it.
   *
   * An edit that returns `false` is taken to have done nothing, and the
   * snapshot goes back on the shelf: a typed dimension that rounds to the size
   * the shape already is should not cost a recompile and an undo step that
   * undoes nothing. Returning nothing means "I changed something", which is
   * what every other caller here does.
   */
  const mutate = useCallback((edit: () => void | boolean) => {
    undoStack.current.push(cloneLattice(lattice));
    // Cages are small, so the history can be generous where the sculpt tools'
    // has to be frugal — but not unbounded.
    if (undoStack.current.length > 100) undoStack.current.shift();
    redoStack.current.length = 0;
    if (edit() === false) {
      undoStack.current.pop();
      return;
    }
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
      // Ear-clipped, the same as the mesh this stands in for. A fan over a
      // concave face — the ribbon between two curves is the obvious one —
      // covers ground the face does not, so clicks land on a shape that is not
      // there and the highlight spills outside its own outline.
      const tris = triangulate([verts], lattice.coords);
      for (let t = 0; t + 2 < tris.length; t += 3) {
        for (const v of [tris[t], tris[t + 1], tris[t + 2]]) positions.push(...position(v));
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
    // Wires are in `soft` too, so they pick and loop like any edge; drawn
    // over it in their own colour so an outline reads as unfinished.
    return { soft: build(soft), sharp: build(sharp), open: build(wireEdges(lattice)) };
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
    // A wire's ends only. Its middle is a sampled curve, and a handle on every
    // one of forty samples made the curve a caterpillar that could not be
    // clicked through to select the wire itself.
    for (const chain of lattice.wires) { used.add(chain[0]); used.add(chain[chain.length - 1]); }
    return [...used];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lattice, revision]);

  const handleMeshRef = useRef<THREE.InstancedMesh>(null);
  useEffect(() => {
    const mesh = handleMeshRef.current;
    if (!mesh) return;
    const matrix = new THREE.Matrix4();
    // Per-instance colour rather than a second mesh for the selected ones: they
    // are the same handles, and splitting them into two draws would mean two
    // index maps to keep in step for the sake of a hue.
    const plain = new THREE.Color('#0ea5e9');
    const chosen = new THREE.Color('#f59e0b');
    const selected = new Set(selectedVertices);
    handles.forEach((v, i) => {
      const [x, y, z] = position(v);
      mesh.setMatrixAt(i, matrix.makeTranslation(x, y, z));
      mesh.setColorAt(i, selected.has(v) ? chosen : plain);
    });
    mesh.count = handles.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [handles, position, revision, selectedVertices]);

  /** Where the dot field runs to, in grid steps, on each in-plane axis. */
  /**
   * The volume the grid is drawn over, in grid steps, on all three axes.
   *
   * All three, not the two in the work plane: the field is a cube of dots you
   * can see through and reach into, because the whole point of the mode is
   * joining a point to another point at a different depth, and a grid you
   * cannot see the depth of makes you take that on trust.
   */
  /**
   * Where the pointer is working — the middle of the lit slice, when the slice
   * is too big to draw whole. Null until the pointer has been somewhere.
   * (Declared up by `setHover`, which moves it.)
   */
  const field = useMemo(() => {
    const bounds = latticeBounds(lattice);
    const min: LatticeCoord = bounds ? [...bounds.min] : [0, 0, 0];
    const max: LatticeCoord = bounds ? [...bounds.max] : [0, 0, 0];
    /*
     * The volume always covers the whole shape, and gets SPARSER rather than
     * smaller when that is too many dots: the step goes up a decade at a time
     * until the cube fits under the cap. Decades nest, so every coarse dot is
     * still a point of the fine grid. The alternative — a window of fine dots
     * that follows the pointer — was tried, and at 1 mm it was a small patch
     * that wandered off the part and had to be chased.
     */
    let step = snap;
    const range = (axis: 0 | 1 | 2, at: number) => {
      // The margin is in steps of the CURRENT grid, so coarse work gets a
      // proportionally wide field and fine work gets a tight one — a fixed
      // margin in lattice units is invisible at 100 mm and a mile at 0.1 mm.
      const lo = Math.floor((min[axis] - FIELD_MARGIN * snap) / at) * at;
      const hi = Math.ceil((max[axis] + FIELD_MARGIN * snap) / at) * at;
      return { lo, hi };
    };
    const fits = (at: number) => [0, 1, 2].every((k) => {
      const r = range(k as 0 | 1 | 2, at);
      return (r.hi - r.lo) / at + 1 <= MAX_FIELD_SPAN;
    });
    while (!fits(step) && step < 1e6) step *= 10;
    return { ranges: [range(0, step), range(1, step), range(2, step)] as const, step, fine: [range(0, snap), range(1, snap), range(2, snap)] as const };
  }, [lattice, revision, snap]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * How much of the world one screen pixel covers, at the body being edited.
   *
   * Every mark in this mode is sized off the grid step, which at the finest
   * grid is 0.1 mm: a dot of 0.18 of that is eighteen microns, and eighteen
   * microns is below a pixel however close the camera is allowed to come. The
   * grid was drawn the whole time and could not be seen. Sizes are held to a
   * floor of a few pixels instead — proportional to the grid while that is big
   * enough to see, and pinned to the screen once it is not.
   *
   * Materials are written straight to each frame, since a number on a material
   * costs nothing; the two geometries that carry a radius go through state,
   * quantised so that a slow zoom rebuilds a sphere occasionally rather than
   * sixty times a second.
   */
  const volumeMaterial = useRef<THREE.PointsMaterial>(null);
  const sliceMaterial = useRef<THREE.PointsMaterial>(null);
  const worldPoint = useMemo(() => new THREE.Vector3(), []);
  const [perPixel, setPerPixel] = useState(0);
  // The same figure without the quantising, for the gestures below: a pointer
  // sizing an inset wants the exact scale of the screen, not a banded one.
  const perPixelRef = useRef(0);
  useFrame(({ camera, size }) => {
    const group = cageRef.current;
    if (!group || size.height === 0) return;
    const perspective = camera as THREE.PerspectiveCamera;
    const distance = camera.position.distanceTo(group.getWorldPosition(worldPoint));
    const metresPerPixel =
      (2 * Math.tan((perspective.fov * Math.PI) / 360) * distance) / size.height;
    perPixelRef.current = metresPerPixel;
    // Pixels, not grid steps. Sized to the step, a 100 mm grid drew dots the
    // size of the part; the grid says where a mark is, never how big.
    //
    // Points are not meshes: three draws a point of `size` as size × (height/2)
    // ÷ depth pixels, with no account of the field of view, so a size worked
    // out in metres-per-pixel comes out tan(fov/2) too small — a fifth of the
    // intended dot at a 50° lens. Divided back out here.
    const perPoint = metresPerPixel / Math.tan((perspective.fov * Math.PI) / 360);
    if (volumeMaterial.current) volumeMaterial.current.size = perPoint * 2.5;
    if (sliceMaterial.current) sliceMaterial.current.size = perPoint * (locked ? 4.5 : 3.5);
    // A 15% band: below it the change is not visible, and above it a sphere is
    // rebuilt, which is not something to do on every frame of an orbit.
    if (metresPerPixel > perPixel * 1.15 || metresPerPixel < perPixel * 0.87) {
      setPerPixel(metresPerPixel);
    }
  });

  /** A radius of so many screen pixels, whatever the grid step is. */
  const pixels = useCallback((count: number) => perPixel * count, [perPixel]);

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
    const { ranges, step: at } = field;
    for (let i = ranges[0].lo; i <= ranges[0].hi; i += at) {
      for (let j = ranges[1].lo; j <= ranges[1].hi; j += at) {
        for (let k = ranges[2].lo; k <= ranges[2].hi; k += at) {
          coords.push([i, j, k]);
          positions.push(i * unit, j * unit, k * unit);
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return { geometry, coords };
  }, [field, unit]);

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

  /**
   * Held, the slice reaches well past the shape — see SLICE_REACH — and its
   * dots are kept, because every one of them is somewhere a stroke can land.
   */
  const slice = useMemo(() => {
    const positions: number[] = [];
    const coords: LatticeCoord[] = [];
    const span = (k: 0 | 1 | 2) => {
      // At the grid's own step over the whole shape — a slice is flat, so it
      // can afford what the volume cannot — and held, out past it as well.
      let r = field.fine[k];
      const at = focus ? focus[k] : (r.lo + r.hi) / 2;
      const centre = Math.round(at / snap) * snap;
      if (locked) r = { lo: Math.min(r.lo, centre - SLICE_REACH * snap), hi: Math.max(r.hi, centre + SLICE_REACH * snap) };
      // Only a part hundreds of steps across gets a window, and then it is a
      // wide one around the pointer rather than a patch.
      if ((r.hi - r.lo) / snap + 1 > MAX_SLICE_SPAN) {
        const half = Math.floor(MAX_SLICE_SPAN / 2) * snap;
        r = { lo: centre - half, hi: centre + half };
      }
      return r;
    };
    const ranges = [span(0), span(1), span(2)] as const;
    const axis = AXIS_INDEX[plane.axis];
    const [a, b] = OTHER_AXES[plane.axis];
    for (let u = ranges[a].lo; u <= ranges[a].hi; u += snap) {
      for (let v = ranges[b].lo; v <= ranges[b].hi; v += snap) {
        const coord: LatticeCoord = [0, 0, 0];
        coord[axis] = litIndex;
        coord[a] = u;
        coord[b] = v;
        coords.push(coord);
        positions.push(coord[0] * unit, coord[1] * unit, coord[2] * unit);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return { geometry, coords, ranges };
  }, [field, focus, litIndex, locked, plane.axis, snap, unit]);

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
    // A CORNER of the model gets a floor in pixels as well. At a 1 mm grid the
    // fraction above is three pixels wide at any sensible zoom, which is why
    // the end of a curve could not be clicked at all; the handle is drawn
    // with the same floor, so the target is the thing you can see.
    const cornerThreshold = Math.max(threshold, perPixelRef.current * 8);
    let best: { coord: LatticeCoord; score: number; along: number } | null = null;
    const ox = ray.origin.x;
    const oy = ray.origin.y;
    const oz = ray.origin.z;
    const dx = ray.direction.x;
    const dy = ray.direction.y;
    const dz = ray.direction.z;

    const consider = (coord: LatticeCoord, bias: number, fixed: boolean) => {
      // Locked, a bare grid dot at another depth is not a candidate at all —
      // which is what stops a click meant for the plane being caught by the
      // field behind it. A CORNER of the model still is, at any depth: the
      // plane says where new points are born, never what may be joined to
      // what, and a held plane is not a reason to make the existing shape
      // unreachable.
      if (onlyOnPlane && !fixed && coord[AXIS_INDEX[plane.axis]] !== plane.index) return;
      // Scalar maths, no vectors: this runs over every dot in the slice on
      // every pointer move, and a slice can be twenty thousand dots.
      const px = coord[0] * unit - ox;
      const py = coord[1] * unit - oy;
      const pz = coord[2] * unit - oz;
      const along = px * dx + py * dy + pz * dz;
      if (along <= 0) return;
      const perpendicular = Math.hypot(px - dx * along, py - dy * along, pz - dz * along);
      if (perpendicular > (fixed ? cornerThreshold : threshold)) return;
      const score = perpendicular * bias;
      if (!best || score < best.score - 1e-9 || (Math.abs(score - best.score) < 1e-9 && along < best.along)) {
        best = { coord, score, along };
      }
    };

    // Corners of the model, wherever they are — this is what lets a face span
    // planes, and it is deliberately not limited to the drawn field.
    for (const v of handles) consider(coordOf(lattice, v), 0.6, true);
    // A wire's middle corners too — not drawn as handles, but a stroke that
    // ends on a curve should land on the curve, and the curve's corners are
    // the only points on it a cage knows.
    for (const chain of lattice.wires) {
      for (let i = 1; i + 1 < chain.length; i++) consider(coordOf(lattice, chain[i]), 0.8, true);
    }
    // Held, the dots are NOT candidates: the plane itself answers for them
    // (see snapFromPlane), and the two answers disagree. Nearest-to-the-ray
    // picks, from a grazing view, the dot nearer the camera; the plane hit,
    // rounded, is the one under the pointer. A press resolved one way and a
    // release the other could not close a loop drawn on the plane.
    if (!onlyOnPlane) for (const coord of volume.coords) consider(coord, 1, false);

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
    // The same pixel floor as a corner: a line a fraction of a millimetre wide
    // is not a target on a fine grid.
    const threshold = Math.max(unit * snap * 0.4, perPixelRef.current * 6);
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

  /** `pending`, for handlers that run from a stroke rather than a render. */
  const pendingRef = useRef<LatticeCoord[]>([]);
  useEffect(() => { pendingRef.current = pending; }, [pending]);
  /**
   * The wire in the cage that IS the polygon being drawn, or -1.
   *
   * The drawing tools keep their outline in the document as they go (see
   * `settle`), and this says which wire that is, so the next stroke replaces
   * it rather than laying a second one on top.
   */
  const wireRef = useRef(memory.wire);
  useEffect(() => { noteMemory(memoryKey, { wire: wireRef.current }); }, [memoryKey, revision]);

  /**
   * Adds a face from a drawn outline, wound to face the camera.
   *
   * Which way round an outline was drawn is not a decision anybody made, and
   * a lone face has no neighbours for N to orient it by — so a face drawn
   * clockwise came out red, from the very side it was drawn from, for no
   * reason a person could see.
   */
  const addOutline = useCallback((verts: number[]) => {
    const group = cageRef.current;
    const trial = { ...lattice, faces: [verts] } as Lattice;
    const normal = faceNormal(trial, 0);
    const centre = faceCentre(trial, 0);
    if (group && normal && centre) {
      const eye = getThree().camera.position.clone().applyMatrix4(new THREE.Matrix4().copy(group.matrixWorld).invert());
      const toEye = eye.sub(new THREE.Vector3(centre[0] * unit, centre[1] * unit, centre[2] * unit));
      if (normal[0] * toEye.x + normal[1] * toEye.y + normal[2] * toEye.z < 0) verts = [...verts].reverse();
    }
    // Drawn ON a face, the outline divides it — the face keeps only what the
    // outline does not cover, and the two can be pushed apart afterwards.
    // See utils/latticeSketch. The split decides the winding then, so the
    // new face and the pieces agree about which side is out.
    const split = splitHostAround(lattice, verts);
    if (split) verts = split.inner;
    return addFaceMirrored(verts);
  }, [addFaceMirrored, getThree, lattice, unit]);

  const closePending = useCallback((points: LatticeCoord[]) => {
    if (points.length < 3) return;
    mutate(() => {
      // The outline becomes the face; the wire that held it has done its job.
      if (wireRef.current !== -1) removeWire(lattice, wireRef.current);
      wireRef.current = -1;
      addOutline(points.map(([i, j, k]) => vertexAt(lattice, i, j, k)));
    });
    setPending([]);
  }, [addOutline, lattice, mutate]);

  /**
   * A chain grown by some corners, and whether it came back round to its own
   * start. Repeats of the last corner are skipped, a corner already on the
   * chain is skipped, and the first corner ends it.
   */
  const grown = useCallback((chain: LatticeCoord[], added: LatticeCoord[]) => {
    const next = [...chain];
    for (const c of added) {
      if (next.length > 0 && sameCoord(next[next.length - 1], c)) continue;
      if (next.length >= 3 && sameCoord(next[0], c)) return { chain: next, closed: true };
      if (next.some((p) => sameCoord(p, c))) continue;
      next.push(c);
    }
    return { chain: next, closed: false };
  }, []);

  /**
   * Writes the outline being drawn into the cage, as a wire — or as a face,
   * if it has closed.
   *
   * This is what makes a curve something rather than a preview: a Bézier that
   * ends in mid-air stays, as a wire, and can be continued from either end
   * with any drawing tool, picked up corner by corner, or swept about an axis
   * for a lathe. Landing on the end of ANOTHER wire joins the two into one;
   * landing back on the outline's own start closes it into a face.
   */
  const settle = useCallback((chain: LatticeCoord[], closed: boolean) => {
    if (closed) {
      closePending(chain);
      return;
    }
    mutate(() => {
      const verts = chain.map(([i, j, k]) => vertexAt(lattice, i, j, k));
      if (wireRef.current !== -1) removeWire(lattice, wireRef.current);
      wireRef.current = -1;
      let run = verts;
      if (run.length === 1) {
        // A stroke begun on the middle of a wire is a branch off it — a T —
        // so the wire is cut there into two, each ending at the junction, and
        // the new stroke starts fresh. Begun on the END of a wire, it
        // continues that wire.
        if (!splitWireAt(lattice, run[0])) {
          const at = wireEndingAt(lattice, run[0]);
          if (at) {
            const other = lattice.wires[at.wire];
            run = at.atStart ? [...other].reverse() : [...other];
            removeWire(lattice, at.wire);
          }
        }
      } else if (run.length >= 2) {
        if (!splitWireAt(lattice, run[run.length - 1])) {
          const at = wireEndingAt(lattice, run[run.length - 1]);
          if (at) {
            const other = lattice.wires[at.wire];
            const tail = at.atStart ? other : [...other].reverse();
            removeWire(lattice, at.wire);
            run = [...run, ...tail.slice(1)];
          }
        }
      }
      if (run.length >= 4 && run[0] === run[run.length - 1]) {
        addOutline(run.slice(0, -1));
        setPending([]);
        return;
      }
      /*
       * Closed against what is already there. An outline drawn from one
       * corner of the model to another is an outline whose other side the
       * model already has: the shortest way back along existing edges — a
       * face's, or another wire's — completes it. Shortest, because the
       * question "which way round" has no better answer a click can give,
       * and the near way round is nearly always the one meant. Two corners
       * of drawn outline at least, or a single segment across a face would
       * cap itself into a sliver nobody asked for.
       */
      if (run.length >= 3) {
        const back = shortestWayBack(lattice, run);
        if (back) {
          for (let i = 1; i < back.length; i++) removeWireEdge(lattice, back[i - 1], back[i]);
          addOutline([...run, ...back.slice(1, -1)]);
          setPending([]);
          return;
        }
      }
      setPending(run.map((v) => coordOf(lattice, v)));
      if (run.length < 2) return false; // a lone first corner is not in the cage yet
      wireRef.current = addWire(lattice, run);
    });
  }, [addOutline, closePending, lattice, mutate]);

  /**
   * How far a grid point is from the shape's centre, IN THE SHAPE'S PLANE.
   *
   * In the plane rather than in space, so a pointer that has strayed off the
   * plane still sizes the circle sensibly instead of quietly inflating it by
   * however far out of plane it went.
   */
  const shapeRadius = useCallback((coord: LatticeCoord) => {
    if (!shape) return 0;
    const a = AXIS_INDEX[shape.axis];
    const [u, v] = [0, 1, 2].filter((k) => k !== a);
    return Math.round(Math.hypot(coord[u] - shape.coord[u], coord[v] - shape.coord[v]));
  }, [shape]);

  const shapeSides = useStore((s) => s.latticeShapeSides);

  /** The ring as it stands, for the preview and for the click that keeps it. */
  const ringFor = useCallback((coord: LatticeCoord | null) => {
    if (!shape || !coord) return null;
    return ringCoords(shape.coord, shapeRadius(coord), shape.axis, shapeSides);
  }, [shape, shapeRadius, shapeSides]);

  const placeAt = useCallback((coord: LatticeCoord) => {
    // From the ref, not from inside a state updater: closing a face commits
    // to the store, and a store write from inside an updater is a write
    // during render, which React rightly complains about.
    const points = pendingRef.current;
    // Clicking the first point again is how a loop is closed — the same
    // gesture as every polygon tool, and it keeps the mouse on the model.
    if (points.length >= 3 && sameCoord(points[0], coord)) {
      closePending(points);
      return;
    }
    if (points.some((p) => sameCoord(p, coord))) return;
    // Nothing closes on its own. Four corners used to take the quad
    // automatically, which saved a click on the common case and made every
    // other polygon impossible to draw — including the octagon a circle is
    // made of. A face is finished when you say so, by coming back to the
    // corner you started from or by pressing Enter.
    setPending([...points, coord]);
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
    // Whole GRID steps, as the tool promises — not whole tenths of a
    // millimetre. Rounded to the unit, a face dragged across a gap landed a
    // tenth short of the face on the far side more often than on it, and a
    // tenth short is not touching.
    const steps = Math.round((travelled * sign) / snap) * snap;
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
    setGestureStatus(steps === 0 ? 'Extrude' : `Extrude ${mmText(steps * unit)}`);
    setRevision((r) => r + 1);
  }, [dragPlane, lattice, localRay, mirror, setGestureStatus, snap, unit]);

  const beginVertexDrag = useCallback((vertex: number, event: ThreeEvent<PointerEvent>) => {
    // Everything selected comes along, so a boxful of corners can be moved as a
    // piece. Dragging one that is NOT in the selection is a fresh grab of that
    // one, which is what clicking it just made the selection anyway.
    const moving = selectedVertices.includes(vertex) ? [...selectedVertices] : [vertex];
    drag.current = { kind: 'vertex', vertex, moving, snapshot: cloneLattice(lattice), start: coordOf(lattice, vertex) };
    undoStack.current.push(cloneLattice(lattice));
    redoStack.current.length = 0;
    gl.domElement.setPointerCapture?.(event.pointerId);
    setOrbitEnabled(false);
  }, [gl, lattice, selectedVertices, setOrbitEnabled]);

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
    if (state.moving.length > 1) {
      // The whole selection travels by the step the grabbed corner took.
      moveVertices(lattice, state.moving,
        coord[0] - state.start[0], coord[1] - state.start[1], coord[2] - state.start[2]);
    } else {
      moveVertex(lattice, state.vertex, coord[0], coord[1], coord[2]);
    }
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
    setGestureStatus(null);
    // A drag that ended where it started changed nothing, so it should not cost
    // an undo step either.
    const moved = state.kind === 'extrude'
      ? state.steps !== 0
      : coordOf(lattice, state.vertex).some((c, i) => c !== state.start[i]);
    if (moved && state.kind === 'extrude' && !mirror) {
      // Pushed into the body itself, an extrusion is a boolean of the body
      // with the prism the face swept — added going out, taken away going
      // in, which is how a face pushed through the far side becomes a hole.
      // See utils/latticeSketch. The plain extrude stands when nothing crossed.
      const resolved = resolveExtrusion(state.snapshot, state.face, state.steps);
      if (resolved) {
        restoreLattice(lattice, resolved);
        setSelectedFaces([]);
        setRevision((r) => r + 1);
      }
    }
    if (moved) commit();
    else undoStack.current.pop();
  }, [commit, gl, lattice, mirror, setGestureStatus, setOrbitEnabled]);

  // -----------------------------------------------------------------------
  // Dragging a box round some corners
  // -----------------------------------------------------------------------

  type ClickTarget = { kind: 'face'; face: number } | { kind: 'edge'; edge: [number, number] } | null;
  const marquee = useRef<{ x: number; y: number; additive: boolean; box: HTMLDivElement; click: ClickTarget } | null>(null);

  /** Where a cage corner lands on screen, in client pixels. */
  const toScreen = useCallback((vertex: number): { x: number; y: number } | null => {
    const group = cageRef.current;
    if (!group) return null;
    const camera = getThree().camera;
    const point = group.localToWorld(new THREE.Vector3(...position(vertex))).project(camera);
    // Behind the camera: projection wraps a point round to the other side of the
    // screen, and a corner behind you is not in the box you just drew.
    if (point.z > 1) return null;
    const rect = gl.domElement.getBoundingClientRect();
    return {
      x: rect.left + ((point.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - point.y) / 2) * rect.height,
    };
  }, [getThree, gl, position]);

  const endMarquee = useCallback((event: PointerEvent | null) => {
    const state = marquee.current;
    if (!state) return;
    marquee.current = null;
    state.box.remove();
    setOrbitEnabled(true);
    if (!event) return;

    const left = Math.min(state.x, event.clientX);
    const right = Math.max(state.x, event.clientX);
    const top = Math.min(state.y, event.clientY);
    const bottom = Math.max(state.y, event.clientY);
    // A box small enough to be a click IS a click, and picks whatever was under
    // it — which is why selecting a face happens on the way up. Every drag has
    // to be free to start over the model, or a box can only be drawn in the
    // empty space around the thing you are trying to draw it around.
    if (right - left < 3 && bottom - top < 3) {
      if (state.click?.kind === 'face') {
        const face = state.click.face;
        // Shift adds, so a pair can be built up for J — and clicking a face that
        // is already in the selection takes it back out, which is the only way
        // to correct a mis-aimed second click without starting again.
        setSelectedFaces((current) => (state.additive
          ? current.includes(face) ? current.filter((f) => f !== face) : [...current, face]
          : [face]));
        setSelectedEdges([]);
        setSelectedVertices([]);
      } else if (state.click?.kind === 'edge') {
        // Same rule as faces: adding builds a run of edges up, and clicking one
        // that is already in takes it back out.
        const edge = state.click.edge;
        setSelectedEdges((current) => edgesMeant(lattice, edge).reduce((acc, e) => chooseEdge(acc, e, state.additive || acc !== current), current));
        setSelectedFaces([]);
        setSelectedVertices([]);
      } else if (!state.additive) {
        setSelectedVertices([]);
        setSelectedFaces([]);
        setSelectedEdges([]);
      }
      return;
    }

    const caught: number[] = [];
    for (const v of handles) {
      const at = toScreen(v);
      if (!at) continue;
      if (at.x >= left && at.x <= right && at.y >= top && at.y <= bottom) caught.push(v);
    }
    setSelectedVertices((current) => (state.additive ? [...new Set([...current, ...caught])] : caught));
    setSelectedFaces([]);
    setSelectedEdges([]);
  }, [handles, lattice, setOrbitEnabled, toScreen]);

  const beginMarquee = useCallback((event: ThreeEvent<PointerEvent>, click: ClickTarget = null) => {
    // A plain div over the page rather than anything in the scene: the box is a
    // screen rectangle, it has no position in the model, and drawing it as
    // geometry would mean unprojecting it every frame to keep it flat.
    const box = document.createElement('div');
    box.style.cssText = [
      'position:fixed', 'z-index:50', 'pointer-events:none',
      'border:1px solid #0ea5e9', 'background:rgba(14,165,233,0.12)', 'border-radius:2px',
      `left:${event.clientX}px`, `top:${event.clientY}px`, 'width:0px', 'height:0px',
    ].join(';');
    document.body.appendChild(box);
    marquee.current = { x: event.clientX, y: event.clientY, additive: additiveFrom(event), box, click };
    setOrbitEnabled(false);
  }, [setOrbitEnabled]);

  useEffect(() => {
    // On the window, not on the catcher: a box is usually dragged off the model
    // and often off the canvas, and a selection that stops when the pointer
    // leaves the mesh would be a box you can only draw over the thing you are
    // trying to select around.
    const move = (event: PointerEvent) => {
      const state = marquee.current;
      if (!state) return;
      const { style } = state.box;
      style.left = `${Math.min(state.x, event.clientX)}px`;
      style.top = `${Math.min(state.y, event.clientY)}px`;
      style.width = `${Math.abs(event.clientX - state.x)}px`;
      style.height = `${Math.abs(event.clientY - state.y)}px`;
    };
    const up = (event: PointerEvent) => endMarquee(event);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // A box left on screen by an unmount is a rectangle nobody can get rid of.
      marquee.current?.box.remove();
      marquee.current = null;
    };
  }, [endMarquee]);

  // -----------------------------------------------------------------------
  // Pointer handlers
  // -----------------------------------------------------------------------

  /**
   * A ray into the cage's own space from a raw screen position.
   *
   * The pointer handlers get R3F's ray for free; a gesture started from a
   * KEY has only a pixel to work from, so this builds the same thing.
   */
  const rayFromScreen = useCallback((x: number, y: number) => {
    const group = cageRef.current;
    if (!group) return null;
    const rect = gl.domElement.getBoundingClientRect();
    const caster = new THREE.Raycaster();
    caster.setFromCamera(
      new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -(((y - rect.top) / rect.height) * 2 - 1)),
      getThree().camera,
    );
    const inverse = new THREE.Matrix4().copy(group.matrixWorld).invert();
    return {
      origin: caster.ray.origin.clone().applyMatrix4(inverse),
      direction: caster.ray.direction.clone().transformDirection(inverse).normalize(),
    };
  }, [getThree, gl]);

  /**
   * A line held to the nearest 45 degrees from where it starts — Shift, in the
   * line tool. In the plane, so the depth of the point is left alone.
   */
  const constrain = useCallback((coord: LatticeCoord, from: LatticeCoord): LatticeCoord => {
    const [u, v] = OTHER_AXES[plane.axis];
    const du = coord[u] - from[u];
    const dv = coord[v] - from[v];
    const out: LatticeCoord = [...coord];
    if (Math.abs(du) > 2.414 * Math.abs(dv)) {
      out[v] = from[v];
    } else if (Math.abs(dv) > 2.414 * Math.abs(du)) {
      out[u] = from[u];
    } else {
      const m = Math.round((Math.abs(du) + Math.abs(dv)) / 2 / snap) * snap;
      out[u] = from[u] + Math.sign(du) * m;
      out[v] = from[v] + Math.sign(dv) * m;
    }
    return out;
  }, [plane.axis, snap]);

  const onPlaneMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (drag.current) {
      if (drag.current.kind === 'extrude') updateExtrude(event);
      else updateVertexDrag(event);
      return;
    }
    // A freehand stroke is followed from the window, not from here, so that
    // running off the catcher does not cut the line short.
    if (freehand) return;
    const ray = localRay(event);
    let coord = ray ? resolve(ray) : null;
    if (coord && tool === 'line' && event.shiftKey && pending.length > 0) {
      coord = constrain(coord, pending[pending.length - 1]);
    }
    setHover(coord);
  }, [constrain, freehand, localRay, pending, resolve, setHover, tool, updateExtrude, updateVertexDrag]);

  /**
   * Finishes a Bézier curve: its grid points go onto the polygon being drawn,
   * and if it ends where the polygon began, that closes it.
   */
  const finishCurve = useCallback((from: LatticeCoord, control1: LatticeCoord, control2: LatticeCoord, to: LatticeCoord) => {
    // Sampled on the FINEST grid, not the one clicks snap to: a curve is the
    // one thing here that is not a whole number of steps, and on a 10 mm grid
    // it came out as a staircase of the grid's own lines.
    const middle = curveCoords(from, control1, control2, to, plane.axis, 1);
    // The end goes on last, so an end back on the start closes the outline
    // whatever the middle did.
    const g = grown(pendingRef.current, [...middle.filter((c) => !sameCoord(c, to)), to]);
    settle(g.chain, g.closed);
  }, [grown, plane.axis, settle]);

  const onPlaneDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0) return;
    const ray = localRay(event);
    if (tool === 'select') {
      // An edge seen against the background is still an edge, so it gets first
      // refusal; anything else starts a box.
      const edge = ray && pickEdge(ray);
      if (edge) {
        setSelectedEdges((current) => edgesMeant(lattice, edge).reduce((acc, e) => chooseEdge(acc, e, additiveFrom(event) || acc !== current), current));
        setSelectedFaces([]);
        setSelectedVertices([]);
        event.stopPropagation();
        return;
      }
      event.stopPropagation();
      beginMarquee(event);
      return;
    }
    if (tool === 'shape') {
      const spot = ray && resolve(ray);
      if (!spot) return;
      event.stopPropagation();
      if (!shape) {
        // The first click is the centre, and it settles the plane the same way
        // placing a point does — work at a depth and the next thing you draw
        // appears there rather than back where the session started.
        const axis = AXIS_INDEX[plane.axis];
        if (!locked && spot[axis] !== plane.index) {
          useStore.getState().setLatticePlane({ axis: plane.axis, index: spot[axis] });
        }
        setShape({ coord: spot, axis: plane.axis });
        return;
      }
      const ring = ringCoords(shape.coord, shapeRadius(spot), shape.axis, shapeSides);
      if (ring) {
        mutate(() => { addFaceMirrored(ring.map(([i, j, k]) => vertexAt(lattice, i, j, k))); });
      }
      setShape(null);
      return;
    }
    if (tool === 'bezier') {
      const spot = ray && resolve(ray);
      if (!spot) return;
      event.stopPropagation();
      // Nothing to curve from yet: the first click is the start — or, on the
      // end of a wire, picks that wire up to continue it.
      if (pending.length === 0) { const g = grown([], [spot]); settle(g.chain, g.closed); return; }
      const from = pending[pending.length - 1];
      if (!stroke) {
        if (!sameCoord(spot, from)) setStroke({ end: spot });
        return;
      }
      if (!stroke.control) {
        setStroke({ ...stroke, control: spot });
        return;
      }
      finishCurve(from, stroke.control, spot, stroke.end);
      setStroke(null);
      return;
    }
    if (tool === 'freehand') {
      const spot = ray && resolve(ray);
      if (!spot) return;
      event.stopPropagation();
      // The press puts the first corner down — or, on the first corner of a
      // polygon already three corners long, closes it, as any click does.
      const g = grown(pending, [spot]);
      settle(g.chain, g.closed);
      if (!g.closed) setFreehand(true);
      return;
    }
    if (tool !== 'place' && tool !== 'line') return;
    let coord = ray && resolve(ray);
    if (!coord) return;
    event.stopPropagation();
    if (tool === 'line') {
      if (event.shiftKey && pending.length > 0) coord = constrain(coord, pending[pending.length - 1]);
      const g = grown(pending, [coord]);
      settle(g.chain, g.closed);
      return;
    }
    // Working at a depth moves the work plane there, so the next point placed in
    // empty space appears beside the last one rather than back on whatever plane
    // the session started on.
    const axis = AXIS_INDEX[plane.axis];
    if (!locked && coord[axis] !== plane.index) {
      useStore.getState().setLatticePlane({ axis: plane.axis, index: coord[axis] });
    }
    placeAt(coord);
  }, [addFaceMirrored, beginMarquee, constrain, finishCurve, grown, lattice, localRay, locked, mutate, pending, pickEdge, placeAt, plane, resolve, settle, shape, shapeRadius, shapeSides, stroke, tool]);

  /*
   * The freehand stroke, followed from the window so it survives leaving the
   * catcher. Each new grid point the pointer crosses goes onto the polygon;
   * crossing back onto the point before takes the last one off again, which is
   * how a wobble is undone without a key. A point already on the polygon is
   * never added twice — except the first one, which the release lands on to
   * close the shape.
   */
  useEffect(() => {
    if (!freehand) return;
    setOrbitEnabled(false);
    const move = (event: PointerEvent) => {
      const ray = rayFromScreen(event.clientX, event.clientY);
      const coord = ray && snapFromPlane(ray);
      if (!coord) return;
      setHover(coord);
      setPending((points) => {
        const n = points.length;
        if (n > 0 && sameCoord(points[n - 1], coord)) return points;
        if (n > 1 && sameCoord(points[n - 2], coord)) return points.slice(0, -1);
        if (points.some((p) => sameCoord(p, coord))) return points;
        return [...points, coord];
      });
    };
    const up = (event: PointerEvent) => {
      setFreehand(false);
      const ray = rayFromScreen(event.clientX, event.clientY);
      const coord = ray && snapFromPlane(ray);
      const points = pendingRef.current;
      // Let go on the first corner and the outline closes; anywhere else and
      // the stroke stays as a wire, to be carried on from or closed later.
      settle(points, !!coord && points.length >= 3 && sameCoord(points[0], coord));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setOrbitEnabled(true);
    };
  }, [freehand, rayFromScreen, setHover, setOrbitEnabled, settle, snapFromPlane]);

  // A curve half-placed under one tool means nothing to the next. Reset on
  // the way through a render rather than in an effect, so the next frame
  // never shows the old tool's stroke under the new tool's cursor.
  const [strokeTool, setStrokeTool] = useState(tool);
  if (strokeTool !== tool) {
    setStrokeTool(tool);
    setStroke(null);
    setFreehand(false);
  }

  // What the drawing tools want next, said where the eyes are.
  useEffect(() => {
    if (!drawing) return;
    const text = tool === 'freehand'
      ? 'Freehand · drag on the plane; let go on the first corner to close'
      : tool === 'line'
        ? 'Line · click corner to corner; Shift holds it to 45°'
        : !stroke
          ? (pending.length === 0 ? 'Bézier · click where the curve starts, or the end of a wire to continue it' : 'Bézier · click where the curve ends')
          : !stroke.control
            ? 'Bézier · click to pull the curve out of its start'
            : 'Bézier · click to pull the curve into its end';
    setGestureStatus(text);
    return () => setGestureStatus(null);
  }, [drawing, pending.length, setGestureStatus, stroke, tool]);

  const onFaceDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0 || event.faceIndex == null) return;
    const face = pick.triangleFace[event.faceIndex];
    if (face === undefined) return;
    // Drawing goes through the plane, not the model: a face is a lump of
    // screen and a circle drawn over one still has to resolve to a grid point.
    if (tool === 'place' || tool === 'shape' || DRAWING_TOOLS.has(tool)) return;
    event.stopPropagation();

    // An edge near the click beats the face behind it. Aiming at an edge is
    // aiming at a line a couple of pixels wide, and the face is a much bigger
    // target sitting right behind it — without this the edge is unhittable.
    if (tool === 'select') {
      const ray = localRay(event);
      const edge = ray && pickEdge(ray);
      beginMarquee(event, edge ? { kind: 'edge', edge } : { kind: 'face', face });
      return;
    }

    setSelectedFaces([face]);
    setSelectedVertices([]);
    setSelectedEdges([]);
    if (tool === 'extrude') beginExtrude(face, event);
  }, [beginExtrude, beginMarquee, localRay, pick.triangleFace, pickEdge, tool]);

  const onFaceMove = useCallback((event: ThreeEvent<PointerEvent>) => {
    // Only while extruding. Everywhere else the target is a corner or an edge,
    // and lighting up the whole face behind them says the wrong thing.
    if (tool !== 'extrude' || drag.current) return;
    setHoveredFace(event.faceIndex == null ? null : pick.triangleFace[event.faceIndex] ?? null);
  }, [pick.triangleFace, tool]);

  const onHandleDown = useCallback((event: ThreeEvent<PointerEvent>) => {
    if (event.button !== 0 || tool !== 'select' || event.instanceId == null) return;
    const vertex = handles[event.instanceId];
    if (vertex === undefined) return;
    event.stopPropagation();
    // Held modifier: add this corner to the selection, or drop it back out if
    // it was already in — the same toggle a face gets, and the only way to
    // build up a set of corners that no single box can catch.
    if (additiveFrom(event)) {
      let dropped = false;
      setSelectedVertices((current) => {
        if (current.includes(vertex)) {
          dropped = true;
          return current.filter((v) => v !== vertex);
        }
        return [...current, vertex];
      });
      setSelectedFaces([]);
      setSelectedEdges([]);
      // Dragging a corner that the same click just deselected would move it
      // anyway, which is not what taking it out of the selection means.
      if (!dropped) beginVertexDrag(vertex, event);
      return;
    }
    setSelectedVertices((current) => (current.includes(vertex) ? current : [vertex]));
    setSelectedFaces([]);
    setSelectedEdges([]);
    beginVertexDrag(vertex, event);
  }, [beginVertexDrag, handles, tool]);

  // -----------------------------------------------------------------------
  // Gestures: a key that starts, then the pointer decides how much
  // -----------------------------------------------------------------------
  //
  // Inset and scale both need a SIZE, and a key on its own cannot ask for one.
  // Inset used to answer that with one grid step, which is right about as often
  // as one grid step happens to be the wall you wanted. So the key starts the
  // operation and the pointer sizes it, live, the way every modelling tool has
  // worked since Blender: move to size it, click or Enter to keep it, Esc or
  // right-click to put it back. No button is held — the hand is free to travel
  // the width of the screen, which is the whole range of the gesture.

  type Gesture =
    | { kind: 'inset'; faces: number[]; snapshot: Lattice; centre: { x: number; y: number }; radius: number; steps: number; step: number; limit: number; inner: number[] }
    | { kind: 'scale'; vertices: number[]; about: LatticeCoord; snapshot: Lattice; centre: { x: number; y: number }; radius: number; axis: Axis | null; applied: boolean }
    | { kind: 'move'; vertices: number[]; snapshot: Lattice; from: THREE.Vector3; through: THREE.Vector3; axis: Axis | null; step: LatticeCoord };

  const gesture = useRef<Gesture | null>(null);
  /** Mirrors `gesture.current`'s kind into React, to hang the listeners off. */
  const [gestureKind, setGestureKind] = useState<null | 'inset' | 'scale' | 'move'>(null);
  const pointer = useRef({ x: 0, y: 0 });

  // Where the pointer is, always — a gesture starts from a keypress, and a
  // keypress carries no coordinates.
  useEffect(() => {
    const track = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener('pointermove', track);
    return () => window.removeEventListener('pointermove', track);
  }, []);

  /**
   * Where the pointer is, on the surface a move gesture is measured against.
   *
   * Unconstrained, that is a plane parallel to the work plane through the
   * selection — so a move slides across the slice you are looking at, the same
   * two axes a drag on a corner uses. Constrained to one axis, it is the plane
   * containing that axis and facing the camera, which is what the extrude drag
   * already measures along.
   */
  const moveHit = useCallback((x: number, y: number, through: THREE.Vector3, axis: Axis | null) => {
    const ray = rayFromScreen(x, y);
    if (!ray) return null;
    const surface = axis
      ? dragPlane(axis, through)
      : new THREE.Plane().setFromNormalAndCoplanarPoint(
        new THREE.Vector3(plane.axis === 'x' ? 1 : 0, plane.axis === 'y' ? 1 : 0, plane.axis === 'z' ? 1 : 0),
        through,
      );
    return new THREE.Ray(ray.origin, ray.direction).intersectPlane(surface, new THREE.Vector3());
  }, [dragPlane, plane.axis, rayFromScreen]);

  /** The middle of a set of corners, in client pixels. */
  const screenCentre = useCallback((verts: number[]) => {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const v of verts) {
      const at = toScreen(v);
      if (!at) continue;
      x += at.x;
      y += at.y;
      n += 1;
    }
    return n === 0 ? null : { x: x / n, y: y / n };
  }, [toScreen]);

  /**
   * Re-runs the gesture at whatever the pointer is now.
   *
   * From the snapshot every time, for the same reason the extrude drag does:
   * an inset dragged back to nothing has to leave nothing behind, and a scale
   * applied on top of itself compounds.
   */
  const updateGesture = useCallback(() => {
    const state = gesture.current;
    if (!state) return;

    if (state.kind === 'move') {
      // Whole grid steps of travel across the measuring plane. The corners are
      // integers, so a move is a whole number of steps or it is nothing —
      // there is no half-step to round to later.
      const hit = moveHit(pointer.current.x, pointer.current.y, state.through, state.axis);
      if (!hit) return;
      const step: LatticeCoord = [0, 0, 0];
      const axes: (0 | 1 | 2)[] = state.axis
        ? [AXIS_INDEX[state.axis]]
        : [...OTHER_AXES[plane.axis]];
      for (const k of axes) {
        step[k] = Math.round((hit.toArray()[k] - state.from.toArray()[k]) / (unit * snap)) * snap;
      }
      if (step.every((d, k) => d === state.step[k])) return;
      restoreLattice(lattice, state.snapshot);
      moveVertices(lattice, state.vertices, step[0], step[1], step[2]);
      state.step = step;
      const said = (['x', 'y', 'z'] as const)
        .map((name, k) => (step[k] === 0 ? null : `${name.toUpperCase()} ${mmText(step[k] * unit)}`))
        .filter(Boolean);
      setGestureStatus(said.length === 0 ? 'Move' : `Move ${said.join(' · ')}`);
      setRevision((r) => r + 1);
      return;
    }

    const away = Math.hypot(pointer.current.x - state.centre.x, pointer.current.y - state.centre.y);

    if (state.kind === 'inset') {
      // Out from the middle of the face thickens the border, the way inset
      // reads everywhere else. Pixels become millimetres through the same
      // metres-per-pixel the marks are sized with, so the shape follows the
      // pointer at the scale the screen is actually showing.
      // One grid step the moment the key is pressed, and never less: pressing I
      // and seeing nothing at all happen is how the gesture reads as broken —
      // especially on a flat face, where an inset changes the cage without
      // changing the silhouette. The pointer takes it from there.
      const travel = Math.round((away - state.radius) * perPixelRef.current / unit / state.step) * state.step;
      const steps = Math.min(state.limit, Math.max(state.step, state.step + travel));
      if (steps === state.steps) return;
      restoreLattice(lattice, state.snapshot);
      const inner: number[] = [];
      if (steps > 0) {
        for (const face of state.faces) {
          const result = insetFace(lattice, face, steps);
          if (result) inner.push(result.inner);
          if (!mirror) continue;
          const partner = findMirrorFace(lattice, face, mirror);
          if (partner !== -1) insetFace(lattice, partner, steps);
        }
        // Too far in and the ring turns itself inside out, which insetFace
        // refuses: hold the last inset that worked rather than snapping back to
        // none half way through the drag.
        if (inner.length === 0) {
          restoreLattice(lattice, state.snapshot);
          for (const face of state.faces) {
            const result = insetFace(lattice, face, state.steps);
            if (result) inner.push(result.inner);
            if (!mirror) continue;
            const partner = findMirrorFace(lattice, face, mirror);
            if (partner !== -1) insetFace(lattice, partner, state.steps);
          }
          state.inner = inner;
          setRevision((r) => r + 1);
          return;
        }
      }
      state.steps = steps;
      state.inner = inner;
      setGestureStatus(`Inset ${mmText(steps * unit)}`);
      setRevision((r) => r + 1);
      return;
    }

    // Scale. Measured from where the pointer was when the key was pressed, so
    // the shape does not jump the instant the gesture starts: at that moment
    // the factor is exactly 1, whatever part of the screen the pointer is on.
    // The reference length has a floor, because a pointer that happens to start
    // on the middle of the selection would otherwise make every pixel of travel
    // a doubling.
    // Clamped both ways: a pointer on the middle of the selection would make
    // every pixel a doubling, and one started from across the window would need
    // the width of the screen to do anything.
    const reference = Math.min(240, Math.max(48, state.radius));
    const factor = Math.max(0, (away - state.radius + reference) / reference);
    restoreLattice(lattice, state.snapshot);
    state.applied = scaleVertices(lattice, state.vertices, state.about, factor, snap, state.axis);
    setGestureStatus(`Scale ${factor.toFixed(2)}×${state.axis ? ` · ${state.axis.toUpperCase()}` : ''}`);
    setRevision((r) => r + 1);
  }, [lattice, mirror, moveHit, plane.axis, setGestureStatus, snap, unit]);

  const endGesture = useCallback((keep: boolean) => {
    const state = gesture.current;
    if (!state) return;
    gesture.current = null;
    setGestureKind(null);
    setGestureStatus(null);
    setOrbitEnabled(true);

    const changed = state.kind === 'inset' ? state.steps > 0
      : state.kind === 'move' ? state.step.some((d) => d !== 0)
        : state.applied;
    if (keep && changed) {
      // The new inner face is what anybody wants next — pushed in, pulled out
      // or bridged — so the selection follows it rather than being lost.
      if (state.kind === 'inset') setSelectedFaces(state.inner);
      commit();
      return;
    }
    restoreLattice(lattice, state.snapshot);
    undoStack.current.pop();
    setRevision((r) => r + 1);
  }, [commit, lattice, setGestureStatus, setOrbitEnabled]);

  const beginGesture = useCallback((kind: 'inset' | 'scale' | 'move') => {
    if (gesture.current) return;
    const faces = selectedFaces;
    const vertices = selectedVertices.length > 0
      ? selectedVertices
      : [...new Set(faces.flatMap((f) => lattice.faces[f] ?? []))];
    if (kind === 'inset' && faces.length === 0) return;
    // One corner is a perfectly good thing to move; scaling or insetting it is
    // not, since both need something with a size.
    if (vertices.length < (kind === 'move' ? 1 : 2)) return;

    const snapshot = cloneLattice(lattice);

    if (kind === 'move') {
      const through = new THREE.Vector3();
      for (const v of vertices) through.add(new THREE.Vector3(...position(v)));
      through.multiplyScalar(1 / vertices.length);
      const from = moveHit(pointer.current.x, pointer.current.y, through, null);
      if (!from) return;
      undoStack.current.push(cloneLattice(lattice));
      redoStack.current.length = 0;
      gesture.current = { kind, vertices: [...vertices], snapshot, from, through, axis: null, step: [0, 0, 0] };
      setGestureKind(kind);
      setGestureStatus('Move');
      setOrbitEnabled(false);
      return;
    }

    const centre = screenCentre(kind === 'inset'
      ? [...new Set(faces.flatMap((f) => lattice.faces[f] ?? []))]
      : vertices);
    if (!centre) return;
    const radius = Math.hypot(pointer.current.x - centre.x, pointer.current.y - centre.y);
    undoStack.current.push(cloneLattice(lattice));
    redoStack.current.length = 0;

    if (kind === 'inset') {
      /*
       * How far in one notch of the gesture goes, and how far in it can get.
       *
       * The obvious answer — one step of the current grid — has one usable
       * value on a 40 mm face at a 10 mm grid: two steps would meet in the
       * middle, insetFace refuses, and the gesture looks stuck at a default.
       * So the step drops a decade at a time until there is a range to drag
       * through. The finer corners are still exactly on the grid, because the
       * steps are decades and decades nest.
       */
      let half = Infinity;
      for (const face of faces) {
        const verts = lattice.faces[face];
        if (!verts) continue;
        const normal = faceNormal(lattice, face);
        if (!normal) continue;
        const skip = AXIS_INDEX[dominantAxis(normal).axis];
        for (let k = 0; k < 3; k++) {
          if (k === skip) continue;
          let lo = Infinity;
          let hi = -Infinity;
          for (const v of verts) {
            const c = coordOf(lattice, v)[k];
            lo = Math.min(lo, c);
            hi = Math.max(hi, c);
          }
          if (hi > lo) half = Math.min(half, (hi - lo) / 2);
        }
      }
      if (!Number.isFinite(half) || half < 1) return;
      let step: number = snap;
      while (step > 1 && half / step < 3) step = Math.max(1, Math.round(step / 10));
      // One step short of meeting in the middle: a ring pulled all the way in
      // is a face with no area, which insetFace refuses anyway.
      const limit = Math.max(step, Math.floor((half - step) / step) * step);
      gesture.current = { kind, faces: [...faces], snapshot, centre, radius, steps: 0, step, limit, inner: [] };
      setGestureKind(kind);
      setOrbitEnabled(false);
      // Straight to one step, so the shape moves on the keypress rather than
      // waiting for the pointer to be moved by somebody who does not yet know
      // that is what it wants.
      updateGesture();
      return;
    }
    {
      // The point it scales about is the middle of the selection itself, so a
      // face shrinks in place instead of sliding towards the body origin.
      const about: LatticeCoord = [0, 0, 0];
      for (const v of vertices) {
        const coord = coordOf(lattice, v);
        for (let k = 0; k < 3; k++) about[k] += coord[k] / vertices.length;
      }
      gesture.current = { kind, vertices: [...vertices], about, snapshot, centre, radius, axis: null, applied: false };
    }
    setGestureKind(kind);
    setGestureStatus('Scale 1.00×');
    setOrbitEnabled(false);
  }, [lattice, moveHit, position, screenCentre, selectedFaces, selectedVertices, setGestureStatus, setOrbitEnabled, snap, updateGesture]);

  // While a gesture is running the pointer belongs to it: every button press
  // is an answer to it rather than a click on the model behind it, which is why
  // these listen in the capture phase and stop what they catch.
  useEffect(() => {
    if (!gestureKind) return;
    const move = (event: PointerEvent) => {
      pointer.current = { x: event.clientX, y: event.clientY };
      updateGesture();
    };
    const down = (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      endGesture(event.button === 0);
    };
    const swallow = (event: Event) => {
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
      // Leaving the mode mid-gesture would otherwise leave the camera locked,
      // and the status bar claiming a gesture that is no longer running.
      setOrbitEnabled(true);
      setGestureStatus(null);
    };
  }, [endGesture, gestureKind, setGestureStatus, setOrbitEnabled, updateGesture]);

  /**
   * Chamfer or round the selected edges, by a radius in millimetres.
   *
   * One call for all of them rather than one per edge: a bevel has to see its
   * neighbours to get the corner where two of them meet right, and cutting them
   * one at a time would cut the second from a shape the first had moved.
   */
  const bevelSelectedEdges = useCallback((mode: 'chamfer' | 'fillet', mm: number) => {
    if (selectedEdges.length === 0) return;
    const steps = Math.max(1, Math.round(mm / 1000 / lattice.unit));
    const edges: [number, number][] = [...selectedEdges];
    if (mirror) {
      const reflect = (v: number) => {
        const [i, j, k] = mirrorCoord(coordOf(lattice, v), mirror);
        return findVertex(lattice, i, j, k);
      };
      for (const [a, b] of selectedEdges) {
        const [ma, mb] = [reflect(a), reflect(b)];
        // Not if the reflection is the edge itself: an edge lying in the mirror
        // plane is its own reflection, and cutting it twice is cutting a shape
        // that is no longer there.
        if (ma !== -1 && mb !== -1 && !(ma === a && mb === b)) edges.push([ma, mb]);
      }
    }
    mutate(() => { bevelEdges(lattice, edges, steps, mode); });
    setSelectedEdges([]);
  }, [lattice, mirror, mutate, selectedEdges]);

  /**
   * Sweeps the selected profile about one of the body's own axes.
   *
   * The axis is a whole axis of the body rather than an arbitrary line, because
   * that is what a lathe is: you put the work on the spindle. Moving the profile
   * is how you change the radius, which is the same thing and one fewer number
   * to get wrong.
   */
  const revolveSelection = useCallback((axis: Axis, degrees: number) => {
    const chain = selectedEdges.length > 0
      ? chainFromEdges(selectedEdges)
      : selectedFaces.length === 1
        ? (() => {
          const verts = lattice.faces[selectedFaces[0]];
          return verts ? { chain: [...verts, verts[0]], closed: true } : null;
        })()
        : null;
    if (!chain) return;
    // A closed profile has to come back to where it started, or the sweep
    // leaves a slot down its length where the two ends never met.
    const run = chain.closed && chain.chain[0] !== chain.chain[chain.chain.length - 1]
      ? [...chain.chain, chain.chain[0]]
      : chain.chain;
    const fromFace = selectedEdges.length === 0 ? selectedFaces[0] : -1;
    mutate(() => {
      const swept = revolveChain(lattice, run, axis, [0, 0, 0], 0, degrees);
      if (!swept) return false;
      if (fromFace === -1) return;
      if (degrees >= 360) {
        // A full turn brings the wall back through the face it started from,
        // which leaves it buried inside the solid — invisible, and a surface
        // the exporter has to make some decision about.
        removeFace(lattice, fromFace);
      } else {
        // A partial turn has two open ends. The profile is the first cap; the
        // ring it finished at is the other, and without it the shape is a
        // shell with a slot down one side.
        const last = swept.rings[swept.rings.length - 1];
        const cap: number[] = [];
        for (const vertex of last) if (cap[cap.length - 1] !== vertex) cap.push(vertex);
        if (cap.length > 2 && cap[0] === cap[cap.length - 1]) cap.pop();
        if (cap.length >= 3) addFace(lattice, cap);
        orientFaces(lattice);
      }
    });
    setSelectedEdges([]);
    setSelectedFaces([]);
  }, [lattice, mutate, selectedEdges, selectedFaces]);

  // The diameter, while it is being dragged out. A circle sized by the pointer
  // has no handle and no box to read a number off, and "about that big" is not
  // what anybody wants from a bolt hole.
  useEffect(() => {
    if (!shape) return;
    const ring = ringFor(hover);
    const radius = hover ? shapeRadius(hover) : 0;
    const mm = radius * unit * 1000;
    setGestureStatus(`Circle ⌀${(mm * 2).toFixed(mm < 5 ? 2 : 1)} mm · ${ring?.length ?? 0} sides`);
    return () => setGestureStatus(null);
  }, [hover, ringFor, setGestureStatus, shape, shapeRadius, unit]);

  const revolveRequest = useStore((state) => state.latticeRevolveRequest);
  const revolveSeen = useRef(revolveRequest?.nonce ?? 0);
  useEffect(() => {
    if (!revolveRequest || revolveRequest.nonce === revolveSeen.current) return;
    revolveSeen.current = revolveRequest.nonce;
    revolveSelection(revolveRequest.axis, revolveRequest.degrees);
  }, [revolveRequest, revolveSelection]);

  const bevelRequest = useStore((state) => state.latticeBevelRequest);
  const bevelSeen = useRef(bevelRequest?.nonce ?? 0);
  useEffect(() => {
    if (!bevelRequest || bevelRequest.nonce === bevelSeen.current) return;
    bevelSeen.current = bevelRequest.nonce;
    bevelSelectedEdges(bevelRequest.mode, bevelRequest.mm);
  }, [bevelRequest, bevelSelectedEdges]);

  // -----------------------------------------------------------------------
  // Keys
  // -----------------------------------------------------------------------

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      const key = event.key.toLowerCase();

      // The measure tool is out, and it has taken the left button with it. A
      // key that edited the cage while its clicks were being swallowed would
      // change a shape nobody could see themselves changing.
      if (useStore.getState().measureMode) return;

      // A gesture owns the keyboard while it runs: X/Y/Z confine it instead of
      // turning the work plane, and the keys that end it end it.
      const running = gesture.current;
      if (running) {
        event.preventDefault();
        // Immediate: the tool palette listens on the window too, and 1/2/3
        // switching tools out from under a running gesture is not an answer to
        // the question the gesture is asking.
        event.stopImmediatePropagation();
        if (key === 'escape') { endGesture(false); return; }
        if (key === 'enter' || key === ' ') { endGesture(true); return; }
        if (running.kind !== 'inset' && (key === 'x' || key === 'y' || key === 'z')) {
          // Pressing the axis it is already confined to lets it go again, which
          // is how you correct a mis-hit without cancelling the whole gesture.
          running.axis = running.axis === key ? null : (key as Axis);
          updateGesture();
        }
        return;
      }

      if ((event.metaKey || event.ctrlKey) && key === 'z') {
        const stack = event.shiftKey ? redoStack.current : undoStack.current;
        const other = event.shiftKey ? undoStack.current : redoStack.current;
        const snapshot = stack.pop();
        if (!snapshot) return;
        event.preventDefault();
        event.stopPropagation();
        other.push(cloneLattice(lattice));
        restoreLattice(lattice, snapshot);
        setSelectedFaces([]);
        setSelectedVertices([]);
        // The wire indices this hand was holding mean nothing in the snapshot.
        setPending([]);
        wireRef.current = -1;
        setRevision((r) => r + 1);
        commit();
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (key === 'escape') {
        // A wire already in the cage stays there; only the hand lets go of it.
        setPending([]);
        wireRef.current = -1;
        setShape(null);
        setStroke(null);
        setFreehand(false);
        setSelectedFaces([]);
        setSelectedVertices([]);
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
        const axis = key as Axis;
        const at = hoverRef.current;
        // Turning the plane keeps you where you are working. Index 0 was the
        // world origin, which on a part built anywhere else is a slice through
        // nothing — the keys worked and felt like they had not, because the lit
        // slice vanished off the model.
        let index = at ? at[AXIS_INDEX[axis]] : 0;
        if (!at) {
          const bounds = latticeBounds(lattice);
          if (bounds) {
            const middle = (bounds.min[AXIS_INDEX[axis]] + bounds.max[AXIS_INDEX[axis]]) / 2;
            index = Math.round(middle / snap) * snap;
          }
        }
        useStore.getState().setLatticePlane({ axis, index });
        return;
      }
      if (key === 'delete' || key === 'backspace') {
        // Swallowed whether or not there is anything to delete. The app's own
        // Delete removes the selected BODY, and while these tools are open that
        // is the entire lattice — one keypress away from losing the work,
        // reachable by aiming slightly wrong.
        event.preventDefault();
        event.stopPropagation();

        // Selected edges of a wire come out of it — before the corner under
        // the pointer is considered, because the pointer is on the wire that
        // was just clicked to select it. A face's edges have nothing to delete
        // but the face, which is a different selection.
        if (selectedEdges.length > 0 && selectedFaces.length === 0 && selectedVertices.length === 0) {
          const edges = [...selectedEdges];
          mutate(() => {
            let any = false;
            for (const [a, b] of edges) any = removeWireEdge(lattice, a, b) || any;
            return any ? undefined : false;
          });
          setSelectedEdges([]);
          setPending([]);
          wireRef.current = -1;
          return;
        }
        const vertices = selectedVertices.length > 0
          ? selectedVertices
          : hoverVertex !== -1 ? [hoverVertex] : [];
        if (selectedFaces.length === 0 && vertices.length === 0) return;

        mutate(() => {
          if (selectedFaces.length > 0) {
            for (const face of selectedFaces) {
              const partner = mirror ? findMirrorFace(lattice, face, mirror) : -1;
              removeFace(lattice, face);
              if (partner !== -1) removeFace(lattice, partner);
            }
            return;
          }
          for (const vertex of vertices) {
            const [i, j, k] = mirrorCoord(coordOf(lattice, vertex), mirror ?? 'x');
            const partner = mirror ? findVertex(lattice, i, j, k) : -1;
            removeVertex(lattice, vertex);
            if (partner !== -1 && partner !== vertex) removeVertex(lattice, partner);
          }
        });
        setSelectedFaces([]);
        setSelectedVertices([]);
        setPending([]);
        wireRef.current = -1;
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

      if (key === 'g' || key === 'm') {
        // Move what is selected, sized by the pointer — a face, a loop or a
        // boxful of corners, which dragging a single handle cannot do. On G
        // where a modeller expects it, and on M for everyone who reads it as
        // "move".
        beginGesture('move');
        return;
      }

      if (key === 's') {
        // Scale, sized by the pointer — see the gesture section above. S rather
        // than any other letter because it is S everywhere else, which cost
        // sharpening its key: that moved to H, for sHarp.
        beginGesture('scale');
        return;
      }

      if (key === 'h' && (selectedEdges.length > 0 || selectedFaces.length > 0)) {
        // Sharpen. The one control that makes smoothing usable for a part
        // rather than a pebble: everything rounds except what is marked.
        //
        // With a FACE selected it marks that face's whole border, which is the
        // only cheap way to reach the rim of a cap — the corners there are
        // three-way, so L finds no loop through them and never will. Selecting
        // the face and pressing S is four edges in one keystroke.
        const edges: [number, number][] = selectedEdges.length > 0
          ? selectedEdges
          : selectedFaces.flatMap((face) => {
            const verts = lattice.faces[face];
            if (!verts) return [];
            return verts.map((v, i) => [v, verts[(i + 1) % verts.length]] as [number, number]);
          });
        if (edges.length === 0) return;

        // Softening only when the WHOLE selection is already sharp, so pressing
        // H on a rim that is half marked finishes the job rather than inverting
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

      if (key === 'n') {
        // Turn everything the right way round. On the N key because it is what
        // "recalculate normals" is on everywhere else.
        mutate(() => { orientFaces(lattice); });
        return;
      }

      if (key === 'f' && selectedFaces.length > 0) {
        // Flip: the fix for a face drawn from the wrong side, which is
        // otherwise invisible until it is exported and the solid has a hole.
        // N does the whole shape; this is for the one you disagree with.
        const faces = [...selectedFaces];
        mutate(() => {
          for (const face of faces) {
            const partner = mirror ? findMirrorFace(lattice, face, mirror) : -1;
            flipFace(lattice, face);
            if (partner !== -1) flipFace(lattice, partner);
          }
        });
        return;
      }

      if (key === 'i' && selectedFaces.length > 0) {
        // Inset: a smaller face inside this one, with a border of quads around
        // it. The start of a hole, and the only way to get a face small enough
        // to bridge through a solid. How far in is the pointer's to say — one
        // grid step was a guess that happened to be right about as often as the
        // wall you wanted happened to be 0.1 mm.
        beginGesture('inset');
        return;
      }

      if ((key === 'b' || key === 'r') && selectedEdges.length > 0) {
        // Chamfer (B) and fillet (R) an edge of the SOLID. The same cut both
        // times — a strip taken off along the edge, with the tear on either
        // side stitched back up — and they differ only in whether the strip is
        // creased. Creased, smoothing keeps it a flat chamfer; left soft, the
        // subdivision rounds it into an arc of about the strip's own width,
        // which is what makes the radius a number you chose rather than
        // whatever the smoothing felt like.
        bevelSelectedEdges(key === 'b' ? 'chamfer' : 'fillet', useStore.getState().latticeBevelMm);
        return;
      }

      if (key === 'b' && selectedFaces.length > 0) {
        // Cut the corners off. A square becomes an octagon, and an octagon
        // smoothed is a circle — which four corners can never be, however many
        // times they are subdivided.
        const faces = [...selectedFaces];
        mutate(() => {
          for (const face of faces) {
            bevelFace(lattice, face, snap);
            if (!mirror) continue;
            const partner = findMirrorFace(lattice, face, mirror);
            if (partner !== -1) bevelFace(lattice, partner, snap);
          }
        });
        setSelectedFaces([]);
        return;
      }

      if (key === 'j' && selectedFaces.length === 2) {
        // Join. Two faces of two shapes make them one; two faces of the SAME
        // shape bore a tunnel between them.
        const [a, b] = selectedFaces;
        mutate(() => { bridgeFaces(lattice, a, b); });
        setSelectedFaces([]);
        return;
      }
    };
    // Capture, so the app's own undo does not also fire while these tools are
    // open and own the shape.
    window.addEventListener('keydown', onKey, true);
    // The status bar's mode menu asks for the same gestures by name, for
    // anybody who has not learned the keys — or has no keyboard to hand.
    const onAsked = (event: Event) => {
      // The measure tool rides the same event (see MeasureTool), so the kinds
      // this surface owns are named rather than assumed.
      const kind = (event as CustomEvent<{ kind: string }>).detail?.kind;
      if (kind === 'move' || kind === 'scale' || kind === 'inset') beginGesture(kind);
    };
    window.addEventListener('physbox:gesture', onAsked);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('physbox:gesture', onAsked);
    };
  }, [beginGesture, closePending, commit, endGesture, hoverVertex, lattice, mirror, mutate, nudgeLatticePlane, selectedEdges, selectedFaces, selectedVertices, bevelSelectedEdges, snap, updateGesture]);

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
    // Lock to the plane through whatever is under the pointer, not to wherever
    // the work plane was left. Pressing Ctrl while hovering a corner means
    // "hold me to THIS one" — locking to a plane somewhere else is the opposite
    // of what the gesture asks for, and it takes the lit slice away from the
    // thing being pointed at.
    const landOnPointer = () => {
      const at = hoverRef.current;
      if (!at) return;
      const { latticePlane } = useStore.getState();
      const index = at[AXIS_INDEX[latticePlane.axis]];
      if (index !== latticePlane.index) useStore.getState().setLatticePlane({ ...latticePlane, index });
    };
    // Caps Lock is the hold that stays. A plain toggle on the key going down:
    // reading the lock's own state off the event looked cleverer and was not,
    // because Windows reports the state from BEFORE the press on keydown and
    // browsers disagree about keyup, so the second press did nothing. A Mac
    // sends keydown when the light turns on and keyup when it turns off, and
    // nothing in between, so there both edges toggle.
    const toggleHold = () => {
      const { latticePlaneHold, setLatticePlaneHold } = useStore.getState();
      if (!latticePlaneHold) landOnPointer();
      setLatticePlaneHold(!latticePlaneHold);
    };
    const mac = /Mac|iPhone|iPad/.test(navigator.platform);
    const down = (event: KeyboardEvent) => {
      if (event.key === 'CapsLock') { if (!event.repeat) toggleHold(); return; }
      if (event.key !== 'Control' && event.key !== 'Meta') return;
      landOnPointer();
      setCtrlHeld(true);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === 'CapsLock') { if (mac) toggleHold(); return; }
      if (event.key === 'Control' || event.key === 'Meta') setCtrlHeld(false);
    };
    const clear = () => setCtrlHeld(false);
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

  // -----------------------------------------------------------------------
  // Dimensions
  // -----------------------------------------------------------------------
  //
  // Everything above sizes a shape by moving the pointer, which is how you find
  // out what you want and a poor way to say it once you know. A bracket is 40 mm
  // across because the thing it bolts to is; no amount of dragging arrives at
  // that, and the number is the whole specification.
  //
  // So the selection is measured and published, the panel puts the measurements
  // in boxes, and a number typed into one comes back here as a request. The
  // corners stay integers throughout: a typed millimetre is rounded onto the
  // grid like any other placement, so a dimension can never introduce a corner
  // that the rest of the mode could not have made.

  /** Every corner the current selection covers, however it was selected. */
  const selectionCorners = useMemo(() => {
    const fromFaces = selectedFaces.flatMap((f) => lattice.faces[f] ?? []);
    const fromEdges = selectedEdges.flatMap(([a, b]) => [a, b]);
    return [...new Set([...selectedVertices, ...fromFaces, ...fromEdges])]
      .filter((v) => v >= 0 && v < vertexCount(lattice));
    // revision, because the cage is mutated in place: the corners a face names
    // stay the same numbers while what they point at moves underneath.
  }, [lattice, revision, selectedEdges, selectedFaces, selectedVertices]); // eslint-disable-line react-hooks/exhaustive-deps

  /*
   * The last measurements published, so an unchanged one is not published
   * again. This runs on every revision — which means every frame of a drag —
   * and a store write per frame re-renders the panel sixty times a second to
   * show it the same three numbers.
   */
  const publishedSelection = useRef<string>('');
  useEffect(() => {
    const bounds = selectionBoundsMm(lattice, selectionCorners);
    if (!bounds) {
      if (publishedSelection.current === '') return;
      publishedSelection.current = '';
      useStore.getState().setLatticeSelection(null);
      return;
    }
    // What it is called is what was selected, not what the corners add up to:
    // "loop" is the answer somebody who pressed L is expecting to see.
    const kind = selectedEdges.length > 1 ? 'loop'
      : selectedEdges.length === 1 ? 'edge'
        : selectedFaces.length > 1 ? 'faces'
          : selectedFaces.length === 1 ? 'face'
            : selectionCorners.length === 1 ? 'corner' : 'corners';
    const selection = { kind, corners: selectionCorners.length, ...bounds } as const;
    const fingerprint = JSON.stringify(selection);
    if (fingerprint === publishedSelection.current) return;
    publishedSelection.current = fingerprint;
    useStore.getState().setLatticeSelection(selection);
  }, [lattice, selectionCorners, selectedEdges.length, selectedFaces.length]);

  useEffect(() => () => useStore.getState().setLatticeSelection(null), []);

  /*
   * Where a new cut should land: the selected face — its real normal, and its
   * middle.
   *
   * The normal is used as it is, not snapped to the nearest axis. A lattice
   * VERTEX is three integers, but a face joining any three of them can point
   * anywhere: a triangle from (0,0,0) to (10,0,0) to (0,7,3) is as ordinary
   * here as a wall of a box, and bevelling makes 45-degree faces on purpose.
   * Rounding that to an axis gives a hole that is not square to the face it was
   * asked for, and says nothing about having done so.
   *
   * In the BODY's frame, not the cage's: a geom's `pos` is measured from the
   * body origin, and the mesh the cage produces has been recentred on its own
   * centre of mass to get there.
   */
  useEffect(() => {
    const face = selectedFaces[0];
    const normal = face === undefined ? null : faceNormal(lattice, face);
    const centre = face === undefined ? null : faceCentre(lattice, face);
    if (!normal || !centre) {
      if (useStore.getState().cutSpot?.nodeId === nodeId) useStore.getState().setCutSpot(null);
      return;
    }
    const origin = findLatticeNode(useStore.getState().sceneGraph.nodes, nodeId)?.latticeOrigin ?? [0, 0, 0];
    useStore.getState().setCutSpot({
      nodeId,
      at: centre.map((v, k) => v * unit - (origin[k] ?? 0)),
      normal: [...normal],
    });
  }, [lattice, nodeId, revision, selectedFaces, unit]);

  useEffect(() => () => {
    if (useStore.getState().cutSpot?.nodeId === nodeId) useStore.getState().setCutSpot(null);
  }, [nodeId]);

  // A number typed into the panel lands here, the same way the orient request
  // below does: the editor owns the live cage while it is open, so the panel
  // asks rather than writing. The geometry itself is in latticeCommands, which
  // is where the pointerless side of every other tool lives.
  const resizeRequest = useStore((state) => state.latticeResizeRequest);
  const resizeSeen = useRef(resizeRequest?.nonce ?? 0);
  useEffect(() => {
    if (!resizeRequest || resizeRequest.nonce === resizeSeen.current) return;
    resizeSeen.current = resizeRequest.nonce;
    mutate(() => dimensionMm(lattice, selectionCorners, resizeRequest.axis, resizeRequest.mode, resizeRequest.mm));
  }, [lattice, mutate, resizeRequest, selectionCorners]);

  // The panel's repair button, and the N key below, land here.
  const orientRequest = useStore((state) => state.latticeOrientRequest);
  const orientSeen = useRef(orientRequest);
  useEffect(() => {
    if (orientRequest === orientSeen.current) return;
    orientSeen.current = orientRequest;
    mutate(() => { orientFaces(lattice); });
  }, [lattice, mutate, orientRequest]);

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
   * A box round the field rather than a quad on the work plane, so the pointer
   * still resolves when the plane is edge-on to the camera — and drawn BACK
   * side only, which puts its surface behind everything in the model. A
   * front-facing wall would sit between the camera and the cage and swallow
   * every click meant for a face.
   *
   * Metres across, not grid steps: the field follows the pointer, and it can
   * only follow where the pointer is still being heard. Sized to the field,
   * one quick flick of the mouse at a fine grid put the pointer outside the
   * box, the field stopped following, and there was no way back short of
   * finding the dots again. Nothing about it is visible, so nothing is lost by
   * making it big enough that the pointer is never outside it.
   */
  const catcher = useMemo(() => {
    const { ranges } = field;
    const position = ranges.map((r) => ((r.hi + r.lo) / 2) * unit) as unknown as [number, number, number];
    return { size: [20, 20, 20] as [number, number, number], position };
  }, [field, unit]);

  const pendingLine = useMemo(() => {
    const points = [...pending];
    if (hover && pending.length > 0 && !stroke) points.push(hover);
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
  }, [hover, pending, stroke, unit]);

  /**
   * The ring the shape tool is about to place, drawn as it is sized.
   *
   * Closed, unlike the polygon preview: a circle has no half-drawn state to
   * show — the centre is down and the radius follows the pointer — so the
   * preview is the finished shape all the way through.
   */
  const shapeLine = useMemo(() => {
    const ring = ringFor(hover);
    const positions: number[] = [];
    if (ring) {
      for (let n = 0; n < ring.length; n++) {
        for (const [i, j, k] of [ring[n], ring[(n + 1) % ring.length]]) positions.push(i * unit, j * unit, k * unit);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }, [hover, ringFor, unit]);

  /**
   * The curve being placed, drawn smooth with its handles, so the bend can be
   * seen before the grid gets hold of it. Handles not yet clicked are wherever
   * the pointer is — the second stands on the first until the first is down,
   * which makes the early preview a symmetric bow.
   */
  const curvePreview = useMemo(() => {
    const positions: number[] = [];
    const handles: number[] = [];
    if (stroke && pending.length > 0) {
      const from = pending[pending.length - 1];
      const c1 = stroke.control ?? hover ?? stroke.end;
      const c2 = hover ?? c1;
      const to = stroke.end;
      const [u, v] = OTHER_AXES[plane.axis];
      const a = AXIS_INDEX[plane.axis];
      const at = (t: number): LatticeCoord => {
        const s = 1 - t;
        const w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
        const out: LatticeCoord = [0, 0, 0];
        out[a] = from[a];
        out[u] = w[0] * from[u] + w[1] * c1[u] + w[2] * c2[u] + w[3] * to[u];
        out[v] = w[0] * from[v] + w[1] * c1[v] + w[2] * c2[v] + w[3] * to[v];
        return out;
      };
      const push = (into: number[], c: LatticeCoord) => into.push(c[0] * unit, c[1] * unit, c[2] * unit);
      let previous = at(0);
      for (let i = 1; i <= 48; i++) {
        const next = at(i / 48);
        push(positions, previous);
        push(positions, next);
        previous = next;
      }
      push(handles, from); push(handles, c1);
      push(handles, to); push(handles, c2);
    }
    const line = new THREE.BufferGeometry();
    line.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const arms = new THREE.BufferGeometry();
    arms.setAttribute('position', new THREE.Float32BufferAttribute(handles, 3));
    return { line, arms };
  }, [hover, pending, plane.axis, stroke, unit]);

  const faceGeometry = useCallback((faces: number[]) => {
    const positions: number[] = [];
    for (const face of faces) {
      const verts = lattice.faces[face];
      if (!verts) continue;
      const tris = triangulate([verts], lattice.coords);
      for (let t = 0; t + 2 < tris.length; t += 3) {
        for (const v of [tris[t], tris[t + 1], tris[t + 2]]) positions.push(...position(v));
      }
    }
    if (positions.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return geometry;
  }, [lattice, position]);

  // `revision` looks redundant to the linter and is not: `faceGeometry` reads
  // the live cage, which is mutated in place, so the revision counter is the
  // only thing that says its contents have changed.
  /* eslint-disable react-hooks/exhaustive-deps */
  const highlight = useMemo(() => faceGeometry(selectedFaces), [faceGeometry, revision, selectedFaces]);
  const hoverFaceGeometry = useMemo(
    () => (hoveredFace === null || selectedFaces.includes(hoveredFace) ? null : faceGeometry([hoveredFace])),
    [faceGeometry, hoveredFace, revision, selectedFaces],
  );
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <group ref={groupRef} name={`${nodeId}_lattice`}>
      {/* The shape itself, drawn front faces only — as every other renderer in
          the app draws it. Double-sided was a kindness that cost more than it
          gave: an inside-out face looked perfectly solid here and vanished the
          moment the tools were closed. */}
      <mesh name={geomName} geometry={solid.geometry} castShadow receiveShadow raycast={() => null}>
        <meshStandardMaterial color={rgb} roughness={0.6} metalness={0.05} side={THREE.FrontSide} wireframe={wireframe} />
      </mesh>

      {/* And the backs of those faces, in a colour nobody would choose for a
          part. Looking into an open shell you are genuinely seeing the inside of
          it, so this is honest rather than alarming; a face that reads red from
          OUTSIDE is one that will be a hole in the export. */}
      <mesh geometry={solid.geometry} raycast={() => null}>
        <meshStandardMaterial color="#e11d48" roughness={0.9} metalness={0} side={THREE.BackSide} wireframe={wireframe} />
      </mesh>

      <group ref={cageRef} position={[-solid.origin[0], -solid.origin[1], -solid.origin[2]]}>
      {/* The cage over it: the thing actually being edited. */}
      <lineSegments geometry={wire.soft} raycast={() => null}>
        <lineBasicMaterial color="#0f172a" transparent opacity={0.5} depthTest={false} />
      </lineSegments>
      {/* Wires: outlines drawn and not yet closed into a face. */}
      <lineSegments geometry={wire.open} raycast={() => null}>
        <lineBasicMaterial color="#84cc16" depthTest={false} />
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
      <mesh
        geometry={pick.geometry}
        onPointerDown={onFaceDown}
        onPointerMove={onFaceMove}
        onPointerOut={() => setHoveredFace(null)}
      >
        <meshBasicMaterial colorWrite={false} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>

      {/* What an extrude is about to take hold of. Shown before the drag,
          because the face a drag starts on is decided by where the pointer is
          when the button goes down and there is no undoing a look. */}
      {hoverFaceGeometry && (
        <mesh geometry={hoverFaceGeometry} raycast={() => null}>
          <meshBasicMaterial color="#f59e0b" transparent opacity={0.3} side={THREE.DoubleSide} depthTest={false} />
        </mesh>
      )}

      {selectedFaces.length > 0 && highlight && (
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
        <sphereGeometry args={[pixels(2.5), 8, 6]} />
        {/* White, so the per-instance colours above come through unmixed. */}
        <meshBasicMaterial color="#ffffff" depthTest={false} />
      </instancedMesh>

      {/* The grid, as a volume: the whole cube is drawn and the whole cube is
          clickable, with the slice under the pointer picked out of it. */}
      <points geometry={volume.geometry} raycast={() => null}>
        <pointsMaterial
          ref={volumeMaterial}
          map={dotTexture} color="#94a3b8" size={0.0005} sizeAttenuation
          transparent opacity={0.22} depthWrite={false}
        />
      </points>
      <points geometry={slice.geometry} raycast={() => null}>
        {/* Lit blue while it is being held, so the lock is visible on the thing
            it locks rather than only in the panel. */}
        <pointsMaterial
          ref={sliceMaterial}
          map={dotTexture} color={locked ? '#0284c7' : '#475569'}
          size={0.0008} sizeAttenuation
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
          <sphereGeometry args={[wouldClose || hoverVertex !== -1 ? pixels(5) : pixels(3), 12, 8]} />
          <meshBasicMaterial
            color={wouldClose ? '#10b981' : hoverVertex !== -1 ? '#f59e0b' : '#38bdf8'}
            depthTest={false}
          />
        </mesh>
      )}

      {shape && (
        <lineSegments geometry={shapeLine} raycast={() => null}>
          <lineBasicMaterial color="#0ea5e9" depthTest={false} transparent opacity={0.9} />
        </lineSegments>
      )}
      {stroke && (
        <>
          <lineSegments geometry={curvePreview.line} raycast={() => null}>
            <lineBasicMaterial color="#0ea5e9" depthTest={false} transparent opacity={0.9} />
          </lineSegments>
          <lineSegments geometry={curvePreview.arms} raycast={() => null}>
            <lineBasicMaterial color="#f59e0b" depthTest={false} transparent opacity={0.5} />
          </lineSegments>
          <mesh position={[stroke.end[0] * unit, stroke.end[1] * unit, stroke.end[2] * unit]} raycast={() => null}>
            <sphereGeometry args={[pixels(3), 12, 8]} />
            <meshBasicMaterial color="#0ea5e9" depthTest={false} />
          </mesh>
        </>
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
