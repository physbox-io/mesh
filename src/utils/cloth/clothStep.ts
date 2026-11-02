/**
 * What cloth needs from the physics worker each step, read back out of the
 * model the MJCF compiler wrote (utils/cloth/clothMjcf.ts):
 *
 *  - Sewing and tensioning: each `clothsew_` connect's body2 anchor moves from
 *    where it was compiled (the gap) to its target over its time.
 *  - Floating: a flex is held weightless while it is being sewn.
 *  - Wind: a flat-plate force on each triangle from the wind relative to
 *    the cloth (clothNormalCoefficient). MuJoCo's own fluid model sizes its drag from a
 *    body's inertia, and a flex vertex is a point mass with none, so it does
 *    not move cloth at all.
 *
 * Pure: no worker globals, so tests step a model the same way.
 */

import { CLOTH_FLEX_PREFIX, CLOTH_SEW_PREFIX } from './clothMjcf';

/* eslint-disable @typescript-eslint/no-explicit-any -- the MuJoCo wasm bindings are untyped here */
type Mj = any;
type Model = any;
type Data = any;

interface Sew { eq: number; from: [number, number, number]; to: [number, number, number]; seconds: number }
interface FlexRt {
  vadr: number; vnum: number;
  /** Vertex bodies, by local vertex. */
  bodies: Int32Array;
  mass: Float64Array;
  /** Triangles, as local vertex indices. */
  elems: Int32Array;
  floatSeconds: number;
  cd: number;
}

export interface ClothRuntime {
  sews: Sew[];
  flexes: FlexRt[];
  eqStride: number;
  prev: Float64Array | null;
  prevTime: number;
  /** Equality ids of the ties, by name, for reading their loads. */
  ties: { name: string; eq: number }[];
}

const OBJ = (mujoco: Mj, key: string, fallback: number) => mujoco.mjtObj?.[key]?.value ?? fallback;

export function initClothRuntime(mujoco: Mj, model: Model): ClothRuntime | null {
  if (!model.nflex || !model.nnumeric) return null;
  const NUMERIC = OBJ(mujoco, 'mjOBJ_NUMERIC', 20), EQUALITY = OBJ(mujoco, 'mjOBJ_EQUALITY', 17), FLEX = OBJ(mujoco, 'mjOBJ_FLEX', 9);
  const eqData = model.eq_data;
  const eqStride = model.neq ? eqData.length / model.neq : 0;
  const nAdr = model.numeric_adr, nData = model.numeric_data;
  const sews: Sew[] = [];
  const flexByName = new Map<string, { seconds: number; cd: number }>();
  for (let i = 0; i < model.nnumeric; i++) {
    const name: string = mujoco.mj_id2name(model, NUMERIC, i) ?? '';
    const a = nAdr[i];
    if (name.startsWith(CLOTH_SEW_PREFIX)) {
      const eq = mujoco.mj_name2id(model, EQUALITY, name.slice(CLOTH_SEW_PREFIX.length));
      if (eq < 0) continue;
      const o = eqStride * eq + 3;
      sews.push({ eq, from: [eqData[o], eqData[o + 1], eqData[o + 2]], to: [nData[a], nData[a + 1], nData[a + 2]], seconds: Math.max(1e-6, nData[a + 3]) });
    } else if (name.startsWith(CLOTH_FLEX_PREFIX)) {
      flexByName.set(name.slice(CLOTH_FLEX_PREFIX.length), { seconds: nData[a], cd: nData[a + 1] });
    }
  }
  const flexes: FlexRt[] = [];
  const vadr = model.flex_vertadr, vnum = model.flex_vertnum, vbody = model.flex_vertbodyid;
  const eadr = model.flex_elemdataadr, enumA = model.flex_elemnum, elem = model.flex_elem, dim = model.flex_dim;
  const bmass = model.body_mass;
  for (let fi = 0; fi < model.nflex; fi++) {
    const info = flexByName.get(mujoco.mj_id2name(model, FLEX, fi) ?? '');
    if (!info || dim[fi] !== 2) continue;
    const n = vnum[fi], bodies = new Int32Array(n), mass = new Float64Array(n);
    for (let v = 0; v < n; v++) { bodies[v] = vbody[vadr[fi] + v]; mass[v] = bmass[bodies[v]]; }
    const elems = Int32Array.from(elem.slice(eadr[fi], eadr[fi] + 3 * enumA[fi]));
    flexes.push({ vadr: vadr[fi], vnum: n, bodies, mass, elems, floatSeconds: info.seconds, cd: info.cd });
  }
  if (!sews.length && !flexes.length) return null;
  const ties: ClothRuntime['ties'] = [];
  for (let e = 0; e < model.neq; e++) {
    const name: string = mujoco.mj_id2name(model, EQUALITY, e) ?? '';
    if (name.startsWith('cloth_') && name.includes('_tie')) ties.push({ name, eq: e });
  }
  return { sews, flexes, eqStride, prev: null, prevTime: -1, ties };
}

const SKIN_FRICTION = 0.02;
const STALL = (15 * Math.PI) / 180, POST_STALL = (30 * Math.PI) / 180;

/**
 * Force square to a sheet, over dynamic pressure times area, with the flow at
 * `alpha` to its plane. A flat plate's, as the aerodynamic bodies use
 * (physicsWorker, isAerodynamic): lift-like 5.7 per radian until it stalls at
 * 15 degrees, then easing by 30 degrees onto a bluff plate's `cd * sin(alpha)`,
 * which is `cd` square on. Pressure alone (sin^2) left a nearly flat sail all
 * but untouched by wind blowing across it. `cd` below a solid sheet's 1.2 is
 * an open weave letting air through, and scales the whole curve.
 */
export function clothNormalCoefficient(alpha: number, cd: number): number {
  const k = cd / 1.2;
  const bluff = cd * Math.sin(alpha);
  if (alpha <= STALL) return k * 5.7 * alpha;
  if (alpha >= POST_STALL) return bluff;
  const t = (alpha - STALL) / (POST_STALL - STALL);
  return (1 - t) * k * 5.7 * STALL + t * bluff;
}

/**
 * Call before each mj_step, after xfrc_applied is cleared. `wind` is the
 * world wind in m/s, `airDensity` kg/m^3.
 */
export function applyCloth(rt: ClothRuntime, model: Model, data: Data, wind: [number, number, number], airDensity: number) {
  const t = data.time;
  const eqData = model.eq_data;
  for (const s of rt.sews) {
    const k = Math.min(1, t / s.seconds), o = rt.eqStride * s.eq + 3;
    eqData[o] = s.from[0] + (s.to[0] - s.from[0]) * k;
    eqData[o + 1] = s.from[1] + (s.to[1] - s.from[1]) * k;
    eqData[o + 2] = s.from[2] + (s.to[2] - s.from[2]) * k;
  }
  const xf = data.xfrc_applied;
  const g = model.opt.gravity;
  for (const f of rt.flexes) {
    if (t < f.floatSeconds) {
      for (let v = 0; v < f.vnum; v++) {
        const b = 6 * f.bodies[v], m = f.mass[v];
        xf[b] -= m * g[0]; xf[b + 1] -= m * g[1]; xf[b + 2] -= m * g[2];
      }
    }
  }
  const windy = wind[0] !== 0 || wind[1] !== 0 || wind[2] !== 0;
  const pos: Float64Array = data.flexvert_xpos;
  // Vertex velocity from the last step's positions: the slide joints a flex
  // vertex moves on are in its parent's frame, and this is simpler and exact
  // enough for a pressure.
  const dt = rt.prev && t > rt.prevTime ? t - rt.prevTime : 0;
  const prev = rt.prev;
  if (!windy) { rt.prev = null; return; }
  for (const f of rt.flexes) {
    const E = f.elems;
    for (let e = 0; e < E.length; e += 3) {
      const ia = 3 * (f.vadr + E[e]), ib = 3 * (f.vadr + E[e + 1]), ic = 3 * (f.vadr + E[e + 2]);
      const ux = pos[ib] - pos[ia], uy = pos[ib + 1] - pos[ia + 1], uz = pos[ib + 2] - pos[ia + 2];
      const wx = pos[ic] - pos[ia], wy = pos[ic + 1] - pos[ia + 1], wz = pos[ic + 2] - pos[ia + 2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue;
      const area = len / 2;
      nx /= len; ny /= len; nz /= len;
      let rx = wind[0], ry = wind[1], rz = wind[2];
      if (dt > 0 && prev) {
        rx -= (pos[ia] + pos[ib] + pos[ic] - prev[ia] - prev[ib] - prev[ic]) / (3 * dt);
        ry -= (pos[ia + 1] + pos[ib + 1] + pos[ic + 1] - prev[ia + 1] - prev[ib + 1] - prev[ic + 1]) / (3 * dt);
        rz -= (pos[ia + 2] + pos[ib + 2] + pos[ic + 2] - prev[ia + 2] - prev[ib + 2] - prev[ic + 2]) / (3 * dt);
      }
      const speed2 = rx * rx + ry * ry + rz * rz;
      if (speed2 < 1e-10) continue;
      const speed = Math.sqrt(speed2);
      const vn = rx * nx + ry * ny + rz * nz;
      const alpha = Math.asin(Math.min(1, Math.abs(vn) / speed));
      // Dynamic pressure times area, shared by the triangle's three corners.
      const qa = (0.5 * airDensity * speed2 * area) / 3;
      const pn = Math.sign(vn) * qa * clothNormalCoefficient(alpha, f.cd);
      // Skin friction along the sheet, from the flow's in-plane part.
      const tx = rx - vn * nx, ty = ry - vn * ny, tz = rz - vn * nz;
      const pt = (qa * SKIN_FRICTION) / speed;
      for (const v of [E[e], E[e + 1], E[e + 2]]) {
        const b = 6 * f.bodies[v];
        xf[b] += pn * nx + pt * tx; xf[b + 1] += pn * ny + pt * ty; xf[b + 2] += pn * nz + pt * tz;
      }
    }
  }
  if (!rt.prev || rt.prev.length !== pos.length) rt.prev = new Float64Array(pos.length);
  rt.prev.set(pos);
  rt.prevTime = t;
}

/**
 * Load on each tie, newtons: the force in its connect's three constraint
 * rows, read from the last step.
 */
export function clothTieLoads(rt: ClothRuntime, data: Data, EQUALITY_TYPE = 0): { name: string; newtons: number }[] {
  if (!rt.ties.length) return [];
  const n = data.nefc, type = data.efc_type, id = data.efc_id, force = data.efc_force;
  const sum = new Map<number, number>();
  for (let r = 0; r < n; r++) {
    if (type[r] !== EQUALITY_TYPE) continue;
    sum.set(id[r], (sum.get(id[r]) ?? 0) + force[r] * force[r]);
  }
  return rt.ties.map((t) => ({ name: t.name, newtons: Math.sqrt(sum.get(t.eq) ?? 0) }));
}
