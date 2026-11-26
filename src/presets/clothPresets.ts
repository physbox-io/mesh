/**
 * Cloth scenes: a dress form wearing a t-shirt, the same form in a dress, and
 * a shade sail on four posts. All built from the generic cloth parts
 * (utils/cloth): the garments are drafted from the form's measurements, and
 * the sail is one piece tied to the posts.
 */

import type { SceneGraph, SceneNode } from '../types/scene';
import type { ClothEdge, ClothPiece, ClothSeam, ClothTie, UV } from '../types/cloth';
import { garmentNode, lazyBodyFormNode as bodyFormNode } from '../utils/cloth/clothNodes';
import { bodyFormSection, bodyLandmarks } from '../utils/cloth/bodyForm';
import { GARMENT_DEFAULTS } from '../utils/cloth/garments';
import { samplePathStations } from '../utils/cloth/clothMesh';

function formWearing(garment: 'tshirt' | 'dress'): SceneGraph {
  // A man's t-shirt on a male form, a dress on a female one.
  const form = bodyFormNode('form', 'form', { figure: garment === 'dress' ? 'female' : 'male' });
  const worn = garmentNode(garment, garment, { garment }, form);
  return {
    nodes: [form, worn],
  } as SceneGraph;
}

/** Lazily computes `.nodes` on first access so importing presets at app startup takes ~0 ms. */
function lazyScene(build: () => SceneGraph): SceneGraph {
  let cached: SceneNode[] | undefined;
  return {
    get nodes() {
      cached ??= build().nodes;
      return cached;
    },
    set nodes(v: SceneNode[]) {
      cached = v;
    },
  } as SceneGraph;
}

export const tshirtOnFormPreset = lazyScene(() => formWearing('tshirt'));
export const dressOnFormPreset = lazyScene(() => formWearing('dress'));

/** A garment worn as `layer` (0 next to the body). */
function wearing(id: string, draft: Parameters<typeof garmentNode>[2], form: SceneNode, layer: number): SceneNode {
  const node = garmentNode(id, id, draft, form);
  node.cloth!.layer = layer;
  return node;
}

/** A man in jeans, a t-shirt over them and a leather jacket over that: three layers. */
function menswear(): SceneGraph {
  const form = bodyFormNode('form', 'form', { figure: 'male' });
  return {
    nodes: [
      form,
      wearing('jeans', { garment: 'trousers' }, form, 0),
      wearing('tshirt', { garment: 'tshirt', rgba: [0.92, 0.92, 0.9, 1] }, form, 1),
      wearing('jacket', { garment: 'jacket' }, form, 2),
    ],
  } as SceneGraph;
}

/**
 * A large bow folded from one continuous velvet ribbon and sewn onto the back
 * of `onto` at height z: from the right tail up into the right loop, across
 * the front of the knot into the left loop, and down into the left tail.
 */
function bow(id: string, onto: string, backY: number, z: number, layer: number, rgba: number[], lean = 0): SceneNode {
  // Placed as a generalized cylinder over a smooth horizontal curve in (x, y),
  // so every triangle of the loops, center knot, and hanging tails starts
  // isometric to its flat 2D pattern. Vertical, but where the tails hang it
  // leans back by `lean` (y per metre down), so they start along the back
  // below the knot rather than inside it; moved out at the top by as much,
  // so the loops above stay off it.
  const vMin = -0.40, vMax = 0.055, vMid = (vMin + vMax) / 2, z0 = z + vMid;
  const ac = [0, 0, 1], tail = [0, -lean / Math.hypot(1, lean), 1 / Math.hypot(1, lean)];
  const stations: { p: number[]; across: number[] }[] = [
    // Right back pinch (0..1), tied to the gown.
    { p: [-0.006, backY + 0.005, z0], across: ac },
    { p: [-0.024, backY + 0.006, z0], across: ac },
    // Right tail & back of right loop (1..5).
    { p: [-0.058, backY + 0.008 + lean * 0.040, z0], across: tail },
    { p: [-0.068, backY + 0.009 + lean * 0.044, z0], across: tail },
    { p: [-0.135, backY + 0.014 + lean * 0.053, z0], across: tail },
    // Right loop outer tip (5) and front sheet (6..7).
    { p: [-0.155, backY + 0.025, z0], across: ac },
    { p: [-0.092, backY + 0.038, z0], across: ac },
    // Front center knot (7..9), wrapping in front (+y) of the back pinch.
    { p: [-0.026, backY + 0.022, z0], across: ac },
    { p: [0, backY + 0.027, z0], across: ac },
    { p: [0.026, backY + 0.022, z0], across: ac },
    // Left loop front sheet (9..10) and outer tip (11).
    { p: [0.092, backY + 0.038, z0], across: ac },
    { p: [0.155, backY + 0.025, z0], across: ac },
    // Left tail & back of left loop (11..15).
    { p: [0.135, backY + 0.014 + lean * 0.053, z0], across: tail },
    { p: [0.068, backY + 0.009 + lean * 0.044, z0], across: tail },
    { p: [0.058, backY + 0.008 + lean * 0.040, z0], across: tail },
    // Left back pinch (15..16), tied to the gown.
    { p: [0.024, backY + 0.006, z0], across: ac },
    { p: [0.006, backY + 0.005, z0], across: ac },
  ];
  const { stationS: s } = samplePathStations(stations);
  const vTop = [
    0.028, 0.028, 0.040, 0.044, 0.053, 0.055, 0.048,
    0.028, 0.028, 0.028,
    0.048, 0.055, 0.053, 0.044, 0.040, 0.028, 0.028,
  ];
  const topPt = (i: number): UV => [s[i], vTop[i]];
  const spanTop = (i0: number, i1: number): UV[] => {
    const out: UV[] = [], step = i1 >= i0 ? 1 : -1;
    for (let i = i0; ; i += step) { out.push(topPt(i)); if (i === i1) break; }
    return out;
  };
  const edges: ClothEdge[] = [
    // Lower boundary: right back pinch -> right tail -> right loop bottom -> front knot bottom -> left loop bottom -> left tail -> left back pinch.
    { id: 'bot_pinchR', pts: [[s[0], -0.028], [s[1], -0.028]] },
    { id: 'tailR_in', pts: [[s[1], -0.028], [s[2], vMin]] },
    { id: 'tailR_hem', pts: [[s[2], vMin], [s[4], vMin]] },
    { id: 'tailR_out', pts: [[s[4], vMin], [s[3], -0.036]] },
    { id: 'bot_loopR', pts: [[s[3], -0.036], [s[4], -0.050], [s[5], -0.055], [s[6], -0.048], [s[7], -0.028]] },
    { id: 'bot_knotR', pts: [[s[7], -0.028], [s[8], -0.028]] },
    { id: 'bot_knotL', pts: [[s[8], -0.028], [s[9], -0.028]] },
    { id: 'bot_loopL', pts: [[s[9], -0.028], [s[10], -0.048], [s[11], -0.055], [s[12], -0.050], [s[13], -0.036]] },
    { id: 'tailL_out', pts: [[s[13], -0.036], [s[12], vMin]] },
    { id: 'tailL_hem', pts: [[s[12], vMin], [s[14], vMin]] },
    { id: 'tailL_in', pts: [[s[14], vMin], [s[15], -0.028]] },
    { id: 'bot_pinchL', pts: [[s[15], -0.028], [s[16], -0.028]] },
    // Left pinch vertical end.
    { id: 'endL', pts: [[s[16], -0.028], topPt(16)] },
    // Upper boundary (reversed from 16 back to 0).
    { id: 'top_pinchL', pts: spanTop(16, 15) },
    { id: 'top_loopL', pts: spanTop(15, 9) },
    { id: 'top_knotL', pts: spanTop(9, 8) },
    { id: 'top_knotR', pts: spanTop(8, 7) },
    { id: 'top_loopR', pts: spanTop(7, 1) },
    { id: 'top_pinchR', pts: spanTop(1, 0) },
    // Right pinch vertical end.
    { id: 'endR', pts: [topPt(0), [s[0], -0.028]] },
  ];
  const pieces: ClothPiece[] = [{ name: 'ribbon', rgba, edges, placement: { kind: 'path', stations } }];
  // Close the back pinch at the center and wrap the front knot band over it.
  const seams: ClothSeam[] = [
    { name: 'pinchClosed', a: [{ piece: 'ribbon', edge: 'endR' }], b: [{ piece: 'ribbon', edge: 'endL', reversed: true }] },
    { name: 'knotBotR', a: [{ piece: 'ribbon', edge: 'bot_knotR' }], b: [{ piece: 'ribbon', edge: 'bot_pinchR', reversed: true }] },
    { name: 'knotBotL', a: [{ piece: 'ribbon', edge: 'bot_knotL' }], b: [{ piece: 'ribbon', edge: 'bot_pinchL', reversed: true }] },
    { name: 'knotTopR', a: [{ piece: 'ribbon', edge: 'top_knotR' }], b: [{ piece: 'ribbon', edge: 'top_pinchR', reversed: true }] },
    { name: 'knotTopL', a: [{ piece: 'ribbon', edge: 'top_knotL' }], b: [{ piece: 'ribbon', edge: 'top_pinchL', reversed: true }] },
  ];
  // Tie the back pinch directly onto the gown.
  const ties: ClothTie[] = [
    { piece: 'ribbon', edge: 'endR', toCloth: onto },
    { piece: 'ribbon', edge: 'endL', toCloth: onto },
    { piece: 'ribbon', edge: 'bot_pinchR', toCloth: onto },
    { piece: 'ribbon', edge: 'top_pinchR', toCloth: onto },
    { piece: 'ribbon', edge: 'bot_pinchL', toCloth: onto },
    { piece: 'ribbon', edge: 'top_pinchL', toCloth: onto },
  ];
  return { id, name: id, pos: [0, 0, 0], geoms: [], joints: [], children: [], cloth: { pieces, seams, ties, material: 'velvet', spacing: 0.02, sewTime: 1, layer } } as unknown as SceneNode;
}

/** A ballgown with a train and batwing sleeves, a large velvet bow on its back. */
function ballgown(): SceneGraph {
  const form = bodyFormNode('form', 'form', { figure: 'female' });
  const gown = wearing('gown', { garment: 'gown' }, form, 0);
  // The back of the gown at the waist, from the form and the gown's ease.
  const m = form.bodyForm!, L = bodyLandmarks(m);
  const off = GARMENT_DEFAULTS.gown.ease / (2 * Math.PI) + 0.004;
  const backAt = (z: number) => { const q = bodyFormSection(m, z); return q.centreY + q.radii[Math.round(q.radii.length / 4)]; };
  const back = backAt(L.waistZ) + off, knot = L.waistZ + 0.02;
  // The tails lean back along the line from the knot that clears the back below it.
  let lean = 0;
  for (let dz = 0.02; dz <= 0.4; dz += 0.02) lean = Math.max(lean, (backAt(knot - dz) + off - (back + 0.006)) / dz);
  return { nodes: [form, gown, bow('bow', 'gown', back + 0.006, knot, 1, [0.08, 0.08, 0.1, 1], lean)] } as SceneGraph;
}

/**
 * Knitwear, each a tube round a span of a limb: a hat over the crown, a sock
 * on each foot, and leg warmers over the socks (a layer above them).
 */
function knitwear(): SceneGraph {
  const form = bodyFormNode('form', 'form', { figure: 'female' });
  return {
    nodes: [
      form,
      wearing('hat', { garment: 'hat' }, form, 0),
      wearing('sockL', { garment: 'sock', over: 'legL' }, form, 0),
      wearing('sockR', { garment: 'sock', over: 'legR' }, form, 0),
      wearing('legWarmerL', { garment: 'tube', over: 'legL', from: 0.5, to: 0.78, ease: 0.06, rgba: [0.55, 0.3, 0.45, 1] }, form, 1),
      wearing('legWarmerR', { garment: 'tube', over: 'legR', from: 0.5, to: 0.78, ease: 0.06, rgba: [0.55, 0.3, 0.45, 1] }, form, 1),
    ],
  } as SceneGraph;
}

/** A flared skirt, from the waist, on a female form. */
function skirt(): SceneGraph {
  const form = bodyFormNode('form', 'form', { figure: 'female' });
  return { nodes: [form, wearing('skirt', { garment: 'skirt' }, form, 0)] } as SceneGraph;
}

const FLORAL_DIAMOND_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">',
  '<circle cx="16" cy="16" r="7" fill="#fb7185"/>',
  '<circle cx="16" cy="16" r="2.8" fill="#fef08a"/>',
  '<circle cx="48" cy="48" r="7" fill="#fb7185"/>',
  '<circle cx="48" cy="48" r="2.8" fill="#fef08a"/>',
  '<path d="M48 9 L55 16 L48 23 L41 16 Z" fill="#38bdf8"/>',
  '<path d="M16 41 L23 48 L16 55 L9 48 Z" fill="#38bdf8"/>',
  '</svg>',
].join('');

/**
 * Showcase outfit combining all garment features:
 * - Layer 0: Belted denim trousers with front/back patch pockets, 5 belt loops, and a buckled leather belt drawn in.
 * - Layer 1: Negative-ease spandex top with an SVG surface print and elasticated cuffs.
 * - Layer 2: Rib-knit cardigan with functional buttons & buttonholes along the front opening, chest pocket, and gathered elastic cuffs/hem.
 */
function tailoredOutfit(): SceneGraph {
  const form = bodyFormNode('form', 'form', { figure: 'female' });
  return {
    nodes: [
      form,
      wearing('jeans', {
        garment: 'trousers',
        pockets: [{ panel: 'front', at: [0.62, 0.86] }, { panel: 'back', at: [0.5, 0.8] }],
        beltLoops: 5,
        belt: { width: 0.035, material: 'leather', rgba: [0.22, 0.13, 0.07, 1] },
      }, form, 0),
      wearing('stretchTop', {
        garment: 'tshirt',
        material: 'spandex',
        ease: -0.04,
        length: 0.03,
        sleeve: 0.18,
        rgba: [0.14, 0.22, 0.42, 1],
        elastics: [{ along: 'cuff', ratio: 0.85, stiffness: 10 }, { along: 'hem', ratio: 0.92, stiffness: 10 }],
        pattern: { svg: FLORAL_DIAMOND_SVG, scale: 0.14, tile: true },
      }, form, 1),
      wearing('cardigan', {
        garment: 'jacket',
        material: 'rib',
        opening: true,
        ease: 0.14,
        length: 0.26,
        sleeve: 0.49,
        cuff: 0.20,
        neckline: 0.12,
        rgba: [0.58, 0.22, 0.28, 1],
        trims: [{ kind: 'button', along: 'opening', spacing: 0.075, size: 0.015, fastened: true, rgba: [0.92, 0.86, 0.72, 1] }],
        elastics: [{ along: 'cuff', ratio: 0.82, stiffness: 12 }, { along: 'hem', ratio: 0.88, stiffness: 12 }],
        pockets: [{ panel: 'frontL', at: [0.5, 0.66], width: 0.095, height: 0.105 }],
      }, form, 2),
    ],
  } as SceneGraph;
}

/**
 * A boned strapless gown under a cropped velvet spencer, every part from the
 * draft: princess seams down to the hem, a zip done up the centre back,
 * spiral steel bones in the bodice's seams from just below the waist, and a
 * polyester hoop round the skirt near the floor, in a seam of its own (a
 * steel one weighs 85 g, more than the taffeta hung from it). The spencer's
 * left front laps over the right on a button stand.
 */
function bonedGown(): SceneGraph {
  const form = bodyFormNode('form', 'form', { figure: 'female' });
  const L = bodyLandmarks(form.bodyForm!);
  const bones: [number, number] = [L.waistZ - 0.06, 3];
  return {
    nodes: [
      form,
      wearing('gown', {
        garment: 'dress',
        top: L.bustZ + 0.05,
        length: 1.0,
        flare: 2.4,
        material: 'taffeta',
        rgba: [0.1, 0.32, 0.36, 1],
        seams: [
          { name: 'princess', point: [L.bustPoint[0], 0, 0], normal: [1, 0, 0], mirror: true, on: ['skin'] },
          { name: 'zip', point: [0, 0, 0], normal: [1, 0, 0], front: false, open: true },
          { name: 'hoop', point: [0, 0, 0.36], normal: [0, 0, 1] },
        ],
        rods: [
          { along: 'princessL', z: bones },
          { along: 'princessR', z: bones },
          { along: 'side', z: bones },
          { along: 'hoop', kind: 'plastic' },
        ],
        trims: [{ kind: 'zipper', along: 'zip' }],
      }, form, 0),
      wearing('spencer', {
        garment: 'jacket',
        material: 'velvet',
        ease: 0.12,
        length: 0.02,
        sleeve: 0.6,
        cuff: 0.18,
        neckline: 0.12,
        rgba: [0.42, 0.08, 0.14, 1],
        trims: [{ kind: 'button', along: 'opening', spacing: 0.06, fastened: true, lap: 'left', stand: 0.03, rgba: [0.85, 0.72, 0.4, 1] }],
      }, form, 1),
    ],
  } as SceneGraph;
}

/**
 * A shirt under a single-breasted jacket, both collared from the draft. The
 * shirt's collar has a stand of its own (a band, buttoned at the front) and
 * a fall folded over it; the jacket's fronts turn back into notched lapels
 * from the top button, its collar running round from one lapel to the other,
 * its stand easing from 3 cm at the back to 1 cm where it meets them.
 */
function shirtAndJacket(): SceneGraph {
  const form = bodyFormNode('form', 'form', { figure: 'male' });
  return {
    nodes: [
      form,
      wearing('shirt', {
        garment: 'tshirt',
        material: 'woven',
        opening: true,
        ease: 0.12,
        length: 0.26,
        sleeve: 0.6,
        cuff: 0.24,
        neckline: 0.03,
        rgba: [0.86, 0.9, 0.96, 1],
        collar: { stand: 0.03, fall: 0.042, point: -0.012, separateStand: true },
        trims: [{ kind: 'button', along: 'opening', spacing: 0.09, size: 0.01, rgba: [0.95, 0.95, 0.92, 1] }],
      }, form, 1),
      wearing('jacket', {
        garment: 'jacket',
        material: 'woven',
        ease: 0.16,
        length: 0.26,
        neckline: 0.05,
        rgba: [0.16, 0.2, 0.3, 1],
        lapels: { break: 0.24, width: 0.075, peak: 0.01 },
        collar: { stand: 0.03, standFront: 0.01, fall: 0.045, separateStand: true },
        trims: [{ kind: 'button', along: 'opening', spacing: 0.1, size: 0.02, rgba: [0.1, 0.1, 0.12, 1] }],
        // Worn two layers out from the shirt: round the neck, the shirt's collar is two more layers of cloth.
      }, form, 3),
    ],
  } as SceneGraph;
}

/**
 * A fitted woven sheath dress shaped by darts alone, on a form with its
 * elbows bent: double-ended back waist darts in place of the plan's own,
 * and on each three-quarter sleeve an elbow dart across the inside of the
 * bend and a dart down from the shoulder over the cap. Without the sleeve
 * darts a one-piece sleeve over a bent elbow needs 7% to lie flat; with
 * them about 4%.
 */
function dartedSheath(): SceneGraph {
  const form = bodyFormNode('form', 'form', { figure: 'female', elbowBend: 25 });
  return {
    nodes: [
      form,
      wearing('sheath', {
        garment: 'dress',
        material: 'woven',
        fitted: true,
        length: 0.55,
        sleeve: 0.45,
        cuff: 0.2,
        rgba: [0.55, 0.12, 0.1, 1],
        darts: [
          { name: 'backWaist', apex: { z: 'waist', x: 0.075, back: true }, direction: [0, 0, 1], length: 0.15, back: 0.12, mirror: true },
          { name: 'elbow', apex: { limb: 'armL', along: 'joint', face: [1, 0, 1] }, to: { limb: 'armL', along: 'joint', face: [0, -1, -1] }, mirror: true },
          { name: 'cap', apex: { limb: 'armL', along: 0.12, face: [0, 0, 1] }, direction: [-1, 0, 1], mirror: true },
        ],
      }, form, 0),
    ],
  } as SceneGraph;
}

/**
 * Fullness: a dress whose skirt is gathered into its bodice at a waist seam,
 * twice the waist's length of cloth eased in evenly, release tucks up its
 * back bodice from the same seam; and a skirt knife-pleated
 * from a yoke, two and a half times round, the pleats stitched down 10 cm.
 * The extra is in the pieces (spread along the seam) and the sewing; the drape
 * makes the folds.
 */
function gathersAndPleats(): SceneGraph {
  const left = bodyFormNode('formA', 'formA', { figure: 'female' }, [-0.45, 0, 0]);
  const right = bodyFormNode('formB', 'formB', { figure: 'female' }, [0.45, 0, 0]);
  const L = bodyLandmarks(left.bodyForm!);
  return {
    nodes: [
      left,
      wearing('gathered', {
        garment: 'dress',
        rgba: [0.2, 0.36, 0.62, 1],
        seams: [{ name: 'waist', point: [0, 0, L.waistZ], normal: [0, 0, 1] }],
        // Two release tucks up the back bodice from the waist: stitched 6 cm,
        // falling open above. (The front's bust darts reach the waist's
        // stretch; spread across a dart, its legs no longer match.)
        fullness: [
          { along: 'waist', kind: 'gather', ratio: 2 },
          { along: 'waist', kind: 'knife', panels: ['back1'], ratio: 1.4, count: 2, stitched: 0.06, pressed: false },
        ],
      }, left, 0),
      right,
      wearing('pleated', {
        garment: 'skirt',
        length: 0.55,
        flare: 1.3,
        rgba: [0.55, 0.16, 0.2, 1],
        seams: [{ name: 'yoke', point: [0, 0, L.waistZ - 0.07], normal: [0, 0, 1] }],
        fullness: [{ along: 'yoke', kind: 'knife', ratio: 2.5, count: 6, stitched: 0.1 }],
      }, right, 0),
    ],
  } as SceneGraph;
}

export const gathersAndPleatsPreset = lazyScene(gathersAndPleats);
export const knitwearPreset = lazyScene(knitwear);
export const skirtPreset = lazyScene(skirt);
export const menswearPreset = lazyScene(menswear);
export const ballgownPreset = lazyScene(ballgown);
export const tailoredOutfitPreset = lazyScene(tailoredOutfit);
export const bonedGownPreset = lazyScene(bonedGown);
export const shirtAndJacketPreset = lazyScene(shirtAndJacket);
export const dartedSheathPreset = lazyScene(dartedSheath);

/** A sail edge from `a` to `b`, cut in toward the middle by `sag` of its length, as sails are. */
function catenaryEdge(id: string, a: UV, b: UV, sag: number): ClothEdge {
  const pts: UV[] = [];
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  // Inward normal of a counter-clockwise outline: the edge direction turned left.
  const nx = -dy / len, ny = dx / len;
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, k = 4 * t * (1 - t) * sag * len;
    pts.push([a[0] + dx * t + nx * k, a[1] + dy * t + ny * k]);
  }
  return { id, pts };
}

const SPAN = 4, LOW = 2.4, HIGH = 3.2;
const posts: [number, number, number][] = [[-SPAN / 2, -SPAN / 2, LOW], [SPAN / 2, -SPAN / 2, HIGH], [SPAN / 2, SPAN / 2, LOW], [-SPAN / 2, SPAN / 2, HIGH]];

function shadeSail(): SceneGraph {
  // Cut 4% small, so the sail is stretched taut when its corners reach the posts.
  const c = (SPAN * 0.96) / 2;
  const corners: UV[] = [[-c, -c], [c, -c], [c, c], [-c, c]];
  const ids = ['south', 'east', 'north', 'west'];
  const edges = ids.map((id, i) => catenaryEdge(id, corners[i], corners[(i + 1) % 4], 0.06));

  // Initial t=0 ruled hyperbolic-paraboloid shape matching the alternating LOW/HIGH
  // post heights (SW=LOW, SE=HIGH, NE=LOW, NW=HIGH) so the sail starts cleanly aligned
  // with all four tie anchors without posts poking through it; rest lengths stay flat.
  const dz = (HIGH - LOW) / 2;
  const hyparStations = Array.from({ length: 9 }, (_, k) => {
    const s = -1 + (2 * k) / 8;
    return {
      p: [s * c, 0, 0],
      across: [0, 1, (-dz * s) / c],
    };
  });

  const postNodes: SceneNode[] = posts.map(([x, y, h], i) => {
    const inX = -Math.sign(x);
    const inY = -Math.sign(y);
    const topZ = h / 2;
    const anchorZ = topZ + 0.03;
    return {
      id: `post${i + 1}`,
      name: `post${i + 1}`,
      pos: [x, y, h / 2],
      geoms: [
        { name: `post${i + 1}_pipe`, type: 'cylinder', size: [0.045, h / 2], rgba: [0.55, 0.57, 0.6, 1] },
        { name: `post${i + 1}_base_plate`, type: 'cylinder', size: [0.11, 0.012], pos: [0, 0, -topZ + 0.012], rgba: [0.38, 0.4, 0.44, 1], role: 'visual' },
        { name: `post${i + 1}_cap`, type: 'cylinder', size: [0.052, 0.012], pos: [0, 0, topZ], rgba: [0.42, 0.44, 0.48, 1], role: 'visual' },
        { name: `post${i + 1}_eye_stem`, type: 'capsule', fromto: [0, 0, topZ, 0, 0, anchorZ + 0.004], size: [0.008], rgba: [0.82, 0.85, 0.89, 1], role: 'visual' },
        { name: `post${i + 1}_eye_ring`, type: 'sphere', size: [0.016], pos: [0, 0, anchorZ], rgba: [0.85, 0.88, 0.92, 1], role: 'visual' },
        { name: `post${i + 1}_turnbuckle`, type: 'capsule', fromto: [0, 0, anchorZ, inX * 0.09, inY * 0.09, anchorZ], size: [0.0065], rgba: [0.78, 0.81, 0.86, 1], role: 'visual' },
      ],
      joints: [],
    } as unknown as SceneNode;
  });

  const sail = {
    id: 'sail',
    name: 'sail',
    pos: [0, 0, (LOW + HIGH) / 2 + 0.03],
    cloth: {
      pieces: [
        {
          name: 'sheet',
          edges,
          rgba: [0.93, 0.62, 0.2, 1],
          start: { kind: 'path', along: 'u', stations: hyparStations },
        },
      ],
      material: 'shadeCloth',
      spacing: 0.16,
      // Each corner shackled to the top of its post, wound in to tension it.
      ties: posts.map(([, , h], i) => ({ name: `corner${i + 1}`, piece: 'sheet', edge: ids[i], at: 0, to: `post${i + 1}`, anchor: [0, 0, h / 2 + 0.03] })),
    },
    joints: [],
  } as unknown as SceneNode;
  return {
    nodes: [...postNodes, sail],
  } as SceneGraph;
}

export const shadeSailPreset = shadeSail();
