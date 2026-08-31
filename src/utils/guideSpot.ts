// ---------------------------------------------------------------------------
// The guide spot
// ---------------------------------------------------------------------------
//
// A laser has no tool tip to look at. On a router you jog until the cutter is
// over the corner of the stock and you can see when it is; on a laser the thing
// that does the cutting is invisible until it fires, and the head it comes out
// of is a lump of metal several millimetres wide. So XY zero gets set by eye
// against the wrong point, and the whole job comes out shifted by the same
// amount in the same direction every time.
//
// The fix is to light the beam at a power far too low to mark anything and jog
// *that* onto the corner. These are the settings that decide what "far too low"
// means on a particular machine, which is not a constant: `$30` sets what an S
// word is worth, and it is 1000 on a stock GRBL, 255 on plenty of shipped diode
// boards and 100 on a few.
//
// Ported from ~/etch, where this was worked out against real hardware.

const GUIDE_POWER_KEY = 'physbox.laserGuidePowerPct';
const GUIDE_JIGGLE_KEY = 'physbox.laserGuideJiggle';
const LASER_MODE_BORROWED_KEY = 'physbox.laserModeBorrowed';

/**
 * Power the laser is fired at as a pointer rather than a cutter.
 *
 * A **percentage of full scale**, not an S word, because the same S word is
 * three different powers across the controllers this app drives. One percent is
 * a visible dot on most diodes; a twentieth of that was tried first and turned
 * out to be nothing at all on a real machine.
 */
export const DEFAULT_GUIDE_POWER_PCT = 1;

/**
 * The ceiling on that. This is a pointer, not a cut: the beam is parked in one
 * place with nothing moving, which is the one condition under which even a
 * modest diode sets scrap alight. Ten percent of a 10 W diode marks wood in the
 * time it takes to line a corner up — high enough that no machine has an excuse
 * for an invisible dot, low enough that the honest answer to "still cannot see
 * it" is a fault rather than a bigger number.
 */
export const MAX_GUIDE_POWER_PCT = 10;

/** Full scale to assume when the controller has not reported its `$30` yet. */
export const DEFAULT_SPINDLE_PWM_MAX = 1000;

/** How long the spot stays lit before putting itself out, ms. */
export const GUIDE_SPOT_TIMEOUT_MS = 120_000;

/**
 * The cross the head traces to stay lit on a controller that only fires the
 * laser while it is moving. Out and back on each axis, so the pattern returns
 * to its own centre rather than walking the origin across the bed.
 */
export const GUIDE_JIGGLE_PATTERN: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-2, 0],
  [1, 0],
  [0, 1],
  [0, -2],
  [0, 1],
];

/**
 * How far each of those moves is, mm. Inside the beam's own spot size, so what
 * the operator sees is a stationary dot rather than a small scribble.
 */
export const GUIDE_JIGGLE_STEP_MM = 0.1;

/**
 * How fast, mm/min. Slow enough that each move lasts long enough to be worth
 * lighting — at 100 mm/min a 0.1 mm move takes 60 ms — and that the head is
 * genuinely in motion for most of the cycle rather than accelerating and
 * stopping.
 */
export const GUIDE_JIGGLE_FEED_MM_MIN = 100;

/**
 * How long to wait for each of those `ok`s. Short, unlike the 30 s a probing
 * cycle wants: these are 60 ms moves, so a reply that has not come in two
 * seconds means the machine is not listening rather than still working.
 */
export const GUIDE_JIGGLE_REPLY_TIMEOUT_MS = 2000;

export function clampGuidePower(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_GUIDE_POWER_PCT;
  // Tenths: the step between 0.1% and 0.2% is a real difference on a machine
  // whose diode reaches threshold in that region.
  return Math.min(MAX_GUIDE_POWER_PCT, Math.round(value * 10) / 10);
}

export function readGuidePower(): number {
  try {
    const raw = localStorage.getItem(GUIDE_POWER_KEY);
    if (raw === null) return DEFAULT_GUIDE_POWER_PCT;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampGuidePower(parsed) : DEFAULT_GUIDE_POWER_PCT;
  } catch {
    return DEFAULT_GUIDE_POWER_PCT;
  }
}

export function writeGuidePower(value: number): number {
  const clamped = clampGuidePower(value);
  try {
    localStorage.setItem(GUIDE_POWER_KEY, String(clamped));
  } catch {
    // Non-fatal: the setting just will not survive a reload.
  }
  return clamped;
}

/**
 * Whether the guide spot has to keep moving to stay lit.
 *
 * `$32=0` is supposed to make a stationary beam possible, and on plenty of
 * controllers it does. On plenty of others the PWM is gated on motion below the
 * level any `$` setting reaches. There is no way to ask a controller which kind
 * it is — the symptom is a dot that appears while the head jogs and vanishes
 * the moment it stops — so this is a property of the machine that its owner
 * observes once and ticks.
 */
export function readGuideJiggle(): boolean {
  try {
    return localStorage.getItem(GUIDE_JIGGLE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeGuideJiggle(enabled: boolean): boolean {
  try {
    localStorage.setItem(GUIDE_JIGGLE_KEY, enabled ? '1' : '0');
  } catch {
    // Non-fatal: the setting just will not survive a reload.
  }
  return enabled;
}

/**
 * A breadcrumb saying "`$32` was switched off to light a guide spot, and has
 * not been switched back on yet".
 *
 * The spot turns laser mode off because GRBL will not fire a stationary beam
 * with it on. Every in-session exit restores it, but the tab closing is not an
 * exit this app gets to run code for — and `$32=0` left behind survives into
 * the next job, which then burns a line through every rapid. So the intent is
 * written down before the setting is changed and acted on at the next
 * connection.
 */
export function readLaserModeBorrowed(): boolean {
  try {
    return localStorage.getItem(LASER_MODE_BORROWED_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeLaserModeBorrowed(borrowed: boolean): void {
  try {
    if (borrowed) localStorage.setItem(LASER_MODE_BORROWED_KEY, '1');
    else localStorage.removeItem(LASER_MODE_BORROWED_KEY);
  } catch {
    // Non-fatal, but it does mean a tab closed mid-spot leaves `$32` off. The
    // in-session restore paths still cover every other exit.
  }
}

/**
 * The S word for a pointer percentage on a controller whose full scale is
 * `spindleMax`, floored at 1.
 *
 * The floor is the whole reason this is a function rather than a multiply:
 * 0.5% of a `$30` of 100 rounds to zero, and S0 is a beam that never lights —
 * indistinguishable, at the machine, from the button being broken.
 */
export function guidePowerToS(percent: number, spindleMax: number): number {
  const scale = Number.isFinite(spindleMax) && spindleMax > 0 ? spindleMax : DEFAULT_SPINDLE_PWM_MAX;
  return Math.max(1, Math.round((clampGuidePower(percent) / 100) * scale));
}
