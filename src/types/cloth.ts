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
 *    flared skirt, a sleeve that narrows).
 */
export type ClothPlacement =
  | { kind: 'plane'; origin?: number[]; uAxis?: number[]; vAxis?: number[] }
  | { kind: 'wrap'; origin: number[]; axis: number[]; ref: number[]; radius: number; taper?: number; startU?: number };

export interface ClothPiece {
  name: string;
  edges: ClothEdge[];
  placement?: ClothPlacement;
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
}

export type ClothMaterialName = 'jersey' | 'woven' | 'canvas' | 'shadeCloth';

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
}

export interface ClothSpec {
  pieces: ClothPiece[];
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
   * Set when the cloth was drafted for a body form: regenerate from these
   * whenever the form's measurements change. See utils/cloth/garments.ts.
   */
  draft?: GarmentDraft;
}

export type GarmentKind = 'tshirt' | 'dress' | 'skirt';

export interface GarmentDraft {
  garment: GarmentKind;
  /** Name of the body form it is fitted to. */
  fitTo: string;
  /** Ease over the body, metres of circumference at chest, waist and hip. */
  ease?: number;
  /** Hem below the waist for a dress or skirt, metres. */
  length?: number;
  /** Skirt flare: hem circumference over hip circumference. */
  flare?: number;
  /** Sleeve length from the shoulder point, metres; 0 for sleeveless. */
  sleeve?: number;
  material?: ClothMaterialName;
  rgba?: number[];
}

/**
 * A dress form's measurements, metres. Circumferences are round the body,
 * as a tape measures them; heights are from the floor.
 */
export interface BodyFormMeasurements {
  height: number;
  chest: number;
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
  /** Whether the form has legs below the hip, or stands on a pole. */
  legs: boolean;
}
