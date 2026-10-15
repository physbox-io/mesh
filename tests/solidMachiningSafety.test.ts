import { describe, it, expect } from 'vitest';
import { generateSolidMachining } from '../src/utils/solidMachiningExporter';
import { simulateMilling } from '../src/utils/cutSimulation';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

/*
 * The parts of a solid job that are not the surface: registration pins and
 * holding tabs. Each of these went to the machine wrong in a way the surface
 * tests could not see.
 */

function body(geoms: (Partial<SceneGeom> & { type: SceneGeom['type']; size: number[] })[]): SceneGraph {
  return {
    nodes: [{
      id: 'b1', name: 'part', type: 'body', pos: [0, 0, 0],
      geoms: geoms.map((g, i) => ({ name: `g${i}`, ...g }) as SceneGeom),
      joints: [], children: [],
    }],
  };
}

/** A 30 mm block, 20 mm tall. */
const block = body([{ type: 'box', size: [0.015, 0.015, 0.01], pos: [0, 0, 0.01] } as never]);
/** A 30 mm boss, 40 mm tall, on a 60 mm flange 4 mm thick. */
const flanged = body([
  { type: 'box', size: [0.03, 0.03, 0.002], pos: [0, 0, 0.002] } as never,
  { type: 'box', size: [0.015, 0.015, 0.02], pos: [0, 0, 0.02] } as never,
]);
/** A 100 x 6 mm bar. */
const bar = body([{ type: 'box', size: [0.05, 0.003, 0.005], pos: [0, 0, 0.005] } as never]);

const quick = {
  finishingToolDiaMm: 6,
  finishingStepoverPercent: 40,
  roughingToolDiaMm: 6.35,
  material: 'softwood' as const,
};

/** The pin-boring block of side A, as parsed moves. */
function pinMoves(gcode: string) {
  const start = gcode.indexOf('OP 0: registration pins');
  const end = gcode.indexOf('back over the origin before the part');
  expect(start).toBeGreaterThan(0);
  let z = 0, feed = 0;
  const out: { z: number; dz: number; feed: number; g: string }[] = [];
  for (const raw of gcode.slice(start, end).split('\n')) {
    const line = raw.split(';')[0].trim();
    const g = /^G([01])\b/.exec(line);
    if (!g) continue;
    const f = /F([\d.]+)/.exec(line);
    if (f) feed = parseFloat(f[1]);
    const nz = parseFloat(/Z(-?[\d.]+)/.exec(line)?.[1] ?? `${z}`);
    out.push({ z: nz, dz: nz - z, feed, g: g[1] });
    z = nz;
  }
  return out;
}

describe('Registration pins', () => {
  it('pecks a pin hole the cutter only just fits, at the plunge rate', () => {
    // With the pin as wide as the cutter the helix has no radius, and it was
    // a straight plunge the whole depth of the block at four times the
    // plunge rate.
    const res = generateSolidMachining(block, { ...quick, sides: 2, pinDiaMm: 6.4 });
    expect(res.success, res.error).toBe(true);
    const moves = pinMoves(res.sides[0].gcode);
    const rate = Math.min(...moves.filter((m) => m.g === '1' && m.dz < -1e-6).map((m) => m.feed));
    expect(rate).toBeGreaterThan(0);
    let depthSinceLift = 0;
    for (const m of moves) {
      if (m.g === '1' && m.dz < -1e-6) {
        expect(m.feed).toBe(rate);
        depthSinceLift += -m.dz;
      }
      if (m.dz > 1e-6) depthSinceLift = 0;
      // Lifted to clear the chips at least every few millimetres.
      expect(depthSinceLift).toBeLessThanOrEqual(6.4 + 1e-6);
    }
  });

  it('keeps a pin hole out of the channel when the frame is narrower than asked', () => {
    // An explicit stock 2 x 10 mm wider than part and channel leaves a 10 mm
    // frame; the pin was centred in the 15 mm frame asked for, and an 8 mm
    // hole there runs into the channel.
    const res = generateSolidMachining(block, {
      ...quick, sides: 2, stockWidthMm: 30 + 2 * (9.525 + 10), stockDepthMm: 80,
    });
    expect(res.success, res.error).toBe(true);
    expect(res.pins).toHaveLength(0);
    expect(res.warnings.join('\n')).toMatch(/registration pin/);
  });

  it('does not bore deeper than the holder lets the cutter reach', () => {
    const res = generateSolidMachining(block, {
      ...quick, sides: 2, toolStickoutMm: 18, holderDiaMm: 22,
    });
    expect(res.success, res.error).toBe(true);
    if (res.pins.length > 0) {
      for (const m of pinMoves(res.sides[0].gcode)) expect(m.z).toBeGreaterThanOrEqual(-18 + 0.5 - 1e-6);
    }
    expect(res.warnings.join('\n')).toMatch(/pin/i);
  });
});

describe('Holding tabs', () => {
  it('puts each tab where the part is, not at the middle of the stock', () => {
    // The flange's edge spans only its own 4 mm at the bottom of the block; a
    // tab at the stock's midplane is joined to nothing there.
    const res = generateSolidMachining(flanged, { ...quick, sides: 2 });
    expect(res.success, res.error).toBe(true);
    expect(res.tabs.length).toBeGreaterThan(0);
    const t = res.stock.thicknessMm;
    const skin = (t - 40) / 2;
    const flangeBottom = -t + skin;
    const flangeTop = flangeBottom + 4;
    for (const tab of res.tabs) {
      expect(tab.topZ - tab.bottomZ).toBeGreaterThan(0);
      expect(tab.bottomZ).toBeLessThan(flangeTop);
      expect(tab.topZ).toBeGreaterThan(flangeBottom);
    }
  });

  it('leaves the tabs standing at those heights once both sides are cut', () => {
    // Cut each side's program out of a block and read the channel half way
    // across each tab: side A must stop at the tab's top, side B (which sees
    // the block mirrored left to right) at its bottom.
    const res = generateSolidMachining(flanged, { ...quick, sides: 2 });
    expect(res.success, res.error).toBe(true);
    const { widthMm: W, depthMm: D, thicknessMm: T } = res.stock;
    const sim = (gcode: string) => simulateMilling(gcode, {
      widthMm: W, depthMm: D, cellMm: 0.5,
      tools: {
        1: { shape: 'flat', diameterMm: quick.roughingToolDiaMm },
        2: { shape: 'flat', diameterMm: quick.finishingToolDiaMm },
      },
      initialTool: 1,
    });
    const a = sim(res.sides[0].gcode);
    const b = sim(res.sides[1].gcode);
    for (const tab of res.tabs) {
      // Out from the part's centre, a few millimetres into the channel.
      const dx = tab.x - W / 2, dy = tab.y - D / 2;
      const len = Math.hypot(dx, dy);
      const x = tab.x + (dx / len) * 4, y = tab.y + (dy / len) * 4;
      expect(a.at(x, y)).toBeCloseTo(tab.topZ, 0);
      expect(-T - b.at(W - x, y)).toBeCloseTo(tab.bottomZ, 0);
    }
  });

  it('never puts two tabs on top of each other', () => {
    // Eight tabs by bearing round a long thin bar: two of the bearings land
    // a couple of millimetres apart on its long side.
    const res = generateSolidMachining(bar, { ...quick, sides: 2, tabCount: 8, tabWidthMm: 6 });
    expect(res.success, res.error).toBe(true);
    for (let i = 0; i < res.tabs.length; i++) {
      for (let j = i + 1; j < res.tabs.length; j++) {
        const d = Math.hypot(res.tabs[i].x - res.tabs[j].x, res.tabs[i].y - res.tabs[j].y);
        expect(d).toBeGreaterThanOrEqual(6);
      }
    }
    expect(res.tabsPlaced).toBe(res.tabs.length);
  });
});
