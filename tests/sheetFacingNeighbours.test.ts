import { describe, it, expect } from 'vitest';
import { generateLaserCutGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import type { LaserPanel, Point2D } from '../src/utils/laserCutExporter';

/**
 * Facing a sheet part down to its drawn thickness (audit H30): the pass has to
 * run on a bit the job actually has, and must never cut into a neighbouring
 * part that is not being faced as deep.
 */

const panel = (id: string, outer: Point2D[], pos: Point2D, thicknessMm: number): LaserPanel => {
  const xs = outer.map((p) => p.x);
  const ys = outer.map((p) => p.y);
  return {
    id, name: id,
    thickness: thicknessMm / 1000,
    origin3D: { x: 0, y: 0, z: 0 }, normal3D: { x: 0, y: 0, z: 1 },
    uAxis3D: { x: 1, y: 0, z: 0 }, vAxis3D: { x: 0, y: 1, z: 0 },
    outerPolygon2D: outer, innerCutouts2D: [], edges3D: [],
    width2D: Math.max(...xs) - Math.min(...xs),
    height2D: Math.max(...ys) - Math.min(...ys),
    placedPos2D: pos, sheetIndex: 0,
  } as unknown as LaserPanel;
};
const rect = (w: number, h: number): Point2D[] => [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }];

const cnc = {
  ...DEFAULT_GCODE_OPTIONS,
  machineMode: 'cnc' as const,
  faceToThickness: true,
  sheetStockThicknessMm: [10],
  sheetSizeMm: [{ widthMm: 600, heightMm: 400 }],
  cutDepthZ: 10,
};

/** Every move the facing blocks make below the stock top, as segments. */
function facingCuts(gcode: string): { a: Point2D; b: Point2D }[] {
  const out: { a: Point2D; b: Point2D }[] = [];
  let x = 0, y = 0, z = 0;
  let inFacing = false;
  for (const line of gcode.split('\n')) {
    if (line.startsWith('; --- Facing')) inFacing = true;
    else if (line.startsWith('; --- Panel') || line.startsWith('; --- TOOL CHANGE')) inFacing = false;
    const m = /^G([01])\b/.exec(line);
    if (!m) continue;
    const nx = /X(-?[\d.]+)/.exec(line), ny = /Y(-?[\d.]+)/.exec(line), nz = /Z(-?[\d.]+)/.exec(line);
    const px = nx ? +nx[1] : x, py = ny ? +ny[1] : y, pz = nz ? +nz[1] : z;
    if (inFacing && z < -1e-6 && pz < -1e-6 && (px !== x || py !== y)) out.push({ a: { x, y }, b: { x: px, y: py } });
    x = px; y = py; z = pz;
  }
  return out;
}

function segDist(p: Point2D, a: Point2D, b: Point2D): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L = dx * dx + dy * dy;
  const t = L > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** How close any facing move's centre comes to a polygon's outline (sampled densely). */
function closestApproach(cuts: { a: Point2D; b: Point2D }[], poly: Point2D[]): number {
  let best = Infinity;
  for (const { a, b } of cuts) {
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.25));
    for (let i = 0; i <= n; i++) {
      const p = { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n };
      for (let k = 0; k < poly.length; k++) best = Math.min(best, segDist(p, poly[k], poly[(k + 1) % poly.length]));
    }
  }
  return best;
}
const placed = (poly: Point2D[], pos: Point2D) => poly.map((p) => ({ x: p.x + pos.x, y: p.y + pos.y }));

describe('sheet facing uses a bit the job has (H30)', () => {
  it('faces with the profile bit unless a facing bit is configured, so no undeclared tool change', () => {
    const r = generateLaserCutGcode([panel('a', rect(100, 60), { x: 20, y: 30 }, 8)], cnc);
    expect(r.success).toBe(true);
    expect(r.gcode).not.toMatch(/\bM6\b/);
    expect(r.operations.some((o) => o.type === 'pause_tool')).toBe(false);
    // The bit's edge reaches a radius of the 3.175 mm end mill past its centre.
    const cuts = facingCuts(r.gcode);
    const minX = Math.min(...cuts.flatMap((c) => [c.a.x, c.b.x]));
    expect(r.bounds.minX).toBeCloseTo(minX - 3.175 / 2, 3);
  });
});

describe('sheet facing never cuts into a neighbouring part (H30)', () => {
  it('stays a cutter radius clear of an unfaced part beside it', () => {
    // a: 8 mm part faced from 10 mm stock. b: drawn at the full 10 mm, 8 mm away.
    const a = panel('a', rect(100, 60), { x: 20, y: 30 }, 8);
    const b = panel('b', rect(80, 60), { x: 128, y: 30 }, 10);
    const r = generateLaserCutGcode([a, b], { ...cnc, facingBitDiameterMm: 12, pauseOnToolChange: false });
    expect(r.success).toBe(true);
    const cuts = facingCuts(r.gcode);
    expect(cuts.length).toBeGreaterThan(0);
    expect(closestApproach(cuts, placed(rect(80, 60), { x: 128, y: 30 }))).toBeGreaterThanOrEqual(6 - 0.01);
  });

  it('does not face a part standing in the notch of an L-shaped neighbour', () => {
    // a is an L 120 x 100 with a 70 x 60 notch out of its top right; b sits in it.
    const L: Point2D[] = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 40 }, { x: 50, y: 40 }, { x: 50, y: 100 }, { x: 0, y: 100 }];
    const a = panel('a', L, { x: 20, y: 20 }, 8);
    const b = panel('b', rect(50, 40), { x: 20 + 62, y: 20 + 50 }, 10);
    const r = generateLaserCutGcode([a, b], cnc);
    expect(r.success).toBe(true);
    const cuts = facingCuts(r.gcode);
    expect(cuts.length).toBeGreaterThan(0);
    expect(closestApproach(cuts, placed(rect(50, 40), { x: 82, y: 70 }))).toBeGreaterThanOrEqual(3.175 / 2 - 0.01);
    // And a still gets faced all over, right out to its own edges.
    expect(Math.max(...cuts.flatMap((c) => [c.a.x, c.b.x]))).toBeGreaterThanOrEqual(20 + 120);
    expect(Math.max(...cuts.flatMap((c) => [c.a.y, c.b.y]))).toBeGreaterThanOrEqual(20 + 100);
  });

  it('faces freely over a neighbour that is being faced just as deep', () => {
    const a = panel('a', rect(100, 60), { x: 20, y: 30 }, 8);
    const b = panel('b', rect(80, 60), { x: 128, y: 30 }, 8);
    const r = generateLaserCutGcode([a, b], { ...cnc, facingBitDiameterMm: 12, pauseOnToolChange: false });
    expect(r.success).toBe(true);
    expect(closestApproach(facingCuts(r.gcode), placed(rect(80, 60), { x: 128, y: 30 }))).toBeLessThan(6);
  });

  it('refuses, in one sentence, when the parts are too close to face one without the other', () => {
    const a = panel('a', rect(100, 60), { x: 20, y: 30 }, 8);
    const b = panel('b', rect(80, 60), { x: 122, y: 30 }, 10); // 2 mm apart
    const r = generateLaserCutGcode([a, b], cnc);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^a cannot be faced without cutting into b/);
    expect(r.error!.split(/\.\s/).length).toBe(1);
  });
});
