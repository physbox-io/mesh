import { describe, it, expect } from 'vitest';
import { generateMoldMeshes, DEFAULT_MOLD_OPTIONS, type MoldOptions, type Triangle3D } from '../src/utils/moldExporter';
import { loadManifold } from '../src/utils/sculptCut';
import type { SceneGraph } from '../src/types/scene';

/** An upright tube, 108 mm across with a 4 mm wall and 111 mm tall: the clear epoxy shell a candle stands in. */
function tubeScene(ro = 0.054, ri = 0.05, h = 0.111, n = 160): SceneGraph {
  const v: number[] = [];
  // Z-up corners, written Y-up as mesh vertices are: (x, z, -y).
  const push = (x: number, y: number, z: number) => v.push(x, z, -y);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n, c = Math.cos(a), s = Math.sin(a);
    push(ro * c, ro * s, 0); push(ro * c, ro * s, h); push(ri * c, ri * s, 0); push(ri * c, ri * s, h);
  }
  const f: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = 4 * i, b = 4 * ((i + 1) % n);
    f.push(a, b, b + 1, a, b + 1, a + 1); // outside, facing out
    f.push(a + 2, b + 3, b + 2, a + 2, a + 3, b + 3); // inside, facing the axis
    f.push(a + 1, b + 1, b + 3, a + 1, b + 3, a + 3); // top
    f.push(a, b + 2, b, a, a + 2, b + 2); // bottom
  }
  return {
    nodes: [{
      id: 'shell', name: 'shell', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [{ name: 'g', type: 'mesh', size: [1, 1, 1], vertices: v, faces: f }],
    }],
  } as SceneGraph;
}

function volume(tris: Triangle3D[]): number {
  let s = 0;
  for (const { a, b, c } of tris) {
    s += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  }
  return s / 6;
}

// A 1 degree wedge on both walls of the slot, all the way round: 0.5 x 111 x 111 tan(1) mm² a side, over both circumferences.
const WEDGE_MM3 = 0.5 * 111 * 111 * Math.tan(Math.PI / 180) * 2 * Math.PI * (50 + 54);

describe('mold draft', () => {
  const scene = tubeScene();
  const mold = async (o: Partial<MoldOptions>) => {
    const r = generateMoldMeshes(scene, { ...DEFAULT_MOLD_OPTIONS, moldType: 'auto', ...o }, await loadManifold());
    expect(r.success).toBe(true);
    return { r, mm3: volume(r.combinedTriangles) };
  };

  it('a lined mold carries the draft it is given, in every direction', async () => {
    const straight = (await mold({ dissolvableLiner: true, draftAngleDeg: 0 })).mm3;
    const removed = (await mold({ dissolvableLiner: true, draftAngleDeg: 1 })).mm3;
    const added = await mold({ dissolvableLiner: true, draftAngleDeg: 1, draftMode: 'add' });
    const centred = (await mold({ dissolvableLiner: true, draftAngleDeg: 1, draftMode: 'centre' })).mm3;
    // Taken off the casting, the mold is bigger; put on, smaller, by about the wedges.
    expect(removed).toBeGreaterThan(straight + 0.5 * WEDGE_MM3);
    expect(straight - added.mm3).toBeGreaterThan(0.8 * WEDGE_MM3);
    expect(straight - added.mm3).toBeLessThan(1.2 * WEDGE_MM3);
    expect(centred).toBeGreaterThan(added.mm3);
    expect(centred).toBeLessThan(removed);
    expect(added.r.minDraftDeg).toBeGreaterThan(0.8);
  }, 120000);

  it('the depth-field mold leans its walls the way it is told', async () => {
    const straight = (await mold({ draftAngleDeg: 0 })).mm3;
    const removed = (await mold({ draftAngleDeg: 1 })).mm3;
    const added = (await mold({ draftAngleDeg: 1, draftMode: 'add' })).mm3;
    expect(removed).toBeGreaterThan(straight + 0.5 * WEDGE_MM3);
    expect(straight - added).toBeGreaterThan(0.8 * WEDGE_MM3);
    expect(straight - added).toBeLessThan(1.2 * WEDGE_MM3);
  }, 120000);

  it('the undercut-keeping mold, which cuts the exact part, tapers it too', async () => {
    // Opened side to side, the tube's bore is an undercut, kept.
    const o = { allowUndercuts: true, pullDirection: '+x' as const };
    const straight = (await mold({ ...o, draftAngleDeg: 0 })).mm3;
    const added = (await mold({ ...o, draftAngleDeg: 1, draftMode: 'add' })).mm3;
    const removed = (await mold({ ...o, draftAngleDeg: 1 })).mm3;
    expect(added).toBeLessThan(straight - 1000);
    expect(removed).toBeGreaterThan(straight + 1000);
  }, 120000);

  it('a draft that grows out through the side wall is said', async () => {
    const { r } = await mold({ draftAngleDeg: 8, draftMode: 'add', wallMarginMm: 6 });
    expect(r.warnings.join(' ')).toMatch(/side wall/);
  }, 120000);
});
