import { describe, it, expect } from 'vitest';
import { summarizeTrajectory } from '../src/utils/trajectorySummary';
import type { HistoryEntry } from '../src/workers/physicsWorkerProtocol';

/** A quaternion [w, x, y, z] tilted `deg` about X. */
const tilt = (deg: number) => {
  const h = (deg * Math.PI) / 360;
  return [Math.cos(h), Math.sin(h), 0, 0];
};

/** Frames every 10 ms; `at(t)` gives the body's tilt and angular speed then. */
function run(seconds: number, at: (t: number) => { deg: number; w?: number; v?: number }): HistoryEntry[] {
  const frames: HistoryEntry[] = [];
  for (let t = 0; t <= seconds + 1e-9; t += 0.01) {
    const { deg, w = 0, v = 0 } = at(t);
    frames.push({
      time: t,
      bodies: { phone: { pos: [0, 0.01, 0.05], vel: [v, 0, 0], angvel: [w, 0, 0], xfrc_applied: [0, 0, 0, 0, 0, 0], quat: tilt(deg) } },
      joints: {},
      contacts: [],
      aeroDiagnostics: {},
    });
  }
  return frames;
}

describe('summarizing a headless run', () => {
  it('reports a body that has come to rest, and its lean', () => {
    const s = summarizeTrajectory(run(2, (t) => (t < 1 ? { deg: 22 * t, w: 0.38, v: 0.05 } : { deg: 22 })))!;
    expect(s.settled).toBe(true);
    expect(s.bodies.phone.settled).toBe(true);
    expect(s.bodies.phone.tiltDeg).toBeCloseTo(22, 0);
    expect(s.bodies.phone.turnedDeg).toBeCloseTo(22, 0);
    expect(s.bodies.phone.posMm).toEqual([0, 10, 50]);
  });

  it('does not call a body settled while it is still moving', () => {
    const s = summarizeTrajectory(run(2, (t) => ({ deg: 22, v: t > 1.8 ? 0.01 : 0 })))!;
    expect(s.bodies.phone.settled).toBe(false);
    expect(s.settled).toBe(false);
  });

  it('catches a body that is rocking, even through a moment that looks still', () => {
    // A slow 1 Hz rock of 3 degrees: at the turning points it is momentarily
    // stopped, which is exactly what a glance at one frame gets wrong.
    const s = summarizeTrajectory(run(3, (t) => ({ deg: 22 + 3 * Math.sin(2 * Math.PI * t), w: 0.0001 })))!;
    expect(s.bodies.phone.rocking).toBe(true);
    expect(s.bodies.phone.settled).toBe(false);
  });

  it('will not judge a run too short to tell', () => {
    const s = summarizeTrajectory(run(0.2, () => ({ deg: 0 })))!;
    expect(s.settled).toBe(false);
  });
});
