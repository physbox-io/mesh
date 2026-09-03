// ---------------------------------------------------------------------------
// What RPM to set, and what to feed at once you have
// ---------------------------------------------------------------------------
//
// Every G-code file this app writes starts with `M3 S12000`, and until now
// nothing ever showed that number to anyone. On a machine with a closed-loop
// spindle that is fine — the controller sets it. On the VFD-and-a-dial routers
// and trim routers most of this app's users own, the `S` word does nothing at
// all: the speed is a knob on the side of the spindle, and if nobody says what
// to turn it to, it stays wherever the last job left it. Cutting hardwood with
// the dial still on the setting used for acrylic is how you get a burnt cut and
// a blunt bit, and the file that caused it never mentioned a number.
//
// So: a real recommendation, from the same two pieces of arithmetic every
// machinist uses.
//
//   RPM   = surface speed x 1000 / (pi x diameter)
//   feed  = RPM x flutes x chip per tooth
//
// Surface speed is how fast the edge may be dragged through a given material
// before it stops cutting and starts rubbing; chip load is how big a bite each
// edge should take. Both are properties of the material and the cutter, not of
// the model being carved, which is why they live here rather than in an
// exporter.
// ---------------------------------------------------------------------------

export type MaterialId =
  | 'softwood'
  | 'hardwood'
  | 'plywood'
  | 'mdf'
  | 'acrylic'
  | 'aluminium'
  | 'foam';

export interface MaterialSpec {
  id: MaterialId;
  label: string;
  /**
   * Surface speed for a carbide cutter, m/min. The speed the cutting edge
   * itself travels through the work, which is what actually wears it.
   */
  surfaceSpeedMMin: number;
  /**
   * Chip per tooth as a fraction of cutter diameter.
   *
   * Expressed as a fraction rather than an absolute because the right chip for
   * a 1 mm cutter and a 6 mm one differ by the same ratio as the cutters do —
   * a small bit simply has no room in its gullet for a big chip, and no
   * stiffness to take the load of one.
   */
  chiploadPerDia: number;
  /**
   * Hard ceiling on spindle speed, RPM, where the material sets one that the
   * surface-speed arithmetic does not.
   *
   * Only thermoplastics have this. Acrylic does not wear the tool out, it melts
   * and welds itself back into the cut behind the cutter, and the way to stop
   * that is a big chip carrying the heat away — which means a *lower* RPM than
   * the surface speed alone would ask for, not a higher one.
   */
  maxRpm?: number;
  /** One line, written for someone deciding what to clamp down. */
  note: string;
}

export const MATERIALS: MaterialSpec[] = [
  {
    id: 'softwood',
    label: 'Softwood (pine, cedar)',
    surfaceSpeedMMin: 320,
    chiploadPerDia: 0.03,
    note: 'Cuts fast and fuzzes at the edges. A sharp upcut and a brisk feed leave less fuzz than a slow one.',
  },
  {
    id: 'hardwood',
    label: 'Hardwood (oak, maple, walnut)',
    surfaceSpeedMMin: 250,
    chiploadPerDia: 0.025,
    note: 'The default assumption. Burns if the feed is too slow for the speed — burn marks mean rubbing, not cutting.',
  },
  {
    id: 'plywood',
    label: 'Plywood',
    surfaceSpeedMMin: 250,
    chiploadPerDia: 0.025,
    note: 'Glue lines blunt cutters faster than the timber does. Expect a shorter bit life than solid wood of the same hardness.',
  },
  {
    id: 'mdf',
    label: 'MDF',
    surfaceSpeedMMin: 300,
    chiploadPerDia: 0.03,
    note: 'Machines beautifully and destroys cutters — the binder is abrasive. Dust extraction is not optional here.',
  },
  {
    id: 'acrylic',
    label: 'Acrylic / polycarbonate',
    surfaceSpeedMMin: 200,
    chiploadPerDia: 0.035,
    maxRpm: 16000,
    note: 'Melts rather than wears. Big chips carry the heat out; small ones at high RPM weld the swarf back into the cut.',
  },
  {
    id: 'aluminium',
    label: 'Aluminium',
    surfaceSpeedMMin: 150,
    chiploadPerDia: 0.012,
    maxRpm: 18000,
    note: 'Shallow passes, and something wet or waxy on the cut. A dry aluminium cut packs the flutes and snaps the bit.',
  },
  {
    id: 'foam',
    label: 'Modelling foam / wax',
    surfaceSpeedMMin: 400,
    chiploadPerDia: 0.05,
    note: 'Almost no cutting load. The limit is the machine, not the material — feed it as fast as the axes will go.',
  },
];

export const DEFAULT_MATERIAL: MaterialId = 'hardwood';

export function materialSpec(id: MaterialId): MaterialSpec {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS[1];
}

/**
 * The speed range a spindle can actually be set to.
 *
 * Defaults are a common hobby router — a Makita/Katsu trim router dials 10,000
 * to 30,000, a 65 mm water-cooled spindle 8,000 to 24,000. When a controller is
 * connected its own `$30`/`$31` are better than either and should be passed in.
 */
export interface SpindleRange {
  min: number;
  max: number;
}

export const DEFAULT_SPINDLE_RANGE: SpindleRange = { min: 8000, max: 24000 };

export interface SpeedRecommendation {
  /** What to set the spindle to, RPM. */
  rpm: number;
  /** What to feed at once it is there, mm/min. */
  feedMmMin: number;
  /** Plunge rate, mm/min — always gentler than the feed. */
  plungeMmMin: number;
  /** Chip per tooth the pair works out to, mm. */
  chiploadMm: number;
  /**
   * Why the RPM is not simply the surface-speed answer, when it is not.
   *
   * Null when nothing intervened. Otherwise this is the thing worth telling
   * the operator, because each case wants a different response from them.
   */
  clampedBy: 'spindle-max' | 'spindle-min' | 'material' | 'gantry' | null;
}

/**
 * What to set the spindle to for a given cutter in a given material.
 *
 * The surface-speed answer first, then the two things that override it: what
 * the spindle can physically be set to, and what the material will tolerate.
 * Small cutters are the interesting case — the arithmetic asks for 50,000 RPM
 * for a 1.5 mm bit in pine, no hobby spindle will do it, and the honest answer
 * is "as fast as yours goes, and then feed it slower than the textbook says
 * because you are cutting under speed". That is what `clampedBy` is for.
 */
export function recommendSpeeds(input: {
  diameterMm: number;
  flutes: number;
  material: MaterialId;
  spindle?: SpindleRange | null;
  /**
   * Fastest the gantry will actually track while cutting, mm/min — the lower of
   * the machine's X and Y maximum rates, from `$110`/`$111` when a controller
   * is connected.
   *
   * This is not a detail. When the chipload-correct feed is faster than the
   * machine can hold, the fix is to turn the spindle *down*, not to feed
   * slower: chip per tooth is feed divided by RPM and flutes, so slowing the
   * feed on its own thins the chip until the edge stops cutting and starts
   * rubbing — which is what burns wood, welds acrylic to the flutes and dulls
   * carbide. Backing the RPM off keeps the chip the right thickness at a feed
   * the machine can actually achieve.
   */
  maxFeedMmMin?: number;
  /**
   * Fraction of the ideal chip to take, for a cutter that is hanging a long way
   * out of the collet or is otherwise not going to enjoy full load. 1 is the
   * textbook figure.
   */
  derate?: number;
}): SpeedRecommendation {
  const spec = materialSpec(input.material);
  const range = input.spindle ?? DEFAULT_SPINDLE_RANGE;
  const dia = Math.max(0.1, input.diameterMm);
  const flutes = Math.max(1, Math.round(input.flutes));
  const derate = Math.min(1, Math.max(0.2, input.derate ?? 1));

  const ideal = (spec.surfaceSpeedMMin * 1000) / (Math.PI * dia);
  const chipload = spec.chiploadPerDia * dia * derate;
  const feedPerRev = flutes * chipload;

  let clampedBy: SpeedRecommendation['clampedBy'] = null;
  let rpm = ideal;
  if (spec.maxRpm !== undefined && rpm > spec.maxRpm) {
    rpm = spec.maxRpm;
    clampedBy = 'material';
  }
  // Turn the spindle down rather than starve the chip — see `maxFeedMmMin`.
  if (input.maxFeedMmMin !== undefined && input.maxFeedMmMin > 0 && feedPerRev > 0) {
    const rpmForMaxFeed = input.maxFeedMmMin / feedPerRev;
    if (rpm > rpmForMaxFeed) {
      rpm = rpmForMaxFeed;
      clampedBy = 'gantry';
    }
  }
  if (rpm > range.max) {
    rpm = range.max;
    clampedBy = 'spindle-max';
  }
  if (rpm < range.min) {
    rpm = range.min;
    // A spindle that will not go slow enough is the aluminium problem, and it
    // matters more than a spindle that will not go fast enough: too fast in a
    // soft metal is a welded flute within a few centimetres.
    clampedBy = 'spindle-min';
  }
  rpm = Math.round(rpm / 500) * 500;

  // The feed the chosen speed implies, then held to what the gantry can track —
  // reached only when the spindle floor was already the binding constraint,
  // which `clampedBy` has recorded.
  let feed = rpm * feedPerRev;
  if (input.maxFeedMmMin !== undefined && input.maxFeedMmMin > 0) {
    feed = Math.min(feed, input.maxFeedMmMin);
  }
  feed = Math.round(feed / 10) * 10;

  return {
    rpm,
    feedMmMin: Math.max(50, feed),
    // Downward is the direction a cutter clears chips worst and bends out of
    // trouble least, so it never gets the full feed.
    plungeMmMin: Math.max(30, Math.round(feed / 3 / 10) * 10),
    chiploadMm: chipload,
    clampedBy,
  };
}

/** The sentence to put in front of someone before they press start. */
export function describeSpeedRecommendation(
  rec: SpeedRecommendation,
  material: MaterialId,
  diameterMm: number
): string {
  const spec = materialSpec(material);
  const base =
    `${rec.rpm.toLocaleString()} RPM and ${rec.feedMmMin} mm/min ` +
    `(${rec.chiploadMm.toFixed(3)} mm per tooth) for a ${diameterMm} mm cutter in ${spec.label.toLowerCase()}.`;

  switch (rec.clampedBy) {
    case 'spindle-max':
      return `${base} Spindle maximum RPM is lower than ideal; feed rate has been adjusted accordingly.`;
    case 'spindle-min':
      return `${base} Spindle minimum RPM is higher than ideal; use shallow passes to prevent heat buildup.`;
    case 'material':
      return `${base} Held down deliberately: ${spec.note}`;
    case 'gantry':
      return `${base} Spindle RPM adjusted to match maximum machine feed rate while maintaining target chip thickness.`;
    default:
      return base;
  }
}
