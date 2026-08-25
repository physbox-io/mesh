import { describe, it, expect } from 'vitest';
import { checkJobEnvelope, describeEnvelope, type JobExtent } from '../src/utils/workEnvelope';
import { DEFAULT_MOTION_PROFILE, motionProfileFromSettings, parseGrblSettings, type MotionProfile } from '../src/utils/motionProfile';

/** A machine that homes to max, GRBL's default, with a 400x300x80 envelope. */
const machine: MotionProfile = {
  ...DEFAULT_MOTION_PROFILE,
  travel: { x: 400, y: 300, z: 80 },
  homingEnabled: true,
  source: 'machine',
};

const job = (minX: number, minY: number, maxX: number, maxY: number): JobExtent =>
  ({ minX, minY, maxX, maxY });

describe('workEnvelope', () => {
  describe('reading the limits off the controller', () => {
    it('picks up travel, homing and soft limits from a $$ dump', () => {
      const p = motionProfileFromSettings(parseGrblSettings([
        '$20=1', '$22=1', '$120=750', '$110=8000',
        '$130=400.000', '$131=300.000', '$132=80.000',
      ]));

      expect(p.travel).toEqual({ x: 400, y: 300, z: 80 });
      expect(p.homingEnabled).toBe(true);
      expect(p.softLimits).toBe(true);
    });

    it('leaves travel unknown rather than half-known', () => {
      // A controller that numbers its settings differently is far likelier than
      // a machine with no Y axis, so one axis on its own is not an envelope.
      const p = motionProfileFromSettings(parseGrblSettings(['$130=400.000']));
      expect(p.travel).toBeNull();
    });

    it('leaves travel unknown when nothing reported it', () => {
      const p = motionProfileFromSettings(parseGrblSettings(['$120=750', '$110=8000']));
      expect(p.travel).toBeNull();
      expect(p.homingEnabled).toBe(false);
    });
  });

  describe('is the job bigger than the machine', () => {
    it('passes a job that fits', () => {
      const v = checkJobEnvelope(job(0, 0, 380, 280), machine);
      expect(v.ok).toBe(true);
      expect(v.sizeChecked).toBe(true);
    });

    it('fails a sheet wider than the rail, and says by how much', () => {
      const v = checkJobEnvelope(job(0, 0, 600, 280), machine);
      expect(v.ok).toBe(false);
      expect(v.problems).toHaveLength(1);
      expect(v.problems[0]).toMatchObject({ axis: 'X', kind: 'too-big' });
      expect(v.problems[0].overrunMm).toBeCloseTo(200, 3);
      expect(v.problems[0].message).toContain('200.0 mm too much');
    });

    it('catches both axes at once', () => {
      const v = checkJobEnvelope(job(0, 0, 600, 400), machine);
      expect(v.problems.map((p) => p.axis)).toEqual(['X', 'Y']);
    });

    it('checks the Z span when the job has one', () => {
      const deep: JobExtent = { ...job(0, 0, 100, 100), minZ: -100, maxZ: 5 };
      const v = checkJobEnvelope(deep, machine);
      expect(v.problems.map((p) => p.axis)).toContain('Z');
    });

    it('says nothing at all when the machine never reported its travel', () => {
      const v = checkJobEnvelope(job(0, 0, 5000, 5000), DEFAULT_MOTION_PROFILE);
      // Not "it fits" — "nothing is known against it", and the caller is told
      // the difference.
      expect(v.ok).toBe(true);
      expect(v.sizeChecked).toBe(false);
      expect(v.placementSkippedBecause).toMatch(/\$130/);
    });
  });

  describe('does it fit from where it has been zeroed', () => {
    // Homed to max: machine coordinates run -400..0 on X, and the machine
    // parked at -50 confirms that convention.
    const parked = { x: -50, y: -50, z: -10 };

    it('passes a job that fits from its origin', () => {
      const origin = { x: -300, y: -200, z: -20 };
      const v = checkJobEnvelope(job(0, 0, 200, 150), machine, origin, parked);
      expect(v.placementChecked).toBe(true);
      expect(v.ok).toBe(true);
    });

    it('fails a job zeroed too far along the bed to finish', () => {
      // Origin 100mm from the far end, job 200mm long: 100mm of it is off the end.
      const origin = { x: -100, y: -200, z: -20 };
      const v = checkJobEnvelope(job(0, 0, 200, 150), machine, origin, parked);

      expect(v.ok).toBe(false);
      expect(v.problems[0]).toMatchObject({ axis: 'X', kind: 'runs-off' });
      expect(v.problems[0].overrunMm).toBeCloseTo(100, 3);
      expect(v.problems[0].message).toContain('past the far end');
    });

    it('fails a job that runs off the near end', () => {
      const origin = { x: -350, y: -200, z: -20 };
      const v = checkJobEnvelope(job(-100, 0, 0, 150), machine, origin, parked);
      expect(v.problems[0]).toMatchObject({ axis: 'X', kind: 'runs-off' });
      expect(v.problems[0].overrunMm).toBeCloseTo(50, 3);
      expect(v.problems[0].message).toContain('past the near end');
    });

    it('reads the sign convention off a machine that homes to minimum', () => {
      // Same machine, but parked at +50, so its coordinates run 0..400.
      const atMin = { x: 50, y: 50, z: 10 };
      const origin = { x: 300, y: 100, z: 20 };

      const fits = checkJobEnvelope(job(0, 0, 90, 150), machine, origin, atMin);
      expect(fits.ok).toBe(true);

      const doesNot = checkJobEnvelope(job(0, 0, 150, 150), machine, origin, atMin);
      expect(doesNot.problems[0]).toMatchObject({ axis: 'X', kind: 'runs-off' });
      expect(doesNot.problems[0].overrunMm).toBeCloseTo(50, 3);
    });

    it('does not report the same axis twice when the job is simply too big', () => {
      const origin = { x: -200, y: -200, z: -20 };
      const v = checkJobEnvelope(job(0, 0, 600, 150), machine, origin, parked);
      expect(v.problems.filter((p) => p.axis === 'X')).toHaveLength(1);
      expect(v.problems[0].kind).toBe('too-big');
    });

    it('skips the placement check on a machine that does not home, and says so', () => {
      const noHoming = { ...machine, homingEnabled: false };
      const v = checkJobEnvelope(job(0, 0, 200, 150), noHoming, { x: -100, y: 0, z: 0 }, parked);

      expect(v.sizeChecked).toBe(true);
      expect(v.placementChecked).toBe(false);
      expect(v.placementSkippedBecause).toMatch(/\$22=0/);
      // Still catches a size problem on the same machine.
      expect(checkJobEnvelope(job(0, 0, 600, 150), noHoming).ok).toBe(false);
    });

    it('skips the placement check when nothing is connected', () => {
      const v = checkJobEnvelope(job(0, 0, 200, 150), machine);
      expect(v.placementChecked).toBe(false);
      expect(v.placementSkippedBecause).toMatch(/Nothing is connected/);
    });
  });

  describe('describeEnvelope', () => {
    it('distinguishes a pass from an unrun check', () => {
      const checked = describeEnvelope(checkJobEnvelope(job(0, 0, 100, 100), machine, { x: -200, y: -200, z: -20 }, { x: -50, y: -50, z: -10 }));
      expect(checked).toMatch(/fits from this work origin/);

      const unchecked = describeEnvelope(checkJobEnvelope(job(0, 0, 100, 100), DEFAULT_MOTION_PROFILE));
      expect(unchecked).toMatch(/\$130/);
    });
  });
});
