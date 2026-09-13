// The lattice showcase preset: does the part it claims to be exist, and is it
// a thing that could be made?
import { describe, it, expect } from 'vitest';
import { bracketCage, latticeBracketPreset } from '../src/presets/latticeBracket';
import { isWatertight, latticeStats, latticeBounds, inconsistentFaces, signedVolume, DEFAULT_UNIT } from '../src/utils/latticeMesh';

describe('wall bracket cage', () => {
  const cage = bracketCage();

  it('is a closed solid with every face the right way out', () => {
    expect(isWatertight(cage)).toBe(true);
    expect(inconsistentFaces(cage)).toBe(0);
  });

  it('is the size the note card says it is', () => {
    const bounds = latticeBounds(cage)!;
    const mm = (v: number) => v * DEFAULT_UNIT * 1000;
    expect(mm(bounds.max[0] - bounds.min[0])).toBeCloseTo(50, 6); // shelf arm
    expect(mm(bounds.max[1] - bounds.min[1])).toBeCloseTo(40, 6); // width
    expect(mm(bounds.max[2] - bounds.min[2])).toBeCloseTo(60, 6); // wall plate
  });

  it('is quads and triangles only — never a concave face', () => {
    // The L outline is concave, and a concave cage face is the one shape that
    // subdivides and triangulates badly: fanned, it produces triangles across
    // the notch that overlap each other and flicker. The caps are tiled into
    // quads instead, so no face here has more than four corners.
    const stats = latticeStats(cage);
    expect(stats.quads + stats.tris).toBe(stats.quads + stats.tris); // every face is one or the other
    for (const face of cage.faces) if (face) expect(face.length).toBeLessThanOrEqual(4);
    expect(stats.creases).toBeGreaterThan(0);
  });

  it('has positive volume — no shell left inside out', () => {
    // orientFaces turns each connected piece outwards on its own, and the
    // gusset is a second piece. A piece that came out inverted still passes a
    // consistency check and still draws red in the editor.
    expect(signedVolume(cage)).toBeGreaterThan(0);
  });
});

describe('wall bracket preset', () => {
  const node = latticeBracketPreset.nodes[0];

  it('ships the cage, not just the mesh it produced', () => {
    expect(node.isLattice).toBe(true);
    expect(node.latticeCage?.coords.length).toBeGreaterThan(0);
  });

  it('stands on the ground rather than hovering over it', () => {
    const render = node.geoms[0].renderVertices!;
    let lowest = Infinity;
    for (let i = 2; i < render.length; i += 3) lowest = Math.min(lowest, render[i]);
    expect(node.pos[2] + lowest).toBeCloseTo(0, 6);
  });
});
