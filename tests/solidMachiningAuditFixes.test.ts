import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  generateSolidMachining,
  deriveSolidOptions,
  tipSideContactOffsetMm,
} from '../src/utils/solidMachiningExporter';
import { simulateMilling } from '../src/utils/cutSimulation';
import { reliefSimulationTools, runSimulationJob, simulateStock } from '../src/utils/simulatedPart';
import { cutSetups } from '../src/utils/multiSetupMesh';
import { describeTurn, setupFrame } from '../src/utils/orient';
import { setupDiagramSvg } from '../src/utils/setupDiagram';
import { mergeConvexTiers } from '../src/utils/solidDecomposition';
import { solidify, isClosed } from '../src/utils/solidify';
import { createLattice, vertexAt, addFace, toPolyMesh } from '../src/utils/latticeMesh';
import { machineSurface } from '../src/utils/machineSurface';
import { DEFAULT_RELIEF_OPTIONS } from '../src/utils/reliefOptions';
import { gridFromPoints, interpolateGridZ } from '../src/utils/meshLeveler';
import { machiningOptionsFor } from '../src/hooks/mcp/exportOptions';
import { machiningCommands } from '../src/hooks/mcp/machiningCommands';
import type { Hull } from '../src/utils/csg';
import { convexHullOf } from '../src/utils/csg';
import type { SceneGraph, SceneGeom } from '../src/types/scene';

vi.mock('../src/utils/apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/utils/apiClient')>()),
  postMachineTelemetry: vi.fn().mockResolvedValue([]),
  fetchMachineDevices: vi.fn().mockResolvedValue([]),
}));

const { carveOptions, createMeshMachineHandlers, jobBounds, machineArming, setCurrentScene } = await import(
  '../src/utils/machineMcp'
);
const { webSerialManager } = await import('../src/utils/webSerialManager');

function body(geoms: Partial<SceneGeom>[]): SceneGraph {
  return {
    nodes: [
      {
        id: 'b1',
        name: 'part',
        type: 'body',
        pos: [0, 0, 0],
        geoms: geoms.map((g, i) => ({ name: `g${i}`, ...g })) as SceneGeom[],
        joints: [],
        children: [],
      },
    ],
  };
}

/** Closed axis-aligned box from [x0,y0,z0] to [x1,y1,z1] in mm (renderVertices Z-up, metres). */
function boxMeshMm(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Partial<SceneGeom> {
  const pts = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ].map(([x, y, z]) => [x / 1000, y / 1000, z / 1000]);
  const faces = [
    0, 2, 1, 0, 3, 2, // -z
    4, 5, 6, 4, 6, 7, // +z
    0, 1, 5, 0, 5, 4, // -y
    2, 3, 7, 2, 7, 6, // +y
    1, 2, 6, 1, 6, 5, // +x
    3, 0, 4, 3, 4, 7, // -x
  ];
  const renderVertices = pts.flat();
  const vertices = pts.flatMap(([x, y, z]) => [x, z, -y]);
  return { type: 'mesh', size: [1], renderVertices, vertices, faces };
}

describe('S-C1: 2-sided surfaceFor sub-midplane stepped flange', () => {
  it('machines all the way down to a sub-midplane flange instead of clamping at floorZ', () => {
    // 40 x 40 x 4 mm bottom flange (z = 0..4 mm) + 20 x 20 x 36 mm upper boss (z = 4..40 mm).
    // Total height = 40 mm -> stockT = 42 mm, midplane = -21 mm, flange top = -37 mm, bottom = -41 mm.
    const stepped = body([
      boxMeshMm(-20, -20, 0, 20, 20, 4),
      boxMeshMm(-10, -10, 0, 10, 10, 40),
    ]);
    const opts = deriveSolidOptions(stepped, {
      sides: 2,
      material: 'softwood',
      roughingToolDiaMm: 6,
      finishingToolDiaMm: 6,
      finishingToolType: 'flat',
      tabCount: 0,
      registrationPins: false,
      toolStickoutMm: 60,
    });
    const res = generateSolidMachining(stepped, opts);
    expect(res.success, res.error).toBe(true);

    const tools = reliefSimulationTools(opts);
    const stockSim = simulateStock({
      gcode: res.sides[0].gcode,
      gcodeB: res.sides[1].gcode,
      widthMm: res.stock.widthMm,
      depthMm: res.stock.depthMm,
      thicknessMm: res.stock.thicknessMm,
      ...tools,
    });
    // Check outer rim of the flange (x = cx + 18.5 mm, y = cy, within finishRad of the moat at x = cx + 20 mm):
    // Side A must machine down to ~ -37 mm, NOT stop at floorZ = -21.5 mm!
    const cx = res.stock.widthMm / 2;
    const cy = res.stock.depthMm / 2;
    const col = Math.floor((cx + 18.5) / stockSim.grid.cell);
    const row = Math.floor(cy / stockSim.grid.cell);
    const topAtRim = stockSim.grid.top[row * stockSim.grid.cols + col];
    expect(topAtRim).toBeLessThan(-36.2);
    expect(topAtRim).toBeGreaterThan(-37.8);

    const measured = runSimulationJob({
      gcode: res.sides[0].gcode,
      gcodeB: res.sides[1].gcode,
      widthMm: res.stock.widthMm,
      depthMm: res.stock.depthMm,
      thicknessMm: res.stock.thicknessMm,
      ...tools,
      cellMm: 0.5,
      maxTriangles: 120_000,
      measureRect: res.partBounds,
      measureMask: res.footprint,
    }).measuredVolumeMm3!;
    // Model volume = 40*40*4 + 20*20*36 = 20,800 mm^3 (plus r=3 inner boss-to-flange fillet).
    expect(measured / res.partVolumeMm3).toBeGreaterThan(0.97);
    expect(measured / res.partVolumeMm3).toBeLessThan(1.06);
  });
});

describe('S-C2: datum notch sizing, roughing stepdowns, finishingEnabled=false, and outer corner runOff', () => {
  const W = 100, D = 100, H = 18;
  function leaningTray(): SceneGraph {
    const run = 10 * Math.tan((15 * Math.PI) / 180);
    const prism = (profile: [number, number][]): Partial<SceneGeom> => {
      const v: number[] = [];
      for (const x of [0, W]) for (const [y, z] of profile) v.push(x / 1000, y / 1000, z / 1000);
      const n = profile.length;
      const faces: number[] = [];
      for (let i = 1; i < n - 1; i++) faces.push(0, i + 1, i, n, n + i, n + i + 1);
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        faces.push(i, j, n + j, i, n + j, n + i);
      }
      const yup: number[] = [];
      for (let i = 0; i < v.length; i += 3) yup.push(v[i], v[i + 2], -v[i + 1]);
      return { type: 'mesh', size: [1], renderVertices: v, vertices: yup, faces };
    };
    return body([
      prism([[0, 0], [D, 0], [D, 6], [0, 6]]),
      prism([[0, 6], [42, 6], [42 + run, H], [0, H]]),
      prism([[54, 6], [D, 6], [D, H], [54 + run, H]]),
    ]);
  }

  it('sizes the datum notch for the larger roughing cutter so roughing clears it before finishing', () => {
    const scene = leaningTray();
    const asked = {
      sides: 1 as const,
      material: 'softwood' as const,
      roughingToolDiaMm: 6.35,
      finishingToolDiaMm: 3,
      finishingToolType: 'flat' as const,
      toolStickoutMm: 80,
      stockWidthMm: 124,
      stockDepthMm: 124,
      stockThicknessMm: 22,
    };
    const r = generateSolidMachining(scene, { ...deriveSolidOptions(scene, asked), setups: 'auto' });
    expect(r.success, r.error).toBe(true);
    const first = r.setups![0];
    const top = r.setups!.find((s) => s.upFace === '+z')!;
    // Notch width >= 6.35 + 2 = 8.35 mm -> 8.4 mm
    const notchWall = top.datum!.touches.find((t) => t.axis === 'x')!.wallMm;
    expect(notchWall).toBeGreaterThanOrEqual(8.35);
    // Touch-off value matches the setup's first cutter (6.35 mm rougher -> radius 3.175 mm)
    const tx = top.datum!.touches.find((t) => t.axis === 'x')!;
    expect(tx.valueMm).toBeCloseTo(tx.wallMm - 6.35 / 2, 3);

    // Split first setup G-code at T2 M6 and confirm T1 roughing already cleared the notch!
    const m6Idx = first.gcode.indexOf('T2 M6');
    expect(m6Idx).toBeGreaterThan(0);
    const frame = setupFrame(first.upFace, r.stock);
    const roughOnly = simulateMilling(first.gcode.slice(0, m6Idx), {
      widthMm: frame.stock.widthMm,
      depthMm: frame.stock.depthMm,
      cellMm: 0.25,
      initialTool: 1,
      tools: { 1: { shape: 'flat', diameterMm: 6.35 }, 2: { shape: 'flat', diameterMm: 3 } },
    });
    const mid = frame.toSetup([0, notchWall / 2, -notchWall / 2]);
    expect(roughOnly.at(mid[0], mid[1])).toBeLessThan(-notchWall + 1.0);

    // Also confirm the outer corner (0.3, 0.3) inside the notch has no uncut fillet pillar
    const full = simulateMilling(first.gcode, {
      widthMm: frame.stock.widthMm,
      depthMm: frame.stock.depthMm,
      cellMm: 0.2,
      initialTool: 1,
      tools: { 1: { shape: 'flat', diameterMm: 6.35 }, 2: { shape: 'flat', diameterMm: 3 } },
    });
    const corner = frame.toSetup([0, 0.3, -0.3]);
    expect(full.at(corner[0], corner[1])).toBeLessThan(-notchWall + 0.5);
  });

  it('cuts the datum notch cleanly with the rougher when finishingEnabled is false', () => {
    const scene = leaningTray();
    const asked = {
      sides: 1 as const,
      material: 'softwood' as const,
      roughingEnabled: true,
      finishingEnabled: false,
      roughingToolDiaMm: 6,
      finishingToolDiaMm: 3,
      finishingToolType: 'flat' as const,
      toolStickoutMm: 80,
      stockWidthMm: 124,
      stockDepthMm: 124,
      stockThicknessMm: 22,
    };
    const r = generateSolidMachining(scene, { ...deriveSolidOptions(scene, asked), setups: 'auto' });
    expect(r.success, r.error).toBe(true);
    const first = r.setups![0];
    const top = r.setups!.find((s) => s.upFace === '+z')!;
    const tx = top.datum!.touches.find((t) => t.axis === 'x')!;
    expect(tx.wallMm).toBeCloseTo(8, 2);
    expect(tx.valueMm).toBeCloseTo(5, 3); // 8 - 6/2

    const frame = setupFrame(first.upFace, r.stock);
    const cut = simulateMilling(first.gcode, {
      widthMm: frame.stock.widthMm,
      depthMm: frame.stock.depthMm,
      cellMm: 0.25,
      initialTool: 1,
      tools: { 1: { shape: 'flat', diameterMm: 6 } },
    });
    const mid = frame.toSetup([0, 4, -4]);
    expect(cut.at(mid[0], mid[1])).toBeLessThan(-7.5);
  });
});

describe('S-C3: multi-setup tab protection and 4-side undercut tab retention', () => {
  it('protects holding tabs during side setups so tabs are not severed before -z runs', () => {
    // A 40 x 40 x 20 mm block with a blind pocket into its front (-y) face and a blind pocket on -z.
    const part = body([
      // Bottom slab z=4..8, top slab z=14..20, back wall y=12..40, left/right walls leaving a front (-y) slot
      boxMeshMm(0, 12, 0, 40, 40, 20),
      boxMeshMm(0, 0, 0, 40, 12, 6),
      boxMeshMm(0, 0, 14, 40, 12, 20),
    ]);
    const opts = deriveSolidOptions(part, {
      sides: 2,
      material: 'softwood',
      roughingToolDiaMm: 6,
      finishingToolDiaMm: 6,
      finishingToolType: 'flat',
      tabCount: 4,
      tabWidthMm: 6,
      tabThicknessMm: 3,
      toolStickoutMm: 50,
    });
    const r = generateSolidMachining(part, { ...opts, setups: ['+z', '-y', '-z'] });
    expect(r.success, r.error).toBe(true);
    expect(r.tabsPlaced).toBeGreaterThanOrEqual(2);
    expect(r.tabPrisms!.length).toBe(r.tabsPlaced);

    const simSetups = r.setups!.map((s) => ({
      gcode: s.gcode,
      rotation: s.rotation,
      translation: s.translation,
      stock: s.stock,
    }));
    const tools = reliefSimulationTools(opts);
    const cut = cutSetups(simSetups, tools.tools, tools.initialTool, r.stock, 0.5);

    // Every placed tab prism must still have solid material across its midpoint after ALL 3 setups!
    for (const tab of r.tabPrisms!) {
      const mx = (tab.x0 + tab.x1) / 2;
      const my = (tab.y0 + tab.y1) / 2;
      const mz = (tab.topZ + tab.bottomZ) / 2;
      expect(cut.field(mx, my, mz)).toBeGreaterThan(-0.35);
    }
  });

  it('keeps opposing frame + tabs when all 4 side faces are cut and tool reach permits', () => {
    // 30 x 30 x 18 mm body with shallow side grooves on all 4 vertical faces (x=0, x=30, y=0, y=30).
    const part = body([
      boxMeshMm(0, 0, 0, 30, 30, 5),
      boxMeshMm(0, 0, 13, 30, 30, 18),
      boxMeshMm(4, 4, 5, 26, 26, 13),
    ]);
    const opts = deriveSolidOptions(part, {
      sides: 1,
      material: 'softwood',
      roughingToolDiaMm: 4,
      finishingToolDiaMm: 4,
      finishingToolType: 'flat',
      tabCount: 4,
      toolStickoutMm: 24,
      clearanceMm: 120,
    });
    const r = generateSolidMachining(part, { ...opts, setups: ['+x', '-x', '+y', '-y', '+z'] });
    expect(r.success, r.error).toBe(true);
    expect(r.tabsPlaced).toBeGreaterThan(0);
  });
});

describe('S-C4: machineMcp bench stock XY origin alignment, face-list setups, and side-up summary', () => {
  it('aligns carveOptions and jobBounds to benchStock XY dimensions and formats side setups cleanly', async () => {
    const cube = body([boxMeshMm(-25, -20, 0, 25, 20, 10)]);
    const bench = { widthMm: 120, depthMm: 100, thicknessMm: 18 };
    setCurrentScene(cube, bench);
    try {
      const { options, stockFrom } = carveOptions({ toolDiaMm: 6, material: 'softwood' });
      expect(stockFrom).toBe('bench');
      expect(options.board).toEqual(bench);

      const carved = generateSolidMachining(cube, options);
      expect(carved.stock.widthMm).toBe(120);
      expect(carved.stock.depthMm).toBe(100);
      expect((carved.partBounds.minX + carved.partBounds.maxX) / 2).toBeCloseTo(60, 2);
      expect((carved.partBounds.minY + carved.partBounds.maxY) / 2).toBeCloseTo(50, 2);
      expect(jobBounds()).toEqual({ minX: 0, minY: 0, maxX: 120, maxY: 100 });

      // Face-list setups parsed cleanly
      const withSetups = carveOptions({ toolDiaMm: 6, setups: ['-y', '+z'] });
      expect(withSetups.options.setups).toEqual(['-y', '+z']);

      // Carve summary when Setup 1 is a side face (-y) never says "Cutting side undefined"
      const mgr = webSerialManager as unknown as {
        state: Record<string, unknown>;
        runJob: typeof webSerialManager.runJob;
      };
      const prevConnected = mgr.state.connected;
      const prevStatus = mgr.state.status;
      const origRunJob = mgr.runJob;
      mgr.state.connected = true;
      mgr.state.status = 'IDLE';
      mgr.runJob = (async () => ({ delivered: true, message: 'ok' })) as unknown as typeof webSerialManager.runJob;
      machineArming.arm(60_000);
      try {
        const frontPocketPart = body([
          boxMeshMm(-25, -8, 0, 25, 20, 12),
          boxMeshMm(-25, -20, 0, 25, -8, 4),
          boxMeshMm(-25, -20, 9, 25, -8, 12),
        ]);
        setCurrentScene(frontPocketPart, bench);
        const pocketCarved = generateSolidMachining(
          frontPocketPart,
          carveOptions({ toolDiaMm: 6, material: 'softwood', setups: ['-y'] }).options
        );
        const handlers = createMeshMachineHandlers();
        const reply = (await handlers.CARVE_SCENE({
          toolDiaMm: 6,
          material: 'softwood',
          setups: ['-y'],
          acceptUnreachable: true,
        })) as { summary: string };
        expect(reply.summary).toContain('Cutting setup 1 of 2 (front up)');
        expect(reply.summary).not.toContain('undefined');
        // Bounds for the active -y setup match the block standing on its back (width x thickness)
        expect(jobBounds()).toEqual({
          minX: 0,
          minY: 0,
          maxX: pocketCarved.setups![0].stock.widthMm,
          maxY: pocketCarved.setups![0].stock.depthMm,
        });
      } finally {
        machineArming.disarm();
        mgr.runJob = origRunJob;
        mgr.state.connected = prevConnected;
        mgr.state.status = prevStatus;
      }
    } finally {
      setCurrentScene(null);
    }
  });
});

describe('S-H1: turn instructions after side setup, earlierCuts touch-off safety, and probe grid guard', () => {
  it('describes laying the block back flat on +z after a side setup instead of "Block as it started"', () => {
    const stock = { widthMm: 100, depthMm: 80, thicknessMm: 20 };
    expect(describeTurn(setupFrame('+z', stock))).toBe('Block as it started: top up, front towards you.');
    const afterFront = describeTurn(setupFrame('+z', stock), '-y');
    expect(afterFront).toContain('Lay the block flat on its underside, top up');
    expect(afterFront).not.toContain('Block as it started');
  });

  it('keeps T2 M6 touch-off on +z clear of air milled out by an earlier side setup and skips undersized probe grids', () => {
    const part = body([
      boxMeshMm(0, 12, 0, 40, 40, 18),
      boxMeshMm(0, 0, 0, 40, 12, 6),
      boxMeshMm(0, 0, 13, 40, 12, 18),
    ]);
    const smallGrid = gridFromPoints([
      [
        { x: 0, y: 0, z: 0 },
        { x: 10, y: 0, z: 1.5 },
      ],
      [
        { x: 0, y: 10, z: -1.5 },
        { x: 10, y: 10, z: 0 },
      ],
    ])!;
    const asked = deriveSolidOptions(part, {
      sides: 1,
      material: 'softwood',
      roughingToolDiaMm: 6,
      finishingToolDiaMm: 3,
      finishingToolType: 'flat',
      toolStickoutMm: 50,
      applyMeshLeveling: true,
      meshLevelGrid: smallGrid,
    });
    const r = generateSolidMachining(part, { ...asked, setups: ['-y', '+z'] });
    expect(r.success, r.error).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/Bed levelling grid is smaller than the top-up setup footprint; all setups are cut without levelling/);

    const sideSetup = r.setups![0];
    const topSetup = r.setups![1];
    expect(topSetup.instructions.join(' ')).toMatch(/Lay the block flat/);

    const sideCut = simulateMilling(sideSetup.gcode, {
      widthMm: sideSetup.stock.widthMm,
      depthMm: sideSetup.stock.depthMm,
      cellMm: 0.5,
      initialTool: 1,
      tools: { 1: { shape: 'flat', diameterMm: 6 }, 2: { shape: 'flat', diameterMm: 3 } },
    });
    const m6Match = /G0 X(-?[\d.]+) Y(-?[\d.]+)\nT2 M6/.exec(topSetup.gcode);
    expect(m6Match).not.toBeNull();
    const tx = parseFloat(m6Match![1]);
    const ty = parseFloat(m6Match![2]);
    const q = setupFrame('-y', r.stock).toSetup([tx, ty, 0]);
    expect(sideCut.at(q[0], q[1])).toBeGreaterThanOrEqual(q[2] - 0.5);
  });
});

describe('S-H2: ball-nose and V-bit midplane overlap and 1-sided bottom-skirt warning', () => {
  it('leaves no uncut midplane bridge or cusp belt on a 2-sided cylinder cut with a ball-nose', () => {
    const cyl: SceneGraph = body([{ type: 'cylinder', size: [0.012, 0.012] } as Partial<SceneGeom>]);
    const opts = deriveSolidOptions(cyl, {
      sides: 2,
      material: 'softwood',
      roughingEnabled: false,
      finishingEnabled: true,
      finishingToolDiaMm: 6,
      finishingToolType: 'ball_nose',
      tabCount: 0,
      registrationPins: false,
      toolStickoutMm: 50,
    });
    expect(tipSideContactOffsetMm(opts)).toBeCloseTo(3, 6);
    const res = generateSolidMachining(cyl, opts);
    expect(res.success, res.error).toBe(true);

    const tools = reliefSimulationTools(opts);
    const { grid } = simulateStock({
      gcode: res.sides[0].gcode,
      gcodeB: res.sides[1].gcode,
      widthMm: res.stock.widthMm,
      depthMm: res.stock.depthMm,
      thicknessMm: res.stock.thicknessMm,
      ...tools,
    });
    const cx = res.stock.widthMm / 2;
    const cy = res.stock.depthMm / 2;
    const bottom = grid.bottom as Float64Array;
    // At r = 13.0 mm (just 1 mm outside the 12 mm cylinder radius!), previously a 6 mm ball-nose
    // left a solid uncut bridge around the midplane. Now top <= bottom (completely cut through!).
    for (let deg = 0; deg < 360; deg += 30) {
      const rad = (deg * Math.PI) / 180;
      const c = Math.round((cx + 13.0 * Math.cos(rad)) / grid.cell);
      const r = Math.round((cy + 13.0 * Math.sin(rad)) / grid.cell);
      const k = r * grid.cols + c;
      expect(grid.top[k] - bottom[k]).toBeLessThanOrEqual(0.05);
    }
  });

  it('warns on a 1-sided job when a ball-nose or V-bit leaves a bottom skirt above throughCutMm', () => {
    const block = body([boxMeshMm(-10, -10, 0, 10, 10, 12)]);
    const opts = deriveSolidOptions(block, {
      sides: 1,
      material: 'softwood',
      finishingToolDiaMm: 6,
      finishingToolType: 'ball_nose',
      throughCutMm: 0.2,
    });
    const res = generateSolidMachining(block, opts);
    expect(res.success).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/steep walls will keep a small bottom skirt/);
  });
});

describe('S-H3: 2-sided + flush side setup provides a surviving datum for -z when pins are skipped', () => {
  it('cuts a through-thickness flip datum notch or references surviving un-milled faces for -z', () => {
    const part = body([
      boxMeshMm(0, 0, 0, 28, 40, 20),
      boxMeshMm(28, 0, 0, 40, 40, 6),
      boxMeshMm(28, 0, 14, 40, 40, 20),
    ]);
    const opts = deriveSolidOptions(part, {
      sides: 2,
      material: 'softwood',
      roughingToolDiaMm: 6,
      finishingToolDiaMm: 6,
      finishingToolType: 'flat',
      registrationPins: true,
      toolStickoutMm: 50,
    });
    const r = generateSolidMachining(part, { ...opts, setups: ['+z', '+x', '-z'] });
    expect(r.success, r.error).toBe(true);
    expect(r.pins).toHaveLength(0);
    const flip = r.setups!.find((s) => s.upFace === '-z')!;
    expect(flip.locate).toBe('knownSpot');
    expect(flip.datum).toBeDefined();
    // +x was flushed and milled on Setup 2; after flipping left-to-right onto -z, +x is now -z's LEFT face (x = 0)!
    // So -z MUST NOT tell the operator to zero X on the raw left face at wallMm === 0 without a notch!
    const xTouch = flip.datum!.touches.find((t) => t.axis === 'x')!;
    expect(xTouch.wallMm).toBeGreaterThan(0);
  });
});

describe('S-M1..S-M5 & S-L1..S-L3', () => {
  it('S-M2: warps before shifting post-M6 Z, leaves comments untouched, and tracks rapid clearance from spot', () => {
    // 30 x 30 mm heightmap whose entire surface sits at z = -4 mm, so roughing removes ALL z = 0 stock
    // and T2 M6 must touch off on the roughing shelf (levelMm < 0).
    const cols = 31, rows = 31;
    const z = new Float32Array(cols * rows).fill(-4);
    const grid = gridFromPoints([
      [
        { x: 0, y: 0, z: 0.2 },
        { x: 30, y: 0, z: 1.2 },
      ],
      [
        { x: 0, y: 30, z: -0.4 },
        { x: 30, y: 30, z: 0.6 },
      ],
    ])!;
    const warnings: string[] = [];
    const res = machineSurface(
      {
        surface: { minX: 0, minY: 0, maxX: 30, maxY: 30, cols, rows, stepX: 1, stepY: 1, z },
        bounds: { minX: 0, minY: 0, maxX: 30, maxY: 30, minZ: -10, maxZ: 0 },
        depthMm: 4,
        resolution: 1,
        header: ['; Header Z0 check'],
      },
      {
        ...DEFAULT_RELIEF_OPTIONS,
        stockWidthMm: 30,
        stockDepthMm: 30,
        stockThicknessMm: 10,
        carveDepthMm: 4,
        roughingEnabled: true,
        finishingEnabled: true,
        roughingToolDiaMm: 6,
        finishingToolDiaMm: 3,
        finishingToolType: 'flat',
        roughingAllowanceMm: 0.5,
        roughingStepdownMm: 2,
        applyMeshLeveling: true,
        meshLevelGrid: grid,
      },
      warnings
    );
    expect(res.success, res.error).toBe(true);
    const m6Match = /G0 X(-?[\d.]+) Y(-?[\d.]+)(?: Z-?[\d.]+)?\nT2 M6 ; (.*)/.exec(res.gcode);
    expect(m6Match).not.toBeNull();
    const sx = parseFloat(m6Match![1]);
    const sy = parseFloat(m6Match![2]);

    // Any comments after M6 must NOT have their Z numbers mutated
    const afterM6 = res.gcode.slice(res.gcode.indexOf('T2 M6'));
    expect(afterM6).toContain('re-zero Z');

    // Verify warped finishing floor at (15, 15): nominal z = -4, warped = -4 + grid(15,15),
    // shifted by -(shelfZ + grid(sx, sy)), where shelfZ = -3.5 (-4 + 0.5 allowance).
    const expectedTouchZ = -3.5 + interpolateGridZ(grid, sx, sy);
    const expectedAtCentre = -4 + interpolateGridZ(grid, 15, 15) - expectedTouchZ;
    // Find a finishing G1 move near X15 Y15
    let foundNearCentre = false;
    let curX = sx, curY = sy, curZ = 20;
    for (const raw of afterM6.split('\n').slice(1)) {
      const code = raw.split(';')[0].trim();
      if (!code.startsWith('G1')) continue;
      const xm = /X(-?[\d.]+)/.exec(code);
      const ym = /Y(-?[\d.]+)/.exec(code);
      const zm = /Z(-?[\d.]+)/.exec(code);
      if (xm) curX = parseFloat(xm[1]);
      if (ym) curY = parseFloat(ym[1]);
      if (zm) curZ = parseFloat(zm[1]);
      if (Math.hypot(curX - 15, curY - 15) < 1.5 && curZ < 0) {
        expect(curZ).toBeCloseTo(expectedAtCentre, 1);
        foundNearCentre = true;
        break;
      }
    }
    expect(foundNearCentre).toBe(true);
  });

  it('S-M4: supports distinct roughingToolDiaMm and finishingToolDiaMm and includes summary.setups when setups=2', async () => {
    const simpleBlock: SceneGraph = body([{ type: 'box', size: [0.01, 0.01, 0.004] }]);
    const distinct = machiningOptionsFor(
      { kind: 'machining', roughingToolDiaMm: 6.35, finishingToolDiaMm: 2.0, material: 'aluminium' },
      simpleBlock
    );
    expect(distinct.roughingToolDiaMm).toBe(6.35);
    expect(distinct.finishingToolDiaMm).toBe(2.0);

    // Default equivalence preserved
    expect(machiningOptionsFor({ kind: 'machining' }, simpleBlock)).toEqual(
      machiningOptionsFor({ sides: 1, toolDiaMm: 3, material: 'aluminium', finishingToolType: 'flat' }, simpleBlock)
    );

    // EXPORT_MACHINING includes summary.setups when setups: 2 is requested
    const ctx = { store: { sceneGraph: simpleBlock }, toId: (s: string) => s } as never;
    const reply = (await machiningCommands.EXPORT_MACHINING(
      { setups: 2, toolDiaMm: 6, material: 'softwood' },
      ctx
    )) as { ok: boolean; summary: { setups?: { index: number; face: string }[] } };
    expect(reply.ok).toBe(true);
    expect(reply.summary.setups).toHaveLength(2);
    expect(reply.summary.setups!.map((s) => s.face)).toEqual(['+z', '-z']);
  });

  it('S-M5: miters 90-degree open box corners to full wall thickness and solidifies double-sided open sheets', () => {
    // 1. Open 5-face rectangular tray (floor z=0 + 4 vertical walls of height 1, grid unit = 10 mm -> 20x20x10 mm)
    const l = createLattice(0.01);
    const v000 = vertexAt(l, 0, 0, 0), v200 = vertexAt(l, 2, 0, 0), v220 = vertexAt(l, 2, 2, 0), v020 = vertexAt(l, 0, 2, 0);
    const v001 = vertexAt(l, 0, 0, 1), v201 = vertexAt(l, 2, 0, 1), v221 = vertexAt(l, 2, 2, 1), v021 = vertexAt(l, 0, 2, 1);
    // Wound outward so inward normal points into the tray (+x/+y/+z at (0,0,0)):
    // solidify offsets by `-t * n`, so face normals must point OUTWARD (-z on floor, -y on front, etc.)!
    addFace(l, [v000, v020, v220, v200]); // floor facing -z -> inward offset +z
    addFace(l, [v000, v200, v201, v001]); // front wall facing -y -> inward offset +y
    addFace(l, [v200, v220, v221, v201]); // right wall facing +x -> inward offset -x
    addFace(l, [v220, v020, v021, v221]); // back wall facing +y -> inward offset -y
    addFace(l, [v020, v000, v001, v021]); // left wall facing -x -> inward offset +x

    const tray = toPolyMesh(l);
    expect(isClosed(tray)).toBe(false);
    const wallM = 0.002; // 2 mm
    const solidTray = solidify(tray, wallM);
    expect(isClosed(solidTray)).toBe(true);

    // Corner vertex 0 was at (0, 0, 0); its inner twin is at index n = tray.positions.length / 3
    const nVerts = tray.positions.length / 3;
    const ix = solidTray.positions[nVerts * 3];
    const iy = solidTray.positions[nVerts * 3 + 1];
    const iz = solidTray.positions[nVerts * 3 + 2];
    // With proper 3-plane corner mitering, each coordinate moves inward by the full 2 mm (not 2 / sqrt(3) = 1.15 mm!)
    expect(ix).toBeCloseTo(0.002, 5);
    expect(iy).toBeCloseTo(0.002, 5);
    expect(iz).toBeCloseTo(0.002, 5);

    // 2. Double-sided zero-thickness open sheet (front + reversed back face on the same vertices)
    const doubleSided = {
      positions: new Float64Array([0, 0, 0, 0.02, 0, 0, 0.02, 0.02, 0, 0, 0.02, 0]),
      faces: [
        [0, 1, 2, 3],
        [0, 3, 2, 1],
      ],
    };
    expect(isClosed(doubleSided)).toBe(false);
    const thickenedSheet = solidify(doubleSided, 0.002);
    expect(isClosed(thickenedSheet)).toBe(true);
    expect(thickenedSheet.faces.length).toBe(6);
  });

  it('S-L1 & S-L2: places "zero here" at datumXY in setupDiagramSvg and fixes Top Skin tooltip', () => {
    const stock = { widthMm: 120, depthMm: 100, thicknessMm: 20 };
    const cornerSvg = setupDiagramSvg({ upFace: '+z', firstStock: stock, locate: 'knownSpot' });
    const notchSvg = setupDiagramSvg({
      upFace: '+z',
      firstStock: stock,
      locate: 'knownSpot',
      datumXY: { x: 10, y: 10 },
    });
    const circlePos = (svg: string) => {
      const m = /<circle cx="([\d.]+)" cy="([\d.]+)"/.exec(svg)!;
      return [parseFloat(m[1]), parseFloat(m[2])];
    };
    const [cx0, cy0] = circlePos(cornerSvg);
    const [cx1, cy1] = circlePos(notchSvg);
    expect(Math.hypot(cx1 - cx0, cy1 - cy0)).toBeGreaterThan(2);

    const modalSrc = readFileSync(
      resolve(__dirname, '../src/components/ExportSolidMachiningModal.tsx'),
      'utf8'
    );
    expect(modalSrc).toContain('Top Skin (mm)');
    expect(modalSrc).toContain("Extra stock thickness left above the part's top face");
    expect(modalSrc).not.toMatch(/Material[\s\S]{0,500}What is being cut\. Sets cutting speed[\s\S]{0,120}Top Skin \(mm\)/);
  });

  it('S-L3: merges revolution cap wedges across floating-point rounding boundaries', () => {
    // Two triangular wedges meeting at the Z axis (0,0) with tLo differing by 2e-6 across a 0.5*eps boundary.
    // reach = 1.0 -> eps = 1e-4; old Math.round(tLo / 1e-4) split 0.49999e-4 (0) vs 0.50001e-4 (1)!
    const wedge = (a0: number, a1: number, z0: number, z1: number): Hull => {
      const pts = [
        [0, 0, z0],
        [Math.cos(a0), Math.sin(a0), z0],
        [Math.cos(a1), Math.sin(a1), z0],
        [0, 0, z1],
        [Math.cos(a0), Math.sin(a0), z1],
        [Math.cos(a1), Math.sin(a1), z1],
      ];
      const h = convexHullOf(pts)!;
      return { ...h, volume: Math.abs(h.volume) };
    };
    const w1 = wedge(0, Math.PI / 4, 0.00004999, 0.1);
    const w2 = wedge(Math.PI / 4, Math.PI / 2, 0.00005001, 0.1);
    const merged = mergeConvexTiers([w1, w2], { origin: [0, 0, 0], axis: [0, 0, 1] }, convexHullOf);
    expect(merged).toHaveLength(1);
  });
});
