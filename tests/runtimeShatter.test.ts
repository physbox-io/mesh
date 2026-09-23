// Turning a body into its pieces, and checking the pieces are a body's worth.
//
// The worker and the store cannot be reached from here, but everything they
// decide with can: the fracture, the shard graph, and — the part most likely to
// be quietly wrong — whether the result is a scene MuJoCo will actually accept
// and step without flinging anything to infinity.
//
// The frame arithmetic is the reason this exists. A shard's offset from the body
// origin is (cell centroid - mesh centroid) rotated into the world, and getting
// it wrong does not look like an offset: it looks like the vase teleporting as
// it breaks.

import { describe, it, expect, afterAll } from 'vitest';
import { fractureMesh } from '../src/utils/fracture';
import { MAX_SHATTER_DEPTH, buildShatterGraph, matToQuat, rotate, volumeCentroid, zupToYup } from '../src/utils/runtimeShatter';
import { simulate, type Sim } from './helpers/simulate';
import { shatterPreset } from '../src/presets/shatter';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const vaseNode = (): SceneNode =>
  (shatterPreset.nodes as SceneNode[]).find((n) => n.id === 'vase')!;

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const shatterVase = (frameOverrides: Partial<Parameters<typeof buildShatterGraph>[4]> = {}) => {
  const node = vaseNode();
  const geom = node.geoms[0];
  const source = geom.renderVertices!;
  const cells = fractureMesh(source, geom.faces!, { pieces: 14, seed: 7, focus: [0, 0, 0.05] });
  const result = buildShatterGraph(node, source, geom.faces!, cells, {
    pos: [node.pos[0], node.pos[1], node.pos[2]],
    xmat: IDENTITY,
    vel: [0, 0, 0],
    angvel: [0, 0, 0],
    ...frameOverrides,
  }, { totalMass: geom.mass, rgba: geom.rgba, spread: 0 });
  return { node, geom, source, cells, ...result };
};

describe('helpers', () => {
  it('turns an identity rotation into an identity quaternion', () => {
    expect(matToQuat(IDENTITY)).toEqual([1, 0, 0, 0]);
  });

  it('rotates by a row-major matrix the way data.xmat is laid out', () => {
    // 90 degrees about Z: x -> y.
    const rz = [0, -1, 0, 1, 0, 0, 0, 0, 1];
    const [x, y, z] = rotate(rz, [1, 0, 0]);
    expect(x).toBeCloseTo(0, 12);
    expect(y).toBeCloseTo(1, 12);
    expect(z).toBeCloseTo(0, 12);
  });

  it('round-trips Z-up to Y-up as a rotation, preserving handedness', () => {
    // A rotation must not flip the sign of a signed volume; a mirror would, and
    // a mirrored mesh renders inside out.
    const { verts, faces } = cube();
    const before = volumeCentroid(verts, faces).volume;
    const after = volumeCentroid(zupToYup(verts), faces).volume;
    expect(Math.sign(after)).toBe(Math.sign(before));
    expect(Math.abs(after)).toBeCloseTo(Math.abs(before), 12);
  });
});

describe('buildShatterGraph', () => {
  it('conserves the body: the shards weigh what the vase weighed', () => {
    const { shards, geom } = shatterVase();
    expect(shards.length).toBeGreaterThan(5);
    const total = shards.reduce((s, n) => s + (n.geoms[0].mass ?? 0), 0);
    expect(total).toBeCloseTo(geom.mass!, 6);
  });

  it('puts the pieces where the body was, not where the document says', () => {
    // Break it a metre to one side of where it is authored. Every shard must
    // follow the body, which is the whole point of taking the live frame.
    const moved = shatterVase({ pos: [5, 0, 2] });
    for (const shard of moved.shards) {
      expect(Math.abs(shard.pos[0] - 5)).toBeLessThan(0.3);
      expect(Math.abs(shard.pos[2] - 2)).toBeLessThan(0.3);
    }
    // And their centre of mass should sit on the body's origin, because that is
    // where MuJoCo had recentred the mesh.
    const mass = moved.shards.reduce((s, n) => s + (n.geoms[0].mass ?? 0), 0);
    const com = [0, 1, 2].map((axis) =>
      moved.shards.reduce((s, n) => s + (n.geoms[0].mass ?? 0) * n.pos[axis], 0) / mass);
    expect(com[0]).toBeCloseTo(5, 1);
    expect(com[2]).toBeCloseTo(2, 1);
  });

  it('carries the spin out through the pieces, not just the drift', () => {
    // Spinning about Z, a shard offset in +x must acquire velocity in +y.
    const spun = shatterVase({ angvel: [0, 0, 10] });
    const offset = spun.shards
      .map((n, i) => ({ n, r: n.pos[0] - spun.node.pos[0], i }))
      .sort((a, b) => b.r - a.r)[0];
    const vel = offset.n.joints[0].initialVelocity!;
    expect(vel[1]).toBeGreaterThan(0);
    expect(offset.n.joints[0].initialVelocity!.slice(3)).toEqual([0, 0, 10]);
  });

  it('gives each shard the same string for its id and its name', () => {
    // Not cosmetic. MJCF names a body from node.name, and SceneLayer resolves
    // that body with mj_name2id(..., nodeId) — by ID. If the two differ the
    // lookup returns -1, the renderer falls back to the identity transform, and
    // every shard is drawn in a heap at the world origin instead of where it
    // broke. Every preset in the repo sets id === name, so only shards ever
    // exercised this.
    const { shards } = shatterVase();
    for (const s of shards) expect(s.id).toBe(s.name);
  });

  it('gives every shard a free joint, a unique name and a drawable mesh', () => {
    const { shards } = shatterVase();
    const names = new Set(shards.map((s) => s.name));
    expect(names.size).toBe(shards.length);
    for (const s of shards) {
      expect(s.joints).toHaveLength(1);
      expect(s.joints[0].type).toBe('free');
      const g = s.geoms[0];
      expect(g.type).toBe('mesh');
      expect(g.dynamic).toBe(true);
      expect(g.renderVertices!.length).toBeGreaterThan(9);
      expect(g.vertices!.length).toBe(g.renderVertices!.length);
      // Outward winding, or it renders as a half-transparent ghost.
      expect(volumeCentroid(g.renderVertices!, g.faces!).volume).toBeGreaterThan(0);
      // Recentred on itself, like every other mesh geom.
      const c = volumeCentroid(g.renderVertices!, g.faces!).centroid;
      expect(Math.hypot(c[0], c[1], c[2])).toBeLessThan(0.02);
    }
  });
});

describe('pieces that break again', () => {
  const withRecursion = (depth: number, generation = 0) => {
    const node = vaseNode();
    const geom = node.geoms[0];
    const source = geom.renderVertices!;
    const cells = fractureMesh(source, geom.faces!, { pieces: 8, seed: 3 });
    return buildShatterGraph(node, source, geom.faces!, cells, {
      pos: [0, 0, 1], xmat: IDENTITY, vel: [0, 0, 0], angvel: [0, 0, 0],
    }, {
      totalMass: geom.mass,
      recursion: { generation: generation + 1, depth, impulseNs: 1.2, pieces: 8, seed: 1 },
    }).shards;
  };

  it('leaves the pieces final when no depth was asked for', () => {
    const { shards } = shatterVase();
    for (const s of shards) expect(s.shatterImpulseNs).toBeUndefined();
  });

  it('makes each piece breakable in proportion to its share of the body', () => {
    const shards = withRecursion(1);
    for (const s of shards) {
      expect(s.shatterImpulseNs).toBeDefined();
      // A chip held to the whole vase's threshold could hardly ever be hit hard
      // enough, and would read as armour plating rather than as porcelain.
      expect(s.shatterImpulseNs!).toBeLessThan(1.2);
      expect(s.shatterImpulseNs!).toBeGreaterThan(0);
      expect(s.shatterGeneration).toBe(1);
    }
    // ...and the thresholds add back up to the body's, because the volumes do.
    const total = shards.reduce((t, s) => t + s.shatterImpulseNs!, 0);
    expect(total).toBeCloseTo(1.2, 6);
  });

  it('asks for fewer pieces each generation, so a chip does not become gravel', () => {
    const shards = withRecursion(2);
    for (const s of shards) expect(s.shatterPieces).toBe(4);
  });

  it('stops at the authored depth', () => {
    // Generation 1 with a depth of 1 is the last: its pieces are final.
    for (const s of withRecursion(1, 1)) expect(s.shatterImpulseNs).toBeUndefined();
  });

  it('stops at the hard ceiling however much depth is asked for', () => {
    for (const s of withRecursion(99, MAX_SHATTER_DEPTH)) {
      expect(s.shatterImpulseNs).toBeUndefined();
    }
  });

  it('gives each piece its own seed, so two shards do not break identically', () => {
    const seeds = withRecursion(1).map((s) => s.shatterSeed);
    expect(new Set(seeds).size).toBe(seeds.length);
  });
});

describe('a shattered scene is a scene MuJoCo accepts', () => {
  let sim: Sim;
  afterAll(() => sim?.dispose());

  it('compiles, steps, and lets the pieces fall without blowing up', async () => {
    const { shards, node } = shatterVase();
    const scene: SceneGraph = {
      nodes: [
        ...(shatterPreset.nodes as SceneNode[]).filter((n) => n.id !== node.id && !n.id.startsWith('vase_handle')),
        ...shards,
      ],
    };
    sim = await simulate(scene);
    const startZ = shards.map((s) => sim.bodyPos(s.name)[2]);
    sim.run(1.2);

    for (let i = 0; i < shards.length; i++) {
      const p = sim.bodyPos(shards[i].name);
      expect(Number.isFinite(p[0]) && Number.isFinite(p[1]) && Number.isFinite(p[2])).toBe(true);
      // They fell — nothing is hanging in the air where the vase used to be.
      expect(p[2]).toBeLessThan(startZ[i] + 0.05);
      // ...and nothing was flung across the room by a bad initial overlap.
      expect(Math.hypot(p[0] - node.pos[0], p[1] - node.pos[1])).toBeLessThan(1.5);
    }
  }, 120_000);
});

function cube() {
  const h = 0.1;
  const verts = [
    -h, -h, -h, h, -h, -h, h, h, -h, -h, h, -h,
    -h, -h, h, h, -h, h, h, h, h, -h, h, h,
  ];
  const faces = [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6,
    1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3,
  ];
  return { verts, faces };
}
