import { describe, it, expect } from 'vitest';
import {
  exportLaserCutSvg,
  resolveStock,
  stockThicknesses,
  assignPanelThickness,
  extractPanelsFromScene,
  DEFAULT_LASER_OPTIONS,
  type StockItem,
  type LaserCutOptions,
} from '../src/utils/laserCutExporter';
import type { SceneGraph } from '../src/types/scene';

/**
 * Stock as a rack rather than a size.
 *
 * The governing rule for all of this: a job that does not mention stock must
 * behave exactly as it did before. Everything here either proves that, or
 * proves the new behaviour only shows up once a rack is actually declared.
 */

const opts = (o: Partial<LaserCutOptions> = {}): LaserCutOptions => ({ ...DEFAULT_LASER_OPTIONS, ...o });

/** A picture frame: a flat slab with a smaller slab subtracted from its middle. */
const frame = (outerW = 240, outerH = 180, thickness = 10): SceneGraph =>
  ({
    nodes: [
      {
        id: 'frame', name: 'frame', type: 'body', pos: [0, 0, 0], joints: [],
        geoms: [
          { id: 'outer', name: 'outer', type: 'box', pos: [0, 0, 0],
            size: [outerW / 2000, thickness / 2000, outerH / 2000] },
          { id: 'inner', name: 'inner', type: 'box', pos: [0, 0, 0], csg: 'difference',
            size: [(outerW - 60) / 2000, thickness / 1000, (outerH - 60) / 2000] },
        ],
      },
    ],
  }) as unknown as SceneGraph;

const stock = (widthMm: number, heightMm: number, thicknessMm: number, quantity: number | null = null): StockItem =>
  ({ widthMm, heightMm, thicknessMm, quantity });

describe('the default rack', () => {
  it('is one unlimited piece built from the sheet fields, so nothing changes', () => {
    const rack = resolveStock(opts({ sheetWidth: 0.6, sheetHeight: 0.4, materialThickness: 0.003 }));
    expect(rack).toEqual([{ widthMm: 600, heightMm: 400, thicknessMm: 3, quantity: null }]);
  });

  it('ignores a rack of nonsense rather than cutting from it', () => {
    const rack = resolveStock(opts({ stock: [stock(0, 400, 3), stock(600, 400, 0), stock(600, 400, 3, 0)] }));
    expect(rack).toHaveLength(1);
    expect(rack[0].quantity).toBeNull();
  });
});

describe('which thickness each panel is cut from', () => {
  const panelsOf = (scene: SceneGraph) => extractPanelsFromScene(scene, DEFAULT_LASER_OPTIONS).panels;

  it('gives every panel the one thickness when the rack has one', () => {
    const panels = panelsOf(frame(240, 180, 10));
    const rack = [stock(300, 200, 3)];
    const { byPanelId, warnings } = assignPanelThickness(panels, rack, opts());
    expect([...byPanelId.values()]).toEqual(panels.map(() => 3));
    // No complaint: with one stock size the mismatch is the existing global
    // warning's business, not this function's.
    expect(warnings).toEqual([]);
  });

  it('gives each panel the stock nearest what it was drawn at', () => {
    const panels = panelsOf(frame(240, 180, 10));
    const rack = [stock(300, 200, 3), stock(300, 200, 9), stock(300, 200, 18)];
    const { byPanelId } = assignPanelThickness(panels, rack, opts());
    expect([...byPanelId.values()]).toEqual([9]);
  });

  it('says so when nothing in the rack matches what was drawn', () => {
    const panels = panelsOf(frame(240, 180, 10));
    // Nothing at 10; the nearest above is 12, so it is cut thicker.
    const rack = [stock(300, 200, 12), stock(300, 200, 18)];
    const { warnings } = assignPanelThickness(panels, rack, opts());
    expect(warnings.join(' ')).toContain('Cut thicker than drawn');
    expect(warnings.join(' ')).toContain('will not seat');
  });

  it('flags a part the rack can only cut thinner than it was drawn', () => {
    const panels = panelsOf(frame(240, 180, 18));
    const rack = [stock(300, 200, 3), stock(300, 200, 6)];
    const { tooThin } = assignPanelThickness(panels, rack, opts());
    expect(tooThin).toHaveLength(1);
    expect(tooThin[0]).toContain('18.0 mm drawn');
  });

  it('lets sheet-goods undersizing through, because nominal 6 mm ply is 5.5', () => {
    // Refusing to cut a 6 mm model from the 6 mm sheet in the rack because the
    // sheet measures 5.5 would be intolerable and would teach people to leave
    // the override on permanently.
    const panels = panelsOf(frame(240, 180, 6));
    const { tooThin } = assignPanelThickness(panels, [stock(300, 200, 5.5)], opts());
    expect(tooThin).toEqual([]);
  });



  it('reads the thickness the model was drawn at, never a scaled one', () => {
    // Stock selection happens before any scale search. A model taken to 33% is
    // not suddenly 3 mm plywood.
    const panels = panelsOf(frame(240, 180, 9));
    const rack = [stock(300, 200, 3), stock(300, 200, 9)];
    const { byPanelId } = assignPanelThickness(panels, rack, opts({ scaleFactor: 0.33, autoScale: true }));
    expect([...byPanelId.values()]).toEqual([9]);
  });

  it('lists the thicknesses in the rack, thinnest first', () => {
    expect(stockThicknesses([stock(1, 1, 18), stock(1, 1, 3), stock(1, 1, 18)])).toEqual([3, 18]);
  });
});

describe('stock too thin for the model', () => {
  it('refuses the export rather than quietly cutting a weaker part', () => {
    // The case that matters: joints are sized from the stock, so the thin part
    // assembles exactly as drawn and nothing about the result looks wrong.
    const result = exportLaserCutSvg(frame(240, 180, 18), opts({
      stock: [stock(300, 200, 6)],
    }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('nothing thick enough');
    expect(result.svg).toBeUndefined();
  });

  it('goes ahead once the operator says they have decided', () => {
    const result = exportLaserCutSvg(frame(240, 180, 18), opts({
      stock: [stock(300, 200, 6)],
      allowThinnerStock: true,
    }));
    expect(result.success).toBe(true);
    expect(result.sheets![0].thicknessMm).toBe(6);
  });

  it('does not refuse stock that is thicker than drawn', () => {
    // Thicker is a fit problem, not a strength one, and it has always been a
    // warning. It stays one.
    const result = exportLaserCutSvg(frame(240, 180, 6), opts({
      stock: [stock(300, 200, 18)],
    }));
    expect(result.success).toBe(true);
  });
});

describe('a photo frame', () => {
  it('fits 300 x 200 x 10 stock and is cut with no extra steps', () => {
    const result = exportLaserCutSvg(frame(240, 180, 10), opts({
      stock: [stock(300, 200, 10)],
    }));

    expect(result.success).toBe(true);
    expect(result.sheetCount).toBe(1);
    expect(result.sheets).toEqual([{ widthMm: 300, heightMm: 200, thicknessMm: 10 }]);
    // One piece: outer rectangle plus the inner cutout. No joints, no splitting,
    // nothing asked of the operator.
    expect(result.panels).toHaveLength(1);
    expect(result.panels![0].innerCutouts2D).toHaveLength(1);
    expect(result.warnings?.some((w) => w.includes('Too big'))).toBeFalsy();
  });

  it('complains on 150 x 100 x 10 stock rather than quietly cutting something else', () => {
    const result = exportLaserCutSvg(frame(240, 180, 10), opts({
      stock: [stock(150, 100, 10)],
    }));

    expect(result.success).toBe(true);
    expect(result.warnings!.some((w) => w.includes('Too big for'))).toBe(true);
    // Still drawn, overhanging its frame, so what went wrong is visible.
    expect(result.panels).toHaveLength(1);
  });
});

describe('packing a rack', () => {
  it('reports the size of every sheet it used', () => {
    const result = exportLaserCutSvg(frame(240, 180, 10), opts({ stock: [stock(300, 200, 10)] }));
    expect(result.sheets![0].widthMm).toBe(300);
  });

  it('moves on to the next piece when a finite one is used up', () => {
    // Two frames' worth of panels will not both fit one 300 x 200 piece.
    const two: SceneGraph = {
      nodes: [
        ...(frame(240, 180, 10) as unknown as { nodes: unknown[] }).nodes,
        ...(frame(240, 180, 10) as unknown as { nodes: Array<{ id: string }> }).nodes.map((n) => ({
          ...n, id: 'frame2', name: 'frame2',
        })),
      ],
    } as unknown as SceneGraph;

    const result = exportLaserCutSvg(two, opts({
      stock: [stock(300, 200, 10, 1), stock(400, 300, 10, 1)],
    }));
    expect(result.success).toBe(true);
    // Largest first, so the 400 x 300 piece is opened before the 300 x 200.
    expect(result.sheets![0]).toMatchObject({ widthMm: 400, heightMm: 300 });
  });

  it('keeps today’s caption when the rack has one thickness', () => {
    const result = exportLaserCutSvg(frame(240, 180, 10), opts({ stock: [stock(300, 200, 10)] }));
    expect(result.svg).toContain('Sheet 1 (300mm x 200mm)');
  });

  it('names the thickness on the caption once the rack has several', () => {
    const result = exportLaserCutSvg(frame(240, 180, 10), opts({
      stock: [stock(300, 200, 10), stock(300, 200, 3)],
    }));
    expect(result.svg).toContain('x 10.0mm)');
  });
});

describe('joints between panels of different thickness', () => {
  /**
   * Two perpendicular slabs meeting along an edge: A in the XZ plane, B in the
   * XY plane, B's near edge sitting on A's far edge.
   */
  const ell = (tA: number, tB: number): SceneGraph =>
    ({
      nodes: [
        { id: 'a', name: 'a', type: 'body', pos: [0, 0, 0], joints: [],
          geoms: [{ id: 'ga', name: 'panel_a', type: 'box', pos: [0, 0, 0], size: [0.1, tA / 2000, 0.05] }] },
        { id: 'b', name: 'b', type: 'body', pos: [0, 0, 0], joints: [],
          geoms: [{ id: 'gb', name: 'panel_b', type: 'box', pos: [0, 0.05, 0.05], size: [0.1, 0.05, tB / 2000] }] },
      ],
    }) as unknown as SceneGraph;

  const heights = (scene: SceneGraph, rack: StockItem[]) => {
    const r = exportLaserCutSvg(scene, opts({ stock: rack, materialThickness: 0.006 }));
    expect(r.success).toBe(true);
    const by = new Map(r.panels!.map((p) => [p.name, p]));
    return { result: r, a: by.get('panel_a')!, b: by.get('panel_b')! };
  };

  it('sizes each panel’s tabs from the material they pass through, not from one job figure', () => {
    const uniform = heights(ell(6, 6), [stock(600, 400, 6)]);
    const mixed = heights(ell(6, 18), [stock(600, 400, 6), stock(600, 400, 18)]);

    // A is cut from 6 mm and its tabs must span B's 18 mm, so they reach a
    // further (18 - 6) / 2 mm than they did when B was also 6 mm.
    expect(mixed.a.height2D!).toBeCloseTo(uniform.a.height2D! + 6, 1);
    // B is cut from 18 mm and its tabs still only span A's 6 mm, so B is
    // unchanged — which is the half that a single global thickness got wrong.
    expect(mixed.b.height2D!).toBeCloseTo(uniform.b.height2D!, 1);
  });

  it('puts each panel on stock of its own thickness', () => {
    const { result, a, b } = heights(ell(6, 18), [stock(600, 400, 6), stock(600, 400, 18)]);
    expect(result.sheets!.map((s) => s.thicknessMm).sort((x, y) => x - y)).toEqual([6, 18]);
    expect(result.sheets![a.sheetIndex!].thicknessMm).toBe(6);
    expect(result.sheets![b.sheetIndex!].thicknessMm).toBe(18);
  });
});

describe('splitting a part the rack cannot hold whole', () => {
  /**
   * A flat ring — a flask half, a picture frame — modelled as an extruded
   * rectangle with a smaller one subtracted. Cut whole it needs a sheet as big
   * as the whole part and throws the middle away; cut as four mitred lengths it
   * needs four pieces no wider than its own border.
   */
  const ring = (outer = 300, height = 240, wall = 30, thick = 9): SceneGraph =>
    ({
      nodes: [
        {
          id: 'ring', name: 'ring', type: 'body', pos: [0, 0, 0], joints: [],
          geoms: [
            { id: 'o', name: 'cope', type: 'box', pos: [0, 0, 0],
              size: [outer / 2000, thick / 2000, height / 2000] },
            { id: 'i', name: 'void', type: 'box', pos: [0, 0, 0], csg: 'difference',
              size: [(outer - 2 * wall) / 2000, thick / 1000, (height - 2 * wall) / 2000] },
          ],
        },
      ],
    }) as unknown as SceneGraph;

  /** Bar: long enough for a side, only as wide as the border. */
  const bar = [stock(320, 50, 9, 8)];

  it('reports it oversized by default rather than splitting it', () => {
    const result = exportLaserCutSvg(ring(), opts({ stock: bar, materialThickness: 0.009 }));
    expect(result.success).toBe(true);
    expect(result.panels).toHaveLength(1);
    expect(result.warnings!.some((w) => w.includes('Too big for'))).toBe(true);
  });

  it('cuts it as four mitred lengths once splitting is asked for', () => {
    const result = exportLaserCutSvg(ring(), opts({
      stock: bar, materialThickness: 0.009, splitOversized: true,
    }));

    expect(result.success).toBe(true);
    expect(result.panels).toHaveLength(4);

    // Two lengths run the full 300, two the full 240, and every one of them is
    // exactly one border wide.
    const sizes = result.panels!
      .map((p) => [Math.max(p.width2D!, p.height2D!), Math.min(p.width2D!, p.height2D!)])
      .sort((a, b) => b[0] - a[0]);
    expect(sizes[0][0]).toBeCloseTo(300, 0);
    expect(sizes[1][0]).toBeCloseTo(300, 0);
    expect(sizes[2][0]).toBeCloseTo(240, 0);
    expect(sizes[3][0]).toBeCloseTo(240, 0);
    for (const [, short] of sizes) expect(short).toBeCloseTo(30, 0);

    expect(result.warnings!.some((w) => w.includes('4 mitred lengths'))).toBe(true);
    expect(result.warnings!.some((w) => w.includes('Too big for'))).toBeFalsy();
  });

  it('gives every length two mitred ends and no self-crossing', () => {
    const result = exportLaserCutSvg(ring(), opts({
      stock: bar, materialThickness: 0.009, splitOversized: true,
    }));
    for (const p of result.panels!) {
      expect(p.outerPolygon2D).toHaveLength(4);
      /*
       * Convex, which is what a trapezoid is. The failure this catches is a bow
       * tie: four points paired up in the wrong order still have a plausible
       * area and only give themselves away by turning back on themselves.
       */
      const signs = p.outerPolygon2D.map((a, i, all) => {
        const b = all[(i + 1) % 4];
        const c = all[(i + 2) % 4];
        return Math.sign((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x));
      });
      expect(new Set(signs.filter((v) => v !== 0)).size).toBe(1);
      // And two of the four corners are mitres rather than right angles.
      const offRight = p.outerPolygon2D.filter((v, i, all) => {
        const prev = all[(i + 3) % 4];
        const next = all[(i + 1) % 4];
        const ax = prev.x - v.x, ay = prev.y - v.y;
        const bx = next.x - v.x, by = next.y - v.y;
        const cos = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
        return Math.abs(cos) > 0.05;
      });
      expect(offRight.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('does not share a vertex between two lengths', () => {
    /*
     * The bug this exists for: strips built from the loops' own point objects
     * share their corners, and `normalizePanelBounds` shifts a panel's points
     * in place — so a shared corner is moved once per strip that holds it. The
     * split looked right the moment it was made and came apart afterwards.
     */
    const result = exportLaserCutSvg(ring(), opts({
      stock: bar, materialThickness: 0.009, splitOversized: true,
    }));
    const seen = new Set<object>();
    for (const p of result.panels!) {
      for (const v of p.outerPolygon2D) {
        expect(seen.has(v)).toBe(false);
        seen.add(v);
      }
    }
  });

  it('leaves a part that already fits exactly as it was', () => {
    // Switching splitting on must not re-shape a job that was already cuttable.
    const rack = [stock(400, 400, 9)];
    expect(exportLaserCutSvg(ring(), opts({ stock: rack, materialThickness: 0.009 })).panels).toHaveLength(1);
    expect(
      exportLaserCutSvg(ring(), opts({ stock: rack, materialThickness: 0.009, splitOversized: true })).panels
    ).toHaveLength(1);
  });

  it('declines a solid slab, which has no corner to mitre at', () => {
    const slab: SceneGraph = {
      nodes: [{
        id: 's', name: 's', type: 'body', pos: [0, 0, 0], joints: [],
        geoms: [{ id: 'g', name: 'slab', type: 'box', pos: [0, 0, 0], size: [0.15, 0.0045, 0.12] }],
      }],
    } as unknown as SceneGraph;
    const result = exportLaserCutSvg(slab, opts({
      stock: bar, materialThickness: 0.009, splitOversized: true,
    }));
    expect(result.panels).toHaveLength(1);
    expect(result.warnings!.some((w) => w.includes('Too big for'))).toBe(true);
  });

  it('declines a ring whose cutout runs out to an edge', () => {
    // Not a ring at all — a shelled box hands over shapes like this, and
    // splitting one gives strips of nothing and a bow tie.
    const noBorder = ring(300, 240, 0.5);
    const result = exportLaserCutSvg(noBorder, opts({
      stock: bar, materialThickness: 0.009, splitOversized: true,
    }));
    expect(result.panels!.length).toBeLessThan(4);
  });
});
