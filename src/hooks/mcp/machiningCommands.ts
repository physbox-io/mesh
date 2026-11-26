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
import { defaultCornerRelief, layoutCutOutset, layoutKerf, layoutMargin } from '../../utils/sheetCutRecipe';
import { addSimulationToScene, sceneStockTransform, simulateTimberOffThread } from '../useAddSimulation';
import { addMcpSimulationSteps } from '../useSimulationSteps';
import { breakdownFrameToWorld, timberSimulationRequest } from '../../utils/timberSimulation';
import { pipeFrameSimulationRequest } from '../../utils/tubeSimulation';
import { runMcpMoldSimulation } from '../../utils/moldWorkerClient';
import { mcpMoldSubject } from '../../utils/moldSubject';
import { ExportWorkerClient } from '../../utils/exportWorkerClient';
import { findNodeInScene, describeFiles } from './bridgeUtils';
import { reliefOptionsFor, machiningOptionsFor } from './exportOptions';
import { webSerialManager } from '../../utils/webSerialManager';
import type { McpCommands } from './types';
import type { SceneGraph } from '../../types/scene';

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

/**
 * What an export works on, as the dialogs take the selection: master_id
 * (comma-separated for several bodies), else every body that is not a
 * simulation.
 */
function exportSubject(msg: Record<string, unknown>, scene: SceneGraph, verb: string, toId: (s: string) => string = (s) => s) {
  if (msg.masterId !== undefined && msg.masterId !== null && typeof msg.masterId !== 'string') {
    return { error: 'masterId must be a string.' };
  }
  return mcpMoldSubject(scene, msg.masterId, (id) => findNodeInScene(scene.nodes, toId(id)), verb);
}

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
  EXPORT_RELIEF: async (msg, { store, toId }) => {
    if (!store.sceneGraph.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to carve.' };
    const subject = exportSubject(msg, store.sceneGraph, 'carve', (s) => (toId ? toId(s) : s) as string);
    if ('error' in subject) return { ok: false, error: subject.error };
    const scene = subject.scene;
    let options: ReturnType<typeof reliefOptionsFor>['options'];
    let fromDialog: boolean;
    try {
      ({ options, fromDialog } = reliefOptionsFor(msg));
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const client = new ExportWorkerClient();
    let result: ReliefCarveResult;
    try {
      result = await client.run('relief', scene, options);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
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
  EXPORT_MACHINING: async (msg, { store, toId }) => {
    if (!store.sceneGraph.nodes?.length) return { ok: false, error: 'The scene is empty — there is nothing to machine.' };
    const subject = exportSubject(msg, store.sceneGraph, 'machine', (s) => (toId ? toId(s) : s) as string);
    if ('error' in subject) return { ok: false, error: subject.error };
    const scene = subject.scene;
    let options: ReturnType<typeof machiningOptionsFor>;
    try {
      options = machiningOptionsFor(msg, scene);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    // On a worker, as the dialog plans it: on the page, a big part froze
    // the tab for the half minute its plan takes.
    const client = new ExportWorkerClient();
    let result: SolidMachiningResult;
    try {
      result = await client.run('solid', scene, options);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      client.dispose();
    }
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
        // Setups in the order they run (present whenever `setups` was requested or planned).
        ...(result.plan ? {
          plan: result.plan.text,
          upChosen: result.upChosen,
          remaining: result.plan.remaining,
          redesignHint: result.plan.redesignHint ?? null,
          dropped: result.plan.dropped,
        } : {}),
        ...(result.setups ? {
          setups: result.setups.map((st) => ({
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
    if (msg.masterId !== undefined && msg.masterId !== null && typeof msg.masterId !== 'string') {
      return { ok: false, error: 'masterId must be a string.' };
    }
    if (msg.bodyId !== undefined && msg.bodyId !== null && typeof msg.bodyId !== 'string') {
      return { ok: false, error: 'bodyId must be a string.' };
    }
    if (msg.body_id !== undefined && msg.body_id !== null && typeof msg.body_id !== 'string') {
      return { ok: false, error: 'body_id must be a string.' };
    }

    if (msg.kind === 'mold' || msg.kind === 'mold_cast' || msg.kind === 'cast') {
      for (const key of [
        'wallMm', 'wallMarginMm', 'floorMm', 'baseThicknessMm', 'pinDiaMm', 'pinDiameterMm',
        'pinHeightMm', 'sprueTopDiaMm', 'sprueBottomDiaMm', 'ventDiaMm', 'linerSkinMm',
        'coverMm', 'siliconeBudgetG', 'holeDiaMm', 'hole_dia_mm',
      ] as const) {
        const chk = checkPos(msg[key], key);
        if (!chk.ok) return chk;
      }
      for (const key of [
        'pinToleranceMm', 'cavityDepthMm', 'draftAngleDeg', 'draftDeg', 'shrinkPercent',
        'fillMm', 'copeDragHeightMm',
      ] as const) {
        const chk = checkNonNeg(msg[key], key);
        if (!chk.ok) return chk;
      }
      const holeAt = msg.holeAtMm ?? msg.hole_at_mm;
      if (holeAt !== undefined && holeAt !== null) {
        if (!Array.isArray(holeAt) || holeAt.length !== 2 || !holeAt.every((v) => typeof v === 'number' && Number.isFinite(v))) {
          return { ok: false, error: 'holeAtMm must be [x, y] of finite numbers in mm.' };
        }
      }
      try {
        return await runMcpMoldSimulation({
          msg,
          scene,
          placement,
          toId: (s) => (toId ? toId(s) : s) as string,
          findNodeInScene,
          describeFiles,
        });
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    if (!scene.nodes?.some((n) => !n.simulation)) {
      return { ok: false, error: 'The scene has nothing to cut but earlier simulations.' };
    }
    // Relief, machining, laser, contour, sheet and tube cut master_id (or
    // body_id on sheet), else every body; timber names its parts with body_id.
    let subjectScene = scene;
    if (
      msg.kind === 'relief' ||
      msg.kind === 'machining' ||
      msg.kind === 'laser' ||
      msg.kind === 'contour' ||
      msg.kind === 'sheet' ||
      msg.kind === 'tube'
    ) {
      const subjectMsg = msg.kind === 'sheet' ? { ...msg, masterId: msg.masterId ?? msg.bodyId } : msg;
      const subject = exportSubject(subjectMsg, scene, 'cut', (s) => (toId ? toId(s) : s) as string);
      if ('error' in subject) return { ok: false, error: subject.error };
      subjectScene = subject.scene;
    }

    const runJob = async <T,>(go: (client: ExportWorkerClient) => Promise<T>) => {
      const client = new ExportWorkerClient();
      try { return await go(client); } finally { client.dispose(); }
    };

    try {
      if (msg.kind === 'relief') {
        const { options, fromDialog } = reliefOptionsFor(msg);
        const result: ReliefCarveResult = await runJob((c) => c.run('relief', subjectScene, options));
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
        const options = machiningOptionsFor(msg, subjectScene);
        // On the worker: a big part's plan takes half a minute, and on the
        // page it froze the tab for all of it.
        const result: SolidMachiningResult = await runJob((c) => c.run('solid', subjectScene, options));
        if (!result.success || !result.stockTransform) {
          return { ok: false, error: result.error || 'The machining program could not be generated.', warnings: result.warnings ?? [] };
        }
        if (msg.stage !== undefined) {
          const staged = await addMcpSimulationSteps(result, options, msg.stage);
          if (staged.ok && msg.placement === 'overlay') {
            const overlayNote = "Staged machining replay uses 'beside' placement (ignoring placement: 'overlay').";
            return {
              ...staged,
              note: 'note' in staged && staged.note ? `${staged.note} ${overlayNote}` : overlayNote,
            };
          }
          return staged;
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
        if (msg.machine !== undefined && msg.machine !== null && msg.machine !== 'laser' && msg.machine !== 'cnc' && msg.machine !== 'router') {
          return { ok: false, error: "machine is 'laser', 'cnc' or 'router'." };
        }
        const bitChk = checkPos(msg.bitDiaMm, 'bitDiaMm');
        if (!bitChk.ok) return bitChk;
        const thickChk = checkPos(msg.materialThicknessMm, 'materialThicknessMm');
        if (!thickChk.ok) return thickChk;
        const scaleChk = checkPos(msg.scaleFactor, 'scaleFactor');
        if (!scaleChk.ok) return scaleChk;
        const state = useStore.getState();
        const router =
          msg.machine === 'cnc' ||
          msg.machine === 'router' ||
          (msg.machine == null && state.machineTarget === 'cnc');
        // Laid out as the dialog lays it out for that machine (sheetCutRecipe):
        // a router gets no kerf, and dogbones in the corners its bit leaves round.
        const machine = router ? 'cnc' : 'laser';
        const bitDiaMm = bitChk.value ?? 3.175;
        const routerRadiusMm = router ? bitDiaMm / 2 : 0;
        const stock = state.stock;
        // A contour layer is one sheet of the bench's stock, as in its dialog.
        const thicknessMm = thickChk.value
          ?? (msg.kind === 'contour' ? stock.thicknessMm : 3);
        const scaleFactor = scaleChk.value;
        if (msg.kind === 'laser') {
          if (msg.jointMode !== undefined && msg.jointMode !== null
            && msg.jointMode !== 'finger' && msg.jointMode !== 'slot' && msg.jointMode !== 'glue') {
            return { ok: false, error: "jointMode is 'finger', 'slot' or 'glue'." };
          }
          const jointMode =
            msg.jointMode === 'finger' || msg.jointMode === 'slot' || msg.jointMode === 'glue'
              ? msg.jointMode
              : DEFAULT_LASER_OPTIONS.jointMode;
          const result: LaserCutResult = await runJob((c) =>
            c.run('laser', subjectScene, {
            ...DEFAULT_LASER_OPTIONS,
            jointMode,
            materialThickness: thicknessMm / 1000,
            kerf: layoutKerf(machine, DEFAULT_LASER_OPTIONS.kerf),
            margin: layoutMargin(machine, bitDiaMm / 1000),
            cutOutset: layoutCutOutset(machine, bitDiaMm / 1000),
            cornerRelief: defaultCornerRelief(machine),
            bitDiameter: bitDiaMm / 1000,
            sheetWidth: stock.widthMm / 1000,
            sheetHeight: stock.depthMm / 1000,
            ...(scaleFactor ? { scaleFactor } : {}),
          }));
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
          c.run('contour', subjectScene, {
            ...DEFAULT_CONTOUR_OPTIONS,
            materialThickness: thicknessMm / 1000,
            kerf: layoutKerf(machine, DEFAULT_CONTOUR_OPTIONS.kerf),
            margin: layoutMargin(machine, bitDiaMm / 1000),
            cutOutset: layoutCutOutset(machine, bitDiaMm / 1000),
            sheetWidth: stock.widthMm / 1000,
            sheetHeight: stock.depthMm / 1000,
            ...(scaleFactor ? { scaleFactor } : {}),
          }));
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
        const tris = collectSceneTriangles(subjectScene).tris;
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
        if (sheetMode !== undefined && sheetMode !== null
          && sheetMode !== 'papercraft' && sheetMode !== 'sheet_metal' && sheetMode !== 'soft_goods') {
          return { ok: false, error: "sheetMode is 'papercraft', 'sheet_metal' or 'soft_goods'." };
        }
        const matThick = checkPos(msg.materialThicknessMm, 'materialThicknessMm');
        if (!matThick.ok) return matThick;
        const thick = checkPos(msg.thicknessMm, 'thicknessMm');
        if (!thick.ok) return thick;
        const bend = checkNonNeg(msg.bendRadiusMm, 'bendRadiusMm');
        if (!bend.ok) return bend;
        const scale = checkPos(msg.scaleFactor, 'scaleFactor');
        if (!scale.ok) return scale;
        if (msg.kFactor !== undefined && msg.kFactor !== null
          && (typeof msg.kFactor !== 'number' || !Number.isFinite(msg.kFactor) || msg.kFactor < 0 || msg.kFactor > 1)) {
          return { ok: false, error: 'kFactor must be a finite number between 0 and 1.' };
        }
        const options: SheetUnfoldOptions = {
          ...DEFAULT_SHEET_UNFOLD_OPTIONS,
          ...(sheetMode === 'papercraft' || sheetMode === 'sheet_metal' || sheetMode === 'soft_goods' ? { mode: sheetMode } : {}),
          ...(matThick.value !== undefined ? { thicknessMm: matThick.value } : {}),
          ...(thick.value !== undefined ? { thicknessMm: thick.value } : {}),
          ...(bend.value !== undefined ? { bendRadiusMm: bend.value } : {}),
          ...(typeof msg.kFactor === 'number' ? { kFactor: msg.kFactor } : {}),
          ...(scale.value !== undefined ? { scaleFactor: scale.value } : {}),
        };
        const resolveSheetId = (s: string) => (toId ? toId(s) : s) as string;
        const targetIds = Array.isArray(msg.targetIds)
          ? msg.targetIds.filter((x): x is string => typeof x === 'string').map(resolveSheetId)
          : typeof msg.targetId === 'string' ? [resolveSheetId(msg.targetId)] : undefined;
        const res = exportSheetUnfold(subjectScene, options, targetIds);
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
        const bd = breakdownPipeFrame(subjectScene, msg as Partial<PipeFrameOptions>);
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
        const resolveId = (id: string) => (toId ? String(toId(id)) : id);
        const rawBodyId =
          typeof msg.bodyId === 'string'
            ? msg.bodyId
            : typeof msg.body_id === 'string'
              ? msg.body_id
              : null;
        const rawWithInput = msg.withIds ?? msg.with_ids;
        if (rawWithInput !== undefined && rawWithInput !== null) {
          if (!Array.isArray(rawWithInput) || !rawWithInput.every((v) => typeof v === 'string')) {
            return { ok: false, error: 'withIds must be an array of body IDs or names.' };
          }
        }
        const rawWithIds: string[] = Array.isArray(rawWithInput) ? (rawWithInput as string[]) : [];
        const missingWith = rawWithIds.filter((raw) => !findNodeInScene(scene.nodes, resolveId(raw)));
        if (missingWith.length) {
          return { ok: false, error: `No body called ${missingWith.join(', ')}.` };
        }
        const others = rawWithIds.map((raw) => findNodeInScene(scene.nodes, resolveId(raw))!.id);
        const targetIds = rawBodyId
          ? [resolveId(rawBodyId), ...others]
          : resolveTimberTargetIds(scene.nodes, store.selectedNodeId, others);
        if (!targetIds.length) return { ok: false, error: 'Give body_id, or add a body to the scene first.' };
        const world = breakdownFrameToWorld(scene.nodes, targetIds[0]);
        if (!world) return { ok: false, error: `No body called ${rawBodyId ?? targetIds[0]}.` };
        const { items } = collectIndividualPartSoups(scene, targetIds);
        if (!items.length) return { ok: false, error: `${rawBodyId ?? targetIds[0]} has no solid geometry to break down.` };

        const cutterDia = checkPos(msg.cutterDiaMm ?? msg.cutter_dia_mm, 'cutterDiaMm');
        if (!cutterDia.ok) return cutterDia;
        const shoulder = checkNonNeg(msg.shoulderMm ?? msg.shoulder_mm, 'shoulderMm');
        if (!shoulder.ok) return shoulder;
        const tenonLen = checkPos(msg.tenonLengthMm ?? msg.tenon_length_mm, 'tenonLengthMm');
        if (!tenonLen.ok) return tenonLen;
        const clearance = checkNonNeg(msg.clearanceMm ?? msg.clearance_mm, 'clearanceMm');
        if (!clearance.ok) return clearance;
        const maxBoardW = checkPos(msg.maxBoardWidthMm ?? msg.max_board_width_mm, 'maxBoardWidthMm');
        if (!maxBoardW.ok) return maxBoardW;
        const stockLen = checkPos(msg.stockLengthMm ?? msg.stock_length_mm, 'stockLengthMm');
        if (!stockLen.ok) return stockLen;

        const rawJointMode = msg.jointMode ?? msg.joint_mode;
        if (rawJointMode !== undefined && rawJointMode !== null
          && rawJointMode !== 'mortise_tenon' && rawJointMode !== 'dado' && rawJointMode !== 'dowel' && rawJointMode !== 'butt' && rawJointMode !== 'glue') {
          return { ok: false, error: "jointMode is 'mortise_tenon', 'dado', 'dowel', 'butt' or 'glue'." };
        }
        const rawCornerFit = msg.tenonCornerFit ?? msg.tenon_corner_fit;
        if (rawCornerFit !== undefined && rawCornerFit !== null
          && rawCornerFit !== 'dogbone' && rawCornerFit !== 'round_tenon' && rawCornerFit !== 'chisel_square') {
          return { ok: false, error: "tenonCornerFit is 'dogbone', 'round_tenon' or 'chisel_square'." };
        }
        const rawClips = msg.tabletopClips ?? msg.tabletop_clips;
        const rawBed = msg.cncBedMm ?? msg.cnc_bed_mm;
        let cncBedMm: [number, number, number];
        if (rawBed !== undefined && rawBed !== null) {
          if (!Array.isArray(rawBed) || rawBed.length !== 3 || !rawBed.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
            return { ok: false, error: 'cncBedMm must be [width, depth, height] of positive finite numbers in mm.' };
          }
          cncBedMm = [rawBed[0], rawBed[1], rawBed[2]];
        } else {
          const latestBed = useStore.getState().cncBed;
          cncBedMm = [latestBed.widthMm, latestBed.depthMm, latestBed.heightMm];
        }
        const motion = webSerialManager.getState().motion;
        const planned = await runJob((c) => c.run('timber', scene, {
          mode: 'frame',
          soups: items.map((it) => it.soup),
          joineryOptions: {
            jointMode: rawJointMode === 'dado' ? 'dado' : 'mortise_tenon',
            tenonCornerFit: rawCornerFit === 'round_tenon' || rawCornerFit === 'chisel_square' ? rawCornerFit : 'dogbone',
            cutterDiaMm: cutterDia.value,
            shoulderMm: shoulder.value,
            tenonLengthMm: tenonLen.value,
            clearanceMm: clearance.value,
            maxBoardWidthMm: maxBoardW.value,
            ...(typeof rawClips === 'boolean' ? { tabletopClips: rawClips } : {}),
          },
          cncBedMm,
          defaultStockLengthMm: stockLen.value ?? 1800,
          spindle: motion.spindle,
          maxFeedMmMin: Math.min(motion.maxRate.x, motion.maxRate.y),
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
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    return { ok: false, error: "kind must be 'relief', 'machining', 'laser', 'contour', 'sheet', 'tube', 'timber', 'mold' or 'mold_cast'." };
  },
};
