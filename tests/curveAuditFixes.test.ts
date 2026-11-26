import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateCurveGeoms } from '../src/utils/geom';
import { objectReply } from '../src/utils/objectReply';
import { collisionReport } from '../src/utils/sceneSummary';
import { decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import { objectCommands } from '../src/hooks/mcp/objectCommands';
import { viewCommands } from '../src/hooks/mcp/viewCommands';
import { useStore } from '../src/store/useStore';
import { cupMesh, zupToYupFlat } from './helpers/meshes';
import type { SceneGeom, SceneNode } from '../src/types/scene';

/** Quaternion [w, x, y, z] -> angle in degrees between two orientations. */
function quatAngleDeg(q1: number[], q2: number[]): number {
  const dot = Math.abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3]);
  return (2 * Math.acos(Math.min(1, dot)) * 180) / Math.PI;
}

/** Rotate local vector v by unit quaternion q = [w, x, y, z]. */
function rotateByQuat(q: number[], v: [number, number, number]): [number, number, number] {
  const [w, x, y, z] = q;
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

function makeCurveNode(overrides: Record<string, unknown> = {}): SceneNode {
  return fillBodyDefaults({
    id: 'track',
    name: 'Track',
    isCurve: true,
    curvePoints: [[-1, 0, 1], [0, 0, 0.2], [1, 0, 0.8]],
    curveWidth: 0.4,
    curveThickness: 0.05,
    curveSegments: 16,
    rgba: [0.8, 0.3, 0.1, 1],
    ...overrides,
  });
}

describe('Finding 1: physics_update_object regenerates isCurve geometry', () => {
  beforeEach(() => {
    const recompileSpy = vi.fn(async () => {});
    useStore.setState({
      sceneGraph: { nodes: [makeCurveNode()] },
      recompile: recompileSpy,
      lastCompileError: null,
    } as unknown as Partial<ReturnType<typeof useStore.getState>>);
  });

  it('regenerates segment geoms when curveSegments, curveWidth, curveThickness, curveBank, curveClosed, or curvePoints change', async () => {
    const store = useStore.getState();
    const beforeGeoms = store.sceneGraph.nodes[0].geoms;
    expect(beforeGeoms).toHaveLength(16);

    const res1 = (await objectCommands.UPDATE_OBJECT(
      {
        targetId: 'track',
        updates: {
          curveSegments: 24,
          curveWidth: 0.8,
          curveThickness: 0.1,
          curveBank: 15,
          curvePoints: [[-2, 0, 1.5], [0, 0, 0.1], [2, 0, 1.2]],
        },
      },
      { store: useStore.getState() },
    )) as { ok: boolean };

    expect(res1.ok).toBe(true);
    const updated = useStore.getState().sceneGraph.nodes[0];
    expect(updated.geoms).toHaveLength(24);
    expect(updated.geoms[0].size[1]).toBeCloseTo(0.4, 6); // width / 2
    expect(updated.geoms[0].size[2]).toBeCloseTo(0.05, 6); // thickness / 2
    expect(updated.geoms[0].pos).not.toEqual(beforeGeoms[0].pos);
    expect(updated.geoms[0].rgba).toEqual([0.8, 0.3, 0.1, 1]);

    // Toggle curveClosed: true
    const res2 = (await objectCommands.UPDATE_OBJECT(
      {
        targetId: 'track',
        updates: {
          curveClosed: true,
          curveSegments: 20,
          curvePoints: [[1, 0, 0.2], [0, 1, 0.2], [-1, 0, 0.2], [0, -1, 0.2]],
        },
      },
      { store: useStore.getState() },
    )) as { ok: boolean };
    expect(res2.ok).toBe(true);
    const closedNode = useStore.getState().sceneGraph.nodes[0];
    expect(closedNode.curveClosed).toBe(true);
    expect(closedNode.geoms).toHaveLength(20);
  });

  it('regenerates curve geoms instead of wiping to [] when geoms: [] is passed', async () => {
    const res = (await objectCommands.UPDATE_OBJECT(
      {
        targetId: 'track',
        updates: { geoms: [], curveSegments: 12 },
      },
      { store: useStore.getState() },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);
    const updated = useStore.getState().sceneGraph.nodes[0];
    expect(updated.geoms).toHaveLength(12);
  });

  it('generates curve geoms when isCurve becomes true on an existing body', async () => {
    const boxNode: SceneNode = {
      id: 'plain_box',
      name: 'Plain Box',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [{ name: 'b0', type: 'box', size: [0.1, 0.1, 0.1], rgba: [0.2, 0.7, 0.4, 1] }],
    };
    useStore.setState({
      sceneGraph: { nodes: [boxNode] },
    } as unknown as Partial<ReturnType<typeof useStore.getState>>);

    const res = (await objectCommands.UPDATE_OBJECT(
      {
        targetId: 'plain_box',
        updates: { isCurve: true, curveSegments: 10 },
      },
      { store: useStore.getState() },
    )) as { ok: boolean };

    expect(res.ok).toBe(true);
    const updated = useStore.getState().sceneGraph.nodes[0];
    expect(updated.isCurve).toBe(true);
    expect(updated.geoms).toHaveLength(10);
    expect(updated.geoms[0].name).toBe('plain_box_seg0');
    expect(updated.geoms[0].rgba).toEqual([0.2, 0.7, 0.4, 1]);
  });

  it('rejects invalid curve parameters in physics_update_object', async () => {
    const badWidth = (await objectCommands.UPDATE_OBJECT(
      { targetId: 'track', updates: { curveWidth: -0.5 } },
      { store: useStore.getState() },
    )) as { ok: boolean; error?: string };
    expect(badWidth.ok).toBe(false);
    expect(badWidth.error).toMatch(/curveWidth/);

    const badPts = (await objectCommands.UPDATE_OBJECT(
      { targetId: 'track', updates: { curvePoints: [[0, 0, 0]] } },
      { store: useStore.getState() },
    )) as { ok: boolean; error?: string };
    expect(badPts.ok).toBe(false);
    expect(badPts.error).toMatch(/curvePoints/);
  });
});

describe('Finding 2: isCurve parallel transport (Bishop frame) avoids vertical-tangent gimbal flip', () => {
  it('smoothly traverses vertical tangents (roller-coaster vertical loop) without quaternion snap or center jump', () => {
    // Vertical loop in the XZ plane passing straight up (+Z), upside down (-X), and straight down (-Z)
    const loopPts: number[][] = [];
    const R = 1.0;
    for (let i = 0; i < 12; i++) {
      const a = -Math.PI / 2 + (i / 12) * Math.PI * 2;
      loopPts.push([R * Math.cos(a), 0, R + R * Math.sin(a)]);
    }
    const geoms = generateCurveGeoms('loop', loopPts, 0.3, 0.06, 48, [0.9, 0.4, 0.1, 1], true, 0);
    expect(geoms).toHaveLength(48);

    // Adjacent segment orientation change must be smooth (~360/48 = 7.5 deg), never a ~90 deg gimbal snap.
    let maxAngleDeg = 0;
    let maxCenterStep = 0;
    const expectedStep = (2 * Math.PI * R) / 48;
    for (let i = 0; i < geoms.length; i++) {
      const curr = geoms[i];
      const next = geoms[(i + 1) % geoms.length];
      maxAngleDeg = Math.max(maxAngleDeg, quatAngleDeg(curr.quat!, next.quat!));
      const p1 = curr.pos!;
      const p2 = next.pos!;
      const dist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]);
      maxCenterStep = Math.max(maxCenterStep, dist);
    }

    expect(maxAngleDeg).toBeLessThan(15);
    expect(maxCenterStep).toBeLessThan(expectedStep * 1.5);
  });

  it('keeps horizontal planar tracks backward-compatible with world-up +Z surface normal', () => {
    const oval = [
      [1.5, 0, 0.2],
      [0, 1.0, 0.2],
      [-1.5, 0, 0.2],
      [0, -1.0, 0.2],
    ];
    const geoms = generateCurveGeoms('oval', oval, 0.5, 0.06, 32, [0.8, 0.5, 0.2, 1], true, 0);
    expect(geoms).toHaveLength(32);
    for (const g of geoms) {
      const zAxis = rotateByQuat(g.quat!, [0, 0, 1]);
      expect(zAxis[0]).toBeCloseTo(0, 5);
      expect(zAxis[1]).toBeCloseTo(0, 5);
      expect(zAxis[2]).toBeCloseTo(1, 5);
      // Center sits half a thickness below z = 0.2
      expect(g.pos![2]).toBeCloseTo(0.2 - 0.03, 5);
    }
  });

  it('distributes residual twist smoothly around a closed 3D curve', () => {
    // Non-planar 3D trefoil-like closed loop that accumulates holonomy under pure parallel transport
    const pts: number[][] = [];
    for (let i = 0; i < 16; i++) {
      const t = (i / 16) * Math.PI * 2;
      pts.push([
        Math.cos(t) + 0.35 * Math.cos(2 * t),
        Math.sin(t) - 0.35 * Math.sin(2 * t),
        0.8 + 0.45 * Math.sin(3 * t),
      ]);
    }
    const geoms = generateCurveGeoms('knot', pts, 0.2, 0.04, 64, [0.2, 0.6, 0.9, 1], true, 10);
    expect(geoms).toHaveLength(64);

    // The seam between last segment and first segment must be as smooth as interior transitions.
    const seamAngle = quatAngleDeg(geoms[geoms.length - 1].quat!, geoms[0].quat!);
    expect(seamAngle).toBeLessThan(20);
  });
});

describe('Finding 3: physics_get_object(full=false) summarizes isCurve geoms', () => {
  it('omits generated curve segment boxes when full=false and includes them when full=true', async () => {
    const track = makeCurveNode({ curveSegments: 40, curveBank: 12, curveClosed: true });
    expect(track.geoms).toHaveLength(40);

    const compact = objectReply(track) as {
      geoms: SceneGeom[];
      geomCount?: number;
      curve?: {
        segments: number;
        controlPoints?: number;
        widthMm?: number;
        thicknessMm?: number;
        closed?: boolean;
        bankDeg?: number;
      };
    };
    expect(compact.geoms).toEqual([]);
    expect(compact.geomCount).toBe(40);
    expect(compact.curve).toEqual({
      segments: 40,
      controlPoints: 3,
      widthMm: 400,
      thicknessMm: 50,
      closed: true,
      bankDeg: 12,
    });

    const full = objectReply(track, { full: true }) as { geoms: SceneGeom[]; geomCount?: number; curve?: unknown };
    expect(full.geoms).toHaveLength(40);
    expect(full.geomCount).toBeUndefined();
    expect(full.curve).toBeUndefined();

    // Also verify through GET_OBJECT MCP command
    useStore.setState({
      sceneGraph: { nodes: [track] },
      model: null,
      data: null,
    } as unknown as Partial<ReturnType<typeof useStore.getState>>);
    const mcpCompact = (await viewCommands.GET_OBJECT(
      { targetId: 'track' },
      { store: useStore.getState() },
    )) as { geoms: SceneGeom[]; geomCount?: number; curve?: { segments: number } };
    expect(mcpCompact.geoms).toEqual([]);
    expect(mcpCompact.geomCount).toBe(40);
    expect(mcpCompact.curve?.segments).toBe(40);

    const mcpFull = (await viewCommands.GET_OBJECT(
      { targetId: 'track', full: true },
      { store: useStore.getState() },
    )) as { geoms: SceneGeom[] };
    expect(mcpFull.geoms).toHaveLength(40);
  });
});

describe('Finding 4: physics_set_color on isCurve body syncs node.rgba', () => {
  beforeEach(() => {
    const recompileSpy = vi.fn(async () => {});
    useStore.setState({
      sceneGraph: { nodes: [makeCurveNode()] },
      recompile: recompileSpy,
      lastCompileError: null,
    } as unknown as Partial<ReturnType<typeof useStore.getState>>);
  });

  it('syncs node.rgba on single SET_COLOR so subsequent physics_update_object preserves the new color', async () => {
    const colorRes = (await objectCommands.SET_COLOR(
      { targetId: 'track', rgba: [0.1, 0.5, 0.9, 1] },
      { store: useStore.getState() },
    )) as { ok: boolean; geomsColored: number };
    expect(colorRes.ok).toBe(true);
    expect(colorRes.geomsColored).toBe(16);

    const afterColor = useStore.getState().sceneGraph.nodes[0] as SceneNode & { rgba?: number[] };
    expect(afterColor.rgba).toEqual([0.1, 0.5, 0.9, 1]);
    expect(afterColor.geoms[0].rgba).toEqual([0.1, 0.5, 0.9, 1]);

    // Subsequent curve re-tessellation via UPDATE_OBJECT must preserve [0.1, 0.5, 0.9, 1]
    const updateRes = (await objectCommands.UPDATE_OBJECT(
      { targetId: 'track', updates: { curveSegments: 20 } },
      { store: useStore.getState() },
    )) as { ok: boolean };
    expect(updateRes.ok).toBe(true);

    const afterUpdate = useStore.getState().sceneGraph.nodes[0];
    expect(afterUpdate.geoms).toHaveLength(20);
    for (const g of afterUpdate.geoms) {
      expect(g.rgba).toEqual([0.1, 0.5, 0.9, 1]);
    }
  });

  it('syncs node.rgba on batch SET_COLOR for isCurve bodies', async () => {
    const batchRes = (await objectCommands.SET_COLOR(
      { colors: [{ id: 'track', rgba: [0.2, 0.8, 0.3, 1] }] },
      { store: useStore.getState() },
    )) as { ok: boolean; bodiesColored: number; geomsColored: number };
    expect(batchRes).toEqual({ ok: true, bodiesColored: 1, geomsColored: 16 });

    const afterColor = useStore.getState().sceneGraph.nodes[0] as SceneNode & { rgba?: number[] };
    expect(afterColor.rgba).toEqual([0.2, 0.8, 0.3, 1]);
  });
});

describe('Finding 5: suppress misleading mass collisionWarning when node.mass is already set', () => {
  it('omits massWarning in decomposeNodeColliders when node.mass is explicitly set', async () => {
    const m = cupMesh({ outerR: 0.05, innerR: 0.04, height: 0.08, baseThickness: 0.01 });
    const baseCup: SceneNode = {
      id: 'cup',
      name: 'cup',
      type: 'body',
      pos: [0, 0, 0.1],
      joints: [{ name: 'cup_free', type: 'free' }],
      children: [],
      geoms: [{
        name: 'cup_mesh',
        type: 'mesh',
        size: [1],
        dynamic: true,
        renderVertices: m.verts,
        vertices: zupToYupFlat(m.verts),
        faces: m.faces,
      }],
    };

    const withoutMass = (await decomposeNodeColliders(baseCup))!;
    expect(withoutMass.geoms.length).toBeGreaterThan(1);
    expect(withoutMass.warning).toMatch(/Set a mass if you wanted the heavier figure/);

    const withMass = (await decomposeNodeColliders({ ...baseCup, mass: 0.5 }))!;
    expect(withMass.geoms.length).toBeGreaterThan(1);
    expect(withMass.warning).toBeUndefined();
  }, 120_000);

  it('suppresses stale mass collisionWarning in collisionReport when node.mass != null while keeping other warnings', () => {
    const base: SceneNode = {
      id: 'hollow',
      name: 'hollow',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      collisionDecomposed: true,
      collisionSolidity: 0.35,
      collisionWarning: 'Weighed by its real volume now that it collides as convex pieces, this body weighs 50 g rather than the 200 g of its convex hull, which counted the space between and inside its parts as solid. Set a mass if you wanted the heavier figure.',
      geoms: [
        { name: 'col0', type: 'mesh', size: [1], csgDerived: 'collider', role: 'collision' },
      ],
    };

    expect(collisionReport(base).collisionWarning).toMatch(/Set a mass/);
    expect(collisionReport({ ...base, mass: 0.25 }).collisionWarning).toBeUndefined();

    // Unrelated warnings (e.g. cavity filled) must still be shown even when mass is set.
    const cavity = {
      ...base,
      mass: 0.25,
      collisionWarning: 'A cavity about 20 x 20 x 20 mm around (0, 0, 10) mm is filled in by col0.',
    };
    expect(collisionReport(cavity).collisionWarning).toMatch(/cavity/);
  });
});
