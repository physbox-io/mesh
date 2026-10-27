// ---------------------------------------------------------------------------
// Timber Breakdown, made from its cut list and its mortising programs
// ---------------------------------------------------------------------------
//
// The breakdown hands over a cut list (each member's finished size, its tenons
// as sawn) and a G-code program for each CNC window setup, with a setup sheet
// saying which face is up, which face goes against the fence, and how far past
// the stop the top end slides. This makes the parts from those, the way the
// shop would, and puts them together:
//
// - Each member is its finished blank, with the tenons the card lists sawn on
//   its ends.
// - Each window's program is run through the cut simulator, in the frame the
//   part actually sits in on the bed: the face the sheet says is up, up, and the
//   top end against the Y0 stop past it by the offset. Those two fix the part,
//   so the face at the fence is whichever one that puts there; when the sheet
//   names another, the sheet cannot be followed, and that is reported.
// - Each tenon is pushed into its mortise as milled, until it bottoms or its
//   shoulder meets the face. A tenon that hits the floor, or misses the pocket
//   and lands on the face, leaves its shoulder standing off the leg; one wider
//   than the pocket, or off to one side of it, shows in the slack either side.
//
// Everything is in the breakdown's own frame, millimetres, Z up: the frame of
// the first part picked, which the caller puts back into the scene.

import type { Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import { simulateMilling, type CutResult } from './cutSimulation';
import { buildSimulationMesh } from './simulationMesh';
import { manifoldToMeshMm, meshMmToManifold, type TimberMember } from './timberBreakdown';
import { memberFaceNumber, type CncWindowSetup, type TimberCutPlan } from './timberCutList';
import type { TimberBreakdownResult } from './timberJoinery';
import type { AddSimulationRequest } from '../hooks/useAddSimulation';
import type { StockTransform } from './reliefCarveExporter';
import type { SceneNode } from '../types/scene';
import { getNodeWorldTransform } from './laserCutExporter';

type V3 = [number, number, number];

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const neg = (a: V3): V3 => [-a[0], -a[1], -a[2]];

export interface TimberJointFit {
  jointId: string;
  /** The rail whose tenon it is, and the member it goes into. */
  rail: string;
  host: string;
  /** How far the shoulder stands off the face with the tenon pushed home, mm: 0 when it seats. */
  shoulderGapMm: number;
  /** Room in the mortise as milled either side of the tenon, across its width and its thickness, mm. */
  slackWidthMm: number;
  slackThicknessMm: number;
  /** How far the middle of the pocket is from the middle of the tenon, mm. */
  offCentreMm: number;
}

export interface TimberSimJobOptions {
  breakdown: TimberBreakdownResult;
  cutPlan: TimberCutPlan;
  /** Simulation grid, mm. Default 0.1. */
  cellMm?: number;
}

export interface TimberSimJobResult {
  /** The parts, mm, Z up, in the breakdown's frame. */
  positions: Float32Array;
  faces: Uint32Array;
  volumeMm3: number;
  parts: number;
  windows: number;
  joints: TimberJointFit[];
  /** Setup sheets that cannot be followed as written. */
  setupFaults: string[];
  /** Mortises with no program, cut by hand, so not simulated. */
  byHand: number;
  cellMm: number;
}

/** The numbered face's outward normal: F1, F2 the reference faces, F3, F4 their opposites. */
function faceNormal(m: TimberMember, label: string): V3 | null {
  const k = Number(/F(\d)/.exec(label)?.[1]);
  const n = k === 1 || k === 3 ? m.face1.normal : k === 2 || k === 4 ? m.face2.normal : null;
  if (!n) return null;
  return k <= 2 ? [n[0], n[1], n[2]] : [-n[0], -n[1], -n[2]];
}

/** Half the member's extent along a unit direction square to its faces. */
const halfAlong = (m: TimberMember, n: ArrayLike<number>) =>
  m.axes.reduce((s, a, i) => s + (Math.abs(dot(a, n)) * m.dimsMm[i]) / 2, 0);

/** A window setup as the part sits on the bed: machine X, Y, Z in the breakdown's frame, and its origin. */
interface WindowFrame {
  setup: CncWindowSetup;
  origin: V3;
  x: V3;
  y: V3;
  z: V3;
  widthMm: number;
  lengthMm: number;
  cut?: CutResult;
}

function windowFrame(m: TimberMember, setup: CncWindowSetup, faults: string[]): WindowFrame | null {
  const up = faceNormal(m, setup.faceUpLabel);
  if (!up) return null;
  const a0: V3 = [m.axes[0][0], m.axes[0][1], m.axes[0][2]];
  // Down the part from its top end, which is against the stop at Y0.
  const y = neg(a0);
  const z = up;
  const x = cross(y, z);
  // The face at X0 is the one against the fence.
  const atFence = memberFaceNumber(m, neg(x));
  const named = Number(/F(\d)/.exec(setup.fenceFaceLabel)?.[1]);
  if (named && named !== atFence) {
    faults.push(
      `${setup.id}: with ${setup.faceUpLabel} up and the top end at the stop, Face F${atFence} is against the fence, not ${setup.fenceFaceLabel}`
    );
  }
  const c: V3 = [m.centerMm[0], m.centerMm[1], m.centerMm[2]];
  const widthMm = 2 * halfAlong(m, x);
  const origin = add(add(add(c, scale(x, -widthMm / 2)), scale(a0, m.dimsMm[0] / 2 - setup.indexOffsetFromTopMm)), scale(z, halfAlong(m, z)));
  return { setup, origin, x, y, z, widthMm, lengthMm: m.dimsMm[0] - setup.indexOffsetFromTopMm };
}

/** A point in the breakdown's frame in a window's machine coordinates. */
const toWindow = (w: WindowFrame, p: V3): V3 => {
  const d: V3 = [p[0] - w.origin[0], p[1] - w.origin[1], p[2] - w.origin[2]];
  return [dot(d, w.x), dot(d, w.y), dot(d, w.z)];
};

/** Column-major placement of a unit-axis frame at `c`, right-handed whatever `w` was. */
function frameMat4(u: V3, v: V3, c: V3): Mat4 {
  const w = cross(u, v);
  return [u[0], u[1], u[2], 0, v[0], v[1], v[2], 0, w[0], w[1], w[2], 0, c[0], c[1], c[2], 1] as Mat4;
}

/** What a window's program took out, as a solid: from just above the face down to the cut. */
function removedSolid(wasm: ManifoldToplevel, w: WindowFrame): Manifold | null {
  const cut = w.cut!;
  let i0 = cut.cols, i1 = -1, j0 = cut.rows, j1 = -1;
  for (let j = 0; j < cut.rows; j++) {
    for (let i = 0; i < cut.cols; i++) {
      if (cut.heights[j * cut.cols + i] < -1e-3) {
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
    }
  }
  if (i1 < 0) return null;
  // A margin of uncut cells, so the solid stops inside the crop.
  i0 = Math.max(0, i0 - 2); j0 = Math.max(0, j0 - 2);
  i1 = Math.min(cut.cols - 1, i1 + 2); j1 = Math.min(cut.rows - 1, j1 + 2);
  const cols = i1 - i0 + 1, rows = j1 - j0 + 1;
  const top = new Float64Array(cols * rows), bottom = new Float64Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const h = cut.heights[(j + j0) * cut.cols + (i + i0)];
      bottom[j * cols + i] = h;
      // Through the face, so the cut opens cleanly; nothing where nothing was cut.
      top[j * cols + i] = h < -1e-3 ? 0.5 : h;
    }
  }
  const mesh = buildSimulationMesh({
    cols, rows, cell: cut.cell,
    originX: cut.originX + i0 * cut.cell, originY: cut.originY + j0 * cut.cell,
    widthMm: cols * cut.cell, depthMm: rows * cut.cell,
    top, bottom,
  }, { maxTriangles: 60_000 });
  const p = mesh.positions;
  const out = new Float32Array(p.length);
  for (let k = 0; k < p.length; k += 3) {
    const q = add(add(add(w.origin, scale(w.x, p[k])), scale(w.y, p[k + 1])), scale(w.z, p[k + 2]));
    out[k] = q[0]; out[k + 1] = q[1]; out[k + 2] = q[2];
  }
  try {
    return meshMmToManifold(wasm, out, mesh.faces);
  } catch {
    return null;
  }
}

export function runTimberSimulation(
  wasm: ManifoldToplevel,
  o: TimberSimJobOptions,
  onProgress?: (fraction: number) => void
): TimberSimJobResult {
  const { breakdown, cutPlan } = o;
  const faults: string[] = [];
  const byPart = new Map<string, WindowFrame[]>();

  // Every window's program, run where the part sits.
  const setups = cutPlan.allCncSetups;
  let cellMm = o.cellMm ?? 0.1;
  setups.forEach((setup, k) => {
    onProgress?.((k / Math.max(1, setups.length)) * 0.7);
    const part = breakdown.parts.find((p) => p.member.id === setup.partId);
    if (!part) return;
    const w = windowFrame(part.member, setup, faults);
    if (!w || w.lengthMm <= 0) return;
    w.cut = simulateMilling(setup.gcode, {
      widthMm: w.widthMm,
      depthMm: w.lengthMm,
      tools: { 1: { shape: 'flat', diameterMm: setup.cutterDiaMm } },
      cellMm: o.cellMm ?? 0.1,
    });
    cellMm = Math.max(cellMm, w.cut.cell);
    const list = byPart.get(part.member.id) ?? [];
    list.push(w);
    byPart.set(part.member.id, list);
  });

  // How deep the host is cut at a point on its face, over every window on that face.
  const depthAt = (host: string, p: V3, faceN: V3) => {
    let deepest = 0;
    for (const w of byPart.get(host) ?? []) {
      if (dot(w.z, faceN) < 0.9 || !w.cut) continue;
      const [x, y] = toWindow(w, p);
      if (x < 0 || y < 0 || x > w.widthMm || y > w.lengthMm) continue;
      deepest = Math.max(deepest, -w.cut.at(x, y));
    }
    return deepest;
  };

  const joints: TimberJointFit[] = [];
  let byHand = 0;
  for (const j of breakdown.joints) {
    const t = j.tenon, m = j.mortise;
    if (!t || !m) continue;
    const faceN = m.faceNormal as V3;
    // A part too big for the machine has its mortises cut by hand: no program to run.
    if (!(byPart.get(m.hostMemberId) ?? []).some((w) => dot(w.z, faceN) >= 0.9)) {
      byHand++;
      continue;
    }
    const u = t.uAxis as V3, v = t.vAxis as V3, c = t.shoulderCenterMm as V3;
    const at = (s: number, r: number) => depthAt(m.hostMemberId, add(add(c, scale(u, s)), scale(v, r)), faceN);
    // Pushed in until some part of its end meets the floor, or the face.
    const step = Math.max(0.1, cellMm);
    // Its faces in half a cell: a cheek flush with the wall is a fit, not a miss.
    const hw = Math.max(0, t.widthMm / 2 - step / 2), ht = Math.max(0, t.thicknessMm / 2 - step / 2);
    let reach = Infinity;
    for (let s = -hw; s <= hw + 1e-9; s += step) {
      for (let r = -ht; r <= ht + 1e-9; r += step) {
        reach = Math.min(reach, at(Math.min(s, hw), Math.min(r, ht)));
      }
    }
    const shoulderGapMm = Math.max(0, t.lengthMm - reach);
    // The pocket's walls, out from the tenon's middle along each axis: where
    // it is less than half as deep as the tenon is long.
    const wall = (ds: number, dr: number) => {
      const floor = Math.min(t.lengthMm, at(0, 0)) / 2;
      let d = 0;
      const far = Math.max(t.widthMm, t.thicknessMm) * 2 + 20;
      while (d < far && at(ds * d, dr * d) > floor) d += step / 2;
      return d;
    };
    const [wp, wn, tp, tn] = [wall(1, 0), wall(-1, 0), wall(0, 1), wall(0, -1)];
    joints.push({
      jointId: j.id,
      rail: t.railMemberId,
      host: m.hostMemberId,
      shoulderGapMm,
      slackWidthMm: wp + wn - t.widthMm,
      slackThicknessMm: tp + tn - t.thicknessMm,
      offCentreMm: Math.hypot((wp - wn) / 2, (tp - tn) / 2),
    });
  }

  // The parts: blanks, tenons sawn on, pockets milled out.
  const positions: number[] = [];
  const faces: number[] = [];
  let volumeMm3 = 0;
  breakdown.parts.forEach((part, k) => {
    onProgress?.(0.7 + (k / Math.max(1, breakdown.parts.length)) * 0.3);
    const mem = part.member;
    const a0 = mem.axes[0] as V3, a1 = mem.axes[1] as V3;
    const blank = wasm.Manifold.cube(mem.dimsMm as [number, number, number], true);
    let solid = blank.transform(frameMat4(a0, a1, mem.centerMm as V3));
    blank.delete();
    for (const t of part.tenons) {
      const box = wasm.Manifold.cube([t.widthMm, t.thicknessMm, t.lengthMm], true);
      const out = t.outwardDir as V3;
      // Its third axis along `out`, from the shoulder.
      const placed = box.transform(frameMat4(t.uAxis as V3, cross(out, t.uAxis as V3), add(t.shoulderCenterMm as V3, scale(out, t.lengthMm / 2))));
      box.delete();
      const next = solid.add(placed);
      placed.delete(); solid.delete();
      solid = next;
    }
    for (const w of byPart.get(mem.id) ?? []) {
      const gone = removedSolid(wasm, w);
      if (!gone) continue;
      const next = solid.subtract(gone);
      gone.delete(); solid.delete();
      solid = next;
    }
    const mesh = manifoldToMeshMm(solid);
    solid.delete();
    const base = positions.length / 3;
    for (const p of mesh.positionsMm) positions.push(p);
    for (const f of mesh.faces) faces.push(base + f);
    volumeMm3 += mesh.volumeMm3;
  });
  onProgress?.(1);

  return {
    positions: new Float32Array(positions),
    faces: new Uint32Array(faces),
    volumeMm3,
    parts: breakdown.parts.length,
    windows: setups.length,
    joints,
    setupFaults: faults,
    byHand,
    cellMm,
  };
}

/**
 * The parts' place in the scene: `frameToWorld` is the breakdown frame's world
 * matrix (three's column-major elements, metres), the first picked body's.
 */
export function timberSimulationRequest(
  sim: TimberSimJobResult,
  frameToWorld: ArrayLike<number>
): { figures: Record<string, unknown>; request: Omit<AddSimulationRequest, 'placement'> } {
  const e = frameToWorld;
  const p = sim.positions;
  const world = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] / 1000, y = p[i + 1] / 1000, z = p[i + 2] / 1000;
    world[i] = (e[0] * x + e[4] * y + e[8] * z + e[12]) * 1000;
    world[i + 1] = (e[1] * x + e[5] * y + e[9] * z + e[13]) * 1000;
    world[i + 2] = (e[2] * x + e[6] * y + e[10] * z + e[14]) * 1000;
  }
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < world.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], world[i]);
    hi[i % 3] = Math.max(hi[i % 3], world[i]);
  }
  const transform: StockTransform = { modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: lo, modelMaxMm: hi };
  const worstGap = sim.joints.reduce<TimberJointFit | null>((w, j) => (!w || j.shoulderGapMm > w.shoulderGapMm ? j : w), null);
  const tight = sim.joints.filter((j) => j.slackWidthMm < -0.05 || j.slackThicknessMm < -0.05);
  const offCentre = sim.joints.reduce((m, j) => Math.max(m, j.offCentreMm), 0);
  const r2 = (v: number) => +v.toFixed(2);
  return {
    figures: {
      parts: sim.parts,
      windows: sim.windows,
      joints: sim.joints.length,
      largestShoulderGapMm: worstGap ? r2(worstGap.shoulderGapMm) : 0,
      worstJoint: worstGap && worstGap.shoulderGapMm > 0.05 ? { rail: worstGap.rail, host: worstGap.host, shoulderGapMm: r2(worstGap.shoulderGapMm) } : null,
      tooTight: tight.map((j) => ({ rail: j.rail, host: j.host, slackWidthMm: r2(j.slackWidthMm), slackThicknessMm: r2(j.slackThicknessMm) })),
      mostOffCentreMm: r2(offCentre),
      setupFaults: sim.setupFaults,
      mortisesByHand: sim.byHand,
      cellMm: sim.cellMm,
    },
    request: {
      mesh: { positions: world, faces: sim.faces },
      transform,
      kind: 'timber',
      label: 'Timber frame',
      details: [
        `${sim.parts} parts from the cut list, ${sim.windows} mortising program${sim.windows === 1 ? '' : 's'} cut on a ${sim.cellMm.toFixed(2)} mm grid`,
        !worstGap || worstGap.shoulderGapMm <= 0.05
          ? `Every tenon goes home: ${sim.joints.length} joints, shoulders on the face`
          : `**${worstGap.rail}'s shoulder stands ${worstGap.shoulderGapMm.toFixed(2)} mm off ${worstGap.host}**: its tenon stops short in the mortise as milled`,
        ...(tight.length ? [`**${tight.length} tenon${tight.length === 1 ? ' is' : 's are'} wider than the mortise milled for ${tight.length === 1 ? 'it' : 'them'}**`] : []),
        ...(offCentre > 0.25 ? [`A mortise is up to ${offCentre.toFixed(2)} mm off its tenon's centre`] : []),
        ...sim.setupFaults.map((f) => `**Setup sheet:** ${f}`),
        ...(sim.byHand ? [`${sim.byHand} mortise${sim.byHand === 1 ? '' : 's'} cut by hand, not simulated: too big for the CNC`] : []),
        'Mitred tenon tips are sawn square here',
      ],
    },
  };
}

/**
 * The breakdown's frame in the scene: the first picked body's world matrix
 * (`collectIndividualPartSoups` works in it), three's column-major elements.
 */
export function breakdownFrameToWorld(nodes: SceneNode[], firstId: string): number[] | null {
  const walk = (list: SceneNode[], parent?: ReturnType<typeof getNodeWorldTransform>): number[] | null => {
    for (const n of list) {
      const world = getNodeWorldTransform(n, parent);
      if (n.id === firstId) return world.elements.slice();
      const hit = walk(n.children || [], world);
      if (hit) return hit;
    }
    return null;
  };
  return walk(nodes);
}
