import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import load_mujoco from '@mujoco/mujoco';
import { indexScadTriangles, type CompiledScad } from '../src/utils/scadMesh';
import { meshPieces, usesCollisionProxies } from '../src/utils/scadColliders';
import { POCKET_SCAD } from '../src/utils/scadLibrary';
import { generateScadForNode, parseScadVariables, replaceVarInCode } from '../src/utils/scadSource';
import { explainCompileError } from '../src/utils/compileErrorContext';
import { scriptSyntaxError } from '../src/utils/scriptCheck';
import { ScriptStateStore } from '../src/utils/scriptState';
import { clearScriptStatus, lastScriptStatus, noteScriptStatus, subscribeScriptStatus } from '../src/store/scriptStatus';
import {
  MAX_SCRIPT_PROBLEMS,
  ScriptLogRing,
  ScriptProblemLog,
  ScriptTiming,
  TIMING_WINDOW_MS,
  headlessCostWarning,
  logText,
} from '../src/workers/scriptDiagnostics';
import { actuatorsByJoint, contactsOfBody, jointViews, raycast, readJoint, type JointInfo, type SensorNames } from '../src/workers/scriptSensors';
import type { SceneGeom, SceneNode } from '../src/types/scene';

// Mock `openscad` for store/hook/UI race tests; the real `openscad` worker pool
// is tested directly via `vi.importActual('../src/utils/openscad')` below.
const mockCompileImpl = vi.fn<(scad: string) => Promise<CompiledScad>>();
vi.mock('../src/utils/openscad', () => ({
  compileSCAD: (scad: string) => mockCompileImpl(scad),
  isCompilerReady: () => true,
  loadCompiler: () => Promise.resolve(),
  setScadCompileListener: () => {},
}));

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null;
    onBreak = null;
    onImpact = null;
    onError = null;
    build() {
      return Promise.resolve({ ok: true });
    }
    setEnv() {}
    setSound() {}
    setPlaying() {}
    resume() {}
    tick() {}
    terminate() {}
    updateScript() {}
    hasPendingWork() {
      return false;
    }
  }
  return { PhysicsWorkerClient };
});

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
let mjModel: InstanceType<Mujoco['MjModel']>;
let mjData: InstanceType<Mujoco['MjData']>;

const SENSOR_XML = `<mujoco>
  <option timestep="0.001"/>
  <worldbody>
    <geom name="floor" type="plane" size="1 1 0.1"/>
    <body name="box" pos="0 0 0.05"><freejoint name="box_free"/><geom name="box_g" type="box" size="0.05 0.05 0.05" mass="1"/></body>
    <body name="arm" pos="0.5 0 0.5"><joint name="arm_h" type="hinge" axis="0 1 0"/><geom name="arm_g" type="sphere" size="0.02" contype="0" conaffinity="0"/></body>
  </worldbody>
</mujoco>`;

function boxCompiled(scale = 1): CompiledScad {
  const s = 0.05 * scale;
  const renderVertices = [
    -s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s,
    -s, -s, s, s, -s, s, s, s, s, -s, s, s,
  ];
  const vertices: number[] = [];
  for (let i = 0; i < renderVertices.length; i += 3) {
    vertices.push(renderVertices[i], renderVertices[i + 2], -renderVertices[i + 1]);
  }
  const faces = [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6,
    1, 2, 6, 1, 6, 5,
    3, 0, 4, 3, 4, 7,
  ];
  return { vertices, faces, renderVertices };
}

function deferred<T>() {
  let resolve!: (val: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeAll(async () => {
  mj = await load_mujoco();
  mjModel = mj.MjModel.from_xml_string(SENSOR_XML);
  mjData = new mj.MjData(mjModel);
  for (let i = 0; i < 200; i++) mj.mj_step(mjModel, mjData);
}, 60_000);

afterAll(() => {
  mjData?.delete();
  mjModel?.delete();
});

// ---------------------------------------------------------------------------
// 1. OpenSCAD worker pool (`src/utils/openscad.ts`)
// ---------------------------------------------------------------------------
describe('openscad worker pool lifecycle & error recovery', () => {
  interface PostedMsg {
    type: string;
    id?: string;
    scad?: string;
  }

  class FakeWorker {
    static instances: FakeWorker[] = [];
    static mode: 'crash-on-load' | 'load-error' | 'ok' = 'ok';
    onmessage: ((evt: MessageEvent) => void) | null = null;
    onerror: ((evt: ErrorEvent) => void) | null = null;
    terminated = false;
    posted: PostedMsg[] = [];

    constructor() {
      FakeWorker.instances.push(this);
    }

    postMessage(msg: PostedMsg) {
      this.posted.push(msg);
      if (msg.type === 'LOAD') {
        queueMicrotask(() => {
          if (this.terminated) return;
          if (FakeWorker.mode === 'crash-on-load') {
            this.onerror?.({} as ErrorEvent);
          } else if (FakeWorker.mode === 'load-error') {
            this.onmessage?.({ data: { type: 'LOAD_ERROR', message: 'WASM HTTP 503' } } as MessageEvent);
          } else {
            this.onmessage?.({ data: { type: 'READY' } } as MessageEvent);
          }
        });
      } else if (msg.type === 'COMPILE') {
        queueMicrotask(() => {
          if (this.terminated || FakeWorker.mode !== 'ok') return;
          const compiled = boxCompiled(1);
          this.onmessage?.({ data: { type: 'COMPILED', id: msg.id, ...compiled } } as MessageEvent);
        });
      }
    }

    terminate() {
      this.terminated = true;
    }
  }

  const prevWorker = (globalThis as Record<string, unknown>).Worker;

  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.mode = 'ok';
    (globalThis as Record<string, unknown>).Worker = FakeWorker;
  });

  afterEach(() => {
    if (prevWorker === undefined) delete (globalThis as Record<string, unknown>).Worker;
    else (globalThis as Record<string, unknown>).Worker = prevWorker;
  });

  it('rejects loadCompiler() on worker crash instead of hanging forever, and succeeds on retry', async () => {
    vi.resetModules();
    const realOpenscad = await vi.importActual<typeof import('../src/utils/openscad')>('../src/utils/openscad');

    FakeWorker.mode = 'crash-on-load';
    await expect(realOpenscad.loadCompiler()).rejects.toThrow(/crashed/i);
    expect(realOpenscad.isCompilerReady()).toBe(false);

    FakeWorker.mode = 'ok';
    await expect(realOpenscad.loadCompiler()).resolves.toBeUndefined();
    expect(realOpenscad.isCompilerReady()).toBe(true);
  });

  it('drains queued jobs beyond MAX_POOL_SIZE on LOAD_ERROR and restores compile counter to zero', async () => {
    vi.resetModules();
    const realOpenscad = await vi.importActual<typeof import('../src/utils/openscad')>('../src/utils/openscad');

    let inFlight = 0;
    realOpenscad.setScadCompileListener((delta) => {
      inFlight += delta;
    });

    FakeWorker.mode = 'load-error';
    const jobs = Array.from({ length: 7 }, (_, i) => realOpenscad.compileSCAD(`cube(${i + 1});`));
    const results = await Promise.allSettled(jobs);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(inFlight).toBe(0);
  });

  it('isolates cached mesh arrays from caller mutation and recycles workers after 4 compiles', async () => {
    vi.resetModules();
    const realOpenscad = await vi.importActual<typeof import('../src/utils/openscad')>('../src/utils/openscad');

    const first = await realOpenscad.compileSCAD('cube(1);');
    const origVertLen = first.vertices.length;
    first.vertices.push(999, 999, 999);
    first.faces.length = 0;

    const cachedHit = await realOpenscad.compileSCAD('cube(1);');
    expect(cachedHit.vertices.length).toBe(origVertLen);
    expect(cachedHit.faces.length).toBe(36);

    // Run 4 distinct compiles so the first worker reaches RECYCLE_AFTER_COMPILES and is retired.
    for (let i = 2; i <= 5; i++) {
      await realOpenscad.compileSCAD(`cube(${i});`);
    }
    expect(FakeWorker.instances.some((w) => w.terminated)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. OpenSCAD STL indexing, proxy colliders, library & source parsing
// ---------------------------------------------------------------------------
describe('scadMesh, scadColliders, scadLibrary, and scadSource fixes', () => {
  it('indexScadTriangles skips non-finite triangles, drops trailing partial coords, and normalizes -0', () => {
    const validTri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const nanTri = [NaN, 0, 0, 1, 0, 0, 0, 1, 0];
    const infTri = [Infinity, 0, 0, 1, 0, 0, 0, 1, 0];
    const trailing = [5, 6]; // incomplete triangle
    const res = indexScadTriangles([...validTri, ...nanTri, ...infTri, ...trailing]);

    expect(res.faces).toEqual([0, 1, 2]);
    expect(res.vertices.every((v) => Number.isFinite(v) && !Object.is(v, -0))).toBe(true);
    expect(res.renderVertices.every((v) => Number.isFinite(v) && !Object.is(v, -0))).toBe(true);
  });

  it('usesCollisionProxies ignores comments and strings mentioning $physbox_collision', () => {
    expect(usesCollisionProxies('// Set $physbox_collision = true to customize\ncube(1);')).toBe(false);
    expect(usesCollisionProxies('/* $physbox_collision */\ncube(1);')).toBe(false);
    expect(usesCollisionProxies('echo("$physbox_collision");\ncube(1);')).toBe(false);
    expect(usesCollisionProxies('if ($physbox_collision) cube(1); else sphere(1);')).toBe(true);
  });

  it('meshPieces welds shared vertices across -0/+0 coordinate planes and ignores invalid face indices', () => {
    // Tetrahedron split across two triangles sharing edge on Y=0 with -0 vs +0 and ±1e-9 noise
    const verts = [
      0, -0, 0,
      1, 0, 0,
      0, 1e-9, 1,
      0, +0, -1e-9,
      1, -1e-9, 0,
      0, 1, 0,
    ];
    const faces = [0, 1, 2, 3, 4, 5, 99, 100, 101];
    const pieces = meshPieces(verts, faces);
    expect(pieces).toHaveLength(1);
    expect(pieces[0].length).toBe(4);
  });

  it('POCKET_SCAD guards overshoot <= 0 against duplicate collar rings and clamps around/rings', () => {
    expect(POCKET_SCAD).toContain('collar = overshoot > 1e-6 ? [[0, overshoot]] : [];');
    expect(POCKET_SCAD).toContain('around_n = max(3, round(around));');
    expect(POCKET_SCAD).toContain('rings_n = max(1, round(rings));');
  });

  it('parseScadVariables and replaceVarInCode handle braces in comments/strings, block comments, scientific notation, and $fn', () => {
    const code = [
      '// Open brace in comment { must not hide sliders!',
      'label = "unbalanced { brace in string";',
      '/*',
      'width = 999;',
      '*/',
      'clearance = 1e-4; // [1e-5:1e-5:1e-3]',
      '$fn = 24; // [8:4:64]',
      'expr = 2 * clearance;',
      'width = 0.5;',
      'width = 1.25; // [0.5:0.25:3.0]',
    ].join('\n');

    const vars = parseScadVariables(code);
    expect(vars.map((v) => v.name)).toEqual(['clearance', '$fn', 'width']);
    expect(vars.find((v) => v.name === 'clearance')?.value).toBeCloseTo(1e-4, 9);
    expect(vars.find((v) => v.name === 'width')?.value).toBe(1.25);

    // Replacing scientific notation must NOT produce `0.0002e-4;`
    const updatedClearance = replaceVarInCode(code, 'clearance', 0.0002);
    expect(updatedClearance).toContain('clearance = 0.0002; // [1e-5:1e-5:1e-3]');
    expect(updatedClearance).not.toContain('0.0002e-4');

    // Replacing `$fn` escapes `$` properly
    const updatedFn = replaceVarInCode(updatedClearance, '$fn', 48);
    expect(updatedFn).toContain('$fn = 48; // [8:4:64]');

    // Replacing `expr` (an expression, not a literal) leaves `2 * clearance;` untouched
    expect(replaceVarInCode(code, 'expr', 10)).toContain('expr = 2 * clearance;');

    // Replacing `width` updates the active (last) top-level assignment, not the commented-out one
    const updatedWidth = replaceVarInCode(code, 'width', 2.5);
    expect(updatedWidth).toContain('width = 999;');
    expect(updatedWidth).toContain('width = 2.5; // [0.5:0.25:3.0]');
  });

  it('generateScadForNode derives cylinder and capsule lengths from fromto when size[1] is omitted', () => {
    const cylNode = {
      id: 'cyl_scad',
      pos: [0, 0, 0],
      geoms: [{ type: 'cylinder', size: [0.05], fromto: [0, 0, 0, 0, 0, 0.8] }],
    } as unknown as SceneNode;
    expect(generateScadForNode(cylNode)).toContain('height = 0.800;');

    const capNode = {
      id: 'cap_scad',
      pos: [0, 0, 0],
      geoms: [{ type: 'capsule', size: [0.03], fromto: [0, 0, -0.3, 0, 0, 0.3] }],
    } as unknown as SceneNode;
    expect(generateScadForNode(capNode)).toContain('height = 0.300;');
  });
});

// ---------------------------------------------------------------------------
// 3. `useCsgCompile.ts` race & empty-mesh guards
// ---------------------------------------------------------------------------
describe('compileCsgNodes SCAD staleness, empty-mesh guard, and boolean ordering', () => {
  it('does not overwrite a newer SCAD source when an older in-flight compile finishes late', async () => {
    const { useStore } = await import('../src/store/useStore');
    const { compileCsgNodes } = await import('../src/hooks/useCsgCompile');

    const slowA = deferred<CompiledScad>();
    mockCompileImpl.mockImplementationOnce(() => slowA.promise);

    useStore.setState({
      sceneGraph: {
        nodes: [{ id: 'part', name: 'part', type: 'body', pos: [0, 0, 0], joints: [], children: [], scad: 'cube(1);', geoms: [] } as unknown as SceneNode],
      },
      recompile: async () => {},
    });

    const pass = compileCsgNodes(true, { colliders: false });
    await new Promise((r) => setTimeout(r, 10));

    // User updates `part` to `sphere(2);` before `cube(1);` resolves
    const newerMesh = boxCompiled(2);
    useStore.getState().updateNodeScad('part', 'sphere(2);', newerMesh, true);

    slowA.resolve(boxCompiled(1));
    await pass;

    const finalNode = useStore.getState().sceneGraph.nodes[0];
    expect(finalNode.scad).toBe('sphere(2);');
    expect(finalNode.geoms[0].renderVertices).toEqual(newerMesh.renderVertices);
  });

  it('marks empty-geometry SCAD output as failed instead of installing an empty mesh or looping', async () => {
    const { useStore } = await import('../src/store/useStore');
    const { compileCsgNodes } = await import('../src/hooks/useCsgCompile');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recompileSpy = vi.fn(async () => {});
    mockCompileImpl.mockResolvedValueOnce({ vertices: [], faces: [], renderVertices: [] });

    useStore.setState({
      sceneGraph: {
        nodes: [{ id: 'empty_part', name: 'empty_part', type: 'body', pos: [0, 0, 0], joints: [], children: [], scad: '// empty degenerate', geoms: [] } as unknown as SceneNode],
      },
      recompile: recompileSpy,
    });

    await compileCsgNodes(false, { colliders: false });
    expect(useStore.getState().sceneGraph.nodes[0].geoms).toEqual([]);
    expect(recompileSpy).not.toHaveBeenCalled();

    // Second pass skips the known-failed empty source without calling compileSCAD again
    mockCompileImpl.mockClear();
    await compileCsgNodes(false, { colliders: false });
    expect(mockCompileImpl).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('evaluates csgEnabled booleans after unbuilt SCAD base meshes land in the same pass', async () => {
    const { useStore } = await import('../src/store/useStore');
    const { compileCsgNodes } = await import('../src/hooks/useCsgCompile');

    mockCompileImpl.mockImplementation(async () => boxCompiled(1));

    const scadBooleanNode: SceneNode = {
      id: 'drilled_scad',
      name: 'drilled_scad',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      scad: 'cube(0.1, center=true);',
      csgEnabled: true,
      collision: 'hull',
      geoms: [
        { id: 'base_m', name: 'base_m', type: 'mesh', dynamic: true, vertices: [], faces: [], renderVertices: [] } as unknown as SceneGeom,
        { id: 'hole', name: 'hole', type: 'cylinder', size: [0.01, 0.1], csg: 'difference' } as SceneGeom,
      ],
    };

    useStore.setState({
      sceneGraph: { nodes: [scadBooleanNode] },
      recompile: async () => {},
    });

    await compileCsgNodes(true, { colliders: false });
    const built = useStore.getState().sceneGraph.nodes[0];
    expect(built.csgHash).toBeTruthy();
    expect(built.geoms.some((g) => !!g.csgDerived)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. `compileErrorContext.ts` edge cases
// ---------------------------------------------------------------------------
describe('explainCompileError edge cases', () => {
  it('handles negative element IDs (id -1), XML entities, regex metacharacters in tendon names, and <mesh> owners', () => {
    const xml = [
      '<mujoco>',
      '  <asset>',
      '    <mesh',
      '      name="cup&amp;lid_mesh"',
      '      vertex="0 0 0"/>',
      '  </asset>',
      '  <worldbody>',
      '    <body name="bob&apos;s (arm)">',
      '      <joint name="j+(1)" type="hinge"/>',
      '      <geom name="cup_g" type="mesh" mesh="cup&amp;lid_mesh"/>',
      '    </body>',
      '  </worldbody>',
      '  <tendon>',
      '    <fixed name="ten+(1)"><joint joint="j+(1)" coef="1"/></fixed>',
      '  </tendon>',
      '</mujoco>',
    ].join('\n');

    // Negative id (-1) + multi-line <mesh> tag + XML entity `&amp;` + body/geom attribution
    const meshErr = explainCompileError(
      "Error: mesh must have at least 4 vertices\nElement name 'cup&lid_mesh', id -1, line 3",
      xml,
    );
    expect(meshErr).toBe(
      "MuJoCo could not build the scene: mesh must have at least 4 vertices, in mesh 'cup&lid_mesh' (geom 'cup_g' on body 'bob's (arm)').",
    );

    // Regex metacharacters in `<fixed>` tendon and joint names must not throw SyntaxError
    const tenErr = explainCompileError(
      "Error: bad tendon limit\nElement name 'ten+(1)', id -1, line 14",
      xml,
    );
    expect(tenErr).toBe(
      "MuJoCo could not build the scene: bad tendon limit, in fixed 'ten+(1)', between hinge joint 'j+(1)' on body 'bob's (arm)'.",
    );
  });
});

// ---------------------------------------------------------------------------
// 5. Custom Scripting Engine (`scriptState`, `scriptDiagnostics`, `scriptSensors`, `scriptStatus`, `scriptCheck`)
// ---------------------------------------------------------------------------
describe('custom scripting engine audit fixes', () => {
  it('ScriptStateStore avoids Object.prototype collisions, isolates per-body snapshot errors, and clones on restore', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = new ScriptStateStore();

    // Prototype keys must start as empty plain objects, never `Object.prototype.constructor`
    const ctorState = store.stateFor('constructor');
    expect(typeof ctorState).toBe('object');
    expect(Object.keys(ctorState)).toEqual([]);
    ctorState.step = 7;
    expect(('step' in Object)).toBe(false);

    // Uncloneable value on one body does not wipe out another body's valid state
    store.stateFor('good_arm').integral = 3.5;
    store.stateFor('bad_cart').helper = () => 42;
    const snap = store.snapshot();
    expect(snap).toEqual({ constructor: { step: 7 }, good_arm: { integral: 3.5 } });
    expect(warn).toHaveBeenCalledTimes(1);

    // Restoring clones the seed so mutating api.state does not mutate the caller's seed
    const seed = { arm: { items: [1, 2] }, invalidArray: [1, 2, 3] as unknown as Record<string, unknown> };
    const restored = new ScriptStateStore();
    restored.restore(seed);
    expect(Object.keys(restored.stateFor('invalidArray'))).toEqual([]);
    (restored.stateFor('arm').items as number[]).push(3);
    expect(seed.arm.items).toEqual([1, 2]);
    warn.mockRestore();
  });

  it('ScriptProblemLog.clearBodies resets stale overflow when problems drop below cap', () => {
    const log = new ScriptProblemLog();
    for (let i = 0; i < MAX_SCRIPT_PROBLEMS + 8; i++) {
      log.note('broken_body', `err_${i}`, 0.01);
    }
    expect(log.overflow).toBe(8);

    log.clearBodies(new Set(['broken_body']));
    expect(log.size).toBe(0);
    expect(log.overflow).toBe(0);
    expect(log.warnings()).toEqual([]);
  });

  it('logText formats Error instances and never throws on null-prototype unserializable objects', () => {
    expect(logText([new Error('motor stalled')])).toBe('Error: motor stalled');

    const nullProtoCyclic = Object.create(null) as Record<string, unknown>;
    nullProtoCyclic.self = nullProtoCyclic;
    expect(() => logText([nullProtoCyclic])).not.toThrow();
    expect(logText([nullProtoCyclic])).toBe('[object Object]');
  });

  it('ScriptLogRing handles zero/negative capacity and entries(last) bounds cleanly', () => {
    const zeroRing = new ScriptLogRing(0);
    zeroRing.push(0.1, 'a', ['hello']);
    expect(zeroRing.entries()).toEqual([]);
    expect(zeroRing.dropped).toBe(1);

    const ring = new ScriptLogRing(3);
    ring.push(0.1, 'a', ['one']);
    ring.push(0.2, 'a', ['two']);
    expect(ring.entries(0)).toEqual([]);
    expect(ring.entries(-2)).toEqual([]);
    expect(ring.entries(1).map((e) => e.msg)).toEqual(['two']);
  });

  it('ScriptTiming restarts window when simTime resets backward and headlessCostWarning clamps >100% share', () => {
    const timing = new ScriptTiming();
    timing.tick(1000, 5.0);
    timing.addStep(2);
    // Sim auto-reset mid-window jumped simTime from 5.0 back to 0.1: must NOT report negative RTF
    expect(timing.tick(2200, 0.1)).toBe(false);
    expect(timing.last).toBeNull();

    timing.addStep(2);
    expect(timing.tick(2200 + TIMING_WINDOW_MS, 1.1)).toBe(true);
    expect(timing.last!.realtimeFactor).toBeCloseTo(1.0, 5);

    const w = headlessCostWarning(100, 500, 520, 0.001);
    expect(w).toContain('100%');
    expect(headlessCostWarning(100, 500, 400, 0)).toBeNull();
  });

  it('raycast rejects non-finite origin/dir and returns null on NaN/negative maxDist; readJoint avoids -0', () => {
    const names: SensorNames = {
      geomName: (g) => mj.mj_id2name(mjModel, mj.mjtObj.mjOBJ_GEOM.value, g) || `geom_${g}`,
      bodyNode: (b) => (b === 0 ? 'world' : mj.mj_id2name(mjModel, mj.mjtObj.mjOBJ_BODY.value, b) || `body_${b}`),
    };

    expect(() => raycast(mj, mjModel, mjData, [NaN, 0, 1], [0, 0, -1], 10, -1, names)).toThrow(/finite/);
    expect(() => raycast(mj, mjModel, mjData, [0, 0, 1], [Infinity, 0, 0], 10, -1, names)).toThrow(/non-zero/);
    expect(raycast(mj, mjModel, mjData, [0, 0, 1], [0, 0, -1], NaN, -1, names)).toBeNull();
    expect(raycast(mj, mjModel, mjData, [0, 0, 1], [0, 0, -1], -5, -1, names)).toBeNull();

    // Valid hit still works and contactsOfBody guards negative body IDs
    const hit = raycast(mj, mjModel, mjData, [0, 0, 1], [0, 0, -1], 10, NaN, names);
    expect(hit?.geom).toBe('box_g');
    expect(contactsOfBody(mj, mjModel, mjData, 0, names).length).toBeGreaterThan(0);

    const armId = mj.mj_name2id(mjModel, mj.mjtObj.mjOBJ_JOINT.value, 'arm_h');
    const jInfo: JointInfo = {
      name: 'arm_h',
      id: armId,
      type: mjModel.jnt_type[armId],
      qposadr: mjModel.jnt_qposadr[armId],
      dofadr: mjModel.jnt_dofadr[armId],
      body: 'arm',
      actuators: actuatorsByJoint(mj, mjModel).get(armId) ?? [],
      drive: { dofadr: mjModel.jnt_dofadr[armId], actuators: [] },
    };
    const telemetry = readJoint(jInfo, jointViews(mjData));
    expect(Object.is(telemetry.clutchTorque, -0)).toBe(false);
  });

  it('clearScriptStatus removes a single body problems and notifies subscribers', () => {
    let notifications = 0;
    const unsub = subscribeScriptStatus(() => {
      notifications++;
    });

    noteScriptStatus({
      problems: [
        { body: 'cart', message: 'runtime error: x is not defined', firstAtTime: 0.1, count: 5 },
        { body: 'pole', message: 'runtime error: y is not defined', firstAtTime: 0.2, count: 2 },
      ],
      moreProblems: 3,
      timing: null,
      timestepMs: 1,
    });
    expect(notifications).toBe(1);

    clearScriptStatus('cart');
    expect(lastScriptStatus()?.problems.map((p) => p.body)).toEqual(['pole']);
    expect(lastScriptStatus()?.moreProblems).toBe(3);

    clearScriptStatus('pole');
    expect(lastScriptStatus()?.problems).toEqual([]);
    expect(lastScriptStatus()?.moreProblems).toBe(0);

    clearScriptStatus();
    expect(lastScriptStatus()).toBeNull();
    unsub();
  });

  it('scriptSyntaxError handles non-string and whitespace inputs safely', () => {
    expect(scriptSyntaxError(undefined)).toBeNull();
    expect(scriptSyntaxError(null)).toBeNull();
    expect(scriptSyntaxError('   \n\t  ')).toBeNull();
    expect(scriptSyntaxError('const x = ;')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 6. UI cards (`ScadEditorCard`, `ScriptEditorCard`, `CompileErrorBanner`)
// ---------------------------------------------------------------------------
describe('ScadEditorCard, ScriptEditorCard, and CompileErrorBanner UI behavior', () => {
  let domWindow: Window & typeof globalThis;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    const jsdomMod = (await import('jsdom' as string)) as {
      JSDOM: new (html?: string) => { window: Window & typeof globalThis };
    };
    const dom = new jsdomMod.JSDOM('<!doctype html><html><body></body></html>');
    domWindow = dom.window;
    const g = globalThis as Record<string, unknown>;
    g.window = domWindow;
    g.document = domWindow.document;
    g.HTMLElement = domWindow.HTMLElement;
    g.HTMLInputElement = domWindow.HTMLInputElement;
    g.HTMLTextAreaElement = domWindow.HTMLTextAreaElement;
    g.HTMLSelectElement = domWindow.HTMLSelectElement;
    g.Event = domWindow.Event;
    g.MouseEvent = domWindow.MouseEvent;
    g.IS_REACT_ACT_ENVIRONMENT = true;
    container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    root = createRoot(container);
    clearScriptStatus();
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    const g = globalThis as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.HTMLElement;
    delete g.HTMLInputElement;
    delete g.HTMLTextAreaElement;
    delete g.HTMLSelectElement;
    delete g.Event;
    delete g.MouseEvent;
    delete g.IS_REACT_ACT_ENVIRONMENT;
  });

  it('CompileErrorBanner renders an alert banner only when lastCompileError is non-null', async () => {
    const { useStore } = await import('../src/store/useStore');
    const { CompileErrorBanner } = await import('../src/components/CompileErrorBanner');

    useStore.setState({ lastCompileError: null });
    await act(async () => {
      root.render(React.createElement(CompileErrorBanner));
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(async () => {
      useStore.setState({ lastCompileError: 'MuJoCo could not build the scene: bad joint' });
    });
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.textContent).toContain('bad joint');
  });

  it('ScriptEditorCard shows Disabled for whitespace-only script, surfaces stored syntax & live runtime errors, and clears stale errors on save', async () => {
    const { useStore } = await import('../src/store/useStore');
    const scriptStatusMod = await import('../src/store/scriptStatus');
    const { ScriptEditorCard } = await import('../src/components/inspector/ScriptEditorCard');

    const updateSpy = vi.fn();
    useStore.setState({ updateNodeScript: updateSpy });

    // 1. Whitespace-only script shows Disabled, not Active
    const blankNode = { id: 'cart', name: 'cart', type: 'body', pos: [0, 0, 0], script: '   \n  ', geoms: [], joints: [], children: [] } as unknown as SceneNode;
    await act(async () => {
      root.render(React.createElement(ScriptEditorCard, { node: blankNode }));
    });
    expect(container.textContent).toContain('Disabled');
    expect(container.textContent).not.toContain('Active');

    // 2. Node arriving with broken syntax from MCP immediately shows Error badge and message
    const brokenSyntaxNode = { ...blankNode, script: 'if (' } as SceneNode;
    await act(async () => {
      root.render(React.createElement(ScriptEditorCard, { node: brokenSyntaxNode }));
    });
    expect(container.textContent).toContain('Error');
    expect(container.textContent).toContain('⚠️ Error:');

    // 3. Valid syntax node with live runtime problem in scriptStatus shows runtime error, and saving clears it
    const validNode = { ...blankNode, script: 'api.applyForce([1, 0, 0]);' } as SceneNode;
    await act(async () => {
      scriptStatusMod.noteScriptStatus({
        problems: [{ body: 'cart', message: 'runtime error: oops', firstAtTime: 0.2, count: 4 }],
        moreProblems: 0,
        timing: null,
        timestepMs: 1,
      });
      root.render(React.createElement(ScriptEditorCard, { node: validNode }));
    });
    expect(container.textContent).toContain('runtime error: oops');

    const saveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Save & Execute'))!;
    await act(async () => {
      saveBtn.click();
    });
    expect(updateSpy).toHaveBeenCalledWith('cart', 'api.applyForce([1, 0, 0]);');
    expect(scriptStatusMod.lastScriptStatus()?.problems).toEqual([]);
  });

  it('ScadEditorCard discards superseded in-flight compiles when external Undo updates node.scad', async () => {
    const { useStore } = await import('../src/store/useStore');
    const { ScadEditorCard } = await import('../src/components/inspector/ScadEditorCard');

    const slowCompile = deferred<CompiledScad>();
    mockCompileImpl.mockImplementationOnce(() => slowCompile.promise);

    const updateScadSpy = vi.fn();
    const initialNode = {
      id: 'scad_box',
      name: 'scad_box',
      type: 'body',
      pos: [0, 0, 0],
      scad: 'size = 1;\ncube(size);',
      geoms: [],
      joints: [],
      children: [],
    } as unknown as SceneNode;
    useStore.setState({
      sceneGraph: { nodes: [initialNode] },
      updateNodeScad: updateScadSpy,
    });

    await act(async () => {
      root.render(React.createElement(ScadEditorCard, { node: initialNode }));
    });

    const compileBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('Compile & Update'))!;
    await act(async () => {
      compileBtn.click();
    });
    expect(container.textContent).toContain('Compiling...');

    // Simulate an Undo changing `node.scad` externally before `slowCompile` finishes
    const undoneNode = { ...initialNode, scad: 'size = 0.5;\ncube(size);' } as SceneNode;
    useStore.setState({ sceneGraph: { nodes: [undoneNode] } });
    await act(async () => {
      root.render(React.createElement(ScadEditorCard, { node: undoneNode }));
    });

    // Now the stale compile resolves — it must be ignored and never overwrite Undo
    await act(async () => {
      slowCompile.resolve(boxCompiled(1));
      await Promise.resolve();
    });
    expect(updateScadSpy).not.toHaveBeenCalled();
    expect(container.querySelector('textarea')?.value).toBe('size = 0.5;\ncube(size);');
  });
});
