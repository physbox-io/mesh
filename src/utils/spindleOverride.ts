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
 */

import type { MotionProfile } from './motionProfile';

/** localStorage key, and the account parameter of the same name. */
export const SPINDLE_MAX_OVERRIDE_KEY = 'physics_spindle_max_override';

/** Below this an RPM is a typo, not a spindle. */
const MIN_OVERRIDE_RPM = 1000;
const MAX_OVERRIDE_RPM = 100_000;

/** The override in force, or null to use whatever the controller reports. */
export function readSpindleMaxOverride(): number | null {
  try {
    const raw = localStorage.getItem(SPINDLE_MAX_OVERRIDE_KEY);
    if (!raw) return null;
    const rpm = Number(raw);
    return Number.isFinite(rpm) && rpm >= MIN_OVERRIDE_RPM && rpm <= MAX_OVERRIDE_RPM ? rpm : null;
  } catch {
    // No localStorage (a test, a locked-down profile): there is no override.
    return null;
  }
}

/**
 * Sets the override, or clears it with null, here and in the account.
 *
 * Cleared is written as an empty string rather than deleted, so the account
 * holds the clearing too — otherwise the next sign-in would pull the old value
 * straight back down.
 */
export function writeSpindleMaxOverride(rpm: number | null): void {
  const value = rpm === null ? '' : String(Math.round(Math.min(MAX_OVERRIDE_RPM, Math.max(MIN_OVERRIDE_RPM, rpm))));
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
