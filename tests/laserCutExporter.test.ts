import { describe, it, expect } from 'vitest';
import { exportLaserCutSvg, extractPanelsFromScene, DEFAULT_LASER_OPTIONS } from '../src/utils/laserCutExporter';
import { birdhousePreset, birdhouseScadPreset, stackedCubesPreset } from '../src/presets/presetScenes';
import type { SceneGraph } from '../src/types/scene';

describe('Laser Cut Exporter Engine', () => {
  it('unwraps Birdhouse (Primitives) scene into 2D SVG panels with finger joints', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'finger',
    });

    expect(result.success).toBe(true);
    expect(result.panels).toBeDefined();
    expect(result.panels!.length).toBeGreaterThanOrEqual(6);
    expect(result.svg).toContain('<svg');
    expect(result.svg).toContain('stroke="#FF0000"'); // Cut paths
    expect(result.svg).toContain('fill="#0000FF"');   // Engraved label text
    expect(result.svg).toContain('floor_panel');
    expect(result.svg).toContain('back_panel');
  });

  it('unwraps Birdhouse (Primitives) scene with glue mode (plain cut edges)', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'glue',
    });

    expect(result.success).toBe(true);
    expect(result.panels).toBeDefined();
    expect(result.panels!.length).toBeGreaterThanOrEqual(6);
    expect(result.svg).toContain('Joint=glue');
  });

  it('unwraps Birdhouse (Primitives) scene with Tab & Slot (Mortise and Tenon) joints', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'slot',
    });

    expect(result.success).toBe(true);
    expect(result.panels).toBeDefined();
    expect(result.svg).toContain('Joint=slot');
    // Check that interior rectangular slots were cut inside mortise panels
    const hasMortiseSlots = result.panels!.some(p => p.innerCutouts2D.length > 0);
    expect(hasMortiseSlots).toBe(true);
  });

  it('unwraps Birdhouse (OpenSCAD) scene', () => {
    const result = exportLaserCutSvg(birdhouseScadPreset, DEFAULT_LASER_OPTIONS);

    expect(result).toBeDefined();
  });

  it('returns explicit error when scene contains only unsupported sphere geometry', () => {
    const sphereScene: SceneGraph = {
      nodes: [
        {
          id: 'ball',
          name: 'ball',
          type: 'body',
          pos: [0, 0, 0],
          joints: [],
          geoms: [
            { name: 'sphere_geom', type: 'sphere', size: [0.05], pos: [0, 0, 0] }
          ],
          children: []
        }
      ]
    };

    const result = exportLaserCutSvg(sphereScene, DEFAULT_LASER_OPTIONS);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Laser cut export failed');
    expect(result.error).toContain('unsupported curved geometries');
  });
});

// ---------------------------------------------------------------------------
// Joint geometry
// ---------------------------------------------------------------------------

function segmentsCross(a: any, b: any, c: any, d: any) {
  const cross = (p: any, q: any) => p.x * q.y - p.y * q.x;
  const sub = (p: any, q: any) => ({ x: p.x - q.x, y: p.y - q.y });
  const d1 = cross(sub(d, c), sub(a, c));
  const d2 = cross(sub(d, c), sub(b, c));
  const d3 = cross(sub(b, a), sub(c, a));
  const d4 = cross(sub(b, a), sub(d, a));
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) &&
         ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9));
}

function selfIntersects(poly: any[]) {
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return true;
    }
  }
  return false;
}


// Duplicate points at a corner split a fold-back into two harmless-looking
// turns, so any check for one has to collapse them first.
function dedupe(poly: any[]) {
  const out: any[] = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-7) out.push(p);
  }
  while (out.length > 1 &&
         Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) < 1e-7) {
    out.pop();
  }
  return out;
}

/** Sharpest reversal anywhere in a closed outline, in degrees (180 = a spike). */
function sharpestTurn(poly: any[]) {
  const pts = dedupe(poly);
  const n = pts.length;
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    if (l1 < 1e-9 || l2 < 1e-9) continue;
    const dot = ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (l1 * l2);
    worst = Math.max(worst, (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI);
  }
  return worst;
}

describe('Laser cut joint geometry', () => {
  for (const mode of ['finger', 'slot', 'glue'] as const) {
    it(`produces simple, non-self-intersecting cut outlines in ${mode} mode`, () => {
      const result = exportLaserCutSvg(birdhousePreset, {
        ...DEFAULT_LASER_OPTIONS,
        jointMode: mode,
      });

      expect(result.success).toBe(true);
      for (const panel of result.panels!) {
        expect(selfIntersects(panel.outerPolygon2D), `${panel.name} outline`).toBe(false);
        for (const cutout of panel.innerCutouts2D) {
          expect(selfIntersects(cutout), `${panel.name} cutout`).toBe(false);
        }
      }
    });
  }

  it('joints every panel of the birdhouse, including the roof and gable ends', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'finger',
    });

    // A jointed panel is no longer the plain rectangle/pentagon it started as.
    for (const panel of result.panels!) {
      expect(panel.outerPolygon2D.length, `${panel.name} should carry joints`).toBeGreaterThan(6);
    }
    expect(result.warnings ?? []).toEqual([]);
  });

  it('leaves edges straight in glue mode', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'glue',
    });

    const floor = result.panels!.find(p => p.name === 'floor_panel')!;
    expect(floor.outerPolygon2D.length).toBe(4);
  });

  it('cuts interior mortises in Tab & Slot mode where the panel has room', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'slot',
    });

    const walls = result.panels!.filter(p => p.name === 'left_panel' || p.name === 'right_panel');
    expect(walls.length).toBe(2);
    for (const wall of walls) {
      expect(wall.innerCutouts2D.length, `${wall.name} mortises`).toBeGreaterThan(2);
    }
  });

  it('warns instead of silently ignoring joints it cannot express', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'slot',
    });

    expect(result.warnings!.some(w => w.includes('fell back to finger joints'))).toBe(true);
  });

  it('unwraps mesh geometry from its Y-up vertex space onto the right plane', () => {
    // A 120 x 120 x 3 mm sheet lying flat, written the way SceneGeom stores it.
    const half = 0.06;
    const t = 0.0015;
    const zUp: [number, number, number][] = [
      [-half, -half, -t], [half, -half, -t], [half, half, -t], [-half, half, -t],
      [-half, -half, t], [half, -half, t], [half, half, t], [-half, half, t],
    ];
    const vertices = zUp.flatMap(([x, y, z]) => [x, z, -y]); // Z-up -> Y-up
    const faces = [
      0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
      0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
      2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
    ];

    const scene: SceneGraph = {
      nodes: [{
        id: 'sheet', name: 'sheet', type: 'body', pos: [0, 0, 0], joints: [],
        geoms: [{ name: 'sheet', type: 'mesh', pos: [0, 0, 0], vertices, faces } as any],
        children: [],
      }],
    };

    const result = exportLaserCutSvg(scene, DEFAULT_LASER_OPTIONS);
    expect(result.success).toBe(true);
    expect(result.panels!.length).toBe(1);

    const panel = result.panels![0];
    // The sheet is flat in XY, so its normal must be Z and its face 120 x 120.
    expect(Math.abs(panel.normal3D.z)).toBeCloseTo(1, 3);
    expect(panel.thickness).toBeCloseTo(0.003, 5);
    expect(panel.width2D).toBeCloseTo(120, 1);
    expect(panel.height2D).toBeCloseTo(120, 1);
  });
});

describe('Laser cut panel extraction and nesting', () => {
  it('shells a solid box into six faces rather than cutting it as one square', () => {
    // "Smallest of three dimensions" is true of one axis on every box, so a cube
    // used to be mistaken for a sheet and exported as a single square.
    const result = exportLaserCutSvg(stackedCubesPreset, DEFAULT_LASER_OPTIONS);

    expect(result.success).toBe(true);
    expect(result.panels!.length).toBe(12); // two cubes, six faces each
    for (const cube of ['cube1_geom', 'cube2_geom']) {
      for (const face of ['front', 'back', 'left', 'right', 'top', 'bottom']) {
        expect(result.panels!.some(p => p.name === `${cube}_${face}`)).toBe(true);
      }
    }
    // Every face butts against four others, so none should be left unjointed.
    expect(result.warnings ?? []).toEqual([]);
  });

  it('still treats a genuine sheet as one panel', () => {
    const result = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);
    expect(result.panels!.some(p => p.name === 'floor_panel')).toBe(true);
    expect(result.panels!.some(p => p.name.startsWith('floor_panel_'))).toBe(false);
  });

  it('nests onto multiple sheets without panels landing on top of each other', () => {
    // Sheets stack vertically in one SVG, so a panel's placed position has to
    // include its sheet's offset.
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      sheetWidth: 0.3,
      sheetHeight: 0.3,
    });

    expect(result.success).toBe(true);
    expect(result.sheetCount!).toBeGreaterThan(1);

    const boxes = result.panels!.map(p => ({
      name: p.name,
      x: p.placedPos2D!.x, y: p.placedPos2D!.y,
      w: p.width2D!, h: p.height2D!,
    }));

    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        const overlaps = a.x < b.x + b.w && b.x < a.x + a.w &&
                         a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlaps, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }

    // ...and every panel sits inside the overall sheet stack.
    const totalHeight = 300 * result.sheetCount!;
    for (const b of boxes) {
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y + b.h).toBeLessThanOrEqual(totalHeight + 0.01);
    }
  });

  it('warns when a panel cannot fit the chosen sheet at all', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      sheetWidth: 0.1,
      sheetHeight: 0.1,
    });

    expect(result.warnings!.some(w => w.includes('Too big for a'))).toBe(true);
  });
});

describe('Laser cut SVG annotations', () => {
  it('includes panel labels and sheet outlines by default', () => {
    const result = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);

    expect(result.svg).toContain('<text');
    expect(result.svg).toContain('engrave-labels');
    expect(result.svg).toContain('floor_panel');
    expect(result.svg).toContain('<rect');
  });

  it('drops every text element but keeps the sheet outlines', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      includeLabels: false,
    });

    expect(result.svg).not.toContain('<text');
    expect(result.svg).not.toContain('engrave-labels');
    expect(result.svg).toContain('<rect');
    expect(result.svg).toContain('cut-paths');
  });

  it('emits cut paths alone when both annotations are off', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      includeLabels: false,
      includeSheetOutline: false,
    });

    expect(result.svg).not.toContain('<text');
    expect(result.svg).not.toContain('<rect');
    expect(result.svg).toContain('cut-paths');

    // The geometry itself must be untouched by the annotation settings.
    const withLabels = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);
    const paths = (s: string) => s.match(/<path d="[^"]+"/g) ?? [];
    expect(paths(result.svg!)).toEqual(paths(withLabels.svg!));
  });

  it('escapes panel names so a stray character cannot break the XML', () => {
    const scene = JSON.parse(JSON.stringify(birdhousePreset)) as SceneGraph;
    (scene.nodes[0] as any).children[0].geoms[0].name = 'floor <a & b> "x"';

    const result = exportLaserCutSvg(scene, DEFAULT_LASER_OPTIONS);
    expect(result.svg).toContain('floor &lt;a &amp; b&gt; &quot;x&quot;');
    expect(result.svg).not.toContain('floor <a & b>');
  });
});

describe('Laser cut corner quality', () => {
  const cornerCases = [
    ['birdhouse', birdhousePreset],
    ['stacked cubes', stackedCubesPreset],
  ] as const;

  it('keeps every finger when tabs are made long', () => {
    // Pulling joints back by a tab's own length would strip the fingers either
    // side of every corner, leaving bald steps. Parity, not pull-back, is what
    // makes room for a long tab, so the profile must not thin out as it grows.
    const featureCount = (overhang: number) =>
      exportLaserCutSvg(birdhousePreset, { ...DEFAULT_LASER_OPTIONS, tabOverhang: overhang })
        .panels!.map(p => p.outerPolygon2D.length);

    const flush = featureCount(0);
    for (const overhang of [0.004, 0.008, 0.012, 0.02]) {
      const long = featureCount(overhang);
      long.forEach((count, i) => {
        expect(count, `panel ${i} lost fingers at ${overhang * 1000}mm overhang`)
          .toBeGreaterThanOrEqual(flush[i]);
      });
    }
  });

  it('keeps corners clean however long the tabs get', () => {
    for (const overhang of [0.008, 0.02]) {
      const result = exportLaserCutSvg(birdhousePreset, {
        ...DEFAULT_LASER_OPTIONS,
        tabOverhang: overhang,
      });
      for (const panel of result.panels!) {
        expect(selfIntersects(panel.outerPolygon2D), `${panel.name} @${overhang}`).toBe(false);

        const poly = panel.outerPolygon2D;
        const n = poly.length;
        for (let i = 0; i < n; i++) {
          const prev = poly[(i - 1 + n) % n];
          const here = poly[i];
          const next = poly[(i + 1) % n];
          const l1 = Math.hypot(here.x - prev.x, here.y - prev.y);
          const l2 = Math.hypot(next.x - here.x, next.y - here.y);
          if (l1 < 1e-9 || l2 < 1e-9) continue;
          const dot = ((here.x - prev.x) * (next.x - here.x) +
                       (here.y - prev.y) * (next.y - here.y)) / (l1 * l2);
          expect(dot, `${panel.name} folds back at ${i}`).toBeGreaterThan(-0.98);
        }
      }
    }
  });

  it('grows tabs by the full overhang, however long', () => {
    const tip = (overhang: number) => {
      const floor = exportLaserCutSvg(birdhousePreset,
        { ...DEFAULT_LASER_OPTIONS, tabOverhang: overhang })
        .panels!.find(p => p.name === 'floor_panel')!;
      return floor.width2D!;
    };
    const base = tip(0);
    // Two opposite edges each gain the overhang.
    expect(tip(0.008) - base).toBeCloseTo(16, 0);
    expect(tip(0.02) - base).toBeCloseTo(40, 0);
  });

  for (const [label, scene] of cornerCases) {
    for (const mode of ['finger', 'slot'] as const) {
      it(`leaves no spurs or slivers on ${label} corners in ${mode} mode`, () => {
        const result = exportLaserCutSvg(scene, { ...DEFAULT_LASER_OPTIONS, jointMode: mode });
        const kerfMm = DEFAULT_LASER_OPTIONS.kerf * 1000;

        for (const panel of result.panels!) {
          const poly = panel.outerPolygon2D;
          const n = poly.length;

          for (let i = 0; i < n; i++) {
            const prev = poly[(i - 1 + n) % n];
            const here = poly[i];
            const next = poly[(i + 1) % n];

            const l1 = Math.hypot(here.x - prev.x, here.y - prev.y);
            const l2 = Math.hypot(next.x - here.x, next.y - here.y);
            if (l1 < 1e-9 || l2 < 1e-9) continue; // duplicate point, harmless

            // Nothing narrower than the beam that cuts it: such a segment is a
            // stray spur in the file and simply burns away on the machine.
            expect(l1, `${panel.name} segment ${i} is sub-kerf`).toBeGreaterThan(kerfMm);

            // A joint profile turns by 90 degrees at a time; a full reversal
            // means the outline folded back on itself.
            const dot = ((here.x - prev.x) * (next.x - here.x) +
                         (here.y - prev.y) * (next.y - here.y)) / (l1 * l2);
            expect(dot, `${panel.name} folds back at vertex ${i}`).toBeGreaterThan(-0.98);
          }
        }
      });
    }
  }

  it('cuts joints right up to a square corner but stops short of an obtuse one', () => {
    const jointed = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'finger',
    });
    const plain = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'glue',
    });

    const gable = jointed.panels!.find(p => p.name.startsWith('front_panel'))!;
    const plainGable = plain.panels!.find(p => p.name.startsWith('front_panel'))!;

    // Each export re-origins its panels independently, so compare in model space.
    const modelPts = (panel: typeof gable) =>
      panel.outerPolygon2D.map(q => ({
        x: q.x + panel.modelOffset2D!.x,
        y: q.y + panel.modelOffset2D!.y,
      }));

    const pts = modelPts(gable);
    const plainPts = modelPts(plainGable);
    const apex = plainPts.reduce((a, b) => (b.y > a.y ? b : a));

    // The peak is obtuse, so it must survive untouched: the outline still passes
    // exactly through it, and the joint profiles stop clear on both sides.
    const atApex = pts.findIndex(q => Math.hypot(q.x - apex.x, q.y - apex.y) < 0.01);
    expect(atApex, 'the gable peak must still be a vertex').toBeGreaterThanOrEqual(0);

    const n = pts.length;
    const before = pts[(atApex - 1 + n) % n];
    const after = pts[(atApex + 1) % n];
    const slopeGap = DEFAULT_LASER_OPTIONS.materialThickness * 1000 * 0.9;
    expect(Math.hypot(before.x - apex.x, before.y - apex.y),
      'no cut may run into the peak').toBeGreaterThan(slopeGap);
    expect(Math.hypot(after.x - apex.x, after.y - apex.y),
      'no cut may run into the peak').toBeGreaterThan(slopeGap);

    // A square-cornered panel needs no such pull-back, so its fingers still run
    // the length of every edge.
    const floor = jointed.panels!.find(p => p.name === 'floor_panel')!;
    expect(floor.outerPolygon2D.length).toBeGreaterThan(40);
  });
});

describe('Laser cut material thickness and tab length', () => {
  // On the floor panel's left/right edges, ignoring the ends, there are exactly
  // two x levels: the tab tips and the bottom of the recesses.
  const edgeLevels = (scene: SceneGraph, opts: Partial<LaserCutOptions>) => {
    const result = exportLaserCutSvg(scene, { ...DEFAULT_LASER_OPTIONS, ...opts });
    const floor = result.panels!.find(p => p.name === 'floor_panel')!;
    const off = floor.modelOffset2D!;
    const pts = floor.outerPolygon2D
      .map(q => ({ x: q.x + off.x, y: q.y + off.y }))
      .filter(q => Math.abs(q.y) < 40);
    const xs = pts.map(q => q.x).sort((a, b) => a - b);
    return {
      tabTip: -xs[0],                    // outermost material, from centre
      recessFloor: -xs[xs.length === 0 ? 0 : xs.findIndex(v => v > xs[0] + 0.5)],
      result,
    };
  };

  it('sizes joints from the stock being cut, not from how the model was drawn', () => {
    // The birdhouse is drawn with 3 mm panels. Cutting it from thicker stock has
    // to lengthen the tabs, or they will not span the panel they pass through.
    const thin = edgeLevels(birdhousePreset, { materialThickness: 0.003 });
    const thick = edgeLevels(birdhousePreset, { materialThickness: 0.006 });

    expect(thick.tabTip).toBeGreaterThan(thin.tabTip + 1);
    expect(thick.recessFloor).toBeLessThan(thin.recessFloor - 1);
  });

  it('lengthens tabs by the requested overhang without deepening the recesses', () => {
    const flush = edgeLevels(birdhousePreset, { tabOverhang: 0 });
    const proud = edgeLevels(birdhousePreset, { tabOverhang: 0.004 });

    // Half a kerf on top: a tab is drawn long by that much so it ends up at
    // nominal length once the beam has taken its share off the tip.
    const grown = proud.tabTip - flush.tabTip;
    expect(grown).toBeGreaterThan(4 - 1e-6);
    expect(grown).toBeLessThan(4 + DEFAULT_LASER_OPTIONS.kerf * 1000);
    // A longer tab sticks out further; it must not also eat into its own panel.
    expect(proud.recessFloor).toBeCloseTo(flush.recessFloor, 3);
  });

  it('keeps outlines clean at a non-default thickness and overhang', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.006,
      tabOverhang: 0.003,
    });

    expect(result.success).toBe(true);
    for (const panel of result.panels!) {
      expect(selfIntersects(panel.outerPolygon2D), `${panel.name}`).toBe(false);

      const poly = panel.outerPolygon2D;
      const n = poly.length;
      for (let i = 0; i < n; i++) {
        const prev = poly[(i - 1 + n) % n];
        const here = poly[i];
        const next = poly[(i + 1) % n];
        const l1 = Math.hypot(here.x - prev.x, here.y - prev.y);
        const l2 = Math.hypot(next.x - here.x, next.y - here.y);
        if (l1 < 1e-9 || l2 < 1e-9) continue;
        const dot = ((here.x - prev.x) * (next.x - here.x) +
                     (here.y - prev.y) * (next.y - here.y)) / (l1 * l2);
        expect(dot, `${panel.name} folds back at ${i}`).toBeGreaterThan(-0.98);
      }
    }
  });

  it('says so when the stock does not match what the model was drawn for', () => {
    const matched = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);
    expect(matched.warnings!.some(w => w.includes('drawn with'))).toBe(false);

    const mismatched = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      materialThickness: 0.006,
    });
    expect(mismatched.warnings!.some(w => w.includes('3.0 mm panels'))).toBe(true);
  });
});

describe('Laser cut joint fit', () => {
  // Width of one tab along the floor panel's outermost edge run.
  const tabWidth = (opts: Partial<LaserCutOptions>) => {
    const result = exportLaserCutSvg(birdhousePreset, { ...DEFAULT_LASER_OPTIONS, ...opts });
    const floor = result.panels!.find(p => p.name === 'floor_panel')!;
    const off = floor.modelOffset2D!;
    const pts = floor.outerPolygon2D.map(q => ({ x: q.x + off.x, y: q.y + off.y }));
    const outer = Math.min(...pts.map(p => p.y));
    const xs = pts.filter(p => Math.abs(p.y - outer) < 0.01).map(p => p.x).sort((a, b) => a - b);
    return xs[3] - xs[2]; // an interior tab, clear of the end cells
  };

  const panelSize = (opts: Partial<LaserCutOptions>) => {
    const result = exportLaserCutSvg(birdhousePreset, { ...DEFAULT_LASER_OPTIONS, ...opts });
    const floor = result.panels!.find(p => p.name === 'floor_panel')!;
    return floor.width2D!;
  };

  it('tightens the fit by widening tabs against their slots', () => {
    const nominal = tabWidth({ jointClearance: 0 });
    const tight = tabWidth({ jointClearance: -0.0002 });
    const loose = tabWidth({ jointClearance: 0.0002 });

    expect(tight - nominal).toBeCloseTo(0.2, 3);
    expect(nominal - loose).toBeCloseTo(0.2, 3);
  });

  it('changes the fit without changing the size of the part', () => {
    // This is the whole point of the setting: tab overhang buys a longer tab at
    // the cost of a bigger part, whereas fit is free of any dimensional change.
    const base = panelSize({ jointClearance: 0 });
    for (const clearance of [-0.0003, -0.0001, 0.0001, 0.0003]) {
      expect(panelSize({ jointClearance: clearance }), `clearance ${clearance}`).toBeCloseTo(base, 6);
    }
  });

  it('keeps outlines clean at an interference fit', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      jointClearance: -0.0003,
    });

    expect(result.success).toBe(true);
    for (const panel of result.panels!) {
      expect(selfIntersects(panel.outerPolygon2D), panel.name).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Subtractive CSG cutout projection
// ---------------------------------------------------------------------------

/**
 * A 200 x 200 mm sheet lying in the XY plane, 3 mm thick, carrying whatever
 * cutters the case under test needs. Its (u, v) frame is world (X, Y), so a
 * projected cutout can be reasoned about in millimetres directly.
 */
function sheetWithCutters(cutters: any[]): SceneGraph {
  return {
    nodes: [
      {
        id: 'sheet',
        name: 'sheet',
        type: 'body',
        pos: [0, 0, 0],
        joints: [],
        csgEnabled: true,
        geoms: [
          { name: 'sheet_panel', type: 'box', size: [0.1, 0.1, 0.0015], pos: [0, 0, 0] },
          ...cutters,
        ],
        children: [],
      },
    ],
  } as SceneGraph;
}

function sheetCutouts(cutters: any[]) {
  const { panels } = extractPanelsFromScene(sheetWithCutters(cutters), DEFAULT_LASER_OPTIONS);
  const sheet = panels.find(p => p.name === 'sheet_panel');
  expect(sheet, 'sheet panel was not extracted').toBeDefined();
  return sheet!.innerCutouts2D;
}

const extent = (loop: any[], axis: 'x' | 'y') => ({
  lo: Math.min(...loop.map(p => p[axis])),
  hi: Math.max(...loop.map(p => p[axis])),
});

describe('Subtractive CSG cutout projection', () => {
  it('projects an axis-normal cylinder as a circle of its radius', () => {
    const cutouts = sheetCutouts([
      { name: 'hole', type: 'cylinder', size: [0.018, 0.01], pos: [0.02, -0.03, 0], csg: 'difference' },
    ]);

    expect(cutouts).toHaveLength(1);
    const x = extent(cutouts[0], 'x');
    const y = extent(cutouts[0], 'y');
    // Centred on the geom, 18 mm in every direction.
    expect((x.lo + x.hi) / 2).toBeCloseTo(20, 1);
    expect((y.lo + y.hi) / 2).toBeCloseTo(-30, 1);
    expect(x.hi - x.lo).toBeCloseTo(36, 0);
    expect(y.hi - y.lo).toBeCloseTo(36, 0);
  });

  it('projects a cylinder whose axis lies in the panel as a slot, not a circle', () => {
    // euler [90, 0, 0] takes local +Z onto -Y, so the bore runs along the sheet.
    const cutouts = sheetCutouts([
      { name: 'slot', type: 'cylinder', size: [0.01, 0.03], pos: [0, 0, 0], euler: [90, 0, 0], csg: 'difference' },
    ]);

    expect(cutouts).toHaveLength(1);
    const x = extent(cutouts[0], 'x');
    const y = extent(cutouts[0], 'y');
    expect(x.hi - x.lo).toBeCloseTo(20, 0); // 2r across the bore
    expect(y.hi - y.lo).toBeCloseTo(60, 0); // 2 * half-length along it
  });

  it('projects a rotated box cutout at its true orientation', () => {
    const cutouts = sheetCutouts([
      { name: 'angled', type: 'box', size: [0.02, 0.005, 0.05], euler: [0, 0, 45], csg: 'difference' },
    ]);

    expect(cutouts).toHaveLength(1);
    // Support width of the rotated box: (0.02 + 0.005) * cos(45) each side.
    // Ignoring the rotation gives the unrotated 20 mm instead.
    const halfSpan = 0.025 * Math.SQRT1_2 * 1000;
    expect(extent(cutouts[0], 'x').hi).toBeCloseTo(halfSpan, 1);
    expect(extent(cutouts[0], 'y').hi).toBeCloseTo(halfSpan, 1);
  });

  it('places a fromto cylinder at the midpoint of its endpoints', () => {
    // No pos at all: the frame comes entirely from fromto, as csg.ts evaluates it.
    const cutouts = sheetCutouts([
      { name: 'bar', type: 'cylinder', size: [0.005], fromto: [-0.03, 0.02, 0, 0.03, 0.02, 0], csg: 'difference' },
    ]);

    expect(cutouts).toHaveLength(1);
    const x = extent(cutouts[0], 'x');
    const y = extent(cutouts[0], 'y');
    expect((y.lo + y.hi) / 2).toBeCloseTo(20, 1); // offset in Y, not at the origin
    expect(x.hi - x.lo).toBeCloseTo(60, 0);       // full length along X
    expect(y.hi - y.lo).toBeCloseTo(10, 0);       // 2r across
  });

  it('ignores a cutter that never reaches the panel plane', () => {
    // Directly over the sheet in (u, v), but 500 mm off it along the normal.
    expect(sheetCutouts([
      { name: 'elsewhere', type: 'box', size: [0.01, 0.01, 0.01], pos: [0, 0, 0.5], csg: 'difference' },
    ])).toHaveLength(0);
  });

  it('keeps a cutout that straddles the panel edge', () => {
    const cutouts = sheetCutouts([
      { name: 'notch', type: 'cylinder', size: [0.02, 0.01], pos: [0.1, 0, 0], csg: 'difference' },
    ]);

    expect(cutouts).toHaveLength(1);
  });

  it('treats subtractive geoms as cutters rather than stock', () => {
    // A difference box used to be shelled into six panels of its own, and a
    // difference capsule used to fail the export as unsupported curved geometry.
    const { panels, invalidGeoms } = extractPanelsFromScene(
      sheetWithCutters([
        { name: 'shaft', type: 'box', size: [0.02, 0.02, 0.05], csg: 'difference' },
        { name: 'pin', type: 'capsule', size: [0.006, 0.02], euler: [90, 0, 0], csg: 'difference' },
      ]),
      DEFAULT_LASER_OPTIONS
    );

    expect(invalidGeoms).toHaveLength(0);
    expect(panels).toHaveLength(1);
    expect(panels[0].innerCutouts2D).toHaveLength(2);
  });
});

describe('Laser cut corners are never degenerate', () => {
  // A recess reaching a corner removes the corner, so the outline has to turn at
  // where the two offset profiles meet. Emitting the modelled corner instead
  // sends it to a point off the boundary and straight back — a hairline spur
  // that renders as a stray line and confuses a cutter's path planner.
  it('never folds back on itself, at any thickness or tab length', () => {
    for (const scene of [birdhousePreset, stackedCubesPreset]) {
      for (const materialThickness of [0.003, 0.006]) {
        for (const tabOverhang of [0, 0.006]) {
          for (const jointMode of ['finger', 'slot'] as const) {
            const result = exportLaserCutSvg(scene, {
              ...DEFAULT_LASER_OPTIONS, materialThickness, tabOverhang, jointMode,
            });
            for (const panel of result.panels!) {
              const label = `${panel.name} t=${materialThickness} o=${tabOverhang} ${jointMode}`;
              expect(sharpestTurn(panel.outerPolygon2D), label).toBeLessThan(170);
            }
          }
        }
      }
    }
  });

  it('mitres a corner where cuts meet from both edges', () => {
    // Both edges recessed into the same corner: the outline must pass through
    // the intersection of the two recess floors, not the original corner.
    const result = exportLaserCutSvg(birdhousePreset, DEFAULT_LASER_OPTIONS);
    const plain = exportLaserCutSvg(birdhousePreset,
      { ...DEFAULT_LASER_OPTIONS, jointMode: 'glue' });

    for (const panel of result.panels!) {
      const base = plain.panels!.find(p => p.name === panel.name)!;
      const off = panel.modelOffset2D!;
      const bo = base.modelOffset2D!;
      const corners = base.outerPolygon2D.map(q => ({ x: q.x + bo.x, y: q.y + bo.y }));
      const pts = dedupe(panel.outerPolygon2D).map(q => ({ x: q.x + off.x, y: q.y + off.y }));

      // No vertex may sit on a modelled corner that has been cut away, i.e. one
      // the outline only touches by doubling back.
      for (const c of corners) {
        const touching = pts.filter(q => Math.hypot(q.x - c.x, q.y - c.y) < 1e-6);
        expect(touching.length, `${panel.name} revisits corner`).toBeLessThanOrEqual(1);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CNC inside-corner relief
// ---------------------------------------------------------------------------

/** A 40 x 20 mm rectangular pocket in the middle of the test sheet. */
const rectPocket = [
  { name: 'pocket', type: 'box', size: [0.02, 0.01, 0.05], csg: 'difference' },
];

/**
 * The pocket in the sheet's own (u, v) millimetres. Relief is applied by the
 * full export, which then shifts every panel into sheet space, so the offset it
 * recorded has to be added back to compare against the modelled rectangle.
 */
function pocketLoop(opts: Partial<typeof DEFAULT_LASER_OPTIONS>) {
  const result = exportLaserCutSvg(sheetWithCutters(rectPocket), {
    ...DEFAULT_LASER_OPTIONS,
    jointMode: 'glue',
    ...opts,
  });
  expect(result.success).toBe(true);
  const sheet = result.panels!.find(p => p.name === 'sheet_panel')!;
  expect(sheet.innerCutouts2D).toHaveLength(1);
  const off = sheet.modelOffset2D!;
  return sheet.innerCutouts2D[0].map(p => ({ x: p.x + off.x, y: p.y + off.y }));
}

describe('CNC inside-corner relief', () => {
  const BIT = 0.003175;
  const R = (BIT * 1000) / 2;

  it('leaves corners sharp when relief is off', () => {
    const loop = pocketLoop({ cornerRelief: 'none' });
    expect(loop).toHaveLength(4);
    expect(extent(loop, 'x').hi).toBeCloseTo(20, 3);
    expect(extent(loop, 'y').hi).toBeCloseTo(10, 3);
  });

  it('dogbones overcut along the corner bisector', () => {
    const loop = pocketLoop({ cornerRelief: 'dogbone', bitDiameter: BIT });

    // Both walls give way, by the bisector reach resolved onto each axis.
    const reach = (R - 0.05) * Math.SQRT1_2 + R;
    expect(extent(loop, 'x').hi).toBeCloseTo(20 + reach, 1);
    expect(extent(loop, 'y').hi).toBeCloseTo(10 + reach, 1);
    expect(selfIntersects(loop)).toBe(false);
  });

  it('t-bones hide the overcut in the longer wall, keeping the end faces flat', () => {
    const loop = pocketLoop({ cornerRelief: 'tbone', bitDiameter: BIT });

    // The 40 mm walls take the bite; the 20 mm end faces a tenon seats
    // against are left exactly where they were.
    expect(extent(loop, 'y').hi).toBeCloseTo(10 + R, 1);
    // Flat but for the sliver of deliberate overlap that keeps the union of
    // circle and rectangle from pinching to nothing at the corner.
    expect(extent(loop, 'x').hi).toBeCloseTo(20.05, 2);
    expect(selfIntersects(loop)).toBe(false);
  });

  it('clears the full bit radius at every corner it relieves', () => {
    for (const style of ['dogbone', 'tbone'] as const) {
      const loop = pocketLoop({ cornerRelief: style, bitDiameter: BIT });

      // The relief exists so the bit centre can reach within R of the corner
      // without the bit crossing a wall. That means some cut point must lie
      // beyond the corner, further out than the bit could otherwise go.
      for (const corner of [{ x: 20, y: 10 }, { x: -20, y: 10 }, { x: 20, y: -10 }, { x: -20, y: -10 }]) {
        const beyond = loop.some(p =>
          Math.abs(p.x) > Math.abs(corner.x) + 0.5 || Math.abs(p.y) > Math.abs(corner.y) + 0.5
        );
        expect(beyond, `${style} relief at ${corner.x},${corner.y}`).toBe(true);
      }
    }
  });

  it('does not sprout relief on the many shallow corners of a round hole', () => {
    const { panels } = extractPanelsFromScene(
      sheetWithCutters([
        { name: 'bore', type: 'cylinder', size: [0.01, 0.05], csg: 'difference' },
      ]),
      { ...DEFAULT_LASER_OPTIONS, cornerRelief: 'dogbone', bitDiameter: BIT }
    );
    const loop = panels.find(p => p.name === 'sheet_panel')!.innerCutouts2D[0];

    expect(loop).toHaveLength(48);
    expect(extent(loop, 'x').hi).toBeCloseTo(10, 1); // still a 10 mm bore
  });

  it('warns rather than mangling a joint the bit cannot fit into', () => {
    // A birdhouse mortise is as deep as the stock is thick, so an eighth-inch
    // bit has no room to swing at its corners; a 1.5 mm one does.
    const tooBig = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS, jointMode: 'slot', cornerRelief: 'tbone', bitDiameter: 0.003175,
    });
    expect(tooBig.warnings!.some(w => w.includes('un-relieved'))).toBe(true);

    const fits = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS, jointMode: 'slot', cornerRelief: 'tbone', bitDiameter: 0.0015,
    });
    expect(fits.warnings!.some(w => w.includes('un-relieved'))).toBe(false);

    for (const panel of tooBig.panels!) {
      for (const cutout of panel.innerCutouts2D) {
        expect(selfIntersects(cutout), `${panel.name} cutout`).toBe(false);
      }
    }
  });

  it('relieves the finger joints and mortises of a real model', () => {
    for (const [mode, style] of [['finger', 'dogbone'], ['slot', 'tbone']] as const) {
      const plain = exportLaserCutSvg(birdhousePreset, {
        ...DEFAULT_LASER_OPTIONS, jointMode: mode,
      });
      const relieved = exportLaserCutSvg(birdhousePreset, {
        ...DEFAULT_LASER_OPTIONS, jointMode: mode, cornerRelief: style, bitDiameter: BIT,
      });

      expect(relieved.success).toBe(true);
      expect(relieved.svg).toContain(`Relief=${style}`);

      const verts = (r: any) => r.panels.reduce(
        (n: number, p: any) => n + p.outerPolygon2D.length +
          p.innerCutouts2D.reduce((m: number, c: any[]) => m + c.length, 0), 0);
      expect(verts(relieved), mode).toBeGreaterThan(verts(plain));

      for (const panel of relieved.panels!) {
        expect(selfIntersects(panel.outerPolygon2D), `${panel.name} outline`).toBe(false);
        for (const cutout of panel.innerCutouts2D) {
          expect(selfIntersects(cutout), `${panel.name} cutout`).toBe(false);
        }
      }
    }
  });

  it('supports custom user-specifiable X by Y sheet bounds in mm and recalculates sheet counts', () => {
    // 600 x 400 mm sheet
    const large = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      sheetWidth: 0.600,
      sheetHeight: 0.400,
    });
    // Micro 150 x 150 mm sheet
    const small = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      sheetWidth: 0.150,
      sheetHeight: 0.150,
    });

    expect(large.success).toBe(true);
    expect(small.success).toBe(true);
    expect(small.sheetCount!).toBeGreaterThan(large.sheetCount!);
    expect(small.svg).toContain('Sheet 1 (150mm x 150mm)');
  });

  it('auto-scales cuts down when autoScale is enabled or maxSheets is specified', () => {
    // 150 x 150 mm sheet with autoScale enabled and maxSheets = 2
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      sheetWidth: 0.150,
      sheetHeight: 0.150,
      autoScale: true,
      maxSheets: 2,
    });

    expect(result.success).toBe(true);
    expect(result.scaleFactor).toBeLessThan(1.0);
    expect(result.sheetCount).toBeLessThanOrEqual(2);
    expect(result.warnings!.some(w => w.includes('scaled to'))).toBe(true);
  });

  it('honours the sheet limit against the jointed cut, not the raw faces', () => {
    // The scale search has to measure panels with their fingers and mortises
    // already cut — tabs stick out by the stock thickness and do not shrink with
    // the scale, so sizing off the bare faces silently spills onto a second sheet.
    for (const [w, h] of [[0.3, 0.3], [0.15, 0.15], [0.6, 0.4]] as const) {
      for (const jointMode of ['finger', 'slot', 'glue'] as const) {
        const result = exportLaserCutSvg(birdhousePreset, {
          ...DEFAULT_LASER_OPTIONS,
          jointMode,
          sheetWidth: w,
          sheetHeight: h,
          autoScale: true,
          maxSheets: 1,
        });

        expect(result.success).toBe(true);
        expect(
          result.sheetCount,
          `${w * 1000}x${h * 1000} ${jointMode} used ${result.sheetCount} sheets`
        ).toBe(1);

        // ...and every panel really is inside that one sheet.
        for (const p of result.panels!) {
          expect(p.placedPos2D!.x + p.width2D!).toBeLessThanOrEqual(w * 1000 + 0.01);
          expect(p.placedPos2D!.y + p.height2D!).toBeLessThanOrEqual(h * 1000 + 0.01);
        }
      }
    }
  });

  it('keeps the cut path free of zero-length moves when tabs stand proud', () => {
    // A tab that reaches a corner leaves no separate mitre to emit, so the
    // rebuilt corner lands on the step point the edge is about to draw. Emitting
    // both put a zero-length move in the path — a pierce that cuts nothing.
    for (const tabOverhang of [0, 0.002, 0.005]) {
      const result = exportLaserCutSvg(birdhousePreset, { ...DEFAULT_LASER_OPTIONS, tabOverhang });
      expect(result.success).toBe(true);

      for (const panel of result.panels!) {
        const loops = [panel.outerPolygon2D, ...panel.innerCutouts2D];
        for (const loop of loops) {
          for (let i = 0; i < loop.length; i++) {
            const a = loop[i];
            const b = loop[(i + 1) % loop.length];
            expect(
              Math.hypot(b.x - a.x, b.y - a.y),
              `${panel.name} has a zero-length move at vertex ${i} (overhang ${tabOverhang * 1000}mm)`
            ).toBeGreaterThan(1e-6);
          }
        }
      }
    }
  });

  it('stands tabs proud by the amount asked for, measured off the mate', () => {
    // Overhang is a distance off the mating panel's face. Where panels meet at
    // an angle that distance spans 1 / sin(b) in this panel's plane, exactly as
    // the thickness does, so a ridge tab has to grow by more than the nominal
    // figure to stand as proud as a right-angled one.
    const flush = exportLaserCutSvg(birdhousePreset, { ...DEFAULT_LASER_OPTIONS, tabOverhang: 0 });
    const proud = exportLaserCutSvg(birdhousePreset, { ...DEFAULT_LASER_OPTIONS, tabOverhang: 0.004 });

    const roofOf = (r: typeof flush) => r.panels!.find(p => p.name === 'roof_left_panel')!;
    const before = roofOf(flush);
    const after = roofOf(proud);

    // Eave and rake edges are right-angled joints: 4 mm proud at each end.
    expect(after.height2D! - before.height2D!).toBeCloseTo(8.0, 1);
    // The ridge is the angled one, and only that end of this edge is jointed.
    const ridgeGrowth = after.width2D! - before.width2D!;
    expect(ridgeGrowth).toBeGreaterThan(4.5);
    expect(ridgeGrowth).toBeLessThan(6.5);
  });

  it('does not scale down when the model already fits the sheet budget', () => {
    const result = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS,
      sheetWidth: 0.6,
      sheetHeight: 0.4,
      autoScale: true,
      maxSheets: 2,
    });

    expect(result.success).toBe(true);
    expect(result.scaleFactor).toBe(1.0);
    expect(result.sheetCount).toBeLessThanOrEqual(2);
  });
});
