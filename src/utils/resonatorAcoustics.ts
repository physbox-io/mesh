// ---------------------------------------------------------------------------
// Marimba & Vibraphone External Tube Resonators + Motor-Driven Tremolo Fans
// ---------------------------------------------------------------------------
//
// Physics implemented (Fletcher & Rossing §19.2; Rossing, Moore & Wheeler):
// 1. 3D Standing-Wave Tube Air Column (`extractTubeAirColumn`):
//    - Measures true inner radius r, column length L_bore, and boundary condition:
//      * 'open_closed' (quarter-wave λ/4 stopped marimba/vibraphone tube):
//          f_1 = c_air / (4 * (L_bore + 0.6133 * r)),   harmonics 1, 3, 5...
//      * 'open_open' (half-wave λ/2 open pipe):
//          f_1 = c_air / (2 * (L_bore + 2 * 0.6133 * r)), harmonics 1, 2, 3...
// 2. Cross-Body Bar <-> Tube Radiation & Energy-Conserving Q Tradeoff:
//    - Discovers resonator tubes either via explicit `bar.resonatorNodeId` /
//      `tube.resonatorTube.coupledBarNodeId` OR automatically in 3D space when
//      an open tube mouth sits beneath a struck bar's antinode!
//    - Lorentzian acoustic resonance coupling L(f_bar, f_tube) boosts fundamental
//      radiated gain (+4..+9 dB) while increasing radiation damping on the bar
//      (shortening bar T_60 when open, restoring long dry sustain when closed!).
// 3. Motor-Driven Rotating Vane Amplitude & Formant Tremolo (Vibraphone):
//    - Reads live hinge angle theta_0 = q_vane and angular velocity Omega_vane
//      from MuJoCo `data` (`qpos` / `qvel`) or explicit joint maps.
//    - A rotating disk inside the circular tube mouth opens twice per shaft
//      revolution -> acoustic tremolo frequency f_trem = |Omega_vane| / pi = 2 * f_shaft,
//      modulating both fundamental amplitude and throat-reactance formant!
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { ResonatorTubeEndCondition, SceneNode } from '../types/scene';
import type { DataMirror, ModelMirror } from '../types/sceneLayer';
import { generateTubeMeshData } from './geom';
import type { BodyModalProfile, ModalVoice } from './modalAudio';
import {
  analyze3DCavityAndPorts,
  analyze3DSolidCrossSections,
  buildBodyRayScene,
  castSceneRay,
  evaluateNormalizedModeShape,
} from './solidAcoustics3D';

const SPEED_OF_SOUND_AIR = 343.0;
const UNFLANGED_END_CORRECTION = 0.6133;

export interface ExtractedTubeAirColumn {
  tubeNodeId: string;
  tubeName: string;
  endCondition: ResonatorTubeEndCondition;
  boreLengthM: number;
  innerRadiusM: number;
  outerRadiusM: number;
  crossAreaM2: number;
  fundamentalHz: number;
  overtonesHz: number[];
  qualityQ: number;
  boreAxisLocal: 0 | 1 | 2;
  mouthSignLocal: 1 | -1;
  axisDirWorld: [number, number, number];
  mouthCenterWorld: [number, number, number];
}

export interface ResonatorLiveKinematics {
  model?: ModelMirror | null;
  data?: DataMirror | null;
  jointPositions?: Record<string, number>;
  jointVelocities?: Record<string, number>;
}

export interface TremoloModulationSpec {
  active: boolean;
  vaneJointName: string | null;
  vaneAngleRad: number;
  shaftSpeedRadPerSec: number;
  /** Acoustic tremolo rate in Hz: f_trem = |Omega_vane| / pi = 2 * f_shaft (two open/close cycles per shaft revolution!). */
  tremoloHz: number;
  /** Instantaneous open-mouth transmission factor eta(theta_0) in [1 - maxOcclusion, 1]. */
  instantaneousOpenFactor: number;
  /** Cycle-averaged open factor when spinning, or instantaneous when stopped. */
  meanOpenFactor: number;
  /** Peak-to-peak amplitude modulation depth in [0, 0.95]. */
  amDepth: number;
  /** Peak formant gain swing in dB at f_1 (0..6.5 dB). */
  formantGainSwingDb: number;
  /** Fractional reactive pitch/formant pull when the vane partially closes the mouth (0..0.014). */
  formantFreqDetuneRatio: number;
  initialPhaseRad: number;
}

export interface CoupledTubeResonatorResult {
  tube: ExtractedTubeAirColumn;
  gapM: number;
  lateralOffsetM: number;
  geometricCoupling: number;
  lorentzianDetuning: number;
  fundamentalGainMultiplier: number;
  fundamentalDecayMultiplier: number;
  coupledVoices: ModalVoice[];
  tremolo: TremoloModulationSpec;
}

interface NodeWorldPose {
  node: SceneNode;
  pos: [number, number, number];
  /** Column-major 3x3 rotation matrix: col0=[0..2], col1=[3..5], col2=[6..8] */
  rot: [number, number, number, number, number, number, number, number, number];
}

const _posePos = new THREE.Vector3();
const _poseQuat = new THREE.Quaternion();
const _poseEuler = new THREE.Euler();
const _poseScale = new THREE.Vector3(1, 1, 1);
const _poseLocalMat = new THREE.Matrix4();
const _poseWorldStack: THREE.Matrix4[] = [new THREE.Matrix4()];

function composeNodeLocalMat(n: SceneNode, out: THREE.Matrix4): void {
  const px = n.pos?.[0] ?? 0;
  const py = n.pos?.[1] ?? 0;
  const pz = n.pos?.[2] ?? 0;
  if (n.quat) {
    // MuJoCo [w, x, y, z] -> Three.js (x, y, z, w)
    _poseQuat.set(n.quat[1], n.quat[2], n.quat[3], n.quat[0]).normalize();
    _posePos.set(px, py, pz);
    out.compose(_posePos, _poseQuat, _poseScale);
  } else if (n.euler) {
    _poseEuler.set(
      (n.euler[0] || 0) * THREE.MathUtils.DEG2RAD,
      (n.euler[1] || 0) * THREE.MathUtils.DEG2RAD,
      (n.euler[2] || 0) * THREE.MathUtils.DEG2RAD,
      'XYZ',
    );
    _poseQuat.setFromEuler(_poseEuler);
    _posePos.set(px, py, pz);
    out.compose(_posePos, _poseQuat, _poseScale);
  } else {
    out.makeTranslation(px, py, pz);
  }
}

function collectWorldPoses(
  nodes: SceneNode[] | undefined,
  liveKin?: ResonatorLiveKinematics,
): Map<string, NodeWorldPose> {
  const out = new Map<string, NodeWorldPose>();
  if (!nodes) return out;

  const bodyIdMap = (liveKin?.model?._idMaps?.body as Record<string, number> | undefined) ?? undefined;
  const xpos = liveKin?.data?.xpos;
  const xmat = liveKin?.data?.xmat;

  const walk = (list: SceneNode[], depth: number) => {
    const parentMat = _poseWorldStack[depth];
    let childMat = _poseWorldStack[depth + 1];
    if (!childMat) {
      childMat = new THREE.Matrix4();
      _poseWorldStack[depth + 1] = childMat;
    }
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      const hasChildren = (n.children?.length ?? 0) > 0;
      const bId = bodyIdMap ? (bodyIdMap[n.name] ?? bodyIdMap[n.id]) : undefined;
      const hasLive = bId !== undefined && bId > 0 && xpos !== undefined && xmat !== undefined && bId * 9 + 8 < xmat.length;

      let pos: [number, number, number];
      let rot: [number, number, number, number, number, number, number, number, number];

      if (hasLive && !hasChildren) {
        const m3 = bId * 3;
        const m9 = bId * 9;
        pos = [xpos[m3], xpos[m3 + 1], xpos[m3 + 2]];
        // MuJoCo xmat is row-major; store column-major so col c is rot[c*3..c*3+2]
        rot = [
          xmat[m9], xmat[m9 + 3], xmat[m9 + 6],
          xmat[m9 + 1], xmat[m9 + 4], xmat[m9 + 7],
          xmat[m9 + 2], xmat[m9 + 5], xmat[m9 + 8],
        ];
      } else {
        composeNodeLocalMat(n, _poseLocalMat);
        childMat.multiplyMatrices(parentMat, _poseLocalMat);
        if (hasLive) {
          const m3 = bId * 3;
          const m9 = bId * 9;
          pos = [xpos[m3], xpos[m3 + 1], xpos[m3 + 2]];
          rot = [
            xmat[m9], xmat[m9 + 3], xmat[m9 + 6],
            xmat[m9 + 1], xmat[m9 + 4], xmat[m9 + 7],
            xmat[m9 + 2], xmat[m9 + 5], xmat[m9 + 8],
          ];
        } else {
          const e = childMat.elements;
          pos = [e[12], e[13], e[14]];
          rot = [
            e[0], e[1], e[2],
            e[4], e[5], e[6],
            e[8], e[9], e[10],
          ];
        }
      }

      out.set(n.id, { node: n, pos, rot });
      if (hasChildren) walk(n.children!, depth + 1);
    }
  };

  _poseWorldStack[0].identity();
  walk(nodes, 0);
  return out;
}

function readLiveJointState(
  jointName: string,
  liveKin?: ResonatorLiveKinematics,
): { pos: number; vel: number } {
  const explicitPos = liveKin?.jointPositions?.[jointName];
  const explicitVel = liveKin?.jointVelocities?.[jointName];
  if (explicitPos !== undefined || explicitVel !== undefined) {
    return { pos: explicitPos ?? 0, vel: explicitVel ?? 0 };
  }
  const jMap = (liveKin?.model?._idMaps?.joint as Record<string, number> | undefined) ?? undefined;
  const jId = jMap?.[jointName];
  if (jId === undefined || !liveKin?.model || !liveKin?.data) {
    return { pos: 0, vel: 0 };
  }
  const qposAdr = liveKin.model.jnt_qposadr?.[jId];
  const dofAdr = liveKin.model.jnt_dofadr?.[jId];
  const pos = qposAdr !== undefined ? (liveKin.data.qpos[qposAdr] ?? 0) : 0;
  const vel = dofAdr !== undefined ? (liveKin.data.qvel[dofAdr] ?? 0) : 0;
  return { pos, vel };
}

interface CachedLocalTubeAirColumn {
  tubeNodeId: string;
  tubeName: string;
  endCondition: ResonatorTubeEndCondition;
  boreLengthM: number;
  innerRadiusM: number;
  outerRadiusM: number;
  crossAreaM2: number;
  fundamentalHz: number;
  overtonesHz: number[];
  qualityQ: number;
  boreAxisLocal: 0 | 1 | 2;
  uAxis: 0 | 1 | 2;
  vAxis: 0 | 1 | 2;
  centerU: number;
  centerV: number;
  boreLo: number;
  boreHi: number;
  fixedMouthSign: 1 | -1 | 0; // 0 = open both ends (resolved by world +Z)
}

const localTubeColumnCache = new Map<string, CachedLocalTubeAirColumn | null>();
const MAX_LOCAL_TUBE_CACHE = 128;

function tubeLocalGeometrySignature(n: SceneNode): string {
  const spec = n.resonatorTube;
  let sig = `${n.id}|${n.name}|${n.isTube ? 1 : 0}|${n.innerRadius ?? ''}|${n.outerRadius ?? ''}|${n.height ?? ''}|${n.csgEnabled === false ? 0 : 1}|${n.sculptVersion ?? 0}|${n.sculptEdited ? 1 : 0}|${spec?.endCondition ?? ''}|${spec?.tuningHz ?? ''}`;
  const geoms = n.geoms;
  if (geoms) {
    for (let i = 0; i < geoms.length; i++) {
      const g = geoms[i];
      if (g.csgDerived || g.role === 'visual' || g.type === 'plane') continue;
      sig += `;${g.name ?? ''}:${g.type}:${g.csg ?? ''}:${g.size ? g.size.join(',') : ''}:${g.pos ? g.pos.join(',') : ''}:${g.quat ? g.quat.join(',') : ''}:${g.euler ? g.euler.join(',') : ''}:${g.fromto ? g.fromto.join(',') : ''}:${g.renderVertices?.length ?? g.vertices?.length ?? 0}:${g.faces?.length ?? 0}`;
    }
  }
  return sig;
}

function getOrAnalyzeLocalTubeAirColumn(tubeNode: SceneNode): CachedLocalTubeAirColumn | null {
  const sig = tubeLocalGeometrySignature(tubeNode);
  const hit = localTubeColumnCache.get(sig);
  if (hit !== undefined) {
    localTubeColumnCache.delete(sig);
    localTubeColumnCache.set(sig, hit);
    return hit;
  }

  const spec = tubeNode.resonatorTube;
  const scene = buildBodyRayScene(tubeNode, true);
  if (!scene) {
    if (localTubeColumnCache.size >= MAX_LOCAL_TUBE_CACHE) {
      const oldest = localTubeColumnCache.keys().next().value;
      if (oldest !== undefined) localTubeColumnCache.delete(oldest);
    }
    localTubeColumnCache.set(sig, null);
    return null;
  }

  const [bx0, bx1, by0, by1, bz0, bz1] = scene.bounds;
  const spans: [number, number, number] = [bx1 - bx0, by1 - by0, bz1 - bz0];

  // Determine bore axis: for `isTube` it is Z (unless rotated geom); otherwise longest hollow axis
  let boreAxis: 0 | 1 | 2 = 2;
  if (!tubeNode.isTube) {
    if (spans[0] >= spans[1] && spans[0] >= spans[2]) boreAxis = 0;
    else if (spans[1] >= spans[0] && spans[1] >= spans[2]) boreAxis = 1;
    else boreAxis = 2;
  }

  const uAxis = ((boreAxis + 1) % 3) as 0 | 1 | 2;
  const vAxis = ((boreAxis + 2) % 3) as 0 | 1 | 2;
  const boundsMin = [bx0, by0, bz0];
  const boundsMax = [bx1, by1, bz1];
  const centerU = 0.5 * (boundsMin[uAxis] + boundsMax[uAxis]);
  const centerV = 0.5 * (boundsMin[vAxis] + boundsMax[vAxis]);

  // Cast axial ray right down the bore centerline to check if ends are open or capped!
  const axOrigin: [number, number, number] = [0, 0, 0];
  axOrigin[uAxis] = centerU;
  axOrigin[vAxis] = centerV;
  axOrigin[boreAxis] = 0;
  const axDir: [number, number, number] = [0, 0, 0];
  axDir[boreAxis] = 1;
  const centerAxialIvs = castSceneRay(scene, axOrigin[0], axOrigin[1], axOrigin[2], axDir[0], axDir[1], axDir[2]);

  const midAxial = 0.5 * (boundsMin[boreAxis] + boundsMax[boreAxis]);

  let innerRadiusM = 0;
  let outerRadiusM = 0.25 * (spans[uAxis] + spans[vAxis]);
  if (tubeNode.isTube && typeof tubeNode.innerRadius === 'number' && tubeNode.innerRadius > 0.001) {
    innerRadiusM = tubeNode.innerRadius;
    outerRadiusM = Math.max(innerRadiusM + 0.001, tubeNode.outerRadius ?? outerRadiusM);
  } else {
    const uOrigin: [number, number, number] = [0, 0, 0];
    uOrigin[boreAxis] = midAxial;
    uOrigin[vAxis] = centerV;
    const uDir: [number, number, number] = [0, 0, 0];
    uDir[uAxis] = 1;
    const uIvs = castSceneRay(scene, uOrigin[0], uOrigin[1], uOrigin[2], uDir[0], uDir[1], uDir[2]);

    const vOrigin: [number, number, number] = [0, 0, 0];
    vOrigin[boreAxis] = midAxial;
    vOrigin[uAxis] = centerU;
    const vDir: [number, number, number] = [0, 0, 0];
    vDir[vAxis] = 1;
    const vIvs = castSceneRay(scene, vOrigin[0], vOrigin[1], vOrigin[2], vDir[0], vDir[1], vDir[2]);

    if (uIvs.length >= 2 && vIvs.length >= 2) {
      const gapU = uIvs[1][0] - uIvs[0][1];
      const gapV = vIvs[1][0] - vIvs[0][1];
      if (gapU > 0.002 && gapV > 0.002) {
        innerRadiusM = 0.25 * (gapU + gapV);
      }
    } else {
      const cav = analyze3DCavityAndPorts(tubeNode);
      if (!cav.hasHollowCavity || cav.ports.length === 0) {
        localTubeColumnCache.set(sig, null);
        return null;
      }
      innerRadiusM = cav.ports[0].eqRadiusM;
    }
  }

  if (innerRadiusM <= 0.0015) {
    localTubeColumnCache.set(sig, null);
    return null;
  }

  let boreLo = boundsMin[boreAxis];
  let boreHi = boundsMax[boreAxis];
  let closedLo = false;
  let closedHi = false;

  for (const [a, b] of centerAxialIvs) {
    const segMid = 0.5 * (a + b);
    if (b - a > 0.65 * spans[boreAxis]) {
      localTubeColumnCache.set(sig, null);
      return null;
    }
    if (segMid < midAxial) {
      closedLo = true;
      if (b > boreLo && b < midAxial) boreLo = b;
    } else {
      closedHi = true;
      if (a < boreHi && a > midAxial) boreHi = a;
    }
  }

  if (closedLo && closedHi && !spec) {
    localTubeColumnCache.set(sig, null);
    return null;
  }

  const boreLengthM = Math.max(0.015, boreHi - boreLo);
  if (!spec && boreLengthM < 1.2 * innerRadiusM * 2) {
    localTubeColumnCache.set(sig, null);
    return null;
  }

  const endCondition: ResonatorTubeEndCondition =
    spec?.endCondition ?? (closedLo !== closedHi ? 'open_closed' : 'open_open');

  const fixedMouthSign: 1 | -1 | 0 =
    closedHi && !closedLo ? -1 : !closedHi && closedLo ? 1 : 0;

  const geomFundamentalHz =
    endCondition === 'open_closed'
      ? SPEED_OF_SOUND_AIR / (4 * (boreLengthM + UNFLANGED_END_CORRECTION * innerRadiusM))
      : SPEED_OF_SOUND_AIR / (2 * (boreLengthM + 2 * UNFLANGED_END_CORRECTION * innerRadiusM));

  const fundamentalHz =
    typeof spec?.tuningHz === 'number' && Number.isFinite(spec.tuningHz) && spec.tuningHz > 20
      ? spec.tuningHz
      : geomFundamentalHz;

  const overtonesHz =
    endCondition === 'open_closed'
      ? [+(fundamentalHz).toFixed(2), +(3 * fundamentalHz).toFixed(2), +(5 * fundamentalHz).toFixed(2)]
      : [+(fundamentalHz).toFixed(2), +(2 * fundamentalHz).toFixed(2), +(3 * fundamentalHz).toFixed(2)];

  const k1 = (2 * Math.PI * fundamentalHz) / SPEED_OF_SOUND_AIR;
  const radLoss = endCondition === 'open_closed' ? 0.25 * Math.pow(k1 * innerRadiusM, 2) : 0.5 * Math.pow(k1 * innerRadiusM, 2);
  const wallLoss = 1.2e-4 * Math.sqrt(fundamentalHz) / Math.max(0.003, innerRadiusM);
  const qualityQ = Math.max(14, Math.min(52, 1 / Math.max(0.018, radLoss + wallLoss)));

  const localCol: CachedLocalTubeAirColumn = {
    tubeNodeId: tubeNode.id,
    tubeName: tubeNode.name,
    endCondition,
    boreLengthM: +boreLengthM.toFixed(5),
    innerRadiusM: +innerRadiusM.toFixed(5),
    outerRadiusM: +outerRadiusM.toFixed(5),
    crossAreaM2: +(Math.PI * innerRadiusM * innerRadiusM).toFixed(6),
    fundamentalHz: +fundamentalHz.toFixed(2),
    overtonesHz,
    qualityQ: +qualityQ.toFixed(1),
    boreAxisLocal: boreAxis,
    uAxis,
    vAxis,
    centerU,
    centerV,
    boreLo,
    boreHi,
    fixedMouthSign,
  };

  if (localTubeColumnCache.size >= MAX_LOCAL_TUBE_CACHE) {
    const oldest = localTubeColumnCache.keys().next().value;
    if (oldest !== undefined) localTubeColumnCache.delete(oldest);
  }
  localTubeColumnCache.set(sig, localCol);
  return localCol;
}

/**
 * Extracts the 3D standing-wave air column of a hollow resonator tube (`isTube`,
 * CSG-hollowed cylinder/box, or `node.resonatorTube`), returning `null` for solid
 * un-hollowed rods/bars.
 */
export function extractTubeAirColumn(
  tubeNode: SceneNode,
  liveKin?: ResonatorLiveKinematics,
  poseOverride?: NodeWorldPose,
): ExtractedTubeAirColumn | null {
  if (tubeNode.acousticString || tubeNode.acousticMembrane || tubeNode.windInstrument) return null;
  void liveKin;

  const localCol = getOrAnalyzeLocalTubeAirColumn(tubeNode);
  if (!localCol) return null;

  let px: number, py: number, pz: number;
  let r0: number, r1: number, r2: number, r3: number, r4: number, r5: number, r6: number, r7: number, r8: number;
  if (poseOverride) {
    px = poseOverride.pos[0];
    py = poseOverride.pos[1];
    pz = poseOverride.pos[2];
    const rot = poseOverride.rot;
    r0 = rot[0]; r1 = rot[1]; r2 = rot[2];
    r3 = rot[3]; r4 = rot[4]; r5 = rot[5];
    r6 = rot[6]; r7 = rot[7]; r8 = rot[8];
  } else {
    composeNodeLocalMat(tubeNode, _poseLocalMat);
    const e = _poseLocalMat.elements;
    px = e[12]; py = e[13]; pz = e[14];
    r0 = e[0]; r1 = e[1]; r2 = e[2];
    r3 = e[4]; r4 = e[5]; r5 = e[6];
    r6 = e[8]; r7 = e[9]; r8 = e[10];
  }

  const bAx = localCol.boreAxisLocal;
  const axX = bAx === 0 ? r0 : bAx === 1 ? r3 : r6;
  const axY = bAx === 0 ? r1 : bAx === 1 ? r4 : r7;
  const axZ = bAx === 0 ? r2 : bAx === 1 ? r5 : r8;
  const mouthSignLocal: 1 | -1 = localCol.fixedMouthSign !== 0
    ? localCol.fixedMouthSign
    : (axZ >= 0 ? 1 : -1);

  const axLen = Math.sqrt(axX * axX + axY * axY + axZ * axZ) || 1;
  const invAxLen = mouthSignLocal / axLen;
  const axisDirWorld: [number, number, number] = [axX * invAxLen, axY * invAxLen, axZ * invAxLen];

  const mouthLocalCoord = mouthSignLocal > 0 ? localCol.boreHi : localCol.boreLo;
  let lx = 0, ly = 0, lz = 0;
  if (localCol.uAxis === 0) lx = localCol.centerU;
  else if (localCol.uAxis === 1) ly = localCol.centerU;
  else lz = localCol.centerU;
  if (localCol.vAxis === 0) lx = localCol.centerV;
  else if (localCol.vAxis === 1) ly = localCol.centerV;
  else lz = localCol.centerV;
  if (bAx === 0) lx = mouthLocalCoord;
  else if (bAx === 1) ly = mouthLocalCoord;
  else lz = mouthLocalCoord;

  const mouthCenterWorld: [number, number, number] = [
    px + r0 * lx + r3 * ly + r6 * lz,
    py + r1 * lx + r4 * ly + r7 * lz,
    pz + r2 * lx + r5 * ly + r8 * lz,
  ];

  return {
    tubeNodeId: localCol.tubeNodeId,
    tubeName: localCol.tubeName,
    endCondition: localCol.endCondition,
    boreLengthM: localCol.boreLengthM,
    innerRadiusM: localCol.innerRadiusM,
    outerRadiusM: localCol.outerRadiusM,
    crossAreaM2: localCol.crossAreaM2,
    fundamentalHz: localCol.fundamentalHz,
    overtonesHz: localCol.overtonesHz,
    qualityQ: localCol.qualityQ,
    boreAxisLocal: localCol.boreAxisLocal,
    mouthSignLocal,
    axisDirWorld,
    mouthCenterWorld,
  };
}

function discoverTremoloVaneJoint(
  tubeNode: SceneNode,
  mouthWorld: [number, number, number],
  innerRadiusM: number,
  poses: Map<string, NodeWorldPose>,
): string | null {
  if (tubeNode.resonatorTube?.vaneJointName) {
    return tubeNode.resonatorTube.vaneJointName;
  }
  // Check hinged children on `tubeNode` first (standard vibraphone paddle hierarchy!)
  for (const ch of tubeNode.children ?? []) {
    const hinge = (ch.joints ?? []).find((j) => j.type === 'hinge');
    if (hinge) return hinge.name;
  }
  // Or any nearby hinged disk/vane body sitting right at `mouthWorld`
  for (const [, p] of poses) {
    if (p.node.id === tubeNode.id) continue;
    const hinge = (p.node.joints ?? []).find((j) => j.type === 'hinge');
    if (!hinge) continue;
    const d = Math.hypot(
      p.pos[0] - mouthWorld[0],
      p.pos[1] - mouthWorld[1],
      p.pos[2] - mouthWorld[2],
    );
    if (d <= innerRadiusM * 2.2) {
      return hinge.name;
    }
  }
  return null;
}

/**
 * Evaluates cross-body acoustic coupling between a struck bar/plate (`barNode`)
 * and an external open/closed resonator tube suspended beneath (or explicitly linked to) it,
 * including motor-driven vibraphone rotating-vane amplitude & formant tremolo!
 */
export function resolveExternalTubeResonator(
  barNode: SceneNode,
  barProfile: BodyModalProfile,
  voices: ModalVoice[],
  sceneNodes?: SceneNode[],
  liveKin?: ResonatorLiveKinematics,
): CoupledTubeResonatorResult | null {
  if (!sceneNodes || sceneNodes.length === 0 || voices.length === 0) return null;
  if (barNode.acousticString || barNode.acousticMembrane || barNode.windInstrument || barNode.resonatorTube) {
    return null;
  }

  const poses = collectWorldPoses(sceneNodes, liveKin);
  const barPose = poses.get(barNode.id);
  if (!barPose) return null;

  const barSec = analyze3DSolidCrossSections(barNode);
  const [barThick, barWidth, barLen] = barSec.dimsSortedAsc;
  const [, , barLenAxis] = barSec.axisOrderAsc;

  const barHalfL = Math.max(0.01, 0.5 * barLen);
  const barRot = barPose.rot;
  const barLenColOff = barLenAxis * 3;
  const barLenAxisX = barRot[barLenColOff];
  const barLenAxisY = barRot[barLenColOff + 1];
  const barLenAxisZ = barRot[barLenColOff + 2];

  let bestTube: ExtractedTubeAirColumn | null = null;
  let bestTubeNode: SceneNode | null = null;
  let bestScore = -1;
  let bestGapM = 0;
  let bestLateralM = 0;
  let bestXi = 0;

  for (const [, candPose] of poses) {
    const cand = candPose.node;
    if (cand.id === barNode.id) continue;

    const explicitMatch =
      barNode.resonatorNodeId === cand.id ||
      barNode.resonatorNodeId === cand.name ||
      cand.resonatorTube?.coupledBarNodeId === barNode.id ||
      cand.resonatorTube?.coupledBarNodeId === barNode.name;

    // Quick skip on obvious non-tubes unless explicitly linked
    if (!explicitMatch && !cand.isTube && !cand.resonatorTube && !cand.csgEnabled && !cand.sculptEdited) {
      continue;
    }

    const col = extractTubeAirColumn(cand, liveKin, candPose);
    if (!col) continue;

    const dx = col.mouthCenterWorld[0] - barPose.pos[0];
    const dy = col.mouthCenterWorld[1] - barPose.pos[1];
    const dz = col.mouthCenterWorld[2] - barPose.pos[2];

    // Project mouth offset onto bar's longitudinal local axis via column dot product (R^T * d, zero Matrix4/Vector3 allocs!)
    const relAlongLen = dx * barLenAxisX + dy * barLenAxisY + dz * barLenAxisZ;
    const xi = Math.max(-1, Math.min(1, relAlongLen / barHalfL));

    const lateralCapture = 2.0 * col.innerRadiusM + 0.55 * barWidth;
    const lateralDist = Math.sqrt(dx * dx + dy * dy);
    const verticalGap = Math.max(0, Math.abs(dz) - 0.5 * barThick);

    if (!explicitMatch) {
      if (lateralDist > lateralCapture || verticalGap > 0.16 || Math.abs(xi) > 0.55) {
        continue;
      }
    }

    const score = (explicitMatch ? 100 : 1) / (1 + lateralDist * 20 + verticalGap * 12);
    if (score > bestScore) {
      bestScore = score;
      bestTube = col;
      bestTubeNode = cand;
      bestGapM = verticalGap;
      bestLateralM = lateralDist;
      bestXi = xi;
    }
  }

  if (!bestTube || !bestTubeNode) return null;

  // Spatial coupling kappa_geom: peaks when mouth sits close beneath the bar's fundamental antinode (xi ≈ 0)
  const antinodeWeight =
    barProfile.modeVectors && barProfile.modeVectors[0]
      ? evaluateNormalizedModeShape(barProfile.modeVectors[0], bestXi)
      : Math.cos(0.5 * Math.PI * bestXi);

  const gapNorm = bestGapM / Math.max(0.012, 1.5 * bestTube.innerRadiusM);
  const areaMatch = Math.min(1.1, bestTube.crossAreaM2 / Math.max(1e-4, 0.55 * barWidth * barWidth));
  const geometricCoupling = Math.max(
    0,
    Math.min(1.0, (antinodeWeight / (1 + gapNorm * gapNorm)) * areaMatch),
  );
  if (geometricCoupling < 0.02) return null;

  // Lorentzian frequency detuning curve between bar fundamental f_1 and tube fundamental f_tube
  // (also checks if bar f_1 couples to the 3rd harmonic of a deep resonator tube!)
  const fBar = Math.max(24, voices[0].freqHz);
  let bestLorentzian = 0;
  let matchedTubeModeHz = bestTube.fundamentalHz;
  const qEff = Math.min(26, bestTube.qualityQ * 0.82); // Near-field bar-mouth radiation broadens coupled Q slightly
  for (const fMode of bestTube.overtonesHz) {
    const detune = fBar / fMode - fMode / fBar;
    const lor = 1 / (1 + qEff * qEff * detune * detune);
    if (lor > bestLorentzian) {
      bestLorentzian = lor;
      matchedTubeModeHz = fMode;
    }
  }

  // Rotating tremolo fan / butterfly vane kinematics
  const vaneJointName = discoverTremoloVaneJoint(bestTubeNode, bestTube.mouthCenterWorld, bestTube.innerRadiusM, poses);
  const maxOcc = Math.max(0, Math.min(0.98, bestTubeNode.resonatorTube?.vaneMaxOcclusion ?? 0.88));
  let vaneAngleRad = Math.PI * 0.5; // Default wide-open (90°) when no vane is installed!
  let shaftSpeedRadPerSec = 0;
  if (vaneJointName) {
    const jState = readLiveJointState(vaneJointName, liveKin);
    vaneAngleRad = jState.pos;
    shaftSpeedRadPerSec = jState.vel;
  }

  // Convention: theta = 0 -> vane flat across bore (occluded by `maxOcc`); theta = pi/2 -> vane edge-on (100% open!)
  const openSinSq = vaneJointName ? Math.pow(Math.sin(vaneAngleRad), 2) : 1.0;
  const instantaneousOpenFactor = 1 - maxOcc * (1 - openSinSq);
  const isSpinning = vaneJointName !== null && Math.abs(shaftSpeedRadPerSec) > 0.35;
  const meanOpenFactor = isSpinning ? 1 - 0.5 * maxOcc : instantaneousOpenFactor;
  const tremoloHz = isSpinning ? Math.min(28, Math.abs(shaftSpeedRadPerSec) / Math.PI) : 0;

  const couplingStrength = geometricCoupling * bestLorentzian;
  const effectiveOpenForAttack = isSpinning ? meanOpenFactor : instantaneousOpenFactor;

  // Conservation-of-energy radiation tradeoff (Fletcher & Rossing §19.2):
  // Open tuned resonator boosts fundamental radiated pressure by up to ~2.55x (+8.1 dB)
  // while drawing vibrational energy faster out of the bar (shortening T_60)!
  // Closing the vane (theta = 0 -> instantaneousOpenFactor = 1 - maxOcc ≈ 0.12) cuts boost and restores long bar sustain!
  const fundamentalGainMultiplier = 1 + 1.55 * couplingStrength * effectiveOpenForAttack;
  const fundamentalDecayMultiplier = 1 / (1 + 0.58 * couplingStrength * meanOpenFactor);

  const coupledVoices: ModalVoice[] = voices.map((v, idx) => {
    if (idx === 0) {
      return {
        freqHz: v.freqHz,
        gain: +(v.gain * fundamentalGainMultiplier).toFixed(4),
        decaySec: +Math.max(0.025, v.decaySec * fundamentalDecayMultiplier).toFixed(4),
      };
    }
    return v;
  });

  // Add subtle sympathetic air-column bloom voice at `matchedTubeModeHz` so slightly detuned tubes beat naturally
  const airVoiceGain = 0.28 * geometricCoupling * (0.25 + 0.75 * bestLorentzian) * effectiveOpenForAttack * (voices[0]?.gain ?? 0.5);
  if (airVoiceGain >= 0.012 && matchedTubeModeHz >= 28 && matchedTubeModeHz <= 8000) {
    const airDecaySec = Math.max(0.025, Math.min(0.45, (bestTube.qualityQ / (Math.PI * matchedTubeModeHz)) * 2.6));
    coupledVoices.push({
      freqHz: +matchedTubeModeHz.toFixed(2),
      gain: +airVoiceGain.toFixed(4),
      decaySec: +airDecaySec.toFixed(4),
    });
  }

  const amDepth = isSpinning
    ? Math.min(0.88, maxOcc * (0.35 + 0.65 * couplingStrength))
    : 0;
  const formantGainSwingDb = isSpinning ? +(5.6 * maxOcc * couplingStrength).toFixed(2) : 0;
  const formantFreqDetuneRatio = isSpinning ? +(0.009 * maxOcc * couplingStrength).toFixed(5) : 0;

  return {
    tube: bestTube,
    gapM: +bestGapM.toFixed(4),
    lateralOffsetM: +bestLateralM.toFixed(4),
    geometricCoupling: +geometricCoupling.toFixed(4),
    lorentzianDetuning: +bestLorentzian.toFixed(4),
    fundamentalGainMultiplier: +fundamentalGainMultiplier.toFixed(4),
    fundamentalDecayMultiplier: +fundamentalDecayMultiplier.toFixed(4),
    coupledVoices,
    tremolo: {
      active: isSpinning,
      vaneJointName,
      vaneAngleRad: +vaneAngleRad.toFixed(4),
      shaftSpeedRadPerSec: +shaftSpeedRadPerSec.toFixed(4),
      tremoloHz: +tremoloHz.toFixed(3),
      instantaneousOpenFactor: +instantaneousOpenFactor.toFixed(4),
      meanOpenFactor: +meanOpenFactor.toFixed(4),
      amDepth: +amDepth.toFixed(4),
      formantGainSwingDb,
      formantFreqDetuneRatio,
      initialPhaseRad: +((2 * vaneAngleRad) % (2 * Math.PI)).toFixed(4),
    },
  };
}

/**
 * Tunes a hollow external resonator tube (`node.resonatorTube` or `node.isTube`) so its
 * standing-wave air column (`open_closed` λ/4 or `open_open` λ/2) resonates at `targetHz`!
 */
export function tuneResonatorTubeToPitch(
  tubeNode: SceneNode,
  targetHzRaw: number,
  endConditionOverride?: ResonatorTubeEndCondition,
): SceneNode {
  const safeTargetHz = Number.isFinite(targetHzRaw) ? targetHzRaw : 261.63;
  const targetHz = Math.max(28, Math.min(4200, safeTargetHz));
  const current = extractTubeAirColumn(tubeNode);
  const endCondition: ResonatorTubeEndCondition =
    endConditionOverride ?? tubeNode.resonatorTube?.endCondition ?? current?.endCondition ?? 'open_closed';

  const rIn = current?.innerRadiusM ?? tubeNode.innerRadius ?? 0.02;
  const endCorr =
    endCondition === 'open_closed'
      ? UNFLANGED_END_CORRECTION * rIn
      : 2 * UNFLANGED_END_CORRECTION * rIn;
  const waveDivisor = endCondition === 'open_closed' ? 4 : 2;
  const targetBoreLenM = Math.max(0.018, SPEED_OF_SOUND_AIR / (waveDivisor * targetHz) - endCorr);

  const curBoreLenM = current?.boreLengthM ?? tubeNode.height ?? 0.16;
  const lenScale = targetBoreLenM / Math.max(0.005, curBoreLenM);

  const updated: SceneNode = {
    ...tubeNode,
    tunedPitchHz: +targetHz.toFixed(2),
    resonatorTube: {
      ...tubeNode.resonatorTube,
      endCondition,
      tuningHz: +targetHz.toFixed(2),
    },
  };

  if (tubeNode.isTube && typeof tubeNode.innerRadius === 'number' && typeof tubeNode.outerRadius === 'number') {
    const nextH = +targetBoreLenM.toFixed(6);
    updated.height = nextH;
    const meshData = generateTubeMeshData(tubeNode.innerRadius, tubeNode.outerRadius, nextH, 24);
    updated.geoms = (tubeNode.geoms ?? []).map((g, idx) => {
      if (idx === 0 && g.type === 'mesh') {
        return {
          ...g,
          vertices: meshData.vertices,
          renderVertices: meshData.renderVertices,
          faces: meshData.faces,
          ...(typeof g.mass === 'number' ? { mass: +(g.mass * lenScale).toFixed(5) } : {}),
        };
      }
      // Shift any bottom end-cap geom (`closed_bottom`) along Z to stay flush with the resized tube bottom!
      if (g.pos && Math.abs(g.pos[2]) > 0.25 * curBoreLenM) {
        return {
          ...g,
          pos: [g.pos[0], g.pos[1], +(g.pos[2] * lenScale).toFixed(6)],
        };
      }
      return g;
    });
    return updated;
  }

  // CSG-hollowed cylinder/box resonator tube: scale axial dimension along `boreAxisLocal` while keeping bore radius fixed!
  const boreAxis = current?.boreAxisLocal ?? 2;
  updated.geoms = (tubeNode.geoms ?? []).map((g) => {
    const nextPos = g.pos
      ? (g.pos.map((c, ax) => (ax === boreAxis ? +(c * lenScale).toFixed(6) : c)) as [number, number, number])
      : undefined;
    if (g.type === 'cylinder' || g.type === 'capsule') {
      if (g.fromto && g.fromto.length >= 6) {
        const ft = [...g.fromto];
        ft[boreAxis] = +(ft[boreAxis] * lenScale).toFixed(6);
        ft[boreAxis + 3] = +(ft[boreAxis + 3] * lenScale).toFixed(6);
        return { ...g, fromto: ft, ...(nextPos ? { pos: nextPos } : {}) };
      }
      return {
        ...g,
        size: [g.size[0], +((g.size[1] ?? 0.05) * lenScale).toFixed(6), ...g.size.slice(2)],
        ...(nextPos ? { pos: nextPos } : {}),
      };
    }
    if (g.type === 'box') {
      const nextSize = [...g.size];
      if (nextSize.length > boreAxis) {
        // Don't stretch thin end-cap plates thicker than 8 mm along `boreAxis`
        if ((nextSize[boreAxis] ?? 0) > 0.012) {
          nextSize[boreAxis] = +(nextSize[boreAxis] * lenScale).toFixed(6);
        }
      }
      return { ...g, size: nextSize, ...(nextPos ? { pos: nextPos } : {}) };
    }
    return nextPos ? { ...g, pos: nextPos } : g;
  });

  return updated;
}
