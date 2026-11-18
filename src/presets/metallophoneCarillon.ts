import type { SceneGraph, SceneNode } from '../types/scene';
import { tuneBodyToPitch, noteToHz } from '../utils/acousticTuning';

/**
 * Steel Glockenspiel & Carillon Automaton:
 * The metallic counterpart to the rosewood marimba — six brushed high-carbon
 * steel bars (G4, A4, C5, D5, E5, G5; Q ≈ 950 -> long, shimmering bell sustain)
 * struck by solid brass mallets driven by a silver music-box cam cylinder to
 * play "Amazing Grace" in a continuous mechanical loop!
 */
export const metallophoneCarillonPreset: SceneGraph = (() => {
  const notes = ['G4', 'A4', 'C5', 'D5', 'E5', 'G5'] as const;
  const nodes: SceneNode[] = [];

  // "Amazing Grace" in C major — 100% pure 6-bar pentatonic {0:G4, 1:A4, 2:C5, 3:D5, 4:E5, 5:G5}!
  const controllerScript = `// Silver carillon cam cylinder driving 6 brass mallets ("Amazing Grace" in strict 3/4)
const score = [
  // "A - ma - zing Grace, how sweet the sound"
  [0, 1.0], [2, 2.0], [4, 0.5], [2, 0.5], [4, 2.0], [3, 1.0], [2, 2.0], [1, 1.0], [0, 2.0],
  // "That saved a wretch like me"
  [0, 1.0], [2, 2.0], [4, 0.5], [2, 0.5], [4, 2.0], [3, 1.0], [5, 2.0],
  // "I once was lost, but now am found"
  [4, 1.0], [5, 2.0], [4, 0.5], [2, 0.5], [4, 2.0], [3, 1.0], [2, 2.0], [1, 1.0], [0, 2.0],
  // "Was blind, but now I see"
  [0, 1.0], [2, 2.0], [4, 0.5], [2, 0.5], [4, 2.0], [3, 1.0], [2, 5.0],
];
const joints = ['glock_hammer_0', 'glock_hammer_1', 'glock_hammer_2', 'glock_hammer_3', 'glock_hammer_4', 'glock_hammer_5'];
const beatSec = 0.46;
let totalDur = 0;
for (let i = 0; i < score.length; i++) totalDur += score[i][1] * beatSec;

const tLoop = api.getTime() % totalDur;
let cursor = 0;
for (let i = 0; i < score.length; i++) {
  const dur = score[i][1] * beatSec;
  const dt = tLoop - cursor;
  if (dt >= 0 && dt < 0.042) {
    api.applyJointForce(joints[score[i][0]], -2.65);
  }
  cursor += dur;
}
`;

  const pinGeoms = Array.from({ length: 16 }).map((_, k) => {
    const angle = (k / 16) * Math.PI * 2;
    const xPin = -0.13 + ((k * 5) % 6) * 0.052;
    const rDrum = 0.021;
    return {
      name: `carillon_pin_${k}`,
      type: 'sphere' as const,
      size: [0.0026],
      pos: [xPin, Math.cos(angle) * rDrum, Math.sin(angle) * rDrum],
      rgba: [0.95, 0.80, 0.28, 1],
      contype: 0,
      conaffinity: 0,
    };
  });

  // Anodized slate-steel resonator frame + silver pinned cylinder
  nodes.push({
    id: 'glock_frame',
    name: 'Anodized Glockenspiel Frame',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'softMetal',
    script: controllerScript,
    joints: [],
    geoms: [
      { name: 'glock_rail_front', type: 'box', size: [0.18, 0.007, 0.011], pos: [0, -0.048, 0.011], rgba: [0.20, 0.25, 0.34, 1] },
      { name: 'glock_rail_back', type: 'box', size: [0.18, 0.007, 0.011], pos: [0, 0.048, 0.011], rgba: [0.20, 0.25, 0.34, 1] },
      { name: 'glock_tie_l', type: 'box', size: [0.008, 0.110, 0.009], pos: [-0.175, -0.050, 0.009], rgba: [0.16, 0.20, 0.28, 1] },
      { name: 'glock_tie_r', type: 'box', size: [0.008, 0.110, 0.009], pos: [0.175, -0.050, 0.009], rgba: [0.16, 0.20, 0.28, 1] },
      { name: 'glock_mallet_rail', type: 'box', size: [0.18, 0.009, 0.030], pos: [0, -0.148, 0.030], rgba: [0.18, 0.22, 0.30, 1] },
      { name: 'glock_drum_post_l', type: 'box', size: [0.008, 0.012, 0.046], pos: [-0.175, -0.188, 0.046], rgba: [0.18, 0.22, 0.30, 1] },
      { name: 'glock_drum_post_r', type: 'box', size: [0.008, 0.012, 0.046], pos: [0.175, -0.188, 0.046], rgba: [0.18, 0.22, 0.30, 1] },
    ],
    children: [
      {
        id: 'carillon_drum',
        name: 'Silver Carillon Cylinder',
        type: 'body',
        pos: [0, -0.188, 0.080],
        deformMaterial: 'steel',
        joints: [
          {
            name: 'carillon_drum_spin',
            type: 'hinge',
            axis: [1, 0, 0],
            damping: 0.04,
            actuator: { type: 'velocity', kv: 0.8, ctrlValue: 1.1 },
          },
        ],
        geoms: [
          {
            name: 'silver_cylinder',
            type: 'cylinder',
            size: [0.019, 0.172],
            euler: [0, 90, 0],
            rgba: [0.80, 0.84, 0.90, 1],
            contype: 0,
            conaffinity: 0,
          },
          ...pinGeoms,
        ],
        children: [],
      },
    ],
  });

  // Rattan-handled brass bell mallets (wide upper range so rebound never slams an upper joint stop!)
  const makeBrassMallet = (idx: number, label: string, x: number): SceneNode => ({
    id: `glock_mallet_${idx + 1}`,
    name: `Brass Mallet (${label})`,
    type: 'body',
    pos: [x, -0.142, 0.066],
    deformMaterial: 'plastic',
    joints: [
      {
        name: `glock_hammer_${idx}`,
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 0.76,
        springref: 0.02,
        damping: 0.036,
        limited: true,
        range: [-14, 55],
        hardStop: false,
      },
    ],
    geoms: [
      {
        name: `glock_shaft_${idx}`,
        type: 'capsule',
        fromto: [0, 0.018, 0, 0, 0.140, 0],
        size: [0.002],
        density: 7800,
        solref: [0.004, 0.45],
        rgba: [0.76, 0.80, 0.86, 1],
      },
      {
        name: `brass_head_${idx}`,
        type: 'sphere',
        pos: [0, 0.142, -0.003],
        size: [0.0095],
        density: 8400,
        solref: [0.004, 0.18],
        rgba: [0.92, 0.76, 0.26, 1],
      },
    ],
    children: [],
  });

  notes.forEach((note, i) => {
    const x = -0.13 + i * 0.052;
    // 5.0 mm brushed glockenspiel flat steel stock -> compact 160–225 mm bars with generous rail clearance!
    const halfLen = 0.112 - i * 0.0065;
    const rawBar: SceneNode = {
      id: `glock_bar_${note.toLowerCase()}`,
      name: `Steel Bar (${note})`,
      type: 'body',
      pos: [x, 0, 0.034],
      deformMaterial: 'steel',
      joints: [
        {
          name: `glock_${note.toLowerCase()}_pad`,
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
          name: 'steel_bar_body',
          type: 'box',
          size: [0.016, halfLen, 0.0025],
          rgba: [0.80 + i * 0.02, 0.84 + i * 0.015, 0.91, 1],
        },
      ],
      children: [],
    };
    nodes.push(tuneBodyToPitch(rawBar, noteToHz(note) ?? 392.0).node);
    nodes.push(makeBrassMallet(i, note, x));
  });

  return { nodes };
})();
