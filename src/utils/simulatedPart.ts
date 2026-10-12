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

import { simulateMilling, type SimTool } from './cutSimulation';
import { buildSimulationMesh } from './simulationMesh';
import type { CutterShape, ReliefCarveOptions, StockTransform } from './reliefCarveExporter';
import type { SceneGeom, SceneNode } from '../types/scene';

export interface SimulationJobOptions {
  gcode: string;
  /** The stock, from the work origin at its near-left corner, top face Z0. */
  widthMm: number;
  depthMm: number;
  thicknessMm: number;
  tools: Record<number, SimTool>;
  initialTool: number;
  cellMm?: number;
  maxTriangles?: number;
}

export interface SimulationJobResult {
  /** The part, x, y, z per vertex in the program's millimetres, Z up. */
  positions: Float32Array;
  faces: Uint32Array;
  cellMm: number;
  toleranceMm: number;
  volumeMm3: number;
  /** The block it was cut from. */
  stockVolumeMm3: number;
  /** Rapid moves that took material off, and the most any of them took. */
  rapidCuts: number;
  deepestRapidMm: number;
}

export function runSimulationJob(o: SimulationJobOptions, onProgress?: (fraction: number) => void): SimulationJobResult {
  const cut = simulateMilling(o.gcode, {
    widthMm: o.widthMm,
    depthMm: o.depthMm,
    tools: o.tools,
    initialTool: o.initialTool,
    cellMm: o.cellMm,
    // The mesh is a fraction of the time; the cut is the long part.
    onProgress: onProgress ? (f) => onProgress(f * 0.8) : undefined,
  });
  const mesh = buildSimulationMesh(
    { ...cut, top: cut.heights, bottom: -o.thicknessMm, widthMm: o.widthMm, depthMm: o.depthMm },
    { maxTriangles: o.maxTriangles }
  );
  onProgress?.(1);
  const rapids = cut.cuts.filter((c) => c.rapid);
  return {
    positions: mesh.positions,
    faces: mesh.faces,
    cellMm: cut.cell,
    toleranceMm: mesh.toleranceMm,
    volumeMm3: mesh.volumeMm3,
    stockVolumeMm3: o.widthMm * o.depthMm * o.thicknessMm,
    rapidCuts: rapids.length,
    deepestRapidMm: rapids.reduce((m, c) => Math.max(m, c.removedMm), 0),
  };
}

const simShape = (shape: CutterShape): SimTool['shape'] => (shape === 'ball_nose' ? 'ball' : shape);

/**
 * The cutters a relief program uses, numbered as it numbers them: T1 roughs
 * with a flat end mill, and finishing is T2 when the job changes tool and the
 * same T1 when it does not.
 */
export function reliefSimulationTools(o: ReliefCarveOptions): Pick<SimulationJobOptions, 'tools' | 'initialTool'> {
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
 * 'beside' puts it at the size it will come off the machine, standing on the
 * model's lowest point, clear of the model and of any simulation already
 * there along +X. 'overlay' undoes the fit (scale, and a relief's vertical
 * exaggeration) so it sits exactly over the model, where an over-cut or a
 * missed area is plain.
 */
export function simulatedBody(
  sim: Pick<SimulationJobResult, 'positions' | 'faces' | 'cellMm' | 'toleranceMm'>,
  stock: { widthMm: number; depthMm: number; thicknessMm: number },
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
    let startX = transform.modelMaxMm[0];
    for (const n of opts.existing ?? []) {
      const mesh = n.geoms?.find((g) => g.renderVertices?.length);
      if (!mesh?.renderVertices) continue;
      let hi = -Infinity;
      for (let i = 0; i < mesh.renderVertices.length; i += 3) hi = Math.max(hi, mesh.renderVertices[i]);
      startX = Math.max(startX, (n.pos[0] + hi) * 1000);
    }
    const gap = 20;
    const x0 = startX + gap;
    const y0 = (transform.modelMinMm[1] + transform.modelMaxMm[1]) / 2 - stock.depthMm / 2;
    const z0 = transform.modelMinMm[2] + stock.thicknessMm;
    for (let v = 0; v < count; v++) {
      world[v * 3] = p[v * 3] + x0;
      world[v * 3 + 1] = p[v * 3 + 1] + y0;
      world[v * 3 + 2] = p[v * 3 + 2] + z0;
    }
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
