// ---------------------------------------------------------------------------
// 2.5D feature reconstruction
//
// Most mechanical STLs — plates, brackets, enclosure lids, anything that came
// off a printer — are prismatic: the cross-section perpendicular to one axis is
// constant over a run of heights, changing only at a few levels, with the
// occasional tapered band where an edge is chamfered.
//
// Rebuilding that structure gives an OpenSCAD program made of 2D profiles and
// named heights, which is both exact (it reproduces the mesh, not a bounding
// box) and genuinely editable — unlike a polyhedron of raw triangles.
//
// Everything here works in Z-up model space, the same frame as the emitted
// OpenSCAD. `axis` selects the extrusion direction; the two perpendicular axes
// (in index order) become the profile's local U and V.
// ---------------------------------------------------------------------------

export type Pt = [number, number];

/** A closed 2D outline, wound counter-clockwise, without collinear points. */
export type Loop = Pt[];

/** One connected 2D area: an outline with any number of holes in it. */
export interface Region {
  outer: Loop;
  holes: Loop[];
}

export interface Slab {
  /** Extents along the extrusion axis. */
  z0: number;
  z1: number;
  /** Cross-section at the bottom of the slab. */
  bottom: Region[];
  /**
   * Cross-section at the top, when the slab tapers; null when it is prismatic
   * and `bottom` is the whole story.
   */
  top: Region[] | null;
  /**
   * Inward offset from `bottom` to `top`, when the taper is a plain chamfer.
   * Lets the top be written as offset(r = -chamfer) of one shared profile.
   */
  chamfer: number | null;
  /** Cross-section area halfway up a tapered slab, for the volume check. */
  midArea: number | null;
}

export interface PrismaticModel {
  axis: 0 | 1 | 2;
  slabs: Slab[];
  /** Volume of the reconstruction, for checking it against the mesh. */
  volume: number;
}

const EPS = 1e-9;

const PERP: Record<number, [number, number]> = { 0: [1, 2], 1: [0, 2], 2: [0, 1] };

/** Weld coordinates onto a 1µm grid, the same tolerance the STL parser uses. */
const qkey = (x: number, y: number) => `${Math.round(x * 1e6) || 0},${Math.round(y * 1e6) || 0}`;

export function loopArea(loop: Loop): number {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const p = loop[i], q = loop[(i + 1) % loop.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function loopPerimeter(loop: Loop): number {
  let p = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    p += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return p;
}

export function loopBounds(loop: Loop) {
  const xs = loop.map(p => p[0]), ys = loop.map(p => p[1]);
  const min: Pt = [Math.min(...xs), Math.min(...ys)];
  const max: Pt = [Math.max(...xs), Math.max(...ys)];
  return { min, max, size: [max[0] - min[0], max[1] - min[1]] as Pt, center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2] as Pt };
}

function pointInLoop(pt: Pt, loop: Loop): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const [xi, yi] = loop[i], [xj, yj] = loop[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Drop points that sit on the straight line between their neighbours. */
function simplifyLoop(loop: Loop, tol: number): Loop {
  if (loop.length < 3) return loop;
  const out: Loop = [];
  for (let i = 0; i < loop.length; i++) {
    const a = loop[(i - 1 + loop.length) % loop.length];
    const b = loop[i];
    const c = loop[(i + 1) % loop.length];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const scale = Math.hypot(c[0] - a[0], c[1] - a[1]);
    if (scale > 0 && Math.abs(cross) / scale <= tol) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : loop;
}

/**
 * Intersect the mesh with the plane `axis = plane` and chain the resulting
 * segments into closed loops.
 */
export function sliceLoops(verts: number[], faces: number[], axis: 0 | 1 | 2, plane: number, tol: number): Loop[] {
  const [p, q] = PERP[axis];
  const segs: [Pt, Pt][] = [];

  for (let i = 0; i < faces.length; i += 3) {
    const idx = [faces[i], faces[i + 1], faces[i + 2]];
    const hits: Pt[] = [];
    for (let e = 0; e < 3; e++) {
      const a = idx[e] * 3, b = idx[(e + 1) % 3] * 3;
      const da = verts[a + axis] - plane, db = verts[b + axis] - plane;
      // Half-open plane test (d >= 0 vs d < 0): symbolically perturbs vertices
      // lying exactly on the plane to the positive side so single vertices and
      // in-plane edges on the cut plane produce clean, non-duplicated segments.
      if ((da < 0 && db >= 0) || (da >= 0 && db < 0)) {
        const t = da / (da - db);
        hits.push([verts[a + p] + t * (verts[b + p] - verts[a + p]), verts[a + q] + t * (verts[b + q] - verts[a + q])]);
      }
    }
    if (hits.length === 2 && Math.hypot(hits[0][0] - hits[1][0], hits[0][1] - hits[1][1]) > EPS) {
      segs.push([hits[0], hits[1]]);
    }
  }
  if (segs.length < 3) return [];

  // Chain segments end to end. Each welded point should have exactly two
  // incident segment ends on a closed manifold.
  const next = new Map<string, Pt[]>();
  for (const [a, b] of segs) {
    for (const [from, to] of [[a, b], [b, a]] as [Pt, Pt][]) {
      const k = qkey(from[0], from[1]);
      if (!next.has(k)) next.set(k, []);
      next.get(k)!.push(to);
    }
  }

  const visited = new Set<string>();
  const loops: Loop[] = [];
  for (const [start] of segs) {
    const startKey = qkey(start[0], start[1]);
    if (visited.has(startKey)) continue;
    const loop: Loop = [start];
    visited.add(startKey);
    for (;;) {
      const cur = loop[loop.length - 1];
      const candidates = next.get(qkey(cur[0], cur[1])) || [];
      const step = candidates.find(c => !visited.has(qkey(c[0], c[1])));
      if (!step) break;
      visited.add(qkey(step[0], step[1]));
      loop.push(step);
    }
    if (loop.length >= 3) {
      const last = loop[loop.length - 1];
      const lastNeighbors = next.get(qkey(last[0], last[1])) || [];
      const closes = lastNeighbors.some(c => qkey(c[0], c[1]) === startKey);
      if (closes) {
        const simplified = simplifyLoop(loop, tol);
        if (Math.abs(loopArea(simplified)) > tol * tol) loops.push(simplified);
      }
    }
  }
  return loops;
}

/** Nest loops into outlines with holes, and wind them consistently. */
export function buildRegions(loops: Loop[]): Region[] {
  const wound = loops.map(l => (loopArea(l) < 0 ? [...l].reverse() : l));
  // Depth = how many other loops contain this one. Even depth is solid area,
  // odd depth is a hole in the loop that contains it.
  const sorted = wound
    .map((loop, i) => ({ loop, i, area: Math.abs(loopArea(loop)) }))
    .sort((a, b) => b.area - a.area);

  const depth = sorted.map(({ loop }) =>
    sorted.filter(other => other.loop !== loop && pointInLoop(loop[0], other.loop)).length);

  const regions: Region[] = [];
  sorted.forEach((entry, i) => {
    if (depth[i] % 2 !== 0) return;
    const holes = sorted
      .filter((other, j) => depth[j] === depth[i] + 1 && pointInLoop(other.loop[0], entry.loop))
      .map(other => [...other.loop].reverse());
    regions.push({ outer: entry.loop, holes });
  });
  return regions;
}

export function regionsArea(regions: Region[]): number {
  return regions.reduce((sum, r) => sum + Math.abs(loopArea(r.outer)) - r.holes.reduce((h, l) => h + Math.abs(loopArea(l)), 0), 0);
}

interface LoopSignature {
  area: number;
  perimeter: number;
  bounds: ReturnType<typeof loopBounds>;
}

function loopSignature(loop: Loop): LoopSignature {
  return {
    area: Math.abs(loopArea(loop)),
    perimeter: loopPerimeter(loop),
    bounds: loopBounds(loop),
  };
}

function compareByCenterAndArea(a: LoopSignature, b: LoopSignature): number {
  return (
    a.bounds.center[0] - b.bounds.center[0] ||
    a.bounds.center[1] - b.bounds.center[1] ||
    a.area - b.area
  );
}

/** Match two loops with dimensionally consistent tolerances: area in m², bounds/centre in m. */
function loopsMatch(a: LoopSignature, b: LoopSignature, tol: number): boolean {
  const areaTol = Math.max(Math.max(a.area, b.area) * 0.02, Math.max(a.perimeter, b.perimeter) * tol, tol * tol);
  return (
    Math.abs(a.area - b.area) <= areaTol &&
    Math.abs(a.bounds.center[0] - b.bounds.center[0]) <= tol &&
    Math.abs(a.bounds.center[1] - b.bounds.center[1]) <= tol &&
    Math.abs(a.bounds.size[0] - b.bounds.size[0]) <= tol * 2 &&
    Math.abs(a.bounds.size[1] - b.bounds.size[1]) <= tol * 2
  );
}

/** Deterministically pair items from `a` and `b` by nearest centre. */
function pairByNearestCenter<T>(
  a: T[],
  b: T[],
  sigOf: (item: T) => LoopSignature,
): [T, T][] | null {
  if (a.length !== b.length) return null;
  const sa = [...a].map(item => ({ item, sig: sigOf(item) })).sort((x, y) => compareByCenterAndArea(x.sig, y.sig));
  const sb = [...b].map(item => ({ item, sig: sigOf(item) })).sort((x, y) => compareByCenterAndArea(x.sig, y.sig));
  const used = new Uint8Array(sb.length);
  const pairs: [T, T][] = [];
  for (const ea of sa) {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let j = 0; j < sb.length; j++) {
      if (used[j]) continue;
      const d = Math.hypot(
        ea.sig.bounds.center[0] - sb[j].sig.bounds.center[0],
        ea.sig.bounds.center[1] - sb[j].sig.bounds.center[1],
      );
      if (d < bestDist) {
        bestDist = d;
        bestIdx = j;
      }
    }
    if (bestIdx < 0) return null;
    used[bestIdx] = 1;
    pairs.push([ea.item, sb[bestIdx].item]);
  }
  return pairs;
}

/** Do two cross-sections describe the same shape (i.e. is the slab prismatic)? */
export function regionsMatch(a: Region[], b: Region[], tol: number): boolean {
  const pairs = pairByNearestCenter(a, b, r => loopSignature(r.outer));
  if (!pairs) return false;
  return pairs.every(([ra, rb]) => {
    if (ra.holes.length !== rb.holes.length) return false;
    if (!loopsMatch(loopSignature(ra.outer), loopSignature(rb.outer), tol)) return false;
    if (ra.holes.length === 0) return true;
    const holePairs = pairByNearestCenter(ra.holes, rb.holes, loopSignature);
    if (!holePairs) return false;
    return holePairs.every(([ha, hb]) => loopsMatch(loopSignature(ha), loopSignature(hb), tol));
  });
}

/**
 * If `top` is `bottom` shrunk uniformly inwards, return that distance. Used to
 * turn a tapered band into one profile plus a `chamfer` parameter instead of
 * two unrelated point lists.
 */
export function uniformOffset(bottom: Region[], top: Region[], tol: number): number | null {
  const pairs = pairByNearestCenter(bottom, top, r => loopSignature(r.outer));
  if (!pairs) return null;

  let delta: number | null = null;
  for (const [bReg, tReg] of pairs) {
    if (bReg.holes.length !== tReg.holes.length) return null;
    const b = loopBounds(bReg.outer);
    const t = loopBounds(tReg.outer);
    // The outline has to shrink by the same amount on both sides of both axes,
    // otherwise it is a taper, not a chamfer.
    const dxLo = t.min[0] - b.min[0], dxHi = b.max[0] - t.max[0];
    const dyLo = t.min[1] - b.min[1], dyHi = b.max[1] - t.max[1];
    const d = (dxLo + dxHi + dyLo + dyHi) / 4;
    if (d <= tol) return null;
    if ([dxLo, dxHi, dyLo, dyHi].some(v => Math.abs(v - d) > Math.max(tol, d * 0.05))) return null;

    // Cross-check against the area an offset of d would produce:
    // A' = A - P·d + k·d², where k = π for rounded corners and k = 4 for sharp/miter corners.
    const area = Math.abs(loopArea(bReg.outer));
    const perim = loopPerimeter(bReg.outer);
    const actualTopArea = Math.abs(loopArea(tReg.outer));
    const predRound = area - perim * d + Math.PI * d * d;
    const predMiter = area - perim * d + 4 * d * d;
    const areaErr = Math.min(Math.abs(predRound - actualTopArea), Math.abs(predMiter - actualTopArea));
    if (areaErr > Math.max(area * 0.05, tol * tol)) return null;

    if (delta === null) delta = d;
    else if (Math.abs(delta - d) > Math.max(tol, delta * 0.05)) return null;

    // Holes must either remain unchanged (straight bore through a chamfered
    // outer edge) or expand uniformly outwards by the same chamfer offset `d`.
    if (bReg.holes.length > 0) {
      const holePairs = pairByNearestCenter(bReg.holes, tReg.holes, loopSignature);
      if (!holePairs) return null;
      for (const [bHole, tHole] of holePairs) {
        const bSig = loopSignature(bHole);
        const tSig = loopSignature(tHole);
        if (loopsMatch(bSig, tSig, tol)) continue;
        // Uniform outward expansion of a hole by `d`:
        const hdxLo = bSig.bounds.min[0] - tSig.bounds.min[0];
        const hdxHi = tSig.bounds.max[0] - bSig.bounds.max[0];
        const hdyLo = bSig.bounds.min[1] - tSig.bounds.min[1];
        const hdyHi = tSig.bounds.max[1] - bSig.bounds.max[1];
        const holeTol = Math.max(tol, d * 0.05);
        if ([hdxLo, hdxHi, hdyLo, hdyHi].some(v => Math.abs(v - d) > holeTol)) return null;
        const hPredRound = bSig.area + bSig.perimeter * d + Math.PI * d * d;
        const hPredMiter = bSig.area + bSig.perimeter * d + 4 * d * d;
        const hAreaErr = Math.min(Math.abs(hPredRound - tSig.area), Math.abs(hPredMiter - tSig.area));
        if (hAreaErr > Math.max(bSig.area * 0.05, tol * tol)) return null;
      }
    }
  }
  return delta;
}

/**
 * Prismatoid rule: V = h/6 · (A0 + 4·Amid + A1). Exact for the quadratic area
 * variation that offsetting a section produces, so this doubles as the check
 * that the reconstruction really is the part.
 */
function slabVolume(slab: Slab): number {
  const h = slab.z1 - slab.z0;
  const a0 = regionsArea(slab.bottom);
  if (!slab.top) return a0 * h;
  const a1 = regionsArea(slab.top);
  const amid = slab.midArea ?? (a0 + a1) / 2;
  return (h / 6) * (a0 + 4 * amid + a1);
}

/**
 * Try to rebuild the mesh as a stack of extruded cross-sections along one axis.
 * Returns null when the shape is not prismatic in any direction, or when the
 * reconstruction does not reproduce the mesh's own volume.
 */
export function reconstructPrismatic(
  verts: number[],
  faces: number[],
  meshVolume: number,
  maxLevels = 24,
): PrismaticModel | null {
  let best: PrismaticModel | null = null;

  for (const axis of [0, 1, 2] as const) {
    const coords = new Set<number>();
    for (let i = axis; i < verts.length; i += 3) coords.add(Math.round(verts[i] * 1e6) / 1e6);
    const levels = [...coords].sort((a, b) => a - b);
    if (levels.length < 2 || levels.length > maxLevels) continue;

    const span = levels[levels.length - 1] - levels[0];
    const tol = span * 1e-3;
    const slabs: Slab[] = [];
    let ok = true;

    for (let i = 0; i < levels.length - 1 && ok; i++) {
      const z0 = levels[i], z1 = levels[i + 1];
      const h = z1 - z0;
      if (h <= tol) continue;

      const lo = buildRegions(sliceLoops(verts, faces, axis, z0 + h * 0.05, tol));
      const hi = buildRegions(sliceLoops(verts, faces, axis, z1 - h * 0.05, tol));
      if (lo.length === 0 && hi.length === 0) continue; // hollow gap, e.g. under an overhang
      if (lo.length === 0 || hi.length === 0) { ok = false; break; }

      if (regionsMatch(lo, hi, tol)) {
        slabs.push({ z0, z1, bottom: lo, top: null, chamfer: null, midArea: null });
        continue;
      }
      const chamfer = uniformOffset(lo, hi, tol);
      if (chamfer === null && !regionsMatch(lo, hi, tol)) {
        // A taper we cannot describe as a chamfer is still exact as a loft
        // between the two sections, as long as nothing is non-convex enough for
        // hull() to fill in.
        if (lo.length !== hi.length || lo.some(r => r.holes.length > 0) || hi.some(r => r.holes.length > 0)) {
          ok = false;
          break;
        }
      }
      const midArea = regionsArea(buildRegions(sliceLoops(verts, faces, axis, (z0 + z1) / 2, tol)));
      slabs.push({ z0, z1, bottom: lo, top: hi, chamfer, midArea });
    }

    if (!ok || slabs.length === 0) continue;

    const volume = slabs.reduce((sum, s) => sum + slabVolume(s), 0);
    // The reconstruction has to actually be the part.
    if (meshVolume > 0 && Math.abs(volume - meshVolume) > meshVolume * 0.02) continue;

    if (!best || slabs.length < best.slabs.length) best = { axis, slabs, volume };
  }

  return best;
}
