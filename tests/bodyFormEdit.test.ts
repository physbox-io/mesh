// A dress form edited by its measurements: a change of a few fields merges
// into the rest, the geoms are marked internal (the tree lists the form, not
// its primitives), and the background compiler rebuilds a form whose
// measurements no longer match the geoms it has.

import { describe, it, expect, beforeEach } from 'vitest';
import { useStore } from '../src/store/useStore';
import { compileCsgNodes } from '../src/hooks/useCsgCompile';
import { bodyFormNode } from '../src/utils/cloth/clothNodes';
import { bodyFormKey, mergeBodyForm, needsBodyFormBuild } from '../src/utils/cloth/bodyFormEdit';
import { FIGURE_DEFAULTS, bodyLandmarks, clampBodyForm } from '../src/utils/cloth/bodyForm';
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

  it('keys the geoms by measurements and name, whatever the key order', () => {
    const a = { id: 'f', name: 'f', bodyForm: { ...FIGURE_DEFAULTS.male } } as SceneNode;
    const reordered = Object.fromEntries(Object.entries(FIGURE_DEFAULTS.male).reverse());
    const b = { id: 'f', name: 'f', bodyForm: reordered } as unknown as SceneNode;
    expect(bodyFormKey(a)).toBe(bodyFormKey(b));
    expect(bodyFormKey({ ...a, name: 'g' })).not.toBe(bodyFormKey(a));
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
