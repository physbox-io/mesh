// Spike: a real t-shirt pattern (front, back, two set-in sleeves, neckband),
// meshed, wrapped round an A-pose mannequin, sewn with connect constraints and
// draped. MuJoCo Z-up, metres; the wearer faces -Y. Pattern 'R'/'L' are
// world +x/-x (the wearer's left/right, as a pattern is drawn facing you).
//
// Pattern space is (u, v): u across the piece, v up it. Each piece's outline
// is a list of named segments; seams are chains of segments, paired by
// arc-length fraction so a longer edge is eased onto a shorter one (a sleeve
// cap into its armhole, the stretched neckband onto the neckline).

import Delaunator from 'delaunator';

// ---------- drafting ----------

/** Men's M knit tee. Finished sizes in metres, not body sizes. */
export const DEFAULT_SIZE = {
  halfChest: 0.255,     // quarter chest + ease is halfChest/2 per half piece: chest 1.02 m finished
  length: 0.68,         // HPS to hem
  neckHalf: 0.085,      // HPS distance from centre
  frontNeckDepth: 0.09,
  backNeckDepth: 0.02,
  shoulderX: 0.22,      // shoulder point from centre
  shoulderDrop: 0.035,
  armholeDepth: 0.24,   // HPS level to underarm
  sleeveLength: 0.20,   // underarm to hem
  sleeveHalfWidth: 0.18,
  sleeveHemHalf: 0.16,
  capEase: 0.0,         // knit tee: cap = armhole
  neckbandRatio: 0.85,  // band length / neckline length
  neckbandWidth: 0.03,
};

const bez = (p0, p1, p2, p3, n = 40) => {
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
};
const line = (a, b) => [a, b];
const polyLen = (pts) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
const mirror = (pts) => pts.map(([u, v]) => [-u, v]).reverse();

function bodice(S, neckDepth, scoop) {
  const W = S.halfChest, L = S.length, AH = S.armholeDepth;
  const sp = [S.shoulderX, -S.shoulderDrop], ua = [W, -AH], hps = [S.neckHalf, 0];
  // Armhole from underarm up to the shoulder point; `scoop` pulls it in (front scoops more).
  const armR = bez(ua, [W - scoop, -AH + 0.02], [sp[0] - 0.012, sp[1] - 0.09], sp);
  const neckR = bez(hps, [S.neckHalf, -neckDepth * 0.6], [S.neckHalf * 0.45, -neckDepth], [0, -neckDepth]);
  return [
    { id: 'hemR', pts: line([0, -L], [W, -L]) },
    { id: 'sideR', pts: line([W, -L], ua) },
    { id: 'armR', pts: armR },
    { id: 'shR', pts: line(sp, hps) },
    { id: 'neckR', pts: neckR },
    { id: 'neckL', pts: mirror(neckR) },
    { id: 'shL', pts: mirror(line(sp, hps)) },
    { id: 'armL', pts: mirror(armR) },
    { id: 'sideL', pts: mirror(line([W, -L], ua)) },
    { id: 'hemL', pts: mirror(line([0, -L], [W, -L])) },
  ];
}

function sleeve(S, capLen) {
  const SW = S.sleeveHalfWidth, SH = S.sleeveHemHalf, SL = S.sleeveLength;
  const capHalf = (ch) => bez([SW, 0], [SW * 0.55, ch * 0.15], [SW * 0.35, ch], [0, ch]);
  // Cap height solved so each half of the cap matches its half of the armhole.
  let lo = 0.01, hi = 0.3;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (polyLen(capHalf(mid)) < capLen) lo = mid; else hi = mid;
  }
  const half = capHalf((lo + hi) / 2);
  const cap = [...half, ...mirror(half).slice(1)];
  return {
    capHeight: (lo + hi) / 2,
    segs: [
      { id: 'hem', pts: line([-SH, -SL], [SH, -SL]) },
      { id: 'seamR', pts: line([SH, -SL], [SW, 0]) },
      { id: 'cap', pts: cap },
      { id: 'seamL', pts: line([-SW, 0], [-SH, -SL]) },
    ],
  };
}

export function draftTshirt(size = {}) {
  const S = { ...DEFAULT_SIZE, ...size };
  const front = bodice(S, S.frontNeckDepth, 0.03);
  const back = bodice(S, S.backNeckDepth, 0.018);
  const seg = (p, id) => p.find((s) => s.id === id).pts;
  const armFront = polyLen(seg(front, 'armR')), armBack = polyLen(seg(back, 'armR'));
  const sl = sleeve(S, ((armFront + armBack) / 2) * (1 + S.capEase));
  const neckline = 2 * (polyLen(seg(front, 'neckR')) + polyLen(seg(back, 'neckR')));
  const Lb = neckline * S.neckbandRatio, Wb = S.neckbandWidth;
  const band = [
    { id: 'bottom', pts: line([0, 0], [Lb, 0]) },
    { id: 'endR', pts: line([Lb, 0], [Lb, Wb]) },
    { id: 'top', pts: line([Lb, Wb], [0, Wb]) },
    { id: 'endL', pts: line([0, Wb], [0, 0]) },
  ];
  const pieces = [
    { name: 'front', segs: front },
    { name: 'back', segs: back },
    { name: 'sleeveR', segs: sl.segs },
    { name: 'sleeveL', segs: sl.segs },
    // Rib knit: far stretchier than the body jersey, which is what lets a short band pull the neckline flat.
    { name: 'band', segs: band, spacingScale: 0.5, youngScale: 0.1 },
  ];
  // Each side of a seam is a chain of [piece, segment, reversed], both running
  // the same way along the stitch line.
  const seams = [
    ['shoulderR', [['front', 'shR']], [['back', 'shR']]],
    ['shoulderL', [['front', 'shL']], [['back', 'shL']]],
    ['sideR', [['front', 'sideR']], [['back', 'sideR']]],
    ['sideL', [['front', 'sideL']], [['back', 'sideL']]],
    // Armhole runs front underarm -> shoulder point -> back underarm, as the cap does (u>0 is the front).
    ['armholeR', [['front', 'armR'], ['back', 'armR', true]], [['sleeveR', 'cap']]],
    ['armholeL', [['front', 'armL', true], ['back', 'armL']], [['sleeveL', 'cap']]],
    ['underarmR', [['sleeveR', 'seamR']], [['sleeveR', 'seamL', true]]],
    ['underarmL', [['sleeveL', 'seamR']], [['sleeveL', 'seamL', true]]],
    // Neckline from centre back via -x, the front, +x, back to centre back; the band's bottom edge runs the same way.
    ['neckline', [['back', 'neckL'], ['front', 'neckL', true], ['front', 'neckR', true], ['back', 'neckR']], [['band', 'bottom']]],
    ['bandEnds', [['band', 'endR']], [['band', 'endL', true]]],
  ];
  return { S, pieces, seams, capHeight: sl.capHeight, neckline, bandLength: Lb, armFront, armBack };
}

// ---------- meshing ----------

function resample(pts, step) {
  const L = polyLen(pts), n = Math.max(1, Math.round(L / step));
  const out = [];
  let seg = 0, acc = 0;
  for (let i = 0; i <= n; i++) {
    const target = (L * i) / n;
    while (seg < pts.length - 2 && acc + Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]) < target) {
      acc += Math.hypot(pts[seg + 1][0] - pts[seg][0], pts[seg + 1][1] - pts[seg][1]);
      seg++;
    }
    const a = pts[seg], b = pts[seg + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
    const t = Math.min(1, Math.max(0, (target - acc) / l));
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

const inside = (poly, [x, y]) => {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};
const distToPoly = (poly, [x, y]) => {
  let d = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
    d = Math.min(d, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return d;
};

/** Boundary sampled at `step`, interior a triangular lattice, Delaunay, clipped to the outline. */
export function meshPiece(piece, step) {
  const pts = [], segVerts = {};
  for (const s of piece.segs) {
    const r = resample(s.pts, step);
    const ids = [];
    for (let i = 0; i < r.length; i++) {
      if (i === r.length - 1) { ids.push(null); continue; } // the next segment's first point
      ids.push(pts.length);
      pts.push(r[i]);
    }
    segVerts[s.id] = ids;
  }
  // Close each segment onto the next one's start.
  const ids = piece.segs.map((s) => segVerts[s.id]);
  for (let k = 0; k < ids.length; k++) ids[k][ids[k].length - 1] = ids[(k + 1) % ids.length][0];
  const outline = pts.slice();
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const [u, v] of outline) { minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v); }
  const dv = step * Math.sqrt(3) / 2;
  for (let row = 0, v = minV + dv / 2; v < maxV; v += dv, row++) {
    for (let u = minU + (row % 2 ? step / 2 : 0); u < maxU; u += step) {
      const p = [u, v];
      if (inside(outline, p) && distToPoly(outline, p) > step * 0.55) pts.push(p);
    }
  }
  const del = Delaunator.from(pts);
  const tris = [];
  for (let t = 0; t < del.triangles.length; t += 3) {
    const a = del.triangles[t], b = del.triangles[t + 1], c = del.triangles[t + 2];
    const cx = (pts[a][0] + pts[b][0] + pts[c][0]) / 3, cy = (pts[a][1] + pts[b][1] + pts[c][1]) / 3;
    if (!inside(outline, [cx, cy])) continue;
    // Three collinear points along a straight edge make a zero-area sliver,
    // and a flex element with no area has no defined stiffness.
    const area = Math.abs((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1])) / 2;
    if (area < 0.05 * step * step) continue;
    tris.push(a, b, c);
  }
  return { pts, tris, segVerts };
}

// ---------- placement on the mannequin ----------

export const MANNEQUIN = {
  hpsZ: 1.565,
  panelGap: 0.2,
  shoulder: [0.21, 0, 1.47],
  armDir: [Math.SQRT1_2, 0, -Math.SQRT1_2], // A-pose, 45 degrees down
  armRadius: 0.045,
  armLength: 0.42,
  sleeveStart: 0.15, // distance along the arm of the sleeve's underarm line
  neckZ: 1.565,
};

function placer(name, draft) {
  const M = MANNEQUIN, S = draft.S;
  if (name === 'front') return ([u, v]) => [u, -M.panelGap, M.hpsZ + v];
  if (name === 'back') return ([u, v]) => [u, M.panelGap, M.hpsZ + v];
  if (name === 'band') {
    const R = draft.bandLength / (2 * Math.PI);
    // u = 0 at centre back, running first towards -x.
    return ([u, v]) => { const f = u / R; return [-R * Math.sin(f), R * Math.cos(f), M.neckZ + v]; };
  }
  // Sleeves: rolled into a tube round the arm, the underarm seam underneath, u > 0 to the front.
  // Pattern 'R' is world +x, so the right sleeve goes on the +x arm, next to the armR armholes.
  const side = name === 'sleeveR' ? 1 : -1;
  const d = [side * M.armDir[0], 0, M.armDir[2]];
  const up = [side * Math.SQRT1_2, 0, Math.SQRT1_2];
  const o = [side * M.shoulder[0], M.shoulder[1], M.shoulder[2]];
  const R = S.sleeveHalfWidth / Math.PI;
  return ([u, v]) => {
    const s = M.sleeveStart - v, th = u / R;
    return [0, 1, 2].map((k) => o[k] + s * d[k] + R * (Math.cos(th) * up[k] - (k === 1 ? Math.sin(th) : 0)));
  };
}

// ---------- MJCF + sewing ----------

export function buildTshirt({
  spacing = 0.03,
  young = 1e6,
  timestep = 0.004,
  iterations = 20,
  tolerance = 1e-5,
  seamSolref = 0.008,
  selfcollide = 'none',
  size = {},
  only = null, // debugging: build just these pieces, and the seams between them
} = {}) {
  const draft = draftTshirt(size);
  const M = MANNEQUIN;
  const colors = { front: '0.23 0.48 0.83 1', back: '0.17 0.38 0.68 1', sleeveR: '0.3 0.55 0.88 1', sleeveL: '0.3 0.55 0.88 1', band: '0.9 0.9 0.92 1' };
  const meshes = {};
  if (only) {
    draft.pieces = draft.pieces.filter((p) => only.includes(p.name));
    draft.seams = draft.seams.filter(([, A, B]) => [...A, ...B].every(([piece]) => only.includes(piece)));
  }
  const flexes = draft.pieces.map((p) => {
    const m = meshPiece(p, spacing * (p.spacingScale ?? 1));
    const place = placer(p.name, draft);
    m.world = m.pts.map(place);
    meshes[p.name] = m;
    return { p, m };
  });
  // 160 g/m^2 jersey.
  for (const f of flexes) {
    let area = 0;
    const P = f.m.pts, T = f.m.tris;
    for (let t = 0; t < T.length; t += 3) {
      const [a, b, c] = [P[T[t]], P[T[t + 1]], P[T[t + 2]]];
      area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1])) / 2;
    }
    f.area = area;
    f.mass = Math.max(0.002, 0.16 * area);
  }
  const flexXml = flexes.map(({ p, m, mass }) => `
    <flexcomp name="${p.name}" type="direct" dim="2" radius="0.004" mass="${mass.toFixed(4)}" rgba="${colors[p.name]}"
      point="${m.world.map((q) => q.map((x) => x.toFixed(5)).join(' ')).join('  ')}"
      element="${m.tris.join(' ')}">
      <edge damping="0.002"/>
      <elasticity young="${young * (p.youngScale ?? 1)}" poisson="0.2" thickness="0.002" damping="0.001" elastic2d="both"/>
      <contact contype="2" conaffinity="1" condim="3" friction="0.6" solref="0.005 1" selfcollide="${selfcollide}" margin="0.003"/>
    </flexcomp>`).join('');
  const sh = M.shoulder, ad = M.armDir, aEnd = (side) => [side * (sh[0] + M.armLength * ad[0]), 0, sh[2] + M.armLength * ad[2]];
  const xml = `
<mujoco model="tshirt-spike">
  <default><geom contype="1" conaffinity="2" rgba="0.85 0.7 0.6 1"/></default>
  <option timestep="${timestep}" integrator="discrete" solver="CG" jacobian="sparse" iterations="${iterations}" tolerance="${tolerance}"/>
  <size memory="400M"/>
  <worldbody>
    <light pos="0 -1 3" dir="0 0.3 -1"/>
    <geom name="floor" type="plane" size="2 2 0.1" rgba="0.8 0.8 0.8 1"/>
    <geom name="chest" type="ellipsoid" pos="0 0 1.25" size="0.17 0.12 0.26"/>
    <geom name="hips" type="ellipsoid" pos="0 0 0.98" size="0.17 0.12 0.13"/>
    <geom name="shoulders" type="capsule" fromto="-0.19 0 1.49 0.19 0 1.49" size="0.055"/>
    <geom name="neck" type="capsule" fromto="0 0 1.49 0 0 1.64" size="0.05"/>
    <geom name="head" type="sphere" pos="0 0 1.75" size="0.1"/>
    <geom name="armR" type="capsule" fromto="${-sh[0]} 0 ${sh[2]} ${aEnd(-1).join(' ')}" size="${M.armRadius}"/>
    <geom name="armL" type="capsule" fromto="${sh[0]} 0 ${sh[2]} ${aEnd(1).join(' ')}" size="${M.armRadius}"/>
    ${flexXml}
  </worldbody>
  __EQUALITY__
</mujoco>`;
  return { xml, draft, meshes };
}

/** Vertex chain for one seam side: global piece vertex ids with arc-length fractions. */
function chain(spec, meshes) {
  const out = [];
  for (const [piece, seg, rev] of spec) {
    let ids = meshes[piece].segVerts[seg].slice();
    if (rev) ids.reverse();
    for (const id of out.length ? ids.slice(1) : ids) out.push({ piece, id });
  }
  // Fractions measured flat in the pattern, so easing follows the cut lengths.
  let f = 0;
  const flat = (q) => meshes[q.piece].pts[q.id];
  out.forEach((q, i) => { if (i) f += Math.hypot(flat(q)[0] - flat(out[i - 1])[0], flat(q)[1] - flat(out[i - 1])[1]); q.f = f; });
  out.forEach((q) => { q.t = f ? q.f / f : 0; });
  return out;
}

export function compileTshirt(mujoco, opts = {}) {
  const built = buildTshirt(opts);
  const { meshes, draft } = built;
  const probe = mujoco.MjModel.from_xml_string(built.xml.replace('__EQUALITY__', ''));
  // Vertex bodies are expected as <piece>_<i> in point order; check that against positions.
  const pd = new mujoco.MjData(probe);
  mujoco.mj_forward(probe, pd);
  for (const [name, m] of Object.entries(meshes)) {
    for (const i of [0, m.world.length - 1]) {
      const b = mujoco.mj_name2id(probe, 1, `${name}_${i}`);
      if (b < 0) throw new Error(`no body ${name}_${i}`);
      const err = Math.hypot(...[0, 1, 2].map((k) => pd.xpos[3 * b + k] - m.world[i][k]));
      if (err > 1e-4) throw new Error(`body ${name}_${i} is not point ${i} (${err})`);
    }
  }
  pd.delete(); probe.delete();

  const pairs = [];
  for (const [seamName, A, B] of draft.seams) {
    const a = chain(A, meshes), b = chain(B, meshes);
    const [long, short, swap] = a.length >= b.length ? [a, b, false] : [b, a, true];
    for (const q of long) {
      let best = short[0];
      for (const r of short) if (Math.abs(r.t - q.t) < Math.abs(best.t - q.t)) best = r;
      const [x, y] = swap ? [best, q] : [q, best];
      if (x.piece === y.piece && x.id === y.id) continue;
      pairs.push({ seam: seamName, a: `${x.piece}_${x.id}`, b: `${y.piece}_${y.id}` });
    }
  }
  const eq = `<equality>${pairs.map((p) => `<connect body1="${p.a}" body2="${p.b}" anchor="0 0 0" solref="${opts.seamSolref ?? 0.008} 1"/>`).join('')}</equality>`;
  const model = mujoco.MjModel.from_xml_string(built.xml.replace('__EQUALITY__', eq));
  const data = new mujoco.MjData(model);
  mujoco.mj_forward(model, data);
  const stride = model.eq_data.length / model.neq; // mjNEQDATA: 11 before 3.17, 12 after
  const initial = new Float64Array(pairs.length * 3);
  { const e = model.eq_data; for (let i = 0; i < pairs.length; i++) for (let k = 0; k < 3; k++) initial[3 * i + k] = e[stride * i + 3 + k]; }
  const ids = pairs.map((p) => [mujoco.mj_name2id(model, 1, p.a), mujoco.mj_name2id(model, 1, p.b)]);
  const seamGap = (all = false) => {
    const xp = data.xpos, gaps = [], bySeam = {};
    for (let i = 0; i < pairs.length; i++) {
      const [ia, ib] = ids[i];
      const d = Math.hypot(xp[3 * ia] - xp[3 * ib], xp[3 * ia + 1] - xp[3 * ib + 1], xp[3 * ia + 2] - xp[3 * ib + 2]);
      gaps.push(d);
      const s = pairs[i].seam;
      bySeam[s] = Math.max(bySeam[s] ?? 0, d);
    }
    const max = Math.max(...gaps);
    if (!all) return max;
    gaps.sort((p, q) => p - q);
    return { max, median: gaps[gaps.length >> 1], min: gaps[0], bySeam };
  };
  // Sewn weightless, as garment CAD does: falling for the time the seams take
  // to close would drop the pieces off the mannequin before they meet.
  const setSew = (t) => {
    const s = 1 - Math.min(1, Math.max(0, t));
    model.opt.gravity[2] = s > 0 ? 0 : -9.81;
    const e = model.eq_data;
    for (let i = 0; i < pairs.length; i++) for (let k = 0; k < 3; k++) e[stride * i + 3 + k] = initial[3 * i + k] * s;
  };
  let nvert = 0;
  for (const m of Object.values(meshes)) nvert += m.pts.length;
  return { model, data, pairs, draft, meshes, seamGap, setSew, nvert };
}
