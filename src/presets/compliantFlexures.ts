import type { SceneGraph, SceneNode } from '../types/scene';
import { applyFlexureToNode } from '../utils/flexure';

/**
 * Monolithic Compliant Mechanisms Showcase:
 * Three 3D-printable PETG compliant mechanisms on one baseplate — no pins,
 * bearings, or metal springs:
 *   1. Cross-Strip Flexure Pivot (`cross_pivot` on hinge) — zero-backlash pendulum
 *   2. Bistable Von Mises Snap Toggle (`bistable` on slide) — two stable latched states
 *   3. Serpentine Guided Stage (`serpentine` on slide) — parallel linear spring stage
 */
export const compliantFlexuresPreset: SceneGraph = (() => {
  // 1. Cross-strip flexure pendulum (left, x = -0.105 m)
  const rawPivotArm: SceneNode = {
    id: 'cross_pivot_pendulum',
    name: 'Cross-Strip Pivot Arm',
    type: 'body',
    pos: [-0.105, 0, 0.095],
    deformMaterial: 'plastic',
    joints: [
      {
        name: 'cross_pivot_hinge',
        type: 'hinge',
        axis: [0, 1, 0],
        pos: [0, 0, 0],
        initialVelocity: [3],
      },
    ],
    geoms: [
      {
        // Clamp block the crossed leaves grip, just below the pivot
        name: 'arm_hub',
        type: 'box',
        size: [0.0075, 0.008, 0.0025],
        pos: [0, 0, -0.0065],
        rgba: [0.18, 0.72, 0.58, 1],
      },
      {
        name: 'arm_stem',
        type: 'box',
        size: [0.005, 0.008, 0.028],
        pos: [0, 0, -0.032],
        rgba: [0.18, 0.72, 0.58, 1],
      },
      {
        name: 'pendulum_bob',
        type: 'cylinder',
        size: [0.018, 0.009],
        pos: [0, 0, -0.062],
        euler: [90, 0, 0],
        density: 2400,
        rgba: [0.22, 0.58, 0.86, 1],
      },
    ],
    children: [],
  };
  const crossPivotNode = applyFlexureToNode(rawPivotArm, {
    kind: 'cross_pivot',
    filament: 'petg',
    thicknessMm: 0.75,
    lengthMm: 16,
    widthMm: 12,
  })!.node;

  // 2. Bistable Von Mises snap-through toggle switch (center, x = 0 m)
  const rawBistableShuttle: SceneNode = {
    id: 'bistable_toggle_shuttle',
    name: 'Bistable Snap Toggle',
    type: 'body',
    pos: [0, 0, 0.032],
    deformMaterial: 'plastic',
    joints: [
      {
        name: 'bistable_slide',
        type: 'slide',
        axis: [0, 1, 0],
        pos: [0, 0, 0],
      },
    ],
    geoms: [
      {
        name: 'shuttle_block',
        type: 'box',
        size: [0.009, 0.016, 0.010],
        pos: [0, 0, 0],
        rgba: [0.92, 0.52, 0.18, 1],
      },
      {
        name: 'toggle_knob',
        type: 'box',
        size: [0.006, 0.006, 0.012],
        pos: [0, 0, 0.018],
        rgba: [0.96, 0.68, 0.24, 1],
      },
    ],
    children: [],
  };
  const bistableNode = applyFlexureToNode(rawBistableShuttle, {
    kind: 'bistable',
    filament: 'petg',
    thicknessMm: 0.85,
    lengthMm: 20,
    widthMm: 9,
    archRiseMm: 3.2,
  })!.node;

  // 3. Serpentine guided linear stage (right, x = +0.105 m)
  const rawSerpentineStage: SceneNode = {
    id: 'serpentine_linear_stage',
    name: 'Serpentine Linear Stage',
    type: 'body',
    pos: [0.105, 0, 0.032],
    deformMaterial: 'plastic',
    joints: [
      {
        name: 'serpentine_slide',
        type: 'slide',
        axis: [0, 1, 0],
        pos: [0, 0, 0],
      },
    ],
    geoms: [
      {
        name: 'stage_table',
        type: 'box',
        size: [0.012, 0.016, 0.009],
        pos: [0, 0, 0],
        rgba: [0.22, 0.66, 0.78, 1],
      },
    ],
    children: [],
  };
  const serpentineNode = applyFlexureToNode(rawSerpentineStage, {
    kind: 'serpentine',
    filament: 'petg',
    thicknessMm: 0.8,
    lengthMm: 22,
    widthMm: 9,
    folds: 5,
  })!.node;

  // Monolithic outer frame + gentle test-bench driver script cycling the bistable & serpentine stages
  const baseFrame: SceneNode = {
    id: 'flexure_test_frame',
    name: 'Monolithic PETG Frame',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'plastic',
    script: `// Test bench: flips the bistable toggle past its snap force each way, sweeps the
// serpentine stage, and keeps the flexure pendulum ringing.
const t = api.getTime();
// Snap force of this toggle is ~9.5 N; push 1.5x that, then let go so it rests
// unassisted in each latched state (q = 0 and q = 2·h0 ≈ 6.4 mm).
const phase = t % 4.0;
let togglePush = 0;
if (phase >= 0.4 && phase < 0.9) togglePush = 14;
else if (phase >= 2.4 && phase < 2.9) togglePush = -14;
api.applyJointForce('bistable_slide', togglePush);

// Slow sinusoidal push on the guided stage (±~11 mm of its ±14 mm rated travel).
api.applyJointForce('serpentine_slide', 4 * Math.sin(t * 2.8));

// Escapement-style drive: a small torque with the swing replaces what the
// polymer's damping takes each cycle, so the pendulum keeps a steady amplitude.
const w = api.getJointVelocity('cross_pivot_hinge');
api.applyJointForce('cross_pivot_hinge', 0.006 * Math.sign(w));
`,
    joints: [],
    geoms: [
      { name: 'baseplate', type: 'box', size: [0.165, 0.055, 0.006], pos: [0, 0, 0.006], rgba: [0.24, 0.27, 0.32, 1] },
      // Pivot tower (left) and the bracket over the pivot the crossed leaves hang from
      { name: 'pivot_tower', type: 'box', size: [0.016, 0.012, 0.048], pos: [-0.105, 0.022, 0.058], rgba: [0.28, 0.32, 0.38, 1], contype: 0, conaffinity: 0 },
      { name: 'pivot_bracket', type: 'box', size: [0.0085, 0.012, 0.0025], pos: [-0.105, 0.002, 0.1032], rgba: [0.28, 0.32, 0.38, 1], contype: 0, conaffinity: 0 },
      // Bistable anchor walls (center): inner faces where the arches end, 9 + 20 mm out
      { name: 'bistable_wall_l', type: 'box', size: [0.004, 0.014, 0.016], pos: [-0.033, 0.002, 0.028], rgba: [0.28, 0.32, 0.38, 1], contype: 0, conaffinity: 0 },
      { name: 'bistable_wall_r', type: 'box', size: [0.004, 0.014, 0.016], pos: [0.033, 0.002, 0.028], rgba: [0.28, 0.32, 0.38, 1], contype: 0, conaffinity: 0 },
      // Serpentine anchor posts (right): one under each folded spring's anchor pad
      { name: 'serpentine_anchor_l', type: 'box', size: [0.003, 0.004, 0.0125], pos: [0.0644, 0.0142, 0.024], rgba: [0.28, 0.32, 0.38, 1], contype: 0, conaffinity: 0 },
      { name: 'serpentine_anchor_r', type: 'box', size: [0.003, 0.004, 0.0125], pos: [0.1456, 0.0142, 0.024], rgba: [0.28, 0.32, 0.38, 1], contype: 0, conaffinity: 0 },
    ],
    children: [crossPivotNode, bistableNode, serpentineNode],
  };

  return { nodes: [baseFrame] };
})();
