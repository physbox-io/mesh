// Two bodies with one id.
//
// Reported: names were made unique (utils/uniqueNames) but ids were not, so
// the scene summary, get_object and a headless run's report, which all find a
// body by id, answered for whichever came first and mixed the two up. Ids now
// follow the name rule, in the store's set middleware and in the compiler;
// physics_build_scene / physics_update_scene rename them before the bodies
// are filled in, and say so.

import { describe, it, expect, vi, beforeAll } from 'vitest';

const g = globalThis as Record<string, unknown>;
g.window = g;
g.document = { visibilityState: 'hidden' };
g.alert = () => {};
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

vi.mock('../src/store/physicsWorkerClient', () => {
  class PhysicsWorkerClient {
    meshFiles = undefined;
    onFrame = null; onBreak = null; onImpact = null; onError = null;
    build() { return Promise.resolve({ ok: true }); }
    setEnv() {} setPlaying() {} resume() {} tick() {} terminate() {}
    hasPendingWork() { return false; }
  }
  return { PhysicsWorkerClient };
});

import { withUniqueNames, uniquifyNamesInPlace, withUniqueRawIds } from '../src/utils/uniqueNames';
import { resolveBodyFilter } from '../src/utils/headlessReport';
import { fillBodyDefaults, pendingDeclarativeOps } from '../src/hooks/mcp/bodyDefaults';
import type { SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
let useStore: any;
beforeAll(async () => { ({ useStore } = await import('../src/store/useStore')); });

const body = (id: string, name: string, children: SceneNode[] = []): SceneNode =>
  ({ id, name, pos: [0, 0, 0.1], joints: [], children, geoms: [{ name: `${name}_g`, type: 'box', size: [0.01, 0.01, 0.01] }] }) as unknown as SceneNode;

const ids = (nodes: SceneNode[]): string[] => nodes.flatMap((n) => [n.id, ...ids(n.children || [])]);

describe('body ids are unique', () => {
  it('the later of a clash is numbered, at any depth, and the first keeps its id', () => {
    const scene = { nodes: [body('crate', 'a'), body('crate', 'b', [body('crate', 'c')]), body('crate_2', 'd')] } as SceneGraph;
    expect(ids(withUniqueNames(scene).nodes)).toEqual(['crate', 'crate_3', 'crate_4', 'crate_2']);
  });

  it('the compiler and the store agree', () => {
    const make = () => [body('x', 'a'), body('x', 'b', [body('x', 'c')])];
    const inPlace = make();
    uniquifyNamesInPlace(inPlace);
    expect(ids(inPlace)).toEqual(ids(withUniqueNames({ nodes: make() } as SceneGraph).nodes));
  });

  it('leaves a scene with no clash as it was', () => {
    const scene = { nodes: [body('a', 'a'), body('b', 'b')] } as SceneGraph;
    expect(withUniqueNames(scene)).toBe(scene);
  });

  it('the store never holds two bodies with one id, so a lookup by id is unambiguous', () => {
    useStore.getState().updateScene({ nodes: [body('crate', 'left'), body('crate', 'right')] }, true);
    const nodes: SceneNode[] = useStore.getState().sceneGraph.nodes;
    expect(ids(nodes)).toEqual(['crate', 'crate_2']);
    // What physics_run_headless's `bodies` filter (and get_object) resolve against.
    expect([...resolveBodyFilter({ nodes }, ['crate']).ids!]).toEqual(['crate']);
    expect([...resolveBodyFilter({ nodes }, ['crate_2']).ids!]).toEqual(['crate_2']);
    expect(nodes.find((n) => n.id === 'crate_2')!.name).toBe('right');
  });
});

describe('build_scene with two bodies of one name and no ids', () => {
  it('gives them two ids before they are filled in, so their queued ops stay their own', () => {
    pendingDeclarativeOps.clear();
    const raw = [
      { name: 'panel', geoms: [{ type: 'box', size: [0.05, 0.05, 0.005] }], cuts: [{ shape: 'cylinder', at: [0, 0, 0], diameterMm: 4 }] },
      { name: 'panel', geoms: [{ type: 'box', size: [0.05, 0.05, 0.005] }], paint: [{ at: [0, 0, 0], rgba: [1, 0, 0] }] },
    ];
    const { bodies, renamed } = withUniqueRawIds(raw as any[]);
    expect(renamed).toEqual([{ from: 'panel', to: 'panel_2' }]);
    const nodes = bodies.map((b) => fillBodyDefaults(b));
    expect(nodes.map((n) => n.id)).toEqual(['panel', 'panel_2']);
    expect(pendingDeclarativeOps.get('panel')?.cuts).toHaveLength(1);
    expect(pendingDeclarativeOps.get('panel')?.paint).toBeUndefined();
    expect(pendingDeclarativeOps.get('panel_2')?.paint).toHaveLength(1);
    pendingDeclarativeOps.clear();
  });

  it('renames a clashing child id too, and returns the same array when nothing clashes', () => {
    const raw = [{ id: 'arm', children: [{ id: 'arm' }] }];
    const { bodies, renamed } = withUniqueRawIds(raw);
    expect(bodies[0].children![0].id).toBe('arm_2');
    expect(raw[0].children[0].id).toBe('arm'); // not written into
    expect(renamed).toEqual([{ from: 'arm', to: 'arm_2' }]);
    const clean = [{ id: 'a' }, { id: 'b' }];
    expect(withUniqueRawIds(clean).bodies).toBe(clean);
  });
});
