import { describe, it, expect } from 'vitest';
import { applyDraft } from '../src/utils/moldDraft';
import { buildPourBox } from '../src/utils/siliconeMold';
import { buildSlipMold } from '../src/utils/slipCastMold';
import { loadManifold } from '../src/utils/sculptCut';
import { MoldWorkerClient } from '../src/utils/moldWorkerClient';
import type { SceneGraph } from '../src/types/scene';

function boxSoupMm(w: number, d: number, h: number, cx = 0, cy = 0, z0 = 0): Float64Array {
  const x0 = cx - w / 2, x1 = cx + w / 2;
  const y0 = cy - d / 2, y1 = cy + d / 2;
  const z1 = z0 + h;
  const v: [number, number, number][] = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4], // front
    [2, 3, 7], [2, 7, 6], // back
    [1, 2, 6], [1, 6, 5], // right
    [3, 0, 4], [3, 4, 7], // left
  ];
  const out = new Float64Array(faces.length * 9);
  faces.forEach(([a, b, c], t) => {
    out.set(v[a], t * 9);
    out.set(v[b], t * 9 + 3);
    out.set(v[c], t * 9 + 6);
  });
  return out;
}

describe('casting and mold pipeline audit fixes', () => {
  describe('moldDraft extreme angle safety', () => {
    it('clamps draftDeg >= 90 instead of producing negative or infinite tangent slopes', () => {
      const grid = { cols: 5, rows: 5, stepX: 1, stepY: 1, halfW: 2, halfD: 2 };
      const depth = new Float64Array(25);
      depth[12] = 10; // centre cell at depth 10

      const drafted90 = applyDraft(depth, grid, 90, 'remove');
      const drafted120 = applyDraft(depth, grid, 120, 'remove');
      for (let i = 0; i < 25; i++) {
        expect(Number.isFinite(drafted90[i])).toBe(true);
        expect(Number.isFinite(drafted120[i])).toBe(true);
        expect(drafted90[i]).toBeGreaterThanOrEqual(0);
        expect(drafted120[i]).toBeGreaterThanOrEqual(0);
        expect(drafted90[i]).toBeLessThanOrEqual(10);
      }
      // 90° and 120° clamp to the same 89° slope limit.
      expect(Array.from(drafted120)).toEqual(Array.from(drafted90));
    });
  });

  describe('siliconeMold buildPourBox error cleanup & thin-master bounds', () => {
    it('cleans up cleanly when holeAtMm is off the master and still builds valid subsequent boxes', async () => {
      const wasm = await loadManifold();
      const soup = boxSoupMm(20, 20, 20);

      expect(() =>
        buildPourBox(wasm, soup, { hole: 'pour', holeAtMm: [500, 500], splitSleeve: false })
      ).toThrow(/not over the master/i);

      // Subsequent build on the same WASM instance succeeds cleanly.
      const ok = buildPourBox(wasm, soup, { shape: 'box', splitSleeve: false });
      expect(ok.base.faces.length).toBeGreaterThan(0);
      expect(ok.sleeve.faces.length).toBeGreaterThan(0);
      expect(ok.report.siliconeMm3).toBeGreaterThan(0);
    });

    it('handles a degenerate zero-thickness planar master in box and round shapes without empty meshes', async () => {
      const wasm = await loadManifold();
      // Planar master with xMin === xMax === 0
      const planar = boxSoupMm(0, 20, 15);
      const box = buildPourBox(wasm, planar, { shape: 'box', splitSleeve: false });
      expect(box.base.faces.length).toBeGreaterThan(0);
      expect(box.sleeve.faces.length).toBeGreaterThan(0);

      const round = buildPourBox(wasm, planar, { shape: 'round', splitSleeve: false });
      expect(round.base.faces.length).toBeGreaterThan(0);
      expect(round.sleeve.faces.length).toBeGreaterThan(0);
    });
  });

  describe('slipCastMold error cleanup', () => {
    it('cleans up WASM allocations when spareAtMm is off the part and allows subsequent builds', async () => {
      const wasm = await loadManifold();
      const soup = boxSoupMm(30, 30, 40);

      expect(() =>
        buildSlipMold(wasm, soup, { sides: 2, base: false, splitCase: false, spareAtMm: [500, 500] })
      ).toThrow(/not over the part/i);

      const ok = buildSlipMold(wasm, soup, { sides: 2, base: false, splitCase: false });
      expect(ok.pieces.length).toBe(2);
      expect(ok.report.plasterMm3).toBeGreaterThan(0);
    });
  });

  describe('MoldWorkerClient inline fallback measure parity', () => {
    it('computes deviation against masterSoup when cast(options, true) runs inline without Worker', async () => {
      const scene: SceneGraph = {
        name: 'cube',
        nodes: [
          {
            id: 'box-1',
            name: 'box',
            position: [0, 0.015, 0],
            geoms: [{ name: 'box_geom', type: 'box', size: [0.015, 0.015, 0.015] }],
          },
        ],
      };
      const client = new MoldWorkerClient();
      try {
        const preview = await client.generate(scene, { moldType: 'open', draftAngleDeg: 0 });
        expect(preview.summary.success).toBe(true);
        const castRes = await client.cast({ trimChannels: true }, true);
        expect(castRes.success).toBe(true);
        expect(castRes.deviation).toBeDefined();
        expect(castRes.deviation!.maxMm).toBeLessThan(2);
      } finally {
        client.dispose();
      }
    });
  });
});
