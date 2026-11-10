// ---------------------------------------------------------------------------
// Where to part a lined mold so it prints with least hanging over the casting
// ---------------------------------------------------------------------------
//
// Both halves print parting face up. In the half below the parting plane every
// face of the part that turns upward has mold above it, and in the half above
// every face that turns downward does: each is a roof over the casting as the
// half prints. A steep one builds up at 45° or more and needs nothing. A flat
// one is fixed after the fact: liner over it moves to the other half, or the
// insert is cut there (moldLiner.ts). A shallow slope or a curve, such as the
// top of a horizontal hole, can only print with support under it, and support
// printed in the cavity takes the casting's place.
//
// So the plane, and the direction the mold opens when it is free to choose,
// are the ones that leave least of that. A parting plane can fix none of it
// when the part keeps such a face whichever half it falls in; turning the mold
// can.
// ---------------------------------------------------------------------------

import { rotateTrianglesForPull, type PullDirection } from './moldPullDirection';

/** Steeper than this from the horizontal, a roof builds up without support. */
const STEEP_COS = Math.SQRT1_2;
/** Within this of horizontal a face is flat: fixed by a cut or a lift, not support. */
const FLAT_COS = 0.999;
/** A flat roof counts this much against a plane: it prints, at the price of a seam. */
const FLAT_WEIGHT = 0.2;
/** A face this close to the plane is on it, mm. */
const ON_PLANE_MM = 0.05;

export interface RoofScore {
  /** The parting height, in the frame the triangles were given in, mm. */
  z: number;
  /** Shallow or curved roof the plane leaves: what only support prints, mm². */
  curvedMm2: number;
  /** Flat roof it leaves, mm². */
  flatMm2: number;
}

interface Faces {
  /** Corner heights and area of each face that matters, with its kind. */
  z0: Float64Array;
  z1: Float64Array;
  z2: Float64Array;
  area: Float64Array;
  /** +1 a shallow upward face, -1 a shallow downward one, +2 / -2 flat, 0 steep. */
  kind: Int8Array;
}

function facesOf(tris: ArrayLike<number>): Faces {
  const n = Math.floor(tris.length / 9);
  const f: Faces = { z0: new Float64Array(n), z1: new Float64Array(n), z2: new Float64Array(n), area: new Float64Array(n), kind: new Int8Array(n) };
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    const c = nz / len;
    f.area[t] = len / 2;
    f.z0[t] = tris[o + 2];
    f.z1[t] = tris[o + 5];
    f.z2[t] = tris[o + 8];
    f.kind[t] = c >= FLAT_COS ? 2 : c > STEEP_COS ? 1 : c <= -FLAT_COS ? -2 : c < -STEEP_COS ? -1 : 0;
  }
  return f;
}

/**
 * The share of a triangle with corner heights a, b, c that lies below `h`. A
 * triangle's area shares out along any one direction the way its heights do,
 * so this is exact without clipping it.
 */
function shareBelow(a: number, b: number, c: number, h: number): number {
  const [lo, mid, hi] = [a, b, c].sort((p, q) => p - q);
  if (h <= lo) return 0;
  if (h >= hi) return 1;
  if (hi - lo < 1e-12) return h >= lo ? 1 : 0;
  // The area below h grows as (h - lo)² up to mid, then the rest shrinks as (hi - h)².
  if (h <= mid) return ((h - lo) * (h - lo)) / ((hi - lo) * Math.max(mid - lo, 1e-12));
  return 1 - ((hi - h) * (hi - h)) / ((hi - lo) * Math.max(hi - mid, 1e-12));
}

function scoreAt(f: Faces, plane: number): { curved: number; flat: number } {
  let curved = 0;
  let flat = 0;
  for (let t = 0; t < f.kind.length; t++) {
    const k = f.kind[t];
    if (k === 0) continue;
    // Upward faces are roofs below the plane, downward ones above it; a face on the plane is neither.
    const share = k > 0
      ? shareBelow(f.z0[t], f.z1[t], f.z2[t], plane - ON_PLANE_MM)
      : 1 - shareBelow(f.z0[t], f.z1[t], f.z2[t], plane + ON_PLANE_MM);
    if (share <= 0) continue;
    if (Math.abs(k) === 2) flat += share * f.area[t];
    else curved += share * f.area[t];
  }
  return { curved, flat };
}

const total = (s: { curved: number; flat: number }) => s.curved + FLAT_WEIGHT * s.flat;

/**
 * The roof each plane between zMin and zMax would leave, from one pass over
 * the faces: a face's area is shared over its height as a straight ramp (a
 * flat face as a step), and the ramps are summed on a fine ladder of heights,
 * so any plane is then read off in constant time. A ramp is near enough: a
 * triangle's area actually shares out as two curved pieces, and the plane
 * this picks is a parting choice, not a measurement.
 */
function roofLadder(f: Faces, zMin: number, zMax: number) {
  const N = 4096;
  const lo = zMin - 1;
  const step = (zMax - zMin + 2) / N;
  // Upward area below a height and downward area above it, curved and flat apart.
  const make = () => ({ slope: new Float64Array(N + 2), jump: new Float64Array(N + 2) });
  const up = { curved: make(), flat: make() };
  const down = { curved: make(), flat: make() };
  const bin = (z: number) => Math.min(N, Math.max(0, (z - lo) / step));
  for (let t = 0; t < f.kind.length; t++) {
    const k = f.kind[t];
    if (k === 0) continue;
    const a = f.area[t];
    const z0 = Math.min(f.z0[t], f.z1[t], f.z2[t]);
    const z1 = Math.max(f.z0[t], f.z1[t], f.z2[t]);
    const target = (k > 0 ? up : down)[Math.abs(k) === 2 ? 'flat' : 'curved'];
    const b0 = bin(z0), b1 = bin(z1);
    if (b1 - b0 < 1e-9) {
      target.jump[Math.ceil(b0)] += a;
    } else {
      const rate = a / (b1 - b0);
      // The ramp starts and stops partway through a rung: whole rungs here, the rest is under a rung's error.
      target.slope[Math.ceil(b0)] += rate;
      target.slope[Math.ceil(b1)] -= rate;
    }
  }
  // Cumulative area below each rung.
  const below = (c: { slope: Float64Array; jump: Float64Array }) => {
    const out = new Float64Array(N + 2);
    let slope = 0, acc = 0;
    for (let i = 0; i <= N + 1; i++) {
      slope += c.slope[i];
      acc += c.jump[i];
      out[i] = acc;
      acc += slope;
    }
    return out;
  };
  const upC = below(up.curved), upF = below(up.flat), dnC = below(down.curved), dnF = below(down.flat);
  const dnCTotal = dnC[N + 1], dnFTotal = dnF[N + 1];
  const at = (arr: Float64Array, z: number) => arr[Math.min(N + 1, Math.max(0, Math.floor(bin(z))))];
  return (plane: number) => ({
    curved: at(upC, plane - ON_PLANE_MM) + (dnCTotal - at(dnC, plane + ON_PLANE_MM)),
    flat: at(upF, plane - ON_PLANE_MM) + (dnFTotal - at(dnF, plane + ON_PLANE_MM)),
  });
}

/**
 * The parting height between `zMin` and `zMax` that leaves a lined mold least
 * roof it cannot print, trying every height a flat face of the part lies at as
 * well as an even spread. Near-ties go to the plane nearest `preferZ` (the
 * plain mold's choice), so a part with nothing to choose between keeps it.
 * `tris` are in mm, the mold opening along +Z.
 */
export function linerPartingChoice(tris: ArrayLike<number>, zMin: number, zMax: number, preferZ: number): RoofScore {
  const f = facesOf(tris);
  const levels = new Set<number>();
  for (let t = 0; t < f.kind.length; t++) {
    if (Math.abs(f.kind[t]) === 2 && f.z0[t] > zMin && f.z0[t] < zMax) levels.add(Math.round(f.z0[t] * 1000) / 1000);
  }
  const SAMPLES = 128;
  for (let s = 0; s <= SAMPLES; s++) levels.add(zMin + ((zMax - zMin) * s) / SAMPLES);
  levels.add(preferZ);
  const ladder = roofLadder(f, zMin, zMax);
  const scored = [...levels].map((z) => ({ z, ...ladder(z) }));
  const least = Math.min(...scored.map(total));
  const near = scored.filter((s) => total(s) <= least + Math.max(0.5, least * 0.01));
  near.sort((p, q) => Math.abs(p.z - preferZ) - Math.abs(q.z - preferZ));
  // Scored exactly, the winner, for what it reports.
  const exact = scoreAt(f, near[0].z);
  return { z: near[0].z, curvedMm2: exact.curved, flatMm2: exact.flat };
}

/**
 * Which axis a lined clamshell should open along: the one whose best parting
 * plane leaves least roof only support prints, then least flat roof. `tris`
 * in mm, as placed. Null when no axis is clearly better (within 5%), so the
 * caller keeps its own choice.
 */
export function linerPullChoice(tris: ArrayLike<number>, preferred: PullDirection): PullDirection | null {
  const axes: PullDirection[] = ['+z', '+y', '+x'];
  const results = axes.map((dir) => {
    const turned = dir === '+z' ? tris : rotateTrianglesForPull(tris, dir);
    let lo = Infinity, hi = -Infinity;
    for (let i = 2; i < turned.length; i += 3) {
      lo = Math.min(lo, turned[i]);
      hi = Math.max(hi, turned[i]);
    }
    const s = linerPartingChoice(turned, lo, hi, (lo + hi) / 2);
    return { dir, score: s.curvedMm2 + FLAT_WEIGHT * s.flatMm2 };
  });
  const mine = results.find((r) => r.dir === `+${preferred[1]}`) ?? results[0];
  const best = results.reduce((a, b) => (b.score < a.score ? b : a));
  if (best.dir === mine.dir || best.score >= mine.score * 0.95 - 0.5) return null;
  return best.dir;
}
