// A body's reported velocity is its origin's, not its tree's COM's. See
// src/workers/bodyKinematics.ts. Repro: a cart on four hinged wheels (r 30 mm)
// launched at 0.5 m/s reported every wheel at [0.539, 0, 0.872].

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import { bodyAngularVelocity, bodyPointVelocity, worldToBodyFrame, type VelocityViews } from '../src/workers/bodyKinematics';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
let model: InstanceType<Mujoco['MjModel']>;
let data: InstanceType<Mujoco['MjData']>;

const wheel = (n: string, x: number, y: number) =>
  `<body name="${n}" pos="${x} ${y} -0.01"><joint name="${n}_h" type="hinge" axis="0 1 0"/>` +
  `<geom type="cylinder" size="0.03 0.005" euler="90 0 0" mass="0.05"/></body>`;
const XML = `<mujoco>
  <option timestep="0.001"/>
  <worldbody>
    <geom name="floor" type="plane" size="5 5 0.1"/>
    <body name="cart" pos="0 0 0.041"><freejoint name="cart_free"/>
      <geom type="box" size="0.08 0.04 0.01" mass="0.5"/>
      ${wheel('w1', 0.06, 0.05)}${wheel('w2', 0.06, -0.05)}${wheel('w3', -0.06, 0.05)}${wheel('w4', -0.06, -0.05)}
    </body>
  </worldbody>
</mujoco>`;

const views = (): VelocityViews => ({ cvel: data.cvel, xpos: data.xpos, subtreeCom: data.subtree_com, rootId: model.body_rootid });
const id = (n: string) => mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, n);

/** mj_objectVelocity at the body origin, world frame: [ω; v]. */
const reference = (b: number) => {
  const out = new Float64Array(6);
  const buf = new mj.DoubleBuffer(6);
  try {
    mj.mj_objectVelocity(model, data, mj.mjtObj.mjOBJ_BODY.value, b, buf, 0);
    out.set(buf.GetView());
  } finally { buf.delete(); }
  return out;
};

beforeAll(async () => {
  mj = await load_mujoco();
  model = mj.MjModel.from_xml_string(XML);
  data = new mj.MjData(model);
  mj.mj_forward(model, data);
  // Launch at 0.5 m/s, wheels rolling at v/r, and let it run.
  data.qvel[0] = 0.5;
  for (const n of ['w1', 'w2', 'w3', 'w4']) data.qvel[model.jnt_dofadr[mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, `${n}_h`)]] = 0.5 / 0.03;
  for (let i = 0; i < 300; i++) mj.mj_step(model, data);
  mj.mj_forward(model, data);
});

afterAll(() => { data.delete(); model.delete(); });

describe('body velocity', () => {
  it("is the body origin's, as mj_objectVelocity gives it", () => {
    for (const n of ['cart', 'w1', 'w2', 'w3', 'w4']) {
      const b = id(n);
      const ref = reference(b);
      const v = bodyPointVelocity(views(), b);
      const w = bodyAngularVelocity(views(), b);
      for (let k = 0; k < 3; k++) {
        expect(v[k]).toBeCloseTo(ref[3 + k], 9);
        expect(w[k]).toBeCloseTo(ref[k], 9);
      }
    }
  });

  it('gives a wheel hub the speed the cart rolls at, not the raw cvel', () => {
    const b = id('w1');
    const cartV = bodyPointVelocity(views(), id('cart'));
    const hub = bodyPointVelocity(views(), b);
    // The hub rides with the cart: no vertical speed to speak of.
    expect(Math.abs(hub[2])).toBeLessThan(0.02);
    expect(hub[0]).toBeCloseTo(cartV[0], 2);
    // The raw linear part of cvel is the tree COM's frame, and is not.
    const raw = [data.cvel[b * 6 + 3], data.cvel[b * 6 + 4], data.cvel[b * 6 + 5]];
    expect(Math.hypot(raw[0] - hub[0], raw[1] - hub[1], raw[2] - hub[2])).toBeGreaterThan(0.1);
  });

  it("puts world ω into a free joint's frame, which is how qvel holds it", () => {
    const b = id('cart');
    // Tip the cart over and spin it about a world axis.
    const m = mj.MjModel.from_xml_string(XML);
    const d = new mj.MjData(m);
    try {
      const s = Math.SQRT1_2;
      d.qpos[3] = s; d.qpos[4] = s; d.qpos[5] = 0; d.qpos[6] = 0; // 90° about x
      mj.mj_forward(m, d);
      const wWorld = [0, 0, 2];
      const local = worldToBodyFrame(d.xmat, b, wWorld);
      d.qvel[3] = local[0]; d.qvel[4] = local[1]; d.qvel[5] = local[2];
      mj.mj_forward(m, d);
      const got = [d.cvel[b * 6], d.cvel[b * 6 + 1], d.cvel[b * 6 + 2]];
      for (let k = 0; k < 3; k++) expect(got[k]).toBeCloseTo(wWorld[k], 9);
      // Written straight into qvel, the same ω turns about the body's z, which is now world -y.
      d.qvel[3] = 0; d.qvel[4] = 0; d.qvel[5] = 2;
      mj.mj_forward(m, d);
      expect(Math.abs(d.cvel[b * 6 + 1])).toBeCloseTo(2, 6);
    } finally { d.delete(); m.delete(); }
  });
});
