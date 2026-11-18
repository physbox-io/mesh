import type { SceneGraph } from '../types/scene';

/**
 * Whoopee Cushion & 4-Lobe Cam Stomper ("The Flatulophone"):
 * Proves 100% generic aero-elastic & 3D bore physics on a short (110 mm) compliant
 * rubber spout whose quarter-wave formant (~740 Hz) sits far above the floppy rubber
 * lip's 24–220 Hz relaxation slap rate — producing authentic wet motorboat rips,
 * staccato machine-gun sputters, and rising-pitch squeakers!
 */
export const whoopeeStomperPreset: SceneGraph = {
  nodes: [
    {
      id: 'flatulophone_base',
      name: 'Cast-Iron Stomper Frame',
      type: 'body',
      pos: [0, 0, 0],
      deformMaterial: 'softMetal',
      script: `// 4-Lobe Cam Escapement: lifts the 1.5 kg Brass Stomper & drops/presses it onto the Whoopee Bladder!
// Between cam lobes you can also grab the red knob with your mouse and stomp it manually.
const theta = api.getJointPosition('cam_spin');
const phase = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
const sector = Math.floor((phase / (Math.PI * 2)) * 4); // 0..3: 4 distinct fart profiles
const u = ((phase / (Math.PI * 2)) * 4) % 1;

const qBoot = api.getJointPosition('boot_drop');
const vBoot = api.getJointVelocity('boot_drop');

if (u < 0.30) {
  // Cam lift ramp: hoist the brass plunger up to this lobe's drop height
  const targetH = sector === 0 ? 0.078 : sector === 1 ? 0.058 : sector === 2 ? 0.042 : 0.032;
  const fLift = 420 * (targetH - qBoot) - 24 * vBoot;
  if (fLift > 0) api.applyJointForce('boot_drop', fLift);
} else if (sector === 0 && u >= 0.30 && u < 0.72) {
  // Lobe 0 ("The Morning Ripper"): heavy sustained stomp follow-through!
  api.applyJointForce('boot_drop', -34);
} else if (sector === 1 && u >= 0.32 && u < 0.82) {
  // Lobe 1 ("The Wet Machine-Gun"): 4 rapid staccato cam-ratchet bounces!
  const pulse = Math.sin((u - 0.32) * Math.PI * 2 * 5.0);
  api.applyJointForce('boot_drop', pulse > 0.05 ? -38 : 22);
} else if (sector === 2 && u >= 0.32 && u < 0.90) {
  // Lobe 2 ("The Slow Cheek-Squeaker"): relentless squeeze flattening the rubber neck tight!
  const prog = (u - 0.32) / 0.58;
  api.applyJointForce('boot_drop', -18 - 48 * prog);
} else if (sector === 3 && u >= 0.32 && u < 0.52) {
  // Lobe 3 ("The Shy Wet Toot"): quick crisp tap!
  api.applyJointForce('boot_drop', -24);
}
`,
      joints: [],
      geoms: [
        { name: 'iron_baseplate', type: 'box', size: [0.23, 0.14, 0.012], pos: [-0.02, 0, 0.012], rgba: [0.18, 0.21, 0.27, 1] },
        { name: 'stanchion_front', type: 'box', size: [0.012, 0.012, 0.136], pos: [-0.19, -0.082, 0.148], rgba: [0.22, 0.26, 0.33, 1] },
        { name: 'stanchion_back', type: 'box', size: [0.012, 0.012, 0.136], pos: [-0.19, 0.082, 0.148], rgba: [0.22, 0.26, 0.33, 1] },
        { name: 'gantry_yoke', type: 'box', size: [0.078, 0.022, 0.012], pos: [-0.125, 0, 0.272], rgba: [0.24, 0.28, 0.36, 1], contype: 0, conaffinity: 0 },
        { name: 'cushion_lower_shell', type: 'ellipsoid', size: [0.085, 0.085, 0.018], pos: [-0.08, 0, 0.042], rgba: [0.90, 0.40, 0.50, 1], contype: 0, conaffinity: 0 },
        { name: 'nozzle_cradle', type: 'box', size: [0.018, 0.032, 0.022], pos: [0.085, 0, 0.046], rgba: [0.44, 0.29, 0.17, 1] },
      ],
      children: [
        {
          id: 'fart_cam_wheel',
          name: '4-Lobe Escapement Cam',
          type: 'body',
          pos: [-0.19, 0, 0.195],
          deformMaterial: 'softMetal',
          joints: [
            {
              name: 'cam_spin',
              type: 'hinge',
              axis: [0, 1, 0],
              damping: 0.05,
              actuator: { type: 'velocity', kv: 2.0, ctrlValue: 1.05 },
            },
          ],
          geoms: [
            { name: 'cam_hub', type: 'cylinder', size: [0.036, 0.016], euler: [90, 0, 0], rgba: [0.86, 0.68, 0.24, 1], contype: 0, conaffinity: 0 },
            { name: 'cam_lobe_ripper', type: 'box', size: [0.012, 0.014, 0.008], pos: [0.044, 0, 0], rgba: [0.92, 0.32, 0.26, 1], contype: 0, conaffinity: 0 },
            { name: 'cam_lobe_sputter', type: 'box', size: [0.008, 0.014, 0.010], pos: [0, 0, 0.040], rgba: [0.95, 0.75, 0.22, 1], contype: 0, conaffinity: 0 },
            { name: 'cam_lobe_squeak', type: 'box', size: [0.013, 0.014, 0.008], pos: [-0.046, 0, 0], rgba: [0.94, 0.48, 0.60, 1], contype: 0, conaffinity: 0 },
            { name: 'cam_lobe_toot', type: 'box', size: [0.008, 0.014, 0.009], pos: [0, 0, -0.036], rgba: [0.38, 0.78, 0.52, 1], contype: 0, conaffinity: 0 },
          ],
          children: [],
        },
      ],
    },
    {
      id: 'whoopee_bladder',
      name: 'Pink Rubber Whoopee Cushion',
      type: 'body',
      pos: [-0.08, 0, 0.088],
      deformMaterial: 'plastic',
      joints: [
        {
          name: 'cushion_squash',
          type: 'slide',
          axis: [0, 0, -1],
          stiffness: 160,
          damping: 8.5,
          limited: true,
          hardStop: true,
          range: [-0.004, 0.042],
        },
      ],
      geoms: [
        { name: 'cushion_upper_belly', type: 'ellipsoid', size: [0.085, 0.085, 0.028], pos: [0, 0, 0], solref: [0.016, 0.68], rgba: [0.96, 0.52, 0.60, 1] },
        { name: 'cushion_seam_flange', type: 'cylinder', size: [0.090, 0.005], pos: [0, 0, -0.006], rgba: [0.86, 0.34, 0.45, 1], contype: 0, conaffinity: 0 },
        { name: 'bladder_bellows_coupler', type: 'cylinder', fromto: [0.068, 0, -0.002, 0.112, 0, -0.002], size: [0.020], rgba: [0.92, 0.44, 0.53, 1], contype: 0, conaffinity: 0 },
      ],
      children: [],
    },
    {
      id: 'stomper_boot',
      name: 'Brass Stomper Plunger',
      type: 'body',
      pos: [-0.08, 0, 0.16],
      deformMaterial: 'softMetal',
      joints: [
        {
          name: 'boot_drop',
          type: 'slide',
          axis: [0, 0, 1],
          damping: 1.2,
          limited: true,
          hardStop: true,
          range: [-0.08, 0.10],
        },
      ],
      geoms: [
        { name: 'brass_stomper_sole', type: 'cylinder', size: [0.060, 0.016], pos: [0, 0, -0.020], density: 8400, solref: [0.016, 0.72], rgba: [0.85, 0.67, 0.24, 1] },
        { name: 'plunger_shaft', type: 'cylinder', fromto: [0, 0, -0.004, 0, 0, 0.135], size: [0.010], density: 7800, rgba: [0.75, 0.79, 0.85, 1], contype: 0, conaffinity: 0 },
        { name: 'red_stomp_knob', type: 'sphere', size: [0.024], pos: [0, 0, 0.148], rgba: [0.88, 0.22, 0.20, 1] },
      ],
      children: [],
    },
    {
      id: 'whoopee_spout_nozzle',
      name: 'Ribbed Rubber Whoopee Spout',
      type: 'body',
      pos: [0.085, 0, 0.086],
      euler: [0, 90, 0],
      deformMaterial: 'plastic',
      csgEnabled: true,
      collision: 'hull',
      windInstrument: {
        exciter: 'brass_lip',
        breathKPa: 0,
        embouchureHz: 38,
      },
      script: `// Pure physical coupling: Bladder compression -> Bernoulli Flapper Lip -> 110 mm Rubber Spout!
const t = api.getTime();
const qSquash = Math.max(0, api.getJointPosition('cushion_squash')); // 0..0.042 m
const vSquash = api.getJointVelocity('cushion_squash');              // + m/s when squashing!
const flapRad = api.getJointPosition('sphincter_flap');              // rad (0 = shut, + = blown open)

// Air jet pressure comes from downward bladder velocity + residual bottom-of-stroke squeeze!
const squeezeTail = qSquash > 0.025 && vSquash > -0.015 ? 0.65 * Math.min(1, (qSquash - 0.025) / 0.012) : 0;
const rawFlow = Math.max(0, vSquash * 48) + squeezeTail;

// Bernoulli jet flutter on the hinged rubber flapper lip at the spout mouth:
if (rawFlow > 0.05) {
  const jetPush = rawFlow * 0.24 * Math.max(-0.35, Math.cos(flapRad * 4.4));
  api.applyJointForce('sphincter_flap', jetPush);
}

// Modulate spout air pressure with real flapper motion + irregular wet bubble-bursts!
const sputterGate = 0.56 + 0.44 * Math.sin(flapRad * 9.5 + t * 27) * Math.cos(t * 11.3);
const breathKPa = rawFlow > 0.04 ? Math.min(6.8, (0.55 + rawFlow * 1.75) * Math.max(0.24, sputterGate)) : 0;

// As the rubber bladder flattens, neck stretches from loose 26 Hz motorboat -> 60 Hz rip -> 215 Hz squeaker!
const squashFrac = Math.min(1, qSquash / 0.034);
const chaos = 1 + 0.13 * Math.sin(t * 31.7) + 0.08 * Math.sin(t * 53.1);
const embouchureHz = (25 + 48 * squashFrac + 148 * Math.pow(squashFrac, 3.4)) * chaos;

api.state.breathKPa = breathKPa;
api.state.embouchureHz = embouchureHz;
`,
      joints: [],
      geoms: [
        // Real 110 mm (halfH = 0.055) compliant rubber whoopee-cushion neck -> quarter-wave formant f_1 ≈ 730 Hz!
        { name: 'spout_outer_neck', type: 'cylinder', size: [0.025, 0.055], pos: [0, 0, 0], rgba: [0.92, 0.44, 0.53, 1] },
        { name: 'spout_flared_lips', type: 'cylinder', size: [0.035, 0.012], pos: [0, 0, 0.048], rgba: [0.85, 0.34, 0.45, 1] },
        { name: 'spout_hollow_bore', type: 'cylinder', size: [0.017, 0.068], pos: [0, 0, 0], csg: 'difference', rgba: [0.30, 0.12, 0.16, 0.4] },
        // Unsealed side-seam air bleed -> 3D TMM detects wall breach for wet turbulent air-puff spray!
        { name: 'seam_bleed_slit', type: 'cylinder', size: [0.0055, 0.032], pos: [0, 0, 0.022], quat: [0.707107, 0, 0.707107, 0], csg: 'difference', rgba: [0.25, 0.10, 0.14, 0.5] },
      ],
      children: [
        {
          id: 'sphincter_flapper',
          name: 'Fluttering Rubber Lip Flap',
          type: 'body',
          pos: [0, 0, 0.068],
          deformMaterial: 'plastic',
          joints: [
            {
              name: 'sphincter_flap',
              type: 'hinge',
              axis: [1, 0, 0],
              pos: [0, -0.014, 0],
              stiffness: 0.62,
              damping: 0.008,
              limited: true,
              hardStop: true,
              range: [0, 58],
            },
          ],
          geoms: [
            { name: 'flapper_lip_disc', type: 'ellipsoid', size: [0.028, 0.024, 0.004], pos: [0, 0.014, 0], density: 1150, solref: [0.016, 0.55], rgba: [0.95, 0.46, 0.56, 1] },
          ],
          children: [],
        },
      ],
    },
  ],
};
