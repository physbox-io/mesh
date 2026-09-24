// Making a nested body free.
//
// MuJoCo refuses to load a model with a free joint anywhere but a top-level
// body — "free joint can only be used on top level", and it rejects the WHOLE
// model, not the joint. Before this existed the app kept the last model that
// loaded while the document said something else, so the body quietly stopped
// responding to anything: the gizmo moved and it stayed put.
//
// So the body is lifted out of its parent first. What has to be true is that
// it comes out where it went in — a pendulum arm detached mid-swing must not
// jump back to the pose its parent-relative numbers describe.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const node = (id: string, pos: number[], extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, type: 'body', pos,
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.05, 0.05, 0.05] }],
  joints: [], children: [], ...extra,
} as unknown as SceneNode);

/** parent turned a quarter turn about Z, with a child out along its local +X. */
const nested = (): SceneGraph => ({
  nodes: [
    node('parent', [1, 2, 3], {
      euler: [0, 0, 90],
      children: [node('child', [0.22, 0, 0])],
    }),
  ],
} as unknown as SceneGraph);

const find = (nodes: SceneNode[], id: string): SceneNode | undefined => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = find(n.children || [], id);
    if (hit) return hit;
  }
  return undefined;
};

describe('detachToTopLevel', () => {
  beforeEach(() => {
    // The action asks for a rebuild on its way out, and the debounce in
    // `recompile` parks its resolver on `window`. There is no window out here,
    // and none of what follows depends on the rebuild — only on the scene
    // graph the action leaves behind, which it writes before asking.
    (globalThis as unknown as { window: unknown }).window = globalThis;
    useStore.setState({ sceneGraph: nested(), model: null, data: null });
  });

  it('moves the body out of its parent and onto the top level', () => {
    expect(useStore.getState().detachToTopLevel('child')).toBe(true);
    const { nodes } = useStore.getState().sceneGraph;
    expect(nodes.map((n) => n.id).sort()).toEqual(['child', 'parent']);
    expect(find(nodes, 'parent')!.children).toHaveLength(0);
  });

  it('leaves it where it was, rather than where its old numbers said', () => {
    useStore.getState().detachToTopLevel('child');
    const child = find(useStore.getState().sceneGraph.nodes, 'child')!;
    // parent sits at (1,2,3) turned 90 deg about Z, so the child's local +X
    // offset of 0.22 points along the world +Y.
    expect(child.pos[0]).toBeCloseTo(1, 6);
    expect(child.pos[1]).toBeCloseTo(2.22, 6);
    expect(child.pos[2]).toBeCloseTo(3, 6);
    // and it keeps the orientation it inherited from the parent.
    expect(child.euler![2]).toBeCloseTo(90, 4);
  });

  it('refuses a body that is already top level, leaving the scene alone', () => {
    const before = JSON.stringify(useStore.getState().sceneGraph);
    expect(useStore.getState().detachToTopLevel('parent')).toBe(false);
    expect(JSON.stringify(useStore.getState().sceneGraph)).toBe(before);
  });

  it('produces MJCF MuJoCo will accept a free joint in', () => {
    useStore.getState().detachToTopLevel('child');
    const graph = useStore.getState().sceneGraph;
    const child = find(graph.nodes, 'child')!;
    child.joints = [{ name: 'child_joint', type: 'free' }];
    const xml = compileToMJCF(graph);
    // mjcf.ts writes a free joint as MJCF's <freejoint/> shorthand.
    expect(xml.slice(xml.indexOf('<body name="child"'))).toContain('<freejoint');
    // And it has to be a DIRECT child of worldbody, which is the whole point:
    // every body opened before it must also have been closed.
    const worldbody = xml.slice(xml.indexOf('<worldbody>'));
    const before = worldbody.slice(0, worldbody.indexOf('<body name="child"'));
    expect((before.match(/<body /g) || []).length)
      .toBe((before.match(/<\/body>/g) || []).length);
  });
});
