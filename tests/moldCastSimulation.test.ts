import { describe, it, expect, beforeAll } from 'vitest';
import {
  simulateCastFromMoldResult,
  simulateCastFromMoldNode,
  simulateCastFromMoldBuffers,
  simulateCastFromMoldTriangles,
  weldTriangles,
  computeMeshVolume,
} from '../src/utils/moldCastSimulation';
import {
  generateMoldMeshes as generateWithEngine,
  moldPreviewBuffers,
  moldSummary,
  DEFAULT_MOLD_OPTIONS,
} from '../src/utils/moldExporter';
import { siliconeChain } from '../src/utils/castChain';
import { moldMasterRecord, moldSceneParts } from '../src/utils/moldWorkerClient';
import { simulatedBody } from '../src/utils/simulatedPart';
import { stlToMesh } from '../src/utils/stlMesh';
import { sphereMesh, torusMesh, zupToYupFlat } from './helpers/meshes';
import type { SceneGraph, SceneGeom, SceneNode } from '../src/types/scene';
import { loadManifold } from '../src/utils/sculptCut';
import { manifoldToMeshMm } from '../src/utils/timberBreakdown';

// The app's worker always hands the generator the geometry engine, and bottom
// fill (the default) needs it for the runner under the cavity.
let engine: Awaited<ReturnType<typeof loadManifold>> | null = null;
beforeAll(async () => {
  engine = await loadManifold();
});
const generateMoldMeshes: typeof generateWithEngine = (scene, options, wasm) => generateWithEngine(scene, options, wasm ?? engine);

describe('Mold Cast Simulation', () => {
  // Test 1: Casting from a 1-part open mold of a stepped plaque
  // plaque: 40x40x4mm plate + 20x20x10mm boss -> total height 14mm, volume 40*40*4 + 20*20*10 = 10,400 mm³
  it('recovers a closed mesh for a 1-part open mold of a stepped plaque with correct dimensions and volume', async () => {
    const plaqueScene: SceneGraph = {
      nodes: [
        {
          id: 'b1',
          name: 'plaque',
          type: 'body',
          pos: [0, 0, 0],
          geoms: [
            { name: 'plate', type: 'box', size: [0.02, 0.02, 0.002], pos: [0, 0, 0.002] } as SceneGeom,
            { name: 'boss', type: 'box', size: [0.01, 0.01, 0.005], pos: [0, 0, 0.009] } as SceneGeom,
          ],
          joints: [],
          children: [],
        },
      ],
    };

    const mold = generateMoldMeshes(plaqueScene, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'open',
      draftAngleDeg: 0,
      wallMarginMm: 10,
      baseThicknessMm: 5,
    });

    expect(mold.success).toBe(true);
    expect(mold.bottomHalf).toBeDefined();

    const sim = await simulateCastFromMoldResult(mold);

    expect(sim.success).toBe(true);
    expect(sim.error).toBeUndefined();
    expect(sim.cavityComponents).toBeGreaterThanOrEqual(1);

    // Dimensions should be ~40 x 40 x 14 mm
    expect(sim.sizeMm.width).toBeCloseTo(40, 0);
    expect(sim.sizeMm.depth).toBeCloseTo(40, 0);
    expect(sim.sizeMm.height).toBeCloseTo(14, 0);

    // Volume within 5% of 10,400 mm³ (10,400 * 0.95 = 9,880; 10,400 * 1.05 = 10,920)
    const expectedVolume = 40 * 40 * 4 + 20 * 20 * 10; // 10,400 mm³
    expect(sim.castVolumeMm3).toBeGreaterThan(expectedVolume * 0.95);
    expect(sim.castVolumeMm3).toBeLessThan(expectedVolume * 1.05);

    // Verify mesh is non-empty and resting on Z = 0
    expect(sim.mesh.positions.length).toBeGreaterThan(0);
    expect(sim.mesh.faces.length).toBeGreaterThan(0);

    let lowestZ = Infinity;
    for (let i = 2; i < sim.mesh.positions.length; i += 3) {
      if (sim.mesh.positions[i] < lowestZ) lowestZ = sim.mesh.positions[i];
    }
    expect(lowestZ).toBeCloseTo(0, 2);
  });

  // Test 2: Casting from a 2-part clamshell mold of a 60mm sphere
  // recovers the sphere (plus sprue/vent stubs), excluding corner registration pin sockets,
  // volume close to 4/3 * π * 30³ ≈ 113,097 mm³
  it('recovers a 60mm sphere from a 2-part clamshell mold excluding alignment sockets', async () => {
    const domeScene: SceneGraph = {
      nodes: [
        {
          id: 'b1',
          name: 'dome',
          type: 'body',
          pos: [0, 0, 0],
          geoms: [{ name: 'sphere', type: 'sphere', size: [0.03], pos: [0, 0, 0] } as SceneGeom],
          joints: [],
          children: [],
        },
      ],
    };

    const mold = generateMoldMeshes(domeScene, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'clamshell',
      wallMarginMm: 10,
      baseThicknessMm: 5,
      includeSprue: true,
      includeVents: true,
      draftAngleDeg: 0,
    });

    expect(mold.success).toBe(true);
    expect(mold.topHalf).toBeDefined();

    // Trimmed: filled from the bottom, the casting comes out with a runner on it.
    const sim = await simulateCastFromMoldResult(mold, { trimChannels: true });

    expect(sim.success).toBe(true);
    expect(sim.error).toBeUndefined();

    // The mold has 4 pin sockets + 2 pry notches which decompose into separate void components;
    // verify the simulation separated them
    expect(sim.cavityComponents).toBeGreaterThan(1);

    // Expected sphere volume: 4/3 * π * 30³ ≈ 113,097 mm³
    const sphereVolume = (4 / 3) * Math.PI * Math.pow(30, 3);
    // With sprue and vents, volume should be within 5% of pure sphere
    expect(sim.castVolumeMm3).toBeGreaterThan(sphereVolume * 0.95);
    expect(sim.castVolumeMm3).toBeLessThan(sphereVolume * 1.1);

    // Width and depth should be ~60 mm
    expect(Math.abs(sim.sizeMm.width - 60)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(sim.sizeMm.depth - 60)).toBeLessThanOrEqual(1.5);
    expect(sim.sizeMm.height).toBeGreaterThanOrEqual(58);
  });

  // Test 3: Casting from a 3D undercut mold
  // Narrow column 40x40x60mm at top pour mouth widening to 80x80x40mm shoulders at bottom of mold,
  // built by subtracting both boxes from a 100x100x110mm mold block.
  // Recovers exact 2-tier undercut statue (volume ≈ 40*40*60 + 80*80*40 = 352,000 mm³).
  it('recovers the exact 2-tier statue from a 3D undercut mold with overhangs', async () => {
    const wasm = await loadManifold();

    // Mold block: 100 x 100 x 110 mm, base on Z = 0, top face on Z = 110
    const moldBlock = wasm.Manifold.cube([100, 100, 110], false).translate([-50, -50, 0]);

    // Wide shoulders cavity at bottom of mold: 80 x 80 x 40 mm, Z from 10 to 50 mm
    const shoulders = wasm.Manifold.cube([80, 80, 40], false).translate([-40, -40, 10]);

    // Narrow column cavity at top pour mouth: 40 x 40 x 60.1 mm, Z from 50 to 110.1 mm (open to top)
    const column = wasm.Manifold.cube([40, 40, 60.1], false).translate([-20, -20, 50]);

    // Subtract cavity from mold block to create the undercut mold
    const undercutMold = moldBlock.subtract(shoulders).subtract(column);
    shoulders.delete();
    column.delete();
    moldBlock.delete();

    const moldMesh = manifoldToMeshMm(undercutMold);
    undercutMold.delete();

    // Convert to flat Float64Array triangle soup in mm
    const trisMm = new Float64Array(moldMesh.faces.length * 3);
    for (let f = 0; f < moldMesh.faces.length; f++) {
      const idx = moldMesh.faces[f] * 3;
      trisMm[f * 3] = moldMesh.positionsMm[idx];
      trisMm[f * 3 + 1] = moldMesh.positionsMm[idx + 1];
      trisMm[f * 3 + 2] = moldMesh.positionsMm[idx + 2];
    }

    const sim = await simulateCastFromMoldTriangles(trisMm);

    expect(sim.success).toBe(true);
    expect(sim.error).toBeUndefined();

    // Expected volume: 40*40*60 + 80*80*40 = 96,000 + 256,000 = 352,000 mm³
    const expectedVolume = 40 * 40 * 60 + 80 * 80 * 40;
    expect(sim.castVolumeMm3).toBeCloseTo(expectedVolume, -1);

    // Dimensions: width = 80 mm, depth = 80 mm, height = 100 mm
    expect(sim.sizeMm.width).toBeCloseTo(80, 0);
    expect(sim.sizeMm.depth).toBeCloseTo(80, 0);
    expect(sim.sizeMm.height).toBeCloseTo(100, 0);
  });

  // Additional test: simulateCastFromMoldNode
  it('simulates casting directly from a SceneNode representing a mold', async () => {
    // Mold box with a 40x40x20mm cavity formed by a floor plate and 4 perimeter walls
    const moldNode: SceneNode = {
      id: 'm1',
      name: 'Concrete Mold',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        { name: 'floor', type: 'box', size: [0.025, 0.025, 0.0025], pos: [0, 0, 0.0025] } as SceneGeom,
        { name: 'wallLeft', type: 'box', size: [0.0025, 0.025, 0.01], pos: [-0.0225, 0, 0.015] } as SceneGeom,
        { name: 'wallRight', type: 'box', size: [0.0025, 0.025, 0.01], pos: [0.0225, 0, 0.015] } as SceneGeom,
        {
          name: 'wallFront',
          type: 'box',
          size: [0.02, 0.0025, 0.01],
          pos: [0, -0.0225, 0.015],
          textures: [
            {
              pattern: 'text',
              options: { text: 'TOM GREK' },
              depthM: 0.0008,
              scale: -1,
              seedAt: [0, 0.0025, 0],
              seedNormal: [0, 1, 0],
            },
          ],
        } as SceneGeom,
        { name: 'wallBack', type: 'box', size: [0.02, 0.0025, 0.01], pos: [0, 0.0225, 0.015] } as SceneGeom,
      ],
      joints: [],
      children: [],
    };

    const sim = await simulateCastFromMoldNode(moldNode);
    expect(sim.success).toBe(true);
    expect(sim.sizeMm.width).toBeCloseTo(40, 0);
    expect(sim.sizeMm.depth).toBeCloseTo(40, 0);
    expect(sim.sizeMm.height).toBeCloseTo(20, 0);
    expect(sim.castVolumeMm3).toBeCloseTo(40 * 40 * 20, -2);
    expect(sim.textures).toBeDefined();
    expect(sim.textures![0].pattern).toBe('text');
    expect(sim.textures![0].depthM).toBeCloseTo(-0.0008, 6);
    expect(sim.textures![0].scale).toBe(1);
  });

  it('weldTriangles correctly welds shared vertices and eliminates degenerate faces', () => {
    const soup = [
      0, 0, 0,  10, 0, 0,  0, 10, 0, // Triangle 1
      10, 0, 0, 10, 10, 0, 0, 10, 0, // Triangle 2 (sharing edge with T1)
      5, 5, 5,  5, 5, 5,   6, 6, 6,  // Degenerate (two corners welded)
    ];
    const welded = weldTriangles(soup, 0.01);
    expect(welded.positions.length / 3).toBe(4); // 4 unique vertices
    expect(welded.faces.length / 3).toBe(2); // 2 valid triangles
  });

  it('computeMeshVolume returns positive volume for standard cube', () => {
    // 10x10x10 cube
    const positions = new Float32Array([
      0,0,0,  10,0,0,  10,10,0,  0,10,0,
      0,0,10, 10,0,10, 10,10,10, 0,10,10,
    ]);
    const faces = new Uint32Array([
      0,2,1, 0,3,2, // bottom
      4,5,6, 4,6,7, // top
      0,1,5, 0,5,4, // front
      2,3,7, 2,7,6, // back
      0,4,7, 0,7,3, // left
      1,2,6, 1,6,5, // right
    ]);
    const vol = computeMeshVolume(positions, faces);
    expect(vol).toBeCloseTo(1000, 1);
  });

  it('stands the casting the way the part stood, after the mold was turned to open front to back', async () => {
    // An upright square frame (hole along Y) with a lug on its top right
    // corner, so a casting that came back mirrored or upside down would show it.
    const box = (name: string, sx: number, sz: number, x: number, z: number) =>
      ({ name, type: 'box', size: [sx, 0.005, sz], pos: [x, 0, z] }) as SceneGeom;
    const frame: SceneGraph = {
      nodes: [
        {
          id: 'f1',
          name: 'frame',
          type: 'body',
          pos: [0, 0, 0],
          geoms: [
            box('bottom', 0.02, 0.005, 0, 0.005),
            box('top', 0.02, 0.005, 0, 0.035),
            box('left', 0.005, 0.01, -0.015, 0.02),
            box('right', 0.005, 0.01, 0.015, 0.02),
            box('lug', 0.003, 0.003, 0.016, 0.043),
          ],
          joints: [],
          children: [],
        },
      ],
    };

    for (const moldType of ['clamshell', 'open'] as const) {
      // Ventless, so poured from the top: from the bottom its air would have nowhere to go.
      const mold = generateMoldMeshes(frame, { ...DEFAULT_MOLD_OPTIONS, moldType, includeVents: false, sprueFeed: 'top' });
      expect(mold.pullDirection === '+y' || mold.pullDirection === '-y').toBe(true);
      const cast = await simulateCastFromMoldResult(mold, { trimChannels: true });
      expect(cast.success).toBe(true);
      // Within a sampling cell of the part's 40 x 46 mm.
      expect(Math.abs(cast.sizeMm.width - 40)).toBeLessThan(1.5);
      expect(cast.sizeMm.height).toBeGreaterThan(45);
      expect(cast.sizeMm.height).toBeLessThan(47.5);

      // The lug is the only material in the top 4 mm, and it is on the right.
      const pos = cast.mesh.positions;
      let sumX = 0;
      let count = 0;
      for (let i = 0; i < pos.length; i += 3) {
        if (pos[i + 2] > cast.sizeMm.height - 4) {
          sumX += pos[i];
          count++;
        }
      }
      expect(count).toBeGreaterThan(0);
      expect(sumX / count).toBeGreaterThan(10);
    }
  });

  it('casts a clean sphere through a silicone pour-box hole (C4)', async () => {
    const expectedVol = (4 / 3) * Math.PI * Math.pow(15, 3); // ~14,137 mm³
    // 1. Primitive sphere
    const primScene: SceneGraph = {
      nodes: [{
        id: 'sp', name: 'sphere', type: 'body', pos: [0, 0, 0.015], joints: [], children: [],
        geoms: [{ name: 'g', type: 'sphere', size: [0.015] } as SceneGeom],
      }],
    };
    const primRes = await siliconeChain(primScene, ['sp'], { hole: 'pour' }, 'epoxy');
    expect(primRes.ok).toBe(true);
    if (primRes.ok) {
      expect(primRes.piece.volumeMm3).toBeGreaterThan(expectedVol * 0.94);
      expect(primRes.piece.volumeMm3).toBeLessThan(expectedVol * 1.04);
      expect(primRes.deviation?.maxMm ?? 0).toBeLessThan(1.5);
    }

    // 2. Mesh sphere
    const sm = sphereMesh(0.015, 24, 16);
    const meshScene: SceneGraph = {
      nodes: [{
        id: 'spm', name: 'mesh_sphere', type: 'body', pos: [0, 0, 0.015], joints: [], children: [],
        geoms: [{ name: 'gm', type: 'mesh', size: [1], renderVertices: sm.verts, vertices: zupToYupFlat(sm.verts), faces: sm.faces } as SceneGeom],
      }],
    };
    const meshRes = await siliconeChain(meshScene, ['spm'], { hole: 'pour' }, 'epoxy');
    expect(meshRes.ok).toBe(true);
    if (meshRes.ok) {
      expect(meshRes.piece.volumeMm3).toBeGreaterThan(expectedVol * 0.92);
      expect(meshRes.piece.volumeMm3).toBeLessThan(expectedVol * 1.05);
    }
  });

  it('closes clamshell seams cleanly even when partingZMm is rounded to 0.01 mm on an upright torus (C3)', async () => {
    const tm = torusMesh(0.018, 0.006, 32, 16);
    // Rotate upright about X: (x, y, z) -> (x, -z, y + 0.024)
    const upVerts: number[] = [];
    for (let i = 0; i < tm.verts.length; i += 3) {
      upVerts.push(tm.verts[i], -tm.verts[i + 2], tm.verts[i + 1] + 0.024);
    }
    const torusScene: SceneGraph = {
      nodes: [{
        id: 't1', name: 'torus', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [{ name: 'gt', type: 'mesh', size: [1], renderVertices: upVerts, vertices: zupToYupFlat(upVerts), faces: tm.faces } as SceneGeom],
      }],
    };
    const mold = generateMoldMeshes(torusScene, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'clamshell',
      wallMarginMm: 15,
      dissolvableLiner: true,
      linerConstruction: 'insert',
    });
    expect(mold.success, mold.error).toBe(true);
    // Force legacy 2-decimal rounding on partingZMm to ensure seam tolerance holds
    const roundedMold = {
      ...mold,
      bottomHalf: { ...mold.bottomHalf, partingZMm: Math.round(mold.bottomHalf.partingZMm * 100) / 100 },
      topHalf: mold.topHalf ? { ...mold.topHalf, partingZMm: Math.round(mold.topHalf.partingZMm * 100) / 100 } : undefined,
    };
    const sim = await simulateCastFromMoldResult(roundedMold, { trimChannels: true });
    expect(sim.success).toBe(true);
    const expectedTorusVol = 2 * Math.PI * Math.PI * 18 * 36; // ~12,791 mm³
    expect(sim.castVolumeMm3).toBeGreaterThan(expectedTorusVol * 0.9);
  });

  it('trims top-fed epoxy sprue and funnel without gouging a narrow spire (C6)', async () => {
    const spireScene: SceneGraph = {
      nodes: [{
        id: 'sp1', name: 'spire_part', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [
          { name: 'base', type: 'box', size: [0.015, 0.015, 0.0075], pos: [0, 0, 0.0075] } as SceneGeom,
          { name: 'tower', type: 'box', size: [0.003, 0.003, 0.0055], pos: [0, 0, 0.0195] } as SceneGeom,
        ],
      }],
    };
    const mold = generateMoldMeshes(spireScene, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'clamshell',
      wallMarginMm: 14,
      dissolvableLiner: true,
      sprueFeed: 'top',
      castMaterial: 'epoxy',
    });
    expect(mold.success, mold.error).toBe(true);
    const untrimmed = await simulateCastFromMoldResult(mold, { trimChannels: false });
    const trimmed = await simulateCastFromMoldResult(mold, { trimChannels: true });
    expect(trimmed.success).toBe(true);
    expect(trimmed.castVolumeMm3).toBeLessThan(untrimmed.castVolumeMm3 - 100);
    // Master is 25 mm tall (13,860 mm³): sprue above 25 mm is gone, spire is intact!
    expect(trimmed.sizeMm.height).toBeCloseTo(25, 0);
    expect(trimmed.castVolumeMm3).toBeGreaterThan(13_860 * 0.95);
    expect(trimmed.castVolumeMm3).toBeLessThan(13_860 * 1.04);
  });

  it('trims open-mold blind vents and detects trapped air on unvented open-mold recesses (H8)', async () => {
    // Spool in an open mold (`allowUndercuts: true` + `includeVents: true`): whichever Z face is
    // the open mouth, the opposite 30×30 flange is a submerged overhang vented by 4 blind vents.
    const spoolScene: SceneGraph = {
      nodes: [{
        id: 'fl1', name: 'spool', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [
          { name: 'foot', type: 'box', size: [0.015, 0.015, 0.003], pos: [0, 0, 0.003] } as SceneGeom,
          { name: 'waist', type: 'box', size: [0.006, 0.006, 0.007], pos: [0, 0, 0.012] } as SceneGeom,
          { name: 'cap', type: 'box', size: [0.015, 0.015, 0.003], pos: [0, 0, 0.021] } as SceneGeom,
        ],
      }],
    };
    const openMold = generateMoldMeshes(spoolScene, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'open',
      pullDirection: '+z',
      allowUndercuts: true,
      includeVents: true,
    });
    expect(openMold.success).toBe(true);
    expect((openMold.features?.blindVents.length ?? 0)).toBeGreaterThan(0);

    const untrimmed = await simulateCastFromMoldResult(openMold, { trimChannels: false });
    const trimmed = await simulateCastFromMoldResult(openMold, { trimChannels: true });
    // Spool volume: 2 * (30 * 30 * 6) + (12 * 12 * 12) = 10,800 + 1,728 = 12,528 mm³
    const masterVol = 2 * (30 * 30 * 6) + 12 * 12 * 12;
    expect(trimmed.castVolumeMm3).toBeLessThan(untrimmed.castVolumeMm3 - 100);
    expect(trimmed.castVolumeMm3).toBeGreaterThan(masterVol * 0.96);
    expect(trimmed.castVolumeMm3).toBeLessThan(masterVol * 1.04);

    // Unvented open mold with a dome pocket recessed up into an overhang ceiling traps air in simulateCastFromMoldTriangles:
    const wasm = await loadManifold();
    const mBlock = wasm.Manifold.cube([50, 50, 25], false).translate([-25, -25, 0]);
    const mainCav = wasm.Manifold.cube([30, 30, 20.1], false).translate([-15, -15, 5]);
    const shelf = wasm.Manifold.cube([15, 30, 8], false).translate([-15, -15, 17]);
    const trappedPocket = wasm.Manifold.cube([8, 20, 5], false).translate([-13, -10, 16]);
    const unventedOpen = mBlock.subtract(mainCav.subtract(shelf).add(trappedPocket));
    const meshMm = manifoldToMeshMm(unventedOpen);
    const soup = new Float64Array(meshMm.faces.length * 3);
    for (let i = 0; i < meshMm.faces.length; i++) {
      const v = meshMm.faces[i] * 3;
      soup[i * 3] = meshMm.positionsMm[v];
      soup[i * 3 + 1] = meshMm.positionsMm[v + 1];
      soup[i * 3 + 2] = meshMm.positionsMm[v + 2];
    }
    mBlock.delete(); mainCav.delete(); shelf.delete(); trappedPocket.delete(); unventedOpen.delete();
    const unventedCast = await simulateCastFromMoldTriangles(soup, { isClamshell: false });
    expect(unventedCast.fill).toBeDefined();
    expect(unventedCast.fill!.trappedMm3).toBeGreaterThan(300);
  });

  it('never obliterates the main insert cavity if a fine feature touches the holder (C7)', async () => {
    const wasm = await loadManifold();
    // Holder: 50x50x25 block with a 30.5x30.5x18.25 pocket (0.25 mm seating gap around a 30x30x18 insert)
    const holderBlock = wasm.Manifold.cube([50, 50, 25], false).translate([-25, -25, 0]);
    const holderPocket = wasm.Manifold.cube([30.5, 30.5, 18.3], false).translate([-15.25, -15.25, 6.75]);
    const holder = holderBlock.subtract(holderPocket);
    // Insert: 30x30x18 block with a 20x20x12 cavity PLUS a tiny 1x1 mm grid-escape slot reaching the holder wall!
    const insBlock = wasm.Manifold.cube([30, 30, 18], false).translate([-15, -15, 7]);
    const cav = wasm.Manifold.cube([20, 20, 12.1], false).translate([-10, -10, 13]);
    const escapeSlot = wasm.Manifold.cube([6, 1.5, 2], false).translate([10, -0.75, 16]);
    const ins = insBlock.subtract(cav).subtract(escapeSlot);

    const toSoup = (m: typeof holder) => {
      const mm = manifoldToMeshMm(m);
      const out = new Float64Array(mm.faces.length * 3);
      for (let i = 0; i < mm.faces.length; i++) {
        const v = mm.faces[i] * 3;
        out[i * 3] = mm.positionsMm[v];
        out[i * 3 + 1] = mm.positionsMm[v + 1];
        out[i * 3 + 2] = mm.positionsMm[v + 2];
      }
      return out;
    };
    const hSoup = toSoup(holder);
    const iSoup = toSoup(ins);
    holderBlock.delete(); holderPocket.delete(); holder.delete();
    insBlock.delete(); cav.delete(); escapeSlot.delete(); ins.delete();

    const joined = new Float64Array(hSoup.length + iSoup.length);
    joined.set(hSoup, 0);
    joined.set(iSoup, hSoup.length);
    const res = await simulateCastFromMoldTriangles(joined, {
      isClamshell: false,
      partingZ: 25,
      halves: [joined],
      halfPieceTriangles: [[hSoup.length / 9, iSoup.length / 9]],
      isInsertLiner: true,
    });
    expect(res.success).toBe(true);
    // Cavity is 20*20*12 = 4,800 mm³ (plus tiny escape slot + seating strip there), NOT 0 mm³!
    expect(res.castVolumeMm3).toBeGreaterThan(4_500);
  });

  it('restores part orientation for open molds poured as SceneNodes and supports liner preview buffers (H1, H5, H6)', async () => {
    const box = (name: string, sx: number, sz: number, x: number, z: number) =>
      ({ name, type: 'box', size: [sx, 0.005, sz], pos: [x, 0, z] }) as SceneGeom;
    const frame: SceneGraph = {
      nodes: [{
        id: 'f1', name: 'frame', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [
          box('bottom', 0.02, 0.005, 0, 0.005),
          box('top', 0.02, 0.005, 0, 0.035),
          box('left', 0.005, 0.01, -0.015, 0.02),
          box('right', 0.005, 0.01, 0.015, 0.02),
          box('lug', 0.003, 0.003, 0.016, 0.043),
        ],
      }],
    };
    // H1: Open lined mold with non-+z pullDirection poured as a SceneNode
    const openLined = generateMoldMeshes(frame, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'open',
      dissolvableLiner: true,
      includeVents: false,
    });
    expect(openLined.success).toBe(true);
    expect(openLined.pullDirection === '+y' || openLined.pullDirection === '-y').toBe(true);
    const sum = moldSummary(openLined);
    const mesh = stlToMesh(openLined.binarySTL);
    const sceneMoldNode: SceneNode = {
      ...simulatedBody(
        { positions: mesh.positions, faces: mesh.faces, cellMm: 0, toleranceMm: 0 },
        { workOriginMm: [0, 0, 0], modelOriginMm: [0, 0, 0], scale: [1, 1, 1], modelMinMm: [0, 0, 0], modelMaxMm: [0, 0, 0] },
        { id: 'sim_open', name: 'Open Lined Mold', kind: 'mold', placement: 'beside', parts: moldSceneParts(sum) },
      ),
    };
    sceneMoldNode.simulation = { ...sceneMoldNode.simulation!, mold: moldMasterRecord(frame, sum) };
    const nodeCast = await simulateCastFromMoldNode(sceneMoldNode, { pour: {} });
    expect(nodeCast.success).toBe(true);
    expect(nodeCast.sizeMm.width).toBeCloseTo(40, 0);
    expect(nodeCast.sizeMm.depth).toBeCloseTo(10, 0);
    expect(nodeCast.sizeMm.height).toBeCloseTo(46, 0);

    // H5: simulateCastFromMoldBuffers with liner buffers matches true sphere volume (not +41% bare shell)
    const sphereScene: SceneGraph = {
      nodes: [{
        id: 's1', name: 's1', type: 'body', pos: [0, 0, 0], joints: [], children: [],
        geoms: [{ name: 'gs', type: 'sphere', size: [0.015], pos: [0, 0, 0] } as SceneGeom],
      }],
    };
    const linedSphereMold = generateMoldMeshes(sphereScene, {
      ...DEFAULT_MOLD_OPTIONS,
      moldType: 'clamshell',
      wallMarginMm: 14,
      dissolvableLiner: true,
    });
    expect(linedSphereMold.success).toBe(true);
    const bufs = moldPreviewBuffers(linedSphereMold);
    const bufSim = await simulateCastFromMoldBuffers(
      moldSummary(linedSphereMold),
      bufs.bottom.positions,
      bufs.top?.positions,
      { trimChannels: true },
      bufs.liner?.bottom.positions,
      bufs.liner?.top?.positions,
    );
    expect(bufSim.success).toBe(true);
    const sphereVol = (4 / 3) * Math.PI * Math.pow(15, 3);
    expect(bufSim.castVolumeMm3).toBeGreaterThan(sphereVol * 0.94);
    expect(bufSim.castVolumeMm3).toBeLessThan(sphereVol * 1.06);

    // H6: Secondary disconnected cavity emits dropped-cavity warning
    const wasm = await loadManifold();
    const twoCavMold = wasm.Manifold.cube([60, 30, 20], false).translate([-30, -15, 0])
      .subtract(wasm.Manifold.cube([16, 16, 15.1], false).translate([-24, -8, 5]))
      .subtract(wasm.Manifold.cube([12, 12, 15.1], false).translate([8, -6, 5]));
    const twoMesh = manifoldToMeshMm(twoCavMold);
    const twoSoup = new Float64Array(twoMesh.faces.length * 3);
    for (let i = 0; i < twoMesh.faces.length; i++) {
      const v = twoMesh.faces[i] * 3;
      twoSoup[i * 3] = twoMesh.positionsMm[v];
      twoSoup[i * 3 + 1] = twoMesh.positionsMm[v + 1];
      twoSoup[i * 3 + 2] = twoMesh.positionsMm[v + 2];
    }
    twoCavMold.delete();
    const twoCast = await simulateCastFromMoldTriangles(twoSoup, { isClamshell: false });
    expect(twoCast.warnings.some((w) => /another cavity/i.test(w))).toBe(true);
  });
});
