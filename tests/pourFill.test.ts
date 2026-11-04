import { describe, it, expect, beforeAll } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { voxelizeCavity, simulateFill } from '../src/utils/pourFill';

// Cavities as poured, +z up: what is drawn is where the liquid can go, with
// the sprue and vents reaching up to the mold's top face at z = 30.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

function flat(m: Manifold): Float64Array {
  const mesh = m.getMesh();
  const out = new Float64Array(mesh.triVerts.length * 3);
  for (let t = 0; t < mesh.triVerts.length; t++) {
    const v = mesh.triVerts[t] * mesh.numProp;
    out[t * 3] = mesh.vertProperties[v];
    out[t * 3 + 1] = mesh.vertProperties[v + 1];
    out[t * 3 + 2] = mesh.vertProperties[v + 2];
  }
  return out;
}

const box = (x: number, y: number, z: number, w: number, d: number, h: number) =>
  wasm.Manifold.cube([w, d, h], false).translate([x, y, z]);
const tube = (x: number, y: number, z0: number, z1: number, dia: number) =>
  wasm.Manifold.cylinder(z1 - z0, dia / 2, dia / 2, 32, false).translate([x, y, z0]);
const union = (...ms: Manifold[]) => ms.reduce((a, b) => a.add(b));

function pour(m: Manifold, cell = 0.4) {
  return simulateFill(voxelizeCavity(flat(m), cell), 3.5);
}

describe('pouring with air in the mold', () => {
  it('fills a block through a wide sprue: the air goes up past the resin', () => {
    const r = pour(union(box(-10, -10, 0, 20, 20, 10), tube(0, 0, 9, 30, 8)));
    expect(r.filledShare).toBeGreaterThan(0.99);
  });

  it('fills nothing past a sprue too narrow for a bubble, with no vent', () => {
    const r = pour(union(box(-10, -10, 0, 20, 20, 10), tube(0, 0, 9, 30, 2.4)));
    // The resin plugs the sprue: the block stays air.
    expect(r.filledShare).toBeLessThan(0.1);
    expect(r.pockets[0].volumeMm3).toBeGreaterThan(20 * 20 * 10 * 0.9);
  });

  it('fills the same block once a vent lets its air out', () => {
    const r = pour(union(box(-10, -10, 0, 20, 20, 10), tube(0, 0, 9, 30, 2.4), tube(8, 8, 9, 30, 1.6)));
    expect(r.filledShare).toBeGreaterThan(0.98);
  });

  it('leaves the air under a ceiling with no vent, filling from the bottom', () => {
    // A down-sprue to the floor of a block with a dome-like pocket rising from its roof.
    const cavity = union(
      box(-10, -10, 0, 20, 20, 6),
      box(-3, -3, 6, 6, 6, 5), // the pocket, 5 mm up, closed on top
      tube(-8, -8, 3, 30, 8), // the down-sprue, into the block's side
      tube(8, 8, 5, 30, 1.6), // a vent from the block's roof
    );
    const r = pour(cavity);
    expect(r.pockets.length).toBeGreaterThan(0);
    const biggest = r.pockets[0];
    // The pocket's 180 mm³, give or take a cell round it.
    expect(biggest.volumeMm3).toBeGreaterThan(120);
    expect(biggest.volumeMm3).toBeLessThan(260);
    expect(biggest.topMm[2]).toBeGreaterThan(9);
  });

  it('fills a narrow post hanging below a plate only if its air can get out', () => {
    // A thin plate under the sprue, with a 2.4 mm post hanging off it to a bulb.
    const plate = box(-10, -10, 20, 20, 20, 2);
    const post = tube(9, 9, 7, 20.5, 2.4);
    const bulb = box(8, 8, 2, 6, 6, 6);
    const sprue = tube(-5, -5, 21, 30, 8);
    const vent = tube(5, -5, 21, 30, 1.6);
    const without = pour(union(plate, post, bulb, sprue, vent), 0.3);
    // The bulb and post have no way out for their air but up the post itself.
    expect(without.trappedMm3).toBeGreaterThan(6 * 6 * 6 * 0.8);
    // A vent from the bulb's top straight up, clear of the plate, lets it fill.
    const ventBulb = tube(12, 12, 7, 30, 1.6);
    const withVent = pour(union(plate, post, bulb, sprue, vent, ventBulb), 0.3);
    // What air is left is not in the bulb or the post (x, y past 7.5, below the plate).
    const inBulb = withVent.pockets.filter((p) => p.topMm[0] > 7.5 && p.topMm[1] > 7.5 && p.topMm[2] < 20);
    expect(inBulb.reduce((s, p) => s + p.volumeMm3, 0)).toBeLessThan(5);
  });
});
