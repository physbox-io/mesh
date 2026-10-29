// Telemetry of every joint type, actuator effort, and the scripts' raycast and
// contact sensors, against real MuJoCo. See src/workers/scriptSensors.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import load_mujoco from '@mujoco/mujoco';
import {
  actuatorsByJoint, contactsOfBody, jointViews, raycast, readJoint, type JointInfo, type SensorNames,
} from '../src/workers/scriptSensors';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
let mj: Mujoco;
let model: InstanceType<Mujoco['MjModel']>;
let data: InstanceType<Mujoco['MjData']>;

// A box resting on the floor (free), a ball-jointed pendulum, a slide driven by
// a motor, and a hinge driven by nothing.
const XML = `<mujoco>
  <option timestep="0.001"/>
  <worldbody>
    <geom name="floor" type="plane" size="1 1 0.1"/>
    <body name="box" pos="0.2 0 0.35"><freejoint name="box_free"/><geom name="box_g" type="box" size="0.05 0.05 0.05" mass="1"/></body>
    <body name="bob" pos="-0.3 0 0.5"><joint name="bob_ball" type="ball"/><geom name="bob_g" type="sphere" size="0.02" pos="0 0 -0.1" contype="0" conaffinity="0"/></body>
    <body name="lift" pos="0.6 0 0.5"><joint name="lift_z" type="slide" axis="0 0 1"/><geom name="lift_g" type="sphere" size="0.02" contype="0" conaffinity="0"/></body>
    <body name="arm" pos="-0.6 0 0.5"><joint name="arm_h" type="hinge" axis="0 1 0"/><geom name="arm_g" type="capsule" fromto="0 0 0 0.1 0 0" size="0.01" contype="0" conaffinity="0"/></body>
  </worldbody>
  <actuator><motor name="lift_z_actuator" joint="lift_z"/></actuator>
</mujoco>`;

const names = (): SensorNames => ({
  geomName: (g) => mj.mj_id2name(model, mj.mjtObj.mjOBJ_GEOM.value, g) || `geom_${g}`,
  bodyNode: (b) => (b === 0 ? 'world' : mj.mj_id2name(model, mj.mjtObj.mjOBJ_BODY.value, b) || `body_${b}`),
});

const joint = (name: string, body: string): JointInfo => {
  const id = mj.mj_name2id(model, mj.mjtObj.mjOBJ_JOINT.value, name);
  return { name, id, type: model.jnt_type[id], qposadr: model.jnt_qposadr[id], dofadr: model.jnt_dofadr[id], body, actuators: actuatorsByJoint(mj, model).get(id) ?? [] };
};

beforeAll(async () => {
  mj = await load_mujoco();
  model = mj.MjModel.from_xml_string(XML);
  data = new mj.MjData(model);
  // Let the box fall and land.
  for (let i = 0; i < 1500; i++) mj.mj_step(model, data);
});

afterAll(() => {
  data.delete();
  model.delete();
});

describe('joint telemetry', () => {
  it('reports a free joint at full width, not as its x', () => {
    const j = readJoint(joint('box_free', 'box'), jointViews(data));
    expect(j.body).toBe('box');
    expect(Array.isArray(j.pos) && j.pos.length).toBe(7);
    expect(Array.isArray(j.vel) && j.vel.length).toBe(6);
    const pos = j.pos as number[];
    expect(pos[0]).toBeCloseTo(0.2, 3);
    // Resting on the floor: z is its half height, not 1e-14.
    expect(pos[2]).toBeCloseTo(0.05, 2);
    expect(Math.hypot(pos[3], pos[4], pos[5], pos[6])).toBeCloseTo(1, 6);
    expect(j).not.toHaveProperty('ctrl');
  });

  it('reports a ball joint as a quaternion and three rates', () => {
    const j = readJoint(joint('bob_ball', 'bob'), jointViews(data));
    expect((j.pos as number[]).length).toBe(4);
    expect((j.vel as number[]).length).toBe(3);
  });

  it('gives an actuated joint its control and the force the actuator puts in', () => {
    const lift = mj.mj_name2id(model, mj.mjtObj.mjOBJ_ACTUATOR.value, 'lift_z_actuator');
    data.ctrl[lift] = 3;
    mj.mj_forward(model, data);
    const j = readJoint(joint('lift_z', 'lift'), jointViews(data));
    expect(typeof j.pos).toBe('number');
    expect(j.ctrl).toBe(3);
    expect(j.actuatorForce).toBeCloseTo(3, 9);
    // The same force through setActuatorControl never showed in qfrc_applied.
    expect(j.qfrc_applied).toBe(0);
    const arm = readJoint(joint('arm_h', 'arm'), jointViews(data));
    expect(arm).not.toHaveProperty('actuatorForce');
  });
});

describe('api.raycast', () => {
  it('hits the top of the box from above, and the floor beside it', () => {
    const hit = raycast(mj, model, data, [0.2, 0, 1], [0, 0, -2], 10, -1, names());
    expect(hit).not.toBeNull();
    expect(hit!.geom).toBe('box_g');
    expect(hit!.body).toBe('box');
    expect(hit!.dist).toBeCloseTo(0.9, 2);
    expect(hit!.point[2]).toBeCloseTo(0.1, 2);
    const floor = raycast(mj, model, data, [0, 0.5, 1], [0, 0, -1], 10, -1, names());
    expect(floor!.body).toBe('world');
    expect(floor!.geom).toBe('floor');
  });

  it('skips the excluded body, and misses beyond maxDist or into the sky', () => {
    const box = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'box');
    expect(raycast(mj, model, data, [0.2, 0, 1], [0, 0, -1], 10, box, names())!.geom).toBe('floor');
    expect(raycast(mj, model, data, [0.2, 0, 1], [0, 0, -1], 0.5, -1, names())).toBeNull();
    expect(raycast(mj, model, data, [0, 0, 1], [0, 0, 1], 10, -1, names())).toBeNull();
    expect(() => raycast(mj, model, data, [0, 0, 1], [0, 0, 0], 10, -1, names())).toThrow(/non-zero/);
  });
});

describe('api.getContacts', () => {
  it('lists what the box rests on, with the normal force holding it up', () => {
    const box = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'box');
    const contacts = contactsOfBody(mj, model, data, box, names());
    expect(contacts.length).toBeGreaterThan(0);
    expect(contacts.every((c) => c.otherBody === 'world' && c.otherGeom === 'floor' && c.geom === 'box_g')).toBe(true);
    // Its weight, shared between the corners.
    const total = contacts.reduce((s, c) => s + c.force, 0);
    expect(total).toBeGreaterThan(9.81 * 0.8);
    expect(total).toBeLessThan(9.81 * 1.2);
  });

  it('is empty for a body touching nothing, and can be called every step for a long run', () => {
    const arm = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'arm');
    expect(contactsOfBody(mj, model, data, arm, names())).toEqual([]);
    const box = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, 'box');
    for (let i = 0; i < 20000; i++) contactsOfBody(mj, model, data, box, names());
    for (let i = 0; i < 20000; i++) raycast(mj, model, data, [0.2, 0, 1], [0, 0, -1], 10, -1, names());
  });
});
