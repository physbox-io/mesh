// The copilot's node normaliser/merger - the last thing between a model's JSON
// and the store.
//
// Every case here is a bug that shipped: the scene either silently didn't change
// or silently changed in a way nobody asked for, while the chat panel reported
// success either way.

import { describe, it, expect } from 'vitest';
import { sanitizeAndNormalizeNodes, mergeAndNormalizeNodes } from '../src/utils/sceneNodes';

const pendant = () => ([{
  id: 'pentacle_pendant',
  name: 'Pentacle Pendant (35mm)',
  pos: [0, 0, 0.2],
  scad: 'cube([1,1,1]);',
  geoms: [{
    id: 'geom_1',
    name: 'pentacle_mesh',
    type: 'mesh',
    size: [0.0015],
    pos: [0, 0, 0],
    rgba: [0.85, 0.75, 0.45, 1],
    mass: 0.016,
    dynamic: true,
    vertices: [0, 0, 0, 1, 1, 1, 2, 0, 1],
    faces: [0, 1, 2],
  }],
  joints: [{ id: 'j1', name: 'free_joint', type: 'free' }],
  children: [],
}]);

describe('sanitizeAndNormalizeNodes', () => {
  it('honours an explicit pos of [0,0,0]', () => {
    // "Move it to the origin" / "drop it to the floor". A guard meant to catch
    // an OMITTED pos was reverting explicit zeros to the old position, so the
    // request silently did nothing.
    const out = sanitizeAndNormalizeNodes(
      [{ id: 'pentacle_pendant', pos: [0, 0, 0] }],
      pendant()
    );
    expect(out[0].pos).toEqual([0, 0, 0]);
  });

  it('still falls back to the existing pos when pos is omitted', () => {
    const out = sanitizeAndNormalizeNodes([{ id: 'pentacle_pendant' }], pendant());
    expect(out[0].pos).toEqual([0, 0, 0.2]);
  });

  it('keeps the existing geom size when the model does not restate it', () => {
    // size used to fall through to [0.1, 0.1, 0.1] - a 100mm cube where a 3mm
    // part used to be - while every neighbouring field fell back to the
    // existing geom.
    const existing = [{
      id: 'bracket', name: 'bracket',
      geoms: [{ id: 'g', name: 'bracket_geom', type: 'box', size: [0.02, 0.03, 0.004] }],
    }];
    const out = sanitizeAndNormalizeNodes(
      [{ id: 'bracket', geoms: [{ name: 'bracket_geom', rgba: [1, 0, 0, 1] }] }],
      existing
    );
    expect(out[0].geoms[0].size).toEqual([0.02, 0.03, 0.004]);
    expect(out[0].geoms[0].rgba).toEqual([1, 0, 0, 1]);
  });

  it('preserves fromto and collision flags the model did not restate', () => {
    // The normaliser built a fixed object literal, dropping every field it had
    // no clause for - including the span and collision filtering the copilot's
    // own system prompt tells the model to preserve.
    const existing = [{
      id: 'arm', name: 'arm',
      geoms: [{
        id: 'g', name: 'arm_cap', type: 'capsule', size: [0.05, 0.4],
        fromto: [0, 0, 0, 1, 0, 0], contype: 0, conaffinity: 0, friction: [1, 0.005, 0.0001],
      }],
    }];
    const out = sanitizeAndNormalizeNodes(
      [{ id: 'arm', geoms: [{ name: 'arm_cap', rgba: [0.2, 0.2, 0.2, 1] }] }],
      existing
    );
    const g = out[0].geoms[0];
    expect(g.fromto).toEqual([0, 0, 0, 1, 0, 0]);
    expect(g.contype).toBe(0);
    expect(g.conaffinity).toBe(0);
    expect(g.friction).toEqual([1, 0.005, 0.0001]);
  });

  it('does not inherit a stale fromto onto a geom whose type changed', () => {
    const existing = [{
      id: 'arm', name: 'arm',
      geoms: [{ id: 'g', name: 'arm_cap', type: 'capsule', size: [0.05, 0.4], fromto: [0, 0, 0, 1, 0, 0] }],
    }];
    const out = sanitizeAndNormalizeNodes(
      [{ id: 'arm', geoms: [{ name: 'arm_cap', type: 'box', size: [0.1, 0.1, 0.1] }] }],
      existing
    );
    expect(out[0].geoms[0].fromto).toBeUndefined();
    expect(out[0].geoms[0].size).toEqual([0.1, 0.1, 0.1]);
  });

  it('gives a bare-radius capsule a half-length instead of a stub pill', () => {
    const out = sanitizeAndNormalizeNodes(
      [{ id: 'spoke', geoms: [{ name: 'spoke_geom', type: 'capsule', size: [0.0015] }] }],
      []
    );
    expect(out[0].geoms[0].size).toHaveLength(2);
  });

  it('leaves a capsule sized by fromto alone', () => {
    const out = sanitizeAndNormalizeNodes(
      [{ id: 'spoke', geoms: [{ name: 'spoke_geom', type: 'capsule', size: [0.0015], fromto: [0, 0, 0, 0.03, 0, 0] }] }],
      []
    );
    expect(out[0].geoms[0].size).toEqual([0.0015]);
    expect(out[0].geoms[0].fromto).toEqual([0, 0, 0, 0.03, 0, 0]);
  });
});

describe('mergeAndNormalizeNodes', () => {
  it('appends an unmatched node instead of merging it onto the first body', () => {
    // A model that returns only the body it added used to have that body merged
    // ONTO existing node 0 by index, corrupting a node the user never mentioned.
    const merged = mergeAndNormalizeNodes(
      [{ id: 'chain_loop', name: 'chain_loop', pos: [0, 0, 0.3], geoms: [{ name: 'loop_geom', type: 'sphere', size: [0.004] }] }],
      pendant(),
      false
    );
    expect(merged).toHaveLength(2);
    const names = merged.map(n => n.name);
    expect(names).toContain('Pentacle Pendant (35mm)');
    expect(names).toContain('chain_loop');

    const original = merged.find(n => n.id === 'pentacle_pendant');
    expect(original.pos).toEqual([0, 0, 0.2]);
    expect(original.geoms[0].name).toBe('pentacle_mesh');
  });

  it('merges onto the matching node when ids line up', () => {
    const merged = mergeAndNormalizeNodes(
      [{ id: 'pentacle_pendant', pos: [0, 0, 0.5] }],
      pendant(),
      false
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].pos).toEqual([0, 0, 0.5]);
    // Mesh data the model never restates must survive the round trip.
    expect(merged[0].geoms[0].vertices).toHaveLength(9);
    expect(merged[0].scad).toBe('cube([1,1,1]);');
  });

  it('carries through nodes the model did not mention', () => {
    const scene = [...pendant(), { id: 'stand', name: 'stand', pos: [0, 0, 0], geoms: [], joints: [], children: [] }];
    const merged = mergeAndNormalizeNodes([{ id: 'pentacle_pendant', pos: [0, 0, 0.5] }], scene, false);
    expect(merged.map(n => n.id)).toContain('stand');
  });

  it('replaces the scene wholesale on the generate path', () => {
    const merged = mergeAndNormalizeNodes(
      [{ id: 'new_thing', name: 'new_thing', geoms: [{ name: 'g', type: 'box', size: [1, 1, 1] }] }],
      pendant(),
      true
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe('new_thing');
  });
});
