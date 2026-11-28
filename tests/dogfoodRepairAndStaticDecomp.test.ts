import { describe, expect, it } from 'vitest';
import { repairMesh } from '../src/utils/meshRepair';
import { sceneHasMovableBodies } from '../src/utils/convexDecomposition';
import { collisionReport } from '../src/utils/sceneSummary';
import type { SceneNode } from '../src/types/scene';
import { cupMesh, zupToYupFlat } from './helpers/meshes';

describe('repairMesh non-manifold hole-fill regression', () => {
  it('fills a 4-vertex hole without re-using an existing interior diagonal (no non-manifold plateau)', () => {
    // Build a closed box with vertices 0..7 and remove the two triangles of the
    // top face (+Z: 4,5,6,7), then add a synthetic interior diagonal edge (4,6)
    // via a small attached prism on the back, OR simpler: a tetrahedron/octahedron
    // where removing 2 faces leaves a 4-vertex loop whose shorter diagonal already
    // exists in the remaining mesh!
    //
    // Regular octahedron vertices:
    // 0: (1,0,0), 1: (0,1,0), 2: (-1,0,0), 3: (0,-1,0), 4: (0,0,0.4), 5: (0,0,-0.4)
    // Notice dist(4, 5) = 0.8 is SHORTER than dist(0, 2) = 2.0.
    // Remove the two faces sharing edge (0, 2)? No, octahedron faces are:
    // Top: (0,1,4), (1,2,4), (2,3,4), (3,0,4)
    // Bottom: (1,0,5), (2,1,5), (3,2,5), (0,3,5)
    // If we remove faces (0,1,4) and (1,0,5), we leave a 4-vertex hole [0, 4, 1, 5]!
    // Diagonal (0, 1) does not exist, diagonal (4, 5) does not exist yet — wait:
    // Now add an extra fin triangle (4, 5, 6) or pinch where edge (4, 5) ALREADY
    // exists in the mesh (two triangles on the other side share edge (4, 5))!
    //
    // Construct a closed prism where vertices [0, 1, 2, 3] form a 4-vertex hole
    // on the front, while edge (0, 2) ALREADY exists on the back side!
    // Vertices:
    // 0: (0, 0, 0), 1: (1, 0, 0.5), 2: (0, 1, 0), 3: (-1, 0, 0.5)
    // Back faces closing the loop via edge (0, 2):
    // Back-right: [0, 2, 1] -> edges (0,2), (2,1), (1,0)
    // Back-left:  [2, 0, 3] -> edges (2,0), (0,3), (3,2)
    // Wait — that's just a folded pillow with 2 faces! Make a genuine 3D shell
    // with 6 vertices (bipyramid around edge 0-2):
    // 0: (0, 0, 0), 2: (0, 1, 0)  [short diagonal dist = 1.0]
    // 1: (1.5, 0.5, 0), 3: (-1.5, 0.5, 0) [long diagonal dist = 3.0]
    // 4: (0, 0.5, -1) (bottom apex)
    // Closed shell using bottom apex 4 + top faces:
    // Bottom has 4 faces: (0,4,1), (1,4,2), (2,4,3), (3,4,0) -> boundary loop [0,1,2,3].
    // Now also connect (0,2) via a bottom ridge: replace bottom with 2 faces sharing (0,2):
    // Wait: if bottom is (0,1,4), (1,2,4), (2,0,4) AND (2,3,4), (3,0,4), (0,2,4) -> (0,2) has 2 faces!
    // Even simpler: a closed manifold shell where (0,2) is an existing edge with 2 faces,
    // and [0,1,2,3] is a 4-vertex hole whose shorter diagonal IS (0,2)!
    const positions = [
      0, 0, 0,       // 0
      1.5, 0.5, 0,   // 1
      0, 1, 0,       // 2
      -1.5, 0.5, 0,  // 3
      0.5, 0.5, -1,  // 4
      -0.5, 0.5, -1, // 5
    ];
    // Existing shell (open along top loop 0 -> 1 -> 2 -> 3 -> 0, outward normals):
    // Right bottom: (0, 4, 1), (1, 4, 2), (2, 4, 0) -- wait, edge (0,2) used by (2,4,0)
    // Left bottom:  (2, 5, 3), (3, 5, 0), (0, 5, 2) -- edge (0,2) also used by (0,5,2)!
    // Check edge counts before hole fill:
    // (0,2): 2 faces -> ALREADY an interior manifold edge!
    // (0,4),(1,4),(2,4): 2 faces each
    // (2,5),(3,5),(0,5): 2 faces each
    // Boundary edges (count 1): (0,1), (1,2), (2,3), (3,0)!
    // And notice: dist(0,2) = 1.0 < dist(1,3) = 3.0!
    // Previously, k===4 blindly chose shorter diagonal (0,2), creating 4 faces on (0,2) -> nonManifoldEdges: 1!
    const faces = [
      0, 4, 1,
      1, 4, 2,
      2, 4, 0,
      2, 5, 3,
      3, 5, 0,
      0, 5, 2,
    ];

    const res = repairMesh(positions, faces, { weldTolerance: 0 });
    expect(res.after.nonManifoldEdges).toBe(0);
    expect(res.after.boundaryEdges).toBe(0);
    expect(res.after.closed).toBe(true);
    expect(res.after.consistentlyWound).toBe(true);

    // Running repair a second time must be idempotent (no oscillation).
    const res2 = repairMesh(res.positions, res.faces, { weldTolerance: 0 });
    expect(res2.after.nonManifoldEdges).toBe(0);
    expect(res2.after.closed).toBe(true);
    expect(res2.removedNonManifold).toBe(0);
  });
});

describe('static-only scenes skip background convex decomposition', () => {
  const staticBowl = (id: string, extra: Partial<SceneNode> = {}): SceneNode => {
    const m = cupMesh({ outerR: 0.05, innerR: 0.045, height: 0.04, baseThickness: 0.004 });
    return {
      id, name: id, type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [{ name: `${id}_m`, type: 'mesh', size: [1], renderVertices: m.verts, vertices: zupToYupFlat(m.verts), faces: m.faces }],
      ...extra,
    } as SceneNode;
  };

  it('detects movable bodies accurately', () => {
    const s1 = staticBowl('garment_a');
    const s2 = staticBowl('garment_b');
    expect(sceneHasMovableBodies([s1, s2])).toBe(false);

    const dynamicBall: SceneNode = {
      id: 'ball', name: 'ball', type: 'body', pos: [0, 0, 0.2],
      joints: [{ name: 'ball_free', type: 'free' }],
      geoms: [{ name: 'g', type: 'sphere', size: [0.02] }],
      children: [],
    };
    expect(sceneHasMovableBodies([s1, dynamicBall])).toBe(true);
  });

  it('collisionReport omits collisionPending for static-only display scenes unless collision==="decompose"', () => {
    const s = staticBowl('shorts_body');
    const staticReport = collisionReport(s, { sceneHasMovable: false });
    expect(staticReport.collisionPending).toBeUndefined();
    expect(String(staticReport.collidesAs)).toMatch(/static display/i);

    const movableReport = collisionReport(s, { sceneHasMovable: true });
    expect(movableReport.collisionPending).toBe(true);

    const forced = staticBowl('shorts_forced', { collision: 'decompose' });
    expect(collisionReport(forced, { sceneHasMovable: false }).collisionPending).toBe(true);
  });
});
