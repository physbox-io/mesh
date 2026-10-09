// ---------------------------------------------------------------------------
// The co-simulation link: Volt drives this scene in lock step
//
// Volt solves a circuit in short slices; between slices it asks Mesh to step
// the scene by the same time with the inputs it names, and reads back the
// outputs it names. Volt owns time: while linked, Mesh never steps on its own.
//
// The protocol knows nothing about motors. A channel is a name and a number:
// Volt's DC motor binds a joint's force (in) and position and speed (out); a
// limit switch binds a body's contact count; a potentiometer a joint's angle.
//
// The two apps are different origins, so the channel is `window.open` +
// `postMessage`, and each end only listens to the other's origins. The same
// shape lives in Volt's src/utils/coSimLink.ts; the wiki records the contract.
// ---------------------------------------------------------------------------

import type load_mujoco from '@mujoco/mujoco';

type Mujoco = Awaited<ReturnType<typeof load_mujoco>>;
type MjModel = InstanceType<Mujoco['MjModel']>;
type MjData = InstanceType<Mujoco['MjData']>;

export const COSIM_PROTOCOL = 'physbox-cosim';
export const COSIM_VERSION = 1;

/** One number Volt can write or read. */
export interface CoSimChannel {
  name: string;
  direction: 'input' | 'output';
  unit: string;
  description: string;
}

type Envelope = { proto: typeof COSIM_PROTOCOL; v: number };

/** Every message either end sends. */
export type CoSimMessage = Envelope & (
  /** Volt → Mesh, repeated until answered: are you there, and what can I bind? */
  | { type: 'HELLO' }
  | { type: 'CATALOGUE'; channels: CoSimChannel[]; timestepMs: number; scene: string }
  /** Step `dtMs` with `inputs` held, then report `outputs`. */
  | { type: 'STEP_FOR'; seq: number; dtMs: number; inputs: Record<string, number>; outputs: string[] }
  | { type: 'STEPPED'; seq: number; t: number; steps: number; outputs: Record<string, number>; unknown: string[] }
  | { type: 'ERROR'; seq?: number; message: string }
  /** Either end, to end the link. */
  | { type: 'UNLINK' }
);

/** Messages without the envelope, as built by the sender. */
export type CoSimBody = CoSimMessage extends infer M ? M extends Envelope ? Omit<M, keyof Envelope> : never : never;

export const envelope = <T extends CoSimBody>(body: T): T & Envelope =>
  ({ proto: COSIM_PROTOCOL, v: COSIM_VERSION, ...body });

export function isCoSimMessage(value: unknown): value is CoSimMessage {
  if (!value || typeof value !== 'object') return false;
  const m = value as Record<string, unknown>;
  return m.proto === COSIM_PROTOCOL && m.v === COSIM_VERSION && typeof m.type === 'string';
}

/**
 * The pages allowed to drive this one: Volt, wherever it is running.
 *
 * Volt runs on 5174 beside Mesh's 5175 in development and at
 * volt.physbox.io in production. Anything else posting to this window is
 * ignored, so a page that happened to open Mesh cannot drive it.
 */
export function voltOrigins(location: { hostname: string; protocol: string } = window.location): string[] {
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  return local
    ? [`${location.protocol}//localhost:5174`, `${location.protocol}//127.0.0.1:5174`]
    : ['https://volt.physbox.io'];
}

// ---------------------------------------------------------------------------
// The channels of a built model
// ---------------------------------------------------------------------------

const JOINT_SLIDE = 2;
const JOINT_HINGE = 3;
const OBJ = (mj: Mujoco) => mj.mjtObj;

type ObjKind = 'joint' | 'actuator' | 'body';

/**
 * Name → id, remembered per built model. A linked Volt names the same
 * channels on every slice, and `mj_name2id` is a string search through the
 * model each time; a rebuilt model is a new object, so it starts afresh.
 */
const idCache = new WeakMap<MjModel, Map<string, number>>();
function idOf(mj: Mujoco, model: MjModel, kind: ObjKind, name: string): number {
  let cache = idCache.get(model);
  if (!cache) {
    cache = new Map();
    idCache.set(model, cache);
  }
  const key = `${kind}:${name}`;
  let id = cache.get(key);
  if (id === undefined) {
    const obj = kind === 'joint' ? OBJ(mj).mjOBJ_JOINT : kind === 'actuator' ? OBJ(mj).mjOBJ_ACTUATOR : OBJ(mj).mjOBJ_BODY;
    id = mj.mj_name2id(model, obj.value, name);
    cache.set(key, id);
  }
  return id;
}

/** Hinge and slide joints, by name: the ones with one scalar position. */
function scalarJoints(mj: Mujoco, model: MjModel): { name: string; id: number; hinge: boolean }[] {
  const out: { name: string; id: number; hinge: boolean }[] = [];
  for (let id = 0; id < model.njnt; id++) {
    const type = model.jnt_type[id];
    if (type !== JOINT_HINGE && type !== JOINT_SLIDE) continue;
    const name = mj.mj_id2name(model, OBJ(mj).mjOBJ_JOINT.value, id);
    if (name) out.push({ name, id, hinge: type === JOINT_HINGE });
  }
  return out;
}

function actuators(mj: Mujoco, model: MjModel): { name: string; id: number }[] {
  const out: { name: string; id: number }[] = [];
  for (let id = 0; id < model.nu; id++) {
    const name = mj.mj_id2name(model, OBJ(mj).mjOBJ_ACTUATOR.value, id);
    if (name) out.push({ name, id });
  }
  return out;
}

function bodies(mj: Mujoco, model: MjModel): { name: string; id: number }[] {
  const out: { name: string; id: number }[] = [];
  // Body 0 is the world.
  for (let id = 1; id < model.nbody; id++) {
    const name = mj.mj_id2name(model, OBJ(mj).mjOBJ_BODY.value, id);
    if (name) out.push({ name, id });
  }
  return out;
}

/** Everything a linked Volt can bind in this model. */
export function channelCatalogue(mj: Mujoco, model: MjModel): CoSimChannel[] {
  const channels: CoSimChannel[] = [];
  for (const j of scalarJoints(mj, model)) {
    const [pos, vel, force] = j.hinge ? ['rad', 'rad/s', 'N·m'] : ['m', 'm/s', 'N'];
    channels.push(
      { name: `joint:${j.name}.force`, direction: 'input', unit: force, description: `${j.hinge ? 'Torque' : 'Force'} applied along joint ${j.name}` },
      { name: `joint:${j.name}.pos`, direction: 'output', unit: pos, description: `Position of joint ${j.name}` },
      { name: `joint:${j.name}.vel`, direction: 'output', unit: vel, description: `Speed of joint ${j.name}` },
      { name: `joint:${j.name}.inertia`, direction: 'output', unit: j.hinge ? 'kg·m²' : 'kg', description: `What joint ${j.name} has to accelerate: its diagonal of the mass matrix` },
      { name: `joint:${j.name}.load`, direction: 'output', unit: force, description: `The ${j.hinge ? 'torque' : 'force'} the rest of the scene puts on joint ${j.name}: gravity, springs, damping, contacts, other actuators` },
    );
  }
  for (const a of actuators(mj, model)) {
    channels.push(
      { name: `actuator:${a.name}`, direction: 'input', unit: 'ctrl', description: `Control input of actuator ${a.name}` },
      { name: `actuator:${a.name}.force`, direction: 'output', unit: 'N·m or N', description: `Force actuator ${a.name} is applying` },
    );
  }
  for (const b of bodies(mj, model)) {
    for (const axis of ['x', 'y', 'z']) {
      channels.push({ name: `body:${b.name}.${axis}`, direction: 'output', unit: 'm', description: `World ${axis} of body ${b.name}` });
    }
    channels.push({ name: `body:${b.name}.contacts`, direction: 'output', unit: 'count', description: `How many contacts body ${b.name} is in` });
  }
  return channels;
}

/** An input resolved to where it goes: a dof's applied force, or an actuator's ctrl. */
export type ResolvedInput = { kind: 'dof'; index: number; value: number } | { kind: 'ctrl'; index: number; value: number };

const INPUT = /^(joint|actuator):(.+?)(\.force)?$/;

/**
 * Where each input goes. Names this model has no channel for come back in
 * `unknown` rather than being dropped in silence.
 */
export function resolveInputs(mj: Mujoco, model: MjModel, inputs: Record<string, number>): { resolved: ResolvedInput[]; unknown: string[] } {
  const resolved: ResolvedInput[] = [];
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    const m = INPUT.exec(name);
    if (!m || !Number.isFinite(value)) { unknown.push(name); continue; }
    if (m[1] === 'joint' && m[3]) {
      const id = idOf(mj, model, 'joint', m[2]);
      if (id < 0 || (model.jnt_type[id] !== JOINT_HINGE && model.jnt_type[id] !== JOINT_SLIDE)) { unknown.push(name); continue; }
      resolved.push({ kind: 'dof', index: model.jnt_dofadr[id], value });
    } else if (m[1] === 'actuator' && !m[3]) {
      const id = idOf(mj, model, 'actuator', m[2]);
      if (id < 0) { unknown.push(name); continue; }
      resolved.push({ kind: 'ctrl', index: id, value });
    } else {
      unknown.push(name);
    }
  }
  return { resolved, unknown };
}

/** Sets the actuator inputs; they hold until changed. Joint forces are applied per step. */
export function applyCtrlInputs(data: MjData, inputs: ResolvedInput[]): void {
  for (const i of inputs) if (i.kind === 'ctrl') data.ctrl[i.index] = i.value;
}

/**
 * Adds the joint-force inputs to `qfrc_applied`. Call it every step, after
 * whatever clears `qfrc_applied` and before `mj_step`.
 */
export function applyJointForces(data: MjData, inputs: ResolvedInput[]): void {
  if (inputs.length === 0) return;
  const qfrc = data.qfrc_applied;
  for (const i of inputs) if (i.kind === 'dof') qfrc[i.index] += i.value;
}

const OUTPUT = /^(joint|actuator|body):(.+)\.(pos|vel|inertia|load|force|x|y|z|contacts)$/;

/** The current value of each named output; names with no channel in `unknown`. */
export function readOutputs(mj: Mujoco, model: MjModel, data: MjData, names: string[]): { outputs: Record<string, number>; unknown: string[] } {
  const outputs: Record<string, number> = {};
  const unknown: string[] = [];
  let contactsByBody: Map<number, number> | null = null;
  const contactCounts = () => {
    if (contactsByBody) return contactsByBody;
    contactsByBody = new Map();
    // `data.contact` copies the whole array onto the heap: read it once, free it.
    const vec = data.contact;
    try {
      const n = vec.size();
      for (let c = 0; c < n; c++) {
        const contact = vec.get(c);
        if (!contact) continue;
        for (const g of [contact.geom1, contact.geom2]) {
          const body = model.geom_bodyid[g];
          contactsByBody.set(body, (contactsByBody.get(body) ?? 0) + 1);
        }
        contact.delete();
      }
    } finally {
      vec.delete();
    }
    return contactsByBody;
  };

  for (const name of names) {
    const m = OUTPUT.exec(name);
    if (!m) { unknown.push(name); continue; }
    const [, kind, target, field] = m;
    if (kind === 'joint' && (field === 'pos' || field === 'vel' || field === 'inertia' || field === 'load')) {
      const id = idOf(mj, model, 'joint', target);
      if (id < 0 || (model.jnt_type[id] !== JOINT_HINGE && model.jnt_type[id] !== JOINT_SLIDE)) { unknown.push(name); continue; }
      const dof = model.jnt_dofadr[id];
      if (field === 'pos') outputs[name] = data.qpos[model.jnt_qposadr[id]];
      else if (field === 'vel') outputs[name] = data.qvel[dof];
      else if (field === 'inertia') outputs[name] = data.qM[model.dof_Madr[dof]];
      // Everything acting on the dof except what the link itself applied:
      // M·qacc = passive − bias + actuator + constraint + applied.
      else outputs[name] = data.qfrc_passive[dof] - data.qfrc_bias[dof] + data.qfrc_actuator[dof] + data.qfrc_constraint[dof];
    } else if (kind === 'actuator' && field === 'force') {
      const id = idOf(mj, model, 'actuator', target);
      if (id < 0) { unknown.push(name); continue; }
      outputs[name] = data.actuator_force[id];
    } else if (kind === 'body') {
      const id = idOf(mj, model, 'body', target);
      if (id < 1) { unknown.push(name); continue; }
      if (field === 'contacts') outputs[name] = contactCounts().get(id) ?? 0;
      else if (field === 'x' || field === 'y' || field === 'z') outputs[name] = data.xpos[id * 3 + 'xyz'.indexOf(field)];
      else unknown.push(name);
    } else {
      unknown.push(name);
    }
  }
  return { outputs, unknown };
}

/**
 * How many model steps make `dtMs`: at least one for any slice, so time
 * always moves, and none for a slice of zero — which is how Volt reads the
 * scene's state before its first slice without moving it.
 */
export function stepsFor(dtMs: number, timestepS: number): number {
  if (!(dtMs > 0)) return 0;
  return Math.max(1, Math.round(dtMs / 1000 / timestepS));
}
