// The slip-cast mold: plaster pieces round a part, and the printed cases that
// cast them, checked as a potter would use them.
import { describe, it, expect, beforeAll } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { buildSlipMold, type SlipMesh } from '../src/utils/slipCastMold';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { simulateSlipCast } from '../src/utils/slipCastSimulation';
import { sceneWithSlipMold } from '../src/utils/slipMoldScene';
import { slipCaseStls } from '../src/utils/slipMoldActions';
import type { SceneGraph } from '../src/types/scene';

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
    expect(cast.warnings.some((n) => n.includes('casts solid'))).toBe(false);
  });
});

/** A jug: a 4 mm cup whose handle loop, joined below the rim, rises 15 mm above it. */
function jug(): Manifold {
  const cup = wasm.Manifold.cylinder(90, 40, 40, 96).subtract(wasm.Manifold.cylinder(90, 36, 36, 96).translate([0, 0, 4]));
  const handle = wasm.Manifold.cylinder(8, 30, 30, 64).subtract(wasm.Manifold.cylinder(8, 22, 22, 64)).rotate([90, 0, 0])
    .translate([70, 4, 75]).subtract(wasm.Manifold.cylinder(90, 38, 38, 96));
  return cup.add(handle);
}

describe('slip spare over the opening', () => {
  it('puts the spare over the mouth, not the handle that stands higher, and casts the jug hollow', () => {
    const j = jug();
    expect(j.boundingBox().max[2]).toBeGreaterThan(100);
    const mold = buildSlipMold(wasm, soupOf(j), { slip: 'stoneware-slip' });
    const r = mold.report;
    console.log(JSON.stringify(r));
    // Over the cup's mouth: its axis near the cup's, at the rim.
    expect(Math.hypot(r.spareAtMm[0], r.spareAtMm[1])).toBeLessThan(8);
    expect(r.spareAtMm[2]).toBeLessThan(r.partTopMm - 15);
    expect(r.warnings.some((w) => w.includes('roofed in plaster'))).toBe(false);
    // The handle above the rim stands in the spare's way: said where.
    const cast = simulateSlipCast(wasm, { cavity: mold.cavity, spare: mold.spare, partTopMm: r.partTopMm, footMm: r.footMm, scale: r.scale, slip: mold.slip }, 4);
    console.log(JSON.stringify({ ...cast, mesh: undefined }));
    expect(cast.volumeMm3).toBeLessThan(Math.PI * 40 ** 2 * 90 * 0.4);
    expect(cast.warnings.some((w) => w.includes('nearly solid') || w.includes('casts solid'))).toBe(false);
  });

  it('warns, with where, when the spare is put where the inside cannot drain, and the cast says it is solid', () => {
    const mold = buildSlipMold(wasm, soupOf(jug()), { slip: 'stoneware-slip', spareAtMm: [100, 0] });
    const r = mold.report;
    console.log(r.warnings);
    expect(r.spareAtMm[2]).toBeGreaterThan(r.partTopMm - 10);
    expect(r.warnings.some((w) => w.includes('roofed in plaster') && /\(-?\d+, -?\d+, \d+ mm\)/.test(w))).toBe(true);
    // A wall that closes the handle, the inside's only way to the spare.
    const cast = simulateSlipCast(wasm, { cavity: mold.cavity, spare: mold.spare, partTopMm: r.partTopMm, footMm: r.footMm, scale: r.scale, slip: mold.slip }, 5);
    console.log(cast.warnings);
    expect(cast.warnings.some((w) => w.includes('sealed off') && w.includes('mm)'))).toBe(true);
  });

  it('stands the spare on a mouth whose rim rises on one side, and keeps the high side out of it', () => {
    // A cup whose rim slants from 80 mm up on one side to 95 mm on the other.
    const cup = wasm.Manifold.cylinder(100, 40, 40, 96).subtract(wasm.Manifold.cylinder(100, 36, 36, 96).translate([0, 0, 4]));
    const slant = wasm.Manifold.cube([200, 200, 100], true).rotate([0, 8.5, 0]).translate([0, 0, 87.5 + 50]);
    const r = buildSlipMold(wasm, soupOf(cup.subtract(slant)), {}).report;
    expect(Math.hypot(r.spareAtMm[0], r.spareAtMm[1])).toBeLessThan(8);
    expect(r.warnings.some((w) => w.includes('rises into the spare'))).toBe(false);
  });

  it('keeps the spare on top of a solid part with a small gap open from above', () => {
    // A solid post with a thin loop standing beside it: the gap between them is not an inside.
    const post = wasm.Manifold.cylinder(80, 15, 15, 64);
    const loop = wasm.Manifold.cube([4, 10, 40], true).translate([22, 0, 40]).add(wasm.Manifold.cube([10, 10, 4], true).translate([18, 0, 22]));
    const part = post.add(loop);
    const r = buildSlipMold(wasm, soupOf(part), {}).report;
    expect(r.spareAtMm[2]).toBeGreaterThan(r.partTopMm - 2);
  });

  it('centres the spare on the point asked for on a wide top', () => {
    const block = wasm.Manifold.cube([120, 60, 40], true).translate([0, 0, 20]);
    const r = buildSlipMold(wasm, soupOf(block), { spareAtMm: [40, 0] }).report;
    expect(r.spareAtMm[0]).toBeCloseTo(40, 3);
    expect(r.spareAtMm[1]).toBeCloseTo(0, 3);
  });

  it('refuses a spare position off the part', () => {
    expect(() => buildSlipMold(wasm, soupOf(jug()), { spareAtMm: [500, 500] })).toThrow(/not over the part/);
  });

  it('sinks the spare into a pointed pyramid until the throat is wide enough to join solidly and drain hollow', () => {
    const pyrBase = wasm.Manifold.cube([80, 80, 0.1]).translate([-40, -40, 0]);
    const pyrApex = wasm.Manifold.cube([0.2, 0.2, 0.1]).translate([-0.1, -0.1, 80]);
    const pyramid = wasm.Manifold.hull([pyrBase, pyrApex]);
    const mold = buildSlipMold(wasm, soupOf(pyramid), { shrinkPercent: 0 });
    // Instead of barely touching 0.5 mm below the sharp tip, the spare seats down where the pyramid is ~20 mm wide.
    expect(mold.report.spareAtMm[2]).toBeLessThan(65);
    const neckSlice = solidOf(mold.cavity).slice(mold.report.spareAtMm[2]);
    const nb = neckSlice.bounds();
    expect(Math.min(nb.max[0] - nb.min[0], nb.max[1] - nb.min[1])).toBeGreaterThanOrEqual(19);
    // And slip drains out through that wide throat, casting the pyramid hollow instead of solid.
    const cast = simulateSlipCast(wasm, { cavity: mold.cavity, spare: mold.spare, partTopMm: mold.report.partTopMm, footMm: mold.report.footMm, scale: mold.report.scale, slip: mold.slip }, 4);
    expect(cast.warnings.some((w) => w.includes('casts solid') || w.includes('nearly solid'))).toBe(false);
  });
});

describe('slip mold made again', () => {
  it('replaces the plaster and cases made before round the same part', () => {
    const mold = buildSlipMold(wasm, soupOf(vase()), {});
    const scene = { nodes: [{ id: 'v', name: 'vase', type: 'body', geoms: [], children: [] }] } as unknown as SceneGraph;
    const first = sceneWithSlipMold(scene, 'vase', mold, ['v']);
    const second = sceneWithSlipMold(first.scene, 'vase', mold, ['v']);
    expect(second.replaced.map((r) => r.id).sort()).toEqual([...first.plasterIds, ...first.caseIds].sort());
    expect(second.scene.nodes.filter((n) => n.slipMold).length).toBe(first.plasterIds.length + first.caseIds.length);
  });
});

describe('plaster to hand', () => {
  it('makes the plaster as thick as a powder budget allows', () => {
    const full = buildSlipMold(wasm, soupOf(vase()), {});
    const budget = Math.round(full.report.plasterPowderG * 0.6);
    const lean = buildSlipMold(wasm, soupOf(vase()), { plasterBudgetG: budget });
    console.log(full.report.plasterMm, full.report.plasterPowderG, lean.report.plasterMm, lean.report.plasterPowderG, budget);
    expect(lean.report.plasterMm).toBeLessThan(full.report.plasterMm);
    expect(lean.report.plasterPowderG).toBeLessThanOrEqual(budget * 1.03);
    expect(lean.report.plasterPowderG).toBeGreaterThan(budget * 0.8);
    const tiny = buildSlipMold(wasm, soupOf(vase()), { plasterBudgetG: 100 });
    expect(tiny.report.plasterMm).toBe(10);
    expect(tiny.report.warnings.some((w) => w.includes('over the 100 g budget'))).toBe(true);
  });
});

describe('separable split cases with sliding clips', () => {
  it('splits each side case at the middle of its long edges into closed, zero-interference parts that unclip and slide off', () => {
    const mold = buildSlipMold(wasm, soupOf(jug()), { slip: 'earthenware-slip', base: false, plasterMm: 15 });
    expect(mold.report.splitCase).toBe(true);
    expect(mold.pieces.length).toBe(2);

    for (const p of mold.pieces) {
      expect(p.caseParts.map((cp) => cp.key)).toEqual(['base', 'wall1', 'wall2', 'clip1', 'clip2']);
      const solids = new Map<string, Manifold>();
      for (const cp of p.caseParts) {
        for (const m of [cp.mesh, cp.assembled]) {
          const a = analyzeMesh(m.positions, m.faces)!;
          expect(a.closed && a.consistentlyWound).toBe(true);
          expect(a.volume).toBeGreaterThan(0);
          const s = solidOf(m);
          expect(s.status()).toBe('NoError');
          expect(s.decompose().length).toBe(1);
        }
        // Every standalone STL sits flat on Z = 0.
        let minZ = Infinity;
        for (let i = 2; i < cp.mesh.positions.length; i += 3) minZ = Math.min(minZ, cp.mesh.positions[i]);
        expect(minZ).toBeCloseTo(0, 3);
        solids.set(cp.key, solidOf(cp.assembled));
      }

      const base = solids.get('base')!;
      const wall1 = solids.get('wall1')!;
      const wall2 = solids.get('wall2')!;
      const clip1 = solids.get('clip1')!;
      const clip2 = solids.get('clip2')!;
      const all = [base, wall1, wall2, clip1, clip2];

      // Zero pairwise overlap in the assembled pose.
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          expect(all[i].intersect(all[j]).volume()).toBeLessThan(1e-3);
        }
      }

      // Split is at the middle of the long edges: assembled Y span >= X span
      // (excluding the clip protrusion on ±X, base's Y >= base's X), and wall1/wall2 split at Y = 0.
      const bbb = base.boundingBox();
      expect(bbb.max[1] - bbb.min[1]).toBeGreaterThanOrEqual(bbb.max[0] - bbb.min[0] - 0.1);
      expect(wall1.boundingBox().max[1]).toBeLessThan(2); // only the 1.4 mm sealing tongue crosses Y = 0
      expect(wall2.boundingBox().min[1]).toBeGreaterThan(0);

      // Each U-wall half has all 3 flat-bottomed trapezoidal grooves (both side walls + its longer end wall):
      // probing the inner face across the flat groove band (Z = 2.9 and Z = 3.9) vs Z = 0.4 recedes ~1.68 mm on -X, +X, AND ±Y.
      const innerSpanAt = (wall: Manifold, z: number, endSign: -1 | 1) => {
        const yProbe = wall.intersect(wasm.Manifold.cube([2, 400, 0.1]).translate([-1, -200, z - 0.05])).boundingBox();
        const xPosProbe = wall.intersect(wasm.Manifold.cube([200, 2, 0.1]).translate([0, endSign * 20 - 1, z - 0.05])).boundingBox();
        const xNegProbe = wall.intersect(wasm.Manifold.cube([200, 2, 0.1]).translate([-200, endSign * 20 - 1, z - 0.05])).boundingBox();
        return {
          endIn: endSign < 0 ? -yProbe.max[1] : yProbe.min[1],
          posIn: xPosProbe.min[0],
          negIn: -xNegProbe.max[0],
        };
      };
      for (const [wall, sign] of [[wall1, -1], [wall2, 1]] as const) {
        const foot = innerSpanAt(wall, 0.4, sign);
        for (const zBand of [2.9, 3.9]) {
          const band = innerSpanAt(wall, zBand, sign);
          expect(band.endIn - foot.endIn).toBeGreaterThan(1.55);
          expect(band.posIn - foot.posIn).toBeGreaterThan(1.55);
          expect(band.negIn - foot.negIn).toBeGreaterThan(1.55);
        }
      }

      // Step 1: Clips slide straight up (+Z) off both walls and base with zero interference.
      for (const clip of [clip1, clip2]) {
        expect(worstOverlap(clip, wall1, [0, 0, 1])).toBeLessThan(1e-3);
        expect(worstOverlap(clip, wall2, [0, 0, 1])).toBeLessThan(1e-3);
        expect(worstOverlap(clip, base, [0, 0, 1])).toBeLessThan(1e-3);
      }

      // Step 2: Once unclipped, wall1 slides along -Y and wall2 along +Y with zero interference.
      expect(worstOverlap(wall1, base, [0, -1, 0])).toBeLessThan(1e-3);
      expect(worstOverlap(wall1, wall2, [0, -1, 0])).toBeLessThan(1e-3);
      expect(worstOverlap(wall2, base, [0, 1, 0])).toBeLessThan(1e-3);
      expect(worstOverlap(wall2, wall1, [0, 1, 0])).toBeLessThan(1e-3);
    }

    // Exports 5 print-ready STLs per side case; splitCase: false exports 1 per case.
    expect(slipCaseStls('jug', mold).map((f) => f.file)).toEqual([
      'jug_slip_case_side1_base', 'jug_slip_case_side1_wall1', 'jug_slip_case_side1_wall2', 'jug_slip_case_side1_clip1', 'jug_slip_case_side1_clip2',
      'jug_slip_case_side2_base', 'jug_slip_case_side2_wall1', 'jug_slip_case_side2_wall2', 'jug_slip_case_side2_clip1', 'jug_slip_case_side2_clip2',
    ]);
    const solidCases = buildSlipMold(wasm, soupOf(jug()), { slip: 'earthenware-slip', base: false, splitCase: false });
    expect(solidCases.report.splitCase).toBe(false);
    expect(slipCaseStls('jug', solidCases).map((f) => f.file)).toEqual(['jug_slip_case_side1', 'jug_slip_case_side2']);
  });

  it('turns a wide shallow dish case so the split still falls at the middle of its long edges', () => {
    // A wide, shallow platter (180 mm across, 25 mm tall): wider than the mold is tall.
    const dish = wasm.Manifold.cylinder(25, 90, 80, 64).subtract(wasm.Manifold.cylinder(22, 85, 75, 64).translate([0, 0, 4]));
    const mold = buildSlipMold(wasm, soupOf(dish), { base: false, shrinkPercent: 0 });
    const side1 = mold.pieces[0];
    const base = solidOf(side1.caseParts[0].assembled);
    const b = base.boundingBox();
    expect(b.max[1] - b.min[1]).toBeGreaterThan(b.max[0] - b.min[0]);
    expect(worstOverlap(solidOf(side1.caseParts[1].assembled), base, [0, -1, 0])).toBeLessThan(1e-3);
    expect(worstOverlap(solidOf(side1.caseParts[2].assembled), base, [0, 1, 0])).toBeLessThan(1e-3);
  });
});

