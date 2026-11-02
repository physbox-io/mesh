// What an agent making a mold over MCP ran into, each pinned down: the
// features it could not name, the preview that looked broken, the pour into
// an open mold that came back at 56% without a word, the loose bolt heads a
// watertight check passed, and every export called empty.stl.

import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, moldSummary, DEFAULT_MOLD_OPTIONS, type MoldOptions } from '../src/utils/moldExporter';
import { loadManifold } from '../src/utils/sculptCut';
import { stlToMesh } from '../src/utils/stlMesh';
import { analyzeMesh, meshShells } from '../src/utils/meshIntegrity';
import { simulatedBody } from '../src/utils/simulatedPart';
import { moldOptionsFor, moldSceneParts, pourShortfallWarning } from '../src/utils/moldWorkerClient';
import { meshIntegrity } from '../src/utils/sceneSummary';
import { exportBaseName } from '../src/utils/exportBaseName';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const ball: SceneGraph = {
  nodes: [{ id: 'b1', name: 'ball', type: 'body', pos: [0, 0, 0.03], geoms: [{ name: 'g', type: 'sphere', size: [0.02] } as SceneGeom], joints: [], children: [] }],
};

const CLAMSHELL: Partial<MoldOptions> = { ...DEFAULT_MOLD_OPTIONS, moldType: 'clamshell', pullDirection: '+z' };

/** A unit cube's 8 corners and 12 outward triangles, offset by `at`. */
function cube(at: number[], size = 1, inward = false) {
  const p: number[] = [];
  for (let i = 0; i < 8; i++) p.push(at[0] + (i & 1) * size, at[1] + ((i >> 1) & 1) * size, at[2] + ((i >> 2) & 1) * size);
  const f = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  if (inward) for (let i = 0; i < f.length; i += 3) [f[i + 1], f[i + 2]] = [f[i + 2], f[i + 1]];
  return { p, f };
}

function join(...parts: { p: number[]; f: number[] }[]) {
  const p: number[] = [], f: number[] = [];
  for (const part of parts) {
    const base = p.length / 3;
    p.push(...part.p);
    f.push(...part.f.map((i) => i + base));
  }
  return { p, f };
}

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

describe('mold features in the reply', () => {
  it('names the sprue, vents, pins, sockets and pry notches, and where each is', () => {
    const s = moldSummary(generateMoldMeshes(ball, CLAMSHELL, wasm));
    expect(s.success).toBe(true);
    const f = s.features!;
    expect(f.sprue?.half).toBe('lid half');
    expect(f.sprue?.diaMm).toBe(8);
    expect(f.sprue?.narrowDiaMm).toBe(4);
    expect(f.vents).toHaveLength(2);
    expect(f.vents.every((v) => v.half === 'lid half' && v.diaMm === 1.5)).toBe(true);
    expect(f.pins).toHaveLength(4);
    expect(f.sockets).toHaveLength(4);
    // The notches are on the seam at the side edges, not more sockets or channels.
    expect(f.pryNotches).toHaveLength(2);
    expect(f.pryNotches.every((n) => n.half === 'cavity half' && Math.abs(n.atMm[0]) > s.moldWidthMm / 2 - 2)).toBe(true);
  });

  it('leaves out what was switched off', () => {
    const f = moldSummary(generateMoldMeshes(ball, { ...CLAMSHELL, includeSprue: false, includeVents: false, includePryNotches: false }, wasm)).features!;
    expect(f.sprue).toBeNull();
    expect(f.vents).toHaveLength(0);
    expect(f.pryNotches).toHaveLength(0);
    expect(f.sockets).toHaveLength(4);
  });
});

describe('wall and floor over MCP', () => {
  it('takes wall_mm and floor_mm, and they change the block', () => {
    const { options } = moldOptionsFor({ wallMm: 4, floorMm: 2, pinDiaMm: 3 });
    expect(options.wallMarginMm).toBe(4);
    expect(options.baseThicknessMm).toBe(2);
    expect(options.pinDiameterMm).toBe(3);
    const thin = moldSummary(generateMoldMeshes(ball, { ...CLAMSHELL, wallMarginMm: 4, baseThicknessMm: 2, pinDiameterMm: 3 }, wasm));
    const thick = moldSummary(generateMoldMeshes(ball, CLAMSHELL, wasm));
    expect(thin.moldDepthMm).toBeLessThan(thick.moldDepthMm - 10);
    expect(thin.moldHeightMm).toBeLessThan(thick.moldHeightMm);
  });
});

describe('a lined mold in the scene', () => {
  it('is one geom per printed piece, each closed, where one mesh of all four was not', () => {
    const res = generateMoldMeshes(ball, { ...CLAMSHELL, dissolvableLiner: true, castMaterial: 'epoxy' }, wasm);
    const s = moldSummary(res);
    expect(s.parts.map((p) => p.material)).toEqual(['PLA', 'PVA', 'PLA', 'PVA']);
    const mesh = stlToMesh(res.binarySTL);
    // As one mesh, the shells' and liners' shared faces read as non-manifold.
    expect(analyzeMesh(mesh.positions, mesh.faces)!.closed).toBe(false);
    const node = simulatedBody({ ...mesh, cellMm: 0, toleranceMm: 0 }, {
      modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [-20, -20, 0], modelMaxMm: [20, 20, 40],
    }, { id: 'sim_x', name: 'Mold', kind: 'mold', placement: 'beside', parts: moldSceneParts(s) });
    expect(node.geoms).toHaveLength(4);
    for (const g of node.geoms!) expect(meshIntegrity(g).watertight).toBe(true);
    // The PVA is told apart by colour.
    expect(node.geoms![1].rgba).not.toEqual(node.geoms![0].rgba);
  });

  it('stays one geom when the runs do not add up to the mesh', () => {
    const { p, f } = cube([0, 0, 0]);
    const node = simulatedBody({ positions: new Float32Array(p), faces: new Uint32Array(f), cellMm: 0, toleranceMm: 0 }, {
      modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [0, 0, 0], modelMaxMm: [1, 1, 1],
    }, { id: 'sim_y', name: 'x', kind: 'mold', placement: 'beside', parts: [{ name: 'a', triangles: 5 }, { name: 'b', triangles: 5 }] });
    expect(node.geoms).toHaveLength(1);
  });
});

describe('a pour short of the master', () => {
  const moldNode = (mold: { masterVolumeMm3: number; laidOpen: boolean }): SceneNode => ({
    id: 'm', name: 'Mold', type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms: [],
    simulation: { kind: 'mold', createdAt: '', cellMm: 0, toleranceMm: 0, placement: 'beside', mold },
  });

  it('says a clamshell lying open filled each half on its own', () => {
    const w = pourShortfallWarning(moldNode({ masterVolumeMm3: 1000, laidOpen: true }), 560, 'agent');
    expect(w).toMatch(/56%/);
    expect(w).toMatch(/master_id/);
    expect(pourShortfallWarning(moldNode({ masterVolumeMm3: 1000, laidOpen: true }), 560)).not.toMatch(/physics_/);
  });

  it('flags an open mold that fell short, and keeps quiet when it is full', () => {
    expect(pourShortfallWarning(moldNode({ masterVolumeMm3: 1000, laidOpen: false }), 700)).toMatch(/70%/);
    expect(pourShortfallWarning(moldNode({ masterVolumeMm3: 1000, laidOpen: false }), 990)).toBeNull();
  });

  it('says nothing about a mold it knows no master for', () => {
    const n = moldNode({ masterVolumeMm3: 0, laidOpen: true });
    delete n.simulation!.mold;
    expect(pourShortfallWarning(n, 10)).toBeNull();
  });
});

describe('separate pieces', () => {
  it('counts loose pieces that a watertight check passes', () => {
    const { p, f } = join(cube([0, 0, 0], 10), cube([20, 0, 0]), cube([30, 0, 0]));
    expect(analyzeMesh(p, f)!.closed).toBe(true);
    expect(meshShells(p, f)).toEqual({ shells: 3, pieces: 3, voids: 0 });
    const g = { name: 'g', type: 'mesh', size: [1], renderVertices: p, vertices: p, faces: f } as SceneGeom;
    expect(meshIntegrity(g).pieces).toBe(3);
  });

  it('counts a hollow as one piece with a hollow, not two pieces', () => {
    const { p, f } = join(cube([0, 0, 0], 10), cube([3, 3, 3], 4, true));
    expect(meshShells(p, f)).toEqual({ shells: 2, pieces: 1, voids: 1 });
    const g = { name: 'g', type: 'mesh', size: [1], renderVertices: p, vertices: p, faces: f } as SceneGeom;
    const r = meshIntegrity(g);
    expect(r.pieces).toBeUndefined();
    expect(r.hollows).toBe(1);
  });
});

describe('export names', () => {
  it('does not name a scene built from blank after the empty preset', () => {
    expect(exportBaseName([], 'empty')).toBe('physics_scene');
    expect(exportBaseName([{ id: 'n', markdown: '# Gear housing', minimized: false, x: 0, y: 0 } as never], 'empty')).toBe('gear_housing');
  });
});
