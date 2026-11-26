// What the DFM overlay claims about a shape, checked against shapes whose
// answers are known by hand.
//
// The engine is pure — it takes a SceneGraph and returns numbers — so all of
// this runs in plain Node with no store, no worker and no MuJoCo. In the
// browser the same module runs on workers/dfmWorker.ts.

import { describe, it, expect } from 'vitest';
import {
  analyseDfm,
  dfmLensFor,
  dfmLimitsFor,
  draftDeg,
  enclosedAir,
  outsideFaces,
  overhangDeg,
  thinnestWall,
  supportArea,
  fitsBedSquareOn,
  DFM_DEFAULTS,
} from '../src/utils/dfm';
import { sampleColumns, sampleWallSpans } from '../src/utils/partColumns';
import { bossFindings, hardwareFindings } from '../src/utils/hardwareChecks';
import { buildHeatGeometry } from '../src/utils/dfmHeatGeometry';
import { boxMesh, cupMesh, sphereMesh, toSoup, zupToYupFlat } from './helpers/meshes';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const meshBody = (m: { verts: number[]; faces: number[] }, extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'part', name: 'part', type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{
    name: 'part_mesh', type: 'mesh', size: [1],
    renderVertices: m.verts,
    vertices: zupToYupFlat(m.verts),
    faces: m.faces,
  } as SceneGeom],
  ...extra,
});

const scene = (nodes: SceneNode[]): SceneGraph => ({ nodes } as SceneGraph);

/** A flat triangle soup for a shape, as the engine would see it. */
const boxBody = (c: [number, number, number], h: [number, number, number], name = 'part') =>
  meshBody(boxMesh(c, h), { id: name, name });

// ---------------------------------------------------------------------------
// The two angle definitions everything else is built on.
// ---------------------------------------------------------------------------

describe('overhangDeg', () => {
  it('is 0 for a vertical wall — it prints on top of itself', () => {
    expect(overhangDeg(0)).toBe(0);
  });

  it('is 90 for a flat ceiling — that is bridging over open air', () => {
    expect(overhangDeg(-1)).toBeCloseTo(90, 6);
  });

  it('is 45 at the slicer limit, where a layer still lands half on the last', () => {
    expect(overhangDeg(-Math.SQRT1_2)).toBeCloseTo(45, 6);
  });

  it('is 0 for anything facing upward, however steeply', () => {
    // An upward face has the whole part beneath it; it cannot overhang.
    expect(overhangDeg(1)).toBe(0);
    expect(overhangDeg(0.3)).toBe(0);
  });
});

describe('draftDeg', () => {
  it('is 0 for a wall exactly parallel to the pull — it drags all the way out', () => {
    expect(draftDeg(0, true)).toBe(0);
  });

  it('is positive when the face opens towards the pull', () => {
    expect(draftDeg(Math.SQRT1_2, true)).toBeCloseTo(45, 6);
  });

  it('is negative when the face leans back over the mould', () => {
    // This is the undercut: the pattern cannot come out at all.
    expect(draftDeg(-0.5, true)).toBeCloseTo(-30, 6);
  });

  it('flips sign below the parting plane, because that half pulls the other way', () => {
    expect(draftDeg(-0.5, false)).toBeCloseTo(30, 6);
    expect(draftDeg(0.5, false)).toBeCloseTo(-30, 6);
  });
});

// ---------------------------------------------------------------------------
// 3D printing
// ---------------------------------------------------------------------------

describe('print analysis', () => {
  it('passes a plain box: every wall is vertical and the bottom is on the plate', () => {
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'print', { asPlaced: true });
    expect(r.findings.find(f => f.id === 'print_overhang')).toBeUndefined();
    expect(r.score).toBeGreaterThan(90);
    expect(r.heat.every(h => h === 0)).toBe(true);
  });

  it('catches the ceiling of a shape that overhangs, and says how much', () => {
    // A wide slab held up on a narrow post: the underside of the slab is a flat
    // ceiling over open air, which is the worst case there is.
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'post'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'slab'),
    ]), 'print', { asPlaced: true });

    const overhang = r.findings.find(f => f.id === 'print_overhang');
    expect(overhang).toBeDefined();
    expect(overhang!.detail).toMatch(/90°/);
    // The hot triangles are the downward faces, and they are under the slab.
    const hot = [...r.heat].filter(h => h > 0.9).length;
    expect(hot).toBeGreaterThan(0);
    expect(overhang!.position[2]).toBeLessThan(0.05);
  });

  it('ignores the face resting on the build plate', () => {
    // A box's underside points straight down at 90°, but it is printed against
    // glass rather than air. Counting it would flag every part ever drawn.
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'print', { asPlaced: true });
    expect(r.findings).toHaveLength(0);
  });

  it('measures a thin wall through whichever axis it is thin in', () => {
    // 0.4 mm thin in X, which a plan-view-only check would never see.
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.0002, 0.05, 0.05])]), 'print', { asPlaced: true });
    const thin = r.findings.find(f => f.id === 'print_thin_wall');
    expect(thin).toBeDefined();
    expect(thin!.metric!).toBeLessThan(DFM_DEFAULTS.minWallMm);
    expect(thin!.severity).toBe('critical');
  });

  it('leaves a wall at the limit alone', () => {
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.002, 0.05, 0.05])]), 'print', { asPlaced: true });
    expect(r.findings.find(f => f.id === 'print_thin_wall')).toBeUndefined();
  });
});

describe('thinnestWall', () => {
  it('finds the smaller of two dimensions', () => {
    const b = boxMesh([0, 0, 0], [0.05, 0.001, 0.05]);
    const got = thinnestWall(toSoup(b), DFM_DEFAULTS.minWallMm);
    expect(got).not.toBeNull();
    expect(got!.mm).toBeCloseTo(2, 0);
  });
});

// ---------------------------------------------------------------------------
// 3-axis CNC
// ---------------------------------------------------------------------------

describe('cnc analysis', () => {
  it('passes a block: a cutter reaches all of it from above', () => {
    const r = analyseDfm(scene([boxBody([0, 0, 0.01], [0.05, 0.05, 0.01])]), 'cnc', { asPlaced: true });
    expect(r.findings.find(f => f.id === 'cnc_undercut')).toBeUndefined();
  });

  it('catches material tucked under an overhang', () => {
    // A T: the arms of the top slab hang out over nothing, so the air beneath
    // them is inside the column but outside the material. A 3-axis cutter
    // coming straight down cannot get under there.
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'stem'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'top'),
    ]), 'cnc', { asPlaced: true });

    const undercut = r.findings.find(f => f.id === 'cnc_undercut');
    expect(undercut).toBeDefined();
    expect(undercut!.metric!).toBeGreaterThan(0.1);
    expect(undercut!.severity).toBe('critical');
    expect(undercut!.fix).toMatch(/Flip the part/);
  });

  it('distinguishes side-reachable slots from underside-only overhangs', () => {
    // A C-channel open on the sides: has both a bottom slab and a top slab, so
    // flipping alone cannot see between them, but side faces (±X / ±Y) can.
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.005], [0.04, 0.04, 0.005], 'bottom'),
      boxBody([-0.03, 0, 0.025], [0.01, 0.04, 0.015], 'wall'),
      boxBody([0, 0, 0.045], [0.04, 0.04, 0.005], 'top'),
    ]), 'cnc', { asPlaced: true });

    const undercut = r.findings.find(f => f.id === 'cnc_undercut');
    expect(undercut).toBeDefined();
    expect(undercut!.fix).toMatch(/Flip the part/);
    expect(undercut!.fix).toMatch(/Setups: Auto/);
    expect([...r.heat].some(h => Math.abs(h - 0.8) < 1e-3)).toBe(true);
  });

  it('stays quiet about depth a normal bit can reach', () => {
    // Stepping down in passes is ordinary. Warning about every deep part is how
    // a panel teaches people to ignore it.
    const r = analyseDfm(scene([boxBody([0, 0, 0.015], [0.02, 0.02, 0.015])]), 'cnc', { asPlaced: true });
    expect(r.findings.find(f => f.id === 'cnc_reach')).toBeUndefined();
  });

  it('stays quiet for standard two-sided depth and warns past 2× max tool reach', () => {
    // 100 mm is <= 2 * 50.8 mm (101.6 mm): ordinary two-sided machining, no noise.
    const twoSided = analyseDfm(scene([boxBody([0, 0, 0.05], [0.02, 0.02, 0.05])]), 'cnc', { asPlaced: true });
    expect(twoSided.findings.find(f => f.id === 'cnc_reach')).toBeUndefined();

    // 120 mm exceeds 2 * 50.8 mm: warns.
    const tooDeep = analyseDfm(scene([boxBody([0, 0, 0.06], [0.02, 0.02, 0.06])]), 'cnc', { asPlaced: true });
    const reach = tooDeep.findings.find(f => f.id === 'cnc_reach');
    expect(reach).toBeDefined();
    expect(reach!.severity).toBe('warning');
    expect(reach!.metric!).toBeCloseTo(120, 0);
  });
});

describe('enclosedAir', () => {
  it('tells a pocket from the space around the part', () => {
    // A 5x5 plan view: a ring of material with one air cell in the middle.
    const cols = 5, rows = 5;
    const hit = new Uint8Array(cols * rows);
    for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) hit[r * cols + c] = 1;
    hit[2 * cols + 2] = 0; // the pocket

    const enclosed = enclosedAir(hit, cols, rows);
    expect(enclosed[2 * cols + 2]).toBe(1);
    // The border, and everything connected to it, is where the tool came from.
    expect(enclosed[0]).toBe(0);
    expect([...enclosed].filter(Boolean)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Casting
// ---------------------------------------------------------------------------

describe('cast analysis', () => {
  it('flags a deep box: its walls are parallel to the pull and will drag', () => {
    // The classic first lesson in pattern making — a plain box has no draft at
    // all, and over enough height every vertical wall scuffs the mould.
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'cast', { asPlaced: true });
    const draft = r.findings.find(f => f.id === 'cast_draft');
    expect(draft).toBeDefined();
    expect(draft!.detail).toMatch(/2°/);
    expect(draft!.fix).toMatch(/Taper/);
  });

  it('finds the undercut on a shape that leans back over the mould', () => {
    // A spool: wide at both ends, narrow between. Wherever the parting line
    // goes, one flange's inner face looks back into the half it is pulled out
    // of and locks the pattern in. (A slab on a post is not one: it parts at
    // the step.)
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.01], [0.06, 0.06, 0.01], 'foot'),
      boxBody([0, 0, 0.04], [0.01, 0.01, 0.02], 'waist'),
      boxBody([0, 0, 0.07], [0.06, 0.06, 0.01], 'cap'),
    ]), 'cast', { asPlaced: true });

    const undercut = r.findings.find(f => f.id === 'cast_undercut');
    expect(undercut).toBeDefined();
    expect(undercut!.severity).toBe('critical');
    expect(undercut!.detail).toMatch(/will not pull|leans back/);
    expect([...r.heat].some(h => h === 1)).toBe(true);
  });

  it('scores a shape with an undercut worse than one that merely drags', () => {
    const drags = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'cast', { asPlaced: true });
    const locks = analyseDfm(scene([
      boxBody([0, 0, 0.01], [0.06, 0.06, 0.01], 'foot'),
      boxBody([0, 0, 0.04], [0.01, 0.01, 0.02], 'waist'),
      boxBody([0, 0, 0.07], [0.06, 0.06, 0.01], 'cap'),
    ]), 'cast', { asPlaced: true });
    expect(locks.score).toBeLessThan(drags.score);
  });
});

// ---------------------------------------------------------------------------
// The report itself
// ---------------------------------------------------------------------------

describe('analyseDfm', () => {
  it('returns the same triangles the heat indexes into', () => {
    // The overlay colours this soup directly, so a mismatch here would paint
    // the wrong faces — and nothing downstream could detect it.
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'print', { asPlaced: true });
    expect(r.heat.length).toBe(r.tris.length / 9);
  });

  it('copes with an empty scene', () => {
    const r = analyseDfm(scene([]), 'cnc', { asPlaced: true });
    expect(r.findings).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.summary).toMatch(/Nothing/);
  });

  it('gives every process an answer for the same hollow part', () => {
    const cup = scene([meshBody(cupMesh())]);
    for (const process of ['print', 'cnc', 'cast'] as const) {
      const r = analyseDfm(cup, process, { asPlaced: true });
      expect(r.process).toBe(process);
      expect(r.heat.length).toBe(r.tris.length / 9);
      expect(r.legend.length).toBeGreaterThan(0);
      expect(r.summary.length).toBeGreaterThan(0);
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it('respects a caller’s limits over the bench', () => {
    const tall = scene([boxBody([0, 0, 0.05], [0.02, 0.02, 0.05])]);
    expect(analyseDfm(tall, 'cnc', { asPlaced: true, maxToolReachMm: 500 }).findings.find(f => f.id === 'cnc_reach')).toBeUndefined();
    expect(analyseDfm(tall, 'cnc', { asPlaced: true, maxToolReachMm: 5 }).findings.find(f => f.id === 'cnc_reach')).toBeDefined();
  });

  it('says, part by part, what it left out and why', () => {
    // The per-part walk gathers these itself rather than sampling the whole
    // scene a second time for its warnings.
    const uncut: SceneNode = {
      ...boxBody([0.2, 0, 0.05], [0.05, 0.05, 0.05], 'plate'),
      csgEnabled: true,
      geoms: [
        { name: 'slab', type: 'box', size: [0.05, 0.05, 0.05] } as SceneGeom,
        { name: 'hole', type: 'cylinder', size: [0.01, 0.06], csg: 'difference' } as SceneGeom,
      ],
    };
    const broken = meshBody({ verts: [], faces: [] }, { id: 'broken', name: 'broken' });
    const sim = { ...boxBody([-0.2, 0, 0.05], [0.02, 0.02, 0.02], 'cut'), simulation: {} } as SceneNode;
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05]), uncut, broken, sim]), 'print');
    expect(r.warnings).toContain('plate: CSG has not been compiled, so its holes are not cut.');
    expect(r.warnings).toContain('cut: a simulated cut, so it is left out.');
    expect(r.warnings).toContain('Not analysed: broken (part_mesh).');
    expect(r.heat.length).toBe(r.tris.length / 9);
  });
});

// ---------------------------------------------------------------------------
// What the viewport draws from the report.
// ---------------------------------------------------------------------------

describe('buildHeatGeometry', () => {
  it('draws nothing when nothing is wrong', () => {
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'print', { asPlaced: true });
    expect(buildHeatGeometry(r)).toBeNull();
  });

  it('draws only the offending triangles, in the same places they were measured', () => {
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'post'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'slab'),
    ]), 'print', { asPlaced: true });

    const hot = [...r.heat].filter(h => h > 0.001).length;
    const geom = buildHeatGeometry(r)!;
    expect(geom).not.toBeNull();
    // Three vertices per hot triangle, and not one more.
    expect(geom.getAttribute('position').count).toBe(hot * 3);
    expect(geom.getAttribute('color').count).toBe(hot * 3);

    // Every drawn vertex has to be a vertex of the soup that was analysed,
    // or the colours are describing triangles the user is not looking at.
    const pos = geom.getAttribute('position').array as ArrayLike<number>;
    const zs = new Set<number>();
    for (let i = 2; i < pos.length; i += 3) zs.add(+pos[i].toFixed(4));
    for (const z of zs) expect([...r.tris].some(v => Math.abs(v - z) < 1e-3)).toBe(true);
  });

  it('gives a triangle one flat colour, so the face reads as a face', () => {
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'post'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'slab'),
    ]), 'print', { asPlaced: true });
    const col = buildHeatGeometry(r)!.getAttribute('color').array as ArrayLike<number>;
    for (let v = 0; v < 9; v += 3) {
      expect(col[v]).toBeCloseTo(col[0], 6);
      expect(col[v + 1]).toBeCloseTo(col[1], 6);
      expect(col[v + 2]).toBeCloseTo(col[2], 6);
    }
  });
});

// ---------------------------------------------------------------------------
// The limits come from the bench, not from this file.
// ---------------------------------------------------------------------------

describe('dfmLimitsFor', () => {
  it('takes the overhang and wall limits from the loaded filament', () => {
    // PLA sets almost instantly under a fan and holds a good deal past 45°.
    // TPU is still soft when the next layer lands on it, and will not bridge.
    const pla = dfmLimitsFor({ material: 'hardwood', filament: 'pla' });
    const tpu = dfmLimitsFor({ material: 'hardwood', filament: 'tpu' });
    expect(pla.overhangDeg).toBeGreaterThan(tpu.overhangDeg);
    expect(pla.bridges).toBe(true);
    expect(tpu.bridges).toBe(false);
    expect(tpu.minWallMm).toBeGreaterThan(pla.minWallMm);
  });

  it('knows which filaments shrink off the bed', () => {
    expect(dfmLimitsFor({ material: 'hardwood', filament: 'abs' }).warpsOnLargeFlats).toBe(true);
    expect(dfmLimitsFor({ material: 'hardwood', filament: 'pla' }).warpsOnLargeFlats).toBe(false);
  });

  it('takes the cut wall limit from the stock on the bench', () => {
    // A 1.2 mm rib is fine in aluminium and crumbles in MDF.
    const alu = dfmLimitsFor({ material: 'aluminium', filament: 'pla' });
    const mdf = dfmLimitsFor({ material: 'mdf', filament: 'pla' });
    expect(alu.cncMinWallMm).toBeLessThan(mdf.cncMinWallMm);
  });

  it('derives reach from the biggest bit a workshop owns, not a guess', () => {
    const l = dfmLimitsFor({ material: 'hardwood', filament: 'pla' });
    expect(l.maxToolReachMm).toBeCloseTo(6.35 * 8, 6);
  });
});

describe('the bench changes the answer', () => {
  const overhangingPart = () => scene([
    boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'post'),
    boxBody([0, 0, 0.05], [0.03, 0.03, 0.01], 'slab'),
  ]);

  it('flags a flat ceiling in TPU that PLA would simply support', () => {
    const pla = analyseDfm(overhangingPart(), 'print', { asPlaced: true, filament: 'pla' });
    const tpu = analyseDfm(overhangingPart(), 'print', { asPlaced: true, filament: 'tpu' });
    expect(pla.findings.find(f => f.id === 'print_no_bridge')).toBeUndefined();
    expect(tpu.findings.find(f => f.id === 'print_no_bridge')).toBeDefined();
  });

  it('flags a 1 mm rib in MDF and passes the same rib in aluminium', () => {
    const rib = () => scene([boxBody([0, 0, 0.02], [0.0005, 0.04, 0.02])]);
    expect(analyseDfm(rib(), 'cnc', { asPlaced: true, material: 'mdf' }).findings.find(f => f.id === 'cnc_thin_wall')).toBeDefined();
    expect(analyseDfm(rib(), 'cnc', { asPlaced: true, material: 'aluminium' }).findings.find(f => f.id === 'cnc_thin_wall')).toBeUndefined();
  });

  it('says when the part just misses the board', () => {
    // 200 x 200 mm on a 150 mm board: scale it or split it, and both are real
    // things to do.
    const near = scene([boxBody([0, 0, 0.005], [0.1, 0.1, 0.005])]);
    const r = analyseDfm(near, 'cnc', { asPlaced: true, stock: { widthMm: 150, depthMm: 150, thicknessMm: 18 } });
    const fit = r.findings.find(f => f.id === 'stock_fit');
    expect(fit).toBeDefined();
    expect(fit!.severity).toBe('critical');
  });

  it('says nothing when the part is plainly not meant for that board', () => {
    // A 4 m bridge deck does not fit a 150 mm board, and saying so is the kind
    // of true, useless remark that gets a panel switched off.
    const huge = scene([boxBody([0, 0, 0.05], [2, 2, 0.05])]);
    expect(analyseDfm(huge, 'cnc', { asPlaced: true, stock: { widthMm: 150, depthMm: 150, thicknessMm: 18 } })
      .findings.find(f => f.id === 'stock_fit')).toBeUndefined();
  });

  it('never checks the board on the print lens — nothing knows the bed size', () => {
    const near = scene([boxBody([0, 0, 0.005], [0.1, 0.1, 0.005])]);
    expect(analyseDfm(near, 'print', { asPlaced: true, stock: { widthMm: 150, depthMm: 150, thicknessMm: 18 } })
      .findings.find(f => f.id === 'stock_fit')).toBeUndefined();
  });

  it('does not invent a stock problem when no stock was given', () => {
    const big = scene([boxBody([0, 0, 0.05], [0.2, 0.2, 0.05])]);
    expect(analyseDfm(big, 'cnc', { asPlaced: true }).findings.find(f => f.id === 'stock_fit')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Calibration. A panel that complains about every part is a panel people turn
// off — and then the one real problem goes unseen too.
// ---------------------------------------------------------------------------

describe('it stays quiet about ordinary parts', () => {
  const roomy = { widthMm: 400, depthMm: 400, thicknessMm: 100 };

  it('says nothing about a plain block, for any process', () => {
    const block = () => scene([boxBody([0, 0, 0.01], [0.04, 0.04, 0.01])]);
    for (const process of ['print', 'cnc', 'cast'] as const) {
      expect(analyseDfm(block(), process, { asPlaced: true, stock: roomy }).findings).toEqual([]);
    }
  });

  it('does not call an ordinary block undraftable just for having square sides', () => {
    // Every box ever modelled has vertical walls. A 40 mm one pulls fine, and
    // flagging it would flag half the scene.
    const domino = scene([boxBody([0, 0, 0.02], [0.01, 0.005, 0.02])]);
    expect(analyseDfm(domino, 'cast', { asPlaced: true }).findings.find(f => f.id === 'cast_draft')).toBeUndefined();
  });

  it('still mentions draft on a wall deep enough for the drag to cost something', () => {
    const tall = scene([boxBody([0, 0, 0.1], [0.05, 0.05, 0.1])]);
    expect(analyseDfm(tall, 'cast', { asPlaced: true }).findings.find(f => f.id === 'cast_draft')).toBeDefined();
  });

  it('does not warn about the support a normal overhang needs', () => {
    // A modest chamfered overhang is routine FDM, not a defect.
    const modest = scene([
      boxBody([0, 0, 0.02], [0.03, 0.03, 0.02], 'base'),
      boxBody([0, 0, 0.05], [0.035, 0.035, 0.01], 'lip'),
    ]);
    expect(analyseDfm(modest, 'print', { asPlaced: true, stock: roomy }).findings
      .find(f => f.id === 'print_overhang')).toBeUndefined();
  });

  it('does not call bit-radius corners a problem', () => {
    // Inside corners having the cutter's radius is true of every CNC part.
    const pocketed = scene([boxBody([0, 0, 0.01], [0.05, 0.05, 0.01])]);
    expect(analyseDfm(pocketed, 'cnc', { asPlaced: true, stock: roomy }).findings
      .find(f => f.id === 'cnc_corner_radius')).toBeUndefined();
  });

  it('still catches the things that really do fail', () => {
    // The bar is "this will not work", and these still trip it.
    const locked = scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'base'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'cap'),
    ]);
    const spool = scene([
      boxBody([0, 0, 0.01], [0.06, 0.06, 0.01], 'foot'),
      boxBody([0, 0, 0.04], [0.01, 0.01, 0.02], 'waist'),
      boxBody([0, 0, 0.07], [0.06, 0.06, 0.01], 'cap'),
    ]);
    expect(analyseDfm(spool, 'cast', { asPlaced: true }).findings.find(f => f.id === 'cast_undercut')).toBeDefined();
    expect(analyseDfm(locked, 'cnc', { asPlaced: true }).findings.find(f => f.id === 'cnc_undercut')).toBeDefined();
  });
});

describe('curved parts are not paper-thin', () => {
  it('does not report a sphere’s silhouette as a thin wall', () => {
    // Any curved body is genuinely a sliver where it turns away from the
    // viewer. Measuring those columns reported every round part as unmakeable,
    // which is exactly the kind of false alarm that gets a panel switched off.
    const ball = meshBody(sphereMesh(0.01));
    const thin = thinnestWall(toSoup(sphereMesh(0.01)), 1.5);
    expect(thin!.mm).toBeGreaterThan(1.5);
    expect(analyseDfm(scene([ball]), 'cnc', { asPlaced: true }).findings.find(f => f.id === 'cnc_thin_wall')).toBeUndefined();
    expect(analyseDfm(scene([ball]), 'print', { asPlaced: true }).findings.find(f => f.id === 'print_thin_wall')).toBeUndefined();
  });

  it('still says a sphere cannot be cut from one side, because it cannot', () => {
    const r = analyseDfm(scene([meshBody(sphereMesh(0.01))]), 'cnc', { asPlaced: true });
    expect(r.findings.find(f => f.id === 'cnc_undercut')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fabrication is per part, and a Mesh scene is usually a simulation.
// ---------------------------------------------------------------------------

describe('scoping to one body', () => {
  const twoBodies = () => scene([
    boxBody([0, 0, 0.01], [0.02, 0.02, 0.01], 'small'),
    boxBody([0.5, 0, 0.05], [0.3, 0.3, 0.05], 'huge'),
  ]);

  it('judges only the body asked about', () => {
    // Without this, "can I make this?" is answered about the pendulum, the
    // floor and the gear train at once — all true, and all useless.
    const roomy = { widthMm: 400, depthMm: 400, thicknessMm: 100 };
    const justSmall = analyseDfm(twoBodies(), 'cnc', { asPlaced: true, nodeId: 'small', stock: roomy });
    expect(justSmall.findings).toEqual([]);

    const whole = analyseDfm(twoBodies(), 'cnc', { asPlaced: true, stock: roomy });
    expect(whole.findings.length).toBeGreaterThan(0);
  });

  it('measures the heat only over that body’s triangles', () => {
    const small = analyseDfm(twoBodies(), 'print', { asPlaced: true, nodeId: 'small' });
    const both = analyseDfm(twoBodies(), 'print', { asPlaced: true });
    expect(small.tris.length).toBeLessThan(both.tris.length);
    expect(small.heat.length).toBe(small.tris.length / 9);
  });

  it('falls back to the whole scene for an id that is not there', () => {
    const r = analyseDfm(twoBodies(), 'print', { asPlaced: true, nodeId: 'nonesuch' });
    expect(r.tris.length).toBe(analyseDfm(twoBodies(), 'print', { asPlaced: true }).tris.length);
  });
});

describe('dfmLensFor', () => {
  it('follows the machine on the bench rather than asking twice', () => {
    expect(dfmLensFor('fdm')).toBe('print');
    expect(dfmLensFor('cnc')).toBe('cnc');
  });

  it('has nothing to say about a laser, and says so with null', () => {
    // A laser has no Z depth, so overhang, undercut and reach mean nothing to
    // it. Better no answer than a confident one from the wrong lens.
    expect(dfmLensFor('laser')).toBeNull();
  });
});

describe('the printer bed', () => {
  // Half-extents in metres: a 300 x 100 x 100 mm part.
  const long = () => scene([boxBody([0, 0, 0.05], [0.15, 0.05, 0.05])]);

  it('says a part does not fit when no square-on way up fits the bed', () => {
    const r = analyseDfm(long(), 'print', { asPlaced: true, printBed: { widthMm: 200, depthMm: 200, heightMm: 200 } });
    const f = r.findings.find((x) => x.id === 'print_exceeds_bed');
    expect(f).toBeDefined();
    expect(f!.fix).toMatch(/Split/);
  });

  it('is quiet when it fits some way up, and when no bed is given', () => {
    // 300 mm stands up on a bed 320 mm tall.
    expect(analyseDfm(long(), 'print', { asPlaced: true, printBed: { widthMm: 200, depthMm: 200, heightMm: 320 } })
      .findings.find((x) => x.id === 'print_exceeds_bed')).toBeUndefined();
    expect(analyseDfm(long(), 'print', { asPlaced: true }).findings.find((x) => x.id === 'print_exceeds_bed')).toBeUndefined();
  });

  it('shades exactly the faces Split for Print counts as needing support', () => {
    // A T: a stem with a wide bar on top, whose underside overhangs.
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.04], [0.01, 0.01, 0.04], 'stem'),
      boxBody([0, 0, 0.085], [0.05, 0.05, 0.005], 'bar'),
    ]), 'print', { asPlaced: true });
    const { area } = supportArea(r.tris, DFM_DEFAULTS.overhangDeg);
    let shaded = 0;
    for (let t = 0; t < r.heat.length; t++) {
      if (r.heat[t] <= 0) continue;
      const i = t * 9;
      const u = [r.tris[i + 3] - r.tris[i], r.tris[i + 4] - r.tris[i + 1], r.tris[i + 5] - r.tris[i + 2]];
      const v = [r.tris[i + 6] - r.tris[i], r.tris[i + 7] - r.tris[i + 1], r.tris[i + 8] - r.tris[i + 2]];
      shaded += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
    }
    expect(area).toBeGreaterThan(0);
    expect(shaded).toBeCloseTo(area, 12);
  });

  it('fits a box any of the six square-on ways up', () => {
    expect(fitsBedSquareOn([300, 100, 100], { widthMm: 100, depthMm: 100, heightMm: 300 })).toBe(true);
    expect(fitsBedSquareOn([300, 100, 100], { widthMm: 200, depthMm: 200, heightMm: 200 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression suite: signal declutter, hollow walls, printPose, Resin SLA,
// outsideFaces air-gap preservation, NaN safety, & hardware consolidation.
// ---------------------------------------------------------------------------

/** Builds a closed hollow box mesh with outer half-extents `ho` and wall thickness `wallM`. */
function hollowBoxMesh(ho: [number, number, number], wallM: number) {
  const outer = boxMesh([0, 0, ho[2]], ho);
  const inner = boxMesh([0, 0, ho[2]], [ho[0] - wallM, ho[1] - wallM, ho[2] - wallM]);
  const vOff = outer.verts.length / 3;
  // Flip inner triangle winding so normals point inward into the cavity.
  const innerFaces: number[] = [];
  for (let i = 0; i < inner.faces.length; i += 3) {
    innerFaces.push(inner.faces[i] + vOff, inner.faces[i + 2] + vOff, inner.faces[i + 1] + vOff);
  }
  return {
    verts: [...outer.verts, ...inner.verts],
    faces: [...outer.faces, ...innerFaces],
  };
}

/** Builds a solid 20 mm relief block with peaked mountain ridges across its top face. */
function reliefBlockMesh(widthM = 0.08, depthM = 0.08, baseH = 0.02, peakH = 0.006, nx = 24, ny = 24) {
  const verts: number[] = [];
  const faces: number[] = [];
  const topIdx = (ix: number, iy: number) => iy * (nx + 1) + ix;
  const botStart = (nx + 1) * (ny + 1);
  const botIdx = (ix: number, iy: number) => botStart + iy * (nx + 1) + ix;
  const heightAt = (u: number, v: number) => {
    // Sharp mountain ridges with ~35° slopes
    const r1 = Math.max(0, 1 - Math.abs(u - 0.3) * 6) * peakH;
    const r2 = Math.max(0, 1 - Math.abs(u - 0.7) * 5) * peakH * 0.85;
    const wave = 0.5 + 0.5 * Math.sin(v * Math.PI * 2);
    return baseH + (r1 + r2) * wave;
  };
  for (let iy = 0; iy <= ny; iy++) {
    for (let ix = 0; ix <= nx; ix++) {
      const u = ix / nx, v = iy / ny;
      verts.push((u - 0.5) * widthM, (v - 0.5) * depthM, heightAt(u, v));
    }
  }
  for (let iy = 0; iy <= ny; iy++) {
    for (let ix = 0; ix <= nx; ix++) {
      const u = ix / nx, v = iy / ny;
      verts.push((u - 0.5) * widthM, (v - 0.5) * depthM, 0);
    }
  }
  // Top & bottom surfaces
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const a = topIdx(ix, iy), b = topIdx(ix + 1, iy), c = topIdx(ix + 1, iy + 1), d = topIdx(ix, iy + 1);
      faces.push(a, b, c, a, c, d);
      const ba = botIdx(ix, iy), bb = botIdx(ix + 1, iy), bc = botIdx(ix + 1, iy + 1), bd = botIdx(ix, iy + 1);
      faces.push(ba, bc, bb, ba, bd, bc);
    }
  }
  // Four side skirts
  for (let ix = 0; ix < nx; ix++) {
    // -Y side
    faces.push(botIdx(ix, 0), botIdx(ix + 1, 0), topIdx(ix + 1, 0), botIdx(ix, 0), topIdx(ix + 1, 0), topIdx(ix, 0));
    // +Y side
    faces.push(botIdx(ix + 1, ny), botIdx(ix, ny), topIdx(ix, ny), botIdx(ix + 1, ny), topIdx(ix, ny), topIdx(ix + 1, ny));
  }
  for (let iy = 0; iy < ny; iy++) {
    // -X side
    faces.push(botIdx(0, iy + 1), botIdx(0, iy), topIdx(0, iy), botIdx(0, iy + 1), topIdx(0, iy), topIdx(0, iy + 1));
    // +X side
    faces.push(botIdx(nx, iy), botIdx(nx, iy + 1), topIdx(nx, iy + 1), botIdx(nx, iy), topIdx(nx, iy + 1), topIdx(nx, iy));
  }
  return { verts, faces };
}

describe('DFM engine declutter, wall thickness, pose, printer, & hardware regressions', () => {
  it('catches a hollow box with 0.45 mm walls instead of summing both walls to 0.90 mm', () => {
    const hollow = hollowBoxMesh([0.02, 0.02, 0.02], 0.00045);
    const got = thinnestWall(toSoup(hollow), 0.8);
    expect(got).not.toBeNull();
    expect(got!.mm).toBeCloseTo(0.45, 1);
    expect(got!.share).toBeGreaterThan(0.5);

    const r = analyseDfm(scene([meshBody(hollow)]), 'print', { asPlaced: true });
    const thin = r.findings.find((f) => f.id === 'print_thin_wall');
    expect(thin).toBeDefined();
    expect(thin!.metric!).toBeLessThan(0.55);
    // Summary must describe the thin wall, not "0% of the surface overhangs."
    expect(r.summary).not.toMatch(/0% of the surface overhangs/);
    expect(r.summary).toMatch(/Wall down to/);
  });

  it('reports thin.at at the actual ray-axis midpoint rather than 0', () => {
    // 0.4 mm thick plate located at x = 0.25 m (y in [-0.04, 0.04], z in [0, 0.08]).
    const plate = boxMesh([0.25, 0.0, 0.04], [0.0002, 0.04, 0.04]);
    const got = thinnestWall(toSoup(plate), 0.8);
    expect(got).not.toBeNull();
    expect(got!.mm).toBeCloseTo(0.4, 1);
    expect(got!.at[0]).toBeCloseTo(0.25, 3);
  });

  it('does not false-fire thin-wall on solid mountain relief ridge crests', () => {
    const relief = reliefBlockMesh();
    const got = thinnestWall(toSoup(relief), 0.8);
    // Solid 20 mm base block: every valid opposing wall span is >= 18 mm.
    expect(got === null || got.mm > 15).toBe(true);
    const r = analyseDfm(scene([meshBody(relief)]), 'print', { asPlaced: true });
    expect(r.findings.find((f) => f.id === 'print_thin_wall')).toBeUndefined();
  });

  it('excludes intentional compliant flexure leaves from thin-wall findings', () => {
    const flexNode: SceneNode = {
      id: 'flex_body',
      name: 'Compliant Hinge',
      type: 'body',
      pos: [0, 0, 0.02],
      joints: [],
      children: [],
      flexure: {
        kind: 'blade',
        filament: 'petg',
        thicknessMm: 0.5,
        lengthMm: 15,
        widthMm: 10,
        stiffness: 0.1,
        maxTravel: 20,
      },
      geoms: [
        { name: 'body_block', type: 'box', size: [0.02, 0.02, 0.01] } as SceneGeom,
        { name: 'flexure_blade', type: 'box', size: [0.00025, 0.0075, 0.005], pos: [0.025, 0, 0], role: 'visual' } as SceneGeom,
      ],
    };
    const r = analyseDfm(scene([flexNode]), 'print', { nodeId: 'flex_body' });
    expect(r.findings.find((f) => f.id === 'print_thin_wall')).toBeUndefined();
  });

  it('gates unselected multi-body avalanche with needsPartSelection and respects checkAllAsPlate', () => {
    const bed = { widthMm: 220, depthMm: 220, heightMm: 220 };
    const multi = scene([
      boxBody([0, 0, 0.05], [0.15, 0.05, 0.05], 'partA'),
      boxBody([0.5, 0, 0.05], [0.15, 0.05, 0.05], 'partB'),
    ]);
    const gated = analyseDfm(multi, 'print', { printBed: bed });
    expect(gated.needsPartSelection).toEqual({ bodyCount: 2 });
    expect(gated.findings.filter((f) => f.id.includes('print_exceeds_bed'))).toHaveLength(0);

    const allPlate = analyseDfm(multi, 'print', { printBed: bed, checkAllAsPlate: true });
    expect(allPlate.needsPartSelection).toBeUndefined();
    expect(allPlate.findings.filter((f) => f.id.includes('print_exceeds_bed'))).toHaveLength(2);
  });

  it('lowers BED_BALLPARK to 2.2 so large simulation props stay quiet', () => {
    // 700 mm tall tower on a 256 mm bed: ratio = 2.73 > 2.2 -> simulation prop, not a print near-miss.
    const tower = scene([boxBody([0, 0, 0.35], [0.05, 0.05, 0.35], 'tower')]);
    const r = analyseDfm(tower, 'print', { asPlaced: true, printBed: { widthMm: 256, depthMm: 256, heightMm: 256 } });
    expect(r.findings.find((f) => f.id === 'print_exceeds_bed')).toBeUndefined();
  });

  it('respects node.printPose (overhangs & diagonal bed fit) and never paints phantom rotated heat', () => {
    // T-shape as a single multi-geom body: wide top bar hangs over air unless flipped upside down.
    const tNode: SceneNode = {
      id: 't_part', name: 'T Part', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [
        { name: 'stem', type: 'box', size: [0.01, 0.01, 0.02], pos: [0, 0, 0.02] } as SceneGeom,
        { name: 'bar', type: 'box', size: [0.06, 0.06, 0.01], pos: [0, 0, 0.05] } as SceneGeom,
      ],
    };
    // Without printPose: reports placed overhang, viewport heat matches placed overhang, and offers apply_print_pose!
    const unposed = analyseDfm(scene([tNode]), 'print', { nodeId: 't_part' });
    const oh = unposed.findings.find((f) => f.id === 'print_overhang');
    expect(oh).toBeDefined();
    expect(oh!.nodeId).toBe('t_part');
    expect(oh!.actions?.some((a) => a.kind === 'apply_print_pose')).toBe(true);
    expect([...unposed.heat].some((h) => h > 0.5)).toBe(true);

    // With printPose flipped upside down: overhang disappears, heat is 0, judgedPoseLabel is set!
    const flipped: SceneNode = { ...tNode, printPose: { up: [0, 0, -1], spin: 0 } };
    const posed = analyseDfm(scene([flipped]), 'print', { nodeId: 't_part' });
    expect(posed.findings.find((f) => f.id === 'print_overhang')).toBeUndefined();
    expect(posed.heat.every((h) => h === 0)).toBe(true);
    expect(posed.judgedPoseLabel).toBe('print pose');

    // Diagonal 45° printPose fits a 280 x 30 x 20 mm bar onto a 250 x 250 x 250 mm bed.
    const bar: SceneNode = boxBody([0, 0, 0.01], [0.14, 0.015, 0.01], 'bar');
    const bed = { widthMm: 250, depthMm: 250, heightMm: 250 };
    const unposedBar = analyseDfm(scene([bar]), 'print', { nodeId: 'bar', printBed: bed });
    const bedErr = unposedBar.findings.find((f) => f.id === 'print_exceeds_bed');
    expect(bedErr).toBeDefined();
    expect(bedErr!.actions?.some((a) => a.kind === 'apply_print_pose')).toBe(true);
    expect(bedErr!.actions?.some((a) => a.kind === 'open_split')).toBe(true);

    const diagBar: SceneNode = { ...bar, printPose: { up: [0, 0, 1], spin: Math.PI / 4 } };
    const posedBar = analyseDfm(scene([diagBar]), 'print', { nodeId: 'bar', printBed: bed });
    expect(posedBar.findings.find((f) => f.id === 'print_exceeds_bed')).toBeUndefined();
  });

  it('connects bench.printer: scales FDM nozzle minWallMm and runs SLA trapped-cup check for resin', () => {
    const lim08 = dfmLimitsFor({
      material: 'hardwood',
      filament: 'pla',
      printer: { process: 'fdm', nozzleMm: 0.8, layerMm: 0.4, xyMm: 0.05 },
    });
    expect(lim08.minWallMm).toBeCloseTo(1.6, 5);

    // 1.2 mm plate passes 0.4 mm nozzle PLA (0.8 mm min) but fails 0.8 mm nozzle (1.6 mm min).
    const wall12 = scene([boxBody([0, 0, 0.02], [0.0006, 0.03, 0.02])]);
    expect(analyseDfm(wall12, 'print', { asPlaced: true, printer: { process: 'fdm', nozzleMm: 0.4, layerMm: 0.2, xyMm: 0.05 } })
      .findings.find((f) => f.id === 'print_thin_wall')).toBeUndefined();
    expect(analyseDfm(wall12, 'print', { asPlaced: true, printer: { process: 'fdm', nozzleMm: 0.8, layerMm: 0.4, xyMm: 0.05 } })
      .findings.find((f) => f.id === 'print_thin_wall')).toBeDefined();

    // Resin SLA printer flags upright hollow cup (opening toward the vat) with sla_trapped_cup,
    // and skips FDM warping/bridging; solid block has zero sla_trapped_cup findings.
    const resin = { process: 'resin' as const, nozzleMm: 0.4, layerMm: 0.05, xyMm: 0.05 };
    const cupReport = analyseDfm(scene([meshBody(cupMesh())]), 'print', { asPlaced: true, filament: 'abs', printer: resin });
    expect(cupReport.findings.find((f) => f.id === 'sla_trapped_cup')).toBeDefined();
    expect(cupReport.findings.find((f) => f.id === 'print_warp')).toBeUndefined();
    expect(cupReport.findings.find((f) => f.id === 'print_no_bridge')).toBeUndefined();

    const solidReport = analyseDfm(scene([boxBody([0, 0, 0.02], [0.02, 0.02, 0.02])]), 'print', { asPlaced: true, printer: resin });
    expect(solidReport.findings.find((f) => f.id === 'sla_trapped_cup')).toBeUndefined();
  });

  it('measures bed-contact footprint for print_warp and requires > 5 mm ceiling span for print_no_bridge', () => {
    // ABS mushroom: 40 mm stem touching bed, 160 mm canopy up in mid-air -> no bed warp!
    const mushroom = scene([
      boxBody([0, 0, 0.02], [0.02, 0.02, 0.02], 'stem'),
      boxBody([0, 0, 0.05], [0.08, 0.08, 0.01], 'canopy'),
    ]);
    expect(analyseDfm(mushroom, 'print', { asPlaced: true, filament: 'abs' })
      .findings.find((f) => f.id === 'print_warp')).toBeUndefined();

    // ABS 160 mm flat plate resting on bed -> triggers print_warp with actions!
    const flatAbs = scene([boxBody([0, 0, 0.005], [0.08, 0.08, 0.005])]);
    const warp = analyseDfm(flatAbs, 'print', { asPlaced: true, filament: 'abs' })
      .findings.find((f) => f.id === 'print_warp');
    expect(warp).toBeDefined();
    expect(warp!.actions?.some((a) => a.kind === 'set_filament' && a.filament === 'petg')).toBe(true);

    // TPU tiny 3 mm horizontal ceiling overhang -> below 5 mm bridge span threshold, ignored.
    const tinyCeiling = scene([
      boxBody([0, 0, 0.005], [0.002, 0.002, 0.005], 'base'),
      boxBody([0, 0, 0.011], [0.0015, 0.0015, 0.001], 'cap'),
    ]);
    expect(analyseDfm(tinyCeiling, 'print', { asPlaced: true, filament: 'tpu' })
      .findings.find((f) => f.id === 'print_no_bridge')).toBeUndefined();
  });

  it('preserves opposing exterior faces across a 0.2 mm air gap in outsideFaces while removing flush buried faces', () => {
    // Two 40 x 40 x 20 mm boxes separated by a 0.2 mm air gap along Z.
    const a = toSoup(boxMesh([0, 0, 0.01], [0.02, 0.02, 0.01]));
    const bGap = toSoup(boxMesh([0, 0, 0.0302], [0.02, 0.02, 0.01]));
    const trisGap = new Float64Array(a.length + bGap.length);
    trisGap.set(a, 0);
    trisGap.set(bGap, a.length);
    const solidsGap = new Int32Array(trisGap.length / 9);
    solidsGap.fill(0, 0, a.length / 9);
    solidsGap.fill(1, a.length / 9);
    const keptGap = outsideFaces(trisGap, solidsGap);
    expect(keptGap.index.length).toBe(trisGap.length / 9);

    // Same two boxes touching flush at z = 0.02 -> the 4 touching interface triangles are removed.
    const bTouch = toSoup(boxMesh([0, 0, 0.03], [0.02, 0.02, 0.01]));
    const trisTouch = new Float64Array(a.length + bTouch.length);
    trisTouch.set(a, 0);
    trisTouch.set(bTouch, a.length);
    const keptTouch = outsideFaces(trisTouch, solidsGap);
    expect(keptTouch.index.length).toBe(trisTouch.length / 9 - 4);
  });

  it('safely handles NaN and zero-span triangle soups without throwing', () => {
    const nanTris = new Float64Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(() => thinnestWall(nanTris, 0.8)).not.toThrow();
    expect(thinnestWall(nanTris, 0.8)).toBeNull();
    expect(() => sampleColumns(nanTris, { minX: NaN, minY: 0, maxX: NaN, maxY: 1 }, NaN, 16)).not.toThrow();
    expect(() => sampleWallSpans(nanTris, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, 0, 0)).not.toThrow();
  });

  it('reports thin heat_set_boss walls via hardwareChecks with thicken_boss action and scopes by nodeId', () => {
    const bossNode: SceneNode = {
      id: 'boss_1',
      name: 'M3 Boss',
      type: 'body',
      pos: [0.05, 0.02, 0.01],
      joints: [],
      children: [],
      isHardwareComponent: true,
      hardwareType: 'heat_set_boss',
      hardwareSpec: { size: 'M3', outerDiameterMm: 6.0, innerHoleMm: 4.0 },
      geoms: [{ name: 'boss_cyl', type: 'cylinder', size: [0.003, 0.005] } as SceneGeom],
    };
    const otherNode = boxBody([0.2, 0, 0.02], [0.02, 0.02, 0.02], 'unrelated');
    const sc = scene([bossNode, otherNode]);

    const direct = bossFindings(sc, 'print');
    expect(direct).toHaveLength(1);
    expect(direct[0].id).toBe('boss_wall_boss_1');
    expect(direct[0].nodeId).toBe('boss_1');
    expect(direct[0].actions?.[0]).toEqual({
      kind: 'thicken_boss',
      label: 'Thicken boss OD to 7.6 mm',
      nodeId: 'boss_1',
      outerDiameterMm: 7.6,
    });

    // Scoped to unrelated body: boss_wall_boss_1 is excluded!
    expect(hardwareFindings(sc, 'print', sc, undefined, 'unrelated')).toHaveLength(0);
    // Scoped to boss_1: boss_wall_boss_1 is included!
    expect(hardwareFindings(sc, 'print', sc, undefined, 'boss_1')).toHaveLength(1);
  });

  it('fixes misleading CNC summary when stock_fit fires with 0% undercut', () => {
    const near = scene([boxBody([0, 0, 0.005], [0.1, 0.1, 0.005])]);
    const r = analyseDfm(near, 'cnc', { asPlaced: true, stock: { widthMm: 150, depthMm: 150, thicknessMm: 18 } });
    expect(r.summary).not.toMatch(/0% unreachable from above/);
    expect(r.summary).toMatch(/Exceeds stock dimensions/);
    const fit = r.findings.find((f) => f.id === 'stock_fit');
    expect(fit?.actions?.[0]?.kind).toBe('fit_stock');
  });

  it('flags a sphere/point-contact print pose with print_tiny_bed_contact while passing a flat-bottomed box', () => {
    const ball = meshBody(sphereMesh(0.02), { id: 'ball', name: 'ball', pos: [0, 0, 0.02] });
    const rBall = analyseDfm(scene([ball]), 'print', { asPlaced: true });
    const tiny = rBall.findings.find((f) => f.id === 'print_tiny_bed_contact');
    expect(tiny).toBeDefined();
    expect(tiny!.severity).toBe('critical');

    const flatBox = boxBody([0, 0, 0.02], [0.02, 0.02, 0.02], 'flat');
    const rBox = analyseDfm(scene([flatBox]), 'print', { asPlaced: true });
    expect(rBox.findings.find((f) => f.id === 'print_tiny_bed_contact')).toBeUndefined();
  });

  it('keeps flat 19 mm boards flat in CNC orientation search instead of standing them on edge', () => {
    // 800 x 420 x 19 mm flat board against a 300 x 300 x 20 mm bench stock:
    // stock_fit fires flat, and standing it on edge (+X up, 800 mm deep) must
    // NOT silence stock_fit via STOCK_BALLPARK to trade it for a cnc_reach warning.
    const flatBoard = boxBody([0, 0, 0.0095], [0.4, 0.21, 0.0095], 'flat_board');
    const stock = { widthMm: 300, depthMm: 300, thicknessMm: 20 };
    const rFlat = analyseDfm(scene([flatBoard]), 'cnc', { stock });
    expect(rFlat.findings.find((f) => f.id === 'cnc_reach')).toBeUndefined();
    expect(rFlat.findings.find((f) => f.id === 'stock_fit')).toBeDefined();
    expect(rFlat.judgedPoseLabel).toBeUndefined();

    // 800 x 19 x 374 mm upright panel: CNC orientation search must lay it flat
    // (+Y up, 19 mm thick) so cnc_reach does not fire, regardless of stock size.
    const uprightPanel = boxBody([0, 0, 0.187], [0.4, 0.0095, 0.187], 'upright_panel');
    const rUpright = analyseDfm(scene([uprightPanel]), 'cnc', { stock });
    expect(rUpright.findings.find((f) => f.id === 'cnc_reach')).toBeUndefined();
    expect(rUpright.findings.find((f) => f.id === 'stock_fit')).toBeDefined();

    // Same upright panel with roomy stock (or no stock): lays flat and passes cleanly.
    const rClean = analyseDfm(scene([uprightPanel]), 'cnc', { stock: { widthMm: 900, depthMm: 500, thicknessMm: 25 } });
    expect(rClean.findings).toEqual([]);
    expect(rClean.score).toBe(100);
  });

  it('keeps cast summary in sync with emitted cast_undercut and cast_draft findings', () => {
    // Spool has an undercut (critical) and ~28% vertical walls (< 50% dragShare),
    // so cast_draft is NOT emitted and summary must not claim "short of draft".
    const spool = scene([
      boxBody([0, 0, 0.01], [0.06, 0.06, 0.01], 'foot'),
      boxBody([0, 0, 0.04], [0.01, 0.01, 0.02], 'waist'),
      boxBody([0, 0, 0.07], [0.06, 0.06, 0.01], 'cap'),
    ]);
    const rSpool = analyseDfm(spool, 'cast', { asPlaced: true });
    expect(rSpool.findings.find((f) => f.id === 'cast_undercut')).toBeDefined();
    expect(rSpool.findings.find((f) => f.id === 'cast_draft')).toBeUndefined();
    expect(rSpool.summary).toMatch(/undercut/);
    expect(rSpool.summary).not.toMatch(/short of draft/);

    // Tall cube has cast_draft and 0% undercut: summary must mention "short of draft"
    // and NOT "0% undercut".
    const tallCube = scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]);
    const rCube = analyseDfm(tallCube, 'cast', { asPlaced: true });
    expect(rCube.findings.find((f) => f.id === 'cast_draft')).toBeDefined();
    expect(rCube.findings.find((f) => f.id === 'cast_undercut')).toBeUndefined();
    expect(rCube.summary).toMatch(/short of draft/);
    expect(rCube.summary).not.toMatch(/undercut/);
  });
});
