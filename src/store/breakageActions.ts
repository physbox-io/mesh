// ---------------------------------------------------------------------------
// The store's answers to impacts during a run: shattering a body, denting
// one, and welding a broken constraint back
//
// The state they write (shatteredBodies, deformedGeoms, brokenConstraints)
// and the helpers they share are in breakage.ts.
// ---------------------------------------------------------------------------

import type { SceneNode, SceneGeom } from '../types/scene';
import type { ImpactEvent } from '../workers/physicsWorkerProtocol';
import { shatterVerdict } from '../utils/breakThresholds';
import { DEFAULT_FRACTURE_PIECES } from '../utils/fracture';
import { cutShards, shardRoom, shatterSourceOf } from './shatterCut';
import { fromtoCenter, imprintOf, isDentable, meshForDenting } from '../utils/dentMesh';
import type { DentConfig } from '../utils/breakThresholds';
import { findNodeById } from './sceneClone';
import { toRenderVertices } from './meshGeomTransforms';
import { fracturing, breakageEpoch, scheduleShatterRebuild, effectiveSceneGraph, wallAtImpact, dentBody } from './breakage';
import type { SliceDeps } from './sliceDeps';

export interface BreakageActions {
  /** A body has been hit: break it, dent it, or ignore it. */
  handleImpact: (event: ImpactEvent) => void;
  /** Replace a body with its pieces, in the runtime overlay only. */
  shatterNode: (node: SceneNode, event: ImpactEvent, wallM?: number | null) => Promise<void>;
  /**
   * Make a geom dentable, converting a primitive into the mesh it looked like.
   *
   * A dent moves vertices and a primitive has none, so this is what stands
   * between "tick the box" and a surface that can actually take a mark.
   * Returns false when the geom is something no mesh can be made of — a plane.
   */
  makeDentable: (nodeId: string, geomIndex: number, cfg: DentConfig) => boolean;
  /** Put one broken weld back, without resetting the rest of the scene. */
  restoreConstraint: (key: string) => void;
}

export function breakageActions({ set, get }: SliceDeps): BreakageActions {
  return {
    /*
     * A body has just been hit hard enough to matter.
     *
     * Shattering wins over denting when both apply: there is no point creasing
     * the surface of something that is about to stop existing. Both are decided
     * from the same measured impulse, which is what makes them read as one
     * material rather than as two unrelated features.
     */
    handleImpact: (event) => {
      const state = get();
      // Look the body up in the graph that is actually running: a shard has no
      // entry in the document, and a body that already broke has none either.
      const live = effectiveSceneGraph(state.sceneGraph, state.shatteredBodies);
      const node = findNodeById(live.nodes, event.nodeId);
      if (!node) return;

      // Already coming apart: the blow has nothing left to do to this body.
      const cutting = fracturing.has(node.id);
      if (!state.shatteredBodies[node.id] && !cutting) {
        const wallM = node.shatterThicknessRef ? wallAtImpact(node, event.localPoint) : null;
        if (shatterVerdict(event.impulseNs, node, wallM)) {
          get().shatterNode(node, event, wallM);
          return;
        }
      }

      // Dent whatever was soft enough, on either end of the collision. The body
      // that reported the blow is usually the striker, so the thing that takes
      // the mark is usually the other one.
      const other = event.otherNodeId ? findNodeById(live.nodes, event.otherNodeId) : null;
      // Each end of the collision is marked by the shape of the other end.
      if (!cutting) dentBody(node, event.localPoint, event.localNormal, event.impulseNs, imprintOf(other?.geoms?.[0]));
      if (other && event.otherLocalPoint && event.otherLocalNormal) {
        dentBody(other, event.otherLocalPoint, event.otherLocalNormal, event.impulseNs, imprintOf(node.geoms?.[0]));
      }
    },

    /*
     * Replace a body with its pieces, in the runtime overlay only.
     *
     * The rebuild is NOT a force reset: the rest of the scene is mid-flight and
     * has to stay there. It changes the number of degrees of freedom, though, so
     * the worker cannot carry the state over by copying arrays — it matches
     * joints by name instead, which is what the by-joint branch of doBuild is for.
     */
    shatterNode: async (node, event, wallM) => {
      if (!shatterSourceOf(node)) return;

      // Stay inside the shard budget, counting pieces already promised to
      // bodies still being cut.
      const broken = get().shatteredBodies;
      let promised = 0;
      for (const n of fracturing.values()) promised += n;
      const pieces = Math.min(node.shatterPieces ?? DEFAULT_FRACTURE_PIECES, shardRoom(broken, node.id) - promised);
      if (pieces < 2) return;

      // Cut in the worker while the old model keeps stepping. The pieces are
      // posed from the impact, and rebaseShard moves them onto wherever the body
      // has got to by the time the rebuild lands, so the wait costs no accuracy.
      fracturing.set(node.id, pieces);
      const epoch = breakageEpoch;
      let shards: SceneNode[] | null;
      try {
        shards = await cutShards(node, event, pieces);
      } catch (err) {
        console.warn('[shatter]', err);
        shards = null;
      } finally {
        if (epoch === breakageEpoch) fracturing.delete(node.id);
      }
      // Reset, or a new scene, while it was being cut: that break never happened.
      if (epoch !== breakageEpoch) return;
      const nowBroken = get().shatteredBodies;
      if (nowBroken[node.id]) return;
      if (!findNodeById(effectiveSceneGraph(get().sceneGraph, nowBroken).nodes, node.id)) return;
      // Fewer than two pieces is not a shatter.
      if (!shards) return;

      set({
        shatteredBodies: { ...nowBroken, [node.id]: shards },
        lastShatter: { nodeId: node.id, name: node.name, pieces: shards.length, time: event.time, impulseNs: event.impulseNs, wallM: wallM ?? undefined },
      });
      scheduleShatterRebuild(() => get().recompile(undefined, undefined, false, true, false, true));
    },

    makeDentable: (nodeId, geomIndex, cfg) => {
      const node = findNodeById(get().sceneGraph.nodes, nodeId);
      const geom = node?.geoms?.[geomIndex];
      if (!node || !geom) return false;

      const updates: Partial<SceneGeom> = { ...cfg };
      if (!isDentable(geom)) {
        const mesh = meshForDenting(geom);
        if (!mesh) return false;
        updates.type = 'mesh';
        updates.vertices = mesh.vertices;
        updates.renderVertices = toRenderVertices(mesh.vertices);
        updates.faces = mesh.faces;
        // A fromto carried the shape's direction AND its offset. meshForDenting
        // has turned the vertices to face the right way; the offset moves to the
        // geom's pos, because these vertices are the collision geometry too and
        // MuJoCo recentres a mesh asset on its centroid. Bake the offset in and
        // the thing collides half its own length away from where it is drawn.
        if (geom.fromto) {
          updates.pos = fromtoCenter(geom.fromto);
          updates.fromto = undefined;
        }
        // A mesh geom on a body that can move has to say so, or it is drawn from
        // vertices baked once into world space and never tracks the body again:
        // it simulates and drags correctly and looks frozen in place.
        if ((node.joints || []).length > 0) updates.dynamic = true;
        // The shape is its own hull, so there is nothing for the decomposer to
        // find and every reason not to spend a rebuild looking.
        if (!node.collision) get().updateNode(node.id, { collision: 'hull' });
      }
      get().updateNodeGeom(node.id, updates, geomIndex);
      return true;
    },

    restoreConstraint: (key) => {
      const prev = get().brokenConstraints;
      if (!prev.includes(key)) return;
      const next = prev.filter((k) => k !== key);
      set({
        brokenConstraints: next,
        lastBreak: get().lastBreak?.key === key ? null : get().lastBreak,
      });
      // Undebounced and state-preserving: the weld comes back where the body is
      // now, not where it was when it broke.
      get().recompile(undefined, undefined, false, true);
    },
  };
}
