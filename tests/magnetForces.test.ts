import { describe, expect, it } from 'vitest';
import type { SceneNode } from '../src/types/scene';
import {
  applyMagnetForces,
  collectMagnetBodies,
  computeDipoleInteraction,
  magnetMomentAm2,
  parseMagnetSizeMm,
  type MagnetBody,
} from '../src/utils/magnetForces';

const IDENTITY_ROT = [
  1, 0, 0,
  0, 1, 0,
  0, 0, 1,
];

// 180 deg rotation about X: local +Z -> world -Z
const FLIP_X_ROT = [
  1, 0, 0,
  0, -1, 0,
  0, 0, -1,
];

// +90 deg rotation about Y: local +Z -> world +X
const ROT_Y_90 = [
  0, 0, 1,
  0, 1, 0,
  -1, 0, 0,
];

function makeMagnet(overrides: Partial<MagnetBody> & { bodyId: number }): MagnetBody {
  return {
    weldId: overrides.bodyId,
    radiusM: 0.004,
    thicknessM: 0.003,
    momentAm2: magnetMomentAm2(8, 3),
    polarity: 1,
    ...overrides,
  };
}

function makeSimData(bodies: Array<{ pos: [number, number, number]; rot?: number[] }>) {
  const n = bodies.length;
  const xpos = new Float64Array(n * 3);
  const xmat = new Float64Array(n * 9);
  const xfrc_applied = new Float64Array(n * 6);
  for (let i = 0; i < n; i++) {
    xpos.set(bodies[i].pos, i * 3);
    xmat.set(bodies[i].rot ?? IDENTITY_ROT, i * 9);
  }
  return { xpos, xmat, xfrc_applied };
}

describe('magnetForces', () => {
  it('parses magnet size strings cleanly', () => {
    expect(parseMagnetSizeMm('8×3')).toEqual([8, 3]);
    expect(parseMagnetSizeMm('8x3')).toEqual([8, 3]);
    expect(parseMagnetSizeMm(' 10 × 2.5 ')).toEqual([10, 2.5]);
    expect(parseMagnetSizeMm('M3')).toBeNull();
    expect(parseMagnetSizeMm('0x3')).toBeNull();
  });

  it('collects magnet bodies recursively with weldId and polarity', () => {
    const nodes = [
      {
        id: 'parent',
        name: 'parent',
        children: [
          {
            id: 'mag_a',
            name: 'mag_a',
            hardwarePart: { kind: 'magnet', size: '8×3' },
          },
          {
            id: 'mag_b',
            name: 'mag_b',
            hardwarePart: { kind: 'magnet', size: '10x2', polarity: -1 },
          },
          {
            id: 'bolt_1',
            name: 'bolt_1',
            hardwarePart: { kind: 'screw', size: 'M3' },
          },
        ],
      },
    ] as unknown as SceneNode[];

    const cache = new Map<string, number>([
      ['mag_a', 1],
      ['mag_b', 2],
      ['bolt_1', 3],
    ]);
    const model = { body_weldid: new Int32Array([0, 1, 1, 3]) };

    const magnets = collectMagnetBodies(nodes, cache, model);
    expect(magnets).toHaveLength(2);
    expect(magnets[0]).toMatchObject({
      bodyId: 1,
      weldId: 1,
      radiusM: 0.004,
      thicknessM: 0.003,
      polarity: 1,
    });
    expect(magnets[1]).toMatchObject({
      bodyId: 2,
      weldId: 1,
      radiusM: 0.005,
      thicknessM: 0.002,
      polarity: -1,
    });
  });

  it('attracts two coaxial aligned magnets (N facing S) obeying Newtons 3rd law', () => {
    const m1 = makeMagnet({ bodyId: 1, polarity: 1 });
    const m2 = makeMagnet({ bodyId: 2, polarity: 1 });
    const data = makeSimData([
      { pos: [0, 0, 0] }, // body 0 (world)
      { pos: [0, 0, 0] }, // body 1
      { pos: [0, 0, 0.010] }, // body 2 at +Z = 10 mm
    ]);

    applyMagnetForces([m1, m2], data);

    const f1z = data.xfrc_applied[1 * 6 + 2];
    const f2z = data.xfrc_applied[2 * 6 + 2];

    // Magnet 2 is at +Z, so attraction pulls it toward -Z (f2.z < 0) and magnet 1 toward +Z (f1.z > 0).
    expect(f2z).toBeLessThan(0);
    expect(f1z).toBeGreaterThan(0);
    expect(f1z).toBeCloseTo(-f2z, 12);
    expect(data.xfrc_applied[1 * 6 + 0]).toBeCloseTo(0, 12);
    expect(data.xfrc_applied[1 * 6 + 1]).toBeCloseTo(0, 12);
    expect(data.xfrc_applied[2 * 6 + 0]).toBeCloseTo(0, 12);
    expect(data.xfrc_applied[2 * 6 + 1]).toBeCloseTo(0, 12);
  });

  it('repels two coaxial opposing magnets (polarity -1 or rotated 180 deg)', () => {
    const m1 = makeMagnet({ bodyId: 1, polarity: 1 });
    const m2FlippedPolarity = makeMagnet({ bodyId: 2, polarity: -1 });
    const dataPolarity = makeSimData([
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0.010] },
    ]);

    applyMagnetForces([m1, m2FlippedPolarity], dataPolarity);
    expect(dataPolarity.xfrc_applied[2 * 6 + 2]).toBeGreaterThan(0);
    expect(dataPolarity.xfrc_applied[1 * 6 + 2]).toBeLessThan(0);
    expect(dataPolarity.xfrc_applied[1 * 6 + 2]).toBeCloseTo(-dataPolarity.xfrc_applied[2 * 6 + 2], 12);

    const m2Rotated = makeMagnet({ bodyId: 2, polarity: 1 });
    const dataRotated = makeSimData([
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0.010], rot: FLIP_X_ROT },
    ]);

    applyMagnetForces([m1, m2Rotated], dataRotated);
    expect(dataRotated.xfrc_applied[2 * 6 + 2]).toBeGreaterThan(0);
    expect(dataRotated.xfrc_applied[1 * 6 + 2]).toBeLessThan(0);
    expect(dataRotated.xfrc_applied[2 * 6 + 2]).toBeCloseTo(dataPolarity.xfrc_applied[2 * 6 + 2], 12);
  });

  it('produces realistic force magnitude at 10 mm and smoothly bounded force at contact (3 mm)', () => {
    const moment = magnetMomentAm2(8, 3);
    const at10mm = computeDipoleInteraction(
      [0, 0, 0],
      [0, 0, moment],
      0.004,
      0.003,
      [0, 0, 0.010],
      [0, 0, moment],
      0.004,
      0.003,
    );
    expect(at10mm).not.toBeNull();
    const mag10 = Math.abs(at10mm!.f2[2]);
    expect(mag10).toBeGreaterThan(0.5);
    expect(mag10).toBeLessThan(3.0);

    const atContact = computeDipoleInteraction(
      [0, 0, 0],
      [0, 0, moment],
      0.004,
      0.003,
      [0, 0, 0.003],
      [0, 0, moment],
      0.004,
      0.003,
    );
    expect(atContact).not.toBeNull();
    expect(atContact!.f2[2]).toBeLessThan(0); // still attractive at contact!
    const magContact = Math.abs(atContact!.f2[2]);
    expect(magContact).toBeGreaterThan(2.5);
    expect(magContact).toBeLessThan(12.0);
  });

  it('applies aligning torque to perpendicular dipoles', () => {
    const m1 = makeMagnet({ bodyId: 1 });
    const m2 = makeMagnet({ bodyId: 2 });
    const data = makeSimData([
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0], rot: IDENTITY_ROT }, // m1 along +Z
      { pos: [0, 0, 0.010], rot: ROT_Y_90 }, // m2 along +X
    ]);

    applyMagnetForces([m1, m2], data);

    // At +Z from m1 (+Z), B1 points along +Z.
    // tau2 = m2 (+X) x B1 (+Z) points along -Y (rotating +X toward +Z).
    const tau2y = data.xfrc_applied[2 * 6 + 4];
    expect(tau2y).toBeLessThan(0);
    expect(Math.abs(data.xfrc_applied[2 * 6 + 3])).toBeCloseTo(0, 12);
    expect(Math.abs(data.xfrc_applied[2 * 6 + 5])).toBeCloseTo(0, 12);

    // At -Z from m2 (+X), B2 points along -X.
    // tau1 = m1 (+Z) x B2 (-X) points along -Y (rotating +Z toward -X).
    const tau1y = data.xfrc_applied[1 * 6 + 4];
    expect(tau1y).toBeLessThan(0);
  });

  it('exerts zero force between two magnets sharing the same weldId', () => {
    const m1 = makeMagnet({ bodyId: 1, weldId: 7 });
    const m2 = makeMagnet({ bodyId: 2, weldId: 7 });
    const data = makeSimData([
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0.010] },
    ]);

    applyMagnetForces([m1, m2], data);
    expect(Array.from(data.xfrc_applied).every((v) => v === 0)).toBe(true);
  });

  it('exerts zero force between distant magnets beyond cutoff', () => {
    const m1 = makeMagnet({ bodyId: 1 });
    const m2 = makeMagnet({ bodyId: 2 });
    const data = makeSimData([
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0] },
      { pos: [0, 0, 0.25] }, // 250 mm > max(150 mm, 12 * 8 mm = 96 mm)
    ]);

    applyMagnetForces([m1, m2], data);
    expect(Array.from(data.xfrc_applied).every((v) => v === 0)).toBe(true);
  });
});
