import type { SceneGraph, SceneNode } from '../types/scene';
import { noteToHz } from '../utils/acousticTuning';
import { buildMountedStringsForBody } from '../utils/stringAcoustics';

/**
 * Acoustic Soundbox Lyre (Taut Strings + Helmholtz Cavity Resonance):
 * A hollowed spruce/mahogany soundbox (~2.5 L chamber + Ø52 mm soundhole -> f_H ≈ 122 Hz)
 * with 5 taut phosphor-bronze strings (C4, D4, E4, G4, A4), physically strummed back and
 * forth by an oscillating tortoiseshell plectrum.
 */
export const soundboxLyrePreset: SceneGraph = (() => {
  const soundbox: SceneNode = {
    id: 'lyre_soundbox',
    name: 'Spruce Soundbox',
    type: 'body',
    pos: [0, 0, 0.032],
    deformMaterial: 'softwood',
    csgEnabled: true,
    collision: 'hull',
    script: `// Gentle pendulum strum sweeping the plectrum cleanly across all 5 strings
const t = api.getTime();
const target = 0.068 + 0.068 * Math.sin(t * 2.1);
const x = api.getJointPosition('plectrum_sweep');
api.applyJointForce('plectrum_sweep', 145 * (target - x));
`,
    joints: [],
    geoms: [
      {
        name: 'outer_body',
        type: 'box',
        size: [0.08, 0.16, 0.032],
        rgba: [0.76, 0.53, 0.30, 1],
      },
      {
        name: 'air_chamber',
        type: 'box',
        size: [0.074, 0.152, 0.028],
        pos: [0, 0, 0],
        csg: 'difference',
        rgba: [0.25, 0.16, 0.10, 0.35],
      },
      {
        name: 'soundhole',
        type: 'cylinder',
        size: [0.026, 0.010],
        pos: [0, -0.015, 0.030],
        csg: 'difference',
        rgba: [0.15, 0.10, 0.08, 0.6],
      },
    ],
    children: [],
  };

  const notesHz = ['C4', 'D4', 'E4', 'G4', 'A4'].map((n) => noteToHz(n) ?? 261.63);
  const strings = buildMountedStringsForBody(soundbox, {
    notes: notesHz,
    material: 'bronze',
    pluckPos: 0.2,
  });

  // Real structural rosewood bridge & bone nut as welded child bodies planted on the spruce soundboard (z = 0.032..0.040)
  // bearing directly underneath all 5 strings (y = ±0.1312, z = 0.040) without inflating soundbox's z = 0.032 convex hull!
  const lyreBridge: SceneNode = {
    id: 'lyre_bridge',
    name: 'Rosewood Bridge Saddle',
    type: 'body',
    pos: [0, -0.131, 0],
    deformMaterial: 'hardwood',
    joints: [],
    geoms: [
      {
        name: 'bridge_saddle',
        type: 'box',
        size: [0.056, 0.003, 0.004],
        pos: [0, 0, 0.036],
        rgba: [0.28, 0.15, 0.09, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [],
  };

  const lyreNut: SceneNode = {
    id: 'lyre_nut',
    name: 'Bone Nut Saddle',
    type: 'body',
    pos: [0, 0.131, 0],
    deformMaterial: 'hardwood',
    joints: [],
    geoms: [
      {
        name: 'nut_saddle',
        type: 'box',
        size: [0.056, 0.003, 0.004],
        pos: [0, 0, 0.036],
        rgba: [0.92, 0.90, 0.84, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [],
  };

  // Position plectrum tip so its rounded hemisphere grazes the top 1.1 mm crown of the strings!
  const plectrum: SceneNode = {
    id: 'lyre_plectrum',
    name: 'Tortoiseshell Plectrum',
    type: 'body',
    pos: [-0.068, -0.065, 0.04315],
    deformMaterial: 'plastic',
    joints: [
      {
        name: 'plectrum_sweep',
        type: 'slide',
        axis: [1, 0, 0],
        damping: 2.8,
        limited: true,
        range: [-0.03, 0.16],
      },
      {
        name: 'plectrum_flex',
        type: 'slide',
        axis: [0, 0, 1],
        stiffness: 650,
        damping: 2.4,
        limited: true,
        range: [-0.0005, 0.004],
      },
    ],
    geoms: [
      {
        name: 'pick_tip',
        type: 'capsule',
        fromto: [0, 0, 0.016, 0, 0, 0],
        size: [0.0028],
        mass: 0.006,
        friction: [0.04, 0.001, 0.0001],
        solref: [0.005, 0.75],
        rgba: [0.58, 0.26, 0.12, 1],
      },
      {
        name: 'pick_arm',
        type: 'box',
        size: [0.006, 0.014, 0.003],
        pos: [0, 0, 0.020],
        mass: 0.012,
        rgba: [0.35, 0.24, 0.16, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [],
  };

  soundbox.children = [lyreBridge, lyreNut, ...strings, plectrum];
  return { nodes: [soundbox] };
})();
