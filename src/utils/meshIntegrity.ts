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
// Edge keys are numbers in sorted typed arrays rather than strings or Map keys
// because this runs for every mesh in every scene summary and on every recompile.

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
 * Above this the two sorted edge arrays (16 bytes per triangle corner) and their
 * sorts cost more than either caller's whole job. Two million triangles is about
 * 100 MB of STL; below it the check takes well under a second, and a big mesh
 * is exactly the one headed for a printer or a mold with a hole in it.
 */
export const MAX_CHECKED_TRIANGLES = 2_000_000;

/** `null` when the mesh is empty or too large to check. */
export function analyzeMesh(positions: ArrayLike<number>, faces: ArrayLike<number>): MeshIntegrity | null {
  const triangles = faces.length / 3;
  if (!triangles || !positions.length) return null;
  if (triangles > MAX_CHECKED_TRIANGLES) return null;

  // One key per triangle corner's edge, undirected and directed, sorted and
  // then read as runs. A Map and a Set took six times as long (1.2 s against 0.2 s on 456k triangles)
  // and several times the memory, which is what used to cap this at 200k.
  // Keys stay below 2^53 for any vertex count under ~94 million.
  const vertexCount = positions.length / 3;
  const undirected = new Float64Array(faces.length);
  // Directed, so that a→b and b→a are different keys: a second triangle walking
  // an edge the same way as the first is one of them facing inward.
  const directed = new Float64Array(faces.length);
  let n = 0;
  let degenerateTriangles = 0;
  let volume = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const t0 = faces[i], t1 = faces[i + 1], t2 = faces[i + 2];
    if (t0 === t1 || t1 === t2 || t0 === t2) { degenerateTriangles++; continue; }
    undirected[n] = t0 < t1 ? t0 * vertexCount + t1 : t1 * vertexCount + t0;
    directed[n++] = t0 * vertexCount + t1;
    undirected[n] = t1 < t2 ? t1 * vertexCount + t2 : t2 * vertexCount + t1;
    directed[n++] = t1 * vertexCount + t2;
    undirected[n] = t2 < t0 ? t2 * vertexCount + t0 : t0 * vertexCount + t2;
    directed[n++] = t2 * vertexCount + t0;
    const a = t0 * 3, b = t1 * 3, c = t2 * 3;
    volume += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6;
  }
  const edges = undirected.subarray(0, n).sort();
  const walks = directed.subarray(0, n).sort();
  let inconsistent = false;
  for (let i = 1; i < n; i++) {
    if (walks[i] === walks[i - 1]) { inconsistent = true; break; }
  }
  let boundaryEdges = 0, nonManifoldEdges = 0;
  for (let i = 0; i < n;) {
    let j = i + 1;
    while (j < n && edges[j] === edges[i]) j++;
    if (j - i === 1) boundaryEdges++;
    else if (j - i > 2) nonManifoldEdges++;
    i = j;
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
