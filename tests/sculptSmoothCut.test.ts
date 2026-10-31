// Smooth rounds the hard edge a cut leaves.
//
// A cut's cap is one fan of long triangles with no vertex inside it, and
// Smooth never refined, so it had nothing on the cap to bend: eight dabs at
// full strength on the rim moved the corner 0.2 mm and left the crease
// sharper (55° to 77°) than they found it.

import { beforeAll, describe, expect, it } from 'vitest';
import type { ManifoldToplevel } from 'manifold-3d';
import { icosphere, cloneSculptMesh, recomputeNormals, type SculptMesh } from '../src/utils/sculptMesh';
import { applySculptStroke } from '../src/utils/sculptCommands';
import { cutSculpt, loadManifold } from '../src/utils/sculptCut';

let wasm: ManifoldToplevel;
beforeAll(async () => { wasm = await loadManifold(); });

const R = 0.03;
const CAP = 0.6 * R;
const RIM = Math.sqrt(R * R - CAP * CAP);

/** The sharpest fold, in degrees, between faces meeting within 3 mm of the corner smoothed. */
function creaseAtCorner(mesh: SculptMesh): number {
  const P = mesh.positions, F = mesh.faces;
  const normal = (t: number) => {
    const a = F[t * 3], b = F[t * 3 + 1], c = F[t * 3 + 2];
    const u = [0, 1, 2].map((i) => P[b * 3 + i] - P[a * 3 + i]);
    const v = [0, 1, 2].map((i) => P[c * 3 + i] - P[a * 3 + i]);
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return n.map((x) => x / l);
  };
  const edges = new Map<string, number[]>();
  for (let t = 0; t < mesh.faceCount; t++) {
    for (let e = 0; e < 3; e++) {
      const a = F[t * 3 + e], b = F[t * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      edges.set(key, [...(edges.get(key) ?? []), t]);
    }
  }
  let worst = 0;
  for (const [key, faces] of edges) {
    const a = Number(key.split(',')[0]);
    if (faces.length !== 2 || Math.hypot(P[a * 3] - RIM, P[a * 3 + 1], P[a * 3 + 2] - CAP) > 0.003) continue;
    const n1 = normal(faces[0]), n2 = normal(faces[1]);
    const dot = Math.max(-1, Math.min(1, n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2]));
    worst = Math.max(worst, (Math.acos(dot) * 180) / Math.PI);
  }
  return worst;
}

describe('Smooth on the rim of a cut', () => {
  it('rounds the edge, and keeps the clay from swelling with vertices', () => {
    const box = wasm.Manifold.cube([0.1, 0.1, 0.1], true).translate([0, 0, CAP + 0.05]);
    const cut = cutSculpt(wasm, icosphere(R, 4), box);
    box.delete();
    if (!cut.ok) throw new Error(cut.error);
    recomputeNormals(cut.mesh);
    const before = creaseAtCorner(cut.mesh);
    expect(before).toBeGreaterThan(45);

    const mesh = cloneSculptMesh(cut.mesh);
    for (let i = 0; i < 20; i++) applySculptStroke(mesh, { brush: 'smooth', at: [[RIM, 0, CAP]], radius: 0.008, strength: 1 });
    expect(creaseAtCorner(mesh)).toBeLessThan(before * 0.5);
    expect(mesh.vertexCount).toBeLessThan(cut.mesh.vertexCount * 1.5);
  });
});
