import { describe, it, expect } from 'vitest';
import { simulateCastFromMoldNode, simulateCastFromMoldTriangles } from '../src/utils/moldCastSimulation';
import { pourNodeFor } from '../src/utils/pourTarget';
import type { SceneGeom, SceneNode } from '../src/types/scene';

// A mother mold for a silicone mold, in two bodies the way one is printed: a
// master (a base plate with a square candle on it and a groove round it) and a
// sleeve standing in the groove. The sleeve clears the groove's inner wall by
// 0.2 mm, so the silicone grows a 3 mm fin round its rim, as a real one does.
// mm -> MuJoCo half-extents in metres.
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

const body = (id: string, geoms: SceneGeom[]): SceneNode =>
  ({ id, name: id, type: 'body', pos: [0, 0, 0], joints: [], geoms, children: [] }) as unknown as SceneNode;

const master = body('master', [
  box('plate_floor', [-40, -40, 0], [40, 40, 3]),
  box('plate_inner', [-20.8, -20.8, 3], [20.8, 20.8, 6]),
  ...ring('plate_outer', 23.2, 40, 3, 6),
  box('candle', [-10, -10, 6], [10, 10, 36]),
]);
const sleeve = body('sleeve', ring('sleeve', 21, 23, 3, 50));

function trianglesOf(mesh: { positions: Float32Array; faces: Uint32Array }): Float64Array {
  const out = new Float64Array(mesh.faces.length * 3);
  for (let i = 0; i < mesh.faces.length; i++) {
    for (let k = 0; k < 3; k++) out[i * 3 + k] = mesh.positions[mesh.faces[i] * 3 + k];
  }
  return out;
}

describe('pouring into selected bodies', () => {
  it('fills a master and its sleeve with silicone, not the air round the sleeve', async () => {
    const mold = pourNodeFor([master, sleeve], ['master', 'sleeve']);
    expect(mold).not.toBeNull();
    const silicone = await simulateCastFromMoldNode(mold!, { pour: {} });
    expect(silicone.success).toBe(true);
    // The sleeve's bore, 42 mm, from the plate to just under the sleeve's top.
    expect(silicone.sizeMm.width).toBeCloseTo(42, 0);
    expect(silicone.sizeMm.height).toBeCloseTo(47, 0);
    // 42² x 44 less the 20 x 20 x 30 candle, plus a 0.2 x 3 mm fin round the rim.
    expect(silicone.castVolumeMm3).toBeGreaterThan(65_500);
    expect(silicone.castVolumeMm3).toBeLessThan(65_800);
    expect(silicone.pour?.direction).toBe('+z');
    expect(silicone.pour?.undercutMm2).toBe(0);
  });

  it('casts the candle from that silicone, stopping where the fin would let it spill', async () => {
    const silicone = await simulateCastFromMoldNode(pourNodeFor([master, sleeve], ['master', 'sleeve'])!, { pour: {} });
    const candle = await simulateCastFromMoldTriangles(trianglesOf(silicone.mesh), { pour: {} });
    expect(candle.success).toBe(true);
    expect(candle.sizeMm.width).toBeCloseTo(20, 0);
    expect(candle.sizeMm.depth).toBeCloseTo(20, 0);
    // The fill stops within a step (0.25 mm) of the face the candle stood on.
    expect(candle.sizeMm.height).toBeGreaterThan(29.7);
    expect(candle.sizeMm.height).toBeLessThanOrEqual(30.01);
    expect(candle.castVolumeMm3).toBeGreaterThan(11_850);
  });

  it('pours into the silicone however it stands: as cast, turned over, or on its side', async () => {
    const silicone = await simulateCastFromMoldNode(pourNodeFor([master, sleeve], ['master', 'sleeve'])!, { pour: {} });
    const upright = trianglesOf(silicone.mesh);
    // As it comes off the master: opening underneath. Then lying with it facing +X.
    const turnedOver = upright.map((v, i) => (i % 3 === 0 ? v : -v));
    const onSide = upright.map((v, i, a) => {
      const k = i % 3;
      const base = i - k;
      return k === 0 ? a[base + 2] : k === 1 ? a[base + 1] : -a[base];
    });
    for (const [tris, dir] of [[upright, '+z'], [turnedOver, '-z'], [onSide, '+x']] as const) {
      const candle = await simulateCastFromMoldTriangles(Float64Array.from(tris), { pour: {} });
      expect(candle.success).toBe(true);
      expect(candle.pour?.direction).toBe(dir);
      expect(candle.castVolumeMm3).toBeGreaterThan(11_850);
      expect(candle.castVolumeMm3).toBeLessThan(12_050);
    }
  });

  it('fills to the depth asked for, and no deeper than the rim', async () => {
    const silicone = await simulateCastFromMoldNode(pourNodeFor([master, sleeve], ['master', 'sleeve'])!, { pour: {} });
    const tris = trianglesOf(silicone.mesh);
    const part = await simulateCastFromMoldTriangles(tris, { pour: { fillMm: 10 } });
    expect(part.pour?.filledMm).toBeCloseTo(10, 1);
    expect(part.sizeMm.height).toBeCloseTo(10, 1);
    expect(part.castVolumeMm3).toBeCloseTo(4000, -1);
    const full = await simulateCastFromMoldTriangles(tris, { pour: { fillMm: 500 } });
    expect(full.pour?.filledMm).toBe(full.pour?.depthMm);
  });

  it('takes a wick hole through the silicone as plugged, and says so', async () => {
    // A 2 x 2 mm wick pin on the candle, its tip above the silicone's fill line.
    const pinned = { ...master, geoms: [...master.geoms, box('pin', [-1, -1, 36], [1, 1, 47])] } as SceneNode;
    const silicone = await simulateCastFromMoldNode(pourNodeFor([pinned, sleeve], ['master', 'sleeve'])!, { pour: { fillMm: 40 } });
    expect(silicone.success).toBe(true);
    const candle = await simulateCastFromMoldTriangles(trianglesOf(silicone.mesh), { pour: {} });
    expect(candle.success).toBe(true);
    expect(candle.pour?.plugMm2).toBeCloseTo(4, 0);
    // The candle and the wax in the wick hole, through the 40 mm of silicone.
    expect(candle.castVolumeMm3).toBeGreaterThan(11_850 + 4 * 9);
  });

  it('only pours from the side it is told to', async () => {
    const silicone = await simulateCastFromMoldNode(pourNodeFor([master, sleeve], ['master', 'sleeve'])!, { pour: {} });
    const res = await simulateCastFromMoldTriangles(trianglesOf(silicone.mesh), { pour: { direction: '+x' } });
    expect(res.success).toBe(false);
  });

  it('says when a rigid mold would hold the casting in', async () => {
    // A box with a 20 mm pocket under a lip that narrows its mouth to 10 mm.
    const lipped = body('lipped', [
      box('floor', [-15, -15, 0], [15, 15, 3]),
      ...ring('wall', 10, 15, 3, 23),
      ...ring('lip', 5, 10, 20, 23),
    ]);
    const res = await simulateCastFromMoldNode(lipped, { pour: {} });
    expect(res.success).toBe(true);
    // The pocket's plan less the mouth: 20² - 10² mm².
    expect(res.pour?.undercutMm2).toBeGreaterThan(250);
    expect(res.pour?.undercutMm2).toBeLessThan(350);
  });

  it('refuses a solid part, which holds nothing', async () => {
    const res = await simulateCastFromMoldNode(body('block', [box('b', [0, 0, 0], [20, 30, 10])]), { pour: {} });
    expect(res.success).toBe(false);
  });

  it('places a nested body where it stands in the world', () => {
    const child = body('child', [box('c', [0, 0, 0], [1, 1, 1])]);
    const parent = { ...body('parent', []), pos: [0.1, 0, 0], children: [child] } as SceneNode;
    const node = pourNodeFor([parent], ['child']);
    expect(node?.id).toBe('child');
    expect(node?.pos?.[0]).toBeCloseTo(0.1, 6);
  });
});
