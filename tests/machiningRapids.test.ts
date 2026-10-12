// Cutting the program back out of a block and checking what the rapids hit.
//
// A G0 is the machine's top speed with no regard for what is in the way, so a
// rapid that takes material off is a cutter dragged sideways through the work
// at several metres a minute — in aluminium, a snapped bit. See
// src/utils/cutSimulation.ts for how the program is cut back out of a block.
import { describe, it, expect } from 'vitest';
import { latticeBracketPreset } from '../src/presets/latticeBracket';
import { generateSolidMachining } from '../src/utils/solidMachiningExporter';
import { cutStock, cutStockMap, type MoveCut } from '../src/utils/cutSimulation';

/** Every G0 in a program that took material off. */
function rapidsThroughStock(
  gcode: string, width: number, depth: number, radius: number, finishing: 'flat' | 'ball' = 'flat'
): MoveCut[] {
  return cutStock(gcode, width, depth, radius, finishing).filter((c) => c.rapid);
}

/** Ignores what a cell-centre sampler can disagree with the exporter about at a wall. */
const TOLERANCE_MM = 0.05;

describe('no rapid moves through the stock', () => {
  it('on both sides of the two-sided wall bracket', () => {
    // One cutter for both operations, so the simulation's radius is exactly
    // the one that cut: a smaller one leaves slivers the real tool took off,
    // and a correct rapid beside them reads as a collision.
    const r = generateSolidMachining(latticeBracketPreset, {
      sides: 2,
      roughingToolDiaMm: 6.35,
      finishingToolDiaMm: 6.35,
      finishingToolType: 'flat',
      finishingStepoverPercent: 40,
      material: 'aluminium',
    });
    expect(r.success, r.error).toBe(true);
    for (const side of r.sides) {
      const hits = rapidsThroughStock(side.gcode, r.stock.widthMm, r.stock.depthMm, 6.35 / 2)
        .filter((h) => h.removedMm > TOLERANCE_MM);
      expect(hits.slice(0, 5), `side ${side.side}`).toEqual([]);
    }
  });

  // Ground shallower than the first roughing layer is where the old traverse
  // model was wrong: roughing never touches it, so it stands at the stock's
  // face until the finishing pass, while the model had it at its finished
  // height plus the allowance and flew across it a millimetre above that.
  // Every combination of passes leaves the stock in a different state between
  // moves, so each is cut and checked.
  const passes = [
    { name: 'roughing and finishing', roughingEnabled: true, finishingEnabled: true, finishingToolType: 'flat' },
    { name: 'roughing only', roughingEnabled: true, finishingEnabled: false, finishingToolType: 'flat' },
    { name: 'finishing only', roughingEnabled: false, finishingEnabled: true, finishingToolType: 'flat' },
    { name: 'roughing, then a ball-nose finish', roughingEnabled: true, finishingEnabled: true, finishingToolType: 'ball_nose' },
  ] as const;

  for (const p of passes) {
    it(`over ground shallower than the first roughing layer: ${p.name}`, () => {
      const r = generateSolidMachining(dishScene(), {
        sides: 2,
        roughingToolDiaMm: 3,
        finishingToolDiaMm: 3,
        roughingEnabled: p.roughingEnabled,
        finishingEnabled: p.finishingEnabled,
        finishingToolType: p.finishingToolType,
        material: 'aluminium',
      });
      expect(r.success, r.error).toBe(true);
      const tip = p.finishingToolType === 'ball_nose' ? 'ball' : 'flat';
      for (const side of r.sides) {
        const hits = rapidsThroughStock(side.gcode, r.stock.widthMm, r.stock.depthMm, 1.5, tip)
          .filter((h) => h.removedMm > TOLERANCE_MM);
        expect(hits.slice(0, 5), `side ${side.side}`).toEqual([]);
      }
    });
  }
});

describe('roughing on its own', () => {
  // The last roughing layer sits exactly at the floor, and a strict "below
  // the layer" test left it empty. With a finishing pass that was hidden —
  // finishing went to the floor anyway — but with roughing alone the channel
  // round a two-sided part stopped a whole layer short of the middle, and the
  // part never came free.
  it('cuts each side of a two-sided part all the way to its floor', () => {
    const r = generateSolidMachining(dishScene(), {
      sides: 2, roughingToolDiaMm: 3, finishingEnabled: false, material: 'aluminium',
    });
    expect(r.success, r.error).toBe(true);
    for (const side of r.sides) {
      let deepest = 0;
      const roughing = side.gcode.slice(side.gcode.indexOf('OP 1: roughing'));
      for (const m of roughing.matchAll(/Z(-?\d+(?:\.\d+)?)/g)) deepest = Math.min(deepest, parseFloat(m[1]));
      expect(-deepest, `side ${side.side}`).toBeCloseTo(side.depthMm, 2);
    }
  });
});

describe('the finishing pass does not cut into the walls it crosses', () => {
  // The raster samples the cutter-offset surface a resolution step apart and
  // the machine draws straight lines between the samples. Across a vertical
  // wall that line was a chamfer into the top of the wall: up to 0.65 mm into
  // a pocket's rim on the soap dish this was found on.
  it('leaves the top of the rim round the recess at its full height', () => {
    const r = generateSolidMachining(dishScene(), {
      sides: 2, roughingToolDiaMm: 3, finishingToolDiaMm: 3, finishingToolType: 'flat', material: 'aluminium',
    });
    expect(r.success, r.error).toBe(true);
    const a = r.sides.find((s) => s.side === 'A')!;
    const cut = cutStockMap(a.gcode, r.stock.widthMm, r.stock.depthMm, 1.5);

    // Two-sided, the part is centred in the block with its top a skin below
    // the face: the rim's top is at -skin, the recess floor 3 mm under it.
    const skin = (r.stock.thicknessMm - r.partSizeMm.z) / 2;
    const cx = r.stock.widthMm / 2, cy = r.stock.depthMm / 2;
    // The north and south rims run 14..20 mm either side of the centre line,
    // the east and west ones 24..30 mm. The exporter only knows where a wall
    // is to within one sample of its heightmap (0.6 mm here), so the check
    // stays a millimetre clear of every edge: what it is after is a cut into
    // the top of the rim, not where exactly its sides land.
    let worst = 0;
    for (let x = cx - 29; x <= cx + 29; x += 0.25) {
      for (const dy of [15, 16, 17, 18, 19]) {
        worst = Math.max(worst, -skin - cut.at(x, cy + dy), -skin - cut.at(x, cy - dy));
      }
    }
    for (let y = cy - 13; y <= cy + 13; y += 0.25) {
      for (const dx of [25, 26, 27, 28, 29]) {
        worst = Math.max(worst, -skin - cut.at(cx + dx, y), -skin - cut.at(cx - dx, y));
      }
    }
    // How far below the rim's top any of it was cut.
    expect(worst).toBeLessThan(0.05);
  });
});

/**
 * A 60 x 40 mm block with a raised rim round a recess on top and two ribs
 * underneath — the shape of the soap dish this was found on, in boxes.
 */
function dishScene() {
  const box = (name: string, pos: [number, number, number], half: [number, number, number]) => ({
    name, type: 'box', pos, size: half, rgba: [0.7, 0.6, 0.4, 1],
  });
  return {
    nodes: [{
      id: 'dish', name: 'dish', type: 'body', pos: [0, 0, 0.02], joints: [], children: [],
      geoms: [
        // Body of the part, 8 mm thick.
        box('base', [0, 0, 0], [0.03, 0.02, 0.004]),
        // A rim 3 mm tall round the top: the recess inside it sits 3 mm below
        // the part's top, inside the first roughing layer.
        box('rim_n', [0, 0.017, 0.0055], [0.03, 0.003, 0.0015]),
        box('rim_s', [0, -0.017, 0.0055], [0.03, 0.003, 0.0015]),
        box('rim_e', [0.027, 0, 0.0055], [0.003, 0.014, 0.0015]),
        box('rim_w', [-0.027, 0, 0.0055], [0.003, 0.014, 0.0015]),
        // Two ribs underneath, off centre so a mirrored flip would show.
        box('rib_1', [-0.012, 0, -0.0055], [0.0025, 0.02, 0.0015]),
        box('rib_2', [0.016, 0, -0.0055], [0.0025, 0.02, 0.0015]),
      ],
    }],
  } as unknown as Parameters<typeof generateSolidMachining>[0];
}
