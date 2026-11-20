import type { SceneGraph, SceneNode } from '../types/scene';
import type { ClothEdge, UV } from '../types/cloth';

/**
 * Coastal Flagpole Aeroacoustics Showcase (`flag_in_wind`):
 *
 * Pairs an ultralight 55 g/m² marine ripstop nylon signal ensign (0.92 × 0.56 m,
 * bright ~2.8 kHz trailing-edge whip-crackle & ~5.3 kHz weave rustle) above a
 * heavy 400 g/m² cotton duck canvas regatta burgee (0.46 × 0.26 m, warm ~500 Hz
 * thwack & ~2.2 kHz rustle) on a hollow Ø54 mm anodized aluminum mast with a
 * taut Ø6 mm stainless halyard stay and hinged brass halyard shackle.
 */

const MARITIME_ENSIGN_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100">',
  '<rect width="100" height="100" fill="#0f294a"/>',
  '<rect x="50" y="0" width="50" height="50" fill="#dc2626"/>',
  '<rect x="0" y="50" width="50" height="50" fill="#dc2626"/>',
  '<rect x="0" y="42" width="100" height="16" fill="#f8fafc"/>',
  '<rect x="38" y="0" width="14" height="100" fill="#f8fafc"/>',
  '<rect x="0" y="46" width="100" height="8" fill="#f59e0b"/>',
  '<rect x="41.5" y="0" width="7" height="100" fill="#f59e0b"/>',
  '<polygon points="45,35 55,50 45,65 35,50" fill="#0f294a"/>',
  '<polygon points="45,39 51.5,50 45,61 38.5,50" fill="#fef08a"/>',
  '<rect x="0" y="0" width="6.5" height="100" fill="#f1f5f9"/>',
  '<line x1="6.5" y1="0" x2="6.5" y2="100" stroke="#cbd5e1" stroke-width="0.8"/>',
  '</svg>',
].join('');

const REGATTA_BURGEE_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 100 100">',
  '<rect width="100" height="100" fill="#f5efe2"/>',
  '<polygon points="0,0 100,50 0,100 0,80 68,50 0,20" fill="#17355e"/>',
  '<polygon points="28,39 44,50 28,61 16,50" fill="#c82829"/>',
  '<rect x="0" y="0" width="8" height="100" fill="#e7decb"/>',
  '</svg>',
].join('');

function rectFlagEdges(w: number, h: number): ClothEdge[] {
  const hw = w / 2;
  const hh = h / 2;
  const c: UV[] = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ];
  const ids = ['bottom', 'fly', 'top', 'hoist'];
  return ids.map((id, i) => ({ id, pts: [c[i], c[(i + 1) % 4]] }));
}

function taperedBurgeeEdges(w: number, hoistH: number, tipH: number): ClothEdge[] {
  const hw = w / 2;
  const h0 = hoistH / 2;
  const h1 = tipH / 2;
  return [
    { id: 'bottom', pts: [[-hw, -h0], [hw, -h1]] },
    { id: 'fly', pts: [[hw, -h1], [hw, h1]] },
    { id: 'top', pts: [[hw, h1], [-hw, h0]] },
    { id: 'hoist', pts: [[-hw, h0], [-hw, -h0]] },
  ];
}

function buildFlagInWindScene(): SceneGraph {
  const plinth: SceneNode = {
    id: 'flagpole_plinth',
    name: 'flagpole_plinth',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'stone',
    joints: [],
    geoms: [
      {
        name: 'plinth_granite_base',
        type: 'box',
        size: [0.19, 0.19, 0.045],
        pos: [0, 0, 0.045],
        rgba: [0.42, 0.44, 0.48, 1],
      },
      {
        name: 'plinth_granite_tier',
        type: 'box',
        size: [0.135, 0.135, 0.03],
        pos: [0, 0, 0.12],
        rgba: [0.49, 0.51, 0.55, 1],
      },
      {
        name: 'plinth_bronze_collar',
        type: 'cylinder',
        size: [0.062, 0.015],
        pos: [0, 0, 0.165],
        rgba: [0.64, 0.49, 0.24, 1],
      },
    ],
    children: [],
  };

  // At 0.56 m hoist height and 0.04 m spacing, `resample` divides `hoist` into 14 equal segments;
  // `at: 0.5` selects the exact midpoint vertex 7/14 at local v = 0 (world z = ensignCenterZ).
  const ensignCenterZ = 2.20;
  const ensignTopZ = ensignCenterZ + 0.28;
  const ensignMidZ = ensignCenterZ;
  const ensignBotZ = ensignCenterZ - 0.28;

  const burgeeCenterZ = 1.41;
  const burgeeTopZ = burgeeCenterZ + 0.13;
  const burgeeBotZ = burgeeCenterZ - 0.13;

  const flagpole: SceneNode = {
    id: 'flagpole',
    name: 'flagpole',
    type: 'body',
    pos: [0, 0, 0],
    deformMaterial: 'softMetal',
    joints: [],
    geoms: [
      // Main Ø54 mm hollow anodized aluminum mast (z = 0.18..2.55 m, L/D = 43.9)
      {
        name: 'mast_main',
        type: 'cylinder',
        size: [0.027, 1.185],
        pos: [0, 0, 1.365],
        rgba: [0.80, 0.83, 0.88, 1],
      },
      // Stepped Ø64 mm lower mast sleeve (z = 0.18..0.62 m, L/D = 6.88)
      {
        name: 'mast_base_sleeve',
        type: 'cylinder',
        size: [0.032, 0.22],
        pos: [0, 0, 0.40],
        rgba: [0.71, 0.75, 0.80, 1],
      },
      // 3 mm wall internal hollow bore for 3D structural tube modes & cavity FIR
      {
        name: 'mast_hollow_bore',
        type: 'cylinder',
        size: [0.024, 1.16],
        pos: [0, 0, 1.365],
        csg: 'difference',
      },
      // Taut Ø6 mm stainless halyard stay (z = 0.70..2.54 m, L/D = 307 -> crisp coastal Strouhal hum)
      {
        name: 'halyard_stay',
        type: 'capsule',
        fromto: [0, -0.036, 0.70, 0, -0.034, 2.54],
        size: [0.003],
        rgba: [0.86, 0.88, 0.91, 1],
      },
      // Masthead brass truck, spun brass finial ball, horn cleat & halyard hardware
      {
        name: 'mast_truck',
        type: 'cylinder',
        size: [0.033, 0.012],
        pos: [0, 0, 2.562],
        rgba: [0.85, 0.68, 0.24, 1],
        role: 'visual',
      },
      {
        name: 'mast_finial_ball',
        type: 'sphere',
        size: [0.040],
        pos: [0, 0, 2.608],
        rgba: [0.94, 0.79, 0.30, 1],
        role: 'visual',
      },
      {
        name: 'halyard_belay_cleat',
        type: 'capsule',
        fromto: [-0.036, 0, 0.65, -0.036, 0, 0.76],
        size: [0.0045],
        rgba: [0.85, 0.68, 0.24, 1],
        role: 'visual',
      },
      {
        name: 'hoist_halyard_line',
        type: 'capsule',
        fromto: [0.032, 0, 0.72, 0.032, 0, 2.54],
        size: [0.0018],
        rgba: [0.92, 0.90, 0.84, 1],
        role: 'visual',
      },
      ...[ensignTopZ, ensignMidZ, ensignBotZ, burgeeTopZ, burgeeBotZ].map((z, idx) => ({
        name: `hoist_snap_hook_${idx + 1}`,
        type: 'sphere' as const,
        size: [0.0045],
        pos: [0.032, 0, z],
        rgba: [0.90, 0.74, 0.26, 1],
        role: 'visual' as const,
      })),
    ],
    children: [
      {
        id: 'halyard_shackle',
        name: 'halyard_shackle',
        type: 'body',
        pos: [-0.039, 0, 1.18],
        deformMaterial: 'steel',
        joints: [
          {
            name: 'halyard_shackle_hinge',
            type: 'hinge',
            axis: [0, 1, 0],
            pos: [0, 0, 0],
            stiffness: 0.0035,
            damping: 0.00025,
            limited: true,
            range: [-30, 22],
          },
        ],
        geoms: [
          {
            name: 'shackle_drop_lanyard',
            type: 'capsule',
            fromto: [0, 0, 0, 0, 0, -0.185],
            size: [0.002],
            mass: 0.002,
            rgba: [0.88, 0.89, 0.92, 1],
            contype: 0,
            conaffinity: 0,
          },
          // 7.5 mm clear of the Ø54 mm mast at t = 0 (ncon === 0), swings downwind to clink on the mast
          {
            name: 'shackle_brass_clew',
            type: 'box',
            size: [0.0045, 0.012, 0.017],
            pos: [0, 0, -0.20],
            density: 8500,
            solref: [0.004, 0.18],
            rgba: [0.92, 0.75, 0.26, 1],
          },
        ],
        children: [],
      },
    ],
  };

  // Upper main signal ensign: 0.92 m × 0.56 m ultralight 55 g/m² marine ripstop nylon
  const ensignFlag: SceneNode = {
    id: 'ensign_flag',
    name: 'ensign_flag',
    type: 'body',
    pos: [0.036 + 0.46, 0, ensignCenterZ],
    geoms: [],
    joints: [],
    children: [],
    cloth: {
      material: 'ripstop',
      spacing: 0.04,
      sewTime: 0.05,
      pattern: { svg: MARITIME_ENSIGN_SVG, scale: 1, tile: false },
      pieces: [
        {
          name: 'ensign',
          rgba: [0.86, 0.16, 0.16, 1],
          edges: rectFlagEdges(0.92, 0.56),
          placement: { kind: 'plane', origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
          trims: [
            {
              kind: 'stud',
              along: 'hoist',
              spacing: 0.135,
              size: 0.014,
              offset: 0.012,
              rgba: [0.90, 0.74, 0.26, 1],
            },
          ],
        },
      ],
      ties: [
        { name: 'ensign_hoist_top', piece: 'ensign', edge: 'hoist', at: 0, to: 'flagpole', anchor: [0.035, 0, ensignTopZ] },
        { name: 'ensign_hoist_mid', piece: 'ensign', edge: 'hoist', at: 0.5, to: 'flagpole', anchor: [0.035, 0, ensignMidZ] },
        { name: 'ensign_hoist_bot', piece: 'ensign', edge: 'bottom', at: 0, to: 'flagpole', anchor: [0.035, 0, ensignBotZ] },
      ],
    },
  };

  // Lower regatta burgee pennant: 0.46 m × 0.26 m heavy 400 g/m² cotton duck canvas
  const burgeePennant: SceneNode = {
    id: 'burgee_pennant',
    name: 'burgee_pennant',
    type: 'body',
    pos: [0.036 + 0.23, 0, burgeeCenterZ],
    geoms: [],
    joints: [],
    children: [],
    cloth: {
      material: 'canvas',
      spacing: 0.044,
      sewTime: 0.05,
      pattern: { svg: REGATTA_BURGEE_SVG, scale: 1, tile: false },
      pieces: [
        {
          name: 'burgee',
          rgba: [0.96, 0.94, 0.89, 1],
          edges: taperedBurgeeEdges(0.46, 0.26, 0.08),
          placement: { kind: 'plane', origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
          trims: [
            {
              kind: 'stud',
              along: 'hoist',
              spacing: 0.11,
              size: 0.012,
              offset: 0.01,
              rgba: [0.88, 0.72, 0.26, 1],
            },
          ],
        },
      ],
      ties: [
        { name: 'burgee_hoist_top', piece: 'burgee', edge: 'hoist', at: 0, to: 'flagpole', anchor: [0.035, 0, burgeeTopZ] },
        { name: 'burgee_hoist_bot', piece: 'burgee', edge: 'bottom', at: 0, to: 'flagpole', anchor: [0.035, 0, burgeeBotZ] },
      ],
    },
  };

  return {
    nodes: [plinth, flagpole, ensignFlag, burgeePennant],
  };
}

let cachedNodes: SceneNode[] | undefined;

export const flagInWindPreset: SceneGraph = {
  get nodes() {
    cachedNodes ??= buildFlagInWindScene().nodes;
    return cachedNodes;
  },
  set nodes(v: SceneNode[]) {
    cachedNodes = v;
  },
} as SceneGraph;
