// ---------------------------------------------------------------------------
// MCP commands for breakage: crumple, impacts, breaks and restoring them
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { useDentStore } from '../../store/dentStore';
import { isDentable, needsConversionForDenting } from '../../utils/dentMesh';
import type { DentConfig } from '../../utils/breakThresholds';
import { MIN_FRACTURE_PIECES, MAX_FRACTURE_PIECES } from '../../utils/fracture';
import type { SceneGeom, SceneNode } from '../../types/scene';
import { type Msg, findNodeInScene } from './bridgeUtils';
import type { McpCommands } from './types';

const isNonNegFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPosFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;

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
      : joints.find((j) => j.type === 'hinge');
    if (!joint) {
      return { ok: false, error: jointName
        ? `'${targetId}' has no joint named '${jointName}'`
        : `'${targetId}' has no hinge joint to crumple — a free, ball, or slide joint cannot fold about a single rotational axis` };
    }
    if (joint.type !== 'hinge') {
      return {
        ok: false,
        error: `Joint '${joint.name}' on '${targetId}' is a ${joint.type} joint — crumple only supports hinge joints (a ${joint.type} joint has no single rotational axis to fold about)`,
      };
    }

    if (crumpleTorqueNm !== undefined && crumpleTorqueNm !== null && !isNonNegFinite(crumpleTorqueNm)) {
      return { ok: false, error: 'crumpleTorqueNm must be a non-negative finite number or null' };
    }
    if (crumpleRangeDeg !== undefined && crumpleRangeDeg !== null) {
      if (
        !Array.isArray(crumpleRangeDeg) ||
        crumpleRangeDeg.length !== 2 ||
        typeof crumpleRangeDeg[0] !== 'number' ||
        typeof crumpleRangeDeg[1] !== 'number' ||
        !Number.isFinite(crumpleRangeDeg[0]) ||
        !Number.isFinite(crumpleRangeDeg[1]) ||
        crumpleRangeDeg[0] > crumpleRangeDeg[1]
      ) {
        return { ok: false, error: 'crumpleRangeDeg must be [minDeg, maxDeg] finite numbers with min <= max, or null' };
      }
    }
    if (crumpleDampingAfter !== undefined && crumpleDampingAfter !== null && !isNonNegFinite(crumpleDampingAfter)) {
      return { ok: false, error: 'crumpleDampingAfter must be a non-negative finite number or null' };
    }

    const updates: Partial<typeof joint> = {};
    if (crumpleTorqueNm !== undefined) updates.crumpleTorqueNm = crumpleTorqueNm ?? undefined;
    if (crumpleRangeDeg !== undefined) {
      updates.crumpleRangeDeg = crumpleRangeDeg === null ? undefined : [crumpleRangeDeg[0], crumpleRangeDeg[1]];
    } else if (crumpleTorqueNm === null) {
      // Clearing crumple also clears range/damping unless explicitly replaced so limited="true" isn't stranded.
      updates.crumpleRangeDeg = undefined;
    }
    if (crumpleDampingAfter !== undefined) {
      updates.crumpleDampingAfter = crumpleDampingAfter ?? undefined;
    } else if (crumpleTorqueNm === null) {
      updates.crumpleDampingAfter = undefined;
    }
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
        dentYieldNs?: number | null; dentDepthPerNs?: number | null; dentRadius?: number | null; dentMaxDepth?: number | null;
        pierceImpulseNs?: number | null; deformCollision?: boolean;
        geomName?: string;
      }>;
    if (!targetId) throw new Error('Missing targetId');
    const node = findNodeInScene(store.sceneGraph.nodes, targetId);
    if (!node) throw new Error(`No object with id '${targetId}'`);

    // Validate ALL parameters upfront before mutating store state.
    if (shatterImpulseNs !== undefined && shatterImpulseNs !== null && !isPosFinite(shatterImpulseNs)) {
      return { ok: false, error: 'shatterImpulseNs must be a positive finite number or null' };
    }
    if (shatterPieces !== undefined && (typeof shatterPieces !== 'number' || !Number.isInteger(shatterPieces) || shatterPieces < MIN_FRACTURE_PIECES || shatterPieces > MAX_FRACTURE_PIECES)) {
      return { ok: false, error: `shatterPieces must be an integer between ${MIN_FRACTURE_PIECES} and ${MAX_FRACTURE_PIECES}` };
    }
    if (shatterSeed !== undefined && !(typeof shatterSeed === 'number' && Number.isFinite(shatterSeed))) {
      return { ok: false, error: 'shatterSeed must be a finite number' };
    }
    if (shatterPattern !== undefined && shatterPattern !== 'radial' && shatterPattern !== 'uniform') {
      return { ok: false, error: "shatterPattern must be 'radial' or 'uniform'" };
    }
    if (shatterSpread !== undefined && !isNonNegFinite(shatterSpread)) {
      return { ok: false, error: 'shatterSpread must be a non-negative finite number' };
    }
    if (shatterDepth !== undefined && (typeof shatterDepth !== 'number' || !Number.isInteger(shatterDepth) || shatterDepth < 0 || shatterDepth > 2)) {
      return { ok: false, error: 'shatterDepth must be an integer between 0 and 2' };
    }
    if (dentYieldNs !== undefined && dentYieldNs !== null && !isPosFinite(dentYieldNs)) {
      return { ok: false, error: 'dentYieldNs must be a positive finite number or null' };
    }
    if (dentDepthPerNs !== undefined && dentDepthPerNs !== null && !isPosFinite(dentDepthPerNs)) {
      return { ok: false, error: 'dentDepthPerNs must be a positive finite number or null' };
    }
    if (dentRadius !== undefined && dentRadius !== null && !isPosFinite(dentRadius)) {
      return { ok: false, error: 'dentRadius must be a positive finite number or null' };
    }
    if (dentMaxDepth !== undefined && dentMaxDepth !== null && !isPosFinite(dentMaxDepth)) {
      return { ok: false, error: 'dentMaxDepth must be a positive finite number or null' };
    }
    if (pierceImpulseNs !== undefined && pierceImpulseNs !== null && !isPosFinite(pierceImpulseNs)) {
      return { ok: false, error: 'pierceImpulseNs must be a positive finite number or null' };
    }
    if (deformCollision !== undefined && typeof deformCollision !== 'boolean') {
      return { ok: false, error: 'deformCollision must be a boolean' };
    }
    if (geomName !== undefined && typeof geomName !== 'string') {
      return { ok: false, error: 'geomName must be a string' };
    }

    const wantsDent = dentYieldNs !== undefined || dentDepthPerNs !== undefined
      || dentRadius !== undefined || dentMaxDepth !== undefined || pierceImpulseNs !== undefined
      || deformCollision !== undefined;
    const enablingDent = typeof dentYieldNs === 'number' || typeof dentDepthPerNs === 'number'
      || typeof dentRadius === 'number' || typeof dentMaxDepth === 'number'
      || typeof pierceImpulseNs === 'number' || deformCollision === true;

    const geoms = node.geoms || [];
    let dentIdx = -1;
    if (wantsDent) {
      if (enablingDent) {
        dentIdx = geomName
          ? geoms.findIndex((g) => g.name === geomName)
          : geoms.findIndex((g) => isDentable(g) || needsConversionForDenting(g));
        if (dentIdx < 0) {
          return { ok: false, error: geomName
            ? `'${targetId}' has no geom named '${geomName}'`
            : `'${targetId}' has no surface that can be dented` };
        }
        if (!isDentable(geoms[dentIdx]) && !needsConversionForDenting(geoms[dentIdx])) {
          return { ok: false, error: `'${geoms[dentIdx].name}' is a ${geoms[dentIdx].type}, which has no surface a dent can be made in` };
        }
      } else {
        // Clearing-only path (e.g. dentYieldNs: null / pierceImpulseNs: null / deformCollision: false):
        // Never convert primitives to meshes just to clear dent properties.
        if (geomName) {
          dentIdx = geoms.findIndex((g) => g.name === geomName);
          if (dentIdx < 0) {
            return { ok: false, error: `'${targetId}' has no geom named '${geomName}'` };
          }
        } else {
          dentIdx = geoms.findIndex((g) =>
            g.dentYieldNs !== undefined || g.pierceImpulseNs !== undefined || g.deformCollision !== undefined
            || g.dentDepthPerNs !== undefined || g.dentRadius !== undefined || g.dentMaxDepth !== undefined,
          );
        }
      }
    }

    const nodeUpdates: Partial<SceneNode> = {};
    if (shatterImpulseNs !== undefined) nodeUpdates.shatterImpulseNs = shatterImpulseNs ?? undefined;
    if (shatterPieces !== undefined) nodeUpdates.shatterPieces = shatterPieces;
    if (shatterSeed !== undefined) nodeUpdates.shatterSeed = shatterSeed;
    if (shatterPattern !== undefined) nodeUpdates.shatterPattern = shatterPattern;
    if (shatterSpread !== undefined) nodeUpdates.shatterSpread = shatterSpread;
    if (shatterDepth !== undefined) nodeUpdates.shatterDepth = shatterDepth;
    if (Object.keys(nodeUpdates).length > 0) store.updateNode(node.id, nodeUpdates);

    let dentedGeom: string | null = null;
    let convertedToMesh = false;
    if (wantsDent && dentIdx >= 0) {
      if (enablingDent) {
        const cfg: DentConfig = {};
        if (dentYieldNs !== undefined) cfg.dentYieldNs = dentYieldNs ?? undefined;
        if (dentDepthPerNs !== undefined) cfg.dentDepthPerNs = dentDepthPerNs !== null ? dentDepthPerNs / 1000 : undefined;
        if (dentRadius !== undefined) cfg.dentRadius = dentRadius !== null ? dentRadius / 1000 : undefined;
        if (dentMaxDepth !== undefined) cfg.dentMaxDepth = dentMaxDepth !== null ? dentMaxDepth / 1000 : undefined;
        if (pierceImpulseNs !== undefined) cfg.pierceImpulseNs = pierceImpulseNs ?? undefined;
        if (deformCollision !== undefined) cfg.deformCollision = deformCollision || undefined;
        const converted = needsConversionForDenting(geoms[dentIdx]);
        if (!store.makeDentable(node.id, dentIdx, cfg)) {
          return { ok: false, error: `'${geoms[dentIdx].name}' is a ${geoms[dentIdx].type}, which has no surface a dent can be made in` };
        }
        dentedGeom = geoms[dentIdx].name;
        if (converted) convertedToMesh = true;
      } else {
        const clearUpdates: Partial<SceneGeom> = {};
        if (dentYieldNs === null) {
          clearUpdates.dentYieldNs = undefined;
          clearUpdates.dentDepthPerNs = undefined;
          clearUpdates.dentRadius = undefined;
          clearUpdates.dentMaxDepth = undefined;
          clearUpdates.deformCollision = undefined;
        }
        if (dentDepthPerNs === null) clearUpdates.dentDepthPerNs = undefined;
        if (dentRadius === null) clearUpdates.dentRadius = undefined;
        if (dentMaxDepth === null) clearUpdates.dentMaxDepth = undefined;
        if (pierceImpulseNs === null) clearUpdates.pierceImpulseNs = undefined;
        if (deformCollision === false) clearUpdates.deformCollision = undefined;
        store.updateNodeGeom(node.id, clearUpdates, dentIdx);
        dentedGeom = geoms[dentIdx].name;
      }
    }

    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    const afterGeom = dentedGeom ? (after?.geoms || []).find((g) => g.name === dentedGeom) : undefined;
    return {
      ok: true, id: node.id, name: node.name,
      shatterImpulseNs: after?.shatterImpulseNs ?? null,
      shatterPieces: after?.shatterPieces ?? null,
      dentGeom: dentedGeom,
      // Worth saying: the body's geom type changed under the caller.
      convertedToMesh,
      dentYieldNs: afterGeom?.dentYieldNs ?? null,
      ...(pierceImpulseNs !== undefined ? { pierceImpulseNs: afterGeom?.pierceImpulseNs ?? null } : {}),
    };
  },
  RESTORE_BREAK: async (msg) => {
    const { key } = msg as Msg<{ key?: unknown }>;
    const state = useStore.getState();
    if (key === undefined || key === null) {
      // No key means "put everything back", which is what Reset does.
      state.resetSimulation();
      return { ok: true, restored: 'all' };
    }
    if (typeof key !== 'string' || key.length === 0) {
      return { ok: false, error: 'key must be a non-empty broken constraint key string (or omit to reset all)' };
    }
    if (!state.brokenConstraints.includes(key)) {
      return { ok: false, error: `'${key}' is not broken` };
    }
    state.restoreConstraint(key);
    return { ok: true, restored: key };
  },
};
