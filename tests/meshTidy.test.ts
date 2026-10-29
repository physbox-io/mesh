// A SCAD bowl whose profile touches the axis, and a polyhedron listed the
// wrong way round, are both closed meshes. Neither was treated as one.
//
// `rotate_extrude() polygon([[0,0], ..., [0,t]])` — the usual way to write a
// cup — compiled to a mesh with 256 zero-area triangles on 64 segments, was
// reported `watertight: false`, refused for decomposition as having holes,
// and collided and was weighed as its hull. A CCW `polyhedron` was reported
// inside out and refused with the message for a mesh wound both ways.
//
// OpenSCAD itself is a browser worker, so this builds what it writes to STL:
// one vertex per segment at each point on the axis.

import { describe, expect, it } from 'vitest';
import { indexScadTriangles } from '../src/utils/scadMesh';
import { tidyMesh } from '../src/utils/meshTidy';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { boredCup, latheSoup, flipMesh, zupToYupFlat, type MeshData } from './helpers/meshes';
import type { SceneNode } from '../src/types/scene';

// A cup 60 mm across and 40 mm tall with 3 mm walls, profile reaching the axis
// at the bottom of its base and the top of its floor.
const CUP: [number, number][] = [[0, 0], [0.03, 0], [0.03, 0.04], [0.027, 0.04], [0.027, 0.003], [0, 0.003]];
const TRUE_VOLUME = Math.PI * (0.03 ** 2 * 0.04 - 0.027 ** 2 * 0.037);

const node = (m: MeshData): SceneNode => ({
  id: 'bowl', name: 'bowl', type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: 'bowl_m', type: 'mesh', size: [1], dynamic: true, renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces }],
});

/** The store's Z-up mesh out of a SCAD compile. */
const compiled = (soup: number[]): MeshData => {
  const c = indexScadTriangles(soup);
  return { verts: c.renderVertices, faces: c.faces };
};

/** The same mesh before this fix: welded, nothing dropped. */
const weldedOnly = (soup: number[]): MeshData => {
  const verts: number[] = [], faces: number[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < soup.length; i += 3) {
    const key = soup.slice(i, i + 3).map(v => Math.round(v * 1e5)).join(',');
    let id = seen.get(key);
    if (id === undefined) { id = verts.length / 3; seen.set(key, id); verts.push(soup[i], soup[i + 1], soup[i + 2]); }
    faces.push(id);
  }
  return { verts, faces };
};

describe('a lathed profile that touches the axis', () => {
  const soup = latheSoup(CUP, 64);

  it('welds to 256 zero-area triangles, which is what made it read as open', () => {
    const before = analyzeMesh(weldedOnly(soup).verts, weldedOnly(soup).faces)!;
    expect(before.degenerateTriangles).toBe(256);
    expect(before.closed).toBe(false);
    // Every edge the real triangles use is still used twice, once each way.
    expect(before.boundaryEdges).toBe(0);
    expect(before.consistentlyWound).toBe(true);
  });

  it('compiles to a closed, outward mesh once they are dropped', () => {
    const m = compiled(soup);
    const after = analyzeMesh(m.verts, m.faces)!;
    expect(after.closed).toBe(true);
    expect(after.degenerateTriangles).toBe(0);
    expect(after.volume).toBeGreaterThan(0);
    expect(after.volume / TRUE_VOLUME).toBeGreaterThan(0.98);
  });

  it('is decomposed and weighed by what is there, even saved before the compile tidied it', async () => {
    const r = (await decomposeNodeColliders(node(weldedOnly(soup))))!;
    expect(r.warning ?? '').not.toMatch(/holes/);
    expect(r.geoms.length).toBeGreaterThan(1);
    // 1000 kg/m³ of the true volume: about 0.03 kg, not the 0.11 kg of its hull.
    expect(r.mass).toBeCloseTo(1000 * TRUE_VOLUME, 2);
  }, 60_000);
});

describe('a closed mesh wound inward throughout', () => {
  const cup = boredCup();

  it('is turned the right way out by the compile', () => {
    const inverted = flipMesh(cup);
    const soup: number[] = [];
    for (const f of inverted.faces) soup.push(inverted.verts[f * 3], inverted.verts[f * 3 + 1], inverted.verts[f * 3 + 2]);
    const m = compiled(soup);
    expect(analyzeMesh(m.verts, m.faces)!.volume).toBeGreaterThan(0);
  });

  it('is decomposed rather than refused as wound both ways', async () => {
    const r = (await decomposeNodeColliders(node(flipMesh(cup))))!;
    expect(r.warning ?? '').not.toMatch(/both ways/);
    expect(r.verdict.strategy).toBe('decompose');
    expect(r.geoms.length).toBeGreaterThan(1);
  }, 60_000);

  it('a mesh really wound both ways still gets the both-ways sentence', async () => {
    const mixed = { verts: cup.verts, faces: cup.faces.slice() };
    // Turn over one half of the triangles.
    for (let i = 0; i < mixed.faces.length / 2; i += 3) [mixed.faces[i + 1], mixed.faces[i + 2]] = [mixed.faces[i + 2], mixed.faces[i + 1]];
    const t = tidyMesh(mixed.verts, mixed.faces);
    expect(t.flipped).toBe(false);
    const r = (await decomposeNodeColliders({ ...node(mixed), collision: 'decompose' }))!;
    expect(r.warning).toMatch(/both ways/);
    expect(r.geoms).toEqual([]);
  }, 60_000);
});
