import { describe, it, expect } from 'vitest';
import { generateLaserCutGcode, generateContourSliceGcode, generateFramingGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS } from '../src/utils/laserCutExporter';
import { exportContourSliceSvg, DEFAULT_CONTOUR_OPTIONS } from '../src/utils/contourSliceExporter';
import { birdhousePreset } from '../src/presets/presetScenes';

describe('G-Code Generator Engine', () => {
  it('generates laser mode G-code for birdhouse panels with interior cutouts first', () => {
    const laserResult = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);
    expect(laserResult.success).toBe(true);

    const gcodeResult = generateLaserCutGcode(laserResult.panels!, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
    });

    expect(gcodeResult.success).toBe(true);
    expect(gcodeResult.gcode).toContain('G21');
    expect(gcodeResult.gcode).toContain('G90');
    expect(gcodeResult.gcode).toContain('M3 S10000'); // default $30=10000, full power
    expect(gcodeResult.gcode).toContain('M5');
    expect(gcodeResult.totalCutDistanceMm).toBeGreaterThan(100);
    expect(gcodeResult.estimatedTimeSeconds).toBeGreaterThan(0);

    // Verify cutout comes before outer outline for panel with holes
    const panelWithHoles = laserResult.panels!.find(p => p.innerCutouts2D.length > 0);
    expect(panelWithHoles).toBeDefined();

    const cutoutOpIdx = gcodeResult.operations.findIndex(o => o.id === `${panelWithHoles!.id}_cutout_0`);
    const outerOpIdx = gcodeResult.operations.findIndex(o => o.id === `${panelWithHoles!.id}_outer`);
    expect(cutoutOpIdx).toBeGreaterThanOrEqual(0);
    expect(outerOpIdx).toBeGreaterThan(cutoutOpIdx);
  });

  it('generates multi-pass CNC routing G-code with Z safe heights', () => {
    const laserResult = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);

    const cncResult = generateLaserCutGcode(laserResult.panels!, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      cutDepthZ: 6.0,
      zStepdown: 3.0,
      safeZ: 5.0,
    });

    expect(cncResult.success).toBe(true);
    expect(cncResult.gcode).toContain('G0 Z5.000');
    expect(cncResult.gcode).toContain('Pass 1/2 (Z = -3.000mm)');
    expect(cncResult.gcode).toContain('Pass 2/2 (Z = -6.000mm)');
    expect(cncResult.gcode).toContain('M3 S12000');
  });

  it('retraces each laser path once per requested pass', () => {
    const laserResult = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);

    const single = generateLaserCutGcode(laserResult.panels!, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
    });
    const triple = generateLaserCutGcode(laserResult.panels!, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
      laserPasses: 3,
    });

    // One pass stays unannotated; three passes annotate and triple the cutting travel.
    expect(single.gcode).not.toContain('; Pass ');
    expect(triple.gcode).toContain('; Pass 1/3');
    expect(triple.gcode).toContain('; Pass 3/3');
    // Both totals are rounded to whole mm, so allow a mm of rounding drift.
    expect(triple.totalCutDistanceMm).toBeCloseTo(single.totalCutDistanceMm * 3, -0.5);

    // The beam is struck once per loop, not once per pass.
    const strikes = (s: string) => (s.match(/^M3 S/gm) || []).length;
    expect(strikes(triple.gcode)).toBe(strikes(single.gcode));
  });

  it('scales power to the controller $30 ceiling', () => {
    const laserResult = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);

    const full = generateLaserCutGcode(laserResult.panels!, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
      laserMaxPower: 10000,
      laserPower: 10000,
    });
    expect(full.gcode).toContain('M3 S10000');
    expect(full.gcode).toContain('$30=10000');

    // A power above the machine's ceiling is clamped rather than emitted verbatim.
    const overdriven = generateLaserCutGcode(laserResult.panels!, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
      laserMaxPower: 1000,
      laserPower: 10000,
    });
    expect(overdriven.gcode).toContain('M3 S1000');
    expect(overdriven.gcode).not.toContain('M3 S10000');
  });

  it('rescales the framing guide power to the controller $30 ceiling', () => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const framing = generateFramingGcode(bounds, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
      laserGuidePower: 5,
      laserMaxPower: 10000,
    });

    // S5 on a $30=10000 machine would be invisible; 0.5% of 10000 is S50.
    expect(framing).toContain('M3 S50 ; Low power guide dot');
  });

  it('generates low-power laser framing guide trace', () => {
    const bounds = { minX: 10, minY: 10, maxX: 200, maxY: 150 };
    const framingGcode = generateFramingGcode(bounds, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
      laserGuidePower: 5,
      laserMaxPower: 1000,
    });

    expect(framingGcode).toContain('M3 S5 ; Low power guide dot');
    expect(framingGcode).toContain('X200.000 Y10.000');
    expect(framingGcode).toContain('X200.000 Y150.000');
    expect(framingGcode).toContain('M5');
  });

  it('generates G-code for stacked contour slices', () => {
    const contourResult = exportContourSliceSvg(birdhousePreset, DEFAULT_CONTOUR_OPTIONS);
    expect(contourResult.success).toBe(true);

    const gcodeResult = generateContourSliceGcode(contourResult, DEFAULT_GCODE_OPTIONS);

    expect(gcodeResult.success).toBe(true);
    expect(gcodeResult.gcode).toContain('CONTOUR LAYER 1 of');
    expect(gcodeResult.sheetCount).toBeGreaterThan(0);
  });
});
