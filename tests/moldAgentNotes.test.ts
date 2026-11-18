// What an agent making a mold over MCP ran into, each pinned down: the
// features it could not name, the preview that looked broken, the pour into
// an open mold that came back at 56% without a word, the loose bolt heads a
// watertight check passed, and every export called empty.stl.

import { describe, it, expect, beforeAll } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, moldSummary, DEFAULT_MOLD_OPTIONS, type MoldOptions, type Triangle3D } from '../src/utils/moldExporter';
import { loadManifold } from '../src/utils/sculptCut';
import { stlToMesh } from '../src/utils/stlMesh';
import { analyzeMesh, meshShells } from '../src/utils/meshIntegrity';
import { simulatedBody } from '../src/utils/simulatedPart';
import { moldMasterRecord, moldOptionsFor, moldSceneParts, pourShortfallWarning } from '../src/utils/moldWorkerClient';
import { simulateCastFromMoldNode } from '../src/utils/moldCastSimulation';
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
    // A funnel in the lid's face, then epoxy's 6 mm neck.
    expect(f.sprue?.narrowDiaMm).toBe(6);
    expect(f.sprue!.diaMm).toBeGreaterThan(f.sprue!.narrowDiaMm!);
    expect(f.sprue!.depthMm).toBeGreaterThan(0);
    // Filled from the bottom, and a vent from the ball's one high point.
    expect(f.feed).toBe('bottom');
    expect(f.downSprue?.half).toBe('cavity half');
    expect(f.gate?.diaMm).toBeGreaterThan(0);
    expect(f.vents).toHaveLength(1);
    expect(f.vents.every((v) => v.half === 'lid half' && v.diaMm === 4)).toBe(true);
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

describe('a pour into a clamshell lying open', () => {
  // It filled each half on its own: a lined gear sculpture came back at 56%
  // of the master, its gears half as thick, with a warning instead of a casting.
  for (const lined of [false, true]) {
    it(`closes the ${lined ? 'lined ' : ''}mold first and casts the whole part`, async () => {
      const res = generateMoldMeshes(ball, { ...CLAMSHELL, dissolvableLiner: lined, castMaterial: 'epoxy' }, wasm);
      const s = moldSummary(res);
      const mesh = stlToMesh(res.binarySTL);
      const node = simulatedBody({ ...mesh, cellMm: 0, toleranceMm: 0 }, {
        modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [-20, -20, 0], modelMaxMm: [20, 20, 40],
      }, { id: 'sim_x', name: 'Mold', kind: 'mold', placement: 'beside', parts: moldSceneParts(s) });
      const record = moldMasterRecord(ball, s);
      node.simulation = { ...node.simulation!, mold: record };
      const ballMm3 = record.masterVolumeMm3;
      // Wherever it has been dragged to.
      node.pos = [0.31, -0.047, 0.002];
      // Trimmed: the bottom fill's runner comes off along its own bore.
      const cast = await simulateCastFromMoldNode(node, { trimChannels: true });
      expect(cast.success, cast.error).toBe(true);
      // The ball, and a little of the sprue and vents.
      expect(cast.castVolumeMm3).toBeGreaterThan(ballMm3 * 0.97);
      expect(cast.castVolumeMm3).toBeLessThan(ballMm3 * 1.08);
      expect(cast.sizeMm.width).toBeCloseTo(40, 0);
      expect(pourShortfallWarning(node, cast.castVolumeMm3)).toBeNull();
    });
  }
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

describe('separable and clip-clamped rigid molds', () => {
  const trisToManifold = (tris: Triangle3D[]): Manifold => {
    const vp = new Float32Array(tris.length * 9);
    const tv = new Uint32Array(tris.length * 3);
    tris.forEach((t, i) => {
      vp.set([...t.a, ...t.b, ...t.c], i * 9);
      tv[i * 3] = i * 3;
      tv[i * 3 + 1] = i * 3 + 1;
      tv[i * 3 + 2] = i * 3 + 2;
    });
    const m = new wasm.Mesh({ numProp: 3, vertProperties: vp, triVerts: tv });
    m.merge();
    const solid = new wasm.Manifold(m);
    expect(solid.status()).toBe('NoError');
    expect(solid.decompose().length).toBe(1);
    return solid;
  };

  // Closed asymmetric L-stepped solid mesh body (metres, Y-up vertices & Z-up renderVertices) for 'fit' mold tests.
  const makeAsymMeshScene = (): SceneGraph => {
    const a = wasm.Manifold.cube([0.032, 0.052, 0.022], true).translate([0, 0, 0.011]);
    const b = wasm.Manifold.cube([0.016, 0.026, 0.012], true).translate([0.008, -0.010, 0.022]);
    const u = a.add(b);
    const gm = u.getMesh();
    const n = gm.numVert;
    const renderVertices: number[] = [];
    const vertices: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = gm.vertProperties[i * gm.numProp];
      const y = gm.vertProperties[i * gm.numProp + 1];
      const z = gm.vertProperties[i * gm.numProp + 2];
      renderVertices.push(x, y, z);
      vertices.push(x, z, -y);
    }
    const faces = Array.from(gm.triVerts);
    a.delete(); b.delete(); u.delete();
    return {
      nodes: [{
        id: 'asym', name: 'asym_part', type: 'body', pos: [0, 0, 0.01],
        geoms: [{ name: 'g', type: 'mesh', size: [1], vertices, renderVertices, faces } as SceneGeom],
        joints: [], children: [],
      }],
    };
  };

  it('splits an open mold orthogonally with intact mid-height rails, 0 mm³ overlap when closed/sliding, and closes before pouring', async () => {
    const slabTall: SceneGraph = {
      nodes: [{ id: 'b', name: 'brick', type: 'body', pos: [0, 0, 0.015], geoms: [{ name: 'g', type: 'box', size: [0.02, 0.03, 0.015] }], children: [] }],
    };
    const slabWide: SceneGraph = {
      nodes: [{ id: 'bw', name: 'wide_brick', type: 'body', pos: [0, 0, 0.012], geoms: [{ name: 'g', type: 'box', size: [0.035, 0.02, 0.012] }], children: [] }],
    };
    const asymScene = makeAsymMeshScene();

    for (const [label, scene, blockShape, expectTurn90] of [
      ['tall-box', slabTall, 'box', false],
      ['wide-box', slabWide, 'box', true],
      ['asym-fit', asymScene, 'fit', false],
    ] as const) {
      const baseRes = generateMoldMeshes(scene, { ...DEFAULT_MOLD_OPTIONS, moldType: 'open', pullDirection: '+z', blockShape, separable: false }, wasm);
      const res = generateMoldMeshes(scene, { ...DEFAULT_MOLD_OPTIONS, moldType: 'open', pullDirection: '+z', blockShape, separable: true }, wasm);
      const s = moldSummary(res);
      expect(s.parts.map((p) => p.name)).toEqual(['Cavity Half 1', 'Cavity Half 2', 'Sliding Clip 1', 'Sliding Clip 2']);
      expect(res.clips).toHaveLength(2);

      const splitOpen = res.bottomHalf.splitOpen!;
      expect(splitOpen).toBeDefined();
      // Orthogonal single-axis split shift: [3, 0] when spanX > spanY, [0, 3] when spanX <= spanY.
      if (expectTurn90) {
        expect(Math.abs(splitOpen.closeShiftMm[0])).toBeCloseTo(3, 5);
        expect(Math.abs(splitOpen.closeShiftMm[1])).toBeLessThan(1e-6);
      } else {
        expect(Math.abs(splitOpen.closeShiftMm[0])).toBeLessThan(1e-6);
        expect(Math.abs(splitOpen.closeShiftMm[1])).toBeCloseTo(3, 5);
      }

      const [n1] = splitOpen.pieceTriangles;
      const h1Spaced = trisToManifold(res.bottomHalf.triangles.slice(0, n1));
      const h2Spaced = trisToManifold(res.bottomHalf.triangles.slice(n1));
      const c1Bed = trisToManifold(res.clips![0]);
      const c2Bed = trisToManifold(res.clips![1]);

      const [sx, sy] = splitOpen.closeShiftMm;
      const h1Closed = h1Spaced.translate([sx, sy, 0]);
      const h2Closed = h2Spaced.translate([-sx, -sy, 0]);
      expect(h1Closed.intersect(h2Closed).volume(), `${label} closed halves overlap`).toBeLessThan(1e-3);

      // Mid-height slice must include intact protruding dovetail rails (+7.2 mm wider than unsplit block)!
      const unsplitSolid = trisToManifold(baseRes.bottomHalf.triangles);
      const unsplitBB = unsplitSolid.boundingBox();
      const midZ = (unsplitBB.min[2] + unsplitBB.max[2]) * 0.5;
      const clampedAxis = expectTurn90 ? 1 : 0;
      const unsplitSpan = unsplitBB.max[clampedAxis] - unsplitBB.min[clampedAxis];
      const closedMidBounds = h1Closed.add(h2Closed).slice(midZ).bounds();
      expect(closedMidBounds.max[clampedAxis] - closedMidBounds.min[clampedAxis], `${label} mid-height rails intact`).toBeGreaterThan(unsplitSpan + 6.5);

      // Seat both vertical C-clips onto the closed rails in 3D and verify 0 mm³ overlap assembled and along +Z / ±release slides.
      const toLocal = (m: Manifold) => (expectTurn90 ? m.rotate([0, 0, 90]) : m);
      const fromLocal = (m: Manifold) => (expectTurn90 ? m.rotate([0, 0, -90]) : m);
      const localClosed = toLocal(h1Closed.add(h2Closed));
      const lbb = localClosed.boundingBox();
      const vMid = (lbb.min[1] + lbb.max[1]) * 0.5;
      const cb1 = c1Bed.boundingBox(), cb2 = c2Bed.boundingBox();
      const c1Seated = fromLocal(c1Bed.translate([(lbb.min[0] + 3.25) - cb1.max[0], vMid - (cb1.min[1] + cb1.max[1]) * 0.5, -cb1.min[2]]));
      const c2Seated = fromLocal(c2Bed.translate([(lbb.max[0] - 3.25) - cb2.min[0], vMid - (cb2.min[1] + cb2.max[1]) * 0.5, -cb2.min[2]]));

      for (const clip of [c1Seated, c2Seated]) {
        for (const dz of [0, 1, 5, 15, 45]) {
          const moved = clip.translate([0, 0, dz]);
          expect(moved.intersect(h1Closed).volume(), `${label} clip +Z=${dz} vs h1`).toBeLessThan(1e-3);
          expect(moved.intersect(h2Closed).volume(), `${label} clip +Z=${dz} vs h2`).toBeLessThan(1e-3);
        }
      }
      const relLen = Math.hypot(sx, sy) || 1;
      const rx = sx / relLen, ry = sy / relLen;
      for (const step of [0, 0.5, 1.5, 5, 25]) {
        expect(h1Closed.translate([-rx * step, -ry * step, 0]).intersect(h2Closed).volume(), `${label} h1 slide ${step}`).toBeLessThan(1e-3);
        expect(h2Closed.translate([rx * step, ry * step, 0]).intersect(h1Closed).volume(), `${label} h2 slide ${step}`).toBeLessThan(1e-3);
      }

      if (label === 'tall-box') {
        const mesh = stlToMesh(res.binarySTL);
        const node = simulatedBody({ ...mesh, cellMm: 0, toleranceMm: 0 }, {
          modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [-20, -30, 0], modelMaxMm: [20, 30, 30],
        }, { id: 'sim_open', name: 'Open Mold', kind: 'mold', placement: 'beside', parts: moldSceneParts(s) });
        node.simulation = { ...node.simulation!, mold: moldMasterRecord(slabTall, s) };
        expect(node.geoms).toHaveLength(4);
        for (const g of node.geoms!) expect(meshIntegrity(g).watertight).toBe(true);

        const cast = await simulateCastFromMoldNode(node);
        expect(cast.success, cast.error).toBe(true);
        const expectedVol = 40 * 60 * 30;
        expect(Math.abs(cast.castVolumeMm3 - expectedVol) / expectedVol).toBeLessThan(0.05);
      }
    }
  });

  it('adds symmetric double-45° clamping flanges and support-free C-clips to clamshells across box, fit, asymmetric fit, spanX<=spanY and spanX>spanY with 0 mm³ closed/slide overlap', async () => {
    const wideBar: SceneGraph = {
      nodes: [{ id: 'wb', name: 'wide_bar', type: 'body', pos: [0, 0, 0.015], geoms: [{ name: 'g', type: 'box', size: [0.03, 0.016, 0.012] }], children: [] }],
    };
    const asymScene = makeAsymMeshScene();

    for (const [label, scene, extraOpts, expectTurn90] of [
      ['ball-box', ball, { blockShape: 'box' as const }, false],
      ['ball-fit', ball, { blockShape: 'fit' as const }, false],
      ['wide-box', wideBar, { blockShape: 'box' as const, includeSprue: false, includeVents: false }, true],
      ['asym-fit', asymScene, { blockShape: 'fit' as const }, false],
    ]) {
      const baseRes = generateMoldMeshes(scene, { ...CLAMSHELL, ...extraOpts, separable: false, castMaterial: 'epoxy' }, wasm);
      const res = generateMoldMeshes(scene, { ...CLAMSHELL, ...extraOpts, separable: true, castMaterial: 'epoxy' }, wasm);
      expect(res.success, `${label}: ${res.error}`).toBe(true);
      expect(res.clips).toHaveLength(2);
      const s = moldSummary(res);
      expect(s.parts.map((p) => p.role)).toEqual(['shell', 'shell', 'clip', 'clip']);

      const botPlated = trisToManifold(res.bottomHalf.triangles);
      const topPlated = trisToManifold(res.topHalf!.triangles);
      const c1Bed = trisToManifold(res.clips![0]);
      const c2Bed = trisToManifold(res.clips![1]);

      // Printability: C-clips stood on Z = 0 have no >45° overhangs; clamping flanges outside base block have <= 45° bevels.
      for (const clipTris of res.clips!) {
        for (const t of clipTris) {
          const zAvg = (t.a[2] + t.b[2] + t.c[2]) / 3;
          if (zAvg > 0.08 && t.normal) {
            expect(t.normal[2], `${label} clip overhang`).toBeGreaterThan(-0.715);
          }
        }
      }

      const botPartZ = res.bottomHalf.partingZMm;
      const topPartZ = res.topHalf!.partingZMm;
      const bbB = botPlated.boundingBox(), bbT = topPlated.boundingBox();
      const bot0 = botPlated.translate([-(bbB.min[0] + bbB.max[0]) * 0.5, 0, -bbB.min[2]]);
      const top0 = topPlated.translate([-(bbT.min[0] + bbT.max[0]) * 0.5, 0, -bbT.min[2]]);

      // Flange protrusion check: slice near parting face is > 6 mm wider across clamped axis than near floor (z = 0.3).
      const clampedAxis = expectTurn90 ? 1 : 0;
      for (const [half, partZ, hName] of [[bot0, botPartZ, 'bot'], [top0, topPartZ, 'top']] as const) {
        const floorB = half.slice(0.3).bounds();
        const flangeB = half.slice(partZ - 1.0).bounds();
        expect(
          (flangeB.max[clampedAxis] - flangeB.min[clampedAxis]) - (floorB.max[clampedAxis] - floorB.min[clampedAxis]),
          `${label}/${hName} flange protrusion intact`,
        ).toBeGreaterThan(6.0);
      }

      // Check exterior flange bevel overhang angle <= 45° (normal.z >= -0.715) on both plated halves.
      const baseBotBB = baseRes.bottomHalf.bounds;
      const baseHalfSpan = expectTurn90 ? (baseBotBB.maxY - baseBotBB.minY) * 0.5 : (baseBotBB.maxX - baseBotBB.minX) * 0.5;
      for (const [halfTris, cxShift] of [
        [res.bottomHalf.triangles, (bbB.min[0] + bbB.max[0]) * 0.5],
        [res.topHalf!.triangles, (bbT.min[0] + bbT.max[0]) * 0.5],
      ] as const) {
        for (const t of halfTris) {
          const coord = expectTurn90
            ? Math.abs((t.a[1] + t.b[1] + t.c[1]) / 3)
            : Math.abs((t.a[0] + t.b[0] + t.c[0]) / 3 - cxShift);
          const zAvg = (t.a[2] + t.b[2] + t.c[2]) / 3;
          if (coord > baseHalfSpan + 0.3 && zAvg > 0.08 && t.normal) {
            expect(t.normal[2], `${label} flange bevel overhang <= 45°`).toBeGreaterThan(-0.715);
          }
        }
      }

      // Close the clamshell in 3D by flipping topHalf 180° about X onto bottomHalf (using float32 parting heights)!
      const seamSumZ = Math.fround(botPartZ) + Math.fround(topPartZ);
      const topClosed = top0.rotate([180, 0, 0]).translate([0, 0, seamSumZ]);
      expect(bot0.intersect(topClosed).volume(), `${label} closed bot vs flipped top`).toBeLessThan(1e-2);

      // Verify wedge taper adds (does NOT cancel!) across the seam after the 180° X-flip.
      const toLocal = (m: Manifold) => (expectTurn90 ? m.rotate([0, 0, 90]) : m);
      const fromLocal = (m: Manifold) => (expectTurn90 ? m.rotate([0, 0, -90]) : m);
      const botLocal = toLocal(bot0);
      const topClosedLocal = toLocal(topClosed);
      const lbb = botLocal.boundingBox();
      const vMid = (lbb.min[1] + lbb.max[1]) * 0.5;
      const uProbe = lbb.max[0] - 0.2; // inside the outer vertical flange face
      const probeNeg = wasm.Manifold.cube([0.2, 0.4, 20]).translate([uProbe - 0.1, vMid - 5.2, botPartZ - 10]);
      const probePos = wasm.Manifold.cube([0.2, 0.4, 20]).translate([uProbe - 0.1, vMid + 4.8, botPartZ - 10]);
      const closedMatedLocal = botLocal.add(topClosedLocal);
      const hAtNeg = closedMatedLocal.intersect(probeNeg).boundingBox();
      const hAtPos = closedMatedLocal.intersect(probePos).boundingBox();
      const spanNeg = hAtNeg.max[2] - hAtNeg.min[2];
      const spanPos = hAtPos.max[2] - hAtPos.min[2];
      // Over a 10 mm v-interval along railLen (12..22 mm), double-flange height changes by 2 * 0.35 * (10 / railLen) >= 0.30 mm!
      expect(Math.abs(spanPos - spanNeg), `${label} wedge taper reinforced across seam`).toBeGreaterThan(0.28);
      const taperSign: 1 | -1 = spanPos >= spanNeg ? 1 : -1;

      // Seat both C-clips in 3D onto the mated double-45° hexagonal rails and verify 0 mm³ overlap seated & sliding off!
      const cb1 = c1Bed.boundingBox();
      const cCentered = c1Bed.translate([-(cb1.min[0] + cb1.max[0]) * 0.5, -(cb1.min[1] + cb1.max[1]) * 0.5, -(cb1.min[2] + cb1.max[2]) * 0.5]);
      const cAlignedPos = cCentered.rotate([taperSign > 0 ? 90 : -90, 0, 0]);
      const cab = cAlignedPos.boundingBox();
      const clipSeatedPos = fromLocal(cAlignedPos.translate([
        (lbb.max[0] + 3.45) - cab.max[0],
        vMid - (cab.min[1] + cab.max[1]) * 0.5,
        botPartZ - (cab.min[2] + cab.max[2]) * 0.5,
      ]));
      const cAlignedNeg = cAlignedPos.rotate([0, 180, 0]);
      const can = cAlignedNeg.boundingBox();
      const clipSeatedNeg = fromLocal(cAlignedNeg.translate([
        (lbb.min[0] - 3.45) - can.min[0],
        vMid - (can.min[1] + can.max[1]) * 0.5,
        botPartZ - (can.min[2] + can.max[2]) * 0.5,
      ]));
      void c2Bed;

      // Verify seated clips genuinely wrap >= 2 mm over the flanges across the parting seam.
      const posLocalBB = toLocal(clipSeatedPos).boundingBox();
      expect(lbb.max[0] - posLocalBB.min[0], `${label} clip jaw grip depth`).toBeGreaterThan(2.0);
      expect(posLocalBB.min[2]).toBeLessThan(botPartZ - 4.0);
      expect(posLocalBB.max[2]).toBeGreaterThan(botPartZ + 4.0);

      const slideDirLocal: [number, number] = [0, -taperSign];
      const slideDirWorld: [number, number] = expectTurn90 ? [slideDirLocal[1], -slideDirLocal[0]] : slideDirLocal;
      for (const clip of [clipSeatedPos, clipSeatedNeg]) {
        for (const step of [0, 1, 3, 8, 18, 45]) {
          const moved = clip.translate([slideDirWorld[0] * step, slideDirWorld[1] * step, 0]);
          expect(moved.intersect(bot0).volume(), `${label} clip slide=${step} vs bot`).toBeLessThan(1e-3);
          expect(moved.intersect(topClosed).volume(), `${label} clip slide=${step} vs top`).toBeLessThan(1e-3);
        }
      }

      if (label === 'ball-box' || label === 'asym-fit') {
        const mesh = stlToMesh(res.binarySTL);
        const node = simulatedBody({ ...mesh, cellMm: 0, toleranceMm: 0 }, {
          modelOriginMm: [0, 0, 0], workOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [-20, -26, 0], modelMaxMm: [20, 26, 40],
        }, { id: `sim_${label}`, name: 'Clam Mold', kind: 'mold', placement: 'beside', parts: moldSceneParts(s) });
        const record = moldMasterRecord(scene, s);
        node.simulation = { ...node.simulation!, mold: record };
        expect(node.geoms).toHaveLength(4);
        for (const g of node.geoms!) expect(meshIntegrity(g).watertight, `${label} ${g.name} watertight`).toBe(true);

        const cast = await simulateCastFromMoldNode(node, { trimChannels: true });
        expect(cast.success, `${label}: ${cast.error}`).toBe(true);
        expect(cast.castVolumeMm3).toBeGreaterThan(record.masterVolumeMm3 * 0.94);
        expect(cast.castVolumeMm3).toBeLessThan(record.masterVolumeMm3 * 1.10);
      }
    }
  });
});
