// Cloth on the worker's path (tests/clothSimHarness): a sail tied to four
// posts, two panels sewn edge to edge, and the shade sail preset held in wind.

import { describe, it, expect } from 'vitest';
import { meshCloth } from '../src/utils/cloth/clothMesh';
import type { SceneNode } from '../src/types/scene';
import type { ClothSpec } from '../src/types/cloth';
import { shadeSailPreset } from '../src/presets/clothPresets';
import { clothRun, percentile } from './clothSimHarness';

const square = (s: number) => [
  { id: 'bottom', pts: [[-s / 2, -s / 2], [s / 2, -s / 2]] },
  { id: 'right', pts: [[s / 2, -s / 2], [s / 2, s / 2]] },
  { id: 'top', pts: [[s / 2, s / 2], [-s / 2, s / 2]] },
  { id: 'left', pts: [[-s / 2, s / 2], [-s / 2, -s / 2]] },
] as NonNullable<ClothSpec['pieces']>[number]['edges'];

const at = (x: Float64Array, i: number) => [x[3 * i], x[3 * i + 1], x[3 * i + 2]];

describe('cloth', () => {
  it('meshes a piece with its outline on its edges', () => {
    const m = meshCloth({ pieces: [{ name: 'p', edges: square(1) }], spacing: 0.1 });
    const p = m.pieces.p;
    expect(p.edgeVerts.bottom.length).toBe(11);
    // Closed: each edge ends where the next begins.
    expect(p.edgeVerts.bottom.at(-1)).toBe(p.edgeVerts.right[0]);
    expect(p.edgeVerts.left.at(-1)).toBe(p.edgeVerts.bottom[0]);
    let area = 0;
    for (let t = 0; t < p.tris.length; t += 3) {
      const [a, b, c] = [p.uv[p.tris[t]], p.uv[p.tris[t + 1]], p.uv[p.tris[t + 2]]];
      const cr = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      expect(cr).toBeGreaterThan(0); // every triangle counter-clockwise
      area += cr / 2;
    }
    expect(area).toBeCloseTo(1, 2);
  });

  it('tensions a shade sail onto four posts and reports the corner loads', async () => {
    const L = 3, cut = L * 0.97;
    const posts = [[-L / 2, -L / 2, 2.2], [L / 2, -L / 2, 2.8], [L / 2, L / 2, 2.2], [-L / 2, L / 2, 2.8]];
    const corners = ['bottom', 'right', 'top', 'left'];
    const nodes: SceneNode[] = [
      ...posts.map((p, i) => ({ id: `post${i}`, name: `post${i}`, pos: [p[0], p[1], p[2] / 2], geoms: [{ name: `post${i}_g`, type: 'cylinder', size: [0.04, p[2] / 2] }] } as SceneNode)),
      {
        id: 'sail', name: 'sail', pos: [0, 0, 2.5],
        cloth: {
          pieces: [{ name: 'sheet', edges: square(cut) }],
          material: 'shadeCloth', spacing: 0.15,
          ties: corners.map((edge, i) => ({ piece: 'sheet', edge, at: 0, to: `post${i}`, anchor: [0, 0, posts[i][2] / 2] })),
        },
      } as SceneNode,
    ];
    const calm = await clothRun(nodes);
    calm.run(3);
    // Every corner has reached the top of its post.
    calm.models[0].ties.forEach((t, i) => {
      const p = at(calm.sim.x, t.particle);
      expect(Math.hypot(p[0] - posts[i][0], p[1] - posts[i][1], p[2] - posts[i][2])).toBeLessThan(0.03);
    });
    const loads = calm.sim.tieLoads();
    expect(loads).toHaveLength(4);
    for (const l of loads) expect(l.newtons).toBeGreaterThan(20);
    // Wind loads the sail: a hypar sail is tilted to a horizontal wind, so it
    // takes some of it square on and moves.
    const windy = await clothRun(nodes);
    windy.run(3, { wind: [12, 0, 0] });
    let moved = 0;
    for (let i = 0; i < calm.sim.n; i++) moved = Math.max(moved, Math.hypot(...[0, 1, 2].map((k) => windy.sim.x[3 * i + k] - calm.sim.x[3 * i + k])));
    expect(moved).toBeGreaterThan(0.02);
    const windLoads = windy.sim.tieLoads();
    expect(Math.max(...windLoads.map((l) => l.newtons))).toBeGreaterThan(Math.max(...loads.map((l) => l.newtons)));
    console.log('moved', moved.toFixed(3), 'calm', loads.map((l) => l.newtons.toFixed(0)), 'wind', windLoads.map((l) => l.newtons.toFixed(0)));
  }, 120_000);

  it('sews two panels together, floating while it sews', async () => {
    const w = 0.4;
    const nodes: SceneNode[] = [{
      id: 'bag', name: 'bag', pos: [0, 0, 1],
      cloth: {
        pieces: [
          { name: 'front', edges: square(w), placement: { kind: 'plane', origin: [0, -0.1, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] } },
          { name: 'back', edges: square(w), placement: { kind: 'plane', origin: [0, 0.1, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] } },
        ],
        seams: [
          { a: [{ piece: 'front', edge: 'left' }], b: [{ piece: 'back', edge: 'left' }] },
          { a: [{ piece: 'front', edge: 'right' }], b: [{ piece: 'back', edge: 'right' }] },
        ],
        spacing: 0.05,
        sewTime: 1,
      },
    } as SceneNode];
    const r = await clothRun(nodes);
    r.run(1.05);
    const st = r.models[0].stitches;
    let worst = 0;
    for (let k = 0; k < st.length; k += 2) {
      const a = at(r.sim.x, st[k]), b = at(r.sim.x, st[k + 1]);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    expect(worst).toBeLessThan(0.01);
    // Weightless while sewing: it has not fallen.
    let low = Infinity;
    for (let i = 0; i < r.sim.n; i++) low = Math.min(low, r.sim.x[3 * i + 2]);
    expect(low).toBeGreaterThan(0.75);
  }, 60_000);

  it('hangs a sheet from two corners without stretching it', async () => {
    const nodes: SceneNode[] = [{
      id: 'flag', name: 'flag', pos: [0, 0, 1.5],
      cloth: {
        pieces: [{ name: 'p', edges: square(0.6), placement: { kind: 'plane', origin: [0, 0, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1] } }],
        spacing: 0.04, sewTime: 0,
        ties: [{ piece: 'p', edge: 'top', at: 0 }, { piece: 'p', edge: 'left', at: 0 }],
      },
    } as SceneNode];
    const r = await clothRun(nodes);
    r.run(3);
    expect(r.speedOver(0.5)).toBeLessThan(0.005);
    expect(percentile(r.strains(), 0.95)).toBeLessThan(0.01);
  }, 60_000);

  // Twenty seconds, calm and in a breeze: still when calm; in the breeze it
  // flutters, as a sail does, but nothing grows (MuJoCo's flex sail tore
  // itself apart after ten), and the corners stay loaded but not torn.
  it.each([[0, 0], [6, 2]])('keeps the shade sail steady for 20 s in wind %d,%d', async (wx, wy) => {
    const r = await clothRun(shadeSailPreset.nodes);
    r.run(19.5, { wind: [wx, wy, 0] });
    const speed = r.speedOver(0.5, { wind: [wx, wy, 0] });
    const loads = r.sim.tieLoads().map((l) => l.newtons);
    console.log('sail 20 s wind', wx, wy, 'speed', (speed * 1000).toFixed(1), 'mm/s loads', loads.map((n) => n.toFixed(0)));
    expect(speed).toBeLessThan(wx ? 0.05 : 0.005);
    for (const n of loads) { expect(n).toBeGreaterThan(20); expect(n).toBeLessThan(1000); }
  }, 300_000);
});
