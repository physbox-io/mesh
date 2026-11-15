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
  SECTION: async (msg, { store }) => {
    const axis = (typeof msg.axis === 'string' ? msg.axis.toLowerCase() : 'z') as SectionAxis;
    if (!['x', 'y', 'z'].includes(axis)) return { ok: false, error: "axis is 'x', 'y' or 'z': the world axis the cut is square to." };
    if (msg.atMm !== undefined && !(typeof msg.atMm === 'number' && Number.isFinite(msg.atMm))) return { ok: false, error: 'at_mm is a distance along the axis, scene mm.' };
    const subject = mcpMoldSubject(store.sceneGraph, msg.bodyId, (id) => findNodeInScene(store.sceneGraph.nodes, id), 'cut');
    if ('error' in subject) return { ok: false, error: subject.error };
    const options = { axis, ...(typeof msg.atMm === 'number' ? { atMm: msg.atMm } : {}) };
    let result: SectionResult;
    try {
      if (typeof Worker === 'undefined') result = await runExportJob('section', subject.scene, options);
      else {
        const client = new ExportWorkerClient();
        try { result = await client.run('section', subject.scene, options); } finally { client.dispose(); }
      }
    } catch (e) {
      return { ok: false, error: (e as Error).message };
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
