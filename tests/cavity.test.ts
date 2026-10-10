import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { measureCavity, measureBodyCavity, type PortAxis } from '../src/utils/cavity';
import { cavityChannels, readCavityOutputs } from '../src/utils/coSimLink';
import { buildVoltCavityUrl } from '../src/utils/voltHandoff';
import type { SceneNode } from '../src/types/scene';

/**
 * "Measure cavity" against boxes whose air is known exactly: sealed hollow
 * boxes and prisms (the inward shell), and boxes with a bore through one wall
 * (the cavity behind a named port, and the port's length and radius) — each
 * over several sizes, and moved and turned, since the answer must not depend
 * on where the body sits.
 */

type V = [number, number, number];

/** A triangle soup with shared corners, each triangle wound to face `normal`. */
class Builder {
  points: number[] = [];
  faces: number[] = [];
  private index = new Map<string, number>();
  private at(p: V): number {
    const key = p.map(c => c.toFixed(12)).join(',');
    let i = this.index.get(key);
    if (i === undefined) {
      i = this.points.length / 3;
      this.points.push(...p);
      this.index.set(key, i);
    }
    return i;
  }
  tri(a: V, b: V, c: V, normal: V) {
    const n = new THREE.Vector3(...b).sub(new THREE.Vector3(...a)).cross(new THREE.Vector3(...c).sub(new THREE.Vector3(...a)));
    const [i, j, k] = [this.at(a), this.at(b), this.at(c)];
    if (n.dot(new THREE.Vector3(...normal)) >= 0) this.faces.push(i, j, k);
    else this.faces.push(i, k, j);
  }
  quad(a: V, b: V, c: V, d: V, normal: V) {
    this.tri(a, b, c, normal);
    this.tri(a, c, d, normal);
  }
}

/**
 * The six faces of a cube of half-size h about the origin, facing out (or in,
 * for a cavity's walls), except +x when `skipPlusX`: that wall is drawn with
 * its bore by `holedWall`.
 */
function cube(b: Builder, h: number, inward: boolean, skipPlusX = false) {
  const s = inward ? -1 : 1;
  for (let axis = 0; axis < 3; axis++) for (const side of [-1, 1]) {
    if (skipPlusX && axis === 0 && side === 1) continue;
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const corner = (cu: number, cv: number): V => {
      const p: V = [0, 0, 0];
      p[axis] = side * h; p[u] = cu * h; p[v] = cv * h;
      return p;
    };
    const normal: V = [0, 0, 0];
    normal[axis] = side * s;
    b.quad(corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1), normal);
  }
}

/** The bore's polygon in the y-z plane, at x, offset so no edge's middle sits on a diagonal. */
const ring = (x: number, r: number, n: number): V[] =>
  Array.from({ length: n }, (_, i) => {
    const th = ((i + 0.25) / n) * 2 * Math.PI;
    return [x, r * Math.cos(th), r * Math.sin(th)] as V;
  });

/**
 * The +x wall of a cube of half-size h with a centred n-gon hole of radius r:
 * each polygon edge fanned to the square corner nearest it, and a triangle to
 * each square side where the nearest corner changes. Only the corners on the
 * square's edges, so the wall meets its neighbours edge for edge.
 */
function holedWall(b: Builder, h: number, r: number, n: number, normal: V) {
  const poly = ring(h, r, n);
  const corners: V[] = [[h, h, h], [h, -h, h], [h, -h, -h], [h, h, -h]].map(c => c as V);
  const nearest = (p: V, q: V) => {
    const my = (p[1] + q[1]) / 2, mz = (p[2] + q[2]) / 2;
    let best = 0, d = Infinity;
    corners.forEach((c, k) => {
      const dd = (c[1] - my) ** 2 + (c[2] - mz) ** 2;
      if (dd < d) { d = dd; best = k; }
    });
    return best;
  };
  const ks = poly.map((p, i) => nearest(p, poly[(i + 1) % n]));
  for (let i = 0; i < n; i++) {
    const p = poly[i], q = poly[(i + 1) % n];
    b.tri(p, q, corners[ks[i]], normal);
    const prev = ks[(i + n - 1) % n];
    if (prev !== ks[i]) b.tri(p, corners[prev], corners[ks[i]], normal);
  }
}

/** A closed box of outer half-size a and walls t thick, with an n-gon bore of radius r through +x. */
function portedBox(a: number, t: number, r: number, n: number): Builder {
  const b = new Builder();
  const h = a - t;
  cube(b, a, false, true);
  holedWall(b, a, r, n, [1, 0, 0]);
  cube(b, h, true, true);
  holedWall(b, h, r, n, [-1, 0, 0]);
  const outer = ring(a, r, n), inner = ring(h, r, n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const mid = (outer[i][1] + outer[j][1]) / 2, midz = (outer[i][2] + outer[j][2]) / 2;
    // The bore faces its own axis: out of the material, into the hole.
    b.quad(inner[i], inner[j], outer[j], outer[i], [0, -mid, -midz]);
  }
  return b;
}

/** A rigid motion applied to a mesh and to a port axis alike. */
function moved(points: number[], port: PortAxis | null, euler: V, offset: V) {
  const m = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...euler)).setPosition(...offset);
  const out: number[] = [];
  const p = new THREE.Vector3();
  for (let i = 0; i < points.length; i += 3) out.push(...p.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(m).toArray());
  const turned = port && {
    origin: new THREE.Vector3(...port.origin).applyMatrix4(m).toArray(),
    axis: new THREE.Vector3(...port.axis).transformDirection(m).toArray(),
    radius: port.radius,
  };
  return { points: out, port: turned };
}

const POSES: [V, V][] = [
  [[0, 0, 0], [0, 0, 0]],
  [[0.3, -1.1, 2.0], [0.5, -0.2, 1.7]],
  [[Math.PI / 2, 0, Math.PI / 4], [-3, 4, 0.01]],
];

const report: string[] = [];

describe('a sealed box', () => {
  for (const [a, t] of [[0.06, 0.006], [0.1, 0.012], [0.2, 0.018], [0.025, 0.002]]) {
    for (const [euler, offset] of POSES) {
      it(`holds (2(a − t))³: a=${a}m, walls ${t}m, at ${offset.join(',')}`, () => {
        const b = new Builder();
        cube(b, a, false);
        cube(b, a - t, true);
        const { points } = moved(b.points, null, euler, offset);
        const r = measureCavity(points, b.faces);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const want = (2 * (a - t)) ** 3;
        report.push(`sealed a=${a} t=${t}: ${r.cavity.volume.toExponential(6)}m³ against ${want.toExponential(6)}m³`);
        expect(Math.abs(r.cavity.volume / want - 1)).toBeLessThan(0.005);
        expect(Math.abs(r.cavity.volume / want - 1)).toBeLessThan(1e-9);
        expect(r.cavity.port).toBeUndefined();
      });
    }
  }

  it('is any watertight shape: a hollow n-gon prism holds its prism of air', () => {
    for (const n of [6, 24, 64]) {
      const b = new Builder();
      const prism = (rad: number, z0: number, z1: number, inward: boolean) => {
        const s = inward ? -1 : 1;
        const at = (i: number, z: number): V => [rad * Math.cos((2 * Math.PI * i) / n), rad * Math.sin((2 * Math.PI * i) / n), z];
        for (let i = 0; i < n; i++) {
          const th = (2 * Math.PI * (i + 0.5)) / n;
          b.quad(at(i, z0), at(i + 1, z0), at(i + 1, z1), at(i, z1), [s * Math.cos(th), s * Math.sin(th), 0]);
          b.tri([0, 0, z1], at(i, z1), at(i + 1, z1), [0, 0, s]);
          b.tri([0, 0, z0], at(i + 1, z0), at(i, z0), [0, 0, -s]);
        }
      };
      prism(0.05, 0, 0.1, false);
      prism(0.045, 0.005, 0.095, true);
      const r = measureCavity(b.points, b.faces);
      const want = (n / 2) * 0.045 ** 2 * Math.sin((2 * Math.PI) / n) * 0.09;
      expect(r.ok && Math.abs(r.cavity.volume / want - 1)).toBeLessThan(1e-9);
    }
  });

  it('has no inside when it is not watertight', () => {
    const b = new Builder();
    cube(b, 0.05, false);
    cube(b, 0.04, true);
    const r = measureCavity(b.points, b.faces.slice(3));
    expect(r.ok).toBe(false);
  });

  it('is a solid with no cavity at all', () => {
    const b = new Builder();
    cube(b, 0.05, false);
    expect(measureCavity(b.points, b.faces).ok).toBe(false);
  });
});

describe('a ported box', () => {
  const cases = [
    { a: 0.06, t: 0.006, r: 0.01, n: 32 },
    { a: 0.1, t: 0.012, r: 0.02, n: 48 },
    { a: 0.15, t: 0.018, r: 0.025, n: 24 },
    { a: 0.05, t: 0.003, r: 0.008, n: 64 },
  ];
  for (const { a, t, r, n } of cases) {
    for (const [euler, offset] of POSES) {
      it(`holds (2(a − t))³ behind a port t long and r wide: a=${a}m, t=${t}m, r=${r}m, ${n}-gon, at ${offset.join(',')}`, () => {
        const b = portedBox(a, t, r, n);
        const port: PortAxis = { origin: [0, 0, 0], axis: [1, 0, 0], radius: r };
        const m = moved(b.points, port, euler, offset);
        // Not a sealed box: the bore joins the inside to the outside.
        expect(measureCavity(m.points, b.faces).ok).toBe(false);
        const res = measureCavity(m.points, b.faces, [m.port!]);
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        const want = (2 * (a - t)) ** 3;
        report.push(`ported a=${a} t=${t} r=${r}: ${res.cavity.volume.toExponential(6)}m³ against ${want.toExponential(6)}m³; port ${res.cavity.port!.length.toFixed(6)} × r${res.cavity.port!.radius.toFixed(6)}`);
        expect(Math.abs(res.cavity.volume / want - 1)).toBeLessThan(0.005);
        expect(Math.abs(res.cavity.volume / want - 1)).toBeLessThan(1e-9);
        expect(res.cavity.port!.length).toBeCloseTo(t, 9);
        expect(res.cavity.port!.radius).toBeCloseTo(r, 9);
      });
    }
  }

  it('counts the air a tube port standing into the box displaces, and the tube in its length', () => {
    for (const { a, t, r, wall, inside, n } of [
      { a: 0.08, t: 0.008, r: 0.012, wall: 0.003, inside: 0.04, n: 32 },
      { a: 0.12, t: 0.012, r: 0.02, wall: 0.004, inside: 0.07, n: 48 },
    ]) {
      const b = new Builder();
      const h = a - t, R = r + wall, x0 = h - inside;
      cube(b, a, false, true);
      holedWall(b, a, r, n, [1, 0, 0]);
      cube(b, h, true, true);
      holedWall(b, h, R, n, [-1, 0, 0]);
      const bore = (x1: number, x2: number, rad: number, sign: number) => {
        const p = ring(x1, rad, n), q = ring(x2, rad, n);
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          b.quad(p[i], p[j], q[j], q[i], [0, sign * (p[i][1] + p[j][1]), sign * (p[i][2] + p[j][2])]);
        }
      };
      // The tube's outside faces the cavity; its bore faces its axis.
      bore(x0, h, R, 1);
      bore(x0, a, r, -1);
      const inner = ring(x0, r, n), outer = ring(x0, R, n);
      for (let i = 0; i < n; i++) b.quad(inner[i], inner[(i + 1) % n], outer[(i + 1) % n], outer[i], [-1, 0, 0]);
      const res = measureCavity(b.points, b.faces, [{ origin: [0, 0, 0], axis: [1, 0, 0], radius: r }]);
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const polygon = (rad: number) => (n / 2) * rad * rad * Math.sin((2 * Math.PI) / n);
      const want = (2 * h) ** 3 - polygon(R) * inside;
      report.push(`tube port a=${a} r=${r} inside ${inside}: ${res.cavity.volume.toExponential(6)}m³ against ${want.toExponential(6)}m³; port ${res.cavity.port!.length.toFixed(6)}`);
      expect(Math.abs(res.cavity.volume / want - 1)).toBeLessThan(1e-9);
      expect(res.cavity.port!.length).toBeCloseTo(t + inside, 9);
      expect(res.cavity.port!.radius).toBeCloseTo(r, 9);
    }
  });

  it('is not found from a cylinder that is not its bore', () => {
    const b = portedBox(0.06, 0.006, 0.01, 32);
    expect(measureCavity(b.points, b.faces, [{ origin: [0, 0, 0], axis: [1, 0, 0], radius: 0.012 }]).ok).toBe(false);
    expect(measureCavity(b.points, b.faces, [{ origin: [0, 0, 0], axis: [0, 1, 0], radius: 0.01 }]).ok).toBe(false);
  });

  it('finds its port among a body\'s cut cylinders, in the compiled mesh\'s frame', () => {
    const a = 0.08, t = 0.008, r = 0.015;
    const b = portedBox(a, t, r, 40);
    // The compiled mesh is re-centred by csgCentroid's x and y; the negative is not.
    const centroid = [0.01, -0.02, 0.3];
    const zup = b.points.map((v, i) => v + (i % 3 === 2 ? centroid[2] : 0));
    const node = {
      id: 'box', name: 'box', csgEnabled: true, csgCentroid: centroid, children: [], joints: [],
      geoms: [
        { name: 'shell', type: 'box', size: [a, a, a], pos: [centroid[0], centroid[1], centroid[2]] },
        { name: 'decoy', type: 'cylinder', csg: 'difference', size: [0.004, 0.05], pos: [centroid[0], centroid[1] + 0.03, centroid[2]] },
        // Local +z turned onto +x: a quarter turn about y.
        { name: 'port', type: 'cylinder', csg: 'difference', size: [r, 0.05], pos: [centroid[0] + a, centroid[1], centroid[2]], quat: [Math.SQRT1_2, 0, Math.SQRT1_2, 0] },
        { name: 'box_csg', type: 'mesh', size: [1], csgDerived: 'visual', renderVertices: zup, vertices: zup, faces: b.faces },
      ],
    } as unknown as SceneNode;
    const res = measureBodyCavity(node);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(Math.abs(res.cavity.volume / (2 * (a - t)) ** 3 - 1)).toBeLessThan(1e-9);
    expect(res.cavity.port!.length).toBeCloseTo(t, 9);
    expect(res.cavity.port!.radius).toBeCloseTo(r, 9);
  });
});

describe('a measured cavity on the link to Volt', () => {
  const measured = { box: { volume: 0.001, portLength: 0.05, portRadius: 0.01 }, jar: { volume: 0.0005 } };

  it('is in the catalogue as outputs, a port only where there is one', () => {
    const names = cavityChannels(measured).map(c => `${c.name} ${c.direction} ${c.unit}`);
    expect(names).toEqual([
      'body:box.cavityVolume output m³', 'body:box.portLength output m', 'body:box.portRadius output m',
      'body:jar.cavityVolume output m³',
    ]);
  });

  it('is answered without the model, and anything else is left to it', () => {
    const { outputs, rest } = readCavityOutputs(measured, ['body:box.cavityVolume', 'body:box.portRadius', 'body:jar.portLength', 'joint:arm.pos', 'body:lid.cavityVolume']);
    expect(outputs).toEqual({ 'body:box.cavityVolume': 0.001, 'body:box.portRadius': 0.01 });
    expect(rest).toEqual(['body:jar.portLength', 'joint:arm.pos', 'body:lid.cavityVolume']);
  });

  it('travels unlinked as the fragment Volt reads', () => {
    const url = buildVoltCavityUrl('box', measured.box, 'Speaker box', 'http://localhost:5174/');
    const params = new URLSearchParams(url.split('#')[1]);
    expect(url.startsWith('http://localhost:5174/#')).toBe(true);
    expect(Object.fromEntries(params)).toEqual({ v: '1', cavity: '0.001', body: 'box', scene: 'Speaker box', portLength: '0.05', portRadius: '0.01' });
    expect(new URLSearchParams(buildVoltCavityUrl('jar', measured.jar, undefined, 'x/').split('#')[1]).has('portLength')).toBe(false);
  });
});

describe('measurements', () => {
  it('reports what was measured', () => {
    console.log(report.join('\n'));
  });
});
