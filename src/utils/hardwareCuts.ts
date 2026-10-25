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

import type { HardwareBore, HardwareCutKind, SceneGeom } from '../types/scene';
import { metricThread } from './metricThreads';
import { BOLTS, HEX_NUTS, CLEARANCE_HOLES, COUNTERBORES, INSERTS, BEARINGS } from './hardwareSizes';

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
};

export const BORE_LABELS: Record<HardwareBore, string> = { clearance: 'Clearance', tapped: 'Tapped', insert: 'Heat-set insert' };

export interface HardwareCutSpec {
  group: string;
  kind: HardwareCutKind;
  size: string;
  at: number[];
  normal: number[];
  bore?: HardwareBore;
  fitMm?: number;
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
export function hardwareCutGeoms(spec: HardwareCutSpec, nodeId: string): SceneGeom[] {
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
    fitMm: h.fit ? +(h.fit * 1000).toFixed(4) : 0,
  };
}

/** A group name not yet used on this body: nut_trap1, nut_trap2, … */
export function nextHardwareGroup(geoms: SceneGeom[], kind: HardwareCutKind): string {
  const used = new Set(geoms.map((g) => g.hardware?.group).filter(Boolean));
  let i = 1;
  while (used.has(`${kind}${i}`)) i++;
  return `${kind}${i}`;
}
