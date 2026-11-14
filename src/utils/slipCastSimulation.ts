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
    for (let k = 0; k < n; k++) {
      let liquid: CrossSection | null = null;
      for (let j = -reachSteps; j <= reachSteps && (liquid === null || !liquid.isEmpty()); j++) {
        const at = k + j;
        if (at >= n) continue; // above the spare's mouth: open
        const inset = Math.sqrt(Math.max(0, t * t - (j * dz) ** 2));
        const here = at < 0 ? keep(wasm.CrossSection.square(0)) : keep(outlines[at].offset(-inset, 'Round', 2, 24));
        liquid = liquid ? keep(liquid.intersect(here)) : here;
      }
      if (liquid && !liquid.isEmpty()) slabs.push(keep(keep(liquid.simplify(0.05)).extrude(dz + 0.02).translate([0, 0, zMin + k * dz - 0.01])));
    }
    const notes: string[] = [];
    let drained: Manifold | null = null;
    if (slabs.length) {
      // Only the slip that reaches the spare pours out; a pocket sealed off
      // by the wall stays in and sets solid.
      const liquid = keep(wasm.Manifold.union(slabs));
      const parts = liquid.decompose().map(keep);
      const out = parts.filter((p) => p.boundingBox().max[2] >= zMax - 2 * dz);
      if (out.length < parts.length) notes.push('Some slip is sealed off from the spare by the wall and sets solid there.');
      drained = out.length ? keep(wasm.Manifold.union(out)) : null;
    }
    if (!drained) notes.push(`The cavity is no wider than two walls (${t * 2} mm) anywhere: it casts solid.`);
    const cast = keep(drained ? cavity.subtract(drained) : cavity);
    // The spare's clay is cut off at the rim.
    const trimmed = keep(cast.trimByPlane([0, 0, -1], -input.partTopMm));
    const lumps = trimmed.decompose().map(keep);
    if (!lumps.length) throw new Error('Nothing is left once the spare is trimmed off.');
    let piece = lumps.reduce((a, c) => (c.volume() > a.volume() ? c : a));
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
      notes: [`${slip.label}, ${t} mm wall as cast, fired ${(t * s).toFixed(1)} mm after ${slip.shrinkPercent ?? 0}% shrink`, ...notes],
    };
  } finally {
    for (const o of new Set(bin)) {
      try { o.delete(); } catch { /* already freed */ }
    }
  }
}
