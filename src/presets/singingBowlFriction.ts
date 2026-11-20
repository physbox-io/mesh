import type { SceneGraph, SceneNode } from '../types/scene';

/**
 * Tibetan Singing Bowl & Stepped Hardwood/Slate Rolling Chute (`singing_bowl_friction`):
 * Showcases continuous tribological contact-friction synthesis (Starter #2):
 *   1. Left (`x = -0.20 m`): Hollow cast-bronze Tibetan singing bowl (`deformMaterial: 'softMetal'`,
 *      `density: 8700`, 3D vibro-acoustic `bodyIr`) circled continuously at 1.75 rad/s by a
 *      spring-loaded suede-leather wooden puja wand (`circumferentialRub` -> modal `rim_singing`
 *      quadrupole lock-in with revolving nodal-line shimmer beat `df = v_slip / (pi * R_rim)`).
 *   2. Right (`x = +0.03 .. +0.35 m`): Enclosed two-tier maple hardwood & rough slate zig-zag
 *      chute where bearing-steel and soda-lime glass marbles roll and drop into a motorized
 *      rocking soundboard trough, alongside a flat slate whetstone puck gliding in a parallel
 *      lane (`rolling` + `scraping` + two-body Hertzian drop chimes across the stereo stage).
 */
export const singingBowlFrictionPreset: SceneGraph = (() => {
  const controllerScript = `// Smooth radial puja pressure + gentle ±9.5° seesaw drive on lower chute trough
const t = api.getTime();

// Ramp puja radial normal force over 50 ms so t = 0 starts cleanly detached, then holds ~1.4 N steady rub
const ramp = Math.min(1.0, t / 0.05);
const vPress = api.getJointVelocity('puja_radial_press');
api.applyJointForce('puja_radial_press', 1.85 * ramp - 8.0 * vPress);

// Slowly rock the lower hardwood & slate catch trough (±9.5° = ±0.166 rad, 3.2 s period)
// so the steel/glass marbles roll and the flat slate puck scrapes continuously forever!
const targetTilt = 0.166 * Math.sin((2 * Math.PI * t) / 3.2);
const targetVel = 0.166 * ((2 * Math.PI) / 3.2) * Math.cos((2 * Math.PI * t) / 3.2);
const qTilt = api.getJointPosition('trough_rock_hinge');
const vTilt = api.getJointVelocity('trough_rock_hinge');
api.applyJointForce('trough_rock_hinge', 28.0 * (targetTilt - qTilt) + 3.6 * (targetVel - vTilt));
`;

  // 1. Cast-Bronze Tibetan Singing Bowl (`x = -0.20, y = 0.00`)
  const singingBowl: SceneNode = {
    id: 'tibetan_singing_bowl',
    name: 'Cast Bronze Singing Bowl',
    type: 'body',
    pos: [-0.20, 0, 0.076],
    deformMaterial: 'softMetal',
    density: 8700,
    csgEnabled: true,
    collision: 'hull',
    joints: [],
    geoms: [
      {
        name: 'bowl_outer_wall',
        type: 'cylinder',
        size: [0.082, 0.052], // Ø164 mm × 104 mm tall bronze cup (rim at z_world = 0.128 m)
        pos: [0, 0, 0],
        density: 8700,
        friction: [0.38, 0.004, 0.0002],
        solref: [0.006, 0.35],
        rgba: [0.85, 0.66, 0.25, 1],
      },
      {
        name: 'bowl_hollow_cavity',
        type: 'cylinder',
        size: [0.0745, 0.050], // 7.5 mm bronze bell wall + 8 mm base, open at +Z mouth
        pos: [0, 0, 0.008],
        csg: 'difference',
        rgba: [0.52, 0.36, 0.14, 0.45],
      },
      {
        name: 'bowl_turned_rim',
        type: 'cylinder',
        size: [0.0832, 0.003],
        pos: [0, 0, 0.048],
        rgba: [0.94, 0.78, 0.36, 1],
        role: 'visual',
      },
    ],
    children: [],
  };

  // 2. Silk Cushion Base + Overhead Concentric Motorized Puja Mallet Rig
  const bowlRigAndController: SceneNode = {
    id: 'bowl_cushion_rig',
    name: 'Silk Cushion & Puja Drive Rig',
    type: 'body',
    pos: [-0.20, 0, 0],
    deformMaterial: 'hardwood',
    script: controllerScript,
    joints: [],
    geoms: [
      {
        name: 'silk_ring_cushion',
        type: 'cylinder',
        size: [0.072, 0.012],
        pos: [0, 0, 0.012],
        rgba: [0.68, 0.14, 0.22, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'cushion_plinth',
        type: 'box',
        size: [0.095, 0.095, 0.005],
        pos: [0, 0, 0.005],
        rgba: [0.28, 0.18, 0.12, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'gantry_rear_post',
        type: 'box',
        size: [0.009, 0.009, 0.108],
        pos: [0, 0.155, 0.112],
        rgba: [0.30, 0.19, 0.12, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'gantry_overarm',
        type: 'box',
        size: [0.010, 0.085, 0.008],
        pos: [0, 0.078, 0.216],
        rgba: [0.32, 0.21, 0.13, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [
      {
        id: 'puja_orbit_hub',
        name: 'Motorized Puja Orbit Hub',
        type: 'body',
        pos: [0, 0, 0.204],
        deformMaterial: 'softMetal',
        joints: [
          {
            name: 'puja_orbit_hinge',
            type: 'hinge',
            axis: [0, 0, 1],
            damping: 0.08,
            actuator: { type: 'velocity', kv: 1.4, ctrlValue: 1.75 },
          },
        ],
        geoms: [
          {
            name: 'orbit_hub_cap',
            type: 'cylinder',
            size: [0.016, 0.006],
            rgba: [0.82, 0.68, 0.28, 1],
            contype: 0,
            conaffinity: 0,
          },
          {
            name: 'orbit_radial_bar',
            type: 'box',
            size: [0.052, 0.005, 0.004],
            pos: [0.048, 0, 0],
            rgba: [0.78, 0.64, 0.26, 1],
            contype: 0,
            conaffinity: 0,
          },
        ],
        children: [
          {
            id: 'puja_mallet',
            name: 'Leather-Wrapped Rosewood Puja Mallet',
            type: 'body',
            // Starts at r = 0.0955 m (2.5 mm clear outside r_bowl + r_wand = 0.0930 m -> zero t = 0 overlap!)
            pos: [0.0955, 0, -0.088],
            deformMaterial: 'hardwood',
            joints: [
              {
                name: 'puja_radial_press',
                type: 'slide',
                axis: [-1, 0, 0],
                stiffness: 180,
                damping: 16,
                limited: true,
                range: [-0.003, 0.007],
              },
            ],
            geoms: [
              {
                name: 'puja_suede_band',
                type: 'cylinder',
                size: [0.011, 0.022], // Rubs outer bowl rim cleanly around z_world = 0.116 m
                pos: [0, 0, 0],
                density: 780,
                condim: 3,
                friction: [0.38, 0.004, 0.0002],
                solref: [0.008, 1.15],
                solimp: [0.96, 0.995, 0.0008, 0.5, 2],
                rgba: [0.36, 0.22, 0.14, 1],
              },
              {
                name: 'puja_wooden_handle',
                type: 'cylinder',
                size: [0.0085, 0.036],
                pos: [0, 0, 0.052],
                density: 720,
                rgba: [0.58, 0.32, 0.16, 1],
                contype: 0,
                conaffinity: 0,
              },
            ],
            children: [],
          },
        ],
      },
    ],
  };

  // 3. Enclosed Stepped Hardwood & Slate Zig-Zag Chute (`x = +0.02 .. +0.36 m`)
  //    Front lane (`y = -0.014 m`) carries cascading steel & glass marbles from Tier 1 -> Tier 2 -> Rocking Trough.
  const chuteMapleFrame: SceneNode = {
    id: 'zigzag_maple_chute',
    name: 'Hardwood Zig-Zag Chute Frame',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'hardwood',
    joints: [],
    geoms: [
      // Tier 1: Upper maple ramp (x = 0.030..0.280, slopes down +X toward right drop gap x = 0.280..0.354)
      {
        name: 'maple_ramp_upper',
        type: 'box',
        size: [0.125, 0.013, 0.004],
        pos: [0.155, -0.014, 0.245],
        euler: [0, 9, 0],
        friction: [0.32, 0.003, 0.0001],
        rgba: [0.76, 0.54, 0.30, 1],
      },
      // Upper containment walls around Tier 1 & Tier 2 (`z_bottom = 0.126 m`, >= 8 mm clear above rocking trough at max ±12° tilt!)
      {
        name: 'chute_wall_front',
        type: 'box',
        size: [0.168, 0.0025, 0.082],
        pos: [0.190, -0.0295, 0.208],
        rgba: [0.82, 0.88, 0.94, 0.22],
      },
      {
        name: 'chute_wall_mid',
        type: 'box',
        size: [0.168, 0.0025, 0.082],
        pos: [0.190, 0.0015, 0.208],
        rgba: [0.82, 0.88, 0.94, 0.22],
      },
      {
        name: 'chute_end_left',
        type: 'box',
        size: [0.004, 0.016, 0.082],
        pos: [0.024, -0.014, 0.208],
        rgba: [0.58, 0.38, 0.22, 1],
      },
      {
        name: 'chute_end_right',
        type: 'box',
        size: [0.004, 0.016, 0.082],
        pos: [0.356, -0.014, 0.208],
        rgba: [0.58, 0.38, 0.22, 1],
      },
      // Pedestal posts supporting the chute & rocking trough pivot
      {
        name: 'trough_pedestal_f',
        type: 'box',
        size: [0.028, 0.008, 0.024],
        pos: [0.190, -0.042, 0.024],
        rgba: [0.34, 0.22, 0.14, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'trough_pedestal_b',
        type: 'box',
        size: [0.028, 0.008, 0.024],
        pos: [0.190, 0.044, 0.024],
        rgba: [0.34, 0.22, 0.14, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [],
  };

  // Tier 2: Separate Rough Slate Chute Body (`deformMaterial: 'stone'`, roughness = 0.85!)
  const chuteSlateTier: SceneNode = {
    id: 'zigzag_slate_tier',
    name: 'Rough Slate Chute Tier',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'stone',
    joints: [],
    geoms: [
      // Slopes down -X from x = 0.352 to x = 0.102, dropping through left gap x = 0.028..0.102 into the lower trough!
      {
        name: 'slate_ramp_mid',
        type: 'box',
        size: [0.125, 0.013, 0.0045],
        pos: [0.227, -0.014, 0.158],
        euler: [0, -9, 0],
        friction: [0.68, 0.005, 0.0002],
        rgba: [0.28, 0.31, 0.36, 1],
      },
    ],
    children: [],
  };

  // Lower Motorized Rocking Soundboard Trough (2 parallel walled lanes: Front = Rolling Marbles, Back = Scraping Slate Puck)
  const rockingSoundboardTrough: SceneNode = {
    id: 'rocking_chute_trough',
    name: 'Rocking Maple & Slate Soundboard Trough',
    type: 'body',
    pos: [0.190, 0, 0.052],
    deformMaterial: 'hardwood',
    joints: [
      {
        name: 'trough_rock_hinge',
        type: 'hinge',
        axis: [0, 1, 0],
        pos: [0, 0, 0],
        damping: 0.25,
        limited: true,
        range: [-12, 12],
        hardStop: false,
      },
    ],
    geoms: [
      // Front lane floor (hardwood, y_local = -0.014)
      {
        name: 'trough_maple_bed',
        type: 'box',
        size: [0.164, 0.013, 0.004],
        pos: [0, -0.014, 0],
        friction: [0.35, 0.003, 0.0001],
        rgba: [0.74, 0.50, 0.28, 1],
      },
      // Back lane floor (low-mu honed slate rail so flat stone puck glides at ±9.5° tilt!)
      {
        name: 'trough_slate_bed',
        type: 'box',
        size: [0.164, 0.013, 0.004],
        pos: [0, 0.016, 0],
        friction: [0.11, 0.002, 0.0001],
        rgba: [0.25, 0.28, 0.33, 1],
      },
      // Three longitudinal lane walls + two end bumpers keeping all marbles & scraper captured forever
      {
        name: 'trough_rail_front',
        type: 'box',
        size: [0.166, 0.0025, 0.018],
        pos: [0, -0.0295, 0.014],
        rgba: [0.55, 0.36, 0.20, 1],
      },
      {
        name: 'trough_rail_divider',
        type: 'box',
        size: [0.166, 0.0025, 0.018],
        pos: [0, 0.001, 0.014],
        rgba: [0.55, 0.36, 0.20, 1],
      },
      {
        name: 'trough_rail_back',
        type: 'box',
        size: [0.166, 0.0025, 0.018],
        pos: [0, 0.0315, 0.014],
        rgba: [0.55, 0.36, 0.20, 1],
      },
      {
        name: 'trough_bumper_l',
        type: 'box',
        size: [0.004, 0.033, 0.020],
        pos: [-0.162, 0.001, 0.016],
        rgba: [0.46, 0.30, 0.18, 1],
      },
      {
        name: 'trough_bumper_r',
        type: 'box',
        size: [0.004, 0.033, 0.020],
        pos: [0.162, 0.001, 0.016],
        rgba: [0.46, 0.30, 0.18, 1],
      },
    ],
    children: [],
  };

  // 4. Dynamic Rolling Marbles (Bearing Steel & Clear Glass) + Sliding Rough Stone Scraper Block
  const steelMarble: SceneNode = {
    id: 'bearing_steel_marble',
    name: 'Bearing Steel Marble',
    type: 'body',
    pos: [0.060, -0.014, 0.278], // 3.9 mm clear above upper maple ramp at t = 0
    deformMaterial: 'steel',
    joints: [{ name: 'steel_marble_free', type: 'free' }],
    geoms: [
      {
        name: 'steel_ball_geom',
        type: 'sphere',
        size: [0.010],
        density: 7850,
        condim: 3,
        friction: [0.32, 0.002, 0.0001],
        solref: [0.005, 0.25],
        rgba: [0.84, 0.87, 0.92, 1],
      },
    ],
    children: [],
  };

  const glassMarble: SceneNode = {
    id: 'cobalt_glass_marble',
    name: 'Cobalt Glass Marble',
    type: 'body',
    pos: [0.120, -0.014, 0.269], // 4.4 mm clear above upper maple ramp at t = 0
    deformMaterial: 'glass',
    joints: [{ name: 'glass_marble_free', type: 'free' }],
    geoms: [
      {
        name: 'glass_ball_geom',
        type: 'sphere',
        size: [0.010],
        density: 2500,
        condim: 3,
        friction: [0.26, 0.002, 0.0001],
        solref: [0.005, 0.22],
        rgba: [0.22, 0.62, 0.92, 0.88],
      },
    ],
    children: [],
  };

  const slateScraperPuck: SceneNode = {
    id: 'slate_whetstone_puck',
    name: 'Slate Whetstone Scraper Block',
    type: 'body',
    pos: [0.190, 0.016, 0.067], // 3.0 mm clear above back slate lane at t = 0
    deformMaterial: 'stone',
    joints: [{ name: 'slate_puck_free', type: 'free' }],
    geoms: [
      {
        name: 'slate_puck_geom',
        type: 'box',
        size: [0.018, 0.009, 0.008],
        mass: 0.16,
        condim: 3,
        friction: [0.11, 0.002, 0.0001],
        solref: [0.007, 0.85],
        rgba: [0.38, 0.41, 0.46, 1],
      },
    ],
    children: [],
  };

  return {
    nodes: [
      bowlRigAndController,
      singingBowl,
      chuteMapleFrame,
      chuteSlateTier,
      rockingSoundboardTrough,
      steelMarble,
      glassMarble,
      slateScraperPuck,
    ],
  };
})();
