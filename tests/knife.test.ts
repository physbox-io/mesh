// The knife: seams across every face a plane crosses (MCP), and the patterns
// and seams a part keeps when it is cut into pieces. Real manifold wasm.

import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { cutAlongPlane, type PlaneCutResult } from '../src/utils/printSplit';
import { partSoups } from '../src/utils/printSplitClient';
import { carryAcrossCut, knifeSoups, seamsAcross } from '../src/utils/knife';
import { applySurfaceTextures, type SurfaceTexture } from '../src/utils/surfaceTexture';
import { decomposeNodeColliders } from '../src/utils/convexDecomposition';
import type { SceneGeom, SceneNode } from '../src/types/scene';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); }, 30_000);

const fluted = (seedAt: number[], seedNormal: number[]): SurfaceTexture => ({
  pattern: 'fluted', depthM: -0.0005, cellM: 0.001, borderM: 0, seedAt, seedNormal,
});

const body = (geom: Partial<SceneGeom>): SceneNode => ({
  id: 'part', name: 'part', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: 'part_geom', ...geom } as SceneGeom],
} as unknown as SceneNode);

function cut(node: SceneNode, at: number[], normal: number[]) {
  const r: PlaneCutResult = cutAlongPlane(wasm, knifeSoups(node).soups, at, normal);
  if (!r.ok) throw new Error(r.error);
  return { sections: r.sections, carried: carryAcrossCut(node, r.sections, at, normal) };
}

/** The patterns as they would be laid on a piece: what each covers. */
function laid(section: { positions: ArrayLike<number>; faces: ArrayLike<number> }, carried: ReturnType<typeof carryAcrossCut>[number]) {
  const out = applySurfaceTextures(Array.from(section.positions), Array.from(section.faces), carried.textures ?? [], { splits: carried.faceSplits });
  return out.regions;
}

describe('cutting a patterned part into pieces', () => {
  // 40 × 20 × 10 mm, its geom set off from the body's origin, so the frames are tested too.
  const box = body({ type: 'box', size: [0.02, 0.01, 0.005], pos: [0.01, 0, 0], textures: [
    fluted([0.015, 0.002, 0.005], [0, 0, 1]), // the top
    fluted([0.02, 0, 0], [1, 0, 0]), // the +x end (geom frame; 30 mm in the body's)
  ] });

  it('gives a pattern the cut ran through to both pieces, each over its own half', () => {
    const { sections, carried } = cut(box, [0.01, 0, 0], [1, 0, 0]);
    expect(sections).toHaveLength(2);
    for (let k = 0; k < 2; k++) {
      const regions = laid(sections[k], carried[k]);
      expect(regions.every((r) => r.applied)).toBe(true);
      const tops = regions.filter((r) => Math.abs(r.normal[2] - 1) < 1e-6);
      expect(tops).toHaveLength(1);
      expect(tops[0].areaM2).toBeCloseTo(0.02 * 0.02, 7);
    }
  });

  it('gives a pattern only to the piece its face is on', () => {
    const { sections, carried } = cut(box, [0.01, 0, 0], [1, 0, 0]);
    const ends = carried.map((c) => (c.textures ?? []).filter((t) => t.seedNormal?.[0] === 1).length);
    expect([...ends].sort()).toEqual([0, 1]);
    const k = ends.indexOf(1);
    // Its seed is on that piece: the end at x = 30 mm.
    expect(carried[k].textures!.find((t) => t.seedNormal?.[0] === 1)!.seedAt[0]).toBeCloseTo(0.03, 6);
    expect(laid(sections[k], carried[k]).every((r) => r.applied)).toBe(true);
  });

  it('keeps a seam and the patterns either side of it, on each piece', () => {
    const R = 0.03;
    const sphere = body({ type: 'sphere', size: [R],
      faceSplits: [{ at: [0, 0, 0], normal: [1, 0, 0], seeds: [[R, 0, 0]] }],
      textures: [fluted([R, 0, 0], [1, 0, 0]), fluted([-R, 0, 0], [-1, 0, 0])],
    });
    const { sections, carried } = cut(sphere, [0, 0, 0], [0, 0, 1]);
    expect(sections).toHaveLength(2);
    for (let k = 0; k < 2; k++) {
      expect(carried[k].faceSplits).toHaveLength(1);
      expect(carried[k].textures).toHaveLength(2);
      const regions = laid(sections[k], carried[k]);
      expect(regions.map((r) => r.applied)).toEqual([true, true]);
      // A quarter of the sphere each: the seam and the cut both bound them.
      for (const r of regions) expect(r.areaM2 / (Math.PI * R * R)).toBeGreaterThan(0.9);
    }
  });

  it('gives a plain part plain pieces', () => {
    const { carried } = cut(body({ type: 'box', size: [0.02, 0.01, 0.005] }), [0, 0, 0], [1, 0, 0]);
    expect(carried).toEqual([{}, {}]);
  });
});

describe('a seam over MCP, with no line drawn', () => {
  it('divides every face the plane crosses, and only those', () => {
    const box = body({ type: 'box', size: [0.02, 0.01, 0.005] });
    const seams = seamsAcross(box, new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0));
    expect(seams).toHaveLength(1);
    // Top, bottom, front and back: not the two ends.
    expect(seams[0].split.seeds).toHaveLength(4);
    const top = applySurfaceTextures(...surfaceOf(box), [fluted([0.01, 0, 0.005], [0, 0, 1])], { splits: [seams[0].split] });
    expect(top.regions[0].areaM2).toBeCloseTo(0.02 * 0.02, 7);
  });

  it('leaves none where the plane misses the part', () => {
    const box = body({ type: 'box', size: [0.02, 0.01, 0.005] });
    expect(seamsAcross(box, new THREE.Vector3(0.05, 0, 0), new THREE.Vector3(1, 0, 0))).toEqual([]);
  });
});

/*
  A knife piece used to collide as one convex shape filling its holes: the
  section's plane-cut "exact" pieces were installed as its colliders even when
  one was left concave (a curved bore cannot be cut exactly by planes), and
  being stamped as the decomposition they kept the general one from running.
*/
describe('a knife piece collides as what it is, holes and all', () => {
  /** A 40 x 40 x 20 mm block with a 16 mm bore along z, as a soup in metres. */
  function boredBlock(): Float64Array {
    const block = wasm.Manifold.cube([40, 40, 20], true);
    const bore = wasm.Manifold.cylinder(30, 8, 8, 48, true);
    const part = block.subtract(bore);
    const mesh = part.getMesh();
    const out: number[] = [];
    for (let t = 0; t < mesh.numTri * 3; t++) {
      const i = mesh.triVerts[t] * mesh.numProp;
      out.push(mesh.vertProperties[i] / 1000, mesh.vertProperties[i + 1] / 1000, mesh.vertProperties[i + 2] / 1000);
    }
    for (const m of [block, bore, part]) m.delete();
    return Float64Array.from(out);
  }
  /** Whether a point (metres) lies inside the hull of these points (metres). */
  function inHull(points: number[][], p: number[]): boolean {
    const mm = (q: number[]) => q.map((v) => v * 1000) as [number, number, number];
    const a = wasm.Manifold.hull(points.map(mm));
    const b = wasm.Manifold.hull([...points.map(mm), mm(p)]);
    try { return b.volume() - a.volume() < 1e-3; } finally { a.delete(); b.delete(); }
  }
  const pointsOf = (positions: ArrayLike<number>) => {
    const out: number[][] = [];
    for (let i = 0; i < positions.length; i += 3) out.push([positions[i], positions[i + 1], positions[i + 2]]);
    return out;
  };
  // Air: in the half bore of the +x piece, 4 mm off the axis.
  const inGroove = [0.004, 0, 0];

  it('installs no plane-cut pieces that fill the bore, and leaves the piece to be decomposed', async () => {
    // Cut along the bore's axis: each piece is a block with a half-round groove.
    const r = cutAlongPlane(wasm, [boredBlock()], [0, 0, 0], [1, 0, 0]);
    if (!r.ok) throw new Error(r.error);
    expect(r.sections).toHaveLength(2);
    const k = r.sections.findIndex((s) => s.positions[0] > -1e-9 && Array.from(s.positions).every((v, i) => i % 3 !== 0 || v > -1e-9));
    const section = r.sections[k];
    for (const piece of section.convexPieces) expect(inHull(pointsOf(piece.positions), inGroove)).toBe(false);

    // The piece as splitBodyForPrint makes it, through the general decomposition.
    const node: SceneNode = {
      id: 'piece', name: 'piece', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [{
        name: 'piece_mesh', type: 'mesh', size: [1], dynamic: true,
        renderVertices: Array.from(section.positions), faces: Array.from(section.faces),
        colliderVertices: Array.from(section.plainPositions), colliderFaces: Array.from(section.plainFaces),
      } as SceneGeom],
    } as unknown as SceneNode;
    const result = (await decomposeNodeColliders(node))!;
    expect(result.verdict.strategy).toBe('decompose');
    expect(result.geoms.length).toBeGreaterThan(1);
    for (const g of result.geoms) {
      // Collider vertices are Y-up about the piece's pos; back to the body's Z-up frame.
      const v = g.vertices!;
      const pts: number[][] = [];
      for (let i = 0; i < v.length; i += 3) pts.push([v[i] + g.pos![0], -v[i + 2] + g.pos![1], v[i + 1] + g.pos![2]]);
      expect(inHull(pts, inGroove)).toBe(false);
    }
  }, 60_000);
});

function surfaceOf(node: SceneNode): [number[], number[]] {
  const soup = partSoups(node).soups[0];
  return [Array.from(soup), Array.from({ length: soup.length / 3 }, (_, i) => i)];
}
