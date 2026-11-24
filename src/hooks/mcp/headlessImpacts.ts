// What a blow does in physics_run_headless: the store's handleImpact, for a
// run of its own.
//
// The live run hands every impact to the store, which shatters or dents the
// body; a headless run stops at the tick of the blow and asks this instead.
// It keeps its own record of what broke (never the store's, which is the live
// scene's), decides with the same verdict, cuts with the same code
// (store/shatterCut.ts) and hands back the scene with the body swapped for
// its pieces, compiled, for the worker to rebuild around. Dents are only
// recorded: they are cosmetic live as well, unless deformCollision is set,
// which headless does not model (utils/headlessLimits.ts says so).

import type { SceneGraph, SceneNode } from '../../types/scene';
import type { ImpactEvent } from '../../workers/physicsWorkerProtocol';
import type { HeadlessImpactJudge } from '../../store/physicsWorkerClient';
import { dentDepth, pierceVerdict, shatterVerdict } from '../../utils/breakThresholds';
import { DEFAULT_FRACTURE_PIECES } from '../../utils/fracture';
import { effectiveSceneGraph, wallAtImpact } from '../../store/breakage';
import { findNodeById } from '../../store/sceneClone';
import { cutShards, shardRoom } from '../../store/shatterCut';
import { nodeLocalQuat } from '../../utils/sceneTree';

const quatToMat3 = ([w, x, y, z]: [number, number, number, number]): number[] => [
  1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
  2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
  2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
];

/** A body that came apart during the run. */
export interface HeadlessShatter {
  id: string;
  name: string;
  /** Simulated seconds of the blow. */
  time: number;
  impulseNs: number;
  /** The shards' body ids, as the trajectory has them. */
  shards: string[];
}

/** A surface marked during the run: dented this deep, or holed. */
export interface HeadlessDent {
  body: string;
  geom: string;
  time: number;
  impulseNs: number;
  depthMm?: number;
  pierced?: boolean;
}

export interface HeadlessImpacts {
  judge: HeadlessImpactJudge;
  shattered: HeadlessShatter[];
  dented: HeadlessDent[];
  /** Every shard made, for naming them in the reply. */
  shards: () => SceneNode[];
}

/**
 * A judge for one run of `scene`. `compile` turns the scene with its pieces
 * into MJCF against the client the run is on (its mesh-file ledger).
 */
export function headlessImpacts(scene: SceneGraph, compile: (graph: SceneGraph) => string): HeadlessImpacts {
  const broken: Record<string, SceneNode[]> = {};
  const shattered: HeadlessShatter[] = [];
  const dented: HeadlessDent[] = [];

  const mark = (node: SceneNode, event: ImpactEvent) => {
    for (const g of node.geoms || []) {
      if (!(g.renderVertices ?? g.vertices) || !g.faces) continue;
      // Holed or dented, never both: see dentBody.
      if (pierceVerdict(event.impulseNs, g)) {
        dented.push({ body: node.id, geom: g.name, time: event.time, impulseNs: event.impulseNs, pierced: true });
        continue;
      }
      const depth = dentDepth(event.impulseNs, g);
      if (depth > 0) dented.push({ body: node.id, geom: g.name, time: event.time, impulseNs: event.impulseNs, depthMm: +(depth * 1000).toFixed(2) });
    }
  };

  const tryShatter = async (
    target: SceneNode,
    localPoint: number[],
    targetEvent: ImpactEvent,
  ): Promise<boolean> => {
    if (broken[target.id]) return false;
    const wallM = target.shatterThicknessRef ? wallAtImpact(target, localPoint) : null;
    if (!shatterVerdict(targetEvent.impulseNs, target, wallM)) return false;
    const pieces = Math.min(target.shatterPieces ?? DEFAULT_FRACTURE_PIECES, shardRoom(broken, target.id));
    if (pieces < 2) return false;
    let shards: SceneNode[] | null = null;
    try {
      shards = await cutShards(target, targetEvent, pieces);
    } catch (err) {
      console.warn('[headless shatter]', err);
    }
    if (!shards) return false;
    broken[target.id] = shards;
    shattered.push({
      id: target.id,
      name: target.name,
      time: targetEvent.time,
      impulseNs: targetEvent.impulseNs,
      shards: shards.map((s) => s.id),
    });
    return true;
  };

  const judge: HeadlessImpactJudge = async (event) => {
    // The scene as it now is, with whatever already broke in pieces.
    const live = effectiveSceneGraph(scene, broken);
    const node = findNodeById(live.nodes, event.nodeId);
    const other = event.otherNodeId ? findNodeById(live.nodes, event.otherNodeId) : null;
    if (!node && !other) return null;

    let didShatter = false;
    // Shattering wins over denting on each side of the collision independently.
    if (node) {
      if (await tryShatter(node, event.localPoint, event)) didShatter = true;
      else mark(node, event);
    }

    if (other) {
      const otherPoint = event.otherLocalPoint ?? [0, 0, 0];
      const otherNormal = event.otherLocalNormal ?? [0, 0, 1];
      const otherEvent: ImpactEvent = {
        ...event,
        nodeId: other.id,
        localPoint: otherPoint,
        localNormal: otherNormal,
        pos: other.pos ?? [0, 0, 0],
        xmat: quatToMat3(nodeLocalQuat(other)),
        vel: [0, 0, 0],
        angvel: [0, 0, 0],
      };
      if (await tryShatter(other, otherPoint, otherEvent)) didShatter = true;
      else if (event.otherLocalPoint && event.otherLocalNormal) mark(other, event);
    }

    if (didShatter) {
      const graph = effectiveSceneGraph(scene, broken);
      return { xml: compile(graph), sceneGraph: graph };
    }
    return null;
  };

  return { judge, shattered, dented, shards: () => Object.values(broken).flat() };
}
