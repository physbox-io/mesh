// ---------------------------------------------------------------------------
// A pipe frame from a shape: a sketch or a solid, made into a skeleton that
// stands up, then into pipes and fittings
// ---------------------------------------------------------------------------
//
// The Pipes dialog plans a frame from struts laid out end to end. This builds
// those struts from what the user already makes:
//
// - A lattice's lines: its wires (open strokes) and its faces' edges. The lines
//   are where the pipes go.
// - Any other solid: its surface, brought to flat faces (the sheet unfold's
//   coplanar grouping), and when that leaves more faces than the span needs, a
//   simplified surface about a span per triangle, so a sphere becomes a dome.
//
// Then the frame is made to hold itself up, by one measure: no pipe runs
// further than `maxSpanMm` between joints that hold it.
//
// - A face wider than the span gets members across it: rails along it on a
//   wall (horizontal), along its longest edge on a roof; and where those run
//   longer than the span, a second set crossing them.
// - A joint off the floor with nothing going down from it gets a post to the
//   floor; a level member still longer than the span gets posts along it; and
//   feet under the same member are joined by a base rail.
// - Diagonals, when asked: one across every four-sided panel.
//
// Millimetres, Z up, world, throughout.

import * as THREE from 'three';
import { SimplifyModifier } from 'three/examples/jsm/modifiers/SimplifyModifier.js';
import type { SceneGraph, SceneNode } from '../types/scene';
import { collectSceneTriangles } from './contourSliceExporter';
import { getNodeWorldTransform } from './laserCutExporter';
import { clusterTrianglesToPolyFaces } from './sheetUnfoldExporter';
import { PIPE_STANDARDS, makeStrutNode, pipeFittings, type PipeStandardId, type PipeStandardSpec } from './tubeAndWireExporter';

type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => scale(a, 1 / (len(a) || 1));

export type MemberKind = 'edge' | 'line' | 'rail' | 'post' | 'base' | 'brace';

export interface Skeleton {
  nodes: V3[];
  members: { a: number; b: number; kind: MemberKind }[];
}

export interface SkeletonOptions {
  /** Longest a pipe may run between joints that hold it, mm. Default: the pipe's own (`defaultMaxSpanMm`). */
  maxSpanMm?: number;
  /** A diagonal across every four-sided panel. Default false. */
  diagonals?: boolean;
  /** Posts to the floor under joints with nothing holding them up. Default true. */
  posts?: boolean;
  /** Where the floor is, mm. Default 0. */
  floorMm?: number;
  pipeStandardId?: PipeStandardId;
}

/**
 * How far a pipe spans between supports: where it sags L/140 full of water,
 * simply supported, which is what PVC makers' support-spacing tables come to
 * (3/4" Schedule 40, 5 ft). From each pipe's own stiffness and weight.
 */
export function defaultMaxSpanMm(spec: PipeStandardSpec): number {
  const [E, rho] = { emt: [200_000, 7.85e-6], aluminium: [69_000, 2.7e-6], pvc: [2_800, 1.4e-6] }[spec.material]; // N/mm², kg/mm³
  const ro = spec.odMm / 2, ri = spec.idMm / 2;
  const I = (Math.PI / 4) * (ro ** 4 - ri ** 4);
  const w = (Math.PI * (ro * ro - ri * ri) * rho + Math.PI * ri * ri * 1e-6) * 9.81; // N/mm
  const L = Math.cbrt((384 * E * I) / (5 * w * 140));
  return Math.round(Math.min(L, spec.stockLengthMm) / 10) * 10;
}

/** Nodes welded within `weldMm`, members kept once. */
class Graph {
  nodes: V3[] = [];
  members: Skeleton['members'] = [];
  private keys = new Set<string>();
  constructor(private weldMm: number) {}
  node(p: V3): number {
    for (let i = 0; i < this.nodes.length; i++) if (len(sub(this.nodes[i], p)) <= this.weldMm) return i;
    this.nodes.push(p);
    return this.nodes.length - 1;
  }
  link(a: number, b: number, kind: MemberKind) {
    if (a === b) return;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.members.push({ a, b, kind });
  }
  reset() {
    const old = this.members;
    this.members = [];
    this.keys.clear();
    return old;
  }
}

/** The body's chain from the top of the scene, so its world transform comes out right. */
function pathTo(nodes: SceneNode[], id: string): SceneNode[] | null {
  for (const n of nodes) {
    if (n.id === id) return [n];
    const below = pathTo(n.children || [], id);
    if (below) return [n, ...below];
  }
  return null;
}

function worldMatrix(path: SceneNode[]): THREE.Matrix4 {
  let m: THREE.Matrix4 | undefined;
  for (const n of path) m = getNodeWorldTransform(n, m);
  return m ?? new THREE.Matrix4();
}

/** Ramer-Douglas-Peucker on a polyline, mm. */
function simplifyLine(pts: V3[], tolMm: number): V3[] {
  if (pts.length <= 2) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  const ab = sub(b, a);
  const L = len(ab);
  let worst = -1, at = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const ap = sub(pts[i], a);
    const d = L < 1e-9 ? len(ap) : len(cross(ap, ab)) / L;
    if (d > worst) { worst = d; at = i; }
  }
  if (worst <= tolMm) return [a, b];
  return [...simplifyLine(pts.slice(0, at + 1), tolMm).slice(0, -1), ...simplifyLine(pts.slice(at), tolMm)];
}

interface Face { loop: number[]; normal: V3 }

/** A lattice's own faces and wires, through its body's transform. */
function fromLattice(g: Graph, node: SceneNode, m: THREE.Matrix4, curveTolMm: number): Face[] {
  const cage = node.latticeCage!;
  const unit = cage.unit || 0.0001;
  const origin = node.latticeOrigin || [0, 0, 0];
  const world: V3[] = [];
  for (let i = 0; i + 2 < cage.coords.length; i += 3) {
    const v = new THREE.Vector3(cage.coords[i] * unit - origin[0], cage.coords[i + 1] * unit - origin[1], cage.coords[i + 2] * unit - origin[2]).applyMatrix4(m);
    world.push([v.x * 1000, v.y * 1000, v.z * 1000]);
  }
  const faces: Face[] = [];
  let at = 0;
  for (const size of cage.faceSizes) {
    const ring = cage.faces.slice(at, at + size).map((i) => world[i]);
    at += size;
    if (ring.length < 3) continue;
    const ids = ring.map((p) => g.node(p));
    ids.forEach((id, k) => g.link(id, ids[(k + 1) % ids.length], 'edge'));
    faces.push({ loop: ids, normal: newell(ring) });
  }
  at = 0;
  for (const size of cage.wireSizes ?? []) {
    // Curves are sampled finely; pipes are straight, so keep only the corners that matter.
    const line = simplifyLine((cage.wires ?? []).slice(at, at + size).map((i) => world[i]), curveTolMm);
    at += size;
    const ids = line.map((p) => g.node(p));
    for (let k = 0; k + 1 < ids.length; k++) g.link(ids[k], ids[k + 1], 'line');
  }
  return faces;
}

function newell(pts: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm(n);
}

/** A solid's surface as flat faces, simplified when it is curved finer than the span needs. */
function fromSolid(g: Graph, path: SceneNode[], spanMm: number): Face[] {
  // The body alone, under its parents' transforms, and without what is cut
  // out of it: a frame goes round a window, not along its edge. A body with a
  // cut also carries the finished mesh with the hole in it (`csgDerived`);
  // its parts, not that, are what is framed.
  const solidOnly = (n: SceneNode): SceneNode => ({
    ...n,
    geoms: (n.geoms ?? []).filter((g) => g.csg !== 'difference' && !g.csgDerived && g.role !== 'collision'),
    children: (n.children ?? []).map(solidOnly),
  });
  let wrapped: SceneNode = solidOnly(path[path.length - 1]);
  for (let i = path.length - 2; i >= 0; i--) wrapped = { ...path[i], geoms: [], children: [wrapped] };
  const tris = collectSceneTriangles({ nodes: [wrapped] } as SceneGraph).tris;
  if (tris.length < 9) return [];

  const weld = (soup: ArrayLike<number>) => {
    const map = new Map<string, number>();
    const verts: THREE.Vector3[] = [];
    const idx: number[] = [];
    for (let i = 0; i + 2 < soup.length; i += 3) {
      const key = `${Math.round(soup[i] * 2e3)},${Math.round(soup[i + 1] * 2e3)},${Math.round(soup[i + 2] * 2e3)}`;
      let k = map.get(key);
      if (k === undefined) { k = verts.length; map.set(key, k); verts.push(new THREE.Vector3(soup[i], soup[i + 1], soup[i + 2])); }
      idx.push(k);
    }
    return { verts, idx };
  };
  let { verts, idx } = weld(tris);
  let faces = clusterTrianglesToPolyFaces(verts, idx, 3);

  // Curved, or made of flat faces? A tessellated curve's neighbouring faces
  // meet at a few degrees; a box's, a roof's, a birdhouse's at thirty or more.
  // Counting faces instead took any model of many flat parts for a curve and
  // simplified a birdhouse down to four corners.
  const edgeFaces = new Map<string, number[]>();
  faces.forEach((f, k) => f.verts.forEach((v, i) => {
    const w = f.verts[(i + 1) % f.verts.length];
    const key = v < w ? `${v}:${w}` : `${w}:${v}`;
    edgeFaces.set(key, [...(edgeFaces.get(key) ?? []), k]);
  }));
  // By area, so a small round hole's many facets cannot make a house curved.
  const total = faces.reduce((sum, f) => sum + f.areaM2, 0);
  const onCurve = new Set<number>();
  for (const ks of edgeFaces.values()) {
    if (ks.length !== 2) continue;
    if (faces[ks[0]].normal.angleTo(faces[ks[1]].normal) < (20 * Math.PI) / 180) ks.forEach((k) => onCurve.add(k));
  }
  const curvedArea = [...onCurve].reduce((sum, k) => sum + faces[k].areaM2, 0);
  if (total > 0 && curvedArea / total > 0.3) {
    // About one triangle per (edge² · √3/4) of surface, the edge under two
    // thirds of the span so an uneven facet needs nothing across it, and no
    // more than a quarter of the shape so a small one keeps its form.
    const box = new THREE.Box3().setFromPoints(verts);
    const sizeMm = box.getSize(new THREE.Vector3()).multiplyScalar(1000);
    const across = [sizeMm.x, sizeMm.y, sizeMm.z].sort((a, b) => b - a)[1];
    const areaMm2 = faces.reduce((sum, f) => sum + f.areaM2 * 1e6, 0);
    const edgeMm = Math.min(spanMm * 0.65, across / 4);
    const wanted = Math.max(8, Math.ceil(areaMm2 / (0.433 * edgeMm * edgeMm)));
    if (verts.length > wanted) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts.flatMap((v) => [v.x, v.y, v.z])), 3));
      geo.setIndex(idx);
      const keep = Math.max(6, Math.round(wanted / 2) + 2);
      const simplified = new SimplifyModifier().modify(geo, Math.max(0, verts.length - keep));
      const pos = simplified.attributes.position.array as ArrayLike<number>;
      const index = simplified.index ? Array.from(simplified.index.array as ArrayLike<number>) : Array.from({ length: pos.length / 3 }, (_, i) => i);
      const soup: number[] = [];
      for (const i of index) soup.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      ({ verts, idx } = weld(soup));
      faces = clusterTrianglesToPolyFaces(verts, idx, 3);
    }
  }

  const out: Face[] = [];
  for (const f of faces) {
    const ring: V3[] = f.verts.map((i) => [verts[i].x * 1000, verts[i].y * 1000, verts[i].z * 1000]);
    const ids = ring.map((p) => g.node(p));
    ids.forEach((id, k) => g.link(id, ids[(k + 1) % ids.length], 'edge'));
    out.push({ loop: ids, normal: [f.normal.x, f.normal.y, f.normal.z] });
  }
  return out;
}

/**
 * Members across a face wider than the span: a set along `d`, spaced across
 * it no wider than the span, and where those are themselves longer than the
 * span, a second set crossing them.
 */
function fillFace(g: Graph, face: Face, spanMm: number, floorMm: number) {
  const ring = face.loop.map((i) => g.nodes[i]);
  const n = face.normal;
  // On the floor: nothing to hold up.
  if (n[2] < -0.9 && ring.every((p) => Math.abs(p[2] - floorMm) < 1)) return;
  let d: V3;
  if (Math.abs(n[2]) < 0.7) {
    d = norm(cross(n, [0, 0, 1])); // a wall: rails run level
  } else {
    let best = 0;
    d = [1, 0, 0];
    ring.forEach((p, i) => {
      const e = sub(ring[(i + 1) % ring.length], p);
      if (len(e) > best) { best = len(e); d = norm(e); }
    });
  }
  const e = norm(cross(n, d));
  const o = ring[0];
  const st = ring.map((p) => [dot(sub(p, o), d), dot(sub(p, o), e)] as [number, number]);
  const at = (s: number, t: number): V3 => add(o, add(scale(d, s), scale(e, t)));

  /** Where the line `t = c` (or `s = c`) crosses the outline, in pairs inside it. */
  const spans = (c: number, alongS: boolean): [number, number][] => {
    const hits: number[] = [];
    for (let i = 0; i < st.length; i++) {
      const p = st[i], q = st[(i + 1) % st.length];
      const [pc, qc, pv, qv] = alongS ? [p[1], q[1], p[0], q[0]] : [p[0], q[0], p[1], q[1]];
      if ((pc <= c && qc > c) || (qc <= c && pc > c)) hits.push(pv + ((c - pc) / (qc - pc)) * (qv - pv));
    }
    hits.sort((x, y) => x - y);
    const out: [number, number][] = [];
    for (let k = 0; k + 1 < hits.length; k += 2) out.push([hits[k], hits[k + 1]]);
    return out;
  };
  const [s0, s1] = [Math.min(...st.map((p) => p[0])), Math.max(...st.map((p) => p[0]))];
  const [t0, t1] = [Math.min(...st.map((p) => p[1])), Math.max(...st.map((p) => p[1]))];
  const levels = (lo: number, hi: number) => {
    const k = Math.ceil((hi - lo) / spanMm - 1e-6);
    return Array.from({ length: Math.max(0, k - 1) }, (_, i) => lo + ((hi - lo) * (i + 1)) / k);
  };
  const rails = levels(t0, t1);
  const studs = levels(s0, s1);
  for (const t of rails) for (const [a, b] of spans(t, true)) g.link(g.node(at(a, t)), g.node(at(b, t)), 'rail');
  for (const s of studs) for (const [a, b] of spans(s, false)) g.link(g.node(at(s, a)), g.node(at(s, b)), 'rail');
  // Where the two sets cross, a joint.
  for (const t of rails) for (const s of studs) {
    if (spans(t, true).some(([a, b]) => s > a && s < b)) g.node(at(s, t));
  }
}

/** Every member cut at the joints that lie along it. */
function splitAtJoints(g: Graph, tolMm: number) {
  const old = g.reset();
  for (const m of old) {
    const a = g.nodes[m.a], b = g.nodes[m.b];
    const ab = sub(b, a);
    const L = len(ab);
    const on: { t: number; i: number }[] = [];
    g.nodes.forEach((p, i) => {
      if (i === m.a || i === m.b) return;
      const t = dot(sub(p, a), ab) / (L * L);
      if (t <= 1e-6 || t >= 1 - 1e-6) return;
      if (len(sub(p, add(a, scale(ab, t)))) <= tolMm) on.push({ t, i });
    });
    on.sort((x, y) => x.t - y.t);
    const chain = [m.a, ...on.map((x) => x.i), m.b];
    for (let k = 0; k + 1 < chain.length; k++) g.link(chain[k], chain[k + 1], m.kind);
  }
}

const slopeOf = (p: V3, q: V3) => {
  const d = sub(q, p);
  return Math.abs(d[2]) / (len(d) || 1);
};

/** Posts to the floor where nothing holds a joint up, along long level members too, and base rails between their feet. */
function addPosts(g: Graph, spanMm: number, floorMm: number) {
  const steep = Math.sin((30 * Math.PI) / 180);
  // Level members still longer than the span are cut into equal lengths first.
  for (const m of g.reset()) {
    const a = g.nodes[m.a], b = g.nodes[m.b];
    const L = len(sub(b, a));
    if (slopeOf(a, b) >= steep || L <= spanMm || Math.min(a[2], b[2]) <= floorMm + 1) {
      g.link(m.a, m.b, m.kind);
      continue;
    }
    const k = Math.ceil(L / spanMm - 1e-6);
    let prev = m.a;
    for (let i = 1; i <= k; i++) {
      const next = i === k ? m.b : g.node(add(a, scale(sub(b, a), i / k)));
      g.link(prev, next, m.kind);
      prev = next;
    }
  }
  // Held outright: on the floor, or a steep member going down from it.
  const outright = (i: number) => {
    const p = g.nodes[i];
    if (p[2] <= floorMm + 1) return true;
    return g.members.some((m) => {
      const other = m.a === i ? m.b : m.b === i ? m.a : -1;
      return other >= 0 && g.nodes[other][2] < p[2] - 1 && slopeOf(p, g.nodes[other]) >= steep;
    });
  };
  // And within a short reach of that along members: an eave overhanging its
  // wall is a cantilever a pipe carries, not a joint wanting a post.
  const reach = spanMm / 4;
  const dist = g.nodes.map((_, i) => (outright(i) ? 0 : Infinity));
  for (let changed = true; changed;) {
    changed = false;
    for (const m of g.members) {
      const L = len(sub(g.nodes[m.a], g.nodes[m.b]));
      if (dist[m.a] + L < dist[m.b]) { dist[m.b] = dist[m.a] + L; changed = true; }
      if (dist[m.b] + L < dist[m.a]) { dist[m.a] = dist[m.b] + L; changed = true; }
    }
  }
  const feet = new Map<number, number>();
  const count = g.nodes.length;
  for (let i = 0; i < count; i++) {
    if (dist[i] <= reach) continue;
    const p = g.nodes[i];
    const foot = g.node([p[0], p[1], floorMm]);
    g.link(i, foot, 'post');
    feet.set(i, foot);
  }
  // Feet under the same level member are tied together.
  for (const m of [...g.members]) {
    const fa = feet.get(m.a), fb = feet.get(m.b);
    if (fa !== undefined && fb !== undefined) g.link(fa, fb, 'base');
  }
}

/** One diagonal across every flat four-sided panel. */
function addDiagonals(g: Graph) {
  const nbr = new Map<number, Set<number>>();
  for (const m of g.members) {
    if (!nbr.has(m.a)) nbr.set(m.a, new Set());
    if (!nbr.has(m.b)) nbr.set(m.b, new Set());
    nbr.get(m.a)!.add(m.b);
    nbr.get(m.b)!.add(m.a);
  }
  const done = new Set<string>();
  for (const [a, na] of nbr) {
    for (const b of na) {
      for (const c of nbr.get(b) ?? []) {
        if (c === a || na.has(c)) continue;
        for (const d of nbr.get(c) ?? []) {
          if (d === b || d === a || !na.has(d) || nbr.get(b)!.has(d)) continue;
          const key = [a, b, c, d].sort((x, y) => x - y).join(':');
          if (done.has(key)) continue;
          done.add(key);
          const [pa, pb, pc, pd] = [a, b, c, d].map((i) => g.nodes[i]);
          // Flat: the fourth corner on the plane of the other three.
          const n = norm(cross(sub(pb, pa), sub(pd, pa)));
          if (Math.abs(dot(sub(pc, pa), n)) > 5) continue;
          // The shorter way across.
          if (len(sub(pc, pa)) <= len(sub(pd, pb))) g.link(a, c, 'brace');
          else g.link(b, d, 'brace');
        }
      }
    }
  }
}

export interface BuiltSkeleton extends Skeleton {
  maxSpanMm: number;
  source: 'sketch' | 'solid';
  /** The pipe it was framed in: the one asked for, or a smaller one when that was too big for the shape. */
  pipeStandardId: PipeStandardId;
  /** Set when the pipe asked for was too big and another was used: which. */
  resizedFrom?: PipeStandardId;
}

/** The skeleton of a body in the scene, supported. */
export function buildPipeSkeleton(scene: SceneGraph, bodyId: string, opts: SkeletonOptions = {}): BuiltSkeleton {
  const path = pathTo(scene.nodes, bodyId);
  if (!path) throw new Error(`No body '${bodyId}'.`);
  const body = path[path.length - 1];
  const asked = PIPE_STANDARDS[opts.pipeStandardId ?? 'pvc_sch40_3_4'] ?? PIPE_STANDARDS.pvc_sch40_3_4;
  const sketch = !!body.latticeCage && (body.latticeCage.coords.length ?? 0) >= 3;

  // Sized before any joints are merged, from the shape itself.
  const sizeOf = (pts: V3[]) => [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])) - Math.min(...pts.map((p) => p[a])));
  const loose = new Graph(0);
  if (sketch) fromLattice(loose, body, worldMatrix(path), 0);
  else fromSolid(loose, path, opts.maxSpanMm && opts.maxSpanMm > 0 ? opts.maxSpanMm : defaultMaxSpanMm(asked));
  if (!loose.members.length) throw new Error(`${body.name} has no lines or faces to frame.`);
  // A pipe between two fittings is about three diameters at the least, and a
  // frame needs two of them across, so a shape under six diameters across
  // collapses into its joints. Then the largest tube that suits it is used:
  // eight diameters across where one does, six where not.
  const across = sizeOf(loose.nodes).sort((a, b) => b - a)[1];
  let spec = asked;
  if (across < asked.odMm * 6) {
    const smaller = Object.values(PIPE_STANDARDS).filter((s) => s.odMm < asked.odMm).sort((a, b) => b.odMm - a.odMm);
    const pick = smaller.find((s) => s.odMm * 8 <= across) ?? smaller.find((s) => s.odMm * 6 <= across);
    if (!pick) throw new Error(`${body.name} is ${Math.round(across)} mm across, smaller than any tube here frames.`);
    spec = pick;
  }
  const span = opts.maxSpanMm && opts.maxSpanMm > 0 && spec === asked ? opts.maxSpanMm : defaultMaxSpanMm(spec);
  const floor = opts.floorMm ?? 0;
  // Joints closer than about a fitting's reach are one joint.
  const weld = Math.max(spec.odMm, spec.odMm * 1.5);
  const g = new Graph(weld);

  const faces = sketch ? fromLattice(g, body, worldMatrix(path), Math.max(5, spec.odMm / 2)) : fromSolid(g, path, span);

  for (const f of faces) fillFace(g, f, span, floor);
  splitAtJoints(g, weld / 2);
  if (opts.posts !== false) addPosts(g, span, floor);
  splitAtJoints(g, weld / 2);
  if (opts.diagonals) addDiagonals(g);

  return {
    nodes: g.nodes, members: g.members, maxSpanMm: span, source: sketch ? 'sketch' : 'solid',
    pipeStandardId: spec.id, ...(spec !== asked ? { resizedFrom: asked.id } : {}),
  };
}

const KIND_NAMES: Record<MemberKind, string> = {
  edge: 'Edge', line: 'Pipe', rail: 'Rail', post: 'Post', base: 'Base Rail', brace: 'Diagonal',
};

/**
 * The skeleton as struts and their fittings, ready for the scene: what the
 * cut list, the hubs and Add Simulation all read. `shift` moves it, mm.
 */
export function skeletonToNodes(sk: Skeleton, pipeStandardId: PipeStandardId, idPrefix: string, shift: V3 = [0, 0, 0]): SceneNode[] {
  const spec = PIPE_STANDARDS[pipeStandardId] ?? PIPE_STANDARDS.pvc_sch40_3_4;
  const rgba: [number, number, number, number] = spec.material === 'pvc' ? [0.94, 0.95, 0.97, 1] : [0.7, 0.74, 0.78, 1];
  const count: Partial<Record<MemberKind, number>> = {};
  const struts = sk.members.map((m, i) => {
    count[m.kind] = (count[m.kind] ?? 0) + 1;
    return makeStrutNode(`${idPrefix}_pipe_${i + 1}`, `${KIND_NAMES[m.kind]} ${count[m.kind]}`,
      add(sk.nodes[m.a], shift), add(sk.nodes[m.b], shift), spec.odMm / 2, rgba);
  });
  return [...struts, ...pipeFittings(struts, { pipeStandardId }, idPrefix)];
}

export type FramePlacement = 'replace' | 'beside';

/**
 * The scene with `bodyId` framed: the frame in its place (the body taken
 * out), or beside it along +X. Shared by the Pipes dialog and the bridge.
 */
export function frameBodyInScene(
  scene: SceneGraph,
  bodyId: string,
  opts: SkeletonOptions & { placement?: FramePlacement } = {}
): { nodes: SceneNode[]; skeleton: BuiltSkeleton; added: number } {
  const sk = buildPipeSkeleton(scene, bodyId, opts);
  const xs = sk.nodes.map((p) => p[0]);
  const shift: V3 = opts.placement === 'beside' ? [Math.max(...xs) - Math.min(...xs) + 300, 0, 0] : [0, 0, 0];
  const prefix = `frame_${Math.random().toString(36).slice(2, 7)}`;
  const frame = skeletonToNodes(sk, sk.pipeStandardId, prefix, shift);
  const without = (list: SceneNode[]): SceneNode[] =>
    list.filter((n) => n.id !== bodyId).map((n) => (n.children?.length ? { ...n, children: without(n.children) } : n));
  const kept = opts.placement === 'beside' ? scene.nodes : without(scene.nodes);
  return { nodes: [...kept, ...frame], skeleton: sk, added: frame.length };
}
