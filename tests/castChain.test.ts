// One click from master to finished piece: the battery of masters in
// plans/cast-flow.md, through each tab's chain.

import { describe, it, expect } from 'vitest';
import type { SceneGraph, SceneNode, SceneGeom } from '../src/types/scene';
import { siliconeChain, metalChain, SAND_COVER_MM, MIN_POUR_OPENING_MM, deviationMm, masterSoup } from '../src/utils/castChain';
import { generateMoldMeshes } from '../src/utils/moldExporter';
import { simulateCastFromMoldResult } from '../src/utils/moldCastSimulation';
import { loadManifold } from '../src/utils/sculptCut';

const body = (id: string, geoms: SceneGeom[], pos = [0, 0, 0]): SceneNode =>
  ({ id, name: id, type: 'body', pos, joints: [], geoms, children: [] } as unknown as SceneNode);
const box = (name: string, half: number[], pos = [0, 0, 0]): SceneGeom => ({ name, type: 'box', size: half, pos } as SceneGeom);
const cyl = (name: string, r: number, half: number, pos = [0, 0, 0]): SceneGeom => ({ name, type: 'cylinder', size: [r, half], pos } as SceneGeom);
const sphere = (name: string, r: number, pos = [0, 0, 0]): SceneGeom => ({ name, type: 'sphere', size: [r], pos } as SceneGeom);

/** A 20 mm block standing on the ground. */
const block: SceneGraph = { nodes: [body('block', [box('b', [0.01, 0.01, 0.01])], [0, 0, 0.01])] };
/** A mushroom: a stem with a wide cap, whose underside overhangs. */
const mushroom: SceneGraph = {
  nodes: [body('mushroom', [cyl('stem', 0.005, 0.006, [0, 0, 0.006]), cyl('cap', 0.014, 0.003, [0, 0, 0.015])])],
};
/** A ball on a thin stalk: too narrow a foot to pour through. */
const onAStalk: SceneGraph = {
  nodes: [body('ball', [cyl('stalk', 0.0012, 0.003, [0, 0, 0.003]), sphere('head', 0.01, [0, 0, 0.015])])],
};

/** Two ledges stacked over each other: a spool with two necks. */
const spool: SceneGraph = {
  nodes: [body('spool', [
    cyl('a', 0.008, 0.0025, [0, 0, 0.0025]), cyl('n1', 0.005, 0.0015, [0, 0, 0.0065]),
    cyl('b', 0.008, 0.0025, [0, 0, 0.0105]), cyl('n2', 0.005, 0.0015, [0, 0, 0.0145]),
    cyl('c', 0.008, 0.0025, [0, 0, 0.0185]),
  ])],
};
/** A slab on four thin legs: plenty of foot in all, none of it wide enough. */
const onLegs: SceneGraph = {
  nodes: [body('table', [
    box('top', [0.012, 0.012, 0.003], [0, 0, 0.009]),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y], i) => cyl(`leg${i}`, 0.0016, 0.003, [x * 0.009, y * 0.009, 0.003])),
  ])],
};
/** A block on a blade 1 mm thick and 30 mm long. */
const onABlade: SceneGraph = {
  nodes: [body('blade', [box('blade', [0.015, 0.0005, 0.003], [0, 0, 0.003]), box('top', [0.015, 0.01, 0.005], [0, 0, 0.011])])],
};
/** An L: a 30 mm bar with a post at one end, so a turn or a mirror shows. */
const ell: SceneGraph = {
  nodes: [body('ell', [box('bar', [0.015, 0.005, 0.004], [0, 0, 0.004]), box('post', [0.005, 0.005, 0.008], [0.01, 0, 0.016])])],
};

describe('silicone chain', () => {
  it('vents a ledge under another ledge', async () => {
    const r = await siliconeChain(spool, ['spool'], {}, 'epoxy');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.vents.length).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('refuses four thin legs and a blade, however much foot they add up to', async () => {
    for (const [scene, id] of [[onLegs, 'table'], [onABlade, 'blade']] as const) {
      const r = await siliconeChain(scene, [id], {}, 'epoxy');
      expect(r.ok, id).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/No part of the master's foot/);
    }
  }, 60000);

  it('stands an L the way the master stands, not turned or mirrored', async () => {
    const r = await siliconeChain(ell, ['ell'], {}, 'epoxy');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.piece.deviation!.maxMm).toBeLessThan(0.3);
  }, 60000);

  it('pours a block in resin that matches the master and needs no vent', async () => {
    const r = await siliconeChain(block, ['block'], {}, 'epoxy');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.vents).toHaveLength(0);
    expect(r.piece.volumeMm3 / 8000).toBeCloseTo(1, 1);
    expect(r.piece.weightG).toBeCloseTo(8 * 1.15, 0);
    expect(r.piece.deviation!.maxMm).toBeLessThan(0.3);
  }, 60000);

  it('vents the pockets under a mushroom cap, and stands it as the master stands', async () => {
    const r = await siliconeChain(mushroom, ['mushroom'], {}, 'polyurethane');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.vents.length).toBeGreaterThan(0);
    // Upside down it would sit 15 mm off the master on average.
    expect(r.piece.deviation!.meanMm).toBeLessThan(0.3);
    expect(r.piece.deviation!.maxMm).toBeLessThan(0.6);
  }, 60000);

  it('pours through a pour hole when the foot is too narrow, the stub cut off', async () => {
    const r = await siliconeChain(onAStalk, ['ball'], { hole: 'pour' }, 'epoxy');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.pouredThrough).toBe('pour hole');
    // Cut flat at the top of the ball: an 8 mm sprue on a 10 mm ball stands up
    // to 10 - sqrt(10² - 4²) = 0.83 mm proud of the curve, trimmed by hand.
    expect(r.piece.deviation!.maxMm).toBeLessThan(0.9);
    expect(r.piece.deviation!.meanMm).toBeLessThan(0.2);
  }, 60000);

  it('cuts off a pour hole stub that stands on a lower step', async () => {
    // 15 × 10 × 20 mm beside 15 × 10 × 10 mm: 4500 mm³, the hole on the low step.
    const step: SceneGraph = { nodes: [body('step', [box('hi', [0.0075, 0.005, 0.01], [-0.0075, 0, 0.01]), box('lo', [0.0075, 0.005, 0.005], [0.0075, 0, 0.005])])] };
    const r = await siliconeChain(step, ['step'], { hole: 'pour', holeAtMm: [7.5, 0] }, 'epoxy');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.pouredThrough).toBe('pour hole');
    expect(Math.abs(r.piece.volumeMm3 - 4500) / 4500).toBeLessThan(0.02);
    expect(r.piece.deviation!.maxMm).toBeLessThan(0.6);
  }, 60000);

  it('pours a block through its foot with a wick hole plugged', async () => {
    const r = await siliconeChain(block, ['block'], { hole: 'wick' }, 'wax');
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.pouredThrough).toBe('foot');
    expect(r.piece.volumeMm3 / 8000).toBeCloseTo(1, 1);
  }, 60000);

  it('refuses a foot too narrow to pour through, and points to Rigid', async () => {
    const r = await siliconeChain(onAStalk, ['ball'], {}, 'epoxy');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/too narrow.*Rigid with the PVA liner, or a pour hole/);
    expect(MIN_POUR_OPENING_MM).toBeGreaterThan(2.4);
  }, 60000);
});

describe('metal chain', () => {
  it('stands an L the way the master stands, sand-cast', async () => {
    const r = await metalChain(ell, { method: 'sand', metalId: 'aluminium', draftDeg: 0 });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.piece.deviation!.maxMm).toBeLessThan(0.3);
  }, 60000);

  it('leaves out a body the gating does not reach, and says so', async () => {
    const two: SceneGraph = { nodes: [...block.nodes, body('stray', [box('s', [0.005, 0.005, 0.005])], [0.08, 0, 0.005])] };
    const r = await metalChain(two, { method: 'sand', metalId: 'aluminium', draftDeg: 0 });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.filledShare!).toBeLessThan(0.97);
    expect(r.warnings.join(' ')).toMatch(/left out of the piece/);
    // The block alone, not the block and the stray cube.
    expect(r.piece.volumeMm3).toBeLessThan(8000 * 1.05);
  }, 60000);

  it('adds the gating to the pattern dialog\'s pour figure, not its own', async () => {
    const r = await metalChain(block, { method: 'sand', metalId: 'aluminium', draftDeg: 0 });
    if (!r.ok) throw new Error(r.error);
    expect(Math.abs(r.piece.weightG + r.piece.gating!.weightG - r.pourWeightG)).toBeLessThan(1);
  }, 60000);

  it('sand-casts a block: the piece is the drafted part at size, the gating counted apart', async () => {
    const r = await metalChain(block, { method: 'sand', metalId: 'aluminium', draftDeg: 2 });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.filledShare).toBeGreaterThan(0.97);
    expect(r.piece.gating!.weightG).toBeGreaterThan(0);
    expect(r.piece.weightG).toBeCloseTo((r.piece.volumeMm3 / 1000) * 2.7, 1);
    // 2° over 20 mm of wall leans the base out by 0.7 mm.
    expect(r.piece.deviation!.maxMm).toBeLessThan(1.2);
    expect(r.piece.deviation!.maxMm).toBeGreaterThan(0.3);
    expect(r.flask.shape).toBe('box');
  }, 60000);

  it('sizes the sand flask with its cover and no more', async () => {
    const r = await metalChain(block, { method: 'sand', metalId: 'aluminium', draftDeg: 0 });
    if (!r.ok) throw new Error(r.error);
    // The pattern is the 20 mm block grown 1.3%, with the gating beside it.
    const [w, d] = r.flask.sizeMm;
    expect(w).toBeGreaterThanOrEqual(Math.round(20 * 1.013 + 2 * SAND_COVER_MM));
    expect(d).toBeGreaterThanOrEqual(Math.round(20 * 1.013 + 2 * SAND_COVER_MM));
    expect(r.fillG).toBeGreaterThan(0);
  }, 60000);

  it('casts a lost-PLA bronze piece in its cylinder flask', async () => {
    const r = await metalChain(mushroom, { method: 'lost-pla', metalId: 'bronze', draftDeg: 0 });
    expect(r.ok, r.ok ? '' : r.error).toBe(true);
    if (!r.ok) return;
    expect(r.flask.shape).toBe('cylinder');
    expect(r.filledShare).toBeGreaterThan(0.97);
    expect(r.piece.deviation!.maxMm).toBeLessThan(0.3);
  }, 60000);
});

describe('rigid mold', () => {
  it('casts a piece that stands the way the master does', async () => {
    const wasm = await loadManifold();
    for (const scene of [block, mushroom]) {
      const mold = generateMoldMeshes(scene, { moldType: 'auto' }, wasm);
      expect(mold.success, mold.error).toBe(true);
      const cast = await simulateCastFromMoldResult(mold);
      expect(cast.success, cast.error).toBe(true);
      const soup = new Float64Array(cast.mesh.faces.length * 3);
      cast.mesh.faces.forEach((v, i) => soup.set(cast.mesh.positions.subarray(v * 3, v * 3 + 3), i * 3));
      const dev = deviationMm(soup, masterSoup(wasm, scene))!;
      // A rigid mold fills in what it cannot release, so the mushroom's cap
      // stands proud of the master; its mean stays small all the same.
      expect(dev.meanMm, JSON.stringify(dev)).toBeLessThan(scene === block ? 0.3 : 2);
    }
  }, 60000);
});
