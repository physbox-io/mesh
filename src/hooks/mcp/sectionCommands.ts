// ---------------------------------------------------------------------------
// A section through the parts over MCP: what a screenshot cannot show
// ---------------------------------------------------------------------------
//
// An agent looking at a handle that barely joined its jug saw nothing wrong in
// screenshots and found the notch only by slicing the part outside Mesh.
// SECTION cuts body_id (or every body) square to one world axis and returns
// each piece of the cut: outline, area, holes, thickest and where it pinches.
// On the export worker: building the solid of a dense part takes seconds.

import * as THREE from 'three';
import { isBoughtIn } from '../../utils/boughtIn';
import { ExportWorkerClient } from '../../utils/exportWorkerClient';
import { runExportJob } from '../../utils/exportJobs';
import { getNodeWorldTransform } from '../../utils/laserCutExporter';
import { mcpMoldSubject } from '../../utils/moldSubject';
import { isNodeRotationBaked } from '../../utils/sceneTree';
import type { SectionAxis, SectionResult } from '../../utils/sectionQuery';
import type { SceneNode } from '../../types/scene';
import { findNodeInScene } from './bridgeUtils';
import type { McpCommands } from './types';

function liftForExplicitSection(nodes: SceneNode[], wantedIds: string[]): SceneNode[] {
  const wanted = new Set(wantedIds);
  const byId = new Map<string, SceneNode>();
  const walk = (list: SceneNode[], parent?: THREE.Matrix4) => {
    for (const n of list) {
      const world = getNodeWorldTransform(n, parent);
      if (wanted.has(n.id)) {
        const cleaned = { ...n, simulation: undefined, pourBox: undefined, hardwarePart: undefined, acousticString: undefined };
        if (!parent) {
          byId.set(n.id, cleaned);
        } else {
          const pos = new THREE.Vector3();
          const q = new THREE.Quaternion();
          world.decompose(pos, q, new THREE.Vector3());
          const { euler: _euler, ...rest } = cleaned;
          const geoms = isNodeRotationBaked(n)
            ? n.geoms.map(({ baseVertices: _bv, baseRenderVertices: _brv, ...g }) => g)
            : n.geoms;
          byId.set(n.id, { ...rest, geoms, pos: [pos.x, pos.y, pos.z], quat: [q.w, q.x, q.y, q.z] });
        }
      }
      if (n.children?.length) walk(n.children, world);
    }
  };
  walk(nodes);
  return wantedIds.map((id) => byId.get(id)).filter((n): n is SceneNode => Boolean(n));
}

export const sectionCommands: McpCommands = {
  SECTION: async (msg, { store, toId }) => {
    if (msg.axis !== undefined && typeof msg.axis !== 'string') {
      return { ok: false, error: "axis is 'x', 'y' or 'z': the world axis the cut is square to." };
    }
    const axis = (typeof msg.axis === 'string' ? msg.axis.toLowerCase() : 'z') as SectionAxis;
    if (!['x', 'y', 'z'].includes(axis)) return { ok: false, error: "axis is 'x', 'y' or 'z': the world axis the cut is square to." };
    if (msg.atMm !== undefined && !(typeof msg.atMm === 'number' && Number.isFinite(msg.atMm))) return { ok: false, error: 'at_mm is a distance along the axis, scene mm.' };
    if (msg.bodyId !== undefined && msg.bodyId !== null && typeof msg.bodyId !== 'string') {
      return { ok: false, error: 'bodyId must be a body id or name string.' };
    }
    let subject: { scene: typeof store.sceneGraph; label: string; ids: string[] };
    const rawIds = typeof msg.bodyId === 'string'
      ? msg.bodyId.split(',').map((x) => x.trim()).filter(Boolean)
      : [];
    const resolvedNodes = rawIds
      .map((id) => findNodeInScene(store.sceneGraph.nodes, (toId ? toId(id) : id) as string))
      .filter((n): n is NonNullable<typeof n> => Boolean(n));
    if (rawIds.length > 0 && resolvedNodes.length === rawIds.length && resolvedNodes.some((n) => Boolean(n.simulation || n.pourBox || isBoughtIn(n)))) {
      // Explicit body_id targeting a simulation, pour box, or bought hardware
      // (e.g. inspecting a generated mold's wall thickness or a fastener):
      // lift to world pose and strip exclusion tags so it can be sliced.
      const lifted = liftForExplicitSection(store.sceneGraph.nodes, resolvedNodes.map((n) => n.id));
      subject = {
        scene: { ...store.sceneGraph, nodes: lifted },
        label: lifted.length === 1 ? lifted[0].name : `${lifted[0].name} and ${lifted.length - 1} more`,
        ids: lifted.map((n) => n.id),
      };
    } else {
      const checked = mcpMoldSubject(store.sceneGraph, msg.bodyId, (id) => findNodeInScene(store.sceneGraph.nodes, (toId ? toId(id) : id) as string), 'cut', 'body_id');
      if ('error' in checked) return { ok: false, error: checked.error };
      subject = checked;
    }
    const options = { axis, ...(typeof msg.atMm === 'number' ? { atMm: msg.atMm } : {}) };
    let result: SectionResult;
    try {
      if (typeof Worker === 'undefined') result = await runExportJob('section', subject.scene, options);
      else {
        const client = new ExportWorkerClient();
        try { result = await client.run('section', subject.scene, options); } finally { client.dispose(); }
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const outside = result.atMm < result.spanMm[0] || result.atMm > result.spanMm[1];
    return {
      ok: true,
      cut: { label: subject.label, ids: subject.ids },
      ...result,
      ...(outside ? { warnings: [`${axis} = ${result.atMm} mm is outside the parts (${result.spanMm[0]} to ${result.spanMm[1]} mm), so the cut is empty.`] } : {}),
    };
  },
};
