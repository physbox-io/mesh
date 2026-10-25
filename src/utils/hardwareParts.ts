// ---------------------------------------------------------------------------
// Bought hardware: bearings, cap screws, nuts and shafts
//
// The other half of utils/hardwareCuts.ts. A cut is the seat a part is given;
// this is the thing that goes in it, sized from the same table
// (utils/hardwareSizes.ts) so the two cannot disagree.
//
// Only hardware that changes what the simulation does is here. A bearing lets
// something turn — its inner race is a body of its own on a hinge. A screw
// holds two parts together — it welds the part it reaches into to the one it
// sits in. A nut and a shaft are what those two need beside them. A washer
// does nothing a solver can see, so it is an option on the screw: it adds to
// the stack under the head and nothing else.
//
// THREE THINGS WORTH KNOWING
//
// 1. A SEATED PART TAKES NO CONTACTS. Dropped into a cut, a part becomes a child
//    of the body it is in: rigid to it, and moved with it. Its geoms are then
//    taken out of the contact solver. A bearing pressed into a pocket overlaps
//    that pocket's walls by its fit, and the part around it collides as convex
//    pieces that need not follow a bore exactly — left in, the two would push
//    each other apart. What holds a seated part is the hierarchy, and what
//    moves it is its joint: that is the mechanism, not the contacts.
//
// 2. EVERY POSE IS IN THE COMPILED FRAME. A cut's `pos` is written in the frame
//    the body was authored in, but a body with holes is drawn and simulated from
//    a solid re-origined on its centre of mass; `csgFrameOffset` is the
//    difference. A child's pos is in the second frame, so a seat is worked out
//    in the first and moved by the offset — and re-worked whenever the offset
//    changes, which is every time the part around it is recompiled.
//
// 3. A FASTENING IS A WELD ON THE OTHER BODY. A screw finds the next hole along
//    its line in some other body, and that body is welded to the one the screw
//    sits in (SceneNode.weldTargetId). The screw records it, so taking the
//    screw out takes the weld with it — but only a weld the screw made.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { HardwareCutKind, HardwarePart, HardwarePartKind, SceneGeom, SceneGraph, SceneNode } from '../types/scene';
import { csgFrameOffset, csgSourceGeoms, fromtoFrame, geomMatrixOf, surfaceUnder } from './csg';
import { hardwareSpecOf } from './hardwareCuts';
import { getNodeWorldTransform } from './laserCutExporter';
import { BEARINGS, BOLTS, CAP_SCREW_HEADS, HEX_NUTS, SCREW_LENGTHS, SHAFTS, WASHERS, screwLengthAtMost } from './hardwareSizes';
import { metricThread } from './metricThreads';
import { isBoughtIn } from './boughtIn';

export interface HardwarePartInfo {
  label: string;
  sizes: readonly string[];
  defaultSize: string;
  /** Lengths it is sold in, mm, when it has a length. */
  lengths?: readonly number[];
  defaultLengthMm?: number;
  hint: string;
}

const SHAFT_LENGTHS = [10, 16, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300] as const;

export const HARDWARE_PARTS: Record<HardwarePartKind, HardwarePartInfo> = {
  bearing: {
    label: 'Bearing', sizes: Object.keys(BEARINGS), defaultSize: '608',
    hint: 'A ball bearing. Its inner race turns on a hinge, so whatever is fixed to it spins.',
  },
  screw: {
    label: 'Cap screw', sizes: BOLTS, defaultSize: 'M3', lengths: SCREW_LENGTHS, defaultLengthMm: 12,
    hint: 'A socket head cap screw. Seated in a hole, it holds the part it reaches into to the one it sits in.',
  },
  nut: {
    label: 'Nut', sizes: BOLTS, defaultSize: 'M3',
    hint: 'A hex nut, for a nut trap or the end of a screw.',
  },
  shaft: {
    label: 'Shaft', sizes: SHAFTS, defaultSize: '8', lengths: SHAFT_LENGTHS, defaultLengthMm: 50,
    hint: 'A ground steel shaft or dowel pin, for a bearing to carry or a hole to locate on.',
  },
};

/** The parts that go in each kind of hardware cut, the one it is made for first. */
export const PARTS_FOR_CUT: Record<HardwareCutKind, HardwarePartKind[]> = {
  bearing: ['bearing'],
  counterbore: ['screw'],
  nut_trap: ['nut'],
  insert: ['screw'],
  insert_boss: ['screw'],
};

export { isBoughtIn };

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const STEEL = 7850; // kg/m³
const BRIGHT: [number, number, number, number] = [0.74, 0.76, 0.79, 1];
const BLACK_OXIDE: [number, number, number, number] = [0.17, 0.17, 0.19, 1];
const SHIELD: [number, number, number, number] = [0.36, 0.38, 0.42, 1];
const mm = (v: number) => +(v / 1000).toFixed(7);

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

/** A hexagon's radius at an angle, corners on +X as OpenSCAD's `$fn = 6` puts them. */
const hexRadius = (flats: number) => (theta: number) => {
  const sector = ((theta % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3);
  return flats / 2 / Math.cos(sector - Math.PI / 6);
};

function ringGeom(
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

function cylinderGeom(name: string, r: number, h: number, z: number, rgba: number[], extra: Partial<SceneGeom> = {}): SceneGeom {
  return {
    name, type: 'cylinder', size: [r, h / 2], pos: [0, 0, +z.toFixed(7)], rgba: [...rgba],
    mass: +(Math.PI * r * r * h * STEEL).toFixed(7), dynamic: true, ...extra,
  };
}

/** Drawn only: no contacts and no mass, so it changes nothing the solver sees. */
function visual(g: SceneGeom): SceneGeom {
  const { mass: _mass, dynamic: _dynamic, condim: _condim, ...rest } = g;
  return { ...rest, role: 'visual' };
}

const sizeOf = (kind: HardwarePartKind, size: string) => {
  const info = HARDWARE_PARTS[kind];
  return info.sizes.includes(size) ? size : info.defaultSize;
};

/** The spec with its size and length made valid, defaults filled in. */
export function normalizePart(spec: HardwarePart): HardwarePart {
  const info = HARDWARE_PARTS[spec.kind];
  const out: HardwarePart = { ...spec, size: sizeOf(spec.kind, spec.size) };
  if (info.defaultLengthMm !== undefined) {
    const l = spec.lengthMm && spec.lengthMm > 0 ? spec.lengthMm : info.defaultLengthMm;
    out.lengthMm = +l.toFixed(3);
  } else {
    delete out.lengthMm;
  }
  if (spec.kind !== 'screw' || !spec.washer) delete out.washer;
  return out;
}

/** What the hierarchy calls it: "608 bearing", "M3×12 cap screw". */
export function hardwarePartName(spec: HardwarePart): string {
  const p = normalizePart(spec);
  switch (p.kind) {
    case 'bearing': return `${p.size} bearing`;
    case 'screw': return `${p.size}×${p.lengthMm} cap screw${p.washer ? ' + washer' : ''}`;
    case 'nut': return `${p.size} nut`;
    case 'shaft': return `Ø${p.size}×${p.lengthMm} shaft`;
  }
}

/**
 * One bought part, as a body standing on its own: free to fall, colliding
 * like anything else. Seating it in a cut is a separate step (`seatPart`).
 *
 * Its own +Z is its axis. A bearing, a nut and a shaft are centred on their
 * origin; a screw's origin is where it bears — under its head, or under its
 * washer — with the shank down -Z, because that is the point a seat is.
 */
export function hardwarePartNode(spec: HardwarePart, id: string): SceneNode {
  const p = normalizePart(spec);
  const node: SceneNode = {
    id, name: hardwarePartName(p), type: 'body', pos: [0, 0, 0],
    geoms: [], joints: [{ name: `${id}_free`, type: 'free' }], children: [],
    hardwarePart: p,
  };
  switch (p.kind) {
    case 'bearing': {
      const [od, bore, width] = BEARINGS[p.size];
      const race = ((od - bore) / 2) * 0.3;
      const W = mm(width);
      node.geoms = [
        ringGeom(`${id}_outer`, mm(od / 2), mm(od / 2 - race), W, 0, BRIGHT),
        // The shields are part of the outer race, as on the real thing: they
        // stay still while the inner race turns inside them.
        visual(ringGeom(`${id}_shield`, mm(od / 2 - race), mm(bore / 2 + race), W * 0.9, 0, SHIELD)),
      ];
      node.children = [{
        id: `${id}_inner`, name: `${hardwarePartName(p)} inner race`, type: 'body', pos: [0, 0, 0],
        geoms: [ringGeom(`${id}_inner_race`, mm(bore / 2 + race), mm(bore / 2), W, 0, BRIGHT)],
        // About a shielded skate bearing's drag: an inner race weighs grams,
        // so anything like a printed hinge's damping would stop it dead.
        joints: [{ name: `${id}_spin`, type: 'hinge', axis: [0, 0, 1], pos: [0, 0, 0], damping: 1e-7 }],
        children: [],
        hardwarePart: { ...p, piece: 'inner' },
      }];
      break;
    }
    case 'screw': {
      const thread = metricThread(p.size);
      const d = thread ? thread[1] : 3;
      const [headD, headH, key] = CAP_SCREW_HEADS[p.size];
      const under = p.washer ? WASHERS[p.size][2] : 0;
      const L = p.lengthMm!;
      node.geoms = [
        ...(p.washer ? [ringGeom(`${id}_washer`, mm(WASHERS[p.size][1] / 2), mm(WASHERS[p.size][0] / 2), mm(under), mm(under / 2), BRIGHT)] : []),
        cylinderGeom(`${id}_head`, mm(headD / 2), mm(headH), mm(under + headH / 2), BLACK_OXIDE),
        // The socket, drawn: only a hex key needs to know its shape.
        visual(cylinderGeom(`${id}_socket`, mm(key / 2), mm(0.1), mm(under + headH), [0.05, 0.05, 0.06, 1])),
        cylinderGeom(`${id}_shank`, mm(d / 2), mm(L), mm(-L / 2), BLACK_OXIDE),
      ];
      break;
    }
    case 'nut': {
      const [flats, height] = HEX_NUTS[p.size];
      const thread = metricThread(p.size);
      // Drawn to the thread's minor diameter, which is where its metal stops.
      const minor = thread ? thread[1] - 1.0825 * thread[2] : flats / 2;
      node.geoms = [ringGeom(`${id}_nut`, mm(flats / Math.sqrt(3)), mm(minor / 2), mm(height), 0, BRIGHT, {}, hexRadius(mm(flats)), 12)];
      // A hexagon's area, not the circle round its corners, is what it weighs.
      const area = (Math.sqrt(3) / 2) * mm(flats) ** 2 - Math.PI * mm(minor / 2) ** 2;
      node.geoms[0].mass = +(area * mm(height) * STEEL).toFixed(7);
      break;
    }
    case 'shaft': {
      const d = Number(p.size);
      node.geoms = [cylinderGeom(`${id}_shaft`, mm(d / 2), mm(p.lengthMm!), 0, BRIGHT)];
      break;
    }
  }
  return node;
}

/** Every body of a part, the part itself first: a bearing is two. */
function partBodies(node: SceneNode): SceneNode[] {
  const out: SceneNode[] = [node];
  for (const c of node.children || []) if (c.hardwarePart?.piece) out.push(...partBodies(c));
  return out;
}

/**
 * Builds the part again from its spec, in place: same id, same pose, same
 * seat, and the same bodies under it that are not pieces of it — a wheel fixed
 * to a bearing's inner race stays fixed to the new one.
 */
export function rebuildPart(node: SceneNode, spec: HardwarePart): void {
  const was = node.hardwarePart;
  const fresh = hardwarePartNode({
    ...spec,
    ...(spec.seat ?? was?.seat ? { seat: spec.seat ?? was?.seat } : {}),
    ...(spec.fastens ?? was?.fastens ? { fastens: spec.fastens ?? was?.fastens } : {}),
  }, node.id);
  const keptUnder = (n: SceneNode | undefined) => (n?.children || []).filter((c) => !c.hardwarePart?.piece);
  const oldInner = (node.children || []).find((c) => c.hardwarePart?.piece === 'inner');
  const freshInner = fresh.children.find((c) => c.hardwarePart?.piece === 'inner');
  if (freshInner) freshInner.children = keptUnder(oldInner);
  node.name = fresh.name;
  node.geoms = fresh.geoms;
  node.hardwarePart = fresh.hardwarePart;
  node.children = [...fresh.children, ...keptUnder(node)];
  if (node.hardwarePart?.seat) quiet(node);
  else if (!node.joints?.length) node.joints = fresh.joints;
}

/** Takes a part's geoms out of the contact solver; see note 1 at the top. */
function quiet(node: SceneNode) {
  for (const body of partBodies(node)) {
    for (const g of body.geoms) {
      if (g.role === 'visual') continue;
      g.contype = 0;
      g.conaffinity = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Seating
// ---------------------------------------------------------------------------

/** The cut piece a part is placed against: the pocket it drops into, or the bore it goes down. */
const SEAT_PIECE: Record<HardwareCutKind, string> = {
  bearing: 'pocket', nut_trap: 'pocket', counterbore: 'head', insert: 'bore', insert_boss: 'bore',
};

export interface Seat {
  /** In the host body's compiled frame, which a child's pos is read in. */
  pos: number[];
  quat: number[];
  /** The part as this cut sizes it. */
  part: HardwarePart;
  /** For a screw: the far side of the hole, as a distance along the screw from where it bears, m. */
  gripM?: number;
}

/**
 * Where a part goes in one of a body's hardware cuts, and what size it is.
 * Null when the body has no such cut, or the cut takes no part of this kind.
 */
export function seatFor(host: SceneNode, group: string, kind?: HardwarePartKind): Seat | null {
  const spec = hardwareSpecOf(host.geoms || [], group);
  if (!spec) return null;
  const partKind = kind ?? PARTS_FOR_CUT[spec.kind][0];
  if (!PARTS_FOR_CUT[spec.kind].includes(partKind)) return null;
  const piece = (host.geoms || []).find((g) => g.hardware?.group === group && g.hardware.part === SEAT_PIECE[spec.kind] && !g.csgDerived);
  if (!piece?.pos || !piece.size) return null;

  const n = new THREE.Vector3(...(spec.normal as [number, number, number])).normalize();
  const reach = piece.cutDepth ?? 0;
  // A blind cut's cutter runs from `reach` inside the surface to the overshoot
  // outside it, so the surface is `reach - half` out from the cutter's centre.
  const entry = new THREE.Vector3(...(piece.pos as [number, number, number])).addScaledVector(n, reach - (piece.size[1] ?? 0));
  const offset = csgFrameOffset(host);
  const quat = piece.quat ? [...piece.quat] : (() => {
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    return [q.w, q.x, q.y, q.z];
  })();
  const at = (p: THREE.Vector3) => [p.x - (offset[0] ?? 0), p.y - (offset[1] ?? 0), p.z - (offset[2] ?? 0)].map((v) => +v.toFixed(7));

  switch (partKind) {
    case 'bearing': {
      const width = mm(BEARINGS[spec.size][2]);
      return { pos: at(entry.clone().addScaledVector(n, -width / 2)), quat, part: { kind: 'bearing', size: spec.size } };
    }
    case 'nut': {
      // On the floor of its trap, where it ends up once it has dropped in.
      const height = mm(HEX_NUTS[spec.size][1]);
      return { pos: at(entry.clone().addScaledVector(n, -(reach - height / 2))), quat, part: { kind: 'nut', size: spec.size } };
    }
    case 'screw': {
      if (spec.kind === 'counterbore') {
        // Bearing on the counterbore's floor, through the rest of the part.
        const floor = entry.clone().addScaledVector(n, -reach);
        const through = surfaceUnder(host, spec.at, spec.normal)?.thickness ?? reach;
        return { pos: at(floor), quat, part: { kind: 'screw', size: spec.size, lengthMm: 0 }, gripM: Math.max(0, through - reach) };
      }
      // Into an insert, from outside: bearing on the surface, as deep as the insert.
      return { pos: at(entry), quat, part: { kind: 'screw', size: spec.size, lengthMm: screwLengthAtMost(reach * 1000) }, gripM: 0 };
    }
    default:
      return null;
  }
}

/**
 * Makes `node` the part that sits in `host`'s cut `group`, and moves it there.
 * It should already be a child of `host`. Returns false when it cannot go there.
 */
export function seatPart(node: SceneNode, host: SceneNode, group: string, lengthMm?: number): boolean {
  const kind = node.hardwarePart?.kind;
  const seat = kind && seatFor(host, group, kind);
  if (!seat) return false;
  const part: HardwarePart = { ...node.hardwarePart!, ...seat.part, seat: group };
  if (kind === 'screw') {
    part.washer = false; // a washer does not fit in a counterbore, nor between an insert and its screw
    part.lengthMm = lengthMm ?? (seat.part.lengthMm || node.hardwarePart?.lengthMm || HARDWARE_PARTS.screw.defaultLengthMm!);
  }
  node.pos = seat.pos;
  node.quat = seat.quat;
  delete node.euler;
  delete node.rot;
  node.joints = [];
  rebuildPart(node, part);
  quiet(node);
  return true;
}

/**
 * Moves every part seated in `host` back onto its cut, after the cuts or the
 * frame they are read in have changed. A part whose cut is gone stays where it
 * is, rigid to the body, and is no longer seated.
 */
export function reseatHardware(host: SceneNode): void {
  for (const child of host.children || []) {
    const group = child.hardwarePart?.seat;
    if (!group || child.hardwarePart?.piece) continue;
    const seat = seatFor(host, group, child.hardwarePart!.kind);
    if (!seat) {
      delete child.hardwarePart!.seat;
      continue;
    }
    child.pos = seat.pos;
    child.quat = seat.quat;
    const size = seat.part.size;
    if (size !== child.hardwarePart!.size) rebuildPart(child, { ...child.hardwarePart!, size });
  }
}

/** True when some part in `host` is seated in `group`. */
export function seatedIn(host: SceneNode, group: string): SceneNode | undefined {
  return (host.children || []).find((c) => c.hardwarePart?.seat === group && !c.hardwarePart.piece);
}

// ---------------------------------------------------------------------------
// Fastening
// ---------------------------------------------------------------------------

function findPath(nodes: SceneNode[], id: string, trail: SceneNode[] = []): SceneNode[] | null {
  for (const n of nodes) {
    const here = [...trail, n];
    if (n.id === id) return here;
    const below = findPath(n.children || [], id, here);
    if (below) return below;
  }
  return null;
}

/** A body's world matrix as the document places it: its own pose on its parents'. */
export function documentWorldMatrix(scene: SceneGraph, id: string): THREE.Matrix4 | null {
  const path = findPath(scene.nodes, id);
  if (!path) return null;
  let m: THREE.Matrix4 | undefined;
  for (const n of path) m = getNodeWorldTransform(n, m);
  return m ?? null;
}

export interface FastenTarget {
  node: SceneNode;
  /** How far along the screw, from where it bears, its thread can reach into this body, m. */
  reachM: number;
}

/**
 * The body a screw seated in `host` would screw into: the nearest hole in any
 * other body that lies on the screw's line, past the far side of `host`.
 *
 * Holes are read from the document, as mate snapping reads them
 * (mateFeatures.documentAxes): after a boolean all that is left on screen is a
 * ring of vertices, and the cut that made the hole still has its exact axis.
 */
export function fastenTargetFor(scene: SceneGraph, host: SceneNode, screw: SceneNode, gripM: number): FastenTarget | null {
  const screwWorld = documentWorldMatrix(scene, screw.id);
  if (!screwWorld) return null;
  const S = new THREE.Vector3().setFromMatrixPosition(screwWorld);
  const down = new THREE.Vector3(0, 0, -1).transformDirection(screwWorld);
  const thread = metricThread(screw.hardwarePart!.size);
  const d = (thread ? thread[1] : 3) / 1000;
  const skip = new Set<string>();
  const mark = (n: SceneNode) => { skip.add(n.id); (n.children || []).forEach(mark); };
  mark(host);
  for (const n of findPath(scene.nodes, host.id) ?? []) skip.add(n.id);

  let best: FastenTarget | null = null;
  let bestStart = Infinity;
  const visit = (n: SceneNode) => {
    if (!skip.has(n.id) && !isBoughtIn(n)) {
      const world = documentWorldMatrix(scene, n.id);
      const offset = csgFrameOffset(n);
      for (const g of world ? csgSourceGeoms(n) : []) {
        if (g.type !== 'cylinder' || g.csg !== 'difference') continue;
        const f = g.fromto && g.fromto.length >= 6 ? fromtoFrame(g.fromto) : { matrix: geomMatrixOf(g), halfLen: g.size?.[1] ?? 0 };
        const local = new THREE.Vector3().setFromMatrixPosition(f.matrix).sub(new THREE.Vector3(offset[0] ?? 0, offset[1] ?? 0, offset[2] ?? 0));
        const centre = local.applyMatrix4(world!);
        const axis = new THREE.Vector3(0, 0, 1).transformDirection(f.matrix).transformDirection(world!);
        if (Math.abs(axis.dot(down)) < 0.98) continue;
        const along = centre.clone().sub(S).dot(down);
        const across = centre.clone().sub(S).addScaledVector(down, -along).length();
        if (across > Math.max(0.0006, (g.size?.[0] ?? 0) * 0.5)) continue;
        const half = f.halfLen ?? 0;
        const start = along - half;
        const end = along + half;
        // Past the host's far side (a little slack for faces that touch), and
        // close enough to it that a screw this size could reach.
        if (end < gripM + 0.0005 || start > gripM + 3 * d + 0.03) continue;
        if (start < bestStart) {
          bestStart = start;
          best = { node: n, reachM: Math.min(end, Math.max(start, gripM) + 2.5 * d) };
        }
      }
    }
    (n.children || []).forEach(visit);
  };
  scene.nodes.forEach(visit);
  return best;
}

/**
 * The length a seated screw should be and, if it reaches one, the body it
 * fastens. Into nothing, it is the grip plus the engagement a thread of its
 * size wants, so it shows what still needs a part to go into.
 */
export function screwFit(scene: SceneGraph, host: SceneNode, screw: SceneNode, gripM: number): { lengthMm: number; target: SceneNode | null } {
  const thread = metricThread(screw.hardwarePart!.size);
  const d = (thread ? thread[1] : 3) / 1000;
  const target = fastenTargetFor(scene, host, screw, gripM);
  const reach = target ? target.reachM : gripM + 1.5 * d;
  return { lengthMm: screwLengthAtMost(reach * 1000), target: target?.node ?? null };
}

/**
 * Welds `target` to `host`, for the screw that holds them. False when the
 * target is already welded to something, which this will not overwrite.
 */
export function fasten(screw: SceneNode, host: SceneNode, target: SceneNode): boolean {
  if (target.weldTargetId && target.weldTargetId !== host.id) return false;
  target.weldTargetId = host.id;
  screw.hardwarePart = { ...screw.hardwarePart!, fastens: target.id };
  return true;
}

/**
 * Before `doomed` bodies are taken out of the scene: removes the welds their
 * screws made, unless another screw that stays holds the same two together.
 * Mutates `scene`.
 */
export function releaseFastenings(scene: SceneGraph, doomed: ReadonlySet<string>): void {
  const holds: { host: string; target: string; screw: string; gone: boolean }[] = [];
  const walk = (nodes: SceneNode[], parent: SceneNode | null, gone: boolean) => {
    for (const n of nodes) {
      const isGone = gone || doomed.has(n.id);
      if (n.hardwarePart?.fastens && parent) holds.push({ host: parent.id, target: n.hardwarePart.fastens, screw: n.id, gone: isGone });
      walk(n.children || [], n, isGone);
    }
  };
  walk(scene.nodes, null, false);
  for (const h of holds) {
    if (!h.gone) continue;
    if (holds.some((o) => !o.gone && o.host === h.host && o.target === h.target)) continue;
    const target = findPath(scene.nodes, h.target)?.at(-1);
    if (target && target.weldTargetId === h.host) delete target.weldTargetId;
  }
}

/** The next size up or down the part's list, for a size-stepping key. */
export function stepPartSize(spec: HardwarePart, step: 1 | -1): string {
  const sizes = HARDWARE_PARTS[spec.kind].sizes;
  const i = sizes.indexOf(spec.size);
  return sizes[Math.min(sizes.length - 1, Math.max(0, (i < 0 ? 0 : i) + step))];
}
