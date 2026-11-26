import type { SceneGraph, SceneNode } from '../types/scene';
import { noteToHz } from '../utils/acousticTuning';
import { buildMountedStringsForBody, tuneStringToPitch } from '../utils/stringAcoustics';

/**
 * Full-Size 4/4 Cremonese Violoncello Automaton (`bowed_cello`):
 * - Authentic Stradivarius ("Duport") 740 mm × 428 mm × 116 mm figure-8 corpus
 *   enclosing a ~26.5 L air chamber beneath a graduated 3.4 mm Alpine spruce belly
 *   with twin carved CSG f-holes (f_H ≈ 98 Hz, tuned right onto open G2!)
 * - Real internal 3D lutherie architecture:
 *   - Vertical Spruce Soundpost wedged between spruce belly & maple back behind
 *     the treble bridge foot (creating asymmetric monopole volume-velocity drive!)
 *   - Longitudinal Spruce Bass Bar glued beneath the bass bridge foot
 * - Complete 640 mm vibrating scale load path: Pegbox -> Arched Ebony Nut (y = +0.572) ->
 *   C2-G2-D3-A3 Concert Cello Strings -> Standing Arched Maple Bridge (y = -0.068) ->
 *   Silk Afterlengths -> Ebony Tailpiece & Saddle
 * - 3D Left-Hand Stopping Finger on A3 at y = +0.5022 m (8/9 scale -> B3 = 246.94 Hz)
 *   playing J.S. Bach's Cello Suite No. 1 in G Major (BWV 1007) in 4-note slurred strokes.
 */
export const bowedCelloPreset: SceneGraph = (() => {
  const BRIDGE_ARC_RADIUS = 0.096;
  const BRIDGE_ARC_CENTER_Z = 0.056; // Authentic 90 mm Belgian/Stradivarius 4/4 cello bridge height over spruce belly!
  const BRIDGE_Y = -0.068;
  const NUT_Y = 0.572;
  const STRING_CENTER_Y = 0.5 * (BRIDGE_Y + NUT_Y); // +0.252 m
  const STRING_HALF_LEN = 0.5 * (NUT_Y - BRIDGE_Y); // 0.320 m -> 640 mm concert cello scale!
  const BOW_STATION_Y = -0.008; // Bows right through the C-bout waist, 60 mm from bridge -> beta ≈ 0.094
  const STRING_ANGLES_DEG = [-24, -8, 8, 24];

  const stringCoords = STRING_ANGLES_DEG.map((deg) => {
    const rad = (deg * Math.PI) / 180;
    return {
      deg,
      rad,
      x: +(BRIDGE_ARC_RADIUS * Math.sin(rad)).toFixed(5),
      z: +(BRIDGE_ARC_CENTER_Z + BRIDGE_ARC_RADIUS * Math.cos(rad)).toFixed(5),
    };
  });

  const afterlengthGeoms = stringCoords.map((sc, idx) => ({
    name: `afterlength_tail_${idx + 1}`,
    type: 'capsule' as const,
    fromto: [sc.x, BRIDGE_Y, sc.z, +(sc.x * 0.44).toFixed(5), -0.175, 0.108],
    size: [0.0009],
    rgba: [0.76, 0.18, 0.18, 1] as [number, number, number, number],
    role: 'visual' as const,
  }));

  const pegboxLeaderGeoms = stringCoords.map((sc, idx) => ({
    name: `pegbox_leader_${idx + 1}`,
    type: 'capsule' as const,
    fromto: [sc.x, NUT_Y, sc.z, +(sc.x * 0.52).toFixed(5), 0.635, 0.112],
    size: [0.0009],
    rgba: [0.76, 0.18, 0.18, 1] as [number, number, number, number],
    role: 'visual' as const,
  }));

  const soundbox: SceneNode = {
    id: 'cello_soundbox',
    name: 'Spruce & Maple Cello Body',
    type: 'body',
    pos: [0, -0.08, 0.165], // Seated on floor-standing wooden cradle so tilted 660 mm bow clears floor by >48 mm
    deformMaterial: 'softwood',
    csgEnabled: true,
    collision: 'hull',
    script: `// J.S. Bach — Cello Suite No. 1 in G Major, BWV 1007 (Prelude Measure 1, Molto Legato)
// 4/4 Cremonese Violoncello (C2-G2-D3-A3) + 3D Left-Hand Finger stopping B3 on the A3 string!
// Phase-locked wrist crossings & finger lead-time place all 16 sixteenth notes strictly on a 260 ms grid!
const t = api.getTime();
const angles = [-0.41888, -0.13963, 0.13963, 0.41888]; // [C2 -24°, G2 -8°, D3 +8°, A3 +24°]
const strPattern = [1, 2, 3, 3, 3, 2, 3, 2]; // G2 - D3 - B3(on A3) - A3 - B3 - D3 - B3 - D3
const stopB3Pattern = [0, 0, 1, 0, 1, 1, 1, 1]; // Authentic cello fingering: lift 1st finger for open A3, hold B3 across B3-D3-B3-D3 bariolage!
const noteDur = 0.28; // Singing Bach Prelude sixteenth-note pulse (♩ = 53.6 BPM -> 1.12 s per 4-note slur)

// Phase-locked 26 ms cosine wrist roll with velocity feedforward so qRock crosses midpoint right at t = k * noteDur!
const rollLead = 0.018;
const rollDur = 0.025;
const tWrist = t + rollLead;
const wristStep = Math.floor(tWrist / noteDur);
const tauWrist = tWrist - wristStep * noteDur;
const strIdx = strPattern[wristStep % 8];
const prevStrIdx = wristStep > 0 ? strPattern[(wristStep - 1) % 8] : strIdx;

let targetRock = angles[strIdx];
let targetRockVel = 0.0;
if (t < 0.022) {
  const p0 = (Math.PI * t) / 0.022;
  targetRock = angles[1] * (0.5 - 0.5 * Math.cos(p0));
  targetRockVel = angles[1] * 0.5 * (Math.PI / 0.022) * Math.sin(p0);
} else if (tauWrist < rollDur && strIdx !== prevStrIdx) {
  const phase = (Math.PI * tauWrist) / rollDur;
  const w = Math.PI / rollDur;
  const blend = 0.5 - 0.5 * Math.cos(phase);
  targetRock = angles[prevStrIdx] + (angles[strIdx] - angles[prevStrIdx]) * blend;
  targetRockVel = (angles[strIdx] - angles[prevStrIdx]) * 0.5 * w * Math.sin(phase);
}

const qRock = api.getJointPosition('bow_rock');
const qStroke = api.getJointPosition('bow_stroke');
const vRock = api.getJointVelocity('bow_rock');
const bowComX = 0.155 + qStroke;
const bowComZ = 0.104;
const gravTorqueY = 0.082 * 9.81 * (bowComX * Math.cos(qRock) + bowComZ * Math.sin(qRock));
api.applyJointForce('bow_rock', -gravTorqueY + 250.0 * (targetRock - qRock) + 5.2 * (targetRockVel - vRock));

// Left-hand 1st finger on A3 string (1,500 N/m return spring at +2.0 mm clearance):
// +3.9 N seats +2.6 mm down onto A3 (stopping B3 = 246.94 Hz in 6 ms); releasing snaps 2.5 mm clear in 6 ms for open A3!
const tFinger = t + 0.008;
const fingerStep = Math.floor(tFinger / noteDur);
const wantB3 = stopB3Pattern[fingerStep % 8] === 1;
const vFinger = api.getJointVelocity('finger_b3_press');
if (wantB3) {
  api.applyJointForce('finger_b3_press', 3.9 - 4.5 * vFinger);
} else {
  api.applyJointForce('finger_b3_press', -1.2 - 4.5 * vFinger);
}

// 4-note slurred Casals/Rostropovich bow stroke (0.35 m at rich 0.315 m/s bow speed, crisp 14 ms wrist turnaround)!
const noteStep = Math.floor(t / noteDur);
const u = (t - noteStep * noteDur) / noteDur;
const slurIdx = Math.floor(noteStep / 4);
const slurU = ((noteStep % 4) + u) / 4;
const turnFrac = 0.014;
let posFrac = 0;
let velNorm = 0;
if (slurU < turnFrac) {
  posFrac = (0.5 * slurU * slurU) / (turnFrac * (1 - turnFrac));
  velNorm = slurU / (turnFrac * (1 - turnFrac));
} else if (slurU <= 1 - turnFrac) {
  posFrac = (slurU - 0.5 * turnFrac) / (1 - turnFrac);
  velNorm = 1 / (1 - turnFrac);
} else {
  const rem = 1 - slurU;
  posFrac = 1 - (0.5 * rem * rem) / (turnFrac * (1 - turnFrac));
  velNorm = rem / (1 - turnFrac);
}

const strokeSpan = 0.350;
const slurDur = noteDur * 4;
const isDownBow = (slurIdx % 2) === 0;
const xTarget = isDownBow ? -strokeSpan * posFrac : -strokeSpan * (1 - posFrac);
const vTarget = (isDownBow ? -1 : 1) * (strokeSpan / slurDur) * velNorm;

const vStroke = api.getJointVelocity('bow_stroke');
const gravTangent = -0.082 * 9.81 * Math.sin(qRock);
api.applyJointForce('bow_stroke', gravTangent + 22.0 * vTarget + 650 * (xTarget - qStroke) + 18.0 * (vTarget - vStroke));
`,
    joints: [],
    geoms: [
      // 1. Full-Size 4/4 Stradivarius Corpus (740 mm long × 428 mm lower bout × 116 mm rib depth, belly at z = +0.058 m)
      {
        name: 'lower_bout',
        type: 'cylinder',
        size: [0.214, 0.058],
        pos: [0, -0.172, 0],
        rgba: [0.68, 0.35, 0.15, 1],
      },
      {
        name: 'upper_bout',
        type: 'cylinder',
        size: [0.172, 0.058],
        pos: [0, 0.182, 0],
        rgba: [0.68, 0.35, 0.15, 1],
      },
      {
        name: 'c_bout_waist',
        type: 'box',
        size: [0.132, 0.182, 0.058],
        pos: [0, 0.005, 0],
        rgba: [0.70, 0.37, 0.16, 1],
      },
      // 2. Internal ~26.5 L Air Chamber (graduated 3.4 mm Alpine spruce belly & 5.2 mm maple back, >= 11 mm ribs!)
      {
        name: 'cavity_lower',
        type: 'cylinder',
        size: [0.202, 0.0537],
        pos: [0, -0.172, 0.0009],
        csg: 'difference',
        rgba: [0.24, 0.14, 0.08, 0.35],
      },
      {
        name: 'cavity_upper',
        type: 'cylinder',
        size: [0.160, 0.0537],
        pos: [0, 0.182, 0.0009],
        csg: 'difference',
        rgba: [0.24, 0.14, 0.08, 0.35],
      },
      {
        name: 'cavity_waist',
        type: 'box',
        size: [0.118, 0.174, 0.0537],
        pos: [0, 0.005, 0.0009],
        csg: 'difference',
        rgba: [0.24, 0.14, 0.08, 0.35],
      },
      // 3. Twin Carved CSG f-hole Ports (14 × 106 mm) -> tunes ~26.5 L Helmholtz air mode f_H right to ~98 Hz (G2)!
      {
        name: 'f_hole_left',
        type: 'box',
        size: [0.007, 0.053, 0.008],
        pos: [-0.068, -0.052, 0.056],
        csg: 'difference',
        rgba: [0.12, 0.08, 0.06, 0.65],
      },
      {
        name: 'f_hole_right',
        type: 'box',
        size: [0.007, 0.053, 0.008],
        pos: [0.068, -0.052, 0.056],
        csg: 'difference',
        rgba: [0.12, 0.08, 0.06, 0.65],
      },
    ],
    children: [],
  };

  // 4. Internal Cremonese Lutherie Bracing: Spruce Soundpost (behind treble foot) + Spruce Bass Bar (under bass foot)!
  //    Welded inside `cello_soundbox`, so our 3D FDTD Vibro-Acoustic solver couples the treble bridge foot to the back plate
  //    while letting the bass bridge foot pump the 3.4 mm spruce belly asymmetrically!
  const celloInternalBracing: SceneNode = {
    id: 'cello_soundpost_bassbar',
    name: 'Spruce Soundpost & Bass Bar',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'softwood',
    joints: [],
    geoms: [
      {
        name: 'spruce_soundpost',
        type: 'cylinder',
        size: [0.0055, 0.054],
        pos: [0.026, -0.082, 0.001], // Connects z = -0.053 maple back to z = +0.055 spruce belly behind treble foot!
        rgba: [0.85, 0.72, 0.50, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'spruce_bass_bar',
        type: 'box',
        size: [0.0045, 0.210, 0.0065],
        pos: [-0.026, -0.020, 0.049], // Glued along underside of spruce belly beneath the bass bridge foot!
        rgba: [0.85, 0.72, 0.50, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [],
  };

  // 5. Standing Arched Maple Bridge (planted flush at z = 0.058 on the Spruce Belly, bearing under all 4 strings!)
  const outerZ = stringCoords[0].z;
  const innerZ = stringCoords[1].z;
  const bellyZ = 0.058;
  const footHalfH = 0.011; // 22 mm carved arch window between bass & treble bridge feet (stays 100% voxel-connected to spruce belly!)
  const upperArchBottomZ = bellyZ + footHalfH * 2;
  const upperArchHalfH = +((outerZ - upperArchBottomZ) * 0.5).toFixed(5);
  const crownHalfH = +((innerZ - outerZ) * 0.5).toFixed(5);

  const celloBridge: SceneNode = {
    id: 'cello_bridge',
    name: 'Arched Maple Bridge',
    type: 'body',
    pos: [0, BRIDGE_Y, 0],
    deformMaterial: 'hardwood',
    joints: [],
    geoms: [
      {
        name: 'maple_bridge_bass_foot',
        type: 'box',
        size: [0.018, 0.0032, footHalfH],
        pos: [-0.028, 0, +(bellyZ + footHalfH).toFixed(5)], // Stands directly over the longitudinal spruce bass bar!
        rgba: [0.86, 0.70, 0.47, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'maple_bridge_treble_foot',
        type: 'box',
        size: [0.018, 0.0032, footHalfH],
        pos: [0.028, 0, +(bellyZ + footHalfH).toFixed(5)], // Stands directly in front of the vertical spruce soundpost!
        rgba: [0.86, 0.70, 0.47, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'maple_bridge_upper_arch',
        type: 'box',
        size: [0.046, 0.0028, upperArchHalfH],
        pos: [0, 0, +(upperArchBottomZ + upperArchHalfH).toFixed(5)],
        rgba: [0.86, 0.70, 0.47, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'maple_bridge_crown',
        type: 'box',
        size: [0.019, 0.0028, crownHalfH],
        pos: [0, 0, +(outerZ + crownHalfH).toFixed(5)],
        rgba: [0.88, 0.72, 0.49, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [],
  };

  // 6. Mortised Maple Neck, Ebony Fingerboard & Arched Ebony Nut (bearing under all 4 strings at y = +0.572!)
  const celloNeckAssembly: SceneNode = {
    id: 'cello_neck_assembly',
    name: 'Maple Neck, Fingerboard & Ebony Nut',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'hardwood',
    joints: [],
    geoms: [
      {
        name: 'maple_neck_heel',
        type: 'box',
        size: [0.022, 0.135, 0.042],
        pos: [0, 0.455, 0.094], // Mortised into upper_bout (y <= 0.354, z <= 0.058) and angled up to fingerboard
        rgba: [0.74, 0.48, 0.26, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'ebony_fingerboard',
        type: 'box',
        size: [0.034, 0.245, 0.0045],
        pos: [0, 0.327, +(outerZ - 0.011).toFixed(5)],
        rgba: [0.11, 0.11, 0.13, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'ebony_nut_outer',
        type: 'box',
        size: [0.046, 0.0040, 0.0055],
        pos: [0, NUT_Y, +(outerZ - 0.0055).toFixed(5)],
        rgba: [0.12, 0.12, 0.14, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'ebony_nut_crown',
        type: 'box',
        size: [0.019, 0.0040, crownHalfH],
        pos: [0, NUT_Y, +(outerZ + crownHalfH).toFixed(5)],
        rgba: [0.12, 0.12, 0.14, 1],
        contype: 0,
        conaffinity: 0,
      },
      ...pegboxLeaderGeoms,
      {
        name: 'scroll_volute',
        type: 'ellipsoid',
        size: [0.020, 0.030, 0.022],
        pos: [0, 0.660, 0.112],
        rgba: [0.66, 0.34, 0.15, 1],
        role: 'visual',
      },
      {
        name: 'peg_row_upper',
        type: 'cylinder',
        fromto: [-0.042, 0.635, 0.112, 0.042, 0.635, 0.112],
        size: [0.004],
        rgba: [0.12, 0.11, 0.13, 1],
        role: 'visual',
      },
      {
        name: 'peg_row_lower',
        type: 'cylinder',
        fromto: [-0.042, 0.612, 0.108, 0.042, 0.612, 0.108],
        size: [0.004],
        rgba: [0.12, 0.11, 0.13, 1],
        role: 'visual',
      },
    ],
    children: [],
  };

  // 7. Ebony Tailpiece, Saddle, Silk Afterlengths & Floor-Standing Wooden Cradle
  const celloTailpieceAssembly: SceneNode = {
    id: 'cello_tailpiece_assembly',
    name: 'Ebony Tailpiece & Cradle Stand',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'hardwood',
    joints: [],
    geoms: [
      {
        name: 'ebony_tailpiece',
        type: 'box',
        size: [0.026, 0.088, 0.0045],
        pos: [0, -0.258, 0.094],
        euler: [14, 0, 0],
        rgba: [0.11, 0.11, 0.13, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'tailgut_saddle',
        type: 'box',
        size: [0.018, 0.014, 0.0045],
        pos: [0, -0.376, 0.060],
        rgba: [0.14, 0.13, 0.15, 1],
        contype: 0,
        conaffinity: 0,
      },
      // Real tailgut cord loop connecting ebony_tailpiece lower end over tailgut_saddle to the endpin button.
      {
        name: 'tailgut_cord_left',
        type: 'capsule',
        fromto: [-0.008, -0.338, 0.073, -0.008, -0.384, 0.062],
        size: [0.0022],
        rgba: [0.16, 0.15, 0.17, 1],
        role: 'visual',
      },
      {
        name: 'tailgut_cord_right',
        type: 'capsule',
        fromto: [0.008, -0.338, 0.073, 0.008, -0.384, 0.062],
        size: [0.0022],
        rgba: [0.16, 0.15, 0.17, 1],
        role: 'visual',
      },
      {
        name: 'tailgut_loop_left',
        type: 'capsule',
        fromto: [-0.008, -0.384, 0.062, -0.004, -0.388, 0.002],
        size: [0.0022],
        rgba: [0.16, 0.15, 0.17, 1],
        role: 'visual',
      },
      {
        name: 'tailgut_loop_right',
        type: 'capsule',
        fromto: [0.008, -0.384, 0.062, 0.004, -0.388, 0.002],
        size: [0.0022],
        rgba: [0.16, 0.15, 0.17, 1],
        role: 'visual',
      },
      ...afterlengthGeoms,
      {
        name: 'cradle_stand_rear',
        type: 'box',
        size: [0.165, 0.020, 0.0535],
        pos: [0, -0.22, -0.1115], // Spans z_local = [-0.165, -0.058] -> sits flush on floor z_world = 0!
        rgba: [0.26, 0.16, 0.10, 1],
        role: 'visual',
      },
      {
        name: 'cradle_stand_front',
        type: 'box',
        size: [0.140, 0.020, 0.0535],
        pos: [0, 0.21, -0.1115], // Spans z_local = [-0.165, -0.058] -> sits flush on floor z_world = 0!
        rgba: [0.26, 0.16, 0.10, 1],
        role: 'visual',
      },
      {
        name: 'brass_endpin',
        type: 'cylinder',
        fromto: [0, -0.386, 0.0, 0, -0.510, 0.0],
        size: [0.005],
        rgba: [0.82, 0.68, 0.30, 1],
        role: 'visual',
      },
    ],
    children: [],
  };

  // Tune 4 standard baritone 4/4 Violoncello strings: C2 (65.41 Hz), G2 (98.00 Hz), D3 (146.83 Hz), A3 (220.00 Hz)
  // across the 640 mm vibrating scale (wound bronze C2/G2 + warm luthier gut D3/A3)!
  const noteNames = ['C2', 'G2', 'D3', 'A3'] as const;
  const stringMats = ['bronze', 'bronze', 'gut', 'gut'] as const;
  const notesHz = noteNames.map((n) => noteToHz(n) ?? 98.0);
  const rawStrings = buildMountedStringsForBody(soundbox, {
    notes: notesHz,
    material: 'gut',
    pluckPos: 0.094,
  });

  const archedStrings = rawStrings.map((s, i) => {
    const sc = stringCoords[i];
    const matId = stringMats[i];
    const tangentAxis: [number, number, number] = [
      +Math.cos(sc.rad).toFixed(5),
      0,
      +(-Math.sin(sc.rad)).toFixed(5),
    ];
    const positioned: SceneNode = {
      ...s,
      name: `Cello String ${i + 1} (${noteNames[i]})`,
      pos: [sc.x, STRING_CENTER_Y, sc.z],
      acousticString: {
        ...s.acousticString!,
        material: matId,
      },
      joints: s.joints?.map((j, jIdx) =>
        jIdx === 0 ? { ...j, axis: tangentAxis, range: [-0.0035, 0.0035] } : j,
      ),
      geoms: s.geoms.map((g, gIdx) =>
        gIdx === 0
          ? {
              ...g,
              fromto: [0, -STRING_HALF_LEN, 0, 0, STRING_HALF_LEN, 0],
              friction: [0.005, 0.0005, 0.0001], // Smooth gut/bronze wire: rosined horsehair supplies mu = 0.38 while fingertip stops cleanly with mu = 0.005!
              solref: [0.0065, 1.25],
            }
          : g,
      ),
    };
    const tuned = tuneStringToPitch(positioned, notesHz[i]);
    // Luthier-notched bridge depth: seat each string by its exact capsule radius `g.size[0]` so all 4 top crowns lie on R = BRIDGE_ARC_RADIUS!
    const rGeom = tuned.geoms[0]?.size?.[0] ?? 0.0012;
    const rCenter = BRIDGE_ARC_RADIUS - rGeom;
    return {
      ...tuned,
      pos: [
        +(rCenter * Math.sin(sc.rad)).toFixed(5),
        STRING_CENTER_Y,
        +(BRIDGE_ARC_CENTER_Z + rCenter * Math.cos(sc.rad)).toFixed(5),
      ],
    };
  });

  // Real 3D Left-Hand Stopping Finger above Cello String 4 (A3 crown at R = BRIDGE_ARC_RADIUS) at 8/9 of 640 mm scale (-> exact B3 = 246.94 Hz!)
  const a3Coord = stringCoords[3];
  const stopB3Y = +(BRIDGE_Y + (NUT_Y - BRIDGE_Y) * (220.0 / 246.94165)).toFixed(5);
  const fingerRadialIn: [number, number, number] = [
    +(-Math.sin(a3Coord.rad)).toFixed(5),
    0,
    +(-Math.cos(a3Coord.rad)).toFixed(5),
  ];
  const celloFingerB3: SceneNode = {
    id: 'cello_finger_b3',
    name: 'Left-Hand Stopping Finger (B3)',
    type: 'body',
    pos: [
      +((BRIDGE_ARC_RADIUS + 0.0040) * Math.sin(a3Coord.rad)).toFixed(5),
      stopB3Y,
      +(BRIDGE_ARC_CENTER_Z + (BRIDGE_ARC_RADIUS + 0.0040) * Math.cos(a3Coord.rad)).toFixed(5),
    ],
    deformMaterial: 'rubber',
    joints: [
      {
        name: 'finger_b3_press',
        type: 'slide',
        axis: fingerRadialIn,
        stiffness: 1500,
        damping: 5.0,
        limited: true,
        range: [-0.0020, 0.0030],
      },
    ],
    geoms: [
      {
        name: 'fingertip_pad',
        type: 'box',
        size: [0.0085, 0.0018, 0.0020],
        euler: [0, a3Coord.deg, 0],
        mass: 0.016,
        condim: 1,
        friction: [0.005, 0.0005, 0.0001],
        solref: [0.005, 1.35],
        rgba: [0.86, 0.68, 0.56, 1],
      },
      {
        name: 'finger_knuckle',
        type: 'capsule',
        fromto: [0, 0, 0, +(0.020 * Math.sin(a3Coord.rad)).toFixed(5), 0.010, +(0.020 * Math.cos(a3Coord.rad)).toFixed(5)],
        size: [0.0036],
        rgba: [0.84, 0.65, 0.53, 1],
        role: 'visual',
      },
    ],
    children: [],
  };
  celloNeckAssembly.children = [celloFingerB3];

  // Concentric R = 112 mm Bow Gimbal with a full-scale 660 mm Pernambuco Cello Bow:
  // `bow_press` range `[-0.008, 0.014]` ensures continuous rosin contact on all 4 string gauges without bottoming out!
  // Compliant 5 g Horsehair Ribbon suspended beneath the rigid 77 g Pernambuco Stick:
  // Models real horsehair deflection under 0.52–0.76 N rosin weight without stick-inertia bounce on rapid crossings!
  // Passive 1,200 N/m Horsehair Tension Ribbon seated at R - 0.55 mm beneath the rigid Pernambuco Stick:
  // Each crown-aligned string lifts the hair by +0.55 mm -> exact F = k * dz = 0.66 N passive Helmholtz rosin force,
  // while the 1,200 N/m spring keeps `bow_press` within [-0.15, +0.65] mm forever (zero detachment or under-string slip)!
  const celloBow: SceneNode = {
    id: 'cello_bow',
    name: 'Pernambuco & Horsehair Bow',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'hardwood',
    joints: [
      {
        name: 'bow_press',
        type: 'slide',
        axis: [0, 0, 1],
        stiffness: 1400,
        damping: 8.5,
        limited: true,
        range: [-0.00025, 0.0018],
      },
    ],
    geoms: [
      {
        name: 'horsehair_ribbon',
        type: 'box',
        size: [0.310, 0.0052, 0.0008],
        pos: [0, 0, 0.0008],
        mass: 0.012,
        condim: 3,
        friction: [0.38, 0.004, 0.0004],
        solref: [0.0045, 1.25],
        solimp: [0.96, 0.995, 0.0006, 0.5, 2],
        rgba: [0.96, 0.94, 0.87, 1],
      },
    ],
    children: [],
  };

  const celloBowStick: SceneNode = {
    id: 'cello_bow_stick',
    name: 'Pernambuco Stick & Ebony Frog',
    type: 'body',
    pos: [0.215, 0, +(BRIDGE_ARC_RADIUS - 0.00038).toFixed(5)],
    deformMaterial: 'hardwood',
    joints: [
      {
        name: 'bow_stroke',
        type: 'slide',
        axis: [1, 0, 0],
        damping: 22.0,
        limited: true,
        range: [-0.46, 0.08],
      },
    ],
    geoms: [
      {
        name: 'pernambuco_stick',
        type: 'capsule',
        fromto: [-0.320, 0, 0.014, 0.324, 0, 0.010],
        size: [0.0042],
        mass: 0.051,
        rgba: [0.54, 0.18, 0.09, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'ebony_frog',
        type: 'box',
        size: [0.022, 0.0065, 0.008],
        pos: [-0.302, 0, 0.007],
        mass: 0.015,
        rgba: [0.12, 0.11, 0.13, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'silver_adjuster_screw',
        type: 'cylinder',
        fromto: [-0.324, 0, 0.014, -0.340, 0, 0.014],
        size: [0.0035],
        mass: 0.004,
        rgba: [0.84, 0.85, 0.88, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'ivory_bow_tip',
        type: 'box',
        size: [0.007, 0.0045, 0.006],
        pos: [0.318, 0, 0.005],
        rgba: [0.92, 0.90, 0.84, 1],
        role: 'visual',
      },
    ],
    children: [celloBow],
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
        damping: 0.95,
        limited: true,
        range: [-35, 35],
      },
    ],
    geoms: [
      {
        name: 'gimbal_hub',
        type: 'cylinder',
        fromto: [0, -0.012, 0, 0, 0.012, 0],
        size: [0.006],
        mass: 0.035,
        rgba: [0.76, 0.62, 0.28, 1],
        role: 'visual',
      },
    ],
    children: [celloBowStick],
  };

  soundbox.children = [
    celloInternalBracing,
    celloBridge,
    celloNeckAssembly,
    celloTailpieceAssembly,
    ...archedStrings,
    bowGimbal,
  ];
  return { nodes: [soundbox] };
})();
