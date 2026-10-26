// ---------------------------------------------------------------------------
// Hardware cuts
//
// A nut trap, a counterbored screw hole, a heat-set insert hole, an insert
// boss and a bearing pocket, put INTO a part at a spot on its surface.
//
// These used to be parts of their own: a palette tile dropped a small body
// shaped like the feature, which could never cut anything — two bodies do not
// cut each other here — and whose size was fixed at M3 by the script it was
// compiled from. A feature you fasten through belongs to the part it is in.
//
// So each one is a few ordinary cuts (utils/csg.ts cutGeometry) sharing one
// spot and one `hardware` tag. Everything cuts already do — finding the
// surface, measuring a through hole, following the face when the part
// changes — they do here unchanged; the tag is what lets the panel show them
// as one feature with one Size menu, and rebuild them all when it changes.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import type { HardwareBore, HardwareCutKind, SceneGeom, SceneNode, SealType } from '../types/scene';
import { metricThread } from './metricThreads';
import { BOLTS, HEX_NUTS, CLEARANCE_HOLES, COUNTERBORES, INSERTS, BEARINGS, O_RINGS, SEAL_CORDS } from './hardwareSizes';
import { planSealGroove, sealGrooveProblem } from './sealGrooves';
import { LM_UU, MGN } from './linearParts';
import { probeRay, surfaceUnder } from './csg';

export { HEX_NUTS, CLEARANCE_HOLES, COUNTERBORES, INSERTS, BEARINGS } from './hardwareSizes';

export interface HardwareKindInfo {
  label: string;
  /** What the panel's Size menu offers. */
  sizes: readonly string[];
  defaultSize: string;
  /** The choices for what goes below or into it, if it has any. */
  bores?: readonly HardwareBore[];
  defaultBore?: HardwareBore;
  /** Diametral clearance it starts with, mm. */
  defaultFitMm: number;
  hint: string;
}

export const HARDWARE_KINDS: Record<HardwareCutKind, HardwareKindInfo> = {
  nut_trap: {
    label: 'Nut trap', sizes: BOLTS, defaultSize: 'M3', defaultFitMm: 0.2,
    hint: 'A hex pocket a nut drops into, so it cannot turn, with a clearance hole for the bolt right through.',
  },
  nut_slot: {
    label: 'Nut slot', sizes: BOLTS, defaultSize: 'M3', defaultFitMm: 0.2,
    hint: 'A slot a nut slides into from the side of the part, buried under the face so the bolt pulls against material, with a clearance hole for the bolt right through.',
  },
  counterbore: {
    label: 'Counterbore', sizes: BOLTS, defaultSize: 'M3', bores: ['clearance', 'tapped'], defaultBore: 'clearance', defaultFitMm: 0,
    hint: 'A recess that sinks a socket head cap screw flush, with a clearance hole for its shank below.',
  },
  insert: {
    label: 'Insert hole', sizes: Object.keys(INSERTS), defaultSize: 'M3', defaultFitMm: 0,
    hint: 'A blind hole sized for a heat-set threaded insert.',
  },
  insert_boss: {
    label: 'Insert boss', sizes: Object.keys(INSERTS), defaultSize: 'M3', bores: ['insert', 'tapped', 'clearance'], defaultBore: 'insert', defaultFitMm: 0,
    hint: 'A round post stood on the surface, bored for a heat-set insert, a thread or a screw.',
  },
  bearing: {
    label: 'Bearing pocket', sizes: Object.keys(BEARINGS), defaultSize: '608', defaultFitMm: 0,
    hint: 'A blind pocket a ball bearing presses into, with a hole through for the shaft that leaves a ledge under the outer race.',
  },
  oring: {
    // The default is chosen to fit where it goes, so it has none of its own.
    label: 'O-ring groove', sizes: Object.keys(O_RINGS), defaultSize: '', defaultFitMm: 0,
    hint: 'A groove for a stocked O-ring: in a face under a lid, in a bore round a shaft, or round a boss. Sized to fit where it goes.',
  },
  seal_cord: {
    label: 'Rim seal', sizes: SEAL_CORDS, defaultSize: '', defaultFitMm: 0,
    hint: 'A groove following the rim of a box, for O-ring cord cut to length; in the middle of the wall when there is a cavity under it.',
  },
  rail_seat: {
    label: 'Rail seat', sizes: Object.keys(MGN), defaultSize: 'MGN12', bores: ['insert', 'tapped', 'clearance'], defaultBore: 'insert', defaultFitMm: 0.1,
    hint: 'A shallow channel that locates a miniature linear rail straight, with a hole at every one of its bolt holes.',
  },
  rod_clamp: {
    label: 'Rod socket', sizes: Object.keys(LM_UU), defaultSize: '8', defaultFitMm: 0.1,
    hint: 'A blind socket a ground rod is pushed into, two diameters deep.',
  },
  lm_housing: {
    label: 'Bushing housing', sizes: Object.keys(LM_UU), defaultSize: '8', defaultFitMm: 0.1,
    hint: 'A pocket for an LM-UU linear bushing, with room for its rod right through, so the part rides on a rod.',
  },
};

export const SEAL_LABELS: Record<SealType, string> = { face: 'Face', bore: 'Bore', piston: 'Piston' };

export const BORE_LABELS: Record<HardwareBore, string> = { clearance: 'Clearance', tapped: 'Tapped', insert: 'Heat-set insert' };

export interface HardwareCutSpec {
  group: string;
  kind: HardwareCutKind;
  size: string;
  at: number[];
  normal: number[];
  bore?: HardwareBore;
  /** An O-ring groove's: where it seals. Read off where it is put when left out. */
  seal?: SealType;
  /** A rail seat's: the rail's length, and whether it runs across the face's first axis rather than along it. */
  lengthMm?: number;
  turned?: boolean;
  /** A nut slot's: which way it runs, quarter turns about the normal. Left out, the nearest side. */
  quarter?: number;
  fitMm?: number;
}

/** How much material a nut slot leaves between the face and the nut, mm. */
export const NUT_SLOT_COVER_MM = 2;

/** The face's own X and Y at a spot: the frame a slot's quarter turns are counted in. */
function faceAxes(normal: number[]): { n: THREE.Vector3; x: THREE.Vector3; y: THREE.Vector3 } {
  const n = new THREE.Vector3(...(normal as [number, number, number])).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  return { n, x: new THREE.Vector3(1, 0, 0).applyQuaternion(q), y: new THREE.Vector3(0, 1, 0).applyQuaternion(q) };
}

/** The way a slot of `quarter` turns runs, along the face. */
function slotDirection(normal: number[], quarter: number): THREE.Vector3 {
  const { x, y } = faceAxes(normal);
  const a = (((quarter % 4) + 4) % 4) * (Math.PI / 2);
  return x.multiplyScalar(Math.cos(a)).addScaledVector(y, Math.sin(a)).normalize();
}

/** Where the nut's middle sits: on the bolt's line, under the cover. */
function nutCentre(spec: HardwareCutSpec, heightMm: number): THREE.Vector3 {
  const { n } = faceAxes(spec.normal);
  const depth = NUT_SLOT_COVER_MM + heightMm / 2;
  return new THREE.Vector3(...(spec.at as [number, number, number])).addScaledVector(n, -m(depth));
}

/** The quarter turn whose way out of the part, from the nut, is shortest: the side it is easiest to slide in from. */
function nearestSide(spec: HardwareCutSpec, host: SceneNode, heightMm: number): number {
  const c = nutCentre(spec, heightMm).toArray();
  let best = 0;
  let bestT = Infinity;
  for (let quarter = 0; quarter < 4; quarter++) {
    const hits = probeRay(host, c, slotDirection(spec.normal, quarter).toArray()).filter((h) => h.t > 1e-9);
    const t = hits.length ? Math.min(...hits.map((h) => h.t)) : Infinity;
    if (t < bestT - 1e-9) { best = quarter; bestT = t; }
  }
  return best;
}

const m = (mm: number) => +(mm / 1000).toFixed(7);

/** A tapped bore for this bolt size, or undefined when there is no such thread. */
function tapped(size: string): Pick<SceneGeom, 'size' | 'thread'> | undefined {
  const t = metricThread(size);
  return t ? { size: [m(t[1] / 2), 0], thread: { pitch: m(t[2]) } } : undefined;
}

/**
 * The cut geoms for one feature, in the order they must be placed: a boss
 * before the hole bored into it, so the hole finds the boss's top. Each still
 * needs `cutGeometry` for its pos, length and turn.
 */
export function hardwareCutGeoms(spec: HardwareCutSpec, nodeId: string, host?: SceneNode): SceneGeom[] {
  if (spec.kind === 'oring' || spec.kind === 'seal_cord') {
    // Worked out from the part, not only the table: see utils/sealGrooves.ts.
    const plan = host ? planSealGroove({ ...spec, kind: spec.kind }, host) : null;
    if (!plan || 'problem' in plan) return [];
    const fit = Math.max(0, spec.fitMm ?? 0);
    return [{
      ...plan.geom,
      name: `${nodeId}_${spec.group}_groove`,
      hardware: {
        group: spec.group, kind: spec.kind, size: plan.size, part: 'groove',
        ...(plan.seal !== 'rim' ? { seal: plan.seal } : {}),
        ...(fit > 0 ? { fit: m(fit) } : {}),
      },
    } as SceneGeom];
  }
  // A slot with no room under the face is no slot, as a groove that does not fit is none.
  if (spec.kind === 'nut_slot' && host && hardwareCutProblem(spec, host)) return [];
  const info = HARDWARE_KINDS[spec.kind];
  const size = info.sizes.includes(spec.size) ? spec.size : info.defaultSize;
  const bore = spec.bore && info.bores?.includes(spec.bore) ? spec.bore : info.defaultBore;
  const fit = Math.max(0, spec.fitMm ?? info.defaultFitMm);
  const tag = (part: string) => ({
    group: spec.group, kind: spec.kind, size, part,
    ...(bore ? { bore } : {}),
    ...(fit > 0 ? { fit: m(fit) } : {}),
  });
  const cut = (part: string, radiusMm: number, depthMm: number, extra: Partial<SceneGeom> = {}): SceneGeom => ({
    name: `${nodeId}_${spec.group}_${part}`,
    type: 'cylinder',
    size: [m(radiusMm), 0],
    csg: 'difference',
    cutAt: spec.at.map((v) => +v.toFixed(6)),
    cutNormal: [...spec.normal],
    cutDepth: m(depthMm),
    rgba: [0.9, 0.25, 0.35, 1],
    hardware: tag(part),
    ...extra,
  });
  const clearance = (part: string) => cut(part, CLEARANCE_HOLES[size] / 2, 0);

  switch (spec.kind) {
    case 'nut_trap': {
      const [flats, height] = HEX_NUTS[size];
      // A hexagonal prism is a six-sided cylinder; its radius is to the corners.
      return [
        cut('pocket', (flats + fit) / Math.sqrt(3), height + fit, { facets: 6 }),
        clearance('shank'),
      ];
    }
    case 'nut_slot': {
      const [flats, height] = HEX_NUTS[size];
      const quarter = spec.quarter ?? (host ? nearestSide(spec, host, height + fit) : 0);
      const dir = slotDirection(spec.normal, quarter);
      const { n } = faceAxes(spec.normal);
      // A box turned so its width lies along the face and its height along the
      // bolt: as wide as the nut across its flats, so it cannot turn, and as
      // tall as the nut. It runs from the side of the part in to the nut's far
      // corner, which is a flats/sqrt(3) out from its middle.
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      const yNow = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
      const twist = Math.atan2(new THREE.Vector3().crossVectors(yNow, n).dot(dir), yNow.dot(n));
      const slot: SceneGeom = {
        ...cut('slot', 0, (flats + fit) / Math.sqrt(3)),
        type: 'box',
        size: [m((flats + fit) / 2), m((height + fit) / 2), 0],
        cutAt: nutCentre(spec, height + fit).toArray().map((v) => +v.toFixed(6)),
        cutNormal: dir.toArray().map((v) => +v.toFixed(9)),
        cutInside: true,
        ...(Math.abs(twist) > 1e-9 ? { cutTwist: +twist.toFixed(9) } : {}),
      };
      // The bolt's hole first: the group is read back off its first piece,
      // and that has to be the one on the face.
      const shank = clearance('shank');
      shank.hardware = { ...shank.hardware!, quarter };
      slot.hardware = { ...slot.hardware!, quarter };
      return [shank, slot];
    }
    case 'counterbore': {
      const [diameter, depth] = COUNTERBORES[size];
      const shank = bore === 'tapped' ? cut('shank', 0, 0, tapped(size)) : clearance('shank');
      return [cut('head', (diameter + fit) / 2, depth), shank];
    }
    case 'insert': {
      const [hole, depth] = INSERTS[size];
      return [cut('bore', (hole + fit) / 2, depth)];
    }
    case 'insert_boss': {
      const [hole, depth, outside] = INSERTS[size];
      // Material, so the part's own colour rather than a cutter's red; its
      // cutDepth is how far it stands out.
      const post: SceneGeom = { ...cut('boss', outside / 2, depth), csg: 'union' };
      delete post.rgba;
      const into = bore === 'tapped' ? cut('bore', 0, depth, tapped(size))
        : bore === 'clearance' ? cut('bore', CLEARANCE_HOLES[size] / 2, depth)
          : cut('bore', (hole + fit) / 2, depth);
      return [post, into];
    }
    case 'bearing': {
      const [outside, inside, width] = BEARINGS[size];
      // The shaft hole stops halfway across the races: clear of the inner one,
      // which turns, and still under the outer one, which the ledge holds.
      return [cut('pocket', (outside + fit) / 2, width), cut('shaft', (outside + inside) / 4, 0)];
    }
    case 'rail_seat': {
      const { rail: [width, , pitch], bolt } = MGN[size];
      const length = spec.lengthMm && spec.lengthMm > 0 ? spec.lengthMm : 300;
      const twist = spec.turned ? Math.PI / 2 : 0;
      const seatTag = { length: m(length), ...(spec.turned ? { turned: true } : {}) };
      // Deep enough to hold the rail straight, nowhere near as deep as the rail.
      const SEAT_DEPTH = 1.5;
      const channel: SceneGeom = {
        ...cut('channel', 0, SEAT_DEPTH), type: 'box',
        size: [m((length + 1) / 2), m((width + fit) / 2), 0],
        ...(twist ? { cutTwist: +twist.toFixed(9) } : {}),
      };
      channel.hardware = { ...channel.hardware!, ...seatTag };
      // The cut's own X, turned onto the face: the line the holes run along.
      const n = new THREE.Vector3(...(spec.normal as [number, number, number])).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
      if (twist) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), twist));
      const along = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      const holes = Math.max(1, Math.floor((length - 8) / pitch) + 1);
      const first = -((holes - 1) * pitch) / 2;
      const hole = (i: number): SceneGeom => {
        const at = new THREE.Vector3(...(spec.at as [number, number, number])).addScaledVector(along, m(first + i * pitch));
        const piece = bore === 'tapped' ? cut(`hole${i}`, 0, 6 + SEAT_DEPTH, tapped(bolt))
          : bore === 'clearance' ? cut(`hole${i}`, CLEARANCE_HOLES[bolt] / 2, 0)
            : cut(`hole${i}`, INSERTS[bolt][0] / 2, INSERTS[bolt][1] + SEAT_DEPTH);
        return { ...piece, cutAt: at.toArray().map((v) => +v.toFixed(6)), hardware: { ...piece.hardware!, ...seatTag } };
      };
      return [channel, ...Array.from({ length: holes }, (_, i) => hole(i))];
    }
    case 'rod_clamp': {
      const d = Number(size);
      return [cut('bore', (d + fit) / 2, Math.max(12, 2 * d))];
    }
    case 'lm_housing': {
      const [od, length] = LM_UU[size];
      // The rod goes right through, with room round it: the bushing runs on it, not the part.
      return [cut('pocket', (od + fit) / 2, length), cut('rod', Number(size) / 2 + 1, 0)];
    }
    default:
      return [];
  }
}

/** The spec a group of geoms was built from, read back off its first member. */
export function hardwareSpecOf(geoms: SceneGeom[], group: string): HardwareCutSpec | null {
  const first = geoms.find((g) => g.hardware?.group === group && !g.csgDerived);
  if (!first?.hardware) return null;
  const h = first.hardware;
  return {
    group, kind: h.kind, size: h.size,
    at: [...(first.cutAt ?? [0, 0, 0])], normal: [...(first.cutNormal ?? [0, 0, 1])],
    ...(h.bore ? { bore: h.bore } : {}),
    ...(h.seal ? { seal: h.seal } : {}),
    ...(h.length ? { lengthMm: +(h.length * 1000).toFixed(3) } : {}),
    ...(h.turned ? { turned: true } : {}),
    ...(h.quarter !== undefined ? { quarter: h.quarter } : {}),
    fitMm: h.fit ? +(h.fit * 1000).toFixed(4) : 0,
  };
}

/** Why a hardware feature cannot be cut where it was asked for, in one sentence, or null. */
export function hardwareCutProblem(spec: HardwareCutSpec, host: SceneNode): string | null {
  if (spec.kind === 'oring' || spec.kind === 'seal_cord') return sealGrooveProblem({ ...spec, kind: spec.kind }, host);
  if (spec.kind === 'nut_slot') {
    const info = HARDWARE_KINDS.nut_slot;
    const size = info.sizes.includes(spec.size) ? spec.size : info.defaultSize;
    const [, height] = HEX_NUTS[size];
    const fit = Math.max(0, spec.fitMm ?? info.defaultFitMm);
    // Cover over the nut, the nut, and a floor under it for the slot to have a bottom.
    const needMm = NUT_SLOT_COVER_MM + height + fit + 1;
    const under = surfaceUnder(host, spec.at, spec.normal);
    const haveMm = under ? under.thickness * 1000 : 0;
    if (haveMm < needMm) {
      return `An ${size} nut slot needs ${needMm.toFixed(1)} mm of material under the face (${NUT_SLOT_COVER_MM} mm over the nut, the nut, 1 mm under it); this is ${haveMm.toFixed(1)} mm. Use a nut trap from the face instead, or a smaller size.`;
    }
  }
  return null;
}

/** A group name not yet used on this body: nut_trap1, nut_trap2, … */
export function nextHardwareGroup(geoms: SceneGeom[], kind: HardwareCutKind): string {
  const used = new Set(geoms.map((g) => g.hardware?.group).filter(Boolean));
  let i = 1;
  while (used.has(`${kind}${i}`)) i++;
  return `${kind}${i}`;
}
