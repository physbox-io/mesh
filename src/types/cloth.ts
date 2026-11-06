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
 * Ruled-surface placement along a smooth 3D curve through `stations`: `u` runs
 * by arc length along the spline through `p`, and `v` (from the pattern's
 * centreline) runs along the unit transverse ruling `across` (projected
 * orthogonal to the curve tangent).
 */
export interface PathPlacement {
  kind: 'path';
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

export type ClothMaterialName = 'jersey' | 'woven' | 'canvas' | 'shadeCloth' | 'denim' | 'leather' | 'taffeta' | 'velvet';

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
  selfCollide?: boolean;
  /**
   * Which layer it is worn as: cloth lies outside every cloth of a lower
   * layer (a jacket, 2, over a shirt, 1, over jeans, 0). Same layers pass
   * through each other.
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
 * Something fixed along a line of a garment: studs, buttons or beads at a
 * spacing (`size` across them); a zipper, whose teeth run the whole line.
 * They ride on the cloth and are marked on the pattern; they do not weigh
 * or stiffen it.
 */
export interface GarmentTrim {
  kind: 'stud' | 'button' | 'bead' | 'zipper';
  along: GarmentLine;
  /** Between one and the next, metres; a zipper's teeth set their own. */
  spacing?: number;
  /** Across one, metres. */
  size?: number;
  rgba?: number[];
}

export type GarmentKind = 'tshirt' | 'dress' | 'skirt' | 'gown' | 'jacket' | 'trousers' | 'tube' | 'sock' | 'hat';

/** A limb of a body form, as a tube garment goes over it. */
export type FormLimbName = 'armL' | 'armR' | 'legL' | 'legR' | 'head';

export interface GarmentDraft {
  garment: GarmentKind;
  /** Name of the body form it is fitted to. */
  fitTo: string;
  /** Where it starts on the body: at the neck, with a neckline (a bodice), or at a waistband. Not for a tube (`over`). */
  top?: 'neck' | 'waist';
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
  /** Studs, buttons, a zipper, beads: along the garment's edges and seams. */
  trims?: GarmentTrim[];
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
}
