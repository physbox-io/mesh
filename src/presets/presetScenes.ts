import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';

export const pendulumPreset: SceneGraph = {
  nodes: [
    {
      id: 'pole',
      name: 'pole',
      type: 'body',
      pos: [0, 0, 3.0],
      joints: [
        { name: 'hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0 }
      ],
      geoms: [
        { name: 'pole_geom', type: 'capsule', fromto: [0, 0, 0, 1, 0, 0], size: [0.05], mass: 1, rgba: [0.6, 0.6, 0.6, 1] },
        { name: 'pole_bob_geom', type: 'sphere', size: [0.12], pos: [1, 0, 0], mass: 7, rgba: [0.3, 0.5, 0.8, 1] }
      ],
      children: [
        {
          id: 'pole2',
          name: 'pole2',
          type: 'body',
          pos: [1, 0, 0],
          joints: [
            { name: 'hinge2', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0 }
          ],
          geoms: [
            { name: 'pole2_geom', type: 'capsule', fromto: [0, 0, 0, 1, 0, 0], size: [0.05], mass: 1, rgba: [0.5, 0.5, 0.5, 1] },
            { name: 'bob_geom', type: 'sphere', size: [0.15], pos: [1, 0, 0], mass: 14, rgba: [0.2, 0.6, 1.0, 1] }
          ],
          children: []
        }
      ]
    }
  ]
};

export const stackedCubesPreset: SceneGraph = {
  nodes: [
    {
      id: 'cube1',
      name: 'cube1',
      type: 'body',
      pos: [0, 0, 0.3],
      joints: [
        { name: 'cube1_free', type: 'free' }
      ],
      geoms: [
        { name: 'cube1_geom', type: 'box', size: [0.2, 0.2, 0.2], mass: 1, rgba: [0.8, 0.2, 0.2, 1] }
      ],
      children: []
    },
    {
      id: 'cube2',
      name: 'cube2',
      type: 'body',
      pos: [0, 0, 1.0],
      joints: [
        { name: 'cube2_free', type: 'free' }
      ],
      geoms: [
        { name: 'cube2_geom', type: 'box', size: [0.2, 0.2, 0.2], mass: 1, rgba: [0.2, 0.8, 0.2, 1] }
      ],
      children: []
    }
  ]
};

export const generateGearGeoms = (
  id: string,
  radius: number,
  teeth: number,
  color: number[],
  isSecondGear: boolean = false,
  contype: number = 0,
  conaffinity: number = 0
): SceneGeom[] => {
  const geoms: SceneGeom[] = [];
  
  // Center cylinder
  geoms.push({
    name: `${id}_center`,
    type: 'cylinder',
    size: [radius, 0.05], // radius, half-height
    rgba: color,
    mass: 0.05,
    contype,
    conaffinity
  });

  // Teeth as single boxes radiating outward (square cogs!)
  const toothWidth = (Math.PI * radius * 2) / (teeth * 2.8);
  const toothThickness = 0.08;
  const toothLength = radius * 0.25;
  const startAngle = isSecondGear ? (Math.PI / teeth) : 0;

  for (let i = 0; i < teeth; i++) {
    const angle = startAngle + (i / teeth) * Math.PI * 2;
    const cosAngle = Math.cos(angle);
    const sinAngle = Math.sin(angle);
    
    // Position of tooth box center radiating outward
    const toothCenterX = cosAngle * (radius + toothLength / 2);
    const toothCenterY = sinAngle * (radius + toothLength / 2);
    
    // Box dimensions: size = [half_length_outward, half_width_tangent, half_thickness_vertical]
    const size = [toothLength / 2, toothWidth / 2, toothThickness / 2];
    
    // Pure Z-rotation quaternion so teeth point outward and remain perfectly flat
    const halfAngle = angle / 2;
    const quat = [Math.cos(halfAngle), 0, 0, Math.sin(halfAngle)];
    
    geoms.push({
      name: `${id}_tooth_${i}`,
      type: 'box',
      size,
      pos: [toothCenterX, toothCenterY, 0],
      quat,
      rgba: color,
      mass: 0.01,
      contype,
      conaffinity
    });
  }

  return geoms;
};

const createGear = (id: string, name: string, pos: number[], radius: number, teeth: number, color: number[], isMotor: boolean, isSecondGear: boolean = false): SceneNode => {
  return {
    id,
    name,
    type: 'body',
    pos,
    joints: [
      { 
        name: `${id}_hinge`, 
        type: 'hinge', 
        axis: [0, 0, 1], // Z-axis hinge
        damping: 0.5,
        ...(isMotor && { actuator: { type: 'velocity', kv: 20, ctrlValue: 1.5 } })
      }
    ],
    geoms: generateGearGeoms(id, radius, teeth, color, isSecondGear),
    children: []
  };
};

export const gearsPreset: SceneGraph = {
  nodes: [
    // Two meshing gears.
    // If Gear 1 is at (0,0,0) and radius 0.5, outer radius is 0.625.
    // We use D = 1.13 to provide a tiny clearance gap and guarantee start-up stability.
    // Placed at Z = 0.05 so they lie exactly flat on the plane
    createGear('gear1', 'gear1', [0, 0, 0.05], 0.5, 12, [0.8, 0.4, 0.2, 1], true, false),
    createGear('gear2', 'gear2', [1.13, 0, 0.05], 0.5, 12, [0.2, 0.6, 0.8, 1], false, true)
  ]
};

const machineGear1 = createGear('gear1', 'gear1', [0, 0, 0.05], 0.3, 12, [0.8, 0.4, 0.2, 1], true, false);
machineGear1.geoms.push({
  name: 'gear1_shaft',
  type: 'cylinder',
  size: [0.05, 0.12], // radius 0.05, half-height 0.12
  pos: [0, 0, 0.12],
  rgba: [0.45, 0.45, 0.45, 1],
  mass: 0.1,
  contype: 0,
  conaffinity: 0
});

const machineGear2 = createGear('gear2', 'gear2', [0.72, 0, 0.05], 0.4, 16, [0.2, 0.6, 0.8, 1], false, true);

const machineGear3 = createGear('gear3', 'gear3', [0.72, 0.82, 0.05], 0.4, 16, [0.2, 0.8, 0.4, 1], false, false);
machineGear3.geoms.push({
  name: 'gear3_pusher_peg',
  type: 'cylinder',
  size: [0.03, 0.08], // radius 0.03, half-height 0.08
  pos: [0.52, 0.0, 0.14], // relative offset placed outside the gear disc (0.52 > 0.40) and high enough to clear the shelf top
  rgba: [0.9, 0.2, 0.2, 1],
  mass: 0.05,
  condim: 3
});

const machineShelf: SceneNode = {
  id: 'shelf',
  name: 'shelf',
  type: 'body',
  pos: [1.35, 0.82, 0.05],
  joints: [],
  geoms: [
    {
      name: 'shelf_geom',
      type: 'box',
      size: [0.12, 0.12, 0.05], // sits at Z=0.05, top is at 0.10, covers X from 1.23 to 1.47
      rgba: [0.7, 0.7, 0.7, 1],
      mass: 10,
      condim: 3,
      friction: [0.1, 0.005, 0.0005]
    }
  ],
  children: []
};

const machineBlock: SceneNode = {
  id: 'push_block',
  name: 'push_block',
  type: 'body',
  pos: [1.26, 0.82, 0.16], // sits perfectly on shelf, X is 1.26, in the clean sweep path of the pusher peg
  joints: [
    { name: 'push_block_free', type: 'free' }
  ],
  geoms: [
    {
      name: 'push_block_geom',
      type: 'box',
      size: [0.05, 0.05, 0.05], // 10cm cube
      rgba: [0.95, 0.8, 0.25, 1],
      mass: 0.1,
      condim: 3,
      friction: [0.1, 0.005, 0.0005]
    }
  ],
  children: []
};

export const machinePreset: SceneGraph = {
  nodes: [
    machineGear1,
    machineGear2,
    machineGear3,
    machineShelf,
    machineBlock
  ]
};

// Generate visual cogs matching pinion pitch spaced along X as child SceneNodes
const pinionPitch = (Math.PI * 2 * 0.20) / 8; // 0.157079
const rackTeethChildren: SceneNode[] = [];
let toothIndex = 0;
// Space teeth along a 0.70m long rack base (from -0.30 to 0.30)
for (let x = -0.30; x <= 0.30; x += pinionPitch) {
  rackTeethChildren.push({
    id: `rack_tooth_${toothIndex}`,
    name: `tooth_${toothIndex}`,
    type: 'body',
    pos: [x, 0.045, 0],
    joints: [], // Fixed / welded to parent!
    geoms: [
      {
        name: `rack_tooth_${toothIndex}_geom`,
        type: 'box',
        size: [0.01, 0.015, 0.02],
        rgba: [0.7, 0.7, 0.7, 1],
        mass: 0.01
        // Full physical collision enabled (no contype/conaffinity overrides)
      }
    ],
    children: []
  });
  toothIndex++;
}

// Rack body node with X slide joint limited to [-0.6, 0.6] range
const rackNode: SceneNode = {
  id: 'rack',
  name: 'rack',
  type: 'body',
  pos: [0, -0.25, 0.05],
  joints: [
    { name: 'rack_slide', type: 'slide', axis: [1, 0, 0], damping: 0.5, limited: true, range: [-0.6, 0.6] }
  ],
  geoms: [
    {
      name: 'rack_base',
      type: 'box',
      size: [0.35, 0.04, 0.04], // 0.70m long rack base
      rgba: [0.8, 0.8, 0.8, 1],
      mass: 0.5
      // Full physical collision enabled (no contype/conaffinity overrides)
    }
  ],
  children: rackTeethChildren
};

// Pinion gear with velocity motor
const pinionNode = createGear('pinion', 'pinion', [0, 0, 0.05], 0.2, 8, [0.2, 0.6, 0.8, 1], true);

// Shelf and block at the right end of the rack path, perfectly aligned in Y (-0.25)
const rackShelf: SceneNode = {
  id: 'rack_shelf',
  name: 'rack_shelf',
  type: 'body',
  pos: [0.90, -0.25, 0.05], // Aligned in Y with the rack path
  joints: [],
  geoms: [
    {
      name: 'rack_shelf_geom',
      type: 'box',
      size: [0.10, 0.10, 0.05],
      rgba: [0.65, 0.65, 0.65, 1],
      mass: 10,
      condim: 3,
      friction: [0.1, 0.005, 0.0005]
    }
  ],
  children: []
};

const rackBlock: SceneNode = {
  id: 'rack_block',
  name: 'rack_block',
  type: 'body',
  pos: [0.76, -0.25, 0.15], // Resting perfectly on the left edge of the shelf
  joints: [
    { name: 'rack_block_free', type: 'free' }
  ],
  geoms: [
    {
      name: 'rack_block_geom',
      type: 'box',
      size: [0.05, 0.05, 0.05],
      rgba: [0.95, 0.8, 0.25, 1],
      mass: 0.1,
      condim: 3,
      friction: [0.1, 0.005, 0.0005]
    }
  ],
  children: []
};

export const rackPinionPreset: SceneGraph = {
  nodes: [
    pinionNode,
    rackNode,
    rackShelf,
    rackBlock
  ]
};

export const inclinedPlanePreset: SceneGraph = {
  nodes: [
    {
      id: 'inclined_wedge',
      name: 'inclined_wedge',
      type: 'body',
      pos: [0, 0, 0],
      isWedge: true,
      width: 3.0,
      depth: 1.2,
      height: 1.0,
      wedgeAngle: 18.435,
      geoms: [
        {
          name: 'wedge_geom',
          type: 'box',
          size: [1.581, 0.6, 0.025],
          rgba: [0.8, 0.5, 0.2, 1],
          mass: 50,
          condim: 3,
          friction: [0.2, 0.005, 0.0005]
        }
      ],
      joints: [],
      children: []
    },
    {
      id: 'sliding_cube',
      name: 'sliding_cube',
      type: 'body',
      pos: [-1.0, 0, 1.3],
      geoms: [
        {
          name: 'sliding_cube_geom',
          type: 'box',
          size: [0.2, 0.2, 0.2],
          rgba: [0.95, 0.8, 0.2, 1],
          mass: 2.0,
          condim: 3,
          friction: [0.1, 0.005, 0.0005]
        }
      ],
      joints: [
        { name: 'sliding_cube_free', type: 'free' }
      ],
      children: []
    }
  ]
};

export const pulleySystemPreset: SceneGraph = {
  nodes: [
    {
      id: 'pulley_support',
      name: 'pulley_support',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        {
          name: 'support_column',
          type: 'capsule',
          fromto: [0, 0, 0, 0, 0, 1.8],
          size: [0.05],
          rgba: [0.4, 0.4, 0.4, 1]
        },
        {
          name: 'support_peg',
          type: 'capsule',
          fromto: [0, 0, 1.6, 0, -0.35, 1.6],
          size: [0.03],
          rgba: [0.3, 0.3, 0.3, 1]
        }
      ],
      joints: [],
      children: []
    },
    {
      id: 'pulley_wheel',
      name: 'pulley_wheel',
      type: 'body',
      pos: [0, -0.3, 1.6],
      isPulleyWheel: true,
      pulleyRadius: 0.4,
      geoms: [
        { name: 'pulley_wheel_spindle', type: 'cylinder', size: [0.32, 0.03], pos: [0, 0, 0], euler: [90, 0, 0], rgba: [0.3, 0.4, 0.6, 1], mass: 0.5 },
        { name: 'pulley_wheel_flange_l', type: 'cylinder', size: [0.4, 0.01], pos: [0, -0.04, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 },
        { name: 'pulley_wheel_flange_r', type: 'cylinder', size: [0.4, 0.01], pos: [0, 0.04, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.25 }
      ],
      joints: [
        { name: 'pulley_wheel_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.2 }
      ],
      children: []
    },
    {
      id: 'left_weight',
      name: 'left_weight',
      type: 'body',
      pos: [-0.4, -0.3, 0.8],
      geoms: [
        {
          name: 'left_weight_geom',
          type: 'box',
          size: [0.15, 0.15, 0.15],
          rgba: [0.2, 0.6, 1.0, 1],
          mass: 5.0,
          condim: 3
        }
      ],
      joints: [
        { name: 'left_weight_joint', type: 'slide', axis: [0, 0, 1], damping: 1.0 }
      ],
      children: []
    },
    {
      id: 'right_weight',
      name: 'right_weight',
      type: 'body',
      pos: [0.4, -0.3, 0.8],
      geoms: [
        {
          name: 'right_weight_geom',
          type: 'box',
          size: [0.15, 0.15, 0.15],
          rgba: [0.95, 0.8, 0.2, 1],
          mass: 3.0,
          condim: 3
        }
      ],
      joints: [
        { name: 'right_weight_joint', type: 'slide', axis: [0, 0, 1], damping: 1.0 }
      ],
      children: []
    },
    {
      id: 'pulley_rope_preset',
      name: 'pulley_rope_preset',
      type: 'body',
      pos: [0, 0, 0],
      isPulleyRope: true,
      pulleyWheelId: 'pulley_wheel',
      leftTargetId: 'left_weight',
      rightTargetId: 'right_weight',
      geoms: [],
      joints: [],
      children: []
    }
  ]
};

export const cartpolePreset: SceneGraph = {
  nodes: [
    {
      id: 'rail',
      name: 'rail',
      type: 'body',
      pos: [0, 0, 1.0],
      joints: [],
      geoms: [
        {
          name: 'rail_geom',
          type: 'cylinder',
          size: [0.015], // 3cm diameter
          rgba: [0.3, 0.35, 0.4, 0.5], // semi-transparent slate
          fromto: [-2.0, 0, 0, 2.0, 0, 0], // horizontal slider rail along X
          contype: 0,
          conaffinity: 0
        }
      ],
      children: []
    },
    {
      id: 'cart',
      name: 'cart',
      type: 'body',
      pos: [0, 0, 1.0],
      joints: [
        { name: 'cart_slide', type: 'slide', axis: [1, 0, 0], damping: 1.0, limited: true, range: [-2.0, 2.0] }
      ],
      script: `// Cartpole LQR Balancing Controller
const x = api.getJointPosition('cart_slide');
const v = api.getJointVelocity('cart_slide');
const theta = api.getJointPosition('pole_hinge');
const omega = api.getJointVelocity('pole_hinge');

// State-feedback LQR controller gains
const kx = 22.0;      // Cart position gain
const kv = 15.0;      // Cart velocity damping
const kTheta = 80.0;  // Pole angle gain (robust tracking)
const kOmega = 20.0;  // Pole angular velocity damping

// Compute the balancing force
const force = (kx * x) + (kv * v) + (kTheta * theta) + (kOmega * omega);

// Apply force directly to the cart slide joint
api.applyJointForce('cart_slide', force);
`,
      geoms: [
        {
          name: 'cart_geom',
          type: 'box',
          size: [0.25, 0.18, 0.12], // cart dimensions
          rgba: [0.15, 0.5, 0.85, 1], // vibrant premium blue
          mass: 2.0,
          condim: 3
        }
      ],
      children: [
        {
          id: 'pole',
          name: 'pole',
          type: 'body',
          pos: [0, 0, 0.12], // hinge sits on top of cart
          euler: [0, 5, 0],  // Initial tilt (5 degrees around Y)
          joints: [
            { name: 'pole_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.05 }
          ],
          geoms: [
            {
              name: 'pole_rod_geom',
              type: 'capsule',
              fromto: [0, 0, 0, 0, 0, 0.7],
              size: [0.018],
              rgba: [0.65, 0.65, 0.65, 1],
              mass: 0.2
            }
          ],
          children: [
            {
              id: 'pole_weight',
              name: 'pole_weight',
              type: 'body',
              pos: [0, 0, 0.7],
              joints: [],
              geoms: [
                {
                  name: 'pole_weight_geom',
                  type: 'sphere',
                  pos: [0, 0, 0],
                  size: [0.06], // spherical tip weight
                  rgba: [0.85, 0.25, 0.25, 1], // crimson tip
                  mass: 0.6,
                  condim: 3
                }
              ],
              children: []
            }
          ]
        }
      ]
    }
  ]
};

export const newtonsCradlePreset: SceneGraph = {
  nodes: [
    {
      id: 'support_bar',
      name: 'support_bar',
      type: 'body',
      pos: [0, 0, 2.5],
      joints: [],
      geoms: [
        { name: 'bar_geom', type: 'cylinder', size: [0.03, 0.6], pos: [0, 0, 0], euler: [0, 90, 0], rgba: [0.3, 0.3, 0.3, 1], contype: 0, conaffinity: 0 }
      ],
      children: []
    },
    ...Array.from({ length: 5 }).map((_, idx): SceneNode => {
      const x = -0.4 + idx * 0.2;
      const isFirst = idx === 0;
      
      return {
        id: `cradle_${idx}`,
        name: `cradle_${idx}`,
        type: 'body',
        pos: [x, 0, 2.5],
        euler: isFirst ? [0, 35, 0] : [0, 0, 0],
        joints: [
          { name: `cradle_joint_${idx}`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.05, limited: true, range: [-90, 90] }
        ],
        geoms: [
          { name: `cradle_rod_${idx}`, type: 'capsule', fromto: [0, 0, 0, 0, 0, -1.0], size: [0.01], mass: 0.1, rgba: [0.7, 0.7, 0.7, 1], contype: 0, conaffinity: 0 }
        ],
        children: [
          {
            id: `cradle_bob_body_${idx}`,
            name: `cradle_bob_body_${idx}`,
            type: 'body',
            pos: [0, 0, -1.0],
            joints: [],
            geoms: [
              { name: `cradle_ball_${idx}`, type: 'sphere', size: [0.0995], pos: [0, 0, 0], mass: 6, rgba: [0.8, 0.8, 0.8, 1], solref: [-5000, -50.0], solimp: [0.98, 0.99, 0.001, 0.5, 2] }
            ],
            children: []
          }
        ]
      };
    })
  ]
};

const generateBridgePlanks = (): SceneNode[] => {
  const planksCount = 10;
  const plankLength = 0.28;
  
  const createPlankNode = (index: number): SceneNode => {
    const isFirst = index === 1;
    const isLast = index === planksCount;
    
    return {
      id: `plank_${index}`,
      name: `plank_${index}`,
      type: 'body',
      pos: isFirst ? [-1.4, 0, 1.3] : [plankLength, 0, 0],
      joints: [
        { name: `plank_joint_${index}`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }
      ],
      geoms: [
        { 
          name: `plank_geom_${index}`, 
          type: 'box', 
          size: [plankLength / 2, 0.25, 0.02], 
          pos: [plankLength / 2, 0, 0], 
          rgba: [0.65, 0.45, 0.25, 1], 
          mass: 0.5,
          condim: 3,
          friction: [0.8, 0.01, 0.001]
        }
      ],
      children: isLast ? [] : [createPlankNode(index + 1)],
      ...(isLast ? { connectTargetId: 'support_r', connectAnchor: [1.4, 0, 1.3] } : {})
    };
  };
  
  return [createPlankNode(1)];
};

export const suspensionBridgePreset: SceneGraph = {
  nodes: [
    {
      id: 'support_l',
      name: 'support_l',
      type: 'body',
      pos: [-1.5, 0, 0.65],
      joints: [],
      geoms: [
        { name: 'support_l_geom', type: 'box', size: [0.1, 0.35, 0.65], rgba: [0.4, 0.45, 0.5, 1] }
      ],
      children: []
    },
    {
      id: 'support_r',
      name: 'support_r',
      type: 'body',
      pos: [1.5, 0, 0.65],
      joints: [],
      geoms: [
        { name: 'support_r_geom', type: 'box', size: [0.1, 0.35, 0.65], rgba: [0.4, 0.45, 0.5, 1] }
      ],
      children: []
    },
    ...generateBridgePlanks(),
    {
      id: 'rolling_ball',
      name: 'rolling_ball',
      type: 'body',
      pos: [0, 0, 2.2],
      joints: [
        { name: 'rolling_ball_free', type: 'free' }
      ],
      geoms: [
        { 
          name: 'ball_geom', 
          type: 'sphere', 
          size: [0.38], 
          rgba: [0.85, 0.25, 0.25, 1], 
          mass: 30.0, 
          condim: 3, 
          friction: [0.4, 0.01, 0.001] 
        }
      ],
      children: []
    }
  ]
};

export const paperPlanePreset: SceneGraph = {
  nodes: [
    {
      id: 'paper_plane_wing',
      name: 'paper_plane_wing',
      type: 'body',
      pos: [0, 0, 3.5],
      euler: [0, 8, 0],
      isAerodynamic: true,
      joints: [
        { name: 'plane_free', type: 'free', initialVelocity: [4.0, 0.0, 0.5, 0.0, 0.0, 0.0] }
      ],
      geoms: [
        {
          name: 'wing_geom',
          type: 'box',
          size: [0.06, 0.28, 0.003],
          rgba: [0.96, 0.96, 0.94, 1],
          mass: 0.004,
          condim: 3,
          friction: [0.3, 0.005, 0.0005]
        }
      ],
      children: [
        {
          id: 'paper_plane_spine',
          name: 'paper_plane_spine',
          type: 'body',
          pos: [0, 0, 0],
          euler: [0, 0, 0],
          joints: [],
          geoms: [
            {
              name: 'spine_geom',
              type: 'box',
              size: [0.13, 0.018, 0.012],
              rgba: [0.88, 0.88, 0.86, 1],
              mass: 0.003,
              condim: 3
            }
          ],
          children: []
        },
        {
          id: 'paper_plane_nose',
          name: 'paper_plane_nose',
          type: 'body',
          pos: [0.13, 0, 0],
          euler: [0, 0, 0],
          joints: [],
          geoms: [
            {
              name: 'nose_geom',
              type: 'sphere',
              size: [0.011],
              rgba: [0.75, 0.75, 0.72, 1],
              mass: 0.003,
              condim: 3
            }
          ],
          children: []
        }
      ]
    }
  ]
};

// Monkey head: compound primitives approximating the classic Blender Suzanne.
export const monkeyHeadPreset: SceneGraph = {
  nodes: [{
    id: 'monkey', name: 'monkey', type: 'body', pos: [0, 0, 3.0],
    joints: [{ name: 'monkey_free', type: 'free' }],
    geoms: [
      { name: 'skull',        type: 'ellipsoid', size: [0.52, 0.55, 0.48], rgba: [0.88, 0.66, 0.30, 1] },
      { name: 'cheek_l',      type: 'ellipsoid', size: [0.19, 0.16, 0.15], pos: [-0.40, 0.08, -0.06], rgba: [0.80, 0.58, 0.26, 1] },
      { name: 'cheek_r',      type: 'ellipsoid', size: [0.19, 0.16, 0.15], pos: [ 0.40, 0.08, -0.06], rgba: [0.80, 0.58, 0.26, 1] },
      { name: 'snout',        type: 'ellipsoid', size: [0.22, 0.18, 0.13], pos: [0, 0.62, -0.12],     rgba: [0.86, 0.68, 0.34, 1] },
      { name: 'nostril_l',    type: 'sphere',    size: [0.055],            pos: [-0.09, 0.78, -0.12], rgba: [0.15, 0.08, 0.03, 1] },
      { name: 'nostril_r',    type: 'sphere',    size: [0.055],            pos: [ 0.09, 0.78, -0.12], rgba: [0.15, 0.08, 0.03, 1] },
      { name: 'brow',         type: 'box',       size: [0.32, 0.06, 0.05], pos: [0, 0.48, 0.28],      rgba: [0.40, 0.24, 0.08, 1] },
      { name: 'eye_socket_l', type: 'sphere',    size: [0.12],             pos: [-0.22, 0.50, 0.08],  rgba: [0.15, 0.08, 0.03, 1] },
      { name: 'eye_socket_r', type: 'sphere',    size: [0.12],             pos: [ 0.22, 0.50, 0.08],  rgba: [0.15, 0.08, 0.03, 1] },
      { name: 'eye_l',        type: 'sphere',    size: [0.10],             pos: [-0.22, 0.60, 0.08],  rgba: [0.95, 0.95, 0.93, 1] },
      { name: 'eye_r',        type: 'sphere',    size: [0.10],             pos: [ 0.22, 0.60, 0.08],  rgba: [0.95, 0.95, 0.93, 1] },
      { name: 'pupil_l',      type: 'sphere',    size: [0.050],            pos: [-0.22, 0.69, 0.08],  rgba: [0.04, 0.04, 0.04, 1] },
      { name: 'pupil_r',      type: 'sphere',    size: [0.050],            pos: [ 0.22, 0.69, 0.08],  rgba: [0.04, 0.04, 0.04, 1] },
      { name: 'jaw',          type: 'ellipsoid', size: [0.30, 0.24, 0.10], pos: [0, 0.20, -0.42],     rgba: [0.80, 0.56, 0.24, 1] },
      { name: 'ear_l',        type: 'ellipsoid', size: [0.10, 0.08, 0.18], pos: [-0.60, -0.10, 0.16], rgba: [0.84, 0.62, 0.28, 1] },
      { name: 'ear_r',        type: 'ellipsoid', size: [0.10, 0.08, 0.18], pos: [ 0.60, -0.10, 0.16], rgba: [0.84, 0.62, 0.28, 1] },
      { name: 'ear_inner_l',  type: 'ellipsoid', size: [0.055,0.045,0.11], pos: [-0.61, 0.00, 0.16],  rgba: [0.48, 0.26, 0.10, 1] },
      { name: 'ear_inner_r',  type: 'ellipsoid', size: [0.055,0.045,0.11], pos: [ 0.61, 0.00, 0.16],  rgba: [0.48, 0.26, 0.10, 1] },
      { name: 'chin',         type: 'sphere',    size: [0.09],             pos: [0, 0.52, -0.50],     rgba: [0.80, 0.56, 0.24, 1] },
    ],
    children: []
  }]
};

// Golden Gate bridge — all primitives so the structure physically simulates.
// Towers fixed to world. Deck + cables on a stiff ball joint so they sway in wind.
export const goldenGateBridgePreset: SceneGraph = (() => {
  const ORANGE = [0.80, 0.25, 0.08, 1] as number[];
  const GREY   = [0.55, 0.55, 0.55, 1] as number[];
  const CABLE  = [0.60, 0.18, 0.05, 1] as number[];
  const HANGER = [0.65, 0.65, 0.65, 1] as number[];

  const makeTowerGeoms = (x: number, prefix: string): SceneGeom[] => [
    { name: `${prefix}_leg_f`, type: 'box',     size: [0.08, 0.08, 1.5], pos: [x, -0.3, 1.5], rgba: ORANGE },
    { name: `${prefix}_leg_b`, type: 'box',     size: [0.08, 0.08, 1.5], pos: [x,  0.3, 1.5], rgba: ORANGE },
    { name: `${prefix}_xb_lo`, type: 'box',     size: [0.08, 0.38, 0.06], pos: [x, 0, 0.8],   rgba: ORANGE },
    { name: `${prefix}_xb_hi`, type: 'box',     size: [0.08, 0.38, 0.06], pos: [x, 0, 2.5],   rgba: ORANGE },
  ];

  const makeCableGeoms = (y: number, prefix: string): SceneGeom[] => {
    const geoms: SceneGeom[] = [];
    const N = 16;
    for (let i = 0; i < N; i++) {
      const t0 = i / N, t1 = (i + 1) / N;
      const x0 = -4.8 + t0 * 9.6, x1 = -4.8 + t1 * 9.6;
      const z0 = 3.0 - 6 * t0 * (1 - t0), z1 = 3.0 - 6 * t1 * (1 - t1);
      geoms.push({ name: `${prefix}_${i}`, type: 'capsule', size: [0.04], fromto: [x0, y, z0, x1, y, z1], rgba: CABLE });
    }
    return geoms;
  };

  const makeHangerGeoms = (y: number, prefix: string): SceneGeom[] => {
    const geoms: SceneGeom[] = [];
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      const x = -4.8 + t * 9.6;
      const zTop = 3.0 - 6 * t * (1 - t);
      geoms.push({ name: `${prefix}_${i}`, type: 'capsule', size: [0.02], fromto: [x, y, zTop, x, y, 0.36], rgba: HANGER });
    }
    return geoms;
  };

  return {
    nodes: [
      {
        id: 'gg_towers', name: 'gg_towers', type: 'body' as const, pos: [0, 0, 0], joints: [],
        geoms: [...makeTowerGeoms(-4.8, 'tl'), ...makeTowerGeoms(4.8, 'tr')],
        children: [],
      },
      {
        id: 'gg_deck', name: 'gg_deck', type: 'body' as const, pos: [0, 0, 0],
        joints: [{ name: 'gg_sway', type: 'ball', pos: [0, 0, 0], damping: 300, stiffness: 1200 }],
        geoms: [
          { name: 'gg_deck_box', type: 'box', size: [4.8, 0.3, 0.06], pos: [0, 0, 0.3], rgba: GREY, mass: 600 },
          ...makeCableGeoms(-0.3, 'cf'), ...makeCableGeoms(0.3, 'cb'),
          ...makeHangerGeoms(-0.3, 'hf'), ...makeHangerGeoms(0.3, 'hb'),
        ],
        children: [],
      },
    ]
  };
})();

// Golden Gate bridge — mesh version (visual/decorative only, no simulation).
// Vertices in Three.js Y-up world space: X=right, Y=up, Z=toward camera.
export const goldenGateMeshPreset: SceneGraph = (() => {
  // box(cx,cy,cz, hx,hy,hz) — Three.js Y-up coords: X=right, Y=up, Z=depth
  function box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number) {
    const v = [
      cx-hx, cy-hy, cz-hz,  cx+hx, cy-hy, cz-hz,  cx+hx, cy+hy, cz-hz,  cx-hx, cy+hy, cz-hz,
      cx-hx, cy-hy, cz+hz,  cx+hx, cy-hy, cz+hz,  cx+hx, cy+hy, cz+hz,  cx-hx, cy+hy, cz+hz,
    ];
    const f = [0,1,2,0,2,3, 4,6,5,4,7,6, 0,4,5,0,5,1, 3,2,6,3,6,7, 0,3,7,0,7,4, 1,5,6,1,6,2];
    return { v, f };
  }
  function merge(parts: {v:number[];f:number[]}[]) {
    const verts: number[] = [], faces: number[] = [];
    let off = 0;
    for (const {v, f} of parts) { verts.push(...v); faces.push(...f.map(i => i+off)); off += v.length/3; }
    return { vertices: verts, faces };
  }

  const ORANGE = [0.80, 0.25, 0.08, 1] as number[];
  const GREY   = [0.55, 0.55, 0.55, 1] as number[];
  const CABLE  = [0.60, 0.18, 0.05, 1] as number[];
  const HANGER = [0.65, 0.65, 0.65, 1] as number[];

  // Deck: flat plank spanning X, thin in Y, shallow in Z
  const deck = box(0, 0.3, 0,  4.8, 0.06, 0.3);

  // Tower H-frames: legs tall in Y, at X=±4.8
  function makeTower(cx: number) {
    return merge([
      box(cx, 1.5, -0.3,  0.08, 1.5, 0.08),  // front leg
      box(cx, 1.5,  0.3,  0.08, 1.5, 0.08),  // back leg
      box(cx, 0.8,  0,    0.08, 0.06, 0.38),  // lower crossbeam
      box(cx, 2.4,  0,    0.08, 0.06, 0.38),  // upper crossbeam
    ]);
  }

  // Parabolic cables: series of boxes along arc, front and back
  function makeCable(cz: number) {
    const parts = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const t0 = i/N, t1 = (i+1)/N;
      const x0 = -4.8 + t0*9.6, x1 = -4.8 + t1*9.6;
      const y0 = 3.0 - 6*t0*(1-t0), y1 = 3.0 - 6*t1*(1-t1);
      const len = Math.sqrt((x1-x0)**2 + (y1-y0)**2)/2 + 0.01;
      parts.push(box((x0+x1)/2, (y0+y1)/2, cz,  len, 0.04, 0.04));
    }
    return merge(parts);
  }

  // Vertical hangers
  function makeHangers(cz: number) {
    const parts = [];
    for (let i = 1; i < 14; i++) {
      const t = i/14;
      const x = -4.8 + t*9.6;
      const yTop = 3.0 - 6*t*(1-t);
      parts.push(box(x, (yTop+0.36)/2, cz,  0.02, (yTop-0.36)/2, 0.02));
    }
    return merge(parts);
  }

  const towerL  = makeTower(-4.8);
  const towerR  = makeTower( 4.8);
  const cable1  = makeCable(-0.3);
  const cable2  = makeCable( 0.3);
  const hang1   = makeHangers(-0.3);
  const hang2   = makeHangers( 0.3);

  return {
    nodes: [{
      id: 'gg_mesh', name: 'gg_mesh', type: 'body' as const, pos: [0, 0, 0], joints: [],
      geoms: [
        { name: 'gg_deck',    type: 'mesh' as const, size: [1], rgba: GREY,   vertices: deck.v,          faces: deck.f          },
        { name: 'gg_tower_l', type: 'mesh' as const, size: [1], rgba: ORANGE, vertices: towerL.vertices,  faces: towerL.faces    },
        { name: 'gg_tower_r', type: 'mesh' as const, size: [1], rgba: ORANGE, vertices: towerR.vertices,  faces: towerR.faces    },
        { name: 'gg_cable_1', type: 'mesh' as const, size: [1], rgba: CABLE,  vertices: cable1.vertices,  faces: cable1.faces    },
        { name: 'gg_cable_2', type: 'mesh' as const, size: [1], rgba: CABLE,  vertices: cable2.vertices,  faces: cable2.faces    },
        { name: 'gg_hang_1',  type: 'mesh' as const, size: [1], rgba: HANGER, vertices: hang1.vertices,   faces: hang1.faces     },
        { name: 'gg_hang_2',  type: 'mesh' as const, size: [1], rgba: HANGER, vertices: hang2.vertices,   faces: hang2.faces     },
      ],
      children: [],
    }]
  };
})();

// Mesh collision demo: pyramid mesh falling onto a ramp mesh, with full collision.
// renderVertices are in MuJoCo Z-up space, offset by the volume centroid MuJoCo computes.
// Centroid values determined empirically via mj_forward with body at origin.
// Ramp centroid (Z-up): (0, 0.2, 0.1667). Pyramid centroid (Z-up): (0, 0, 0.125).
export const meshCollisionPreset: SceneGraph = (() => {
  // Y-up verts (Three.js) → fed to mjcf builder which swaps Y↔Z for MuJoCo
  // Ramp slopes in X (left→right goes up), depth in Z — pyramid slides along X, stays near Z=0
  const rampYup = [
    -0.6, 0,   -0.3,
    -0.6, 0,    0.3,
     0.6, 0.5, -0.3,
     0.6, 0.5,  0.3,
     0.6, 0,   -0.3,
     0.6, 0,    0.3,
  ];
  const rampFaces = [0,1,3, 0,3,2, 0,2,4, 1,3,5, 2,3,5, 2,5,4, 0,5,1, 0,4,5];

  const pyramidYup = [
    -0.3, 0,  0.3,
     0.3, 0,  0.3,
     0.3, 0, -0.3,
    -0.3, 0, -0.3,
     0.0, 0.5, 0.0,
  ];
  const pyramidFaces = [0,4,1, 1,4,2, 2,4,3, 3,4,0, 0,1,2, 0,2,3];

  // renderVertices: raw Z-up (Y↔Z swap only, no centroid subtraction).
  // MuJoCo recenters the mesh internally; xpos tracks the recentered body frame.
  // Using raw Z-up means rendered position = xpos + raw_vertex, which is correct.
  const rampRV = [
    -0.6, 0.3, 0,  -0.6, -0.3, 0,
     0.6, 0.3, 0.5, 0.6, -0.3, 0.5,
     0.6, 0.3, 0,   0.6, -0.3, 0,
  ];
  const pyramidRV = [
    -0.3, -0.3, 0,  0.3, -0.3, 0,
     0.3,  0.3, 0, -0.3,  0.3, 0,
     0.0,  0.0, 0.5,
  ];

  return {
    nodes: [
      {
        id: 'ramp', name: 'ramp', type: 'body',
        pos: [0, 0, 0],
        joints: [],
        geoms: [{
          name: 'ramp_mesh', type: 'mesh', size: [1],
          rgba: [0.5, 0.6, 0.7, 1], mass: 100, condim: 3,
          friction: [0.4, 0.005, 0.0005],
          vertices: rampYup, faces: rampFaces,
          dynamic: true, renderVertices: rampRV,
        }],
        children: [],
      },
      {
        id: 'pyramid', name: 'pyramid', type: 'body',
        pos: [-0.2, 0.1125, 1.5],  // start above ramp centre, same Y as ramp
        joints: [{ name: 'pyramid_free', type: 'free' }],
        geoms: [{
          name: 'pyramid_mesh', type: 'mesh', size: [1],
          rgba: [0.85, 0.35, 0.15, 1], mass: 1, condim: 3,
          friction: [0.5, 0.005, 0.0005],
          vertices: pyramidYup, faces: pyramidFaces,
          dynamic: true, renderVertices: pyramidRV,
        }],
        // Apex polyhedron as a rigidly-attached child body (no joint = welded).
        // Its own body centroid is purely its own geometry, keeping renderVertices simple.
        children: [{
          id: 'pyramid_apex', name: 'pyramid_apex', type: 'body',
          // pos in MuJoCo Z-up relative to pyramid body: apex at Z=0.5, centroid at Z=0 → offset = Z+0.5
          pos: [0, 0, 0.5],
          joints: [],
          geoms: [{
            name: 'apex_poly', type: 'mesh', size: [1],
            rgba: [1.0, 0.9, 0.2, 1], mass: 0.05, condim: 3,
            // vertices: Y-up, centred at (0,0,0) — body pos handles the offset to apex
            vertices: [-0.0421,0.0681,0,0.0421,0.0681,0,-0.0421,-0.0681,0,0.0421,-0.0681,0,0,-0.0421,0.0681,0,0.0421,0.0681,0,-0.0421,-0.0681,0,0.0421,-0.0681,0.0681,0,-0.0421,0.0681,0,0.0421,-0.0681,0,-0.0421,-0.0681,0,0.0421,-0.0647,0.04,0.0247,-0.04,0.0247,0.0647,-0.0247,0.0647,0.04,0.0247,0.0647,0.04,0,0.08,0,0.0247,0.0647,-0.04,-0.0247,0.0647,-0.04,-0.04,0.0247,-0.0647,-0.0647,0.04,-0.0247,-0.08,0,0,0.04,0.0247,0.0647,0.0647,0.04,0.0247,-0.04,-0.0247,0.0647,0,0,0.08,-0.0647,-0.04,-0.0247,-0.0647,-0.04,0.0247,0,0,-0.08,-0.04,-0.0247,-0.0647,0.0647,0.04,-0.0247,0.04,0.0247,-0.0647,0.0647,-0.04,0.0247,0.04,-0.0247,0.0647,0.0247,-0.0647,0.04,-0.0247,-0.0647,0.04,0,-0.08,0,-0.0247,-0.0647,-0.04,0.0247,-0.0647,-0.04,0.04,-0.0247,-0.0647,0.0647,-0.04,-0.0247,0.08,0,0],
            faces: [0,12,14,11,13,12,5,14,13,12,13,14,0,14,16,5,15,14,1,16,15,14,15,16,0,16,18,1,17,16,7,18,17,16,17,18,0,18,20,7,19,18,10,20,19,18,19,20,0,20,12,10,21,20,11,12,21,20,21,12,1,15,23,5,22,15,9,23,22,15,22,23,5,13,25,11,24,13,4,25,24,13,24,25,11,21,27,10,26,21,2,27,26,21,26,27,10,19,29,7,28,19,6,29,28,19,28,29,7,17,31,1,30,17,8,31,30,17,30,31,3,32,34,9,33,32,4,34,33,32,33,34,3,34,36,4,35,34,2,36,35,34,35,36,3,36,38,2,37,36,6,38,37,36,37,38,3,38,40,6,39,38,8,40,39,38,39,40,3,40,32,8,41,40,9,32,41,40,41,32,4,33,25,9,22,33,5,25,22,33,22,25,2,35,27,4,24,35,11,27,24,35,24,27,6,37,29,2,26,37,10,29,26,37,26,29,8,39,31,6,28,39,7,31,28,39,28,31,9,41,23,8,30,41,1,23,30,41,30,23],
            dynamic: true,
            // renderVertices: Z-up, centred at body origin (centroid of unit icosphere ≈ origin)
            renderVertices: [-0.0421,0,0.0681,0.0421,0,0.0681,-0.0421,0,-0.0681,0.0421,0,-0.0681,0,-0.0681,-0.0421,0,-0.0681,0.0421,0,0.0681,-0.0421,0,0.0681,0.0421,0.0681,0.0421,0,0.0681,-0.0421,0,-0.0681,0.0421,0,-0.0681,-0.0421,0,-0.0647,-0.0247,0.04,-0.04,-0.0647,0.0247,-0.0247,-0.04,0.0647,0.0247,-0.04,0.0647,0,0,0.08,0.0247,0.04,0.0647,-0.0247,0.04,0.0647,-0.04,0.0647,0.0247,-0.0647,0.0247,0.04,-0.08,0,0,0.04,-0.0647,0.0247,0.0647,-0.0247,0.04,-0.04,-0.0647,-0.0247,0,-0.08,0,-0.0647,0.0247,-0.04,-0.0647,-0.0247,-0.04,0,0.08,0,-0.04,0.0647,-0.0247,0.0647,0.0247,0.04,0.04,0.0647,0.0247,0.0647,-0.0247,-0.04,0.04,-0.0647,-0.0247,0.0247,-0.04,-0.0647,-0.0247,-0.04,-0.0647,0,0,-0.08,-0.0247,0.04,-0.0647,0.0247,0.04,-0.0647,0.04,0.0647,-0.0247,0.0647,0.0247,-0.04,0.08,0,0],
          }],
          children: [],
        }],
      },
    ]
  };
})()

export const coinFlipPreset: SceneGraph = {
  nodes: [
    {
      id: 'coin',
      name: 'coin',
      type: 'body',
      pos: [0, 0, 0.5],
      joints: [
        { name: 'coin_free', type: 'free', initialVelocity: [0.0, 0.0, 5.0, 0.0, 15.0, 0.0], damping: 0.1 }
      ],
      script: `// Coin Flip Script
// On the very first frame of the simulation (time = 0),
// add a healthy amount of random perturbation to the launch angular velocity.
if (api.getTime() === 0) {
  const currentAngVel = api.getAngularVelocity();
  const wx = currentAngVel[0] + (Math.random() - 0.5) * (Math.abs(currentAngVel[0]) * 0.3 + 3.0);
  const wy = currentAngVel[1] + (Math.random() - 0.5) * (Math.abs(currentAngVel[1]) * 0.5 + 8.0);
  const wz = currentAngVel[2] + (Math.random() - 0.5) * (Math.abs(currentAngVel[2]) * 0.3 + 3.0);
  api.setAngularVelocity([wx, wy, wz]);
}
`,
      geoms: [
        {
          name: 'coin_base',
          type: 'cylinder',
          size: [0.25, 0.04],
          rgba: [0.85, 0.65, 0.12, 1],
          mass: 0.1,
          condim: 3,
          friction: [0.3, 0.005, 0.0001]
        },
        {
          name: 'coin_heads_face',
          type: 'cylinder',
          size: [0.25, 0.001],
          pos: [0, 0, 0.04],
          rgba: [0.95, 0.85, 0.3, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_heads_h1',
          type: 'box',
          size: [0.0125, 0.06, 0.004],
          pos: [-0.05, 0, 0.042],
          rgba: [0.4, 0.3, 0.1, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_heads_h2',
          type: 'box',
          size: [0.0125, 0.06, 0.004],
          pos: [0.05, 0, 0.042],
          rgba: [0.4, 0.3, 0.1, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_heads_h3',
          type: 'box',
          size: [0.0375, 0.0125, 0.004],
          pos: [0, 0, 0.042],
          rgba: [0.4, 0.3, 0.1, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_tails_face',
          type: 'cylinder',
          size: [0.25, 0.001],
          pos: [0, 0, -0.04],
          rgba: [0.75, 0.75, 0.8, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_tails_t1',
          type: 'box',
          size: [0.055, 0.0125, 0.004],
          pos: [0, 0.045, -0.042],
          rgba: [0.25, 0.25, 0.25, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_tails_t2',
          type: 'box',
          size: [0.0125, 0.045, 0.004],
          pos: [0, -0.0125, -0.042],
          rgba: [0.25, 0.25, 0.25, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        }
      ],
      children: []
    }
  ]
};

export const windmillPreset: SceneGraph = {
  nodes: [
    {
      id: 'tower',
      name: 'tower',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        { name: 'tower_base', type: 'cylinder', size: [0.2, 0.05], pos: [0, 0, 0.05], rgba: [0.7, 0.7, 0.7, 1] },
        { name: 'tower_mast', type: 'cylinder', size: [0.06, 1.2], pos: [0, 0, 1.2], rgba: [0.9, 0.9, 0.9, 1] }
      ],
      children: [
        {
          id: 'nacelle',
          name: 'nacelle',
          type: 'body',
          pos: [0, 0, 2.4],
          joints: [
            { name: 'yaw_hinge', type: 'hinge', axis: [0, 0, 1], damping: 20.0 }
          ],
          geoms: [
            { name: 'nacelle_body', type: 'box', size: [0.25, 0.12, 0.12], rgba: [0.9, 0.9, 0.9, 1], contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'tail_vane',
              name: 'tail_vane',
              type: 'body',
              pos: [-0.6, 0, 0.15],
              euler: [90, 0, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'vane_fin', type: 'box', size: [0.15, 0.2, 0.005], rgba: [0.85, 0.45, 0.25, 1], mass: 0.15, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'rotor',
              name: 'rotor',
              type: 'body',
              pos: [0.32, 0, 0],
              joints: [
                { name: 'rotor_hinge', type: 'hinge', axis: [1, 0, 0], damping: 0.15 }
              ],
              geoms: [
                { name: 'rotor_hub', type: 'sphere', size: [0.12], rgba: [0.85, 0.25, 0.25, 1], contype: 0, conaffinity: 0 }
              ],
              children: [
                {
                  id: 'blade1',
                  name: 'blade1',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, 12, 0],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'blade1_sail', type: 'box', size: [0.08, 0.6, 0.015], pos: [0, 0.8, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.3, contype: 0, conaffinity: 0 },
                    { name: 'blade1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.7, 0.7, 0.7, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade2',
                  name: 'blade2',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [120, 12, 0],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'blade2_sail', type: 'box', size: [0.08, 0.6, 0.015], pos: [0, 0.8, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.3, contype: 0, conaffinity: 0 },
                    { name: 'blade2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.7, 0.7, 0.7, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade3',
                  name: 'blade3',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [240, 12, 0],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'blade3_sail', type: 'box', size: [0.08, 0.6, 0.015], pos: [0, 0.8, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.3, contype: 0, conaffinity: 0 },
                    { name: 'blade3_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.7, 0.7, 0.7, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};

export const physicsOnlyWindmillPreset: SceneGraph = {
  nodes: [
    {
      id: 'tower',
      name: 'tower',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        { name: 'tower_base', type: 'cylinder', size: [0.2, 0.05], pos: [0, 0, 0.05], rgba: [0.7, 0.7, 0.7, 1] },
        { name: 'tower_mast', type: 'cylinder', size: [0.06, 1.2], pos: [0, 0, 1.2], rgba: [0.9, 0.9, 0.9, 1] }
      ],
      children: [
        {
          id: 'nacelle',
          name: 'nacelle',
          type: 'body',
          pos: [0, 0, 2.4],
          joints: [
            { name: 'yaw_hinge', type: 'hinge', axis: [0, 0, 1], damping: 20.0 }
          ],
          geoms: [
            { name: 'nacelle_body', type: 'box', size: [0.25, 0.12, 0.12], rgba: [0.9, 0.9, 0.9, 1], contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'tail_vane',
              name: 'tail_vane',
              type: 'body',
              pos: [-0.6, 0, 0.15],
              euler: [90, 0, 0],
              joints: [],
              geoms: [
                { name: 'vane_fin', type: 'box', size: [0.15, 0.2, 0.005], rgba: [0.85, 0.45, 0.25, 1], mass: 0.15, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'rotor',
              name: 'rotor',
              type: 'body',
              pos: [0.32, 0, 0],
              joints: [
                { name: 'rotor_hinge', type: 'hinge', axis: [1, 0, 0], damping: 0.15 }
              ],
              geoms: [
                { name: 'rotor_hub', type: 'sphere', size: [0.12], rgba: [0.85, 0.25, 0.25, 1], contype: 0, conaffinity: 0 }
              ],
              children: [
                {
                  id: 'blade1',
                  name: 'blade1',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, 12, 0],
                  joints: [],
                  geoms: [
                    { name: 'blade1_sail', type: 'box', size: [0.08, 0.6, 0.015], pos: [0, 0.8, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.3, contype: 0, conaffinity: 0 },
                    { name: 'blade1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.7, 0.7, 0.7, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade2',
                  name: 'blade2',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [120, 12, 0],
                  joints: [],
                  geoms: [
                    { name: 'blade2_sail', type: 'box', size: [0.08, 0.6, 0.015], pos: [0, 0.8, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.3, contype: 0, conaffinity: 0 },
                    { name: 'blade2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.7, 0.7, 0.7, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade3',
                  name: 'blade3',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [240, 12, 0],
                  joints: [],
                  geoms: [
                    { name: 'blade3_sail', type: 'box', size: [0.08, 0.6, 0.015], pos: [0, 0.8, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.3, contype: 0, conaffinity: 0 },
                    { name: 'blade3_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.7, 0.7, 0.7, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};

export const dronePreset: SceneGraph = {
  nodes: [
    {
      id: 'tower',
      name: 'tower',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        { name: 'tower_base', type: 'cylinder', size: [0.3, 0.05], pos: [0, 0, 0.05], rgba: [0.7, 0.7, 0.7, 1] },
        { name: 'tower_mast', type: 'cylinder', size: [0.015, 1.5], pos: [0, 0, 1.5], rgba: [0.9, 0.9, 0.9, 1], contype: 0, conaffinity: 0 }
      ],
      children: [
        {
          id: 'drone_body',
          name: 'drone_body',
          type: 'body',
          pos: [0, 0, 0.2],
          joints: [
            { name: 'drone_slide', type: 'slide', axis: [0, 0, 1], damping: 1.5, limited: true, range: [0.05, 2.8] },
            { name: 'drone_yaw', type: 'hinge', axis: [0, 0, 1], damping: 0.5 }
          ],
          geoms: [
            { name: 'fuselage', type: 'box', size: [0.12, 0.12, 0.06], rgba: [0.2, 0.5, 0.8, 1], mass: 0.3 },
            { name: 'arm1', type: 'cylinder', fromto: [0, 0, 0, 0.25, 0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
            { name: 'arm2', type: 'cylinder', fromto: [0, 0, 0, 0.25, -0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
            { name: 'arm3', type: 'cylinder', fromto: [0, 0, 0, -0.25, 0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
            { name: 'arm4', type: 'cylinder', fromto: [0, 0, 0, -0.25, -0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
            { name: 'pod1', type: 'cylinder', size: [0.025, 0.04], pos: [0.25, 0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
            { name: 'pod2', type: 'cylinder', size: [0.025, 0.04], pos: [0.25, -0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
            { name: 'pod3', type: 'cylinder', size: [0.025, 0.04], pos: [-0.25, 0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
            { name: 'pod4', type: 'cylinder', size: [0.025, 0.04], pos: [-0.25, -0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 }
          ],
          children: [
            {
              id: 'rotor1',
              name: 'rotor1',
              type: 'body',
              pos: [0.25, 0.25, 0.06],
              joints: [
                { name: 'rotor1_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
              ],
              geoms: [
                { name: 'hub1', type: 'sphere', size: [0.02], rgba: [0.85, 0.25, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
              ],
              children: [
                {
                  id: 'r1_b1',
                  name: 'r1_b1',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, 10, 0],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'r1_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                    { name: 'r1_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'r1_b2',
                  name: 'r1_b2',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, -10, 180],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'r1_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                    { name: 'r1_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                }
              ]
            },
            {
              id: 'rotor2',
              name: 'rotor2',
              type: 'body',
              pos: [0.25, -0.25, 0.06],
              joints: [
                { name: 'rotor2_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
              ],
              geoms: [
                { name: 'hub2', type: 'sphere', size: [0.02], rgba: [0.25, 0.85, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
              ],
              children: [
                {
                  id: 'r2_b1',
                  name: 'r2_b1',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, -10, 0],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'r2_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                    { name: 'r2_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'r2_b2',
                  name: 'r2_b2',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, 10, 180],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'r2_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                    { name: 'r2_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                }
              ]
            },
            {
              id: 'rotor3',
              name: 'rotor3',
              type: 'body',
              pos: [-0.25, 0.25, 0.06],
              joints: [
                { name: 'rotor3_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
              ],
              geoms: [
                { name: 'hub3', type: 'sphere', size: [0.02], rgba: [0.25, 0.85, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
              ],
              children: [
                {
                  id: 'r3_b1',
                  name: 'r3_b1',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, -10, 0],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'r3_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                    { name: 'r3_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'r3_b2',
                  name: 'r3_b2',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, 10, 180],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'r3_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                    { name: 'r3_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                }
              ]
            },
            {
              id: 'rotor4',
              name: 'rotor4',
              type: 'body',
              pos: [-0.25, -0.25, 0.06],
              joints: [
                { name: 'rotor4_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
              ],
              geoms: [
                { name: 'hub4', type: 'sphere', size: [0.02], rgba: [0.85, 0.25, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
              ],
              children: [
                {
                  id: 'r4_b1',
                  name: 'r4_b1',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, 10, 0],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'r4_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                    { name: 'r4_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'r4_b2',
                  name: 'r4_b2',
                  type: 'body',
                  pos: [0, 0, 0],
                  euler: [0, -10, 180],
                  isAerodynamic: true,
                  joints: [],
                  geoms: [
                    { name: 'r4_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                    { name: 'r4_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                }
              ]
            }
          ]
        }
      ]
    },
    {
      id: 'free_drone_body',
      name: 'free_drone_body',
      type: 'body',
      pos: [1.2, 0, 0.08],
      euler: [10, 10, 0],
      script: `
const R = api.getOrientation();
const angvel = api.getAngularVelocity();
const Kp = 12.0;
const Kd = 2.0;
const tx = Kp * R[5] - Kd * angvel[0];
const ty = -Kp * R[2] - Kd * angvel[1];
const tz = -0.5 * angvel[2];
api.applyTorque([tx, ty, tz]);
      `.trim(),
      joints: [
        { name: 'free_drone_free', type: 'free', damping: 0.5 }
      ],
      geoms: [
        { name: 'free_fuselage', type: 'box', size: [0.12, 0.12, 0.06], rgba: [0.8, 0.2, 0.5, 1], mass: 0.3 },
        { name: 'free_arm1', type: 'cylinder', fromto: [0, 0, 0, 0.25, 0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'free_arm2', type: 'cylinder', fromto: [0, 0, 0, 0.25, -0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'free_arm3', type: 'cylinder', fromto: [0, 0, 0, -0.25, 0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'free_arm4', type: 'cylinder', fromto: [0, 0, 0, -0.25, -0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'free_pod1', type: 'cylinder', size: [0.025, 0.04], pos: [0.25, 0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'free_pod2', type: 'cylinder', size: [0.025, 0.04], pos: [0.25, -0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'free_pod3', type: 'cylinder', size: [0.025, 0.04], pos: [-0.25, 0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'free_pod4', type: 'cylinder', size: [0.025, 0.04], pos: [-0.25, -0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 }
      ],
      children: [
        {
          id: 'free_rotor1',
          name: 'free_rotor1',
          type: 'body',
          pos: [0.25, 0.25, 0.06],
          joints: [
            { name: 'free_rotor1_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
          ],
          geoms: [
            { name: 'free_hub1', type: 'sphere', size: [0.02], rgba: [0.85, 0.25, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'free_r1_b1',
              name: 'free_r1_b1',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, 10, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'free_r1_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'free_r1_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'free_r1_b2',
              name: 'free_r1_b2',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, -10, 180],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'free_r1_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'free_r1_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'free_rotor2',
          name: 'free_rotor2',
          type: 'body',
          pos: [0.25, -0.25, 0.06],
          joints: [
            { name: 'free_rotor2_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
          ],
          geoms: [
            { name: 'free_hub2', type: 'sphere', size: [0.02], rgba: [0.25, 0.85, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'free_r2_b1',
              name: 'free_r2_b1',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, -10, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'free_r2_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'free_r2_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'free_r2_b2',
              name: 'free_r2_b2',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, 10, 180],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'free_r2_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'free_r2_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'free_rotor3',
          name: 'free_rotor3',
          type: 'body',
          pos: [-0.25, 0.25, 0.06],
          joints: [
            { name: 'free_rotor3_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
          ],
          geoms: [
            { name: 'free_hub3', type: 'sphere', size: [0.02], rgba: [0.25, 0.85, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'free_r3_b1',
              name: 'free_r3_b1',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, -10, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'free_r3_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'free_r3_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'free_r3_b2',
              name: 'free_r3_b2',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, 10, 180],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'free_r3_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'free_r3_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'free_rotor4',
          name: 'free_rotor4',
          type: 'body',
          pos: [-0.25, -0.25, 0.06],
          joints: [
            { name: 'free_rotor4_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
          ],
          geoms: [
            { name: 'free_hub4', type: 'sphere', size: [0.02], rgba: [0.85, 0.25, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'free_r4_b1',
              name: 'free_r4_b1',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, 10, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'free_r4_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'free_r4_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'free_r4_b2',
              name: 'free_r4_b2',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, -10, 180],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'free_r4_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'free_r4_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        }
      ]
    },
    {
      id: 'unstable_drone_body',
      name: 'unstable_drone_body',
      type: 'body',
      pos: [2.4, 0, 0.08],
      euler: [10, 10, 0],
      joints: [
        { name: 'unstable_drone_free', type: 'free', damping: 0.5 }
      ],
      geoms: [
        { name: 'unstable_fuselage', type: 'box', size: [0.12, 0.12, 0.06], rgba: [0.95, 0.85, 0.15, 1], mass: 0.3 },
        { name: 'unstable_arm1', type: 'cylinder', fromto: [0, 0, 0, 0.25, 0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'unstable_arm2', type: 'cylinder', fromto: [0, 0, 0, 0.25, -0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'unstable_arm3', type: 'cylinder', fromto: [0, 0, 0, -0.25, 0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'unstable_arm4', type: 'cylinder', fromto: [0, 0, 0, -0.25, -0.25, 0], size: [0.012], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'unstable_pod1', type: 'cylinder', size: [0.025, 0.04], pos: [0.25, 0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'unstable_pod2', type: 'cylinder', size: [0.025, 0.04], pos: [0.25, -0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'unstable_pod3', type: 'cylinder', size: [0.025, 0.04], pos: [-0.25, 0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'unstable_pod4', type: 'cylinder', size: [0.025, 0.04], pos: [-0.25, -0.25, 0.02], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 }
      ],
      children: [
        {
          id: 'unstable_rotor1',
          name: 'unstable_rotor1',
          type: 'body',
          pos: [0.25, 0.25, 0.06],
          joints: [
            { name: 'unstable_rotor1_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
          ],
          geoms: [
            { name: 'unstable_hub1', type: 'sphere', size: [0.02], rgba: [0.85, 0.25, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'unstable_r1_b1',
              name: 'unstable_r1_b1',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, 10, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'unstable_r1_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'unstable_r1_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'unstable_r1_b2',
              name: 'unstable_r1_b2',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, -10, 180],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'unstable_r1_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'unstable_r1_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'unstable_rotor2',
          name: 'unstable_rotor2',
          type: 'body',
          pos: [0.25, -0.25, 0.06],
          joints: [
            { name: 'unstable_rotor2_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
          ],
          geoms: [
            { name: 'unstable_hub2', type: 'sphere', size: [0.02], rgba: [0.25, 0.85, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'unstable_r2_b1',
              name: 'unstable_r2_b1',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, -10, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'unstable_r2_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'unstable_r2_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'unstable_r2_b2',
              name: 'unstable_r2_b2',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, 10, 180],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'unstable_r2_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'unstable_r2_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'unstable_rotor3',
          name: 'unstable_rotor3',
          type: 'body',
          pos: [-0.25, 0.25, 0.06],
          joints: [
            { name: 'unstable_rotor3_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
          ],
          geoms: [
            { name: 'unstable_hub3', type: 'sphere', size: [0.02], rgba: [0.25, 0.85, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'unstable_r3_b1',
              name: 'unstable_r3_b1',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, -10, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'unstable_r3_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'unstable_r3_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'unstable_r3_b2',
              name: 'unstable_r3_b2',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, 10, 180],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'unstable_r3_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'unstable_r3_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'unstable_rotor4',
          name: 'unstable_rotor4',
          type: 'body',
          pos: [-0.25, -0.25, 0.06],
          joints: [
            { name: 'unstable_rotor4_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
          ],
          geoms: [
            { name: 'unstable_hub4', type: 'sphere', size: [0.02], rgba: [0.85, 0.25, 0.25, 1], mass: 0.1, contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'unstable_r4_b1',
              name: 'unstable_r4_b1',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, 10, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'unstable_r4_b1_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'unstable_r4_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'unstable_r4_b2',
              name: 'unstable_r4_b2',
              type: 'body',
              pos: [0, 0, 0],
              euler: [0, -10, 180],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'unstable_r4_b2_sail', type: 'box', size: [0.03, 0.2, 0.002], pos: [0, 0.22, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.05, contype: 0, conaffinity: 0 },
                { name: 'unstable_r4_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.1, 0], size: [0.008], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        }
      ]
    }
  ]
};

export const emptyPreset: SceneGraph = {
  nodes: []
};

const rotorBEMScript4Blade = `
const omega = api.getJointVelocity('rotor_hinge');
const [windX, windY] = api.getWind();
const R = api.getOrientation();
const ax = R[0], ay = R[3], az = R[6];
const Vw = windX * ax + windY * ay;
const numBlades = 4;
const R_blade = 0.9, r_hub = 0.15, pitch = 18 * Math.PI / 180, rho = 1.225;
let totalTorque = 0;
const N = 5, dr = (R_blade - r_hub) / N;
for (let i = 0; i < N; i++) {
  const r = r_hub + (i + 0.5) * dr;
  const Vt = -omega * r;
  const Vrel = Math.sqrt(Vw * Vw + Vt * Vt);
  if (Vrel > 0.05) {
    const phi = Math.atan2(Math.abs(Vw), Math.abs(Vt));
    const alpha = phi - pitch;
    const CL = 1.5 * Math.sin(2 * alpha);
    const CD = 0.08 + 1.2 * Math.sin(alpha) * Math.sin(alpha);
    const chord = 0.22 * (1.0 - 0.3 * (r / R_blade));
    const q = 0.5 * rho * Vrel * Vrel;
    const dL = q * CL * chord * dr;
    const dD = q * CD * chord * dr;
    const signVw = Math.sign(Vw);
    const dFt = -signVw * (dL * Math.sin(phi) - dD * Math.cos(phi));
    totalTorque += dFt * r * numBlades;
  }
}
api.applyJointForce('rotor_hinge', totalTorque);
`.trim();

const yawScript = `
const [windX, windY] = api.getWind();
const targetYaw = Math.atan2(windY, windX);
const currentYaw = api.getJointPosition('yaw_hinge');
const yawError = targetYaw - currentYaw;
const yawVel = api.getJointVelocity('yaw_hinge');
api.applyJointForce('yaw_hinge', 8 * yawError - 3 * yawVel);
`.trim();

export const traditionalWindmillPreset: SceneGraph = {
  nodes: [
    {
      id: 'tower',
      name: 'tower',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        { name: 'base_box', type: 'box', size: [0.3, 0.3, 0.08], pos: [0, 0, 0.04], rgba: [0.65, 0.45, 0.25, 1], contype: 0, conaffinity: 0 },
        { name: 'tower_post', type: 'cylinder', size: [0.08, 1], pos: [0, 0, 1.08], rgba: [0.7, 0.5, 0.3, 1], contype: 0, conaffinity: 0 }
      ],
      children: [
        {
          id: 'nacelle',
          name: 'nacelle',
          type: 'body',
          pos: [0, 0, 2.1],
          joints: [{ name: 'yaw_hinge', type: 'hinge', axis: [0, 0, 1], damping: 2 }],
          geoms: [
            { name: 'nacelle_body', type: 'box', size: [0.18, 0.09, 0.09], rgba: [0.7, 0.5, 0.3, 1], contype: 0, conaffinity: 0 }
          ],
          script: yawScript,
          children: [
            {
              id: 'tail_vane',
              name: 'tail_vane',
              type: 'body',
              pos: [-0.5, 0, 0.12],
              euler: [90, 0, 0],
              joints: [],
              geoms: [
                { name: 'vane_fin', type: 'box', size: [0.12, 0.18, 0.005], rgba: [0.85, 0.45, 0.25, 1], mass: 0.15, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'rotor',
              name: 'rotor',
              type: 'body',
              pos: [0.28, 0, 0],
              joints: [{ name: 'rotor_hinge', type: 'hinge', axis: [1, 0, 0], damping: 0.15 }],
              geoms: [
                { name: 'rotor_hub', type: 'sphere', size: [0.1], rgba: [0.6, 0.4, 0.2, 1], contype: 0, conaffinity: 0 }
              ],
              script: rotorBEMScript4Blade,
              children: [
                {
                  id: 'blade1', name: 'blade1', type: 'body', pos: [0, 0, 0], euler: [0, 12, 0], joints: [],
                  geoms: [
                    { name: 'blade1_sail', type: 'box', size: [0.1, 0.55, 0.02], pos: [0, 0.75, 0], rgba: [0.95, 0.92, 0.8, 1], mass: 0.4, contype: 0, conaffinity: 0 },
                    { name: 'blade1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.6, 0.4, 0.2, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade2', name: 'blade2', type: 'body', pos: [0, 0, 0], euler: [90, 12, 0], joints: [],
                  geoms: [
                    { name: 'blade2_sail', type: 'box', size: [0.1, 0.55, 0.02], pos: [0, 0.75, 0], rgba: [0.95, 0.92, 0.8, 1], mass: 0.4, contype: 0, conaffinity: 0 },
                    { name: 'blade2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.6, 0.4, 0.2, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade3', name: 'blade3', type: 'body', pos: [0, 0, 0], euler: [180, 12, 0], joints: [],
                  geoms: [
                    { name: 'blade3_sail', type: 'box', size: [0.1, 0.55, 0.02], pos: [0, 0.75, 0], rgba: [0.95, 0.92, 0.8, 1], mass: 0.4, contype: 0, conaffinity: 0 },
                    { name: 'blade3_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.6, 0.4, 0.2, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade4', name: 'blade4', type: 'body', pos: [0, 0, 0], euler: [270, 12, 0], joints: [],
                  geoms: [
                    { name: 'blade4_sail', type: 'box', size: [0.1, 0.55, 0.02], pos: [0, 0.75, 0], rgba: [0.95, 0.92, 0.8, 1], mass: 0.4, contype: 0, conaffinity: 0 },
                    { name: 'blade4_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.2, 0], size: [0.025], rgba: [0.6, 0.4, 0.2, 1], mass: 0.1, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                }
              ]
            }
          ]
        }
      ]
    }
  ]
};

export const bouncyBallsPreset: SceneGraph = (() => {
  const colors: number[][] = [
    [0.95, 0.15, 0.15, 1], [0.15, 0.55, 0.95, 1], [0.15, 0.85, 0.30, 1],
    [0.95, 0.65, 0.10, 1], [0.75, 0.15, 0.90, 1], [0.10, 0.85, 0.85, 1],
    [0.95, 0.35, 0.75, 1], [0.50, 0.85, 0.10, 1], [0.95, 0.90, 0.10, 1],
    [0.90, 0.45, 0.10, 1], [0.20, 0.30, 0.90, 1], [0.85, 0.10, 0.45, 1],
    [0.10, 0.75, 0.50, 1], [0.60, 0.40, 0.90, 1], [0.95, 0.75, 0.45, 1],
    [0.30, 0.90, 0.70, 1], [0.90, 0.20, 0.60, 1], [0.45, 0.65, 0.10, 1],
    [0.80, 0.80, 0.20, 1], [0.10, 0.50, 0.70, 1],
  ];
  // Deterministic scatter across X/Y/Z using a simple LCG so balls don't stack
  const lcg = (s: number) => { let v = s; return () => { v = (v * 1664525 + 1013904223) & 0x7fffffff; return v / 0x7fffffff; }; };
  const rng = lcg(42);
  const positions: [number,number,number][] = colors.map(() => [
    (rng() - 0.5) * 4.0,   // X: -2..2
    (rng() - 0.5) * 2.0,   // Y: -1..1 (depth)
    1.5 + rng() * 5.0,      // Z: 1.5..6.5 (height, staggered)
  ]);
  const nodes = colors.map((rgba, i) => {
    const r = 0.18 + (i % 4) * 0.03; // radii 0.18, 0.21, 0.24, 0.27
    return {
      id: `ball_${i}`, name: `ball_${i}`, type: 'body' as const,
      pos: positions[i],
      joints: [{ name: `ball_${i}_free`, type: 'free' as const, initialVelocity: [0,0,0,0,0,0] }],
      geoms: [{ name: `ball_${i}_geom`, type: 'sphere' as const, size: [r], rgba, mass: 0.3,
        friction: [0.1, 0.005, 0.0001],
        solref: [0.04, 0.2],
        solimp: [0.99, 0.9999, 0.0001, 0.5, 2] }],
      children: [],
    };
  });
  return { nodes };
})();

export const openscadDemoPreset: SceneGraph = {
  nodes: [
    {
      id: 'scad_container',
      name: 'scad_container',
      type: 'body',
      pos: [0, 0, 0.4],
      joints: [{ name: 'scad_container_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [
        // Primitive collision proxies (floor + 4 walls) — each box is
        // individually convex, so together they form an actual hollow container.
        // A single dynamic mesh geom can't do this: MuJoCo collides dynamic
        // meshes via their convex hull, and the hull of a hollow box's vertices
        // is just the solid outer box (the hull fills in the concave interior),
        // so balls would land on what is effectively a solid block. The pretty
        // CSG mesh below stays purely visual (contype/conaffinity 0) and rides
        // along kinematically with the body. These proxies are colored to match
        // the mesh (not alpha:0 — this renderer's meshStandardMaterial never
        // reads the rgba alpha channel, so a=0 still rendered fully opaque,
        // as solid black, causing z-fighting with the visual mesh) so they
        // blend in seamlessly instead.
        { name: 'scad_container_floor', type: 'box', size: [0.4, 0.4, 0.0375], pos: [0, 0, -0.2125], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        { name: 'scad_container_wall_px', type: 'box', size: [0.0375, 0.4, 0.2125], pos: [0.3625, 0, 0.0375], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        { name: 'scad_container_wall_nx', type: 'box', size: [0.0375, 0.4, 0.2125], pos: [-0.3625, 0, 0.0375], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        { name: 'scad_container_wall_py', type: 'box', size: [0.4, 0.0375, 0.2125], pos: [0, 0.3625, 0.0375], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        { name: 'scad_container_wall_ny', type: 'box', size: [0.4, 0.0375, 0.2125], pos: [0, -0.3625, 0.0375], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        {
          name: 'scad_container_geom',
          type: 'mesh',
          size: [1],
          rgba: [0.2, 0.5, 0.8, 1], // blue container
          mass: 0.001,
          contype: 0,
          conaffinity: 0,
          dynamic: true,
          vertices: [
            -0.4, -0.25, -0.4,
             0.4, -0.25, -0.4,
             0.4, -0.25,  0.4,
            -0.4, -0.25,  0.4,
            -0.4,  0.25, -0.4,
             0.4,  0.25, -0.4,
             0.4,  0.25,  0.4,
            -0.4,  0.25,  0.4,
            -0.325, -0.175, -0.325,
             0.325, -0.175, -0.325,
             0.325, -0.175,  0.325,
            -0.325, -0.175,  0.325,
            -0.325,  0.25, -0.325,
             0.325,  0.25, -0.325,
             0.325,  0.25,  0.325,
            -0.325,  0.25,  0.325
          ],
          renderVertices: [
            -0.4,  0.4, -0.25,
             0.4,  0.4, -0.25,
             0.4, -0.4, -0.25,
            -0.4, -0.4, -0.25,
            -0.4,  0.4,  0.25,
             0.4,  0.4,  0.25,
             0.4, -0.4,  0.25,
            -0.4, -0.4,  0.25,
            -0.325, 0.325, -0.175,
             0.325, 0.325, -0.175,
             0.325, -0.325, -0.175,
            -0.325, -0.325, -0.175,
            -0.325, 0.325,  0.25,
             0.325, 0.325,  0.25,
             0.325, -0.325,  0.25,
            -0.325, -0.325,  0.25
          ],
          faces: [
            0, 1, 2,  0, 2, 3,
            0, 1, 5,  0, 5, 4,
            1, 2, 6,  1, 6, 5,
            2, 3, 7,  2, 7, 6,
            3, 0, 4,  3, 4, 7,
            4, 5, 13,  4, 13, 12,
            5, 6, 14,  5, 14, 13,
            6, 7, 15,  6, 15, 14,
            7, 4, 12,  7, 12, 15,
            8, 9, 10,  8, 10, 11,
            8, 12, 13,  8, 13, 9,
            9, 13, 14,  9, 14, 10,
            10, 14, 15,  10, 15, 11,
            11, 15, 12,  11, 12, 8
          ]
        }
      ],
      scad: `// OpenSCAD Showcase Scene\n// A hollow box that catches falling spheres!\nbox_size = 0.8; // [0.4:0.05:1.5]\nbox_height = 0.5; // [0.2:0.05:1.0]\ninner_size = 0.65; // [0.3:0.05:1.3]\ndifference() {\n  cube([box_size, box_size, box_height], center=true);\n  translate([0, 0, 0.075]) cube([inner_size, inner_size, box_height], center=true);\n}`,
      children: []
    },
    {
      id: 'ball_red',
      name: 'ball_red',
      type: 'body',
      pos: [-0.1, 0, 1.8],
      joints: [{ name: 'ball_red_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [{ name: 'ball_red_geom', type: 'sphere', size: [0.12], rgba: [0.8, 0.2, 0.2, 1], mass: 0.5 }],
      children: []
    },
    {
      id: 'ball_green',
      name: 'ball_green',
      type: 'body',
      pos: [0.15, 0, 2.3],
      joints: [{ name: 'ball_green_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [{ name: 'ball_green_geom', type: 'sphere', size: [0.10], rgba: [0.2, 0.8, 0.2, 1], mass: 0.4 }],
      children: []
    },
    {
      id: 'ball_yellow',
      name: 'ball_yellow',
      type: 'body',
      pos: [0, 0, 2.8],
      joints: [{ name: 'ball_yellow_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [{ name: 'ball_yellow_geom', type: 'sphere', size: [0.15], rgba: [0.8, 0.8, 0.2, 1], mass: 0.8 }],
      children: []
    }
  ]
};

export const ropeBridgePreset: SceneGraph = {
  nodes: [
    {
      id: 'rope_left_anchor',
      name: 'rope_left_anchor',
      type: 'body',
      pos: [-1.2, 0, 1.2],
      joints: [],
      geoms: [{ name: 'left_anchor_geom', type: 'box', size: [0.08, 0.08, 0.08], rgba: [0.4, 0.4, 0.4, 1] }],
      isComposite: true,
      compositeType: 'cable',
      compositeCount: '25 1 1',
      compositeSize: '2.4',
      compositePrefix: 'rope_',
      weldLastToId: 'rope_right_anchor',
      children: []
    },
    {
      id: 'rope_right_anchor',
      name: 'rope_right_anchor',
      type: 'body',
      pos: [1.2, 0, 1.2],
      joints: [],
      geoms: [{ name: 'right_anchor_geom', type: 'box', size: [0.08, 0.08, 0.08], rgba: [0.4, 0.4, 0.4, 1] }],
      children: []
    },
    {
      id: 'heavy_ball',
      name: 'heavy_ball',
      type: 'body',
      pos: [0, 0, 2.0],
      joints: [{ name: 'ball_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [{ name: 'ball_geom', type: 'sphere', size: [0.18], rgba: [0.9, 0.2, 0.2, 1], mass: 3.5 }],
      children: []
    }
  ]
};

export const PRESETS = {
  empty: {
    name: 'Blank (Empty)',
    scene: emptyPreset
  },
  pendulum: {
    name: 'Double Pendulum',
    scene: pendulumPreset
  },
  cubes: {
    name: 'Stacked Cubes',
    scene: stackedCubesPreset
  },
  gears: {
    name: 'Gear System',
    scene: gearsPreset
  },
  machine: {
    name: 'Gear Train Machine',
    scene: machinePreset
  },
  rack_pinion: {
    name: 'Rack and Pinion Converter',
    scene: rackPinionPreset
  },
  inclined_plane: {
    name: 'Inclined Plane',
    scene: inclinedPlanePreset
  },
  pulley_system: {
    name: 'Pulley System Stand',
    scene: pulleySystemPreset
  },
  cartpole: {
    name: 'Cartpole System',
    scene: cartpolePreset
  },
  newtons_cradle: {
    name: "Newton's Cradle",
    scene: newtonsCradlePreset
  },
  suspension_bridge: {
    name: 'Suspension Bridge',
    scene: suspensionBridgePreset
  },
  paper_plane: {
    name: 'Paper Plane',
    scene: paperPlanePreset
  },
  monkey_head: {
    name: 'Monkey Head',
    scene: monkeyHeadPreset
  },
  golden_gate: {
    name: 'Golden Gate Bridge',
    scene: goldenGateBridgePreset
  },
  golden_gate_mesh: {
    name: 'Golden Gate (Mesh)',
    scene: goldenGateMeshPreset
  },
  mesh_collision: {
    name: 'Mesh Collision Demo',
    scene: meshCollisionPreset
  },
  coin_flip: {
    name: 'Coin Flip',
    scene: coinFlipPreset
  },
  windmill: {
    name: 'Wind Turbine',
    scene: windmillPreset,
    environment: { windX: 5.0, windY: 0.0 }
  },
  physics_only_windmill: {
    name: 'Wind Turbine (No Aero)',
    scene: physicsOnlyWindmillPreset,
    environment: { windX: 5.0, windY: 0.0 }
  },
  traditional_windmill: {
    name: 'Traditional Windmill (4-Blade)',
    scene: traditionalWindmillPreset,
    environment: { windX: 5.0, windY: 0.0 }
  },
  drone: {
    name: 'Quadcopter Drone',
    scene: dronePreset
  },
  bouncy_balls: {
    name: 'Bouncy Balls',
    scene: bouncyBallsPreset,
    environment: { floorBounce: 0.85 }
  },
  openscad_demo: {
    name: 'OpenSCAD Showcase',
    scene: openscadDemoPreset
  },
  rope_bridge: {
    name: 'Interactive Rope Bridge',
    scene: ropeBridgePreset
  }
};
