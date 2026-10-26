import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import { fillBodyDefaults, resolveUpdatedGeoms, applyPaintStrokeToBody } from '../src/hooks/useMCPBridge';
import { useStore } from '../src/store/useStore';
import { canvasFromLayer } from '../src/utils/vertexPaint';
import type { SceneNode } from '../src/types';

describe('fillBodyDefaults pos', () => {
  it('drops a top-level body from a metre up but sits a child at its parent', () => {
    const node = fillBodyDefaults({
      name: 'frame',
      geoms: [{ type: 'box', size: [0.05, 0.05, 0.05] }],
      children: [{ name: 'arm', geoms: [{ type: 'box', size: [0.01, 0.01, 0.01] }] }],
    });
    expect(node.pos).toEqual([0, 0, 1]);
    expect(node.children[0].pos).toEqual([0, 0, 0]);
  });

  it('sits a body added under a parent at the parent origin', () => {
    const node = fillBodyDefaults({ name: 'bolt', geoms: [{ type: 'cylinder', size: [0.002, 0.01] }] }, false);
    expect(node.pos).toEqual([0, 0, 0]);
  });
});

describe('resolveUpdatedGeoms partial geom updates (Item 1)', () => {
  const pumpkinTarget: SceneNode = {
    name: 'pumpkin',
    pos: [0, 0, 0.1],
    quat: [1, 0, 0, 0],
    joints: [],
    children: [],
    geoms: [
      {
        name: 'pumpkin_sculpt',
        type: 'mesh',
        size: [1, 1, 1],
        rgba: [0.6, 0.6, 0.9, 1],
        vertices: [-0.05, -0.05, -0.05, 0.05, -0.05, -0.05, 0, 0.05, 0.05],
        faces: [0, 1, 2],
        renderVertices: [-0.05, -0.05, -0.05, 0.05, -0.05, -0.05, 0, 0.05, 0.05],
      },
      {
        name: 'pumpkin_col_0',
        type: 'mesh',
        size: [1, 1, 1],
        rgba: [0, 0, 0, 0],
        vertices: [-0.05, -0.05, -0.05, 0.05, -0.05, -0.05, 0, 0.05, 0.05],
        faces: [0, 1, 2],
      },
    ],
  };

  it('merges {name, rgba} into an existing sculpt mesh geom without clobbering it into a box', () => {
    const res = resolveUpdatedGeoms(
      pumpkinTarget,
      [{ name: 'pumpkin_sculpt', rgba: [0.95, 0.45, 0.08, 1] }],
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.geoms).toHaveLength(2);
    expect(res.geoms[0].type).toBe('mesh');
    expect(res.geoms[0].rgba).toEqual([0.95, 0.45, 0.08, 1]);
    expect(res.geoms[0].vertices).toEqual(pumpkinTarget.geoms[0].vertices);
    expect(res.geoms[0].faces).toEqual(pumpkinTarget.geoms[0].faces);
    expect(res.geoms[0].renderVertices).toEqual(pumpkinTarget.geoms[0].renderVertices);
    // Preserves convex hull collider geoms as well
    expect(res.geoms[1].name).toBe('pumpkin_col_0');
  });

  it('merges unnamed partial geom [{rgba}] by index into the primary geom', () => {
    const res = resolveUpdatedGeoms(
      pumpkinTarget,
      [{ rgba: [0.9, 0.4, 0.1] }],
      {},
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.geoms[0].type).toBe('mesh');
    expect(res.geoms[0].rgba).toEqual([0.9, 0.4, 0.1, 1]);
    expect(res.geoms[0].vertices).toEqual(pumpkinTarget.geoms[0].vertices);
  });

  it('rejects partial geom updates that reference a non-existent geom name', () => {
    const res = resolveUpdatedGeoms(
      pumpkinTarget,
      [{ name: 'wrong_name', rgba: [1, 0, 0, 1] }],
      {},
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('wrong_name');
    expect(res.error).toContain('pumpkin_sculpt');
  });
});

describe('SCAD body-level rgba propagation (Item 5)', () => {
  it('propagates body-level rgba to synthesized SCAD geom in fillBodyDefaults', () => {
    const node = fillBodyDefaults({
      name: 'brass_bracket',
      scad: 'cube(20, center=true);',
      rgba: [0.85, 0.65, 0.2, 1],
    });
    expect(node.geoms[0].type).toBe('mesh');
    expect(node.geoms[0].rgba).toEqual([0.85, 0.65, 0.2, 1]);
    expect((node as { rgba?: number[] }).rgba).toEqual([0.85, 0.65, 0.2, 1]);
  });

  it('propagates 3-element body-level rgba and preserves it across updateNode and updateNodeScad', () => {
    const node = fillBodyDefaults({
      name: 'copper_plate',
      scad: 'cube(15, center=true);',
      rgba: [0.8, 0.4, 0.2],
    });
    expect(node.geoms[0].rgba).toEqual([0.8, 0.4, 0.2, 1]);

    useStore.setState({
      sceneGraph: { ...useStore.getState().sceneGraph, nodes: [node] },
      recompile: vi.fn(),
    });
    // Updating SCAD geometry preserves the body colour instead of reverting to lilac
    useStore.getState().updateNodeScad(
      node.id,
      [-0.01, -0.01, -0.01, 0.01, -0.01, -0.01, 0, 0.01, 0.01],
      [0, 1, 2],
    );
    const afterScad = useStore.getState().sceneGraph.nodes.find(n => n.id === node.id)!;
    expect(afterScad.geoms[0].rgba).toEqual([0.8, 0.4, 0.2, 1]);

    // Updating body-level rgba via updateNode updates the geom colour
    useStore.getState().updateNode(node.id, { rgba: [0.2, 0.7, 0.4, 1] } as Partial<SceneNode>);
    const afterUpdate = useStore.getState().sceneGraph.nodes.find(n => n.id === node.id)!;
    expect(afterUpdate.geoms[0].rgba).toEqual([0.2, 0.7, 0.4, 1]);
  });
});

describe('applyPaintStrokeToBody on coarse mesh geoms (Item 16)', () => {
  it('paints the center of a face on an 8-vertex mesh cube', () => {
    const s = 0.025;
    const cubeVertices = [
      -s, -s, -s,  s, -s, -s,  s,  s, -s, -s,  s, -s,
      -s, -s,  s,  s, -s,  s,  s,  s,  s, -s,  s,  s,
    ];
    const cubeFaces = [
      0, 2, 1,  0, 3, 2,
      4, 5, 6,  4, 6, 7,
      0, 1, 5,  0, 5, 4,
      2, 3, 7,  2, 7, 6,
      0, 4, 7,  0, 7, 3,
      1, 2, 6,  1, 6, 5,
    ];
    const body = fillBodyDefaults({
      name: 'scad_cube',
      geoms: [{
        name: 'scad_cube_geom',
        type: 'mesh',
        size: [1, 1, 1],
        rgba: [0.8, 0.8, 0.8, 1],
        vertices: cubeVertices,
        faces: cubeFaces,
      }],
    });
    useStore.setState({
      sceneGraph: { ...useStore.getState().sceneGraph, nodes: [body] },
      recompile: vi.fn(),
    });

    const res = applyPaintStrokeToBody(body.id, {
      rgba: [0.9, 0.1, 0.1],
      radius: 0.008,
      at: [0, 0, s], // exact center of top face, ~35 mm from the 8 corners
    });
    expect(res.ok).toBe(true);
    expect(res.dabsLanded).toBe(1);
    const updated = useStore.getState().sceneGraph.nodes.find(n => n.id === body.id)!;
    const layer = updated.geoms[0].paint!;
    expect(layer).toBeDefined();
    expect(layer.res.length).toBe(1);
    expect(layer.idx.length).toBeGreaterThan(0);
    expect(layer.rgba.length).toBe(layer.idx.length * 4);
  });
});
