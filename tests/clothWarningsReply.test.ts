// A cloth naming what it does not have (a trim along a line it lacks, a pocket
// on a panel a seam renamed) used to be said only in physics_get_state: the
// command that wrote it replied {ok:true} and the editor showed nothing. The
// reply now carries the cloth's own warnings, and the store the Garment card
// reads holds them.

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', { value: { hardwareConcurrency: 4 }, configurable: true });
  }
});

import * as THREE from 'three';
import type { SceneNode } from '../src/types/scene';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { clothModel } from '../src/utils/cloth/clothModel';
import { objectCommands } from '../src/hooks/mcp/objectCommands';
import { useStore } from '../src/store/useStore';
import { clothWarningsOf, noteClothWarnings, useClothStatus } from '../src/store/clothStatus';

/** What the worker does on a build: models each cloth and posts what it warned of, by name. */
const workerBuild = () => {
  const nodes = useStore.getState().sceneGraph.nodes;
  const out: string[] = [];
  for (const n of nodes) {
    if (!n.cloth) continue;
    try {
      const m = clothModel(n, new THREE.Matrix4(), nodes);
      for (const w of m.warnings ?? []) out.push(`${m.name}: ${w}`);
    } catch (err) { out.push(`${n.name}: not built: ${String(err)}`); }
  }
  noteClothWarnings(out);
};

describe('cloth warnings in the reply that caused them', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    noteClothWarnings([]);
    useStore.setState({
      recompile: vi.fn().mockImplementation(async () => workerBuild()) as never,
      undoStack: [], redoStack: [], tempUndoState: null, lastInteractionType: null,
    });
  });

  it('update_object replies with the name that matched nothing, and only its own cloth\'s', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const skirt = garmentNode('skirt', 'skirt', { garment: 'skirt' }, form);
    const other = garmentNode('other', 'other', { garment: 'skirt', trims: [{ kind: 'stud', along: 'nowhere' }] }, form);
    useStore.setState({ sceneGraph: { nodes: [form, skirt, other] } });
    const r = await objectCommands.UPDATE_OBJECT({
      targetId: 'skirt',
      updates: { cloth: { ...skirt.cloth!, garment: { ...skirt.cloth!.garment!, trims: [{ kind: 'button', along: 'placket' }] } } },
    } as never, { store: useStore.getState() } as never) as { ok: boolean; clothWarnings?: string[] };
    expect(r.ok).toBe(true);
    expect(r.clothWarnings).toHaveLength(1);
    expect(r.clothWarnings![0]).toMatch(/^skirt: trims\[0\]\.along 'placket' names no line of this garment \(its lines: .*hem/);
    // The editor's store has them, for the card of each cloth.
    const all = useClothStatus.getState().warnings;
    expect(clothWarningsOf(all, 'skirt')[0]).toMatch(/^trims\[0\]\.along 'placket'/);
    expect(clothWarningsOf(all, 'other')[0]).toMatch(/^trims\[0\]\.along 'nowhere'/);
  }, 180_000);

  it('a clean update says nothing about cloth', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const skirt = garmentNode('skirt', 'skirt', { garment: 'skirt' }, form);
    useStore.setState({ sceneGraph: { nodes: [form, skirt] } });
    const r = await objectCommands.UPDATE_OBJECT({
      targetId: 'skirt', updates: { cloth: { ...skirt.cloth!, garment: { ...skirt.cloth!.garment!, length: 0.4 } } },
    } as never, { store: useStore.getState() } as never) as { ok: boolean; clothWarnings?: string[] };
    expect(r.ok).toBe(true);
    expect(r.clothWarnings).toBeUndefined();
  }, 180_000);

  it('update_object refuses an unknown kind and leaves the garment as it was', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const skirt = garmentNode('skirt', 'skirt', { garment: 'skirt' }, form);
    useStore.setState({ sceneGraph: { nodes: [form, skirt] } });
    const r = await objectCommands.UPDATE_OBJECT({
      targetId: 'skirt', updates: { cloth: { ...skirt.cloth!, garment: { ...skirt.cloth!.garment!, garment: 'shorts' } } },
    } as never, { store: useStore.getState() } as never) as { ok: boolean; error?: string };
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/"shorts", which is not one of: tshirt, dress, skirt/);
    expect((useStore.getState().sceneGraph.nodes.find((n) => n.id === 'skirt') as SceneNode).cloth?.garment?.garment).toBe('skirt');
  });
});
