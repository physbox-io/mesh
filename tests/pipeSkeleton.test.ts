import { describe, it, expect } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { buildPipeSkeleton, defaultMaxSpanMm, skeletonToNodes } from '../src/utils/pipeSkeleton';
import { PIPE_STANDARDS, breakdownPipeFrame } from '../src/utils/tubeAndWireExporter';
import { createLattice, vertexAt, addWire, serializeCage } from '../src/utils/latticeMesh';
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
    // Its walls and roof are children of one root body, and boards, not
    // pipes: there is no frame until it is framed.
    expect(breakdownPipeFrame(scene).struts.length).toBe(0);
    // A frame grouped under one body is read through the group.
    const { frameBodyInScene } = await import('../src/utils/pipeSkeleton');
    const frame = frameBodyInScene(scene, 'birdhouse_root').nodes;
    const grouped = { nodes: [{ id: 'g', name: 'Group', pos: [0.1, 0, 0], geoms: [], joints: [], children: frame }] } as unknown as SceneGraph;
    expect(breakdownPipeFrame(grouped).struts.length).toBe(15);
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

describe('thin rod', () => {
  it('frames the birdhouse in 5 mm dowel when asked, and spaghetti glued with no fittings', async () => {
    const { PRESETS } = await import('../src/presets/presetScenes');
    const scene = (PRESETS as unknown as Record<string, { scene: SceneGraph }>).birdhouse.scene;
    const dowel = buildPipeSkeleton(scene, 'birdhouse_root', { pipeStandardId: 'dowel_5' });
    expect(dowel.pipeStandardId).toBe('dowel_5');
    expect(dowel.resizedFrom).toBeUndefined();
    expect(dowel.members.length).toBe(15);
    const { frameBodyInScene } = await import('../src/utils/pipeSkeleton');
    const pasta = frameBodyInScene(scene, 'birdhouse_root', { pipeStandardId: 'spaghetti' });
    // Thin enough to follow the roof's overhang too; and the ridge stands on
    // its rafters, shallow as the roof is, so nothing needs a post.
    expect(pasta.skeleton.members.length).toBe(21);
    expect(pasta.skeleton.members.some((m) => m.kind === 'post')).toBe(false);
    // Pipes only: no printed hub round a strand of spaghetti.
    expect(pasta.added).toBe(21);
    // A rod is drawn solid and still checks out hub to hub.
    const bd = breakdownPipeFrame({ nodes: pasta.nodes.filter((n) => n.id.startsWith('frame_')) } as unknown as SceneGraph, { pipeStandardId: 'spaghetti' });
    expect(simulatePipeFrame(bd).maxGapMm).toBeLessThan(0.05);
  });
});


describe('furniture of long parts', () => {
  it('frames the flower stand down the middle of each part, with nothing selected', async () => {
    const { PRESETS } = await import('../src/presets/presetScenes');
    const { loadManifold } = await import('../src/utils/sculptCut');
    const { WHOLE_SCENE } = await import('../src/utils/pipeSkeleton');
    const scene = (PRESETS as unknown as Record<string, { scene: SceneGraph }>).flower_stand.scene;
    const wasm = await loadManifold();
    // Auto: twelve of its fourteen parts are long, so a pipe down each.
    const pvc = buildPipeSkeleton(scene, WHOLE_SCENE, { wasm });
    expect(pvc.style).toBe('centrelines');
    // Four legs, four aprons, four stretchers; the top, 43 mm up, is within
    // three diameters of 3/4" PVC, so it rests on the aprons' joints.
    expect(pvc.members.length).toBe(16);
    expect(pvc.members.some((m) => m.kind === 'post')).toBe(false);
    // In 8 mm dowel the legs run on up to rails under the top.
    const dowel = buildPipeSkeleton(scene, WHOLE_SCENE, { wasm, pipeStandardId: 'dowel_8' });
    expect(dowel.members.length).toBe(22);
    // Every apron and stretcher meets its legs: one connected frame.
    const seen = new Set([0]);
    for (let grew = true; grew;) {
      grew = false;
      for (const m of dowel.members) if (seen.has(m.a) !== seen.has(m.b)) { seen.add(m.a); seen.add(m.b); grew = true; }
    }
    expect(seen.size).toBe(dowel.nodes.length);
    // Along the edges, when asked, it is joined into one solid first; the
    // groove between the two top planks is a loose fragment, dropped, not
    // stood on three posts of its own.
    for (const pipeStandardId of ['pvc_sch40_3_4', 'dowel_8', 'dowel_5'] as const) {
      const edges = buildPipeSkeleton(scene, WHOLE_SCENE, { wasm, style: 'edges', pipeStandardId });
      expect(edges.style).toBe('edges');
      expect(edges.members.some((m) => m.kind === 'post' || m.kind === 'base')).toBe(false);
    }
  });
});
