import { describe, it, expect } from 'vitest';
import {
  simulateCastFromMoldResult,
  simulateCastFromMoldNode,
  simulateCastFromMoldTriangles,
  weldTriangles,
  computeMeshVolume,
} from '../src/utils/moldCastSimulation';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS } from '../src/utils/moldExporter';
import type { SceneGraph, SceneGeom, SceneNode } from '../src/types/scene';
import { loadManifold } from '../src/utils/sculptCut';
import { manifoldToMeshMm } from '../src/utils/timberBreakdown';

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

    const sim = await simulateCastFromMoldResult(mold);

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
      const mold = generateMoldMeshes(frame, { ...DEFAULT_MOLD_OPTIONS, moldType, includeVents: false });
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
});
