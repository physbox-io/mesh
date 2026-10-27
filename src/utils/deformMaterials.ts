// What a thing is made of, as far as being hit is concerned.
//
// Shattering and denting are each half a dozen numbers, and nobody knows
// offhand what "breaks at 2 N*s" means for a wine glass. A material is those
// numbers chosen together, so that picking Glass gives something that breaks
// when it is dropped and picking Steel gives something that takes a dent from
// a hammer and nothing from a tennis ball.
//
// PURE, like breakThresholds.ts: a node in, a set of updates out. The sidebar
// applies them through the ordinary store actions, and the tests read them
// without a store.
//
// The one idea worth reading twice is that the two halves scale differently.
//
// A shatter threshold is compared against the momentum THIS body absorbs (see
// checkImpacts in the physics worker), which is its own mass times the change
// in its speed. So a material's brittleness is a speed, and the threshold is
// that speed times this body's mass: a glass marble and a glass tabletop both
// break when dropped from knee height, where one fixed N*s would leave the
// marble unbreakable and break the tabletop when it was set down.
//
// A dent is usually made in something fixed — a plate, a panel — and a fixed
// body has no momentum of its own; the blow is the striker's. So dent numbers
// stay in N*s and describe the surface, not the thing that hits it.

import type { LoadStrength, SceneGeom, SceneNode } from '../types/scene';
import { meshVolumeAndCentroid } from './csg';

export type DeformMaterialId =
  | 'glass' | 'ceramic' | 'stone' | 'plastic'
  | 'softwood' | 'hardwood' | 'softMetal' | 'steel' | 'pasta';

export interface ShatterProfile {
  /** Change of speed that breaks it, m/s. Times the body's mass gives N*s. */
  breakSpeedMs: number;
  pieces: number;
  pattern: 'uniform' | 'radial';
  /** Whether the pieces break again when they land (0..2). */
  depth: number;
  /** Extra outward speed per shard, m/s. */
  spread: number;
  /**
   * The wall `breakSpeedMs` is rated for, in metres. Set for things that break
   * because a thin wall bends — glass, ceramic, stone — so a thinner wall
   * breaks sooner. Unset, thickness does not matter.
   */
  thicknessRef?: number;
}

export interface DentProfile {
  yieldNs: number;
  depthPerNs: number;
  maxDepth: number;
  /** Undefined: never holed. */
  pierceNs?: number;
}

export interface DeformMaterial {
  id: DeformMaterialId;
  label: string;
  /** kg/m3, given to every geom that does not state a mass outright. */
  density: number;
  /** Null: it does not do this. Glass does not dent; steel does not shatter. */
  shatter: ShatterProfile | null;
  dent: DentProfile | null;
  /**
   * How it fails under steady load, for a long, thin part: see
   * SceneNode.loadStrength. Every material has one, because everything breaks
   * or bends if you lean on it hard enough.
   */
  strength: LoadStrength;
  /** Which behaviours picking this material turns on when none is on yet. */
  natural: { shatter: boolean; dent: boolean; load?: boolean };
  /** One line, for the dropdown's tooltip. */
  note: string;
}

// Break speeds are a drop onto something hard: glass at 3 m/s is a fall of
// about half a metre, which is roughly where a tumbler stops surviving the
// kitchen floor. For the brittle ones that speed is for a wall of
// `thicknessRef`; a 3 mm wine-glass bowl breaks at half of it. Dent yields
// are relative to each other more than to any one real alloy — steel takes
// four times the blow soft aluminium does to mark.
export const DEFORM_MATERIALS: DeformMaterial[] = [
  {
    id: 'glass', label: 'Glass', density: 2500,
    shatter: { breakSpeedMs: 3, pieces: 14, pattern: 'radial', depth: 1, spread: 0.4, thicknessRef: 0.006 },
    dent: null,
    strength: { flexuralMPa: 50, tensileMPa: 40, modulusGPa: 70 },
    natural: { shatter: true, dent: false },
    note: 'A 6 mm wall breaks from a half-metre drop; thinner breaks sooner. Never dents.',
  },
  {
    id: 'ceramic', label: 'Ceramic', density: 2400,
    shatter: { breakSpeedMs: 3.5, pieces: 8, pattern: 'radial', depth: 1, spread: 0.2, thicknessRef: 0.006 },
    dent: null,
    strength: { flexuralMPa: 80, tensileMPa: 40, modulusGPa: 100 },
    natural: { shatter: true, dent: false },
    note: 'A little tougher than glass, and breaks into fewer, larger pieces.',
  },
  {
    id: 'stone', label: 'Stone / concrete', density: 2400,
    shatter: { breakSpeedMs: 8, pieces: 5, pattern: 'uniform', depth: 0, spread: 0, thicknessRef: 0.03 },
    dent: null,
    strength: { flexuralMPa: 5, tensileMPa: 3, modulusGPa: 30 },
    natural: { shatter: true, dent: false },
    note: 'Takes a real blow, then breaks into a few heavy chunks.',
  },
  {
    id: 'plastic', label: 'Plastic', density: 1100,
    shatter: { breakSpeedMs: 15, pieces: 4, pattern: 'radial', depth: 0, spread: 0 },
    dent: { yieldNs: 2, depthPerNs: 0.004, maxDepth: 0.006, pierceNs: 20 },
    strength: { flexuralMPa: 70, tensileMPa: 45, modulusGPa: 3, ductile: true },
    natural: { shatter: false, dent: true },
    note: 'Dents and scuffs. Cracks only when thrown very hard.',
  },
  {
    id: 'softwood', label: 'Softwood', density: 450,
    shatter: { breakSpeedMs: 9, pieces: 3, pattern: 'uniform', depth: 0, spread: 0 },
    dent: { yieldNs: 1, depthPerNs: 0.004, maxDepth: 0.008, pierceNs: 40 },
    strength: { flexuralMPa: 65, tensileMPa: 40, modulusGPa: 9 },
    natural: { shatter: false, dent: true },
    note: 'Pine and the like: marks easily, splits into a few pieces.',
  },
  {
    id: 'hardwood', label: 'Hardwood', density: 750,
    shatter: { breakSpeedMs: 12, pieces: 3, pattern: 'uniform', depth: 0, spread: 0 },
    dent: { yieldNs: 3, depthPerNs: 0.0025, maxDepth: 0.005, pierceNs: 60 },
    strength: { flexuralMPa: 100, tensileMPa: 60, modulusGPa: 12 },
    natural: { shatter: false, dent: true },
    note: 'Oak and the like: three times the blow to mark, and shallower when it does.',
  },
  {
    id: 'softMetal', label: 'Soft metal', density: 2700,
    shatter: null,
    dent: { yieldNs: 1.5, depthPerNs: 0.008, maxDepth: 0.015, pierceNs: 25 },
    strength: { flexuralMPa: 150, tensileMPa: 150, modulusGPa: 69, ductile: true },
    natural: { shatter: false, dent: true },
    note: 'Aluminium, copper: dents deep and easily, and can be holed.',
  },
  {
    id: 'steel', label: 'Steel', density: 7850,
    shatter: null,
    dent: { yieldNs: 6, depthPerNs: 0.002, maxDepth: 0.006, pierceNs: 80 },
    strength: { flexuralMPa: 250, tensileMPa: 250, modulusGPa: 200, ductile: true },
    natural: { shatter: false, dent: true },
    note: 'Unmarked by anything light. A dropped weight leaves a shallow crater.',
  },
  {
    // Dry spaghetti: the classroom tower-and-bridge material. Strength and
    // stiffness are for a 1.8 mm strand, which a 100 mm length buckles under
    // about 2 N and a 6 g weight at the middle of a 200 mm span snaps.
    id: 'pasta', label: 'Dry pasta', density: 1450,
    shatter: { breakSpeedMs: 5, pieces: 3, pattern: 'uniform', depth: 0, spread: 0 },
    dent: null,
    strength: { flexuralMPa: 20, tensileMPa: 15, modulusGPa: 4 },
    natural: { shatter: false, dent: false, load: true },
    note: 'Dry spaghetti: snaps when bent and buckles when pushed end-on, long before it pulls apart.',
  },
];

export function deformMaterial(id: string | undefined): DeformMaterial | undefined {
  return DEFORM_MATERIALS.find((m) => m.id === id);
}

/**
 * The volume of one geom in cubic metres, from MuJoCo's half-sizes.
 *
 * Zero for a plane, which is infinite, and for a mesh that is not closed
 * enough to have a volume.
 */
export function geomVolume(g: SceneGeom): number {
  const s = g.size || [];
  switch (g.type) {
    case 'box': return 8 * (s[0] ?? 0) * (s[1] ?? 0) * (s[2] ?? 0);
    case 'sphere': return (4 / 3) * Math.PI * (s[0] ?? 0) ** 3;
    case 'ellipsoid': return (4 / 3) * Math.PI * (s[0] ?? 0) * (s[1] ?? 0) * (s[2] ?? 0);
    case 'cylinder': return Math.PI * (s[0] ?? 0) ** 2 * 2 * (s[1] ?? 0);
    case 'capsule': {
      const r = s[0] ?? 0;
      return Math.PI * r * r * 2 * (s[1] ?? 0) + (4 / 3) * Math.PI * r ** 3;
    }
    case 'mesh': {
      const v = g.renderVertices || g.vertices;
      return v && g.faces ? meshVolumeAndCentroid(v, g.faces).volume : 0;
    }
    default: return 0;
  }
}

/** Geoms that carry mass: not cutters, not decoration. */
function massive(g: SceneGeom): boolean {
  return g.csg !== 'difference' && g.role !== 'visual';
}

/**
 * What a body weighs, the way MuJoCo will weigh it: a stated mass where there
 * is one, otherwise volume times density, at water's 1000 when unsaid.
 *
 * An estimate for a boolean body, whose cutters are not subtracted. Returns 0
 * when there is nothing to weigh.
 */
export function estimateBodyMass(node: SceneNode): number {
  let total = 0;
  for (const g of node.geoms || []) {
    if (!massive(g)) continue;
    total += typeof g.mass === 'number' ? g.mass : (g.density ?? 1000) * geomVolume(g);
  }
  return total;
}

/** A shatter profile as the node fields it becomes, for a body of this mass. */
export function shatterFields(p: ShatterProfile, massKg: number): Partial<SceneNode> {
  // Rounded to the step the sidebar's input uses, so the field reads cleanly;
  // floored above zero, because zero means "cannot shatter".
  // A body that weighs nothing (an open mesh has no volume) is treated as a
  // kilogram, the same fallback its shards get.
  const kg = massKg > 0 ? massKg : 1;
  const ns = Math.max(0.05, Math.round(p.breakSpeedMs * kg * 20) / 20);
  return {
    shatterImpulseNs: ns,
    shatterPieces: p.pieces,
    shatterPattern: p.pattern,
    shatterDepth: p.depth || undefined,
    shatterSpread: p.spread || undefined,
    shatterSeed: 1,
    shatterThicknessRef: p.thicknessRef,
  };
}

export function dentFields(p: DentProfile): Partial<SceneGeom> {
  return {
    dentYieldNs: p.yieldNs,
    dentDepthPerNs: p.depthPerNs,
    dentMaxDepth: p.maxDepth,
    pierceImpulseNs: p.pierceNs,
  };
}

/** What a body gets when it is ticked with no material chosen. */
export const CUSTOM_SHATTER: ShatterProfile = { breakSpeedMs: 4, pieces: 8, pattern: 'radial', depth: 0, spread: 0 };
export const CUSTOM_DENT: DentProfile = { yieldNs: 4, depthPerNs: 0.012, maxDepth: 0.01 };

/**
 * Everything picking `material` changes on this node, given which of the two
 * behaviours are on now.
 *
 * With neither on, the material's natural ones are turned on — picking Glass
 * on a plain body should give a body that breaks, not a dropdown that says
 * Glass above two unticked boxes. With either on, the choice is left alone and
 * only the numbers change; a behaviour the material cannot do is turned off,
 * because a steel body that shatters is not steel.
 *
 * Density goes on every geom that does not state a mass, so the body weighs
 * what it is made of, and the shatter threshold is worked out from that new
 * weight rather than from the old one.
 */
export function materialUpdates(
  node: SceneNode,
  material: DeformMaterial,
  now: { shatter: boolean; dent: boolean; load?: boolean },
  /**
   * The body is a free, long, thin part (utils/memberStrength.ts). Its
   * natural way to fail is under load, whatever it is made of, so that is what
   * picking a material turns on; and denting or shattering would rebuild it
   * as a mesh, which is no longer a rod and cannot break under load at all.
   */
  member = false,
): {
  node: Partial<SceneNode>;
  /** Per geom index. Only indices that change are present. */
  geoms: Record<number, Partial<SceneGeom>>;
  shatter: boolean;
  dent: boolean;
  load: boolean;
} {
  const neither = !now.shatter && !now.dent && !now.load;
  const shatter = !!material.shatter && (neither ? !member && material.natural.shatter : now.shatter);
  const dent = !!material.dent && (neither ? !member && material.natural.dent : now.dent);
  const load = neither ? member || !!material.natural.load : !!now.load;

  const geoms: Record<number, Partial<SceneGeom>> = {};
  (node.geoms || []).forEach((g, i) => {
    if (massive(g) && typeof g.mass !== 'number') geoms[i] = { density: material.density };
  });
  const weighed: SceneNode = {
    ...node,
    geoms: (node.geoms || []).map((g, i) => (geoms[i] ? { ...g, ...geoms[i] } : g)),
  };

  const nodeUpdates: Partial<SceneNode> = { deformMaterial: material.id };
  if (shatter) Object.assign(nodeUpdates, shatterFields(material.shatter!, estimateBodyMass(weighed)));
  else nodeUpdates.shatterImpulseNs = undefined;
  nodeUpdates.loadStrength = load ? { ...material.strength } : undefined;

  return { node: nodeUpdates, geoms, shatter, dent, load };
}

/**
 * `loadStrength` as an agent may write it: the strength itself, a material id
 * ('pasta', 'steel'), `true` for the body's own material (hardwood when it has
 * none), or `false`/`null` to turn it off. `{ error }` when it is none of
 * those; `undefined` result means "off".
 */
export function resolveLoadStrength(
  v: unknown,
  materialId: string | undefined,
): { value: LoadStrength | undefined } | { error: string } {
  if (v === false || v === null) return { value: undefined };
  const ids = DEFORM_MATERIALS.map((m) => m.id).join(', ');
  if (v === true) return { value: { ...(deformMaterial(materialId) ?? deformMaterial('hardwood')!).strength } };
  if (typeof v === 'string') {
    const m = deformMaterial(v);
    return m ? { value: { ...m.strength } } : { error: `loadStrength '${v}' is not a material: use one of ${ids}, true, false, or { flexuralMPa, tensileMPa, modulusGPa, ductile? }.` };
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const num = (k: string) => typeof o[k] === 'number' && Number.isFinite(o[k]) && (o[k] as number) > 0;
    if (num('flexuralMPa') && num('tensileMPa') && num('modulusGPa')) {
      return { value: { flexuralMPa: o.flexuralMPa as number, tensileMPa: o.tensileMPa as number, modulusGPa: o.modulusGPa as number, ...(o.ductile ? { ductile: true } : {}) } };
    }
  }
  return { error: `loadStrength must be a material id (${ids}), true, false, or { flexuralMPa, tensileMPa, modulusGPa, ductile? } with positive numbers.` };
}

/**
 * A body's loadStrength as the physics reads it: resolved from a shorthand
 * (a material id, or true) when something wrote one straight into the scene,
 * and undefined when it is off or unreadable.
 */
export function loadStrengthOf(node: SceneNode): LoadStrength | undefined {
  if (node.loadStrength === undefined) return undefined;
  const r = resolveLoadStrength(node.loadStrength, node.deformMaterial);
  return 'error' in r ? undefined : r.value;
}
