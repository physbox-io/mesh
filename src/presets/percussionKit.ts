import type { SceneGraph, SceneNode } from '../types/scene';
import { noteToHz, tuneMembraneToPitch } from '../utils/acousticTuning';

/**
 * Orchestral & Studio Percussion Kit Automaton (`percussion_kit`):
 * Showcases 2D Bessel membrane acoustics (`acousticMembrane`), von Kármán nonlinear
 * thin-plate crash cascade (`nonlinearPlate`), and viscoelastic contact choking (`AUDIO_DAMPING`):
 *   1. Left (`x = -0.265 m`): Parabolic copper kettle timpani (`timpani_kettle` + `timpani_head`
 *      tuned to C3 = 130.81 Hz), where enclosed kettle air coupling shifts circular Bessel
 *      azimuthal modes into harmonic 1 : 1.50 : 1.99 intervals.
 *   2. Center (`x = 0.000 m`): Dual-head maple concert snare drum (`snare_batter_head` +
 *      `snare_resonant_head`) with hard-strike tension pitch-glide and sympathetic snare-wire buzz.
 *   3. Right (`x = +0.265 m`): Suspended Ø260 mm thin B20 bronze crash cymbal (`nonlinearPlate`
 *      50–250 ms upward energy cascade & metallic shimmer), paired with a motorized crimson felt
 *      damper arm (`cymbal_choke_arm`) that drops onto the ringing cymbal bow to physically choke it!
 */
export const percussionKitPreset: SceneGraph = (() => {
  const controllerScript = `// Stereo drum-corps & orchestral groove + physical felt cymbal choke!
// Loop period = 2.00 s:
//   t = 0.06 s : Timpani C3 + Big B20 Crash Cymbal strike (lets von Karman shimmer bloom!)
//   t = 0.52 s : Snare backbeat crack (pitch-glide + snare rattle)
//   t = 0.78 s : Timpani syncopated stroke
//   t = 0.96..1.56 s : Felt choke arm presses onto Crash Cymbal bow (600 ms AUDIO_DAMPING mute!)
//   t = 1.04 s : Snare accent
//   t = 1.50 s, 1.64 s : Snare double-stroke pickup + Timpani turnaround at 1.78 s
const period = 2.00;
const tLoop = api.getTime() % period;

const timpHits = [0.06, 0.78, 1.78];
for (let i = 0; i < timpHits.length; i++) {
  const dt = tLoop - timpHits[i];
  if (dt >= 0 && dt < 0.044) {
    api.applyJointForce('timpani_mallet_hinge', -3.6);
  }
}

const snareHits = [
  [0.52, -3.4],
  [1.04, -3.8],
  [1.50, -2.5],
  [1.64, -3.2],
];
for (let i = 0; i < snareHits.length; i++) {
  const dt = tLoop - snareHits[i][0];
  if (dt >= 0 && dt < 0.038) {
    api.applyJointForce('snare_stick_hinge', snareHits[i][1]);
  }
}

// Strong crash strike at t = 0.06 s to drive von Karman plate deflection well past linear threshold
if (tLoop >= 0.06 && tLoop < 0.108) {
  api.applyJointForce('cymbal_mallet_hinge', -4.8);
}

// Lower the crimson felt damper arm onto the ringing crash cymbal from t = 0.96 s to 1.56 s
const qChoke = api.getJointPosition('cymbal_choke_hinge');
const vChoke = api.getJointVelocity('cymbal_choke_hinge');
if (tLoop >= 0.96 && tLoop < 1.56) {
  api.applyJointForce('cymbal_choke_hinge', 0.62 - 0.16 * vChoke);
} else {
  api.applyJointForce('cymbal_choke_hinge', -1.8 * qChoke - 0.14 * vChoke);
}
`;

  // 1. Enclosed Parabolic Spun-Copper Kettle Timpani (`x = -0.275, y = 0.03`, tuned to F3 = 174.61 Hz)
  const timpaniKettle: SceneNode = {
    id: 'timpani_kettle',
    name: 'Parabolic Copper Kettle',
    type: 'body',
    pos: [-0.275, 0.03, 0.124],
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
    pos: [-0.275, 0.03, 0.252],
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

  // 2. Dual-Head Vented Maple Concert Snare Drum (`x = 0.000, y = 0.03`)
  const snareShell: SceneNode = {
    id: 'snare_shell',
    name: 'Vented Maple Snare Shell',
    type: 'body',
    pos: [0.0, 0.03, 0.160],
    deformMaterial: 'hardwood',
    csgEnabled: true,
    collision: 'hull',
    joints: [],
    geoms: [
      {
        name: 'snare_maple_wall',
        type: 'cylinder',
        size: [0.112, 0.046], // Spans z_world = [0.114, 0.206] m (9 mm clear of both heads!)
        pos: [0, 0, 0],
        rgba: [0.68, 0.34, 0.16, 1],
      },
      {
        name: 'snare_shell_bore',
        type: 'cylinder',
        size: [0.105, 0.050],
        pos: [0, 0, 0],
        csg: 'difference',
        rgba: [0.32, 0.18, 0.10, 0.4],
      },
      {
        name: 'snare_air_vent',
        type: 'cylinder',
        size: [0.006, 0.018],
        pos: [0, -0.108, 0],
        euler: [90, 0, 0],
        csg: 'difference',
        rgba: [0.15, 0.15, 0.18, 0.6],
      },
      {
        name: 'snare_top_hoop',
        type: 'cylinder',
        size: [0.116, 0.004],
        pos: [0, 0, 0.052],
        rgba: [0.82, 0.85, 0.90, 1],
        role: 'visual',
      },
      {
        name: 'snare_bottom_hoop',
        type: 'cylinder',
        size: [0.116, 0.004],
        pos: [0, 0, -0.052],
        rgba: [0.82, 0.85, 0.90, 1],
        role: 'visual',
      },
      {
        name: 'snare_stand_pedestal',
        type: 'cylinder',
        fromto: [0, 0, -0.060, 0, 0, -0.154],
        size: [0.008],
        rgba: [0.72, 0.75, 0.80, 1],
        role: 'visual',
      },
      ...[30, 150, 270].map((deg, idx) => {
        const rad = (deg * Math.PI) / 180;
        return {
          name: `snare_stand_leg_${idx + 1}`,
          type: 'capsule' as const,
          fromto: [0, 0, -0.115, +(0.095 * Math.cos(rad)).toFixed(4), +(0.095 * Math.sin(rad)).toFixed(4), -0.155],
          size: [0.0045],
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
    pos: [0.0, 0.03, 0.215],
    deformMaterial: 'plastic',
    acousticMembrane: {
      material: 'coated_film',
      tensionNPerM: 3600,
      thicknessMm: 0.25,
      shape: 'circular',
      shellNodeId: 'snare_shell',
      snareBuzz: 0.85,
      pitchGlideSemitones: 1.8,
      pitchGlideDecayMs: 65,
      nonlinearGlide: 1.15,
    },
    joints: [
      {
        name: 'snare_batter_pad',
        type: 'slide',
        axis: [0, 0, 1],
        stiffness: 4400,
        damping: 22,
        limited: true,
        range: [-0.005, 0.005],
      },
    ],
    geoms: [
      {
        name: 'snare_batter_disk',
        type: 'cylinder',
        size: [0.109, 0.0012],
        density: 1520,
        solref: [0.0035, 0.30],
        rgba: [0.95, 0.94, 0.90, 0.98],
      },
    ],
    children: [],
  };
  const snareBatterHead = tuneMembraneToPitch(
    rawSnareBatter,
    noteToHz('G3') ?? 196.0,
    [snareShell, rawSnareBatter],
  );

  const snareWireCapsules = [-0.015, -0.009, -0.003, 0.003, 0.009, 0.015].map((wx, idx) => ({
    name: `snare_wire_strand_${idx + 1}`,
    type: 'capsule' as const,
    fromto: [wx, -0.098, -0.0022, wx, 0.098, -0.0022],
    size: [0.0009],
    rgba: [0.84, 0.86, 0.92, 1] as [number, number, number, number],
    role: 'visual' as const,
  }));

  const snareResonantHead: SceneNode = {
    id: 'snare_resonant_head',
    name: 'Snare-Side Resonant Head & Wires',
    type: 'body',
    pos: [0.0, 0.03, 0.105],
    deformMaterial: 'plastic',
    acousticMembrane: {
      material: 'mylar',
      tensionNPerM: 2900,
      thicknessMm: 0.12,
      shape: 'circular',
      shellNodeId: 'snare_shell',
      snareBuzz: 0.92,
      pitchGlideSemitones: 0.9,
      pitchGlideDecayMs: 55,
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
        size: [0.109, 0.0010],
        density: 1390,
        solref: [0.0035, 0.30],
        rgba: [0.90, 0.93, 0.97, 0.85],
      },
      ...snareWireCapsules,
    ],
    children: [],
  };

  // 3. Suspended Thin B20 Bronze Crash Cymbal / Gong (`x = +0.265, y = 0.03`)
  const crashCymbal: SceneNode = {
    id: 'crash_cymbal',
    name: 'Thin B20 Bronze Crash Cymbal',
    type: 'body',
    pos: [0.265, 0.03, 0.265],
    deformMaterial: 'softMetal',
    density: 8600,
    nonlinearPlate: {
      enabled: true,
      crashSensitivity: 1.75,
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
        stiffness: 3.4,
        damping: 0.09,
        limited: true,
        range: [-18, 18],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'cymbal_bow_disk',
        type: 'cylinder',
        size: [0.130, 0.0009], // Ø260 mm × 1.8 mm spun B20 bronze plate
        density: 8600,
        solref: [0.004, 0.22],
        rgba: [0.88, 0.72, 0.28, 1],
      },
      {
        name: 'cymbal_cup_bell',
        type: 'cylinder',
        size: [0.030, 0.0055],
        pos: [0, 0, 0.005],
        rgba: [0.93, 0.78, 0.34, 1],
        role: 'visual',
      },
    ],
    children: [],
  };

  // 4. Hinged Crimson Felt Choke Damper Arm (`cymbal_choke_arm`, `deformMaterial: 'rubber'`)
  //    Rests 14.1 mm clear above `crash_cymbal` at t = 0, then drops onto the ringing cymbal
  //    from t = 0.96..1.56 s so MuJoCo contact emits viscoelastic `AUDIO_DAMPING`!
  const cymbalChokeArm: SceneNode = {
    id: 'cymbal_choke_arm',
    name: 'Felt Cymbal Choke Damper',
    type: 'body',
    pos: [0.265, 0.185, 0.292],
    deformMaterial: 'rubber',
    joints: [
      {
        name: 'cymbal_choke_hinge',
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 1.5,
        damping: 0.12,
        limited: true,
        range: [-15, 26],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'choke_lever_rod',
        type: 'capsule',
        fromto: [0, -0.012, 0, 0, -0.080, 0],
        size: [0.003],
        density: 2700,
        rgba: [0.35, 0.38, 0.44, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'choke_felt_pad',
        type: 'box',
        size: [0.024, 0.018, 0.006],
        pos: [0, -0.080, -0.006], // Bottom at z_world = 0.280 m (14.1 mm clear above cymbal z = 0.2659 m!)
        density: 1150,
        // Soft critically damped felt pad (`st >= 0.040, sd >= 0.85`): suppresses impact clack while maximizing AUDIO_DAMPING!
        solref: [0.048, 1.0],
        friction: [0.75, 0.006, 0.0003],
        rgba: [0.78, 0.16, 0.20, 1],
      },
    ],
    children: [],
  };

  // 5. Front Mallet Rail (`y = -0.215 m`, >= 110 mm clear of all drums/cymbals) & Cymbal Boom Stand
  const percussionFrame: SceneNode = {
    id: 'percussion_rig_frame',
    name: 'Percussion Rack & Cymbal Boom',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'steel',
    script: controllerScript,
    joints: [],
    geoms: [
      { name: 'rack_crossbar', type: 'box', size: [0.310, 0.010, 0.010], pos: [0, -0.215, 0.232], rgba: [0.20, 0.23, 0.28, 1] },
      { name: 'rack_post_l', type: 'box', size: [0.012, 0.012, 0.121], pos: [-0.305, -0.215, 0.121], rgba: [0.18, 0.20, 0.25, 1] },
      { name: 'rack_post_r', type: 'box', size: [0.012, 0.012, 0.121], pos: [0.305, -0.215, 0.121], rgba: [0.18, 0.20, 0.25, 1] },
      { name: 'rack_foot_l', type: 'box', size: [0.032, 0.045, 0.006], pos: [-0.305, -0.215, 0.006], rgba: [0.15, 0.17, 0.21, 1] },
      { name: 'rack_foot_r', type: 'box', size: [0.032, 0.045, 0.006], pos: [0.305, -0.215, 0.006], rgba: [0.15, 0.17, 0.21, 1] },
      // Rear cymbal boom stand at (0.265, 0.195) supporting both `crash_cymbal` center spindle and `cymbal_choke_arm`
      { name: 'cymbal_boom_post', type: 'cylinder', fromto: [0.265, 0.195, 0.008, 0.265, 0.195, 0.315], size: [0.008], rgba: [0.72, 0.75, 0.80, 1], contype: 0, conaffinity: 0 },
      { name: 'cymbal_boom_base', type: 'cylinder', size: [0.075, 0.006], pos: [0.265, 0.195, 0.006], rgba: [0.20, 0.22, 0.26, 1], role: 'visual' },
      { name: 'cymbal_boom_arm', type: 'cylinder', fromto: [0.265, 0.195, 0.312, 0.265, 0.03, 0.312], size: [0.0055], rgba: [0.76, 0.79, 0.84, 1], contype: 0, conaffinity: 0 },
      { name: 'cymbal_spindle_pin', type: 'cylinder', fromto: [0.265, 0.03, 0.312, 0.265, 0.03, 0.245], size: [0.004], rgba: [0.80, 0.82, 0.86, 1], contype: 0, conaffinity: 0 },
    ],
    children: [],
  };

  // 6. Three Hinged Mallets (all resting >= 17 mm clear above heads/cymbal at t = 0)
  const timpaniMallet: SceneNode = {
    id: 'timpani_mallet',
    name: 'Wool-Felt Timpani Mallet',
    type: 'body',
    pos: [-0.275, -0.215, 0.286],
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
        fromto: [0, 0.018, 0, 0, 0.148, 0],
        size: [0.003],
        density: 680,
        rgba: [0.74, 0.56, 0.35, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'timpani_felt_head',
        type: 'sphere',
        pos: [0, 0.152, -0.002], // Strikes timpani at y = -0.063 m (radial spot r = 0.093 m = 0.59 R!)
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
    pos: [0.0, -0.215, 0.250],
    deformMaterial: 'hardwood',
    joints: [
      {
        name: 'snare_stick_hinge',
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 1.85,
        springref: 0.035,
        damping: 0.068,
        limited: true,
        range: [-14, 48],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'hickory_shaft',
        type: 'capsule',
        fromto: [0, 0.018, 0, 0, 0.222, 0],
        size: [0.0032],
        density: 820,
        rgba: [0.82, 0.67, 0.44, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'hickory_acorn_tip',
        type: 'sphere',
        pos: [0, 0.225, -0.002], // Strikes snare batter head at y = +0.010 m
        size: [0.009],
        density: 1450,
        solref: [0.0035, 0.28],
        rgba: [0.86, 0.72, 0.48, 1],
      },
    ],
    children: [],
  };

  const cymbalMallet: SceneNode = {
    id: 'cymbal_crash_mallet',
    name: 'Heavy Yarn & Brass Cymbal Mallet',
    type: 'body',
    pos: [0.265, -0.215, 0.298],
    deformMaterial: 'softMetal',
    joints: [
      {
        name: 'cymbal_mallet_hinge',
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 1.75,
        springref: 0.04,
        damping: 0.075,
        limited: true,
        range: [-16, 52],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: 'cymbal_mallet_shaft',
        type: 'capsule',
        fromto: [0, 0.018, 0, 0, 0.156, 0],
        size: [0.0028],
        density: 750,
        rgba: [0.68, 0.50, 0.30, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'cymbal_mallet_head',
        type: 'sphere',
        pos: [0, 0.160, -0.002], // Strikes front bow of crash cymbal at y = -0.055 m (r = 0.65 R)
        size: [0.012],
        density: 4200,
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
