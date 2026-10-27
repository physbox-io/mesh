import { describe, it, expect } from 'vitest';
import { loadManifold } from '../src/utils/sculptCut';
import { synthesizeTimberJoinery } from '../src/utils/timberJoinery';
import { buildTimberCutPlan } from '../src/utils/timberCutList';
import { runTimberSimulation } from '../src/utils/timberSimulation';
import { analyzeMesh } from '../src/utils/meshIntegrity';

const MM = 1000;

function soupOf(m: import('manifold-3d').Manifold): Float64Array {
  const mesh = m.getMesh();
  const p = mesh.numProp;
  const soup = new Float64Array(mesh.numTri * 9);
  for (let t = 0; t < mesh.numTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k];
      for (let a = 0; a < 3; a++) soup[t * 9 + k * 3 + a] = mesh.vertProperties[v * p + a] / MM;
    }
  }
  return soup;
}

/** A small table: four 45 mm legs, aprons `inset` mm in from the legs' outside faces. */
async function table(apronFromOutsideMm: number | null) {
  const wasm = await loadManifold();
  const legXY = 177.5;
  const boxes: import('manifold-3d').Manifold[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
    boxes.push(wasm.Manifold.cube([45, 45, 600], true).translate([sx * legXY, sy * legXY, 300]));
  }
  // Centred on the leg, or set in from its outside face by the given amount.
  const at = apronFromOutsideMm === null ? legXY : legXY + 22.5 - apronFromOutsideMm - 11;
  for (const s of [-1, 1]) {
    boxes.push(wasm.Manifold.cube([310, 22, 60], true).translate([0, s * at, 560]));
    boxes.push(wasm.Manifold.cube([22, 310, 60], true).translate([s * at, 0, 560]));
  }
  const res = synthesizeTimberJoinery(wasm, boxes.map(soupOf), { jointMode: 'mortise_tenon', tenonCornerFit: 'dogbone', cutterDiaMm: 6 });
  for (const b of boxes) b.delete();
  if (!res.ok) throw new Error(res.error);
  const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
  return { wasm, res, plan };
}

describe('timber simulation', () => {
  it('mills a table and every tenon goes home, shoulders on the face', async () => {
    const { wasm, res, plan } = await table(null);
    const sim = runTimberSimulation(wasm, { breakdown: res, cutPlan: plan });
    expect(sim.joints.length).toBe(8);
    expect(sim.setupFaults).toEqual([]);
    for (const j of sim.joints) {
      expect(j.shoulderGapMm).toBe(0);
      // The joinery's 0.15 mm clearance, read off a 0.1 mm grid.
      expect(j.slackWidthMm).toBeGreaterThan(0);
      expect(j.slackWidthMm).toBeLessThan(0.4);
      expect(j.slackThicknessMm).toBeGreaterThan(0);
      expect(j.slackThicknessMm).toBeLessThan(0.4);
      expect(j.offCentreMm).toBeLessThan(0.1);
    }
    const a = analyzeMesh(Array.from(sim.positions), Array.from(sim.faces))!;
    expect(a.closed).toBe(true);
    expect(a.consistentlyWound).toBe(true);
    // Four legs and four aprons, less the mortises, plus the tenons.
    const legs = 4 * 45 * 45 * 600, aprons = 4 * 22 * 60 * 310;
    expect(sim.volumeMm3).toBeGreaterThan((legs + aprons) * 0.97);
    expect(sim.volumeMm3).toBeLessThan((legs + aprons) * 1.03);
  }, 60_000);

  it('mills every mortise where its tenon is when the aprons are set in from the outside', async () => {
    // Off the middle of the leg's face, so a setup that puts the wrong face
    // against the fence mills the mortise mirrored across it.
    const { wasm, res, plan } = await table(4);
    const sim = runTimberSimulation(wasm, { breakdown: res, cutPlan: plan });
    expect(sim.setupFaults).toEqual([]);
    for (const j of sim.joints) {
      expect(j.shoulderGapMm).toBe(0);
      expect(j.offCentreMm).toBeLessThan(0.1);
    }
  }, 60_000);

  it('shows a tenon sawn longer than its mortise as a shoulder off the face', async () => {
    const { wasm, res, plan } = await table(null);
    const tenon = res.joints[0].tenon!;
    const depth = res.joints[0].mortise!.depthMm;
    tenon.lengthMm = depth + 3;
    const sim = runTimberSimulation(wasm, { breakdown: res, cutPlan: plan });
    expect(sim.joints[0].shoulderGapMm).toBeGreaterThan(2.8);
    expect(sim.joints[0].shoulderGapMm).toBeLessThan(3.2);
    expect(sim.joints.slice(1).every((j) => j.shoulderGapMm === 0)).toBe(true);
  }, 60_000);
});
