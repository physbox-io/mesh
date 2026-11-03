// Cloth through the real compiler and real MuJoCo: a sail tied to four posts,
// and two panels sewn edge to edge. Stepped the way the worker steps it.

import { describe, it, expect, beforeAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { compileToMJCF } from '../src/utils/mjcf';
import { applyCloth, applyClothStart, clothTieLoads, initClothRuntime } from '../src/utils/cloth/clothStep';
import { meshCloth } from '../src/utils/cloth/clothMesh';
import { contactBody } from '../src/utils/contactBodies';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import type { ClothSpec } from '../src/types/cloth';
import { shadeSailPreset } from '../src/presets/clothPresets';

/* eslint-disable @typescript-eslint/no-explicit-any */
let mj: any;
beforeAll(async () => { mj = await load_mujoco(); }, 60_000);

const square = (s: number) => [
  { id: 'bottom', pts: [[-s / 2, -s / 2], [s / 2, -s / 2]] },
  { id: 'right', pts: [[s / 2, -s / 2], [s / 2, s / 2]] },
  { id: 'top', pts: [[s / 2, s / 2], [-s / 2, s / 2]] },
  { id: 'left', pts: [[-s / 2, s / 2], [-s / 2, -s / 2]] },
] as ClothSpec['pieces'][number]['edges'];

function run(scene: SceneGraph, seconds: number, wind: [number, number, number] = [0, 0, 0]) {
  const xml = compileToMJCF(scene);
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  mj.mj_forward(model, data);
  const rt = initClothRuntime(mj, model)!;
  expect(rt).not.toBeNull();
  applyClothStart(rt, mj, model, data);
  const t0 = performance.now();
  while (data.time < seconds) {
    data.xfrc_applied.fill(0);
    applyCloth(rt, model, data, wind, 1.225);
    mj.mj_step(model, data);
  }
  return { xml, model, data, rt, msPerStep: (performance.now() - t0) / (seconds / model.opt.timestep) };
}

const bodyPos = (m: any, d: any, name: string) => {
  const b = mj.mj_name2id(m, 1, name);
  return [d.xpos[3 * b], d.xpos[3 * b + 1], d.xpos[3 * b + 2]];
};

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

  it('tensions a shade sail onto four posts and reports the corner loads', () => {
    const L = 3, cut = L * 0.97;
    const posts = [[-L / 2, -L / 2, 2.2], [L / 2, -L / 2, 2.8], [L / 2, L / 2, 2.2], [-L / 2, L / 2, 2.8]];
    const corners: [string, number][] = [['bottom', 0], ['right', 0], ['top', 0], ['left', 0]];
    const nodes: SceneNode[] = [
      ...posts.map((p, i) => ({ id: `post${i}`, name: `post${i}`, pos: [p[0], p[1], p[2] / 2], geoms: [{ name: `post${i}_g`, type: 'cylinder', size: [0.04, p[2] / 2] }] } as SceneNode)),
      {
        id: 'sail', name: 'sail', pos: [0, 0, 2.5],
        cloth: {
          pieces: [{ name: 'sheet', edges: square(cut) }],
          material: 'shadeCloth', spacing: 0.15,
          ties: corners.map(([edge, at], i) => ({ piece: 'sheet', edge, at, to: `post${i}`, anchor: [0, 0, posts[i][2] / 2] })),
        },
      } as SceneNode,
    ];
    const { xml, model, data, rt, msPerStep } = run({ nodes } as SceneGraph, 3);
    expect(xml).toContain('integrator="discrete"');
    // Every corner has reached the top of its post.
    for (let i = 0; i < 4; i++) {
      const v = mj.mj_name2id(model, 1, `sail__sheet_${meshCloth(nodes[4].cloth!).ties[i].verts[0]}`);
      const top = [posts[i][0], posts[i][1], posts[i][2]];
      const gap = Math.hypot(...[0, 1, 2].map((k) => data.xpos[3 * v + k] - top[k]));
      expect(gap).toBeLessThan(0.03);
    }
    const loads = clothTieLoads(rt, data);
    expect(loads).toHaveLength(4);
    for (const l of loads) expect(l.newtons).toBeGreaterThan(20);
    // Wind loads the sail: a hypar sail is tilted to a horizontal wind, so
    // it takes some of it square on and moves.
    const calm = Array.from(data.flexvert_xpos as Float64Array);
    const windy = run({ nodes } as SceneGraph, 3, [12, 0, 0]);
    let moved = 0;
    for (let v = 0; v < calm.length / 3; v++) {
      moved = Math.max(moved, Math.hypot(...[0, 1, 2].map((k) => windy.data.flexvert_xpos[3 * v + k] - calm[3 * v + k])));
    }
    expect(moved).toBeGreaterThan(0.02);
    const windLoads = clothTieLoads(windy.rt, windy.data);
    expect(Math.max(...windLoads.map((l) => l.newtons))).toBeGreaterThan(Math.max(...loads.map((l) => l.newtons)));
    console.log('moved', moved.toFixed(3), 'sail ms/step', msPerStep.toFixed(2), 'calm', loads.map((l) => l.newtons.toFixed(0)), 'wind', windLoads.map((l) => l.newtons.toFixed(0)));
  });

  it('sews two panels together, floating while it sews', () => {
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
    const { model, data } = run({ nodes } as SceneGraph, 1);
    const m = meshCloth(nodes[0].cloth!);
    let worst = 0;
    for (const s of m.stitches) {
      const a = bodyPos(model, data, `bag__${s.a[0]}_${s.a[1]}`), b = bodyPos(model, data, `bag__${s.b[0]}_${s.b[1]}`);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    }
    expect(worst).toBeLessThan(0.02);
    // Weightless while sewing: it has not fallen.
    const z = Array.from({ length: model.nflexvert }, (_, v) => data.flexvert_xpos[3 * v + 2]);
    expect(Math.min(...z)).toBeGreaterThan(0.75);
  });

  it('names the body on the cloth side of a contact, which has no geom', () => {
    const nodes = [{ id: 'mat', name: 'mat', pos: [0, 0, 0.02], cloth: { pieces: [{ name: 'p', edges: square(0.3) }], spacing: 0.1, sewTime: 0 } } as SceneNode];
    const { model, data } = run({ nodes } as SceneGraph, 0.5);
    const vec = data.contact;
    try {
      expect(vec.size()).toBeGreaterThan(0);
      const c = vec.get(0);
      const sides = [contactBody(model, c, 0), contactBody(model, c, 1)];
      c.delete();
      const names = sides.map((b) => mj.mj_id2name(model, 1, b));
      expect(names).toContain('world'); // the floor
      expect(names.some((n: string) => /^mat__p_\d+$/.test(n))).toBe(true);
    } finally {
      vec.delete();
    }
  });

  // Twenty seconds, calm and in a breeze: at a 4 ms step and lighter damping
  // the preset sail was steady for ten and then tore itself apart.
  it.each([[0, 0], [6, 2]])('keeps the shade sail steady for 20 s in wind %d,%d', (wx, wy) => {
    const { model, data, rt } = run(shadeSailPreset, 19.5, [wx, wy, 0]);
    const before = Float64Array.from(data.flexvert_xpos);
    while (data.time < 20) { data.xfrc_applied.fill(0); applyCloth(rt, model, data, [wx, wy, 0], 1.225); mj.mj_step(model, data); }
    let moved = 0;
    for (let i = 0; i < before.length; i += 3) moved += Math.hypot(data.flexvert_xpos[i] - before[i], data.flexvert_xpos[i + 1] - before[i + 1], data.flexvert_xpos[i + 2] - before[i + 2]);
    const speed = moved / (before.length / 3) / 0.5;
    const loads = clothTieLoads(rt, data).map((l) => l.newtons);
    console.log('sail 20 s wind', wx, wy, 'speed', (speed * 1000).toFixed(1), 'mm/s loads', loads.map((n) => n.toFixed(0)));
    expect(speed).toBeLessThan(0.01);
    for (const n of loads) { expect(n).toBeGreaterThan(30); expect(n).toBeLessThan(1000); }
  }, 300_000);
});
