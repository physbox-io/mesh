// A long, thin, curved part with a channel along it: a U-section coaster track,
// 440 mm long with a 32 x 12 mm channel and 3 mm walls, solidity about 0.09.
//
// Broken into the 15 pieces the defaults used to allow, several spanned the
// channel and it came out solid along most of its length — and nothing said
// so, because the filled-cavity check judged each region of filled air against
// the open air in its bounding box, which for a sloping track is mostly sky.
// What has to hold: a car can roll along the channel, and when a
// decomposition still fills it, the body says so.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { collisionDetailLevels, decomposeNodeColliders } from '../src/utils/convexDecomposition';
import { chunkSlenderness } from '../src/utils/chunkedDecomposition';
import { CHUNK_VOXELS, SOLID_CHUNK_PLAN } from '../src/utils/solidDecomposition';
import { wallThickness } from '../src/utils/filledCavities';
import { findFilledCavities } from '../src/utils/filledCavities';
import { decomposeMesh } from '../src/utils/vhacd';
import type { Hull } from '../src/utils/csg';
import { coasterFloorZ, cupMesh, torusMesh, uChannelTrack, zupToYupFlat } from './helpers/meshes';
import { simulate, type Sim } from './helpers/simulate';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const track = uChannelTrack();

const planesOf = (verts: number[], faces: number[]) => {
  const out: number[][] = [];
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3, b = faces[i + 1] * 3, c = faces[i + 2] * 3;
    const u = [verts[b] - verts[a], verts[b + 1] - verts[a + 1], verts[b + 2] - verts[a + 2]];
    const w = [verts[c] - verts[a], verts[c + 1] - verts[a + 1], verts[c + 2] - verts[a + 2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    if (l < 1e-18) continue;
    out.push([n[0] / l, n[1] / l, n[2] / l, (n[0] * verts[a] + n[1] * verts[a + 1] + n[2] * verts[a + 2]) / l]);
  }
  return out;
};

/** Where the channel's floor is at x, and which way is up from it. */
const floorFrame = (x: number) => {
  const h = 1e-5;
  const dz = (coasterFloorZ(x + h) - coasterFloorZ(x - h)) / (2 * h);
  const n = Math.hypot(1, dz);
  return { z: coasterFloorZ(x), up: [-dz / n, 1 / n] as const };
};

/**
 * The share of the channel's core — 10 mm either side of the centreline, 3 to
 * 9 mm off the floor, where a car's wheels and body run — inside some piece.
 */
function coreFilled(pieces: number[][][]): number {
  let inside = 0, total = 0;
  for (let x = -0.215; x <= 0.215; x += 0.005) {
    const { z, up } = floorFrame(x);
    for (let y = -0.010; y <= 0.0101; y += 0.0025) {
      for (let h = 0.003; h <= 0.0091; h += 0.002) {
        const p = [x + up[0] * h, y, z + up[1] * h];
        total++;
        if (pieces.some(pl => pl.every(q => q[0] * p[0] + q[1] * p[1] + q[2] * p[2] - q[3] <= 1e-9))) inside++;
      }
    }
  }
  return inside / total;
}

const hullPlanes = (hulls: Hull[]) => hulls.map(h => planesOf(h.verts, h.faces));
/** A collider's planes in the body frame: its centred Y-up vertices put back at its pos. */
const colliderPlanes = (geoms: SceneGeom[]) => geoms.map(g => {
  const v: number[] = [];
  for (let i = 0; i < g.vertices!.length; i += 3) v.push(g.vertices![i] + g.pos![0], -g.vertices![i + 2] + g.pos![1], g.vertices![i + 1] + g.pos![2]);
  return planesOf(v, g.faces!);
});

const trackNode = (extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'track', name: 'track', type: 'body', pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: 'rail', type: 'mesh', size: [1], dynamic: true, renderVertices: track.verts, vertices: zupToYupFlat(track.verts), faces: track.faces }],
  ...extra,
});

describe('the U-channel fixture', () => {
  it('is long for its walls, so it is cut into chunks before it is decomposed', () => {
    expect(chunkSlenderness(track, wallThickness(track.verts, track.faces))).toBeGreaterThan(SOLID_CHUNK_PLAN.slender);
  });

  it('a compact cup is not', () => {
    const cup = cupMesh({ outerR: 0.10, innerR: 0.08, height: 0.12, baseThickness: 0.02 });
    expect(chunkSlenderness(cup, wallThickness(cup.verts, cup.faces))).toBeLessThan(SOLID_CHUNK_PLAN.slender);
  });
});

describe('finding a channel filled along its length', () => {
  let coarse: Hull[];
  beforeAll(async () => { coarse = await decomposeMesh(track.verts, track.faces, { maxHulls: 16 }); });

  it('the old 16-piece budget really does fill the channel', () => {
    expect(coreFilled(hullPlanes(coarse))).toBeGreaterThan(0.5);
  });

  it('reports it, piece by piece, along the length of the track', () => {
    const found = findFilledCavities(track.verts, track.faces, coarse);
    expect(found.length).toBeGreaterThanOrEqual(4);
    const xs = found.map(c => c.centerMm[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(200);
    // Each is in the channel: on the centreline, within a channel's depth of the floor.
    for (const c of found) {
      expect(Math.abs(c.centerMm[1])).toBeLessThan(16);
      expect(c.centerMm[2] / 1000 - coasterFloorZ(c.centerMm[0] / 1000)).toBeLessThan(0.03);
    }
  });

  it('does not report the pieces of a sound decomposition', async () => {
    const torus = torusMesh();
    expect(findFilledCavities(torus.verts, torus.faces, await decomposeMesh(torus.verts, torus.faces))).toEqual([]);
  }, 30_000);
});

describe('decomposing the track with the defaults', () => {
  let result: NonNullable<Awaited<ReturnType<typeof decomposeNodeColliders>>>;
  beforeAll(async () => { result = (await decomposeNodeColliders(trackNode()))!; }, 60_000);

  it('scales its budget to the part, and leaves the channel open', () => {
    expect(result.verdict.strategy).toBe('decompose');
    expect(result.geoms.length).toBeGreaterThan(200);
    expect(coreFilled(colliderPlanes(result.geoms))).toBeLessThan(0.05);
  });

  it('names whatever it still fills, and that is corners, not the channel', () => {
    // Pieces holding a wall and a strip of floor still fill the corner between
    // them; that is what is left, and it is said.
    for (const c of result.cavities ?? []) expect(c.volumeMm3).toBeLessThan(2_000);
    if (result.cavities?.length) expect(result.warning).toMatch(/filled in by track_csg_col\d+/);
  });

  it('tells someone who asked for too few pieces that the channel is filled', async () => {
    const tuned = (await decomposeNodeColliders(trackNode({ collisionHulls: 16 })))!;
    expect(tuned.geoms.length).toBeLessThanOrEqual(16);
    expect(tuned.cavities!.length).toBeGreaterThanOrEqual(4);
    expect(tuned.warning).toMatch(/^A cavity about .* is filled in by track_csg_col\d+ \(and \d+ more\)/);
  }, 60_000);
});

describe('a car in the channel, in MuJoCo', () => {
  let sim: Sim | null = null;
  afterAll(() => sim?.dispose());

  it('rolls down the first drop and over the hump, in the channel rather than on a lid over it', async () => {
    // Stiffer contact than the scene default (0.02 s), which lets a ball this
    // small sink 3 mm into a 4 mm floor at the bottom of the drop and catch
    // on the seams between pieces there. Pieces inherit it from the rail.
    const stiff = [0.004, 1];
    const source = trackNode({ geoms: [{ ...trackNode().geoms![0], solref: stiff }] });
    const result = (await decomposeNodeColliders(source))!;
    const rail: SceneNode = { ...source, geoms: [...source.geoms!, ...result.geoms], collisionHash: result.hash, collisionDecomposed: true };
    // A 10 mm ball: it runs on the floor, between the walls, below their tops.
    const start = -0.12;
    const { z, up } = floorFrame(start);
    const ball: SceneNode = {
      id: 'car', name: 'car', type: 'body', joints: [{ name: 'car_free', type: 'free' }], children: [],
      pos: [start + up[0] * 0.0055, 0, z + up[1] * 0.0055],
      geoms: [{ name: 'car_ball', type: 'sphere', size: [0.005], density: 7800, solref: stiff }],
    };
    sim = await simulate({ nodes: [rail, ball] } as never);
    let furthest = -Infinity, highest = 0, widest = 0, last = Infinity;
    for (let i = 0; i < 150; i++) {
      sim.run(0.01);
      const [x, y, cz] = sim.bodyPos('car');
      if (x < -0.21 || x > 0.21) break;
      furthest = Math.max(furthest, x);
      const f = floorFrame(x);
      last = (cz - f.z) * f.up[1];
      // Up to the crest. Past it the ball is airborne, as it should be: it
      // reaches the 61 mm-radius crest at about 0.95 m/s, and anything over
      // sqrt(g r) = 0.77 m/s leaves the track. On the old stepped pieces it
      // arrived too slowly to.
      if (x < 0.07) highest = Math.max(highest, last);
      widest = Math.max(widest, Math.abs(y));
    }
    // Past the bottom of the drop and over the 45 mm hump at x = 70 mm.
    expect(furthest).toBeGreaterThan(0.08);
    // Riding on the floor: a channel filled to its 12 mm rim would carry it at 17 mm.
    expect(highest).toBeLessThan(0.009);
    // And back on it, in the channel, once it has landed.
    expect(last).toBeLessThan(0.009);
    expect(widest).toBeLessThan(0.012);
  }, 120_000);
});

describe("the inspector's Detail levels", () => {
  it('are each finer than what a chunk gets by default, and cap no part', () => {
    const { standard, fine, finest } = collisionDetailLevels();
    expect(standard).toEqual({});
    expect(fine.collisionResolution).toBeGreaterThan(CHUNK_VOXELS);
    expect(finest.collisionResolution).toBeGreaterThan(fine.collisionResolution!);
    expect(fine.collisionHulls).toBeUndefined();
    expect(finest.collisionHulls).toBeUndefined();
  });
});
