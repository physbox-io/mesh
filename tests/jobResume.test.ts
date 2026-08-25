import { describe, it, expect } from 'vitest';
import { scanModalState, buildResumePreamble, planResume } from '../src/utils/jobResume';
import { prepareJobLines } from '../src/utils/webSerialManager';
import { generateLaserCutGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import type { LaserPanel, Point2D } from '../src/utils/laserCutExporter';

/** A short router program, as the sender would hold it. */
const router = [
  'G21', 'G90', 'G17',
  'G0 Z5.000',
  'M3 S18000',
  'G4 P2',
  'G0 X10.000 Y20.000',
  'G1 Z-3.000 F300',
  'G1 X60.000 Y20.000 F900',
  'G1 X60.000 Y50.000',
  'G1 X10.000 Y50.000',
  'G0 Z5.000',
  'M5',
  'M30',
];

describe('jobResume', () => {
  describe('scanning the state a line would run in', () => {
    it('recovers the modal words in force part way through', () => {
      const s = scanModalState(router, 9); // about to cut from X60 Y20 to X60 Y50
      expect(s.units).toBe('G21');
      expect(s.distance).toBe('G90');
      expect(s.plane).toBe('G17');
      expect(s.wcs).toBe('G54');
      expect(s.feed).toBe(900);
      expect(s.spindle).toEqual({ mode: 'M3', rpm: 18000 });
    });

    it('recovers where the tool would be', () => {
      const s = scanModalState(router, 9);
      expect(s.position).toEqual({ x: 60, y: 20, z: -3 });
    });

    it('takes the retract height from the whole program, not just the part that ran', () => {
      // At line 8 the only Z commanded so far is the -3 plunge; the program's
      // own clear height is the +5 that comes later, and that is what a resume
      // has to traverse at.
      const s = scanModalState(router, 8);
      expect(s.position.z).toBe(-3);
      expect(s.safeZ).toBe(5);
    });

    it('follows the spindle being switched off', () => {
      expect(scanModalState(router, 13).spindle).toBeNull();
    });

    it('tracks an S word that changes without restarting the spindle', () => {
      const laser = ['G21', 'G90', 'M3 S1000', 'G1 X5 F600', 'S250', 'G1 X10'];
      expect(scanModalState(laser, 6).spindle).toEqual({ mode: 'M3', rpm: 250 });
    });

    it('accumulates incremental moves rather than reading them as positions', () => {
      const inc = ['G21', 'G90', 'G0 X10 Y10', 'G91', 'G1 X5', 'G1 X5', 'G1 Y-2'];
      const s = scanModalState(inc, 7);
      expect(s.distance).toBe('G91');
      expect(s.position).toEqual({ x: 20, y: 8, z: null });
    });

    it('does not move the tool on a line that only sets a word', () => {
      const s = scanModalState(['G21', 'G90', 'G0 X10 Y10', 'S5000', 'M5'], 5);
      expect(s.position).toEqual({ x: 10, y: 10, z: null });
    });

    it('flags a program whose coordinates it cannot honestly replay', () => {
      const s = scanModalState(['G21', 'G90', 'G0 X10', 'G92 X0', 'G1 X5'], 5);
      expect(s.uncertain).toBe(true);
      expect(s.uncertainBecause).toMatch(/G92/);
    });

    it('leaves a clean program unflagged', () => {
      expect(scanModalState(router, 9).uncertain).toBe(false);
    });
  });

  describe('the preamble for a router', () => {
    const plan = planResume(router, 9, { plungeFeed: 250 });

    it('retracts, restarts the spindle, positions, then descends — in that order', () => {
      const body = plan.preamble.filter((l) => !l.startsWith(';'));
      const idx = (re: RegExp) => body.findIndex((l) => re.test(l));

      expect(idx(/^G0 Z5\.000/)).toBeGreaterThanOrEqual(0);
      expect(idx(/^M3 S18000/)).toBeGreaterThan(idx(/^G0 Z5\.000/));
      expect(idx(/^G0 X60\.000 Y20\.000/)).toBeGreaterThan(idx(/^M3 S18000/));
      expect(idx(/^G1 Z-3\.000 F250/)).toBeGreaterThan(idx(/^G0 X60\.000 Y20\.000/));
    });

    it('descends at a feedrate rather than rapiding into the stock', () => {
      const plunge = plan.preamble.find((l) => /Z-3\.000/.test(l));
      expect(plunge).toMatch(/^G1 /);
      expect(plunge).toMatch(/F250/);
    });

    it('lets the spindle come up to speed before it is used', () => {
      const body = plan.preamble.filter((l) => !l.startsWith(';'));
      const spindle = body.findIndex((l) => /^M3 /.test(l));
      expect(body[spindle + 1]).toMatch(/^G4 P2/);
    });

    it('restores the units, distance mode, plane, work offset and feed', () => {
      const joined = plan.preamble.join('\n');
      expect(joined).toContain('G21');
      expect(joined).toContain('G90');
      expect(joined).toContain('G17');
      expect(joined).toContain('G54');
      expect(joined).toMatch(/^F900/m);
    });

    it('clears by the extra height it is given', () => {
      const p = buildResumePreamble(scanModalState(router, 9), 9, { extraClearance: 10 });
      expect(p.join('\n')).toContain('G0 Z15.000');
    });
  });

  describe('the preamble for a laser', () => {
    // No Z anywhere, which is what makes it a laser.
    const laser = [
      'G21', 'G90', 'G17',
      'G0 X10.000 Y10.000',
      'M3 S800',
      'G1 X50.000 Y10.000 F1200',
      'G1 X50.000 Y40.000',
      'M5',
    ];

    it('positions before restoring the beam, not after', () => {
      const body = planResume(laser, 7).preamble.filter((l) => !l.startsWith(';'));
      const move = body.findIndex((l) => /^G0 X50\.000 Y40\.000/.test(l));
      const beam = body.findIndex((l) => /^M3 S800/.test(l));

      expect(move).toBeGreaterThanOrEqual(0);
      expect(beam).toBeGreaterThan(move);
    });

    it('commands no Z at all', () => {
      expect(planResume(laser, 7).preamble.join('\n')).not.toMatch(/\bZ-?\d/);
    });
  });

  describe('resuming a real exported program', () => {
    const zero = { x: 0, y: 0, z: 0 };
    const panel: LaserPanel = {
      id: 'sq', name: 'Square', thickness: 0.003,
      origin3D: zero, normal3D: { x: 0, y: 0, z: 1 },
      uAxis3D: { x: 1, y: 0, z: 0 }, vAxis3D: { x: 0, y: 1, z: 0 },
      outerPolygon2D: [
        { x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 80 }, { x: 0, y: 80 },
      ] as Point2D[],
      innerCutouts2D: [],
      edges3D: [], placedPos2D: { x: 0, y: 0 }, width2D: 120, height2D: 80,
    };

    it('picks a router job back up mid-cut with the spindle and depth restored', () => {
      const res = generateLaserCutGcode([panel], {
        ...DEFAULT_GCODE_OPTIONS,
        machineMode: 'cnc',
        spindleRpm: 16000,
        cutDepthZ: 6,
        zStepdown: 2,
        safeZ: 5,
      });
      const lines = prepareJobLines(res.gcode).map((l) => l.code);

      // Somewhere in the middle of the cutting, rather than in the header.
      const cutting = lines.findIndex((l) => /^G1 X/.test(l));
      const at = cutting + 5;
      const plan = planResume(lines, at);

      expect(plan.state.uncertain).toBe(false);
      expect(plan.state.spindle).toEqual({ mode: 'M3', rpm: 16000 });
      // Deep in a stepdown pass, so the tool is below the surface.
      expect(plan.state.position.z).toBeLessThan(0);
      expect(plan.state.safeZ).toBe(5);

      const joined = plan.preamble.join('\n');
      expect(joined).toContain('M3 S16000');
      expect(joined).toContain('G0 Z5.000');
      expect(joined).toMatch(/G1 Z-\d+\.\d+ F\d+/);
    });

    it('clamps a line number past the end of the program', () => {
      const res = generateLaserCutGcode([panel], { ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser' });
      const lines = prepareJobLines(res.gcode).map((l) => l.code);
      expect(planResume(lines, 999999).fromLine).toBe(lines.length);
      expect(planResume(lines, -5).fromLine).toBe(0);
    });
  });
});
