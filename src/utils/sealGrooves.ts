// ---------------------------------------------------------------------------
// O-ring grooves
//
// The two hardware cuts that are worked out from the part rather than only from
// a table: a groove has to sit in a wall, round a boss or in a bore, and what
// it is cut to depends on which, and on how big that wall, boss or bore is.
//
// - 'oring', a stocked ring (ID × cord), in one of three places:
//     face   — in a flat face, a lid pressed down onto it. Centred on a round
//              face, and in the middle of the wall of a round cavity under it.
//     piston — round a boss, sealing inside the bore it is pushed into.
//     bore   — in the wall of a hole, sealing on a shaft pushed through it.
//   Which one is read off where it was put: on a cylinder's side it is a
//   piston, on a hole's wall a bore, anywhere else a face.
// - 'seal_cord', cord sold by the metre in a groove that follows a box's rim,
//   in the middle of the wall of the cavity under the face when there is one.
//
// Every groove is one cut: a ring cylinder (SceneGeom.ringInner) for the round
// ones, and a prism with a hole in it (cutOutline + cutHoles) for a rim. Depth
// and width are the cord's gland from hardwareSizes; this file only decides
// where the groove goes and which ring it is for. With no size given, it is
// the ring that fits; with one that cannot fit, there is no groove and
// `sealGrooveProblem` says why in one sentence.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGeom, SceneNode, SealType } from '../types/scene';
import { csgSourceGeoms, flatFaceAt, fromtoFrame, geomMatrixOf, type FaceRegion } from './csg';
import { GLANDS, O_RINGS, SEAL_CORDS, SEAL_LIMITS } from './hardwareSizes';

/** Plastic left either side of a groove, mm: two beads of a 0.4 mm nozzle. */
const WALL_EACH_SIDE = 0.8;
/** A cord bends round no tighter than this many of its own diameters. */
const BEND_RADII = 3;
/** Stretch a ring is fitted with, onto a groove floor or a shaft. */
const STRETCH = 0.02;
/** How far a ring may be squeezed round, into a groove smaller than its own line. */
const RING_SQUEEZE = 0.03;
/** Radial clearance between a boss or a shaft and the bore it goes in, mm. */
const SLIDE_CLEARANCE = 0.15;

const mm = (v: number) => +(v / 1000).toFixed(7);

export interface SealSpec {
  kind: 'oring' | 'seal_cord';
  size: string;
  at: number[];
  normal: number[];
  seal?: SealType;
  fitMm?: number;
}

/** What a groove is, worked out: where, which ring, and the numbers a seal check reads back. */
export interface SealPlan {
  seal: SealType | 'rim';
  size: string;
  cordMm: number;
  /** Groove depth and width, mm. */
  depthMm: number;
  widthMm: number;
  geom: Omit<SceneGeom, 'name' | 'hardware'>;
}

// ---------------------------------------------------------------------------
// Reading the part
// ---------------------------------------------------------------------------

interface Axis { point: THREE.Vector3; dir: THREE.Vector3; radius: number; halfLen: number }

function axisOf(g: SceneGeom): Axis | null {
  if (g.type !== 'cylinder') return null;
  const f = g.fromto && g.fromto.length >= 6 ? fromtoFrame(g.fromto) : { matrix: geomMatrixOf(g), halfLen: g.size?.[1] ?? 0 };
  return {
    point: new THREE.Vector3().setFromMatrixPosition(f.matrix),
    dir: new THREE.Vector3(0, 0, 1).transformDirection(f.matrix),
    radius: g.size?.[0] ?? 0,
    halfLen: f.halfLen ?? 0,
  };
}

/** The cylinder whose side `at` is on, square to `normal`: a boss's (positive) or a hole's (negative). */
function sideOf(host: SceneNode, at: THREE.Vector3, normal: THREE.Vector3, negative: boolean): Axis | null {
  for (const g of csgSourceGeoms(host)) {
    if (g.hardware || g.ringInner) continue;
    if ((g.csg === 'difference') !== negative) continue;
    const a = axisOf(g);
    if (!a || a.radius <= 0) continue;
    if (Math.abs(a.dir.dot(normal)) > 0.05) continue;
    const rel = at.clone().sub(a.point);
    const along = rel.dot(a.dir);
    // A through hole's cutter overshoots the part, so only a boss is held to its length.
    if (!negative && Math.abs(along) > a.halfLen + 1e-5) continue;
    const across = rel.clone().addScaledVector(a.dir, -along);
    if (Math.abs(across.length() - a.radius) > 0.0005) continue;
    return a;
  }
  return null;
}

interface Frame { origin: THREE.Vector3; quat: THREE.Quaternion }

function faceFrame(region: FaceRegion): Frame {
  const n = new THREE.Vector3(...(region.normal as [number, number, number])).normalize();
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  if (region.twist) quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), region.twist));
  return { origin: new THREE.Vector3(...(region.at as [number, number, number])), quat };
}

/** The face under a spot, as a cut there reads it. */
function faceAt(host: SceneNode, at: number[], normal: number[]): FaceRegion | null {
  const away = 0.05;
  return flatFaceAt(host, at.map((v, a) => v + (normal[a] ?? 0) * away), normal.map((v) => -v));
}

/**
 * The opening of a cavity under a face, in the face's frame, mm: a box's
 * rectangle or a round hole's circle. Null when nothing is open into the face.
 */
function cavityUnder(host: SceneNode, frame: Frame): { rect?: [number, number, number, number]; circle?: [number, number, number] } | null {
  const toFace = new THREE.Matrix4().compose(frame.origin, frame.quat, new THREE.Vector3(1, 1, 1)).invert();
  for (const g of csgSourceGeoms(host)) {
    if (g.csg !== 'difference' || g.hardware || g.ringInner || g.cutFace) continue;
    if (g.type === 'box') {
      const s = g.size || [];
      const m = new THREE.Matrix4().multiplyMatrices(toFace, geomMatrixOf(g));
      const box = new THREE.Box3();
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        box.expandByPoint(new THREE.Vector3(x * (s[0] ?? 0), y * (s[1] ?? 0), z * (s[2] ?? 0)).applyMatrix4(m));
      }
      if (box.max.z < -1e-5 || box.min.z > -1e-5) continue;
      return { rect: [box.min.x * 1000, box.max.x * 1000, box.min.y * 1000, box.max.y * 1000] };
    }
    const a = axisOf(g);
    if (!a) continue;
    const dir = a.dir.clone().applyQuaternion(frame.quat.clone().invert());
    if (Math.abs(dir.z) < 0.999) continue;
    const c = a.point.clone().applyMatrix4(toFace);
    if (c.z + a.halfLen < -1e-5 || c.z - a.halfLen > -1e-5) continue;
    return { circle: [c.x * 1000, c.y * 1000, a.radius * 1000] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** A rounded rectangle centred on the origin, anticlockwise, metres; half sizes and radius in mm. */
export function roundedRect(hx: number, hy: number, r: number, perCorner = 8): number[][] {
  const rr = Math.max(0, Math.min(r, hx, hy));
  const out: number[][] = [];
  const corners: [number, number, number][] = [[hx - rr, hy - rr, 0], [-hx + rr, hy - rr, 90], [-hx + rr, -hy + rr, 180], [hx - rr, -hy + rr, 270]];
  for (const [cx, cy, a0] of corners) {
    for (let i = 0; i <= perCorner; i++) {
      const a = ((a0 + (90 * i) / perCorner) * Math.PI) / 180;
      out.push([mm(cx + rr * Math.cos(a)), mm(cy + rr * Math.sin(a))]);
    }
  }
  return out;
}

/** The length of a closed loop, mm, from points in metres. */
export function loopLengthMm(loop: number[][]): number {
  let l = 0;
  for (let i = 0; i < loop.length; i++) {
    const [a, b] = [loop[i], loop[(i + 1) % loop.length]];
    l += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return l * 1000;
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

type Plan = SealPlan | { problem: string };

const ringOf = (size: string) => O_RINGS[size];
const glandOf = (cord: number, radial: boolean): [number, number] => {
  const g = GLANDS[String(cord)];
  return radial ? g.radial : g.face;
};

/** Where a groove goes on this part, and what for, or why it cannot go there. */
export function planSealGroove(spec: SealSpec, host: SceneNode): Plan {
  const at = new THREE.Vector3(...(spec.at as [number, number, number]));
  const n = new THREE.Vector3(...(spec.normal as [number, number, number])).normalize();
  const fit = Math.max(0, spec.fitMm ?? 0);

  if (spec.kind === 'seal_cord') return planRim(spec, host, fit);

  const boss = spec.seal === undefined || spec.seal === 'piston' ? sideOf(host, at, n, false) : null;
  const hole = !boss && (spec.seal === undefined || spec.seal === 'bore') ? sideOf(host, at, n, true) : null;
  if (spec.seal === 'piston' && !boss) return { problem: 'A piston seal goes round a boss: put it on the side of a cylinder.' };
  if (spec.seal === 'bore' && !hole) return { problem: 'A bore seal goes in the wall of a hole: put it on the inside of one.' };
  if (boss) return planRadial(spec, boss, at, n, 'piston', fit);
  if (hole) return planRadial(spec, hole, at, n, 'bore', fit);
  return planFace(spec, host, fit);
}

function planRadial(spec: SealSpec, axis: Axis, at: THREE.Vector3, n: THREE.Vector3, seal: 'piston' | 'bore', fit: number): Plan {
  const R = axis.radius * 1000;
  // Piston: the ring stretched onto the groove floor, the mating bore a
  // clearance outside the boss. Bore: the ring's outside on the groove floor,
  // the shaft it seals on a clearance inside the hole.
  const fits = (size: string) => {
    const [id, cord] = ringOf(size);
    const [depth, width] = glandOf(cord, true);
    if (seal === 'piston') {
      const floor = (id / 2) * (1 + STRETCH);
      const mating = R + SLIDE_CLEARANCE;
      return { floor, wall: R, ok: floor < R - 0.3, error: Math.abs(mating - floor - depth), depth, width, cord };
    }
    const shaft = R - SLIDE_CLEARANCE;
    const floor = shaft + depth;
    // Stretched onto the shaft by a little, never squeezed onto it.
    const stretch = shaft / (id / 2) - 1;
    return { floor, wall: R, ok: stretch >= 0 && stretch <= SEAL_LIMITS.stretchMax, error: Math.abs(stretch - STRETCH), depth, width, cord };
  };
  let size = spec.size;
  if (!ringOf(size)) {
    const ranked = Object.keys(O_RINGS).map((s) => ({ s, f: fits(s) })).filter((x) => x.f.ok).sort((a, b) => a.f.error - b.f.error || b.f.cord - a.f.cord);
    if (!ranked.length) return { problem: `No stocked O-ring fits a Ø${(R * 2).toFixed(1)} mm ${seal === 'piston' ? 'boss' : 'bore'}.` };
    size = ranked[0].s;
  }
  const f = fits(size);
  if (!f.ok) {
    return { problem: seal === 'piston'
      ? `A ${size} is too big for this Ø${(R * 2).toFixed(1)} mm boss: its groove floor would be outside the boss.`
      : `A ${size} does not fit a Ø${(R * 2).toFixed(1)} mm bore: it would have to stretch more than ${SEAL_LIMITS.stretchMax * 100}% onto the shaft.` };
  }
  const width = f.width + fit;
  const inner = seal === 'piston' ? f.floor : R - 1;
  const outer = seal === 'piston' ? R + 1 : f.floor;
  return {
    seal, size, cordMm: f.cord, depthMm: Math.abs(R - f.floor), widthMm: width,
    geom: {
      type: 'cylinder', size: [mm(outer), mm(width / 2)], ringInner: mm(inner), csg: 'difference',
      cutAt: at.toArray().map((v) => +v.toFixed(6)), cutNormal: n.toArray(),
      cutAxis: [...axis.point.toArray(), ...axis.dir.toArray()].map((v) => +v.toFixed(9)),
      rgba: [0.9, 0.25, 0.35, 1],
    },
  };
}

function planFace(spec: SealSpec, host: SceneNode, fit: number): Plan {
  const region = faceAt(host, spec.at, spec.normal);
  if (!region) return { problem: 'An O-ring groove goes in a flat face: put it on one.' };
  const frame = faceFrame(region);
  const disc = region.shape === 'cylinder';
  // Round on a round face; on any other, where it was put.
  const centre = disc ? frame.origin.clone() : new THREE.Vector3(...(spec.at as [number, number, number]));
  const local = centre.clone().sub(frame.origin).applyQuaternion(frame.quat.clone().invert()).multiplyScalar(1000);
  const cavity = cavityUnder(host, frame);
  // The band the groove has to stay inside, as radii about its centre, mm.
  let lo = 0;
  let hi: number;
  if (disc) hi = region.half[0] * 1000;
  else if (region.shape === 'box') hi = Math.min(region.half[0] * 1000 - Math.abs(local.x), region.half[1] * 1000 - Math.abs(local.y));
  else hi = region.maxBorder * 1000;
  if (cavity?.circle && Math.hypot(cavity.circle[0] - local.x, cavity.circle[1] - local.y) < 0.5) lo = cavity.circle[2];
  // The groove's middle: in the middle of a wall when there is one, as far out
  // as fits when there is not.
  const middle = (width: number) => (lo > 0 ? (lo + hi) / 2 : hi - WALL_EACH_SIDE - 2 - width / 2);
  const groove = (size: string, centred: boolean) => {
    const [id, cord] = ringOf(size);
    const [depth, w] = glandOf(cord, false);
    const width = w + fit;
    // A ring lies round its own line, and takes a groove a little off it —
    // stretched onto the inner wall, or squeezed into the outer.
    const line = id / 2 + cord / 2;
    const at = centred ? middle(width) : line;
    const takes = at >= line * (1 - RING_SQUEEZE) && at <= line * (1 + SEAL_LIMITS.stretchMax);
    const outer = at + width / 2;
    const inner = at - width / 2;
    return { at, outer, inner, depth, width, cord, line, takes, fits: inner >= lo + WALL_EACH_SIDE && outer <= hi - WALL_EACH_SIDE };
  };
  let size = spec.size;
  let centred = false;
  if (!ringOf(size)) {
    // The thickest cord whose ring takes a groove where the groove should be.
    const ranked = Object.keys(O_RINGS).map((s) => ({ s, g: groove(s, true) })).filter((x) => x.g.fits && x.g.takes)
      // Up to 3 mm: past that a printed part gains nothing but a deeper groove.
      .sort((a, b) => (a.g.cord > 3 ? 1 : 0) - (b.g.cord > 3 ? 1 : 0) || b.g.cord - a.g.cord
        || Math.abs(a.g.at - a.g.line) - Math.abs(b.g.at - b.g.line));
    if (!ranked.length) {
      return { problem: lo > 0
        ? `The wall here is ${(hi - lo).toFixed(1)} mm; the smallest groove needs ${(GLANDS['1.5'].face[1] + 2 * WALL_EACH_SIDE).toFixed(1)} mm.`
        : 'No stocked O-ring fits on this face.' };
    }
    size = ranked[0].s;
    centred = true;
  } else {
    // A size given: still in the middle of the wall if that ring takes it
    // there, so editing the fit does not slide the groove about.
    const there = groove(size, true);
    centred = there.takes && there.fits;
  }
  const g = groove(size, centred);
  if (!g.fits) {
    return { problem: lo > 0
      ? `A ${size} does not sit in this ${(hi - lo).toFixed(1)} mm wall: its groove runs ${(g.inner).toFixed(1)} to ${g.outer.toFixed(1)} mm out, and the wall ${lo.toFixed(1)} to ${hi.toFixed(1)}.`
      : `A ${size} is too big for this face: its groove reaches ${g.outer.toFixed(1)} mm out, and the face ${hi.toFixed(1)}.` };
  }
  return {
    seal: 'face', size, cordMm: g.cord, depthMm: g.depth, widthMm: g.width,
    geom: {
      type: 'cylinder', size: [mm(g.outer), 0], ringInner: mm(g.inner), csg: 'difference',
      cutAt: centre.toArray().map((v) => +v.toFixed(6)), cutNormal: [...region.normal],
      cutDepth: mm(g.depth), rgba: [0.9, 0.25, 0.35, 1],
    },
  };
}

function planRim(spec: SealSpec, host: SceneNode, fit: number): Plan {
  const region = faceAt(host, spec.at, spec.normal);
  if (!region || region.shape !== 'box') return { problem: 'A rim seal follows the edge of a flat rectangular face: put it on one.' };
  const frame = faceFrame(region);
  const [hx, hy] = [region.half[0] * 1000, region.half[1] * 1000];
  const cavity = cavityUnder(host, frame)?.rect;
  // The wall on each side, mm, and the centreline's half sizes in the middle of it.
  const walls = cavity ? [cavity[0] + hx, hx - cavity[1], cavity[2] + hy, hy - cavity[3]] : null;
  const thinnest = walls ? Math.min(...walls) : Infinity;
  const fitsCord = (cord: string) => GLANDS[cord].face[1] + fit + 2 * WALL_EACH_SIDE <= thinnest;
  let size = spec.size;
  if (!(SEAL_CORDS as readonly string[]).includes(size)) {
    const usable = SEAL_CORDS.filter(fitsCord);
    if (!usable.length) return { problem: `The wall here is ${thinnest.toFixed(1)} mm; the thinnest cord's groove needs ${(GLANDS['1.5'].face[1] + 2 * WALL_EACH_SIDE).toFixed(1)} mm.` };
    // The thickest cord the wall takes, up to 3 mm: past that a printed box gains nothing.
    size = [...usable].reverse().find((c) => Number(c) <= 3) ?? usable[0];
  }
  if (!fitsCord(size)) {
    return { problem: `Ø${size} cord needs a ${(GLANDS[size].face[1] + fit + 2 * WALL_EACH_SIDE).toFixed(1)} mm wall, and this one is ${thinnest.toFixed(1)} mm.` };
  }
  const cord = Number(size);
  const [depth, width0] = GLANDS[size].face;
  const width = width0 + fit;
  const inset = walls ? null : WALL_EACH_SIDE + 2 + width / 2;
  const cx = walls ? ((cavity![0] + cavity![1]) / 2) : 0;
  const cy = walls ? ((cavity![2] + cavity![3]) / 2) : 0;
  const halfX = walls ? (hx - walls[1] / 2) - cx : hx - inset!;
  const halfY = walls ? (hy - walls[3] / 2) - cy : hy - inset!;
  const bend = BEND_RADII * cord;
  if (halfX - width / 2 <= bend || halfY - width / 2 <= bend) return { problem: 'This face is too small for a rim seal to go round.' };
  const shift = (loop: number[][]) => loop.map(([x, y]) => [+(x + mm(cx)).toFixed(7), +(y + mm(cy)).toFixed(7)]);
  const outer = shift(roundedRect(halfX + width / 2, halfY + width / 2, bend + width / 2));
  const inner = shift(roundedRect(halfX - width / 2, halfY - width / 2, bend - width / 2)).reverse();
  return {
    seal: 'rim', size, cordMm: cord, depthMm: depth, widthMm: width,
    geom: {
      type: 'mesh', size: [1], csg: 'difference', cutOutline: outer, cutHoles: [inner],
      cutAt: frame.origin.toArray().map((v) => +v.toFixed(6)), cutNormal: [...region.normal],
      ...(region.twist ? { cutTwist: +region.twist.toFixed(9) } : {}),
      cutDepth: mm(depth), rgba: [0.9, 0.25, 0.35, 1],
    },
  };
}

/** Why a groove cannot go where it was asked to, or null when it can. */
export function sealGrooveProblem(spec: SealSpec, host: SceneNode): string | null {
  const plan = planSealGroove(spec, host);
  return 'problem' in plan ? plan.problem : null;
}

/** The centreline of a rim groove, metres, in its cut frame: midway between its two walls. */
export function rimCentreline(geom: SceneGeom): number[][] | null {
  const outer = geom.cutOutline;
  const inner = geom.cutHoles?.[0];
  if (!outer || !inner || inner.length !== outer.length) return null;
  const back = [...inner].reverse();
  return outer.map(([x, y], i) => [(x + back[i][0]) / 2, (y + back[i][1]) / 2]);
}
