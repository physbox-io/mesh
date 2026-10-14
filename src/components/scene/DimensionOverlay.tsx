/**
 * The Dims overlay: a drawing's dimensions on the parts, in Top, Front and Side.
 *
 * What to measure comes from utils/viewDimensions, run on the parts AS DRAWN:
 * every transform, boolean and MuJoCo pose already applied, the same reasoning
 * as measureScene. This file gathers those triangles, each part's own axes
 * (the frame of its biggest piece) and its exact round pieces, and draws the
 * result the way a drawing does — thin extension lines out from the part, a
 * dimension line with an arrowhead at each end, the figure in mm on it. A part
 * turned or tilted in the view is dimensioned along its own edges, so a
 * figure can sit on a slanted or foreshortened line; it is the true size.
 *
 * Where each part sits is drawn too, in a second colour: its origin from its
 * parent's, across and up the sheet.
 *
 * Drawn only while the camera is square to the view: orbit off it and the
 * figures would sit on a sheet nobody is looking at, so they go until you come
 * back. Sizes are in screen pixels (an orthographic view's scale is its zoom),
 * so the rows and arrows stay the same size as you zoom.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import { useStore } from '../../store/useStore';
import { isDrawingView, SQUARE_TO_VIEW, VIEW_AXES, type DrawingView } from '../../utils/cameraViews';
import {
  bodyViewDimensions, locationDimensions, type BodyDimensions, type BodyMesh, type LocationDim,
} from '../../utils/viewDimensions';
import { bodyOf } from '../../utils/measureScene';
import { setLiveDimensions, type LiveDimension } from '../../utils/liveDimensions';
import type { SceneNode } from '../../types/scene';
import type { DataMirror, ModelMirror, MujocoShim } from '../../types/sceneLayer';

const COLOUR = '#d97706';
/** Where a part sits, as against what it is. */
const LOCATION_COLOUR = '#0891b2';
/** How far out each row sits from the part, in pixels. */
const ROW_PX = [0, 22, 46];
/** The gap between the part and an extension line, and how far it runs past the dimension line. */
const GAP_PX = 3;
const OVERSHOOT_PX = 4;
const ARROW_LONG_PX = 9;
const ARROW_HALF_PX = 3;
/** The diameter leader: how far past the rim it runs, and its shoulder. */
const LEADER_PX = 26;
const SHOULDER_PX = 10;
/** An angle's arc, and how far its two lines run past it. */
const ARC_PX = 34;
const ARC_OVERRUN_PX = 12;
/** The arms of the cross that marks a part's origin. */
const MARK_PX = 5;
/** How often the drawn scene is checked for change. */
const POLL_MS = 250;
/** Bigger than this is the floor or the sky, not a part. */
const MAX_PART_M = 10;
/** With nothing selected and more parts than this, where each sits is left out: it would be a web of lines. */
const MAX_LOCATIONS = 12;

type Vec3 = [number, number, number];

interface DrawnPiece { id: string; geometry: THREE.BufferGeometry; matrix: THREE.Matrix4 }

/** Three's Y-up scene frame and the document's Z-up, both ways. */
const toDoc = (v: THREE.Vector3): Vec3 => [v.x, -v.z, v.y];
const toThree = (v: ArrayLike<number>) => new THREE.Vector3(v[0], v[2], -v[1]);

const evenScale = (matrix: THREE.Matrix4) => {
  const scale = new THREE.Vector3().setFromMatrixScale(matrix);
  return { scale, even: Math.abs(scale.x - scale.y) <= 1e-3 * scale.x && Math.abs(scale.x - scale.z) <= 1e-3 * scale.x };
};

/**
 * The sphere a piece is, exactly, when it is a whole sphere drawn at an even
 * scale: centre in the document frame and radius in metres. An ellipsoid is a
 * unit sphere scaled unevenly, and is not one.
 */
function sphereOf({ geometry, matrix }: DrawnPiece): { centre: Vec3; radius: number } | null {
  if (geometry.type !== 'SphereGeometry') return null;
  const p = (geometry as THREE.SphereGeometry).parameters;
  if (Math.abs(p.phiLength - Math.PI * 2) > 1e-6 || Math.abs(p.thetaLength - Math.PI) > 1e-6) return null;
  const { scale, even } = evenScale(matrix);
  if (!even) return null;
  return { centre: toDoc(new THREE.Vector3().setFromMatrixPosition(matrix)), radius: p.radius * scale.x };
}

/** The rod a capsule is: the ends of its straight part, and its radius. */
function rodOf({ geometry, matrix }: DrawnPiece): { a: Vec3; b: Vec3; radius: number } | null {
  if (geometry.type !== 'CapsuleGeometry') return null;
  const p = (geometry as THREE.CapsuleGeometry).parameters;
  const { scale, even } = evenScale(matrix);
  if (!even) return null;
  return {
    a: toDoc(new THREE.Vector3(0, -p.height / 2, 0).applyMatrix4(matrix)),
    b: toDoc(new THREE.Vector3(0, p.height / 2, 0).applyMatrix4(matrix)),
    radius: p.radius * scale.x,
  };
}

/**
 * A part's own axes: those of its biggest piece that is not a sphere. The piece's frame is the geom's, which is the body's
 * turned by however the geom sits in it — the frame its edges run along.
 */
function frameOf(pieces: DrawnPiece[]): [Vec3, Vec3, Vec3] | undefined {
  let best: DrawnPiece | null = null;
  let bestSize = -1;
  const size = new THREE.Vector3();
  for (const piece of pieces) {
    // A true sphere's axes say nothing; an ellipsoid (a sphere scaled unevenly) has its own.
    if (sphereOf(piece)) continue;
    if (!piece.geometry.boundingBox) piece.geometry.computeBoundingBox();
    piece.geometry.boundingBox!.getSize(size).multiply(new THREE.Vector3().setFromMatrixScale(piece.matrix));
    const across = size.length();
    if (across > bestSize) { best = piece; bestSize = across; }
  }
  if (!best) return undefined;
  const e = best.matrix.elements;
  const axis = (i: number) => toDoc(new THREE.Vector3(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]).normalize());
  return [axis(0), axis(1), axis(2)];
}

/**
 * The meshes that make up each body as drawn, and a signature per body that
 * changes when any of them moves or is rebuilt. Cheap: nothing is copied, so
 * it can be asked a few times a second.
 *
 * Only meshes that cast a shadow: that is the part's own surface, and it
 * leaves out everything drawn alongside it in the same group — the inside wall
 * of a hollow mesh, the DFM heat map, a brush cursor, cut ghosts.
 */
function drawnPieces(root: THREE.Object3D, only: string | null): Map<string, { pieces: DrawnPiece[]; signature: string }> {
  const out = new Map<string, { pieces: DrawnPiece[]; signature: string }>();
  const push = (id: string, geometry: THREE.BufferGeometry, matrix: THREE.Matrix4) => {
    let entry = out.get(id);
    if (!entry) out.set(id, (entry = { pieces: [], signature: '' }));
    entry.pieces.push({ id, geometry, matrix });
    entry.signature += `${geometry.uuid}:${(geometry.getAttribute('position') as THREE.BufferAttribute | undefined)?.version ?? 0}:${matrix.elements.map((e) => e.toFixed(6)).join(',')};`;
  };
  root.traverseVisible((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry || !mesh.castShadow) return;
    const instanced = mesh as unknown as THREE.InstancedMesh;
    if (instanced.isInstancedMesh) {
      // Static boxes, one instance each; see measureScene's instancedCandidates.
      const ids = (instanced.userData?.nodeIds ?? []) as string[];
      for (let i = 0; i < instanced.count; i++) {
        const id = ids[i];
        if (!id || (only && id !== only)) continue;
        const m = new THREE.Matrix4();
        instanced.getMatrixAt(i, m);
        push(id, instanced.geometry, m.premultiply(instanced.matrixWorld));
      }
      return;
    }
    const id = bodyOf(mesh);
    if (!id || (only && id !== only)) return;
    push(id, mesh.geometry, mesh.matrixWorld.clone());
  });
  return out;
}

/** One body's triangles, world space, document frame (Z-up), with its frame and exact rounds. */
function bodyMesh(id: string, pieces: DrawnPiece[]): BodyMesh {
  const positions: number[] = [];
  const faces: number[] = [];
  const p = new THREE.Vector3();
  for (const { geometry, matrix } of pieces) {
    const position = geometry.getAttribute('position');
    if (!position) continue;
    const base = positions.length / 3;
    for (let i = 0; i < position.count; i++) {
      p.fromBufferAttribute(position, i).applyMatrix4(matrix);
      positions.push(...toDoc(p));
    }
    const index = geometry.index;
    if (index) for (let i = 0; i < index.count; i++) faces.push(base + index.getX(i));
    else for (let i = 0; i < position.count; i++) faces.push(base + i);
  }
  const spheres = pieces.map(sphereOf).filter((x): x is NonNullable<typeof x> => x !== null);
  const rods = pieces.map(rodOf).filter((x): x is NonNullable<typeof x> => x !== null);
  return { id, positions, faces, spheres, rods, frame: frameOf(pieces) };
}

/**
 * Each drawn part's origin and the origin it is located from — its parent
 * body's, or the world's — from MuJoCo, where a simulated body actually is.
 * A part MuJoCo does not know is left out.
 */
function locationLinks(ids: Iterable<string>, nodes: SceneNode[]): { id: string; parent: string | null; from: Vec3; to: Vec3 }[] {
  const { model, data, mujoco } = useStore.getState() as unknown as {
    model: ModelMirror | null; data: DataMirror | null; mujoco: MujocoShim | null;
  };
  if (!model || !data || !mujoco) return [];
  const parentOf = new Map<string, SceneNode | null>();
  const byId = new Map<string, SceneNode>();
  const walk = (list: SceneNode[] | undefined, parent: SceneNode | null) => {
    for (const node of list ?? []) {
      byId.set(node.id, node);
      parentOf.set(node.id, parent);
      // A pulley rope is not a part: its children hang off whatever it hangs off.
      walk(node.children, node.isPulleyRope ? parent : node);
    }
  };
  walk(nodes, null);
  const origin = (node: SceneNode): Vec3 | null => {
    try {
      const b = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_BODY.value, node.name || node.id);
      if (b < 0) return null;
      return [data.xpos[b * 3], data.xpos[b * 3 + 1], data.xpos[b * 3 + 2]];
    } catch {
      return null;
    }
  };
  const out: { id: string; parent: string | null; from: Vec3; to: Vec3 }[] = [];
  for (const id of ids) {
    const node = byId.get(id);
    if (!node) continue;
    const to = origin(node);
    if (!to) continue;
    const parent = parentOf.get(id) ?? null;
    const from = parent ? origin(parent) : [0, 0, 0] as Vec3;
    if (!from) continue;
    out.push({ id, parent: parent?.id ?? null, from, to });
  }
  return out;
}

interface Drawing {
  lines: Float32Array;
  arrows: Float32Array;
  locationLines: Float32Array;
  locationArrows: Float32Array;
  labels: { key: string; at: THREE.Vector3; text: string; anchor: 'centre' | 'left' | 'right'; location: boolean }[];
}

/** Which way each successive ⌀ leader on a part runs, so concentric circles do not share one. */
const LEADER_DIRECTIONS: [number, number][] = [[1, 1], [-1, 1], [1, -1], [-1, -1]].map(
  ([u, v]) => [u * Math.SQRT1_2, v * Math.SQRT1_2] as [number, number]);

const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [1, 0, 0];
};

/** Lay the dimensions out on the sheet at this many metres per pixel. Works in the document frame throughout. */
function layOut(found: BodyDimensions[], locations: LocationDim[], view: DrawingView, mpp: number): Drawing {
  const { forward, right, up } = VIEW_AXES[view];
  const out = { lines: [] as number[], arrows: [] as number[], locationLines: [] as number[], locationArrows: [] as number[] };
  const labels: Drawing['labels'] = [];
  /** A direction as it shows on the sheet: its depth dropped. */
  const onSheet = (d: Vec3) => unit(add(d, forward, -dot(d, forward)));
  const line = (target: number[], a: Vec3, b: Vec3) => {
    const p = toThree(a), q = toThree(b);
    target.push(p.x, p.y, p.z, q.x, q.y, q.z);
  };
  /** An arrowhead with its tip at `tip`, pointing along `direction` as drawn. */
  const arrow = (target: number[], tip: Vec3, direction: Vec3) => {
    const d = onSheet(direction);
    const back = add(tip, d, -ARROW_LONG_PX * mpp);
    const side = cross(forward, d);
    for (const p of [tip, add(back, side, ARROW_HALF_PX * mpp), add(back, side, -ARROW_HALF_PX * mpp)]) {
      const t = toThree(p);
      target.push(t.x, t.y, t.z);
    }
  };
  /*
   * Figures already placed, as screen rectangles (pixels on the sheet). A figure
   * that would land on one moves up the sheet until it is clear: approximate
   * widths are enough to keep two numbers from printing over each other.
   */
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const label = (key: string, spot: Vec3, text: string, anchor: 'centre' | 'left' | 'right', location = false) => {
    const w = text.length * 6.5 + 8;
    const h = 14;
    const x = dot(spot, right) / mpp;
    const y0 = dot(spot, up) / mpp;
    let y = y0;
    const x0 = anchor === 'left' ? x : anchor === 'right' ? x - w : x - w / 2;
    for (let tries = 0; tries < 6; tries++) {
      const box = { x0, x1: x0 + w, y0: y - h / 2, y1: y + h / 2 };
      if (!placed.some((p) => p.x0 < box.x1 && box.x0 < p.x1 && p.y0 < box.y1 && box.y0 < p.y1)) {
        placed.push(box);
        break;
      }
      y += h + 2;
    }
    const placedAt = add(spot, up, (y - y0) * mpp);
    // Moved off its line to stay clear of another: a thin leader back to it,
    // or the figure floats with nothing to say what it measures.
    if (y !== y0) line(location ? out.locationLines : out.lines, spot, placedAt);
    labels.push({ key, at: toThree(placedAt), text, anchor, location });
  };
  /**
   * Whether this figure is already on the sheet: the same text at the same
   * place, to the pixel. Two parts can share a face line (a birdhouse's front
   * and back walls, seen from the front), and a figure drawn twice over itself
   * reads as two.
   */
  const drawn = new Set<string>();
  const already = (text: string, ...points: Vec3[]) => {
    const key = `${text}@${points.map((p) => `${Math.round(dot(p, right) / mpp)},${Math.round(dot(p, up) / mpp)}`).join(';')}`;
    if (drawn.has(key)) return true;
    drawn.add(key);
    return false;
  };

  for (const body of found) {
    const { u: U, v: V, w: W } = body.axes;
    const at = (u: number, v: number): Vec3 => add(add(add([0, 0, 0], U, u), V, v), W, body.depth);
    // A pixel along each of the part's axes, which may be drawn foreshortened.
    const fu = Math.max(0.05, Math.hypot(...add(U, forward, -dot(U, forward))));
    const fv = Math.max(0.05, Math.hypot(...add(V, forward, -dot(V, forward))));
    const pu = (n: number) => (n * mpp) / fu;
    const pv = (n: number) => (n * mpp) / fv;
    let diameterCount = 0;
    const hasChain = { u: false, v: false };
    for (const d of body.dims) if (d.kind === 'linear' && d.row === 1) hasChain[d.axis] = true;

    body.dims.forEach((d, i) => {
      const key = `${body.id}:${i}`;
      if (d.kind === 'linear') {
        const row = d.row === 2 && !hasChain[d.axis] ? 1 : d.row;
        const along = d.axis === 'u' ? U : V;
        const spanPx = ((d.b - d.a) * (d.axis === 'u' ? fu : fv)) / mpp;
        // Too short to hold its figure between the arrows: the figure goes past
        // an end — the near one when this is the first of its chain, where
        // nothing else is drawn, and otherwise the far one.
        const outside = spanPx < 34;
        const first = d.a <= (d.axis === 'u' ? body.bounds.u[0] : body.bounds.v[0]) + 1e-9;
        // (along, across) on the part's sheet, whichever way this one measures.
        const pt = d.axis === 'u' ? (s: number, t: number) => at(s, t) : (s: number, t: number) => at(t, s);
        const pa = d.axis === 'u' ? pu : pv;
        const pc = d.axis === 'u' ? pv : pu;
        const rowAt = d.edge - pc(ROW_PX[row]);
        if (already(d.label, pt(d.a, rowAt), pt(d.b, rowAt))) return;
        line(out.lines, pt(d.a, d.anchorA - pc(GAP_PX)), pt(d.a, rowAt - pc(OVERSHOOT_PX)));
        line(out.lines, pt(d.b, d.anchorB - pc(GAP_PX)), pt(d.b, rowAt - pc(OVERSHOOT_PX)));
        line(out.lines, pt(d.a, rowAt), pt(d.b, rowAt));
        arrow(out.arrows, pt(d.a, rowAt), [-along[0], -along[1], -along[2]]);
        arrow(out.arrows, pt(d.b, rowAt), along);
        const trailing = outside && !first;
        const spot = !outside ? pt((d.a + d.b) / 2, rowAt)
          : first ? pt(d.a - pa(d.axis === 'u' ? 16 : 10), rowAt)
          : pt(d.b + pa(d.axis === 'u' ? 6 : 10), rowAt);
        label(key, spot, d.label, trailing && d.axis === 'u' ? 'left' : 'centre');
      } else if (d.kind === 'diameter') {
        // Across the circle at 45°, out past the rim to a short shoulder. Each
        // further ⌀ on the part turns a quarter, so a counterbore's two circles
        // are not labelled up the same line.
        const [ku, kv] = LEADER_DIRECTIONS[diameterCount++ % LEADER_DIRECTIONS.length];
        const [cu, cv] = d.centre;
        if (already(d.label, at(cu, cv), at(cu + d.radius, cv))) return;
        const k = add(add([0, 0, 0], U, ku), V, kv);
        const near = at(cu - ku * d.radius, cv - kv * d.radius);
        const far = at(cu + ku * d.radius, cv + kv * d.radius);
        const outward = onSheet(k);
        const elbow = add(far, outward, LEADER_PX * mpp);
        const side = dot(outward, right) >= 0 ? 1 : -1;
        line(out.lines, near, elbow);
        line(out.lines, elbow, add(elbow, right, side * SHOULDER_PX * mpp));
        arrow(out.arrows, near, [-k[0], -k[1], -k[2]]);
        arrow(out.arrows, far, k);
        label(key, add(elbow, right, side * (SHOULDER_PX + 3) * mpp), d.label, side > 0 ? 'left' : 'right');
      } else {
        // From the sheet's horizontal or vertical round to the part's long
        // axis, both drawn out from the middle of the part.
        const centre = at(...d.centre);
        if (already(d.label, centre, add(centre, d.to, mpp * 40))) return;
        const theta = Math.acos(Math.min(1, Math.max(-1, dot(d.from, d.to))));
        const g = unit(add(d.to, d.from, -dot(d.to, d.from)));
        const reach = (ARC_PX + ARC_OVERRUN_PX) * mpp;
        line(out.lines, centre, add(centre, d.from, reach));
        line(out.lines, centre, add(centre, d.to, reach));
        const arcAt = (phi: number, r: number) => add(add(centre, d.from, r * Math.cos(phi)), g, r * Math.sin(phi));
        const steps = 12;
        for (let s = 0; s < steps; s++) {
          line(out.lines, arcAt((theta * s) / steps, ARC_PX * mpp), arcAt((theta * (s + 1)) / steps, ARC_PX * mpp));
        }
        label(key, arcAt(theta / 2, (ARC_PX + 16) * mpp), d.label, 'centre');
      }
    });
  }

  // Where each part sits: up from the reference origin, then across to the
  // part's. Across goes at the part's own height, inside the drawing, rather
  // than along the floor, where it ran off the sheet under the toolbar.
  for (const loc of locations) {
    const depth = 0;
    const at = (u: number, v: number): Vec3 => add(add(add([0, 0, 0], right, u), up, v), forward, depth);
    const from = at(...loc.from);
    const corner = at(loc.from[0], loc.to[1]);
    const to = at(...loc.to);
    for (const p of [from, to]) {
      line(out.locationLines, add(p, right, -MARK_PX * mpp), add(p, right, MARK_PX * mpp));
      line(out.locationLines, add(p, up, -MARK_PX * mpp), add(p, up, MARK_PX * mpp));
    }
    const leg = (a: Vec3, b: Vec3, text: string, key: string) => {
      if (already(`loc:${text}`, a, b)) return;
      const d = unit(add(b, a, -1));
      line(out.locationLines, a, b);
      arrow(out.locationArrows, a, [-d[0], -d[1], -d[2]]);
      arrow(out.locationArrows, b, d);
      // On a long leg the figure sits near the part, which is in the drawing,
      // not halfway back to an origin that may be off the sheet (on the floor
      // under the toolbar).
      const lengthPx = Math.hypot(...add(b, a, -1)) / mpp;
      label(key, lengthPx > 80 ? add(b, d, -28 * mpp) : add(a, add(b, a, -1), 0.5), text, 'centre', true);
    };
    if (loc.up) leg(from, corner, loc.up.label, `${loc.id}:up`);
    if (loc.across) leg(corner, to, loc.across.label, `${loc.id}:across`);
  }

  return {
    lines: new Float32Array(out.lines),
    arrows: new Float32Array(out.arrows),
    locationLines: new Float32Array(out.locationLines),
    locationArrows: new Float32Array(out.locationArrows),
    labels,
  };
}

/**
 * What physics_get_camera reports: every figure drawn, in the order drawn, and
 * like the sheet, each once. Two parts sharing a face line (a birdhouse's front
 * and back walls, seen from the front) give the same figure at the same place;
 * the first keeps it and names the rest in `sharedWith`.
 */
function liveList(found: BodyDimensions[], locations: LocationDim[], parents: Map<string, string | null>, view: DrawingView): LiveDimension[] {
  const { right, up } = VIEW_AXES[view];
  const out: LiveDimension[] = [];
  const seen = new Map<string, LiveDimension>();
  const keep = (key: string, entry: LiveDimension) => {
    const first = seen.get(key);
    if (first) {
      if (first.body !== entry.body && !first.sharedWith?.includes(entry.body)) {
        first.sharedWith = [...(first.sharedWith ?? []), entry.body];
      }
      return;
    }
    seen.set(key, entry);
    out.push(entry);
  };
  /** A place on the sheet, to a tenth of a millimetre. */
  const spot = (p: Vec3) => `${Math.round(dot(p, right) * 1e4)},${Math.round(dot(p, up) * 1e4)}`;
  for (const b of found) {
    const { u: U, v: V } = b.axes;
    const at = (u: number, v: number) => add(add([0, 0, 0], U, u), V, v);
    for (const d of b.dims) {
      if (d.kind === 'linear') {
        const pt = d.axis === 'u' ? (s: number) => at(s, d.edge) : (s: number) => at(d.edge, s);
        keep(`${d.kind}:${d.row}:${d.label}@${spot(pt(d.a))};${spot(pt(d.b))}`, {
          body: b.id, kind: d.kind, direction: d.axis === 'u' ? 'width' : 'height',
          row: d.row === 1 ? 'chain' : 'overall', label: d.label, valueMm: d.valueMm,
        });
      } else if (d.kind === 'diameter') {
        keep(`${d.kind}:${d.label}@${spot(at(...d.centre))}`,
          { body: b.id, kind: d.kind, count: d.count, label: d.label, valueMm: d.valueMm });
      } else {
        keep(`${d.kind}:${d.label}@${spot(at(...d.centre))}`, { body: b.id, kind: d.kind, label: d.label, valueDeg: d.valueDeg });
      }
    }
  }
  for (const loc of locations) {
    const from = parents.get(loc.id) ?? 'origin';
    if (loc.up) out.push({ body: loc.id, kind: 'location', direction: 'height', from, label: loc.up.label, valueMm: loc.up.valueMm });
    if (loc.across) out.push({ body: loc.id, kind: 'location', direction: 'width', from, label: loc.across.label, valueMm: loc.across.valueMm });
  }
  return out;
}

export function DimensionOverlay() {
  const cameraView = useStore((s) => s.cameraView);
  const dimsEnabled = useStore((s) => s.dimsEnabled);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const scene = useThree((s) => s.scene);
  const view = isDrawingView(cameraView) ? cameraView : null;
  const on = dimsEnabled && view !== null;

  // Tagged with what it was measured for, so a change of view or selection
  // never draws the last one's figures on the new sheet while it re-measures.
  const [found, setFound] = useState<{ key: string; dims: BodyDimensions[]; locations: LocationDim[] }>({ key: '', dims: [], locations: [] });
  const measuring = `${view}|${selectedNodeId ?? ''}`;
  const [mpp, setMpp] = useState(0);
  const [square, setSquare] = useState(false);
  const cache = useRef(new Map<string, { signature: string; dims: BodyDimensions | null }>());
  const lastSignature = useRef('');
  const lastPoll = useRef(0);
  const forward = useMemo(() => new THREE.Vector3(), []);

  // A new view or a new selection measures from scratch.
  useEffect(() => {
    cache.current.clear();
    lastSignature.current = '';
    lastPoll.current = 0;
    if (!on) setLiveDimensions([]);
  }, [on, view, selectedNodeId]);

  useFrame(({ camera, size }) => {
    if (!on || !view) return;
    const ortho = camera as THREE.OrthographicCamera;
    if (!ortho.isOrthographicCamera) {
      if (square) setSquare(false);
      return;
    }
    camera.getWorldDirection(forward);
    const isSquare = forward.dot(toThree(VIEW_AXES[view].forward)) >= SQUARE_TO_VIEW;
    if (isSquare !== square) setSquare(isSquare);

    const perPixel = (ortho.top - ortho.bottom) / (ortho.zoom * Math.max(1, size.height));
    if (!(mpp > 0) || Math.abs(perPixel / mpp - 1) > 0.01) setMpp(perPixel);

    const now = performance.now();
    if (now - lastPoll.current < POLL_MS) return;
    lastPoll.current = now;
    const pieces = drawnPieces(scene, selectedNodeId);
    let signature = '';
    for (const [id, entry] of pieces) signature += `${id}=${entry.signature.length}:${hashOf(entry.signature)}|`;
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;

    // Per body, so a sim moving one part re-measures that part alone.
    const next: BodyDimensions[] = [];
    for (const [id, entry] of pieces) {
      let hit = cache.current.get(id);
      if (!hit || hit.signature !== entry.signature) {
        hit = { signature: entry.signature, dims: bodyViewDimensions(bodyMesh(id, entry.pieces), view) };
        cache.current.set(id, hit);
      }
      const d = hit.dims;
      if (!d) continue;
      if (d.bounds.u[1] - d.bounds.u[0] > MAX_PART_M || d.bounds.v[1] - d.bounds.v[0] > MAX_PART_M) continue;
      next.push(d);
    }
    const links = locationLinks(next.map((d) => d.id), useStore.getState().sceneGraph.nodes);
    const located = selectedNodeId || links.length <= MAX_LOCATIONS ? locationDimensions(links, view) : [];
    setFound({ key: measuring, dims: next, locations: located });
    setLiveDimensions(liveList(next, located, new Map(links.map((l) => [l.id, l.parent])), view));
  });

  const drawing = useMemo(
    () => (on && view && square && mpp > 0 && found.key === measuring ? layOut(found.dims, found.locations, view, mpp) : null),
    [on, view, square, mpp, found, measuring],
  );
  const geometries = useMemo(() => {
    const make = (array: Float32Array | undefined) => {
      const g = new THREE.BufferGeometry();
      if (array) g.setAttribute('position', new THREE.BufferAttribute(array, 3));
      return g;
    };
    return {
      lines: make(drawing?.lines),
      arrows: make(drawing?.arrows),
      locationLines: make(drawing?.locationLines),
      locationArrows: make(drawing?.locationArrows),
    };
  }, [drawing]);
  useEffect(() => () => Object.values(geometries).forEach((g) => g.dispose()), [geometries]);
  useEffect(() => () => setLiveDimensions([]), []);

  if (!drawing) return null;
  return (
    <group>
      {([['lines', 'arrows', COLOUR], ['locationLines', 'locationArrows', LOCATION_COLOUR]] as const).map(([lines, arrows, colour]) => (
        <group key={lines}>
          <lineSegments geometry={geometries[lines]} raycast={() => null} renderOrder={997}>
            <lineBasicMaterial color={colour} depthTest={false} transparent toneMapped={false} />
          </lineSegments>
          <mesh geometry={geometries[arrows]} raycast={() => null} renderOrder={998}>
            <meshBasicMaterial color={colour} depthTest={false} side={THREE.DoubleSide} transparent toneMapped={false} />
          </mesh>
        </group>
      ))}
      {drawing.labels.map((label) => (
        <Html
          key={label.key}
          position={label.at}
          // drei's `center` is a transform on the same element `style` styles,
          // so a label anchored at one edge sets its own instead.
          center={label.anchor === 'centre'}
          // Under the viewport's floating panels (z-10), not over them.
          zIndexRange={[9, 1]}
          style={label.anchor === 'left'
            ? { pointerEvents: 'none', transform: 'translate(0, -50%)' }
            : label.anchor === 'right'
              ? { pointerEvents: 'none', transform: 'translate(-100%, -50%)' }
              : { pointerEvents: 'none' }}
        >
          <span className={`px-1 rounded-sm bg-white/90 dark:bg-slate-900/90 text-[10px] font-mono font-semibold tabular-nums whitespace-nowrap shadow-xs ${label.location ? 'text-cyan-700 dark:text-cyan-400' : 'text-amber-700 dark:text-amber-400'}`}>
            {label.text}
          </span>
        </Html>
      ))}
    </group>
  );
}

/** A short fingerprint of a long signature. */
function hashOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}
