// A section through the parts, as numbers: outlines, holes, thickest, neck.
import { describe, it, expect, beforeAll } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { sectionOfSoup } from '../src/utils/sectionQuery';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

function soupOf(m: Manifold): Float64Array {
  const mesh = m.getMesh();
  const out = new Float64Array(mesh.triVerts.length * 3);
  for (let i = 0; i < mesh.triVerts.length; i++) {
    const v = mesh.triVerts[i] * mesh.numProp;
    out[i * 3] = mesh.vertProperties[v]; out[i * 3 + 1] = mesh.vertProperties[v + 1]; out[i * 3 + 2] = mesh.vertProperties[v + 2];
  }
  return out;
}

describe('section query', () => {
  it('finds a 3 mm neck where a handle joins a cup, and the cup\'s ring', () => {
    // A cup 80 mm across with a 4 mm wall, and a lug joined to it by a 3 mm web.
    const cup = wasm.Manifold.cylinder(60, 40, 40, 96).subtract(wasm.Manifold.cylinder(60, 36, 36, 96).translate([0, 0, 4]));
    const web = wasm.Manifold.cube([6, 3, 20], true).translate([42, 0, 30]);
    const lug = wasm.Manifold.cube([12, 12, 20], true).translate([50, 0, 30]);
    const r = sectionOfSoup(wasm, soupOf(cup.add(web).add(lug)), 'z', 30);
    expect(r.axes).toEqual(['x', 'y']);
    expect(r.pieces.length).toBe(1);
    const p = r.pieces[0];
    expect(p.holes).toBe(1);
    expect(p.neckMm).toBeGreaterThan(2.5);
    expect(p.neckMm).toBeLessThan(3.5);
    // Its thickest is the lug, 12 mm square.
    expect(p.thickestMm).toBeGreaterThan(11);
    expect(p.thickestMm).toBeLessThan(13);
  });

  it('cuts along x through the wall, a plain slab with no neck', () => {
    const slab = wasm.Manifold.cube([40, 6, 30], true);
    const r = sectionOfSoup(wasm, soupOf(slab), 'x', 0);
    expect(r.axes).toEqual(['y', 'z']);
    expect(r.pieces.length).toBe(1);
    expect(r.pieces[0].areaMm2).toBeCloseTo(6 * 30, 0);
    expect(r.pieces[0].thickestMm).toBeCloseTo(6, 0);
    expect(r.pieces[0].neckMm).toBeUndefined();
    expect(r.spanMm).toEqual([-20, 20]);
  });
});
