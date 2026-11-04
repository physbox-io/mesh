import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS, type MoldOptions, type MoldExportResult, type Triangle3D } from '../src/utils/moldExporter';
import { MIN_FUNNEL_WALL_MM, sprueNeckDiaMm } from '../src/utils/moldSprue';
import { loadManifold } from '../src/utils/sculptCut';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

// An epoxy pour into a lined gear sculpture sat in a 4 mm sprue and never went
// in: a bubble cannot rise up a tube that narrow, so neither air out nor resin
// in. The neck is now held to what the material passes, and the funnel is sunk
// into the lid as deep as the lid allows.

const ball: SceneGraph = {
  nodes: [{ id: 'b1', name: 'ball', type: 'body', pos: [0, 0, 0.03], geoms: [{ name: 'g', type: 'sphere', size: [0.025] } as SceneGeom], joints: [], children: [] }],
};

/** A 40 x 40 x 10 mm slab: parted in the middle, its lid holds 5 mm of it, so a funnel has little room. */
const slab: SceneGraph = {
  nodes: [{ id: 'b1', name: 'slab', type: 'body', pos: [0, 0, 0.005], geoms: [{ name: 'g', type: 'box', size: [0.02, 0.02, 0.005] } as SceneGeom], joints: [], children: [] }],
};

/** Hourglass: undercuts, so allowUndercuts takes the exact-CSG mold. */
const box = (name: string, half: number[], z: number): SceneGeom => ({ name, type: 'box', size: half, pos: [0, 0, z] }) as SceneGeom;
const hourglass: SceneGraph = {
  nodes: [{
    id: 'b1', name: 'hourglass', type: 'body', pos: [0, 0, 0],
    geoms: [box('foot', [0.02, 0.02, 0.0075], 0.0075), box('waist', [0.007, 0.007, 0.0085], 0.0225), box('head', [0.02, 0.02, 0.005], 0.036)],
    joints: [], children: [],
  }],
};

/** A thick block with a thin arm off one side, so the sprue lands well off the mold's centre. */
const lopsided: SceneGraph = {
  nodes: [{
    id: 'b1', name: 'lopsided', type: 'body', pos: [0, 0, 0.01],
    geoms: [box('block', [0.012, 0.012, 0.01], 0), { ...box('arm', [0.012, 0.003, 0.004], 0), pos: [0.022, 0.008, 0] } as SceneGeom],
    joints: [], children: [],
  }],
};

const OPTS: MoldOptions = {
  ...DEFAULT_MOLD_OPTIONS,
  moldType: 'clamshell',
  pullDirection: '+z',
  includeSprue: true,
  includeVents: false,
  sprueTopDiaMm: 16,
  sprueBottomDiaMm: 4,
  castMaterial: 'epoxy',
  // These are about the funnel sunk into the lid over the cavity.
  sprueFeed: 'top',
};

/** Where a vertical line at (x, y) crosses the soup, ascending. */
function crossings(tris: Triangle3D[], x: number, y: number): number[] {
  const out: number[] = [];
  for (const t of tris) {
    const [a, b, c] = [t.a, t.b, t.c];
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-12) continue;
    const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
    const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
    const l3 = 1 - l1 - l2;
    if (l1 < 0 || l2 < 0 || l3 < 0) continue;
    out.push(l1 * a[2] + l2 * b[2] + l3 * c[2]);
  }
  out.sort((p, q) => p - q);
  // A line through a shared edge meets both triangles.
  return out.filter((z, i) => i === 0 || z - out[i - 1] > 1e-6);
}

/** The lid's triangles, and the sprue's axis on the plate. */
function lidAndSprue(r: MoldExportResult) {
  expect(r.success, r.error).toBe(true);
  const lid = r.topHalf!;
  const cx = (lid.bounds.minX + lid.bounds.maxX) / 2;
  const cy = (lid.bounds.minY + lid.bounds.maxY) / 2;
  const s = r.features!.sprue!;
  return { tris: lid.triangles, x: cx + s.atMm[0], y: cy + s.atMm[1], sprue: s };
}

/** The lid is open right through within the neck, and void from the outer face up the funnel. */
function expectFunnelAndNeck(r: MoldExportResult) {
  const { tris, x, y, sprue } = lidAndSprue(r);
  const neckR = sprue.narrowDiaMm! / 2;
  const mouthR = sprue.diaMm / 2;
  for (const [dx, dy] of [[0, 0], [neckR - 0.5, 0], [0, -(neckR - 0.5)]]) {
    expect(crossings(tris, x + dx, y + dy)).toEqual([]);
  }
  if (sprue.depthMm! > 1) {
    // Halfway up the funnel's wall the column is void from the outer face (z = 0) to the wall.
    const d = neckR + (mouthR - neckR) / 2;
    const zs = crossings(tris, x + d, y);
    expect(zs[0]).toBeGreaterThan(sprue.depthMm! / 2 - 0.6);
  }
}

/** Everywhere round the funnel, at least the wall's thickness of mold between it and the cavity. */
function expectWallOverCavity(r: MoldExportResult) {
  const { tris, x, y, sprue } = lidAndSprue(r);
  const neckR = sprue.narrowDiaMm! / 2;
  for (let d = neckR + 0.3; d < sprue.diaMm / 2; d += 0.3) {
    for (const a of [0, Math.PI / 3, Math.PI, (3 * Math.PI) / 2]) {
      const zs = crossings(tris, x + d * Math.cos(a), y + d * Math.sin(a));
      // The funnel's wall, then the cavity's roof above it.
      expect(zs.length).toBeGreaterThanOrEqual(2);
      expect(zs[1] - zs[0]).toBeGreaterThan(MIN_FUNNEL_WALL_MM - 0.2);
    }
  }
}

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await loadManifold();
});

describe('pour sprue', () => {
  it("never makes the neck narrower than the cast material can pass", () => {
    expect(sprueNeckDiaMm(4, 'epoxy')).toBe(6);
    expect(sprueNeckDiaMm(4, 'plaster')).toBe(8);
    expect(sprueNeckDiaMm(10, 'epoxy')).toBe(10);
    const r = generateMoldMeshes(ball, OPTS);
    expect(r.features!.sprue!.narrowDiaMm).toBe(6);
    const plaster = generateMoldMeshes(ball, { ...OPTS, castMaterial: 'plaster' });
    expect(plaster.features!.sprue!.narrowDiaMm).toBe(8);
  });

  it('sinks the funnel as deep as the floor allows and opens the neck into the cavity', () => {
    const r = generateMoldMeshes(ball, OPTS);
    const s = r.features!.sprue!;
    // The 5 mm floor is thinnest beside the neck, where the ball's top nearly
    // reaches it: the funnel stops the wall short of that, at 45°.
    expect(s.depthMm).toBeGreaterThan(3.5);
    expect(Math.abs(s.diaMm - (s.narrowDiaMm! + 2 * s.depthMm!))).toBeLessThan(0.15);
    expectFunnelAndNeck(r);
    expectWallOverCavity(r);
  });

  it(`shrinks the funnel on a thin lid, leaving ${MIN_FUNNEL_WALL_MM} mm over the cavity`, () => {
    const r = generateMoldMeshes(slab, { ...OPTS, baseThicknessMm: 3 });
    const { sprue } = lidAndSprue(r);
    // The lid's floor over the slab is 3 mm, so the funnel goes 1.5 mm in.
    expect(sprue.depthMm).toBeCloseTo(3 - MIN_FUNNEL_WALL_MM, 1);
    expect(Math.abs(sprue.diaMm - (sprue.narrowDiaMm! + 2 * sprue.depthMm!))).toBeLessThan(0.15);
    expectWallOverCavity(r);
  });

  it('cuts the same sprue in the exact (undercut-keeping) mold', () => {
    const r = generateMoldMeshes(hourglass, { ...OPTS, allowUndercuts: true }, wasm);
    expect(r.features!.sprue!.narrowDiaMm).toBe(6);
    expectFunnelAndNeck(r);
  });

  it('cuts it through shell and liner alike in a lined mold', () => {
    const r = generateMoldMeshes(ball, { ...OPTS, dissolvableLiner: true, linerPair: 'abs_hips' }, wasm);
    expectFunnelAndNeck(r);
    // Neither material alone closes the neck.
    const { x, y } = lidAndSprue(r);
    expect(crossings(r.topHalf!.liner!.liner, x, y)).toEqual([]);
    expect(crossings(r.topHalf!.liner!.shell, x, y)).toEqual([]);
  });

  it('cuts an off-centre sprue through a lined lid', () => {
    // The gear sculpture's lined lid lost its sprue when the funnel was a cone
    // added to a cylinder; at the centre of a ball it never showed.
    const r = generateMoldMeshes(lopsided, { ...OPTS, dissolvableLiner: true, linerPair: 'abs_hips' }, wasm);
    expect(Math.hypot(...r.features!.sprue!.atMm)).toBeGreaterThan(3);
    expectFunnelAndNeck(r);
    const rigid = generateMoldMeshes(lopsided, OPTS);
    expectFunnelAndNeck(rigid);
  });
});
