import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

// ---------------------------------------------------------------------------
// Coordinate spaces
//
// An STL file is authored Z-up, which is also OpenSCAD's convention and the
// convention every pos/size in this app uses (see the header comment in
// utils/csg.ts). So all shape inference and all generated OpenSCAD below works
// in the raw STL frame, exposed as `renderVertices`.
//
// `vertices` is the Three.js Y-up copy (x, z, -y), matching what scadWorker
// produces for compiled meshes and what mjcf.ts expects in SceneGeom.vertices.
// ---------------------------------------------------------------------------

export interface STLParseOptions {
  name?: string;
  scale?: number | [number, number, number];
  autoScaleMmToMeters?: boolean;
}

export interface BoundingBox {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
}

/** A circular through-hole recognised in a sub-component, in Z-up model space. */
export interface InferredHole {
  /** Axis the hole is drilled along: 0 = X, 1 = Y, 2 = Z. */
  axis: 0 | 1 | 2;
  center: [number, number, number];
  radius: number;
  depth: number;
}

/** The primitive a sub-component was recognised as. */
export type PrimitiveFit =
  | { kind: 'sphere'; center: [number, number, number]; radius: number; exact: boolean }
  | { kind: 'cylinder'; center: [number, number, number]; axis: 0 | 1 | 2; radius: number; height: number; exact: boolean }
  | { kind: 'box'; center: [number, number, number]; size: [number, number, number]; exact: boolean };

export interface SubComponent {
  id: number;
  /** Z-up, scaled, indices local to this component. */
  vertices: number[];
  faces: number[];
  centroid: [number, number, number];
  bbox: BoundingBox;
  /** Enclosed volume of this shell. */
  volume: number;
  fit: PrimitiveFit;
  holes: InferredHole[];
}

export interface ParsedSTLResult {
  /** Three.js Y-up vertices, for SceneGeom.vertices. */
  vertices: number[];
  /** Z-up vertices, for SceneGeom.renderVertices. */
  renderVertices: number[];
  faces: number[];
  /** Z-up bounds of the whole model. */
  boundingBox: BoundingBox;
  subComponents: SubComponent[];
  inferredSpacing?: {
    axis: 'x' | 'y' | 'z';
    delta: number;
    count: number;
  };
  /** One-line, human-readable description of what the inference recognised. */
  shapeSummary: string;
  scadRaw: string;
  scadParametric: string;
  scadCsg: string;
  primitiveGeom: {
    type: 'box' | 'cylinder' | 'sphere';
    size: number[];
  };
  appliedScale: [number, number, number];
}

/** Compute bounding box for flat [x,y,z,...] array */
export function computeBoundingBox(verts: number[]): BoundingBox {
  if (!verts || verts.length === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (let i = 0; i < verts.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = verts[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }

  const size: [number, number, number] = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];

  return { min, max, size, center };
}

/** Enclosed volume of a closed triangle shell (sum of signed tetra volumes). */
function computeVolume(verts: number[], faces: number[]): number {
  let vol = 0;
  for (let i = 0; i < faces.length; i += 3) {
    const a = faces[i] * 3, b = faces[i + 1] * 3, c = faces[i + 2] * 3;
    const ax = verts[a], ay = verts[a + 1], az = verts[a + 2];
    const bx = verts[b], by = verts[b + 1], bz = verts[b + 2];
    const cx = verts[c], cy = verts[c + 1], cz = verts[c + 2];
    vol += (
      ax * (by * cz - bz * cy) -
      ay * (bx * cz - bz * cx) +
      az * (bx * cy - by * cx)
    ) / 6;
  }
  return Math.abs(vol);
}

// --- Union-find, used both for splitting islands and for grouping face loops ---

function makeDSU(n: number) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  return { find, union };
}

/**
 * Split an indexed mesh into connected components (islands). Operates on the
 * deduplicated index buffer, so two triangles touching at a shared vertex are
 * one island — which is what "one physical part" means for an STL.
 */
function findSubComponents(verts: number[], faces: number[]): { vertices: number[]; faces: number[] }[] {
  const vertCount = verts.length / 3;
  if (vertCount === 0) return [];

  const dsu = makeDSU(vertCount);
  for (let i = 0; i < faces.length; i += 3) {
    dsu.union(faces[i], faces[i + 1]);
    dsu.union(faces[i + 1], faces[i + 2]);
  }

  // Bucket faces by island root, then rebuild a local vertex array per island.
  const byRoot = new Map<number, number[]>();
  for (let i = 0; i < faces.length; i += 3) {
    const root = dsu.find(faces[i]);
    let list = byRoot.get(root);
    if (!list) byRoot.set(root, (list = []));
    list.push(i);
  }

  const out: { vertices: number[]; faces: number[] }[] = [];
  for (const faceStarts of byRoot.values()) {
    const remap = new Map<number, number>();
    const localVerts: number[] = [];
    const localFaces: number[] = [];
    for (const f of faceStarts) {
      for (let k = 0; k < 3; k++) {
        const gi = faces[f + k];
        let li = remap.get(gi);
        if (li === undefined) {
          li = localVerts.length / 3;
          remap.set(gi, li);
          localVerts.push(verts[gi * 3], verts[gi * 3 + 1], verts[gi * 3 + 2]);
        }
        localFaces.push(li);
      }
    }
    out.push({ vertices: localVerts, faces: localFaces });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shape inference
// ---------------------------------------------------------------------------

const PERP: Record<number, [number, number]> = { 0: [1, 2], 1: [0, 2], 2: [0, 1] };

/** True when a and b agree to within `tol` (relative to the larger of the two). */
function close(a: number, b: number, tol: number): boolean {
  const m = Math.max(Math.abs(a), Math.abs(b));
  return m === 0 ? true : Math.abs(a - b) <= tol * m;
}

/** Volume ratio a solid of `expected` volume would have against the real mesh. */
function volumeRatio(actual: number, expected: number): number {
  return expected === 0 ? Infinity : actual / expected;
}

function fitSphere(verts: number[], bbox: BoundingBox, volume: number): PrimitiveFit | null {
  const [sx, sy, sz] = bbox.size;
  if (!close(sx, sy, 0.05) || !close(sx, sz, 0.05)) return null;

  const r = (sx + sy + sz) / 6;
  if (r <= 0) return null;

  // Every surface vertex of a sphere sits on the same radius from the centre.
  let outliers = 0;
  const n = verts.length / 3;
  for (let i = 0; i < verts.length; i += 3) {
    const d = Math.hypot(
      verts[i] - bbox.center[0],
      verts[i + 1] - bbox.center[1],
      verts[i + 2] - bbox.center[2],
    );
    if (!close(d, r, 0.06)) outliers++;
  }
  if (outliers > n * 0.05) return null;

  const ratio = volumeRatio(volume, (4 / 3) * Math.PI * r ** 3);
  if (ratio < 0.85 || ratio > 1.15) return null;
  return { kind: 'sphere', center: bbox.center, radius: r, exact: true };
}

/**
 * Find circular through-holes.
 *
 * For each axis, look at the vertices lying on the two extreme faces, split
 * them into loops along mesh edges, and keep the loops that are circles but are
 * not the outer boundary. A circle appearing at the same place on both faces is
 * a hole drilled clean through — the case worth parameterising (bolt patterns,
 * axle bores). Pockets and blind holes are deliberately ignored rather than
 * guessed at.
 */
function detectThroughHoles(verts: number[], faces: number[], bbox: BoundingBox): InferredHole[] {
  const maxDim = Math.max(...bbox.size);
  if (maxDim <= 0) return [];
  const planeTol = maxDim * 1e-4;
  const vertCount = verts.length / 3;

  const circlesOnPlane = (axis: 0 | 1 | 2, plane: number) => {
    const onPlane = new Uint8Array(vertCount);
    let count = 0;
    for (let v = 0; v < vertCount; v++) {
      if (Math.abs(verts[v * 3 + axis] - plane) <= planeTol) {
        onPlane[v] = 1;
        count++;
      }
    }
    if (count < 8) return [];

    // Split the face into its outlines. Connectivity alone is no use here: the
    // triangulation of a face runs straight across it, joining a hole rim to the
    // outer outline. The rims are the face's *boundary* — edges used by exactly
    // one of its triangles — so group along those only.
    const edgeUse = new Map<number, number>();
    for (let i = 0; i < faces.length; i += 3) {
      const a = faces[i], b = faces[i + 1], c = faces[i + 2];
      if (!onPlane[a] || !onPlane[b] || !onPlane[c]) continue;
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = u < v ? u * vertCount + v : v * vertCount + u;
        edgeUse.set(key, (edgeUse.get(key) || 0) + 1);
      }
    }

    const dsu = makeDSU(vertCount);
    const onLoop = new Uint8Array(vertCount);
    for (const [key, uses] of edgeUse) {
      if (uses !== 1) continue;
      const u = Math.floor(key / vertCount), v = key % vertCount;
      dsu.union(u, v);
      onLoop[u] = 1;
      onLoop[v] = 1;
    }

    const clusters = new Map<number, number[]>();
    for (let v = 0; v < vertCount; v++) {
      if (!onLoop[v]) continue;
      const root = dsu.find(v);
      let list = clusters.get(root);
      if (!list) clusters.set(root, (list = []));
      list.push(v);
    }

    const [p, q] = PERP[axis];
    const found: { u: number; v: number; radius: number }[] = [];
    for (const cluster of clusters.values()) {
      if (cluster.length < 6) continue;

      let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
      let sumU = 0, sumV = 0;
      for (const vi of cluster) {
        const u = verts[vi * 3 + p], w = verts[vi * 3 + q];
        sumU += u; sumV += w;
        if (u < minU) minU = u; if (u > maxU) maxU = u;
        if (w < minV) minV = w; if (w > maxV) maxV = w;
      }
      // The loop that spans the whole face is the part outline, not a hole.
      if (close(maxU - minU, bbox.size[p], 0.05) && close(maxV - minV, bbox.size[q], 0.05)) continue;

      const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
      const radius = ((maxU - minU) + (maxV - minV)) / 4;
      if (radius <= planeTol) continue;

      // A circle is centred on its own bounding box and has every vertex at the
      // same distance from that centre; an arbitrary pocket outline is neither.
      if (Math.abs(sumU / cluster.length - cu) > radius * 0.05) continue;
      if (Math.abs(sumV / cluster.length - cv) > radius * 0.05) continue;
      let ok = true;
      for (const vi of cluster) {
        const d = Math.hypot(verts[vi * 3 + p] - cu, verts[vi * 3 + q] - cv);
        if (!close(d, radius, 0.08)) { ok = false; break; }
      }
      if (!ok) continue;
      found.push({ u: cu, v: cv, radius });
    }
    return found;
  };

  let best: InferredHole[] = [];
  for (const axis of [0, 1, 2] as const) {
    const low = circlesOnPlane(axis, bbox.min[axis]);
    if (low.length === 0) continue;
    const high = circlesOnPlane(axis, bbox.max[axis]);
    const [p, q] = PERP[axis];
    const tol = maxDim * 0.01;

    const holes: InferredHole[] = [];
    for (const c of low) {
      const match = high.find(h =>
        Math.abs(h.u - c.u) <= tol && Math.abs(h.v - c.v) <= tol && close(h.radius, c.radius, 0.05));
      if (!match) continue;
      const center: [number, number, number] = [0, 0, 0];
      center[axis] = bbox.center[axis];
      center[p] = c.u;
      center[q] = c.v;
      holes.push({ axis, center, radius: c.radius, depth: bbox.size[axis] });
    }
    if (holes.length > best.length) best = holes;
  }
  return best;
}

/** Classify one island: an exact primitive, a primitive with holes, or a best-effort box/cylinder. */
function classify(vertices: number[], faces: number[]): { fit: PrimitiveFit; holes: InferredHole[] } {
  const bbox = computeBoundingBox(vertices);
  const volume = computeVolume(vertices, faces);

  // Look for drilled holes before fitting, not after: a bolt hole in a plate
  // removes well under a percent of the volume, so a volume test alone would
  // happily call the plate a solid cube and throw the hole away.
  const holes = detectThroughHoles(vertices, faces, bbox);
  const holeVolume = holes.reduce((sum, h) => sum + Math.PI * h.radius ** 2 * h.depth, 0);

  if (holes.length === 0) {
    const sphere = fitSphere(vertices, bbox, volume);
    if (sphere) return { fit: sphere, holes };
  }

  // A cylinder's axis is the one whose two perpendicular extents match. Several
  // axes qualify when the part is as tall as it is wide, so score them by how
  // well the volume works out (with any bore subtracted) instead of taking the
  // first — and let a detected bore break the tie, since that is the axis the
  // part is actually turned about.
  const cylCandidates = ([0, 1, 2] as const)
    .filter(a => close(bbox.size[PERP[a][0]], bbox.size[PERP[a][1]], 0.06))
    .map(axis => {
      const [pa, qa] = PERP[axis];
      const radius = (bbox.size[pa] + bbox.size[qa]) / 4;
      const height = bbox.size[axis];
      const bore = holes.length > 0 && holes[0].axis === axis ? holeVolume : 0;
      return { axis, radius, height, err: Math.abs(1 - volumeRatio(volume, Math.PI * radius * radius * height - bore)) };
    })
    .sort((a, b) => a.err - b.err);

  const bestCyl = cylCandidates[0];
  if (bestCyl && bestCyl.err <= 0.12) {
    return {
      fit: { kind: 'cylinder', center: bbox.center, axis: bestCyl.axis, radius: bestCyl.radius, height: bestCyl.height, exact: true },
      holes,
    };
  }

  const boxErr = Math.abs(1 - volumeRatio(volume, bbox.size[0] * bbox.size[1] * bbox.size[2] - holeVolume));
  if (boxErr <= 0.08) {
    return { fit: { kind: 'box', center: bbox.center, size: bbox.size, exact: true }, holes };
  }

  // Nothing recognised: fall back to whichever bounds-sized primitive is
  // closest by volume, and flag it as approximate rather than claiming a match.
  if (bestCyl && bestCyl.err < boxErr) {
    return {
      fit: {
        kind: 'cylinder',
        center: bbox.center,
        axis: bestCyl.axis,
        radius: bestCyl.radius,
        height: bestCyl.height,
        exact: false,
      },
      holes,
    };
  }
  return { fit: { kind: 'box', center: bbox.center, size: bbox.size, exact: false }, holes };
}

// ---------------------------------------------------------------------------
// OpenSCAD emission
// ---------------------------------------------------------------------------

const fmt = (v: number): string => {
  const r = Number(v.toFixed(6));
  return Object.is(r, -0) ? '0' : String(r);
};

/** Slider annotation parseScadVariables() understands: `// [min:step:max]`. */
const slider = (v: number): string => {
  const step = Number((Math.max(Math.abs(v), 1e-4) / 50).toPrecision(1));
  return `// [${fmt(Math.max(step, 0))}:${fmt(step)}:${fmt(Math.abs(v) * 3 || step * 100)}]`;
};

const AXIS_NAME = ['x', 'y', 'z'] as const;

/** OpenSCAD rotation that points a Z-axis primitive along `axis`. */
function rotateForAxis(axis: 0 | 1 | 2): string | null {
  if (axis === 0) return 'rotate([0, 90, 0]) ';
  if (axis === 1) return 'rotate([-90, 0, 0]) ';
  return null;
}

/** `polyhedron(...)` for an indexed mesh, with OpenSCAD's clockwise winding. */
function emitPolyhedron(vertices: number[], faces: number[], indent: string): string {
  const pts: string[] = [];
  for (let i = 0; i < vertices.length; i += 3) {
    pts.push(`[${fmt(vertices[i])}, ${fmt(vertices[i + 1])}, ${fmt(vertices[i + 2])}]`);
  }
  // STL triangles wind counter-clockwise seen from outside; OpenSCAD wants the
  // opposite, and gets normals inside-out otherwise.
  const tris: string[] = [];
  for (let i = 0; i < faces.length; i += 3) {
    tris.push(`[${faces[i + 2]}, ${faces[i + 1]}, ${faces[i]}]`);
  }
  return `${indent}polyhedron(
${indent}  points = [
${indent}    ${pts.join(`,\n${indent}    `)}
${indent}  ],
${indent}  faces = [
${indent}    ${tris.join(`,\n${indent}    `)}
${indent}  ],
${indent}  convexity = 6
${indent});`;
}

/** The body of one recognised island: its primitive, minus any holes. */
function emitFitBody(fit: PrimitiveFit, holes: InferredHole[], vars: string, indent: string): string {
  let solid: string;
  if (fit.kind === 'sphere') {
    solid = `sphere(d = ${vars}diameter, $fn = 64);`;
  } else if (fit.kind === 'cylinder') {
    const rot = rotateForAxis(fit.axis) ?? '';
    solid = `${rot}cylinder(h = ${vars}height, d = ${vars}diameter, center = true, $fn = 64);`;
  } else {
    solid = `cube([${vars}size_x, ${vars}size_y, ${vars}size_z], center = true);`;
  }

  if (holes.length === 0) return `${indent}${solid}`;

  const axis = holes[0].axis;
  const [p, q] = PERP[axis];
  const rot = rotateForAxis(axis) ?? '';
  const positions = holes
    .map(h => `[${fmt(h.center[p] - fit.center[p])}, ${fmt(h.center[q] - fit.center[q])}]`)
    .join(', ');
  // Holes are cut over-length so the end faces are cleanly open, never coplanar.
  const offset: string[] = ['0', '0', '0'];
  offset[p] = 'p[0]';
  offset[q] = 'p[1]';

  return `${indent}difference() {
${indent}  ${solid}
${indent}  for (p = [${positions}])
${indent}    translate([${offset.join(', ')}]) ${rot}cylinder(h = ${vars}hole_depth, d = ${vars}hole_d, center = true, $fn = 48);
${indent}}`;
}

/**
 * One island's solid for the CSG program.
 *
 * A recognised island becomes its primitive, placed at its own centre. An
 * unrecognised one keeps its real triangles: substituting a bounding box there
 * would silently replace the user's part with a block that looks nothing like
 * it, which is worse than having no parameters. Sliders are a bonus; rendering
 * the actual part is not.
 */
function emitIslandBody(c: SubComponent, prefix: string, indent: string): string {
  if (!c.fit.exact) return emitPolyhedron(c.vertices, c.faces, indent);
  return translateWrap(c.fit.center, emitFitBody(c.fit, c.holes, prefix, indent), indent);
}

/** Parameter declarations for one island's fit, prefixed when there are several. */
function emitFitVars(fit: PrimitiveFit, holes: InferredHole[], prefix: string): string {
  if (!fit.exact) return '';
  const lines: string[] = [];
  const decl = (name: string, value: number) => lines.push(`${prefix}${name} = ${fmt(value)}; ${slider(value)}`);

  if (fit.kind === 'sphere') {
    decl('diameter', fit.radius * 2);
  } else if (fit.kind === 'cylinder') {
    decl('height', fit.height);
    decl('diameter', fit.radius * 2);
  } else {
    decl('size_x', fit.size[0]);
    decl('size_y', fit.size[1]);
    decl('size_z', fit.size[2]);
  }
  if (holes.length > 0) {
    decl('hole_d', holes[0].radius * 2);
    decl('hole_depth', holes[0].depth * 2);
  }
  return lines.join('\n');
}

function describeFit(fit: PrimitiveFit, holes: InferredHole[]): string {
  const mm = (v: number) => `${(v * 1000).toFixed(1)}mm`;
  let base: string;
  if (fit.kind === 'sphere') base = `sphere Ø${mm(fit.radius * 2)}`;
  else if (fit.kind === 'cylinder') base = `cylinder Ø${mm(fit.radius * 2)} × ${mm(fit.height)} along ${AXIS_NAME[fit.axis].toUpperCase()}`;
  else base = `box ${mm(fit.size[0])} × ${mm(fit.size[1])} × ${mm(fit.size[2])}`;

  if (holes.length > 0) {
    base += ` with ${holes.length} through-hole${holes.length > 1 ? 's' : ''} Ø${mm(holes[0].radius * 2)}`;
  }
  return fit.exact
    ? base
    : `not a primitive (roughly ${base}) — kept as an exact mesh`;
}

/** Detect an evenly spaced run of congruent islands along one axis. */
function detectArray(components: SubComponent[]): ParsedSTLResult['inferredSpacing'] | undefined {
  if (components.length < 3) return undefined;

  for (const axis of [0, 1, 2] as const) {
    const sorted = [...components].sort((a, b) => a.centroid[axis] - b.centroid[axis]);

    // Every element has to be the same shape, or it isn't an array.
    const ref = sorted[0].bbox.size;
    if (!sorted.every(c => c.bbox.size.every((s, i) => close(s, ref[i], 0.03)))) continue;

    const deltas: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      deltas.push(sorted[i].centroid[axis] - sorted[i - 1].centroid[axis]);
    }
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    if (avg <= Math.max(...ref) * 0.01) continue;
    if (!deltas.every(d => close(d, avg, 0.05))) continue;

    // The other two axes must not drift, otherwise it's a diagonal scatter.
    const [p, q] = PERP[axis];
    const spreadOk = [p, q].every(a =>
      sorted.every(c => Math.abs(c.centroid[a] - sorted[0].centroid[a]) <= Math.max(...ref) * 0.02));
    if (!spreadOk) continue;

    return { axis: AXIS_NAME[axis], delta: avg, count: sorted.length };
  }
  return undefined;
}

/** Translate wrapper, omitted when the offset is negligible. */
function translateWrap(offset: [number, number, number], body: string, indent: string): string {
  if (offset.every(v => Math.abs(v) < 1e-9)) return body;
  return `${indent}translate([${offset.map(fmt).join(', ')}])\n${body.replace(/^/gm, '  ')}`;
}

/** Parse STL data (ArrayBuffer or ASCII string) */
export function parseSTL(
  data: ArrayBuffer | string,
  options: STLParseOptions = {}
): ParsedSTLResult {
  const loader = new STLLoader();
  const geometry = loader.parse(data as any);
  const positionAttr = geometry.attributes.position;

  if (!positionAttr) {
    throw new Error('Parsed STL geometry does not contain position attributes.');
  }

  const rawVerts = positionAttr.array as Float32Array;

  // Compute raw bounding box to check mm -> meter auto-scaling
  const rawBbox = computeBoundingBox(Array.from(rawVerts));
  const diagM = Math.hypot(...rawBbox.size);

  let scaleX = 1.0;
  let scaleY = 1.0;
  let scaleZ = 1.0;

  if (options.scale !== undefined) {
    if (typeof options.scale === 'number') {
      scaleX = scaleY = scaleZ = options.scale;
    } else {
      [scaleX, scaleY, scaleZ] = options.scale;
    }
  } else if (options.autoScaleMmToMeters !== false && diagM > 2.0) {
    // If diagonal > 2m, auto-scale mm to meters (1000x)
    scaleX = scaleY = scaleZ = 0.001;
  }

  // Deduplicate into an index buffer, keeping both conventions in sync.
  const yUpVerts: number[] = [];
  const zUpVerts: number[] = [];
  const faces: number[] = [];
  const vertMap = new Map<string, number>();

  for (let i = 0; i < rawVerts.length; i += 3) {
    const x = rawVerts[i] * scaleX;
    const y = rawVerts[i + 1] * scaleY;
    const z = rawVerts[i + 2] * scaleZ;

    // Weld on a 1µm grid. Rounding to an integer (rather than toFixed) matters:
    // a coordinate of -1e-16 — which any lathe-like STL produces at the seam
    // where the sweep closes — formats as "-0.000000" and would not weld to its
    // "0.000000" twin, leaving a split seam that breaks hole and island
    // detection downstream.
    const key = `${Math.round(x * 1e6) || 0},${Math.round(y * 1e6) || 0},${Math.round(z * 1e6) || 0}`;
    let idx = vertMap.get(key);
    if (idx === undefined) {
      idx = zUpVerts.length / 3;
      vertMap.set(key, idx);
      zUpVerts.push(x, y, z);
      yUpVerts.push(x, z, -y);
    }
    faces.push(idx);
  }

  const boundingBox = computeBoundingBox(zUpVerts);
  const partName = options.name || 'imported_stl';

  // --- Inference -----------------------------------------------------------

  const islands = findSubComponents(zUpVerts, faces);
  const subComponents: SubComponent[] = islands.map((island, id) => {
    const bbox = computeBoundingBox(island.vertices);
    const { fit, holes } = classify(island.vertices, island.faces);
    return {
      id,
      vertices: island.vertices,
      faces: island.faces,
      centroid: bbox.center,
      bbox,
      volume: computeVolume(island.vertices, island.faces),
      fit,
      holes,
    };
  });

  const inferredSpacing = detectArray(subComponents);

  // --- Generated OpenSCAD --------------------------------------------------

  const scadRaw = `// Auto-generated OpenSCAD polyhedron for ${partName} (Z-up, metres)
${emitPolyhedron(zUpVerts, faces, '')}`;

  // Parametric mesh: the real geometry, scaled by sliders. When the model is a
  // linear array, one element becomes a module so count and spacing are live
  // parameters (the old version repeated the *whole* mesh instead of one
  // element, which just stacked N copies of everything).
  const sizeX = boundingBox.size[0] || 1;
  const sizeY = boundingBox.size[1] || 1;
  const sizeZ = boundingBox.size[2] || 1;

  let scadParametric = `// Parametric OpenSCAD for ${partName} — scaled mesh (Z-up, metres)
size_x = ${fmt(sizeX)}; ${slider(sizeX)}
size_y = ${fmt(sizeY)}; ${slider(sizeY)}
size_z = ${fmt(sizeZ)}; ${slider(sizeZ)}

`;

  if (inferredSpacing) {
    const element = subComponents[0];
    const axisIndex = AXIS_NAME.indexOf(inferredSpacing.axis);
    const offset = ['0', '0', '0'];
    offset[axisIndex] = `i * spacing`;
    scadParametric += `element_count = ${inferredSpacing.count}; // [1:1:40]
spacing = ${fmt(inferredSpacing.delta)}; ${slider(inferredSpacing.delta)}

module element() {
${emitPolyhedron(element.vertices, element.faces, '  ')}
}

scale([size_x / ${fmt(sizeX)}, size_y / ${fmt(sizeY)}, size_z / ${fmt(sizeZ)}])
  for (i = [0 : element_count - 1])
    translate([${offset.join(', ')}]) element();
`;
  } else {
    scadParametric += `scale([size_x / ${fmt(sizeX)}, size_y / ${fmt(sizeY)}, size_z / ${fmt(sizeZ)}])
${emitPolyhedron(zUpVerts, faces, '  ')}
`;
  }

  // CSG primitives: what the inference actually recognised, as clean editable
  // OpenSCAD. Multi-island models become a union (or a for-loop when they form
  // an array), each island placed at its own centre. Islands that are not a
  // primitive keep their triangles — this program always renders the real part.
  let scadCsg: string;
  const summaries = subComponents.map(c => describeFit(c.fit, c.holes));

  if (subComponents.length === 1) {
    const c = subComponents[0];
    const vars = emitFitVars(c.fit, c.holes, '');
    scadCsg = `// Parametric CSG for ${partName} (Z-up, metres)
// ${summaries[0]}
${vars ? `${vars}\n` : ''}
${emitIslandBody(c, '', '')}
`;
  } else if (inferredSpacing) {
    const element = subComponents[0];
    const axisIndex = AXIS_NAME.indexOf(inferredSpacing.axis);
    const offset = ['0', '0', '0'];
    offset[axisIndex] = 'i * spacing';
    scadCsg = `// Parametric CSG for ${partName} (Z-up, metres)
// ${inferredSpacing.count} × ${summaries[0]}, spaced along ${inferredSpacing.axis.toUpperCase()}
${emitFitVars(element.fit, element.holes, '') ? `${emitFitVars(element.fit, element.holes, '')}\n` : ''}element_count = ${inferredSpacing.count}; // [1:1:40]
spacing = ${fmt(inferredSpacing.delta)}; ${slider(inferredSpacing.delta)}

module element() {
${emitIslandBody(element, '', '  ')}
}

for (i = [0 : element_count - 1])
  translate([${offset.map((o, i) => (i === axisIndex ? o : (element.fit.exact ? fmt(element.fit.center[i]) : '0'))).join(', ')}]) element();
`;
  } else {
    const blocks = subComponents.map((c, i) => {
      const prefix = `p${i}_`;
      const vars = emitFitVars(c.fit, c.holes, prefix);
      return {
        vars: `// part ${i + 1}: ${summaries[i]}${vars ? `\n${vars}` : ''}`,
        body: emitIslandBody(c, prefix, '  '),
      };
    });
    scadCsg = `// Parametric CSG for ${partName} (Z-up, metres)
// Recognised ${subComponents.length} parts
${blocks.map(b => b.vars).join('\n\n')}

union() {
${blocks.map(b => b.body).join('\n')}
}
`;
  }

  // --- MuJoCo primitive fallback ------------------------------------------

  const topFit = subComponents.length === 1 ? subComponents[0].fit : null;
  let primitiveGeom: ParsedSTLResult['primitiveGeom'];
  if (topFit && topFit.kind === 'sphere') {
    primitiveGeom = { type: 'sphere', size: [topFit.radius] };
  } else if (topFit && topFit.kind === 'cylinder' && topFit.axis === 2) {
    // MuJoCo cylinders are Z-aligned; a sideways one is better served by a box.
    primitiveGeom = { type: 'cylinder', size: [topFit.radius, topFit.height / 2] };
  } else {
    primitiveGeom = { type: 'box', size: [boundingBox.size[0] / 2, boundingBox.size[1] / 2, boundingBox.size[2] / 2] };
  }

  const shapeSummary = inferredSpacing
    ? `${inferredSpacing.count} × ${summaries[0]}, ${(inferredSpacing.delta * 1000).toFixed(1)}mm apart along ${inferredSpacing.axis.toUpperCase()}`
    : subComponents.length === 1
      ? summaries[0]
      : `${subComponents.length} parts: ${summaries.slice(0, 3).join('; ')}${summaries.length > 3 ? '; …' : ''}`;

  return {
    vertices: yUpVerts,
    renderVertices: zUpVerts,
    faces,
    boundingBox,
    subComponents,
    inferredSpacing,
    shapeSummary,
    scadRaw,
    scadParametric,
    scadCsg,
    primitiveGeom,
    appliedScale: [scaleX, scaleY, scaleZ],
  };
}
