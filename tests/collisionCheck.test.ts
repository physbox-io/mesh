import { describe, it, expect } from 'vitest';
import { belowFloor, boundsOverlaps, contactOverlaps } from '../src/utils/collisionCheck';
import type { SceneGeom, SceneJoint, SceneNode } from '../src/types/scene';

function body(
  id: string,
  geoms: Partial<SceneGeom>[],
  opts: { pos?: number[]; euler?: number[]; joints?: Partial<SceneJoint>[]; children?: SceneNode[] } = {},
): SceneNode {
  return {
    id,
    name: id,
    type: 'body',
    pos: opts.pos ?? [0, 0, 0],
    ...(opts.euler ? { euler: opts.euler } : {}),
    geoms: geoms.map((g, i) => ({ name: `${id}_g${i}`, ...g }) as SceneGeom),
    joints: (opts.joints ?? []) as SceneJoint[],
    children: opts.children ?? [],
  };
}

const hinge = [{ name: 'h', type: 'hinge' as const, axis: [0, 1, 0] }];
const free = [{ name: 'f', type: 'free' as const }];

/**
 * A 300 mm Ferris wheel: a static tower, a wheel on a hinge, turned to stand
 * upright, and eight gondolas hung on hinges round its rim — about 115 mm
 * apart, each a 30 mm box. The old check padded every body origin by 100 mm
 * and reported dozens of pairs here.
 */
function ferrisWheel(): SceneNode[] {
  const gondolas = Array.from({ length: 8 }, (_, i) => {
    const a = (i / 8) * 2 * Math.PI;
    return body(`gondola${i}`, [{ type: 'box', size: [0.015, 0.015, 0.015] }], {
      pos: [0.15 * Math.cos(a), 0.15 * Math.sin(a), 0],
      joints: hinge,
    });
  });
  const spokes = Array.from({ length: 4 }, (_, i) => {
    const a = (i / 4) * Math.PI;
    return {
      type: 'capsule' as const,
      size: [0.002],
      fromto: [-0.13 * Math.cos(a), -0.13 * Math.sin(a), 0, 0.13 * Math.cos(a), 0.13 * Math.sin(a), 0],
    };
  });
  const wheel = body('wheel', spokes, { pos: [0, 0, 0.17], euler: [90, 0, 0], joints: hinge, children: gondolas });
  const tower = body('tower', [{ type: 'box', size: [0.01, 0.01, 0.075], pos: [0, 0.03, 0.075] }], { children: [wheel] });
  return [tower];
}

describe('boundsOverlaps', () => {
  it('finds nothing in a Ferris wheel whose gondolas hang clear of each other', () => {
    expect(boundsOverlaps(ferrisWheel())).toEqual([]);
  });

  it('reports two free bodies placed inside one another, with the depth', () => {
    const pairs = boundsOverlaps([
      body('a', [{ type: 'box', size: [0.02, 0.02, 0.02] }], { pos: [0, 0, 0.1], joints: free }),
      body('b', [{ type: 'sphere', size: [0.01] }], { pos: [0.025, 0, 0.1], joints: free }),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ bodyA: 'a', bodyB: 'b' });
    expect(pairs[0].depthMm).toBeCloseTo(5, 3);
  });

  it("follows a geom's own offset rather than the body origin", () => {
    const pairs = boundsOverlaps([
      body('a', [{ type: 'box', size: [0.01, 0.01, 0.01], pos: [0.2, 0, 0] }], { pos: [0, 0, 0.1], joints: free }),
      body('b', [{ type: 'box', size: [0.01, 0.01, 0.01] }], { pos: [0, 0, 0.1], joints: free }),
    ]);
    expect(pairs).toEqual([]);
  });

  it('skips geoms with contact switched off, and visual-only ones', () => {
    const nodes = [
      body('a', [{ type: 'box', size: [0.02, 0.02, 0.02], contype: 0, conaffinity: 0 }], { pos: [0, 0, 0.1], joints: free }),
      body('b', [{ type: 'box', size: [0.02, 0.02, 0.02], role: 'visual' }], { pos: [0, 0, 0.1], joints: free }),
      body('c', [{ type: 'box', size: [0.02, 0.02, 0.02] }], { pos: [0, 0, 0.1], joints: free }),
    ];
    expect(boundsOverlaps(nodes)).toEqual([]);
  });

  it('skips a pair whose contact bits never meet', () => {
    const nodes = [
      body('a', [{ type: 'box', size: [0.02, 0.02, 0.02], contype: 2, conaffinity: 2 }], { pos: [0, 0, 0.1], joints: free }),
      body('b', [{ type: 'box', size: [0.02, 0.02, 0.02], contype: 1, conaffinity: 1 }], { pos: [0, 0, 0.1], joints: free }),
    ];
    expect(boundsOverlaps(nodes)).toEqual([]);
  });

  it('skips a body and the one it hangs off, and anything fixed to either', () => {
    const seat = body('seat', [{ type: 'box', size: [0.02, 0.02, 0.02] }]);
    const gondola = body('gondola', [{ type: 'box', size: [0.02, 0.02, 0.02] }], { joints: hinge, children: [seat] });
    const arm = body('arm', [{ type: 'box', size: [0.05, 0.05, 0.05] }], { pos: [0, 0, 0.2], joints: free, children: [gondola] });
    expect(boundsOverlaps([arm])).toEqual([]);
  });

  it('still reports a grandchild on its own joint against its grandparent', () => {
    const grandchild = body('gc', [{ type: 'box', size: [0.02, 0.02, 0.02] }], { joints: hinge });
    const child = body('c', [{ type: 'box', size: [0.005, 0.005, 0.005] }], { pos: [0.2, 0, 0], joints: hinge, children: [grandchild] });
    grandchild.pos = [-0.2, 0, 0];
    const root = body('r', [{ type: 'box', size: [0.05, 0.05, 0.05] }], { pos: [0, 0, 0.2], joints: free, children: [child] });
    expect(boundsOverlaps([root]).map((p) => [p.bodyA, p.bodyB])).toEqual([['r', 'gc']]);
  });

  it('skips two bodies both fixed to the world', () => {
    expect(boundsOverlaps([
      body('base', [{ type: 'box', size: [0.05, 0.05, 0.05] }]),
      body('post', [{ type: 'box', size: [0.01, 0.01, 0.2] }]),
    ])).toEqual([]);
  });

  it('reads a mesh by its vertices, not its placeholder size [1]', () => {
    const tet = {
      type: 'mesh' as const,
      size: [1],
      renderVertices: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0, 0, 0, 0.01],
      faces: [0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3],
    };
    expect(boundsOverlaps([
      body('m', [tet], { pos: [0, 0, 0.1], joints: free }),
      body('n', [{ type: 'sphere', size: [0.01] }], { pos: [0.1, 0, 0.1], joints: free }),
    ])).toEqual([]);
  });
});

describe('belowFloor', () => {
  it('reports a free body sunk into the floor and leaves a resting one alone', () => {
    const sunk = belowFloor([
      body('sunk', [{ type: 'box', size: [0.02, 0.02, 0.02] }], { pos: [0, 0, 0.01], joints: free }),
      body('resting', [{ type: 'box', size: [0.02, 0.02, 0.02] }], { pos: [0.1, 0, 0.02], joints: free }),
      body('static', [{ type: 'box', size: [0.02, 0.02, 0.02] }], { pos: [0.2, 0, 0] }),
    ]);
    expect(sunk.map((s) => s.body)).toEqual(['sunk']);
    expect(sunk[0].depthMm).toBeCloseTo(10, 3);
  });
});

describe('contactOverlaps', () => {
  it('maps contact geoms back to bodies, keeps the deepest per pair, and ignores resting contact', () => {
    const nodes = [
      body('a', [{ type: 'box', size: [0.02, 0.02, 0.02], name: 'a_box' }], { joints: free }),
      body('b', [{ type: 'mesh', size: [1], name: 'b_mesh' }], { joints: free }),
    ];
    const pairs = contactOverlaps([
      { geom1: 'a_box', geom2: 'b_mesh_csg_col0', dist: -0.002 },
      { geom1: 'b_mesh_csg_col1', geom2: 'a_box', dist: -0.004 },
      { geom1: 'a_box', geom2: 'floor', dist: -0.00001 },
    ], nodes);
    expect(pairs).toEqual([{ bodyA: 'a', bodyB: 'b', geomA: 'a_box', geomB: 'b_mesh_csg_col1', depthMm: 4 }]);
  });
});
