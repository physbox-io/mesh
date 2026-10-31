// ---------------------------------------------------------------------------
// How a sheet job (laser cut, contour slice) is laid out for the machine that
// cuts it: shared by the export dialogs and the MCP simulation, so a router
// simulation is of the layout the router dialog hands over
// ---------------------------------------------------------------------------

export type SheetMachine = 'laser' | 'cnc';

/**
 * The kerf the layout is sent. Only a laser is: a router's G-code stands the
 * bit off by its own radius, and a kerf on top would loosen every joint, and
 * shrink every dowel hole, a second time. In whatever unit `kerf` is in.
 */
export function layoutKerf(machine: SheetMachine, kerf: number): number {
  return machine === 'laser' ? kerf : 0;
}

/**
 * Inside corners a router cannot cut square get a dogbone unless asked
 * otherwise; a beam has no radius, so a laser's are left as drawn.
 */
export function defaultCornerRelief(machine: SheetMachine): 'none' | 'dogbone' {
  return machine === 'cnc' ? 'dogbone' : 'none';
}
