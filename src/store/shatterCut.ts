// Cutting a body that has just been hit into its pieces: the part of a shatter
// that is the same live and headless. The live store (breakageActions) and a
// headless run's judge (hooks/mcp/headlessImpacts.ts) both come here, so the
// same blow on the same body gives the same pieces either way.

import type { SceneGeom, SceneNode } from '../types/scene';
import type { ImpactEvent } from '../workers/physicsWorkerProtocol';
import { fractureMeshOffThread } from '../utils/fractureWorkerClient';
import { buildShatterGraph, MAX_LIVE_SHARDS } from '../utils/runtimeShatter';
import { bodyMassOf } from './breakage';

/**
 * How many more shards the world has room for if `nodeId` breaks now.
 *
 * Every entry in `broken` lists the pieces of one break, and a piece that has
 * broken again is no longer in the world, so the live ones are the pieces with
 * no entry of their own. A shard breaking gives its own slot back.
 */
export function shardRoom(broken: Record<string, SceneNode[]>, nodeId: string): number {
  const live = Object.values(broken).flat().filter((s) => !broken[s.id]);
  return MAX_LIVE_SHARDS - live.length + (live.some((s) => s.id === nodeId) ? 1 : 0);
}

/** Three.js Y-up `vertices` turned into the MuJoCo Z-up frame `buildShatterGraph` expects. */
export function yupToZup(verts: number[]): number[] {
  const out = new Array(verts.length - (verts.length % 3));
  for (let i = 0; i + 2 < verts.length; i += 3) {
    out[i] = verts[i];
    out[i + 1] = -verts[i + 2];
    out[i + 2] = verts[i + 1];
  }
  return out;
}

/** The body's own mesh, never one of the convex pieces it collides as; null when it has none. */
export function shatterSourceOf(node: SceneNode): { geom: SceneGeom; verts: number[]; faces: number[] } | null {
  const geoms = node.geoms || [];
  const hasMesh = (g: SceneGeom) =>
    ((g.renderVertices?.length ?? g.vertices?.length ?? 0) >= 9) && ((g.faces?.length ?? 0) >= 3);
  // A boolean body's actual shape is its compiled `visual` mesh; raw geoms on
  // it include uncut primitives and negative `difference` cutters.
  const geom = node.csgEnabled
    ? (geoms.find((g) => g.csgDerived === 'visual' && hasMesh(g))
      ?? geoms.find((g) => !g.csgDerived && g.csg !== 'difference' && hasMesh(g)))
    : geoms.find((g) => !g.csgDerived && g.csg !== 'difference' && hasMesh(g));
  if (!geom || !geom.faces) return null;
  const verts = geom.renderVertices?.length
    ? geom.renderVertices
    : geom.vertices?.length
      ? yupToZup(geom.vertices)
      : null;
  if (!verts || verts.length < 9) return null;
  return { geom, verts, faces: geom.faces };
}

/**
 * The pieces `node` breaks into under `event`, at most `pieces` of them (a
 * cell that falls across two parts of the body can give two), posed and moving
 * as the body was at the blow. Null when there is nothing to cut or the cut
 * gave fewer than two pieces, which is not a shatter. Throws when the cut does.
 */
export async function cutShards(node: SceneNode, event: ImpactEvent, pieces: number): Promise<SceneNode[] | null> {
  const source = shatterSourceOf(node);
  if (!source) return null;
  const { geom, verts, faces } = source;
  const cells = await fractureMeshOffThread(verts, faces, {
    pieces,
    seed: node.shatterSeed ?? 1,
    focus: node.shatterPattern === 'uniform'
      ? undefined
      : [event.localPoint[0], event.localPoint[1], event.localPoint[2]],
  });
  // Replacing a body with one shard would be a visible no-op that had thrown
  // its collider away.
  if (cells.length < 2) return null;

  const { shards } = buildShatterGraph(node, verts, faces, cells, {
    pos: [event.pos[0], event.pos[1], event.pos[2]],
    xmat: event.xmat,
    vel: [event.vel[0], event.vel[1], event.vel[2]],
    angvel: [event.angvel[0], event.angvel[1], event.angvel[2]],
  }, {
    spread: node.shatterSpread,
    totalMass: bodyMassOf(node),
    rgba: geom.rgba,
    friction: geom.friction,
    solref: geom.solref,
    solimp: geom.solimp,
    recursion: (node.shatterDepth ?? 0) > 0 ? {
      generation: (node.shatterGeneration ?? 0) + 1,
      depth: node.shatterDepth!,
      impulseNs: node.shatterImpulseNs!,
      thicknessRef: node.shatterThicknessRef,
      pieces: node.shatterPieces ?? 8,
      pattern: node.shatterPattern,
      spread: node.shatterSpread,
      seed: node.shatterSeed,
    } : undefined,
  });
  return shards;
}
