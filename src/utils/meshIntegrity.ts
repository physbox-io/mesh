// What a triangle soup actually encloses.
//
// Two callers ask the same three questions of a mesh and have to agree on the
// answers: physics_get_scene_summary, which reports watertightness so an agent
// can see a mesh is open before it exports as nothing, and the MJCF compiler,
// which uses them to decide whether MuJoCo can be trusted to integrate the
// mesh's real volume for its mass (see the `inertia` note in mjcf.ts).
//
// The questions: is every edge used by exactly two triangles, do those two
// traverse it in OPPOSITE directions, are there any degenerate triangles, and
// is the signed volume positive.
//
// The direction half of that is what catches a mesh whose triangles do not all
// face the same way. CLAUDE.md § Traps notes that signed volume only catches a
// UNIFORMLY inverted solid — a mesh with faces both ways can still sum
// positive — and this is the check that does catch it: two triangles sharing an
// edge agree about which side is outside exactly when one walks that edge a→b
// and the other walks it b→a.
//
// Edge keys are integers rather than strings because this runs for every mesh
// in every scene summary and on every recompile.

export interface MeshIntegrity {
  /** Every edge shared by exactly two triangles, and no degenerate triangles. */
  closed: boolean;
  /** Every shared edge walked in opposite directions by its two triangles. */
  consistentlyWound: boolean;
  /** Signed volume in the units the positions are given in; negative = inverted. */
  volume: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  degenerateTriangles: number;
}

/**
 * Above this the edge map costs more than either caller's whole job, so they
 * are told "not checked" rather than made to wait. A mesh this size is a
 * sculpt or a relief, and both of those are built closed by construction.
 */
export const MAX_CHECKED_TRIANGLES = 200_000;

/** `null` when the mesh is empty or too large to check. */
export function analyzeMesh(positions: number[], faces: number[]): MeshIntegrity | null {
  const triangles = faces.length / 3;
  if (!triangles || !positions.length) return null;
  if (triangles > MAX_CHECKED_TRIANGLES) return null;

  const vertexCount = positions.length / 3;
  const edges = new Map<number, number>();
  // Directed, so that a→b and b→a are different keys: a second triangle walking
  // an edge the same way as the first is one of them facing inward.
  const directed = new Set<number>();
  let inconsistent = false;
  let degenerateTriangles = 0;
  let volume = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const t0 = faces[i], t1 = faces[i + 1], t2 = faces[i + 2];
    if (t0 === t1 || t1 === t2 || t0 === t2) { degenerateTriangles++; continue; }
    const tri = [t0, t1, t2];
    for (let e = 0; e < 3; e++) {
      const a = tri[e], b = tri[(e + 1) % 3];
      const key = a < b ? a * vertexCount + b : b * vertexCount + a;
      edges.set(key, (edges.get(key) ?? 0) + 1);
      const dir = a * vertexCount + b;
      if (directed.has(dir)) inconsistent = true;
      directed.add(dir);
    }
    const a = t0 * 3, b = t1 * 3, c = t2 * 3;
    volume += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  let boundaryEdges = 0, nonManifoldEdges = 0;
  for (const n of edges.values()) {
    if (n === 1) boundaryEdges++;
    else if (n > 2) nonManifoldEdges++;
  }
  return {
    closed: boundaryEdges === 0 && nonManifoldEdges === 0 && degenerateTriangles === 0,
    consistentlyWound: !inconsistent,
    volume,
    boundaryEdges,
    nonManifoldEdges,
    degenerateTriangles,
  };
}
