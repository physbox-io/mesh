// ---------------------------------------------------------------------------
// MCP commands that generate parts from a scene: timber breakdown,
// sheet unfold, PCB enclosure, mechanisms, pipe frames
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { framingPatch } from '../../store/sceneFraming';
import { loadManifold } from '../../utils/sculptCut';
import {
  classifyTimberAutoMode, collectIndividualPartSoups, decomposeSolidIntoPlanks, isNonWoodNode, resolveTimberTargetIds, type PlankJointType,
} from '../../utils/timberBreakdown';
import {
  synthesizeTimberJoinery, type TenonCornerFit, type TimberEdgeProfile, type TimberJointMode,
} from '../../utils/timberJoinery';
import { buildTimberCutPlan } from '../../utils/timberCutList';
import { webSerialManager } from '../../utils/webSerialManager';
import { exportSheetUnfold, type SheetUnfoldOptions } from '../../utils/sheetUnfoldExporter';
import {
  PCB_PRESETS, buildPcbNode, decodePcbHandoff, exportPcbFaceplateSvg, generatePcbEnclosure,
  type PcbEnclosureFace, type PcbEnclosureOptions, type PcbMechanicalSpec,
} from '../../utils/pcbEnclosureSync';
import { buildMechanism, type MechanismRequest } from '../../utils/buildMechanism';
import { adjustmentWarnings } from '../../utils/mechanismAdjustments';
import {
  PIPE_STANDARDS, breakdownPipeFrame, withoutHubsAt,
  generatePipeStructurePreset, type PipeFrameOptions, type PipeStandardId,
  type PipeStructurePresetId,
} from '../../utils/tubeAndWireExporter';
import { WHOLE_SCENE } from '../../utils/pipeSkeleton';
import { buildHubsOffThread, frameBodyOffThread } from '../../utils/pipeFrameClient';
import { findNodeInScene } from './bridgeUtils';
import { settleScene } from './settleScene';
import type { McpCommands, McpHandler } from './types';

const PIPE_STRUCTURE_PRESETS = ['mini_greenhouse', 'yard_pub', 'carport', 'geodesic_dome'] as const;

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

function checkFiniteNum(v: unknown, name: string): { ok: true; value: number | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    return { ok: false, error: `${name} must be a finite number.` };
  }
  return { ok: true, value: v };
}

function checkVec3(v: unknown, name: string): { ok: true; value: [number, number, number] | undefined } | { ok: false; error: string } {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (!Array.isArray(v) || v.length !== 3 || !v.every((x) => typeof x === 'number' && Number.isFinite(x))) {
    return { ok: false, error: `${name} must be a 3-element array of finite numbers.` };
  }
  return { ok: true, value: [v[0], v[1], v[2]] };
}

  /*
   * Timber & Joinery Breakdown (`physics_timber_breakdown` / `BREAKDOWN_JOINERY`):
   * Decompose either:
   *   (a) Large architectural/enclosure/cabinet solids into machinable timber
   *       planks with interlocking rabbet, miter, finger, or butt joints,
   *       alignment dowels, hollow interior option, and lay-flat sheet packing; OR
   *   (b) Framed furniture (table, chair, flower stand) into mortise-and-tenon
   *       legs & rails, stopped edge roundovers, 1D stock bars, and CNC windows.
   */
const breakdownJoineryCommand: McpHandler = async (msg, { store, toId }) => {
  const resolveId = (id: string) => (toId ? String(toId(id)) : id);
  const rawBodyInput = msg.bodyId ?? msg.body_id;
  if (rawBodyInput !== undefined && rawBodyInput !== null && typeof rawBodyInput !== 'string') {
    return { ok: false, error: 'bodyId must be a string.' };
  }
  const rawBodyId = typeof rawBodyInput === 'string' ? rawBodyInput : null;
  const explicitBodyId = rawBodyId ? resolveId(rawBodyId) : null;
  const rawWithInput = msg.withIds ?? msg.with_ids;
  if (rawWithInput !== undefined && rawWithInput !== null) {
    if (!Array.isArray(rawWithInput) || !rawWithInput.every((v) => typeof v === 'string')) {
      return { ok: false, error: 'withIds must be an array of body IDs or names.' };
    }
  }
  const rawWithIds: string[] = Array.isArray(rawWithInput) ? (rawWithInput as string[]) : [];
  const missingWith = rawWithIds.filter((raw) => !findNodeInScene(store.sceneGraph.nodes, resolveId(raw)));
  if (missingWith.length) {
    return { ok: false, error: `No body called ${missingWith.join(', ')}.` };
  }
  const others = rawWithIds.map((raw) => findNodeInScene(store.sceneGraph.nodes, resolveId(raw))!.id);
  const woodRoots = store.sceneGraph.nodes.filter((n) => !isNonWoodNode(n));
  const targetIds = explicitBodyId
    ? [explicitBodyId, ...others]
    : rawWithIds.length > 0
      ? resolveTimberTargetIds(store.sceneGraph.nodes, store.selectedNodeId, others)
      : woodRoots.length > 1
        ? woodRoots.map((n) => n.id)
        : resolveTimberTargetIds(store.sceneGraph.nodes, store.selectedNodeId, others);
  if (!targetIds.length) return { ok: false, error: 'Give bodyId, or add a body to the scene first.' };
  const primary = findNodeInScene(store.sceneGraph.nodes, targetIds[0]);
  if (!primary) return { ok: false, error: `No body called ${rawBodyId ?? targetIds[0]}.` };

  const { items, absorbed } = collectIndividualPartSoups(store.sceneGraph, targetIds, {
    strictIds: rawWithIds.length > 0,
  });
  if (!items.length) return { ok: false, error: `${primary.name} has no solid geometry to break down.` };
  const targetedIds = Array.from(new Set([...targetIds, ...absorbed]));

  const boardThick = checkPos(msg.boardThicknessMm ?? msg.board_thickness_mm, 'boardThicknessMm');
  if (!boardThick.ok) return boardThick;
  const wallThick = checkPos(msg.wallThicknessMm ?? msg.wall_thickness_mm, 'wallThicknessMm');
  if (!wallThick.ok) return wallThick;
  const maxBoardW = checkPos(msg.maxBoardWidthMm ?? msg.max_board_width_mm, 'maxBoardWidthMm');
  if (!maxBoardW.ok) return maxBoardW;
  const maxBoardL = checkPos(msg.maxBoardLengthMm ?? msg.max_board_length_mm, 'maxBoardLengthMm');
  if (!maxBoardL.ok) return maxBoardL;
  const fingerW = checkPos(msg.fingerWidthMm ?? msg.finger_width_mm, 'fingerWidthMm');
  if (!fingerW.ok) return fingerW;
  const dowelDia = checkNonNeg(msg.dowelDiaMm ?? msg.dowel_dia_mm, 'dowelDiaMm');
  if (!dowelDia.ok) return dowelDia;
  const dowelLen = checkNonNeg(msg.dowelLengthMm ?? msg.dowel_length_mm, 'dowelLengthMm');
  if (!dowelLen.ok) return dowelLen;
  const clearance = checkNonNeg(msg.clearanceMm ?? msg.clearance_mm, 'clearanceMm');
  if (!clearance.ok) return clearance;
  const cutterDia = checkPos(msg.cutterDiaMm ?? msg.cutter_dia_mm, 'cutterDiaMm');
  if (!cutterDia.ok) return cutterDia;
  const shoulder = checkNonNeg(msg.shoulderMm ?? msg.shoulder_mm, 'shoulderMm');
  if (!shoulder.ok) return shoulder;
  const tenonLen = checkPos(msg.tenonLengthMm ?? msg.tenon_length_mm, 'tenonLengthMm');
  if (!tenonLen.ok) return tenonLen;
  const edgeRad = checkNonNeg(msg.edgeRadiusMm ?? msg.edge_radius_mm, 'edgeRadiusMm');
  if (!edgeRad.ok) return edgeRad;
  const stopMargin = checkNonNeg(msg.stopMarginMm ?? msg.stop_margin_mm, 'stopMarginMm');
  if (!stopMargin.ok) return stopMargin;
  const stockLen = checkPos(msg.stockLengthMm ?? msg.stock_length_mm, 'stockLengthMm');
  if (!stockLen.ok) return stockLen;

  const rawBed = msg.cncBedMm ?? msg.cnc_bed_mm;
  if (rawBed !== undefined && rawBed !== null) {
    if (!Array.isArray(rawBed) || rawBed.length !== 3 || !rawBed.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
      return { ok: false, error: 'cncBedMm must be [width, depth, height] of positive finite numbers in mm.' };
    }
  }

  const placement: 'replace' | 'beside' = msg.placement === 'beside' ? 'beside' : 'replace';

  const rawJointType = msg.jointType ?? msg.joint_type;
  const hasPlankSpecificArg =
    msg.mode === 'planks' ||
    rawJointType === 'rabbet' ||
    rawJointType === 'miter' ||
    rawJointType === 'finger' ||
    rawJointType === 'butt' ||
    rawJointType === 'glue' ||
    msg.boardThicknessMm !== undefined ||
    msg.board_thickness_mm !== undefined ||
    msg.wallThicknessMm !== undefined ||
    msg.wall_thickness_mm !== undefined ||
    msg.hollowInterior !== undefined ||
    msg.hollow_interior !== undefined ||
    msg.fingerWidthMm !== undefined ||
    msg.finger_width_mm !== undefined ||
    msg.dowelDiaMm !== undefined ||
    msg.dowel_dia_mm !== undefined ||
    msg.maxBoardLengthMm !== undefined ||
    msg.max_board_length_mm !== undefined;

  try {
    const wasm = await loadManifold();
    const soups = items.map((it) => it.soup);
    const hintNames = items.map((it) => it.hintName);

    if (hasPlankSpecificArg && msg.mode !== 'frame') {
      const jointType: PlankJointType =
        rawJointType === 'miter' || rawJointType === 'finger' || rawJointType === 'butt' || rawJointType === 'glue'
          ? rawJointType
          : 'rabbet';
      const plankRes = decomposeSolidIntoPlanks(
        wasm,
        soups,
        {
          boardThicknessMm: boardThick.value,
          wallThicknessMm: wallThick.value,
          maxBoardWidthMm: maxBoardW.value,
          maxBoardLengthMm: maxBoardL.value,
          jointType,
          fingerWidthMm: fingerW.value,
          dowelDiaMm: dowelDia.value,
          dowelLengthMm: dowelLen.value,
          clearanceMm: clearance.value,
          hollowInterior:
            typeof msg.hollowInterior === 'boolean'
              ? msg.hollowInterior
              : typeof msg.hollow_interior === 'boolean'
                ? msg.hollow_interior
                : undefined,
        },
        hintNames,
      );
      if (!plankRes.ok) return plankRes;

      const names = plankRes.planks.map((p) => p.id);
      const ids =
        msg.apply === true
          ? useStore.getState().splitBodyForPrint(primary.id, plankRes.sections, absorbed, {
              plain: false,
              names,
              centerOrigin: true,
              placement,
            })
          : null;

      return {
        ok: true,
        mode: 'planks',
        targetedIds,
        applied: !!ids,
        placement: ids ? placement : undefined,
        options: plankRes.options,
        totalVolumeMm3: plankRes.totalVolumeMm3,
        originalVolumeMm3: plankRes.originalVolumeMm3,
        hollowedVolumeMm3: plankRes.hollowedVolumeMm3,
        layFlatSheetMm: plankRes.layFlatSheetMm,
        planks: plankRes.planks.map((p, idx) => ({
          index: idx,
          id: p.id,
          ...(ids ? { sceneNodeId: ids[idx] } : {}),
          name: p.name,
          wallFace: p.wallFace,
          dimensionsMm: p.dimensionsMm,
          grainAxis: p.grainAxis,
          volumeMm3: p.volumeMm3,
          explodedOffsetMm: p.explodedOffsetMm,
          layFlatOffsetMm: p.layFlatOffsetMm,
          layFlatSizeMm: p.layFlatSizeMm,
          dowelCount: p.dowelHoles.length,
          jointSummary: p.jointSummary,
          joints: p.joints,
        })),
        bomMarkdown: plankRes.bomMarkdown,
        warnings: plankRes.warnings,
      };
    }

    const rawJointMode = msg.jointMode ?? msg.joint_mode;
    const jointMode: TimberJointMode =
      rawJointMode === 'dowel' || rawJointMode === 'dado' || rawJointMode === 'butt'
        ? rawJointMode
        : rawJointMode === 'glue'
          ? 'butt'
          : 'mortise_tenon';
    const rawCornerFit = msg.tenonCornerFit ?? msg.tenon_corner_fit;
    const tenonCornerFit: TenonCornerFit =
      rawCornerFit === 'round_tenon' || rawCornerFit === 'chisel_square' ? rawCornerFit : 'dogbone';
    const rawEdgeProfile = msg.edgeProfile ?? msg.edge_profile;
    const edgeProfile: TimberEdgeProfile =
      rawEdgeProfile === 'chamfer' || rawEdgeProfile === 'square' ? rawEdgeProfile : 'roundover';
    const rawCutMethod = msg.tenonCutMethod ?? msg.tenon_cut_method;
    const rawClips = msg.tabletopClips ?? msg.tabletop_clips;

    const outcome = synthesizeTimberJoinery(
      wasm,
      soups,
      {
        jointMode,
        tenonCornerFit,
        edgeProfile,
        cutterDiaMm: cutterDia.value,
        shoulderMm: shoulder.value,
        tenonLengthMm: tenonLen.value,
        clearanceMm: clearance.value,
        edgeRadiusMm: edgeRad.value,
        stopMarginMm: stopMargin.value,
        maxBoardWidthMm: maxBoardW.value,
        tabletopClips: typeof rawClips === 'boolean' ? rawClips : undefined,
        tenonCutMethod: rawCutMethod === 'cnc' ? 'cnc' : 'bandsaw',
      },
      hintNames,
    );
    if (!outcome.ok) return outcome;

    // If auto-mode found no actual framing members (legs/rails) — e.g. a single
    // slab/panel (even rotated/tilted) or an unframed solid block — fall back to
    // plank breakdown instead of emitting a furniture frame guide.
    if (msg.mode !== 'frame' && classifyTimberAutoMode(outcome) === 'planks' && rawJointMode === undefined) {
      const plankRes = decomposeSolidIntoPlanks(
        wasm,
        soups,
        {
          maxBoardWidthMm: maxBoardW.value,
          clearanceMm: clearance.value,
        },
        hintNames,
      );
      if (plankRes.ok && plankRes.planks.length >= 1) {
        const names = plankRes.planks.map((p) => p.id);
        const ids =
          msg.apply === true
            ? useStore.getState().splitBodyForPrint(primary.id, plankRes.sections, absorbed, {
                plain: false,
                names,
                centerOrigin: true,
                placement,
              })
            : null;
        return {
          ok: true,
          mode: 'planks',
          targetedIds,
          applied: !!ids,
          placement: ids ? placement : undefined,
          options: plankRes.options,
          totalVolumeMm3: plankRes.totalVolumeMm3,
          originalVolumeMm3: plankRes.originalVolumeMm3,
          hollowedVolumeMm3: plankRes.hollowedVolumeMm3,
          layFlatSheetMm: plankRes.layFlatSheetMm,
          planks: plankRes.planks.map((p, idx) => ({
            index: idx,
            id: p.id,
            ...(ids ? { sceneNodeId: ids[idx] } : {}),
            name: p.name,
            wallFace: p.wallFace,
            dimensionsMm: p.dimensionsMm,
            grainAxis: p.grainAxis,
            volumeMm3: p.volumeMm3,
            explodedOffsetMm: p.explodedOffsetMm,
            layFlatOffsetMm: p.layFlatOffsetMm,
            layFlatSizeMm: p.layFlatSizeMm,
            dowelCount: p.dowelHoles.length,
            jointSummary: p.jointSummary,
            joints: p.joints,
          })),
          bomMarkdown: plankRes.bomMarkdown,
          warnings: plankRes.warnings,
        };
      }
    }

    const latestStore = useStore.getState();
    const bedArr = Array.isArray(rawBed) ? (rawBed as number[]) : null;
    const cncBedMm: [number, number, number] =
      bedArr
        ? [bedArr[0], bedArr[1], bedArr[2]]
        : [latestStore.cncBed.widthMm, latestStore.cncBed.depthMm, latestStore.cncBed.heightMm];
    const motion = webSerialManager.getState().motion;

    const cutPlan = buildTimberCutPlan(outcome, {
      cncBedMm,
      defaultStockLengthMm: stockLen.value ?? 1800,
      spindle: motion.spindle,
      maxFeedMmMin: Math.min(motion.maxRate.x, motion.maxRate.y),
    });

    const names = outcome.parts.map((p) => p.member.id);
    const ids =
      msg.apply === true
        ? useStore.getState().splitBodyForPrint(primary.id, outcome.sections, absorbed, {
            plain: false,
            names,
            centerOrigin: true,
            placement,
          })
        : null;

    const hasMortisedLegs = outcome.parts.some((p) => p.member.role === 'leg' && p.mortises.length > 0);
    const buildGuideMarkdown =
      !hasMortisedLegs && cutPlan.birdsEyeMapMarkdown
        ? cutPlan.buildGuideMarkdown.replace(`\n\n---\n\n${cutPlan.birdsEyeMapMarkdown}`, '')
        : cutPlan.buildGuideMarkdown;

    return {
      ok: true,
      mode: 'frame',
      targetedIds,
      applied: !!ids,
      placement: ids ? placement : undefined,
      parts: outcome.parts.map((p, idx) => ({
        index: idx,
        id: p.member.id,
        ...(ids ? { sceneNodeId: ids[idx] } : {}),
        title: p.member.title,
        role: p.member.id.startsWith('Corner_Cleat_') ? 'cleat' : p.member.role,
        mirrorOf: p.member.mirrorOf,
        finishedDimsMm: [p.totalFinishedLengthMm, p.crossSectionMm[0], p.crossSectionMm[1]],
        shoulderToShoulderMm: p.shoulderToShoulderMm,
        face1: p.member.face1.label,
        face2: p.member.face2.label,
        mortiseCount: p.mortises.length,
        tenonCount: p.tenons.length,
        zClipSlotCount: p.zClipSlots.length,
        stoppedEdgeZones: p.stoppedEdgeZones,
      })),
      joints: outcome.joints.map((j) => ({
        id: j.id,
        kind: j.kind,
        between: [j.memberAId, j.memberBId],
        miteredCornerTenon: j.tenon?.miteredTip ?? false,
        notes: j.notes,
      })),
      stockBars: cutPlan.stockBars,
      hardwareBom: cutPlan.hardwareBom,
      cncSetups: cutPlan.allCncSetups.map((s) => ({
        id: s.id,
        partId: s.partId,
        faceUpLabel: s.faceUpLabel,
        fenceFaceLabel: s.fenceFaceLabel,
        indexOffsetFromTopMm: s.indexOffsetFromTopMm,
        overhangMm: s.overhangMm,
        estimatedMinutes: s.estimatedMinutes,
        operationsSummary: s.operationsSummary,
        gcode: s.gcode,
      })),
      buildGuideMarkdown,
      warnings: outcome.warnings,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const exportSheetUnfoldCommand: McpHandler = async (msg, { store, toId }) => {
  const resolveId = (id: string) => (toId ? String(toId(id)) : id);
  const rawMode = msg.mode ?? msg.sheetMode;
  if (rawMode !== undefined && rawMode !== null
    && rawMode !== 'papercraft' && rawMode !== 'sheet_metal' && rawMode !== 'soft_goods') {
    return { ok: false, error: "mode is 'papercraft', 'sheet_metal' or 'soft_goods'." };
  }
  const thickChk = checkPos(msg.thicknessMm, 'thicknessMm');
  if (!thickChk.ok) return thickChk;
  const scaleChk = checkPos(msg.scaleFactor, 'scaleFactor');
  if (!scaleChk.ok) return scaleChk;
  const bendChk = checkNonNeg(msg.bendRadiusMm, 'bendRadiusMm');
  if (!bendChk.ok) return bendChk;
  const tabChk = checkNonNeg(msg.tabWidthMm, 'tabWidthMm');
  if (!tabChk.ok) return tabChk;
  const seamChk = checkNonNeg(msg.seamAllowanceMm, 'seamAllowanceMm');
  if (!seamChk.ok) return seamChk;
  const stitchChk = checkNonNeg(msg.stitchPitchMm, 'stitchPitchMm');
  if (!stitchChk.ok) return stitchChk;
  if (msg.kFactor !== undefined && msg.kFactor !== null
    && (typeof msg.kFactor !== 'number' || !Number.isFinite(msg.kFactor) || msg.kFactor < 0 || msg.kFactor > 1)) {
    return { ok: false, error: 'kFactor must be a finite number between 0 and 1.' };
  }
  const targetIds = Array.isArray(msg.targetIds)
    ? msg.targetIds.filter((x): x is string => typeof x === 'string').map(resolveId)
    : typeof msg.targetId === 'string'
      ? [resolveId(msg.targetId)]
      : undefined;
  try {
    const res = exportSheetUnfold(
      store.sceneGraph,
      msg as Partial<SheetUnfoldOptions>,
      targetIds,
    );
    if (!res.success) {
      return {
        ok: false,
        error: res.error || 'No unfoldable 3D faces found in the scene.',
        warnings: res.warnings,
      };
    }
    return {
      ok: true,
      mode: res.mode,
      totalFaces: res.totalFaces,
      foldCount: res.foldCount,
      seamCount: res.seamCount,
      glueTabCount: res.glueTabCount,
      stitchHoleCount: res.stitchHoleCount,
      sheetCount: res.sheets.length,
      islands: res.islands.map((isl) => ({
        id: isl.id,
        nodeId: isl.nodeId,
        nodeName: isl.nodeName,
        faceCount: isl.faceCount,
        boundsMm: isl.boundsMm,
      })),
      svg: res.svg,
      etchUrl: res.etchUrl,
      warnings: res.warnings,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const syncPcbEnclosureCommand: McpHandler = async (msg, { store }) => {
  if (msg.preset !== undefined && msg.preset !== null) {
    if (typeof msg.preset !== 'string' || !Object.hasOwn(PCB_PRESETS, msg.preset)) {
      return { ok: false, error: `Unknown PCB preset '${String(msg.preset)}'. Choose one of: ${Object.keys(PCB_PRESETS).join(', ')}.` };
    }
  }
  const wallChk = checkPos(msg.wallThicknessMm, 'wallThicknessMm');
  if (!wallChk.ok) return wallChk;
  const clearChk = checkNonNeg(msg.boardClearanceMm, 'boardClearanceMm');
  if (!clearChk.ok) return clearChk;
  const standoffChk = checkNonNeg(msg.standoffHeightMm, 'standoffHeightMm');
  if (!standoffChk.ok) return standoffChk;
  const topClearChk = checkNonNeg(msg.topClearanceMm, 'topClearanceMm');
  if (!topClearChk.ok) return topClearChk;
  const posChk = checkVec3(msg.pos, 'pos');
  if (!posChk.ok) return posChk;

  const presetKey = typeof msg.preset === 'string' ? msg.preset : undefined;
  let spec: PcbMechanicalSpec | null;
  try {
    if (presetKey && Object.hasOwn(PCB_PRESETS, presetKey)) {
      spec = PCB_PRESETS[presetKey];
    } else if (typeof msg.handoff === 'string') {
      spec = decodePcbHandoff(msg.handoff);
    } else if (msg.spec && typeof msg.spec === 'object') {
      spec = msg.spec as PcbMechanicalSpec;
    } else {
      spec = PCB_PRESETS.arduino_uno;
    }
    if (!spec) return { ok: false, error: 'Invalid PCB specification or handoff payload.' };

    if (msg.face !== undefined && msg.face !== null
      && msg.face !== 'top' && msg.face !== 'front' && msg.face !== 'back' && msg.face !== 'left' && msg.face !== 'right') {
      return { ok: false, error: "face is 'top', 'front', 'back', 'left' or 'right'." };
    }
    const face: PcbEnclosureFace =
      msg.face === 'front' || msg.face === 'back' || msg.face === 'left' || msg.face === 'right'
        ? msg.face
        : 'top';
    // Sized to the enclosure built from the same options, lid screws and all.
    const faceplate = exportPcbFaceplateSvg(spec, face, { enclosure: msg as Partial<PcbEnclosureOptions> });

    if (msg.pcbOnly === true) {
      const pcbNode = buildPcbNode(spec);
      const nextNodes = [...store.sceneGraph.nodes.filter((n) => n.id !== pcbNode.id), pcbNode];
      // Added to the scene: its notes, fidelity and pictures stay.
      const settled = await settleScene(nextNodes, { replacesScene: false });
      if (!settled.ok) return { ok: false, error: settled.error || 'Scene failed to compile after adding PCB.' };
      return {
        ok: true,
        pcbId: pcbNode.id,
        faceplateSvg: faceplate.svg,
        etchUrl: faceplate.etchUrl,
      };
    }

    const enc = generatePcbEnclosure(spec, msg as Partial<PcbEnclosureOptions>);
    const addedIds = new Set([enc.baseNode.id, enc.pcbNode.id, ...(enc.lidNode ? [enc.lidNode.id] : [])]);
    const nextNodes = [
      ...store.sceneGraph.nodes.filter((n) => !addedIds.has(n.id)),
      enc.baseNode,
      enc.pcbNode,
      ...(enc.lidNode ? [enc.lidNode] : []),
    ];
    const settled = await settleScene(nextNodes, { replacesScene: false });
    if (!settled.ok) return { ok: false, error: settled.error || 'Scene failed to compile after building PCB enclosure.' };
    return {
      ok: true,
      baseId: enc.baseNode.id,
      lidId: enc.lidNode?.id,
      pcbId: enc.pcbNode.id,
      cutouts: enc.cutouts,
      clearanceReport: enc.clearanceReport,
      faceplateSvg: faceplate.svg,
      etchUrl: faceplate.etchUrl,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const buildMechanismCommand: McpHandler = async (msg, { store, toId }) => {
  if (msg.arborId !== undefined && msg.arborId !== null && typeof msg.arborId !== 'string') {
    return { ok: false, error: 'arborId must be a string.' };
  }
  const originChk = checkVec3(msg.origin, 'origin');
  if (!originChk.ok) return originChk;
  const axisChk = checkVec3(msg.axis, 'axis');
  if (!axisChk.ok) return axisChk;
  const originM = Array.isArray(msg.origin)
    ? ([msg.origin[0] / 1000, msg.origin[1] / 1000, msg.origin[2] / 1000] as [number, number, number])
    : undefined;
  const resolvedMsg: MechanismRequest = {
    ...(msg as MechanismRequest),
    ...(originM ? { origin: originM } : {}),
    ...(typeof msg.arborId === 'string' ? { arborId: String(toId ? toId(msg.arborId) : msg.arborId) } : {}),
  };
  const prevNodes = store.sceneGraph.nodes ?? [];
  try {
    // Added to the scene as it is; see utils/buildMechanism.ts.
    const built = buildMechanism(resolvedMsg, prevNodes);
    if ('error' in built) return { ok: false, error: built.error };
    // Added to the scene: its notes, fidelity and pictures stay, as for any body
    // added (replacing the scene dropped them). And the reply comes once the
    // parts are built, not after their convex pieces: those follow in the
    // background (collisionPending), and waiting on them pushed a build past
    // send_command's ten seconds although it had worked.
    const settled = await settleScene(built.nodes, { replacesScene: false, waitForColliders: false });
    if (prevNodes.length === 0 && settled.ok) {
      const latestScene = useStore.getState().sceneGraph;
      const sceneForFraming = latestScene.nodes.length > 0 ? latestScene : { ...latestScene, nodes: built.nodes };
      const patch = framingPatch(sceneForFraming, null);
      if (patch.cameraOverride) useStore.setState(patch);
    }
    // Said, not done quietly: a 0.5 mm lead built as 1 mm runs twice as far.
    const metricWarnings = Array.isArray(built.metrics.warnings)
      ? built.metrics.warnings.filter((w): w is string => typeof w === 'string')
      : [];
    const warnings = [...adjustmentWarnings(built.family, built.adjusted), ...metricWarnings];
    return {
      ok: settled.ok,
      ...(settled.error ? { error: settled.error } : {}),
      family: built.family,
      addedIds: built.addedIds,
      ...(built.arborId ? { arborId: built.arborId } : {}),
      metrics: built.metrics,
      ...(built.adjusted.length ? { adjusted: built.adjusted } : {}),
      ...(warnings.length ? { warnings } : {}),
      ...(settled.collisionPending ? { collisionPending: settled.collisionPending, note: settled.note } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

const breakdownPipeFrameCommand: McpHandler = async (msg) => {
  if (msg.preset !== undefined && msg.preset !== null) {
    if (typeof msg.preset !== 'string' || !(PIPE_STRUCTURE_PRESETS as readonly string[]).includes(msg.preset)) {
      return { ok: false, error: `Unknown preset '${String(msg.preset)}'. Choose one of: ${PIPE_STRUCTURE_PRESETS.join(', ')}.` };
    }
  }
  if (msg.pipeStandardId !== undefined && msg.pipeStandardId !== null) {
    if (typeof msg.pipeStandardId !== 'string' || !Object.hasOwn(PIPE_STANDARDS, msg.pipeStandardId)) {
      return { ok: false, error: `Unknown pipeStandardId '${String(msg.pipeStandardId)}'. Choose one of: ${Object.keys(PIPE_STANDARDS).join(', ')}.` };
    }
  }
  const widthChk = checkPos(msg.widthMm, 'widthMm');
  if (!widthChk.ok) return widthChk;
  const depthChk = checkPos(msg.depthMm, 'depthMm');
  if (!depthChk.ok) return depthChk;
  const heightChk = checkPos(msg.heightMm, 'heightMm');
  if (!heightChk.ok) return heightChk;
  const stockLenChk = checkPos(msg.stockLengthMm, 'stockLengthMm');
  if (!stockLenChk.ok) return stockLenChk;
  const pitchChk = checkFiniteNum(msg.roofPitchDeg, 'roofPitchDeg');
  if (!pitchChk.ok) return pitchChk;

  try {
    if (typeof msg.preset === 'string') {
      const pipeStandardId: PipeStandardId =
        typeof msg.pipeStandardId === 'string' && Object.hasOwn(PIPE_STANDARDS, msg.pipeStandardId)
          ? (msg.pipeStandardId as PipeStandardId)
          : 'pvc_sch40_3_4';
      const presetNodes = generatePipeStructurePreset(msg.preset as PipeStructurePresetId, {
        pipeStandardId,
        widthMm: widthChk.value,
        depthMm: depthChk.value,
        heightMm: heightChk.value,
        roofPitchDeg: pitchChk.value,
      });
      const settled = await settleScene(presetNodes);
      if (!settled.ok) return { ok: false, error: settled.error || 'Scene failed to compile after loading pipe preset.' };
    }
    const bd = breakdownPipeFrame(useStore.getState().sceneGraph, msg as Partial<PipeFrameOptions>);
    let addedHubIds: string[] = [];
    const includeStandard = msg.includeStandardFittings === true || msg.addAllFittings === true;
    if (msg.addPrintableHubs === true || msg.addAllFittings === true) {
      const hubNodes = await buildHubsOffThread(bd, includeStandard);
      addedHubIds = hubNodes.map((h) => h.id);
      const nextNodes = [...withoutHubsAt(useStore.getState().sceneGraph.nodes, hubNodes), ...hubNodes];
      const settled = await settleScene(nextNodes, { replacesScene: false, waitForColliders: false });
      if (!settled.ok) return { ok: false, error: settled.error || 'Scene failed to compile after adding printable hubs.' };
    }
    return {
      ok: true,
      pipeSpec: bd.pipeSpec,
      strutCount: bd.struts.length,
      hubCount: bd.hubs.length,
      sticksRequired: bd.sticksRequired,
      totalPipeLengthMm: bd.totalPipeLengthMm,
      shoppingList: bd.shoppingList,
      sticks: bd.sticks,
      addedHubIds,
      warnings: bd.warnings,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
};

export const partBuildCommands: McpCommands = {
  TIMBER_BREAKDOWN: breakdownJoineryCommand,
  PHYSICS_TIMBER_BREAKDOWN: breakdownJoineryCommand,
  BREAKDOWN_JOINERY: breakdownJoineryCommand,
  EXPORT_SHEET_UNFOLD: exportSheetUnfoldCommand,
  PHYSICS_EXPORT_SHEET_UNFOLD: exportSheetUnfoldCommand,
  SYNC_PCB_ENCLOSURE: syncPcbEnclosureCommand,
  PHYSICS_SYNC_PCB_ENCLOSURE: syncPcbEnclosureCommand,
  BUILD_MECHANISM: buildMechanismCommand,
  PHYSICS_BUILD_MECHANISM: buildMechanismCommand,
  BREAKDOWN_PIPE_FRAME: breakdownPipeFrameCommand,
  PHYSICS_BREAKDOWN_PIPE_FRAME: breakdownPipeFrameCommand,
  BUILD_PIPE_FRAME: async (msg, { store, toId }) => {
    // A lattice sketch or any solid, framed in pipe and stood up.
    // A body, or the whole scene when none is given.
    if (msg.bodyId !== undefined && msg.bodyId !== null && typeof msg.bodyId !== 'string') {
      return { ok: false, error: 'bodyId must be a string.' };
    }
    const rawBodyId = typeof msg.bodyId === 'string' ? msg.bodyId : WHOLE_SCENE;
    const body = rawBodyId === WHOLE_SCENE
      ? { id: WHOLE_SCENE, name: 'the scene' }
      : findNodeInScene(store.sceneGraph.nodes, (toId ? toId(rawBodyId) : rawBodyId) as string);
    if (!body) return { ok: false, error: `No body '${rawBodyId}'.` };
    if (msg.pipeStandardId !== undefined && msg.pipeStandardId !== null) {
      if (typeof msg.pipeStandardId !== 'string' || !Object.hasOwn(PIPE_STANDARDS, msg.pipeStandardId)) {
        return { ok: false, error: `Unknown pipeStandardId '${String(msg.pipeStandardId)}'. Choose one of: ${Object.keys(PIPE_STANDARDS).join(', ')}.` };
      }
    }
    const maxSpanChk = checkPos(msg.maxSpanMm, 'maxSpanMm');
    if (!maxSpanChk.ok) return maxSpanChk;
    if (msg.placement !== undefined && msg.placement !== null && msg.placement !== 'replace' && msg.placement !== 'beside') {
      return { ok: false, error: "placement is 'replace' or 'beside'." };
    }
    if (msg.style !== undefined && msg.style !== null && msg.style !== 'auto' && msg.style !== 'edges' && msg.style !== 'centrelines') {
      return { ok: false, error: "style is 'auto', 'edges' or 'centrelines'." };
    }
    const pipeStandardId = (typeof msg.pipeStandardId === 'string' && Object.hasOwn(PIPE_STANDARDS, msg.pipeStandardId)
      ? msg.pipeStandardId : 'pvc_sch40_3_4') as PipeStandardId;
    try {
      const { nodes, skeleton, added } = await frameBodyOffThread(store.sceneGraph, body.id, {
        maxSpanMm: maxSpanChk.value,
        diagonals: msg.diagonals === true,
        posts: msg.posts !== false,
        placement: msg.placement === 'beside' ? 'beside' : 'replace',
        style: msg.style === 'edges' || msg.style === 'centrelines' ? msg.style : 'auto',
        pipeStandardId,
      });
      useStore.getState().prepareForDiscreteChange();
      // Adds to the scene: its note card and settings stay.
      const settled = await settleScene(nodes, { replacesScene: false, waitForColliders: false });
      if (!settled.ok) return { ok: false, error: settled.error || 'Scene failed to compile after building pipe frame.' };
      const kinds: Record<string, number> = {};
      for (const m of skeleton.members) kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
      const bd = breakdownPipeFrame(useStore.getState().sceneGraph, {
        pipeStandardId: skeleton.pipeStandardId,
        stockLengthMm: PIPE_STANDARDS[skeleton.pipeStandardId].stockLengthMm,
      });
      return {
        ok: true,
        source: skeleton.source,
        style: skeleton.style,
        pipe: skeleton.pipeStandardId,
        ...(skeleton.resizedFrom ? { note: `${PIPE_STANDARDS[skeleton.resizedFrom].label} is too big for ${body.name}: framed in ${PIPE_STANDARDS[skeleton.pipeStandardId].label}.` } : {}),
        maxSpanMm: skeleton.maxSpanMm,
        pipes: skeleton.members.length,
        joints: skeleton.nodes.length,
        byKind: kinds,
        bodiesAdded: added,
        sticksRequired: bd.sticksRequired,
        totalPipeLengthMm: bd.totalPipeLengthMm,
        shoppingList: bd.shoppingList,
        warnings: bd.warnings,
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
