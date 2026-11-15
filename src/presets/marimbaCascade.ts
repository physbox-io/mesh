import type { SceneGraph, SceneNode } from '../types/scene';
import { tuneBodyToPitch, noteToHz } from '../utils/acousticTuning';

/**
 * Pentatonic Marimba & Chime Cascade:
 * Five rosewood marimba bars tuned via underside luthier arches to C4–D4–E4–G4–A4
 * plus a C5 steel chime rod, struck in an ascending arpeggio by rolling brass mallets.
 */
export const marimbaCascadePreset: SceneGraph = (() => {
  const notes = ['C4', 'D4', 'E4', 'G4', 'A4'] as const;
  const nodes: SceneNode[] = [];

  // Frame rails supporting the marimba bars near their 0.224·L nodal lines
  nodes.push({
    id: 'marimba_frame',
    name: 'Marimba Frame',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'softwood',
    joints: [],
    geoms: [
      { name: 'rail_front', type: 'box', size: [0.16, 0.008, 0.014], pos: [0, -0.052, 0.014], rgba: [0.36, 0.24, 0.15, 1] },
      { name: 'rail_back', type: 'box', size: [0.16, 0.008, 0.014], pos: [0, 0.052, 0.014], rgba: [0.36, 0.24, 0.15, 1] },
    ],
    children: [],
  });

  // Five tuned hardwood marimba bars (length along Y, stepped along X)
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
          stiffness: 5200,
          damping: 1.4,
          limited: true,
          range: [-0.002, 0.002],
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
    const tuned = tuneBodyToPitch(rawBar, noteToHz(note) ?? 261.63).node;
    nodes.push(tuned);

    // Staggered striker drops for a crisp pentatonic arpeggio on Play
    const dropZ = 0.085 + i * 0.055;
    nodes.push({
      id: `mallet_${i + 1}`,
      name: `Mallet ${note}`,
      type: 'body',
      pos: [x, 0, dropZ],
      deformMaterial: 'plastic',
      joints: [{ name: `mallet_${i + 1}_free`, type: 'free' }],
      geoms: [
        {
          name: 'mallet_ball',
          type: 'sphere',
          size: [0.011],
          density: 1350,
          solref: [-4200, -16],
          rgba: [0.92, 0.72, 0.22, 1],
        },
      ],
      children: [],
    });
  });

  // Final C5 tubular steel chime at the right end for bright metallic contrast
  const rawChime: SceneNode = {
    id: 'steel_chime_c5',
    name: 'Steel Chime (C5)',
    type: 'body',
    pos: [0.16, 0, 0.038],
    euler: [90, 0, 0],
    deformMaterial: 'steel',
    joints: [
      {
        name: 'chime_c5_cord',
        type: 'slide',
        axis: [0, 1, 0],
        stiffness: 6000,
        damping: 1.0,
        limited: true,
        range: [-0.002, 0.002],
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

  nodes.push({
    id: 'mallet_chime',
    name: 'Chime Striker',
    type: 'body',
    pos: [0.16, 0, 0.39],
    deformMaterial: 'steel',
    joints: [{ name: 'mallet_chime_free', type: 'free' }],
    geoms: [
      {
        name: 'striker_ball',
        type: 'sphere',
        size: [0.0095],
        density: 7800,
        solref: [-6500, -14],
        rgba: [0.85, 0.88, 0.94, 1],
      },
    ],
    children: [],
  });

  return { nodes };
})();
