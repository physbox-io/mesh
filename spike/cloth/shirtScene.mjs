// Spike: can MuJoCo's flex cloth sew and drape a shirt-sized garment fast
// enough to be useful in the browser? Shared by bench.mjs (node) and the
// viewer page. MuJoCo Z-up, metres; the wearer faces -Y.
//
// The "shirt" is two flat panels, front and back, hung either side of a
// capsule mannequin. Seams are equality `connect` constraints between pairs
// of flex vertex bodies. A connect is compiled as already satisfied, so the
// body2 anchor starts at the pair's current offset and is lerped to zero at
// runtime: that is the sewing.

export const BODY = {
  torso: { pos: [0, 0, 1.22], size: [0.16, 0.10, 0.27] },
  hips: { pos: [0, 0, 0.98], size: [0.17, 0.11, 0.12] },
  shoulderZ: 1.47,
  shoulderHalf: 0.19,
  armTo: [0.27, 0, 1.08],
};

export function buildShirtXml({
  spacing = 0.02,
  selfcollide = 'none',
  edgeEquality = false,
  young = 1e6,
  timestep = 0.004,
  clothCloth = false,
  iterations = 20,
  tolerance = 1e-5,
  elastic2d = "both",
  thickness = 0.002,
} = {}) {
  const W = 0.54, H = 0.70, gap = 0.17, top = 1.56;
  const nx = Math.round(W / spacing) + 1;
  const nz = Math.round(H / spacing) + 1;
  const cz = top - H / 2;
  const panel = (name, y) => `
    <flexcomp name="${name}" type="grid" dim="2" count="${nx} ${nz} 1"
      spacing="${spacing} ${spacing} ${spacing}" pos="0 ${y} ${cz}" euler="90 0 0"
      radius="0.004" mass="0.08" rgba="${name === 'front' ? '0.2 0.45 0.8 1' : '0.15 0.35 0.65 1'}">
      <edge equality="${edgeEquality}" damping="0.002"/>
      <elasticity young="${young}" poisson="0.2" thickness="${thickness}" damping="0.001" elastic2d="${elastic2d}"/>
      <contact contype="${clothCloth ? 3 : 2}" conaffinity="${clothCloth ? 3 : 1}" condim="3" friction="0.6" solref="0.005 1" selfcollide="${selfcollide}"
        margin="0.003"/>
    </flexcomp>`;
  const { torso, hips, shoulderZ, shoulderHalf, armTo } = BODY;
  const xml = `
<mujoco model="cloth-spike">
  <default><geom contype="1" conaffinity="2"/></default>
  <option timestep="${timestep}" integrator="discrete" solver="CG" jacobian="sparse" iterations="${iterations}" tolerance="${tolerance}" gravity="0 0 -9.81"/>
  <size memory="200M"/>
  <worldbody>
    <light pos="0 -1 3" dir="0 0.3 -1"/>
    <geom name="floor" type="plane" size="2 2 0.1" rgba="0.8 0.8 0.8 1"/>
    <geom name="torso" type="ellipsoid" pos="${torso.pos.join(' ')}" size="${torso.size.join(' ')}" rgba="0.85 0.7 0.6 1"/>
    <geom name="hips" type="ellipsoid" pos="${hips.pos.join(' ')}" size="${hips.size.join(' ')}" rgba="0.85 0.7 0.6 1"/>
    <geom name="shoulders" type="capsule" fromto="${-shoulderHalf} 0 ${shoulderZ} ${shoulderHalf} 0 ${shoulderZ}" size="0.055" rgba="0.85 0.7 0.6 1"/>
    <geom name="neck" type="capsule" fromto="0 0 ${shoulderZ} 0 0 1.62" size="0.05" rgba="0.85 0.7 0.6 1"/>
    <geom name="head" type="sphere" pos="0 0 1.73" size="0.1" rgba="0.85 0.7 0.6 1"/>
    <geom name="armL" type="capsule" fromto="${-shoulderHalf - 0.02} 0 ${shoulderZ} ${-armTo[0]} 0 ${armTo[2]}" size="0.045" rgba="0.85 0.7 0.6 1"/>
    <geom name="armR" type="capsule" fromto="${shoulderHalf + 0.02} 0 ${shoulderZ} ${armTo[0]} 0 ${armTo[2]}" size="0.045" rgba="0.85 0.7 0.6 1"/>
    ${panel('front', -gap)}
    ${panel('back', gap)}
  </worldbody>
  __EQUALITY__
</mujoco>`;
  return { xml, nx, nz, W, H, top, gap };
}

/**
 * Compiles once to find the vertex bodies by position, picks the seam pairs,
 * and recompiles with one connect per pair. Grid index order is not assumed:
 * vertices are classified by where MuJoCo put them.
 */
export function compileShirt(mujoco, opts = {}) {
  const spec = buildShirtXml(opts);
  const probe = mujoco.MjModel.from_xml_string(spec.xml.replace('__EQUALITY__', ''));
  const pd = new mujoco.MjData(probe);
  mujoco.mj_forward(probe, pd);
  const verts = { front: [], back: [] };
  const xpos = pd.xpos;
  for (let b = 1; b < probe.nbody; b++) {
    const name = mujoco.mj_id2name(probe, 1 /* mjOBJ_BODY */, b);
    const m = /^(front|back)_(\d+)$/.exec(name || '');
    if (!m) continue;
    verts[m[1]].push({ name, x: xpos[3 * b], z: xpos[3 * b + 2] });
  }
  pd.delete(); probe.delete();
  if (!verts.front.length) throw new Error('no flex vertex bodies named front_N; naming differs');

  const tol = opts.spacing ? opts.spacing * 0.3 : 0.006;
  const key = (v) => `${Math.round(v.x / tol)}:${Math.round(v.z / tol)}`;
  const backBy = new Map(verts.back.map((v) => [key(v), v]));
  const half = spec.W / 2, neckHalf = 0.09, armhole = 0.2;
  const pairs = [];
  for (const f of verts.front) {
    const onTop = Math.abs(f.z - spec.top) < tol;
    const onSide = Math.abs(Math.abs(f.x) - half) < tol;
    const shoulder = onTop && Math.abs(f.x) > neckHalf;
    const side = onSide && f.z < spec.top - armhole;
    if (!shoulder && !side) continue;
    const b = backBy.get(key(f));
    if (b) pairs.push([f.name, b.name, shoulder ? 'shoulder' : 'side']);
  }
  const eq = `<equality>${pairs
    .map(([a, b]) => `<connect body1="${a}" body2="${b}" anchor="0 0 0" solref="${opts.seamSolref ?? 0.008} 1"/>`)
    .join('')}</equality>`;
  const model = mujoco.MjModel.from_xml_string(spec.xml.replace('__EQUALITY__', eq));
  const data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);
  // Initial body2 anchors (body2 frame = translation only for a vertex body).
  const eqData = model.eq_data;
  const stride = eqData.length / model.neq; // mjNEQDATA: 11 before 3.17, 12 after
  const initial = new Float64Array(pairs.length * 3);
  for (let i = 0; i < pairs.length; i++) for (let k = 0; k < 3; k++) initial[3 * i + k] = eqData[stride * i + 3 + k];
  const seamGap = (all = false) => {
    let max = 0;
    const gaps = [];
    const xp = data.xpos;
    for (const [a, b] of pairs) {
      const ia = mujoco.mj_name2id(model, 1, a), ib = mujoco.mj_name2id(model, 1, b);
      const d = Math.hypot(xp[3 * ia] - xp[3 * ib], xp[3 * ia + 1] - xp[3 * ib + 1], xp[3 * ia + 2] - xp[3 * ib + 2]);
      gaps.push(d);
      if (d > max) max = d;
    }
    if (all) { gaps.sort((p, q) => p - q); return { max, median: gaps[gaps.length >> 1], min: gaps[0] }; }
    return max;
  };
  /** Sew: lerp each seam's anchor offset from its start to zero over `sewTime`. */
  // Sewn weightless, as garment CAD does: falling for the second the seams take
  // to close would drop the panels metres before they ever reach the shoulders.
  const setSew = (t) => {
    const s = 1 - Math.min(1, Math.max(0, t));
    const g = model.opt.gravity;
    g[2] = s > 0 ? 0 : -9.81;
    const e = model.eq_data;
    for (let i = 0; i < pairs.length; i++) for (let k = 0; k < 3; k++) e[stride * i + 3 + k] = initial[3 * i + k] * s;
  };
  return { model, data, pairs, spec, seamGap, setSew, nvert: verts.front.length + verts.back.length };
}
