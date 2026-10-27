import { describe, it, expect } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { buildPipeSkeleton, defaultMaxSpanMm, skeletonToNodes } from '../src/utils/pipeSkeleton';
import { PIPE_STANDARDS, breakdownPipeFrame } from '../src/utils/tubeAndWireExporter';
import { createLattice, vertexAt, addFace, addWire, serializeCage } from '../src/utils/latticeMesh';
import { simulatePipeFrame } from '../src/utils/tubeSimulation';

const box = (sx: number, sy: number, sz: number, z0 = 0): SceneGraph => ({
  nodes: [{ id: 'b', name: 'Box', pos: [0, 0, z0 + sz / 2], geoms: [{ name: 'g', type: 'box', size: [sx / 2, sy / 2, sz / 2] }], joints: [], children: [] } as SceneNode],
} as unknown as SceneGraph);

const lenOf = (sk: ReturnType<typeof buildPipeSkeleton>, m: { a: number; b: number }) =>
  Math.hypot(...sk.nodes[m.a].map((v, k) => v - sk.nodes[m.b][k]));

describe('pipe skeleton', () => {
  it('spans 3/4" PVC about as far as the support tables, and steel EMT further', () => {
    const pvc = defaultMaxSpanMm(PIPE_STANDARDS.pvc_sch40_3_4);
    expect(pvc).toBeGreaterThan(1400);
    expect(pvc).toBeLessThan(1700);
    const emt = Object.values(PIPE_STANDARDS).find((s) => s.material === 'emt')!;
    expect(defaultMaxSpanMm(emt)).toBeGreaterThan(pvc);
  });

  it('frames a small box as its twelve edges', () => {
    const sk = buildPipeSkeleton(box(1, 0.8, 0.6), 'b');
    expect(sk.source).toBe('solid');
    expect(sk.members.length).toBe(12);
    expect(sk.nodes.length).toBe(8);
  });

  it('fills a box bigger than the span so no pipe runs further than it', () => {
    const sk = buildPipeSkeleton(box(3.2, 2, 2.1), 'b', { maxSpanMm: 1200 });
    // Posts stand in compression: the span is for what bends.
    const longest = Math.max(...sk.members.filter((m) => m.kind !== 'post').map((m) => lenOf(sk, m)));
    expect(longest).toBeLessThanOrEqual(1200 + 1);
    // The roof is wider than the span both ways, so its middle joints stand on posts.
    expect(sk.members.filter((m) => m.kind === 'post').length).toBe(2);
    // Nothing under the floor's face but its edges.
    expect(sk.members.some((m) => sk.nodes[m.a][2] < 1 && sk.nodes[m.b][2] < 1 && m.kind === 'rail')).toBe(false);
  });

  it('frames a sphere as facets about a span across', () => {
    const scene = { nodes: [{ id: 's', name: 'Dome', pos: [0, 0, 1.2], geoms: [{ name: 'g', type: 'sphere', size: [1.2] }], joints: [], children: [] }] } as unknown as SceneGraph;
    const sk = buildPipeSkeleton(scene, 's');
    const lens = sk.members.filter((m) => m.kind !== 'post' && m.kind !== 'base').map((m) => lenOf(sk, m));
    expect(sk.members.length).toBeGreaterThan(20);
    // Facet corners are on the sphere; a joint added across a facet still
    // wider than the span lies on the flat facet, inside the curve.
    const off = sk.nodes.filter((p) => Math.abs(p[2]) > 1 && Math.abs(Math.hypot(p[0], p[1], p[2] - 1200) - 1200) > 15);
    expect(off.length).toBeLessThanOrEqual(sk.nodes.length * 0.1);
    expect(Math.max(...lens)).toBeLessThanOrEqual(sk.maxSpanMm + 1);
  });

  it('stands a rectangle sketched 750 mm up on posts, with more under a long side', () => {
    const lat = createLattice(0.001);
    const v = (x: number, y: number) => vertexAt(lat, x, y, 750);
    addWire(lat, [v(0, 0), v(4000, 0), v(4000, 800), v(0, 800), v(0, 0)]);
    const scene = { nodes: [{ id: 'k', name: 'Sketch', pos: [0, 0, 0], isLattice: true, latticeCage: serializeCage(lat), geoms: [], joints: [], children: [] }] } as unknown as SceneGraph;
    const sk = buildPipeSkeleton(scene, 'k', { maxSpanMm: 1500 });
    const posts = sk.members.filter((m) => m.kind === 'post');
    const base = sk.members.filter((m) => m.kind === 'base');
    // Corners, and two along each 4 m side.
    expect(posts.length).toBe(4 + 2 * 2);
    expect(base.length).toBe(posts.length);
    expect(Math.max(...sk.members.map((m) => lenOf(sk, m)))).toBeLessThanOrEqual(1500 + 1);
  });

  it('adds diagonals only when asked, one per panel', () => {
    const plain = buildPipeSkeleton(box(1, 0.8, 0.6), 'b');
    const braced = buildPipeSkeleton(box(1, 0.8, 0.6), 'b', { diagonals: true });
    expect(plain.members.some((m) => m.kind === 'brace')).toBe(false);
    expect(braced.members.filter((m) => m.kind === 'brace').length).toBe(6);
  });

  it('comes out as struts and fittings the cut list and the simulation read with no gap', () => {
    const sk = buildPipeSkeleton(box(3.2, 2, 2.1), 'b', { maxSpanMm: 1200, diagonals: true });
    const nodes = skeletonToNodes(sk, 'pvc_sch40_3_4', 'f1');
    const bd = breakdownPipeFrame({ nodes } as unknown as SceneGraph);
    expect(bd.struts.length).toBe(sk.members.length);
    const sim = simulatePipeFrame(bd);
    expect(sim.maxGapMm).toBeLessThan(0.05);
  });
});

describe('framing a body in the scene', () => {
  it('replaces the body with its frame, or stands the frame beside it', async () => {
    const { frameBodyInScene } = await import('../src/utils/pipeSkeleton');
    const scene = box(1, 0.8, 0.6);
    const replaced = frameBodyInScene(scene, 'b');
    expect(replaced.nodes.some((n) => n.id === 'b')).toBe(false);
    expect(replaced.nodes.length).toBe(replaced.added);
    const beside = frameBodyInScene(scene, 'b', { placement: 'beside' });
    expect(beside.nodes[0].id).toBe('b');
    // Clear of the 1 m box along +X.
    const xs = beside.nodes.slice(1).flatMap((n) => n.geoms?.[0]?.fromto ? [n.geoms[0].fromto[0], n.geoms[0].fromto[3]] : []);
    expect(Math.min(...xs)).toBeGreaterThan(0.5);
    // Every pipe in the frame has the cut list's attention, and a fitting at both ends.
    const bd = breakdownPipeFrame({ nodes: replaced.nodes } as unknown as SceneGraph);
    expect(bd.struts.length).toBe(12);
    expect(replaced.nodes.length - 12).toBe(8);
  });
});

describe('shapes the pipes do not suit', () => {
  it('reads a model whose parts are children, and frames a small one in tube that suits it', async () => {
    const { PRESETS } = await import('../src/presets/presetScenes');
    const scene = (PRESETS as unknown as Record<string, { scene: SceneGraph }>).birdhouse.scene;
    // Its walls and roof are children of one root body: they are read now.
    expect(breakdownPipeFrame(scene).struts.length).toBeGreaterThan(0);
    // As the app holds it: a wall with a cut also carries the finished mesh,
    // the door's 32 facets round its hole, which once made the house "curved".
    const ring = Array.from({ length: 32 }, (_, i) => [Math.cos((i / 32) * 2 * Math.PI) * 0.018, Math.sin((i / 32) * 2 * Math.PI) * 0.018]);
    const holeMesh = { name: 'Front Wall_csg', type: 'mesh', size: [1], csgDerived: 'visual', role: 'visual',
      renderVertices: ring.flatMap(([x, z]) => [x, -0.0015, 0.075 + z]).concat(ring.flatMap(([x, z]) => [x, 0.0015, 0.075 + z])),
      faces: ring.flatMap((_, i) => { const j = (i + 1) % 32; return [i, j, 32 + j, i, 32 + j, 32 + i]; }) };
    const live = JSON.parse(JSON.stringify(scene)) as SceneGraph;
    live.nodes[0].children!.find((n) => n.id === 'front_wall')!.geoms!.push(holeMesh as never);
    expect(buildPipeSkeleton(live, 'birdhouse_root').members.length).toBe(15);
    // 120 mm across, too small for 3/4" PVC: framed in tube that suits it.
    const sk = buildPipeSkeleton(scene, 'birdhouse_root');
    expect(sk.resizedFrom).toBe('pvc_sch40_3_4');
    expect(PIPE_STANDARDS[sk.pipeStandardId].odMm * 8).toBeLessThanOrEqual(130);
    // The house: four floor edges, four corners, two eaves, four gable
    // rafters and the ridge. The round door is cut out, so it is not framed;
    // the roof's overhang is carried, not stood on posts.
    expect(sk.members.length).toBe(15);
    expect(sk.nodes.length).toBe(10);
    expect(sk.members.every((m) => m.kind === 'edge')).toBe(true);
  });
});
