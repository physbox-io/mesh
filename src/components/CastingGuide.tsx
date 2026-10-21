import React from 'react';
import { Droplets, Layers, Hand } from 'lucide-react';
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

export const CastingGuide: React.FC<{ result: CastingFacts; moldType?: 'clamshell' | 'open' }> = ({
  result,
  moldType = 'clamshell',
}) => {
  const lifts = Math.max(1, Math.ceil(result.cavityDepthMm / SAFE_LIFT_MM));
  const isOpen = moldType === 'open';

  return (
    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-3 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
      <h4 className="font-bold text-sm text-slate-800 dark:text-slate-100">Casting into it</h4>

      <ol className="space-y-2 list-none">
        <li className="flex items-start gap-2">
          <Layers className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>Print cavity-up.</strong>{' '}
            {isOpen
              ? 'The mold is laid flat outer face down, so nothing needs support.'
              : 'Both halves are laid flat outer face down, so nothing needs support.'}{' '}
            Fine layers on the cavity: every layer line prints itself into the casting.
            Four walls or more, or resin wicks into the infill.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Droplets className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>Seal, then release.</strong> Printed FDM layer lines can mechanically bond with
            casting resin. Apply an epoxy sealer or primer coat to the cavity, then apply mold
            release wax or spray before pouring.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Droplets className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>
              Pour in {lifts} {lifts === 1 ? 'lift' : 'lifts'}.
            </strong>{' '}
            {result.cavityDepthMm > SAFE_LIFT_MM ? (
              <>
                Cavity depth is {result.cavityDepthMm} mm. Most standard casting epoxies recommend
                pouring in layers up to ~{SAFE_LIFT_MM} mm, or using a deep-pour epoxy system.
              </>
            ) : (
              <>
                {result.cavityDepthMm} mm is within standard single-pour depths for most casting resins.
              </>
            )}{' '}
            Brush a thin coat into the details first to release bubbles, then fill.
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Hand className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            {isOpen ? (
              <>
                <strong>Pour and level.</strong> Pour into the deepest point of the cavity so the rising
                level pushes air out ahead of it, then screed flush or let the open back self-level.
                Full cure, then demold.
              </>
            ) : (
              <>
                <strong>Close it, or don't.</strong>{' '}
                {result.lidIsBackingPlate
                  ? 'The lid holds none of the shape here. Screed the back flush and leave it off, or set it on afterwards as a press for a flat, glossy back. The vents let the excess out.'
                  : 'Seat the lid on the pins, band it lightly closed (there is no injection pressure to fight) and let the excess escape through the vents. Pour through the sprue.'}{' '}
                Full cure, then pry at the side notches.
              </>
            )}
          </span>
        </li>
        {result.flexibleMoldAdvised && (
          <li className="flex items-start gap-2">
            <Hand className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
            <span>
              <strong>If it sticks.</strong> The walls run nearly straight down, so wax them well. If
              a casting still will not come out, raise <strong>Draft</strong> to 3°.
            </span>
          </li>
        )}
      </ol>
    </div>
  );
};
