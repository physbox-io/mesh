// ---------------------------------------------------------------------------
// Which piece of a cut part something belongs to
//
// The knife and Split for Print replace one body with several, and the first
// piece kept the body's id, so everything that hung off the body or was
// welded to it stayed with that piece: a screw seated in the other half rode
// along with the wrong one. A point (a child's origin, a welded body's) goes
// to the piece that contains it, or failing that the nearest.
// ---------------------------------------------------------------------------

interface Piece { positions: ArrayLike<number>; faces: ArrayLike<number> }

/** Crossings of a ray from `p` along +Z with the mesh: odd means inside. */
function inside(piece: Piece, p: number[]): boolean {
  const v = piece.positions, f = piece.faces;
  let crossings = 0;
  for (let t = 0; t + 2 < f.length; t += 3) {
    const a = f[t] * 3, b = f[t + 1] * 3, c = f[t + 2] * 3;
    // Barycentric test of (x, y) against the triangle's footprint.
    const x1 = v[a] - p[0], y1 = v[a + 1] - p[1];
    const x2 = v[b] - p[0], y2 = v[b + 1] - p[1];
    const x3 = v[c] - p[0], y3 = v[c + 1] - p[1];
    const d = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1);
    if (Math.abs(d) < 1e-18) continue;
    const u = (x2 * y3 - x3 * y2) / d;
    const w = (x3 * y1 - x1 * y3) / d;
    const s = 1 - u - w;
    if (u < 0 || w < 0 || s < 0) continue;
    const z = u * v[a + 2] + w * v[b + 2] + s * v[c + 2];
    if (z > p[2]) crossings++;
  }
  return crossings % 2 === 1;
}

function nearestVertex(piece: Piece, p: number[]): number {
  const v = piece.positions;
  let best = Infinity;
  for (let i = 0; i + 2 < v.length; i += 3) {
    best = Math.min(best, (v[i] - p[0]) ** 2 + (v[i + 1] - p[1]) ** 2 + (v[i + 2] - p[2]) ** 2);
  }
  return best;
}

/** The index of the piece holding `p` (same frame as the pieces), or the nearest one. */
export function pieceHolding(pieces: Piece[], p: number[]): number {
  const holding = pieces.findIndex((piece) => inside(piece, p));
  if (holding >= 0) return holding;
  let best = 0, bestD = Infinity;
  pieces.forEach((piece, k) => {
    const d = nearestVertex(piece, p);
    if (d < bestD) { bestD = d; best = k; }
  });
  return best;
}
