import { describe, it, expect } from 'vitest';
import { loadManifold } from '../src/utils/sculptCut';
import { meshMmToManifold } from '../src/utils/timberBreakdown';
import { synthesizeTimberJoinery } from '../src/utils/timberJoinery';
import { buildTimberCutPlan } from '../src/utils/timberCutList';
import { runTimberSimulation, timberSimulationRequest } from '../src/utils/timberSimulation';
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

  it('mills T-junction center rails and centered Z-clip slots on tenoned aprons with zero shoulder gap or datum drift', async () => {
    const wasm = await loadManifold();
    const legXY = 250; // 455 mm shoulder-to-shoulder aprons (499 mm total with tenons -> sliding window on 300 mm bed!)
    const boxes: import('manifold-3d').Manifold[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      boxes.push(wasm.Manifold.cube([45, 45, 915], true).translate([sx * legXY, sy * legXY, 915 / 2]));
    }
    for (const s of [-1, 1]) {
      boxes.push(wasm.Manifold.cube([455, 22, 60], true).translate([0, s * legXY, 855]));
      boxes.push(wasm.Manifold.cube([22, 455, 60], true).translate([s * legXY, 0, 855]));
    }
    // Center T-junction rail framing into Apron_Front and Apron_Back + Tabletop for Z-clips
    boxes.push(wasm.Manifold.cube([22, 478, 60], true).translate([0, 0, 855]));
    boxes.push(wasm.Manifold.cube([560, 560, 24], true).translate([0, 0, 885 + 12]));

    const res = synthesizeTimberJoinery(wasm, boxes.map(soupOf), {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      tabletopClips: true,
      maxBoardWidthMm: 600,
    });
    for (const b of boxes) b.delete();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const plan = buildTimberCutPlan(res, { cncBedMm: [300, 300, 60] });
    const sim = runTimberSimulation(wasm, { breakdown: res, cutPlan: plan, cellMm: 0.2 });
    const { figures } = timberSimulationRequest(sim, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    expect(sim.setupFaults).toEqual([]);
    expect(figures.largestShoulderGapMm).toBe(0);
    expect(figures.tooTight).toEqual([]);
    expect(Number(figures.mostOffCentreMm)).toBeLessThan(0.2);
  }, 60_000);

  it('seats round_tenon and chisel_square tenons home in simulation with closed meshes', async () => {
    const wasm = await loadManifold();
    const legXY = 177.5;
    for (const fit of ['round_tenon', 'chisel_square'] as const) {
      const boxes: import('manifold-3d').Manifold[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        boxes.push(wasm.Manifold.cube([45, 45, 600], true).translate([sx * legXY, sy * legXY, 300]));
      }
      for (const s of [-1, 1]) {
        boxes.push(wasm.Manifold.cube([310, 22, 60], true).translate([0, s * legXY, 560]));
        boxes.push(wasm.Manifold.cube([22, 310, 60], true).translate([s * legXY, 0, 560]));
      }
      const res = synthesizeTimberJoinery(wasm, boxes.map(soupOf), {
        jointMode: 'mortise_tenon',
        tenonCornerFit: fit,
        cutterDiaMm: 6,
      });
      for (const b of boxes) b.delete();
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
      const sim = runTimberSimulation(wasm, { breakdown: res, cutPlan: plan, cellMm: 0.15 });
      expect(sim.setupFaults).toEqual([]);
      for (const j of sim.joints) {
        expect(j.shoulderGapMm).toBe(0);
        expect(j.slackWidthMm).toBeGreaterThan(-0.05);
        expect(j.slackThicknessMm).toBeGreaterThan(-0.05);
      }
      if (fit === 'chisel_square') {
        expect(sim.chiseledCorners).toBe(8);
      }
      const a = analyzeMesh(Array.from(sim.positions), Array.from(sim.faces))!;
      expect(a.closed).toBe(true);
      expect(a.consistentlyWound).toBe(true);
    }
  }, 60_000);

  it('mills rotated in-plane pockets on compound-splayed (±10°) legs so every apron tenon goes home', async () => {
    const wasm = await loadManifold();
    const legXY = 177.5;
    const boxes: import('manifold-3d').Manifold[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      // Compound outward splay (±10° in both X and Y) pivoted at apron height z = 560
      const centeredAtTop = wasm.Manifold.cube([45, 45, 600], true).translate([0, 0, -260]);
      const tilted = centeredAtTop.rotate([sy * 10, -sx * 10, 0]);
      centeredAtTop.delete();
      boxes.push(tilted.translate([sx * legXY, sy * legXY, 560]));
      tilted.delete();
    }
    for (const s of [-1, 1]) {
      boxes.push(wasm.Manifold.cube([320, 22, 60], true).translate([0, s * legXY, 560]));
      boxes.push(wasm.Manifold.cube([22, 320, 60], true).translate([s * legXY, 0, 560]));
    }
    const res = synthesizeTimberJoinery(wasm, boxes.map(soupOf), {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      edgeProfile: 'square',
    });
    for (const b of boxes) b.delete();
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.joints.length).toBe(8);

    const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
    const sim = runTimberSimulation(wasm, { breakdown: res, cutPlan: plan, cellMm: 0.15 });
    expect(sim.setupFaults).toEqual([]);
    for (const j of sim.joints) {
      expect(j.shoulderGapMm).toBeLessThanOrEqual(0.05);
      expect(j.slackWidthMm).toBeGreaterThan(-0.05);
      expect(j.slackThicknessMm).toBeGreaterThan(-0.05);
    }
    const a = analyzeMesh(Array.from(sim.positions), Array.from(sim.faces))!;
    expect(a.closed).toBe(true);
    expect(a.consistentlyWound).toBe(true);
  }, 60_000);

  it('uses sawn shoulderToShoulderMm blank length on overlapping and small-gap rails in simulation', async () => {
    const wasm = await loadManifold();
    const legXY = 177.5;
    for (const apronSpan of [320, 306.4]) {
      const boxes: import('manifold-3d').Manifold[] = [];
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
        boxes.push(wasm.Manifold.cube([45, 45, 600], true).translate([sx * legXY, sy * legXY, 300]));
      }
      boxes.push(wasm.Manifold.cube([apronSpan, 22, 60], true).translate([0, -legXY, 560]));
      const res = synthesizeTimberJoinery(wasm, boxes.map(soupOf), {
        jointMode: 'mortise_tenon',
        tenonCornerFit: 'dogbone',
        cutterDiaMm: 6,
        edgeProfile: 'square',
      });
      for (const b of boxes) b.delete();
      expect(res.ok).toBe(true);
      if (!res.ok) return;

      const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
      const sim = runTimberSimulation(wasm, { breakdown: res, cutPlan: plan, cellMm: 0.15 });
      expect(sim.joints.every((j) => j.shoulderGapMm === 0)).toBe(true);

      // Extract just the simulated rail component (last part) and verify a 2 mm slice at x = 156..158
      // inside Leg_FR (whose face is at x = 155) contains ONLY the 9 x 50 mm tenon (~900 mm³),
      // NOT the untrimmed 22 x 60 mm rail (~2640 mm³)!
      const fullManifold = meshMmToManifold(wasm, sim.positions, sim.faces);
      const comps = fullManifold.decompose();
      fullManifold.delete();
      expect(comps.length).toBe(5); // 4 legs + 1 continuous rail!
      const sliceSlab = wasm.Manifold.cube([2, 60, 100], true).translate([157, -legXY, 560]);
      // Find the rail component (centered at x = 0, y = -177.5)
      const railComp = comps.find((c) => {
        const b = c.boundingBox();
        return b.min[0] < -100 && b.max[0] > 100;
      })!;
      const railInLeg = railComp.intersect(sliceSlab);
      const sliceVol = railInLeg.volume();
      railInLeg.delete();
      sliceSlab.delete();
      for (const c of comps) c.delete();
      expect(sliceVol).toBeGreaterThan(750);
      expect(sliceVol).toBeLessThan(1100);
    }
  }, 60_000);

  it('simulates 45° knee braces and panel-to-panel bookcase dadoes with zero shoulder gap', async () => {
    const wasm = await loadManifold();
    // 1. 45° knee brace frame
    const legL = wasm.Manifold.cube([45, 45, 600], true).translate([-177.5, 0, 300]);
    const legR = wasm.Manifold.cube([45, 45, 600], true).translate([177.5, 0, 300]);
    const apron = wasm.Manifold.cube([310, 22, 60], true).translate([0, 0, 560]);
    const rawBrace = wasm.Manifold.cube([155, 22, 35], true).rotate([0, -45, 0]);
    const brace = rawBrace.translate([-105, 0, 480]);
    rawBrace.delete();
    const braceRes = synthesizeTimberJoinery(wasm, [legL, legR, apron, brace].map(soupOf), {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      tenonLengthMm: 16,
      edgeProfile: 'square',
    });
    legL.delete(); legR.delete(); apron.delete(); brace.delete();
    expect(braceRes.ok).toBe(true);
    if (!braceRes.ok) return;
    const bracePlan = buildTimberCutPlan(braceRes, { cncBedMm: [300, 400, 80] });
    const braceSim = runTimberSimulation(wasm, { breakdown: braceRes, cutPlan: bracePlan, cellMm: 0.15 });
    expect(braceSim.setupFaults).toEqual([]);
    expect(braceSim.joints.length).toBe(4);
    for (const j of braceSim.joints) {
      expect(j.shoulderGapMm).toBe(0);
      expect(j.slackWidthMm).toBeGreaterThan(-0.05);
      expect(j.slackThicknessMm).toBeGreaterThan(-0.05);
    }

    // 2. Bookcase panel-to-panel stopped dadoes (20x300x800 sides + 380x300x20 shelves)
    const sideL = wasm.Manifold.cube([20, 300, 800], true).translate([-200, 0, 400]);
    const sideR = wasm.Manifold.cube([20, 300, 800], true).translate([200, 0, 400]);
    const shelf1 = wasm.Manifold.cube([380, 300, 20], true).translate([0, 0, 200]);
    const shelf2 = wasm.Manifold.cube([380, 300, 20], true).translate([0, 0, 600]);
    const caseRes = synthesizeTimberJoinery(wasm, [sideL, sideR, shelf1, shelf2].map(soupOf), {
      jointMode: 'dado',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      maxBoardWidthMm: 350,
      edgeProfile: 'square',
    });
    sideL.delete(); sideR.delete(); shelf1.delete(); shelf2.delete();
    expect(caseRes.ok).toBe(true);
    if (!caseRes.ok) return;
    const casePlan = buildTimberCutPlan(caseRes, { cncBedMm: [300, 300, 60] });
    const caseSim = runTimberSimulation(wasm, { breakdown: caseRes, cutPlan: casePlan, cellMm: 0.25 });
    expect(caseSim.setupFaults).toEqual([]);
    expect(caseSim.joints.length).toBe(4);
    for (const j of caseSim.joints) {
      expect(j.shoulderGapMm).toBe(0);
      expect(j.slackWidthMm).toBeGreaterThan(-0.05);
      expect(j.slackThicknessMm).toBeGreaterThan(-0.05);
    }
    const a = analyzeMesh(Array.from(caseSim.positions), Array.from(caseSim.faces))!;
    expect(a.closed).toBe(true);
    expect(a.consistentlyWound).toBe(true);
  }, 60_000);

  it('simulates a 6-leg table with opposite-face and 3-way center legs with zero shoulder gap', async () => {
    const wasm = await loadManifold();
    const legXY = 177.5;
    const boxes: import('manifold-3d').Manifold[] = [];
    for (const x of [-300, 0, 300]) for (const sy of [-1, 1]) {
      boxes.push(wasm.Manifold.cube([45, 45, 600], true).translate([x, sy * legXY, 300]));
    }
    for (const sy of [-1, 1]) {
      boxes.push(wasm.Manifold.cube([255, 22, 60], true).translate([-150, sy * legXY, 560]));
      boxes.push(wasm.Manifold.cube([255, 22, 60], true).translate([150, sy * legXY, 560]));
    }
    for (const x of [-300, 0, 300]) {
      boxes.push(wasm.Manifold.cube([22, 310, 60], true).translate([x, 0, 560]));
    }
    const res = synthesizeTimberJoinery(wasm, boxes.map(soupOf), {
      jointMode: 'mortise_tenon',
      tenonCornerFit: 'dogbone',
      cutterDiaMm: 6,
      tenonLengthMm: 25,
      edgeProfile: 'square',
    });
    for (const b of boxes) b.delete();
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const plan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
    const sim = runTimberSimulation(wasm, { breakdown: res, cutPlan: plan, cellMm: 0.2 });
    expect(sim.setupFaults).toEqual([]);
    expect(sim.joints.length).toBe(14);
    for (const j of sim.joints) {
      expect(j.shoulderGapMm).toBe(0);
      expect(j.slackWidthMm).toBeGreaterThan(-0.05);
      expect(j.slackThicknessMm).toBeGreaterThan(-0.05);
    }
  }, 60_000);
});
