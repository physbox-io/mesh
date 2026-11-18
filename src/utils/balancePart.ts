// ---------------------------------------------------------------------------
// Inverse Balance & Ballast ("Make It Stand / Spin / Float")
// ---------------------------------------------------------------------------
//
// Analyses a body's static stability on a flat floor (support polygon margin &
// tip-over angle), dynamic balance on a hinge axis (radial CoM eccentricity),
// and hydrostatic trim in water (equilibrium draft, freeboard, CoB alignment &
// metacentric margin).
//
// `balanceBody` solves the inverse problem without altering the outer silhouette:
// 1. Hollows an internal boolean void (`balance_void`, `csg: 'difference'`) on
//    the heavy/high side while respecting minimum printable wall thickness.
// 2. Seats silent bought-in steel hex nuts (`hardwarePart: { kind: 'nut', ... }`)
//    inside the base/counterweight side — weighed immediately by MuJoCo, omitted
//    from 3D-print STL/3MF exports, and automatically tallied in Make → Parts list.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { SceneGeom, SceneNode } from '../types/scene';
import { applyBodyMass } from './bodyMass';
import { geomMatrixOf, meshVolumeAndCentroid } from './csg';
import { geomVolume } from './deformMaterials';
import { HEX_NUTS } from './hardwareSizes';
import { hardwarePartNode } from './hardwareParts';
import {
  buildHydroBodyModel,
  evaluateSubmerged,
  FRESHWATER_DENSITY,
  geomHydroTriangles,
} from './hydrostatics';

export type BalanceMode = 'stand' | 'spin' | 'float';

export interface StabilityReport {
  massKg: number;
  comLocal: [number, number, number];
  comWorld: [number, number, number];
  boundsLocal: { min: [number, number, number]; max: [number, number, number] };
  stand: {
    stands: boolean;
    /** Positive inside the support polygon, negative when overhanging (mm). */
    edgeMarginMm: number;
    /** Static tilt angle required to tip over the nearest base edge (deg). */
    tipAngleDeg: number;
    /** World Z of the base contact plane (m). */
    baseZ: number;
    supportPolygon: [number, number][];
    supportCentroid: [number, number];
  };
  spin: {
    hasHinge: boolean;
    /** Radial CoM offset from the hinge axis (mm). */
    eccentricityMm: number;
    axisLocal: [number, number, number];
    pivotLocal: [number, number, number];
  };
  float: {
    floats: boolean;
    equilibriumDraftM: number;
    freeboardMm: number;
    /** Horizontal misalignment between CoM and submerged CoB at rest (mm). */
    trimOffsetMm: number;
    /** Approximate vertical stability margin (KB + BM - KG) in mm; > 0 is upright-stable. */
    metacentricMarginMm: number;
    flooded: boolean;
  };
}

export interface BalanceOptions {
  allowVoid?: boolean;
  allowBallast?: boolean;
  minWallMm?: number;
  waterLevel?: number | null;
}

export interface BalanceResult {
  node: SceneNode;
  before: StabilityReport;
  after: StabilityReport;
  voidAdded: boolean;
  ballastNutSize: string | null;
  ballastNutCount: number;
  summary: string;
}

const BALLAST_NUT_CANDIDATES = ['M4', 'M6', 'M8', 'M10', 'M12', 'M16'] as const;

function nodeWorldMatrix(node: SceneNode): THREE.Matrix4 {
  return geomMatrixOf({
    name: node.id,
    type: 'box',
    size: [1, 1, 1],
    pos: node.pos,
    quat: node.quat,
    euler: node.euler,
  });
}

function geomCentroidLocal(g: SceneGeom): THREE.Vector3 {
  if ((g.type === 'cylinder' || g.type === 'capsule') && g.fromto && g.fromto.length >= 6) {
    return new THREE.Vector3(
      0.5 * (g.fromto[0] + g.fromto[3]),
      0.5 * (g.fromto[1] + g.fromto[4]),
      0.5 * (g.fromto[2] + g.fromto[5]),
    );
  }
  if (g.type === 'mesh') {
    const m = geomMatrixOf(g);
    if (g.renderVertices && g.faces) {
      const { centroid } = meshVolumeAndCentroid(g.renderVertices, g.faces);
      return new THREE.Vector3(centroid[0], centroid[1], centroid[2]).applyMatrix4(m);
    }
    if (g.vertices && g.faces) {
      const zup = new Array<number>(g.vertices.length);
      for (let i = 0; i + 2 < g.vertices.length; i += 3) {
        zup[i] = g.vertices[i];
        zup[i + 1] = -g.vertices[i + 2];
        zup[i + 2] = g.vertices[i + 1];
      }
      const { centroid } = meshVolumeAndCentroid(zup, g.faces);
      return new THREE.Vector3(centroid[0], centroid[1], centroid[2]).applyMatrix4(m);
    }
  }
  const p = g.pos ?? [0, 0, 0];
  return new THREE.Vector3(p[0] ?? 0, p[1] ?? 0, p[2] ?? 0);
}

/**
 * Computes composite mass and local Centre of Mass of `node` (including fixed
 * jointless child bodies such as seated steel ballast nuts, and subtracting
 * `csg: 'difference'` voids analytically when a boolean mesh is not yet compiled).
 */
export function computeCompositeMassAndCom(node: SceneNode): {
  massKg: number;
  comLocal: [number, number, number];
  effectiveDensity: number;
} {
  let totalMass = 0;
  const moment = new THREE.Vector3();
  let solidVolSum = 0;
  let solidMassSum = 0;

  const accumulateBody = (n: SceneNode, toRoot: THREE.Matrix4) => {
    const geoms = n.geoms ?? [];
    const compiledVisual = n.csgEnabled ? geoms.find((g) => g.csgDerived === 'visual') : undefined;
    const colliders = n.csgEnabled ? geoms.filter((g) => g.csgDerived === 'collider') : [];

    if (n.csgEnabled && compiledVisual && (colliders.length > 0 || n.collision === 'hull')) {
      // Compiled boolean mesh carries true centroid; total mass from colliders or csgMass
      const stated = n.collisionMass ?? n.mass ?? n.csgMass;
      const colliderMass = colliders.reduce((s, c) => s + (c.mass ?? 0), 0);
      const vol = Math.abs(geomVolume(compiledVisual));
      const dens = n.density ?? geoms.find((g) => g.csg !== 'difference' && !g.csgDerived)?.density ?? 1000;
      const m = stated ?? (colliderMass > 0 ? colliderMass : vol * dens);
      if (m > 0) {
        const c = geomCentroidLocal(compiledVisual).applyMatrix4(toRoot);
        totalMass += m;
        moment.addScaledVector(c, m);
        if (vol > 0) {
          solidVolSum += vol;
          solidMassSum += m;
        }
      }
    } else {
      const positives = applyBodyMass(
        { ...n, csgEnabled: false, csgMass: undefined, collisionMass: undefined },
        geoms.filter((g) => !g.csgDerived && g.csg !== 'difference'),
      );
      let baseDensity = n.density ?? 1000;
      for (const g of positives) {
        if (g.role === 'visual' && !(typeof g.mass === 'number' && g.mass > 0)) continue;
        const vol = Math.abs(geomVolume(g));
        const dens = g.density ?? n.density ?? 1000;
        baseDensity = dens;
        const m = typeof g.mass === 'number' ? Math.max(0, g.mass) : vol * dens;
        if (m <= 0) continue;
        const c = geomCentroidLocal(g).applyMatrix4(toRoot);
        totalMass += m;
        moment.addScaledVector(c, m);
        if (vol > 0) {
          solidVolSum += vol;
          solidMassSum += m;
        }
      }
      // Subtract internal boolean voids analytically when uncompiled or colliding with primitives
      if (n.csgEnabled) {
        for (const cut of geoms.filter((g) => !g.csgDerived && g.csg === 'difference')) {
          const cutVol = Math.abs(geomVolume(cut));
          const cutMass = cutVol * baseDensity;
          if (cutMass > 0 && cutMass < totalMass * 0.85) {
            const c = geomCentroidLocal(cut).applyMatrix4(toRoot);
            totalMass -= cutMass;
            moment.addScaledVector(c, -cutMass);
          }
        }
      }
    }

    for (const ch of n.children ?? []) {
      if ((ch.joints?.length ?? 0) > 0 || ch.simulation) continue;
      const mChild = nodeWorldMatrix(ch);
      accumulateBody(ch, toRoot.clone().multiply(mChild));
    }
  };

  accumulateBody(node, new THREE.Matrix4());
  const com: [number, number, number] = totalMass > 1e-12
    ? [moment.x / totalMass, moment.y / totalMass, moment.z / totalMass]
    : [0, 0, 0];
  const effectiveDensity = solidVolSum > 1e-12 ? solidMassSum / solidVolSum : (node.density ?? 1000);
  return { massKg: Math.max(1e-6, totalMass), comLocal: com, effectiveDensity };
}

/** Monotone-chain 2D convex hull in CCW order. */
function convexHull2D(pts: [number, number][]): [number, number][] {
  if (pts.length <= 1) return pts.slice();
  const sorted = pts
    .slice()
    .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const uniq: [number, number][] = [];
  for (const p of sorted) {
    const last = uniq[uniq.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-5) uniq.push(p);
  }
  if (uniq.length <= 2) return uniq;

  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  const lower: [number, number][] = [];
  for (const p of uniq) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (let i = uniq.length - 1; i >= 0; i--) {
    const p = uniq[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Signed distance from `pt` to CCW polygon `poly`: positive inside, negative outside.
 */
function signedPolygonMargin(poly: [number, number][], pt: [number, number]): number {
  if (poly.length === 0) return -Infinity;
  if (poly.length === 1) return -Math.hypot(pt[0] - poly[0][0], pt[1] - poly[0][1]);
  if (poly.length === 2) {
    const [a, b] = poly;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lenSq = dx * dx + dy * dy;
    const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((pt[0] - a[0]) * dx + (pt[1] - a[1]) * dy) / lenSq)) : 0;
    return -Math.hypot(pt[0] - (a[0] + t * dx), pt[1] - (a[1] + t * dy));
  }
  let minInside = Infinity;
  let insideAll = true;
  let minOutsideDist = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey);
    if (len < 1e-12) continue;
    // Left-hand inward normal for CCW polygon is (-ey, ex) / len
    const signed = (-(pt[0] - a[0]) * ey + (pt[1] - a[1]) * ex) / len;
    if (signed < 0) insideAll = false;
    if (signed < minInside) minInside = signed;

    const t = Math.max(0, Math.min(1, ((pt[0] - a[0]) * ex + (pt[1] - a[1]) * ey) / (len * len)));
    const dist = Math.hypot(pt[0] - (a[0] + t * ex), pt[1] - (a[1] + t * ey));
    if (dist < minOutsideDist) minOutsideDist = dist;
  }
  return insideAll ? minInside : -minOutsideDist;
}

function polygonCentroid(poly: [number, number][]): [number, number] {
  if (poly.length === 0) return [0, 0];
  if (poly.length <= 2) {
    const sx = poly.reduce((s, p) => s + p[0], 0) / poly.length;
    const sy = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    return [sx, sy];
  }
  let area2 = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    area2 += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  if (Math.abs(area2) < 1e-12) {
    return [
      poly.reduce((s, p) => s + p[0], 0) / poly.length,
      poly.reduce((s, p) => s + p[1], 0) / poly.length,
    ];
  }
  return [cx / (3 * area2), cy / (3 * area2)];
}

function collectSurfaceVerticesLocal(node: SceneNode): number[] {
  const tris: number[] = [];
  const geoms = node.csgEnabled
    ? (node.geoms ?? []).filter((g) => g.csgDerived === 'visual')
    : [];
  const source = geoms.length > 0
    ? geoms
    : (node.geoms ?? []).filter((g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual');
  for (const g of source) {
    geomHydroTriangles(g, tris);
  }
  return tris;
}

export function analyzeStability(node: SceneNode, waterLevel: number | null = 0): StabilityReport {
  const worldMat = nodeWorldMatrix(node);
  const { massKg, comLocal } = computeCompositeMassAndCom(node);
  const comWorldV = new THREE.Vector3(...comLocal).applyMatrix4(worldMat);
  const comWorld: [number, number, number] = [comWorldV.x, comWorldV.y, comWorldV.z];

  const localVerts = collectSurfaceVerticesLocal(node);
  let minLx = Infinity, minLy = Infinity, minLz = Infinity;
  let maxLx = -Infinity, maxLy = -Infinity, maxLz = -Infinity;
  const worldPts: [number, number, number][] = [];
  const vTmp = new THREE.Vector3();
  for (let i = 0; i + 2 < localVerts.length; i += 3) {
    const lx = localVerts[i], ly = localVerts[i + 1], lz = localVerts[i + 2];
    if (lx < minLx) minLx = lx;
    if (ly < minLy) minLy = ly;
    if (lz < minLz) minLz = lz;
    if (lx > maxLx) maxLx = lx;
    if (ly > maxLy) maxLy = ly;
    if (lz > maxLz) maxLz = lz;
    vTmp.set(lx, ly, lz).applyMatrix4(worldMat);
    worldPts.push([vTmp.x, vTmp.y, vTmp.z]);
  }
  if (!Number.isFinite(minLx)) {
    minLx = minLy = minLz = -0.02;
    maxLx = maxLy = maxLz = 0.02;
  }

  // 1. Standing support polygon on lowest contact band (within 2.5 mm of min world Z)
  let minWz = Infinity;
  for (const p of worldPts) if (p[2] < minWz) minWz = p[2];
  const contactTol = Math.max(0.0025, (maxLz - minLz) * 0.02);
  const basePts: [number, number][] = worldPts
    .filter((p) => p[2] <= minWz + contactTol)
    .map((p) => [p[0], p[1]]);
  const supportPolygon = convexHull2D(basePts);
  const supportCentroid = polygonCentroid(supportPolygon);
  const edgeMarginM = signedPolygonMargin(supportPolygon, [comWorld[0], comWorld[1]]);
  const comHeightM = Math.max(1e-4, comWorld[2] - (Number.isFinite(minWz) ? minWz : 0));
  const tipAngleDeg = edgeMarginM > 0
    ? (Math.atan2(edgeMarginM, comHeightM) * 180) / Math.PI
    : 0;

  // 2. Spin eccentricity relative to first hinge joint (or local Z axis through origin)
  const hinge = (node.joints ?? []).find((j) => j.type === 'hinge');
  const rawAxis = hinge?.axis ?? [0, 0, 1];
  const axisVec = new THREE.Vector3(rawAxis[0] ?? 0, rawAxis[1] ?? 0, rawAxis[2] ?? 1);
  if (axisVec.lengthSq() < 1e-12) axisVec.set(0, 0, 1);
  axisVec.normalize();
  const pivotRaw = hinge?.pos ?? [0, 0, 0];
  const pivotVec = new THREE.Vector3(pivotRaw[0] ?? 0, pivotRaw[1] ?? 0, pivotRaw[2] ?? 0);
  const relCom = new THREE.Vector3(...comLocal).sub(pivotVec);
  const radialVec = relCom.clone().addScaledVector(axisVec, -relCom.dot(axisVec));
  const eccentricityMm = radialVec.length() * 1000;

  // 3. Hydrostatic equilibrium at current orientation
  const wl = waterLevel ?? 0;
  const hydro = buildHydroBodyModel(node);
  let floats = false;
  let equilibriumDraftM = 0;
  let freeboardMm = 0;
  let trimOffsetMm = 0;
  let metacentricMarginMm = -100;
  let flooded = false;

  if (hydro) {
    const e = worldMat.elements;
    // THREE.Matrix4 is column-major; MuJoCo xmat is row-major 3x3
    const xmat = [
      e[0], e[4], e[8],
      e[1], e[5], e[9],
      e[2], e[6], e[10],
    ];
    let minZ = Infinity, maxZ = -Infinity;
    for (const p of worldPts) {
      if (p[2] < minZ) minZ = p[2];
      if (p[2] > maxZ) maxZ = p[2];
    }
    const height = Math.max(0.002, maxZ - minZ);
    const basePos = [worldMat.elements[12], worldMat.elements[13], worldMat.elements[14]];

    // Max buoyancy just below rim (for open vessels) or fully submerged (for closed hulls)
    let bestDispVol = 0;
    for (let k = 1; k <= 24; k++) {
      const testShift = (wl - minZ) - (k / 24) * height;
      const sub = evaluateSubmerged(hydro, [basePos[0], basePos[1], basePos[2] + testShift], xmat, wl);
      if (sub.volume > bestDispVol) bestDispVol = sub.volume;
    }
    const maxBuoyMass = bestDispVol * FRESHWATER_DENSITY;
    if (maxBuoyMass > massKg * 1.01) {
      floats = true;
      // Solve shift dz where displaced mass == massKg (body moves from high above water down into water)
      let hiShift = (wl - minZ) + 0.001; // bottom barely above water -> V = 0
      let loShift = (wl - maxZ) - 0.01;  // top below water -> V = solidVolume
      // For an open vessel, restrict loShift to where bestDispVol occurred before swamping
      if (hydro.vessel) {
        let peakShift = loShift;
        let peakVol = 0;
        for (let k = 0; k <= 40; k++) {
          const s = hiShift + (k / 40) * (loShift - hiShift);
          const v = evaluateSubmerged(hydro, [basePos[0], basePos[1], basePos[2] + s], xmat, wl).volume;
          if (v > peakVol) {
            peakVol = v;
            peakShift = s;
          }
        }
        loShift = peakShift;
      }
      for (let iter = 0; iter < 28; iter++) {
        const mid = 0.5 * (loShift + hiShift);
        const sub = evaluateSubmerged(hydro, [basePos[0], basePos[1], basePos[2] + mid], xmat, wl);
        if (sub.volume * FRESHWATER_DENSITY < massKg) {
          hiShift = mid; // need deeper immersion (more negative shift)
        } else {
          loShift = mid;
        }
      }
      const eqShift = 0.5 * (loShift + hiShift);
      const eqPos = [basePos[0], basePos[1], basePos[2] + eqShift];
      const eqSub = evaluateSubmerged(hydro, eqPos, xmat, wl);
      const eqMinZ = minZ + eqShift;
      const eqMaxZ = maxZ + eqShift;
      equilibriumDraftM = Math.max(0, wl - eqMinZ);
      freeboardMm = Math.max(0, (eqMaxZ - wl) * 1000);
      flooded = eqSub.floodedFraction > 0.25;
      const eqComZ = comWorld[2] + eqShift;
      trimOffsetMm = Math.hypot(eqSub.cob[0] - comWorld[0], eqSub.cob[1] - comWorld[1]) * 1000;

      // Estimate transverse metacentric radius BM = I_wp / V_sub via finite-difference waterplane area
      const dz = Math.max(1e-4, height * 0.01);
      const subPlus = evaluateSubmerged(hydro, [eqPos[0], eqPos[1], eqPos[2] - dz], xmat, wl);
      const aWp = Math.max(0, (subPlus.volume - eqSub.volume) / dz);
      // Conservative circular/elliptical waterplane second moment I_wp ~ A_wp^2 / (4 * pi)
      const iWp = (aWp * aWp) / (4 * Math.PI);
      const bm = eqSub.volume > 1e-12 ? iWp / eqSub.volume : 0;
      metacentricMarginMm = ((eqSub.cob[2] + bm) - eqComZ) * 1000;
    }
  }

  return {
    massKg: +massKg.toFixed(6),
    comLocal: comLocal.map((v) => +v.toFixed(6)) as [number, number, number],
    comWorld: comWorld.map((v) => +v.toFixed(6)) as [number, number, number],
    boundsLocal: {
      min: [minLx, minLy, minLz].map((v) => +v.toFixed(6)) as [number, number, number],
      max: [maxLx, maxLy, maxLz].map((v) => +v.toFixed(6)) as [number, number, number],
    },
    stand: {
      stands: edgeMarginM > 0.0015 && tipAngleDeg >= 4,
      edgeMarginMm: +(edgeMarginM * 1000).toFixed(2),
      tipAngleDeg: +tipAngleDeg.toFixed(1),
      baseZ: +(Number.isFinite(minWz) ? minWz : 0).toFixed(6),
      supportPolygon,
      supportCentroid: [+supportCentroid[0].toFixed(6), +supportCentroid[1].toFixed(6)],
    },
    spin: {
      hasHinge: !!hinge,
      eccentricityMm: +eccentricityMm.toFixed(3),
      axisLocal: [axisVec.x, axisVec.y, axisVec.z].map((v) => +v.toFixed(5)) as [number, number, number],
      pivotLocal: [pivotVec.x, pivotVec.y, pivotVec.z].map((v) => +v.toFixed(6)) as [number, number, number],
    },
    float: {
      floats,
      equilibriumDraftM: +equilibriumDraftM.toFixed(4),
      freeboardMm: +freeboardMm.toFixed(1),
      trimOffsetMm: +trimOffsetMm.toFixed(2),
      metacentricMarginMm: +metacentricMarginMm.toFixed(2),
      flooded,
    },
  };
}

/** Removes any previous `balance_void` cutter and seated `*_ballast_*` hardware nuts. */
export function clearBalanceAdjustments(node: SceneNode): SceneNode {
  const hadBalanceVoid = (node.geoms ?? []).some((g) => g.name === 'balance_void');
  const nextGeoms = (node.geoms ?? []).filter(
    (g) => g.name !== 'balance_void' && !(hadBalanceVoid && g.csgDerived),
  );
  const nextChildren = (node.children ?? []).filter((c) => !c.id.startsWith(`${node.id}_ballast_`));
  const stillHasCsg = nextGeoms.some((g) => g.csg === 'difference' || g.csg === 'intersection');
  return {
    ...node,
    geoms: nextGeoms.map((g) => ({ ...g })),
    children: nextChildren,
    csgEnabled: stillHasCsg ? node.csgEnabled : undefined,
  };
}

function makeSilentBallastNut(hostId: string, index: number, size: string, posLocal: [number, number, number]): SceneNode {
  const id = `${hostId}_ballast_${index}`;
  const nut = hardwarePartNode({ kind: 'nut', size }, id);
  nut.name = `${size} ballast nut`;
  nut.pos = posLocal.map((v) => +v.toFixed(6));
  nut.joints = [];
  nut.geoms = nut.geoms.map((g) => ({
    ...g,
    contype: 0,
    conaffinity: 0,
  }));
  return nut;
}

function nutMassKg(size: string): number {
  const tmp = hardwarePartNode({ kind: 'nut', size }, 'probe');
  return tmp.geoms[0]?.mass ?? 0.005;
}

/** Chooses the largest standard hex nut whose thickness & across-flats fit comfortably inside the body. */
function chooseBallastNutSize(spansM: [number, number, number], desiredTotalMassKg: number): string {
  const sortedMm = spansM.map((s) => s * 1000).sort((a, b) => a - b);
  const maxHeightMm = Math.max(3.2, sortedMm[0] * 0.72);
  const maxFlatsMm = Math.max(4.5, sortedMm[1] * 0.65);
  let best: string = 'M4';
  for (const sz of BALLAST_NUT_CANDIDATES) {
    const [flats, height] = HEX_NUTS[sz];
    if (flats <= maxFlatsMm && height <= maxHeightMm) {
      best = sz;
      const single = nutMassKg(sz);
      // Prefer a size where 1..4 nuts cover the needed ballast cleanly
      if (single * 3 >= desiredTotalMassKg) break;
    }
  }
  return best;
}

function clampInsideBounds(
  pt: THREE.Vector3,
  bounds: { min: [number, number, number]; max: [number, number, number] },
  marginM: number,
): [number, number, number] {
  const clampAxis = (val: number, lo: number, hi: number) => {
    if (hi - lo <= 2 * marginM) return 0.5 * (lo + hi);
    return Math.max(lo + marginM, Math.min(hi - marginM, val));
  };
  return [
    clampAxis(pt.x, bounds.min[0], bounds.max[0]),
    clampAxis(pt.y, bounds.min[1], bounds.max[1]),
    clampAxis(pt.z, bounds.min[2], bounds.max[2]),
  ];
}

export function balanceBody(
  inputNode: SceneNode,
  mode: BalanceMode,
  opts: BalanceOptions = {},
): BalanceResult {
  const waterLevel = opts.waterLevel ?? 0;
  const allowVoid = opts.allowVoid !== false;
  const allowBallast = opts.allowBallast !== false;
  const minWallM = ((opts.minWallMm ?? 2.4) / 1000);

  const before = analyzeStability(inputNode, waterLevel);
  const working = clearBalanceAdjustments(inputNode);
  const baseReport = analyzeStability(working, waterLevel);
  const { boundsLocal } = baseReport;
  const sx = boundsLocal.max[0] - boundsLocal.min[0];
  const sy = boundsLocal.max[1] - boundsLocal.min[1];
  const sz = boundsLocal.max[2] - boundsLocal.min[2];
  const minSpan = Math.max(0.008, Math.min(sx, sy, sz));

  const worldMat = nodeWorldMatrix(working);
  const invWorldMat = worldMat.clone().invert();

  // Determine target local CoM based on mode
  let targetComLocal: THREE.Vector3;

  if (mode === 'stand') {
    const [cx, cy] = baseReport.stand.supportCentroid;
    let minWz = Infinity;
    const verts = collectSurfaceVerticesLocal(working);
    const tmp = new THREE.Vector3();
    for (let i = 0; i + 2 < verts.length; i += 3) {
      tmp.set(verts[i], verts[i + 1], verts[i + 2]).applyMatrix4(worldMat);
      if (tmp.z < minWz) minWz = tmp.z;
    }
    if (!Number.isFinite(minWz)) minWz = baseReport.comWorld[2] - 0.02;
    const polyRadius = Math.max(
      0.005,
      signedPolygonMargin(baseReport.stand.supportPolygon, [cx, cy]),
    );
    // Aim for >= 18 deg tip-over angle by lowering CoM when base is narrow
    const desiredMaxHeight = polyRadius / Math.tan((18 * Math.PI) / 180);
    const currentHeight = baseReport.comWorld[2] - minWz;
    const targetWorldZ = minWz + Math.min(currentHeight, Math.max(sz * 0.22, desiredMaxHeight));
    targetComLocal = new THREE.Vector3(cx, cy, targetWorldZ).applyMatrix4(invWorldMat);
  } else if (mode === 'spin') {
    const pivot = new THREE.Vector3(...baseReport.spin.pivotLocal);
    const axis = new THREE.Vector3(...baseReport.spin.axisLocal).normalize();
    const rel = new THREE.Vector3(...baseReport.comLocal).sub(pivot);
    // Project CoM directly onto the hinge axis so radial eccentricity = 0
    targetComLocal = pivot.clone().addScaledVector(axis, rel.dot(axis));
  } else {
    // Float upright: align horizontal CoM with true submerged CoB & pull CoM strictly below CoB
    // so even tall-masted buoys and vessels self-right from steep knockdown angles!
    let targetX = 0.5 * (boundsLocal.min[0] + boundsLocal.max[0]);
    let targetY = 0.5 * (boundsLocal.min[1] + boundsLocal.max[1]);
    let keelZ = boundsLocal.min[2] + 0.18 * sz;

    const hydroInit = buildHydroBodyModel(working);
    if (hydroInit) {
      const idXmat = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      let loS = -boundsLocal.max[2] - 0.01;
      let hiS = -boundsLocal.min[2] + 0.001;
      const goalVol = Math.min(hydroInit.solidVolume * 0.72, baseReport.massKg / FRESHWATER_DENSITY);
      for (let it = 0; it < 24; it++) {
        const mid = 0.5 * (loS + hiS);
        const sub = evaluateSubmerged(hydroInit, [0, 0, mid], idXmat, 0);
        if (sub.volume < goalVol) hiS = mid;
        else loS = mid;
      }
      const eqS = 0.5 * (loS + hiS);
      const eqSub = evaluateSubmerged(hydroInit, [0, 0, eqS], idXmat, 0);
      if (eqSub.volume > 1e-9) {
        targetX = eqSub.cob[0];
        targetY = eqSub.cob[1];
        const cobLocalZ = eqSub.cob[2] - eqS;
        keelZ = Math.max(
          boundsLocal.min[2] + 0.010,
          Math.min(keelZ, cobLocalZ - Math.max(0.014, 0.09 * sz)),
        );
      }
    }
    targetComLocal = new THREE.Vector3(targetX, targetY, Math.min(baseReport.comLocal[2], keelZ));
  }

  let voidAdded = false;
  const candidatePrims = (working.geoms ?? []).filter(
    (g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual' && g.type !== 'mesh' && g.type !== 'plane',
  );

  // Check whether a floating body already has ample reserve buoyancy (>32%) so keel ballast alone suffices
  const { effectiveDensity } = computeCompositeMassAndCom(working);
  const needsVoidInFloat =
    mode !== 'float' ||
    !baseReport.float.floats ||
    effectiveDensity > FRESHWATER_DENSITY * 0.68;

  // Step 1: Cut an internal `balance_void` ellipsoid strictly inside a single host primitive on the heavy side
  if (allowVoid && needsVoidInFloat && candidatePrims.length > 0) {
    const curCom = new THREE.Vector3(...baseReport.comLocal);
    const shiftNeeded = targetComLocal.clone().sub(curCom);
    const heavyDir = shiftNeeded.length() > 1e-5
      ? shiftNeeded.clone().negate().normalize()
      : new THREE.Vector3(0, 0, 1);

    // Pick the primitive geom with the best combination of interior volume & alignment toward `heavyDir`
    let bestBox: { min: [number, number, number]; max: [number, number, number] } | null = null;
    let bestScore = -Infinity;
    for (const g of candidatePrims) {
      const tris: number[] = [];
      geomHydroTriangles(g, tris);
      if (tris.length < 9) continue;
      let gx0 = Infinity, gy0 = Infinity, gz0 = Infinity;
      let gx1 = -Infinity, gy1 = -Infinity, gz1 = -Infinity;
      for (let i = 0; i + 2 < tris.length; i += 3) {
        if (tris[i] < gx0) gx0 = tris[i];
        if (tris[i + 1] < gy0) gy0 = tris[i + 1];
        if (tris[i + 2] < gz0) gz0 = tris[i + 2];
        if (tris[i] > gx1) gx1 = tris[i];
        if (tris[i + 1] > gy1) gy1 = tris[i + 1];
        if (tris[i + 2] > gz1) gz1 = tris[i + 2];
      }
      const gsx = gx1 - gx0, gsy = gy1 - gy0, gsz = gz1 - gz0;
      if (gsx <= 3 * minWallM || gsy <= 3 * minWallM || gsz <= 3 * minWallM) continue;
      const gCenter = new THREE.Vector3(0.5 * (gx0 + gx1), 0.5 * (gy0 + gy1), 0.5 * (gz0 + gz1));
      const gRho = g.density ?? working.density ?? 1000;
      const score = gRho * gsx * gsy * gsz * (1 + Math.max(-0.5, gCenter.clone().sub(targetComLocal).dot(heavyDir) * 10));
      if (score > bestScore) {
        bestScore = score;
        bestBox = { min: [gx0, gy0, gz0], max: [gx1, gy1, gz1] };
      }
    }

    if (bestBox) {
      const gsx = bestBox.max[0] - bestBox.min[0];
      const gsy = bestBox.max[1] - bestBox.min[1];
      const gsz = bestBox.max[2] - bestBox.min[2];
      const maxVoidRx = Math.max(0.002, 0.36 * (gsx * 0.5 - minWallM));
      const maxVoidRy = Math.max(0.002, 0.36 * (gsy * 0.5 - minWallM));
      const maxVoidRz = Math.max(0.002, 0.34 * (gsz * 0.5 - minWallM));

      const centerBounds = new THREE.Vector3(
        0.5 * (bestBox.min[0] + bestBox.max[0]),
        0.5 * (bestBox.min[1] + bestBox.max[1]),
        0.5 * (bestBox.min[2] + bestBox.max[2]),
      );
      const halfSpan = new THREE.Vector3(
        Math.max(0, gsx * 0.5 - minWallM - maxVoidRx),
        Math.max(0, gsy * 0.5 - minWallM - maxVoidRy),
        Math.max(0, gsz * 0.5 - minWallM - maxVoidRz),
      );
      const voidPosVec = new THREE.Vector3(
        centerBounds.x + heavyDir.x * halfSpan.x * 0.85,
        centerBounds.y + heavyDir.y * halfSpan.y * 0.85,
        centerBounds.z + heavyDir.z * halfSpan.z * 0.85,
      );

      const maxVoidVol = (4 / 3) * Math.PI * maxVoidRx * maxVoidRy * maxVoidRz;
      const lever = voidPosVec.distanceTo(targetComLocal);
      let scale = 0.85;
      if (lever > 1e-4 && effectiveDensity > 0) {
        const idealVoidMass = (baseReport.massKg * curCom.distanceTo(targetComLocal)) / lever;
        const idealVol = idealVoidMass / effectiveDensity;
        scale = Math.min(1, Math.max(0.25, Math.cbrt(idealVol / Math.max(1e-12, maxVoidVol))));
      }
      if (mode === 'float' && !baseReport.float.floats && effectiveDensity > FRESHWATER_DENSITY * 0.85) {
        scale = 1;
      }

      const rx = +(maxVoidRx * scale).toFixed(5);
      const ry = +(maxVoidRy * scale).toFixed(5);
      const rz = +(maxVoidRz * scale).toFixed(5);
      if (rx >= 0.002 && ry >= 0.002 && rz >= 0.002) {
        const voidGeom: SceneGeom = {
          name: 'balance_void',
          type: 'ellipsoid',
          size: [rx, ry, rz],
          pos: [
            +voidPosVec.x.toFixed(6),
            +voidPosVec.y.toFixed(6),
            +voidPosVec.z.toFixed(6),
          ],
          csg: 'difference',
          rgba: [0.95, 0.55, 0.25, 0.35],
        };
        working.geoms = [...(working.geoms ?? []), voidGeom];
        working.csgEnabled = true;
        if (!working.collision) working.collision = 'hull';
        voidAdded = true;
      }
    }
  }

  // Step 2: Seat silent steel hex-nut ballast so MuJoCo's composite CoM hits the target immediately
  // Note: before OpenSCAD compiles `balance_void`, MuJoCo weighs the un-cut primitives, so we size
  // ballast against the live MuJoCo mass (`uncompiledView`) while keeping float displacement headroom!
  let ballastNutSize: string | null = null;
  let ballastNutCount = 0;

  if (allowBallast) {
    const liveViewNode: SceneNode = { ...working, csgEnabled: false };
    const { massKg: liveMass, comLocal: liveComArr } = computeCompositeMassAndCom(liveViewNode);
    const liveCom = new THREE.Vector3(...liveComArr);
    const delta = targetComLocal.clone().sub(liveCom);

    if (delta.length() > 0.00035) {
      const dir = delta.clone().normalize();
      // Place ballast as far in `dir` as interior clearance allows so nut count is minimal
      const nutMargin = Math.min(0.006, minSpan * 0.22);
      const extremeCandidate = new THREE.Vector3(
        dir.x >= 0 ? boundsLocal.max[0] : boundsLocal.min[0],
        dir.y >= 0 ? boundsLocal.max[1] : boundsLocal.min[1],
        dir.z >= 0 ? boundsLocal.max[2] : boundsLocal.min[2],
      );
      // Blend along ray from targetComLocal in direction `dir` to boundary
      let tRay = Infinity;
      const bMin = boundsLocal.min;
      const bMax = boundsLocal.max;
      for (let a = 0; a < 3; a++) {
        const dComp = dir.getComponent(a);
        const oComp = targetComLocal.getComponent(a);
        if (Math.abs(dComp) > 1e-6) {
          const bound = dComp > 0 ? bMax[a] - nutMargin : bMin[a] + nutMargin;
          const t = (bound - oComp) / dComp;
          if (t > 0 && t < tRay) tRay = t;
        }
      }
      const seatAnchor = Number.isFinite(tRay)
        ? targetComLocal.clone().addScaledVector(dir, tRay)
        : extremeCandidate;
      const clampedAnchor = clampInsideBounds(seatAnchor, boundsLocal, nutMargin);
      const anchorVec = new THREE.Vector3(...clampedAnchor);

      // Lever arm past targetComLocal along `dir`
      const leverPastTarget = anchorVec.clone().sub(targetComLocal).dot(dir);
      const distToTarget = delta.length();

      if (leverPastTarget > 0.0008) {
        let requiredBallastKg = (liveMass * distToTarget) / leverPastTarget;
        if (mode === 'float') {
          const hydro = buildHydroBodyModel(working);
          if (hydro) {
            // Measure true peak displacement across immersion depths so ballast never sinks the part!
            let peakDispVol = hydro.solidVolume;
            if (hydro.vessel) {
              const idXmat = [1, 0, 0, 0, 1, 0, 0, 0, 1];
              for (let k = 1; k <= 20; k++) {
                const zTest = boundsLocal.min[2] + (k / 20) * (boundsLocal.max[2] - boundsLocal.min[2]);
                const sub = evaluateSubmerged(hydro, [0, 0, -zTest], idXmat, 0);
                if (sub.volume > peakDispVol) peakDispVol = sub.volume;
              }
            }
            const maxSafeTotalMass = peakDispVol * FRESHWATER_DENSITY * 0.78;
            requiredBallastKg = Math.min(requiredBallastKg, Math.max(0, maxSafeTotalMass - liveMass));
          }
        }
        if (requiredBallastKg > 0.0004) {
          const szNut = chooseBallastNutSize([sx, sy, sz], requiredBallastKg);
          const mOne = nutMassKg(szNut);
          const count = Math.max(1, Math.min(16, Math.round(requiredBallastKg / mOne)));
          // Fine-tune exact seat position between targetComLocal and anchorVec so integer `count` nuts
          // land the composite CoM directly on `targetComLocal`!
          const exactLever = (liveMass * distToTarget) / (count * mOne);
          const usableLever = Math.min(leverPastTarget, exactLever);
          const exactSeat = targetComLocal.clone().addScaledVector(dir, usableLever);
          const finalCenter = clampInsideBounds(exactSeat, boundsLocal, nutMargin * 0.6);

          // Spread multiple nuts compactly perpendicular to `dir` around `finalCenter`
          const nutHeightM = (HEX_NUTS[szNut]?.[1] ?? 6.8) / 1000;
          const perpA = Math.abs(dir.z) < 0.9
            ? new THREE.Vector3(-dir.y, dir.x, 0).normalize()
            : new THREE.Vector3(1, 0, 0);
          const nuts: SceneNode[] = [];
          for (let k = 0; k < count; k++) {
            const offsetIdx = k - (count - 1) / 2;
            const p = new THREE.Vector3(...finalCenter).addScaledVector(perpA, offsetIdx * Math.min(nutHeightM * 0.5, minSpan * 0.06));
            const posLocal = clampInsideBounds(p, boundsLocal, nutMargin * 0.4);
            nuts.push(makeSilentBallastNut(working.id, k + 1, szNut, posLocal));
          }
          working.children = [...(working.children ?? []), ...nuts];
          ballastNutSize = szNut;
          ballastNutCount = count;
        }
      }
    }
  }

  const after = analyzeStability(working, waterLevel);
  const partsDesc: string[] = [];
  if (voidAdded) partsDesc.push('hollowed internal void');
  if (ballastNutCount > 0 && ballastNutSize) {
    partsDesc.push(`seated ${ballastNutCount}× ${ballastNutSize} steel nut${ballastNutCount > 1 ? 's' : ''}`);
  }
  const actionStr = partsDesc.length > 0 ? partsDesc.join(' + ') : 'already balanced';
  const metricStr = mode === 'stand'
    ? `tip angle ${before.stand.tipAngleDeg}° → ${after.stand.tipAngleDeg}°`
    : mode === 'spin'
      ? `axis offset ${before.spin.eccentricityMm.toFixed(2)} mm → ${after.spin.eccentricityMm.toFixed(2)} mm`
      : `trim offset ${before.float.trimOffsetMm.toFixed(1)} mm → ${after.float.trimOffsetMm.toFixed(1)} mm`;

  return {
    node: working,
    before,
    after,
    voidAdded,
    ballastNutSize,
    ballastNutCount,
    summary: `${actionStr} (${metricStr})`,
  };
}
