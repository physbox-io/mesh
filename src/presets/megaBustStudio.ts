import type { SceneGraph } from '../types/scene';

// Generate high-resolution procedural bust mesh
function generateHighPolyBustMesh(slices = 100, stacks = 70): { vertices: number[]; faces: number[] } {
  const vertices: number[] = [];
  const faces: number[] = [];

  for (let i = 0; i <= stacks; ++i) {
    const v = i / stacks;
    const z = v * 0.16; // 16cm height (Z-up in meters)

    for (let j = 0; j <= slices; ++j) {
      const u = j / slices;
      const theta = u * Math.PI * 2;

      let r = 0.02;

      if (z < 0.02) {
        // Pedestal base
        r = 0.038 - 0.005 * (z / 0.02) + 0.003 * Math.cos(z * 400);
      } else if (z < 0.06) {
        // Shoulders & Chest
        const st = (z - 0.02) / 0.04;
        const w = 0.055 * (1 - st * 0.35);
        const d = 0.028 * (1 - st * 0.3);
        r = Math.sqrt(Math.pow(w * Math.sin(theta), 2) + Math.pow(d * Math.cos(theta), 2));
      } else if (z < 0.09) {
        // Neck
        const nt = (z - 0.06) / 0.03;
        r = 0.022 - 0.003 * Math.sin(nt * Math.PI);
      } else if (z < 0.13) {
        // Head & Facial features
        const ht = (z - 0.09) / 0.04;
        r = 0.028 + 0.006 * Math.sin(ht * Math.PI);
        const front = Math.cos(theta);
        const side = Math.sin(theta);
        if (front > 0) {
          // Nose & Chin
          if (z >= 0.10 && z <= 0.12 && Math.abs(side) < 0.3) {
            r += 0.012 * (1 - Math.abs(side) / 0.3) * Math.sin(((z - 0.10) / 0.02) * Math.PI);
          }
          if (z >= 0.092 && z <= 0.10) {
            r += 0.008 * front * Math.sin(((z - 0.092) / 0.008) * Math.PI);
          }
        }
      } else {
        // Cranium dome & curls
        const dt = (z - 0.13) / 0.03;
        r = 0.03 * Math.sqrt(Math.max(0, 1 - dt * dt));
        r += 0.0025 * Math.sin(theta * 12) * Math.cos(z * 80);
      }

      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);

      // Three.js / MuJoCo coordinates (X, Y, Z)
      vertices.push(x, y, z);
    }
  }

  for (let i = 0; i < stacks; ++i) {
    for (let j = 0; j < slices; ++j) {
      const first = i * (slices + 1) + j;
      const second = first + slices + 1;

      faces.push(first, second, first + 1);
      faces.push(second, second + 1, first + 1);
    }
  }

  return { vertices, faces };
}

const bustMeshData = generateHighPolyBustMesh(120, 80);

export const megaBustStudioPreset: SceneGraph = {
  nodes: [
    // 1. Classical High-Poly Sculpted Bust
    {
      id: 'classical_bust_sculpt',
      name: 'Classical Marble Sculpt (High-Poly)',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        {
          name: 'bust_mesh_geom',
          type: 'mesh',
          size: [1, 1, 1],
          pos: [0, 0, 0],
          rgba: [0.92, 0.90, 0.86, 1.0],
          vertices: bustMeshData.vertices,
          faces: bustMeshData.faces,
          mass: 1.2,
          friction: [0.6, 0.005, 0.0001]
        }
      ],
      children: []
    },

    // 2. Wrecking Ball Trigger Pendulum
    {
      id: 'wrecking_pendulum_base',
      name: 'Wrecking Ball Trigger Stand',
      type: 'body',
      pos: [-0.35, 0.15, 0.28],
      joints: [],
      geoms: [
        { name: 'stand_post', type: 'cylinder', size: [0.008, 0.14], pos: [0, 0, 0], rgba: [0.35, 0.38, 0.45, 1], contype: 0, conaffinity: 0 }
      ],
      children: [
        {
          id: 'pendulum_arm',
          name: 'Pendulum Release Arm',
          type: 'body',
          pos: [0, 0, 0.14],
          joints: [
            { name: 'pendulum_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.0005 }
          ],
          geoms: [
            { name: 'tether', type: 'capsule', fromto: [0, 0, 0, 0.18, 0, 0], size: [0.003], mass: 0.02, rgba: [0.8, 0.8, 0.8, 1] },
            { name: 'steel_bob', type: 'sphere', size: [0.025], pos: [0.18, 0, 0], mass: 0.8, rgba: [0.2, 0.75, 0.95, 1], friction: [0.2, 0.001, 0.0001] }
          ],
          children: []
        }
      ]
    },

    // 3. Multi-tier Physics Collapse Tower (24 interacting rigid blocks)
    ...Array.from({ length: 8 }).flatMap((_, tier) => {
      const z = 0.015 + tier * 0.032;
      const isEven = tier % 2 === 0;
      return [
        {
          id: `tower_block_${tier}_1`,
          name: `Tower Block T${tier}A`,
          type: 'body' as const,
          pos: [0.25 + (isEven ? -0.025 : 0), -0.05 + (isEven ? 0 : -0.025), z] as [number, number, number],
          joints: [{ name: `free_j_${tier}_1`, type: 'free' as const }],
          geoms: [
            {
              name: `geom_t_${tier}_1`,
              type: 'box' as const,
              size: isEven ? [0.012, 0.045, 0.014] : [0.045, 0.012, 0.014],
              mass: 0.08,
              rgba: [0.35 + tier * 0.06, 0.65 - tier * 0.04, 0.85, 1.0],
              friction: [0.5, 0.005, 0.0001]
            }
          ],
          children: []
        },
        {
          id: `tower_block_${tier}_2`,
          name: `Tower Block T${tier}B`,
          type: 'body' as const,
          pos: [0.25 + (isEven ? 0.025 : 0), -0.05 + (isEven ? 0 : 0.025), z] as [number, number, number],
          joints: [{ name: `free_j_${tier}_2`, type: 'free' as const }],
          geoms: [
            {
              name: `geom_t_${tier}_2`,
              type: 'box' as const,
              size: isEven ? [0.012, 0.045, 0.014] : [0.045, 0.012, 0.014],
              mass: 0.08,
              rgba: [0.85, 0.45 + tier * 0.05, 0.35, 1.0],
              friction: [0.5, 0.005, 0.0001]
            }
          ],
          children: []
        }
      ];
    }),

    // 4. Domino Arc Cascade (16 dominoes curving around the plinth)
    ...Array.from({ length: 16 }).map((_, idx) => {
      const angle = (idx / 16) * Math.PI * 1.5 - 0.4;
      const radius = 0.18;
      const x = radius * Math.cos(angle);
      const y = radius * Math.sin(angle);
      const z = 0.025;
      const rotZ = (angle * 180) / Math.PI + 90;

      return {
        id: `domino_${idx}`,
        name: `Domino #${idx + 1}`,
        type: 'body' as const,
        pos: [x, y, z] as [number, number, number],
        euler: [idx === 0 ? 15 : 0, 0, rotZ] as [number, number, number], // first domino has initial trigger lean
        joints: [{ name: `dom_joint_${idx}`, type: 'free' as const }],
        geoms: [
          {
            name: `dom_geom_${idx}`,
            type: 'box' as const,
            size: [0.006, 0.018, 0.024],
            mass: 0.04,
            rgba: idx % 2 === 0 ? [0.95, 0.25, 0.35, 1.0] : [0.15, 0.16, 0.20, 1.0],
            friction: [0.7, 0.005, 0.0001]
          }
        ],
        children: []
      };
    })
  ]
};
