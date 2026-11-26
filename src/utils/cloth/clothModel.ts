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

import { garmentNameWarnings, linePicks } from './clothNames';
import * as THREE from 'three';
import type { ClothMaterial, ClothMaterialName, ClothPatternPrint, GarmentBelt, GarmentTrim } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { chain, CLOTH_MATERIALS, clothBendRigidity, clothMaterial, DEFAULT_CLOTH_SPACING, DEFAULT_SEW_TIME, meshCloth, resolveClothMaterial } from './clothMesh';
import { restOff } from './garmentPlan';
import { garmentShell } from './garmentShell';
import { doneUp } from './fastening';
import { flattenPanel, type FlatPiece } from './garmentFlatten';
import { meshSpacing, spreadOver, spreadPanel } from './garmentSpread';
import { addRod, rodLines, type RodConstraints } from './clothRods';
import { BOARD_STIFFNESS, type Board } from './clothBoards';
import { garmentForm, garmentSettings } from './garments';
import { bodyFormGeoms, bodyLandmarks } from './bodyForm';
import { beltPaths, beltPieces, LAP_OFF, pocketPieces, standPiece, type AddOnPiece, type HostPanel } from './garmentAddOns';
import { attachedPieces } from './garmentAttached';
import { collarPieces, lapelPieces } from './garmentCollars';
import { fullSides, panelEdgeEase } from './garmentFullness';

/** A piece as it is cut: its points flat, metres, v up the body; its outline in order round it; how much it had to stretch to lie flat; its trims, by point. */
export interface FlatPattern {
  uv: [number, number][];
  outline: number[];
  strain95: number;
  marks?: ClothTrim[];
  /** Boning channels: runs of its points (local indices). */
  lines?: number[][];
  /** Double-ended darts inside its outline: loops of its points (local indices). */
  darts?: number[][];
}

/** A stud, button, bead or zipper tooth riding on one of a group's points (its local index), `size` across. */
export interface ClothTrim {
  kind: GarmentTrim['kind'];
  particle: number;
  size: number;
  rgba: number[];
  /** Between `particle` and this one, `t` of the way (finer than the cloth's points). */
  toward?: number;
  t?: number;
  /** Set off across its line, metres. */
  offset?: number;
  /** Its run along a line, in order (a zip's tape is drawn through one), and whether it ends one (where a zip's slider sits). */
  run?: number;
  end?: boolean;
  /** A zip's tooth: which of the garment's trims it is (ClothModel.zips) and how far up its run, 0 to 1 from the bottom; the slider rides to the top tooth done up. */
  zip?: { trim: number; at: number };
  /** Drawn on the cloth's back face (the way its normal points is not its outside here). */
  flip?: boolean;
}

/**
 * A zip along an opening, done up and undone as the scene runs: the two
 * sides' particles at each point of its run (`pairs`, two a pair), how far up
 * the run each is (0 to 1 from the bottom, rising), each pair's sew time as
 * built, and how far it is done up. A pair is held shut where its place is at
 * or below `fastened`; the slider sits there.
 */
export interface ClothZip {
  /** Its index in the garment's trims. */
  trim: number;
  pairs: number[];
  at: number[];
  sew: number[];
  fastened: number;
}

const TRIM_DEFAULTS: Record<GarmentTrim['kind'], { size: number; spacing: number; rgba: number[] }> = {
  stud: { size: 0.008, spacing: 0.02, rgba: [0.82, 0.82, 0.85, 1] },
  button: { size: 0.012, spacing: 0.08, rgba: [0.12, 0.1, 0.08, 1] },
  buttonhole: { size: 0.014, spacing: 0.08, rgba: [0.18, 0.16, 0.15, 1] },
  bead: { size: 0.006, spacing: 0.009, rgba: [0.9, 0.84, 0.45, 1] },
  zipper: { size: 0.004, spacing: 0.005, rgba: [0.8, 0.8, 0.84, 1] },
  buckle: { size: 0.038, spacing: 1, rgba: [0.82, 0.78, 0.65, 1] },
  // Topstitching: a dash of thread `size` long every `spacing`.
  stitch: { size: 0.0032, spacing: 0.0048, rgba: [0.86, 0.68, 0.32, 1] },
};

/**
 * An elastic's relaxed length over the edge it gathers, and its E*A (N), unless
 * given. Soft by default: much stiffer gathers a mesh this fine into a
 * one-triangle sawtooth rather than soft folds.
 */
const ELASTIC_RATIO = 0.75, ELASTIC_STIFFNESS = 12;

/** Chains matching named segments (`cuff` matches `cuffL` and `cuffR`; `top`/`waist` match top openings) into ordered vertex runs. */
function chainLineRuns(lines: { name: string; path: number[] }[], along: string): { run: number[]; closed: boolean }[] {
  const next = new Map<number, number[]>();
  for (const l of lines) {
    if (!linePicks(l.name, along)) continue;
    const [a, b] = l.path;
    (next.get(a) ?? next.set(a, []).get(a)!).push(b);
    (next.get(b) ?? next.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const starts = [...next.keys()].sort((a, b) => (next.get(a)!.length - next.get(b)!.length));
  const out: { run: number[]; closed: boolean }[] = [];
  for (const start of starts) {
    if (seen.has(start)) continue;
    const run = [start];
    seen.add(start);
    for (let cur = start; ;) {
      const n = (next.get(cur) ?? []).find((q) => !seen.has(q));
      if (n === undefined) break;
      seen.add(n); run.push(n); cur = n;
    }
    const closed = run.length > 2 && (next.get(run[run.length - 1]) ?? []).includes(start);
    out.push({ run, closed });
  }
  return out;
}

/** A trim placed on a line: at `point`, or `t` of the way on to `toward`; its row's offset, its run, and whether it ends it. */
/** How far apart the two sides of an opening start where it is not done up, metres. */
const OPEN_GAP = 0.001;

interface TrimPlace { trim: GarmentTrim; point: number; toward?: number; t?: number; offset: number; run: number; end: boolean; /** Done up (a fastening's part of the run below how far it is fastened). */ closed: boolean; /** How far up its run, 0 to 1 from the bottom (a fastening's). */ along?: number; /** A point of the cloth on its side of its line (a seam's two panels both hold the line): drawn on the panel that holds it. */ sideOf?: number }

/**
 * Where a garment's trims sit: the lines named (`cuff` takes both cuffs)
 * chained into runs, and along each one every `spacing`, exactly there,
 * between the run's points (teeth and stitches far finer than the cloth's
 * points); a row of them at each of its offsets across the line. A fastened
 * zip's run ends at its top, where its slider is. Shell point indices.
 */
function trimPoints(points: number[][], lines: { name: string; path: number[] }[], trims: GarmentTrim[], tris: number[] = []): TrimPlace[] {
  let trimRuns = 0;
  const out: TrimPlace[] = [];
  // Which side of a run the cloth is on (an edge's one side; a seam's, one of
  // them, the same all along): an offset is into it. Left going along the
  // line instead, a hem's topstitching came out in the air past its edge.
  const n = points.length, opposite = new Map<number, number>(), across = new Map<number, [number, number][]>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)], o = tris[t + ((e + 2) % 3)];
    opposite.set(a * n + b, o); opposite.set(b * n + a, o);
    const key = Math.min(a, b) * n + Math.max(a, b);
    (across.get(key) ?? across.set(key, []).get(key)!).push([o, t]);
  }
  // The cloth's point across edge a-b on the side `sign` (left going a to b, by the cloth's normal, as intoCloth reads it).
  const sideAt = (a: number, b: number, sign: number) => {
    const os = across.get(Math.min(a, b) * n + Math.max(a, b)) ?? [];
    if (os.length < 2) return os[0]?.[0];
    const pa = points[a], ab = [0, 1, 2].map((c) => points[b][c] - pa[c]);
    for (const [o, t0] of os) {
      const ao = [0, 1, 2].map((c) => points[o][c] - pa[c]);
      const [q0, q1, q2] = [points[tris[t0]], points[tris[t0 + 1]], points[tris[t0 + 2]]];
      const u = [0, 1, 2].map((c) => q1[c] - q0[c]), v = [0, 1, 2].map((c) => q2[c] - q0[c]);
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const sd = [nrm[1] * ab[2] - nrm[2] * ab[1], nrm[2] * ab[0] - nrm[0] * ab[2], nrm[0] * ab[1] - nrm[1] * ab[0]];
      if ((sd[0] * ao[0] + sd[1] * ao[1] + sd[2] * ao[2] >= 0 ? 1 : -1) === sign) return o;
    }
    return os[0][0];
  };
  const intoCloth = (run: number[]) => {
    for (let k = 1; k < run.length; k++) {
      const a = run[k - 1], b = run[k], o = opposite.get(a * n + b);
      if (o === undefined) continue;
      const pa = points[a], ab = [0, 1, 2].map((c) => points[b][c] - pa[c]), ao = [0, 1, 2].map((c) => points[o][c] - pa[c]);
      // The triangle's own normal, wound outward, as the cloth's normal is drawn.
      const os = across.get(Math.min(a, b) * n + Math.max(a, b));
      const t0 = os?.find((x) => x[0] === o)?.[1] ?? -1;
      if (t0 < 0) continue;
      const [q0, q1, q2] = [points[tris[t0]], points[tris[t0 + 1]], points[tris[t0 + 2]]];
      const u = [0, 1, 2].map((c) => q1[c] - q0[c]), v = [0, 1, 2].map((c) => q2[c] - q0[c]);
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const side = [nrm[1] * ab[2] - nrm[2] * ab[1], nrm[2] * ab[0] - nrm[0] * ab[2], nrm[0] * ab[1] - nrm[1] * ab[0]];
      return side[0] * ao[0] + side[1] * ao[1] + side[2] * ao[2] >= 0 ? 1 : -1;
    }
    return 1;
  };
  for (const trim of trims) {
    // One at a point: on the garment's point nearest it (a line drawn there
    // for it crossed a seam, and each side of the seam had one).
    if (trim.at) {
      let best = -1, bd = Infinity;
      points.forEach((q, i) => { const d = (q[0] - trim.at![0]) ** 2 + (q[1] - trim.at![1]) ** 2 + (q[2] - trim.at![2]) ** 2; if (d < bd) { bd = d; best = i; } });
      if (best >= 0) out.push({ trim, point: best, toward: best, t: 0, offset: 0, run: trimRuns++, end: false, closed: true });
      continue;
    }
    if (!trim.along) continue;
    const spacing = trim.spacing ?? TRIM_DEFAULTS[trim.kind].spacing;
    const offsets = Array.isArray(trim.offset) ? trim.offset : [trim.offset ?? 0];
    chainLineRuns(lines, trim.along).forEach(({ run }, side) => {
      const at = [0];
      for (let k = 1; k < run.length; k++) { const a = points[run[k - 1]], b = points[run[k]]; at.push(at[k - 1] + Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); }
      const total = at[at.length - 1];
      const count = total > 0 ? Math.max(1, Math.floor(total / spacing)) : 0;
      // Its slider at the top of the run.
      const topLast = points[run[run.length - 1]][2] >= points[run[0]][2], into = intoCloth(run);
      for (const offset0 of offsets) {
        const offset = offset0 * into;
        const id = trimRuns++;
        // A zip's two sides interlock: the second's teeth half a tooth along from the first's.
        const wants = Array.from({ length: count }, (_, j) => (total - (count - 1) * spacing) / 2 + j * spacing + (trim.kind === 'zipper' && side % 2 ? spacing / 2 : 0));
        // Done up from the bottom as far as it is fastened; a zip's slider at
        // the top of that, or at its bottom when it is all undone (where it is
        // taken hold of to do it up).
        const up = doneUp(trim), along = wants.map((w) => (topLast ? w / total : 1 - w / total)), closed = along.map((a) => a <= up + 1e-9);
        const shut = closed.flatMap((c, j) => (c ? [j] : []));
        const slider = trim.kind !== 'zipper' || !count ? -1 : shut.length ? (topLast ? shut[shut.length - 1] : shut[0]) : topLast ? 0 : count - 1;
        wants.forEach((want, j) => {
          let k = 1;
          while (k < run.length - 1 && at[k] < want) k++;
          const seg = at[k] - at[k - 1], t = seg > 0 ? Math.max(0, Math.min(1, (want - at[k - 1]) / seg)) : 0;
          // Topstitching on the panel it is stitched through: along a seam,
          // drawn on both panels, each run showed twice, a little out of line (speckled).
          const sideOf = trim.kind === 'stitch' ? sideAt(run[k - 1], run[k], (offset0 ? Math.sign(offset0) : 1) * into) : undefined;
          out.push({ trim, point: run[k - 1], toward: run[k], t, offset, run: id, end: j === slider, closed: closed[j], along: along[j], ...(sideOf !== undefined ? { sideOf } : {}) });
        });
      }
    });
  }
  return out;
}

/** A placed trim as drawn, its points by `localOf` (null where one of them is not on the piece). */
function placedTrim(pl: TrimPlace, localOf: (g: number) => number | undefined, kind = pl.trim.kind, size = pl.trim.size ?? TRIM_DEFAULTS[pl.trim.kind].size, rgba = pl.trim.rgba ?? TRIM_DEFAULTS[pl.trim.kind].rgba): ClothTrim | null {
  const particle = localOf(pl.point);
  if (particle === undefined) return null;
  const toward = pl.toward === undefined ? undefined : localOf(pl.toward);
  return { kind, particle, size, rgba, ...(toward !== undefined && pl.t ? { toward, t: pl.t } : {}), ...(pl.offset ? { offset: pl.offset } : {}), run: pl.run, ...(pl.end ? { end: true } : {}) };
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
  /** Studs, buttons, buttonholes, beads, zipper teeth on its points. */
  trims?: ClothTrim[];
  /** Printed SVG pattern on this group. */
  pattern?: ClothPatternPrint;
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

export interface ClothTack {
  particle: number;
  tri: [number, number, number];
  bary: [number, number, number];
  offset: number;
  /** Free to lift further off than `offset` (held from sliding along the triangle, and from sinking under it); else held at it. */
  lift?: boolean;
}

export interface ClothModel {
  name: string;
  /** What in its spec names nothing in it (a line, a panel, a piece): ignored, and said so. */
  warnings?: string[];
  /** Particles that start lifted off what they hang on, let fall into place before the cloth is first drawn. */
  drop?: number[];
  /** Particles drawn to places (world) before the cloth is first drawn, then let go: its arrangement (ClothSpec.arrange). */
  pulls?: { particle: number; to: number[]; via?: number[][] }[];
  material: ClothMaterial;
  /** Worn over every concentric cloth of a lower layer on the same form/part (clothLayers). */
  layer: number;
  /** Body form this cloth is fitted to (or tied onto), if any, for concentric layer pairing. */
  fitTo?: string;
  /** True for an unfitted garment (`garment` with no `fitTo`), which falls loose rather than concentric on a form. */
  loose?: boolean;
  /** Body parts covered by a modelled garment (`skin`, `head`, `armL`, ...), so disjoint parts do not nest as layers. */
  parts?: string[];
  /** Whether its triangles all face out (a garment modelled round a body), so its outside is known. */
  outward: boolean;
  /** Whether it is kept off itself and the other cloth of its layer (clothSelf); default true. */
  selfCollide?: boolean;
  sewTime: number;
  x0: Float64Array;
  invMass: Float64Array;
  /** Every triangle, by particle, for the wind and layer contacts. */
  tris: number[];
  /** Index in `tris` where tacked overlay triangles (pockets, belts, belt loops) begin. */
  overlayTrisStart?: number;
  /** Pairs of particles and the length between them on the flat cloth. */
  edges: number[];
  edgeRest: number[];
  /** Each edge's stretch stiffness over the material's (a stiffened piece's, say). */
  edgeStiffness?: number[];
  /** Minimum length before an edge resists compression (smaller than `edgeRest` along an embedded elastic). */
  edgeMin?: number[];
  /** Embedded elastic bands: pairs of particles, their relaxed lengths, their flat lengths, and their compliances (m/N). */
  elastics?: number[];
  elasticRest?: number[];
  elasticFlat?: number[];
  elasticAlpha?: number[];
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
  /** Dihedral sign (-1, 0, or 1) of each non-zero rest curvature stencil in rest space. */
  bendSign?: number[];
  /** Each stencil's bending stiffness over the material's. */
  bendStiffness?: number[];
  /** Pairs of particles two edges apart, and their flat distance: the most they may stretch to. */
  limits: number[];
  limitRest: number[];
  /** Pairs of particles sewn together, closing over the sew time. */
  stitches: number[];
  stitchSew?: number[];
  /** Zips, held shut below their sliders (their pairs are not among the stitches). */
  zips?: ClothZip[];
  /** Boning (clothRods). */
  rods?: RodConstraints;
  /** Pieces stiff enough to keep their shape, held rigid in their plane (clothBoards): particles, flat pattern, local triangles. */
  boards?: Board[];
  /** Surface tacks holding overlay pieces (pockets, belts, belt loops) at a clean normal offset outside a garment triangle. */
  tacks?: ClothTack[];
  ties: ClothTieSpec[];
  groups: ClothRenderGroup[];
}

/** A triangle's unit normal, by its points' positions. */
function triNormal(x: number[][], [a, b, c]: number[]): number[] {
  const u = [x[b][0] - x[a][0], x[b][1] - x[a][1], x[b][2] - x[a][2]], v = [x[c][0] - x[a][0], x[c][1] - x[a][1], x[c][2] - x[a][2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [n[0] / l, n[1] / l, n[2] / l];
}

/** Each point's outward normal: its triangles' (wound outward), area-weighted, turned as `world` turns. */
function vertexNormals(points: number[][], tris: number[], world: THREE.Matrix4): number[][] {
  const n = points.map(() => [0, 0, 0]);
  for (let t = 0; t < tris.length; t += 3) {
    const [a, b, c] = [tris[t], tris[t + 1], tris[t + 2]];
    const u = [points[b][0] - points[a][0], points[b][1] - points[a][1], points[b][2] - points[a][2]], v = [points[c][0] - points[a][0], points[c][1] - points[a][1], points[c][2] - points[a][2]];
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    for (const i of [a, b, c]) for (let k = 0; k < 3; k++) n[i][k] += f[k];
  }
  const nm = new THREE.Matrix3().getNormalMatrix(world), w = new THREE.Vector3();
  return n.map((q) => { w.set(q[0], q[1], q[2]).applyMatrix3(nm).normalize(); return [w.x, w.y, w.z]; });
}

const shade = (c: number[], k: number) => [c[0] * k, c[1] * k, c[2] * k, c[3] ?? 1];

/** Pairs of edges into a map keyed by particle pair, averaging lengths seen more than once. */
class EdgeSet {
  private map = new Map<string, { a: number; b: number; sum: number; n: number; minRatio: number; scale: number }>();
  /** `scale`: stiffness over the material's (the stiffest of an edge's pieces wins). */
  add(a: number, b: number, len: number, scale = 1) {
    if (a === b) return;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const e = this.map.get(key);
    if (e) { e.sum += len; e.n++; e.scale = Math.max(e.scale, scale); } else this.map.set(key, { a, b, sum: len, n: 1, minRatio: 1, scale });
  }
  scales(): number[] { return [...this.map.values()].map((e) => e.scale); }
  getLen(a: number, b: number): number | undefined {
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const e = this.map.get(key);
    return e ? e.sum / e.n : undefined;
  }
  setMinRatio(a: number, b: number, ratio: number) {
    if (a === b) return;
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const e = this.map.get(key);
    if (e) e.minRatio = Math.min(e.minRatio, ratio);
  }
  flat(): [number[], number[], number[]] {
    const pairs: number[] = [], rest: number[] = [], minRest: number[] = [];
    for (const e of this.map.values()) {
      const r = e.sum / e.n;
      pairs.push(e.a, e.b);
      rest.push(r);
      minRest.push(r * e.minRatio);
    }
    return [pairs, rest, minRest];
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
  quads: number[] = []; weights: number[] = []; area: number[] = []; rest: number[] = []; sign: number[] = [];
  /** Each stencil's stiffness over the material's. */
  scale: number[] = [];
}
/** `rest`: where each point rests in 3D, if not flat (a pressed piece rests as it starts). */
function addBends(tris: number[], uv: number[][], particleOf: (local: number) => number, out: BendSet, scale = 1, rest?: number[][]) {
  const opposite = new Map<string, { a: number; b: number; o: number[] }>();
  for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
    const a = tris[t + e], b = tris[t + ((e + 1) % 3)], o = tris[t + ((e + 2) % 3)];
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    const entry = opposite.get(key) ?? opposite.set(key, { a, b, o: [] }).get(key)!;
    entry.o.push(o);
  }
  for (const { a, b, o } of opposite.values()) {
    if (o.length !== 2) continue;
    const flat = (i: number) => (rest ? rest[i] : [uv[i][0], uv[i][1], 0]);
    addStencil([particleOf(a), particleOf(b), particleOf(o[0]), particleOf(o[1])], [flat(a), flat(b), flat(o[0]), flat(o[1])], out, scale);
  }
}

/**
 * One stencil, its weights from `rest` (four points, 3D): Bergou et al., "A
 * quadratic bending model for inextensible surfaces". Rests at the
 * curvature `rest` has, which is none if it is flat.
 */
function addStencil(ids: number[], rest: number[][], out: BendSet, scale = 1) {
  const sub = (p: number[], q: number[]) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const cross = (u: number[], v: number[]) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const crossLen = (u: number[], v: number[]) => Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  const cot = (u: number[], v: number[]) => (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / Math.max(1e-12, crossLen(u, v));
  const [x0, x1, x2, x3] = rest;
  const e0 = sub(x1, x0), e1 = sub(x2, x0), e2 = sub(x3, x0), e3 = sub(x2, x1), e4 = sub(x3, x1), ne0 = [-e0[0], -e0[1], -e0[2]];
  const area = (crossLen(e0, e1) + crossLen(e0, e2)) / 2;
  if (area < 1e-10) return;
  const c01 = cot(e0, e1), c02 = cot(e0, e2), c03 = cot(ne0, e3), c04 = cot(ne0, e4);
  const K = [c03 + c04, c01 + c02, -c01 - c03, -c02 - c04];
  const v = [0, 1, 2].map((k) => K.reduce((sum, w, j) => sum + w * rest[j][k], 0));
  const mag = Math.hypot(v[0], v[1], v[2]);
  const h = cross(e0, sub(e1, e2));
  const dot = v[0] * h[0] + v[1] * h[1] + v[2] * h[2];
  out.quads.push(...ids);
  out.weights.push(...K);
  out.area.push(area);
  out.rest.push(mag);
  out.sign.push(mag > 1e-9 && Math.abs(dot) > 1e-18 ? (dot >= 0 ? 1 : -1) : 0);
  out.scale.push(scale);
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

/**
 * An add-on cut in one with a panel (a lapel with its front): its points
 * added to the panel's group, its flat points already in the panel's frame,
 * and its own edges taking the place of the stretch of the panel's outline
 * between its first and last shared points. False if they are not on it.
 */
function joinGroup(group: ClothRenderGroup, piece: AddOnPiece, particleOf: (local: number) => number): boolean {
  const path = piece.joinPath ?? [], flat = group.flat;
  if (!flat || path.length < 2) return false;
  const localOf = new Map(group.particles.map((p, i) => [p, i]));
  const a = localOf.get(particleOf(path[0])), b = localOf.get(particleOf(path[path.length - 1]));
  if (a === undefined || b === undefined) return false;
  const ia = flat.outline.indexOf(a), ib = flat.outline.indexOf(b);
  if (ia < 0 || ib < 0) return false;
  const local = piece.uv.map((q, i) => {
    const have = localOf.get(particleOf(i));
    if (have !== undefined) return have;
    group.particles.push(particleOf(i));
    flat.uv.push([q[0], q[1]]);
    return group.particles.length - 1;
  });
  for (let t = 0; t < piece.tris.length; t += 3) group.tris.push(local[piece.tris[t]], local[piece.tris[t + 1]], local[piece.tris[t + 2]]);
  // Cut in one: the piece needs as much stretch to lie flat as the worse of the two did.
  flat.strain95 = Math.max(flat.strain95, piece.strain95 ?? 0);
  // The outline from a to b one way round or the other: the shared seam is the arc carrying `piece.shared` vertices,
  // AND any boundary vertices skipped over between shared points along the neckline/gorge (`neckPts` column thinning in
  // `collarPieces`) are bridged by `joinPath` rather than left as an unreferenced triangle outside `flat.outline`.
  const m = flat.outline.length, fwd = (ib - ia + m) % m;
  const inner = path.slice(1, -1).map((i) => local[i]);
  const rot = [...flat.outline.slice(ia), ...flat.outline.slice(0, ia)];
  const sharedLocal = new Set((piece.shared ?? []).map((sh) => localOf.get(particleOf(sh.local))).filter((v): v is number => v !== undefined));
  let fwdHits = 0, bwdHits = 0;
  for (let k = 1; k < fwd; k++) if (sharedLocal.has(rot[k])) fwdHits++;
  for (let k = fwd + 1; k < m; k++) if (sharedLocal.has(rot[k])) bwdHits++;
  // When both arcs have equal shared-vertex counts (e.g. a lapel whose roll line has 0 intermediate shared vertices
  // on `flat.outline`, or 1 hit on a corner), compare the spliced polygon area against the 2D triangle mesh area
  // so we never cut off the body of a cropped bolero!
  let replaceFwd: boolean;
  if (fwdHits !== bwdHits) {
    replaceFwd = fwdHits > bwdHits;
  } else {
    let triAbs = 0;
    for (let t = 0; t < group.tris.length; t += 3) {
      const p = flat.uv[group.tris[t]], q = flat.uv[group.tris[t + 1]], r = flat.uv[group.tris[t + 2]];
      triAbs += 0.5 * Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]));
    }
    const areaOf = (lp: number[]) => {
      let s = 0;
      for (let i = 0; i < lp.length; i++) {
        const p = flat.uv[lp[i]], q = flat.uv[lp[(i + 1) % lp.length]];
        s += p[0] * q[1] - q[0] * p[1];
      }
      return 0.5 * Math.abs(s);
    };
    const candFwd = [a, ...inner, ...rot.slice(fwd)];
    const candBwd = [a, ...rot.slice(1, fwd + 1), ...inner.slice().reverse()];
    replaceFwd = Math.abs(areaOf(candFwd) - triAbs) <= Math.abs(areaOf(candBwd) - triAbs);
  }
  let chosen = replaceFwd ? [a, ...inner, ...rot.slice(fwd)] : [a, ...rot.slice(1, fwd + 1), ...inner.slice().reverse()];
  // Keep CCW winding (positive signed area, matching flattenPanel).
  let s2 = 0;
  for (let i = 0; i < chosen.length; i++) {
    const p = flat.uv[chosen[i]], q = flat.uv[chosen[(i + 1) % chosen.length]];
    s2 += p[0] * q[1] - q[0] * p[1];
  }
  if (s2 < 0) chosen = [chosen[0], ...chosen.slice(1).reverse()];
  flat.outline = chosen;
  return true;
}

export function clothModel(node: SceneNode, world: THREE.Matrix4, scene: SceneNode[]): ClothModel {
  const spec = node.cloth!;
  const material = clothMaterial(spec), materialName: ClothMaterialName = spec.material ?? 'jersey';
  const sewTime = spec.sewTime ?? DEFAULT_SEW_TIME;
  const name = node.name || node.id;
  const v = new THREE.Vector3();
  const toWorld = (p: number[]) => { v.set(p[0], p[1], p[2]).applyMatrix4(world); return [v.x, v.y, v.z]; };
  const edges = new EdgeSet(), bends = new BendSet(), limits = new EdgeSet();
  const elastics: number[] = [], elasticRest: number[] = [], elasticFlat: number[] = [], elasticAlpha: number[] = [];
  const tacks: ClothTack[] = [];
  const boards: Board[] = [];
  const drop: number[] = [];
  const rods: RodConstraints = { links: [], linkRest: [], bends: [], bendRest: [], bendAlpha: [] };
  const groups: ClothRenderGroup[] = [];
  const tris: number[] = [];
  let x0: number[][] = [];
  let mass: number[] = [];
  const stitches: number[] = [], stitchSew: number[] = [];
  const zips: ClothZip[] = [];
  const addStitch = (a: number, b: number, sew = sewTime) => {
    if (a === b) return;
    stitches.push(a, b);
    stitchSew.push(sew);
  };
  const ties: ClothTieSpec[] = [];
  const addMass = (a: number, b: number, c: number, area: number) => {
    const m = (material.arealDensity * area) / 3;
    mass[a] += m; mass[b] += m; mass[c] += m;
  };
  const flatArea = (p: number[], q: number[], r: number[]) => Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1])) / 2;
  const dist3 = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  /** Embeds an elastic band along a run of particles (closed loop or open chain). */
  const addElasticRun = (run: number[], closed: boolean, cfg: { ratio?: number; length?: number; stiffness?: number }) => {
    if (run.length < 2) return;
    const pts = closed ? [...run, run[0]] : run;
    const segLen: number[] = [];
    let totalFlat = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const d = edges.getLen(a, b) ?? dist3(x0[a], x0[b]);
      segLen.push(d);
      totalFlat += d;
    }
    if (totalFlat < 1e-6) return;
    const ratio = Math.max(0.25, Math.min(1, cfg.length !== undefined ? cfg.length / totalFlat : (cfg.ratio ?? ELASTIC_RATIO)));
    const stiffness = Math.max(0.1, cfg.stiffness ?? ELASTIC_STIFFNESS);
    const onRun = new Set<number>(run);
    for (let i = 1; i < pts.length; i++) edges.setMinRatio(pts[i - 1], pts[i], ratio);
    // Also let triangles sharing an edge with the elastic run ease slightly so the first row of triangles never locks into a sawtooth.
    for (let t = 0; t < tris.length; t += 3) {
      const a = tris[t], b = tris[t + 1], c = tris[t + 2];
      if (!onRun.has(a) && !onRun.has(b) && !onRun.has(c)) continue;
      const adjRatio = 0.5 * (1 + ratio);
      edges.setMinRatio(a, b, adjRatio);
      edges.setMinRatio(b, c, adjRatio);
      edges.setMinRatio(c, a, adjRatio);
    }
    const nSeg = segLen.length;
    const hops: [number, number][] = [[1, 0.5], [2, 0.3], [4, 0.2]];
    for (const [hop, wHop] of hops) {
      if (hop >= run.length) continue;
      const limit = closed ? run.length : run.length - hop;
      for (let i = 0; i < limit; i++) {
        const a = run[i], b = run[(i + hop) % run.length];
        if (a === b) continue;
        let dFlat = 0;
        for (let s = 0; s < hop; s++) dFlat += segLen[(i + s) % nSeg];
        const rest = ratio * dFlat;
        const alpha = rest / (stiffness * wHop);
        elastics.push(a, b);
        elasticRest.push(rest);
        elasticFlat.push(dFlat);
        elasticAlpha.push(alpha);
      }
    }
  };

  /** Where the triangles of what is sewn onto a garment begin (an outer layer is kept off them as off the garment). */
  let overlayTrisStart: number | undefined;
  let fitTo: string | undefined;
  let loose = false;
  let garmentParts: string[] | undefined;

  const warnings: string[] = [];
  if (spec.garment) {
    const form = { bodyForm: garmentForm(spec.garment, scene) };
    if (!form.bodyForm) throw new Error(`the garment '${name}' is fitted to '${spec.garment.fitTo}', which is not a body form here`);
    fitTo = spec.garment.fitTo;
    loose = !spec.garment.fitTo;
    const shell = garmentShell(spec.garment, form.bodyForm, spec.layer ?? 0);
    if (shell.warnings?.length) warnings.push(...shell.warnings);
    if (shell.part?.length) garmentParts = [...new Set(shell.part)];
    x0 = shell.points.map(toWorld);
    mass = new Array(x0.length).fill(0);
    const settings = garmentSettings(spec.garment);
    const L = bodyLandmarks(form.bodyForm);
    const colour = settings.rgba;
    const seamPaths = shell.seams.map((sm) => sm.path);
    // Fullness sewn into its seams: ease flattened into a piece, gathers and pleats spread into it.
    const sides = fullSides(shell, settings.fullness, settings.material);
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
    const openFirst = new Map<number, number>(), openSecond = new Map<number, number>();
    /** The panel each open point's second copy is on. */
    const secondPanel = new Map<number, number>();
    const trimList = trimPoints(shell.points, [...shell.edges, ...shell.seams, ...(shell.marks ?? [])], settings.trims ?? [], shell.tris);
    const sliderDrawn = new Set<TrimPlace>();
    const pointDrawn = new Set<TrimPlace>();
    // Negative ease: the pattern cut narrower than the form, by the ease
    // over the girth under each point (a band's own ease at its top edge,
    // easing to the garment's over 8 cm), as far as the fabric gives.
    const ease = Math.min(0, settings.ease), bandEase = settings.top !== 'neck' && !settings.over ? Math.min(0, settings.waistEase ?? settings.ease) : ease;
    const minScale = 1 / (1 + Math.max(0.02, material.give * 0.9));
    const cutPts = shell.cut ?? shell.points;
    const zTop = cutPts.reduce((m, p) => Math.max(m, p[2]), -Infinity);
    const uScale = (i: number, girth = shell.girth?.[i] ?? 0) => {
      const t = Math.min(1, Math.max(0, (zTop - cutPts[i][2]) / 0.08));
      const e = bandEase + (ease - bandEase) * t;
      return e < 0 && girth > 0 ? Math.max(minScale, 1 + e / girth) : 1;
    };
    // Measured round the part a panel covers, all of it: a body panel's
    // points by an armhole nearer the arm than the body, a sleeve's nearer
    // the body, took that part's girth, three times the ease's share, and the
    // panel scaled across from its middle jumped there (a stretch top's
    // underarm cut 8x longer than it was built: set in, the sleeve went
    // through the back). Each such point takes the girth of the nearest
    // point of the panel's own part.
    const panelGirths = (pts: number[]) => {
      const part = shell.part, girth = shell.girth;
      if (!part || !girth) return pts.map((g) => girth?.[g] ?? 0);
      const votes = new Map<string, number>();
      for (const g of pts) votes.set(part[g], (votes.get(part[g]) ?? 0) + 1);
      const own = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0];
      const mine = pts.filter((g) => part[g] === own);
      return pts.map((g) => {
        if (part[g] === own || !mine.length) return girth[g];
        let best = mine[0], bd = Infinity;
        for (const q of mine) { const d = (cutPts[q][0] - cutPts[g][0]) ** 2 + (cutPts[q][1] - cutPts[g][1]) ** 2 + (cutPts[q][2] - cutPts[g][2]) ** 2; if (d < bd) { bd = d; best = q; } }
        return girth[best];
      });
    };

    const panelSide: ('left' | 'right')[] = [];
    const standWidth = (trim: GarmentTrim) => trim.stand ?? 2.2 * (trim.size ?? TRIM_DEFAULTS.button.size);
    const shellNormals = vertexNormals(shell.points, shell.tris, world);
    const hostPanels: HostPanel[] = [], wornPanels: HostPanel[] = [];
    // Laid out as pieces, a spread piece's seam points sewn to the seam's nearest shell point, closing as the rest do.
    const spreadStitches: [number, number][] = [];
    const seamTackAt: { particle: number; group: number; a: number; b: number; t: number; offset: number; across: number }[] = [];
    const spreadRows = new Map<number, { ratio: number; row: [number, number][] }>();
    const flats = shell.panels.map((panel, k) => {
      const flat = flattenPanel(panel.name, shell.cut ?? shell.points, shell.tris, panel.tris, seamPaths, 15, panel.upAxis, panelEdgeEase(shell, sides, k));
      if (ease < 0 || bandEase < 0) {
        const girths = panelGirths(flat.points);
        for (let i = 0; i < flat.uv.length; i++) flat.uv[i] = [flat.uv[i][0] * uScale(flat.points[i], girths[i]), flat.uv[i][1]];
      }
      return flat;
    });
    // Gathered or pleated: spread along its seam and meshed afresh (garmentSpread), its new points new particles.
    // Where both sides of a seam are spread, the side laid over the other
    // (spreadOver) after it, clear of its layers along the seam (a gathered
    // skirt over the release tucks of its bodice).
    const spreads: (ReturnType<typeof spreadPanel>)[] = new Array(shell.panels.length).fill(null);
    const overs = shell.panels.map((_, k) => spreadOver(sides, k));
    shell.panels.forEach((_, k) => { if (!overs[k]) spreads[k] = spreadPanel(shell, k, flats[k], sides, material.thickness); });
    shell.panels.forEach((_, k) => {
      if (!overs[k]) return;
      const across = new Set(sides.find((sd) => sd.panel === k && sd.kind !== 'ease')!.across.values());
      const layers = [...across].flatMap((p) => spreads[p]?.seamLayers ?? []);
      // The panel across's layers within a couple of mesh steps along the seam: its folds' top layers and their turns.
      const reach = 2 * meshSpacing(flats[k]);
      const under = (q: number[]) => {
        let y = 0;
        for (const l of layers) if (l.y > y && Math.hypot(l.at[0] - q[0], l.at[1] - q[1], l.at[2] - q[2]) < reach) y = l.y;
        return y;
      };
      spreads[k] = spreadPanel(shell, k, flats[k], sides, material.thickness, under);
    });
    shell.panels.forEach((panel, k) => {
      const flat = flats[k], spread = spreads[k];
      let piece: FlatPiece = flat;
      if (spread) {
        const turn = new THREE.Vector3();
        const ids = spread.points.map((g, l) => {
          if (asPieces) return g;
          if (g >= 0) { if (spread.own[l]) x0[g] = toWorld(spread.start[l]); return g; }
          x0.push(toWorld(spread.start[l])); mass.push(0);
          shellNormals.push(turn.set(spread.normal[l][0], spread.normal[l][1], spread.normal[l][2]).transformDirection(world).toArray());
          return x0.length - 1;
        });
        piece = { ...flat, points: ids, uv: spread.uv, tris: spread.tris, outline: spread.outline };
      }
      let particleOf = (local: number) => piece.points[local];
      let facing = [0, -1, 0];
      if (!asPieces && openPoints.size) {
        const own = new Map<number, number>();
        piece.points.forEach((g, local) => {
          if (!openPoints.has(g)) return;
          if (claimed.get(g) === undefined) { claimed.set(g, k); openFirst.set(g, g); return; }
          const dup = openSecond.get(g) ?? x0.length;
          if (!openSecond.has(g)) { openSecond.set(g, dup); secondPanel.set(g, k); x0.push(x0[g].slice()); mass.push(0); }
          own.set(local, dup);
        });
        if (own.size) particleOf = (local: number) => own.get(local) ?? piece.points[local];
      }
      if (asPieces) {
        const base = x0.length;
        const centre = [0, 0, 0];
        for (const t of panel.tris) for (let q = 0; q < 3; q++) { const a = shell.points[shell.tris[3 * t + q]]; for (let c = 0; c < 3; c++) centre[c] += a[c] / (3 * panel.tris.length); }
        const nl = Math.hypot(centre[0], centre[1]);
        const n = nl > 0.02 ? [centre[0] / nl, centre[1] / nl, 0] : [0, -1, 0], right = [-n[1], n[0], 0];
        const along = centre[0] * n[0] + centre[1] * n[1] + PIECE_STAND_OFF;
        const zMean = piece.uv.reduce((acc, q) => acc + q[1], 0) / piece.uv.length;
        for (const [u, v] of piece.uv) x0.push(toWorld([n[0] * along + right[0] * u, n[1] * along + right[1] * u, Math.max(0.02, centre[2] + v - zMean)]));
        for (let i = 0; i < piece.uv.length; i++) {
          const g = piece.points[i];
          if (openPoints.has(g) && claimed.get(g) === undefined) claimed.set(g, k);
          mass.push(0);
          if (g >= 0) (copies.get(g) ?? copies.set(g, []).get(g)!).push(base + i);
        }
        particleOf = (local: number) => base + local;
        facing = new THREE.Vector3(n[0], n[1], n[2]).transformDirection(world).toArray();
      }
      hostPanels.push({ name: panel.name, uv: piece.uv, tris: piece.tris, particles: piece.points.map((_, i) => particleOf(i)), normal: asPieces ? () => facing : (l) => shellNormals[piece.points[l]] });
      wornPanels.push({ name: panel.name, uv: piece.uv, tris: piece.tris, particles: piece.points, normal: (l) => shellNormals[piece.points[l]] });
      for (let t = 0; t < piece.tris.length; t += 3) {
        const [i, j, l] = [piece.tris[t], piece.tris[t + 1], piece.tris[t + 2]];
        const [a, b, c] = [particleOf(i), particleOf(j), particleOf(l)];
        tris.push(a, b, c);
        panelOf.push(k);
        for (const [p, q] of [[i, j], [j, l], [l, i]]) edges.add(particleOf(p), particleOf(q), Math.hypot(piece.uv[p][0] - piece.uv[q][0], piece.uv[p][1] - piece.uv[q][1]));
        addMass(a, b, c, flatArea(piece.uv[i], piece.uv[j], piece.uv[l]));
      }
      // Eased cloth goes into its shorter seam evenly, its points shared: free to sit that much shorter than cut.
      if (piece.edgeEase) piece.edgeEase.forEach((e, c) => { if (e > 0) edges.setMinRatio(particleOf(piece.tris[c]), particleOf(piece.tris[c - (c % 3) + ((c + 1) % 3)]), 1 / (1 + e)); });
      if (material.bending) {
        const before = bends.quads.length / 4;
        const pressedRest = settings.pressed && !spread ? piece.points.map((g) => toWorld(shell.points[g])) : undefined;
        addBends(piece.tris, piece.uv, particleOf, bends, 1, pressedRest);
        // Gathered or pleated cloth keeps the set of its folds as sewn, as a seam
        // keeps its modelled curve (addSeamBends): resting flat, a spread piece
        // never came to rest (a woven skirt gathered 2x still moved 120 mm/s
        // after 5 s, its hem flapping; bending solved every pass, 170 mm/s; with
        // no bending it settled in folds), the one-pass bending fighting rigid
        // stretch wherever cloth is bent far from its rest. Laid out as pieces,
        // the same folds (as it would be worn).
        if (spread) {
          const localOf = new Map(piece.points.map((_, l) => [particleOf(l), l]));
          for (let q = before; q < bends.quads.length / 4; q++) {
            let vx = 0, vy = 0, vz = 0, kept = 0;
            for (let j = 0; j < 4; j++) { const l = localOf.get(bends.quads[4 * q + j])!, p = spread.start[l], kk = bends.weights[4 * q + j]; vx += kk * p[0]; vy += kk * p[1]; vz += kk * p[2]; kept += spread.set[l] / 4; }
            const mag = kept * Math.hypot(vx, vy, vz);
            bends.rest[q] = mag;
            if (mag > 1e-9) {
              const p0 = spread.start[localOf.get(bends.quads[4 * q])!], p1 = spread.start[localOf.get(bends.quads[4 * q + 1])!];
              const p2 = spread.start[localOf.get(bends.quads[4 * q + 2])!], p3 = spread.start[localOf.get(bends.quads[4 * q + 3])!];
              const e0x = p1[0] - p0[0], e0y = p1[1] - p0[1], e0z = p1[2] - p0[2];
              const d12x = p2[0] - p3[0], d12y = p2[1] - p3[1], d12z = p2[2] - p3[2];
              const hx = e0y * d12z - e0z * d12y, hy = e0z * d12x - e0x * d12z, hz = e0x * d12y - e0y * d12x;
              const dot = vx * hx + vy * hy + vz * hz;
              bends.sign[q] = Math.abs(dot) > 1e-18 ? (dot >= 0 ? 1 : -1) : 0;
            } else bends.sign[q] = 0;
          }
        }
      }
      addLimits(piece.tris, piece.uv, particleOf, limits);
      if (spread) {
        // Sewn into its seam: along it, crushed into the seam finer than the mesh; each point held to where it is sewn.
        for (const [a, b, ratio] of spread.crushed) edges.setMinRatio(particleOf(a), particleOf(b), ratio);
        if (asPieces) for (const st of spread.seamStitches) spreadStitches.push([particleOf(st.local), st.point]);
        else {
          for (const tk of spread.seamTacks) seamTackAt.push({ particle: particleOf(tk.local), group: k, a: tk.a, b: tk.b, t: tk.t, offset: tk.offset, across: tk.across });
          spreadRows.set(k, { ratio: spread.ratio, row: spread.seamRow.map(([a, b]) => [particleOf(a), particleOf(b)] as [number, number]) });
          for (const tk of spread.pressTacks) tacks.push({ particle: particleOf(tk.local), tri: [particleOf(tk.tri[0]), particleOf(tk.tri[1]), particleOf(tk.tri[2])], bary: tk.bary, offset: tk.offset });
        }
      }
      const trims: ClothTrim[] = [];
      // The wearer's side this panel is on (+x their left), for which front laps over at an opening.
      const side = piece.points.reduce((acc, g) => acc + (shell.points[g]?.[0] ?? 0), 0) > 0 ? 'left' : 'right';
      panelSide.push(side);
      const localOfG = new Map(piece.points.map((g, local) => [g, local]));
      // In the order they run along their lines, not the piece's points: a
      // zip's tape is drawn through its run's teeth in turn, and in point
      // order it zigzagged across the front and hung loose once undone.
      for (const pl of trimList) {
        const g = pl.point;
        if (!localOfG.has(g)) continue;
        const { trim } = pl;
        // A button on an opening: its hole on the front that laps over, the button on the other;
        // with a stand, both go on the stand (sewn on below).
        const buttoned = trim.kind === 'button' && openPoints.has(g);
        if (buttoned && !asPieces && standWidth(trim) > 0) continue;
        if (buttoned && side === (trim.lap ?? 'right')) {
          const tr = placedTrim(pl, (q) => localOfG.get(q), 'buttonhole', (trim.size ?? TRIM_DEFAULTS.button.size) * 1.15, TRIM_DEFAULTS.buttonhole.rgba);
          if (tr) trims.push(tr);
        } else {
          // One at a point once, on the first panel it is on: a point where
          // panels meet is on each of them (a cap's crown, on its six gores),
          // and each drew one, six buttons stacked askew.
          if (trim.at) { if (pointDrawn.has(pl)) continue; pointDrawn.add(pl); }
          if (pl.sideOf !== undefined && !localOfG.has(pl.sideOf)) continue;
          const tr = placedTrim(pl, (q) => localOfG.get(q));
          if (tr && trim.kind === 'zipper' && pl.along !== undefined) tr.zip = { trim: (settings.trims ?? []).indexOf(trim), at: pl.along };
          // A zip's slider once, on the first panel its tooth is on: an
          // opening's points are on both its sides, and each drew one.
          if (tr?.end) { if (sliderDrawn.has(pl)) delete tr.end; else sliderDrawn.add(pl); }
          if (tr) trims.push(tr);
        }
      }
      groups.push({
        name: `${name}__${panel.name}`, rgba: panel.name.startsWith('back') ? shade(colour, 0.85) : colour, material: materialName,
        particles: piece.points.map((_, i) => particleOf(i)), tris: piece.tris.slice(),
        flat: { uv: piece.uv.map(([u, v]) => [u, v]), outline: piece.outline.slice(), strain95: piece.strain95, marks: trims, ...(piece.darts ? { darts: piece.darts.map((l) => l.slice()) } : {}) },
        trims,
      });
    });
    // A spread piece hangs from the seam it is tacked to, whose points no
    // longer share its triangles' mass: half of each tacked point's mass is
    // carried on the seam, as a shared point's would be. Without, the slivers
    // along a seam (a few milligrams) took the skirt's pull and their edges
    // stood at twice their length.
    // Each held to the triangle across its seam edge, as meshed (the panel across may be spread too).
    const triOfEdge = new Map<string, [number, number, number][]>();
    for (let t = 0; t < tris.length; t += 3) for (let e = 0; e < 3; e++) {
      const a = tris[t + e], b = tris[t + ((e + 1) % 3)], kk = a < b ? `${a},${b}` : `${b},${a}`;
      (triOfEdge.get(kk) ?? triOfEdge.set(kk, []).get(kk)!).push([tris[t], tris[t + 1], tris[t + 2]]);
    }
    for (const st of seamTackAt) {
      const own = new Set(groups[st.group].particles);
      let tri = triOfEdge.get(st.a < st.b ? `${st.a},${st.b}` : `${st.b},${st.a}`)?.find((tr) => !tr.some((q) => own.has(q) && q !== st.a && q !== st.b));
      let bary = tri?.map((q) => (q === st.a ? 1 - st.t : q === st.b ? st.t : 0)) as [number, number, number] | undefined;
      // Fuller cloth both sides of one seam (release tucks above a gathered
      // skirt): the fuller is held to the other's points along the seam, the
      // nearest edge of them to where it is sewn; the other holds to nothing itself.
      const other = spreadRows.get(st.across);
      if (other) {
        if (other.ratio > spreadRows.get(st.group)!.ratio || (other.ratio === spreadRows.get(st.group)!.ratio && st.across < st.group)) continue;
        const at = [0, 1, 2].map((c) => (1 - st.t) * x0[st.a][c] + st.t * x0[st.b][c]);
        let best = Infinity;
        for (const [p, q] of other.row) {
          const d = [0, 1, 2].map((c) => x0[q][c] - x0[p][c]), l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2 || 1e-18;
          const u = Math.max(0, Math.min(1, ((at[0] - x0[p][0]) * d[0] + (at[1] - x0[p][1]) * d[1] + (at[2] - x0[p][2]) * d[2]) / l2));
          const gap = Math.hypot(at[0] - x0[p][0] - u * d[0], at[1] - x0[p][1] - u * d[1], at[2] - x0[p][2] - u * d[2]);
          const tr = triOfEdge.get(p < q ? `${p},${q}` : `${q},${p}`)?.[0];
          if (gap < best && tr) { best = gap; tri = tr; bary = tr.map((r) => (r === p ? 1 - u : r === q ? u : 0)) as [number, number, number]; }
        }
      }
      if (!tri || !bary) continue;
      // Held as far off it as it starts: the edge nearest may be any of the
      // other's layers there (a tuck's, one of them turned back under), and an
      // offset from the seam held it through the layers over that one.
      let offset = st.offset;
      if (other) {
        const [A, B, C] = tri.map((q) => x0[q]), P = x0[st.particle];
        const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
        const nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], nl = Math.hypot(nn[0], nn[1], nn[2]);
        if (nl > 1e-18) offset = [0, 1, 2].reduce((acc, c) => acc + (P[c] - (bary![0] * A[c] + bary![1] * B[c] + bary![2] * C[c])) * nn[c], 0) / nl;
      }
      const tk = { particle: st.particle, tri, bary, offset }, moved = mass[tk.particle] / 2;
      tacks.push(tk);
      mass[tk.particle] -= moved;
      for (let c = 0; c < 3; c++) mass[tk.tri[c]] += moved * tk.bary[c];
    }
    // Boning along its lines, resting as modelled; drawn on the pieces as channels.
    const rodRuns: number[][] = [];
    for (const rod of settings.rods ?? []) {
      for (const line of chainLineRuns([...shell.edges, ...shell.seams, ...(shell.marks ?? [])], rod.along)) {
        // Cut to its heights: the stretches of the line between them.
        const inside = (p: number) => !rod.z || (shell.points[p][2] >= rod.z[0] && shell.points[p][2] <= rod.z[1]);
        const pieces: { run: number[]; closed: boolean }[] = [];
        if (line.run.every(inside)) pieces.push(line);
        else {
          let cur: number[] = [];
          for (const p of line.run) { if (inside(p)) cur.push(p); else { if (cur.length > 1) pieces.push({ run: cur, closed: false }); cur = []; } }
          if (cur.length > 1) pieces.push({ run: cur, closed: false });
        }
        for (const { run, closed } of pieces) {
          const particles = run.map((p) => (asPieces ? copies.get(p)![0] : p));
          addRod(rods, particles, closed, (a, b) => edges.getLen(a, b) ?? Math.hypot(x0[a][0] - x0[b][0], x0[a][1] - x0[b][1], x0[a][2] - x0[b][2]), x0, rod, mass);
          rodRuns.push(closed ? [...particles, particles[0]] : particles);
        }
      }
    }
    if (rodRuns.length) for (const grp of groups) { const lines = rodLines(grp.particles, rodRuns); if (lines.length && grp.flat) grp.flat.lines = lines; }
    if (asPieces) {
      for (const [p, g] of spreadStitches) { const to = copies.get(g)?.[0]; if (to !== undefined) addStitch(p, to, sewTime); }
      for (const [g, list] of copies.entries()) {
        if (openPoints.has(g)) continue;
        for (let i = 1; i < list.length; i++) addStitch(list[i - 1], list[i], sewTime);
      }
    } else if (material.bending) {
      addSeamBends(x0, tris, bends, bends);
    }
    // Fastened buttons, buckles or a zip along an open seam hold the two sides together.
    // Each point a fastening sits at or between (a zip's teeth fall between the line's points).
    // Only where it is done up (a zip undone at the neck stands open there).
    // A zip's pairs, all along it, done up or not: shut and opened as the
    // scene runs, by its slider (ClothModel.zips); each point as far up as
    // the lowest tooth on it.
    const fastenAt = new Map<number, GarmentTrim>(), zipAt = new Map<GarmentTrim, Map<number, number>>();
    for (const pl of trimList) {
      if (pl.trim.kind === 'zipper') {
        const at = zipAt.get(pl.trim) ?? zipAt.set(pl.trim, new Map()).get(pl.trim)!, up = pl.along ?? 0;
        for (const g of pl.toward !== undefined ? [pl.point, pl.toward] : [pl.point]) at.set(g, Math.min(up, at.get(g) ?? Infinity));
        continue;
      }
      if (!pl.closed || (pl.trim.kind !== 'button' && pl.trim.kind !== 'buckle')) continue;
      fastenAt.set(pl.point, pl.trim);
    }
    const pairOf = (g: number): [number, number, number] | null => {
      if (!openPoints.has(g)) return null;
      if (asPieces) {
        const list = copies.get(g);
        return list && list.length >= 2 ? [list[0], list[1], sewTime] : null;
      }
      const p1 = openFirst.get(g), p2 = openSecond.get(g);
      return p1 !== undefined && p2 !== undefined && p1 !== p2 ? [p1, p2, 0] : null;
    };
    for (const [g] of fastenAt) { const pr = pairOf(g); if (pr) addStitch(pr[0], pr[1], pr[2]); }
    for (const [trim, at] of zipAt) {
      const z: ClothZip = { trim: (settings.trims ?? []).indexOf(trim), pairs: [], at: [], sew: [], fastened: doneUp(trim) };
      for (const [g, up] of [...at].sort((p, q) => p[1] - q[1])) {
        const pr = pairOf(g);
        if (pr) { z.pairs.push(pr[0], pr[1]); z.at.push(up); z.sew.push(pr[2]); }
      }
      if (z.at.length) zips.push(z);
    }
    // An opening left undone laps: the front that laps over (`lap`, default
    // the right) is started a fabric's thickness outside the other along it,
    // as the button stand's edge is. Both copies of a point started in one
    // place, the two fronts' edges lay in each other's surface, and the
    // first settle pushed each through the other wherever they met (28
    // crossings down a leather jacket's open zip). Where it is done up the
    // two are sewn shut edge to edge, and stay together.
    if (!asPieces) {
      const lap = (settings.trims ?? []).find((t) => t.lap)?.lap ?? 'right';
      for (const [g, dup] of openSecond) {
        if (fastenAt.has(g)) continue;
        const over = panelSide[claimed.get(g)!] === lap ? g : panelSide[secondPanel.get(g)!] === lap ? dup : -1, n = shellNormals[g];
        if (over < 0 || !n) continue;
        for (let c = 0; c < 3; c++) x0[over][c] += LAP_OFF * n[c];
      }
    }
    // Where an opening is not done up, its two sides start a hair apart, each
    // drawn into its own panel: copies of one point on top of each other met
    // at every look of continuous collision (clothCcd), which could not part
    // them and held the cloth round them still (a puffer's front, undone at
    // the neck).
    if (!asPieces) {
      const into = new Map<number, number[]>();
      for (const [g, p2] of openSecond) if (!fastenAt.has(g) && openFirst.has(g)) { into.set(g, [0, 0, 0]); into.set(p2, [0, 0, 0]); }
      if (into.size) {
        for (let t = 0; t < tris.length; t += 3) for (let q = 0; q < 3; q++) {
          const acc = into.get(tris[t + q]);
          if (!acc) continue;
          const p = x0[tris[t + q]];
          for (let c = 0; c < 3; c++) acc[c] += (x0[tris[t]][c] + x0[tris[t + 1]][c] + x0[tris[t + 2]][c]) / 3 - p[c];
        }
        for (const [p, acc] of into) {
          const l = Math.hypot(acc[0], acc[1], acc[2]);
          if (l > 1e-12) for (let c = 0; c < 3; c++) x0[p][c] += (acc[c] / l) * (OPEN_GAP / 2);
        }
      }
    }
    // Elastic in its casings along the garment's lines.
    for (const el of settings.elastics ?? []) for (const { run, closed } of chainLineRuns([...shell.edges, ...shell.seams, ...(shell.marks ?? [])], el.along)) addElasticRun(run, closed, el);
    // Sewn on: pockets on their panels; a belt round it and its loops.
    const spacing = spec.spacing ?? DEFAULT_CLOTH_SPACING;
    const addOns = pocketPieces(settings.pockets ?? [], hostPanels, x0, spacing, colour);
    const beltSpec: GarmentBelt | null = settings.belt ? (typeof settings.belt === 'object' ? settings.belt : {}) : null;
    const loopCount = settings.beltLoops === undefined ? (beltSpec ? 5 : 0) : typeof settings.beltLoops === 'number' ? Math.max(0, Math.round(settings.beltLoops)) : settings.beltLoops ? 5 : 0;
    if (beltSpec || loopCount) {
      // Where it runs is found on the garment as worn (in pieces, the loops are then sewn to their flat panels).
      const b = beltSpec ?? {};
      const along = b.at === undefined && settings.top !== 'neck' ? 'top' : null;
      const at = b.at ?? (along ? undefined : L.waistZ);
      const wornX = shell.points.map(toWorld);
      const wornNormal = (i: number) => shellNormals[i];
      const lines = along ? chainLineRuns([...shell.edges, ...shell.seams, ...(shell.marks ?? [])], along) : [];
      const paths = beltPaths({ ...b, at: at === undefined ? undefined : toWorld([0, 0, at])[2] }, b.width ?? 0.032, lines, shell.tris, (i) => shell.part?.[i] ?? 'skin', wornX, wornNormal);
      addOns.push(...beltPieces(b, loopCount, paths, shell.tris, wornPanels, hostPanels, x0, wornX, wornNormal, spacing, colour, !!beltSpec && !asPieces, addOns));
    }
    // Button stands: the lapping front run on over the other along a buttoned opening.
    if (!asPieces) {
      for (const trim of settings.trims ?? []) {
        if (trim.kind !== 'button' || !trim.along || standWidth(trim) <= 0) continue;
        const buttons = new Set(trimList.filter((t) => t.trim === trim).map((t) => t.point));
        for (const { run } of chainLineRuns(shell.seams.filter((sm) => sm.open), trim.along)) {
          const holders = hostPanels.map((_, k) => k).filter((k) => wornPanels[k].particles.includes(run[Math.floor(run.length / 2)]));
          const overK = holders.find((k) => panelSide[k] === (trim.lap ?? 'right')), underK = holders.find((k) => panelSide[k] !== (trim.lap ?? 'right'));
          if (overK === undefined || underK === undefined) continue;
          const stand = standPiece(`stand_${hostPanels[overK].name}`, run, hostPanels[overK], hostPanels[underK], wornPanels[overK].particles, wornPanels[underK].particles, standWidth(trim), buttons, { ...trim, size: trim.size ?? TRIM_DEFAULTS.button.size, rgba: trim.rgba ?? TRIM_DEFAULTS.button.rgba }, doneUp(trim) > 0, x0);
          if (stand) { stand.rgba = colour; addOns.push(stand); }
        }
      }
    }
    // Lapels turned back off the fronts' roll lines (on the front however it
    // lies: worn, or laid out flat as a piece), and a collar round the
    // neckline (worn only: its neck edge is the neckline's own points).
    if (settings.collar || (settings.lapels && settings.opening)) {
      // Modelled where the garment was cut (the shell lifted by its hang) and
      // let down with it after: on the hung neckline, lower on the back, a
      // collar wrapped the neck's flare into the shoulders and lay flat badly.
      const nShell = asPieces ? 0 : shell.points.length, hang = asPieces ? [] : shell.hang ?? [];
      const o0 = toWorld([0, 0, 0]), o1 = toWorld([0, 0, 1]), upW = [o1[0] - o0[0], o1[1] - o0[1], o1[2] - o0[2]];
      const liftW = (q: number[], h: number) => [q[0] + upW[0] * h, q[1] + upW[1] * h, q[2] + upW[2] * h];
      const xUp = x0.map((q, i) => (i < nShell ? liftW(q, hang[i] ?? 0) : q));
      const shellUp = shell.points.map((p, i) => [p[0], p[1], p[2] + (hang[i] ?? 0)]);
      const letDown = (pieces: AddOnPiece[]) => {
        for (const piece of pieces) {
          const withLoc = piece as AddOnPiece & { loc?: (i: number, j: number) => number };
          const rowsPerCol = withLoc.loc ? withLoc.loc(1, 0) - withLoc.loc(0, 0) : 0;
          if (rowsPerCol > 1 && piece.start.length % rowsPerCol === 0) {
            const mCols = piece.start.length / rowsPerCol;
            const out: number[][] = new Array(piece.start.length);
            for (let c = 0; c < mCols; c++) {
              const q0 = piece.start[c * rowsPerCol];
              let best = 0, bd = Infinity;
              for (let i = 0; i < nShell; i++) { const d = (xUp[i][0] - q0[0]) ** 2 + (xUp[i][1] - q0[1]) ** 2 + (xUp[i][2] - q0[2]) ** 2; if (d < bd) { bd = d; best = i; } }
              const h0 = hang[best] ?? 0;
              for (let r = 0; r < rowsPerCol; r++) out[c * rowsPerCol + r] = liftW(piece.start[c * rowsPerCol + r], -h0);
            }
            piece.start = out;
            continue;
          }
          piece.start = piece.start.map((q) => {
            let best = 0, bd = Infinity;
            for (let i = 0; i < nShell; i++) { const d = (xUp[i][0] - q[0]) ** 2 + (xUp[i][1] - q[1]) ** 2 + (xUp[i][2] - q[2]) ** 2; if (d < bd) { bd = d; best = i; } }
            return liftW(q, -(hang[best] ?? 0));
          });
        }
      };
      const lapels = settings.lapels && settings.opening ? lapelPieces(settings.lapels, chainLineRuns(shell.edges, 'roll').map((r) => r.run), hostPanels, wornPanels, xUp, spacing) : [];
      for (const l of lapels) { l.piece.rgba = colour; addOns.push(l.piece); }
      // A shawl's lapels run on round the neck as the collar, cut in one with the fronts.
      const shawl = lapels.length > 0 && !!settings.lapels?.shawl;
      if ((settings.collar || shawl) && !asPieces) {
        const inverse = world.clone().invert(), w = new THREE.Vector3();
        const ctx = {
          points: shellUp, tris: shell.tris, normals: vertexNormals(shellUp, shell.tris, new THREE.Matrix4()), form: form.bodyForm!,
          toWorld, fromWorld: (p: number[]) => { w.set(p[0], p[1], p[2]).applyMatrix4(inverse); return [w.x, w.y, w.z]; },
          x: xUp, worldNormal: (i: number) => shellNormals[i], spacing, lapels, colour, room: restOff(spec.layer ?? 0),
          panelPoints: (nm: string) => new Set(wornPanels.find((pn) => pn.name === nm)?.particles ?? []),
          panelUv: (nm: string, g: number) => { const pn = wornPanels.find((q) => q.name === nm), l = pn ? pn.particles.indexOf(g) : -1; return l >= 0 ? pn!.uv[l] : undefined; },
        };
        const necks = chainLineRuns(shell.edges, 'neckline');
        necks.forEach(({ run, closed }, k) => { const made = collarPieces(settings.collar ?? {}, run, closed, ctx, necks.length > 1 ? `${k + 1}` : '', shawl); letDown(made); addOns.push(...made); });
      }
      letDown(lapels.map((l) => l.piece));
    }
    // Cloth of any shape sewn on along its lines (worn: its sewn side is the line's own points).
    if (settings.attached?.length && !asPieces) {
      // The form as well as the garment to start clear of: hung past the garment's edge, a piece starts by the body.
      const formPts: number[][] = [], formTris: number[] = [];
      for (const g of bodyFormGeoms(form.bodyForm!, 'form')) {
        if (g.type !== 'mesh' || !g.vertices || !g.faces) continue;
        const base = formPts.length;
        for (let i = 0; i < g.vertices.length; i += 3) formPts.push(toWorld([g.vertices[i], -g.vertices[i + 2], g.vertices[i + 1]]));
        for (const f of g.faces) formTris.push(base + f);
      }
      const formNormals = vertexNormals(formPts, formTris, new THREE.Matrix4());
      const turns = new Map((spec.arrange ?? []).flatMap((a) => ('turn' in a ? [[a.piece, a.turn] as [string, number]] : [])));
      const attachWarnings: string[] = [];
      addOns.push(...attachedPieces(settings.attached, (along) => chainLineRuns([...shell.edges, ...shell.seams, ...(shell.marks ?? [])], along), x0, shell.tris, (i) => shellNormals[i], spacing, colour, addOns,
        [{ x: formPts, tris: formTris, normalOf: (i) => formNormals[i] }], turns, materialName, attachWarnings));
      if (attachWarnings.length) warnings.push(...attachWarnings);
    }
    overlayTrisStart = tris.length;
    // Which way each particle's cloth faces out, from the triangles placed so
    // far (the garment's, then each add-on's as it is placed): what a piece's
    // triangles with no tack of their own face as, from the nearest point of
    // it that is held to or shared with cloth already placed.
    const facesOut: number[][] = x0.map(() => [0, 0, 0]);
    const addFacing = (tri: number[]) => {
      const f = triNormal(x0, tri);
      for (const p of tri) { while (facesOut.length <= p) facesOut.push([0, 0, 0]); for (let c = 0; c < 3; c++) facesOut[p][c] += f[c]; }
    };
    for (let t = 0; t < tris.length; t += 3) addFacing([tris[t], tris[t + 1], tris[t + 2]]);
    const placed = new Map<string, (local: number) => number>();
    let anyShared = false;
    for (const piece of addOns) {
      // Its own points are new particles; its shared ones are particles already (the garment's, or an earlier add-on's).
      const base = x0.length;
      const sharedAt = new Map((piece.shared ?? []).map((sh) => [sh.local, sh.particle ?? placed.get(sh.piece!)!(sh.at!)]));
      const own = new Map<number, number>();
      piece.uv.forEach((_, i) => { if (!sharedAt.has(i)) own.set(i, base + own.size); });
      const particleOf = (local: number) => sharedAt.get(local) ?? own.get(local)!;
      placed.set(piece.name, particleOf);
      if (sharedAt.size) anyShared = true;
      // Tacked onto an earlier add-on (a belt over a pocket): its points, as particles now.
      piece.tacks = piece.tacks.map((tk) => { const on = tk.onPiece ? placed.get(tk.onPiece) : undefined; return on ? { ...tk, tri: [on(tk.tri[0]), on(tk.tri[1]), on(tk.tri[2])], onPiece: undefined } : tk; });
      const pm = resolveClothMaterial(CLOTH_MATERIALS[piece.material ?? materialName] ?? material, piece.materialOverrides);
      const stretch = (pm.young * pm.thickness) / (material.young * material.thickness), bend = clothBendRigidity(pm) / Math.max(1e-12, clothBendRigidity(material));
      if (clothBendRigidity(pm) >= BOARD_STIFFNESS) boards.push({ particles: piece.uv.map((_, i) => particleOf(i)), rest: piece.rest3 ?? piece.uv.map(([u, vv]) => [u * (piece.shrink ?? 1), vv]), tris: piece.tris, held: [...piece.tacks.map((tk) => tk.local), ...(piece.shared ?? []).map((sh) => sh.local)] });
      // Cut short of where it starts, if drawn in: its flat length is its rest.
      const uv = piece.uv.map(([u, vv]) => [u * (piece.shrink ?? 1), vv]);
      piece.start.forEach((q, i) => { if (own.has(i)) { x0.push(q); mass.push(0); } });
      const tackOf = new Map(piece.tacks.map((tk) => [tk.local, tk]));
      for (const st of piece.stitches ?? []) addStitch(particleOf(st.local), st.particle, st.sew ? sewTime : 0);
      for (const [i, j] of piece.selfStitches ?? []) addStitch(particleOf(i), particleOf(j), sewTime);
      if (piece.drop) piece.uv.forEach((_, i) => drop.push(particleOf(i)));
      // Where its cloth's outside is known: its tacks (the triangle each is
      // held over) and its points that are cloth already placed (a collar's
      // neck edge on the neckline, a fall's on its stand).
      const facing: { at: number[]; n: number[] }[] = piece.tacks.map((tk) => ({ at: x0[particleOf(tk.local)], n: triNormal(x0, tk.tri) }));
      for (const [, p] of sharedAt) { const f = facesOut[p], fl = f ? Math.hypot(f[0], f[1], f[2]) : 0; if (fl > 1e-9) facing.push({ at: x0[p], n: [f[0] / fl, f[1] / fl, f[2] / fl] }); }
      // Its triangles as wound for the solver, in its own points, to draw it
      // by: drawn as meshed, a button stand's faced the body, and its buttons,
      // set out along its normals, were drawn on its inside.
      // Oriented coherently across each manifold piece so grazing ~90 deg angles
      // (a horizontal cap visor sewn to a vertical crown band, or collar tips at
      // a gorge) never flip individual interior triangles into duplicate half-edges.
      const nTris = piece.tris.length / 3;
      const triDot = new Float64Array(nTris);
      let pieceAlign = 0;
      for (let t = 0; t < piece.tris.length; t += 3) {
        const [i, j, l] = [piece.tris[t], piece.tris[t + 1], piece.tris[t + 2]];
        const [pi, pj, pl] = [particleOf(i), particleOf(j), particleOf(l)];
        let n: number[];
        if (piece.facing) {
          const fi = piece.facing[i], fj = piece.facing[j], fl = piece.facing[l];
          const sx = fi[0] + fj[0] + fl[0], sy = fi[1] + fj[1] + fl[1], sz = fi[2] + fj[2] + fl[2];
          const sl = Math.hypot(sx, sy, sz) || 1;
          n = [sx / sl, sy / sl, sz / sl];
        } else {
          const tk = tackOf.get(i) ?? tackOf.get(j) ?? tackOf.get(l);
          n = tk ? triNormal(x0, tk.tri) : [0, 0, 0];
          if (!tk && facing.length) {
            const c = [0, 1, 2].map((k) => (x0[pi][k] + x0[pj][k] + x0[pl][k]) / 3);
            let bd = Infinity;
            for (const f of facing) { const d = (f.at[0] - c[0]) ** 2 + (f.at[1] - c[1]) ** 2 + (f.at[2] - c[2]) ** 2; if (d < bd) { bd = d; n = f.n; } }
          }
        }
        const ux = x0[pj][0] - x0[pi][0], uy = x0[pj][1] - x0[pi][1], uz = x0[pj][2] - x0[pi][2];
        const vx = x0[pl][0] - x0[pi][0], vy = x0[pl][1] - x0[pi][1], vz = x0[pl][2] - x0[pi][2];
        const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vz;
        const fl = Math.hypot(fx, fy, fz);
        const wDot = fx * n[0] + fy * n[1] + fz * n[2];
        pieceAlign += wDot;
        triDot[t / 3] = fl > 1e-12 ? wDot / fl : 0;
      }
      const flipPiece = pieceAlign < 0;
      const host = piece.joinPanel ? groups.find((gr) => gr.name === `${name}__${piece.joinPanel}`) : undefined;
      let flipRender = flipPiece;
      if (host) {
        const hostHalf = new Set<string>();
        for (let t = 0; t < host.tris.length; t += 3) {
          const hp = [host.particles[host.tris[t]], host.particles[host.tris[t + 1]], host.particles[host.tris[t + 2]]];
          for (let e = 0; e < 3; e++) hostHalf.add(`${hp[e]}->${hp[(e + 1) % 3]}`);
        }
        let sameDir = 0, oppDir = 0;
        for (let t = 0; t < piece.tris.length; t += 3) {
          const pp = [particleOf(piece.tris[t]), particleOf(piece.tris[t + 1]), particleOf(piece.tris[t + 2])];
          for (let e = 0; e < 3; e++) {
            const a = pp[e], b = pp[(e + 1) % 3];
            if (hostHalf.has(`${a}->${b}`)) sameDir++;
            if (hostHalf.has(`${b}->${a}`)) oppDir++;
          }
        }
        if (sameDir + oppDir > 0) flipRender = sameDir > oppDir;
      }
      const wound: number[] = [];
      for (let t = 0; t < piece.tris.length; t += 3) {
        const [i, j, l] = [piece.tris[t], piece.tris[t + 1], piece.tris[t + 2]];
        const [pi, pj, pl] = [particleOf(i), particleOf(j), particleOf(l)];
        const flipSolver = piece.facing ? flipPiece : triDot[t / 3] < 0;
        if (flipSolver) tris.push(pi, pl, pj); else tris.push(pi, pj, pl);
        if (flipRender) wound.push(i, l, j); else wound.push(i, j, l);
        addFacing(tris.slice(-3));
        for (const [a, c] of [[i, j], [j, l], [l, i]]) edges.add(particleOf(a), particleOf(c), Math.hypot(uv[a][0] - uv[c][0], uv[a][1] - uv[c][1]), stretch);
        const m = (pm.arealDensity * flatArea(uv[i], uv[j], uv[l])) / 3;
        mass[pi] += m; mass[pj] += m; mass[pl] += m;
      }
      if (material.bending) addBends(piece.tris, uv, particleOf, bends, bend, piece.pressed ? piece.start.map((q, i) => (sharedAt.has(i) ? x0[particleOf(i)] : q)) : piece.rest3);
      // Across the seam where it is tacked on: bending from its first row of
      // triangles into the cloth under it, at its own stiffness, resting at
      // the angle it starts at, for a piece whose shape is set (pressed, cut
      // to a curve, or a board). Tacked points alone hinge freely, and a stiff
      // piece (a cap's peak) folded down at its seam however stiff it was.
      // Soft cloth sewn on hinges at its seam as a seam does: held to the
      // angle it started at, a hood pulled down off the head climbed back up
      // over it once let go.
      const setShape = piece.pressed || !!piece.rest3 || clothBendRigidity(pm) >= BOARD_STIFFNESS;
      if (material.bending && piece.tacks.length && setShape) {
        for (let t = 0; t < piece.tris.length; t += 3) for (let e = 0; e < 3; e++) {
          const a = piece.tris[t + e], b = piece.tris[t + ((e + 1) % 3)], o = piece.tris[t + ((e + 2) % 3)];
          const ta = tackOf.get(a), tb = tackOf.get(b);
          if (!ta || !tb || ta.lift || tb.lift || tackOf.has(o)) continue;
          // The host's point under the seam furthest from it, on the far side from the piece.
          const pa = piece.start[a], pb = piece.start[b], ab = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], l2 = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
          if (l2 < 1e-12) continue;
          const offLine = (q: number[]) => { const r = [q[0] - pa[0], q[1] - pa[1], q[2] - pa[2]], k = (r[0] * ab[0] + r[1] * ab[1] + r[2] * ab[2]) / l2; return Math.hypot(r[0] - k * ab[0], r[1] - k * ab[1], r[2] - k * ab[2]); };
          const host = [...ta.tri, ...tb.tri].reduce((best, h) => (offLine(x0[h]) > offLine(x0[best]) ? h : best), ta.tri[0]);
          if (offLine(x0[host]) < 1e-4) continue;
          addStencil([particleOf(a), particleOf(b), particleOf(o), host], [pa, pb, piece.start[o], x0[host]], bends, bend);
        }
      }
      addLimits(piece.tris, uv, particleOf, limits);
      for (const tk of piece.tacks) tacks.push({ particle: particleOf(tk.local), tri: tk.tri, bary: tk.bary, offset: tk.offset, lift: tk.lift });
      // Drawn in, it gathers the cloth under it, which bunches rather than squeezes (as under an elastic).
      if (piece.shrink && piece.shrink < 1) for (const tk of piece.tacks) for (let e = 0; e < 3; e++) edges.setMinRatio(tk.tri[e], tk.tri[(e + 1) % 3], piece.shrink);
      const trims: ClothTrim[] = (piece.trims ?? []).map(({ trim, local }) => ({ kind: trim.kind, particle: local, size: trim.size ?? TRIM_DEFAULTS[trim.kind].size, rgba: trim.rgba ?? TRIM_DEFAULTS[trim.kind].rgba }));
      if (host && joinGroup(host, { ...piece, tris: wound }, particleOf)) continue;
      groups.push({
        name: `${name}__${piece.name}`, rgba: piece.rgba, material: piece.material ?? materialName,
        particles: piece.uv.map((_, i) => particleOf(i)), tris: wound,
        flat: { uv: uv.map(([u, vv]) => [u, vv]), outline: piece.outline.slice(), strain95: piece.strain95 ?? 0, marks: trims },
        ...(trims.length ? { trims } : {}),
        ...(piece.pattern ? { pattern: piece.pattern } : {}),
      });
    }
    // Where an add-on runs on from the garment through shared points (a lapel
    // off its roll line, a collar off the neckline), the cloth bends there as
    // it starts: pressed.
    // Pieces sewn to each other, now all are placed.
    for (const piece of addOns) for (const j of piece.joinTo ?? []) {
      const a = placed.get(piece.name), b = placed.get(j.piece);
      if (a && b) addStitch(a(j.local), b(j.at), sewTime);
    }
    if (anyShared && material.bending) addSeamBends(x0, tris, bends, bends);
    warnings.push(...garmentNameWarnings(settings, spec,
      [...shell.edges, ...shell.seams, ...(shell.marks ?? [])].map((l) => l.name),
      shell.seams.filter((sm) => !sm.open).map((sm) => sm.name),
      shell.panels.map((p) => p.name),
      groups.map((g) => g.name.slice(name.length + 2))));
  }

  if (spec.pieces?.length) {
    const mesh = meshCloth(spec);
    const base: Record<string, number> = {};
    for (const p of spec.pieces) {
      const m = mesh.pieces[p.name];
      base[p.name] = x0.length;
      const off = base[p.name], particleOf = (local: number) => off + local;
      const pm = CLOTH_MATERIALS[p.material ?? materialName] ?? material, k = p.stiffnessScale ?? 1;
      const stretch = (k * pm.young * pm.thickness) / (material.young * material.thickness), bend = (k * clothBendRigidity(pm)) / Math.max(1e-12, clothBendRigidity(material));
      for (const q of m.start) { x0.push(toWorld(q)); mass.push(0); }
      for (let t = 0; t < m.tris.length; t += 3) {
        const [i, j, l] = [m.tris[t], m.tris[t + 1], m.tris[t + 2]];
        tris.push(off + i, off + j, off + l);
        for (const [a, b] of [[i, j], [j, l], [l, i]]) edges.add(off + a, off + b, Math.hypot(m.uv[a][0] - m.uv[b][0], m.uv[a][1] - m.uv[b][1]), stretch);
        const mm = (pm.arealDensity * flatArea(m.uv[i], m.uv[j], m.uv[l])) / 3;
        mass[off + i] += mm; mass[off + j] += mm; mass[off + l] += mm;
      }
      if (material.bending) addBends(m.tris, m.uv, particleOf, bends, bend);
      addLimits(m.tris, m.uv, particleOf, limits);
      const edgeLines = Object.entries(m.edgeVerts).map(([ename, path]) => ({ name: ename, path }));
      const trims: ClothTrim[] = p.trims?.length
        ? trimPoints(m.start, edgeLines, p.trims, m.tris).flatMap((pl) => placedTrim(pl, (q) => q) ?? [])
        : [];
      groups.push({
        name: `${name}__${p.name}`, rgba: p.rgba ?? [0.25, 0.5, 0.85, 1], material: p.material ?? materialName,
        particles: m.uv.map((_, i) => off + i), tris: m.tris.slice(),
        // Its flat shape, for a print's coordinates and the pattern.
        flat: { uv: m.uv.map(([u, vv]) => [u, vv]), outline: Object.values(m.edgeVerts).flatMap((ev) => ev.slice(0, -1)), strain95: 0, ...(trims.length ? { marks: trims } : {}) },
        ...(trims.length ? { trims } : {}),
        // Only a piece's own print rides on its group; the cloth's is read from the node.
        ...(p.pattern ? { pattern: p.pattern } : {}),
      });
    }
    for (const s of mesh.stitches) addStitch(base[s.a[0]] + s.a[1], base[s.b[0]] + s.b[1], sewTime);
    for (const el of spec.elastics ?? []) {
      const ch = chain(Array.isArray(el.along) ? el.along : [el.along], mesh.pieces);
      const run = ch.map((pt) => base[pt.piece] + pt.id);
      const closed = run.length > 2 && run[0] === run[run.length - 1];
      addElasticRun(closed ? run.slice(0, -1) : run, closed, el);
    }
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
  const [edgePairs, edgeRest, edgeMin] = edges.flat();
  const [limitPairs, limitRest] = limits.flat();
  const x = new Float64Array(x0.length * 3);
  x0.forEach((p, i) => { x[3 * i] = p[0]; x[3 * i + 1] = p[1]; x[3 * i + 2] = p[2]; });
  // A point of it by its piece and where on the piece's flat pattern: the group, its point there.
  const pointOf = (pt: { piece: string; at: [number, number] }): { group: ClothRenderGroup; local: number } | null => {
    const grp = groups.find((g) => g.name === `${name}__${pt.piece}`);
    if (!grp?.flat) return null;
    let best = -1, bd = Infinity;
    grp.flat.uv.forEach((q, k) => { const d = (q[0] - pt.at[0]) ** 2 + (q[1] - pt.at[1]) ** 2; if (d < bd) { bd = d; best = k; } });
    return best >= 0 ? { group: grp, local: best } : null;
  };
  // Fastened: each pair held together, drawn closed over the sew time; what fastens them drawn on the first.
  for (const fa of spec.fasten ?? []) {
    const a = pointOf(fa.a), b = pointOf(fa.b);
    if (!a || !b) continue;
    const pa = a.group.particles[a.local], pb = b.group.particles[b.local];
    addStitch(pa, pb, sewTime);
    if (!fa.trim) continue;
    // On the face away from what it fastens to (a clasp on the outside of a
    // flap): where that is as they start, against the way the first point's
    // cloth faces as drawn (a plain piece's winding says nothing of outside).
    const nrm = [0, 0, 0];
    for (let t = 0; t < tris.length; t += 3) {
      if (tris[t] !== pa && tris[t + 1] !== pa && tris[t + 2] !== pa) continue;
      const [i, j, k] = [tris[t], tris[t + 1], tris[t + 2]].map((q) => 3 * q);
      const u = [x[j] - x[i], x[j + 1] - x[i + 1], x[j + 2] - x[i + 2]], v = [x[k] - x[i], x[k + 1] - x[i + 1], x[k + 2] - x[i + 2]];
      nrm[0] += u[1] * v[2] - u[2] * v[1]; nrm[1] += u[2] * v[0] - u[0] * v[2]; nrm[2] += u[0] * v[1] - u[1] * v[0];
    }
    const toward = (x[3 * pb] - x[3 * pa]) * nrm[0] + (x[3 * pb + 1] - x[3 * pa + 1]) * nrm[1] + (x[3 * pb + 2] - x[3 * pa + 2]) * nrm[2];
    (a.group.trims ??= []).push({ kind: fa.trim.kind, particle: a.local, size: fa.trim.size ?? TRIM_DEFAULTS[fa.trim.kind].size, rgba: fa.trim.rgba ?? TRIM_DEFAULTS[fa.trim.kind].rgba, ...(toward > 0 ? { flip: true } : {}) });
  }
  // Its arrangement: each pull's point found on its piece's flat pattern.
  const pulls: { particle: number; to: number[]; via?: number[][] }[] = [];
  for (const pl of spec.arrange ?? []) {
    if (!('at' in pl)) continue;
    const pt = pointOf(pl);
    if (pt) pulls.push({ particle: pt.group.particles[pt.local], to: toWorld(pl.to), ...(pl.via?.length ? { via: pl.via.map(toWorld) } : {}) });
  }
  if (!fitTo && ties.length) {
    const findFitTo = (list: SceneNode[], target: string): string | undefined => {
      for (const sn of list) {
        if ((sn.name || sn.id) === target && sn.cloth?.garment?.fitTo) return sn.cloth.garment.fitTo;
        const sub = sn.children?.length ? findFitTo(sn.children, target) : undefined;
        if (sub) return sub;
      }
      return undefined;
    };
    for (const t of ties) {
      if (t.cloth) { fitTo = findFitTo(scene, t.cloth); if (fitTo) break; }
    }
  }
  return {
    name, ...(drop.length ? { drop } : {}), ...(pulls.length ? { pulls } : {}), material, layer: spec.layer ?? 0,
    ...(fitTo ? { fitTo } : {}), ...(loose ? { loose: true } : {}), ...(garmentParts?.length ? { parts: garmentParts } : {}),
    outward: !!spec.garment, selfCollide: spec.selfCollide !== false, sewTime,
    x0: x, invMass: Float64Array.from(mass, (m) => (m > 0 ? 1 / m : 0)),
    tris, overlayTrisStart, edges: edgePairs, edgeRest, edgeMin, edgeStiffness: edges.scales(),
    elastics, elasticRest, elasticFlat, elasticAlpha,
    bends: bends.quads, bendWeights: bends.weights, bendArea: bends.area, bendRest: bends.rest, bendSign: bends.sign, bendStiffness: bends.scale,
    limits: limitPairs, limitRest,
    stitches, stitchSew, ...(zips.length ? { zips } : {}), tacks, ties, groups, ...(boards.length ? { boards } : {}),
    ...(rods.links.length ? { rods } : {}),
    ...(warnings.length ? { warnings } : {}),
  };
}
