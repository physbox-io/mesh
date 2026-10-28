import { describe, it, expect, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import { useStore } from '../src/store/useStore';
import { compileToMJCF } from '../src/utils/mjcf';
import { withoutDanglingReferences } from '../src/utils/danglingReferences';
import { withUniqueNames } from '../src/utils/uniqueNames';
import type { SceneGraph, SceneNode } from '../src/types';

const box = (id: string, x: number, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, pos: [x, 0, 0.1], quat: [1, 0, 0, 0], joints: [], children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.02, 0.02, 0.02], rgba: [0.5, 0.5, 0.5, 1] }],
  ...extra,
});

const rope = (id: string, x: number, extra: Partial<SceneNode> = {}): SceneNode => box(id, x, {
  isComposite: true, compositeType: 'cable', compositeCount: '5 1 1', compositeSize: '0.2', compositePrefix: 'rope_',
  ...extra,
});

/** Every body an <equality> constraint names, and every body the model has. */
const constraintBodies = (xml: string) => {
  const eq = xml.match(/<equality>[\s\S]*<\/equality>/)?.[0] ?? '';
  return [...eq.matchAll(/body[12]="([^"]+)"/g)].map((m) => m[1]);
};

// Split for print, the knife, shatter, paste and the pipe frame all take
// bodies out of the scene without asking what was fixed to them. A weld left
// naming one fails the whole model; a connect pins its body to the world.
describe('references to bodies no longer in the scene', () => {
  const scene = (): SceneGraph => ({
    nodes: [
      box('frame', 0),
      box('bracket', 0.05, { weldTargetId: 'gone', weldRigid: true }),
      box('pin', 0.1, { connectTargetId: 'gone', connectAnchor: [0.1, 0, 0.1] }),
      box('gear', 0.15, { coupleTargetId: 'gone', coupleRatio: 2 }),
      box('kept', 0.2, { weldTargetId: 'frame' }),
      rope('cable', 0.3, { weldLastToId: 'gone_anchor' }),
      box('clip', 0.4, { weldTargetId: 'rope_B_last' }),
    ],
  } as SceneGraph);

  it('lets go of them in the store, and keeps the rest', () => {
    const nodes = withoutDanglingReferences(scene()).nodes;
    const by = (id: string) => nodes.find((n) => n.id === id)!;
    expect(by('bracket').weldTargetId).toBeUndefined();
    expect(by('bracket').weldRigid).toBeUndefined();
    expect(by('pin').connectTargetId).toBeUndefined();
    expect(by('pin').connectAnchor).toBeUndefined();
    expect(by('gear').coupleTargetId).toBeUndefined();
    expect(by('cable').weldLastToId).toBeUndefined();
    expect(by('kept').weldTargetId).toBe('frame');
    // A body the rope generates is there, though no node is called that.
    expect(by('clip').weldTargetId).toBe('rope_B_last');
  });

  it('is the same scene when nothing dangles', () => {
    const clean = { nodes: [box('a', 0), box('b', 0.1, { weldTargetId: 'a' })] } as SceneGraph;
    expect(withoutDanglingReferences(clean)).toBe(clean);
  });

  it('compiles a scene handed straight to the compiler', () => {
    const xml = compileToMJCF(scene());
    expect(constraintBodies(xml)).not.toContain('gone');
    expect(constraintBodies(xml)).not.toContain('gone_anchor');
    expect(xml).not.toMatch(/<connect [^>]*body1="pin"/);
  });

  it('cuts a rope end welded to an anchor that was deleted', () => {
    useStore.setState({ recompile: async () => {} } as never);
    useStore.getState().updateScene({ nodes: [rope('cable', 0, { weldLastToId: 'anchor' }), box('anchor', 0.3)] } as never);
    useStore.getState().deleteNodes(['anchor']);
    expect(useStore.getState().sceneGraph.nodes[0].weldLastToId).toBeUndefined();
  });

  it('pastes a copy whose weld target has since been deleted', () => {
    useStore.setState({ recompile: async () => {} } as never);
    useStore.getState().updateScene({ nodes: [box('frame', 0), box('bracket', 0.1, { weldTargetId: 'frame' })] } as never);
    useStore.setState({ selectedNodeId: 'bracket', extraSelectedIds: [] });
    useStore.getState().copySelection();
    useStore.getState().deleteNodes(['frame']);
    const [pasted] = useStore.getState().pasteClipboard();
    const copy = useStore.getState().sceneGraph.nodes.find((n) => n.id === pasted)!;
    expect(copy.weldTargetId).toBeUndefined();
  });
});

// A copy of a rope kept the original's prefix, so the two ropes generated
// bodies of the same names and the copy's end weld held the original's end.
describe('a copied rope', () => {
  it('gets a prefix of its own', () => {
    const nodes = withUniqueNames({ nodes: [rope('cable', 0), rope('cable', 0.3, { id: 'cable_x' })] } as SceneGraph).nodes;
    expect(nodes[0].compositePrefix).toBe('rope_');
    expect(nodes[1].name).toBe('cable_2');
    expect(nodes[1].compositePrefix).toBe('cable_2_');
    const xml = compileToMJCF({ nodes } as SceneGraph);
    expect(xml).toContain('prefix="rope_"');
    expect(xml).toContain('prefix="cable_2_"');
  });

  it('does not take a prefix another rope already has', () => {
    const nodes = withUniqueNames({ nodes: [
      rope('a', 0, { compositePrefix: 'b_' }),
      rope('b', 0.3, { compositePrefix: undefined }),
    ] } as SceneGraph).nodes;
    expect(nodes[1].compositePrefix).toBe('b_2_');
  });
});
