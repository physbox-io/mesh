// ---------------------------------------------------------------------------
// What a run is remembered as
//
// The machine layer is handed a string of G-code and cannot reconstruct any of
// it: what was on the bed, which bit was in the collet, how hard it was cut.
// Each export dialog knows, and passes this to `runJob`, which posts it with
// the first telemetry frame — the one the archive opens a run from.
//
// `material` is a plain string on purpose. The run archive has no schema across
// the apps — each writes what it knows — and every reader of it, the job
// history list and `/api/runs/summary` included, looks for that one key by
// name.
// ---------------------------------------------------------------------------

export interface RunSettingsInput {
  /** What is on the bed, as a person would say it: "Hardwood (oak, maple…)". */
  material: string;
  machine: 'laser' | 'cnc';
  stockThicknessMm?: number;
  /** The bit, described the way the dialog describes it to the operator. */
  tool?: string;
  /** The second bit on a job that changes tools mid-program. */
  secondTool?: string;
  spindleRpm?: number;
  cutFeedrate?: number;
  plungeRate?: number;
  /** Beam power as a GRBL S-value, and how many times it goes round. */
  laserPower?: number;
  passes?: number;
  depthMm?: number;
}

/**
 * The settings blob for one run, with the fields this job has no answer for
 * left out rather than recorded as null — a laser job has no spindle speed, and
 * a row that claims one is worse than a row that is quiet about it.
 */
export function runSettings(input: RunSettingsInput): Record<string, unknown> {
  const out: Record<string, unknown> = {
    material: input.material,
    machine: input.machine,
  };
  const optional: Array<[string, number | string | undefined]> = [
    ['stockThickness', input.stockThicknessMm],
    ['tool', input.tool],
    ['secondTool', input.secondTool],
    ['spindleRpm', input.spindleRpm],
    ['cutFeedrate', input.cutFeedrate],
    ['plungeRate', input.plungeRate],
    ['power', input.laserPower],
    ['passes', input.passes],
    ['depthMm', input.depthMm],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
