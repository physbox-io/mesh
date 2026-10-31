import { describe, it, expect } from 'vitest';
import type { SceneGraph } from '../src/types/scene';

/*
 * physics_add_simulation is documented as simulating the program the matching
 * export hands over. The server sends physics_export_machining's defaults
 * (sides 1, aluminium, a 3 mm flat) on every export and none of them with a
 * simulation, so the simulation used to plan two sides in hardwood: another
 * job. Given the same arguments, both must plan the same one.
 */

const { machiningOptionsFor } = await import('../src/hooks/mcp/exportOptions');

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

