// ---------------------------------------------------------------------------
// How big the printer's bed is, in millimetres.
//
// The print lens used to have no idea, and said so (dfm.ts, stockFindings): a
// part could be any size at all and nothing in the app would tell you it was
// never going to fit. Split for print needs the number to work at all, and the
// DFM overlay can use it to say so before anyone asks.
//
// Same shape and the same reasons as utils/stockSettings.ts: it is a fact about
// the workshop, not about one export, so it lives in the store beside the stock
// and outlives the tab.
// ---------------------------------------------------------------------------

export const PRINT_BED_STORAGE_KEY = 'mesh_print_bed_mm';

export interface PrintBed {
  /** X extent of the build plate, mm. */
  widthMm: number;
  /** Y extent of the build plate, mm. */
  depthMm: number;
  /** How tall a part the gantry clears, mm. */
  heightMm: number;
}

/** A Bambu/Prusa-class bed. Smaller printers are the ones that need splitting. */
export const DEFAULT_PRINT_BED: PrintBed = { widthMm: 256, depthMm: 256, heightMm: 256 };

export const MIN_PRINT_BED_MM = 20;
export const MAX_PRINT_BED_MM = 2000;

const clampAxis = (value: unknown, fallback: number): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(MAX_PRINT_BED_MM, Math.max(MIN_PRINT_BED_MM, n));
};

/** Repairs a partial or garbage bed record into one every consumer can use. */
export function clampPrintBed(bed: Partial<PrintBed> | null | undefined): PrintBed {
  return {
    widthMm: clampAxis(bed?.widthMm, DEFAULT_PRINT_BED.widthMm),
    depthMm: clampAxis(bed?.depthMm, DEFAULT_PRINT_BED.depthMm),
    heightMm: clampAxis(bed?.heightMm, DEFAULT_PRINT_BED.heightMm),
  };
}

export function loadPrintBed(): PrintBed {
  try {
    const raw = localStorage.getItem(PRINT_BED_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PRINT_BED };
    return clampPrintBed(JSON.parse(raw) as Partial<PrintBed>);
  } catch {
    // Private mode, a sandbox, or a half-written entry: none worth a broken app.
    return { ...DEFAULT_PRINT_BED };
  }
}

export function savePrintBed(bed: PrintBed): PrintBed {
  const clamped = clampPrintBed(bed);
  try {
    localStorage.setItem(PRINT_BED_STORAGE_KEY, JSON.stringify(clamped));
  } catch {
    // Non-fatal: the setting just won't persist across reloads.
  }
  return clamped;
}
