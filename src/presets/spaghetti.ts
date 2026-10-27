// Spaghetti and putty: the team-building tower and bridge.
//
// Every strand is a free body of dry pasta and every node a free blob of
// putty. Nothing is fixed and nothing is parented: the structures stand only
// because the compiler welds each strand into the blobs it reaches into (see
// utils/breakModel.ts), at the strength a 5 mm ball of putty can hold. Putty
// yields — past a fraction of a newton-millimetre a joint turns like a pin —
// so what stands is what is triangulated, which is the lesson of the game.
//
// Pasta here breaks under load like any other material that has a strength
// (utils/deformMaterials.ts): nothing in these scenes is special to it.

import type { SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { deformMaterial } from '../utils/deformMaterials';
import { joinMaterial } from '../utils/joinMaterials';

type V3 = [number, number, number];

const PASTA = deformMaterial('pasta')!;
const PUTTY = joinMaterial('putty')!;
/** Dry spaghetti, 1.8 mm. */
const STRAND_R = 0.0009;
/** A 10 mm ball of putty at every node. */
const BLOB_R = 0.005;
const PASTA_RGBA = [0.96, 0.84, 0.48, 1];

/** A strand of spaghetti from `a` to `b`, world metres, Z up. */
export function strand(id: string, a: V3, b: V3): SceneNode {
  const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
  const geom: SceneGeom = {
    name: `${id}_g`, type: 'cylinder', size: [STRAND_R, 0],
    fromto: [a[0] - mid[0], a[1] - mid[1], a[2] - mid[2], b[0] - mid[0], b[1] - mid[1], b[2] - mid[2]],
    rgba: PASTA_RGBA, density: PASTA.density,
  };
  return {
    id, name: id, type: 'body', pos: mid, joints: [{ name: `${id}_free`, type: 'free' }], geoms: [geom], children: [],
    deformMaterial: 'pasta', loadStrength: { ...PASTA.strength },
  };
}

/** A ball of putty at `p`. */
export function puttyBlob(id: string, p: V3, radius = BLOB_R): SceneNode {
  return {
    id, name: id, type: 'body', pos: p, joints: [{ name: `${id}_free`, type: 'free' }],
    geoms: [{ name: `${id}_g`, type: 'ellipsoid', size: [radius, radius, radius], rgba: [...PUTTY.rgba], density: PUTTY.density }],
    children: [], joinMaterial: PUTTY.id,
  };
}

function weight(id: string, p: V3, half: V3, kg: number): SceneNode {
  return {
    id, name: id, type: 'body', pos: p, joints: [{ name: `${id}_free`, type: 'free' }],
    geoms: [{ name: `${id}_g`, type: 'box', size: half, rgba: [0.3, 0.32, 0.36, 1], mass: kg }], children: [],
  };
}

/** Struts between named nodes, blobs on the nodes. */
function frame(prefix: string, nodes: V3[], members: [number, number][]): SceneNode[] {
  return [
    ...nodes.map((p, i) => puttyBlob(`${prefix}_n${i}`, p)),
    ...members.map(([i, j], k) => strand(`${prefix}_s${k}`, nodes[i], nodes[j])),
  ];
}

// ---- Tower ----------------------------------------------------------------

const LEVEL = 0.1;
/** What sits on each tower, and how far off centre. */
const LOAD_KG = 0.05;
const LOAD_OFFSET = 0.02;

/** A three-sided tower, every face crossed: it stands. */
function triangleTower(cx: number, levels: number): { nodes: V3[]; members: [number, number][] } {
  const rc = 0.1 / Math.sqrt(3);
  const nodes: V3[] = [];
  for (let l = 0; l <= levels; l++) {
    for (let k = 0; k < 3; k++) {
      const a = (k * 2 * Math.PI) / 3 + Math.PI / 2;
      nodes.push([cx + rc * Math.cos(a), rc * Math.sin(a), BLOB_R + l * LEVEL]);
    }
  }
  const id = (l: number, k: number) => l * 3 + (k % 3);
  const members: [number, number][] = [];
  for (let l = 0; l <= levels; l++) for (let k = 0; k < 3; k++) members.push([id(l, k), id(l, k + 1)]);
  for (let l = 0; l < levels; l++) {
    for (let k = 0; k < 3; k++) {
      members.push([id(l, k), id(l + 1, k)]);
      members.push([id(l, k), id(l + 1, k + 1)]);
    }
  }
  return { nodes, members };
}

/** A four-sided tower of rings and posts and nothing across: it folds. */
function squareTower(cx: number, levels: number): { nodes: V3[]; members: [number, number][] } {
  const h = 0.04;
  const corners: [number, number][] = [[-h, -h], [h, -h], [h, h], [-h, h]];
  const nodes: V3[] = [];
  for (let l = 0; l <= levels; l++) for (const [x, y] of corners) nodes.push([cx + x, y, BLOB_R + l * LEVEL]);
  const id = (l: number, k: number) => l * 4 + (k % 4);
  const members: [number, number][] = [];
  for (let l = 0; l <= levels; l++) for (let k = 0; k < 4; k++) members.push([id(l, k), id(l, k + 1)]);
  for (let l = 0; l < levels; l++) for (let k = 0; k < 4; k++) members.push([id(l, k), id(l + 1, k)]);
  return { nodes, members };
}

function buildTowers(): SceneGraph {
  // Far enough apart that the square one, folding, cannot take the other
  // down with it: it is 300 mm tall.
  const tri = triangleTower(-0.18, 4);
  const sq = squareTower(0.18, 3);
  const triTop = BLOB_R + 4 * LEVEL;
  const sqTop = BLOB_R + 3 * LEVEL;
  return {
    name: 'Spaghetti Towers',
    nodes: [
      ...frame('tri', tri.nodes, tri.members),
      ...frame('sq', sq.nodes, sq.members),
      // The same weight on each, off centre by the same amount: a perfectly
      // centred one would let even the square tower stand, balanced on
      // nothing, the way no real one ever is. A plate wide enough to rest on
      // every top corner however far off centre it sits.
      weight('tri_load', [-0.18 + LOAD_OFFSET, 0, triTop + BLOB_R + 0.003], [0.085, 0.085, 0.003], LOAD_KG),
      weight('sq_load', [0.18 + LOAD_OFFSET, 0, sqTop + BLOB_R + 0.003], [0.07, 0.07, 0.003], LOAD_KG),
    ],
  };
}

// ---- Bridge -----------------------------------------------------------------

const SPAN = 0.3;
const PANELS = 6;
const TRUSS_H = 0.06;
const WIDTH = 0.06;
const TABLE_TOP = 0.1;

/**
 * Two Pratt trusses side by side, cross-tied at every node, resting on two
 * tables with nothing holding them there but their own weight.
 */
function buildBridge(): SceneGraph {
  const panel = SPAN / PANELS;
  const z0 = TABLE_TOP + BLOB_R;
  const nodes: V3[] = [];
  const bottom: number[][] = [[], []];
  const top: number[][] = [[], []];
  for (let side = 0; side < 2; side++) {
    const y = side === 0 ? -WIDTH / 2 : WIDTH / 2;
    for (let i = 0; i <= PANELS; i++) { bottom[side].push(nodes.length); nodes.push([-SPAN / 2 + i * panel, y, z0]); }
    for (let i = 1; i < PANELS; i++) { top[side].push(nodes.length); nodes.push([-SPAN / 2 + i * panel, y, z0 + TRUSS_H]); }
  }
  const members: [number, number][] = [];
  for (let side = 0; side < 2; side++) {
    const b = bottom[side], t = top[side];
    for (let i = 0; i < PANELS; i++) members.push([b[i], b[i + 1]]);
    for (let i = 0; i + 1 < t.length; i++) members.push([t[i], t[i + 1]]);
    for (let i = 1; i < PANELS; i++) members.push([b[i], t[i - 1]]);
    // Pratt: the end posts slope down to the supports, and every diagonal
    // runs down toward the middle, so under a central load it is in tension.
    members.push([b[0], t[0]], [b[PANELS], t[t.length - 1]]);
    for (let i = 1; i < PANELS - 1; i++) {
      if (i < PANELS / 2) members.push([t[i - 1], b[i + 1]]);
      else members.push([t[i], b[i]]);
    }
  }
  for (let i = 0; i <= PANELS; i++) members.push([bottom[0][i], bottom[1][i]]);
  for (let i = 0; i < PANELS - 1; i++) members.push([top[0][i], top[1][i]]);
  // Bracing between the two trusses. Tied only at the nodes, the pair is a
  // stack of rectangles in plan and in section, and rectangles of pinned
  // joints rack: the bridge swayed sideways and sheared its end joints out.
  // A diagonal across every deck panel, every top panel, every vertical
  // section and both ends makes it a frame (71 members for 24 joints; a
  // frame needs 3 x 24 - 6 = 66).
  for (let i = 0; i < PANELS; i++) members.push(i < PANELS / 2 ? [bottom[0][i], bottom[1][i + 1]] : [bottom[1][i], bottom[0][i + 1]]);
  for (let i = 0; i + 1 < top[0].length; i++) members.push(i < (top[0].length - 1) / 2 ? [top[0][i], top[1][i + 1]] : [top[1][i], top[0][i + 1]]);
  for (let i = 1; i < PANELS; i++) members.push([bottom[0][i], top[1][i - 1]]);
  members.push([bottom[0][0], top[1][0]], [bottom[0][PANELS], top[1][top[1].length - 1]]);

  const table = (id: string, x: number): SceneNode => ({
    id, name: id, type: 'body', pos: [x, 0, TABLE_TOP / 2], joints: [], children: [],
    geoms: [{ name: `${id}_g`, type: 'box', size: [0.06, 0.08, TABLE_TOP / 2], rgba: [0.55, 0.42, 0.3, 1] }],
  });
  return {
    name: 'Spaghetti Bridge',
    nodes: [
      table('table_left', -SPAN / 2 - 0.05),
      table('table_right', SPAN / 2 + 0.05),
      ...frame('br', nodes, members),
      // A weight on the two middle cross-ties, as a cup of coins would sit.
      weight('br_load', [0, 0, z0 + STRAND_R + 0.0051], [0.06, 0.02, 0.005], 0.1),
    ],
  };
}

export const spaghettiTowersPreset: SceneGraph = buildTowers();
export const spaghettiBridgePreset: SceneGraph = buildBridge();
