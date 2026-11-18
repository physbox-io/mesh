import type { SceneGraph, SceneNode } from '../types/scene';

/**
 * Sweeps a hollow circular cross-section `[rInner(i), rOuter(i)]` along a smooth
 * 3D spine curve `spine[0..N]` using parallel-transport (Bishop) frames, capped
 * cleanly with annular rings at both ends so the resulting mesh is 100% manifold,
 * watertight, and outward-wound (`volume > 0`).
 */
function buildSweptHollowTubeMesh(
  spine: [number, number, number][],
  rOuter: number[],
  rInner: number[],
  nSeg = 26,
): { vertices: number[]; renderVertices: number[]; faces: number[] } {
  const nPts = spine.length;
  const vertices: number[] = [];
  const faces: number[] = [];

  const sub = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
    a[0] - b[0],
    a[1] - b[1],
    a[2] - b[2],
  ];
  const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: [number, number, number], b: [number, number, number]): number =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const norm = (v: [number, number, number]): [number, number, number] => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };

  // Compute smooth unit tangents T[i]
  const tangents: [number, number, number][] = [];
  for (let i = 0; i < nPts; i++) {
    const prev = spine[Math.max(0, i - 1)];
    const next = spine[Math.min(nPts - 1, i + 1)];
    tangents.push(norm(sub(next, prev)));
  }

  // Parallel-transport orthonormal frames (T_i, N_i, B_i) with T_i x N_i = B_i (det = +1)
  const normals: [number, number, number][] = [];
  const binormals: [number, number, number][] = [];
  const t0 = tangents[0];
  const seed: [number, number, number] = Math.abs(t0[1]) < 0.85 ? [0, 1, 0] : [0, 0, 1];
  let bCur = norm(cross(t0, seed));
  let nCur = norm(cross(bCur, t0)); // T x N = T x (B x T) = B
  normals.push(nCur);
  binormals.push(bCur);

  for (let i = 1; i < nPts; i++) {
    const t = tangents[i];
    const dtn = dot(nCur, t);
    let nProj: [number, number, number] = [
      nCur[0] - dtn * t[0],
      nCur[1] - dtn * t[1],
      nCur[2] - dtn * t[2],
    ];
    if (Math.hypot(nProj[0], nProj[1], nProj[2]) < 1e-5) {
      nProj = cross(bCur, t);
    }
    nCur = norm(nProj);
    bCur = norm(cross(t, nCur));
    normals.push(nCur);
    binormals.push(bCur);
  }

  const pushPt = (x: number, y: number, z: number) => {
    vertices.push(+x.toFixed(6), +y.toFixed(6), +z.toFixed(6));
  };

  // Outer wall rings [0 .. nPts * nSeg - 1]
  for (let i = 0; i < nPts; i++) {
    const c = spine[i];
    const n = normals[i];
    const b = binormals[i];
    const ro = rOuter[i];
    for (let j = 0; j < nSeg; j++) {
      const th = (j / nSeg) * Math.PI * 2;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      pushPt(
        c[0] + ro * (ct * n[0] + st * b[0]),
        c[1] + ro * (ct * n[1] + st * b[1]),
        c[2] + ro * (ct * n[2] + st * b[2]),
      );
    }
  }

  // Inner airway rings [innerOffset .. 2 * nPts * nSeg - 1]
  const innerOffset = nPts * nSeg;
  for (let i = 0; i < nPts; i++) {
    const c = spine[i];
    const n = normals[i];
    const b = binormals[i];
    const ri = rInner[i];
    for (let j = 0; j < nSeg; j++) {
      const th = (j / nSeg) * Math.PI * 2;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      pushPt(
        c[0] + ri * (ct * n[0] + st * b[0]),
        c[1] + ri * (ct * n[1] + st * b[1]),
        c[2] + ri * (ct * n[2] + st * b[2]),
      );
    }
  }

  // 1. Outer wall quads: e_theta x T = +e_r (outward!) -> (a, c, b), (a, d, c)
  for (let i = 0; i + 1 < nPts; i++) {
    for (let j = 0; j < nSeg; j++) {
      const jNext = (j + 1) % nSeg;
      const a = i * nSeg + j;
      const b = (i + 1) * nSeg + j;
      const c = (i + 1) * nSeg + jNext;
      const d = i * nSeg + jNext;
      faces.push(a, c, b, a, d, c);
    }
  }

  // 2. Inner airway quads: normal -e_r (into airway) -> (a, b, c), (a, c, d)
  for (let i = 0; i + 1 < nPts; i++) {
    for (let j = 0; j < nSeg; j++) {
      const jNext = (j + 1) % nSeg;
      const a = innerOffset + i * nSeg + j;
      const b = innerOffset + (i + 1) * nSeg + j;
      const c = innerOffset + (i + 1) * nSeg + jNext;
      const d = innerOffset + i * nSeg + jNext;
      faces.push(a, b, c, a, c, d);
    }
  }

  // 3. Start annular cap at i = 0 (outward normal -T_0)
  for (let j = 0; j < nSeg; j++) {
    const jNext = (j + 1) % nSeg;
    const o0 = j;
    const o1 = jNext;
    const i0 = innerOffset + j;
    const i1 = innerOffset + jNext;
    faces.push(o0, i1, o1, o0, i0, i1);
  }

  // 4. End annular rim at i = nPts - 1 (outward normal +T_{N-1})
  const topOut = (nPts - 1) * nSeg;
  const topIn = innerOffset + (nPts - 1) * nSeg;
  for (let j = 0; j < nSeg; j++) {
    const jNext = (j + 1) % nSeg;
    const o0 = topOut + j;
    const o1 = topOut + jNext;
    const i0 = topIn + j;
    const i1 = topIn + jNext;
    faces.push(o0, o1, i1, o0, i1, i0);
  }

  // Convert Z-up `renderVertices` [x, y, z] -> Three.js Y-up `vertices` [x, z, -y]
  const yUpVertices = new Array<number>(vertices.length);
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    yUpVertices[i] = vertices[i];
    yUpVertices[i + 1] = vertices[i + 2];
    yUpVertices[i + 2] = -vertices[i + 1];
  }

  return { vertices: yUpVertices, renderVertices: vertices, faces };
}

/** Smoothly flared Grenadilla clarinet bell mesh (x = +0.135 .. +0.215 m). */
function generateClarinetBellMesh() {
  const n = 18;
  const spine: [number, number, number][] = [];
  const rOut: number[] = [];
  const rIn: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    spine.push([0.135 + u * 0.080, 0, 0]);
    const flare = Math.pow(u, 2.25);
    rOut.push(0.0145 + 0.0185 * flare);
    // Seamless 12.3 mm inner airway matching the 14.5 mm barrel (`14.5 - 2.2 = 12.3 mm`), flaring to 30.5 mm!
    rIn.push(0.0123 + 0.0182 * flare);
  }
  return buildSweptHollowTubeMesh(spine, rOut, rIn, 24);
}

/**
 * Generates a continuous, smooth, folded 3-valve cornet / trumpet tubing & Bessel-bell mesh:
 *   1. Leadpipe (`x = -0.175 -> +0.105, y = -0.011, z = +0.012`)
 *   2. Smooth 180° front tuning-slide bow (`x = +0.105` around `z = -0.008`, `R = 0.020`)
 *   3. Lower valve-loop branch (`x = +0.105 -> -0.115, y = -0.004, z = -0.028`)
 *   4. Smooth 180° back bell-bow (`x = -0.115`, curving cleanly to `y = +0.012, z = +0.024`)
 *   5. Upper bell branch (`x = -0.115 -> +0.205, y = +0.012, z = +0.024`) flaring into a Ø112 mm Bessel bell!
 */
function generateFoldedCornetMesh() {
  const spine: [number, number, number][] = [];

  // 1. Leadpipe (14 pts)
  for (let i = 0; i < 14; i++) {
    const u = i / 14;
    spine.push([-0.175 + u * 0.280, -0.011, 0.012]);
  }
  // 2. Front 180° bow (14 pts)
  for (let i = 0; i <= 14; i++) {
    const u = i / 14;
    const ang = Math.PI * 0.5 - u * Math.PI; // +pi/2 -> -pi/2
    spine.push([
      0.105 + 0.020 * Math.cos(ang),
      -0.011 + 0.007 * u,
      -0.008 + 0.020 * Math.sin(ang),
    ]);
  }
  // 3. Lower branch right-to-left (14 pts)
  for (let i = 1; i < 14; i++) {
    const u = i / 14;
    spine.push([0.105 - u * 0.220, -0.004, -0.028]);
  }
  // 4. Back 180° bell bow (16 pts)
  for (let i = 0; i <= 16; i++) {
    const u = i / 16;
    const ang = -Math.PI * 0.5 - u * Math.PI; // -pi/2 -> -3pi/2
    spine.push([
      -0.115 + 0.026 * Math.cos(ang),
      -0.004 + 0.018 * u,
      -0.002 + 0.026 * Math.sin(ang),
    ]);
  }
  // 5. Upper bell branch & Bessel horn flare (26 pts)
  for (let i = 1; i <= 26; i++) {
    const u = i / 26;
    spine.push([-0.115 + u * 0.320, 0.014, 0.024]);
  }

  const nPts = spine.length;
  const rOut: number[] = [];
  const rIn: number[] = [];
  for (let i = 0; i < nPts; i++) {
    const s = i / (nPts - 1);
    // Gradual conical taper through leadpipe & bows, then dramatic Bessel flare on final bell branch!
    const bellProgress = Math.max(0, (s - 0.72) / 0.28);
    const besselFlare = Math.pow(bellProgress, 2.85);
    const ri = 0.0052 + 0.0026 * s + 0.046 * besselFlare;
    const wall = 0.0012 + 0.0005 * (1 - bellProgress);
    rIn.push(ri);
    rOut.push(ri + wall);
  }

  return buildSweptHollowTubeMesh(spine, rOut, rIn, 26);
}

/**
 * Keyed Grenadilla Clarinet & 3-Valve Spun-Brass Cornet Duet:
 * Showcases low-CPU 1D Kelly–Lochbaum bore waveguides (~0.14% CPU, zero percussion clacks!):
 *   - Front: Ebony & nickel-silver Clarinet (cylindrical bore -> warm woody odd harmonics)
 *     with 4 animated silver pad keys playing a lyrical chalumeau melody.
 *   - Back: Folded 3-valve Brass Cornet (Bessel-flared horn + regenerative lip-reed -> rich
 *     complete brass overtone series) with 3 animated pearl-button piston valves answering in a fanfare!
 */
export const windInstrumentsPreset: SceneGraph = (() => {
  const clarinetBellMesh = generateClarinetBellMesh();
  const cornetHornMesh = generateFoldedCornetMesh();

  // Articulated silver clarinet pad key along top keywork rod
  const makeClarinetKey = (idx: number, xHole: number): SceneNode => ({
    id: `clarinet_key_body_${idx}`,
    name: `Silver Key ${idx}`,
    type: 'body',
    pos: [xHole, -0.015, 0.014],
    deformMaterial: 'softMetal',
    joints: [
      {
        name: `clarinet_key_${idx}`,
        type: 'hinge',
        axis: [1, 0, 0],
        pos: [0, 0, 0],
        stiffness: 1.8,
        springref: 0,
        damping: 0.08,
        limited: true,
        range: [0, 22],
      },
    ],
    geoms: [
      {
        name: `clar_key_lever_${idx}`,
        type: 'capsule',
        fromto: [0, 0, 0, 0, 0.015, 0.002],
        size: [0.0018],
        mass: 0.006,
        rgba: [0.88, 0.90, 0.95, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: `clar_pad_cup_${idx}`,
        type: 'cylinder',
        pos: [0, 0.015, 0.001],
        size: [0.0062, 0.0016],
        mass: 0.008,
        rgba: [0.91, 0.93, 0.97, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [],
  });

  // Animated vertical silver & mother-of-pearl brass cornet piston valve
  const makeCornetPistonValve = (idx: number, xPos: number): SceneNode => ({
    id: `cornet_valve_body_${idx}`,
    name: `Piston Valve ${idx}`,
    type: 'body',
    pos: [xPos, -0.004, 0.026],
    deformMaterial: 'softMetal',
    joints: [
      {
        name: `cornet_valve_${idx}`,
        type: 'slide',
        axis: [0, 0, -1],
        pos: [0, 0, 0],
        stiffness: 38,
        springref: 0,
        damping: 1.8,
        limited: true,
        range: [0, 0.013],
      },
    ],
    geoms: [
      {
        name: `valve_stem_${idx}`,
        type: 'cylinder',
        pos: [0, 0, 0.009],
        size: [0.0032, 0.011],
        mass: 0.012,
        rgba: [0.88, 0.90, 0.94, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: `valve_cap_${idx}`,
        type: 'cylinder',
        pos: [0, 0, 0.020],
        size: [0.0076, 0.0020],
        mass: 0.005,
        rgba: [0.90, 0.76, 0.30, 1],
        contype: 0,
        conaffinity: 0,
      },
      {
        name: `pearl_inlay_${idx}`,
        type: 'cylinder',
        pos: [0, 0, 0.0218],
        size: [0.0058, 0.0008],
        mass: 0.002,
        rgba: [0.97, 0.96, 0.92, 1],
        contype: 0,
        conaffinity: 0,
      },
    ],
    children: [],
  });

  // 1. Keyed Grenadilla & Nickel-Silver Clarinet (front cradle, y = -0.082 m)
  const clarinet: SceneNode = {
    id: 'grenadilla_clarinet',
    name: 'Grenadilla Clarinet (Single Reed)',
    type: 'body',
    pos: [0, -0.082, 0.072],
    deformMaterial: 'hardwood',
    collision: 'hull',
    windInstrument: {
      exciter: 'reed',
      breathKPa: 0,
      embouchureHz: 260,
      toneholeJoints: [
        { jointName: 'clarinet_key_1', axialFraction: 0.578, diameterMm: 10.5 },
        { jointName: 'clarinet_key_2', axialFraction: 0.652, diameterMm: 10.5 },
        { jointName: 'clarinet_key_3', axialFraction: 0.781, diameterMm: 11.0 },
        { jointName: 'clarinet_key_4', axialFraction: 0.880, diameterMm: 11.5 },
      ],
    },
    script: `// Seconds 0.0 .. 4.4 of each 9s duet cycle: warm woody G-major chalumeau melody with real keywork fingerings!
const tCycle = api.getTime() % 9.0;
if (tCycle < 4.4) {
  // 7 lyrical notes in G major pentatonic (G3, A3, B3, D4, E4, B3, G3):
  const phrases = [
    // [durSec, openKeysMask (bit0=key1..bit3=key4), breathKPa]
    [0.62, 0b0000, 2.9], // G3 (196.0 Hz — all pads sealed)
    [0.60, 0b1000, 3.0], // A3 (220.0 Hz — key 4 open)
    [0.60, 0b1100, 3.1], // B3 (246.9 Hz — keys 3,4 open)
    [0.62, 0b1110, 3.2], // D4 (293.7 Hz — keys 2,3,4 open)
    [0.64, 0b1111, 3.3], // E4 (329.6 Hz — all 4 keys open)
    [0.56, 0b1100, 3.0], // B3 (246.9 Hz — keys 3,4 open)
    [0.76, 0b0000, 2.8], // G3 (196.0 Hz — warm tonic cadence)
  ];
  let cursor = 0;
  let mask = 0;
  let env = 0;
  for (let i = 0; i < phrases.length; i++) {
    const dur = phrases[i][0];
    if (tCycle >= cursor && tCycle < cursor + dur) {
      const u = (tCycle - cursor) / dur;
      // Keys move during the brief 4% tongued break so pads are seated cleanly before breath rises!
      const tongue = u < 0.045 ? 0 : u < 0.12 ? (u - 0.045) / 0.075 : u > 0.90 ? (1 - u) / 0.10 : 1.0;
      env = phrases[i][2] * tongue;
      mask = phrases[i][1];
      break;
    }
    cursor += dur;
  }
  const st = api.state || (api.state = {});
  st.breathKPa = env;
  if (mask & 1) api.applyJointForce('clarinet_key_1', 0.65);
  if (mask & 2) api.applyJointForce('clarinet_key_2', 0.65);
  if (mask & 4) api.applyJointForce('clarinet_key_3', 0.65);
  if (mask & 8) api.applyJointForce('clarinet_key_4', 0.65);
} else {
  const st = api.state || (api.state = {});
  st.breathKPa = 0;
}
`,
    joints: [],
    geoms: [
      // Tapered ebonite mouthpiece + blonde cane reed + twin silver ligature rings
      { name: 'clar_mouthpiece', type: 'capsule', fromto: [-0.2106, 0, 0.002, -0.168, 0, 0], size: [0.0115], rgba: [0.10, 0.09, 0.10, 1] },
      { name: 'cane_reed', type: 'box', size: [0.024, 0.0055, 0.0012], pos: [-0.192, 0, -0.0115], rgba: [0.87, 0.73, 0.40, 1], role: 'visual' },
      { name: 'silver_ligature_1', type: 'cylinder', size: [0.0128, 0.0022], pos: [-0.184, 0, 0], euler: [0, 90, 0], rgba: [0.88, 0.90, 0.95, 1], role: 'visual' },
      { name: 'silver_ligature_2', type: 'cylinder', size: [0.0128, 0.0022], pos: [-0.175, 0, 0], euler: [0, 90, 0], rgba: [0.88, 0.90, 0.95, 1], role: 'visual' },
      // Rich Grenadilla wood barrel + upper/lower body
      { name: 'clar_barrel', type: 'cylinder', size: [0.0152, 0.026], pos: [-0.142, 0, 0], euler: [0, 90, 0], rgba: [0.15, 0.11, 0.10, 1] },
      { name: 'clar_body_tube', type: 'cylinder', size: [0.0145, 0.126], pos: [0.010, 0, 0], euler: [0, 90, 0], rgba: [0.14, 0.10, 0.09, 1] },
      // Gleaming nickel-silver tenon & bell ferrules
      { name: 'ferrule_barrel', type: 'cylinder', size: [0.0158, 0.003], pos: [-0.116, 0, 0], euler: [0, 90, 0], rgba: [0.88, 0.90, 0.95, 1], role: 'visual' },
      { name: 'ferrule_center', type: 'cylinder', size: [0.0154, 0.0035], pos: [0.005, 0, 0], euler: [0, 90, 0], rgba: [0.88, 0.90, 0.95, 1], role: 'visual' },
      { name: 'ferrule_bell_top', type: 'cylinder', size: [0.0156, 0.0035], pos: [0.136, 0, 0], euler: [0, 90, 0], rgba: [0.88, 0.90, 0.95, 1], role: 'visual' },
      { name: 'ferrule_bell_rim', type: 'cylinder', size: [0.0335, 0.0025], pos: [0.214, 0, 0], euler: [0, 90, 0], rgba: [0.88, 0.90, 0.95, 1], role: 'visual' },
      // Smoothly flared outward-wound Grenadilla clarinet bell (`dynamic: true` -> body-local Z-up rendering!)
      {
        name: 'clarinet_bell_mesh',
        type: 'mesh',
        dynamic: true,
        size: [1, 1, 1],
        vertices: clarinetBellMesh.vertices,
        renderVertices: clarinetBellMesh.renderVertices,
        faces: clarinetBellMesh.faces,
        rgba: [0.15, 0.11, 0.10, 1],
      },
      // Silver keywork hinge rod + tonehole chimneys
      { name: 'clar_key_rod', type: 'capsule', fromto: [-0.045, -0.015, 0.014, 0.118, -0.015, 0.014], size: [0.0018], rgba: [0.84, 0.87, 0.92, 1], role: 'visual' },
      { name: 'chimney_1', type: 'cylinder', size: [0.0055, 0.0025], pos: [-0.025, 0, 0.0135], rgba: [0.18, 0.13, 0.12, 1], role: 'visual' },
      { name: 'chimney_2', type: 'cylinder', size: [0.0055, 0.0025], pos: [0.016, 0, 0.0135], rgba: [0.18, 0.13, 0.12, 1], role: 'visual' },
      { name: 'chimney_3', type: 'cylinder', size: [0.0058, 0.0025], pos: [0.058, 0, 0.0135], rgba: [0.18, 0.13, 0.12, 1], role: 'visual' },
      { name: 'chimney_4', type: 'cylinder', size: [0.0060, 0.0025], pos: [0.098, 0, 0.0135], rgba: [0.18, 0.13, 0.12, 1], role: 'visual' },
    ],
    children: [
      makeClarinetKey(1, -0.025),
      makeClarinetKey(2, 0.016),
      makeClarinetKey(3, 0.058),
      makeClarinetKey(4, 0.098),
    ],
  };

  // 2. Folded 3-Valve Spun-Brass Cornet / Trumpet (back cradle, y = +0.082 m)
  const cornet: SceneNode = {
    id: 'brass_bugle_horn',
    name: '3-Valve Brass Cornet (Lip-Reed)',
    type: 'body',
    pos: [0, 0.082, 0.086],
    deformMaterial: 'softMetal',
    collision: 'hull',
    windInstrument: {
      exciter: 'brass_lip',
      breathKPa: 0,
      embouchureHz: 392,
      boreLengthM: 0.8573,
      mouthRadiusM: 0.0055,
      bellRadiusM: 0.054,
      flareExponent: 2.75,
      valveJoints: [
        { jointName: 'cornet_valve_1', semitones: 2, strokeM: 0.013 },
        { jointName: 'cornet_valve_2', semitones: 1, strokeM: 0.013 },
        { jointName: 'cornet_valve_3', semitones: 3, strokeM: 0.013 },
      ],
    },
    script: `// Seconds 4.5 .. 8.9 of each 9s duet cycle: G-major brass fanfare answering the clarinet an octave higher!
const tCycle = api.getTime() % 9.0;
if (tCycle >= 4.5 && tCycle < 8.9) {
  const dt = tCycle - 4.5;
  // Exact natural harmonics of the 0.8573 m G3 horn + real 3-piston semitone valve combinations:
  //   G4 (392.0 Hz): Open (0-0-0), mode n=2
  //   A4 (440.0 Hz): Valves 1+3 (-5 st), mode n=3
  //   B4 (493.9 Hz): Valves 1+2 (-3 st), mode n=3
  //   D5 (587.3 Hz): Open (0-0-0), mode n=3
  const fanfare = [
    [0.58, 392, 0b000, 2.9], // G4  (Open)
    [0.58, 494, 0b011, 3.1], // B4  (Valves 1+2)
    [0.62, 587, 0b000, 3.3], // D5  (Open)
    [0.55, 494, 0b011, 3.0], // B4  (Valves 1+2)
    [0.55, 440, 0b101, 2.9], // A4  (Valves 1+3)
    [0.55, 494, 0b011, 3.0], // B4  (Valves 1+2)
    [0.97, 392, 0b000, 2.8], // G4  (Warm sustained resolve)
  ];
  let cursor = 0;
  let vMask = 0;
  let breath = 0;
  let lipHz = 392;
  for (let i = 0; i < fanfare.length; i++) {
    const dur = fanfare[i][0];
    if (dt >= cursor && dt < cursor + dur) {
      const u = (dt - cursor) / dur;
      // Pistons seat during the brief 4.5% tongued gap before breath rises so valved notes never scoop!
      const tongue = u < 0.045 ? 0 : u < 0.13 ? (u - 0.045) / 0.085 : u > 0.88 ? (1 - u) / 0.12 : 1.0;
      breath = fanfare[i][3] * tongue;
      lipHz = fanfare[i][1];
      vMask = fanfare[i][2];
      break;
    }
    cursor += dur;
  }
  const st = api.state || (api.state = {});
  st.breathKPa = breath;
  st.embouchureHz = lipHz;
  if (vMask & 1) api.applyJointForce('cornet_valve_1', 0.90);
  if (vMask & 2) api.applyJointForce('cornet_valve_2', 0.90);
  if (vMask & 4) api.applyJointForce('cornet_valve_3', 0.90);
} else {
  const st = api.state || (api.state = {});
  st.breathKPa = 0;
}
`,
    joints: [],
    geoms: [
      // Continuous outward-wound folded brass cornet tubing & Bessel bell (`dynamic: true` -> body-local Z-up!)
      {
        name: 'cornet_folded_horn',
        type: 'mesh',
        dynamic: true,
        size: [1, 1, 1],
        vertices: cornetHornMesh.vertices,
        renderVertices: cornetHornMesh.renderVertices,
        faces: cornetHornMesh.faces,
        rgba: [0.92, 0.74, 0.25, 1],
      },
      // Turned silver-plated brass cup mouthpiece & shank seated into the leadpipe
      { name: 'silver_mp_shank', type: 'cylinder', size: [0.0056, 0.018], pos: [-0.190, -0.011, 0.012], euler: [0, 90, 0], rgba: [0.89, 0.91, 0.95, 1], role: 'visual' },
      { name: 'silver_mp_cup', type: 'cylinder', size: [0.0112, 0.0085], pos: [-0.212, -0.011, 0.012], euler: [0, 90, 0], rgba: [0.91, 0.93, 0.97, 1], role: 'visual' },
      { name: 'silver_mp_rim', type: 'cylinder', size: [0.0136, 0.0025], pos: [-0.221, -0.011, 0.012], euler: [0, 90, 0], rgba: [0.93, 0.95, 0.98, 1], role: 'visual' },
      // Three vertical brass piston valve casings + valve ports + cross-braces
      { name: 'valve_casing_1', type: 'cylinder', size: [0.0092, 0.032], pos: [-0.026, -0.004, -0.002], rgba: [0.88, 0.70, 0.22, 1], role: 'visual' },
      { name: 'valve_casing_2', type: 'cylinder', size: [0.0092, 0.032], pos: [0.000, -0.004, -0.002], rgba: [0.88, 0.70, 0.22, 1], role: 'visual' },
      { name: 'valve_casing_3', type: 'cylinder', size: [0.0092, 0.032], pos: [0.026, -0.004, -0.002], rgba: [0.88, 0.70, 0.22, 1], role: 'visual' },
      { name: 'valve_bridge_pipe', type: 'capsule', fromto: [-0.030, -0.011, 0.012, 0.030, -0.004, 0.012], size: [0.0055], rgba: [0.88, 0.70, 0.22, 1], role: 'visual' },
      { name: 'bell_brace_1', type: 'capsule', fromto: [-0.026, -0.004, 0.022, -0.026, 0.014, 0.024], size: [0.0025], rgba: [0.85, 0.68, 0.22, 1], role: 'visual' },
      { name: 'bell_brace_2', type: 'capsule', fromto: [0.065, -0.011, 0.012, 0.065, 0.014, 0.024], size: [0.0025], rgba: [0.85, 0.68, 0.22, 1], role: 'visual' },
    ],
    children: [
      makeCornetPistonValve(1, -0.026),
      makeCornetPistonValve(2, 0.000),
      makeCornetPistonValve(3, 0.026),
    ],
  };

  // Sleek dark walnut & matte wrought-iron museum display stand supporting both instruments cleanly
  const stand: SceneNode = {
    id: 'wind_bench_stand',
    name: 'Walnut & Iron Display Stand',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'softwood',
    joints: [],
    geoms: [
      { name: 'stand_base', type: 'box', size: [0.23, 0.135, 0.007], pos: [0, 0, 0.007], rgba: [0.24, 0.16, 0.11, 1] },
      // Slim matte-black iron stems reaching right up to cradle the clarinet barrel & bell neck
      { name: 'clar_cradle_l', type: 'capsule', fromto: [-0.105, -0.082, 0.014, -0.105, -0.082, 0.057], size: [0.0035], rgba: [0.16, 0.17, 0.20, 1], contype: 0, conaffinity: 0 },
      { name: 'clar_yoke_l', type: 'box', size: [0.005, 0.015, 0.003], pos: [-0.105, -0.082, 0.056], rgba: [0.22, 0.23, 0.26, 1], contype: 0, conaffinity: 0 },
      { name: 'clar_cradle_r', type: 'capsule', fromto: [0.115, -0.082, 0.014, 0.115, -0.082, 0.057], size: [0.0035], rgba: [0.16, 0.17, 0.20, 1], contype: 0, conaffinity: 0 },
      { name: 'clar_yoke_r', type: 'box', size: [0.005, 0.015, 0.003], pos: [0.115, -0.082, 0.056], rgba: [0.22, 0.23, 0.26, 1], contype: 0, conaffinity: 0 },
      // Slim matte-black iron stems cradling the cornet's lower brass branch (`z_bottom = 0.086 - 0.034 = 0.052`)
      { name: 'cornet_cradle_l', type: 'capsule', fromto: [-0.085, 0.078, 0.014, -0.085, 0.078, 0.052], size: [0.0038], rgba: [0.16, 0.17, 0.20, 1], contype: 0, conaffinity: 0 },
      { name: 'cornet_yoke_l', type: 'box', size: [0.005, 0.016, 0.003], pos: [-0.085, 0.078, 0.051], rgba: [0.22, 0.23, 0.26, 1], contype: 0, conaffinity: 0 },
      { name: 'cornet_cradle_r', type: 'capsule', fromto: [0.085, 0.078, 0.014, 0.085, 0.078, 0.052], size: [0.0038], rgba: [0.16, 0.17, 0.20, 1], contype: 0, conaffinity: 0 },
      { name: 'cornet_yoke_r', type: 'box', size: [0.005, 0.016, 0.003], pos: [0.085, 0.078, 0.051], rgba: [0.22, 0.23, 0.26, 1], contype: 0, conaffinity: 0 },
    ],
    children: [],
  };

  return { nodes: [stand, clarinet, cornet] };
})();
