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

/** Perpends on the wall's front face (y = -107.5) within 25 mm of one in the course below. */
function straightJoints(bricks: PlacedBrick[], courses: number): number {
  const gaps = new Map<number, number[]>();
  for (let c = 0; c < courses; c++) {
    const ends = bricks
      .filter((b) => b.course === c && Math.abs(Math.sin(b.angle)) < 0.01 && Math.abs(b.y - (-107.5 + b.depthMm / 2)) < 2)
      .map((b) => [b.x - b.lengthMm / 2, b.x + b.lengthMm / 2]).sort((a, b) => a[0] - b[0]);
    gaps.set(c, ends.slice(1).flatMap((e, i) => (e[0] - ends[i][1] < 30 ? [(e[0] + ends[i][1]) / 2] : [])));
  }
  let n = 0;
  for (let c = 1; c < courses; c++) for (const x of gaps.get(c)!) if (gaps.get(c - 1)!.some((y) => Math.abs(y - x) < 25)) n++;
  return n;
}

describe('laying a shape in brick', () => {
  it('lays a half-brick wall in stretcher bond, half bats at the stopped ends', () => {
    const r = layBricks(halfBrickWall);
    expect(r.courses).toBe(13);
    expect(Math.round(r.builtHeightMm)).toBe(965);
    // Nine bricks a course, the alternate courses starting with a half bat at each end.
    expect(r.bricks.filter((b) => b.course === 0).length).toBe(9);
    expect(r.bricks.filter((b) => b.course === 1).length).toBe(10);
    expect(r.cuts).toEqual([{ lengthMm: 100, count: 12 }]);
    expect(overlaps(r.bricks)).toBe(0);
    expect(r.lintels).toEqual([]);
  });

  for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
    it(`bonds a one-brick wall in ${bond} bond with no straight joints, and spans its gateway`, () => {
      const r = layBricks(gateway, { bond });
      expect(overlaps(r.bricks)).toBe(0);
      expect(straightJoints(r.bricks, r.courses)).toBe(0);
      // 600 mm opening, 150 mm bearing each end.
      expect(r.lintels).toEqual([{ lengthMm: 900, count: 1 }]);
      if (bond !== 'stretcher') {
        expect(r.bricks.some((b) => b.header)).toBe(true);
        // Queen closers beside the corner headers, two from a brick.
        expect(r.closers).toBeGreaterThan(0);
      }
      expect(r.warnings).toEqual([]);
    });
  }

  it('bonds the corners of a room and finds no opening in it', () => {
    for (const bond of ['stretcher', 'english', 'flemish'] as BrickBond[]) {
      const r = layBricks(room, { bond });
      expect(overlaps(r.bricks)).toBe(0);
      expect(r.lintels).toEqual([]);
      expect(r.warnings).toEqual([]);
      // 10 m of one-brick wall a metre high: about 120 bricks a square metre.
      expect(r.toBuy).toBeGreaterThan(1100);
      expect(r.toBuy).toBeLessThan(1300);
    }
  });

  it('lays a round tower on the curve, lapped half a brick course to course', () => {
    const r = layBricks(tower);
    expect(overlaps(r.bricks)).toBe(0);
    const firstAngles = (c: number) => r.bricks.filter((b) => b.course === c).map((b) => Math.atan2(b.y, b.x)).sort((a, b) => a - b)[0];
    // The joints do not run up the tower in line.
    expect(Math.abs(firstAngles(0) - firstAngles(1))).toBeGreaterThan(0.03);
  });

  it('says what to change when it cannot', () => {
    const tiny = scene([box('t', 0, 0, 0.02, 0.03, 0.03, 0.02)]);
    expect(() => layBricks(tiny)).toThrow(/smaller than a UK standard/);
    // In miniature bricks it lays.
    expect(layBricks(tiny, { standardId: 'mini_12' }).bricks.length).toBeGreaterThan(10);
    // A 40 m wall 10 m high is far more bricks than can be drawn.
    const huge = scene([box('h', 0, 0, 5, 20, 0.1075, 5)]);
    expect(() => layBricks(huge)).toThrow(new RegExp(`more than ${MAX_BRICKS.toLocaleString()}`));
  });

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
