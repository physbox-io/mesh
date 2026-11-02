// ---------------------------------------------------------------------------
// The bottom bar's Etch button: the part, laid flat and opened in Etch
// ---------------------------------------------------------------------------
//
// One click from the model to Etch, where the SVG dialog took a trip through
// its options first. What is sent is that dialog's panel layout, cut for the
// machine the status bar names (a laser's kerf, or a router's dogbones round
// its bit), out of the bench stock: its thickness so Etch derives the feeds,
// its width and depth as the sheet the panels are nested on.

import { ExportWorkerClient } from './exportWorkerClient';
import { DEFAULT_LASER_OPTIONS, type LaserCutOptions } from './laserCutExporter';
import { defaultCornerRelief, layoutKerf } from './sheetCutRecipe';
import { buildEtchHandoffUrl } from './etchHandoff';
import type { SceneGraph } from '../types/scene';

/** A router's bit when nothing says otherwise: 1/8", as the SVG dialog and the MCP default. */
const ROUTER_BIT_MM = 3.175;

export interface EtchSceneRequest {
  /** What to send: the selection's subject scene (utils/moldSubject.ts). */
  scene: SceneGraph;
  /** What to call it in Etch. */
  name: string;
  machine: 'laser' | 'cnc';
  stock: { widthMm: number; depthMm: number; thicknessMm: number };
  /** Where Etch is; by default worked out from where Mesh runs (etchBaseUrl). */
  baseUrl?: string;
}

/** The panel layout options for one machine and board. */
export function etchLayoutOptions(req: Pick<EtchSceneRequest, 'machine' | 'stock'>): LaserCutOptions {
  return {
    ...DEFAULT_LASER_OPTIONS,
    materialThickness: req.stock.thicknessMm / 1000,
    kerf: layoutKerf(req.machine, DEFAULT_LASER_OPTIONS.kerf),
    cornerRelief: defaultCornerRelief(req.machine),
    bitDiameter: ROUTER_BIT_MM / 1000,
    sheetWidth: req.stock.widthMm / 1000,
    sheetHeight: req.stock.depthMm / 1000,
  };
}

/**
 * Why there is nothing to send, and what to do instead. The panel layout only
 * takes flat panels; a solid goes to Etch as Contour's slices or Unfold's net.
 */
function panelRefusal(error: string | undefined): string {
  const why = error || 'Nothing here lays flat into panels to cut.';
  return /planar panels|box objects|lays flat/i.test(why)
    ? 'Nothing here is flat panels to cut. For a solid shape, use Contour (stacked slices) or Unfold (a net), and open the result in Etch from there.'
    : why;
}

/** Lays the scene out and returns the URL that opens it in Etch. Throws with a sentence when it cannot. */
export async function etchUrlForScene(req: EtchSceneRequest): Promise<string> {
  const client = new ExportWorkerClient();
  try {
    const result = await client.run('laser', req.scene, etchLayoutOptions(req));
    if (!result.success || !result.svg || !result.panels?.length) {
      throw new Error(panelRefusal(result.error));
    }
    const handoff = { svg: result.svg, name: req.name, thicknessMm: req.stock.thicknessMm };
    return await (req.baseUrl ? buildEtchHandoffUrl(handoff, req.baseUrl) : buildEtchHandoffUrl(handoff));
  } finally {
    client.dispose();
  }
}

/**
 * Opens the scene in Etch in a new tab, once the layout is done. A blank tab
 * opened first and closed on failure was a flash of nothing; the click's
 * permission to open a tab outlasts a layout (a few seconds in Chrome), and
 * a blocked one is said rather than lost.
 */
export async function openSceneInEtch(req: EtchSceneRequest): Promise<void> {
  const url = await etchUrlForScene(req);
  // Not 'noopener': with it window.open returns null whether or not the tab
  // opened, and a blocked one could not be told apart. Cut loose by hand.
  const tab = window.open(url, '_blank');
  if (!tab) throw new Error('The browser blocked the new tab: allow pop-ups for this site, then press Etch again.');
  tab.opener = null;
}
