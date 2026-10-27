// ---------------------------------------------------------------------------
// Sheet Unfold, folded back up: the net as exported, bent along its own lines
// ---------------------------------------------------------------------------
//
// The unfold hands over a flat net: each face's outline on the sheet, the fold
// lines between faces with their angle, and in sheet metal a bend zone as wide
// as the allowance the file worked out. This folds that net back up the way a
// press brake would, from the file alone, and sets it against the model.
//
// A bend is made at the brake's radius R in metal of thickness T, whose neutral
// layer sits K·T in from the inside of the bend. The bent arc is the neutral
// length R + K·T times the angle, centred on the bend line drawn in the file;
// whatever of the drawn zone is left over either side stays flat. So a zone the
// file drew too wide or too narrow, or faces it left too long, come out as a
// flange standing off the model, not as a quietly corrected part.
//
// The model's surface is taken as the outside of the part, the sheet lying
// behind it: a solid box is the box's outside size. A papercraft or soft-goods
// net folds on a hinge with no radius.
//
// Then the folded part is fitted to the model (rotation from the faces' normals
// and edge directions, position from their planes and the cut edges' lines,
// none of which a bend's setback moves) and measured: how far each model corner
// lies off its folded face's plane, and how far each cut edge lies off its
// folded line. A correct net measures nothing but rounding.

import { runSheetJob, type SheetPart } from './sheetSimulation';
import { enclosedVolume } from './simulationMesh';
import type { Point2D, SheetUnfoldOptions, SheetUnfoldResult, UnfoldIsland } from './sheetUnfoldExporter';
import type { StockTransform } from './reliefCarveExporter';
import type { AddSimulationRequest } from '../hooks/useAddSimulation';

type V3 = [number, number, number];

/** A rigid map from the sheet (x, y on it, z out of the model side) into the folded part, mm. */
interface Frame {
  /** Row-major 3 × 3. */
  r: number[];
  t: V3;
}

export interface SheetFoldResult {
  /** The folded part, mm, Z up, in the model's frame at the net's scale. */
  positions: Float32Array;
  faces: Uint32Array;
  volumeMm3: number;
  islands: number;
  folds: number;
  /** How far the folded part lies off the model, mm, once fitted to it. */
  deviation: { maxMm: number; meanMm: number };
  /** The island and face where it is worst. */
  worst?: { island: string; faceIndex: number };
  /** The sheet thickness drawn, mm. */
  drawnThicknessMm: number;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => scale(a, 1 / (Math.hypot(...a) || 1));
const mulV = (r: number[], v: V3): V3 => [
  r[0] * v[0] + r[1] * v[1] + r[2] * v[2],
  r[3] * v[0] + r[4] * v[1] + r[5] * v[2],
  r[6] * v[0] + r[7] * v[1] + r[8] * v[2],
];
const mulM = (a: number[], b: number[]) => {
  const out = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += a[i * 3 + k] * b[k * 3 + j];
  return out;
};
const apply = (f: Frame, p: V3): V3 => add(mulV(f.r, p), f.t);
const compose = (a: Frame, b: Frame): Frame => ({ r: mulM(a.r, b.r), t: apply(a, b.t) });
const IDENTITY: Frame = { r: [1, 0, 0, 0, 1, 0, 0, 0, 1], t: [0, 0, 0] };
const on = (p: Point2D, z = 0): V3 => [p.x, p.y, z];

/** Turn by `angle` about the line through `at` along unit `axis` (right hand). */
function turnAbout(at: V3, axis: V3, angle: number): Frame {
  const [x, y, z] = axis;
  const c = Math.cos(angle), s = Math.sin(angle), k = 1 - c;
  const r = [
    c + x * x * k, x * y * k - z * s, x * z * k + y * s,
    y * x * k + z * s, c + y * y * k, y * z * k - x * s,
    z * x * k - y * s, z * y * k + x * s, c + z * z * k,
  ];
  return { r, t: sub(at, mulV(r, at)) };
}

/** Newell's normal of a 3D polygon. */
function polygonNormal(pts: V3[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm(n);
}

/**
 * The rotation taking each of `from` closest onto the matching `to`, weighted
 * (Horn's quaternion method, the 4 × 4 eigenproblem solved by Jacobi).
 */
function bestRotation(from: V3[], to: V3[], w: number[]): number[] {
  const s = new Array(9).fill(0);
  from.forEach((a, n) => {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) s[i * 3 + j] += w[n] * a[i] * to[n][j];
  });
  const [sxx, sxy, sxz, syx, syy, syz, szx, szy, szz] = s;
  const m = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ];
  const v = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) off += m[p][q] * m[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 4; p++) {
      for (let q = p + 1; q < 4; q++) {
        if (Math.abs(m[p][q]) < 1e-30) continue;
        const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1), sn = t * c;
        for (let k = 0; k < 4; k++) {
          const mkp = m[k][p], mkq = m[k][q];
          m[k][p] = c * mkp - sn * mkq;
          m[k][q] = sn * mkp + c * mkq;
        }
        for (let k = 0; k < 4; k++) {
          const mpk = m[p][k], mqk = m[q][k];
          m[p][k] = c * mpk - sn * mqk;
          m[q][k] = sn * mpk + c * mqk;
        }
        for (let k = 0; k < 4; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - sn * vkq;
          v[k][q] = sn * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 4; i++) if (m[i][i] > m[best][best]) best = i;
  const [qw, qx, qy, qz] = [v[0][best], v[1][best], v[2][best], v[3][best]];
  return [
    qw * qw + qx * qx - qy * qy - qz * qz, 2 * (qx * qy - qw * qz), 2 * (qx * qz + qw * qy),
    2 * (qx * qy + qw * qz), qw * qw - qx * qx + qy * qy - qz * qz, 2 * (qy * qz - qw * qx),
    2 * (qx * qz - qw * qy), 2 * (qy * qz + qw * qx), qw * qw - qx * qx - qy * qy + qz * qz,
  ];
}

/** Solve a 3 × 3 system (row-major), or null when it is singular. */
function solve3(a: number[], b: V3): V3 | null {
  const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
  if (Math.abs(det) < 1e-18) return null;
  const col = (i: number, v: V3) => { const m = [...a]; m[i] = v[0]; m[3 + i] = v[1]; m[6 + i] = v[2]; return m; };
  const d = (m: number[]) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  return [d(col(0, b)) / det, d(col(1, b)) / det, d(col(2, b)) / det];
}

/** A closed piece with its winding taken from its own volume: built either way, it comes out outward. */
function pushPiece(positions: number[], faces: number[], pts: V3[], tris: number[]) {
  const base = positions.length / 3;
  for (const p of pts) positions.push(p[0], p[1], p[2]);
  const v = enclosedVolume(pts.flat(), tris);
  for (let i = 0; i < tris.length; i += 3) {
    if (v >= 0) faces.push(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
    else faces.push(base + tris[i], base + tris[i + 2], base + tris[i + 1]);
  }
}

/** A box-section strip swept round a bend: `rows` sections of four corners, closed at both ends. */
function sweptStrip(sections: V3[][]): { pts: V3[]; tris: number[] } {
  const pts = sections.flat();
  const tris: number[] = [];
  for (let k = 0; k + 1 < sections.length; k++) {
    for (let c = 0; c < 4; c++) {
      const a = k * 4 + c, b = k * 4 + ((c + 1) % 4), d = (k + 1) * 4 + c, e = (k + 1) * 4 + ((c + 1) % 4);
      tris.push(a, b, e, a, e, d);
    }
  }
  const last = (sections.length - 1) * 4;
  tris.push(0, 2, 1, 0, 3, 2, last, last + 1, last + 2, last, last + 2, last + 3);
  return { pts, tris };
}

const nearly = (a: Point2D, b: Point2D, eps = 1e-3) => Math.hypot(a.x - b.x, a.y - b.y) <= eps;

/** Paper and cloth have a thickness to draw, not one to fold with. */
const DRAWN_THICKNESS_MM = { papercraft: 0.3, soft_goods: 1, sheet_metal: 0 };

/**
 * Fold every island of an unfold back up and measure it against the model.
 * `options` are the ones the net was made with: the bend radius, the K-factor
 * and the thickness are what the brake is set to, and the file says nothing
 * else about them.
 */
export function foldSheetUnfold(
  result: Pick<SheetUnfoldResult, 'islands' | 'mode'>,
  options: Pick<SheetUnfoldOptions, 'thicknessMm' | 'bendRadiusMm' | 'kFactor'>
): SheetFoldResult {
  const metal = result.mode === 'sheet_metal';
  const T = metal ? Math.max(0, options.thicknessMm) : 0;
  const R = metal ? Math.max(0, options.bendRadiusMm) : 0;
  const K = metal ? Math.max(0, options.kFactor) : 0;
  const drawnT = metal ? Math.max(0.05, T) : DRAWN_THICKNESS_MM[result.mode];

  const positions: number[] = [];
  const faces: number[] = [];
  const devs: number[] = [];
  let worst = { d: -1, island: '', faceIndex: -1 };
  let folds = 0;

  for (const island of result.islands) {
    if (!island.faces.length) continue;
    const islandStart = positions.length / 3;
    const byIndex = new Map(island.faces.map((f) => [f.faceIndex, f]));
    const frames = new Map<number, Frame>();
    const root = island.faces[0].faceIndex;
    frames.set(root, IDENTITY);

    // Every hinge of the net: the folds the file draws, and faces lying flat
    // against each other along a shared edge, which it does not.
    type Hinge = { a: number; b: number; fold?: UnfoldIsland['foldEdges'][number] };
    const hinges: Hinge[] = island.foldEdges.map((fe) => ({ a: fe.faceA, b: fe.faceB, fold: fe }));
    for (let i = 0; i < island.faces.length; i++) {
      for (let j = i + 1; j < island.faces.length; j++) {
        const fa = island.faces[i], fb = island.faces[j];
        const shares = fa.polygon2D.some((p, k) => {
          const q = fa.polygon2D[(k + 1) % fa.polygon2D.length];
          return fb.polygon2D.some((r, m) => nearly(r, q) && nearly(fb.polygon2D[(m + 1) % fb.polygon2D.length], p));
        });
        if (shares) hinges.push({ a: fa.faceIndex, b: fb.faceIndex });
      }
    }

    // Bends to draw once both sides are placed: the arc and the flat left over.
    const bends: { fold: UnfoldIsland['foldEdges'][number]; parent: number; child: number; o: V3; L: number; axis: V3; turn: number }[] = [];
    const queue = [root];
    while (queue.length) {
      const parent = queue.shift()!;
      for (const h of hinges) {
        const child = h.a === parent ? h.b : h.b === parent ? h.a : -1;
        if (child < 0 || frames.has(child) || !byIndex.has(child)) continue;
        const pf = frames.get(parent)!;
        if (!h.fold) {
          frames.set(child, pf);
          queue.push(child);
          continue;
        }
        const fe = h.fold;
        const c = on(fe.p1);
        const e = norm(sub(on(fe.p2), c));
        // Across the line towards the child.
        let o: V3 = [-e[1], e[0], 0];
        if (dot(sub(on(byIndex.get(child)!.centroid2D), c), o) < 0) o = scale(o, -1);
        const alpha = Math.abs(fe.angleDeg) * Math.PI / 180;
        const mountain = fe.angleDeg >= 0;
        // The arc's length on the neutral layer, centred on the bend line.
        const L = (R + K * T) * alpha;
        // The bend's axis, R in from the inside of the sheet: under it for a
        // mountain (the child goes down, away from the model side), over it for a valley.
        const axisPt = add(add(c, scale(o, -L / 2)), [0, 0, mountain ? -T - R : R]);
        const turnAxis = cross(o, [0, 0, 1]);
        // A positive turn about o x n carries o towards n: a valley.
        const turn = mountain ? -alpha : alpha;
        const bend = compose(turnAbout(axisPt, norm(turnAxis), turn), { r: IDENTITY.r, t: scale(o, -L) });
        frames.set(child, compose(pf, bend));
        bends.push({ fold: fe, parent, child, o, L, axis: axisPt, turn });
        folds++;
        queue.push(child);
      }
    }

    // The faces, each a slab behind the model side.
    const parts: SheetPart[] = [];
    for (const f of island.faces) {
      const fr = frames.get(f.faceIndex);
      if (!fr || f.polygon2D.length < 3) continue;
      parts.push({
        loops: [f.polygon2D],
        origin: fr.t,
        u: mulV(fr.r, [1, 0, 0]),
        v: mulV(fr.r, [0, 1, 0]),
        zFrom: -drawnT,
        zTo: 0,
      });
    }
    // Each bend: what of the drawn zone stays flat either side, and the arc.
    for (const b of bends) {
      const zone = b.fold.bendZonePolygon2D;
      if (!zone || !metal) continue;
      const c = on(b.fold.p1);
      const e = norm(sub(on(b.fold.p2), c));
      const len = Math.hypot(b.fold.p2.x - b.fold.p1.x, b.fold.p2.y - b.fold.p1.y);
      const half = Math.max(...zone.map((p) => Math.abs(dot(sub(on(p), c), b.o))));
      const strip = (from: number, to: number, frame: Frame) => {
        if (to - from < 1e-3) return;
        const corner = (s: number, t: number): Point2D => {
          const p = add(add(c, scale(b.o, s)), scale(e, t));
          return { x: p[0], y: p[1] };
        };
        parts.push({
          loops: [[corner(from, 0), corner(to, 0), corner(to, len), corner(from, len)]],
          origin: frame.t,
          u: mulV(frame.r, [1, 0, 0]),
          v: mulV(frame.r, [0, 1, 0]),
          zFrom: -drawnT,
          zTo: 0,
        });
      };
      strip(-half, -b.L / 2, frames.get(b.parent)!);
      strip(b.L / 2, half, frames.get(b.child)!);
      if (b.L > 1e-6) {
        const pf = frames.get(b.parent)!;
        const steps = Math.max(4, Math.ceil(Math.abs(b.turn) / (Math.PI / 24)));
        const start = add(c, scale(b.o, -b.L / 2));
        const sections: V3[][] = [];
        for (let k = 0; k <= steps; k++) {
          const turn = turnAbout(b.axis, norm(cross(b.o, [0, 0, 1])), (b.turn * k) / steps);
          const at = (t: number, z: number) => apply(pf, apply(turn, add(add(start, scale(e, t)), [0, 0, z])));
          sections.push([at(0, 0), at(len, 0), at(len, -drawnT), at(0, -drawnT)]);
        }
        const { pts, tris } = sweptStrip(sections);
        pushPiece(positions, faces, pts, tris);
      }
    }
    const slabs = runSheetJob({ parts });
    const base = positions.length / 3;
    for (const p of slabs.positions) positions.push(p);
    for (const i of slabs.faces) faces.push(base + i);

    // Fit to the model, then measure.
    type Measured = { f: (typeof island.faces)[number]; folded: V3[]; model: V3[]; cut: boolean[] };
    const measured: Measured[] = [];
    for (const f of island.faces) {
      const fr = frames.get(f.faceIndex);
      if (!fr || f.model3DMm?.length !== f.polygon2D.length) continue;
      const n = f.polygon2D.length;
      const cut = f.polygon2D.map((p, i) => {
        const q = f.polygon2D[(i + 1) % n];
        return island.cutSeams.some((s) => s.faceIndex === f.faceIndex &&
          ((nearly(s.p1, p) && nearly(s.p2, q)) || (nearly(s.p1, q) && nearly(s.p2, p))));
      });
      measured.push({ f, folded: f.polygon2D.map((p) => apply(fr, on(p))), model: f.model3DMm, cut });
    }
    if (!measured.length) continue;

    const dirsFrom: V3[] = [], dirsTo: V3[] = [], weights: number[] = [];
    for (const m of measured) {
      dirsFrom.push(polygonNormal(m.folded));
      dirsTo.push(polygonNormal(m.model));
      weights.push(Math.max(1, m.f.areaMm2));
      for (let i = 0; i < m.folded.length; i++) {
        const j = (i + 1) % m.folded.length;
        const a = sub(m.folded[j], m.folded[i]), b = sub(m.model[j], m.model[i]);
        const l = Math.hypot(...b);
        if (l < 1e-6 || Math.hypot(...a) < 1e-6) continue;
        dirsFrom.push(norm(a));
        dirsTo.push(norm(b));
        weights.push(l * l);
      }
    }
    const q = bestRotation(dirsFrom, dirsTo, weights);
    const turned = measured.map((m) => m.folded.map((p) => mulV(q, p)));

    // Position: each face on its plane, each cut edge on its line, and a
    // light pull of the centres together for any direction those leave free.
    const A = new Array(9).fill(0);
    let rhs: V3 = [0, 0, 0];
    const constrain = (P: number[], r: V3, w: number) => {
      for (let i = 0; i < 9; i++) A[i] += w * P[i];
      rhs = add(rhs, scale(mulV(P, r), w));
    };
    let cm: V3 = [0, 0, 0], cf: V3 = [0, 0, 0], count = 0;
    measured.forEach((m, k) => {
      const n = polygonNormal(m.model);
      constrain([n[0] * n[0], n[0] * n[1], n[0] * n[2], n[1] * n[0], n[1] * n[1], n[1] * n[2], n[2] * n[0], n[2] * n[1], n[2] * n[2]],
        sub(m.model[0], turned[k][0]), 1);
      m.model.forEach((p, i) => {
        cm = add(cm, p); cf = add(cf, turned[k][i]); count++;
        if (!m.cut[i]) return;
        const d = norm(sub(m.model[(i + 1) % m.model.length], p));
        const P = [1 - d[0] * d[0], -d[0] * d[1], -d[0] * d[2], -d[1] * d[0], 1 - d[1] * d[1], -d[1] * d[2], -d[2] * d[0], -d[2] * d[1], 1 - d[2] * d[2]];
        constrain(P, sub(p, turned[k][i]), 1);
      });
    });
    constrain([1, 0, 0, 0, 1, 0, 0, 0, 1], sub(scale(cm, 1 / count), scale(cf, 1 / count)), 1e-6);
    const shift = solve3(A, rhs) ?? sub(scale(cm, 1 / count), scale(cf, 1 / count));
    const fit: Frame = { r: q, t: shift };

    measured.forEach((m, k) => {
      const folded = turned[k].map((p) => add(p, shift));
      const n = polygonNormal(folded);
      const record = (d: number) => {
        devs.push(d);
        if (d > worst.d) worst = { d, island: island.id, faceIndex: m.f.faceIndex };
      };
      for (const p of m.model) record(Math.abs(dot(sub(p, folded[0]), n)));
      m.cut.forEach((isCut, i) => {
        if (!isCut) return;
        const a = folded[i], b = folded[(i + 1) % folded.length];
        const d = norm(sub(b, a));
        for (const p of [m.model[i], m.model[(i + 1) % m.model.length]]) {
          const r = sub(p, a);
          record(Math.hypot(...sub(r, scale(d, dot(r, d)))));
        }
      });
    });

    // The island's mesh, put where the fit says.
    for (let v = islandStart; v < positions.length / 3; v++) {
      const p = apply(fit, [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
      positions[v * 3] = p[0]; positions[v * 3 + 1] = p[1]; positions[v * 3 + 2] = p[2];
    }
  }

  const pos = new Float32Array(positions);
  const tri = new Uint32Array(faces);
  return {
    positions: pos,
    faces: tri,
    volumeMm3: enclosedVolume(pos, tri),
    islands: result.islands.length,
    folds,
    deviation: {
      maxMm: devs.length ? Math.max(...devs) : 0,
      meanMm: devs.length ? devs.reduce((s, d) => s + d, 0) / devs.length : 0,
    },
    ...(worst.d >= 0 ? { worst: { island: worst.island, faceIndex: worst.faceIndex } } : {}),
    drawnThicknessMm: drawnT,
  };
}

/** The unfolded model's place: the net is the model at `scaleFactor`. */
export function sheetFoldStockTransform(result: Pick<SheetUnfoldResult, 'islands'>, scaleFactor: number): StockTransform {
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const isl of result.islands) {
    for (const f of isl.faces) {
      for (const p of f.model3DMm ?? []) {
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], p[a] / scaleFactor);
          hi[a] = Math.max(hi[a], p[a] / scaleFactor);
        }
      }
    }
  }
  return { modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [scaleFactor, scaleFactor, scaleFactor], modelMinMm: lo, modelMaxMm: hi };
}

/**
 * Add Simulation for an unfold: the net folded back up, beside or over the
 * model, with what the fold measured for the note card. Shared by the dialog
 * and the MCP bridge so both add the same thing.
 */
export function sheetFoldSimulationRequest(
  result: Pick<SheetUnfoldResult, 'islands' | 'mode'>,
  options: Pick<SheetUnfoldOptions, 'thicknessMm' | 'bendRadiusMm' | 'kFactor' | 'scaleFactor'>
): { fold: SheetFoldResult; request: Omit<AddSimulationRequest, 'placement'> } {
  const fold = foldSheetUnfold(result, options);
  const s = options.scaleFactor > 0 ? options.scaleFactor : 1;
  const metal = result.mode === 'sheet_metal';
  const what = { papercraft: 'papercraft', sheet_metal: 'sheet metal', soft_goods: 'soft goods' }[result.mode];
  return {
    fold,
    request: {
      mesh: { positions: fold.positions, faces: fold.faces },
      transform: sheetFoldStockTransform(result, s),
      kind: 'sheet',
      label: `Folded ${what} net`,
      details: [
        `${fold.folds} fold${fold.folds === 1 ? '' : 's'} in ${fold.islands} piece${fold.islands === 1 ? '' : 's'}`,
        metal
          ? `Bent at R${options.bendRadiusMm} in ${options.thicknessMm} mm sheet, K ${options.kFactor}`
          : `Drawn ${fold.drawnThicknessMm} mm thick; folded on a hinge, glue tabs left off`,
        s !== 1 ? `At ${Math.round(s * 100)}% of the model` : null,
        fold.deviation.maxMm < 0.05
          ? `Folds onto the model to within ${Math.max(0.01, fold.deviation.maxMm).toFixed(2)} mm`
          : `**Folds up to ${fold.deviation.maxMm.toFixed(2)} mm off the model** (mean ${fold.deviation.meanMm.toFixed(2)} mm)`,
      ].filter((d): d is string => !!d),
    },
  };
}
