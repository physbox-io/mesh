/**
 * An urban collection, two looks side by side, every part of it from the
 * general garment parts (no garment of its own kind):
 *
 * - A puffer jacket over shorts, a neckerchief at the neck. The puffer is a
 *   jacket quilted round with drawn seams (GarmentDraft.curves), its
 *   channels sculpted out between them (`sculpt`), in a light shiny shell
 *   fabric; the neckerchief a triangle sewn round the neckline, its point at
 *   the front (`attached`).
 * - A hoodie over cut-off jeans, a handbag on the arm. The hood is a piece
 *   sewn on round the back of the neckline, its crown folded and sewn
 *   (`attached` with `joins`), worn up over the head (`turn: 'up'`); its drawstrings two narrow strips; the
 *   pocket a patch across the front. The cut-offs are short jeans with a
 *   ragged hem (`edges`), cut off just above the ankle. The bag is plain cloth: a pouch of two pieces
 *   seamed round, its handles over the forearm.
 */

import type { SceneGraph, SceneNode } from '../types/scene';
import type { ClothPiece, ClothSeam, GarmentCurve, GarmentSculpt, UV } from '../types/cloth';
import { bodyFormNode, garmentNode } from '../utils/cloth/clothNodes';
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
    garment: 'trousers', material: 'canvas', length: 0.4, flare: 1.12, ease: 0.1, rgba: [0.62, 0.55, 0.4, 1],
    pockets: [{ panel: 'front', at: [0.62, 0.86] }, { panel: 'back', at: [0.5, 0.8] }], beltLoops: 5,
    belt: { width: 0.032, material: 'leather', rgba: [0.13, 0.08, 0.05, 1] },
  }, form, 0);
  const puffer = wearing('puffer', {
    garment: 'jacket', material: 'taffeta', rgba: [0.93, 0.4, 0.08, 1],
    ease: 0.24, length: 0.14, sleeve: 0.6, cuff: 0.2, neckline: 0.08,
    collar: { stand: 0.06, fall: 0 },
    trims: [{ kind: 'zipper', along: 'opening', fastened: true, size: 0.012, rgba: [0.78, 0.78, 0.8, 1] }],
    elastics: [{ along: 'cuff', ratio: 0.72 }, { along: 'hem', ratio: 0.88 }],
    curves: quilt.curves, sculpt: quilt.sculpt,
    attached: [{
      // A bandana folded to a triangle and tied: a band all round the neck, its point down the front.
      name: 'neckerchief', outline: NECKERCHIEF, sewn: [0, 1], along: 'neckline', span: [0.5, 1.5],
      material: 'jersey', rgba: [0.72, 0.07, 0.09, 1], pattern: { svg: BANDANA_SVG, scale: 0.09, tile: true },
    }, {
      // Its ends, knotted at the back of the neck and hanging.
      name: 'kerchiefTie', outline: [[0, 0], [0.05, 0], [0.032, -0.12], [0.018, -0.12]], sewn: [0, 1], along: 'neckline', span: [0.44, 0.56], repeat: 2,
      material: 'jersey', rgba: [0.72, 0.07, 0.09, 1], pattern: { svg: BANDANA_SVG, scale: 0.09, tile: true },
    }],
  }, form, 1);
  return [form, shorts, puffer];
}

/** A neckerchief: a band round the neck (its top sewn round the neckline, the middle at the front), a point hanging from it. */
const NECKERCHIEF: [number, number][] = [[0, 0], [1, 0], [1, -0.045], [0.64, -0.045], [0.5, -0.21], [0.36, -0.045], [0, -0.045]];

/** A cut-off hem: longer and shorter all round, irregularly (a regular one read as lace). */
const FRAY: [number, number][] = Array.from({ length: 73 }, (_, k) => {
  const r = Math.sin(k * 12.9898) * 43758.5453, u = r - Math.floor(r);
  return [r4(k / 72), k === 0 || k === 72 ? 0 : r4(0.004 + 0.03 * u * u)] as [number, number];
});

/** The hood: one piece sewn round the back of the neckline, its crown (the far side, halved) folded and sewn. */
// Its face edges long enough to reach the forehead from the neck (short, they pulled the hood down over the face); its crown rounds over the head and back down to the fold at the back (a straight one folded into a point).
const HOOD: [number, number][] = [[0.0, 0], [0.46, 0], [0.46, -0.32], [0.433, -0.37], [0.38, -0.4], [0.318, -0.4], [0.265, -0.37], [0.23, -0.33], [0.195, -0.37], [0.142, -0.4], [0.08, -0.4], [0.027, -0.37], [0.0, -0.32]];

/** A hoodie over cut-off jeans. */
function hoodieLook(x: number): SceneNode[] {
  const form = bodyFormNode('formB', 'formB', { figure: 'female' }, [x, 0, 0]);
  const cutoffs = wearing('cutoffs', {
    garment: 'trousers', material: 'denim', length: 0.86, flare: 0.9, rgba: [0.47, 0.6, 0.78, 1],
    pockets: [{ panel: 'front', at: [0.62, 0.86] }, { panel: 'back', at: [0.5, 0.8] }], beltLoops: 5,
    // Cut off: a ragged hem, longer and shorter all round.
    edges: [{ along: 'hem', profile: { points: FRAY } }],
  }, form, 0);
  const hoodie = wearing('hoodie', {
    garment: 'tshirt', material: 'jersey', rgba: [0.55, 0.5, 0.68, 1],
    ease: 0.18, length: 0.16, sleeve: 0.55, cuff: 0.17, neckline: 0.07,
    elastics: [{ along: 'cuff', ratio: 0.8 }, { along: 'hem', ratio: 0.88 }],
    pockets: [{ panel: 'front', at: [0.5, 0.22], width: 0.3, height: 0.17 }],
    attached: [
      { name: 'hood', outline: HOOD, sewn: [0, 1], along: 'neckline', span: [0.04, 0.96], turn: 'up', joins: [{ a: [2, 7], b: [7, 12], reversed: true }] },
      { name: 'drawstring', outline: [[0, 0], [0.012, 0], [0.012, -0.3], [0, -0.3]], sewn: [0, 1], along: 'neckline', span: [0.94, 0.06], repeat: 2, rgba: [0.95, 0.95, 0.93, 1] },
    ],
  }, form, 1);
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
  const s = arm.path.jointAt + 0.45 * (arm.length - arm.path.jointAt);
  const sec = arm.section(s), T = arm.path.tangent(s);
  const flatT = [T[0], T[1], 0], lt = Math.hypot(flatT[0], flatT[1]) || 1;
  const along = [flatT[0] / lt, flatT[1] / lt, 0];
  // Across the bag: level, square to the forearm.
  const U = [-along[1], along[0], 0], Z = [0, 0, 1];
  const armR = Math.max(sec.w, sec.h) + 0.03; // over the sleeve
  // A gusset of `gap` * 2 between its faces, round the sides and bottom: a bag with depth.
  const W = 0.26, H = 0.19, drop = 0.07, gap = 0.03;
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
    // A clasp at the middle of the front's top.
    ...(side > 0 ? { trims: [{ kind: 'buckle', along: 'topMid', spacing: 1, size: 0.03, rgba: [0.83, 0.68, 0.32, 1] }] } : {}),
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
  const pieces = [panel('front', 1), panel('back', -1), gusset(), handle('handleF', 1), handle('handleB', -1)];
  const round = (p: string) => [{ piece: p, edge: 'left' }, { piece: p, edge: 'bottom' }, { piece: p, edge: 'right' }];
  const seams: ClothSeam[] = [
    // The gusset's first long side lies on the back's face (across runs the way the forearm does, the front the other).
    { name: 'gussetBack', a: round('back'), b: [{ piece: 'gusset', edge: 'sideA' }] },
    { name: 'gussetFront', a: round('front'), b: [{ piece: 'gusset', edge: 'sideB', reversed: true }] },
    { name: 'fA', a: [{ piece: 'handleF', edge: 'endA' }], b: [{ piece: 'front', edge: 'handleL', reversed: true }] },
    { name: 'fB', a: [{ piece: 'handleF', edge: 'endB' }], b: [{ piece: 'front', edge: 'handleR', reversed: true }] },
    { name: 'bA', a: [{ piece: 'handleB', edge: 'endA' }], b: [{ piece: 'back', edge: 'handleL', reversed: true }] },
    { name: 'bB', a: [{ piece: 'handleB', edge: 'endB' }], b: [{ piece: 'back', edge: 'handleR', reversed: true }] },
  ];
  return { id, name: id, pos: [0, 0, 0], geoms: [], joints: [], children: [], cloth: { pieces, seams, material: 'leather', spacing: 0.018, sewTime: 1, layer } } as unknown as SceneNode;
}

function urbanCollection(): SceneGraph {
  return { nodes: [...pufferLook(-0.48), ...hoodieLook(0.48)] } as SceneGraph;
}

export const urbanCollectionPreset = urbanCollection();
