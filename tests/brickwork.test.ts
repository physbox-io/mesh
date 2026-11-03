import { describe, it, expect } from 'vitest';
import type { SceneGraph, SceneGeom } from '../src/types/scene';
import { brickworkInScene, layBricks, MAX_BRICKS, type BrickBond, type PlacedBrick } from '../src/utils/brickwork';

const box = (name: string, cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): SceneGeom =>
  ({ name, type: 'box', size: [hx, hy, hz], pos: [cx, cy, cz] }) as SceneGeom;
const scene = (geoms: SceneGeom[]): SceneGraph =>
  ({ nodes: [{ id: 'b', name: 'B', type: 'body', pos: [0, 0, 0], joints: [], children: [], geoms }] }) as unknown as SceneGraph;

/** 2 m of half-brick wall, 1 m high. */
const halfBrickWall = scene([box('w', 0, 0, 0.5, 1.0, 0.05, 0.5)]);
/** One-brick garden wall with a 600 mm gateway under a lintel course, and a return at one end. */
const gateway = scene([
  box('l', -0.9, 0, 0.6, 0.6, 0.1075, 0.6), box('r', 0.9, 0, 0.6, 0.6, 0.1075, 0.6),
  box('o', 0, 0, 1.05, 0.3, 0.1075, 0.15), box('ret', -1.3925, 0.6075, 0.6, 0.1075, 0.5, 0.6),
]);
/** A one-brick room, 3 × 2 m outside. */
const room = scene([
  box('n', 0, 1, 0.5, 1.5, 0.1075, 0.5), box('s', 0, -1, 0.5, 1.5, 0.1075, 0.5),
  box('e', 1.5, 0, 0.5, 0.1075, 1.1075, 0.5), box('w', -1.5, 0, 0.5, 0.1075, 1.1075, 0.5),
]);
/** A ring of 24 boxes: a round tower 1.8 m across. */
const tower = scene(Array.from({ length: 24 }, (_, i) => {
  const a = (i / 24) * 2 * Math.PI;
  return { name: `t${i}`, type: 'box', size: [0.14, 0.11, 0.5], pos: [Math.cos(a) * 0.9, Math.sin(a) * 0.9, 0.5], quat: [Math.cos((a + Math.PI / 2) / 2), 0, 0, Math.sin((a + Math.PI / 2) / 2)] } as SceneGeom;
}));

/** A round tower as a mesh: a ring of 64 sides, radii and height in metres. */
function meshRing(ro: number, ri: number, h: number, n = 64): SceneGraph {
  const v: number[] = [], f: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2, c = Math.cos(a), sn = Math.sin(a);
    v.push(ro * c, ro * sn, 0, ro * c, ro * sn, h, ri * c, ri * sn, 0, ri * c, ri * sn, h);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 4, b = ((i + 1) % n) * 4;
    f.push(a, b, b + 1, a, b + 1, a + 1, a + 2, a + 3, b + 3, a + 2, b + 3, b + 2, a + 1, b + 1, b + 3, a + 1, b + 3, a + 3, a, a + 2, b + 2, a, b + 2, b);
  }
  return scene([{ name: 'ring', type: 'mesh', size: [1], renderVertices: v, vertices: v, faces: f } as SceneGeom]);
}

/** Pairs of bricks in one course whose footprints overlap (by separating axes, 1 mm grace). */
function overlaps(bricks: PlacedBrick[]): number {
  const corners = (b: PlacedBrick) => {
    const u = [Math.cos(b.angle), Math.sin(b.angle)], v = [-u[1], u[0]];
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => [b.x + (u[0] * a * b.lengthMm + v[0] * c * b.depthMm) / 2, b.y + (u[1] * a * b.lengthMm + v[1] * c * b.depthMm) / 2]);
  };
  const apart = (A: number[][], B: number[][]) => [A, B].some((P) => P.some((_, i) => {
    const e = [P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]];
    const l = Math.hypot(e[0], e[1]);
    const ax = [-e[1] / l, e[0] / l];
    const pa = A.map((p) => p[0] * ax[0] + p[1] * ax[1]), pb = B.map((p) => p[0] * ax[0] + p[1] * ax[1]);
    return Math.min(...pa) >= Math.max(...pb) - 1 || Math.min(...pb) >= Math.max(...pa) - 1;
  }));
  let n = 0;
  const byCourse = new Map<number, number[][][]>();
  for (const b of bricks) (byCourse.get(b.course) ?? byCourse.set(b.course, []).get(b.course)!).push(corners(b));
  for (const list of byCourse.values()) for (let i = 0; i < list.length; i++) for (let k = i + 1; k < list.length; k++) if (!apart(list[i], list[k])) n++;
  return n;
}

/*
 * Bond, as utils/brickBond.ts reads it: pieces (does it hold together),
 * straightJoints (perpends lapped less than a quarter brick over one below).
 * Where a layout is right the figures are exact. Where it is not yet, the
 * figure is a ceiling at what was measured on 2026-11-02, so it cannot get
 * worse unnoticed: lower it when a change improves it, and do not raise it
 * without a measurement.
 */
describe('laying a shape in brick', () => {
  it('lays a half-brick wall in stretcher bond, every joint lapped', () => {
    const r = layBricks(halfBrickWall);
    expect(r.courses).toBe(13);
    expect(Math.round(r.builtHeightMm)).toBe(965);
    expect(overlaps(r.bricks)).toBe(0);
    expect(r.bond).toMatchObject({ pieces: 1, unsupported: 0, straightJoints: 0 });
    expect(r.lintels).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  // The gateway's walls are not a whole number of bricks long (the return is
  // a metre), so a header bond carries a broken bond up the return, one short
  // lap a course, as it does on site; walls drawn to the brick have none (the
  // box below). Ceilings at what was measured, 2026-11-02.
  for (const [bond, ceiling] of [['stretcher', 2], ['english', 24], ['flemish', 30]] as [BrickBond, number][]) {
    it(`sets out a one-brick gateway wall with a return in ${bond} bond, in one piece`, () => {
      const r = layBricks(gateway, { bond });
      expect(overlaps(r.bricks)).toBe(0);
      expect(r.bond.pieces).toBe(1);
      expect(r.bond.straightJoints).toBeLessThanOrEqual(ceiling);
      // 600 mm opening, 150 mm bearing each end.
      expect(r.lintels).toEqual([{ lengthMm: 900, count: 1 }]);
      if (bond !== 'stretcher') {
        expect(r.bricks.some((b) => b.header)).toBe(true);
        expect(r.closers).toBeGreaterThan(0);
      }
    });
  }

  it('sets out the corners of a room in every bond, in one piece', () => {
    for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
      const r = layBricks(room, { bond });
      expect(overlaps(r.bricks)).toBe(0);
      expect(r.lintels).toEqual([]);
      expect(r.bond.pieces).toBe(1);
      // A few in the first course over the base, where the bond starts.
      expect(r.bond.straightJoints).toBeLessThanOrEqual(4);
      // 10 m of one-brick wall a metre high: about 120 bricks a square metre.
      expect(r.toBuy).toBeGreaterThan(1100);
      expect(r.toBuy).toBeLessThan(1350);
    }
  });

  it('sets out English bond as on site: closer beside the quoin, whole bricks between', () => {
    // A one-brick wall round a box five bricks by four (1115 × 890): every
    // stretcher course whole bricks, every header course closer, headers,
    // closer, and not a brick cut.
    const box5 = scene([
      box('f', 0, -0.3375, 0.3, 0.5575, 0.1075, 0.3), box('b', 0, 0.3375, 0.3, 0.5575, 0.1075, 0.3),
      box('l', -0.45, 0, 0.3, 0.1075, 0.23, 0.3), box('r', 0.45, 0, 0.3, 0.1075, 0.23, 0.3),
    ]);
    const r = layBricks(box5, { bond: 'english' });
    expect(r.bond).toMatchObject({ pieces: 1, straightJoints: 0 });
    expect(r.cutPieces).toBe(0);
    expect(r.closers).toBeGreaterThan(0);
  });

  it('lays round towers on the curve in whole bricks, the joints opening as a curve\'s do', () => {
    // Half a brick thick, radius about a metre: one piece, every brick whole.
    const half = layBricks(meshRing(1.0075, 0.905, 1.0));
    expect(overlaps(half.bricks)).toBe(0);
    expect(half.cutPieces).toBe(0);
    expect(half.bond).toMatchObject({ pieces: 1, straightJoints: 0 });
    // So tight a curve opens the face joints well past 10 mm, and it says so.
    expect(half.warnings.join()).toMatch(/joints open to \d+ mm/);
    // A brick thick: in stretcher bond two leaves to tie; in English one piece.
    const leaves = layBricks(meshRing(1.0075, 0.7925, 1.0));
    expect(overlaps(leaves.bricks)).toBe(0);
    expect(leaves.cutPieces).toBe(0);
    expect(leaves.bond).toMatchObject({ pieces: 2, sideBySide: 1, straightJoints: 0 });
    expect(leaves.warnings.join()).toMatch(/wall ties/);
    const english = layBricks(meshRing(1.0075, 0.7925, 1.0), { bond: 'english' });
    expect(overlaps(english.bricks)).toBe(0);
    expect(english.bond).toMatchObject({ pieces: 1, straightJoints: 0 });
    expect(english.cutPieces).toBeLessThanOrEqual(6);
    // A ring of overlapping boxes, its outline notched where they meet:
    // laid without a brick overlapping another.
    expect(overlaps(layBricks(tower).bricks)).toBe(0);
  });

  it('refuses a shape too small for the brick, naming the bricks that would do', async () => {
    const { PRESETS } = await import('../src/presets/presetScenes');
    const birdhouse = (PRESETS as unknown as Record<string, { scene: SceneGraph }>).birdhouse.scene;
    // 143 mm across: two courses of house brick is no birdhouse.
    expect(() => layBricks(birdhouse)).toThrow(/too small for UK standard .* bricks\. Choose .*Miniature 1:12.*Toy bricks/);
    const bird = layBricks(birdhouse, { standardId: 'mini_12' });
    expect(bird.courses).toBeGreaterThan(20);
    expect(overlaps(bird.bricks)).toBe(0);
    // A one-brick pier 600 mm tall is real brickwork, small as it is.
    expect(layBricks(scene([box('p', 0, 0, 0.3, 0.1075, 0.1075, 0.3)])).standard.id).toBe('uk');
    // A 40 m wall 10 m high is far more bricks than can be drawn.
    const huge = scene([box('h', 0, 0, 5, 20, 0.1075, 5)]);
    expect(() => layBricks(huge)).toThrow(new RegExp(`more than ${MAX_BRICKS.toLocaleString()}`));
  }, 60000);

  it('puts the bricks in the scene in place of the shape, or beside it', () => {
    const replaced = brickworkInScene(gateway, 'b', { placement: 'replace' });
    expect(replaced.nodes.some((n) => n.id === 'b')).toBe(false);
    expect(replaced.nodes.length).toBe(replaced.result.courses);
    expect(replaced.nodes.reduce((t, n) => t + n.geoms.length, 0)).toBe(replaced.result.bricks.length);
    const beside = brickworkInScene(gateway, null, { placement: 'beside' });
    expect(beside.nodes[0].id).toBe('b');
    // Past the wall along +X.
    expect(Math.min(...beside.nodes.slice(1).flatMap((n) => n.geoms.map((g) => g.pos![0])))).toBeGreaterThan(1.5);
  });
});

describe('toy bricks', () => {
  const wall = scene([box('w', 0, 0, 0.048, 0.08, 0.008, 0.048)]);

  it('builds a wall in one piece, no seam on the one below', () => {
    // 160 mm long, 2 studs thick, ten bricks tall. Two 2×10s a course is fewer
    // bricks, and splits the wall down the middle into two stacks.
    const r = layBricks(wall, { standardId: 'toy' });
    expect(r.courses).toBe(10);
    expect(overlaps(r.bricks)).toBe(0);
    expect(r.bond).toMatchObject({ pieces: 1, unsupported: 0, straightJoints: 0 });
    expect(r.bricks.length).toBeLessThanOrEqual(25);
    expect(r.parts!.reduce((n, p) => n + p.count, 0)).toBe(r.bricks.length);
    expect(r.mortarLitres).toBe(0);
  });

  it('uses only what the builder has, and says what it is short of', () => {
    // Four 2×10s and as many 2×4s as it takes.
    const r = layBricks(wall, { standardId: 'toy', toyInventory: { '2x10': 4, '2x4': null, '2x2': null } });
    expect(r.parts!.find((p) => p.size === '2x10')?.count ?? 0).toBeLessThanOrEqual(4);
    expect(new Set(r.parts!.map((p) => p.size))).toEqual(new Set(['2x10', '2x4', '2x2'].filter((s) => r.parts!.some((p) => p.size === s))));
    expect(r.bond.pieces).toBe(1);
    // A size nobody makes is fine if the builder has it.
    const custom = layBricks(wall, { standardId: 'toy', toyInventory: { '2x5': null, '2x2': null } });
    expect(custom.parts!.some((p) => p.size === '2x5')).toBe(true);
    // Not a 1×1 in hand, and one needed: said.
    const tight = layBricks(scene([box('t', 0, 0, 0.0048, 0.012, 0.004, 0.0048)]), { standardId: 'toy', toyInventory: { '1x2': null } });
    expect(tight.short).toEqual([{ size: '1x1', count: 1 }]);
    expect(tight.warnings.join()).toMatch(/Short of 1 × 1×1/);
  });

  it('tiles a block exactly from two-wide bricks, needing no 1×1', () => {
    // 80 × 80 studs-square block ten courses tall: 2×2s and 2×4s fill it, if
    // they are set out with an eye on the last row (one brick at a time can
    // leave a one-stud strip).
    const block = scene([box('t', 0.04, 0.04, 0.048, 0.04, 0.04, 0.048)]);
    const r = layBricks(block, { standardId: 'toy', toyInventory: { '2x2': null, '2x4': null } });
    expect(r.short).toEqual([]);
    expect(r.parts!.every((p) => p.size === '2x2' || p.size === '2x4')).toBe(true);
    expect(r.bond.pieces).toBe(1);
  });

  it('builds hollow when asked, the roof corbelled in, open underneath', () => {
    // 160 × 160 × 192: twenty courses, the hollow closed over in the top four.
    const block = scene([box('b', 0, 0, 0.096, 0.08, 0.08, 0.096)]);
    const solid = layBricks(block, { standardId: 'toy' });
    const hollow = layBricks(block, { standardId: 'toy', hollowStuds: 2 });
    const studs = (r: typeof solid) => r.bricks.reduce((t, b) => t + Math.round(b.lengthMm / 8) * Math.round(b.depthMm / 8), 0);
    expect(studs(hollow)).toBeLessThan(studs(solid) * 0.75);
    expect(hollow.bond).toMatchObject({ pieces: 1, unsupported: 0 });
    // The top course is full; the bottom one is the walls.
    const course = (r: typeof solid, c: number) => r.bricks.filter((b) => b.course === c).reduce((t, b) => t + Math.round(b.lengthMm / 8) * Math.round(b.depthMm / 8), 0);
    expect(course(hollow, hollow.courses - 1)).toBe(course(solid, solid.courses - 1));
    expect(course(hollow, 0)).toBe(20 * 20 - 16 * 16);
  });

  it('spans a gateway with bricks gripping studs beside it', async () => {
    const { toyCastlePreset } = await import('../src/presets/brickPresets');
    const { result: r } = brickworkInScene(toyCastlePreset, 'castle', { standardId: 'toy' });
    expect(r.bond).toMatchObject({ pieces: 1, unsupported: 0 });
    // Measured 3.
    expect(r.bond.straightJoints).toBeLessThanOrEqual(3);
  });
});
