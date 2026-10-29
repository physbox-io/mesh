// The real decomposer, on real shapes.
//
// tests/convexDecomposition.test.ts covers the decision and the arithmetic with
// no wasm; this one covers the part only V-HACD can answer: given a cup, does it
// actually find the cavity? The vendored build embeds its binary as a data URL,
// so it instantiates under plain Node and this needs no Worker and no browser.
//
// The assertions are deliberately loose on hull COUNT and tight on what the
// hulls enclose. V-HACD is an approximation and its partitioning is its own
// business; what must hold is that the inside of a cup stays outside the solid.

import { describe, it, expect, beforeAll } from 'vitest';
import { decomposeMesh, DEFAULT_DECOMPOSE_PARAMS } from '../src/utils/vhacd';
import { convexHullOf, meshVolumeAndCentroid, isDegenerateCollider } from '../src/utils/csg';
import { collidersAreStale, decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { boxMesh, cupMesh, openTopBoxMesh, sphereMesh } from './helpers/meshes';
import type { SceneNode } from '../src/types/scene';

const planesOf = (h: { verts: number[]; faces: number[] }) => {
  const planes: Array<[number, number, number, number]> = [];
  for (let i = 0; i < h.faces.length; i += 3) {
    const p = (k: number) => [h.verts[k * 3], h.verts[k * 3 + 1], h.verts[k * 3 + 2]];
    const [ax, ay, az] = p(h.faces[i]);
    const [bx, by, bz] = p(h.faces[i + 1]);
    const [cx, cy, cz] = p(h.faces[i + 2]);
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    planes.push([nx, ny, nz, -(nx * ax + ny * ay + nz * az)]);
  }
  return planes;
};

/** Inside a convex hull, with a tolerance in metres. */
const inside = (planes: Array<[number, number, number, number]>, p: number[], tol = 0) =>
  planes.length > 0 && planes.every(([a, b, c, d]) => a * p[0] + b * p[1] + c * p[2] + d <= tol);

const insideAny = (hulls: Array<{ verts: number[]; faces: number[] }>, p: number[], tol = 0) =>
  hulls.some(h => inside(planesOf(h), p, tol));

describe('decomposing a cup', () => {
  const cup = cupMesh({ outerR: 0.10, innerR: 0.08, height: 0.12, baseThickness: 0.02 });
  // Decomposed once and shared: a run is a couple of seconds, and every
  // assertion below is about the same set of pieces.
  let hulls: Awaited<ReturnType<typeof decomposeMesh>>;
  beforeAll(async () => { hulls = await decomposeMesh(cup.verts, cup.faces); });

  it('finds the cavity: the middle of the cup is outside every piece', () => {
    expect(hulls.length).toBeGreaterThan(1);
    // A point in the air well inside the cup, halfway up.
    expect(insideAny(hulls, [0, 0, 0.08])).toBe(false);
    // And the walls and the base are still there.
    expect(insideAny(hulls, [0.09, 0, 0.08], 2e-3)).toBe(true);
    expect(insideAny(hulls, [0, 0, 0.01], 2e-3)).toBe(true);
  });

  it('recovers most of the real volume, not the hull’s', () => {
    const { volume: trueVolume } = meshVolumeAndCentroid(cup.verts, cup.faces);
    const pts: number[][] = [];
    for (let i = 0; i < cup.verts.length; i += 3) pts.push([cup.verts[i], cup.verts[i + 1], cup.verts[i + 2]]);
    const hullVolume = convexHullOf(pts)!.volume;

    const sum = hulls.reduce((s, h) => s + h.volume, 0);
    // Near the truth, and nowhere near the solid billet MuJoCo would otherwise
    // collide. That gap is the bug this feature removes. The overshoot is the
    // hulls bulging slightly into the cavity — see the table in utils/vhacd.ts.
    expect(sum).toBeGreaterThan(trueVolume * 0.75);
    expect(sum).toBeLessThan(trueVolume * 1.5);
    expect(sum).toBeLessThan(hullVolume * 0.7);
  });

  it('never emits a hull too thin for MuJoCo to hull safely', () => {
    // A sliver aborts qhull inside MuJoCo and takes the wasm heap with it, so
    // decomposeMesh filters them itself rather than trusting its caller.
    expect(hulls.some(isDegenerateCollider)).toBe(false);
    expect(hulls.every(h => h.volume > 0)).toBe(true);
  });

  it('respects the hull budget', async () => {
    const few = await decomposeMesh(cup.verts, cup.faces, { maxHulls: 4 });
    expect(few.length).toBeLessThanOrEqual(4);
  });
});

describe('decomposing an open-top box', () => {
  it('leaves the cavity empty', async () => {
    const box = openTopBoxMesh({ outer: 0.1, wall: 0.02, height: 0.12 });
    const hulls = await decomposeMesh(box.verts, box.faces);
    expect(hulls.length).toBeGreaterThan(1);
    expect(insideAny(hulls, [0, 0, 0.08])).toBe(false);
  });
});

describe('decomposing something already convex', () => {
  it('gives a box back as essentially itself', async () => {
    // Nothing here should ever reach V-HACD — decompositionVerdict sends a box
    // to 'hull' long before this — but if it does, the answer must be sane.
    const box = boxMesh([0, 0, 0], [0.1, 0.1, 0.1]);
    const hulls = await decomposeMesh(box.verts, box.faces);
    const sum = hulls.reduce((s, h) => s + h.volume, 0);
    expect(sum).toBeGreaterThan(0.008 * 0.75);
    expect(insideAny(hulls, [0, 0, 0], 2e-3)).toBe(true);
  });
});

describe('degenerate input', () => {
  it('returns nothing rather than throwing', async () => {
    expect(await decomposeMesh([], [])).toEqual([]);
    expect(await decomposeMesh([0, 0, 0], [])).toEqual([]);
  });
});

describe('the pinned parameters', () => {
  it('fills from outside, so an open cavity survives and a sealed one does not', () => {
    // This is the one parameter with meaning rather than a number: see the note
    // in utils/vhacd.ts. Pinned because changing it silently changes every
    // decomposed body in every saved scene.
    expect(DEFAULT_DECOMPOSE_PARAMS.fillMode).toBe('flood');
  });
});

// ---------------------------------------------------------------------------
// The producer: a scene node in, colliders (or a reasoned refusal) out.
// ---------------------------------------------------------------------------

describe('decomposeNodeColliders', () => {
  const meshNode = (m: { verts: number[]; faces: number[] }, extra: Partial<SceneNode> = {}): SceneNode => ({
    id: 'n', name: 'n', type: 'body', pos: [0, 0, 0], joints: [], children: [],
    geoms: [{ name: 'n_mesh', type: 'mesh', size: [1], renderVertices: m.verts, faces: m.faces }],
    ...extra,
  });

  it('decomposes a cup and leaves it stable afterwards', async () => {
    const node = meshNode(cupMesh());
    expect(collidersAreStale(node)).toBe(true);

    const result = (await decomposeNodeColliders(node))!;
    expect(result.verdict.strategy).toBe('decompose');
    expect(result.geoms.length).toBeGreaterThan(1);
    expect(result.geoms.every(g => g.csgDerived === 'collider')).toBe(true);
    expect(result.geoms.reduce((s, g) => s + (g.mass ?? 0), 0)).toBeCloseTo(result.mass, 8);

    // Installing the result the way the store does must settle it, or the
    // compile pass would decompose the same body on every store update.
    node.geoms = [...node.geoms!, ...result.geoms];
    node.collisionHash = result.hash;
    node.collisionDecomposed = true;
    expect(collidersAreStale(node)).toBe(false);
  });

  it('says so when a hollow body stops being weighed as a solid lump', async () => {
    const result = (await decomposeNodeColliders(meshNode(cupMesh())))!;
    // Water density over the TRUE volume, not the hull's — a real change to how
    // the body behaves, so it is not made silently.
    expect(result.warning).toMatch(/weighs .* rather than/);
    expect(result.mass).toBeLessThan(1000 * result.hullVolume);
    expect(result.mass).toBeCloseTo(1000 * result.volume, 5);
  });

  it('keeps quiet when the mass was given explicitly', async () => {
    const result = (await decomposeNodeColliders(meshNode(cupMesh(), { collisionMass: 0.5 })))!;
    expect(result.mass).toBe(0.5);
    expect(result.warning).toBeUndefined();
  });

  it('refuses a mesh with holes in it, and explains why', async () => {
    // Flood fill leaks through a gap, so "inside" stops meaning anything. A
    // hull and a sentence beats confident nonsense.
    const open = cupMesh();
    const result = (await decomposeNodeColliders(
      meshNode({ verts: open.verts, faces: open.faces.slice(0, open.faces.length - 30) }),
    ))!;
    expect(result.geoms).toEqual([]);
    expect(result.verdict.strategy).toBe('hull');
    expect(result.warning).toMatch(/holes in it/);
  });

  it('stamps a hash even when it decides not to decompose, so it is asked once', async () => {
    const result = (await decomposeNodeColliders(meshNode(sphereMesh())))!;
    expect(result.geoms).toEqual([]);
    expect(result.verdict.strategy).toBe('hull');
    expect(result.hash).not.toBe('');
  });

  it('has nothing to say about a body of primitives', async () => {
    const node: SceneNode = {
      id: 'p', name: 'p', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [{ name: 'p_box', type: 'box', size: [0.1, 0.1, 0.1] }],
    };
    expect(await decomposeNodeColliders(node)).toBeNull();
  });
});
