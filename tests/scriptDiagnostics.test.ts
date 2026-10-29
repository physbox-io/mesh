// What scripts got wrong, logged and cost, as the worker records it and as
// physics_get_state reports it. See src/workers/scriptDiagnostics.ts.

import { describe, it, expect } from 'vitest';
import {
  MAX_SCRIPT_PROBLEMS, ScriptLogRing, ScriptProblemLog, ScriptTiming, TIMING_WINDOW_MS,
  formatScriptProblem, headlessCostWarning, logText,
} from '../src/workers/scriptDiagnostics';
import { scriptSyntaxError, scriptWarnings } from '../src/utils/scriptCheck';
import { describeWorker, type WorkerStatusInput } from '../src/utils/workerStatus';
import type { SceneNode } from '../src/types/scene';

describe('ScriptProblemLog', () => {
  it('records a mistake once, with when it started and how many steps it failed on', () => {
    const log = new ScriptProblemLog();
    expect(log.note('cart', 'runtime error: undefinedThing is not defined', 0.301)).toBe(true);
    for (let i = 0; i < 699; i++) expect(log.note('cart', 'runtime error: undefinedThing is not defined', 0.302 + i * 0.001)).toBe(false);
    const [p] = log.list();
    expect(p).toMatchObject({ body: 'cart', firstAtTime: 0.301, count: 700 });
    expect(log.warnings()).toEqual([
      "Script on 'cart': runtime error: undefinedThing is not defined (first at t=0.301 s, failed on 700 steps)",
    ]);
  });

  it('counts other problems as times, and says nothing about a count of one', () => {
    expect(formatScriptProblem({ body: 'lift', message: "setActuatorControl: no actuator named 'x'", firstAtTime: 0, count: 3 }))
      .toBe("Script on 'lift': setActuatorControl: no actuator named 'x' (first at t=0.000 s, 3 times)");
    expect(formatScriptProblem({ body: 'lift', message: 'does not compile: Unexpected token', firstAtTime: 0.001, count: 1 }))
      .toBe("Script on 'lift': does not compile: Unexpected token (first at t=0.001 s)");
  });

  it('forgets one body when its script changes, and bumps its version', () => {
    const log = new ScriptProblemLog();
    log.note('a', 'x', 0);
    log.note('b', 'y', 0);
    const v = log.version;
    log.clearBodies(new Set(['a']));
    expect(log.list().map((p) => p.body)).toEqual(['b']);
    expect(log.version).toBeGreaterThan(v);
  });

  it('stops growing past its cap, but still counts', () => {
    const log = new ScriptProblemLog();
    for (let i = 0; i < MAX_SCRIPT_PROBLEMS + 5; i++) log.note('a', `problem ${i}`, 0);
    expect(log.size).toBe(MAX_SCRIPT_PROBLEMS);
    expect(log.overflow).toBe(5);
    expect(log.warnings().at(-1)).toMatch(/5 more/);
  });
});

describe('ScriptLogRing', () => {
  it('keeps the newest lines in order, with how many it dropped', () => {
    const ring = new ScriptLogRing(3);
    for (let i = 0; i < 5; i++) ring.push(i * 0.001, 'cart', [`line ${i}`]);
    expect(ring.entries().map((l) => l.msg)).toEqual(['line 2', 'line 3', 'line 4']);
    expect(ring.entries(2).map((l) => l.msg)).toEqual(['line 3', 'line 4']);
    expect(ring.dropped).toBe(2);
    expect(ring.entries()[0]).toEqual({ t: 0.002, body: 'cart', msg: 'line 2' });
    ring.clear();
    expect(ring.entries()).toEqual([]);
    expect(ring.dropped).toBe(0);
  });

  it('writes objects as JSON and caps a long line', () => {
    expect(logText(['x', 1, { a: [1, 2] }])).toBe('x 1 {"a":[1,2]}');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(logText([cyclic])).toBe('[object Object]');
    expect(logText(['y'.repeat(600)]).length).toBe(501);
  });
});

describe('ScriptTiming', () => {
  it('reports the realtime factor, script cost and the slowest script once a second has passed', () => {
    const t = new ScriptTiming();
    t.tick(0, 0);
    // 100 steps of 4 ms of script each, advancing 0.1 s of sim in 1 s of wall.
    for (let i = 0; i < 100; i++) {
      t.addBody('cart', 3.9);
      t.addBody('pole', 0.1);
      t.addStep(4);
    }
    expect(t.tick(500, 0.05)).toBe(false);
    expect(t.tick(TIMING_WINDOW_MS, 0.1)).toBe(true);
    expect(t.last!.realtimeFactor).toBeCloseTo(0.1, 6);
    expect(t.last!.scriptMsPerStep).toBeCloseTo(4, 6);
    expect(t.last!.scriptShare).toBeCloseTo(0.4, 6);
    expect(t.last!.slowest).toEqual({ body: 'cart', msPerStep: expect.closeTo(3.9, 6) });
  });

  it('starts over after a restart, keeping the last report', () => {
    const t = new ScriptTiming();
    t.tick(0, 0);
    t.addStep(1);
    t.tick(1000, 1);
    const last = t.last;
    t.restart();
    expect(t.tick(5000, 1)).toBe(false); // opens a window rather than counting the pause
    expect(t.last).toBe(last);
  });
});

describe('headlessCostWarning', () => {
  it('warns when scripts dominate and live play could not keep up', () => {
    // 1000 steps, 5 s of wall, 4.5 s of it scripts, 1 ms timestep: 0.2x live.
    const w = headlessCostWarning(1000, 5000, 4500, 0.001, { body: 'cart', msPerStep: 4.4 });
    expect(w).toMatch(/90%/);
    expect(w).toMatch(/4\.50 ms per step/);
    expect(w).toMatch(/'cart'/);
    expect(w).toMatch(/0\.20x real time/);
  });

  it('is quiet for cheap scripts, and for an expensive model with cheap scripts', () => {
    expect(headlessCostWarning(1000, 200, 20, 0.001)).toBeNull();
    expect(headlessCostWarning(1000, 5000, 100, 0.001)).toBeNull();
  });
});

describe('script syntax check on write', () => {
  it('finds a script that will not compile, and passes one that will', () => {
    expect(scriptSyntaxError('api.applyForce([0, 0, 1]')).toBeTruthy();
    expect(scriptSyntaxError('api.applyForce([0, 0, 1]);')).toBeNull();
    expect(scriptSyntaxError('')).toBeNull();
    // Compiles: a runtime error is not a syntax error.
    expect(scriptSyntaxError('undefinedThing();')).toBeNull();
  });

  it('names each broken body at any depth', () => {
    const nodes = [
      { id: 'a', name: 'cart', script: 'if (', children: [{ id: 'b', name: 'pole', script: 'let x = ;', children: [] }] },
      { id: 'c', name: 'ok', script: 'api.getTime();', children: [] },
    ] as unknown as SceneNode[];
    const w = scriptWarnings(nodes);
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/^Script on 'cart' does not compile: /);
    expect(w[1]).toMatch(/^Script on 'pole' does not compile: /);
  });
});

describe('physics_get_state worker script fields', () => {
  const base = (over: Partial<WorkerStatusInput>): WorkerStatusInput => ({
    graph: { nodes: [] }, hasModel: true, builtFrom: { nodes: [] }, builtAt: 0,
    frame: { at: 9990, simTime: 3 }, isPlaying: true, compiling: false, hidden: false, now: 10000, ...over,
  });
  const timing = (rtf: number, share: number) => ({
    scriptMsPerStep: 4, realtimeFactor: rtf, scriptShare: share, slowest: { body: 'cart', msPerStep: 3.9 }, measuredOverMs: 1000,
  });

  it('lists live script problems and says the scripts are failing', () => {
    const s = describeWorker(base({
      scripts: { problems: [{ body: 'cart', message: 'runtime error: x', firstAtTime: 0.3, count: 700 }], moreProblems: 0, timing: null, timestepMs: 1 },
    }));
    expect(s.scriptProblems).toEqual([{ body: 'cart', message: 'runtime error: x', firstAtTime: 0.3, count: 700 }]);
    expect(s.note).toMatch(/scripts are failing/);
  });

  it('blames the scripts when they make play slow', () => {
    const s = describeWorker(base({ scripts: { problems: [], moreProblems: 0, timing: timing(0.1, 0.9), timestepMs: 1 } }));
    expect(s.realtimeFactor).toBe(0.1);
    expect(s.scriptMsPerStep).toBe(4);
    expect(s.slowestScript).toEqual({ body: 'cart', msPerStep: 3.9 });
    expect(s.note).toMatch(/0\.10x real time because of the control scripts/);
    expect(s.note).toMatch(/'cart'/);
  });

  it('blames the model when scripts are cheap, and says nothing at real time or in a hidden tab', () => {
    expect(describeWorker(base({ scripts: { problems: [], moreProblems: 0, timing: timing(0.5, 0.05), timestepMs: 1 } })).note)
      .toMatch(/model itself/);
    expect(describeWorker(base({ scripts: { problems: [], moreProblems: 0, timing: timing(0.98, 0.5), timestepMs: 1 } })).note).toBeUndefined();
    expect(describeWorker(base({ hidden: true, frame: { at: 9990, simTime: 3 }, scripts: { problems: [], moreProblems: 0, timing: timing(0.1, 0.9), timestepMs: 1 } })).note)
      .toBeUndefined();
  });

  it('adds nothing when no scripts reported', () => {
    const s = describeWorker(base({}));
    expect(s).not.toHaveProperty('scriptProblems');
    expect(s).not.toHaveProperty('realtimeFactor');
  });
});
