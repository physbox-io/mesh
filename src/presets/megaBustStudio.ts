import type { SceneGraph } from '../types/scene';

/**
 * Builds a closed, solid lathe: an outer wall at radiusAt(z, theta), an inner
 * wall at a fraction of that radius (thicknessRatio), and an annulus at each
 * end connecting outer rim to inner rim. Two earlier approaches both turned
 * out wrong for a
 * bust-shaped profile with a genuine concavity (the neck):
 *
 * - A single open-ended wall (no caps at all) lets you see straight through
 *   the opening into the inside of the far wall — which is what first read
 *   as "translucent".
 * - Capping each end with a fan to a single center point closes the opening,
 *   but is still a zero-thickness shell: from an angle that grazes past the
 *   neck's concavity, backface culling on the near wall can still open a
 *   sightline through to empty space. The fan's ~100 thin triangles meeting
 *   at one point are also a numerically delicate structure for shadow
 *   mapping — self-shadow acne came out radiating with the wedges, which is
 *   why it tracked the mesh's rotation relative to the fixed key light.
 *
 * A true thick shell removes both problems at once: there is always solid
 * material behind the outer surface (no cavity to see into from any angle),
 * and there's no single-point fan for the shadow map to alias against — the
 * ends are quad strips, built the same reliable way as the side walls.
 *
 * Winding for each of outer wall / inner wall / bottom annulus / top annulus
 * has to be derived rather than guessed: the inner wall's "away from material"
 * direction is the opposite radial sense from the outer wall's, since they
 * bound a thin gap rather than being a continuation of the same surface. The
 * test this was first checked with — outward-facing normals against the MESH
 * CENTROID — cannot tell you that, because the centroid of a hollow shell sits
 * in its cavity, and every group came out inverted: the bust was rendering
 * from the inside. The check that does work is the one the tests now make, and
 * it is the same one the MJCF compiler makes before it will trust a mesh with
 * its own mass: closed, consistently wound, and a POSITIVE signed volume.
 */
function buildSolidLathe(
  radiusAt: (z: number, theta: number) => number,
  height: number,
  slices: number,
  stacks: number,
  thicknessRatio: number
): { vertices: number[]; faces: number[] } {
  const vertices: number[] = [];
  const faces: number[] = [];
  const N = slices;

  // A proportional thickness, not a fixed absolute offset: near the crown
  // radiusAt already floors near-zero, and a fixed subtraction there just
  // collides with that same floor from the inside — giving a zero-thickness,
  // degenerate band of triangles right where the outer wall gets thinnest.
  // Scaling by a fraction of the local radius instead keeps inner strictly
  // less than outer everywhere the outer radius is positive, with no clamp
  // needed.
  const pushRing = (z: number, isInner: boolean) => {
    // j < slices, not <= : the ring closes by INDEX, wrapping back to its own
    // first vertex. Pushing a duplicate vertex at theta = 2*pi instead leaves a
    // surface that looks closed and is not — the two columns coincide in space
    // but share no edge, so the mesh carried 324 boundary edges straight up the
    // seam, and nothing that asks whether it is watertight could say yes.
    for (let j = 0; j < slices; ++j) {
      const theta = (j / slices) * Math.PI * 2;
      const outerR = radiusAt(z, theta);
      const r = isInner ? outerR * (1 - thicknessRatio) : outerR;
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      // Geom vertices are stored Y-up (three.js); the MJCF builder maps
      // (x, y, z) -> (x, -z, y) for MuJoCo. So the lathe's height goes in Y,
      // not Z, or the bust is compiled lying on its side. The remaining axis
      // is negated rather than swapped so this stays a rotation about X: a
      // bare swap flips the handedness and turns every face inside out.
      vertices.push(x, z, -y);
    }
  };

  const outerBase = 0;
  for (let i = 0; i <= stacks; ++i) pushRing((i / stacks) * height, false);
  const innerBase = vertices.length / 3;
  for (let i = 0; i <= stacks; ++i) pushRing((i / stacks) * height, true);

  /** The next vertex round the ring, wrapping at the seam. */
  const next = (base: number, j: number) => base + ((j + 1) % slices);

  // Outer wall: normals away from the axis.
  for (let i = 0; i < stacks; ++i) {
    const ring = outerBase + i * N;
    for (let j = 0; j < slices; ++j) {
      const a = ring + j, a1 = next(ring, j);
      const b = a + N, b1 = a1 + N;
      faces.push(a, a1, b);
      faces.push(b, a1, b1);
    }
  }
  // Inner wall: the opposite radial sense, since it faces into the cavity.
  for (let i = 0; i < stacks; ++i) {
    const ring = innerBase + i * N;
    for (let j = 0; j < slices; ++j) {
      const a = ring + j, a1 = next(ring, j);
      const b = a + N, b1 = a1 + N;
      faces.push(a, b, a1);
      faces.push(b, b1, a1);
    }
  }
  // Bottom annulus (z = 0 ring), facing down.
  for (let j = 0; j < slices; ++j) {
    const oa = outerBase + j, ob = next(outerBase, j);
    const ia = innerBase + j, ib = next(innerBase, j);
    faces.push(oa, ia, ob);
    faces.push(ia, ib, ob);
  }
  // Top annulus (z = height ring), facing up.
  const topOuter = outerBase + stacks * N;
  const topInner = innerBase + stacks * N;
  for (let j = 0; j < slices; ++j) {
    const oa = topOuter + j, ob = next(topOuter, j);
    const ia = topInner + j, ib = next(topInner, j);
    faces.push(oa, ob, ia);
    faces.push(ia, ob, ib);
  }

  return { vertices, faces };
}

const BUST_WALL_THICKNESS_RATIO = 0.12;

// Generate high-resolution procedural bust mesh
function generateHighPolyBustMesh(slices = 100, stacks = 70): { vertices: number[]; faces: number[] } {
  const radiusAt = (z: number, theta: number) => {
    if (z < 0.02) {
      // Pedestal base
      return 0.038 - 0.005 * (z / 0.02) + 0.003 * Math.cos(z * 400);
    }
    if (z < 0.06) {
      // Shoulders & Chest
      const st = (z - 0.02) / 0.04;
      const w = 0.055 * (1 - st * 0.35);
      const d = 0.028 * (1 - st * 0.3);
      return Math.sqrt(Math.pow(w * Math.sin(theta), 2) + Math.pow(d * Math.cos(theta), 2));
    }
    if (z < 0.09) {
      // Neck
      const nt = (z - 0.06) / 0.03;
      return 0.022 - 0.003 * Math.sin(nt * Math.PI);
    }
    if (z < 0.13) {
      // Head & Facial features
      const ht = (z - 0.09) / 0.04;
      let r = 0.028 + 0.006 * Math.sin(ht * Math.PI);
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
      return r;
    }
    // Cranium dome & curls. Near the crown the dome term goes to 0 and the
    // curl term can dip below it, flipping r negative — which wraps the
    // point through the axis to the opposite side (x,y negate) instead of
    // sitting at the pole, pinching the mesh into itself there.
    const dt = (z - 0.13) / 0.03;
    const dome = 0.03 * Math.sqrt(Math.max(0, 1 - dt * dt));
    return Math.max(0.001, dome + 0.0025 * Math.sin(theta * 12) * Math.cos(z * 80));
  };

  return buildSolidLathe(radiusAt, 0.16, slices, stacks, BUST_WALL_THICKNESS_RATIO);
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
