// ---------------------------------------------------------------------------
// What a mechanism builder changed from what it was asked for.
//
// Every builder in mechanismParts.ts holds its numbers to what it can make: a
// leadscrew is at least 40 mm long, its lead at least 1 mm, a gear has six
// teeth or more. It did so silently, so a 0.5 mm lead came back as a 1 mm one
// with ok:true, and the mechanism ran at twice the travel the caller worked
// out. Each family hands over the figures it actually used, and the reply
// lists every one that differs from the request. Pure.
// ---------------------------------------------------------------------------

export interface MechanismAdjustment {
  /** The request's field, as the caller wrote it (nested as `driver.teeth`). */
  field: string;
  requested: number;
  used: number;
}

/**
 * Each numeric field in `requested` that `used` holds a different figure for.
 * Fields the builder does not report are left out: no claim is made for them.
 */
export function adjustedFields(
  requested: Record<string, unknown> | undefined,
  used: Record<string, number | undefined>,
  prefix = '',
): MechanismAdjustment[] {
  if (!requested || typeof requested !== 'object') return [];
  const out: MechanismAdjustment[] = [];
  for (const [field, u] of Object.entries(used)) {
    const r = requested[field];
    if (typeof r !== 'number' || !Number.isFinite(r) || u === undefined) continue;
    if (Math.abs(r - u) > 1e-9 * Math.max(1, Math.abs(r))) out.push({ field: `${prefix}${field}`, requested: r, used: u });
  }
  return out;
}

/** One sentence per adjustment, for the reply's warnings. */
export function adjustmentWarnings(family: string, adjustments: MechanismAdjustment[]): string[] {
  return adjustments.map((a) =>
    `${a.field} ${a.requested} was changed to ${a.used}: that is the nearest this ${family} builder makes. Work out the mechanism from ${a.used}, or change the request.`);
}
