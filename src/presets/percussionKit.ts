import type { SceneGraph, SceneNode } from '../types/scene';
import { noteToHz, tuneMembraneToPitch } from '../utils/acousticTuning';

/**
 * Orchestral & Studio Percussion Kit Automaton (`percussion_kit`):
 * Showcases 2D Bessel membrane acoustics (`acousticMembrane`), von Kármán nonlinear
 * thin-plate crash cascade (`nonlinearPlate`), and viscoelastic contact choking (`AUDIO_DAMPING`):
 *   1. Left (`x = -0.380 m`): Parabolic copper kettle timpani (`timpani_kettle` + `timpani_head`
 *      tuned to F3 = 174.61 Hz), where enclosed kettle air coupling shifts circular Bessel
 *      azimuthal modes into harmonic 1 : 1.50 : 1.99 intervals.
 *   2. Center (`x = 0.000 m`): Authentic 14"×5.5" dual-head vented maple concert snare drum
 *      (`snare_batter_head` + `snare_resonant_head` around ~182 Hz) with near-center backbeat
 *      excitation, downward tension pitch-glide (~222 Hz -> 182 Hz), and crisp snare-wire buzz.
 *   3. Right (`x = +0.390 m`): Suspended Ø350 mm thin B20 bronze crash cymbal (`nonlinearPlate`
 *      50–250 ms upward energy cascade & ~3.6–4.8 s metallic shimmer), paired with a motorized
 *      crimson felt damper arm (`cymbal_choke_arm`) that clamps down ~0.49 s mid-shimmer in Bar 1
 *      and stays lifted in Bar 2 so both choked and unchoked crash sustains are showcased!
 */
export const percussionKitPreset: SceneGraph = (() => {
  const controllerScript = `// 2-Bar (4.00 s) orchestral & studio groove showcasing BOTH mid-ring felt choke & full unchoked crash!
// Bar 1 (0.00..2.00 s) — Crash -> 0.49 s loud bronze shimmer -> crisp viscoelastic felt choke:
//   t = 0.06 s : Timpani F3 downbeat
//   t = 0.28 s : Snare center backbeat crack (~222 -> 182 Hz punch + crisp wire buzz)
//   t = 0.50 s : Big Ø350 mm B20 Crash Cymbal strike (t_strike ≈ 0.515 s) + Timpani accent
//   t = 0.96..1.55 s : Felt choke arm clamps onto ringing cymbal at t_choke ≈ 1.005 s (dt ≈ 0.49 s!)
//   t = 1.04 s, 1.52 s, 1.66 s : Snare groove + Timpani turnaround at 1.78 s
// Bar 2 (2.00..4.00 s) — Full unchoked Crash Cymbal sustain alongside snare & timpani groove:
//   t = 2.06 s : Unchoked B20 Crash Cymbal + Timpani F3 (rings freely across Bar 2!)
const period = 4.00;
const tLoop = api.getTime() % period;

const timpHits = [0.06, 0.50, 1.78, 2.06, 2.78, 3.78];
for (let i = 0; i < timpHits.length; i++) {
  const dt = tLoop - timpHits[i];
  if (dt >= 0 && dt < 0.042) {
    api.applyJointForce('timpani_mallet_hinge', -3.6);
  }
}

const snareHits = [
  [0.28, -4.2],
  [1.04, -4.5],
  [1.52, -3.2],
  [1.66, -3.9],
  [2.52, -4.3],
  [3.04, -4.5],
  [3.52, -3.4],
  [3.66, -4.1],
];
for (let i = 0; i < snareHits.length; i++) {
  const dt = tLoop - snareHits[i][0];
  if (dt >= 0 && dt < 0.022) {
    api.applyJointForce('snare_stick_hinge', snareHits[i][1]);
  }
}

// Strong crash strikes: Bar 1 at t = 0.50 s (choked 0.49 s later!) and Bar 2 at t = 2.06 s (unchoked!)
const crashHits = [0.50, 2.06];
for (let i = 0; i < crashHits.length; i++) {
  const dt = tLoop - crashHits[i];
  if (dt >= 0 && dt < 0.044) {
    api.applyJointForce('cymbal_mallet_hinge', -5.4);
  }
}

// Clamp crimson felt damper arm onto the loudly shimmering crash cymbal ~0.49 s after Bar 1 crash,
// hold for ~0.53 s to mute completely via viscoelastic AUDIO_DAMPING, then lift clear before Bar 2!
const qChoke = api.getJointPosition('cymbal_choke_hinge');
const vChoke = api.getJointVelocity('cymbal_choke_hinge');
if (tLoop >= 0.90 && tLoop < 1.55) {
  api.applyJointForce('cymbal_choke_hinge', 1.08 - 0.18 * vChoke);
} else {
  api.applyJointForce('cymbal_choke_hinge', -2.4 * qChoke - 0.18 * vChoke);
}
`;

  // 1. Enclosed Parabolic Spun-Copper Kettle Timpani (`x = -0.380, y = 0.035`, tuned to F3 = 174.61 Hz)
  const timpaniKettle: SceneNode = {
    id: 'timpani_kettle',
    name: 'Parabolic Copper Kettle',
    type: 'body',
    pos: [-0.380, 0.035, 0.124],
    deformMaterial: 'softMetal',
    density: 8900,
    csgEnabled: true,
    collision: 'hull',
    joints: [],
    geoms: [
      {
        name: 'kettle_copper_bowl',
        type: 'cylinder',
        size: [0.162, 0.118],
        pos: [0, 0, 0], // Top lip at z_world = 0.242 m (10 mm clear below timpani_head at 0.252 m)
        rgba: [0.78, 0.43, 0.22, 1],
      },
      {
        name: 'kettle_cavity_inner',
        type: 'cylinder',
        size: [0.155, 0.118],
        pos: [0, 0, 0.008],
        csg: 'difference',
        rgba: [0.35, 0.18, 0.10, 0.4],
      },
      {
        name: 'kettle_counterhoop',
        type: 'cylinder',
        size: [0.167, 0.005],
        pos: [0, 0, 0.122],
        rgba: [0.84, 0.70, 0.32, 1],
        role: 'visual',
      },
      {
        name: 'kettle_base_ring',
        type: 'cylinder',
        size: [0.108, 0.006],
        pos: [0, 0, -0.118],
        rgba: [0.22, 0.24, 0.28, 1],
        role: 'visual',
      },
      ...[0, 120, 240].map((deg, idx) => {
        const rad = (deg * Math.PI) / 180;
        const rx = +(0.164 * Math.cos(rad)).toFixed(4);
        const ry = +(0.164 * Math.sin(rad)).toFixed(4);
        const bx = +(0.112 * Math.cos(rad)).toFixed(4);
        const by = +(0.112 * Math.sin(rad)).toFixed(4);
        return {
          name: `kettle_strut_${idx + 1}`,
          type: 'capsule' as const,
          fromto: [rx, ry, 0.110, bx, by, -0.118],
          size: [0.0045],
          rgba: [0.28, 0.30, 0.35, 1],
          role: 'visual' as const,
        };
      }),
    ],
    children: [],
  };

  const rawTimpaniHead: SceneNode = {
    id: 'timpani_head',
    name: 'Timpani Head (F3)',
    type: 'body',
    pos: [-0.380, 0.035, 0.252],
    deformMaterial: 'plastic',
    acousticMembrane: {
      material: 'mylar',
      tensionNPerM: 2200,
      thicknessMm: 0.19,
      shape: 'circular',
      shellNodeId: 'timpani_kettle',
      kettleCoupling: 1.0,
      nonlinearGlide: 0.85,
    },
    joints: [
      {
        name: 'timpani_head_pad',
        type: 'slide',
        axis: [0, 0, 1],
        stiffness: 3400,
        damping: 18,
        limited: true,
        range: [-0.005, 0.005],
      },
    ],
    geoms: [
      {
        name: 'timpani_membrane_disk',
        type: 'cylinder',
        size: [0.158, 0.0012],
        density: 1390,
        solref: [0.004, 0.35],
        rgba: [0.91, 0.85, 0.72, 0.94],
      },
    ],
    children: [],
  };
  const timpaniHead = tuneMembraneToPitch(
    rawTimpaniHead,
    noteToHz('F3') ?? 174.61,
    [timpaniKettle, rawTimpaniHead],
  );

  // 2. Authentic 14"×5.5" Dual-Head Vented Maple Concert Snare Drum (`x = 0.000, y = 0.035`)
  const snareShell: SceneNode = {
    id: 'snare_shell',
    name: 'Vented Maple Snare Shell',
    type: 'body',
    pos: [0.0, 0.035, 0.170],
    deformMaterial: 'hardwood',
    csgEnabled: true,
    collision: 'hull',
    joints: [],
    geoms: [
      {
        name: 'snare_maple_wall',
        type: 'cylinder',
        size: [0.181, 0.056], // Spans z_world = [0.114, 0.226] m (10 mm clear of both 14" heads!)
        pos: [0, 0, 0],
        rgba: [0.68, 0.34, 0.16, 1],
      },
      {
        name: 'snare_shell_bore',
        type: 'cylinder',
        size: [0.173, 0.062],
        pos: [0, 0, 0],
        csg: 'difference',
        rgba: [0.32, 0.18, 0.10, 0.4],
      },
      {
        name: 'snare_air_vent',
        type: 'cylinder',
        size: [0.006, 0.018],
        pos: [0, -0.177, 0],
        euler: [90, 0, 0],
        csg: 'difference',
        rgba: [0.15, 0.15, 0.18, 0.6],
      },
      {
        name: 'snare_top_hoop',
        type: 'cylinder',
        size: [0.185, 0.004],
        pos: [0, 0, 0.064],
        rgba: [0.82, 0.85, 0.90, 1],
        role: 'visual',
      },
      {
        name: 'snare_bottom_hoop',
        type: 'cylinder',
        size: [0.185, 0.004],
        pos: [0, 0, -0.064],
        rgba: [0.82, 0.85, 0.90, 1],
        role: 'visual',
      },
      {
        name: 'snare_stand_pedestal',
        type: 'cylinder',
        fromto: [0, 0, -0.072, 0, 0, -0.164],
        size: [0.009],
        rgba: [0.72, 0.75, 0.80, 1],
        role: 'visual',
      },
      ...[30, 150, 270].map((deg, idx) => {
        const rad = (deg * Math.PI) / 180;
        return {
          name: `snare_stand_leg_${idx + 1}`,
          type: 'capsule' as const,
          fromto: [0, 0, -0.122, +(0.125 * Math.cos(rad)).toFixed(4), +(0.125 * Math.sin(rad)).toFixed(4), -0.165],
          size: [0.005],
          rgba: [0.68, 0.71, 0.76, 1],
          role: 'visual' as const,
        };
      }),
    ],
    children: [],
  };

  const rawSnareBatter: SceneNode = {
    id: 'snare_batter_head',
    name: 'Coated Snare Batter Head',
    type: 'body',
    pos: [0.0, 0.035, 0.236],
    deformMaterial: 'plastic',
    acousticMembrane: {
      material: 'coated_film',
      tensionNPerM: 4200,
      thicknessMm: 0.28,
      shape: 'circular',
      shellNodeId: 'snare_shell',
      snareBuzz: 0.82,
      pitchGlideSemitones: 3.4,
      pitchGlideDecayMs: 48,
      nonlinearGlide: 1.12,
    },
    joints: [
      {
        name: 'snare_batter_pad',
        type: 'slide',
        axis: [0, 0, 1],
        stiffness: 4600,
        damping: 24,
        limited: true,
        range: [-0.005, 0.005],
      },
    ],
    geoms: [
      {
        name: 'snare_batter_disk',
        type: 'cylinder',
        size: [0.178, 0.0012], // 14" (Ø356 mm) coated concert snare batter head
        density: 1520,
        solref: [0.0035, 0.30],
        rgba: [0.95, 0.94, 0.90, 0.98],
      },
    ],
    children: [],
  };

  const snareWireCapsules = [-0.018, -0.011, -0.004, 0.004, 0.011, 0.018].map((wx, idx) => ({
    name: `snare_wire_strand_${idx + 1}`,
    type: 'capsule' as const,
    fromto: [wx, -0.160, -0.0022, wx, 0.160, -0.0022],
    size: [0.0009],
    rgba: [0.84, 0.86, 0.92, 1] as [number, number, number, number],
    role: 'visual' as const,
  }));

  const rawSnareReso: SceneNode = {
    id: 'snare_resonant_head',
    name: 'Snare-Side Resonant Head & Wires',
    type: 'body',
    pos: [0.0, 0.035, 0.104],
    deformMaterial: 'plastic',
    acousticMembrane: {
      material: 'mylar',
      tensionNPerM: 2100,
      thicknessMm: 0.10,
      shape: 'circular',
      shellNodeId: 'snare_shell',
      snareBuzz: 0.92,
      pitchGlideSemitones: 1.1,
      pitchGlideDecayMs: 45,
    },
    joints: [
      {
        name: 'snare_reso_pad',
        type: 'slide',
        axis: [0, 0, 1],
        stiffness: 3800,
        damping: 20,
        limited: true,
        range: [-0.004, 0.004],
      },
    ],
    geoms: [
      {
        name: 'snare_reso_disk',
        type: 'cylinder',
        size: [0.178, 0.0009],
        density: 1390,
        solref: [0.0035, 0.30],
        rgba: [0.90, 0.93, 0.97, 0.85],
      },
      ...snareWireCapsules,
    ],
    children: [],
  };

  const snareBatterHead = tuneMembraneToPitch(
    rawSnareBatter,
    182.0,
    [snareShell, rawSnareBatter, rawSnareReso],
  );
  const snareResonantHead = tuneMembraneToPitch(
    rawSnareReso,
    192.0,
    [snareShell, snareBatterHead, rawSnareReso],
  );

  // 3. Suspended Ø340 mm Thin B20 Bronze Crash Cymbal (`x = +0.390, y = 0.035`)
  const crashCymbal: SceneNode = {
    id: 'crash_cymbal',
    name: 'Thin B20 Bronze Crash Cymbal',
    type: 'body',
    pos: [0.390, 0.035, 0.268],
    deformMaterial: 'softMetal',
    density: 8600,
    nonlinearPlate: {
      enabled: true,
      crashSensitivity: 1.55,
      bloomDelayMs: 95,
      shimmerMix: 0.85,
      archRatio: 0.16,
    },
    joints: [
      {
        name: 'cymbal_tilt',
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 5.4,
        damping: 0.18,
        limited: true,
        range: [-15, 15],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'cymbal_bow_disk',
        type: 'cylinder',
        size: [0.170, 0.00068], // Ø340 mm × 1.36 mm paper-thin spun B20 bronze crash cymbal (~1.06 kg)
        density: 8600,
        solref: [0.004, 0.22],
        rgba: [0.88, 0.72, 0.28, 1],
      },
      {
        name: 'cymbal_cup_bell',
        type: 'cylinder',
        size: [0.036, 0.0065],
        pos: [0, 0, 0.006],
        rgba: [0.93, 0.78, 0.34, 1],
        role: 'visual',
      },
    ],
    children: [],
  };

  // 4. Hinged Crimson Felt Choke Damper Arm (`cymbal_choke_arm`, `deformMaterial: 'rubber'`)
  //    Hinge lies on the cymbal top plane (`z = 0.2693 m`) while the pad rests 38 mm clear above
  //    `crash_cymbal` at t = 0 (zero accidental recoil contact, and purely vertical v_tangent -> 0
  //    when clamping down at t ≈ 1.005 s, ~0.49 s after the Bar 1 crash strike!).
  const cymbalChokeArm: SceneNode = {
    id: 'cymbal_choke_arm',
    name: 'Felt Cymbal Choke Damper',
    type: 'body',
    pos: [0.390, 0.225, 0.2693],
    deformMaterial: 'rubber',
    joints: [
      {
        name: 'cymbal_choke_hinge',
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 1.25,
        damping: 0.15,
        limited: true,
        range: [-12, 30],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'choke_lever_rod',
        type: 'capsule',
        fromto: [0, -0.010, 0.004, 0, -0.106, 0.046],
        size: [0.0032],
        density: 2700,
        rgba: [0.35, 0.38, 0.44, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'choke_felt_pad',
        type: 'box',
        size: [0.026, 0.020, 0.006],
        pos: [0, -0.108, 0.044], // Bottom at z_world = 0.3073 m (38.0 mm clear above cymbal z = 0.2693 m!)
        euler: [-20, 0, 0], // Parallel to cymbal surface when clamped at q ≈ +20° (+0.35 rad)
        density: 1150,
        // Soft critically damped felt pad (`st >= 0.040, sd >= 0.85`): suppresses impact clack while maximizing AUDIO_DAMPING!
        solref: [0.048, 1.0],
        friction: [0.85, 0.006, 0.0003],
        rgba: [0.78, 0.16, 0.20, 1],
      },
    ],
    children: [],
  };

  // 5. Front Mallet Rail (`y = -0.255 m`, >= 95 mm clear of all drums/cymbals) & Cymbal Boom Stand
  const percussionFrame: SceneNode = {
    id: 'percussion_rig_frame',
    name: 'Percussion Rack & Cymbal Boom',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'steel',
    script: controllerScript,
    joints: [],
    geoms: [
      { name: 'rack_crossbar', type: 'box', size: [0.435, 0.010, 0.010], pos: [0, -0.255, 0.242], rgba: [0.20, 0.23, 0.28, 1] },
      { name: 'rack_post_l', type: 'box', size: [0.012, 0.012, 0.126], pos: [-0.425, -0.255, 0.126], rgba: [0.18, 0.20, 0.25, 1] },
      { name: 'rack_post_r', type: 'box', size: [0.012, 0.012, 0.126], pos: [0.425, -0.255, 0.126], rgba: [0.18, 0.20, 0.25, 1] },
      { name: 'rack_foot_l', type: 'box', size: [0.034, 0.048, 0.006], pos: [-0.425, -0.255, 0.006], rgba: [0.15, 0.17, 0.21, 1] },
      { name: 'rack_foot_r', type: 'box', size: [0.034, 0.048, 0.006], pos: [0.425, -0.255, 0.006], rgba: [0.15, 0.17, 0.21, 1] },
      // Rear cymbal boom stand at (0.390, 0.235) supporting both `crash_cymbal` center spindle and `cymbal_choke_arm`
      { name: 'cymbal_boom_post', type: 'cylinder', fromto: [0.390, 0.235, 0.008, 0.390, 0.235, 0.325], size: [0.0085], rgba: [0.72, 0.75, 0.80, 1], contype: 0, conaffinity: 0 },
      { name: 'cymbal_boom_base', type: 'cylinder', size: [0.085, 0.006], pos: [0.390, 0.235, 0.006], rgba: [0.20, 0.22, 0.26, 1], role: 'visual' },
      { name: 'cymbal_boom_arm', type: 'cylinder', fromto: [0.390, 0.235, 0.322, 0.390, 0.035, 0.322], size: [0.0055], rgba: [0.76, 0.79, 0.84, 1], contype: 0, conaffinity: 0 },
      { name: 'cymbal_spindle_pin', type: 'cylinder', fromto: [0.390, 0.035, 0.322, 0.390, 0.035, 0.248], size: [0.004], rgba: [0.80, 0.82, 0.86, 1], contype: 0, conaffinity: 0 },
    ],
    children: [],
  };

  // 6. Three Hinged Mallets (all resting >= 16 mm clear above heads/cymbal at t = 0)
  const timpaniMallet: SceneNode = {
    id: 'timpani_mallet',
    name: 'Wool-Felt Timpani Mallet',
    type: 'body',
    pos: [-0.380, -0.255, 0.286],
    deformMaterial: 'plastic',
    joints: [
      {
        name: 'timpani_mallet_hinge',
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 1.65,
        springref: 0.04,
        damping: 0.075,
        limited: true,
        range: [-18, 48],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'timpani_shaft',
        type: 'capsule',
        fromto: [0, 0.018, 0, 0, 0.192, 0],
        size: [0.003],
        density: 680,
        rgba: [0.74, 0.56, 0.35, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'timpani_felt_head',
        type: 'sphere',
        pos: [0, 0.197, -0.002], // Strikes timpani at y ≈ -0.058 m (radial spot r = 0.093 m = 0.59 R!)
        size: [0.0145],
        density: 1350,
        solref: [0.0055, 0.35],
        rgba: [0.95, 0.93, 0.88, 1],
      },
    ],
    children: [],
  };

  const snareStick: SceneNode = {
    id: 'snare_drumstick',
    name: 'Hickory Concert Drumstick',
    type: 'body',
    pos: [0.0, -0.255, 0.270],
    deformMaterial: 'hardwood',
    joints: [
      {
        name: 'snare_stick_hinge',
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 2.10,
        springref: 0.04,
        damping: 0.072,
        limited: true,
        range: [-14, 48],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'hickory_shaft',
        type: 'capsule',
        fromto: [0, 0.018, 0, 0, 0.268, 0],
        size: [0.0032],
        density: 820,
        rgba: [0.82, 0.67, 0.44, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'hickory_acorn_tip',
        type: 'sphere',
        pos: [0, 0.272, -0.002], // Strikes 14" snare batter head near center (y ≈ +0.017 m, r/a ≈ 0.10!)
        size: [0.009],
        density: 1450,
        solref: [0.0032, 0.28],
        rgba: [0.86, 0.72, 0.48, 1],
      },
    ],
    children: [],
  };

  const cymbalMallet: SceneNode = {
    id: 'cymbal_crash_mallet',
    name: 'Heavy Yarn & Brass Cymbal Mallet',
    type: 'body',
    pos: [0.390, -0.255, 0.304],
    deformMaterial: 'softMetal',
    joints: [
      {
        name: 'cymbal_mallet_hinge',
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 1.85,
        springref: 0.04,
        damping: 0.078,
        limited: true,
        range: [-16, 52],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'cymbal_mallet_shaft',
        type: 'capsule',
        fromto: [0, 0.018, 0, 0, 0.176, 0],
        size: [0.0028],
        density: 750,
        rgba: [0.68, 0.50, 0.30, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'cymbal_mallet_head',
        type: 'sphere',
        pos: [0, 0.180, -0.002], // Strikes front bow of Ø350 mm crash cymbal at y ≈ -0.075 m (r = 0.63 R)
        size: [0.012],
        density: 4600,
        solref: [0.004, 0.22],
        rgba: [0.88, 0.66, 0.22, 1],
      },
    ],
    children: [],
  };

  return {
    nodes: [
      percussionFrame,
      timpaniKettle,
      timpaniHead,
      snareShell,
      snareBatterHead,
      snareResonantHead,
      crashCymbal,
      cymbalChokeArm,
      timpaniMallet,
      snareStick,
      cymbalMallet,
    ],
  };
})();
