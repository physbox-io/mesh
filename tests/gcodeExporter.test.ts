import { describe, it, expect } from 'vitest';
import { generateLaserCutGcode, generateContourSliceGcode, generateFramingGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS, type LaserPanel, type Point2D } from '../src/utils/laserCutExporter';
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

/**
 * A bare 200 mm square panel with one 40 mm square mortise, so attachment counts
 * and positions can be read off by hand: the outline is 800 mm round, the
 * mortise 160 mm.
 */
function squarePanel(): LaserPanel {
  const zero = { x: 0, y: 0, z: 0 };
  const square = (o: number, s: number): Point2D[] => [
    { x: o, y: o }, { x: o + s, y: o }, { x: o + s, y: o + s }, { x: o, y: o + s },
  ];
  return {
    id: 'sq', name: 'Square', thickness: 0.003,
    origin3D: zero, normal3D: { x: 0, y: 0, z: 1 },
    uAxis3D: { x: 1, y: 0, z: 0 }, vAxis3D: { x: 0, y: 1, z: 0 },
    outerPolygon2D: square(0, 200),
    innerCutouts2D: [square(80, 40)],
    edges3D: [],
    placedPos2D: { x: 0, y: 0 },
    width2D: 200, height2D: 200,
  };
}

describe('Holding attachments', () => {
  const attached = {
    ...DEFAULT_GCODE_OPTIONS,
    attachmentsEnabled: true,
    attachmentWidthMm: 4,
    attachmentSpacingMm: 100,
    attachmentHeightMm: 0.6,
  };

  it('leaves nothing behind when switched off', () => {
    const res = generateLaserCutGcode([squarePanel()], { ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser' });
    expect(res.attachmentCount).toBe(0);
    expect(res.gcode).not.toContain('attachment');
  });

  it('breaks a laser outline into beam-off gaps at the requested spacing', () => {
    const res = generateLaserCutGcode([squarePanel()], { ...attached, machineMode: 'laser' });

    // 800 mm of outline at 100 mm spacing is eight attachments, on the outline only.
    expect(res.attachmentCount).toBe(8);
    expect((res.gcode.match(/M5 ; attachment/g) || []).length).toBe(8);

    // Each gap ends with the beam coming back on, and the loop still closes with
    // the beam lit rather than part-way through a gap.
    const outline = res.gcode.slice(res.gcode.indexOf('; --- Panel'));
    expect((outline.match(/M3 S/g) || []).length).toBe(1 + 1 + 8); // cutout + outline start + one resume per gap
  });

  it('cuts joinery mortises clean through even with attachments on', () => {
    const res = generateLaserCutGcode([squarePanel()], { ...attached, machineMode: 'laser', attachmentSpacingMm: 40 });
    // The 160 mm mortise would take four at this spacing if it were eligible.
    expect(res.attachmentCount).toBe(800 / 40);
  });

  it('rides the cutter over attachments on the final CNC pass only', () => {
    const res = generateLaserCutGcode([squarePanel()], {
      ...attached, machineMode: 'cnc', cutDepthZ: 6.0, zStepdown: 3.0, attachmentHeightMm: 1.0,
    });

    // 1 mm of stock under a 6 mm cut puts the attachment tops at Z-5, so the
    // pass at -3 mm is still above them and needs no Z at all; only the -6 mm
    // pass rides, and it never dips below the cut depth or above the tab top.
    const passes = res.gcode.split('; Pass ');
    expect(passes[1]).not.toMatch(/G1 X[-\d.]+ Y[-\d.]+ Z/);

    const zs = [...res.gcode.matchAll(/G1 X[-\d.]+ Y[-\d.]+ Z([-\d.]+)/g)].map(m => parseFloat(m[1]));
    expect(zs.length).toBeGreaterThan(0);
    expect(Math.max(...zs)).toBeCloseTo(-5.0, 3);
    expect(Math.min(...zs)).toBeCloseTo(-6.0, 3);

    // The climb to the tab top is a ramp, not a plunge: every Z change happens
    // over a move that also travels in XY.
    const moves = [...res.gcode.matchAll(/G1 X([-\d.]+) Y([-\d.]+) Z([-\d.]+)/g)]
      .map(m => ({ x: +m[1], y: +m[2], z: +m[3] }));
    for (let i = 1; i < moves.length; i++) {
      if (moves[i].z === moves[i - 1].z) continue;
      expect(Math.hypot(moves[i].x - moves[i - 1].x, moves[i].y - moves[i - 1].y)).toBeGreaterThan(0.5);
    }
  });

  it('skips loops too small to hold an attachment without swallowing the part', () => {
    const tiny = squarePanel();
    tiny.outerPolygon2D = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0, y: 5 }];
    const res = generateLaserCutGcode([tiny], { ...attached, machineMode: 'laser', attachmentWidthMm: 6 });
    expect(res.attachmentCount).toBe(0);
  });
});

describe('Multi-sheet jobs', () => {
  /** A 100 mm square nested at a sheet-local spot on the given sheet. */
  const panelAt = (id: string, sheetIndex: number, x: number, y: number): LaserPanel => {
    const base = squarePanel();
    return {
      ...base,
      id,
      name: id,
      outerPolygon2D: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
      ],
      innerCutouts2D: [],
      placedPos2D: { x, y },
      sheetIndex,
      width2D: 100,
      height2D: 100,
    };
  };

  const threeSheets = [panelAt('A', 0, 10, 10), panelAt('B', 1, 10, 10), panelAt('C', 2, 10, 10)];
  const opts = { ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser' as const };

  it('runs one sheet after another in a single program', () => {
    const res = generateLaserCutGcode(threeSheets, opts);
    expect(res.sheetCount).toBe(3);
    expect(res.gcode).toContain('; SHEET 1 of 3');
    expect(res.gcode).toContain('; SHEET 3 of 3');
  });

  it('pauses for a sheet swap between sheets, but not before the first', () => {
    const res = generateLaserCutGcode(threeSheets, opts);
    const pauses = res.gcode.match(/M0 \(PAUSE: Insert Material Sheet .*?\)/g) || [];
    expect(pauses).toEqual([
      'M0 (PAUSE: Insert Material Sheet 2 of 3)',
      'M0 (PAUSE: Insert Material Sheet 3 of 3)',
    ]);
  });

  it('cuts every sheet against the same XY zero', () => {
    const res = generateLaserCutGcode(threeSheets, opts);
    // Each sheet is loaded against the same corner, so no cut may reach past
    // the sheet height — sheet 3 at drawing y 810 belongs at machine y 10.
    const ys = [...res.gcode.matchAll(/Y(-?\d+\.\d+)/g)].map((m) => parseFloat(m[1]));
    expect(Math.max(...ys)).toBeLessThanOrEqual(400);
    expect(res.bounds.maxY).toBeCloseTo(110);
    // All three squares cut the identical path.
    const perSheet = res.gcode.split(/; SHEET \d+ of 3/).slice(1);
    expect(perSheet).toHaveLength(3);
    const strip = (s: string) =>
      s.split('; --- Panel')[1].split('; --- PAUSE')[0].split('; --- PROGRAM END')[0]
        .replace(/^.*---\n/, ''); // drop the panel's own name line
    expect(strip(perSheet[1])).toBe(strip(perSheet[0]));
    expect(strip(perSheet[2])).toBe(strip(perSheet[0]));
  });

  it('asks for no swap when everything nested onto one sheet', () => {
    const oneSheet = [panelAt('A', 0, 10, 10), panelAt('B', 0, 10, 610)];
    const res = generateLaserCutGcode(oneSheet, opts);
    expect(res.sheetCount).toBe(1);
    expect(res.gcode).not.toContain('PAUSE: Insert Material Sheet');
  });
});

describe('Cutter compensation', () => {
  /** Every X the program actually moves to. */
  const xsOf = (gcode: string): number[] =>
    gcode.split('\n')
      .map((l) => l.match(/^G[01] X(-?[\d.]+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => parseFloat(m[1]));

  it('runs the tool outside the outline and inside the holes on a router', () => {
    const res = generateLaserCutGcode([squarePanel()], {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      bitDiameterMm: 6,
    });

    expect(res.compensationMm).toBe(3);
    const xs = xsOf(res.gcode);
    // The 200mm outline is cut with the tool 3mm outside it on both sides...
    expect(Math.min(...xs)).toBeCloseTo(-3, 3);
    expect(Math.max(...xs)).toBeCloseTo(203, 3);
    // ...and the 40mm cutout at x=80..120 with the tool 3mm inside it.
    const insideHole = xs.filter((x) => x > 50 && x < 150);
    expect(Math.min(...insideHole)).toBeCloseTo(83, 3);
    expect(Math.max(...insideHole)).toBeCloseTo(117, 3);
  });

  it('cuts on the line when switched off', () => {
    const res = generateLaserCutGcode([squarePanel()], {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      bitDiameterMm: 6,
      cutterCompensation: 'off',
    });

    expect(res.compensationMm).toBe(0);
    const xs = xsOf(res.gcode);
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(200, 3);
  });

  it('leaves a laser alone, since its kerf is already in the geometry', () => {
    const res = generateLaserCutGcode([squarePanel()], {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'laser',
      bitDiameterMm: 6,
    });

    expect(res.compensationMm).toBe(0);
    const xs = xsOf(res.gcode);
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(200, 3);
  });

  it('reports the bounds the tool reaches, not the bounds of the parts', () => {
    const res = generateLaserCutGcode([squarePanel()], {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      bitDiameterMm: 6,
    });
    expect(res.bounds.minX).toBeCloseTo(-3, 3);
    expect(res.bounds.maxX).toBeCloseTo(203, 3);
  });

  it('warns about a cutout the bit cannot enter instead of dropping it silently', () => {
    const panel = squarePanel();
    panel.innerCutouts2D.push([
      { x: 10, y: 10 }, { x: 14, y: 10 }, { x: 14, y: 14 }, { x: 10, y: 14 },
    ]);

    const res = generateLaserCutGcode([panel], {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      bitDiameterMm: 6,
    });

    expect(res.warnings).toBeDefined();
    expect(res.warnings!.join(' ')).toMatch(/4\.000mm across is narrower than the 6\.000mm cutter/);
    // The cutout that does fit is still cut.
    expect(res.operations.filter((o) => o.id.includes('cutout'))).toHaveLength(1);
  });

  it('keeps the joinery at nominal size, which is the whole point', () => {
    // A 10mm-wide tab on the outline and a 10mm mortise. Cut on the line with a
    // 6mm bit the tab would come out 4mm and the mortise 16mm — neither would
    // ever fit. Compensated, both stay 10mm.
    const zero = { x: 0, y: 0, z: 0 };
    const tabbed: LaserPanel = {
      id: 't', name: 'Tabbed', thickness: 0.003,
      origin3D: zero, normal3D: { x: 0, y: 0, z: 1 },
      uAxis3D: { x: 1, y: 0, z: 0 }, vAxis3D: { x: 0, y: 1, z: 0 },
      outerPolygon2D: [
        { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 },
        { x: 55, y: 50 }, { x: 55, y: 60 }, { x: 45, y: 60 }, { x: 45, y: 50 },
        { x: 0, y: 50 },
      ],
      innerCutouts2D: [],
      edges3D: [], placedPos2D: { x: 0, y: 0 }, width2D: 100, height2D: 60,
    };

    const res = generateLaserCutGcode([tabbed], {
      ...DEFAULT_GCODE_OPTIONS,
      machineMode: 'cnc',
      bitDiameterMm: 6,
    });

    // The tool's centre passes 3mm either side of the 10mm tab, so the path
    // spans 16mm there and the tab it leaves behind is 10mm.
    const ys = res.gcode.split('\n')
      .map((l) => l.match(/^G[01] X(-?[\d.]+) Y(-?[\d.]+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => ({ x: parseFloat(m[1]), y: parseFloat(m[2]) }));

    // The tab's two top corners are convex, so the path rounds them at the
    // cutter's radius: the extremes in x sit at the tangent points, level with
    // the base of the arc at y = 60.
    const atTab = ys.filter((p) => p.y >= 59.999).map((p) => p.x);
    expect(Math.min(...atTab)).toBeCloseTo(42, 3);
    expect(Math.max(...atTab)).toBeCloseTo(58, 3);
    // And the top of the tab is cleared by a full radius.
    expect(Math.max(...ys.map((p) => p.y))).toBeCloseTo(63, 3);
  });
});
