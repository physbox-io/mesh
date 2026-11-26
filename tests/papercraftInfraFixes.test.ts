import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewCommands } from '../src/hooks/mcp/viewCommands';
import { sceneCommands } from '../src/hooks/mcp/sceneCommands';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { physicsGlobals } from '../src/physicsGlobals';
import { useStore } from '../src/store/useStore';
import { clampStock, MIN_STOCK_THICKNESS_MM } from '../src/utils/stockSettings';
import { stockReport } from '../src/utils/sceneSummary';
import {
  exportSheetUnfold,
  SHEET_PRESETS,
  type SheetPreset,
} from '../src/utils/sheetUnfoldExporter';
import {
  ANALYSE_TIMEOUT_MS,
  SOLID_TIMEOUT_MS,
  analyseMeshOffThread,
  decomposeMeshOffThread,
  setVhacdWorkerFactory,
  type WorkerLike,
} from '../src/utils/vhacdWorkerClient';
import { decomposeSolid } from '../src/utils/solidDecomposition';
import type { VhacdRequest, VhacdResponse } from '../src/workers/vhacdProtocol';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const makeCtx = () => ({
  store: useStore.getState(),
  toId: (v: unknown) => v,
}) as never;

const boxNode = (
  id: string,
  pos: [number, number, number],
  half: [number, number, number],
  rgba?: [number, number, number, number],
): SceneNode => ({
  id,
  name: id,
  type: 'body',
  pos,
  joints: [],
  children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: half, ...(rgba ? { rgba } : {}) }],
});

describe('Papercraft & Infra Fixes', () => {
  describe('Item 1: SCREENSHOT scale option and renderer pause during flush', () => {
    const origWindow = globalThis.window;

    afterEach(() => {
      if (origWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = origWindow;
      }
    });

    it('rejects out-of-range or non-numeric scale values', async () => {
      for (const bad of [0, 0.1, 1.5, NaN, Infinity, '0.5']) {
        const res = await viewCommands.SCREENSHOT({ scale: bad }, makeCtx()) as { ok: boolean; error?: string };
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/scale/i);
      }
    });

    it('renders at reduced pixelRatio when scale < 1, reports scaled dims, and restores even on error', async () => {
      let dpr = 2;
      const cssW = 400;
      const cssH = 300;
      const composerSizes: Array<[number, number, boolean | undefined]> = [];
      let throwOnRead = false;

      const domElement = {
        get width() { return Math.round(cssW * dpr); },
        get height() { return Math.round(cssH * dpr); },
        toDataURL: () => {
          if (throwOnRead) throw new Error('readback failed');
          return `data:image/png;base64,w${Math.round(cssW * dpr)}h${Math.round(cssH * dpr)}`;
        },
      } as unknown as HTMLCanvasElement;

      const gl = {
        domElement,
        render: vi.fn(),
        getPixelRatio: () => dpr,
        setPixelRatio: (r: number) => { dpr = r; },
        getSize: (t: { x: number; y: number }) => ({ ...t, x: cssW, y: cssH }),
      };
      const composer = {
        render: vi.fn(),
        setSize: (w: number, h: number, u?: boolean) => { composerSizes.push([w, h, u]); },
      };

      (globalThis as Record<string, unknown>).window = {
        _physics_gl: gl,
        _physics_composer: composer,
        _physics_scene: {},
        _physics_camera: {},
      };

      const res = await viewCommands.SCREENSHOT({ scale: 0.5 }, makeCtx()) as {
        ok: boolean; width: number; height: number; dataUrl: string; view: Record<string, unknown>;
      };
      expect(res.ok).toBe(true);
      expect(res.width).toBe(400);
      expect(res.height).toBe(300);
      expect(res.dataUrl).toBe('data:image/png;base64,w400h300');
      expect(res.view.scale).toBe(0.5);
      // Restored after capture
      expect(dpr).toBe(2);
      expect(composerSizes).toEqual([[400, 300, false], [400, 300, false]]);

      // Also restores on throw
      throwOnRead = true;
      await expect(viewCommands.SCREENSHOT({ scale: 0.25 }, makeCtx())).rejects.toThrow(/readback failed/);
      expect(dpr).toBe(2);
    });

    it('pauses BOTH composer.render and gl.render during React commit flush', async () => {
      const glRender = vi.fn();
      const composerRender = vi.fn();
      const gl = {
        domElement: { width: 640, height: 480, toDataURL: () => 'data:image/png;base64,ok' } as unknown as HTMLCanvasElement,
        render: glRender,
      };
      const composer = { render: composerRender };
      const prevGl = physicsGlobals._physics_gl;
      const prevComposer = physicsGlobals._physics_composer;
      const prevScene = physicsGlobals._physics_scene;
      const prevCamera = physicsGlobals._physics_camera;
      (globalThis as Record<string, unknown>).window = {
        _physics_gl: gl,
        _physics_composer: composer,
        _physics_scene: {},
        _physics_camera: {},
      };
      physicsGlobals._physics_gl = gl as never;
      physicsGlobals._physics_composer = composer as never;
      physicsGlobals._physics_scene = {} as never;
      physicsGlobals._physics_camera = {} as never;

      try {
        const pending = viewCommands.SCREENSHOT({ clean: true }, makeCtx());
        // Let screenshotQueue's .then() enter takeScreenshot and install the flush pause
        await Promise.resolve();
        // Simulate intervening rAF calling both composer.render and gl.render during flush
        composer.render();
        gl.render({}, {});
        expect(composerRender).not.toHaveBeenCalled();
        expect(glRender).not.toHaveBeenCalled();

        const res = await pending as { ok: boolean };
        expect(res.ok).toBe(true);
        expect(composerRender).toHaveBeenCalledTimes(1);
      } finally {
        physicsGlobals._physics_gl = prevGl;
        physicsGlobals._physics_composer = prevComposer;
        physicsGlobals._physics_scene = prevScene;
        physicsGlobals._physics_camera = prevCamera;
      }
    });
  });

  describe('Item 2: Thin sheet stock_thickness_mm down to 0.1 mm and clamp warning', () => {
    beforeEach(() => {
      useStore.getState().setStock({ widthMm: 150, depthMm: 150, thicknessMm: 18 });
    });

    it('allows thin sheet stock down to 0.1 mm without clamping to 1 mm', () => {
      expect(MIN_STOCK_THICKNESS_MM).toBe(0.1);
      expect(clampStock({ widthMm: 215.9, depthMm: 279.4, thicknessMm: 0.4 }).thicknessMm).toBe(0.4);
      expect(clampStock({ widthMm: 210, depthMm: 297, thicknessMm: 0.1 }).thicknessMm).toBe(0.1);
      expect(clampStock({ widthMm: 210, depthMm: 297, thicknessMm: 0.05 }).thicknessMm).toBe(0.1);
    });

    it('SET_ENVIRONMENT preserves 0.4 mm cardstock thickness with no warning and warns when clamping', async () => {
      const okRes = await sceneCommands.SET_ENVIRONMENT(
        { stockWidthMm: 215.9, stockDepthMm: 279.4, stockThicknessMm: 0.4 },
        makeCtx(),
      ) as { ok: boolean; stock?: { thicknessMm: number }; warning?: string };
      expect(okRes.ok).toBe(true);
      expect(okRes.stock?.thicknessMm).toBe(0.4);
      expect(okRes.warning).toBeUndefined();

      const clampedRes = await sceneCommands.SET_ENVIRONMENT(
        { stockThicknessMm: 0.02 },
        makeCtx(),
      ) as { ok: boolean; stock?: { thicknessMm: number }; warning?: string };
      expect(clampedRes.ok).toBe(true);
      expect(clampedRes.stock?.thicknessMm).toBe(0.1);
      expect(clampedRes.warning).toMatch(/clamped from 0\.02 to 0\.1 mm/i);
    });
  });

  describe('Item 3: Hollow lattice convex decomposition reliability & queue priority', () => {
    afterEach(() => {
      setVhacdWorkerFactory(null);
      vi.useRealTimers();
    });

    it('uses generous solid/analyse timeouts and prioritizes fast ANALYSE jobs ahead of queued DECOMPOSE jobs', async () => {
      expect(SOLID_TIMEOUT_MS).toBeGreaterThanOrEqual(90_000);
      expect(ANALYSE_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);

      vi.useFakeTimers();
      const order: string[] = [];
      const fakeWorker = (): WorkerLike => ({
        onmessage: null,
        onerror: null,
        terminate() {},
        postMessage(msg: VhacdRequest) {
          order.push(msg.type);
          const delay = msg.type === 'ANALYSE' ? 50 : 1000;
          setTimeout(() => {
            if (msg.type === 'ANALYSE') {
              this.onmessage?.({
                data: {
                  type: 'ANALYSED',
                  id: msg.id,
                  analysis: { volume: 1, hullVolume: 1, integrity: { closed: true, consistentlyWound: true, volume: 1, boundaryEdges: 0, nonManifoldEdges: 0, degenerateTriangles: 0 }, concavityDepth: 0 },
                } as VhacdResponse,
              } as MessageEvent<VhacdResponse>);
            } else {
              this.onmessage?.({
                data: { type: 'DECOMPOSED', id: msg.id, hulls: [] } as VhacdResponse,
              } as MessageEvent<VhacdResponse>);
            }
          }, delay);
        },
      });
      setVhacdWorkerFactory(fakeWorker);

      const d1 = decomposeMeshOffThread([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
      const d2 = decomposeMeshOffThread([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
      const a1 = analyseMeshOffThread([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
      await vi.advanceTimersByTimeAsync(5000);
      await Promise.all([d1, d2, a1]);
      // d1 started immediately; while d1 was running, a1 jumped ahead of queued d2
      expect(order).toEqual(['DECOMPOSE', 'ANALYSE', 'DECOMPOSE']);
    });

    it('decomposes a thin-walled hollow cup (68-triangle class) quickly without timing out', async () => {
      // Build a closed open-top hollow square cup (outer 70x70x90 mm, 1 mm walls, 1 mm floor)
      const ox = 0.035, oy = 0.035, ix = 0.034, iy = 0.034;
      const z0 = 0, zFloor = 0.001, zTop = 0.090;
      const pts: [number, number, number][] = [
        // Outer bottom (0..3)
        [-ox, -oy, z0], [ox, -oy, z0], [ox, oy, z0], [-ox, oy, z0],
        // Outer top (4..7)
        [-ox, -oy, zTop], [ox, -oy, zTop], [ox, oy, zTop], [-ox, oy, zTop],
        // Inner top (8..11)
        [-ix, -iy, zTop], [ix, -iy, zTop], [ix, iy, zTop], [-ix, iy, zTop],
        // Inner floor (12..15)
        [-ix, -iy, zFloor], [ix, -iy, zFloor], [ix, iy, zFloor], [-ix, iy, zFloor],
      ];
      const verts = pts.flat();
      const faces: number[] = [];
      const quad = (a: number, b: number, c: number, d: number) => {
        faces.push(a, b, c, a, c, d);
      };
      // Outer bottom (-Z)
      quad(0, 3, 2, 1);
      // Outer walls
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        quad(i, j, 4 + j, 4 + i);
      }
      // Top rim (+Z)
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        quad(4 + i, 4 + j, 8 + j, 8 + i);
      }
      // Inner walls (facing inward)
      for (let i = 0; i < 4; i++) {
        const j = (i + 1) % 4;
        quad(8 + i, 8 + j, 12 + j, 12 + i);
      }
      // Inner floor (+Z)
      quad(12, 13, 14, 15);

      const t0 = Date.now();
      const res = await decomposeSolid(verts, faces, { maxPieces: 64 });
      const elapsedMs = Date.now() - t0;
      expect(res.hulls.length).toBeGreaterThanOrEqual(5);
      expect(res.cavities).toHaveLength(0);
      expect(elapsedMs).toBeLessThan(5000);
    });
  });

  describe('Items 4, 5, 6: Unfold machine default, sheet presets, color/part grouping, omittedTabs', () => {
    const multiColorScene: SceneGraph = {
      nodes: [
        boxNode('red_cup', [-0.08, 0, 0.02], [0.015, 0.015, 0.02], [0.8, 0.13, 0.13, 1]),
        boxNode('red_lid', [0, 0, 0.01], [0.015, 0.015, 0.01], [0.8, 0.13, 0.13, 1]),
        boxNode('blue_tray', [0.08, 0, 0.015], [0.02, 0.015, 0.015], [0.13, 0.27, 0.8, 1]),
      ],
    };

    const runCut = (msg: Record<string, unknown>, sceneGraph: SceneGraph = multiColorScene) => {
      const store = { ...useStore.getState(), sceneGraph };
      return cutCommands.EXPORT_CUT(msg, { store, toId: (v: unknown) => v } as never) as Promise<Record<string, unknown>>;
    };

    beforeEach(() => {
      useStore.getState().setMachineTarget('cnc');
      useStore.getState().setStock({ widthMm: 600, depthMm: 400, thicknessMm: 0.4 });
    });

    it('Item 4: defaults machine to laser for kind=unfold even when bench machine is cnc, while honoring explicit machine', async () => {
      const paper = await runCut({ kind: 'unfold', sheetMode: 'papercraft' });
      expect(paper.ok).toBe(true);
      expect(paper.machine).toBe('laser');
      expect((paper.etch as { machine: string }).machine).toBe('laser');

      const soft = await runCut({ kind: 'unfold', sheetMode: 'soft_goods' });
      expect(soft.ok).toBe(true);
      expect(soft.machine).toBe('laser');

      const explicitCnc = await runCut({ kind: 'unfold', sheetMode: 'papercraft', machine: 'cnc' });
      expect(explicitCnc.ok).toBe(true);
      expect(explicitCnc.machine).toBe('cnc');
    });

    it('Item 5a: supports letter, a4, cardstock_12x12, and tabloid sheet presets and rejects invalid ones', async () => {
      for (const preset of ['letter', 'a4', 'cardstock_12x12', 'tabloid'] as SheetPreset[]) {
        const res = await runCut({ kind: 'unfold', sheetMode: 'papercraft', sheet_preset: preset });
        expect(res.ok).toBe(true);
        const expected = SHEET_PRESETS[preset];
        const svg = Buffer.from((res.files as { base64: string }[])[0].base64, 'base64').toString('utf8');
        expect(svg).toContain(`width="${expected.widthMm}mm"`);
        expect((res.summary as { sheetPreset?: string }).sheetPreset).toBe(preset);
      }

      const bad = await runCut({ kind: 'unfold', sheetPreset: 'a0_poster' });
      expect(bad.ok).toBe(false);
      expect(String(bad.error)).toMatch(/sheetPreset/i);
    });

    it('Item 5b: group_by_color packs different colors onto separate sheets and one_part_per_sheet isolates each part', async () => {
      // Without grouping: all 3 small boxes fit on 1 big 600x400 sheet
      const ungrouped = exportSheetUnfold(multiColorScene, { mode: 'papercraft', sheetWidthMm: 600, sheetHeightMm: 400 });
      expect(ungrouped.sheets).toHaveLength(1);

      // With group_by_color: red_cup + red_lid share Sheet 1, blue_tray gets Sheet 2
      const byColor = await runCut({ kind: 'unfold', sheetMode: 'papercraft', group_by_color: true });
      expect(byColor.ok).toBe(true);
      const colorSummary = byColor.summary as { sheets: number; sheetGroups?: Array<{ pieces: number; colorHex?: string }> };
      expect(colorSummary.sheets).toBe(2);
      expect(colorSummary.sheetGroups).toHaveLength(2);
      expect(colorSummary.sheetGroups![0].pieces).toBe(2);
      expect(colorSummary.sheetGroups![1].pieces).toBe(1);
      expect(colorSummary.sheetGroups![0].colorHex).not.toBe(colorSummary.sheetGroups![1].colorHex);

      // With one_part_per_sheet: each of the 3 parts gets its own dedicated sheet
      const perPart = await runCut({ kind: 'unfold', sheetMode: 'papercraft', one_part_per_sheet: true });
      expect(perPart.ok).toBe(true);
      const partSummary = perPart.summary as { sheets: number; sheetGroups?: Array<{ group?: string; pieces: number }> };
      expect(partSummary.sheets).toBe(3);
      expect(partSummary.sheetGroups?.map((g) => g.group)).toEqual(['red_cup', 'red_lid', 'blue_tray']);
    });

    it('Item 6: exposes omittedTabs count and narrower tab_width_mm hint when glue tabs are omitted', async () => {
      // Clean box: 0 omitted tabs, no hint
      const cleanRes = await runCut(
        { kind: 'unfold', sheetMode: 'papercraft', tabWidthMm: 5 },
        { nodes: [boxNode('cube', [0, 0, 0.02], [0.02, 0.02, 0.02])] },
      );
      expect(cleanRes.ok).toBe(true);
      const cleanSummary = cleanRes.summary as { glueTabs: number; omittedTabs: number; omittedTabsHint?: string };
      expect(cleanSummary.glueTabs).toBeGreaterThan(0);
      expect(cleanSummary.omittedTabs).toBe(0);
      expect(cleanSummary.omittedTabsHint).toBeUndefined();

      // 24-sided faceted cylinder with wide tabWidthMm: the 23 narrow V-gaps around the
      // cap-to-side seams leave insufficient clearance on both sides, omitting glue tabs
      // and surfacing omittedTabs > 0 with an actionable tab_width_mm hint.
      const crampedScene: SceneGraph = {
        nodes: [
          {
            id: 'faceted_drum',
            name: 'faceted_drum',
            type: 'body',
            pos: [0, 0, 0.04],
            joints: [],
            children: [],
            geoms: [{ name: 'faceted_drum_g', type: 'cylinder', size: [0.04, 0.04], facets: 24 }],
          },
        ],
      };

      const tightRes = await runCut(
        { kind: 'unfold', sheetMode: 'papercraft', tabWidthMm: 20 },
        crampedScene,
      );
      expect(tightRes.ok).toBe(true);
      const tightSummary = tightRes.summary as { omittedTabs: number; omittedTabsHint?: string };
      expect(tightSummary.omittedTabs).toBeGreaterThan(0);
      expect(tightSummary.omittedTabsHint).toMatch(/tab_width_mm/i);
    });
  });

  describe('Item 7: Context-aware stock.note in stockReport for thin sheet vs solid stock', () => {
    const tallAssembly: SceneGraph = {
      nodes: [
        boxNode('cup', [-0.04, 0, 0.045], [0.03, 0.03, 0.045]),
        boxNode('tray', [0.04, 0, 0.015], [0.03, 0.03, 0.015]),
      ],
    };

    it('omits solid-CNC height warnings when stock is thin sheet (<= 3 mm)', () => {
      const report = stockReport(tallAssembly, { widthMm: 215.9, depthMm: 279.4, thicknessMm: 0.4 });
      expect(report.fits).toBe(true);
      expect(report.note).toBeUndefined();
      expect(report.partsNote).not.toMatch(/physics_export_machining/);
      expect(report.partsNote).toMatch(/physics_export_cut/);

      // Footprint overflow on thin sheet still warns, tailored to sheet workflow
      const smallSheet = stockReport(tallAssembly, { widthMm: 100, depthMm: 100, thicknessMm: 3 });
      expect(smallSheet.fits).toBe(false);
      expect(smallSheet.note).toMatch(/Thin sheet stock/i);
      expect(smallSheet.note).not.toMatch(/taller/);
    });

    it('keeps solid-CNC height warning when stock thickness > 3 mm', () => {
      const solid = stockReport(tallAssembly, { widthMm: 200, depthMm: 200, thicknessMm: 18 });
      expect(solid.fits).toBe(false);
      expect(solid.note).toMatch(/taller than your stock/);
      expect(solid.partsNote).toMatch(/physics_export_machining/);
    });
  });
});
