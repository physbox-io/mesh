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

import { useStore } from '../../store/useStore';
import { DEFAULT_CONTOUR_OPTIONS, type ContourSliceResult } from '../../utils/contourSliceExporter';
import { DEFAULT_SHEET_UNFOLD_OPTIONS, exportSheetUnfold, type SheetUnfoldOptions } from '../../utils/sheetUnfoldExporter';
import type { LaserCutResult } from '../../utils/laserCutExporter';
import { layoutKerf } from '../../utils/sheetCutRecipe';
import { etchLayoutOptions } from '../../utils/etchSceneHandoff';
import { ExportWorkerClient } from '../../utils/exportWorkerClient';
import { mcpMoldSubject } from '../../utils/moldSubject';
import { findNodeInScene, describeFiles } from './bridgeUtils';
import type { McpCommands } from './types';

const KINDS = ['panels', 'contour', 'unfold'] as const;
type CutKind = (typeof KINDS)[number];

const fileSafe = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'cut';

export const cutCommands: McpCommands = {
  EXPORT_CUT: async (msg, { store, toId }) => {
    const kind = (msg.kind ?? 'panels') as CutKind;
    if (!KINDS.includes(kind)) return { ok: false, error: "kind is 'panels', 'contour' or 'unfold'." };
    if (msg.machine !== undefined && msg.machine !== 'laser' && msg.machine !== 'cnc') {
      return { ok: false, error: "machine is 'laser' or 'cnc' (default: the bench's)." };
    }
    const subject = mcpMoldSubject(store.sceneGraph, msg.masterId, (id) => findNodeInScene(store.sceneGraph.nodes, toId(id) as string), 'cut');
    if ('error' in subject) return { ok: false, error: subject.error };
    const state = useStore.getState();
    const machine: 'laser' | 'cnc' = msg.machine === 'laser' || msg.machine === 'cnc'
      ? msg.machine
      : state.machineTarget === 'laser' ? 'laser' : 'cnc';
    const stock = state.stock;
    const name = `${subject.label} ${kind}`;
    const pack = (svg: string, thicknessMm: number, summary: Record<string, unknown>, warnings: string[]) => ({
      ok: true,
      kind,
      machine,
      cut: { label: subject.label, ids: subject.ids },
      // What the server hands Etch with the drawing (etch_set_svg's fields).
      etch: { name, thicknessMm, machine, material: state.material },
      summary: { ...summary, thicknessMm },
      warnings,
      files: describeFiles([{ name: `${fileSafe(name)}.svg`, bytes: new TextEncoder().encode(svg) }], msg.includeFiles !== false),
    });

    if (kind === 'unfold') {
      const mode = msg.sheetMode ?? msg.mode;
      const thick = typeof msg.thicknessMm === 'number' && msg.thicknessMm > 0 ? msg.thicknessMm : DEFAULT_SHEET_UNFOLD_OPTIONS.thicknessMm;
      const options: SheetUnfoldOptions = {
        ...DEFAULT_SHEET_UNFOLD_OPTIONS,
        ...(mode === 'papercraft' || mode === 'sheet_metal' || mode === 'soft_goods' ? { mode } : {}),
        thicknessMm: thick,
      };
      const res = exportSheetUnfold(subject.scene, options);
      if (!res.success || !res.svg) return { ok: false, error: res.error || 'Nothing here unfolds.', warnings: res.warnings };
      return pack(res.svg, thick, { mode: res.mode, pieces: res.islands.length }, res.warnings);
    }

    const client = new ExportWorkerClient();
    try {
      if (kind === 'panels') {
        // As the Etch button lays it out: the bench's machine and stock.
        const res: LaserCutResult = await client.run('laser', subject.scene, etchLayoutOptions({ machine, stock }));
        if (!res.success || !res.svg || !res.panels?.length) {
          return { ok: false, error: res.error || 'Nothing here lays flat into panels to cut.', warnings: res.warnings ?? [] };
        }
        return pack(res.svg, stock.thicknessMm, { panels: res.panels.length, sheets: res.sheets?.length ?? 1 }, res.warnings ?? []);
      }
      // A contour layer is one sheet of the bench stock, as in its dialog.
      const res: ContourSliceResult = await client.run('contour', subject.scene, {
        ...DEFAULT_CONTOUR_OPTIONS,
        materialThickness: stock.thicknessMm / 1000,
        kerf: layoutKerf(machine, DEFAULT_CONTOUR_OPTIONS.kerf),
        sheetWidth: stock.widthMm / 1000,
        sheetHeight: stock.depthMm / 1000,
      });
      if (!res.success || !res.svg || !res.layers?.length) {
        return { ok: false, error: res.error || 'The model could not be sliced.', warnings: res.warnings ?? [] };
      }
      return pack(res.svg, stock.thicknessMm, { layers: res.layers.length }, res.warnings ?? []);
    } finally {
      client.dispose();
    }
  },
};
