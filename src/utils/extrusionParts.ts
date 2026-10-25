// ---------------------------------------------------------------------------
// Aluminium extrusion and what joins it
//
// T-slot profile (2020, 2040, 3030, 4040, and V-slot 2020) cut to any length,
// and the bought pieces that hold a frame of it together: T-nuts, inside
// corner brackets, L and T joint plates, end-tap screws, and a V-slot wheel
// carriage that runs along a profile.
//
// THREE THINGS WORTH KNOWING
//
// 1. A PROFILE IS DRAWN AS ITSELF AND COLLIDES AS A BOX. The cross-section is
//    the real one — slots, lips, the tapped centre bore — extruded along the
//    part's own +Z. MuJoCo would hull that anyway, so it is drawn only, and a
//    box the size of its envelope does the colliding and carries the mass:
//    the maker's kilograms per metre, not the solid box's, since the real
//    section is mostly air.
//
// 2. A JOINT IS A WELD THE JOINING PIECE CARRIES. A bracket, a plate or an
//    end-tap screw is a rigid child of one profile, and the weld to the other
//    is on the piece itself (SceneNode.weldTargetId). A profile can only have
//    one weld of its own, and a frame's profiles each meet several others —
//    hung on the pieces, the welds never compete for it, and taking a bracket
//    out takes its weld with it.
//
// 3. WHERE TWO PROFILES MEET IS WORKED OUT, NOT ASKED. `meeting` finds the end
//    of one standing on a side face of the other, square to it, from where the
//    two actually are; the joining piece goes in the corner that makes, and a
//    pair that does not meet is refused in one sentence.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { HardwarePart, SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { prismMesh } from './csg';
import { getNodeWorldTransform } from './laserCutExporter';
import { BLACK_OXIDE, boxGeom, cylinderGeom, mm, visual, type HardwarePartInfo } from './hardwareGeometry';

export const ALUMINIUM = 2700; // kg/m³
const ANODISED: [number, number, number, number] = [0.8, 0.82, 0.85, 1];
const DIECAST: [number, number, number, number] = [0.66, 0.68, 0.71, 1];
const ZINC: [number, number, number, number] = [0.6, 0.62, 0.58, 1];
const DELRIN: [number, number, number, number] = [0.12, 0.12, 0.13, 1];

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * The T-slot sections, mm, after Misumi HFS5 (20-series, slot 6) and the
 * common 8-slot 30 and 40 series; the V-slot after OpenBuilds' 2020.
 * `cells` is the section in 20/30/40 squares, each with a centre bore and a
 * slot on every outside face. A slot is its opening at the face, the lip it
 * enters through, the cavity under the lip (wide at the lip, narrowing toward
 * the bore), and how deep it goes from the face.
 */
export interface ProfileSpec {
  /** The cell size: 20, 30 or 40. */
  cell: number;
  cells: [number, number];
  opening: number;
  lip: number;
  cavityWide: number;
  cavityNarrow: number;
  depth: number;
  bore: number;
  /** A V-slot's 45° entry: its width at the face. */
  vMouth?: number;
  /** The maker's mass, kg per metre. */
  kgPerM: number;
  /** The screw its bore is tapped for. */
  tap: string;
}

export const PROFILES: Record<string, ProfileSpec> = {
  '2020': { cell: 20, cells: [1, 1], opening: 6.2, lip: 1.8, cavityWide: 11, cavityNarrow: 6, depth: 6.1, bore: 4.2, kgPerM: 0.49, tap: 'M5' },
  '2040': { cell: 20, cells: [1, 2], opening: 6.2, lip: 1.8, cavityWide: 11, cavityNarrow: 6, depth: 6.1, bore: 4.2, kgPerM: 0.92, tap: 'M5' },
  '3030': { cell: 30, cells: [1, 1], opening: 8.2, lip: 2.2, cavityWide: 16.5, cavityNarrow: 8, depth: 9, bore: 6.8, kgPerM: 0.92, tap: 'M8' },
  '4040': { cell: 40, cells: [1, 1], opening: 8.2, lip: 2.2, cavityWide: 16.5, cavityNarrow: 8, depth: 12.2, bore: 6.8, kgPerM: 1.48, tap: 'M8' },
  '2020V': { cell: 20, cells: [1, 1], opening: 6.2, lip: 1.8, cavityWide: 11, cavityNarrow: 6, depth: 6.1, bore: 4.2, vMouth: 9.16, kgPerM: 0.45, tap: 'M5' },
};

/** A profile's half sizes across, mm: [x, y]. */
export function profileHalf(size: string): [number, number] {
  const p = PROFILES[size] ?? PROFILES['2020'];
  return [(p.cell * p.cells[0]) / 2, (p.cell * p.cells[1]) / 2];
}

/**
 * The section's outline, anticlockwise, and its bores, clockwise, in mm,
 * centred on the origin.
 *
 * Walked round the outside one edge at a time; on each edge, a slot is a notch
 * cut in from the face — mouth, lip, cavity — at every cell's middle. Each
 * notch point is the edge's start, plus how far along it, plus how far in: so
 * the notch is in the right order along an anticlockwise loop whichever way
 * the edge runs, and the loop stays anticlockwise.
 */
export function profileSection(size: string): { outline: number[][]; bores: number[][][] } {
  const p = PROFILES[size] ?? PROFILES['2020'];
  const [hx, hy] = profileHalf(size);
  const corners: [number, number][] = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  const outline: number[][] = [];
  for (let e = 0; e < 4; e++) {
    const [ax, ay] = corners[e];
    const [bx, by] = corners[(e + 1) % 4];
    const len = Math.hypot(bx - ax, by - ay);
    const [ux, uy] = [(bx - ax) / len, (by - ay) / len];
    // Left of an anticlockwise loop's direction is inward.
    const [nx, ny] = [-uy, ux];
    const at = (s: number, v: number) => [+(ax + ux * s + nx * v).toFixed(6), +(ay + uy * s + ny * v).toFixed(6)];
    outline.push(at(0, 0));
    for (let c = 0; c < Math.round(len / p.cell); c++) {
      const s = (c + 0.5) * p.cell;
      const notch: [number, number][] = p.vMouth
        ? [[-p.vMouth / 2, 0], [-p.opening / 2, (p.vMouth - p.opening) / 2]]
        : [[-p.opening / 2, 0]];
      notch.push([-p.opening / 2, p.lip], [-p.cavityWide / 2, p.lip], [-p.cavityNarrow / 2, p.depth]);
      const right = [...notch].reverse().map(([u, v]) => [-u, v] as [number, number]);
      for (const [u, v] of [...notch, ...right]) outline.push(at(s + u, v));
    }
  }
  const bores: number[][][] = [];
  for (let i = 0; i < p.cells[0]; i++) {
    for (let j = 0; j < p.cells[1]; j++) {
      const cx = -hx + (i + 0.5) * p.cell;
      const cy = -hy + (j + 0.5) * p.cell;
      const ring = Array.from({ length: 24 }, (_, k) => {
        const a = (k / 24) * Math.PI * 2;
        return [+(cx + (p.bore / 2) * Math.cos(a)).toFixed(6), +(cy + (p.bore / 2) * Math.sin(a)).toFixed(6)];
      });
      bores.push(ring.reverse());
    }
  }
  return { outline, bores };
}

/**
 * Where each slot runs, in the profile's frame, mm: the middle of its mouth on
 * the face, the face's outward direction, and the mouth's width. A slot runs
 * the profile's length, along +Z.
 */
export function profileSlots(size: string): { at: [number, number]; out: [number, number]; width: number }[] {
  const p = PROFILES[size] ?? PROFILES['2020'];
  const [hx, hy] = profileHalf(size);
  const out: { at: [number, number]; out: [number, number]; width: number }[] = [];
  for (let i = 0; i < p.cells[0]; i++) {
    const x = -hx + (i + 0.5) * p.cell;
    out.push({ at: [x, hy], out: [0, 1], width: p.opening }, { at: [x, -hy], out: [0, -1], width: p.opening });
  }
  for (let j = 0; j < p.cells[1]; j++) {
    const y = -hy + (j + 0.5) * p.cell;
    out.push({ at: [hx, y], out: [1, 0], width: p.opening }, { at: [-hx, y], out: [-1, 0], width: p.opening });
  }
  return out;
}

/** Twice the signed area of a loop: positive anticlockwise. */
function area2(loop: number[][]): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [p, q] = [loop[i], loop[(i + 1) % loop.length]];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a;
}

/** The section's area, mm²: outline less slots (already in it) less bores. */
export function sectionAreaMm2(size: string): number {
  const { outline, bores } = profileSection(size);
  return area2(outline) / 2 + bores.reduce((s, b) => s + area2(b) / 2, 0);
}

/** A mesh geom from Z-up positions, with the Y-up copy every mesh carries. */
function meshGeom(name: string, positions: number[], faces: number[], rgba: number[]): SceneGeom {
  const renderVertices = positions.map((v) => +v.toFixed(7));
  const vertices: number[] = [];
  for (let i = 0; i < renderVertices.length; i += 3) vertices.push(renderVertices[i], renderVertices[i + 2], -renderVertices[i + 1]);
  return { name, type: 'mesh', size: [1], rgba: [...rgba], renderVertices, vertices, faces };
}

function buildProfile(node: SceneNode, p: HardwarePart, id: string) {
  const L = p.lengthMm ?? 300;
  const { outline, bores } = profileSection(p.size);
  const m = prismMesh(outline.map(([x, y]) => [mm(x), mm(y)]), -mm(L / 2), mm(L / 2), bores.map((b) => b.map(([x, y]) => [mm(x), mm(y)])));
  const [hx, hy] = profileHalf(p.size);
  const spec = PROFILES[p.size] ?? PROFILES['2020'];
  node.geoms = [
    visual(meshGeom(`${id}_section`, m.positions, m.faces, ANODISED)),
    // The envelope collides and weighs what the maker says a metre weighs.
    {
      ...boxGeom(`${id}_envelope`, [mm(hx), mm(hy), mm(L / 2)], [0, 0, 0], ANODISED),
      role: 'collision', mass: +(spec.kgPerM * (L / 1000)).toFixed(6),
    },
  ];
}

// ---------------------------------------------------------------------------
// The pieces that join it
// ---------------------------------------------------------------------------

/** T-nuts by thread and slot: [thread, slot, width across, length, thickness], mm. */
export const T_NUTS: Record<string, [string, number, number, number, number]> = {
  'M4/6': ['M4', 6, 10, 10, 4], 'M5/6': ['M5', 6, 10, 10, 4], 'M5/8': ['M5', 8, 15, 16, 5.5], 'M6/8': ['M6', 8, 15, 16, 5.5],
};

/** Inside corner brackets by series: [leg, wall], mm; as wide as the profile. */
export const CORNER_BRACKETS: Record<string, [number, number]> = { '20': [20, 3.5], '30': [28, 4.5], '40': [38, 5.5] };

/** Joint plates: shape and series. */
export const JOINT_PLATES = ['L20', 'T20', 'L30', 'T30', 'L40', 'T40'] as const;

/** End-tap screws by series: the thread, and how far it goes into the tapped bore, mm. */
export const END_TAPS: Record<string, [string, number]> = { '20': ['M5', 12], '30': ['M8', 16], '40': ['M8', 20] };

function buildTNut(node: SceneNode, p: HardwarePart, id: string) {
  const [, , w, l, t] = T_NUTS[p.size] ?? T_NUTS['M5/6'];
  // Long along +Z, the slot's direction; its thread up +Y, out of the slot.
  node.geoms = [boxGeom(`${id}_nut`, [mm(w / 2), mm(t / 2), mm(l / 2)], [0, 0, 0], ZINC, 7100)];
}

/**
 * An inside corner bracket. Its origin is the corner's inside edge, halfway
 * across: one leg runs +X along the face it stands on, the other +Y up the
 * profile it holds, both as wide as the profile along Z.
 */
function buildBracket(node: SceneNode, p: HardwarePart, id: string) {
  const [leg, wall] = CORNER_BRACKETS[p.size] ?? CORNER_BRACKETS['20'];
  const w = Number(p.size) || 20;
  node.geoms = [
    boxGeom(`${id}_leg_a`, [mm(leg / 2), mm(wall / 2), mm(w / 2)], [mm(leg / 2), mm(wall / 2), 0], DIECAST, ALUMINIUM),
    boxGeom(`${id}_leg_b`, [mm(wall / 2), mm(leg / 2), mm(w / 2)], [mm(wall / 2), mm(leg / 2), 0], DIECAST, ALUMINIUM),
    // The gusset across the corner, drawn: the legs carry it.
    visual(gusset(`${id}_gusset`, leg - 1, wall, w * 0.25)),
  ];
}

/** A triangle in XY with its right angle at (wall, wall), `thick` across Z. */
function gusset(name: string, leg: number, wall: number, thick: number): SceneGeom {
  const tri = [[mm(wall), mm(wall)], [mm(leg), mm(wall)], [mm(wall), mm(leg)]];
  const m = prismMesh(tri, -mm(thick / 2), mm(thick / 2));
  return meshGeom(name, m.positions, m.faces, DIECAST);
}

/** The squares a joint plate is made of, in cells, (0, 0) the one over the junction. */
function plateCells(shape: string): [number, number][] {
  return shape === 'T' ? [[-1, 0], [0, 0], [1, 0], [0, 1], [0, 2]] : [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]];
}

/**
 * An L or T joint plate, lying in XY on z = 0 and standing out +Z. Its origin
 * is the middle of the square over the junction; an L's arms run +X and +Y,
 * a T's across ±X and up +Y.
 */
function buildPlate(node: SceneNode, p: HardwarePart, id: string) {
  const shape = p.size[0];
  const cell = Number(p.size.slice(1)) || 20;
  const t = cell <= 20 ? 4 : 5;
  node.geoms = plateCells(shape).map(([i, j], k) => boxGeom(
    `${id}_cell${k}`, [mm(cell / 2), mm(cell / 2), mm(t / 2)], [mm(i * cell), mm(j * cell), mm(t / 2)], DIECAST, ALUMINIUM,
  ));
}

/**
 * An end-tap screw: a button head and its thread, the head up +Z from where
 * it bears, the thread down -Z into the profile's end.
 */
function buildEndTap(node: SceneNode, p: HardwarePart, id: string) {
  const [thread] = END_TAPS[p.size] ?? END_TAPS['20'];
  const d = Number(thread.slice(1));
  const L = p.lengthMm ?? 16;
  node.geoms = [
    cylinderGeom(`${id}_head`, mm(d * 0.95), mm(d * 0.55), mm(d * 0.275), BLACK_OXIDE),
    cylinderGeom(`${id}_shank`, mm(d / 2), mm(L), -mm(L / 2), BLACK_OXIDE),
  ];
}

/** V-slot wheel carriage: a plate over the profile's +Y face, two wheels on its -X slot, one on its +X. */
const WHEEL = { od: 23.9, width: 10.2, centre: 19.85, pitch: 30 };
const PLATE = { length: 60, width: 64, thick: 3, standOff: 7 };

/** How far the carriage reaches along the profile either side of its middle, mm. */
export const CARRIAGE_REACH = Math.max(PLATE.length / 2, WHEEL.pitch / 2 + WHEEL.od / 2);

function buildCarriage(node: SceneNode, _p: HardwarePart, id: string) {
  // A wheel turns about Y, square to the plate: a cylinder's +Z turned onto +Y.
  const turn = [Math.SQRT1_2, -Math.SQRT1_2, 0, 0];
  const wheel = (name: string, x: number, z: number): SceneGeom => ({
    ...cylinderGeom(name, mm(WHEEL.od / 2), mm(WHEEL.width), 0, DELRIN),
    pos: [mm(x), 0, mm(z)], quat: turn,
  });
  const plateY = 10 + PLATE.standOff + PLATE.thick / 2;
  node.geoms = [
    boxGeom(`${id}_plate`, [mm(PLATE.width / 2), mm(PLATE.thick / 2), mm(PLATE.length / 2)], [0, mm(plateY), 0], DIECAST, ALUMINIUM),
    wheel(`${id}_wheel_a`, -WHEEL.centre, -WHEEL.pitch / 2),
    wheel(`${id}_wheel_b`, -WHEEL.centre, WHEEL.pitch / 2),
    wheel(`${id}_wheel_c`, WHEEL.centre, 0),
  ];
}

/** The slide a carriage at `z0` (m, along the profile) may run, kept off both ends. */
export function carriageRange(profileLengthMm: number, z0: number): [number, number] {
  const free = mm(profileLengthMm / 2 - CARRIAGE_REACH);
  return [+(-free - z0).toFixed(6), +(free - z0).toFixed(6)];
}

export const EXTRUSION_PARTS = {
  extrusion: {
    label: 'Extrusion', sizes: Object.keys(PROFILES), defaultSize: '2020', defaultLengthMm: 300, cutToLength: true,
    stockBarsMm: [2000, 1500, 1000],
    hint: 'T-slot aluminium extrusion cut to length. Join two that meet with a corner bracket, a plate or an end-tap screw.',
    name: (p: HardwarePart) => `${p.size.replace('V', ' V-slot')} × ${p.lengthMm} extrusion`,
    build: buildProfile,
  },
  tnut: {
    label: 'T-nut', sizes: Object.keys(T_NUTS), defaultSize: 'M5/6',
    hint: 'A T-nut that slides in a profile\'s slot, for screwing something to the profile anywhere along it.',
    name: (p: HardwarePart) => `${T_NUTS[p.size]?.[0] ?? 'M5'} T-nut, slot ${T_NUTS[p.size]?.[1] ?? 6}`,
    build: buildTNut,
  },
  corner_bracket: {
    label: 'Corner bracket', sizes: Object.keys(CORNER_BRACKETS), defaultSize: '20',
    hint: 'An inside corner bracket. Select two profiles that meet and it goes in their corner, holding them together.',
    name: (p: HardwarePart) => `${p.size} corner bracket`,
    build: buildBracket,
  },
  joint_plate: {
    label: 'Joint plate', sizes: JOINT_PLATES, defaultSize: 'L20',
    hint: 'An L or T joint plate across the outside face of two profiles that meet, holding them together.',
    name: (p: HardwarePart) => `${p.size[0]} joint plate ${p.size.slice(1)}`,
    build: buildPlate,
  },
  end_tap: {
    label: 'End-tap screw', sizes: Object.keys(END_TAPS), defaultSize: '20', lengths: [12, 16, 20, 25, 30], defaultLengthMm: 16,
    hint: 'A screw through one profile into the tapped centre bore of another\'s end, holding them together.',
    name: (p: HardwarePart) => `${END_TAPS[p.size]?.[0] ?? 'M5'}×${p.lengthMm} end-tap screw`,
    build: buildEndTap,
  },
  vslot_carriage: {
    label: 'V-slot carriage', sizes: ['20'], defaultSize: '20',
    hint: 'A wheel plate that runs along a V-slot 2020 profile and stops at its ends. Select the profile first.',
    name: () => 'V-slot carriage',
    build: buildCarriage,
    refit: (carriage: SceneNode, profile: SceneNode) => {
      const L = profile.hardwarePart?.lengthMm;
      const slide = carriage.joints?.find((j) => j.type === 'slide');
      if (L && slide) slide.range = carriageRange(L, carriage.pos[2] ?? 0);
    },
  },
} satisfies Record<string, HardwarePartInfo>;

// ---------------------------------------------------------------------------
// Where two profiles meet
// ---------------------------------------------------------------------------

function findPath(nodes: SceneNode[], id: string, trail: SceneNode[] = []): SceneNode[] | null {
  for (const n of nodes) {
    const here = [...trail, n];
    if (n.id === id) return here;
    const below = findPath(n.children || [], id, here);
    if (below) return below;
  }
  return null;
}

function worldOf(scene: SceneGraph, id: string): THREE.Matrix4 | null {
  const path = findPath(scene.nodes, id);
  if (!path) return null;
  let m: THREE.Matrix4 | undefined;
  for (const n of path) m = getNodeWorldTransform(n, m);
  return m ?? null;
}

export interface Meeting {
  /** The profile whose end it is, and the one whose side that end stands on. */
  a: SceneNode;
  b: SceneNode;
  /** The middle of a's end, world, m. */
  end: THREE.Vector3;
  /** From the end into a: along a, away from b. */
  intoA: THREE.Vector3;
  /** Along b, toward its middle from the junction: where the inside corner is. */
  alongB: THREE.Vector3;
  /** a's half size across, m, in the alongB direction and square to it. */
  halfA: number;
  /** How much of b there is past a's side in the alongB direction, m. */
  roomOnB: number;
  /** And past a's other side, toward b's nearer end, m. */
  roomBack: number;
  /** How far b's met face is from b's axis, m. */
  depthB: number;
  /** The face both outside faces share, outward, and how far it is out from b's axis, m. */
  outward: THREE.Vector3;
  outwardHalfB: number;
  bWorld: THREE.Matrix4;
}

const TOL = 0.0006;

/**
 * Where the end of one of two profiles stands square on a side face of the
 * other: either way round. Null, with the reason, when it does not.
 */
export function meeting(scene: SceneGraph, firstId: string, secondId: string): Meeting | { problem: string } {
  const first = findPath(scene.nodes, firstId)?.at(-1);
  const second = findPath(scene.nodes, secondId)?.at(-1);
  if (!first || !second || first.hardwarePart?.kind !== 'extrusion' || second.hardwarePart?.kind !== 'extrusion') {
    return { problem: 'Select two extrusion profiles: the joint goes where they meet.' };
  }
  for (const [a, b] of [[first, second], [second, first]] as const) {
    const found = endOnSide(scene, a, b);
    if (found) return found;
  }
  return { problem: 'Those two profiles do not meet: the end of one has to stand square against a side of the other.' };
}

function endOnSide(scene: SceneGraph, a: SceneNode, b: SceneNode): Meeting | null {
  const aW = worldOf(scene, a.id);
  const bW = worldOf(scene, b.id);
  if (!aW || !bW) return null;
  const axis = (m: THREE.Matrix4, k: number) => new THREE.Vector3().setFromMatrixColumn(m, k).normalize();
  const zA = axis(aW, 2);
  const zB = axis(bW, 2);
  if (Math.abs(zA.dot(zB)) > 0.02) return null;
  const cA = new THREE.Vector3().setFromMatrixPosition(aW);
  const cB = new THREE.Vector3().setFromMatrixPosition(bW);
  const LA = mm(a.hardwarePart!.lengthMm ?? 300);
  const LB = mm(b.hardwarePart!.lengthMm ?? 300);
  const halfB = profileHalf(b.hardwarePart!.size).map(mm);
  const halfAxy = profileHalf(a.hardwarePart!.size).map(mm);
  const toB = bW.clone().invert();
  const rotB = new THREE.Matrix3().setFromMatrix4(toB);

  for (const sign of [1, -1]) {
    const end = cA.clone().addScaledVector(zA, (sign * LA) / 2);
    const intoA = zA.clone().multiplyScalar(-sign);
    // b's face under the end looks out along intoA.
    const n = intoA.clone().applyMatrix3(rotB).normalize();
    const k = Math.abs(n.x) > 0.99 ? 0 : Math.abs(n.y) > 0.99 ? 1 : -1;
    if (k < 0) continue;
    const s = Math.sign(n.getComponent(k));
    const p = end.clone().applyMatrix4(toB);
    if (Math.abs(p.getComponent(k) - s * halfB[k]) > TOL) continue;
    const other = 1 - k;
    if (Math.abs(p.getComponent(other)) > halfB[other] + TOL || Math.abs(p.z) > LB / 2 + TOL) continue;

    // Inside the corner: along b toward its middle (either way at its middle).
    const towards = cB.clone().sub(end).dot(zB);
    const alongB = zB.clone().multiplyScalar(towards < 0 ? -1 : 1);
    const xA = axis(aW, 0);
    const yA = axis(aW, 1);
    const halfA = Math.abs(alongB.dot(xA)) > 0.99 ? halfAxy[0] : Math.abs(alongB.dot(yA)) > 0.99 ? halfAxy[1] : -1;
    if (halfA < 0) continue;
    const sB = Math.sign(alongB.dot(zB));
    const roomOnB = LB / 2 - sB * p.z - halfA;
    const roomBack = LB / 2 + sB * p.z - halfA;
    // The pieces' own +Z: X along b, Y up a.
    const outward = alongB.clone().cross(intoA).normalize();
    const outwardLocal = outward.clone().applyMatrix3(rotB).normalize();
    const ko = Math.abs(outwardLocal.x) > 0.99 ? 0 : 1;
    return { a, b, end, intoA, alongB, halfA, roomOnB, roomBack, depthB: halfB[k], outward, outwardHalfB: halfB[ko], bWorld: bW };
  }
  return null;
}

/** A world pose as a child's pose under `parentWorld`: pos and MuJoCo [w, x, y, z]. */
function localPose(parentWorld: THREE.Matrix4, origin: THREE.Vector3, x: THREE.Vector3, y: THREE.Vector3) {
  const z = x.clone().cross(y).normalize();
  const world = new THREE.Matrix4().makeBasis(x, y, z).setPosition(origin);
  const local = parentWorld.clone().invert().multiply(world);
  const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scale = new THREE.Vector3();
  local.decompose(pos, quat, scale);
  return { pos: pos.toArray().map((v) => +v.toFixed(7)), quat: [quat.w, quat.x, quat.y, quat.z].map((v) => +v.toFixed(9)) };
}

export type JoinKind = 'corner_bracket' | 'joint_plate' | 'end_tap';

/**
 * The pose a joining piece takes where two profiles meet, as a child of the
 * profile whose side is met (`meeting.b`), and the size it is for them.
 * Or why it cannot go there.
 */
export function joinPose(m: Meeting, kind: JoinKind, size?: string): { pos: number[]; quat: number[]; size: string; lengthMm?: number } | { problem: string } {
  const series = String(PROFILES[m.a.hardwarePart!.size]?.cell ?? 20);
  if (kind === 'corner_bracket') {
    const [leg] = CORNER_BRACKETS[series];
    if (m.roomOnB < mm(leg) - TOL) return { problem: `There is only ${(m.roomOnB * 1000).toFixed(1)} mm of the other profile past this one; a ${series} bracket's leg needs ${leg} mm.` };
    const corner = m.end.clone().addScaledVector(m.alongB, m.halfA);
    return { ...localPose(m.bWorld, corner, m.alongB, m.intoA), size: series };
  }
  if (kind === 'joint_plate') {
    // An arm along b reaches 2.5 cells from a's axis: an L has one, toward b's
    // middle; a T one either way, so it goes only across b's middle.
    const cell = mm(Number(series));
    const reach = (room: number) => room + m.halfA >= 2.5 * cell - TOL;
    const shape = size?.[0] === 'L' || size?.[0] === 'T' ? size[0] : reach(m.roomOnB) && reach(m.roomBack) ? 'T' : 'L';
    if (!reach(m.roomOnB) || (shape === 'T' && !reach(m.roomBack))) {
      return { problem: `There is not enough of the other profile either side of this one for ${shape === 'T' ? 'a T' : 'an L'} plate's arm.` };
    }
    // The square over the junction, on b's axis, out on the face the two share.
    const centre = m.end.clone().addScaledVector(m.intoA, -m.depthB).addScaledVector(m.outward, m.outwardHalfB);
    return { ...localPose(m.bWorld, centre, m.alongB, m.intoA), size: `${shape}${series}` };
  }
  // End tap: from b's far wall, through b, into a's end.
  const [, engage] = END_TAPS[series];
  const lip = (PROFILES[m.b.hardwarePart!.size] ?? PROFILES['2020']).lip;
  const bearing = m.end.clone().addScaledVector(m.intoA, -mm(lip));
  const ax = Math.abs(m.intoA.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const zUp = m.intoA.clone().negate();
  const xAxis = ax.clone().sub(zUp.clone().multiplyScalar(ax.dot(zUp))).normalize();
  const yAxis = zUp.clone().cross(xAxis).normalize();
  return { ...localPose(m.bWorld, bearing, xAxis, yAxis), size: series, lengthMm: Math.ceil(lip + engage) };
}
