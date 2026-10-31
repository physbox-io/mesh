// The pour box for a silicone mold: base, groove and sleeve round a master,
// checked as printed parts and then poured, the way a maker would use them.
import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { buildPourBox, holePinMesh, soupVolume, topZAt, type PourBoxMesh } from '../src/utils/siliconeMold';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { simulateCastFromMoldNode } from '../src/utils/moldCastSimulation';
import { planPourBox, sceneWithPourBox } from '../src/utils/pourBoxScene';
import { pourBoxIn, pourNodeFor } from '../src/utils/pourTarget';
import { addPourBoxToScene } from '../src/utils/pourBoxActions';
import { useStore } from '../src/store/useStore';
import { moldSubject } from '../src/utils/moldSubject';
import { getNodeWorldTransform } from '../src/utils/laserCutExporter';
import * as THREE from 'three';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

/** A closed cylinder standing on z = z0, as a soup in mm. */
function cylinderSoup(r: number, h: number, n = 256, z0 = 0): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const a0 = (2 * Math.PI * i) / n, a1 = (2 * Math.PI * (i + 1)) / n;
    const p0 = [r * Math.cos(a0), r * Math.sin(a0)], p1 = [r * Math.cos(a1), r * Math.sin(a1)];
    out.push(0, 0, z0 + h, p0[0], p0[1], z0 + h, p1[0], p1[1], z0 + h);
    out.push(0, 0, z0, p1[0], p1[1], z0, p0[0], p0[1], z0);
    out.push(p0[0], p0[1], z0, p1[0], p1[1], z0, p1[0], p1[1], z0 + h);
    out.push(p0[0], p0[1], z0, p1[0], p1[1], z0 + h, p0[0], p0[1], z0 + h);
  }
  return out;
}

/** A box [x0,y0,z0]-[x1,y1,z1] as a soup, wound outward. */
function boxSoup([x0, y0, z0]: number[], [x1, y1, z1]: number[]): number[] {
  const c = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0];
  const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  const out: number[] = [];
  for (const [a, b, cc, d] of quads) out.push(...c(a), ...c(b), ...c(cc), ...c(a), ...c(cc), ...c(d));
  return out;
}

function closedOutward(m: PourBoxMesh) {
  const r = analyzeMesh(m.positions, m.faces)!;
  expect(r.closed).toBe(true);
  expect(r.consistentlyWound).toBe(true);
  expect(r.volume).toBeGreaterThan(0);
}

/** A mesh geom from mm, Z up, as a body in the scene would carry it. */
const meshGeom = (name: string, m: { positions: number[]; faces: number[] }): SceneGeom =>
  ({ name, type: 'mesh', renderVertices: m.positions.map((v) => v / 1000), vertices: m.positions.map((v) => v / 1000), faces: m.faces }) as unknown as SceneGeom;

const soupMesh = (soup: number[]) => ({ positions: soup, faces: soup.map((_, i) => i).filter((i) => i < soup.length / 3) });

const node = (id: string, geoms: SceneGeom[], children: SceneNode[] = []): SceneNode =>
  ({ id, name: id, type: 'body', pos: [0, 0, 0], joints: [], geoms, children }) as unknown as SceneNode;

describe('a pour box round a candle', () => {
  const R = 22.5, H = 60;
  const candle = cylinderSoup(R, H);

  it('builds closed printable parts, with the sleeve the cover clear of the master', () => {
    const box = buildPourBox(wasm, candle);
    closedOutward(box.base);
    closedOutward(box.sleeve);
    // build_mold.py's figures: sleeve bore 30.5 mm, 2.4 mm wall, fill 8 mm over the top.
    let rin = Infinity, rout = 0;
    for (let i = 0; i < box.sleeve.positions.length; i += 3) {
      const r = Math.hypot(box.sleeve.positions[i], box.sleeve.positions[i + 1]);
      rin = Math.min(rin, r); rout = Math.max(rout, r);
    }
    expect(rin).toBeGreaterThan(30.4);
    expect(rin).toBeLessThan(30.6);
    expect(rout).toBeCloseTo(32.9, 1);
    expect(box.report.fillHeightMm).toBeCloseTo(68, 5);
    expect(box.report.pourDepthMm).toBeCloseTo(71, 5);
    expect(box.report.sleeveHeightMm).toBeCloseTo(3 + 68 + 2, 5);
    // The sleeve drops into the groove; the plate under it stays whole.
    let baseBottom = Infinity, sleeveBottom = Infinity;
    for (let i = 2; i < box.base.positions.length; i += 3) baseBottom = Math.min(baseBottom, box.base.positions[i]);
    for (let i = 2; i < box.sleeve.positions.length; i += 3) sleeveBottom = Math.min(sleeveBottom, box.sleeve.positions[i]);
    expect(baseBottom).toBeCloseTo(-6, 5);
    expect(sleeveBottom).toBeCloseTo(-3, 5);
    // The groove is the sleeve's wall plus the clearance each side.
    const groove = (2.4 + 0.4) * Math.PI * (30.3 + 33.1) * 3;
    const plate = soupVolumeOf(box.base);
    expect(plate).toBeGreaterThan(Math.PI * 36.1 ** 2 * 6 - groove - 300);
    expect(plate).toBeLessThan(Math.PI * 36.1 ** 2 * 6 - groove + 300);
  });

  it('reports the silicone build_mold.py worked out by hand, in grams of each part', () => {
    const box = buildPourBox(wasm, candle);
    const expected = Math.PI * 30.5 ** 2 * 68 - Math.PI * R ** 2 * H;
    expect(Math.abs(box.report.siliconeMm3 - expected) / expected).toBeLessThan(0.01);
    expect(box.report.siliconeG).toBeCloseTo((box.report.siliconeMm3 / 1000) * 1.08, -1);
    expect(box.report.partAG + box.report.partBG).toBeCloseTo(box.report.siliconeG, -1);
    const tin = buildPourBox(wasm, candle, { silicone: 'tin' });
    expect(tin.report.partAG).toBeCloseTo(10 * tin.report.partBG, -1);
  });

  it('pours to the figure it reports', async () => {
    const box = buildPourBox(wasm, candle);
    const mold = node('mold', [], [
      node('base', [meshGeom('base', box.base)]),
      node('sleeve', [meshGeom('sleeve', box.sleeve)]),
      node('master', [meshGeom('master', soupMesh(candle))]),
    ]);
    const silicone = await simulateCastFromMoldNode(mold, { pour: { fillMm: box.report.pourDepthMm } });
    expect(silicone.success).toBe(true);
    // The pour also fills the 0.2 mm gap down the groove's inside: a fin.
    expect(Math.abs(silicone.castVolumeMm3 - box.report.siliconeMm3) / box.report.siliconeMm3).toBeLessThan(0.02);
  });

  it('puts a wick hole on the middle of the top, reaching past the fill line', () => {
    const box = buildPourBox(wasm, candle, { hole: 'wick' });
    expect(box.hole).toMatchObject({ purpose: 'wick', diaMm: 2.5 });
    expect(box.hole!.footMm[0]).toBeCloseTo(0, 3);
    expect(box.hole!.footMm[1]).toBeCloseTo(0, 3);
    expect(box.hole!.footMm[2] + box.hole!.lengthMm).toBeCloseTo(H + 8 + 1, 5);
    const plain = buildPourBox(wasm, candle);
    expect(plain.report.siliconeMm3 - box.report.siliconeMm3).toBeCloseTo(Math.PI * 1.25 ** 2 * 8, -1);
  });
});

describe('a hole through the mold', () => {
  const brick = boxSoup([-40, -10, 0], [40, 10, 20]);

  it('starts at a point picked on the master, and sizes itself by purpose', () => {
    const box = buildPourBox(wasm, brick, { hole: 'pour', holeAtMm: [25, 0] });
    expect(box.hole).toMatchObject({ purpose: 'pour', diaMm: 8 });
    expect(box.hole!.footMm[0]).toBe(25);
    expect(box.hole!.footMm[2]).toBeCloseTo(19.5, 5);
    expect(box.report.holeTopMm).toEqual([25, 0, 29]);
  });

  it('puts the pin on the master, not in the air between two peaks', () => {
    const twoPosts = [...boxSoup([-20, -5, 0], [-10, 5, 20]), ...boxSoup([10, -5, 0], [20, 5, 20])];
    const box = buildPourBox(wasm, twoPosts, { hole: 'wick' });
    expect(topZAt(twoPosts, box.hole!.footMm[0], box.hole!.footMm[1])).toBeCloseTo(20, 5);
  });

  it('sinks the pin to the lowest point under its rim on a slope', () => {
    // A wedge rising 1 mm per mm in X, from 10 to 30 mm.
    const wedge = wedgeSoup();
    const box = buildPourBox(wasm, wedge, { hole: 'pour', holeAtMm: [0, 0] });
    // Centre at 20 mm; an 8 mm hole's rim reaches down to 16.
    expect(box.hole!.footMm[2] + 0.5).toBeCloseTo(16, 1);
  });

  it('warns about a hole that cannot work', () => {
    expect(buildPourBox(wasm, brick, { hole: 'pour', holeDiaMm: 4 }).report.warnings.join(' ')).toMatch(/below the 6 mm minimum/);
    expect(buildPourBox(wasm, brick, { hole: 'wick', holeDiaMm: 7 }).report.warnings.join(' ')).toMatch(/exceeds 5 mm max for a plugged hole/);
    expect(buildPourBox(wasm, brick, { hole: 'wick' }).report.warnings).toEqual([]);
  });

  it('makes the pin a closed, outward-wound solid to print', () => {
    const box = buildPourBox(wasm, brick, { hole: 'fixing' });
    const pin = holePinMesh(box.hole!);
    expect(soupVolumeOf(pin)).toBeCloseTo(Math.PI * 1.5 ** 2 * box.hole!.lengthMm, 0);
    const a = analyzeMesh(pin.positions, pin.faces);
    expect(a.closed).toBe(true);
  });

  it('refuses a point that is not over the master', () => {
    expect(() => buildPourBox(wasm, brick, { hole: 'fixing', holeAtMm: [60, 0] })).toThrow(/not over the master/);
  });
});

describe('a pour box round a long master', () => {
  const brick = boxSoup([-40, -10, 0], [40, 10, 20]);

  it('follows the master’s plan, so a long part does not sit in a tube of silicone', () => {
    const fit = buildPourBox(wasm, brick);
    const round = buildPourBox(wasm, brick, { shape: 'round' });
    closedOutward(fit.sleeve);
    closedOutward(round.sleeve);
    expect(fit.report.sleeveFootprintMm[0]).toBeCloseTo(80 + 2 * (8 + 2.4), 0);
    expect(fit.report.sleeveFootprintMm[1]).toBeCloseTo(20 + 2 * (8 + 2.4), 0);
    expect(round.report.siliconeMm3).toBeGreaterThan(2 * fit.report.siliconeMm3);
  });

  it('stands the base under the master however high the master is', () => {
    const lifted = buildPourBox(wasm, boxSoup([-10, -10, 50], [10, 10, 70]));
    let top = -Infinity;
    for (let i = 2; i < lifted.base.positions.length; i += 3) top = Math.max(top, lifted.base.positions[i]);
    expect(top).toBeCloseTo(50, 5);
    expect(lifted.report.fillZMm).toBeCloseTo(78, 5);
  });
});

describe('the pour box in the scene', () => {
  // A 20 mm cube master, moved and turned a quarter round Z: the pin must
  // still come out on top of it, in the world.
  const cubeGeom = { name: 'cube', type: 'box', size: [0.01, 0.01, 0.01] } as SceneGeom;
  const turned = { id: 'm', name: 'cube', type: 'body', pos: [0.1, 0.05, 0.01], quat: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], joints: [], geoms: [cubeGeom], children: [] } as unknown as SceneNode;
  const scene = { nodes: [turned] } as unknown as SceneGraph;

  it('stands the base and sleeve round the master, and fixes the pin to it', async () => {
    const box = await planPourBox(scene, ['m'], { hole: 'wick' });
    expect(box.report.fillZMm).toBeCloseTo(28, 3);
    const out = sceneWithPourBox(scene, ['m'], box);
    expect(out.scene.nodes).toHaveLength(3);
    const base = out.scene.nodes.find((n) => n.id === out.baseId)!;
    // On the middle of the master's footprint, its top where the master stands.
    expect(base.pos[0]).toBeCloseTo(0.1, 4);
    expect(base.pos[1]).toBeCloseTo(0.05, 4);
    expect(base.pos[2]).toBeCloseTo(-0.006, 4);
    const master = out.scene.nodes.find((n) => n.id === 'm')!;
    const pin = master.children!.find((c) => c.id === out.holePinId)!;
    expect(pin.joints).toHaveLength(0);
    // Turned back into the master's frame: in the world it stands straight up
    // from the middle of the top, from 0.5 mm inside it to 1 mm past the fill.
    const w = getNodeWorldTransform(pin, getNodeWorldTransform(master));
    const p = new THREE.Vector3().setFromMatrixPosition(w);
    expect(p.x).toBeCloseTo(0.1, 4);
    expect(p.y).toBeCloseTo(0.05, 4);
    expect(p.z * 1000).toBeCloseTo((19.5 + 29) / 2, 2);
    expect(new THREE.Vector3(0, 0, 1).transformDirection(w).z).toBeCloseTo(1, 5);
  });

  it('pours as the scene stands, wick hole and all', async () => {
    const box = await planPourBox(scene, ['m'], { hole: 'wick' });
    const out = sceneWithPourBox(scene, ['m'], box);
    const mold = pourNodeFor(out.scene.nodes, ['m', out.baseId, out.sleeveId])!;
    const silicone = await simulateCastFromMoldNode(mold, { pour: { fillMm: box.report.pourDepthMm } });
    expect(silicone.success).toBe(true);
    expect(Math.abs(silicone.castVolumeMm3 - box.report.siliconeMm3) / box.report.siliconeMm3).toBeLessThan(0.03);
  });
});

describe('pouring round a master built from primitives', () => {
  // The simulation used to snap primitives to a 0.1 µm grid and leave the pour
  // box's meshes as they were; a cylinder master then met the base a hair off
  // its face, the union kept the master out, and the silicone filled it.
  it('keeps a cylinder master out of the silicone', async () => {
    const cyl = { name: 'c', type: 'cylinder', size: [0.008, 0.008], pos: [0, 0, 0.008] } as SceneGeom;
    const scene = { nodes: [{ id: 'm', name: 'cyl', type: 'body', pos: [0, 0, 0], joints: [], geoms: [cyl], children: [] }] } as unknown as SceneGraph;
    const box = await planPourBox(scene, ['m'], {});
    const out = sceneWithPourBox(scene, ['m'], box);
    const mold = pourNodeFor(out.scene.nodes, ['m', out.baseId, out.sleeveId])!;
    const silicone = await simulateCastFromMoldNode(mold, { pour: { fillMm: box.report.pourDepthMm } });
    expect(silicone.success).toBe(true);
    expect(Math.abs(silicone.castVolumeMm3 - box.report.siliconeMm3) / box.report.siliconeMm3).toBeLessThan(0.03);
  });
});

describe('the hole pin is tooling, not the master', () => {
  it('leaves the pin out when the box is planned again, or the master molded', async () => {
    const cube = { name: 'cube', type: 'box', size: [0.01, 0.01, 0.01] } as SceneGeom;
    const scene = { nodes: [{ id: 'm', name: 'cube', type: 'body', pos: [0, 0, 0.01], joints: [], geoms: [cube], children: [] }] } as unknown as SceneGraph;
    const box = await planPourBox(scene, ['m'], { hole: 'wick' });
    const out = sceneWithPourBox(scene, ['m'], box);
    expect(out.holePinId).toBeDefined();
    const again = await planPourBox(out.scene, ['m'], { hole: 'wick' });
    expect(again.report.fillZMm).toBeCloseTo(box.report.fillZMm, 5);
    expect(again.report.siliconeMm3).toBeCloseTo(box.report.siliconeMm3, -1);
    const subject = moldSubject(out.scene, []);
    expect(subject.ids).toEqual(['m']);
    expect(subject.scene.nodes[0].children ?? []).toHaveLength(0);
  });
});

describe('after the pour box is added', () => {
  const cubeGeom = { name: 'cube', type: 'box', size: [0.01, 0.01, 0.01] } as SceneGeom;
  const master = { id: 'm', name: 'cube', type: 'body', pos: [0, 0, 0.01], joints: [], geoms: [cubeGeom], children: [] } as unknown as SceneNode;

  it('marks the sleeve with its fill line, which a pour into the box picks up', async () => {
    const scene = { nodes: [master] } as unknown as SceneGraph;
    const box = await planPourBox(scene, ['m'], {});
    const out = sceneWithPourBox(scene, ['m'], box);
    const sleeve = out.scene.nodes.find((n) => n.id === out.sleeveId)!;
    expect(sleeve.pourBox).toEqual({ pourDepthMm: box.report.pourDepthMm, silicone: 'platinum' });
    expect(out.scene.nodes.find((n) => n.id === out.baseId)!.pourBox).toEqual(sleeve.pourBox);
    expect(pourBoxIn(pourNodeFor(out.scene.nodes, ['m', out.baseId, out.sleeveId])!)).toEqual(sleeve.pourBox);
    expect(pourBoxIn(master)).toBeNull();
    // Turned over, the box is not poured as planned, so it offers no fill line.
    const turned = { ...sleeve, quat: [0, 1, 0, 0] } as SceneNode;
    expect(pourBoxIn(turned)).toBeNull();
  });

  it('leaves master, base and sleeve selected, the master first, for Cast', async () => {
    useStore.getState().updateScene({ nodes: [master] } as unknown as SceneGraph);
    useStore.getState().selectMany(['m'], false);
    const added = await addPourBoxToScene(['m'], {});
    const { selectedNodeId, extraSelectedIds } = useStore.getState();
    expect(selectedNodeId).toBe('m');
    expect(extraSelectedIds).toEqual([added.baseId, added.sleeveId]);
    expect(added.selected).toEqual(['m', added.baseId, added.sleeveId]);
  });
});

function soupVolumeOf(m: PourBoxMesh): number {
  const soup: number[] = [];
  for (const f of m.faces) soup.push(m.positions[f * 3], m.positions[f * 3 + 1], m.positions[f * 3 + 2]);
  return soupVolume(soup);
}

/** A wedge 20 mm long, 10 mm wide, its top rising 1 mm per mm from 10 to 30 mm, wound outward. */
function wedgeSoup(): number[] {
  const p = {
    a: [-10, -5, 0], b: [10, -5, 0], c: [10, 5, 0], d: [-10, 5, 0],
    e: [-10, -5, 10], f: [10, -5, 30], g: [10, 5, 30], h: [-10, 5, 10],
  };
  const quads: (keyof typeof p)[][] = [
    ['a', 'd', 'c', 'b'], ['e', 'f', 'g', 'h'], ['a', 'b', 'f', 'e'], ['c', 'd', 'h', 'g'], ['b', 'c', 'g', 'f'], ['d', 'a', 'e', 'h'],
  ];
  const out: number[] = [];
  for (const [w, x, y, z] of quads) out.push(...p[w], ...p[x], ...p[y], ...p[w], ...p[y], ...p[z]);
  return out;
}

describe('a groove deeper than the base allows', () => {
  it('says how deep it was made, and why', () => {
    const shallow = buildPourBox(wasm, cylinderSoup(10, 20), { baseMm: 4, grooveMm: 5 });
    expect(shallow.report.grooveMm).toBe(3);
    expect(shallow.report.warnings.some((w) => /Groove depth clamped to 3 mm \(from 5 mm\)/.test(w))).toBe(true);
    const asked = buildPourBox(wasm, cylinderSoup(10, 20), { baseMm: 6, grooveMm: 4 });
    expect(asked.report.grooveMm).toBe(4);
    expect(asked.report.warnings.some((w) => /groove/i.test(w))).toBe(false);
  });
});
