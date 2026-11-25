import { describe, it, expect } from 'vitest';
import { simulateMilling } from '../src/utils/cutSimulation';
import { simulatedBody } from '../src/utils/simulatedPart';
import { sheetFoldStockTransform } from '../src/utils/sheetFoldSimulation';
import { timberSimulationRequest } from '../src/utils/timberSimulation';
import { simulateSlipCast } from '../src/utils/slipCastSimulation';
import { buildSlipMold } from '../src/utils/slipCastMold';
import { loadManifold } from '../src/utils/sculptCut';

function boxSoupMm(w: number, d: number, h: number): Float64Array {
  const x0 = -w / 2, x1 = w / 2, y0 = -d / 2, y1 = d / 2;
  const v: [number, number, number][] = [
    [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0],
    [x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [2, 3, 7], [2, 7, 6],
    [1, 2, 6], [1, 6, 5],
    [3, 0, 4], [3, 4, 7],
  ];
  const out = new Float64Array(faces.length * 9);
  faces.forEach(([a, b, c], t) => {
    out.set(v[a], t * 9);
    out.set(v[b], t * 9 + 3);
    out.set(v[c], t * 9 + 6);
  });
  return out;
}

describe('virtual fabrication simulator audit fixes', () => {
  describe('cutSimulation G-code modal safety', () => {
    it('ignores machine-coordinate G53 and G10 offset lines instead of cutting stock', () => {
      const res = simulateMilling(
        [
          'G21 G90',
          'G0 Z5',
          'G0 X10 Y10',
          'G53 G0 Z-1',
          'G10 L20 P1 X0 Y0 Z0',
          'G0 X20 Y10',
        ].join('\n'),
        {
          widthMm: 30,
          depthMm: 20,
          cellMm: 0.5,
          tools: { 1: { shape: 'flat', diameterMm: 4 } },
        },
      );
      expect(res.cuts).toEqual([]);
      expect(res.at(10, 10)).toBe(0);
    });

    it('handles G91 relative mode, G20 inches, and explicit + signs accurately', () => {
      const res = simulateMilling(
        [
          'G20 G90',
          'G0 Z+0.5',
          'G0 X0.5 Y0.5',
          'G1 Z-0.1 F10',
          'G91',
          'G1 X+0.5 F10',
          'G0 Z+0.5',
          'G90',
        ].join('\n'),
        {
          widthMm: 40,
          depthMm: 30,
          cellMm: 0.5,
          tools: { 1: { shape: 'flat', diameterMm: 4 } },
        },
      );
      // 0.5 in = 12.7 mm, +0.5 in = 25.4 mm, depth -0.1 in = -2.54 mm
      expect(res.at(12.7, 12.7)).toBeCloseTo(-2.54, 2);
      expect(res.at(25.4, 12.7)).toBeCloseTo(-2.54, 2);
      // Relative retract G0 Z+0.5 lifted clear (+12.7 mm) so no rapid cuts.
      expect(res.cuts.filter((c) => c.rapid)).toEqual([]);
    });
  });

  describe('simulatedBody empty-mesh and zero-scale guards', () => {
    it('produces finite pos for empty meshes in both beside and overlay placement', () => {
      const empty = { positions: new Float32Array(0), faces: new Uint32Array(0), cellMm: 0.5, toleranceMm: 0.1 };
      const transform = {
        modelOriginMm: [0, 0, 0] as [number, number, number],
        workOriginMm: [0, 0, 0] as [number, number, number],
        scale: [0, 0, 0] as [number, number, number],
        modelMinMm: [0, 0, 0] as [number, number, number],
        modelMaxMm: [20, 20, 10] as [number, number, number],
      };

      const beside = simulatedBody(empty, transform, { id: 's1', name: 'empty-beside', kind: 'machining', placement: 'beside' });
      const overlay = simulatedBody(empty, transform, { id: 's2', name: 'empty-overlay', kind: 'machining', placement: 'overlay' });

      expect(beside.pos.every(Number.isFinite)).toBe(true);
      expect(overlay.pos.every(Number.isFinite)).toBe(true);
    });
  });

  describe('stock transform bounds guards', () => {
    it('returns finite bounds for empty sheetFoldStockTransform and zero scaleFactor', () => {
      const tr = sheetFoldStockTransform({ islands: [] }, 0);
      expect(tr.scale).toEqual([1, 1, 1]);
      expect(tr.modelMinMm.every(Number.isFinite)).toBe(true);
      expect(tr.modelMaxMm.every(Number.isFinite)).toBe(true);
    });

    it('returns finite bounds in timberSimulationRequest for an empty simulation mesh', () => {
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      const { request } = timberSimulationRequest(
        {
          positions: new Float32Array(0),
          faces: new Uint32Array(0),
          volumeMm3: 0,
          parts: 0,
          windows: 0,
          joints: [],
          setupFaults: [],
          byHand: 0,
          cellMm: 0.1,
        },
        identity,
      );
      expect(request.transform.modelMinMm.every(Number.isFinite)).toBe(true);
      expect(request.transform.modelMaxMm.every(Number.isFinite)).toBe(true);
    });
  });

  describe('slipCastSimulation custom shrink note parity', () => {
    it('reports the actual custom shrink percentage in notes instead of material default', async () => {
      const wasm = await loadManifold();
      const mold = buildSlipMold(wasm, boxSoupMm(40, 40, 50), {
        sides: 2,
        base: false,
        splitCase: false,
        shrinkPercent: 20,
      });
      const res = simulateSlipCast(
        wasm,
        {
          cavity: mold.cavity,
          spare: mold.spare,
          partTopMm: mold.report.partTopMm,
          footMm: mold.report.footMm,
          scale: mold.report.scale,
          slip: mold.slip,
        },
        4,
      );
      expect(res.notes[0]).toMatch(/after 20% shrink/);
      expect(res.firedWallMm).toBeCloseTo(3.2, 1);
    });
  });
});
