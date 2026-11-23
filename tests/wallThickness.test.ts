import { describe, expect, it } from 'vitest';
import { wallThicknessAt } from '../src/utils/wallThickness';
import { wallAtImpact } from '../src/store/breakage';
import { shatterFloor, shatterLimit, shatterVerdict, WALL_SCALE_MAX, WALL_SCALE_MIN } from '../src/utils/breakThresholds';
import type { SceneGeom, SceneNode } from '../src/types/scene';

/** An axis-aligned box of half-size h, outward-wound unless `inward`. */
function box(h: number, inward = false, base = 0): { verts: number[]; faces: number[] } {
  const verts: number[] = [];
  for (let i = 0; i < 8; i++) verts.push(i & 1 ? h : -h, i & 2 ? h : -h, i & 4 ? h : -h);
  // Outward-wound quads (counter-clockwise seen from outside).
  const quads = [
    [0, 2, 3, 1], [4, 5, 7, 6], // -z, +z
    [0, 1, 5, 4], [2, 6, 7, 3], // -y, +y
    [0, 4, 6, 2], [1, 3, 7, 5], // -x, +x
  ];
  const faces: number[] = [];
  for (const [a, b, c, d] of quads) {
    const tri = [[a, b, c], [a, c, d]];
    for (const t of tri) {
      const [p, q, r] = inward ? [t[0], t[2], t[1]] : t;
      faces.push(p + base, q + base, r + base);
    }
  }
  return { verts, faces };
}

/** A closed hollow box: 100 mm outside, `wall` thick. */
function hollowBox(wall: number) {
  const outer = box(0.05);
  const inner = box(0.05 - wall, true, 8);
  return { verts: [...outer.verts, ...inner.verts], faces: [...outer.faces, ...inner.faces] };
}

describe('wallThicknessAt', () => {
  it('measures a solid body straight across', () => {
    const { verts, faces } = box(0.05);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.05])).toBeCloseTo(0.1, 6);
  });

  it('measures only the wall of a hollow body', () => {
    const { verts, faces } = hollowBox(0.004);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.05])).toBeCloseTo(0.004, 6);
    // Struck from inside the cavity, it is still the same wall.
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.046])).toBeCloseTo(0.004, 6);
  });

  it('does not care which side of the surface the contact point sits on', () => {
    const { verts, faces } = hollowBox(0.004);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.0505])).toBeCloseTo(0.004, 6);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.0497])).toBeCloseTo(0.004, 6);
  });

  it('copes with an inside-out mesh', () => {
    const { verts, faces } = box(0.05, true);
    expect(wallThicknessAt(verts, faces, [0.0101, 0.0203, 0.05])).toBeCloseTo(0.1, 6);
  });

  it('gives up on a mesh with no inside', () => {
    expect(wallThicknessAt([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2], [0.1, 0.1, 0])).toBeNull();
    expect(wallThicknessAt([], [], [0, 0, 0])).toBeNull();
  });

  it('guards NaN coordinates, NaN point, and out-of-bounds face indices', () => {
    const { verts, faces } = box(0.05);
    expect(wallThicknessAt(verts, faces, [NaN, 0, 0.05])).toBeNull();
    const nanVerts = [...verts];
    nanVerts[0] = NaN;
    expect(wallThicknessAt(nanVerts, faces, [0, 0, 0.05])).toBeNull();
    const oobFaces = [...faces, 0, 1, 99];
    expect(wallThicknessAt(verts, oobFaces, [0, 0, 0.05])).toBeNull();
    const negFaces = [...faces];
    negFaces[0] = -1;
    expect(wallThicknessAt(verts, negFaces, [0, 0, 0.05])).toBeNull();
  });

  it('rejects an open hemisphere bowl sheet instead of measuring bowl diameter', () => {
    // Open upper hemisphere of radius 0.05 m (single sheet, no thickness, open equator rim).
    const r = 0.05, segs = 24, rings = 8;
    const verts: number[] = [];
    const faces: number[] = [];
    for (let i = 0; i <= rings; i++) {
      const phi = (Math.PI / 2) * (i / rings); // 0 at pole to pi/2 at equator
      const z = r * Math.cos(phi) + 0.02; // shifted off origin so raw signedVol is non-zero
      const rr = r * Math.sin(phi);
      for (let j = 0; j < segs; j++) {
        const theta = (2 * Math.PI * j) / segs;
        verts.push(rr * Math.cos(theta), rr * Math.sin(theta), z);
      }
    }
    for (let i = 0; i < rings; i++) {
      for (let j = 0; j < segs; j++) {
        const jn = (j + 1) % segs;
        const a = i * segs + j, b = i * segs + jn;
        const c = (i + 1) * segs + jn, d = (i + 1) * segs + j;
        faces.push(a, d, c, a, c, b);
      }
    }
    expect(wallThicknessAt(verts, faces, [0.05, 0, 0.025])).toBeNull();
  });

  it('measures real thickness on sharp 90° edges, corners, 45° chamfers, and acute crests', () => {
    const solid = box(0.05);
    // Sharp 90° edge (+x/+z) and sharp 90° corner (+x/+y/+z): must shoot inward along bisector, not graze microns away.
    const edgeT = wallThicknessAt(solid.verts, solid.faces, [0.051, 0, 0.051]);
    expect(edgeT).not.toBeNull();
    expect(edgeT!).toBeCloseTo(0.1 * Math.SQRT2, 4);

    const cornerT = wallThicknessAt(solid.verts, solid.faces, [0.051, 0.051, 0.051]);
    expect(cornerT).not.toBeNull();
    expect(cornerT!).toBeCloseTo(0.1 * Math.sqrt(3), 4);

    // 45° chamfered prism along Y: cross-section is 0.10 x 0.10 m square with a 5 mm 45° bevel on (+x, +z).
    const poly: [number, number][] = [
      [-0.05, -0.05], [0.05, -0.05], [0.05, 0.045], [0.045, 0.05], [-0.05, 0.05],
    ];
    const verts: number[] = [];
    const faces: number[] = [];
    const n = poly.length;
    for (const [x, z] of poly) verts.push(x, -0.05, z);
    for (const [x, z] of poly) verts.push(x, 0.05, z);
    // End caps (-y and +y)
    for (let i = 1; i + 1 < n; i++) {
      faces.push(0, i, i + 1); // -y outward (-y normal)
      faces.push(n, n + i + 1, n + i); // +y outward (+y normal)
    }
    // Side quads
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push(i, j, n + j, i, n + j, n + i);
    }
    // Strike just outside the chamfer-to-side edge (0.05, 0, 0.045) and chamfer-to-top edge (0.045, 0, 0.05):
    const chamferSide = wallThicknessAt(verts, faces, [0.051, 0, 0.0455]);
    expect(chamferSide).not.toBeNull();
    expect(chamferSide!).toBeGreaterThan(0.09);
    const chamferTop = wallThicknessAt(verts, faces, [0.0455, 0, 0.051]);
    expect(chamferTop).not.toBeNull();
    expect(chamferTop!).toBeGreaterThan(0.09);

    // Acute 60° triangular wedge (like a screw thread crest at (0, 0, 0.02)):
    const triPoly: [number, number][] = [[-0.0115, 0], [0.0115, 0], [0, 0.02]];
    const wVerts: number[] = [];
    const wFaces: number[] = [];
    for (const [x, z] of triPoly) wVerts.push(x, -0.05, z);
    for (const [x, z] of triPoly) wVerts.push(x, 0.05, z);
    wFaces.push(0, 1, 2, 3, 5, 4);
    for (let i = 0; i < 3; i++) {
      const j = (i + 1) % 3;
      wFaces.push(i, j, 3 + j, i, 3 + j, 3 + i);
    }
    const crestT = wallThicknessAt(wVerts, wFaces, [0, 0, 0.021]);
    expect(crestT).not.toBeNull();
    expect(crestT!).toBeCloseTo(0.02, 4);
  });

  it('works identically in millimetres and metres (scale-relative EPS)', () => {
    const inMetres = hollowBox(0.004);
    const inMm = { verts: inMetres.verts.map((v) => v * 1000), faces: inMetres.faces };
    const tm = wallThicknessAt(inMetres.verts, inMetres.faces, [0.0101, 0.0203, 0.05]);
    const tmm = wallThicknessAt(inMm.verts, inMm.faces, [10.1, 20.3, 50]);
    expect(tm).toBeCloseTo(0.004, 6);
    expect(tmm).toBeCloseTo(4.0, 3);
  });
});

describe('wallAtImpact', () => {
  /** Rectangular box in Z-up, optionally converted to Three.js Y-up `(x, z, -y)`. */
  function rectBox(hx: number, hy: number, hz: number, yup = false): { verts: number[]; faces: number[] } {
    const verts: number[] = [];
    for (let i = 0; i < 8; i++) {
      const x = i & 1 ? hx : -hx, y = i & 2 ? hy : -hy, z = i & 4 ? hz : -hz;
      // Z-up (x, y, z) corresponds to Three.js Y-up (x, z, -y) since yupToZup(x, y', z') = (x, -z', y').
      if (yup) verts.push(x, z, -y);
      else verts.push(x, y, z);
    }
    const quads = [
      [0, 2, 3, 1], [4, 5, 7, 6],
      [0, 1, 5, 4], [2, 6, 7, 3],
      [0, 4, 6, 2], [1, 3, 7, 5],
    ];
    const faces: number[] = [];
    for (const [a, b, c, d] of quads) faces.push(a, b, c, a, c, d);
    return { verts, faces };
  }

  it('converts Y-up vertices to Z-up when renderVertices is absent and honours geom pos/quat/euler', () => {
    // Thin plate in Z (100 x 100 x 6 mm) stored ONLY as Three.js Y-up `vertices`,
    // placed at geom.pos = [0, 0, 0.2] and rotated 90° around X so its thin axis becomes Y!
    const plateYup = rectBox(0.05, 0.05, 0.003, true);
    const geom = {
      name: 'plate',
      type: 'mesh',
      size: [1],
      vertices: plateYup.verts,
      faces: plateYup.faces,
      pos: [0, 0, 0.2],
      // +90° about X: geom local Z -> body -Y, so thin axis is along body Y (thickness 0.006 m).
      quat: [Math.SQRT1_2, Math.SQRT1_2, 0, 0],
    } as unknown as SceneGeom;
    const node = { id: 'p', name: 'p', type: 'body', pos: [0, 0, 0], geoms: [geom], joints: [], children: [] } as unknown as SceneNode;

    // Hit on the thin face (+Y side at [0.01, 0.003, 0.205]): thickness must be 0.006 m, not 0.10 m!
    expect(wallAtImpact(node, [0.01, 0.003, 0.205])).toBeCloseTo(0.006, 5);
    // Hit on the wide edge (+Z side at [0.01, 0, 0.25]): thickness across plate width is 0.10 m.
    expect(wallAtImpact(node, [0.01, 0, 0.25])).toBeCloseTo(0.10, 5);

    // Also verify euler rotation (90° around Y: local Z -> body +X, so thin axis is along body X):
    const geomEuler = {
      name: 'plateEuler',
      type: 'mesh',
      size: [1],
      vertices: plateYup.verts,
      faces: plateYup.faces,
      pos: [0.3, 0, 0],
      euler: [0, 90, 0],
    } as unknown as SceneGeom;
    const nodeEuler = { id: 'pe', name: 'pe', type: 'body', pos: [0, 0, 0], geoms: [geomEuler], joints: [], children: [] } as unknown as SceneNode;
    expect(wallAtImpact(nodeEuler, [0.303, 0.01, 0.01])).toBeCloseTo(0.006, 5);
  });

  it('picks the closest solid mesh geom on a multi-geom body instead of blindly the first', () => {
    const thickBase = rectBox(0.05, 0.05, 0.02); // 40 mm thick in Z
    const thinRim = rectBox(0.05, 0.05, 0.002);  // 4 mm thick in Z
    const node = {
      id: 'multi',
      name: 'multi',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        { name: 'base', type: 'mesh', size: [1], renderVertices: thickBase.verts, faces: thickBase.faces, pos: [0, 0, 0] },
        { name: 'rim', type: 'mesh', size: [1], renderVertices: thinRim.verts, faces: thinRim.faces, pos: [0, 0, 0.1] },
      ],
      joints: [],
      children: [],
    } as unknown as SceneNode;

    // Impact on the 2nd geom (`rim` at z = 0.102) must report 4 mm, not the 1st geom's 40 mm!
    expect(wallAtImpact(node, [0.01, 0.01, 0.102])).toBeCloseTo(0.004, 5);
    // Impact on the 1st geom (`base` at z = 0.02) reports 40 mm.
    expect(wallAtImpact(node, [0.01, 0.01, 0.02])).toBeCloseTo(0.04, 5);
  });
});

describe('shatterLimit', () => {
  const cfg = { shatterImpulseNs: 2, shatterThicknessRef: 0.006 };

  it('scales with the wall where the blow landed', () => {
    expect(shatterLimit(cfg, 0.006)).toBeCloseTo(2);
    expect(shatterLimit(cfg, 0.003)).toBeCloseTo(1);
    expect(shatterLimit(cfg, 0.012)).toBeCloseTo(4);
  });

  it('is capped both ways', () => {
    expect(shatterLimit(cfg, 0.0001)).toBeCloseTo(2 * WALL_SCALE_MIN);
    expect(shatterLimit(cfg, 1)).toBeCloseTo(2 * WALL_SCALE_MAX);
  });

  it('ignores thickness when there is no rating or no measurement', () => {
    expect(shatterLimit({ shatterImpulseNs: 2 }, 0.001)).toBe(2);
    expect(shatterLimit(cfg, null)).toBe(2);
  });

  it('a wine glass breaks on the bowl from a blow its foot shrugs off', () => {
    expect(shatterVerdict(1.2, cfg, 0.002)).toBe(true);
    expect(shatterVerdict(1.2, cfg, 0.02)).toBe(false);
  });

  it('the worker watches for the weakest wall there could be', () => {
    expect(shatterFloor(cfg)).toBeCloseTo(2 * WALL_SCALE_MIN);
    expect(shatterFloor({ shatterImpulseNs: 2 })).toBe(2);
  });
});
