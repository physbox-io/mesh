/** Millimetres kept in the browser for the zeroing tools, one figure wherever it is asked for. */

const PLATE_KEY = 'meshTouchPlateMm';
const DEFAULT_PLATE_MM = 12;

export function readStoredMm(key: string, fallback: number): number {
  try {
    const v = parseFloat(localStorage.getItem(key) ?? '');
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredMm(key: string, mm: number): number {
  try {
    localStorage.setItem(key, String(mm));
  } catch {
    // Private mode: the value holds for this session only.
  }
  return mm;
}

export const readTouchPlateMm = (): number => readStoredMm(PLATE_KEY, DEFAULT_PLATE_MM);
export const writeTouchPlateMm = (mm: number): number => writeStoredMm(PLATE_KEY, mm);
