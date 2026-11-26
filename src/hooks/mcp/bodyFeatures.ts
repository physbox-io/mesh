// ---------------------------------------------------------------------------
// Features an agent declares on a body (cuts, pockets, rounded edges,
// patterns, paint), applied once the body is in the scene
// ---------------------------------------------------------------------------

import { hexToRgb, rgbToHex } from '../../utils/hexColor';
import { pocketMesh, type PocketSpec } from '../../utils/pocketCutter';
import { useStore } from '../../store/useStore';
import { compileCsgNodes } from '../useCsgCompile';
import { bodyEdges, bodyUp, whyNotRoundable } from '../../utils/edgeRoundBase';
import { planClampedRoundings } from '../../utils/edgeRound';
import { selectEdges, type EdgeGroup } from '../../utils/featureEdges';
import {
  applyDab, buildMeshPaintGeometry, buildPaintGeometry, canvasFromLayer, isPaintable,
  layerFromCanvas, paintArgsFromSize, paintMeshResolution, paintResolution, toGeometrySpace,
  DEFAULT_PAINT_HARDNESS,
} from '../../utils/vertexPaint';
import { toSceneGeom } from '../../utils/sculptMesh';
import { cutSculptOffThread } from '../../utils/sculptCutClient';
import { patternPickAt } from '../../utils/facePatternPick';
import { SURFACE_PATTERNS, patternById } from '../../utils/surfacePatterns';
import {
  DEFAULT_TEXTURE_BORDER_M, DEFAULT_TEXTURE_CELL_M, type SurfaceTexture, type TextureProjection,
} from '../../utils/surfaceTexture';
import { geomHalfLen } from '../../utils/geomSurface';
import { requestTexturedSurface } from '../../utils/textureClient';
import { Quaternion, Vector3 } from 'three';
import type { SceneGraph, SceneNode, SceneGeom, HardwareBore, HardwareCutKind, SealType } from '../../types/scene';
import {
  CLEARANCE_HOLES, COUNTERSINK_INFO, HARDWARE_KINDS, countersinkCutGeoms, hardwareCutProblem,
  hardwareSpecOf, quarterDirection, quarterFacing,
} from '../../utils/hardwareCuts';
import { metricThread } from '../../utils/metricThreads';
import { SNAP_SIZES, snapBeamLength, snapLipHeight } from '../../utils/snapFits';
import { sealFindings } from '../../utils/hardwareChecks';
import { isFiniteNumber, isFiniteVec3, isPlainObject, pointList, findNodeInScene } from './bridgeUtils';
import { sculptMeshOf } from './sculptState';
import { normalizeRgba, pendingDeclarativeOps, type PendingDeclarativeOps } from './bodyDefaults';

/**
 * The piece of a part that a body is fixed to, to move with it: a carriage
 * (rail, rod, runner, spring) first, else whatever else moves — a bearing's
 * inner race, a stepper's shaft.
 */
export function movingPieceOf(part: SceneNode): SceneNode | null {
  const pieces: SceneNode[] = [];
  const walk = (n: SceneNode) => { for (const c of n.children || []) if (c.hardwarePart?.piece) { pieces.push(c); walk(c); } };
  walk(part);
  return pieces.find((p) => p.hardwarePart!.piece === 'carriage') ?? pieces[0] ?? null;
}

/** Whether one O-ring groove seals against what is placed round it, as the DFM check says. */
export function sealCheckFor(scene: SceneGraph, nodeId: string, group: string) {
  const f = sealFindings(scene, 'print').find((x) => x.id === `seal_${nodeId}_${group}`);
  return f ? { seals: !!f.passed, title: f.title, detail: f.detail, fix: f.fix } : null;
}

const PRIMITIVE_CUT_SHAPES = new Set(['hole', 'cylinder', 'slot', 'box', 'dish', 'sphere']);
const SEAL_TYPES = new Set<SealType>(['face', 'bore', 'piston']);
const POCKET_OUTLINES = new Set(['rect', 'ellipse', 'circle']);
const POCKET_FLOORS = new Set(['flat', 'bowl']);
const ROUND_MODES = new Set(['round', 'fillet', 'bevel', 'chamfer']);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applySingleCutToBody(targetId: string, spec: Record<string, any>): Record<string, any> {
  if (!isPlainObject(spec)) return { ok: false, error: 'Cut specification must be a plain object' };
  const store = useStore.getState();
  const { shape, at, normal, frame, diameterMm, widthMm, lengthMm, depthMm, threadPitchMm, threadLeft, threadFitMm, size, bore, fitMm, seal, turned, facing } = spec;
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) return { ok: false, error: `No object with id '${targetId}'` };
  if (frame !== undefined && frame !== 'body' && frame !== 'cage') {
    return { ok: false, error: "frame must be 'body' or 'cage'" };
  }
  if (frame === 'cage' && !node.isLattice) {
    return { ok: false, error: `frame 'cage' is only valid on lattice bodies ('${targetId}' is not a lattice body)` };
  }
  if (at !== undefined && !isFiniteVec3(at)) {
    return { ok: false, error: 'at must be [x, y, z] of finite numbers in millimetres' };
  }
  if (normal !== undefined) {
    if (!isFiniteVec3(normal)) return { ok: false, error: 'normal must be [x, y, z] of finite numbers' };
    if (Math.hypot(normal[0], normal[1], normal[2]) < 1e-9) return { ok: false, error: 'normal must not be [0, 0, 0]' };
  }
  const cageOrigin = frame === 'cage' ? (node.latticeOrigin ?? [0, 0, 0]) : [0, 0, 0];
  const spotIn = at !== undefined
    ? {
      at: [at[0] / 1000 - cageOrigin[0], at[1] / 1000 - cageOrigin[1], at[2] / 1000 - cageOrigin[2]],
      normal: normal !== undefined ? [...normal] : [0, 0, 1],
    }
    : undefined;

  if (shape !== undefined && typeof shape !== 'string') {
    return { ok: false, error: 'shape must be a string' };
  }

  if (typeof shape === 'string' && Object.hasOwn(HARDWARE_KINDS, shape)) {
    const hwKind = shape as HardwareCutKind;
    const info = HARDWARE_KINDS[hwKind];
    if (size !== undefined && !info.sizes.includes(String(size))) {
      return { ok: false, error: `${info.label} comes in ${info.sizes.join(', ')}; got '${size}'` };
    }
    if (bore !== undefined) {
      if (!info.bores) {
        return { ok: false, error: `${info.label} does not accept a bore option` };
      }
      if (typeof bore !== 'string' || !info.bores.includes(bore as HardwareBore)) {
        return { ok: false, error: `bore for ${info.label} must be one of ${info.bores.join(', ')}; got '${String(bore)}'` };
      }
    }
    if (fitMm !== undefined && !isFiniteNumber(fitMm)) {
      return { ok: false, error: 'fitMm must be a finite number' };
    }
    if (seal !== undefined && (typeof seal !== 'string' || !SEAL_TYPES.has(seal as SealType))) {
      return { ok: false, error: "seal must be 'face', 'bore', or 'piston'" };
    }
    if (hwKind === 'rail_seat' && lengthMm !== undefined && (!isFiniteNumber(lengthMm) || lengthMm <= 0)) {
      return { ok: false, error: 'lengthMm must be a positive finite number' };
    }
    if (spec.quarter !== undefined && spec.quarter !== null && !isFiniteNumber(spec.quarter)) {
      return { ok: false, error: 'quarter must be a finite number' };
    }
    if (facing !== undefined) {
      if (!isFiniteVec3(facing)) return { ok: false, error: 'facing must be [x, y, z] of finite numbers' };
      if (Math.hypot(facing[0], facing[1], facing[2]) < 1e-9) return { ok: false, error: 'facing must not be [0, 0, 0]' };
    }
    const quarterIn = spec.quarter === undefined || spec.quarter === null ? undefined : Number(spec.quarter);
    const group = store.addHardwareCut(targetId, hwKind, spotIn);
    if (!group) return { ok: false, error: store.hardwareCutProblemAt(targetId, hwKind, spotIn) ?? 'That body has no solid shape to cut into' };
    const railSeat = hwKind === 'rail_seat' && (typeof lengthMm === 'number' || typeof turned === 'boolean');
    const turns = hwKind === 'nut_slot' || hwKind === 'snap_hook' || hwKind === 'snap_catch';
    // `facing`, a direction in the body's frame, is the easy way to say it: the nearest quarter on this face.
    const placed = turns ? findNodeInScene(useStore.getState().sceneGraph.nodes, targetId) : null;
    const faceNormal = (placed && hardwareSpecOf(placed.geoms ?? [], group)?.normal) ?? spotIn?.normal ?? [0, 0, 1];
    const quarter = turns && isFiniteVec3(facing)
      ? quarterFacing(faceNormal, facing.map(Number))
      : quarterIn;
    const turnable = turns && typeof quarter === 'number' && Number.isFinite(quarter);
    const removeAddedHardwareCut = () => {
      const cur = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
      const index = (cur?.geoms ?? []).findIndex((g) => g.hardware?.group === group && !g.csgDerived);
      if (index >= 0) useStore.getState().deleteNodeGeom(targetId, index);
    };
    if (size !== undefined || bore !== undefined || fitMm !== undefined || seal !== undefined || railSeat || turnable) {
      const current = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
      const before = current && hardwareSpecOf(current.geoms ?? [], group);
      const changes = {
        ...(size !== undefined ? { size: String(size) } : {}),
        ...(bore !== undefined ? { bore: bore as HardwareBore } : {}),
        ...(typeof fitMm === 'number' ? { fitMm } : {}),
        ...(seal !== undefined ? { seal: seal as SealType } : {}),
        // A rail seat's own length and direction.
        ...(hwKind === 'rail_seat' && typeof lengthMm === 'number' ? { lengthMm } : {}),
        ...(hwKind === 'rail_seat' && typeof turned === 'boolean' ? { turned } : {}),
        // Which way a nut slot runs out, or a snap hook's lip faces: quarter turns about the normal.
        ...(turnable ? { quarter: ((Math.round(quarter as number) % 4) + 4) % 4 } : {}),
      };
      // A groove a size cannot fit is not changed: say why rather than hand back the wrong one.
      const why = current && before && hardwareCutProblem({ ...before, ...changes }, current);
      if (why) {
        // Nothing half-made is left behind: the groove added at its own size goes too.
        removeAddedHardwareCut();
        return { ok: false, error: why };
      }
      useStore.getState().setHardwareCut(targetId, group, changes);
    }
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
    const hwSpec = hardwareSpecOf(after?.geoms ?? [], group);
    if (size !== undefined && hwSpec && hwSpec.size !== String(size)) {
      removeAddedHardwareCut();
      return { ok: false, error: `${info.label} comes in ${info.sizes.join(', ')}; got '${size}'` };
    }
    return {
      ok: true, id: targetId, group, shape: hwKind, size: hwSpec?.size,
      ...(hwSpec?.bore ? { bore: hwSpec.bore } : {}),
      fitMm: hwSpec?.fitMm ?? 0,
      atMm: (hwSpec?.at ?? []).map((v: number) => Math.round(v * 1000 * 1000) / 1000),
      normal: hwSpec?.normal,
      pieces: (after?.geoms ?? []).filter((g) => g.hardware?.group === group).map((g) => g.hardware!.part),
      ...(hwSpec?.seal ? { seal: hwSpec.seal } : {}),
      ...(hwSpec?.quarter !== undefined ? { quarter: hwSpec.quarter, direction: quarterDirection(hwSpec.normal, hwSpec.quarter) } : {}),
      ...((hwKind === 'snap_hook' || hwKind === 'snap_catch') && hwSpec && SNAP_SIZES[hwSpec.size] ? (() => {
        const s = SNAP_SIZES[hwSpec.size];
        const beam = snapBeamLength(s), lip = snapLipHeight(s);
        return {
          beamLengthMm: +beam.toFixed(2), lipHeightMm: +lip.toFixed(2), lipDepthMm: s.depth, widthMm: s.width,
          note: hwKind === 'snap_hook'
            ? `The lip faces \`direction\`. The beam's outer face is on \`atMm\`: put it on the line of the wall's inside face. Centre the catch window ${(beam + lip / 2).toFixed(1)} mm from this face, in the wall the lip faces.`
            : `\`direction\` should be the way the hook's beam runs past it, up or down the wall: the window is the lip's height along it and its width across, plus fitMm, through this wall only.`,
        };
      })() : {}),
      ...(hwKind === 'oring' || hwKind === 'seal_cord' ? { sealCheck: sealCheckFor(useStore.getState().sceneGraph, targetId, group) } : {}),
    };
  }

  if (shape === 'countersink') return applyCountersinkCut(targetId, spec, spotIn);
  if (shape === 'pocket') return applyPocketCut(targetId, spec, spotIn);

  if (shape !== undefined && !PRIMITIVE_CUT_SHAPES.has(shape)) {
    const valid = [...PRIMITIVE_CUT_SHAPES, 'pocket', 'countersink', ...Object.keys(HARDWARE_KINDS)].join(', ');
    return { ok: false, error: `Unknown cut shape '${shape}'. Valid shapes: ${valid}` };
  }

  if (widthMm !== undefined && (!isFiniteNumber(widthMm) || widthMm <= 0)) {
    return { ok: false, error: 'widthMm must be a positive finite number' };
  }
  if (lengthMm !== undefined && (!isFiniteNumber(lengthMm) || lengthMm <= 0)) {
    return { ok: false, error: 'lengthMm must be a positive finite number' };
  }
  if (diameterMm !== undefined && (!isFiniteNumber(diameterMm) || diameterMm <= 0)) {
    return { ok: false, error: 'diameterMm must be a positive finite number' };
  }
  if (depthMm !== undefined && (!isFiniteNumber(depthMm) || depthMm < 0)) {
    return { ok: false, error: 'depthMm must be a non-negative finite number (0 for through-cut)' };
  }
  if (threadPitchMm !== undefined && (!isFiniteNumber(threadPitchMm) || threadPitchMm <= 0)) {
    return { ok: false, error: 'threadPitchMm must be a positive finite number' };
  }
  if (threadFitMm !== undefined && !isFiniteNumber(threadFitMm)) {
    return { ok: false, error: 'threadFitMm must be a finite number' };
  }

  const kind = shape === 'slot' || shape === 'box' ? 'box'
    : shape === 'dish' || shape === 'sphere' ? 'sphere' : 'cylinder';
  const index = store.addBodyCut(targetId, kind, spotIn);
  if (index < 0) return { ok: false, error: 'That body has no solid shape to cut into' };

  if (kind === 'box') {
    const wide = typeof widthMm === 'number' ? widthMm / 2000 : undefined;
    const long = typeof lengthMm === 'number' ? lengthMm / 2000 : undefined;
    if (wide !== undefined || long !== undefined) {
      const now = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId)?.geoms?.[index];
      useStore.getState().setCutSection(targetId, index, [
        wide ?? now?.size?.[0] ?? 0.005,
        long ?? now?.size?.[1] ?? 0.005,
      ]);
    }
  } else if (typeof diameterMm === 'number') {
    useStore.getState().setCutSection(targetId, index, [diameterMm / 2000]);
  }
  if (typeof depthMm === 'number') useStore.getState().setCutDepth(targetId, index, depthMm);
  if (typeof threadPitchMm === 'number' && kind === 'cylinder') {
    useStore.getState().setGeomThread(targetId, index, {
      pitchMm: threadPitchMm,
      left: threadLeft === true,
      fitMm: typeof threadFitMm === 'number' ? threadFitMm : 0,
    });
  }

  const cut = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId)?.geoms?.[index];
  return {
    ok: true,
    id: targetId,
    geomIndex: index,
    name: cut?.name,
    shape: kind,
    atMm: (cut?.cutAt ?? []).map((v: number) => Math.round(v * 1000 * 1000) / 1000),
    normal: cut?.cutNormal,
    ...(cut?.thread?.pitch ? {
      threadPitchMm: Math.round(cut.thread.pitch * 1000 * 1000) / 1000,
      ...(cut.thread.left ? { threadLeft: true } : {}),
      ...(cut.thread.fit ? { threadFitMm: Math.round(cut.thread.fit * 1000 * 1000) / 1000 } : {}),
    } : {}),
    depthMm: cut?.cutDepth ? Math.round(cut.cutDepth * 1000 * 1000) / 1000 : 0,
    through: !(cut?.cutDepth && cut.cutDepth > 0),
  };
}

/**
 * A conical countersink (ISO 90° metric by default, or 82° for US flat-head
 * screws) paired with a clearance or tapped through-hole below it. Placed on
 * the surface the same way every cut is, then baked into the body frame as a
 * closed manifold cone mesh alongside the shank cylinder.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyCountersinkCut(targetId: string, spec: Record<string, any>, spotIn?: { at: number[]; normal: number[] }): Record<string, any> {
  const { size, bore, fitMm, angleDeg } = spec;
  if (size !== undefined && !COUNTERSINK_INFO.sizes.includes(String(size))) {
    return { ok: false, error: `${COUNTERSINK_INFO.label} comes in ${COUNTERSINK_INFO.sizes.join(', ')}; got '${size}'` };
  }
  if (bore !== undefined && (typeof bore !== 'string' || !COUNTERSINK_INFO.bores!.includes(bore as HardwareBore))) {
    return { ok: false, error: `bore for ${COUNTERSINK_INFO.label} must be one of ${COUNTERSINK_INFO.bores!.join(', ')}; got '${String(bore)}'` };
  }
  if (fitMm !== undefined && (!isFiniteNumber(fitMm) || fitMm < 0)) {
    return { ok: false, error: 'fitMm must be a non-negative finite number' };
  }
  if (angleDeg !== undefined && (!isFiniteNumber(angleDeg) || angleDeg < 30 || angleDeg > 150)) {
    return { ok: false, error: 'angleDeg must be a finite number between 30 and 150 degrees' };
  }

  const resolvedSize = size !== undefined ? String(size) : COUNTERSINK_INFO.defaultSize;
  const resolvedBore: HardwareBore = (bore as HardwareBore | undefined) ?? 'clearance';
  const resolvedFit = typeof fitMm === 'number' ? fitMm : 0;
  const resolvedAngle = typeof angleDeg === 'number' ? angleDeg : 90;

  const store = useStore.getState();
  const shankIndex = store.addBodyCut(targetId, 'cylinder', spotIn);
  if (shankIndex < 0) return { ok: false, error: 'That body has no solid shape to cut into' };

  const threadInfo = resolvedBore === 'tapped' ? metricThread(resolvedSize) : undefined;
  const shankDiaMm = threadInfo ? threadInfo[1] : CLEARANCE_HOLES[resolvedSize];
  useStore.getState().setCutSection(targetId, shankIndex, [shankDiaMm / 2000]);
  useStore.getState().setCutDepth(targetId, shankIndex, 0);
  if (threadInfo) {
    useStore.getState().setGeomThread(targetId, shankIndex, { pitchMm: threadInfo[2], left: false, fitMm: 0 });
  }

  const node = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
  const placed = node?.geoms?.[shankIndex];
  if (!node || !placed?.cutAt || !placed.cutNormal) {
    return { ok: false, error: 'The countersink could not be placed' };
  }

  const usedNames = new Set((node.geoms ?? []).map((g) => g.name));
  let n = 1;
  while (usedNames.has(`${targetId}_countersink${n}_head`) || usedNames.has(`${targetId}_countersink${n}_shank`)) n++;
  const group = `countersink${n}`;

  const built = countersinkCutGeoms(
    {
      group,
      size: resolvedSize,
      at: placed.cutAt,
      normal: placed.cutNormal,
      bore: resolvedBore,
      fitMm: resolvedFit,
      angleDeg: resolvedAngle,
    },
    targetId,
  );
  const renamedShank: SceneGeom = { ...placed, name: `${targetId}_${group}_shank` };
  const nextGeoms = node.geoms.map((g, i) => (i === shankIndex ? renamedShank : g));
  nextGeoms.splice(shankIndex, 0, built.head);
  useStore.getState().updateNode(targetId, { geoms: nextGeoms, csgEnabled: true });

  return {
    ok: true,
    id: targetId,
    group,
    shape: 'countersink',
    size: built.size,
    bore: built.bore,
    angleDeg: built.angleDeg,
    headDiameterMm: built.headDiameterMm,
    depthMm: built.depthMm,
    fitMm: built.fitMm,
    atMm: placed.cutAt.map((v: number) => Math.round(v * 1000 * 1000) / 1000),
    normal: placed.cutNormal,
    pieces: ['head', 'shank'],
  };
}

/**
 * A smooth pocket: placed the way any cut is (a line cast along `normal`
 * through `at` finds the surface), then swapped for a dense closed mesh of the
 * outline, depth and floor asked for, baked into the body's frame. It keeps no
 * cutAt, so nothing re-derives it as a primitive; what it was made from stays
 * on it as `pocket`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyPocketCut(targetId: string, spec: Record<string, any>, spotIn?: { at: number[]; normal: number[] }): Record<string, any> {
  if (spec.outline !== undefined && (typeof spec.outline !== 'string' || !POCKET_OUTLINES.has(spec.outline))) {
    return { ok: false, error: "outline must be 'rect', 'ellipse', or 'circle'" };
  }
  if (spec.floor !== undefined && (typeof spec.floor !== 'string' || !POCKET_FLOORS.has(spec.floor))) {
    return { ok: false, error: "floor must be 'flat' or 'bowl'" };
  }
  if (spec.cornerRadiusMm !== undefined && (!isFiniteNumber(spec.cornerRadiusMm) || spec.cornerRadiusMm < 0)) {
    return { ok: false, error: 'cornerRadiusMm must be a non-negative finite number' };
  }
  if (spec.floorRadiusMm !== undefined && (!isFiniteNumber(spec.floorRadiusMm) || spec.floorRadiusMm < 0)) {
    return { ok: false, error: 'floorRadiusMm must be a non-negative finite number' };
  }
  for (const key of ['widthMm', 'lengthMm', 'diameterMm', 'depthMm'] as const) {
    if (spec[key] !== undefined && (!isFiniteNumber(spec[key]) || spec[key] <= 0)) {
      return { ok: false, error: `${key} must be a positive finite number` };
    }
  }
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
  const outline = spec.outline === 'ellipse' || spec.outline === 'circle' ? 'ellipse' : 'rect';
  const widthMm = num(spec.widthMm) ?? num(spec.diameterMm);
  const lengthMm = num(spec.lengthMm) ?? (outline === 'ellipse' ? widthMm : undefined);
  const depthMm = num(spec.depthMm);
  if (!widthMm || !lengthMm || !depthMm) {
    return { ok: false, error: 'A pocket needs positive finite widthMm and lengthMm (or diameterMm for a round one) and depthMm' };
  }
  const pocket: PocketSpec = {
    outline,
    widthMm,
    lengthMm,
    depthMm,
    ...(num(spec.cornerRadiusMm) ? { cornerRadiusMm: num(spec.cornerRadiusMm) } : {}),
    floor: spec.floor === 'bowl' ? 'bowl' : 'flat',
    ...(typeof spec.floorRadiusMm === 'number' ? { floorRadiusMm: spec.floorRadiusMm } : {}),
  };
  const store = useStore.getState();
  const index = store.addBodyCut(targetId, 'cylinder', spotIn);
  if (index < 0) return { ok: false, error: 'That body has no solid shape to cut into' };
  const node = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
  const placed = node?.geoms?.[index];
  if (!node || !placed?.cutAt || !placed.cutNormal) return { ok: false, error: 'The pocket could not be placed' };

  const { verts, faces } = pocketMesh(pocket);
  const n = new Vector3(...(placed.cutNormal as [number, number, number])).normalize();
  const turn = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), n);
  const origin = new Vector3(...(placed.cutAt as [number, number, number]));
  const zup: number[] = [];
  const v = new Vector3();
  for (let i = 0; i < verts.length; i += 3) {
    v.set(verts[i] / 1000, verts[i + 1] / 1000, verts[i + 2] / 1000).applyQuaternion(turn).add(origin);
    zup.push(v.x, v.y, v.z);
  }
  const yup = zup.flatMap((_, i, a) => (i % 3 === 0 ? [a[i], a[i + 2], -a[i + 1]] : []));
  const mesh: SceneGeom = {
    name: placed.name,
    type: 'mesh',
    // A mesh geom's size is unused, as for every other mesh geom.
    size: [1],
    csg: 'difference',
    rgba: placed.rgba,
    renderVertices: zup,
    vertices: yup,
    faces,
    pocket: { ...pocket, at: [...placed.cutAt], normal: [...placed.cutNormal] },
  };
  store.updateNode(targetId, { geoms: node.geoms.map((g, i) => (i === index ? mesh : g)) });
  return {
    ok: true,
    id: targetId,
    geomIndex: index,
    name: placed.name,
    shape: 'pocket',
    atMm: placed.cutAt.map((c: number) => Math.round(c * 1e6) / 1000),
    normal: placed.cutNormal,
    pocket,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applyRoundEdgesToBody(targetId: string, specs: Record<string, any>[], compileNow = true): Promise<Record<string, any>> {
  const store = useStore.getState();
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  const why = whyNotRoundable(node);
  if (why) return { ok: false, error: node ? why : `No object with id '${targetId}'` };
  const found = await bodyEdges(node!, bodyUp(store.sceneGraph.nodes, targetId));
  // Validate every spec in the batch before mutating the store so a bad entry
  // never leaves earlier specs applied in a half-baked state.
  type PlannedRound =
    | { remove: true; edges: (typeof found.edges)[number]['edge'][] }
    | { remove: false; mode: 'fillet' | 'chamfer'; size: number; edges: (typeof found.edges)[number]['edge'][] };
  const planned: PlannedRound[] = [];
  let clampedEdges = 0;
  let skippedEdges = 0;

  for (const spec of specs) {
    if (!isPlainObject(spec)) return { ok: false, error: 'Each rounding specification must be a plain object' };
    const { edges, sizeMm, mode, remove } = spec;
    let which: EdgeGroup | number[] | null = null;
    if (Array.isArray(edges)) {
      if (edges.some((e) => !isFiniteNumber(e) || !Number.isInteger(e))) {
        return { ok: false, error: 'edges list must contain integer edge ids from physics_get_edges' };
      }
      which = edges as number[];
    } else if (edges === undefined) {
      which = 'all';
    } else if (typeof edges === 'string' && ['all', 'top', 'bottom', 'vertical', 'inside'].includes(edges)) {
      which = edges as EdgeGroup;
    }
    if (which === null) return { ok: false, error: "edges must be 'all', 'top', 'bottom', 'vertical', 'inside' or a list of ids from physics_get_edges" };
    const { picked, unknown } = selectEdges(found.edges, which);
    if (unknown.length) return { ok: false, error: `No edge with id ${unknown.join(', ')} — physics_get_edges lists them` };
    if (picked.length === 0) return { ok: false, error: `This part has no ${Array.isArray(which) ? '' : which + ' '}edges that can be rounded` };

    if (remove === true) {
      planned.push({ remove: true, edges: picked.map((e) => e.edge) });
    } else {
      if (mode !== undefined && (typeof mode !== 'string' || !ROUND_MODES.has(mode))) {
        return { ok: false, error: "mode must be 'round', 'fillet', 'bevel', or 'chamfer'" };
      }
      const kind: 'fillet' | 'chamfer' = mode === 'bevel' || mode === 'chamfer' ? 'chamfer' : 'fillet';
      if (!isFiniteNumber(sizeMm) || !(sizeMm > 0)) return { ok: false, error: 'sizeMm must be a positive finite number of millimetres' };
      const plan = planClampedRoundings(picked, kind, sizeMm / 1000);
      if (!plan.ok) {
        return { ok: false, error: `${sizeMm} mm is too big for ${picked.length === 1 ? 'this edge' : 'these edges'} — ${Math.floor(plan.maxFit * 1e5) / 100} mm is the most that fits` };
      }
      clampedEdges += plan.clampedCount;
      skippedEdges += plan.skippedCount;
      for (const group of plan.groups) {
        planned.push({ remove: false, mode: kind, size: group.size, edges: group.edges });
      }
    }
  }

  let totalChanged = 0;
  for (const step of planned) {
    if (step.remove) {
      useStore.getState().unroundEdges(targetId, step.edges);
    } else {
      useStore.getState().roundEdges(targetId, { mode: step.mode, size: step.size, edges: step.edges });
    }
    totalChanged += step.edges.length;
  }

  if (compileNow) {
    await compileCsgNodes(true);
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
  }
  const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
  if (after?.csgError) return { ok: false, error: `Rounding failed: ${after.csgError}` };
  const compileError = compileNow ? useStore.getState().lastCompileError : null;
  if (compileError) return { ok: false, error: compileError };
  return {
    ok: true,
    id: targetId,
    edgesChanged: totalChanged,
    ...(clampedEdges > 0 ? { clampedEdges } : {}),
    ...(skippedEdges > 0 ? { skippedEdges } : {}),
    roundings: (after?.edgeRounds ?? []).map((f, i) => ({
      index: i, mode: f.mode === 'fillet' ? 'round' : 'bevel', sizeMm: Math.round(f.size * 1e5) / 100, edges: f.edges.length,
    })),
    ...(after?.csgVolume !== undefined ? { volumeMm3: Math.round(after.csgVolume * 1e9 * 10) / 10 } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applySinglePatternToBody(targetId: string, m: Record<string, any>): Promise<Record<string, any>> {
  if (!isPlainObject(m)) return { ok: false, error: 'Pattern specification must be a plain object' };
  const store = useStore.getState();
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) return { ok: false, error: `No object with id '${targetId}'` };
  const at = pointList(m.at)[0];
  if (!isFiniteVec3(at)) {
    return { ok: false, error: "Missing or invalid at: expected [x, y, z] of finite numbers in the body's own frame in millimetres." };
  }
  if (m.normal !== undefined) {
    if (!isFiniteVec3(m.normal)) return { ok: false, error: 'normal must be [x, y, z] of finite numbers.' };
    if (Math.hypot(m.normal[0], m.normal[1], m.normal[2]) < 1e-9) return { ok: false, error: 'normal must not be [0, 0, 0].' };
  }
  const pick = patternPickAt(node, at.map((v) => v / 1000), m.normal);
  if (!pick) {
    return { ok: false, error: `No surface of '${targetId}' within 10 mm of [${at.join(', ')}] mm. Points are in the body's own frame in millimetres; physics_get_object gives the shapes, and normal says which way the face looks.` };
  }
  const geom = (node.geoms || []).find((g) => g.name === pick.geomName);
  if (!geom) return { ok: false, error: `The face picked belongs to '${pick.geomName}', which is not on the body.` };
  const existing = geom.textures ?? [];
  const describe = (t: SurfaceTexture) =>
    `${patternById(t.pattern)?.label ?? t.pattern}, ${t.depthM > 0 ? 'embossed' : 'engraved'} ${(Math.abs(t.depthM) * 1000).toFixed(1)} mm`;

  if (m.remove) {
    if (pick.index === undefined) return { ok: false, error: 'There is no pattern on the face at that point.' };
    const list = existing.filter((_, i) => i !== pick.index);
    if (!m.preview) useStore.getState().setGeomTextures(node.id, geom.name, list.length ? list : undefined);
    return { ok: true, removed: describe(existing[pick.index]), geomName: geom.name, remaining: list.length };
  }

  const prev = pick.index !== undefined ? existing[pick.index] : undefined;
  const faceable = SURFACE_PATTERNS.filter((p) => !p.throughCut);
  const known = () =>
    faceable.map((p) => `${p.id} (${p.fields.map((f) => f.key).join(', ')})`).join('; ');
  const patternId = m.pattern ?? prev?.pattern;
  if (!patternId || typeof patternId !== 'string') return { ok: false, error: `Missing pattern. One of, with its options: ${known()}.` };
  const spec = patternById(patternId);
  if (!spec || spec.throughCut) {
    return { ok: false, error: `'${patternId}' is not a pattern that goes on a face. One of, with its options: ${known()}.` };
  }
  const projections: TextureProjection[] = ['auto', 'planar', 'cylindrical', 'revolved', 'unwrap'];
  if (m.projection !== undefined && (typeof m.projection !== 'string' || !projections.includes(m.projection as TextureProjection))) {
    return { ok: false, error: `projection is one of ${projections.join(', ')}.` };
  }
  if (m.options !== undefined && !isPlainObject(m.options)) {
    return { ok: false, error: 'options must be a plain object.' };
  }
  const optionKeys = new Set(spec.fields.map((f) => f.key));
  const unknown = Object.keys(m.options ?? {}).filter((k) => !optionKeys.has(k));
  const depthMm = m.depthMm !== undefined ? m.depthMm : (prev ? Math.abs(prev.depthM) * 1000 : 1.5);
  if (!isFiniteNumber(depthMm) || !(depthMm > 0)) return { ok: false, error: 'depthMm must be a positive finite number.' };
  if (m.borderMm !== undefined && (!isFiniteNumber(m.borderMm) || m.borderMm < 0)) {
    return { ok: false, error: 'borderMm must be a non-negative finite number.' };
  }
  if (m.cellMm !== undefined && (!isFiniteNumber(m.cellMm) || m.cellMm <= 0)) {
    return { ok: false, error: 'cellMm must be a positive finite number.' };
  }
  if (m.stopAtDeg !== undefined && !isFiniteNumber(m.stopAtDeg)) {
    return { ok: false, error: 'stopAtDeg must be a finite number.' };
  }
  if (m.twistDeg !== undefined && !isFiniteNumber(m.twistDeg)) {
    return { ok: false, error: 'twistDeg must be a finite number.' };
  }
  if (m.scale !== undefined && (!isFiniteNumber(m.scale) || m.scale <= 0)) {
    return { ok: false, error: 'scale must be a positive finite number.' };
  }
  const emboss = m.emboss ?? (prev ? prev.depthM > 0 : false);
  const projection = (m.projection ?? prev?.projection) as TextureProjection | undefined;
  // [r, g, b] 0..1 or '#rrggbb' for the part the pattern moves; null or 'none' clears it.
  let color: number[] | undefined = prev?.color;
  if (m.color === null || m.color === 'none') color = undefined;
  else if (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) color = hexToRgb(m.color);
  else if (Array.isArray(m.color) && (m.color.length === 3 || m.color.length === 4) && m.color.slice(0, 3).every((v: unknown) => isFiniteNumber(v) && v >= 0 && v <= 1)) {
    color = m.color.slice(0, 3) as number[];
  } else if (m.color !== undefined) return { ok: false, error: "color is [r, g, b] each a finite number in 0..1, or '#rrggbb', or 'none'." };
  const cellField = spec.fields.find((f) => f.key === 'cellMm') as { min?: number } | undefined;
  const rawOptions = (m.options as SurfaceTexture['options']) ?? {};
  const propagateCellToOption =
    !!cellField &&
    m.cellMm !== undefined &&
    rawOptions.cellMm === undefined &&
    m.cellMm >= (cellField.min ?? 2);
  const texture: SurfaceTexture = {
    pattern: spec.id,
    options: {
      ...spec.defaults,
      ...(prev?.pattern === spec.id ? prev.options : {}),
      ...rawOptions,
      ...(propagateCellToOption ? { cellMm: m.cellMm } : {}),
    },
    depthM: ((emboss ? 1 : -1) * depthMm) / 1000,
    borderM: m.borderMm !== undefined ? Math.max(0, m.borderMm) / 1000 : prev?.borderM ?? DEFAULT_TEXTURE_BORDER_M,
    // Lettering's strokes want finer triangles than a texture does.
    cellM: !propagateCellToOption && m.cellMm !== undefined
      ? Math.max(0.05, m.cellMm) / 1000
      : prev?.cellM ?? (spec.figure || spec.wraps ? 0.00025 : DEFAULT_TEXTURE_CELL_M),
    seedAt: prev?.seedAt ?? pick.seedAt,
    seedNormal: prev?.seedNormal ?? pick.seedNormal,
    maxTiltDeg: m.stopAtDeg ?? prev?.maxTiltDeg,
    projection: projection === 'auto' ? undefined : projection,
    twistDeg: m.twistDeg ?? prev?.twistDeg,
    scale: m.scale ?? prev?.scale,
    ...(color ? { color } : {}),
  };
  // Text fetches its font and is laid out here; the build only fills the outline.
  if (spec.prepare) {
    try {
      texture.options = await spec.prepare(texture.options ?? {});
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  // Re-read fresh node/geom after await so concurrent texture edits aren't clobbered.
  const freshNodeAfterPrepare = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
  const freshGeomAfterPrepare = (freshNodeAfterPrepare?.geoms || []).find((g) => g.name === geom.name);
  if (!freshNodeAfterPrepare || !freshGeomAfterPrepare) {
    return { ok: false, error: `Body '${node.id}' or geom '${geom.name}' was removed while preparing the pattern.` };
  }
  const freshExisting = freshGeomAfterPrepare.textures ?? [];
  const index = pick.index !== undefined && pick.index < freshExisting.length ? pick.index : freshExisting.length;
  const list = [...freshExisting];
  list[index] = texture;
  const surface = await requestTexturedSurface({ ...freshGeomAfterPrepare, textures: list }, geomHalfLen(freshGeomAfterPrepare));
  const region = surface?.regions.find((r) => r.index === index);
  const warnings = [
    ...(surface?.warnings ?? [])
      .filter((w) => w.startsWith(`Pattern ${index + 1}:`) || !w.startsWith('Pattern '))
      .map((w) => w.replace(/^Pattern \d+: /, '')),
    ...(unknown.length ? [`${spec.label} has no option ${unknown.join(', ')}; it takes ${[...optionKeys].join(', ')}.`] : []),
  ];
  if (!region?.applied) {
    return { ok: false, error: region?.reason ?? 'The pattern could not be laid on that face.', warnings };
  }
  if (!m.preview) {
    const latestNode = findNodeInScene(useStore.getState().sceneGraph.nodes, node.id);
    const latestGeom = (latestNode?.geoms || []).find((g) => g.name === geom.name);
    if (!latestNode || !latestGeom) {
      return { ok: false, error: `Body '${node.id}' or geom '${geom.name}' was removed while building the pattern.` };
    }
    const latestTextures = [...(latestGeom.textures ?? [])];
    if (pick.index !== undefined && pick.index < latestTextures.length) {
      latestTextures[pick.index] = texture;
    } else {
      latestTextures.push(texture);
    }
    useStore.getState().setGeomTextures(latestNode.id, latestGeom.name, latestTextures);
  }
  const mm = (v: number) => Math.round(v * 10000) / 10;
  return {
    ok: true,
    preview: !!m.preview,
    edited: pick.index !== undefined,
    index,
    geomName: geom.name,
    pattern: describe({ ...texture, depthM: region.depthM }),
    options: Object.fromEntries(Object.entries(texture.options ?? {}).filter(([k]) => k !== 'outline' && k !== 'outlineSig' && k !== 'imageGrid')),
    faceMm: [mm(region.extentM[0]), mm(region.extentM[1])],
    areaMm2: Math.round(region.areaM2 * 1e6),
    projection: region.projection,
    stretchPercent: region.stretch !== undefined && Number.isFinite(region.stretch) ? Math.round(region.stretch * 100) : null,
    ...(region.wrap ? { wrap: region.wrap } : {}),
    ...(region.seam ? { seam: true } : {}),
    ...(region.capped ? { capped: true } : {}),
    depthMm: mm(Math.abs(region.depthM)),
    ...(texture.color ? { color: rgbToHex(texture.color) } : {}),
    triangles: region.triangles,
    warnings,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyPaintStrokeToBody(targetId: string, m: Record<string, any>): Record<string, any> {
  if (!isPlainObject(m)) throw new Error('Paint stroke must be a plain object');
  const store = useStore.getState();
  const { geomName, at, atMm, radius, radiusMm, rgba, flow, erase, line, hardness, symmetry } = m;
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) throw new Error(`No object with id '${targetId}'`);

  const geom = geomName
    ? (node.geoms || []).find((g: SceneGeom) => g.name === geomName)
    : (node.csgEnabled
        ? (node.geoms || []).find((g: SceneGeom) => g.csgDerived === 'visual' && isPaintable(g.type, !!node.isWedge)) ??
          (node.geoms || []).find((g: SceneGeom) => isPaintable(g.type, !!node.isWedge))
        : (node.geoms || []).find((g: SceneGeom) => isPaintable(g.type, !!node.isWedge)));
  if (!geom) throw new Error(geomName ? `No geom named '${geomName}' on '${targetId}'` : `Nothing paintable on '${targetId}'`);
  if (!isPaintable(geom.type, !!node.isWedge)) {
    throw new Error(`A '${geom.type}' geom cannot hold paint — paintable types are box, sphere, ellipsoid, cylinder, capsule and mesh`);
  }
  const normColor = normalizeRgba(rgba);
  if (!normColor) throw new Error('rgba must be [r, g, b] or [r, g, b, a], each a finite number in 0..1');

  const rawPoints: number[][] = at !== undefined
    ? pointList(at)
    : atMm !== undefined
      ? pointList(atMm).map((p) => (isFiniteVec3(p) ? [p[0] / 1000, p[1] / 1000, p[2] / 1000] : p))
      : [];
  const points: number[][] = rawPoints;
  if (!points.length || points.some((p: unknown) => !isFiniteVec3(p))) {
    throw new Error("at must be [x, y, z] or a list of them, with finite numbers in the geom's own frame in metres (or pass atMm in millimetres)");
  }
  if (radius !== undefined && (!isFiniteNumber(radius) || radius <= 0)) {
    throw new Error('radius must be a positive finite number in metres');
  }
  if (radiusMm !== undefined && (!isFiniteNumber(radiusMm) || radiusMm <= 0)) {
    throw new Error('radiusMm must be a positive finite number in millimetres');
  }
  if (flow !== undefined && (!isFiniteNumber(flow) || flow < 0 || flow > 1)) {
    throw new Error('flow must be a finite number in 0..1');
  }
  if (hardness !== undefined && (!isFiniteNumber(hardness) || hardness < 0 || hardness > 1)) {
    throw new Error('hardness must be a finite number in 0..1');
  }
  if (symmetry !== undefined && symmetry !== 'x' && symmetry !== 'y' && symmetry !== 'z') {
    throw new Error("symmetry must be 'x', 'y' or 'z'");
  }
  const brush = typeof radius === 'number'
    ? radius
    : typeof radiusMm === 'number'
      ? radiusMm / 1000
      : 0.008;

  const isDynamicMesh = geom.type === 'mesh' && (geom.dynamic !== false || !geom.vertices?.length);
  const rawMeshPositions = geom.type === 'mesh'
    ? (isDynamicMesh ? (geom.renderVertices ?? geom.vertices) : geom.vertices)
    : undefined;
  const args = paintArgsFromSize(geom.type, geom.size || []);
  const res = geom.paint
    ? geom.paint.res
    : geom.type === 'mesh'
      ? (rawMeshPositions?.length ? paintMeshResolution(rawMeshPositions) : [])
      : paintResolution(geom.type, args);
  const built = geom.type === 'mesh'
    ? (rawMeshPositions?.length && geom.faces?.length && res.length
        ? buildMeshPaintGeometry(rawMeshPositions, geom.faces, res)
        : null)
    : buildPaintGeometry(geom.type, args, res);
  const positions: ArrayLike<number> | undefined = built
    ? (built.getAttribute('position')?.array as Float32Array | undefined)
    : rawMeshPositions;
  const faces: ArrayLike<number> | undefined = built
    ? (built.getIndex()?.array as Uint32Array | undefined)
    : geom.faces;
  if (!positions?.length) throw new Error('That geom has no surface to paint');

  const canvas = canvasFromLayer(geom.paint, positions.length / 3, res);
  const pointRuns: number[][][] = [points];
  if (symmetry) {
    const axis = symmetry === 'x' ? 0 : symmetry === 'y' ? 1 : 2;
    pointRuns.push(points.map((p) => {
      const q = [p[0], p[1], p[2]];
      q[axis] = -q[axis];
      return q;
    }));
  }
  // A line is its points joined: dabs a third of a radius apart along each
  // step, each pulled onto the surface so a long step across a curved body
  // does not sink under it. Without it each point is a dab of its own (the
  // pips of a die), and a stripe drawn as points came out dotted.
  const dabs: number[][] = [];
  for (const run of pointRuns) {
    const local = run.map((p) => toGeometrySpace(geom.type, p, isDynamicMesh));
    dabs.push(...(line === true ? alongSurface(local, positions, brush / 3) : local));
  }
  let landed = 0;
  for (const [x, y, z] of dabs) {
    if (applyDab(canvas, positions, {
      x, y, z,
      radius: brush,
      color: normColor,
      flow: typeof flow === 'number' ? flow : 1,
      erase: !!erase,
      hardness: typeof hardness === 'number' ? hardness : DEFAULT_PAINT_HARDNESS,
    }, faces)) landed++;
  }
  built?.dispose();

  if (!landed) {
    return {
      ok: false, geomName: geom.name, dabsLanded: 0, dabsRequested: dabs.length,
      error: `No vertices within ${brush} m of any of those points — 'at' must be on the surface in the geom's own frame in METRES (or pass 'atMm' in millimetres)`,
    };
  }
  useStore.getState().setGeomPaint(targetId, geom.name, layerFromCanvas(canvas));
  return { ok: true, geomName: geom.name, dabsLanded: landed, dabsRequested: dabs.length };
}

/** Points `step` apart along a polyline, each moved to the nearest surface vertex. */
function alongSurface(points: number[][], positions: ArrayLike<number>, step: number): number[][] {
  const nearest = (p: number[]) => {
    let best = Infinity, at = p;
    for (let v = 0; v < positions.length; v += 3) {
      const d = (positions[v] - p[0]) ** 2 + (positions[v + 1] - p[1]) ** 2 + (positions[v + 2] - p[2]) ** 2;
      if (d < best) { best = d; at = [positions[v], positions[v + 1], positions[v + 2]]; }
    }
    return at;
  };
  const out: number[][] = points.length ? [points[0]] : [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const n = Math.min(400, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / step));
    for (let k = 1; k < n; k++) out.push(nearest([0, 1, 2].map((j) => a[j] + (b[j] - a[j]) * (k / n))));
    out.push(b);
  }
  return out;
}

export async function applyDeclarativePreCsgFeatures(
  nodes: SceneNode[],
  opsMap: Map<string, PendingDeclarativeOps> = pendingDeclarativeOps,
): Promise<void> {
  const walk = async (list: SceneNode[]) => {
    for (const n of list || []) {
      const pending = opsMap.get(n.id);
      if (pending) {
        if (pending.sculptCuts && pending.sculptCuts.length > 0) {
          for (const cutSpec of pending.sculptCuts) {
            const live = findNodeInScene(useStore.getState().sceneGraph.nodes, n.id);
            if (!live || !live.isSculpt) break;
            const geomIndex = Math.max(0, (live.geoms ?? []).findIndex((g: SceneGeom) => g.type === 'mesh'));
            const mesh = sculptMeshOf(live);
            const res = await cutSculptOffThread(
              mesh,
              { kind: 'polygon', polygon: cutSpec.polygon, direction: cutSpec.direction },
              { mode: cutSpec.mode, cap: cutSpec.cap },
            );
            if (!res.ok) throw new Error(`Sculpt cut on '${n.name}' failed: ${res.error}`);
            const latest = useStore.getState();
            latest.updateNode(n.id, { sculptEdited: true, sculptVersion: (live.sculptVersion ?? 1) + 1 });
            const { vertices, renderVertices, faces } = toSceneGeom(res.mesh);
            latest.updateNodeGeom(n.id, { vertices, renderVertices, faces }, geomIndex);
          }
        }
        if (pending.cuts && pending.cuts.length > 0) {
          for (const cutSpec of pending.cuts) {
            const res = applySingleCutToBody(n.id, cutSpec);
            if (!res.ok) throw new Error(`Cut on '${n.name}' failed: ${res.error}`);
          }
        }
        if (pending.roundEdges && pending.roundEdges.length > 0) {
          const res = await applyRoundEdgesToBody(n.id, pending.roundEdges, false);
          if (!res.ok) throw new Error(`Edge rounding on '${n.name}' failed: ${res.error}`);
        }
        if (pending.patterns && pending.patterns.length > 0) {
          for (const patSpec of pending.patterns) {
            const res = await applySinglePatternToBody(n.id, patSpec);
            if (!res.ok) throw new Error(`Pattern on '${n.name}' failed: ${res.error}`);
          }
        }
      }
      if (n.children && n.children.length > 0) {
        await walk(n.children);
      }
    }
  };
  await walk(nodes);
}

export async function applyDeclarativePostCsgFeatures(
  nodes: SceneNode[],
  opsMap: Map<string, PendingDeclarativeOps> = pendingDeclarativeOps,
): Promise<void> {
  const walk = async (list: SceneNode[]) => {
    for (const n of list || []) {
      const pending = opsMap.get(n.id);
      if (pending) {
        opsMap.delete(n.id);
        if (pending.paint && pending.paint.length > 0) {
          for (const paintSpec of pending.paint) {
            const res = applyPaintStrokeToBody(n.id, paintSpec);
            if (!res.ok) throw new Error(`Paint on '${n.name}' failed: ${res.error}`);
          }
        }
      }
      if (n.children && n.children.length > 0) {
        await walk(n.children);
      }
    }
  };
  await walk(nodes);
}
