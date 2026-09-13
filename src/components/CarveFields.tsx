// ---------------------------------------------------------------------------
// The sections every router export dialog is built out of
// ---------------------------------------------------------------------------
//
// Lifted out of the relief carve dialog when the solid machining dialog needed
// exactly the same sections. A finishing pass is a finishing pass whether the
// surface under it is a landscape or the top of a bracket, and two copies of
// two hundred lines of fields would drift apart within the month. The state
// they edit comes from the hooks in carveTooling.ts.

import React, { useState } from 'react';
import { AlertCircle, Info, ChevronRight, RefreshCw } from 'lucide-react';
import { NumberInput } from '@physbox-io/ui';
import type { ReliefCarveOptions, ReliefOverrides, DerivedReliefSettings } from '../utils/reliefCarveExporter';
import type { GridStats, ProbeGrid } from '../utils/meshLeveler';
import type { CarveTooling, SetTooling, OverrideTooling } from './carveTooling';

export const inputClass =
  'w-full px-3 py-1.5 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg ' +
  'text-xs font-mono text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-blue-500 focus:outline-none disabled:opacity-40';

export const labelClass = 'text-xs font-semibold text-slate-600 dark:text-slate-300';

export const sectionClass =
  'p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-4';

export const sectionTitleClass =
  'text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500';

export const hintBubbleClass =
  'pointer-events-none absolute top-full z-30 mt-1.5 w-max max-w-[min(14rem,70vw)] rounded-lg ' +
  'bg-slate-900 dark:bg-slate-950 px-2.5 py-2 text-[11px] font-normal leading-snug text-slate-100 ' +
  'shadow-xl ring-1 ring-slate-700 opacity-0 transition-opacity ' +
  'group-hover:opacity-100 group-focus-within:opacity-100';

export function HintIcon() {
  return (
    <Info
      className="w-3.5 h-3.5 flex-shrink-0 text-slate-400 hover:text-blue-500 cursor-help"
      tabIndex={0}
      aria-label="What is this?"
    />
  );
}

export function Field({
  label, hint, hintAlign = 'start', className, children,
}: {
  label: string;
  hint: string;
  hintAlign?: 'start' | 'end';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`flex flex-col min-w-0 ${className ?? ''}`}>
      <div className="group relative flex items-center space-x-1 mb-1.5">
        <label className={labelClass}>{label}</label>
        <HintIcon />
        <span role="tooltip" className={`${hintBubbleClass} ${hintAlign === 'end' ? 'right-0' : 'left-0'}`}>
          {hint}
        </span>
      </div>
      <div className="mt-auto">{children}</div>
    </div>
  );
}

/**
 * What the job will actually do, in the units the machine uses.
 *
 * The counterpart to hiding the feeds: a beginner should not have to fill six
 * numbers in, but they should be able to see the six numbers that were chosen
 * for them, and be told when one of them is a compromise. Modelled on the same
 * card in the sibling editor, so the two apps read alike.
 */
export function DerivedRecipe({
  title, line, notes,
}: { title: string; line: string; notes?: (string | null | undefined)[] }) {
  const real = (notes ?? []).filter(Boolean) as string[];
  return (
    <div className="rounded-lg bg-slate-100 dark:bg-slate-950/60 border border-slate-200 dark:border-slate-800 px-2.5 py-2">
      <span className="text-[9px] uppercase font-semibold text-slate-500 dark:text-slate-400">
        {title}
      </span>
      <p className="mt-0.5 font-mono text-[11px] text-slate-800 dark:text-slate-100">{line}</p>
      {real.map((n) => (
        <p
          key={n}
          className="mt-1 flex items-start gap-1 text-[10px] text-amber-600 dark:text-amber-400 leading-snug"
        >
          <AlertCircle className="w-3 h-3 mt-px flex-shrink-0" />
          <span>{n}</span>
        </p>
      ))}
    </div>
  );
}

export function Advanced({ label = 'Advanced', children }: { label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="pt-3 border-t border-slate-200 dark:border-slate-800">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="flex items-center space-x-1 text-[11px] font-bold uppercase tracking-wider text-slate-400
                   dark:text-slate-500 hover:text-blue-600 dark:hover:text-blue-400 cursor-pointer transition-colors"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <span>{label}</span>
      </button>
      {open && (
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">{children}</div>
      )}
    </div>
  );
}

/**
 * A two- or three-way switch that fits the column it is put in.
 *
 * `min-w-0` and `truncate` rather than `whitespace-nowrap`: a flex child will
 * not shrink below its content's width unless it is told it may, so a label a
 * few characters too long for its grid cell used to push the whole control out
 * past the field beside it. Now it ellipsizes instead, and the `title` keeps
 * the full text reachable.
 *
 * That is the backstop, not the plan — a label people have to hover to read is
 * a label that is too long. Keep them short enough that the ellipsis never
 * appears at the widths these grids actually use.
 */
export function Segmented<T extends string>({
  value, options, onChange, disabled = false,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  /** Greys the whole switch out, to match the number fields beside it. */
  disabled?: boolean;
}) {
  return (
    <div className={`flex bg-slate-200 dark:bg-slate-700/60 p-0.5 rounded-lg ${disabled ? 'opacity-40' : ''}`}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          disabled={disabled}
          onClick={() => onChange(v)}
          title={label}
          className={`flex-1 min-w-0 py-1 px-2 rounded-md text-xs font-medium transition-all truncate ${
            disabled ? 'cursor-not-allowed' : ''
          } ${
            value === v
              ? 'bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm'
              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

interface PassFieldsProps {
  options: CarveTooling;
  effective: CarveTooling;
  derived: DerivedReliefSettings;
  overrides: ReliefOverrides;
  set: SetTooling;
  override: OverrideTooling;
  materialLabel: string;
}

/** The finishing pass: the cutter, how it sweeps, and the feeds derived for it. */
export function FinishingPassFields({
  options, effective, derived, overrides, set, override, materialLabel,
  speedNote, passCount, onSuggestTooling, canSuggest,
}: PassFieldsProps & {
  speedNote: string | null;
  /** Passes the last export came out as, or null before one has. */
  passCount: number | null;
  onSuggestTooling: () => void;
  canSuggest: boolean;
}) {
  // The ring, spiral and waterline patterns lay their passes out from the
  // surface or the boundary, so the raster angle controls have nothing to act on.
  const usesRasterAngle =
    options.finishingStrategy === 'raster' ||
    options.finishingStrategy === 'crosshatch' ||
    options.finishingStrategy === 'hybrid';

  return (
    <div className={sectionClass}>
      <div className="flex items-center justify-between gap-4">
        <h3 className={sectionTitleClass}>Finishing Pass</h3>
        <button
          type="button"
          onClick={onSuggestTooling}
          disabled={!canSuggest}
          title="Pick bits, stepdowns and feeds that suit this job's depth and size"
          className="text-xs px-2 py-1 rounded border border-neutral-600 hover:bg-neutral-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Suggest tooling
        </button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <Field
          className="lg:col-span-3"
          label="Cutter Shape"
          hint="A ball nose leaves a smooth surface on curves, and the toolpath is lifted to keep its round tip on the surface. A flat mill has to clear the highest point under its whole diameter, so it rounds off fine detail. A V-bit is a cone: it drops into corners and grooves no round cutter can enter and holds detail far finer than its diameter, so lettering and ornament are cut with one. It only cuts as deep as the cone is tall, and it leaves a ridge between passes."
        >
          <Segmented
            value={options.finishingToolType}
            onChange={(v) => set('finishingToolType', v)}
            options={[['ball_nose', 'Ball-Nose'], ['flat', 'Flat'], ['v_bit', 'V-Bit']] as const}
          />
        </Field>

        {options.finishingToolType === 'v_bit' && (
          <Field
            label="V Angle (deg)"
            hint="Included point angle, as it is written on the bit (60 for a 60 degree V). It sets two things at once: how deep the bit can cut before the cone runs out and only the shank is left, and how tall a ridge the stepover leaves. Narrow holds finer detail and is more fragile."
          >
            <Segmented
              value={String(options.finishingVBitAngleDeg)}
              onChange={(v) => set('finishingVBitAngleDeg', parseInt(v, 10))}
              options={[['30', '30'], ['60', '60'], ['90', '90']] as const}
            />
          </Field>
        )}

        <Field
          label="Bit Ø (mm)"
          hint="Diameter of the finishing cutter. It sets both the stepover and how much detail survives: nothing narrower than the bit can be cut. For a V-bit this is the diameter at the top of the cone, which is only reached at full depth."
        >
          <NumberInput
            step={0.1} min={0.1} max={30}
            value={options.finishingToolDiaMm}
            onChange={(v) => set('finishingToolDiaMm', v)}
            className={inputClass}
          />
        </Field>







      </div>

      <DerivedRecipe
        title={`Derived for ${materialLabel}`}
        line={
          `${effective.spindleRpm.toLocaleString()} RPM · ${effective.finishingFeedrate} mm/min · ` +
          `${((effective.finishingToolDiaMm * effective.finishingStepoverPercent) / 100).toFixed(2)} mm stepover · ` +
          `${passCount ?? '—'} passes`
        }
        notes={[speedNote]}
      />
      <Advanced label="Advanced: override the derived feeds">
        <Field
          label="Flutes"
          hint="Cutting edges on the bit. Feed rate is chip-per-tooth x flutes x RPM, so the same feed is twice the load per edge on a two-flute cutter as on a four. The app checks the feedrate against this, and writes it into the file's header so the right bit gets fitted."
        >
          <NumberInput
            step={1} min={1} max={8} integer
            value={options.finishingFlutes}
            onChange={(v) => set('finishingFlutes', v)}
            className={inputClass}
          />
        </Field>
        <Field
          className="lg:col-span-3"
          label="Helix"
          hint="Which way the flutes throw the chip. Upcut lifts it out of the cut and is what clears depth. Downcut presses it down: a clean top edge, but the chips pack into the bottom of a deep relief and burn. Compression is upcut low and downcut high, which in a relief means it never leaves its upcut section. This does not change the coordinates, but it does change what the app will let a feed, a plunge and a stepdown be without warning you."
        >
          <Segmented
            value={options.finishingGeometry}
            onChange={(v) => set('finishingGeometry', v)}
            options={[['upcut', 'Up'], ['downcut', 'Down'], ['compression', 'Compr.'], ['straight', 'Straight']] as const}
          />
        </Field>
        <Field
          className="lg:col-span-2"
          label="Depth Strategy"
          hint="One Sweep is depth-first: each point is cut to its final height the first time the raster reaches it. It is the quicker one, and the right choice when a roughing pass has already taken the waste out or the relief is shallow. Layered repeats the raster at lower and lower limits so the bit never has to swallow the whole relief at once. It is slower, but keeps a small cutter alive when the finishing pass is clearing the relief on its own. Auto picks One Sweep when roughing is on and Layered when it is off."
        >
          <Segmented
            value={options.finishingDepthMode}
            onChange={(v) => set('finishingDepthMode', v)}
            options={[['auto', 'Auto'], ['single', 'One Sweep'], ['layered', 'Layered']] as const}
          />
        </Field>
        <Field
          label="Stepdown (mm)"
          hint="Most depth one layered sweep may take. 0 uses the bit diameter. Ignored when the depth strategy is One Sweep."
        >
          <NumberInput
            step={0.5} min={0} max={20}
            allowEmpty
            placeholder={String(derived.finishingStepdownMm)}
            value={overrides.finishingStepdownMm ?? null}
            onChange={(v) => override('finishingStepdownMm', v)}
            className={inputClass}
          />
        </Field>
        <Field
          label="Stepover (%)"
          hint="Spacing between passes, as a percentage of bit diameter. Lower is smoother and slower: 10% is a show surface, 40% leaves visible ridges you will have to sand."
        >
          <NumberInput
            step={5} min={2} max={50}
            allowEmpty
            placeholder={String(derived.finishingStepoverPercent)}
            value={overrides.finishingStepoverPercent ?? null}
            onChange={(v) => override('finishingStepoverPercent', v)}
            className={inputClass}
          />
        </Field>
        <Field
          label="Feedrate (mm/m)"
          hint="How fast the cutter travels through the finishing pass, in mm per minute."
        >
          <NumberInput
            step={100} min={50} max={10000} integer
            allowEmpty
            placeholder={String(derived.finishingFeedrate)}
            value={overrides.finishingFeedrate ?? null}
            onChange={(v) => override('finishingFeedrate', v)}
            className={inputClass}
          />
        </Field>
        <Field
          hintAlign="end"
          label="Pass Pattern"
          hint="How the finishing passes are laid out. A raster is the fastest to cut and the one whose direction you can see in the finished surface. Waterline follows the surface's own level lines, which is far better on steep ground and useless on flat. Hybrid uses each where it wins, and is the one to pick for a sculpted or organic relief."
        >
          <select
            value={options.finishingStrategy}
            onChange={(e) => set('finishingStrategy', e.target.value as ReliefCarveOptions['finishingStrategy'])}
            className={inputClass}
          >
            <option value="raster">Parallel raster</option>
            <option value="crosshatch">Crosshatch (two rasters, 90° apart)</option>
            <option value="concentric">Concentric rings</option>
            <option value="spiral">Continuous spiral</option>
            <option value="contour">Waterline (follows level lines)</option>
            <option value="hybrid">Hybrid (waterline + raster)</option>
          </select>
        </Field>
        <Field
          hintAlign="end"
          label="Sweep Axis"
          hint="Which way the parallel passes run. Sweeping across a feature's long axis rather than along it usually leaves a better surface. Unused by the ring, spiral and waterline patterns."
        >
          <Segmented
            value={options.finishingDirection}
            onChange={(v) => set('finishingDirection', v)}
            disabled={!usesRasterAngle}
            options={[['x', 'X'], ['y', 'Y']] as const}
          />
        </Field>
        <Field
          label="Pass Angle (°)"
          hint="Rotates the raster off its axis. Blank follows the sweep axis (0° for X, 90° for Y). On wood this is not cosmetic: passes running across the grain tear it, and 45° is the usual compromise when the grain and a feature's long axis disagree."
        >
          <NumberInput
            step={5} min={-180} max={180}
            allowEmpty
            disabled={!usesRasterAngle}
            placeholder={String(options.finishingDirection === 'y' ? 90 : 0)}
            value={options.finishingAngleDeg ?? null}
            onChange={(v) => set('finishingAngleDeg', v ?? undefined)}
            className={inputClass}
          />
        </Field>
        <Field
          label="Steep Cutover (°)"
          hint="The slope at which the hybrid pattern hands over from raster to waterline. Lower sends more of the model to the waterline pass. 30-45° is the usual band."
        >
          <NumberInput
            step={5} min={5} max={85} integer
            disabled={options.finishingStrategy !== 'hybrid'}
            value={options.finishingSteepAngleDeg}
            onChange={(v) => set('finishingSteepAngleDeg', v ?? 35)}
            className={inputClass}
          />
        </Field>
        <Field
          className="lg:col-span-2"
          label="Plunge Rate (mm/m)"
          hint="How fast the cutter is driven straight down into the material at the start of a pass. Slower than the cutting feedrate, because the tip of an end mill cuts badly."
        >
          <NumberInput
            step={50} min={10} max={2000} integer
            allowEmpty
            placeholder={String(derived.finishingPlungeRate)}
            value={overrides.finishingPlungeRate ?? null}
            onChange={(v) => override('finishingPlungeRate', v)}
            className={inputClass}
          />
        </Field>

        <Field
          className="lg:col-span-2"
          label="Shank & Holder Clearance"
          hint="Checks toolpath against shank and collet nut diameter to prevent collisions in deep pockets."
        >
          <Segmented
            value={options.toolBodyClearance ? 'on' : 'off'}
            onChange={(v) => set('toolBodyClearance', v === 'on')}
            options={[['on', 'Keep Clear'], ['off', 'Flutes Only']] as const}
          />
        </Field>

        <Field
          label="Shank Ø (mm)"
          hint="Diameter of the finishing bit above its flutes. 0 assumes the usual: bits under 3.175 mm are ground on a 3.175 mm blank, anything bigger is its own diameter."
        >
          <NumberInput
            step={0.1} min={0} max={30}
            value={options.finishingShankDiaMm}
            onChange={(v) => set('finishingShankDiaMm', v)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Flute Length (mm)"
          hint="How far up the finishing bit the cutting edges run. Below this it cuts, above it only rubs. 0 assumes three diameters, which is about what catalogue bits carry."
        >
          <NumberInput
            step={1} min={0} max={100}
            value={options.finishingFluteLengthMm}
            onChange={(v) => set('finishingFluteLengthMm', v)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Stickout (mm)"
          hint="Tip of the tool to the face of the collet nut. Together with the holder diameter it is what decides whether the nut clears a tall feature standing next to a deep cut. 0 leaves the holder unchecked."
        >
          <NumberInput
            step={1} min={0} max={200}
            value={options.toolStickoutMm}
            onChange={(v) => set('toolStickoutMm', v)}
            className={inputClass}
          />
        </Field>

        <Field
          label="Holder Ø (mm)"
          hint="Widest part of the collet nut or tool holder (about 19 mm for ER11, 28 mm for ER16). 0 leaves the holder unchecked."
        >
          <NumberInput
            step={1} min={0} max={200}
            value={options.holderDiaMm}
            onChange={(v) => set('holderDiaMm', v)}
            className={inputClass}
          />
        </Field>

        <Field
          className="lg:col-span-2"
          label="Lead-In Angle (°)"
          hint="How steeply the cutter descends into the material at the head of a pass. Plunging straight down snaps small bits, so the cutter ramps in along the path instead, then backs up to clear what the ramp rode over. 0 goes back to plunging straight down."
        >
          <NumberInput
            step={5} min={0} max={45}
            value={options.leadInAngleDeg}
            onChange={(v) => set('leadInAngleDeg', v)}
            className={inputClass}
          />
        </Field>

        <Field
          className="lg:col-span-2"
          label="Safe Z (mm)"
          hint="Retract height above the stock's top face for moves between passes. It has to clear the clamps."
        >
          <NumberInput
            step={1} min={1} max={100}
            value={options.safeZ}
            onChange={(v) => set('safeZ', v)}
            className={inputClass}
          />
        </Field>

        <Field
          className="lg:col-span-2"
          hintAlign="end"
          label="Spindle (RPM)"
          hint="The speed to set before you press start. On a router with a dial rather than a controlled spindle the S word in the file does nothing at all, so this is a number you turn by hand. The file writes it out as a comment and the machine panel repeats it. It comes from the material's surface speed and the finishing bit's diameter; Suggest tooling sets it."
        >
          <NumberInput
            step={1000} min={0} max={60000} integer
            allowEmpty
            placeholder={String(derived.spindleRpm)}
            value={overrides.spindleRpm ?? null}
            onChange={(v) => override('spindleRpm', v)}
            className={inputClass}
          />
        </Field>
      </Advanced>
    </div>
  );
}

/** The roughing pass: whether there is one, what it is cut with, and how. */
export function RoughingPassFields({
  options, effective, derived, overrides, set, override, materialLabel,
}: PassFieldsProps) {
  return (
    <div className={sectionClass}>
      <h3 className={sectionTitleClass}>Roughing Pass</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <Field
          className="lg:col-span-2"
          label="Waste Clearing"
          hint="A layered pass with a bigger flat mill that clears the bulk before the finishing raster. Skipping it means the finishing bit takes the full depth in one go, which snaps small cutters."
        >
          <Segmented
            value={options.roughingEnabled ? 'on' : 'off'}
            onChange={(v) => set('roughingEnabled', v === 'on')}
            options={[['on', 'Rough First'], ['off', 'Finish Only']] as const}
          />
        </Field>

        <Field
          label="Flat End Mill Ø (mm)"
          hint="Diameter of the flat end mill used for bulk material removal before the finishing pass."
        >
          <NumberInput
            step={0.1} min={0.1} max={30}
            disabled={!options.roughingEnabled}
            value={options.roughingToolDiaMm}
            onChange={(v) => set('roughingToolDiaMm', v)}
            className={inputClass}
          />
        </Field>

        <Field
          className="lg:col-span-2"
          hintAlign="end"
          label="Clearing Path"
          hint="Raster sweeps back and forth in parallel lines. Its stepover only describes the bite on a long straight run: every time a line meets a corner or crosses a narrow channel the tool is suddenly cutting full width, so the depth per pass has to be set for that worst case and paid for over the whole job. Adaptive walks the region's own contours instead, outermost ring first, so the bite is the stepover everywhere, and the depth per pass can go up several times over."
        >
          <Segmented
            value={options.roughingStrategy}
            onChange={(v) => set('roughingStrategy', v)}
            disabled={!options.roughingEnabled}
            options={[['adaptive', 'Adaptive'], ['raster', 'Raster']] as const}
          />
        </Field>


      </div>

      <DerivedRecipe
        title={`Derived for ${materialLabel}`}
        line={
          effective.roughingEnabled
            ? `${effective.spindleRpm.toLocaleString()} RPM · ${effective.roughingFeedrate} mm/min · ` +
              `${effective.roughingStepdownMm} mm/pass · ${effective.roughingAllowanceMm} mm left on` +
              (effective.roughingStrategy === 'adaptive'
                ? ` · ${Math.round(
                    ((effective.roughingStepoverMm > 0
                      ? effective.roughingStepoverMm
                      : effective.roughingToolDiaMm * 0.2) /
                      Math.max(0.01, effective.roughingToolDiaMm)) * 100
                  )}% bite, held in corners too`
                : '')
            : 'Skipped: the finishing bit clears the whole job on its own'
        }
      />
      <Advanced label="Advanced: override the derived feeds">
        <Field
          label="Flutes"
          hint="Cutting edges on the roughing mill, used to check the feedrate makes a chip rather than a rub, and written into the file so the right bit is fitted."
        >
          <NumberInput
            step={1} min={1} max={8} integer
            disabled={!options.roughingEnabled}
            value={options.roughingFlutes}
            onChange={(v) => set('roughingFlutes', v)}
            className={inputClass}
          />
        </Field>
        <Field
          className="lg:col-span-3"
          label="Helix"
          hint="Roughing wants an upcut: the whole job of this pass is to get waste out of a pocket, and upcut is the only geometry that lifts it. A downcut here packs its own chips into the floor it is trying to clear."
        >
          <Segmented
            value={options.roughingGeometry}
            onChange={(v) => set('roughingGeometry', v)}
            options={[['upcut', 'Up'], ['downcut', 'Down'], ['compression', 'Compr.'], ['straight', 'Straight']] as const}
          />
        </Field>
        <Field
          label="Stepdown (mm)"
          hint="How much depth each roughing layer takes. Deeper is quicker but loads the cutter harder; 1–2 mm suits most wood on a hobby router."
        >
          <NumberInput
            step={0.5} min={0.1} max={20}
            disabled={!options.roughingEnabled}
            allowEmpty
            placeholder={String(derived.roughingStepdownMm)}
            value={overrides.roughingStepdownMm ?? null}
            onChange={(v) => override('roughingStepdownMm', v)}
            className={inputClass}
          />
        </Field>
        <Field
          label="Leave On (mm)"
          hint="Material the roughing pass leaves above the finished surface for the finishing bit to take off. Too little and the roughing marks show through."
        >
          <NumberInput
            step={0.1} min={0} max={5}
            disabled={!options.roughingEnabled}
            allowEmpty
            placeholder={String(derived.roughingAllowanceMm)}
            value={overrides.roughingAllowanceMm ?? null}
            onChange={(v) => override('roughingAllowanceMm', v)}
            className={inputClass}
          />
        </Field>
        <Field
          hintAlign="end"
          label="Feedrate (mm/m)"
          hint="Cutting feedrate for the roughing layers, in mm per minute."
        >
          <NumberInput
            step={100} min={50} max={10000} integer
            disabled={!options.roughingEnabled}
            allowEmpty
            placeholder={String(derived.roughingFeedrate)}
            value={overrides.roughingFeedrate ?? null}
            onChange={(v) => override('roughingFeedrate', v)}
            className={inputClass}
          />
        </Field>
        <Field
          className="lg:col-span-2"
          label="Plunge Rate (mm/m)"
          hint="How fast the roughing bit is driven down into the stock at the start of each cut."
        >
          <NumberInput
            step={50} min={10} max={2000} integer
            disabled={!options.roughingEnabled}
            allowEmpty
            placeholder={String(derived.roughingPlungeRate)}
            value={overrides.roughingPlungeRate ?? null}
            onChange={(v) => override('roughingPlungeRate', v)}
            className={inputClass}
          />
        </Field>
      </Advanced>
    </div>
  );
}

/** Probing the bed and riding what it found. */
export function BedLevellingFields({
  probeCols, setProbeCols, probeRows, setProbeRows, isProbing, probeProgress, probedGrid, stats,
  onProbe, canProbe, connected, applyMeshLeveling, setApplyMeshLeveling,
}: {
  probeCols: number;
  setProbeCols: (n: number) => void;
  probeRows: number;
  setProbeRows: (n: number) => void;
  isProbing: boolean;
  probeProgress: { current: number; total: number };
  probedGrid: ProbeGrid | null;
  stats: GridStats | null;
  onProbe: () => void;
  canProbe: boolean;
  /** Whether a machine is connected. Probing is a physical measurement, so it
   *  is refused without one rather than faked. */
  connected: boolean;
  applyMeshLeveling: boolean;
  setApplyMeshLeveling: (on: boolean) => void;
}) {
  return (
    <div className={sectionClass}>
      <h3 className={sectionTitleClass}>Bed Levelling</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-4">
        <Field
          className="lg:col-span-2"
          label="Probe Grid"
          hint="How many points across and up the bed are touched off with G38.2. A finishing pass can be a couple of tenths deep at its shallowest, so half a millimetre of bed tilt is the difference between a surface and a scratch."
        >
          <div className="flex items-center space-x-1.5">
            <NumberInput
              step={1} min={2} max={15} integer
              value={probeCols}
              onChange={(v) => v !== undefined && setProbeCols(v)}
              className={`${inputClass} px-2`}
              aria-label="Probe points across X"
            />
            <span className="text-xs font-medium text-slate-400">&times;</span>
            <NumberInput
              step={1} min={2} max={15} integer
              value={probeRows}
              onChange={(v) => v !== undefined && setProbeRows(v)}
              className={`${inputClass} px-2`}
              aria-label="Probe points across Y"
            />
          </div>
        </Field>

        <Field
          className="lg:col-span-2"
          label="Measure Bed"
          hint="Runs the probe over the job's own footprint. It is a real measurement: G38.2 plunges slowly until the controller's probe input triggers, which needs the tool clipped to a conductive bed or plate, or a touch probe on the input. Jog the tool to a few millimetres above the surface first — it probes down relative to there and makes no absolute Z move, so a wrong datum can't drive it into the work. Needs a machine connected, and there is nothing to measure without one."
        >
          <button
            type="button"
            onClick={onProbe}
            disabled={isProbing || !canProbe || !connected}
            className="w-full py-1.5 px-3 bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600
                       disabled:opacity-40 text-slate-700 dark:text-slate-200 text-xs font-semibold rounded-lg
                       flex items-center justify-center space-x-1.5 cursor-pointer transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-blue-500 ${isProbing ? 'animate-spin' : ''}`} />
            <span>
              {isProbing
                ? `Probing ${probeProgress.current}/${probeProgress.total}…`
                : !connected
                  ? 'Connect a machine to probe'
                  : `Probe ${probeCols}×${probeRows} Grid`}
            </span>
          </button>
        </Field>

        <Field
          className="lg:col-span-2"
          hintAlign="end"
          label="Depth Compensation"
          hint="Rides the measured surface so the carve keeps a constant depth over a bed or a board that is not flat. Needs a probed grid."
        >
          <Segmented
            value={applyMeshLeveling && probedGrid ? 'on' : 'off'}
            onChange={(v) => setApplyMeshLeveling(v === 'on')}
            options={[['off', 'Off'], ['on', probedGrid ? 'Follow Bed' : 'Needs Probe']] as const}
          />
        </Field>
      </div>

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-300">
          <div>Min Z: {stats.minZ.toFixed(3)} mm</div>
          <div>Max Z: {stats.maxZ.toFixed(3)} mm</div>
          <div>Total warp: {stats.spanZ.toFixed(3)} mm</div>
          <div>Average: {stats.avgZ.toFixed(3)} mm</div>
        </div>
      )}
    </div>
  );
}

/**
 * Stands in for the toolpath viewport while the job is still being planned.
 *
 * The plan runs on a worker now, so the first result is a moment coming and
 * every change starts another. Without this the whole preview block was absent
 * until a result arrived and then popped in, jumping the dialog; here the box
 * keeps its place and says what it is waiting for. Matches ToolpathView's own
 * `w-full h-80` frame so nothing shifts when the real preview replaces it.
 */
export function PreviewPlaceholder({ label = 'Calculating the toolpath…' }: { label?: string }) {
  return (
    <div className="space-y-3">
      <div className="relative w-full h-80 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-950 overflow-hidden flex items-center justify-center">
        <div className="flex items-center gap-2 text-xs font-medium text-slate-400">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          <span>{label}</span>
        </div>
      </div>
    </div>
  );
}
