import { describe, it, expect } from 'vitest';
import { exportLaserCutSvg } from '../src/utils/laserCutExporter';
import { generateLaserCutGcode } from '../src/utils/gcodeExporter';
import { reliefContours } from '../src/utils/patternEngrave';
import { texturedSurfaceOf } from '../src/utils/geomSurface';
import type { SceneGeom, SceneGraph } from '../src/types/scene';
import type { SurfaceTexture } from '../src/utils/surfaceTexture';

/*
 * A laser cannot carve a relief, so a patterned panel reaches it as lines: the
 * outlines of the pattern, on the face it is on, in a layer of their own so
 * the machine can mark them at a power that does not cut. These check that
 * the lines exist, that they land on the panel they belong to and inside its
 * border, and that they reach the G-code at the engrave power, not the cut
 * power.
 */

const HX = 0.05, HY = 0.03, HZ = 0.0015;

function sheet(z: number, normal: number): SceneGraph {
  const texture: SurfaceTexture = {
    pattern: 'masonry', depthM: -0.0008, cellM: 0.001, borderM: 0.004,
    seedAt: [0, 0, z], seedNormal: [0, 0, normal],
  };
  const geom: SceneGeom = { name: 'lid_geom', type: 'box', size: [HX, HY, HZ], textures: [texture] };
  return { nodes: [{ id: 'lid', name: 'lid', pos: [0, 0, 0.1], geoms: [geom], children: [] }] } as unknown as SceneGraph;
}

describe('pattern outlines', () => {
  it('are closed loops of a two-level pattern, inside the face and its border', () => {
    const geom = sheet(HZ, 1).nodes[0].geoms[0];
    const field = texturedSurfaceOf(geom)!.regions[0].field!;
    const lines = reliefContours(field);
    // The mortar is one connected network here, so its outline is a few long
    // closed loops rather than one per brick.
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.reduce((n, l) => n + l.length, 0)).toBeGreaterThan(40);
    for (const line of lines) {
      for (const [x, y, z] of line) {
        expect(Math.abs(x)).toBeLessThanOrEqual(HX - 0.003);
        expect(Math.abs(y)).toBeLessThanOrEqual(HY - 0.003);
        expect(z).toBeCloseTo(HZ, 9);
      }
    }
    // A brick is a closed outline, not a scatter of segments.
    const closed = lines.filter((l) => l.length > 3 && l[0].every((v, k) => Math.abs(v - l[l.length - 1][k]) < 1e-9));
    expect(closed.length).toBe(lines.length);
  });
});

describe('a patterned panel through the laser exporter', () => {
  const result = exportLaserCutSvg(sheet(HZ, 1));

  it('draws the pattern in its own engrave layer, on the panel', () => {
    expect(result.success).toBe(true);
    expect(result.svg).toContain('id="engrave-patterns"');
    const [panel] = result.panels!;
    expect(panel.engrave2D!.length).toBeGreaterThan(0);
    for (const line of panel.engrave2D!) {
      for (const p of line) {
        expect(p.x).toBeGreaterThanOrEqual(-1e-6);
        expect(p.y).toBeGreaterThanOrEqual(-1e-6);
        expect(p.x).toBeLessThanOrEqual(panel.width2D! + 1e-6);
        expect(p.y).toBeLessThanOrEqual(panel.height2D! + 1e-6);
      }
    }
  });

  it('engraves before it cuts, at the engrave power', () => {
    const gcode = generateLaserCutGcode(result.panels!, { laserPower: 9000, laserEngravePower: 1500, engraveFeedrate: 2500 });
    expect(gcode.success).toBe(true);
    const ops = gcode.operations.map((o) => o.type);
    expect(ops.indexOf('engrave')).toBeGreaterThanOrEqual(0);
    expect(ops.indexOf('engrave')).toBeLessThan(ops.indexOf('cut'));
    expect(gcode.gcode).toContain('M4 S1500');
    expect(gcode.gcode).toContain('F2500');
    expect(gcode.gcode).toContain('M4 S9000');
  });

  it('leaves the pattern out of a router job, and says to carve it instead', () => {
    const gcode = generateLaserCutGcode(result.panels!, { machineMode: 'cnc' });
    expect(gcode.operations.some((o) => o.type === 'engrave')).toBe(false);
    expect(gcode.warnings?.some((w) => /Relief carve/.test(w))).toBe(true);
  });

  it('cuts a panel patterned underneath face down, so it is never turned over', () => {
    // A hole off to one side tells the two faces apart. Turning a panel over
    // after cutting would put that hole on the wrong side of the assembly.
    const withHole = (z: number, normal: number) => {
      const g = sheet(z, normal);
      g.nodes[0].geoms.push({ name: 'hole', type: 'box', size: [0.005, 0.005, 0.01], pos: [0.03, 0, 0], csg: 'difference' } as SceneGeom);
      return g;
    };
    const holeAt = (r: ReturnType<typeof exportLaserCutSvg>) => {
      const p = r.panels![0];
      const xs = p.innerCutouts2D[0].map((q) => q.x);
      return ((Math.min(...xs) + Math.max(...xs)) / 2) / p.width2D!;
    };
    const over = exportLaserCutSvg(withHole(HZ, 1));
    const under = exportLaserCutSvg(withHole(-HZ, -1));
    const panel = under.panels![0];
    expect(panel.engrave2D!.length).toBeGreaterThan(0);
    // Viewed from below, the hole is on the other side of the panel.
    expect(holeAt(over)).toBeGreaterThan(0.6);
    expect(holeAt(under)).toBeLessThan(0.4);
    expect(panel.normal3D.z).toBeLessThan(0);
    expect(panel.engraveUnderside).toBeFalsy();
    expect(under.warnings?.some((w) => /Turn th(at|ose) panels? over/.test(w))).toBe(false);
    expect(under.warnings?.some((w) => /face down/.test(w))).toBe(true);
    // The engraving still lands inside the panel.
    for (const line of panel.engrave2D!) {
      for (const q of line) {
        expect(q.x).toBeGreaterThanOrEqual(-1e-6);
        expect(q.x).toBeLessThanOrEqual(panel.width2D! + 1e-6);
      }
    }
  });
});
