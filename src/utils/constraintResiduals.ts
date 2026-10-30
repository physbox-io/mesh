/**
 * How far a headless run's constraints were pulled apart, and which joints ran
 * through their stops.
 *
 * MuJoCo's equality constraints and joint limits are soft: a linkage loaded
 * past what they can hold just stretches. A scissor lift whose loop-closing
 * `<connect>` pins opened up to 23 mm folded 178 mm through the floor, and a
 * 50 g slider ran to -136 mm against a -120 mm stop, and both runs came back
 * settled with no warning at all. This watches every tick and says so.
 *
 * Residuals come straight from the solver: the first `ne` rows of `efc_pos`
 * are the equality rows, each tagged with its equality's id in `efc_id` -
 * three position rows for a connect, three more for a weld's rotation, one for
 * a joint or tendon coupling. A coupling held by a fixed tendon (as every
 * coupling the compiler writes is) is read through its tendon's joints, so a
 * hinge's error is in degrees: it used to be printed as metres, and a gear
 * pair 0.2° out at start-up read "3.46 mm apart, not holding". Only
 * typed-array views are read per tick; no embind vector is copied onto the
 * heap. Worker-safe: no store, no DOM.
 */

// MuJoCo enum values (mjtEq, mjtConstraint, mjtJoint, mjtObj).
const EQ_CONNECT = 0;
const EQ_WELD = 1;
const EQ_JOINT = 2;
const EQ_TENDON = 3;
const CNSTR_EQUALITY = 0;
const JNT_SLIDE = 2;
const JNT_HINGE = 3;
const WRAP_JOINT = 1;
const TRN_JOINT = 0;

/** Above these a residual is a warning: a pin or weld this far open is not holding. */
export const RESIDUAL_WARN_MM = 1;
export const RESIDUAL_WARN_DEG = 1;
/**
 * How far past a stop a joint may sit before it counts. A stop is soft too, and
 * a part resting on one presses into it a little; this is well past that.
 */
export const LIMIT_WARN_MM = 2;
export const LIMIT_WARN_DEG = 2;

const RAD2DEG = 180 / Math.PI;

export interface ConstraintResidual {
  name: string;
  kind: 'connect' | 'weld' | 'joint' | 'tendon' | 'other';
  /** The bodies it ties together; 'world' for the ground. */
  bodies: string[];
  /** The two joints a coupling ties, joint1 first. */
  joints?: string[];
  /** Largest position error over the run, and at the end. */
  worstMm?: number;
  finalMm?: number;
  /** Largest rotation error (welds, hinge couplings), and at the end. */
  worstDeg?: number;
  finalDeg?: number;
  /** Simulated time of the worst error. */
  worstAtS: number;
  /** Switched off by the end of the run: it broke, which is reported as a break. */
  broke?: boolean;
}

export interface LimitOvershoot {
  joint: string;
  body: string;
  /** The range, in mm for a slide and degrees for a hinge. */
  range: [number, number];
  unit: 'mm' | 'deg';
  /** Furthest it went past either end. */
  worstPast: number;
  worstAtS: number;
  /** Where it ended, and how far past the range that is (0 inside it). */
  final: number;
  finalPast: number;
}

export interface ConstraintReport {
  /** Every active equality's worst residual, worst first. */
  constraints: ConstraintResidual[];
  /** Only joints that went well past a stop. */
  limits: LimitOvershoot[];
  warnings: string[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Mj = any;
type Model = any;
type Data = any;
/* eslint-enable @typescript-eslint/no-explicit-any */

const round = (v: number, places = 1) => Math.round(v * 10 ** places) / 10 ** places;

interface EqTrack {
  name: string;
  kind: ConstraintResidual['kind'];
  bodies: string[];
  joints?: string[];
  /** A coupling of two joints, by joint equality or by fixed tendon. */
  coupling: boolean;
  /** For a coupling: is joint1 a slide (metres) or rotary (radians)? */
  linear: boolean;
  torquescale: number;
  worstPos: number;
  worstRot: number;
  worstAt: number;
  finalPos: number;
  finalRot: number;
  seen: boolean;
  index: number;
}

interface LimitTrack {
  joint: string;
  body: string;
  qadr: number;
  lo: number;
  hi: number;
  slide: boolean;
  worstPast: number;
  worstAt: number;
}

export function createConstraintMonitor(mj: Mj, model: Model) {
  const OBJ_BODY: number = mj.mjtObj?.mjOBJ_BODY?.value ?? 1;
  const OBJ_JOINT: number = mj.mjtObj?.mjOBJ_JOINT?.value ?? 3;
  const OBJ_EQUALITY: number = mj.mjtObj?.mjOBJ_EQUALITY?.value ?? 17;
  const OBJ_ACTUATOR: number = mj.mjtObj?.mjOBJ_ACTUATOR?.value ?? 19;
  const name = (type: number, id: number, fallback: string) => {
    try { return mj.mj_id2name(model, type, id) || fallback; } catch { return fallback; }
  };
  const bodyName = (id: number) => (id <= 0 ? 'world' : name(OBJ_BODY, id, `body ${id}`));

  const neq: number = model.neq ?? 0;
  const eqType = neq ? model.eq_type : null;
  const obj1 = neq ? model.eq_obj1id : null;
  const obj2 = neq ? model.eq_obj2id : null;
  const eqData = neq ? model.eq_data : null;
  const stride = neq ? eqData.length / neq : 0;
  const jntType = model.njnt ? model.jnt_type : null;
  const jntBody = model.njnt ? model.jnt_bodyid : null;

  const eqs: EqTrack[] = [];
  for (let i = 0; i < neq; i++) {
    const t = eqType[i];
    const kind: ConstraintResidual['kind'] =
      t === EQ_CONNECT ? 'connect' : t === EQ_WELD ? 'weld' : t === EQ_JOINT ? 'joint' : t === EQ_TENDON ? 'tendon' : 'other';
    const track: EqTrack = {
      name: name(OBJ_EQUALITY, i, `equality ${i}`),
      kind, bodies: [], coupling: false, linear: true, torquescale: 1,
      worstPos: 0, worstRot: 0, worstAt: 0, finalPos: 0, finalRot: 0, seen: false, index: i,
    };
    if (kind === 'connect' || kind === 'weld') {
      track.bodies = [bodyName(obj1[i]), bodyName(obj2[i])];
      if (kind === 'weld') track.torquescale = eqData[i * stride + 10] || 0;
    } else if (kind === 'joint') {
      const j1 = obj1[i], j2 = obj2[i];
      track.joints = [name(OBJ_JOINT, j1, `joint ${j1}`), ...(j2 >= 0 ? [name(OBJ_JOINT, j2, `joint ${j2}`)] : [])];
      track.bodies = [bodyName(jntBody[j1]), ...(j2 >= 0 ? [bodyName(jntBody[j2])] : [])];
      track.linear = jntType[j1] === JNT_SLIDE;
      track.coupling = true;
    } else if (kind === 'tendon' && obj2[i] < 0 && model.ntendon) {
      // A fixed tendon of joints held at zero length: joint1 has coef 1, so
      // the residual is in joint1's units.
      const t = obj1[i];
      const adr = model.tendon_adr[t], num = model.tendon_num[t];
      const joints: number[] = [];
      for (let w = adr; w < adr + num; w++) if (model.wrap_type[w] === WRAP_JOINT) joints.push(model.wrap_objid[w]);
      if (joints.length === num && num >= 2) {
        track.joints = joints.map((jt) => name(OBJ_JOINT, jt, `joint ${jt}`));
        track.bodies = joints.map((jt) => bodyName(jntBody[jt]));
        track.linear = jntType[joints[0]] === JNT_SLIDE;
        track.coupling = true;
      }
    }
    eqs.push(track);
  }

  const limits: LimitTrack[] = [];
  if (model.njnt) {
    const limited = model.jnt_limited;
    const range = model.jnt_range;
    const qadr = model.jnt_qposadr;
    for (let j = 0; j < model.njnt; j++) {
      const t = jntType[j];
      if (!limited[j] || (t !== JNT_SLIDE && t !== JNT_HINGE)) continue;
      const lo = range[2 * j], hi = range[2 * j + 1];
      if (!(hi > lo)) continue;
      limits.push({
        joint: name(OBJ_JOINT, j, `joint ${j}`), body: bodyName(jntBody[j]),
        qadr: qadr[j], lo, hi, slide: t === JNT_SLIDE, worstPast: 0, worstAt: 0,
      });
    }
  }

  // Squared sums per equality for the tick being read; reused, never reallocated.
  const posSq = new Float64Array(neq);
  const rotSq = new Float64Array(neq);
  const rows = new Int32Array(neq);

  /** Read one tick's residuals and positions. Call after mj_step. */
  const sample = (data: Data) => {
    const time: number = data.time;
    if (neq) {
      const ne: number = data.ne ?? 0;
      if (ne > 0) {
        posSq.fill(0); rotSq.fill(0); rows.fill(0);
        const pos = data.efc_pos, type = data.efc_type, id = data.efc_id;
        for (let r = 0; r < ne; r++) {
          if (type[r] !== CNSTR_EQUALITY) continue;
          const e = id[r];
          if (e < 0 || e >= neq) continue;
          const k = rows[e]++;
          const v = pos[r];
          // A weld's rows 3..5 are its rotation, the rest are positions (or a
          // coupling's single row, in the units of its first joint).
          if (eqs[e].kind === 'weld' && k >= 3) rotSq[e] += v * v;
          else posSq[e] += v * v;
        }
        for (let e = 0; e < neq; e++) {
          if (rows[e] === 0) continue;
          const t = eqs[e];
          let posErr = 0, rotErr = 0;
          if (t.coupling && !t.linear) rotErr = Math.sqrt(posSq[e]) * RAD2DEG;
          else posErr = Math.sqrt(posSq[e]) * 1000;
          if (t.kind === 'weld' && t.torquescale > 0) {
            const s = Math.min(1, Math.sqrt(rotSq[e]) / t.torquescale);
            rotErr = 2 * Math.asin(s) * RAD2DEG;
          }
          t.seen = true;
          t.finalPos = posErr;
          t.finalRot = rotErr;
          // Judged against the warning thresholds, so a weld's millimetre and
          // its degree are weighed alike when picking the worst moment.
          const now = Math.max(posErr / RESIDUAL_WARN_MM, rotErr / RESIDUAL_WARN_DEG);
          const was = Math.max(t.worstPos / RESIDUAL_WARN_MM, t.worstRot / RESIDUAL_WARN_DEG);
          if (now > was) t.worstAt = time;
          if (posErr > t.worstPos) t.worstPos = posErr;
          if (rotErr > t.worstRot) t.worstRot = rotErr;
        }
      }
    }
    if (limits.length) {
      const qpos = data.qpos;
      for (const l of limits) {
        const q = qpos[l.qadr];
        const past = Math.max(l.lo - q, q - l.hi, 0);
        if (past > l.worstPast) { l.worstPast = past; l.worstAt = time; }
      }
    }
  };

  /**
   * A velocity servo on one of these joints stiffer than the joint can follow
   * (kv*dt over its inertia well above 1), which the implicit integrator
   * damps where the constraint solver cannot see it.
   */
  const stiffServo = (joints: string[]) => {
    // The compiler's step (utils/mjcf.ts). model.opt is a struct copied
    // onto the heap on every read, not a view.
    const dt = 0.001;
    for (let a = 0; a < (model.nu ?? 0); a++) {
      if (model.actuator_trntype[a] !== TRN_JOINT) continue;
      const jt = model.actuator_trnid[2 * a];
      const jn = name(OBJ_JOINT, jt, '');
      if (!joints.includes(jn) || (jntType[jt] !== JNT_SLIDE && jntType[jt] !== JNT_HINGE)) continue;
      const kv = -model.actuator_biasprm[10 * a + 2];
      const inertia = model.dof_M0[model.jnt_dofadr[jt]];
      if (!(kv > 0) || !(inertia > 0)) continue;
      const ratio = (kv * dt) / inertia;
      if (ratio > 10) {
        return { actuator: name(OBJ_ACTUATOR, a, `actuator ${a}`), joint: jn, ratio: +ratio.toPrecision(3), kvMax: +(inertia / dt).toPrecision(2) };
      }
    }
    return null;
  };

  /** What the run did to its constraints. `data` gives the final positions. */
  const report = (data: Data): ConstraintReport => {
    const warnings: string[] = [];
    const active = neq && data ? data.eq_active : null;
    const constraints: ConstraintResidual[] = eqs
      .filter((t) => t.seen)
      .map((t) => {
        const broke = !!active && !active[t.index];
        const usesMm = !t.coupling || t.linear;
        const usesDeg = t.kind === 'weld' || (t.coupling && !t.linear);
        return {
          name: t.name, kind: t.kind, bodies: t.bodies,
          ...(t.joints ? { joints: t.joints } : {}),
          ...(usesMm ? { worstMm: round(t.worstPos, 2), finalMm: round(t.finalPos, 2) } : {}),
          ...(usesDeg ? { worstDeg: round(t.worstRot, 2), finalDeg: round(t.finalRot, 2) } : {}),
          worstAtS: round(t.worstAt, 3),
          ...(broke ? { broke: true } : {}),
        };
      })
      .sort((a, b) =>
        Math.max((b.worstMm ?? 0) / RESIDUAL_WARN_MM, (b.worstDeg ?? 0) / RESIDUAL_WARN_DEG)
        - Math.max((a.worstMm ?? 0) / RESIDUAL_WARN_MM, (a.worstDeg ?? 0) / RESIDUAL_WARN_DEG));

    for (const c of constraints) {
      if (c.broke) continue;
      const parts: string[] = [];
      if ((c.worstMm ?? 0) > RESIDUAL_WARN_MM) parts.push(`${c.worstMm} mm apart (${c.finalMm} mm at the end)`);
      if ((c.worstDeg ?? 0) > RESIDUAL_WARN_DEG) parts.push(`${c.worstDeg}° out (${c.finalDeg}° at the end)`);
      if (!parts.length) continue;
      const what = c.joints
        ? `Coupling ${c.name} (${c.joints.join(' -> ')}, on ${c.bodies.join(' and ')})`
        : `${c.kind === 'connect' ? 'Pin' : c.kind === 'weld' ? 'Weld' : 'Constraint'} ${c.name} between ${c.bodies.join(' and ')}`;
      const servo = c.joints && stiffServo(c.joints);
      warnings.push(servo
        ? `${what} was pulled ${parts.join(', ')}, worst at t=${c.worstAtS} s: it is not holding. ${servo.actuator} drives ${servo.joint} with a servo far stiffer than the joint can follow in a step (kv*timestep/inertia = ${servo.ratio}), and the coupled parts are whipped around it before they settle. Lower its kv below ${servo.kvMax} or give it a forceLimit: the servo is the cause, not the load or the masses.`
        : `${what} was pulled ${parts.join(', ')}, worst at t=${c.worstAtS} s: it is not holding, so the motion is not what the mechanism allows. Look for a part driven against it, an over-constrained loop, or too little mass for the load.`);
    }

    const over: LimitOvershoot[] = [];
    const qpos = data?.qpos;
    for (const l of limits) {
      const scale = l.slide ? 1000 : RAD2DEG;
      const warnAt = l.slide ? LIMIT_WARN_MM : LIMIT_WARN_DEG;
      const q = qpos ? qpos[l.qadr] : NaN;
      const finalPast = Number.isFinite(q) ? Math.max(l.lo - q, q - l.hi, 0) * scale : 0;
      const worst = l.worstPast * scale;
      if (worst <= warnAt) continue;
      const unit = l.slide ? 'mm' : 'deg';
      const entry: LimitOvershoot = {
        joint: l.joint, body: l.body, unit,
        range: [round(l.lo * scale), round(l.hi * scale)],
        worstPast: round(worst), worstAtS: round(l.worstAt, 3),
        final: round(q * scale), finalPast: round(finalPast),
      };
      over.push(entry);
      const u = l.slide ? ' mm' : '°';
      warnings.push(`Joint ${l.joint} (${l.body}) ran ${entry.worstPast}${u} past its range [${entry.range[0]}, ${entry.range[1]}]${u} at t=${entry.worstAtS} s and ended at ${entry.final}${u}${finalPast > warnAt ? `, still ${entry.finalPast}${u} past it` : ''}: its stop is not holding the load.`);
    }
    return { constraints, limits: over, warnings };
  };

  return { sample, report };
}

/** How far a residual is over its warning, the measure the report sorts by. */
const severity = (c: ConstraintResidual) =>
  Math.max((c.worstMm ?? 0) / RESIDUAL_WARN_MM, (c.worstDeg ?? 0) / RESIDUAL_WARN_DEG);

/**
 * One report for a run whose model was rebuilt partway (a headless run in
 * which something shattered): each constraint and stop by name, the worst
 * moment from whichever model saw it, the end from the last. Equalities are
 * named by index, so one detached by the rebuild can lend its name to the
 * next; that is rare, and costs only which row a figure is filed under.
 */
export function mergeConstraintReports(reports: ConstraintReport[]): ConstraintReport {
  if (reports.length === 1) return reports[0];
  const byName = new Map<string, ConstraintResidual>();
  for (const r of reports) {
    for (const c of r.constraints) {
      const was = byName.get(c.name);
      if (!was) { byName.set(c.name, c); continue; }
      const worse = severity(was) > severity(c) ? was : c;
      byName.set(c.name, {
        ...c,
        ...(worse.worstMm !== undefined ? { worstMm: worse.worstMm } : {}),
        ...(worse.worstDeg !== undefined ? { worstDeg: worse.worstDeg } : {}),
        worstAtS: worse.worstAtS,
        ...(was.broke || c.broke ? { broke: true } : {}),
      });
    }
  }
  const byJoint = new Map<string, LimitOvershoot>();
  for (const r of reports) {
    for (const l of r.limits) {
      const was = byJoint.get(l.joint);
      byJoint.set(l.joint, was && was.worstPast > l.worstPast
        ? { ...l, worstPast: was.worstPast, worstAtS: was.worstAtS }
        : l);
    }
  }
  return {
    constraints: [...byName.values()].sort((a, b) => severity(b) - severity(a)),
    limits: [...byJoint.values()],
    warnings: [...new Set(reports.flatMap((r) => r.warnings))],
  };
}
