// ---------------------------------------------------------------------------
// Vertex painting
// ---------------------------------------------------------------------------
//
// Colour applied to *part* of a surface rather than to a whole body, and built
// up by going over the same place twice — the pips on a die, a stripe down a
// wheel, a dirty patch on a wall.
//
// Three things follow from that, and they are the whole design:
//
//  1. Paint lives per vertex, so a shape needs enough vertices to hold it. A
//     box is six quads until something asks otherwise; `paintResolution` works
//     out how finely to re-tessellate it, and the answer is kept with the paint
//     so that resizing the body later moves the pips with it instead of
//     stranding a colour array of the wrong length.
//
//  2. What is stored is coverage, not colour: rgb plus how much of it is down,
//     0..1. The body's own rgba still shows through underneath, so the base
//     colour stays live and a half-covered vertex is genuinely half-painted
//     rather than pre-mixed against a colour that may since have changed.
//
//  3. It is stored sparsely. Pips cover a percent or two of a die, and a dense
//     array would put tens of thousands of mostly-zero floats into every save
//     file for the sake of them.
//
// None of this reaches the physics. MuJoCo is handed a geom's rgba and does
// nothing with it, the MJCF emitter names the attributes it writes, and no
// exporter reads vertex colour — a painted body cuts, prints and simulates
// exactly as the unpainted one did.
// ---------------------------------------------------------------------------

import * as THREE from 'three';

/**
 * A geom's paint, as it is stored in the scene graph.
 *
 * `res` is the tessellation the paint was laid down on — the segment counts
 * passed to the geometry constructor, not a vertex count. Keeping the segments
 * rather than the count is what lets a painted die be resized: the geometry is
 * rebuilt at the new size with the same subdivisions, so vertex N is still the
 * same point on the same face and the pips travel with it.
 */
export interface PaintLayer {
  /** Segment counts the surface was built with. Empty for a mesh geom, which is painted at its own density. */
  res: number[];
  /** Indices of the vertices carrying paint. */
  idx: number[];
  /** r, g, b, coverage for each entry in `idx`, quantised to 0..255. */
  rgba: number[];
}

/** The live, dense form of a PaintLayer — what a stroke actually writes into. */
export interface PaintCanvas {
  res: number[];
  /** Vertex count of the surface this canvas covers. */
  count: number;
  /** r, g, b, coverage per vertex, 0..1. Coverage 0 means bare. */
  data: Float32Array;
}

/**
 * Edge length the tessellation aims for, in metres.
 *
 * Vertex colour is interpolated across a triangle, so this is also the width of
 * the blur at the edge of a mark: at 0.7 mm the pips on a 20 mm die come out
 * with edges tighter than the eye reads as soft, and the die costs about six
 * thousand vertices. Ten times finer would be crisper and cost a hundred times
 * the memory to draw a dot.
 */
const TARGET_EDGE = 0.0007;

/** Nothing is subdivided past this per axis, however big it is. */
const MAX_SEGMENTS = 96;

const segmentsFor = (length: number, min = 1, max = MAX_SEGMENTS) =>
  Math.min(max, Math.max(min, Math.round(Math.abs(length) / TARGET_EDGE)));

/**
 * Whether a geom type can hold paint at all.
 *
 * The list is the types this module knows how to re-tessellate, plus meshes,
 * which arrive dense enough to paint as they are. A wedge builds its geometry
 * from a bespoke six-vertex prism and is left alone — six vertices cannot hold
 * a pip, and one dab would flood a whole face.
 */
export const PAINTABLE_TYPES = new Set(['box', 'sphere', 'ellipsoid', 'cylinder', 'capsule', 'mesh']);

export const isPaintable = (type: string, customRender?: boolean) =>
  !customRender && PAINTABLE_TYPES.has(type);

/**
 * How finely to subdivide a primitive so it can hold paint.
 *
 * `args` is the same argument list the ordinary renderer passes to the geometry
 * constructor, so that the painted surface is the same shape and orientation as
 * the one it replaces — only denser.
 */
export function paintResolution(type: string, args: number[]): number[] {
  switch (type) {
    case 'box':
      // width, height, depth -> a segment count per axis, so a long thin bar is
      // not subdivided into slivers on its short sides.
      return [segmentsFor(args[0]), segmentsFor(args[1]), segmentsFor(args[2])];
    case 'sphere': {
      const r = args[0] ?? 0.1;
      return [segmentsFor(2 * Math.PI * r, 16), segmentsFor(Math.PI * r, 8, 64)];
    }
    case 'ellipsoid': {
      // Drawn as a unit sphere scaled by the three radii, so the circumference
      // that matters is the largest of them.
      const r = Math.max(args[0] ?? 0.1, args[1] ?? 0.1, args[2] ?? 0.1);
      return [segmentsFor(2 * Math.PI * r, 16), segmentsFor(Math.PI * r, 8, 64)];
    }
    case 'cylinder': {
      const r = args[0] ?? 0.1;
      const h = args[2] ?? 0.1;
      return [segmentsFor(2 * Math.PI * r, 16), segmentsFor(h, 1, 64)];
    }
    case 'capsule': {
      const r = args[0] ?? 0.05;
      const len = args[1] ?? 0.1;
      return [segmentsFor(Math.PI * r * 0.5, 4, 32), segmentsFor(2 * Math.PI * r, 16), segmentsFor(len, 1, 64)];
    }
    default:
      return [];
  }
}

/**
 * The constructor arguments for a primitive, from the half-extents a geom is
 * authored with.
 *
 * One place, because two callers need to agree exactly: the renderer, which
 * builds the surface a stroke lands on, and the MCP bridge, which lays paint
 * down without a renderer at all. A disagreement here would put an agent's
 * pips on a differently tessellated die from the one on screen.
 */
export function paintArgsFromSize(type: string, size: number[]): number[] {
  const [a = 0.1, b = 0.1, c = 0.1] = size;
  switch (type) {
    // MJCF sizes a box by its half-extents; BoxGeometry takes full ones.
    case 'box': return [a * 2, b * 2, c * 2];
    case 'sphere': return [a];
    case 'ellipsoid': return [a, b, c];
    case 'cylinder': return [a, a, b * 2];
    case 'capsule': return [a, b * 2];
    default: return [];
  }
}

/**
 * A point in a geom's own Z-up frame, moved into the space its geometry is
 * actually built in.
 *
 * Cylinders and capsules are the exception the rest of the app already lives
 * with: Three builds them along Y, and the renderer stands them up with a
 * quarter turn about X. Anything addressing a point on one — an agent painting
 * a stripe down a roller — should be able to think in the geom's frame and let
 * this do the turn.
 */
export function toGeometrySpace(type: string, point: number[]): [number, number, number] {
  const [x = 0, y = 0, z = 0] = point;
  if (type === 'cylinder' || type === 'capsule') return [x, z, -y];
  return [x, y, z];
}

/**
 * The paintable form of a primitive: same shape, same orientation, more vertices.
 *
 * Returns null for anything this module does not tessellate — the caller keeps
 * drawing whatever it was drawing.
 */
export function buildPaintGeometry(type: string, args: number[], res: number[]): THREE.BufferGeometry | null {
  switch (type) {
    case 'box':
      return new THREE.BoxGeometry(args[0], args[1], args[2], res[0], res[1], res[2]);
    case 'sphere':
      return new THREE.SphereGeometry(args[0], res[0], res[1]);
    case 'ellipsoid':
      // Unit sphere: the caller scales the mesh by the radii, exactly as the
      // unpainted renderer does.
      return new THREE.SphereGeometry(1, res[0], res[1]);
    case 'cylinder':
      return new THREE.CylinderGeometry(args[0], args[1], args[2], res[0], res[1]);
    case 'capsule':
      return new THREE.CapsuleGeometry(args[0], args[1], res[0], res[1], res[2]);
    default:
      return null;
  }
}

/** An empty canvas for a surface of `count` vertices. */
export function emptyCanvas(count: number, res: number[]): PaintCanvas {
  return { res, count, data: new Float32Array(count * 4) };
}

/**
 * Expands stored paint back into a canvas.
 *
 * A layer whose indices do not fit the surface is dropped rather than partially
 * applied: that only happens when the tessellation has changed underneath it,
 * and half a set of pips is worse than none.
 */
export function canvasFromLayer(layer: PaintLayer | undefined, count: number, res: number[]): PaintCanvas {
  const canvas = emptyCanvas(count, res);
  if (!layer?.idx?.length) return canvas;
  for (let i = 0; i < layer.idx.length; i++) {
    const v = layer.idx[i];
    if (v < 0 || v >= count) continue;
    canvas.data[v * 4] = (layer.rgba[i * 4] ?? 0) / 255;
    canvas.data[v * 4 + 1] = (layer.rgba[i * 4 + 1] ?? 0) / 255;
    canvas.data[v * 4 + 2] = (layer.rgba[i * 4 + 2] ?? 0) / 255;
    canvas.data[v * 4 + 3] = (layer.rgba[i * 4 + 3] ?? 0) / 255;
  }
  return canvas;
}

/**
 * Squeezes a canvas back down for storage.
 *
 * Quantised to a byte a channel and sparse over the vertices: a die with pips
 * on it saves a few hundred numbers rather than the thirty thousand its dense
 * canvas holds, and a byte of coverage is finer than the eye resolves in a
 * colour that is being blended anyway.
 */
export function layerFromCanvas(canvas: PaintCanvas): PaintLayer | undefined {
  const idx: number[] = [];
  const rgba: number[] = [];
  for (let v = 0; v < canvas.count; v++) {
    const a = canvas.data[v * 4 + 3];
    // Below half a byte of coverage there is nothing to see and nothing worth
    // storing — this is also what stops an erased stroke leaving a trail of
    // near-zero entries behind in the save file forever.
    if (a < 1 / 255) continue;
    idx.push(v);
    rgba.push(
      Math.round(canvas.data[v * 4] * 255),
      Math.round(canvas.data[v * 4 + 1] * 255),
      Math.round(canvas.data[v * 4 + 2] * 255),
      Math.round(a * 255),
    );
  }
  return idx.length ? { res: canvas.res, idx, rgba } : undefined;
}

/**
 * Writes the colour attribute the material reads: the body's own colour with
 * whatever paint is on top of it mixed in.
 */
export function writeVertexColors(target: Float32Array, base: number[], canvas: PaintCanvas) {
  const [br, bg, bb] = [base[0] ?? 0.8, base[1] ?? 0.8, base[2] ?? 0.8];
  for (let v = 0; v < canvas.count; v++) {
    const a = canvas.data[v * 4 + 3];
    if (a <= 0) {
      target[v * 3] = br;
      target[v * 3 + 1] = bg;
      target[v * 3 + 2] = bb;
      continue;
    }
    target[v * 3] = br + (canvas.data[v * 4] - br) * a;
    target[v * 3 + 1] = bg + (canvas.data[v * 4 + 1] - bg) * a;
    target[v * 3 + 2] = bb + (canvas.data[v * 4 + 2] - bb) * a;
  }
}

export interface DabOptions {
  /** Centre of the dab, in the surface's own space. */
  x: number; y: number; z: number;
  radius: number;
  /** 0..1 rgb the brush is holding. */
  color: number[];
  /** How much coverage one dab lays down at the centre of the brush. */
  flow: number;
  /** Take paint off instead of putting it on. */
  erase?: boolean;
}

/**
 * Lays one dab of paint onto the canvas.
 *
 * Returns the vertex range it touched so the caller can upload just that slice
 * of the colour attribute rather than the whole buffer — a dab on a dense mesh
 * moves a few dozen vertices out of tens of thousands, and re-uploading all of
 * them sixty times a second is most of what a naive painting tool spends its
 * frame on.
 */
export function applyDab(
  canvas: PaintCanvas,
  positions: ArrayLike<number>,
  { x, y, z, radius, color, flow, erase }: DabOptions,
): { lo: number; hi: number } | null {
  const r2 = radius * radius;
  let lo = -1;
  let hi = -1;

  for (let v = 0; v < canvas.count; v++) {
    const dx = positions[v * 3] - x;
    const dy = positions[v * 3 + 1] - y;
    const dz = positions[v * 3 + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= r2) continue;

    // Squared-cosine-ish falloff: full strength under the middle of the brush
    // and zero *slope* at the edge, so overlapping dabs down a stroke add up to
    // an even band instead of a row of visible rims.
    const t = 1 - d2 / r2;
    const amount = Math.min(1, Math.max(0, t * t * flow));
    if (amount <= 0) continue;

    const o = v * 4;
    const a = canvas.data[o + 3];

    if (erase) {
      canvas.data[o + 3] = a * (1 - amount);
    } else {
      // Painting over, the way a wash does: each pass closes some fraction of
      // what is still uncovered, so going over the same spot repeatedly
      // approaches full strength without ever banding past it.
      const next = a + (1 - a) * amount;
      if (next > 0) {
        // The colour already down keeps its share; the new colour takes the
        // coverage this dab just added. Painting red over blue therefore walks
        // through purple rather than flipping, which is what makes a second
        // colour over a first behave like paint.
        const added = next - a;
        canvas.data[o] = (canvas.data[o] * a + (color[0] ?? 0) * added) / next;
        canvas.data[o + 1] = (canvas.data[o + 1] * a + (color[1] ?? 0) * added) / next;
        canvas.data[o + 2] = (canvas.data[o + 2] * a + (color[2] ?? 0) * added) / next;
      }
      canvas.data[o + 3] = next;
    }

    if (lo === -1 || v < lo) lo = v;
    if (v > hi) hi = v;
  }

  return lo === -1 ? null : { lo, hi };
}

/**
 * The colour showing at the vertex nearest a point — what the eyedropper picks
 * up, so that alt-clicking a pip gives back the pip's colour rather than the
 * colour of the body it sits on.
 */
export function sampleColor(
  canvas: PaintCanvas,
  positions: ArrayLike<number>,
  base: number[],
  x: number, y: number, z: number,
): [number, number, number] | null {
  let best = Infinity;
  let bestV = -1;
  for (let v = 0; v < canvas.count; v++) {
    const dx = positions[v * 3] - x;
    const dy = positions[v * 3 + 1] - y;
    const dz = positions[v * 3 + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) { best = d2; bestV = v; }
  }
  if (bestV === -1) return null;

  const a = canvas.data[bestV * 4 + 3];
  const mix = (channel: number, baseValue: number) => baseValue + (channel - baseValue) * a;
  return [
    mix(canvas.data[bestV * 4], base[0] ?? 0.8),
    mix(canvas.data[bestV * 4 + 1], base[1] ?? 0.8),
    mix(canvas.data[bestV * 4 + 2], base[2] ?? 0.8),
  ];
}
