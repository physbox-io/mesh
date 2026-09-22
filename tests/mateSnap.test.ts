import { describe, it, expect } from 'vitest';
import {
  solveMate, solveAlignAboutAxis, solveScaleToFit, applyQuat, quatFromAxisAngle,
  ALIGN_BAND_DEG, RADIUS_TOL,
  type Vec3, type Quat, type PointFeature, type AxisFeature, type FaceFeature,
} from '../src/utils/mateSnap';

const BAND = 0.004; // 4 mm, about what 14 screen pixels comes to on a small part.

const point = (at: Vec3, label = 'corner'): PointFeature => ({ kind: 'point', point: at, label });
const axis = (at: Vec3, dir: Vec3, radius: number, label = 'hole'): AxisFeature =>
  ({ kind: 'axis', point: at, dir, radius, label });
const face = (at: Vec3, normal: Vec3, extent: number, label = 'face'): FaceFeature =>
  ({ kind: 'face', point: at, normal, extent, label });

const mate = (moving: Parameters<typeof solveMate>[0]['moving'], fixed: Parameters<typeof solveMate>[0]['fixed']) =>
  solveMate({ moving, fixed, position: [0, 0, 0], threshold: BAND });

/** Degrees off an axis, as a unit vector in the XZ plane. */
const tilted = (deg: number): Vec3 => {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), 0, Math.cos(r)];
};

describe('a corner onto a corner', () => {
  it('pulls on all three axes at once', () => {
    const solution = mate([point([0, 0, 0])], [point([0.0005, 0.0005, 0.0005])]);
    expect(solution).not.toBeNull();
    expect(solution!.kind).toBe('point');
    // Inside the deadzone, so it lands exactly rather than approaching.
    expect(solution!.position[0]).toBeCloseTo(0.0005, 12);
    expect(solution!.position[1]).toBeCloseTo(0.0005, 12);
    expect(solution!.position[2]).toBeCloseTo(0.0005, 12);
    expect(solution!.locked).toBe(true);
  });

  it('constrains everything, so nothing is left for the floor snap', () => {
    expect(mate([point([0, 0, 0])], [point([0.0005, 0, 0])])!.free).toEqual([]);
  });

  it('is not offered at all from outside the band', () => {
    expect(mate([point([0, 0, 0])], [point([0.05, 0, 0])])).toBeNull();
  });

  it('eases rather than jumping, part way out', () => {
    const solution = mate([point([0, 0, 0])], [point([0.003, 0, 0])]);
    expect(solution).not.toBeNull();
    expect(solution!.locked).toBe(false);
    // Moved toward the target, but not all the way onto it.
    expect(solution!.position[0]).toBeGreaterThan(0);
    expect(solution!.position[0]).toBeLessThan(0.003);
  });
});

describe('an axis into a hole', () => {
  // Offset across the axis by about 1.1 mm — inside the deadzone, so the mate
  // lands exactly — and a long way up it, which is the part that must not move.
  const hole = axis([0.0005, 0.001, 0.5], [0, 0, 1], 0.003);

  it('leaves the along-axis coordinate completely alone', () => {
    // The peg is a long way up the hole's line and must stay exactly there:
    // sliding to some fixed depth is the thing nobody asked for.
    const peg = axis([0, 0, 0], [0, 0, 1], 0.003, 'peg');
    const solution = mate([peg], [hole]);
    expect(solution).not.toBeNull();
    expect(solution!.kind).toBe('axis');
    expect(solution!.offset[2]).toBe(0);
    expect(solution!.position[2]).toBe(0);
    // And it did close the gap across the axis.
    expect(solution!.position[0]).toBeCloseTo(0.0005, 12);
    expect(solution!.position[1]).toBeCloseTo(0.001, 12);
  });

  it('reports the axis as free, so the part can still settle along it', () => {
    const solution = mate([axis([0, 0, 0], [0, 0, 1], 0.003)], [hole]);
    expect(solution!.free).toHaveLength(1);
    expect(solution!.free[0][2]).toBeCloseTo(1, 12);
  });

  it('does not care which end of the hole the axis points at', () => {
    const flipped = axis([0, 0, 0], [0, 0, -1], 0.003);
    expect(mate([flipped], [hole])).not.toBeNull();
  });

  it('accepts a degree of misalignment and rejects twenty', () => {
    expect(mate([axis([0, 0, 0], tilted(1), 0.003)], [axis([0.001, 0, 0], [0, 0, 1], 0.003)])).not.toBeNull();
    expect(mate([axis([0, 0, 0], tilted(20), 0.003)], [axis([0.001, 0, 0], [0, 0, 1], 0.003)])).toBeNull();
  });

  it('will not put a pin in a bore that is nothing like its size', () => {
    const pin = axis([0, 0, 0], [0, 0, 1], 0.0015);
    const bore = axis([0.001, 0, 0], [0, 0, 1], 0.01);
    expect(Math.abs(0.0015 - 0.01) / 0.01).toBeGreaterThan(RADIUS_TOL);
    expect(mate([pin], [bore])).toBeNull();
  });

  it('allows a clearance fit', () => {
    const peg = axis([0, 0, 0], [0, 0, 1], 0.0029);
    expect(mate([peg], [hole])).not.toBeNull();
  });
});

describe('a face flat onto a face', () => {
  // A table top facing up, and a plate whose underside faces down onto it.
  const top = face([0, 0, 0.02], [0, 0, 1], 0.05, 'top of plate');
  const underside = (z: number) => face([0, 0, z], [0, 0, -1], 0.03, 'bottom of block');

  it('closes the gap along the normal and moves nothing sideways', () => {
    const solution = mate([underside(0.0205)], [top]);
    expect(solution).not.toBeNull();
    expect(solution!.kind).toBe('face');
    expect(solution!.offset[0]).toBeCloseTo(0, 15);
    expect(solution!.offset[1]).toBeCloseTo(0, 15);
    expect(solution!.position[2]).toBeCloseTo(-0.0005, 12);
  });

  it('leaves the two in-plane directions free', () => {
    const solution = mate([underside(0.0205)], [top]);
    expect(solution!.free).toHaveLength(2);
    for (const d of solution!.free) expect(d[2]).toBeCloseTo(0, 12);
  });

  it('fires when the faces already oppose each other', () => {
    expect(mate([underside(0.0205)], [top])).not.toBeNull();
  });

  it('refuses faces that are twenty degrees out, rather than turning the part', () => {
    const askew = face([0, 0, 0.0205], [Math.sin(-0.35), 0, -Math.cos(0.35)], 0.03);
    expect(mate([askew], [top])).toBeNull();
  });

  it('refuses two faces that do not overlap sideways', () => {
    // Level with the table, but a metre away across it.
    const faraway = face([1, 0, 0.0205], [0, 0, -1], 0.03);
    expect(mate([faraway], [top])).toBeNull();
  });

  it('refuses two faces pointing the same way', () => {
    const sameWay = face([0, 0, 0.0205], [0, 0, 1], 0.03);
    expect(mate([sameWay], [top])).toBeNull();
  });
});

describe('which mate wins', () => {
  it('prefers a corner, as the more specific thing to have aimed at', () => {
    const solution = solveMate({
      moving: [point([0, 0, 0]), face([0, 0, 0], [0, 0, -1], 0.05)],
      fixed: [point([0.0009, 0, 0]), face([0, 0, 0.0004], [0, 0, 1], 0.05)],
      position: [0, 0, 0],
      threshold: 0.004,
    });
    // The face is nearer, but not by the clear margin TIE_BREAK asks for
    // (0.0004 is not under 0.0009 * 0.3), so the corner holds.
    expect(solution!.kind).toBe('point');
  });

  it('lets a face all but touching beat a corner at the edge of reach', () => {
    const solution = solveMate({
      moving: [point([0, 0, 0]), face([0, 0, 0], [0, 0, -1], 0.05)],
      fixed: [point([0.009, 0, 0]), face([0, 0, 0.0002], [0, 0, 1], 0.05)],
      position: [0, 0, 0],
      threshold: 0.01,
    });
    expect(solution!.kind).toBe('face');
  });

  it('takes the nearer of two mates of the same kind', () => {
    const solution = mate([point([0, 0, 0])], [point([0.003, 0, 0]), point([0, 0.0008, 0])]);
    expect(solution!.to).toEqual([0, 0.0008, 0]);
  });
});

describe('turning a part onto a neighbouring face', () => {
  const band = ALIGN_BAND_DEG;
  // A fixed face pointing up; a moving face that should end up pointing down.
  const fixedUp = [face([0, 0, 0], [0, 0, 1], 0.05, 'top of plate')];
  const movingAt = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    // Tipped about Z... which does nothing to a normal along Z, so tip about Y.
    return [face([0, 0, 0.01], [Math.sin(r), 0, -Math.cos(r)], 0.03, 'bottom of block')];
  };
  const spin: Quat = [0, 0, 0, 1];

  it('pulls the last few degrees home, about the ring being held', () => {
    const solution = solveAlignAboutAxis({
      moving: movingAt(2), fixed: fixedUp, axis: [0, 1, 0], quaternion: spin,
    });
    expect(solution).not.toBeNull();
    expect(solution!.locked).toBe(true);
    // Inside the deadzone the moving normal ends up exactly opposed.
    const turned = applyQuat(movingAt(2)[0].normal, solution!.quaternion);
    expect(turned[0]).toBeCloseTo(0, 9);
    expect(turned[2]).toBeCloseTo(-1, 9);
  });

  it('leaves a part alone when it is nowhere near aligned', () => {
    expect(solveAlignAboutAxis({
      moving: movingAt(20), fixed: fixedUp, axis: [0, 1, 0], quaternion: spin,
    })).toBeNull();
    expect(band).toBeLessThan(20);
  });

  it('never turns about any axis but the one being dragged', () => {
    const solution = solveAlignAboutAxis({
      moving: movingAt(5), fixed: fixedUp, axis: [0, 1, 0], quaternion: spin,
    });
    expect(solution).not.toBeNull();
    // A rotation purely about Y has zero X and Z in its vector part.
    expect(solution!.quaternion[0]).toBeCloseTo(0, 12);
    expect(solution!.quaternion[2]).toBeCloseTo(0, 12);
  });

  it('declines a pairing that this ring could never reach', () => {
    // The target is 90 degrees away ACROSS the ring's axis: spinning about Y
    // sweeps the normal round a cone that never passes through it.
    const sideways = [face([0, 0, 0], [0, 1, 0], 0.05, 'end face')];
    expect(solveAlignAboutAxis({
      moving: movingAt(2), fixed: sideways, axis: [0, 1, 0], quaternion: spin,
    })).toBeNull();
  });

  it('eases rather than snapping when it is part way out', () => {
    const solution = solveAlignAboutAxis({
      moving: movingAt(6), fixed: fixedUp, axis: [0, 1, 0], quaternion: spin,
    });
    expect(solution).not.toBeNull();
    expect(solution!.locked).toBe(false);
    expect(solution!.strength).toBeGreaterThan(0);
    expect(solution!.strength).toBeLessThan(1);
  });
});

describe('the quaternion helpers', () => {
  it('turn a vector the way a right-handed rotation should', () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 2);
    const turned = applyQuat([1, 0, 0], q);
    expect(turned[0]).toBeCloseTo(0, 12);
    expect(turned[1]).toBeCloseTo(1, 12);
    expect(turned[2]).toBeCloseTo(0, 12);
  });

  it('survive the trip the gizmo actually makes them take', () => {
    // The gizmo commits a turn as three ZYX Euler degrees and reads it back as
    // a quaternion. A nudge from the align solve has to come through that
    // unchanged, or the part would shift on release.
    const q = quatFromAxisAngle([0, 1, 0], 0.4);
    const normal: Vec3 = [0, 0, -1];
    const before = applyQuat(normal, q);
    // ZYX euler from the quaternion, then back — done with the same maths
    // Three uses, so this is a real round trip rather than an identity.
    const [x, y, z, w] = q;
    const m11 = 1 - 2 * (y * y + z * z), m12 = 2 * (x * y - z * w), m13 = 2 * (x * z + y * w);
    const m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
    const m32 = 2 * (y * z + x * w), m33 = 1 - 2 * (x * x + y * y);
    const ey = Math.asin(Math.min(1, Math.max(-1, m13)));
    const ex = Math.abs(m13) < 0.9999 ? Math.atan2(-m23, m33) : Math.atan2(m32, m22);
    const ez = Math.abs(m13) < 0.9999 ? Math.atan2(-m12, m11) : 0;
    const back = quatMulAll(
      quatFromAxisAngle([0, 0, 1], ez),
      quatFromAxisAngle([0, 1, 0], ey),
      quatFromAxisAngle([1, 0, 0], ex),
    );
    const after = applyQuat(normal, back);
    expect(after[0]).toBeCloseTo(before[0], 9);
    expect(after[1]).toBeCloseTo(before[1], 9);
    expect(after[2]).toBeCloseTo(before[2], 9);
  });
});

function quatMulAll(...qs: Quat[]): Quat {
  return qs.reduce((a, b) => {
    const [ax, ay, az, aw] = a;
    const [bx, by, bz, bw] = b;
    return [
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz,
    ] as Quat;
  });
}

describe('sizing a part to fit a hole', () => {
  // A 3 mm peg being scaled up next to a 6 mm bore.
  const peg = axis([0, 0, 0], [0, 0, 1], 0.003, 'peg');
  const bore = axis([0, 0, 0], [0, 0, 1], 0.006, 'bore in plate');
  const fit = (factor: number, threshold = 0.0005) =>
    solveScaleToFit({ moving: [peg], fixed: [bore], factor, threshold });

  it('lands exactly on the size that fits', () => {
    // 1.98 puts the peg at 5.94 mm, well inside a half-millimetre band.
    const solution = fit(1.98);
    expect(solution).not.toBeNull();
    expect(solution!.locked).toBe(true);
    expect(solution!.radius).toBeCloseTo(0.006, 12);
    // And the factor it reports is the one that gets there.
    expect(peg.radius * solution!.factor).toBeCloseTo(0.006, 12);
  });

  it('says nothing while the sizes are nowhere near', () => {
    expect(fit(1)).toBeNull();
    expect(fit(4)).toBeNull();
  });

  it('eases in rather than jumping to the fit', () => {
    const solution = fit(1.85); // 5.55 mm: inside the band, outside the deadzone
    expect(solution).not.toBeNull();
    expect(solution!.locked).toBe(false);
    expect(solution!.radius).toBeGreaterThan(0.00555);
    expect(solution!.radius).toBeLessThan(0.006);
  });

  it('measures the band in millimetres, not in factors', () => {
    // The same factor error on a much bigger part is a much bigger gap, and
    // must fall outside a band stated in metres.
    const flange = axis([0, 0, 0], [0, 0, 1], 0.3, 'flange');
    const seat = axis([0, 0, 0], [0, 0, 1], 0.6, 'seat');
    expect(solveScaleToFit({ moving: [flange], fixed: [seat], factor: 1.98, threshold: 0.0005 })).toBeNull();
  });

  it('takes the nearest size when several would fit', () => {
    const small = axis([0, 0, 0], [0, 0, 1], 0.0058, 'small bore');
    const solution = solveScaleToFit({
      moving: [peg], fixed: [bore, small], factor: 1.95, threshold: 0.0005,
    });
    // 5.85 mm is nearer 5.8 than 6.0.
    expect(solution!.radius).toBeCloseTo(0.0058, 12);
  });

  it('ignores anything that is not a hole or a boss', () => {
    const corner = point([0, 0, 0]);
    expect(solveScaleToFit({ moving: [corner], fixed: [bore], factor: 1.98, threshold: 0.0005 })).toBeNull();
    expect(solveScaleToFit({ moving: [peg], fixed: [corner], factor: 1.98, threshold: 0.0005 })).toBeNull();
  });
});
