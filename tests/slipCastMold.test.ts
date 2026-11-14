// The slip-cast mold: plaster pieces round a part, and the printed cases that
// cast them, checked as a potter would use them.
import { describe, it, expect, beforeAll } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { buildSlipMold, type SlipMesh } from '../src/utils/slipCastMold';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { simulateSlipCast } from '../src/utils/slipCastSimulation';

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

function solidOf(m: SlipMesh): Manifold {
  const mesh = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(m.positions), triVerts: Uint32Array.from(m.faces) });
  mesh.merge();
  return new wasm.Manifold(mesh);
}

/** An open vase: a bellied profile revolved, hollowed with a 4 mm wall, open at the top. */
function vase(): Manifold {
  const outer: [number, number][] = [[0, 0], [30, 0], [45, 40], [40, 90], [22, 120], [26, 140], [0, 140]];
  const inner: [number, number][] = [[0, 4], [26, 4], [41, 40], [36, 90], [18, 120], [22, 141], [0, 141]];
  const o = wasm.Manifold.revolve(new wasm.CrossSection([outer]), 96);
  const i = wasm.Manifold.revolve(new wasm.CrossSection([inner]), 96);
  return o.subtract(i);
}

/** A mug: a 4 mm cup with a handle loop standing out to +X. */
function mug(): Manifold {
  const cup = wasm.Manifold.cylinder(90, 40, 40, 96).subtract(wasm.Manifold.cylinder(90, 36, 36, 96).translate([0, 0, 4]));
  const handle = wasm.Manifold.cylinder(8, 25, 25, 64).subtract(wasm.Manifold.cylinder(8, 17, 17, 64)).rotate([90, 0, 0])
    .translate([40, 4, 45]).subtract(wasm.Manifold.cylinder(90, 38, 38, 96));
  return cup.add(handle);
}

describe('slip-cast mold', () => {
  it('molds an open vase in plaster pieces whose cases are closed printable solids', () => {
    const t0 = Date.now();
    const mold = buildSlipMold(wasm, soupOf(vase()), { slip: 'porcelain-slip' });
    const r = mold.report;
    console.log(JSON.stringify(r), Date.now() - t0, 'ms', mold.pieces.map((p) => [p.name, p.plasterMm3, p.caseSizeMm, p.natches, p.undercutMm2]));
    expect(r.base).toBe(true);
    expect(r.sides).toBe(2);
    expect(mold.pieces.length).toBe(3);
    // Grown for porcelain's 13 % shrink.
    expect(r.scale).toBeCloseTo(1 / 0.87, 3);
    for (const p of mold.pieces) {
      for (const m of [p.plaster, p.casePrint]) {
        const a = analyzeMesh(m.positions, m.faces)!;
        expect(a.closed && a.consistentlyWound).toBe(true);
        expect(a.volume).toBeGreaterThan(0);
        const s = solidOf(m);
        expect(s.status()).toBe('NoError');
        expect(s.decompose().length).toBe(1);
      }
    }
    // No plaster core in the vase: the cavity holds its inside.
    const cavity = solidOf(mold.cavity);
    expect(cavity.volume()).toBeGreaterThan(Math.PI * 30 * 30 * 140 * (1 / 0.87) ** 3 * 0.8);
    // Every side has natches.
    for (const p of mold.pieces.filter((p) => p.name.startsWith('side'))) expect(p.natches.bumps + p.natches.dimples).toBeGreaterThan(0);
  });

  it('splits a mug through its handle', () => {
    const mold = buildSlipMold(wasm, soupOf(mug()), { slip: 'stoneware-slip' });
    console.log(JSON.stringify(mold.report));
    expect(mold.report.sides).toBe(2);
    // The parting plane runs along X, through the handle.
    const d = ((mold.report.splitDeg % 180) + 180) % 180;
    expect(Math.min(d, 180 - d)).toBeLessThan(5);
    expect(mold.report.undercutMm2).toBeLessThan(50);
  });
});

/** How much of `moving`, slid along `pull` by each distance, runs into `fixed`, mm³ (the worst). */
function worstOverlap(moving: Manifold, fixed: Manifold, pull: number[]): number {
  let worst = 0;
  for (const s of [0.5, 2, 5, 10, 20, 40, 80]) {
    const moved = moving.translate([pull[0] * s, pull[1] * s, pull[2] * s]);
    worst = Math.max(worst, moved.intersect(fixed).volume());
  }
  return worst;
}

describe('slip-cast mold draft', () => {
  it('leans a wall square to the parting in away from it, keeping the parting line', () => {
    // A square prism split down the middle: its two walls that run across the
    // parting have no draft until asked.
    const prism = wasm.Manifold.cube([60, 60, 80]).translate([-30, -30, 0]);
    const drafted = buildSlipMold(wasm, soupOf(prism), { sides: 2, shrinkPercent: 0, base: false, draftDeg: 3 });
    const pull = drafted.pieces[0].pull;
    const across = [-pull[1], pull[0]];
    const pts = solidOf(drafted.cavity).slice(40).toPolygons().flat();
    // How far across the parting the wall reaches, by distance from the parting.
    const widthAt = (h: number) => Math.max(...pts.filter((p) => Math.abs(Math.abs(p[0] * pull[0] + p[1] * pull[1]) - h) < 1).map((p) => Math.abs(p[0] * across[0] + p[1] * across[1])));
    expect(widthAt(0)).toBeCloseTo(30, 1);
    expect(widthAt(30)).toBeCloseTo(30 - 30 * Math.tan((3 * Math.PI) / 180), 1);
  });
});

describe('slip-cast mold base', () => {
  it('takes a recess in the foot with the base plug, and nothing else', () => {
    // A solid pot with a 6 mm recess under its foot.
    const pot = wasm.Manifold.cylinder(60, 30, 30, 64).subtract(wasm.Manifold.cylinder(6, 20, 20, 64).translate([0, 0, -0.01]));
    const mold = buildSlipMold(wasm, soupOf(pot), { shrinkPercent: 0 });
    const base = mold.pieces.find((p) => p.name === 'base')!;
    const top = Math.max(...base.plaster.positions.filter((_, i) => i % 3 === 2));
    expect(top).toBeCloseTo(6, 0);
    // A plain cylinder's plug stops at the parting plane.
    const plain = buildSlipMold(wasm, soupOf(wasm.Manifold.cylinder(60, 30, 30, 64)), { shrinkPercent: 0 });
    const plainTop = Math.max(...plain.pieces.find((p) => p.name === 'base')!.plaster.positions.filter((_, i) => i % 3 === 2));
    expect(plainTop).toBeLessThan(0.5);
  });
});

describe('slip-cast mold base under an off-centre foot', () => {
  it('centres the plug on the foot, not on the pour axis', () => {
    // A ball standing on a small knob well forward of its middle (a head on its chin).
    const head = wasm.Manifold.sphere(60, 64).translate([0, 0, 75]).add(wasm.Manifold.sphere(10, 32).translate([0, 50, 15]));
    // Standing on a knob, it gets no plug unless asked.
    expect(buildSlipMold(wasm, soupOf(head), { shrinkPercent: 0 }).report.base).toBe(false);
    const mold = buildSlipMold(wasm, soupOf(head), { shrinkPercent: 0, base: true });
    const base = mold.pieces.find((p) => p.name === 'base')!;
    const [w, d] = base.caseSizeMm;
    // A round plug of a few centimetres, not a sliver reaching back to the middle.
    expect(Math.max(w, d) / Math.min(w, d)).toBeLessThan(1.3);
    const ys = base.plaster.positions.filter((_, i) => i % 3 === 1);
    expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeGreaterThan(40);
  });
});

describe('slip-cast mold release', () => {
  for (const [label, make, sides, draftDeg] of [['vase, 2 sides', vase, 2, 0], ['vase, 3 sides', vase, 3, 0], ['mug, auto', mug, 'auto', 0], ['vase, 3 sides, 2° draft', vase, 3, 2]] as const) {
    it(`${label}: every piece fills its case and lifts out of it, and pulls off the casting`, () => {
      const mold = buildSlipMold(wasm, soupOf(make()), { sides, draftDeg });
      expect(mold.report.draftDeg).toBe(draftDeg);
      const cavity = solidOf(mold.cavity);
      let plaster = 0;
      for (const p of mold.pieces) {
        const piece = solidOf(p.plaster);
        const box = solidOf(p.caseInPlace);
        plaster += piece.volume();
        // The case holds the piece exactly: no overlap where it sits...
        expect(piece.intersect(box).volume()).toBeLessThan(1);
        // ...and it comes straight out through the open face.
        expect(worstOverlap(piece, box, p.pull)).toBeLessThan(5);
        // It pulls off the casting the same way.
        expect(worstOverlap(piece, cavity, p.pull)).toBeLessThan(5);
        // Each case prints as one piece.
        expect(box.decompose().length).toBe(1);
      }
      // Together the pieces are the whole block less the cavity (whose spare
      // runs 1 mm past the block's top, for a clean cut).
      const [w, d, h] = mold.report.blockMm;
      const inBlock = cavity.trimByPlane([0, 0, -1], -(cavity.boundingBox().max[2] - 1)).volume();
      expect(plaster + inBlock).toBeLessThan(w * d * h * 1.002);
      // Two sides make a box block; more, a prism inside that box.
      if (mold.report.sides === 2) expect(plaster + inBlock).toBeGreaterThan(w * d * h * 0.97);
    });
  }
});

describe('slip cast simulation', () => {
  it('casts a hollow vase with the wall asked for, at the size it was modelled', () => {
    const v = vase();
    const mold = buildSlipMold(wasm, soupOf(v), { slip: 'porcelain-slip' });
    const r = mold.report;
    const t0 = Date.now();
    const cast = simulateSlipCast(wasm, { cavity: mold.cavity, partTopMm: r.partTopMm, footMm: r.footMm, scale: r.scale, slip: 'porcelain-slip' }, 4);
    console.log('cast ms', Date.now() - t0, JSON.stringify({ ...cast, mesh: undefined }));
    // Fired, it is the vase's size again: 90 mm across the belly, 140 tall.
    expect(cast.sizeMm[2]).toBeCloseTo(140, 0);
    expect(cast.sizeMm[0]).toBeCloseTo(90, 0);
    // Hollow: far less clay than a solid vase, and open at the top.
    const solidOuter = Math.PI * 35 ** 2 * 140;
    expect(cast.volumeMm3).toBeLessThan(solidOuter * 0.3);
    const piece = solidOf({ positions: Array.from(cast.mesh.positions), faces: Array.from(cast.mesh.faces) });
    expect(piece.status()).toBe('NoError');
    expect(piece.decompose().length).toBe(1);
    // Its wall, fired, is about 4 / 1.149 mm: at mid-height the ring is that thick.
    const ring = piece.slice(70);
    const pts = ring.toPolygons();
    const radii = pts.map((c) => Math.max(...c.map((p) => Math.hypot(p[0], p[1]))));
    radii.sort((a, b) => a - b);
    expect(radii.length).toBe(2);
    expect(radii[1] - radii[0]).toBeCloseTo(4 / r.scale, 0);
  });

  it('drains a mug with draft, whatever its height comes to, and the draft adds no undercut', () => {
    const mold = buildSlipMold(wasm, soupOf(mug()), { draftDeg: 1.5 });
    const r = mold.report;
    const area = solidOf(mold.cavity).surfaceArea?.() ?? Infinity;
    expect(r.undercutMm2).toBeLessThan(Math.min(50, area * 0.002));
    const cast = simulateSlipCast(wasm, { cavity: mold.cavity, partTopMm: r.partTopMm, footMm: r.footMm, scale: r.scale, slip: mold.slip }, 4);
    // Hollow: well under half of the cup's solid outline.
    expect(cast.volumeMm3).toBeLessThan(Math.PI * 40 ** 2 * 90 * 0.4);
    expect(cast.notes.some((n) => n.includes('casts solid'))).toBe(false);
  });
});
