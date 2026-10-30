// A boolean body's collision goes through the same decomposition as any other
// mesh body (utils/convexDecomposition.ts): exact cuts along flat inside
// corners, chunked V-HACD, pieces pulled in to the surface, and the body's
// Collision Detail settings.
//
// It used to have a path of its own: one V-HACD call over the whole part,
// none of the rest, and a hash that did not include collisionHulls or
// collisionResolution, so the detail setting never rebuilt anything. A
// sliding-lid box built as a boolean overlapped its lid by millimetres in the
// lid's groove, and the lid was thrown out at the first step.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { csgHashOf, evaluateNodeCsg, resolveCsgGeoms } from '../src/utils/csg';
import { simulate } from './helpers/simulate';
import type { SceneGeom, SceneNode } from '../src/types/scene';

vi.mock('../src/utils/openscad', () => ({
  compileSCAD: vi.fn(),
  setScadCompileListener: vi.fn(),
}));

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); }, 30_000);

/*
  The box, in mm: 60 x 40 x 30 outside, 3 mm walls and floor, open at the top,
  with a 2 mm groove for the lid 3 mm below the rim, running out through the
  +x end so the lid slides in from there.
*/
const OUTER = { min: [-30, -20, 0], max: [30, 20, 30] };
const CAVITY = { min: [-27, -17, 3], max: [27, 17, 31] };
const GROOVE = { min: [-28.5, -18.5, 25], max: [31, 18.5, 27] };
// The lid, 0.25 mm clear of the groove all round (and 1.6 mm thick).
const LID = { min: [-28.25, -18.25, 25.2], max: [30, 18.25, 26.8] };

type Box = { min: number[]; max: number[] };
const cube = (b: Box) => wasm.Manifold.cube([b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]).translate(b.min as [number, number, number]);

/** The box as openscad.compileSCAD would hand it back: metres, Z-up and Y-up. */
function compiledBox() {
  const outer = cube(OUTER), cavity = cube(CAVITY), groove = cube(GROOVE);
  const part = outer.subtract(cavity).subtract(groove);
  const mesh = part.getMesh();
  const renderVertices: number[] = [];
  for (let i = 0; i < mesh.numVert; i++) {
    const o = i * mesh.numProp;
    renderVertices.push(mesh.vertProperties[o] / 1000, mesh.vertProperties[o + 1] / 1000, mesh.vertProperties[o + 2] / 1000);
  }
  const vertices: number[] = [];
  for (let i = 0; i < renderVertices.length; i += 3) vertices.push(renderVertices[i], renderVertices[i + 2], -renderVertices[i + 1]);
  for (const m of [outer, cavity, groove, part]) m.delete();
  return { vertices, renderVertices, faces: Array.from(mesh.triVerts) };
}

const half = (b: Box) => b.max.map((v, k) => (v - b.min[k]) / 2000);
const centre = (b: Box) => b.max.map((v, k) => (v + b.min[k]) / 2000);

const boxNode = (extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'box', name: 'box', type: 'body', pos: [0, 0, 0], joints: [], children: [],
  csgEnabled: true,
  geoms: [
    { name: 'shell', type: 'box', size: half(OUTER), pos: centre(OUTER) },
    { name: 'cavity', type: 'box', size: half(CAVITY), pos: centre(CAVITY), csg: 'difference' },
    { name: 'groove', type: 'box', size: half(GROOVE), pos: centre(GROOVE), csg: 'difference' },
  ] as SceneGeom[],
  ...extra,
});

/** How far (mm) the lid is inside the box's colliders: the deepest overlap of any piece's hull with it. */
function lidOverlapMm(colliders: SceneGeom[]): number {
  const lid = cube(LID);
  let worst = 0;
  for (const g of colliders) {
    // Collider vertices are Y-up about the piece's pos; back to the body's Z-up frame, in mm.
    const v = g.vertices!;
    const pts: [number, number, number][] = [];
    for (let i = 0; i < v.length; i += 3) {
      pts.push([(v[i] + g.pos![0]) * 1000, (-v[i + 2] + g.pos![1]) * 1000, (v[i + 1] + g.pos![2]) * 1000]);
    }
    const hull = wasm.Manifold.hull(pts);
    const both = hull.intersect(lid);
    if (!both.isEmpty()) {
      const bb = both.boundingBox();
      worst = Math.max(worst, Math.min(...[0, 1, 2].map((k) => bb.max[k] - bb.min[k])));
    }
    hull.delete(); both.delete();
  }
  lid.delete();
  return worst;
}

async function compile(node: SceneNode) {
  const openscad = await import('../src/utils/openscad');
  vi.mocked(openscad.compileSCAD).mockResolvedValueOnce(compiledBox());
  const res = (await evaluateNodeCsg(node))!;
  return { res, physics: resolveCsgGeoms({ ...node, geoms: [...node.geoms!, ...res.geoms] }, 'physics') };
}

describe('a sliding-lid box made as a boolean', () => {
  it('collides as pieces that leave the lid its groove', async () => {
    const { res, physics } = await compile(boxNode());
    expect(res.mode).toBe('decompose');
    const colliders = physics.filter((g) => g.csgDerived === 'collider');
    expect(colliders.length).toBeGreaterThanOrEqual(2);
    expect(lidOverlapMm(colliders)).toBeLessThan(0.1);

    // And in MuJoCo: the lid stays in its groove rather than being thrown out.
    const box = { ...boxNode(), geoms: [...boxNode().geoms!, ...res.geoms], csgHash: res.hash };
    const lid: SceneNode = {
      id: 'lid', name: 'lid', type: 'body', pos: centre(LID) as [number, number, number],
      joints: [{ name: 'lid_free', type: 'free' }], children: [],
      geoms: [{ name: 'lid_geom', type: 'box', size: half(LID), density: 1200 }],
    } as SceneNode;
    const sim = await simulate({ nodes: [box, lid] } as never);
    try {
      sim.run(0.3);
      const [x, y, z] = sim.bodyPos('lid');
      const [x0, y0, z0] = centre(LID);
      // It drops the 0.2 mm onto the groove floor (0.84 mm, pushed up and out, before).
      expect(Math.hypot(x - x0, y - y0, z - z0) * 1000).toBeLessThan(0.4);
    } finally {
      sim.dispose();
    }
  }, 120_000);

  it('rebuilds when the collision detail changes', () => {
    const h = csgHashOf(boxNode());
    expect(csgHashOf(boxNode({ collisionResolution: 400_000 }))).not.toBe(h);
    expect(csgHashOf(boxNode({ collisionHulls: 32 }))).not.toBe(h);
  });
});
