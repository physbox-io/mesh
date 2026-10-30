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

  const judge: HeadlessImpactJudge = async (event) => {
    // The scene as it now is, with whatever already broke in pieces.
    const live = effectiveSceneGraph(scene, broken);
    const node = findNodeById(live.nodes, event.nodeId);
    if (!node) return null;

    // Shattering wins over denting, as in handleImpact.
    if (!broken[node.id]) {
      const wallM = node.shatterThicknessRef ? wallAtImpact(node, event.localPoint) : null;
      if (shatterVerdict(event.impulseNs, node, wallM)) {
        const pieces = Math.min(node.shatterPieces ?? DEFAULT_FRACTURE_PIECES, shardRoom(broken, node.id));
        if (pieces < 2) return null;
        let shards: SceneNode[] | null = null;
        try {
          shards = await cutShards(node, event, pieces);
        } catch (err) {
          console.warn('[headless shatter]', err);
        }
        if (!shards) return null;
        broken[node.id] = shards;
        shattered.push({ id: node.id, name: node.name, time: event.time, impulseNs: event.impulseNs, shards: shards.map((s) => s.id) });
        const graph = effectiveSceneGraph(scene, broken);
        return { xml: compile(graph), sceneGraph: graph };
      }
    }

    mark(node, event);
    const other = event.otherNodeId ? findNodeById(live.nodes, event.otherNodeId) : null;
    if (other && event.otherLocalPoint && event.otherLocalNormal) mark(other, event);
    return null;
  };

  return { judge, shattered, dented, shards: () => Object.values(broken).flat() };
}
