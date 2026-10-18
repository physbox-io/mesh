// Prepare for Casting, through the store: the originals, the single undo step,
// and the guard that refuses edits while draft is baked in.
//
// The runner itself needs the OpenSCAD worker to find edges, so these drive the
// same store actions it calls, in the same order, with draft only.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { eachBody, shapeSignature, snapshotShape } from '../src/utils/castPrep';
import type { CastPrep, SceneGraph, SceneNode } from '../src/types/scene';

const cube = (id: string): SceneNode => ({
  id, name: id, type: 'body', pos: [0, 0, 0.01],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.01, 0.01, 0.01] }],
  joints: [], children: [],
} as unknown as SceneNode);

const tick = () => new Promise((r) => setTimeout(r, 0));

function originalsOf(scene: SceneGraph): CastPrep['originals'] {
  const out: CastPrep['originals'] = {};
  for (const { node } of eachBody(scene)) out[node.id] = { shape: snapshotShape(node), signature: shapeSignature(node) };
  return out;
}

/** What castPrepRunner does for a draft-only prep. */
async function prep(draftDeg: number) {
  const s = useStore.getState();
  s.beginCastPrep({ draftDeg: 0, draftMode: 'add', partingZ: 0, edges: null, originals: originalsOf(s.sceneGraph), skipped: [], sharpEdges: 0 });
  if (draftDeg > 0) useStore.getState().bakeCastPrepDraft({ deg: draftDeg, mode: 'add', partingZ: 0 });
  useStore.getState().finishCastPrep({ edges: null, sharpEdges: 0 });
  await tick();
}

describe('Prepare for Casting in the store', () => {
  beforeEach(async () => {
    // recompile's debounce parks its resolver on `window`; see detachToTopLevel.test.
    (globalThis as unknown as { window: unknown }).window = globalThis;
    useStore.setState({
      sceneGraph: { nodes: [cube('a'), cube('b')] },
      model: null, data: null, undoStack: [], redoStack: [], tempUndoState: null,
      castPrepGuardOpen: false, castPrepBusy: null,
    });
    await tick();
  });

  it('bakes draft in, and refuses an edit to a body while it is', async () => {
    await prep(2);
    const baked = useStore.getState().sceneGraph;
    expect(baked.castPrep?.draftDeg).toBe(2);
    expect(baked.nodes[0].geoms[0].type).toBe('mesh');

    const blocked = useStore.getState().castPrepBlocked;
    useStore.getState().updateNode('a', { pos: [0.1, 0, 0.01] });
    expect(useStore.getState().sceneGraph).toBe(baked);
    expect(useStore.getState().castPrepGuardOpen).toBe(true);
    expect(useStore.getState().castPrepBlocked).toBe(blocked + 1);
  });

  it('lets edits through when prep broke edges only', async () => {
    await prep(0);
    expect(useStore.getState().sceneGraph.castPrep).toBeDefined();
    useStore.getState().updateNode('a', { pos: [0.1, 0, 0.01] });
    expect(useStore.getState().sceneGraph.nodes[0].pos).toEqual([0.1, 0, 0.01]);
    expect(useStore.getState().castPrepGuardOpen).toBe(false);
  });

  it('switching off puts the original shapes back', async () => {
    await prep(2);
    const { restored, kept } = useStore.getState().clearCastPrep();
    expect(restored).toEqual(['a', 'b']);
    expect(kept).toEqual([]);
    const sg = useStore.getState().sceneGraph;
    expect(sg.castPrep).toBeUndefined();
    expect(sg.nodes[0].geoms).toEqual([{ name: 'a_g', type: 'box', size: [0.01, 0.01, 0.01] }]);
    await tick();
    useStore.getState().updateNode('a', { pos: [0.1, 0, 0.01] });
    expect(useStore.getState().sceneGraph.nodes[0].pos).toEqual([0.1, 0, 0.01]);
  });

  it('baking in keeps the drafted shapes and ends the guard', async () => {
    await prep(2);
    useStore.getState().bakeCastPrep();
    const sg = useStore.getState().sceneGraph;
    expect(sg.castPrep).toBeUndefined();
    expect(sg.nodes[0].geoms[0].type).toBe('mesh');
    await tick();
    useStore.getState().updateNode('a', { pos: [0.1, 0, 0.01] });
    expect(useStore.getState().sceneGraph.nodes[0].pos).toEqual([0.1, 0, 0.01]);
  });

  it('one undo after baking in goes back to before the prep', async () => {
    await prep(2);
    useStore.getState().bakeCastPrep();
    await tick();
    useStore.getState().undo();
    const sg = useStore.getState().sceneGraph;
    expect(sg.castPrep).toBeUndefined();
    expect(sg.nodes[0].geoms[0].type).toBe('box');
  });

  it('undoes the whole prep in one step', async () => {
    await prep(2);
    useStore.getState().undo();
    const sg = useStore.getState().sceneGraph;
    expect(sg.castPrep).toBeUndefined();
    expect(sg.nodes[0].geoms[0].type).toBe('box');
  });

  it('carries surface textures from positive source geoms onto compiled CSG visual geoms', async () => {
    const { csgHashOf } = await import('../src/utils/csg');
    const texturedNode: SceneNode = {
      id: 'coin',
      name: 'coin',
      type: 'body',
      pos: [0, 0, 0.15],
      csgEnabled: true,
      edgeRounds: [{
        mode: 'chamfer',
        size: 0.001,
        edges: [{ kind: 'circle', convex: true, centre: [0, 0, 0.01], axis: [0, 0, 1], radius: 0.05, sample: [0.05, 0, 0.01] }],
      }],
      geoms: [{
        name: 'coin_g',
        type: 'cylinder',
        size: [0.05, 0.01],
        textures: [{
          id: 'lotus',
          pattern: 'lotus_mandala',
          seedAt: [0, 0, 0.01],
          seedNormal: [0, 0, 1],
          scale: 0.05,
          depth: 0.003,
          angle: 0,
          invert: false,
          fadeMargin: 0.005,
          cellSize: 0.0004,
          creaseDeg: 35,
          maxTiltDeg: 60,
          aroundClaimed: true,
        }],
      }],
      joints: [],
      children: [],
    } as unknown as SceneNode;
    useStore.setState({ sceneGraph: { nodes: [texturedNode] } });
    const hash = csgHashOf(texturedNode);
    useStore.getState().applyNodeCsg('coin', {
      hash,
      scad: 'cylinder();',
      volume: 1e-4,
      hullVolume: 1e-4,
      centroid: [0, 0, 0],
      geoms: [{
        name: 'coin_csg_visual',
        type: 'mesh',
        csgDerived: 'visual',
        role: 'visual',
        pos: [0, 0, 0],
        renderVertices: [-0.01, -0.01, 0, 0.01, -0.01, 0, 0, 0.01, 0, 0, 0, 0.01],
        vertices: [-0.01, 0, 0.01, 0.01, 0, 0.01, 0, 0, -0.01, 0, 0.01, 0],
        faces: [0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3],
      }],
    }, true);
    const updated = useStore.getState().sceneGraph.nodes[0];
    const visual = updated.geoms.find((g) => g.csgDerived === 'visual');
    expect(visual?.textures).toHaveLength(1);
    expect(visual?.textures?.[0].pattern).toBe('lotus_mandala');
  });
});

