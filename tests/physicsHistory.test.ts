import { describe, expect, it } from 'vitest';
import { HistoryRing } from '../src/workers/historyRing';
import type { HistoryEntry } from '../src/workers/physicsWorkerProtocol';

const entry = (time: number): HistoryEntry => ({
  time,
  bodies: {
    a: { pos: [time, 0, 0], vel: [0, 0, 0], angvel: [0, 0, 0], xfrc_applied: [0, 0, 0, 0, 0, 0] },
    b: { pos: [0, time, 0], vel: [0, 0, 0], angvel: [0, 0, 0], xfrc_applied: [0, 0, 0, 0, 0, 0] },
  },
  joints: { j: { pos: time, vel: 0, qfrc_applied: 0 } },
  contacts: [{ geom1: 'a', geom2: 'floor', dist: 0 }],
  aeroDiagnostics: {},
});

const filled = (capacity: number, n: number) => {
  const r = new HistoryRing(capacity);
  for (let i = 0; i < n; i++) r.push(entry(i));
  return r;
};
const times = (r: HistoryRing, q?: Parameters<HistoryRing['query']>[0]) => r.query(q).frames.map((f) => f.time);

describe('HistoryRing', () => {
  it('keeps the newest entries in order once it wraps', () => {
    const r = filled(5, 12);
    expect(r.size).toBe(5);
    expect(times(r)).toEqual([7, 8, 9, 10, 11]);
    expect(r.latest()?.time).toBe(11);
  });

  it('is empty after clear, and an empty query returns nothing', () => {
    const r = filled(5, 3);
    r.clear();
    expect(r.size).toBe(0);
    expect(r.latest()).toBeNull();
    expect(r.query()).toEqual({ frames: [], total: 0, stride: 1 });
    expect(times(new HistoryRing(5), { maxFrames: 3 })).toEqual([]);
  });

  it('last keeps the newest N', () => {
    expect(times(filled(10, 10), { last: 3 })).toEqual([7, 8, 9]);
    expect(times(filled(10, 10), { last: 0 })).toEqual([]);
    expect(times(filled(10, 10), { last: 50 })).toHaveLength(10);
  });

  it('sinceTime drops earlier frames, across the wrap', () => {
    expect(times(filled(8, 20), { sinceTime: 15 })).toEqual([15, 16, 17, 18, 19]);
    expect(times(filled(8, 20), { sinceTime: 100 })).toEqual([]);
  });

  it('stride counts back from the newest so it is always included', () => {
    expect(times(filled(10, 10), { stride: 3 })).toEqual([0, 3, 6, 9]);
    expect(times(filled(10, 10), { stride: 4 })).toEqual([1, 5, 9]);
  });

  it('maxFrames raises the stride to fit, and never lowers an explicit one', () => {
    const r = filled(5000, 5000);
    const q = r.query({ maxFrames: 200 });
    expect(q.frames.length).toBeLessThanOrEqual(200);
    expect(q.stride).toBe(25);
    expect(q.total).toBe(5000);
    expect(q.frames[q.frames.length - 1].time).toBe(4999);
    expect(r.query({ maxFrames: 200, stride: 100 }).stride).toBe(100);
    expect(r.query({ last: 50, maxFrames: 200 }).stride).toBe(1);
  });

  it('bodies and include trim each frame without touching the stored entry', () => {
    const r = filled(4, 4);
    const [f] = r.query({ last: 1, bodies: ['b'], include: ['bodies'] }).frames;
    expect(Object.keys(f.bodies!)).toEqual(['b']);
    expect(f.joints).toBeUndefined();
    expect(f.contacts).toBeUndefined();
    expect(f.aeroDiagnostics).toBeUndefined();
    expect(Object.keys(r.latest()!.bodies)).toEqual(['a', 'b']);
  });
});
