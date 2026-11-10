import { describe, it, expect } from 'vitest';
import { digestTelemetry } from '../src/utils/telemetryDigest';
import type { HistoryFrame } from '../src/workers/physicsWorkerProtocol';

const body = (pos: number[], vel: number[] = [0, 0, 0]) => ({ pos, vel, angvel: [0, 0, 0], xfrc_applied: [0, 0, 0, 0, 0, 0] });

/** A ball dropping 100 mm and stopping at t=0.5, a box that never moves, a hinge swinging 90 degrees under a motor. */
function run(): HistoryFrame[] {
  const frames: HistoryFrame[] = [];
  for (let i = 0; i <= 20; i++) {
    const t = i * 0.05;
    const falling = t < 0.5;
    frames.push({
      time: t,
      bodies: {
        ball: body([0, 0, falling ? 0.2 - 0.2 * t : 0.1], [0, 0, falling ? -0.2 : 0]),
        box: body([0.5, 0, 0.05]),
      },
      joints: {
        arm_hinge: { pos: Math.min(t, 0.5) * Math.PI, vel: 0, qfrc_applied: 0, actuatorForce: i === 3 ? -1.25 : 0.4 },
      },
      contacts: t >= 0.5 ? [{ geom1: 'g1', geom2: 'floor', dist: 0, body1: 'ball', body2: 'world' }] : [],
    });
  }
  return frames;
}

describe('digestTelemetry', () => {
  it('says what moved, how far, and when everything came to rest', () => {
    const d = digestTelemetry(run(), { jointTypes: { arm_hinge: 'hinge' }, nameOf: (id) => (id === 'ball' ? 'Ball' : id) })!;
    expect(d.durationS).toBeCloseTo(1, 6);
    expect(Object.keys(d.moved)).toEqual(['Ball']);
    expect(d.moved.Ball.netMm).toBeCloseTo(100, 0);
    expect(d.moved.Ball.peakSpeedMmS).toBeCloseTo(200, 0);
    expect(d.still).toBe(1);
    expect(d.settledAtS).toBeCloseTo(0.5, 6);
  });

  it('reports joint travel in degrees and the peak motor effort', () => {
    const d = digestTelemetry(run(), { jointTypes: { arm_hinge: 'hinge' } })!;
    expect(d.joints.arm_hinge.travel).toBeCloseTo(90, 0);
    expect(d.joints.arm_hinge.unit).toBe('deg');
    expect(d.joints.arm_hinge.peakEffort).toBeCloseTo(1.25, 6);
  });

  it('counts contact time by body pair', () => {
    const d = digestTelemetry(run())!;
    expect(d.contacts!.peak).toBe(1);
    expect(d.contacts!.longest[0].pair).toEqual(['ball', 'world']);
    expect(d.contacts!.longest[0].seconds).toBeCloseTo(0.5, 2);
  });

  it('flags a body that fell through the floor, and never settling', () => {
    const frames: HistoryFrame[] = [0, 0.1, 0.2].map((t) => ({ time: t, bodies: { rock: body([0, 0, 0.1 - 5 * t], [0, 0, -5]) } }));
    const d = digestTelemetry(frames)!;
    expect(d.moved.rock.leftScene).toBe(true);
    expect(d.settledAtS).toBeNull();
  });

  it('returns null for no frames', () => {
    expect(digestTelemetry([])).toBeNull();
  });
});
