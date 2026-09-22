// ---------------------------------------------------------------------------
// Filaments
// ---------------------------------------------------------------------------
//
// Kept apart from `feedsAndSpeeds.ts` on purpose. That file's materials each
// carry a surface speed and a chip load, because everything it exists to work
// out is what happens when a cutting edge is dragged through stock. A filament
// has neither. What it has is a temperature, a bed, and a set of habits — and
// none of that is arithmetic this app performs, because this app does not drive
// printers. See `FdmNotice` for why.
//
// So this is a short list of names, with the one line about each that is worth
// knowing while choosing what to model in. The printing itself happens in a
// slicer, from the 3MF or STL exported here.

export type FilamentId = 'pla' | 'petg' | 'abs' | 'asa' | 'tpu';

export interface FilamentSpec {
  id: FilamentId;
  label: string;
  /** One line, written for someone deciding what to print the thing in. */
  note: string;
  /**
   * How far past vertical this will hold an unsupported face, in degrees.
   *
   * 45° is the figure every slicer ships as its support threshold, and it is a
   * geometric argument rather than a material one: at 45° each layer still
   * lands half on the one below it. What the material changes is how far past
   * that it gets away with, which comes down to how fast the extrusion freezes
   * — PLA sets almost instantly under a fan and will hold a good deal more,
   * while TPU is still soft when the next layer lands on it.
   *
   * These are the thresholds in common slicer profiles rather than anything
   * measured here. Treat them as the point past which to expect support, not as
   * a cliff.
   */
  maxOverhangDeg: number;
  /**
   * Thinnest wall worth drawing, in mm, on the usual 0.4 mm nozzle.
   *
   * A 0.4 mm nozzle lays a bead about 0.42 mm wide, so two perimeters is 0.8 mm
   * and that is the floor for anything that has to be a wall rather than a
   * film. The stiffer filaments hold that; the ones that print less crisply, or
   * are too floppy to handle at that thickness, want more.
   */
  minWallMm: number;
  /** Whether it will span a gap with nothing underneath it. */
  bridges: boolean;
  /**
   * Whether a large flat footprint lifts off the bed as it cools.
   *
   * The styrenics shrink as they go from melt to solid, and on a wide flat part
   * that shrinkage pulls the corners up off the plate. It is the reason those
   * filaments want an enclosure and the reason a big flat ABS plate is a bad
   * idea rather than merely a slow one.
   */
  warpsOnLargeFlats: boolean;
}

export const FILAMENTS: FilamentSpec[] = [
  {
    id: 'pla',
    maxOverhangDeg: 55,
    minWallMm: 0.8,
    bridges: true,
    warpsOnLargeFlats: false,
    label: 'PLA',
    note: 'Stiff, dimensionally accurate and forgiving to print. Softens in a hot car, so it is the wrong choice for anything that lives outdoors or holds a load warm.',
  },
  {
    id: 'petg',
    maxOverhangDeg: 45,
    minWallMm: 0.9,
    bridges: true,
    warpsOnLargeFlats: false,
    label: 'PETG',
    note: 'Tougher than PLA and happy outdoors. Stringier to print and slightly less crisp on fine detail, which shows on small features rather than large ones.',
  },
  {
    id: 'abs',
    maxOverhangDeg: 45,
    minWallMm: 1.0,
    bridges: true,
    warpsOnLargeFlats: true,
    label: 'ABS',
    note: 'Heat-resistant and machinable after the fact, but it shrinks as it cools — large flat parts want an enclosure or they lift off the bed at the corners.',
  },
  {
    id: 'asa',
    maxOverhangDeg: 45,
    minWallMm: 1.0,
    bridges: true,
    warpsOnLargeFlats: true,
    label: 'ASA',
    note: 'ABS that survives sunlight. The usual answer for parts that live outside and would otherwise go chalky and brittle within a season.',
  },
  {
    id: 'tpu',
    maxOverhangDeg: 30,
    minWallMm: 1.2,
    bridges: false,
    warpsOnLargeFlats: false,
    label: 'TPU',
    note: 'Rubber, near enough — a hundred times less stiff than the rest of this list rather than the factor of two that separates them from each other. That is what makes it the filament for a casting mold: it peels off the casting instead of gripping it. Slow to print and it will not bridge.',
  },
];

export const DEFAULT_FILAMENT: FilamentId = 'pla';

export function filamentSpec(id: FilamentId): FilamentSpec {
  return FILAMENTS.find((f) => f.id === id) ?? FILAMENTS[0];
}
