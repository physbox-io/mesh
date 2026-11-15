/**
 * Cloth: fabric as MuJoCo flex. A cloth body is cut from flat pieces, each an
 * outline in pattern space, placed in 3D, then sewn together and tied to
 * other bodies. The same few parts make a t-shirt (pieces sewn edge to edge)
 * and a shade sail (one piece tied to four posts): nothing here is garment-
 * or sail-specific. See utils/cloth/.
 *
 * Everything is metres, in the cloth body's own frame, MuJoCo Z-up.
 */

/** A 2D point in pattern space: u across the piece, v up it. */
export type UV = [number, number];

/** One named stretch of a piece's outline, in order round the piece. */
export interface ClothEdge {
  id: string;
  /** Polyline. Its last point is the next edge's first and is not repeated there. */
  pts: UV[];
}

/**
 * Where a flat piece is put before anything is sewn. Pattern (u, v) maps to:
 *  - plane: origin + u*uAxis + v*vAxis.
 *  - wrap: rolled round an axis, v running along `axis`, u round it starting
 *    at `ref` and turning right-handed about `axis`. `radius` is the radius at
 *    v = 0; `taper` adds that much radius per metre of v, making a cone (a
 *    flared skirt, a sleeve that narrows). `clockwise` turns it the other way,
 *    which is how the right sleeve is the mirror of the left.
 */
export type ClothPlacement =
  | { kind: 'plane'; origin?: number[]; uAxis?: number[]; vAxis?: number[] }
  | { kind: 'wrap'; origin: number[]; axis: number[]; ref: number[]; radius: number; taper?: number; startU?: number; clockwise?: boolean }
  | GirthPlacement
  | AlongPlacement
  | PathPlacement;

/**
 * Ruled-surface placement along a smooth 3D curve through `stations`: `u` (or
 * `v` when `along: 'v'`) runs by arc length along the spline through `p`, and
 * the transverse axis (from the pattern's centreline) runs along the unit
 * transverse ruling `across` (projected orthogonal to the curve tangent).
 */
export interface PathPlacement {
  kind: 'path';
  along?: 'u' | 'v';
  stations: { p: number[]; across: number[] }[];
}

/**
 * Round a body: each row of the piece (each v) wrapped round the body's
 * cross-section at that height, by arc length from the centre of the piece
 * out to its side seam, stood `gap` clear of it. `profile` gives the
 * cross-section by height (v = 0 at `origin`, up the z axis) as its radius at
 * even angles round a centre `centreY` toward +y from the axis, angle 0 at +x
 * turning toward +y. Each row reaches round exactly to the side (+-x), so a
 * front and a back placed this way meet at their side seams; a row longer
 * than that is stood further off, so the cloth never starts inside the body.
 * `facing` -y puts the piece's centre at the front.
 */
export interface GirthPlacement {
  kind: 'girth';
  origin: number[];
  profile: { v: number; centreY: number; radii: number[] }[];
  facing: 'front' | 'back';
  gap: number;
}

/**
 * Along edges of pieces already placed: u runs along their 3D path (by
 * fraction of its length, from the first edge's start), v along `up`. How a
 * neckband starts on the neckline it will be sewn to.
 */
export interface AlongPlacement {
  kind: 'along';
  path: SeamSide;
  up: number[];
}

export interface ClothPatternPrint {
  /** Raw SVG markup (or data URL) printed onto the fabric. */
  svg: string;
  /** Width of one tile on the cloth in metres (default 0.25), or scale factor when `tile` is false. */
  scale?: number;
  /** Whether the SVG tiles across the fabric (default true) or fits each piece once. */
  tile?: boolean;
  /** Rotation of the print in degrees relative to the grain line (+v). */
  angle?: number;
}

export interface ClothPiece {
  name: string;
  edges: ClothEdge[];
  /**
   * Where the piece is cut: its rest shape, flat as the pattern was, which
   * is what its stretch and bend are measured against.
   */
  placement?: ClothPlacement;
  /**
   * Where it starts, if not there: wrapped round the form, say, with its
   * seams almost met, so it is sewn in a moment instead of pulled across the
   * room. Rest shape and lengths still come from `placement`.
   */
  start?: ClothPlacement;
  rgba?: number[];
  /** Fabric material for this piece (defaults to the cloth's material). */
  material?: ClothMaterialName;
  /** Printed SVG pattern on this piece (overrides the cloth's own). */
  pattern?: ClothPatternPrint;
  /** Trims along this piece's edges (`button`, `buckle`, `stud`, `bead`, `zipper`). */
  trims?: GarmentTrim[];
  /** Mesh finer or coarser than the cloth's spacing, e.g. 0.5 for a narrow band. */
  spacingScale?: number;
  /** Stiffer or softer than the cloth's material, e.g. 0.1 for rib knit. */
  stiffnessScale?: number;
}

/** One side of a seam: edges walked in order, each optionally backwards. */
export type SeamSide = { piece: string; edge: string; reversed?: boolean }[];

/**
 * Two edge chains sewn together. Stitches pair the two sides by fraction of
 * their length, so a longer side is eased onto a shorter one.
 */
export interface ClothSeam {
  name?: string;
  a: SeamSide;
  b: SeamSide;
}

/**
 * Cloth held to something. `edge` with `at` (0..1 along it) ties one point;
 * `edge` alone ties every point of that edge. `to` is a body name, or the
 * world when absent. `anchor` is where the point goes, in `to`'s frame (world
 * for the world): when given, the tie winds in to it over the cloth's
 * `sewTime` — how a sail corner is tensioned. Without it the point is held
 * where it starts.
 */
/**
 * A point of a cloth drawn to a place before the scene starts (ClothSpec.arrange):
 * the point of piece `piece` (a panel's or a piece's name: `hood`, `frontL`)
 * at `at` on its flat pattern, metres; `to` in the cloth's own frame (a
 * garment's, its form's), metres, Z up.
 */
export interface ClothPull {
  piece: string;
  at: [number, number];
  to: [number, number, number];
  /** Places it is drawn through on the way, in order (as a hand takes a hood up over the back of the head, not through it). */
  via?: [number, number, number][];
}

/** A point of a cloth, by its piece and where it is on the piece's flat pattern, metres. */
export interface ClothPoint {
  piece: string;
  at: [number, number];
}

/** Two points of a cloth held together (ClothSpec.fasten), drawn closed over the sew time; `trim` drawn where it fastens, at `a`. */
export interface ClothFastening {
  a: ClothPoint;
  b: ClothPoint;
  trim?: { kind: GarmentTrim['kind']; size?: number; rgba?: number[] };
}

/**
 * A piece sewn on along a line turned about that line before the scene starts
 * (ClothSpec.arrange): `turn` degrees from hanging down, 90 stood straight
 * out off the garment, about 165 turned up and over (a hood put up, a collar
 * turned up, a cap's peak set out at 90, a cuff turned back).
 */
export interface ClothTurn {
  piece: string;
  turn: number;
}

export interface ClothTie {
  name?: string;
  piece: string;
  edge: string;
  at?: number;
  to?: string;
  anchor?: number[];
  /**
   * Another cloth (its node's name) to sew the point to instead of a body:
   * the nearest point of it where the two start, drawn together over the sew
   * time. How an ornament goes on a garment.
   */
  toCloth?: string;
}

export type ClothMaterialName = 'jersey' | 'rib' | 'spandex' | 'woven' | 'canvas' | 'shadeCloth' | 'denim' | 'leather' | 'taffeta' | 'velvet';

/**
 * An elastic band embedded along a chain of piece edges. Gathers the fabric edge
 * down toward its relaxed length (by `ratio` of the flat cut length or `length`
 * in metres) with axial stiffness `stiffness` (E*A, newtons), while the cut
 * cloth stops stretching once pulled out to its full flat length.
 */
export interface ClothElastic {
  name?: string;
  along: SeamSide | { piece: string; edge: string; reversed?: boolean };
  /** Relaxed elastic length over the flat cut length (0..1, default 0.75). */
  ratio?: number;
  /** Relaxed elastic length, metres (overrides `ratio` when given). */
  length?: number;
  /** Axial stiffness E*A, newtons (force per unit strain; default 12, soft: much stiffer gathers into a sawtooth). */
  stiffness?: number;
}

export interface ClothMaterial {
  /** kg/m^2. */
  arealDensity: number;
  /** Young's modulus, Pa, of a sheet `thickness` thick. */
  young: number;
  poisson: number;
  /** Metres. Sets stiffness with `young`; contact is separate. */
  thickness: number;
  /** Whether it resists bending as well as stretch. A membrane need not, and is cheaper. */
  bending: boolean;
  damping: number;
  friction: number;
  /**
   * Drag coefficient against wind blowing square on. About 1.2 for a solid
   * sheet; less for an open weave, which lets air through.
   */
  windCd: number;
  /**
   * How far it stretches to take a shape it was not cut to, as a fraction.
   * A knit gives, and goes over a bust as it is; a woven barely does, and a
   * garment of it is shaped there with darts.
   */
  give: number;
  /**
   * How much longer than its seam an edge of it can be eased in, shrunk with
   * the iron and never seen, as a fraction: a wool or cotton sleeve's cap
   * into its armhole. Leather and crisp silks barely ease and take a dart
   * instead; a knit needs neither, it gives.
   */
  easeIn: number;
}

export interface ClothSpec {
  /**
   * A garment modelled in 3D round a body form (utils/cloth/garmentShell):
   * the cloth is its shell, cut into panels at its seams and flattened into
   * pieces. Otherwise the cloth is `pieces`, placed and sewn.
   */
  garment?: GarmentDraft;
  pieces?: ClothPiece[];
  seams?: ClothSeam[];
  ties?: ClothTie[];
  /**
   * The cloth arranged by hand before the scene starts, as a wearer arranges
   * what they wear: each a point of it drawn to a place, held a moment and
   * let go to settle. A hood pulled up over a head, a collar turned up, a
   * sleeve pushed up, a peak set straight.
   */
  arrange?: (ClothPull | ClothTurn)[];
  /**
   * Points held together, as a clasp, a snap, a button through its hole or a
   * hook holds them: a bag's flap to its front, a wrap dress's corner to its
   * side, a cuff's tab to its sleeve.
   */
  fasten?: ClothFastening[];
  /** Elastic bands embedded along piece edges. */
  elastics?: ClothElastic[];
  /** Printed SVG pattern across the cloth's pieces. */
  pattern?: ClothPatternPrint;
  material?: ClothMaterialName;
  /** Overrides of the named material. */
  materialOverrides?: Partial<ClothMaterial>;
  /** Mesh edge length, metres. Finer drapes better and costs more. */
  spacing?: number;
  /**
   * Seconds over which seams close and anchored ties wind in. The cloth is
   * held weightless until then, as garment CAD does: falling while the seams
   * close would drop the pieces before they meet.
   */
  sewTime?: number;
  /**
   * Kept off itself and off the other cloth of its layer: folds, pleats, a
   * sleeve against the body, two tails (utils/cloth/clothSelf). Default true.
   */
  selfCollide?: boolean;
  /**
   * Which layer it is worn as: cloth lies outside every cloth of a lower
   * layer (a jacket, 2, over a shirt, 1, over jeans, 0). Cloth of one layer
   * keeps off itself (selfCollide), both ways.
   */
  layer?: number;
  /**
   * Set when the cloth was drafted for a body form: regenerate from these
   * whenever the form's measurements change. See utils/cloth/garments.ts.
   */
  draft?: GarmentDraft;
  /**
   * How a garment starts: worn, sewn on the form (the default); or as its
   * pieces, each laid out flat a little off where it goes, sewn up over the
   * sew time when the scene plays.
   */
  layout?: 'worn' | 'pieces';
}

/**
 * An edge of a garment as it is cut (`neckline`, `hem`, `waist`, `cuff`,
 * `armhole`, `opening`, a tube's `top` and `end`) or one of its seams by
 * name (`side`, `centre`, `armholeL`, `underarmL`, `elbowL`, `dartL`, ...).
 */
export type GarmentLine = string;

/**
 * Something fixed along a line of a garment: studs, buttons (with matching
 * buttonholes across an open seam) or beads at a spacing (`size` across them);
 * a zipper, whose teeth run the whole line.
 */
export interface GarmentTrim {
  kind: 'stud' | 'button' | 'buttonhole' | 'bead' | 'zipper' | 'buckle' | 'stitch';
  along: GarmentLine;
  /** Between one and the next, metres; a zipper's teeth set their own. */
  spacing?: number;
  /** Across one, metres. */
  size?: number;
  rgba?: number[];
  /**
   * For buttons or a zip along an open seam (`opening`): whether each button
   * is fastened through its matching buttonhole on the opposite edge, or the
   * zip done up, holding the two sides together (default true). A number is
   * how much of it is done up from the bottom, 0 to 1 (a zip undone at the
   * neck: 0.85; the top button open). Buttons on a stand are all or none.
   */
  fastened?: boolean | number;
  /** For buttons on an opening: the wearer's side whose front laps over and carries the holes (default 'right'). */
  lap?: 'left' | 'right';
  /** For buttons on an opening: how far the lapping front runs on over the other, metres (default 2.2 buttons; 0 for edge to edge). */
  stand?: number;
  /**
   * Set off across the line, metres: into the cloth from an edge (from a seam, into one side of it, the same all
   * along; negative, the other); several, a row at each (topstitching in a double row: [0.003, 0.009]).
   */
  offset?: number | number[];
}

/**
 * Elastic embedded along a named garment edge or seam (`waist`, `cuff`, `hem`,
 * `neckline`, ...; `top` is the garment's top opening, whatever it is called).
 */
export interface GarmentElastic {
  along: GarmentLine;
  /** Relaxed elastic length over the flat cut length (0..1, default 0.75). */
  ratio?: number;
  /** Relaxed elastic length, metres (overrides `ratio` when given). */
  length?: number;
  /** Axial stiffness E*A, newtons (force per unit strain; default 12, soft: much stiffer gathers into a sawtooth). */
  stiffness?: number;
}

/**
 * Boning: a stiff strip in a channel along a line of the garment (a seam, or
 * an edge), holding its modelled shape: bones up a bodice's princess seams, a
 * hoop round a skirt along a seam at a height, a wire in a brim. It does not
 * stretch, and resists bending by its flexural rigidity.
 */
export interface GarmentRod {
  along: GarmentLine;
  /** What it is: spiral or flat steel (corsetry), plastic (Rigilene), or hoop steel (crinolines). Sets its stiffness and weight. */
  kind?: 'spiralSteel' | 'flatSteel' | 'plastic' | 'hoopSteel';
  /** Flexural rigidity E*I, N m^2, over its kind's. */
  stiffness?: number;
  /** Only between these heights above the floor, metres (a bodice's bones stop at the waist). */
  z?: [number, number];
}

/**
 * A patch pocket on a panel of the garment, sewn on round its sides and
 * bottom, open at the top: placed as a pattern marks it, on the flat piece.
 */
export interface GarmentPocket {
  /** The panel it goes on (`front`, `backL`, `sleeveL`, ...); a name without its L or R takes both, mirrored. */
  panel: string;
  /** Where its middle is, as fractions across and up the panel's flat piece (default 0.5, 0.6); across is mirrored on a right-hand panel. */
  at?: [number, number];
  /** Width across the pocket, metres (default 0.11). */
  width?: number;
  /** Height of the pocket, metres (default 0.12). */
  height?: number;
  rgba?: number[];
}

/**
 * A belt round a garment, buckled at the front, drawn in so it takes the
 * garment in: along its top edge if it hangs from a band, else round the
 * waist; or round it at a height (round both legs, below the body).
 */
export interface GarmentBelt {
  /** Strap width, metres (default 0.032). */
  width?: number;
  /** Its length over the length round where it goes (default 0.97): how tight. */
  ratio?: number;
  /** Round the garment at this height above the floor, metres. */
  at?: number;
  material?: ClothMaterialName;
  rgba?: number[];
  /** Show a buckle at the centre front (default true). */
  buckle?: boolean;
}

/**
 * A collar: a piece of its own sewn to the neckline by arc length, standing
 * up the neck by `stand` and folding over at its top (the roll line) into a
 * fall `fall` wide that comes down over the stand and onto the garment. Cut
 * flat from that shape as modelled, and pressed in it. The families are
 * settings of the same few numbers: a band (mandarin) is all stand, no fall;
 * a shirt collar a stand and a fall a little wider; a flat (Peter Pan)
 * collar next to no stand and a wide fall lying on the shoulders, its
 * corners rounded; a notched collar meets lapels at their gorge. On an open
 * neckline it runs from one front edge to the other (from lapel to lapel);
 * round a closed one, it meets itself at the centre front.
 */
export interface GarmentCollar {
  /** Up the neck from the neckline to the roll line, metres (default 0.03; 0 lies flat from the seam). */
  stand?: number;
  /** The stand at the collar's front ends, metres, easing to it from the centre back (default `stand`; a notched collar's falls to about 0.01, where it meets the lapels). */
  standFront?: number;
  /** From the roll line over and down, metres (default 0.045; 0 for a band collar). */
  fall?: number;
  /** How far the fall's front corners reach on past the ends of the neckline, metres; negative holds them back (a spread collar). Default 0. */
  point?: number;
  /** Radius the fall's front corners are rounded to, metres (default 0: square; a Peter Pan collar's are round). */
  round?: number;
  /** The stand cut as a piece of its own, sewn to the fall along the roll line (a shirt's collar band). Default false: one piece, folded. */
  separateStand?: boolean;
  material?: ClothMaterialName;
  /** Its fabric changed from `material`'s: interfaced or padded, so it stands (a puffer's stand collar, a shirt collar's band). */
  materialOverrides?: Partial<ClothMaterial>;
  rgba?: number[];
}

/**
 * Lapels: the fronts of an opening turned back from the top button (the
 * break) up to the neckline along a roll line, the facing showing. The front
 * is cut along the roll line and runs on past it, past the opening, into the
 * lapel (one pattern piece), which starts folded back over the front and is
 * pressed so. Its top edge meets the collar at the gorge: a notched lapel's
 * point stands clear of the collar's end; a shawl collar is a lapel whose
 * top runs on round the neck (`shawl`). Needs an `opening`.
 */
export interface GarmentLapels {
  /** The break: where the lapel starts to turn back, metres below the neck point (default 0.22). */
  break?: number;
  /** Across the lapel at its top, from the roll line to its point, metres (default 0.075). */
  width?: number;
  /** How far the lapel's point stands above square to the roll line, metres: about 0 a notched lapel, more a peak lapel (default 0.01). */
  peak?: number;
  /** Where the roll line meets the neckline, as a fraction of the way out from the centre front to the neck's side (default 0.8). */
  rollAt?: number;
  /** How much of the lapel's top edge, from its point, stands free of the collar (the notch), metres; the rest is the gorge seam, sewn to the collar's end (default 0.035). */
  notch?: number;
  /** A shawl collar: the lapels run on round the back of the neck, cut in one with the fronts and seamed at the centre back, no collar of their own (`collar` gives the stand and fall round the neck). */
  shawl?: boolean;
}

/**
 * A plane through a garment, and where on it it applies: the generic line a
 * draft cuts or seams along (a princess seam, a yoke, a centre-back zip, a
 * one-shoulder neckline, a backless cut). Metres, in the form's frame: Z up,
 * +x the wearer's left, -y the front.
 */
export interface GarmentPlane {
  /** A point the plane passes through. */
  point: number[];
  /** Its normal; a cut takes away the cloth on this side. */
  normal: number[];
  /** Only where the cloth is nearest these parts of the form: skin, armL, armR, legL, legR, head. */
  on?: ('skin' | FormLimbName)[];
  /** Only on the garment's front (true) or back (false). */
  front?: boolean;
  /** Only between these heights, metres; and these x, either side. */
  z?: [number, number];
  x?: [number, number];
  /** Also its mirror image across the body's centre (x to -x): a pair, left and right. */
  mirror?: boolean;
}

/** A seam along a plane: sewn, or cut and left `open` (an opening, fastened by its trims). */
export interface GarmentPlaneSeam extends GarmentPlane {
  name: string;
  open?: boolean;
}

/** A height on the body by name: the high point of the shoulder, the shoulder, bust, waist, hip, crotch. */
export type BodyHeight = 'hps' | 'shoulder' | 'bust' | 'waist' | 'hip' | 'crotch';

/**
 * A place on the form, found on the garment where it lies over it, so it
 * follows the form when the form's measurements change. Metres, the form's
 * frame (Z up, +x the wearer's left, -y the front). One of:
 * - a point, `[x, y, z]`;
 * - a landmark of the form (its +x one), moved by `offset`;
 * - on the body's front (or `back`) at a height (a number, or a named one
 *   moved by `dz`), `x` across from the centre;
 * - on a limb: `along` it from its root (a fraction of its length, or its
 *   `joint`: the elbow, the ankle), moved `dAlong` metres, on the side of it
 *   that `face` points to (`[0, 1, 0]`: the back of an arm).
 */
export type GarmentPoint =
  | number[]
  | { landmark: 'bustPoint' | 'shoulderPoint' | 'armOrigin'; offset?: number[] }
  | { z: number | BodyHeight; dz?: number; x?: number; back?: boolean }
  | { limb: FormLimbName; along: number | 'joint'; dAlong?: number; face: number[] };

/**
 * A dart: a wedge of cloth folded out and sewn, so a flat piece takes a
 * shape it could not lie flat in. The garment is slit along a line from the
 * apex (straight as seen from the apex's side: the line through the apex
 * that its direction and the way the garment faces there span); flattened,
 * the slit opens into the dart's wedge, both legs the length of the line;
 * worn, they are sewn closed. Its width at the open end (its take-up) is not
 * asked for: it is what the piece opens by when laid flat, which is how much
 * the cloth must give there.
 */
export interface GarmentDart {
  /** Its name, as a garment line (a trim or rod can run along it); a mirrored pair is named with L and R. */
  name: string;
  /** Its point, where the shaping is and the stitching ends; for a double-ended dart, its middle, where it is widest. */
  apex: GarmentPoint;
  /** Which way it runs from the apex toward its open end: a direction in the form's frame... */
  direction?: number[];
  /** ...or toward a place on the form (one or the other; `to` wins). */
  to?: GarmentPoint;
  /**
   * How far it runs from the apex, metres, measured along its direction.
   * Unset, on until it meets a seam or an edge: single-ended, open there.
   */
  length?: number;
  /** Double-ended (a fish-eye, inside a panel): it also runs this far back the other way from the apex, metres. */
  back?: number;
  /** Also its mirror image across the body's centre (x to -x): a pair, left and right. */
  mirror?: boolean;
}

/**
 * Fullness: more cloth on one side of a seam than the seam is long, sewn in.
 * The extra lives in the flat piece and the sewing, and the drape makes of it
 * what it makes: a sleeve cap eased into its armhole with no visible fold,
 * a skirt gathered into a bodice in soft folds, pleats folded and stitched at
 * a waist and falling open below, tucks stitched down a way as shaping.
 */
export interface GarmentFullness {
  /** The seam the fuller cloth is sewn into: a draft seam's name (`waist`, `yoke`) or the garment's own (`armhole` takes both armholes). */
  along: GarmentLine;
  /**
   * How the extra goes in: `ease`, a little (up to ~6%) spread evenly, flattened
   * into the piece and never seen; `gather`, evenly over the seam (or `from`..`to`
   * of it) in soft folds; or folded into pleats: `knife` (all one way), `box`
   * (two folds turned away from each other under a flat face) or `inverted`
   * (two folds meeting). A tuck is a knife pleat stitched down (`stitched`).
   */
  kind?: 'ease' | 'gather' | 'knife' | 'box' | 'inverted';
  /** Cloth along the seam over the seam's length: ease about 1.03, gathers 1.5 to 2.5, knife pleats edge to edge 3. */
  ratio?: number;
  /** Pleats on each panel, evenly spaced (default 6). */
  count?: number;
  /** Or where each pleat's middle is, as fractions along each panel's stretch of the seam, from its left as you look at its outside. */
  at?: number[];
  /** Gathers only over this stretch of each panel's seam, as fractions from its left (default 0 to 1). */
  from?: number;
  to?: number;
  /** Pleats stitched down this far from the seam, metres (pressed pleats, release tucks); open below. */
  stitched?: number;
  /**
   * Pleats pressed: their creases set to the hem (default true). Unpressed,
   * they are folded only as far as they are stitched, and fall open below.
   */
  pressed?: boolean;
  /** Which way knife pleats' folds face, as you look at a panel's outside (default right: round the body one way). */
  facing?: 'left' | 'right';
  /** Which side of the seam carries it: the panels `below` it (a skirt from a waist) or `above` (release tucks up a bodice from its waist). Default: the one on a limb at a seam between a limb and the body (a sleeve), else below. */
  side?: 'below' | 'above';
  /** Or the panels that carry it, by name (`front` takes frontL and frontR). */
  panels?: string[];
}

export type GarmentKind = 'tshirt' | 'dress' | 'skirt' | 'gown' | 'jacket' | 'trousers' | 'tube' | 'sock' | 'hat';

/** A limb of a body form, as a tube garment goes over it. */
export type FormLimbName = 'armL' | 'armR' | 'legL' | 'legR' | 'head';

/**
 * A level that varies along a line: points [t, value], t from 0 to 1, joined
 * straight; past the first and last, held level. `repeat`: the whole profile
 * that many times over t's span (points, scallops).
 */
export interface EdgeProfile {
  points: number[][];
  repeat?: number;
}

/**
 * One open edge of a garment shaped by a profile.
 * - `neckline`: t across from the centre (0) to the side (1); value = how far
 *   it drops there, as a fraction of its depth (round is sqrt(1 - t^2), a V
 *   1 - t). `side` front (default) or back; `width` widens it, metres each side.
 * - `hem`, `top` (a band's top edge; a tube's or hat's start, its band), `cuff` (both sleeves' ends), `end` (a
 *   tube's): t round the part from the centre front (a limb: from its
 *   underside; an upright one, the head, from its front) toward the wearer's left, back at 0.5; value = metres longer
 *   there (lower for a hem, higher for a top, further along for a cuff).
 */
export interface GarmentEdge {
  along: 'neckline' | 'hem' | 'top' | 'cuff' | 'end';
  profile: EdgeProfile;
  side?: 'front' | 'back';
  width?: number;
}

/**
 * A dab of sculpting on a garment's silhouette: the cloth stood further off
 * the body round a point (or closer, negative), falling smoothly to nothing
 * at `radius`. Dabs add up; a stroke is a run of them. In the form's frame
 * (Z up, metres, +x the wearer's left, -y the front), as the garment is
 * modelled, before it hangs.
 */
export interface GarmentSculpt {
  at: [number, number, number];
  radius: number;
  /** Metres further off at the middle; negative, closer (never inside the fit it would have with no ease). */
  amount: number;
  /** Also its mirror across the centre (x to -x). Default true. */
  mirror?: boolean;
}

/**
 * A line drawn on a garment, any curve: its points in order on the garment
 * as modelled (the form's frame, Z up, metres), laid on its surface and
 * followed between them.
 * - `seam`: cut and sewn back, a panel line where the pieces part (a curved
 *   yoke, a spiral, a panel no one has a name for). Ended inside a panel, it
 *   is sewn shut and opens flat as a dart.
 * - `open`: cut and left open: a slit, a vent, an opening.
 * - `cut`: cut, and the smaller part it cuts off taken away: a closed one a
 *   cut-out, an open one from an edge back to an edge a new line for it (a
 *   neckline, a hem, an armhole drawn by hand). Its edge is named `name`.
 * - `line`: only marked, nothing cut: a named line on the garment for trims,
 *   topstitching or a piece sewn on to follow (a jeans fly's curve, a yoke's).
 */
export interface GarmentCurve {
  name: string;
  kind: 'seam' | 'open' | 'cut' | 'line';
  points: [number, number, number][];
  /** Round to its first point again. */
  closed?: boolean;
  /** Also its mirror across the centre (x to -x), the pair named L and R. */
  mirror?: boolean;
}

/**
 * A piece of cloth of any shape sewn onto a garment along one of its lines:
 * a ruffle, a ribbon, a flounce, a cape, a peplum, a panel nobody has named.
 * Drawn flat as a pattern piece is; the stretch of its outline that is sewn
 * goes along the line (gathered or eased by however much longer it is), the
 * rest hangs from there as the cloth falls.
 */
export interface GarmentAttachment {
  name: string;
  /** Its outline flat, metres, in order round. */
  outline: [number, number][];
  /** The stretch of the outline sewn on: from point `sewn[0]` round the way the outline runs to point `sewn[1]`. Default [0, 1], its first side. */
  sewn?: [number, number];
  /** The garment line it is sewn along, by name: an edge (`hem`, `neckline`, `cuff`), a seam (`side`, `armholeL`), a drawn curve. A name with L and R takes both. */
  along: string;
  /**
   * From where to where along the line, as fractions of its length. Default the whole of it.
   * Round a closed line (a hem, a neckline, a cuff) 0 is the point of it furthest to the front, and it runs toward
   * the wearer's left; a span from more to less runs across 0 (from 0.9 to 0.1, across the front).
   */
  span?: [number, number];
  /** That many of it side by side along the span, each sewn along its share (a fringe, a row of ribbons, scallops). Default 1. */
  repeat?: number;
  /**
   * Stretches of its own outline sewn together, each from one point round the way the outline runs to another, paired
   * by fraction along each (`reversed`: the second's end to the first's start): a hood's crown folded and sewn, a tube, a pouch.
   */
  joins?: { a: [number, number]; b: [number, number]; reversed?: boolean; /** `b` is a stretch of this other piece sewn on (by its name): two halves of a hood sewn along their curved back seam. */ with?: string }[];
  material?: ClothMaterialName;
  rgba?: number[];
  /** Its fabric's properties changed from `material`'s (a cap's peak: a stiff board, thick and hard to bend), as a cloth's own `materialOverrides`. */
  materialOverrides?: Partial<ClothMaterial>;
  /** Printed on it (a bandana's paisley, a scarf's check). */
  pattern?: ClothPatternPrint;
  /**
   * Set in a curve, metres: bent round an axis running out from the middle
   * of its sewn side, this radius, its sides turned down toward the garment
   * it is sewn to (negative: up). It rests so; a board holds it (a cap's
   * pre-curved peak, a curved brim). Unset, it rests flat.
   */
  bend?: number;
}

export interface GarmentDraft {
  garment: GarmentKind;
  /** Name of the body form it is fitted to, refitted whenever that form changes. */
  fitTo?: string;
  /**
   * The measurements it is cut to when it is on no form (`fitTo` unset): its
   * form was deleted, or it was made without one. It starts as it would be
   * worn on a form of these and, with nothing inside it, falls.
   */
  form?: BodyFormMeasurements;
  /**
   * Where it starts on the body: at the neck, with a neckline (a bodice); or
   * from a band, at the waist or at a height above the floor in metres (a
   * strapless bodice, a hip-slung skirt). Not for a tube (`over`).
   */
  top?: 'neck' | 'waist' | number;
  /** Follows each leg down (trousers) instead of hanging past them (a skirt, a dress). */
  legs?: boolean;
  /** Ease over the body, metres of circumference at chest, waist and hip. */
  ease?: number;
  /** For a garment from a waistband (`top: 'waist'`): ease round the waist itself, metres of circumference, snug so it holds. */
  waistEase?: number;
  /** Hem below the waist, metres (trousers: waistband to hem). Past the floor, it lies on it. */
  length?: number;
  /** Skirt flare: hem circumference over hip circumference. Trousers: hem over thigh. */
  flare?: number;
  /** Extra length at the centre back, metres, tapering off to the sides: a train. */
  train?: number;
  /** Sleeve length from the shoulder point, metres; 0 for sleeveless. */
  sleeve?: number;
  /** Round the sleeve at its cuff, metres; 0 for as wide as the sleeve. */
  cuff?: number;
  /** Armhole cut this much deeper than a set-in sleeve's, metres: deep, a batwing. */
  armhole?: number;
  /** Front neckline below the neck point, metres. */
  neckline?: number;
  /** Open down the centre front, its edges left unsewn: a jacket, a coat. */
  opening?: boolean;
  /** More cuts, each taking away the cloth on its normal's side: shaping a neckline, a back, a shoulder. Their edges are named `cut`, or by `name`. */
  cuts?: (GarmentPlane & { name?: string })[];
  /** More seams, each cutting the garment along a plane: princess lines, a yoke, a centre-back opening. */
  seams?: GarmentPlaneSeam[];
  /** Studs, buttons (with buttonholes on openings), a zipper, beads: along the garment's edges and seams. */
  trims?: GarmentTrim[];
  /** Boning in channels along the garment's lines (`side`, a draft seam's name, `top`, `hem`, ...). */
  rods?: GarmentRod[];
  /**
   * Fullness sewn into seams: ease, gathers, pleats, tucks. A seam between a
   * limb and the body (a set-in sleeve's armhole) is eased by default, by as
   * much as the fabric does not give (woven 3%, leather 4%, knits none); an
   * entry for it with `ratio: 1` turns that off.
   */
  fullness?: GarmentFullness[];
  /** Elastic bands embedded along named garment lines (`waist`, `cuff`, `top`, `neckline`, `hem`, ...). */
  elastics?: GarmentElastic[];
  /** Patch pockets sewn onto the garment's panels (sides and bottom stitched, top open). */
  pockets?: GarmentPocket[];
  /** Loops for a belt, sewn on over where it runs (true for 5, or how many; 5 with a belt unless false or 0). */
  beltLoops?: boolean | number;
  /** A belt round the waist (with belt loops unless `beltLoops` is false/0). */
  belt?: boolean | GarmentBelt;
  /** Printed SVG pattern across the garment's pieces. */
  pattern?: ClothPatternPrint;
  /** A collar sewn to the neckline (a garment from the neck). */
  collar?: GarmentCollar;
  /** The fronts turned back into lapels above the top button (with an `opening`). */
  lapels?: GarmentLapels;
  /**
   * A tube garment (sock, glove, hood, cuff): the limb it goes round, from
   * and to where along it (0 the root, 1 the end: a leg's toe, an arm's
   * fingertips, the crown), and whether it closes over the `to` end.
   */
  over?: FormLimbName;
  from?: number;
  to?: number;
  cap?: boolean;
  /** How many panels round a tube garment, cut along it; a dome wants more (a hat's crown six), a sock two. */
  gores?: number;
  /**
   * Shaped to the body under the bust, with darts (a fitted dress); or not,
   * hanging straight from its widest above (a t-shirt). A front with neither
   * cannot be cut flat.
   */
  fitted?: boolean;
  /**
   * The darts it is shaped with. Unset or true: the bust and waist darts a
   * bodice gets where it needs them; false: none (the draft's own seams
   * shape it instead: princess lines). A list: these as well, anywhere (an
   * elbow, a back waist, a skirt's waist), the plan's own left out where one
   * of these already shapes (its apex near theirs).
   */
  darts?: boolean | GarmentDart[];
  /**
   * Its open edges shaped: each a profile of the edge's level along it,
   * instead of one level all round. A V or square or sweetheart neckline, a
   * high-low or pointed or scalloped hem, a sleeve drawn out to a point.
   */
  edges?: GarmentEdge[];
  /**
   * Its silhouette sculpted: the stand-off off the body pushed out or drawn
   * in round points, any shape (a bubble, a cocoon, a shoulder, a shelf).
   * The pieces are cut to whatever it makes.
   */
  sculpt?: GarmentSculpt[];
  /** Curves drawn on it: seams, openings, and cuts that take cloth away. */
  curves?: GarmentCurve[];
  /** Cloth of any shape sewn on along its lines: ruffles, ribbons, capes, flounces. */
  attached?: GarmentAttachment[];
  material?: ClothMaterialName;
  rgba?: number[];
}

/**
 * A dress form's measurements, metres. Circumferences are round the body,
 * as a tape measures them; heights are from the floor.
 */
export type BodyFigure = 'male' | 'female';

export interface BodyFormMeasurements {
  /** The figure's build: where the waist and hips sit, the bust, the set of the shoulders. */
  figure: BodyFigure;
  height: number;
  /** Round the fullest part of the chest (the bust, on a female figure). */
  chest: number;
  /** Round the ribcage just under the bust; equal to the chest for no bust. */
  underbust: number;
  waist: number;
  hip: number;
  neck: number;
  /** Shoulder point to shoulder point, across the back. */
  shoulderWidth: number;
  /** Shoulder point to wrist. */
  armLength: number;
  /** Round the upper arm. */
  upperArm: number;
  /** Arms down from horizontal, degrees: 90 hangs straight, 45 is an A-pose. */
  armAngle: number;
  /** How far the forearm turns forward from the upper arm at the elbow, degrees: 0 is straight. */
  elbowBend: number;
  /** Whether the form has legs below the hip, or stands on a pole. */
  legs: boolean;
  /*
   * The rest are optional: unset, each is the usual proportion for the
   * figure at its height (formProportions.ts), and the form is exactly the
   * one those proportions give. Set, it fixes its landmark. Heights chain
   * up from the floor and are kept in order (see resolveHeights).
   */
  /** Crotch to floor, straight down the inside leg. */
  inseam?: number;
  /** Crotch depth: from the crotch straight up to the waist. */
  rise?: number;
  /** From the waist straight down to the fullest part of the hips. */
  waistToHip?: number;
  /** Nape to waist down the centre back; the nape taken at the top of the shoulders (HPS). */
  backLength?: number;
  /** From the top of the shoulder at the neck (HPS) straight down to the level of the bust points. */
  shoulderToBust?: number;
  /** Bust point to bust point. */
  bustSpan?: number;
  /** Round the wrist. */
  wrist?: number;
  /** Round the thigh, about halfway from the crotch to the knee. */
  thigh?: number;
  /** Round the knee. */
  knee?: number;
  /** Round the fullest part of the calf. */
  calf?: number;
  /** Round the narrowest part of the leg above the ankle bone. */
  ankle?: number;
}
