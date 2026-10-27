import { describe, it, expect } from 'vitest';
import type { SceneGraph } from '../src/types/scene';
import { breakdownPipeFrame, generatePipeStructurePreset } from '../src/utils/tubeAndWireExporter';
import { simulatePipeFrame } from '../src/utils/tubeSimulation';
import { analyzeMesh } from '../src/utils/meshIntegrity';

const closed = (m: { positions: Float32Array; faces: Uint32Array }) => {
  const a = analyzeMesh(Array.from(m.positions), Array.from(m.faces))!;
  expect(a.closed).toBe(true);
  expect(a.consistentlyWound).toBe(true);
  expect(a.volume).toBeGreaterThan(0);
  return a.volume;
};

describe('pipe frame simulation', () => {
  it('cuts a frame from its cut list and seats every tube shoulder to shoulder', () => {
    for (const preset of ['mini_greenhouse', 'carport', 'geodesic_dome'] as const) {
      const scene = { nodes: generatePipeStructurePreset(preset) } as unknown as SceneGraph;
      const b = breakdownPipeFrame(scene);
      const sim = simulatePipeFrame(b);
      expect(sim.tubes).toBe(b.struts.length);
      expect(sim.maxGapMm).toBeLessThan(0.05);
      const v = closed(sim);
      const ring = Math.PI * ((b.pipeSpec.odMm / 2) ** 2 - (b.pipeSpec.idMm / 2) ** 2);
      expect(v / (ring * b.totalPipeLengthMm)).toBeGreaterThan(0.98);
      expect(v / (ring * b.totalPipeLengthMm)).toBeLessThan(1.001);
    }
  });

  it('shows tubes running into each other in a hub too tight for them', () => {
    const a = (25 * Math.PI) / 180;
    const strut = (name: string, to: number[]) => ({ name, type: 'cylinder', size: [0.0134, 0.25], fromto: [0, 0, 0, ...to] });
    const scene = {
      nodes: [{ id: 'f', name: 'Frame', pos: [0, 0, 0], joints: [], children: [], geoms: [
        strut('a', [0.5, 0, 0]),
        strut('b', [0.5 * Math.cos(a), 0.5 * Math.sin(a), 0]),
      ] }],
    } as unknown as SceneGraph;
    const b = breakdownPipeFrame(scene);
    const sim = simulatePipeFrame(b);
    expect(sim.clashes.length).toBe(1);
    expect(sim.clashes[0].overlapMm).toBeGreaterThan(5);
    expect(sim.maxGapMm).toBeLessThan(0.05);
  });

});

describe('pipe structure examples', () => {
  it('stand on a fitting at every joint, and plan the same cut list as the bare struts', async () => {
    const { pipeStructureScene, generatePipeStructurePreset: bare, isPipeHubNode } = await import('../src/utils/tubeAndWireExporter');
    for (const preset of ['mini_greenhouse', 'yard_pub', 'carport', 'geodesic_dome'] as const) {
      // Named as the store names them: every hub after the first gets `hub_core_2`…
      const { withUniqueNames } = await import('../src/utils/uniqueNames');
      const nodes = withUniqueNames({ nodes: pipeStructureScene(preset) } as unknown as SceneGraph).nodes;
      const withHubs = breakdownPipeFrame({ nodes } as unknown as SceneGraph);
      const without = breakdownPipeFrame({ nodes: bare(preset) } as unknown as SceneGraph);
      expect(withHubs.struts.length).toBe(without.struts.length);
      expect(withHubs.totalPipeLengthMm).toBeCloseTo(without.totalPipeLengthMm, 6);
      // Every joint of two or more pipes has its fitting.
      expect(nodes.filter(isPipeHubNode).length).toBe(without.hubs.filter((h) => h.ports.length >= 2).length);
    }
  });
});
