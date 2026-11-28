/**
 * Fullness: which side of which seam carries more cloth than the seam is
 * long, and how much (GarmentDraft.fullness). The shell is one smooth surface
 * and cannot fold over itself, so the extra lives in the flat pieces and the
 * sewing: a little, `ease`, is flattened into the piece itself (a sleeve cap
 * lies flat longer round its edge than the armhole it goes into, and is
 * eased in evenly); more, gathers and pleats, is spread into the piece along
 * the seam and folded back in as it is sewn (garmentSpread.ts).
 *
 * Generic: a seam is a seam. The one default is ease on a seam between a
 * limb and the body (a set-in sleeve's armhole), on the limb's side, as much
 * as the fabric does not give.
 */

import type { ClothMaterialName, GarmentFullness } from '../../types/cloth';
import { CLOTH_MATERIALS } from './clothMesh';
import { linePicks } from './clothNames';
import type { GarmentShell } from './garmentShell';

/** A seam side that carries fullness: the panel, the seam's edges along it (shell points), and what it carries. */
export interface FullSide {
  panel: number;
  /** Seam edges on this panel, by shell point, as `a * n + b` with a < b. */
  edges: Set<number>;
  /** The panel across the seam, by edge key. */
  across: Map<number, number>;
  spec: GarmentFullness;
  kind: NonNullable<GarmentFullness['kind']>;
  /** Cloth over seam. */
  ratio: number;
}

/**
 * Cap ease by fabric: what a sleeve's cap needs to lie flat round the dome of
 * the shoulder (CAP_NEED), as far as the fabric eases in: a woven all of it,
 * denim and canvas some, crisp or piled cloth little, leather none (the plan
 * gives those a cap dart for the rest: garmentPlan); a knit none, it gives.
 * Measured on a woven dress's short sleeve: 5.3% to lie flat with 4% cap
 * ease, 4.8% with 6%.
 */
export const CAP_NEED = 0.06;
export const capEase = (material: ClothMaterialName) => (CLOTH_MATERIALS[material].give >= CAP_NEED ? 0 : Math.min(CAP_NEED, CLOTH_MATERIALS[material].easeIn));

/**
 * A line's name matches: by the same rule as every other `along` (trims,
 * rods, the name warnings): `armhole` takes armholeL and armholeR, `gore`
 * gore1 to gore9. Its own narrower rule (L or R only) let `gore` pass the
 * warning and gather nothing.
 */
export const lineMatches = linePicks;
/** Panels a name picks: itself, or with an L or R after it. */
const panelMatches = (name: string, want: string) => name === want || (name.length === want.length + 1 && name.startsWith(want) && /[LR]$/.test(name));

const LIMBS = new Set(['armL', 'armR', 'legL', 'legR', 'head']);

/**
 * Every seam side that carries fullness: the draft's own, and ease on the
 * limb's side of every seam between a limb and the body unless the draft
 * names that seam itself.
 */
export function fullSides(shell: GarmentShell, fullness: GarmentFullness[] = [], material: ClothMaterialName): FullSide[] {
  const n = shell.points.length, key = (a: number, b: number) => (a < b ? a * n + b : b * n + a);
  const panelOfTri = new Int32Array(shell.tris.length / 3).fill(-1);
  shell.panels.forEach((p, k) => { for (const t of p.tris) panelOfTri[t] = k; });
  const panelsOfEdge = new Map<number, number[]>();
  for (let t = 0; t < shell.tris.length; t += 3) {
    const k = panelOfTri[t / 3];
    if (k < 0) continue;
    for (let e = 0; e < 3; e++) {
      const ek = key(shell.tris[t + e], shell.tris[t + ((e + 1) % 3)]);
      const list = panelsOfEdge.get(ek) ?? panelsOfEdge.set(ek, []).get(ek)!;
      if (!list.includes(k)) list.push(k);
    }
  }
  // Each panel: whether it lies on a limb (most of its points nearest one), and how high it is.
  const onLimb = shell.panels.map((p) => {
    let limb = 0, all = 0;
    for (const t of p.tris) for (let c = 0; c < 3; c++) { all++; if (LIMBS.has(shell.part?.[shell.tris[3 * t + c]] ?? 'skin')) limb++; }
    return limb > all / 2;
  });
  const height = shell.panels.map((p) => {
    let z = 0;
    for (const t of p.tris) for (let c = 0; c < 3; c++) z += shell.points[shell.tris[3 * t + c]][2];
    return z / Math.max(1, 3 * p.tris.length);
  });
  // The sides of a named seam: per pair of panels across it, its edges.
  const sidesOf = (along: string) => {
    const pairs = new Map<string, { a: number; b: number; edges: number[] }>();
    for (const sm of shell.seams) {
      if (!lineMatches(sm.name, along) || sm.open) continue;
      for (let i = 1; i < sm.path.length; i++) {
        const ek = key(sm.path[i - 1], sm.path[i]), ps = panelsOfEdge.get(ek);
        if (!ps || ps.length !== 2) continue;
        const [a, b] = ps[0] < ps[1] ? ps : [ps[1], ps[0]];
        const pk = `${a}:${b}`;
        (pairs.get(pk) ?? pairs.set(pk, { a, b, edges: [] }).get(pk)!).edges.push(ek);
      }
    }
    return [...pairs.values()];
  };
  const out: FullSide[] = [];
  const add = (panel: number, other: number, edges: number[], spec: GarmentFullness, kind: FullSide['kind'], ratio: number) => {
    const existing = out.find((s) => s.panel === panel && s.spec === spec);
    const side = existing ?? { panel, edges: new Set<number>(), across: new Map<number, number>(), spec, kind, ratio };
    for (const e of edges) { side.edges.add(e); side.across.set(e, other); }
    if (!existing) out.push(side);
  };
  // Which side carries it, unless the entry names the panels or the side: the
  // limb's side of a seam between a limb and the body, else the lower.
  const carrier = (a: number, b: number, spec: GarmentFullness): number[] => {
    if (spec.panels?.length) return [a, b].filter((k) => spec.panels!.some((w) => panelMatches(shell.panels[k].name, w)));
    if (spec.side) return [(height[a] < height[b]) === (spec.side === 'below') ? a : b];
    if (onLimb[a] !== onLimb[b]) return [onLimb[a] ? a : b];
    return [height[a] < height[b] ? a : b];
  };
  const named = new Set<string>();
  for (const spec of fullness) {
    const kind = spec.kind ?? 'gather';
    const ratio = spec.ratio ?? (kind === 'ease' ? 1 + capEase(material) : kind === 'gather' ? 2 : 3);
    for (const sm of shell.seams) if (lineMatches(sm.name, spec.along)) named.add(sm.name);
    if (ratio <= 1) continue;
    for (const { a, b, edges } of sidesOf(spec.along)) for (const k of carrier(a, b, spec)) add(k, k === a ? b : a, edges, spec, kind, ratio);
  }
  // Cap ease: on a limb, at a seam to the body.
  const ease = capEase(material);
  if (ease > 0) {
    const seamNames = [...new Set(shell.seams.map((sm) => sm.name))].filter((nm) => !named.has(nm));
    for (const nm of seamNames) {
      const spec: GarmentFullness = { along: nm, kind: 'ease', ratio: 1 + ease };
      for (const { a, b, edges } of sidesOf(nm)) {
        if (onLimb[a] === onLimb[b]) continue;
        const k = onLimb[a] ? a : b;
        add(k, k === a ? b : a, edges, spec, 'ease', 1 + ease);
      }
    }
  }
  return out;
}

/** For flattenPanel: how much longer than it is each outline edge of panel `k` may lie flat (its ease), by shell point. */
export function panelEdgeEase(shell: GarmentShell, sides: FullSide[], k: number): ((a: number, b: number) => number) | undefined {
  const mine = sides.filter((s) => s.panel === k && s.kind === 'ease');
  if (!mine.length) return undefined;
  const n = shell.points.length;
  return (a, b) => {
    const ek = a < b ? a * n + b : b * n + a;
    for (const s of mine) if (s.edges.has(ek)) return s.ratio - 1;
    return 0;
  };
}
