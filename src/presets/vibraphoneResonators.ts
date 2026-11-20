import type { SceneGraph, SceneNode } from '../types/scene';
import { noteToHz, tuneBodyToPitch, tuneResonatorTubeToPitch } from '../utils/acousticTuning';
import { generateTubeMeshData } from '../utils/geom';

/**
 * Motorized Concert Vibraphone Automaton (`vibraphone_resonators`):
 * Showcases external standing-wave resonator tube coupling + rotating butterfly
 * tremolo fans (Starter #5) and viscoelastic pedal damper-bar muting (Starter #3):
 *   1. Six arch-tuned anodized 6061 aluminum alloy bars (`C4, D4, E4, G4, A4, C5`,
 *      `Q ≈ 780`) suspended on cord rails directly above individual open-top /
 *      closed-bottom quarter-wave (`open_closed`, λ/4) cylindrical aluminum resonator tubes.
 *   2. A continuous motor-driven stainless-steel shaft (`vibe_tremolo_shaft`) spins six
 *      golden butterfly paddles inside the resonator tube mouths at Ω = 5.5π rad/s,
 *      opening and occluding each bore twice per revolution (`f_trem = |Ω| / π = 5.5 Hz`
 *      amplitude + throat-formant shimmer!).
 *   3. Six cord-wound mallets perform jazz chords and pentatonic arpeggios, while a
 *      spring-return crimson felt pedal damper bar (`vibe_damper_bar`) lifts against the
 *      bars between harmonies to physically mute their sustain via `AUDIO_DAMPING`.
 */
export const vibraphoneResonatorsPreset: SceneGraph = (() => {
  const notes = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5'] as const;
  const barZ = 0.385;

  // 1. First tune all 6 aluminum vibraphone bars so we can size rail clearances from exact post-tuned geometry!
  const tunedBars: SceneNode[] = notes.map((note, i) => {
    const x = +(-0.140 + i * 0.056).toFixed(4);
    const initHalfLen = +(0.172 - i * 0.011).toFixed(4);
    const tubeId = `vibe_tube_${note.toLowerCase()}`;
    const rawBar: SceneNode = {
      id: `vibe_bar_${note.toLowerCase()}`,
      name: `Aluminum Vibraphone Bar (${note})`,
      type: 'body',
      pos: [x, 0, barZ],
      deformMaterial: 'softMetal',
      resonatorNodeId: tubeId,
      joints: [
        {
          name: `vibe_bar_${note.toLowerCase()}_cord`,
          type: 'slide',
          axis: [0, 0, 1],
          stiffness: 2400,
          damping: 12,
          limited: true,
          range: [-0.008, 0.008],
        },
      ],
      geoms: [
        {
          name: 'aluminum_bar_body',
          type: 'box',
          size: [0.0205, initHalfLen, 0.0045],
          rgba: [0.90 - i * 0.015, 0.78 - i * 0.01, 0.34 + i * 0.02, 1],
        },
      ],
      children: [],
    };
    const tuned = tuneBodyToPitch(rawBar, noteToHz(note) ?? 261.63).node;
    return {
      ...tuned,
      resonatorNodeId: tubeId,
    };
  });

  const maxBarHalfLen = Math.max(
    ...tunedBars.map((b) => b.geoms.find((g) => g.name === 'aluminum_bar_body')?.size[1] ?? 0.18),
  );
  const maxBarHalfThick = Math.max(
    ...tunedBars.map((b) => b.geoms.find((g) => g.name === 'aluminum_bar_body')?.size[2] ?? 0.0045),
  );
  const barBottomZ = +(barZ - maxBarHalfThick).toFixed(5); // ~0.3805 m
  const tubeMouthZ = +(barBottomZ - 0.0165).toFixed(5);   // 16.5 mm clear below bar bottoms
  const malletRailY = +(-(maxBarHalfLen + 0.038)).toFixed(4); // >= 28 mm clear in front of longest bar!

  // 2. Six Graduated Quarter-Wave (`open_closed`) Cylindrical Resonator Tubes
  const tunedTubes: SceneNode[] = notes.map((note, i) => {
    const x = +(-0.140 + i * 0.056).toFixed(4);
    const targetHz = noteToHz(note) ?? 261.63;
    const barId = `vibe_bar_${note.toLowerCase()}`;
    const initH = 0.22;
    const initMesh = generateTubeMeshData(0.019, 0.022, initH, 24);

    const untunedTube: SceneNode = {
      id: `vibe_tube_${note.toLowerCase()}`,
      name: `Resonator Tube (${note})`,
      type: 'body',
      pos: [x, 0, 0.22],
      deformMaterial: 'softMetal',
      isTube: true,
      innerRadius: 0.019,
      outerRadius: 0.022,
      height: initH,
      resonatorTube: {
        endCondition: 'open_closed',
        coupledBarNodeId: barId,
        vaneJointName: 'vibe_tremolo_shaft',
        vaneMaxOcclusion: 0.88,
      },
      joints: [],
      geoms: [
        {
          name: `tube_wall_${note.toLowerCase()}`,
          type: 'mesh',
          size: [1],
          rgba: [0.78, 0.82, 0.88, 1],
          contype: 0,
          conaffinity: 0,
          ...initMesh,
        },
        {
          name: `tube_cap_${note.toLowerCase()}`,
          type: 'cylinder',
          size: [0.022, 0.003],
          pos: [0, 0, -initH * 0.5],
          rgba: [0.55, 0.60, 0.68, 1],
          contype: 0,
          conaffinity: 0,
        },
      ],
      children: [],
    };

    const tunedTube = tuneResonatorTubeToPitch(untunedTube, targetHz, 'open_closed');
    const halfH = (tunedTube.height ?? initH) * 0.5;
    return {
      ...tunedTube,
      pos: [x, 0, +(tubeMouthZ - halfH).toFixed(5)],
      resonatorTube: {
        ...tunedTube.resonatorTube,
        endCondition: 'open_closed',
        coupledBarNodeId: barId,
        vaneJointName: 'vibe_tremolo_shaft',
        vaneMaxOcclusion: 0.88,
      },
    };
  });

  // 3. Chordal & Arpeggio Controller + Pedal Felt Damper Bar Automation
  //    Indices: 0=C4, 1=D4, 2=E4, 3=G4, 4=A4, 5=C5
  const controllerScript = `// Jazz Vibraphone Chordal & Arpeggio Score + Spring-Return Felt Damper Pedal
// Loop = 3.20 s:
//   0.06 s : 3-note C6 chord [C4, E4, A4]
//   0.44, 0.68, 0.92, 1.16 s : Shimmering pentatonic bells (G4 - C5 - A4 - G4)
//   1.42..1.96 s : Felt damper bar lifts against all 6 bars (540 ms AUDIO_DAMPING chord mute!)
//   2.02 s : 3-note Dm7/G9 voicing [D4, G4, C5]
//   2.38, 2.62, 2.86 s : Descending answer (A4 - E4 - D4)
const period = 3.20;
const tLoop = api.getTime() % period;
const joints = [
  'vibe_mallet_0', 'vibe_mallet_1', 'vibe_mallet_2',
  'vibe_mallet_3', 'vibe_mallet_4', 'vibe_mallet_5',
];

const events = [
  [0.06, [0, 2, 4], -3.1],
  [0.44, [3], -2.6],
  [0.68, [5], -2.7],
  [0.92, [4], -2.5],
  [1.16, [3], -2.4],
  [2.02, [1, 3, 5], -3.1],
  [2.38, [4], -2.6],
  [2.62, [2], -2.6],
  [2.86, [1], -2.5],
];

for (let i = 0; i < events.length; i++) {
  const dt = tLoop - events[i][0];
  if (dt >= 0 && dt < 0.040) {
    const chord = events[i][1];
    const torque = events[i][2];
    for (let k = 0; k < chord.length; k++) {
      api.applyJointForce(joints[chord[k]], torque);
    }
  }
}

// Engage the spring-return felt damper bar during [1.42, 1.96] s to mute the ringing bars
const vDamp = api.getJointVelocity('vibe_damper_slide');
const qPedal = api.getJointPosition('vibe_pedal_hinge');
const vPedal = api.getJointVelocity('vibe_pedal_hinge');
if (tLoop >= 1.42 && tLoop < 1.96) {
  api.applyJointForce('vibe_damper_slide', 36.0 - 12.0 * vDamp);
  api.applyJointForce('vibe_pedal_hinge', -0.45 - 0.12 * vPedal);
} else {
  api.applyJointForce('vibe_damper_slide', -6.0 * vDamp);
  api.applyJointForce('vibe_pedal_hinge', 0.35 - 2.2 * qPedal - 0.12 * vPedal);
}
`;

  // 4. Concert Vibraphone Frame + Continuous Motorized Butterfly Tremolo Shaft + Foot Pedal
  const butterflyVaneGeoms = notes.map((note, i) => ({
    name: `butterfly_vane_${note.toLowerCase()}`,
    type: 'cylinder' as const,
    // Flat disk in XY at q = 0 (occludes Z-axis tube mouth); edge-on at q = pi/2 (100% open!)
    size: [0.0172, 0.0009],
    pos: [+(-0.140 + i * 0.056).toFixed(4), 0, 0],
    rgba: [0.95, 0.80, 0.28, 1] as [number, number, number, number],
    contype: 0,
    conaffinity: 0,
  }));

  const vibraphoneFrame: SceneNode = {
    id: 'vibraphone_frame',
    name: 'Concert Vibraphone Frame & Motor',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'steel',
    script: controllerScript,
    joints: [],
    geoms: [
      // Bar suspension rails at y = ±0.058 m, z_top = barBottomZ - 0.0085 m (8.5 mm clear below bars!)
      {
        name: 'cord_rail_front',
        type: 'box',
        size: [0.182, 0.006, 0.009],
        pos: [0, -0.058, +(barBottomZ - 0.0175).toFixed(5)],
        rgba: [0.20, 0.23, 0.28, 1],
      },
      {
        name: 'cord_rail_back',
        type: 'box',
        size: [0.182, 0.006, 0.009],
        pos: [0, 0.058, +(barBottomZ - 0.0175).toFixed(5)],
        rgba: [0.20, 0.23, 0.28, 1],
      },
      // End cheeks & floor-standing A-frame legs
      {
        name: 'end_cheek_l',
        type: 'box',
        size: [0.008, 0.068, 0.014],
        pos: [-0.182, 0, +(barBottomZ - 0.016).toFixed(5)],
        rgba: [0.26, 0.18, 0.12, 1],
      },
      {
        name: 'end_cheek_r',
        type: 'box',
        size: [0.008, 0.068, 0.014],
        pos: [0.182, 0, +(barBottomZ - 0.016).toFixed(5)],
        rgba: [0.26, 0.18, 0.12, 1],
      },
      { name: 'leg_fl', type: 'capsule', fromto: [-0.182, -0.058, 0.012, -0.182, -0.058, +(barBottomZ - 0.028).toFixed(5)], size: [0.006], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'leg_bl', type: 'capsule', fromto: [-0.182, 0.058, 0.012, -0.182, 0.058, +(barBottomZ - 0.028).toFixed(5)], size: [0.006], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'leg_fr', type: 'capsule', fromto: [0.182, -0.058, 0.012, 0.182, -0.058, +(barBottomZ - 0.028).toFixed(5)], size: [0.006], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'leg_br', type: 'capsule', fromto: [0.182, 0.058, 0.012, 0.182, 0.058, +(barBottomZ - 0.028).toFixed(5)], size: [0.006], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'pedal_cross_stretcher', type: 'box', size: [0.186, 0.012, 0.008], pos: [0, 0, 0.008], rgba: [0.20, 0.22, 0.26, 1], contype: 0, conaffinity: 0 },
      // Electric tremolo motor housing mounted on left end-cheek
      {
        name: 'tremolo_motor_can',
        type: 'cylinder',
        size: [0.018, 0.022],
        pos: [-0.205, 0, +(tubeMouthZ - 0.005).toFixed(5)],
        euler: [0, 90, 0],
        rgba: [0.16, 0.18, 0.22, 1],
        role: 'visual',
      },
      // Front mallet rail positioned strictly clear in -Y of the longest tuned bar
      {
        name: 'vibe_mallet_rail',
        type: 'box',
        size: [0.182, 0.009, 0.012],
        pos: [0, malletRailY, +(barZ + 0.008).toFixed(4)],
        rgba: [0.20, 0.23, 0.28, 1],
      },
      {
        name: 'mallet_rail_arm_l',
        type: 'capsule',
        fromto: [-0.182, -0.058, +(barBottomZ - 0.016).toFixed(5), -0.182, malletRailY, +(barZ + 0.008).toFixed(4)],
        size: [0.005],
        rgba: [0.22, 0.25, 0.30, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'mallet_rail_arm_r',
        type: 'capsule',
        fromto: [0.182, -0.058, +(barBottomZ - 0.016).toFixed(5), 0.182, malletRailY, +(barZ + 0.008).toFixed(4)],
        size: [0.005],
        rgba: [0.22, 0.25, 0.30, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [
      {
        id: 'tremolo_motor_shaft',
        name: 'Rotating Butterfly Tremolo Fans',
        type: 'body',
        pos: [0, 0, +(tubeMouthZ - 0.005).toFixed(5)],
        deformMaterial: 'softMetal',
        joints: [
          {
            name: 'vibe_tremolo_shaft',
            type: 'hinge',
            axis: [1, 0, 0],
            damping: 0.004,
            // Ω = 5.5π rad/s ≈ 17.28 rad/s -> acoustic tremolo f_trem = |Ω| / π = 5.50 Hz!
            actuator: { type: 'velocity', kv: 2.5, ctrlValue: +(5.5 * Math.PI).toFixed(4) },
          },
        ],
        geoms: [
          {
            name: 'tremolo_drive_axle',
            type: 'cylinder',
            fromto: [-0.188, 0, 0, 0.175, 0, 0],
            size: [0.0020],
            rgba: [0.85, 0.88, 0.92, 1],
            contype: 0,
            conaffinity: 0,
          },
          {
            name: 'tremolo_belt_pulley',
            type: 'cylinder',
            size: [0.014, 0.003],
            pos: [-0.186, 0, 0],
            euler: [0, 90, 0],
            rgba: [0.90, 0.74, 0.26, 1],
            contype: 0,
            conaffinity: 0,
          },
          ...butterflyVaneGeoms,
        ],
        children: [],
      },
      {
        id: 'vibe_sustain_pedal',
        name: 'Swivel Sustain Foot Pedal',
        type: 'body',
        pos: [0, 0.010, 0.024],
        deformMaterial: 'softMetal',
        joints: [
          {
            name: 'vibe_pedal_hinge',
            type: 'hinge',
            axis: [1, 0, 0],
            stiffness: 2.2,
            damping: 0.14,
            limited: true,
            range: [-18, 18],
          },
        ],
        geoms: [
          {
            name: 'chrome_pedal_plate',
            type: 'box',
            size: [0.032, 0.068, 0.004],
            pos: [0, -0.055, 0],
            rgba: [0.82, 0.85, 0.90, 1],
            contype: 0,
            conaffinity: 0,
          },
        ],
        children: [],
      },
    ],
  };

  // 5. Spring-Return Crimson Felt Damper Bar (`y = +0.036 m`, 4.0 mm clear below bars at t = 0, 7.5 mm clear of tubes!)
  const feltDamperBar: SceneNode = {
    id: 'vibe_damper_bar',
    name: 'Spring-Return Pedal Felt Damper Bar',
    type: 'body',
    pos: [0, 0.036, +(barBottomZ - 0.009).toFixed(5)],
    deformMaterial: 'rubber',
    joints: [
      {
        name: 'vibe_damper_slide',
        type: 'slide',
        axis: [0, 0, 1],
        stiffness: 320,
        damping: 16,
        limited: true,
        range: [-0.006, 0.009],
      },
    ],
    geoms: [
      {
        name: 'damper_felt_rail',
        type: 'box',
        size: [0.165, 0.0065, 0.005], // Top face at barBottomZ - 0.004 m -> 4.0 mm clear at t = 0!
        pos: [0, 0, 0],
        density: 1150,
        // Critically damped viscoelastic felt (`st >= 0.040, sd >= 0.85`) -> pure AUDIO_DAMPING with zero clack!
        solref: [0.048, 1.0],
        friction: [0.75, 0.006, 0.0003],
        rgba: [0.78, 0.16, 0.20, 1],
      },
      {
        name: 'damper_pull_rod',
        type: 'cylinder',
        fromto: [0, 0, -0.006, 0, 0, -0.340],
        size: [0.0028],
        rgba: [0.76, 0.79, 0.84, 1],
        role: 'visual',
      },
    ],
    children: [],
  };

  // 6. Six Cord-Wound Rattan Vibraphone Mallets
  const mallets: SceneNode[] = notes.map((note, i) => {
    const x = +(-0.140 + i * 0.056).toFixed(4);
    const strikeReachY = +(Math.abs(malletRailY) - 0.042).toFixed(4); // Strikes bar at y_world = -0.042 m
    return {
      id: `vibe_mallet_${i + 1}`,
      name: `Cord-Wound Mallet (${note})`,
      type: 'body',
      pos: [x, malletRailY, +(barZ + 0.036).toFixed(4)],
      deformMaterial: 'plastic',
      joints: [
        {
          name: `vibe_mallet_${i}`,
          type: 'hinge',
          axis: [1, 0, 0],
          pos: [0, 0, 0],
          stiffness: 1.55,
          springref: 0.035,
          damping: 0.068,
          limited: true,
          range: [-12, 52],
          hardStop: false,
        },
      ],
      geoms: [
        {
          name: `rattan_shaft_${i}`,
          type: 'capsule',
          fromto: [0, 0.016, 0, 0, +(strikeReachY - 0.004).toFixed(4), 0],
          size: [0.0025],
          density: 620,
          rgba: [0.80, 0.66, 0.42, 1],
          contype: 0,
          conaffinity: 0,
        },
        {
          name: `cord_mallet_head_${i}`,
          type: 'sphere',
          pos: [0, strikeReachY, -0.002],
          size: [0.0115],
          density: 1650,
          solref: [0.0045, 0.28],
          rgba: [0.18, 0.64, 0.82, 1],
        },
      ],
      children: [],
    };
  });

  return {
    nodes: [
      vibraphoneFrame,
      ...tunedTubes,
      ...tunedBars,
      feltDamperBar,
      ...mallets,
    ],
  };
})();
