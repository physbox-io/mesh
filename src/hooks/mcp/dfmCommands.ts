// ---------------------------------------------------------------------------
// The DFM check over MCP: will it print, machine or cast, and where not
// ---------------------------------------------------------------------------
//
// The editor's DFM panel judges a part for the bench's printer, router or a
// casting: walls too thin, overhangs, undercuts, draft, sections a cast will
// not fill. None of it reached an agent, which had to write its own checks
// and so missed 0.6 mm spokes a mold could not hold. CHECK_DFM is the same
// analysis, on the DFM worker, of master_id or every body.

import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { dfmReportFor } from '../../utils/dfmWorkerClient';
import {
  resolveDfmCastMaterialStrict,
  SUPPORTED_CAST_MATERIAL_IDS,
  type DfmProcess,
} from '../../utils/dfm';
import { getNodeWorldTransform } from '../../utils/laserCutExporter';
import { mcpMoldSubject, type MoldSubject } from '../../utils/moldSubject';
import { isPourTooling } from '../../utils/pourTooling';
import { isNodeRotationBaked } from '../../utils/sceneTree';
import type { SceneGraph, SceneNode } from '../../types/scene';
import { findNodeInScene } from './bridgeUtils';
import type { McpCommands } from './types';

const PROCESSES: Record<string, DfmProcess> = { print: 'print', fdm: 'print', cnc: 'cnc', machining: 'cnc', cast: 'cast', mold: 'cast' };

const mm = (v: number) => Math.round(v * 10000) / 10;

/**
 * Picks ONLY the explicitly requested bodies (without pulling in unrequested
 * descendants such as child hardware), lifting each child node to top-level
 * world coordinates with `children: []`.
 */
function explicitNodesSubject(
  scene: SceneGraph,
  named: string[],
  resolve: (id: string) => SceneNode | null,
): MoldSubject | { error: string } {
  const missing = named.filter((id) => !resolve(id));
  if (missing.length) return { error: `No body called ${missing.join(', ')}.` };

  const orderedIds: string[] = [];
  const seen = new Set<string>();
  for (const name of named) {
    const id = resolve(name)!.id;
    if (!seen.has(id)) {
      seen.add(id);
      orderedIds.push(id);
    }
  }

  const worldById = new Map<string, { node: SceneNode; world: THREE.Matrix4; hasParent: boolean }>();
  const walk = (nodes: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of nodes) {
      const world = getNodeWorldTransform(n, parent);
      if (seen.has(n.id)) worldById.set(n.id, { node: n, world, hasParent: Boolean(parent) });
      if (n.children?.length) walk(n.children, world);
    }
  };
  walk(scene.nodes || []);

  const picked: SceneNode[] = [];
  for (const id of orderedIds) {
    const entry = worldById.get(id);
    if (!entry) continue;
    const { node, world, hasParent } = entry;
    if (node.simulation || isPourTooling(node)) continue;
    if (!hasParent) {
      picked.push({ ...node, children: [] });
    } else {
      const pos = new THREE.Vector3();
      const q = new THREE.Quaternion();
      world.decompose(pos, q, new THREE.Vector3());
      const { euler: _euler, ...rest } = node;
      const geoms = isNodeRotationBaked(node)
        ? node.geoms.map(({ baseVertices: _bv, baseRenderVertices: _brv, ...g }) => g)
        : node.geoms;
      picked.push({ ...rest, geoms, pos: [pos.x, pos.y, pos.z], quat: [q.w, q.x, q.y, q.z], children: [] });
    }
  }

  if (!picked.length) {
    return {
      error: `${named.join(', ')} ${named.length === 1 ? 'is a simulation or a pour box' : 'are simulations or pour boxes'}, not part of the design: pass master_id for the part to check.`,
    };
  }
  return {
    scene: { ...scene, nodes: picked },
    ids: picked.map((n) => n.id),
    label: picked.length <= 2 ? picked.map((n) => n.name).join(' and ') : `${picked[0].name} and ${picked.length - 1} more`,
  };
}

export const dfmCommands: McpCommands = {
  CHECK_DFM: async (msg, { store, toId }) => {
    const state = useStore.getState();
    const resolveId = (v: unknown) => (toId ? toId(v) : v);
    const rawProcess = typeof msg.process === 'string' ? msg.process.toLowerCase() : undefined;
    const asked = rawProcess !== undefined && Object.hasOwn(PROCESSES, rawProcess) ? PROCESSES[rawProcess] : undefined;
    if (msg.process !== undefined && !asked) return { ok: false, error: "process is 'print', 'cnc' or 'cast'." };
    // Default: what the bench is set up for, as the panel's lens follows it.
    const process: DfmProcess = asked ?? (state.machineTarget === 'fdm' ? 'print' : 'cnc');

    const rawCastMaterial = msg.castMaterial !== undefined ? msg.castMaterial : msg.cast_material;
    const resolvedCast = rawCastMaterial !== undefined && rawCastMaterial !== null
      ? resolveDfmCastMaterialStrict(rawCastMaterial)
      : null;
    if (rawCastMaterial !== undefined && rawCastMaterial !== null && !resolvedCast) {
      return { ok: false, error: `cast_material is one of ${SUPPORTED_CAST_MATERIAL_IDS.join(', ')}.` };
    }

    const rawBed = msg.bedMm !== undefined ? msg.bedMm : msg.bed_mm;
    let bedOverride: { widthMm: number; depthMm: number; heightMm: number } | undefined;
    if (rawBed !== undefined && rawBed !== null) {
      if (
        !Array.isArray(rawBed) ||
        rawBed.length !== 3 ||
        !rawBed.every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)
      ) {
        return { ok: false, error: 'bed_mm must be [width_mm, depth_mm, height_mm] with positive numbers.' };
      }
      bedOverride = { widthMm: rawBed[0], depthMm: rawBed[1], heightMm: rawBed[2] };
    }

    const rawIncludeChildren = msg.includeChildren !== undefined ? msg.includeChildren : msg.include_children;
    if (rawIncludeChildren !== undefined && typeof rawIncludeChildren !== 'boolean') {
      return { ok: false, error: 'include_children must be a boolean.' };
    }

    if (msg.masterId !== undefined && msg.masterId !== null && typeof msg.masterId !== 'string') {
      return { ok: false, error: 'master_id must be a body id or name string.' };
    }

    const sceneGraph = store?.sceneGraph ?? state.sceneGraph;
    const resolveNode = (id: string) => findNodeInScene(sceneGraph.nodes, resolveId(id) as string);
    const named = typeof msg.masterId === 'string'
      ? msg.masterId.split(',').map((x) => x.trim()).filter(Boolean)
      : [];
    // When multiple explicit IDs are passed, default include_children to false so
    // listing a parent + its panels does not silently pull in unrequested child
    // hardware or collapse the checked list to the parent.
    const includeChildren = typeof rawIncludeChildren === 'boolean' ? rawIncludeChildren : named.length <= 1;

    const subject = named.length > 0 && !includeChildren
      ? explicitNodesSubject(sceneGraph, named, resolveNode)
      : mcpMoldSubject(sceneGraph, msg.masterId, resolveNode, 'check');
    if ('error' in subject) return { ok: false, error: subject.error };

    // When a caller explicitly names a bought-in hardware body via master_id,
    // allow DFM to inspect that requested body directly instead of skipping it.
    const subjectScene = named.length > 0
      ? {
        ...subject.scene,
        nodes: subject.scene.nodes.map((n) => (
          n.hardwarePart || n.acousticString
            ? { ...n, hardwarePart: undefined, acousticString: undefined }
            : n
        )),
      }
      : subject.scene;

    const effectiveBed = bedOverride ?? state.printBed;
    const report = await dfmReportFor(
      subjectScene,
      process,
      {
        material: state.material,
        filament: state.filament,
        stock: state.stock,
        printBed: effectiveBed,
        printer: state.printer,
        checkAllAsPlate: true,
        ...(resolvedCast ? { castMaterial: resolvedCast.id } : {}),
      },
      named.length > 0 ? sceneGraph : undefined,
    );
    if (!report) return { ok: false, error: 'The DFM check timed out or the worker restarted — try again in a moment, or pass master_id to check one body at a time.' };
    return {
      ok: true,
      process,
      checked: { label: subject.label, ids: subject.ids },
      ...(report.minWallMm !== undefined ? { minWallMm: report.minWallMm } : {}),
      ...(process === 'cast' && report.castMaterial ? { castMaterial: report.castMaterial } : {}),
      ...(process === 'print' && effectiveBed
        ? { bedMm: [effectiveBed.widthMm, effectiveBed.depthMm, effectiveBed.heightMm] }
        : {}),
      score: report.score,
      summary: report.summary,
      findings: report.findings.filter((f) => !f.passed).map((f) => ({
        id: f.id,
        severity: f.severity,
        title: f.title,
        detail: f.detail,
        fix: f.fix,
        atMm: f.position.map(mm),
      })),
      warnings: report.warnings,
    };
  },
};
