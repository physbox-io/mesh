import { describe, it, expect } from 'vitest';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS, buildHeightmap } from '../src/utils/reliefCarveExporter';
import { collectSceneTriangles } from '../src/utils/contourSliceExporter';
import { simulateMilling } from '../src/utils/cutSimulation';
import { reliefSimulationTools, runSimulationJob, simulateStock, simulatedBody } from '../src/utils/simulatedPart';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGraph, SceneNode } from '../src/types/scene';

// Add Simulation end to end: a relief program cut back out of its block,
// meshed, and put in the scene beside the model or over it.

/** A 100 mm sphere centred on the origin. */
const dome: SceneGraph = {
  nodes: [{
    id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
    geoms: [{ name: 'g1', type: 'sphere', size: [0.05] } as never],
    joints: [], children: [],
  }],
};

// True scale in plan and height, so the overlay has nothing to stretch back.
const options = {
  ...DEFAULT_RELIEF_OPTIONS,
  stockWidthMm: 120,
  stockDepthMm: 120,
  stockThicknessMm: 18,
  fitMode: 'manual' as const,
  scalePercent: 100,
  verticalScaleMode: 'proportional' as const,
  verticalExaggeration: 1,
  carveDepthMm: 10,
  finishingToolType: 'ball_nose' as const,
};

const relief = generateReliefCarveGcode(dome, options);
const job = {
  gcode: relief.gcode,
  widthMm: 120,
  depthMm: 120,
  thicknessMm: 18,
  ...reliefSimulationTools(options),
};
const sim = runSimulationJob(job);

const extent = (node: SceneNode) => {
  const v = node.geoms[0].renderVertices!;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], v[i] + node.pos[i % 3]);
    hi[i % 3] = Math.max(hi[i % 3], v[i] + node.pos[i % 3]);
  }
  return { lo, hi };
};

describe('Add Simulation', () => {
  it('numbers the tools as the relief program does', () => {
    expect(reliefSimulationTools(options)).toEqual({
      tools: {
        1: { shape: 'flat', diameterMm: options.roughingToolDiaMm },
        2: { shape: 'ball', diameterMm: options.finishingToolDiaMm, vAngleDeg: options.finishingVBitAngleDeg },
      },
      initialTool: 1,
    });
    const finishOnly = reliefSimulationTools({ ...options, roughingEnabled: false });
    expect(finishOnly.initialTool).toBe(2);
    expect(finishOnly.tools[2].shape).toBe('ball');
  });

  it('cuts the relief into a closed solid, with no rapid through the stock', () => {
    expect(relief.success).toBe(true);
    expect(sim.rapidCuts).toBe(0);
    const integrity = analyzeMesh(Array.from(sim.positions), Array.from(sim.faces))!;
    expect(integrity.closed).toBe(true);
    expect(integrity.consistentlyWound).toBe(true);
    expect(integrity.volume).toBeCloseTo(sim.volumeMm3, 0);
    // A 10 mm deep relief takes off something, and leaves most of the block.
    expect(sim.volumeMm3).toBeLessThan(sim.stockVolumeMm3);
    expect(sim.volumeMm3).toBeGreaterThan(sim.stockVolumeMm3 * 0.4);
  });

  it('lays the overlay over the model, cap to cap', () => {
    const node = simulatedBody(sim, relief.stockTransform!, {
      id: 's1', name: 'sim', kind: 'relief', placement: 'overlay',
    });
    const { lo, hi } = extent(node);
    // The stock's top face is the top of the sphere, 50 mm up.
    expect(hi[2]).toBeCloseTo(0.05, 4);
    // The block is centred on the model in plan.
    expect((lo[0] + hi[0]) / 2).toBeCloseTo(0, 4);
    expect((lo[1] + hi[1]) / 2).toBeCloseTo(0, 4);
    expect(hi[0] - lo[0]).toBeCloseTo(0.12, 4);
    // And 18 mm deep under it.
    expect(hi[2] - lo[2]).toBeCloseTo(0.018, 4);
    expect(node.joints).toEqual([]);
    expect(node.geoms[0]).toMatchObject({ contype: 0, conaffinity: 0, dynamic: true });
    expect(node.simulation).toMatchObject({ kind: 'relief', placement: 'overlay' });
  });

  it('puts the part beside the model, and the next one beside that', () => {
    const first = simulatedBody(sim, relief.stockTransform!, {
      id: 's1', name: 'sim', kind: 'relief', placement: 'beside',
    });
    const a = extent(first);
    expect(a.lo[0]).toBeGreaterThan(0.05);
    expect(a.hi[0] - a.lo[0]).toBeCloseTo(0.12, 4);
    // Standing on the model's lowest point.
    expect(a.lo[2]).toBeCloseTo(-0.05, 4);
    const second = simulatedBody(sim, relief.stockTransform!, {
      id: 's2', name: 'sim 2', kind: 'relief', placement: 'beside', existing: [first],
    });
    expect(extent(second).lo[0]).toBeGreaterThan(a.hi[0]);
  });

  it('keeps the same winding in both of its frames', () => {
    const node = simulatedBody(sim, relief.stockTransform!, {
      id: 's1', name: 'sim', kind: 'relief', placement: 'beside',
    });
    const g = node.geoms[0];
    expect(analyzeMesh(g.renderVertices!, g.faces!)!.volume).toBeGreaterThan(0);
    // Y-up, as the renderer and mjcf.ts read `vertices`.
    expect(analyzeMesh(g.vertices!, g.faces!)!.volume).toBeGreaterThan(0);
  });

  it('is left out of the next plan', () => {
    const node = simulatedBody(sim, relief.stockTransform!, {
      id: 's1', name: 'Simulated: Relief carve', kind: 'relief', placement: 'beside',
    });
    const again = generateReliefCarveGcode({ nodes: [...dome.nodes, node] }, options);
    expect(again.stockTransform).toEqual(relief.stockTransform);
    expect(again.warnings.some((w) => w.includes('Simulated: Relief carve'))).toBe(true);
  });

  /*
   * The finished relief against the model it was cut from, cell by cell, the
   * check that found the finishing pass planned into the surface on a slope.
   *
   * Never below it by more than the exporter's own sampling of the surface
   * accounts for: a sphere geom is facets, and a surface sampled every 0.6 mm
   * passes under the ridges between them by up to 0.045 mm. Before the cutter
   * was swept between samples it went 0.088 mm in with a ball nose and
   * 0.258 mm with a flat, on the dome's steep flank. And within a scallop of it
   * wherever a ball can reach.
   */
  for (const tool of ['ball_nose', 'flat'] as const) {
    it(`finishes on the model with a ${tool} finisher, not in it`, () => {
      const o = { ...options, finishingToolType: tool };
      const res = tool === 'ball_nose' ? relief : generateReliefCarveGcode(dome, o);
      const cut = simulateMilling(res.gcode, { widthMm: 120, depthMm: 120, ...reliefSimulationTools(o) });
      const t = res.stockTransform!;
      const src = collectSceneTriangles(dome).tris;
      const tris = new Float64Array(src.length);
      for (let i = 0; i < src.length; i += 3) {
        for (let a = 0; a < 3; a++) tris[i + a] = (src[i + a] * 1000 - t.modelOriginMm[a]) * t.scale[a] + t.workOriginMm[a];
      }
      const c = cut.cell;
      const model = buildHeightmap(
        tris, { minX: c / 2, minY: c / 2, maxX: (cut.cols - 0.5) * c, maxY: (cut.rows - 0.5) * c }, cut.cols, cut.rows, -Infinity
      );
      let worstGouge = 0;
      const excess: number[] = [];
      for (let j = 0; j < cut.rows; j++) {
        for (let i = 0; i < cut.cols; i++) {
          const k = j * cut.cols + i;
          const want = Math.max(-res.reliefDepthMm, model.z[k]);
          worstGouge = Math.max(worstGouge, want - cut.heights[k]);
          // Inside the cap, clear of the corner at its foot no ball can fill.
          if (Math.hypot((i + 0.5) * c - 60, (j + 0.5) * c - 60) < 28) excess.push(cut.heights[k] - want);
        }
      }
      expect(worstGouge).toBeLessThan(0.07);
      if (tool === 'ball_nose') {
        excess.sort((a, b) => a - b);
        expect(excess[Math.floor(excess.length * 0.99)]).toBeLessThan(0.08);
      }
    });
  }
});

describe('Add Simulation, two sides', () => {
  /** A 60 mm sphere, cut from both faces of the block. */
  const ball: SceneGraph = {
    nodes: [{
      id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
      geoms: [{ name: 'g1', type: 'sphere', size: [0.03] } as never],
      joints: [], children: [],
    }],
  };
  // A raster, whose passes on the two sides are each other's mirror image
  // exactly, so any step at the seam is the sides read out of line. Hybrid's
  // waterline leaves its scallops at slightly different places on each side:
  // 0.17 mm apart at worst, though both are as close to the sphere (0.08 mm
  // mean, 0.26 at worst) as the raster is.
  const opts = deriveSolidOptions(ball, { sides: 2, material: 'softwood', finishingToolType: 'ball_nose', finishingStrategy: 'raster' });
  const res = generateSolidMachining(ball, opts);
  const job = {
    gcode: res.sides[0].gcode,
    gcodeB: res.sides[1].gcode,
    widthMm: res.stock.widthMm,
    depthMm: res.stock.depthMm,
    thicknessMm: res.stock.thicknessMm,
    ...reliefSimulationTools(opts),
  };

  /*
   * The volume says both sides cut the whole sphere, and the symmetry says
   * they met: side B is mirrored back column for column, and reading it one
   * column off showed a 0.15 mm step here, against 0.003 mm read right.
   */
  it('cuts the sphere from both sides, meeting at the seam without a step', () => {
    const { grid, cuts } = simulateStock(job);
    expect(cuts.filter((c) => c.rapid)).toEqual([]);
    const top = grid.top, bottom = grid.bottom as Float64Array;
    const cx = res.stock.widthMm / 2, cy = res.stock.depthMm / 2, mid = -res.stock.thicknessMm / 2;
    let volume = 0, step = 0;
    for (let j = 0; j < grid.rows; j++) {
      for (let i = 0; i < grid.cols; i++) {
        const k = j * grid.cols + i;
        const r = Math.hypot((i + 0.5) * grid.cell - cx, (j + 0.5) * grid.cell - cy);
        const thick = Math.max(0, top[k] - bottom[k]);
        // The tabs reach in to the sphere at its equator; a millimetre of them counts.
        if (r < 31) volume += thick * grid.cell ** 2;
        if (r < 25) step = Math.max(step, Math.abs(top[k] - mid - (mid - bottom[k])));
      }
    }
    const sphere = (4 / 3) * Math.PI * 30 ** 3;
    expect(Math.abs(volume - sphere) / sphere).toBeLessThan(0.02);
    expect(step).toBeLessThan(0.05);
  });

  it('meshes the two-sided block closed, and lays it back over the sphere', () => {
    const sim = runSimulationJob(job);
    const integrity = analyzeMesh(Array.from(sim.positions), Array.from(sim.faces))!;
    expect(integrity.closed).toBe(true);
    expect(integrity.consistentlyWound).toBe(true);
    const node = simulatedBody(sim, res.stockTransform!, {
      id: 's1', name: 'sim', kind: 'machining', placement: 'overlay',
    });
    const { lo, hi } = extent(node);
    // The block is centred on the sphere every way.
    for (let a = 0; a < 3; a++) expect((lo[a] + hi[a]) / 2).toBeCloseTo(0, 4);
    expect(hi[2] - lo[2]).toBeCloseTo(res.stock.thicknessMm / 1000, 4);
  });

  it('describes a part turned on its side by the turn it was given', () => {
    // 40 x 20 x 10 mm, cut with its +X end up.
    const brick: SceneGraph = {
      nodes: [{
        id: 'b1', name: 'brick', type: 'body', pos: [0.1, 0.2, 0.3],
        geoms: [{ name: 'g1', type: 'box', size: [0.02, 0.01, 0.005] } as never],
        joints: [], children: [],
      }],
    };
    const r = generateSolidMachining(brick, deriveSolidOptions(brick, { sides: 2, up: '+x' }));
    const t = r.stockTransform!;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const x of [80, 120]) for (const y of [190, 210]) for (const z of [295, 305]) {
      const m = [x - t.modelOriginMm[0], y - t.modelOriginMm[1], z - t.modelOriginMm[2]];
      const R = t.rotation!;
      for (let a = 0; a < 3; a++) {
        const w = t.scale[a] * (R[a * 3] * m[0] + R[a * 3 + 1] * m[1] + R[a * 3 + 2] * m[2]) + t.workOriginMm[a];
        lo[a] = Math.min(lo[a], w);
        hi[a] = Math.max(hi[a], w);
      }
    }
    // Standing on end: 40 mm tall, its top face skinned below the stock's.
    expect(hi[2] - lo[2]).toBeCloseTo(40, 3);
    expect(hi[2]).toBeCloseTo(-(r.stock.thicknessMm - 40) / 2, 3);
    expect(lo[0]).toBeCloseTo(r.partBounds.minX, 3);
    expect(hi[0]).toBeCloseTo(r.partBounds.maxX, 3);
    expect(lo[1]).toBeCloseTo(r.partBounds.minY, 3);
    expect(hi[1]).toBeCloseTo(r.partBounds.maxY, 3);

    // And turned back, the corners land where they started.
    const corners = [[80, 190, 295], [120, 210, 305], [80, 210, 305]];
    const positions = new Float32Array(corners.flatMap((m) => {
      const R = t.rotation!;
      return [0, 1, 2].map((a) =>
        t.scale[a] * (R[a * 3] * m[0] + R[a * 3 + 1] * m[1] + R[a * 3 + 2] * m[2]) + t.workOriginMm[a]);
    }));
    const node = simulatedBody(
      { positions, faces: new Uint32Array([0, 1, 2]), cellMm: 0.1, toleranceMm: 0 }, t,
      { id: 's', name: 's', kind: 'machining', placement: 'overlay' }
    );
    const v = node.geoms[0].renderVertices!;
    corners.forEach((m, c) => {
      for (let a = 0; a < 3; a++) expect((v[c * 3 + a] + node.pos[a]) * 1000).toBeCloseTo(m[a], 2);
    });
  });
});
