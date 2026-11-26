import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  boxLattice,
  createLattice,
  DEFAULT_UNIT,
  inconsistentFaces,
  isWatertight,
  latticeStats,
  toSceneGeom,
} from '../src/utils/latticeMesh';
import {
  addFacesMm,
  bevelFaceMm,
  dimensionSelectionBatchMm,
  extrudeMm,
  revolveMm,
  sharpenEdgesMm,
} from '../src/utils/latticeCommands';
import { latticeCommands } from '../src/hooks/mcp/latticeCommands';
import { runLatticeOps } from '../src/hooks/mcp/latticeState';
import { dfmCommands } from '../src/hooks/mcp/dfmCommands';
import { sectionCommands } from '../src/hooks/mcp/sectionCommands';
import { sceneCommands } from '../src/hooks/mcp/sceneCommands';
import { castCommands } from '../src/hooks/mcp/castCommands';
import { applySingleCutToBody } from '../src/hooks/mcp/bodyFeatures';
import { useStore } from '../src/store/useStore';
import { boxMesh, zupToYupFlat } from './helpers/meshes';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const meshBody = (m: { verts: number[]; faces: number[] }, extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'part',
  name: 'part',
  type: 'body',
  pos: [0, 0, 0],
  joints: [],
  children: [],
  geoms: [{
    name: 'part_mesh',
    type: 'mesh',
    size: [1],
    renderVertices: m.verts,
    vertices: zupToYupFlat(m.verts),
    faces: m.faces,
  } as SceneGeom],
  ...extra,
});

const boxBody = (
  c: [number, number, number],
  h: [number, number, number],
  id: string,
  extra: Partial<SceneNode> = {},
): SceneNode => meshBody(boxMesh(c, h), { id, name: id, ...extra });

describe('Item 1: physics_lattice_extrude explicit axis sign convention', () => {
  it('extrudes a -y-facing face toward -y when axis="y" and distanceMm=-8 (both solid and lone face)', () => {
    // Solid box: 40x40x40 mm, centered at origin -> y in [-20, 20]
    const lat = boxLattice(DEFAULT_UNIT, 200);
    const negYFace = [
      [-20, -20, -20],
      [20, -20, -20],
      [20, -20, 20],
      [-20, -20, 20],
    ];
    const res = extrudeMm(lat, negYFace, -8, 'y');
    // Cap should move to y = -28 (NOT -12!)
    expect(res.cap.every((p) => p[1] === -28)).toBe(true);
    expect(isWatertight(lat)).toBe(true);
    expect(inconsistentFaces(lat)).toBe(0);

    // Lone -y-facing quad:
    const lone = createLattice(DEFAULT_UNIT);
    // Winding for -y outward normal: (-x,-z) -> (+x,-z) -> (+x,+z) -> (-x,+z) has normal -Y
    addFacesMm(lone, [[[-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10]]]);
    const loneRes = extrudeMm(lone, [[-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10]], -8, 'y');
    expect(loneRes.cap.every((p) => p[1] === -8)).toBe(true);
    expect(isWatertight(lone)).toBe(true);
    expect(inconsistentFaces(lone)).toBe(0);

    // Lone -y-facing quad extruded toward +y with explicit axis="y" and distanceMm=+8:
    const lonePos = createLattice(DEFAULT_UNIT);
    addFacesMm(lonePos, [[[-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10]]]);
    const lonePosRes = extrudeMm(lonePos, [[-10, 0, -10], [10, 0, -10], [10, 0, 10], [-10, 0, 10]], 8, 'y');
    expect(lonePosRes.cap.every((p) => p[1] === 8)).toBe(true);
    expect(isWatertight(lonePos)).toBe(true);
    expect(inconsistentFaces(lonePos)).toBe(0);
  });

  it('preserves face-normal sign when axis is omitted and mirrors symmetrically when axis === mirror', () => {
    const lat = boxLattice(DEFAULT_UNIT, 200);
    const negYFace = [
      [-20, -20, -20],
      [20, -20, -20],
      [20, -20, 20],
      [-20, -20, 20],
    ];
    // Without axis: positive distanceMm pushes outward along -y normal -> y = -28
    const res = extrudeMm(lat, negYFace, 8);
    expect(res.cap.every((p) => p[1] === -28)).toBe(true);
    expect(isWatertight(lat)).toBe(true);
    expect(inconsistentFaces(lat)).toBe(0);

    // Explicit axis === mirror: extruding +x face by +10 with mirror='x' pushes +x to +30 and -x to -30
    const mirrored = boxLattice(DEFAULT_UNIT, 200);
    const posXFace = [
      [20, -20, -20],
      [20, 20, -20],
      [20, 20, 20],
      [20, -20, 20],
    ];
    extrudeMm(mirrored, posXFace, 10, 'x', 'x');
    const stats = latticeStats(mirrored);
    expect(stats.watertight).toBe(true);
    expect(stats.inconsistent).toBe(0);
    const geom = toSceneGeom(mirrored);
    const xs: number[] = [];
    for (let i = 0; i < geom.renderVertices.length; i += 3) xs.push(geom.renderVertices[i]);
    const spanXMm = Math.round((Math.max(...xs) - Math.min(...xs)) * 1000);
    expect(spanXMm).toBe(60); // 40 + 10 on +x + 10 on -x
  });
});

describe('Item 2: physics_lattice_extrude docs match auto-capping behavior', () => {
  it('auto-caps a lone extruded polygon and mcp-docs.json documents auto-capping', () => {
    const lat = createLattice(DEFAULT_UNIT);
    const quad = [[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 20, 0]];
    addFacesMm(lat, [quad]);
    extrudeMm(lat, quad, 10);
    expect(isWatertight(lat)).toBe(true);

    const docs = JSON.parse(readFileSync(resolve(process.cwd(), 'mcp-docs.json'), 'utf8'));
    const extrudeDoc: string = docs.tools.physics_lattice_extrude;
    expect(extrudeDoc).not.toContain('still an open shell');
    expect(extrudeDoc).toMatch(/back cap|watertight: true/i);
  });
});

describe('Item 3: physics_check_dfm & physics_section exclude welded and seated hardware by default', () => {
  const buildHardwareAssembly = (): SceneGraph => {
    const seatedScrew = boxBody([0, 0, 0.02], [0.0025, 0.0025, 0.006], 'm5_screw', {
      hardwarePart: { kind: 'screw', size: 'M5' } as SceneNode['hardwarePart'],
    });
    const plate = boxBody([0, 0, 0.01], [0.025, 0.025, 0.01], 'bracket_plate', {
      children: [seatedScrew],
    });
    const weldedNut = boxBody([0.04, 0, 0.005], [0.004, 0.004, 0.004], 'm5_hex_nut', {
      hardwarePart: { kind: 'nut', size: 'M5' } as SceneNode['hardwarePart'],
      weldTargetId: 'bracket_plate',
    });
    return { nodes: [plate, weldedNut] } as SceneGraph;
  };

  it('excludes welded top-level hardware and seated child hardware from whole-scene CHECK_DFM', async () => {
    const scene = buildHardwareAssembly();
    const res = await dfmCommands.CHECK_DFM(
      { process: 'print' },
      { store: { ...useStore.getState(), sceneGraph: scene }, toId: (v: unknown) => v } as never,
    ) as Record<string, unknown>;

    expect(res.ok).toBe(true);
    const checked = res.checked as { label: string; ids: string[] };
    expect(checked.ids).toEqual(['bracket_plate']);
    expect(checked.label).toBe('bracket_plate');
  });

  it('excludes welded top-level hardware from whole-scene SECTION, while allowing explicit body_id targeting', async () => {
    const scene = buildHardwareAssembly();
    const whole = await sectionCommands.SECTION(
      { axis: 'z', atMm: 10 },
      { store: { ...useStore.getState(), sceneGraph: scene }, toId: (v: unknown) => v } as never,
    ) as Record<string, unknown>;

    expect(whole.ok).toBe(true);
    const cut = whole.cut as { label: string; ids: string[] };
    expect(cut.ids).toEqual(['bracket_plate']);
    expect(cut.label).toBe('bracket_plate');

    // Explicitly targeting the welded nut should still slice it:
    const explicit = await sectionCommands.SECTION(
      { axis: 'z', atMm: 5, bodyId: 'm5_hex_nut' },
      { store: { ...useStore.getState(), sceneGraph: scene }, toId: (v: unknown) => v } as never,
    ) as Record<string, unknown>;

    expect(explicit.ok).toBe(true);
    expect((explicit.cut as { ids: string[] }).ids).toEqual(['m5_hex_nut']);
    expect((explicit.pieces as unknown[]).length).toBeGreaterThan(0);
  });
});

describe('Item 4: export filename resets after deleting preset + lightweight scene rename', () => {
  beforeEach(() => {
    const box = boxBody([0, 0, 0.02], [0.02, 0.02, 0.02], 'pendulum_bob');
    useStore.setState({
      sceneGraph: { name: 'pendulum', nodes: [box] } as SceneGraph,
      activePreset: 'pendulum',
    });
  });

  it('clears stale preset name when all preset bodies are deleted so exports use the new body name', async () => {
    useStore.getState().deleteNode('pendulum_bob');
    expect(useStore.getState().sceneGraph.nodes).toHaveLength(0);
    expect(useStore.getState().sceneGraph.name).toBeUndefined();
    expect(useStore.getState().activePreset).toBe('empty');

    // Add two new parts (no explicit scene name):
    const partA = boxBody([0, 0, 0.01], [0.02, 0.02, 0.01], 'clamp_base');
    const partB = boxBody([0.05, 0, 0.01], [0.02, 0.02, 0.01], 'clamp_jaw');
    useStore.getState().updateScene({ ...useStore.getState().sceneGraph, nodes: [partA, partB] }, true);

    const exported = await castCommands.EXPORT_PRINT(
      { format: 'stl', includeFiles: false },
      { store: useStore.getState(), toId: (v: unknown) => v } as never,
    ) as { ok: boolean; files: { name: string }[] };

    expect(exported.ok).toBe(true);
    expect(exported.files[0].name).toBe('clamp_base.stl');
    expect(exported.files[0].name).not.toContain('pendulum');
  });

  it('supports lightweight scene rename via SET_ENVIRONMENT(name=...)', async () => {
    const res = await sceneCommands.SET_ENVIRONMENT(
      { name: 'vise_assembly' },
      { store: useStore.getState() } as never,
    ) as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.name).toBe('vise_assembly');
    expect(useStore.getState().sceneGraph.name).toBe('vise_assembly');
    expect(useStore.getState().activePreset).toBe('empty');

    const exported = await castCommands.EXPORT_PRINT(
      { format: 'stl', includeFiles: false },
      { store: useStore.getState(), toId: (v: unknown) => v } as never,
    ) as { ok: boolean; files: { name: string }[] };

    expect(exported.ok).toBe(true);
    expect(exported.files[0].name).toBe('vise_assembly.stl');

    // Clearing the name with null or empty string works cleanly:
    const cleared = await sceneCommands.SET_ENVIRONMENT(
      { name: null },
      { store: useStore.getState() } as never,
    ) as Record<string, unknown>;
    expect(cleared.ok).toBe(true);
    expect(cleared.name).toBeNull();
    expect(useStore.getState().sceneGraph.name).toBeUndefined();
  });
});

describe('Item 5: physics_lattice_bevel returns new face corners', () => {
  it('returns the bevelled polygon corners ready to pass straight into extrude', () => {
    const lat = createLattice(DEFAULT_UNIT);
    const square = [[-10, -10, 0], [10, -10, 0], [10, 10, 0], [-10, 10, 0]];
    addFacesMm(lat, [square]);

    const bevelRes = bevelFaceMm(lat, square, 3);
    expect(bevelRes.amountMm).toBe(3);
    expect(bevelRes.corners).toHaveLength(8);

    // Chaining straight into extrudeMm without calling describeLattice:
    const extRes = extrudeMm(lat, bevelRes.corners, 12);
    expect(extRes.sides).toBe(8);
    expect(extRes.cap).toHaveLength(8);
    expect(isWatertight(lat)).toBe(true);
  });
});

describe('Item 6: physics_lattice_dimension batch dimensions parameter', () => {
  it('modifies multiple axes and modes in one call while keeping single-axis backward compatibility', () => {
    const lat = boxLattice(DEFAULT_UNIT, 200); // 40x40x40 mm, centered at 0
    const topFace = [
      [-20, -20, 20],
      [20, -20, 20],
      [20, 20, 20],
      [-20, 20, 20],
    ];

    const batch = dimensionSelectionBatchMm(lat, topFace, [
      { axis: 'x', mode: 'size', valueMm: 20 },
      { axis: 'y', mode: 'size', valueMm: 30 },
      { axis: 'z', mode: 'position', valueMm: 35 },
    ]);

    expect(batch.changed).toBe(true);
    expect(batch.applied).toBe(3);
    expect(batch.corners).toHaveLength(4);
    const xs = batch.corners.map((c) => c[0]);
    const ys = batch.corners.map((c) => c[1]);
    const zs = batch.corners.map((c) => c[2]);
    expect(Math.max(...xs) - Math.min(...xs)).toBe(20);
    expect(Math.max(...ys) - Math.min(...ys)).toBe(30);
    expect(zs.every((z) => z === 35)).toBe(true);

    // Also works inside runLatticeOps:
    const lat2 = boxLattice(DEFAULT_UNIT, 200);
    const opsRes = runLatticeOps(lat2, [{
      op: 'dimension',
      corners: topFace,
      dimensions: [
        { axis: 'x', mode: 'size', valueMm: 16 },
        { axis: 'z', mode: 'position', valueMm: 28 },
      ],
    }]);
    expect(opsRes.results[0].changed).toBe(true);
    expect(opsRes.results[0].applied).toBe(2);
  });
});

describe('Item 7: physics_cut frame="cage" coordinate conversion on lattice bodies', () => {
  it('converts cage-frame mm coordinates to body frame for off-origin lattice bodies', () => {
    // Build a 40x40x20 mm lattice box spanning x:[0,40], y:[0,40], z:[0,20] in cage frame
    // -> centroid / latticeOrigin is [0.02, 0.02, 0.01] m!
    const lat = createLattice(DEFAULT_UNIT);
    const base = [[0, 0, 0], [40, 0, 0], [40, 40, 0], [0, 40, 0]];
    addFacesMm(lat, [base]);
    extrudeMm(lat, base, 20);
    const geom = toSceneGeom(lat);

    const latticeNode: SceneNode = {
      id: 'off_origin_plate',
      name: 'off_origin_plate',
      type: 'body',
      pos: [0.02, 0.02, 0.01],
      joints: [],
      children: [],
      isLattice: true,
      latticeOrigin: geom.origin,
      geoms: [{
        name: 'off_origin_plate_mesh',
        type: 'mesh',
        size: [1],
        dynamic: true,
        latticeGeom: true,
        vertices: geom.vertices,
        renderVertices: geom.renderVertices,
        faces: geom.faces,
      } as SceneGeom],
    };

    const nonLattice = boxBody([0, 0, 0.01], [0.02, 0.02, 0.01], 'plain_box');
    useStore.setState({ sceneGraph: { nodes: [latticeNode, nonLattice] } as SceneGraph });

    // Cut at cage centre [20, 20, 20] mm (which is body-frame [0, 0, 10] mm):
    const res = applySingleCutToBody('off_origin_plate', {
      shape: 'hole',
      at: [20, 20, 20],
      normal: [0, 0, 1],
      diameterMm: 6,
      frame: 'cage',
    });
    expect(res.ok).toBe(true);
    // Body-frame landing point should be near [0, 0, 10] mm (NOT [20, 20, 10]!)
    const atMm = res.atMm as number[];
    expect(Math.abs(atMm[0])).toBeLessThan(0.5);
    expect(Math.abs(atMm[1])).toBeLessThan(0.5);
    expect(Math.abs(atMm[2] - 10)).toBeLessThan(0.5);

    // Rejects frame='cage' on non-lattice bodies and rejects invalid frame values:
    const badTarget = applySingleCutToBody('plain_box', {
      shape: 'hole',
      at: [0, 0, 10],
      normal: [0, 0, 1],
      diameterMm: 4,
      frame: 'cage',
    });
    expect(badTarget.ok).toBe(false);
    expect(String(badTarget.error)).toMatch(/lattice/i);

    const badFrame = applySingleCutToBody('off_origin_plate', {
      shape: 'hole',
      at: [0, 0, 10],
      normal: [0, 0, 1],
      diameterMm: 4,
      frame: 'world',
    });
    expect(badFrame.ok).toBe(false);
    expect(String(badFrame.error)).toMatch(/body.*cage/i);
  });
});

describe('Item 8: physics_create_lattice with thicknessMm distinguishes cageWatertight vs watertight', () => {
  it('reports cageWatertight=false and watertight=true when thicknessMm thickens an open shell', async () => {
    useStore.setState({
      sceneGraph: { nodes: [] } as SceneGraph,
      recompile: async () => undefined,
    } as never);

    // Create an open cup shell (5 faces of a box, top removed) with thicknessMm=2:
    const res = await latticeCommands.CREATE_LATTICE(
      {
        name: 'open_cup',
        sizeMm: 40,
        thicknessMm: 2,
        ops: [
          {
            op: 'delete_faces',
            faces: [[[-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]]],
          },
        ],
      },
      { store: useStore.getState() } as never,
    ) as Record<string, unknown>;

    expect(res.ok).toBe(true);
    expect(res.cageWatertight).toBe(false);
    expect(res.watertight).toBe(true);
  });
});

describe('Item 9: physics_lattice_revolve returns ringEdges for chaining sharpen(loop=true)', () => {
  it('returns one representative circumferential edge per non-pole profile ring', () => {
    const lat = createLattice(DEFAULT_UNIT);
    // Profile with a pole on axis [0,0,30] and 3 off-axis rings:
    const profile = [
      [0, 0, 30],   // pole -> skipped
      [10, 0, 28],  // ring 0
      [14, 0, 10],  // ring 1
      [10, 0, 0],   // ring 2
    ];
    const rev = revolveMm(lat, profile, 'z', 360, { segments: 12 });
    expect(rev.ringEdges).toHaveLength(3);
    // Each ringEdge is a pair of distinct 3D mm points at the corresponding ring's Z height:
    expect(rev.ringEdges[0][0][2]).toBe(28);
    expect(rev.ringEdges[0][1][2]).toBe(28);
    expect(rev.ringEdges[1][0][2]).toBe(10);
    expect(rev.ringEdges[2][0][2]).toBe(0);

    // Pass ringEdges directly into sharpenEdgesMm with loop=true -> creases all 12 segments of each ring!
    const sharp = sharpenEdgesMm(lat, [rev.ringEdges[0], rev.ringEdges[2]], true, undefined, true);
    expect(sharp.skipped).toHaveLength(0);
    expect(sharp.changed).toBe(24);
  });
});
