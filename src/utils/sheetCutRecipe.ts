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

/** Depth a router takes per pass: no more than its own diameter. In mm. */
export function routerStepdownMm(thicknessMm: number, bitDiameterMm: number): number {
  return Math.min(thicknessMm, 3.0, bitDiameterMm);
}

/** The usual gap kept round every part on a sheet, in metres. */
export const SHEET_MARGIN = 0.008;

/**
 * The gap for this machine, in metres. A router's slots are a bit wide, so two
 * neighbours need that much and a little more to stay apart.
 */
export function layoutMargin(machine: SheetMachine, bitDiameter: number): number {
  return machine === 'cnc' ? Math.max(SHEET_MARGIN, bitDiameter + 0.001) : SHEET_MARGIN;
}

/** Whether a sheet job may start: its program is good and every part is on its sheet. */
export function canStartSheetJob(
  layout: { offSheet?: string[] } | null,
  gcode: { success: boolean } | null
): boolean {
  return !!gcode?.success && !layout?.offSheet?.length;
}

/** The S-values the laser fields hold, on one controller's scale. */
export interface LaserPowers {
  max: number;
  cut: number;
  engrave: number;
}

/**
 * The same powers on another controller's `$30` scale. It is a machine setting,
 * not a power change, so the percentages dialled in survive the switch.
 */
export function retargetLaserPowers(powers: LaserPowers, nextMax: number): LaserPowers {
  const max = Math.max(1, nextMax);
  const scaled = (s: number) => Math.max(0, Math.min(max, Math.round((s / Math.max(1, powers.max)) * max)));
  return { max, cut: scaled(powers.cut), engrave: scaled(powers.engrave) };
}

/** The `$30` a laser job should follow, or null while there is none or the operator chose. */
export function machineLaserMax(
  machine: SheetMachine,
  state: { connected: boolean; motion: { spindle: { max: number } | null } },
  operatorChose: boolean
): number | null {
  if (machine !== 'laser' || operatorChose || !state.connected) return null;
  return state.motion.spindle?.max ?? null;
}
