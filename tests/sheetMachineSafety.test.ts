// What the sheet exporters hand a router or laser: where Z really is on a mixed
// rack, what can reach a controller through a part's name, and what is refused.

import { describe, it, expect } from 'vitest';
import { planResume, scanModalState, warpGcode } from '@physbox-io/machining';
import { DEFAULT_GCODE_OPTIONS, generateContourSliceGcode, generateLaserCutGcode } from '../src/utils/gcodeExporter';
import { DEFAULT_LASER_OPTIONS, exportLaserCutSvg, type LaserPanel } from '../src/utils/laserCutExporter';
import { DEFAULT_CONTOUR_OPTIONS, exportContourSliceSvg } from '../src/utils/contourSliceExporter';
import { commentText } from '../src/utils/gcodeComments';
import { prepareJobLines } from '../src/utils/machineJobLines';
import { generateWindowGcode } from '../src/utils/timberCutList';
import { measureGcodeBounds } from '../src/utils/workEnvelope';
import {
  canStartSheetJob, layoutMargin, machineLaserMax, retargetLaserPowers, routerStepdownMm,
} from '../src/utils/sheetCutRecipe';
import { castingFlaskPreset } from '../src/presets/presetScenes';
import type { SceneGraph } from '../src/types/scene';

const panel = (id: string, thicknessMm: number, sheetIndex: number, name = id): LaserPanel =>
  ({
    id, name,
    thickness: thicknessMm / 1000,
    origin3D: { x: 0, y: 0, z: 0 },
    normal3D: { x: 0, y: 0, z: 1 },
    uAxis3D: { x: 1, y: 0, z: 0 },
    vAxis3D: { x: 0, y: 1, z: 0 },
    outerPolygon2D: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }],
    innerCutouts2D: [],
    edges3D: [],
    width2D: 100,
    height2D: 60,
    placedPos2D: { x: 20, y: 30 },
    sheetIndex,
  }) as unknown as LaserPanel;

const cnc = { ...DEFAULT_GCODE_OPTIONS, machineMode: 'cnc' as const, zStepdown: 3 };

/** The program from "SHEET n" to the next sheet's pause or the end. */
const sheetBlock = (gcode: string, n: number) => {
  const from = gcode.indexOf(`; SHEET ${n} of`);
  const pause = gcode.indexOf('; --- PAUSE', from);
  return gcode.slice(from, pause < 0 ? undefined : pause).split('\n');
};
const zsOf = (lines: string[]) =>
  lines.filter((l) => /^G[01]\b/.test(l)).flatMap((l) => {
    const m = /Z(-?[\d.]+)/.exec(l.split(';')[0]);
    return m ? [parseFloat(m[1])] : [];
  });
const before = (gcode: string, line: RegExp) => {
  const all = gcode.split('\n');
  return all.slice(0, all.findIndex((l) => line.test(l)));
};

describe('a mixed-thickness rack on one bed, zeroed once on the first sheet', () => {
  const thinThenThick = () =>
    generateLaserCutGcode([panel('thin', 6, 0), panel('thick', 12, 1)], {
      ...cnc, cutDepthZ: 6, sheetStockThicknessMm: [6, 12],
    });

  it('raises every Z on a thicker sheet by the difference', () => {
    const zs = zsOf(sheetBlock(thinThenThick().gcode, 2));
    expect(Math.max(...zs)).toBeCloseTo(11, 3); // 5 clear of a top at +6
    expect(zs).toContain(3); // the first 3 mm off the top
    expect(Math.min(...zs)).toBeCloseTo(-6.2, 3);
  });

  it('reaches a sheet at that sheet\'s safe height before crossing it', () => {
    const block = sheetBlock(thinThenThick().gcode, 2);
    const firstXY = block.findIndex((l) => /^G0 X/.test(l));
    expect(block.slice(0, firstXY).filter((l) => /^G0 Z/.test(l)).pop()).toBe('G0 Z11.000');
    // Lifted before the swap too, so the tool parks clear of the sheet going on.
    const atPause = before(thinThenThick().gcode, /^M0/);
    expect(atPause.filter((l) => /^G0 Z/.test(l)).pop()).toBe('G0 Z11.000');
  });

  it('leaves the bed-side retract at the end on the last sheet\'s height', () => {
    const zLines = thinThenThick().gcode.split('\n').filter((l) => /^G0 Z/.test(l));
    expect(zLines[zLines.length - 1]).toBe('G0 Z11.000');
  });

  it('clears a thicker sheet in any order', () => {
    const r = generateLaserCutGcode([panel('thick', 12, 0), panel('thin', 6, 1)], {
      ...cnc, cutDepthZ: 12, sheetStockThicknessMm: [12, 6],
    });
    const atPause = before(r.gcode, /^M0/);
    expect(atPause.filter((l) => /^G0 Z/.test(l)).pop()).toBe('G0 Z5.000');
    const zs = zsOf(sheetBlock(r.gcode, 2));
    expect(Math.max(...zs)).toBeCloseTo(-1, 3); // 5 clear of a top at -6
    expect(Math.min(...zs)).toBeCloseTo(-12.2, 3); // the same bed
  });

  it('cuts every sheet down to the same bed', () => {
    const r = generateLaserCutGcode([panel('a', 3, 0), panel('b', 6, 1), panel('c', 12, 2)], {
      ...cnc, cutDepthZ: 3, sheetStockThicknessMm: [3, 6, 12],
    });
    for (const n of [1, 2, 3]) expect(Math.min(...zsOf(sheetBlock(r.gcode, n)))).toBeCloseTo(-3.2, 3);
  });

  it('keeps tabs the same height off the bed', () => {
    const r = generateLaserCutGcode([panel('a', 6, 0), panel('b', 12, 1)], {
      ...cnc, cutDepthZ: 6, sheetStockThicknessMm: [6, 12], attachmentsEnabled: true, attachmentHeightMm: 0.6,
    });
    for (const n of [1, 2]) expect(sheetBlock(r.gcode, n).some((l) => /^G1 X.* Z-5\.400/.test(l))).toBe(true);
  });

  it('keeps comments out of it', () => {
    const r = generateLaserCutGcode([panel('a', 6, 0), panel('b', 12, 1, 'Z9 shelf')], {
      ...cnc, cutDepthZ: 6, sheetStockThicknessMm: [6, 12],
    });
    const block = sheetBlock(r.gcode, 2);
    expect(block).toContain('; Pass 1/4 (Z = -3.000mm)');
    expect(block).toContain('; --- Panel: Z9 shelf ---');
  });

  it('starts counting from a sheet a new bit was touched off on', () => {
    const r = generateLaserCutGcode([panel('a', 8, 0), panel('b', 8, 1)], {
      ...cnc, cutDepthZ: 10, sheetStockThicknessMm: [10, 14], faceToThickness: true,
    });
    const lines = r.gcode.split('\n');
    const m6 = lines.map((l, i) => (/M6\b/.test(l) ? i : -1)).filter((i) => i >= 0);
    const swap = lines.findIndex((l) => /^M0/.test(l));
    const onSecond = m6.find((i) => i > swap)!;
    // Lifted on the old zero, 4 mm higher for the thicker sheet.
    expect(lines.slice(0, onSecond).filter((l) => /^G0 Z/.test(l)).pop()).toBe('G0 Z24.000');
    // After it, Z0 is that sheet's top: plain depths, right through 14 mm.
    const after = zsOf(lines.slice(onSecond));
    expect(Math.min(...after)).toBeCloseTo(-14.2, 3);
    expect(lines[onSecond + 1]).toBe('G0 Z20.000 ; back to travel height after the change');
  });

  it('gives the program readers one clear height, the highest', () => {
    const r = thinThenThick();
    const code = prepareJobLines(r.gcode).map((l) => l.code);
    expect(scanModalState(code, 0).safeZ).toBeCloseTo(11, 3);
    // Picking the job back up on the first sheet still clears the second.
    const firstCut = code.findIndex((l) => /^G1 X/.test(l));
    const resume = planResume(code, firstCut + 2);
    expect(resume.preamble.find((l) => /^G0 Z/.test(l))).toMatch(/^G0 Z11\.000/);
  });

  it('reports the true Z range, and warping leaves the shift alone', () => {
    const r = thinThenThick();
    expect(r.bounds.maxZ).toBeCloseTo(11, 3);
    expect(r.bounds.minZ).toBeCloseTo(-6.2, 3);
    expect(measureGcodeBounds(r.gcode)?.maxZ).toBeCloseTo(11, 3);
    const level = warpGcode(r.gcode, {
      minX: 0, minY: 0, maxX: 200, maxY: 200, gridX: 2, gridY: 2,
      points: [[{ x: 0, y: 0, z: 0 }, { x: 200, y: 0, z: 0 }], [{ x: 0, y: 200, z: 0 }, { x: 200, y: 200, z: 0 }]],
    } as never);
    expect(measureGcodeBounds(level)?.maxZ).toBeCloseTo(11, 3);
    expect(r.estimatedTimeSeconds).toBeGreaterThan(0);
  });

  it('writes one thickness exactly as before', () => {
    const plain = generateLaserCutGcode([panel('a', 6, 0), panel('b', 6, 1)], { ...cnc, cutDepthZ: 6 });
    const same = generateLaserCutGcode([panel('a', 6, 0), panel('b', 6, 1)], { ...cnc, cutDepthZ: 6, sheetStockThicknessMm: [6, 6] });
    const body = (g: string) => g.split('\n').filter((l) => !/^; Date/.test(l)).join('\n');
    expect(body(same.gcode)).toBe(body(plain.gcode));
  });

  it('stays a router matter', () => {
    const r = generateLaserCutGcode([panel('a', 6, 0), panel('b', 12, 1)], {
      ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser', sheetStockThicknessMm: [6, 12],
    });
    expect(r.gcode).not.toMatch(/^G\d .*Z/m);
  });
});

describe('names in G-code comments', () => {
  const nasty = 'evil\nG1 Z-50 F3000\r\nM3 S10000 G0 X9\u0007';

  it('strips line breaks and control characters', () => {
    expect(commentText(nasty)).toBe('evil G1 Z-50 F3000 M3 S10000 G0 X9');
  });

  it('keeps a part name in its panel and facing comments', () => {
    const r = generateLaserCutGcode([panel('a', 8, 0, nasty)], {
      ...cnc, cutDepthZ: 10, sheetStockThicknessMm: [10], faceToThickness: true,
    });
    const code = prepareJobLines(r.gcode).map((l) => l.code);
    expect(code.some((l) => /Z-50|S10000|X9$/.test(l))).toBe(false);
    expect(r.gcode.split('\n').filter((l) => l.includes('evil'))).toHaveLength(2);
  });

  it('keeps timber ids and labels in theirs', () => {
    const { gcode } = generateWindowGcode({
      setupId: nasty, partId: nasty, faceUpLabel: nasty, fenceFaceLabel: nasty, indexOffsetFromTopMm: 0,
      cutterDiaMm: 6, spindleRpm: 12000, feedRate: 800, plungeRate: 250, stepdownMm: 2,
      mortises: [{ id: nasty, centerXMm: 20, centerYMm: 40, thicknessXMm: 10, widthYMm: 30, depthMm: 6, dogbone: false }],
      zClips: [],
    } as never);
    expect(prepareJobLines(gcode).map((l) => l.code).some((l) => /Z-50|S10000|X9$/.test(l))).toBe(false);
  });
});

describe('depth per pass', () => {
  it('never exceeds the bit, and leaves the 3.175 mm default alone', () => {
    expect(routerStepdownMm(6, 3.175)).toBe(3);
    expect(routerStepdownMm(2, 3.175)).toBe(2);
    expect(routerStepdownMm(6, 1)).toBe(1);
  });

  it('turns into that many passes', () => {
    const r = generateLaserCutGcode([panel('a', 3, 0)], { ...cnc, cutDepthZ: 3, zStepdown: routerStepdownMm(3, 1), bitDiameterMm: 1 });
    expect(r.gcode.match(/^G1 Z-/gm)).toHaveLength(3);
  });
});

describe('holding tabs', () => {
  const small = (w: number, h: number) => {
    const p = panel('a', 6, 0);
    p.outerPolygon2D = [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];
    p.width2D = w;
    p.height2D = h;
    return p;
  };
  const tabs = (w: number, h: number) =>
    generateLaserCutGcode([small(w, h)], { ...cnc, cutDepthZ: 6, attachmentsEnabled: true }).attachmentCount;

  it('holds a small part by two, not one or none', () => {
    expect(tabs(9, 9)).toBe(2);
    expect(tabs(15, 15)).toBe(2);
    expect(tabs(5, 5)).toBe(2);
  });

  it('leaves the count alone where the spacing already gives more', () => {
    expect(tabs(60, 60)).toBe(3);
  });

  it('stays off unless asked for', () => {
    expect(DEFAULT_GCODE_OPTIONS.attachmentsEnabled).toBe(false);
  });
});

const box = (id: string, w: number, h: number, t: number) => ({
  id, name: id, type: 'body', pos: [0, 0, t / 2000], joints: [], children: [],
  geoms: [{ name: `g${id}`, type: 'box', size: [w / 2000, h / 2000, t / 2000] }],
});
const scene = (...nodes: unknown[]) => ({ nodes }) as unknown as SceneGraph;
const tower = () => ({
  nodes: [{ id: 'b', name: 'b', pos: [0, 0, 0.03], joints: [], children: [], geoms: [{ type: 'box', size: [0.03, 0.03, 0.03] }] }],
}) as unknown as SceneGraph;

describe('a rack that runs out', () => {
  const rack = (quantity: number) => [{ widthMm: 300, heightMm: 300, thicknessMm: 6, quantity }];
  const four = () => scene(box('a', 200, 200, 6), box('b', 200, 200, 6), box('c', 200, 200, 6), box('d', 200, 200, 6));

  it('refuses the job, and says what to change', () => {
    const r = exportLaserCutSvg(four(), { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0, stock: rack(2) });
    expect(r.success).toBe(false);
    expect(r.panels).toBeUndefined();
    expect(r.error).toMatch(/run out of stock for .*Add stock/);
  });

  it('cuts a split piece from its parent\'s stock, not the first row\'s', () => {
    const r = exportLaserCutSvg(castingFlaskPreset, {
      ...DEFAULT_LASER_OPTIONS, materialThickness: 0.055, splitOversized: true,
      stock: [{ widthMm: 320, heightMm: 40, thicknessMm: 60, quantity: 16 }],
    });
    expect(r.success).toBe(true);
    expect(r.panels!.length).toBeGreaterThan(2);
    for (const p of r.panels!) expect(p.placedPos2D).toBeDefined();
    expect(r.sheets!.every((sheet) => sheet.thicknessMm === 60)).toBe(true);
  });

  it('fits when there is enough', () => {
    const r = exportLaserCutSvg(four(), { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0, stock: rack(4) });
    expect(r.success).toBe(true);
    for (const p of r.panels!) expect(p.placedPos2D!.y + p.height2D!).toBeLessThanOrEqual(300);
  });

  it('lets Auto Scale shrink the job onto what there is', () => {
    const r = exportLaserCutSvg(four(), { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0, stock: rack(1), autoScale: true });
    expect(r.success).toBe(true);
    expect(r.scaleFactor!).toBeLessThan(1);
  });

  it('takes a part to the stock that holds it, past a bigger piece that does not', () => {
    const r = exportLaserCutSvg(scene(box('a', 280, 280, 6)), {
      ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0,
      stock: [{ widthMm: 200, heightMm: 2000, thicknessMm: 6, quantity: null }, { widthMm: 300, heightMm: 300, thicknessMm: 6, quantity: 1 }],
    });
    expect(r.success).toBe(true);
    expect(r.sheets![r.panels![0].sheetIndex!].widthMm).toBe(300);
  });
});

describe('the gap round a part on a router', () => {
  it('holds the default 8 mm for the default bit, and for any laser', () => {
    expect(layoutMargin('cnc', 0.003175)).toBe(0.008);
    expect(layoutMargin('laser', 0.012)).toBe(0.008);
  });

  it('grows past 8 mm with the bit, on the panel packer', () => {
    const margin = layoutMargin('cnc', 0.012);
    const r = exportLaserCutSvg(scene(box('a', 100, 100, 6), box('b', 100, 100, 6)), {
      ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0, bitDiameter: 0.012, margin,
    });
    const [a, b] = r.panels!;
    expect(a.placedPos2D!.x).toBeCloseTo(13, 6);
    expect(b.placedPos2D!.x - (a.placedPos2D!.x + a.width2D!)).toBeCloseTo(13, 6);
  });

  it('and on the contour packer', () => {
    const r = exportContourSliceSvg(tower(), {
      ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.02, kerf: 0, pinHoles: false, margin: layoutMargin('cnc', 0.012),
    });
    const [a, b] = r.layers!;
    expect(a.placedPos2D!.x).toBeCloseTo(13, 6);
    expect(b.placedPos2D!.x - (a.placedPos2D!.x + a.width2D!)).toBeCloseTo(13, 6);
  });
});

describe('Start with a part off its sheet', () => {
  const good = { success: true };

  it('is off for a panel that overhangs', () => {
    const r = exportLaserCutSvg(scene(box('a', 900, 100, 6)), { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0 });
    expect(r.warnings!.join()).toMatch(/Too big/);
    expect(canStartSheetJob(r, good)).toBe(false);
  });

  it('stays on for a panel on the sheet that is only short of its far margin', () => {
    const r = exportLaserCutSvg(scene(box('a', 288, 100, 6)), {
      ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0, sheetWidth: 0.3, sheetHeight: 0.3,
    });
    expect(r.oversized!.length).toBe(1);
    expect(canStartSheetJob(r, good)).toBe(true);
  });

  it('is off for a contour layer that overhangs', () => {
    const r = exportContourSliceSvg(tower(), { ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.02, sheetWidth: 0.05, sheetHeight: 0.05 });
    expect(r.warnings!.join()).toMatch(/Too big/);
    expect(canStartSheetJob(r, good)).toBe(false);
  });

  it('is on when everything fits and the program is good', () => {
    const r = exportLaserCutSvg(scene(box('a', 100, 100, 6)), { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0 });
    expect(canStartSheetJob(r, good)).toBe(true);
    expect(canStartSheetJob(r, { success: false })).toBe(false);
    expect(canStartSheetJob(r, null)).toBe(false);
  });
});

describe('through-cuts', () => {
  it('go 0.2 mm under the stock in the same number of passes', () => {
    const r = generateLaserCutGcode([panel('a', 6, 0)], { ...cnc, cutDepthZ: 6 });
    expect(r.gcode.match(/^G1 Z.*/gm)).toEqual(['G1 Z-3.000 F300', 'G1 Z-6.200 F300']);
  });

  it('take no extra pass on stock that is a whole number of steps', () => {
    const r = generateLaserCutGcode([panel('a', 3, 0)], { ...cnc, cutDepthZ: 3 });
    expect(r.gcode.match(/^G1 Z.*/gm)).toEqual(['G1 Z-3.200 F300']);
  });

  it('leave tabs their full height', () => {
    const r = generateLaserCutGcode([panel('a', 6, 0)], {
      ...cnc, cutDepthZ: 6, attachmentsEnabled: true, attachmentHeightMm: 0.6,
    });
    const tops = [...r.gcode.matchAll(/^G1 X\S+ Y\S+ Z(-?[\d.]+)/gm)].map((m) => +m[1]);
    expect(Math.max(...tops)).toBeCloseTo(-5.4, 3);
  });

  it('reach under a contour sheet too', () => {
    const slice = exportContourSliceSvg(tower(), { ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.02, kerf: 0, pinHoles: false });
    const r = generateContourSliceGcode(slice, { ...cnc, cutDepthZ: 20 });
    expect(r.bounds.minZ).toBeCloseTo(-20.2, 3);
  });

  it('leave a laser alone', () => {
    const r = generateLaserCutGcode([panel('a', 3, 0)], { ...DEFAULT_GCODE_OPTIONS });
    expect(r.gcode).not.toMatch(/\bZ-/);
  });
});

describe('settings a controller could not be sent', () => {
  it.each([
    ['cnc', { cutDepthZ: 0 }],
    ['cnc', { cutDepthZ: 0, sheetStockThicknessMm: [0] }],
    ['cnc', { cutFeedrate: NaN }],
    ['cnc', { plungeFeedrate: NaN }],
    ['cnc', { spindleRpm: NaN }],
    ['laser', { cutFeedrate: NaN }],
    ['laser', { laserPower: NaN }],
    ['laser', { laserEngravePower: NaN }],
    ['laser', { laserPasses: NaN }],
  ] as const)('are refused: %s %j', (machineMode, bad) => {
    const r = generateLaserCutGcode([panel('a', 6, 0)], { ...DEFAULT_GCODE_OPTIONS, machineMode, ...bad } as never);
    expect(r.success).toBe(false);
    expect(r.gcode).toBe('');
    expect(r.error).toMatch(/^Set the /);
  });

  it('are refused on a contour stack as well', () => {
    const slice = exportContourSliceSvg(tower(), { ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.02, kerf: 0, pinHoles: false });
    expect(generateContourSliceGcode(slice, { ...cnc, cutDepthZ: 0 }).success).toBe(false);
    expect(generateContourSliceGcode(slice, { ...cnc, cutFeedrate: NaN }).success).toBe(false);
  });

  it('a program with nothing to cut is a failure, not a success', () => {
    const r = generateLaserCutGcode([{ ...panel('a', 6, 0), outerPolygon2D: [] }], { ...cnc, cutDepthZ: 6 });
    expect(r.success).toBe(false);
    expect(r.gcode).toBe('');
  });
});

describe('laser S-values follow the controller', () => {
  const connected = { connected: true, motion: { spindle: { max: 1000 } } };

  it('takes $30 from a connected machine', () => {
    expect(machineLaserMax('laser', connected, false)).toBe(1000);
  });

  it('never overrides the operator', () => {
    expect(machineLaserMax('laser', connected, true)).toBeNull();
  });

  it('has nothing to say unconnected, unreported, or for a spindle', () => {
    expect(machineLaserMax('laser', { ...connected, connected: false }, false)).toBeNull();
    expect(machineLaserMax('laser', { connected: true, motion: { spindle: null } }, false)).toBeNull();
    expect(machineLaserMax('cnc', connected, false)).toBeNull();
  });

  it('keeps the percentages, engraving included', () => {
    expect(retargetLaserPowers({ max: 10000, cut: 10000, engrave: 2000 }, 1000)).toEqual({ max: 1000, cut: 1000, engrave: 200 });
  });

  it('writes S-values on that scale', () => {
    const { max, cut } = retargetLaserPowers({ max: 10000, cut: 5000, engrave: 2000 }, 1000);
    const r = generateLaserCutGcode([panel('a', 3, 0)], { ...DEFAULT_GCODE_OPTIONS, laserMaxPower: max, laserPower: cut });
    expect(r.gcode).toMatch(/^M4 S500$/m);
  });
});

describe('the panel SVG', () => {
  /** An L plate lying on Z0: the notch is out of the top right, seen from above. */
  const lPlate = (thicknessMm: number) => {
    const outline: [number, number][] = [[0, 0], [100, 0], [100, 30], [30, 30], [30, 80], [0, 80]];
    const quads: number[] = [];
    const n = outline.length;
    const top = outline.map(([x, y]) => [x / 1000, y / 1000, thicknessMm / 1000]);
    const bottom = outline.map(([x, y]) => [x / 1000, y / 1000, 0]);
    const faces = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 5]].flatMap(([a, b, c]) => [a, b, c, n + c, n + b, n + a]);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      faces.push(i, n + i, n + j, i, n + j, j);
    }
    quads.push(...top.flat(), ...bottom.flat());
    return {
      id: 'L', name: 'L', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [{ name: 'gL', type: 'mesh', size: [1], renderVertices: quads, faces }],
    };
  };
  const outlineXY = (svg: string) => {
    const d = /<g id="cut-paths"[^>]*>\s*<path d="([^"]+)"/.exec(svg)![1];
    return [...d.matchAll(/(-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({ x: +m[1], y: +m[2] }));
  };

  it('is the G-code seen from above: the notch stays top right, in y-down', () => {
    const r = exportLaserCutSvg(scene(lPlate(6)), { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0 });
    const g = generateLaserCutGcode(r.panels!, { ...DEFAULT_GCODE_OPTIONS, machineMode: 'laser' });
    const cut = [...g.gcode.matchAll(/^G[01] X(-?[\d.]+) Y(-?[\d.]+)/gm)].map((m) => ({ x: +m[1], y: +m[2] }));
    expect(Math.max(...cut.filter((p) => p.x > 40).map((p) => p.y))).toBeCloseTo(38, 2);

    const svg = outlineXY(r.svg!);
    // y-down: the long leg's end, far right, sits at the bottom of the panel's box.
    const right = svg.filter((p) => p.x > 40).map((p) => p.y);
    expect(Math.min(...right)).toBeCloseTo(58, 2);
    expect(Math.max(...right)).toBeCloseTo(88, 2);
  });

  it('matches the contour exporter on the same plate', () => {
    const r = exportLaserCutSvg(scene(lPlate(6)), { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0, includeLabels: false });
    const c = exportContourSliceSvg(scene(lPlate(6)), { ...DEFAULT_CONTOUR_OPTIONS, materialThickness: 0.006, kerf: 0, pinHoles: false, includeLabels: false });
    const key = (pts: { x: number; y: number }[]) => pts.map((p) => `${p.x},${p.y}`).sort();
    expect(key(outlineXY(r.svg!))).toEqual(key(outlineXY(c.svg!)));
  });

  it('does not move anything on the sheet', () => {
    const r = exportLaserCutSvg(scene(lPlate(6)), { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, kerf: 0 });
    const pts = outlineXY(r.svg!);
    expect(Math.min(...pts.map((p) => p.x))).toBeCloseTo(8, 2);
    expect(Math.min(...pts.map((p) => p.y))).toBeCloseTo(8, 2);
    expect(Math.max(...pts.map((p) => p.y))).toBeCloseTo(88, 2);
  });
});
