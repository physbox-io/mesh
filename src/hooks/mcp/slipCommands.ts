// ---------------------------------------------------------------------------
// MCP commands for slip-cast molds and Add Draft (the Mold dialog's Slip Cast
// and Draft tabs)
// ---------------------------------------------------------------------------

import { planSlipMold, simulateSlipCastOffThread } from '../../utils/slipMoldClient';
import { addSlipCastToScene, addSlipMoldToScene, slipCaseStls, slipCastInput, slipPartWarnings } from '../../utils/slipMoldActions';
import { DEFAULT_SLIP_WALL_MM } from '../../utils/slipCastSimulation';
import { MAX_SLIP_SIDES, type SlipMoldOptions } from '../../utils/slipCastMold';
import { SLIPS, isSlipId, resolveCastMaterial } from '../../utils/castMaterials';
import { applyAddDraft, MAX_ADD_DRAFT_DEG } from '../../utils/addDraftAction';
import { DEFAULT_TAB_DRAFT } from '../../utils/moldTabs';
import { mcpMoldSubject } from '../../utils/moldSubject';
import { findNodeInScene, describeFiles } from './bridgeUtils';
import type { McpCommands } from './types';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

function checkPos(v: unknown, name: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    return { ok: false, error: `${name} must be a positive finite number.` };
  }
  return { ok: true, value: v };
}

function checkNonNeg(v: unknown, name: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    return { ok: false, error: `${name} must be a non-negative finite number.` };
  }
  return { ok: true, value: v };
}

export const slipCommands: McpCommands = {
  /*
   * A plaster mold for slip casting round the given bodies (default: every
   * body), in n pieces, and a printed case per piece that casts it in plaster.
   * Reports the pieces, the plaster and the slip; apply adds them to the scene;
   * the cases come back as STLs, stood open side up.
   */
  MAKE_SLIP_MOLD: async (msg, { store, toId }) => {
    const rawTarget = msg.bodyId ?? msg.masterId;
    if (rawTarget !== undefined && rawTarget !== null && typeof rawTarget !== 'string') {
      return { ok: false, error: 'bodyId/masterId must be a string.' };
    }
    const subject = mcpMoldSubject(store.sceneGraph, rawTarget, (id) => findNodeInScene(store.sceneGraph.nodes, (toId ? toId(id) : id) as string));
    if ('error' in subject) return { ok: false, error: subject.error };
    const options: Partial<SlipMoldOptions> = {};
    if (msg.sides !== undefined && msg.sides !== null && msg.sides !== 'auto') {
      const n = num(msg.sides);
      if (n === undefined || n < 2 || n > MAX_SLIP_SIDES || !Number.isInteger(n)) return { ok: false, error: `sides is 'auto' or a whole number from 2 to ${MAX_SLIP_SIDES}.` };
      options.sides = n;
    }
    if (msg.base !== undefined && msg.base !== null) {
      if (typeof msg.base !== 'boolean' && msg.base !== 'auto') {
        return { ok: false, error: "base must be a boolean or 'auto'." };
      }
      options.base = msg.base;
    }
    if (typeof msg.fillInside === 'boolean') options.fillInside = msg.fillInside;
    if (typeof msg.splitCase === 'boolean') options.splitCase = msg.splitCase;

    for (const key of ['plasterMm', 'plasterBudgetG', 'spareHeightMm', 'spareDiaMm', 'caseWallMm', 'natchDiaMm'] as const) {
      const chk = checkPos(msg[key], key);
      if (!chk.ok) return chk;
      if (chk.value !== undefined) options[key] = chk.value;
    }
    for (const key of ['freeboardMm', 'baseTaperDeg', 'draftDeg', 'shrinkPercent'] as const) {
      const chk = checkNonNeg(msg[key], key);
      if (!chk.ok) return chk;
      if (chk.value !== undefined) options[key] = chk.value;
    }
    const castWallChk = checkPos(msg.castWallMm, 'castWallMm');
    if (!castWallChk.ok) return castWallChk;

    if (msg.spareAtMm !== undefined && msg.spareAtMm !== null) {
      const a = msg.spareAtMm;
      if (!Array.isArray(a) || a.length < 2 || !a.slice(0, 2).every((v: unknown) => num(v) !== undefined)) return { ok: false, error: 'spare_at_mm is [x, y] in scene mm.' };
      options.spareAtMm = [a[0], a[1]];
    }
    const slipName = msg.slip ?? msg.castMaterial;
    if (slipName !== undefined && slipName !== null) {
      if (typeof slipName !== 'string') return { ok: false, error: `slip is one of ${SLIPS.map((m) => m.id).join(', ')}.` };
      const slip = resolveCastMaterial(slipName);
      if (!isSlipId(slip)) return { ok: false, error: `slip is one of ${SLIPS.map((m) => m.id).join(', ')}.` };
      options.slip = slip;
    }
    let mold;
    try {
      mold = await planSlipMold(store.sceneGraph, subject.ids, options);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    let added = null;
    if (msg.apply === true) {
      try {
        added = await addSlipMoldToScene(subject.ids, options, mold);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    // The casting it makes: the clay wall built, drained, trimmed and fired.
    let cast: Record<string, unknown> | undefined;
    const castWarnings: string[] = [];
    if (msg.simulateCast === true) {
      const wall = castWallChk.value ?? DEFAULT_SLIP_WALL_MM;
      try {
        const result = await simulateSlipCastOffThread(slipCastInput(mold), wall);
        const sim = msg.apply === true ? await addSlipCastToScene(result, mold, subject.ids) : null;
        castWarnings.push(...result.warnings.map((w) => `Cast: ${w}`));
        cast = { wallMm: result.wallMm, firedWallMm: result.firedWallMm, sizeMm: result.sizeMm, volumeMm3: result.volumeMm3, weightG: result.weightG, notes: result.notes, ...(sim ? { addedId: sim.id } : {}) };
      } catch (e) {
        cast = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    const { warnings, ...summary } = mold.report;
    let partWarnings: string[];
    try {
      partWarnings = await slipPartWarnings(subject.scene, mold.slip);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
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
          caseParts: p.caseParts.map((cp) => ({ key: cp.key, role: cp.role, sizeMm: cp.sizeMm })),
          undercutMm2: p.undercutMm2,
          natches: p.natches,
        })),
        ...(added ? { added: { plasterIds: added.plasterIds, caseIds: added.caseIds } } : {}),
        ...(added?.replaced.length ? { replaced: added.replaced } : {}),
        ...(cast ? { cast } : {}),
      },
      warnings: [...warnings, ...partWarnings, ...castWarnings],
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
  ADD_DRAFT: async (msg, { store, toId }) => {
    if (msg.bodyId !== undefined && msg.bodyId !== null && typeof msg.bodyId !== 'string') {
      return { ok: false, error: 'bodyId must be a string.' };
    }
    const subject = mcpMoldSubject(store.sceneGraph, msg.bodyId, (id) => findNodeInScene(store.sceneGraph.nodes, (toId ? toId(id) : id) as string), 'draft');
    if ('error' in subject) return { ok: false, error: subject.error };
    let deg: number;
    if (msg.draftDeg === undefined || msg.draftDeg === null) {
      deg = DEFAULT_TAB_DRAFT.draft;
    } else {
      const parsed = num(msg.draftDeg);
      if (parsed === undefined || parsed <= 0 || parsed > MAX_ADD_DRAFT_DEG) {
        return { ok: false, error: `draft_deg is more than 0 and at most ${MAX_ADD_DRAFT_DEG}.` };
      }
      deg = parsed;
    }
    if (msg.keep !== undefined && msg.keep !== null && msg.keep !== 'top' && msg.keep !== 'base') {
      return { ok: false, error: "keep is 'top' (add material) or 'base' (remove material)." };
    }
    if (store.sceneGraph.castPrep?.draftDeg) return { ok: false, error: 'Prepare for Casting has already drafted the part; switch it off first (physics_set_cast_prep off: true).' };
    try {
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
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
