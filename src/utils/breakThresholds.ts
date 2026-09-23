// When a constraint has had enough.
//
// MuJoCo already computes the force it is spending to hold every equality
// constraint in the scene: six rows per weld in `efc_force`, the first three
// force in newtons and the last three torque in newton-metres. So "the handle
// shears off when you load it hard enough" needs no new physics at all — it is
// a threshold on a number the solver hands over every step.
//
// This module is the threshold, and nothing else. It is PURE: numbers in, a
// verdict out, no store, no MuJoCo, no worker. That matters because the code
// that calls it lives inside the physics worker's step loop, which no test can
// reach — see the printAnalysis/dfm split in CLAUDE.md for the same argument.
// Everything here runs in plain Vitest.
//
// The one piece of judgement worth reading twice is `consecutive`. A threshold
// read one step at a time breaks welds that were never really loaded, because a
// hard contact makes the solver spike for a single step while it resolves the
// penetration. The overload has to persist to count.

/** What a body says about when its weld gives way. */
export interface WeldBreakConfig {
  /** Newtons of pull the weld survives. Undefined means it never breaks. */
  weldBreakForceN?: number;
  /** Newton-metres of twist the weld survives. Undefined means it never breaks. */
  weldBreakTorqueNm?: number;
  /** Consecutive overloaded steps required. Defaults to DEFAULT_HOLD_STEPS. */
  weldBreakHoldSteps?: number;
}

/**
 * Three steps, i.e. 3 ms at the default timestep.
 *
 * Long enough to outlast the single-step spike the solver produces on contact
 * onset, short enough that a genuine overload still breaks the weld within a
 * frame — nobody can see 3 ms of delay, and everybody can see a mug whose
 * handle falls off when it is set down gently.
 */
export const DEFAULT_HOLD_STEPS = 3;

/** True when this body's weld is configured to be breakable at all. */
export function isBreakable(cfg: WeldBreakConfig | undefined): boolean {
  if (!cfg) return false;
  return isFiniteThreshold(cfg.weldBreakForceN) || isFiniteThreshold(cfg.weldBreakTorqueNm);
}

/**
 * How many consecutive overloaded steps this weld needs before it lets go.
 *
 * Floored at 1: zero would mean "break on a step that has not been overloaded",
 * which the caller's counter cannot express, and a negative is meaningless.
 */
export function holdSteps(cfg: WeldBreakConfig | undefined): number {
  const raw = cfg?.weldBreakHoldSteps;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_HOLD_STEPS;
  return Math.max(1, Math.round(raw));
}

/**
 * Is this weld over its limit *right now*?
 *
 * Either limit alone is enough — a weld given only a force limit is not
 * expected to survive unlimited torque, it is expected to ignore torque. A
 * threshold of 0 breaks on any load at all, which is a legitimate thing to ask
 * for and is why this tests `>=` on a configured zero rather than treating it
 * as unset.
 */
export function isOverloaded(forceN: number, torqueNm: number, cfg: WeldBreakConfig | undefined): boolean {
  if (!cfg) return false;
  if (isFiniteThreshold(cfg.weldBreakForceN) && forceN >= cfg.weldBreakForceN!) return true;
  if (isFiniteThreshold(cfg.weldBreakTorqueNm) && torqueNm >= cfg.weldBreakTorqueNm!) return true;
  return false;
}

/**
 * The whole decision, given how many steps in a row this weld has been over.
 *
 * `consecutive` counts the steps BEFORE this one, so the caller keeps a plain
 * counter and does not have to decide whether to increment before or after
 * asking. Not overloaded now resets it; overloaded for the full hold breaks it.
 */
export function weldOverload(
  forceN: number,
  torqueNm: number,
  cfg: WeldBreakConfig | undefined,
  consecutive: number,
): { broken: boolean; consecutive: number } {
  if (!isOverloaded(forceN, torqueNm, cfg)) return { broken: false, consecutive: 0 };
  const next = consecutive + 1;
  return { broken: next >= holdSteps(cfg), consecutive: next };
}

/**
 * The key a broken constraint is remembered by.
 *
 * Deliberately built from the two node ids rather than from the equality's
 * index or its `weld_constraint_N` name. Both of those are positional: add a
 * body to the scene and every index after it shifts, so a break recorded on the
 * main thread would re-apply itself to the wrong weld after the next rebuild.
 * A pair of ids survives anything that does not delete one of the two bodies.
 */
export function weldKey(nodeId: string, targetId: string): string {
  return `weld:${nodeId}->${targetId}`;
}

/**
 * The key a released crumple zone is remembered by.
 *
 * Named after the joint, which is unique in the model, so it survives the body
 * being renamed or reparented.
 */
export function crumpleKey(jointName: string): string {
  return `crumple:${jointName}`;
}

/** What a joint says about when it stops being rigid. */
export interface CrumpleConfig {
  crumpleTorqueNm?: number;
  crumpleDampingAfter?: number;
}

export function canCrumple(cfg: CrumpleConfig | undefined): boolean {
  return !!cfg && typeof cfg.crumpleTorqueNm === 'number'
    && Number.isFinite(cfg.crumpleTorqueNm) && cfg.crumpleTorqueNm >= 0;
}

/**
 * A crumple lock read as a breakable weld.
 *
 * It IS one — the lock holding the joint still is an ordinary weld equality —
 * so the same overload test does the work. Only the torque matters: a crumple
 * zone folds when it is bent, not when it is pulled, and giving it a force
 * limit as well would make it come apart in the hands rather than crumple.
 */
export function crumpleAsWeld(cfg: CrumpleConfig | undefined): WeldBreakConfig {
  return { weldBreakTorqueNm: cfg?.crumpleTorqueNm, weldBreakHoldSteps: DEFAULT_HOLD_STEPS };
}

function isFiniteThreshold(v: number | undefined): boolean {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

// ---------------------------------------------------------------------------
// Impacts: shattering and denting
// ---------------------------------------------------------------------------
//
// Both are thresholds on the same measured quantity — the momentum a body
// absorbed over a few milliseconds — and the ordering between them is what makes
// the pair read as one material rather than two features. A blow that shatters
// does not also dent, because there is nothing left to dent.

export interface ShatterConfig {
  shatterImpulseNs?: number;
}

export interface DentConfig {
  dentYieldNs?: number;
  dentDepthPerNs?: number;
  dentRadius?: number;
  dentMaxDepth?: number;
  pierceImpulseNs?: number;
  deformCollision?: boolean;
}

/**
 * Did that blow go straight through?
 *
 * Checked before denting, because the two are alternatives rather than stages:
 * there is nothing left to crease where the material has gone.
 */
export function pierceVerdict(impulseNs: number, cfg: DentConfig | undefined): boolean {
  const limit = cfg?.pierceImpulseNs;
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0 && impulseNs >= limit;
}

/** Metres per newton-second over yield, when a geom does not say. */
export const DEFAULT_DENT_DEPTH_PER_NS = 0.004;
/** A dent deeper than this is a hole, and this is not a hole-punching feature. */
export const DEFAULT_DENT_MAX_DEPTH = 0.02;

export function canShatter(cfg: ShatterConfig | undefined): boolean {
  return !!cfg && typeof cfg.shatterImpulseNs === 'number'
    && Number.isFinite(cfg.shatterImpulseNs) && cfg.shatterImpulseNs > 0;
}

export function canDent(cfg: DentConfig | undefined): boolean {
  return !!cfg && typeof cfg.dentYieldNs === 'number'
    && Number.isFinite(cfg.dentYieldNs) && cfg.dentYieldNs > 0;
}

/** Was that blow enough to break it? */
export function shatterVerdict(impulseNs: number, cfg: ShatterConfig | undefined): boolean {
  return canShatter(cfg) && impulseNs >= cfg!.shatterImpulseNs!;
}

/**
 * How deep a dent that blow leaves, in metres. Zero means it left no mark.
 *
 * Linear in the excess over yield and then clamped, which is not real
 * elastoplasticity — real work-hardening is a curve — but it has the two
 * properties that matter here: nothing below the yield leaves a mark at all,
 * and nothing above it can punch through. A soft or slow weight bounces off an
 * unmarked plate; a hard one craters it.
 */
export function dentDepth(impulseNs: number, cfg: DentConfig | undefined): number {
  if (!canDent(cfg)) return 0;
  const excess = impulseNs - cfg!.dentYieldNs!;
  if (excess <= 0) return 0;
  const rate = numberOr(cfg!.dentDepthPerNs, DEFAULT_DENT_DEPTH_PER_NS);
  const max = numberOr(cfg!.dentMaxDepth, DEFAULT_DENT_MAX_DEPTH);
  return Math.min(max, excess * rate);
}

/**
 * How wide the crater is, as a multiple of the geom's authored dent radius.
 *
 * A harder blow spreads further as well as going deeper, and that reads far
 * better than depth alone: a 9 mm dish and an 18 mm dish of the same width are
 * nearly indistinguishable on a half-metre plate, while one twice the width is
 * obvious at a glance. It is also the more honest of the two — depth is capped
 * by the thickness of the thing being hit, and width is not.
 *
 * Grows with the overload rather than with the depth, because the depth is
 * clamped and would take the width flat with it just as the blows get
 * interesting.
 */
export function dentSpread(impulseNs: number, cfg: DentConfig | undefined): number {
  if (!canDent(cfg)) return 1;
  const overload = (impulseNs - cfg!.dentYieldNs!) / cfg!.dentYieldNs!;
  if (!(overload > 0)) return 1;
  return 1 + 0.6 * Math.min(2.5, overload);
}

function numberOr(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
}
