import { describe, it, expect } from 'vitest';
import { generateSolidMachining, deriveSolidOptions } from '../src/utils/solidMachiningExporter';
import { generateReliefCarveGcode, DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefCarveExporter';
import { StockModel, FLAT_PROFILE, ballProfile } from '../src/utils/stockModel';
import { reliefOptionsFor, machiningOptionsFor } from '../src/hooks/mcp/exportOptions';
import { machiningCommands } from '../src/hooks/mcp/machiningCommands';
import { rememberReliefOptions } from '../src/utils/lastReliefOptions';
import { useStore } from '../src/store/useStore';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

function body(geoms: Partial<SceneGeom>[]): SceneGraph {
  return {
    nodes: [
      {
        id: 'b1',
        name: 'part',
        type: 'body',
        pos: [0, 0, 0],
        geoms: geoms.map((g, i) => ({ name: `g${i}`, ...g })) as SceneGeom[],
        joints: [],
        children: [],
      },
    ],
  };
}

/** Closed axis-aligned box from [x0,y0,z0] to [x1,y1,z1] in mm (renderVertices Z-up, metres). */
function boxMeshMm(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Partial<SceneGeom> {
  const pts = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ].map(([x, y, z]) => [x / 1000, y / 1000, z / 1000]);
  const faces = [
    0, 2, 1, 0, 3, 2, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    2, 3, 7, 2, 7, 6, // +y
    1, 2, 6, 1, 6, 5, // +x
    3, 0, 4, 3, 4, 7, // -x
  ];
  const renderVertices = pts.flat();
  const vertices = pts.flatMap(([x, y, z]) => [x, z, -y]);
  return { type: 'mesh', size: [1], renderVertices, vertices, faces };
}

/**
 * Replays OP 1 (roughing) and OP 2 (finishing) against a fine StockModel and
 * measures the deepest single-pass G1 cut in OP 2 within `withinMm` of the tool axis.
 */
function measureMaxFinishingCutDepthMm(
  gcode: string,
  widthMm: number,
  depthMm: number,
  roughDiaMm: number,
  finishDiaMm: number,
  finishType: 'flat' | 'ball_nose',
  withinMm: number
): number {
  const split = gcode.indexOf('OP 2: finishing');
  expect(split).toBeGreaterThan(0);

  const cell = Math.min(0.25, Math.max(0.1, finishDiaMm / 8));
  const stock = new StockModel({ minX: 0, minY: 0, maxX: widthMm, maxY: depthMm }, cell);
  const roughRad = roughDiaMm / 2;
  const finishRad = finishDiaMm / 2;
  const finishProfile = finishType === 'ball_nose' ? ballProfile(finishRad) : FLAT_PROFILE;

  let x = 0, y = 0, z = 50;
  let inFinish = false;
  let maxCut = 0;

  for (const raw of gcode.split('\n')) {
    if (raw.includes('OP 2: finishing')) {
      inFinish = true;
      continue;
    }
    const line = raw.split(';')[0].trim();
    const m = /^G0?([01])\b/.exec(line);
    if (!m) continue;
    const nx = /X(-?[\d.]+)/.exec(line)?.[1];
    const ny = /Y(-?[\d.]+)/.exec(line)?.[1];
    const nz = /Z(-?[\d.]+)/.exec(line)?.[1];
    const tx = nx !== undefined ? parseFloat(nx) : x;
    const ty = ny !== undefined ? parseFloat(ny) : y;
    const tz = nz !== undefined ? parseFloat(nz) : z;

    if (m[1] === '1') {
      if (!inFinish) {
        stock.cut(x, y, z, tx, ty, tz, roughRad, FLAT_PROFILE);
      } else {
        const bite = stock.deepestCut(x, y, z, tx, ty, tz, finishRad, finishProfile, withinMm);
        if (bite > maxCut) maxCut = bite;
        stock.cut(x, y, z, tx, ty, tz, finishRad, finishProfile);
      }
    }
    x = tx;
    y = ty;
    z = tz;
  }
  return maxCut;
}

describe('Bug 1: Finishing rest-layering prevents full-depth plunges in unroughed corners & stock border', () => {
  it('2-sided aluminium housing (6 mm rough -> 3 mm flat finish) steps down unroughed corners & border safely', () => {
    // 60 x 40 x 20 mm aluminium housing with a 10 mm deep internal pocket (44 x 24 mm)
    // and sharp 90-degree interior pocket corners where a 6 mm rougher leaves R=3 mm fillets
    // that a 3 mm finisher must clean up without plunging full depth.
    const housing = body([
      boxMeshMm(-30, -20, 0, 30, 20, 10),   // lower solid base z=0..10
      boxMeshMm(-30, -20, 10, 30, -12, 20), // front wall
      boxMeshMm(-30, 12, 10, 30, 20, 20),   // back wall
      boxMeshMm(-30, -12, 10, -22, 12, 20), // left wall
      boxMeshMm(22, -12, 10, 30, 12, 20),   // right wall
    ]);
    const opts = deriveSolidOptions(housing, {
      sides: 2,
      material: 'aluminium',
      roughingToolDiaMm: 6,
      finishingToolDiaMm: 3,
      finishingToolType: 'flat',
      tabCount: 4,
      registrationPins: false,
      toolStickoutMm: 50,
    });
    const res = generateSolidMachining(housing, opts);
    expect(res.success, res.error).toBe(true);
    expect(res.sides).toHaveLength(2);

    // Measure at the tool axis (staying clear of the thin straight-wall allowance
    // skin roughing leaves): unroughed inside pocket corners & outer stock corners
    // used to plunge 9.6-12.5 mm in a single G1 move.
    expect(res.sides[0].gcode).toContain('; rest-cleanup stepdown');
    for (const side of res.sides) {
      const maxCut = measureMaxFinishingCutDepthMm(
        side.gcode,
        res.stock.widthMm,
        res.stock.depthMm,
        opts.roughingToolDiaMm,
        opts.finishingToolDiaMm,
        'flat',
        0.05
      );
      expect(maxCut).toBeLessThan(2.0);
    }
  });

  it('relief plaque (6.35 mm rough -> 2 mm ball-nose finish) steps down unroughed corners & stock border safely', () => {
    // Recessed 80 x 60 mm plaque with a raised central boss and sharp corners, carved 10 mm deep.
    const plaque = body([
      boxMeshMm(-40, -30, 0, 40, -22, 10),  // bottom frame bar
      boxMeshMm(-40, 22, 0, 40, 30, 10),    // top frame bar
      boxMeshMm(-40, -22, 0, -32, 22, 10),  // left frame bar
      boxMeshMm(32, -22, 0, 40, 22, 10),    // right frame bar
      boxMeshMm(-12, -8, 0, 12, 8, 10),     // raised center motif
    ]);
    const opts = {
      ...DEFAULT_RELIEF_OPTIONS,
      stockWidthMm: 100,
      stockDepthMm: 80,
      stockThicknessMm: 18,
      fitMode: 'manual' as const,
      scalePercent: 100,
      backgroundMode: 'carve' as const,
      carveDepthMm: 10,
      material: 'hardwood' as const,
      roughingEnabled: true,
      roughingToolDiaMm: 6.35,
      finishingEnabled: true,
      finishingToolDiaMm: 2.0,
      finishingToolType: 'ball_nose' as const,
    };
    const res = generateReliefCarveGcode(plaque, opts);
    expect(res.success, res.error).toBe(true);

    expect(res.gcode).toContain('; rest-cleanup stepdown');
    const maxCutAxis = measureMaxFinishingCutDepthMm(
      res.gcode,
      opts.stockWidthMm,
      opts.stockDepthMm,
      opts.roughingToolDiaMm,
      opts.finishingToolDiaMm,
      'ball_nose',
      0.05
    );
    expect(maxCutAxis).toBeLessThan(2.5);
  });
});

describe('Bug 2: reliefOptionsFor parses finishingVBitAngleDeg and triggers rederive', () => {
  it('passes finishingVBitAngleDeg through and rederives feeds when changed from dialog options', () => {
    const base = reliefOptionsFor({
      finishingToolType: 'v_bit',
      finishingToolDiaMm: 6,
      finishingVBitAngleDeg: 60,
    }).options;
    expect(base.finishingToolType).toBe('v_bit');
    expect(base.finishingVBitAngleDeg).toBe(60);

    // Remember a dialog plan with a custom overridden feedrate and 60-deg V-bit
    rememberReliefOptions({ ...base, finishingFeedrate: 9999 });
    // Keeping the same angle keeps the dialog's custom feedrate
    const kept = reliefOptionsFor({}).options;
    expect(kept.finishingFeedrate).toBe(9999);
    expect(kept.finishingVBitAngleDeg).toBe(60);

    // Changing finishingVBitAngleDeg updates the option and re-derives feeds
    const changed = reliefOptionsFor({ finishingVBitAngleDeg: 90 }).options;
    expect(changed.finishingVBitAngleDeg).toBe(90);
    expect(changed.finishingFeedrate).not.toBe(9999);

    // Invalid non-positive angles are rejected
    expect(() => reliefOptionsFor({ finishingVBitAngleDeg: 0 })).toThrow(/finishingVBitAngleDeg/);
    expect(() => reliefOptionsFor({ finishingVBitAngleDeg: -45 })).toThrow(/finishingVBitAngleDeg/);
  });
});

describe('Bug 3: units: "in" is refused with a clear metric (mm / G21) error', () => {
  const cube = body([boxMeshMm(-10, -10, 0, 10, 10, 10)]);

  it('refuses units: "in" in reliefOptionsFor and machiningOptionsFor while accepting "mm"', () => {
    expect(() => reliefOptionsFor({ units: 'in' })).toThrow(/metric|G21|mm/i);
    expect(() => machiningOptionsFor({ units: 'in' }, cube)).toThrow(/metric|G21|mm/i);

    expect(() => reliefOptionsFor({ units: 'mm' })).not.toThrow();
    expect(() => machiningOptionsFor({ units: 'mm' }, cube)).not.toThrow();

    expect(() => reliefOptionsFor({ units: 'cm' })).toThrow(/units must be one of/);
    expect(() => machiningOptionsFor({ units: 'cm' }, cube)).toThrow(/units must be one of/);
  });
});

describe('Bug 4: ADD_SIMULATION (machining + stage) explains that placement: "overlay" is ignored', () => {
  it('includes a note when stage is set and placement is "overlay"', async () => {
    const cube = body([boxMeshMm(-10, -10, 0, 10, 10, 8)]);
    const prevGraph = useStore.getState().sceneGraph;
    useStore.setState({ sceneGraph: cube });
    try {
      const ctx = { store: useStore.getState(), toId: (s: string) => s } as never;
      const withOverlay = (await machiningCommands.ADD_SIMULATION(
        { kind: 'machining', stage: 0, placement: 'overlay', toolDiaMm: 6, material: 'softwood' },
        ctx
      )) as { ok: boolean; placement?: string; note?: string };
      expect(withOverlay.ok).toBe(true);
      expect(withOverlay.placement).toBe('beside');
      expect(withOverlay.note).toMatch(/beside/i);

      const withBeside = (await machiningCommands.ADD_SIMULATION(
        { kind: 'machining', stage: 0, placement: 'beside', toolDiaMm: 6, material: 'softwood' },
        ctx
      )) as { ok: boolean; placement?: string; note?: string };
      expect(withBeside.ok).toBe(true);
      expect(withBeside.placement).toBe('beside');
      expect(withBeside.note).toBeUndefined();
    } finally {
      useStore.setState({ sceneGraph: prevGraph });
    }
  });
});
