import { describe, it, expect } from 'vitest';
import {
  BLOCK_FACES,
  ORIENT_MATRIX,
  determinant,
  describeTurn,
  orient,
  setupFrame,
  type BlockFace,
} from '../src/utils/orient';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import type { SceneGraph } from '../src/types/scene';

const stock = { widthMm: 150, depthMm: 120, thicknessMm: 20 };

describe('setup frames', () => {
  for (const face of BLOCK_FACES) {
    describe(face, () => {
      const f = setupFrame(face, stock);

      it('is a rotation, not a mirror', () => {
        expect(determinant(f.rotation)).toBeCloseTo(1, 12);
      });

      it('puts the block +X +Y of the corner and below Z0', () => {
        const { widthMm: W, depthMm: D, thicknessMm: T } = stock;
        for (const x of [0, W]) for (const y of [0, D]) for (const z of [-T, 0]) {
          const [a, b, c] = f.toSetup([x, y, z]);
          expect(a).toBeGreaterThanOrEqual(-1e-9);
          expect(a).toBeLessThanOrEqual(f.stock.widthMm + 1e-9);
          expect(b).toBeGreaterThanOrEqual(-1e-9);
          expect(b).toBeLessThanOrEqual(f.stock.depthMm + 1e-9);
          expect(c).toBeLessThanOrEqual(1e-9);
          expect(c).toBeGreaterThanOrEqual(-f.stock.thicknessMm - 1e-9);
        }
        expect(f.stock.widthMm * f.stock.depthMm * f.stock.thicknessMm).toBeCloseTo(W * D * T, 6);
      });

      it('turns back to where it started', () => {
        const p: [number, number, number] = [12.5, 33, -7];
        const back = f.toFirst(f.toSetup(p));
        back.forEach((v, a) => expect(v).toBeCloseTo(p[a], 9));
      });

      it('puts the named face up', () => {
        expect(f.faceAt.up).toBe(face);
        // A point on that face sits at Z0 in the new frame.
        const onFace: Record<BlockFace, [number, number, number]> = {
          '+z': [10, 10, 0], '-z': [10, 10, -20], '+x': [150, 10, -5],
          '-x': [0, 10, -5], '+y': [10, 120, -5], '-y': [10, 0, -5],
        };
        expect(f.toSetup(onFace[face])[2]).toBeCloseTo(0, 9);
      });

      it('says how to stand the block in words that match the matrix', () => {
        const text = describeTurn(f);
        const names: Record<BlockFace, string> = {
          '+z': 'top', '-z': 'underside', '+x': 'right end', '-x': 'left end', '+y': 'back', '-y': 'front',
        };
        if (face === '+z') return expect(text).toMatch(/top up/);
        expect(text).toContain(`${names[face]} up`);
        if (face !== '-z') {
          expect(text).toContain(`on its ${names[f.faceAt.down]}`);
          expect(text).toContain(`${names[f.faceAt.near]} towards you`);
        }
      });
    });
  }

  it('keeps the edge between setup 1’s top and front at the near-left on a turn onto an end', () => {
    for (const face of ['+x', '-x'] as BlockFace[]) {
      const f = setupFrame(face, stock);
      // Both ends of that edge (y = 0, z = 0) land on the new near-left vertical edge.
      for (const x of [0, 150]) {
        const [a, b] = f.toSetup([x, 0, 0]);
        expect(a).toBeCloseTo(0, 9);
        expect(b).toBeCloseTo(0, 9);
      }
    }
  });

  it('flips -Z left to right, as side B always has been and as its header says', () => {
    const f = setupFrame('-z', stock);
    // Side B reads X as the width less side A's, and Z down from the underside.
    expect(f.toSetup([10, 30, -5])).toEqual([140, 30, -15]);
    expect(describeTurn(f)).toMatch(/left to right/);

    const block: SceneGraph = {
      nodes: [{
        id: 'b', name: 'p', type: 'body', pos: [0, 0, 0],
        geoms: [{ name: 'g', type: 'sphere', size: [0.02] } as never],
        joints: [], children: [],
      }],
    };
    const r = generateSolidMachining(block, deriveSolidOptions(block, { sides: 2 }));
    expect(r.sides[0].gcode).toMatch(/flip the block over LEFT TO RIGHT \(about the Y axis\)/);
  });

  it('still orients the model the way solid machining always has', () => {
    for (const up of Object.keys(ORIENT_MATRIX) as (keyof typeof ORIENT_MATRIX)[]) {
      const m = ORIENT_MATRIX[up];
      expect(determinant(m)).toBeCloseTo(1, 12);
      const p = orient(up, 1, 2, 3);
      expect(p).toEqual([m[0] + 2 * m[1] + 3 * m[2], m[3] + 2 * m[4] + 3 * m[5], m[6] + 2 * m[7] + 3 * m[8]]);
    }
  });
});
