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

export type FilamentId = 'pla' | 'petg' | 'abs' | 'asa';

export interface FilamentSpec {
  id: FilamentId;
  label: string;
  /** One line, written for someone deciding what to print the thing in. */
  note: string;
}

export const FILAMENTS: FilamentSpec[] = [
  {
    id: 'pla',
    label: 'PLA',
    note: 'Stiff, dimensionally accurate and forgiving to print. Softens in a hot car, so it is the wrong choice for anything that lives outdoors or holds a load warm.',
  },
  {
    id: 'petg',
    label: 'PETG',
    note: 'Tougher than PLA and happy outdoors. Stringier to print and slightly less crisp on fine detail, which shows on small features rather than large ones.',
  },
  {
    id: 'abs',
    label: 'ABS',
    note: 'Heat-resistant and machinable after the fact, but it shrinks as it cools — large flat parts want an enclosure or they lift off the bed at the corners.',
  },
  {
    id: 'asa',
    label: 'ASA',
    note: 'ABS that survives sunlight. The usual answer for parts that live outside and would otherwise go chalky and brittle within a season.',
  },
];

export const DEFAULT_FILAMENT: FilamentId = 'pla';

export function filamentSpec(id: FilamentId): FilamentSpec {
  return FILAMENTS.find((f) => f.id === id) ?? FILAMENTS[0];
}
