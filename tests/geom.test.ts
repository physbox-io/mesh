// Winding invariants for the procedural mesh generators.
//
// These exist because three of them shipped with broken winding, and the bugs
// were invisible until a boolean body tried to use one as an OpenSCAD
// polyhedron: the tube's walls were inverted while its caps were not (mixed
// winding, which no orientation convention can interpret), the cone's side faces
// were inverted, and the wedge's renderVertices were a MIRROR of its vertices
// rather than a rotation of them.
//
// Two independent checks, because neither alone is sufficient:
//   signed volume  — catches inverted normals, but is blind to any face lying in
//                    a plane through the origin (the cone's base tetrahedra have
//                    zero volume, so an inverted base is undetectable this way)
//   directed edges — catches neighbouring faces that disagree, which is what
//                    "mixed winding" means, and does see the cone's base

import { describe, it, expect } from 'vitest';
import {
  generateTubeMeshData, generateTorusMeshData, generateConeMeshData,
  generatePyramidMeshData, generateWedgeMeshData, type MeshData,
} from '../src/utils/geom';

/** Positive iff every face is wound CCW seen from outside (normals point out). */
function signedVolume(verts: number[], faces: number[]): number {
  let vol = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3, b = faces[i + 1] * 3, c = faces[i + 2] * 3;
    const [ax, ay, az] = [verts[a], verts[a + 1], verts[a + 2]];
    const [bx, by, bz] = [verts[b], verts[b + 1], verts[b + 2]];
    const [cx, cy, cz] = [verts[c], verts[c + 1], verts[c + 2]];
    vol += (ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx)) / 6;
  }
  return vol;
}

/**
 * Every directed edge must appear exactly once, with its reverse also present.
 * A directed edge used twice means two faces disagree about which way is out.
 *
 * Vertices are welded by position first: several generators duplicate their seam
 * ring instead of sharing it, which would otherwise look like unpaired boundary
 * edges. `+n.toFixed(6) + 0` normalises -0 to 0 — seam coordinates differ by
 * float noise around 1e-18, and "-0.000000" !== "0.000000" as a hash key.
 */
function windingProblems(mesh: MeshData): { duplicated: number; unpaired: number } {
  const q = (n: number) => String(+n.toFixed(6) + 0);
  const remap: number[] = [];
  const byPos = new Map<string, number>();
  const v = mesh.renderVertices;
  for (let i = 0; i < v.length / 3; i++) {
    const key = `${q(v[i * 3])},${q(v[i * 3 + 1])},${q(v[i * 3 + 2])}`;
    if (!byPos.has(key)) byPos.set(key, byPos.size);
    remap[i] = byPos.get(key)!;
  }
  const faces = mesh.faces.map(f => remap[f]);

  const seen = new Map<string, number>();
  for (let i = 0; i < faces.length; i += 3) {
    for (const [a, b] of [[faces[i], faces[i + 1]], [faces[i + 1], faces[i + 2]], [faces[i + 2], faces[i]]]) {
      const key = `${a}>${b}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
  }
  let duplicated = 0, unpaired = 0;
  for (const [key, n] of seen) {
    if (n > 1) duplicated++;
    const [a, b] = key.split('>');
    if (!seen.has(`${b}>${a}`)) unpaired++;
  }
  return { duplicated, unpaired };
}

// n-gon area, for generators that inscribe a polygon in the ideal circle.
const ngonArea = (r: number, segments: number) =>
  0.5 * segments * r * r * Math.sin((2 * Math.PI) / segments);

const SEG = 64;
const cases: Array<{ name: string; mesh: MeshData; volume: number; tolerance: number }> = [
  {
    name: 'tube',
    mesh: generateTubeMeshData(0.06, 0.12, 0.08, SEG),
    volume: (ngonArea(0.12, SEG) - ngonArea(0.06, SEG)) * 0.08,
    tolerance: 1e-9,
  },
  {
    name: 'torus',
    mesh: generateTorusMeshData(0.15, 0.04, 96, 48),
    volume: 2 * Math.PI ** 2 * 0.15 * 0.04 ** 2,
    tolerance: 0.01,   // faceted (96x48), so ~0.4% under the ideal
  },
  {
    name: 'cone',
    mesh: generateConeMeshData(0.1, 0.2, SEG),
    volume: (ngonArea(0.1, SEG) * 0.2) / 3,
    tolerance: 1e-9,
  },
  {
    name: 'pyramid',
    mesh: generatePyramidMeshData(0.2, 0.2, 0.2),
    volume: (0.2 * 0.2 * 0.2) / 3,
    tolerance: 1e-12,
  },
  {
    name: 'wedge',
    mesh: generateWedgeMeshData(0.2, 0.1, 0.08),
    volume: 0.5 * 0.2 * 0.08 * 0.1,
    tolerance: 1e-12,
  },
];

describe.each(cases)('$name mesh', ({ mesh, volume, tolerance }) => {
  it('is wound outward, with a positive signed volume matching its analytic one', () => {
    const measured = signedVolume(mesh.renderVertices, mesh.faces);
    // Positive means every normal points out of the solid. Inverted winding would
    // give exactly -volume, and mixed winding some unrelated number.
    expect(measured).toBeGreaterThan(0);
    // A faceted mesh is inscribed in the ideal shape, so it comes in slightly
    // under; `tolerance` is the relative allowance for that per shape.
    expect(measured).toBeLessThanOrEqual(volume * (1 + 1e-9));
    expect(measured).toBeGreaterThan(volume * (1 - tolerance));
  });

  it('has consistent winding: no directed edge used twice, none unpaired', () => {
    expect(windingProblems(mesh)).toEqual({ duplicated: 0, unpaired: 0 });
  });

  it('stores vertices and renderVertices as the same solid, not mirror images', () => {
    // renderVertices must be `vertices` mapped through (x,y,z) -> (x,-z,y), a
    // ROTATION. The wedge used (x,y,z) -> (x,z,y), a reflection, so its two
    // arrays had opposite handedness and opposite winding.
    const yUp = signedVolume(mesh.vertices, mesh.faces);
    const zUp = signedVolume(mesh.renderVertices, mesh.faces);
    expect(Math.sign(yUp)).toBe(Math.sign(zUp));
    expect(yUp).toBeCloseTo(zUp, 9);
  });
});

describe('regression: signed volume alone is not enough', () => {
  it("cannot see the cone's base orientation, so the edge check must", () => {
    // The base lies in the plane y=0, which passes through the origin, so every
    // base tetrahedron has zero volume. Reversing the base changes nothing in
    // the volume but breaks edge consistency.
    const cone = generateConeMeshData(0.1, 0.2, 16);
    const sabotaged = { ...cone, faces: [...cone.faces] };
    // The base fan is the tail of the face list (16 sides, then 14 base tris).
    for (let i = 16 * 3; i < sabotaged.faces.length; i += 3) {
      const t = sabotaged.faces[i + 1];
      sabotaged.faces[i + 1] = sabotaged.faces[i + 2];
      sabotaged.faces[i + 2] = t;
    }
    expect(signedVolume(sabotaged.renderVertices, sabotaged.faces))
      .toBeCloseTo(signedVolume(cone.renderVertices, cone.faces), 12);
    expect(windingProblems(sabotaged).duplicated).toBeGreaterThan(0);
  });
});
