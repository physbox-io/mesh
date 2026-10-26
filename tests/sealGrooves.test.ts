// O-ring grooves and the seal check. These check that each kind of groove goes
// where the part says it should — centred on a lid, in the middle of a wall,
// round a boss, in a bore — at the gland the cord wants; that one which cannot
// fit says why; and that the check tells a lid that seals from one that sits
// too high, or misses half the ring.

import { describe, it, expect } from 'vitest';
import { hardwareCutGeoms, hardwareCutProblem, type HardwareCutSpec } from '../src/utils/hardwareCuts';
import { cutGeometry, prismMesh, primitiveToScad } from '../src/utils/csg';
import { planSealGroove, roundedRect, loopLengthMm } from '../src/utils/sealGrooves';
import { sealFindings, screwFindings } from '../src/utils/hardwareChecks';
import { hardwarePartNode, seatPart, sweepMesh } from '../src/utils/hardwareParts';
import { GLANDS } from '../src/utils/hardwareSizes';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const body = (id: string, geoms: Partial<SceneGeom>[], pos = [0, 0, 0]): SceneNode => ({
  id, name: id, pos, csgEnabled: true, joints: [], children: [],
  geoms: geoms.map((g, i) => ({ name: `${id}_${i}`, ...g }) as SceneGeom),
} as SceneNode);

/** As the store's writeHardwareGroup does it: the pieces, each placed by cutGeometry. */
function cut(node: SceneNode, over: Partial<HardwareCutSpec>): SceneGeom[] {
  const spec: HardwareCutSpec = { group: 'g1', kind: 'oring', size: '', at: [0, 0, 0], normal: [0, 0, 1], ...over };
  const pieces = hardwareCutGeoms(spec, node.id, node);
  for (const piece of pieces) {
    node.geoms.push(piece);
    Object.assign(piece, cutGeometry(node, piece));
  }
  return pieces;
}

/** A round lid 60 mm across and 6 thick, its underside at z = 0, facing down. */
const disc = () => body('lid', [{ type: 'cylinder', size: [0.03, 0.003], pos: [0, 0, 0.003] }]);
/** A jar: Ø60, 40 tall, top at z = 0.04, with a Ø50 cavity open at the top. */
const jar = () => body('jar', [
  { type: 'cylinder', size: [0.03, 0.02], pos: [0, 0, 0.02] },
  { type: 'cylinder', size: [0.025, 0.0185], pos: [0, 0, 0.0215], csg: 'difference' },
]);
/** A box 80 × 60 × 30, top at z = 0.03, a 72 × 52 cavity open at the top: 4 mm walls. */
const box = (wallMm = 4) => body('box', [
  { type: 'box', size: [0.04, 0.03, 0.015], pos: [0, 0, 0.015] },
  { type: 'box', size: [0.04 - wallMm / 1000, 0.03 - wallMm / 1000, 0.0135], pos: [0, 0, 0.0165], csg: 'difference' },
]);

describe('the geometry it is built from', () => {
  it('stands an outline with a hole up as a closed ring, wound outward', () => {
    const outer = roundedRect(20, 10, 4);
    const inner = roundedRect(17, 7, 1).reverse();
    const m = prismMesh(outer, -0.001, 0.001, [inner]);
    const a = analyzeMesh(m.positions, m.faces)!;
    expect(a.closed).toBe(true);
    expect(a.consistentlyWound).toBe(true);
    expect(a.volume).toBeGreaterThan(0);
  });

  it('turns a cylinder with an inside radius into a ring for OpenSCAD', () => {
    const scad = primitiveToScad({ name: 'r', type: 'cylinder', size: [0.01, 0.001], ringInner: 0.008, csg: 'difference' } as SceneGeom);
    expect(scad).toMatch(/difference\(\)\s*\{\s*cylinder\(h=[^)]*r=0\.01[^)]*\);\s*cylinder\([^)]*r=0\.008/);
  });

  it('sweeps cord into a closed tube, wound outward', () => {
    const m = sweepMesh(roundedRect(30, 20, 6), 0.001);
    const a = analyzeMesh(m.renderVertices, m.faces)!;
    expect(a.closed && a.consistentlyWound && a.volume > 0).toBe(true);
  });
});

describe('where a groove goes', () => {
  it('centres a face groove on a round lid, as big as fits with plastic outside it', () => {
    const lid = disc();
    const [g] = cut(lid, { at: [0.01, 0, 0], normal: [0, 0, -1] });
    expect(g.hardware?.seal).toBe('face');
    expect(g.cutAt![0]).toBeCloseTo(0, 6);
    expect(g.size![0]).toBeLessThanOrEqual(0.03 - 0.0008 + 1e-9);
    // At the gland the cord wants.
    const cord = String(Number(g.hardware!.size.split('×')[1]));
    expect(g.cutDepth! * 1000).toBeCloseTo(GLANDS[cord].face[0], 6);
  });

  it('puts it in the middle of a jar\'s wall', () => {
    const j = jar();
    const plan = planSealGroove({ kind: 'oring', size: '', at: [0.027, 0, 0.04], normal: [0, 0, 1] }, j);
    expect('problem' in plan).toBe(false);
    if ('problem' in plan) return;
    const outer = plan.geom.size![0] * 1000;
    const inner = plan.geom.ringInner! * 1000;
    // Inside the 25-30 mm wall with a bead each side.
    expect(inner).toBeGreaterThanOrEqual(25.8 - 1e-6);
    expect(outer).toBeLessThanOrEqual(29.2 + 1e-6);
  });

  it('runs a piston groove round a boss, the ring a little stretched onto its floor', () => {
    const boss = body('plug', [{ type: 'cylinder', size: [0.0125, 0.01], pos: [0, 0, 0.01] }]);
    const [g] = cut(boss, { at: [0.0125, 0, 0.01], normal: [1, 0, 0] });
    expect(g.hardware?.seal).toBe('piston');
    expect(g.cutAxis!.slice(3)).toEqual([0, 0, 1]);
    expect(g.pos![2]).toBeCloseTo(0.01, 6);
    expect(g.ringInner!).toBeLessThan(0.0125);
  });

  it('cuts a bore groove into the wall of a hole', () => {
    const part = body('housing', [
      { type: 'box', size: [0.02, 0.02, 0.01], pos: [0, 0, 0] },
      // For an 8 mm shaft: 0.3 mm over across.
      { type: 'cylinder', size: [0.00415, 0.012], pos: [0, 0, 0], csg: 'difference' },
    ]);
    const [g] = cut(part, { at: [0.00415, 0, 0], normal: [-1, 0, 0] });
    expect(g.hardware?.seal).toBe('bore');
    expect(g.size![0]).toBeGreaterThan(0.00415);
    // A ring with an 8 mm bore, on the shaft without stretching.
    expect(g.hardware!.size).toMatch(/^8×/);
  });

  it('follows a box\'s rim in the middle of its walls, and knows the cord to cut', () => {
    const b = box(4);
    const [g] = cut(b, { kind: 'seal_cord', at: [0.038, 0, 0.03], normal: [0, 0, 1] });
    expect(g.type).toBe('mesh');
    expect(g.cutHoles).toHaveLength(1);
    // The groove's outer wall sits inside the box's edge by the bead and half the spare wall.
    const xs = g.cutOutline!.map(([x]) => x);
    const width = GLANDS[g.hardware!.size].face[1];
    expect(Math.max(...xs) * 1000).toBeCloseTo(40 - (4 - width) / 2, 3);
    const mid = g.cutOutline!.map(([x, y], i) => [(x + [...g.cutHoles![0]].reverse()[i][0]) / 2, (y + [...g.cutHoles![0]].reverse()[i][1]) / 2]);
    expect(loopLengthMm(mid)).toBeGreaterThan(2 * (76 + 56) - 30);
  });

  it('refuses a wall too thin for any groove, and says how thin', () => {
    const b = box(2);
    const why = hardwareCutProblem({ group: 'g', kind: 'seal_cord', size: '', at: [0.039, 0, 0.03], normal: [0, 0, 1] }, b);
    expect(why).toMatch(/2\.0 mm/);
    expect(hardwareCutGeoms({ group: 'g', kind: 'seal_cord', size: '', at: [0.039, 0, 0.03], normal: [0, 0, 1] }, 'box', b)).toEqual([]);
  });

  it('refuses a ring too big for its boss', () => {
    const boss = body('plug', [{ type: 'cylinder', size: [0.005, 0.01], pos: [0, 0, 0.01] }]);
    const why = hardwareCutProblem({ group: 'g', kind: 'oring', size: '40×2', at: [0.005, 0, 0.01], normal: [1, 0, 0] }, boss);
    expect(why).toMatch(/too big/);
  });
});

describe('the seal check', () => {
  /** The jar with its face groove, and a lid over it at `liftMm` above the rim, `shiftMm` to one side. */
  const jarAndLid = (liftMm: number, shiftMm = 0) => {
    const j = jar();
    cut(j, { at: [0.027, 0, 0.04], normal: [0, 0, 1] });
    const lid = body('lid', [{ type: 'cylinder', size: [0.03, 0.003], pos: [0, 0, 0] }], [shiftMm / 1000, 0, 0.043 + liftMm / 1000]);
    return { nodes: [j, lid] } as SceneGraph;
  };

  it('passes a lid sitting on the rim', () => {
    const [f] = sealFindings(jarAndLid(0), 'print');
    expect(f.passed).toBe(true);
    expect(f.title).toMatch(/seals/);
  });

  it('fails a lid standing half a millimetre off, and says how far to bring it', () => {
    const [f] = sealFindings(jarAndLid(0.5), 'print');
    expect(f.severity).toBe('critical');
    expect(f.title).toMatch(/squeezed only/);
    expect(f.fix).toMatch(/Bring the lid 0\.5 mm closer/);
  });

  it('fails a lid that misses part of the ring', () => {
    const [f] = sealFindings(jarAndLid(0, 20), 'print');
    expect(f.severity).toBe('critical');
    expect(f.title).toMatch(/misses/);
  });

  it('says nothing presses on a groove with no lid', () => {
    const j = jar();
    cut(j, { at: [0.027, 0, 0.04], normal: [0, 0, 1] });
    const [f] = sealFindings({ nodes: [j] } as SceneGraph, 'print');
    expect(f.severity).toBe('warning');
    expect(f.title).toMatch(/nothing presses/);
  });

  it('passes a plug in a bore a slide clearance bigger', () => {
    const plug = body('plug', [{ type: 'cylinder', size: [0.0125, 0.01], pos: [0, 0, 0.01] }]);
    cut(plug, { at: [0.0125, 0, 0.01], normal: [1, 0, 0] });
    const sleeve = body('sleeve', [
      { type: 'cylinder', size: [0.02, 0.012], pos: [0, 0, 0.01] },
      { type: 'cylinder', size: [0.01265, 0.014], pos: [0, 0, 0.01], csg: 'difference' },
    ]);
    // Uncompiled, a body's hole is not in its triangles; stand the sleeve in as
    // a ring of material, which is what compiling it would give.
    sleeve.geoms = [{ name: 'tube', type: 'mesh', size: [1], ...tubeMesh(0.01265, 0.02, 0.024, 0.01) } as SceneGeom];
    sleeve.csgEnabled = false;
    const [f] = sealFindings({ nodes: [plug, sleeve] } as SceneGraph, 'print');
    expect(f.passed).toBe(true);
  });
});

describe('the ring in its groove', () => {
  it('lies on the floor of a face groove, round its line', () => {
    const j = jar();
    cut(j, { at: [0.027, 0, 0.04], normal: [0, 0, 1] });
    const ring = hardwarePartNode({ kind: 'oring', size: '20×2' }, 'r');
    j.children.push(ring);
    expect(seatPart(ring, j, 'g1')).toBe(true);
    const g = j.geoms.find((x) => x.hardware?.part === 'groove')!;
    const cord = Number(g.hardware!.size.split('×')[1]) / 1000;
    // Its centre is half a cord above the floor.
    expect(ring.pos[2]).toBeCloseTo(0.04 - g.cutDepth! + cord / 2, 6);
    expect(ring.hardwarePart?.size).toBe(g.hardware!.size);
    const a = analyzeMesh(ring.geoms[0].renderVertices!, ring.geoms[0].faces!)!;
    expect(a.closed && a.consistentlyWound && a.volume > 0).toBe(true);
  });

  it('is cord cut to the length of a rim groove', () => {
    const b = box(4);
    cut(b, { kind: 'seal_cord', at: [0.038, 0, 0.03], normal: [0, 0, 1] });
    const ring = hardwarePartNode({ kind: 'oring', size: '2' }, 'r');
    b.children.push(ring);
    expect(seatPart(ring, b, 'g1')).toBe(true);
    expect(ring.name).toMatch(/cord, \d+ mm/);
    expect(ring.hardwarePart!.lengthMm!).toBeGreaterThan(200);
  });
});

describe('the screw check', () => {
  it('warns of a cap screw on too little plastic under its head', () => {
    const plate = body('plate', [{ type: 'box', size: [0.02, 0.02, 0.0025], pos: [0, 0, 0] }]);
    cut(plate, { kind: 'counterbore', size: 'M3', at: [0, 0, 0.0025], normal: [0, 0, 1] });
    const screw = hardwarePartNode({ kind: 'screw', size: 'M3' }, 's');
    plate.children.push(screw);
    seatPart(screw, plate, 'g1');
    const [f] = screwFindings({ nodes: [plate] } as SceneGraph, 'print');
    expect(f.severity).toBe('warning');
    expect(f.title).toMatch(/under its head/);
  });
});

/** A plain tube, Z-up, its bore r1 and outside r2, length h, centred at z. */
function tubeMesh(r1: number, r2: number, h: number, z: number) {
  const outer = Array.from({ length: 48 }, (_, i) => [r2 * Math.cos((i / 48) * 2 * Math.PI), r2 * Math.sin((i / 48) * 2 * Math.PI)]);
  const inner = Array.from({ length: 48 }, (_, i) => [r1 * Math.cos((i / 48) * 2 * Math.PI), r1 * Math.sin((i / 48) * 2 * Math.PI)]).reverse();
  const m = prismMesh(outer, z - h / 2, z + h / 2, [inner]);
  const vertices: number[] = [];
  for (let i = 0; i < m.positions.length; i += 3) vertices.push(m.positions[i], m.positions[i + 2], -m.positions[i + 1]);
  return { renderVertices: m.positions, vertices, faces: m.faces };
}
