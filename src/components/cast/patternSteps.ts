// ---------------------------------------------------------------------------
// What to do with a printed metal pattern, step by step
// ---------------------------------------------------------------------------

import type { CastSummary } from '../../utils/castPatternExporter';

export const round = (n: number) => Math.round(n);

/** The walkthrough's note on what Prepare for Casting put into the model. */
function prepLine(draftDeg: number, edges: { chamferMm: number; filletMm: number } | null): string {
  const parts: string[] = [];
  if (draftDeg > 0) parts.push(`the walls carry ${draftDeg}° of draft`);
  if (edges && (edges.chamferMm > 0 || edges.filletMm > 0)) {
    parts.push(`outside edges are chamfered up to ${edges.chamferMm} mm and inside corners filleted up to ${edges.filletMm} mm`);
  }
  const text = parts.join('; ');
  return `The model is prepared for casting: ${text}. It is in the model itself, so the plain STL export has it too.`;
}
export const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * How hot to have the flask when the metal goes in, °C. Investment is poured
 * into a flask still well above room temperature so thin sections do not chill
 * off mid-fill, and the rule of thumb across the hobby range is roughly half
 * the pour temperature — cooler for aluminium, glowing for silver and bronze —
 * kept inside what plaster investment survives and rounded to something a kiln
 * dial can actually be set to.
 */
const flaskTempC = (pourC: number) => Math.round(Math.min(550, Math.max(200, pourC * 0.55)) / 25) * 25;

/** The walkthrough for a pattern, sand or lost PLA, with the figures this one needs. */
export function patternSteps(summary: CastSummary | null, addGating: boolean, lostPla: boolean): string[] {
  const metalLabel = summary?.metalLabel ?? '';
  return [
    ...(summary && (summary.draftDeg > 0 || summary.edgesMm) ? [prepLine(summary.draftDeg, summary.edgesMm)] : []),
    ...(lostPla ? [
      summary
        ? `Print the pattern (${round1(summary.patternSizeMm.x)} × ${round1(summary.patternSizeMm.y)} × ${round1(summary.patternSizeMm.z)} mm, ≈${round(summary.patternPlasticG)} g). It is grown ${summary.shrinkPercent}% so the casting shrinks to the ${round1(summary.partSizeMm.x)} × ${round1(summary.partSizeMm.y)} × ${round1(summary.partSizeMm.z)} mm part. Print it hollow — two or three walls, about 10% infill — so there is less plastic to burn and less of it to push outwards as it softens. Every layer line ends up in the casting, so fine layers and a sand or a filler-primer skim pay off here.`
        : 'Print the pattern once the model is ready.',
      addGating
        ? 'The sprue, cup and vents are printed on. Check the sprue is fused to the pattern rather than balanced on it, and drill a small drain hole from the hollow interior into the sprue so the melted PLA has a way out.'
        : 'Sprue it yourself: a rod from the heaviest section up to a pouring cup, and a thin vent from each high point and blind pocket up to the top of the flask.',
      summary && summary.flaskDiaMm > 0
        ? `Stand it in a flask about ⌀${round(summary.flaskDiaMm)} × ${round(summary.flaskHeightMm)} mm, cup upwards and level with the flask top, and seal the base with tape or clay. That leaves roughly 12 mm of investment all round, which is the least that reliably holds.`
        : 'Stand it in a flask, cup upwards and level with the flask top, sealed at the base.',
      summary && summary.investmentPowderG > 0
        ? `Mix about ${round(summary.investmentPowderG)} g of investment into ${round(summary.investmentWaterG)} g of water — powder into water, never the other way — for three minutes. Vacuum or vibrate the bubbles out, pour down the side of the flask rather than over the pattern, debubble again, and leave it to set for at least two hours.`
        : 'Mix the investment, debubble it, pour it down the side of the flask and leave it to set.',
      'Burn out in a kiln, flask inverted over a tray so the PLA drains. Hold around 150°C to drive off the water, ramp to 300°C to soften and run the plastic out, then up to 730°C and hold until no smoke comes off and the sprue hole glows clean inside. Call it six to eight hours; rushing it cracks the flask.',
      summary
        ? `Bring the flask down to about ${flaskTempC(summary.pourC)}°C and hold it there — hot enough that the metal does not chill off in the thin sections, cool enough that the casting is not a coarse grain.`
        : 'Bring the flask down to pouring temperature and hold it there.',
      summary
        ? `Melt and pour about ${round(summary.pourWeightG)} g of ${metalLabel.toLowerCase()} at roughly ${summary.pourC}°C — casting plus sprue and cup, with a margin. Pour in one go and keep the cup full; vacuum-assist or a centrifuge if the part has thin sections.`
        : 'Melt the metal and pour it in one go, keeping the cup full.',
      'Let it freeze, then quench the flask in a bucket of water — the investment shatters off. Cut off the sprue and vents (remelt them), and finish the part.',
    ] : [
      summary
        ? `Print the pattern (${round1(summary.patternSizeMm.x)} × ${round1(summary.patternSizeMm.y)} × ${round1(summary.patternSizeMm.z)} mm). It is grown ${summary.shrinkPercent}% so the casting shrinks to the ${round1(summary.partSizeMm.x)} × ${round1(summary.partSizeMm.y)} × ${round1(summary.partSizeMm.z)} mm part. Print it solid, and sand or seal the layer lines for a cleaner mould.`
        : 'Print the pattern once the model is ready.',
      'Set the pattern flat-back-down in the drag (the lower half of the flask), parting face on the board. Dust it with parting powder so the sand releases.',
      'Ram sand over it, firm and even, strike off level, then roll the drag over.',
      'Dust the parting face, set the cope (upper half) on top, and ram it full.'
        + (addGating ? ' The printed sprue and riser form their own openings.' : ' Set a sprue pin and a riser pin, then ram around them.'),
      'Lift the cope off, gently draw the pattern straight up out of the drag, and cut a short gate from the runner into the cavity if you rammed one by hand. Poke a few fine vents.',
      'Close the cope back onto the drag. Weight it or clamp it, so the metal head does not lift the cope.',
      summary
        ? `Melt and pour about ${round(summary.pourWeightG)} g of ${metalLabel.toLowerCase()} at roughly ${summary.pourC}°C — cast plus gating, with a margin. Pour steadily and keep the sprue full.`
        : 'Melt the metal and pour it steadily, keeping the sprue full.',
      'Let it freeze and cool, then shake out. Cut off the sprue, runner and riser (remelt them), and finish the part.',
    ]),
  ];
}
