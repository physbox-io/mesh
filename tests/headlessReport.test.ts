// physics_run_headless's `bodies` filter and `final`.
//
// The filter matched trajectory keys, which are body ids, so asking for
// "output" (the name of body "gear_a4") or for a typo returned `bodies: {}` in
// every frame, and `final`, judged from those empty frames, said `settled:
// true` while the whole gear train spun at 25 rad/s.

import { describe, it, expect } from 'vitest';
import { reportHeadless, resolveBodyFilter, emptySceneRefusal } from '../src/utils/headlessReport';
import type { HistoryEntry } from '../src/workers/physicsWorkerProtocol';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const node = (id: string, name: string, joint?: { name: string; type: string }, children: SceneNode[] = []): SceneNode =>
  ({ id, name, type: 'body', pos: [0, 0, 0], children, joints: joint ? [joint] : [], geoms: [] }) as unknown as SceneNode;

const graph: SceneGraph = {
  nodes: [
    node('frame', 'frame', undefined, [
      node('gear_a1', 'input', { name: 'in_hinge', type: 'hinge' }),
      node('gear_a4', 'output', { name: 'out_hinge', type: 'hinge' }),
    ]),
  ],
} as SceneGraph;

/** Two seconds of a gear train: the frame still, both gears spinning at `w` rad/s. */
const spinning = (w: number): HistoryEntry[] => {
  const frames: HistoryEntry[] = [];
  for (let t = 0; t <= 2 + 1e-9; t += 0.01) {
    const still = { pos: [0, 0, 0], vel: [0, 0, 0], angvel: [0, 0, 0], xfrc_applied: [0, 0, 0, 0, 0, 0], quat: [1, 0, 0, 0] };
    const spin = { ...still, angvel: [0, 0, w] };
    frames.push({
      time: t,
      bodies: { frame: still, gear_a1: spin, gear_a4: spin },
      joints: { in_hinge: { pos: w * t, vel: w, qfrc_applied: 0 }, out_hinge: { pos: -w * t, vel: -w, qfrc_applied: 0 } },
      contacts: [],
      aeroDiagnostics: {},
    });
  }
  return frames;
};

const run = (w: number) => ({ ok: true as const, ticksSimulated: 2000, trajectory: spinning(w), warnings: [] as string[] });

describe('the bodies filter', () => {
  it('takes a body by its name as well as its id', () => {
    const f = resolveBodyFilter(graph, ['output', 'gear_a1']);
    expect([...f.ids!].sort()).toEqual(['gear_a1', 'gear_a4']);
    expect(f.unknown).toEqual([]);
  });

  it('keeps the named body in every frame and warns about one that does not exist', () => {
    const r = reportHeadless(run(25), graph, ['output', 'outptu']);
    expect(Object.keys(r.trajectory![0].bodies)).toEqual(['gear_a4']);
    expect(r.warnings.some((w) => /"outptu"/.test(w) && /output \(gear_a4\)/.test(w))).toBe(true);
    expect(Object.keys(r.final!.bodies)).toEqual(['gear_a4']);
    expect(r.final!.bodies.gear_a4.name).toBe('output');
  });

  it('judges settled on the whole scene, not the bodies kept', () => {
    // Only the still frame is asked for; the gears are spinning.
    const r = reportHeadless(run(25), graph, ['frame']);
    expect(r.final!.settled).toBe(false);
    expect(r.final!.moving).toEqual(expect.arrayContaining(['gear_a1', 'gear_a4']));
    // An unknown name alone used to leave nothing to judge, and so "settled".
    expect(reportHeadless(run(25), graph, ['nope']).final!.settled).toBe(false);
  });

  it('counts a joint still turning even when no body frame shows it', () => {
    const frames = spinning(0).map((f) => ({ ...f, joints: { ...f.joints, out_hinge: { pos: 0, vel: 2, qfrc_applied: 0 } } }));
    const r = reportHeadless({ ok: true, ticksSimulated: 2000, trajectory: frames, warnings: [] }, graph, undefined);
    expect(r.final!.settled).toBe(false);
    expect(r.final!.moving).toEqual(['out_hinge']);
    expect(reportHeadless(run(0), graph, undefined).final!.settled).toBe(true);
  });
});

describe('an empty scene', () => {
  it('is refused rather than reported settled', () => {
    expect(emptySceneRefusal({ nodes: [] } as unknown as SceneGraph)).toMatchObject({ ok: false, error: expect.stringMatching(/empty/) });
    expect(emptySceneRefusal(graph)).toBeNull();
  });
});
