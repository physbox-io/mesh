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
      { name: `joint:${j.name}.force.cos(w)`, direction: 'input', unit: force, description: `Force amplitude a, applied as a·cos(w·q) of joint ${j.name}'s position q every step; w in the name, per ${pos}` },
      { name: `joint:${j.name}.force.sin(w)`, direction: 'input', unit: force, description: `Force amplitude b, applied as b·sin(w·q) of joint ${j.name}'s position q every step; w in the name, per ${pos}` },
      { name: `joint:${j.name}.armature`, direction: 'input', unit: j.hinge ? 'kg·m²' : 'kg', description: `Inertia added to joint ${j.name} while named in each step: a motor's rotor` },
      { name: `joint:${j.name}.damping`, direction: 'input', unit: j.hinge ? 'N·m·s/rad' : 'N·s/m', description: `Damping added to joint ${j.name} while named in each step: a motor's bearings` },
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

/**
 * An input resolved to where it goes:
 *  - `dof`: a force on a joint, constant or `value·cos(w·q)` / `value·sin(w·q)`
 *    of the joint's own position q, evaluated afresh every step;
 *  - `ctrl`: an actuator's control input;
 *  - `armature` / `damping`: added to the joint's own while named — a
 *    motor's rotor inertia and its bearing friction, coupled to the joint.
 */
export type ResolvedInput =
  | { kind: 'dof'; index: number; qposadr: number; value: number; harmonic?: { fn: 'cos' | 'sin'; w: number } }
  | { kind: 'ctrl'; index: number; value: number }
  | { kind: 'armature' | 'damping'; index: number; value: number };

const JOINT_INPUT = /^joint:(.+?)\.(force(?:\.(cos|sin)\(([-+0-9.eE]+)\))?|armature|damping)$/;
const ACTUATOR_INPUT = /^actuator:(.+)$/;

/**
 * Where each input goes. Names this model has no channel for come back in
 * `unknown` rather than being dropped in silence.
 */
export function resolveInputs(mj: Mujoco, model: MjModel, inputs: Record<string, number>): { resolved: ResolvedInput[]; unknown: string[] } {
  const resolved: ResolvedInput[] = [];
  const unknown: string[] = [];
  for (const [name, value] of Object.entries(inputs)) {
    if (!Number.isFinite(value)) { unknown.push(name); continue; }
    const j = JOINT_INPUT.exec(name);
    if (j) {
      const id = idOf(mj, model, 'joint', j[1]);
      if (id < 0 || (model.jnt_type[id] !== JOINT_HINGE && model.jnt_type[id] !== JOINT_SLIDE)) { unknown.push(name); continue; }
      const dof = model.jnt_dofadr[id];
      if (j[2] === 'armature' || j[2] === 'damping') {
        resolved.push({ kind: j[2], index: dof, value });
      } else {
        const w = j[4] === undefined ? undefined : Number(j[4]);
        if (w !== undefined && !Number.isFinite(w)) { unknown.push(name); continue; }
        resolved.push({
          kind: 'dof', index: dof, qposadr: model.jnt_qposadr[id], value,
          harmonic: w === undefined ? undefined : { fn: j[3] as 'cos' | 'sin', w },
        });
      }
      continue;
    }
    if (name.includes('.')) { unknown.push(name); continue; }
    const a = ACTUATOR_INPUT.exec(name);
    const id = a ? idOf(mj, model, 'actuator', a[1]) : -1;
    if (id < 0) { unknown.push(name); continue; }
    resolved.push({ kind: 'ctrl', index: id, value });
  }
  return { resolved, unknown };
}

/** Sets the actuator inputs; they hold until changed. Joint forces are applied per step. */
export function applyCtrlInputs(data: MjData, inputs: ResolvedInput[]): void {
  for (const i of inputs) if (i.kind === 'ctrl') data.ctrl[i.index] = i.value;
}

/**
 * Adds the joint-force inputs to `qfrc_applied`, each evaluated at the
 * joint's position now. Call it every step, after whatever clears
 * `qfrc_applied` and before `mj_step`.
 */
export function applyJointForces(data: MjData, inputs: ResolvedInput[]): void {
  if (inputs.length === 0) return;
  // One view of each: every read of `data.qpos` allocates a fresh one.
  const qfrc = data.qfrc_applied;
  const qpos = data.qpos;
  for (const i of inputs) {
    if (i.kind !== 'dof') continue;
    let f = i.value;
    if (i.harmonic) {
      const q = qpos[i.qposadr];
      f *= i.harmonic.fn === 'cos' ? Math.cos(i.harmonic.w * q) : Math.sin(i.harmonic.w * q);
    }
    qfrc[i.index] += f;
  }
}

/**
 * The armature and damping a link has added, per model: each dof's own value
 * from the scene, and what is on it now.
 */
const jointParams = new WeakMap<MjModel, Map<string, { base: number; applied: number }>>();

/**
 * Puts the joint parameters a STEP_FOR names on the model — the scene's own
 * value plus the input — and takes off any it no longer names, so a step
 * that names none (as unlinking sends) leaves the scene as it was built.
 *
 * Armature only reaches the dynamics after `mj_setConst`: MuJoCo caches the
 * inertia it derives from it. That is not free, so the model is only written
 * when a value changes, which for a motor is once per link.
 */
export function setJointParams(mj: Mujoco, model: MjModel, data: MjData, inputs: ResolvedInput[]): void {
  let held = jointParams.get(model);
  if (!held) {
    held = new Map();
    jointParams.set(model, held);
  }
  const wanted = new Map<string, number>();
  for (const i of inputs) {
    if (i.kind === 'armature' || i.kind === 'damping') wanted.set(`${i.kind}:${i.index}`, Math.max(0, i.value));
  }
  let armatureChanged = false;
  const write = (key: string, value: number) => {
    const [kind, idx] = key.split(':');
    (kind === 'armature' ? model.dof_armature : model.dof_damping)[Number(idx)] = value;
    if (kind === 'armature') armatureChanged = true;
  };
  for (const [key, add] of wanted) {
    let entry = held.get(key);
    if (!entry) {
      const [kind, idx] = key.split(':');
      const base = (kind === 'armature' ? model.dof_armature : model.dof_damping)[Number(idx)];
      entry = { base, applied: base };
      held.set(key, entry);
    }
    if (entry.applied !== entry.base + add) {
      entry.applied = entry.base + add;
      write(key, entry.applied);
    }
  }
  for (const [key, entry] of held) {
    if (wanted.has(key)) continue;
    if (entry.applied !== entry.base) write(key, entry.base);
    held.delete(key);
  }
  if (armatureChanged) {
    // mj_setConst uses the data it is handed as scratch, which would reset
    // the scene mid-run, so it gets data of its own.
    const scratch = new mj.MjData(model);
    try {
      mj.mj_setConst(model, scratch);
    } finally {
      scratch.delete();
    }
    mj.mj_forward(model, data);
  }
}

/**
 * How many sub-steps each model step needs so position-dependent forces stay
 * resolved: a stepper held by its coils is a stiff spring (~240Hz on its own
 * rotor), and a timestep long beside its period would ring and blow up.
 *
 * Each joint's stiffness is bounded by Σ|value·w| over its harmonic forces;
 * with its inertia (mass-matrix diagonal, armature included) that gives an
 * upper bound on its natural frequency, and the step is cut until there are
 * twenty to a period. Capped, so a mistaken law cannot stall the page.
 */
export function substepsFor(model: MjModel, data: MjData, inputs: ResolvedInput[], timestepS: number, maxSubsteps = 64): number {
  const stiffness = new Map<number, number>();
  for (const i of inputs) {
    if (i.kind !== 'dof' || !i.harmonic) continue;
    stiffness.set(i.index, (stiffness.get(i.index) ?? 0) + Math.abs(i.value * i.harmonic.w));
  }
  if (stiffness.size === 0) return 1;
  const qM = data.qM;
  let n = 1;
  for (const [dof, k] of stiffness) {
    const inertia = Math.max(qM[model.dof_Madr[dof]], 1e-12);
    const omega = Math.sqrt(k / inertia);
    const period = (2 * Math.PI) / omega;
    n = Math.max(n, Math.ceil(timestepS / (period / 20)));
  }
  return Math.min(n, maxSubsteps);
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
 * How many equal steps make a `dtMs` slice exactly, none longer than the
 * model's timestep: Volt owns time, so a 5ms slice is 5ms even in a scene
 * stepped at 2ms (three steps of 1.67ms). None for a slice of zero — how Volt
 * reads the scene before its first slice without moving it.
 */
export function stepsFor(dtMs: number, timestepS: number): number {
  if (!(dtMs > 0)) return 0;
  return Math.max(1, Math.ceil(dtMs / 1000 / timestepS - 1e-9));
}

// ---------------------------------------------------------------------------
// Measured cavities: outputs that come from the scene graph, not the model
// ---------------------------------------------------------------------------

/** What "Measure cavity" found for a body, in metres and cubic metres. */
export interface MeasuredCavity {
  volume: number;
  portLength?: number;
  portRadius?: number;
}

const CAVITY_OUTPUT = /^body:(.+)\.(cavityVolume|portLength|portRadius)$/;

/**
 * The channels of every measured cavity: a speaker in Volt binds its box
 * volume and port to them. Constants rather than state, so they are answered
 * on the main thread and never reach the physics worker; a port's channels
 * exist only when the body has a port.
 */
export function cavityChannels(measured: Record<string, MeasuredCavity>): CoSimChannel[] {
  const channels: CoSimChannel[] = [];
  for (const [body, c] of Object.entries(measured)) {
    channels.push({ name: `body:${body}.cavityVolume`, direction: 'output', unit: 'm³', description: `Air volume inside body ${body}, as measured` });
    if (c.portLength !== undefined && c.portRadius !== undefined) {
      channels.push(
        { name: `body:${body}.portLength`, direction: 'output', unit: 'm', description: `Length of body ${body}'s port` },
        { name: `body:${body}.portRadius`, direction: 'output', unit: 'm', description: `Radius of body ${body}'s port` },
      );
    }
  }
  return channels;
}

/**
 * Splits the outputs a STEP_FOR names into the measured cavities' (answered
 * here) and the rest (for the model). A cavity name with no measurement stays
 * with the rest, so it comes back `unknown` as any other would.
 */
export function readCavityOutputs(measured: Record<string, MeasuredCavity>, names: string[]): { outputs: Record<string, number>; rest: string[] } {
  const outputs: Record<string, number> = {};
  const rest: string[] = [];
  for (const name of names) {
    const m = CAVITY_OUTPUT.exec(name);
    const c = m ? measured[m[1]] : undefined;
    const v = !m || !c ? undefined : m[2] === 'cavityVolume' ? c.volume : m[2] === 'portLength' ? c.portLength : c.portRadius;
    if (v === undefined) rest.push(name);
    else outputs[name] = v;
  }
  return { outputs, rest };
}
