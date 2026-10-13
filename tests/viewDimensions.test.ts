import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyViewDimensions, formatDim, type BodyMesh, type DiameterDim, type LinearDim } from '../src/utils/viewDimensions';
import { orthoFraming } from '../src/utils/cameraViews';

/** A three geometry as a body: positions taken as document frame (Z-up), metres. */
function body(geometry: THREE.BufferGeometry, matrix?: THREE.Matrix4, id = 'part'): BodyMesh {
  const g = geometry;
  if (matrix) g.applyMatrix4(matrix);
  const positions = Array.from(g.getAttribute('position').array as ArrayLike<number>);
  const faces = g.index
    ? Array.from(g.index.array as ArrayLike<number>)
    : Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { id, positions, faces };
}

const mm = (v: number) => v / 1000;

function linear(dims: { dims: unknown[] } | null, axis: 'u' | 'v', row: 1 | 2): LinearDim[] {
  return (dims?.dims ?? []).filter((d): d is LinearDim =>
    (d as LinearDim).kind === 'linear' && (d as LinearDim).axis === axis && (d as LinearDim).row === row);
}
const diameters = (dims: { dims: unknown[] } | null) =>
  (dims?.dims ?? []).filter((d): d is DiameterDim => (d as DiameterDim).kind === 'diameter');

/** A plate in XY, extruded up Z, with round holes. */
function plateWithHoles(w: number, d: number, t: number, holes: { x: number; y: number; r: number }[]) {
  const shape = new THREE.Shape();
  shape.moveTo(0, 0); shape.lineTo(w, 0); shape.lineTo(w, d); shape.lineTo(0, d); shape.closePath();
  for (const h of holes) {
    const path = new THREE.Path();
    path.absarc(h.x, h.y, h.r, 0, Math.PI * 2, true);
    shape.holes.push(path);
  }
  return new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 64 });
}

/** A profile in XZ (drawn as x, y), extruded along +Y by `depth`. */
function profileXZ(points: [number, number][], depth: number) {
  const shape = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  // Shape's y becomes Z, extrusion (+Z) becomes +Y: rotate +90° about X then mirror.
  g.applyMatrix4(new THREE.Matrix4().set(
    1, 0, 0, 0,
    0, 0, 1, 0,
    0, 1, 0, 0,
    0, 0, 0, 1,
  ));
  return g;
}

describe('formatDim', () => {
  it('writes millimetres, one decimal, none when whole', () => {
    expect(formatDim(0.04)).toBe('40');
    expect(formatDim(0.0125)).toBe('12.5');
    expect(formatDim(0.01234)).toBe('12.3');
  });
});

describe('box', () => {
  const box = () => body(new THREE.BoxGeometry(mm(40), mm(20), mm(10)));

  it('front view: 40 wide, 10 high, no chain', () => {
    const d = bodyViewDimensions(box(), 'front');
    expect(linear(d, 'u', 2).map((x) => x.label)).toEqual(['40']);
    expect(linear(d, 'v', 2).map((x) => x.label)).toEqual(['10']);
    expect(linear(d, 'u', 1)).toEqual([]);
    expect(linear(d, 'v', 1)).toEqual([]);
    expect(diameters(d)).toEqual([]);
  });

  it('top view: 40 wide, 20 high', () => {
    const d = bodyViewDimensions(box(), 'topDown');
    expect(linear(d, 'u', 2)[0].valueMm).toBeCloseTo(40, 6);
    expect(linear(d, 'v', 2)[0].valueMm).toBeCloseTo(20, 6);
  });

  it('side view: 20 wide, 10 high', () => {
    const d = bodyViewDimensions(box(), 'side');
    expect(linear(d, 'u', 2)[0].valueMm).toBeCloseTo(20, 6);
    expect(linear(d, 'v', 2)[0].valueMm).toBeCloseTo(10, 6);
  });

  it('still reads its size when turned 30° about the view axis, and claims no square edges', () => {
    const turned = body(new THREE.BoxGeometry(mm(40), mm(20), mm(10)), new THREE.Matrix4().makeRotationZ(Math.PI / 6));
    const d = bodyViewDimensions(turned, 'topDown');
    expect(linear(d, 'u', 1)).toEqual([]);
    expect(linear(d, 'v', 1)).toEqual([]);
    const w = 40 * Math.cos(Math.PI / 6) + 20 * Math.sin(Math.PI / 6);
    expect(linear(d, 'u', 2)[0].valueMm).toBeCloseTo(w, 1);
  });
});

describe('plate with holes', () => {
  const plate = () => body(plateWithHoles(mm(60), mm(30), mm(5), [
    { x: mm(10), y: mm(15), r: mm(4) },
    { x: mm(50), y: mm(15), r: mm(4) },
    { x: mm(30), y: mm(15), r: mm(6) },
  ]));

  it('top view: each size of hole once, equal holes counted, both rims one hole', () => {
    const d = bodyViewDimensions(plate(), 'topDown');
    const labels = diameters(d).map((x) => x.label).sort();
    expect(labels).toEqual(['2× ⌀8', '⌀12']);
  });

  it('top view: the chain locates the hole centres and adds up to the width', () => {
    const d = bodyViewDimensions(plate(), 'topDown');
    const chain = linear(d, 'u', 1).map((x) => x.valueMm);
    expect(chain.map((x) => Math.round(x * 10) / 10)).toEqual([10, 20, 20, 10]);
    expect(chain.reduce((a, b) => a + b, 0)).toBeCloseTo(linear(d, 'u', 2)[0].valueMm, 6);
    // Up the sheet, the holes all sit at 15.
    expect(linear(d, 'v', 1).map((x) => Math.round(x.valueMm * 10) / 10)).toEqual([15, 15]);
  });

  it('front view: the holes are out of sight and add nothing', () => {
    const d = bodyViewDimensions(plate(), 'front');
    expect(diameters(d)).toEqual([]);
    expect(linear(d, 'u', 1)).toEqual([]);
    expect(linear(d, 'u', 2)[0].valueMm).toBeCloseTo(60, 6);
    expect(linear(d, 'v', 2)[0].valueMm).toBeCloseTo(5, 6);
  });
});

describe('stepped block', () => {
  // Front profile: 50 wide; 20 high for the first 20 mm, 8 high after.
  const stepped = () => body(profileXZ([[0, 0], [mm(50), 0], [mm(50), mm(8)], [mm(20), mm(8)], [mm(20), mm(20)], [0, mm(20)]], mm(15)));

  it('front view: the step is a stop each way, and the chains add up', () => {
    const d = bodyViewDimensions(stepped(), 'front');
    expect(linear(d, 'u', 1).map((x) => Math.round(x.valueMm * 10) / 10)).toEqual([20, 30]);
    expect(linear(d, 'v', 1).map((x) => Math.round(x.valueMm * 10) / 10)).toEqual([8, 12]);
    expect(linear(d, 'u', 2)[0].valueMm).toBeCloseTo(50, 6);
    expect(linear(d, 'v', 2)[0].valueMm).toBeCloseTo(20, 6);
  });

  it('the step edge reaches its extension line down from where it is', () => {
    const d = bodyViewDimensions(stepped(), 'front');
    const [first] = linear(d, 'u', 1);
    // Both ends of the 20 mm run start on the bottom of the part.
    expect(first.anchorA).toBeCloseTo(0, 6);
  });
});

describe('cylinder', () => {
  // three's cylinder stands on Y; lay it along the document's Z (its axis up).
  const upright = () => body(new THREE.CylinderGeometry(mm(10), mm(10), mm(30), 64), new THREE.Matrix4().makeRotationX(Math.PI / 2));

  it('top view: one diameter and nothing else', () => {
    const d = bodyViewDimensions(upright(), 'topDown');
    expect(d?.dims.map((x) => x.label)).toEqual(['⌀20']);
  });

  it('front view: the width is the diameter', () => {
    const d = bodyViewDimensions(upright(), 'front');
    expect(linear(d, 'u', 2)[0].label).toBe('⌀20');
    expect(linear(d, 'v', 2)[0].label).toBe('30');
    expect(diameters(d)).toEqual([]);
  });
});

describe('orthoFraming', () => {
  it('centres on the content and keeps the 160 mm default for a small part', () => {
    const f = orthoFraming({ min: [0, 0, 0], max: [0.04, 0.02, 0.01] }, 'front', 1.5);
    expect(f.target).toEqual([0.02, 0.01, 0.005]);
    expect(f.height).toBeCloseTo(0.16, 6);
  });

  it('backs off for a big part, by whichever way binds', () => {
    const wide = orthoFraming({ min: [0, 0, 0], max: [1, 0.1, 0.1] }, 'front', 2);
    expect(wide.height).toBeCloseTo((1 / 2) * 1.6, 6);
    const tall = orthoFraming({ min: [0, 0, 0], max: [0.1, 0.1, 1] }, 'side', 2);
    expect(tall.height).toBeCloseTo(1.6, 6);
  });

  it('defaults with nothing to frame', () => {
    expect(orthoFraming(null, 'topDown').height).toBeCloseTo(0.16, 6);
  });
});

describe('sphere', () => {
  it('a bob is its diameter in every view, and nothing else', () => {
    for (const view of ['front', 'side', 'topDown'] as const) {
      const bob = { ...body(new THREE.SphereGeometry(mm(18), 32, 24)), spheres: [{ centre: [0, 0, 0] as [number, number, number], radius: mm(18) }] };
      expect(bodyViewDimensions(bob, view)?.dims.map((d) => d.label)).toEqual(['⌀36']);
    }
  });

  it('on the end of an arm it gets its ⌀ beside the arm\'s sizes', () => {
    const arm = new THREE.BoxGeometry(mm(200), mm(6), mm(6));
    arm.translate(mm(100), 0, 0);
    const ball = new THREE.SphereGeometry(mm(18), 32, 24);
    ball.translate(mm(220), 0, 0);
    const a = body(arm);
    const b = body(ball);
    const merged = {
      id: 'pendulum',
      positions: [...a.positions as number[], ...b.positions as number[]],
      faces: [...a.faces as number[], ...(b.faces as number[]).map((i) => i + a.positions.length / 3)],
      spheres: [{ centre: [mm(220), 0, 0] as [number, number, number], radius: mm(18) }],
    };
    const d = bodyViewDimensions(merged, 'front');
    expect(diameters(d).map((x) => x.label)).toEqual(['⌀36']);
    expect(linear(d, 'u', 2)[0].valueMm).toBeCloseTo(238, 6);
  });
});

describe('busy parts', () => {
  it('a plate with a row of nine holes gives no chain, just the size and the holes', () => {
    const holes = Array.from({ length: 9 }, (_, i) => ({ x: mm(10 + i * 10), y: mm(10), r: mm(2) }));
    const d = bodyViewDimensions(body(plateWithHoles(mm(100), mm(20), mm(3), holes)), 'topDown');
    expect(linear(d, 'u', 1)).toEqual([]);
    expect(linear(d, 'u', 2)[0].valueMm).toBeCloseTo(100, 6);
    expect(diameters(d).map((x) => x.label)).toEqual(['9× ⌀4']);
  });
});

describe('spheres inside spheres', () => {
  it('one wholly inside another is out of sight and gets nothing', () => {
    const head = body(new THREE.SphereGeometry(mm(100), 32, 24));
    const d = bodyViewDimensions({
      ...head,
      spheres: [
        { centre: [0, 0, 0], radius: mm(100) },
        { centre: [mm(30), 0, 0], radius: mm(20) },
      ],
    }, 'front');
    expect(d?.dims.map((x) => x.label)).toEqual(['⌀200']);
  });
});
