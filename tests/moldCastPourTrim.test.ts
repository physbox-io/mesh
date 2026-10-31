import { describe, it, expect } from 'vitest';
import { simulateCastFromMoldNode } from '../src/utils/moldCastSimulation';
import type { SceneGeom, SceneNode } from '../src/types/scene';

// A closed mold in one body: a 30 x 30 x 20 mm cavity with a 4 x 4 mm sprue
// running 10 mm up to the top face. Boxes in mm -> MuJoCo half-extents in metres.
const box = (name: string, [x0, y0, z0]: number[], [x1, y1, z1]: number[]): SceneGeom =>
  ({
    name,
    type: 'box',
    size: [(x1 - x0) / 2000, (y1 - y0) / 2000, (z1 - z0) / 2000],
    pos: [(x0 + x1) / 2000, (y0 + y1) / 2000, (z0 + z1) / 2000],
  }) as SceneGeom;

const ring = (name: string, inner: number, outer: number, z0: number, z1: number): SceneGeom[] => [
  box(`${name}_s`, [-outer, -outer, z0], [outer, -inner, z1]),
  box(`${name}_n`, [-outer, inner, z0], [outer, outer, z1]),
  box(`${name}_w`, [-outer, -inner, z0], [-inner, inner, z1]),
  box(`${name}_e`, [inner, -inner, z0], [outer, inner, z1]),
];

const mold = {
  id: 'mold',
  name: 'mold',
  type: 'body',
  pos: [0, 0, 0],
  joints: [],
  geoms: [box('floor', [-30, -30, 0], [30, 30, 10]), ...ring('walls', 15, 30, 10, 30), ...ring('lid', 2, 30, 30, 40)],
  children: [],
} as unknown as SceneNode;

describe('pouring into a mold body', () => {
  it('keeps the sprue unless asked to trim it', async () => {
    const kept = await simulateCastFromMoldNode(mold, { pour: { direction: '+z' } });
    expect(kept.success).toBe(true);
    expect(kept.sizeMm.height).toBeCloseTo(30, 0);
    expect(kept.castVolumeMm3).toBeGreaterThan(18_100);

    const trimmed = await simulateCastFromMoldNode(mold, { pour: { direction: '+z' }, trimChannels: true });
    expect(trimmed.success).toBe(true);
    expect(trimmed.sizeMm.height).toBeLessThan(21);
    expect(trimmed.castVolumeMm3).toBeLessThan(18_100);
    expect(trimmed.castVolumeMm3).toBeGreaterThan(17_900);
  });

  it('turns the casting onto its poured face only when asked to', async () => {
    const upright = await simulateCastFromMoldNode(mold, { pour: { direction: '+z' } });
    const asPoured = await simulateCastFromMoldNode(mold, { pour: { direction: '+z' }, orientUpright: false });
    const sprueEnd = (m: { positions: Float32Array }) => {
      // The sprue is the only material within 4 mm of the axis above 22 mm or below 8 mm.
      let hi = 0, lo = 0;
      for (let i = 0; i < m.positions.length; i += 3) {
        if (Math.abs(m.positions[i]) <= 2.01 && Math.abs(m.positions[i + 1]) <= 2.01) {
          if (m.positions[i + 2] > 22) hi++;
          if (m.positions[i + 2] < 8) lo++;
        }
      }
      return hi > lo ? 'top' : 'bottom';
    };
    expect(sprueEnd(upright.mesh)).toBe('bottom');
    expect(sprueEnd(asPoured.mesh)).toBe('top');
  });
});
