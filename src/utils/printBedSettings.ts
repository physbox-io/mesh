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

export const CNC_BED_STORAGE_KEY = 'mesh_cnc_bed_mm';

export interface CncBed {
  /** X travel of the CNC router bed, mm. */
  widthMm: number;
  /** Y travel of the CNC router bed, mm. */
  depthMm: number;
  /** Z clearance / travel of the CNC router, mm. */
  heightMm: number;
}

/** Standard 3030 / 3020 desktop CNC envelope. */
export const DEFAULT_CNC_BED: CncBed = { widthMm: 300, depthMm: 300, heightMm: 60 };

export const MIN_CNC_BED_MM = 20;
export const MAX_CNC_BED_MM = 3000;

const clampCncAxis = (value: unknown, fallback: number): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(MAX_CNC_BED_MM, Math.max(MIN_CNC_BED_MM, n));
};

export function clampCncBed(bed: Partial<CncBed> | null | undefined): CncBed {
  return {
    widthMm: clampCncAxis(bed?.widthMm, DEFAULT_CNC_BED.widthMm),
    depthMm: clampCncAxis(bed?.depthMm, DEFAULT_CNC_BED.depthMm),
    heightMm: clampCncAxis(bed?.heightMm, DEFAULT_CNC_BED.heightMm),
  };
}

export function loadCncBed(): CncBed {
  try {
    const raw = localStorage.getItem(CNC_BED_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CNC_BED };
    return clampCncBed(JSON.parse(raw) as Partial<CncBed>);
  } catch {
    return { ...DEFAULT_CNC_BED };
  }
}

export function saveCncBed(bed: CncBed): CncBed {
  const clamped = clampCncBed(bed);
  try {
    localStorage.setItem(CNC_BED_STORAGE_KEY, JSON.stringify(clamped));
  } catch {
    // Non-fatal
  }
  return clamped;
}

