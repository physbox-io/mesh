// ---------------------------------------------------------------------------
// The printer's settings as data, and the thinnest wall and skin they allow.
// Kept apart from printerSettings.ts (storage and the account) so the mold
// worker can read it without loading the API client.
// ---------------------------------------------------------------------------

export type PrinterProcess = 'fdm' | 'resin';

export interface PrinterSettings {
  process: PrinterProcess;
  /** FDM nozzle diameter, mm. */
  nozzleMm: number;
  /** Layer height, mm (FDM or resin). */
  layerMm: number;
  /** Resin printer's XY resolution (pixel pitch), mm. */
  xyMm: number;
}

export const DEFAULT_PRINTER: PrinterSettings = { process: 'fdm', nozzleMm: 0.4, layerMm: 0.2, xyMm: 0.05 };

/** The thinnest features the printer makes reliably, mm. */
export interface PrintLimits {
  /** Thinnest flat skin: liner over or under a face of the casting. */
  minSkinMm: number;
  /** Thinnest upright wall: liner between two faces side by side. */
  minWallMm: number;
  /**
   * How far a bridge reaches from its anchor with supports off, mm: a roof
   * held on two sides spans twice this. 0 where every overhang needs support.
   */
  bridgeMm: number;
}

/** FDM bridges with supports off: 5 mm from an anchor, a 10 mm span, inside what PLA, PETG and HIPS hold flat at stock bridge settings. */
const FDM_BRIDGE_MM = 5;

/**
 * FDM: one layer is the thinnest skin a slicer keeps, and one nozzle line the
 * thinnest wall. Resin: two layers and two pixels, since a single exposure of
 * either is a film that peels with the support or the vat, and no bridges:
 * a resin overhang prints hanging and needs support.
 */
export function printLimits(p: PrinterSettings): PrintLimits {
  return p.process === 'resin'
    ? { minSkinMm: 2 * p.layerMm, minWallMm: 2 * p.xyMm, bridgeMm: 0 }
    : { minSkinMm: p.layerMm, minWallMm: p.nozzleMm, bridgeMm: FDM_BRIDGE_MM };
}
