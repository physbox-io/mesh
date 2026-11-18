import type { SceneGraph } from '../types/scene';

/**
 * Whoopee Cushion & 4-Lobe Cam Stomper ("The Flatulophone"):
 * Models slow pneumatic air-reservoir bleed (0.8–1.5 s per squeeze, soft damped
 * elastomer contact with zero rigid impact bang!) through a 110 mm compliant
 * rubber spout in the Fletcher sub-resonant relaxation-slap regime (high-Q
 * sweeping vowel-formant squelch + Rosenberg mucosal buzz!).
 */
export const whoopeeStomperPreset: SceneGraph = {
  nodes: [
    {
      id: 'flatulophone_base',
      name: 'Cast-Iron Stomper Frame',
      type: 'body',
      pos: [0, 0, 0],
      deformMaterial: 'softMetal',
      script: `// 4-Lobe Cam Escapement: presses the Brass Stomper onto the Pneumatic Whoopee Bladder!
// Soft pneumatic damping gives long 0.8..1.5 s squelchy air-bleed squeezes with zero collision bang.
const theta = api.getJointPosition('cam_spin');
const phase = ((theta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
const sector = Math.floor((phase / (Math.PI * 2)) * 4); // 0..3: 4 distinct comedic profiles
const u = ((phase / (Math.PI * 2)) * 4) % 1;

const qBoot = api.getJointPosition('boot_drop');
const vBoot = api.getJointVelocity('boot_drop');

if (u < 0.24) {
  // Smooth cam return lift so the rubber bladder re-inflates cleanly
  const targetH = 0.028;
  const fLift = 220 * (targetH - qBoot) - 22 * vBoot;
  if (fLift > 0) api.applyJointForce('boot_drop', fLift);
} else if (sector === 0 && u >= 0.24 && u < 0.80) {
  // Lobe 0 ("The Juicy Wet Ripper", ~1.2 s): firm press with mid-stroke squelch surge!
  const prog = (u - 0.24) / 0.56;
  const wave = 1 + 0.35 * Math.sin(prog * Math.PI * 3);
  api.applyJointForce('boot_drop', -28 * wave);
} else if (sector === 1 && u >= 0.24 && u < 0.86) {
  // Lobe 1 ("The Bubbly Sputter-Cluster", ~1.3 s): 4 distinct wet pulsing pushes!
  const prog = (u - 0.24) / 0.62;
  const pulse = Math.sin(prog * Math.PI * 2 * 3.5);
  api.applyJointForce('boot_drop', pulse > -0.15 ? -34 * (0.5 + 0.5 * Math.max(0, pulse)) : 8);
} else if (sector === 2 && u >= 0.24 && u < 0.90) {
  // Lobe 2 ("The Church-Pew Squeaker", ~1.4 s): slow progressive pinch all the way flat!
  const prog = (u - 0.24) / 0.66;
  api.applyJointForce('boot_drop', -16 - 42 * prog * prog);
} else if (sector === 3 && u >= 0.28 && u < 0.56) {
  // Lobe 3 ("The Short Wet Blorp", ~0.55 s): quick squishy press!
  api.applyJointForce('boot_drop', -26);
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
              actuator: { type: 'velocity', kv: 2.0, ctrlValue: 0.72 },
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
          // High pneumatic orifice damping (110 N*s/m) -> slow, realistic 0.8..1.4 s air deflation!
          stiffness: 72,
          damping: 110,
          limited: true,
          hardStop: true,
          range: [-0.004, 0.042],
        },
      ],
      geoms: [
        // Critically damped 75 ms soft pneumatic contact (`solref: [0.075, 1.0]`) -> zero rigid gunshot bang!
        { name: 'cushion_upper_belly', type: 'ellipsoid', size: [0.085, 0.085, 0.028], pos: [0, 0, 0], solref: [0.075, 1.0], rgba: [0.96, 0.52, 0.60, 1] },
        { name: 'cushion_seam_flange', type: 'cylinder', size: [0.090, 0.005], pos: [0, 0, -0.006], rgba: [0.86, 0.34, 0.45, 1], contype: 0, conaffinity: 0 },
        { name: 'bladder_bellows_coupler', type: 'cylinder', fromto: [0.068, 0, -0.002, 0.112, 0, -0.002], size: [0.020], rgba: [0.92, 0.44, 0.53, 1], contype: 0, conaffinity: 0 },
      ],
      children: [],
    },
    {
      id: 'stomper_boot',
      name: 'Brass Stomper Plunger',
      type: 'body',
      pos: [-0.08, 0, 0.154],
      deformMaterial: 'softMetal',
      joints: [
        {
          name: 'boot_drop',
          type: 'slide',
          axis: [0, 0, 1],
          damping: 6.5,
          limited: true,
          hardStop: true,
          range: [-0.075, 0.08],
        },
      ],
      geoms: [
        { name: 'brass_stomper_sole', type: 'cylinder', size: [0.060, 0.016], pos: [0, 0, -0.020], density: 4200, solref: [0.075, 1.0], rgba: [0.85, 0.67, 0.24, 1] },
        { name: 'plunger_shaft', type: 'cylinder', fromto: [0, 0, -0.004, 0, 0, 0.135], size: [0.010], density: 4000, rgba: [0.75, 0.79, 0.85, 1], contype: 0, conaffinity: 0 },
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
        embouchureHz: 46,
      },
      script: `// Pneumatic RC Bladder Reservoir -> Wet Stick-Slip Bubble Gate -> 110 mm Rubber Spout!
const t = api.getTime();
const dt = api.getTimestep() || 0.001;
const qSquash = Math.max(0, api.getJointPosition('cushion_squash')); // 0..0.042 m
const vSquash = api.getJointVelocity('cushion_squash');              // + m/s when deflating!
const flapRad = api.getJointPosition('sphincter_flap');

// Integrate internal trapped air pressure pBag (kPa): builds on compression, bleeds out over ~0.35 s!
let pBag = typeof api.state.pBag === 'number' ? api.state.pBag : 0;
if (vSquash > 0.002) {
  pBag = Math.min(5.2, pBag + vSquash * dt * 210);
}
const pinchTightness = Math.min(1, Math.pow(qSquash / 0.033, 2.2));
const bleedTau = 0.26 + 0.28 * pinchTightness; // pinched neck bleeds slower (longer squeak!)
pBag *= Math.exp(-dt / bleedTau);
if (vSquash < -0.01) pBag *= Math.exp(-dt / 0.06); // suction cutoff during re-inflation
api.state.pBag = pBag;

// Bernoulli jet flutter on the visible rubber lip flap at the spout exit:
if (pBag > 0.25) {
  const jetPush = pBag * 0.11 * Math.max(-0.35, Math.cos(flapRad * 4.4));
  api.applyJointForce('sphincter_flap', jetPush);
}

// Wet mucosal stick-slip bubble gating ("bwwwrr-owa-squelch-prrt"):
const bubble1 = Math.sin(t * 19.3 + Math.sin(t * 6.7) * 2.1);
const bubble2 = Math.cos(t * 31.1 + flapRad * 8.0);
const wetGate = 0.62 + 0.38 * bubble1 * (0.6 + 0.4 * bubble2);
const breathKPa = pBag > 0.22 ? Math.min(5.8, (0.35 + pBag * 1.15) * Math.max(0.22, wetGate)) : 0;

// Pitch contour:
// - Mid-pressure wet surge droops pitch DOWN into juicy 34..55 Hz squelch ("blorrrp-wah"),
// - High bottom-of-stroke compression stretches the rubber slit tight up to 160..240 Hz ("squeeeak!")!
const pressureDroop = Math.max(0, Math.min(18, (pBag - 1.2) * 7.5)) * (1 - pinchTightness);
const baseLipHz = 44 - pressureDroop + 38 * (qSquash / 0.034) + 155 * Math.pow(pinchTightness, 1.8);
const wetWobble = 1 + 0.12 * bubble1 + 0.07 * Math.sin(t * 47.3);

api.state.breathKPa = breathKPa;
api.state.embouchureHz = Math.max(24, baseLipHz * wetWobble);
`,
      joints: [],
      geoms: [
        { name: 'spout_outer_neck', type: 'cylinder', size: [0.025, 0.055], pos: [0, 0, 0], rgba: [0.92, 0.44, 0.53, 1] },
        { name: 'spout_flared_lips', type: 'cylinder', size: [0.035, 0.012], pos: [0, 0, 0.048], rgba: [0.85, 0.34, 0.45, 1] },
        { name: 'spout_hollow_bore', type: 'cylinder', size: [0.017, 0.068], pos: [0, 0, 0], csg: 'difference', rgba: [0.30, 0.12, 0.16, 0.4] },
        { name: 'seam_bleed_slit', type: 'cylinder', size: [0.0045, 0.032], pos: [0, 0, 0.022], quat: [0.707107, 0, 0.707107, 0], csg: 'difference', rgba: [0.25, 0.10, 0.14, 0.5] },
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
              stiffness: 0.58,
              damping: 0.008,
              limited: true,
              hardStop: true,
              range: [0, 58],
            },
          ],
          geoms: [
            { name: 'flapper_lip_disc', type: 'ellipsoid', size: [0.028, 0.024, 0.004], pos: [0, 0.014, 0], density: 1150, solref: [0.04, 0.85], rgba: [0.95, 0.46, 0.56, 1] },
          ],
          children: [],
        },
      ],
    },
  ],
};
