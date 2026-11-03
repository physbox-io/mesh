/**
 * Garments drafted for a body form (bodyForm.ts): flat pattern pieces, placed
 * round the form and sewn as a real one is. Each garment is only a ClothSpec
 * built from the form's measurements — pieces, seams, placement — so it
 * simulates like any other cloth, and it is redrafted when the form changes.
 *
 * Pattern space is (u, v): u across the piece, v up it, metres. A bodice's
 * v = 0 is the high point of the shoulder (HPS); 'R' edges are at +u, which
 * is world +x, the wearer's left (patterns are drawn facing you).
 */

import type { BodyFormMeasurements, ClothEdge, ClothPiece, ClothSeam, ClothSpec, GarmentDraft, GarmentKind, SeamSide, UV } from '../../types/cloth';
import { bodyFormProfile, bodyLandmarks } from './bodyForm';
import { polyLen } from './clothMesh';

const bez = (p0: UV, p1: UV, p2: UV, p3: UV, n = 24): UV[] => {
  const out: UV[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, a = (1 - t) ** 3, b = 3 * (1 - t) ** 2 * t, c = 3 * (1 - t) * t * t, d = t ** 3;
    out.push([a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]);
  }
  return out;
};
/** A smooth curve through `pts` (Catmull-Rom), `n` points per span: a side seam, not a polyline with corners. */
function spline(pts: UV[], n = 10): UV[] {
  if (pts.length < 3) return pts.slice();
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const out: UV[] = [];
  for (let i = 1; i < P.length - 2; i++) {
    const [p0, p1, p2, p3] = [P[i - 1], P[i], P[i + 1], P[i + 2]];
    for (let j = 0; j < n; j++) {
      const t = j / n, t2 = t * t, t3 = t2 * t;
      out.push([0, 1].map((k) => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)) as UV);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

/** The point at height v on a polyline running upward (v increasing). */
function atHeight(curve: UV[], v: number): UV {
  for (let i = 1; i < curve.length; i++) {
    const a = curve[i - 1], b = curve[i];
    if ((v >= a[1] && v <= b[1]) || (v <= a[1] && v >= b[1])) {
      const t = (v - a[1]) / (b[1] - a[1] || 1);
      return [a[0] + (b[0] - a[0]) * t, v];
    }
  }
  return v < curve[0][1] ? curve[0] : curve[curve.length - 1];
}

/**
 * A flared hem, curved up toward the side so it meets the side seam square,
 * as a flared skirt is cut (straight across, its corners would hang as points).
 * Returns the hem from the centre out, and where the side seam now starts.
 */
function curvedHem(hemHalf: number, hemV: number, above: UV): { hem: UV[]; corner: UV } {
  const tanPhi = Math.max(0, (hemHalf - above[0]) / (above[1] - hemV || 1));
  const rise = (tanPhi * hemHalf) / 2;
  const hem: UV[] = [];
  for (let i = 0; i <= 8; i++) { const u = (hemHalf * i) / 8; hem.push([u, hemV + rise * (u / hemHalf) ** 2]); }
  return { hem, corner: hem[hem.length - 1] };
}

const mirror = (pts: UV[]): UV[] => pts.map(([u, v]) => [-u, v] as UV).reverse();
const edgePts = (edges: ClothEdge[], id: string) => edges.find((e) => e.id === id)!.pts;

export const GARMENT_DEFAULTS: Record<GarmentKind, Required<Omit<GarmentDraft, 'garment' | 'fitTo'>>> = {
  tshirt: { ease: 0.1, length: 0, flare: 1, sleeve: 0.2, material: 'jersey', rgba: [0.23, 0.48, 0.83, 1] },
  dress: { ease: 0.06, length: 0.55, flare: 1.5, sleeve: 0, material: 'woven', rgba: [0.75, 0.22, 0.3, 1] },
  skirt: { ease: 0.04, length: 0.5, flare: 1.6, sleeve: 0, material: 'woven', rgba: [0.2, 0.25, 0.35, 1] },
};

interface Side { hemHalf: number; points: UV[] }

/**
 * Front or back bodice. `side` is the side seam from the hem up to (not
 * including) the underarm; `scoop` how far the armhole curves in.
 */
/**
 * A side bust dart: a wedge cut into the side seam at height `v`, `intake`
 * wide, pointing to `short` before the bust point `apex`, its point on the
 * line that halves its mouth so its two legs are the same length. Sewing its two legs together shapes the flat piece
 * over the bust, as a woven bodice needs: without one, a close-fitting dress
 * stood under tension and pulled its side seams 7-11 mm open. A piece with a
 * dart has extra edges, dartLow/dartUp; one with only `notchV` (the back) has
 * its side seam split there too, so the two side seams are sewn notch to notch.
 */
interface SideDart { v: number; intake: number; apex: UV; short: number }

function bodice(o: { W: number; AH: number; neckHalf: number; neckDepth: number; shoulderX: number; shoulderDrop: number; scoop: number; side: Side; dart?: SideDart; notchV?: number }): ClothEdge[] {
  const { W, AH, side } = o;
  const sp: UV = [o.shoulderX, -o.shoulderDrop], ua: UV = [W, -AH], hps: UV = [o.neckHalf, 0];
  // A flared hem curves up to the side; the side seam is a smooth curve from
  // there through the hip and waist to the underarm.
  const flared = side.points.length > 1 && side.points[0][0] > side.points[1][0] + 1e-6;
  const { hem: hemCurve, corner } = flared
    ? curvedHem(side.points[0][0], side.points[0][1], side.points[1])
    : { hem: [[0, side.points[0][1]], side.points[0]] as UV[], corner: side.points[0] };
  const sideR: UV[] = spline([corner, ...side.points.slice(1), ua]);
  const onSide = (v: number): UV => atHeight(sideR, v);
  const below = (p: UV) => [...sideR.filter((q) => q[1] < p[1] - 1e-6), p];
  const aboveP = (p: UV) => [p, ...sideR.filter((q) => q[1] > p[1] + 1e-6)];
  const armR = bez(ua, [W - o.scoop, -AH + 0.02], [sp[0] - 0.012, sp[1] - 0.09], sp);
  const neckR = bez(hps, [o.neckHalf, -o.neckDepth * 0.6], [o.neckHalf * 0.45, -o.neckDepth], [0, -o.neckDepth]);
  const hemR: UV[] = hemCurve;
  let sideEdgesR: ClothEdge[] = [{ id: 'sideR', pts: sideR }];
  if (o.dart) {
    const l1 = onSide(o.dart.v - o.dart.intake / 2), l2 = onSide(o.dart.v + o.dart.intake / 2);
    // The point on the line square to the mouth through its middle, `short`
    // before the bust point: both legs the same length.
    const mid: UV = [(l1[0] + l2[0]) / 2, (l1[1] + l2[1]) / 2];
    const cu = l2[0] - l1[0], cv = l2[1] - l1[1], cl = Math.hypot(cu, cv) || 1;
    const inward: UV = [-cv / cl, cu / cl];
    const len = Math.max(0.03, Math.hypot(o.dart.apex[0] - mid[0], o.dart.apex[1] - mid[1]) - o.dart.short);
    const tip: UV = [mid[0] + inward[0] * len, mid[1] + inward[1] * len];
    sideEdgesR = [
      { id: 'sideR', pts: below(l1) },
      { id: 'dartLowR', pts: [l1, tip] },
      { id: 'dartUpR', pts: [tip, l2] },
      { id: 'sideUpR', pts: aboveP(l2) },
    ];
  } else if (o.notchV !== undefined) {
    const n = onSide(o.notchV);
    sideEdgesR = [{ id: 'sideR', pts: below(n) }, { id: 'sideUpR', pts: aboveP(n) }];
  }
  const sideEdgesL = sideEdgesR.slice().reverse().map((e) => ({ id: e.id.replace(/R$/, 'L'), pts: mirror(e.pts) }));
  return [
    { id: 'hemR', pts: hemR },
    ...sideEdgesR,
    { id: 'armR', pts: armR },
    { id: 'shR', pts: [sp, hps] },
    { id: 'neckR', pts: neckR },
    { id: 'neckL', pts: mirror(neckR) },
    { id: 'shL', pts: mirror([sp, hps]) },
    { id: 'armL', pts: mirror(armR) },
    ...sideEdgesL,
    { id: 'hemL', pts: mirror(hemR) },
  ];
}

/** A polyline cut in two at `frac` of its length; the cut point ends the first and starts the second. */
function splitAt(pts: UV[], frac: number): [UV[], UV[]] {
  const target = polyLen(pts) * frac;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + l >= target) {
      const t = l ? (target - acc) / l : 0;
      const p: UV = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      return [[...pts.slice(0, i), p], [p, ...pts.slice(i)]];
    }
    acc += l;
  }
  return [pts, [pts[pts.length - 1], pts[pts.length - 1]]];
}

/**
 * A set-in sleeve whose cap is exactly as long as the armhole it goes into,
 * notched where the shoulder seam meets it: `frontShare` of the cap's length
 * from its front end, the front armhole's share of the whole armhole. The
 * cap's two edges, capF and capB, sew to the front and back armholes each.
 */
function sleeve(halfWidth: number, length: number, capLen: number, frontShare: number) {
  const SW = halfWidth, SH = halfWidth * 0.9, SL = length;
  const capHalf = (ch: number) => bez([SW, 0], [SW * 0.55, ch * 0.15], [SW * 0.35, ch], [0, ch]);
  let lo = 0.005, hi = 0.4;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    if (polyLen(capHalf(mid)) < capLen) lo = mid; else hi = mid;
  }
  const half = capHalf((lo + hi) / 2);
  const edges: ClothEdge[] = [
    { id: 'hem', pts: [[-SH, -SL], [SH, -SL]] },
    { id: 'seamR', pts: [[SH, -SL], [SW, 0]] },
    ...splitAt([...half, ...mirror(half).slice(1)], frontShare).map((pts, k) => ({ id: k ? 'capB' : 'capF', pts })),
    { id: 'seamL', pts: [[-SW, 0], [-SH, -SL]] },
  ];
  return { edges, capHeight: (lo + hi) / 2 };
}

/** The cloth for a garment drafted to fit `form`. In the form's own frame. */
export function draftGarment(draft: GarmentDraft, form: BodyFormMeasurements): ClothSpec {
  const kind = draft.garment;
  const d = { ...GARMENT_DEFAULTS[kind], ...Object.fromEntries(Object.entries(draft).filter(([, v]) => v !== undefined)) } as Required<GarmentDraft>;
  const L = bodyLandmarks(form);
  const s = form.height / 1.75;
  const ease = d.ease;
  const pieces: ClothPiece[] = [];
  const seams: ClothSeam[] = [];
  const sew = (name: string, a: ClothSeam['a'], b: ClothSeam['b']) => seams.push({ name, a, b });
  const rgba = d.rgba;
  const gap = Math.max(L.chestDepth, L.hipDepth) + 0.06;
  // Each piece is cut flat (its rest shape) and starts wrapped round the
  // form, row by row at its true width, its side seams already together.
  const flat = (y: number, z: number) => ({ kind: 'plane' as const, origin: [0, y, z], uAxis: [1, 0, 0], vAxis: [0, 0, 1] });
  const START_GAP = 0.012 * s;
  const round = (facing: 'front' | 'back', zTop: number, zBottom: number) => ({
    kind: 'girth' as const, origin: [0, 0, zTop], facing, gap: START_GAP,
    profile: bodyFormProfile(form, zBottom - 0.04, zTop + 0.04, zTop),
  });

  if (kind === 'skirt') {
    const Ww = (form.waist + ease) / 4, Wh = (form.hip + ease) / 4;
    const toHip = L.waistZ - L.hipZ, len = Math.max(toHip + 0.05, d.length);
    const hemHalf = Wh * d.flare;
    const { hem: hemR, corner } = curvedHem(hemHalf, -len, [Wh, -toHip]);
    const sideR: UV[] = spline([corner, [Wh, -toHip], [Ww, 0]]);
    const edges: ClothEdge[] = [
      { id: 'hem', pts: [...mirror(hemR), ...hemR.slice(1)] },
      { id: 'sideR', pts: sideR },
      { id: 'waist', pts: [[Ww, 0], [-Ww, 0]] },
      { id: 'sideL', pts: mirror(sideR) },
    ];
    pieces.push({ name: 'front', edges, placement: flat(-gap, L.waistZ), start: round('front', L.waistZ, L.waistZ - len), rgba });
    pieces.push({ name: 'back', edges, placement: flat(gap, L.waistZ), start: round('back', L.waistZ, L.waistZ - len), rgba: shade(rgba) });
    sew('sideR', [{ piece: 'front', edge: 'sideR' }], [{ piece: 'back', edge: 'sideR' }]);
    sew('sideL', [{ piece: 'front', edge: 'sideL' }], [{ piece: 'back', edge: 'sideL' }]);
    return { pieces, seams, material: d.material, spacing: 0.04, sewTime: GARMENT_SEW_TIME, draft: { ...draft } };
  }

  // Bodice: a t-shirt is boxy, a dress fitted at the waist and flared below the hip.
  const W = (form.chest + ease) / 4;
  const AH = L.hpsZ - 0.735 * form.height + 0.07 * s;
  const at = (z: number) => -(L.hpsZ - z);
  let side: Side;
  if (kind === 'tshirt') {
    const hemV = at(L.hipZ - 0.04 * s);
    side = { hemHalf: W, points: [[W, hemV]] };
  } else {
    const Ww = Math.min(W, (form.waist + ease) / 4), Wh = (form.hip + ease) / 4;
    const hemV = at(L.waistZ - Math.max(L.waistZ - L.hipZ + 0.05, d.length));
    const hemHalf = Math.max(Wh, Wh * d.flare);
    side = { hemHalf, points: [[hemHalf, hemV], [Wh, at(L.hipZ)], [Ww, at(L.waistZ)]] };
  }
  const common = {
    W, AH, side,
    neckHalf: L.neckRadius + 0.012 * s,
    shoulderX: form.shoulderWidth / 2 + 0.01 * s,
    // The form's own slope, so the shoulder seam lies along its shoulder.
    shoulderDrop: L.shoulderDrop,
  };
  // A dress is woven and close fitting, so over a bust its front has side
  // bust darts, 5 cm below the underarm and pointing to 3 cm short of the bust
  // point, taking in about as much as the bust stands out. A t-shirt is knit
  // and loose, and has none.
  let dart: SideDart | undefined;
  if (kind === 'dress' && L.bustProminence > 0.01) {
    const v = -AH - 0.05 * s, apex: UV = [L.bustPoint[0], at(L.bustZ)];
    const intake = Math.min(0.05, Math.max(0.012, 0.7 * L.bustProminence));
    dart = { v, intake, apex, short: 0.03 * s };
  }
  const front = bodice({ ...common, neckDepth: (kind === 'dress' ? 0.13 : 0.09) * s, scoop: 0.03 * s, dart });
  const back = bodice({ ...common, neckDepth: 0.02 * s, scoop: 0.018 * s, notchV: dart ? dart.v - dart.intake / 2 : undefined });
  const hemZ = L.hpsZ + side.points[0][1];
  pieces.push({ name: 'front', edges: front, placement: flat(-gap, L.hpsZ), start: round('front', L.hpsZ, hemZ), rgba });
  pieces.push({ name: 'back', edges: back, placement: flat(gap, L.hpsZ), start: round('back', L.hpsZ, hemZ), rgba: shade(rgba) });
  sew('shoulderR', [{ piece: 'front', edge: 'shR' }], [{ piece: 'back', edge: 'shR' }]);
  sew('shoulderL', [{ piece: 'front', edge: 'shL' }], [{ piece: 'back', edge: 'shL' }]);
  if (dart) {
    // Side seams notch to notch, below the dart and above it; then the darts.
    sew('sideR', [{ piece: 'front', edge: 'sideR' }, { piece: 'front', edge: 'sideUpR' }], [{ piece: 'back', edge: 'sideR' }, { piece: 'back', edge: 'sideUpR' }]);
    sew('sideL', [{ piece: 'front', edge: 'sideUpL' }, { piece: 'front', edge: 'sideL' }], [{ piece: 'back', edge: 'sideUpL' }, { piece: 'back', edge: 'sideL' }]);
    sew('dartR', [{ piece: 'front', edge: 'dartLowR' }], [{ piece: 'front', edge: 'dartUpR', reversed: true }]);
    sew('dartL', [{ piece: 'front', edge: 'dartLowL' }], [{ piece: 'front', edge: 'dartUpL', reversed: true }]);
  } else {
    sew('sideR', [{ piece: 'front', edge: 'sideR' }], [{ piece: 'back', edge: 'sideR' }]);
    sew('sideL', [{ piece: 'front', edge: 'sideL' }], [{ piece: 'back', edge: 'sideL' }]);
  }

  if (d.sleeve > 0.03) {
    const armFront = polyLen(edgePts(front, 'armR')), armBack = polyLen(edgePts(back, 'armR'));
    const armhole = (armFront + armBack) / 2;
    const half = Math.max(0.15 * s, (form.upperArm + 0.12) / 2);
    const sl = sleeve(half, d.sleeve, armhole, armFront / (armFront + armBack));
    const R = half / Math.PI;
    for (const sideSign of [1, -1]) {
      const name = sideSign > 0 ? 'sleeveR' : 'sleeveL';
      const dir = [sideSign * L.armDir[0], 0, L.armDir[2]];
      // Square to the arm and upward: the top of the cap (u = 0) sits on top of the arm.
      const up = [sideSign * -L.armDir[2], 0, L.armDir[0]];
      // Rolled round the arm with the top of the cap at the shoulder point.
      const o = [sideSign * L.shoulderPoint[0] + sl.capHeight * dir[0], 0, L.shoulderPoint[2] + sl.capHeight * dir[2]];
      // Front of the sleeve (u > 0) toward -y on both arms, so it meets the front armhole.
      pieces.push({
        name, edges: sl.edges, rgba,
        placement: { kind: 'plane', origin: [sideSign * 0.8 * s, 0, L.hpsZ], uAxis: [0, 1, 0], vAxis: [0, 0, 1] },
        start: { kind: 'wrap', origin: o, axis: dir.map((x) => -x), ref: up, radius: R, clockwise: sideSign > 0 },
      });
      const tag = sideSign > 0 ? 'R' : 'L';
      // The armhole runs front underarm -> shoulder point -> back underarm, as the cap does.
      sew(`armhole${tag}`,
        sideSign > 0
          ? [{ piece: 'front', edge: 'armR' }, { piece: 'back', edge: 'armR', reversed: true }]
          : [{ piece: 'front', edge: 'armL', reversed: true }, { piece: 'back', edge: 'armL' }],
        [{ piece: name, edge: 'capF' }, { piece: name, edge: 'capB' }]);
      sew(`underarm${tag}`, [{ piece: name, edge: 'seamR' }], [{ piece: name, edge: 'seamL', reversed: true }]);
    }
  }

  if (kind === 'tshirt') {
    // A neckband cut short of the neckline, so it pulls the neck in flat,
    // notched where the neckline's four edges meet (the shoulder seams and the
    // centre front) so those land where they should round the band.
    const neckPath: SeamSide = [{ piece: 'back', edge: 'neckL' }, { piece: 'front', edge: 'neckL', reversed: true }, { piece: 'front', edge: 'neckR', reversed: true }, { piece: 'back', edge: 'neckR' }];
    const neckEdges = [polyLen(edgePts(back, 'neckL')), polyLen(edgePts(front, 'neckL')), polyLen(edgePts(front, 'neckR')), polyLen(edgePts(back, 'neckR'))];
    const neckline = neckEdges.reduce((x, y) => x + y, 0);
    const Lb = neckline * 0.9, Wb = 0.03 * s;
    const ids = ['bottomBL', 'bottomFL', 'bottomFR', 'bottomBR'];
    let u = 0;
    const bottom: ClothEdge[] = neckEdges.map((len, k) => {
      const u1 = k === 3 ? Lb : u + (len / neckline) * Lb;
      const e: ClothEdge = { id: ids[k], pts: [[u, 0], [u1, 0]] };
      u = u1;
      return e;
    });
    pieces.push({
      // Half the shirt's mesh spacing: 3 cm wide on the shirt's 4 cm mesh it
      // would be one row of slivers.
      name: 'band', rgba: [0.92, 0.92, 0.94, 1], spacingScale: 0.5,
      edges: [
        ...bottom,
        { id: 'endR', pts: [[Lb, 0], [Lb, Wb]] },
        { id: 'top', pts: [[Lb, Wb], [0, Wb]] },
        { id: 'endL', pts: [[0, Wb], [0, 0]] },
      ],
      placement: { kind: 'plane', origin: [-Lb / 2, 0.6 * s, L.hpsZ + 0.1], uAxis: [1, 0, 0], vAxis: [0, 0, 1] },
      // Starts on the neckline it is sewn to, from the centre back round.
      start: { kind: 'along', path: neckPath, up: [0, 0, 1] },
    });
    sew('neckline', neckPath,
      ids.map((edge) => ({ piece: 'band', edge })));
    sew('bandEnds', [{ piece: 'band', edge: 'endR' }], [{ piece: 'band', edge: 'endL', reversed: true }]);
  }
  return { pieces, seams, material: d.material, spacing: 0.04, sewTime: GARMENT_SEW_TIME, draft: { ...draft } };
}

/**
 * Seconds to sew a garment that starts on the form: its seams start a
 * centimetre or two apart, not the width of the room.
 */
const GARMENT_SEW_TIME = 0.4;

/** The back a shade darker than the front, so the two read apart. */
function shade(rgba: number[]): number[] {
  return [rgba[0] * 0.85, rgba[1] * 0.85, rgba[2] * 0.85, rgba[3] ?? 1];
}
