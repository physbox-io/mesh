import { describe, it, expect } from 'vitest';
import { meshPieces, collisionVariant, usesCollisionProxies } from '../src/utils/scadColliders';
import { boxMesh } from './helpers/meshes';

describe('collision proxies a SCAD script draws', () => {
  it('is switched on by the script mentioning the flag, and sets it last so it wins', () => {
    const scad = '$physbox_collision = false;\nif ($physbox_collision) cube(1); else sphere(1);';
    expect(usesCollisionProxies(scad)).toBe(true);
    expect(usesCollisionProxies('cube(1);')).toBe(false);
    expect(collisionVariant(scad).trim().endsWith('$physbox_collision = true;')).toBe(true);
  });

  it('splits the collision output into one piece per separate solid', () => {
    const a = boxMesh([0, 0, 0], [0.01, 0.01, 0.01]);
    const b = boxMesh([0.05, 0, 0], [0.01, 0.02, 0.01]);
    // As an STL arrives: two boxes in one array, the second's vertices duplicated per face.
    const verts = [...a.verts, ...b.verts];
    const faces = [...a.faces, ...b.faces.map((i) => i + a.verts.length / 3)];
    const soupVerts: number[] = [];
    const soupFaces: number[] = [];
    for (let t = 0; t < faces.length; t++) {
      soupVerts.push(verts[faces[t] * 3], verts[faces[t] * 3 + 1], verts[faces[t] * 3 + 2]);
      soupFaces.push(t);
    }
    const pieces = meshPieces(soupVerts, soupFaces);
    expect(pieces.length).toBe(2);
    expect(pieces.map((p) => p.length).sort()).toEqual([8, 8]);
  });
});
