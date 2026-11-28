// ---------------------------------------------------------------------------
// The 2D exports over MCP: panels, contour slices and unfolded nets as SVG
// ---------------------------------------------------------------------------
//
// Laying a model out flat is Mesh's work, not something an agent can redo:
// the panels need their joints cut to the stock, nesting on the sheet, and a
// laser's kerf or a router's dogbones; a contour stack needs slicing at the
// stock's pitch; a net needs unfolding. physics_add_simulation ran all three
// and handed back only the simulated parts, so the SVG Etch takes was out of
// reach. EXPORT_CUT returns it, as the bottom bar's Etch button and the three
// dialogs make it; the MCP server writes it to disk or sends it straight to
// the Etch tab, so the drawing never passes through the agent.

import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import type { SceneGraph, SceneNode } from '../../types/scene';
import { DEFAULT_CONTOUR_OPTIONS, type ContourSliceResult } from '../../utils/contourSliceExporter';
import {
  DEFAULT_SHEET_UNFOLD_OPTIONS,
  SHEET_PRESETS,
  exportSheetUnfold,
  renderSingleSheetUnfoldSvg,
  type SheetPreset,
  type SheetUnfoldOptions,
} from '../../utils/sheetUnfoldExporter';
import { getNodeWorldTransform, type LaserCutResult } from '../../utils/laserCutExporter';
import { layoutCutOutset, layoutKerf, layoutMargin } from '../../utils/sheetCutRecipe';
import type { EtchSheetSpec } from '../../utils/etchHandoff';
import { etchLayoutOptions } from '../../utils/etchSceneHandoff';
import { ExportWorkerClient } from '../../utils/exportWorkerClient';
import { mcpMoldSubject, type MoldSubject } from '../../utils/moldSubject';
import { isPourTooling, withoutTooling } from '../../utils/pourTooling';
import { isNodeRotationBaked } from '../../utils/sceneTree';
import { findNodeInScene, describeFiles } from './bridgeUtils';
import { collectClothNodes, DEFAULT_PATTERN_OPTIONS, exportClothPatternUnfold, patternLines, stalePatternIds } from '../../utils/cloth/patternExport';
import { staleBodies } from '../../utils/sceneSummary';
import { modelBuiltFrom } from '../../store/modelProvenance';
import { PAPER_SPECS, type PaperFormat } from '../../utils/tiledPaperPrint';
import { CLOTH_MATERIALS } from '../../utils/cloth/clothMesh';
import { patternSvg } from '../../utils/cloth/patternSvg';
import type { ClothMaterialName } from '../../types/cloth';

const PAPER_FORMATS = Object.keys(PAPER_SPECS) as PaperFormat[];
import type { McpCommands } from './types';

const KINDS = ['panels', 'contour', 'unfold'] as const;
type CutKind = (typeof KINDS)[number];
const SHEET_MODES = ['papercraft', 'sheet_metal', 'soft_goods'] as const;
const SHEET_PRESET_NAMES = Object.keys(SHEET_PRESETS) as SheetPreset[];
const JOINT_MODES = ['finger', 'slot', 'glue'] as const;

const fileSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'cut';

function hasOwnPositiveGeoms(node: SceneNode): boolean {
  return (node.geoms || []).some((g) => g.role !== 'collision' && g.csg !== 'difference');
}

function liftCutNode(node: SceneNode, world: THREE.Matrix4): SceneNode {
  const pos = new THREE.Vector3();
  const q = new THREE.Quaternion();
  world.decompose(pos, q, new THREE.Vector3());
  const { euler: _euler, ...rest } = node;
  const geoms = isNodeRotationBaked(node)
    ? node.geoms.map(({ baseVertices: _bv, baseRenderVertices: _brv, ...g }) => g)
    : node.geoms;
  return { ...rest, geoms, pos: [pos.x, pos.y, pos.z], quat: [q.w, q.x, q.y, q.z] };
}

/**
 * Resolves the cut subject while preventing parent-subtree leakage when explicit
 * `masterId` bodies are named (e.g. a wood lid panel carrying child steel hinges
 * or a brass hasp).
 *
 * - `includeChildren === true`: preserves full subtrees (existing `mcpMoldSubject` behavior).
 * - `includeChildren === false`: strips unrequested children even for whole-scene or container nodes.
 * - `includeChildren === undefined` (default):
 *   - With explicit `masterId`: strips unrequested children from bodies that have their own
 *     geometry (while still picking any child that was also explicitly listed in `masterId`),
 *     and keeps children for empty container/group bodies that have no geometry of their own.
 *   - Without `masterId` (whole scene): includes the whole scene tree as usual.
 */
function resolveCutSubject(
  scene: SceneGraph,
  masterId: unknown,
  resolve: (id: string) => SceneNode | null,
  includeChildren: boolean | undefined,
): MoldSubject | { error: string } {
  const base = mcpMoldSubject(scene, masterId, resolve, 'cut');
  if ('error' in base) return base;

  const named = typeof masterId === 'string'
    ? masterId.split(',').map((x) => x.trim()).filter(Boolean)
    : [];

  if (named.length === 0) {
    if (includeChildren === false) {
      const stripped = base.scene.nodes.map((n) => ({ ...n, children: [] }));
      return { ...base, scene: { ...base.scene, nodes: stripped } };
    }
    return base;
  }

  if (includeChildren === true) return base;

  const wanted = new Set(named.map((id) => resolve(id)!.id));
  const picked: SceneNode[] = [];
  const real = (n: SceneNode) => !n.simulation && !isPourTooling(n);

  const walk = (nodes: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of nodes) {
      if (!real(n)) continue;
      const world = getNodeWorldTransform(n, parent);
      if (wanted.has(n.id)) {
        const keepSubtree = includeChildren === undefined && !hasOwnPositiveGeoms(n) && (n.children?.length ?? 0) > 0;
        const liftedNode = parent ? liftCutNode(n, world) : n;
        if (keepSubtree) {
          picked.push(withoutTooling(liftedNode));
        } else {
          picked.push({ ...liftedNode, children: [] });
          if (n.children?.length) walk(n.children, world);
        }
      } else if (n.children?.length) {
        walk(n.children, world);
      }
    }
  };
  walk(scene.nodes);

  if (!picked.length) return base;
  return {
    scene: { ...scene, nodes: picked },
    ids: picked.map((n) => n.id),
    label: picked.length <= 2 ? picked.map((n) => n.name).join(' and ') : `${picked[0].name} and ${picked.length - 1} more`,
  };
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

export const cutCommands: McpCommands = {
  EXPORT_CUT: async (msg, { store, toId }) => {
    const kind = (msg.kind ?? 'panels') as CutKind;
    if (!KINDS.includes(kind)) return { ok: false, error: "kind is 'panels', 'contour' or 'unfold'." };
    if (msg.machine !== undefined && msg.machine !== null && msg.machine !== 'laser' && msg.machine !== 'cnc' && msg.machine !== 'router') {
      return { ok: false, error: "machine is 'laser' or 'cnc' (default: the bench's)." };
    }
    if (msg.jointMode !== undefined && msg.jointMode !== null
      && (typeof msg.jointMode !== 'string' || !(JOINT_MODES as readonly string[]).includes(msg.jointMode))) {
      return { ok: false, error: `jointMode is one of ${JOINT_MODES.join(', ')}.` };
    }
    if (msg.masterId !== undefined && msg.masterId !== null && typeof msg.masterId !== 'string') {
      return { ok: false, error: 'masterId must be a string.' };
    }
    const rawIncludeChildren = msg.includeChildren !== undefined ? msg.includeChildren : msg.include_children;
    if (rawIncludeChildren !== undefined && rawIncludeChildren !== null && typeof rawIncludeChildren !== 'boolean') {
      return { ok: false, error: 'includeChildren must be a boolean.' };
    }
    const includeChildren = typeof rawIncludeChildren === 'boolean' ? rawIncludeChildren : undefined;
    const subject = resolveCutSubject(
      store.sceneGraph,
      msg.masterId,
      (id) => findNodeInScene(store.sceneGraph.nodes, (toId ? toId(id) : id) as string),
      includeChildren,
    );
    if ('error' in subject) return { ok: false, error: subject.error };
    const state = useStore.getState();
    const machine: 'laser' | 'cnc' = msg.machine === 'laser'
      ? 'laser'
      : msg.machine === 'cnc' || msg.machine === 'router'
        ? 'cnc'
        : kind === 'unfold'
          ? 'laser'
          : state.machineTarget === 'laser' ? 'laser' : 'cnc';
    const stock = state.stock;
    const name = `${subject.label} ${kind}`;
    const pack = (
      svg: string,
      thicknessMm: number,
      summary: Record<string, unknown>,
      warnings: string[],
      sheets?: EtchSheetSpec[],
      fileEntries?: Array<{ name: string; bytes: Uint8Array }>,
    ) => ({
      ok: true,
      kind,
      machine,
      cut: { label: subject.label, ids: subject.ids },
      // What the server hands Etch with the drawing (etch_set_svg's fields).
      etch: { name, thicknessMm, machine, material: state.material, ...(sheets && sheets.length > 1 ? { sheets } : {}) },
      summary: { ...summary, thicknessMm },
      warnings,
      files: describeFiles(
        fileEntries ?? [{ name: `${fileSafe(name)}.svg`, bytes: new TextEncoder().encode(svg) }],
        msg.includeFiles !== false,
      ),
    });

    if (kind === 'unfold') {
      const rawMode = msg.sheetMode ?? msg.mode;
      if (rawMode !== undefined && rawMode !== null
        && (typeof rawMode !== 'string' || !(SHEET_MODES as readonly string[]).includes(rawMode))) {
        return { ok: false, error: `sheetMode is one of ${SHEET_MODES.join(', ')}.` };
      }
      const rawPreset = msg.sheetPreset ?? msg.sheet_preset;
      if (rawPreset !== undefined && rawPreset !== null
        && (typeof rawPreset !== 'string' || !(SHEET_PRESET_NAMES as readonly string[]).includes(rawPreset))) {
        return { ok: false, error: `sheetPreset is one of ${SHEET_PRESET_NAMES.join(', ')}.` };
      }
      const rawGroupByColor = msg.groupByColor !== undefined ? msg.groupByColor : msg.group_by_color;
      if (rawGroupByColor !== undefined && rawGroupByColor !== null && typeof rawGroupByColor !== 'boolean') {
        return { ok: false, error: 'groupByColor must be a boolean.' };
      }
      const rawOnePartPerSheet = msg.onePartPerSheet !== undefined ? msg.onePartPerSheet : msg.one_part_per_sheet;
      if (rawOnePartPerSheet !== undefined && rawOnePartPerSheet !== null && typeof rawOnePartPerSheet !== 'boolean') {
        return { ok: false, error: 'onePartPerSheet must be a boolean.' };
      }
      const rawSplitSheets = msg.splitSheets !== undefined ? msg.splitSheets : msg.split_sheets;
      if (rawSplitSheets !== undefined && rawSplitSheets !== null && typeof rawSplitSheets !== 'boolean') {
        return { ok: false, error: 'splitSheets must be a boolean.' };
      }
      const splitSheets = rawSplitSheets === true;
      const t1 = checkPos(msg.thicknessMm, 'thicknessMm');
      if (!t1.ok) return t1;
      const t2 = checkPos(msg.materialThicknessMm, 'materialThicknessMm');
      if (!t2.ok) return t2;
      const bend = checkNonNeg(msg.bendRadiusMm, 'bendRadiusMm');
      if (!bend.ok) return bend;
      const scale = checkPos(msg.scaleFactor, 'scaleFactor');
      if (!scale.ok) return scale;
      const tabW = checkNonNeg(msg.tabWidthMm, 'tabWidthMm');
      if (!tabW.ok) return tabW;
      const rawSeam = msg.seamAllowanceMm !== undefined ? msg.seamAllowanceMm : msg.seam_allowance_mm;
      const seam = checkNonNeg(rawSeam, 'seamAllowanceMm');
      if (!seam.ok) return seam;
      const stitch = checkNonNeg(msg.stitchPitchMm, 'stitchPitchMm');
      if (!stitch.ok) return stitch;
      if (msg.kFactor !== undefined && msg.kFactor !== null
        && (typeof msg.kFactor !== 'number' || !Number.isFinite(msg.kFactor) || msg.kFactor < 0 || msg.kFactor > 1)) {
        return { ok: false, error: 'kFactor must be a finite number between 0 and 1.' };
      }
      const thick = t1.value ?? t2.value ?? DEFAULT_SHEET_UNFOLD_OPTIONS.thicknessMm;
      const sheetPreset = typeof rawPreset === 'string' ? (rawPreset as SheetPreset) : undefined;
      const presetDims = sheetPreset ? SHEET_PRESETS[sheetPreset] : undefined;
      const options: SheetUnfoldOptions & { material?: typeof state.material; machine?: 'laser' | 'cnc' } = {
        ...DEFAULT_SHEET_UNFOLD_OPTIONS,
        ...(rawMode ? { mode: rawMode as SheetUnfoldOptions['mode'] } : {}),
        thicknessMm: thick,
        ...(sheetPreset ? { sheetPreset } : {}),
        sheetWidthMm: presetDims ? presetDims.widthMm : stock.widthMm,
        sheetHeightMm: presetDims ? presetDims.heightMm : stock.depthMm,
        ...(rawGroupByColor === true ? { groupByColor: true } : {}),
        ...(rawOnePartPerSheet === true ? { onePartPerSheet: true } : {}),
        ...(bend.value !== undefined ? { bendRadiusMm: bend.value } : {}),
        ...(typeof msg.kFactor === 'number' ? { kFactor: msg.kFactor } : {}),
        ...(scale.value !== undefined ? { scaleFactor: scale.value } : {}),
        ...(tabW.value !== undefined ? { tabWidthMm: tabW.value } : {}),
        ...(seam.value !== undefined ? { seamAllowanceMm: seam.value } : {}),
        ...(stitch.value !== undefined ? { stitchPitchMm: stitch.value } : {}),
        material: state.material,
        machine,
      };
      // A garment is unfolded as its sewing pattern, whatever else is in the
      // subject: the form it is fitted to is the mannequin it was cut on, not a
      // part to unfold (a whole-scene unfold of a dress on its form unfolded
      // the form's 42 meshes for over ten minutes). Only an explicit papercraft
      // or sheet-metal mode unfolds the rigid bodies instead.
      const clothNodes = collectClothNodes(subject.scene.nodes);
      const rigidMode = rawMode === 'papercraft' || rawMode === 'sheet_metal';
      if (clothNodes.length > 0 && !rigidMode) {
        const built = store.model ? modelBuiltFrom().graph : null;
        const stale = stalePatternIds(clothNodes, store.sceneGraph.nodes, staleBodies(store.sceneGraph, built));
        const clothSeamMm = seam.value ?? DEFAULT_PATTERN_OPTIONS.seamAllowanceMm;
        // A sheet preset that is paper prints the pattern tiled 1:1 on it.
        const paper = sheetPreset && (PAPER_FORMATS as readonly string[]).includes(sheetPreset) ? sheetPreset as PaperFormat : undefined;
        const rawHem = msg.hemAllowanceMm !== undefined ? msg.hemAllowanceMm : msg.hem_allowance_mm;
        const hem = checkNonNeg(rawHem, 'hemAllowanceMm');
        if (!hem.ok) return hem;
        const rawByLine = msg.edgeAllowanceMm !== undefined ? msg.edgeAllowanceMm : msg.edge_allowance_mm;
        if (rawByLine !== undefined && rawByLine !== null && (typeof rawByLine !== 'object' || Array.isArray(rawByLine)
          || Object.values(rawByLine as Record<string, unknown>).some((v) => typeof v !== 'number' || !Number.isFinite(v) || v < 0))) {
          return { ok: false, error: 'edgeAllowanceMm is an object of line name to a non-negative allowance in mm (e.g. the hem, a neckline).' };
        }
        const rawFold = msg.fold;
        if (rawFold !== undefined && rawFold !== null && typeof rawFold !== 'boolean') return { ok: false, error: 'fold must be a boolean.' };
        const clothRes = exportClothPatternUnfold(clothNodes, store.sceneGraph.nodes, state.model?.flexes, {
          seamAllowanceMm: clothSeamMm,
          ...(hem.value !== undefined ? { hemAllowanceMm: hem.value } : {}),
          ...(rawByLine ? { edgeAllowanceMm: rawByLine as Record<string, number> } : {}),
          ...(typeof rawFold === 'boolean' ? { fold: rawFold } : {}),
          title: subject.label,
          stale,
          ...(paper ? { paper } : {}),
        });
        if (!clothRes.ok) {
          return { ok: false, error: clothRes.error, warnings: clothRes.warnings };
        }
        const leftOut: string[] = [];
        const walkLeft = (list: SceneNode[]) => {
          for (const n of list) {
            if (!n.cloth && !n.bodyForm && hasOwnPositiveGeoms(n)) leftOut.push(n.name || n.id);
            if (n.children?.length) walkLeft(n.children);
          }
        };
        walkLeft(subject.scene.nodes);
        const warnings = [...clothRes.warnings];
        if (leftOut.length) {
          warnings.push(`Only the garment pattern is unfolded; ${leftOut.slice(0, 5).join(', ')}${leftOut.length > 5 ? ` and ${leftOut.length - 5} more` : ''} left out (name them in masterId with sheetMode 'papercraft' or 'sheet_metal' to unfold them).`);
        }
        // Said, not dropped: what a sewn garment's pattern has no use for.
        const unused = ([
          ['bendRadiusMm', bend.value], ['kFactor', msg.kFactor], ['tabWidthMm', tabW.value],
          ['stitchPitchMm', stitch.value], ['scaleFactor', scale.value !== undefined && scale.value !== 1 ? scale.value : undefined],
          ['groupByColor', rawGroupByColor === true ? true : undefined],
        ] as [string, unknown][]).filter(([, v]) => v !== undefined && v !== null).map(([k]) => k);
        if (unused.length) warnings.push(`Not used for a garment pattern (drawn 1:1, seams sewn, not glued or bent): ${unused.join(', ')}.`);
        if (sheetPreset && !paper) warnings.push(`sheetPreset '${sheetPreset}' is not a paper to print on; the pattern is one sheet.`);
        // Etch is handed the fabric's thickness; it has no fabric stock, so its material is left to choose there.
        const fabricMm = clothRes.fabrics.map((f) => CLOTH_MATERIALS[f as ClothMaterialName]?.thickness).filter((t): t is number => typeof t === 'number');
        const clothThick = t1.value ?? t2.value ?? (fabricMm.length ? +(Math.max(...fabricMm) * 1000).toFixed(2) : 1);
        warnings.push(`Etch has no fabric stock: set its material and laser power for ${clothRes.fabrics.join(', ') || 'the fabric'} before cutting.`);
        const sheetW = Math.round(clothRes.layout.width);
        const sheetH = Math.round(clothRes.layout.height);
        const stem = fileSafe(`${subject.label} pattern`);
        const enc = (t: string) => new TextEncoder().encode(t);
        const files: Array<{ name: string; bytes: Uint8Array }> = [];
        if (rawOnePartPerSheet === true) {
          for (const piece of clothRes.pieceNames) {
            const one = clothRes.pieces.filter((p) => p.name === piece);
            files.push({ name: `${stem}_${fileSafe(piece)}.svg`, bytes: enc(patternSvg(one, `${subject.label} ${piece}`, clothRes.options)) });
          }
        } else {
          files.push({ name: `${stem}.svg`, bytes: enc(clothRes.svg) });
        }
        if (clothRes.print) {
          files.push({ name: `${stem}_${clothRes.print.paper}_tiled.html`, bytes: enc(clothRes.print.html) });
          if (splitSheets) clothRes.print.pageSvgs.forEach((pg, i) => files.push({ name: `${stem}_${clothRes.print!.paper}_page_${i + 1}.svg`, bytes: enc(pg) }));
        }
        const reply = pack(
          clothRes.svg,
          clothThick,
          {
            mode: 'soft_goods',
            pieces: clothRes.pieceNames.length,
            pieceNames: clothRes.pieceNames,
            cutList: clothRes.layout.pieces.map((p) => ({ piece: p.name, cut: p.cut, widthMm: Math.round(p.w), heightMm: Math.round(p.h) })),
            hemAllowanceMm: clothRes.options.hemAllowanceMm,
            ...(clothRes.options.edgeAllowanceMm ? { edgeAllowanceMm: clothRes.options.edgeAllowanceMm } : {}),
            lines: patternLines(clothRes.pieces),
            sheets: 1,
            widthMm: sheetW,
            heightMm: sheetH,
            seamAllowanceMm: clothRes.seamAllowanceMm,
            fabrics: clothRes.fabrics,
            ...(clothRes.print ? { paper: clothRes.print.paper, printPages: clothRes.print.pages } : {}),
          },
          warnings,
          [{ widthMm: sheetW, heightMm: sheetH, thicknessMm: clothThick }],
          files,
        );
        return { ...reply, etch: { name: reply.etch.name, thicknessMm: clothThick, machine } };
      }
      try {
        const res = exportSheetUnfold(subject.scene, options);
        if (!res.success || !res.svg) {
          return { ok: false, error: res.error || 'Nothing here unfolds.', warnings: res.warnings };
        }
        const sheets: EtchSheetSpec[] = res.sheets.map((s) => ({ widthMm: s.widthMm, heightMm: s.heightMm, thicknessMm: thick }));
        const cornerBlocked = res.cornerBlockedTabCount ?? 0;
        const suggestedTabWidthMm = Math.round(options.tabWidthMm * 0.5 * 10) / 10;
        let omittedTabsHint: string | undefined;
        if (res.omittedTabCount > 0) {
          if (cornerBlocked >= res.omittedTabCount) {
            omittedTabsHint = `${res.omittedTabCount} glue tab(s) were omitted in tight/zero-clearance inside corners where adjacent unfolded faces meet with no room for a tab; narrowing tab_width_mm further will not fit these corners (tape or bridge those seams on assembly, or split the net).`;
          } else if (suggestedTabWidthMm < 2) {
            omittedTabsHint = `${res.omittedTabCount} glue tab(s) were omitted due to tight corner/face clearance; tab_width_mm (${options.tabWidthMm} mm) is already near the minimum practical width (2 mm), so assemble those seams with tape or split the net.`;
          } else if (cornerBlocked > 0) {
            const nonCorner = res.omittedTabCount - cornerBlocked;
            omittedTabsHint = `${res.omittedTabCount} glue tab(s) were omitted (${cornerBlocked} in tight/zero-clearance inside corners, ${nonCorner} due to overlap clearance); try a narrower tab_width_mm (e.g. ${suggestedTabWidthMm} mm) to fit the non-corner tabs.`;
          } else {
            omittedTabsHint = `${res.omittedTabCount} glue tab(s) were omitted due to overlap/clearance collisions; try a narrower tab_width_mm (e.g. ${suggestedTabWidthMm} mm) to fit more tabs.`;
          }
        }
        const sheetGroups = res.sheets.some((s) => s.groupLabel || s.colorHex)
          ? res.sheets.map((s) => ({
              sheet: s.index + 1,
              widthMm: s.widthMm,
              heightMm: s.heightMm,
              pieces: s.islandIds.length,
              ...(s.groupLabel ? { group: s.groupLabel } : {}),
              ...(s.colorHex ? { colorHex: s.colorHex } : {}),
            }))
          : undefined;
        const splitFileEntries = splitSheets && res.sheets.length > 0
          ? res.sheets.map((s) => {
              const rawLabel = s.groupLabel || (s.colorHex ? s.colorHex.replace(/^#/, '') : '');
              const labelSuffix = rawLabel ? `_${fileSafe(rawLabel)}` : '';
              const sheetSvg = renderSingleSheetUnfoldSvg(res.islands, s, options);
              return {
                name: `${fileSafe(name)}_sheet_${s.index + 1}${labelSuffix}.svg`,
                bytes: new TextEncoder().encode(sheetSvg),
              };
            })
          : undefined;
        return pack(
          res.svg,
          thick,
          {
            mode: res.mode,
            pieces: res.islands.length,
            sheets: res.sheets.length || 1,
            glueTabs: res.glueTabCount,
            omittedTabs: res.omittedTabCount,
            ...(cornerBlocked > 0 ? { cornerBlockedTabs: cornerBlocked } : {}),
            ...(omittedTabsHint ? { omittedTabsHint } : {}),
            ...(sheetPreset ? { sheetPreset } : {}),
            ...(sheetGroups ? { sheetGroups } : {}),
            ...(splitSheets ? { splitSheets: true } : {}),
          },
          res.warnings,
          sheets,
          splitFileEntries,
        );
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const client = new ExportWorkerClient();
    try {
      if (kind === 'panels') {
        // As the Etch button lays it out: the bench's machine and stock.
        const layoutOpts = etchLayoutOptions({ machine, stock });
        if (typeof msg.jointMode === 'string') {
          layoutOpts.jointMode = msg.jointMode as typeof layoutOpts.jointMode;
        }
        const res: LaserCutResult = await client.run('laser', subject.scene, layoutOpts);
        if (!res.success || !res.svg || !res.panels?.length) {
          return { ok: false, error: res.error || 'Nothing here lays flat into panels to cut.', warnings: res.warnings ?? [] };
        }
        return pack(res.svg, stock.thicknessMm, { panels: res.panels.length, sheets: res.sheets?.length ?? 1 }, res.warnings ?? [], res.sheets);
      }
      // A contour layer is one sheet of the bench stock, as in its dialog.
      const bitDiameter = 0.003175;
      const res: ContourSliceResult = await client.run('contour', subject.scene, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: stock.thicknessMm / 1000,
        kerf: layoutKerf(machine, DEFAULT_CONTOUR_OPTIONS.kerf),
        margin: layoutMargin(machine, bitDiameter),
        cutOutset: layoutCutOutset(machine, bitDiameter),
        sheetWidth: stock.widthMm / 1000,
        sheetHeight: stock.depthMm / 1000,
      });
      if (!res.success || !res.svg || !res.layers?.length) {
        return { ok: false, error: res.error || 'The model could not be sliced.', warnings: res.warnings ?? [] };
      }
      const sheetCount = Math.max(1, res.sheetCount ?? 1);
      const sheets: EtchSheetSpec[] = Array.from({ length: sheetCount }, () => ({
        widthMm: stock.widthMm,
        heightMm: stock.depthMm,
        thicknessMm: stock.thicknessMm,
      }));
      return pack(res.svg, stock.thicknessMm, { layers: res.layers.length, sheets: sheetCount }, res.warnings ?? [], sheets);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      client.dispose();
    }
  },
};
