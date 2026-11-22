// A dress form edited by its measurements: a change of a few fields merges
// into the rest, the geoms are marked internal (the tree lists the form, not
// its primitives), and the background compiler rebuilds a form whose
// measurements no longer match the geoms it has.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { compileCsgNodes, resolveBodyFormsForBuild } from '../src/hooks/useCsgCompile';
import { bodyFormNode } from '../src/utils/cloth/clothNodes';
import { applySkinTone, bodyFormKey, mergeBodyForm, needsBodyFormBuild } from '../src/utils/cloth/bodyFormEdit';
import { DEFAULT_MANNEQUIN_RGBA, FIGURE_DEFAULTS, SKIN_TONE_STOPS, bodyLandmarks, clampBodyForm, skinToneLabel, skinToneRgba } from '../src/utils/cloth/bodyForm';
import { formHeightMeasurements, LANDMARK_GAPS, proportions } from '../src/utils/cloth/formProportions';
import { defaultLimbGirths, formLimbs } from '../src/utils/cloth/formLimbs';
import { resolveUpdatedGeoms } from '../src/hooks/mcp/bodyDefaults';
import type { SceneNode } from '../src/types/scene';
import type { BodyFormMeasurements } from '../src/types/cloth';

describe('body form measurements', () => {
  it('merges a change, and restarts from the new figure when the figure changes', () => {
    const male = { ...FIGURE_DEFAULTS.male, waist: 0.9 };
    expect(mergeBodyForm(male, { hip: 1.05 })).toMatchObject({ waist: 0.9, hip: 1.05, chest: male.chest });
    const female = mergeBodyForm(male, { figure: 'female', hip: 1.05 });
    expect(female).toMatchObject({ ...FIGURE_DEFAULTS.female, hip: 1.05 });
    // Clamped to the limits the inspector shows.
    expect(mergeBodyForm(male, { waist: 9 }).waist).toBe(1.6);
  });

  it('keys the geoms by measurements alone, whatever the key order or body name', () => {
    const a = { id: 'f', name: 'f', bodyForm: { ...FIGURE_DEFAULTS.male } } as SceneNode;
    const reordered = Object.fromEntries(Object.entries(FIGURE_DEFAULTS.male).reverse());
    const b = { id: 'f', name: 'f', bodyForm: reordered } as unknown as SceneNode;
    expect(bodyFormKey(a)).toBe(bodyFormKey(b));
    expect(bodyFormKey({ ...a, name: 'g' })).toBe(bodyFormKey(a));
    expect(bodyFormKey({ ...a, bodyForm: { ...FIGURE_DEFAULTS.male, waist: 0.9 } })).not.toBe(bodyFormKey(a));
  });

  it('marks a new form built, and every one of its geoms internal', () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    expect(needsBodyFormBuild(form)).toBe(false);
    expect(form.geoms.length).toBeGreaterThan(10);
    expect(form.geoms.every((g) => g.internal)).toBe(true);
  });
});

describe('a body form edited through the store', () => {
  beforeEach(() => {
    (globalThis as unknown as { window: unknown }).window = globalThis;
    useStore.setState({ sceneGraph: { nodes: [bodyFormNode('form', 'form', { figure: 'male' })] }, model: null, data: null, undoStack: [] });
  });

  it('takes a partial update, and is rebuilt to it', async () => {
    const node = () => useStore.getState().sceneGraph.nodes[0];
    const before = node().geoms.find((g) => g.name === 'form_skin')!;
    useStore.getState().updateNode('form', { bodyForm: { waist: 0.7 } } as Partial<SceneNode>);
    expect(node().bodyForm).toMatchObject({ ...FIGURE_DEFAULTS.male, waist: 0.7 });
    expect(needsBodyFormBuild(node())).toBe(true);
    // The old geoms stay until the new ones land.
    expect(node().geoms.find((g) => g.name === 'form_skin')!.vertices).toEqual(before.vertices);

    await compileCsgNodes(true, { colliders: false });
    expect(needsBodyFormBuild(node())).toBe(false);
    const after = node().geoms.find((g) => g.name === 'form_skin')!;
    expect(after.vertices).not.toEqual(before.vertices);
    expect(after.internal).toBe(true);
    expect(after.dynamic).toBe(true);
  }, 60_000);
});

describe('tailoring measurements', () => {
  const female = (extra: Partial<BodyFormMeasurements> = {}) => clampBodyForm({ figure: 'female', ...extra });
  const ordered = (m: BodyFormMeasurements) => {
    const P = proportions(m), g = LANDMARK_GAPS.map((x) => x * P.s - 1e-9);
    return P.hipZ - P.crotchZ >= g[0] && P.waistZ - P.hipZ >= g[1] && P.bustZ - P.waistZ >= g[2] && P.shoulderZ - P.bustZ >= g[3];
  };

  it('leaves every optional measurement unset on a typical form, at the usual fractions', () => {
    for (const figure of ['male', 'female'] as const) {
      const m = clampBodyForm({ figure });
      expect(Object.keys(m).sort()).toEqual(Object.keys(FIGURE_DEFAULTS[figure]).sort());
      const P = proportions(m);
      expect(P.crotchZ).toBe(0.47 * m.height);
      expect(P.shoulderZ).toBe(0.817 * m.height);
      expect(P.waistZ).toBe((figure === 'female' ? 0.625 : 0.6) * m.height);
    }
  });

  it('puts the crotch at the inseam, and moves the legs and knees with it', () => {
    const base = female(), long = female({ inseam: 0.85 });
    expect(bodyLandmarks(long).crotchZ).toBeCloseTo(0.85, 9);
    expect(bodyLandmarks(long).waistZ).toBe(bodyLandmarks(base).waistZ);
    // The calf, the widest the leg is below the knee, rises with the crotch.
    const calfZ = (m: BodyFormMeasurements) => {
      const leg = formLimbs(m).legL, top = 0.6 * bodyLandmarks(m).crotchZ;
      let z = 0, w = 0;
      for (let i = 0; i <= 600; i++) {
        const s = (leg.length * i) / 600, p = leg.path.at(s);
        if (p[2] > 0.15 && p[2] < top && leg.section(s).w > w) { w = leg.section(s).w; z = p[2]; }
      }
      return z;
    };
    expect(calfZ(long) - calfZ(base)).toBeGreaterThan(0.02);
    expect(ordered(long)).toBe(true);
  });

  it('places the waist by the rise, the hip by waist-to-hip, the shoulders by back length, the bust from the shoulder', () => {
    const m = female({ inseam: 0.8, rise: 0.28, waistToHip: 0.2, backLength: 0.35, shoulderToBust: 0.25 });
    const P = proportions(m), h = formHeightMeasurements(m);
    expect(P.waistZ).toBeCloseTo(1.08, 9);
    expect(P.hipZ).toBeCloseTo(0.88, 9);
    expect(P.shoulderZ + P.shoulderR).toBeCloseTo(1.43, 9);
    expect(P.bustZ).toBeCloseTo(1.18, 9);
    expect(h.outseam).toBeCloseTo(1.08, 9);
  });

  it('keeps the heights in order, storing a set one where it had to go', () => {
    // A long rise and back on a short form: the shoulders would be over the head.
    const m = female({ rise: 0.4, backLength: 0.6, shoulderToBust: 0.4 });
    expect(ordered(m)).toBe(true);
    expect(m.backLength!).toBeLessThan(0.6);
    expect(formHeightMeasurements(m).backLength).toBeCloseTo(m.backLength!, 5);
    // Stored where it went, it resolves to the same form again.
    expect(proportions(clampBodyForm(m))).toEqual(proportions(m));
    // An inseam past what the height allows is held to it.
    expect(female({ inseam: 1.05 }).inseam!).toBeLessThan(0.55 * 1.68);
    for (const extra of [{ inseam: 1.0, rise: 0.4 }, { waistToHip: 0.3, rise: 0.15 }, { height: 0.9, backLength: 0.6 }] as Partial<BodyFormMeasurements>[]) {
      expect(ordered(clampBodyForm({ figure: 'male', ...extra }))).toBe(true);
    }
  });

  it('unsets a measurement given as null', () => {
    const m = mergeBodyForm(female({ inseam: 0.85 }), { inseam: null } as unknown as Partial<BodyFormMeasurements>);
    expect(m.inseam).toBeUndefined();
    expect(proportions(m).crotchZ).toBe(0.47 * m.height);
  });

  it('scales the leg and wrist sections to the girths given', () => {
    const base = female(), d = defaultLimbGirths(base);
    const thick = female({ thigh: d.thigh * 1.2, calf: d.calf * 1.1, wrist: d.wrist * 0.9 });
    const P = proportions(base);
    const widthAt = (m: BodyFormMeasurements, z: number) => {
      const leg = formLimbs(m).legL;
      let best = 0, bestD = Infinity;
      for (let i = 0; i <= 400; i++) { const s = (leg.length * i) / 400, dz = Math.abs(leg.path.at(s)[2] - z); if (dz < bestD) { bestD = dz; best = s; } }
      return leg.section(best).w;
    };
    const thighZ = P.crotchZ - (P.crotchZ - 0.285 * base.height) * 0.45;
    expect(widthAt(thick, thighZ) / widthAt(base, thighZ)).toBeCloseTo(1.2, 1);
    const arm = (m: BodyFormMeasurements) => formLimbs(m).armL.section(m.armLength).w;
    expect(arm(thick) / arm(base)).toBeCloseTo(0.9, 6);
  });
});

describe('a geom marked internal over MCP', () => {
  it('takes internal true and false as a geom patch', () => {
    const form = bodyFormNode('form', 'form', { figure: 'female' });
    const name = form.geoms.find((g) => g.role !== 'collision')!.name;
    const r = resolveUpdatedGeoms(form, [{ name, internal: false }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.geoms.find((g) => g.name === name)!.internal).toBe(false);
  });
});

describe('human-inclusive skinTone spectrum and O(1) zero-rebuild updates', () => {
  it('spans non-linear reddish, brown, golden/olive, and rosy-pink human complexions and defaults to studio plaster', () => {
    expect(skinToneRgba(undefined)).toEqual(DEFAULT_MANNEQUIN_RGBA);
    expect(skinToneLabel(undefined)).toBe('Studio plaster');
    expect(SKIN_TONE_STOPS.length).toBeGreaterThanOrEqual(10);

    // Monotonically increasing luminance from deep ebony (0) to rosy porcelain (1),
    // with genuinely non-collinear RGB chromaticity shifts across undertones.
    const samples = Array.from({ length: 21 }, (_, i) => skinToneRgba(i / 20));
    const lum = ([r, g, b]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(lum(samples[0])).toBeLessThan(0.14);
    expect(lum(samples[samples.length - 1])).toBeGreaterThan(0.82);
    for (let i = 1; i < samples.length; i++) {
      expect(lum(samples[i])).toBeGreaterThan(lum(samples[i - 1]));
    }

    // Verify chromaticity (r/(r+g+b), g/(r+g+b)) is curved/non-linear across reddish mahogany, olive, and rosy pink:
    const chrom = ([r, g, b]: number[]) => {
      const s = r + g + b;
      return [r / s, g / s] as const;
    };
    const cMahogany = chrom(skinToneRgba(0.18));
    const cOlive = chrom(skinToneRgba(0.66));
    const cRosy = chrom(skinToneRgba(0.92));
    // Cross product of chromaticity vectors != 0 proves non-linear undertone curve (not a 2-endpoint lerp).
    const area2 = Math.abs(
      (cOlive[0] - cMahogany[0]) * (cRosy[1] - cMahogany[1]) -
      (cOlive[1] - cMahogany[1]) * (cRosy[0] - cMahogany[0]),
    );
    expect(area2).toBeGreaterThan(1e-3);

    // Preserves skinTone across figure switches and unsets on null.
    const m1 = mergeBodyForm(FIGURE_DEFAULTS.male, { skinTone: 0.35 });
    expect(m1.skinTone).toBeCloseTo(0.35, 4);
    const m2 = mergeBodyForm(m1, { figure: 'female' });
    expect(m2.figure).toBe('female');
    expect(m2.skinTone).toBeCloseTo(0.35, 4);
    expect(mergeBodyForm(m2, { skinTone: null } as unknown as Partial<BodyFormMeasurements>).skinTone).toBeUndefined();
  });

  it('updates skinTone in O(1) sharing mesh buffers without invalidating bodyFormKey or triggering compileCsgNodes', async () => {
    const initial = bodyFormNode('form', 'form', { figure: 'female' });
    expect(initial.geoms.every((g) => g.rgba?.slice(0, 3).every((v, k) => Math.abs(v - DEFAULT_MANNEQUIN_RGBA[k]) < 1e-4))).toBe(true);
    useStore.setState({ sceneGraph: { nodes: [initial] }, model: null, data: null, undoStack: [] });

    const beforeSkin = useStore.getState().sceneGraph.nodes[0].geoms.find((g) => g.name === 'form_skin')!;
    const beforeKey = bodyFormKey(initial);

    // Simulate dragging the Skin Tone slider in BodyFormCard (skipRecompile = true, O(1) applySkinTone).
    for (const tone of [0.18, 0.48, 0.66, 0.92]) {
      const cur = useStore.getState().sceneGraph.nodes[0];
      useStore.getState().updateNode(
        'form',
        { bodyForm: { skinTone: tone }, geoms: applySkinTone(cur.geoms, tone) } as Partial<SceneNode>,
        true,
      );
    }

    const updated = useStore.getState().sceneGraph.nodes[0];
    expect(updated.bodyForm?.skinTone).toBeCloseTo(0.92, 4);
    expect(bodyFormKey(updated)).toBe(beforeKey);
    expect(needsBodyFormBuild(updated)).toBe(false);

    const afterSkin = updated.geoms.find((g) => g.name === 'form_skin')!;
    expect(afterSkin.rgba).toEqual(skinToneRgba(0.92));
    // Vertex and face buffers are shared by reference — zero re-meshing or array copying!
    expect(afterSkin.vertices).toBe(beforeSkin.vertices);
    expect(afterSkin.faces).toBe(beforeSkin.faces);

    // Background compiler must perform 0 rebuilds when only skinTone changed.
    const builtCount = await compileCsgNodes(true, { colliders: false });
    expect(builtCount).toBe(0);

    // Fresh builds also emit skinToneRgba directly.
    const fresh = bodyFormNode('f2', 'f2', { figure: 'male', skinTone: 0.28 });
    expect(fresh.geoms.find((g) => g.name === 'f2_headSkin')!.rgba).toEqual(skinToneRgba(0.28));
  });

  it('resolveBodyFormsForBuild populates lazy preset geoms and re-posed form geoms without mutating store sceneGraph prematurely', async () => {
    const lazyPresetForm: SceneNode = {
      id: 'form',
      name: 'form',
      type: 'body',
      pos: [-0.48, 0, 0],
      bodyForm: clampBodyForm({ figure: 'female', skinTone: 0.48 }),
      geoms: [],
      joints: [],
      children: [],
    };
    const inputGraph = { nodes: [lazyPresetForm] };
    useStore.setState({ sceneGraph: inputGraph });

    const resolved = await resolveBodyFormsForBuild(inputGraph);
    // Live store sceneGraph stays untouched until recompile's atomic applyBuilt frame!
    expect(useStore.getState().sceneGraph.nodes[0].geoms).toEqual([]);
    // Resolved build graph has all 40+ dynamic/internal form geoms with skinTone applied and bodyFormBuilt set!
    const builtForm = resolved.nodes[0];
    expect(builtForm.geoms.length).toBeGreaterThan(20);
    expect(needsBodyFormBuild(builtForm)).toBe(false);
    expect(builtForm.geoms.find((g) => g.name === 'form_skin')!.rgba).toEqual(skinToneRgba(0.48));
    expect(builtForm.geoms.find((g) => g.name === 'form_skin')!.dynamic).toBe(true);

    // Calling again on an up-to-date graph is an O(1) identity return.
    expect(await resolveBodyFormsForBuild(resolved)).toBe(resolved);
  });
});
