import type { SceneGraph, SceneNode } from '../types/scene';
import { noteToHz } from '../utils/acousticTuning';
import { buildMountedStringsForBody, tuneStringToPitch } from '../utils/stringAcoustics';

/**
 * Spruce & Maple Violoncello Automaton (`bowed_cello`):
 * - Hollowed figure-8 Cremonese spruce & maple soundbox (~8.2 L air chamber +
 *   4.5 mm spruce soundboard + twin CSG f-hole ports -> f_H ≈ 125 Hz)
 * - 4 taut steel cello strings arranged on a real R = 92 mm arched bridge radius
 *   at [-24°, -8°, +8°, +24°] so a straight horsehair bow physically selects one
 *   string (or double-stop) at a time purely via 3D geometry & MuJoCo contact!
 * - 80 g Pernambuco & Mongolian horsehair bow on a concentric 2-DOF + normal-press
 *   gimbal (`bow_rock`, `bow_press`, `bow_stroke`) playing the iconic opening
 *   arpeggio of J.S. Bach's Cello Suite No. 1 in G Major (BWV 1007):
 *     G3 - D4 - B4 - A4 - B4 - D4 - B4 - D4
 */
export const bowedCelloPreset: SceneGraph = (() => {
  const BRIDGE_ARC_RADIUS = 0.092;
  const BRIDGE_ARC_CENTER_Z = 0.018;
  const STRING_CENTER_Y = 0.125;
  const STRING_HALF_LEN = 0.170; // 340 mm vibrating scale from bridge (-0.045) to nut (+0.295)
  const BOW_STATION_Y = -0.007; // Bows right through the C-bout waist, 38 mm from bridge -> beta ≈ 0.112
  const STRING_ANGLES_DEG = [-27, -9, 9, 27];

  const soundbox: SceneNode = {
    id: 'cello_soundbox',
    name: 'Spruce & Maple Cello Body',
    type: 'body',
    pos: [0, 0, 0.056],
    deformMaterial: 'softwood',
    csgEnabled: true,
    collision: 'hull',
    script: `// J.S. Bach — Cello Suite No. 1 in G Major, BWV 1007 (Prelude Measure 1)
// Arpeggiates G3 - D4 - B4 - A4 - B4 - D4 - B4 - D4 across the 4 arched-bridge strings
// via real 3D bow string-crossing (bow_rock) and alternating tiré/poussé strokes (bow_stroke).
const t = api.getTime();
const angles = [-0.47124, -0.15708, 0.15708, 0.47124];
const pattern = [0, 1, 3, 2, 3, 1, 3, 1];
const noteDur = 0.24;
const stepIdx = Math.floor(t / noteDur);
const u = (t - stepIdx * noteDur) / noteDur;

const strIdx = pattern[stepIdx % 8];
const prevIdx = stepIdx > 0 ? pattern[(stepIdx - 1) % 8] : strIdx;
const targetRock = angles[strIdx];

const qRock = api.getJointPosition('bow_rock');
const qPress = api.getJointPosition('bow_press');
const qStroke = api.getJointPosition('bow_stroke');
const rockErr = targetRock - qRock;
const bowComX = -0.042 + qStroke;
const bowComZ = 0.095 + qPress;
const gravTorqueY = 0.080 * 9.81 * (bowComX * Math.cos(qRock) + bowComZ * Math.sin(qRock));
api.applyJointForce('bow_rock', -gravTorqueY + 52.0 * rockErr);

// Cellist wrist clearance: brief 26 ms lift during string crossings (and initial arrival onto String 1)
const isCrossing = (stepIdx === 0 && u < 0.12) || (strIdx !== prevIdx && u < 0.12);
const gravNormal = 0.080 * 9.81 * Math.cos(qRock);
if (isCrossing) {
  api.applyJointForce('bow_press', gravNormal + 260 * (0.0018 - qPress));
} else {
  // Steady 1.05 N normal rosin bow weight right in Schelleng's Helmholtz sweet spot
  api.applyJointForce('bow_press', gravNormal - 1.05);
}

// Smooth C1 trapezoidal bow velocity (~0.31 m/s steady Helmholtz plateau, alternating down/up-bow)
const a = 0.08;
let posFrac = 0;
let velNorm = 0;
if (u < a) {
  posFrac = (0.5 * u * u) / (a * (1 - a));
  velNorm = u / (a * (1 - a));
} else if (u <= 1 - a) {
  posFrac = (u - 0.5 * a) / (1 - a);
  velNorm = 1 / (1 - a);
} else {
  const rem = 1 - u;
  posFrac = 1 - (0.5 * rem * rem) / (a * (1 - a));
  velNorm = rem / (a * (1 - a));
}

const strokeSpan = 0.084;
const isDownBow = (stepIdx % 2) === 0;
const xTarget = isDownBow ? strokeSpan * posFrac : strokeSpan * (1 - posFrac);
const vTarget = (isDownBow ? 1 : -1) * (strokeSpan / noteDur) * velNorm;

const gravTangent = -0.080 * 9.81 * Math.sin(qRock);
api.applyJointForce('bow_stroke', gravTangent + 22.0 * vTarget + 240 * (xTarget - qStroke));
`,
    joints: [],
    geoms: [
      // 1. Cremonese Figure-8 Spruce & Maple Corpus (92 mm rib depth)
      {
        name: 'lower_bout',
        type: 'cylinder',
        size: [0.136, 0.046],
        pos: [0, -0.102, 0],
        rgba: [0.68, 0.35, 0.15, 1],
      },
      {
        name: 'upper_bout',
        type: 'cylinder',
        size: [0.116, 0.046],
        pos: [0, 0.102, 0],
        rgba: [0.68, 0.35, 0.15, 1],
      },
      {
        name: 'c_bout_waist',
        type: 'box',
        size: [0.092, 0.116, 0.046],
        pos: [0, 0, 0],
        rgba: [0.70, 0.37, 0.16, 1],
      },
      // 2. Internal ~8.4 L Air Chamber (leaving 4.5 mm spruce soundboard & >= 8 mm maple ribs everywhere)
      {
        name: 'cavity_lower',
        type: 'cylinder',
        size: [0.126, 0.041],
        pos: [0, -0.102, 0.0005],
        csg: 'difference',
        rgba: [0.24, 0.14, 0.08, 0.35],
      },
      {
        name: 'cavity_upper',
        type: 'cylinder',
        size: [0.106, 0.041],
        pos: [0, 0.102, 0.0005],
        csg: 'difference',
        rgba: [0.24, 0.14, 0.08, 0.35],
      },
      {
        name: 'cavity_waist',
        type: 'box',
        size: [0.082, 0.108, 0.041],
        pos: [0, 0, 0.0005],
        csg: 'difference',
        rgba: [0.24, 0.14, 0.08, 0.35],
      },
      // 3. Twin CSG f-hole Ports through the 4.5 mm Spruce Soundboard
      {
        name: 'f_hole_left',
        type: 'box',
        size: [0.006, 0.040, 0.008],
        pos: [-0.048, -0.032, 0.044],
        csg: 'difference',
        rgba: [0.12, 0.08, 0.06, 0.65],
      },
      {
        name: 'f_hole_right',
        type: 'box',
        size: [0.006, 0.040, 0.008],
        pos: [0.048, -0.032, 0.044],
        csg: 'difference',
        rgba: [0.12, 0.08, 0.06, 0.65],
      },
      // 4. Luthier Cradle Stand, Maple Neck, Ebony Fingerboard, Arched Bridge & Tailpiece (visual)
      {
        name: 'cradle_stand_rear',
        type: 'box',
        size: [0.11, 0.016, 0.005],
        pos: [0, -0.13, -0.051],
        rgba: [0.26, 0.16, 0.10, 1],
        role: 'visual',
      },
      {
        name: 'cradle_stand_front',
        type: 'box',
        size: [0.095, 0.016, 0.005],
        pos: [0, 0.12, -0.051],
        rgba: [0.26, 0.16, 0.10, 1],
        role: 'visual',
      },
      {
        name: 'maple_neck',
        type: 'capsule',
        fromto: [0, 0.210, 0.042, 0, 0.325, 0.072],
        size: [0.015],
        rgba: [0.74, 0.48, 0.26, 1],
        role: 'visual',
      },
      {
        name: 'scroll_volute',
        type: 'ellipsoid',
        size: [0.017, 0.024, 0.020],
        pos: [0, 0.348, 0.076],
        rgba: [0.66, 0.34, 0.15, 1],
        role: 'visual',
      },
      {
        name: 'peg_row_upper',
        type: 'cylinder',
        fromto: [-0.036, 0.320, 0.074, 0.036, 0.320, 0.074],
        size: [0.0035],
        rgba: [0.12, 0.11, 0.13, 1],
        role: 'visual',
      },
      {
        name: 'peg_row_lower',
        type: 'cylinder',
        fromto: [-0.036, 0.302, 0.070, 0.036, 0.302, 0.070],
        size: [0.0035],
        rgba: [0.12, 0.11, 0.13, 1],
        role: 'visual',
      },
      {
        name: 'ebony_fingerboard',
        type: 'box',
        size: [0.026, 0.125, 0.0045],
        pos: [0, 0.170, 0.084],
        euler: [-1.8, 0, 0],
        rgba: [0.11, 0.11, 0.13, 1],
        role: 'visual',
      },
      {
        name: 'ebony_nut',
        type: 'box',
        size: [0.040, 0.004, 0.012],
        pos: [0, 0.295, 0.090],
        rgba: [0.12, 0.12, 0.14, 1],
        role: 'visual',
      },
      {
        name: 'bridge_feet',
        type: 'box',
        size: [0.044, 0.0045, 0.022],
        pos: [0, -0.045, 0.068],
        rgba: [0.85, 0.68, 0.45, 1],
        role: 'visual',
      },
      {
        name: 'bridge_arch_center',
        type: 'box',
        size: [0.020, 0.0035, 0.025],
        pos: [0, -0.045, 0.076],
        rgba: [0.86, 0.70, 0.47, 1],
        role: 'visual',
      },
      {
        name: 'bridge_arch_left',
        type: 'box',
        size: [0.016, 0.0035, 0.020],
        pos: [-0.026, -0.045, 0.072],
        euler: [0, -16, 0],
        rgba: [0.86, 0.70, 0.47, 1],
        role: 'visual',
      },
      {
        name: 'bridge_arch_right',
        type: 'box',
        size: [0.016, 0.0035, 0.020],
        pos: [0.026, -0.045, 0.072],
        euler: [0, 16, 0],
        rgba: [0.86, 0.70, 0.47, 1],
        role: 'visual',
      },
      {
        name: 'ebony_tailpiece',
        type: 'box',
        size: [0.024, 0.075, 0.004],
        pos: [0, -0.145, 0.076],
        euler: [11, 0, 0],
        rgba: [0.11, 0.11, 0.13, 1],
        role: 'visual',
      },
      {
        name: 'brass_endpin',
        type: 'cylinder',
        fromto: [0, -0.240, 0.0, 0, -0.315, 0.0],
        size: [0.0045],
        rgba: [0.82, 0.68, 0.30, 1],
        role: 'visual',
      },
    ],
    children: [],
  };

  // Tune 4 open strings to G3, D4, A4, B4 (196.00, 293.66, 440.00, 493.88 Hz) for Bach's Prelude in G Major
  const noteNames = ['G3', 'D4', 'A4', 'B4'] as const;
  const notesHz = noteNames.map((n) => noteToHz(n) ?? 196.0);
  const rawStrings = buildMountedStringsForBody(soundbox, {
    notes: notesHz,
    material: 'steel',
    pluckPos: 0.112,
  });

  const archedStrings = rawStrings.map((s, i) => {
    const thetaRad = (STRING_ANGLES_DEG[i] * Math.PI) / 180;
    const x = +(BRIDGE_ARC_RADIUS * Math.sin(thetaRad)).toFixed(5);
    const z = +(BRIDGE_ARC_CENTER_Z + BRIDGE_ARC_RADIUS * Math.cos(thetaRad)).toFixed(5);
    const tangentAxis: [number, number, number] = [
      +Math.cos(thetaRad).toFixed(5),
      0,
      +(-Math.sin(thetaRad)).toFixed(5),
    ];
    const positioned: SceneNode = {
      ...s,
      name: `Cello String ${i + 1} (${noteNames[i]})`,
      pos: [x, STRING_CENTER_Y, z],
      joints: s.joints?.map((j, jIdx) => (jIdx === 0 ? { ...j, axis: tangentAxis } : j)),
      geoms: s.geoms.map((g, gIdx) =>
        gIdx === 0
          ? {
              ...g,
              fromto: [0, -STRING_HALF_LEN, 0, 0, STRING_HALF_LEN, 0],
              friction: [0.35, 0.004, 0.0004],
              solref: [-3600, -3.5],
            }
          : g,
      ),
    };
    return tuneStringToPitch(positioned, notesHz[i]);
  });

  // Concentric 2-DOF + normal-press Bow Gimbal centered on the R = 92 mm bridge arc!
  const celloBow: SceneNode = {
    id: 'cello_bow',
    name: 'Pernambuco & Horsehair Bow',
    type: 'body',
    pos: [-0.042, 0, +(BRIDGE_ARC_RADIUS + 0.0024).toFixed(5)],
    deformMaterial: 'hardwood',
    joints: [
      {
        name: 'bow_press',
        type: 'slide',
        axis: [0, 0, 1],
        damping: 5.5,
        limited: true,
        range: [-0.0018, 0.010],
        hardStop: true,
      },
      {
        name: 'bow_stroke',
        type: 'slide',
        axis: [1, 0, 0],
        damping: 22.0,
        limited: true,
        range: [-0.16, 0.16],
      },
    ],
    geoms: [
      {
        name: 'horsehair_ribbon',
        type: 'box',
        size: [0.200, 0.0045, 0.0032],
        pos: [0, 0, 0.0018],
        mass: 0.018,
        condim: 3,
        friction: [0.35, 0.004, 0.0004],
        solref: [-1800, -3.5],
        solimp: [0.97, 0.995, 0.0005, 0.5, 2],
        rgba: [0.96, 0.94, 0.87, 1],
      },
      {
        name: 'pernambuco_stick',
        type: 'capsule',
        fromto: [-0.208, 0, 0.012, 0.212, 0, 0.009],
        size: [0.0038],
        mass: 0.044,
        rgba: [0.54, 0.18, 0.09, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'ebony_frog',
        type: 'box',
        size: [0.018, 0.006, 0.007],
        pos: [-0.194, 0, 0.006],
        mass: 0.014,
        rgba: [0.12, 0.11, 0.13, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'silver_adjuster_screw',
        type: 'cylinder',
        fromto: [-0.212, 0, 0.012, -0.224, 0, 0.012],
        size: [0.0032],
        mass: 0.004,
        rgba: [0.84, 0.85, 0.88, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'ivory_bow_tip',
        type: 'box',
        size: [0.006, 0.0042, 0.0055],
        pos: [0.206, 0, 0.0045],
        rgba: [0.92, 0.90, 0.84, 1],
        role: 'visual',
      },
    ],
    children: [],
  };

  const bowGimbal: SceneNode = {
    id: 'bow_gimbal',
    name: 'Arched Bridge Bow Gimbal',
    type: 'body',
    pos: [0, BOW_STATION_Y, BRIDGE_ARC_CENTER_Z],
    joints: [
      {
        name: 'bow_rock',
        type: 'hinge',
        axis: [0, 1, 0],
        damping: 0.65,
        limited: true,
        range: [-35, 35],
      },
    ],
    geoms: [
      {
        name: 'gimbal_hub',
        type: 'cylinder',
        fromto: [0, -0.012, 0, 0, 0.012, 0],
        size: [0.008],
        mass: 0.035,
        rgba: [0.76, 0.62, 0.28, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [celloBow],
  };

  soundbox.children = [...archedStrings, bowGimbal];
  return { nodes: [soundbox] };
})();
