// How much contact memory MuJoCo needs for a scene's convex pieces.
//
// MuJoCo keeps contacts and constraint rows in one arena, 15 MiB unless the
// model says otherwise (<size memory>). Two decomposed bodies that touch make
// contacts piece against piece, and four nesting paraboloid bowls of 512
// V-HACD pieces each stopped the simulation dead at their first touch:
// "mj_stackAlloc: out of memory ... (increase <size memory>)". Settled, the
// arena fills to its last byte and MuJoCo drops contacts without a word, so
// the bowls sink into each other instead.
//
// Measured on those bowls cut into exact sector-and-band pieces, peak arena
// use against pieces per bowl:
//
//   pieces/bowl                         65     257    513
//   dropped, stiff contact, settling    6.6    15.1   31.5 MiB
//   dropped at the default, sinking     -      61     118  MiB
//
// (~3.4 KiB a contact). Soft contact lets a landing bowl sink into the one
// below, and then every piece touches several: 60 KiB a piece. So a moving
// body's pieces are budgeted 128 KiB each, and MuJoCo's default is left alone
// until that comes to more — past about 120 pieces. Four free bodies at the
// 64-piece default ask for 32 MiB.
//
// More memory does not make it fast: those bowls stepped at 18 to 36 ms a
// millisecond step at 513 pieces, against 2 to 3 ms at 64. It turns a crash
// into a slow scene, which is the honest version of the same news.

import type { SceneNode } from '../types/scene';

const MIB = 1024 * 1024;
/** MuJoCo's own arena when <size memory> is not given. */
export const DEFAULT_ARENA = 15 * MIB;
const PER_PIECE = 128 * 1024;
/** Held under the wasm heap's 2 GB with room for the model and everything else. */
const MOST = 512 * MIB;

/** Convex pieces on bodies that move, anywhere in the tree. */
export function movingColliderPieces(nodes: SceneNode[], moving = false): number {
  let n = 0;
  for (const node of nodes || []) {
    const moves = moving || (node.joints ?? []).length > 0;
    if (moves) n += (node.geoms ?? []).filter(g => g.csgDerived === 'collider').length;
    n += movingColliderPieces(node.children || [], moves);
  }
  return n;
}

/** The arena to ask for, in bytes, or null when MuJoCo's default is enough. */
export function contactArenaBytes(nodes: SceneNode[]): number | null {
  const want = movingColliderPieces(nodes) * PER_PIECE;
  return want > DEFAULT_ARENA ? Math.min(MOST, Math.ceil(want / MIB) * MIB) : null;
}

/** The <size> element for it, or nothing. */
export function contactArenaXml(nodes: SceneNode[]): string {
  const bytes = contactArenaBytes(nodes);
  return bytes ? `  <size memory="${bytes / MIB}M" />\n` : '';
}
