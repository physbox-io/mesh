// ---------------------------------------------------------------------------
// The shapes bought hardware is built from
//
// Shared by every family of bought part — bearings and screws
// (hardwareParts.ts), rails and runners (linearParts.ts), extrusion and its
// brackets (extrusionParts.ts) — so each builds from the same closed,
// outward-wound pieces and weighs them the same way. Nothing here knows what a
// part is for; it only makes rings, cylinders, sweeps and boxes, Z-up, metres.
// ---------------------------------------------------------------------------

import type { HardwarePart, SceneGeom, SceneNode } from '../types/scene';

/** What the palette, the inspector and MCP know about a kind of bought part. */
export interface HardwarePartInfo {
  label: string;
  sizes: readonly string[];
  defaultSize: string;
  /** Lengths it is sold in, mm, when it has a length. */
  lengths?: readonly number[];
  defaultLengthMm?: number;
  hint: string;
  /**
   * For a family in a module of its own: what the hierarchy calls one, and
   * how it is built. The core parts in hardwareParts.ts are built there.
   */
  name?: (p: HardwarePart) => string;
  build?: PartBuilder;
}

export const STEEL = 7850; // kg/m³
export const BRIGHT: [number, number, number, number] = [0.74, 0.76, 0.79, 1];
export const BLACK_OXIDE: [number, number, number, number] = [0.17, 0.17, 0.19, 1];
export const SHIELD: [number, number, number, number] = [0.36, 0.38, 0.42, 1];
export const NITRILE: [number, number, number, number] = [0.08, 0.08, 0.09, 1];
export const RUBBER = 1250; // kg/m³
export const mm = (v: number) => +(v / 1000).toFixed(7);

/**
 * A ring standing on +Z about the origin: outside radius by angle, inside
 * radius fixed, height h, centred. Z-up `renderVertices` and Y-up `vertices`,
 * as every mesh geom carries them.
 *
 * Each face's corner order follows from the way that face looks out — up for
 * the top, away from the axis for the outside, toward it for the bore — so the
 * ring is closed and wound outward everywhere (see CLAUDE.md on winding).
 */
export function ringMesh(outside: (theta: number) => number, inside: number, h: number, segments: number) {
  const renderVertices: number[] = [];
  const faces: number[] = [];
  const hh = h / 2;
  for (let i = 0; i < segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const ro = outside(t);
    renderVertices.push(ro * c, ro * s, hh, ro * c, ro * s, -hh, inside * c, inside * s, hh, inside * c, inside * s, -hh);
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments;
    const [ot, ob, it, ib] = [i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 3];
    const [otn, obn, itn, ibn] = [j * 4, j * 4 + 1, j * 4 + 2, j * 4 + 3];
    faces.push(ot, otn, itn, ot, itn, it); // top, looking up
    faces.push(ob, ibn, obn, ob, ib, ibn); // bottom, looking down
    faces.push(ob, obn, otn, ob, otn, ot); // outside, away from the axis
    faces.push(ib, itn, ibn, ib, it, itn); // bore, toward the axis
  }
  // Z-up to Y-up, (x, y, z) -> (x, z, -y): a rotation, so the winding holds.
  const vertices: number[] = [];
  for (let i = 0; i < renderVertices.length; i += 3) {
    vertices.push(renderVertices[i], renderVertices[i + 2], -renderVertices[i + 1]);
  }
  return {
    vertices: vertices.map((v) => +v.toFixed(7)),
    renderVertices: renderVertices.map((v) => +v.toFixed(7)),
    faces,
  };
}

/**
 * A round cord of radius `r` swept along a closed loop in the XY plane,
 * anticlockwise seen from +Z: an O-ring, or cord laid in a groove.
 *
 * Its corner order is worked from the sweep's own frame. Along the loop is u,
 * round the cord is v, starting outward and turning up; with t the loop's
 * direction and N its outward normal, t × N is -Z, so ∂u × ∂v comes out as
 * cos v·N + sin v·Z — the cord's outward normal — for corners taken in u then v.
 */
export function sweepMesh(loop: number[][], r: number, around = 12) {
  const n = loop.length;
  const renderVertices: number[] = [];
  for (let i = 0; i < n; i++) {
    const [px, py] = loop[i];
    const [ax, ay] = loop[(i - 1 + n) % n];
    const [bx, by] = loop[(i + 1) % n];
    const tl = Math.hypot(bx - ax, by - ay) || 1;
    const [tx, ty] = [(bx - ax) / tl, (by - ay) / tl];
    const [nx, ny] = [ty, -tx]; // right of an anticlockwise loop: outward
    for (let k = 0; k < around; k++) {
      const v = (k / around) * Math.PI * 2;
      const [c, s] = [Math.cos(v), Math.sin(v)];
      renderVertices.push(px + r * c * nx, py + r * c * ny, r * s);
    }
  }
  const faces: number[] = [];
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < around; k++) {
      const a = i * around + k;
      const b = ((i + 1) % n) * around + k;
      const c = ((i + 1) % n) * around + ((k + 1) % around);
      const d = i * around + ((k + 1) % around);
      faces.push(a, b, c, a, c, d);
    }
  }
  const vertices: number[] = [];
  for (let i = 0; i < renderVertices.length; i += 3) vertices.push(renderVertices[i], renderVertices[i + 2], -renderVertices[i + 1]);
  return { vertices: vertices.map((v) => +v.toFixed(7)), renderVertices: renderVertices.map((v) => +v.toFixed(7)), faces };
}

/** A circle as a loop, metres. */
export const circleLoop = (radius: number, segments = 48) =>
  Array.from({ length: segments }, (_, i) => [radius * Math.cos((i / segments) * Math.PI * 2), radius * Math.sin((i / segments) * Math.PI * 2)]);

/** A hexagon's radius at an angle, corners on +X as OpenSCAD's `$fn = 6` puts them. */
export const hexRadius = (flats: number) => (theta: number) => {
  const sector = ((theta % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3);
  return flats / 2 / Math.cos(sector - Math.PI / 6);
};

export function ringGeom(
  name: string, outsideR: number, insideR: number, h: number, z: number,
  rgba: number[], extra: Partial<SceneGeom> = {}, outside?: (theta: number) => number, segments = 32,
): SceneGeom {
  const shape = ringMesh(outside ?? (() => outsideR), insideR, h, segments);
  // Moved in the mesh itself: a mesh geom's vertices are read in the body frame.
  for (let i = 2; i < shape.renderVertices.length; i += 3) shape.renderVertices[i] = +(shape.renderVertices[i] + z).toFixed(7);
  for (let i = 1; i < shape.vertices.length; i += 3) shape.vertices[i] = +(shape.vertices[i] + z).toFixed(7);
  const volume = Math.PI * (outsideR * outsideR - insideR * insideR) * h;
  return {
    name, type: 'mesh', size: [1], rgba: [...rgba], dynamic: true,
    mass: +(volume * STEEL).toFixed(7), condim: 3, ...shape, ...extra,
  };
}

export function cylinderGeom(name: string, r: number, h: number, z: number, rgba: number[], extra: Partial<SceneGeom> = {}): SceneGeom {
  return {
    name, type: 'cylinder', size: [r, h / 2], pos: [0, 0, +z.toFixed(7)], rgba: [...rgba],
    mass: +(Math.PI * r * r * h * STEEL).toFixed(7), dynamic: true, ...extra,
  };
}

/** Drawn only: no contacts and no mass, so it changes nothing the solver sees. */
export function visual(g: SceneGeom): SceneGeom {
  const { mass: _mass, dynamic: _dynamic, condim: _condim, ...rest } = g;
  return { ...rest, role: 'visual' };
}

/**
 * Builds one family's part into `node`, which arrives with its id, name, free
 * joint and spec already set: the builder fills in geoms and child pieces.
 */
export type PartBuilder = (node: SceneNode, p: HardwarePart, id: string) => void;

/** A box geom, half sizes and centre in metres, weighed as `density`. */
export function boxGeom(name: string, half: number[], pos: number[], rgba: number[], density = STEEL, extra: Partial<SceneGeom> = {}): SceneGeom {
  return {
    name, type: 'box', size: half.map((v) => +v.toFixed(7)), pos: pos.map((v) => +v.toFixed(7)), rgba: [...rgba],
    mass: +(8 * half[0] * half[1] * half[2] * density).toFixed(7), dynamic: true, ...extra,
  };
}
