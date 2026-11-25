// ---------------------------------------------------------------------------
// A section through the parts over MCP: what a screenshot cannot show
// ---------------------------------------------------------------------------
//
// An agent looking at a handle that barely joined its jug saw nothing wrong in
// screenshots and found the notch only by slicing the part outside Mesh.
// SECTION cuts body_id (or every body) square to one world axis and returns
// each piece of the cut: outline, area, holes, thickest and where it pinches.
// On the export worker: building the solid of a dense part takes seconds.

import { ExportWorkerClient } from '../../utils/exportWorkerClient';
import { runExportJob } from '../../utils/exportJobs';
import { mcpMoldSubject } from '../../utils/moldSubject';
import type { SectionAxis, SectionResult } from '../../utils/sectionQuery';
import { findNodeInScene } from './bridgeUtils';
import type { McpCommands } from './types';

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
    if (rawIds.length > 0 && resolvedNodes.length === rawIds.length && resolvedNodes.some((n) => Boolean(n.simulation || n.pourBox))) {
      // Explicit body_id targeting a simulation or pour box (e.g. inspecting a
      // generated mold's wall thickness or cavity clearance): allow slicing it.
      subject = {
        scene: { ...store.sceneGraph, nodes: resolvedNodes.map((n) => ({ ...n, simulation: undefined, pourBox: undefined })) },
        label: resolvedNodes.length === 1 ? resolvedNodes[0].name : `${resolvedNodes[0].name} and ${resolvedNodes.length - 1} more`,
        ids: resolvedNodes.map((n) => n.id),
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
