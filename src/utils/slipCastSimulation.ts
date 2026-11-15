// ---------------------------------------------------------------------------
// What a slip-cast mold casts: the clay wall it builds, drained and fired
// ---------------------------------------------------------------------------
//
// The plaster drinks water from the slip against it, so a wall of clay builds
// on every surface of the cavity at much the same rate; after the casting
// time the rest is poured back out of the spare. So the casting is the
// cavity less the cavity eroded by the wall thickness, keeping only the slip
// that could drain (eroded space connected to the spare), with the spare's
// clay trimmed off at the part's rim, and the whole shrunk by the clay's
// firing shrink, back to the size the part was modelled.
//
// Erosion by a ball is built slice by slice: the slip still liquid at height
// z is the cavity's outline at z, and at every height within a wall of it,
// each inset by what is left of the wall at that distance. A slice past the
// cavity's floor insets everything away, which is the casting's base; past
// its top (the open spare) it holds nothing back.
// ---------------------------------------------------------------------------

import type { CrossSection, Manifold, ManifoldToplevel } from 'manifold-3d';
import { castMaterial, castWeightG, type CastMaterialId } from './castMaterials';
import type { IndexedMesh } from './stlMesh';
import type { SlipMesh } from './slipCastMold';

export interface SlipCastInput {
  /** The mold's cavity, spare included (SlipMold.cavity). */
  cavity: SlipMesh;
  /** The spare less the part in it (SlipMold.spare): trimmed off the casting. Absent: trimmed at partTopMm. */
  spare?: SlipMesh;
  /** SlipMoldReport fields: the part's top, its foot and how much it was grown. */
  partTopMm: number;
  footMm: [number, number, number];
  scale: number;
  slip: CastMaterialId;
}

export interface SlipCastResult {
  /** The fired piece, as the part stands: centred in plan on its foot, on Z = 0. */
  mesh: IndexedMesh;
  volumeMm3: number;
  weightG: number;
  /** Wall as cast, and as fired, mm. */
  wallMm: number;
  firedWallMm: number;
  sizeMm: [number, number, number];
  notes: string[];
  /** What goes wrong in this casting, each where it is (mold frame, mm). */
  warnings: string[];
}

/** A usual porcelain cast builds 3-5 mm in 15-25 minutes. */
export const DEFAULT_SLIP_WALL_MM = 4;

export function simulateSlipCast(wasm: ManifoldToplevel, input: SlipCastInput, wallMm = DEFAULT_SLIP_WALL_MM): SlipCastResult {
  const bin: (Manifold | CrossSection)[] = [];
  const keep = <T extends Manifold | CrossSection>(o: T) => (bin.push(o), o);
  try {
    const t = Math.max(0.5, wallMm);
    const raw = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(input.cavity.positions), triVerts: Uint32Array.from(input.cavity.faces) });
    raw.merge();
    const cavity = keep(new wasm.Manifold(raw));
    if (cavity.status() !== 'NoError' || cavity.isEmpty()) throw new Error('The mold has no cavity to cast in.');
    const b = cavity.boundingBox();
    const zMin = b.min[2], zMax = b.max[2];
    // A whole number of steps over the cavity's height, so the top slice is
    // inside the spare: one above it is empty and would seal the top shut.
    const n = Math.max(2, Math.ceil((zMax - zMin) / Math.min(1, Math.max(0.3, t / 3))));
    const dz = (zMax - zMin) / n;
    const outlines: CrossSection[] = [];
    for (let k = 0; k < n; k++) outlines.push(keep(keep(cavity.slice(zMin + (k + 0.5) * dz)).simplify(0.02)));
    const reachSteps = Math.floor(t / dz);
    const slabs: Manifold[] = [];
    const unbuilt: number[] = [];
    for (let k = 0; k < n; k++) {
      let liquid: CrossSection | null = null;
      for (let j = -reachSteps; j <= reachSteps && (liquid === null || !liquid.isEmpty()); j++) {
        const at = k + j;
        if (at >= n) continue; // above the spare's mouth: open
        const inset = Math.sqrt(Math.max(0, t * t - (j * dz) ** 2));
        const here = at < 0 ? keep(wasm.CrossSection.square(0)) : keep(outlines[at].offset(-inset, 'Round', 2, 24));
        liquid = liquid ? keep(liquid.intersect(here)) : here;
      }
      if (!liquid || liquid.isEmpty()) continue;
      // A degenerate outline extrudes to an invalid solid, and one invalid
      // slab turns the whole union empty, which read as a solid casting.
      const z0 = zMin + k * dz - 0.01;
      let slab: Manifold | null = null;
      for (const tol of [0.05, 0.2, 0.5]) {
        const m = keep(keep(keep(liquid.simplify(tol)).extrude(dz + 0.02)).translate([0, 0, z0]));
        if (m.status() === 'NoError') { slab = m; break; }
      }
      if (slab) slabs.push(slab);
      else unbuilt.push(z0);
    }
    const warnings: string[] = [];
    const at = (m: Manifold) => {
      const mb = m.boundingBox();
      return `(${[(mb.min[0] + mb.max[0]) / 2, (mb.min[1] + mb.max[1]) / 2, (mb.min[2] + mb.max[2]) / 2].map((v) => v.toFixed(0)).join(', ')} mm)`;
    };
    if (unbuilt.length) warnings.push(`The slip at ${unbuilt.length === 1 ? `z = ${unbuilt[0].toFixed(0)} mm` : `${unbuilt.length} heights from z = ${unbuilt[0].toFixed(0)} mm`} could not be modelled, so what drains is unsure there.`);
    let drained: Manifold | null = null;
    if (slabs.length) {
      // Only the slip that reaches the spare pours out; a pocket sealed off
      // by the wall stays in and sets solid.
      const liquid = keep(wasm.Manifold.union(slabs));
      if (liquid.status() !== 'NoError') throw new Error(`The slip could not be modelled (${liquid.status()}).`);
      const parts = liquid.decompose().map(keep);
      const out = parts.filter((p) => p.boundingBox().max[2] >= zMax - 2 * dz);
      // A sliver sealed in a corner is clay a hair thicker there; a pocket is
      // a lump of solid clay.
      // a lump of solid clay that cracks in the firing. A solid handle or
      // knob is usual and is not warned of.
      const sealed = parts.filter((p) => !out.includes(p) && p.volume() > 1000);
      sealed.sort((a, b) => b.volume() - a.volume());
      for (const p of sealed.slice(0, 5)) {
        const ml = p.volume() / 1000;
        warnings.push(`${ml < 10 ? ml.toFixed(1) : Math.round(ml).toLocaleString()} ml of slip at ${at(p)} is sealed off from the spare by the wall and sets solid there.`);
      }
      if (sealed.length > 5) warnings.push(`${sealed.length - 5} more pockets of slip are sealed off and set solid.`);
      drained = out.length ? keep(wasm.Manifold.union(out)) : null;
    }
    if (!drained) warnings.push(`The cavity is no wider than two walls (${t * 2} mm) anywhere, or none of it reaches the spare: it casts solid.`);
    const cast = keep(drained ? cavity.subtract(drained) : cavity);
    // The spare's clay is cut off: the spare itself, or at the rim.
    let trimmed: Manifold;
    if (input.spare && input.spare.faces.length) {
      const sm = new wasm.Mesh({ numProp: 3, vertProperties: Float32Array.from(input.spare.positions), triVerts: Uint32Array.from(input.spare.faces) });
      sm.merge();
      const spareSolid = keep(new wasm.Manifold(sm));
      trimmed = keep(spareSolid.status() === 'NoError' && !spareSolid.isEmpty()
        ? cast.subtract(spareSolid)
        : cast.trimByPlane([0, 0, -1], -input.partTopMm));
    } else {
      trimmed = keep(cast.trimByPlane([0, 0, -1], -input.partTopMm));
    }
    const lumps = trimmed.decompose().map(keep);
    if (!lumps.length) throw new Error('Nothing is left once the spare is trimmed off.');
    let piece = lumps.reduce((a, c) => (c.volume() > a.volume() ? c : a));
    // The casting comes out in pieces: the rest falls away when it is trimmed.
    const loose = lumps.filter((l) => l !== piece && l.volume() > Math.max(20, t * t * t));
    if (loose.length) warnings.push(`The casting comes out in ${loose.length + 1} pieces: ${loose.slice(0, 3).map((l) => `${Math.round(l.volume()).toLocaleString()} mm³ at ${at(l)}`).join(', ')} ${loose.length === 1 ? 'is' : 'are'} not joined to the rest.`);
    // Nearly all the cavity set solid: whatever the reason, it is not a hollow casting.
    const cavityBelow = keep(cavity.trimByPlane([0, 0, -1], -input.partTopMm)).volume();
    if (drained && piece.volume() > 0.8 * cavityBelow) warnings.push(`The casting is ${Math.round((100 * piece.volume()) / Math.max(1, cavityBelow))}% of the cavity: it casts nearly solid, not hollow.`);
    const [fx, fy, fz] = input.footMm;
    const s = 1 / Math.max(1e-6, input.scale);
    piece = keep(piece.translate([-fx, -fy, -fz]).scale(s));
    const pb = piece.boundingBox();
    piece = keep(piece.translate([0, 0, -pb.min[2]]));
    const m = piece.getMesh();
    const positions = new Float32Array(m.numVert * 3);
    for (let i = 0; i < m.numVert; i++) for (let c = 0; c < 3; c++) positions[i * 3 + c] = m.vertProperties[i * m.numProp + c];
    const volumeMm3 = piece.volume();
    const fb = piece.boundingBox();
    const slip = castMaterial(input.slip);
    return {
      mesh: { positions, faces: new Uint32Array(m.triVerts) },
      volumeMm3: Math.round(volumeMm3),
      weightG: Math.round(castWeightG(input.slip, volumeMm3)),
      wallMm: t,
      firedWallMm: +(t * s).toFixed(2),
      sizeMm: [+(fb.max[0] - fb.min[0]).toFixed(1), +(fb.max[1] - fb.min[1]).toFixed(1), +(fb.max[2] - fb.min[2]).toFixed(1)],
      notes: [`${slip.label}, ${t} mm wall as cast, fired ${(t * s).toFixed(1)} mm after ${slip.shrinkPercent ?? 0}% shrink`],
      warnings,
    };
  } finally {
    for (const o of new Set(bin)) {
      try { o.delete(); } catch { /* already freed */ }
    }
  }
}
