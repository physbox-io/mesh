// ---------------------------------------------------------------------------
// 3D-Printed Mechanical Hardware Components Generator
//
// Provides standardized, print-optimized 3D hardware primitives:
// - Heat-set insert bosses (M2, M3, M4, M5, M8)
// - Directly printed metric threads (M3–M16)
// - Hex nut trap pockets & slots (M3, M4, M5, M6)
// - Standard bearing pockets (608, 624, 625, 688)
// - Cantilever snap-fit hooks
// - D-shaft motor hub couplers (5mm, 6mm, 8mm)
// ---------------------------------------------------------------------------

import type { SceneNode } from '../types/scene';

export type HardwareType =
  | 'heat_set_boss'
  | 'printed_thread'
  | 'hex_nut_trap'
  | 'bearing_pocket'
  | 'snap_fit'
  | 'd_shaft_hub';

export interface InsertBossSpec {
  size: 'M2' | 'M3' | 'M4' | 'M5' | 'M8';
  outerDiameterMm: number;
  innerHoleMm: number;
  depthMm: number;
  chamferMm: number;
}

export const HEAT_SET_SPECS: Record<string, InsertBossSpec> = {
  M2: { size: 'M2', outerDiameterMm: 6.0, innerHoleMm: 3.2, depthMm: 4.0, chamferMm: 0.5 },
  M3: { size: 'M3', outerDiameterMm: 8.0, innerHoleMm: 4.2, depthMm: 5.7, chamferMm: 0.6 },
  M4: { size: 'M4', outerDiameterMm: 10.0, innerHoleMm: 5.6, depthMm: 8.1, chamferMm: 0.8 },
  M5: { size: 'M5', outerDiameterMm: 12.0, innerHoleMm: 6.8, depthMm: 9.5, chamferMm: 1.0 },
  M8: { size: 'M8', outerDiameterMm: 18.0, innerHoleMm: 9.8, depthMm: 12.5, chamferMm: 1.2 },
};

export interface BearingSpec {
  name: '608' | '624' | '625' | '688';
  outerDiameterMm: number;
  innerDiameterMm: number;
  widthMm: number;
}

export const BEARING_SPECS: Record<string, BearingSpec> = {
  '608': { name: '608', outerDiameterMm: 22.0, innerDiameterMm: 8.0, widthMm: 7.0 },
  '624': { name: '624', outerDiameterMm: 13.0, innerDiameterMm: 4.0, widthMm: 5.0 },
  '625': { name: '625', outerDiameterMm: 16.0, innerDiameterMm: 5.0, widthMm: 5.0 },
  '688': { name: '688', outerDiameterMm: 16.0, innerDiameterMm: 8.0, widthMm: 5.0 },
};

export interface NutSpec {
  size: 'M3' | 'M4' | 'M5' | 'M6';
  flatToFlatMm: number;
  thicknessMm: number;
}

export const HEX_NUT_SPECS: Record<string, NutSpec> = {
  M3: { size: 'M3', flatToFlatMm: 5.5, thicknessMm: 2.4 },
  M4: { size: 'M4', flatToFlatMm: 7.0, thicknessMm: 3.2 },
  M5: { size: 'M5', flatToFlatMm: 8.0, thicknessMm: 4.0 },
  M6: { size: 'M6', flatToFlatMm: 10.0, thicknessMm: 5.0 },
};

/**
 * Creates a complete SceneNode for a Heat-Set Insert Boss
 */
export function createHeatSetBossNode(size: 'M2' | 'M3' | 'M4' | 'M5' | 'M8' = 'M3', nameSuffix = ''): SceneNode {
  const spec = HEAT_SET_SPECS[size] || HEAT_SET_SPECS.M3;
  // Convert mm to meters (Physics engine uses meters)
  const outerR = (spec.outerDiameterMm / 2) / 1000;
  const innerR = (spec.innerHoleMm / 2) / 1000;
  const height = spec.depthMm / 1000;
  const id = `boss_${size.toLowerCase()}_${Math.random().toString(36).slice(2, 7)}`;

  // Parametric OpenSCAD code for high fidelity rendering and export
  const scad = `// Print-optimized ${size} Heat-Set Insert Boss
$fn = 48;
scale(0.001) {
  difference() {
    cylinder(r = ${spec.outerDiameterMm / 2}, h = ${spec.depthMm}, center = false);
    translate([0, 0, -0.1])
      cylinder(r = ${spec.innerHoleMm / 2}, h = ${spec.depthMm + 0.2}, center = false);
    // Lead-in insertion chamfer
    translate([0, 0, ${spec.depthMm - spec.chamferMm}])
      cylinder(r1 = ${spec.innerHoleMm / 2}, r2 = ${spec.innerHoleMm / 2 + spec.chamferMm}, h = ${spec.chamferMm + 0.1}, center = false);
  }
}
`;

  return {
    id,
    name: `${size} Insert Boss${nameSuffix ? ` ${nameSuffix}` : ''}`,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scad,
    csgEnabled: true,
    type: 'body',
    isHardwareComponent: true,
    hardwareType: 'heat_set_boss',
    hardwareSpec: spec,
    geoms: [
      {
        name: `${size} Boss Body`,
        type: 'cylinder',
        size: [outerR, height / 2],
        rgba: [0.85, 0.45, 0.2, 1], // Bronze/brass insert color
        dynamic: true,
        mass: 0.005,
        pos: [0, 0, height / 2],
      },
      {
        name: `${size} Insert Hole Cutout`,
        type: 'cylinder',
        size: [innerR, (height + 0.0004) / 2],
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
 * Creates a complete SceneNode for a Hex Nut Trap
 */
export function createHexNutTrapNode(size: 'M3' | 'M4' | 'M5' | 'M6' = 'M3'): SceneNode {
  const spec = HEX_NUT_SPECS[size] || HEX_NUT_SPECS.M3;
  const flatToFlat = spec.flatToFlatMm;
  const outerR = (flatToFlat * 1.5) / 1000;
  const thickness = spec.thicknessMm / 1000;
  const height = thickness + 0.003;
  const screwR = (parseFloat(size.slice(1)) / 2 + 0.25) / 1000;
  const hexR = (flatToFlat / Math.sqrt(3)) / 1000;
  const id = `nuttrap_${size.toLowerCase()}_${Math.random().toString(36).slice(2, 7)}`;

  const scad = `// 3D Print Drop-In ${size} Hex Nut Trap
$fn = 6;
module hex_nut() {
  cylinder(r = ${(flatToFlat / Math.sqrt(3)).toFixed(3)}, h = ${spec.thicknessMm + 0.3}, center = false);
}

scale(0.001) {
  difference() {
    cylinder(r = ${(flatToFlat * 0.9).toFixed(3)}, h = ${spec.thicknessMm + 3}, center = false);
    translate([0, 0, 1.5]) hex_nut();
    // Pass-through screw hole
    translate([0, 0, -0.1]) cylinder(r = ${size.slice(1)}/2 + 0.25, h = ${spec.thicknessMm + 3.2}, $fn=32);
  }
}
`;

  return {
    id,
    name: `${size} Nut Trap`,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scad,
    csgEnabled: true,
    type: 'body',
    isHardwareComponent: true,
    hardwareType: 'hex_nut_trap',
    hardwareSpec: spec,
    geoms: [
      {
        name: `${size} Nut Trap Body`,
        type: 'cylinder',
        size: [outerR, height / 2],
        rgba: [0.3, 0.65, 0.85, 1],
        dynamic: true,
        mass: 0.008,
        pos: [0, 0, height / 2],
      },
      {
        name: `${size} Hex Pocket Cutout`,
        type: 'cylinder',
        size: [hexR, (spec.thicknessMm + 0.3) / 2000],
        rgba: [0.9, 0.25, 0.35, 1],
        dynamic: false,
        csg: 'difference',
        pos: [0, 0, 0.0015 + (spec.thicknessMm + 0.3) / 2000],
      },
      {
        name: `${size} Screw Hole Cutout`,
        type: 'cylinder',
        size: [screwR, (height + 0.002) / 2],
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
 * Creates a complete SceneNode for a Bearing Pocket (e.g. 608 skate bearing)
 */
export function createBearingPocketNode(name: '608' | '624' | '625' | '688' = '608'): SceneNode {
  const spec = BEARING_SPECS[name] || BEARING_SPECS['608'];
  const outerR = (spec.outerDiameterMm / 2 + 2.5) / 1000;
  const height = (spec.widthMm + 2.0) / 1000;
  const bearingCutR = (spec.outerDiameterMm / 2 + 0.08) / 1000;
  const bearingCutH = (spec.widthMm + 0.8) / 1000;
  const shaftCutR = (spec.innerDiameterMm / 2 + 0.5) / 1000;
  const id = `bearing_${name}_${Math.random().toString(36).slice(2, 7)}`;

  const scad = `// 3D Print ${name} Bearing Housing Pocket
$fn = 64;
scale(0.001) {
  difference() {
    cylinder(r = ${spec.outerDiameterMm / 2 + 2.5}, h = ${spec.widthMm + 2.0}, center = false);
    // Bearing press-fit pocket (+0.15mm clearance for FDM)
    translate([0, 0, 1.5])
      cylinder(r = ${spec.outerDiameterMm / 2 + 0.08}, h = ${spec.widthMm + 0.8}, center = false);
    // Shaft pass-through & retention lip hole
    translate([0, 0, -0.1])
      cylinder(r = ${spec.innerDiameterMm / 2 + 0.5}, h = ${spec.widthMm + 2.2}, center = false);
  }
}
`;

  return {
    id,
    name: `${name} Bearing Housing`,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scad,
    csgEnabled: true,
    type: 'body',
    isHardwareComponent: true,
    hardwareType: 'bearing_pocket',
    hardwareSpec: spec,
    geoms: [
      {
        name: `${name} Housing Body`,
        type: 'cylinder',
        size: [outerR, height / 2],
        rgba: [0.4, 0.45, 0.55, 1],
        dynamic: true,
        mass: 0.015,
        pos: [0, 0, height / 2],
      },
      {
        name: `${name} Bearing Seat Cutout`,
        type: 'cylinder',
        size: [bearingCutR, bearingCutH / 2],
        rgba: [0.9, 0.25, 0.35, 1],
        dynamic: false,
        csg: 'difference',
        pos: [0, 0, 0.0015 + bearingCutH / 2],
      },
      {
        name: `${name} Shaft Hole Cutout`,
        type: 'cylinder',
        size: [shaftCutR, (height + 0.0004) / 2],
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

export interface CounterboreSpec {
  size: 'M2' | 'M3' | 'M4' | 'M5';
  headDiameterMm: number;
  headHeightMm: number;
  shankDiameterMm: number;
  totalDepthMm: number;
}

export const COUNTERBORE_SPECS: Record<string, CounterboreSpec> = {
  M2: { size: 'M2', headDiameterMm: 3.8, headHeightMm: 2.0, shankDiameterMm: 2.4, totalDepthMm: 6.0 },
  M3: { size: 'M3', headDiameterMm: 5.5, headHeightMm: 3.0, shankDiameterMm: 3.4, totalDepthMm: 8.0 },
  M4: { size: 'M4', headDiameterMm: 7.0, headHeightMm: 4.0, shankDiameterMm: 4.5, totalDepthMm: 10.0 },
  M5: { size: 'M5', headDiameterMm: 8.5, headHeightMm: 5.0, shankDiameterMm: 5.5, totalDepthMm: 12.0 },
};

/**
 * Creates a complete SceneNode for a Counterbored Screw Hole (Cap Screw Head Recess + Shank Through Hole)
 */
export function createCounterboreHoleNode(size: 'M2' | 'M3' | 'M4' | 'M5' = 'M3'): SceneNode {
  const spec = COUNTERBORE_SPECS[size] || COUNTERBORE_SPECS.M3;
  const outerR = (spec.headDiameterMm / 2 + 1.5) / 1000;
  const headCutR = (spec.headDiameterMm / 2 + 0.25) / 1000;
  const headCutH = (spec.headHeightMm + 0.2) / 1000;
  const shankCutR = (spec.shankDiameterMm / 2) / 1000;
  const height = spec.totalDepthMm / 1000;
  const id = `counterbore_${size.toLowerCase()}_${Math.random().toString(36).slice(2, 7)}`;

  const scad = `// 3D Print ${size} Counterbored Screw Clearance Hole
$fn = 32;
scale(0.001) {
  difference() {
    cylinder(r = ${(spec.headDiameterMm / 2 + 1.5).toFixed(3)}, h = ${spec.totalDepthMm}, center = false);
    // Bolt head counterbore recess
    translate([0, 0, ${(spec.totalDepthMm - spec.headHeightMm).toFixed(3)}])
      cylinder(r = ${(spec.headDiameterMm / 2 + 0.25).toFixed(3)}, h = ${(spec.headHeightMm + 0.3).toFixed(3)}, center = false);
    // Shank clearance through-hole
    translate([0, 0, -0.1])
      cylinder(r = ${(spec.shankDiameterMm / 2).toFixed(3)}, h = ${(spec.totalDepthMm + 0.2).toFixed(3)}, center = false);
  }
}
`;

  return {
    id,
    name: `${size} Cap Screw Recess`,
    pos: [0, 0, 0],
    rot: [0, 0, 0],
    scad,
    csgEnabled: true,
    type: 'body',
    isHardwareComponent: true,
    hardwareType: 'counterbore_hole',
    hardwareSpec: spec,
    geoms: [
      {
        name: `${size} Housing Sleeve`,
        type: 'cylinder',
        size: [outerR, height / 2],
        rgba: [0.5, 0.55, 0.65, 1],
        dynamic: true,
        mass: 0.006,
        pos: [0, 0, height / 2],
      },
      {
        name: `${size} Bolt Head Recess Cutout`,
        type: 'cylinder',
        size: [headCutR, headCutH / 2],
        rgba: [0.9, 0.25, 0.35, 1],
        dynamic: false,
        csg: 'difference',
        pos: [0, 0, height - headCutH / 2],
      },
      {
        name: `${size} Shank Through-Hole Cutout`,
        type: 'cylinder',
        size: [shankCutR, (height + 0.0004) / 2],
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

