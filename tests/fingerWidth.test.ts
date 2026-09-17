import { describe, it, expect } from 'vitest';
import {
  derivedFingerWidthMm,
  effectiveFingerWidthMm,
  exportLaserCutSvg,
  DEFAULT_LASER_OPTIONS,
} from '../src/utils/laserCutExporter';
import { birdhousePreset } from '../src/presets/presetScenes';

/**
 * Finger width follows the stock.
 *
 * The old fixed 10 mm was chosen for thin ply and left alone for everything
 * else: in 18 mm stock it cuts fingers barely wider than the material is thick,
 * which is short grain and snaps out during assembly.
 */

describe('derived finger width', () => {
  it('is twice the material thickness through the usable range', () => {
    expect(derivedFingerWidthMm(6)).toBe(12);
    expect(derivedFingerWidthMm(9)).toBe(18);
    expect(derivedFingerWidthMm(12)).toBe(24);
  });

  it('never cuts a finger narrower than the material is thick', () => {
    for (const t of [1, 2, 3, 4, 6, 9, 12, 18, 25]) {
      expect(derivedFingerWidthMm(t)).toBeGreaterThanOrEqual(t);
    }
  });

  it('holds a floor, so the kerf never becomes a serious fraction of a finger', () => {
    expect(derivedFingerWidthMm(0.5)).toBe(5);
    expect(derivedFingerWidthMm(0)).toBe(5);
  });

  it('holds a ceiling, so a joint is never down to two fingers', () => {
    expect(derivedFingerWidthMm(40)).toBe(25);
  });

  it('stays close to the old fixed default at the ply it was chosen for', () => {
    // 3-6 mm is what 10 mm was picked for; existing thin-stock jobs should
    // barely move.
    expect(derivedFingerWidthMm(3)).toBeGreaterThanOrEqual(5);
    expect(derivedFingerWidthMm(5)).toBe(10);
  });
});

describe('the override', () => {
  it('is what gets cut when Auto is off', () => {
    expect(
      effectiveFingerWidthMm({ ...DEFAULT_LASER_OPTIONS, fingerWidthAuto: false, fingerWidth: 0.008, materialThickness: 0.012 })
    ).toBe(8);
  });

  it('is ignored while Auto is on', () => {
    expect(
      effectiveFingerWidthMm({ ...DEFAULT_LASER_OPTIONS, fingerWidthAuto: true, fingerWidth: 0.008, materialThickness: 0.012 })
    ).toBe(24);
  });

  it('is on by default', () => {
    expect(DEFAULT_LASER_OPTIONS.fingerWidthAuto).toBe(true);
  });
});

describe('thick stock', () => {
  it('cuts fewer, wider fingers than thin stock on the same model', () => {
    const cut = (thicknessMm: number) =>
      exportLaserCutSvg(birdhousePreset, {
        ...DEFAULT_LASER_OPTIONS,
        jointMode: 'finger',
        materialThickness: thicknessMm / 1000,
      });

    const thin = cut(3);
    const thick = cut(12);
    expect(thin.success).toBe(true);
    expect(thick.success).toBe(true);

    // More cell boundaries means more path vertices along the jointed edges.
    const vertices = (svg: string) => (svg.match(/[ML]\s/g) || []).length + (svg.match(/\d+\s+\d+/g) || []).length;
    expect(vertices(thick.svg!)).toBeLessThan(vertices(thin.svg!));
  });

  it('records the width it used in the file, so it is never a number nobody can see', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.009,
    });
    expect(result.svg).toContain('Finger=18.0mm (auto)');
  });
});
