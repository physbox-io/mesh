// Cast warnings that say where: air a pour holds, pockets left out of the
// casting, and high points a pour hole does not vent.
import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { buildPourBox } from '../src/utils/siliconeMold';
import { simulateCastFromMoldNode } from '../src/utils/moldCastSimulation';
import type { SceneGeom, SceneNode } from '../src/types/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

function boxSoup([x0, y0, z0]: number[], [x1, y1, z1]: number[]): number[] {
  const c = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out: number[] = [];
  for (const [a, b, cc, d] of quads) out.push(...c(a), ...c(b), ...c(cc), ...c(a), ...c(cc), ...c(d));
  return out;
}

/** Boxes in mm, as MuJoCo half-extents in metres. */
const box = (name: string, [x0, y0, z0]: number[], [x1, y1, z1]: number[]): SceneGeom =>
  ({
    name,
    type: 'box',
    size: [(x1 - x0) / 2000, (y1 - y0) / 2000, (z1 - z0) / 2000],
    pos: [(x0 + x1) / 2000, (y0 + y1) / 2000, (z0 + z1) / 2000],
  }) as SceneGeom;

const body = (geoms: SceneGeom[]) =>
  ({ id: 'mold', name: 'mold', type: 'body', pos: [0, 0, 0], joints: [], geoms, children: [] }) as unknown as SceneNode;

describe('pour box hole', () => {
  it('names the master\'s other high points a pour hole leaves holding air', () => {
    // Two posts joined low down: a hole on one leaves the other's top full of air.
    const master = [...boxSoup([-30, -5, 0], [30, 5, 5]), ...boxSoup([-30, -5, 5], [-20, 5, 25]), ...boxSoup([20, -5, 5], [30, 5, 20])];
    const box = buildPourBox(wasm, master, { hole: 'pour', holeAtMm: [-25, 0] });
    const w = box.report.warnings.find((x) => x.includes('other high point'));
    expect(w).toBeDefined();
    expect(w).toMatch(/\(2\d, -?\d, 20 mm\)/);
  });

  it('says nothing of a flat top the hole stands on', () => {
    const brick = boxSoup([-40, -10, 0], [40, 10, 20]);
    const box = buildPourBox(wasm, brick, { hole: 'pour', holeAtMm: [25, 0] });
    expect(box.report.warnings.some((x) => x.includes('other high point'))).toBe(false);
  });
});

describe('pouring into an open mold', () => {
  it('cuts out the air under an overhang and says where it is on the casting', async () => {
    // An open box, 40 x 40 x 20 inside, with a shelf standing in from one wall
    // whose underside has a recess 4 mm up into it: the air in the recess
    // cannot get out. (Under a flat shelf the level rises evenly and holds none.)
    const mold = body([
      box('floor', [-25, -25, 0], [25, 25, 5]),
      box('s', [-25, -25, 5], [25, -20, 25]), box('n', [-25, 20, 5], [25, 25, 25]),
      box('w', [-25, -20, 5], [-20, 20, 25]), box('e', [20, -20, 5], [25, 20, 25]),
      box('shelfA', [-20, -20, 12], [-15, 20, 16]), box('shelfB', [-5, -20, 12], [0, 20, 16]),
      box('shelfTop', [-20, -20, 16], [0, 20, 20]),
    ]);
    const cast = await simulateCastFromMoldNode(mold, { pour: { direction: '+z' }, orientUpright: false });
    expect(cast.success).toBe(true);
    const w = cast.warnings.find((x) => x.startsWith('Air stays'));
    expect(w).toBeDefined();
    // The pocket is the recess: -X of the middle, its top 11 mm up the casting.
    const at = cast.fill?.pocketsAtMm?.[0]?.atMm;
    expect(at).toBeDefined();
    expect(at![0]).toBeLessThan(-2);
    expect(at![2]).toBeGreaterThan(8);
    expect(at![2]).toBeLessThan(13);
  });

  it('says so when a second pocket fills but is not joined to the casting', async () => {
    // Two open cups side by side in one mold body.
    const cup = (x: number): SceneGeom[] => [
      box(`f${x}`, [x - 10, -10, 0], [x + 10, 10, 3]),
      box(`s${x}`, [x - 10, -10, 3], [x + 10, -7, 15]), box(`n${x}`, [x - 10, 7, 3], [x + 10, 10, 15]),
      box(`w${x}`, [x - 10, -7, 3], [x - 7, 7, 15]), box(`e${x}`, [x + 7, -7, 3], [x + 10, 7, 15]),
    ];
    const mold = body([...cup(-15), ...cup(15), box('bridge', [-5, -10, 0], [5, 10, 15])]);
    const cast = await simulateCastFromMoldNode(mold, { pour: { direction: '+z' } });
    expect(cast.success).toBe(true);
    expect(cast.warnings.some((x) => x.includes('not joined to it'))).toBe(true);
  });
});
