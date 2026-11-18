import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import { exportSheetUnfold, type SheetUnfoldOptions } from '../src/utils/sheetUnfoldExporter';
import { foldSheetUnfold } from '../src/utils/sheetFoldSimulation';
import { analyzeMesh } from '../src/utils/meshIntegrity';
import { createLattice, vertexAt, addFace, serializeCage } from '../src/utils/latticeMesh';

const scene = (node: SceneNode): SceneGraph => ({ nodes: [node] } as unknown as SceneGraph);

const box = (hx: number, hy: number, hz: number) => scene({
  id: 'b', name: 'Box', pos: [0.01, 0.02, 0.03], euler: [0, 0, 20],
  geoms: [{ name: 'g', type: 'box', size: [hx, hy, hz] }], joints: [], children: [],
} as SceneNode);

/** A square pyramid: its four sides fold at angles that are not right angles. */
const pyramid = () => {
  const h = 0.025, top = 0.04;
  return scene({
    id: 'p', name: 'Pyramid', pos: [0, 0, 0],
    geoms: [{
      name: 'g', type: 'mesh', size: [h, h, top],
      renderVertices: [-h, -h, 0, h, -h, 0, h, h, 0, -h, h, 0, 0, 0, top],
      faces: [0, 3, 2, 0, 2, 1, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4],
    }],
    joints: [], children: [],
  } as SceneNode);
};

/** A step: a mountain bend up, then a valley bend over. */
const step = () => {
  const lat = createLattice(0.001);
  const v = (x: number, y: number, z: number) => vertexAt(lat, x, y, z);
  addFace(lat, [v(0, 0, 0), v(0, 30, 0), v(40, 30, 0), v(40, 0, 0)]);
  addFace(lat, [v(40, 0, 0), v(40, 30, 0), v(40, 30, 30), v(40, 0, 30)]);
  addFace(lat, [v(40, 0, 30), v(40, 30, 30), v(70, 30, 30), v(70, 0, 30)]);
  return scene({
    id: 's', name: 'Step', pos: [0, 0, 0], isLattice: true, latticeCage: serializeCage(lat), geoms: [], joints: [], children: [],
  } as SceneNode);
};

const METAL = { mode: 'sheet_metal' as const, thicknessMm: 2, bendRadiusMm: 1.5, kFactor: 0.44 };

const fold = (s: SceneGraph, o: Partial<SheetUnfoldOptions>, brake?: Partial<SheetUnfoldOptions>) => {
  const res = exportSheetUnfold(s, o);
  expect(res.success).toBe(true);
  return foldSheetUnfold(res, { ...METAL, ...o, ...brake });
};

const closed = (f: ReturnType<typeof foldSheetUnfold>) => {
  const m = analyzeMesh(Array.from(f.positions), Array.from(f.faces))!;
  expect(m.closed).toBe(true);
  expect(m.consistentlyWound).toBe(true);
  expect(m.volume).toBeGreaterThan(0);
  return m.volume;
};

describe('sheet fold simulation', () => {
  it('folds a papercraft cube net back into the cube', () => {
    const f = fold(box(0.025, 0.025, 0.025), { mode: 'papercraft', tabWidthMm: 0 });
    expect(f.folds).toBe(5);
    expect(f.deviation.maxMm).toBeLessThan(1e-3);
    // Six 50 mm faces of 0.3 mm card.
    expect(closed(f)).toBeCloseTo(6 * 50 * 50 * f.drawnThicknessMm, 0);
  });

  it('folds a papercraft pyramid at its own angles', () => {
    const f = fold(pyramid(), { mode: 'papercraft' });
    expect(f.folds).toBe(4);
    expect(f.deviation.maxMm).toBeLessThan(1e-3);
  });

  it('folds a sheet-metal box to its outside size, with the bends at the brake radius', () => {
    const f = fold(box(0.03, 0.02, 0.025), METAL);
    expect(f.folds).toBe(5);
    expect(f.deviation.maxMm).toBeLessThan(1e-3);
    const v = closed(f);
    // Under a shell of the box's outside area at 2 mm: the bends are rounded
    // and the corners where three faces meet are open.
    const shell = 2 * (60 * 40 + 60 * 50 + 40 * 50) * 2;
    expect(v).toBeLessThan(shell);
    expect(v).toBeGreaterThan(shell * 0.85);
    // Nothing sticks out past the model's outside.
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < f.positions.length; i++) {
      lo[i % 3] = Math.min(lo[i % 3], f.positions[i]);
      hi[i % 3] = Math.max(hi[i % 3], f.positions[i]);
    }
    const size = hi.map((h, a) => h - lo[a]).sort((a, b) => a - b);
    // Turned 20° about Z, so only the height is a plain figure.
    expect(hi[2] - lo[2]).toBeCloseTo(50, 2);
    expect(size[0]).toBeGreaterThan(40);
  });

  it('folds sheet-metal bends that are not right angles, and a valley bend', () => {
    expect(fold(pyramid(), METAL).deviation.maxMm).toBeLessThan(1e-3);
    const f = fold(step(), METAL);
    expect(f.folds).toBe(2);
    expect(f.deviation.maxMm).toBeLessThan(1e-3);
    closed(f);
  });

  it('shows a net made for another K-factor as a flange off the model', () => {
    // Made for K = 0.44, bent in metal that is 0.30: each bend comes out
    // (pi / 2) * 0.14 * 2 = 0.44 mm short, and it adds up across the box.
    const f = fold(box(0.03, 0.02, 0.025), METAL, { kFactor: 0.3 });
    expect(f.deviation.maxMm).toBeGreaterThan(0.2);
    expect(f.deviation.maxMm).toBeLessThan(2);
  });

  it('folds 24- and 36-sided sheet-metal cylinders without premature setback clamping (< 0.05 mm deviation)', () => {
    for (const facets of [24, 36]) {
      const cylScene = scene({
        id: `cyl_${facets}`,
        name: `Cyl_${facets}`,
        pos: [0, 0, 0],
        geoms: [{ name: 'c', type: 'cylinder', size: [0.025, 0.04], facets }],
        joints: [],
        children: [],
      } as SceneNode);
      const opts = { mode: 'sheet_metal' as const, thicknessMm: 1.5, bendRadiusMm: 1.5, kFactor: 0.44 };
      const res = exportSheetUnfold(cylScene, opts);
      expect(res.success).toBe(true);
      expect(res.warnings).toEqual([]);
      const f = foldSheetUnfold(res, opts);
      expect(f.deviation.maxMm).toBeLessThan(0.05);
      closed(f);
    }
  });

  it('warns and clips holes entering a bend setback zone so folded mesh stays closed and manifold', () => {
    // Build a 40x40 mm base with a r=3 mm circular hole centered at (36, 20) (x in [33, 39])
    // plus a 90° valley flange at x=40 (R=2, T=2 -> setback = 2.0 mm, trimmed edge at x=38).
    const contour = [
      new THREE.Vector2(0, 0),
      new THREE.Vector2(40, 0),
      new THREE.Vector2(40, 40),
      new THREE.Vector2(0, 40),
    ];
    const hole = Array.from({ length: 16 }, (_, k) => {
      const a = -(k / 16) * Math.PI * 2;
      return new THREE.Vector2(36 + 3 * Math.cos(a), 20 + 3 * Math.sin(a));
    });
    const tris2D = THREE.ShapeUtils.triangulateShape(contour, [hole]);
    const all2D = [...contour, ...hole];
    const vertsM: number[] = [
      ...all2D.flatMap((p) => [p.x / 1000, p.y / 1000, 0]),
      0.04, 0, 0.025, 0.04, 0.04, 0.025,
    ];
    const f0 = all2D.length;
    const f1 = all2D.length + 1;
    const baseTris = tris2D.flatMap(([a, b, c]) => [a, b, c]);
    // Flange at x=0.04: base traverses 1->2 ((40,0,0)->(40,40,0)), so valley flange (+Z, normal -X) traverses 2->1->f0->f1
    const flangeTris = [2, 1, f0, 2, f0, f1];
    const s = scene({
      id: 'hole_bend',
      name: 'HoleInBendZone',
      pos: [0, 0, 0],
      geoms: [{ name: 'm', type: 'mesh', size: [0.02, 0.02, 0.0125], renderVertices: vertsM, faces: [...baseTris, ...flangeTris] }],
      joints: [],
      children: [],
    } as SceneNode);

    const opts = { mode: 'sheet_metal' as const, thicknessMm: 2, bendRadiusMm: 2, kFactor: 0.44 };
    const res = exportSheetUnfold(s, opts);
    expect(res.success).toBe(true);
    expect(res.warnings.some((w) => /enters .* bend setback zone/i.test(w))).toBe(true);

    const f = foldSheetUnfold(res, opts);
    closed(f);
    expect(f.deviation.maxMm).toBeLessThan(0.05);
  });
});
