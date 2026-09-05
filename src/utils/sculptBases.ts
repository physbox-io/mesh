// ---------------------------------------------------------------------------
// Sculpt base shapes
// ---------------------------------------------------------------------------
//
// What you start from decides what you can reasonably finish. A sphere is the
// honest default because it presumes nothing, and it is also the reason most
// first attempts at a figure fail: you spend the session pulling limbs out of a
// ball instead of sculpting, and the proportions are set by whichever limb you
// happened to pull first.
//
// So there are two kinds of base here, built two different ways, for two
// different reasons:
//
//   * Primitives — sphere, cube, cylinder — are constructed exactly. A cube's
//     edges are its whole character, and running one through an isosurface
//     would round them off and hand you a slightly wrong cube to correct by
//     hand.
//
//   * Figures — humanoid, quadruped, bird, fish, hand, head — are *described*
//     as a skeleton of tapered capsules and extracted with surface nets. The
//     description is a few dozen numbers, the limbs blend into each other
//     instead of meeting at a seam, and adding a creature is adding data.
//
// Everything is Z-up metres, centred on the body origin, and sized so that any
// base can be swapped for any other without the object jumping in scale.
// ---------------------------------------------------------------------------

import { createSculptMesh, type SculptMesh, icosphere } from './sculptMesh';
import { surfaceNets, skeletonField, skeletonBounds, type Bone } from './surfaceNets';

/** Roughly how big any base comes out, longest axis, in metres. */
export const BASE_SIZE = 0.24;

export type SculptBaseId =
  | 'sphere'
  | 'cube'
  | 'cylinder'
  | 'humanoid'
  | 'quadruped'
  | 'bird'
  | 'fish'
  | 'hand'
  | 'head';

// ---------------------------------------------------------------------------
// Welded construction
// ---------------------------------------------------------------------------

/**
 * Collects triangles and welds coincident corners into shared vertices.
 *
 * Faces authored independently — six sides of a cube, a cylinder's wall and its
 * caps — meet at edges whose vertices are written twice, once by each side. Left
 * unwelded the mesh looks perfect and is not closed: the brush tears it open at
 * every seam, smoothing cannot cross one, and nothing downstream will print it.
 * Quantising to a micron and sharing the match is what makes the seam an edge
 * rather than a crack.
 */
class WeldedBuilder {
  private positions: number[] = [];
  private faces: number[] = [];
  private lookup = new Map<string, number>();

  vertex(x: number, y: number, z: number): number {
    const key = `${Math.round(x * 1e6)},${Math.round(y * 1e6)},${Math.round(z * 1e6)}`;
    const seen = this.lookup.get(key);
    if (seen !== undefined) return seen;
    const index = this.positions.length / 3;
    this.positions.push(x, y, z);
    this.lookup.set(key, index);
    return index;
  }

  triangle(a: number, b: number, c: number): void {
    // A quad whose corners collapse onto each other — the middle of a cylinder
    // cap, where a ring shrinks to the centre point — produces one real triangle
    // and one degenerate. Dropping the degenerate here keeps every edge shared
    // by exactly two faces.
    if (a === b || b === c || c === a) return;
    this.faces.push(a, b, c);
  }

  /** A quad, wound so that (a, b, c, d) goes round the outside. */
  quad(a: number, b: number, c: number, d: number): void {
    this.triangle(a, b, c);
    this.triangle(a, c, d);
  }

  build(): SculptMesh {
    return createSculptMesh(this.positions, this.faces);
  }
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A cube with each face divided into a grid.
 *
 * The subdivision is not cosmetic: an eight-vertex cube has nothing for a brush
 * to move, so the first stroke would either do nothing or fold the whole face.
 * A grid gives the brush something to bite on while leaving the edges dead
 * straight.
 */
export function cubeBase(size: number, segments = 8): SculptMesh {
  const builder = new WeldedBuilder();
  const half = size / 2;
  const n = Math.max(1, segments);

  // Each face is named by its outward axis; `u` and `v` span it, ordered so the
  // cross product u x v points out of the solid.
  const faces: [[number, number, number], [number, number, number], [number, number, number]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]],    // +X
    [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],   // -X
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]],    // +Y
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]],   // -Y
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]],    // +Z
    [[0, 0, -1], [0, 1, 0], [1, 0, 0]],   // -Z
  ];

  for (const [normal, u, v] of faces) {
    const corner = (a: number, b: number) => {
      const x = normal[0] * half + u[0] * a + v[0] * b;
      const y = normal[1] * half + u[1] * a + v[1] * b;
      const z = normal[2] * half + u[2] * a + v[2] * b;
      return builder.vertex(x, y, z);
    };

    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const a0 = -half + (i * size) / n;
        const a1 = -half + ((i + 1) * size) / n;
        const b0 = -half + (j * size) / n;
        const b1 = -half + ((j + 1) * size) / n;
        builder.quad(corner(a0, b0), corner(a1, b0), corner(a1, b1), corner(a0, b1));
      }
    }
  }

  return builder.build();
}

/**
 * A capped cylinder, axis along Z.
 *
 * The caps are built as concentric rings. There is still a fan at the very
 * centre — the innermost ring shrinks to a point, and something has to close it
 * — but it is a fan across the innermost ring only, not across the whole cap.
 * That is the part that matters: a single fan from rim to centre gives the cap
 * nothing but long slivers meeting at one vertex, so a brush anywhere on the
 * face drags the entire cap, and smoothing pulls the middle into a dimple. With
 * rings, the cap's triangles are the size of the wall's and the fan is confined
 * to a small disc in the middle.
 */
export function cylinderBase(radius: number, height: number, radial = 32, heightSegments = 8, capRings = 5): SculptMesh {
  const builder = new WeldedBuilder();
  const n = Math.max(3, radial);
  const halfHeight = height / 2;

  const ring = (r: number, z: number, i: number) => {
    const angle = (i % n) * ((Math.PI * 2) / n);
    return builder.vertex(r * Math.cos(angle), r * Math.sin(angle), z);
  };

  // Wall.
  for (let k = 0; k < heightSegments; k++) {
    const z0 = -halfHeight + (k * height) / heightSegments;
    const z1 = -halfHeight + ((k + 1) * height) / heightSegments;
    for (let i = 0; i < n; i++) {
      builder.quad(ring(radius, z0, i), ring(radius, z0, i + 1), ring(radius, z1, i + 1), ring(radius, z1, i));
    }
  }

  // Caps. `sign` flips the winding so both face outward.
  for (const [z, sign] of [[halfHeight, 1], [-halfHeight, -1]] as [number, number][]) {
    for (let k = 0; k < capRings; k++) {
      const r0 = radius * (1 - k / capRings);
      const r1 = radius * (1 - (k + 1) / capRings);
      for (let i = 0; i < n; i++) {
        const outer0 = ring(r0, z, i);
        const outer1 = ring(r0, z, i + 1);
        // The innermost ring has radius 0, so both of its corners weld to the
        // one centre vertex and the quad degenerates to a triangle.
        const inner1 = r1 > 1e-9 ? ring(r1, z, i + 1) : builder.vertex(0, 0, z);
        const inner0 = r1 > 1e-9 ? ring(r1, z, i) : inner1;
        if (sign > 0) builder.quad(outer0, outer1, inner1, inner0);
        else builder.quad(outer1, outer0, inner0, inner1);
      }
    }
  }

  return builder.build();
}

// ---------------------------------------------------------------------------
// Figures
// ---------------------------------------------------------------------------

/**
 * How finely a figure is extracted.
 *
 * A base wants to be coarse. It is scaffolding — you are going to add the detail
 * yourself, and the brush adds triangles where you put them, so starting dense
 * only makes every stroke slower without making any of them finer. 48 cells puts
 * a figure at a few thousand triangles, which is enough to read the pose and
 * cheap enough to sculpt on immediately.
 */
const FIGURE_RESOLUTION = 48;

/**
 * Mirrors a bone across the Y = 0 plane — a figure's limbs come in pairs.
 *
 * Y, because every figure here faces +X, so left and right lie along Y. This
 * mirrored across X, which is the front-to-back axis: a wing written at
 * y = +0.026 was "paired" with a second wing at y = +0.026, flipped nose to
 * tail. The bird had two left wings and two left legs, with nothing whatever on
 * its right side; the quadruped had all four legs down one flank; the hand's
 * fingers were stacked front to back. It cost the bases up to 43 mm of
 * asymmetry on a body 110 mm wide, and it made a pair of anything impossible to
 * sculpt symmetrically because there was no surface on the far side to sculpt.
 */
function mirrored(bone: Bone): Bone {
  return { a: [bone.a[0], -bone.a[1], bone.a[2]], b: [bone.b[0], -bone.b[1], bone.b[2]], ra: bone.ra, rb: bone.rb };
}

/** Both of a pair. */
function pair(bone: Bone): Bone[] {
  return [bone, mirrored(bone)];
}

/**
 * Extracts a skeleton and rescales it so every figure arrives the same size.
 *
 * Without the rescale, editing a bird's wingspan by a centimetre would silently
 * change how big a bird is relative to a humanoid, and swapping between bases
 * would make the object jump.
 */
function figure(bones: Bone[], blend: number): SculptMesh {
  const bounds = skeletonBounds(bones, blend);
  const extracted = surfaceNets(skeletonField(bones, blend), { ...bounds, resolution: FIGURE_RESOLUTION });

  const positions = extracted.positions;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
    minY = Math.min(minY, positions[i + 1]); maxY = Math.max(maxY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]); maxZ = Math.max(maxZ, positions[i + 2]);
  }

  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const scale = span > 1e-9 ? BASE_SIZE / span : 1;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const cz = (minZ + maxZ) / 2;

  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - cx) * scale;
    positions[i + 1] = (positions[i + 1] - cy) * scale;
    positions[i + 2] = (positions[i + 2] - cz) * scale;
  }

  return createSculptMesh(positions, extracted.faces);
}

/**
 * A standing figure, facing +X.
 *
 * Deliberately a mannequin and not a person: no face, no hands, no muscle. A
 * base with detail already in it is a base you have to agree with, and the
 * useful thing here is the proportion and the pose — head at the top, weight
 * over the feet, arms hanging where arms hang.
 */
/*
 * Turned a quarter turn about Z from how it was first written.
 *
 * This skeleton alone put its shoulders, hips and limbs along X and faced +Y,
 * while its own doc comment — and every other figure here — said +X. It was the
 * only one `mirrored`'s X-flip suited, which is presumably how the flip came to
 * be written that way. Now it agrees with the rest: facing +X, left and right
 * along Y, and one symmetry plane that works for every base.
 */
export function humanoidSkeleton(): Bone[] {
  return [
    // Spine, pelvis to the base of the neck.
    { a: [0, 0, -0.02], b: [0, 0, 0.06], ra: 0.034, rb: 0.030 },
    // Neck and head.
    { a: [0, 0, 0.06], b: [0, 0, 0.085], ra: 0.016, rb: 0.018 },
    { a: [0, 0, 0.092], b: [0.004, 0, 0.108], ra: 0.026, rb: 0.024 },
    // Shoulders.
    { a: [0, 0, 0.055], b: [0, -0.040, 0.055], ra: 0.022, rb: 0.019 },
    { a: [0, 0, 0.055], b: [0, 0.040, 0.055], ra: 0.022, rb: 0.019 },
    // Arms: upper, fore, and a stub for the hand.
    ...pair({ a: [0, -0.042, 0.052], b: [0, -0.052, 0.008], ra: 0.018, rb: 0.014 }),
    ...pair({ a: [0, -0.052, 0.008], b: [0.004, -0.058, -0.034], ra: 0.014, rb: 0.011 }),
    ...pair({ a: [0.004, -0.058, -0.034], b: [0.006, -0.060, -0.048], ra: 0.011, rb: 0.009 }),
    // Hips.
    { a: [0, 0.022, -0.018], b: [0, -0.022, -0.018], ra: 0.028, rb: 0.028 },
    // Legs: thigh, shin, foot.
    ...pair({ a: [0, -0.021, -0.024], b: [0, -0.023, -0.076], ra: 0.023, rb: 0.017 }),
    ...pair({ a: [0, -0.023, -0.076], b: [0, -0.024, -0.122], ra: 0.017, rb: 0.012 }),
    ...pair({ a: [-0.004, -0.024, -0.126], b: [0.020, -0.024, -0.128], ra: 0.013, rb: 0.010 }),
  ];
}

/**
 * A generic four-legged mammal, facing +X.
 *
 * Dog-shaped rather than any particular animal, which is the useful place to
 * start: the distance between a base like this and a cat, a horse or a bear is
 * a session's sculpting, and the distance from a sphere to any of them is a
 * session of getting the legs in the right place first.
 */
export function quadrupedSkeleton(): Bone[] {
  return [
    // Barrel, hindquarters to shoulder.
    { a: [-0.055, 0, 0.005], b: [0.055, 0, 0.012], ra: 0.036, rb: 0.033 },
    // Neck and head, carried forward and up.
    { a: [0.055, 0, 0.016], b: [0.088, 0, 0.034], ra: 0.024, rb: 0.019 },
    { a: [0.088, 0, 0.034], b: [0.108, 0, 0.030], ra: 0.023, rb: 0.020 },
    // Muzzle.
    { a: [0.108, 0, 0.028], b: [0.134, 0, 0.020], ra: 0.016, rb: 0.012 },
    // Ears.
    ...pair({ a: [0.104, 0.014, 0.042], b: [0.100, 0.020, 0.060], ra: 0.009, rb: 0.005 }),
    // Front legs.
    ...pair({ a: [0.046, 0.020, -0.010], b: [0.048, 0.022, -0.052], ra: 0.016, rb: 0.011 }),
    ...pair({ a: [0.048, 0.022, -0.052], b: [0.050, 0.022, -0.086], ra: 0.011, rb: 0.009 }),
    // Hind legs, with the extra bend a haunch has.
    ...pair({ a: [-0.046, 0.020, -0.006], b: [-0.056, 0.022, -0.044], ra: 0.020, rb: 0.012 }),
    ...pair({ a: [-0.056, 0.022, -0.044], b: [-0.044, 0.022, -0.086], ra: 0.012, rb: 0.009 }),
    // Tail.
    { a: [-0.058, 0, 0.020], b: [-0.086, 0, 0.044], ra: 0.011, rb: 0.005 },
  ];
}

/** A standing bird, facing +X: body, neck, beak, folded wings, legs, tail. */
export function birdSkeleton(): Bone[] {
  return [
    { a: [-0.030, 0, 0.010], b: [0.030, 0, 0.022], ra: 0.032, rb: 0.028 },
    { a: [0.030, 0, 0.026], b: [0.046, 0, 0.062], ra: 0.014, rb: 0.012 },
    { a: [0.046, 0, 0.062], b: [0.052, 0, 0.078], ra: 0.016, rb: 0.014 },
    // Beak.
    { a: [0.054, 0, 0.076], b: [0.078, 0, 0.070], ra: 0.008, rb: 0.003 },
    // Folded wings, laid along the flanks.
    ...pair({ a: [0.014, 0.026, 0.028], b: [-0.030, 0.020, 0.014], ra: 0.014, rb: 0.008 }),
    // Legs.
    ...pair({ a: [0.004, 0.014, -0.014], b: [0.004, 0.014, -0.050], ra: 0.008, rb: 0.006 }),
    ...pair({ a: [0.004, 0.014, -0.050], b: [0.014, 0.014, -0.058], ra: 0.006, rb: 0.004 }),
    // Tail.
    { a: [-0.034, 0, 0.016], b: [-0.070, 0, 0.004], ra: 0.016, rb: 0.008 },
  ];
}

/** A fish, facing +X: a streamlined body, fins, and a forked tail. */
export function fishSkeleton(): Bone[] {
  return [
    { a: [-0.030, 0, 0], b: [0.050, 0, 0.004], ra: 0.030, rb: 0.020 },
    { a: [0.050, 0, 0.004], b: [0.078, 0, 0.002], ra: 0.020, rb: 0.010 },
    // Tail stock and the two lobes of the fin.
    { a: [-0.030, 0, 0], b: [-0.062, 0, 0.002], ra: 0.020, rb: 0.008 },
    { a: [-0.062, 0, 0.002], b: [-0.092, 0, 0.030], ra: 0.008, rb: 0.004 },
    { a: [-0.062, 0, 0.002], b: [-0.092, 0, -0.026], ra: 0.008, rb: 0.004 },
    // Dorsal fin.
    { a: [0.006, 0, 0.026], b: [-0.016, 0, 0.048], ra: 0.008, rb: 0.004 },
    // Pectoral fins.
    ...pair({ a: [0.026, 0.016, -0.004], b: [0.010, 0.038, -0.016], ra: 0.007, rb: 0.003 }),
  ];
}

/**
 * An open hand, palm in the XY plane, fingers along +Y.
 *
 * The traditional sculpting exercise, and the one shape where getting the
 * proportions right by hand is genuinely hard: the knuckles do not sit on a
 * straight line, and a hand built as though they did reads as wrong long before
 * anyone can say why.
 */
export function handSkeleton(): Bone[] {
  const bones: Bone[] = [
    // Palm.
    { a: [0, -0.020, 0], b: [0, 0.020, 0], ra: 0.026, rb: 0.028 },
    // Wrist.
    { a: [0, -0.020, 0], b: [0, -0.056, 0], ra: 0.022, rb: 0.019 },
    // Thumb, out of the plane of the fingers, which is what makes it a thumb.
    { a: [-0.020, -0.006, 0.004], b: [-0.044, 0.014, 0.012], ra: 0.011, rb: 0.009 },
    { a: [-0.044, 0.014, 0.012], b: [-0.056, 0.036, 0.014], ra: 0.009, rb: 0.007 },
  ];

  // Four fingers. The knuckle line arcs and the middle finger is longest, so
  // both the base and the length come off a curve rather than a constant.
  const lengths = [0.052, 0.058, 0.054, 0.042];
  for (let i = 0; i < 4; i++) {
    const x = -0.018 + i * 0.013;
    const knuckle = 0.026 - Math.abs(i - 1.2) * 0.003;
    const tip = knuckle + lengths[i];
    const radius = 0.0095 - i * 0.0008;
    bones.push({ a: [x, knuckle, 0], b: [x, knuckle + lengths[i] * 0.55, 0.002], ra: radius, rb: radius * 0.85 });
    bones.push({ a: [x, knuckle + lengths[i] * 0.55, 0.002], b: [x, tip, 0.001], ra: radius * 0.85, rb: radius * 0.62 });
  }

  return bones;
}

/**
 * A head and shoulders bust, facing +X.
 *
 * A portrait started from a sphere spends its first hour becoming a head. This
 * is that hour: cranium, jaw, neck and a shoulder line to sit it on, with no
 * features cut, because the features are the part worth doing yourself.
 */
export function headSkeleton(): Bone[] {
  return [
    // Cranium and the mass of the jaw.
    { a: [0, 0, 0.030], b: [0, 0, 0.062], ra: 0.046, rb: 0.040 },
    { a: [0.004, 0, 0.014], b: [0.010, 0, 0.034], ra: 0.038, rb: 0.042 },
    // Brow and the bridge of the nose, enough to say which way it faces.
    { a: [0.034, 0, 0.046], b: [0.042, 0, 0.030], ra: 0.016, rb: 0.012 },
    // Chin.
    { a: [0.024, 0, 0.006], b: [0.030, 0, 0.014], ra: 0.020, rb: 0.017 },
    // Neck.
    { a: [0, 0, 0.010], b: [0, 0, -0.036], ra: 0.024, rb: 0.026 },
    // Shoulders, cut off as a bust is.
    { a: [-0.050, 0, -0.052], b: [0.050, 0, -0.052], ra: 0.030, rb: 0.030 },
    // Ears.
    ...pair({ a: [0.044, 0, 0.036], b: [0.048, 0, 0.038], ra: 0.012, rb: 0.010 }),
  ];
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

export interface SculptBaseDefinition {
  id: SculptBaseId;
  label: string;
  /** One line, shown under the picker. Says what it is FOR, not what it is. */
  description: string;
  build: () => SculptMesh;
}

export const SCULPT_BASES: SculptBaseDefinition[] = [
  {
    id: 'sphere',
    label: 'Sphere',
    description: 'A ball of clay. Presumes nothing — the right start when you do not know yet.',
    build: () => icosphere(BASE_SIZE / 2, 3),
  },
  {
    id: 'cube',
    label: 'Cube',
    description: 'Flat faces and hard edges to cut into. Good for anything built rather than grown.',
    build: () => cubeBase(BASE_SIZE * 0.8, 10),
  },
  {
    id: 'cylinder',
    label: 'Cylinder',
    description: 'A turned blank: a column, a vessel, a limb. Keeps its axis while you work round it.',
    build: () => cylinderBase(BASE_SIZE * 0.32, BASE_SIZE * 0.9, 32, 10, 5),
  },
  {
    id: 'humanoid',
    label: 'Humanoid',
    description: 'A standing mannequin, facing +X. Proportion and pose already right; no features.',
    build: () => figure(humanoidSkeleton(), 0.012),
  },
  {
    id: 'quadruped',
    label: 'Mammal',
    description: 'A generic four-legged animal. A session away from a cat, a horse or a bear.',
    build: () => figure(quadrupedSkeleton(), 0.013),
  },
  {
    id: 'bird',
    label: 'Bird',
    description: 'Standing, wings folded. Body, beak and legs placed; feathers are yours.',
    build: () => figure(birdSkeleton(), 0.011),
  },
  {
    id: 'fish',
    label: 'Fish',
    description: 'Streamlined body with fins and a forked tail. Also the start of most sea creatures.',
    build: () => figure(fishSkeleton(), 0.010),
  },
  {
    id: 'hand',
    label: 'Hand',
    description: 'Open palm with the knuckle line already curved — the part that is hard to eyeball.',
    build: () => figure(handSkeleton(), 0.008),
  },
  {
    id: 'head',
    label: 'Head',
    description: 'A bust on its shoulders. Skips the hour a portrait spends becoming head-shaped.',
    build: () => figure(headSkeleton(), 0.014),
  },
];

export const DEFAULT_SCULPT_BASE: SculptBaseId = 'sphere';

/** Builds a base by id, falling back to the sphere for an id we do not know. */
export function buildSculptBase(id: SculptBaseId | undefined): SculptMesh {
  const definition = SCULPT_BASES.find((b) => b.id === id) ?? SCULPT_BASES[0];
  return definition.build();
}
