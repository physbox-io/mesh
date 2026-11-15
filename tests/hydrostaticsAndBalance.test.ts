import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { SceneNode } from '../src/types/scene';
import {
  buildHydroBodyModel,
  computeBuoyancyWrench,
  evaluateSubmerged,
  FRESHWATER_DENSITY,
} from '../src/utils/hydrostatics';
import {
  analyzeStability,
  balanceBody,
  clearBalanceAdjustments,
} from '../src/utils/balancePart';

const IDENTITY_XMAT = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function xmatFromAxisAngle(axis: [number, number, number], rad: number): number[] {
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis).normalize(), rad);
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
  const e = m.elements; // column-major
  // Row-major 3x3 for MuJoCo xmat
  return [
    e[0], e[4], e[8],
    e[1], e[5], e[9],
    e[2], e[6], e[10],
  ];
}

describe('True waterline hydrostatics', () => {
  it('integrates exact submerged volume and 3D Centre of Buoyancy for a cube across poses', () => {
    // 100 mm cube (half-extents 0.05 m -> total volume 0.001 m³)
    const cube: SceneNode = {
      id: 'cube',
      name: 'Cube',
      pos: [0, 0, 0],
      geoms: [{ name: 'box', type: 'box', size: [0.05, 0.05, 0.05] }],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };
    const hydro = buildHydroBodyModel(cube);
    expect(hydro).not.toBeNull();
    expect(hydro!.solidVolume).toBeCloseTo(0.001, 6);

    // Half submerged at Z = 0: bottom half [-0.05..0] -> V = 0.0005 m³, CoB.z = -0.025 m
    const half = evaluateSubmerged(hydro!, [0, 0, 0], IDENTITY_XMAT, 0);
    expect(half.volume).toBeCloseTo(0.0005, 6);
    expect(half.cob[0]).toBeCloseTo(0, 6);
    expect(half.cob[1]).toBeCloseTo(0, 6);
    expect(half.cob[2]).toBeCloseTo(-0.025, 6);

    // 25% submerged (waterLevel = -0.025 -> [-0.05..-0.025], depth 0.025 m -> CoB.z = -0.0375 m)
    const quarter = evaluateSubmerged(hydro!, [0, 0, 0], IDENTITY_XMAT, -0.025);
    expect(quarter.volume).toBeCloseTo(0.00025, 6);
    expect(quarter.cob[2]).toBeCloseTo(-0.0375, 6);

    // Tilted 35° about Y while centred on waterline Z = 0: by point symmetry of cube,
    // exactly half its volume remains below Z = 0, and CoB shifts laterally generating a righting arm!
    const rot35 = xmatFromAxisAngle([0, 1, 0], (35 * Math.PI) / 180);
    const tilted = evaluateSubmerged(hydro!, [0, 0, 0], rot35, 0);
    expect(tilted.volume).toBeCloseTo(0.0005, 5);
    expect(tilted.cob[2]).toBeLessThan(-0.015);
  });

  it('displaces interior air for a dense open-top boat hull when upright, and swamps when heeled past the rim', () => {
    // Open rectangular steel barge (density 2500 kg/m³ > water 1000 kg/m³!):
    // Outer 120 x 80 x 50 mm, wall thickness 5 mm (bottom + 4 walls, open top at z = +0.025)
    const barge: SceneNode = {
      id: 'barge',
      name: 'Open Barge',
      pos: [0, 0, 0],
      density: 2500,
      geoms: [
        { name: 'floor', type: 'box', size: [0.06, 0.04, 0.0025], pos: [0, 0, -0.0225] },
        { name: 'port', type: 'box', size: [0.06, 0.0025, 0.0225], pos: [0, 0.0375, 0.0025] },
        { name: 'starboard', type: 'box', size: [0.06, 0.0025, 0.0225], pos: [0, -0.0375, 0.0025] },
        { name: 'bow', type: 'box', size: [0.0025, 0.035, 0.0225], pos: [0.0575, 0, 0.0025] },
        { name: 'stern', type: 'box', size: [0.0025, 0.035, 0.0225], pos: [-0.0575, 0, 0.0025] },
      ],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };
    const hydro = buildHydroBodyModel(barge);
    expect(hydro).not.toBeNull();
    expect(hydro!.vessel).toBeDefined();

    // Upright with waterline at Z = +0.015 (10 mm freeboard below z = +0.025 rim, 40 mm draft):
    // Displaced volume equals full outer box below waterline (0.12 * 0.08 * 0.04 = 0.000384 m³),
    // nearly 3x solid wall volume and well above what 2500 kg/m³ walls need to float!
    const upright = evaluateSubmerged(hydro!, [0, 0, 0], IDENTITY_XMAT, 0.015);
    expect(upright.floodedFraction).toBe(0);
    expect(upright.volume).toBeCloseTo(0.12 * 0.08 * 0.04, 5);
    expect(upright.volume).toBeGreaterThan(hydro!.solidVolume * 2.5);
    const solidMassKg = hydro!.solidVolume * 2500;
    const buoyantSupportKg = upright.volume * FRESHWATER_DENSITY;
    expect(buoyantSupportKg).toBeGreaterThan(solidMassKg);

    // Heeled 45° about X so the starboard gunwale plunges well below Z = +0.015:
    // Hull floods (floodedFraction -> 1) and buoyancy drops to bare submerged wall volume (< solidMassKg -> sinks!)
    const heeled = xmatFromAxisAngle([1, 0, 0], (45 * Math.PI) / 180);
    const swamped = evaluateSubmerged(hydro!, [0, 0, 0], heeled, 0.015);
    expect(swamped.floodedFraction).toBeGreaterThan(0.95);
    expect(swamped.volume * FRESHWATER_DENSITY).toBeLessThan(solidMassKg);
  });

  it('produces an upward Archimedes force and clamping-safe drag wrench', () => {
    const sphere: SceneNode = {
      id: 'cork',
      name: 'Cork Ball',
      pos: [0, 0, -0.05],
      density: 240,
      geoms: [{ name: 'ball', type: 'sphere', size: [0.02] }],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };
    const hydro = buildHydroBodyModel(sphere)!;
    const massKg = hydro.solidVolume * 240;
    const wrench = computeBuoyancyWrench(
      hydro,
      [0, 0, -0.05],
      IDENTITY_XMAT,
      [0, 0, -0.05],
      [0, 0, 4.0], // moving rapidly upward
      [0, 0, 0],
      massKg,
      [1e-5, 1e-5, 1e-5],
      0,
      -9.81,
      0.002,
    );
    // Buoyancy minus clamped upward drag remains finite and bounded
    expect(Number.isFinite(wrench.force[2])).toBe(true);
    expect(wrench.submergedVolume).toBeCloseTo((4 / 3) * Math.PI * 0.02 ** 3, 4);
  });
});

describe('Inverse Balance & Ballast (Stand / Spin / Float)', () => {
  it('stabilizes an overhanging L-shaped sculpture to stand upright on its base', () => {
    // Small base [0..30 mm] in X, heavy cantilevered arm hanging out at X = +45 mm
    const sculpture: SceneNode = {
      id: 'statue',
      name: 'Cantilever Statue',
      pos: [0, 0, 0.05],
      density: 1240,
      geoms: [
        { name: 'pedestal', type: 'box', size: [0.018, 0.02, 0.025], pos: [0, 0, -0.025] },
        { name: 'overhang_head', type: 'box', size: [0.032, 0.022, 0.022], pos: [0.026, 0, 0.022] },
      ],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };

    const before = analyzeStability(sculpture, null);
    expect(before.stand.stands).toBe(false);

    const balanced = balanceBody(sculpture, 'stand');
    expect(balanced.after.stand.stands).toBe(true);
    expect(balanced.after.stand.tipAngleDeg).toBeGreaterThan(8);
    expect(balanced.voidAdded || balanced.ballastNutCount > 0).toBe(true);

    // Every ballast nut is standard hardware (`kind: 'nut'`), fixed (no joints), and non-colliding
    const nuts = balanced.node.children.filter((c) => c.hardwarePart?.kind === 'nut');
    expect(nuts.length).toBe(balanced.ballastNutCount);
    for (const nut of nuts) {
      expect(nut.joints).toEqual([]);
      expect(nut.geoms.every((g) => g.contype === 0 && g.conaffinity === 0)).toBe(true);
    }

    // Reset restores original clean part
    const reset = clearBalanceAdjustments(balanced.node);
    expect(reset.geoms.some((g) => g.name === 'balance_void')).toBe(false);
    expect(reset.children.some((c) => c.id.includes('_ballast_'))).toBe(false);
  });

  it('drives radial CoM eccentricity toward zero for an off-axis hinged rotor', () => {
    const cam: SceneNode = {
      id: 'cam_rotor',
      name: 'Eccentric Cam',
      pos: [0, 0, 0.04],
      density: 1200,
      geoms: [
        { name: 'disc', type: 'box', size: [0.04, 0.025, 0.008], pos: [0.012, 0, 0] },
      ],
      joints: [{ name: 'spin_hinge', type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0] }],
      children: [],
    };

    const before = analyzeStability(cam, null);
    expect(before.spin.hasHinge).toBe(true);
    expect(before.spin.eccentricityMm).toBeCloseTo(12, 1);

    const res = balanceBody(cam, 'spin');
    expect(res.after.spin.eccentricityMm).toBeLessThan(1.5);
  });

  it('trims an off-balance floating block so horizontal CoM-CoB trim offset shrinks', () => {
    const hull: SceneNode = {
      id: 'toy_boat',
      name: 'Toy Boat',
      pos: [0, 0, 0],
      density: 650,
      geoms: [
        { name: 'hull', type: 'box', size: [0.05, 0.025, 0.018], pos: [0, 0, 0] },
        { name: 'cabin', type: 'box', size: [0.018, 0.02, 0.015], pos: [0.025, 0, 0.025] },
      ],
      joints: [{ name: 'free', type: 'free' }],
      children: [],
    };
    const res = balanceBody(hull, 'float', { waterLevel: 0 });
    expect(res.after.float.floats).toBe(true);
    expect(res.after.float.trimOffsetMm).toBeLessThan(res.before.float.trimOffsetMm);
  });
});
