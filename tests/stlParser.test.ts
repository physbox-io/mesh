import { describe, it, expect } from 'vitest';
import { parseSTL } from '../src/utils/stlParser';

type Tri = [number[], number[], number[]];

/** Binary STL from a triangle soup — the format parseSTL is normally fed. */
function writeBinarySTL(tris: Tri[]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const view = new DataView(buf);
  view.setUint32(80, tris.length, true);
  let off = 84;
  for (const [a, b, c] of tris) {
    // Normals are ignored by the loader; winding carries the orientation.
    for (let i = 0; i < 3; i++) view.setFloat32(off + i * 4, 0, true);
    off += 12;
    for (const v of [a, b, c]) {
      for (let i = 0; i < 3; i++) view.setFloat32(off + i * 4, v[i], true);
      off += 12;
    }
    view.setUint16(off, 0, true);
    off += 2;
  }
  return buf;
}

function quad(a: number[], b: number[], c: number[], d: number[]): Tri[] {
  return [[a, b, c], [a, c, d]];
}

function boxTris(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): Tri[] {
  const x0 = cx - sx / 2, x1 = cx + sx / 2;
  const y0 = cy - sy / 2, y1 = cy + sy / 2;
  const z0 = cz - sz / 2, z1 = cz + sz / 2;
  const p = (x: number, y: number, z: number) => [x, y, z];
  return [
    ...quad(p(x0, y0, z0), p(x1, y0, z0), p(x1, y1, z0), p(x0, y1, z0)),
    ...quad(p(x0, y0, z1), p(x0, y1, z1), p(x1, y1, z1), p(x1, y0, z1)),
    ...quad(p(x0, y0, z0), p(x0, y0, z1), p(x1, y0, z1), p(x1, y0, z0)),
    ...quad(p(x0, y1, z0), p(x1, y1, z0), p(x1, y1, z1), p(x0, y1, z1)),
    ...quad(p(x0, y0, z0), p(x0, y1, z0), p(x0, y1, z1), p(x0, y0, z1)),
    ...quad(p(x1, y0, z0), p(x1, y0, z1), p(x1, y1, z1), p(x1, y1, z0)),
  ];
}

/** Cylinder along `axis`, centred at the origin. */
function cylinderTris(radius: number, height: number, axis: 0 | 1 | 2, segments = 48): Tri[] {
  const put = (r: number, ang: number, along: number) => {
    const v = [0, 0, 0];
    const perp = axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
    v[axis] = along;
    v[perp[0]] = r * Math.cos(ang);
    v[perp[1]] = r * Math.sin(ang);
    return v;
  };
  const h = height / 2;
  const tris: Tri[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    tris.push(...quad(put(radius, a0, -h), put(radius, a1, -h), put(radius, a1, h), put(radius, a0, h)));
    // Caps, fanned from a centre vertex on each end.
    tris.push([put(0, 0, -h), put(radius, a1, -h), put(radius, a0, -h)]);
    tris.push([put(0, 0, h), put(radius, a0, h), put(radius, a1, h)]);
  }
  return tris;
}

/** Tube: a Z-aligned cylinder with a coaxial through-bore. */
function tubeTris(outer: number, inner: number, height: number, segments = 48): Tri[] {
  const put = (r: number, ang: number, z: number) => [r * Math.cos(ang), r * Math.sin(ang), z];
  const h = height / 2;
  const tris: Tri[] = [];
  for (let i = 0; i < segments; i++) {
    const a0 = (i / segments) * Math.PI * 2;
    const a1 = ((i + 1) / segments) * Math.PI * 2;
    tris.push(...quad(put(outer, a0, -h), put(outer, a1, -h), put(outer, a1, h), put(outer, a0, h)));
    tris.push(...quad(put(inner, a0, -h), put(inner, a0, h), put(inner, a1, h), put(inner, a1, -h)));
    // Annular end faces, wound so their normals face out of each end.
    tris.push(...quad(put(inner, a0, h), put(outer, a0, h), put(outer, a1, h), put(inner, a1, h)));
    tris.push(...quad(put(inner, a0, -h), put(inner, a1, -h), put(outer, a1, -h), put(outer, a0, -h)));
  }
  return tris;
}

/**
 * Rectangular plate with one circular through-hole at (hx, hy).
 *
 * The faces are triangulated by fanning rays out from the hole centre to the
 * plate outline — the same "boundary loop plus interior triangulation" a CAD
 * exporter produces, which is what the hole detector has to see through.
 */
function plateWithHoleTris(sx: number, sy: number, sz: number, r: number, hx: number, hy: number, segments = 64): Tri[] {
  const a = sx / 2, b = sy / 2, h = sz / 2;
  const angles = new Set<number>();
  for (let i = 0; i < segments; i++) angles.add((i / segments) * Math.PI * 2);
  // Include the corner directions so the fan reproduces the rectangle exactly.
  for (const [cx, cy] of [[a, b], [-a, b], [-a, -b], [a, -b]]) {
    const t = Math.atan2(cy - hy, cx - hx);
    angles.add(t < 0 ? t + Math.PI * 2 : t);
  }
  const sorted = [...angles].sort((p, q) => p - q);

  const outline = sorted.map(t => {
    const c = Math.cos(t), s = Math.sin(t);
    const dists = [
      c > 1e-12 ? (a - hx) / c : Infinity,
      c < -1e-12 ? (-a - hx) / c : Infinity,
      s > 1e-12 ? (b - hy) / s : Infinity,
      s < -1e-12 ? (-b - hy) / s : Infinity,
    ];
    const d = Math.min(...dists);
    return [hx + d * c, hy + d * s];
  });
  const rim = sorted.map(t => [hx + r * Math.cos(t), hy + r * Math.sin(t)]);
  const at = (p: number[], z: number) => [p[0], p[1], z];

  const tris: Tri[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const j = (i + 1) % sorted.length;
    tris.push(...quad(at(rim[i], h), at(outline[i], h), at(outline[j], h), at(rim[j], h)));
    tris.push(...quad(at(rim[i], -h), at(rim[j], -h), at(outline[j], -h), at(outline[i], -h)));
    tris.push(...quad(at(outline[i], -h), at(outline[j], -h), at(outline[j], h), at(outline[i], h)));
    tris.push(...quad(at(rim[i], -h), at(rim[i], h), at(rim[j], h), at(rim[j], -h)));
  }
  return tris;
}

function sphereTris(radius: number, rings = 24, segments = 32): Tri[] {
  const put = (i: number, j: number) => {
    const phi = (i / rings) * Math.PI;
    const theta = (j / segments) * Math.PI * 2;
    return [
      radius * Math.sin(phi) * Math.cos(theta),
      radius * Math.sin(phi) * Math.sin(theta),
      radius * Math.cos(phi),
    ];
  };
  const tris: Tri[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      tris.push(...quad(put(i, j), put(i + 1, j), put(i + 1, j + 1), put(i, j + 1)));
    }
  }
  return tris;
}

const parse = (tris: Tri[], name = 'part') => parseSTL(writeBinarySTL(tris), { name });

describe('parseSTL geometry', () => {
  it('keeps renderVertices Z-up and vertices Y-up', () => {
    const r = parse(boxTris(0, 0, 0, 0.2, 0.1, 0.05));
    // Z-up bounds match the authored STL exactly.
    expect(r.boundingBox.size.map(v => +v.toFixed(4))).toEqual([0.2, 0.1, 0.05]);
    for (let i = 0; i < r.renderVertices.length; i += 3) {
      expect(r.vertices[i]).toBeCloseTo(r.renderVertices[i], 6);
      expect(r.vertices[i + 1]).toBeCloseTo(r.renderVertices[i + 2], 6);
      expect(r.vertices[i + 2]).toBeCloseTo(-r.renderVertices[i + 1], 6);
    }
  });

  it('emits polyhedron faces in OpenSCAD winding (reversed from STL)', () => {
    const r = parse(boxTris(0, 0, 0, 0.2, 0.1, 0.05));
    const first = r.scadRaw.match(/faces = \[\s*\[(\d+), (\d+), (\d+)\]/);
    expect(first).toBeTruthy();
    expect(first!.slice(1, 4).map(Number)).toEqual([r.faces[2], r.faces[1], r.faces[0]]);
  });

  it('auto-scales millimetre-sized models to metres', () => {
    const r = parse(boxTris(0, 0, 0, 100, 50, 20));
    expect(r.appliedScale).toEqual([0.001, 0.001, 0.001]);
    expect(r.boundingBox.size[0]).toBeCloseTo(0.1, 5);
  });
});

describe('parseSTL primitive inference', () => {
  it('recognises a box', () => {
    const r = parse(boxTris(0, 0, 0, 0.2, 0.1, 0.05));
    expect(r.subComponents).toHaveLength(1);
    expect(r.subComponents[0].fit).toMatchObject({ kind: 'box', exact: true });
    expect(r.scadCsg).toContain('cube([size_x, size_y, size_z], center = true);');
    expect(r.primitiveGeom.type).toBe('box');
    expect(r.primitiveGeom.size.map(v => +v.toFixed(5))).toEqual([0.1, 0.05, 0.025]);
  });

  it('recognises a sphere', () => {
    const r = parse(sphereTris(0.08));
    expect(r.subComponents[0].fit).toMatchObject({ kind: 'sphere', exact: true });
    expect(r.primitiveGeom.type).toBe('sphere');
    expect(r.scadCsg).toContain('sphere(d = diameter');
  });

  it('recognises a Z-aligned cylinder', () => {
    const r = parse(cylinderTris(0.05, 0.2, 2));
    const fit = r.subComponents[0].fit;
    expect(fit).toMatchObject({ kind: 'cylinder', axis: 2, exact: true });
    expect(r.primitiveGeom.type).toBe('cylinder');
    expect(r.scadCsg).not.toContain('rotate');
  });

  it('recognises a cylinder lying along X and rotates it in the CSG', () => {
    const r = parse(cylinderTris(0.05, 0.2, 0));
    const fit = r.subComponents[0].fit;
    expect(fit).toMatchObject({ kind: 'cylinder', axis: 0, exact: true });
    expect(r.scadCsg).toContain('rotate([0, 90, 0]) cylinder(');
    // A sideways cylinder can't be a MuJoCo cylinder geom, so it falls back to a box.
    expect(r.primitiveGeom.type).toBe('box');
  });

  it('recognises a through-bore and emits a difference()', () => {
    const r = parse(tubeTris(0.05, 0.02, 0.1));
    const c = r.subComponents[0];
    expect(c.fit).toMatchObject({ kind: 'cylinder', axis: 2 });
    expect(c.holes).toHaveLength(1);
    expect(c.holes[0].radius).toBeCloseTo(0.02, 3);
    expect(c.holes[0].depth).toBeCloseTo(0.1, 5);
    expect(r.scadCsg).toContain('difference()');
    expect(r.scadCsg).toContain('hole_d = 0.04;');
    expect(r.shapeSummary).toMatch(/1 through-hole Ø40.0mm/);
  });

  it('recognises a drilled plate and places the hole in the CSG', () => {
    const r = parse(plateWithHoleTris(0.1, 0.06, 0.008, 0.005, 0.02, -0.01), 'plate');
    const c = r.subComponents[0];
    expect(c.fit).toMatchObject({ kind: 'box', exact: true });
    expect(c.holes).toHaveLength(1);
    expect(c.holes[0].axis).toBe(2);
    expect(c.holes[0].center[0]).toBeCloseTo(0.02, 4);
    expect(c.holes[0].center[1]).toBeCloseTo(-0.01, 4);
    expect(c.holes[0].radius).toBeCloseTo(0.005, 4);
    // Hole offsets are relative to the primitive's centre, which is the origin here.
    expect(r.scadCsg).toMatch(/for \(p = \[\[0\.02, -0\.01\]\]\)/);
    expect(r.scadCsg).toContain('translate([p[0], p[1], 0])');
    expect(r.shapeSummary).toMatch(/box 100\.0mm × 60\.0mm × 8\.0mm with 1 through-hole Ø10\.0mm/);
  });

  it('does not invent holes in a solid part', () => {
    expect(parse(boxTris(0, 0, 0, 0.2, 0.1, 0.05)).subComponents[0].holes).toHaveLength(0);
    expect(parse(cylinderTris(0.05, 0.2, 2)).subComponents[0].holes).toHaveLength(0);
  });

  it('keeps the real geometry when no primitive fits, rather than faking a box', () => {
    // A wedge fills exactly half its bounding box, so no primitive explains it.
    const p = (x: number, y: number, z: number) => [x, y, z];
    const wedge: Tri[] = [
      [p(0, 0, 0), p(0.1, 0, 0), p(0, 0, 0.1)],
      [p(0, 0.1, 0), p(0, 0.1, 0.1), p(0.1, 0.1, 0)],
      ...quad(p(0, 0, 0), p(0, 0.1, 0), p(0.1, 0.1, 0), p(0.1, 0, 0)),
      ...quad(p(0, 0, 0), p(0, 0, 0.1), p(0, 0.1, 0.1), p(0, 0.1, 0)),
      ...quad(p(0.1, 0, 0), p(0.1, 0.1, 0), p(0, 0.1, 0.1), p(0, 0, 0.1)),
    ];
    const r = parse(wedge);
    expect(r.subComponents[0].fit.exact).toBe(false);
    expect(r.shapeSummary).toContain('kept as an exact mesh');
    // The CSG program must be the wedge itself, not a cube covering its bounds.
    expect(r.scadCsg).not.toContain('cube(');
    expect(r.scadCsg).toContain('polyhedron(');
    const faceBlock = r.scadCsg.slice(r.scadCsg.indexOf('faces = ['));
    const emittedTris = (faceBlock.match(/\[\d+, \d+, \d+\]/g) || []).length;
    expect(emittedTris).toBe(r.faces.length / 3);
  });
});

describe('parseSTL array inference', () => {
  it('detects an evenly spaced run along Y and parameterises count and spacing', () => {
    const tris = [0, 1, 2, 3].flatMap(i => boxTris(0, i * 0.05, 0, 0.02, 0.02, 0.02));
    const r = parse(tris, 'comb');
    expect(r.subComponents).toHaveLength(4);
    expect(r.inferredSpacing!.axis).toBe('y');
    expect(r.inferredSpacing!.count).toBe(4);
    expect(r.inferredSpacing!.delta).toBeCloseTo(0.05, 6);
    expect(r.scadCsg).toContain('element_count = 4;');
    expect(r.scadCsg).toContain('spacing = 0.05;');
    expect(r.scadCsg).toContain('translate([0, i * spacing, 0]) element();');
    // The parametric mesh repeats ONE element, not the whole model.
    expect(r.scadParametric).toContain('module element()');
    const points = r.scadParametric.match(/\[[-\d.]+, [-\d.]+, [-\d.]+\]/g) || [];
    expect(points.length).toBeLessThan(r.renderVertices.length / 3);
  });

  it('ignores a scattered layout', () => {
    const tris = [
      ...boxTris(0, 0, 0, 0.02, 0.02, 0.02),
      ...boxTris(0.05, 0.03, 0, 0.02, 0.02, 0.02),
      ...boxTris(0.2, 0, 0, 0.02, 0.02, 0.02),
    ];
    expect(parse(tris).inferredSpacing).toBeUndefined();
  });

  it('unions distinct parts with their own parameters', () => {
    const tris = [...boxTris(0, 0, 0, 0.1, 0.1, 0.1), ...cylinderTris(0.02, 0.3, 2).map(t =>
      t.map(v => [v[0] + 0.4, v[1], v[2]]) as Tri)];
    const r = parse(tris);
    expect(r.subComponents).toHaveLength(2);
    expect(r.scadCsg).toContain('union()');
    expect(r.scadCsg).toContain('p0_size_x');
    expect(r.scadCsg).toContain('p1_diameter');
  });
});
