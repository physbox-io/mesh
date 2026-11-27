// ---------------------------------------------------------------------------
// MCP commands for molds and casting, and Split for Print
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { generateCastPattern, DEFAULT_CAST_OPTIONS, rememberCastOptions, type CastMethod, type CastResult } from '../../utils/castPatternExporter';
import { ExportWorkerClient } from '../../utils/exportWorkerClient';
import { runCastPrep } from '../../utils/castPrepRunner';
import { planPourBox } from '../../utils/pourBoxScene';
import { addPourBoxToScene, pourBoxStlFiles } from '../../utils/pourBoxActions';
import { type PourBoxOptions } from '../../utils/siliconeMold';
import { CAST_METALS, SILICONES, isSiliconeId, resolveCastMaterial } from '../../utils/castMaterials';
import { mcpMoldSubject } from '../../utils/moldSubject';
import { DEFAULT_TAB_DRAFT } from '../../utils/moldTabs';
import { selectionSoups, splitOffThread, testAssemblyOffThread } from '../../utils/printSplitClient';
import { filamentSpec } from '../../utils/filaments';
import { exportPrintFiles } from '../../utils/printExport';
import { isBoughtIn } from '../../utils/boughtIn';
import { findNodeInScene, describeFiles } from './bridgeUtils';
import type { McpCommands } from './types';
import type { SceneNode } from '../../types/scene';

/**
 * What an export is called: the one body asked for by id, else the scene's
 * name, else the one body in the scene, else the preset it came from, else
 * the first printable body's name, else 'scene'. Never 'empty', the blank
 * scene's preset id, which named every file built from scratch empty.stl.
 */
function exportFileBase(store: { sceneGraph: { name?: string; nodes: SceneNode[] }; activePreset?: string }, ids: string[]): string {
  const asked = ids.length === 1 ? findNodeInScene(store.sceneGraph.nodes, ids[0]) : undefined;
  if (asked) return asked.name || asked.id;
  const bodies = ids.length
    ? ids
    : store.sceneGraph.nodes.filter((n) => !n.simulation && !isBoughtIn(n)).map((n) => n.id);
  const only = bodies.length === 1 ? store.sceneGraph.nodes.find((n) => n.id === bodies[0])?.name : undefined;
  const first = bodies.length > 0 ? store.sceneGraph.nodes.find((n) => n.id === bodies[0])?.name : undefined;
  const preset = store.activePreset && store.activePreset !== 'empty' ? store.activePreset.replace(/^user:/, '') : undefined;
  return store.sceneGraph.name || only || preset || first || 'scene';
}

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

export const castCommands: McpCommands = {
    /*
     * A printed pour box for a silicone mold of the given bodies (default:
     * every body): base with a groove, sleeve, and an
     * optional hole through the silicone (wick, pour or fixing). Reports the fill line and the silicone; apply adds
     * the pieces to the scene; files come back as for EXPORT_CAST.
     */
  MAKE_POUR_BOX: async (msg, { store, toId }) => {
    const rawTarget = msg.bodyId ?? msg.masterId;
    if (rawTarget !== undefined && rawTarget !== null && typeof rawTarget !== 'string') {
      return { ok: false, error: 'bodyId/masterId must be a string.' };
    }
    // The master: body_id, else every body (never the UI selection, which an agent cannot see).
    const resolveId = (v: unknown) => (toId ? toId(v) : v);
    const subject = mcpMoldSubject(store.sceneGraph, rawTarget, (id) => findNodeInScene(store.sceneGraph.nodes, resolveId(id) as string));
    if ('error' in subject) return { ok: false, error: subject.error };
    const ids = subject.ids;
    const options: Partial<PourBoxOptions> = {};
    for (const key of ['coverMm', 'wallMm', 'baseMm', 'siliconeBudgetG'] as const) {
      const chk = checkPos(msg[key], key);
      if (!chk.ok) return chk;
      if (chk.value !== undefined) options[key] = chk.value;
    }
    const floorChk = checkPos(msg.floorMm, 'floorMm');
    if (!floorChk.ok) return floorChk;
    for (const key of ['clearanceMm', 'grooveMm', 'freeboardMm'] as const) {
      const chk = checkNonNeg(msg[key], key);
      if (!chk.ok) return chk;
      if (chk.value !== undefined) options[key] = chk.value;
    }
    if (msg.shape !== undefined && msg.shape !== null) {
      if (msg.shape !== 'fit' && msg.shape !== 'round' && msg.shape !== 'box') {
        return { ok: false, error: "shape is 'fit', 'round' or 'box'." };
      }
      options.shape = msg.shape;
    }
    if (msg.parting !== undefined && msg.parting !== null) {
      if (msg.parting !== 'auto' && msg.parting !== 'bottom' && msg.parting !== 'mid' && msg.parting !== 'top') {
        return { ok: false, error: "parting is 'auto', 'bottom', 'mid' or 'top'." };
      }
    }
    if (typeof msg.splitSleeve === 'boolean') options.splitSleeve = msg.splitSleeve;
    // A hole through the silicone and what it is for; `pin` is the older
    // name for a wick hole, and still means one.
    if (msg.hole !== undefined && msg.hole !== null && msg.hole !== 'none') {
      if (msg.hole !== 'wick' && msg.hole !== 'pour' && msg.hole !== 'fixing') {
        return { ok: false, error: "hole is 'wick', 'pour', 'fixing' or 'none'." };
      }
      options.hole = msg.hole;
    } else if (msg.pin === true) options.hole = 'wick';
    const holeDiaChk = checkPos(msg.holeDiaMm, 'holeDiaMm');
    if (!holeDiaChk.ok) return holeDiaChk;
    const pinDiaChk = checkPos(msg.pinDiaMm, 'pinDiaMm');
    if (!pinDiaChk.ok) return pinDiaChk;
    const holeDia = holeDiaChk.value ?? pinDiaChk.value;
    if (holeDia !== undefined) options.holeDiaMm = holeDia;
    if (msg.holeAtMm !== undefined && msg.holeAtMm !== null) {
      if (!Array.isArray(msg.holeAtMm) || msg.holeAtMm.length !== 2 || !msg.holeAtMm.every((v) => typeof v === 'number' && Number.isFinite(v))) {
        return { ok: false, error: 'holeAtMm must be [x, y] of finite numbers in mm.' };
      }
      options.holeAtMm = msg.holeAtMm as [number, number];
    }
    if (msg.silicone !== undefined && msg.silicone !== null) {
      if (typeof msg.silicone !== 'string') {
        return { ok: false, error: `silicone is one of ${SILICONES.map((m) => m.id).join(', ')}.` };
      }
      const silicone = resolveCastMaterial(msg.silicone);
      if (!isSiliconeId(silicone)) return { ok: false, error: `silicone is one of ${SILICONES.map((m) => m.id).join(', ')}.` };
      options.silicone = silicone;
    }
    let box;
    try {
      box = await planPourBox(store.sceneGraph, ids, options);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    let added = null;
    if (msg.apply === true) {
      try {
        added = await addPourBoxToScene(ids, options, box);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }
    const { warnings, ...summary } = box.report;
    return {
      ok: true,
      summary: {
        ...summary,
        master: ids,
        ...(box.hole ? { hole: { purpose: box.hole.purpose, diaMm: box.hole.diaMm } } : {}),
        ...(added ? { added: { baseId: added.baseId, sleeveId: added.sleeveId, ...(added.holePinId ? { holePinId: added.holePinId } : {}) }, selected: added.selected } : {}),
        ...(added?.replaced.length ? { replaced: added.replaced } : {}),
      },
      warnings,
      files: describeFiles(
        pourBoxStlFiles(box, '-').map((f) => ({ name: `pour-${f.piece}.stl`, bytes: f.bytes })),
        msg.includeFiles !== false
      ),
    };
  },
    /*
     * The two export paths, reachable at last.
     *
     * Everything the app can make — a casting pattern, a CNC program, a
     * mold, a laser layout — lived behind a modal and a mouse, so an agent
     * could model a part and then had no way to find out whether it could be
     * made. These two are the ones asked for.
     *
     * Files come back base64-encoded and the MCP server writes them out; it
     * never hands the bytes to the agent, which is the whole reason they are
     * separated from the summary.
     */
  EXPORT_CAST: async (msg, { store, toId }) => {
    if (!store.sceneGraph.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to cast.' };
    if (msg.masterId !== undefined && msg.masterId !== null && typeof msg.masterId !== 'string') {
      return { ok: false, error: 'masterId must be a string.' };
    }
    // What is cast: master_id, else every body.
    const resolveId = (v: unknown) => (toId ? toId(v) : v);
    const subject = mcpMoldSubject(store.sceneGraph, msg.masterId, (id) => findNodeInScene(store.sceneGraph.nodes, resolveId(id) as string));
    if ('error' in subject) return { ok: false, error: subject.error };
    const scene = subject.scene;
    const metal = msg.metalId ?? msg.metal ?? msg.material;
    if (metal !== undefined && metal !== null && (typeof metal !== 'string' || !CAST_METALS.some((m) => m.id === metal))) {
      return {
        ok: false,
        error: `metal is one of ${CAST_METALS.map((m) => m.id).join(', ')}. For concrete, plaster, resin, or silicone molds, use physics_make_pour_box(out_dir=...) and physics_add_simulation(kind='mold_cast', method='silicone', cast_material=...).`,
      };
    }
    if (msg.method !== undefined && msg.method !== null && msg.method !== 'sand' && msg.method !== 'lost-pla') {
      const hint = msg.method === 'silicone'
        ? " For silicone molds, use physics_make_pour_box(out_dir=...) and physics_add_simulation(kind='mold_cast', method='silicone', cast_material=...)."
        : '';
      return { ok: false, error: `method is 'sand' or 'lost-pla'.${hint}` };
    }
    let partingFromBaseMm: number | 'auto' | undefined;
    if (msg.partingFromBaseMm !== undefined && msg.partingFromBaseMm !== null) {
      if (msg.partingFromBaseMm === 'auto') {
        partingFromBaseMm = 'auto';
      } else if (typeof msg.partingFromBaseMm === 'number' && Number.isFinite(msg.partingFromBaseMm) && msg.partingFromBaseMm >= 0) {
        partingFromBaseMm = msg.partingFromBaseMm;
      } else {
        return { ok: false, error: "partingFromBaseMm must be 'auto' or a non-negative finite number." };
      }
    }
    // 0 means "size from the part" (the MCP server sends 0 by default); negative or non-finite is invalid.
    const sprueDia = checkNonNeg(msg.sprueDiaMm, 'sprueDiaMm');
    if (!sprueDia.ok) return sprueDia;
    const riserDia = checkNonNeg(msg.riserDiaMm, 'riserDiaMm');
    if (!riserDia.ok) return riserDia;
    const copeDrag = checkNonNeg(msg.copeDragHeightMm, 'copeDragHeightMm');
    if (!copeDrag.ok) return copeDrag;
    const draftChk = checkNonNeg(msg.draftDeg, 'draftDeg');
    if (!draftChk.ok) return draftChk;
    const shrinkChk = checkNonNeg(msg.shrinkPercent, 'shrinkPercent');
    if (!shrinkChk.ok) return shrinkChk;
    if (msg.sprueAtMm !== undefined && msg.sprueAtMm !== null
      && !(Array.isArray(msg.sprueAtMm) && msg.sprueAtMm.length >= 2 && msg.sprueAtMm.slice(0, 2).every((v: unknown) => typeof v === 'number' && Number.isFinite(v)))) {
      return { ok: false, error: 'sprue_at_mm is [x, y] in scene mm.' };
    }
    const options = {
      ...DEFAULT_CAST_OPTIONS,
      // `metal` is what the MCP tool calls it; `metalId` is what the
      // exporter's own options call it. Both are accepted so neither side
      // has to know the other's spelling.
      ...(typeof metal === 'string' ? { metalId: metal } : {}),
      ...(partingFromBaseMm !== undefined ? { partingFromBaseMm } : {}),
      ...(msg.method === 'sand' || msg.method === 'lost-pla' ? { method: msg.method as CastMethod } : {}),
      ...(typeof msg.addGating === 'boolean' ? { addGating: msg.addGating } : {}),
      ...(sprueDia.value !== undefined ? { sprueDiaMm: sprueDia.value } : {}),
      ...(Array.isArray(msg.sprueAtMm) && msg.sprueAtMm.length >= 2 && msg.sprueAtMm.slice(0, 2).every((v: unknown) => typeof v === 'number' && Number.isFinite(v))
        ? { sprueAtMm: [msg.sprueAtMm[0], msg.sprueAtMm[1]] as [number, number] } : {}),
      ...(riserDia.value !== undefined ? { riserDiaMm: riserDia.value } : {}),
      ...(typeof msg.addRiser === 'boolean' ? { addRiser: msg.addRiser } : {}),
      ...(copeDrag.value !== undefined ? { copeDragHeightMm: copeDrag.value } : {}),
      // The Sand tab starts with 2° on the pattern; Lost PLA with none.
      draftDeg: draftChk.value !== undefined ? draftChk.value : msg.method === 'lost-pla' ? 0 : DEFAULT_TAB_DRAFT.sand,
      ...(shrinkChk.value !== undefined ? { shrinkPercent: shrinkChk.value } : {}),
    };
    // On the export worker, as the Sand and Lost PLA tabs run it: finding
    // every air pocket in a big pattern takes seconds, not a frame.
    let result: CastResult;
    try {
      if (typeof Worker === 'undefined') result = generateCastPattern(scene, options);
      else {
        const client = new ExportWorkerClient();
        try { result = await client.run('cast', scene, options); } finally { client.dispose(); }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.success) return { ok: false, error: result.error || 'The cast pattern could not be generated.', warnings: result.warnings ?? [] };
    // physics_add_simulation's sand and lost-PLA chains simulate this pattern next.
    rememberCastOptions(options);
    return {
      ok: true,
      molded: { label: subject.label, ids: subject.ids },
      summary: result.summary,
      warnings: result.warnings ?? [],
      files: describeFiles(
        [{ name: result.summary.method === 'lost-pla' ? 'burnout-pattern.stl' : 'cast-pattern.stl', bytes: result.patternStl }],
        msg.includeFiles !== false
      ),
    };
  },
    /*
     * Prepare for Casting, as the switch under Mold > Sand or Lost PLA > Advanced does it: edge
     * breaks on every part, and for sand, draft baked in. See
     * utils/castPrep.ts.
     */
  SET_CAST_PREP: async (msg, { store }) => {
    try {
      if (msg.off === true) {
        if (!store.sceneGraph.castPrep) return { ok: true, on: false, note: 'Prep was not on.' };
        const { restored, kept } = store.clearCastPrep();
        await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
        return { ok: true, on: false, restored: restored.length, keptAsTheyAre: kept.map((k) => k.name) };
      }
      if (msg.bake === true) {
        if (!store.sceneGraph.castPrep) return { ok: false, error: 'Prep is not on, so there is nothing to bake in.' };
        store.bakeCastPrep();
        return { ok: true, on: false, baked: true };
      }
      if (msg.method !== undefined && msg.method !== null && msg.method !== 'sand' && msg.method !== 'lost-pla') {
        if (msg.method === 'silicone') {
          return {
            ok: false,
            error: "method is 'sand' or 'lost-pla'. Silicone molds flex over undercuts and don't need sand/lost-PLA cast prep — go straight to physics_make_pour_box.",
          };
        }
        return { ok: false, error: "method is 'sand' or 'lost-pla'." };
      }
      if (msg.draftMode !== undefined && msg.draftMode !== null && msg.draftMode !== 'add' && msg.draftMode !== 'remove') {
        return { ok: false, error: "draftMode is 'add' or 'remove'." };
      }
      let draftDeg = 2;
      if (msg.draftDeg !== undefined && msg.draftDeg !== null) {
        if (typeof msg.draftDeg !== 'number' || !Number.isFinite(msg.draftDeg) || msg.draftDeg < 0 || msg.draftDeg > 15) {
          return { ok: false, error: 'draftDeg must be a finite number between 0 and 15.' };
        }
        draftDeg = msg.draftDeg;
      }
      let edgeSizeMm: number | 'auto' = 'auto';
      if (msg.edgeSizeMm !== undefined && msg.edgeSizeMm !== null && msg.edgeSizeMm !== 'auto') {
        if (typeof msg.edgeSizeMm !== 'number' || !Number.isFinite(msg.edgeSizeMm) || msg.edgeSizeMm <= 0) {
          return { ok: false, error: "edgeSizeMm must be 'auto' or a positive finite number." };
        }
        edgeSizeMm = msg.edgeSizeMm;
      }
      let partingFromBaseMm: number | 'auto' = 'auto';
      if (msg.partingFromBaseMm !== undefined && msg.partingFromBaseMm !== null && msg.partingFromBaseMm !== 'auto') {
        if (typeof msg.partingFromBaseMm !== 'number' || !Number.isFinite(msg.partingFromBaseMm) || msg.partingFromBaseMm < 0) {
          return { ok: false, error: "partingFromBaseMm must be 'auto' or a non-negative finite number." };
        }
        partingFromBaseMm = msg.partingFromBaseMm;
      }
      const method = msg.method === 'lost-pla' ? 'lost-pla' : 'sand';
      const report = await runCastPrep({
        method,
        draftDeg,
        draftMode: msg.draftMode === 'remove' ? 'remove' : 'add',
        edges: msg.edges !== false,
        edgeSizeMm,
        partingFromBaseMm,
      });
      return report.ok ? { ...report, on: true } : report;
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
    /*
     * Split for Print, as the dialog does it: cut a body into sections
     * that fit the bed, with joinery on the cut faces. Reports the
     * sections; `testAssembly` puts them back together in MuJoCo first,
     * and `apply` replaces the body with them. See utils/printSplit.ts.
     */
  SPLIT_FOR_PRINT: async (msg, { store, toId }) => {
    if (msg.bodyId !== undefined && msg.bodyId !== null && typeof msg.bodyId !== 'string') {
      return { ok: false, error: 'bodyId must be a string.' };
    }
    const resolveNode = (id: string) => findNodeInScene(store.sceneGraph.nodes, (toId ? toId(id) : id) as string);
    const bodyId = typeof msg.bodyId === 'string' ? msg.bodyId : store.selectedNodeId;
    const node = bodyId ? resolveNode(bodyId) : null;
    if (!node) return { ok: false, error: bodyId ? `No body called ${bodyId}.` : 'Give bodyId, or select a body first.' };
    // More bodies to split as one part with it, in its frame.
    if (msg.withIds !== undefined && msg.withIds !== null && (!Array.isArray(msg.withIds) || !msg.withIds.every((v) => typeof v === 'string'))) {
      return { ok: false, error: 'withIds must be an array of body IDs or names.' };
    }
    const others = (Array.isArray(msg.withIds) ? msg.withIds : []).filter((v): v is string => typeof v === 'string');
    const missing = others.filter((id) => !resolveNode(id));
    if (missing.length) return { ok: false, error: `No body called ${missing.join(', ')}.` };
    const { soups, absorbed } = selectionSoups(store.sceneGraph, [node.id, ...others.map((id) => resolveNode(id)!.id)]);
    if (!soups.length) return { ok: false, error: `${node.name} has no solid geometry to split.` };
    let bed = store.printBed;
    if (msg.bedMm !== undefined && msg.bedMm !== null) {
      if (!Array.isArray(msg.bedMm) || msg.bedMm.length !== 3 || !msg.bedMm.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
        return { ok: false, error: 'bedMm must be [width, depth, height] of positive finite numbers in mm.' };
      }
      bed = { widthMm: msg.bedMm[0], depthMm: msg.bedMm[1], heightMm: msg.bedMm[2] };
    }
    const rawJoinery = msg.joinery ?? msg.connector;
    if (rawJoinery !== undefined && rawJoinery !== null && rawJoinery !== 'none' && rawJoinery !== 'peg' && rawJoinery !== 'dowel') {
      return { ok: false, error: "joinery/connector is 'dowel', 'peg' or 'none'." };
    }
    const kind = rawJoinery === 'none' || rawJoinery === 'peg' || rawJoinery === 'dowel' ? rawJoinery : 'dowel';
    const diaChk = checkPos(msg.diameterMm, 'diameterMm');
    if (!diaChk.ok) return diaChk;
    const lenChk = checkPos(msg.lengthMm, 'lengthMm');
    if (!lenChk.ok) return lenChk;
    const minWallChk = checkPos(msg.minWallMm, 'minWallMm');
    if (!minWallChk.ok) return minWallChk;
    const clearChk = checkNonNeg(msg.clearanceMm, 'clearanceMm');
    if (!clearChk.ok) return clearChk;
    const marginChk = checkNonNeg(msg.marginMm, 'marginMm');
    if (!marginChk.ok) return marginChk;
    let maxSections: number | undefined;
    if (msg.maxSections !== undefined && msg.maxSections !== null) {
      if (typeof msg.maxSections !== 'number' || !Number.isFinite(msg.maxSections) || !Number.isInteger(msg.maxSections) || msg.maxSections < 2) {
        return { ok: false, error: 'maxSections must be an integer >= 2.' };
      }
      maxSections = msg.maxSections;
    }
    const joinery = Object.fromEntries(Object.entries({
      kind,
      diameterMm: diaChk.value,
      lengthMm: lenChk.value,
      clearanceMm: clearChk.value,
      minWallMm: minWallChk.value,
    }).filter(([, v]) => v !== undefined));
    const marginMm = marginChk.value ?? 5;
    const placement = msg.placement === 'beside' ? 'beside' : msg.placement === undefined || msg.placement === 'replace' ? 'replace' : null;
    if (!placement) return { ok: false, error: "placement is 'replace' or 'beside'." };
    if (msg.name !== undefined && msg.name !== null && (typeof msg.name !== 'string' || !msg.name.trim())) {
      return { ok: false, error: 'name must be a non-empty string.' };
    }
    const requestedName = typeof msg.name === 'string' && msg.name.trim()
      ? msg.name.trim()
      : others.length > 0 && store.sceneGraph.name?.trim()
        ? store.sceneGraph.name.trim()
        : undefined;
    let splitOut;
    try {
      splitOut = await splitOffThread(soups, {
        bed,
        marginMm,
        overhangDeg: filamentSpec(store.filament).maxOverhangDeg,
        joinery,
        ...(maxSections !== undefined ? { maxSections } : {}),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const { result, checks } = splitOut;
    if (!result.ok) return { ok: false, error: result.error };

    let assembly: Record<string, unknown> | undefined;
    if (msg.testAssembly === true && result.cuts.length) {
      try {
        const { results } = await testAssemblyOffThread(result);
        assembly = {
          ok: results.every((r) => r.ok),
          stages: results.map((r) => ({
            label: r.label, kind: r.kind, ok: r.ok, seated: r.seated,
            gapMm: +r.gapMm.toFixed(3), lateralMm: +r.lateralMm.toFixed(3), angleDeg: +r.angleDeg.toFixed(3),
            playMm: r.playMm === null ? 'unbounded' : +r.playMm.toFixed(3),
            twistDeg: r.twistDeg === null ? 'unbounded' : +r.twistDeg.toFixed(3),
            rotates: r.rotates, diverged: r.diverged, notes: r.notes,
          })),
        };
      } catch (err) {
        assembly = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const names = requestedName
      ? (result.sections.length === 1
        ? [requestedName]
        : result.sections.map((_, i) => `${requestedName}_part${i + 1}`))
      : undefined;
    const ids = msg.apply === true
      ? useStore.getState().splitBodyForPrint(node.id, result.sections, absorbed, {
        cutFor: { bed, marginMm }, placement, ...(names ? { names } : {}), ...(msg.centerOrigin === true ? { centerOrigin: true } : {}),
      })
      : null;
    const round = (v: number, d = 1) => +v.toFixed(d);
    return {
      ok: true,
      applied: !!ids,
      ...(absorbed.length ? { includedBodies: absorbed.length } : {}),
      bedMm: [bed.widthMm, bed.depthMm, bed.heightMm],
      sections: result.sections.map((sec, i) => ({
        index: i,
        sectionNumber: i + 1,
        ...(ids ? { id: ids[i] } : {}),
        fits: sec.fits,
        printedSizeMm: sec.sizeMm.map((v) => round(v)),
        supportMm2: round(sec.supportMm2),
        up: sec.up.map((v) => round(v, 4)),
        spinDeg: round(sec.spin * 180 / Math.PI, 2),
        volumeMm3: round(sec.volumeMm3),
        holes: sec.features.filter((f) => f.kind === 'bore').length,
        pegs: sec.features.filter((f) => f.kind === 'peg').length,
      })),
      cuts: result.cuts.map((c, i) => ({
        index: i,
        cutNumber: i + 1,
        normal: c.normal.map((v) => round(v, 4)),
        offsetMm: round(c.offset * 1000, 2),
      })),
      joints: result.joints.map((j) => ({
        between: [j.neg, j.pos],
        betweenSections: [j.neg + 1, j.pos + 1],
        areaMm2: round(j.areaMm2),
        pins: j.pins.length,
        ...(j.pegSide ? {
          pegsOn: j.pegSide === 'neg' ? j.neg : j.pos,
          pegsOnSection: (j.pegSide === 'neg' ? j.neg : j.pos) + 1,
        } : {}),
      })),
      checks,
      ...(assembly ? { assembly } : {}),
      warnings: result.warnings,
    };
  },
    /*
     * The toolbar's Export STL / Export 3MF, for an agent: the chosen bodies
     * (default every body) at true size in millimetres, Z-up, sitting on
     * z = 0. Built from the graph, not the canvas (utils/printExport.ts), so
     * there is no size prompt and no waiting on a frame. Files come back as
     * for EXPORT_CAST.
     */
  EXPORT_PRINT: async (msg, { store, toId }) => {
    if (!store.sceneGraph.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to print.' };
    const format = msg.format === undefined ? 'stl' : msg.format;
    if (format !== 'stl' && format !== '3mf') return { ok: false, error: "format is 'stl' or '3mf'." };
    if (msg.ids !== undefined && msg.ids !== null
      && typeof msg.ids !== 'string'
      && !(Array.isArray(msg.ids) && msg.ids.every((v) => typeof v === 'string'))) {
      return { ok: false, error: 'ids must be a body ID/name or an array of body IDs/names.' };
    }
    const resolveNode = (id: string) => findNodeInScene(store.sceneGraph.nodes, (toId ? toId(id) : id) as string);
    const asked = (Array.isArray(msg.ids) ? msg.ids : typeof msg.ids === 'string' ? [msg.ids] : [])
      .filter((v): v is string => typeof v === 'string');
    const unknown = asked.filter((id) => !resolveNode(id));
    if (unknown.length) return { ok: false, error: `No body called ${unknown.join(', ')}.` };
    const ids = asked.map((id) => resolveNode(id)!.id);
    if (msg.filaments !== undefined && msg.filaments !== null) {
      if (typeof msg.filaments !== 'number' || !Number.isFinite(msg.filaments) || !Number.isInteger(msg.filaments) || msg.filaments < 1 || msg.filaments > 32) {
        return { ok: false, error: 'filaments must be an integer from 1 to 32.' };
      }
    }
    let exportBed = store.printBed;
    if (msg.bedMm !== undefined && msg.bedMm !== null) {
      if (!Array.isArray(msg.bedMm) || (msg.bedMm.length !== 2 && msg.bedMm.length !== 3)
        || !msg.bedMm.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
        return { ok: false, error: 'bedMm must be [width, depth] or [width, depth, height] of positive finite numbers in mm.' };
      }
      exportBed = {
        widthMm: msg.bedMm[0],
        depthMm: msg.bedMm[1],
        heightMm: msg.bedMm.length === 3 ? msg.bedMm[2] : store.printBed.heightMm,
      };
    }
    const marginChk = checkNonNeg(msg.marginMm, 'marginMm');
    if (!marginChk.ok) return marginChk;
    /*
     * An STL is one soup: split sections in it stand assembled, as big as the
     * part that would not fit the bed - a 478 mm beam for a 256 mm bed, every
     * cut face touching the next. Unless told otherwise, sections go out a
     * file each, stood as they print, as the editor's dialog offers first.
     */
    const exported = ids.length ? ids.map((id) => findNodeInScene(store.sceneGraph.nodes, id)!) : store.sceneGraph.nodes;
    const posed = (nodes: SceneNode[]): boolean => nodes.some((n) => !!n.printPose || posed(n.children ?? []));
    const separate = typeof msg.separate === 'boolean' ? msg.separate : format === 'stl' && posed(exported);
    const customFilename = typeof msg.filename === 'string' && msg.filename.trim()
      ? msg.filename.trim().replace(/\.(stl|3mf)$/i, '')
      : undefined;
    let result;
    try {
      result = exportPrintFiles(store.sceneGraph, {
        format,
        ids,
        moldParts: ids.length > 0,
        separate,
        ...(typeof msg.plate === 'boolean' ? { plate: msg.plate } : {}),
        ...(typeof msg.filaments === 'number' ? { filaments: msg.filaments } : {}),
        bed: exportBed,
        ...(marginChk.value !== undefined ? { marginMm: marginChk.value } : {}),
        baseName: customFilename || exportFileBase(store, ids),
      });
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    if (!result.files.length) {
      return { ok: false, error: 'Nothing printable in what was asked for: no body with solid geometry (bought-in hardware and simulated cuts are left out).', warnings: result.warnings };
    }
    return {
      ok: true,
      // Under `summary`: the MCP server passes on summary, warnings and files only.
      summary: {
        format, units: 'mm', plated: result.plated, parts: result.parts,
        ...(result.filaments ? { filaments: result.filaments } : {}),
      },
      warnings: result.warnings,
      files: describeFiles(result.files, msg.includeFiles !== false),
    };
  },
};
