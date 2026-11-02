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

/** Lays the scene out and returns the URL that opens it in Etch. Throws with a sentence when it cannot. */
export async function etchUrlForScene(req: EtchSceneRequest): Promise<string> {
  const client = new ExportWorkerClient();
  try {
    const result = await client.run('laser', req.scene, etchLayoutOptions(req));
    if (!result.success || !result.svg || !result.panels?.length) {
      throw new Error(result.error || 'Nothing here lays flat into panels to cut.');
    }
    const handoff = { svg: result.svg, name: req.name, thicknessMm: req.stock.thicknessMm };
    return await (req.baseUrl ? buildEtchHandoffUrl(handoff, req.baseUrl) : buildEtchHandoffUrl(handoff));
  } finally {
    client.dispose();
  }
}

/**
 * Opens the scene in Etch in a new tab. The tab is opened before the layout
 * runs, while the click still counts as one, since a popup blocker refuses a
 * window opened after an await; it is closed again if the layout fails.
 */
export async function openSceneInEtch(req: EtchSceneRequest): Promise<void> {
  const tab = window.open('about:blank', '_blank');
  try {
    const url = await etchUrlForScene(req);
    if (tab) {
      tab.opener = null;
      tab.location.href = url;
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (e) {
    tab?.close();
    throw e;
  }
}
