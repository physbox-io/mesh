// node spike/cloth/bench.mjs [spacing] [selfcollide] [edgeEquality]
import load_mujoco from '@mujoco/mujoco';
import { compileShirt } from './shirtScene.mjs';

const spacing = Number(process.argv[2] ?? 0.02);
const selfcollide = process.argv[3] ?? 'none';
const edgeEquality = process.argv[4] === 'true';
const extra = JSON.parse(process.env.OPTS ?? '{}');
const mujoco = await load_mujoco();
const t0 = performance.now();
const s = compileShirt(mujoco, { spacing, selfcollide, edgeEquality, ...extra });
const compileMs = performance.now() - t0;
const { model, data } = s;
const dt = model.opt.timestep;
const sewTime = 1.0, total = 3.0;
const steps = Math.round(total / dt);

// eq_data must be a live view, or sewing does nothing.
const before = model.eq_data[3];
s.setSew(1);
const writable = model.eq_data[3] !== before || before === 0;
s.setSew(0);

const startGap = s.seamGap();
const t1 = performance.now();
let maxContacts = 0;
let i = 0;
for (; i < steps && performance.now() - t1 < 60000; i++) {
  s.setSew(data.time / sewTime);
  mujoco.mj_step(model, data);
  if (data.ncon > maxContacts) maxContacts = data.ncon;
  if (i % Math.round(0.5 / dt) === 0) {
    const g = s.seamGap(true); process.stdout.write(`  t=${data.time.toFixed(2)} gap max/med/min=${(g.max*1000).toFixed(0)}/${(g.median*1000).toFixed(0)}/${(g.min*1000).toFixed(0)}mm ncon=${data.ncon}\n`);
  }
}
const wall = performance.now() - t1;
let minZ = Infinity, nan = false;
for (let b = 0; b < model.nbody; b++) {
  const z = data.xpos[3 * b + 2];
  if (Number.isNaN(z)) nan = true;
  if (z < minZ) minZ = z;
}
const fx = data.flexvert_xpos; let cz0 = Infinity, cz1 = -Infinity;
for (let v = 0; v < model.nflexvert; v++) { const z = fx[3 * v + 2]; cz0 = Math.min(cz0, z); cz1 = Math.max(cz1, z); }
const L = data.flexedge_length, L0 = model.flexedge_length0; let stretch = 0;
for (let e = 0; e < model.nflexedge; e++) stretch = Math.max(stretch, L[e] / L0[e]);
console.log(JSON.stringify({ clothZ: [+cz0.toFixed(3), +cz1.toFixed(3)], maxEdgeStretch: +stretch.toFixed(2) }));
console.log(JSON.stringify({
  spacing, selfcollide, edgeEquality, ...extra, nvert: s.nvert, seams: s.pairs.length, eqWritable: writable,
  compileMs: Math.round(compileMs), simTime: +data.time.toFixed(2), msPerStep: +(wall / i).toFixed(3),
  realtimeFactor: +((data.time * 1000) / wall).toFixed(3),
  startGapMm: Math.round(startGap * 1000), endGapMm: +(s.seamGap() * 1000).toFixed(1),
  maxContacts, minZ: +minZ.toFixed(3), nan,
}));
