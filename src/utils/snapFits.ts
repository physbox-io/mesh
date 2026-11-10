// ---------------------------------------------------------------------------
// Snap fits for printed parts
//
// A cantilever hook stood on one part and a window cut in the other for its
// lip to click into: the lid clip, the battery-door latch, the enclosure that
// closes without screws.
//
// THE BEAM IS AS LONG AS IT HAS TO BE NOT TO BREAK. A cantilever bent by the
// lip's depth y at its tip strains its root by 1.5 t y / L^2 (rectangular
// section, constant thickness). Printed PLA takes about 2% before it whitens
// and cracks, so each size's length is the one that keeps it there; PETG and
// nylon take more and go further. The lip has a 30 degree lead-in so it rides
// over the edge going in, and a square catch face so it holds coming out.
// ---------------------------------------------------------------------------

export interface SnapSize {
  /** How far the lip stands out from the beam: the deflection it snaps over, mm. */
  depth: number;
  /** Beam thickness in the direction it bends, mm. */
  thickness: number;
  /** Beam and lip width across the face, mm. */
  width: number;
}

/** Root strain a printed PLA beam takes repeatedly without cracking. */
export const PLA_SAFE_STRAIN = 0.02;

export const SNAP_SIZES: Record<string, SnapSize> = {
  S: { depth: 0.8, thickness: 1.2, width: 4 },
  M: { depth: 1.2, thickness: 1.6, width: 6 },
  L: { depth: 1.8, thickness: 2.0, width: 8 },
};

/** Beam length for a size: the shortest that keeps the root under the safe strain, mm. */
export function snapBeamLength(s: SnapSize, strain = PLA_SAFE_STRAIN): number {
  return Math.sqrt((1.5 * s.thickness * s.depth) / strain);
}

/** How tall the lip is along the beam: a 30 degree ramp over 70% of it, a flat land on the rest, mm. */
export function snapLipHeight(s: SnapSize): number {
  return s.depth / Math.tan((30 * Math.PI) / 180) / 0.7;
}

/**
 * The hook's side profile, [x, z] in mm: the beam from the surface up, its
 * outer face at x = 0, and the lip out along +x at the top. Anticlockwise.
 */
export function snapHookProfileMm(s: SnapSize): number[][] {
  const L = snapBeamLength(s);
  const h = snapLipHeight(s);
  const land = h * 0.3;
  const top = L + h;
  return [
    [-s.thickness, 0],
    [0, 0],
    [0, L],
    [s.depth, L],
    [s.depth, L + land],
    [0, top],
    [-s.thickness, top],
  ];
}

/** The window the lip clicks into, mm: across the face, then along the beam. */
export function snapWindowMm(s: SnapSize, fitMm: number): [number, number] {
  return [s.width + fitMm, snapLipHeight(s) + fitMm];
}
