import { syncCloudParameters } from './apiClient';

// ---------------------------------------------------------------------------
// The printer on the bench: how it lays plastic or resin down, and from that,
// the thinnest wall and the thinnest skin a printed part can have.
//
// Molds read it. A liner between two parts of a casting is only as thin as the
// gap between them, and below a layer it either vanishes in the slicer or
// prints as one loose layer that the nozzle drags off the bed. Kept in this
// browser and mirrored to the account, like the bed size.
// ---------------------------------------------------------------------------

/** localStorage key, and the account parameter of the same name. */
export const PRINTER_STORAGE_KEY = 'mesh_printer';

export { DEFAULT_PRINTER, printLimits, type PrinterProcess, type PrinterSettings, type PrintLimits } from './printLimits';
import { DEFAULT_PRINTER, type PrinterSettings } from './printLimits';

export const NOZZLE_CHOICES_MM = [0.2, 0.4, 0.6, 0.8] as const;
export const MIN_LAYER_MM = 0.01;
export const MAX_LAYER_MM = 1;
export const MIN_XY_MM = 0.01;
export const MAX_XY_MM = 0.5;

const clampNum = (value: unknown, lo: number, hi: number, fallback: number): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
};

/** Repairs a partial or garbage record into one every consumer can use. */
export function clampPrinter(p: Partial<PrinterSettings> | null | undefined): PrinterSettings {
  return {
    process: p?.process === 'resin' ? 'resin' : 'fdm',
    nozzleMm: clampNum(p?.nozzleMm, 0.1, 2, DEFAULT_PRINTER.nozzleMm),
    layerMm: clampNum(p?.layerMm, MIN_LAYER_MM, MAX_LAYER_MM, DEFAULT_PRINTER.layerMm),
    xyMm: clampNum(p?.xyMm, MIN_XY_MM, MAX_XY_MM, DEFAULT_PRINTER.xyMm),
  };
}

export function loadPrinter(): PrinterSettings {
  try {
    const raw = localStorage.getItem(PRINTER_STORAGE_KEY);
    return raw ? clampPrinter(JSON.parse(raw) as Partial<PrinterSettings>) : { ...DEFAULT_PRINTER };
  } catch {
    return { ...DEFAULT_PRINTER };
  }
}

export function savePrinter(p: PrinterSettings): PrinterSettings {
  const clamped = clampPrinter(p);
  try {
    localStorage.setItem(PRINTER_STORAGE_KEY, JSON.stringify(clamped));
  } catch {
    // Non-fatal: the setting just won't persist across reloads.
  }
  void syncCloudParameters('physics', { [PRINTER_STORAGE_KEY]: clamped });
  return clamped;
}

