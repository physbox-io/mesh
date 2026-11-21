import { describe, it, expect } from 'vitest';
import { generateLaserCutGcode, DEFAULT_GCODE_OPTIONS } from '../src/utils/gcodeExporter';
import type { LaserPanel, Point2D } from '../src/utils/laserCutExporter';

/**
 * Panel cut order on a sheet (audit H32): a loop is never cut before every
 * loop inside it. A part nested in another part's cutout has to be cut out
 * (its holes first, then its outline) before the cutout around it frees the
 * slug it sits on; contour slices already did this (cf08441).
 */

const rect = (w: number, h: number, x = 0, y = 0): Point2D[] => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const panel = (id: string, outer: Point2D[], holes: Point2D[][], pos: Point2D): LaserPanel => {
  const xs = outer.map((p) => p.x), ys = outer.map((p) => p.y);
  return {
    id, name: id, thickness: 0.006,
    origin3D: { x: 0, y: 0, z: 0 }, normal3D: { x: 0, y: 0, z: 1 },
    uAxis3D: { x: 1, y: 0, z: 0 }, vAxis3D: { x: 0, y: 1, z: 0 },
    outerPolygon2D: outer, innerCutouts2D: holes, edges3D: [],
    width2D: Math.max(...xs) - Math.min(...xs), height2D: Math.max(...ys) - Math.min(...ys),
    placedPos2D: pos, sheetIndex: 0,
  } as unknown as LaserPanel;
};

// A frame with a window; a ring standing in the window; a core in the ring's hole.
const frame = () => panel('frame', rect(200, 200), [rect(160, 160, 20, 20)], { x: 10, y: 10 });
const ring = () => panel('ring', rect(140, 140), [rect(80, 80, 30, 30)], { x: 40, y: 40 });
const core = () => panel('core', rect(60, 60), [rect(10, 10, 25, 25)], { x: 80, y: 80 });

const order = (ps: LaserPanel[], machineMode: 'cnc' | 'laser') => {
  const r = generateLaserCutGcode(ps, { ...DEFAULT_GCODE_OPTIONS, machineMode, cutDepthZ: 6 });
  expect(r.success).toBe(true);
  return r.operations.filter((o) => o.type === 'cut').map((o) => o.id);
};

describe('panel cut order follows nesting (H32)', () => {
  for (const machineMode of ['cnc', 'laser'] as const) {
    it(`cuts a part in another's window, holes and all, before the window (${machineMode})`, () => {
      const ids = order([frame(), ring(), core()], machineMode);
      const at = (id: string) => {
        const i = ids.indexOf(id);
        expect(i).toBeGreaterThanOrEqual(0);
        return i;
      };
      // Innermost first, each loop only after everything inside it.
      expect(at('core_cutout_0')).toBeLessThan(at('core_outer'));
      expect(at('core_outer')).toBeLessThan(at('ring_cutout_0'));
      expect(at('ring_cutout_0')).toBeLessThan(at('ring_outer'));
      expect(at('ring_outer')).toBeLessThan(at('frame_cutout_0'));
      expect(at('frame_cutout_0')).toBeLessThan(at('frame_outer'));
    });
  }

  it('leaves the order of parts that do not nest exactly as it was', () => {
    const a = panel('a', rect(80, 60), [rect(20, 20, 10, 10), rect(20, 20, 50, 30)], { x: 10, y: 10 });
    const b = panel('b', rect(80, 60), [rect(20, 20, 30, 20)], { x: 110, y: 10 });
    expect(order([a, b], 'cnc')).toEqual(['a_cutout_0', 'a_cutout_1', 'a_outer', 'b_cutout_0', 'b_outer']);
  });
});
