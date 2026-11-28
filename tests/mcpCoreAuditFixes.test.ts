import { describe, it, expect, beforeEach, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => {
  (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 };
});

import {
  isReadOnlyCommand,
  shouldSerializeCommand,
  runGuardedCommand,
} from '../src/hooks/useMCPBridge';
import { findNodeInScene, resolveParent } from '../src/hooks/mcp/bridgeUtils';
import {
  normalizeRgba,
  fillBodyDefaults,
  resolveUpdatedGeoms,
  pendingDeclarativeOps,
} from '../src/hooks/mcp/bodyDefaults';
import { applySingleCutToBody, applyPaintStrokeToBody } from '../src/hooks/mcp/bodyFeatures';
import { sceneCommands } from '../src/hooks/mcp/sceneCommands';
import { objectCommands } from '../src/hooks/mcp/objectCommands';
import { profileCommands } from '../src/hooks/mcp/profileCommands';
import { useStore } from '../src/store/useStore';
import type { SceneNode } from '../src/types/scene';

function makeBoxNode(id: string, name = id, extra: Partial<SceneNode> = {}): SceneNode {
  return {
    id,
    name,
    type: 'body',
    pos: [0, 0, 0.05],
    geoms: [{ name: `${id}_geom`, type: 'box', size: [0.05, 0.05, 0.05], rgba: [0.5, 0.5, 0.8, 1] }],
    joints: [{ name: `${id}_free`, type: 'free' }],
    children: [],
    ...extra,
  };
}

function makeCtx() {
  const store = useStore.getState();
  const toId = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    const byId = (nodes: SceneNode[] = []): boolean =>
      nodes.some((n) => n.id === v || byId(n.children));
    if (byId(store.sceneGraph.nodes)) return v;
    return findNodeInScene(store.sceneGraph.nodes, v)?.id ?? v;
  };
  return { store, toId };
}

beforeEach(() => {
  pendingDeclarativeOps.clear();
  useStore.setState({
    sceneGraph: { nodes: [] },
    lastCompileError: null,
    castPrepBlocked: 0,
    castPrepGuardOpen: false,
    brokenConstraints: [],
    shatteredBodies: {},
    visibleShatteredBodies: {},
    deformedGeoms: {},
    lastBreak: null,
    lastShatter: null,
    activePreset: 'pendulum',
    recompile: vi.fn().mockResolvedValue(undefined),
  });
});

describe('H2: command classification, serialization & castPrepBlocked race', () => {
  it('classifies read-only vs mutating commands properly', () => {
    for (const cmd of [
      'GET_STATE', 'GET_SCENE', 'LIST_COMMANDS', 'CHECK_DFM',
      'EXPORT_STL', 'SCREENSHOT', 'MEASURE', 'SECTION',
      'VALIDATE_SCAD', 'PROBE_SCULPT', 'RUN_HEADLESS',
    ]) {
      expect(isReadOnlyCommand(cmd)).toBe(true);
      expect(shouldSerializeCommand(cmd)).toBe(false);
    }
    for (const cmd of [
      'CREATE_SCULPT', 'CREATE_LATTICE', 'SCULPT', 'ADD_OBJECT', 'UPDATE_OBJECT', 'BUILD_SCENE',
    ]) {
      expect(isReadOnlyCommand(cmd)).toBe(false);
      expect(shouldSerializeCommand(cmd)).toBe(true);
    }
  });

  it('never fails a read-only command when castPrepBlocked increments concurrently', async () => {
    const res = await runGuardedCommand('GET_STATE', async () => {
      // Simulate another concurrent edit tripping the cast-prep guard mid-flight.
      useStore.setState({ castPrepBlocked: useStore.getState().castPrepBlocked + 1 });
      return { ok: true, time: 1.5 };
    });
    expect(res).toEqual({ ok: true, time: 1.5 });
  });

  it('fails a mutating command when castPrepBlocked increments and serializes concurrent mutations', async () => {
    const order: string[] = [];
    const p1 = runGuardedCommand('CREATE_SCULPT', async () => {
      order.push('start-1');
      await new Promise((r) => setTimeout(r, 25));
      order.push('end-1');
      return { ok: true, n: 1 };
    });
    const p2 = runGuardedCommand('CREATE_LATTICE', async () => {
      order.push('start-2');
      useStore.setState({ castPrepBlocked: useStore.getState().castPrepBlocked + 1 });
      order.push('end-2');
      return { ok: true, n: 2 };
    });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(order).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    expect(r1).toEqual({ ok: true, n: 1 });
    expect((r2 as { ok: boolean; error: string }).ok).toBe(false);
    expect((r2 as { ok: boolean; error: string }).error).toContain('prepared for casting');
  });
});

describe('H3: pendingDeclarativeOps cleanup & ADD_OBJECT child ID deduplication', () => {
  it('cleans up pendingDeclarativeOps when fillBodyDefaults throws on a later child', () => {
    expect(() =>
      fillBodyDefaults({
        id: 'parent_body',
        cuts: [{ shape: 'hole', diameterMm: 5 }],
        geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }],
        children: [
          { id: 'ok_child', cuts: [{ shape: 'hole', diameterMm: 3 }], geoms: [{ type: 'box', size: [0.02, 0.02, 0.02] }] },
          { id: 'bad_child', joints: [{ type: 'free' }], geoms: [{ type: 'box', size: [0.02, 0.02, 0.02] }] },
        ],
      } as never),
    ).toThrow(/free joint/);
    expect(pendingDeclarativeOps.size).toBe(0);
  });

  it('deduplicates colliding child IDs in ADD_OBJECT before fillBodyDefaults runs', async () => {
    const existingSub = makeBoxNode('sub', 'sub');
    useStore.setState({ sceneGraph: { nodes: [existingSub] } });

    const res = await objectCommands.ADD_OBJECT(
      {
        body: {
          id: 'parent',
          geoms: [{ type: 'box', size: [50, 50, 50] }],
          children: [
            { id: 'sub', geoms: [{ type: 'box', size: [20, 20, 20] }] },
          ],
        },
      },
      makeCtx(),
    ) as { ok: boolean; id: string };

    expect(res.ok).toBe(true);
    const parent = findNodeInScene(useStore.getState().sceneGraph.nodes, 'parent');
    expect(parent?.children[0].id).toBe('sub_2');
    expect(pendingDeclarativeOps.size).toBe(0);
  });
});

describe('H4: UPDATE_OBJECT skips redundant recompiles', () => {
  it('calls updateNode with skipRecompile=true and awaits a single recompile', async () => {
    const box = makeBoxNode('box1');
    const recompile = vi.fn().mockResolvedValue(undefined);
    useStore.setState({ sceneGraph: { nodes: [box] }, recompile });

    const res = await objectCommands.UPDATE_OBJECT(
      { targetId: 'box1', updates: { name: 'renamed_box' } },
      makeCtx(),
    ) as { ok: boolean };

    expect(res.ok).toBe(true);
    expect(recompile).toHaveBeenCalledTimes(1);
    expect(findNodeInScene(useStore.getState().sceneGraph.nodes, 'box1')?.name).toBe('renamed_box');
  });
});

describe('H5 & H6: prototype-chain Object.hasOwn, exact-id precedence, ADD_HARDWARE toId', () => {
  it('prefers exact id match across the tree over earlier name match in findNodeInScene and resolveParent', () => {
    const first = makeBoxNode('id_a', 'id_b');
    const second = makeBoxNode('id_b', 'other_name');
    const nodes = [first, second];
    expect(findNodeInScene(nodes, 'id_b')?.id).toBe('id_b');
    expect(resolveParent(nodes, 'id_b')?.id).toBe('id_b');
  });

  it('rejects Object.prototype keys in BODY_CUT and ADD_HARDWARE', async () => {
    const box = makeBoxNode('box1');
    useStore.setState({ sceneGraph: { nodes: [box] } });

    const cutProto = applySingleCutToBody('box1', { shape: 'constructor' });
    expect(cutProto.ok).toBe(false);
    expect(cutProto.error).toContain('Unknown cut shape');

    const hwProto = await objectCommands.ADD_HARDWARE({ kind: 'constructor' }, makeCtx()) as { ok: boolean; error: string };
    expect(hwProto.ok).toBe(false);
    expect(hwProto.error).toContain('kind must be one of');

    const hwToString = await objectCommands.ADD_HARDWARE({ kind: 'toString' }, makeCtx()) as { ok: boolean };
    expect(hwToString.ok).toBe(false);
  });

  it('validates at and lengthMm and resolves into by body name in ADD_HARDWARE', async () => {
    const box = makeBoxNode('frame_id', 'MyFrame');
    useStore.setState({ sceneGraph: { nodes: [box] } });

    const badAt = await objectCommands.ADD_HARDWARE({ kind: 'screw', at: [NaN, 0, 0] }, makeCtx()) as { ok: boolean; error: string };
    expect(badAt.ok).toBe(false);
    expect(badAt.error).toContain('at must be');

    const badLen = await objectCommands.ADD_HARDWARE({ kind: 'screw', lengthMm: -5 }, makeCtx()) as { ok: boolean; error: string };
    expect(badLen.ok).toBe(false);
    expect(badLen.error).toContain('lengthMm');

    const spyAdd = vi.fn().mockReturnValue(null);
    useStore.setState({ addHardwarePart: spyAdd });
    await objectCommands.ADD_HARDWARE({ kind: 'screw', into: 'MyFrame', at: [10, 20, 30] }, makeCtx());
    // Must receive resolved id 'frame_id', NOT raw name 'MyFrame'
    expect(spyAdd).toHaveBeenCalledWith('screw', [0.01, 0.02, 0.03], 'frame_id', { exact: true, mount: true });
  });
});

describe('H7: SET_ENVIRONMENT validation and atomic failure', () => {
  it('rejects invalid numeric/range/enum inputs without partial store mutation', async () => {
    const stockBefore = { ...useStore.getState().stock };
    const fidelityBefore = useStore.getState().sceneGraph.simFidelity;

    // Valid stock & fidelity paired with invalid background must NOT mutate stock or fidelity
    const res = await sceneCommands.SET_ENVIRONMENT(
      { stockWidthMm: 500, fidelity: 'print', background: 'not_a_bg' },
      makeCtx(),
    ) as { ok: boolean; error: string };
    expect(res.ok).toBe(false);
    expect(useStore.getState().stock).toEqual(stockBefore);
    expect(useStore.getState().sceneGraph.simFidelity).toBe(fidelityBefore);

    for (const bad of [
      { gravityZ: NaN },
      { windX: Infinity },
      { density: -1 },
      { floorFriction: -0.5 },
      { floorBounce: 1.5 },
      { floorBounce: -0.1 },
      { waterLevel: NaN },
      { waterLevel: 'high' },
      { stockWidthMm: 0 },
      { stockDepthMm: Infinity },
      { sound: 'yes' },
    ]) {
      const r = await sceneCommands.SET_ENVIRONMENT(bad, makeCtx()) as { ok: boolean };
      expect(r.ok).toBe(false);
    }
  });
});

describe('H8: normalizeRgba, SET_COLOR, and PAINT validation', () => {
  it('rejects NaN, Infinity, non-numbers, and out-of-range values in normalizeRgba', () => {
    expect(normalizeRgba([0.2, 0.4, 0.6])).toEqual([0.2, 0.4, 0.6, 1]);
    expect(normalizeRgba([0.2, 0.4, 0.6, 0.5])).toEqual([0.2, 0.4, 0.6, 0.5]);
    expect(normalizeRgba([1, 0, 0, NaN])).toBeUndefined();
    expect(normalizeRgba([Infinity, 0, 0])).toBeUndefined();
    expect(normalizeRgba([-0.1, 0, 0])).toBeUndefined();
    expect(normalizeRgba([1.2, 0, 0])).toBeUndefined();
    expect(normalizeRgba(['1', '0', '0'])).toBeUndefined();
    expect(normalizeRgba([1, 0])).toBeUndefined();
  });

  it('validates rgba in SET_COLOR and preserves garment alpha for 3-element rgba', async () => {
    const garmentNode: SceneNode = {
      id: 'shirt',
      name: 'shirt',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [],
      joints: [],
      children: [],
      cloth: {
        garment: { pattern: 'tshirt', rgba: [0.1, 0.2, 0.3, 0.4] },
      } as never,
    };
    useStore.setState({ sceneGraph: { nodes: [garmentNode] } });

    await expect(objectCommands.SET_COLOR({ targetId: 'shirt', rgba: [1, 0, NaN] }, makeCtx())).rejects.toThrow(/rgba/);

    const ok = await objectCommands.SET_COLOR({ targetId: 'shirt', rgba: [0.8, 0.2, 0.1] }, makeCtx()) as { ok: boolean };
    expect(ok.ok).toBe(true);
    const updated = findNodeInScene(useStore.getState().sceneGraph.nodes, 'shirt');
    expect(updated?.cloth?.garment?.rgba).toEqual([0.8, 0.2, 0.1, 0.4]);
  });

  it('rejects empty strokes and invalid radius/flow/hardness/rgba/at in PAINT', async () => {
    const box = makeBoxNode('box1');
    useStore.setState({ sceneGraph: { nodes: [box] } });

    const empty = await objectCommands.PAINT({ targetId: 'box1', strokes: [] }, makeCtx()) as { ok: boolean };
    expect(empty.ok).toBe(false);

    expect(() => applyPaintStrokeToBody('box1', { rgba: [1, 0, 0], at: [0, 0, 0.05], radius: -0.01 })).toThrow(/radius/);
    expect(() => applyPaintStrokeToBody('box1', { rgba: [1, 0, 0], at: [0, 0, 0.05], radius: 0 })).toThrow(/radius/);
    expect(() => applyPaintStrokeToBody('box1', { rgba: [1, 0, 0], at: [0, 0, 0.05], flow: NaN })).toThrow(/flow/);
    expect(() => applyPaintStrokeToBody('box1', { rgba: [1, 0, 0], at: [0, 0, 0.05], hardness: 2 })).toThrow(/hardness/);
    expect(() => applyPaintStrokeToBody('box1', { rgba: [1, 0, NaN], at: [0, 0, 0.05] })).toThrow(/rgba/);
    expect(() => applyPaintStrokeToBody('box1', { rgba: [1, 0, 0], at: [0, NaN, 0.05] })).toThrow(/at must be/);
  });
});

describe('H9, M1, M5: BODY_CUT, COMBINE_BODIES, APPLY_PATTERN, KNIFE, IMPORT_STL validation', () => {
  it('rejects unknown cut shapes, non-finite dims, and rolls back failed cut batches', async () => {
    const box = makeBoxNode('box1');
    useStore.setState({ sceneGraph: { nodes: [box] } });

    expect(applySingleCutToBody('box1', { shape: 'dovetail' }).ok).toBe(false);
    expect(applySingleCutToBody('box1', { shape: 'hole', diameterMm: NaN }).ok).toBe(false);
    expect(applySingleCutToBody('box1', { shape: 'hole', depthMm: -5 }).ok).toBe(false);
    expect(applySingleCutToBody('box1', { shape: 'hole', normal: [0, 0, 0] }).ok).toBe(false);
    expect(applySingleCutToBody('box1', { shape: 'hole', at: [1, 2] }).ok).toBe(false);
    expect(applySingleCutToBody('box1', { shape: 'pocket', widthMm: Infinity, lengthMm: 10, depthMm: 5 }).ok).toBe(false);

    // Hardware cut with invalid size leaves no geom behind
    const badHw = applySingleCutToBody('box1', { shape: 'counterbore', size: 'M999' });
    expect(badHw.ok).toBe(false);
    expect(findNodeInScene(useStore.getState().sceneGraph.nodes, 'box1')?.geoms).toHaveLength(1);

    // Batch cut rollback: 1st valid cut + 2nd invalid cut must restore original geoms
    const batchRes = await objectCommands.BODY_CUT(
      {
        targetId: 'box1',
        cuts: [
          { shape: 'hole', diameterMm: 5, at: [0, 0, 50], normal: [0, 0, 1] },
          { shape: 'bogus_shape' },
        ],
      },
      makeCtx(),
    ) as { ok: boolean };
    expect(batchRes.ok).toBe(false);
    expect(findNodeInScene(useStore.getState().sceneGraph.nodes, 'box1')?.geoms).toHaveLength(1);
  });

  it('rejects unknown op, self-combine, and ancestor-into-descendant in COMBINE_BODIES', async () => {
    const child = makeBoxNode('child1', 'child1', { joints: [] });
    const parent = makeBoxNode('parent1', 'parent1', { children: [child] });
    useStore.setState({ sceneGraph: { nodes: [parent] } });

    const badOp = await objectCommands.COMBINE_BODIES({ targetId: 'parent1', withIds: ['child1'], op: 'xor' }, makeCtx()) as { ok: boolean };
    expect(badOp.ok).toBe(false);

    const selfCombine = await objectCommands.COMBINE_BODIES({ targetId: 'parent1', withIds: ['parent1'], op: 'union' }, makeCtx()) as { ok: boolean; error: string };
    expect(selfCombine.ok).toBe(false);
    expect(selfCombine.error).toContain('itself');

    const ancCombine = await objectCommands.COMBINE_BODIES({ targetId: 'child1', withIds: ['parent1'], op: 'union' }, makeCtx()) as { ok: boolean; error: string };
    expect(ancCombine.ok).toBe(false);
    expect(ancCombine.error).toContain('ancestor');
  });

  it('handles non-array at safely in APPLY_PATTERN and KNIFE without TypeError', async () => {
    const box = makeBoxNode('box1');
    useStore.setState({ sceneGraph: { nodes: [box] } });

    const patRes = await objectCommands.APPLY_PATTERN({ targetId: 'box1', at: 123, pattern: 'knurl' }, makeCtx()) as { ok: boolean; error: string };
    expect(patRes.ok).toBe(false);
    expect(patRes.error).toContain('at');

    const knifeRes = await objectCommands.KNIFE({ targetId: 'box1', at: 123, normal: [0, 0, 1] }, makeCtx()) as { ok: boolean; error: string };
    expect(knifeRes.ok).toBe(false);
    expect(knifeRes.error).toContain('at');

    const knifeZeroNormal = await objectCommands.KNIFE({ targetId: 'box1', at: [0, 0, 0], normal: [0, 0, 0] }, makeCtx()) as { ok: boolean; error: string };
    expect(knifeZeroNormal.ok).toBe(false);
    expect(knifeZeroNormal.error).toContain('normal');
  });

  it('validates stlData, importMode, scale, and pos in IMPORT_STL', async () => {
    const asciiStl = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid t';
    expect(((await sceneCommands.IMPORT_STL({ stlData: 12345 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.IMPORT_STL({ stlData: asciiStl, importMode: 'bogus' }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.IMPORT_STL({ stlData: asciiStl, scale: 0 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.IMPORT_STL({ stlData: asciiStl, scale: [1, -1, 1] }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.IMPORT_STL({ stlData: asciiStl, pos: [0, NaN, 0] }, makeCtx())) as { ok: boolean }).ok).toBe(false);
  });
});

describe('H10, H11, M2–M8, L2: scene/object/profile/preset/constraint validation & cleanup', () => {
  it('resolves break fields recursively, clears runtime breakage & activePreset in BUILD_SCENE', async () => {
    useStore.setState({
      shatteredBodies: { old: [makeBoxNode('old_shard')] },
      brokenConstraints: ['weld:old'],
      activePreset: 'pendulum',
    });

    // Invalid joinMaterial on child body must fail cleanly
    const bad = await sceneCommands.BUILD_SCENE(
      {
        bodies: [{
          id: 'root',
          geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }],
          children: [{ id: 'child', joinMaterial: 'unobtainium', geoms: [{ type: 'box', size: [0.02, 0.02, 0.02] }] }],
        }],
      },
      makeCtx(),
    ) as { ok: boolean; error: string };
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('joinMaterial');

    // Non-object entry and excessive segments rejected cleanly
    const badEntry = await sceneCommands.BUILD_SCENE({ bodies: [null] }, makeCtx()) as { ok: boolean };
    expect(badEntry.ok).toBe(false);

    const badSegs = await sceneCommands.BUILD_SCENE(
      { bodies: [{ id: 'c', geoms: [{ type: 'cone', radius: 0.05, height: 0.1, segments: 99999 }] }] },
      makeCtx(),
    ) as { ok: boolean };
    expect(badSegs.ok).toBe(false);

    // Valid BUILD_SCENE clears breakage and activePreset and sets scene name
    const ok = await sceneCommands.BUILD_SCENE(
      { name: 'My Custom Rig', bodies: [{ id: 'b1', geoms: [{ type: 'box', size: [50, 50, 50] }] }] },
      makeCtx(),
    ) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(useStore.getState().shatteredBodies).toEqual({});
    expect(useStore.getState().brokenConstraints).toEqual([]);
    expect(useStore.getState().activePreset).toBeUndefined();
    expect(useStore.getState().sceneGraph.name).toBe('My Custom Rig');
  });

  it('catches corrupt scenes and clears breakage in LOAD_SCENE_FILE', async () => {
    const arrRes = await sceneCommands.LOAD_SCENE_FILE({ scene: [] }, makeCtx()) as { ok: boolean };
    expect(arrRes.ok).toBe(false);

    const corruptPacked = await sceneCommands.LOAD_SCENE_FILE(
      { scene: { nodes: [{ id: 'a', geoms: [{ vertices: { $packed: 'unknown_codec', b64: '!!!', n: 3 } }] }] } },
      makeCtx(),
    ) as { ok: boolean };
    expect(corruptPacked.ok).toBe(false);

    useStore.setState({ brokenConstraints: ['weld:x'] });
    const ok = await sceneCommands.LOAD_SCENE_FILE({ scene: { nodes: [makeBoxNode('b1')] } }, makeCtx()) as { ok: boolean };
    expect(ok.ok).toBe(true);
    expect(useStore.getState().brokenConstraints).toEqual([]);
  });

  it('enforces UPDATE_OBJECT guards (non-object updates, id immutability, joint defaults, nested free, scad type, resolveUpdatedGeoms error)', async () => {
    const child = makeBoxNode('child1', 'child1', { joints: [] });
    const parent = makeBoxNode('parent1', 'parent1', { children: [child] });
    useStore.setState({ sceneGraph: { nodes: [parent] } });

    expect(((await objectCommands.UPDATE_OBJECT({ targetId: 'parent1', updates: 'not-obj' }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await objectCommands.UPDATE_OBJECT({ targetId: 'parent1', updates: [] }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await objectCommands.UPDATE_OBJECT({ targetId: 'parent1', updates: { id: 'renamed_id' } }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await objectCommands.UPDATE_OBJECT({ targetId: 'parent1', updates: { scad: 123 } }, makeCtx())) as { ok: boolean }).ok).toBe(false);

    // Nested body cannot be given a free joint
    const nestedFree = await objectCommands.UPDATE_OBJECT(
      { targetId: 'child1', updates: { joints: [{ type: 'free' }] } },
      makeCtx(),
    ) as { ok: boolean; error: string };
    expect(nestedFree.ok).toBe(false);
    expect(nestedFree.error).toContain('free joint');

    // Top-level joint update fills missing joint name via fillJointDefaults
    const jointOk = await objectCommands.UPDATE_OBJECT(
      { targetId: 'parent1', updates: { joints: [{ type: 'hinge', axis: [0, 1, 0] }] } },
      makeCtx(),
    ) as { ok: boolean };
    expect(jointOk.ok).toBe(true);
    const updatedParent = findNodeInScene(useStore.getState().sceneGraph.nodes, 'parent1');
    expect(updatedParent?.joints[0].name).toBe('parent1_joint_0');

    // UPDATE_OBJECT catches resolveUpdatedGeoms size errors and returns { ok: false, error }
    const badGeom = await objectCommands.UPDATE_OBJECT(
      { targetId: 'parent1', updates: { geoms: [{ type: 'box', size: [-1, 0.1, 0.1] }] } },
      makeCtx(),
    ) as { ok: boolean };
    expect(badGeom.ok).toBe(false);
    expect(() => resolveUpdatedGeoms(parent, [{ type: 'box', size: [-1, 0.1, 0.1] }])).toThrow(/size\[0\]/);
  });

  it('validates IMPORT_PROFILE, RUN_HEADLESS, preset commands, CLEAR_PAINT, VALIDATE_SCAD, and SET_CONSTRAINT', async () => {
    const box = makeBoxNode('box1');
    useStore.setState({ sceneGraph: { nodes: [box] } });

    // IMPORT_PROFILE
    expect(((await profileCommands.IMPORT_PROFILE({ svg: 123 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await profileCommands.IMPORT_PROFILE({ svg: '<svg/>', widthMm: Infinity }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await profileCommands.IMPORT_PROFILE({ svg: '<svg/>', thicknessMm: -2 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await profileCommands.IMPORT_PROFILE({ svg: '<svg/>', pos: [0, NaN, 0] }, makeCtx())) as { ok: boolean }).ok).toBe(false);

    // RUN_HEADLESS
    expect(((await sceneCommands.RUN_HEADLESS({ ticks: -10 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.RUN_HEADLESS({ ticks: Infinity }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.RUN_HEADLESS({ stride: 0 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.RUN_HEADLESS({ bodies: 'box1' }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.RUN_HEADLESS({ include: ['bogus'] }, makeCtx())) as { ok: boolean }).ok).toBe(false);

    // Preset commands
    expect(((await sceneCommands.LOAD_PRESET({ preset: 123 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.SAVE_PRESET({ preset: 'user:' }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.SAVE_PRESET({ preset: '__proto__' }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.DELETE_PRESET({ preset: 'user:nonexistent_xyz' }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await sceneCommands.DELETE_PRESET({ preset: 'constructor' }, makeCtx())) as { ok: boolean }).ok).toBe(false);

    // CLEAR_PAINT
    const clearAllSpy = vi.fn();
    useStore.setState({ clearAllPaint: clearAllSpy });
    const clearNoId = await objectCommands.CLEAR_PAINT({ geomName: 'box1_geom' }, makeCtx()) as { ok: boolean };
    expect(clearNoId.ok).toBe(false);
    expect(clearAllSpy).not.toHaveBeenCalled();

    const clearBadGeom = await objectCommands.CLEAR_PAINT({ targetId: 'box1', geomName: 'missing_geom' }, makeCtx()) as { ok: boolean };
    expect(clearBadGeom.ok).toBe(false);

    // VALIDATE_SCAD
    expect(((await sceneCommands.VALIDATE_SCAD({ scad: 42 }, makeCtx())) as { ok: boolean }).ok).toBe(false);

    // SET_CONSTRAINT
    expect(((await objectCommands.SET_CONSTRAINT({ targetId: 'box1', breakForceN: -5 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await objectCommands.SET_CONSTRAINT({ targetId: 'box1', breakTorqueNm: NaN }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await objectCommands.SET_CONSTRAINT({ targetId: 'box1', breakHoldSteps: 1.5 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
    expect(((await objectCommands.SET_CONSTRAINT({ targetId: 'box1', breakHoldSteps: 0 }, makeCtx())) as { ok: boolean }).ok).toBe(false);
  });
});
