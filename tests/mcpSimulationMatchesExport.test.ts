import { describe, it, expect, vi } from 'vitest';
import type { SceneGraph } from '../src/types/scene';

/*
 * physics_add_simulation is documented as simulating the program the matching
 * export hands over. The server sends physics_export_machining's defaults
 * (sides 1, aluminium, a 3 mm flat) on every export and none of them with a
 * simulation, so the simulation used to plan two sides in hardwood: another
 * job. Given the same arguments, both must plan the same one.
 */

// The options each job is planned with, caught before any worker runs it.
const runs: { kind: string; options: Record<string, unknown> }[] = [];
vi.mock('../src/utils/exportWorkerClient', () => ({
  ExportWorkerClient: class {
    run(kind: string, _scene: unknown, options: Record<string, unknown>) {
      runs.push({ kind, options });
      return Promise.resolve({ success: false, error: 'captured' });
    }
    dispose() {}
  },
}));

const { machiningOptionsFor } = await import('../src/hooks/mcp/exportOptions');
const { machiningCommands } = await import('../src/hooks/mcp/machiningCommands');
const { DEFAULT_LASER_OPTIONS } = await import('../src/utils/laserCutExporter');
const { DEFAULT_CONTOUR_OPTIONS } = await import('../src/utils/contourSliceExporter');

const block: SceneGraph = {
  nodes: [{ id: 'b', name: 'p', type: 'body', pos: [0, 0, 0], geoms: [{ name: 'g', type: 'box', size: [0.02, 0.02, 0.005] } as never], joints: [], children: [] }],
} as unknown as SceneGraph;

// What server.py's physics_export_machining sends with no arguments.
const EXPORT_PAYLOAD = { sides: 1, toolDiaMm: 3.0, material: 'aluminium', finishingToolType: 'flat' };

describe('an MCP machining simulation', () => {
  it('plans the job physics_export_machining plans when neither is told otherwise', () => {
    const sim = machiningOptionsFor({ kind: 'machining' }, block);
    const exp = machiningOptionsFor(EXPORT_PAYLOAD, block);
    expect(sim.sides).toBe(1);
    expect(sim.material).toBe('aluminium');
    expect(sim).toEqual(exp);
  });

  it('still takes what the command names', () => {
    const sim = machiningOptionsFor({ kind: 'machining', sides: 2, material: 'hardwood', finishingToolType: 'ball_nose' }, block);
    expect(sim.sides).toBe(2);
    expect(sim.material).toBe('hardwood');
    expect(sim.finishingToolType).toBe('ball_nose');
    expect(sim).toEqual(machiningOptionsFor({ ...EXPORT_PAYLOAD, sides: 2, material: 'hardwood', finishingToolType: 'ball_nose' }, block));
  });
});

/*
 * A router simulation of a laser cut or a contour slice is laid out as the
 * dialog lays it out for a router: no kerf (the G-code stands the bit off by
 * its radius) and, for panels, dogbones in the inside corners. It used to take
 * the laser's recipe, 0.15 mm kerf and square corners, whatever the machine.
 */
describe('an MCP sheet simulation on a router', () => {
  const ctx = { store: { sceneGraph: block }, toId: (s: string) => s } as never;

  it('lays panels out with no kerf, dogbone corners and the named bit', async () => {
    runs.length = 0;
    await machiningCommands.ADD_SIMULATION({ kind: 'laser', machine: 'router', bitDiaMm: 6 }, ctx);
    expect(runs[0].kind).toBe('laser');
    expect(runs[0].options.kerf).toBe(0);
    expect(runs[0].options.cornerRelief).toBe('dogbone');
    expect(runs[0].options.bitDiameter).toBeCloseTo(0.006);
  });

  it('slices contour layers with no kerf', async () => {
    runs.length = 0;
    await machiningCommands.ADD_SIMULATION({ kind: 'contour', machine: 'router' }, ctx);
    expect(runs[0].kind).toBe('contour');
    expect(runs[0].options.kerf).toBe(0);
  });

  it('keeps the laser recipe on a laser', async () => {
    runs.length = 0;
    await machiningCommands.ADD_SIMULATION({ kind: 'laser' }, ctx);
    await machiningCommands.ADD_SIMULATION({ kind: 'contour' }, ctx);
    expect(runs[0].options.kerf).toBe(DEFAULT_LASER_OPTIONS.kerf);
    expect(runs[0].options.cornerRelief).toBe('none');
    expect(runs[1].options.kerf).toBe(DEFAULT_CONTOUR_OPTIONS.kerf);
  });
});
