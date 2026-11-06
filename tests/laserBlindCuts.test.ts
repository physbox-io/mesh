import { describe, it, expect } from 'vitest';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS, type LaserPanel } from '../src/utils/laserCutExporter';
import { hardwareCutGeoms, type HardwareCutSpec } from '../src/utils/hardwareCuts';
import { cutGeometry } from '../src/utils/csg';
import { tapDrillRadius } from '../src/utils/metricThreads';
import { birdhousePreset } from '../src/presets/presetScenes';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

/*
 * A sheet cut goes right through or not at all. Every subtractive geom used to
 * be projected as a hole however deep it went, so a counterbore's head came out
 * as a hole the screw fell through and an O-ring groove as a disc out of the
 * seal face, with nothing said.
 */

const OPTIONS = { ...DEFAULT_LASER_OPTIONS, materialThickness: 0.006, jointMode: 'glue' as const };

/** A 120 x 120 x 6 mm plate with the features cut into its top face. */
function plate(specs: Partial<HardwareCutSpec>[]): SceneGraph {
  const node = {
    id: 'block', name: 'block', type: 'body', pos: [0, 0, 0], csgEnabled: true, joints: [], children: [],
    geoms: [{ name: 'b', type: 'box', size: [0.06, 0.06, 0.003] } as SceneGeom],
  } as unknown as SceneNode;
  specs.forEach((s, i) => {
    const spec = { group: `g${i}`, at: [0, 0, 0.003], normal: [0, 0, 1], ...s } as HardwareCutSpec;
    for (const g of hardwareCutGeoms(spec, node.id, node)) {
      node.geoms.push(g);
      Object.assign(g, cutGeometry(node, g)!);
    }
  });
  return { nodes: [node] };
}

const holeWidths = (panel: LaserPanel) =>
  panel.innerCutouts2D.map((c) => Math.max(...c.map((p) => p.x)) - Math.min(...c.map((p) => p.x)));

describe('blind cuts in a sheet', () => {
  it.each([
    ['counterbore', { kind: 'counterbore', size: 'M3' }, 'Counterbore'],
    ['nut trap', { kind: 'nut_trap', size: 'M5' }, 'Nut trap'],
    ['insert', { kind: 'insert', size: 'M3' }, 'in block'],
    ['O-ring groove', { kind: 'oring', size: '4×2' }, 'O-ring groove'],
  ] as const)('refuses a %s and names it', (_, spec, named) => {
    const r = exportLaserCutSvg(plate([spec]), OPTIONS);
    expect(r.success).toBe(false);
    expect(r.error).toContain(named);
    expect(r.error).toContain('sheet');
  });

  it('cuts a counterbore as deep as the sheet, which is a through hole', () => {
    // An M6 head is 6 mm deep, so in this plate the model itself goes through.
    const r = exportLaserCutSvg(plate([{ kind: 'counterbore', size: 'M6' }]), OPTIONS);
    expect(r.success).toBe(true);
  });

  it('still cuts a through hole', () => {
    const scene = plate([]);
    const node = scene.nodes[0];
    const hole = { name: 'h', type: 'cylinder', csg: 'difference', size: [0.004, 0.01], pos: [0, 0, 0] } as SceneGeom;
    node.geoms.push(hole);
    const r = exportLaserCutSvg(scene, OPTIONS);
    expect(r.success).toBe(true);
    expect(holeWidths(r.panels![0])[0]).toBeCloseTo(8, 1);
  });

  it('counts a cut exactly as long as the sheet is thick as through', () => {
    const scene = plate([]);
    scene.nodes[0].geoms.push({ name: 'h', type: 'cylinder', csg: 'difference', size: [0.004, 0.003], pos: [0, 0, 0] } as SceneGeom);
    expect(exportLaserCutSvg(scene, OPTIONS).success).toBe(true);
  });

  it('holds a cut in a solid box to the wall it passes through', () => {
    // A 60 mm block shelled into 6 mm walls, drilled from the top. The cut stops
    // in the air inside: through the top wall, nowhere near the bottom one.
    const node = {
      id: 'solid', name: 'solid', type: 'body', pos: [0, 0, 0], joints: [], children: [],
      geoms: [
        { name: 'b', type: 'box', size: [0.03, 0.03, 0.03] },
        { name: 'h', type: 'cylinder', csg: 'difference', size: [0.004, 0.01], pos: [0, 0, 0.025] },
      ],
    } as unknown as SceneNode;
    const r = exportLaserCutSvg({ nodes: [node] }, OPTIONS);
    expect(r.success).toBe(true);
    const holes = r.panels!.filter((p) => p.innerCutouts2D.length > 0);
    expect(holes.map((p) => p.name)).toEqual(['b_top']);
  });
});

describe('tapped holes', () => {
  it('cuts the tap drill, not the major diameter', () => {
    const scene = plate([]);
    const [tap] = hardwareCutGeoms(
      { group: 'g', kind: 'insert_boss', size: 'M6', bore: 'tapped', at: [0, 0, 0.003], normal: [0, 0, 1] } as HardwareCutSpec,
      'block',
    ).slice(1);
    scene.nodes[0].geoms.push({ ...tap, cutDepth: 0, cutAt: undefined, cutNormal: undefined, pos: [0, 0, 0], size: [tap.size![0], 0.01] } as SceneGeom);
    const r = exportLaserCutSvg(scene, OPTIONS);
    expect(r.success).toBe(true);
    expect(holeWidths(r.panels![0])[0]).toBeCloseTo(5, 1);
  });

  it('opens the drill by the thread fit, and leaves plain holes alone', () => {
    const hole = { type: 'cylinder', csg: 'difference', size: [0.003, 0], thread: { pitch: 0.001, fit: 0.0002 } } as SceneGeom;
    expect(tapDrillRadius(hole)! * 2000).toBeCloseTo(5.2, 6);
    expect(tapDrillRadius({ ...hole, thread: undefined })).toBeUndefined();
    expect(tapDrillRadius({ ...hole, csg: undefined })).toBeUndefined();
  });
});

describe('kerf on finger tabs', () => {
  const panel = (kerfMm: number) => {
    const r = exportLaserCutSvg(birdhousePreset, {
      ...DEFAULT_LASER_OPTIONS, jointMode: 'finger', kerf: kerfMm / 1000, jointClearance: 0, cornerRelief: 'none',
    });
    return (name: string) => {
      const pts = r.panels!.find((p) => p.name === name)!.outerPolygon2D;
      return {
        pts,
        w: Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)),
        h: Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)),
      };
    };
  };

  it.each([0.1, 0.15, 0.3, 0.39, 0.4, 0.6, 1])('grows every tab tip half a kerf at %s mm', (kerf) => {
    const nominal = panel(0)('floor_panel');
    const cut = panel(kerf)('floor_panel');
    expect(cut.w - nominal.w).toBeCloseTo(kerf, 3);
    expect(cut.h - nominal.h).toBeCloseTo(kerf, 3);
  });

  it.each([0.15, 0.39, 0.4, 0.6, 1])('leaves no fin at a corner at %s mm', (kerf) => {
    const nominal = panel(0)('left_panel');
    const cut = panel(kerf)('left_panel');
    expect(cut.h - nominal.h).toBeLessThan(kerf + 1e-6);
    // Thinner than the beam, a stretch of outline is a fin or a nub.
    const shortRuns = cut.pts.filter((p, i) => {
      const a = cut.pts[(i + cut.pts.length - 1) % cut.pts.length];
      const b = cut.pts[(i + 1) % cut.pts.length];
      const before = Math.hypot(p.x - a.x, p.y - a.y);
      const after = Math.hypot(b.x - p.x, b.y - p.y);
      return before < kerf && after > 1;
    });
    expect(shortRuns).toHaveLength(0);
  });
});
