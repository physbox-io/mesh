import { describe, it, expect } from 'vitest';
import { loadManifold } from '../src/utils/sculptCut';
import { buildPourBox } from '../src/utils/siliconeMold';
import { linerPullChoice } from '../src/utils/moldRoofScore';
import { hardwarePartNode } from '../src/utils/hardwareParts';
import {
  breakdownPipeFrame,
  buildAllCustomHubNodes,
  buildPipeHubNode,
  makeStrutNode,
} from '../src/utils/tubeAndWireExporter';
import { fillBodyDefaults } from '../src/hooks/mcp/bodyDefaults';
import type { SceneGraph } from '../src/types/scene';

/** Build a closed triangle soup for an axis-aligned box [x0..x1, y0..y1, z0..z1] in mm. */
function boxSoupMm(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): number[] {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ];
  const f = [
    [0, 2, 1], [0, 3, 2], // bottom
    [4, 5, 6], [4, 6, 7], // top
    [0, 1, 5], [0, 5, 4], // -Y
    [2, 3, 7], [2, 7, 6], // +Y
    [0, 4, 7], [0, 7, 3], // -X
    [1, 2, 6], [1, 6, 5], // +X
  ];
  const out: number[] = [];
  for (const [a, b, c] of f) out.push(...v[a], ...v[b], ...v[c]);
  return out;
}

/** Build a closed octahedron standing on a single point at z=0 (tiny base contact, like a rounded figurine). */
function pointedMasterSoupMm(rx: number, ry: number, height: number): number[] {
  const midZ = height / 2;
  const v = [
    [0, 0, 0], // bottom point
    [rx, 0, midZ], [0, ry, midZ], [-rx, 0, midZ], [0, -ry, midZ],
    [0, 0, height], // top point
  ];
  const f = [
    [0, 2, 1], [0, 3, 2], [0, 4, 3], [0, 1, 4],
    [5, 1, 2], [5, 2, 3], [5, 3, 4], [5, 4, 1],
  ];
  const out: number[] = [];
  for (const [a, b, c] of f) out.push(...v[a], ...v[b], ...v[c]);
  return out;
}

describe('Dogfooding Wave 1 & Wave 2 regression tests', () => {
  it('siliconeMold adds a tapered breakaway anchor post when master base contact is < 35 mm²', async () => {
    const wasm = await loadManifold();
    const soup = pointedMasterSoupMm(20, 14, 32);
    const res = buildPourBox(wasm, soup, { shape: 'fit', silicone: 'platinum', splitSleeve: true, hole: 'pour' });
    expect(res.report.warnings.some((w) => w.includes('breakaway anchor post'))).toBe(true);
    // The anchor post rises 1 mm above zMin = 0, so base mesh max Z > 0.5 mm
    let maxBaseZ = -Infinity;
    for (let i = 2; i < res.base.positions.length; i += 3) {
      maxBaseZ = Math.max(maxBaseZ, res.base.positions[i]);
    }
    expect(maxBaseZ).toBeGreaterThan(0.5);
  });

  it('siliconeMold does NOT add a breakaway anchor post on a flat-bottomed master', async () => {
    const wasm = await loadManifold();
    const soup = boxSoupMm(-25, 25, -25, 25, 0, 12); // 2500 mm² flat base
    const res = buildPourBox(wasm, soup, { shape: 'fit', silicone: 'platinum', splitSleeve: true });
    expect(res.report.warnings.some((w) => w.includes('breakaway anchor post'))).toBe(false);
  });

  it('siliconeMold warns when epoxy pour hole is narrower than 6 mm (surface tension risk)', async () => {
    const wasm = await loadManifold();
    const soup = boxSoupMm(-20, 20, -20, 20, 0, 25);
    const res = buildPourBox(wasm, soup, { shape: 'fit', hole: 'pour', holeDiaMm: 4 });
    expect(res.report.warnings.some((w) => w.includes('below the 6 mm minimum'))).toBe(true);
  });

  it('linerPullChoice avoids end-on +x pull on a slender 100 x 25 x 25 mm stepped figurine', () => {
    // 100 mm along X, 25 mm along Y & Z, with a slight overhang in Z
    const body = boxSoupMm(-50, 50, -12, 12, 0, 12);
    const head = boxSoupMm(25, 50, -14, 14, 10, 28);
    const soup = [...body, ...head];
    const choice = linerPullChoice(soup, '+z');
    expect(choice).not.toBe('+x');
  });

  it('hardwarePartNode(spring) marks every coil wire mesh dynamic: true so coils render at spring pos', () => {
    const spring = hardwarePartNode(
      { kind: 'spring', size: 'Ø10×30' },
      'test_spring',
    );
    const coils = spring.children.filter((c) => c.hardwarePart?.piece === 'coil');
    expect(coils.length).toBeGreaterThanOrEqual(3);
    for (const c of coils) {
      expect(c.geoms[0].dynamic).toBe(true);
    }
  });

  it('makeStrutNode centers pos at midpoint and buildAllCustomHubNodes supports includeStandard', () => {
    const s1 = makeStrutNode('s1', 'Post', [600, 0, 0], [600, 0, 1000], 16.7);
    const s2 = makeStrutNode('s2', 'Rail', [600, 0, 1000], [600, 500, 1000], 16.7);
    const s3 = makeStrutNode('s3', 'Rafter', [600, 0, 1000], [300, 0, 1300], 16.7);
    expect(s1.pos[0]).toBeCloseTo(0.6, 5);
    expect(s1.pos[2]).toBeCloseTo(0.5, 5);

    const scene: SceneGraph = { nodes: [s1, s2, s3] };
    const bd = breakdownPipeFrame(scene, { pipeStandardId: 'pvc_sch40_1' });
    const hub = buildPipeHubNode(bd.hubs.find((h) => h.ports.length >= 2)!, bd.options);
    expect(hub.collision).toBe('hull');

    const allHubs = buildAllCustomHubNodes(bd, true);
    expect(allHubs.length).toBe(bd.hubs.filter((h) => h.ports.length >= 2).length);
  });

  it('fillBodyDefaults wires declarative flexure specs via applyFlexureToNode', () => {
    const opsMap = new Map();
    const node = fillBodyDefaults(
      {
        id: 'flex_btn',
        name: 'Flexure Button',
        pos: [0, 0, 0.04],
        joints: [{ name: 'flex_slide', type: 'slide', axis: [0, 0, 1], limited: true, range: [-0.01, 0.01] }],
        geoms: [{ name: 'cap', type: 'box', size: [0.01, 0.01, 0.004] }],
        flexure: { kind: 'serpentine', filament: 'petg', thicknessMm: 1.2, lengthMm: 20, widthMm: 8, folds: 3 },
      },
      false,
      opsMap,
    );
    expect(node.flexure?.kind).toBe('serpentine');
    expect(node.geoms.some((g) => g.name.startsWith('flexure_'))).toBe(true);
  });
});
