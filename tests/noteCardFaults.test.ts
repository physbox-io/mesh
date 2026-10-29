// Two note card faults found driving the app over MCP.
//
// LOAD_PRESET sets the preset's card and then refreshes its bounding boxes in
// the same tick. The getter on `window` was closed over the last rendered
// cards, so it handed back the card from BEFORE the set, and the refresh wrote
// "Double Pendulum" back over "Blank Scene". The cards are now read from what
// was last set (utils/syncedSetter.ts).
//
// The bounding boxes centred each child body on its `pos`, ignoring where its
// shape actually is in its frame and how it is turned.

import { describe, it, expect, beforeEach } from 'vitest';
import { syncedSetter } from '../src/utils/syncedSetter';
import { computeNodeBoundingBox, makePresetNoteCard, updateOrCreateNotecard, type NoteCard } from '../src/utils/noteCards';
import type { BoundsNode } from '../src/utils/noteCards';

describe('LOAD_PRESET over a scene with a card', () => {
  let rendered: NoteCard[] = [];
  beforeEach(() => {
    rendered = [makePresetNoteCard('double_pendulum')!];
  });

  it('keeps the new preset card when the refresh reads straight back', () => {
    const ref = { current: rendered };
    // The React state only changes on the next render, which never comes here.
    const set = syncedSetter<NoteCard[]>(ref, () => {});
    (globalThis as unknown as { window: unknown }).window = {
      _physics_getNoteCards: () => ref.current,
      _physics_setNoteCards: (cards: NoteCard[]) => set(cards),
    };
    const empty = makePresetNoteCard('empty');
    expect(empty).not.toBeNull();
    set([empty!]);
    updateOrCreateNotecard({ mode: 'mcp', nodes: [] });
    expect(ref.current[0].markdown).toMatch(/^# Blank Scene/);
    expect(ref.current[0].markdown).not.toContain('Double Pendulum');
  });

  it('applies functional updates to the latest value', () => {
    const ref = { current: [1] };
    let state = [1];
    const set = syncedSetter<number[]>(ref, (v) => { state = v; });
    set([2]);
    set((prev) => [...prev, 3]);
    expect(state).toEqual([2, 3]);
  });
});

describe('component bounding boxes', () => {
  const box = (name: string, size: number[]) => ({ name, type: 'box', size });

  it('places a child by its pose, not centred on its pos', () => {
    // A seat with a leg hanging below it: the leg's frame is at the seat's
    // corner and its shape runs downward from there.
    const chair: BoundsNode = {
      name: 'chair',
      geoms: [box('seat', [0.18, 0.18, 0.015])],
      children: [{
        name: 'leg', pos: [0.165, 0.165, -0.015],
        geoms: [{ name: 'leg_mesh', type: 'mesh', renderVertices: [-0.015, -0.015, 0, 0.015, 0.015, -0.41] }],
      }],
    };
    const b = computeNodeBoundingBox(chair);
    expect(b.x).toBeCloseTo(0.36, 6);
    expect(b.y).toBeCloseTo(0.36, 6);
    expect(b.z).toBeCloseTo(0.015 + 0.015 + 0.41, 6);
  });

  it('turns a child by its orientation', () => {
    const node: BoundsNode = {
      name: 'hub',
      children: [{ name: 'arm', pos: [0, 0, 0], euler: [0, 0, 90], geoms: [box('arm', [0.1, 0.01, 0.01])] }],
    };
    const b = computeNodeBoundingBox(node);
    expect(b.x).toBeCloseTo(0.02, 6);
    expect(b.y).toBeCloseTo(0.2, 6);
  });

  it('leaves a negative out of the size', () => {
    const node: BoundsNode = {
      name: 'plate',
      geoms: [box('plate', [0.05, 0.05, 0.005]), { name: 'bore', type: 'cylinder', size: [0.2, 0.2], csg: 'difference' }],
    };
    expect(computeNodeBoundingBox(node).x).toBeCloseTo(0.1, 6);
  });
});
