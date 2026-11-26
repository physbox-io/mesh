import { describe, it, expect } from 'vitest';
import type { SceneGraph, SceneGeom, SceneNode } from '../src/types/scene';
import { brickworkInScene, layBricks, MAX_BRICKS, subjectScene, type BrickBond, type PlacedBrick } from '../src/utils/brickwork';

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

  for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
    it(`sets out a one-brick gateway wall with a return in ${bond} bond, in one piece`, () => {
      const r = layBricks(gateway, { bond });
      expect(overlaps(r.bricks)).toBe(0);
      expect(r.bond).toMatchObject({ pieces: 1, straightJoints: 0 });
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
      expect(r.bond).toMatchObject({ pieces: 1, straightJoints: 0 });
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

  it('buys mortar at the rate premix makers give, more for a wall of two leaves', () => {
    const wall = (t: number) => scene([box('w', 0, 0, 0.5, 2.25, t, 0.5)]);
    const half = layBricks(wall(0.05125));
    const perBag = (r: typeof half) => (r.bricks.length * 12.5) / r.mortarLitres;
    // Datasheets: 20 to 25 standard bricks to the 25 kg bag.
    expect(perBag(half)).toBeGreaterThan(20);
    expect(perBag(half)).toBeLessThan(28);
    // The collar joint between the leaves: half that joint again for each brick.
    const two = layBricks(wall(0.1075));
    expect(two.mortarLitres / two.bricks.length).toBeGreaterThan(half.mortarLitres / half.bricks.length * 1.1);
    // A scale-model brick is solid: joints and nothing else.
    const mini = layBricks(scene([box('w', 0, 0, 0.1, 0.4, 0.0085, 0.1)]), { standardId: 'mini_6' });
    const std = mini.standard;
    const joints = mini.bricks.reduce((t, b) => t + (b.lengthMm * mini.jointMm + std.heightMm * mini.jointMm + mini.jointMm ** 2) * b.depthMm, 0) * 1.1 / 1e6;
    expect(mini.mortarLitres).toBeCloseTo(joints, 6);
  });

  it('lists every brick shorter than whole as a cut, and buys a brick for each cut header', () => {
    // Off the brick's measure, so strips close with cuts.
    const offGauge = scene([
      box('f', 0, -1.291, 0.5, 2.2445, 0.1075, 0.5), box('b', 0, 1.291, 0.5, 2.2445, 0.1075, 0.5),
      box('l', -2.137, 0, 0.5, 0.1075, 1.1835, 0.5), box('r', 2.137, 0, 0.5, 0.1075, 1.1835, 0.5),
    ]);
    for (const bond of ['stretcher', 'english'] as BrickBond[]) {
      const r = layBricks(offGauge, { bond });
      const short = r.bricks.filter((b) => !b.closer && b.lengthMm < (b.header ? 102.5 : 215) - 5);
      expect(short.every((b) => b.cut)).toBe(true);
      // Every brick laid comes out of a brick, or shares one only as two stretcher cuts can.
      const headers = r.bricks.filter((b) => b.cut && b.header).length;
      const stretcherCuts = r.bricks.filter((b) => b.cut && !b.header).length;
      expect(r.toBuy).toBeGreaterThanOrEqual(r.whole + headers + Math.ceil(stretcherCuts / 2) + Math.ceil(r.closers / 2));
    }
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

  it('puts the bricks in the scene in place of the shape, or beside it', async () => {
    const { withUniqueNames } = await import('../src/utils/uniqueNames');
    const replaced = brickworkInScene(gateway, 'b', { placement: 'replace' });
    expect(replaced.nodes.some((n) => n.id === 'b')).toBe(false);
    expect(replaced.nodes.length).toBe(replaced.result.courses);
    expect(replaced.nodes.reduce((t, n) => t + n.geoms.length, 0)).toBe(
      replaced.result.bricks.length + (replaced.result.placedLintels?.length ?? 0),
    );
    const beside = brickworkInScene(gateway, null, { placement: 'beside' });
    expect(beside.nodes[0].id).toBe('b');
    // Past the wall along +X.
    expect(Math.min(...beside.nodes.slice(1).flatMap((n) => n.geoms.map((g) => g.pos![0])))).toBeGreaterThan(1.5);
    // Laying beside a second and third time (after uniqueNames renames courses to Course 1_2) never re-bricks laid courses.
    const second = withUniqueNames({ nodes: brickworkInScene({ nodes: beside.nodes }, null, { placement: 'beside' }).nodes });
    const third = brickworkInScene(second, null, { placement: 'beside' });
    expect(third.result.bricks.length).toBe(beside.result.bricks.length);
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
    // Only 2×4 ticked with too few in hand (even when a bigger ticked brick is still in stock): uses more 2×4s and reports short of 2×4, not 1×1.
    const twoByFourBlock = scene([box('b', 0, 0, 0.0096, 0.016, 0.016, 0.0096)]);
    const scarce2x4 = layBricks(twoByFourBlock, { standardId: 'toy', toyInventory: { '2x4': 2, '2x8': 2 } });
    expect(scarce2x4.parts).toEqual([{ size: '2x4', count: 4 }]);
    expect(scarce2x4.short).toEqual([{ size: '2x4', count: 2 }]);
    expect(scarce2x4.warnings.join()).toMatch(/Short of 2 × 2×4/);
    // Explicit toySizes or a different standardId overrides what was saved on scene.brickwork.
    const withSaved: SceneGraph = { ...wall, brickwork: { standardId: 'uk', jointMm: 10, toyInventory: { '2x4': 2 } } };
    expect(layBricks(withSaved, { standardId: 'mini_12' }).jointMm).toBe(0.8);
    expect(layBricks(withSaved, { standardId: 'toy', toySizes: ['2x4', '2x2'] }).short).toEqual([]);
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
    // toyCastlePreset carries brickwork: { standardId: 'toy' } on the scene.
    const { result: r } = brickworkInScene(toyCastlePreset, 'castle');
    expect(r.standard.id).toBe('toy');
    expect(r.bond).toMatchObject({ pieces: 1, unsupported: 0 });
    // Measured 3.
    expect(r.bond.straightJoints).toBeLessThanOrEqual(3);
  });
});

/** Pairs of bricks in one course whose footprints overlap at all (exact separating axes, no grace). */
function strictOverlaps(bricks: PlacedBrick[]): number {
  const corners = (b: PlacedBrick) => {
    const u = [Math.cos(b.angle), Math.sin(b.angle)], v = [-u[1], u[0]];
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, c]) => [b.x + (u[0] * a * b.lengthMm + v[0] * c * b.depthMm) / 2, b.y + (u[1] * a * b.lengthMm + v[1] * c * b.depthMm) / 2]);
  };
  const apart = (A: number[][], B: number[][]) => [A, B].some((P) => P.some((_, i) => {
    const e = [P[(i + 1) % 4][0] - P[i][0], P[(i + 1) % 4][1] - P[i][1]];
    const l = Math.hypot(e[0], e[1]);
    const ax = [-e[1] / l, e[0] / l];
    const pa = A.map((p) => p[0] * ax[0] + p[1] * ax[1]), pb = B.map((p) => p[0] * ax[0] + p[1] * ax[1]);
    return Math.min(...pa) >= Math.max(...pb) - 1e-6 || Math.min(...pb) >= Math.max(...pa) - 1e-6;
  }));
  let n = 0;
  const byCourse = new Map<number, number[][][]>();
  for (const b of bricks) (byCourse.get(b.course) ?? byCourse.set(b.course, []).get(b.course)!).push(corners(b));
  for (const list of byCourse.values()) for (let i = 0; i < list.length; i++) for (let k = i + 1; k < list.length; k++) if (!apart(list[i], list[k])) n++;
  return n;
}

/** A box from two corners, metres. */
const span = (name: string, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): SceneGeom =>
  box(name, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (y1 - y0) / 2, (z1 - z0) / 2);

describe('regressions from the brickwork audit (#22)', () => {
  /** A T-junction: a main wall and a stem butting into its inner face, both `tMm` thick. */
  const tJunction = (L: number, j: number, H: number, tMm: number, armBricks = 5, courses = 6) => {
    const arm = (armBricks * (L + j)) / 1000, t = tMm / 1000, h = (courses * (H + j)) / 1000;
    return scene([span('main', -arm, arm, 0, t, 0, h), span('stem', -t / 2, t / 2, t, t + arm, 0, h)]);
  };

  it('lays T-junctions with small joints without a single brick passing into another (1)', () => {
    for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
      // mini_12: j = 0.8 mm, a one-brick T and one at its own measure (2W + j).
      for (const t of [18, 17.8]) {
        const r = layBricks(tJunction(18, 0.8, 5.5, t), { standardId: 'mini_12', bond });
        expect(strictOverlaps(r.bricks)).toBe(0);
        expect(r.bond.pieces).toBe(1);
      }
      // UK brick on a 0.8 mm joint, and mini_6 one brick thick.
      expect(strictOverlaps(layBricks(tJunction(215, 0.8, 65, 215), { bond, jointMm: 0.8 }).bricks)).toBe(0);
      expect(strictOverlaps(layBricks(tJunction(36, 1.6, 11, 36), { standardId: 'mini_6', bond }).bricks)).toBe(0);
    }
  }, 120000);

  it('finds every opening and its lintel in a room with a door and a window, in every bond (2)', () => {
    const sx = 2.69 / 2, sy = 2.015 / 2, t = 0.215, H = 1.5;
    const roomWinDoor = scene([
      span('fl', -sx, -0.445, -sy, -sy + t, 0, 1.2), span('fr', 0.445, sx, -sy, -sy + t, 0, 1.2), span('ft', -sx, sx, -sy, -sy + t, 1.2, H),
      span('bk', -sx, sx, sy - t, sy, 0, H), span('lf', -sx, -sx + t, -sy + t, sy - t, 0, H),
      span('rb', sx - t, sx, -sy + t, sy - t, 0, 0.45), span('rl', sx - t, sx, -sy + t, -0.445, 0.45, 1.125),
      span('rr', sx - t, sx, 0.445, sy - t, 0.45, 1.125), span('rt', sx - t, sx, -sy + t, sy - t, 1.125, H),
    ]);
    for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
      const r = layBricks(roomWinDoor, { bond });
      expect(r.lintels.reduce((n, l) => n + l.count, 0)).toBe(2);
      expect(r.bond.unsupported).toBe(0);
      expect(strictOverlaps(r.bricks)).toBe(0);
    }
  }, 120000);

  it('keeps a two-leaf return its full thickness beside a narrow corner pier (3)', () => {
    const nearCornerWin = scene([
      span('front_l', 0, 0.12, 0, 0.215, 0, 1.125), span('front_r', 0.72, 1.6, 0, 0.215, 0, 1.125),
      span('front_top', 0, 1.6, 0, 0.215, 1.125, 1.35), span('ret', 0, 0.215, 0.215, 1.2, 0, 1.35),
    ]);
    const stretcher = layBricks(nearCornerWin, { bond: 'stretcher' });
    expect(stretcher.bond.straightJoints).toBe(0);
    expect(strictOverlaps(stretcher.bricks)).toBe(0);
    const english = layBricks(nearCornerWin, { bond: 'english' });
    expect(english.warnings.join()).not.toMatch(/half-brick wall|would stick out/);
    expect(strictOverlaps(english.bricks)).toBe(0);
  }, 60000);

  it('never lays a header longer than a brick, stays quick on a half-millimetre joint, and bonds junctions (4)', () => {
    const w220 = layBricks(scene([span('w', 0, 1.5, 0, 0.22, 0, 0.6)]), { bond: 'english' });
    expect(Math.max(...w220.bricks.map((b) => b.depthMm))).toBeLessThanOrEqual(215);
    const t0 = Date.now();
    const thin = layBricks(scene([span('w', 0, 2.0, 0, 0.215, 0, 0.6)]), { bond: 'stretcher', jointMm: 0.5 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(strictOverlaps(thin.bricks)).toBe(0);
    // T-junctions and cross-junctions splice across the winning axis on alternate courses.
    for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
      const tOne = layBricks(tJunction(215, 10, 65, 215), { bond });
      expect(tOne.bond).toMatchObject({ pieces: 1, straightJoints: 0 });
      expect(strictOverlaps(tOne.bricks)).toBe(0);
    }
    const cross = scene([span('x', -1.125, 1.125, -0.1075, 0.1075, 0, 0.6), span('y', -0.1075, 0.1075, -1.125, 1.125, 0, 0.6)]);
    for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
      const r = layBricks(cross, { bond });
      expect(r.bond).toMatchObject({ pieces: 1, sideBySide: 0, unsupported: 0 });
      expect(r.bond.straightJoints).toBeLessThanOrEqual(bond === 'english' ? 3 : 0);
      expect(strictOverlaps(r.bricks)).toBe(0);
    }
    const crossOffGauge = scene([
      span('ew', -1, 1, -0.1075, 0.1075, 0, 0.6),
      span('ns1', -0.1075, 0.1075, 0.1075, 1, 0, 0.6),
      span('ns2', -0.1075, 0.1075, -1, -0.1075, 0, 0.6),
    ]);
    for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
      const r = layBricks(crossOffGauge, { bond });
      expect(r.bond).toMatchObject({ pieces: 1, sideBySide: 0, unsupported: 0 });
      expect(r.bond.straightJoints).toBeLessThanOrEqual(10);
      expect(strictOverlaps(r.bricks)).toBe(0);
    }
  }, 60000);

  it('corbels a hollow toy block in without a brick over air, and ties a two-stud T together (5, 6)', async () => {
    const block = scene([span('b', 0, 16 * 0.008, 0, 16 * 0.008, 0, 12 * 0.0096)]);
    for (const hollowStuds of [1, 2]) {
      const r = layBricks(block, { standardId: 'toy', hollowStuds });
      expect(r.bond).toMatchObject({ pieces: 1, unsupported: 0 });
      expect(strictOverlaps(r.bricks)).toBe(0);
    }
    const { toyCastlePreset } = await import('../src/presets/brickPresets');
    expect(brickworkInScene(toyCastlePreset, 'castle', { standardId: 'toy', hollowStuds: 2 }).result.bond.unsupported).toBe(0);
    const toyT = scene([span('main', 0, 20 * 0.008, 0, 2 * 0.008, 0, 8 * 0.0096), span('stem', 9 * 0.008, 11 * 0.008, 2 * 0.008, 12 * 0.008, 0, 8 * 0.0096)]);
    const t = layBricks(toyT, { standardId: 'toy' });
    expect(t.bond).toMatchObject({ pieces: 1, sideBySide: 0 });
    expect(strictOverlaps(t.bricks)).toBe(0);
  }, 60000);

  it('never lays a hinged child of a fixed body, and refuses a jointed body named outright (7)', async () => {
    const house: SceneGraph = {
      nodes: [{
        id: 'house', name: 'House', type: 'body', pos: [0, 0, 0], joints: [],
        geoms: [span('wall', 0, 1.2, 0, 0.215, 0, 0.6)],
        children: [{
          id: 'child_door', name: 'Door', type: 'body', pos: [2.0, 0, 0],
          joints: [{ name: 'h', type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0] }], children: [],
          geoms: [span('door', 0, 0.8, 0, 0.1025, 0, 0.6)],
        } as unknown as SceneNode],
      } as unknown as SceneNode],
    };
    const r = layBricks(subjectScene(house, null));
    expect(r.bricks.filter((b) => b.x > 1500).length).toBe(0);
    // Replaced in place, the hinged door stays in the scene.
    const replaced = brickworkInScene(house, null, { placement: 'replace' });
    const ids = (ns: SceneNode[]): string[] => ns.flatMap((n) => [n.id, ...ids(n.children ?? [])]);
    expect(ids(replaced.nodes)).toContain('child_door');
    const { smokerPreset } = await import('../src/presets/brickPresets');
    expect(() => subjectScene(smokerPreset, 'smoker_door')).toThrow(/has a joint/);
  }, 60000);

  it('resolves bodyId by name, reports closers, accepts custom AxB toySizes, and validates options in MCP (8)', async () => {
    if (typeof globalThis.navigator === 'undefined') {
      Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 2 }, configurable: true });
    }
    const { brickCommands } = await import('../src/hooks/mcp/brickCommands');
    const { smokerPreset } = await import('../src/presets/brickPresets');
    const { useStore } = await import('../src/store/useStore');
    const ctx = { store: { ...useStore.getState(), sceneGraph: smokerPreset } } as Parameters<typeof brickCommands.BUILD_BRICKWORK>[1];
    // Lookup by display name ('Smoker walls' -> id 'smoker_walls') with placement: 'none'.
    const byName = await brickCommands.BUILD_BRICKWORK({ bodyId: 'Smoker walls', bond: 'stretcher', placement: 'none' }, ctx) as Record<string, unknown>;
    expect(byName.ok).toBe(true);
    expect(byName.laid).toBe(false);
    expect(byName.bricksLaid).toBe(259);
    expect(byName.closers).toBe(0);
    // English bond reply includes queen closers, and whole + cutPieces + closers === bricksLaid.
    const ctxGateway = { store: { ...useStore.getState(), sceneGraph: gateway } } as Parameters<typeof brickCommands.BUILD_BRICKWORK>[1];
    const eng = await brickCommands.BUILD_BRICKWORK({ bodyId: 'B', bond: 'english', placement: 'none' }, ctxGateway) as Record<string, unknown>;
    expect(eng.ok).toBe(true);
    expect(eng.closers as number).toBeGreaterThan(0);
    expect((eng.whole as number) + (eng.cutPieces as number) + (eng.closers as number)).toBe(eng.bricksLaid);
    // Custom AxB toySizes ('2x5') accepted via normalToySize.
    const toyWall = scene([box('tw', 0, 0, 0.048, 0.08, 0.008, 0.048)]);
    const ctxToy = { store: { ...useStore.getState(), sceneGraph: toyWall } } as Parameters<typeof brickCommands.BUILD_BRICKWORK>[1];
    const customToy = await brickCommands.BUILD_BRICKWORK({ standardId: 'toy', toySizes: ['2x5', '2x2'], placement: 'none' }, ctxToy) as Record<string, unknown>;
    expect(customToy.ok).toBe(true);
    expect((customToy.parts as { size: string }[]).some((p) => p.size === '2x5')).toBe(true);
    // Invalid jointMm, wastagePct, placement, and hinged explicit bodyId are rejected cleanly.
    expect((await brickCommands.BUILD_BRICKWORK({ jointMm: 0, placement: 'none' }, ctxGateway) as Record<string, unknown>).ok).toBe(false);
    expect((await brickCommands.BUILD_BRICKWORK({ jointMm: -2, placement: 'none' }, ctxGateway) as Record<string, unknown>).ok).toBe(false);
    expect((await brickCommands.BUILD_BRICKWORK({ wastagePct: -5, placement: 'none' }, ctxGateway) as Record<string, unknown>).ok).toBe(false);
    expect((await brickCommands.BUILD_BRICKWORK({ placement: 'bogus' }, ctxGateway) as Record<string, unknown>).ok).toBe(false);
    expect((await brickCommands.BUILD_BRICKWORK({ bodyId: 'Door', placement: 'none' }, ctx) as Record<string, unknown>).ok).toBe(false);
  }, 60000);
});
