// ---------------------------------------------------------------------------
// Add Simulation: the part a program will leave, as a body in the scene
// ---------------------------------------------------------------------------
//
// Two halves. `runSimulationJob` is the heavy one and runs on the export
// worker: it cuts the program out of a block (`cutSimulation.ts`) and turns
// what is left into a closed mesh (`simulationMesh.ts`), in the program's own
// millimetres. `simulatedBody` runs on the main thread and turns that mesh
// into a scene body, beside the model at the size it will really be, or over
// the model, put back through the transform the exporter fitted it with.

import { simulateMilling, simulationCellMm, type MoveCut, type SimTool } from './cutSimulation';
import { buildSimulationMesh, type HeightGrid } from './simulationMesh';
import type { CutterShape, ReliefCarveOptions, StockTransform } from './reliefCarveExporter';
import type { PartFootprint } from './solidMachiningExporter';
import type { SceneGeom, SceneNode } from '../types/scene';

export interface SimulationJobOptions {
  gcode: string;
  /**
   * A second setup's program, run with the block turned over left to right
   * (about Y), as the solid exporter's side B is: its X is the stock's width
   * less side A's, and its Z is measured down from what was the underside.
   */
  gcodeB?: string;
  /** The stock, from the work origin at its near-left corner, top face Z0. */
  widthMm: number;
  depthMm: number;
  thicknessMm: number;
  tools: Record<number, SimTool>;
  initialTool: number;
  cellMm?: number;
  maxTriangles?: number;
  /**
   * Also measure what is left over this rectangle of the stock, in side A's
   * frame: a solid part's footprint, so its volume can be set against the
   * model's without the frame round it.
   */
  measureRect?: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * Narrower than `measureRect`: only where this mask is set (nearest sample),
   * so a round part is measured without the stock in the corners of its box.
   */
  measureMask?: PartFootprint;
}

export interface SimulationJobResult {
  /** The part, x, y, z per vertex in the program's millimetres, Z up. */
  positions: Float32Array;
  faces: Uint32Array;
  cellMm: number;
  toleranceMm: number;
  /** The grid the mesh is drawn from, mm: `cellMm`, or coarser when that was too much to draw. */
  drawnCellMm: number;
  volumeMm3: number;
  /** The block it was cut from. */
  stockVolumeMm3: number;
  /** Rapid moves that took material off, and the most any of them took. */
  rapidCuts: number;
  deepestRapidMm: number;
  /** What is left over `measureRect`, mm³. */
  measuredVolumeMm3?: number;
}

/**
 * The stock after every setup's program, as the top and bottom of what is
 * left in each cell, in side A's frame.
 */
export function simulateStock(
  o: SimulationJobOptions,
  onProgress?: (fraction: number) => void
): { grid: HeightGrid; cuts: MoveCut[] } {
  const sides = o.gcodeB ? 2 : 1;
  let cellMm = o.cellMm;
  let maxCells: number | undefined;
  if (o.gcodeB) {
    // Side B's columns are side A's mirrored, so the width has to be a whole
    // number of cells for the two grids to line up column for column.
    const wanted = simulationCellMm(o.widthMm, o.depthMm, o.cellMm);
    cellMm = o.widthMm / Math.ceil(o.widthMm / wanted - 1e-9);
    maxCells = Infinity;
  }
  const run = (gcode: string, side: number) => simulateMilling(gcode, {
    widthMm: o.widthMm,
    depthMm: o.depthMm,
    tools: o.tools,
    initialTool: o.initialTool,
    cellMm,
    maxCells,
    onProgress: onProgress ? (f) => onProgress((side + f) / sides) : undefined,
  });

  const a = run(o.gcode, 0);
  let bottom: number | Float64Array = -o.thicknessMm;
  let cuts = a.cuts;
  if (o.gcodeB) {
    const b = run(o.gcodeB, 1);
    // Concatenated, not pushed as arguments: a big job is hundreds of
    // thousands of moves, past what a browser's call stack takes.
    cuts = cuts.concat(b.cuts);
    // Side B's surface, turned back over into side A's frame.
    const under = new Float64Array(a.heights.length);
    for (let j = 0; j < a.rows; j++) {
      for (let i = 0; i < a.cols; i++) {
        under[j * a.cols + i] = -o.thicknessMm - b.heights[j * a.cols + (a.cols - 1 - i)];
      }
    }
    bottom = under;
  }
  return { grid: { ...a, top: a.heights, bottom, widthMm: o.widthMm, depthMm: o.depthMm }, cuts };
}

export function runSimulationJob(o: SimulationJobOptions, onProgress?: (fraction: number) => void): SimulationJobResult {
  // The mesh is a fraction of the time; the cutting is the long part.
  const { grid, cuts } = simulateStock(o, onProgress ? (f) => onProgress(f * 0.8) : undefined);
  const mesh = buildSimulationMesh(grid, { maxTriangles: o.maxTriangles });
  let measuredVolumeMm3: number | undefined;
  if (o.measureRect || o.measureMask) {
    const r = o.measureRect ?? { minX: -Infinity, minY: -Infinity, maxX: Infinity, maxY: Infinity };
    const m = o.measureMask;
    const inMask = (x: number, y: number) => {
      if (!m) return true;
      const c = Math.round((x - m.minX) / (m.stepX || 1)), j = Math.round((y - m.minY) / (m.stepY || 1));
      return c >= 0 && j >= 0 && c < m.cols && j < m.rows && m.mask[j * m.cols + c] === 1;
    };
    measuredVolumeMm3 = 0;
    for (let j = 0; j < grid.rows; j++) {
      const y = grid.originY + (j + 0.5) * grid.cell;
      if (y < r.minY || y > r.maxY) continue;
      for (let i = 0; i < grid.cols; i++) {
        const x = grid.originX + (i + 0.5) * grid.cell;
        if (x < r.minX || x > r.maxX || !inMask(x, y)) continue;
        const k = j * grid.cols + i;
        const under = typeof grid.bottom === 'number' ? grid.bottom : grid.bottom[k];
        measuredVolumeMm3 += Math.max(0, grid.top[k] - under) * grid.cell * grid.cell;
      }
    }
  }
  onProgress?.(1);
  const rapids = cuts.filter((c) => c.rapid);
  return {
    positions: mesh.positions,
    faces: mesh.faces,
    cellMm: grid.cell,
    toleranceMm: mesh.toleranceMm,
    drawnCellMm: mesh.cellMm,
    volumeMm3: mesh.volumeMm3,
    stockVolumeMm3: o.widthMm * o.depthMm * o.thicknessMm,
    rapidCuts: rapids.length,
    deepestRapidMm: rapids.reduce((m, c) => Math.max(m, c.removedMm), 0),
    measuredVolumeMm3,
  };
}

const simShape = (shape: CutterShape): SimTool['shape'] => (shape === 'ball_nose' ? 'ball' : shape);

/**
 * The cutters a relief or solid-machining program uses (both are written by
 * `machineSurface`), numbered as it numbers them: T1 roughs
 * with a flat end mill, and finishing is T2 when the job changes tool and the
 * same T1 when it does not.
 */
export function reliefSimulationTools(
  o: Pick<
    ReliefCarveOptions,
    'roughingEnabled' | 'roughingToolDiaMm' | 'finishingToolType' | 'finishingToolDiaMm' | 'finishingVBitAngleDeg'
  >
): Pick<SimulationJobOptions, 'tools' | 'initialTool'> {
  const finisher: SimTool = {
    shape: simShape(o.finishingToolType),
    diameterMm: o.finishingToolDiaMm,
    vAngleDeg: o.finishingVBitAngleDeg,
  };
  if (!o.roughingEnabled) return { tools: { 1: finisher, 2: finisher }, initialTool: 2 };
  return {
    tools: { 1: { shape: 'flat', diameterMm: o.roughingToolDiaMm }, 2: finisher },
    initialTool: 1,
  };
}

export type SimulationPlacement = 'beside' | 'overlay';

/** Light wood, a shade off any model colour so the two are told apart. */
export const SIMULATION_RGBA = [0.86, 0.7, 0.48, 1];

/**
 * A static body holding the simulated part.
 *
 * 'beside' puts it at the size it will come off the machine, turned the way
 * the model stands, on the model's lowest point, clear of the model and of
 * any simulation already there along +X. 'overlay' undoes the fit (scale, and a relief's vertical
 * exaggeration) so it sits exactly over the model, where an over-cut or a
 * missed area is plain.
 */
export function simulatedBody(
  sim: Pick<SimulationJobResult, 'positions' | 'faces' | 'cellMm' | 'toleranceMm'>,
  transform: StockTransform,
  opts: {
    id: string;
    name: string;
    kind: NonNullable<SceneNode['simulation']>['kind'];
    placement: SimulationPlacement;
    /** Simulations already in the scene, so a new one goes past them. */
    existing?: SceneNode[];
    createdAt?: string;
  }
): SceneNode {
  const p = sim.positions;
  const count = p.length / 3;
  // Into the scene's millimetres first, then about the body's origin in metres.
  const world = new Float64Array(p.length);
  if (opts.placement === 'overlay') {
    const { workOriginMm: w, modelOriginMm: m, scale: s, rotation: r } = transform;
    for (let v = 0; v < count; v++) {
      // Un-scale into the turned model's frame, then turn back.
      const a = (p[v * 3] - w[0]) / s[0];
      const b = (p[v * 3 + 1] - w[1]) / s[1];
      const c = (p[v * 3 + 2] - w[2]) / s[2];
      // The inverse of a rotation is its transpose.
      world[v * 3] = (r ? r[0] * a + r[3] * b + r[6] * c : a) + m[0];
      world[v * 3 + 1] = (r ? r[1] * a + r[4] * b + r[7] * c : b) + m[1];
      world[v * 3 + 2] = (r ? r[2] * a + r[5] * b + r[8] * c : c) + m[2];
    }
  } else {
    // Turned back the way the model stands, at the size it is cut.
    const r = transform.rotation;
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < count; v++) {
      const a = p[v * 3], b = p[v * 3 + 1], c = p[v * 3 + 2];
      const q = r
        ? [r[0] * a + r[3] * b + r[6] * c, r[1] * a + r[4] * b + r[7] * c, r[2] * a + r[5] * b + r[8] * c]
        : [a, b, c];
      for (let k = 0; k < 3; k++) {
        world[v * 3 + k] = q[k];
        lo[k] = Math.min(lo[k], q[k]);
        hi[k] = Math.max(hi[k], q[k]);
      }
    }
    let startX = transform.modelMaxMm[0];
    for (const n of opts.existing ?? []) {
      const mesh = n.geoms?.find((g) => g.renderVertices?.length);
      if (!mesh?.renderVertices) continue;
      let far = -Infinity;
      for (let i = 0; i < mesh.renderVertices.length; i += 3) far = Math.max(far, mesh.renderVertices[i]);
      startX = Math.max(startX, (n.pos[0] + far) * 1000);
    }
    const gap = 20;
    const shift = [
      startX + gap - lo[0],
      (transform.modelMinMm[1] + transform.modelMaxMm[1]) / 2 - (lo[1] + hi[1]) / 2,
      transform.modelMinMm[2] - lo[2],
    ];
    for (let i = 0; i < world.length; i++) world[i] += shift[i % 3];
  }

  // The body sits at the middle of its footprint, on its lowest point.
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < world.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], world[i]);
    hi[i % 3] = Math.max(hi[i % 3], world[i]);
  }
  const origin = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]];
  const renderVertices: number[] = new Array(world.length);
  const vertices: number[] = new Array(world.length);
  for (let i = 0; i < world.length; i += 3) {
    const x = (world[i] - origin[0]) / 1000;
    const y = (world[i + 1] - origin[1]) / 1000;
    const z = (world[i + 2] - origin[2]) / 1000;
    renderVertices[i] = x; renderVertices[i + 1] = y; renderVertices[i + 2] = z;
    // Three.js Y-up, the inverse of mjcf.ts's (x, y, z) -> (x, -z, y). A
    // rotation, so the winding the mesh was built with survives it.
    vertices[i] = x; vertices[i + 1] = z; vertices[i + 2] = -y;
  }

  const geom: SceneGeom = {
    name: `${opts.id}_mesh`,
    type: 'mesh',
    size: [1],
    rgba: [...SIMULATION_RGBA],
    // Drawn from the body's transform rather than baked into world space.
    dynamic: true,
    // Nothing to collide with: it is there to be looked at and measured.
    contype: 0,
    conaffinity: 0,
    vertices,
    renderVertices,
    faces: Array.from(sim.faces),
  };
  return {
    id: opts.id,
    name: opts.name,
    type: 'body',
    pos: origin.map((v) => v / 1000),
    geoms: [geom],
    // No joint: it stays where it is put.
    joints: [],
    children: [],
    // Its hull is all it would collide as, and it does not collide; a
    // 200 000-triangle board is no job for the decomposer.
    collision: 'hull',
    simulation: {
      kind: opts.kind,
      createdAt: opts.createdAt ?? new Date().toISOString(),
      cellMm: sim.cellMm,
      toleranceMm: sim.toleranceMm,
      placement: opts.placement,
    },
  };
}
