import type { SceneGraph, SceneNode, SceneGeom } from '../types/scene';
import { generateCurveGeoms, generateWedgeMeshData } from '../utils/geom';

export const pendulumPreset: SceneGraph = {
  nodes: [
    {
      id: 'stand_base',
      name: 'stand_base',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: [
        { name: 'base_plate', type: 'box', size: [0.06, 0.06, 0.01], pos: [0, 0, 0.01], rgba: [0.3, 0.3, 0.35, 1], contype: 0, conaffinity: 0 },
        { name: 'stand_post', type: 'cylinder', size: [0.01, 0.28], pos: [0, 0, 0.29], rgba: [0.4, 0.4, 0.45, 1], contype: 0, conaffinity: 0 },
        { name: 'stand_axle', type: 'cylinder', size: [0.008, 0.04], pos: [0, 0, 0.58], euler: [90, 0, 0], rgba: [0.5, 0.5, 0.55, 1], contype: 0, conaffinity: 0 }
      ],
      children: [
        {
          id: 'pole',
          name: 'pole',
          type: 'body',
          pos: [0, 0, 0.58],
          joints: [
            { name: 'hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.001 }
          ],
          geoms: [
            { name: 'pole_geom', type: 'capsule', fromto: [0, 0, 0, 0.22, 0, 0], size: [0.005], mass: 0.05, rgba: [0.7, 0.7, 0.7, 1] },
            { name: 'pole_bob_geom', type: 'sphere', size: [0.018], pos: [0.22, 0, 0], mass: 0.3, rgba: [0.3, 0.5, 0.85, 1] }
          ],
          children: [
            {
              id: 'pole2',
              name: 'pole2',
              type: 'body',
              pos: [0.22, 0, 0],
              joints: [
                { name: 'hinge2', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.001 }
              ],
              geoms: [
                { name: 'pole2_geom', type: 'capsule', fromto: [0, 0, 0, 0.22, 0, 0], size: [0.005], mass: 0.05, rgba: [0.6, 0.6, 0.6, 1] },
                { name: 'bob_geom', type: 'sphere', size: [0.022], pos: [0.22, 0, 0], mass: 0.5, rgba: [0.2, 0.6, 1.0, 1] }
              ],
              children: []
            }
          ]
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
      pos: [0, 0, 0.08],
      joints: [
        { name: 'cube1_free', type: 'free' }
      ],
      geoms: [
        { name: 'cube1_geom', type: 'box', size: [0.08, 0.08, 0.08], mass: 1, rgba: [0.8, 0.2, 0.2, 1] }
      ],
      children: []
    },
    {
      id: 'cube2',
      name: 'cube2',
      type: 'body',
      pos: [0, 0, 0.24],
      joints: [
        { name: 'cube2_free', type: 'free' }
      ],
      geoms: [
        { name: 'cube2_geom', type: 'box', size: [0.08, 0.08, 0.08], mass: 1, rgba: [0.2, 0.8, 0.2, 1] }
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
    size: [radius, 0.02], // radius, half-height
    rgba: color,
    mass: 0.05,
    contype,
    conaffinity
  });

  // Teeth as single boxes radiating outward (square cogs!)
  const toothWidth = (Math.PI * radius * 2) / (teeth * 2.8);
  const toothThickness = 0.03;
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
    // Two meshing gears at 0.1m radius
    createGear('gear1', 'gear1', [-0.1, 0, 0.03], 0.1, 12, [0.8, 0.4, 0.2, 1], true, false),
    createGear('gear2', 'gear2', [0.1, 0, 0.03], 0.1, 12, [0.2, 0.6, 0.8, 1], false, true)
  ]
};

const machineGear1 = createGear('gear1', 'gear1', [-0.2, -0.1, 0.03], 0.1, 12, [0.8, 0.4, 0.2, 1], true, false);
machineGear1.geoms.push({
  name: 'gear1_shaft',
  type: 'cylinder',
  size: [0.02, 0.04],
  pos: [0, 0, 0.04],
  rgba: [0.45, 0.45, 0.45, 1],
  mass: 0.1,
  contype: 0,
  conaffinity: 0
});

const machineGear2 = createGear('gear2', 'gear2', [0.0, -0.1, 0.03], 0.1, 12, [0.2, 0.6, 0.8, 1], false, true);

const machineGear3 = createGear('gear3', 'gear3', [0.0, 0.1, 0.03], 0.1, 12, [0.2, 0.8, 0.4, 1], false, false);
machineGear3.geoms.push({
  name: 'gear3_pusher_peg',
  type: 'cylinder',
  size: [0.015, 0.04],
  pos: [0.08, 0.0, 0.06],
  rgba: [0.9, 0.2, 0.2, 1],
  mass: 0.05,
  condim: 3
});

const machineShelf: SceneNode = {
  id: 'shelf',
  name: 'shelf',
  type: 'body',
  pos: [0.2, 0.08, 0.03],
  joints: [],
  geoms: [
    {
      name: 'shelf_geom',
      type: 'box',
      size: [0.06, 0.06, 0.03],
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
  pos: [0.17, 0.08, 0.09],
  joints: [
    { name: 'push_block_free', type: 'free' }
  ],
  geoms: [
    {
      name: 'push_block_geom',
      type: 'box',
      size: [0.025, 0.025, 0.025],
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
const pinionPitch = (Math.PI * 2 * 0.08) / 8;
const rackTeethChildren: SceneNode[] = [];
let toothIndex = 0;
// Space teeth along a 0.35m long rack base (from -0.15 to 0.15)
for (let x = -0.15; x <= 0.15; x += pinionPitch) {
  rackTeethChildren.push({
    id: `rack_tooth_${toothIndex}`,
    name: `tooth_${toothIndex}`,
    type: 'body',
    pos: [x, 0.02, 0],
    joints: [],
    geoms: [
      {
        name: `rack_tooth_${toothIndex}_geom`,
        type: 'box',
        size: [0.005, 0.008, 0.01],
        rgba: [0.7, 0.7, 0.7, 1],
        mass: 0.01
      }
    ],
    children: []
  });
  toothIndex++;
}

// Rack body node with X slide joint limited to [-0.3, 0.3] range
const rackNode: SceneNode = {
  id: 'rack',
  name: 'rack',
  type: 'body',
  pos: [0, -0.12, 0.03],
  joints: [
    { name: 'rack_slide', type: 'slide', axis: [1, 0, 0], damping: 0.5, limited: true, range: [-0.3, 0.3] }
  ],
  geoms: [
    {
      name: 'rack_base',
      type: 'box',
      size: [0.18, 0.02, 0.02],
      rgba: [0.8, 0.8, 0.8, 1],
      mass: 0.5
    }
  ],
  children: rackTeethChildren
};

// Pinion gear with velocity motor
const pinionNode = createGear('pinion', 'pinion', [0, 0, 0.03], 0.08, 8, [0.2, 0.6, 0.8, 1], true);

// Shelf and block at the right end of the rack path, perfectly aligned in Y (-0.12)
const rackShelf: SceneNode = {
  id: 'rack_shelf',
  name: 'rack_shelf',
  type: 'body',
  pos: [0.35, -0.12, 0.03],
  joints: [],
  geoms: [
    {
      name: 'rack_shelf_geom',
      type: 'box',
      size: [0.05, 0.05, 0.03],
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
  pos: [0.30, -0.12, 0.09],
  joints: [
    { name: 'rack_block_free', type: 'free' }
  ],
  geoms: [
    {
      name: 'rack_block_geom',
      type: 'box',
      size: [0.025, 0.025, 0.025],
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

const inclinedPlaneWedgeMesh = generateWedgeMeshData(0.35, 0.2, 0.16);

export const inclinedPlanePreset: SceneGraph = {
  nodes: [
    {
      id: 'inclined_wedge',
      name: 'inclined_wedge',
      type: 'body',
      pos: [0, 0, 0],
      isWedge: true,
      width: 0.35,
      depth: 0.2,
      height: 0.16,
      wedgeAngle: 24.58,
      joints: [],
      geoms: [
        {
          name: 'wedge_geom',
          type: 'mesh',
          dynamic: true,
          size: [0.175, 0.1, 0.08],
          vertices: inclinedPlaneWedgeMesh.vertices,
          faces: inclinedPlaneWedgeMesh.faces,
          renderVertices: inclinedPlaneWedgeMesh.renderVertices,
          rgba: [0.8, 0.5, 0.2, 1],
          mass: 10,
          condim: 3,
          friction: [0.15, 0.005, 0.0005]
        }
      ],
      children: []
    },
    {
      id: 'sliding_cube',
      name: 'sliding_cube',
      type: 'body',
      pos: [-0.12, 0, 0.3],
      geoms: [
        {
          name: 'sliding_cube_geom',
          type: 'box',
          size: [0.03, 0.03, 0.03],
          rgba: [0.95, 0.8, 0.2, 1],
          mass: 0.5,
          condim: 3,
          friction: [0.12, 0.005, 0.0005]
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
          fromto: [0, 0, 0, 0, 0, 0.6],
          size: [0.02],
          rgba: [0.4, 0.4, 0.4, 1]
        },
        {
          name: 'support_peg',
          type: 'capsule',
          fromto: [0, 0, 0.55, 0, -0.15, 0.55],
          size: [0.015],
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
      pos: [0, -0.12, 0.55],
      isPulleyWheel: true,
      pulleyRadius: 0.08,
      geoms: [
        { name: 'pulley_wheel_spindle', type: 'cylinder', size: [0.064, 0.01], pos: [0, 0, 0], euler: [90, 0, 0], rgba: [0.3, 0.4, 0.6, 1], mass: 0.2 },
        { name: 'pulley_wheel_flange_l', type: 'cylinder', size: [0.08, 0.003], pos: [0, -0.015, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.1 },
        { name: 'pulley_wheel_flange_r', type: 'cylinder', size: [0.08, 0.003], pos: [0, 0.015, 0], euler: [90, 0, 0], rgba: [0.2, 0.3, 0.5, 1], mass: 0.1 }
      ],
      joints: [
        { name: 'pulley_wheel_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.1 }
      ],
      children: []
    },
    {
      id: 'left_weight',
      name: 'left_weight',
      type: 'body',
      pos: [-0.1, -0.12, 0.28],
      geoms: [
        {
          name: 'left_weight_geom',
          type: 'box',
          size: [0.04, 0.04, 0.04],
          rgba: [0.2, 0.6, 1.0, 1],
          mass: 2.0,
          condim: 3
        }
      ],
      joints: [
        { name: 'left_weight_joint', type: 'slide', axis: [0, 0, 1], damping: 0.5 }
      ],
      children: []
    },
    {
      id: 'right_weight',
      name: 'right_weight',
      type: 'body',
      pos: [0.1, -0.12, 0.28],
      geoms: [
        {
          name: 'right_weight_geom',
          type: 'box',
          size: [0.04, 0.04, 0.04],
          rgba: [0.95, 0.8, 0.2, 1],
          mass: 1.0,
          condim: 3
        }
      ],
      joints: [
        { name: 'right_weight_joint', type: 'slide', axis: [0, 0, 1], damping: 0.5 }
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
      pos: [0, 0, 0.35],
      joints: [],
      geoms: [
        {
          name: 'rail_geom',
          type: 'cylinder',
          size: [0.006],
          rgba: [0.3, 0.35, 0.4, 0.5],
          fromto: [-0.4, 0, 0, 0.4, 0, 0],
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
      pos: [0, 0, 0.35],
      joints: [
        { name: 'cart_slide', type: 'slide', axis: [1, 0, 0], damping: 0.1, limited: true, range: [-0.35, 0.35] }
      ],
      script: `// Cartpole LQR Balancing Controller
const x = api.getJointPosition('cart_slide');
const v = api.getJointVelocity('cart_slide');
const theta = api.getJointPosition('pole_hinge');
const omega = api.getJointVelocity('pole_hinge');

const kx = 12.0;
const kv = 8.0;
const kTheta = 55.0;
const kOmega = 14.0;

const force = (-kx * x) + (-kv * v) + (kTheta * theta) + (kOmega * omega);
api.applyJointForce('cart_slide', force);
`,
      geoms: [
        {
          name: 'cart_geom',
          type: 'box',
          size: [0.06, 0.05, 0.03],
          rgba: [0.15, 0.5, 0.85, 1],
          mass: 0.6,
          condim: 3
        }
      ],
      children: [
        {
          id: 'pole',
          name: 'pole',
          type: 'body',
          pos: [0, 0, 0.03],
          euler: [0, 5, 0],
          joints: [
            { name: 'pole_hinge', type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.005 }
          ],
          geoms: [
            {
              name: 'pole_rod_geom',
              type: 'capsule',
              fromto: [0, 0, 0, 0, 0, 0.35],
              size: [0.006],
              rgba: [0.65, 0.65, 0.65, 1],
              mass: 0.1
            }
          ],
          children: [
            {
              id: 'pole_weight',
              name: 'pole_weight',
              type: 'body',
              pos: [0, 0, 0.35],
              joints: [],
              geoms: [
                {
                  name: 'pole_weight_geom',
                  type: 'sphere',
                  pos: [0, 0, 0],
                  size: [0.02],
                  rgba: [0.85, 0.25, 0.25, 1],
                  mass: 0.25,
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
      pos: [0, 0, 0.45],
      joints: [],
      geoms: [
        { name: 'bar_geom', type: 'cylinder', size: [0.01, 0.12], pos: [0, 0, 0], euler: [0, 90, 0], rgba: [0.3, 0.3, 0.3, 1], contype: 0, conaffinity: 0 }
      ],
      children: []
    },
    ...Array.from({ length: 5 }).map((_, idx): SceneNode => {
      const x = -0.08 + idx * 0.04;
      const isFirst = idx === 0;
      
      return {
        id: `cradle_${idx}`,
        name: `cradle_${idx}`,
        type: 'body',
        pos: [x, 0, 0.45],
        euler: isFirst ? [0, 35, 0] : [0, 0, 0],
        joints: [
          { name: `cradle_joint_${idx}`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.02, limited: true, range: [-90, 90] }
        ],
        geoms: [
          { name: `cradle_rod_${idx}`, type: 'capsule', fromto: [0, 0, 0, 0, 0, -0.25], size: [0.004], mass: 0.05, rgba: [0.7, 0.7, 0.7, 1], contype: 0, conaffinity: 0 }
        ],
        children: [
          {
            id: `cradle_bob_body_${idx}`,
            name: `cradle_bob_body_${idx}`,
            type: 'body',
            pos: [0, 0, -0.25],
            joints: [],
            geoms: [
              { name: `cradle_ball_${idx}`, type: 'sphere', size: [0.0198], pos: [0, 0, 0], mass: 1, rgba: [0.8, 0.8, 0.8, 1], solref: [-5000, -50.0], solimp: [0.98, 0.99, 0.001, 0.5, 2] }
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
  const plankLength = 0.065;
  
  const createPlankNode = (index: number): SceneNode => {
    const isFirst = index === 1;
    const isLast = index === planksCount;
    
    return {
      id: `plank_${index}`,
      name: `plank_${index}`,
      type: 'body',
      pos: isFirst ? [-0.325, 0, 0.2] : [plankLength, 0, 0],
      joints: [
        { name: `plank_joint_${index}`, type: 'hinge', axis: [0, 1, 0], pos: [0, 0, 0], damping: 0.02 }
      ],
      geoms: [
        { 
          name: `plank_geom_${index}`, 
          type: 'box', 
          size: [plankLength / 2, 0.08, 0.008], 
          pos: [plankLength / 2, 0, 0], 
          rgba: [0.65, 0.45, 0.25, 1], 
          mass: 0.1,
          condim: 3,
          friction: [0.8, 0.01, 0.001]
        }
      ],
      children: isLast ? [] : [createPlankNode(index + 1)],
      ...(isLast ? { connectTargetId: 'support_r', connectAnchor: [0.325, 0, 0.2] } : {})
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
      pos: [-0.35, 0, 0.1],
      joints: [],
      geoms: [
        { name: 'support_l_geom', type: 'box', size: [0.025, 0.1, 0.1], rgba: [0.4, 0.45, 0.5, 1] }
      ],
      children: []
    },
    {
      id: 'support_r',
      name: 'support_r',
      type: 'body',
      pos: [0.35, 0, 0.1],
      joints: [],
      geoms: [
        { name: 'support_r_geom', type: 'box', size: [0.025, 0.1, 0.1], rgba: [0.4, 0.45, 0.5, 1] }
      ],
      children: []
    },
    ...generateBridgePlanks(),
    {
      id: 'rolling_ball',
      name: 'rolling_ball',
      type: 'body',
      pos: [-0.28, 0, 0.25],
      joints: [
        { name: 'rolling_ball_free', type: 'free' }
      ],
      geoms: [
        { 
          name: 'ball_geom', 
          type: 'sphere', 
          size: [0.035], 
          rgba: [0.85, 0.25, 0.25, 1], 
          mass: 0.25, 
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
      pos: [0, 0, 0.4],
      euler: [0, 8, 0],
      isAerodynamic: true,
      joints: [
        { name: 'plane_free', type: 'free', initialVelocity: [2.0, 0.0, 0.2, 0.0, 0.0, 0.0] }
      ],
      geoms: [
        {
          name: 'wing_geom',
          type: 'box',
          size: [0.03, 0.14, 0.003],
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
    id: 'monkey', name: 'monkey', type: 'body', pos: [0, 0, 0.25],
    joints: [{ name: 'monkey_free', type: 'free' }],
    geoms: [
      { name: 'skull',        type: 'ellipsoid', size: [0.15, 0.16, 0.14], rgba: [0.88, 0.66, 0.30, 1] },
      { name: 'cheek_l',      type: 'ellipsoid', size: [0.05, 0.04, 0.04], pos: [-0.11, 0.02, -0.02], rgba: [0.80, 0.58, 0.26, 1] },
      { name: 'cheek_r',      type: 'ellipsoid', size: [0.05, 0.04, 0.04], pos: [ 0.11, 0.02, -0.02], rgba: [0.80, 0.58, 0.26, 1] },
      { name: 'snout',        type: 'ellipsoid', size: [0.06, 0.05, 0.04], pos: [0, 0.17, -0.03],     rgba: [0.86, 0.68, 0.34, 1] },
      { name: 'nostril_l',    type: 'sphere',    size: [0.015],            pos: [-0.025, 0.21, -0.03], rgba: [0.15, 0.08, 0.03, 1] },
      { name: 'nostril_r',    type: 'sphere',    size: [0.015],            pos: [ 0.025, 0.21, -0.03], rgba: [0.15, 0.08, 0.03, 1] },
      { name: 'brow',         type: 'box',       size: [0.09, 0.018, 0.014], pos: [0, 0.13, 0.08],      rgba: [0.40, 0.24, 0.08, 1] },
      { name: 'eye_socket_l', type: 'sphere',    size: [0.035],            pos: [-0.06, 0.14, 0.02],  rgba: [0.15, 0.08, 0.03, 1] },
      { name: 'eye_socket_r', type: 'sphere',    size: [0.035],            pos: [ 0.06, 0.14, 0.02],  rgba: [0.15, 0.08, 0.03, 1] },
      { name: 'eye_l',        type: 'sphere',    size: [0.028],            pos: [-0.06, 0.17, 0.02],  rgba: [0.95, 0.95, 0.93, 1] },
      { name: 'eye_r',        type: 'sphere',    size: [0.028],            pos: [ 0.06, 0.17, 0.02],  rgba: [0.95, 0.95, 0.93, 1] },
      { name: 'pupil_l',      type: 'sphere',    size: [0.014],            pos: [-0.06, 0.19, 0.02],  rgba: [0.04, 0.04, 0.04, 1] },
      { name: 'pupil_r',      type: 'sphere',    size: [0.014],            pos: [ 0.06, 0.19, 0.02],  rgba: [0.04, 0.04, 0.04, 1] },
      { name: 'jaw',          type: 'ellipsoid', size: [0.08, 0.06, 0.03], pos: [0, 0.05, -0.12],     rgba: [0.80, 0.56, 0.24, 1] },
      { name: 'ear_l',        type: 'ellipsoid', size: [0.03, 0.02, 0.05], pos: [-0.17, -0.03, 0.04], rgba: [0.84, 0.62, 0.28, 1] },
      { name: 'ear_r',        type: 'ellipsoid', size: [0.03, 0.02, 0.05], pos: [ 0.17, -0.03, 0.04], rgba: [0.84, 0.62, 0.28, 1] },
      { name: 'ear_inner_l',  type: 'ellipsoid', size: [0.016, 0.012, 0.03], pos: [-0.17, 0.00, 0.04], rgba: [0.48, 0.26, 0.10, 1] },
      { name: 'ear_inner_r',  type: 'ellipsoid', size: [0.016, 0.012, 0.03], pos: [ 0.17, 0.00, 0.04], rgba: [0.48, 0.26, 0.10, 1] },
      { name: 'chin',         type: 'sphere',    size: [0.025],            pos: [0, 0.15, -0.14],     rgba: [0.80, 0.56, 0.24, 1] },
    ],
    children: []
  }]
};

// Golden Gate bridge — all primitives so the structure physically simulates.
export const goldenGateBridgePreset: SceneGraph = (() => {
  const ORANGE = [0.80, 0.25, 0.08, 1] as number[];
  const GREY   = [0.55, 0.55, 0.55, 1] as number[];
  const CABLE  = [0.60, 0.18, 0.05, 1] as number[];
  const HANGER = [0.65, 0.65, 0.65, 1] as number[];

  const makeTowerGeoms = (x: number, prefix: string): SceneGeom[] => [
    { name: `${prefix}_leg_f`, type: 'box',     size: [0.02, 0.02, 0.2], pos: [x, -0.08, 0.2], rgba: ORANGE },
    { name: `${prefix}_leg_b`, type: 'box',     size: [0.02, 0.02, 0.2], pos: [x,  0.08, 0.2], rgba: ORANGE },
    { name: `${prefix}_xb_lo`, type: 'box',     size: [0.02, 0.10, 0.015], pos: [x, 0, 0.1],   rgba: ORANGE },
    { name: `${prefix}_xb_hi`, type: 'box',     size: [0.02, 0.10, 0.015], pos: [x, 0, 0.35],  rgba: ORANGE },
  ];

  const makeCableGeoms = (y: number, prefix: string): SceneGeom[] => {
    const geoms: SceneGeom[] = [];
    const N = 16;
    for (let i = 0; i < N; i++) {
      const t0 = i / N, t1 = (i + 1) / N;
      const x0 = -0.35 + t0 * 0.7, x1 = -0.35 + t1 * 0.7;
      const z0 = 0.4 - 0.8 * t0 * (1 - t0), z1 = 0.4 - 0.8 * t1 * (1 - t1);
      geoms.push({ name: `${prefix}_${i}`, type: 'capsule', size: [0.008], fromto: [x0, y, z0, x1, y, z1], rgba: CABLE });
    }
    return geoms;
  };

  const makeHangerGeoms = (y: number, prefix: string): SceneGeom[] => {
    const geoms: SceneGeom[] = [];
    for (let i = 1; i < 12; i++) {
      const t = i / 12;
      const x = -0.35 + t * 0.7;
      const zTop = 0.4 - 0.8 * t * (1 - t);
      geoms.push({ name: `${prefix}_${i}`, type: 'capsule', size: [0.004], fromto: [x, y, zTop, x, y, 0.08], rgba: HANGER });
    }
    return geoms;
  };

  return {
    nodes: [
      {
        id: 'gg_towers', name: 'gg_towers', type: 'body' as const, pos: [0, 0, 0], joints: [],
        geoms: [...makeTowerGeoms(-0.35, 'tl'), ...makeTowerGeoms(0.35, 'tr')],
        children: [],
      },
      {
        id: 'gg_deck', name: 'gg_deck', type: 'body' as const, pos: [0, 0, 0],
        joints: [{ name: 'gg_sway', type: 'ball', pos: [0, 0, 0], damping: 30, stiffness: 120 }],
        geoms: [
          { name: 'gg_deck_box', type: 'box', size: [0.35, 0.08, 0.01], pos: [0, 0, 0.08], rgba: GREY, mass: 60 },
          ...makeCableGeoms(-0.08, 'cf'), ...makeCableGeoms(0.08, 'cb'),
          ...makeHangerGeoms(-0.08, 'hf'), ...makeHangerGeoms(0.08, 'hb'),
        ],
        children: [],
      },
    ]
  };
})();

// Golden Gate bridge — mesh version (visual/decorative only, no simulation).
export const goldenGateMeshPreset: SceneGraph = (() => {
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

  const deck = box(0, 0.08, 0,  0.35, 0.01, 0.08);

  function makeTower(cx: number) {
    return merge([
      box(cx, 0.2, -0.08,  0.02, 0.2, 0.02),
      box(cx, 0.2,  0.08,  0.02, 0.2, 0.02),
      box(cx, 0.1,  0,     0.02, 0.01, 0.09),
      box(cx, 0.35, 0,     0.02, 0.01, 0.09),
    ]);
  }

  function makeCable(cz: number) {
    const parts = [];
    const N = 24;
    for (let i = 0; i < N; i++) {
      const t0 = i/N, t1 = (i+1)/N;
      const x0 = -0.35 + t0*0.7, x1 = -0.35 + t1*0.7;
      const y0 = 0.4 - 0.8*t0*(1-t0), y1 = 0.4 - 0.8*t1*(1-t1);
      const len = Math.sqrt((x1-x0)**2 + (y1-y0)**2)/2 + 0.005;
      parts.push(box((x0+x1)/2, (y0+y1)/2, cz,  len, 0.008, 0.008));
    }
    return merge(parts);
  }

  function makeHangers(cz: number) {
    const parts = [];
    for (let i = 1; i < 14; i++) {
      const t = i/14;
      const x = -0.35 + t*0.7;
      const yTop = 0.4 - 0.8*t*(1-t);
      parts.push(box(x, (yTop+0.08)/2, cz,  0.004, (yTop-0.08)/2, 0.004));
    }
    return merge(parts);
  }

  const towerL  = makeTower(-0.35);
  const towerR  = makeTower( 0.35);
  const cable1  = makeCable(-0.08);
  const cable2  = makeCable( 0.08);
  const hang1   = makeHangers(-0.08);
  const hang2   = makeHangers( 0.08);

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
  const rampYup = [
    -0.25, 0,   -0.12,
    -0.25, 0,    0.12,
     0.25, 0.2, -0.12,
     0.25, 0.2,  0.12,
     0.25, 0,   -0.12,
     0.25, 0,    0.12,
  ];
  const rampFaces = [0,1,3, 0,3,2, 0,2,4, 1,3,5, 2,3,5, 2,5,4, 0,5,1, 0,4,5];

  const pyramidYup = [
    -0.12, 0,  0.12,
     0.12, 0,  0.12,
     0.12, 0, -0.12,
    -0.12, 0, -0.12,
     0.0,  0.2, 0.0,
  ];
  const pyramidFaces = [0,4,1, 1,4,2, 2,4,3, 3,4,0, 0,1,2, 0,2,3];

  const rampRV = [
    -0.25, 0.12, 0,  -0.25, -0.12, 0,
     0.25, 0.12, 0.2, 0.25, -0.12, 0.2,
     0.25, 0.12, 0,   0.25, -0.12, 0,
  ];
  const pyramidRV = [
    -0.12, -0.12, 0,  0.12, -0.12, 0,
     0.12,  0.12, 0, -0.12,  0.12, 0,
     0.0,   0.0, 0.2,
  ];

  return {
    nodes: [
      {
        id: 'ramp', name: 'ramp', type: 'body',
        pos: [0, 0, 0],
        joints: [],
        geoms: [{
          name: 'ramp_mesh', type: 'mesh', size: [1],
          rgba: [0.5, 0.6, 0.7, 1], mass: 50, condim: 3,
          friction: [0.4, 0.005, 0.0005],
          vertices: rampYup, faces: rampFaces,
          dynamic: true, renderVertices: rampRV,
        }],
        children: [],
      },
      {
        id: 'pyramid', name: 'pyramid', type: 'body',
        pos: [-0.08, 0.04, 0.4],
        joints: [{ name: 'pyramid_free', type: 'free' }],
        geoms: [{
          name: 'pyramid_mesh', type: 'mesh', size: [1],
          rgba: [0.85, 0.35, 0.15, 1], mass: 1, condim: 3,
          friction: [0.5, 0.005, 0.0005],
          vertices: pyramidYup, faces: pyramidFaces,
          dynamic: true, renderVertices: pyramidRV,
        }],
        children: [{
          id: 'pyramid_apex', name: 'pyramid_apex', type: 'body',
          pos: [0, 0, 0.2],
          joints: [],
          geoms: [{
            name: 'apex_poly', type: 'mesh', size: [1],
            rgba: [1.0, 0.9, 0.2, 1], mass: 0.05, condim: 3,
            vertices: [-0.0421,0.0681,0,0.0421,0.0681,0,-0.0421,-0.0681,0,0.0421,-0.0681,0,0,-0.0421,0.0681,0,0.0421,0.0681,0,-0.0421,-0.0681,0,0.0421,-0.0681,0.0681,0,-0.0421,0.0681,0,0.0421,-0.0681,0,-0.0421,-0.0681,0,0.0421,-0.0647,0.04,0.0247,-0.04,0.0247,0.0647,-0.0247,0.0647,0.04,0.0247,0.0647,0.04,0,0.08,0,0.0247,0.0647,-0.04,-0.0247,0.0647,-0.04,-0.04,0.0247,-0.0647,-0.0647,0.04,-0.0247,-0.08,0,0,0.04,0.0247,0.0647,0.0647,0.04,0.0247,-0.04,-0.0247,0.0647,0,0,0.08,-0.0647,-0.04,-0.0247,-0.0647,-0.04,0.0247,0,0,-0.08,-0.04,-0.0247,-0.0647,0.0647,0.04,-0.0247,0.04,0.0247,-0.0647,0.0647,-0.04,0.0247,0.04,-0.0247,0.0647,0.0247,-0.0647,0.04,-0.0247,-0.0647,0.04,0,-0.08,0,-0.0247,-0.0647,-0.04,0.0247,-0.0647,-0.04,0.04,-0.0247,-0.0647,0.0647,-0.04,-0.0247,0.08,0,0],
            faces: [0,12,14,11,13,12,5,14,13,12,13,14,0,14,16,5,15,14,1,16,15,14,15,16,0,16,18,1,17,16,7,18,17,16,17,18,0,18,20,7,19,18,10,20,19,18,19,20,0,20,12,10,21,20,11,12,21,20,21,12,1,15,23,5,22,15,9,23,22,15,22,23,5,13,25,11,24,13,4,25,24,13,24,25,11,21,27,10,26,21,2,27,26,21,26,27,10,19,29,7,28,19,6,29,28,19,28,29,7,17,31,1,30,17,8,31,30,17,30,31,3,32,34,9,33,32,4,34,33,32,33,34,3,34,36,4,35,34,2,36,35,34,35,36,3,36,38,2,37,36,6,38,37,36,37,38,3,38,40,6,39,38,8,40,39,38,39,40,3,40,32,8,41,40,9,32,41,40,41,32,4,33,25,9,22,33,5,25,22,33,22,25,2,35,27,4,24,35,11,27,24,35,24,27,6,37,29,2,26,37,10,29,26,37,26,29,8,39,31,6,28,39,7,31,28,39,28,31,9,41,23,8,30,41,1,23,30,41,30,23],
            dynamic: true,
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
      pos: [0, 0, 0.2],
      joints: [
        { name: 'coin_free', type: 'free', initialVelocity: [0.0, 0.0, 2.5, 0.0, 15.0, 0.0], damping: 0.1 }
      ],
      script: `// Coin Flip Script
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
          size: [0.08, 0.015],
          rgba: [0.85, 0.65, 0.12, 1],
          mass: 0.05,
          condim: 3,
          friction: [0.3, 0.005, 0.0001]
        },
        {
          name: 'coin_heads_face',
          type: 'cylinder',
          size: [0.08, 0.001],
          pos: [0, 0, 0.015],
          rgba: [0.95, 0.85, 0.3, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_heads_h1',
          type: 'box',
          size: [0.005, 0.02, 0.002],
          pos: [-0.02, 0, 0.016],
          rgba: [0.4, 0.3, 0.1, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_heads_h2',
          type: 'box',
          size: [0.005, 0.02, 0.002],
          pos: [0.02, 0, 0.016],
          rgba: [0.4, 0.3, 0.1, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_heads_h3',
          type: 'box',
          size: [0.015, 0.005, 0.002],
          pos: [0, 0, 0.016],
          rgba: [0.4, 0.3, 0.1, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_tails_face',
          type: 'cylinder',
          size: [0.08, 0.001],
          pos: [0, 0, -0.015],
          rgba: [0.75, 0.75, 0.8, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_tails_t1',
          type: 'box',
          size: [0.02, 0.005, 0.002],
          pos: [0, 0.015, -0.016],
          rgba: [0.25, 0.25, 0.25, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0
        },
        {
          name: 'coin_tails_t2',
          type: 'box',
          size: [0.005, 0.015, 0.002],
          pos: [0, -0.005, -0.016],
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
        { name: 'tower_base', type: 'cylinder', size: [0.08, 0.02], pos: [0, 0, 0.02], rgba: [0.7, 0.7, 0.7, 1] },
        { name: 'tower_mast', type: 'cylinder', size: [0.02, 0.45], pos: [0, 0, 0.45], rgba: [0.9, 0.9, 0.9, 1] }
      ],
      children: [
        {
          id: 'nacelle',
          name: 'nacelle',
          type: 'body',
          pos: [0, 0, 0.9],
          joints: [
            { name: 'yaw_hinge', type: 'hinge', axis: [0, 0, 1], damping: 5.0 }
          ],
          geoms: [
            { name: 'nacelle_body', type: 'box', size: [0.08, 0.04, 0.04], rgba: [0.9, 0.9, 0.9, 1], contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'tail_vane',
              name: 'tail_vane',
              type: 'body',
              pos: [-0.2, 0, 0.05],
              euler: [90, 0, 0],
              isAerodynamic: true,
              joints: [],
              geoms: [
                { name: 'vane_fin', type: 'box', size: [0.05, 0.08, 0.002], rgba: [0.85, 0.45, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'rotor',
              name: 'rotor',
              type: 'body',
              pos: [0.1, 0, 0],
              joints: [
                { name: 'rotor_hinge', type: 'hinge', axis: [1, 0, 0], damping: 0.05 }
              ],
              geoms: [
                { name: 'rotor_hub', type: 'sphere', size: [0.04], rgba: [0.85, 0.25, 0.25, 1], contype: 0, conaffinity: 0 }
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
                    { name: 'blade1_sail', type: 'box', size: [0.03, 0.2, 0.005], pos: [0, 0.25, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.08, 0], size: [0.01], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
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
                    { name: 'blade2_sail', type: 'box', size: [0.03, 0.2, 0.005], pos: [0, 0.25, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.08, 0], size: [0.01], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
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
                    { name: 'blade3_sail', type: 'box', size: [0.03, 0.2, 0.005], pos: [0, 0.25, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade3_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.08, 0], size: [0.01], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
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
        { name: 'tower_base', type: 'cylinder', size: [0.08, 0.02], pos: [0, 0, 0.02], rgba: [0.7, 0.7, 0.7, 1] },
        { name: 'tower_mast', type: 'cylinder', size: [0.02, 0.45], pos: [0, 0, 0.45], rgba: [0.9, 0.9, 0.9, 1] }
      ],
      children: [
        {
          id: 'nacelle',
          name: 'nacelle',
          type: 'body',
          pos: [0, 0, 0.9],
          joints: [
            { name: 'yaw_hinge', type: 'hinge', axis: [0, 0, 1], damping: 5.0 }
          ],
          geoms: [
            { name: 'nacelle_body', type: 'box', size: [0.08, 0.04, 0.04], rgba: [0.9, 0.9, 0.9, 1], contype: 0, conaffinity: 0 }
          ],
          children: [
            {
              id: 'tail_vane',
              name: 'tail_vane',
              type: 'body',
              pos: [-0.2, 0, 0.05],
              euler: [90, 0, 0],
              joints: [],
              geoms: [
                { name: 'vane_fin', type: 'box', size: [0.05, 0.08, 0.002], rgba: [0.85, 0.45, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'rotor',
              name: 'rotor',
              type: 'body',
              pos: [0.1, 0, 0],
              joints: [
                { name: 'rotor_hinge', type: 'hinge', axis: [1, 0, 0], damping: 0.05 }
              ],
              geoms: [
                { name: 'rotor_hub', type: 'sphere', size: [0.04], rgba: [0.85, 0.25, 0.25, 1], contype: 0, conaffinity: 0 }
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
                    { name: 'blade1_sail', type: 'box', size: [0.03, 0.2, 0.005], pos: [0, 0.25, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.08, 0], size: [0.01], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
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
                    { name: 'blade2_sail', type: 'box', size: [0.03, 0.2, 0.005], pos: [0, 0.25, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.08, 0], size: [0.01], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
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
                    { name: 'blade3_sail', type: 'box', size: [0.03, 0.2, 0.005], pos: [0, 0.25, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade3_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.08, 0], size: [0.01], rgba: [0.7, 0.7, 0.7, 1], mass: 0.02, contype: 0, conaffinity: 0 }
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
        { name: 'tower_base', type: 'cylinder', size: [0.1, 0.02], pos: [0, 0, 0.02], rgba: [0.7, 0.7, 0.7, 1] },
        { name: 'tower_mast', type: 'cylinder', size: [0.008, 0.45], pos: [0, 0, 0.45], rgba: [0.9, 0.9, 0.9, 1], contype: 0, conaffinity: 0 }
      ],
      children: [
        {
          id: 'drone_body',
          name: 'drone_body',
          type: 'body',
          pos: [0, 0, 0.15],
          joints: [
            { name: 'drone_slide', type: 'slide', axis: [0, 0, 1], damping: 1.5, limited: true, range: [0.02, 0.8] },
            { name: 'drone_yaw', type: 'hinge', axis: [0, 0, 1], damping: 0.5 }
          ],
          geoms: [
            { name: 'fuselage', type: 'box', size: [0.05, 0.05, 0.025], rgba: [0.2, 0.5, 0.8, 1], mass: 0.3 },
            { name: 'arm1', type: 'cylinder', fromto: [0, 0, 0, 0.1, 0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
            { name: 'arm2', type: 'cylinder', fromto: [0, 0, 0, 0.1, -0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
            { name: 'arm3', type: 'cylinder', fromto: [0, 0, 0, -0.1, 0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
            { name: 'arm4', type: 'cylinder', fromto: [0, 0, 0, -0.1, -0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
            { name: 'pod1', type: 'cylinder', size: [0.012, 0.02], pos: [0.1, 0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
            { name: 'pod2', type: 'cylinder', size: [0.012, 0.02], pos: [0.1, -0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
            { name: 'pod3', type: 'cylinder', size: [0.012, 0.02], pos: [-0.1, 0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
            { name: 'pod4', type: 'cylinder', size: [0.012, 0.02], pos: [-0.1, -0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 }
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
      pos: [0.35, 0, 0.08],
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
        { name: 'free_fuselage', type: 'box', size: [0.05, 0.05, 0.025], rgba: [0.8, 0.2, 0.5, 1], mass: 0.3 },
        { name: 'free_arm1', type: 'cylinder', fromto: [0, 0, 0, 0.1, 0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'free_arm2', type: 'cylinder', fromto: [0, 0, 0, 0.1, -0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'free_arm3', type: 'cylinder', fromto: [0, 0, 0, -0.1, 0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'free_arm4', type: 'cylinder', fromto: [0, 0, 0, -0.1, -0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'free_pod1', type: 'cylinder', size: [0.012, 0.02], pos: [0.1, 0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'free_pod2', type: 'cylinder', size: [0.012, 0.02], pos: [0.1, -0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'free_pod3', type: 'cylinder', size: [0.012, 0.02], pos: [-0.1, 0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'free_pod4', type: 'cylinder', size: [0.012, 0.02], pos: [-0.1, -0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 }
      ],
      children: [
        {
          id: 'free_rotor1',
          name: 'free_rotor1',
          type: 'body',
          pos: [0.1, 0.1, 0.03],
          joints: [
            { name: 'free_rotor1_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
          ],
          geoms: [
            { name: 'free_hub1', type: 'sphere', size: [0.01], rgba: [0.85, 0.25, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
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
                { name: 'free_r1_b1_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'free_r1_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
                { name: 'free_r1_b2_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'free_r1_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'free_rotor2',
          name: 'free_rotor2',
          type: 'body',
          pos: [0.1, -0.1, 0.03],
          joints: [
            { name: 'free_rotor2_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
          ],
          geoms: [
            { name: 'free_hub2', type: 'sphere', size: [0.01], rgba: [0.25, 0.85, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
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
                { name: 'free_r2_b1_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'free_r2_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
                { name: 'free_r2_b2_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'free_r2_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'free_rotor3',
          name: 'free_rotor3',
          type: 'body',
          pos: [-0.1, 0.1, 0.03],
          joints: [
            { name: 'free_rotor3_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
          ],
          geoms: [
            { name: 'free_hub3', type: 'sphere', size: [0.01], rgba: [0.25, 0.85, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
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
                { name: 'free_r3_b1_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'free_r3_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
                { name: 'free_r3_b2_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'free_r3_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'free_rotor4',
          name: 'free_rotor4',
          type: 'body',
          pos: [-0.1, -0.1, 0.03],
          joints: [
            { name: 'free_rotor4_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
          ],
          geoms: [
            { name: 'free_hub4', type: 'sphere', size: [0.01], rgba: [0.85, 0.25, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
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
                { name: 'free_r4_b1_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'free_r4_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
                { name: 'free_r4_b2_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'free_r4_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
      pos: [-0.35, 0, 0.08],
      euler: [10, 10, 0],
      joints: [
        { name: 'unstable_drone_free', type: 'free', damping: 0.5 }
      ],
      geoms: [
        { name: 'unstable_fuselage', type: 'box', size: [0.05, 0.05, 0.025], rgba: [0.95, 0.85, 0.15, 1], mass: 0.3 },
        { name: 'unstable_arm1', type: 'cylinder', fromto: [0, 0, 0, 0.1, 0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'unstable_arm2', type: 'cylinder', fromto: [0, 0, 0, 0.1, -0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'unstable_arm3', type: 'cylinder', fromto: [0, 0, 0, -0.1, 0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'unstable_arm4', type: 'cylinder', fromto: [0, 0, 0, -0.1, -0.1, 0], size: [0.006], rgba: [0.9, 0.9, 0.9, 1], mass: 0.02, contype: 0, conaffinity: 0 },
        { name: 'unstable_pod1', type: 'cylinder', size: [0.012, 0.02], pos: [0.1, 0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'unstable_pod2', type: 'cylinder', size: [0.012, 0.02], pos: [0.1, -0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'unstable_pod3', type: 'cylinder', size: [0.012, 0.02], pos: [-0.1, 0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 },
        { name: 'unstable_pod4', type: 'cylinder', size: [0.012, 0.02], pos: [-0.1, -0.1, 0.01], rgba: [0.3, 0.3, 0.3, 1], mass: 0.02 }
      ],
      children: [
        {
          id: 'unstable_rotor1',
          name: 'unstable_rotor1',
          type: 'body',
          pos: [0.1, 0.1, 0.03],
          joints: [
            { name: 'unstable_rotor1_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
          ],
          geoms: [
            { name: 'unstable_hub1', type: 'sphere', size: [0.01], rgba: [0.85, 0.25, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
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
                { name: 'unstable_r1_b1_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'unstable_r1_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
                { name: 'unstable_r1_b2_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'unstable_r1_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'unstable_rotor2',
          name: 'unstable_rotor2',
          type: 'body',
          pos: [0.1, -0.1, 0.03],
          joints: [
            { name: 'unstable_rotor2_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
          ],
          geoms: [
            { name: 'unstable_hub2', type: 'sphere', size: [0.01], rgba: [0.25, 0.85, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
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
                { name: 'unstable_r2_b1_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'unstable_r2_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
                { name: 'unstable_r2_b2_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'unstable_r2_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'unstable_rotor3',
          name: 'unstable_rotor3',
          type: 'body',
          pos: [-0.1, 0.1, 0.03],
          joints: [
            { name: 'unstable_rotor3_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: -90.0 } }
          ],
          geoms: [
            { name: 'unstable_hub3', type: 'sphere', size: [0.01], rgba: [0.25, 0.85, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
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
                { name: 'unstable_r3_b1_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'unstable_r3_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
                { name: 'unstable_r3_b2_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'unstable_r3_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
              ],
              children: []
            }
          ]
        },
        {
          id: 'unstable_rotor4',
          name: 'unstable_rotor4',
          type: 'body',
          pos: [-0.1, -0.1, 0.03],
          joints: [
            { name: 'unstable_rotor4_joint', type: 'hinge', axis: [0, 0, 1], damping: 0.02, actuator: { type: 'velocity', kv: 2.0, ctrlValue: 90.0 } }
          ],
          geoms: [
            { name: 'unstable_hub4', type: 'sphere', size: [0.01], rgba: [0.85, 0.25, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
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
                { name: 'unstable_r4_b1_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'unstable_r4_b1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
                { name: 'unstable_r4_b2_sail', type: 'box', size: [0.015, 0.08, 0.001], pos: [0, 0.09, 0], rgba: [0.95, 0.95, 0.95, 1], mass: 0.02, contype: 0, conaffinity: 0 },
                { name: 'unstable_r4_b2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.04, 0], size: [0.004], rgba: [0.7, 0.7, 0.7, 1], mass: 0.01, contype: 0, conaffinity: 0 }
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
const R_blade = 0.25, r_hub = 0.04, pitch = 18 * Math.PI / 180, rho = 1.225;
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
    const chord = 0.06 * (1.0 - 0.3 * (r / R_blade));
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
        { name: 'base_box', type: 'box', size: [0.1, 0.1, 0.03], pos: [0, 0, 0.015], rgba: [0.65, 0.45, 0.25, 1], contype: 0, conaffinity: 0 },
        { name: 'tower_post', type: 'cylinder', size: [0.03, 0.35], pos: [0, 0, 0.35], rgba: [0.7, 0.5, 0.3, 1], contype: 0, conaffinity: 0 }
      ],
      children: [
        {
          id: 'nacelle',
          name: 'nacelle',
          type: 'body',
          pos: [0, 0, 0.7],
          joints: [{ name: 'yaw_hinge', type: 'hinge', axis: [0, 0, 1], damping: 2 }],
          geoms: [
            { name: 'nacelle_body', type: 'box', size: [0.06, 0.03, 0.03], rgba: [0.7, 0.5, 0.3, 1], contype: 0, conaffinity: 0 }
          ],
          script: yawScript,
          children: [
            {
              id: 'tail_vane',
              name: 'tail_vane',
              type: 'body',
              pos: [-0.18, 0, 0.04],
              euler: [90, 0, 0],
              joints: [],
              geoms: [
                { name: 'vane_fin', type: 'box', size: [0.04, 0.06, 0.002], rgba: [0.85, 0.45, 0.25, 1], mass: 0.05, contype: 0, conaffinity: 0 }
              ],
              children: []
            },
            {
              id: 'rotor',
              name: 'rotor',
              type: 'body',
              pos: [0.09, 0, 0],
              joints: [{ name: 'rotor_hinge', type: 'hinge', axis: [1, 0, 0], damping: 0.05 }],
              geoms: [
                { name: 'rotor_hub', type: 'sphere', size: [0.035], rgba: [0.6, 0.4, 0.2, 1], contype: 0, conaffinity: 0 }
              ],
              script: rotorBEMScript4Blade,
              children: [
                {
                  id: 'blade1', name: 'blade1', type: 'body', pos: [0, 0, 0], euler: [0, 12, 0], joints: [],
                  geoms: [
                    { name: 'blade1_sail', type: 'box', size: [0.03, 0.18, 0.006], pos: [0, 0.22, 0], rgba: [0.95, 0.92, 0.8, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade1_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.07, 0], size: [0.008], rgba: [0.6, 0.4, 0.2, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade2', name: 'blade2', type: 'body', pos: [0, 0, 0], euler: [90, 12, 0], joints: [],
                  geoms: [
                    { name: 'blade2_sail', type: 'box', size: [0.03, 0.18, 0.006], pos: [0, 0.22, 0], rgba: [0.95, 0.92, 0.8, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade2_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.07, 0], size: [0.008], rgba: [0.6, 0.4, 0.2, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade3', name: 'blade3', type: 'body', pos: [0, 0, 0], euler: [180, 12, 0], joints: [],
                  geoms: [
                    { name: 'blade3_sail', type: 'box', size: [0.03, 0.18, 0.006], pos: [0, 0.22, 0], rgba: [0.95, 0.92, 0.8, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade3_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.07, 0], size: [0.008], rgba: [0.6, 0.4, 0.2, 1], mass: 0.02, contype: 0, conaffinity: 0 }
                  ],
                  children: []
                },
                {
                  id: 'blade4', name: 'blade4', type: 'body', pos: [0, 0, 0], euler: [270, 12, 0], joints: [],
                  geoms: [
                    { name: 'blade4_sail', type: 'box', size: [0.03, 0.18, 0.006], pos: [0, 0.22, 0], rgba: [0.95, 0.92, 0.8, 1], mass: 0.1, contype: 0, conaffinity: 0 },
                    { name: 'blade4_shaft', type: 'capsule', fromto: [0, 0, 0, 0, 0.07, 0], size: [0.008], rgba: [0.6, 0.4, 0.2, 1], mass: 0.02, contype: 0, conaffinity: 0 }
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
  const lcg = (s: number) => { let v = s; return () => { v = (v * 1664525 + 1013904223) & 0x7fffffff; return v / 0x7fffffff; }; };
  const rng = lcg(42);
  const positions: [number,number,number][] = colors.map(() => [
    (rng() - 0.5) * 0.7,   // X: -0.35..0.35
    (rng() - 0.5) * 0.4,   // Y: -0.2..0.2
    0.2 + rng() * 0.5,     // Z: 0.2..0.7
  ]);
  const nodes = colors.map((rgba, i) => {
    const r = 0.03 + (i % 4) * 0.008;
    return {
      id: `ball_${i}`, name: `ball_${i}`, type: 'body' as const,
      pos: positions[i],
      joints: [{ name: `ball_${i}_free`, type: 'free' as const, initialVelocity: [0,0,0,0,0,0] }],
      geoms: [{ name: `ball_${i}_geom`, type: 'sphere' as const, size: [r], rgba, mass: 0.1,
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
      pos: [0, 0, 0.15],
      joints: [{ name: 'scad_container_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [
        { name: 'scad_container_floor', type: 'box', size: [0.15, 0.15, 0.015], pos: [0, 0, -0.085], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        { name: 'scad_container_wall_px', type: 'box', size: [0.015, 0.15, 0.085], pos: [0.135, 0, 0.015], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        { name: 'scad_container_wall_nx', type: 'box', size: [0.015, 0.15, 0.085], pos: [-0.135, 0, 0.015], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        { name: 'scad_container_wall_py', type: 'box', size: [0.15, 0.015, 0.085], pos: [0, 0.135, 0.015], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        { name: 'scad_container_wall_ny', type: 'box', size: [0.15, 0.015, 0.085], pos: [0, -0.135, 0.015], rgba: [0.2, 0.5, 0.8, 1], mass: 0.4 },
        {
          name: 'scad_container_geom',
          type: 'mesh',
          size: [1],
          rgba: [0.2, 0.5, 0.8, 1],
          mass: 0.001,
          contype: 0,
          conaffinity: 0,
          dynamic: true,
          vertices: [
            -0.15, -0.1, -0.15,
             0.15, -0.1, -0.15,
             0.15, -0.1,  0.15,
            -0.15, -0.1,  0.15,
            -0.15,  0.1, -0.15,
             0.15,  0.1, -0.15,
             0.15,  0.1,  0.15,
            -0.15,  0.1,  0.15,
            -0.12, -0.07, -0.12,
             0.12, -0.07, -0.12,
             0.12, -0.07,  0.12,
            -0.12, -0.07,  0.12,
            -0.12,  0.1, -0.12,
             0.12,  0.1, -0.12,
             0.12,  0.1,  0.12,
            -0.12,  0.1,  0.12
          ],
          renderVertices: [
            -0.15,  0.15, -0.1,
             0.15,  0.15, -0.1,
             0.15, -0.15, -0.1,
            -0.15, -0.15, -0.1,
            -0.15,  0.15,  0.1,
             0.15,  0.15,  0.1,
             0.15, -0.15,  0.1,
            -0.15, -0.15,  0.1,
            -0.12,  0.12, -0.07,
             0.12,  0.12, -0.07,
             0.12, -0.12, -0.07,
            -0.12, -0.12, -0.07,
            -0.12,  0.12,  0.1,
             0.12,  0.12,  0.1,
             0.12, -0.12,  0.1,
            -0.12, -0.12,  0.1
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
      scad: `// OpenSCAD Showcase Scene\n// A hollow box that catches falling spheres!\nbox_size = 0.3; // [0.15:0.02:0.5]\nbox_height = 0.2; // [0.1:0.02:0.4]\ninner_size = 0.24; // [0.1:0.02:0.4]\ndifference() {\n  cube([box_size, box_size, box_height], center=true);\n  translate([0, 0, 0.03]) cube([inner_size, inner_size, box_height], center=true);\n}`,
      children: []
    },
    {
      id: 'ball_red',
      name: 'ball_red',
      type: 'body',
      pos: [-0.04, 0, 0.4],
      joints: [{ name: 'ball_red_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [{ name: 'ball_red_geom', type: 'sphere', size: [0.04], rgba: [0.8, 0.2, 0.2, 1], mass: 0.2 }],
      children: []
    },
    {
      id: 'ball_green',
      name: 'ball_green',
      type: 'body',
      pos: [0.05, 0, 0.5],
      joints: [{ name: 'ball_green_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [{ name: 'ball_green_geom', type: 'sphere', size: [0.03], rgba: [0.2, 0.8, 0.2, 1], mass: 0.15 }],
      children: []
    },
    {
      id: 'ball_yellow',
      name: 'ball_yellow',
      type: 'body',
      pos: [0, 0, 0.6],
      joints: [{ name: 'ball_yellow_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [{ name: 'ball_yellow_geom', type: 'sphere', size: [0.045], rgba: [0.8, 0.8, 0.2, 1], mass: 0.3 }],
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
      pos: [-0.35, 0, 0.3],
      joints: [],
      geoms: [{ name: 'left_anchor_geom', type: 'box', size: [0.03, 0.03, 0.03], rgba: [0.4, 0.4, 0.4, 1] }],
      isComposite: true,
      compositeType: 'cable',
      compositeCount: '25 1 1',
      compositeSize: '0.7',
      compositePrefix: 'rope_',
      weldLastToId: 'rope_right_anchor',
      children: []
    },
    {
      id: 'rope_right_anchor',
      name: 'rope_right_anchor',
      type: 'body',
      pos: [0.35, 0, 0.3],
      joints: [],
      geoms: [{ name: 'right_anchor_geom', type: 'box', size: [0.03, 0.03, 0.03], rgba: [0.4, 0.4, 0.4, 1] }],
      children: []
    },
    {
      id: 'heavy_ball',
      name: 'heavy_ball',
      type: 'body',
      pos: [0, 0, 0.5],
      joints: [{ name: 'ball_free', type: 'free', initialVelocity: [0, 0, 0, 0, 0, 0] }],
      geoms: [{ name: 'ball_geom', type: 'sphere', size: [0.05], rgba: [0.9, 0.2, 0.2, 1], mass: 1.5 }],
      children: []
    }
  ]
};

export const pringlesScadPreset: SceneGraph = {
  nodes: [
    {
      id: 'pringles_scad_head',
      name: 'pringles_scad_head',
      type: 'body',
      pos: [0, 0, 0.3],
      joints: [],
      geoms: [{ name: 'head_mesh', type: 'sphere', size: [0.12], rgba: [0.98, 0.94, 0.86, 1], mass: 1.0 }],
      scad: `$fn = 32;

module pringles_head() {
    color([0.98, 0.94, 0.86])
        scale([1.0, 0.85, 1.1])
            sphere(r=0.12);
    
    color([0.22, 0.12, 0.05]) {
        translate([-0.04, -0.01, 0.08])
            rotate([0, 20, -10])
                scale([1.2, 0.8, 0.6])
                    sphere(r=0.05);

        translate([0.04, -0.01, 0.08])
            rotate([0, -20, 10])
                scale([1.2, 0.8, 0.6])
                    sphere(r=0.05);
    }

    color([0.08, 0.08, 0.08]) {
        translate([-0.035, 0.08, 0.025])
            scale([0.8, 0.4, 1.1])
                sphere(r=0.02);

        translate([0.035, 0.08, 0.025])
            scale([0.8, 0.4, 1.1])
                sphere(r=0.02);
    }

    color([0.20, 0.10, 0.04]) {
        hull() {
            translate([0, 0.09, -0.015]) sphere(r=0.015);
            translate([-0.05, 0.08, -0.02]) sphere(r=0.018);
            translate([-0.08, 0.07, -0.01]) sphere(r=0.015);
            translate([-0.10, 0.05, 0.01]) sphere(r=0.01);
        }

        hull() {
            translate([0, 0.09, -0.015]) sphere(r=0.015);
            translate([0.05, 0.08, -0.02]) sphere(r=0.018);
            translate([0.08, 0.07, -0.01]) sphere(r=0.015);
            translate([0.10, 0.05, 0.01]) sphere(r=0.01);
        }
    }

    color([0.85, 0.15, 0.15]) {
        translate([0, 0.08, -0.10])
            sphere(r=0.016);

        hull() {
            translate([0, 0.08, -0.10]) sphere(r=0.01);
            translate([-0.05, 0.07, -0.09]) scale([1, 0.6, 1.4]) sphere(r=0.02);
        }

        hull() {
            translate([0, 0.08, -0.10]) sphere(r=0.01);
            translate([0.05, 0.07, -0.09]) scale([1, 0.6, 1.4]) sphere(r=0.02);
        }
    }
}

pringles_head();`,
      children: []
    }
  ]
};

const OVAL_TRACK_POINTS: number[][] = [
  [0.4, 0, 0.06],
  [0.28, 0.25, 0.06],
  [0, 0.35, 0.06],
  [-0.28, 0.25, 0.06],
  [-0.4, 0, 0.06],
  [-0.28, -0.25, 0.06],
  [0, -0.35, 0.06],
  [0.28, -0.25, 0.06],
];
const OVAL_TRACK_BANK = -16;

const OVAL_CURB_INNER_POINTS: number[][] = [
  [0.26, 0, 0.04],
  [0.18, 0.16, 0.04],
  [0, 0.22, 0.04],
  [-0.18, 0.16, 0.04],
  [-0.26, 0, 0.04],
  [-0.18, -0.16, 0.04],
  [0, -0.22, 0.04],
  [0.18, -0.16, 0.04],
];
const OVAL_CURB_OUTER_POINTS: number[][] = [
  [0.54, 0, 0.1],
  [0.38, 0.34, 0.1],
  [0, 0.48, 0.1],
  [-0.38, 0.34, 0.1],
  [-0.54, 0, 0.1],
  [-0.38, -0.34, 0.1],
  [0, -0.48, 0.1],
  [0.38, -0.34, 0.1],
];

export const ovalTrackPreset: SceneGraph = {
  nodes: [
    {
      id: 'oval_track',
      name: 'oval_track',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: generateCurveGeoms('oval_track', OVAL_TRACK_POINTS, 0.25, 0.02, 48, [0.85, 0.45, 0.15, 1], true, OVAL_TRACK_BANK) as SceneGeom[],
      children: [],
      isCurve: true,
      curvePoints: OVAL_TRACK_POINTS.map(p => [...p]),
      curveWidth: 0.25,
      curveThickness: 0.02,
      curveSegments: 48,
      curveClosed: true,
      curveBank: OVAL_TRACK_BANK
    },
    {
      id: 'oval_curb_inner',
      name: 'oval_curb_inner',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: generateCurveGeoms('oval_curb_inner', OVAL_CURB_INNER_POINTS, 0.08, 0.02, 48, [0.55, 0.28, 0.08, 1], true, 40) as SceneGeom[],
      children: [],
      isCurve: true,
      curvePoints: OVAL_CURB_INNER_POINTS.map(p => [...p]),
      curveWidth: 0.08,
      curveThickness: 0.02,
      curveSegments: 48,
      curveClosed: true,
      curveBank: 40
    },
    {
      id: 'oval_curb_outer',
      name: 'oval_curb_outer',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      geoms: generateCurveGeoms('oval_curb_outer', OVAL_CURB_OUTER_POINTS, 0.08, 0.02, 48, [0.55, 0.28, 0.08, 1], true, -40) as SceneGeom[],
      children: [],
      isCurve: true,
      curvePoints: OVAL_CURB_OUTER_POINTS.map(p => [...p]),
      curveWidth: 0.08,
      curveThickness: 0.02,
      curveSegments: 48,
      curveClosed: true,
      curveBank: -40
    },
    {
      id: 'marble',
      name: 'marble',
      type: 'body',
      pos: [0.38, 0, 0.1],
      joints: [
        { name: 'marble_free', type: 'free', initialVelocity: [0, 1.1, 0, 0, 0, 0] }
      ],
      geoms: [
        { name: 'marble_geom', type: 'sphere', size: [0.03], mass: 0.1, rgba: [0.2, 0.6, 1.0, 1], friction: [1.0, 0.005, 0.0001] }
      ],
      children: []
    }
  ]
};

// Single source of truth for built-in presets. The App's preset dropdown and
// the MCP bridge's LIST_PRESETS both derive from this map — add a preset here
// and it appears everywhere. `emoji` is an optional display prefix for UI.
export const PRESETS = {
  empty: {
    name: 'Blank (Empty)',
    emoji: '🫙',
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
  oval_track: {
    name: 'Oval Curve Track',
    emoji: '🎢',
    scene: ovalTrackPreset
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
    emoji: '✈',
    scene: paperPlanePreset
  },
  monkey_head: {
    name: 'Monkey Head',
    emoji: '🐵',
    scene: monkeyHeadPreset
  },
  golden_gate: {
    name: 'Golden Gate Bridge',
    emoji: '🌉',
    scene: goldenGateBridgePreset
  },
  golden_gate_mesh: {
    name: 'Golden Gate (Mesh)',
    emoji: '🌉',
    scene: goldenGateMeshPreset
  },
  mesh_collision: {
    name: 'Mesh Collision Demo',
    emoji: '🔺',
    scene: meshCollisionPreset
  },
  coin_flip: {
    name: 'Coin Flip',
    emoji: '🪙',
    scene: coinFlipPreset
  },
  windmill: {
    name: 'Wind Turbine',
    emoji: '💨',
    scene: windmillPreset,
    environment: { windX: 5.0, windY: 0.0 }
  },
  physics_only_windmill: {
    name: 'Wind Turbine (No Aero)',
    emoji: '💨',
    scene: physicsOnlyWindmillPreset,
    environment: { windX: 5.0, windY: 0.0 }
  },
  traditional_windmill: {
    name: 'Traditional Windmill (4-Blade)',
    emoji: '💨',
    scene: traditionalWindmillPreset,
    environment: { windX: 5.0, windY: 0.0 }
  },
  drone: {
    name: 'Quadcopter Drone',
    emoji: '🛸',
    scene: dronePreset
  },
  bouncy_balls: {
    name: 'Bouncy Balls',
    emoji: '🎱',
    scene: bouncyBallsPreset,
    environment: { floorBounce: 0.85 }
  },
  openscad_demo: {
    name: 'OpenSCAD Showcase',
    emoji: '🛠️',
    scene: openscadDemoPreset
  },
  rope_bridge: {
    name: 'Interactive Rope Bridge',
    emoji: '🎗️',
    scene: ropeBridgePreset
  },
  pringles_scad: {
    name: 'Mr Pringles (OpenSCAD)',
    emoji: '🥔',
    scene: pringlesScadPreset
  }
};
