// ---------------------------------------------------------------------------
// What is clamped on the bed, in millimetres.
//
// Stock used to be three numbers typed into whichever export modal was open,
// reset to 150 x 150 x 18 on every mount by `useCarveTooling`. That made two
// things awkward and one thing wrong: you retyped the same board on every
// export, a relief and a solid cut from the same session could disagree about
// what they were being cut from, and nothing in the app could answer "how big
// is the material" -- which is exactly what a pattern generator has to know to
// size what it makes.
//
// So it sits beside `machineTarget` and `material` in the store, which the
// comment there already explains: these are properties of the workshop rather
// than of one operation. Etch reached the same conclusion and put the same
// three fields in its own bottom bar.
// ---------------------------------------------------------------------------

export const STOCK_STORAGE_KEY = 'mesh_stock_mm';

export interface StockSize {
  /** X extent in mm. */
  widthMm: number;
  /** Y extent in mm. */
  depthMm: number;
  /** How thick the board is, in mm. */
  thicknessMm: number;
}

/**
 * The same 150 x 150 x 18 the relief exporter has always defaulted to, so a
 * session that never touches the bottom bar behaves exactly as it did before.
 */
export const DEFAULT_STOCK: StockSize = { widthMm: 150, depthMm: 150, thicknessMm: 18 };

/** Bounds a hobby machine can actually hold, and a field can sensibly step over. */
export const MIN_STOCK_MM = 1;
export const MAX_STOCK_PLAN_MM = 3000;
export const MAX_STOCK_THICKNESS_MM = 300;

const clampAxis = (value: unknown, fallback: number, max: number): number => {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(MIN_STOCK_MM, n));
};

/** Repairs a partial or garbage stock record into one every consumer can use. */
export function clampStock(stock: Partial<StockSize> | null | undefined): StockSize {
  return {
    widthMm: clampAxis(stock?.widthMm, DEFAULT_STOCK.widthMm, MAX_STOCK_PLAN_MM),
    depthMm: clampAxis(stock?.depthMm, DEFAULT_STOCK.depthMm, MAX_STOCK_PLAN_MM),
    thicknessMm: clampAxis(stock?.thicknessMm, DEFAULT_STOCK.thicknessMm, MAX_STOCK_THICKNESS_MM),
  };
}

/** Reads the bench's stock, falling back to the default on absent/garbage values. */
export function loadStock(): StockSize {
  try {
    const raw = localStorage.getItem(STOCK_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_STOCK };
    return clampStock(JSON.parse(raw) as Partial<StockSize>);
  } catch {
    // localStorage throws in private-mode / sandboxed contexts, and a
    // half-written entry throws in JSON.parse. Neither is worth a broken app.
    return { ...DEFAULT_STOCK };
  }
}

export function saveStock(stock: StockSize): StockSize {
  const clamped = clampStock(stock);
  try {
    localStorage.setItem(STOCK_STORAGE_KEY, JSON.stringify(clamped));
  } catch {
    // Non-fatal: the setting just won't persist across reloads.
  }
  return clamped;
}
