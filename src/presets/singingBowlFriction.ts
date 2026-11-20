import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';

/**
 * Builds a watertight, consistently outward-wound 2-manifold surface of revolution
 * around the body-local +Z axis from an ordered meridian profile `rings` (`[r, z]`, `r > 0`)
 * running from bottom-outer (`zBottomPole`) up the outer belly, over the rim lip, and down
 * the inner wall (or top face) to `zTopPole`.
 *
 * Outward normal verification (`CLAUDE.md` Mesh face winding):
 *   - Circumferential tangent `t_theta = r dtheta * theta_hat`
 *   - Meridian tangent `t_s = dr * r_hat + dz * z_hat`
 *   - `(b - a) x (c - a) = t_theta x t_s = r dtheta * (dz * r_hat - dr * z_hat)`:
 *       * Bottom base (`dr > 0, dz = 0`)  -> `-Z` (outward downward)
 *       * Outer belly (`dz > 0`)          -> `+r_hat` (outward radially)
 *       * Rounded lip (`dr < 0, dz ~ 0`)  -> `+Z` (outward upward)
 *       * Inner cavity (`dz < 0`)         -> `-r_hat` (into open bowl cavity)
 *       * Inner floor (`dr < 0, dz = 0`)  -> `+Z` (upward from cavity floor)
 */
function buildClosedRevolutionMesh(
  rings: readonly (readonly [number, number])[],
  zBottomPole: number,
  zTopPole: number,
  segs: number,
): { vertices: number[]; renderVertices: number[]; faces: number[] } {
  const renderVertices: number[] = [0, 0, zBottomPole];
  const nRings = rings.length;

  for (let k = 0; k < nRings; k++) {
    const [r, z] = rings[k];
    for (let i = 0; i < segs; i++) {
      const theta = (2 * Math.PI * i) / segs;
      renderVertices.push(r * Math.cos(theta), r * Math.sin(theta), z);
    }
  }
  const topPoleIdx = 1 + nRings * segs;
  renderVertices.push(0, 0, zTopPole);

  const vid = (k: number, i: number) => 1 + k * segs + (i % segs);
  const faces: number[] = [];

  // Bottom pole cap (-Z outward normal)
  for (let i = 0; i < segs; i++) {
    faces.push(0, vid(0, i + 1), vid(0, i));
  }

  // Meridian quad strips
  for (let k = 0; k < nRings - 1; k++) {
    for (let i = 0; i < segs; i++) {
      const a = vid(k, i);
      const b = vid(k, i + 1);
      const c = vid(k + 1, i + 1);
      const d = vid(k + 1, i);
      faces.push(a, b, c, a, c, d);
    }
  }

  // Top / inner-cavity center pole cap (+Z outward normal)
  for (let i = 0; i < segs; i++) {
    faces.push(vid(nRings - 1, i), vid(nRings - 1, i + 1), topPoleIdx);
  }

  // Three.js Y-up `vertices` via proper +90° X rotation: (x_zup, y_zup, z_zup) -> (x_zup, z_zup, -y_zup)
  const vertices: number[] = [];
  for (let m = 0; m < renderVertices.length; m += 3) {
    vertices.push(renderVertices[m], renderVertices[m + 2], -renderVertices[m + 1]);
  }
  return { vertices, renderVertices, faces };
}

/**
 * Builds a watertight, consistently outward-wound 2-manifold elliptical-section torus
 * centered at `(0, 0, zCenter)` around the +Z axis (`majorR > minorRad > 0`).
 *
 * Outward normal: `d_theta x d_phi = theta_hat x (-a sin(phi) r_hat + b cos(phi) z_hat)`
 * `= b cos(phi) r_hat + a sin(phi) z_hat` (strictly outward at every `(theta, phi)`).
 */
function buildClosedTorusMesh(
  majorR: number,
  minorRad: number,
  minorZ: number,
  zCenter: number,
  uSegs: number,
  vSegs: number,
): { vertices: number[]; renderVertices: number[]; faces: number[] } {
  const renderVertices: number[] = [];
  for (let i = 0; i < uSegs; i++) {
    const theta = (2 * Math.PI * i) / uSegs;
    const ct = Math.cos(theta);
    const st = Math.sin(theta);
    for (let j = 0; j < vSegs; j++) {
      const phi = (2 * Math.PI * j) / vSegs;
      const r = majorR + minorRad * Math.cos(phi);
      const z = zCenter + minorZ * Math.sin(phi);
      renderVertices.push(r * ct, r * st, z);
    }
  }

  const vid = (i: number, j: number) => (i % uSegs) * vSegs + (j % vSegs);
  const faces: number[] = [];
  for (let i = 0; i < uSegs; i++) {
    for (let j = 0; j < vSegs; j++) {
      const a = vid(i, j);
      const b = vid(i + 1, j);
      const c = vid(i + 1, j + 1);
      const d = vid(i, j + 1);
      faces.push(a, b, c, a, c, d);
    }
  }

  const vertices: number[] = [];
  for (let m = 0; m < renderVertices.length; m += 3) {
    vertices.push(renderVertices[m], renderVertices[m + 2], -renderVertices[m + 1]);
  }
  return { vertices, renderVertices, faces };
}

/**
 * Tibetan Singing Bowl & Stepped Hardwood/Slate Rolling Chute (`singing_bowl_friction`):
 * Showcases continuous tribological contact-friction synthesis (Starter #2):
 *   1. Left (`x = -0.185 m`): Hand-beaten Himalayan bell-bronze singing bowl (`Ø236 mm` curved
 *      belly, `Ø225 mm` rounded thickened lip, `110.5 mm` height, `~4.0 mm` bronze wall tuned to
 *      warm `220 Hz` A3 `(2,0)` fundamental + `~607 Hz` `(3,0)` overtone, 3D `bodyIr`) nestled on
 *      a deep crimson silk brocade ring cushion with gold piping atop a turned dark-walnut plinth.
 *      A concealed turntable inside the walnut plinth smoothly orbits a `18°`-angled rosewood &
 *      dark-charcoal suede puja mallet around the bronze lip (`circumferentialRub` -> `rim_singing`).
 *   2. Right (`x = +0.024 .. +0.360 m`): Stepped two-tier maple hardwood & rough honed slate zig-zag
 *      chute where bearing-steel and cobalt-glass marbles cascade into a motorized rocking soundboard
 *      trough alongside a gliding slate whetstone puck (`rolling` + `scraping` + Hertzian chimes).
 */
export const singingBowlFrictionPreset: SceneGraph = (() => {
  const controllerScript = `// Smooth radial puja mallet pressure + gentle ±9.5° seesaw drive on lower chute trough
const t = api.getTime();

// Ramp radial puja force over 50 ms so t = 0 starts cleanly detached, then holds steady ~2.4 N rim rub
const ramp = Math.min(1.0, t / 0.05);
api.applyJointForce('puja_radial_press', 2.85 * ramp);

// Slowly rock the lower hardwood & slate catch trough (±9.5° = ±0.166 rad, 3.2 s period)
// so the steel/glass marbles roll and the flat slate puck scrapes continuously forever!
const targetTilt = 0.166 * Math.sin((2 * Math.PI * t) / 3.2);
const targetVel = 0.166 * ((2 * Math.PI) / 3.2) * Math.cos((2 * Math.PI * t) / 3.2);
const qTilt = api.getJointPosition('trough_rock_hinge');
const vTilt = api.getJointVelocity('trough_rock_hinge');
api.applyJointForce('trough_rock_hinge', 28.0 * (targetTilt - qTilt) + 3.6 * (targetVel - vTilt));
`;

  // -------------------------------------------------------------------------
  // 1. Hand-Beaten Himalayan Bell-Bronze Singing Bowl (64 × 25 closed 2-manifold)
  //    Resting base r ≈ 62 mm, curved belly r_max = 120 mm (Ø240 mm), classic inward
  //    shoulder to rounded thickened upper lip r_rim ≈ 109.5 mm, height = 112.5 mm.
  // -------------------------------------------------------------------------
  const bowlProfileRings: readonly [number, number][] = [
    // Outer flat resting base & rounded heel
    [0.0560, 0.0000],
    [0.0635, 0.0012],
    [0.0770, 0.0052],
    // Rising lower curve swelling into warm Himalayan belly (convex meridian curve)
    [0.0935, 0.0132],
    [0.1072, 0.0242],
    [0.1158, 0.0368],
    [0.1194, 0.0495],
    [0.1200, 0.0615], // Widest belly Ø240 mm
    [0.1184, 0.0745],
    [0.1154, 0.0875],
    [0.1120, 0.0995],
    // Thickened, gently rounded upper bronze lip (contact circle around z = 0.1105 m)
    [0.1102, 0.1072],
    [0.1095, 0.1106],
    [0.1076, 0.1125], // Lip crown
    [0.1042, 0.1110], // Inner lip bead (~3.8 mm thickened rim lip)
    // Hand-hammered hollow interior bronze cavity (~2.1 mm shell wall -> ~220 Hz A3 fundamental)
    [0.1058, 0.1025],
    [0.1132, 0.0882],
    [0.1164, 0.0748],
    [0.1180, 0.0615],
    [0.1173, 0.0495],
    [0.1136, 0.0372],
    [0.1048, 0.0248],
    [0.0912, 0.0140],
    [0.0748, 0.0062],
    [0.0550, 0.0019],
  ];
  const bowlShellMesh = buildClosedRevolutionMesh(bowlProfileRings, 0.0, 0.0019, 64);

  // Subtle hand-chased golden & dark-patina decorative rim bands below the lip contact zone
  const bowlGoldRimBand = buildClosedTorusMesh(0.1113, 0.00055, 0.0011, 0.1030, 64, 10);
  const bowlPatinaGrooveBand = buildClosedTorusMesh(0.1129, 0.00050, 0.0009, 0.0970, 64, 10);

  const singingBowl: SceneNode = {
    id: 'tibetan_singing_bowl',
    name: 'Cast Bronze Singing Bowl',
    type: 'body',
    pos: [-0.185, 0, 0.032],
    deformMaterial: 'softMetal',
    density: 8700,
    tunedPitchHz: 220,
    collision: 'hull',
    joints: [],
    geoms: [
      {
        name: 'bowl_shell_mesh',
        type: 'mesh',
        size: [1],
        dynamic: true,
        vertices: bowlShellMesh.vertices,
        renderVertices: bowlShellMesh.renderVertices,
        faces: bowlShellMesh.faces,
        density: 8700,
        friction: [0.38, 0.004, 0.0002],
        solref: [0.006, 0.35],
        rgba: [0.76, 0.58, 0.26, 1],
      },
      {
        // Analytical mjc_SphereCapsule lip equator collider for exact C^infinity chatter-free rim rub
        name: 'bowl_lip_ring_collider',
        type: 'capsule',
        size: [0.1096, 0.004],
        pos: [0, 0, 0.1098],
        mass: 0,
        role: 'collision',
        csgDerived: 'collider',
        colliderOf: 'bowl_lip_ring',
        contype: 2,
        conaffinity: 2,
        friction: [0.38, 0.004, 0.0002],
        solref: [0.012, 1.35],
        solimp: [0.35, 0.98, 0.0035, 0.5, 2],
        rgba: [0.76, 0.58, 0.26, 1],
      },
      {
        name: 'bowl_chased_gold_band',
        type: 'mesh',
        size: [1],
        dynamic: true,
        role: 'visual',
        contype: 0,
        conaffinity: 0,
        vertices: bowlGoldRimBand.vertices,
        renderVertices: bowlGoldRimBand.renderVertices,
        faces: bowlGoldRimBand.faces,
        rgba: [0.90, 0.74, 0.36, 1],
      },
      {
        name: 'bowl_patina_inlay_band',
        type: 'mesh',
        size: [1],
        dynamic: true,
        role: 'visual',
        contype: 0,
        conaffinity: 0,
        vertices: bowlPatinaGrooveBand.vertices,
        renderVertices: bowlPatinaGrooveBand.renderVertices,
        faces: bowlPatinaGrooveBand.faces,
        rgba: [0.40, 0.28, 0.13, 1],
      },
    ],
    children: [],
  };

  // -------------------------------------------------------------------------
  // 2. Silk Brocade Ring Cushion (36×18 Torus + Gold Piping) & Turned Dark-Walnut Plinth
  //    Concealed under-plinth rotary drive (`puja_orbit_hub`) with sleek curved cradle arm
  //    guiding the 18°-angled rosewood + dark-charcoal suede puja mallet smoothly around the rim!
  // -------------------------------------------------------------------------
  const walnutPlinthRings: readonly [number, number][] = [
    [0.104, 0.0000],
    [0.108, 0.0020],
    [0.108, 0.0055],
    [0.097, 0.0075], // Recessed shadow-line slot concealing the turntable ring
    [0.097, 0.0110],
    [0.106, 0.0135],
    [0.106, 0.0165],
    [0.100, 0.0200], // Chamfered top walnut rim
    [0.088, 0.0200],
    [0.074, 0.0145], // Dished walnut cradle nestling the crimson silk torus
  ];
  const walnutPlinthMesh = buildClosedRevolutionMesh(walnutPlinthRings, 0.0, 0.0145, 48);
  const silkCushionTorus = buildClosedTorusMesh(0.075, 0.023, 0.0135, 0.0275, 36, 18);
  const goldPipingTorus = buildClosedTorusMesh(0.0982, 0.0022, 0.0022, 0.0275, 36, 12);

  const cradleArmGeoms: SceneGeom[] = [
    {
      name: 'turntable_concealed_collar',
      type: 'cylinder',
      size: [0.096, 0.0016],
      pos: [0, 0, 0],
      rgba: [0.32, 0.22, 0.14, 1],
      contype: 0,
      conaffinity: 0,
    },
    {
      name: 'puja_cradle_lower_sweep',
      type: 'capsule',
      size: [0.0036, 0.01],
      fromto: [0.094, 0, 0.000, 0.136, 0, 0.016],
      rgba: [0.30, 0.20, 0.13, 1],
      contype: 0,
      conaffinity: 0,
    },
    {
      name: 'puja_cradle_riser_sweep',
      type: 'capsule',
      size: [0.0034, 0.01],
      fromto: [0.136, 0, 0.016, 0.137, 0, 0.098],
      rgba: [0.30, 0.20, 0.13, 1],
      contype: 0,
      conaffinity: 0,
    },
  ];

  // Turned rosewood + charcoal-suede puja mallet leaning inward at a natural 18° angle (`euler: [0, -18, 0]`):
  // Local +Z unit vector is `(-sin 18°, 0, cos 18°) = (-0.3090, 0, +0.9511)`.
  const S18 = Math.sin((18 * Math.PI) / 180);
  const C18 = Math.cos((18 * Math.PI) / 180);
  const alongMallet = (s: number): [number, number, number] => [
    +(-s * S18).toFixed(5),
    0,
    +(s * C18).toFixed(5),
  ];

  const bowlRigAndController: SceneNode = {
    id: 'bowl_cushion_rig',
    name: 'Silk Cushion & Puja Drive Rig',
    type: 'body',
    pos: [-0.185, 0, 0],
    deformMaterial: 'hardwood',
    script: controllerScript,
    joints: [],
    geoms: [
      {
        name: 'walnut_plinth_stand',
        type: 'mesh',
        size: [1],
        dynamic: true,
        vertices: walnutPlinthMesh.vertices,
        renderVertices: walnutPlinthMesh.renderVertices,
        faces: walnutPlinthMesh.faces,
        rgba: [0.24, 0.14, 0.09, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'silk_ring_cushion',
        type: 'mesh',
        size: [1],
        dynamic: true,
        vertices: silkCushionTorus.vertices,
        renderVertices: silkCushionTorus.renderVertices,
        faces: silkCushionTorus.faces,
        rgba: [0.58, 0.12, 0.16, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'cushion_gold_piping',
        type: 'mesh',
        size: [1],
        dynamic: true,
        vertices: goldPipingTorus.vertices,
        renderVertices: goldPipingTorus.renderVertices,
        faces: goldPipingTorus.faces,
        rgba: [0.85, 0.68, 0.27, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [
      {
        id: 'puja_orbit_hub',
        name: 'Motorized Puja Orbit Hub',
        type: 'body',
        pos: [0, 0, 0.0092],
        deformMaterial: 'softMetal',
        joints: [
          {
            name: 'puja_orbit_hinge',
            type: 'hinge',
            axis: [0, 0, 1],
            damping: 0.25,
            actuator: { type: 'velocity', kv: 12.0, ctrlValue: 2.15 },
          },
        ],
        geoms: cradleArmGeoms,
        children: [
          {
            id: 'puja_mallet',
            name: 'Leather-Wrapped Rosewood Puja Mallet',
            type: 'body',
            // Starts at x = 0.1232 m (~2.6 mm clear outside bowl lip contact x = 0.1206 m -> 0 contacts at t = 0!)
            pos: [0.1232, 0, 0.1326],
            deformMaterial: 'hardwood',
            joints: [
              {
                name: 'puja_radial_press',
                type: 'slide',
                axis: [-1, 0, 0],
                stiffness: 85,
                damping: 28,
                limited: true,
                range: [-0.003, 0.010],
              },
            ],
            geoms: [
              {
                // Exact analytical mjc_SphereCapsule contact patch embedded flush inside the 18° suede sleeve
                name: 'puja_suede_band',
                type: 'sphere',
                size: [0.0110],
                pos: [0, 0, 0],
                mass: 0.022,
                condim: 3,
                contype: 2,
                conaffinity: 2,
                friction: [0.38, 0.004, 0.0002],
                solref: [0.012, 1.35],
                solimp: [0.35, 0.98, 0.0035, 0.5, 2],
                role: 'collision',
                rgba: [0.19, 0.18, 0.20, 1],
              },
              {
                name: 'puja_suede_sleeve',
                type: 'capsule',
                size: [0.0110, 0.022], // Dark-charcoal suede striker wrap leaning 18° against outer bronze lip
                pos: [0, 0, 0],
                euler: [0, -18, 0],
                role: 'visual',
                contype: 0,
                conaffinity: 0,
                rgba: [0.19, 0.18, 0.20, 1],
              },
              {
                name: 'puja_lower_ferrule',
                type: 'cylinder',
                size: [0.0114, 0.0018],
                pos: alongMallet(-0.023),
                euler: [0, -18, 0],
                role: 'visual',
                rgba: [0.82, 0.66, 0.28, 1],
                contype: 0,
                conaffinity: 0,
              },
              {
                name: 'puja_upper_ferrule',
                type: 'cylinder',
                size: [0.0113, 0.0020],
                pos: alongMallet(0.0235),
                euler: [0, -18, 0],
                role: 'visual',
                rgba: [0.84, 0.68, 0.30, 1],
                contype: 0,
                conaffinity: 0,
              },
              {
                name: 'puja_wooden_handle',
                type: 'capsule',
                size: [0.0088, 0.034],
                pos: alongMallet(0.059),
                euler: [0, -18, 0],
                role: 'visual',
                rgba: [0.44, 0.19, 0.11, 1],
                contype: 0,
                conaffinity: 0,
              },
              {
                name: 'puja_handle_pommel',
                type: 'sphere',
                size: [0.0104],
                pos: alongMallet(0.095),
                role: 'visual',
                rgba: [0.38, 0.16, 0.09, 1],
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

  // -------------------------------------------------------------------------
  // 3. Enclosed Stepped Maple Hardwood & Rough Slate Zig-Zag Chute (`x = +0.020 .. +0.360 m`)
  //    Front lane (`y = -0.014 m`) carries cascading steel & glass marbles from Tier 1 -> Tier 2 -> Rocking Trough.
  // -------------------------------------------------------------------------
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
        rgba: [0.82, 0.88, 0.94, 0.20],
      },
      {
        name: 'chute_wall_mid',
        type: 'box',
        size: [0.168, 0.0025, 0.082],
        pos: [0.190, 0.0015, 0.208],
        rgba: [0.82, 0.88, 0.94, 0.20],
      },
      {
        name: 'chute_end_left',
        type: 'box',
        size: [0.0045, 0.017, 0.083],
        pos: [0.024, -0.014, 0.208],
        rgba: [0.54, 0.35, 0.20, 1],
      },
      {
        name: 'chute_end_right',
        type: 'box',
        size: [0.0045, 0.017, 0.083],
        pos: [0.356, -0.014, 0.208],
        rgba: [0.54, 0.35, 0.20, 1],
      },
      // Architectural walnut top cap rails & grounded side standards framing the glass chute
      {
        name: 'chute_cap_rail_front',
        type: 'box',
        size: [0.171, 0.004, 0.0035],
        pos: [0.190, -0.0295, 0.292],
        rgba: [0.32, 0.20, 0.12, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'chute_cap_rail_back',
        type: 'box',
        size: [0.171, 0.004, 0.0035],
        pos: [0.190, 0.0015, 0.292],
        rgba: [0.32, 0.20, 0.12, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'chute_base_plinth',
        type: 'box',
        size: [0.174, 0.056, 0.006],
        pos: [0.190, 0.001, 0.006],
        rgba: [0.24, 0.14, 0.09, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'chute_rear_stanchion_l',
        type: 'box',
        size: [0.005, 0.005, 0.140],
        pos: [0.024, 0.044, 0.146],
        rgba: [0.30, 0.18, 0.11, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'chute_rear_stanchion_r',
        type: 'box',
        size: [0.005, 0.005, 0.140],
        pos: [0.356, 0.044, 0.146],
        rgba: [0.30, 0.18, 0.11, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'chute_stanchion_tie_l',
        type: 'box',
        size: [0.005, 0.024, 0.004],
        pos: [0.024, 0.022, 0.286],
        rgba: [0.30, 0.18, 0.11, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'chute_stanchion_tie_r',
        type: 'box',
        size: [0.005, 0.024, 0.004],
        pos: [0.356, 0.022, 0.286],
        rgba: [0.30, 0.18, 0.11, 1],
        contype: 0,
        conaffinity: 0,
      },
      // Pedestal posts & brass pivot trunnions supporting the rocking trough hinge
      {
        name: 'trough_pedestal_f',
        type: 'box',
        size: [0.026, 0.007, 0.024],
        pos: [0.190, -0.042, 0.030],
        rgba: [0.30, 0.18, 0.11, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'trough_pedestal_b',
        type: 'box',
        size: [0.026, 0.007, 0.024],
        pos: [0.190, 0.044, 0.030],
        rgba: [0.30, 0.18, 0.11, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'trough_brass_bearing_f',
        type: 'cylinder',
        size: [0.007, 0.003],
        pos: [0.190, -0.036, 0.052],
        euler: [90, 0, 0],
        rgba: [0.82, 0.66, 0.28, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: 'trough_brass_bearing_b',
        type: 'cylinder',
        size: [0.007, 0.003],
        pos: [0.190, 0.038, 0.052],
        euler: [90, 0, 0],
        rgba: [0.82, 0.66, 0.28, 1],
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
        rgba: [0.27, 0.30, 0.35, 1],
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
      // Front lane floor (maple hardwood, y_local = -0.014)
      {
        name: 'trough_maple_bed',
        type: 'box',
        size: [0.164, 0.013, 0.004],
        pos: [0, -0.014, 0],
        friction: [0.35, 0.003, 0.0001],
        rgba: [0.75, 0.52, 0.29, 1],
      },
      // Back lane floor (low-mu honed slate rail so flat stone puck glides at ±9.5° tilt!)
      {
        name: 'trough_slate_bed',
        type: 'box',
        size: [0.164, 0.013, 0.004],
        pos: [0, 0.016, 0],
        friction: [0.11, 0.002, 0.0001],
        rgba: [0.24, 0.27, 0.32, 1],
      },
      // Three longitudinal lane walls + two end bumpers keeping all marbles & scraper captured forever
      {
        name: 'trough_rail_front',
        type: 'box',
        size: [0.166, 0.0025, 0.018],
        pos: [0, -0.0295, 0.014],
        rgba: [0.54, 0.35, 0.19, 1],
      },
      {
        name: 'trough_rail_divider',
        type: 'box',
        size: [0.166, 0.0025, 0.018],
        pos: [0, 0.001, 0.014],
        rgba: [0.54, 0.35, 0.19, 1],
      },
      {
        name: 'trough_rail_back',
        type: 'box',
        size: [0.166, 0.0025, 0.018],
        pos: [0, 0.0315, 0.014],
        rgba: [0.54, 0.35, 0.19, 1],
      },
      {
        name: 'trough_bumper_l',
        type: 'box',
        size: [0.004, 0.033, 0.020],
        pos: [-0.162, 0.001, 0.016],
        rgba: [0.44, 0.28, 0.16, 1],
      },
      {
        name: 'trough_bumper_r',
        type: 'box',
        size: [0.004, 0.033, 0.020],
        pos: [0.162, 0.001, 0.016],
        rgba: [0.44, 0.28, 0.16, 1],
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
