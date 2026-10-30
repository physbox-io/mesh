// A null field is an unset one, and in an update it removes the field.
//
// physics_update_object with geoms: [{ name, friction: null }] used to fail
// with "Cannot read properties of null (reading 'join')", and the null stayed
// in the graph, so the scene never compiled again.

import { describe, it, expect } from 'vitest';
import { compileToMJCF } from '../src/utils/mjcf';
import { fillBodyDefaults, fillGeomDefaults, resolveUpdatedGeoms } from '../src/hooks/mcp/bodyDefaults';
import type { SceneGraph, SceneNode } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
const box = (extra: Record<string, any>): SceneNode => ({
  id: 'b', name: 'b', pos: [0, 0, 0.5],
  joints: [{ name: 'b_free', type: 'free' }],
  geoms: [{ name: 'b_g', type: 'box', size: [0.05, 0.05, 0.05], ...extra }],
} as SceneNode);

describe('null fields in the compiler', () => {
  it('compiles a geom whose optional arrays and numbers are null as if they were unset', () => {
    const nulls = { friction: null, rgba: null, pos: null, quat: null, euler: null, fromto: null, solref: null, solimp: null, mass: null, condim: null, margin: null, gap: null, contype: null };
    const xml = compileToMJCF({ nodes: [box(nulls)] } as SceneGraph);
    const geom = xml.match(/<geom name="b_g"[^>]*>/)![0];
    expect(geom).not.toMatch(/friction=|rgba=|solref=|mass=|condim=|null/);
  });

  it('compiles a hinge whose pos, axis and range are null', () => {
    const node = { ...box({}), joints: [{ name: 'h', type: 'hinge', axis: null, pos: null, range: null, damping: null }] } as unknown as SceneNode;
    const xml = compileToMJCF({ nodes: [node] } as SceneGraph);
    expect(xml).toMatch(/<joint name="h" type="hinge" \/>/);
  });

  it('compiles a body whose pos and euler are null', () => {
    const node = { ...box({}), pos: null, euler: null } as unknown as SceneNode;
    expect(compileToMJCF({ nodes: [node] } as SceneGraph)).not.toContain('null');
  });
});

describe('null fields from an agent', () => {
  it('removes the field from the geom a physics_update_object patch merges into', () => {
    const target = {
      ...box({ friction: [0.5, 0.005, 0.0001], solref: [0.02, 1] }),
      geoms: [
        { name: 'b_g', type: 'box', size: [0.05, 0.05, 0.05], friction: [0.5, 0.005, 0.0001], solref: [0.02, 1], rgba: [1, 0, 0, 1] },
        { name: 'b_h', type: 'sphere', size: [0.02], friction: [0.2, 0.005, 0.0001] },
      ],
    } as SceneNode;
    const r = resolveUpdatedGeoms(target, [{ name: 'b_g', friction: null } as any]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.geoms).toHaveLength(2);
    expect('friction' in r.geoms[0]).toBe(false);
    expect(r.geoms[0].solref).toEqual([0.02, 1]);
    expect(r.geoms[0].rgba).toEqual([1, 0, 0, 1]);
    expect(r.geoms[1].friction).toEqual([0.2, 0.005, 0.0001]);
    // And it compiles.
    expect(() => compileToMJCF({ nodes: [{ ...target, geoms: r.geoms }] } as SceneGraph)).not.toThrow();
  });

  it('removes a structural field too, from a mesh-free primitive', () => {
    const target = box({ pos: [0.1, 0, 0] });
    const r = resolveUpdatedGeoms(target, [{ name: 'b_g', pos: null } as any]);
    expect(r.ok && 'pos' in r.geoms[0]).toBe(false);
  });

  it('fills a null size or type with the default, and keeps no null', () => {
    const g = fillGeomDefaults({ type: null, size: null, friction: null } as any, 'b', 0, true);
    expect(g.type).toBe('box');
    expect(g.size).toEqual([0.25, 0.25, 0.25]);
    expect('friction' in g).toBe(false);
  });

  it('builds a body whose fields are null as if they were left out', () => {
    const n = fillBodyDefaults({ id: 'a', pos: null, euler: null, joints: [{ type: 'hinge', axis: null, name: 'j' }], geoms: [{ type: 'box', size: [0.1, 0.1, 0.1], friction: null }] } as any);
    expect('pos' in n && n.pos === null).toBe(false);
    expect(n.joints[0].axis ?? undefined).toBeUndefined();
    expect('friction' in n.geoms[0]).toBe(false);
    expect(() => compileToMJCF({ nodes: [n] } as SceneGraph)).not.toThrow();
  });
});
