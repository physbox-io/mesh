// Garments modelled in 3D on a body form (garmentShell), cut into flat
// pieces (garmentFlatten), and draped by the cloth solver: held to what a
// person looks at. The form measures what it was given; the modelled garment
// stands clear of it; the pieces lie flat with little distortion; and draped,
// the garment comes to rest on the form, nothing inside it, its cut lengths
// held.

//
// Each garment modelled, cut and draped on its form (the second half of the cases).

import { describe, it, expect } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { bodyFormSection, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { CLOTH_THICKNESS } from '../src/utils/cloth/xpbd';
import { CLOTH_MATERIALS } from '../src/utils/cloth/clothMesh';
import { GARMENT_DEFAULTS, garmentSettings } from '../src/utils/cloth/garments';
import { fullSides, panelEdgeEase } from '../src/utils/cloth/garmentFullness';
import { clothRun, percentile } from './clothSimHarness';
import { cases, expectedPanels } from './garmentsShared';

describe.each(cases.slice(8))('%s', (_label, garment, measurements, options = {}) => {
  const form = bodyFormNode('form', 'form', measurements);
  const g = garmentNode('g', 'garment', { garment, ...options }, form);

  it('is modelled clear of the body and splits into panels that lie flat', () => {
    const shell = garmentShell(g.cloth!.garment!, form.bodyForm!);
    const L = bodyLandmarks(form.bodyForm!);
    for (const p of shell.points) {
      if (p[2] > L.hpsZ || p[2] < L.hipZ) continue;
      const sec = bodyFormSection(form.bodyForm!, p[2]);
      const th = Math.atan2(p[1] - sec.centreY, p[0]), n = sec.radii.length;
      const f = (((th / (2 * Math.PI)) % 1) + 1) % 1 * n, i = Math.floor(f), t = f - i;
      const r = sec.radii[i % n] * (1 - t) + sec.radii[(i + 1) % n] * t;
      expect(Math.hypot(p[0], p[1] - sec.centreY) - r).toBeGreaterThan(0.002);
    }
    const names = shell.panels.map((p) => p.name).sort();
    const expected = expectedPanels(garment, options);
    if (expected) expect(names).toEqual(expected);
    else { expect(names.length).toBeGreaterThanOrEqual(2); expect(new Set(names).size).toBe(names.length); }
    // Flattened as it is cut: a sleeve cap with its ease (garmentFullness).
    const settings = garmentSettings(g.cloth!.garment!);
    const sides = fullSides(shell, settings.fullness, settings.material);
    for (const [k, p] of shell.panels.entries()) {
      const piece = flattenPanel(p.name, shell.cut ?? shell.points, shell.tris, p.tris, shell.seams.map((s) => s.path), 15, undefined, panelEdgeEase(shell, sides, k));
      // As flat as the fabric needs: a knit goes over a bust by stretching.
      const give = CLOTH_MATERIALS[options.material ?? GARMENT_DEFAULTS[garment].material].give;
      expect(piece.strain95, p.name).toBeLessThan(Math.max(0.05, Math.min(give, 0.08)));
      expect(Math.abs(piece.areaChange), p.name).toBeLessThan(0.01);
    }
  });

  it('drapes, comes to rest on the form, and holds its cut', async () => {
    const r = await clothRun([form, g]);
    r.run(2.5);
    const speed = r.speedOver(0.5);
    const clear = r.clearance();
    const s = r.strains();
    console.log(_label, `${(speed * 1000).toFixed(1)} mm/s, nearest ${(clear * 1000).toFixed(1)} mm, strain p95 ${(percentile(s, 0.95) * 100).toFixed(1)}% p99 ${(percentile(s, 0.99) * 100).toFixed(1)}% max ${(percentile(s, 1) * 100).toFixed(0)}%`);
    expect(speed).toBeLessThan(0.005);
    // Nothing inside the form: the cloth's middle stays at its thickness off it.
    expect(clear).toBeGreaterThan(CLOTH_THICKNESS - 0.001);
    // Holds its cut; a close-fitting knit (a sock, a hat) within what the
    // fabric gives, as it is worn stretched over the body.
    const d = { ...GARMENT_DEFAULTS[garment], ...options };
    const give = (d.ease ?? 0) <= 0.02 ? CLOTH_MATERIALS[d.material].give : 0;
    expect(percentile(s, 0.95)).toBeLessThan(Math.max(0.03, give));
    expect(percentile(s, 0.99)).toBeLessThan(Math.max(0.08, 1.5 * give));
  }, 120_000);
});
