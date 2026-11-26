import { describe, it, expect, vi } from 'vitest';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';
import { brickworkInScene, layBricks } from '../src/utils/brickwork';
import { classifyTimberAutoMode, decomposeSolidIntoPlanks } from '../src/utils/timberBreakdown';
import { collisionHashOf } from '../src/utils/convexDecomposition';
import { collectFilledCavities } from '../src/utils/sceneSummary';
import { digestTelemetry } from '../src/utils/telemetryDigest';
import { summarizeTrajectory } from '../src/utils/trajectorySummary';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { objectCommands } from '../src/hooks/mcp/objectCommands';
import { partBuildCommands } from '../src/hooks/mcp/partBuildCommands';
import { useStore } from '../src/store/useStore';
import type { HistoryEntry } from '../src/workers/physicsWorkerProtocol';

const boxGeom = (name: string, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): SceneGeom =>
  ({ name, type: 'box', size: [hx, hy, hz], pos: [cx, cy, cz] }) as SceneGeom;

const sceneOf = (geoms: SceneGeom[]): SceneGraph =>
  ({ nodes: [{ id: 'b', name: 'B', type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms }] }) as unknown as SceneGraph;

/** One-brick garden wall with a 600 mm gateway under a lintel course. */
const gatewayScene = sceneOf([
  boxGeom('l', -0.9, 0, 0.6, 0.6, 0.1075, 0.6),
  boxGeom('r', 0.9, 0, 0.6, 0.6, 0.1075, 0.6),
  boxGeom('o', 0, 0, 1.05, 0.3, 0.1075, 0.15),
]);

const halfBrickWall = sceneOf([boxGeom('w', 0, 0, 0.3, 0.5575, 0.05125, 0.3)]);

describe('Item 1: physics_build_brickwork lintel geoms and recessed mortar core', () => {
  it('places visible concrete lintel box geom(s) over detected openings matching BOM length & bearing', () => {
    const out = brickworkInScene(gatewayScene, 'b', { placement: 'replace' });
    expect(out.result.lintels).toEqual([{ lengthMm: 900, count: 1 }]);
    expect(out.result.placedLintels).toHaveLength(1);
    const placed = out.result.placedLintels![0];
    expect(placed.lengthMm).toBe(900);
    expect(placed.depthMm).toBeCloseTo(215, 0);
    expect(placed.heightMm).toBe(65);

    const allGeoms = out.nodes.flatMap((n) => n.geoms);
    const lintelGeoms = allGeoms.filter((g) => /_lintel_/.test(g.name));
    expect(lintelGeoms).toHaveLength(1);
    expect(lintelGeoms[0].type).toBe('box');
    // Half-size along X = 900 mm / 2000 = 0.45 m
    expect(lintelGeoms[0].size[0]).toBeCloseTo(0.45, 3);
    expect(lintelGeoms[0].size[1]).toBeCloseTo(0.1075, 3);
    expect(lintelGeoms[0].density).toBe(2400);

    // No regular brick should be floating/bridging inside the lintel's span in that course
    const lintelCourseBricks = out.result.bricks.filter((b) => b.course === placed.course);
    for (const b of lintelCourseBricks) {
      const distX = Math.abs(b.x - placed.x);
      expect(distX).toBeGreaterThanOrEqual(placed.lengthMm / 2 + b.lengthMm / 2 - 1);
    }
  });

  it('adds a slightly recessed visual mortar backing core when includeMortar is true', () => {
    const withoutMortar = brickworkInScene(halfBrickWall, 'b', { placement: 'replace' });
    expect(withoutMortar.nodes.some((n) => n.name === 'Mortar Core')).toBe(false);

    const withMortar = brickworkInScene(halfBrickWall, 'b', { placement: 'replace', includeMortar: true });
    const mortarNode = withMortar.nodes.find((n) => n.name === 'Mortar Core');
    expect(mortarNode).toBeDefined();
    expect(mortarNode!.geoms.length).toBeGreaterThan(0);
    for (const g of mortarNode!.geoms) {
      expect(g.role).toBe('visual');
      // Recessed from the 102.5 mm wall faces so bricks sit proud with zero z-fighting
      expect(g.size[1] * 2000).toBeLessThan(102.5);
    }

    // Mortar core on gateway must not block the 600 mm opening below the lintel
    const gwMortar = brickworkInScene(gatewayScene, 'b', { placement: 'replace', includeMortar: true });
    const gwMortarNode = gwMortar.nodes.find((n) => n.name === 'Mortar Core');
    expect(gwMortarNode).toBeDefined();
    const lintelZ = gwMortar.result.placedLintels![0].z / 1000;
    const blockingOpening = gwMortarNode!.geoms.filter((g) => {
      const zCenter = g.pos![2];
      const xLo = g.pos![0] - g.size[0];
      const xHi = g.pos![0] + g.size[0];
      return zCenter < lintelZ - 0.01 && xLo < 0.25 && xHi > -0.25;
    });
    expect(blockingOpening).toHaveLength(0);
  });

  it('omits mortar core for toy bricks (0 mm joints)', () => {
    const toyWall = sceneOf([boxGeom('w', 0, 0, 0.048, 0.08, 0.008, 0.048)]);
    const out = brickworkInScene(toyWall, 'b', { standardId: 'toy', placement: 'replace', includeMortar: true });
    expect(out.nodes.some((n) => n.name === 'Mortar Core')).toBe(false);
  });
});

describe('Item 2: physics_timber_breakdown(mode=auto) single tilted roof panel', () => {
  it('classifyTimberAutoMode returns planks when no leg or rail framing members exist', () => {
    expect(
      classifyTimberAutoMode({
        parts: [
          { member: { role: 'panel' } },
          { member: { role: 'panel' } },
          { member: { role: 'panel' } },
          { member: { role: 'panel' } },
        ],
      }),
    ).toBe('planks');

    expect(
      classifyTimberAutoMode({
        parts: [
          { member: { role: 'panel' } },
          { member: { role: 'leg' } },
          { member: { role: 'rail' } },
        ],
      }),
    ).toBe('frame');
  });

  it('classifies a single tilted 550 x 1120 x 24 mm roof panel as planks in auto mode', async () => {
    const roofNode: SceneNode = {
      id: 'roof_panel',
      name: 'Roof Panel',
      type: 'body',
      pos: [0, 0, 1.0],
      euler: [0, -32, 0],
      joints: [],
      children: [],
      geoms: [
        {
          name: 'roof_geom',
          type: 'box',
          // half-extents in metres: 550 x 1120 x 24 mm
          size: [0.275, 0.56, 0.012],
          rgba: [0.65, 0.45, 0.25, 1],
        },
      ],
    };
    const fakeStore = {
      sceneGraph: { nodes: [roofNode] },
      selectedNodeId: 'roof_panel',
      selectedNodeIds: ['roof_panel'],
      cncBed: { widthMm: 600, depthMm: 400, heightMm: 100 },
    } as unknown as ReturnType<typeof useStore.getState>;

    const res = (await partBuildCommands.BREAKDOWN_JOINERY(
      { targetId: 'roof_panel', mode: 'auto', apply: false },
      { store: fakeStore, toId: (v) => v },
    )) as { ok: boolean; mode?: string; planks?: Array<{ id: string }>; buildGuideMarkdown?: string };

    expect(res.ok).toBe(true);
    expect(res.mode).toBe('planks');
    expect(res.planks?.length).toBeGreaterThanOrEqual(1);
    expect(res.buildGuideMarkdown).toBeUndefined();
  }, 30000);
});

describe('Item 3: physics_check_collisions filledCavities excludes already-decomposed bodies', () => {
  const sampleMeshGeom: SceneGeom = {
    name: 'body_mesh',
    type: 'mesh',
    size: [1],
    vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1],
    faces: [0, 1, 2, 0, 1, 3, 1, 2, 3, 0, 2, 3],
  };

  it('skips concave bodies that already have convex decomposition colliders', () => {
    const decomposedWithColliders: SceneNode = {
      id: 'cup_decomposed',
      name: 'Cup Decomposed',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      collisionSolidity: 0.6336,
      collisionDecomposed: true,
      geoms: [
        sampleMeshGeom,
        { ...sampleMeshGeom, name: 'cup_col_0', csgDerived: 'collider', role: 'collision' },
        { ...sampleMeshGeom, name: 'cup_col_1', csgDerived: 'collider', role: 'collision' },
      ],
    };

    const decomposedFlagOnly: SceneNode = {
      id: 'cup_flag',
      name: 'Cup Flag',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      collisionSolidity: 0.6336,
      collisionDecomposed: true,
      geoms: [sampleMeshGeom],
    };

    const genuineHullFallback: SceneNode = {
      id: 'cup_hull',
      name: 'Cup Hull',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      collision: 'hull',
      collisionSolidity: 0.6336,
      geoms: [sampleMeshGeom],
    };
    genuineHullFallback.collisionHash = collisionHashOf(genuineHullFallback);

    const pendingBody: SceneNode = {
      id: 'cup_pending',
      name: 'Cup Pending',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      collisionSolidity: 0.6336,
      geoms: [sampleMeshGeom],
    };

    const filled = collectFilledCavities([decomposedWithColliders, decomposedFlagOnly, genuineHullFallback, pendingBody]);
    expect(filled).toEqual([{ body: 'Cup Hull', solidity: 0.6336 }]);
  });
});

describe('Item 4: reconcile final.settled and digest.settledAtS', () => {
  const bodyFrame = (pos: number[], vel: number[] = [0, 0, 0]) => ({
    pos,
    vel,
    angvel: [0, 0, 0],
    quat: [1, 0, 0, 0],
    xfrc_applied: [0, 0, 0, 0, 0, 0],
  });

  it('never reports a non-null digest.settledAtS when run is shorter than the 0.5s settle window', () => {
    // 0.25s run where body stops at 0.145s — final.settled is false, so digest.settledAtS must be null.
    const frames: HistoryEntry[] = [0, 0.05, 0.1, 0.145, 0.2, 0.25].map((t) => ({
      time: t,
      bodies: {
        box: bodyFrame([0, 0, t < 0.145 ? 0.2 - t : 0.055], [0, 0, t < 0.145 ? -1 : 0]),
      },
      joints: {},
      contacts: [],
    }));
    const final = summarizeTrajectory(frames)!;
    expect(final.settled).toBe(false);

    const digestStandalone = digestTelemetry(frames)!;
    expect(digestStandalone.settledAtS).toBeNull();

    const digestWithFinal = digestTelemetry(frames, { settled: final.settled })!;
    expect(digestWithFinal.settledAtS).toBeNull();
  });

  it('returns settledAtS: null when authoritative final.settled is false (e.g. rocking/creep)', () => {
    const frames: HistoryEntry[] = [0, 0.25, 0.5, 0.75, 1.0].map((t) => ({
      time: t,
      bodies: { rock: bodyFrame([0, 0, 0.1], [0, 0, 0]) },
      joints: {},
      contacts: [],
    }));
    const digest = digestTelemetry(frames, { settled: false })!;
    expect(digest.settledAtS).toBeNull();
  });

  it('reports consistent settledAtS when final.settled is true', () => {
    const frames: HistoryEntry[] = Array.from({ length: 21 }, (_, i) => {
      const t = i * 0.05;
      return {
        time: t,
        bodies: {
          ball: bodyFrame([0, 0, t < 0.2 ? 0.2 - t : 0.0], [0, 0, t < 0.2 ? -1 : 0]),
        },
        joints: {},
        contacts: [],
      };
    });
    const final = summarizeTrajectory(frames)!;
    expect(final.settled).toBe(true);
    const digest = digestTelemetry(frames, { settled: final.settled })!;
    expect(digest.settledAtS).toBeCloseTo(0.2, 3);
  });
});

describe('Item 5: physics_build_scene body-level color propagation', () => {
  it('propagates body-level color to child geoms lacking rgba without overriding explicit geom rgba', () => {
    const node = fillBodyDefaults({
      id: 'painted_box',
      name: 'Painted Box',
      pos: [0, 0, 0.5],
      color: [0.85, 0.25, 0.15, 1],
      geoms: [
        { name: 'g_inherit', type: 'box', size: [0.1, 0.1, 0.1] },
        { name: 'g_explicit', type: 'sphere', size: [0.05], rgba: [0.1, 0.7, 0.2, 1] },
      ],
    } as unknown as Parameters<typeof fillBodyDefaults>[0]);

    expect(node.geoms[0].rgba).toEqual([0.85, 0.25, 0.15, 1]);
    expect(node.geoms[1].rgba).toEqual([0.1, 0.7, 0.2, 1]);
    expect((node as unknown as Record<string, unknown>).color).toBeUndefined();
  });

  it('rejects invalid body-level color', () => {
    expect(() =>
      fillBodyDefaults({
        id: 'bad',
        color: [2, 0, 0, 1],
        geoms: [{ type: 'box', size: [0.1, 0.1, 0.1] }],
      } as unknown as Parameters<typeof fillBodyDefaults>[0]),
    ).toThrow(/color must be/);
  });
});

describe('Item 7: batch physics_set_color support', () => {
  it('updates multiple bodies in a single store transaction and single recompile', async () => {
    const nodeA: SceneNode = {
      id: 'body_a',
      name: 'Wall A',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [{ name: 'ga1', type: 'box', size: [0.1, 0.1, 0.1], rgba: [0.5, 0.5, 0.5, 1] }],
    };
    const nodeB: SceneNode = {
      id: 'body_b',
      name: 'Wall B',
      type: 'body',
      pos: [1, 0, 0],
      joints: [],
      children: [],
      geoms: [
        { name: 'gb1', type: 'box', size: [0.1, 0.1, 0.1], rgba: [0.5, 0.5, 0.5, 0.8] },
        { name: 'gb2', type: 'box', size: [0.1, 0.1, 0.1], rgba: [0.5, 0.5, 0.5, 0.8] },
      ],
    };

    const recompileSpy = vi.fn();
    useStore.setState({
      sceneGraph: { nodes: [nodeA, nodeB] },
      recompile: recompileSpy,
    } as unknown as Partial<ReturnType<typeof useStore.getState>>);

    const store = useStore.getState();
    const res = (await objectCommands.SET_COLOR(
      {
        colors: [
          { id: 'Wall A', rgba: [0.9, 0.1, 0.1, 1] },
          { id: 'body_b', geomName: 'gb2', rgba: [0.1, 0.2, 0.9] },
        ],
      },
      {
        store,
        toId: (v) => (v === 'Wall A' ? 'body_a' : v),
      },
    )) as { ok: boolean; bodiesColored?: number; geomsColored?: number };

    expect(res).toEqual({ ok: true, bodiesColored: 2, geomsColored: 2 });
    expect(recompileSpy).toHaveBeenCalledTimes(1);

    const updated = useStore.getState().sceneGraph.nodes;
    expect(updated[0].geoms[0].rgba).toEqual([0.9, 0.1, 0.1, 1]);
    // gb1 untouched, gb2 updated preserving its 0.8 alpha
    expect(updated[1].geoms[0].rgba).toEqual([0.5, 0.5, 0.5, 0.8]);
    expect(updated[1].geoms[1].rgba).toEqual([0.1, 0.2, 0.9, 0.8]);
  });

  it('rejects empty batch or invalid entry', async () => {
    const store = useStore.getState();
    await expect(objectCommands.SET_COLOR({ colors: [] }, { store, toId: (v) => v })).rejects.toThrow(/non-empty/);
    await expect(
      objectCommands.SET_COLOR({ colors: [{ id: 'missing_body', rgba: [1, 0, 0] }] }, { store, toId: (v) => v }),
    ).rejects.toThrow(/No object/);
  });
});

// Unused import guard for layBricks / decomposeSolidIntoPlanks if needed
void layBricks;
void decomposeSolidIntoPlanks;
