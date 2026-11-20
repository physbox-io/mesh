import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  if (typeof globalThis.navigator === 'undefined') {
    Object.defineProperty(globalThis, 'navigator', {
      value: { hardwareConcurrency: 4 },
      configurable: true,
    });
  }
});

import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { ModelMirror } from '../src/types/sceneLayer';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { clampBodyForm } from '../src/utils/cloth/bodyForm';
import { bodyFormKey, needsBodyFormBuild } from '../src/utils/cloth/bodyFormEdit';
import { clothModel } from '../src/utils/cloth/clothModel';
import { rectEdges } from '../src/utils/cloth/clothSheet';
import { copyBodies, pasteBodies } from '../src/utils/duplicateNodes';
import { uniquifyNamesInPlace, withUniqueNames } from '../src/utils/uniqueNames';
import { dropDanglingReferencesInPlace, withoutDanglingReferences } from '../src/utils/danglingReferences';
import { unresolvedReferences, unresolvedReferenceWarnings } from '../src/utils/unresolvedReferences';
import { bodyPhysicsKey, isFabricationScene, staleBodies, summarizeNode } from '../src/utils/sceneSummary';
import { compileToMJCF } from '../src/utils/mjcf';
import { FASTENINGS } from '../src/components/inspector/garmentStyles';
import { objectCommands } from '../src/hooks/mcp/objectCommands';
import { cloneSceneGraph, useStore } from '../src/store/useStore';

const cloneNodes = (nodes: SceneNode[]) => cloneSceneGraph({ nodes } as SceneGraph).nodes;

const find = (nodes: SceneNode[], id: string): SceneNode | null => {
  for (const n of nodes) {
    if (n.id === id) return n;
    const c = find(n.children ?? [], id);
    if (c) return c;
  }
  return null;
};

const at = (nodes: SceneNode[], id: string): SceneNode => {
  const n = find(nodes, id);
  if (!n) throw new Error(`missing node ${id}`);
  return n;
};

const post = (id: string, pos: [number, number, number] = [0, 0, 0]): SceneNode => ({
  id,
  name: id,
  pos,
  geoms: [{ name: `${id}_g`, type: 'cylinder', size: [0.03, 1.0] }],
  joints: [],
  children: [],
} as unknown as SceneNode);

const sailNode = (id: string, name: string, postNames: string[]): SceneNode => ({
  id,
  name,
  pos: [0, 0, 2],
  cloth: {
    pieces: [{ name: 'sheet', edges: rectEdges(1.2, 1.2) }],
    material: 'shadeCloth',
    ties: [
      { piece: 'sheet', edge: 'south', at: 0, to: postNames[0], anchor: [0, 0, 1] },
      { piece: 'sheet', edge: 'east', at: 0, to: postNames[1], anchor: [0, 0, 1] },
    ],
  },
  geoms: [],
  joints: [],
  children: [],
} as unknown as SceneNode);

const bowOnClothNode = (id: string, name: string, hostClothName: string): SceneNode => ({
  id,
  name,
  pos: [0, -0.15, 1.0],
  cloth: {
    pieces: [{ name: 'sheet', edges: rectEdges(0.18, 0.08) }],
    material: 'taffeta',
    ties: [{ piece: 'sheet', edge: 'south', at: 0.5, toCloth: hostClothName }],
  },
  geoms: [],
  joints: [],
  children: [],
} as unknown as SceneNode);

describe('cloth reference hygiene across scene operations', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    useStore.setState({
      recompile: vi.fn().mockResolvedValue(undefined) as never,
      undoStack: [],
      redoStack: [],
      tempUndoState: null,
      lastInteractionType: null,
    });
  });

  it('renameNode rewrites garment fitTo, tie.to, tie.toCloth, and renames form geoms without invalidating bodyFormBuilt', () => {
    const form = bodyFormNode('form_id', 'form', { figure: 'female' });
    const skirt = garmentNode('skirt_id', 'skirt', { garment: 'skirt' }, form);
    const bow = bowOnClothNode('bow_id', 'bow', 'skirt');
    const p1 = post('post1', [-1, -1, 0]);
    const p2 = post('post2', [1, -1, 0]);
    const sail = sailNode('sail_id', 'sail', ['post1', 'post2']);
    useStore.setState({ sceneGraph: { nodes: [form, skirt, bow, p1, p2, sail] } });

    useStore.getState().renameNode('form_id', 'mannequin');
    let nodes = useStore.getState().sceneGraph.nodes;
    const renamedForm = at(nodes, 'form_id');
    expect(renamedForm.name).toBe('mannequin');
    expect(renamedForm.geoms.every((g) => g.name.startsWith('mannequin_'))).toBe(true);
    expect(needsBodyFormBuild(renamedForm)).toBe(false);
    expect(at(nodes, 'skirt_id').cloth!.garment!.fitTo).toBe('mannequin');
    // clothModel builds cleanly against the renamed form without throwing.
    expect(() => clothModel(at(nodes, 'skirt_id'), new THREE.Matrix4(), nodes)).not.toThrow();

    useStore.getState().renameNode('skirt_id', 'evening_skirt');
    useStore.getState().renameNode('post1', 'mast_sw');
    nodes = useStore.getState().sceneGraph.nodes;
    expect(at(nodes, 'bow_id').cloth!.ties![0].toCloth).toBe('evening_skirt');
    expect(at(nodes, 'sail_id').cloth!.ties![0].to).toBe('mast_sw');
    expect(at(nodes, 'sail_id').cloth!.ties![1].to).toBe('post2');
  });

  it('renameNode resolves clashing new names cleanly through withUniqueNames', () => {
    const other = post('other_id');
    other.name = 'mannequin';
    const form = bodyFormNode('form_id', 'form', { figure: 'male' });
    const tee = garmentNode('tee_id', 'tee', { garment: 'tshirt' }, form);
    useStore.setState({ sceneGraph: { nodes: [other, form, tee] } });

    useStore.getState().renameNode('form_id', 'mannequin');
    const nodes = useStore.getState().sceneGraph.nodes;
    expect(at(nodes, 'form_id').name).toBe('mannequin_2');
    expect(at(nodes, 'tee_id').cloth!.garment!.fitTo).toBe('mannequin_2');
  });

  it('duplicating a form + garment + ornament and posts + sail retargets copies to *_2', () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const gown = garmentNode('gown', 'gown', { garment: 'skirt' }, form);
    const bow = bowOnClothNode('bow', 'bow', 'gown');
    const p1 = post('post1', [-1, 0, 0]);
    const p2 = post('post2', [1, 0, 0]);
    const sail = sailNode('sail', 'sail', ['post1', 'post2']);
    const scene: SceneGraph = { nodes: [form, gown, bow, p1, p2, sail] };

    const board = copyBodies(scene, ['form', 'gown', 'bow', 'post1', 'post2', 'sail'], cloneNodes)!;
    const [form2Id, gown2Id, bow2Id, , , sail2Id] = pasteBodies(scene, board, 1, cloneNodes);
    const unique = withUniqueNames(scene);

    expect(at(unique.nodes, form2Id).name).toBe('form_2');
    expect(needsBodyFormBuild(at(unique.nodes, form2Id))).toBe(false);
    expect(at(unique.nodes, gown2Id).cloth!.garment!.fitTo).toBe('form_2');
    expect(at(unique.nodes, bow2Id).cloth!.ties![0].toCloth).toBe('gown_2');
    expect(at(unique.nodes, sail2Id).cloth!.ties!.map((t) => t.to)).toEqual(['post1_2', 'post2_2']);

    // Originals stay pointed at the originals.
    expect(at(unique.nodes, 'gown').cloth!.garment!.fitTo).toBe('form');
    expect(at(unique.nodes, 'bow').cloth!.ties![0].toCloth).toBe('gown');
    expect(at(unique.nodes, 'sail').cloth!.ties!.map((t) => t.to)).toEqual(['post1', 'post2']);

    // In-place uniquify gives the exact same result.
    uniquifyNamesInPlace(scene.nodes);
    expect(at(scene.nodes, gown2Id).cloth!.garment!.fitTo).toBe('form_2');
    expect(at(scene.nodes, bow2Id).cloth!.ties![0].toCloth).toBe('gown_2');
    expect(at(scene.nodes, sail2Id).cloth!.ties!.map((t) => t.to)).toEqual(['post1_2', 'post2_2']);
  });

  it('pasting into an empty scene resolves fitTo to "form", and a second paste to "form_2"', () => {
    const form = bodyFormNode('form', 'form', { figure: 'male' });
    const tee = garmentNode('tee', 'tee', { garment: 'tshirt' }, form);
    const source: SceneGraph = { nodes: [form, tee] };
    const board = copyBodies(source, ['form', 'tee'], cloneNodes)!;

    const dest: SceneGraph = { nodes: [] };
    const [, tee1Id] = pasteBodies(dest, board, 1, cloneNodes);
    const afterFirst = withUniqueNames(dest);
    expect(at(afterFirst.nodes, tee1Id).cloth!.garment!.fitTo).toBe('form');

    const [, tee2Id] = pasteBodies(afterFirst, board, 2, cloneNodes);
    const afterSecond = withUniqueNames(afterFirst);
    expect(at(afterSecond.nodes, tee1Id).cloth!.garment!.fitTo).toBe('form');
    expect(at(afterSecond.nodes, tee2Id).cloth!.garment!.fitTo).toBe('form_2');
  });

  it('withoutDanglingReferences releases orphaned garments and drops dangling ties cleanly', () => {
    const box = post('plain_box');
    const orphanGarment: SceneNode = {
      id: 'tee',
      name: 'tee',
      pos: [0, 0, 0],
      cloth: { garment: { garment: 'skirt', fitTo: 'missing_form' }, material: 'woven' },
      geoms: [],
      joints: [],
      children: [],
    } as unknown as SceneNode;
    const wrongHostGarment: SceneNode = {
      id: 'tee2',
      name: 'tee2',
      pos: [0, 0, 0],
      cloth: { garment: { garment: 'skirt', fitTo: 'plain_box' }, material: 'woven' },
      geoms: [],
      joints: [],
      children: [],
    } as unknown as SceneNode;
    const sail = sailNode('sail', 'sail', ['plain_box', 'missing_post']);
    const bow = bowOnClothNode('bow', 'bow', 'missing_cloth');
    const input: SceneGraph = { nodes: [box, orphanGarment, wrongHostGarment, sail, bow] };

    // Diagnostics catch every broken cloth reference before cleanup.
    const refs = unresolvedReferences(input.nodes);
    expect(refs.map((r) => `${r.bodyId}.${r.field}:${r.reason}`)).toEqual([
      'tee.cloth.garment.fitTo:missing',
      'tee2.cloth.garment.fitTo:notBodyForm',
      'sail.cloth.ties[1].to:missing',
      'bow.cloth.ties[0].toCloth:missing',
    ]);
    const warnings = unresolvedReferenceWarnings(refs);
    expect(warnings.some((w) => w.includes('not a body form'))).toBe(true);

    const cleaned = withoutDanglingReferences(input);
    // Input is never mutated.
    expect(orphanGarment.cloth!.garment!.fitTo).toBe('missing_form');
    // Released garments have no fitTo, carry fallback form measurements, and build without throwing!
    const released = at(cleaned.nodes, 'tee');
    expect(released.cloth!.garment!.fitTo).toBeUndefined();
    expect(released.cloth!.garment!.form).toBeDefined();
    expect(() => clothModel(released, new THREE.Matrix4(), cleaned.nodes)).not.toThrow();
    expect(at(cleaned.nodes, 'tee2').cloth!.garment!.fitTo).toBeUndefined();

    // Live tie kept, missing tie dropped; bow's sole missing tie removed cleanly.
    expect(at(cleaned.nodes, 'sail').cloth!.ties).toHaveLength(1);
    expect(at(cleaned.nodes, 'sail').cloth!.ties![0].to).toBe('plain_box');
    expect(at(cleaned.nodes, 'bow').cloth!.ties).toBeUndefined();
    expect(withoutDanglingReferences(cleaned)).toBe(cleaned);

    // In-place variant matches.
    const copy = cloneSceneGraph(input);
    dropDanglingReferencesInPlace(copy.nodes);
    expect(at(copy.nodes, 'tee').cloth!.garment!.fitTo).toBeUndefined();
    expect(at(copy.nodes, 'bow').cloth!.ties).toBeUndefined();
  }, 60_000);
});

describe('applyBodyFormGeoms, headless lazy bodyForm MJCF, MCP SET_COLOR, and sceneSummary', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    useStore.setState({
      recompile: vi.fn().mockResolvedValue(undefined) as never,
      undoStack: [],
      redoStack: [],
      tempUndoState: null,
      lastInteractionType: null,
    });
  });

  it('applyBodyFormGeoms installs worker geoms without clobbering redoStack after Undo', () => {
    const built = bodyFormNode('form', 'form', { figure: 'female', height: 1.68 });
    const lazyForm: SceneNode = { ...built, geoms: [], bodyFormBuilt: undefined };
    useStore.setState({ sceneGraph: { nodes: [lazyForm] } });

    // Perform a discrete user edit and flush undo, then undo it so redoStack is populated.
    useStore.getState().prepareForDiscreteChange();
    useStore.getState().updateNode('form', { bodyForm: { height: 1.75 } as never }, true);
    useStore.getState().flushPendingUndo();
    expect(useStore.getState().undoStack.length).toBe(1);

    useStore.getState().undo();
    expect(useStore.getState().redoStack.length).toBe(1);

    // Background worker finishes building the restored 1.68 m form: redoStack must survive!
    const restored = at(useStore.getState().sceneGraph.nodes, 'form');
    const key = bodyFormKey(restored);
    useStore.getState().applyBodyFormGeoms('form', built.geoms, key, true);

    const after = at(useStore.getState().sceneGraph.nodes, 'form');
    expect(after.geoms.length).toBeGreaterThan(20);
    expect(after.bodyFormBuilt).toBe(key);
    expect(useStore.getState().redoStack.length).toBe(1);
  });

  it('mjcfPrepare populates bodyFormGeoms for lazy geoms: [] forms during headless compileToMJCF', () => {
    const lazyForm: SceneNode = {
      id: 'form',
      name: 'form',
      pos: [0, 0, 0],
      bodyForm: clampBodyForm({ figure: 'male' }),
      geoms: [],
      joints: [],
      children: [],
    } as unknown as SceneNode;
    const xml = compileToMJCF({ nodes: [lazyForm] });
    expect(xml).toContain('form_torso');
    expect(xml).toContain('form_head');
  });

  it('SET_COLOR supports garments and plain cloth pieces', async () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const tee = garmentNode('tee', 'tee', {
      garment: 'tshirt',
      attached: [{ name: 'ribbon', onto: 'hem', shape: { kind: 'band', width: 0.04 } }],
    }, form);
    const sail = sailNode('sail', 'sail', ['form', 'form']);
    useStore.setState({ sceneGraph: { nodes: [form, tee, sail] } });

    const ctx = { store: useStore.getState() } as never;
    const r1 = await objectCommands.SET_COLOR({ targetId: 'tee', rgba: [0.9, 0.1, 0.2, 1] } as never, ctx);
    expect(r1).toEqual({ ok: true, geomsColored: 1 });
    expect(at(useStore.getState().sceneGraph.nodes, 'tee').cloth!.garment!.rgba).toEqual([0.9, 0.1, 0.2, 1]);

    const r2 = await objectCommands.SET_COLOR({ targetId: 'tee', geomName: 'ribbon', rgba: [0.1, 0.2, 0.8] } as never, { store: useStore.getState() } as never);
    expect(r2).toEqual({ ok: true, geomsColored: 1 });
    expect(at(useStore.getState().sceneGraph.nodes, 'tee').cloth!.garment!.attached![0].rgba).toEqual([0.1, 0.2, 0.8, 1]);

    const r3 = await objectCommands.SET_COLOR({ targetId: 'sail', geomName: 'sheet', rgba: [0.2, 0.7, 0.3, 1] } as never, { store: useStore.getState() } as never);
    expect(r3).toEqual({ ok: true, geomsColored: 1 });
    expect(at(useStore.getState().sceneGraph.nodes, 'sail').cloth!.pieces![0].rgba).toEqual([0.2, 0.7, 0.3, 1]);

    await expect(
      objectCommands.SET_COLOR({ targetId: 'sail', geomName: 'nope', rgba: [1, 0, 0] } as never, { store: useStore.getState() } as never),
    ).rejects.toThrow(/no piece named 'nope'/);
  });

  it('sceneSummary summarizes cloth/bodyForm concisely, tracks structural staleness only, and skips CNC stock checks', () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const jacket = garmentNode('jacket', 'jacket', { garment: 'jacket' }, form);
    const scene: SceneGraph = { nodes: [form, jacket] };

    expect(isFabricationScene(scene, null)).toBe(false);

    // Visual-only colour/print edits do not mark physics stale; structural edits do.
    const visualEdit: SceneGraph = {
      nodes: [
        form,
        { ...jacket, cloth: { ...jacket.cloth!, garment: { ...jacket.cloth!.garment!, rgba: [0.8, 0.2, 0.2, 1], pattern: { svg: '<svg/>', scale: 0.3 } } } },
      ],
    };
    expect(bodyPhysicsKey(visualEdit.nodes[1])).toBe(bodyPhysicsKey(jacket));
    expect([...staleBodies(visualEdit, scene)]).toEqual([]);

    const structuralEdit: SceneGraph = {
      nodes: [
        form,
        { ...jacket, cloth: { ...jacket.cloth!, garment: { ...jacket.cloth!.garment!, length: 0.75 } } },
      ],
    };
    expect([...staleBodies(structuralEdit, scene)]).toEqual(['jacket']);

    const mockModel = {
      flexes: [
        { name: 'jacket__frontL', vertadr: 0, vertnum: 40, elems: [0, 1, 2, 2, 3, 0], rgba: [0.2, 0.2, 0.2, 1] },
        { name: 'jacket__back', vertadr: 40, vertnum: 50, elems: [0, 1, 2], rgba: [0.2, 0.2, 0.2, 1] },
      ],
    } as unknown as ModelMirror;
    const formSummary = summarizeNode(form, { model: mockModel });
    expect(formSummary.bodyForm).toMatchObject({ figure: 'female', partGeoms: form.geoms.length });
    expect(formSummary.geoms).toEqual([]);

    const jacketSummary = summarizeNode(jacket, { model: mockModel, stale: new Set(['jacket']) });
    expect(jacketSummary.cloth).toMatchObject({
      kind: 'jacket',
      fitTo: 'form',
      pieceCount: 2,
      pieces: ['frontL', 'back'],
      vertCount: 90,
      triCount: 3,
      stale: true,
    });

    // FASTENINGS keeps 'zip' selected even when unzipped to 0% (`fastened: false` or `0`).
    const zipChoice = FASTENINGS.find((f) => f.id === 'zip')!;
    const openChoice = FASTENINGS.find((f) => f.id === 'open')!;
    expect(zipChoice.is({ garment: 'jacket', trims: [{ kind: 'zipper', along: 'opening', fastened: false }] })).toBe(true);
    expect(zipChoice.is({ garment: 'jacket', trims: [{ kind: 'zipper', along: 'opening', fastened: 0 }] })).toBe(true);
    expect(openChoice.is({ garment: 'jacket', trims: [{ kind: 'zipper', along: 'opening', fastened: false }] })).toBe(false);
  });
});
