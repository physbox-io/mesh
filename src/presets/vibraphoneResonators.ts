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
 *   3. Six cord-wound mallets with piano-style let-off escapement perform jazz chords and
 *      pentatonic arpeggios, while a spring-return crimson felt pedal damper bar
 *      (`vibe_damper_bar`) lifts cleanly to kiss the undersides of all 6 bars between
 *      harmonies (`~2 N/bar`) to physically mute their sustain via `AUDIO_DAMPING`.
 */
export const vibraphoneResonatorsPreset: SceneGraph = (() => {
  const notes = ['C4', 'D4', 'E4', 'G4', 'A4', 'C5'] as const;
  const barZ = 0.385;
  const barHalfThick = 0.0055; // 11.0 mm concert 6061-T6 aluminum bar thickness
  const barCordStiffness = 3200;

  // 1. First tune all 6 aluminum vibraphone bars so we can size rail clearances from exact post-tuned geometry!
  //    `collision: 'primitives'` keeps the exact analytical box collider in MuJoCo both before and after
  //    OpenSCAD boolean arch evaluation while rendering the carved underside luthier arch in the 3D viewport.
  const tunedBars: SceneNode[] = notes.map((note, i) => {
    const x = +(-0.140 + i * 0.056).toFixed(4);
    const initHalfLen = +(0.188 - i * 0.012).toFixed(4);
    const tubeId = `vibe_tube_${note.toLowerCase()}`;
    const rawBar: SceneNode = {
      id: `vibe_bar_${note.toLowerCase()}`,
      name: `Aluminum Vibraphone Bar (${note})`,
      type: 'body',
      pos: [x, 0, barZ],
      deformMaterial: 'softMetal',
      collision: 'primitives',
      resonatorNodeId: tubeId,
      joints: [
        {
          name: `vibe_bar_${note.toLowerCase()}_cord`,
          type: 'slide',
          axis: [0, 0, 1],
          stiffness: barCordStiffness,
          damping: 14,
          limited: true,
          range: [-0.0035, 0.0035],
          hardStop: true,
        },
      ],
      geoms: [
        {
          name: 'aluminum_bar_body',
          type: 'box',
          size: [0.0205, initHalfLen, barHalfThick],
          density: 2700,
          solref: [0.004, 0.85],
          rgba: [0.90 - i * 0.015, 0.78 - i * 0.01, 0.34 + i * 0.02, 1],
        },
      ],
      children: [],
    };
    const tuned = tuneBodyToPitch(rawBar, noteToHz(note) ?? 261.63).node;
    const tunedBox = tuned.geoms.find((g) => g.name === 'aluminum_bar_body');
    const sx = tunedBox?.size[0] ?? 0.0205;
    const sy = tunedBox?.size[1] ?? initHalfLen;
    const sz = tunedBox?.size[2] ?? barHalfThick;
    const barMassKg = 8 * sx * sy * sz * 2700;
    // Preload cord springref so q = 0 is exact static gravity equilibrium across all 6 bar lengths!
    const cordSpringRef = +((barMassKg * 9.81) / barCordStiffness).toFixed(6);

    return {
      ...tuned,
      collision: 'primitives',
      resonatorNodeId: tubeId,
      joints: (tuned.joints ?? []).map((j) =>
        j.name === `vibe_bar_${note.toLowerCase()}_cord`
          ? { ...j, springref: cordSpringRef, hardStop: true }
          : j,
      ),
    };
  });

  const maxBarHalfLen = Math.max(
    ...tunedBars.map((b) => b.geoms.find((g) => g.name === 'aluminum_bar_body')?.size[1] ?? 0.19),
  );
  const maxBarHalfThick = Math.max(
    ...tunedBars.map((b) => b.geoms.find((g) => g.name === 'aluminum_bar_body')?.size[2] ?? barHalfThick),
  );
  const barTopZ = +(barZ + maxBarHalfThick).toFixed(5);    // 0.3905 m
  const barBottomZ = +(barZ - maxBarHalfThick).toFixed(5); // 0.3795 m
  const tubeMouthZ = +(barBottomZ - 0.0165).toFixed(5);    // 16.5 mm clear below bar bottoms
  const malletRailY = +(-(maxBarHalfLen + 0.038)).toFixed(4); // >= 28 mm clear in front of longest bar!
  const strikeReachY = +(Math.abs(malletRailY) - 0.042).toFixed(4); // Strikes bar at y_world = -0.042 m

  // Mallet strike geometry:
  // Pivot sits at z = barTopZ + 0.030 m; sphere head (r = 11.5 mm) sits at z_local = -0.0025 m,
  // so at q = 0 head bottom is +16.0 mm above barTopZ. Touch occurs at q_touch = -asin(0.0160 / strikeReachY).
  const headRadius = 0.0115;
  const headLocalZ = -0.0025;
  const pivotAboveTopZ = 0.030;
  const restHeadClearanceM = pivotAboveTopZ + headLocalZ - headRadius; // 0.0160 m above barTopZ at q = 0
  const touchAngleRad = -Math.asin(restHeadClearanceM / strikeReachY);
  // Let-off escapement cuts drive torque ~3.0 mm above barTopZ so the final approach & rebound are 100% ballistic!
  const letOffAngleRad = +(touchAngleRad + 0.015).toFixed(4);
  // Mechanical hard stop sits 1.2 mm below resting barTopZ (normal strikes hit solid aluminum first; blocks pass-through under heavy drag!)
  const minMalletDeg = +((-Math.asin((restHeadClearanceM + 0.0012) / strikeReachY) * 180) / Math.PI).toFixed(2);

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
          dynamic: true,
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
//   1.42..1.96 s : Felt damper bar lifts gently (~2.1 N/bar) against all 6 bars (540 ms AUDIO_DAMPING mute!)
//   2.02 s : 3-note Dm7/G9 voicing [D4, G4, C5]
//   2.38, 2.62, 2.86 s : Descending answer (A4 - E4 - D4)
const period = 3.20;
const tLoop = api.getTime() % period;
const joints = [
  'vibe_mallet_0', 'vibe_mallet_1', 'vibe_mallet_2',
  'vibe_mallet_3', 'vibe_mallet_4', 'vibe_mallet_5',
];
const letOffRad = ${letOffAngleRad};

const events = [
  [0.06, [0, 2, 4], -0.92],
  [0.44, [3], -0.82],
  [0.68, [5], -0.85],
  [0.92, [4], -0.80],
  [1.16, [3], -0.78],
  [2.02, [1, 3, 5], -0.92],
  [2.38, [4], -0.82],
  [2.62, [2], -0.82],
  [2.86, [1], -0.80],
];

for (let i = 0; i < events.length; i++) {
  const dt = tLoop - events[i][0];
  if (dt >= 0 && dt < 0.024) {
    const chord = events[i][1];
    const torque = events[i][2];
    for (let k = 0; k < chord.length; k++) {
      const jName = joints[chord[k]];
      const q = api.getJointPosition(jName);
      const v = api.getJointVelocity(jName);
      // True let-off escapement: accelerate downward only above letOffRad before rebound
      // so the mallet strikes ballistically and bounces off the aluminum bar freely!
      if (q > letOffRad && !(dt > 0.008 && v > 0.15)) {
        api.applyJointForce(jName, torque);
      }
    }
  }
}

// Engage the spring-return felt damper bar during [1.42, 1.96] s (~2.1 N normal force per bar)
const qDamp = api.getJointPosition('vibe_damper_slide');
const vDamp = api.getJointVelocity('vibe_damper_slide');
const qPedal = api.getJointPosition('vibe_pedal_hinge');
const vPedal = api.getJointVelocity('vibe_pedal_hinge');
if (tLoop >= 1.42 && tLoop < 1.96) {
  const ramp = Math.min(1.0, (tLoop - 1.42) / 0.045);
  api.applyJointForce('vibe_damper_slide', 14.5 * ramp - 14.0 * vDamp);
  api.applyJointForce('vibe_pedal_hinge', -0.45 * ramp - 0.12 * vPedal);
} else {
  const retractAssist = qDamp > 0.0002 ? -3.5 : 0.0;
  api.applyJointForce('vibe_damper_slide', retractAssist - 8.0 * vDamp);
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
      { name: 'leg_fl', type: 'capsule', fromto: [-0.182, -0.058, 0.006, -0.182, -0.058, +(barBottomZ - 0.028).toFixed(5)], size: [0.006], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'leg_bl', type: 'capsule', fromto: [-0.182, 0.058, 0.006, -0.182, 0.058, +(barBottomZ - 0.028).toFixed(5)], size: [0.006], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'leg_fr', type: 'capsule', fromto: [0.182, -0.058, 0.006, 0.182, -0.058, +(barBottomZ - 0.028).toFixed(5)], size: [0.006], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'leg_br', type: 'capsule', fromto: [0.182, 0.058, 0.006, 0.182, 0.058, +(barBottomZ - 0.028).toFixed(5)], size: [0.006], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      // Lower side stretchers tying front/back legs together and anchoring pedal_cross_stretcher
      { name: 'lower_stretcher_l', type: 'box', size: [0.008, 0.062, 0.008], pos: [-0.182, 0, 0.008], rgba: [0.20, 0.22, 0.26, 1], contype: 0, conaffinity: 0 },
      { name: 'lower_stretcher_r', type: 'box', size: [0.008, 0.062, 0.008], pos: [0.182, 0, 0.008], rgba: [0.20, 0.22, 0.26, 1], contype: 0, conaffinity: 0 },
      { name: 'pedal_cross_stretcher', type: 'box', size: [0.186, 0.012, 0.008], pos: [0, 0, 0.008], rgba: [0.20, 0.22, 0.26, 1], contype: 0, conaffinity: 0 },
      // Sustain pedal clevis hinge brackets & axle pin mounted on pedal_cross_stretcher
      { name: 'pedal_hinge_bracket_l', type: 'box', size: [0.004, 0.008, 0.009], pos: [-0.026, 0.010, 0.021], rgba: [0.26, 0.28, 0.33, 1], contype: 0, conaffinity: 0 },
      { name: 'pedal_hinge_bracket_r', type: 'box', size: [0.004, 0.008, 0.009], pos: [0.026, 0.010, 0.021], rgba: [0.26, 0.28, 0.33, 1], contype: 0, conaffinity: 0 },
      { name: 'pedal_hinge_pin', type: 'cylinder', fromto: [-0.032, 0.010, 0.024, 0.032, 0.010, 0.024], size: [0.0028], rgba: [0.80, 0.83, 0.88, 1], contype: 0, conaffinity: 0 },
      // Braided suspension cords, rubber posts, and brass nodal pins supporting all 6 aluminum bars
      { name: 'cord_string_front', type: 'capsule', fromto: [-0.182, -0.058, +(barBottomZ - 0.001).toFixed(5), 0.182, -0.058, +(barBottomZ - 0.001).toFixed(5)], size: [0.0018], rgba: [0.86, 0.84, 0.78, 1], contype: 0, conaffinity: 0 },
      { name: 'cord_string_back', type: 'capsule', fromto: [-0.182, 0.058, +(barBottomZ - 0.001).toFixed(5), 0.182, 0.058, +(barBottomZ - 0.001).toFixed(5)], size: [0.0018], rgba: [0.86, 0.84, 0.78, 1], contype: 0, conaffinity: 0 },
      ...notes.flatMap((note, i) => {
        const x = +(-0.140 + i * 0.056).toFixed(4);
        const tag = note.toLowerCase();
        return ([-0.058, 0.058] as const).flatMap((yRail, side) => {
          const s = side === 0 ? 'f' : 'b';
          return [
            { name: `vibe_cord_post_${tag}_${s}`, type: 'cylinder' as const, size: [0.0048, 0.0048], pos: [x, yRail, +(barBottomZ - 0.00425).toFixed(5)], rgba: [0.14, 0.15, 0.17, 1], contype: 0, conaffinity: 0 },
            { name: `vibe_cord_pin_${tag}_${s}`, type: 'cylinder' as const, size: [0.0018, 0.006], pos: [x, yRail, +(barBottomZ - 0.003).toFixed(5)], rgba: [0.85, 0.72, 0.28, 1], contype: 0, conaffinity: 0 },
          ];
        });
      }),
      // Resonator rack rails, end ties, and tube clamp collars attaching all 6 resonator tubes to the frame
      { name: 'resonator_rack_front', type: 'box', size: [0.182, 0.004, 0.006], pos: [0, -0.0235, +(tubeMouthZ - 0.045).toFixed(5)], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'resonator_rack_back', type: 'box', size: [0.182, 0.004, 0.006], pos: [0, 0.0235, +(tubeMouthZ - 0.045).toFixed(5)], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'resonator_rack_tie_l', type: 'box', size: [0.006, 0.058, 0.006], pos: [-0.182, 0, +(tubeMouthZ - 0.045).toFixed(5)], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      { name: 'resonator_rack_tie_r', type: 'box', size: [0.006, 0.058, 0.006], pos: [0.182, 0, +(tubeMouthZ - 0.045).toFixed(5)], rgba: [0.22, 0.25, 0.30, 1], contype: 0, conaffinity: 0 },
      ...notes.map((note, i) => ({
        name: `resonator_clamp_${note.toLowerCase()}`,
        type: 'cylinder' as const,
        size: [0.024, 0.005],
        pos: [+(-0.140 + i * 0.056).toFixed(4), 0, +(tubeMouthZ - 0.045).toFixed(5)],
        rgba: [0.24, 0.27, 0.33, 1],
        contype: 0,
        conaffinity: 0,
      })),
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
            hardStop: true,
          },
        ],
        geoms: [
          {
            name: 'pedal_hinge_knuckle',
            type: 'cylinder',
            fromto: [-0.021, 0, 0, 0.021, 0, 0],
            size: [0.005],
            rgba: [0.26, 0.28, 0.33, 1],
            contype: 0,
            conaffinity: 0,
          },
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

  // 5. Spring-Return Crimson Felt Damper Bar (`y = +0.036 m`, 4.0 mm clear below bars at t = 0, 7.0 mm clear of tubes in Y!)
  const damperHalfSizes: [number, number, number] = [0.168, 0.007, 0.0055];
  const damperDensity = 1150;
  const damperStiffness = 260;
  const damperMassKg = 8 * damperHalfSizes[0] * damperHalfSizes[1] * damperHalfSizes[2] * damperDensity;
  const damperSpringRef = +((damperMassKg * 9.81) / damperStiffness).toFixed(6);

  const feltDamperBar: SceneNode = {
    id: 'vibe_damper_bar',
    name: 'Spring-Return Pedal Felt Damper Bar',
    type: 'body',
    pos: [0, 0.036, +(barBottomZ - 0.0095).toFixed(5)],
    deformMaterial: 'rubber',
    joints: [
      {
        name: 'vibe_damper_slide',
        type: 'slide',
        axis: [0, 0, 1],
        stiffness: damperStiffness,
        springref: damperSpringRef,
        damping: 16,
        limited: true,
        range: [-0.002, 0.0052],
        hardStop: true,
      },
    ],
    geoms: [
      {
        name: 'damper_felt_rail',
        type: 'box',
        size: damperHalfSizes, // Top face at barBottomZ - 0.004 m -> 4.0 mm clear at t = 0!
        pos: [0, 0, 0],
        density: damperDensity,
        // Crisp positive critically-damped felt (`solref: [0.005, 1.0]`, rubber softness) -> zero tunneling & pure AUDIO_DAMPING!
        solref: [0.005, 1.0],
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
    return {
      id: `vibe_mallet_${i + 1}`,
      name: `Cord-Wound Mallet (${note})`,
      type: 'body',
      pos: [x, malletRailY, +(barTopZ + pivotAboveTopZ).toFixed(4)],
      deformMaterial: 'plastic',
      joints: [
        {
          name: `vibe_mallet_${i}`,
          type: 'hinge',
          axis: [1, 0, 0],
          pos: [0, 0, 0],
          stiffness: 1.85,
          springref: 5.5,
          damping: 0.055,
          limited: true,
          range: [minMalletDeg, 45],
          hardStop: true,
        },
      ],
      geoms: [
        {
          name: `rattan_shaft_${i}`,
          type: 'capsule',
          fromto: [0, 0.020, 0, 0, +(strikeReachY - 0.012).toFixed(4), 0],
          size: [0.0025],
          density: 620,
          solref: [0.004, 0.5],
          rgba: [0.80, 0.66, 0.42, 1],
        },
        {
          name: `cord_mallet_head_${i}`,
          type: 'sphere',
          pos: [0, strikeReachY, headLocalZ],
          size: [headRadius],
          density: 1650,
          solref: [0.004, 0.28],
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
