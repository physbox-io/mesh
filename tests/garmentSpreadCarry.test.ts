import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { garmentShell, type GarmentShell } from '../src/utils/cloth/garmentShell';
import { flattenPanel } from '../src/utils/cloth/garmentFlatten';
import { fullSides, panelEdgeEase } from '../src/utils/cloth/garmentFullness';
import { spreadPanel } from '../src/utils/cloth/garmentSpread';
import { garmentSettings } from '../src/utils/cloth/garments';
import { clothModel } from '../src/utils/cloth/clothModel';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import type { GarmentDraft } from '../src/types/cloth';

const form = clampBodyForm({});
const L = bodyLandmarks(form);

function spreads(draft: GarmentDraft) {
  const shell: GarmentShell = garmentShell(draft, form);
  const st = garmentSettings(draft);
  const sides = fullSides(shell, st.fullness, st.material);
  const seamPaths = shell.seams.map((s) => s.path);
  return { shell, sides, out: shell.panels.map((panel, k) => {
    const flat = flattenPanel(panel.name, shell.cut ?? shell.points, shell.tris, panel.tris, seamPaths, 15, panel.upAxis, panelEdgeEase(shell, sides, k));
    return { k, flat, spread: spreadPanel(shell, k, flat, sides) };
  }) };
}

const inside = (poly: number[][], [x, y]: number[]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

describe('a spread (gathered or pleated) panel keeps its ease and darts', () => {
  it('eases the spread mesh along the eased seam, by its own triangles', () => {
    const draft = { garment: 'tshirt', material: 'woven', sleeve: 0.55, seams: [{ name: 'band', point: [0, 0, L.shoulderZ - 0.12], normal: [0, 0, 1], on: ['sleeve'] }], fullness: [{ along: 'band', kind: 'gather', ratio: 1.6, side: 'above' }] } as GarmentDraft;
    const { shell, sides, out } = spreads(draft);
    const both = out.filter((o) => o.spread && o.flat.edgeEase);
    expect(both.length).toBe(2);
    const n = shell.points.length;
    for (const { k, spread, flat } of both) {
      const sp = spread!;
      expect(sp.edgeEase?.length).toBe(sp.tris.length);
      const eased = sides.find((s) => s.panel === k && s.kind === 'ease')!.edges;
      const onSeam = new Set<number>();
      for (const e of eased) { onSeam.add(Math.floor(e / n)); onSeam.add(e % n); }
      const seamUv = sp.points.flatMap((g, l) => (onSeam.has(g) ? [sp.uv[l]] : []));
      expect(seamUv.length).toBeGreaterThan(10);
      const lens: number[] = [];
      for (let t = 0; t < sp.tris.length; t += 3) for (let j = 0; j < 3; j++) { const a = sp.uv[sp.tris[t + j]], b = sp.uv[sp.tris[t + (j + 1) % 3]]; lens.push(Math.hypot(a[0] - b[0], a[1] - b[1])); }
      const step = lens.sort((a, b) => a - b)[lens.length >> 1];
      // As far from the seam as the flat piece's eased edges are, spread by the gather at most.
      const farthest = (uv: [number, number][] | number[][], tris: number[], pts: number[], ease: number[]) => {
        const at = pts.flatMap((g, l) => (onSeam.has(g) ? [uv[l]] : []));
        let worst = 0, count = 0;
        ease.forEach((e, c) => {
          if (!(e > 0)) return;
          count++;
          const t = c - (c % 3), a = uv[tris[c]], b = uv[tris[t + ((c + 1) % 3)]], m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          worst = Math.max(worst, Math.min(...at.map((q) => Math.hypot(q[0] - m[0], q[1] - m[1]))));
        });
        return { worst, count };
      };
      const f = farthest(flat.uv, flat.tris, flat.points, flat.edgeEase!), s2 = farthest(sp.uv, sp.tris, sp.points, sp.edgeEase!);
      expect(s2.count).toBeGreaterThan(50);
      expect(s2.worst).toBeLessThan(sp.ratio * f.worst + 2 * step);
      // The seam's own edges are eased.
      let seamEdges = 0, seamEased = 0;
      for (let t = 0; t < sp.tris.length; t += 3) for (let j = 0; j < 3; j++) {
        const ga = sp.points[sp.tris[t + j]], gb = sp.points[sp.tris[t + (j + 1) % 3]];
        if (ga < 0 || gb < 0 || !eased.has(ga < gb ? ga * n + gb : gb * n + ga)) continue;
        seamEdges++;
        if (sp.edgeEase![t + j] > 0) seamEased++;
      }
      expect(seamEdges).toBeGreaterThan(5);
      expect(seamEased / seamEdges).toBeGreaterThan(0.9);
    }
  }, 400000);

  it('keeps a double-ended dart open in the spread mesh, at its own points', () => {
    const back = { name: 'backWaist', apex: { z: 'waist' as const, x: 0.075, back: true }, direction: [0, 0, 1], length: 0.15, back: 0.12, mirror: true };
    const draft = { garment: 'dress', darts: [back], fullness: [{ along: 'side', kind: 'gather', ratio: 1.3, panels: ['back'] }] } as GarmentDraft;
    const { out } = spreads(draft);
    const o = out.find((q) => q.spread && q.flat.darts?.length)!;
    expect(o).toBeDefined();
    const sp = o.spread!;
    expect(sp.darts?.length).toBe(o.flat.darts!.length);
    o.flat.darts!.forEach((loop, i) => {
      expect(new Set(sp.darts![i].map((l) => sp.points[l]))).toEqual(new Set(loop.map((l) => o.flat.points[l])));
      const poly = sp.darts![i].map((l) => sp.uv[l]);
      for (let t = 0; t < sp.tris.length; t += 3) {
        const c = [0, 1].map((q) => (sp.uv[sp.tris[t]][q] + sp.uv[sp.tris[t + 1]][q] + sp.uv[sp.tris[t + 2]][q]) / 3);
        expect(inside(poly, c)).toBe(false);
      }
    });
    // And in the model's pattern, the dart is drawn at those points.
    const fnode = bodyFormNode('form', 'form', {});
    const g = garmentNode('g', 'dress', draft, fnode);
    const m = clothModel(g, new THREE.Matrix4(), [fnode, g]);
    const grp = m.groups.find((gr) => gr.name === 'dress__back')!;
    expect(grp.flat!.darts?.length).toBe(sp.darts!.length);
    for (const loop of grp.flat!.darts!) for (const l of loop) expect(l).toBeLessThan(grp.flat!.uv.length);
  }, 400000);
});
