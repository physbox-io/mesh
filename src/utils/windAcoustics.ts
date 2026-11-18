// ---------------------------------------------------------------------------
// 3D Cross-Section Slicer & 1D Conical Transfer-Matrix Bore Acoustics (TMM)
// ---------------------------------------------------------------------------
//
// 1. Slices ANY 3D body's positive primitives AND triangle meshes (`renderVertices`,
//    `faces` — straight pipes, flared bells, multi-branch folded horns, or live
//    sculpted shells) with 2D cross-section planes to extract:
//      - Unfolded 3D airway length (via Cauchy branch-loop clustering)
//      - Open polar hydraulic radius r_eff(s) (shrinks when baffles/mutes are
//        sculpted inside the bell or bore!)
//      - Topological genus g = C - (V - E + F)/2 & 2D ray-escape / C-loop breaches
//        to locate sculpted side-holes & boolean toneholes in 3D!
//
// 2. Solves the exact 1D Helmholtz wave equation via 2x2 spherical-wave conical
//    acoustic transfer matrices (Caussé et al. 1984) with Kirchhoff thermo-viscous
//    wall losses, Levine–Schwinger radiation impedance, and Keefe complex tonehole
//    shunt admittances to obtain Z_in(f), playable resonance peaks, and the actual
//    radiated harmonic spectrum H_1..H_10!
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneNode, WindExciterKind, WindInstrumentSpec } from '../types/scene';

const SPEED_OF_SOUND_WARM_AIR = 349; // m/s at ~28 °C breath temperature
const AIR_DENSITY = 1.18; // kg/m³
const DEFAULT_SAMPLE_RATE = 48000;

export interface ToneholeStation {
  /** Cell index along the waveguide [1 .. M-2]. */
  cellIndex: number;
  /** Axial position from mouthpiece (0..1). */
  axialFraction: number;
  /** Hole radius in mm. */
  radiusMm: number;
  /** Negative shunt scattering coefficient in [-0.85, 0] when uncovered. */
  shuntCoeff: number;
  /** Optional MuJoCo joint name whose displacement lifts the key pad off this hole. */
  keyJointName?: string;
  /** Current open fraction [0 = sealed by pad, 1 = wide open]. */
  openAmount: number;
  /** True if detected directly from 3D sculpted / boolean geometry rather than a padded key. */
  fromGeometry?: boolean;
}

export interface BoreWaveguideModel {
  nodeId: string;
  exciter: WindExciterKind;
  /** Unfolded physical bore length (m) along the 3D airway. */
  lengthM: number;
  /** Mouthpiece inner radius (m). */
  mouthRadiusM: number;
  /** Effective unobstructed bell open-end radius (m). */
  bellRadiusM: number;
  /** Number of integer Kelly–Lochbaum spatial delay cells at 48 kHz. */
  cellCount: number;
  /** Continuous exact waveguide length in cells. */
  exactCells: number;
  /** Junction reflection coefficients k_i = (A_i - A_{i+1}) / (A_i + A_{i+1}). */
  junctionK: number[];
  /** Bell open-end radiation cutoff frequency (Hz): f_rad = c / (2 * π * r_bell). */
  bellCutoffHz: number;
  /** Bore profile classification inferred directly from 3D geometry. */
  boreShape: 'cylindrical' | 'conical' | 'flared_horn';
  /** Toneholes from keywork, boolean cuts, or sculpted mesh breaches. */
  toneholes: ToneholeStation[];
  /** Playable resonant input-impedance peak frequencies (Hz) from the 2x2 TMM wave solver. */
  resonantModesHz: number[];
  /** Normalized peak input-impedance magnitudes |Z_in(f_n)| / Z_0 for each resonant mode. */
  modeImpedancePeaks?: number[];
  /** Sampled input-impedance magnitude curve |Z_in(f)| / Z_0 on a uniform grid [fMin..fMax]. */
  impedanceGrid?: { fMin: number; fStep: number; magNorm: number[] };
  /** Bell obstruction / mute constriction factor [0 = wide open, 1 = heavily stopped/muted]. */
  muteFactor?: number;
  /** Acoustic air-leak fraction from unpadded sculpted/cut side breaches [0..1]. */
  breachFactor?: number;
}

// ---------------------------------------------------------------------------
// 3D Triangle Mesh Airway, Folded-Branch, Sculpted-Hole & Mute Analyzer
// ---------------------------------------------------------------------------

interface Seg2D {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  nu: number;
  nv: number;
}

interface BranchSliceInfo {
  uc: number;
  vc: number;
  rEff: number;
  rOuter: number;
  minRatio: number;
  loopCount: number;
  escapeArcRad: number;
}

interface MeshAirwayAnalysis {
  boreAxis: 0 | 1 | 2;
  minCoord: number;
  maxCoord: number;
  unfoldedLengthM: number;
  profileRadii: number[]; // length 36, ordered along unfolded airway from mouth -> bell
  sculptedHoles: { axialFraction: number; radiusM: number; wallM: number }[];
  muteFactor: number;
  genus: number;
  boundaryEdges: number;
}

const meshAnalysisCache = new WeakMap<number[], MeshAirwayAnalysis>();

function computeMeshTopology(rv: number[], faces: number[]): { genus: number; boundaryEdges: number } {
  const nVerts = Math.floor(rv.length / 3);
  const nFaces = Math.floor(faces.length / 3);
  if (nVerts < 4 || nFaces < 4) return { genus: 0, boundaryEdges: 0 };

  // Weld coincident vertices within 0.05 mm
  const weldMap = new Map<string, number>();
  const vertToWeld = new Int32Array(nVerts);
  let weldedCount = 0;
  for (let i = 0; i < nVerts; i++) {
    const kx = Math.round(rv[i * 3] * 20000);
    const ky = Math.round(rv[i * 3 + 1] * 20000);
    const kz = Math.round(rv[i * 3 + 2] * 20000);
    const key = `${kx}:${ky}:${kz}`;
    let wid = weldMap.get(key);
    if (wid === undefined) {
      wid = weldedCount++;
      weldMap.set(key, wid);
    }
    vertToWeld[i] = wid;
  }

  const parent = new Int32Array(weldedCount);
  const used = new Uint8Array(weldedCount);
  for (let i = 0; i < weldedCount; i++) parent[i] = i;
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let c = x;
    while (c !== r) {
      const nxt = parent[c];
      parent[c] = r;
      c = nxt;
    }
    return r;
  };
  const unite = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  const edgeCounts = new Map<number, number>();
  const stride = weldedCount + 1;
  let validFaces = 0;

  for (let f = 0; f < nFaces; f++) {
    const a = vertToWeld[faces[f * 3]];
    const b = vertToWeld[faces[f * 3 + 1]];
    const c = vertToWeld[faces[f * 3 + 2]];
    if (a === b || b === c || c === a) continue;
    validFaces++;
    used[a] = 1;
    used[b] = 1;
    used[c] = 1;
    unite(a, b);
    unite(b, c);

    const e0 = a < b ? a * stride + b : b * stride + a;
    const e1 = b < c ? b * stride + c : c * stride + b;
    const e2 = c < a ? c * stride + a : a * stride + c;
    edgeCounts.set(e0, (edgeCounts.get(e0) ?? 0) + 1);
    edgeCounts.set(e1, (edgeCounts.get(e1) ?? 0) + 1);
    edgeCounts.set(e2, (edgeCounts.get(e2) ?? 0) + 1);
  }

  let usedVerts = 0;
  const roots = new Set<number>();
  for (let i = 0; i < weldedCount; i++) {
    if (used[i]) {
      usedVerts++;
      roots.add(find(i));
    }
  }
  const components = Math.max(1, roots.size);
  let boundaryEdges = 0;
  for (const cnt of edgeCounts.values()) {
    if (cnt === 1) boundaryEdges++;
  }

  // Euler-Poincaré formula for orientable 2-manifolds with B boundary edges:
  // If B === 0, chi = V - E + F = 2*C - 2*g  =>  g = C - (V - E + F)/2
  const chi = usedVerts - edgeCounts.size + validFaces;
  const genus = boundaryEdges === 0 ? Math.max(0, Math.round(components - chi / 2)) : 1;
  return { genus, boundaryEdges };
}

function analyzeBranchCluster(segs: Seg2D[], loopCount: number): BranchSliceInfo | null {
  if (segs.length < 6) return null;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const s of segs) {
    if (s.u0 < minU) minU = s.u0;
    if (s.u1 < minU) minU = s.u1;
    if (s.u0 > maxU) maxU = s.u0;
    if (s.u1 > maxU) maxU = s.u1;
    if (s.v0 < minV) minV = s.v0;
    if (s.v1 < minV) minV = s.v1;
    if (s.v0 > maxV) maxV = s.v0;
    if (s.v1 > maxV) maxV = s.v1;
  }
  const spanU = maxU - minU;
  const spanV = maxV - minV;
  if (spanU < 0.0022 || spanV < 0.0022) return null;

  const boxU = 0.5 * (minU + maxU);
  const boxV = 0.5 * (minV + maxV);

  // Estimate inward airway centroid from segments whose outward solid normal points toward box center
  let sumW = 0, inU = 0, inV = 0;
  for (const s of segs) {
    const mu = 0.5 * (s.u0 + s.u1);
    const mv = 0.5 * (s.v0 + s.v1);
    const len = Math.hypot(s.u1 - s.u0, s.v1 - s.v0);
    const dotToCenter = (boxU - mu) * s.nu + (boxV - mv) * s.nv;
    // Outward solid normal on an INNER cavity wall points INTO the cavity (toward boxU, boxV => dotToCenter > 0)
    if (dotToCenter > 0) {
      inU += mu * len;
      inV += mv * len;
      sumW += len;
    }
  }
  const seedU = sumW > 1e-5 ? inU / sumW : boxU;
  const seedV = sumW > 1e-5 ? inV / sumW : boxV;

  const N_RAYS = 36;
  const cosTab = new Float64Array(N_RAYS);
  const sinTab = new Float64Array(N_RAYS);
  for (let m = 0; m < N_RAYS; m++) {
    const th = (2 * Math.PI * m) / N_RAYS;
    cosTab[m] = Math.cos(th);
    sinTab[m] = Math.sin(th);
  }

  const evalCandidate = (cu: number, cv: number) => {
    let airRayCount = 0;
    let areaOpen = 0;
    let areaOuter = 0;
    let minRin = Infinity;
    let maxRin = 0;
    const hitCounts = new Uint8Array(N_RAYS);
    const rIns = new Float64Array(N_RAYS);

    for (let m = 0; m < N_RAYS; m++) {
      const du = cosTab[m];
      const dv = sinTab[m];
      let nearestT = Infinity;
      let nearestDot = 0;
      let farthestT = 0;
      let hits = 0;

      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const eu = s.u1 - s.u0;
        const ev = s.v1 - s.v0;
        const denom = du * ev - dv * eu;
        if (Math.abs(denom) < 1e-12) continue;
        const wu = s.u0 - cu;
        const wv = s.v0 - cv;
        const t = (wu * ev - wv * eu) / denom;
        if (t <= 1e-5) continue;
        const uParam = (wu * dv - wv * du) / denom;
        if (uParam < -1e-4 || uParam > 1.0001) continue;
        hits++;
        if (t < nearestT) {
          nearestT = t;
          nearestDot = du * s.nu + dv * s.nv;
        }
        if (t > farthestT) farthestT = t;
      }

      hitCounts[m] = Math.min(255, hits);
      if (hits > 0 && Number.isFinite(nearestT)) {
        // If ray from (cu, cv) hits inner wall from air into solid, ray opposes inward-pointing solid normal (nearestDot < 0)
        if (nearestDot < 0) {
          airRayCount++;
          rIns[m] = nearestT;
        } else {
          // Candidate point is inside solid wall/wedge along this ray!
          rIns[m] = 0.0005;
        }
        areaOuter += 0.5 * farthestT * farthestT * ((2 * Math.PI) / N_RAYS);
      }
    }

    // Fill escaping rays with median hit radius for open-area integration, and measure contiguous escape arc
    let sumHitR = 0, cntHitR = 0;
    for (let m = 0; m < N_RAYS; m++) {
      if (hitCounts[m] > 0 && rIns[m] > 0.001) {
        sumHitR += rIns[m];
        cntHitR++;
        if (rIns[m] < minRin) minRin = rIns[m];
        if (rIns[m] > maxRin) maxRin = rIns[m];
      }
    }
    const avgR = cntHitR > 0 ? sumHitR / cntHitR : 0.25 * (spanU + spanV);
    for (let m = 0; m < N_RAYS; m++) {
      const rUse = hitCounts[m] === 0 ? avgR : rIns[m];
      areaOpen += 0.5 * rUse * rUse * ((2 * Math.PI) / N_RAYS);
    }

    let maxEscapeRun = 0;
    let curRun = 0;
    for (let m = 0; m < N_RAYS * 2; m++) {
      if (hitCounts[m % N_RAYS] === 0) {
        curRun++;
        if (curRun > maxEscapeRun) maxEscapeRun = Math.min(N_RAYS, curRun);
      } else {
        curRun = 0;
      }
    }

    return {
      cu,
      cv,
      airRayCount,
      areaOpen,
      areaOuter: Math.max(areaOpen, areaOuter),
      minRatio: maxRin > 1e-4 && Number.isFinite(minRin) ? minRin / maxRin : 1,
      escapeArcRad: (maxEscapeRun * 2 * Math.PI) / N_RAYS,
    };
  };

  // Test seed + 3x3 interior offsets so sculpted inward wedges never trap the center inside solid brass!
  let best = evalCandidate(seedU, seedV);
  if (best.airRayCount < N_RAYS * 0.65) {
    for (const fu of [-0.24, 0, 0.24]) {
      for (const fv of [-0.24, 0, 0.24]) {
        const cand = evalCandidate(boxU + fu * spanU, boxV + fv * spanV);
        if (
          cand.airRayCount > best.airRayCount ||
          (cand.airRayCount === best.airRayCount && cand.areaOpen > best.areaOpen)
        ) {
          best = cand;
        }
      }
    }
  }

  // Must have a genuine hollow interior (not a solid rod)
  if (best.airRayCount < 5) return null;

  return {
    uc: best.cu,
    vc: best.cv,
    rEff: Math.sqrt(best.areaOpen / Math.PI),
    rOuter: Math.sqrt(best.areaOuter / Math.PI),
    minRatio: best.minRatio,
    loopCount,
    escapeArcRad: best.escapeArcRad,
  };
}

function analyzeHollowMeshAirway(g: SceneGeom): MeshAirwayAnalysis | null {
  const rv = g.renderVertices;
  const faces = g.faces;
  if (!rv || !faces || rv.length < 12 || faces.length < 12) return null;

  const cached = meshAnalysisCache.get(rv);
  if (cached) return cached;

  const off0 = g.pos?.[0] ?? 0;
  const off1 = g.pos?.[1] ?? 0;
  const off2 = g.pos?.[2] ?? 0;
  const offs = [off0, off1, off2];

  const mins = [Infinity, Infinity, Infinity];
  const maxs = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < rv.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = rv[i + a] + offs[a];
      if (v < mins[a]) mins[a] = v;
      if (v > maxs[a]) maxs[a] = v;
    }
  }
  const spans = [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]];
  let boreAxis: 0 | 1 | 2 = 0;
  if (spans[1] >= spans[0] && spans[1] >= spans[2]) boreAxis = 1;
  else if (spans[2] >= spans[0] && spans[2] >= spans[1]) boreAxis = 2;

  const perpAxes = ([0, 1, 2] as const).filter((a) => a !== boreAxis);
  const axU = perpAxes[0];
  const axV = perpAxes[1];
  const minB = mins[boreAxis];
  const maxB = maxs[boreAxis];
  const spanB = Math.max(0.02, maxB - minB);

  const topo = computeMeshTopology(rv, faces);

  const N_SLICES = 36;
  const dx = spanB / N_SLICES;
  const sliceSegs: Seg2D[][] = Array.from({ length: N_SLICES }, () => []);

  const nFaces = Math.floor(faces.length / 3);
  for (let f = 0; f < nFaces; f++) {
    const i0 = faces[f * 3] * 3;
    const i1 = faces[f * 3 + 1] * 3;
    const i2 = faces[f * 3 + 2] * 3;

    const b0 = rv[i0 + boreAxis] + offs[boreAxis];
    const b1 = rv[i1 + boreAxis] + offs[boreAxis];
    const b2 = rv[i2 + boreAxis] + offs[boreAxis];

    const loB = Math.min(b0, b1, b2);
    const hiB = Math.max(b0, b1, b2);
    if (hiB - loB < 1e-7) continue;

    const u0 = rv[i0 + axU] + offs[axU], v0 = rv[i0 + axV] + offs[axV];
    const u1 = rv[i1 + axU] + offs[axU], v1 = rv[i1 + axV] + offs[axV];
    const u2 = rv[i2 + axU] + offs[axU], v2 = rv[i2 + axV] + offs[axV];

    // 3D triangle normal in (B, U, V) right-handed permutation up to sign: orient 2D normal using signed cross product
    const e1b = b1 - b0, e1u = u1 - u0, e1v = v1 - v0;
    const e2b = b2 - b0, e2u = u2 - u0, e2v = v2 - v0;
    // Note: cyclic sign of (boreAxis, axU, axV):
    // (0,1,2) => +1; (1,0,2) => -1; (2,0,1) => +1
    const handed = boreAxis === 1 ? -1 : 1;
    const nuRaw = handed * (e1v * e2b - e1b * e2v);
    const nvRaw = handed * (e1b * e2u - e1u * e2b);
    const n2Len = Math.hypot(nuRaw, nvRaw);
    if (n2Len < 1e-9) continue;
    const nu = nuRaw / n2Len;
    const nv = nvRaw / n2Len;

    const qStart = Math.max(0, Math.floor((loB - minB) / dx));
    const qEnd = Math.min(N_SLICES - 1, Math.floor((hiB - minB) / dx));

    for (let q = qStart; q <= qEnd; q++) {
      const planeB = minB + (q + 0.5) * dx;
      if (planeB <= loB || planeB >= hiB) continue;

      const pts: [number, number][] = [];
      const checkEdge = (ba: number, ua: number, va: number, bb: number, ub: number, vb: number) => {
        if ((ba < planeB && bb >= planeB) || (bb < planeB && ba >= planeB)) {
          const t = (planeB - ba) / (bb - ba);
          pts.push([ua + t * (ub - ua), va + t * (vb - va)]);
        }
      };
      checkEdge(b0, u0, v0, b1, u1, v1);
      checkEdge(b1, u1, v1, b2, u2, v2);
      checkEdge(b2, u2, v2, b0, u0, v0);
      if (pts.length >= 2) {
        sliceSegs[q].push({
          u0: pts[0][0],
          v0: pts[0][1],
          u1: pts[1][0],
          v1: pts[1][1],
          nu,
          nv,
        });
      }
    }
  }

  // Extract branch clusters per slice
  const sliceBranches: BranchSliceInfo[][] = [];
  for (let q = 0; q < N_SLICES; q++) {
    const segs = sliceSegs[q];
    if (segs.length < 6) {
      sliceBranches.push([]);
      continue;
    }

    // 1. Connect segments sharing 0.3 mm quantized endpoints into 2D loops
    const nSegs = segs.length;
    const loopParent = new Int32Array(nSegs);
    for (let i = 0; i < nSegs; i++) loopParent[i] = i;
    const findL = (x: number): number => {
      let r = x;
      while (loopParent[r] !== r) r = loopParent[r];
      let c = x;
      while (c !== r) {
        const nxt = loopParent[c];
        loopParent[c] = r;
        c = nxt;
      }
      return r;
    };
    const uniteL = (a: number, b: number) => {
      const ra = findL(a);
      const rb = findL(b);
      if (ra !== rb) loopParent[ra] = rb;
    };

    const ptMap = new Map<string, number>();
    for (let i = 0; i < nSegs; i++) {
      const s = segs[i];
      for (const [pu, pv] of [[s.u0, s.v0], [s.u1, s.v1]] as const) {
        const key = `${Math.round(pu * 6000)}:${Math.round(pv * 6000)}`;
        const prev = ptMap.get(key);
        if (prev !== undefined) uniteL(i, prev);
        else ptMap.set(key, i);
      }
    }

    const loopsMap = new Map<number, { segs: Seg2D[]; minU: number; maxU: number; minV: number; maxV: number }>();
    for (let i = 0; i < nSegs; i++) {
      const r = findL(i);
      const s = segs[i];
      let entry = loopsMap.get(r);
      if (!entry) {
        entry = { segs: [], minU: Infinity, maxU: -Infinity, minV: Infinity, maxV: -Infinity };
        loopsMap.set(r, entry);
      }
      entry.segs.push(s);
      entry.minU = Math.min(entry.minU, s.u0, s.u1);
      entry.maxU = Math.max(entry.maxU, s.u0, s.u1);
      entry.minV = Math.min(entry.minV, s.v0, s.v1);
      entry.maxV = Math.max(entry.maxV, s.v0, s.v1);
    }

    // 2. Merge nested/concentric inner+outer loops whose 2D bounding boxes overlap (within 1.5 mm) into physical tube branches
    const loops = Array.from(loopsMap.values()).filter((l) => l.segs.length >= 4);
    const nLoops = loops.length;
    const brParent = new Int32Array(nLoops);
    for (let i = 0; i < nLoops; i++) brParent[i] = i;
    const findB = (x: number): number => {
      let r = x;
      while (brParent[r] !== r) r = brParent[r];
      return r;
    };
    // Pair concentric inner+outer wall loops (centers within <= 45% of smaller loop radius),
    // never merging side-by-side parallel branches of a folded horn!
    for (let i = 0; i < nLoops; i++) {
      const a = loops[i];
      const caU = 0.5 * (a.minU + a.maxU), caV = 0.5 * (a.minV + a.maxV);
      const radA = 0.25 * (a.maxU - a.minU + (a.maxV - a.minV));
      for (let j = i + 1; j < nLoops; j++) {
        const b = loops[j];
        const cbU = 0.5 * (b.minU + b.maxU), cbV = 0.5 * (b.minV + b.maxV);
        const radB = 0.25 * (b.maxU - b.minU + (b.maxV - b.minV));
        const dist = Math.hypot(caU - cbU, caV - cbV);
        if (dist <= Math.max(0.005, 0.45 * Math.min(radA, radB))) {
          const ri = findB(i), rj = findB(j);
          if (ri !== rj) brParent[ri] = rj;
        }
      }
    }

    const branchGroups = new Map<number, { segs: Seg2D[]; loopCount: number }>();
    for (let i = 0; i < nLoops; i++) {
      const r = findB(i);
      let bg = branchGroups.get(r);
      if (!bg) {
        bg = { segs: [], loopCount: 0 };
        branchGroups.set(r, bg);
      }
      bg.segs.push(...loops[i].segs);
      bg.loopCount++;
    }

    const branches: BranchSliceInfo[] = [];
    for (const bg of branchGroups.values()) {
      const info = analyzeBranchCluster(bg.segs, bg.loopCount);
      if (info) branches.push(info);
    }
    // Sort branches at slice q from smallest outer radius (mouthpiece/leadpipe) to largest (bell)
    branches.sort((a, b) => a.rOuter - b.rOuter);
    sliceBranches.push(branches);
  }

  // Compute unfolded length via Cauchy branch-count integral + U-turn bow arcs
  const counts = sliceBranches.map((b) => b.length);
  const maxBranches = Math.max(1, ...counts);
  let unfoldedLengthM = 0;
  for (let q = 0; q < N_SLICES; q++) {
    const kq = counts[q];
    unfoldedLengthM += Math.max(1, kq) * dx;
    if (q > 0 && counts[q] !== counts[q - 1]) {
      // Semicircular U-bend arc excess (pi/2 - 1) * R_turn at each fold transition
      unfoldedLengthM += 0.014 * Math.abs(counts[q] - counts[q - 1]);
    }
  }

  // Order all (slice q, pass p) samples sequentially from mouthpiece (s = 0) -> bell (s = 1)!
  const orderedSamples: { s: number; q: number; passIdx: number; info: BranchSliceInfo }[] = [];
  if (maxBranches <= 1) {
    for (let q = 0; q < N_SLICES; q++) {
      if (sliceBranches[q][0]) {
        orderedSamples.push({
          s: (q + 0.5) / N_SLICES,
          q,
          passIdx: 0,
          info: sliceBranches[q][0],
        });
      }
    }
  } else {
    // Multi-branch folded horn (e.g. 3 passes: pass 0 forward +B, pass 1 backward -B, pass 2 forward +B)
    const nPasses = maxBranches;
    const rawChain: { q: number; passIdx: number; info: BranchSliceInfo }[] = [];
    for (let p = 0; p < nPasses; p++) {
      const forward = p % 2 === 0;
      for (let step = 0; step < N_SLICES; step++) {
        const q = forward ? step : N_SLICES - 1 - step;
        const brs = sliceBranches[q];
        if (brs.length === 0) continue;
        // Skip U-bend turn saddle slices where branch count changes
        if (q > 0 && q + 1 < N_SLICES && (counts[q] !== counts[q - 1] || counts[q] !== counts[q + 1])) {
          continue;
        }
        if (brs.length === nPasses) {
          rawChain.push({ q, passIdx: p, info: brs[p] });
        } else if (brs.length === 1) {
          const isBellSide = q > N_SLICES / 2 && brs[0].rOuter > 0.011;
          const ownerPass = isBellSide ? nPasses - 1 : 0;
          if (p === ownerPass) rawChain.push({ q, passIdx: p, info: brs[0] });
        }
      }
    }
    const total = Math.max(1, rawChain.length);
    for (let i = 0; i < rawChain.length; i++) {
      orderedSamples.push({
        s: (i + 0.5) / total,
        ...rawChain[i],
      });
    }
  }

  // Resample ordered airway radii cleanly onto 36 uniform stations
  const profileRadii = new Array<number>(36).fill(0.007);
  if (orderedSamples.length > 0) {
    for (let k = 0; k < 36; k++) {
      const targetS = k / 35;
      let best = orderedSamples[0];
      let bestDist = Infinity;
      for (const smp of orderedSamples) {
        const d = Math.abs(smp.s - targetS);
        if (d < bestDist) {
          bestDist = d;
          best = smp;
        }
      }
      profileRadii[k] = best.info.rEff;
    }
    // Gentle 3-point smoothing across discrete slice bins (preserving end radii)
    const sm = [...profileRadii];
    for (let k = 1; k + 1 < 36; k++) {
      sm[k] = 0.25 * profileRadii[k - 1] + 0.5 * profileRadii[k] + 0.25 * profileRadii[k + 1];
    }
    for (let k = 1; k + 1 < 36; k++) profileRadii[k] = sm[k];
  }

  // Detect sculpted side-holes when topology confirms a wall breach (genus > 1 or open boundary edges > 0)!
  const sculptedHoles: { axialFraction: number; radiusM: number; wallM: number }[] = [];
  const hasTopologicalBreach = topo.genus > 1 || topo.boundaryEdges > 0;
  if (hasTopologicalBreach && orderedSamples.length >= 6) {
    const holeCandidates: { s: number; radiusM: number }[] = [];
    for (let i = 2; i + 2 < orderedSamples.length; i++) {
      const smp = orderedSamples[i];
      const q = smp.q;
      if (q <= 1 || q >= N_SLICES - 2) continue;
      // Skip U-bend turn transition slices where branch count changes
      if (counts[q] !== counts[q - 1] || counts[q] !== counts[q + 1]) continue;

      const inf = smp.info;
      // Either direct 2D ray escape (>= 20° opening) OR merged single C-loop wall breach!
      const rayEscaped = inf.escapeArcRad >= (20 * Math.PI) / 180;
      const mergedCLoop =
        inf.loopCount === 1 &&
        orderedSamples[i - 1].info.loopCount >= 2 &&
        orderedSamples[i + 1].info.loopCount >= 2;

      if (rayEscaped || mergedCLoop) {
        const arc = rayEscaped ? inf.escapeArcRad : 0.45;
        const holeR = Math.max(0.003, Math.min(0.025, 0.5 * inf.rOuter * arc));
        holeCandidates.push({ s: smp.s, radiusM: holeR });
      }
    }

    // Group contiguous slice detections into discrete physical holes
    let idx = 0;
    while (idx < holeCandidates.length) {
      let j = idx;
      let sumS = 0;
      let maxR = 0;
      while (j < holeCandidates.length && holeCandidates[j].s - holeCandidates[idx].s < 0.08) {
        sumS += holeCandidates[j].s;
        if (holeCandidates[j].radiusM > maxR) maxR = holeCandidates[j].radiusM;
        j++;
      }
      const meanS = sumS / (j - idx);
      sculptedHoles.push({
        axialFraction: +Math.max(0.08, Math.min(0.95, meanS)).toFixed(4),
        radiusM: +maxR.toFixed(4),
        wallM: 0.0022,
      });
      idx = j;
    }

    // Fallback if an oblique pinhole increased genus > 1 strictly between two slice planes:
    if (sculptedHoles.length === 0 && topo.genus > 1) {
      // Find interior sample with minimum loopCount or minimum rEff/rOuter wall anomaly
      let bestS = 0.78;
      let maxArc = -1;
      for (let i = 3; i + 3 < orderedSamples.length; i++) {
        if (orderedSamples[i].info.escapeArcRad > maxArc) {
          maxArc = orderedSamples[i].info.escapeArcRad;
          bestS = orderedSamples[i].s;
        }
      }
      sculptedHoles.push({ axialFraction: +bestS.toFixed(4), radiusM: 0.0055, wallM: 0.0022 });
    }
  }

  // Measure bell mute / inward sculpted baffle constriction over the final 18% of the airway!
  let muteFactor = 0;
  const bellSamples = orderedSamples.filter((smp) => smp.s >= 0.82 && smp.s <= 0.98);
  if (bellSamples.length > 0) {
    let minAreaRatio = 1;
    let minStarRatio = 1;
    for (const smp of bellSamples) {
      const areaRatio = (smp.info.rEff * smp.info.rEff) / Math.max(1e-8, smp.info.rOuter * smp.info.rOuter);
      if (areaRatio < minAreaRatio) minAreaRatio = areaRatio;
      if (smp.info.minRatio < minStarRatio) minStarRatio = smp.info.minRatio;
    }
    // Smooth open thin-walled bell has areaRatio ~ 0.85..0.94 and minStarRatio ~ 0.92..1.0.
    // Sculpted inward baffles/mute plugs drop areaRatio < 0.72 and/or star circularity < 0.65!
    const areaConstriction = Math.max(0, (0.76 - minAreaRatio) / 0.45);
    const starConstriction = Math.max(0, (0.72 - minStarRatio) / 0.50);
    muteFactor = +Math.min(0.88, Math.max(areaConstriction, starConstriction * 0.85)).toFixed(3);
  }

  const result: MeshAirwayAnalysis = {
    boreAxis,
    minCoord: minB,
    maxCoord: maxB,
    unfoldedLengthM,
    profileRadii,
    sculptedHoles,
    muteFactor,
    genus: topo.genus,
    boundaryEdges: topo.boundaryEdges,
  };
  meshAnalysisCache.set(rv, result);
  return result;
}

// ---------------------------------------------------------------------------
// Node-Level Bore Geometry Aggregation (Primitives + Hollow Meshes + CSG Cuts)
// ---------------------------------------------------------------------------

interface AxialBoreSlice {
  boreAxis: 0 | 1 | 2;
  minCoord: number;
  maxCoord: number;
  lengthM: number;
  hasHollowFoldedMesh: boolean;
  muteFactor: number;
  radiiAtStations: (nStations: number) => number[];
  transverseHoles: { axialFraction: number; radiusM: number; wallM: number }[];
}

function geomSpanOnAxis(g: SceneGeom, axis: 0 | 1 | 2): [number, number] {
  if (g.type === 'mesh') {
    const rv = g.renderVertices;
    const off = g.pos?.[axis] ?? 0;
    if (rv && rv.length >= 3) {
      let lo = Infinity, hi = -Infinity;
      for (let i = axis; i < rv.length; i += 3) {
        const v = rv[i] + off;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (Number.isFinite(lo)) return [lo, hi];
    }
  }
  const c = g.pos?.[axis] ?? 0;
  if (g.fromto && g.fromto.length >= 6) {
    const a = g.fromto[axis];
    const b = g.fromto[axis + 3];
    const r = g.size[0] ?? 0.005;
    return [Math.min(a, b) - r, Math.max(a, b) + r];
  }
  if (g.type === 'box') {
    const h = g.size[axis] ?? 0.02;
    return [c - h, c + h];
  }
  if (g.type === 'cylinder' || g.type === 'capsule') {
    const eul = g.euler ?? [0, 0, 0];
    let cylAxis: 0 | 1 | 2 = 2;
    if (Math.abs(Math.abs(eul[1] ?? 0) - 90) < 20) cylAxis = 0;
    else if (Math.abs(Math.abs(eul[0] ?? 0) - 90) < 20) cylAxis = 1;
    const ext = cylAxis === axis ? (g.size[1] ?? 0.05) : (g.size[0] ?? 0.01);
    return [c - ext, c + ext];
  }
  const r = g.size[0] ?? 0.02;
  return [c - r, c + r];
}

function inspectNodeBoreGeometry(node: SceneNode): AxialBoreSlice {
  const geoms = node.geoms ?? [];
  const positives = geoms.filter((g) => !g.csgDerived && g.csg !== 'difference' && g.role !== 'visual');
  const negatives = geoms.filter((g) => g.csg === 'difference');

  // If the primary positive body is a single hollow folded/sculpted mesh (e.g. cornet/horn/ocarina),
  // use full 2D cross-section & topological airway analysis directly!
  const meshGeoms = positives.filter((g) => g.type === 'mesh' && g.renderVertices && g.faces);
  const primaryMeshAnalysis = meshGeoms.length === 1 && positives.length === 1
    ? analyzeHollowMeshAirway(meshGeoms[0])
    : null;

  const spans: [number, number][] = [0, 1, 2].map((ax) => {
    let lo = Infinity, hi = -Infinity;
    for (const g of positives) {
      const [g0, g1] = geomSpanOnAxis(g, ax as 0 | 1 | 2);
      if (g0 < lo) lo = g0;
      if (g1 > hi) hi = g1;
    }
    return Number.isFinite(lo) ? [lo, hi] : [-0.15, 0.15];
  });
  const lengths = spans.map(([lo, hi]) => hi - lo);
  let boreAxis: 0 | 1 | 2 = 2;
  if (lengths[0] >= lengths[1] && lengths[0] >= lengths[2]) boreAxis = 0;
  else if (lengths[1] >= lengths[0] && lengths[1] >= lengths[2]) boreAxis = 1;

  const [minCoord, maxCoord] = spans[boreAxis];
  const bboxLengthM = Math.max(0.06, maxCoord - minCoord);

  // Separate coaxial bore cutters from transverse CSG tonehole cutters
  const coaxialBores: SceneGeom[] = [];
  const transverseHoles: { axialFraction: number; radiusM: number; wallM: number }[] = [];

  for (const neg of negatives) {
    if (neg.type !== 'cylinder' && neg.type !== 'capsule' && neg.type !== 'ellipsoid') continue;
    const [n0, n1] = geomSpanOnAxis(neg, boreAxis);
    const axialSpan = n1 - n0;
    const rNeg = neg.size[0] ?? 0.005;
    if (axialSpan > bboxLengthM * 0.35) {
      coaxialBores.push(neg);
    } else if (rNeg >= 0.0015 && rNeg <= 0.035) {
      const center = 0.5 * (n0 + n1);
      const frac = Math.max(0.08, Math.min(0.94, (center - minCoord) / bboxLengthM));
      transverseHoles.push({
        axialFraction: +frac.toFixed(4),
        radiusM: rNeg,
        wallM: 0.0035,
      });
    }
  }

  // Also inspect any mesh geoms on compound instruments (e.g. clarinet_bell_mesh!) for sculpted holes or bell mutes!
  let muteFactor = primaryMeshAnalysis?.muteFactor ?? 0;
  if (primaryMeshAnalysis) {
    transverseHoles.push(...primaryMeshAnalysis.sculptedHoles);
  } else {
    for (const mg of meshGeoms) {
      const ma = analyzeHollowMeshAirway(mg);
      if (!ma) continue;
      if (ma.muteFactor > muteFactor) muteFactor = ma.muteFactor;
      const [m0, m1] = geomSpanOnAxis(mg, boreAxis);
      for (const sh of ma.sculptedHoles) {
        const worldCoord = m0 + sh.axialFraction * (m1 - m0);
        const bodyFrac = Math.max(0.08, Math.min(0.96, (worldCoord - minCoord) / bboxLengthM));
        transverseHoles.push({
          axialFraction: +bodyFrac.toFixed(4),
          radiusM: sh.radiusM,
          wallM: sh.wallM,
        });
      }
    }
  }

  if (primaryMeshAnalysis) {
    const prof = primaryMeshAnalysis.profileRadii;
    return {
      boreAxis: primaryMeshAnalysis.boreAxis,
      minCoord: primaryMeshAnalysis.minCoord,
      maxCoord: primaryMeshAnalysis.maxCoord,
      lengthM: primaryMeshAnalysis.unfoldedLengthM,
      hasHollowFoldedMesh: primaryMeshAnalysis.unfoldedLengthM > bboxLengthM * 1.35,
      muteFactor,
      radiiAtStations: (nStations: number) => {
        const out: number[] = [];
        for (let k = 0; k < nStations; k++) {
          const u = nStations <= 1 ? 0 : (k / (nStations - 1)) * (prof.length - 1);
          const idx0 = Math.floor(u);
          const idx1 = Math.min(prof.length - 1, idx0 + 1);
          const frac = u - idx0;
          out.push(prof[idx0] * (1 - frac) + prof[idx1] * frac);
        }
        return out;
      },
      transverseHoles,
    };
  }

  const radiiAtStations = (nStations: number): number[] => {
    if (node.isTube && typeof node.innerRadius === 'number' && node.innerRadius > 0) {
      return new Array<number>(nStations).fill(node.innerRadius);
    }

    const out: number[] = [];
    for (let k = 0; k < nStations; k++) {
      const u = nStations <= 1 ? 0 : k / (nStations - 1);
      const coord = minCoord + u * bboxLengthM;

      let rInner = 0;
      for (const cb of coaxialBores) {
        const [c0, c1] = geomSpanOnAxis(cb, boreAxis);
        if (coord >= c0 - 1e-4 && coord <= c1 + 1e-4) {
          rInner = Math.max(rInner, cb.size[0] ?? 0.007);
        }
      }

      if (rInner <= 0) {
        let rOuterAtStation = 0;
        for (const p of positives) {
          const [p0, p1] = geomSpanOnAxis(p, boreAxis);
          if (coord >= p0 - 1e-3 && coord <= p1 + 1e-3) {
            let rCand: number;
            if (p.type === 'cylinder' || p.type === 'capsule' || p.type === 'sphere') {
              rCand = p.size[0] ?? 0.01;
            } else if (p.type === 'box') {
              const perpAxes = ([0, 1, 2] as const).filter((a) => a !== boreAxis);
              rCand = Math.sqrt(((p.size[perpAxes[0]] ?? 0.01) * (p.size[perpAxes[1]] ?? 0.01) * 4) / Math.PI);
            } else if (p.type === 'mesh' && p.renderVertices && p.renderVertices.length >= 9) {
              const ma = analyzeHollowMeshAirway(p);
              if (ma) {
                const localU = Math.max(0, Math.min(1, (coord - p0) / Math.max(1e-4, p1 - p0)));
                const fIdx = localU * (ma.profileRadii.length - 1);
                const i0 = Math.floor(fIdx);
                const i1 = Math.min(ma.profileRadii.length - 1, i0 + 1);
                rInner = Math.max(rInner, ma.profileRadii[i0] * (1 - (fIdx - i0)) + ma.profileRadii[i1] * (fIdx - i0));
                continue;
              }
              rCand = 0.012;
            } else {
              rCand = 0.012;
            }
            if (rCand > rOuterAtStation) rOuterAtStation = rCand;
          }
        }
        if (rInner <= 0 && rOuterAtStation > 0) {
          rInner = Math.max(0.0035, rOuterAtStation - Math.min(0.0022, rOuterAtStation * 0.22));
        }
      }

      out.push(rInner > 0 ? rInner : 0.0075);
    }

    if (positives.length >= 2 && out.length >= 5) {
      const smoothed = [...out];
      for (let i = 1; i + 1 < out.length; i++) {
        smoothed[i] = 0.25 * out[i - 1] + 0.5 * out[i] + 0.25 * out[i + 1];
      }
      return smoothed;
    }
    return out;
  };

  return {
    boreAxis,
    minCoord,
    maxCoord,
    lengthM: bboxLengthM,
    hasHollowFoldedMesh: false,
    muteFactor,
    radiiAtStations,
    transverseHoles,
  };
}

// ---------------------------------------------------------------------------
// 1D Conical Acoustic Transfer-Matrix Wave Solver (Caussé / Keefe / Schwinger)
// ---------------------------------------------------------------------------

interface TmmSolution {
  fMin: number;
  fStep: number;
  magNorm: number[];
  peaksHz: number[];
  peaksMag: number[];
}

const tmmCache = new Map<string, TmmSolution>();

function solveConicalBoreTMM(
  radii: number[],
  totalBoreLengthM: number,
  toneholes: ToneholeStation[],
  isOpenInputFlute: boolean,
  muteFactor: number,
): TmmSolution {
  const nNodes = radii.length;
  const nSegs = Math.max(1, nNodes - 1);
  const segLen = totalBoreLengthM / nSegs;

  // Compact cache key on quantized geometry + open holes so steady sustain costs 0.000 ms!
  const rSig = [0, 6, 12, 18, 24, nNodes - 1]
    .map((idx) => Math.round((radii[Math.min(nNodes - 1, idx)] ?? 0.007) * 10000))
    .join(',');
  const hSig = toneholes
    .filter((t) => t.openAmount > 0.02)
    .map((t) => `${t.cellIndex}:${Math.round(t.radiusMm * 10)}:${Math.round(t.openAmount * 100)}`)
    .join(';');
  const cacheKey = `${Math.round(totalBoreLengthM * 20000)}|${rSig}|${hSig}|${isOpenInputFlute ? 1 : 0}|${Math.round(muteFactor * 100)}`;
  const hit = tmmCache.get(cacheKey);
  if (hit) return hit;
  if (tmmCache.size > 180) tmmCache.clear();

  // Map open toneholes onto segment boundaries [1 .. nSegs - 1] with linear sub-segment interpolation!
  const holesBySeg = new Map<number, { rHoleM: number; tEffM: number; open: number }[]>();
  const addHoleWeight = (segIdx: number, rH: number, tEff: number, openW: number) => {
    if (openW <= 0.005 || segIdx < 1 || segIdx >= nSegs) return;
    let list = holesBySeg.get(segIdx);
    if (!list) {
      list = [];
      holesBySeg.set(segIdx, list);
    }
    list.push({ rHoleM: rH, tEffM: tEff, open: openW });
  };
  for (const th of toneholes) {
    if (th.openAmount <= 0.02) continue;
    const exactSeg = Math.max(1, Math.min(nSegs - 1.001, th.axialFraction * nSegs));
    const s0 = Math.floor(exactSeg);
    const w1 = exactSeg - s0;
    const rH = Math.max(0.0015, th.radiusMm / 1000);
    const tEff = 0.0028 + 1.45 * rH;
    addHoleWeight(s0, rH, tEff, th.openAmount * (1 - w1));
    addHoleWeight(s0 + 1, rH, tEff, th.openAmount * w1);
  }

  const rMouth = Math.max(0.002, radii[0]);
  const rMid = Math.max(0.003, radii[Math.floor(nNodes * 0.5)]);
  const z0Mouth = (AIR_DENSITY * SPEED_OF_SOUND_WARM_AIR) / (Math.PI * rMouth * rMouth);
  const zRef = (AIR_DENSITY * SPEED_OF_SOUND_WARM_AIR) / (Math.PI * rMouth * rMid);
  const rBell = Math.max(0.0025, radii[nNodes - 1]);
  const z0Bell = (AIR_DENSITY * SPEED_OF_SOUND_WARM_AIR) / (Math.PI * rBell * rBell);

  const fMin = 55;
  const fStep = 4.0;
  const nFreqs = 560; // 55 Hz .. 2295 Hz at 4 Hz resolution (parabolic peak interpolation -> < 0.2 Hz accuracy!)
  const magNorm = new Array<number>(nFreqs);

  for (let m = 0; m < nFreqs; m++) {
    const f = fMin + m * fStep;
    const omega = 2 * Math.PI * f;
    const k = omega / SPEED_OF_SOUND_WARM_AIR;

    // Levine–Schwinger unflanged radiation impedance at open bell (+ reactive mute mass when bell is baffled!)
    const ka = k * rBell;
    const muteMassBoost = 1 + 2.4 * muteFactor;
    const muteResistBoost = 1 + 3.5 * muteFactor * muteFactor;
    let pRe = z0Bell * 0.25 * ka * ka * muteResistBoost;
    let pIm = z0Bell * 0.6133 * ka * muteMassBoost;
    let uRe = 1.0;
    let uIm = 0.0;

    // Propagate (p, U) backward from bell (seg = nSegs - 1) to mouthpiece (seg = 0)
    for (let s = nSegs - 1; s >= 0; s--) {
      const r0 = Math.max(0.0018, radii[s]);
      const r1 = Math.max(0.0018, radii[s + 1]);
      const rMean = 0.5 * (r0 + r1);

      // Kirchhoff thermo-viscous boundary-layer attenuation alpha (Np/m)
      const alpha = (1.05e-5 * Math.sqrt(f)) / rMean;
      // Complex wavenumber k_tilde = k - i*alpha => sin(k_tilde * L) = sin(kL)cosh(aL) - i cos(kL)sinh(aL)
      const kL = k * segLen;
      const aL = alpha * segLen;
      const sinKL = Math.sin(kL), cosKL = Math.cos(kL);
      const coshAL = Math.cosh(aL), sinhAL = Math.sinh(aL);

      const sRe = sinKL * coshAL;
      const sIm = -cosKL * sinhAL;
      const cRe = cosKL * coshAL;
      const cIm = sinKL * sinhAL;

      const zc01 = (AIR_DENSITY * SPEED_OF_SOUND_WARM_AIR) / (Math.PI * r0 * r1);

      let ARe: number, AIm: number;
      let BRe: number, BIm: number;
      let CRe: number, CIm: number;
      let DRe: number, DIm: number;

      if (Math.abs(r1 - r0) < 1e-5) {
        // Cylindrical limit
        ARe = cRe; AIm = cIm;
        DRe = cRe; DIm = cIm;
        // B = i * zc01 * s = zc01 * (-sIm + i * sRe)
        BRe = -zc01 * sIm; BIm = zc01 * sRe;
        // C = (i / zc01) * s
        CRe = -sIm / zc01; CIm = sRe / zc01;
      } else {
        // Exact spherical-wave conical frustum (Caussé et al. 1984)
        const dr = r1 - r0;
        const x0 = (r0 * segLen) / dr;
        const x1 = x0 + segLen;
        // Approximate 1 / k_tilde ≈ 1 / k (since alpha / k < 0.01) for spherical curvature terms
        const invKx0 = 1 / (k * x0);
        const invKx1 = 1 / (k * x1);
        const invK2x01 = invKx0 * invKx1;

        ARe = (x1 / x0) * cRe - invKx0 * sRe;
        AIm = (x1 / x0) * cIm - invKx0 * sIm;

        DRe = (x0 / x1) * cRe + invKx1 * sRe;
        DIm = (x0 / x1) * cIm + invKx1 * sIm;

        BRe = -zc01 * sIm;
        BIm = zc01 * sRe;

        // M = (1 + 1/(k² x0 x1)) * s - (L / (k x0 x1)) * c, then C = (i / zc01) * M
        const k1 = 1 + invK2x01;
        const k2 = segLen / (k * x0 * x1);
        const mRe = k1 * sRe - k2 * cRe;
        const mIm = k1 * sIm - k2 * cIm;
        CRe = -mIm / zc01;
        CIm = mRe / zc01;
      }

      const nextPRe = ARe * pRe - AIm * pIm + (BRe * uRe - BIm * uIm);
      const nextPIm = ARe * pIm + AIm * pRe + (BRe * uIm + BIm * uRe);
      const nextURe = CRe * pRe - CIm * pIm + (DRe * uRe - DIm * uIm);
      const nextUIm = CRe * pIm + CIm * pRe + (DRe * uIm + DIm * uRe);

      pRe = nextPRe;
      pIm = nextPIm;
      uRe = nextURe;
      uIm = nextUIm;

      // Apply parallel Keefe complex tonehole / sculpted-breach shunt admittance U <- U + Y_hole * p
      const holes = holesBySeg.get(s);
      if (holes) {
        for (const h of holes) {
          const z0Hole = (AIR_DENSITY * SPEED_OF_SOUND_WARM_AIR) / (Math.PI * h.rHoleM * h.rHoleM);
          const kh = k * h.rHoleM;
          // Radiation + vortex boundary resistance + acoustic inertance i * k * t_eff / open
          const zHoleRe = z0Hole * (0.25 * kh * kh + 0.018 / Math.max(0.15, h.open));
          const zHoleIm = z0Hole * ((k * h.tEffM) / Math.max(0.08, h.open));
          const denom = zHoleRe * zHoleRe + zHoleIm * zHoleIm + 1e-18;
          const yRe = zHoleRe / denom;
          const yIm = -zHoleIm / denom;
          uRe += yRe * pRe - yIm * pIm;
          uIm += yRe * pIm + yIm * pRe;
        }
      }
    }

    // Input impedance Z_in = p / U (for reed/lip pressure-controlled valve) or admittance Y_in = U / p (for open flute!)
    if (isOpenInputFlute) {
      // Open-open air-jet flute resonates at admittance peaks (impedance minima): add embouchure end-correction
      const km = k * rMouth;
      pRe += (z0Mouth * 0.25 * km * km) * uRe - (z0Mouth * 0.85 * km) * uIm;
      pIm += (z0Mouth * 0.25 * km * km) * uIm + (z0Mouth * 0.85 * km) * uRe;
      const pMag = Math.hypot(pRe, pIm) + 1e-12;
      const uMag = Math.hypot(uRe, uIm);
      magNorm[m] = (uMag * z0Mouth) / pMag;
    } else {
      const uMag = Math.hypot(uRe, uIm) + 1e-12;
      const pMag = Math.hypot(pRe, pIm);
      magNorm[m] = pMag / (uMag * zRef);
    }
  }

  // Extract true local maxima (standing-wave resonance peaks!) with quadratic sub-bin interpolation
  const peaksHz: number[] = [];
  const peaksMag: number[] = [];
  for (let m = 2; m + 2 < nFreqs; m++) {
    const y0 = magNorm[m - 1];
    const y1 = magNorm[m];
    const y2 = magNorm[m + 1];
    if (y1 > y0 && y1 >= y2 && y1 > magNorm[m - 2] * 1.01 && y1 > magNorm[m + 2] * 1.01 && y1 > 0.35) {
      const denom = y0 - 2 * y1 + y2;
      const delta = Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0;
      const fPeak = fMin + (m + delta) * fStep;
      const pkVal = y1 - 0.25 * (y0 - y2) * delta;
      // Enforce minimum spacing between distinct longitudinal modes
      if (peaksHz.length === 0 || fPeak - peaksHz[peaksHz.length - 1] > 38) {
        peaksHz.push(+fPeak.toFixed(2));
        peaksMag.push(+pkVal.toFixed(3));
      } else if (pkVal > peaksMag[peaksMag.length - 1]) {
        peaksHz[peaksHz.length - 1] = +fPeak.toFixed(2);
        peaksMag[peaksMag.length - 1] = +pkVal.toFixed(3);
      }
      if (peaksHz.length >= 7) break;
    }
  }

  const sol: TmmSolution = { fMin, fStep, magNorm, peaksHz, peaksMag };
  tmmCache.set(cacheKey, sol);
  return sol;
}

function sampleImpedanceAt(grid: { fMin: number; fStep: number; magNorm: number[] }, fHz: number): number {
  const arr = grid.magNorm;
  if (arr.length === 0) return 1;
  const pos = (fHz - grid.fMin) / grid.fStep;
  if (pos <= 0) return arr[0];
  if (pos >= arr.length - 1) return arr[arr.length - 1];
  const i0 = Math.floor(pos);
  const frac = pos - i0;
  return arr[i0] * (1 - frac) + arr[i0 + 1] * frac;
}

// ---------------------------------------------------------------------------
// Public Bore Extraction & Wave-Equation Voice Solver
// ---------------------------------------------------------------------------

/**
 * Slices `node`'s 3D bore (primitives + triangle meshes + sculpted holes/baffles)
 * and solves the 2x2 conical acoustic transfer matrix for its input impedance
 * resonances and radiation properties.
 */
export function extractBoreWaveguide(
  node: SceneNode,
  jointPositions?: Record<string, number>,
  sampleRate = DEFAULT_SAMPLE_RATE,
): BoreWaveguideModel | null {
  const spec: WindInstrumentSpec | undefined = node.windInstrument;
  if (!spec) return null;

  const slice = inspectNodeBoreGeometry(node);
  const dxCell = SPEED_OF_SOUND_WARM_AIR / sampleRate;

  // Compute extra tubing length switched in by depressed brass piston/rotary valves (2^(semitones/12))
  let valveLengthRatio = 1.0;
  if (spec.valveJoints?.length && jointPositions) {
    let totalSemitones = 0;
    for (const vj of spec.valveJoints) {
      const qVal = Math.abs(jointPositions[vj.jointName] ?? 0);
      const fullStroke = Math.max(0.003, vj.strokeM ?? 0.012);
      const engage = Math.max(0, Math.min(1, (qVal - fullStroke * 0.35) / (fullStroke * 0.40)));
      totalSemitones += vj.semitones * engage;
    }
    valveLengthRatio = Math.pow(2, totalSemitones / 12);
  }

  // Always prefer live 3D geometry when sculpted or when spec overrides are omitted!
  const useLiveGeometry = !!node.sculptEdited || !spec.boreLengthM || spec.boreLengthM <= 0.05;
  const rawBoreLengthM = useLiveGeometry ? slice.lengthM : spec.boreLengthM!;

  const nTmmNodes = 36;
  const rawRadii = (!node.sculptEdited && spec.mouthRadiusM !== undefined && spec.bellRadiusM !== undefined)
    ? Array.from({ length: nTmmNodes }, (_, k) => {
        const u = k / (nTmmNodes - 1);
        const flareExp = Math.max(0.5, Math.min(6, spec.flareExponent ?? 2.5));
        const leadTaper = spec.mouthRadiusM! + (spec.bellRadiusM! - spec.mouthRadiusM!) * 0.08 * u;
        return leadTaper + (spec.bellRadiusM! - leadTaper) * Math.pow(u, flareExp);
      })
    : slice.radiiAtStations(nTmmNodes);

  const mouthRadiusM = rawRadii[0] ?? 0.007;
  const bellRadiusM = slice.muteFactor > 0.05
    ? Math.min(...rawRadii.slice(-5))
    : (rawRadii[rawRadii.length - 1] ?? mouthRadiusM);

  // Valve tubing inserts cylindrical valve-slide loops in the narrow neck/body section
  const baseBoreLengthM = rawBoreLengthM * valveLengthRatio;
  const acousticLengthM = baseBoreLengthM + 0.61 * bellRadiusM;
  const exactCells = Math.max(8, Math.min(178, acousticLengthM / dxCell));
  const cellCount = Math.max(8, Math.min(178, Math.floor(exactCells)));

  const cellRadii = (!node.sculptEdited && spec.mouthRadiusM !== undefined && spec.bellRadiusM !== undefined)
    ? Array.from({ length: cellCount }, (_, k) => {
        const u = cellCount <= 1 ? 0 : k / (cellCount - 1);
        const flareExp = Math.max(0.5, Math.min(6, spec.flareExponent ?? 2.5));
        const leadTaper = mouthRadiusM + (bellRadiusM - mouthRadiusM) * 0.08 * u;
        return leadTaper + (bellRadiusM - leadTaper) * Math.pow(u, flareExp);
      })
    : slice.radiiAtStations(cellCount);

  const areas = cellRadii.map((r) => Math.PI * r * r);
  const junctionK: number[] = [];
  for (let i = 0; i + 1 < cellCount; i++) {
    const a0 = areas[i];
    const a1 = areas[i + 1];
    const k = (a0 - a1) / Math.max(1e-12, a0 + a1);
    junctionK.push(+Math.max(-0.92, Math.min(0.92, k)).toFixed(5));
  }

  const neckRadiusM = rawRadii[Math.floor((nTmmNodes - 1) * 0.20)] ?? mouthRadiusM;
  const midRadiusM = rawRadii[Math.floor((nTmmNodes - 1) * 0.72)] ?? neckRadiusM;
  const bodyTaper = midRadiusM / Math.max(1e-4, neckRadiusM);
  const flareRatio = bellRadiusM / Math.max(1e-4, neckRadiusM);
  const boreShape: BoreWaveguideModel['boreShape'] =
    bodyTaper < 1.22
      ? 'cylindrical'
      : flareRatio >= 2.4
        ? 'flared_horn'
        : 'conical';

  // Combine BOTH articulated keywork toneholes AND 3D geometry holes (sculpted holes + boolean cuts)!
  const toneholes: ToneholeStation[] = [];
  if (spec.toneholeJoints?.length) {
    for (const th of spec.toneholeJoints) {
      const frac = Math.max(0.1, Math.min(0.94, th.axialFraction));
      const cellIdx = Math.max(1, Math.min(cellCount - 2, Math.round(frac * (cellCount - 1))));
      const rBore = cellRadii[cellIdx] ?? 0.0075;
      const rHole = Math.max(0.0015, (th.diameterMm || 7) / 2000);
      const tEff = 0.0035 + 1.5 * rHole;
      const kRef = (2 * Math.PI * 300) / SPEED_OF_SOUND_WARM_AIR;
      const zRatio = (kRef * tEff * rBore * rBore) / (rHole * rHole);
      const shunt = -1 / (1 + 2 * zRatio);
      const qVal = jointPositions && th.jointName ? Math.abs(jointPositions[th.jointName] ?? 0) : 0;
      const openAmount = jointPositions
        ? Math.max(0, Math.min(1, (qVal - 0.015) / 0.065))
        : 0;
      toneholes.push({
        cellIndex: cellIdx,
        axialFraction: frac,
        radiusMm: +(rHole * 2000).toFixed(1),
        shuntCoeff: +Math.max(-0.85, Math.min(-0.08, shunt)).toFixed(4),
        keyJointName: th.jointName,
        openAmount: +openAmount.toFixed(3),
      });
    }
  }

  let breachFactor = 0;
  for (const h of slice.transverseHoles) {
    const cellIdx = Math.max(1, Math.min(cellCount - 2, Math.round(h.axialFraction * (cellCount - 1))));
    const rBore = cellRadii[cellIdx] ?? 0.0075;
    const tEff = h.wallM + 1.5 * h.radiusM;
    const kRef = (2 * Math.PI * 300) / SPEED_OF_SOUND_WARM_AIR;
    const zRatio = (kRef * tEff * rBore * rBore) / (h.radiusM * h.radiusM);
    const shunt = -1 / (1 + 2 * zRatio);
    toneholes.push({
      cellIndex: cellIdx,
      axialFraction: h.axialFraction,
      radiusMm: +(h.radiusM * 2000).toFixed(1),
      shuntCoeff: +Math.max(-0.85, Math.min(-0.08, shunt)).toFixed(4),
      openAmount: 1,
      fromGeometry: true,
    });
    breachFactor = Math.min(1, breachFactor + Math.min(0.85, (h.radiusM / Math.max(0.004, rBore)) * 0.9));
  }
  toneholes.sort((a, b) => a.cellIndex - b.cellIndex);

  // Solve the exact 1D conical acoustic transfer matrix across the 3D cross-sections + open holes!
  // For valved horns, extra cylindrical valve tubing inserts before the bell flare (~first 55% of bore).
  const tmm = solveConicalBoreTMM(
    rawRadii,
    baseBoreLengthM,
    toneholes,
    spec.exciter === 'flute_jet',
    slice.muteFactor,
  );

  let resonantModesHz = tmm.peaksHz;
  if (resonantModesHz.length === 0) {
    const f1 = SPEED_OF_SOUND_WARM_AIR / ((boreShape === 'cylindrical' && spec.exciter !== 'flute_jet' ? 4 : 2) * acousticLengthM);
    resonantModesHz = boreShape === 'cylindrical' && spec.exciter !== 'flute_jet'
      ? [+f1.toFixed(2), +(3 * f1).toFixed(2), +(5 * f1).toFixed(2)]
      : [+f1.toFixed(2), +(2 * f1).toFixed(2), +(3 * f1).toFixed(2), +(4 * f1).toFixed(2)];
  }

  const bellCutoffHz = +Math.min(
    12000,
    Math.max(420, SPEED_OF_SOUND_WARM_AIR / (2 * Math.PI * Math.max(0.004, bellRadiusM))),
  ).toFixed(1);

  return {
    nodeId: node.id,
    exciter: spec.exciter,
    lengthM: +baseBoreLengthM.toFixed(4),
    mouthRadiusM: +mouthRadiusM.toFixed(5),
    bellRadiusM: +bellRadiusM.toFixed(5),
    cellCount,
    exactCells: +exactCells.toFixed(4),
    junctionK,
    bellCutoffHz,
    boreShape,
    toneholes,
    resonantModesHz,
    modeImpedancePeaks: tmm.peaksMag,
    impedanceGrid: { fMin: tmm.fMin, fStep: tmm.fStep, magNorm: tmm.magNorm },
    muteFactor: slice.muteFactor,
    breachFactor: +breachFactor.toFixed(3),
  };
}

export interface PlayableWindVoiceInput {
  exciter: WindExciterKind;
  boreShape?: 'cylindrical' | 'conical' | 'flared_horn';
  resonantModesHz?: number[];
  modeImpedancePeaks?: number[];
  impedanceGrid?: { fMin: number; fStep: number; magNorm: number[] };
  muteFactor?: number;
  breachFactor?: number;
  bellCutoffHz: number;
  exactCells?: number;
  cellCount?: number;
}

export interface SolvedPlayableWindVoice {
  active: boolean;
  pitchHz: number;
  modeIndex: number;
  amplitude: number;
  drive: number;
  formantHz: number;
  formantGainDb: number;
  formantQ: number;
  bellLowpassHz: number;
  bellQ: number;
  noiseGain: number;
  /** Coherent impulse-train phase alignment (0 = dispersed musical horn phase; 1 = autonomous relaxation slap-valve!). */
  phaseCoherence?: number;
  /** Audio-rate per-cycle air-puff modulation depth on turbulent jet noise (for sub-resonant autonomous flap valves). */
  puffGateDepth?: number;
  /** Aero-elastic lip/flap flutter rate (Hz) and depth fraction. */
  flutterHz?: number;
  flutterFrac?: number;
  /** Audio-rate liquid/compliant formant sweep rate (Hz) and excursion (Hz) for wet squelch resonances. */
  squelchRateHz?: number;
  squelchSweepHz?: number;
  /** Normalized harmonic amplitudes H_1..H_N computed directly from Z_in(n * f_0) & radiation! */
  harmonicWeights: number[];
}

/**
 * Pure physical acoustics solver mapping a bore's TMM input-impedance curve
 * `Z_in(f)`, `resonantModesHz`, `muteFactor`, and `breachFactor` to its locked
 * playing frequency and radiated harmonic Fourier spectrum `H_1..H_10`.
 */
export function solvePlayableWindVoice(
  bore: PlayableWindVoiceInput,
  breathKPa: number,
  embouchureHz: number,
): SolvedPlayableWindVoice {
  const bShape = bore.boreShape ?? (bore.exciter === 'brass_lip' ? 'flared_horn' : 'cylindrical');
  const mute = Math.max(0, Math.min(1, bore.muteFactor ?? 0));
  const breach = Math.max(0, Math.min(1, bore.breachFactor ?? 0));

  let modes = bore.resonantModesHz && bore.resonantModesHz.length > 0 ? bore.resonantModesHz : [];
  if (modes.length === 0) {
    const cells = Math.max(8, bore.exactCells ?? bore.cellCount ?? 32);
    const effLenM = (cells * SPEED_OF_SOUND_WARM_AIR) / DEFAULT_SAMPLE_RATE;
    if (bore.exciter === 'flute_jet' || bShape !== 'cylindrical') {
      const fBase = SPEED_OF_SOUND_WARM_AIR / (2 * effLenM);
      modes = [1, 2, 3, 4, 5, 6].map((n) => n * fBase * (bShape === 'flared_horn' && n === 1 ? 0.88 : 1));
    } else {
      const f1 = SPEED_OF_SOUND_WARM_AIR / (4 * effLenM);
      modes = [f1, 3 * f1, 5 * f1, 7 * f1];
    }
  }

  // An unsealed breach/hole lowers |Z_in|, requiring slightly higher threshold breath pressure to speak
  const thresholdKPa = 0.22 + 0.18 * breach;
  if (!(breathKPa > thresholdKPa) || modes.length === 0) {
    return {
      active: false,
      pitchHz: modes[0] ?? 261.63,
      modeIndex: 0,
      amplitude: 0,
      drive: 0.35,
      formantHz: 850,
      formantGainDb: 3,
      formantQ: 1.2,
      bellLowpassHz: 900,
      bellQ: 0.8,
      noiseGain: 0,
      harmonicWeights: [1, 0.3, 0.15, 0.05],
    };
  }

  const bNorm = Math.max(0, Math.min(1.35, (breathKPa - thresholdKPa) / 3.8));
  const embHz = Math.max(16, Math.min(2400, embouchureHz || 330));

  let modeIdx = 0;
  let pitchHz: number;
  let autonomousFlap = 0;

  if (bore.exciter === 'brass_lip') {
    const fBore1 = modes[0] ?? 330;
    // Fletcher / Cullen aero-elastic transition:
    // When lip natural frequency f_lip << lowest bore acoustic resonance f_bore,1 (e.g. buzzing a short
    // mouthpiece, rubber spout, or compliant flap valve whose tube is shorter than a quarter-wavelength!),
    // standing-wave entrainment vanishes and the valve oscillates autonomously at f_lip as a relaxation slap-train!
    autonomousFlap = Math.max(0, Math.min(1, (0.68 * fBore1 - embHz) / Math.max(10, 0.32 * fBore1)));

    let bestScore = -Infinity;
    for (let i = 0; i < modes.length; i++) {
      const distOct = Math.abs(Math.log2(modes[i] / embHz));
      // Weight proximity to lip frequency + TMM impedance peak strength (weak breached peaks are harder to slot!)
      const peakStrength = bore.modeImpedancePeaks?.[i] ?? 8;
      const score = -distOct * 4.5 + 0.18 * Math.log2(Math.max(1.2, peakStrength));
      if (score > bestScore) {
        bestScore = score;
        modeIdx = i;
      }
    }
    const baseModeHz = modes[modeIdx];
    const pullOct = Math.max(-0.013, Math.min(0.013, 0.08 * Math.log2(embHz / baseModeHz)));
    const entrainedHz = baseModeHz * Math.pow(2, pullOct);
    pitchHz = (1 - autonomousFlap) * entrainedHz + autonomousFlap * embHz;
  } else if (bore.exciter === 'flute_jet') {
    const jetTargetHz = embHz * (0.82 + 0.32 * bNorm);
    if (modes.length > 2 && jetTargetHz > modes[1] * 1.38) modeIdx = 2;
    else if (modes.length > 1 && jetTargetHz > modes[0] * 1.55) modeIdx = 1;
    pitchHz = modes[modeIdx];
  } else {
    if (modes.length > 1 && embHz > modes[0] * 2.35) {
      modeIdx = 1;
    }
    pitchHz = modes[modeIdx];
  }

  pitchHz = Math.max(16, Math.min(3500, pitchHz));
  const bellCut = Math.max(420, Math.min(8000, bore.bellCutoffHz || 1500));

  // Compute real harmonic regeneration weights H_1..H_N directly from the bore's TMM impedance curve Z_in(n * f_0)!
  // In the sub-resonant autonomous slap-valve regime (autonomousFlap > 0.2), sharp mucosal/rubber closure
  // excites up to 40 harmonics shaped by the short spout's vocal-tract formant resonance `modes[0]`!
  // In the sub-resonant autonomous slap-valve regime (autonomousFlap > 0.2), Rosenberg asymmetric
  // mucosal/rubber sawtooth-pulse closure excites 24..28 harmonics with low crest factor (loud, meaty buzz!)
  const nMaxHarm = autonomousFlap > 0.2 ? 26 : 10;
  const harmonicWeights: number[] = [];
  const zFund = bore.impedanceGrid
    ? Math.max(1.5, sampleImpedanceAt(bore.impedanceGrid, pitchHz))
    : (bore.modeImpedancePeaks?.[modeIdx] ?? 10);

  // Reduced impedance Q from a wall breach weakens nonlinear harmonic lock on entrained horns,
  // while autonomous relaxation valves are driven directly by upstream pressure!
  const hornQHealth = Math.max(0.35, Math.min(1.15, Math.log10(1 + zFund) / 1.15)) * (1 - 0.24 * breach);
  const qHealth = (1 - autonomousFlap) * hornQHealth + autonomousFlap * (0.98 - 0.10 * breach);
  const spoutFormantHz = Math.max(420, Math.min(1350, (modes[0] ?? 760) * 0.78));

  for (let n = 1; n <= nMaxHarm; n++) {
    const fn = n * pitchHz;
    if (autonomousFlap > 0.2) {
      // Rosenberg asymmetric mucosal relaxation sawtooth-pulse (1 / n^0.52) -> rich, fat low-mid buzz
      // without the -15 dB WebAudio peak-normalization loss of a 44-term zero-phase spike!
      const sawPulse = Math.pow(n, -0.50) * Math.exp(-0.0028 * (n - 1) * (n - 1));
      const df = (fn - spoutFormantHz) / (spoutFormantHz * (0.48 + 0.25 * breach));
      const formantBoost = 1 + 1.6 * Math.exp(-0.5 * df * df);
      const zn = bore.impedanceGrid ? sampleImpedanceAt(bore.impedanceGrid, Math.min(2290, fn)) : 2.5;
      const tmmShape = 0.72 + 0.28 * Math.min(1.5, zn / 3.0);
      const muteTilt = mute > 0.02
        ? (n <= 2 ? 1 - 0.55 * mute : 1 + 0.9 * mute * Math.exp(-0.03 * (n - 7) * (n - 7)))
        : 1.0;
      const w = sawPulse * formantBoost * tmmShape * muteTilt;
      harmonicWeights.push(+Math.max(0.003, w).toFixed(4));
      continue;
    }

    let zCoop: number;
    if (bore.impedanceGrid) {
      const zn = sampleImpedanceAt(bore.impedanceGrid, fn);
      zCoop = Math.min(1.45, zn / Math.max(2.0, zFund));
    } else if (bShape === 'cylindrical' && bore.exciter === 'reed') {
      zCoop = n % 2 === 1 ? 1.0 / Math.sqrt(n) : 0.06;
    } else {
      zCoop = 1.0 / Math.pow(n, 0.45);
    }

    const exciterFalloff =
      bore.exciter === 'flute_jet'
        ? Math.pow(n, -1.85)
        : bore.exciter === 'brass_lip'
          ? Math.exp(-0.085 * (n - 1) * (n - 1) / Math.max(0.45, 0.55 + 0.65 * bNorm))
          : Math.pow(n, -1.05);

    const radHighpass = fn / Math.hypot(fn, bellCut * (0.48 - 0.15 * breach));
    const muteTilt = mute > 0.02
      ? (n === 1 ? 1 - 0.52 * mute : 1 + mute * 1.15 * Math.exp(-0.18 * (n - 3.5) * (n - 3.5)))
      : 1.0;

    const w = n === 1
      ? Math.max(0.25, muteTilt)
      : exciterFalloff * (0.16 + 0.95 * zCoop) * (0.55 + 0.65 * radHighpass) * muteTilt;
    harmonicWeights.push(+Math.max(0.001, w).toFixed(4));
  }

  // Normalize harmonicWeights so max weight = 1.0
  const maxW = Math.max(1e-6, ...harmonicWeights);
  for (let i = 0; i < harmonicWeights.length; i++) {
    harmonicWeights[i] = +(harmonicWeights[i] / maxW).toFixed(4);
  }

  const rawBlowAmp = 0.24 * Math.tanh(bNorm * 1.35);
  const amp = rawBlowAmp * qHealth * (1 - 0.20 * mute);

  if (bore.exciter === 'brass_lip') {
    if (autonomousFlap > 0.2) {
      // Autonomous compliant slap-valve + wet resonant formant squelch:
      // Center formant tracks pressure & pitch across 340..1150 Hz ("bwww-ooww-wah-squelch"!) with high Q!
      const dynamicVowelHz = Math.max(320, Math.min(1280, spoutFormantHz * (0.55 + 0.58 * bNorm) + pitchHz * 1.1));
      const formantHz = dynamicVowelHz * (1 - 0.35 * mute) + 1650 * (0.35 * mute);
      const squelchCutoffHz = Math.max(380, Math.min(1650, formantHz * (1.05 + 0.45 * bNorm + 0.25 * breach)));
      return {
        active: true,
        pitchHz: +pitchHz.toFixed(2),
        modeIndex: 0,
        amplitude: +(Math.min(0.42, rawBlowAmp * 1.65) * (1 - 0.15 * mute)).toFixed(4),
        drive: +(1.25 + 0.75 * bNorm).toFixed(4),
        formantHz: +formantHz.toFixed(1),
        formantGainDb: +(11.5 + 3.0 * mute).toFixed(2),
        formantQ: +(4.8 + 2.2 * mute).toFixed(2),
        bellLowpassHz: +squelchCutoffHz.toFixed(1),
        bellQ: +(3.6 + 1.4 * mute).toFixed(2),
        // Very low broadband wind hiss — real compliant flap-valves are dominated by wet resonant buzz & squelch!
        noiseGain: +(rawBlowAmp * (0.004 + 0.018 * breach)).toFixed(5),
        phaseCoherence: +autonomousFlap.toFixed(3),
        puffGateDepth: +(rawBlowAmp * (0.022 + 0.035 * breach) * autonomousFlap).toFixed(4),
        flutterHz: +(13.5 + 10.5 * bNorm).toFixed(2),
        flutterFrac: +(0.11 * autonomousFlap * (0.55 + 0.65 * bNorm)).toFixed(4),
        squelchRateHz: +(9.5 + 14.0 * bNorm).toFixed(2),
        squelchSweepHz: +((220 + 340 * bNorm) * autonomousFlap).toFixed(1),
        harmonicWeights,
      };
    }

    // Muting shifts formant upward into nasal 1.6..2.2 kHz band with sharper Q; side breaches add airy leak turbulence!
    const baseFormant = Math.max(720, Math.min(1280, 520 + pitchHz * 1.35));
    const formantHz = baseFormant * (1 - mute) + Math.min(2250, baseFormant * 1.85) * mute;
    return {
      active: true,
      pitchHz: +pitchHz.toFixed(2),
      modeIndex: modeIdx,
      amplitude: +(amp * 1.08).toFixed(4),
      drive: +(0.54 + 0.34 * bNorm * qHealth).toFixed(4),
      formantHz: +formantHz.toFixed(1),
      formantGainDb: +(5.0 + 4.5 * mute - 1.5 * breach).toFixed(2),
      formantQ: +(1.2 + 2.2 * mute).toFixed(2),
      bellLowpassHz: +Math.max(620, Math.min(2850, Math.min(bellCut * (1.9 + 0.6 * mute + 0.4 * breach), pitchHz * (1.75 + 2.8 * bNorm)))).toFixed(1),
      bellQ: +(1.05 + 1.1 * mute).toFixed(2),
      noiseGain: +(rawBlowAmp * (0.016 + 0.16 * breach + 0.04 * mute)).toFixed(5),
      phaseCoherence: 0,
      puffGateDepth: 0,
      harmonicWeights,
    };
  }

  if (bore.exciter === 'flute_jet') {
    return {
      active: true,
      pitchHz: +pitchHz.toFixed(2),
      modeIndex: modeIdx,
      amplitude: +(amp * 0.92).toFixed(4),
      drive: +(0.38 + 0.22 * bNorm).toFixed(4),
      formantHz: +Math.max(360, Math.min(1200, pitchHz * 1.5)).toFixed(1),
      formantGainDb: 2.0,
      formantQ: 0.95,
      bellLowpassHz: +Math.max(520, Math.min(2800, pitchHz * (2.1 + 2.2 * bNorm))).toFixed(1),
      bellQ: 0.72,
      noiseGain: +(amp * (0.11 + 0.10 * breach)).toFixed(5),
      harmonicWeights,
    };
  }

  const baseFormant = Math.max(480, Math.min(1420, pitchHz * (bShape === 'cylindrical' ? 3.0 : 2.2)));
  return {
    active: true,
    pitchHz: +pitchHz.toFixed(2),
    modeIndex: modeIdx,
    amplitude: +(amp * 0.96).toFixed(4),
    drive: +(0.50 + 0.32 * bNorm * qHealth).toFixed(4),
    formantHz: +(baseFormant * (1 + 0.45 * mute)).toFixed(1),
    formantGainDb: +(3.6 + 3.5 * mute).toFixed(2),
    formantQ: +(1.3 + 1.6 * mute).toFixed(2),
    bellLowpassHz: +Math.max(620, Math.min(2500, Math.min(bellCut * (1.35 + 0.45 * breach), pitchHz * (2.5 + 2.9 * bNorm)))).toFixed(1),
    bellQ: +(0.88 + 0.8 * mute).toFixed(2),
    noiseGain: +(amp * (0.030 + 0.12 * breach)).toFixed(5),
    harmonicWeights,
  };
}
