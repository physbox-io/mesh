// The physics worker's break check, run headless: compile a scene, step it in
// real MuJoCo, and let welds go where the worker would. The worker itself
// cannot be loaded in Vitest, so this mirrors its loop from the same pure
// pieces it is built from (breakThresholds, breakModel). Keep the two in step.

import { compileToMJCF } from '../src/utils/mjcf';
import { BREAK_FIELDS, parseBreakKey } from '../src/utils/breakModel';
import { BREAK_ARM_S, axialPush, barBending, toBodyFrame, weldOverload, weldTorque, type OverloadCause, type WeldBreakConfig } from '../src/utils/breakThresholds';
import type { SceneGraph } from '../src/types/scene';

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface BreakEvent { key: string; kind: 'member' | 'joint'; cause: OverloadCause | null; time: number; forceN: number; torqueNm: number; compressionN: number }

export interface Run {
  model: any;
  data: any;
  events: BreakEvent[];
  /** Highest push along each member's mid-span weld, by key: for the sign test. */
  peakPush: Record<string, number>;
  bodyPos: (name: string) => [number, number, number];
  realtime: number;
  done: () => void;
}

export function runWithBreaks(mj: any, scene: SceneGraph, seconds: number, opts: { breaks?: boolean; before?: (model: any, data: any) => void } = {}): Run {
  const model = mj.MjModel.from_xml_string(compileToMJCF(scene));
  const data = new mj.MjData(model);
  const eqId: Record<string, number> = {};
  for (let i = 0; i < model.neq; i++) eqId[mj.mj_id2name(model, mj.mjtObj.mjOBJ_EQUALITY.value, i)] = i;
  const specs: { key: string; eq: number; cfg: WeldBreakConfig; axis?: [number, number, number]; bar?: { wide: [number, number, number]; strongNm: number }; also?: string; kind: 'member' | 'joint'; consecutive: number }[] = [];
  const adrs = model.numeric_adr, vals = model.numeric_data;
  for (let i = 0; i < model.nnumeric; i++) {
    const key = mj.mj_id2name(model, mj.mjtObj.mjOBJ_NUMERIC.value, i);
    const p = parseBreakKey(key);
    if (!p || eqId[key] === undefined) continue;
    const d = (k: number) => vals[adrs[i] + k];
    const opt = (v: number) => (v >= 0 ? v : undefined);
    const comp = opt(d(BREAK_FIELDS.COMPRESSION));
    specs.push({
      key, eq: eqId[key], consecutive: 0, kind: p.kind === 'member' ? 'member' : 'joint',
      cfg: { weldBreakForceN: opt(d(BREAK_FIELDS.FORCE)), weldBreakTorqueNm: opt(d(BREAK_FIELDS.TORQUE)), weldBreakCompressionN: comp, weldBreakLateralN: opt(d(BREAK_FIELDS.LATERAL)), weldBreakHoldSteps: d(BREAK_FIELDS.HOLD) },
      axis: d(BREAK_FIELDS.AX) || d(BREAK_FIELDS.AY) || d(BREAK_FIELDS.AZ) ? [d(BREAK_FIELDS.AX), d(BREAK_FIELDS.AY), d(BREAK_FIELDS.AZ)] : undefined,
      also: d(BREAK_FIELDS.ALSO) ? `pin:${p.targetId}>${p.nodeId}` : undefined,
      bar: d(BREAK_FIELDS.STRONG) > 0 ? { wide: [d(BREAK_FIELDS.WX), d(BREAK_FIELDS.WY), d(BREAK_FIELDS.WZ)] as [number, number, number], strongNm: d(BREAK_FIELDS.STRONG) } : undefined,
    });
  }
  const events: BreakEvent[] = [];
  const peakPush: Record<string, number> = {};
  const broken = new Set<string>();
  const EQ = mj.mjtConstraint.mjCNSTR_EQUALITY.value;
  opts.before?.(model, data);
  const steps = Math.round(seconds / model.opt.timestep);
  const t0 = performance.now();
  for (let s = 0; s < steps; s++) {
    mj.mj_step(model, data);
    if (opts.breaks === false || data.time < BREAK_ARM_S || !specs.length) continue;
    const nefc = data.nefc;
    const type = data.efc_type, id = data.efc_id, f = data.efc_force;
    const rows = new Map<number, number[]>();
    for (let i = 0; i < nefc; i++) {
      if (type[i] !== EQ) continue;
      const r = rows.get(id[i]) ?? [];
      if (r.length < 6) r.push(f[i]);
      rows.set(id[i], r);
    }
    let xmat: ArrayLike<number> | null = null;
    const release = (w: (typeof specs)[number], e: Omit<BreakEvent, 'key' | 'kind'>) => {
      data.eq_active[w.eq] = 0;
      broken.add(w.key);
      events.push({ key: w.key, kind: w.kind, ...e });
    };
    for (const w of specs) {
      if (broken.has(w.key)) continue;
      const r = rows.get(w.eq);
      if (!r) continue;
      const [fx = 0, fy = 0, fz = 0, tx = 0, ty = 0, tz = 0] = r;
      const forceN = Math.hypot(fx, fy, fz);
      let torqueNm = weldTorque(tx, ty, tz);
      let compressionN = 0;
      if (w.axis) {
        xmat ??= data.xmat;
        compressionN = axialPush([fx, fy, fz], xmat!, model.eq_obj1id[w.eq], w.axis);
        peakPush[w.key] = Math.max(peakPush[w.key] ?? -Infinity, compressionN);
        if (w.bar && w.cfg.weldBreakTorqueNm !== undefined) {
          const t = toBodyFrame([tx / 2, ty / 2, tz / 2], xmat!, model.eq_obj1id[w.eq]);
          torqueNm = barBending(t, w.axis, w.bar.wide, w.cfg.weldBreakTorqueNm, w.bar.strongNm);
        }
      }
      const v = weldOverload(forceN, torqueNm, w.cfg, w.consecutive, compressionN);
      w.consecutive = v.consecutive;
      if (!v.broken) continue;
      const e = { cause: v.cause, time: data.time, forceN, torqueNm, compressionN };
      release(w, e);
      const other = w.also ? specs.find((x) => x.key === w.also) : undefined;
      if (other && !broken.has(other.key)) release(other, e);
    }
  }
  const wall = (performance.now() - t0) / 1000;
  return {
    model, data, events, peakPush,
    bodyPos: (name) => {
      const b = mj.mj_name2id(model, mj.mjtObj.mjOBJ_BODY.value, name);
      return [data.xpos[b * 3], data.xpos[b * 3 + 1], data.xpos[b * 3 + 2]];
    },
    realtime: seconds / wall,
    done: () => { data.delete(); model.delete(); },
  };
}
