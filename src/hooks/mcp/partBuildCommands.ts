// ---------------------------------------------------------------------------
// MCP commands that generate parts from a scene: timber breakdown,
// sheet unfold, PCB enclosure, mechanisms, pipe frames
// ---------------------------------------------------------------------------

import { useStore } from '../../store/useStore';
import { loadManifold } from '../../utils/sculptCut';
import {
  collectIndividualPartSoups, decomposeSolidIntoPlanks, resolveTimberTargetIds, type PlankJointType,
} from '../../utils/timberBreakdown';
import {
  synthesizeTimberJoinery, type TenonCornerFit, type TimberEdgeProfile, type TimberJointMode,
} from '../../utils/timberJoinery';
import { buildTimberCutPlan } from '../../utils/timberCutList';
import { exportSheetUnfold, type SheetUnfoldOptions } from '../../utils/sheetUnfoldExporter';
import {
  PCB_PRESETS, buildPcbNode, decodePcbHandoff, exportPcbFaceplateSvg, generatePcbEnclosure,
  type PcbEnclosureFace, type PcbEnclosureOptions, type PcbMechanicalSpec,
} from '../../utils/pcbEnclosureSync';
import { buildMechanism, type MechanismRequest } from '../../utils/buildMechanism';
import {
  PIPE_STANDARDS, breakdownPipeFrame, buildAllCustomHubNodes, withoutHubsAt,
  generatePipeStructurePreset, type PipeFrameOptions, type PipeStandardId,
  type PipeStructurePresetId,
} from '../../utils/tubeAndWireExporter';
import { frameBodyInScene, WHOLE_SCENE } from '../../utils/pipeSkeleton';
import { findNodeInScene } from './bridgeUtils';
import { settleScene } from './settleScene';
import type { McpCommands, McpHandler } from './types';

  /*
   * Timber & Joinery Breakdown (`physics_timber_breakdown` / `BREAKDOWN_JOINERY`):
   * Decompose either:
   *   (a) Large architectural/enclosure/cabinet solids into machinable timber
   *       planks with interlocking rabbet, miter, finger, or butt joints,
   *       alignment dowels, hollow interior option, and lay-flat sheet packing; OR
   *   (b) Framed furniture (table, chair, flower stand) into mortise-and-tenon
   *       legs & rails, stopped edge roundovers, 1D stock bars, and CNC windows.
   */
const breakdownJoineryCommand: McpHandler = async (msg, { store }) => {
  const explicitBodyId =
    typeof msg.bodyId === 'string'
      ? msg.bodyId
      : typeof msg.body_id === 'string'
        ? msg.body_id
        : null;
  const rawWithIds = Array.isArray(msg.withIds)
    ? msg.withIds
    : Array.isArray(msg.with_ids)
      ? msg.with_ids
      : [];
  const others = rawWithIds.filter((v): v is string => typeof v === 'string');
  const targetIds = explicitBodyId
    ? [explicitBodyId, ...others]
    : resolveTimberTargetIds(store.sceneGraph.nodes, store.selectedNodeId, others);
  if (!targetIds.length) return { ok: false, error: 'Give bodyId, or add a body to the scene first.' };
  const primary = findNodeInScene(store.sceneGraph.nodes, targetIds[0]);
  if (!primary) return { ok: false, error: `No body called ${targetIds[0]}.` };

  const { items, absorbed } = collectIndividualPartSoups(store.sceneGraph, targetIds);
  if (!items.length) return { ok: false, error: `${primary.name} has no solid geometry to break down.` };

  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
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

  const wasm = await loadManifold();
  const soups = items.map((it) => it.soup);

  if (hasPlankSpecificArg && msg.mode !== 'frame') {
    const jointType: PlankJointType =
      rawJointType === 'miter' || rawJointType === 'finger' || rawJointType === 'butt' || rawJointType === 'glue'
        ? rawJointType
        : 'rabbet';
    const plankRes = decomposeSolidIntoPlanks(wasm, soups, {
      boardThicknessMm: num(msg.boardThicknessMm ?? msg.board_thickness_mm),
      wallThicknessMm: num(msg.wallThicknessMm ?? msg.wall_thickness_mm),
      maxBoardWidthMm: num(msg.maxBoardWidthMm ?? msg.max_board_width_mm),
      maxBoardLengthMm: num(msg.maxBoardLengthMm ?? msg.max_board_length_mm),
      jointType,
      fingerWidthMm: num(msg.fingerWidthMm ?? msg.finger_width_mm),
      dowelDiaMm: num(msg.dowelDiaMm ?? msg.dowel_dia_mm),
      dowelLengthMm: num(msg.dowelLengthMm ?? msg.dowel_length_mm),
      clearanceMm: num(msg.clearanceMm ?? msg.clearance_mm),
      hollowInterior:
        typeof msg.hollowInterior === 'boolean'
          ? msg.hollowInterior
          : typeof msg.hollow_interior === 'boolean'
            ? msg.hollow_interior
            : undefined,
    });
    if (!plankRes.ok) return plankRes;

    const names = plankRes.planks.map((p) => p.id);
    const ids =
      msg.apply === true
        ? store.splitBodyForPrint(primary.id, plankRes.sections, absorbed, {
            plain: false,
            names,
            centerOrigin: true,
            placement,
          })
        : null;

    return {
      ok: true,
      mode: 'planks',
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

  const jointMode: TimberJointMode =
    msg.jointMode === 'dowel' || msg.jointMode === 'dado' || msg.jointMode === 'butt'
      ? msg.jointMode
      : msg.jointMode === 'glue'
        ? 'butt'
        : 'mortise_tenon';
  const tenonCornerFit: TenonCornerFit =
    msg.tenonCornerFit === 'round_tenon' || msg.tenonCornerFit === 'chisel_square' ? msg.tenonCornerFit : 'dogbone';
  const edgeProfile: TimberEdgeProfile =
    msg.edgeProfile === 'chamfer' || msg.edgeProfile === 'square' ? msg.edgeProfile : 'roundover';

  const outcome = synthesizeTimberJoinery(
    wasm,
    soups,
    {
      jointMode,
      tenonCornerFit,
      edgeProfile,
      cutterDiaMm: num(msg.cutterDiaMm),
      shoulderMm: num(msg.shoulderMm),
      tenonLengthMm: num(msg.tenonLengthMm),
      clearanceMm: num(msg.clearanceMm),
      edgeRadiusMm: num(msg.edgeRadiusMm),
      stopMarginMm: num(msg.stopMarginMm),
      maxBoardWidthMm: num(msg.maxBoardWidthMm),
      tabletopClips: typeof msg.tabletopClips === 'boolean' ? msg.tabletopClips : undefined,
      tenonCutMethod: msg.tenonCutMethod === 'cnc' ? 'cnc' : 'bandsaw',
    },
  );
  if (!outcome.ok) return outcome;

  // If auto-mode was called on a single unframed solid block (1 part, 0 joints)
  // and msg.mode !== 'frame', fall back to hollow-shell / plank breakdown!
  if (msg.mode !== 'frame' && outcome.parts.length <= 1 && outcome.joints.length === 0 && msg.jointMode === undefined) {
    const plankRes = decomposeSolidIntoPlanks(wasm, soups, {
      maxBoardWidthMm: num(msg.maxBoardWidthMm ?? msg.max_board_width_mm),
      clearanceMm: num(msg.clearanceMm ?? msg.clearance_mm),
    });
    if (plankRes.ok && plankRes.planks.length > 1) {
      const names = plankRes.planks.map((p) => p.id);
      const ids =
        msg.apply === true
          ? store.splitBodyForPrint(primary.id, plankRes.sections, absorbed, {
              plain: false,
              names,
              centerOrigin: true,
              placement,
            })
          : null;
      return {
        ok: true,
        mode: 'planks',
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

  const bedArr = Array.isArray(msg.cncBedMm) ? (msg.cncBedMm as number[]) : null;
  const cncBedMm: [number, number, number] =
    bedArr && bedArr.length === 3 && bedArr.every((v) => typeof v === 'number' && v > 0)
      ? [bedArr[0], bedArr[1], bedArr[2]]
      : [store.cncBed.widthMm, store.cncBed.depthMm, store.cncBed.heightMm];

  const cutPlan = buildTimberCutPlan(outcome, {
    cncBedMm,
    defaultStockLengthMm: num(msg.stockLengthMm) ?? 1800,
  });

  const names = outcome.parts.map((p) => p.member.id);
  const ids =
    msg.apply === true
      ? store.splitBodyForPrint(primary.id, outcome.sections, absorbed, {
          plain: false,
          names,
          centerOrigin: true,
          placement,
        })
      : null;

  return {
    ok: true,
    mode: 'frame',
    applied: !!ids,
    placement: ids ? placement : undefined,
    parts: outcome.parts.map((p, idx) => ({
      index: idx,
      id: p.member.id,
      ...(ids ? { sceneNodeId: ids[idx] } : {}),
      title: p.member.title,
      role: p.member.role,
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
    buildGuideMarkdown: cutPlan.buildGuideMarkdown,
    warnings: outcome.warnings,
  };
};

const exportSheetUnfoldCommand: McpHandler = async (msg, { store }) => {
  const targetIds = Array.isArray(msg.targetIds)
    ? msg.targetIds.filter((x): x is string => typeof x === 'string')
    : typeof msg.targetId === 'string'
      ? [msg.targetId]
      : undefined;
  const res = exportSheetUnfold(
    store.sceneGraph,
    msg as Partial<SheetUnfoldOptions>,
    targetIds,
  );
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
};

const syncPcbEnclosureCommand: McpHandler = async (msg, { store }) => {
  const presetKey = typeof msg.preset === 'string' ? msg.preset : undefined;
  let spec: PcbMechanicalSpec | null;
  if (presetKey && presetKey in PCB_PRESETS) {
    spec = PCB_PRESETS[presetKey];
  } else if (typeof msg.handoff === 'string') {
    spec = decodePcbHandoff(msg.handoff);
  } else if (msg.spec && typeof msg.spec === 'object') {
    spec = msg.spec as PcbMechanicalSpec;
  } else {
    spec = PCB_PRESETS.arduino_uno;
  }
  if (!spec) return { ok: false, error: 'Invalid PCB specification or handoff payload.' };

  const face: PcbEnclosureFace =
    msg.face === 'front' || msg.face === 'back' || msg.face === 'left' || msg.face === 'right'
      ? msg.face
      : 'top';
  const faceplate = exportPcbFaceplateSvg(spec, face);

  if (msg.pcbOnly === true) {
    const pcbNode = buildPcbNode(spec);
    const nextNodes = [...store.sceneGraph.nodes.filter((n) => n.id !== pcbNode.id), pcbNode];
    await settleScene(nextNodes);
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
  await settleScene(nextNodes);
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
};

const buildMechanismCommand: McpHandler = async (msg, { store }) => {
  // Added to the scene as it is; see utils/buildMechanism.ts.
  const built = buildMechanism(msg as MechanismRequest, store.sceneGraph.nodes);
  if ('error' in built) return { ok: false, error: built.error };
  await settleScene(built.nodes);
  return {
    ok: true,
    family: built.family,
    addedIds: built.addedIds,
    ...(built.arborId ? { arborId: built.arborId } : {}),
    metrics: built.metrics,
  };
};

const breakdownPipeFrameCommand: McpHandler = async (msg) => {
  if (typeof msg.preset === 'string') {
    const presetNodes = generatePipeStructurePreset(msg.preset as PipeStructurePresetId, {
      pipeStandardId: (typeof msg.pipeStandardId === 'string' && msg.pipeStandardId in PIPE_STANDARDS
        ? msg.pipeStandardId
        : 'pvc_sch40_3_4') as PipeStandardId,
      widthMm: typeof msg.widthMm === 'number' ? msg.widthMm : undefined,
      depthMm: typeof msg.depthMm === 'number' ? msg.depthMm : undefined,
      heightMm: typeof msg.heightMm === 'number' ? msg.heightMm : undefined,
      roofPitchDeg: typeof msg.roofPitchDeg === 'number' ? msg.roofPitchDeg : undefined,
    });
    await settleScene(presetNodes);
  }
  const bd = breakdownPipeFrame(useStore.getState().sceneGraph, msg as Partial<PipeFrameOptions>);
  let addedHubIds: string[] = [];
  if (msg.addPrintableHubs === true) {
    const hubNodes = buildAllCustomHubNodes(bd);
    addedHubIds = hubNodes.map((h) => h.id);
    const nextNodes = [...withoutHubsAt(useStore.getState().sceneGraph.nodes, hubNodes), ...hubNodes];
    await settleScene(nextNodes, { replacesScene: false });
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
  BUILD_PIPE_FRAME: async (msg, { store }) => {
    // A lattice sketch or any solid, framed in pipe and stood up.
    // A body, or the whole scene when none is given.
    const bodyId = typeof msg.bodyId === 'string' ? msg.bodyId : WHOLE_SCENE;
    const body = bodyId === WHOLE_SCENE ? { id: WHOLE_SCENE, name: 'the scene' } : findNodeInScene(store.sceneGraph.nodes, bodyId);
    if (!body) return { ok: false, error: `No body '${bodyId}'.` };
    const pipeStandardId = (typeof msg.pipeStandardId === 'string' && msg.pipeStandardId in PIPE_STANDARDS
      ? msg.pipeStandardId : 'pvc_sch40_3_4') as PipeStandardId;
    const { nodes, skeleton, added } = frameBodyInScene(store.sceneGraph, body.id, {
      maxSpanMm: typeof msg.maxSpanMm === 'number' ? msg.maxSpanMm : undefined,
      diagonals: msg.diagonals === true,
      posts: msg.posts !== false,
      placement: msg.placement === 'beside' ? 'beside' : 'replace',
      style: msg.style === 'edges' || msg.style === 'centrelines' ? msg.style : 'auto',
      pipeStandardId,
      wasm: await loadManifold(),
    });
    store.prepareForDiscreteChange();
    // Adds to the scene: its note card and settings stay.
    await settleScene(nodes, { replacesScene: false });
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
  },
};
