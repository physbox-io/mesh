import { describe, expect, it } from 'vitest';
import { shareUnchanged } from '../src/utils/shareUnchanged';
import { cloneSceneGraph } from '../src/store/useStore';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const body = (id: string, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, type: 'body', pos: [0, 0, 0], joints: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.1, 0.1, 0.1], rgba: [1, 0, 0, 1] }],
  children: [], ...extra,
} as SceneNode);

const scene = (): SceneGraph => ({
  nodes: [
    body('a'),
    body('b', { children: [body('b1'), body('b2')] }),
    body('m', { geoms: [{ name: 'mesh', type: 'mesh', vertices: [0, 0, 0, 1, 0, 0, 0, 1, 0], faces: [0, 1, 2] }] as SceneNode['geoms'] }),
  ],
});

describe('shareUnchanged', () => {
  it('gives an untouched clone back its old node objects', () => {
    const prev = scene();
    const next = cloneSceneGraph(prev);
    expect(next.nodes[0]).not.toBe(prev.nodes[0]);
    const out = shareUnchanged(prev, next);
    expect(out).toBe(next);
    next.nodes.forEach((n, i) => expect(n).toBe(prev.nodes[i]));
  });

  it('keeps the edited node new and shares its siblings', () => {
    const prev = scene();
    const next = cloneSceneGraph(prev);
    next.nodes[0].pos = [1, 0, 0];
    shareUnchanged(prev, next);
    expect(next.nodes[0]).not.toBe(prev.nodes[0]);
    expect(next.nodes[0].pos).toEqual([1, 0, 0]);
    expect(next.nodes[1]).toBe(prev.nodes[1]);
    expect(next.nodes[2]).toBe(prev.nodes[2]);
  });

  it('shares unchanged children under a parent whose child changed', () => {
    const prev = scene();
    const next = cloneSceneGraph(prev);
    next.nodes[1].children[1].geoms[0].rgba = [0, 1, 0, 1];
    shareUnchanged(prev, next);
    expect(next.nodes[1]).not.toBe(prev.nodes[1]);
    expect(next.nodes[1].children[0]).toBe(prev.nodes[1].children[0]);
    expect(next.nodes[1].children[1]).not.toBe(prev.nodes[1].children[1]);
    expect(next.nodes[1].children[1].geoms[0].rgba).toEqual([0, 1, 0, 1]);
  });

  it('treats a replaced mesh array as a change even when equal in value', () => {
    const prev = scene();
    const next = cloneSceneGraph(prev);
    next.nodes[2].geoms[0].vertices = [...(prev.nodes[2].geoms[0].vertices as number[])];
    shareUnchanged(prev, next);
    expect(next.nodes[2]).not.toBe(prev.nodes[2]);
  });

  it('matches by id, so a delete or reorder does not pair the wrong nodes', () => {
    const prev = scene();
    const next = cloneSceneGraph(prev);
    next.nodes.splice(0, 1);
    next.nodes.reverse();
    shareUnchanged(prev, next);
    expect(next.nodes.map(n => n.id)).toEqual(['m', 'b']);
    expect(next.nodes[0]).toBe(prev.nodes[2]);
    expect(next.nodes[1]).toBe(prev.nodes[1]);
  });

  it('notices a node that gained or lost a child', () => {
    const prev = scene();
    const next = cloneSceneGraph(prev);
    next.nodes[1].children.pop();
    shareUnchanged(prev, next);
    expect(next.nodes[1]).not.toBe(prev.nodes[1]);
    expect(next.nodes[1].children).toHaveLength(1);
  });
});
