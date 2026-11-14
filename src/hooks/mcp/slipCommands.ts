// ---------------------------------------------------------------------------
// MCP commands for slip-cast molds and Add Draft (the Mold dialog's Slip Cast
// and Draft tabs)
// ---------------------------------------------------------------------------

import { planSlipMold, simulateSlipCastOffThread } from '../../utils/slipMoldClient';
import { addSlipCastToScene, addSlipMoldToScene, slipCaseStls, slipCastInput } from '../../utils/slipMoldActions';
import { DEFAULT_SLIP_WALL_MM } from '../../utils/slipCastSimulation';
import { MAX_SLIP_SIDES, type SlipMoldOptions } from '../../utils/slipCastMold';
import { SLIPS, isSlipId, resolveCastMaterial } from '../../utils/castMaterials';
import { applyAddDraft, MAX_ADD_DRAFT_DEG } from '../../utils/addDraftAction';
import { DEFAULT_TAB_DRAFT } from '../../utils/moldTabs';
import { mcpMoldSubject } from '../../utils/moldSubject';
import { findNodeInScene, describeFiles } from './bridgeUtils';
import type { McpCommands } from './types';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export const slipCommands: McpCommands = {
  /*
   * A plaster mold for slip casting round the given bodies (default: every
   * body), in n pieces, and a printed case per piece that casts it in plaster.
   * Reports the pieces, the plaster and the slip; apply adds them to the scene;
   * the cases come back as STLs, stood open side up.
   */
  MAKE_SLIP_MOLD: async (msg, { store }) => {
    const subject = mcpMoldSubject(store.sceneGraph, msg.bodyId ?? msg.masterId, (id) => findNodeInScene(store.sceneGraph.nodes, id));
    if ('error' in subject) return { ok: false, error: subject.error };
    const options: Partial<SlipMoldOptions> = {};
    if (msg.sides !== undefined && msg.sides !== 'auto') {
      const n = num(msg.sides);
      if (n === undefined || n < 2 || n > MAX_SLIP_SIDES || !Number.isInteger(n)) return { ok: false, error: `sides is 'auto' or a whole number from 2 to ${MAX_SLIP_SIDES}.` };
      options.sides = n;
    }
    if (typeof msg.base === 'boolean' || msg.base === 'auto') options.base = msg.base;
    if (typeof msg.fillInside === 'boolean') options.fillInside = msg.fillInside;
    for (const key of ['plasterMm', 'spareHeightMm', 'spareDiaMm', 'caseWallMm', 'freeboardMm', 'natchDiaMm', 'baseTaperDeg', 'draftDeg'] as const) {
      const v = num(msg[key]);
      if (v !== undefined) options[key] = v;
    }
    const shrink = num(msg.shrinkPercent);
    if (shrink !== undefined) options.shrinkPercent = shrink;
    const slipName = msg.slip ?? msg.castMaterial;
    if (slipName !== undefined) {
      const slip = resolveCastMaterial(slipName);
      if (!isSlipId(slip)) return { ok: false, error: `slip is one of ${SLIPS.map((m) => m.id).join(', ')}.` };
      options.slip = slip;
    }
    let mold;
    try {
      mold = await planSlipMold(store.sceneGraph, subject.ids, options);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const added = msg.apply === true ? await addSlipMoldToScene(subject.ids, options, mold) : null;
    // The casting it makes: the clay wall built, drained, trimmed and fired.
    let cast: Record<string, unknown> | undefined;
    if (msg.simulateCast === true) {
      const wall = num(msg.castWallMm) ?? DEFAULT_SLIP_WALL_MM;
      try {
        const result = await simulateSlipCastOffThread(slipCastInput(mold), wall);
        const sim = msg.apply === true ? await addSlipCastToScene(result, mold) : null;
        cast = { wallMm: result.wallMm, firedWallMm: result.firedWallMm, sizeMm: result.sizeMm, volumeMm3: result.volumeMm3, weightG: result.weightG, notes: result.notes, ...(sim ? { addedId: sim.id } : {}) };
      } catch (e) {
        cast = { error: (e as Error).message };
      }
    }
    const { warnings, ...summary } = mold.report;
    return {
      ok: true,
      summary: {
        ...summary,
        part: subject.ids,
        pieces: mold.pieces.map((p) => ({
          name: p.name,
          pull: p.pull.map((v) => +v.toFixed(3)),
          plasterMm3: p.plasterMm3,
          caseSizeMm: p.caseSizeMm,
          undercutMm2: p.undercutMm2,
          natches: p.natches,
        })),
        ...(added ? { added: { plasterIds: added.plasterIds, caseIds: added.caseIds } } : {}),
        ...(cast ? { cast } : {}),
      },
      warnings,
      files: describeFiles(
        slipCaseStls(subject.label.replace(/[^A-Za-z0-9_-]+/g, '_'), mold).map((f) => ({ name: `${f.file}.stl`, bytes: f.bytes })),
        msg.includeFiles !== false,
      ),
    };
  },

  /*
   * Tapers the given bodies (default: every body) to pull straight up along
   * the scene's Z as they stand, from their lowest point; baked into them as
   * meshes, one undo step.
   */
  ADD_DRAFT: async (msg, { store }) => {
    const subject = mcpMoldSubject(store.sceneGraph, msg.bodyId, (id) => findNodeInScene(store.sceneGraph.nodes, id), 'draft');
    if ('error' in subject) return { ok: false, error: subject.error };
    const deg = num(msg.draftDeg) ?? DEFAULT_TAB_DRAFT.draft;
    if (deg <= 0 || deg > MAX_ADD_DRAFT_DEG) return { ok: false, error: `draft_deg is more than 0 and at most ${MAX_ADD_DRAFT_DEG}.` };
    if (msg.keep !== undefined && msg.keep !== 'top' && msg.keep !== 'base') return { ok: false, error: "keep is 'top' (add material) or 'base' (remove material)." };
    if (store.sceneGraph.castPrep?.draftDeg) return { ok: false, error: 'Prepare for Casting has already drafted the part; switch it off first (physics_set_cast_prep enabled: false).' };
    const r = applyAddDraft(subject.ids, deg, msg.keep === 'base' ? 'remove' : 'add');
    if (r.error) return { ok: false, error: r.error };
    return {
      ok: true,
      draftDeg: deg,
      keep: msg.keep === 'base' ? 'base' : 'top',
      partingZMm: +(r.partingZ * 1000).toFixed(2),
      drafted: r.drafted,
      ...(r.skipped.length ? { skipped: r.skipped } : {}),
    };
  },
};
