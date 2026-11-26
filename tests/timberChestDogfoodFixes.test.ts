import { describe, expect, it, vi } from 'vitest';
import { loadManifold } from '../src/utils/sculptCut';
import {
  collectIndividualPartSoups,
  decomposeSolidIntoPlanks,
} from '../src/utils/timberBreakdown';
import { synthesizeTimberJoinery } from '../src/utils/timberJoinery';
import { buildTimberCutPlan } from '../src/utils/timberCutList';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const MM = 1000;

function makeBoxNode(
  id: string,
  name: string,
  centerMm: [number, number, number],
  fullSizeMm: [number, number, number],
  opts: {
    density?: number;
    deformMaterial?: string;
    children?: SceneNode[];
  } = {},
): SceneNode {
  return {
    id,
    name,
    pos: [centerMm[0] / MM, centerMm[1] / MM, centerMm[2] / MM],
    density: opts.density,
    deformMaterial: opts.deformMaterial,
    geoms: [
      {
        name,
        type: 'box',
        size: [fullSizeMm[0] / (2 * MM), fullSizeMm[1] / (2 * MM), fullSizeMm[2] / (2 * MM)],
      },
    ],
    joints: [],
    children: opts.children ?? [],
  };
}

/**
 * Build a 15-board storage chest scene with a 6 mm overhanging lid, a 45 mm
 * recessed plinth, interior cleats, and lid battens.
 */
function build15BoardStorageChestScene(includeMetalHardware = false): {
  scene: SceneGraph;
  woodIds: string[];
  hardwareIds: string[];
} {
  // Coordinates relative to world (all panels 19 mm thick):
  // Plinth: z in [0, 45] (recessed 30 mm inward from 800x400 carcase -> 740x340 outer)
  // Bottom panel: sits on plinth at z in [45, 64] -> 762 x 362 x 19
  // Carcase walls: z in [45, 395] (height 350 mm), outer X in [-400, 400], outer Y in [-200, 200]
  // Lid: sits on top at z in [395, 414] with 6 mm overhang -> 812 x 412 x 19
  const woodChildren: SceneNode[] = [
    makeBoxNode('front_panel', 'front_panel', [0, -190.5, 220], [800, 19, 350], { density: 650 }),
    makeBoxNode('back_panel', 'back_panel', [0, 190.5, 220], [800, 19, 350], { density: 650 }),
    makeBoxNode('left_panel', 'left_panel', [-390.5, 0, 220], [19, 362, 350], { density: 650 }),
    makeBoxNode('right_panel', 'right_panel', [390.5, 0, 220], [19, 362, 350], { density: 650 }),
    makeBoxNode('lid_panel', 'lid_panel', [0, 0, 404.5], [812, 412, 19], { density: 650 }),
    // 4 recessed plinth rails (45 mm tall, recessed 30 mm inward)
    makeBoxNode('plinth_front', 'plinth_front', [0, -160.5, 22.5], [740, 19, 45], { density: 650 }),
    makeBoxNode('plinth_back', 'plinth_back', [0, 160.5, 22.5], [740, 19, 45], { density: 650 }),
    makeBoxNode('plinth_left', 'plinth_left', [-360.5, 0, 22.5], [19, 302, 45], { density: 650 }),
    makeBoxNode('plinth_right', 'plinth_right', [360.5, 0, 22.5], [19, 302, 45], { density: 650 }),
    // 2 lid battens underneath lid
    makeBoxNode('lid_batten_left', 'lid_batten_left', [-280, 0, 385.5], [35, 340, 19], { density: 650 }),
    makeBoxNode('lid_batten_right', 'lid_batten_right', [280, 0, 385.5], [35, 340, 19], { density: 650 }),
    // 3 interior support cleats
    makeBoxNode('cleat_left', 'cleat_left', [-368.5, 0, 76.5], [25, 340, 19], { density: 650 }),
    makeBoxNode('cleat_right', 'cleat_right', [368.5, 0, 76.5], [25, 340, 19], { density: 650 }),
    makeBoxNode('cleat_center', 'cleat_center', [0, 0, 35.5], [30, 320, 19], { density: 650 }),
  ];

  const hardwareChildren: SceneNode[] = includeMetalHardware
    ? [
        makeBoxNode('steel_bracket_fl', 'steel_bracket_fl', [-375, -175, 380], [40, 3, 40], {
          density: 7850,
          deformMaterial: 'steel',
        }),
        makeBoxNode('steel_bracket_fr', 'steel_bracket_fr', [375, -175, 380], [40, 3, 40], {
          density: 7850,
          deformMaterial: 'steel',
        }),
        makeBoxNode('brass_hasp', 'brass_hasp', [0, -202, 390], [32, 3, 70], {
          density: 8500,
          deformMaterial: 'brass',
        }),
      ]
    : [];

  // Make bottom_panel the parent body (reproducing parent-subtree leakage scenario)
  const bottomPanel = makeBoxNode('bottom_panel', 'bottom_panel', [0, 0, 54.5], [762, 362, 19], {
    density: 650,
    children: [
      ...woodChildren.map((c) => ({
        ...c,
        pos: [c.pos[0], c.pos[1], c.pos[2] - 54.5 / MM],
      })),
      ...hardwareChildren.map((c) => ({
        ...c,
        pos: [c.pos[0], c.pos[1], c.pos[2] - 54.5 / MM],
      })),
    ],
  });

  return {
    scene: { nodes: [bottomPanel] },
    woodIds: ['bottom_panel', ...woodChildren.map((c) => c.id)],
    hardwareIds: hardwareChildren.map((c) => c.id),
  };
}

describe('Timber Breakdown dogfooding regression fixes', () => {
  it('1. preserves already-paneled 15-board storage chest with overhanging lid and recessed plinth in plank/auto mode without 0.9 mm slivers or volume loss', async () => {
    const wasm = await loadManifold();
    const { scene, woodIds } = build15BoardStorageChestScene(false);
    const { items } = collectIndividualPartSoups(scene, woodIds, { strictIds: true });
    expect(items.length).toBe(15);

    const res = decomposeSolidIntoPlanks(
      wasm,
      items.map((it) => it.soup),
      {
        boardThicknessMm: 19,
        wallThicknessMm: 19,
        maxBoardWidthMm: 200,
        jointType: 'rabbet',
        hollowInterior: true,
      },
      items.map((it) => it.hintName),
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // Must preserve all 15 boards (wide boards like lid/bottom/walls split cleanly into planks, so >= 15)
    expect(res.planks.length).toBeGreaterThanOrEqual(15);
    expect(res.hollowedVolumeMm3).toBe(0);
    // No >50% volume loss: must retain >92% of original board volume (only small dowel holes subtracted)
    expect(res.totalVolumeMm3 / res.originalVolumeMm3).toBeGreaterThan(0.92);
    // No 0.9 mm slivers: every plank must keep real board thickness (>= 15 mm for 19 mm stock)
    for (const p of res.planks) {
      expect(Math.min(...p.dimensionsMm)).toBeGreaterThanOrEqual(15);
    }
    // Bottom, plinth, cleats, and battens must all be present
    const ids = res.planks.map((p) => p.id.toLowerCase());
    expect(ids.some((id) => id.includes('bottom_panel'))).toBe(true);
    expect(ids.some((id) => id.includes('plinth_front'))).toBe(true);
    expect(ids.some((id) => id.includes('cleat_left'))).toBe(true);
    expect(ids.some((id) => id.includes('lid_batten_left'))).toBe(true);
    expect(res.bomMarkdown).toContain('Preserved Multi-Board Assembly');
  });

  it('2a. prevents parent-subtree leakage when explicit with_ids are passed to TIMBER_BREAKDOWN', async () => {
    if (typeof globalThis.navigator === 'undefined') {
      vi.stubGlobal('navigator', { hardwareConcurrency: 2 });
    }
    const { partBuildCommands } = await import('../src/hooks/mcp/partBuildCommands');
    const { scene, woodIds } = build15BoardStorageChestScene(true);

    // Add an unrequested wood child under bottom_panel as well
    scene.nodes[0].children.push(
      makeBoxNode('unrequested_tray', 'unrequested_tray', [0, 0, 0.12], [200, 150, 12], { density: 650 }),
    );

    // Explicitly pass bottom_panel + only the 4 walls (omitting metal hardware AND unrequested_tray)
    const explicitWood = ['front_panel', 'back_panel', 'left_panel', 'right_panel'];
    const { items, absorbed } = collectIndividualPartSoups(
      scene,
      ['bottom_panel', ...explicitWood],
      { strictIds: true },
    );

    expect(items.length).toBe(5);
    expect(absorbed.sort()).toEqual([...explicitWood].sort());
    expect(items.some((it) => it.hintName?.includes('steel') || it.hintName?.includes('brass'))).toBe(false);
    expect(items.some((it) => it.hintName === 'unrequested_tray')).toBe(false);

    // Also verify end-to-end through TIMBER_BREAKDOWN command with all 15 wood IDs
    const res = (await partBuildCommands.TIMBER_BREAKDOWN(
      {
        body_id: woodIds[0],
        with_ids: woodIds.slice(1),
        mode: 'auto',
        board_thickness_mm: 19,
      },
      {
        store: {
          sceneGraph: scene,
          selectedNodeId: null,
          cncBed: { widthMm: 300, depthMm: 300, heightMm: 60 },
        } as never,
      },
    )) as { ok: boolean; mode?: string; planks?: { id: string; dimensionsMm: number[] }[] };

    expect(res.ok).toBe(true);
    expect(res.mode).toBe('planks');
    expect(res.planks?.some((p) => p.id.toLowerCase().includes('steel') || p.id.toLowerCase().includes('brass'))).toBe(false);
    expect(res.planks?.some((p) => p.id.toLowerCase().includes('unrequested_tray'))).toBe(false);
    for (const p of res.planks ?? []) {
      expect(Math.min(...p.dimensionsMm)).toBeGreaterThanOrEqual(15);
    }
  });

  it('2b. filters metal-density (>1500 kg/m³) child hardware even when walking a single parent assembly root', () => {
    const { scene } = build15BoardStorageChestScene(true);
    const { items, absorbed } = collectIndividualPartSoups(scene, ['bottom_panel']);

    // 15 wood boards collected, 0 steel brackets or brass hasp
    expect(items.length).toBe(15);
    expect(absorbed).not.toContain('steel_bracket_fl');
    expect(absorbed).not.toContain('steel_bracket_fr');
    expect(absorbed).not.toContain('brass_hasp');
  });

  it('3. uses panel/casework labels and omits Tabletop Z-clips for an enclosed storage chest in frame mode', async () => {
    const wasm = await loadManifold();
    const { scene, woodIds } = build15BoardStorageChestScene(false);
    const { items } = collectIndividualPartSoups(scene, woodIds, { strictIds: true });

    const res = synthesizeTimberJoinery(
      wasm,
      items.map((it) => it.soup),
      {
        jointMode: 'dado',
        maxBoardWidthMm: 200,
        tabletopClips: true,
      },
      items.map((it) => it.hintName),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // No panel in a storage chest should be called "Tabletop" or "Tabletop Plank"
    for (const part of res.parts) {
      expect(part.member.title).not.toContain('Tabletop');
      expect(part.member.id).not.toContain('Tabletop');
      expect(part.member.id).not.toMatch(/^Top_Plank_/);
      expect(part.zClipSlots.length).toBe(0);
    }

    const cutPlan = buildTimberCutPlan(res, { cncBedMm: [300, 300, 60] });
    // No tabletop Z-Clip or Figure-8 expansion fasteners in hardware BOM for an enclosed chest
    expect(
      cutPlan.hardwareBom.some(
        (h) => h.item.includes('Z-Clip') || h.item.includes('Figure-8') || h.item.includes('Tabletop'),
      ),
    ).toBe(false);
    expect(cutPlan.buildGuideMarkdown).not.toContain('Tabletop Plank');
    expect(cutPlan.buildGuideMarkdown).not.toContain('Z-Clip');
  });
});
