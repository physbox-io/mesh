// node bench-tshirt.mjs [spacing]   (OPTS='{"young":1e6}' for overrides)
import load_mujoco from '@mujoco/mujoco';
import { compileTshirt } from './tshirt.mjs';

const spacing = Number(process.argv[2] ?? 0.03);
const extra = JSON.parse(process.env.OPTS ?? '{}');
const mujoco = await load_mujoco();
const t0 = performance.now();
const s = compileTshirt(mujoco, { spacing, ...extra });
const compileMs = performance.now() - t0;
const { model, data, draft } = s;
console.log(JSON.stringify({
  capHeight: +draft.capHeight.toFixed(3), armholeFront: +draft.armFront.toFixed(3), armholeBack: +draft.armBack.toFixed(3),
  neckline: +draft.neckline.toFixed(3), bandLength: +draft.bandLength.toFixed(3),
  pieces: Object.fromEntries(Object.entries(s.meshes).map(([k, m]) => [k, m.pts.length])),
}));
const dt = model.opt.timestep, sewTime = Number(process.env.SEW ?? 1.5), total = Number(process.env.TOTAL ?? 4);
const t1 = performance.now();
let i = 0;
for (; data.time < total && performance.now() - t1 < 120000; i++) {
  s.setSew(data.time / sewTime);
  mujoco.mj_step(model, data);
  if (i % Math.round(0.5 / dt) === 0) {
    const g = s.seamGap(true);
    console.log(`  t=${data.time.toFixed(2)} gap max/med=${(g.max * 1000).toFixed(0)}/${(g.median * 1000).toFixed(0)}mm ncon=${data.ncon}`);
  }
}
const wall = performance.now() - t1;
const fx = data.flexvert_xpos; let z0 = Infinity, z1 = -Infinity, nan = false;
for (let v = 0; v < model.nflexvert; v++) { const z = fx[3 * v + 2]; if (Number.isNaN(z)) nan = true; z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
const L = data.flexedge_length, L0 = model.flexedge_length0; let stretch = 0;
for (let e = 0; e < model.nflexedge; e++) stretch = Math.max(stretch, L[e] / L0[e]);
const g = s.seamGap(true);
console.log(JSON.stringify({
  spacing, ...extra, nvert: s.nvert, seamPairs: s.pairs.length, compileMs: Math.round(compileMs),
  simTime: +data.time.toFixed(2), msPerStep: +(wall / i).toFixed(2), realtime: +((data.time * 1000) / wall).toFixed(3),
  clothZ: [+z0.toFixed(3), +z1.toFixed(3)], maxEdgeStretch: +stretch.toFixed(2), nan,
  seamGapMm: Object.fromEntries(Object.entries(g.bySeam).map(([k, v]) => [k, Math.round(v * 1000)])),
}));
