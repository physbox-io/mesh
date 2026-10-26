// ---------------------------------------------------------------------------
// The tooling state behind a router export dialog
// ---------------------------------------------------------------------------
//
// Hooks and helpers, kept apart from the field components in CarveFields.tsx
// so that file exports only components and hot reload keeps working on it.
// What lives here is the part of a relief carve dialog that was found to be
// the whole of a solid machining dialog as well: the options, the feeds derived
// for them, the operator's overrides, and the bed probe.

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  deriveReliefFeeds,
  describeCutter,
  type ReliefCarveOptions,
  type ReliefOverrides,
  type DerivedReliefSettings,
} from '../utils/reliefCarveExporter';
import { webSerialManager, type MachineState } from '../utils/webSerialManager';
import { MATERIALS, describeSpeedRecommendation, recommendSpeeds } from '../utils/feedsAndSpeeds';
import { getGridStats, type ProbeGrid } from '../utils/meshLeveler';
import { useStore } from '../store/useStore';
import { useSettled } from '../hooks/useSettled';

export type CarveTooling = Omit<
  ReliefCarveOptions,
  | 'carveDepthMm'
  | 'verticalScaleMode'
  | 'verticalExaggeration'
  | 'fitMode'
  | 'scalePercent'
  | 'backgroundMode'
  | 'invertRelief'
  | 'stockWidthMm'
  | 'stockDepthMm'
  | 'stockThicknessMm'
>;

export type SetTooling = <K extends keyof CarveTooling>(key: K, value: CarveTooling[K] | undefined) => void;
export type OverrideTooling = <K extends keyof ReliefOverrides>(key: K, value: number | undefined) => void;

/**
 * Drops the settings a recommendation makes that are derived elsewhere.
 *
 * `recommendReliefTooling` answers one question — which cutters to fit — and
 * returns a whole options patch. Writing the feeds it also computes into state
 * would leave numbers sitting in `options` that `deriveReliefFeeds` immediately
 * shadows, which is the kind of thing that reads as a bug six months later.
 */
export const DERIVED_KEYS = [
  'spindleRpm',
  'finishingFeedrate',
  'finishingPlungeRate',
  'finishingStepoverPercent',
  'finishingStepdownMm',
  'roughingFeedrate',
  'roughingPlungeRate',
  'roughingStepdownMm',
  'roughingAllowanceMm',
] as const;

export function toolingOnly(patch: Partial<ReliefCarveOptions>): Partial<ReliefCarveOptions> {
  const out = { ...patch };
  for (const key of DERIVED_KEYS) delete out[key];
  return out;
}

/**
 * The recommended tooling, picked for the job without being asked.
 *
 * The dialogs opened on one fixed pair of bits whatever the model, and the
 * tooling worked out for the job sat behind a "Suggest tooling" button that a
 * first-timer had no reason to press — so a fine relief was cut with bits too
 * big for its detail. Now the recommendation is applied to each new result for
 * as long as the tooling is still the one it picked. Change a tooling field and
 * it is yours, until Suggest tooling hands it back. A scene that names its own
 * bits (`chosen`) keeps them.
 *
 * Only finished results count: the export job keeps the last one on screen
 * while the next runs, and a recommendation made from that would be for the
 * scene before. Applying a patch the options already hold is skipped, since a
 * new options object would re-run the job for nothing.
 */
/** What `useAutoTooling` remembers between results. */
export interface AutoToolingMemo<T> {
  /** The patch last applied without being asked, to tell an edit from it. */
  lastAuto: Partial<T> | null;
  /** The operator has changed a tooling field since. */
  manual: boolean;
  /** The result last acted on, so each is acted on once. */
  seen: unknown;
}

/**
 * Whether `options` still holds every value of `patch`. The material is the
 * operator's, not the tooling's: the recommendation is handed it and echoes it
 * back, and changing it must not read as having picked a bit.
 */
export function toolingHolds<T extends object>(options: T, patch: Partial<T>): boolean {
  return Object.entries(patch).every(
    ([k, v]) => k === 'material' || JSON.stringify((options as Record<string, unknown>)[k]) === JSON.stringify(v)
  );
}

/**
 * One step of `useAutoTooling`, pure: given a finished result, the patch to
 * apply now (or null), with the memo updated in place.
 */
export function autoToolingStep<T extends object>(
  memo: AutoToolingMemo<T>,
  result: unknown,
  busy: boolean,
  options: T,
  recommend: () => Partial<T> | null,
  chosen: boolean
): Partial<T> | null {
  if (busy || !result || result === memo.seen) return null;
  memo.seen = result;
  if (memo.lastAuto && !toolingHolds(options, memo.lastAuto)) memo.manual = true;
  if (memo.manual || chosen) return null;
  const patch = recommend();
  if (!patch) return null;
  memo.lastAuto = patch;
  return toolingHolds(options, patch) ? null : patch;
}

/**
 * The recommended tooling, picked for the job without being asked.
 *
 * The dialogs opened on one fixed pair of bits whatever the model, and the
 * tooling worked out for the job sat behind a "Suggest tooling" button that a
 * first-timer had no reason to press — so a fine relief was cut with bits too
 * big for its detail. Now the recommendation is applied to each new result for
 * as long as the tooling is still the one it picked. Change a tooling field and
 * it is yours, until Suggest tooling hands it back. A scene that names its own
 * bits (`chosen`) keeps them.
 *
 * Only finished results count: the export job keeps the last one on screen
 * while the next runs, and a recommendation made from that would be for the
 * scene before. A patch the options already hold is not applied, since a new
 * options object would re-run the job for nothing.
 */
export function useAutoTooling<T extends object>(
  result: unknown,
  busy: boolean,
  options: T,
  recommend: () => Partial<T> | null,
  apply: (patch: Partial<T>) => void,
  chosen: boolean
): { suggest: () => void } {
  const memo = useRef<AutoToolingMemo<T>>({ lastAuto: null, manual: false, seen: null });

  useEffect(() => {
    const patch = autoToolingStep(memo.current, result, busy, options, recommend, chosen);
    if (patch) apply(patch);
  });

  return {
    suggest: () => {
      const patch = recommend();
      if (!patch) return;
      memo.current.manual = false;
      memo.current.lastAuto = patch;
      apply(patch);
    },
  };
}

// Lives in `hooks/useSettled.ts` now — every input in the app needs it, not
// just the carve dialogs. Re-exported so the dialogs' imports stay put.
export { useSettled };

/**
 * Everything a router job dialog keeps about its tooling: the options as
 * chosen, the feeds derived for them, the operator's overrides on top, and the
 * settled copy the exporter is run from.
 *
 * `depthMm` is how deep the job goes, which the feeds are derated for. The
 * relief dialog knows it from its own options; the solid machining dialog
 * measures the part first.
 */
export function useCarveTooling<T extends CarveTooling>(
  isOpen: boolean,
  defaults: T,
  depthOf: number | ((options: T) => number)
) {
  const [options, setOptions] = useState<T>(defaults);
  const depthMm = typeof depthOf === 'function' ? depthOf(options) : depthOf;

  /*
   * The material is the workshop's, not this job's.
   *
   * It stays inside `options` because every feed and speed derivation below
   * takes it from there, but the status bar owns the value — so changing it
   * once re-derives the tooling for every export rather than for whichever
   * modal happened to be open.
   */
  const storeMaterial = useStore((s) => s.material);

  // Folded in during render rather than from an effect, so no frame is ever
  // drawn with feeds derived for the material that was selected a moment ago.
  const [syncedMaterial, setSyncedMaterial] = useState(storeMaterial);
  if (syncedMaterial !== storeMaterial) {
    setSyncedMaterial(storeMaterial);
    setOptions((prev) => ({ ...prev, material: storeMaterial }));
  }
  const set = <K extends keyof T>(key: K, value: T[K] | undefined) => {
    if (value === undefined) return;
    setOptions((prev) => ({ ...prev, [key]: value }));
  };

  /**
   * Feeds and speeds the operator has taken over.
   *
   * Empty by default, and every field in it stays empty until somebody types in
   * it — at which point that one number stops tracking the material and the bit
   * and does exactly what it was told, including things the cutter will not
   * survive. Everything not in here is worked out afresh on every change, so
   * switching from pine to aluminium moves the whole recipe rather than leaving
   * a pine feed sitting in a box above an aluminium job.
   */
  const [overrides, setOverrides] = useState<ReliefOverrides>({});
  /** Typing a number takes a field over; clearing it hands it back to the recipe. */
  const override: OverrideTooling = (key, value) =>
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });

  const [machineState, setMachineState] = useState<MachineState>(webSerialManager.getState());
  useEffect(() => {
    if (!isOpen) return;
    return webSerialManager.addListener(setMachineState);
  }, [isOpen]);

  /**
   * Fastest the gantry tracks while cutting, mm/min.
   *
   * The lower of the machine's own X and Y maximum rates. A cut is a
   * two-axis move, so the slower of the pair is the one that governs it.
   */
  const cuttingRateLimit = Math.min(machineState.motion.maxRate.x, machineState.motion.maxRate.y);

  // Deliberately narrow: naming `options` entire would recompute the recipe on
  // every keystroke in an unrelated box and restart the 250 ms settle behind it.
  const { material, finishingToolDiaMm, finishingFlutes, roughingToolDiaMm, roughingFlutes } = options;
  const derived: DerivedReliefSettings = useMemo(
    () =>
      deriveReliefFeeds(
        { material, finishingToolDiaMm, finishingFlutes, roughingToolDiaMm, roughingFlutes, carveDepthMm: depthMm },
        machineState.motion.spindle,
        cuttingRateLimit
      ),
    [cuttingRateLimit, material, finishingToolDiaMm, finishingFlutes, roughingToolDiaMm, roughingFlutes, depthMm, machineState.motion.spindle]
  );

  // What the job is actually cut with: the chosen tooling, the derived recipe
  // for it, and then whatever the operator has said otherwise.
  const effective = useMemo<T>(() => ({ ...options, ...derived, ...overrides }), [options, derived, overrides]);

  const settled = useSettled(effective, 250);
  const pending = settled !== effective;

  // What the operator has to do to the machine before this file will cut what
  // it says it cuts. Derived from the settled options rather than the live ones
  // so it describes the program that would actually be sent.
  const materialLabel = (MATERIALS.find((m) => m.id === settled.material)?.label ?? settled.material).toLowerCase();
  const finishTool = describeCutter(
    settled.finishingToolDiaMm,
    settled.finishingToolType,
    settled.finishingFlutes,
    settled.finishingGeometry,
    settled.finishingVBitAngleDeg
  );
  const roughTool = describeCutter(settled.roughingToolDiaMm, 'flat', settled.roughingFlutes, settled.roughingGeometry);
  const idealSpeeds = recommendSpeeds({
    diameterMm: settled.finishingToolDiaMm,
    flutes: settled.finishingFlutes,
    material: settled.material,
    spindle: machineState.motion.spindle,
    maxFeedMmMin: cuttingRateLimit,
  });
  // Said once, on the finishing card and again before the start button: the
  // recommendation had to give something up, or the number in the box is not
  // the number the material and the bit ask for.
  const speedNote =
    overrides.spindleRpm !== undefined && Math.abs(idealSpeeds.rpm - effective.spindleRpm) > idealSpeeds.rpm * 0.15
      ? `Overridden. ${describeSpeedRecommendation(idealSpeeds, settled.material, settled.finishingToolDiaMm)}`
      : idealSpeeds.clampedBy
        ? describeSpeedRecommendation(idealSpeeds, settled.material, settled.finishingToolDiaMm)
        : null;

  return {
    options, setOptions, set,
    overrides, setOverrides, override,
    machineState, cuttingRateLimit,
    derived, effective, settled, pending,
    materialLabel, finishTool, roughTool, idealSpeeds, speedNote,
  };
}

/**
 * The bed probe: how many points, whether it is running, and what it found.
 *
 * `probe` runs the grid over the given footprint and hands the result to
 * `onProbed`, which is where the dialog turns depth compensation on.
 */
export function useBedProbe(onProbed: (grid: ProbeGrid) => void) {
  const [probeCols, setProbeCols] = useState(3);
  const [probeRows, setProbeRows] = useState(3);
  const [isProbing, setIsProbing] = useState(false);
  const [probeProgress, setProbeProgress] = useState({ current: 0, total: 0 });
  const [probedGrid, setProbedGrid] = useState<ProbeGrid | null>(null);

  const probe = async (bounds: { minX: number; minY: number; maxX: number; maxY: number }) => {
    setIsProbing(true);
    setProbeProgress({ current: 0, total: probeCols * probeRows });
    try {
      const grid = await webSerialManager.probeGrid(bounds, probeCols, probeRows, (current, total) =>
        setProbeProgress({ current, total })
      );
      setProbedGrid(grid);
      onProbed(grid);
    } catch {
      // Probing throws without a connected machine; the button is disabled in
      // that case, so this only fires on a genuine fault. Keep any prior grid.
    } finally {
      setIsProbing(false);
    }
  };

  const stats = probedGrid ? getGridStats(probedGrid) : null;
  return { probeCols, setProbeCols, probeRows, setProbeRows, isProbing, probeProgress, probedGrid, probe, stats };
}

