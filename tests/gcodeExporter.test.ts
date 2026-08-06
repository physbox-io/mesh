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
    expect(gcodeResult.gcode).toContain('M3 S1000');
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

  it('generates low-power laser framing guide trace', () => {
    const bounds = { minX: 10, minY: 10, maxX: 200, maxY: 150 };
    const framingGcode = generateFramingGcode(bounds, {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
      laserGuidePower: 5,
    });

    expect(framingGcode).toContain('M3 S5');
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
