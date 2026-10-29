// ---------------------------------------------------------------------------
// MCP commands for breakage: crumple, impacts, breaks and restoring them
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { useDentStore } from '../../store/dentStore';
import { isDentable, needsConversionForDenting } from '../../utils/dentMesh';
import type { DentConfig } from '../../utils/breakThresholds';
import type { SceneNode } from '../../types/scene';
import { type Msg, findNodeInScene } from './bridgeUtils';
import type { McpCommands } from './types';

export const breakageCommands: McpCommands = {
    /*
     * What has come apart in this run, and putting it back.
     *
     * Breakage is transient — the scene graph still says everything is
     * welded on — so this is the only way to see it from outside.
     */
    /*
     * A crumple zone: a joint that is rigid until it is overloaded, and
     * then folds and stays folded.
     *
     * Set on a JOINT rather than on a body, because that is what folds. The
     * lock holding it still is an ordinary weld equality the MJCF builder
     * emits, so nothing new reaches the solver.
     */
  SET_CRUMPLE: async (msg, { store }) => {
    const { targetId, jointName, crumpleTorqueNm, crumpleRangeDeg, crumpleDampingAfter } =
      msg as Msg<{
        targetId: string; jointName?: string;
        crumpleTorqueNm?: number | null;
        crumpleRangeDeg?: [number, number];
        crumpleDampingAfter?: number;
      }>;
    if (!targetId) throw new Error('Missing targetId');
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!node) throw new Error(`No object with id '${targetId}'`);

    const joints = node.joints || [];
    const joint = jointName
      ? joints.find((j) => j.name === jointName)
      : joints.find((j) => j.type === 'hinge' || j.type === 'slide');
    if (!joint) {
      return { ok: false, error: jointName
        ? `'${targetId}' has no joint named '${jointName}'`
        : `'${targetId}' has no hinge or slider to crumple — a free or ball joint has no single axis to fold about` };
    }

    const updates: Partial<typeof joint> = {};
    if (crumpleTorqueNm !== undefined) updates.crumpleTorqueNm = crumpleTorqueNm ?? undefined;
    if (crumpleRangeDeg !== undefined) updates.crumpleRangeDeg = crumpleRangeDeg;
    if (crumpleDampingAfter !== undefined) updates.crumpleDampingAfter = crumpleDampingAfter;
    store.updateNodeJoint(node.id, updates, joints.indexOf(joint));

    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id)
      ?.joints?.find((j) => j.name === joint.name);
    return {
      ok: true, id: node.id, joint: joint.name,
      crumpleTorqueNm: after?.crumpleTorqueNm ?? null,
      crumpleRangeDeg: after?.crumpleRangeDeg ?? null,
      crumpleDampingAfter: after?.crumpleDampingAfter ?? null,
    };
  },
  GET_BREAKS: async () => {
    const state = useStore.getState();
    const dents = useDentStore.getState().dents;
    return {
      ok: true,
      // Weld keys look like 'weld:<nodeId>-><targetId>'; a crumple zone
      // that has given looks like 'crumple:<jointName>'. A part broken
      // (or bent) under load is 'member:<nodeId>'; one that came out of
      // a join blob 'join:<blobId>><nodeId>' (glue) or
      // 'pin:<blobId>><nodeId>' (putty). `last.cause` says how: pulled,
      // sheared, bent or buckled.
      broken: state.brokenConstraints,
      last: state.lastBreak ?? null,
      shattered: Object.entries(state.shatteredBodies).map(([id, shards]) => ({ id, pieces: shards.length })),
      lastShatter: state.lastShatter ?? null,
      dented: Object.entries(dents).map(([key, d]) => ({
        key, dents: d.count, deepestMm: +(d.deepest * 1000).toFixed(2),
      })),
    };
  },
    /*
     * Brittleness and dentability, the two impact thresholds.
     *
     * Both are measured in newton-seconds — momentum — rather than force,
     * because contact force in a hard solver is a spike whose height
     * depends on the timestep. Neither reaches the emitted MJCF: they are
     * compared every step against what MuJoCo already reports.
     */
  SET_IMPACT: async (msg, { store }) => {
    const { targetId, shatterImpulseNs, shatterPieces, shatterSeed, shatterPattern, shatterSpread, shatterDepth,
            dentYieldNs, dentDepthPerNs, dentRadius, dentMaxDepth, pierceImpulseNs, deformCollision, geomName } =
      msg as Msg<{
        targetId: string;
        shatterImpulseNs?: number | null; shatterPieces?: number; shatterSeed?: number;
        shatterPattern?: 'uniform' | 'radial'; shatterSpread?: number; shatterDepth?: number;
        dentYieldNs?: number | null; dentDepthPerNs?: number; dentRadius?: number; dentMaxDepth?: number;
        pierceImpulseNs?: number | null; deformCollision?: boolean;
        geomName?: string;
      }>;
    if (!targetId) throw new Error('Missing targetId');
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!node) throw new Error(`No object with id '${targetId}'`);

    const nodeUpdates: Partial<SceneNode> = {};
    if (shatterImpulseNs !== undefined) nodeUpdates.shatterImpulseNs = shatterImpulseNs ?? undefined;
    if (shatterPieces !== undefined) nodeUpdates.shatterPieces = shatterPieces;
    if (shatterSeed !== undefined) nodeUpdates.shatterSeed = shatterSeed;
    if (shatterPattern !== undefined) nodeUpdates.shatterPattern = shatterPattern;
    if (shatterSpread !== undefined) nodeUpdates.shatterSpread = shatterSpread;
    if (shatterDepth !== undefined) nodeUpdates.shatterDepth = shatterDepth;
    if (Object.keys(nodeUpdates).length > 0) store.updateNode(node.id, nodeUpdates);

    const wantsDent = dentYieldNs !== undefined || dentDepthPerNs !== undefined
      || dentRadius !== undefined || dentMaxDepth !== undefined || pierceImpulseNs !== undefined
      || deformCollision !== undefined;
    let dentedGeom: string | null = null;
    let convertedToMesh = false;
    if (wantsDent) {
      /*
       * A primitive is converted rather than refused.
       *
       * A dent moves vertices and a primitive has none — a box is six
       * numbers the solver evaluates, not eight corners — so making one
       * dentable means rebuilding it as the mesh it already looked like.
       * `makeDentable` does that, and is the same path the inspector's
       * checkbox takes.
       */
      const geoms = node.geoms || [];
      const idx = geomName
        ? geoms.findIndex((g) => g.name === geomName)
        : geoms.findIndex((g) => isDentable(g) || needsConversionForDenting(g));
      if (idx < 0) {
        return { ok: false, error: geomName
          ? `'${targetId}' has no geom named '${geomName}'`
          : `'${targetId}' has no surface that can be dented` };
      }
      const cfg: DentConfig = {};
      if (dentYieldNs !== undefined) cfg.dentYieldNs = dentYieldNs ?? undefined;
      if (dentDepthPerNs !== undefined) cfg.dentDepthPerNs = dentDepthPerNs;
      if (dentRadius !== undefined) cfg.dentRadius = dentRadius;
      if (dentMaxDepth !== undefined) cfg.dentMaxDepth = dentMaxDepth;
      if (pierceImpulseNs !== undefined) cfg.pierceImpulseNs = pierceImpulseNs ?? undefined;
      if (deformCollision !== undefined) cfg.deformCollision = deformCollision || undefined;
      const converted = needsConversionForDenting(geoms[idx]);
      if (!store.makeDentable(node.id, idx, cfg)) {
        return { ok: false, error: `'${geoms[idx].name}' is a ${geoms[idx].type}, which has no surface a dent can be made in` };
      }
      dentedGeom = geoms[idx].name;
      if (converted) convertedToMesh = true;
    }

    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    return {
      ok: true, id: node.id, name: node.name,
      shatterImpulseNs: after?.shatterImpulseNs ?? null,
      shatterPieces: after?.shatterPieces ?? null,
      dentGeom: dentedGeom,
      // Worth saying: the body's geom type changed under the caller.
      convertedToMesh,
      dentYieldNs: dentedGeom
        ? (after?.geoms || []).find((g) => g.name === dentedGeom)?.dentYieldNs ?? null
        : null,
    };
  },
  RESTORE_BREAK: async (msg) => {
    const { key } = msg as Msg<{ key?: string }>;
    const state = useStore.getState();
    if (!key) {
      // No key means "put everything back", which is what Reset does.
      state.resetSimulation();
      return { ok: true, restored: 'all' };
    }
    if (!state.brokenConstraints.includes(key)) {
      return { ok: false, error: `'${key}' is not broken` };
    }
    state.restoreConstraint(key);
    return { ok: true, restored: key };
  },
};
