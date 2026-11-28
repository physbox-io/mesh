import { describe, expect, it } from 'vitest';
import { clampBodyForm } from '../src/utils/cloth/bodyForm';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { fullSides, panelEdgeEase } from '../src/utils/cloth/garmentFullness';
import { garmentSettings } from '../src/utils/cloth/garments';
import type { BodyFormMeasurements, GarmentDraft } from '../src/types/cloth';
import { DRAFT_ELBOW } from '../src/utils/cloth/formLimbs';

/** Each panel's flat piece: its name, its area (m2) and outline's length (m), and strain95. */
function pattern(draft: GarmentDraft, pose: Partial<BodyFormMeasurements>) {
  const form = clampBodyForm(pose);
  const shell = garmentShell(draft, form);
  const st = garmentSettings(draft);
  const sides = fullSides(shell, st.fullness, st.material);
  return new Map(shell.panels.map((p, k) => {
    const f = flattenPanel(p.name, shell.cut ?? shell.points, shell.tris, p.tris, shell.seams.map((s) => s.path), 15, p.upAxis, panelEdgeEase(shell, sides, k));
    let area = 0, rim = 0;
    for (let t = 0; t < f.tris.length; t += 3) { const [a, b, c] = [f.uv[f.tris[t]], f.uv[f.tris[t + 1]], f.uv[f.tris[t + 2]]]; area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2; }
    for (let i = 0; i < f.outline.length; i++) { const a = f.uv[f.outline[i]], b = f.uv[f.outline[(i + 1) % f.outline.length]]; rim += Math.hypot(b[0] - a[0], b[1] - a[1]); }
    return [p.name, { area, rim, strain: f.strain95 }];
  }));
}

describe('the pattern is cut on the form as drafted, whatever its pose', () => {
  it('a long sleeve is one piece, the same pattern, at any elbow bend', () => {
    const draft = { garment: 'jacket', trims: [] } as GarmentDraft;
    const straight = pattern(draft, { elbowBend: DRAFT_ELBOW });
    expect([...straight.keys()].filter((n) => n.startsWith('sleeve')).sort()).toEqual(['sleeveL', 'sleeveR']);
    for (const elbowBend of [0, 80, 130]) {
      const bent = pattern(draft, { elbowBend });
      expect([...bent.keys()].sort()).toEqual([...straight.keys()].sort());
      for (const nm of ['sleeveL', 'sleeveR']) {
        const a = straight.get(nm)!, b = bent.get(nm)!;
        // Measured against the pattern at the draft pose itself: area and
        // outline within 1.1% at 0, 80 and 130 degrees (the shell over a
        // sharply bent elbow is modelled a little short in the crook).
        expect(Math.abs(b.area - a.area) / a.area, `${nm} area at ${elbowBend}`).toBeLessThan(0.015);
        expect(Math.abs(b.rim - a.rim) / a.rim, `${nm} outline at ${elbowBend}`).toBeLessThan(0.015);
        expect(b.strain, `${nm} strain at ${elbowBend}`).toBeLessThan(0.05);
      }
    }
  }, 400000);
});
