import { describe, expect, it } from 'vitest';
import type { SceneGraph, SceneNode } from '../src/types/scene';
import {
  PIPE_STANDARDS,
  breakdownPipeFrame,
  buildPipeHubNode,
  generatePipeStructurePreset,
  type PipeFrameHub,
} from '../src/utils/tubeAndWireExporter';
import { buildPipeSkeleton, frameBodyInScene } from '../src/utils/pipeSkeleton';
import { layBricks } from '../src/utils/brickwork';
import { layToyBricks } from '../src/utils/toyBricks';
import { loadManifold } from '../src/utils/sculptCut';
import { decomposeSolidIntoPlanks } from '../src/utils/timberBreakdown';
import { synthesizeTimberJoinery } from '../src/utils/timberJoinery';
import { buildTimberCutPlan } from '../src/utils/timberCutList';

const MM = 1000;

function manifoldMmToSoupMetres(m: import('manifold-3d').Manifold): Float64Array {
  const mesh = m.getMesh();
  const p = mesh.numProp;
  const soup = new Float64Array(mesh.numTri * 9);
  for (let t = 0; t < mesh.numTri; t++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.triVerts[t * 3 + k];
      soup[t * 9 + k * 3] = mesh.vertProperties[v * p] / MM;
      soup[t * 9 + k * 3 + 1] = mesh.vertProperties[v * p + 1] / MM;
      soup[t * 9 + k * 3 + 2] = mesh.vertProperties[v * p + 2] / MM;
    }
  }
  return soup;
}

describe('Section 4A audit fixes (Timber, Brickwork & Pipe/Tube)', () => {
  it('Finding 1: frameBodyInScene forwards hubFitStyle, hubWallMm, fitClearanceMm, and crossBoltHoleMm to fittings', () => {
    const boxScene: SceneGraph = {
      nodes: [
        {
          id: 'box_1',
          name: 'Box',
          type: 'body',
          pos: [0, 0, 0.3],
          geoms: [{ name: 'b', type: 'box', size: [0.3, 0.3, 0.3], pos: [0, 0, 0] }],
          joints: [],
          children: [],
        },
      ],
    };

    const spigotFramed = frameBodyInScene(boxScene, 'box_1', {
      pipeStandardId: 'pvc_sch40_3_4',
      hubFitStyle: 'spigot',
      fitClearanceMm: 0.4,
      placement: 'replace',
    });
    const spigotHubs = spigotFramed.nodes.filter((n) => (n.geoms ?? []).some((g) => g.name === 'hub_core'));
    expect(spigotHubs.length).toBeGreaterThan(0);
    expect(spigotHubs[0].geoms.some((g) => g.name?.startsWith('spigot_plug_'))).toBe(true);

    const socketFramed = frameBodyInScene(boxScene, 'box_1', {
      pipeStandardId: 'pvc_sch40_3_4',
      hubFitStyle: 'socket',
      hubWallMm: 8,
      crossBoltHoleMm: 0,
      placement: 'replace',
    });
    const socketHubs = socketFramed.nodes.filter((n) => (n.geoms ?? []).some((g) => g.name === 'hub_core'));
    expect(socketHubs.length).toBeGreaterThan(0);
    expect(socketHubs[0].geoms.some((g) => g.name?.startsWith('cross_bolt_'))).toBe(false);
    const core = socketHubs[0].geoms.find((g) => g.name === 'hub_core');
    const expectedRadiusM = (PIPE_STANDARDS.pvc_sch40_3_4.odMm / 2 + 8) / 1000;
    expect(core?.size?.[0]).toBeCloseTo(expectedRadiusM, 5);
  });

  it('Finding 2: toy bricks fails fast on building-scale models before allocating course masks', () => {
    const buildingScene: SceneGraph = {
      nodes: [
        {
          id: 'bldg',
          name: 'Building',
          type: 'body',
          pos: [0, 0, 1.5],
          geoms: [{ name: 'mass', type: 'box', size: [3, 3, 1.5], pos: [0, 0, 0] }],
          joints: [],
          children: [],
        },
      ],
    };

    const t0 = Date.now();
    expect(() => layBricks(buildingScene, { standardId: 'toy' })).toThrow(/toy bricks/i);
    expect(Date.now() - t0).toBeLessThan(2000);

    // Direct layToyBricks grid-cell cap guard
    expect(() =>
      layToyBricks({
        lo: [0, 0],
        hi: [8000, 8000],
        courses: 100,
        zBase: 0,
        solidAt: () => () => true,
        inventory: { '2x4': null },
        maxBricks: 20_000,
      }),
    ).toThrow(/toy bricks/i);
  });

  it('Finding 3: brickwork on a tight curve keeps wedge bounded and terminates cleanly', () => {
    const tightCylinder: SceneGraph = {
      nodes: [
        {
          id: 'cyl',
          name: 'TightTower',
          type: 'body',
          pos: [0, 0, 0.3],
          geoms: [{ name: 'c', type: 'cylinder', size: [0.18, 0.3], pos: [0, 0, 0] }],
          joints: [],
          children: [],
        },
      ],
    };
    const res = layBricks(tightCylinder, { standardId: 'uk', bond: 'stretcher' });
    expect(res.bricks.length).toBeGreaterThan(0);
    for (const b of res.bricks) {
      expect(Number.isFinite(b.x)).toBe(true);
      expect(Number.isFinite(b.y)).toBe(true);
      expect(Number.isFinite(b.lengthMm)).toBe(true);
    }
  });

  it('Finding 4: oversized CNC bit caps tenon thickness, avoids negative shoulders, emits warning, and flags exceeds_cnc', async () => {
    const wasm = await loadManifold();
    // Two 45x45x400 legs at x = ±122.5, joined by a thin 12mm thick x 50mm tall x 200mm rail
    const legL = wasm.Manifold.cube([45, 45, 400], true).translate([-122.5, 0, 200]);
    const legR = wasm.Manifold.cube([45, 45, 400], true).translate([122.5, 0, 200]);
    const rail = wasm.Manifold.cube([200, 12, 50], true).translate([0, 0, 320]);
    const soups = [legL, legR, rail].map(manifoldMmToSoupMetres);
    legL.delete();
    legR.delete();
    rail.delete();

    for (const jointMode of ['mortise_tenon', 'dado'] as const) {
      const res = synthesizeTimberJoinery(wasm, soups, {
        jointMode,
        cutterDiaMm: 16,
        shoulderMm: 4,
        tenonLengthMm: 20,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) continue;

      const tenons = res.parts.flatMap((p) => p.tenons);
      expect(tenons.length).toBeGreaterThan(0);
      for (const t of tenons) {
        expect(t.thicknessMm).toBeLessThanOrEqual(10); // <= thkA (12) - 2
        expect(t.shoulderCheekMm).toBeGreaterThanOrEqual(0);
        expect(t.shoulderTopBotMm).toBeGreaterThanOrEqual(0);
      }
      expect(res.warnings.some((w) => /CNC bit Ø16 mm is wider/i.test(w))).toBe(true);

      const cutPlan = buildTimberCutPlan(res, { cncBedMm: [300, 400, 80] });
      const hostIds = new Set(res.parts.filter((p) => p.mortises.length > 0).map((p) => p.member.id));
      const hostCards = cutPlan.partCards.filter((c) => hostIds.has(c.partId));
      expect(hostCards.length).toBeGreaterThan(0);
      for (const hc of hostCards) {
        expect(hc.cncAttachment).toBe('exceeds_cnc');
        expect(hc.cncFitNote).toMatch(/wider than pocket/i);
      }
    }
  });

  it('Finding 6: breakdownPipeFrame clamps stockLengthMm <= 0 or NaN instead of infinite-looping', () => {
    const ghNodes = generatePipeStructurePreset('mini_greenhouse');
    const scene: SceneGraph = { nodes: ghNodes };

    for (const badStock of [0, -500, Number.NaN]) {
      const bd = breakdownPipeFrame(scene, { stockLengthMm: badStock });
      expect(bd.shoppingList.stockLengthMm).toBeGreaterThanOrEqual(50);
      expect(bd.sticks.length).toBeGreaterThan(0);
    }
  });

  it('Finding 8: spigot hub falls back to socket on solid rods (idMm === 0) and uses 0.5mm plug floor on alu_6', () => {
    const hub: PipeFrameHub = {
      id: 'hub_test',
      name: 'Test Hub',
      centerMm: [0, 0, 0],
      ports: [
        { strutId: 's1', dir: [1, 0, 0], shoulderOffsetMm: 8 },
        { strutId: 's2', dir: [0, 1, 0], shoulderOffsetMm: 8 },
      ],
      minAngleDeg: 90,
      classification: '90_elbow',
      needsCustomPrint: true,
    };

    const rodNode = buildPipeHubNode(hub, { pipeStandardId: 'dowel_8', hubFitStyle: 'spigot' });
    expect(rodNode.geoms.some((g) => g.name?.startsWith('sleeve_'))).toBe(true);
    expect(rodNode.geoms.some((g) => g.name?.startsWith('socket_bore_'))).toBe(true);
    expect(rodNode.geoms.some((g) => g.name?.startsWith('spigot_plug_'))).toBe(false);

    const alu6Node = buildPipeHubNode(hub, {
      pipeStandardId: 'alu_6',
      hubFitStyle: 'spigot',
      fitClearanceMm: 0.25,
    });
    const plug = alu6Node.geoms.find((g) => g.name === 'spigot_plug_1');
    expect(plug).toBeDefined();
    // alu_6 idMm = 4.0 -> radius 2.0 - 0.25 = 1.75 mm = 0.00175 m
    expect(plug!.size![0]).toBeCloseTo(0.00175, 6);
  });

  it('Finding 9: extractRawStrutsFromScene applies geom euler/quat and does not double-apply g.pos on fromto', () => {
    const rotatedCyl: SceneNode = {
      id: 'rot_cyl',
      name: 'Rotated Cylinder',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        {
          name: 'horiz',
          type: 'cylinder',
          size: [0.015, 0.5],
          pos: [0, 0, 1],
          euler: [0, 90, 0], // rotates local Z onto +X
        },
      ],
      joints: [],
      children: [],
    };
    const bdRot = breakdownPipeFrame({ nodes: [rotatedCyl] });
    expect(bdRot.struts).toHaveLength(1);
    const sRot = bdRot.struts[0];
    // Should run horizontally from (-500, 0, 1000) to (500, 0, 1000)
    expect(Math.abs(sRot.endMm[0] - sRot.startMm[0])).toBeCloseTo(1000, 1);
    expect(Math.abs(sRot.endMm[2] - sRot.startMm[2])).toBeCloseTo(0, 1);
    expect(sRot.startMm[2]).toBeCloseTo(1000, 1);

    const fromtoWithPos: SceneNode = {
      id: 'ft_cyl',
      name: 'Fromto Cylinder',
      type: 'body',
      pos: [0, 0, 0],
      geoms: [
        {
          name: 'ft',
          type: 'cylinder',
          size: [0.015, 0.5],
          pos: [0.5, 0.5, 0.5], // must be ignored when fromto is present
          fromto: [0, 0, 0, 1, 0, 0],
        },
      ],
      joints: [],
      children: [],
    };
    const bdFt = breakdownPipeFrame({ nodes: [fromtoWithPos] });
    expect(bdFt.struts).toHaveLength(1);
    expect(bdFt.struts[0].startMm).toEqual([0, 0, 0]);
    expect(bdFt.struts[0].endMm).toEqual([1000, 0, 0]);
  });

  it('Finding 11: buildPipeSkeleton handles coincident leg ends under a panel without NaN or zero-length struts', () => {
    // Panel supported by two overlapping legs at the exact same XY centre
    const scene: SceneGraph = {
      nodes: [
        {
          id: 'pedestal',
          name: 'Pedestal',
          type: 'body',
          pos: [0, 0, 0],
          geoms: [
            { name: 'leg1', type: 'box', size: [0.02, 0.02, 0.3], pos: [0, 0, 0.3] },
            { name: 'leg2', type: 'box', size: [0.02, 0.02, 0.3], pos: [0.0002, 0, 0.3] },
            { name: 'top', type: 'box', size: [0.25, 0.25, 0.015], pos: [0, 0, 0.615] },
          ],
          joints: [],
          children: [],
        },
      ],
    };
    const sk = buildPipeSkeleton(scene, 'pedestal', { style: 'centrelines', pipeStandardId: 'pvc_sch40_1_2' });
    expect(sk.members.length).toBeGreaterThan(0);
    for (const p of sk.nodes) {
      expect(Number.isFinite(p[0])).toBe(true);
      expect(Number.isFinite(p[1])).toBe(true);
      expect(Number.isFinite(p[2])).toBe(true);
    }
    for (const m of sk.members) {
      const a = sk.nodes[m.a];
      const b = sk.nodes[m.b];
      const dist = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      expect(dist).toBeGreaterThan(1e-3);
    }
  });

  it('Finding 13: buildTimberCutPlan flags exceeds_cnc when a single mortise/dado Y-span exceeds cncBedMm[1]', async () => {
    const wasm = await loadManifold();
    // 90mm tall x 240mm long apron rail into 45x45x500 legs; CNC bed Y travel is only 60mm
    const legL = wasm.Manifold.cube([45, 45, 500], true).translate([-142.5, 0, 250]);
    const legR = wasm.Manifold.cube([45, 45, 500], true).translate([142.5, 0, 250]);
    const wideRail = wasm.Manifold.cube([240, 22, 90], true).translate([0, 0, 250]);
    const soups = [legL, legR, wideRail].map(manifoldMmToSoupMetres);
    legL.delete();
    legR.delete();
    wideRail.delete();

    const res = synthesizeTimberJoinery(wasm, soups, {
      jointMode: 'mortise_tenon',
      cutterDiaMm: 6,
      shoulderMm: 5,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const cutPlan = buildTimberCutPlan(res, { cncBedMm: [300, 60, 80] });
    const hostIds = new Set(res.parts.filter((p) => p.mortises.length > 0).map((p) => p.member.id));
    const legCards = cutPlan.partCards.filter((c) => hostIds.has(c.partId));
    expect(legCards.length).toBeGreaterThan(0);
    for (const leg of legCards) {
      expect(leg.cncAttachment).toBe('exceeds_cnc');
      expect(leg.cncFitNote).toMatch(/Y-span/i);
    }
  });

  it('Finding 14: decomposeSolidIntoPlanks omits alignment dowels in BOM when jointType is glue', async () => {
    const wasm = await loadManifold();
    const box = wasm.Manifold.cube([200, 150, 120], true).translate([0, 0, 60]);
    const soup = manifoldMmToSoupMetres(box);
    box.delete();

    const res = decomposeSolidIntoPlanks(wasm, [soup], {
      jointType: 'glue',
      dowelDiaMm: 8,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.bomMarkdown).toContain('- **Alignment Dowels:** None');
  });
});
