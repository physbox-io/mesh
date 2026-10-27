import { buildEtchHandoffUrl, etchBaseUrl } from './etchHandoff';
import { getNodeWorldTransform } from './laserCutExporter';
import { boxGeom, cylinderGeom, mm } from './hardwareGeometry';
import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';

// ============================================================================
// 1. Hardware-Store Pipe & Conduit Standards
// ============================================================================

export type PipeStandardId =
  | 'pvc_sch40_1_2'
  | 'pvc_sch40_3_4'
  | 'pvc_sch40_1'
  | 'pvc_sch40_1_1_4'
  | 'pvc_sch40_1_1_2'
  | 'emt_1_2'
  | 'emt_3_4'
  | 'emt_1'
  | 'pvc_metric_20'
  | 'pvc_metric_25';

export interface PipeStandardSpec {
  id: PipeStandardId;
  label: string;
  material: 'pvc' | 'emt';
  nominalSize: string;
  odMm: number;
  idMm: number;
  wallMm: number;
  socketDepthMm: number;
  stockLengthMm: number;
}

export const PIPE_STANDARDS: Record<PipeStandardId, PipeStandardSpec> = {
  pvc_sch40_1_2: {
    id: 'pvc_sch40_1_2',
    label: '1/2" Schedule 40 PVC',
    material: 'pvc',
    nominalSize: '1/2"',
    odMm: 21.34,
    idMm: 15.8,
    wallMm: 2.77,
    socketDepthMm: 17.5,
    stockLengthMm: 3048,
  },
  pvc_sch40_3_4: {
    id: 'pvc_sch40_3_4',
    label: '3/4" Schedule 40 PVC',
    material: 'pvc',
    nominalSize: '3/4"',
    odMm: 26.67,
    idMm: 20.93,
    wallMm: 2.87,
    socketDepthMm: 19.0,
    stockLengthMm: 3048,
  },
  pvc_sch40_1: {
    id: 'pvc_sch40_1',
    label: '1" Schedule 40 PVC',
    material: 'pvc',
    nominalSize: '1"',
    odMm: 33.4,
    idMm: 26.64,
    wallMm: 3.38,
    socketDepthMm: 22.2,
    stockLengthMm: 3048,
  },
  pvc_sch40_1_1_4: {
    id: 'pvc_sch40_1_1_4',
    label: '1-1/4" Schedule 40 PVC',
    material: 'pvc',
    nominalSize: '1-1/4"',
    odMm: 42.16,
    idMm: 35.04,
    wallMm: 3.56,
    socketDepthMm: 23.8,
    stockLengthMm: 3048,
  },
  pvc_sch40_1_1_2: {
    id: 'pvc_sch40_1_1_2',
    label: '1-1/2" Schedule 40 PVC',
    material: 'pvc',
    nominalSize: '1-1/2"',
    odMm: 48.26,
    idMm: 40.9,
    wallMm: 3.68,
    socketDepthMm: 27.0,
    stockLengthMm: 3048,
  },
  emt_1_2: {
    id: 'emt_1_2',
    label: '1/2" EMT Steel Conduit',
    material: 'emt',
    nominalSize: '1/2"',
    odMm: 17.93,
    idMm: 15.8,
    wallMm: 1.07,
    socketDepthMm: 18.0,
    stockLengthMm: 3048,
  },
  emt_3_4: {
    id: 'emt_3_4',
    label: '3/4" EMT Steel Conduit',
    material: 'emt',
    nominalSize: '3/4"',
    odMm: 23.42,
    idMm: 20.93,
    wallMm: 1.24,
    socketDepthMm: 20.0,
    stockLengthMm: 3048,
  },
  emt_1: {
    id: 'emt_1',
    label: '1" EMT Steel Conduit',
    material: 'emt',
    nominalSize: '1"',
    odMm: 29.54,
    idMm: 26.64,
    wallMm: 1.45,
    socketDepthMm: 24.0,
    stockLengthMm: 3048,
  },
  pvc_metric_20: {
    id: 'pvc_metric_20',
    label: '20mm Metric PVC Conduit/Pipe',
    material: 'pvc',
    nominalSize: '20mm',
    odMm: 20.0,
    idMm: 16.4,
    wallMm: 1.8,
    socketDepthMm: 16.0,
    stockLengthMm: 3000,
  },
  pvc_metric_25: {
    id: 'pvc_metric_25',
    label: '25mm Metric PVC Conduit/Pipe',
    material: 'pvc',
    nominalSize: '25mm',
    odMm: 25.0,
    idMm: 21.2,
    wallMm: 1.9,
    socketDepthMm: 19.0,
    stockLengthMm: 3000,
  },
};

// ============================================================================
// 2. PVC / EMT Pipe Frame Breakdown, Presets & Printable 3D Hub Connectors
// ============================================================================

export type PipeStructurePresetId = 'mini_greenhouse' | 'yard_pub' | 'carport' | 'geodesic_dome';
export type PipeHubFitStyle = 'socket' | 'spigot';
export type PipeFittingClassification =
  | 'straight_coupler'
  | '90_elbow'
  | '90_tee'
  | '90_corner_3way'
  | 'custom_printed_hub';

export interface PipeFrameOptions {
  pipeStandardId: PipeStandardId;
  hubFitStyle: PipeHubFitStyle;
  hubWallMm: number; // default 3.5
  fitClearanceMm: number; // default 0.25
  socketDepthMm?: number; // overrides standard's socketDepthMm if set
  stockLengthMm?: number; // overrides standard's stockLengthMm if set
  kerfMm: number; // default 2.0
  clusterToleranceMm: number; // default 15.0
  crossBoltHoleMm: number; // default 4.2 (M4 bolt hole through socket for EMT/PVC pinning, 0 = none)
}

export const DEFAULT_PIPE_FRAME_OPTIONS: PipeFrameOptions = {
  pipeStandardId: 'pvc_sch40_3_4',
  hubFitStyle: 'socket',
  hubWallMm: 3.5,
  fitClearanceMm: 0.25,
  kerfMm: 2.0,
  clusterToleranceMm: 15.0,
  crossBoltHoleMm: 4.2,
};

export interface PipeStrut {
  id: string;
  name: string;
  startMm: [number, number, number];
  endMm: [number, number, number];
  nodeToNodeLengthMm: number;
  startDeductionMm: number;
  endDeductionMm: number;
  cutLengthMm: number;
  startHubId: string;
  endHubId: string;
}

export interface PipeHubPort {
  strutId: string;
  dir: [number, number, number]; // unit vector pointing out from hub center along strut
  shoulderOffsetMm: number; // distance from hub center to pipe stop shoulder
}

export interface PipeFrameHub {
  id: string;
  name: string;
  centerMm: [number, number, number];
  ports: PipeHubPort[];
  minAngleDeg: number;
  classification: PipeFittingClassification;
  needsCustomPrint: boolean;
}

export interface PipeStickPlan {
  stickIndex: number;
  stockLengthMm: number;
  cuts: { strutId: string; name: string; cutLengthMm: number }[];
  usedMm: number;
  wasteMm: number;
  utilizationPct: number;
}

export interface PipeFrameBreakdownResult {
  pipeSpec: PipeStandardSpec;
  options: PipeFrameOptions;
  struts: PipeStrut[];
  hubs: PipeFrameHub[];
  sticks: PipeStickPlan[];
  sticksRequired: number;
  totalPipeLengthMm: number;
  shoppingList: {
    sticksToBuy: number;
    stockLengthMm: number;
    standardElbows90: number;
    standardTees90: number;
    standardCorners3Way: number;
    straightCouplers: number;
    customPrintedHubs: number;
  };
  warnings: string[];
}

// --- Vector math helpers ---
type Vec3 = [number, number, number];

function vSub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function vAdd(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function vScale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

function vDot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function vCross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function vLen(a: Vec3): number {
  return Math.hypot(a[0], a[1], a[2]);
}

function vDist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function vNorm(a: Vec3): Vec3 {
  const len = vLen(a);
  return len > 1e-9 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 1];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function makeStrutNode(
  id: string,
  name: string,
  p1Mm: Vec3,
  p2Mm: Vec3,
  radiusMm: number,
  rgba: [number, number, number, number] = [0.92, 0.94, 0.96, 1]
): SceneNode {
  return {
    id,
    name,
    type: 'body',
    pos: [0, 0, 0],
    joints: [],
    children: [],
    geoms: [
      {
        name: id,
        type: 'cylinder',
        size: [mm(radiusMm), mm(vDist(p1Mm, p2Mm) / 2)],
        fromto: [
          mm(p1Mm[0]),
          mm(p1Mm[1]),
          mm(p1Mm[2]),
          mm(p2Mm[0]),
          mm(p2Mm[1]),
          mm(p2Mm[2]),
        ],
        rgba,
      },
    ],
  };
}

export function generatePipeStructurePreset(
  preset: PipeStructurePresetId,
  options?: {
    widthMm?: number;
    depthMm?: number;
    heightMm?: number;
    roofPitchDeg?: number;
    pipeStandardId?: PipeStandardId;
  }
): SceneNode[] {
  const stdId = options?.pipeStandardId ?? 'pvc_sch40_3_4';
  const spec = PIPE_STANDARDS[stdId] ?? PIPE_STANDARDS.pvc_sch40_3_4;
  const rMm = spec.odMm / 2;
  const rgba: [number, number, number, number] =
    spec.material === 'emt' ? [0.7, 0.74, 0.78, 1] : [0.94, 0.95, 0.97, 1];

  const nodes: SceneNode[] = [];
  let idx = 1;
  const addStrut = (name: string, a: Vec3, b: Vec3) => {
    nodes.push(makeStrutNode(`pipe_strut_${idx++}`, name, a, b, rMm, rgba));
  };

  if (preset === 'mini_greenhouse') {
    const W = options?.widthMm ?? 1200;
    const D = options?.depthMm ?? 1800;
    const eaveH = options?.heightMm ?? 1200;
    const pitchRad = ((options?.roofPitchDeg ?? 30) * Math.PI) / 180;
    const ridgeH = eaveH + (W / 2) * Math.tan(pitchRad);
    const xL = -W / 2;
    const xR = W / 2;
    const ys = [-D / 2, 0, D / 2];

    for (let i = 0; i < ys.length; i++) {
      const y = ys[i];
      const bayLabel = i === 0 ? 'Front' : i === 1 ? 'Mid' : 'Rear';
      // Vertical posts
      addStrut(`${bayLabel} Left Post`, [xL, y, 0], [xL, y, eaveH]);
      addStrut(`${bayLabel} Right Post`, [xR, y, 0], [xR, y, eaveH]);
      // Pitched rafters
      addStrut(`${bayLabel} Left Rafter`, [xL, y, eaveH], [0, y, ridgeH]);
      addStrut(`${bayLabel} Right Rafter`, [xR, y, eaveH], [0, y, ridgeH]);
    }
    // Base and eave and ridge longitudinal rails
    for (let i = 0; i < ys.length - 1; i++) {
      const y0 = ys[i];
      const y1 = ys[i + 1];
      addStrut(`Base Left Rail ${i + 1}`, [xL, y0, 0], [xL, y1, 0]);
      addStrut(`Base Right Rail ${i + 1}`, [xR, y0, 0], [xR, y1, 0]);
      addStrut(`Eave Left Rail ${i + 1}`, [xL, y0, eaveH], [xL, y1, eaveH]);
      addStrut(`Eave Right Rail ${i + 1}`, [xR, y0, eaveH], [xR, y1, eaveH]);
      addStrut(`Ridge Rail ${i + 1}`, [0, y0, ridgeH], [0, y1, ridgeH]);
    }
    // Rear cross base & tie
    addStrut('Rear Base Crossbar', [xL, ys[2], 0], [xR, ys[2], 0]);
  } else if (preset === 'yard_pub') {
    const W = options?.widthMm ?? 1800;
    const D = options?.depthMm ?? 1200;
    const eaveH = options?.heightMm ?? 2000;
    const counterH = 1000;
    const pitchRad = ((options?.roofPitchDeg ?? 22) * Math.PI) / 180;
    const ridgeH = eaveH + (D / 2) * Math.tan(pitchRad);
    const xL = -W / 2;
    const xR = W / 2;
    const yF = -D / 2;
    const yB = D / 2;

    // 4 Corner Posts (segmented at counterH on front/sides for bar counter tees)
    addStrut('Front Left Lower Post', [xL, yF, 0], [xL, yF, counterH]);
    addStrut('Front Left Upper Post', [xL, yF, counterH], [xL, yF, eaveH]);
    addStrut('Front Right Lower Post', [xR, yF, 0], [xR, yF, counterH]);
    addStrut('Front Right Upper Post', [xR, yF, counterH], [xR, yF, eaveH]);

    addStrut('Back Left Lower Post', [xL, yB, 0], [xL, yB, counterH]);
    addStrut('Back Left Upper Post', [xL, yB, counterH], [xL, yB, eaveH]);
    addStrut('Back Right Lower Post', [xR, yB, 0], [xR, yB, counterH]);
    addStrut('Back Right Upper Post', [xR, yB, counterH], [xR, yB, eaveH]);

    // Counter frame rails
    addStrut('Front Bar Counter Rail', [xL, yF, counterH], [xR, yF, counterH]);
    addStrut('Left Counter Side Rail', [xL, yF, counterH], [xL, yB, counterH]);
    addStrut('Right Counter Side Rail', [xR, yF, counterH], [xR, yB, counterH]);

    // Base perimeter rails (3 sides open at back for bartender entry)
    addStrut('Front Foot Rail', [xL, yF, 0], [xR, yF, 0]);
    addStrut('Left Base Rail', [xL, yF, 0], [xL, yB, 0]);
    addStrut('Right Base Rail', [xR, yF, 0], [xR, yB, 0]);

    // Overhead canopy eaves + pitched gable roof
    addStrut('Front Eave Rail', [xL, yF, eaveH], [xR, yF, eaveH]);
    addStrut('Back Eave Rail', [xL, yB, eaveH], [xR, yB, eaveH]);
    addStrut('Left Front Rafter', [xL, yF, eaveH], [xL, 0, ridgeH]);
    addStrut('Left Back Rafter', [xL, yB, eaveH], [xL, 0, ridgeH]);
    addStrut('Right Front Rafter', [xR, yF, eaveH], [xR, 0, ridgeH]);
    addStrut('Right Back Rafter', [xR, yB, eaveH], [xR, 0, ridgeH]);
    addStrut('Canopy Ridge Beam', [xL, 0, ridgeH], [xR, 0, ridgeH]);
  } else if (preset === 'carport') {
    const W = options?.widthMm ?? 2800;
    const D = options?.depthMm ?? 4500;
    const eaveH = options?.heightMm ?? 2100;
    const pitchRad = ((options?.roofPitchDeg ?? 20) * Math.PI) / 180;
    const ridgeH = eaveH + (W / 2) * Math.tan(pitchRad);
    const xL = -W / 2;
    const xR = W / 2;
    const ys = [-D / 2, -D / 6, D / 6, D / 2];

    for (let i = 0; i < ys.length; i++) {
      const y = ys[i];
      addStrut(`Bay ${i + 1} Left Leg`, [xL, y, 0], [xL, y, eaveH]);
      addStrut(`Bay ${i + 1} Right Leg`, [xR, y, 0], [xR, y, eaveH]);
      addStrut(`Bay ${i + 1} Left Rafter`, [xL, y, eaveH], [0, y, ridgeH]);
      addStrut(`Bay ${i + 1} Right Rafter`, [xR, y, eaveH], [0, y, ridgeH]);
    }
    for (let i = 0; i < ys.length - 1; i++) {
      const y0 = ys[i];
      const y1 = ys[i + 1];
      addStrut(`Left Eave Purlin ${i + 1}`, [xL, y0, eaveH], [xL, y1, eaveH]);
      addStrut(`Right Eave Purlin ${i + 1}`, [xR, y0, eaveH], [xR, y1, eaveH]);
      addStrut(`Ridge Purlin ${i + 1}`, [0, y0, ridgeH], [0, y1, ridgeH]);
    }
  } else if (preset === 'geodesic_dome') {
    const R = (options?.widthMm ?? 2400) / 2;
    const apexZ = options?.heightMm ?? R;
    const ringZ = apexZ * 0.52;
    const ringR = R * Math.sin(Math.acos(0.52));
    const nSides = 5;

    const apex: Vec3 = [0, 0, apexZ];
    const upperRing: Vec3[] = [];
    const baseRing: Vec3[] = [];
    for (let i = 0; i < nSides; i++) {
      const a1 = (i * 2 * Math.PI) / nSides;
      const a2 = ((i + 0.5) * 2 * Math.PI) / nSides;
      upperRing.push([ringR * Math.cos(a1), ringR * Math.sin(a1), ringZ]);
      baseRing.push([R * Math.cos(a2), R * Math.sin(a2), 0]);
    }
    for (let i = 0; i < nSides; i++) {
      const next = (i + 1) % nSides;
      addStrut(`Crown Strut ${i + 1}`, apex, upperRing[i]);
      addStrut(`Upper Ring Strut ${i + 1}`, upperRing[i], upperRing[next]);
      addStrut(`Lower Diag A ${i + 1}`, upperRing[i], baseRing[i]);
      addStrut(`Lower Diag B ${i + 1}`, baseRing[i], upperRing[next]);
      addStrut(`Base Ring Strut ${i + 1}`, baseRing[i], baseRing[next]);
    }
  }

  return nodes;
}

const FITTING_NAMES: Record<PipeFittingClassification, string> = {
  straight_coupler: 'Coupler',
  '90_elbow': '90° Elbow',
  '90_tee': '90° Tee',
  '90_corner_3way': '3-Way Corner',
  custom_printed_hub: 'Printed Hub',
};

/**
 * A pipe structure as built: the struts, and a fitting at every joint, the
 * ones a store sells and the printed ones alike, so nothing stands on a bare
 * pipe end. The struts still run hub centre to hub centre, which is what the
 * cut list is planned from; the fittings are left out of that.
 */
export function pipeStructureScene(
  preset: PipeStructurePresetId,
  options?: Parameters<typeof generatePipeStructurePreset>[1]
): SceneNode[] {
  const struts = generatePipeStructurePreset(preset, options);
  const frameOptions: Partial<PipeFrameOptions> = { pipeStandardId: options?.pipeStandardId ?? 'pvc_sch40_3_4' };
  const bd = breakdownPipeFrame({ nodes: struts } as SceneGraph, frameOptions);
  const fittings = bd.hubs
    .filter((h) => h.ports.length >= 2)
    .map((h) => {
      const node = buildPipeHubNode(h, frameOptions);
      node.name = `${FITTING_NAMES[h.classification]}: ${h.name}`;
      return node;
    });
  return [...struts, ...fittings];
}

interface RawStrutSegment {
  name: string;
  startMm: Vec3;
  endMm: Vec3;
}

function nodeWorldFrame(node: SceneNode): { worldPos: Vec3; worldRotMat: number[]; scale: Vec3 } {
  const anyNode = node as SceneNode & {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    visible?: boolean;
  };
  const posNode: SceneNode = {
    ...node,
    pos: node.pos ?? anyNode.position ?? [0, 0, 0],
    euler: node.euler ?? anyNode.rotation,
  };
  const m = getNodeWorldTransform(posNode);
  const e = m.elements;
  // THREE.Matrix4 is column-major: row-major 3x3 is [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]]
  return {
    worldPos: [e[12], e[13], e[14]],
    worldRotMat: [e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10]],
    scale: anyNode.scale ?? [1, 1, 1],
  };
}

function transformPointMm(
  localM: Vec3,
  worldPosM: Vec3,
  worldRotMat: number[],
  scale: Vec3
): Vec3 {
  const sx = localM[0] * scale[0];
  const sy = localM[1] * scale[1];
  const sz = localM[2] * scale[2];
  const wx = worldPosM[0] + worldRotMat[0] * sx + worldRotMat[1] * sy + worldRotMat[2] * sz;
  const wy = worldPosM[1] + worldRotMat[3] * sx + worldRotMat[4] * sy + worldRotMat[5] * sz;
  const wz = worldPosM[2] + worldRotMat[6] * sx + worldRotMat[7] * sy + worldRotMat[8] * sz;
  return [wx * 1000, wy * 1000, wz * 1000];
}

/** A hub or fitting `buildPipeHubNode` made: its core is named `hub_core`. */
export function isPipeHubNode(node: SceneNode): boolean {
  return (node.geoms ?? []).some((g) => g.name === 'hub_core');
}

function extractRawStrutsFromScene(scene: SceneGraph): RawStrutSegment[] {
  const cylSegments: RawStrutSegment[] = [];
  const boxSegments: RawStrutSegment[] = [];

  for (const node of scene.nodes) {
    // A hub's sleeves are cylinders too, but they are the fitting, not the frame.
    if (isPipeHubNode(node)) continue;
    if ((node as SceneNode & { visible?: boolean }).visible === false) continue;
    const { worldPos, worldRotMat, scale } = nodeWorldFrame(node);
    const geoms = node.geoms ?? [];

    for (let gIdx = 0; gIdx < geoms.length; gIdx++) {
      const g: SceneGeom = geoms[gIdx];
      if (g.csg === 'difference') continue;
      const gPos: Vec3 = [g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0];

      if (g.type === 'cylinder' || g.type === 'capsule') {
        if (g.fromto && g.fromto.length === 6) {
          const p1Local: Vec3 = [
            gPos[0] + g.fromto[0],
            gPos[1] + g.fromto[1],
            gPos[2] + g.fromto[2],
          ];
          const p2Local: Vec3 = [
            gPos[0] + g.fromto[3],
            gPos[1] + g.fromto[4],
            gPos[2] + g.fromto[5],
          ];
          const p1Mm = transformPointMm(p1Local, worldPos, worldRotMat, scale);
          const p2Mm = transformPointMm(p2Local, worldPos, worldRotMat, scale);
          if (vDist(p1Mm, p2Mm) > 20) {
            cylSegments.push({
              name: g.name ?? `${node.name || node.id}`,
              startMm: p1Mm,
              endMm: p2Mm,
            });
          }
        } else {
          const halfLenM = g.size?.[1] ?? 0.25;
          const p1Local: Vec3 = [gPos[0], gPos[1], gPos[2] - halfLenM];
          const p2Local: Vec3 = [gPos[0], gPos[1], gPos[2] + halfLenM];
          const p1Mm = transformPointMm(p1Local, worldPos, worldRotMat, scale);
          const p2Mm = transformPointMm(p2Local, worldPos, worldRotMat, scale);
          if (vDist(p1Mm, p2Mm) > 20) {
            cylSegments.push({
              name: g.name ?? `${node.name || node.id}`,
              startMm: p1Mm,
              endMm: p2Mm,
            });
          }
        }
      } else if (g.type === 'box') {
        const hx = g.size?.[0] ?? 0.25;
        const hy = g.size?.[1] ?? 0.25;
        const hz = g.size?.[2] ?? 0.25;
        // Check if elongated strut-like box or full volumetric box
        const dims = [hx * scale[0], hy * scale[1], hz * scale[2]];
        const maxD = Math.max(...dims);
        const midD = dims.slice().sort((a, b) => a - b)[1];
        if (maxD > midD * 3 && midD < 0.08) {
          // Slender bar box -> treat as single strut along longest axis
          const axis = dims.indexOf(maxD);
          const dVec: Vec3 = [0, 0, 0];
          dVec[axis] = [hx, hy, hz][axis];
          const p1Mm = transformPointMm(vSub(gPos, dVec), worldPos, worldRotMat, scale);
          const p2Mm = transformPointMm(vAdd(gPos, dVec), worldPos, worldRotMat, scale);
          if (vDist(p1Mm, p2Mm) > 20) {
            cylSegments.push({
              name: g.name ?? `${node.name || node.id}`,
              startMm: p1Mm,
              endMm: p2Mm,
            });
          }
        } else {
          // Volumetric box -> extract 12 wireframe edges as candidate frame struts
          const corners: Vec3[] = [
            [-hx, -hy, -hz],
            [hx, -hy, -hz],
            [hx, hy, -hz],
            [-hx, hy, -hz],
            [-hx, -hy, hz],
            [hx, -hy, hz],
            [hx, hy, hz],
            [-hx, hy, hz],
          ].map((c) => transformPointMm(vAdd(gPos, c as Vec3), worldPos, worldRotMat, scale));
          const edges: [number, number, string][] = [
            [0, 1, 'Bottom Front'],
            [1, 2, 'Bottom Right'],
            [2, 3, 'Bottom Back'],
            [3, 0, 'Bottom Left'],
            [4, 5, 'Top Front'],
            [5, 6, 'Top Right'],
            [6, 7, 'Top Back'],
            [7, 4, 'Top Left'],
            [0, 4, 'Front Left Post'],
            [1, 5, 'Front Right Post'],
            [2, 6, 'Back Right Post'],
            [3, 7, 'Back Left Post'],
          ];
          for (const [i, j, edgeLabel] of edges) {
            if (vDist(corners[i], corners[j]) > 20) {
              boxSegments.push({
                name: `${node.name || node.id} ${edgeLabel}`,
                startMm: corners[i],
                endMm: corners[j],
              });
            }
          }
        }
      }
    }
  }

  return cylSegments.length > 0 ? cylSegments : boxSegments;
}

function classifyHubPorts(ports: PipeHubPort[]): {
  minAngleDeg: number;
  classification: PipeFittingClassification;
  needsCustomPrint: boolean;
} {
  const n = ports.length;
  if (n <= 1) {
    return {
      minAngleDeg: 180,
      classification: 'straight_coupler',
      needsCustomPrint: false,
    };
  }

  let minAngleDeg = 180;
  const angles: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dot = Math.max(-1, Math.min(1, vDot(ports[i].dir, ports[j].dir)));
      const deg = (Math.acos(dot) * 180) / Math.PI;
      angles.push(deg);
      if (deg < minAngleDeg) minAngleDeg = deg;
    }
  }

  const tolDeg = 4.5; // tolerance for standard hardware-store 90° / 180° fittings
  const isNear90 = (a: number) => Math.abs(a - 90) <= tolDeg;
  const isNear180 = (a: number) => Math.abs(a - 180) <= tolDeg;

  if (n === 2) {
    if (isNear180(angles[0])) {
      return {
        minAngleDeg: round2(minAngleDeg),
        classification: 'straight_coupler',
        needsCustomPrint: false,
      };
    }
    if (isNear90(angles[0])) {
      return {
        minAngleDeg: round2(minAngleDeg),
        classification: '90_elbow',
        needsCustomPrint: false,
      };
    }
  } else if (n === 3) {
    const count90 = angles.filter(isNear90).length;
    const count180 = angles.filter(isNear180).length;
    if (count90 === 2 && count180 === 1) {
      // Check coplanarity
      const c = vCross(ports[0].dir, ports[1].dir);
      const coplanar =
        vLen(c) < 1e-3 || Math.abs(vDot(vNorm(c), ports[2].dir)) < Math.sin((tolDeg * Math.PI) / 180);
      if (coplanar) {
        return {
          minAngleDeg: round2(minAngleDeg),
          classification: '90_tee',
          needsCustomPrint: false,
        };
      }
    }
    if (count90 === 3) {
      return {
        minAngleDeg: round2(minAngleDeg),
        classification: '90_corner_3way',
        needsCustomPrint: false,
      };
    }
  }

  return {
    minAngleDeg: round2(minAngleDeg),
    classification: 'custom_printed_hub',
    needsCustomPrint: true,
  };
}

export function breakdownPipeFrame(
  scene: SceneGraph,
  options?: Partial<PipeFrameOptions>
): PipeFrameBreakdownResult {
  const opts: PipeFrameOptions = {
    ...DEFAULT_PIPE_FRAME_OPTIONS,
    ...options,
  };
  const pipeSpec = PIPE_STANDARDS[opts.pipeStandardId] ?? PIPE_STANDARDS.pvc_sch40_3_4;
  const stockLengthMm = opts.stockLengthMm ?? pipeSpec.stockLengthMm;
  const rawSegments = extractRawStrutsFromScene(scene);
  const warnings: string[] = [];

  // Cluster endpoints within clusterToleranceMm
  const clusters: { centerSum: Vec3; count: number; centerMm: Vec3 }[] = [];
  const findOrCreateCluster = (pt: Vec3): number => {
    for (let i = 0; i < clusters.length; i++) {
      if (vDist(pt, clusters[i].centerMm) <= opts.clusterToleranceMm) {
        const c = clusters[i];
        c.centerSum = vAdd(c.centerSum, pt);
        c.count += 1;
        c.centerMm = vScale(c.centerSum, 1 / c.count);
        return i;
      }
    }
    clusters.push({ centerSum: [...pt], count: 1, centerMm: [...pt] });
    return clusters.length - 1;
  };

  const strutClusterPairs: {
    id: string;
    name: string;
    startMm: Vec3;
    endMm: Vec3;
    cStart: number;
    cEnd: number;
  }[] = [];

  for (let i = 0; i < rawSegments.length; i++) {
    const seg = rawSegments[i];
    const cStart = findOrCreateCluster(seg.startMm);
    const cEnd = findOrCreateCluster(seg.endMm);
    if (cStart === cEnd) continue;
    strutClusterPairs.push({
      id: `strut_${i + 1}`,
      name: seg.name || `Strut ${i + 1}`,
      startMm: seg.startMm,
      endMm: seg.endMm,
      cStart,
      cEnd,
    });
  }

  // Build hubs and ports
  const hubsMap = new Map<number, PipeFrameHub>();
  for (let cIdx = 0; cIdx < clusters.length; cIdx++) {
    const c = clusters[cIdx];
    const hubId = `hub_${cIdx + 1}`;
    hubsMap.set(cIdx, {
      id: hubId,
      name: `Hub ${cIdx + 1}`,
      centerMm: [round2(c.centerMm[0]), round2(c.centerMm[1]), round2(c.centerMm[2])],
      ports: [],
      minAngleDeg: 180,
      classification: 'straight_coupler',
      needsCustomPrint: false,
    });
  }

  for (const sc of strutClusterPairs) {
    const startHub = hubsMap.get(sc.cStart)!;
    const endHub = hubsMap.get(sc.cEnd)!;
    const dirFromStart = vNorm(vSub(endHub.centerMm, startHub.centerMm));
    const dirFromEnd = vScale(dirFromStart, -1);

    startHub.ports.push({
      strutId: sc.id,
      dir: dirFromStart,
      shoulderOffsetMm: 0,
    });
    endHub.ports.push({
      strutId: sc.id,
      dir: dirFromEnd,
      shoulderOffsetMm: 0,
    });
  }

  const hubs: PipeFrameHub[] = [];
  let standardElbows90 = 0;
  let standardTees90 = 0;
  let standardCorners3Way = 0;
  let straightCouplers = 0;
  let customPrintedHubs = 0;

  for (const hub of hubsMap.values()) {
    if (hub.ports.length === 0) continue;
    const { minAngleDeg, classification, needsCustomPrint } = classifyHubPorts(hub.ports);
    hub.minAngleDeg = minAngleDeg;
    hub.classification = classification;
    hub.needsCustomPrint = needsCustomPrint;

    const minHalfRad = (Math.max(15, minAngleDeg / 2) * Math.PI) / 180;
    const rawShoulder = pipeSpec.odMm / (2 * Math.tan(minHalfRad));
    const clampedShoulder = round2(
      Math.max(pipeSpec.odMm * 0.4, Math.min(pipeSpec.odMm * 1.5, rawShoulder))
    );

    for (const p of hub.ports) {
      p.shoulderOffsetMm = hub.ports.length <= 1 ? 0 : clampedShoulder;
    }

    if (hub.ports.length >= 2) {
      if (classification === '90_elbow') standardElbows90++;
      else if (classification === '90_tee') standardTees90++;
      else if (classification === '90_corner_3way') standardCorners3Way++;
      else if (classification === 'straight_coupler') straightCouplers++;
      else customPrintedHubs++;
    }

    if (minAngleDeg < 35 && hub.ports.length >= 2) {
      warnings.push(
        `${hub.name} has a very acute strut angle (${minAngleDeg.toFixed(1)}°) which may cause socket overlap.`
      );
    }

    hubs.push(hub);
  }

  // Compute strut deductions and cut lengths
  const struts: PipeStrut[] = [];
  for (const sc of strutClusterPairs) {
    const startHub = hubsMap.get(sc.cStart)!;
    const endHub = hubsMap.get(sc.cEnd)!;
    const nodeToNodeLengthMm = round2(vDist(startHub.centerMm, endHub.centerMm));

    const startPort = startHub.ports.find((p) => p.strutId === sc.id);
    const endPort = endHub.ports.find((p) => p.strutId === sc.id);

    const startDeductionMm = round2(startPort ? startPort.shoulderOffsetMm : 0);
    const endDeductionMm = round2(endPort ? endPort.shoulderOffsetMm : 0);
    const cutLengthMm = round2(Math.max(10, nodeToNodeLengthMm - startDeductionMm - endDeductionMm));

    if (cutLengthMm > stockLengthMm) {
      warnings.push(
        `${sc.name} cut length (${cutLengthMm}mm) exceeds stock stick length (${stockLengthMm}mm); a straight coupler will be needed.`
      );
    }

    struts.push({
      id: sc.id,
      name: sc.name,
      startMm: startHub.centerMm,
      endMm: endHub.centerMm,
      nodeToNodeLengthMm,
      startDeductionMm,
      endDeductionMm,
      cutLengthMm,
      startHubId: startHub.id,
      endHubId: endHub.id,
    });
  }

  // First-Fit Decreasing (FFD) 1D stock stick bin packing
  const sortedStruts = [...struts].sort((a, b) => b.cutLengthMm - a.cutLengthMm);
  const sticks: PipeStickPlan[] = [];

  for (const strut of sortedStruts) {
    // If a single strut exceeds stockLengthMm, split across sticks or place in dedicated stick
    let remainingMm = strut.cutLengthMm;
    let partIdx = 1;
    while (remainingMm > 0) {
      const pieceLen = round2(Math.min(remainingMm, stockLengthMm));
      const pieceName =
         strut.cutLengthMm > stockLengthMm ? `${strut.name} (Part ${partIdx})` : strut.name;
      if (partIdx > 1) {
        straightCouplers++;
      }

      let placed = false;
      for (const stick of sticks) {
        const kerfCost = stick.cuts.length > 0 ? opts.kerfMm : 0;
        if (stick.usedMm + kerfCost + pieceLen <= stockLengthMm + 1e-6) {
          stick.cuts.push({
            strutId: strut.id,
            name: pieceName,
            cutLengthMm: pieceLen,
          });
          stick.usedMm = round2(stick.usedMm + kerfCost + pieceLen);
          stick.wasteMm = round2(Math.max(0, stockLengthMm - stick.usedMm));
          stick.utilizationPct = round2((stick.usedMm / stockLengthMm) * 100);
          placed = true;
          break;
        }
      }

      if (!placed) {
        const stickIndex = sticks.length + 1;
        const usedMm = pieceLen;
        const wasteMm = round2(Math.max(0, stockLengthMm - usedMm));
        sticks.push({
          stickIndex,
          stockLengthMm,
          cuts: [{ strutId: strut.id, name: pieceName, cutLengthMm: pieceLen }],
          usedMm,
          wasteMm,
          utilizationPct: round2((usedMm / stockLengthMm) * 100),
        });
      }

      remainingMm = round2(remainingMm - pieceLen);
      partIdx++;
    }
  }

  const totalPipeLengthMm = round2(struts.reduce((acc, s) => acc + s.cutLengthMm, 0));

  return {
    pipeSpec,
    options: opts,
    struts,
    hubs,
    sticks,
    sticksRequired: sticks.length,
    totalPipeLengthMm,
    shoppingList: {
      sticksToBuy: sticks.length,
      stockLengthMm,
      standardElbows90,
      standardTees90,
      standardCorners3Way,
      straightCouplers,
      customPrintedHubs,
    },
    warnings,
  };
}

function perpUnitVector(dir: Vec3): Vec3 {
  const ref: Vec3 = Math.abs(dir[2]) < 0.85 ? [0, 0, 1] : [1, 0, 0];
  return vNorm(vCross(dir, ref));
}

export function buildPipeHubNode(
  hub: PipeFrameHub,
  options?: Partial<PipeFrameOptions>
): SceneNode {
  const opts: PipeFrameOptions = {
    ...DEFAULT_PIPE_FRAME_OPTIONS,
    ...options,
  };
  const spec = PIPE_STANDARDS[opts.pipeStandardId] ?? PIPE_STANDARDS.pvc_sch40_3_4;
  const socketDepthMm = opts.socketDepthMm ?? spec.socketDepthMm;
  const geoms: SceneGeom[] = [];

  const positiveRgba: [number, number, number, number] = [0.2, 0.58, 0.92, 1.0];
  const negativeRgba: [number, number, number, number] = [0.9, 0.25, 0.25, 1.0];

  if (opts.hubFitStyle === 'socket') {
    const outerRadiusMm = spec.odMm / 2 + opts.hubWallMm;
    const boreRadiusMm = spec.odMm / 2 + opts.fitClearanceMm;

    // Central sphere body
    geoms.push({
      name: 'hub_core',
      type: 'sphere',
      size: [mm(outerRadiusMm), mm(outerRadiusMm), mm(outerRadiusMm)],
      pos: [0, 0, 0],
      csg: 'union',
      rgba: positiveRgba,
    });

    // Union outer sleeves first
    for (let i = 0; i < hub.ports.length; i++) {
      const port = hub.ports[i];
      const sleeveEndMm = port.shoulderOffsetMm + socketDepthMm;
      const pEnd = vScale(port.dir, sleeveEndMm);
      geoms.push({
        name: `sleeve_${i + 1}`,
        type: 'cylinder',
        size: [mm(outerRadiusMm), mm(sleeveEndMm / 2)],
        fromto: [0, 0, 0, mm(pEnd[0]), mm(pEnd[1]), mm(pEnd[2])],
        csg: 'union',
        rgba: positiveRgba,
      });
    }

    // Subtract pipe socket bores & optional cross-bolt holes
    for (let i = 0; i < hub.ports.length; i++) {
      const port = hub.ports[i];
      const pStart = vScale(port.dir, port.shoulderOffsetMm);
      const pEnd = vScale(port.dir, port.shoulderOffsetMm + socketDepthMm + 2.0);
      geoms.push({
        name: `socket_bore_${i + 1}`,
        type: 'cylinder',
        size: [mm(boreRadiusMm), mm((socketDepthMm + 2.0) / 2)],
        fromto: [
          mm(pStart[0]),
          mm(pStart[1]),
          mm(pStart[2]),
          mm(pEnd[0]),
          mm(pEnd[1]),
          mm(pEnd[2]),
        ],
        csg: 'difference',
        rgba: negativeRgba,
      });

      if (opts.crossBoltHoleMm > 0) {
        const boltCenterDist = port.shoulderOffsetMm + socketDepthMm * 0.5;
        const boltCenter = vScale(port.dir, boltCenterDist);
        const perp = perpUnitVector(port.dir);
        const halfSpan = outerRadiusMm + 2.0;
        const b1 = vSub(boltCenter, vScale(perp, halfSpan));
        const b2 = vAdd(boltCenter, vScale(perp, halfSpan));
        geoms.push({
          name: `cross_bolt_${i + 1}`,
          type: 'cylinder',
          size: [mm(opts.crossBoltHoleMm / 2), mm(halfSpan)],
          fromto: [mm(b1[0]), mm(b1[1]), mm(b1[2]), mm(b2[0]), mm(b2[1]), mm(b2[2])],
          csg: 'difference',
          rgba: negativeRgba,
        });
      }
    }
  } else {
    // Spigot (internal plug) fit style
    const coreRadiusMm = spec.odMm / 2;
    const plugRadiusMm = Math.max(2.0, spec.idMm / 2 - opts.fitClearanceMm);

    geoms.push({
      name: 'hub_core',
      type: 'sphere',
      size: [mm(coreRadiusMm), mm(coreRadiusMm), mm(coreRadiusMm)],
      pos: [0, 0, 0],
      csg: 'union',
      rgba: positiveRgba,
    });

    for (let i = 0; i < hub.ports.length; i++) {
      const port = hub.ports[i];
      const pEndShoulder = vScale(port.dir, port.shoulderOffsetMm);
      if (port.shoulderOffsetMm > 0.5) {
        geoms.push({
          name: `shoulder_neck_${i + 1}`,
          type: 'cylinder',
          size: [mm(coreRadiusMm), mm(port.shoulderOffsetMm / 2)],
          fromto: [0, 0, 0, mm(pEndShoulder[0]), mm(pEndShoulder[1]), mm(pEndShoulder[2])],
          csg: 'union',
          rgba: positiveRgba,
        });
      }
      const pEndPlug = vScale(port.dir, port.shoulderOffsetMm + socketDepthMm);
      geoms.push({
        name: `spigot_plug_${i + 1}`,
        type: 'cylinder',
        size: [mm(plugRadiusMm), mm(socketDepthMm / 2)],
        fromto: [
          mm(pEndShoulder[0]),
          mm(pEndShoulder[1]),
          mm(pEndShoulder[2]),
          mm(pEndPlug[0]),
          mm(pEndPlug[1]),
          mm(pEndPlug[2]),
        ],
        csg: 'union',
        rgba: positiveRgba,
      });
    }
  }

  return {
    id: `printed_${hub.id}`,
    name: `3D Hub: ${hub.name} (${hub.ports.length}-Way)`,
    type: 'body',
    csgEnabled: true,
    pos: [mm(hub.centerMm[0]), mm(hub.centerMm[1]), mm(hub.centerMm[2])],
    joints: [],
    children: [],
    geoms,
  };
}

export function buildAllCustomHubNodes(breakdown: PipeFrameBreakdownResult): SceneNode[] {
  const customHubs = breakdown.hubs.filter((h) => h.needsCustomPrint);
  const targets = customHubs.length > 0 ? customHubs : breakdown.hubs.filter((h) => h.ports.length >= 2);
  const spacingMm = (breakdown.pipeSpec.odMm + (breakdown.options.socketDepthMm ?? breakdown.pipeSpec.socketDepthMm) * 2) * 1.4;

  return targets.map((hub, idx) => {
    const node = buildPipeHubNode(hub, breakdown.options);
    // Its own id (`printed_<hub id>`), so adding the hubs again replaces them
    // rather than stacking a second set, and an example's fittings are replaced too.
    void idx;
    node.pos = [mm(hub.centerMm[0]), mm(hub.centerMm[1]), mm(hub.centerMm[2])];
    void spacingMm;
    return node;
  });
}

// ============================================================================
// 3. Tube & Pipe Coping ("Fish-Mouth" Wrap-Around Cut Templates)
// ============================================================================

export interface TubeCopeSpec {
  id?: string;
  name?: string;
  cutTubeOdMm: number;
  cutTubeWallMm: number;
  targetKind: 'tube' | 'plane';
  targetTubeOdMm?: number;
  angleDeg: number;
  offsetMm?: number;
  clockAngleDeg?: number;
  samples?: number;
}

export interface TubeCopePoint {
  angleDeg: number;
  arcMm: number;
  outerZMm: number;
  innerZMm: number;
  cutZMm: number;
  bevelGrindMm: number;
}

export interface TubeCopeProfile {
  spec: TubeCopeSpec;
  circumferenceMm: number;
  points: TubeCopePoint[];
  peakToValleyOuterMm: number;
  peakToValleyInnerMm: number;
  peakToValleyCutMm: number;
  warnings: string[];
}

export interface SceneTubeMember {
  id: string;
  name: string;
  odMm: number;
  wallMm: number;
  lengthMm: number;
  startCope?: TubeCopeProfile;
  endCope?: TubeCopeProfile;
}

export interface TubeCopeSvgOptions {
  baseMarginMm: number;
  includeBevelLine: boolean;
  includeDegreeMarks: boolean;
  includeScaleBar: boolean;
}

export interface TubeCopeExportResult {
  svg: string;
  widthMm: number;
  heightMm: number;
  profiles: TubeCopeProfile[];
  etchUrl?: string;
}

const DEFAULT_TUBE_COPE_SVG_OPTIONS: TubeCopeSvgOptions = {
  baseMarginMm: 15,
  includeBevelLine: true,
  includeDegreeMarks: true,
  includeScaleBar: true,
};

export function computeTubeCopeJoint(spec: TubeCopeSpec): TubeCopeProfile {
  const warnings: string[] = [];
  const rOuter = Math.max(1, spec.cutTubeOdMm / 2);
  const wall = Math.max(0.1, Math.min(rOuter - 0.2, spec.cutTubeWallMm));
  const rInner = Math.max(0.2, rOuter - wall);
  const circumferenceMm = round2(Math.PI * spec.cutTubeOdMm);

  const rawAngleDeg = Math.max(10, Math.min(170, spec.angleDeg));
  if (spec.angleDeg < 15 || spec.angleDeg > 165) {
    warnings.push(`Joint angle (${spec.angleDeg}°) is very shallow; fish-mouth template will be elongated.`);
  }
  const alpha = (rawAngleDeg * Math.PI) / 180;
  const sinA = Math.sin(alpha);
  const cosA = Math.cos(alpha);
  const tanA = Math.tan(alpha);

  const clockRad = ((spec.clockAngleDeg ?? 0) * Math.PI) / 180;
  const offsetMm = spec.offsetMm ?? 0;
  const samples = Math.max(36, spec.samples ?? 120);

  const RTarget =
    spec.targetKind === 'tube'
      ? Math.max(rOuter, (spec.targetTubeOdMm ?? spec.cutTubeOdMm) / 2)
      : rOuter;

  if (spec.targetKind === 'tube') {
    const actualTargetR = (spec.targetTubeOdMm ?? spec.cutTubeOdMm) / 2;
    if (actualTargetR < rOuter - 1e-4) {
      warnings.push(
        `Cut tube OD (${spec.cutTubeOdMm}mm) is larger than target tube OD (${spec.targetTubeOdMm}mm); saddle is clamped at tangent.`
      );
    }
    if (Math.abs(offsetMm) + rOuter > actualTargetR + 1e-4) {
      warnings.push(
        `Offset (${offsetMm}mm) causes cut tube wall to miss target tube exterior partially.`
      );
    }
  }

  const rawPoints: {
    angleDeg: number;
    arcMm: number;
    zOuter: number;
    zInner: number;
    zCut: number;
  }[] = [];

  for (let i = 0; i <= samples; i++) {
    const deg = (i * 360) / samples;
    const theta = (deg * Math.PI) / 180 + clockRad;
    const arcMm = (deg / 360) * circumferenceMm;

    // Where the line along the tube at radius r meets the target.
    const zAt = (r: number): number => {
      if (spec.targetKind === 'plane') {
        // Plane miter cut: z(theta) = r * cos(theta) / tan(alpha)
        return (r * Math.cos(theta)) / tanA;
      }
      // Cylindrical saddle ("fish-mouth") intersection:
      // Target tube along Z_t, cut tube in X_t - Z_t plane at angle alpha, offset along Y_t by offsetMm
      const actualTargetR = Math.max(1, (spec.targetTubeOdMm ?? spec.cutTubeOdMm) / 2);
      const y = r * Math.sin(theta) + offsetMm;
      const radSq = Math.max(0, actualTargetR * actualTargetR - y * y);
      return (actualTargetR - Math.sqrt(radSq) + r * Math.cos(theta) * cosA) / sinA;
    };
    const zOuter = zAt(rOuter);
    const zInner = zAt(rInner);

    // A square cut through the wall must clear the target everywhere across
    // it. On a saddle the target can come lower mid-wall than at either edge
    // (0.07 mm on a 33 mm tube into a 42 mm one at 45°), so take the lowest
    // across the wall, not just of the two edges.
    let zCut = Math.min(zOuter, zInner);
    if (spec.targetKind !== 'plane') {
      for (let k = 1; k < 8; k++) zCut = Math.min(zCut, zAt(rOuter - ((rOuter - rInner) * k) / 8));
    }
    rawPoints.push({ angleDeg: round2(deg), arcMm: round2(arcMm), zOuter, zInner, zCut });
  }

  // Normalize so minimum Z across the profile is 0 (valley = 0, peaks > 0)
  const minOuter = Math.min(...rawPoints.map((p) => p.zOuter));
  const minInner = Math.min(...rawPoints.map((p) => p.zInner));
  const minCut = Math.min(...rawPoints.map((p) => p.zCut));

  const points: TubeCopePoint[] = rawPoints.map((p) => {
    const outerZMm = round2(p.zOuter - minCut);
    const innerZMm = round2(p.zInner - minCut);
    const cutZMm = round2(p.zCut - minCut);
    const bevelGrindMm = round2(Math.max(0, outerZMm - innerZMm));
    return {
      angleDeg: p.angleDeg,
      arcMm: p.arcMm,
      outerZMm,
      innerZMm,
      cutZMm,
      bevelGrindMm,
    };
  });

  const maxOuter = Math.max(...rawPoints.map((p) => p.zOuter));
  const maxInner = Math.max(...rawPoints.map((p) => p.zInner));
  const maxCut = Math.max(...rawPoints.map((p) => p.zCut));

  void RTarget;

  return {
    spec,
    circumferenceMm,
    points,
    peakToValleyOuterMm: round2(maxOuter - minOuter),
    peakToValleyInnerMm: round2(maxInner - minInner),
    peakToValleyCutMm: round2(maxCut - minCut),
    warnings,
  };
}

function pointToSegmentProjection(
  pt: Vec3,
  segA: Vec3,
  segB: Vec3
): { closest: Vec3; dist: number; t: number } {
  const ab = vSub(segB, segA);
  const lenSq = vDot(ab, ab);
  if (lenSq < 1e-9) {
    return { closest: segA, dist: vDist(pt, segA), t: 0 };
  }
  const t = Math.max(0, Math.min(1, vDot(vSub(pt, segA), ab) / lenSq));
  const closest = vAdd(segA, vScale(ab, t));
  return { closest, dist: vDist(pt, closest), t };
}

export function extractSceneTubeJoints(
  scene: SceneGraph,
  options?: { wallThicknessMm?: number; proximityToleranceMm?: number }
): SceneTubeMember[] {
  const wallMm = options?.wallThicknessMm ?? 2.0;
  const proxTolMm = options?.proximityToleranceMm ?? 15.0;

  const rawTubes: {
    id: string;
    name: string;
    p1Mm: Vec3;
    p2Mm: Vec3;
    odMm: number;
    lengthMm: number;
    axis: Vec3;
  }[] = [];

  for (const node of scene.nodes) {
    // A hub's sleeves are cylinders too, but they are the fitting, not the frame.
    if (isPipeHubNode(node)) continue;
    if ((node as SceneNode & { visible?: boolean }).visible === false) continue;
    const { worldPos, worldRotMat, scale } = nodeWorldFrame(node);
    for (let gIdx = 0; gIdx < (node.geoms ?? []).length; gIdx++) {
      const g = node.geoms[gIdx];
      if (g.csg === 'difference') continue;
      if (g.type !== 'cylinder' && g.type !== 'capsule') continue;

      const gPos: Vec3 = [g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0];
      const radiusM = (g.size?.[0] ?? 0.015) * ((scale[0] + scale[1]) / 2);
      const odMm = round2(radiusM * 2 * 1000);

      let p1Mm: Vec3;
      let p2Mm: Vec3;
      if (g.fromto && g.fromto.length === 6) {
        p1Mm = transformPointMm(
          [gPos[0] + g.fromto[0], gPos[1] + g.fromto[1], gPos[2] + g.fromto[2]],
          worldPos,
          worldRotMat,
          scale
        );
        p2Mm = transformPointMm(
          [gPos[0] + g.fromto[3], gPos[1] + g.fromto[4], gPos[2] + g.fromto[5]],
          worldPos,
          worldRotMat,
          scale
        );
      } else {
        const halfLenM = g.size?.[1] ?? 0.25;
        p1Mm = transformPointMm([gPos[0], gPos[1], gPos[2] - halfLenM], worldPos, worldRotMat, scale);
        p2Mm = transformPointMm([gPos[0], gPos[1], gPos[2] + halfLenM], worldPos, worldRotMat, scale);
      }

      const lengthMm = round2(vDist(p1Mm, p2Mm));
      if (lengthMm < 10) continue;

      rawTubes.push({
        id: g.id ?? `${node.id}_cyl_${gIdx}`,
        name: g.name ?? (node.name || node.id),
        p1Mm,
        p2Mm,
        odMm,
        lengthMm,
        axis: vNorm(vSub(p2Mm, p1Mm)),
      });
    }
  }

  return rawTubes.map((tube, idx) => {
    const member: SceneTubeMember = {
      id: tube.id,
      name: tube.name,
      odMm: tube.odMm,
      wallMm,
      lengthMm: tube.lengthMm,
    };

    // Check start (p1Mm) and end (p2Mm) against all other tubes
    const detectEndCope = (endPt: Vec3, endLabel: 'start' | 'end'): TubeCopeProfile | undefined => {
      let bestOther: (typeof rawTubes)[number] | null = null;
      let bestDist = Infinity;

      for (let j = 0; j < rawTubes.length; j++) {
        if (j === idx) continue;
        const other = rawTubes[j];
        const { dist, t } = pointToSegmentProjection(endPt, other.p1Mm, other.p2Mm);
        const touchThreshold = tube.odMm / 2 + other.odMm / 2 + proxTolMm;
        if (dist <= touchThreshold) {
          // Prefer mid-span T-joints or larger diameter target tubes
          const isMidSpan = t > 0.08 && t < 0.92;
          const score = dist - (isMidSpan ? 20 : 0) - (other.odMm > tube.odMm ? 10 : 0);
          if (score < bestDist) {
            bestDist = score;
            bestOther = other;
          }
        }
      }

      if (!bestOther) return undefined;
      const dot = Math.abs(vDot(tube.axis, bestOther.axis));
      const angleDeg = round2(Math.max(15, (Math.acos(Math.min(1, dot)) * 180) / Math.PI));

      return computeTubeCopeJoint({
        id: `${tube.id}_${endLabel}`,
        name: `${tube.name} (${endLabel} -> ${bestOther.name})`,
        cutTubeOdMm: tube.odMm,
        cutTubeWallMm: wallMm,
        targetKind: 'tube',
        targetTubeOdMm: bestOther.odMm,
        angleDeg,
      });
    };

    member.startCope = detectEndCope(tube.p1Mm, 'start');
    member.endCope = detectEndCope(tube.p2Mm, 'end');
    return member;
  });
}

function isSceneTubeMemberArray(
  input: TubeCopeSpec[] | SceneTubeMember[]
): input is SceneTubeMember[] {
  return input.length > 0 && 'odMm' in input[0] && !('cutTubeOdMm' in input[0]);
}

export function exportTubeCopeSvg(
  input: TubeCopeSpec[] | SceneTubeMember[],
  options?: Partial<TubeCopeSvgOptions>
): TubeCopeExportResult {
  const opts: TubeCopeSvgOptions = {
    ...DEFAULT_TUBE_COPE_SVG_OPTIONS,
    ...options,
  };

  const profiles: TubeCopeProfile[] = [];
  if (isSceneTubeMemberArray(input)) {
    for (const m of input) {
      if (m.startCope) profiles.push(m.startCope);
      if (m.endCope) profiles.push(m.endCope);
      if (!m.startCope && !m.endCope) {
        profiles.push(
          computeTubeCopeJoint({
            id: m.id,
            name: m.name,
            cutTubeOdMm: m.odMm,
            cutTubeWallMm: m.wallMm,
            targetKind: 'tube',
            targetTubeOdMm: m.odMm,
            angleDeg: 90,
          })
        );
      }
    }
  } else {
    for (const spec of input) {
      profiles.push(computeTubeCopeJoint(spec));
    }
  }

  const padMm = 12;
  const maxCircumference = profiles.reduce((m, p) => Math.max(m, p.circumferenceMm), 100);
  const widthMm = round2(maxCircumference + padMm * 2);

  let currentYMm = padMm;
  const svgBlocks: string[] = [];

  for (let idx = 0; idx < profiles.length; idx++) {
    const prof = profiles[idx];
    const blockHeightMm = opts.baseMarginMm + prof.peakToValleyOuterMm + 16;
    const x0 = padMm;
    const yBase = currentYMm + blockHeightMm - 6; // bottom baseline of wrap-around strip
    const ySeamTop = yBase - opts.baseMarginMm - prof.peakToValleyOuterMm;

    // Outer cut polyline points
    const outerPts = prof.points
      .map((p) => `${round2(x0 + p.arcMm)},${round2(yBase - opts.baseMarginMm - p.outerZMm)}`)
      .join(' ');

    // Closed wrap-around boundary path (cut line across top, straight baseline across bottom)
    const firstPt = prof.points[0];
    const lastPt = prof.points[prof.points.length - 1];
    const closedPathD = [
      `M ${round2(x0)},${round2(yBase)}`,
      `L ${round2(x0 + firstPt.arcMm)},${round2(yBase - opts.baseMarginMm - firstPt.outerZMm)}`,
      ...prof.points
        .slice(1)
        .map((p) => `L ${round2(x0 + p.arcMm)},${round2(yBase - opts.baseMarginMm - p.outerZMm)}`),
      `L ${round2(x0 + lastPt.arcMm)},${round2(yBase)}`,
      'Z',
    ].join(' ');

    svgBlocks.push(`  <g id="cope_template_${idx + 1}">`);
    svgBlocks.push(
      `    <path d="${closedPathD}" fill="none" stroke="#ff0000" stroke-width="0.35" data-line-role="outer-cut" />`
    );
    svgBlocks.push(
      `    <polyline points="${outerPts}" fill="none" stroke="#cc0000" stroke-width="0.4" />`
    );

    if (opts.includeBevelLine) {
      const innerPts = prof.points
        .map((p) => `${round2(x0 + p.arcMm)},${round2(yBase - opts.baseMarginMm - p.innerZMm)}`)
        .join(' ');
      svgBlocks.push(
        `    <polyline points="${innerPts}" fill="none" stroke="#0066cc" stroke-width="0.3" stroke-dasharray="2,1.5" data-line-role="inner-bevel" />`
      );
    }

    if (opts.includeDegreeMarks) {
      for (const deg of [0, 90, 180, 270, 360]) {
        const xMark = round2(x0 + (deg / 360) * prof.circumferenceMm);
        svgBlocks.push(
          `    <line x1="${xMark}" y1="${round2(ySeamTop)}" x2="${xMark}" y2="${round2(yBase)}" stroke="#666666" stroke-width="0.2" stroke-dasharray="1.5,1.5" />`
        );
        svgBlocks.push(
          `    <text x="${round2(xMark + 1)}" y="${round2(yBase - 2)}" font-family="monospace" font-size="3" fill="#333333">${deg}°</text>`
        );
      }
    }

    const label =
      prof.spec.name ??
      `Tube OD ${prof.spec.cutTubeOdMm}mm x ${prof.spec.cutTubeWallMm}mm @ ${prof.spec.angleDeg}°`;
    svgBlocks.push(
      `    <text x="${round2(x0 + 2)}" y="${round2(yBase - opts.baseMarginMm / 2)}" font-family="monospace" font-size="3.5" fill="#111111">${label} (Circ: ${prof.circumferenceMm}mm)</text>`
    );
    svgBlocks.push('  </g>');

    currentYMm += blockHeightMm + 10;
  }

  if (opts.includeScaleBar) {
    const barX = padMm;
    const barY = currentYMm + 4;
    svgBlocks.push('  <g id="calibration_scale_bar_50mm">');
    svgBlocks.push(
      `    <line x1="${barX}" y1="${barY}" x2="${barX + 50}" y2="${barY}" stroke="#000000" stroke-width="0.5" />`
    );
    svgBlocks.push(
      `    <line x1="${barX}" y1="${barY - 2}" x2="${barX}" y2="${barY + 2}" stroke="#000000" stroke-width="0.5" />`
    );
    svgBlocks.push(
      `    <line x1="${barX + 50}" y1="${barY - 2}" x2="${barX + 50}" y2="${barY + 2}" stroke="#000000" stroke-width="0.5" />`
    );
    svgBlocks.push(
      `    <text x="${barX + 12}" y="${barY - 1.5}" font-family="monospace" font-size="3.2" fill="#000000">50 mm Scale Check</text>`
    );
    svgBlocks.push('  </g>');
    currentYMm += 14;
  }

  const heightMm = round2(Math.max(40, currentYMm));
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${widthMm}mm" height="${heightMm}mm" viewBox="0 0 ${widthMm} ${heightMm}">`,
    ...svgBlocks,
    '</svg>',
  ].join('\n');

  return {
    svg,
    widthMm,
    heightMm,
    profiles,
  };
}

export async function buildTubeCopeEtchUrl(
  result: TubeCopeExportResult,
  name = 'Tube Cope Template'
): Promise<string> {
  const baseUrl = etchBaseUrl(
    typeof window !== 'undefined' && window.location
      ? window.location
      : { hostname: 'localhost', protocol: 'http:' }
  );
  return buildEtchHandoffUrl(
    {
      name,
      svg: result.svg,
    },
    baseUrl
  );
}

// ============================================================================
// 4. 3D Wire Bending Schedule (LRA) & Printable Wire Bending Jig
// ============================================================================

export interface WireBendOptions {
  wireDiameterMm: number;
  bendRadiusMm: number;
  springbackFactor: number;
  simplifyToleranceMm: number;
}

export interface WireBendStep {
  stepIndex: number;
  vertexMm: [number, number, number];
  straightFeedMm: number;
  bendAngleDeg: number;
  overbendAngleDeg: number;
  rotateAngleDeg: number;
  arcLengthMm: number;
  setbackMm: number;
  pegCenterMm: [number, number, number];
}

export interface WireBendSchedule {
  options: WireBendOptions;
  pointsMm: [number, number, number][];
  steps: WireBendStep[];
  finalStraightMm: number;
  totalCutLengthMm: number;
  sharpPolylineLengthMm: number;
  isPlanar: boolean;
  warnings: string[];
}

export interface WireBendJigOptions extends WireBendOptions {
  baseThicknessMm: number;
  marginMm: number;
  pegHeightMm: number;
  grooveDepthMm: number;
  clearanceMm: number;
}

const DEFAULT_WIRE_BEND_OPTIONS: WireBendOptions = {
  wireDiameterMm: 3.0,
  bendRadiusMm: 6.0,
  springbackFactor: 1.04,
  simplifyToleranceMm: 0.5,
};

const DEFAULT_WIRE_BEND_JIG_OPTIONS: WireBendJigOptions = {
  ...DEFAULT_WIRE_BEND_OPTIONS,
  baseThicknessMm: 5.0,
  marginMm: 14.0,
  pegHeightMm: 10.0,
  grooveDepthMm: 2.2,
  clearanceMm: 0.3,
};

function rdpSimplify3D(pts: Vec3[], toleranceMm: number): Vec3[] {
  if (pts.length <= 2 || toleranceMm <= 0) return pts.map((p) => [...p]);
  let maxDist = 0;
  let maxIdx = 0;
  const first = pts[0];
  const last = pts[pts.length - 1];

  for (let i = 1; i < pts.length - 1; i++) {
    const { dist } = pointToSegmentProjection(pts[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > toleranceMm) {
    const left = rdpSimplify3D(pts.slice(0, maxIdx + 1), toleranceMm);
    const right = rdpSimplify3D(pts.slice(maxIdx), toleranceMm);
    return [...left.slice(0, -1), ...right];
  }
  return [[...first], [...last]];
}

export function computeWireBendSchedule(
  pointsMm: [number, number, number][],
  options?: Partial<WireBendOptions>
): WireBendSchedule {
  const opts: WireBendOptions = {
    ...DEFAULT_WIRE_BEND_OPTIONS,
    ...options,
  };
  const warnings: string[] = [];

  // Deduplicate coincident consecutive vertices and run optional RDP simplification
  const deduped: Vec3[] = [];
  for (const p of pointsMm) {
    if (deduped.length === 0 || vDist(deduped[deduped.length - 1], p) > 1e-4) {
      deduped.push([p[0], p[1], p[2]]);
    }
  }
  const cleanPts =
    opts.simplifyToleranceMm > 0 ? rdpSimplify3D(deduped, opts.simplifyToleranceMm) : deduped;

  if (cleanPts.length < 2) {
    return {
      options: opts,
      pointsMm: cleanPts,
      steps: [],
      finalStraightMm: 0,
      totalCutLengthMm: 0,
      sharpPolylineLengthMm: 0,
      isPlanar: true,
      warnings: ['Wire path needs at least 2 points.'],
    };
  }

  const segLengths: number[] = [];
  const segDirs: Vec3[] = [];
  let sharpPolylineLengthMm = 0;

  for (let i = 0; i < cleanPts.length - 1; i++) {
    const d = vDist(cleanPts[i], cleanPts[i + 1]);
    segLengths.push(d);
    sharpPolylineLengthMm += d;
    segDirs.push(vNorm(vSub(cleanPts[i + 1], cleanPts[i])));
  }

  const nBends = cleanPts.length - 2;
  const bendAnglesRad: number[] = [];
  const setbacks: number[] = [];
  const arcLengths: number[] = [];
  const bendNormals: Vec3[] = [];
  const pegCenters: Vec3[] = [];

  for (let b = 0; b < nBends; b++) {
    const uIn = segDirs[b];
    const uOut = segDirs[b + 1];
    const dot = Math.max(-1, Math.min(1, vDot(uIn, uOut)));
    const thetaRad = Math.acos(dot); // deflection angle (0 = straight, 90deg = right angle)
    bendAnglesRad.push(thetaRad);

    const setback = opts.bendRadiusMm * Math.tan(thetaRad / 2);
    const arcLen = opts.bendRadiusMm * thetaRad;
    setbacks.push(setback);
    arcLengths.push(arcLen);

    const cross = vCross(uIn, uOut);
    bendNormals.push(vLen(cross) > 1e-6 ? vNorm(cross) : [0, 0, 1]);

    // Inside corner peg center: offset along bisector of (-uIn) and (uOut) by bendRadius / cos(theta/2)
    const bisector = vNorm(vAdd(vScale(uIn, -1), uOut));
    const halfCos = Math.max(0.15, Math.cos(thetaRad / 2));
    const distToCenter = opts.bendRadiusMm / halfCos;
    const pegCenter = vAdd(cleanPts[b + 1], vScale(bisector, distToCenter));
    pegCenters.push([round2(pegCenter[0]), round2(pegCenter[1]), round2(pegCenter[2])]);
  }

  const steps: WireBendStep[] = [];
  let prevNormal: Vec3 | null = null;
  let isPlanar = true;

  for (let b = 0; b < nBends; b++) {
    const segLen = segLengths[b];
    const prevSetback = b === 0 ? 0 : setbacks[b - 1];
    const currSetback = setbacks[b];
    const rawStraight = segLen - prevSetback - currSetback;

    if (rawStraight < 0) {
      warnings.push(
        `Segment ${b + 1} (${round2(segLen)}mm) is shorter than combined bend setbacks (${round2(prevSetback + currSetback)}mm).`
      );
    }

    const straightFeedMm = round2(Math.max(0, rawStraight));
    const bendAngleDeg = round2((bendAnglesRad[b] * 180) / Math.PI);
    const overbendAngleDeg = round2(bendAngleDeg * opts.springbackFactor);

    let rotateAngleDeg = 0;
    const currNormal = bendNormals[b];
    if (prevNormal && bendAngleDeg > 1.0) {
      const nDot = Math.max(-1, Math.min(1, vDot(prevNormal, currNormal)));
      const nCross = vCross(prevNormal, currNormal);
      const sign = vDot(nCross, segDirs[b]) >= 0 ? 1 : -1;
      rotateAngleDeg = round2(sign * ((Math.acos(nDot) * 180) / Math.PI));
      if (Math.abs(rotateAngleDeg) > 2.0 && Math.abs(Math.abs(rotateAngleDeg) - 180) > 2.0) {
        isPlanar = false;
      }
    }
    if (bendAngleDeg > 1.0) {
      prevNormal = currNormal;
    }

    steps.push({
      stepIndex: b + 1,
      vertexMm: [round2(cleanPts[b + 1][0]), round2(cleanPts[b + 1][1]), round2(cleanPts[b + 1][2])],
      straightFeedMm,
      bendAngleDeg,
      overbendAngleDeg,
      rotateAngleDeg,
      arcLengthMm: round2(arcLengths[b]),
      setbackMm: round2(currSetback),
      pegCenterMm: pegCenters[b],
    });
  }

  const lastSegLen = segLengths[segLengths.length - 1];
  const lastSetback = nBends > 0 ? setbacks[nBends - 1] : 0;
  if (lastSegLen - lastSetback < 0) {
    warnings.push(
      `Final segment (${round2(lastSegLen)}mm) is shorter than last bend setback (${round2(lastSetback)}mm).`
    );
  }
  const finalStraightMm = round2(Math.max(0, lastSegLen - lastSetback));

  const sumStraights =
    steps.reduce((acc, s) => acc + s.straightFeedMm, 0) + finalStraightMm;
  const sumArcs = steps.reduce((acc, s) => acc + s.arcLengthMm, 0);
  const totalCutLengthMm = round2(sumStraights + sumArcs);

  return {
    options: opts,
    pointsMm: cleanPts,
    steps,
    finalStraightMm,
    totalCutLengthMm,
    sharpPolylineLengthMm: round2(sharpPolylineLengthMm),
    isPlanar,
    warnings,
  };
}

export function extractSceneWireCurves(
  scene: SceneGraph
): { id: string; name: string; pointsMm: [number, number, number][] }[] {
  const results: { id: string; name: string; pointsMm: [number, number, number][] }[] = [];

  // Chain connected cylinder/capsule segments into polylines
  const segments: { name: string; p1: Vec3; p2: Vec3; used: boolean }[] = [];
  for (const node of scene.nodes) {
    // A hub's sleeves are cylinders too, but they are the fitting, not the frame.
    if (isPipeHubNode(node)) continue;
    if ((node as SceneNode & { visible?: boolean }).visible === false) continue;
    const { worldPos, worldRotMat, scale } = nodeWorldFrame(node);
    for (const g of node.geoms ?? []) {
      if (g.csg === 'difference') continue;
      if ((g.type === 'cylinder' || g.type === 'capsule') && g.fromto && g.fromto.length === 6) {
        const gPos: Vec3 = [g.pos?.[0] ?? 0, g.pos?.[1] ?? 0, g.pos?.[2] ?? 0];
        const p1 = transformPointMm(
          [gPos[0] + g.fromto[0], gPos[1] + g.fromto[1], gPos[2] + g.fromto[2]],
          worldPos,
          worldRotMat,
          scale
        );
        const p2 = transformPointMm(
          [gPos[0] + g.fromto[3], gPos[1] + g.fromto[4], gPos[2] + g.fromto[5]],
          worldPos,
          worldRotMat,
          scale
        );
        if (vDist(p1, p2) > 1.0) {
          segments.push({ name: node.name || node.id, p1, p2, used: false });
        }
      }
    }
  }

  const tol = 5.0;
  let curveIdx = 1;
  for (let i = 0; i < segments.length; i++) {
    if (segments[i].used) continue;
    segments[i].used = true;
    const chain: Vec3[] = [segments[i].p1, segments[i].p2];

    let extended = true;
    while (extended) {
      extended = false;
      for (let j = 0; j < segments.length; j++) {
        if (segments[j].used) continue;
        const head = chain[0];
        const tail = chain[chain.length - 1];
        if (vDist(tail, segments[j].p1) <= tol) {
          chain.push(segments[j].p2);
          segments[j].used = true;
          extended = true;
        } else if (vDist(tail, segments[j].p2) <= tol) {
          chain.push(segments[j].p1);
          segments[j].used = true;
          extended = true;
        } else if (vDist(head, segments[j].p2) <= tol) {
          chain.unshift(segments[j].p1);
          segments[j].used = true;
          extended = true;
        } else if (vDist(head, segments[j].p1) <= tol) {
          chain.unshift(segments[j].p2);
          segments[j].used = true;
          extended = true;
        }
      }
    }

    results.push({
      id: `wire_curve_${curveIdx}`,
      name: segments[i].name || `Wire Curve ${curveIdx}`,
      pointsMm: chain,
    });
    curveIdx++;
  }

  return results;
}

export function buildWireBendingJigNode(
  pointsMm: [number, number, number][],
  options?: Partial<WireBendJigOptions>
): { jigNode: SceneNode; schedule: WireBendSchedule; isPlanar: boolean } {
  const opts: WireBendJigOptions = {
    ...DEFAULT_WIRE_BEND_JIG_OPTIONS,
    ...options,
  };
  const schedule = computeWireBendSchedule(pointsMm, opts);
  const pts = schedule.pointsMm;

  // Project onto XY plane for flat printable jig (or keep Z height pedestals if 3D)
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = (xs.length > 0 ? Math.min(...xs) : -40) - opts.marginMm;
  const maxX = (xs.length > 0 ? Math.max(...xs) : 40) + opts.marginMm;
  const minY = (ys.length > 0 ? Math.min(...ys) : -30) - opts.marginMm;
  const maxY = (ys.length > 0 ? Math.max(...ys) : 30) + opts.marginMm;

  const widthMm = Math.max(30, maxX - minX);
  const depthMm = Math.max(30, maxY - minY);
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;

  const geoms: SceneGeom[] = [];
  const plateRgba: [number, number, number, number] = [0.24, 0.28, 0.34, 1.0];
  const pegRgba: [number, number, number, number] = [0.95, 0.65, 0.15, 1.0];
  const grooveRgba: [number, number, number, number] = [0.85, 0.25, 0.25, 1.0];

  // 1. Base plate (top surface at z = 0)
  const basePlate = boxGeom(
    'jig_base_plate',
    [mm(widthMm / 2), mm(depthMm / 2), mm(opts.baseThicknessMm / 2)],
    [mm(centerX), mm(centerY), mm(-opts.baseThicknessMm / 2)],
    plateRgba,
    undefined,
    { csg: 'union' }
  );
  geoms.push(basePlate);

  // 2. Cylindrical bending pegs at each inside corner radius center
  const pegRadiusMm = Math.max(1.5, opts.bendRadiusMm - opts.wireDiameterMm / 2);
  for (const step of schedule.steps) {
    const px = step.pegCenterMm[0];
    const py = step.pegCenterMm[1];
    const pzTop = Math.max(opts.pegHeightMm, step.pegCenterMm[2] + opts.pegHeightMm);
    const pegH = pzTop + opts.baseThicknessMm * 0.5;
    const pegZ = (pzTop - opts.baseThicknessMm * 0.5) / 2;
    const peg = cylinderGeom(
      `bend_peg_${step.stepIndex}`,
      mm(pegRadiusMm),
      mm(pegH),
      mm(pegZ),
      pegRgba,
      { pos: [mm(px), mm(py), mm(pegZ)], csg: 'union' }
    );
    geoms.push(peg);
  }

  // 3. Start stop post near first point
  if (pts.length >= 2) {
    const u0 = vNorm(vSub(pts[1], pts[0]));
    const n0: Vec3 = [-u0[1], u0[0], 0];
    const stopRadiusMm = 3.0;
    const stopPos = vAdd(
      pts[0],
      vScale(n0, opts.wireDiameterMm / 2 + stopRadiusMm + opts.clearanceMm)
    );
    geoms.push(
      cylinderGeom(
        'start_stop_peg',
        mm(stopRadiusMm),
        mm(opts.pegHeightMm),
        mm(opts.pegHeightMm / 2),
        pegRgba,
        { pos: [mm(stopPos[0]), mm(stopPos[1]), mm(opts.pegHeightMm / 2)], csg: 'union' }
      )
    );
  }

  // 4. Subtract wire guide channel along straight segments into top of baseplate
  const grooveRadiusMm = opts.wireDiameterMm / 2 + opts.clearanceMm;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (vDist(a, b) < 1.0) continue;
    geoms.push({
      name: `wire_groove_${i + 1}`,
      type: 'cylinder',
      size: [mm(grooveRadiusMm), mm(vDist(a, b) / 2)],
      fromto: [
        mm(a[0]),
        mm(a[1]),
        mm(grooveRadiusMm - opts.grooveDepthMm),
        mm(b[0]),
        mm(b[1]),
        mm(grooveRadiusMm - opts.grooveDepthMm),
      ],
      csg: 'difference',
      rgba: grooveRgba,
    });
  }

  const jigNode: SceneNode = {
    id: 'wire_bending_jig',
    name: `Wire Bending Jig (Ø${opts.wireDiameterMm}mm, R${opts.bendRadiusMm}mm)`,
    type: 'body',
    csgEnabled: true,
    pos: [0, 0, 0],
    joints: [],
    children: [],
    geoms,
  };

  return {
    jigNode,
    schedule,
    isPlanar: schedule.isPlanar,
  };
}
