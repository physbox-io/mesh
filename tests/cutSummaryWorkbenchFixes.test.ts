import { describe, it, expect, beforeEach } from 'vitest';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { useStore } from '../src/store/useStore';
import { exportLaserCutSvg, DEFAULT_LASER_OPTIONS } from '../src/utils/laserCutExporter';
import { summarizeNode } from '../src/utils/sceneSummary';
import { buildWorkbenchGeometries } from '../src/utils/backgroundScenery';
import type { SceneGeom, SceneGraph, SceneNode } from '../src/types/scene';

const boxNode = (
  id: string,
  pos: [number, number, number],
  half: [number, number, number],
  children: SceneNode[] = [],
): SceneNode => ({
  id,
  name: id,
  type: 'body',
  pos,
  joints: [],
  children,
  geoms: [{ name: `${id}_g`, type: 'box', size: half }],
});

function runExportCut(scene: SceneGraph, msg: Record<string, unknown>) {
  const store = { ...useStore.getState(), sceneGraph: scene };
  return cutCommands.EXPORT_CUT(msg, { store, toId: (v: unknown) => v } as never) as Promise<Record<string, unknown>>;
}

describe('Issue 1: EXPORT_CUT prevents parent-subtree leakage on explicit masterId', () => {
  beforeEach(() => {
    useStore.getState().setStock({ widthMm: 900, depthMm: 600, thicknessMm: 19 });
  });

  const lidWithHardware: SceneGraph = {
    nodes: [
      boxNode('lid_panel', [0, 0, 0.45], [0.35, 0.22, 0.0095], [
        boxNode('strap_hinge_left', [-0.22, 0.18, 0.011], [0.018, 0.09, 0.0015]),
        boxNode('strap_hinge_right', [0.22, 0.18, 0.011], [0.018, 0.09, 0.0015]),
        boxNode('brass_hasp', [0, -0.22, 0.005], [0.025, 0.0015, 0.04]),
      ]),
    ],
  };

  it('excludes unrequested child hardware bodies when masterId names lid_panel', async () => {
    const res = await runExportCut(lidWithHardware, {
      kind: 'panels',
      masterId: 'lid_panel',
      machine: 'cnc',
    });
    expect(res.ok).toBe(true);
    expect((res.cut as { ids: string[] }).ids).toEqual(['lid_panel']);
    expect((res.summary as { panels: number }).panels).toBe(1);
    const warnings = (res.warnings as string[]) ?? [];
    expect(warnings.some((w) => /3\.0 mm|thicker stock/i.test(w))).toBe(false);
  });

  it('includes an explicitly listed child body while still excluding unlisted siblings', async () => {
    const res = await runExportCut(lidWithHardware, {
      kind: 'panels',
      masterId: 'lid_panel,strap_hinge_left',
      machine: 'cnc',
    });
    expect(res.ok).toBe(true);
    expect((res.cut as { ids: string[] }).ids).toEqual(['lid_panel', 'strap_hinge_left']);
    expect((res.summary as { panels: number }).panels).toBe(2);
  });

  it('includes full subtree when includeChildren is explicitly true', async () => {
    const res = await runExportCut(lidWithHardware, {
      kind: 'panels',
      masterId: 'lid_panel',
      includeChildren: true,
      machine: 'cnc',
    });
    expect(res.ok).toBe(true);
    expect((res.summary as { panels: number }).panels).toBe(4);
  });

  it('still walks children for an empty container/assembly body when includeChildren is omitted', async () => {
    const assembly: SceneGraph = {
      nodes: [
        {
          id: 'chest_assembly',
          name: 'chest_assembly',
          type: 'body',
          pos: [0, 0, 0],
          joints: [],
          geoms: [],
          children: [
            boxNode('top_board', [0, 0, 0.0095], [0.2, 0.15, 0.0095]),
          ],
        },
      ],
    };
    const res = await runExportCut(assembly, {
      kind: 'panels',
      masterId: 'chest_assembly',
      machine: 'cnc',
    });
    expect(res.ok).toBe(true);
    expect((res.summary as { panels: number }).panels).toBe(1);
  });

  it('rejects non-boolean includeChildren', async () => {
    const res = await runExportCut(lidWithHardware, {
      kind: 'panels',
      masterId: 'lid_panel',
      includeChildren: 'yes',
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/includeChildren must be a boolean/i);
  });
});

describe('Issue 2: edge-to-edge butt joints across separate sibling bodies', () => {
  const makePlinthScene = (heightM: number, thicknessM = 0.019): SceneGraph => {
    const w = 0.6;
    const d = 0.4;
    const t = thicknessM;
    const hz = heightM / 2;
    const innerD = d - 2 * t;
    return {
      nodes: [
        boxNode('plinth_front', [0, -d / 2 + t / 2, hz], [w / 2, t / 2, hz]),
        boxNode('plinth_back', [0, d / 2 - t / 2, hz], [w / 2, t / 2, hz]),
        boxNode('plinth_left', [-w / 2 + t / 2, 0, hz], [t / 2, innerD / 2, hz]),
        boxNode('plinth_right', [w / 2 - t / 2, 0, hz], [t / 2, innerD / 2, hz]),
      ],
    };
  };

  it('cuts finger joints for 50 mm tall 19 mm sibling plinth walls touching edge-to-edge', () => {
    const scene = makePlinthScene(0.05, 0.019);
    const res = exportLaserCutSvg(scene, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'finger',
      materialThickness: 0.019,
      sheetWidth: 1.2,
      sheetHeight: 0.8,
      cornerRelief: 'dogbone',
    });
    expect(res.success).toBe(true);
    expect(res.panels).toHaveLength(4);
    const warnings = res.warnings ?? [];
    expect(warnings.some((w) => /No joints were cut/i.test(w))).toBe(false);
    for (const p of res.panels!) {
      // Plain rectangle has 4 vertices; finger-jointed ends add teeth (> 4 vertices).
      expect(p.outerPolygon2D.length).toBeGreaterThan(4);
    }
  });

  it('detects sibling edge-to-edge butt joints even when stock is slightly thinner than modelled (18 mm on 19 mm)', () => {
    const scene = makePlinthScene(0.05, 0.019);
    const res = exportLaserCutSvg(scene, {
      ...DEFAULT_LASER_OPTIONS,
      jointMode: 'finger',
      materialThickness: 0.018,
      allowThinnerStock: true,
      sheetWidth: 1.2,
      sheetHeight: 0.8,
    });
    expect(res.success).toBe(true);
    expect(res.panels).toHaveLength(4);
    const warnings = res.warnings ?? [];
    expect(warnings.some((w) => /No joints were cut/i.test(w))).toBe(false);
  });
});

describe('Issue 3: sceneSummary exactColliders.sockets reports logical socket count', () => {
  function makeBoreSocketGeoms(boreCount: number, group: number): SceneGeom[] {
    const out: SceneGeom[] = [];
    let idx = 0;
    for (let b = 0; b < boreCount; b++) {
      // 16 wall boxes (identical size) + 1 square cap box (matching wall thickness in z).
      for (let k = 0; k < 16; k++) {
        out.push({
          name: `sec_f${idx++}`,
          type: 'box',
          role: 'collision',
          contactClass: 'socket',
          contactGroup: group,
          size: [0.0005, 0.0008, 0.005],
          pos: [b * 0.02, 0, 0],
        });
      }
      out.push({
        name: `sec_f${idx++}`,
        type: 'box',
        role: 'collision',
        contactClass: 'socket',
        contactGroup: group,
        size: [0.004, 0.004, 0.0005],
        pos: [b * 0.02, 0, -0.0055],
      });
    }
    // Add surrounding face slabs (like printSplit's faceSlabs) to bring total to 220 for 9 bores.
    const slabCount = boreCount === 9 ? 67 : 4;
    for (let s = 0; s < slabCount; s++) {
      out.push({
        name: `sec_f${idx++}`,
        type: 'box',
        role: 'collision',
        contactClass: 'socket',
        contactGroup: group,
        size: [0.01 + s * 0.0001, 0.015, 0.0005],
        pos: [0, s * 0.01, 0],
      });
    }
    return out;
  }

  it('reports logical socket count (9) alongside socketGeoms (220) for decomposed printSplit bores', () => {
    const node: SceneNode = {
      id: 'section_1',
      name: 'section_1',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [
        { name: 'section_1_body', type: 'box', size: [0.1, 0.1, 0.05] },
        ...makeBoreSocketGeoms(9, 0),
      ],
    };
    const summary = summarizeNode(node, { model: null });
    expect(summary.exactColliders).toEqual({
      pins: 0,
      sockets: 9,
      socketGeoms: 220,
    });
  });

  it('keeps simple standalone socket geoms backwards-compatible without redundant socketGeoms', () => {
    const node: SceneNode = {
      id: 'simple_part',
      name: 'simple_part',
      type: 'body',
      pos: [0, 0, 0],
      joints: [],
      children: [],
      geoms: [
        { name: 'pin_0', type: 'cylinder', role: 'collision', contactClass: 'pin', size: [0.003, 0.005] },
        { name: 'sock_0', type: 'box', role: 'collision', contactClass: 'socket', size: [0.004, 0.004, 0.005] },
        { name: 'sock_1', type: 'box', role: 'collision', contactClass: 'socket', size: [0.004, 0.004, 0.005] },
      ],
    };
    const summary = summarizeNode(node, { model: null });
    expect(summary.exactColliders).toEqual({
      pins: 1,
      sockets: 2,
    });
  });
});

describe('Issue 4: workbench pegboard back-face culling and tall-furniture shelf clearance', () => {
  it('makes pegboard, pegboard backing, and rear shop wall single-sided (+Z) so rear cameras look through', () => {
    const geos = buildWorkbenchGeometries();

    // Pegboard itself: every vertex normal points +Z.
    const pegNorm = geos.pegboard.attributes.normal;
    for (let i = 0; i < pegNorm.count; i++) {
      expect(pegNorm.getZ(i)).toBeGreaterThan(0.99);
    }

    // In matteProps, vertices of the pegboard backing plane (z = -0.45, x = ±0.8)
    // and rear shop wall plane (z = -1.29) must only face +Z (no -Z back faces).
    const pos = geos.matteProps.attributes.position;
    const norm = geos.matteProps.attributes.normal;
    let checkedBackingVerts = 0;
    let checkedRearWallVerts = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const nz = norm.getZ(i);
      if (Math.abs(z - (-0.45)) < 0.001 && Math.abs(Math.abs(x) - 0.8) < 0.001 && y >= -0.001) {
        checkedBackingVerts++;
        expect(nz).toBeGreaterThan(0.99);
      }
      if (Math.abs(z - (-1.29)) < 0.001) {
        checkedRearWallVerts++;
        expect(nz).toBeGreaterThan(0.99);
      }
    }
    expect(checkedBackingVerts).toBe(4);
    expect(checkedRearWallVerts).toBe(4);

    // Default upper shelf clears > 1.0 m tall furniture (no clipping at 600-950 mm).
    const oakPos = geos.oakWood.attributes.position;
    let shelfMinY = Infinity;
    for (let i = 0; i < oakPos.count; i++) {
      const y = oakPos.getY(i);
      if (y > 0.05) shelfMinY = Math.min(shelfMinY, y);
    }
    expect(shelfMinY).toBeGreaterThan(1.0);

    geos.oakWood.dispose();
    geos.cuttingMat.dispose();
    geos.pegboard.dispose();
    geos.matteProps.dispose();
    geos.metalProps.dispose();
  });

  it('hides the upper shelf when sceneHeightM > 0.55 m', () => {
    const geos = buildWorkbenchGeometries({ sceneHeightM: 0.75 });
    geos.oakWood.computeBoundingBox();
    // Only the butcher-block top (top at Y = 0) remains in oakWood.
    expect(geos.oakWood.boundingBox!.max.y).toBeLessThanOrEqual(0.001);

    geos.oakWood.dispose();
    geos.cuttingMat.dispose();
    geos.pegboard.dispose();
    geos.matteProps.dispose();
    geos.metalProps.dispose();
  });
});
