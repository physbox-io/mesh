// ---------------------------------------------------------------------------
// What to do with a printed metal pattern, step by step
// ---------------------------------------------------------------------------

import type { CastSummary } from '../../utils/castPatternExporter';

export const round = (n: number) => Math.round(n);

/** The walkthrough's note on what Prepare for Casting put into the model. */
function prepLine(draftDeg: number, edges: { chamferMm: number; filletMm: number } | null): string {
  const parts: string[] = [];
  if (draftDeg > 0) parts.push(`${draftDeg}° draft`);
  if (edges && (edges.chamferMm > 0 || edges.filletMm > 0)) {
    parts.push(`${edges.chamferMm} mm chamfers and ${edges.filletMm} mm fillets`);
  }
  return `Prepared for casting with ${parts.join(' and ')}.`;
}
export const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * How hot to have the flask when the metal goes in, °C.
 */
const flaskTempC = (pourC: number) => Math.round(Math.min(550, Math.max(200, pourC * 0.55)) / 25) * 25;

/** The walkthrough for a pattern, sand or lost PLA, with the figures this one needs. */
export function patternSteps(summary: CastSummary | null, addGating: boolean, lostPla: boolean): string[] {
  const metalLabel = summary?.metalLabel ?? '';
  return [
    ...(summary && (summary.draftDeg > 0 || summary.edgesMm) ? [prepLine(summary.draftDeg, summary.edgesMm)] : []),
    ...(lostPla ? [
      summary
        ? `Print the pattern (${round1(summary.patternSizeMm.x)} × ${round1(summary.patternSizeMm.y)} × ${round1(summary.patternSizeMm.z)} mm, ≈${round(summary.patternPlasticG)} g, scaled +${summary.shrinkPercent}% for shrinkage) with 2–3 walls and ~10% infill.`
        : 'Print the pattern with 2–3 walls and ~10% infill.',
      addGating
        ? 'Verify the printed sprue, cup, and vents are fused, and drill a drain hole from the hollow interior into the sprue.'
        : 'Attach a sprue to the heaviest section and thin vents from high points to the flask top.',
      summary && summary.flaskDiaMm > 0
        ? `Mount cup-up in a ⌀${round(summary.flaskDiaMm)} × ${round(summary.flaskHeightMm)} mm flask (~12 mm wall clearance) and seal the base.`
        : 'Mount cup-up in a flask and seal the base.',
      summary && summary.investmentPowderG > 0
        ? `Mix ~${round(summary.investmentPowderG)} g investment into ${round(summary.investmentWaterG)} g water, degas, pour down the flask wall, and let set for 2+ hours.`
        : 'Mix investment, degas, pour down the flask wall, and let set.',
      'Burn out inverted in a kiln: hold at 150°C, ramp to 300°C to drain PLA, then hold at 730°C until ash-free (6–8 hours total).',
      summary
        ? `Stabilize the flask at ~${flaskTempC(summary.pourC)}°C before pouring.`
        : 'Stabilize the flask at pouring temperature.',
      summary
        ? `Melt and pour ~${round(summary.pourWeightG)} g of ${metalLabel.toLowerCase()} at ~${summary.pourC}°C in one continuous stream.`
        : 'Melt the metal and pour in one continuous stream.',
      'Cool until solid, quench to break away investment, and cut off the sprue and vents.',
    ] : [
      summary
        ? `Print the pattern (${round1(summary.patternSizeMm.x)} × ${round1(summary.patternSizeMm.y)} × ${round1(summary.patternSizeMm.z)} mm, scaled +${summary.shrinkPercent}% for shrinkage) and smooth layer lines.`
        : 'Print the pattern and smooth layer lines.',
      'Place the pattern parting-face down in the drag on a molding board and dust with parting powder.',
      'Ram sand firmly over the pattern, strike off flat, and flip the drag over.',
      'Dust the parting face, place the cope on top, and ram full' + (addGating ? ' around the printed sprue and riser.' : ' around sprue and riser pins.'),
      'Lift the cope, draw the pattern straight out, cut a gate if needed, and add vent holes.',
      'Close and weight or clamp the flask halves together.',
      summary
        ? `Melt and pour ~${round(summary.pourWeightG)} g of ${metalLabel.toLowerCase()} at ~${summary.pourC}°C steadily keeping the sprue full.`
        : 'Melt and pour steadily, keeping the sprue full.',
      'Cool until solid, shake out the sand, and cut off the gating.',
    ]),
  ];
}
