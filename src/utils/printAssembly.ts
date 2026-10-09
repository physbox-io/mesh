// ---------------------------------------------------------------------------
// Does it go back together? Split for Print's assembly test
// ---------------------------------------------------------------------------
//
// A split is only worth printing if the sections assemble: the pins have to
// line up with their holes, go in, and hold the parts where they were cut from.
// This puts that to MuJoCo, one joint at a time, in the 'print' fidelity
// (SceneGraph.simFidelity) where pins and holes collide as their exact shapes.
//
// THE STAGES follow the cut tree upwards: the two halves of a cut are each put
// together first, and then joined. A join holds everything on the cut's
// negative side still, at its designed place, and drops everything on the
// positive side onto it as one rigid body — the scene turned so the cut's
// normal points up, so gravity does the pushing and no script is needed. It
// starts a pin and a half above its seat, nudged sideways by less than the
// clearance, the way a careful hand would offer it up. With dowels, the dowels
// are dropped into their holes first, in a stage of their own.
//
// Each stage then measures:
//   seated     whether it came down to within 0.1 mm of where it was cut from —
//              a pin that misses its hole stands it off by about a pin length;
//   alignment  how far sideways and how far turned it ended up;
//   play       how far it moves when pushed sideways both ways, and when
//              twisted. About the clearance with two pins; with one, it turns;
//              with none, it slides, which is fine — glue holds it.
//   stability  whether MuJoCo stayed finite and kept time.
//
// Building the stages is pure and runs anywhere. Running them needs MuJoCo and
// a compiled model: the caller compiles each stage's scene with compileToMJCF,
// and hands the XML to `runStage` — in the split worker in the browser, and
// directly in the tests.
// ---------------------------------------------------------------------------

import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import type { FeatureCollider, Joinery, SplitResult, SplitSection, SplitTree } from './printSplit';
import { applyMat3, rotationBetween, type Mat3, type Vec3 } from './printPlate';

type SplitOk = Extract<SplitResult, { ok: true }>;
export type Quat = [number, number, number, number];

/** What the stages are measured against, mm. */
export const SEATED_MM = 0.1;
/** PLA, kg/m³. */
const PLA_DENSITY = 1240;
/** Beech dowel, kg/m³. */
const DOWEL_DENSITY = 700;
/** PLA on PLA, more or less. */
const PRINT_FRICTION = 0.3;
/** Where the lowest part of a stage sits above the floor, m. */
const LIFT_M = 0.02;

export interface AssemblyBody {
  /** MuJoCo body name. */
  name: string;
  /**
   * The point it is judged at, in its own body frame: the middle of what it
   * carries. Not the body origin, which for a section is wherever the whole
   * part's origin was — perhaps half a metre off — where a hundredth of a
   * degree of tilt reads as a tenth of a millimetre.
   */
  probe: Vec3;
  /**
   * For a dowel: the section whose hole it was dropped into. Once seated it
   * travels with that section, through every later stage.
   */
  host?: number;
  /** Sections in it, by index into the split's sections. Empty for a dowel. */
  sections: number[];
  /** Where it belongs, in the stage's world, metres. */
  designedPos: Vec3;
  designedQuat: Quat;
}

export interface AssemblyStage {
  kind: 'dowels' | 'join';
  cut: number;
  label: string;
  scene: SceneGraph;
  /** Everything held still, already in place. */
  fixed: AssemblyBody;
  /** What falls into place. One body for a join; one per dowel. */
  moving: AssemblyBody[];
  /** How many pins hold this joint. */
  pins: number;
  joinery: Joinery;
  /** Sections whose body collider is only their convex hull, so contact is approximate. */
  approximate: number[];
  /** The rotation that takes the split's body frame into this stage's world. */
  worldRotation: Mat3;
  worldOffset: Vec3;
  /** Height of the joint's face in this stage's world, m. */
  seatZ: number;
  /** How wide the incoming part is across the joint, m. */
  spanM: number;
  /** What the incoming part weighs, N. */
  weightN: number;
}

/** A stage without its scene: what the worker needs once the scene is compiled. */
export type StageSpec = Omit<AssemblyStage, 'scene'>;

export interface AssemblyPlan {
  stages: AssemblyStage[];
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

function quatFromMat3(m: Mat3): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m;
  const tr = m00 + m11 + m22;
  let w, x, y, z;
  if (tr > 0) {
    const k = Math.sqrt(tr + 1) * 2;
    w = k / 4; x = (m21 - m12) / k; y = (m02 - m20) / k; z = (m10 - m01) / k;
  } else if (m00 > m11 && m00 > m22) {
    const k = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / k; x = k / 4; y = (m01 + m10) / k; z = (m02 + m20) / k;
  } else if (m11 > m22) {
    const k = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / k; x = (m01 + m10) / k; y = k / 4; z = (m12 + m21) / k;
  } else {
    const k = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / k; x = (m02 + m20) / k; y = (m12 + m21) / k; z = k / 4;
  }
  const l = Math.hypot(w, x, y, z) || 1;
  return [w / l, x / l, y / l, z / l];
}

const zUpToYUp = (v: ArrayLike<number>): number[] => {
  const out = new Array<number>(v.length);
  for (let i = 0; i < v.length; i += 3) { out[i] = v[i]; out[i + 1] = v[i + 2]; out[i + 2] = -v[i + 1]; }
  return out;
};

const friction = [PRINT_FRICTION, 0.005, 0.0001];

/**
 * A section's colliders as scene geoms: its plain body — as its exact convex
 * pieces when it is concave, because its hull would fill the corner its
 * neighbour sits in — then its exact pins and sockets.
 */
export function sectionGeoms(section: Pick<SplitSection, 'plainPositions' | 'plainFaces' | 'colliders' | 'convexPieces'>, prefix: string, rgba: number[]): SceneGeom[] {
  const bodies = section.convexPieces.length
    ? section.convexPieces
    : [{ positions: section.plainPositions, faces: section.plainFaces }];
  const geoms: SceneGeom[] = bodies.map((b, k) => {
    const renderVertices = Array.from(b.positions);
    return {
      name: `${prefix}_body${k}`,
      type: 'mesh',
      size: [1],
      rgba,
      density: PLA_DENSITY,
      friction,
      dynamic: true,
      vertices: zUpToYUp(renderVertices),
      renderVertices,
      faces: Array.from(b.faces),
    };
  });
  geoms.push(...featureGeoms(section.colliders, prefix, rgba).map((g) => ({ ...g, friction })));
  return geoms;
}

/** Exact colliders as scene geoms: collision-only, in the feature contact class. */
export function featureGeoms(colliders: FeatureCollider[], prefix: string, rgba: number[]): SceneGeom[] {
  return colliders.map((c, k): SceneGeom => {
    const base = { name: `${prefix}_f${k}`, role: 'collision' as const, contactClass: c.role, contactGroup: c.group, rgba };
    if (c.shape === 'box') return { ...base, type: 'box', size: [...c.half], pos: [...c.pos], quat: [...c.quat] };
    if (c.shape === 'cylinder') return { ...base, type: 'cylinder', size: [c.radius, c.halfLength], pos: [...c.pos], quat: [...c.quat] };
    return {
      ...base, type: 'mesh', size: [1], dynamic: true,
      vertices: zUpToYUp(c.positions), renderVertices: [...c.positions], faces: [...c.faces],
    };
  });
}

const leavesOf = (t: SplitTree): number[] => ('section' in t ? [t.section] : [...leavesOf(t.neg), ...leavesOf(t.pos)]);

/** Body-frame bounds of some sections, after a rotation. */
function rotatedMinZ(split: SplitOk, sections: number[], R: Mat3): number {
  let lo = Infinity;
  for (const s of sections) {
    const p = split.sections[s].positions;
    for (let i = 0; i < p.length; i += 3) lo = Math.min(lo, applyMat3(R, p, i)[2]);
  }
  return lo;
}

/** The middle of some sections' plain vertices, body frame. */
function centreOf(split: SplitOk, sections: number[]): Vec3 {
  let x = 0, y = 0, z = 0, n = 0;
  for (const s of sections) {
    const p = split.sections[s].plainPositions;
    for (let i = 0; i < p.length; i += 3) { x += p[i]; y += p[i + 1]; z += p[i + 2]; n++; }
  }
  return n ? [x / n, y / n, z / n] : [0, 0, 0];
}

const STAGE_COLOURS = [[0.55, 0.6, 0.66, 1], [0.95, 0.55, 0.2, 1], [0.8, 0.7, 0.45, 1]];

/**
 * The stages that put a split back together, in order: every cut's two sides
 * assembled before the cut itself is joined.
 */
export function buildAssemblyPlan(split: SplitOk): AssemblyPlan {
  const stages: AssemblyStage[] = [];
  const j = split.joinery;
  const pinLengthMm = j.kind === 'none' ? 5 : j.lengthMm / 2;
  // Inside the clearance's radial gap, so an aligned pin does go in.
  const nudgeM = (j.kind === 'none' ? 0.5 : 0.3 * j.clearanceMm) / 1000;

  const visit = (t: SplitTree) => {
    if ('section' in t) return;
    visit(t.neg);
    visit(t.pos);
    const cut = split.cuts[t.cut];
    const fixedSections = leavesOf(t.neg);
    const movingSections = leavesOf(t.pos);
    const R = rotationBetween(cut.normal, [0, 0, 1]);
    const quat = quatFromMat3(R);
    const minZ = rotatedMinZ(split, [...fixedSections, ...movingSections], R);
    const offset: Vec3 = [0, 0, LIFT_M - minZ];
    const joints = split.joints.filter((jt) => jt.cut === t.cut);
    const pins = joints.reduce((n, jt) => n + jt.pins.length, 0);
    // Concave and not cut into exact pieces (a curved part, which flat cuts do not resolve).
    const approximate = [...fixedSections, ...movingSections]
      .filter((s) => split.sections[s].solidity < 0.92 && !split.sections[s].convexPieces.length);

    /*
      The incoming part is held square, as a hand offering it up would: it
      slides freely in all three directions and turns freely about the
      insertion axis, but cannot tilt. Gravity alone dropped a tall section
      onto a small diagonal face and let it topple over that face to lean on
      its pins — not something anyone assembling it would allow, and not a
      fault in the split. The pins still have to line it up, and a single pin
      still lets it turn. Joint axes are in the body's frame, which is the
      stage's world turned by R, so the world's axes are taken back through it.
    */
    const toBody = (v: Vec3): Vec3 => [
      R[0] * v[0] + R[3] * v[1] + R[6] * v[2],
      R[1] * v[0] + R[4] * v[1] + R[7] * v[2],
      R[2] * v[0] + R[5] * v[1] + R[8] * v[2],
    ];
    const heldJoints = (name: string, sections: number[]): SceneNode['joints'] => [
      { name: `${name}_x`, type: 'slide', axis: toBody([1, 0, 0]), pos: [0, 0, 0] },
      { name: `${name}_y`, type: 'slide', axis: toBody([0, 1, 0]), pos: [0, 0, 0] },
      { name: `${name}_z`, type: 'slide', axis: toBody([0, 0, 1]), pos: [0, 0, 0] },
      { name: `${name}_turn`, type: 'hinge', axis: toBody([0, 0, 1]), pos: centreOf(split, sections) },
    ];
    const sectionNode = (name: string, sections: number[], colour: number[], pos: Vec3, held: boolean): SceneNode => ({
      id: name,
      name,
      pos: [...pos],
      quat: [...quat],
      joints: held ? heldJoints(name, sections) : [],
      children: [],
      geoms: sections.flatMap((s) => sectionGeoms(split.sections[s], `${name}_s${s}`, colour)),
    });

    const fixed: AssemblyBody = { name: 'seated', sections: fixedSections, probe: centreOf(split, fixedSections), designedPos: offset, designedQuat: quat };
    const seatZ = cut.offset + offset[2];
    const label = `Cut ${t.cut + 1}: section${movingSections.length > 1 ? 's' : ''} ${movingSections.map((s) => s + 1).join(', ')} onto ${fixedSections.map((s) => s + 1).join(', ')}`;

    // Dowels into their holes on the seated side, first.
    const dowelHosts = j.kind === 'dowel' ? joints.flatMap((jt) => jt.pins.map(() => jt.neg)) : [];
    const dowelJoints = j.kind === 'dowel' ? joints.flatMap((jt) => jt.pins.map(() => split.joints.indexOf(jt))) : [];
    const dowels = j.kind === 'dowel'
      ? joints.flatMap((jt) => jt.pins.map((p) => {
        const inward = cut.normal.map((v) => -v) as Vec3;
        // Bottomed in a hole half a dowel and a little deep: its centre sits
        // that little way in from the face.
        const centre: Vec3 = [p[0] + inward[0] * 0.0005, p[1] + inward[1] * 0.0005, p[2] + inward[2] * 0.0005];
        const w = applyMat3(R, centre);
        return [w[0] + offset[0], w[1] + offset[1], w[2] + offset[2]] as Vec3;
      }))
      : [];
    const dowelNode = (k: number, pos: Vec3, free: boolean): SceneNode => ({
      id: `dowel_${k}`,
      name: `dowel_${k}`,
      pos: [...pos],
      quat: [1, 0, 0, 0],
      joints: free ? [{ name: `dowel_${k}_free`, type: 'free' }] : [],
      children: [],
      geoms: [
        {
          name: `dowel_${k}_geom`,
          type: 'cylinder',
          size: [j.diameterMm / 2000, j.lengthMm / 2000],
          rgba: [0.85, 0.7, 0.45, 1],
          friction,
          role: 'collision',
          contactClass: 'pin',
          contactGroup: dowelJoints[k],
        },
        // The same cylinder again, touching nothing, to carry the weight:
        // a pin geom weighs nothing, and a dowel on its own body must.
        {
          name: `dowel_${k}_mass`,
          type: 'cylinder',
          size: [j.diameterMm / 2000, j.lengthMm / 2000],
          density: DOWEL_DENSITY,
          contype: 0,
          conaffinity: 0,
        },
      ],
    });

    if (dowels.length) {
      const lift = 1.5 * pinLengthMm / 1000;
      stages.push({
        kind: 'dowels',
        cut: t.cut,
        label: `Cut ${t.cut + 1}: ${dowels.length} dowel${dowels.length === 1 ? '' : 's'} into section${fixedSections.length > 1 ? 's' : ''} ${fixedSections.map((s) => s + 1).join(', ')}`,
        scene: {
          simFidelity: 'print',
          nodes: [
            sectionNode('seated', fixedSections, STAGE_COLOURS[0], offset, false),
            ...dowels.map((d, k) => dowelNode(k, [d[0] + nudgeM, d[1], d[2] + lift], true)),
          ],
        },
        fixed,
        moving: dowels.map((d, k) => ({ name: `dowel_${k}`, sections: [], host: dowelHosts[k], probe: [0, 0, 0] as Vec3, designedPos: d, designedQuat: [1, 0, 0, 0] as Quat })),
        pins: dowels.length,
        joinery: j,
        approximate,
        worldRotation: R,
        worldOffset: offset,
        seatZ,
        spanM: 0.01,
        weightN: 0,
      });
    }

    const lift = 1.5 * pinLengthMm / 1000;
    stages.push({
      kind: 'join',
      cut: t.cut,
      label,
      scene: {
        simFidelity: 'print',
        nodes: [
          sectionNode('seated', fixedSections, STAGE_COLOURS[0], offset, false),
          ...dowels.map((d, k) => dowelNode(k, d, false)),
          sectionNode('incoming', movingSections, STAGE_COLOURS[1], [offset[0] + nudgeM, offset[1], offset[2] + lift], true),
        ],
      },
      fixed,
      moving: [{ name: 'incoming', sections: movingSections, probe: centreOf(split, movingSections), designedPos: offset, designedQuat: quat }],
      pins,
      joinery: j,
      approximate,
      worldRotation: R,
      worldOffset: offset,
      seatZ,
      spanM: spanOf(split, movingSections, R),
      weightN: weightOf(split, movingSections),
    });
  };
  visit(split.tree);
  return { stages };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** The slice of the MuJoCo module this needs. */
export interface MujocoLike {
  MjModel: { from_xml_string(xml: string): MjModelLike };
  MjData: new (model: MjModelLike) => MjDataLike;
  mj_step(model: MjModelLike, data: MjDataLike): void;
  mj_forward(model: MjModelLike, data: MjDataLike): void;
  mj_name2id(model: MjModelLike, type: number, name: string): number;
  mjtObj: { mjOBJ_BODY: { value: number } };
}
export interface MjModelLike { delete(): void }
export interface MjDataLike {
  time: number;
  /** Body centres of mass, world. */
  xipos: Float64Array;
  qpos: Float64Array;
  qvel: Float64Array;
  xpos: Float64Array;
  xquat: Float64Array;
  xfrc_applied: Float64Array;
  delete(): void;
}

export interface StageFrame {
  t: number;
  /** Per moving body, world pos then quat (w, x, y, z). */
  poses: number[][];
}

export interface StageResult {
  label: string;
  kind: AssemblyStage['kind'];
  cut: number;
  ok: boolean;
  seated: boolean;
  /** How far short of its seat it came to rest, mm; the worst body. */
  gapMm: number;
  /** How far sideways of its seat, mm. */
  lateralMm: number;
  /** How far turned from its seat, degrees. */
  angleDeg: number;
  /** Free movement side to side when pushed both ways, mm; null when unbounded. */
  playMm: number | null;
  /** Free turn when twisted both ways, degrees; null when unbounded. */
  twistDeg: number | null;
  /** A single pin: the part can turn about it. */
  rotates: boolean;
  diverged: boolean;
  approximate: boolean;
  notes: string[];
  frames: StageFrame[];
}

const RAD = 180 / Math.PI;

/** v turned by unit quaternion q (w, x, y, z). */
function rotateByQuat(q: ArrayLike<number>, v: ArrayLike<number>): Vec3 {
  const [w, x, y, z] = [q[0], q[1], q[2], q[3]];
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [
    v[0] + w * tx + (y * tz - z * ty),
    v[1] + w * ty + (z * tx - x * tz),
    v[2] + w * tz + (x * ty - y * tx),
  ];
}

/** Where a body-frame point is, for a body at this pose. */
function pointAt(pos: ArrayLike<number>, quat: ArrayLike<number>, probe: ArrayLike<number>): Vec3 {
  const r = rotateByQuat(quat, probe);
  return [pos[0] + r[0], pos[1] + r[1], pos[2] + r[2]];
}

function quatAngleDeg(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d)) * RAD;
}

/**
 * Runs one stage on a model compiled from its scene. Never throws for a model
 * that loads: a stage that blows up says so in `diverged`.
 */
export function runStage(mj: MujocoLike, xml: string, stage: StageSpec, opts: { settleTicks?: number; stride?: number } = {}): StageResult {
  const settleTicks = opts.settleTicks ?? 1200;
  const stride = opts.stride ?? 10;
  const model = mj.MjModel.from_xml_string(xml);
  const data = new mj.MjData(model);
  const notes: string[] = [];
  try {
    mj.mj_forward(model, data);
    const ids = stage.moving.map((b) => mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, b.name));
    if (ids.some((id) => id < 0)) throw new Error('A stage body is missing from its model.');
    const frames: StageFrame[] = [];
    let diverged = false;
    let lastTime = data.time;

    const snapshot = () => ids.map((id) => [
      data.xpos[id * 3], data.xpos[id * 3 + 1], data.xpos[id * 3 + 2],
      data.xquat[id * 4], data.xquat[id * 4 + 1], data.xquat[id * 4 + 2], data.xquat[id * 4 + 3],
    ]);
    const step = (ticks: number, push?: { body: number; force?: Vec3; torque?: Vec3 }, record = false) => {
      for (let i = 0; i < ticks && !diverged; i++) {
        data.xfrc_applied.fill(0);
        if (push) {
          const o = push.body * 6;
          if (push.force) { data.xfrc_applied[o] += push.force[0]; data.xfrc_applied[o + 1] += push.force[1]; data.xfrc_applied[o + 2] += push.force[2]; }
          if (push.torque) { data.xfrc_applied[o + 3] += push.torque[0]; data.xfrc_applied[o + 4] += push.torque[1]; data.xfrc_applied[o + 5] += push.torque[2]; }
        }
        mj.mj_step(model, data);
        // MuJoCo resets itself to the start, silently, when the state blows up
        // (see tests/headlessRun.test.ts); time going backwards is the tell.
        if (!(data.time > lastTime) || !Number.isFinite(data.qpos[0])) diverged = true;
        lastTime = data.time;
        if (record && i % stride === 0) frames.push({ t: data.time, poses: snapshot() });
      }
    };

    // Until everything that moves has stopped moving, for long enough to be
    // sure, or the budget runs out.
    let still = 0;
    for (let done = 0; done < settleTicks && !diverged && still < 60; done += stride) {
      step(stride, undefined, true);
      let fastest = 0;
      for (let i = 0; i < data.qvel.length; i++) fastest = Math.max(fastest, Math.abs(data.qvel[i]));
      // A millimetre a second: a dowel in its hole jitters at a tenth of
      // that for ever, and waiting it out cost a second of simulation a stage.
      still = done > 100 && fastest < 1e-3 ? still + stride : 0;
    }
    frames.push({ t: data.time, poses: snapshot() });

    // Seated, and how well.
    // Signed: below its seat is as wrong as above it — it went through.
    let gapMm = 0, lateralMm = 0, angleDeg = 0;
    stage.moving.forEach((b, k) => {
      const id = ids[k];
      const q = [data.xquat[id * 4], data.xquat[id * 4 + 1], data.xquat[id * 4 + 2], data.xquat[id * 4 + 3]];
      const p = pointAt([data.xpos[id * 3], data.xpos[id * 3 + 1], data.xpos[id * 3 + 2]], q, b.probe);
      const want = pointAt(b.designedPos, b.designedQuat, b.probe);
      const gap = (p[2] - want[2]) * 1000;
      if (Math.abs(gap) > Math.abs(gapMm)) gapMm = gap;
      lateralMm = Math.max(lateralMm, Math.hypot(p[0] - want[0], p[1] - want[1]) * 1000);
      angleDeg = Math.max(angleDeg, quatAngleDeg(q, b.designedQuat));
    });
    const seated = !diverged && Math.abs(gapMm) <= SEATED_MM;

    // Play: push it each way across the joint, and twist it each way about the
    // insertion axis, starting each time from where it settled.
    let playMm: number | null = null, twistDeg: number | null = null;
    if (stage.kind === 'join' && seated) {
      const settledQpos = Float64Array.from(data.qpos);
      const settledQuat = Array.from(data.xquat.slice(ids[0] * 4, ids[0] * 4 + 4));
      const restore = () => {
        data.qpos.set(settledQpos);
        data.qvel.fill(0);
        mj.mj_forward(model, data);
      };
      const id = ids[0];
      const probe = stage.moving[0].probe;
      const sizeM = stage.spanM;
      // Enough to beat friction comfortably. Applied at the joint face rather
      // than at the centre of mass — a force at a tall part's middle tips it
      // over its edge instead of sliding it on its pins — which in MuJoCo's
      // terms is the force at the centre of mass plus the moment of carrying
      // it down to the face.
      const weight = stage.weightN;
      const force = 1.5 * PRINT_FRICTION * weight;
      const ticks = 300;
      const at = () => pointAt(
        [data.xpos[id * 3], data.xpos[id * 3 + 1], data.xpos[id * 3 + 2]],
        [data.xquat[id * 4], data.xquat[id * 4 + 1], data.xquat[id * 4 + 2], data.xquat[id * 4 + 3]],
        probe,
      );
      const quatNow = () => [data.xquat[id * 4], data.xquat[id * 4 + 1], data.xquat[id * 4 + 2], data.xquat[id * 4 + 3]];
      const shifts: number[] = [];
      for (const axis of [0, 1]) {
        const ends: number[] = [];
        for (const sign of [1, -1]) {
          restore();
          const f: Vec3 = [0, 0, 0];
          f[axis] = sign * force;
          // r × F, with r from the centre of mass straight down to the face.
          const drop = stage.seatZ - data.xipos[id * 3 + 2];
          const torque: Vec3 = [-drop * f[1], drop * f[0], 0];
          step(ticks, { body: id, force: f, torque });
          ends.push(at()[axis]);
        }
        shifts.push(Math.abs(ends[0] - ends[1]) * 1000);
      }
      const unboundedMm = Math.max(2, 10 * (stage.joinery.kind === 'none' ? 0.2 : stage.joinery.clearanceMm));
      const worstShift = Math.max(...shifts);
      playMm = worstShift > unboundedMm ? null : worstShift;

      const turns: number[] = [];
      for (const sign of [1, -1]) {
        restore();
        step(ticks, { body: id, torque: [0, 0, sign * force * sizeM / 2] });
        turns.push(quatAngleDeg(quatNow(), settledQuat));
      }
      const twist = turns[0] + turns[1];
      twistDeg = twist > 5 ? null : twist;
      restore();
    }

    // With no pins it is held by glue alone, which the next note says; turning
    // about a pin is a single pin's problem.
    const rotates = stage.kind === 'join' && stage.joinery.kind !== 'none' && stage.pins >= 1
      && (stage.pins === 1 || (seated && twistDeg === null));
    if (stage.kind === 'join' && stage.joinery.kind !== 'none' && stage.pins === 0) {
      notes.push('No pins on this joint: the face was too narrow for one. It is held by glue alone.');
    }
    if (rotates) notes.push('It can turn about its pin. Glue it with the faces clamped square, or use a wider face for a second pin.');
    if (!seated && !diverged && gapMm < 0) {
      notes.push(`It ended up ${(-gapMm).toFixed(2)} mm past its seat: it went into the part it joins, which means the contact there is not being seen.`);
    } else if (!seated && !diverged) {
      notes.push(gapMm > 0.5
        ? `It came to rest ${gapMm.toFixed(1)} mm short of its seat: a pin is not finding its hole.`
        : `It came to rest ${gapMm.toFixed(2)} mm short of its seat.`);
    }
    if (diverged) notes.push('The simulation became unstable during this stage, so its numbers mean nothing.');
    const approximate = stage.approximate.length > 0;
    if (approximate) notes.push(`Section${stage.approximate.length > 1 ? 's' : ''} ${stage.approximate.map((s) => s + 1).join(', ')} collide${stage.approximate.length > 1 ? '' : 's'} as a convex hull here, so contact away from the pins is approximate.`);

    // Fails when it does not go together, or when two or more pins still let it
    // slide about — pins that are not bearing. A single pin, or none, is a
    // weakness the notes name, not a failure to assemble.
    return {
      label: stage.label,
      kind: stage.kind,
      cut: stage.cut,
      ok: seated && !diverged && (stage.kind === 'dowels' || stage.joinery.kind === 'none' || stage.pins < 2 || playMm !== null),
      seated,
      gapMm,
      lateralMm,
      angleDeg,
      playMm,
      twistDeg,
      rotates,
      diverged,
      approximate,
      notes,
      frames,
    };
  } finally {
    data.delete();
    model.delete();
  }
}


/** How wide some sections are across the cut, once turned into the stage, m. */
function spanOf(split: SplitOk, sections: number[], R: Mat3): number {
  const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const s of sections) {
    const p = split.sections[s].plainPositions;
    for (let i = 0; i < p.length; i += 3) {
      const w = applyMat3(R, p, i);
      for (let k = 0; k < 2; k++) { lo[k] = Math.min(lo[k], w[k]); hi[k] = Math.max(hi[k], w[k]); }
    }
  }
  return Number.isFinite(lo[0]) ? Math.max(0.01, Math.hypot(hi[0] - lo[0], hi[1] - lo[1])) : 0.05;
}

/** What some sections weigh in PLA, N. */
function weightOf(split: SplitOk, sections: number[]): number {
  const mm3 = sections.reduce((v, s) => v + split.sections[s].volumeMm3, 0);
  return Math.max(1e-3, mm3 * 1e-9 * PLA_DENSITY * 9.81);
}

export interface AssemblyReport {
  ok: boolean;
  stages: StageResult[];
}

/** Every stage of a plan, given a compiler for its scenes. */
export function runAssembly(mj: MujocoLike, plan: AssemblyPlan, compile: (scene: SceneGraph) => string): AssemblyReport {
  const stages = plan.stages.map((stage) => runStage(mj, compile(stage.scene), stage));
  return { ok: stages.every((s) => s.ok), stages };
}
