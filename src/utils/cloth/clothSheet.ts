/**
 * Plain cloth from the editor: a sheet laid over what is selected (or held up
 * in the open), its size and its corners. A corner is free, pinned where it
 * starts, or tied to a body: wound in to the nearest point of that body's
 * bounds over the sew time, which is how a shade sail is shackled to its
 * posts. Nodes and specs only; the store adds them.
 */

import * as THREE from 'three';
import type { ClothEdge, ClothPiece, ClothTie, UV } from '../../types/cloth';
import type { SceneNode } from '../../types/scene';
import { walkBodiesWorld } from '../bodyWorld';
import { sceneContentBounds } from '../frameScene';

const SIDES = ['south', 'east', 'north', 'west'];
const allNodes = (nodes: SceneNode[]): SceneNode[] => nodes.flatMap((n) => [n, ...allNodes(n.children ?? [])]);

/** `base`, or `base_2`, `base_3` ...: the first no node in the scene is called. */
function freeName(nodes: SceneNode[], base: string): string {
  const taken = new Set(allNodes(nodes).map((n) => n.name || n.id));
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) if (!taken.has(`${base}_${k}`)) return `${base}_${k}`;
}

/** A rectangle `w` by `l` round its middle, its four sides named south, east, north, west (each starting at a corner). */
export function rectEdges(w: number, l: number): ClothEdge[] {
  const c: UV[] = [[-w / 2, -l / 2], [w / 2, -l / 2], [w / 2, l / 2], [-w / 2, l / 2]];
  return SIDES.map((id, i) => ({ id, pts: [c[i], c[(i + 1) % 4]] }));
}

/**
 * A level sheet of woven cloth `over` a body (a hand-width above its top,
 * half as wide again as it and 0.2 m more, to hang over its sides), or 1 m square held 1 m up at
 * `at` with nothing to go over. It falls and drapes when the scene plays.
 */
export function sheetNode(nodes: SceneNode[], over?: SceneNode | null, at: number[] = [0, 0]): SceneNode {
  let w = 1, l = 1, pos = [at[0], at[1], 1];
  const b = over ? boundsOf(nodes, over) : null;
  if (b) {
    w = 1.5 * (b.max[0] - b.min[0]) + 0.2;
    l = 1.5 * (b.max[1] - b.min[1]) + 0.2;
    pos = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2] + 0.1];
  }
  const r = (x: number) => Math.round(x * 1000) / 1000;
  const name = freeName(nodes, 'cloth');
  return {
    id: `cloth_${Math.random().toString(36).slice(2, 10)}`, name, pos: pos.map(r),
    cloth: { pieces: [{ name: 'sheet', edges: rectEdges(r(w), r(l)), rgba: [0.85, 0.82, 0.74, 1] }], material: 'woven' },
    geoms: [], joints: [], children: [],
  } as unknown as SceneNode;
}

/** A body's world bounds, with everything under it; null if it has no extent. */
function boundsOf(nodes: SceneNode[], node: SceneNode): { min: number[]; max: number[] } | null {
  let parentWorld: THREE.Matrix4 | null = null;
  walkBodiesWorld(nodes, (n, _world, parent) => { if (n.id === node.id) parentWorld = parent ? worldOf(nodes, parent) : new THREE.Matrix4(); });
  if (!parentWorld) return null;
  // sceneContentBounds composes from the node's own pos down; its parent's pose goes on top.
  const b = sceneContentBounds([node]);
  if (!b) return null;
  const pw = parentWorld as THREE.Matrix4;
  const p = new THREE.Vector3(), min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]]) {
    p.set(x, y, z).applyMatrix4(pw);
    [p.x, p.y, p.z].forEach((c, a) => { min[a] = Math.min(min[a], c); max[a] = Math.max(max[a], c); });
  }
  return { min, max };
}

function worldOf(nodes: SceneNode[], node: SceneNode): THREE.Matrix4 {
  let out = new THREE.Matrix4();
  walkBodiesWorld(nodes, (n, world) => { if (n.id === node.id) out = world; });
  return out;
}

/** A piece's extent in pattern space. */
export function pieceSize(piece: ClothPiece): [number, number] {
  const pts = piece.edges.flatMap((e) => e.pts);
  const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
  return [Math.max(...us) - Math.min(...us), Math.max(...vs) - Math.min(...vs)];
}

/** The piece stretched about its middle to `w` by `l`, its outline's shape kept. */
export function resizePiece(piece: ClothPiece, w: number, l: number): ClothPiece {
  const pts = piece.edges.flatMap((e) => e.pts);
  const us = pts.map((p) => p[0]), vs = pts.map((p) => p[1]);
  const cu = (Math.max(...us) + Math.min(...us)) / 2, cv = (Math.max(...vs) + Math.min(...vs)) / 2;
  const [w0, l0] = pieceSize(piece);
  const su = w0 > 0 ? w / w0 : 1, sv = l0 > 0 ? l / l0 : 1;
  return { ...piece, edges: piece.edges.map((e) => ({ ...e, pts: e.pts.map(([u, v]) => [cu + (u - cu) * su, cv + (v - cv) * sv] as UV) })) };
}

/** What a corner (the start of `edge` on `piece`) is held by: nothing, the world where it starts, or a body by name. */
export function cornerHold(ties: ClothTie[] | undefined, piece: string, edge: string): { kind: 'free' } | { kind: 'pinned' } | { kind: 'body'; to: string } {
  const t = ties?.find((x) => x.piece === piece && x.edge === edge && (x.at ?? 0) === 0 && !x.toCloth);
  if (!t) return { kind: 'free' };
  return t.to ? { kind: 'body', to: t.to } : { kind: 'pinned' };
}

/**
 * The cloth's ties with the corner at the start of `edge` held as asked: let
 * go; pinned where it starts; or tied to the body named `to`, wound in to the
 * point of that body's bounds nearest where the corner starts.
 */
export function holdCorner(nodes: SceneNode[], cloth: SceneNode, piece: string, edge: string, hold: 'free' | 'pinned' | { to: string }): ClothTie[] {
  const ties = (cloth.cloth?.ties ?? []).filter((x) => !(x.piece === piece && x.edge === edge && (x.at ?? 0) === 0 && !x.toCloth));
  const name = `${piece}_${edge}`;
  if (hold === 'free') return ties;
  if (hold === 'pinned') return [...ties, { name, piece, edge, at: 0 }];
  const target = allNodes(nodes).find((n) => (n.name || n.id) === hold.to);
  const corner = cornerWorld(nodes, cloth, piece, edge);
  const b = target ? boundsOf(nodes, target) : null;
  if (!target || !corner || !b) return [...ties, { name, piece, edge, at: 0, to: hold.to }];
  const nearest = new THREE.Vector3(...[0, 1, 2].map((a) => Math.min(b.max[a], Math.max(b.min[a], corner[a]))) as [number, number, number]);
  nearest.applyMatrix4(worldOf(nodes, target).invert());
  const r = (x: number) => Math.round(x * 1e4) / 1e4;
  return [...ties, { name, piece, edge, at: 0, to: hold.to, anchor: [r(nearest.x), r(nearest.y), r(nearest.z)] }];
}

/** Where a corner starts in the world, for a piece laid in a plane; null for one placed otherwise. */
function cornerWorld(nodes: SceneNode[], cloth: SceneNode, piece: string, edge: string): number[] | null {
  const p = cloth.cloth?.pieces?.find((x) => x.name === piece);
  const e = p?.edges.find((x) => x.id === edge);
  const pl = p?.start ?? p?.placement;
  if (!e || (pl && pl.kind !== 'plane')) return null;
  const o = pl?.origin ?? [0, 0, 0], ua = pl?.uAxis ?? [1, 0, 0], va = pl?.vAxis ?? [0, 1, 0];
  const [u, v] = e.pts[0];
  const local = new THREE.Vector3(o[0] + u * ua[0] + v * va[0], o[1] + u * ua[1] + v * va[1], o[2] + u * ua[2] + v * va[2]);
  return local.applyMatrix4(worldOf(nodes, cloth)).toArray();
}
