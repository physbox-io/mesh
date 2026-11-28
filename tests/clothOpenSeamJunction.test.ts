import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clampBodyForm, bodyLandmarks } from '../src/utils/cloth/bodyForm';
import { garmentShell } from '../src/utils/cloth/garmentShell';
import { clothModel } from '../src/utils/cloth/clothModel';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { openWedges, pieceWedges } from '../src/utils/cloth/openWedges';
import type { GarmentDraft } from '../src/types/cloth';

const form = clampBodyForm({});
const L = bodyLandmarks(form);

/** Four panels round a point, a cut down x = 0 and a closed seam across it, in any panel order. */
function crossShell(order: number[]) {
  // Points: 0 centre, 1 up, 2 right, 3 down, 4 left, 5..8 the corners between.
  const fan = [[0, 1, 5], [0, 5, 2], [0, 2, 6], [0, 6, 3], [0, 3, 7], [0, 7, 4], [0, 4, 8], [0, 8, 1]];
  const quad = [[0, 1], [2, 3], [4, 5], [6, 7]]; // up-right, down-right, down-left, up-left
  return {
    tris: fan.flat(),
    seams: [{ path: [0, 1], open: true }, { path: [0, 3], open: true }, { path: [0, 2] }, { path: [0, 4] }],
    panels: order.map((q) => ({ tris: quad[q] })),
  };
}

describe('an opening crossed by a closed seam', () => {
  it('splits a point shared by four panels by side, in any panel order', () => {
    for (const order of [[0, 1, 2, 3], [1, 3, 0, 2], [3, 2, 1, 0], [2, 0, 3, 1]]) {
      const w = openWedges(crossShell(order));
      const of = w.wedgeOf.get(0)!;
      const quadOf = (k: number) => order[k];
      const right = [0, 1, 2, 3].filter((k) => quadOf(k) <= 1), left = [0, 1, 2, 3].filter((k) => quadOf(k) >= 2);
      expect(of.get(right[0])).toBe(of.get(right[1]));
      expect(of.get(left[0])).toBe(of.get(left[1]));
      expect(of.get(left[0])).not.toBe(of.get(right[0]));
      expect(w.across.get(0)!.length).toBe(1);
    }
  });

  it('keeps an open point whole where the cut ends inside the cloth', () => {
    const s = crossShell([0, 1, 2, 3]);
    s.seams = [{ path: [0, 1], open: true }];
    const w = openWedges({ ...s, panels: [{ tris: [0, 1, 2, 3, 4, 5, 6, 7] }] });
    expect(new Set(w.wedgeOf.get(0)!.values()).size).toBe(1);
    expect(w.across.get(0)!.length).toBe(0);
  });

  it('splits a slit inside one panel by the side each of its points is on', () => {
    const s = crossShell([0, 1, 2, 3]);
    s.seams = [{ path: [1, 0, 3], open: true }];
    const shell = { ...s, panels: [{ tris: [0, 1, 2, 3, 4, 5, 6, 7] }] };
    const w = openWedges(shell);
    // The piece cut from it: point 0 twice (locals 0 and 9), one per side; 1 and 3 likewise.
    const right = [[0, 1, 5], [0, 5, 2], [0, 2, 6], [0, 6, 3]], left = [[9, 13, 7], [9, 7, 4], [9, 4, 8], [9, 8, 10]];
    const points = [0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 3, 0, 3];
    // locals 10 (point 1) and 13 (point 3) are the left side's copies
    points[10] = 1; points[13] = 3;
    const wedge = pieceWedges(w, shell.tris, { points, tris: [...right, ...left].flat() }, 0);
    expect(wedge[0]).not.toBe(wedge[9]);
    expect(new Set(w.wedgeOf.get(0)!.values()).size).toBe(1);
  });

  for (const layout of ['worn', 'pieces'] as const) {
    it(`a yoked jacket stays sewn on each side of its front and open across it (${layout})`, () => {
      const fnode = bodyFormNode('form', 'form', {});
      const draft = { garment: 'jacket', fitTo: 'form', trims: [], length: 0.3, seams: [{ name: 'yoke', point: [0, 0, L.bustZ], normal: [0, 0, 1] }] } as GarmentDraft;
      const g = garmentNode('j', 'j', draft, fnode);
      if (layout === 'pieces') g.cloth = { ...g.cloth!, layout: 'pieces' };
      const shell = garmentShell(g.cloth!.garment!, form);
      const m = clothModel(g, new THREE.Matrix4(), [fnode, g]);
      const fronts = m.groups.filter((gr) => /__front/.test(gr.name));
      expect(fronts.length).toBe(4);
      const sideOf = (gr: (typeof fronts)[number]) => (gr.particles.reduce((a, p) => a + m.x0[3 * p], 0) > 0 ? 'L' : 'R');
      const shellPoints = (nm: string) => {
        const pn = shell.panels.find((p) => `j__${p.name}` === nm)!;
        return new Set(pn.tris.flatMap((t) => [shell.tris[3 * t], shell.tris[3 * t + 1], shell.tris[3 * t + 2]]));
      };
      // Points sewn together, through any chain of stitches (a point four panels share is sewn round them in turn).
      const parent = new Map<number, number>();
      const find = (p: number): number => { let r = p; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
      for (let i = 0; i < m.stitches.length; i += 2) { const ra = find(m.stitches[i]), rb = find(m.stitches[i + 1]); if (ra !== rb) parent.set(ra, rb); }
      const bRoots = new Map(m.groups.map((gr) => [gr.name, new Set(gr.particles.map(find))]));
      for (const side of ['L', 'R']) {
        const [a, b] = fronts.filter((gr) => sideOf(gr) === side);
        const sharedShell = [...shellPoints(a.name)].filter((q) => shellPoints(b.name).has(q)).length;
        expect(sharedShell).toBeGreaterThan(2);
        // Sewn at every point the two share, the front edge's included.
        const joined = layout === 'worn'
          ? a.particles.filter((p) => new Set(b.particles).has(p)).length
          : [...new Set(a.particles.map(find))].filter((r) => bRoots.get(b.name)!.has(r)).length;
        expect(joined).toBe(sharedShell);
      }
      // And nothing joins a left front to a right one.
      const lefts = new Set(fronts.filter((gr) => sideOf(gr) === 'L').map((gr) => gr.name));
      const rights = new Set(fronts.filter((gr) => sideOf(gr) === 'R').map((gr) => gr.name));
      const rightParticles = new Set(fronts.filter((gr) => rights.has(gr.name)).flatMap((gr) => gr.particles));
      for (const gr of fronts) if (lefts.has(gr.name)) for (const p of gr.particles) expect(rightParticles.has(p)).toBe(false);
      const rightRoots = new Set([...rights].flatMap((nm) => [...bRoots.get(nm)!]));
      for (const nm of lefts) for (const r of bRoots.get(nm)!) expect(rightRoots.has(r)).toBe(false);
    }, 240000);
  }
});
