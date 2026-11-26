import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  addFacesMm, addRingMm, bevelEdgesMm, bevelFaceMm, dimensionSelectionMm, extrudeMm,
  insetFaceMm, revolveMm,
} from '../src/utils/latticeCommands';
import { boxLattice, createLattice, DEFAULT_UNIT, serializeCage, toSceneGeom as latticeToSceneGeom, deserializeCage } from '../src/utils/latticeMesh';
import { icosphere, recomputeNormals, toSceneGeom as sculptToSceneGeom } from '../src/utils/sculptMesh';
import { SCULPT_BASES } from '../src/utils/sculptBases';
import { HARDWARE_KINDS } from '../src/utils/hardwareCuts';
import { useStore } from '../src/store/useStore';
import { useViewQuality } from '../src/store/viewQualityStore';
import { useCapture } from '../src/store/captureStore';
import { parseAxis, runLatticeOps, latticeHistory } from '../src/hooks/mcp/latticeState';
import { latticeCommands } from '../src/hooks/mcp/latticeCommands';
import { breakageCommands } from '../src/hooks/mcp/breakageCommands';
import { sculptCommands } from '../src/hooks/mcp/sculptCommands';
import { sculptHistory, applySculptCutResult } from '../src/hooks/mcp/sculptState';
import { viewCommands } from '../src/hooks/mcp/viewCommands';
import { dfmCommands } from '../src/hooks/mcp/dfmCommands';
import { sectionCommands } from '../src/hooks/mcp/sectionCommands';
import type { SceneNode } from '../src/types/scene';
import type { McpContext } from '../src/hooks/mcp/types';

function makeCtx(overrides: Partial<McpContext> = {}): McpContext {
  return {
    store: useStore.getState(),
    toId: (v: unknown) => v,
    ...overrides,
  };
}

function makeLatticeNode(id = 'lat_1', halfSteps = 100): SceneNode {
  const lat = boxLattice(DEFAULT_UNIT, halfSteps); // 20 mm cube, corners +/-10
  const cage = serializeCage(lat);
  const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(deserializeCage(cage), 0, 0);
  return {
    id,
    name: id,
    type: 'body',
    pos: [0, 0, 0.2],
    joints: [{ name: `${id}_free`, type: 'free' }],
    geoms: [{
      name: `${id}_mesh`,
      type: 'mesh',
      size: [1],
      dynamic: true,
      latticeGeom: true,
      vertices,
      renderVertices,
      faces,
    }],
    children: [],
    isLattice: true,
    latticeCage: cage,
    latticeSubdiv: 0,
    latticeVersion: 1,
    latticeOrigin: origin,
  };
}

function makeSculptNode(id = 'sculpt_1'): SceneNode {
  const mesh = icosphere(0.05, 2);
  recomputeNormals(mesh);
  const { vertices, renderVertices, faces } = sculptToSceneGeom(mesh);
  return {
    id,
    name: id,
    type: 'body',
    pos: [0, 0, 0.1],
    joints: [{ name: `${id}_free`, type: 'free' }],
    geoms: [{
      name: `${id}_mesh`,
      type: 'mesh',
      size: [1],
      dynamic: true,
      vertices,
      renderVertices,
      faces,
    }],
    children: [],
    isSculpt: true,
    sculptBase: 'sphere',
    sculptVersion: 1,
  };
}

const initialNodes = useStore.getState().sceneGraph.nodes;

beforeEach(() => {
  sculptHistory.clear();
  latticeHistory.clear();
  useStore.setState({
    sceneGraph: { name: 'test', nodes: [] },
    lastCompileError: null,
    brokenConstraints: [],
    showEdges: true,
    wireframe: false,
    dimsEnabled: false,
    cameraView: 'perspective',
    cameraOverride: null,
  });
  useViewQuality.setState({ showColliders: false });
  useCapture.setState({ clean: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  useStore.setState({ sceneGraph: { name: 'test', nodes: initialNodes }, lastCompileError: null });
});

// ---------------------------------------------------------------------------
// 1. Lattice utils & handlers
// ---------------------------------------------------------------------------

describe('Lattice validation & safety fixes', () => {
  const topFace = [[-10, -10, 10], [10, -10, 10], [10, 10, 10], [-10, 10, 10]];

  it('stepsFromMm rejects NaN, Infinity, and huge values in inset/bevel/bevelEdges/circle', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    expect(() => insetFaceMm(l, topFace, NaN)).toThrow(/finite/i);
    expect(() => insetFaceMm(l, topFace, Infinity)).toThrow(/finite/i);
    expect(() => insetFaceMm(l, topFace, 200_000)).toThrow(/maximum lattice span/i);
    expect(() => bevelEdgesMm(l, [[topFace[0], topFace[1]]], NaN)).toThrow(/finite/i);
    expect(() => bevelEdgesMm(l, [[topFace[0], topFace[1]]], Infinity)).toThrow(/finite/i);

    const p = createLattice(DEFAULT_UNIT);
    const plate = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]];
    addFacesMm(p, [plate]);
    expect(() => bevelFaceMm(p, plate, NaN)).toThrow(/finite/i);
    expect(() => bevelFaceMm(p, plate, Infinity)).toThrow(/finite/i);

    expect(() => addRingMm(createLattice(DEFAULT_UNIT), [0, 0, 0], Infinity, 'z')).toThrow(/finite/i);
    expect(() => addRingMm(createLattice(DEFAULT_UNIT), [0, 0, 0], NaN, 'z')).toThrow(/finite/i);
  });

  it('extrudeMm uses stepsOf rounding (6.35 mm -> 6.4 mm) and rejects non-finite/huge distance', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    expect(() => extrudeMm(l, topFace, NaN)).toThrow(/finite/i);
    expect(() => extrudeMm(l, topFace, Infinity)).toThrow(/finite/i);
    expect(() => extrudeMm(l, topFace, 200_000)).toThrow(/maximum lattice span/i);

    const res = extrudeMm(l, topFace, 6.35);
    expect(res.steps).toBe(64);
    expect(res.distanceMm).toBe(6.4);
  });

  it('addRingMm & revolveMm enforce sides/segments bounds and validate degrees/throughMm', () => {
    const l = createLattice(DEFAULT_UNIT);
    expect(() => addRingMm(l, [0, 0, 0], 20, 'z', Infinity)).toThrow(/sides/i);
    expect(() => addRingMm(l, [0, 0, 0], 20, 'z', 1e9)).toThrow(/sides/i);
    expect(() => addRingMm(l, [0, 0, 0], 20, 'z', 257)).toThrow(/sides/i);
    expect(() => addRingMm(l, [0, 0, 0], 20, 'z', 2)).toThrow(/sides/i);
    expect(() => addRingMm(l, [0, 0, 0], 20, 'z', -4)).toThrow(/sides/i);
    expect(() => addRingMm(l, [0, 0, 0], 20, 'z', 4.5)).toThrow(/sides/i);

    const prof = [[20, 0, 0], [20, 0, 30]];
    expect(() => revolveMm(l, prof, 'z', NaN)).toThrow(/degrees/i);
    expect(() => revolveMm(l, prof, 'z', Infinity)).toThrow(/degrees/i);
    expect(() => revolveMm(l, prof, 'z', 360, { throughMm: [NaN, 0, 0] })).toThrow(/throughMm/i);
    expect(() => revolveMm(l, prof, 'z', 360, { throughMm: [1, 2] })).toThrow(/throughMm/i);
    expect(() => revolveMm(l, prof, 'z', 360, { segments: Infinity })).toThrow(/segments/i);
    expect(() => revolveMm(l, prof, 'z', 360, { segments: 257 })).toThrow(/segments/i);
    expect(() => revolveMm(l, prof, 'z', 360, { segments: 2 })).toThrow(/segments/i);
  });

  it('dimensionSelectionMm rejects NaN/string corners and non-finite valueMm', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    expect(() => dimensionSelectionMm(l, [[NaN, 0, 0]], 'x', 'size', 20)).toThrow(/\[x, y, z\] point/i);
    expect(() => dimensionSelectionMm(l, [['a', 'b', 'c']], 'x', 'size', 20)).toThrow(/\[x, y, z\] point/i);
    expect(() => dimensionSelectionMm(l, topFace, 'x', 'size', NaN)).toThrow(/valueMm/i);
    expect(() => dimensionSelectionMm(l, topFace, 'x', 'position', Infinity)).toThrow(/valueMm/i);
  });

  it('parseAxis normalizes case and rejects invalid axes', () => {
    expect(parseAxis('x')).toBe('x');
    expect(parseAxis('Y')).toBe('y');
    expect(parseAxis('Z')).toBe('z');
    expect(parseAxis(undefined)).toBeUndefined();
    expect(() => parseAxis(undefined, 'axis', true)).toThrow(/'x', 'y' or 'z'/);
    expect(() => parseAxis('up')).toThrow(/'x', 'y' or 'z'/);
    expect(() => parseAxis('xy')).toThrow(/'x', 'y' or 'z'/);
    expect(() => parseAxis(123)).toThrow(/'x', 'y' or 'z'/);
  });

  it('runLatticeOps validates initial params, op entries, axis/mirror, smooth, wall, dimension, bevel_edges', () => {
    const l = boxLattice(DEFAULT_UNIT, 100);
    expect(() => runLatticeOps(l, [], NaN, 0)).toThrow(/subdiv/i);
    expect(() => runLatticeOps(l, [], 0, Infinity)).toThrow(/thicknessMm/i);
    expect(() => runLatticeOps(l, 'bad' as unknown as [], 0, 0)).toThrow(/array/i);
    expect(() => runLatticeOps(l, [null as unknown as Record<string, unknown>])).toThrow(/object/i);
    expect(() => runLatticeOps(l, [{ op: 'smooth', level: 'high' }])).toThrow(/level/i);
    expect(() => runLatticeOps(l, [{ op: 'smooth', level: -1 }])).toThrow(/level/i);
    expect(() => runLatticeOps(l, [{ op: 'wall', thicknessMm: Infinity }])).toThrow(/thicknessMm/i);
    expect(() => runLatticeOps(l, [{ op: 'wall', thicknessMm: -2 }])).toThrow(/thicknessMm/i);
    expect(() => runLatticeOps(l, [{ op: 'extrude', face: topFace, distanceMm: Infinity }])).toThrow(/distanceMm/i);
    expect(() => runLatticeOps(l, [{ op: 'extrude', face: topFace, distanceMm: 5, axis: 'up' }])).toThrow(/axis/i);
    expect(() => runLatticeOps(l, [{ op: 'dimension', corners: topFace, axis: 'z', valueMm: NaN }])).toThrow(/valueMm/i);
    expect(() => runLatticeOps(l, [{ op: 'dimension', corners: topFace, axis: 'z', mode: 'bogus', valueMm: 10 }])).toThrow(/mode/i);
    expect(() => runLatticeOps(l, [{ op: 'bevel_edges', edges: [[topFace[0], topFace[1]]], radiusMm: 1, mode: 'bogus' }])).toThrow(/mode/i);
  });

  it('CREATE_LATTICE rejects malformed pos, non-array ops, and non-number subdiv/thicknessMm', async () => {
    await expect(latticeCommands.CREATE_LATTICE({ pos: [0, 0] }, makeCtx())).rejects.toThrow(/pos/i);
    await expect(latticeCommands.CREATE_LATTICE({ pos: 'bad' }, makeCtx())).rejects.toThrow(/pos/i);
    await expect(latticeCommands.CREATE_LATTICE({ ops: 'not-array' }, makeCtx())).rejects.toThrow(/ops/i);
    await expect(latticeCommands.CREATE_LATTICE({ subdiv: 'high' }, makeCtx())).rejects.toThrow(/subdiv/i);
    await expect(latticeCommands.CREATE_LATTICE({ thicknessMm: -1 }, makeCtx())).rejects.toThrow(/thicknessMm/i);
  });

  it('LATTICE_SMOOTH & LATTICE_WALL reject invalid/negative inputs instead of resetting to 0', async () => {
    const node = makeLatticeNode();
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    const spySubdiv = vi.spyOn(useStore.getState(), 'setLatticeSubdiv').mockImplementation(() => {});
    const spyWall = vi.spyOn(useStore.getState(), 'setLatticeThickness').mockImplementation(() => {});

    await expect(latticeCommands.LATTICE_SMOOTH({ targetId: node.id, level: NaN }, makeCtx())).rejects.toThrow(/level/i);
    await expect(latticeCommands.LATTICE_SMOOTH({ targetId: node.id, level: -1 }, makeCtx())).rejects.toThrow(/level/i);
    await expect(latticeCommands.LATTICE_SMOOTH({ targetId: node.id, level: 'high' }, makeCtx())).rejects.toThrow(/level/i);
    await expect(latticeCommands.LATTICE_WALL({ targetId: node.id, thicknessMm: -2 }, makeCtx())).rejects.toThrow(/thicknessMm/i);
    await expect(latticeCommands.LATTICE_WALL({ targetId: node.id, thicknessMm: Infinity }, makeCtx())).rejects.toThrow(/thicknessMm/i);
    expect(spySubdiv).not.toHaveBeenCalled();
    expect(spyWall).not.toHaveBeenCalled();
  });

  it('LATTICE_BEVEL_EDGES accepts round and rejects unknown mode; LATTICE_DIMENSION rejects unknown mode', async () => {
    const node = makeLatticeNode();
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    vi.spyOn(useStore.getState(), 'recordInteraction').mockImplementation(() => {});
    vi.spyOn(useStore.getState(), 'updateNode').mockImplementation(() => {});
    vi.spyOn(useStore.getState(), 'applyLattice').mockImplementation(() => {});

    await expect(latticeCommands.LATTICE_BEVEL_EDGES({
      targetId: node.id,
      edges: [[topFace[0], topFace[1]]],
      radiusMm: 2,
      mode: 'unknown',
    }, makeCtx())).rejects.toThrow(/mode/i);

    const roundRes = await latticeCommands.LATTICE_BEVEL_EDGES({
      targetId: node.id,
      edges: [[topFace[0], topFace[1]]],
      radiusMm: 2,
      mode: 'round',
    }, makeCtx()) as { ok: boolean };
    expect(roundRes.ok).toBe(true);

    const dimRes = await latticeCommands.LATTICE_DIMENSION({
      targetId: node.id,
      corners: topFace,
      axis: 'z',
      mode: 'bogus',
      valueMm: 20,
    }, makeCtx()) as { ok: boolean; error?: string };
    expect(dimRes.ok).toBe(false);
    expect(dimRes.error).toMatch(/mode/i);
  });

  it('LATTICE_CIRCLE accepts center alias and validates axis/sides', async () => {
    const node = makeLatticeNode();
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    vi.spyOn(useStore.getState(), 'recordInteraction').mockImplementation(() => {});
    vi.spyOn(useStore.getState(), 'updateNode').mockImplementation(() => {});
    vi.spyOn(useStore.getState(), 'applyLattice').mockImplementation(() => {});

    const res = await latticeCommands.LATTICE_CIRCLE({
      targetId: node.id,
      center: [0, 0, 20],
      diameterMm: 10,
      axis: 'Z',
      sides: 8,
    }, makeCtx()) as { ok: boolean; sides: number };
    expect(res.ok).toBe(true);
    expect(res.sides).toBe(8);

    await expect(latticeCommands.LATTICE_CIRCLE({
      targetId: node.id,
      center: [0, 0, 20],
      diameterMm: 10,
      axis: 'up',
    }, makeCtx())).rejects.toThrow(/axis/i);
  });

  it('LATTICE_DELETE_FACES refuses deleting all faces of a cage', async () => {
    const lat = createLattice(DEFAULT_UNIT);
    const sq = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
    addFacesMm(lat, [sq]);
    const cage = serializeCage(lat);
    const { vertices, renderVertices, faces, origin } = latticeToSceneGeom(deserializeCage(cage), 0, 0);
    const node: SceneNode = {
      ...makeLatticeNode('lat_single'),
      latticeCage: cage,
      latticeOrigin: origin,
      geoms: [{ name: 'lat_single_mesh', type: 'mesh', size: [1], dynamic: true, latticeGeom: true, vertices, renderVertices, faces }],
    };
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    const spyApply = vi.spyOn(useStore.getState(), 'applyLattice').mockImplementation(() => {});

    const res = await latticeCommands.LATTICE_DELETE_FACES({
      targetId: node.id,
      faces: [sq],
    }, makeCtx()) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/physics_delete_object/i);
    expect(spyApply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Breakage commands
// ---------------------------------------------------------------------------

describe('Breakage command audit fixes', () => {
  function boxWithHinge(id = 'b1'): SceneNode {
    return {
      id,
      name: id,
      type: 'body',
      pos: [0, 0, 0.2],
      joints: [{
        name: 'j1',
        type: 'hinge',
        axis: [0, 1, 0],
        crumpleTorqueNm: 10,
        crumpleRangeDeg: [-30, 30],
        crumpleDampingAfter: 2,
      }],
      geoms: [{ name: 'g1', type: 'box', size: [0.05, 0.05, 0.05] }],
      children: [],
    };
  }

  it('SET_CRUMPLE validates inputs and clears range/damping when clearing crumpleTorqueNm', async () => {
    const node = boxWithHinge();
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    const spyJoint = vi.spyOn(useStore.getState(), 'updateNodeJoint').mockImplementation((nodeId, updates, idx) => {
      const nodes = useStore.getState().sceneGraph.nodes;
      const target = nodes.find((n) => n.id === nodeId)!;
      target.joints[idx ?? 0] = { ...target.joints[idx ?? 0], ...updates };
    });

    const badTorque = await breakageCommands.SET_CRUMPLE({ targetId: 'b1', crumpleTorqueNm: -5 }, makeCtx()) as { ok: boolean };
    expect(badTorque.ok).toBe(false);
    const badRange = await breakageCommands.SET_CRUMPLE({ targetId: 'b1', crumpleRangeDeg: [45, 0] }, makeCtx()) as { ok: boolean };
    expect(badRange.ok).toBe(false);
    const badRangeType = await breakageCommands.SET_CRUMPLE({ targetId: 'b1', crumpleRangeDeg: 'bad' }, makeCtx()) as { ok: boolean };
    expect(badRangeType.ok).toBe(false);
    const badDamp = await breakageCommands.SET_CRUMPLE({ targetId: 'b1', crumpleDampingAfter: NaN }, makeCtx()) as { ok: boolean };
    expect(badDamp.ok).toBe(false);
    expect(spyJoint).not.toHaveBeenCalled();

    // Clearing crumpleTorqueNm: null also clears range & damping so limited="true" isn't stranded
    const cleared = await breakageCommands.SET_CRUMPLE({ targetId: 'b1', crumpleTorqueNm: null }, makeCtx()) as {
      ok: boolean; crumpleTorqueNm: number | null; crumpleRangeDeg: number[] | null; crumpleDampingAfter: number | null;
    };
    expect(cleared.ok).toBe(true);
    expect(cleared.crumpleTorqueNm).toBeNull();
    expect(cleared.crumpleRangeDeg).toBeNull();
    expect(cleared.crumpleDampingAfter).toBeNull();
  });

  it('SET_IMPACT validates all params upfront without partial mutation, and clear_dent does not convert primitives', async () => {
    const node: SceneNode = {
      id: 'box1',
      name: 'box1',
      type: 'body',
      pos: [0, 0, 0.2],
      joints: [{ name: 'box1_free', type: 'free' }],
      geoms: [
        { name: 'g_box', type: 'box', size: [0.05, 0.05, 0.05], dentYieldNs: 5, pierceImpulseNs: 20 },
        { name: 'g_plane', type: 'plane', size: [1, 1, 0.01] },
      ],
      children: [],
    };
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    const spyUpdateNode = vi.spyOn(useStore.getState(), 'updateNode').mockImplementation(() => {});
    const spyMakeDentable = vi.spyOn(useStore.getState(), 'makeDentable').mockImplementation(() => true);
    const spyUpdateGeom = vi.spyOn(useStore.getState(), 'updateNodeGeom').mockImplementation((nodeId, updates, idx) => {
      const target = useStore.getState().sceneGraph.nodes.find((n) => n.id === nodeId)!;
      target.geoms[idx ?? 0] = { ...target.geoms[idx ?? 0], ...updates };
    });

    // Invalid shatter params
    expect((await breakageCommands.SET_IMPACT({ targetId: 'box1', shatterPieces: 1 }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await breakageCommands.SET_IMPACT({ targetId: 'box1', shatterPieces: 25 }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await breakageCommands.SET_IMPACT({ targetId: 'box1', shatterPattern: 'spiral' }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await breakageCommands.SET_IMPACT({ targetId: 'box1', shatterDepth: 3 }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await breakageCommands.SET_IMPACT({ targetId: 'box1', deformCollision: 'hull' }, makeCtx()) as { ok: boolean }).ok).toBe(false);

    // Valid shatter + invalid geomName -> MUST NOT partially mutate shatter*
    const badGeom = await breakageCommands.SET_IMPACT({
      targetId: 'box1', shatterImpulseNs: 5, dentYieldNs: 3, geomName: 'missing',
    }, makeCtx()) as { ok: boolean };
    expect(badGeom.ok).toBe(false);
    expect(spyUpdateNode).not.toHaveBeenCalled();

    // Valid shatter + un-dentable plane -> MUST NOT partially mutate shatter*
    const planeRes = await breakageCommands.SET_IMPACT({
      targetId: 'box1', shatterImpulseNs: 5, dentYieldNs: 3, geomName: 'g_plane',
    }, makeCtx()) as { ok: boolean };
    expect(planeRes.ok).toBe(false);
    expect(spyUpdateNode).not.toHaveBeenCalled();

    // Clear dent + clear pierce on primitive box -> MUST NOT call makeDentable (stays type: 'box')
    const clearRes = await breakageCommands.SET_IMPACT({
      targetId: 'box1', dentYieldNs: null, pierceImpulseNs: null,
    }, makeCtx()) as { ok: boolean; convertedToMesh: boolean; dentYieldNs: number | null; pierceImpulseNs: number | null };
    expect(clearRes.ok).toBe(true);
    expect(clearRes.convertedToMesh).toBe(false);
    expect(clearRes.dentYieldNs).toBeNull();
    expect(clearRes.pierceImpulseNs).toBeNull();
    expect(spyMakeDentable).not.toHaveBeenCalled();
    expect(spyUpdateGeom).toHaveBeenCalledTimes(1);
    expect(useStore.getState().sceneGraph.nodes[0].geoms[0].type).toBe('box');
  });

  it('RESTORE_BREAK rejects empty string / non-string key and only resets all on null/undefined', async () => {
    const spyReset = vi.spyOn(useStore.getState(), 'resetSimulation').mockImplementation(() => {});

    expect((await breakageCommands.RESTORE_BREAK({ key: '' }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await breakageCommands.RESTORE_BREAK({ key: 0 }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await breakageCommands.RESTORE_BREAK({ key: false }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect(spyReset).not.toHaveBeenCalled();

    expect((await breakageCommands.RESTORE_BREAK({}, makeCtx()) as { ok: boolean; restored: string }).restored).toBe('all');
    expect((await breakageCommands.RESTORE_BREAK({ key: null }, makeCtx()) as { ok: boolean; restored: string }).restored).toBe('all');
    expect(spyReset).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Sculpt commands & state
// ---------------------------------------------------------------------------

describe('Sculpt command & state audit fixes', () => {
  it('CREATE_SCULPT rejects malformed pos and out-of-range sizeMm', async () => {
    await expect(sculptCommands.CREATE_SCULPT({ pos: [0, 0] }, makeCtx())).rejects.toThrow(/pos/i);
    await expect(sculptCommands.CREATE_SCULPT({ pos: 'bad' }, makeCtx())).rejects.toThrow(/pos/i);
    await expect(sculptCommands.CREATE_SCULPT({ sizeMm: 0.5 }, makeCtx())).rejects.toThrow(/between 1 and 2000/i);
    await expect(sculptCommands.CREATE_SCULPT({ sizeMm: 5000 }, makeCtx())).rejects.toThrow(/between 1 and 2000/i);
  });

  it('RESIZE_SCULPT rejects [null, null, null] without wiping sculptHistory', async () => {
    const node = makeSculptNode();
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    sculptHistory.set(node.id, [{ indices: null, positions: null, mesh: icosphere(0.05, 1) }]);

    await expect(sculptCommands.RESIZE_SCULPT({ targetId: node.id, sizeMm: [null, null, null] }, makeCtx()))
      .rejects.toThrow(/at least one axis/i);
    expect(sculptHistory.get(node.id)?.length).toBe(1);
  });

  it('SCULPT validates all strokes upfront without corrupting sculptHistory, and ignores stale lastCompileError', async () => {
    const node = makeSculptNode();
    useStore.setState({
      sceneGraph: { name: 'test', nodes: [node] },
      lastCompileError: 'stale error from an older edit',
    });
    vi.spyOn(useStore.getState(), 'recordInteraction').mockImplementation(() => {});
    vi.spyOn(useStore.getState(), 'updateNode').mockImplementation(() => {});
    vi.spyOn(useStore.getState(), 'updateNodeGeom').mockImplementation(() => {});

    // Empty / non-array / malformed strokes
    await expect(sculptCommands.SCULPT({ targetId: node.id, strokes: [] }, makeCtx())).rejects.toThrow(/non-empty array/i);
    await expect(sculptCommands.SCULPT({ targetId: node.id, strokes: 'bad' }, makeCtx())).rejects.toThrow(/non-empty array/i);
    await expect(sculptCommands.SCULPT({ targetId: node.id, strokes: [null] }, makeCtx())).rejects.toThrow(/object/i);

    // Invalid symmetry / strength / hardness
    await expect(sculptCommands.SCULPT({ targetId: node.id, at: [0, 0, 0.05], symmetry: 'Y' }, makeCtx())).rejects.toThrow(/symmetry/i);
    await expect(sculptCommands.SCULPT({ targetId: node.id, at: [0, 0, 0.05], strength: 2 }, makeCtx())).rejects.toThrow(/strength/i);
    await expect(sculptCommands.SCULPT({ targetId: node.id, at: [0, 0, 0.05], hardness: -0.1 }, makeCtx())).rejects.toThrow(/hardness/i);

    // Mid-batch validation failure on stroke #2 must NOT leave stroke #1 in sculptHistory!
    await expect(sculptCommands.SCULPT({
      targetId: node.id,
      strokes: [
        { brush: 'draw', at: [0, 0, 0.05], radius: 0.02, strength: 0.5 },
        { brush: 'draw', at: [0, 0, 0.05], strength: 5 },
      ],
    }, makeCtx())).rejects.toThrow(/strength/i);
    expect(sculptHistory.get(node.id) ?? []).toHaveLength(0);

    // Valid stroke succeeds even when lastCompileError holds a stale error
    const okRes = await sculptCommands.SCULPT({
      targetId: node.id,
      brush: 'draw',
      at: [0, 0, 0.05],
      radius: 0.02,
      strength: 0.5,
      dynamicTopology: false,
    }, makeCtx()) as { ok: boolean; error?: string; undoDepth: number };
    expect(okRes.ok).toBe(true);
    expect(okRes.error).toBeUndefined();
    expect(okRes.undoDepth).toBe(1);
  });

  it('SCULPT_CUT rejects zero-length direction upfront', async () => {
    const node = makeSculptNode();
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    await expect(sculptCommands.SCULPT_CUT({
      targetId: node.id,
      polygon: [[0, 0, 0], [0.05, 0, 0], [0, 0.05, 0]],
      direction: [0, 0, 0],
    }, makeCtx())).rejects.toThrow(/non-zero/i);
  });

  it('applySculptCutResult with opts.add skips separateSculpt on pre-existing multi-component mesh and ignores stale lastCompileError', async () => {
    // Build a 2-component sculpt mesh
    const a = icosphere(0.02, 1);
    const b = icosphere(0.02, 1);
    for (let i = 0; i < b.vertexCount; i++) b.positions[i * 3] += 0.1;
    const combinedVerts = new Float32Array((a.vertexCount + b.vertexCount) * 3);
    combinedVerts.set(a.positions.subarray(0, a.vertexCount * 3), 0);
    combinedVerts.set(b.positions.subarray(0, b.vertexCount * 3), a.vertexCount * 3);
    const combinedFaces = new Uint32Array((a.faceCount + b.faceCount) * 3);
    combinedFaces.set(a.faces.subarray(0, a.faceCount * 3), 0);
    for (let i = 0; i < b.faceCount * 3; i++) combinedFaces[a.faceCount * 3 + i] = b.faces[i] + a.vertexCount;

    const twoComp = {
      ...a,
      positions: combinedVerts,
      normals: new Float32Array(combinedVerts.length),
      faces: combinedFaces,
      vertexCount: a.vertexCount + b.vertexCount,
      faceCount: a.faceCount + b.faceCount,
    };
    recomputeNormals(twoComp);
    const geomData = sculptToSceneGeom(twoComp);
    const node: SceneNode = {
      id: 'multi_1',
      name: 'multi_1',
      type: 'body',
      pos: [0, 0, 0.1],
      joints: [],
      geoms: [{ name: 'multi_1_mesh', type: 'mesh', size: [1], dynamic: true, ...geomData }],
      children: [],
      isSculpt: true,
      sculptVersion: 1,
    };
    useStore.setState({
      sceneGraph: { name: 'test', nodes: [node] },
      lastCompileError: 'stale compile error',
    });

    const spySeparate = vi.spyOn(useStore.getState(), 'separateSculpt').mockImplementation(() => []);
    vi.spyOn(useStore.getState(), 'recordInteraction').mockImplementation(() => {});
    vi.spyOn(useStore.getState(), 'updateNode').mockImplementation(() => {});
    vi.spyOn(useStore.getState(), 'updateNodeGeom').mockImplementation(() => {});

    const res = await applySculptCutResult(
      node.id,
      0,
      node.geoms[0],
      twoComp,
      { ok: true, mesh: twoComp, facesBefore: twoComp.faceCount, facesAfter: twoComp.faceCount, pieces: 2 },
      { add: true },
    ) as { ok: boolean; error?: string };

    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(spySeparate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. View & Section commands
// ---------------------------------------------------------------------------

describe('View & Section command audit fixes', () => {
  it('SET_CAMERA rejects NaN/coincident position/target and does not mutate dims on error', async () => {
    const resNaN = await viewCommands.SET_CAMERA({ dims: true, position: [NaN, 0, 1] }, makeCtx()) as { ok: boolean };
    expect(resNaN.ok).toBe(false);
    expect(useStore.getState().dimsEnabled).toBe(false);

    const resCoinc = await viewCommands.SET_CAMERA({ dims: true, position: [1, 1, 1], target: [1, 1, 1] }, makeCtx()) as { ok: boolean };
    expect(resCoinc.ok).toBe(false);
    expect(useStore.getState().dimsEnabled).toBe(false);

    const resBadPreset = await viewCommands.SET_CAMERA({ dims: true, preset: 'bogus' }, makeCtx()) as { ok: boolean };
    expect(resBadPreset.ok).toBe(false);
    expect(useStore.getState().dimsEnabled).toBe(false);

    const okRes = await viewCommands.SET_CAMERA({ dims: true, position: [0, -1, 1], target: [0, 0, 0] }, makeCtx()) as { ok: boolean };
    expect(okRes.ok).toBe(true);
    expect(useStore.getState().dimsEnabled).toBe(true);
    expect(useStore.getState().cameraOverride).toEqual({ position: [0, -1, 1], target: [0, 0, 0] });
  });

  it('SCREENSHOT serializes concurrent calls, resolves if rAF never fires, and works without document', async () => {
    const fakeCanvas = {
      width: 640,
      height: 480,
      toDataURL: () => 'data:image/png;base64,AAA',
    };
    const origWindow = globalThis.window;
    const origRAF = globalThis.requestAnimationFrame;
    // Simulate a backgrounded tab where rAF never calls its callback
    (globalThis as Record<string, unknown>).requestAnimationFrame = () => 1;
    (globalThis as Record<string, unknown>).window = {
      _physics_gl: { domElement: fakeCanvas, render: () => {} },
    };

    try {
      useStore.setState({ showEdges: true, wireframe: false });
      useViewQuality.setState({ showColliders: false });

      const [r1, r2] = await Promise.all([
        viewCommands.SCREENSHOT({ showEdges: false, wireframe: true, clean: true }, makeCtx()),
        viewCommands.SCREENSHOT({ showColliders: true }, makeCtx()),
      ]) as Array<{ ok: boolean; view: Record<string, boolean> }>;

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r1.view).toEqual({ colliders: false, edges: false, wireframe: true, clean: true });
      expect(r2.view).toEqual({ colliders: true, edges: true, wireframe: false, clean: false });

      // Global flags restored cleanly after overlapping calls
      expect(useStore.getState().showEdges).toBe(true);
      expect(useStore.getState().wireframe).toBe(false);
      expect(useViewQuality.getState().showColliders).toBe(false);
      expect(useCapture.getState().clean).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
      (globalThis as Record<string, unknown>).requestAnimationFrame = origRAF;
    }
  });

  it('SCREENSHOT(clean: true) suppresses composer OutlineEffect selection during render, restores it, and skips rAF', async () => {
    const { physicsGlobals } = await import('../src/physicsGlobals');
    const selectedMeshA = { id: 'meshA' };
    const selectedMeshB = { id: 'meshB' };
    const selectionSet = new Set<unknown>([selectedMeshA, selectedMeshB]);
    const outlineSelection = {
      [Symbol.iterator]: () => selectionSet[Symbol.iterator](),
      clear: () => selectionSet.clear(),
      set: (items: unknown[]) => {
        selectionSet.clear();
        for (const item of items) selectionSet.add(item);
      },
      get size() { return selectionSet.size; },
    };
    const outlineEffect = { selection: outlineSelection, forceUpdate: false };
    let seenSelectionDuringRender = -1;
    let seenForceUpdateDuringRender = false;
    const fakeComposer = {
      passes: [{ effects: [outlineEffect] }],
      render: () => {
        seenSelectionDuringRender = outlineSelection.size;
        seenForceUpdateDuringRender = outlineEffect.forceUpdate;
      },
    };
    const fakeCanvas = {
      width: 640,
      height: 480,
      toDataURL: () => 'data:image/png;base64,CLEAN',
    };
    const fakeGl = { domElement: fakeCanvas, render: () => {} };

    const origWindow = globalThis.window;
    const origRAF = globalThis.requestAnimationFrame;
    const origPgGl = physicsGlobals._physics_gl;
    const origPgComposer = physicsGlobals._physics_composer;
    const rafSpy = vi.fn(() => 1);
    (globalThis as Record<string, unknown>).requestAnimationFrame = rafSpy;
    (globalThis as Record<string, unknown>).window = {
      _physics_gl: fakeGl,
      _physics_composer: fakeComposer,
    };
    physicsGlobals._physics_gl = fakeGl as never;
    physicsGlobals._physics_composer = fakeComposer as never;

    try {
      const res = await viewCommands.SCREENSHOT({ clean: true }, makeCtx()) as {
        ok: boolean;
        dataUrl: string;
        view: Record<string, boolean>;
      };

      expect(res.ok).toBe(true);
      expect(res.dataUrl).toBe('data:image/png;base64,CLEAN');
      expect(res.view.clean).toBe(true);
      // Outline selection cleared and forceUpdate set while the clean frame rendered
      expect(seenSelectionDuringRender).toBe(0);
      expect(seenForceUpdateDuringRender).toBe(true);
      // Outline selection and clean flag restored after capture
      expect(Array.from(selectionSet)).toEqual([selectedMeshA, selectedMeshB]);
      expect(outlineEffect.forceUpdate).toBe(true);
      expect(useCapture.getState().clean).toBe(false);
      // Must not wait on requestAnimationFrame (avoids extra SwiftShader renders)
      expect(rafSpy).not.toHaveBeenCalled();

      // Also restores outline selection if toDataURL throws
      fakeCanvas.toDataURL = () => { throw new Error('canvas read failed'); };
      await expect(viewCommands.SCREENSHOT({ clean: true }, makeCtx())).rejects.toThrow(/canvas read failed/);
      expect(Array.from(selectionSet)).toEqual([selectedMeshA, selectedMeshB]);
      expect(useCapture.getState().clean).toBe(false);
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
      (globalThis as Record<string, unknown>).requestAnimationFrame = origRAF;
      physicsGlobals._physics_gl = origPgGl;
      physicsGlobals._physics_composer = origPgComposer;
    }
  });

  it('SceneCanvas keeps SelectionOutline mounted during clean capture so EffectComposer never recompiles shaders', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../src/components/scene/SceneCanvas.tsx'), 'utf8');
    expect(src).toContain('<SelectionOutline />');
    expect(src).not.toMatch(/!cleanCapture\s*&&\s*<SelectionOutline/);
    expect(src).toContain('function EditorOverlays()');
  });

  it('GET_OBJECT validates offset and limit', async () => {
    const node = makeSculptNode();
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });

    await expect(viewCommands.GET_OBJECT({ targetId: node.id, offset: NaN }, makeCtx())).rejects.toThrow(/offset/i);
    await expect(viewCommands.GET_OBJECT({ targetId: node.id, offset: -1 }, makeCtx())).rejects.toThrow(/offset/i);
    await expect(viewCommands.GET_OBJECT({ targetId: node.id, offset: Infinity }, makeCtx())).rejects.toThrow(/offset/i);
    await expect(viewCommands.GET_OBJECT({ targetId: node.id, limit: 0 }, makeCtx())).rejects.toThrow(/limit/i);
    await expect(viewCommands.GET_OBJECT({ targetId: node.id, limit: NaN }, makeCtx())).rejects.toThrow(/limit/i);
  });

  it('GET_HISTORY validates sinceTime, last, stride, maxFrames, bodies, and include', async () => {
    expect((await viewCommands.GET_HISTORY({ sinceTime: NaN }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await viewCommands.GET_HISTORY({ last: -5 }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await viewCommands.GET_HISTORY({ stride: 0 }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await viewCommands.GET_HISTORY({ maxFrames: -1 }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await viewCommands.GET_HISTORY({ bodies: 'box1' }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await viewCommands.GET_HISTORY({ bodies: [123] }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await viewCommands.GET_HISTORY({ include: ['unknown'] }, makeCtx()) as { ok: boolean }).ok).toBe(false);
  });

  it('MEASURE validates withinMm and axis, uses toId, and guards window', async () => {
    expect((await viewCommands.MEASURE({ from: [0, 0, 0], to: [1, 0, 0], withinMm: NaN }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await viewCommands.MEASURE({ from: [0, 0, 0], to: [1, 0, 0], withinMm: -1 }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await viewCommands.MEASURE({ from: [0, 0, 0], to: [1, 0, 0], withinMm: Infinity }, makeCtx()) as { ok: boolean }).ok).toBe(false);

    const node: SceneNode = { id: 'real_id', name: 'MyBox', type: 'body', pos: [0, 0, 0], joints: [], geoms: [], children: [] };
    useStore.setState({ sceneGraph: { name: 'test', nodes: [node] } });
    const badAxis = await viewCommands.MEASURE({ body: 'MyBox', axis: 'w' }, makeCtx({ toId: () => 'real_id' })) as { ok: boolean };
    expect(badAxis.ok).toBe(false);

    // Works in Node without window
    const dist = await viewCommands.MEASURE({ from: [0, 0, 0], to: [0.1, 0, 0], snap: false }, makeCtx()) as { ok: boolean; distanceMm: number };
    expect(dist.ok).toBe(true);
    expect(dist.distanceMm).toBeCloseTo(100, 3);
  });

  it('GET_EDGES rejects missing targetId', async () => {
    const res = await viewCommands.GET_EDGES({}, makeCtx()) as { ok: boolean; error?: string };
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/targetId/i);
  });

  it('SET_NOTE_CARDS validates card objects; SET_REFERENCE_IMAGE strictly validates height', async () => {
    const origWindow = globalThis.window;
    const setter = vi.fn();
    (globalThis as Record<string, unknown>).window = { _physics_setNoteCards: setter };
    try {
      expect((await viewCommands.SET_NOTE_CARDS({ noteCards: [null] }, makeCtx()) as { ok: boolean }).ok).toBe(false);
      expect((await viewCommands.SET_NOTE_CARDS({ noteCards: [{ id: 'n1', markdown: 123 }] }, makeCtx()) as { ok: boolean }).ok).toBe(false);
      expect((await viewCommands.SET_NOTE_CARDS({ noteCards: [{ id: 'n1', markdown: 'hi', x: NaN }] }, makeCtx()) as { ok: boolean }).ok).toBe(false);
      expect((await viewCommands.SET_NOTE_CARDS({ noteCards: [{ id: 'n1', markdown: 'hi', minimized: 'yes' }] }, makeCtx()) as { ok: boolean }).ok).toBe(false);
      expect(setter).not.toHaveBeenCalled();

      expect((await viewCommands.SET_NOTE_CARDS({ noteCards: [{ id: 'n1', markdown: '# ok', x: 10, y: 20, minimized: false }] }, makeCtx()) as { ok: boolean }).ok).toBe(true);
      expect(setter).toHaveBeenCalledTimes(1);
    } finally {
      (globalThis as Record<string, unknown>).window = origWindow;
    }

    await expect(viewCommands.SET_REFERENCE_IMAGE({ imageId: 'r1', height: true }, makeCtx())).rejects.toThrow(/height/i);
    await expect(viewCommands.SET_REFERENCE_IMAGE({ imageId: 'r1', height: [2] }, makeCtx())).rejects.toThrow(/height/i);
    await expect(viewCommands.SET_REFERENCE_IMAGE({ imageId: 'r1', height: NaN }, makeCtx())).rejects.toThrow(/height/i);
    await expect(viewCommands.SET_REFERENCE_IMAGE({ imageId: 'r1', height: 25 }, makeCtx())).rejects.toThrow(/height/i);
  });

  it('GET_SCHEMA lists exact SCULPT_BASES and HARDWARE_KINDS names', async () => {
    const schema = await viewCommands.GET_SCHEMA({}, makeCtx()) as {
      choosingTheRightTool: { organicClayShapes: string };
      nodeFields: { sculpt: string; cuts: string };
    };
    for (const b of SCULPT_BASES) {
      expect(schema.nodeFields.sculpt).toContain(`"${b.id}"`);
      expect(schema.choosingTheRightTool.organicClayShapes).toContain(`"${b.id}"`);
    }
    expect(schema.nodeFields.sculpt).not.toContain('"Bust"');
    expect(schema.nodeFields.sculpt).not.toContain('"torus"');
    for (const kind of Object.keys(HARDWARE_KINDS)) {
      expect(schema.nodeFields.cuts).toContain(`"${kind}"`);
    }
    expect(schema.nodeFields.cuts).not.toContain('"countersink"');
    expect(schema.nodeFields.cuts).not.toContain('"heat_set_insert"');
    expect(schema.nodeFields.cuts).not.toContain('"o_ring_groove"');
  });

  it('SECTION rejects non-string axis and non-string bodyId and resolves bodyId via toId', async () => {
    const badAxis = await sectionCommands.SECTION({ axis: [0, 0, 1] }, makeCtx()) as { ok: boolean };
    expect(badAxis.ok).toBe(false);

    const badBody = await sectionCommands.SECTION({ bodyId: ['a', 'b'] }, makeCtx()) as { ok: boolean };
    expect(badBody.ok).toBe(false);

    const toId = vi.fn(() => 'missing_resolved');
    const missing = await sectionCommands.SECTION({ bodyId: 'FriendlyName' }, makeCtx({ toId })) as { ok: boolean };
    expect(missing.ok).toBe(false);
    expect(toId).toHaveBeenCalledWith('FriendlyName');
  });

  it('CHECK_DFM rejects Object.prototype keys for process and castMaterial, normalizes uppercase process, and rejects non-string masterId', async () => {
    expect((await dfmCommands.CHECK_DFM({ process: 'toString' }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await dfmCommands.CHECK_DFM({ process: 'constructor' }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await dfmCommands.CHECK_DFM({ castMaterial: 'toString' }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await dfmCommands.CHECK_DFM({ castMaterial: 'constructor' }, makeCtx()) as { ok: boolean }).ok).toBe(false);
    expect((await dfmCommands.CHECK_DFM({ masterId: ['a', 'b'] }, makeCtx()) as { ok: boolean }).ok).toBe(false);

    // Uppercase 'CNC' is accepted and fails cleanly on empty scene rather than process validation
    useStore.setState({ sceneGraph: { name: 'empty', nodes: [] } });
    const emptyRes = await dfmCommands.CHECK_DFM({ process: 'CNC' }, makeCtx()) as { ok: boolean; error?: string };
    expect(emptyRes.ok).toBe(false);
    expect(emptyRes.error).toMatch(/nothing to check/i);
  });
});
