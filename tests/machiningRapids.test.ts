// Cutting the program back out of a block and checking what the rapids hit.
//
// A G0 is the machine's top speed with no regard for what is in the way, so a
// rapid that takes material off is a cutter dragged sideways through the work
// at several metres a minute — in aluminium, a snapped bit. See
// helpers/cutStock for how the program is cut back out of a block.
import { describe, it, expect } from 'vitest';
import { latticeBracketPreset } from '../src/presets/latticeBracket';
import { generateSolidMachining } from '../src/utils/solidMachiningExporter';
import { cutStock, type MoveCut } from './helpers/cutStock';

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
