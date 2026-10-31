// ---------------------------------------------------------------------------
// MCP commands for molds and casting, and Split for Print
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { generateCastPattern, DEFAULT_CAST_OPTIONS, rememberCastOptions, type CastMethod } from '../../utils/castPatternExporter';
import { runCastPrep } from '../../utils/castPrepRunner';
import { planPourBox } from '../../utils/pourBoxScene';
import { addPourBoxToScene, pourBoxStl } from '../../utils/pourBoxActions';
import { holePinMesh, type PourBoxOptions } from '../../utils/siliconeMold';
import { CAST_METALS, SILICONES, isSiliconeId, resolveCastMaterial } from '../../utils/castMaterials';
import { mcpMoldSubject } from '../../utils/moldSubject';
import { DEFAULT_TAB_DRAFT } from '../../utils/moldTabs';
import { selectionSoups, splitOffThread, testAssemblyOffThread } from '../../utils/printSplitClient';
import { filamentSpec } from '../../utils/filaments';
import { exportPrintFiles } from '../../utils/printExport';
import { findNodeInScene, describeFiles } from './bridgeUtils';
import type { McpCommands } from './types';

export const castCommands: McpCommands = {
    /*
     * A printed pour box for a silicone mold of the given bodies (default:
     * every body): base with a groove, sleeve, and an
     * optional hole through the silicone (wick, pour or fixing). Reports the fill line and the silicone; apply adds
     * the pieces to the scene; files come back as for EXPORT_CAST.
     */
  MAKE_POUR_BOX: async (msg, { store }) => {
    // The master: body_id, else every body (never the UI selection, which an agent cannot see).
    const subject = mcpMoldSubject(store.sceneGraph, msg.bodyId, (id) => findNodeInScene(store.sceneGraph.nodes, id));
    if ('error' in subject) return { ok: false, error: subject.error };
    const ids = subject.ids;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const options: Partial<PourBoxOptions> = {};
    for (const key of ['coverMm', 'wallMm', 'clearanceMm', 'baseMm', 'grooveMm', 'freeboardMm'] as const) {
      const v = num(msg[key]);
      if (v !== undefined) options[key] = v;
    }
    if (msg.shape === 'fit' || msg.shape === 'round' || msg.shape === 'box') options.shape = msg.shape;
    // A hole through the silicone and what it is for; `pin` is the older
    // name for a wick hole, and still means one.
    if (msg.hole !== undefined && msg.hole !== null && msg.hole !== 'none') {
      if (msg.hole !== 'wick' && msg.hole !== 'pour' && msg.hole !== 'fixing') {
        return { ok: false, error: "hole is 'wick', 'pour', 'fixing' or 'none'." };
      }
      options.hole = msg.hole;
    } else if (msg.pin === true) options.hole = 'wick';
    const holeDia = num(msg.holeDiaMm) ?? num(msg.pinDiaMm);
    if (holeDia !== undefined) options.holeDiaMm = holeDia;
    if (Array.isArray(msg.holeAtMm) && msg.holeAtMm.length === 2 && msg.holeAtMm.every((v) => typeof v === 'number')) {
      options.holeAtMm = msg.holeAtMm as [number, number];
    }
    if (typeof msg.silicone === 'string') {
      const silicone = resolveCastMaterial(msg.silicone);
      if (!isSiliconeId(silicone)) return { ok: false, error: `silicone is one of ${SILICONES.map((m) => m.id).join(', ')}.` };
      options.silicone = silicone;
    }
    let box;
    try {
      box = await planPourBox(store.sceneGraph, ids, options);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const added = msg.apply === true ? await addPourBoxToScene(ids, options, box) : null;
    const { warnings, ...summary } = box.report;
    return {
      ok: true,
      summary: {
        ...summary,
        master: ids,
        ...(box.hole ? { hole: { purpose: box.hole.purpose, diaMm: box.hole.diaMm } } : {}),
        ...(added ? { added: { baseId: added.baseId, sleeveId: added.sleeveId, ...(added.holePinId ? { holePinId: added.holePinId } : {}) }, selected: added.selected } : {}),
      },
      warnings,
      files: describeFiles(
        [
          { name: 'pour-base.stl', bytes: pourBoxStl(box.base, 'base') },
          { name: 'pour-sleeve.stl', bytes: pourBoxStl(box.sleeve, 'sleeve') },
          ...(box.hole ? [{ name: `pour-${box.hole.purpose}-pin.stl`, bytes: pourBoxStl(holePinMesh(box.hole), 'pin') }] : []),
        ],
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
  EXPORT_CAST: async (msg, { store }) => {
    if (!store.sceneGraph.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to cast.' };
    // What is cast: master_id, else every body.
    const subject = mcpMoldSubject(store.sceneGraph, msg.masterId, (id) => findNodeInScene(store.sceneGraph.nodes, id));
    if ('error' in subject) return { ok: false, error: subject.error };
    const scene = subject.scene;
    const metal = msg.metalId ?? msg.metal;
    if (metal !== undefined && !CAST_METALS.some((m) => m.id === metal)) {
      return { ok: false, error: `metal is one of ${CAST_METALS.map((m) => m.id).join(', ')}.` };
    }
    const options = {
      ...DEFAULT_CAST_OPTIONS,
      // `metal` is what the MCP tool calls it; `metalId` is what the
      // exporter's own options call it. Both are accepted so neither side
      // has to know the other's spelling.
      ...(typeof msg.metal === 'string' ? { metalId: msg.metal } : {}),
      ...(typeof msg.metalId === 'string' ? { metalId: msg.metalId } : {}),
      ...(msg.partingFromBaseMm === 'auto' || typeof msg.partingFromBaseMm === 'number'
        ? { partingFromBaseMm: msg.partingFromBaseMm as number | 'auto' } : {}),
      ...(msg.method === 'sand' || msg.method === 'lost-pla' ? { method: msg.method as CastMethod } : {}),
      ...(typeof msg.addGating === 'boolean' ? { addGating: msg.addGating } : {}),
      ...(typeof msg.sprueDiaMm === 'number' ? { sprueDiaMm: msg.sprueDiaMm } : {}),
      ...(typeof msg.riserDiaMm === 'number' ? { riserDiaMm: msg.riserDiaMm } : {}),
      ...(typeof msg.addRiser === 'boolean' ? { addRiser: msg.addRiser } : {}),
      // The Sand tab starts with 2° on the pattern; Lost PLA with none.
      draftDeg: typeof msg.draftDeg === 'number' ? msg.draftDeg : msg.method === 'lost-pla' ? 0 : DEFAULT_TAB_DRAFT.sand,
      ...(typeof msg.shrinkPercent === 'number' && msg.shrinkPercent >= 0 ? { shrinkPercent: msg.shrinkPercent } : {}),
    };
    const result = generateCastPattern(scene, options);
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
    const method = msg.method === 'lost-pla' ? 'lost-pla' : 'sand';
    const report = await runCastPrep({
      method,
      draftDeg: typeof msg.draftDeg === 'number' ? msg.draftDeg : 2,
      draftMode: msg.draftMode === 'remove' ? 'remove' : 'add',
      edges: msg.edges !== false,
      edgeSizeMm: typeof msg.edgeSizeMm === 'number' && msg.edgeSizeMm > 0 ? msg.edgeSizeMm : 'auto',
      partingFromBaseMm: typeof msg.partingFromBaseMm === 'number' ? msg.partingFromBaseMm : 'auto',
    });
    return report.ok ? { ...report, on: true } : report;
  },
    /*
     * Split for Print, as the dialog does it: cut a body into sections
     * that fit the bed, with joinery on the cut faces. Reports the
     * sections; `testAssembly` puts them back together in MuJoCo first,
     * and `apply` replaces the body with them. See utils/printSplit.ts.
     */
  SPLIT_FOR_PRINT: async (msg, { store }) => {
    const bodyId = typeof msg.bodyId === 'string' ? msg.bodyId : store.selectedNodeId;
    const node = bodyId ? findNodeInScene(store.sceneGraph.nodes, bodyId) : null;
    if (!node) return { ok: false, error: bodyId ? `No body called ${bodyId}.` : 'Give bodyId, or select a body first.' };
    // More bodies to split as one part with it, in its frame.
    const others = (Array.isArray(msg.withIds) ? msg.withIds : []).filter((v): v is string => typeof v === 'string');
    const missing = others.filter((id) => !findNodeInScene(store.sceneGraph.nodes, id));
    if (missing.length) return { ok: false, error: `No body called ${missing.join(', ')}.` };
    const { soups, absorbed } = selectionSoups(store.sceneGraph, [node.id, ...others.map((id) => findNodeInScene(store.sceneGraph.nodes, id)!.id)]);
    if (!soups.length) return { ok: false, error: `${node.name} has no solid geometry to split.` };
    const bedArr = Array.isArray(msg.bedMm) ? (msg.bedMm as number[]) : null;
    const bed = bedArr && bedArr.length === 3 && bedArr.every((v) => typeof v === 'number' && v > 0)
      ? { widthMm: bedArr[0], depthMm: bedArr[1], heightMm: bedArr[2] }
      : store.printBed;
    const kind = msg.joinery === 'none' || msg.joinery === 'peg' || msg.joinery === 'dowel' ? msg.joinery : 'dowel';
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const joinery = Object.fromEntries(Object.entries({
      kind,
      diameterMm: num(msg.diameterMm),
      lengthMm: num(msg.lengthMm),
      clearanceMm: num(msg.clearanceMm),
      minWallMm: num(msg.minWallMm),
    }).filter(([, v]) => v !== undefined));
    const marginMm = num(msg.marginMm) ?? 5;
    const placement = msg.placement === 'beside' ? 'beside' : msg.placement === undefined || msg.placement === 'replace' ? 'replace' : null;
    if (!placement) return { ok: false, error: "placement is 'replace' or 'beside'." };
    const maxSections = num(msg.maxSections);
    const { result, checks } = await splitOffThread(soups, {
      bed,
      marginMm,
      overhangDeg: filamentSpec(store.filament).maxOverhangDeg,
      joinery,
      ...(maxSections !== undefined ? { maxSections } : {}),
    });
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

    const ids = msg.apply === true
      ? store.splitBodyForPrint(node.id, result.sections, absorbed, {
        cutFor: { bed, marginMm }, placement, ...(msg.centerOrigin === true ? { centerOrigin: true } : {}),
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
      cuts: result.cuts.map((c) => ({ normal: c.normal.map((v) => round(v, 4)), offsetMm: round(c.offset * 1000, 2) })),
      joints: result.joints.map((j) => ({
        between: [j.neg, j.pos], areaMm2: round(j.areaMm2), pins: j.pins.length,
        ...(j.pegSide ? { pegsOn: j.pegSide === 'neg' ? j.neg : j.pos } : {}),
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
  EXPORT_PRINT: async (msg, { store }) => {
    if (!store.sceneGraph.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to print.' };
    const format = msg.format === undefined ? 'stl' : msg.format;
    if (format !== 'stl' && format !== '3mf') return { ok: false, error: "format is 'stl' or '3mf'." };
    const asked = (Array.isArray(msg.ids) ? msg.ids : typeof msg.ids === 'string' ? [msg.ids] : [])
      .filter((v): v is string => typeof v === 'string');
    const unknown = asked.filter((id) => !findNodeInScene(store.sceneGraph.nodes, id));
    if (unknown.length) return { ok: false, error: `No body called ${unknown.join(', ')}.` };
    const ids = asked.map((id) => findNodeInScene(store.sceneGraph.nodes, id)!.id);
    const bedArr = Array.isArray(msg.bedMm) ? (msg.bedMm as number[]) : null;
    const exportBed = bedArr && bedArr.length === 3 && bedArr.every((v) => typeof v === 'number' && v > 0)
      ? { widthMm: bedArr[0], depthMm: bedArr[1], heightMm: bedArr[2] }
      : store.printBed;
    const result = exportPrintFiles(store.sceneGraph, {
      format,
      ids,
      separate: msg.separate === true,
      ...(typeof msg.plate === 'boolean' ? { plate: msg.plate } : {}),
      ...(typeof msg.filaments === 'number' ? { filaments: msg.filaments } : {}),
      bed: exportBed,
      ...(typeof msg.marginMm === 'number' && Number.isFinite(msg.marginMm) && msg.marginMm >= 0 ? { marginMm: msg.marginMm } : {}),
      baseName: store.sceneGraph.name || store.activePreset || 'model',
    });
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
