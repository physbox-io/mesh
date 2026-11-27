import { describe, it, expect } from 'vitest';
import type { Manifold } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { buildSlipMold, DEFAULT_SLIP_MOLD_OPTIONS } from '../src/utils/slipCastMold';
import { simulateSlipCast } from '../src/utils/slipCastSimulation';
import { slipCastInput } from '../src/utils/slipMoldActions';
import { analyzeMesh, weldByPosition } from '../src/utils/meshIntegrity';
import { analyseDfm } from '../src/utils/dfm';
import type { SceneGraph } from '../src/types/scene';

function manifoldToSoup(m: Manifold): Float64Array {
  const mesh = m.getMesh();
  const numTri = mesh.triVerts.length / 3;
  const out = new Float64Array(numTri * 9);
  for (let t = 0; t < numTri; t++) {
    for (let k = 0; k < 3; k++) {
      const vi = mesh.triVerts[t * 3 + k];
      out[t * 9 + k * 3] = mesh.vertProperties[vi * mesh.numProp];
      out[t * 9 + k * 3 + 1] = mesh.vertProperties[vi * mesh.numProp + 1];
      out[t * 9 + k * 3 + 2] = mesh.vertProperties[vi * mesh.numProp + 2];
    }
  }
  return out;
}

describe('Slip-Cast Ceramic Molds dogfood fixes', () => {
  it('axisymmetric vase with recessed foot ring has zero false-positive side undercut when base plug is active', async () => {
    const wasm = await loadManifold();
    const profile: [number, number][] = [
      [0.01, 4], [17, 4], [18, 0], [23, 0],
      [25, 10], [33, 28], [36, 46], [33, 64],
      [22, 80], [16, 92], [18, 104], [20, 110],
      [16, 110], [14, 103], [12, 92], [18, 79],
      [29, 63], [32, 46], [29, 29], [20, 12], [0.01, 9],
    ];
    const cs = new wasm.CrossSection([profile]);
    const vase = wasm.Manifold.revolve(cs, 48);
    const mold = buildSlipMold(wasm, manifoldToSoup(vase), {
      ...DEFAULT_SLIP_MOLD_OPTIONS,
      sides: 'auto',
      base: 'auto',
      slip: 'porcelain-slip',
      splitCase: true,
    });
    expect(mold.report.sides).toBe(2);
    expect(mold.report.base).toBe(true);
    expect(mold.report.undercutMm2).toBe(0);
    const assertFloat32Watertight = (positions: ArrayLike<number>, faces: ArrayLike<number>) => {
      const m = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i++) m[i] = positions[i] / 1000;
      const welded = weldByPosition(m, faces);
      const integrity = analyzeMesh(welded.positions, welded.faces);
      expect(integrity.closed).toBe(true);
      expect(integrity.nonManifoldEdges).toBe(0);
    };
    for (const p of mold.pieces) {
      expect(p.undercutMm2).toBe(0);
      expect(analyzeMesh(p.plaster.positions, p.plaster.faces).closed).toBe(true);
      assertFloat32Watertight(p.plaster.positions, p.plaster.faces);
      for (const cp of p.caseParts) {
        assertFloat32Watertight(cp.mesh.positions, cp.mesh.faces);
      }
    }
    const cast = simulateSlipCast(wasm, slipCastInput(mold), 4);
    expect(analyzeMesh(Array.from(cast.mesh.positions), Array.from(cast.mesh.faces)).closed).toBe(true);
    assertFloat32Watertight(cast.mesh.positions, cast.mesh.faces);
    expect(cast.sizeMm[2]).toBeCloseTo(110, 0);
    vase.delete();
    cs.delete();
  }, 60000);

  it('spareAtMm places the spare at the requested mold-frame point on a wide top', async () => {
    const wasm = await loadManifold();
    const base = wasm.Manifold.cube([120, 40, 50], true).translate([0, 0, 25]);
    const mold = buildSlipMold(wasm, manifoldToSoup(base), {
      ...DEFAULT_SLIP_MOLD_OPTIONS,
      sides: 2,
      base: false,
      fillInside: false,
      shrinkPercent: 0,
      spareAtMm: [40, 0],
    });
    expect(mold.report.spareAtMm[0]).toBeCloseTo(40, 1);
    expect(mold.report.spareAtMm[2]).toBeCloseTo(50, 0);
    base.delete();
  }, 60000);

  it('draftDeg on a helical fluted vessel does not distort front-facing flutes into undercuts', async () => {
    const wasm = await loadManifold();
    const segs = 96;
    const pts: [number, number][] = [];
    for (let i = 0; i < segs; i++) {
      const th = (i / segs) * 2 * Math.PI;
      const r = 27 + 0.85 * Math.cos(16 * th);
      pts.push([r * Math.cos(th), r * Math.sin(th)]);
    }
    const cs = new wasm.CrossSection([pts]);
    const fluted = wasm.Manifold.extrude(cs, 50, 24, 90);
    const soup = manifoldToSoup(fluted);
    const baseOpts = {
      ...DEFAULT_SLIP_MOLD_OPTIONS,
      sides: 3 as const,
      base: false as const,
      fillInside: false,
      shrinkPercent: 0,
      splitCase: false,
    };
    const undrafted = buildSlipMold(wasm, soup, { ...baseOpts, draftDeg: 0 });
    const drafted = buildSlipMold(wasm, soup, { ...baseOpts, draftDeg: 2 });
    expect(undrafted.report.undercutMm2).toBe(0);
    expect(drafted.report.undercutMm2).toBeLessThan(10);
    fluted.delete();
    cs.delete();
  }, 60000);

  it('cast DFM undercut finding recommends Slip Cast Plaster Mold when castMaterial is a ceramic slip', () => {
    const totemScene: SceneGraph = {
      nodes: [
        { id: 'foot', name: 'foot', type: 'body', pos: [0, 0, 0.01], geoms: [{ name: 'g', type: 'box', size: [0.06, 0.06, 0.01] }], joints: [], children: [] },
        { id: 'waist', name: 'waist', type: 'body', pos: [0, 0, 0.04], geoms: [{ name: 'g', type: 'box', size: [0.01, 0.01, 0.02] }], joints: [], children: [] },
        { id: 'cap', name: 'cap', type: 'body', pos: [0, 0, 0.07], geoms: [{ name: 'g', type: 'box', size: [0.06, 0.06, 0.01] }], joints: [], children: [] },
      ],
    };
    const slipReport = analyseDfm(totemScene, 'cast', { asPlaced: true, castMaterial: 'stoneware-slip' });
    const slipFinding = slipReport.findings.find((f) => f.id === 'cast_undercut');
    expect(slipFinding).toBeDefined();
    expect(slipFinding!.fix).toContain('Slip Cast Plaster Mold');
    expect(slipFinding!.actions?.[0]).toMatchObject({ kind: 'open_fab', modal: 'mold', moldTab: 'slip' });

    const resinReport = analyseDfm(totemScene, 'cast', { asPlaced: true, castMaterial: 'epoxy' });
    const resinFinding = resinReport.findings.find((f) => f.id === 'cast_undercut');
    expect(resinFinding).toBeDefined();
    expect(resinFinding!.fix).toContain('Silicone Pour Box');
  });
});
