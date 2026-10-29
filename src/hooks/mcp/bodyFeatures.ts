// ---------------------------------------------------------------------------
// Features an agent declares on a body (cuts, pockets, rounded edges,
// patterns, paint), applied once the body is in the scene
// ---------------------------------------------------------------------------

import { hexToRgb, rgbToHex } from '../../utils/hexColor';
import { pocketMesh, type PocketSpec } from '../../utils/pocketCutter';
import { useStore } from '../../store/useStore';
import { compileCsgNodes } from '../useCsgCompile';
import { bodyEdges, bodyUp, whyNotRoundable } from '../../utils/edgeRoundBase';
import { maxSizeFor, selectEdges, type EdgeGroup } from '../../utils/featureEdges';
import {
  applyDab, buildMeshPaintGeometry, buildPaintGeometry, canvasFromLayer, isPaintable,
  layerFromCanvas, paintArgsFromSize, paintMeshResolution, paintResolution, toGeometrySpace,
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
import { HARDWARE_KINDS, hardwareCutProblem, hardwareSpecOf } from '../../utils/hardwareCuts';
import { sealFindings } from '../../utils/hardwareChecks';
import { pointList, findNodeInScene } from './bridgeUtils';
import { sculptMeshOf } from './sculptState';
import { pendingDeclarativeOps } from './bodyDefaults';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applySingleCutToBody(targetId: string, spec: Record<string, any>): Record<string, any> {
  const store = useStore.getState();
  const { shape, at, normal, diameterMm, widthMm, lengthMm, depthMm, threadPitchMm, threadLeft, threadFitMm, size, bore, fitMm, seal, turned } = spec;
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) return { ok: false, error: `No object with id '${targetId}'` };
  const spotIn = Array.isArray(at) && at.length >= 3
    ? {
      at: [at[0] / 1000, at[1] / 1000, at[2] / 1000],
      normal: Array.isArray(normal) && normal.length >= 3 ? [...normal] : [0, 0, 1],
    }
    : undefined;

  if (typeof shape === 'string' && shape in HARDWARE_KINDS) {
    const hwKind = shape as HardwareCutKind;
    const group = store.addHardwareCut(targetId, hwKind, spotIn);
    if (!group) return { ok: false, error: store.hardwareCutProblemAt(targetId, hwKind, spotIn) ?? 'That body has no solid shape to cut into' };
    const railSeat = hwKind === 'rail_seat' && (typeof lengthMm === 'number' || typeof turned === 'boolean');
    if (size !== undefined || bore !== undefined || fitMm !== undefined || seal !== undefined || railSeat) {
      const current = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
      const before = current && hardwareSpecOf(current.geoms ?? [], group);
      const changes = {
        ...(size !== undefined ? { size: String(size) } : {}),
        ...(bore !== undefined ? { bore: bore as HardwareBore } : {}),
        ...(typeof fitMm === 'number' ? { fitMm } : {}),
        ...(seal === 'face' || seal === 'bore' || seal === 'piston' ? { seal: seal as SealType } : {}),
        // A rail seat's own length and direction.
        ...(hwKind === 'rail_seat' && typeof lengthMm === 'number' ? { lengthMm } : {}),
        ...(hwKind === 'rail_seat' && typeof turned === 'boolean' ? { turned } : {}),
      };
      // A groove a size cannot fit is not changed: say why rather than hand back the wrong one.
      const why = current && before && hardwareCutProblem({ ...before, ...changes }, current);
      if (why) {
        // Nothing half-made is left behind: the groove added at its own size goes too.
        const index = (current.geoms ?? []).findIndex((g) => g.hardware?.group === group && !g.csgDerived);
        if (index >= 0) useStore.getState().deleteNodeGeom(targetId, index);
        return { ok: false, error: why };
      }
      useStore.getState().setHardwareCut(targetId, group, changes);
    }
    const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
    const hwSpec = hardwareSpecOf(after?.geoms ?? [], group);
    const info = HARDWARE_KINDS[hwKind];
    if (size !== undefined && hwSpec && hwSpec.size !== String(size)) {
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
      ...(hwKind === 'oring' || hwKind === 'seal_cord' ? { sealCheck: sealCheckFor(useStore.getState().sceneGraph, targetId, group) } : {}),
    };
  }

  if (shape === 'pocket') return applyPocketCut(targetId, spec, spotIn);

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
 * A smooth pocket: placed the way any cut is (a line cast along `normal`
 * through `at` finds the surface), then swapped for a dense closed mesh of the
 * outline, depth and floor asked for, baked into the body's frame. It keeps no
 * cutAt, so nothing re-derives it as a primitive; what it was made from stays
 * on it as `pocket`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyPocketCut(targetId: string, spec: Record<string, any>, spotIn?: { at: number[]; normal: number[] }): Record<string, any> {
  const num = (v: unknown) => (typeof v === 'number' && v > 0 ? v : undefined);
  const outline = spec.outline === 'ellipse' || spec.outline === 'circle' ? 'ellipse' : 'rect';
  const widthMm = num(spec.widthMm) ?? num(spec.diameterMm);
  const lengthMm = num(spec.lengthMm) ?? (outline === 'ellipse' ? widthMm : undefined);
  const depthMm = num(spec.depthMm);
  if (!widthMm || !lengthMm || !depthMm) {
    return { ok: false, error: 'A pocket needs widthMm and lengthMm (or diameterMm for a round one) and depthMm' };
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
  let totalChanged = 0;

  for (const spec of specs) {
    const { edges, sizeMm, mode, remove } = spec;
    const which = Array.isArray(edges) ? edges.map(Number)
      : edges === undefined ? 'all'
      : ['all', 'top', 'bottom', 'vertical', 'inside'].includes(String(edges)) ? String(edges) as EdgeGroup : null;
    if (which === null) return { ok: false, error: "edges must be 'all', 'top', 'bottom', 'vertical', 'inside' or a list of ids from physics_get_edges" };
    const { picked, unknown } = selectEdges(found.edges, which);
    if (unknown.length) return { ok: false, error: `No edge with id ${unknown.join(', ')} — physics_get_edges lists them` };
    if (picked.length === 0) return { ok: false, error: `This part has no ${Array.isArray(which) ? '' : which + ' '}edges that can be rounded` };

    if (remove === true) {
      useStore.getState().unroundEdges(targetId, picked.map((e) => e.edge));
    } else {
      const kind: 'fillet' | 'chamfer' = mode === 'bevel' || mode === 'chamfer' ? 'chamfer' : 'fillet';
      if (typeof sizeMm !== 'number' || !(sizeMm > 0)) return { ok: false, error: 'sizeMm must be a positive number of millimetres' };
      const most = maxSizeFor(picked, kind);
      if (sizeMm / 1000 > most + 1e-9) {
        return { ok: false, error: `${sizeMm} mm is too big for ${picked.length === 1 ? 'this edge' : 'these edges'} — ${Math.floor(most * 1e5) / 100} mm is the most that fits` };
      }
      useStore.getState().roundEdges(targetId, { mode: kind, size: sizeMm / 1000, edges: picked.map((e) => e.edge) });
    }
    totalChanged += picked.length;
  }

  if (compileNow) {
    await compileCsgNodes(true);
    await useStore.getState().recompile(useStore.getState().sceneGraph, undefined, false, true);
  }
  const after = findNodeInScene(useStore.getState().sceneGraph.nodes, targetId);
  if (after?.csgError) return { ok: false, error: `Rounding failed: ${after.csgError}` };
  return {
    ok: true,
    id: targetId,
    edgesChanged: totalChanged,
    roundings: (after?.edgeRounds ?? []).map((f, i) => ({
      index: i, mode: f.mode === 'fillet' ? 'round' : 'bevel', sizeMm: Math.round(f.size * 1e5) / 100, edges: f.edges.length,
    })),
    ...(after?.csgVolume !== undefined ? { volumeMm3: Math.round(after.csgVolume * 1e9 * 10) / 10 } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applySinglePatternToBody(targetId: string, m: Record<string, any>): Promise<Record<string, any>> {
  const store = useStore.getState();
  const node = findNodeInScene(store.sceneGraph.nodes, targetId);
  if (!node) throw new Error(`No object with id '${targetId}'`);
  const at = pointList(m.at)[0];
  if (!at) throw new Error("Missing at: a point [x, y, z] on the face, in the body's own frame in millimetres.");
  const pick = patternPickAt(node, at.map((v) => v / 1000), Array.isArray(m.normal) ? m.normal : undefined);
  if (!pick) {
    throw new Error(`No surface of '${targetId}' within 10 mm of [${at.join(', ')}] mm. Points are in the body's own frame in millimetres; physics_get_object gives the shapes, and normal says which way the face looks.`);
  }
  const geom = (node.geoms || []).find((g) => g.name === pick.geomName);
  if (!geom) throw new Error(`The face picked belongs to '${pick.geomName}', which is not on the body.`);
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
  if (!patternId) throw new Error(`Missing pattern. One of, with its options: ${known()}.`);
  const spec = patternById(patternId);
  if (!spec || spec.throughCut) {
    throw new Error(`'${patternId}' is not a pattern that goes on a face. One of, with its options: ${known()}.`);
  }
  const projections: TextureProjection[] = ['auto', 'planar', 'cylindrical', 'revolved', 'unwrap'];
  if (m.projection !== undefined && !projections.includes(m.projection as TextureProjection)) {
    throw new Error(`projection is one of ${projections.join(', ')}.`);
  }
  const optionKeys = new Set(spec.fields.map((f) => f.key));
  const unknown = Object.keys(m.options ?? {}).filter((k) => !optionKeys.has(k));
  const depthMm = m.depthMm ?? (prev ? Math.abs(prev.depthM) * 1000 : 1.5);
  if (!(depthMm > 0)) throw new Error('depthMm must be more than 0.');
  const emboss = m.emboss ?? (prev ? prev.depthM > 0 : false);
  const projection = (m.projection ?? prev?.projection) as TextureProjection | undefined;
  // [r, g, b] 0..1 or '#rrggbb' for the part the pattern moves; null or 'none' clears it.
  let color: number[] | undefined = prev?.color;
  if (m.color === null || m.color === 'none') color = undefined;
  else if (typeof m.color === 'string' && /^#[0-9a-f]{6}$/i.test(m.color)) color = hexToRgb(m.color);
  else if (Array.isArray(m.color) && m.color.length >= 3 && m.color.slice(0, 3).every((v: unknown) => typeof v === 'number')) {
    color = m.color.slice(0, 3).map((v: number) => Math.min(1, Math.max(0, v)));
  } else if (m.color !== undefined) throw new Error("color is [r, g, b] each 0..1, or '#rrggbb', or 'none'.");
  const texture: SurfaceTexture = {
    pattern: spec.id,
    options: { ...spec.defaults, ...(prev?.pattern === spec.id ? prev.options : {}), ...(m.options ?? {}) },
    depthM: ((emboss ? 1 : -1) * depthMm) / 1000,
    borderM: m.borderMm !== undefined ? Math.max(0, m.borderMm) / 1000 : prev?.borderM ?? DEFAULT_TEXTURE_BORDER_M,
    // Lettering's strokes want finer triangles than a texture does.
    cellM: m.cellMm !== undefined ? Math.max(0.05, m.cellMm) / 1000 : prev?.cellM ?? (spec.figure || spec.wraps ? 0.00025 : DEFAULT_TEXTURE_CELL_M),
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
  const index = pick.index ?? existing.length;
  const list = [...existing];
  list[index] = texture;
  const surface = await requestTexturedSurface({ ...geom, textures: list }, geomHalfLen(geom));
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
  if (!m.preview) useStore.getState().setGeomTextures(node.id, geom.name, list);
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
  const store = useStore.getState();
  const { geomName, at, radius, rgba, flow, erase } = m;
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
  if (!Array.isArray(rgba) || rgba.length < 3) throw new Error('rgba must be [r, g, b], each 0..1');

  const points: number[][] = pointList(at);
  if (!points.length || points.some((p: unknown) => !Array.isArray(p) || p.length < 3)) {
    throw new Error("at must be [x, y, z] or a list of them, in the geom's own frame (metres)");
  }
  const brush = typeof radius === 'number' ? radius : 0.008;

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
  let landed = 0;
  for (const point of points) {
    const [x, y, z] = toGeometrySpace(geom.type, point, isDynamicMesh);
    if (applyDab(canvas, positions, {
      x, y, z,
      radius: brush,
      color: rgba,
      flow: typeof flow === 'number' ? flow : 1,
      erase: !!erase,
    }, faces)) landed++;
  }
  built?.dispose();

  if (!landed) {
    throw new Error(`No vertices within ${brush} m of any of those points — the point has to be on the surface, in the geom's own frame`);
  }
  useStore.getState().setGeomPaint(targetId, geom.name, layerFromCanvas(canvas));
  return { ok: true, geomName: geom.name, dabsLanded: landed, dabsRequested: points.length };
}

export async function applyDeclarativePreCsgFeatures(nodes: SceneNode[]): Promise<void> {
  const walk = async (list: SceneNode[]) => {
    for (const n of list || []) {
      const pending = pendingDeclarativeOps.get(n.id);
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

export async function applyDeclarativePostCsgFeatures(nodes: SceneNode[]): Promise<void> {
  const walk = async (list: SceneNode[]) => {
    for (const n of list || []) {
      const pending = pendingDeclarativeOps.get(n.id);
      if (pending) {
        pendingDeclarativeOps.delete(n.id);
        if (pending.paint && pending.paint.length > 0) {
          for (const paintSpec of pending.paint) {
            applyPaintStrokeToBody(n.id, paintSpec);
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
