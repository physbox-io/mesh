/**
 * Boning: stiff strips in channels along a garment's lines (GarmentRod). A
 * rod is a chain of the cloth's own particles along a seam or edge, as long
 * as its channel is cut; it rests in the shape the garment is modelled in,
 * as a bone is shaped to the bodice it goes in and a hoop formed into its
 * ring, and resists being bent out of it by its flexural rigidity: a
 * bodice's bones keep it smooth and up, and a hoop stands round.
 *
 * Straight at rest, a hoop could never be: each pass it pushed out against
 * the cloth holding it, and tore the skirt round it (edges four times their
 * length); bones straightening over a bust pried the bodice off it.
 *
 * Bending as the discrete curvature vector a + c - 2b at each point, over
 * links one and two long: energy E I |kappa|^2 h / 2, with kappa ~
 * (a + c - 2b) / h^2, is a constraint |a + c - 2b| = 0 of compliance
 * h^3 / (E I).
 */

import type { GarmentRod } from '../../types/cloth';

/** Flexural rigidity (N m^2) and weight (kg/m) of each kind, from its section: flat steel 6 x 0.4 mm, spiral steel softer, Rigilene 8 x 1 mm polyester, hoop steel 10 x 0.5 mm. */
export const ROD_KINDS: Record<NonNullable<GarmentRod['kind']>, { ei: number; density: number }> = {
  flatSteel: { ei: 0.0064, density: 0.019 },
  spiralSteel: { ei: 0.004, density: 0.022 },
  plastic: { ei: 0.002, density: 0.011 },
  hoopSteel: { ei: 0.06, density: 0.039 },
};

export interface RodConstraints {
  /** Links: pairs of particles and their lengths, held. */
  links: number[];
  linkRest: number[];
  /** Bends: triples (a, b, c), the length of a + c - 2b at rest, its compliance (m/N). */
  bends: number[];
  bendRest: number[];
  bendAlpha: number[];
}

/**
 * The constraints of a rod along `run` (particles, in order round a `closed`
 * loop or end to end), each link `linkLength(a, b)` long (its channel's cut
 * length), bent as it is at `rest` (each particle's modelled place), and the
 * weight it adds to each particle, into `mass`.
 */
export function addRod(out: RodConstraints, run: number[], closed: boolean, linkLength: (a: number, b: number) => number, rest: number[][], rod: GarmentRod, mass: number[]) {
  const n = run.length;
  if (n < 2) return;
  const kind = ROD_KINDS[rod.kind ?? 'spiralSteel'];
  const ei = Math.max(1e-6, kind.ei * (rod.stiffness ?? 1));
  const wrap = (i: number) => ((i % n) + n) % n;
  const links = closed ? n : n - 1;
  for (let i = 0; i < links; i++) {
    const a = wrap(i), b = wrap(i + 1), l = linkLength(run[a], run[b]);
    out.links.push(run[a], run[b]);
    out.linkRest.push(l);
    mass[run[a]] += (kind.density * l) / 2;
    mass[run[b]] += (kind.density * l) / 2;
  }
  // Multigrid spans (1, 2, 4, 8 links) so a 100+ particle hoop converges against
  // long-wavelength ovalization within the solver's passes per substep.
  for (const hop of [1, 2, 4, 8]) {
    if (closed ? n < 4 * hop : n < 2 * hop + 1) continue;
    const from = closed ? 0 : hop, to = closed ? n : n - hop;
    for (let i = from; i < to; i++) {
      const a = wrap(i - hop), b = wrap(i), c = wrap(i + hop);
      if (a === c) continue;
      let h = 0;
      for (let q = 0; q < hop; q++) h += (linkLength(run[wrap(i - hop + q)], run[wrap(i - hop + q + 1)]) + linkLength(run[wrap(i + q)], run[wrap(i + q + 1)])) / 2;
      const pa = rest[run[a]], pb = rest[run[b]], pc = rest[run[c]];
      out.bends.push(run[a], run[b], run[c]);
      out.bendRest.push(Math.hypot(pa[0] + pc[0] - 2 * pb[0], pa[1] + pc[1] - 2 * pb[1], pa[2] + pc[2] - 2 * pb[2]));
      out.bendAlpha.push(h ** 3 / ei);
    }
  }
}

/** The runs of a rod as lines on the pieces: for each group, its local points along each run, split where the run leaves the piece. */
export function rodLines(groupParticles: number[], runs: number[][]): number[][] {
  const local = new Map<number, number>();
  groupParticles.forEach((p, i) => local.set(p, i));
  const lines: number[][] = [];
  for (const run of runs) {
    let cur: number[] = [];
    for (const p of run) {
      const l = local.get(p);
      if (l === undefined) { if (cur.length > 1) lines.push(cur); cur = []; continue; }
      cur.push(l);
    }
    if (cur.length > 1) lines.push(cur);
  }
  return lines;
}
