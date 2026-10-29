// Concave contact that has to work in MuJoCo, not just look right: a marble
// rolling down a coiled chute, a ball in a close-fitting bore, dice inside a
// closed drum. Each failed before the mesh was cut into chunks and its pieces
// pulled in to the surface (utils/solidDecomposition.ts):
//
// * The two-turn chute read as compact from its bounding box, got 64 pieces,
//   and 29 to 42 of them filled its channel. At 384 pieces the floor was still
//   stepped and 6 mm marbles stopped dead on its 11° slope.
// * A 10 mm blind bore cleared 8.35 mm in its 12 pieces; balls with 0.5 and
//   0.2 mm clearance stopped 32 mm up, and nothing said why.
// * A closed drum filled solid — one hull, "could not be broken into convex
//   pieces" — and threw out the dice inside it.

import { afterAll, describe, expect, it } from 'vitest';
import { decomposeNodeColliders, intrusionSentence, type ColliderResult } from '../src/utils/convexDecomposition';
import { decomposeSolid } from '../src/utils/solidDecomposition';
import { decomposeMesh } from '../src/utils/vhacd';
import type { SceneGeom, SceneNode } from '../src/types/scene';
import {
  boredCup, boxUnion, helicalHalfPipe, lathe, straightHalfPipe, translateMesh, zToX, zupToYupFlat, type MeshData,
} from './helpers/meshes';
import { simulate, type Sim } from './helpers/simulate';

const meshNode = (id: string, m: MeshData, extra: Partial<SceneNode> = {}, geom: Partial<SceneGeom> = {}): SceneNode => ({
  id, name: id, type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: `${id}_m`, type: 'mesh', size: [1], dynamic: true, renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces, ...geom }],
  ...extra,
});

const withPieces = (node: SceneNode, r: ColliderResult): SceneNode =>
  ({ ...node, geoms: [...node.geoms!, ...r.geoms], collisionHash: r.hash, collisionDecomposed: true });

const ball = (id: string, pos: number[], r: number, mass: number): SceneNode => ({
  id, name: id, type: 'body', pos, children: [], joints: [{ name: `${id}_free`, type: 'free' }],
  geoms: [{ name: `${id}_g`, type: 'sphere', size: [r], mass }],
});

const sims: Sim[] = [];
afterAll(() => { for (const s of sims) s.dispose(); });

/** Runs a scene, sampling `track` every 0.1 s; returns the samples. */
async function run(nodes: SceneNode[], seconds: number, track: (sim: Sim) => number): Promise<number[]> {
  const sim = await simulate({ nodes } as never);
  sims.push(sim);
  const out: number[] = [];
  for (let i = 0; i < seconds * 10; i++) { sim.run(0.1); out.push(track(sim)); }
  return out;
}

describe('a marble in a half-pipe chute', () => {
  it('rolls the length of a straight 160 mm ramp at 11°', async () => {
    const a = [0.06, -0.01, 0.057], b = [0.06, 0.15, 0.025];
    const ramp = meshNode('ramp', straightHalfPipe(a, b, 0.010, 0.0075));
    const r = (await decomposeNodeColliders(ramp))!;
    expect(r.cavities ?? []).toEqual([]);
    const d = b.map((x, i) => x - a[i]), len = Math.hypot(d[0], d[1], d[2]), t = d.map(x => x / len);
    const up = [0, -t[2], t[1]];
    // On the floor, 12 mm in from the top end.
    const start = a.map((x, k) => x + t[k] * 0.012 - up[k] * 0.0015 + (k === 2 ? 0.0005 : 0));
    const along = await run([withPieces(ramp, r), ball('marble', start, 0.006, 0.0036)], 1.5,
      sim => { const p = sim.bodyPos('marble'); return ((p[0] - a[0]) * t[0] + (p[1] - a[1]) * t[1] + (p[2] - a[2]) * t[2]) / len; });
    // Off the far end: past the whole length.
    expect(Math.max(...along)).toBeGreaterThan(1);
  }, 120_000);

  it('rolls both turns of a helical chute, which is cut into chunks and leaves no channel filled', async () => {
    const m = helicalHalfPipe();
    const solid = await decomposeSolid(m.verts, m.faces, { maxPieces: 512 });
    // 140 x 140 x 160 mm of box round 750 mm of channel: one call over the
    // whole box gave 64 pieces and filled 29 to 42 places along it.
    expect(solid.chunks).toBeGreaterThan(4);
    expect(solid.cavities).toEqual([]);

    const chute = meshNode('chute', m);
    const r = (await decomposeNodeColliders(chute))!;
    expect(r.cavities ?? []).toEqual([]);
    // Turns travelled, from the angle and the drop: the channel falls 75 mm a turn.
    const turns = (p: number[]) => {
      let th = Math.atan2(p[1], p[0]);
      if (th < 0) th += 2 * Math.PI;
      return Math.round((0.21 - p[2]) / 0.075 - th / (2 * Math.PI)) + th / (2 * Math.PI);
    };
    const path = await run([withPieces(chute, r), ball('marble', [0.06, 0.004, 0.209], 0.006, 0.0036)], 4,
      sim => turns(sim.bodyPos('marble')));
    // Out of the bottom: two turns. Stopped dead in the chute, it would be well short.
    expect(Math.max(...path)).toBeGreaterThan(1.95);
  }, 180_000);
});

describe('a ball in a close-fitting blind bore', () => {
  // Bore radius 10 mm, 4 mm walls and floor, 50 mm tall.
  const cup = () => meshNode('cup', boredCup());

  it('rests on the floor at 2, 0.5 and 0.2 mm radial clearance', async () => {
    const r = (await decomposeNodeColliders(cup()))!;
    for (const gap of [0.002, 0.0005, 0.0002]) {
      const radius = 0.010 - gap;
      const z = await run([withPieces(cup(), r), ball('b', [0.0003, 0, 0.1], radius, 0.01)], 1.5, sim => sim.bodyPos('b')[2]);
      // Down to the 4 mm floor, not wedged 32 mm up as before.
      expect(z[z.length - 1] - radius - 0.004).toBeLessThan(0.0005);
      expect(z[z.length - 1] - radius - 0.004).toBeGreaterThan(-0.001);
    }
  }, 120_000);

  it('is sliced exactly about its axis, so the bore is not narrowed at all', async () => {
    const r = (await decomposeNodeColliders(cup()))!;
    // V-HACD's pieces stood 1.67 mm proud. What is left is the fixture's own
    // 0.5 mm pinhole up the axis, which the floor's one piece spans.
    expect(r.intrusion?.mm ?? 0).toBeLessThanOrEqual(0.51);
    expect(r.intrusion?.atMm?.[2] ?? 0).toBeLessThan(5);
  }, 60_000);

  it('a round bore that is not lathed says how far its pieces still narrow the opening', async () => {
    // A square pocket is cut exactly at its corners now (reflexCuts.test.ts);
    // a bore in a block is curved, and its pieces are V-HACD's.
    const { loadManifold } = await import('../src/utils/sculptCut');
    const { fromManifold } = await import('../src/utils/chunkedDecomposition');
    const M = (await loadManifold()).Manifold;
    const part = M.cube([60, 60, 35]).translate([-30, -30, 0]).subtract(M.cylinder(40, 10.5, 10.5, 64).translate([5, 0, 5]));
    const block = fromManifold(part);
    part.delete();
    const r = (await decomposeNodeColliders(meshNode('block', block)))!;
    expect(r.intrusion!.mm).toBeGreaterThan(0);
    expect(intrusionSentence(r.intrusion!)).toMatch(/^Openings narrowed by up to [\d.]+ mm, most near \(/);
  }, 60_000);
});

describe('dice inside a closed drum', () => {
  // r 45/50 mm, 120 mm long, 5 mm end caps, turned onto the X axis.
  const drumMesh = () => translateMesh(zToX(lathe([
    [0.0005, 0], [0.05, 0], [0.05, 0.12], [0.0005, 0.12], [0.0005, 0.115], [0.045, 0.115], [0.045, 0.005], [0.0005, 0.005],
  ])), [-0.06, 0, 0]);

  it('one V-HACD call fills the sealed hollow solid; sliced about its axis it does not', async () => {
    const m = drumMesh();
    expect(await decomposeMesh(m.verts, m.faces)).toHaveLength(1);
    const solid = await decomposeSolid(m.verts, m.faces, { maxPieces: 512 });
    expect(solid.hulls.length).toBeGreaterThan(8);
    expect(solid.cavities).toEqual([]);
  }, 60_000);

  it('a sealed box, which is not lathed, is cut open into chunks', async () => {
    // 60 mm cube, 5 mm walls, closed all round.
    const box = boxUnion([{ min: [0, 0, 0], max: [0.06, 0.06, 0.06] }], [{ min: [0.005, 0.005, 0.005], max: [0.055, 0.055, 0.055] }]);
    expect(await decomposeMesh(box.verts, box.faces)).toHaveLength(1);
    const solid = await decomposeSolid(box.verts, box.faces, { maxPieces: 512 });
    expect(solid.chunks).toBeGreaterThan(1);
    expect(solid.cavities).toEqual([]);
    // The inside is air: no piece covers its middle, or points 10 mm in from the walls.
    const planes = solid.hulls.map(h => {
      const out: number[][] = [];
      for (let i = 0; i < h.faces.length; i += 3) {
        const [a, b, c] = [h.faces[i] * 3, h.faces[i + 1] * 3, h.faces[i + 2] * 3];
        const u = [0, 1, 2].map(k => h.verts[b + k] - h.verts[a + k]), w = [0, 1, 2].map(k => h.verts[c + k] - h.verts[a + k]);
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const l = Math.hypot(n[0], n[1], n[2]);
        if (l > 1e-18) out.push([...n.map(x => x / l), (n[0] * h.verts[a] + n[1] * h.verts[a + 1] + n[2] * h.verts[a + 2]) / l]);
      }
      return out;
    });
    for (const p of [[0.03, 0.03, 0.03], [0.015, 0.015, 0.015], [0.045, 0.03, 0.045], [0.03, 0.015, 0.045]]) {
      expect(planes.some(pl => pl.every(q => q[0] * p[0] + q[1] * p[1] + q[2] * p[2] - q[3] <= 0))).toBe(false);
    }
  }, 120_000);

  it('keeps them inside while it turns at 2 rad/s', async () => {
    const drum = meshNode('drum', drumMesh(), {
      pos: [0, 0, 0.07],
      joints: [{ name: 'roll', type: 'hinge', axis: [1, 0, 0], actuator: { type: 'velocity', kv: 2, ctrlValue: 2 } }],
    }, { density: 1000 });
    const r = (await decomposeNodeColliders(drum))!;
    expect(r.warning ?? '').not.toMatch(/could not be broken/);
    const dice: SceneNode[] = Array.from({ length: 5 }, (_, i) => ({
      id: `die${i}`, name: `die${i}`, type: 'body', pos: [-0.04 + i * 0.02, 0, 0.04], children: [],
      joints: [{ name: `die${i}_free`, type: 'free' }],
      geoms: [{ name: `die${i}_g`, type: 'box', size: [0.006, 0.006, 0.006], density: 2500 }],
    }));
    const farthest = await run([withPieces(drum, r), ...dice], 4, sim => Math.max(...dice.map(d => {
      const p = sim.bodyPos(d.name);
      return Math.hypot(p[1], p[2] - 0.07);
    })));
    // Inside the 45 mm inner radius throughout; thrown out, they were 70 mm off.
    expect(Math.max(...farthest)).toBeLessThan(0.045);
  }, 120_000);
});
