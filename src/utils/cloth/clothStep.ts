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

import { CLOTH_FLEX_PREFIX, CLOTH_SEW_PREFIX, CLOTH_START_PREFIX } from './clothMjcf';

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
  /** Where each vertex starts, cloth body frame, when that is not its rest place. */
  start?: Float64Array;
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
  const startChunks = new Map<string, number[][]>();
  for (let i = 0; i < model.nnumeric; i++) {
    const name: string = mujoco.mj_id2name(model, NUMERIC, i) ?? '';
    const a = nAdr[i];
    if (name.startsWith(CLOTH_SEW_PREFIX)) {
      const eq = mujoco.mj_name2id(model, EQUALITY, name.slice(CLOTH_SEW_PREFIX.length));
      if (eq < 0) continue;
      const o = eqStride * eq + 3;
      sews.push({ eq, from: [eqData[o], eqData[o + 1], eqData[o + 2]], to: [nData[a], nData[a + 1], nData[a + 2]], seconds: Math.max(1e-6, nData[a + 3]) });
    } else if (name.startsWith(CLOTH_START_PREFIX)) {
      // Chunked: clothstart_<flex>__<k>.
      const rest = name.slice(CLOTH_START_PREFIX.length), cut = rest.lastIndexOf('__');
      const flex = rest.slice(0, cut), k = Number(rest.slice(cut + 2));
      (startChunks.get(flex) ?? startChunks.set(flex, []).get(flex)!)[k] = Array.from(nData.slice(a, a + model.numeric_size[i]) as ArrayLike<number>);
    } else if (name.startsWith(CLOTH_FLEX_PREFIX)) {
      flexByName.set(name.slice(CLOTH_FLEX_PREFIX.length), { seconds: nData[a], cd: nData[a + 1] });
    }
  }
  const startByName = new Map<string, Float64Array>();
  for (const [flex, chunks] of startChunks) startByName.set(flex, Float64Array.from(chunks.flat()));
  const flexes: FlexRt[] = [];
  const vadr = model.flex_vertadr, vnum = model.flex_vertnum, vbody = model.flex_vertbodyid;
  const eadr = model.flex_elemdataadr, enumA = model.flex_elemnum, elem = model.flex_elem, dim = model.flex_dim;
  const bmass = model.body_mass;
  for (let fi = 0; fi < model.nflex; fi++) {
    const flexName = mujoco.mj_id2name(model, FLEX, fi) ?? '';
    const info = flexByName.get(flexName);
    if (!info || dim[fi] !== 2) continue;
    const n = vnum[fi], bodies = new Int32Array(n), mass = new Float64Array(n);
    for (let v = 0; v < n; v++) { bodies[v] = vbody[vadr[fi] + v]; mass[v] = bmass[bodies[v]]; }
    const elems = Int32Array.from(elem.slice(eadr[fi], eadr[fi] + 3 * enumA[fi]));
    const start = startByName.get(flexName);
    flexes.push({ vadr: vadr[fi], vnum: n, bodies, mass, elems, floatSeconds: info.seconds, cd: info.cd, ...(start && start.length === 3 * n ? { start } : {}) });
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
 * Puts each cloth vertex where its piece starts (on the form, say) rather
 * than where it was cut, and aims every seam and tie from there. Call once on
 * a fresh start, after mj_forward; it forwards again.
 *
 * A flex vertex rests at its body's position (the flat pattern) and moves on
 * three slide joints, so starting it elsewhere is only qpos. A connect is
 * compiled as satisfied at the rest places, so each seam's starting anchor is
 * taken again from where its two points now are: the seam then closes from
 * the small gap it starts with, not from the width of the cutting table.
 */
export function applyClothStart(rt: ClothRuntime, mujoco: Mj, model: Model, data: Data): void {
  let moved = false;
  const qpos = data.qpos, bpos = model.body_pos, jadr = model.body_jntadr, jnum = model.body_jntnum;
  const qadr = model.jnt_qposadr, axis = model.jnt_axis;
  for (const f of rt.flexes) {
    if (!f.start) continue;
    moved = true;
    for (let v = 0; v < f.vnum; v++) {
      const b = f.bodies[v];
      const dx = f.start[3 * v] - bpos[3 * b], dy = f.start[3 * v + 1] - bpos[3 * b + 1], dz = f.start[3 * v + 2] - bpos[3 * b + 2];
      for (let j = jadr[b]; j < jadr[b] + jnum[b]; j++) qpos[qadr[j]] = dx * axis[3 * j] + dy * axis[3 * j + 1] + dz * axis[3 * j + 2];
    }
  }
  if (!moved) return;
  mujoco.mj_forward(model, data);
  const xpos = data.xpos, xmat = data.xmat, o1 = model.eq_obj1id, o2 = model.eq_obj2id, eqData = model.eq_data;
  for (const s of rt.sews) {
    const b1 = o1[s.eq], b2 = o2[s.eq];
    const d = [0, 1, 2].map((k) => xpos[3 * b1 + k] - xpos[3 * b2 + k]);
    // Into body2's frame: R^T d, xmat row-major.
    const from: [number, number, number] = [0, 1, 2].map((c) => d[0] * xmat[9 * b2 + c] + d[1] * xmat[9 * b2 + 3 + c] + d[2] * xmat[9 * b2 + 6 + c]) as [number, number, number];
    s.from = from;
    const o = rt.eqStride * s.eq + 3;
    eqData[o] = from[0]; eqData[o + 1] = from[1]; eqData[o + 2] = from[2];
  }
  mujoco.mj_forward(model, data);
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
