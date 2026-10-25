// ---------------------------------------------------------------------------
// Hardware sizes
//
// One set of tables for both halves of a fastening: the cut a part is given to
// take a bolt or a bearing (utils/hardwareCuts.ts), and the bolt or bearing
// itself (utils/hardwareParts.ts). Kept apart from either so the seat and the
// thing seated in it are always read from the same number.
// ---------------------------------------------------------------------------

export const BOLTS = ['M2', 'M2.5', 'M3', 'M4', 'M5', 'M6', 'M8', 'M10', 'M12', 'M14', 'M16', 'M20', 'M24'] as const;

/** ISO 4032 hex nuts: [width across flats, height], mm. */
export const HEX_NUTS: Record<string, [number, number]> = {
  M2: [4, 1.6], 'M2.5': [5, 2], M3: [5.5, 2.4], M4: [7, 3.2], M5: [8, 4.7], M6: [10, 5.2], M8: [13, 6.8],
  M10: [16, 8.4], M12: [18, 10.8], M14: [21, 12.8], M16: [24, 14.8], M20: [30, 18], M24: [36, 21.5],
};

/** ISO 273 medium clearance holes, mm. */
export const CLEARANCE_HOLES: Record<string, number> = {
  M2: 2.4, 'M2.5': 2.9, M3: 3.4, M4: 4.5, M5: 5.5, M6: 6.6, M8: 9, M10: 11, M12: 13.5, M14: 15.5, M16: 17.5, M20: 22, M24: 26,
};

/** Counterbores for ISO 4762 socket head cap screws (DIN 974-1): [diameter, depth], mm — the head's height and a little. */
export const COUNTERBORES: Record<string, [number, number]> = {
  M2: [4.3, 2.4], 'M2.5': [5, 2.9], M3: [6, 3.4], M4: [8, 4.4], M5: [10, 5.4], M6: [11, 6.4], M8: [15, 8.6],
  M10: [18, 10.6], M12: [20, 12.6], M14: [24, 14.6], M16: [26, 16.6], M20: [33, 20.6], M24: [40, 24.6],
};

/** ISO 4762 socket head cap screw heads: [head diameter, head height, hex key across flats], mm. */
export const CAP_SCREW_HEADS: Record<string, [number, number, number]> = {
  M2: [3.8, 2, 1.5], 'M2.5': [4.5, 2.5, 2], M3: [5.5, 3, 2.5], M4: [7, 4, 3], M5: [8.5, 5, 4], M6: [10, 6, 5],
  M8: [13, 8, 6], M10: [16, 10, 8], M12: [18, 12, 10], M14: [21, 14, 12], M16: [24, 16, 14], M20: [30, 20, 17],
  M24: [36, 24, 19],
};

/** The lengths cap screws are sold in, under the head, mm (ISO 4762 preferred). */
export const SCREW_LENGTHS = [3, 4, 5, 6, 8, 10, 12, 16, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 80, 90, 100, 110, 120, 140, 160, 180, 200] as const;

/** ISO 7089 plain washers: [inside diameter, outside diameter, thickness], mm. */
export const WASHERS: Record<string, [number, number, number]> = {
  M2: [2.2, 5, 0.3], 'M2.5': [2.7, 6, 0.5], M3: [3.2, 7, 0.5], M4: [4.3, 9, 0.8], M5: [5.3, 10, 1], M6: [6.4, 12, 1.6],
  M8: [8.4, 16, 1.6], M10: [10.5, 20, 2], M12: [13, 24, 2.5], M14: [15, 28, 2.5], M16: [17, 30, 3], M20: [21, 37, 3],
  M24: [25, 44, 4],
};

/** Heat-set inserts, the common long ones: [hole diameter, hole depth, boss diameter], mm. */
export const INSERTS: Record<string, [number, number, number]> = {
  M2: [3.2, 4, 6], 'M2.5': [3.6, 5.7, 7], M3: [4.2, 5.7, 8], M4: [5.6, 8.1, 10], M5: [6.8, 9.5, 12],
  M6: [8, 12.7, 14], M8: [9.8, 12.5, 18],
};

/** Ball bearings: [outer diameter, bore, width], mm. */
export const BEARINGS: Record<string, [number, number, number]> = {
  '623': [10, 3, 4], '624': [13, 4, 5], '625': [16, 5, 5], '626': [19, 6, 6], '688': [16, 8, 5],
  '608': [22, 8, 7], '6000': [26, 10, 8], '6001': [28, 12, 8],
};

/** Ground shafts and dowel pins, by diameter in mm. */
export const SHAFTS = ['3', '4', '5', '6', '8', '10', '12'] as const;

/** The standard length nearest to `mm` that is not longer than it, or the shortest there is. */
export function screwLengthAtMost(mm: number): number {
  let best: number = SCREW_LENGTHS[0];
  for (const l of SCREW_LENGTHS) if (l <= mm + 1e-6) best = l;
  return best;
}
