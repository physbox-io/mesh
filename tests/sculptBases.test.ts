import { describe, it, expect } from 'vitest';
import {
  surfaceNets,
  boneDistance,
  smoothUnion,
  skeletonField,
  skeletonBounds,
  type Bone,
} from '../src/utils/surfaceNets';
import {
  SCULPT_BASES,
  buildSculptBase,
  cubeBase,
  cylinderBase,
  humanoidSkeleton,
  handSkeleton,
  BASE_SIZE,
  DEFAULT_SCULPT_BASE,
} from '../src/utils/sculptBases';
import { recomputeNormals } from '../src/utils/sculptMesh';
import { nearestSurfacePoint } from '../src/utils/sculptCommands';
import { createSculptMesh, isWatertight, meshBounds, type SculptMesh } from '../src/utils/sculptMesh';
import { meshGeomTriangles, meshGeomToStl, stlFileName } from '../src/utils/meshStlExport';

const sphereField = (radius: number) => (x: number, y: number, z: number) => Math.hypot(x, y, z) - radius;

/** How many triangles each undirected edge carries. */
function edgeHistogram(mesh: SculptMesh): Map<number, number> {
  const counts = new Map<string, number>();
  for (let f = 0; f < mesh.faceCount; f++) {
    for (let e = 0; e < 3; e++) {
      const a = mesh.faces[f * 3 + e];
      const b = mesh.faces[f * 3 + ((e + 1) % 3)];
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const histogram = new Map<number, number>();
  for (const count of counts.values()) histogram.set(count, (histogram.get(count) ?? 0) + 1);
  return histogram;
}

/** Fraction of vertices whose normal points away from the shape's centre. */
function outwardFraction(mesh: SculptMesh): number {
  const bounds = meshBounds(mesh);
  const centre = [0, 1, 2].map((k) => (bounds.min[k] + bounds.max[k]) / 2);
  let outward = 0;
  for (let i = 0; i < mesh.vertexCount; i++) {
    const dot =
      (mesh.positions[i * 3] - centre[0]) * mesh.normals[i * 3] +
      (mesh.positions[i * 3 + 1] - centre[1]) * mesh.normals[i * 3 + 1] +
      (mesh.positions[i * 3 + 2] - centre[2]) * mesh.normals[i * 3 + 2];
    if (dot > 0) outward++;
  }
  return outward / Math.max(1, mesh.vertexCount);
}

describe('bone distance', () => {
  const straight: Bone = { a: [-0.05, 0, 0], b: [0.05, 0, 0], ra: 0.02, rb: 0.02 };

  it('is the capsule distance for an untapered bone', () => {
    expect(boneDistance(0, 0, 0, straight)).toBeCloseTo(-0.02, 6);
    expect(boneDistance(0, 0.02, 0, straight)).toBeCloseTo(0, 6);
    expect(boneDistance(0.09, 0, 0, straight)).toBeCloseTo(0.02, 6);
  });

  it('lands on the surface at both ends of a taper', () => {
    const taper: Bone = { a: [0, 0, 0], b: [0.1, 0, 0], ra: 0.03, rb: 0.01 };
    // The exact round cone touches each end sphere; the cheap approximation of
    // "axis distance minus interpolated radius" is visibly wrong here.
    expect(Math.abs(boneDistance(-0.03, 0, 0, taper))).toBeLessThan(1e-6);
    expect(Math.abs(boneDistance(0.11, 0, 0, taper))).toBeLessThan(1e-6);
  });

  it('falls back to a sphere when one end swallows the other', () => {
    const swallowed: Bone = { a: [0, 0, 0], b: [0.001, 0, 0], ra: 0.05, rb: 0.01 };
    expect(boneDistance(0.05, 0, 0, swallowed)).toBeCloseTo(0, 2);
    expect(Number.isNaN(boneDistance(0, 0, 0, swallowed))).toBe(false);
  });

  it('collapses to a sphere for a zero-length bone', () => {
    const point: Bone = { a: [0, 0, 0], b: [0, 0, 0], ra: 0.03, rb: 0.03 };
    expect(boneDistance(0.03, 0, 0, point)).toBeCloseTo(0, 6);
  });
});

describe('smoothUnion', () => {
  it('is a plain minimum with no blend', () => {
    expect(smoothUnion(0.3, 0.7, 0)).toBe(0.3);
  });

  it('dips below both inputs where they meet, which is the fillet', () => {
    expect(smoothUnion(0.1, 0.1, 0.1)).toBeLessThan(0.1);
  });

  it('leaves a distance far from the other shape alone', () => {
    expect(smoothUnion(0.02, 5, 0.05)).toBeCloseTo(0.02, 3);
  });
});

describe('surfaceNets', () => {
  it('extracts a closed sphere', () => {
    const extracted = surfaceNets(sphereField(0.1), {
      min: [-0.15, -0.15, -0.15],
      max: [0.15, 0.15, 0.15],
      resolution: 32,
    });
    const mesh = createSculptMesh(extracted.positions, extracted.faces);
    expect(mesh.vertexCount).toBeGreaterThan(500);
    expect(isWatertight(mesh)).toBe(true);
    // Genus zero: F = 2V - 4 for a closed triangulated surface.
    expect(mesh.faceCount).toBe(2 * mesh.vertexCount - 4);
  });

  it('puts the surface where the field says it is', () => {
    const extracted = surfaceNets(sphereField(0.1), {
      min: [-0.15, -0.15, -0.15],
      max: [0.15, 0.15, 0.15],
      resolution: 32,
    });
    let worst = 0;
    for (let i = 0; i < extracted.positions.length; i += 3) {
      const r = Math.hypot(extracted.positions[i], extracted.positions[i + 1], extracted.positions[i + 2]);
      worst = Math.max(worst, Math.abs(r - 0.1));
    }
    // Well inside one cell, which is 0.0094 here.
    expect(worst).toBeLessThan(0.002);
  });

  it('winds its triangles outward', () => {
    const extracted = surfaceNets(sphereField(0.1), {
      min: [-0.15, -0.15, -0.15],
      max: [0.15, 0.15, 0.15],
      resolution: 24,
    });
    const mesh = createSculptMesh(extracted.positions, extracted.faces);
    expect(outwardFraction(mesh)).toBe(1);
  });

  it('returns nothing when the field never crosses the level', () => {
    const extracted = surfaceNets(() => 1, { min: [-1, -1, -1], max: [1, 1, 1], resolution: 8 });
    expect(extracted.positions).toHaveLength(0);
    expect(extracted.faces).toHaveLength(0);
  });

  it('honours a non-zero iso level', () => {
    const extracted = surfaceNets(sphereField(0.1), {
      min: [-0.2, -0.2, -0.2],
      max: [0.2, 0.2, 0.2],
      resolution: 24,
      isoLevel: 0.05,
    });
    // Offsetting the level by 0.05 grows the sphere to radius 0.15.
    let sum = 0;
    let n = 0;
    for (let i = 0; i < extracted.positions.length; i += 3) {
      sum += Math.hypot(extracted.positions[i], extracted.positions[i + 1], extracted.positions[i + 2]);
      n++;
    }
    expect(sum / n).toBeCloseTo(0.15, 2);
  });

  it('keeps two nearly-touching spheres manifold', () => {
    // The case the textbook one-vertex-per-cell version cannot express: a cell
    // the surface passes through twice. It used to come out as an edge with
    // four triangles on it, which nothing downstream will accept.
    const gap = 0.004;
    const twin = (x: number, y: number, z: number) =>
      Math.min(Math.hypot(x - 0.05 - gap, y, z) - 0.05, Math.hypot(x + 0.05 + gap, y, z) - 0.05);

    const extracted = surfaceNets(twin, { min: [-0.15, -0.09, -0.09], max: [0.15, 0.09, 0.09], resolution: 40 });
    const mesh = createSculptMesh(extracted.positions, extracted.faces);
    const histogram = edgeHistogram(mesh);
    expect([...histogram.keys()]).toEqual([2]);
    expect(isWatertight(mesh)).toBe(true);
  });
});

describe('skeleton helpers', () => {
  it('pads its bounds so the surface never reaches them', () => {
    const bones = humanoidSkeleton();
    const blend = 0.012;
    const bounds = skeletonBounds(bones, blend);
    const field = skeletonField(bones, blend);

    // Every corner and face centre of the box is outside the shape.
    for (const [x, y, z] of [
      [bounds.min[0], 0, 0], [bounds.max[0], 0, 0],
      [0, bounds.min[1], 0], [0, bounds.max[1], 0],
      [0, 0, bounds.min[2]], [0, 0, bounds.max[2]],
    ]) {
      expect(field(x, y, z)).toBeGreaterThan(0);
    }
  });

  it('blends the skeleton rather than unioning it sharply', () => {
    const bones: Bone[] = [
      { a: [0, 0, 0], b: [0.05, 0, 0], ra: 0.01, rb: 0.01 },
      { a: [0, 0, 0], b: [0, 0.05, 0], ra: 0.01, rb: 0.01 },
    ];
    const sharp = skeletonField(bones, 0);
    const blended = skeletonField(bones, 0.01);
    // In the crook between the two limbs the blend fills material in, so the
    // distance there is smaller (more inside) than a plain union gives.
    expect(blended(0.012, 0.012, 0)).toBeLessThan(sharp(0.012, 0.012, 0));
  });
});

describe('primitive bases', () => {
  it('builds a closed cube with dead-straight edges', () => {
    const mesh = cubeBase(0.2, 6);
    expect(isWatertight(mesh)).toBe(true);
    expect(outwardFraction(mesh)).toBe(1);

    // Positions live in a Float32Array, so the tolerances here are float32's
    // limit rather than a statement about how square the cube is — a nanometre
    // on a 200 mm box.
    const bounds = meshBounds(mesh);
    for (let k = 0; k < 3; k++) {
      expect(bounds.min[k]).toBeCloseTo(-0.1, 7);
      expect(bounds.max[k]).toBeCloseTo(0.1, 7);
    }
    // Every vertex is on the surface of the box: one of its coordinates sits at
    // the extreme. A rounded-off cube would fail this.
    for (let i = 0; i < mesh.vertexCount; i++) {
      const onFace = [0, 1, 2].some((k) => Math.abs(Math.abs(mesh.positions[i * 3 + k]) - 0.1) < 1e-7);
      expect(onFace).toBe(true);
    }
  });

  it('welds the cube faces instead of leaving six loose sheets', () => {
    // Six unwelded 6x6 faces would be 6*49 = 294 vertices; welded is 218.
    const mesh = cubeBase(0.2, 6);
    expect(mesh.vertexCount).toBeLessThan(294);
    expect([...edgeHistogram(mesh).keys()]).toEqual([2]);
  });

  it('builds a closed cylinder with no fan at the cap centre', () => {
    const mesh = cylinderBase(0.05, 0.16, 24, 6, 4);
    expect(isWatertight(mesh)).toBe(true);
    expect(outwardFraction(mesh)).toBe(1);

    const bounds = meshBounds(mesh);
    expect(bounds.max[2]).toBeCloseTo(0.08, 7);
    expect(bounds.min[2]).toBeCloseTo(-0.08, 7);

    // The cap still closes with a fan at its centre — something has to — but it
    // spans only the innermost ring. What would be wrong is a fan from the rim:
    // every cap triangle a sliver as long as the radius, so a brush anywhere on
    // the face drags the whole cap. So the test is on triangle size, not on the
    // fan's existence: no edge may be longer than about one ring's width.
    const ringWidth = 0.05 / 4;
    let longest = 0;
    for (let f = 0; f < mesh.faceCount; f++) {
      for (let e = 0; e < 3; e++) {
        const a = mesh.faces[f * 3 + e];
        const b = mesh.faces[f * 3 + ((e + 1) % 3)];
        longest = Math.max(longest, Math.hypot(
          mesh.positions[a * 3] - mesh.positions[b * 3],
          mesh.positions[a * 3 + 1] - mesh.positions[b * 3 + 1],
          mesh.positions[a * 3 + 2] - mesh.positions[b * 3 + 2]
        ));
      }
    }
    // The wall's own segments are the longest thing here, not any cap sliver.
    expect(longest).toBeLessThan(Math.max(ringWidth, 0.16 / 6) * 1.5);
  });
});

describe('the base registry', () => {
  it('offers a base for every id it advertises', () => {
    for (const base of SCULPT_BASES) {
      expect(base.label.length).toBeGreaterThan(0);
      expect(base.description.length).toBeGreaterThan(0);
      expect(buildSculptBase(base.id).vertexCount).toBeGreaterThan(100);
    }
  });

  it('builds every base as a closed, outward-facing surface', () => {
    // The one property that decides whether a sculpt can be printed, machined
    // or booleaned at all — and the one that no amount of looking at the
    // viewport will tell you about.
    for (const base of SCULPT_BASES) {
      const mesh = buildSculptBase(base.id);
      expect([...edgeHistogram(mesh).keys()], base.id).toEqual([2]);
      expect(isWatertight(mesh), base.id).toBe(true);
    }
  });

  it('sizes every base the same, so swapping one does not rescale the object', () => {
    for (const base of SCULPT_BASES) {
      const bounds = meshBounds(buildSculptBase(base.id));
      const longest = Math.max(...[0, 1, 2].map((k) => bounds.max[k] - bounds.min[k]));
      expect(longest, base.id).toBeGreaterThan(BASE_SIZE * 0.7);
      expect(longest, base.id).toBeLessThanOrEqual(BASE_SIZE * 1.001);
    }
  });

  it('centres every base on the body origin', () => {
    for (const base of SCULPT_BASES) {
      const bounds = meshBounds(buildSculptBase(base.id));
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(bounds.min[k] + bounds.max[k]), `${base.id} axis ${k}`).toBeLessThan(BASE_SIZE * 0.02);
      }
    }
  });

  it('keeps every base coarse enough to sculpt on immediately', () => {
    // A base is scaffolding: the brush adds detail where you put it, so
    // starting dense only makes every stroke slower.
    for (const base of SCULPT_BASES) {
      expect(buildSculptBase(base.id).faceCount, base.id).toBeLessThan(12000);
    }
  });

  it('stands the humanoid up and lays the quadruped along its length', () => {
    const upright = meshBounds(buildSculptBase('humanoid'));
    expect(upright.max[2] - upright.min[2]).toBeGreaterThan(upright.max[0] - upright.min[0]);

    const onAllFours = meshBounds(buildSculptBase('quadruped'));
    expect(onAllFours.max[0] - onAllFours.min[0]).toBeGreaterThan(onAllFours.max[2] - onAllFours.min[2]);
  });

  it('gives the hand five digits', () => {
    // Four fingers plus a thumb, and the thumb out of the fingers' plane —
    // the detail that separates a hand from a mitten.
    const bones = handSkeleton();
    const tips = bones.filter((b) => b.rb < 0.008);
    expect(tips.length).toBeGreaterThanOrEqual(4);
    const thumb = bones.find((b) => b.a[0] < -0.04);
    expect(thumb).toBeDefined();
    expect(Math.abs(thumb!.b[2])).toBeGreaterThan(0.005);
  });

  it('falls back to the default for an id it does not know', () => {
    const unknown = buildSculptBase('nonsense' as never);
    const fallback = buildSculptBase(DEFAULT_SCULPT_BASE);
    expect(unknown.vertexCount).toBe(fallback.vertexCount);
  });
});

describe('STL export', () => {
  const geom = {
    name: 'g',
    renderVertices: [0, 0, 0, 0.001, 0, 0, 0, 0.001, 0],
    vertices: [0, 0, 0, 0.001, 0, 0, 0, 0, -0.001],
    faces: [0, 1, 2],
  };

  it('writes millimetres, because STL carries no units', () => {
    const [triangle] = meshGeomTriangles(geom);
    expect(triangle.b).toEqual([1, 0, 0]);
    expect(triangle.c).toEqual([0, 1, 0]);
  });

  it('exports the Z-up copy, not the renderer’s Y-up one', () => {
    // Exporting the Y-up array would lay every model on its side.
    const [fromZUp] = meshGeomTriangles(geom);
    const [fromYUp] = meshGeomTriangles({ ...geom, renderVertices: undefined });
    expect(fromZUp.c).toEqual([0, 1, 0]);
    expect(fromYUp.c).toEqual([0, 1, 0]);
  });

  it('writes a well-formed binary STL', () => {
    const stl = meshGeomToStl(geom);
    // 80-byte header, a 4-byte count, then 50 bytes per triangle.
    expect(stl.length).toBe(80 + 4 + 50);
    const view = new DataView(stl.buffer, stl.byteOffset, stl.byteLength);
    expect(view.getUint32(80, true)).toBe(1);
  });

  it('exports a whole base as one solid', () => {
    const mesh = buildSculptBase('sphere');
    const stl = meshGeomToStl({
      name: 'sphere',
      renderVertices: Array.from(mesh.positions.subarray(0, mesh.vertexCount * 3)),
      faces: Array.from(mesh.faces.subarray(0, mesh.faceCount * 3)),
    });
    expect(stl.length).toBe(84 + 50 * mesh.faceCount);
  });

  it('handles a geom with nothing in it', () => {
    expect(meshGeomTriangles({ faces: [] })).toHaveLength(0);
    expect(meshGeomTriangles({ renderVertices: [0, 0, 0] })).toHaveLength(0);
  });

  it('makes a filename a filesystem will take', () => {
    expect(stlFileName('Sculpt Body #3')).toBe('sculpt_body_3.stl');
    expect(stlFileName('///')).toBe('mesh.stl');
  });
});

describe('a figure is the same on both sides', () => {
  /*
   * `mirrored` used to flip X while every figure faces +X, so a limb written at
   * y = +0.026 was "paired" with a second one at y = +0.026 turned nose to tail.
   * The bird had two left wings and two left legs and nothing at all on its
   * right; the quadruped had four legs down one flank. Nobody could see it in
   * the picture — a bird with both wings folded on one side still reads as a
   * bird — but you cannot sculpt a matching pair of anything if there is no
   * surface on the far side to sculpt, which is where it finally showed up.
   *
   * Bases whose subject is genuinely one-sided are exempt: a hand has a thumb.
   */
  const LOPSIDED = new Set(['hand']);

  it.each(SCULPT_BASES.filter((b) => !LOPSIDED.has(b.id)).map((b) => b.id))('%s', (id) => {
    const mesh = buildSculptBase(id);
    recomputeNormals(mesh);

    // Every vertex, mirrored across y=0, should land on the surface. One grid
    // cell of slack (BASE_SIZE / 48), because surface nets place a vertex per
    // cell and the two sides land on different cells' worth of rounding.
    const tolerance = (BASE_SIZE / 48) * 1.2;
    let worst = 0;
    const step = Math.max(1, Math.floor(mesh.vertexCount / 250));
    for (let i = 0; i < mesh.vertexCount; i += step) {
      const mirror = [mesh.positions[i * 3], -mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
      const found = nearestSurfacePoint(mesh, mirror);
      worst = Math.max(worst, found?.distance ?? Infinity);
    }
    expect(worst).toBeLessThan(tolerance);
  });
});
