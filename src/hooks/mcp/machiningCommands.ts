// ---------------------------------------------------------------------------
// MCP commands for CNC output: relief carving, solid machining, and the
// cut simulation
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { collectIndividualPartSoups, resolveTimberTargetIds } from '../../utils/timberBreakdown';
import type { SolidMachiningResult } from '../../utils/solidMachiningExporter';
import { describeCutter, type ReliefCarveResult } from '../../utils/reliefCarveExporter';
import { DEFAULT_LASER_OPTIONS, type LaserCutResult } from '../../utils/laserCutExporter';
import {
  DEFAULT_CONTOUR_OPTIONS, collectSceneTriangles, type ContourSliceResult,
} from '../../utils/contourSliceExporter';
import {
  DEFAULT_SHEET_UNFOLD_OPTIONS, exportSheetUnfold, type SheetUnfoldOptions,
} from '../../utils/sheetUnfoldExporter';
import { sheetFoldSimulationRequest } from '../../utils/sheetFoldSimulation';
import { breakdownPipeFrame, type PipeFrameOptions } from '../../utils/tubeAndWireExporter';
import { reliefSimulationTools } from '../../utils/simulatedPart';
import { simulationSetups } from '../../utils/solidSetups';
import { FACE_NAME } from '../../utils/orient';
import { contourSheetParts, laserSheetParts, laserStockTransform } from '../../utils/sheetSimulation';
import { addSimulationToScene, sceneStockTransform, simulateTimberOffThread } from '../useAddSimulation';
import { breakdownFrameToWorld, timberSimulationRequest } from '../../utils/timberSimulation';
import { pipeFrameSimulationRequest } from '../../utils/tubeSimulation';
import { runMcpMoldSimulation } from '../../utils/moldWorkerClient';
import { ExportWorkerClient } from '../../utils/exportWorkerClient';
import { findNodeInScene, describeFiles } from './bridgeUtils';
import { reliefOptionsFor, machiningOptionsFor } from './exportOptions';
import type { McpCommands } from './types';

export const machiningCommands: McpCommands = {
    /*
     * A relief carve, planned the way the Relief Carve dialog last planned
     * it - the same stock, fit, cutters and any feed typed over - so an
     * agent looking into a carve is looking at the job that went to the
     * machine. Anything asked for here is laid on top; asking for a cutter,
     * a material or a depth works the feeds out again for it. With the
     * dialog not opened this session, it starts from the scene's own carve
     * settings and the bench's stock and material, as the dialog would.
     */
  EXPORT_RELIEF: async (msg, { store }) => {
    const scene = store.sceneGraph;
    if (!scene.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to carve.' };
    const { options, fromDialog } = reliefOptionsFor(msg);
    const client = new ExportWorkerClient();
    let result: ReliefCarveResult;
    try {
      result = await client.run('relief', scene, options);
    } finally {
      client.dispose();
    }
    if (!result.success) return { ok: false, error: result.error || 'The relief carve could not be planned.', warnings: result.warnings ?? [] };
    const lines = result.gcode.split('\n');
    const toolChangeAt = lines.findIndex((l) => /^T\d+\s*M0?6\b/.test(l));
    return {
      ok: true,
      optionsFrom: fromDialog ? 'the Relief Carve dialog' : 'the scene and bench defaults (the dialog has not planned a carve this session)',
      summary: {
        stockMm: { width: options.stockWidthMm, depth: options.stockDepthMm, thickness: options.stockThicknessMm },
        material: options.material,
        heightMode: result.heightMode,
        scalePercent: Math.round(result.scaleFactor * 1000) / 10,
        carveDepthMm: result.heightMode === 'model' ? null : options.carveDepthMm,
        reliefDepthMm: result.reliefDepthMm,
        undercut: result.undercut
          ? {
              areaMm2: Math.round(result.undercut.areaMm2),
              volumeMm3: Math.round(result.undercut.volumeMm3),
              maxMm: Math.round(result.undercut.maxMm * 10) / 10,
              boundsMm: result.undercut.bounds,
            }
          : null,
        roughing: options.roughingEnabled
          ? {
              tool: describeCutter(options.roughingToolDiaMm, 'flat', options.roughingFlutes, options.roughingGeometry),
              strategy: options.roughingStrategy,
              layers: result.roughingPassCount,
              bitePercent: result.roughingBitePercent,
              estimatedSeconds: result.roughingTimeSeconds,
            }
          : null,
        finishing: options.finishingEnabled
          ? {
              tool: describeCutter(options.finishingToolDiaMm, options.finishingToolType, options.finishingFlutes, options.finishingGeometry, options.finishingVBitAngleDeg),
              strategy: options.finishingStrategy,
              passes: result.finishingRasterLines,
            }
          : null,
        spindleRpm: options.spindleRpm,
        estimatedTimeSeconds: result.estimatedTimeSeconds,
        totalCutDistanceMm: result.totalCutDistanceMm,
        lines: lines.length,
        // 1-based, as an editor or a sender's line counter shows it.
        toolChangeLine: result.toolChange && toolChangeAt >= 0 ? toolChangeAt + 1 : null,
      },
      warnings: result.warnings ?? [],
      files: describeFiles(
        [{ name: 'relief-carve.nc', bytes: new TextEncoder().encode(result.gcode) }],
        msg.includeFiles !== false,
      ),
    };
  },
  EXPORT_MACHINING: async (msg, { store }) => {
    const scene = store.sceneGraph;
    if (!scene.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to machine.' };
    const options = machiningOptionsFor(msg, scene);
    // On a worker, as the dialog plans it: on the page, a big part froze
    // the tab for the half minute its plan takes.
    const client = new ExportWorkerClient();
    let result: SolidMachiningResult;
    try { result = await client.run('solid', scene, options); } finally { client.dispose(); }
    if (!result.success) return { ok: false, error: result.error || 'The machining program could not be generated.', warnings: result.warnings ?? [] };
    const encoder = new TextEncoder();
    return {
      ok: true,
      summary: {
        stock: result.stock,
        ...(result.boardPrep ? { boardPrep: result.boardPrep } : {}),
        partSizeMm: result.partSizeMm,
        partVolumeMm3: result.partVolumeMm3,
        unreachablePercent: result.unreachablePercent,
        tabsPlaced: result.tabsPlaced,
        estimatedTimeSeconds: result.estimatedTimeSeconds,
        totalCutDistanceMm: result.totalCutDistanceMm,
        sides: result.sides.map(s => ({ side: s.side, depthMm: s.depthMm })),
        // Planned setups (setups: 'auto' or a list of faces), in the order they run.
        ...(result.plan ? {
          plan: result.plan.text,
          upChosen: result.upChosen,
          remaining: result.plan.remaining,
          redesignHint: result.plan.redesignHint ?? null,
          dropped: result.plan.dropped,
          setups: (result.setups ?? []).map((st) => ({
            index: st.index,
            face: st.upFace,
            faceUp: FACE_NAME[st.upFace],
            standingHeightMm: +st.standingHeightMm.toFixed(1),
            depthMm: +st.depthMm.toFixed(2),
            lengthOverDia: +st.lengthOverDia.toFixed(1),
            estimatedTimeSeconds: Math.round(st.estimatedTimeSeconds),
            clearedMm3: Math.round(st.clearedMm3),
            skinMm: +st.allowanceMm.toFixed(2),
            locate: st.locate,
            datum: st.datum?.description ?? null,
            instructions: st.instructions,
          })),
        } : {}),
      },
      warnings: result.warnings ?? [],
      files: describeFiles(
        result.plan && result.setups
          ? result.setups.map(st => ({ name: `machining-setup-${st.index}-${st.upFace.replace('+', 'p').replace('-', 'm')}.nc`, bytes: encoder.encode(st.gcode ?? '') }))
          : result.sides.map(s => ({ name: `machining-side-${s.side}.nc`, bytes: encoder.encode(s.gcode ?? '') })),
        msg.includeFiles !== false,
      ),
    };
  },
  ADD_SIMULATION: async (msg, { store, toId }) => {
    // The part a program leaves, added to the scene: the same plan the
    // matching export would hand over, cut back out of its stock.
    const scene = store.sceneGraph;
    const placement = msg.placement === 'overlay' ? 'overlay' : 'beside';
    const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);

    if (msg.kind === 'mold' || msg.kind === 'mold_cast' || msg.kind === 'cast') {
      return runMcpMoldSimulation({
        msg,
        scene,
        placement,
        toId: (s) => toId(s) as string,
        findNodeInScene,
        describeFiles,
      });
    }

    if (!scene.nodes?.some((n) => !n.simulation)) {
      return { ok: false, error: 'The scene has nothing to cut but earlier simulations.' };
    }

    const runJob = async <T,>(go: (client: ExportWorkerClient) => Promise<T>) => {
      const client = new ExportWorkerClient();
      try { return await go(client); } finally { client.dispose(); }
    };

    if (msg.kind === 'relief') {
      const { options, fromDialog } = reliefOptionsFor(msg);
      const result: ReliefCarveResult = await runJob((c) => c.run('relief', scene, options));
      if (!result.success || !result.stockTransform) {
        return { ok: false, error: result.error || 'The relief carve could not be planned.', warnings: result.warnings ?? [] };
      }
      const added = await addSimulationToScene({
        job: {
          gcode: result.gcode,
          widthMm: options.stockWidthMm,
          depthMm: options.stockDepthMm,
          thicknessMm: options.stockThicknessMm,
          ...reliefSimulationTools(options),
        },
        transform: result.stockTransform,
        kind: 'relief',
        label: 'Relief carve',
        placement,
      });
      const m = added.milled!;
      return {
        ok: true, id: added.id, name: added.name, kind: 'relief', placement,
        optionsFrom: fromDialog ? 'the Relief Carve dialog' : 'the scene and bench defaults',
        volumeMm3: Math.round(m.volumeMm3),
        stockVolumeMm3: Math.round(m.stockVolumeMm3),
        removedMm3: Math.round(m.stockVolumeMm3 - m.volumeMm3),
        rapidMovesThatCut: m.rapidCuts,
        deepestRapidCutMm: +m.deepestRapidMm.toFixed(3),
        cellMm: +m.cellMm.toFixed(3),
        meshToleranceMm: +m.toleranceMm.toFixed(3),
        warnings: result.warnings ?? [],
      };
    }

    if (msg.kind === 'machining') {
      const options = machiningOptionsFor(msg, scene);
      // On the worker: a big part's plan takes half a minute, and on the
      // page it froze the tab for all of it.
      const result: SolidMachiningResult = await runJob((c) => c.run('solid', scene, options));
      if (!result.success || !result.stockTransform) {
        return { ok: false, error: result.error || 'The machining program could not be generated.', warnings: result.warnings ?? [] };
      }
      const added = await addSimulationToScene({
        job: {
          gcode: result.sides[0].gcode,
          gcodeB: result.sides[1]?.gcode,
          setups: simulationSetups(result),
          widthMm: result.stock.widthMm,
          depthMm: result.stock.depthMm,
          thicknessMm: result.stock.thicknessMm,
          ...reliefSimulationTools(options),
          measureRect: result.partBounds,
          measureMask: result.footprint,
        },
        transform: result.stockTransform,
        kind: 'machining',
        label: 'Solid part',
        placement,
        modelVolumeMm3: result.partVolumeMm3,
      });
      const m = added.milled!;
      const part = m.measuredVolumeMm3 ?? 0;
      return {
        ok: true, id: added.id, name: added.name, kind: 'machining', placement,
        sides: result.sides.length,
        setups: result.setups?.map((st) => st.upFace) ?? null,
        volumeMm3: Math.round(m.volumeMm3),
        // Inside the part's own outline, so the frame, the tabs and the
        // stock round a part that is not a rectangle are all left out.
        partVolumeMm3: Math.round(part),
        modelVolumeMm3: Math.round(result.partVolumeMm3),
        partVsModel: result.partVolumeMm3 > 0 ? +(part / result.partVolumeMm3).toFixed(4) : null,
        rapidMovesThatCut: m.rapidCuts,
        deepestRapidCutMm: +m.deepestRapidMm.toFixed(3),
        cellMm: +m.cellMm.toFixed(3),
        meshToleranceMm: +m.toleranceMm.toFixed(3),
        warnings: result.warnings ?? [],
      };
    }

    if (msg.kind === 'laser' || msg.kind === 'contour') {
      const router = msg.machine === 'router';
      const routerRadiusMm = router ? (num(msg.bitDiaMm) ?? 3.175) / 2 : 0;
      // A contour layer is one sheet of the bench's stock, as in its dialog.
      const thicknessMm = num(msg.materialThicknessMm)
        ?? (msg.kind === 'contour' ? useStore.getState().stock.thicknessMm : 3);
      if (msg.kind === 'laser') {
        const result: LaserCutResult = await runJob((c) =>
          c.run('laser', scene, { ...DEFAULT_LASER_OPTIONS, materialThickness: thicknessMm / 1000 }));
        if (!result.success || !result.panels?.length) {
          return { ok: false, error: result.error || 'The panels could not be laid out.', warnings: result.warnings ?? [] };
        }
        const added = await addSimulationToScene({
          sheets: { parts: laserSheetParts(result.panels, result.sheets), routerRadiusMm },
          transform: laserStockTransform(result.panels, result.scaleFactor ?? 1),
          kind: 'laser',
          label: router ? 'Router cut' : 'Laser cut',
          placement,
          details: [`${result.panels.length} panels in ${thicknessMm} mm stock`],
        });
        return {
          ok: true, id: added.id, name: added.name, kind: 'laser', placement,
          panels: result.panels.length,
          volumeMm3: Math.round(added.volumeMm3),
          warnings: result.warnings ?? [],
        };
      }
      const result: ContourSliceResult = await runJob((c) =>
        c.run('contour', scene, { ...DEFAULT_CONTOUR_OPTIONS, materialThickness: thicknessMm / 1000 }));
      if (!result.success || !result.layers?.length || !result.stockTransform) {
        return { ok: false, error: result.error || 'The model could not be sliced.', warnings: result.warnings ?? [] };
      }
      const added = await addSimulationToScene({
        sheets: { parts: contourSheetParts(result.layers, thicknessMm), routerRadiusMm },
        transform: result.stockTransform,
        kind: 'contour',
        label: 'Contour stack',
        placement,
        details: [`${result.layers.length} layers of ${thicknessMm} mm stock`],
      });
      // The model, stretched the way the stack is.
      const tris = collectSceneTriangles(scene).tris;
      let six = 0;
      for (let t = 0; t + 8 < tris.length; t += 9) {
        six += tris[t] * (tris[t + 4] * tris[t + 8] - tris[t + 5] * tris[t + 7])
          - tris[t + 1] * (tris[t + 3] * tris[t + 8] - tris[t + 5] * tris[t + 6])
          + tris[t + 2] * (tris[t + 3] * tris[t + 7] - tris[t + 4] * tris[t + 6]);
      }
      const [sx, sy, sz] = result.stockTransform.scale;
      const model = (six / 6) * 1e9 * sx * sy * sz;
      return {
        ok: true, id: added.id, name: added.name, kind: 'contour', placement,
        layers: result.layers.length,
        volumeMm3: Math.round(added.volumeMm3),
        modelVolumeMm3: Math.round(model),
        stackVsModel: model > 0 ? +(added.volumeMm3 / model).toFixed(4) : null,
        warnings: result.warnings ?? [],
      };
    }

    if (msg.kind === 'sheet') {
      // The net physics_export_sheet_unfold would hand over, with the same
      // options, folded back up along its own lines.
      const sheetMode = msg.sheetMode ?? msg.mode;
      const options: SheetUnfoldOptions = {
        ...DEFAULT_SHEET_UNFOLD_OPTIONS,
        ...(sheetMode === 'papercraft' || sheetMode === 'sheet_metal' || sheetMode === 'soft_goods' ? { mode: sheetMode } : {}),
        ...(num(msg.materialThicknessMm) ? { thicknessMm: num(msg.materialThicknessMm) } : {}),
        ...(num(msg.thicknessMm) ? { thicknessMm: num(msg.thicknessMm) } : {}),
        ...(typeof msg.bendRadiusMm === 'number' && msg.bendRadiusMm >= 0 ? { bendRadiusMm: msg.bendRadiusMm } : {}),
        ...(typeof msg.kFactor === 'number' && msg.kFactor >= 0 && msg.kFactor <= 1 ? { kFactor: msg.kFactor } : {}),
        ...(num(msg.scaleFactor) ? { scaleFactor: num(msg.scaleFactor) } : {}),
      };
      const targetIds = Array.isArray(msg.targetIds)
        ? msg.targetIds.filter((x): x is string => typeof x === 'string')
        : typeof msg.targetId === 'string' ? [msg.targetId] : undefined;
      const res = exportSheetUnfold(scene, options, targetIds);
      if (!res.success) return { ok: false, error: res.error || 'Nothing in the scene unfolds.', warnings: res.warnings };
      const { fold, request } = sheetFoldSimulationRequest(res, options);
      const added = await addSimulationToScene({ ...request, placement });
      return {
        ok: true, id: added.id, name: added.name, kind: 'sheet', placement,
        mode: res.mode,
        pieces: fold.islands,
        folds: fold.folds,
        volumeMm3: Math.round(added.volumeMm3),
        // Fitted to the model: how far a model corner lies off its folded
        // face, or a cut edge off its folded line.
        maxDeviationMm: +fold.deviation.maxMm.toFixed(3),
        meanDeviationMm: +fold.deviation.meanMm.toFixed(3),
        warnings: res.warnings,
      };
    }

    if (msg.kind === 'tube') {
      // The pipe frame made from its cut list, every tube seated hub to hub.
      const bd = breakdownPipeFrame(scene, msg as Partial<PipeFrameOptions>);
      if (!bd.struts.length) return { ok: false, error: 'The scene has no pipes: frame a shape in the Pipes dialog first, or load a pipe frame from Examples.', warnings: bd.warnings };
      const { figures, request } = pipeFrameSimulationRequest(bd, sceneStockTransform());
      const added = await addSimulationToScene({ ...request, placement });
      return {
        ok: true, id: added.id, name: added.name, kind: 'tube', placement,
        ...figures,
        volumeMm3: Math.round(added.volumeMm3),
        warnings: bd.warnings,
      };
    }

    if (msg.kind === 'timber') {
      // The frame physics_timber_breakdown plans, made from its cut list
      // and its window programs, the tenons fitted into what they leave.
      const others = Array.isArray(msg.withIds) ? msg.withIds.filter((v): v is string => typeof v === 'string') : [];
      const targetIds = typeof msg.bodyId === 'string'
        ? [msg.bodyId, ...others]
        : resolveTimberTargetIds(scene.nodes, store.selectedNodeId, others);
      if (!targetIds.length) return { ok: false, error: 'Give body_id, or add a body to the scene first.' };
      const { items } = collectIndividualPartSoups(scene, targetIds);
      if (!items.length) return { ok: false, error: `${targetIds[0]} has no solid geometry to break down.` };
      const world = breakdownFrameToWorld(scene.nodes, targetIds[0]);
      if (!world) return { ok: false, error: `No body called ${targetIds[0]}.` };
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
      const planned = await runJob((c) => c.run('timber', scene, {
        mode: 'frame',
        soups: items.map((it) => it.soup),
        joineryOptions: {
          jointMode: msg.jointMode === 'dado' ? 'dado' : 'mortise_tenon',
          tenonCornerFit: msg.tenonCornerFit === 'round_tenon' || msg.tenonCornerFit === 'chisel_square' ? msg.tenonCornerFit : 'dogbone',
          cutterDiaMm: n(msg.cutterDiaMm),
          shoulderMm: n(msg.shoulderMm),
          tenonLengthMm: n(msg.tenonLengthMm),
          clearanceMm: n(msg.clearanceMm),
          maxBoardWidthMm: n(msg.maxBoardWidthMm),
        },
        cncBedMm: [store.cncBed.widthMm, store.cncBed.depthMm, store.cncBed.heightMm],
        defaultStockLengthMm: n(msg.stockLengthMm) ?? 1800,
      }));
      if (!planned.outcome.ok) return { ok: false, error: planned.outcome.error };
      if (!planned.cutPlan) return { ok: false, error: 'The frame has no cut plan.' };
      const sim = await simulateTimberOffThread({ breakdown: planned.outcome, cutPlan: planned.cutPlan });
      const { figures, request } = timberSimulationRequest(sim, world);
      const added = await addSimulationToScene({ ...request, placement });
      return {
        ok: true, id: added.id, name: added.name, kind: 'timber', placement,
        ...figures,
        volumeMm3: Math.round(added.volumeMm3),
        warnings: planned.outcome.warnings,
      };
    }

    return { ok: false, error: "kind must be 'relief', 'machining', 'laser', 'contour', 'sheet', 'tube', 'timber', 'mold' or 'mold_cast'." };
  },
};
