import { describe, it, expect } from 'vitest';
import type { Manifold } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { buildSlipMold, DEFAULT_SLIP_MOLD_OPTIONS } from '../src/utils/slipCastMold';
import { simulateSlipCast } from '../src/utils/slipCastSimulation';
import { slipCastInput } from '../src/utils/slipMoldActions';
import { analyzeMesh } from '../src/utils/meshIntegrity';

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
    for (const p of mold.pieces) {
      expect(p.undercutMm2).toBe(0);
      expect(analyzeMesh(p.plaster.positions, p.plaster.faces).closed).toBe(true);
    }
    const cast = simulateSlipCast(wasm, slipCastInput(mold), 4);
    expect(analyzeMesh(Array.from(cast.mesh.positions), Array.from(cast.mesh.faces)).closed).toBe(true);
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
});
