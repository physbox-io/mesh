// Scene operations that must carry acoustic fields along: copy/paste, joint
// renames, scaling, dangling references and a combine.

import { beforeEach, describe, expect, it } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { soundboxLyrePreset } from '../src/presets/soundboxLyre';
import { bowedCelloPreset } from '../src/presets/bowedCello';
import { windInstrumentsPreset } from '../src/presets/windInstruments';
import { cloneSceneGraph, useStore } from '../src/store/useStore';
import { copyBodies, pasteBodies } from '../src/utils/duplicateNodes';
import { uniquifyNamesInPlace, withUniqueNames } from '../src/utils/uniqueNames';
import { withoutDanglingReferences } from '../src/utils/danglingReferences';
import { unresolvedReferences, unresolvedReferenceWarnings } from '../src/utils/unresolvedReferences';
import { retargetReferences } from '../src/store/breakage';
import { scaleNodeTree } from '../src/utils/scaleNode';
import { measureStringLengthM } from '../src/utils/stringAcoustics';

const cloneNodes = (nodes: SceneNode[]) => cloneSceneGraph({ nodes } as SceneGraph).nodes;
const fresh = (g: SceneGraph) => cloneSceneGraph(g);
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
  if (!n) throw new Error(`no body ${id}`);
  return n;
};
const box = (id: string, extra: Partial<SceneNode> = {}): SceneNode => ({
  id, name: id, pos: [0, 0, 0], joints: [], children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: [0.02, 0.02, 0.02] }],
  ...extra,
} as SceneNode);

describe('duplicating bodies with acoustic references', () => {
  it('points a copied string at the copied soundbox, and keeps an outside host', () => {
    const scene = fresh(soundboxLyrePreset);
    at(scene.nodes, 'lyre_soundbox_string_1').resonatorNodeId = 'lyre_soundbox';
    at(scene.nodes, 'lyre_soundbox_string_1').acousticString!.resonatorNodeId = 'lyre_soundbox';

    // The strings hang under the soundbox, so copying it copies them too: the
    // copied string follows the new soundbox.
    const board = copyBodies(scene, ['lyre_soundbox'], cloneNodes)!;
    const [boxId] = pasteBodies(scene, board, 1, cloneNodes);
    const copy = at(scene.nodes, boxId).children.find((c) => c.name === 'String 1')!;
    expect(boxId).not.toBe('lyre_soundbox');
    expect(copy.resonatorNodeId).toBe(boxId);
    expect(copy.acousticString!.resonatorNodeId).toBe(boxId);
    // The original still names the original.
    expect(at(scene.nodes, 'lyre_soundbox_string_1').acousticString!.resonatorNodeId).toBe('lyre_soundbox');

    // String alone: its host is outside the copy and still valid.
    const alone = copyBodies(scene, ['lyre_soundbox_string_1'], cloneNodes)!;
    const [aloneId] = pasteBodies(scene, alone, 1, cloneNodes);
    expect(at(scene.nodes, aloneId).resonatorNodeId).toBe('lyre_soundbox');
    expect(at(scene.nodes, aloneId).acousticString!.resonatorNodeId).toBe('lyre_soundbox');
  });

  it('remaps a drumhead shell and a tube bar inside the copy; cuts a bar outside it', () => {
    const head = box('head', { acousticMembrane: { material: 'mylar', tensionNPerM: 2000, thicknessMm: 0.2, shellNodeId: 'shell' } });
    const shell = box('shell', { children: [head] });
    const tube = box('tube', { resonatorTube: { coupledBarNodeId: 'bar', vaneJointName: 'vane' } });
    const bar = box('bar');
    const kit = box('kit', { children: [bar, tube] });
    const scene = { nodes: [shell, kit] } as SceneGraph;

    const [shellCopy] = pasteBodies(scene, copyBodies(scene, ['shell'], cloneNodes)!, 1, cloneNodes);
    const headCopy = at(scene.nodes, shellCopy).children[0];
    expect(headCopy.acousticMembrane!.shellNodeId).toBe(shellCopy);

    const [kitCopy] = pasteBodies(scene, copyBodies(scene, ['kit'], cloneNodes)!, 1, cloneNodes);
    const [barCopy, tubeCopy] = at(scene.nodes, kitCopy).children;
    expect(tubeCopy.resonatorTube!.coupledBarNodeId).toBe(barCopy.id);

    const [lone] = pasteBodies(scene, copyBodies(scene, ['tube'], cloneNodes)!, 1, cloneNodes);
    expect(at(scene.nodes, lone).resonatorTube!.coupledBarNodeId).toBeUndefined();
    expect(at(scene.nodes, lone).resonatorTube!.vaneJointName).toBe('vane');
    expect(tube.resonatorTube!.coupledBarNodeId).toBe('bar');
  });
});

describe('renaming joints rewrites the instrument that names them', () => {
  it('follows a copied clarinet\'s and cornet\'s joints, per subtree', () => {
    const scene = fresh(windInstrumentsPreset);
    const board = copyBodies(scene, ['grenadilla_clarinet', 'brass_bugle_horn'], cloneNodes)!;
    const [clarinetId, hornId] = pasteBodies(scene, board, 1, cloneNodes);
    const renamed = withUniqueNames(scene);
    expect(renamed).not.toBe(scene);

    const clarinet = at(renamed.nodes, clarinetId);
    const keys = clarinet.children.map((k) => k.joints[0].name);
    expect(keys).toEqual(['clarinet_key_1_2', 'clarinet_key_2_2', 'clarinet_key_3_2', 'clarinet_key_4_2']);
    expect(clarinet.windInstrument!.toneholeJoints!.map((t) => t.jointName)).toEqual(keys);
    const horn = at(renamed.nodes, hornId);
    expect(horn.windInstrument!.valveJoints!.map((v) => v.jointName))
      .toEqual(horn.children.map((v) => v.joints[0].name));
    expect(horn.windInstrument!.valveJoints![0].jointName).toBe('cornet_valve_1_2');
    // The originals keep theirs.
    expect(at(renamed.nodes, 'grenadilla_clarinet').windInstrument!.toneholeJoints![0].jointName).toBe('clarinet_key_1');
    // The input was not written to.
    expect(at(scene.nodes, clarinetId).windInstrument!.toneholeJoints![0].jointName).toBe('clarinet_key_1');

    // In place gives the same answer.
    uniquifyNamesInPlace(scene.nodes);
    expect(at(scene.nodes, clarinetId).windInstrument!.toneholeJoints!.map((t) => t.jointName)).toEqual(keys);
  });

  it('follows a tube\'s vane joint, and leaves a clean scene as the same object', () => {
    const vane = box('vane', { joints: [{ name: 'fan', type: 'hinge' } as never] });
    const a = box('tubeA', { resonatorTube: { vaneJointName: 'fan' }, children: [vane] });
    const vane2 = box('vane2', { joints: [{ name: 'fan', type: 'hinge' } as never] });
    const b = box('tubeB', { resonatorTube: { vaneJointName: 'fan' }, children: [vane2] });
    const scene = { nodes: [a, b] } as SceneGraph;
    const out = withUniqueNames(scene);
    expect(at(out.nodes, 'tubeA').resonatorTube!.vaneJointName).toBe('fan');
    expect(at(out.nodes, 'tubeB').resonatorTube!.vaneJointName).toBe('fan_2');

    const clean = fresh(windInstrumentsPreset);
    expect(withUniqueNames(clean)).toBe(clean);
  });
});

describe('dangling and unresolved acoustic references', () => {
  const scene = (): SceneGraph => ({
    nodes: [
      box('host'),
      box('s_ok', { resonatorNodeId: 'host', acousticString: { material: 'steel', diameterMm: 0.5, tensionN: 50, resonatorNodeId: 'host' } }),
      box('s_gone', { resonatorNodeId: 'ghost', acousticString: { material: 'steel', diameterMm: 0.5, tensionN: 50, resonatorNodeId: 'ghost' } }),
      box('drum', { acousticMembrane: { material: 'mylar', tensionNPerM: 2000, thicknessMm: 0.2, shellNodeId: 'ghost_shell' } }),
      box('tube', { resonatorTube: { coupledBarNodeId: 'ghost_bar', vaneJointName: 'nope' } }),
      box('horn', {
        windInstrument: {
          exciter: 'reed', breathKPa: 0, embouchureHz: 200,
          toneholeJoints: [{ jointName: 'k_missing', axialFraction: 0.5, diameterMm: 8 }],
          valveJoints: [{ jointName: 'v_missing', semitones: 1 }],
        },
      }),
    ],
  } as SceneGraph);

  it('clears ids that name nothing, without touching the input', () => {
    const input = scene();
    const out = withoutDanglingReferences(input);
    expect(out.nodes[1]).toBe(input.nodes[1]);
    expect(out.nodes[1].acousticString!.resonatorNodeId).toBe('host');
    expect(out.nodes[2].resonatorNodeId).toBeUndefined();
    expect(out.nodes[2].acousticString!.resonatorNodeId).toBeUndefined();
    expect(out.nodes[2].acousticString!.tensionN).toBe(50);
    expect(out.nodes[3].acousticMembrane!.shellNodeId).toBeUndefined();
    expect(out.nodes[4].resonatorTube!.coupledBarNodeId).toBeUndefined();
    expect(out.nodes[4].resonatorTube!.vaneJointName).toBe('nope');
    expect(input.nodes[2].acousticString!.resonatorNodeId).toBe('ghost');
    expect(withoutDanglingReferences(out)).toBe(out);
  });

  it('keeps references to the presets\' real hosts and warns about the rest', () => {
    const lyre = fresh(soundboxLyrePreset);
    at(lyre.nodes, 'lyre_soundbox_string_2').acousticString!.resonatorNodeId = 'lyre_soundbox';
    expect(withoutDanglingReferences(lyre)).toBe(lyre);

    const warnings = unresolvedReferenceWarnings(unresolvedReferences(scene().nodes));
    expect(warnings.some((w) => w.includes("acousticString.resonatorNodeId 'ghost'"))).toBe(true);
    expect(warnings.some((w) => w.includes("resonatorNodeId 'ghost' on"))).toBe(true);
    expect(warnings.some((w) => w.includes("acousticMembrane.shellNodeId 'ghost_shell'"))).toBe(true);
    expect(warnings.some((w) => w.includes("resonatorTube.coupledBarNodeId 'ghost_bar'"))).toBe(true);
    expect(warnings.some((w) => w.includes("resonatorTube.vaneJointName 'nope'"))).toBe(true);
    expect(warnings.some((w) => w.includes("toneholeJoints[0].jointName 'k_missing'"))).toBe(true);
    expect(warnings.some((w) => w.includes("valveJoints[0].jointName 'v_missing'"))).toBe(true);
    expect(warnings.some((w) => w.includes("'host'"))).toBe(false);

    // The shipped instruments name joints their keys really have.
    expect(unresolvedReferences(fresh(windInstrumentsPreset).nodes)).toEqual([]);
  });
});

describe('combining retargets acoustic references', () => {
  it('moves a string\'s soundbox from the merged body to the target', () => {
    const nodes = [
      box('target'), box('source'),
      box('s', { resonatorNodeId: 'source', acousticString: { material: 'steel', diameterMm: 0.5, tensionN: 50, resonatorNodeId: 'source' } }),
      box('d', { acousticMembrane: { material: 'mylar', tensionNPerM: 2000, thicknessMm: 0.2, shellNodeId: 'source' } }),
      box('t', { resonatorTube: { coupledBarNodeId: 'source' } }),
    ];
    const out = retargetReferences(nodes.filter((n) => n.id !== 'source'), 'source', 'target');
    expect(at(out, 's').resonatorNodeId).toBe('target');
    expect(at(out, 's').acousticString!.resonatorNodeId).toBe('target');
    expect(at(out, 'd').acousticMembrane!.shellNodeId).toBe('target');
    expect(at(out, 't').resonatorTube!.coupledBarNodeId).toBe('target');
    // The inputs are untouched.
    expect(nodes[2].acousticString!.resonatorNodeId).toBe('source');
  });
});

describe('scaling acoustic bodies', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
  });
  const load = (g: SceneGraph) => useStore.setState({ sceneGraph: fresh(g), model: null, data: null });
  const body = (id: string) => at(useStore.getState().sceneGraph.nodes, id);

  it('re-stiffens a string for its new length and drops its tuned pitch', () => {
    load(bowedCelloPreset);
    const id = 'cello_soundbox_string_1';
    const before = body(id);
    expect(before.tunedPitchHz).toBeGreaterThan(0);
    const tension = before.acousticString!.tensionN;
    scaleNodeTree(id, 1.5, 1.5, 1.5);
    const after = body(id);
    expect(after.tunedPitchHz).toBeUndefined();
    expect(after.acousticString!.tensionN).toBe(tension);
    const length = measureStringLengthM(after);
    expect(length).toBeGreaterThan(measureStringLengthM(before));
    const slide = after.joints[0];
    expect(slide.stiffness).toBeCloseTo(+(4 * tension / length).toFixed(1), 1);
    expect(slide.stiffness).not.toBe(before.joints[0].stiffness);
    expect(slide.damping).toBeCloseTo(Math.max(0.04, slide.stiffness! * 0.0008), 3);
  });

  it('scales joint anchors and a wind instrument\'s own dimensions', () => {
    const wind = fresh(windInstrumentsPreset);
    const clarinet = at(wind.nodes, 'grenadilla_clarinet');
    clarinet.windInstrument = {
      ...clarinet.windInstrument!, boreLengthM: 0.6, mouthRadiusM: 0.01, bellRadiusM: 0.04,
    };
    clarinet.tunedPitchHz = 196;
    const cornet = at(wind.nodes, 'brass_bugle_horn');
    cornet.children[0].joints[0].pos = [0.1, 0.2, 0.3];
    load(wind);

    scaleNodeTree('grenadilla_clarinet', 2, 2, 2);
    const c = body('grenadilla_clarinet');
    expect(c.windInstrument!.boreLengthM).toBeCloseTo(1.2, 9);
    expect(c.windInstrument!.mouthRadiusM).toBeCloseTo(0.02, 9);
    expect(c.windInstrument!.bellRadiusM).toBeCloseTo(0.08, 9);
    expect(c.windInstrument!.toneholeJoints![0].diameterMm).toBeCloseTo(21, 9);
    expect(c.tunedPitchHz).toBeUndefined();

    scaleNodeTree('brass_bugle_horn', 2, 3, 4);
    const v = body('cornet_valve_body_1');
    v.joints[0].pos!.forEach((c, i) => expect(c).toBeCloseTo([0.2, 0.6, 1.2][i], 9));
    expect(body('brass_bugle_horn').windInstrument!.valveJoints![0].strokeM).toBeCloseTo(0.013 * 3, 9);
  });

  it('keeps a drumhead\'s tension and shell id when scaled', () => {
    load({ nodes: [box('shell'), box('head', { acousticMembrane: { material: 'mylar', tensionNPerM: 2000, thicknessMm: 0.2, shellNodeId: 'shell' }, tunedPitchHz: 120 })] } as SceneGraph);
    scaleNodeTree('head', 2, 2, 2);
    const h = body('head');
    expect(h.acousticMembrane).toMatchObject({ tensionNPerM: 2000, shellNodeId: 'shell' });
    expect(h.tunedPitchHz).toBeUndefined();
  });
});
