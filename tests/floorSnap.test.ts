import { describe, it, expect } from 'vitest';
import {
  snapToFloor, worldPerPixel, snapThreshold, MIN_SNAP_M, MAX_SNAP_M, SNAP_PIXELS,
} from '../src/utils/floorSnap';

const GROUND = 0.037; // Deliberately not zero: a mesh's origin is its centroid.
const BAND = 0.004;

const z = (raw: number) => snapToFloor({ z: raw, groundZ: GROUND, threshold: BAND }).z;

describe('snapToFloor', () => {
  it('leaves a drag alone outside the band', () => {
    expect(z(GROUND + BAND)).toBe(GROUND + BAND);
    expect(z(GROUND + 10 * BAND)).toBe(GROUND + 10 * BAND);
    expect(z(GROUND - 10 * BAND)).toBe(GROUND - 10 * BAND);
  });

  it('holds a body already on the floor exactly on it', () => {
    const snap = snapToFloor({ z: GROUND, groundZ: GROUND, threshold: BAND });
    expect(snap.z).toBe(GROUND);
    expect(snap.locked).toBe(true);
    expect(snap.strength).toBe(1);
  });

  it('lands on the floor rather than approaching it — the deadzone', () => {
    // A hair inside the deadzone must be exactly the ground, not near it.
    const snap = snapToFloor({ z: GROUND + 0.3 * BAND, groundZ: GROUND, threshold: BAND });
    expect(snap.z).toBe(GROUND);
    expect(snap.locked).toBe(true);
  });

  it('pulls toward the floor without ever pushing past it', () => {
    for (let i = 1; i < 40; i++) {
      const raw = GROUND + (i / 40) * BAND;
      const out = z(raw);
      expect(out).toBeGreaterThanOrEqual(GROUND);
      expect(out).toBeLessThanOrEqual(raw + 1e-12);
    }
  });

  it('is monotonic and continuous across the whole band', () => {
    // A reversal would make the body move down as the pointer moves up; a jump
    // would make the handle teleport. Both read as a bug, so both are asserted.
    const samples: number[] = [];
    for (let i = 0; i <= 100; i++) samples.push(z(GROUND - BAND + (2 * BAND * i) / 100));
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-12);
      expect(Math.abs(samples[i] - samples[i - 1])).toBeLessThan(BAND / 10);
    }
  });

  it('behaves the same below the floor as above it', () => {
    for (let i = 1; i < 20; i++) {
      const d = (i / 20) * BAND;
      expect(z(GROUND + d) - GROUND).toBeCloseTo(GROUND - z(GROUND - d), 12);
    }
  });

  it('fades the hint out as the drag leaves the band', () => {
    const near = snapToFloor({ z: GROUND + 0.4 * BAND, groundZ: GROUND, threshold: BAND });
    const far = snapToFloor({ z: GROUND + 0.9 * BAND, groundZ: GROUND, threshold: BAND });
    expect(near.strength).toBeGreaterThan(far.strength);
    expect(far.strength).toBeGreaterThanOrEqual(0);
    expect(near.strength).toBeLessThanOrEqual(1);
  });

  it('does nothing at all when the snap is switched off', () => {
    const raw = GROUND + 1e-9;
    expect(snapToFloor({ z: raw, groundZ: GROUND, threshold: 0 }).z).toBe(raw);
    expect(snapToFloor({ z: raw, groundZ: GROUND, threshold: -1 }).z).toBe(raw);
  });

  it('passes non-finite input through rather than producing NaN positions', () => {
    expect(snapToFloor({ z: NaN, groundZ: GROUND, threshold: BAND }).locked).toBe(false);
    expect(snapToFloor({ z: 1, groundZ: NaN, threshold: BAND }).z).toBe(1);
  });
});

describe('snap threshold', () => {
  it('measures a pixel in world units from the camera distance', () => {
    // 50° vertical fov at 1 m sees ~0.932 m; over 1000 px that is ~0.93 mm.
    expect(worldPerPixel(50, 1, 1000)).toBeCloseTo(0.000932, 5);
    // Twice as far away, a pixel covers twice as much.
    expect(worldPerPixel(50, 2, 1000)).toBeCloseTo(2 * worldPerPixel(50, 1, 1000), 12);
  });

  it('returns nothing rather than dividing by a zero-height canvas', () => {
    expect(worldPerPixel(50, 1, 0)).toBe(0);
  });

  it('keeps the band usable at any zoom', () => {
    expect(snapThreshold(50, 1, 1000)).toBeCloseTo(worldPerPixel(50, 1, 1000) * SNAP_PIXELS, 12);
    // Zoomed far out the band would be wider than most parts; pressed right up
    // against a body it would be too small to feel. Both ends are clamped.
    expect(snapThreshold(50, 10000, 1000)).toBe(MAX_SNAP_M);
    expect(snapThreshold(50, 1e-6, 1000)).toBe(MIN_SNAP_M);
    expect(snapThreshold(50, 1, 0)).toBe(MIN_SNAP_M);
  });
});
