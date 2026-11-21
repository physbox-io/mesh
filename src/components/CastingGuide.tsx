import React from 'react';
import { Droplets, Layers, Hand } from 'lucide-react';
import type { MoldExportResult } from '../utils/moldExporter';
import { castMaterial, type CastMaterialId } from '../utils/castMaterials';

/** Only the findings are needed here, so a summary from the worker will do. */
type CastingFacts = Pick<
  MoldExportResult,
  'cavityDepthMm' | 'minDraftDeg' | 'flexibleMoldAdvised' | 'lidIsBackingPlate'
>;

/** Deepest lift most standard hobby casting epoxies take in an open pour without overheating, mm. */
const SAFE_LIFT_MM = 10;

/**
 * Plain-English workshop steps for an unlined rigid 3D-printed mold, adapted to
 * what is actually being poured (`material`) and whether the mold is open-top or
 * a closed two-part clamshell (`moldType`).
 *
 * Hidden when a dissolvable liner is active (`dissolvableLiner === true`),
 * because `result.liner.steps` gives exact instructions for the chosen filament
 * pair and solvent bath — whereas telling a maker to seal layer lines with
 * primer or epoxy sealer would waterproof a soluble PVA/BVOH/HIPS liner so it
 * can never dissolve.
 */
export const CastingGuide: React.FC<{
  result: CastingFacts;
  moldType?: 'clamshell' | 'open';
  material?: CastMaterialId;
  dissolvableLiner?: boolean;
}> = ({
  result,
  moldType = 'clamshell',
  material = 'epoxy',
  dissolvableLiner = false,
}) => {
  if (dissolvableLiner) return null;

  const mat = castMaterial(material);
  const guide = mat.rigidGuide ?? 'resin';
  const lifts = Math.max(1, Math.ceil(result.cavityDepthMm / SAFE_LIFT_MM));
  const isOpen = moldType === 'open';
  const isFoodOrIce = Boolean(mat.meltsInBath);

  const printLine = isFoodOrIce
    ? 'Print flat with 4+ perimeters using clean hardware; raw FDM layer lines trap food residue, so press thin food-safe wrap in or use this print to make a food-grade silicone mold.'
    : 'Print flat with fine layers and 4+ perimeters so liquid cannot seep into the infill.';

  let sealLine: string;
  if (guide === 'freeze') {
    sealLine = 'Do not use primer, paint, or chemical mold release for ice; leave clean plastic bare so warm air loosens the frozen block.';
  } else if (guide === 'temper') {
    sealLine = 'Never apply hardware primers, epoxy sealers, or petroleum release for chocolate; use only food-safe cocoa butter or casting film.';
  } else if (guide === 'slurry') {
    sealLine = `Brush a light coat of petroleum jelly, mineral oil, or soapy mold release onto the cavity and parting faces so set ${mat.label.toLowerCase()} slips free of FDM layer lines.`;
  } else if (guide === 'hot-melt') {
    sealLine = 'Mist a light silicone or soapy release onto steep walls, and let melted wax cool below ~55–60 °C before pouring so PLA walls do not soften.';
  } else if (guide === 'addition-silicone') {
    sealLine = 'Brush dish-soap/alcohol or wax release onto layer lines, and keep sulfur clay, latex gloves, and uncured SLA UV resin away (they poison platinum silicone).';
  } else if (guide === 'condensation-silicone') {
    sealLine = 'Smooth heavy layer lines if needed and brush on wax or soapy mold release before pouring the silicone.';
  } else if (guide === 'fast-resin') {
    sealLine = 'Keep the printed mold bone-dry (trace moisture foams polyurethane resin), seal layer lines with acrylic primer, and apply polyurethane mold release.';
  } else {
    sealLine = 'Seal FDM layer lines with acrylic primer or sanding sealer, then apply paste wax or PVA/silicone mold release before pouring so cured epoxy cannot key into the print.';
  }

  let pourHeading: string;
  let pourLine: string;
  if (guide === 'freeze') {
    pourHeading = 'Fill & freeze:';
    pourLine = 'Fill with boiled-and-cooled water for clearer ice, leave a little headroom for expansion, and freeze solid.';
  } else if (guide === 'temper') {
    pourHeading = 'Temper & chill:';
    pourLine = 'Pour tempered chocolate (~31 °C), tap the mold gently on the counter to pop air bubbles, and chill until it contracts slightly from the walls.';
  } else if (guide === 'slurry') {
    pourHeading = 'Mix & tap out bubbles:';
    pourLine = isOpen
      ? `Pour ${mat.label.toLowerCase()} into the lowest spot first, tap or vibrate the sides for a minute to shake air bubbles off the walls, and screed the top flat.`
      : `Clamp or clip the halves firmly shut, pour ${mat.label.toLowerCase()} steadily into the top funnel while tapping the sides to work air up the vents.`;
  } else if (guide === 'hot-melt') {
    pourHeading = 'Pour & top up:';
    pourLine = 'Pour steadily below ~58 °C, then top up the center or sprue funnel as the wax cools and shrinks.';
  } else if (mat.silicone) {
    pourHeading = 'Pour a thin stream:';
    pourLine = 'Scrape the mixing cup sides and bottom thoroughly, then pour a thin ribbon into the lowest point so bubbles stretch and pop on the way in.';
  } else if (guide === 'fast-resin') {
    pourHeading = 'Pour in one go:';
    pourLine = 'Polyurethane sets fast — weigh and mix accurately, then pour steadily in one pass before it thickens.';
  } else if (isOpen) {
    pourHeading = `Pour in ${lifts} ${lifts === 1 ? 'lift' : 'lifts'}:`;
    pourLine =
      result.cavityDepthMm > SAFE_LIFT_MM
        ? `Check your epoxy bottle's ratio (often 1:1 by volume or 2:1 by weight — brands vary). Brush a thin coat into surface details, then pour this ${result.cavityDepthMm} mm open cavity in ~${SAFE_LIFT_MM} mm layers (or use deep-pour epoxy) so cure heat does not warp PLA.`
        : `Check your epoxy bottle's ratio (often 1:1 by volume or 2:1 by weight — brands vary), stir slowly, brush a thin coat into details to release bubbles, then fill the ${result.cavityDepthMm} mm cavity.`;
  } else {
    pourHeading = result.cavityDepthMm > SAFE_LIFT_MM * 2 ? 'Use slow / deep-pour epoxy:' : 'Mix & pour slowly:';
    pourLine =
      result.cavityDepthMm > SAFE_LIFT_MM * 2
        ? `A closed ${result.cavityDepthMm} mm cavity cannot be poured in open layers: use slow-cure / deep-pour casting epoxy so cure heat stays under PLA's ~60 °C softening point. Follow your bottle's ratio (commonly 1:1 by volume or 2:1 by weight).`
        : `Follow your epoxy bottle's exact ratio (commonly 1:1 by volume or 2:1 by weight), stir slowly for 2–3 minutes scraping the sides, and let bubbles rise before pouring.`;
  }

  let closeLine: string;
  if (isOpen) {
    closeLine =
      guide === 'freeze'
        ? 'Let the mold sit at room temperature for a minute so the surface glazes free, then flex or ease the ice out.'
        : 'Let self-level and wait for a full cure/set before flexing or tapping the part out.';
  } else if (result.lidIsBackingPlate) {
    closeLine = 'Fill the open cavity half first, press the waxed flat backing lid onto the pins, weight it down, and pry at the side notches once cured.';
  } else {
    closeLine = 'Seat the lid on the registration pins, clamp or weight it shut (tape alone lets the lid float), pour slowly into the funnel until liquid shows at every vent, and pry at the side notches once cured.';
  }

  return (
    <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-800 space-y-3 text-xs leading-relaxed text-slate-700 dark:text-slate-300">
      <h4 className="font-bold text-sm text-slate-800 dark:text-slate-100">Casting into it</h4>

      <ol className="space-y-2 list-none">
        <li className="flex items-start gap-2">
          <Layers className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>Print cavity-up:</strong> {printLine}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Droplets className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>{isFoodOrIce ? 'Surface safety:' : 'Seal & release:'}</strong> {sealLine}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Droplets className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>{pourHeading}</strong> {pourLine}
          </span>
        </li>
        <li className="flex items-start gap-2">
          <Hand className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
          <span>
            <strong>{isOpen ? 'Cure & demold:' : 'Close & cure:'}</strong> {closeLine}
          </span>
        </li>
        {result.flexibleMoldAdvised && !isFoodOrIce && (
          <li className="flex items-start gap-2">
            <Hand className="w-3.5 h-3.5 shrink-0 mt-0.5 text-purple-500" />
            <span>
              <strong>Steep walls:</strong> Wax vertical walls well, or add <strong>3° Draft</strong> / a <strong>Dissolvable Liner</strong> / <strong>Silicone</strong> if parts grip layer lines.
            </span>
          </li>
        )}
      </ol>
    </div>
  );
};
