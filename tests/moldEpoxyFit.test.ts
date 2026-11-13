import { describe, it, expect, beforeAll } from 'vitest';
import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS, type MoldExportResult, type MoldOptions, type Triangle3D } from '../src/utils/moldExporter';
import { moldOptionsFor } from '../src/utils/moldWorkerClient';
import { buildPartManifold } from '../src/utils/moldManifold';
import { loadManifold } from '../src/utils/sculptCut';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

// What an audit of failed epoxy pours turned up, measured on the built meshes:
// pins that collide with their sockets on the coarse grid of a big mold, vents
// and gates whose mouths were the sliver of a sharp feature, a gate on a flat
// part's corner, and open molds poured through the tangent patch of a ball.

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

const scene = (geoms: object[]): SceneGraph =>
  ({ nodes: [{ id: 'b', name: 'p', type: 'body', pos: [0, 0, 0], geoms: geoms as SceneGeom[], joints: [], children: [] }] }) as SceneGraph;
const slab = (mm: number) => scene([{ name: 'g', type: 'box', size: [mm / 2000, mm / 2000, 0.01], pos: [0, 0, 0.01] }]);
const ball = (mm: number) => scene([{ name: 'g', type: 'sphere', size: [mm / 2000], pos: [0, 0, 0.04] }]);
/** Stacked discs tapering to a point at the bottom. */
const cone = scene(Array.from({ length: 24 }, (_, i) => ({ name: `s${i}`, type: 'cylinder', size: [Math.max(0.0002, (i + 0.5) * 0.0005), 0.0005], pos: [0, 0, (i + 0.5) * 0.001] })));
/** A knife-edged ridge along x, sharp above and below. */
const wedge = scene(Array.from({ length: 20 }, (_, i) => ({ name: `w${i}`, type: 'box', size: [0.02, Math.max(0.0001, (Math.min(i, 19 - i) + 0.5) * 0.0006), 0.0005], pos: [0, 0, 0.0005 + i * 0.001] })));

const clamshell: MoldOptions = { ...DEFAULT_MOLD_OPTIONS, moldType: 'clamshell', pullDirection: '+z' };

const solidOf = (t: Triangle3D[]): Manifold => {
  const f = new Float64Array(t.length * 9);
  t.forEach((x, i) => f.set([...x.a, ...x.b, ...x.c], i * 9));
  return buildPartManifold(wasm, f).part!;
};
/** Each half in its own frame: parting face at z = 0, cavity below. */
function halves(r: MoldExportResult) {
  const off = r.moldWidthMm / 2 + 3;
  return { base: solidOf(r.bottomHalf.triangles).translate([off, 0, -r.bottomHalf.partingZMm]), lid: solidOf(r.topHalf!.triangles).translate([-off, 0, -r.topHalf!.partingZMm]) };
}
const overlap = (a: Manifold, b: Manifold) => a.intersect(b).volume();
/** Equivalent diameter of the void inside a circle at height z of a half. */
function openDia(half: Manifold, x: number, y: number, r: number, z: number) {
  const disc = wasm.Manifold.cylinder(0.04, r, r, 64, false).translate([x, y, z - 0.02]);
  const solid = half.intersect(disc).slice(z).area();
  return 2 * Math.sqrt(Math.max(0, Math.PI * r * r - solid) / Math.PI);
}

describe('registration', () => {
  it.each([[80], [130], [280]])('a %i mm part: the halves close flush, with the clearance asked for', (mm) => {
    const r = generateMoldMeshes(slab(mm), { ...clamshell, wallMarginMm: 10 }, wasm);
    expect(r.success, r.error).toBe(true);
    const { base, lid } = halves(r);
    const closed = lid.rotate([180, 0, 0]);
    expect(overlap(base, closed)).toBeLessThan(1e-3);
    // Sideways, the pin stops on its socket: it moves, but no further than the tolerance and the sockets' taper.
    expect(overlap(base, closed.translate([0.2, 0, 0]))).toBeLessThan(1e-3);
    expect(overlap(base, closed.translate([0.5, 0, 0]))).toBeGreaterThan(0);
  });
});

describe('gate', () => {
  it('stands inside a flat underside, not on its corner', () => {
    const r = generateMoldMeshes(slab(40), clamshell, wasm);
    const g = r.features!.gate!;
    expect(Math.max(Math.abs(g.atMm[0]), Math.abs(g.atMm[1]))).toBeLessThanOrEqual(20 - g.diaMm / 2);
    expect(openDia(halves(r).base, g.atMm[0], g.atMm[1], g.diaMm / 2, -g.depthMm! + 0.05)).toBeGreaterThan(3.8);
  });

  it('opens as wide as it is on a sharp bottom', () => {
    const r = generateMoldMeshes(cone, clamshell, wasm);
    const g = r.features!.gate!;
    // Past the bore's end the mouth is the cavity's section: on this cone, what the stop reached.
    const { base } = halves(r);
    let widest = 0;
    for (let z = -g.depthMm! + 0.4; z < -g.depthMm! + 2.4; z += 0.2) widest = Math.max(widest, openDia(base, g.atMm[0], g.atMm[1], g.diaMm / 2, z));
    expect(widest).toBeGreaterThan(3.2);
  });

  it('is as wide as the material can flow through', () => {
    // Concrete pours from the top unless asked; asked, its gate passes the aggregate.
    const concrete = generateMoldMeshes(slab(60), { ...clamshell, castMaterial: 'concrete', sprueFeed: 'bottom', wallMarginMm: 25, baseThicknessMm: 10 }, wasm);
    expect(concrete.success, concrete.error).toBe(true);
    expect(concrete.features!.gate!.diaMm).toBe(10);
    expect(generateMoldMeshes(slab(60), { ...clamshell, castMaterial: 'epoxy' }, wasm).features!.gate!.diaMm).toBe(4);
  });
});

describe('down-sprue', () => {
  it.each([[190], [200], [210], [220]])('fits the default wall of a %i mm part, whatever the grid', (mm) => {
    const r = generateMoldMeshes(slab(mm), clamshell, wasm);
    expect(r.success, r.error).toBe(true);
    const down = r.features!.downSprue!;
    const edge = r.moldWidthMm / 2 - Math.max(Math.abs(down.atMm[0]), Math.abs(down.atMm[1]));
    expect(edge - down.diaMm / 2).toBeGreaterThanOrEqual(1.4);
  });
});

describe('vents', () => {
  it.each([[false], [true]])('open wider than a sliver on a knife edge (liner %s)', (liner) => {
    const r = generateMoldMeshes(wedge, { ...clamshell, dissolvableLiner: liner }, wasm);
    expect(r.success, r.error).toBe(true);
    const v = r.features!.vents.find((k) => (k.pocketZMm ?? 0) > 0)!;
    const { lid } = halves(r);
    // In the lid's frame the bore stops at -pocketZ; just past it is the mouth.
    expect(openDia(lid, v.atMm[0], v.atMm[1], v.diaMm / 2 - 0.05, -v.pocketZMm! + 0.1)).toBeGreaterThan(2.4);
  });

  it('stop a ball\'s vent where they did: no collar where the section is already wide', () => {
    const r = generateMoldMeshes(ball(30), clamshell, wasm);
    const v = r.features!.vents[0];
    expect(15 - v.pocketZMm!).toBeLessThan(0.8);
  });
});

describe('high fidelity', () => {
  const rod = scene([{ name: 'g', type: 'cylinder', size: [0.03, 0.012], pos: [0, 0, 0.012] }]);
  /** How far the cavity's wall lies out from the 30 mm radius, averaged round it, at mid-depth of the half. */
  const wallError = (r: MoldExportResult) => {
    const { base } = halves(r);
    const hole = r.moldWidthMm * r.moldDepthMm - base.slice(-6).area();
    return Math.abs(Math.sqrt(hole / Math.PI) - 30);
  };

  it('halves the grid, keeps a sound mold, and fills', () => {
    const plain = generateMoldMeshes(rod, { ...clamshell, includeSprue: false, includeVents: false, includePryNotches: false }, wasm);
    const fine = generateMoldMeshes(rod, { ...clamshell, includeSprue: false, includeVents: false, includePryNotches: false, highFidelity: true }, wasm);
    expect(fine.success, fine.error).toBe(true);
    expect(fine.totalTriangles).toBeGreaterThan(plain.totalTriangles * 3);
    expect(wallError(fine)).toBeLessThan(wallError(plain) * 0.75);
    const { base, lid } = halves(fine);
    expect(overlap(base, lid.rotate([180, 0, 0]))).toBeLessThan(1e-3);
  });

  it('leaves a lined mold alone: its cavity is exact', () => {
    const lined = { ...clamshell, dissolvableLiner: true };
    expect(generateMoldMeshes(rod, { ...lined, highFidelity: true }, wasm).totalTriangles).toBe(generateMoldMeshes(rod, lined, wasm).totalTriangles);
  });

  it('finds the same high points as the standard grid', () => {
    const plain = generateMoldMeshes(wedge, clamshell, wasm);
    const fine = generateMoldMeshes(wedge, { ...clamshell, highFidelity: true }, wasm);
    expect(fine.features!.vents.length).toBe(plain.features!.vents.length);
  });

  it('follows the scene High Fidelity switch unless highFidelity overrides it', () => {
    expect(moldOptionsFor({}, { simFidelity: undefined }).options.highFidelity).toBe(false);
    expect(moldOptionsFor({}, { simFidelity: 'standard' }).options.highFidelity).toBe(false);
    expect(moldOptionsFor({}, { simFidelity: 'print' }).options.highFidelity).toBe(true);
    expect(moldOptionsFor({ highFidelity: false }, { simFidelity: 'print' }).options.highFidelity).toBe(false);
    expect(moldOptionsFor({ highFidelity: true }, { simFidelity: 'standard' }).options.highFidelity).toBe(true);
  });
});

describe('open mold mouth', () => {
  it.each([[{ allowUndercuts: true }], [{ dissolvableLiner: true }]])('takes a pour into a ball: %j', (extra) => {
    const r = generateMoldMeshes(ball(40), { ...clamshell, moldType: 'open', ...extra }, wasm);
    expect(r.success, r.error).toBe(true);
    // A lined half is two solids that touch; each is measured on its own.
    const pieces = r.bottomHalf.liner ? [r.bottomHalf.liner.shell, r.bottomHalf.liner.liner] : [r.bottomHalf.triangles];
    const taken = pieces.reduce((sum, t) => sum + solidOf(t).slice(r.bottomHalf.partingZMm - 0.02).area(), 0);
    const free = r.moldWidthMm * r.moldDepthMm - taken;
    expect(2 * Math.sqrt(free / Math.PI)).toBeGreaterThanOrEqual(12);
  });
});

describe('which way a closed mold fills', () => {
  it('pours a slurry from the top unless asked, and a resin from the bottom', () => {
    // Bottom fill ran plaster and concrete through a runner under the cavity, where the aggregate settles.
    for (const m of ['plaster', 'concrete', 'jesmonite'] as const) {
      const r = generateMoldMeshes(slab(60), { ...clamshell, castMaterial: m, wallMarginMm: 25, baseThicknessMm: 10 }, wasm);
      expect(r.success, r.error).toBe(true);
      expect(r.features!.feed, m).toBe('top');
    }
    expect(generateMoldMeshes(slab(60), { ...clamshell, castMaterial: 'epoxy' }, wasm).features!.feed).toBe('bottom');
  });
});
