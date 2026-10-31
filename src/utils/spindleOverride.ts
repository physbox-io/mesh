/**
 * The spindle's real top speed, when the controller's `$30` is not it.
 *
 * Every feed and speed in the app is capped at the spindle range read off the
 * controller, because on a PWM spindle GRBL scales `S` across `$31`..`$30` and
 * clamps anything past it. But on a router with a hand dial `S` drives nothing,
 * and `$30` is whatever the firmware shipped with — 1000 and 10000 are both
 * common. A trim router that dials to 30,000 was then planned at 10,000, which
 * cut every recommended feed to a third and tripled the run time.
 *
 * So the operator can say what the spindle actually does. It is kept in this
 * browser and mirrored to the account, like the other preferences that belong
 * to the workshop rather than to a scene.
 *
 * Kept per controller, not per account. It used to be one number for the
 * whole account, so a 24,000 set for a hand-dial router was also the ceiling
 * on the next machine connected — a `$30=10000` PWM spindle, which GRBL then
 * clamped to 10,000 while every feed had been planned for 24,000: 2.4 times
 * the chip load the bit was meant to take. Each value is filed under the
 * machine it was set for (see `machineKey` in the serial manager), and one
 * set with no machine identified applies only while none is.
 */

import type { MotionProfile } from './motionProfile';

/** localStorage key, and the account parameter of the same name. */
export const SPINDLE_MAX_OVERRIDE_KEY = 'physics_spindle_max_override';

/** Below this an RPM is a typo, not a spindle. */
const MIN_OVERRIDE_RPM = 1000;
const MAX_OVERRIDE_RPM = 100_000;

/** The unkeyed slot: an override set while no controller had identified itself. */
const UNKEYED = '';

/**
 * The lowest `$30` read as a spindle's top speed in RPM rather than as a PWM
 * scale.
 *
 * GRBL scales `S` linearly between `$31` and `$30`, so on a router whose `$30`
 * is its real top speed, `S` is RPM and nothing above `$30` exists. But a
 * controller left at the factory `$30=1000` — or 255, or 100, because the board
 * was built for a diode — is saying "full PWM is S1000", not "this spindle turns
 * at 1000 RPM". Read as a ceiling, that refused every job on a hand-dial router
 * whose owner had never needed to touch `$30`, since `S` drives nothing there.
 * No router spindle tops out below a few thousand RPM and no PWM scale anyone
 * ships is that high, so the line between the two readings sits here — the same
 * line, for the same reason, as Etch's `MIN_RPM_CEILING_FROM_30`.
 */
export const MIN_RPM_CEILING_FROM_30 = 3000;

const validRpm = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= MIN_OVERRIDE_RPM && v <= MAX_OVERRIDE_RPM;

/**
 * Every override this browser knows, by machine.
 *
 * Stored as JSON. A bare number is what builds before the per-machine change
 * wrote, and reads as the unkeyed slot: it was set without saying for which
 * machine, so it is not claimed by whichever one happens to connect first.
 */
function readOverrides(): Record<string, number> {
  try {
    const raw = localStorage.getItem(SPINDLE_MAX_OVERRIDE_KEY);
    if (!raw) return {};
    const legacy = Number(raw);
    if (Number.isFinite(legacy)) return validRpm(legacy) ? { [UNKEYED]: legacy } : {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) if (validRpm(v)) out[k] = v;
    return out;
  } catch {
    // No localStorage (a test, a locked-down profile), or a value nobody here
    // wrote: there is no override.
    return {};
  }
}

/**
 * The override in force for a machine, or null to use whatever the controller
 * reports.
 *
 * `machineKey` is the connected controller's identity, or null when none is
 * known — nothing connected, or one that would not say what it is. A known
 * machine gets only its own value, never the unkeyed one or another machine's.
 */
export function readSpindleMaxOverride(machineKey: string | null = null): number | null {
  return readOverrides()[machineKey ?? UNKEYED] ?? null;
}

/**
 * Sets the override for a machine (null key: the unkeyed slot), or clears it
 * with a null rpm, here and in the account.
 *
 * Cleared is written as an empty string rather than deleted, so the account
 * holds the clearing too — otherwise the next sign-in would pull the old value
 * straight back down.
 */
export function writeSpindleMaxOverride(rpm: number | null, machineKey: string | null = null): void {
  const all = readOverrides();
  const slot = machineKey ?? UNKEYED;
  if (rpm === null) delete all[slot];
  else all[slot] = Math.round(Math.min(MAX_OVERRIDE_RPM, Math.max(MIN_OVERRIDE_RPM, rpm)));
  const value = Object.keys(all).length > 0 ? JSON.stringify(all) : '';
  try {
    if (value) localStorage.setItem(SPINDLE_MAX_OVERRIDE_KEY, value);
    else localStorage.removeItem(SPINDLE_MAX_OVERRIDE_KEY);
  } catch {
    // The account copy below still carries it.
  }
  void import('./apiClient').then(({ syncCloudParameters }) => {
    void syncCloudParameters('physics', { [SPINDLE_MAX_OVERRIDE_KEY]: value });
  });
}

/** A motion profile with the operator's spindle top speed in place of `$30`. */
export function withSpindleOverride(motion: MotionProfile, override = readSpindleMaxOverride()): MotionProfile {
  if (override === null) return motion;
  const min = Math.min(motion.spindle?.min ?? 0, override);
  return { ...motion, spindle: { min, max: override } };
}

/**
 * The highest `S` a program asks for, or null when it never sets one.
 *
 * Comments are stripped first: a header that says "(S12000 for oak)" is not a
 * spindle command.
 */
export function programMaxSpindle(lines: readonly string[]): number | null {
  let max: number | null = null;
  for (const raw of lines) {
    const code = raw.replace(/\([^)]*\)/g, '').replace(/;.*$/, '');
    const words = code.matchAll(/S\s*([0-9]*\.?[0-9]+)/gi);
    for (const m of words) {
      const s = Number(m[1]);
      if (Number.isFinite(s) && (max === null || s > max)) max = s;
    }
  }
  return max;
}

/**
 * Why a program cannot be run on this controller as exported, or null.
 *
 * GRBL clamps an `S` above `$30` to `$30`, so a program planned for a faster
 * spindle runs every feed it was given at a slower one — the chip load goes up
 * by the ratio, which is a broken small bit. Only when `S` is what sets the
 * speed: a laser reads `S` as power, and a machine with an override has said
 * its spindle ignores `S` (a hand dial), so neither is refused. Nor is a
 * `$30` below `MIN_RPM_CEILING_FROM_30`, which is a PWM scale rather than RPM.
 */
export function spindleCeilingRefusal(
  lines: readonly string[],
  controller: { maxRpm: number | null | undefined; laser: boolean; overridden: boolean }
): string | null {
  if (controller.laser || controller.overridden) return null;
  // Only a program that turns a spindle on clockwise is asking for a speed. A
  // laser program fires with M4 and its `S` is a power, so on a machine whose
  // `$32` reads off — mid guide spot, or never set — it is still not a spindle.
  const code = (l: string) => l.replace(/\([^)]*\)/g, '').replace(/;.*$/, '');
  if (!lines.some((l) => /\bM0*3(?![0-9.])/i.test(code(l)))) return null;
  const ceiling = controller.maxRpm;
  // A `$30` this low is a PWM scale, not a speed limit. See MIN_RPM_CEILING_FROM_30.
  if (!ceiling || !Number.isFinite(ceiling) || ceiling < MIN_RPM_CEILING_FROM_30) return null;
  const asked = programMaxSpindle(lines);
  if (asked === null || asked <= ceiling + 0.5) return null;
  const ratio = asked / ceiling;
  return (
    `Program spindle speed S${Math.round(asked)} exceeds controller max ${Math.round(ceiling)} RPM ($30), which would increase chipload by ${ratio.toFixed(1)}×. Re-export for ${Math.round(ceiling)} RPM, or set the manual spindle speed override in Machine Setup.`
  );
}
