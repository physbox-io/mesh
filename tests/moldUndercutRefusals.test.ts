import { describe, it, expect } from 'vitest';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS, type MoldOptions } from '../src/utils/moldExporter';
import { loadManifold } from '../src/utils/sculptCut';
import type { SceneGraph, SceneNode } from '../src/types/scene';

// A mold that keeps undercuts cuts the exact part out of the block. When that
// cannot be done it must say so, not hand back a depth-field mold with the
// undercuts filled in, or a mold missing a body, under the warnings of the
// mold that was asked for.

/** A mesh body from Z-up corners, written Y-up as mesh vertices are: (x, z, -y). */
function meshBody(name: string, corners: number[][], faces: number[]): SceneNode {
  const v: number[] = [];
  for (const [x, y, z] of corners) v.push(x, z, -y);
  return {
    id: name, name, type: 'body', pos: [0, 0, 0], joints: [], children: [],
    geoms: [{ name: 'g', type: 'mesh', size: [1, 1, 1], vertices: v, faces }],
  } as SceneNode;
}

/** An upright tube, 108 mm across with a 4 mm wall and 111 mm tall; opened side to side, its bore is an undercut. */
function tube(ro = 0.054, ri = 0.05, h = 0.111, n = 96): SceneNode {
  const c: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, co = Math.cos(a), s = Math.sin(a);
    c.push([ro * co, ro * s, 0], [ro * co, ro * s, h], [ri * co, ri * s, 0], [ri * co, ri * s, h]);
  }
  const f: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = 4 * i, b = 4 * ((i + 1) % n);
    f.push(a, b, b + 1, a, b + 1, a + 1);
    f.push(a + 2, b + 3, b + 2, a + 2, a + 3, b + 3);
    f.push(a + 1, b + 1, b + 3, a + 1, b + 3, a + 3);
    f.push(a, b + 2, b, a, a + 2, b + 2);
  }
  return meshBody('tube', c, f);
}

/**
 * Two open triangles that touch at one corner, 30 mm apart in height: no
 * repair makes a solid of it, and seen from above most of it stands clear of
 * the parting plane, so a flat-parted mold would fill under it.
 */
function pinchedSheet(name = 'sheet', dx = 0): SceneNode {
  const m = 0.001;
  return meshBody(name, [
    [dx, 0, 0], [dx + 40 * m, 0, 0], [dx, 40 * m, 0],
    [dx - 40 * m, 0, 30 * m], [dx, -40 * m, 30 * m],
  ], [0, 1, 2, 0, 3, 4]);
}

/**
 * A 20 mm cube beside the tube with one corner not a number, as a bad import
 * leaves it: the mold sampler steps over that corner's triangles, but nothing
 * makes the cube a solid.
 */
function brokenCube(name = 'block', dx = 0.09): SceneNode {
  const s = 0.02, c: number[][] = [];
  for (let i = 0; i < 8; i++) c.push([dx + (i & 1 ? s : 0), (i & 2 ? s : 0), (i & 4 ? s : 0)]);
  c[7][2] = NaN;
  const q = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
  return meshBody(name, c, q.flatMap(([a, b, cc, d]) => [a, b, cc, a, cc, d]));
}

const scene = (...nodes: SceneNode[]) => ({ nodes } as SceneGraph);
const mold = (s: SceneGraph, o: Partial<MoldOptions>, wasm: Awaited<ReturnType<typeof loadManifold>> | null) =>
  generateMoldMeshes(s, { ...DEFAULT_MOLD_OPTIONS, moldType: 'auto', ...o }, wasm);

describe('undercut-keeping and lined molds refuse what they cannot build', () => {
  it('keeping undercuts with no geometry engine is refused, not filled in', () => {
    const r = mold(scene(tube()), { allowUndercuts: true, pullDirection: '+x' }, null);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/geometry engine/);
  });

  it('keeping undercuts on a part that is no solid is refused, not filled in under a "kept" warning', async () => {
    const r = mold(scene(pinchedSheet()), { allowUndercuts: true, moldType: 'clamshell', pullDirection: '+z' }, await loadManifold());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/could not be made into a solid/);
    expect(r.warnings.join(' ')).not.toMatch(/kept in the cavity/);
  }, 60000);

  it('an undercut-keeping mold names a body it cannot make solid rather than leaving it out', async () => {
    const r = mold(scene(tube(), brokenCube()), { allowUndercuts: true, pullDirection: '+x' }, await loadManifold());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^block is not a closed solid/);
  }, 120000);

  it('a lined mold names a body it cannot make solid rather than casting PVA into its space', async () => {
    const r = mold(scene(tube(), brokenCube()), { dissolvableLiner: true }, await loadManifold());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^block is not a closed solid/);
  }, 120000);

  it('with nothing to keep, no engine is still fine: the depth-field mold needs none', () => {
    const r = mold(scene(tube()), { allowUndercuts: true, pullDirection: '+z' }, null);
    expect(r.success).toBe(true);
  });
});
