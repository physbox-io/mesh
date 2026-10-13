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

function surfaceOf(node: SceneNode): [number[], number[]] {
  const soup = partSoups(node).soups[0];
  return [Array.from(soup), Array.from({ length: soup.length / 3 }, (_, i) => i)];
}
