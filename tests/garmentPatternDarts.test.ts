import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { bodyFormNode, garmentNode } from '../src/utils/cloth/clothNodes';
import { clothModel } from '../src/utils/cloth/clothModel';
import { layoutPattern, patternSvg, type PatternPiece } from '../src/utils/cloth/patternSvg';
import { outlineDarts } from '../src/utils/cloth/patternEdges';
import { FEMALE } from './garmentsShared';

const form = bodyFormNode('form', 'form', FEMALE);
const back = { name: 'backWaist', apex: { z: 'waist' as const, x: 0.075, back: true }, direction: [0, 0, 1], length: 0.15, back: 0.12, mirror: true };
const dress = garmentNode('g', 'dress', { garment: 'dress', darts: [back] }, form);
const model = clothModel(dress, new THREE.Matrix4(), [form, dress]);
const pieces: PatternPiece[] = model.groups.filter((g) => g.flat).map((g) => ({ name: g.name.split('__')[1], ...g.flat! }));

/** The vertices of an SVG path, mm. */
const vertices = (d: string) => [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));

describe('darts are marked on the pattern, never cut', () => {
  it('every piece knows its edges, and a fitted dress has wedge darts cut in from an edge', () => {
    for (const p of pieces) {
      expect(p.edges?.length, p.name).toBe(p.outline.length);
      expect(p.ids?.length, p.name).toBe(p.uv.length);
    }
    const wedges = pieces.flatMap((p) => outlineDarts(p.ids!, p.outline, p.edges));
    expect(wedges.length).toBeGreaterThan(0);
  });

  for (const sa of [0, 10]) {
    it(`with a ${sa} mm allowance: one cutting line per piece, darts on the stitching line with their points marked`, () => {
      const L = layoutPattern(pieces, { seamAllowanceMm: sa });
      const svg = patternSvg(pieces, 'dress', { seamAllowanceMm: sa });
      for (const l of svg.split('\n').filter((x) => x.includes('data-operation="cut"'))) {
        expect((l.match(/ Z/g) ?? []).length).toBe(1);
      }
      const fishEyes = pieces.reduce((n, p) => n + (p.darts?.length ?? 0), 0);
      expect(fishEyes).toBeGreaterThanOrEqual(2);
      expect(svg.split('\n').filter((l) => l.includes('dart: fold and stitch')).length).toBe(fishEyes);
      for (const lp of L.pieces) {
        const p = pieces.find((q) => q.name === lp.name)!;
        const wedges = outlineDarts(p.ids!, p.outline, p.edges);
        expect(lp.darts.length, lp.name).toBe(wedges.length + (p.darts?.length ?? 0));
        if (!wedges.length) continue;
        // A wedge's apex lies on the stitching line, inside the cutting line: the cut is bridged across the dart's mouth.
        const sew = vertices(lp.sewPath!), cut = vertices(lp.path);
        const ys = cut.map((q) => q.y), xs = cut.map((q) => q.x);
        for (const w of wedges) {
          const apex = sew[w.apex];
          const near = Math.min(...cut.map((q) => Math.hypot(q.x - apex.x, q.y - apex.y)));
          expect(near, `${lp.name} apex`).toBeGreaterThan(sa + 5);
          expect(apex.x).toBeGreaterThan(Math.min(...xs));
          expect(apex.y).toBeGreaterThan(Math.min(...ys));
        }
      }
      // Dart points marked through: a cross each.
      expect((svg.match(/dart point: mark through/g) ?? []).length).toBe(L.pieces.reduce((n, p) => n + p.darts.reduce((k, d) => k + d.points.length, 0), 0));
    });
  }
});
