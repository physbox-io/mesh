// The two things that have to be true of a body the moment it can move: it can
// touch the world, and it weighs what its shape says it weighs.
//
// Both were found through the oak tree preset, which is scenery — jointless,
// and with collision turned off because the convex hull of a tree is a dome
// nothing should bump into. Switched to 6-DOF in the properties panel it fell
// through the floor forever, and once it collided it still behaved like a
// 274-tonne dome of water, because MuJoCo weighs a mesh by its convex hull.

import { describe, it, expect } from 'vitest';
import { restoreCollisionWhenMadeMovable } from '../src/store/useStore';
import { compileToMJCF } from '../src/utils/mjcf';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const body = (geoms: SceneGeom[]): SceneNode => ({
  id: 'b', name: 'b', type: 'body', pos: [0, 0, 0],
  joints: [{ name: 'b_joint', type: 'free' }], geoms, children: [],
} as unknown as SceneNode);

const ghost = (name: string): SceneGeom =>
  ({ name, type: 'box', size: [1, 1, 1], contype: 0, conaffinity: 0 } as SceneGeom);

describe('a body that has just been made movable', () => {
  it('can touch the world again when nothing in it collided', () => {
    const n = body([ghost('a'), ghost('b')]);
    restoreCollisionWhenMadeMovable(n);
    for (const g of n.geoms!) {
      expect(g.contype).toBeUndefined();
      expect(g.conaffinity).toBeUndefined();
    }
  });

  it('is left alone when it already has a collider', () => {
    // A trunk cylinder under visual-only meshes is a considered choice: the
    // colliding shape is deliberately not the shape you see.
    const n = body([
      { name: 'trunk', type: 'cylinder', size: [0.3, 0.9] } as SceneGeom,
      ghost('crown'),
    ]);
    restoreCollisionWhenMadeMovable(n);
    expect(n.geoms![1].contype).toBe(0);
    expect(n.geoms![1].conaffinity).toBe(0);
  });

  it('leaves a visual-only geom visual', () => {
    const n = body([{ name: 'shell', type: 'box', size: [1, 1, 1], role: 'visual' } as SceneGeom]);
    restoreCollisionWhenMadeMovable(n);
    expect(n.geoms![0].role).toBe('visual');
  });

  it('does nothing to a body with no geoms', () => {
    const n = body([]);
    expect(() => restoreCollisionWhenMadeMovable(n)).not.toThrow();
  });
});

// --- mass from the mesh, not from its convex hull --------------------------

/** A unit cube, closed and wound outward. */
const CUBE_VERTS = [
  0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0,
  0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
];
const CUBE_FACES = [
  0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
  0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
  2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
];

const meshScene = (vertices: number[], faces: number[]): SceneGraph => ({
  nodes: [{
    id: 'm', name: 'm', type: 'body', pos: [0, 0, 0],
    joints: [{ name: 'm_joint', type: 'free' }],
    geoms: [{ name: 'm_g', type: 'mesh', size: [1], vertices, faces }],
    children: [],
  }],
} as unknown as SceneGraph);

describe('mesh inertia', () => {
  it('asks MuJoCo to integrate the real volume of a closed mesh', () => {
    expect(compileToMJCF(meshScene(CUBE_VERTS, CUBE_FACES))).toContain('inertia="exact"');
  });

  it('leaves an open mesh on the convex-hull default', () => {
    // Drop the two triangles of one face and the solid has a hole in it, which
    // is not something MuJoCo can integrate a volume over.
    const open = CUBE_FACES.slice(0, CUBE_FACES.length - 6);
    expect(compileToMJCF(meshScene(CUBE_VERTS, open))).not.toContain('inertia="exact"');
  });

  it('leaves a mesh whose faces disagree on the convex-hull default', () => {
    // Every edge is still used twice and the volume is still positive — this is
    // the case signed volume alone cannot see, and the one MuJoCo refuses to
    // load a model over ("faces of mesh have inconsistent orientation"). The
    // mesh_collision preset's ramp is built this way.
    const mixed = CUBE_FACES.slice();
    [mixed[0], mixed[1]] = [mixed[1], mixed[0]];
    expect(compileToMJCF(meshScene(CUBE_VERTS, mixed))).not.toContain('inertia="exact"');
  });

  it('leaves an inside-out mesh on the convex-hull default', () => {
    // Reversed winding makes the signed volume negative; asking for an exact
    // inertia there would ask MuJoCo for a negative mass.
    const flipped: number[] = [];
    for (let i = 0; i < CUBE_FACES.length; i += 3) {
      flipped.push(CUBE_FACES[i], CUBE_FACES[i + 2], CUBE_FACES[i + 1]);
    }
    expect(compileToMJCF(meshScene(CUBE_VERTS, flipped))).not.toContain('inertia="exact"');
  });
});

describe('density', () => {
  it('says what a geom is made of instead of assuming water', () => {
    const scene = meshScene(CUBE_VERTS, CUBE_FACES);
    scene.nodes[0].geoms![0].density = 700;
    expect(compileToMJCF(scene)).toContain('density="700"');
  });

  it('defers to an explicit mass', () => {
    const scene = meshScene(CUBE_VERTS, CUBE_FACES);
    scene.nodes[0].geoms![0].density = 700;
    scene.nodes[0].geoms![0].mass = 12;
    const xml = compileToMJCF(scene);
    expect(xml).toContain('mass="12"');
    expect(xml).not.toContain('density="700"');
  });
});

// Every mesh in every preset, checked the way the compiler checks it.
//
// This is the test that would have caught all four of the meshes this change
// had to fix, none of which looked broken: the mesh_collision ramp had one
// triangle of eight facing inward, its pyramid was inverted throughout, all
// seven meshes of the Golden Gate came out of one helper that was wound
// backwards, the OpenSCAD demo's container had 26 of 28 faces the wrong way,
// and the bust was both inverted and unwelded up its seam. A mis-wound face is
// not drawn at all rather than drawn wrongly, so the symptom is a body that
// looks half transparent (CLAUDE.md § Traps) — and the quieter cost is that
// MuJoCo will not integrate a mesh it cannot orient, so the body silently falls
// back to the mass of its convex hull.
describe('every preset mesh', () => {
  it('is closed, consistently wound and encloses a positive volume', async () => {
    const { PRESETS } = await import('../src/presets/presetScenes');
    const { analyzeMesh } = await import('../src/utils/meshIntegrity');
    const bad: string[] = [];
    for (const [key, entry] of Object.entries(PRESETS as Record<string, { scene: SceneGraph }>)) {
      const walk = (nodes: SceneNode[]) => {
        for (const n of nodes ?? []) {
          for (const g of n.geoms ?? []) {
            if (g.type !== 'mesh' || !g.faces?.length) continue;
            const m = analyzeMesh(g.renderVertices ?? g.vertices!, g.faces);
            if (!m) continue;   // too large to check; see MAX_CHECKED_TRIANGLES
            if (!m.closed || !m.consistentlyWound || m.volume <= 0) {
              bad.push(`${key}/${g.name}: closed=${m.closed} wound=${m.consistentlyWound} `
                + `volume=${m.volume.toExponential(2)} boundaryEdges=${m.boundaryEdges}`);
            }
          }
          walk(n.children ?? []);
        }
      };
      walk(entry.scene?.nodes ?? []);
    }
    expect(bad).toEqual([]);
  });
});
