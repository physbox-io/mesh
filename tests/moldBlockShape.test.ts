// A mold block that follows the part (blockShape 'fit') rather than a box:
// an agent hand-edited a 3MF to get one, since round a 40 mm part the box's
// corners were about half the print.

import { describe, it, expect, beforeAll } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { generateMoldMeshes, moldSummary, DEFAULT_MOLD_OPTIONS, exportBinarySTL, type MoldOptions, type Triangle3D } from '../src/utils/moldExporter';
import { moldOutlines } from '../src/utils/moldOutline';
import { moldOptionsFor } from '../src/utils/moldWorkerClient';
import { loadManifold } from '../src/utils/sculptCut';
import { stlToMesh } from '../src/utils/stlMesh';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

const ball: SceneGraph = {
  nodes: [{ id: 'b', name: 'ball', type: 'body', pos: [0, 0, 0.02], joints: [], children: [], geoms: [{ name: 'g', type: 'sphere', size: [0.02] } as SceneGeom] }],
};
const CLAM: Partial<MoldOptions> = { ...DEFAULT_MOLD_OPTIONS, moldType: 'clamshell', pullDirection: '+z' };

const volume = (tris: Triangle3D[]) => tris.reduce((v, { a, b, c }) =>
  v + (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6, 0);
const closed = (tris: Triangle3D[]) => {
  const m = stlToMesh(exportBinarySTL(tris));
  return analyzeMesh(m.positions, m.faces)!.closed;
};

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

describe('a block that follows the part', () => {
  it('takes far less filament round a ball, each half still closed', () => {
    const box = generateMoldMeshes(ball, CLAM, wasm);
    const fit = generateMoldMeshes(ball, { ...CLAM, blockShape: 'fit' }, wasm);
    expect(fit.success).toBe(true);
    const vBox = volume(box.bottomHalf.triangles) + volume(box.topHalf!.triangles);
    const vFit = volume(fit.bottomHalf.triangles) + volume(fit.topHalf!.triangles);
    expect(vFit).toBeLessThan(vBox * 0.8);
    expect(closed(fit.bottomHalf.triangles)).toBe(true);
    expect(closed(fit.topHalf!.triangles)).toBe(true);
  });

  it('puts the pins in the wall, clear of the cavity and the outside, keyed one way', () => {
    const f = moldSummary(generateMoldMeshes(ball, { ...CLAM, blockShape: 'fit' }, wasm)).features!;
    expect(f.pins).toHaveLength(4);
    for (const p of f.sockets) {
      const r = Math.hypot(p.atMm[0], p.atMm[1]);
      expect(r - p.diaMm / 2).toBeGreaterThan(20);        // clear of the 20 mm cavity
      expect(r + p.diaMm / 2).toBeLessThan(20 + 10);      // inside the 10 mm wall
    }
    // Keyed: the four are not symmetric under a half turn.
    const pts = f.sockets.map((p) => p.atMm);
    const turned = pts.map(([x, y]) => [-x, -y]);
    const matches = turned.every(([x, y]) => pts.some(([u, v]) => Math.hypot(u - x, v - y) < 1));
    expect(matches).toBe(false);
    expect(f.pryNotches).toHaveLength(2);
  });

  it('works for the open and the lined molds too', () => {
    const open = generateMoldMeshes(ball, { ...CLAM, moldType: 'open', blockShape: 'fit' }, wasm);
    expect(open.success).toBe(true);
    const lined = generateMoldMeshes(ball, { ...CLAM, blockShape: 'fit', dissolvableLiner: true, castMaterial: 'epoxy' }, wasm);
    expect(lined.success).toBe(true);
    expect(closed(lined.bottomHalf.liner!.shell)).toBe(true);
  });

  it('keeps the core of a ring solid: the outline has its holes filled', () => {
    // A 60 mm square frame, 10 mm wide, as four bars (mm, sampling frame).
    const bar = (x0: number, y0: number, x1: number, y1: number) => {
      const out: number[] = [];
      const v = [[x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0], [x0, y0, 5], [x1, y0, 5], [x1, y1, 5], [x0, y1, 5]];
      const f = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
      for (const i of f) out.push(...v[i]);
      return out;
    };
    const tris = new Float64Array([...bar(-30, -30, 30, -20), ...bar(-30, 20, 30, 30), ...bar(-30, -20, -20, 20), ...bar(20, -20, 30, 20)]);
    const o = moldOutlines(wasm, tris, undefined, { wallMm: 5, pinRingMm: 2.5, baseMirrored: false })!;
    expect(o).not.toBeNull();
    expect(o.base).toHaveLength(1);
  });

  it('is taken over MCP as block_shape, and refused when unknown', () => {
    expect(moldOptionsFor({ blockShape: 'fit' }).options.blockShape).toBe('fit');
    expect(moldOptionsFor({ blockShape: 'round' }).error).toMatch(/block_shape/);
  });

  it('spaces all four registration pins >= 2.5 * socketRimR apart on a concave L-shape while keeping 180° keying', () => {
    // 60 x 60 mm concave L-shape (missing +X/+Y quadrant):
    const lShape: SceneGraph = {
      nodes: [{
        id: 'l', name: 'l_shape', type: 'body', pos: [0, 0, 0],
        geoms: [
          { name: 'armX', type: 'box', size: [0.03, 0.008, 0.006], pos: [0, -0.022, 0.006] } as SceneGeom,
          { name: 'armY', type: 'box', size: [0.008, 0.03, 0.006], pos: [-0.022, 0, 0.006] } as SceneGeom,
        ],
        joints: [], children: [],
      }],
    };
    const res = generateMoldMeshes(lShape, { ...CLAM, blockShape: 'fit', wallMarginMm: 12 }, wasm);
    expect(res.success, res.error).toBe(true);
    const sockets = res.features!.sockets;
    expect(sockets).toHaveLength(4);
    const socketRimR = sockets[0].diaMm / 2;
    for (let i = 0; i < sockets.length; i++) {
      for (let j = i + 1; j < sockets.length; j++) {
        const d = Math.hypot(sockets[i].atMm[0] - sockets[j].atMm[0], sockets[i].atMm[1] - sockets[j].atMm[1]);
        expect(d).toBeGreaterThanOrEqual(2.5 * socketRimR);
      }
    }
    const pts = sockets.map((s) => s.atMm);
    const matches180 = pts.every(([x, y]) => pts.some(([u, v]) => Math.hypot(-x - u, -y - v) < 1));
    expect(matches180).toBe(false);
    expect(closed(res.bottomHalf.triangles)).toBe(true);
    expect(closed(res.topHalf!.triangles)).toBe(true);
  });

  it('places pry notches on ±Y short ends instead of under ±X clamping rails on separable fit clamshells', () => {
    // 30 x 48 mm capsule/oval deeper in Y than X: sliding-clip rails sit on ±X long edges.
    const deepOval: SceneGraph = {
      nodes: [{
        id: 'o', name: 'oval', type: 'body', pos: [0, 0, 0.012],
        geoms: [
          { name: 'c1', type: 'cylinder', size: [0.015, 0.008], pos: [0, -0.009, 0] } as SceneGeom,
          { name: 'c2', type: 'cylinder', size: [0.015, 0.008], pos: [0, 0.009, 0] } as SceneGeom,
          { name: 'mid', type: 'box', size: [0.015, 0.009, 0.008], pos: [0, 0, 0] } as SceneGeom,
        ],
        joints: [], children: [],
      }],
    };
    const res = generateMoldMeshes(deepOval, {
      ...CLAM,
      blockShape: 'fit',
      separable: true,
      includePryNotches: true,
    }, wasm);
    expect(res.success, res.error).toBe(true);
    expect(res.clips).toHaveLength(2);
    const notches = res.features!.pryNotches;
    expect(notches).toHaveLength(2);
    // Notches must sit near the ±Y ends (|y| > 25 mm), clear of the mid-side clamping rails near y = 0.
    for (const n of notches) {
      expect(Math.abs(n.atMm[1])).toBeGreaterThan(25);
    }
  });
});
