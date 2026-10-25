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
  const outerR = (shaftDiameterMm + 5.0) / 1000;
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
    // M3 Set screw hole
    translate([0, 0, 7.5])
      rotate([0, 90, 0])
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
