// What the DFM overlay claims about a shape, checked against shapes whose
// answers are known by hand.
//
// The engine is pure — it takes a SceneGraph and returns numbers — so all of
// this runs in plain Node with no store, no worker and no MuJoCo. That is the
// point of it being a separate module from utils/printAnalysis.ts, which reads
// live simulation state at module scope.

import { describe, it, expect } from 'vitest';
import {
  analyseDfm,
  dfmLensFor,
  dfmLimitsFor,
  draftDeg,
  enclosedAir,
  overhangDeg,
  thinnestWall,
  DFM_DEFAULTS,
} from '../src/utils/dfm';
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
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'print');
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
    ]), 'print');

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
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'print');
    expect(r.findings).toHaveLength(0);
  });

  it('measures a thin wall through whichever axis it is thin in', () => {
    // 0.4 mm thin in X, which a plan-view-only check would never see.
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.0002, 0.05, 0.05])]), 'print');
    const thin = r.findings.find(f => f.id === 'print_thin_wall');
    expect(thin).toBeDefined();
    expect(thin!.metric!).toBeLessThan(DFM_DEFAULTS.minWallMm);
    expect(thin!.severity).toBe('critical');
  });

  it('leaves a wall at the limit alone', () => {
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.002, 0.05, 0.05])]), 'print');
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
    const r = analyseDfm(scene([boxBody([0, 0, 0.01], [0.05, 0.05, 0.01])]), 'cnc');
    expect(r.findings.find(f => f.id === 'cnc_undercut')).toBeUndefined();
  });

  it('catches material tucked under an overhang', () => {
    // A T: the arms of the top slab hang out over nothing, so the air beneath
    // them is inside the column but outside the material. A 3-axis cutter
    // coming straight down cannot get under there.
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'stem'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'top'),
    ]), 'cnc');

    const undercut = r.findings.find(f => f.id === 'cnc_undercut');
    expect(undercut).toBeDefined();
    expect(undercut!.metric!).toBeGreaterThan(0.1);
    expect(undercut!.severity).toBe('critical');
    expect(undercut!.fix).toMatch(/Flip the part/);
  });

  it('stays quiet about depth a normal bit can reach', () => {
    // Stepping down in passes is ordinary. Warning about every deep part is how
    // a panel teaches people to ignore it.
    const r = analyseDfm(scene([boxBody([0, 0, 0.015], [0.02, 0.02, 0.015])]), 'cnc');
    expect(r.findings.find(f => f.id === 'cnc_reach')).toBeUndefined();
  });

  it('speaks up when the part is deeper than any bit reaches', () => {
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.02, 0.02, 0.05])]), 'cnc');
    const reach = r.findings.find(f => f.id === 'cnc_reach');
    expect(reach).toBeDefined();
    expect(reach!.metric!).toBeCloseTo(100, 0);
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
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'cast');
    const draft = r.findings.find(f => f.id === 'cast_draft');
    expect(draft).toBeDefined();
    expect(draft!.detail).toMatch(/2°/);
    expect(draft!.fix).toMatch(/Taper/);
  });

  it('finds the undercut on a shape that leans back over the mould', () => {
    // A slab wider than the base beneath it: pulled up along +Z, the underside
    // of that overhang faces back down into the drag and locks the pattern in.
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'base'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'cap'),
    ]), 'cast');

    const undercut = r.findings.find(f => f.id === 'cast_undercut');
    expect(undercut).toBeDefined();
    expect(undercut!.severity).toBe('critical');
    expect(undercut!.detail).toMatch(/will not pull|leans back/);
    expect([...r.heat].some(h => h === 1)).toBe(true);
  });

  it('scores a shape with an undercut worse than one that merely drags', () => {
    const drags = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'cast');
    const locks = analyseDfm(scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'base'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'cap'),
    ]), 'cast');
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
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'print');
    expect(r.heat.length).toBe(r.tris.length / 9);
  });

  it('copes with an empty scene', () => {
    const r = analyseDfm(scene([]), 'cnc');
    expect(r.findings).toEqual([]);
    expect(r.score).toBe(100);
    expect(r.summary).toMatch(/Nothing/);
  });

  it('gives every process an answer for the same hollow part', () => {
    const cup = scene([meshBody(cupMesh())]);
    for (const process of ['print', 'cnc', 'cast'] as const) {
      const r = analyseDfm(cup, process);
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
    expect(analyseDfm(tall, 'cnc', { maxToolReachMm: 500 }).findings.find(f => f.id === 'cnc_reach')).toBeUndefined();
    expect(analyseDfm(tall, 'cnc', { maxToolReachMm: 5 }).findings.find(f => f.id === 'cnc_reach')).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// What the viewport draws from the report.
// ---------------------------------------------------------------------------

describe('buildHeatGeometry', () => {
  it('draws nothing when nothing is wrong', () => {
    const r = analyseDfm(scene([boxBody([0, 0, 0.05], [0.05, 0.05, 0.05])]), 'print');
    expect(buildHeatGeometry(r)).toBeNull();
  });

  it('draws only the offending triangles, in the same places they were measured', () => {
    const r = analyseDfm(scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'post'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'slab'),
    ]), 'print');

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
    ]), 'print');
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
    const pla = analyseDfm(overhangingPart(), 'print', { filament: 'pla' });
    const tpu = analyseDfm(overhangingPart(), 'print', { filament: 'tpu' });
    expect(pla.findings.find(f => f.id === 'print_no_bridge')).toBeUndefined();
    expect(tpu.findings.find(f => f.id === 'print_no_bridge')).toBeDefined();
  });

  it('flags a 1 mm rib in MDF and passes the same rib in aluminium', () => {
    const rib = () => scene([boxBody([0, 0, 0.02], [0.0005, 0.04, 0.02])]);
    expect(analyseDfm(rib(), 'cnc', { material: 'mdf' }).findings.find(f => f.id === 'cnc_thin_wall')).toBeDefined();
    expect(analyseDfm(rib(), 'cnc', { material: 'aluminium' }).findings.find(f => f.id === 'cnc_thin_wall')).toBeUndefined();
  });

  it('says when the part just misses the board', () => {
    // 200 x 200 mm on a 150 mm board: scale it or split it, and both are real
    // things to do.
    const near = scene([boxBody([0, 0, 0.005], [0.1, 0.1, 0.005])]);
    const r = analyseDfm(near, 'cnc', { stock: { widthMm: 150, depthMm: 150, thicknessMm: 18 } });
    const fit = r.findings.find(f => f.id === 'stock_fit');
    expect(fit).toBeDefined();
    expect(fit!.severity).toBe('critical');
  });

  it('says nothing when the part is plainly not meant for that board', () => {
    // A 4 m bridge deck does not fit a 150 mm board, and saying so is the kind
    // of true, useless remark that gets a panel switched off.
    const huge = scene([boxBody([0, 0, 0.05], [2, 2, 0.05])]);
    expect(analyseDfm(huge, 'cnc', { stock: { widthMm: 150, depthMm: 150, thicknessMm: 18 } })
      .findings.find(f => f.id === 'stock_fit')).toBeUndefined();
  });

  it('never checks the board on the print lens — nothing knows the bed size', () => {
    const near = scene([boxBody([0, 0, 0.005], [0.1, 0.1, 0.005])]);
    expect(analyseDfm(near, 'print', { stock: { widthMm: 150, depthMm: 150, thicknessMm: 18 } })
      .findings.find(f => f.id === 'stock_fit')).toBeUndefined();
  });

  it('does not invent a stock problem when no stock was given', () => {
    const big = scene([boxBody([0, 0, 0.05], [0.2, 0.2, 0.05])]);
    expect(analyseDfm(big, 'cnc').findings.find(f => f.id === 'stock_fit')).toBeUndefined();
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
      expect(analyseDfm(block(), process, { stock: roomy }).findings).toEqual([]);
    }
  });

  it('does not call an ordinary block undraftable just for having square sides', () => {
    // Every box ever modelled has vertical walls. A 40 mm one pulls fine, and
    // flagging it would flag half the scene.
    const domino = scene([boxBody([0, 0, 0.02], [0.01, 0.005, 0.02])]);
    expect(analyseDfm(domino, 'cast').findings.find(f => f.id === 'cast_draft')).toBeUndefined();
  });

  it('still mentions draft on a wall deep enough for the drag to cost something', () => {
    const tall = scene([boxBody([0, 0, 0.1], [0.05, 0.05, 0.1])]);
    expect(analyseDfm(tall, 'cast').findings.find(f => f.id === 'cast_draft')).toBeDefined();
  });

  it('does not warn about the support a normal overhang needs', () => {
    // A modest chamfered overhang is routine FDM, not a defect.
    const modest = scene([
      boxBody([0, 0, 0.02], [0.03, 0.03, 0.02], 'base'),
      boxBody([0, 0, 0.05], [0.035, 0.035, 0.01], 'lip'),
    ]);
    expect(analyseDfm(modest, 'print', { stock: roomy }).findings
      .find(f => f.id === 'print_overhang')).toBeUndefined();
  });

  it('does not call bit-radius corners a problem', () => {
    // Inside corners having the cutter's radius is true of every CNC part.
    const pocketed = scene([boxBody([0, 0, 0.01], [0.05, 0.05, 0.01])]);
    expect(analyseDfm(pocketed, 'cnc', { stock: roomy }).findings
      .find(f => f.id === 'cnc_corner_radius')).toBeUndefined();
  });

  it('still catches the things that really do fail', () => {
    // The bar is "this will not work", and these still trip it.
    const locked = scene([
      boxBody([0, 0, 0.02], [0.01, 0.01, 0.02], 'base'),
      boxBody([0, 0, 0.05], [0.06, 0.06, 0.01], 'cap'),
    ]);
    expect(analyseDfm(locked, 'cast').findings.find(f => f.id === 'cast_undercut')).toBeDefined();
    expect(analyseDfm(locked, 'cnc').findings.find(f => f.id === 'cnc_undercut')).toBeDefined();
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
    expect(analyseDfm(scene([ball]), 'cnc').findings.find(f => f.id === 'cnc_thin_wall')).toBeUndefined();
    expect(analyseDfm(scene([ball]), 'print').findings.find(f => f.id === 'print_thin_wall')).toBeUndefined();
  });

  it('still says a sphere cannot be cut from one side, because it cannot', () => {
    const r = analyseDfm(scene([meshBody(sphereMesh(0.01))]), 'cnc');
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
    const justSmall = analyseDfm(twoBodies(), 'cnc', { nodeId: 'small', stock: roomy });
    expect(justSmall.findings).toEqual([]);

    const whole = analyseDfm(twoBodies(), 'cnc', { stock: roomy });
    expect(whole.findings.length).toBeGreaterThan(0);
  });

  it('measures the heat only over that body’s triangles', () => {
    const small = analyseDfm(twoBodies(), 'print', { nodeId: 'small' });
    const both = analyseDfm(twoBodies(), 'print');
    expect(small.tris.length).toBeLessThan(both.tris.length);
    expect(small.heat.length).toBe(small.tris.length / 9);
  });

  it('falls back to the whole scene for an id that is not there', () => {
    const r = analyseDfm(twoBodies(), 'print', { nodeId: 'nonesuch' });
    expect(r.tris.length).toBe(analyseDfm(twoBodies(), 'print').tris.length);
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
