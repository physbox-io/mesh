// When a mesh has to be broken into convex pieces, and what those pieces weigh.
//
// Everything here is pure geometry — convexDecomposition.ts holds the decision
// and the arithmetic, and deliberately reaches no wasm and no Worker, so this
// runs in plain Node like the rest of the suite. The decomposition itself is
// exercised in tests/concaveCollision.test.ts, against real MuJoCo.

import { describe, it, expect } from 'vitest';
import {
  collisionHashOf,
  colliderMass,
  decompositionVerdict,
  hullBudget,
  meshSolidity,
  solidityOf,
  solidMeshGeoms,
  MAX_HULLS,
  MIN_HULLS,
  SOLIDITY_DECOMPOSE_BELOW,
} from '../src/utils/convexDecomposition';
import {
  collisionModeOf,
  convexHullOf,
  hullsToColliderGeoms,
  meshVolumeAndCentroid,
  usableColliderHulls,
  type Hull,
} from '../src/utils/csg';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { boxMesh, cupMesh, openTopBoxMesh, openTopBoxSlabs, sphereMesh, zupToYupFlat } from './helpers/meshes';
import type { SceneGeom, SceneNode } from '../src/types/scene';

const meshGeom = (m: { verts: number[]; faces: number[] }, extra: Partial<SceneGeom> = {}): SceneGeom => ({
  name: 'm', type: 'mesh', size: [1],
  renderVertices: m.verts,
  vertices: zupToYupFlat(m.verts),
  faces: m.faces,
  ...extra,
});

const body = (geoms: SceneGeom[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id: 'b', name: 'b', type: 'body', pos: [0, 0, 0], geoms, joints: [], children: [], ...extra,
});

// ---------------------------------------------------------------------------
// The fixtures themselves. Solidity is a signed volume, so a fixture wound the
// wrong way would invert every assertion below without failing any of them.
// ---------------------------------------------------------------------------

describe('mesh fixtures', () => {
  it.each([
    ['box', boxMesh()],
    ['cup', cupMesh()],
    ['open-top box', openTopBoxMesh()],
    ['sphere', sphereMesh()],
  ])('%s is closed, consistently wound and encloses a positive volume', (_name, m) => {
    const integrity = analyzeMesh(m.verts, m.faces);
    expect(integrity).not.toBeNull();
    expect(integrity!.closed).toBe(true);
    expect(integrity!.consistentlyWound).toBe(true);
    expect(integrity!.volume).toBeGreaterThan(0);
    expect(integrity!.degenerateTriangles).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Solidity — the number the whole decision turns on.
// ---------------------------------------------------------------------------

describe('solidity', () => {
  it('is 1 for a box: it is its own convex hull', () => {
    expect(meshSolidity(meshGeom(boxMesh())).solidity).toBeCloseTo(1, 3);
  });

  it('is ~1 for a sphere, up to its faceting', () => {
    expect(meshSolidity(meshGeom(sphereMesh())).solidity).toBeGreaterThan(0.99);
  });

  it('is low for a cup — the hull fills in the cavity', () => {
    const { volume, hullVolume, solidity } = meshSolidity(meshGeom(cupMesh()));
    expect(solidity).toBeLessThan(0.5);
    // This IS the bug, stated as a number: MuJoCo would collide the cup as a
    // solid billet more than twice its real volume.
    expect(hullVolume).toBeGreaterThan(volume * 2);
  });

  it('is low for an open-top box', () => {
    expect(meshSolidity(meshGeom(openTopBoxMesh())).solidity).toBeLessThan(0.5);
  });

  it('reads an open or inside-out mesh as convex rather than as nonsense', () => {
    // A negative or zero volume is not a solidity. 1 means "leave it alone",
    // which is the safe reading — see the winding trap in CLAUDE.md.
    expect(solidityOf(-1, 2)).toBe(1);
    expect(solidityOf(1, 0)).toBe(1);
    // And it never exceeds 1, however the two figures were measured.
    expect(solidityOf(3, 2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The verdict.
// ---------------------------------------------------------------------------

describe('decompositionVerdict', () => {
  it('leaves a body of primitives entirely alone', () => {
    const v = decompositionVerdict(body([{ name: 'p', type: 'box', size: [0.1, 0.1, 0.1] }]));
    expect(v.strategy).toBe('hull');
    expect(v.reason).toBe('no-mesh');
  });

  it('collides a box as its hull, because that is exact', () => {
    const v = decompositionVerdict(body([meshGeom(boxMesh())]));
    expect(v.strategy).toBe('hull');
    // A box is 12 triangles, so it never even reaches the solidity test.
    expect(v.reason).toBe('too-coarse');
  });

  it('collides a sphere as its hull on the solidity test', () => {
    const v = decompositionVerdict(body([meshGeom(sphereMesh())]));
    expect(v.strategy).toBe('hull');
    expect(v.reason).toBe('convex-enough');
    expect(v.solidity).toBeGreaterThan(SOLIDITY_DECOMPOSE_BELOW);
  });

  it('decomposes a cup', () => {
    const v = decompositionVerdict(body([meshGeom(cupMesh())]));
    expect(v.strategy).toBe('decompose');
    expect(v.reason).toBe('concave');
    expect(v.maxHulls).toBeGreaterThanOrEqual(MIN_HULLS);
    expect(v.maxHulls).toBeLessThanOrEqual(MAX_HULLS);
  });

  it('prefers the sector slicer when a hole actually pierces the solid', () => {
    // A ring's error is known exactly there; a general decomposition only
    // approximates it.
    const v = decompositionVerdict(body([meshGeom(cupMesh())]), { hasHoleAxis: true });
    expect(v.strategy).toBe('sectors');
  });

  it('declines a mesh too dense to be worth voxelising, and says so usefully', () => {
    const v = decompositionVerdict(body([meshGeom(cupMesh({ segments: 48 }))]), {
      volume: 1, hullVolume: 10,
    });
    expect(v.strategy).toBe('decompose');

    const dense = decompositionVerdict(
      body([{ ...meshGeom(cupMesh()), faces: new Array(600_000).fill(0) }]),
      { volume: 1, hullVolume: 10 },
    );
    expect(dense.strategy).toBe('hull');
    expect(dense.reason).toBe('too-dense');
    expect(dense.warning).toMatch(/200,000 triangles/);
    expect(dense.warning).toMatch(/convex hull/);
  });

  it('honours an explicit mode over anything it would have decided', () => {
    const cup = [meshGeom(cupMesh())];
    expect(decompositionVerdict(body(cup, { collision: 'hull' })).strategy).toBe('hull');
    expect(decompositionVerdict(body(cup, { collision: 'primitives' })).strategy).toBe('primitives');
    // Forced decomposition ignores the triangle caps: the caps are advice.
    const forced = decompositionVerdict(
      body([{ ...meshGeom(cupMesh()), faces: new Array(600_000).fill(0) }], { collision: 'decompose' }),
      { volume: 1, hullVolume: 10 },
    );
    expect(forced.strategy).toBe('decompose');
    expect(forced.reason).toBe('forced');
  });
});

describe('hullBudget', () => {
  it('spends more hulls on a more concave shape', () => {
    expect(hullBudget(0.9)).toBeLessThan(hullBudget(0.2));
  });
  it('stays within the cap, because contact cost is quadratic in hull count', () => {
    expect(hullBudget(0)).toBeLessThanOrEqual(MAX_HULLS);
    expect(hullBudget(1)).toBeGreaterThanOrEqual(MIN_HULLS);
  });
  it('lets an explicit request through', () => {
    expect(hullBudget(0.5, 3)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Turning hulls into geoms — the rules MuJoCo punishes getting wrong.
// ---------------------------------------------------------------------------

describe('hullsToColliderGeoms', () => {
  const slabHulls = (): Hull[] => openTopBoxSlabs().map(s => {
    const m = boxMesh(s.c, s.h);
    const { volume, centroid } = meshVolumeAndCentroid(m.verts, m.faces);
    return { verts: m.verts, faces: m.faces, volume, centroid };
  });

  it('gives every hull its own centroid as pos, and centres its vertices on it', () => {
    // MuJoCo recentres every mesh asset on its centre of mass and then places
    // that frame at the geom's pos. Skip this and every piece stacks on the
    // body origin.
    const geoms = hullsToColliderGeoms(slabHulls(), 'cup', undefined, 1);
    const hulls = slabHulls();
    geoms.forEach((g, i) => {
      expect(g.pos![0]).toBeCloseTo(hulls[i].centroid[0], 5);
      expect(g.pos![1]).toBeCloseTo(hulls[i].centroid[1], 5);
      expect(g.pos![2]).toBeCloseTo(hulls[i].centroid[2], 5);
      // Vertices are stored Y-up; their centroid must be the origin either way.
      const v = g.vertices!;
      let sx = 0, sy = 0, sz = 0;
      for (let k = 0; k < v.length; k += 3) { sx += v[k]; sy += v[k + 1]; sz += v[k + 2]; }
      const n = v.length / 3;
      expect(Math.hypot(sx / n, sy / n, sz / n)).toBeLessThan(1e-6);
    });
  });

  it('shares the mass out exactly, with no rounding lost', () => {
    const geoms = hullsToColliderGeoms(slabHulls(), 'cup', undefined, 0.37);
    const total = geoms.reduce((s, g) => s + (g.mass ?? 0), 0);
    expect(total).toBeCloseTo(0.37, 10);
    // Heavier pieces are the bigger ones.
    expect(geoms.every(g => (g.mass ?? 0) > 0)).toBe(true);
  });

  it('marks them collision-only and derived, so the read seam can find them', () => {
    const geoms = hullsToColliderGeoms(slabHulls(), 'cup', undefined, 1);
    expect(geoms.every(g => g.role === 'collision')).toBe(true);
    expect(geoms.every(g => g.csgDerived === 'collider')).toBe(true);
    expect(geoms.map(g => g.name)).toEqual(geoms.map((_, i) => `cup_csg_col${i}`));
  });

  it('carries contact properties over from the geom it replaced', () => {
    const geoms = hullsToColliderGeoms(slabHulls(), 'cup', {
      rgba: [1, 0, 0, 1], condim: 6, friction: [2, 0.01, 0.001],
    }, 1);
    expect(geoms[0].condim).toBe(6);
    expect(geoms[0].friction).toEqual([2, 0.01, 0.001]);
    expect(geoms[0].rgba).toEqual([1, 0, 0, 1]);
  });

  it('emits nothing rather than something weightless', () => {
    expect(hullsToColliderGeoms([], 'cup', undefined, 1)).toEqual([]);
  });

  it('drops a sliver before it reaches MuJoCo, and the survivors keep the mass', () => {
    // A sliver makes qhull abort INSIDE MuJoCo and takes the wasm heap with it,
    // so this filter is mandatory, not cosmetic.
    const sliver = boxMesh([0, 0, 0], [0.1, 0.1, 1e-7]);
    const { volume, centroid } = meshVolumeAndCentroid(sliver.verts, sliver.faces);
    const hulls = [...slabHulls(), { verts: sliver.verts, faces: sliver.faces, volume, centroid }];
    const usable = usableColliderHulls(hulls);
    expect(usable.length).toBe(hulls.length - 1);
    const geoms = hullsToColliderGeoms(usable, 'cup', undefined, 2);
    expect(geoms.reduce((s, g) => s + (g.mass ?? 0), 0)).toBeCloseTo(2, 10);
  });
});

// ---------------------------------------------------------------------------
// The pieces really do leave the cavity empty. This is the mirror of
// csg.test.ts's "a single convex hull closes the hole".
// ---------------------------------------------------------------------------

describe('what the pieces enclose', () => {
  const planesOf = (h: { verts: number[]; faces: number[]; centroid: number[] }) => {
    const planes: Array<[number, number, number, number]> = [];
    for (let i = 0; i < h.faces.length; i += 3) {
      const [a, b, c] = [h.faces[i], h.faces[i + 1], h.faces[i + 2]];
      const p = (k: number) => [h.verts[k * 3], h.verts[k * 3 + 1], h.verts[k * 3 + 2]];
      const [ax, ay, az] = p(a), [bx, by, bz] = p(b), [cx, cy, cz] = p(c);
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
  const inside = (planes: Array<[number, number, number, number]>, p: number[]) =>
    planes.every(([a, b, c, d]) => a * p[0] + b * p[1] + c * p[2] + d <= 1e-9);

  it('a single hull swallows the cup’s cavity — the bug, as an assertion', () => {
    const m = cupMesh();
    const pts: number[][] = [];
    for (let i = 0; i < m.verts.length; i += 3) pts.push([m.verts[i], m.verts[i + 1], m.verts[i + 2]]);
    const hull = convexHullOf(pts)!;
    // A point in mid-air above the cup's floor is INSIDE the hull. That is the
    // invisible lid a ball lands on.
    expect(inside(planesOf(hull), [0, 0, 0.08])).toBe(true);
  });

  it('the convex pieces of an open-top box leave its cavity empty', () => {
    const slabs = openTopBoxSlabs().map(s => {
      const b = boxMesh(s.c, s.h);
      const { volume, centroid } = meshVolumeAndCentroid(b.verts, b.faces);
      return { verts: b.verts, faces: b.faces, volume, centroid };
    });
    const planes = slabs.map(planesOf);
    // The middle of the cavity is outside every piece.
    expect(planes.some(p => inside(p, [0, 0, 0.08]))).toBe(false);
    // The walls are still solid where they should be.
    expect(planes.some(p => inside(p, [0.095, 0, 0.08]))).toBe(true);
    expect(planes.some(p => inside(p, [0, 0, 0.01]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Mass, and the hash that stops all of this running twice.
// ---------------------------------------------------------------------------

describe('colliderMass', () => {
  it('prefers an explicit body mass, then the geom’s, then density × TRUE volume', () => {
    const g = meshGeom(cupMesh());
    expect(colliderMass(body([g], { collisionMass: 2 }), g, 0.001)).toBe(2);
    expect(colliderMass(body([g]), { ...g, mass: 0.5 }, 0.001)).toBe(0.5);
    // Water, by MuJoCo's own default, times what is actually there — not times
    // the lump the hull describes.
    expect(colliderMass(body([g]), g, 0.001)).toBeCloseTo(1, 6);
  });

  it('never returns zero, which a free-jointed body cannot have', () => {
    expect(colliderMass(body([]), undefined, 0)).toBeGreaterThan(0);
  });
});

describe('collisionHashOf', () => {
  const cup = () => body([meshGeom(cupMesh())]);

  it('is empty for a body with nothing to decompose', () => {
    expect(collisionHashOf(body([{ name: 'p', type: 'box', size: [1, 1, 1] }]))).toBe('');
  });

  it('is empty for a boolean body, which csgHash already covers', () => {
    expect(collisionHashOf(body([meshGeom(cupMesh())], { csgEnabled: true }))).toBe('');
  });

  it('survives a JSON round trip, so a reload does not re-decompose the scene', () => {
    const node = cup();
    const reloaded = JSON.parse(JSON.stringify(node)) as SceneNode;
    expect(collisionHashOf(reloaded)).toBe(collisionHashOf(node));
  });

  it('changes when the mesh changes', () => {
    expect(collisionHashOf(body([meshGeom(cupMesh({ height: 0.13 }))])))
      .not.toBe(collisionHashOf(cup()));
  });

  it('changes when the collision settings change', () => {
    const h = collisionHashOf(cup());
    expect(collisionHashOf(body(cup().geoms, { collision: 'hull' }))).not.toBe(h);
    expect(collisionHashOf(body(cup().geoms, { collisionHulls: 12 }))).not.toBe(h);
    expect(collisionHashOf(body(cup().geoms, { collisionMass: 3 }))).not.toBe(h);
  });

  it('ignores the colliders it produced, or it would never settle', () => {
    const node = cup();
    const before = collisionHashOf(node);
    node.geoms = [...node.geoms!, ...hullsToColliderGeoms(
      openTopBoxSlabs().map(s => {
        const b = boxMesh(s.c, s.h);
        const { volume, centroid } = meshVolumeAndCentroid(b.verts, b.faces);
        return { verts: b.verts, faces: b.faces, volume, centroid };
      }), 'b', undefined, 1)];
    expect(collisionHashOf(node)).toBe(before);
  });
});

describe('collisionModeOf', () => {
  it('defaults to auto', () => {
    expect(collisionModeOf(body([]))).toBe('auto');
  });
  it('reads the old boolean field, so existing saves keep their behaviour', () => {
    expect(collisionModeOf(body([], { csgCollision: 'hull' }))).toBe('hull');
    expect(collisionModeOf(body([], { csgCollision: 'decompose' }))).toBe('decompose');
  });
  it('lets the new field win', () => {
    expect(collisionModeOf(body([], { csgCollision: 'hull', collision: 'decompose' }))).toBe('decompose');
  });
});

describe('solidMeshGeoms', () => {
  it('ignores negatives, derived geoms and visual-only geoms', () => {
    const node = body([
      meshGeom(cupMesh(), { name: 'real' }),
      meshGeom(boxMesh(), { name: 'hole', csg: 'difference' }),
      meshGeom(boxMesh(), { name: 'derived', csgDerived: 'collider' }),
      meshGeom(boxMesh(), { name: 'decor', role: 'visual' }),
      { name: 'prim', type: 'box', size: [1, 1, 1] },
    ]);
    expect(solidMeshGeoms(node).map(g => g.name)).toEqual(['real']);
  });
});
