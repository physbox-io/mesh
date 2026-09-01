import React from 'react';
import { Droplets, Layers, Hand, TriangleAlert } from 'lucide-react';
import type { MoldExportResult } from '../utils/moldExporter';

/** Only the findings are needed here, so a summary from the worker will do. */
type CastingFacts = Pick<
  MoldExportResult,
  'cavityDepthMm' | 'minDraftDeg' | 'flexibleMoldAdvised' | 'lidIsBackingPlate'
>;

/**
 * What to actually do with the two blocks once they are printed.
 *
 * The export modal knew everything needed to answer this and said none of it: it
 * handed over an STL and left the casting itself — release agent, pour depth,
 * whether the mold can even let go — to be found somewhere else. Most of it is
 * not a matter of taste, and the parts that are numbers are numbers this file
 * already has, so they are computed here rather than written out as advice that
 * quietly stops matching the geometry.
 *
 * Two facts drive nearly all of it:
 *
 *   - Epoxy cures exothermically, and a deep pour insulates its own middle. WEST
 *     SYSTEM put the ceiling for their casting system at a quarter inch a pour
 *     and the manual at 10-12 mm; past that the middle can pass 150 C, which
 *     yellows and cracks the casting and softens a PLA mold around it. So the
 *     cavity depth decides the number of lifts, and it is stated as such.
 *   - A printed mold is porous and its layer lines are mechanical keys. Sealing
 *     and releasing is not optional the way it is with silicone.
 *   - Whether a mold lets go is a question about stiffness, not about which
 *     rigid filament. PLA, PETG, ABS and ASA sit between roughly 2 and 3 GPa --
 *     a factor of two, which demolds nothing. TPU is nearer 0.02, a hundred
 *     times softer, and that is the whole difference. So the panel never offers
 *     a rigid filament as a fix for grip; it offers draft, TPU, or silicone, and
 *     names ASA and PETG only where they genuinely help, which is heat: PLA goes
 *     soft around 60 C and a fast hardener in a deep pour can reach that.
 *
 * It carries no links. A URL in a shipped panel is a promise about somebody
 * else's CMS, and the ones worth citing here — a release-agent reference, an
 * epoxy maker's exotherm note — are exactly the pages that get reorganised. The
 * facts are short enough to state outright, so they are stated outright, and the
 * provenance for the numbers lives in this comment where it cannot 404.
 */

/** Deepest lift most casting epoxies will take without cooking themselves, mm. */
const SAFE_LIFT_MM = 10;

export const CastingGuide: React.FC<{ result: CastingFacts }> = ({ result }) => {
  const lifts = Math.max(1, Math.ceil(result.cavityDepthMm / SAFE_LIFT_MM));

  return (
    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-3 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
      <h4 className="font-bold text-sm text-slate-800 dark:text-slate-100">Casting into it</h4>

      {result.flexibleMoldAdvised && (
        <p className="flex items-start gap-2 rounded-lg px-2.5 py-2 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-900 text-amber-800 dark:text-amber-200">
          <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            <strong>A rigid mold will fight you here.</strong> At {result.cavityDepthMm} mm deep with{' '}
            {result.minDraftDeg}° on its steepest wall, the casting has to slide the full depth along
            walls that are nearly parallel to the pull. Three ways out: raise <strong>Draft</strong> to
            3°, which frees a rigid mold and costs{' '}
            {(result.cavityDepthMm * Math.tan((3 * Math.PI) / 180)).toFixed(1)} mm of lateral detail;
            print it in <strong>TPU</strong>, which peels off instead of gripping; or take a silicone
            negative off the printed mold and cast into that. Switching between rigid filaments will
            not do it — PLA, PETG and ASA are all within a factor of two on stiffness, where TPU is a
            hundred times softer.
          </span>
        </p>
      )}

      <ol className="space-y-2 list-none">
        <li className="flex items-start gap-2">
          <Layers className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>Print cavity-up</strong> — both halves are laid flat outer face down, so nothing
            needs support. Fine layers on the cavity: every layer line prints itself into the casting.
            Four walls or more, or resin wicks into the infill.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Droplets className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>Seal, then release.</strong> A printed mold is porous and its layer lines key into
            the resin. Seal the cavity — a brush-on epoxy print coating is what the release-agent
            charts assume for FDM — then work a wax or a PVA/silicone release spray into every valley.
            This is the step that decides whether you get a casting or a ruined mold.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Droplets className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>
              Pour in {lifts} {lifts === 1 ? 'lift' : 'lifts'}
            </strong>{' '}
            {result.cavityDepthMm > SAFE_LIFT_MM ? (
              <>
                — the cavity is {result.cavityDepthMm} mm deep and most casting epoxies want no more
                than ~{SAFE_LIFT_MM} mm at a time, or the middle of the pour overheats. Let each lift
                go tacky first, or use a slow deep-pour hardener and do it in one. That heat is also
                the one place the rigid filaments differ: PLA softens around 60 °C, PETG nearer 80 and
                ASA around 100, so a fast hardener in a pour this deep is an argument for printing the
                mold in something other than PLA.
              </>
            ) : (
              <>
                — {result.cavityDepthMm} mm is inside the ~{SAFE_LIFT_MM} mm most casting epoxies take
                in one go. Check your resin's datasheet.
              </>
            )}{' '}
            Brush a thin skim coat into the detail first to break surface tension, then fill.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Hand className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>Close it, or don't.</strong>{' '}
            {result.lidIsBackingPlate
              ? 'The lid holds none of the shape here — screed the back flush and leave it off, or set it on afterwards as a press for a flat, glossy back. The vents let the excess out.'
              : 'Seat the lid on the pins, band it lightly closed — there is no injection pressure to fight — and let the excess escape through the vents. Pour through the sprue.'}{' '}
            Full cure, then pry at the corner notches.
          </span>
        </li>
      </ol>
    </div>
  );
};
