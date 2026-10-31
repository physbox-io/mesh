import { describe, it, expect, beforeAll, vi } from 'vitest';

// The bridge module sizes its OpenSCAD pool from navigator at import.
vi.hoisted(() => { (globalThis as { navigator?: unknown }).navigator ??= { hardwareConcurrency: 2 }; });

import type { ManifoldToplevel } from 'manifold-3d';
import { loadManifold } from '../src/utils/sculptCut';
import { cutAlongPlane, splitForPrint } from '../src/utils/printSplit';
import { partSoups } from '../src/utils/partSoups';
import { useStore } from '../src/store/useStore';
import { canvasFromLayer, subdivideMeshForPaint } from '../src/utils/vertexPaint';
import type { SceneNode } from '../src/types';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); }, 30_000);

const node = (id: string) => {
  const walk = (list: SceneNode[]): SceneNode | undefined => {
    for (const n of list) { if (n.id === id) return n; const f = walk(n.children || []); if (f) return f; }
    return undefined;
  };
  return walk(useStore.getState().sceneGraph.nodes);
};

/** Each painted vertex of a piece's paint surface, with its colour as bytes. */
function paintedPoints(id: string): { p: number[]; rgb: number[] }[] {
  const g = node(id)!.geoms[0];
  if (!g.paint) return [];
  const sub = subdivideMeshForPaint(g.renderVertices!, g.faces!, g.paint.res);
  const canvas = canvasFromLayer(g.paint, sub.positions.length / 3, g.paint.res);
  const out: { p: number[]; rgb: number[] }[] = [];
  for (let v = 0; v < canvas.count; v++) {
    if (canvas.data[v * 4 + 3] < 0.5) continue;
    out.push({ p: Array.from(sub.positions.slice(v * 3, v * 3 + 3)), rgb: [0, 1, 2].map((k) => Math.round(canvas.data[v * 4 + k] * 255)) });
  }
  return out;
}

const RED = [0.8, 0.1, 0.1, 1];
const BLUE = [0.1, 0.2, 0.9, 1];

/** A red 60 × 20 × 10 mm slab with a blue 60 × 20 × 2 mm strip on top. */
function twoColourPart(): SceneNode {
  return {
    id: 'slab', name: 'slab', pos: [0, 0, 0.05], quat: [1, 0, 0, 0], joints: [], children: [],
    geoms: [
      { name: 'body', type: 'box', size: [0.03, 0.01, 0.005], rgba: RED },
      { name: 'stripe', type: 'box', pos: [0, 0, 0.006], size: [0.03, 0.01, 0.001], rgba: BLUE },
    ],
  } as never;
}

describe('cut pieces keep the colours the part was drawn in', () => {
  it('a knife cut lays a second geom\'s colour on as paint, and leaves the cut face bare', () => {
    useStore.setState({ recompile: async () => {} } as never);
    useStore.getState().updateScene({ nodes: [twoColourPart()] } as never);
    const { soups, absorbed } = partSoups(node('slab')!);
    const cut = cutAlongPlane(wasm, soups, [0, 0, 0], [1, 0, 0]);
    if (!cut.ok) throw new Error(cut.error);
    const ids = useStore.getState().splitBodyForPrint('slab', cut.sections, absorbed, { plain: true });
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(node(id)!.geoms[0].rgba).toEqual(RED);
      const painted = paintedPoints(id);
      expect(painted.length).toBeGreaterThan(0);
      // Blue, and only on the strip: at or above its underside.
      for (const { p, rgb } of painted) {
        [26, 51, 230].forEach((c, k) => expect(Math.abs(rgb[k] - c)).toBeLessThanOrEqual(1));
        expect(p[2]).toBeGreaterThan(0.005 - 1e-4);
        // On the cut face only where a surface of the part meets it: its edge,
        // and the line where the strip sits on the slab.
        if (Math.abs(p[0]) < 1e-4) {
          expect(Math.abs(p[2] - 0.007) < 1e-4 || Math.abs(p[2] - 0.005) < 1e-4 || Math.abs(Math.abs(p[1]) - 0.01) < 1e-4).toBe(true);
        }
      }
    }
  });

  it('Split for Print keeps the part\'s colour rather than a colour per section', () => {
    useStore.setState({ recompile: async () => {} } as never);
    useStore.getState().updateScene({ nodes: [twoColourPart()] } as never);
    const { soups, absorbed } = partSoups(node('slab')!);
    const split = splitForPrint(wasm, soups, { bed: { widthMm: 45, depthMm: 45, heightMm: 45 }, marginMm: 0, joinery: { kind: 'none' } });
    if (!split.ok) throw new Error(split.error);
    expect(split.sections.length).toBeGreaterThan(1);
    const ids = useStore.getState().splitBodyForPrint('slab', split.sections, absorbed);
    for (const id of ids) {
      expect(node(id)!.geoms[0].rgba).toEqual(RED);
      expect(paintedPoints(id).length).toBeGreaterThan(0);
    }
  });

  it('a part in one plain colour gets no paint', () => {
    useStore.setState({ recompile: async () => {} } as never);
    const part = twoColourPart();
    part.geoms[1].rgba = RED;
    useStore.getState().updateScene({ nodes: [part] } as never);
    const { soups, absorbed } = partSoups(node('slab')!);
    const cut = cutAlongPlane(wasm, soups, [0, 0, 0], [1, 0, 0]);
    if (!cut.ok) throw new Error(cut.error);
    const ids = useStore.getState().splitBodyForPrint('slab', cut.sections, absorbed, { plain: true });
    for (const id of ids) expect(node(id)!.geoms[0].paint).toBeUndefined();
  });
});
