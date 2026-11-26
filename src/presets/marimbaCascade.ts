import type { SceneGraph, SceneNode } from '../types/scene';
import { tuneBodyToPitch, noteToHz } from '../utils/acousticTuning';

/**
 * Animated Pentatonic Marimba & Chime Automaton:
 * A rotating brass music-box cylinder and 6 spring-returned hinged mallets play
 * Edvard Grieg's "Morning Mood" (Peer Gynt) on 5 arch-tuned rosewood marimba bars
 * (C4, D4, E4, G4, A4) and a C5 tubular steel chime!
 *
 * Every note is produced by a genuine MuJoCo rigid-body hammer-on-bar collision,
 * and both mallet heads and wooden shafts have real collision + stop limits so
 * dragging a beater cannot push it through the marimba wood.
 */
export const marimbaCascadePreset: SceneGraph = (() => {
  const notes = ['C4', 'D4', 'E4', 'G4', 'A4'] as const;
  const nodes: SceneNode[] = [];

  // Indices: 0=C4, 1=D4, 2=E4, 3=G4, 4=A4, 5=C5(chime)
  const controllerScript = `// Music-box cam escapement driving the 6 hinged mallets (Grieg — Morning Mood)
const score = [
  [3, 1.0], [2, 1.0], [1, 1.0], [0, 1.0], [1, 1.0], [2, 1.0],
  [3, 1.0], [2, 1.0], [1, 1.0], [0, 1.0], [1, 0.5], [2, 0.5], [1, 0.5], [2, 0.5],
  [3, 1.0], [2, 1.0], [3, 1.0], [4, 1.0], [2, 1.0], [4, 1.0],
  [3, 1.0], [2, 1.0], [1, 1.0], [0, 3.0], [5, 3.0],
];
const joints = ['hammer_0', 'hammer_1', 'hammer_2', 'hammer_3', 'hammer_4', 'hammer_5'];
const unitSec = 0.30;
let totalDur = 0;
for (let i = 0; i < score.length; i++) totalDur += score[i][1] * unitSec;

const tLoop = api.getTime() % totalDur;
let cursor = 0;
for (let i = 0; i < score.length; i++) {
  const dur = score[i][1] * unitSec;
  const dt = tLoop - cursor;
  if (dt >= 0 && dt < 0.024) {
    api.applyJointForce(joints[score[i][0]], -4.15);
  }
  cursor += dur;
}
`;

  const pinGeoms = Array.from({ length: 14 }).map((_, k) => {
    const angle = (k / 14) * Math.PI * 2;
    const xPin = -0.11 + ((k * 3) % 6) * 0.052;
    const rDrum = 0.022;
    return {
      name: `drum_pin_${k}`,
      type: 'sphere' as const,
      size: [0.0028],
      pos: [xPin, Math.cos(angle) * rDrum, Math.sin(angle) * rDrum],
      rgba: [0.95, 0.82, 0.32, 1],
      contype: 0,
      conaffinity: 0,
    };
  });

  nodes.push({
    id: 'marimba_frame',
    name: 'Marimba & Cam Frame',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'softwood',
    script: controllerScript,
    joints: [],
    geoms: [
      // Frame rails sit at z_top = 0.022 m (5.5 mm clear below z_bottom = 0.0275 m of the sprung bars!),
      // and mallet_rail sits at y = -0.230 m (back face y = -0.221 m, >= 15 mm clear of the 410 mm C4 bar!).
      { name: 'rail_front', type: 'box', size: [0.175, 0.008, 0.011], pos: [0.02, -0.052, 0.011], rgba: [0.36, 0.24, 0.15, 1] },
      { name: 'rail_back', type: 'box', size: [0.175, 0.008, 0.011], pos: [0.02, 0.052, 0.011], rgba: [0.36, 0.24, 0.15, 1] },
      { name: 'side_tie_l', type: 'box', size: [0.008, 0.175, 0.009], pos: [-0.155, -0.115, 0.009], rgba: [0.30, 0.20, 0.13, 1] },
      { name: 'side_tie_r', type: 'box', size: [0.008, 0.175, 0.009], pos: [0.195, -0.115, 0.009], rgba: [0.30, 0.20, 0.13, 1] },
      { name: 'mallet_rail', type: 'box', size: [0.175, 0.009, 0.032], pos: [0.02, -0.230, 0.032], rgba: [0.30, 0.20, 0.13, 1] },
      { name: 'drum_post_l', type: 'box', size: [0.008, 0.012, 0.048], pos: [-0.155, -0.270, 0.048], rgba: [0.30, 0.20, 0.13, 1] },
      { name: 'drum_post_r', type: 'box', size: [0.008, 0.012, 0.048], pos: [0.195, -0.270, 0.048], rgba: [0.30, 0.20, 0.13, 1] },
      // Felt/foam nodal suspension pads & brass pins on rail_front/rail_back supporting the 5 rosewood bars
      ...notes.flatMap((note, i) => {
        const x = -0.11 + i * 0.052;
        const tag = note.toLowerCase();
        return ([-0.052, 0.052] as const).flatMap((yRail, side) => {
          const s = side === 0 ? 'f' : 'b';
          return [
            { name: `bar_pad_${tag}_${s}`, type: 'cylinder' as const, size: [0.006, 0.0032], pos: [x, yRail, 0.0248], rgba: [0.16, 0.15, 0.16, 1], contype: 0, conaffinity: 0 },
            { name: `bar_pin_${tag}_${s}`, type: 'cylinder' as const, size: [0.0018, 0.005], pos: [x, yRail, 0.0265], rgba: [0.82, 0.68, 0.28, 1], contype: 0, conaffinity: 0 },
          ];
        });
      }),
      // Rubber suspension posts supporting the C5 tubular steel chime above rail_front/rail_back
      ...([-0.052, 0.052] as const).map((yRail, side) => ({
        name: `chime_pad_c5_${side === 0 ? 'f' : 'b'}`,
        type: 'cylinder' as const,
        size: [0.0055, 0.0048],
        pos: [0.155, yRail, 0.0262],
        rgba: [0.16, 0.15, 0.16, 1],
        contype: 0,
        conaffinity: 0,
      })),
    ],
    children: [
      {
        id: 'music_drum',
        name: 'Pinned Music Cylinder',
        type: 'body',
        pos: [0.02, -0.270, 0.082],
        deformMaterial: 'softMetal',
        joints: [
          {
            name: 'drum_spin',
            type: 'hinge',
            axis: [1, 0, 0],
            damping: 0.04,
            actuator: { type: 'velocity', kv: 0.8, ctrlValue: 1.35 },
          },
        ],
        geoms: [
          {
            name: 'brass_cylinder',
            type: 'cylinder',
            size: [0.02, 0.168],
            euler: [0, 90, 0],
            rgba: [0.85, 0.68, 0.24, 1],
            contype: 0,
            conaffinity: 0,
          },
          ...pinGeoms,
        ],
        children: [],
      },
    ],
  });

  const makeHingedMallet = (idx: number, label: string, x: number, headMat: 'plastic' | 'steel'): SceneNode => {
    const isSteel = headMat === 'steel';
    return {
      id: `mallet_${idx + 1}`,
      name: `Mallet ${label}`,
      type: 'body',
      pos: [x, -0.225, 0.070],
      deformMaterial: headMat,
      joints: [
        {
          name: `hammer_${idx}`,
          type: 'hinge',
          axis: [1, 0, 0],
          pos: [0, 0, 0],
          stiffness: isSteel ? 2.35 : 1.45,
          springref: isSteel ? 0.065 : 0.035,
          damping: 0.065,
          limited: true,
          // Stop at -7.8° prevents dragging the beater head through the 17 mm bar; 55° upper headroom avoids rebound stop-slams!
          range: [-7.8, 55],
          hardStop: false,
        },
      ],
      geoms: [
        // Colliding shaft starting 18 mm forward of the pivot rail so dragging the stick hits solid wood!
        {
          name: `shaft_${idx}`,
          type: 'capsule',
          fromto: [0, 0.018, 0, 0, isSteel ? 0.223 : 0.208, 0],
          size: [0.0025],
          density: 650,
          solref: [0.004, 0.5],
          rgba: [0.72, 0.56, 0.36, 1],
        },
        {
          name: `mallet_head_${idx}`,
          type: 'sphere',
          pos: [0, isSteel ? 0.225 : 0.210, -0.003],
          size: [isSteel ? 0.010 : 0.0115],
          density: isSteel ? 7800 : 1850,
          solref: [0.004, 0.25],
          rgba: isSteel ? [0.85, 0.88, 0.94, 1] : [0.92, 0.70, 0.22, 1],
        },
      ],
      children: [],
    };
  };

  notes.forEach((note, i) => {
    const x = -0.11 + i * 0.052;
    const halfLen = 0.118 - i * 0.008;
    const rawBar: SceneNode = {
      id: `marimba_bar_${note.toLowerCase()}`,
      name: `Rosewood Bar (${note})`,
      type: 'body',
      pos: [x, 0, 0.036],
      deformMaterial: 'hardwood',
      joints: [
        {
          name: `bar_${note.toLowerCase()}_pad`,
          type: 'slide',
          axis: [0, 0, 1],
          stiffness: 2200,
          damping: 12,
          limited: true,
          range: [-0.012, 0.012],
        },
      ],
      geoms: [
        {
          name: 'bar_body',
          type: 'box',
          size: [0.019, halfLen, 0.0085],
          rgba: [0.58 - i * 0.03, 0.25 + i * 0.02, 0.14, 1],
        },
      ],
      children: [],
    };
    nodes.push(tuneBodyToPitch(rawBar, noteToHz(note) ?? 261.63).node);
    nodes.push(makeHingedMallet(i, note, x, 'plastic'));
  });

  const rawChime: SceneNode = {
    id: 'steel_chime_c5',
    name: 'Steel Chime (C5)',
    type: 'body',
    pos: [0.155, 0, 0.038],
    euler: [90, 0, 0],
    deformMaterial: 'steel',
    joints: [
      {
        name: 'chime_c5_cord',
        type: 'slide',
        axis: [0, 1, 0],
        stiffness: 1800,
        damping: 11,
        limited: true,
        range: [-0.012, 0.012],
      },
    ],
    geoms: [
      {
        name: 'chime_rod',
        type: 'cylinder',
        size: [0.008, 0.11],
        rgba: [0.78, 0.83, 0.9, 1],
      },
    ],
    children: [],
  };
  nodes.push(tuneBodyToPitch(rawChime, noteToHz('C5') ?? 523.25).node);
  nodes.push(makeHingedMallet(5, 'C5', 0.155, 'steel'));

  return { nodes };
})();
