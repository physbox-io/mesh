// ---------------------------------------------------------------------------
// The DFM check over MCP: will it print, machine or cast, and where not
// ---------------------------------------------------------------------------
//
// The editor's DFM panel judges a part for the bench's printer, router or a
// casting: walls too thin, overhangs, undercuts, draft, sections a cast will
// not fill. None of it reached an agent, which had to write its own checks
// and so missed 0.6 mm spokes a mold could not hold. CHECK_DFM is the same
// analysis, on the DFM worker, of master_id or every body.

import { useStore } from '../../store/useStore';
import { dfmReportFor } from '../../utils/dfmWorkerClient';
import type { DfmProcess } from '../../utils/dfm';
import { mcpMoldSubject } from '../../utils/moldSubject';
import { CAST_MATERIALS, resolveCastMaterial } from '../../utils/castMaterials';
import { findNodeInScene } from './bridgeUtils';
import type { McpCommands } from './types';

const PROCESSES: Record<string, DfmProcess> = { print: 'print', fdm: 'print', cnc: 'cnc', machining: 'cnc', cast: 'cast', mold: 'cast' };

const mm = (v: number) => Math.round(v * 10000) / 10;

export const dfmCommands: McpCommands = {
  CHECK_DFM: async (msg, { store, toId }) => {
    const state = useStore.getState();
    const asked = typeof msg.process === 'string' ? PROCESSES[msg.process] : undefined;
    if (msg.process !== undefined && !asked) return { ok: false, error: "process is 'print', 'cnc' or 'cast'." };
    // Default: what the bench is set up for, as the panel's lens follows it.
    const process: DfmProcess = asked ?? (state.machineTarget === 'fdm' ? 'print' : 'cnc');
    const castMaterial = resolveCastMaterial(msg.castMaterial);
    if (msg.castMaterial !== undefined && !castMaterial) {
      return { ok: false, error: `cast_material is one of ${CAST_MATERIALS.map((m) => m.id).join(', ')}.` };
    }
    const subject = mcpMoldSubject(store.sceneGraph, msg.masterId, (id) => findNodeInScene(store.sceneGraph.nodes, toId(id) as string), 'check');
    if ('error' in subject) return { ok: false, error: subject.error };
    const report = await dfmReportFor(subject.scene, process, {
      material: state.material,
      filament: state.filament,
      stock: state.stock,
      printBed: state.printBed,
      ...(castMaterial ? { castMaterial } : {}),
    });
    if (!report) return { ok: false, error: 'The check could not be run: try again in a moment.' };
    return {
      ok: true,
      process,
      checked: { label: subject.label, ids: subject.ids },
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
