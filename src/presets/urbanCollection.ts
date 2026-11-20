/**
 * An urban collection, two looks side by side, every part of it from the
 * general garment parts (no garment of its own kind):
 *
 * - A puffer jacket over knee-length shorts with a belt, a neckerchief under
 *   the jacket (undone at the neck, its point showing), a baseball cap. The puffer is a jacket quilted round with
 *   drawn seams (GarmentDraft.curves), its channels sculpted out between them
 *   (`sculpt`), in a ripstop shell; the neckerchief its own cloth tied round
 *   the neck; the cap a hat whose peak is a stiff crescent sewn round the
 *   front of its band (`attached` with `materialOverrides`).
 * - A hoodie over cut-off jeans, a handbag on the arm. The hood is a piece
 *   sewn on round the neckline, folded at the nape and seamed over the crown
 *   (`attached` with `joins`), pulled up over the head as it is worn
 *   (ClothSpec.arrange); its drawstrings two narrow strips; the pocket a patch
 *   across the front. The cut-offs are jeans cut off above the ankle, the hem
 *   ragged (`edges`). The bag is plain cloth: two leather faces and a gusset
 *   seamed round, a clasp, handles over the forearm.
 */

import type { SceneGraph, SceneNode } from '../types/scene';
import type { ClothFastening, ClothPiece, ClothSeam, GarmentCurve, GarmentSculpt, UV } from '../types/cloth';
import { garmentNode, lazyBodyFormNode as bodyFormNode } from '../utils/cloth/clothNodes';
import { bodyFormSection, bodyLandmarks } from '../utils/cloth/bodyForm';
import { formLimbs } from '../utils/cloth/formLimbs';
import type { BodyFormMeasurements } from '../types/cloth';

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** A bandana's paisley: boteh teardrops with curled tips, an inner drop and a ring of dots each, small flowers between, on red. */
const BANDANA_SVG = (() => {
  const boteh = (x: number, y: number, r: number, k: number) => [
    `<g transform="translate(${x} ${y}) rotate(${r}) scale(${k})">`,
    '<path d="M0 22C-13 22-18 8-12-2C-6-12 4-18 4-28C9-20 15-10 13 2C11 14 7 22 0 22Z" fill="#fbf6ec"/>',
    '<path d="M0 15C-7 15-10 7-7 1C-4-5 1-9 2-15C5-9 8-3 7 4C6 10 4 15 0 15Z" fill="#b0121b"/>',
    '<path d="M0 10C-3 10-4 6-2 3C-1 1 1-1 1-4C3-1 4 2 3 5C3 8 2 10 0 10Z" fill="#111"/>',
    ...Array.from({ length: 9 }, (_, n) => { const a = (n / 9) * 2 * Math.PI; return `<circle cx="${(Math.cos(a) * 17).toFixed(1)}" cy="${(Math.sin(a) * 25 - 2).toFixed(1)}" r="1.4" fill="#fbf6ec"/>`; }),
    '</g>',
  ].join('');
  const flower = (x: number, y: number) => `<g transform="translate(${x} ${y})" fill="#fbf6ec">${[0, 72, 144, 216, 288].map((a) => `<ellipse rx="1.6" ry="3.4" cy="-3.4" transform="rotate(${a})"/>`).join('')}<circle r="1.2" fill="#111"/></g>`;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
    '<rect width="100" height="100" fill="#b0121b"/>',
    boteh(28, 30, -20, 0.62), boteh(76, 74, 160, 0.62), boteh(78, 22, 70, 0.42), boteh(24, 80, 250, 0.42),
    flower(52, 50), flower(6, 52), flower(52, 4), flower(94, 96), flower(50, 96),
    '</svg>',
  ].join('');
})();

/** A garment worn as `layer` (0 next to the body). */
function wearing(id: string, draft: Parameters<typeof garmentNode>[2], form: SceneNode, layer: number): SceneNode {
  const node = garmentNode(id, id, draft, form);
  node.cloth!.layer = layer;
  return node;
}

/** A point round the body at height z, `out` off it, at angle a (0 at +x, toward +y). */
function round(m: BodyFormMeasurements, z: number, a: number, out: number): [number, number, number] {
  const q = bodyFormSection(m, z), n = q.radii.length;
  const k = ((a / (2 * Math.PI)) * n + n) % n, k0 = Math.floor(k), u = k - k0;
  const r = q.radii[k0 % n] * (1 - u) + q.radii[(k0 + 1) % n] * u + out;
  return [r4(Math.cos(a) * r), r4(q.centreY + Math.sin(a) * r), r4(z)];
}

/** A point round a limb, `along` its line, `out` off it, at angle a round it. */
function roundLimb(m: BodyFormMeasurements, limb: 'armL' | 'armR', along: number, a: number, out: number): [number, number, number] {
  const sec = formLimbs(m)[limb].section(along);
  const p = [0, 1, 2].map((k) => sec.c[k] + sec.side[k] * Math.cos(a) * (sec.w + out) + sec.up[k] * Math.sin(a) * (sec.h + out));
  return [r4(p[0]), r4(p[1]), r4(p[2])];
}

/**
 * A puffer's quilting: seams round the body at `zs`, and round each sleeve
 * at fractions along it; channels sculpted out between them by `puff`.
 */
function quilting(m: BodyFormMeasurements, zs: number[], sleeveRings: number[], out: number, puff: number): { curves: GarmentCurve[]; sculpt: GarmentSculpt[] } {
  const curves: GarmentCurve[] = [], sculpt: GarmentSculpt[] = [];
  const ring = (f: (a: number) => [number, number, number], n = 40) => Array.from({ length: n }, (_, k) => f((2 * Math.PI * k) / n));
  zs.forEach((z, i) => curves.push({ name: `quilt${i + 1}`, kind: 'seam', closed: true, points: ring((a) => round(m, z, a, out)) }));
  const arm = formLimbs(m).armL;
  sleeveRings.forEach((f, i) => curves.push({ name: `sleeveQuilt${i + 1}`, kind: 'seam', closed: true, mirror: true, points: ring((a) => roundLimb(m, 'armL', f * arm.length, a, out), 24) }));
  // Each channel's middle pushed out: dabs round it, on the left half (mirrored).
  for (let i = 0; i + 1 < zs.length; i++) {
    const z = (zs[i] + zs[i + 1]) / 2, half = (zs[i + 1] - zs[i]) / 2;
    for (let a = -Math.PI / 2; a <= Math.PI / 2 + 1e-9; a += Math.PI / 14) sculpt.push({ at: round(m, z, a, out), radius: r4(1.6 * half), amount: puff });
  }
  for (let i = 0; i + 1 < sleeveRings.length; i++) {
    const f = (sleeveRings[i] + sleeveRings[i + 1]) / 2, half = ((sleeveRings[i + 1] - sleeveRings[i]) * arm.length) / 2;
    for (let a = 0; a < 2 * Math.PI - 1e-9; a += Math.PI / 5) sculpt.push({ at: roundLimb(m, 'armL', f * arm.length, a, out), radius: r4(1.4 * half), amount: r4(puff * 0.45) });
  }
  return { curves, sculpt };
}

/** A puffer jacket over shorts, a neckerchief at the neck. */
function pufferLook(x: number): SceneNode[] {
  const form = bodyFormNode('formA', 'formA', { figure: 'male' }, [x, 0, 0]);
  const m = form.bodyForm!, L = bodyLandmarks(m);
  const quilt = quilting(m, [L.waistZ - 0.1, L.waistZ - 0.01, L.waistZ + 0.08, L.waistZ + 0.17, L.waistZ + 0.26, L.waistZ + 0.35], [0.3, 0.45, 0.6, 0.75, 0.9], 0.04, 0.02);
  const shorts = wearing('shorts', {
    // Ease 5 cm round the thigh: at 10 the two legs hung pressed together to near the hem, and slid 4 cm down on Run.
    garment: 'trousers', material: 'canvas', length: 0.4, flare: 1.12, ease: 0.05, rgba: [0.3, 0.33, 0.19, 1],
    pockets: [{ panel: 'front', at: [0.62, 0.86] }, { panel: 'back', at: [0.5, 0.8] }], beltLoops: 5,
    trims: [{ kind: 'stitch', along: 'hem', offset: [0.008, 0.014], rgba: [0.2, 0.22, 0.12, 1] }, { kind: 'stitch', along: 'side', offset: 0.004, rgba: [0.2, 0.22, 0.12, 1] }],
    belt: { width: 0.032, material: 'leather', rgba: [0.13, 0.08, 0.05, 1] },
  }, form, 0);
  const puffer = wearing('puffer', {
    garment: 'jacket', material: 'taffeta', rgba: [0.93, 0.4, 0.08, 1],
    ease: 0.24, length: 0.14, sleeve: 0.6, cuff: 0.2, neckline: 0.08,
    // Padded and interfaced, as a puffer's is: it stands round the neck on its own, done up or not.
    collar: { stand: 0.06, standFront: 0.035, fall: 0, materialOverrides: { thickness: 0.003, young: 2e7 } },
    elastics: [{ along: 'cuff', ratio: 0.72 }, { along: 'hem', ratio: 0.88 }],
    curves: quilt.curves, sculpt: quilt.sculpt,
    // Its channels stitched through, and its hem bound in a double row.
    trims: [
      // Worn undone at the neck, the neckerchief's knot showing.
      { kind: 'zipper', along: 'opening', fastened: 0.85, size: 0.004, rgba: [0.78, 0.78, 0.8, 1] },
      ...quilt.curves.map((c) => ({ kind: 'stitch' as const, along: c.name, rgba: [0.62, 0.24, 0.04, 1] })),
      { kind: 'stitch', along: 'hem', offset: [0.008, 0.016], rgba: [0.62, 0.24, 0.04, 1] },
    ],
  }, form, 1);
  // A baseball cap: a close crown of six panels, its peak a stiffened crescent sewn on round the front of its band, stood out.
  // Its band round the forehead a couple of centimetres above the brow and under the back of the skull.
  const FROM = 0.58, CAP_PEAK = 0.18, CAP_BACK = 0.04, CAP_CURVE = 0.16, headL = formLimbs(m).head, bandSec = headL.section(FROM * headL.length);
  const across = [bandSec.side, bandSec.up].reduce((a, b) => (Math.abs(b[0]) > Math.abs(a[0]) ? b : a));
  const half = across === bandSec.side ? bandSec.w : bandSec.h, deep = across === bandSec.side ? bandSec.h : bandSec.w;
  // The band: the head's oval there stood off by its ease.
  const bh = half + 0.004, bd = deep + 0.004, bandC = Math.PI * (3 * (bh + bd) - Math.sqrt((3 * bh + bd) * (bh + 3 * bd)));
  // The peak round the front third of the band, to the temples (round the front quarter, it stuck out as a duck's bill).
  const PEAK = peakOutline(bh, bd, 2 * CAP_PEAK * bandC, 0.07);
  // How far the band drops round from the front (tau, of the way round): under the peak as its seam
  // curves (across its chord, round CAP_CURVE), behind it on down to CAP_BACK more at the back.
  const peakDrop = (x: number) => CAP_CURVE - Math.sqrt(Math.max(0, CAP_CURVE ** 2 - x * x));
  const capDrop = (tau: number) => {
    const k = Math.min(1, tau / CAP_PEAK) * (PEAK_ARC / 2), k0 = Math.floor(k), k1 = Math.min(PEAK_ARC / 2, k0 + 1);
    const x = PEAK[PEAK_ARC / 2 + k0][0] + (PEAK[PEAK_ARC / 2 + k1][0] - PEAK[PEAK_ARC / 2 + k0][0]) * (k - k0);
    const f = Math.max(0, (tau - CAP_PEAK) / (0.5 - CAP_PEAK));
    return peakDrop(x) + (CAP_BACK * (1 - Math.cos(Math.PI * f))) / 2;
  };
  // Its front panels stiffened to stand up off the forehead in a tall front, as a structured cap's do
  // (left to follow the head, the crown read as a swimming cap).
  const lowSec = headL.section((FROM + 0.2) * headL.length), lowDeep = Math.abs(lowSec.side[1]) > Math.abs(lowSec.up[1]) ? lowSec.w : lowSec.h;
  const frontSec = headL.section(0.88 * headL.length), frontDeep = Math.abs(frontSec.side[1]) > Math.abs(frontSec.up[1]) ? frontSec.w : frontSec.h;
  const topSec = headL.section(0.93 * headL.length), topW = Math.abs(topSec.side[0]) > Math.abs(topSec.up[0]) ? topSec.w : topSec.h;
  const capFront: GarmentSculpt[] = [
    // Clear of the band: reaching it, it stood the crown's edge out over the peak in teeth.
    { at: [r4(frontSec.c[0]), r4(frontSec.c[1] - frontDeep), r4(frontSec.c[2])], radius: 0.045, amount: 0.014, mirror: false },
    // Standing up off the band before it turns back: the front's lower part out, short of the band.
    { at: [r4(lowSec.c[0]), r4(lowSec.c[1] - lowDeep), r4(lowSec.c[2])], radius: 0.03, amount: 0.01, mirror: false },
    // Its top broad and flattish, not a dome to a point: filled out a little at the shoulders of the crown (more, it read as a helmet).
    { at: [r4(topSec.c[0] + 0.8 * topW), r4(topSec.c[1] - 0.015), r4(topSec.c[2])], radius: 0.055, amount: 0.01 },
    // And no taller than a cap: drawn in at the top, to the head's own fit there.
    { at: [r4(topSec.c[0]), r4(topSec.c[1] + 0.01), r4(headL.path.at(headL.length)[2] + 0.01)], radius: 0.05, amount: -0.02, mirror: false },
  ];
  // At the back an opening arched up from a strap: the strap the band below
  // it, a strap's width, the opening cut out above (an arch cut from the
  // band's edge, with no strap across it, read as a bite out of the cap).
  // And a button where the panels meet on top.
  const axis = (() => { const v = [0, 1, 2].map((k) => bandSec.side[(k + 1) % 3] * bandSec.up[(k + 2) % 3] - bandSec.side[(k + 2) % 3] * bandSec.up[(k + 1) % 3]); const l = Math.hypot(...v) * Math.sign(v[2] || 1); return v.map((q) => q / l); })();
  const backDir = (across === bandSec.side ? bandSec.up : bandSec.side).map((q, _, v) => q * Math.sign(v[1] || 1));
  const onBand = (x: number, up: number): [number, number, number] => {
    const sn = Math.max(-1, Math.min(1, x / bh)), cs = Math.sqrt(1 - sn * sn), dropAt = capDrop(0.5) - up;
    return [0, 1, 2].map((k) => r4(bandSec.c[k] + across[k] * bh * sn + backDir[k] * bd * cs - axis[k] * dropAt)) as [number, number, number];
  };
  // A strap's width below the opening (narrower, it read as an empty hole).
  const STRAP = 0.024, OPEN_W = 0.034, OPEN_H = 0.06;
  const closure: [number, number, number][] = [
    ...Array.from({ length: 5 }, (_, k) => onBand(-OPEN_W + (2 * OPEN_W * k) / 4, STRAP)),
    ...Array.from({ length: 11 }, (_, k) => { const ph = (Math.PI * (k + 1)) / 12; return onBand(OPEN_W * Math.cos(ph), STRAP + (OPEN_H - STRAP) * Math.sin(ph)); }),
  ];
  const apex = headL.path.at(headL.length), crownTop = (dx: number): [number, number, number] => [r4(apex[0] + dx), r4(apex[1]), r4(apex[2] + 0.01)];
  const cap = wearing('cap', {
    garment: 'hat', material: 'canvas', ease: 0.01, from: FROM, gores: 6, rgba: [0.09, 0.13, 0.3, 1], sculpt: capFront,
    curves: [{ name: 'closure', kind: 'cut', closed: true, points: closure }],
    trims: [
      { kind: 'stitch', along: 'closure', offset: 0.003, rgba: [0.05, 0.08, 0.2, 1] },
      { kind: 'button', at: crownTop(0), size: 0.02, rgba: [0.09, 0.13, 0.3, 1] },
    ],
    // Under the peak its band drops at the sides as the peak curves down
    // (sewn to a level band, the curved peak's seam pulled it straight), then
    // lower still round the back, down under the skull, as a cap sits: square
    // to the head's line, it pitched down at the front and the peak with it,
    // over the eyes. A strap across the opening at the back (curves).
    edges: [{ along: 'top', profile: { points: Array.from({ length: 49 }, (_, k) => { const t = k / 48, tau = Math.min(t, 1 - t); return [r4(t), r4(capDrop(tau))]; }) } }],
    attached: [{
      name: 'peak', outline: PEAK, sewn: [0, PEAK_ARC], along: 'top', span: [r4(1 - CAP_PEAK), CAP_PEAK], bend: CAP_CURVE, rgba: [0.09, 0.13, 0.3, 1],
      // A plastic board inside it (polyethylene, about a gigapascal): it holds itself out.
      material: 'canvas', materialOverrides: { thickness: 0.0015, young: 1e9, arealDensity: 0.9 },
    }],
  }, form, 0);
  // A structured cap: its crown stiffened (buckram behind the canvas), so it holds its shape and the peak on it.
  cap.cloth!.materialOverrides = { thickness: 0.0016, young: 4e7 };
  // Undone at the neck, the collar's ends folded back by the wearer (pulled,
  // then let go), the neckerchief showing between them.
  puffer.cloth!.arrange = [
    { piece: 'collar', at: [-0.428, 0.099], to: [-0.08, -0.15, 1.41] },
    { piece: 'collar', at: [0.425, 0.099], to: [0.08, -0.15, 1.41] },
  ];
  return [form, neckerchief(form), shorts, puffer, cap];
}

/**
 * A cap's peak: its inner edge the band's own curve laid flat (the band is
 * level round the head, an oval: `half` across, `deep` front to back), so
 * the only way it can be sewn on without stretching or buckling is standing
 * out level, as a peak does; its outer edge the inner one stood off by the
 * peak's depth, rounding into the band at the temples (a D). Drafted as a circle, it matched
 * the band at the front only: rounder than the band, it lay on it as a cone
 * tilted down over the eyes; as curved as the front, its sides (where the
 * oval is straighter) hung down in a wall either side of the face.
 */
const PEAK_ARC = 12;
/** Points round the peak's outer edge. */
const PEAK_OUTER = 24;
function peakOutline(half: number, deep: number, arcLen: number, depth: number): [number, number][] {
  // The oval from its front, finely, both ways, by arc length.
  const at = (th: number) => [half * Math.cos(th), deep * Math.sin(th)];
  const fine: { s: number; th: number }[] = [{ s: 0, th: -Math.PI / 2 }];
  for (let k = 1, prev = at(-Math.PI / 2); k <= 2000; k++) {
    const th = -Math.PI / 2 + (Math.PI * k) / 2000, q = at(th);
    fine.push({ s: fine[k - 1].s + Math.hypot(q[0] - prev[0], q[1] - prev[1]), th });
    prev = q;
  }
  const thAt = (s: number) => { const i = fine.findIndex((f) => f.s >= s); if (i <= 0) return fine[Math.max(0, i)].th; const f0 = fine[i - 1], f1 = fine[i]; return f0.th + ((f1.th - f0.th) * (s - f0.s)) / (f1.s - f0.s); };
  // Flat: across x, out from the head +y, the band's front at the origin.
  const point = (u: number) => {
    const th = thAt(Math.abs(u)), sg = Math.sign(u) || 1, [x, y] = at(th);
    const n = [Math.cos(th) / half, Math.sin(th) / deep], l = Math.hypot(n[0], n[1]);
    return { p: [sg * x, -(deep + y)], n: [(sg * n[0]) / l, -n[1] / l] };
  };
  const inner: [number, number][] = [];
  for (let k = 0; k <= PEAK_ARC; k++) { const u = -arcLen / 2 + (arcLen * k) / PEAK_ARC, { p } = point(u); inner.push([r4(p[0]), r4(p[1])]); }
  // Its outer edge the sewn one stood forward (not out round the head) by
  // `depth`, less toward the ends and then quickly none: its sides run
  // forward from the temples, its corners rounded into the band. A half
  // ellipse from end to end met the band tangent, in slivers; stood off the
  // band square to it all along, it wrapped round like a brim.
  const outer: [number, number][] = [];
  for (let k = PEAK_OUTER - 1; k >= 1; k--) {
    const f = -1 + (2 * k) / PEAK_OUTER, { p } = point((f * arcLen) / 2);
    outer.push([r4(p[0]), r4(p[1] + depth * Math.sqrt(1 - f ** 4))]);
  }
  return [...inner, ...outer];
}

/**
 * A neckerchief: a bandana folded and tied round the neck, its own cloth
 * (not sewn to anything), worn under the jacket: a band round the neck, its
 * ends sewn at the back as a knot holds them, its point hanging at the
 * front, showing where the jacket is worn undone at the neck.
 */
function neckerchief(form: SceneNode): SceneNode {
  const fm = form.bodyForm!, L = bodyLandmarks(fm);
  // Low on the neck and a narrow fold, of thin cotton: close, tall and of
  // jersey, it stood up the neck as a stiff tube, a gaiter (looser, it stood
  // out as a ring on the jacket's collar).
  const z = L.hpsZ - 0.045, r = fm.neck / (2 * Math.PI) + 0.012, C = 2 * Math.PI * r, band = 0.03;
  /** The front's span of the band, and the wider top of the triangle gathered onto it. */
  const FRONT = 0.15, BIB = 0.2;
  /** Each end of the knot, across. */
  const TAIL = 0.03;
  const cy = bodyFormSection(fm, z).centreY, pos = form.pos ?? [0, 0, 0];
  const pts = (q: number[][]) => q as UV[];
  const piece: ClothPiece = {
    name: 'bandana', rgba: [0.72, 0.07, 0.09, 1], pattern: { svg: BANDANA_SVG, scale: 0.09, tile: true },
    edges: [
      { id: 'top', pts: pts([[C, 0], [0, 0]]) },
      { id: 'endA', pts: pts([[0, 0], [0, -band]]) },
      { id: 'knotA', pts: pts([[0, -band], [TAIL, -band]]) },
      { id: 'lowA', pts: pts([[TAIL, -band], [C / 2 - FRONT, -band]]) },
      { id: 'front', pts: pts([[C / 2 - FRONT, -band], [C / 2 + FRONT, -band]]) },
      { id: 'lowB', pts: pts([[C / 2 + FRONT, -band], [C - TAIL, -band]]) },
      { id: 'knotB', pts: pts([[C - TAIL, -band], [C, -band]]) },
      { id: 'endB', pts: pts([[C, -band], [C, 0]]) },
    ],
    // Round the neck from the back; flaring a little below, over the collarbones.
    placement: { kind: 'wrap', origin: [pos[0], pos[1] + cy, z], axis: [0, 0, 1], ref: [0, 1, 0], radius: r, taper: -0.35 },
  };
  // Its point hanging at the front: a triangle wider across its top than the
  // band it hangs from, gathered onto it, so it falls in folds (cut as part of
  // the band, it was a flat bib). Started round the neck below the band, on a
  // wider round so it spans the same front (started as a flat sheet out in
  // front, it began inside the jacket and was pushed through it, dragging the
  // whole neckerchief down through the body to the floor).
  const rb = (r * BIB) / FRONT, mid = Math.PI * rb;
  const bib: ClothPiece = {
    name: 'bib', rgba: piece.rgba, pattern: piece.pattern,
    edges: [
      { id: 'top', pts: pts([[mid + BIB, -band], [mid - BIB, -band]]) },
      { id: 'sideA', pts: pts([[mid - BIB, -band], [mid, -band - 0.2]]) },
      { id: 'sideB', pts: pts([[mid, -band - 0.2], [mid + BIB, -band]]) },
    ],
    placement: { kind: 'wrap', origin: [pos[0], pos[1] + cy, z], axis: [0, 0, 1], ref: [0, 1, 0], radius: rb, taper: -0.35 },
  };
  // The knot's two ends hanging below it, out of the band at the back (sewn
  // on under it; left as a seam alone, the back read as a tube split down it).
  const back = [pos[0], pos[1] + cy + r + 0.012, z - band], down = [0, 0.25, -0.97];
  const tail = (name: string, x0: number, lean: number): ClothPiece => ({
    name, rgba: piece.rgba, pattern: piece.pattern,
    edges: [
      { id: 'top', pts: pts([[0, 0], [-TAIL, 0]]) },
      { id: 'side1', pts: pts([[-TAIL, 0], [-TAIL / 2 - lean - 0.008, -0.075]]) },
      { id: 'tip', pts: pts([[-TAIL / 2 - lean - 0.008, -0.075], [-TAIL / 2 - lean + 0.008, -0.07]]) },
      { id: 'side2', pts: pts([[-TAIL / 2 - lean + 0.008, -0.07], [0, 0]]) },
    ],
    // Its outline runs down (v < 0) from its top: v along up, so it hangs from the knot (along `down` it started
    // standing up the neck inside the collar, and fell through the collar as it was sewn).
    placement: { kind: 'plane', origin: [back[0] + x0, back[1], back[2]], uAxis: [1, 0, 0], vAxis: down.map((c) => -c) },
  });
  const tails = [tail('tailA', 0, 0.006), tail('tailB', TAIL, -0.006)];
  const seams: ClothSeam[] = [
    { name: 'knot', a: [{ piece: 'bandana', edge: 'endA' }], b: [{ piece: 'bandana', edge: 'endB', reversed: true }] },
    { name: 'tailA', a: [{ piece: 'tailA', edge: 'top' }], b: [{ piece: 'bandana', edge: 'knotA' }] },
    { name: 'tailB', a: [{ piece: 'tailB', edge: 'top' }], b: [{ piece: 'bandana', edge: 'knotB' }] },
    { name: 'bib', a: [{ piece: 'bib', edge: 'top' }], b: [{ piece: 'bandana', edge: 'front', reversed: true }] },
  ];
  return { id: 'neckerchief', name: 'neckerchief', pos: [0, 0, 0], geoms: [], joints: [], children: [], cloth: { pieces: [piece, bib, ...tails], seams, material: 'woven', materialOverrides: { thickness: 0.0005, arealDensity: 0.1 }, spacing: 0.012, sewTime: 0.5, layer: 0 } } as unknown as SceneNode;
}

/** A cut-off hem: longer and shorter all round, irregularly (a regular one read as lace). */
const FRAY: [number, number][] = Array.from({ length: 73 }, (_, k) => {
  const r = Math.sin(k * 12.9898) * 43758.5453, u = r - Math.floor(r);
  return [r4(k / 72), k === 0 || k === 72 ? 0 : r4(0.004 + 0.03 * u * u)] as [number, number];
});

/**
 * The hood, drafted as a hood is: two side pieces, each sewn round its half
 * of the neckline from the front to the nape, joined along their back edges
 * (a seam rounding up the back of the head and over the crown to the
 * forehead). One piece folded at the back cannot round the back of the head
 * (its back would have to cross its own middle), and stood in a point.
 */
const HOOD_SIDE: [number, number][] = [
  // Its neck edge its share of the hoodie's neckline (0.73 m round, each side
  // 46% of it); shorter, it was sewn in the middle of its share and the hood
  // stood open at the nape.
  [0, 0], [0.34, 0],
  // Up the back from the nape, leaning in to the back of the head, then
  // rounding over the crown to the front edge, which leans back as it rises:
  // from the front of the neckline, a hand ahead of the throat, to the
  // forehead. Square to the neck edge, it rose straight up from there and the
  // hood stood out over the face, its two front edges meeting in front of it.
  [0.335, -0.053], [0.32, -0.114], [0.305, -0.176], [0.282, -0.236], [0.277, -0.268], [0.263, -0.298], [0.24, -0.324], [0.211, -0.343], [0.177, -0.356], [0.14, -0.36],
];
const HOOD_TOP = HOOD_SIDE.length - 1;
/** The other side: mirrored, run the other way round, so its neck edge runs from the nape to the front as the neckline does there. */
const HOOD_OTHER: [number, number][] = HOOD_SIDE.map(([u, v]) => [-u, v] as [number, number]).reverse();

const GOLD_THREAD = [0.86, 0.62, 0.26, 1];

/** A jeans fly's J on the front, from the waist down the wearer's left of the middle and curving in to it: points on the body. */
function flyJ(fm: BodyFormMeasurements): [number, number, number][] {
  const L = bodyLandmarks(fm), out: [number, number, number][] = [];
  const front = (z: number, x: number) => { const q = bodyFormSection(fm, z), r = q.radii[Math.round((3 * q.radii.length) / 4) % q.radii.length]; return round(fm, z, -Math.PI / 2 + x / r, 0.012); };
  for (let k = 0; k <= 8; k++) out.push(front(L.waistZ - 0.03 - 0.16 * (k / 8), 0.035));
  for (let k = 1; k <= 4; k++) { const a = (k / 4) * (Math.PI / 2); out.push(front(L.waistZ - 0.19 - 0.025 * Math.sin(a), 0.035 * Math.cos(a))); }
  return out;
}

/** A hoodie over cut-off jeans. */
function hoodieLook(x: number): SceneNode[] {
  const form = bodyFormNode('formB', 'formB', { figure: 'female' }, [x, 0, 0]);
  const cutoffs = wearing('cutoffs', {
    garment: 'trousers', material: 'denim', length: 0.86, flare: 0.9, rgba: [0.47, 0.6, 0.78, 1],
    pockets: [{ panel: 'front', at: [0.62, 0.86] }, { panel: 'back', at: [0.5, 0.8] }], beltLoops: 5,
    // Cut off: a ragged hem, longer and shorter all round.
    edges: [{ along: 'hem', profile: { points: FRAY } }],
    // A fly's J, marked on the front and topstitched, with the side seams and the waistband, in gold thread.
    curves: [{ name: 'fly', kind: 'line', points: flyJ(form.bodyForm!) }],
    trims: [
      { kind: 'stitch', along: 'fly', offset: [0, 0.006], rgba: GOLD_THREAD },
      { kind: 'stitch', along: 'side', offset: [0.004, 0.01], rgba: GOLD_THREAD },
      { kind: 'stitch', along: 'top', offset: [0.012, 0.03], rgba: GOLD_THREAD },
    ],
  }, form, 0);
  const hoodie = wearing('hoodie', {
    garment: 'tshirt', material: 'jersey', rgba: [0.55, 0.5, 0.68, 1],
    ease: 0.18, length: 0.16, sleeve: 0.55, cuff: 0.17, neckline: 0.07,
    elastics: [{ along: 'cuff', ratio: 0.8 }, { along: 'hem', ratio: 0.88 }],
    trims: [{ kind: 'stitch', along: 'hem', offset: [0.02, 0.026], rgba: [0.42, 0.37, 0.53, 1] }, { kind: 'stitch', along: 'cuff', offset: [0.018, 0.024], rgba: [0.42, 0.37, 0.53, 1] }],
    pockets: [{ panel: 'front', at: [0.5, 0.22], width: 0.3, height: 0.17 }],
    attached: [
      // Its left side from the front to the nape, its right from the nape to the front, sewn up the back and over the crown.
      { name: 'hoodL', outline: HOOD_SIDE, sewn: [0, 1], along: 'neckline', span: [0.04, 0.5], joins: [{ a: [1, HOOD_TOP], b: [0, HOOD_TOP - 1], reversed: true, with: 'hoodR' }] },
      { name: 'hoodR', outline: HOOD_OTHER, sewn: [HOOD_TOP - 1, HOOD_TOP], along: 'neckline', span: [0.5, 0.96] },
      { name: 'drawstring', outline: [[0, 0], [0.012, 0], [0.012, -0.3], [0, -0.3]], sewn: [0, 1], along: 'neckline', span: [0.94, 0.06], repeat: 2, rgba: [0.95, 0.95, 0.93, 1] },
    ],
  }, form, 1);
  // Worn with the hood up: turned up over the head about the neckline it is sewn to, and let settle.
  hoodie.cloth!.arrange = [{ piece: 'hoodL', turn: 165 }, { piece: 'hoodR', turn: 165 }];
  return [form, cutoffs, hoodie, handbag('handbag', m(form), x, 2)];
}

const m = (form: SceneNode) => form.bodyForm!;

/**
 * A handbag on the left forearm: a pouch of two leather pieces seamed round
 * the sides and bottom, a handle from each over the arm. Its face square to
 * the forearm, as a bag hangs in the crook of an arm.
 */
function handbag(id: string, fm: BodyFormMeasurements, x: number, layer: number): SceneNode {
  const arm = formLimbs(fm).armL;
  // In the crook of the arm, a little below the elbow.
  const s = arm.path.jointAt + 0.18 * (arm.length - arm.path.jointAt);
  const sec = arm.section(s), T = arm.path.tangent(s);
  const flatT = [T[0], T[1], 0], lt = Math.hypot(flatT[0], flatT[1]) || 1;
  const along = [flatT[0] / lt, flatT[1] / lt, 0];
  // Across the bag: level, square to the forearm.
  const U = [-along[1], along[0], 0], Z = [0, 0, 1];
  const armR = Math.max(sec.w, sec.h) + 0.03; // over the sleeve
  // A gusset of `gap` * 2 between its faces, round the sides and bottom: a bag with depth.
  const W = 0.21, H = 0.15, drop = 0.07, gap = 0.025;
  const top = sec.c[2] - armR - drop;
  const centre = [sec.c[0] + x, sec.c[1], top - H / 2];
  const at = (side: number, u: number, v: number) => [0, 1, 2].map((k) => r4(centre[k] + along[k] * side * gap + U[k] * u + Z[k] * v));
  const leather = [0.26, 0.13, 0.06, 1];
  const panel = (name: string, side: number): ClothPiece => ({
    name, rgba: leather,
    edges: [
      { id: 'bottom', pts: [[-W / 2, -H / 2], [W / 2, -H / 2]] },
      { id: 'right', pts: [[W / 2, -H / 2], [W / 2, H / 2]] },
      { id: 'topR', pts: [[W / 2, H / 2], [0.07, H / 2]] },
      { id: 'handleR', pts: [[0.07, H / 2], [0.045, H / 2]] },
      { id: 'topMid', pts: [[0.045, H / 2], [-0.045, H / 2]] },
      { id: 'handleL', pts: [[-0.045, H / 2], [-0.07, H / 2]] },
      { id: 'topL', pts: [[-0.07, H / 2], [-W / 2, H / 2]] },
      { id: 'left', pts: [[-W / 2, H / 2], [-W / 2, -H / 2]] },
    ],
    placement: { kind: 'plane', origin: at(side, 0, 0), uAxis: U, vAxis: Z },
  });
  // The gusset: down one side, across the bottom and up the other, between the faces.
  const gusset = (): ClothPiece => {
    const len = 2 * H + W, g = 2 * gap, stations: { p: number[]; across: number[] }[] = [];
    const corner = 0.02;
    const route: [number, number][] = [[-W / 2, H / 2], [-W / 2, -H / 2 + corner], [-W / 2 + corner, -H / 2], [W / 2 - corner, -H / 2], [W / 2, -H / 2 + corner], [W / 2, H / 2]];
    for (const [u, v] of route) stations.push({ p: at(0, u, v), across: along });
    return {
      name: 'gusset', rgba: leather,
      edges: [
        { id: 'sideA', pts: [[0, -g / 2], [len, -g / 2]] as UV[] },
        { id: 'endB', pts: [[len, -g / 2], [len, g / 2]] as UV[] },
        { id: 'sideB', pts: [[len, g / 2], [0, g / 2]] as UV[] },
        { id: 'endA', pts: [[0, g / 2], [0, -g / 2]] as UV[] },
      ],
      placement: { kind: 'path', stations },
    };
  };
  // A handle: up from its piece's top, over the arm, and down again, in the
  // piece's plane (square to the forearm).
  const handle = (name: string, side: number): ClothPiece => {
    const reach = 0.0575;
    const stations: { p: number[]; across: number[] }[] = [];
    const pt = (u: number, z: number) => [0, 1, 2].map((k) => r4(sec.c[k] + (k === 0 ? x : 0) + along[k] * side * gap + U[k] * u + Z[k] * z));
    stations.push({ p: pt(-reach, -armR - drop), across: along });
    for (let k = 0; k <= 8; k++) { const a = Math.PI - (Math.PI * k) / 8; stations.push({ p: pt(Math.cos(a) * Math.max(reach, armR * 0.9), Math.sin(a) * armR * 1.05), across: along }); }
    stations.push({ p: pt(reach, -armR - drop), across: along });
    let len = 0;
    for (let k = 1; k < stations.length; k++) len += Math.hypot(...[0, 1, 2].map((q) => stations[k].p[q] - stations[k - 1].p[q]));
    const w = 0.025;
    return {
      name, rgba: leather,
      edges: [
        { id: 'endA', pts: [[0, -w / 2], [0, w / 2]] as UV[] },
        { id: 'sideA', pts: [[0, w / 2], [len, w / 2]] as UV[] },
        { id: 'endB', pts: [[len, w / 2], [len, -w / 2]] as UV[] },
        { id: 'sideB', pts: [[len, -w / 2], [0, -w / 2]] as UV[] },
      ],
      placement: { kind: 'path', stations },
    };
  };
  // A flap from the back's top over the front, fastened to it by a clasp
  // CLASP below the front's top: long enough to cross the bag's mouth (the
  // gusset's width) and come down to it, and a little past (drafted to the
  // clasp alone, it was 5 cm short, pulled the back's top over and crumpled).
  const CLASP = 0.06, F = 2 * gap + CLASP + 0.014;
  const flap: ClothPiece = {
    name: 'flap', rgba: leather,
    edges: [
      { id: 'top', pts: [[W / 2, 0], [-W / 2, 0]] as UV[] },
      { id: 'sideL', pts: [[-W / 2, 0], [-W / 2, -F + 0.02]] as UV[] },
      { id: 'bottom', pts: [[-W / 2, -F + 0.02], [-W / 2 + 0.02, -F], [W / 2 - 0.02, -F], [W / 2, -F + 0.02]] as UV[] },
      { id: 'sideR', pts: [[W / 2, -F + 0.02], [W / 2, 0]] as UV[] },
    ],
    placement: { kind: 'plane', origin: at(1.6, 0, H / 2), uAxis: U, vAxis: Z },
  };
  const pieces = [panel('front', 1), panel('back', -1), gusset(), flap, handle('handleF', 1), handle('handleB', -1)];
  const round = (p: string) => [{ piece: p, edge: 'left' }, { piece: p, edge: 'bottom' }, { piece: p, edge: 'right' }];
  const seams: ClothSeam[] = [
    // The gusset's first long side lies on the back's face (across runs the way the forearm does, the front the other).
    { name: 'gussetBack', a: round('back'), b: [{ piece: 'gusset', edge: 'sideA' }] },
    { name: 'gussetFront', a: round('front'), b: [{ piece: 'gusset', edge: 'sideB', reversed: true }] },
    { name: 'fA', a: [{ piece: 'handleF', edge: 'endA' }], b: [{ piece: 'front', edge: 'handleL', reversed: true }] },
    { name: 'fB', a: [{ piece: 'handleF', edge: 'endB' }], b: [{ piece: 'front', edge: 'handleR', reversed: true }] },
    { name: 'bA', a: [{ piece: 'handleB', edge: 'endA' }], b: [{ piece: 'back', edge: 'handleL', reversed: true }] },
    { name: 'bB', a: [{ piece: 'handleB', edge: 'endB' }], b: [{ piece: 'back', edge: 'handleR', reversed: true }] },
    { name: 'flap', a: [{ piece: 'flap', edge: 'top' }], b: ['topR', 'handleR', 'topMid', 'handleL', 'topL'].map((edge) => ({ piece: 'back', edge })) },
  ];
  const fasten: ClothFastening[] = [{ a: { piece: 'flap', at: [0, -(2 * gap + CLASP)] }, b: { piece: 'front', at: [0, H / 2 - CLASP] }, trim: { kind: 'buckle', size: 0.028, rgba: [0.83, 0.68, 0.32, 1] } }];
  return { id, name: id, pos: [0, 0, 0], geoms: [], joints: [], children: [], cloth: { pieces, seams, fasten, material: 'leather', spacing: 0.018, sewTime: 1, layer } } as unknown as SceneNode;
}

function urbanCollection(): SceneGraph {
  return { nodes: [...pufferLook(-0.48), ...hoodieLook(0.48)] } as SceneGraph;
}

let cachedUrbanNodes: SceneNode[] | undefined;
export const urbanCollectionPreset: SceneGraph = {
  get nodes() {
    cachedUrbanNodes ??= urbanCollection().nodes;
    return cachedUrbanNodes;
  },
  set nodes(v: SceneNode[]) {
    cachedUrbanNodes = v;
  },
} as SceneGraph;
