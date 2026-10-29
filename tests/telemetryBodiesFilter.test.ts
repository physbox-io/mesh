// A `bodies` filter cuts joints and contacts too, in physics_get_history and
// physics_run_headless. With bodies: ['payload'] every joint and every contact
// in the scene used to come back, which was most of the reply.

import { describe, it, expect } from 'vitest';
import { HistoryRing } from '../src/workers/historyRing';
import { reportHeadless } from '../src/utils/headlessReport';
import type { HistoryEntry } from '../src/workers/physicsWorkerProtocol';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const still = { pos: [0, 0, 0], vel: [0, 0, 0], angvel: [0, 0, 0], xfrc_applied: [0, 0, 0, 0, 0, 0], quat: [1, 0, 0, 0] };
const frame = (time: number): HistoryEntry => ({
  time,
  bodies: { payload: still, platform: still, rover: still },
  joints: {
    lift_z: { body: 'platform', pos: 0.1, vel: 0, qfrc_applied: 0, ctrl: 5, actuatorForce: 5 },
    rover_joint_0: { body: 'rover', pos: [0.13, 0, 0.05, 1, 0, 0, 0], vel: [0, 0, 0, 0, 0, 0], qfrc_applied: [0, 0, 0, 0, 0, 0] },
    payload_free: { body: 'payload', pos: [0, 0, 0.355, 1, 0, 0, 0], vel: [0, 0, 0, 0, 0, 0], qfrc_applied: [0, 0, 0, 0, 0, 0] },
  },
  contacts: [
    { geom1: 'payload_g', geom2: 'platform_g', dist: 0, body1: 'payload', body2: 'platform' },
    { geom1: 'floor', geom2: 'rover_g', dist: 0, body1: 'world', body2: 'rover' },
  ],
  aeroDiagnostics: {},
});

describe('physics_get_history bodies filter', () => {
  it('keeps the bodies, their joints, and only the contacts they are in', () => {
    const ring = new HistoryRing(10);
    ring.push(frame(0));
    const [f] = ring.query({ bodies: ['payload'] }).frames;
    expect(Object.keys(f.bodies!)).toEqual(['payload']);
    expect(Object.keys(f.joints!)).toEqual(['payload_free']);
    expect(f.contacts).toEqual([{ geom1: 'payload_g', geom2: 'platform_g', dist: 0, body1: 'payload', body2: 'platform' }]);
    // The stored entry is untouched.
    expect(Object.keys(ring.latest()!.joints)).toHaveLength(3);
  });

  it('filters nothing without a list', () => {
    const ring = new HistoryRing(10);
    ring.push(frame(0));
    const [f] = ring.query({}).frames;
    expect(Object.keys(f.joints!)).toHaveLength(3);
    expect(f.contacts).toHaveLength(2);
  });
});

describe('physics_run_headless bodies filter', () => {
  const node = (id: string): SceneNode => ({ id, name: id, type: 'body', pos: [0, 0, 0], children: [], joints: [], geoms: [] }) as unknown as SceneNode;
  const graph = { nodes: [node('payload'), node('platform'), node('rover')] } as SceneGraph;

  it('cuts joints and contacts to the bodies asked for', () => {
    const r = reportHeadless({ ok: true, ticksSimulated: 10, trajectory: [frame(0), frame(0.01)], warnings: [] }, graph, ['platform']);
    const f = r.trajectory![1];
    expect(Object.keys(f.bodies)).toEqual(['platform']);
    expect(Object.keys(f.joints)).toEqual(['lift_z']);
    expect(f.joints.lift_z).toMatchObject({ ctrl: 5, actuatorForce: 5 });
    expect(f.contacts.map((c) => c.geom1)).toEqual(['payload_g']);
  });

  it('passes the script report through untouched', () => {
    const r = reportHeadless({
      ok: true, ticksSimulated: 10, trajectory: [frame(0)], warnings: [],
      logs: [{ t: 0, body: 'platform', msg: 'up' }], scriptState: { platform: { phase: 2 } }, wallMs: 12, scriptMsPerStep: 0.01,
    }, graph, undefined);
    expect(r.logs).toEqual([{ t: 0, body: 'platform', msg: 'up' }]);
    expect(r.scriptState).toEqual({ platform: { phase: 2 } });
    expect(r.wallMs).toBe(12);
  });
});
