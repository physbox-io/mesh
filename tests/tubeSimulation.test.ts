import { describe, it, expect } from 'vitest';
import type { SceneGraph } from '../src/types/scene';
import {
  breakdownPipeFrame,
  computeTubeCopeJoint,
  computeWireBendSchedule,
  generatePipeStructurePreset,
} from '../src/utils/tubeAndWireExporter';
import { simulateCope, simulatePipeFrame, simulateWire } from '../src/utils/tubeSimulation';
import { analyzeMesh } from '../src/utils/meshIntegrity';

const closed = (m: { positions: Float32Array; faces: Uint32Array }) => {
  const a = analyzeMesh(Array.from(m.positions), Array.from(m.faces))!;
  expect(a.closed).toBe(true);
  expect(a.consistentlyWound).toBe(true);
  expect(a.volume).toBeGreaterThan(0);
  return a.volume;
};

describe('tube and wire simulation', () => {
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

  it('seats a cope cut from its template with nothing to fill but the bevel', () => {
    for (const spec of [
      { cutTubeOdMm: 33.4, cutTubeWallMm: 3.38, targetKind: 'tube' as const, targetTubeOdMm: 42.2, angleDeg: 45 },
      { cutTubeOdMm: 25, cutTubeWallMm: 2, targetKind: 'tube' as const, targetTubeOdMm: 50, angleDeg: 90, offsetMm: 8 },
      { cutTubeOdMm: 25, cutTubeWallMm: 2, targetKind: 'tube' as const, targetTubeOdMm: 25, angleDeg: 60, clockAngleDeg: 30 },
      { cutTubeOdMm: 30, cutTubeWallMm: 2, targetKind: 'plane' as const, angleDeg: 50 },
    ]) {
      const profile = computeTubeCopeJoint(spec);
      const sim = simulateCope(profile);
      expect(sim.maxGapMm).toBeLessThan(0.05);
      closed(sim);
    }
  });

  it('shows a template made for the wrong angle as a gap', () => {
    const right = { cutTubeOdMm: 33.4, cutTubeWallMm: 3.38, targetKind: 'tube' as const, targetTubeOdMm: 42.2, angleDeg: 45 };
    const wrong = computeTubeCopeJoint({ ...right, angleDeg: 55 });
    const sim = simulateCope({ ...wrong, spec: right });
    expect(sim.maxGapMm).toBeGreaterThan(2);
  });

  it('bends a wire from its schedule onto the model path', () => {
    const pts: [number, number, number][] = [[0, 0, 0], [45, 0, 0], [45, 35, 0], [45, 35, 25], [85, 35, 25], [85, 80, 60]];
    const s = computeWireBendSchedule(pts, { wireDiameterMm: 3, bendRadiusMm: 6, springbackFactor: 1.04 });
    const sim = simulateWire(s);
    expect(sim.bends).toBe(4);
    expect(sim.deviation.maxMm).toBeLessThan(0.1);
    expect(sim.lengthMm).toBeCloseTo(s.totalCutLengthMm, 1);
    const v = closed(sim);
    expect(v / (Math.PI * 1.5 * 1.5 * sim.lengthMm)).toBeGreaterThan(0.95);
  });

  it('shows a wire bent without the springback allowance as off the path', () => {
    const pts: [number, number, number][] = [[0, 0, 0], [45, 0, 0], [45, 35, 0], [45, 35, 25], [85, 35, 25]];
    const s = computeWireBendSchedule(pts, { springbackFactor: 1.04 });
    const sim = simulateWire({ ...s, options: { ...s.options, springbackFactor: 1.1 } });
    expect(sim.deviation.maxMm).toBeGreaterThan(1);
  });
});
