/**
 * A cloth body as the cloth solver takes it (xpbd.ts): particles where the
 * cloth starts, with the fabric's mass; the lengths it rests at, measured on
 * the flat cloth it was cut from; and what joins it (stitches) and holds it
 * (ties). From either of the two ways cloth is made:
 *
 *  - a garment modelled in 3D (cloth.garment): its shell's points are the
 *    particles, so its seams are points the panels share and it is sewn from
 *    the start; rest lengths and the flat it bends back to come from its
 *    flattened pieces.
 *  - pattern pieces (cloth.pieces): placed where they start, sewn by stitches
 *    that close over the sew time, tied to bodies (a sail to its posts).
 *
 * Positions in the world frame (the node's transform applied), Z-up, metres.
 */

import * as THREE from 'three';
import type { ClothMaterial, ClothMaterialName, GarmentTrim } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { clothMaterial, DEFAULT_SEW_TIME, meshCloth } from './clothMesh';
import { garmentShell } from './garmentShell';
import { flattenPanel } from './garmentFlatten';
import { GARMENT_DEFAULTS } from './garments';

/** A piece as it is cut: its points flat, metres, v up the body; its outline in order round it; how much it had to stretch to lie flat; its trims, by point. */
export interface FlatPattern {
  uv: [number, number][];
  outline: number[];
  strain95: number;
  marks?: ClothTrim[];
}

/** A stud, button, bead or zipper tooth riding on one of a group's points (its local index), `size` across. */
export interface ClothTrim {
  kind: GarmentTrim['kind'];
  particle: number;
  size: number;
  rgba: number[];
}

const TRIM_DEFAULTS: Record<GarmentTrim['kind'], { size: number; spacing: number; rgba: number[] }> = {
  stud: { size: 0.008, spacing: 0.02, rgba: [0.82, 0.82, 0.85, 1] },
  button: { size: 0.012, spacing: 0.08, rgba: [0.12, 0.1, 0.08, 1] },
  bead: { size: 0.006, spacing: 0.009, rgba: [0.9, 0.84, 0.45, 1] },
  zipper: { size: 0.004, spacing: 0.005, rgba: [0.8, 0.8, 0.84, 1] },
};

/**
 * Where a garment's trims sit: the lines named (`cuff` takes both cuffs)
 * chained into runs, and along each a point every `spacing`, at the run's
 * own point nearest it (a zipper's teeth at every point). Shell point
 * indices, with the trim they carry.
 */
function trimPoints(points: number[][], lines: { name: string; path: number[] }[], trims: GarmentTrim[]): { trim: GarmentTrim; point: number }[] {
  const out: { trim: GarmentTrim; point: number }[] = [];
  for (const trim of trims) {
    const next = new Map<number, number[]>();
    for (const l of lines) {
      if (l.name !== trim.along && !(l.name.length === trim.along.length + 1 && l.name.startsWith(trim.along))) continue;
      const [a, b] = l.path;
      (next.get(a) ?? next.set(a, []).get(a)!).push(b);
      (next.get(b) ?? next.set(b, []).get(b)!).push(a);
    }
    const seen = new Set<number>();
    const starts = [...next.keys()].sort((a, b) => (next.get(a)!.length - next.get(b)!.length));
    for (const start of starts) {
      if (seen.has(start)) continue;
      const run = [start];
      seen.add(start);
      for (let cur = start; ;) {
        const n = (next.get(cur) ?? []).find((q) => !seen.has(q));
        if (n === undefined) break;
        seen.add(n); run.push(n); cur = n;
      }
      if (trim.kind === 'zipper') { for (const i of run) out.push({ trim, point: i }); continue; }
      const spacing = trim.spacing ?? TRIM_DEFAULTS[trim.kind].spacing;
      const at = [0];
      for (let k = 1; k < run.length; k++) { const a = points[run[k - 1]], b = points[run[k]]; at.push(at[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); }
      const total = at[at.length - 1];
      const count = Math.floor(total / spacing);
      const used = new Set<number>();
      for (let j = 0; j < count; j++) {
        const want = (total - (count - 1) * spacing) / 2 + j * spacing;
        let best = 0;
        for (let k = 1; k < run.length; k++) if (Math.abs(at[k] - want) < Math.abs(at[best] - want)) best = k;
        if (!used.has(run[best])) { used.add(run[best]); out.push({ trim, point: run[best] }); }
      }
    }
  }
  return out;
}


/** How far off the form a garment's pieces are laid out, metres. */
const PIECE_STAND_OFF = 0.18;

export interface ClothRenderGroup {
  /** `<body>__<piece>`, as the viewport names a cloth piece. */
  name: string;
  rgba: number[];
  /** The fabric, for how it is drawn. */
  material: ClothMaterialName;
  /** The piece flat, for a garment cut from a modelled shell. */
  flat?: FlatPattern;
  /** Studs, buttons, beads, zipper teeth on its points. */
  trims?: ClothTrim[];
  /** Particle drawn at each of the group's vertices. */
  particles: number[];
  /** Triangles, as indices into `particles`. */
  tris: number[];
}

export interface ClothTieSpec {
  name: string;
  particle: number;
  /** Body it is tied to (its MuJoCo name), or null for the world. */
  body: string | null;
  /** Another cloth (its node's name) it is sewn to instead, at that cloth's nearest point. */
  cloth: string | null;
  /** Where the point goes, in that body's frame; null to hold it where it starts. */
  anchor: number[] | null;
}

export interface ClothModel {
  name: string;
  material: ClothMaterial;
  /** Worn over every cloth of a lower layer (clothLayers). */
  layer: number;
  /** Whether its triangles all face out (a garment modelled round a body), so its outside is known. */
  outward: boolean;
  sewTime: number;
  x0: Float64Array;
  invMass: Float64Array;
  /** Every triangle, by particle, for the wind. */
  tris: number[];
  /** Pairs of particles and the length between them on the flat cloth. */
  edges: number[];
  edgeRest: number[];
  /**
   * Bending, as isometric (quadratic) bending stencils: per interior edge its
   * two ends and the two points opposite, four particles; the four weights
   * that give the curvature there from them; and the two triangles' area.
   * From the flat cloth, so it bends back toward flat.
   */
  bends: number[];
  bendWeights: number[];
  bendArea: number[];
  /** The curvature each stencil rests at: none within a piece; across a seam, as modelled. */
  bendRest: number[];
  /** Pairs of particles two edges apart, and their flat distance: the most they may stretch to. */
  limits: number[];
  limitRest: number[];
  /** Pairs of particles sewn together, closing over the sew time. */
  stitches: number[];
  ties: ClothTieSpec[];
  groups: ClothRenderGroup[];
}

const findNode = (nodes: SceneNode[], name: string): SceneNode | undefined => {
  for (const n of nodes) {
    if ((n.name || n.id) === name) return n;
    const c = n.children ? findNode(n.children, name) : undefined;
    if (c) return c;
  }
  return undefined;
};

const shade = (c: number[], k: number) => [c[0] * k, c[1] * k, c[2] * k, c[3] ?? 1];

/** Pairs of edges into a map keyed by particle pair, averaging lengths seen more than once. */
class EdgeSet {
  private map = new Map<string, { a: number; b: number; sum: number; n: number }>();
  add(a: number, b: number, len: number) {
    if (a === b) return;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const e = this.map.get(key);
    if (e) { e.sum += len; e.n++; } else this.map.set(key, { a, b, sum: len, n: 1 });
  }
  flat(): [number[], number[]] {
    const pairs: number[] = [], rest: number[] = [];
    for (const e of this.map.values()) { pairs.push(e.a, e.b); rest.push(e.sum / e.n); }
    return [pairs, rest];
  }
}

/** Each point to every point two edges from it in the same flat layout, at their flat distance. */
function addLimits(tris: number[], uv: number[][], particleOf: (local: number) => number, out: EdgeSet) {
  const nbr = new Map<number, Set<number>>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)];
    (nbr.get(a) ?? nbr.set(a, new Set()).get(a)!).add(b);
    (nbr.get(b) ?? nbr.set(b, new Set()).get(b)!).add(a);
  }
  const RINGS = 2;
  for (const a of nbr.keys()) {
    const seen = new Set<number>([a]);
    let frontier = [a];
    for (let ring = 1; ring <= RINGS; ring++) {
      const next: number[] = [];
      for (const b of frontier) for (const c of nbr.get(b) ?? []) if (!seen.has(c)) { seen.add(c); next.push(c); }
      if (ring >= 2) for (const c of next) if (c > a) out.add(particleOf(a), particleOf(c), Math.hypot(uv[a][0] - uv[c][0], uv[a][1] - uv[c][1]));
      frontier = next;
    }
  }
}

/** Bending stencils, one per edge two triangles of the same flat layout share. */
class BendSet {
  quads: number[] = []; weights: number[] = []; area: number[] = []; rest: number[] = [];
}
function addBends(tris: number[], uv: number[][], particleOf: (local: number) => number, out: BendSet) {
  const opposite = new Map<string, { a: number; b: number; o: number[] }>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)], o = tris[t + ((e + 2) % 3)];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const entry = opposite.get(key) ?? opposite.set(key, { a, b, o: [] }).get(key)!;
    entry.o.push(o);
  }
  for (const { a, b, o } of opposite.values()) {
    if (o.length !== 2) continue;
    const flat = (i: number) => [uv[i][0], uv[i][1], 0];
    addStencil([particleOf(a), particleOf(b), particleOf(o[0]), particleOf(o[1])], [flat(a), flat(b), flat(o[0]), flat(o[1])], out);
  }
}

/**
 * One stencil, its weights from `rest` (four points, 3D): Bergou et al., "A
 * quadratic bending model for inextensible surfaces". Rests at the
 * curvature `rest` has, which is none if it is flat.
 */
function addStencil(ids: number[], rest: number[][], out: BendSet) {
  const sub = (p: number[], q: number[]) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const crossLen = (u: number[], v: number[]) => Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  const cot = (u: number[], v: number[]) => (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / Math.max(1e-12, crossLen(u, v));
  const [x0, x1, x2, x3] = rest;
  const e0 = sub(x1, x0), e1 = sub(x2, x0), e2 = sub(x3, x0), e3 = sub(x2, x1), e4 = sub(x3, x1), ne0 = [-e0[0], -e0[1], -e0[2]];
  const area = (crossLen(e0, e1) + crossLen(e0, e2)) / 2;
  if (area < 1e-10) return;
  const c01 = cot(e0, e1), c02 = cot(e0, e2), c03 = cot(ne0, e3), c04 = cot(ne0, e4);
  const K = [c03 + c04, c01 + c02, -c01 - c03, -c02 - c04];
  const v = [0, 1, 2].map((k) => K.reduce((sum, w, j) => sum + w * rest[j][k], 0));
  out.quads.push(...ids);
  out.weights.push(...K);
  out.area.push(area);
  out.rest.push(Math.hypot(v[0], v[1], v[2]));
}

/**
 * Stencils across the seams of a garment modelled in 3D: each edge two
 * pieces share, resting at the angle the pieces were modelled meeting at. A
 * seam is no hinge: without them a shoulder seam folded sharp.
 */
function addSeamBends(points: number[][], tris: number[], interiorBends: BendSet, out: BendSet) {
  const done = new Set<string>();
  for (let q = 0; q < interiorBends.quads.length; q += 4) {
    const a = interiorBends.quads[q], b = interiorBends.quads[q + 1];
    done.add(a < b ? `${a},${b}` : `${b},${a}`);
  }
  const opposite = new Map<string, { a: number; b: number; o: number[] }>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)], o = tris[t + ((e + 2) % 3)];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (done.has(key)) continue;
    const entry = opposite.get(key) ?? opposite.set(key, { a, b, o: [] }).get(key)!;
    entry.o.push(o);
  }
  for (const { a, b, o } of opposite.values()) {
    if (o.length !== 2) continue;
    addStencil([a, b, o[0], o[1]], [points[a], points[b], points[o[0]], points[o[1]]], out);
  }
}

export function clothModel(node: SceneNode, world: THREE.Matrix4, scene: SceneNode[]): ClothModel {
  const spec = node.cloth!;
  const material = clothMaterial(spec), materialName: ClothMaterialName = spec.material ?? 'jersey';
  const name = node.name || node.id;
  const v = new THREE.Vector3();
  const toWorld = (p: number[]) => { v.set(p[0], p[1], p[2]).applyMatrix4(world); return [v.x, v.y, v.z]; };
  const edges = new EdgeSet(), bends = new BendSet(), limits = new EdgeSet();
  const groups: ClothRenderGroup[] = [];
  const tris: number[] = [];
  let x0: number[][] = [];
  let mass: number[] = [];
  const stitches: number[] = [];
  const ties: ClothTieSpec[] = [];
  const addMass = (a: number, b: number, c: number, area: number) => {
    const m = (material.arealDensity * area) / 3;
    mass[a] += m; mass[b] += m; mass[c] += m;
  };
  const flatArea = (p: number[], q: number[], r: number[]) => Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;

  if (spec.garment) {
    const form = findNode(scene, spec.garment.fitTo);
    if (!form?.bodyForm) throw new Error(`the garment '${name}' is fitted to '${spec.garment.fitTo}', which is not a body form here`);
    const shell = garmentShell(spec.garment, form.bodyForm, spec.layer ?? 0);
    x0 = shell.points.map(toWorld);
    mass = new Array(x0.length).fill(0);
    const colour = spec.garment.rgba ?? GARMENT_DEFAULTS[spec.garment.garment]?.rgba ?? [0.5, 0.5, 0.6, 1];
    const seamPaths = shell.seams.map((sm) => sm.path);
    const panelOf: number[] = [];
    // As pieces: each panel its own particles, laid flat a little off its
    // place on the form, in the plane it faces; a shell point two panels
    // share becomes a stitch between their copies, closed when the scene plays.
    const asPieces = spec.layout === 'pieces';
    if (asPieces) { x0 = []; mass = []; }
    const copies = new Map<number, number[]>();
    // Points on an open seam (a jacket's front) belong to one panel each:
    // the second panel to reach one gets its own, unsewn copy.
    const openPoints = new Set<number>();
    for (const sm of shell.seams) if (sm.open) for (const i of sm.path) openPoints.add(i);
    const claimed = new Map<number, number>();
    const trimAt = new Map<number, { trim: GarmentTrim; point: number }[]>();
    for (const t of trimPoints(shell.points, [...shell.edges, ...shell.seams], spec.garment.trims ?? GARMENT_DEFAULTS[spec.garment.garment]?.trims ?? [])) (trimAt.get(t.point) ?? trimAt.set(t.point, []).get(t.point)!).push(t);
    shell.panels.forEach((panel, k) => {
      const piece = flattenPanel(panel.name, shell.cut ?? shell.points, shell.tris, panel.tris, seamPaths);
      let particleOf = (local: number) => piece.points[local];
      if (!asPieces && openPoints.size) {
        const own = new Map<number, number>();
        piece.points.forEach((g, local) => {
          if (!openPoints.has(g)) return;
          if (claimed.get(g) === undefined) { claimed.set(g, k); return; }
          if (claimed.get(g) === k) return;
          own.set(local, x0.length); x0.push(x0[g].slice()); mass.push(0);
        });
        if (own.size) particleOf = (local: number) => own.get(local) ?? piece.points[local];
      }
      if (asPieces) {
        const base = x0.length;
        const centre = [0, 0, 0];
        for (const t of panel.tris) for (let q = 0; q < 3; q++) { const a = shell.points[shell.tris[3 * t + q]]; for (let k = 0; k < 3; k++) centre[k] += a[k] / (3 * panel.tris.length); }
        // Out from the form's axis, level, a little past where the panel
        // was: a piece stands up facing where it goes. (Its own normals
        // cancel on a sleeve, and placed by them it went through the arm;
        // placed clear of the whole form it was pulled in from too far, over
        // the arms, and ended inside them.)
        const nl = Math.hypot(centre[0], centre[1]);
        const n = nl > 0.02 ? [centre[0] / nl, centre[1] / nl, 0] : [0, -1, 0], right = [-n[1], n[0], 0];
        const along = centre[0] * n[0] + centre[1] * n[1] + PIECE_STAND_OFF;
        const zMean = piece.uv.reduce((acc, q) => acc + q[1], 0) / piece.uv.length;
        for (const [u, v] of piece.uv) x0.push(toWorld([n[0] * along + right[0] * u, n[1] * along + right[1] * u, Math.max(0.02, centre[2] + v - zMean)]));
        for (let i = 0; i < piece.uv.length; i++) { mass.push(0); (copies.get(piece.points[i]) ?? copies.set(piece.points[i], []).get(piece.points[i])!).push(base + i); }
        particleOf = (local: number) => base + local;
      }
      for (let t = 0; t < piece.tris.length; t += 3) {
        const [i, j, l] = [piece.tris[t], piece.tris[t + 1], piece.tris[t + 2]];
        const [a, b, c] = [particleOf(i), particleOf(j), particleOf(l)];
        tris.push(a, b, c);
        panelOf.push(k);
        for (const [p, q] of [[i, j], [j, l], [l, i]]) edges.add(particleOf(p), particleOf(q), Math.hypot(piece.uv[p][0] - piece.uv[q][0], piece.uv[p][1] - piece.uv[q][1]));
        addMass(a, b, c, flatArea(piece.uv[i], piece.uv[j], piece.uv[l]));
      }
      if (material.bending) addBends(piece.tris, piece.uv, particleOf, bends);
      addLimits(piece.tris, piece.uv, particleOf, limits);
      const trims: ClothTrim[] = [];
      piece.points.forEach((g, local) => { for (const { trim } of trimAt.get(g) ?? []) trims.push({ kind: trim.kind, particle: local, size: trim.size ?? TRIM_DEFAULTS[trim.kind].size, rgba: trim.rgba ?? TRIM_DEFAULTS[trim.kind].rgba }); });
      groups.push({
        name: `${name}__${panel.name}`, rgba: panel.name.startsWith('back') ? shade(colour, 0.85) : colour, material: materialName,
        particles: piece.points.map((_, i) => particleOf(i)), tris: piece.tris.slice(),
        flat: { uv: piece.uv.map(([u, v]) => [u, v]), outline: piece.outline.slice(), strain95: piece.strain95, marks: trims },
        trims,
      });
    });
    if (asPieces) { for (const list of copies.values()) for (let i = 1; i < list.length; i++) stitches.push(list[i - 1], list[i]); }
    else if (material.bending) addSeamBends(x0, tris, bends, bends);
  } else {
    const mesh = meshCloth(spec);
    const base: Record<string, number> = {};
    for (const p of spec.pieces ?? []) {
      const m = mesh.pieces[p.name];
      base[p.name] = x0.length;
      for (const q of m.start) { x0.push(toWorld(q)); mass.push(0); }
      const off = base[p.name], particleOf = (local: number) => off + local;
      for (let t = 0; t < m.tris.length; t += 3) {
        const [i, j, l] = [m.tris[t], m.tris[t + 1], m.tris[t + 2]];
        tris.push(off + i, off + j, off + l);
        const k = p.stiffnessScale ?? 1;
        for (const [a, b] of [[i, j], [j, l], [l, i]]) edges.add(off + a, off + b, Math.hypot(m.uv[a][0] - m.uv[b][0], m.uv[a][1] - m.uv[b][1]));
        void k;
        addMass(off + i, off + j, off + l, flatArea(m.uv[i], m.uv[j], m.uv[l]));
      }
      if (material.bending) addBends(m.tris, m.uv, particleOf, bends);
      addLimits(m.tris, m.uv, particleOf, limits);
      groups.push({ name: `${name}__${p.name}`, rgba: p.rgba ?? [0.25, 0.5, 0.85, 1], material: materialName, particles: m.uv.map((_, i) => off + i), tris: m.tris.slice() });
    }
    for (const s of mesh.stitches) stitches.push(base[s.a[0]] + s.a[1], base[s.b[0]] + s.b[1]);
    for (const t of mesh.ties) {
      const tie = spec.ties![t.tie];
      t.verts.forEach((vtx, k) => ties.push({
        name: tie.name ?? `${name} tie ${t.tie + 1}${t.verts.length > 1 ? `.${k + 1}` : ''}`,
        particle: base[t.piece] + vtx,
        body: tie.to ?? null,
        cloth: tie.toCloth ?? null,
        anchor: tie.anchor && t.verts.length === 1 ? tie.anchor.slice(0, 3) : null,
      }));
    }
  }
  const [edgePairs, edgeRest] = edges.flat();
  const [limitPairs, limitRest] = limits.flat();
  const x = new Float64Array(x0.length * 3);
  x0.forEach((p, i) => { x[3 * i] = p[0]; x[3 * i + 1] = p[1]; x[3 * i + 2] = p[2]; });
  return {
    name, material, layer: spec.layer ?? 0, outward: !!spec.garment, sewTime: spec.sewTime ?? DEFAULT_SEW_TIME,
    x0: x, invMass: Float64Array.from(mass, (m) => (m > 0 ? 1 / m : 0)),
    tris, edges: edgePairs, edgeRest, bends: bends.quads, bendWeights: bends.weights, bendArea: bends.area, bendRest: bends.rest, limits: limitPairs, limitRest, stitches, ties, groups,
  };
}
