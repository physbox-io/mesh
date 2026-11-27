// ---------------------------------------------------------------------------
// 3D-Printed Mechanical Hardware Components Generator
//
// The D-shaft motor hub coupler, a printed part of its own. The cut features
// that used to live here (insert bosses, nut traps, bearing pockets,
// counterbores) are cuts into a part now, utils/hardwareCuts.ts, and the bought
// parts that go in them are utils/hardwareParts.ts.
// ---------------------------------------------------------------------------

import type { SceneNode } from '../types/scene';

/**
 * Creates a complete SceneNode for a D-Shaft Motor Hub (e.g. 5mm NEMA 17)
 */
export function createDShaftHubNode(shaftDiameterMm = 5.0): SceneNode {
  const outerR = (shaftDiameterMm / 2 + 5.0) / 1000;
  const height = 0.015; // 15mm tall hub
  const dShaftR = (shaftDiameterMm / 2 + 0.12) / 1000;
  const id = `dshaft_${shaftDiameterMm}mm_${Math.random().toString(36).slice(2, 7)}`;

  const scad = `// 3D Printed ${shaftDiameterMm}mm D-Shaft Motor Hub
$fn = 48;
scale(0.001) {
  difference() {
    cylinder(r = ${shaftDiameterMm / 2 + 5.0}, h = 15, center = false);
    // D-shaft bore
    translate([0, 0, -0.1])
      intersection() {
        cylinder(r = ${shaftDiameterMm / 2 + 0.12}, h = 15.2, center = false);
        translate([-${shaftDiameterMm}, -${shaftDiameterMm / 2 + 0.12 - 0.5}, 0])
          cube([${shaftDiameterMm * 2}, ${shaftDiameterMm * 2}, 15.2]);
      }
    // M3 Set screw hole (enters -Y wall onto the D-flat)
    translate([0, 0, 7.5])
      rotate([90, 0, 0])
        cylinder(r = 1.45, h = ${shaftDiameterMm + 6}, center = false);
  }
}
`;

  return {
    id,
    name: `${shaftDiameterMm}mm D-Shaft Hub`,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scad,
    csgEnabled: true,
    type: 'body',
    isHardwareComponent: true,
    hardwareType: 'd_shaft_hub',
    hardwareSpec: { shaftDiameterMm },
    geoms: [
      {
        name: `${shaftDiameterMm}mm Hub Body`,
        type: 'cylinder',
        size: [outerR, height / 2],
        rgba: [0.2, 0.7, 0.5, 1],
        dynamic: true,
        mass: 0.02,
        pos: [0, 0, height / 2],
      },
      {
        name: `${shaftDiameterMm}mm D-Shaft Bore Cutout`,
        type: 'cylinder',
        size: [dShaftR, (height + 0.0004) / 2],
        rgba: [0.9, 0.25, 0.35, 1],
        dynamic: false,
        csg: 'difference',
        pos: [0, 0, height / 2],
      }
    ],
    joints: [{ type: 'free', name: 'free' }],
    children: [],
  };
}

/**
 * Creates a 2-body articulated 3D-printable print-in-place knuckle hinge with
 * real MuJoCo hinge kinematics. Lies flat on the XY print bed with leaves
 * extending along -X and +X, thickness along Z, and the hinge pin axis along Y.
 */
export function createHingeNode(lengthMm = 40, widthMm = 32, thicknessMm = 4): SceneNode {
  const id = `hinge_${lengthMm}x${widthMm}_${Math.random().toString(36).slice(2, 7)}`;
  const L = lengthMm / 1000;
  const leafH = thicknessMm / 1000;
  const pinR = (thicknessMm * 0.65) / 1000;
  const leafSpan = (widthMm / 2) / 1000 - pinR * 0.6;
  const leafCenterX = pinR * 0.6 + leafSpan / 2;

  const segL = L / 5;
  const gap = 0.0003; // 0.3mm print-in-place axial clearance between knuckles
  const segHalfL = Math.max(0.0002, (segL - gap) / 2);

  const leafColor = [0.22, 0.56, 0.78, 1];
  const pinColor = [0.16, 0.44, 0.64, 1];

  return {
    id,
    name: `Print-in-Place Hinge (${lengthMm}×${widthMm}mm)`,
    pos: [0, 0, thicknessMm / 2000 + 0.01],
    rot: [0, 0, 0],
    type: 'body',
    isHardwareComponent: true,
    hardwareType: 'knuckle_hinge',
    hardwareSpec: { lengthMm, widthMm, thicknessMm },
    geoms: [
      {
        name: `${id}_leaf_a`,
        type: 'box',
        size: [leafSpan / 2, L / 2, leafH / 2],
        pos: [-leafCenterX, 0, 0],
        rgba: leafColor,
        mass: 0.0045,
        condim: 3,
      },
      {
        name: `${id}_knuckle_0`,
        type: 'cylinder',
        size: [pinR, segHalfL],
        pos: [0, -2 * segL, 0],
        euler: [90, 0, 0],
        rgba: leafColor,
        mass: 0.0005,
        condim: 3,
      },
      {
        name: `${id}_knuckle_2`,
        type: 'cylinder',
        size: [pinR, segHalfL],
        pos: [0, 0, 0],
        euler: [90, 0, 0],
        rgba: leafColor,
        mass: 0.0005,
        condim: 3,
      },
      {
        name: `${id}_knuckle_4`,
        type: 'cylinder',
        size: [pinR, segHalfL],
        pos: [0, 2 * segL, 0],
        euler: [90, 0, 0],
        rgba: leafColor,
        mass: 0.0005,
        condim: 3,
      },
      {
        name: `${id}_pin`,
        type: 'cylinder',
        size: [pinR * 0.55, (L * 0.96) / 2],
        pos: [0, 0, 0],
        euler: [90, 0, 0],
        rgba: pinColor,
        role: 'visual',
      },
    ],
    joints: [{ name: `${id}_free`, type: 'free' }],
    children: [
      {
        id: `${id}_leaf_b`,
        name: 'Moving Leaf',
        pos: [0, 0, 0],
        rot: [0, 0, 0],
        type: 'body',
        geoms: [
          {
            name: `${id}_leaf_b_plate`,
            type: 'box',
            size: [leafSpan / 2, L / 2, leafH / 2],
            pos: [leafCenterX, 0, 0],
            rgba: leafColor,
            mass: 0.0045,
            condim: 3,
          },
          {
            name: `${id}_knuckle_1`,
            type: 'cylinder',
            size: [pinR, segHalfL],
            pos: [0, -segL, 0],
            euler: [90, 0, 0],
            rgba: leafColor,
            mass: 0.00075,
            condim: 3,
          },
          {
            name: `${id}_knuckle_3`,
            type: 'cylinder',
            size: [pinR, segHalfL],
            pos: [0, segL, 0],
            euler: [90, 0, 0],
            rgba: leafColor,
            mass: 0.00075,
            condim: 3,
          },
        ],
        joints: [
          {
            name: `${id}_hinge`,
            type: 'hinge',
            axis: [0, 1, 0],
            pos: [0, 0, 0],
            limited: true,
            range: [-180, 180],
            damping: 0.004,
          },
        ],
        children: [],
      },
    ],
  };
}
