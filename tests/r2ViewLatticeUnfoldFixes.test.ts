import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Vector2 } from 'three';
import { viewCommands } from '../src/hooks/mcp/viewCommands';
import { latticeCommands } from '../src/hooks/mcp/latticeCommands';
import { objectCommands } from '../src/hooks/mcp/objectCommands';
import { cutCommands } from '../src/hooks/mcp/cutCommands';
import { useStore } from '../src/store/useStore';
import type { SceneGraph, SceneNode } from '../src/types/scene';

const makeCtx = () => ({
  store: useStore.getState(),
  toId: (v: unknown) => v,
}) as never;

const boxNode = (
  id: string,
  pos: [number, number, number],
  half: [number, number, number],
  rgba: [number, number, number, number] = [0.6, 0.6, 0.9, 1],
): SceneNode => ({
  id,
  name: id,
  type: 'body',
  pos,
  joints: [],
  children: [],
  geoms: [{ name: `${id}_g`, type: 'box', size: half, rgba }],
});

describe('Round 2 View / Lattice / Hardware / Color / Unfold Fixes', () => {
  const origRecompile = useStore.getState().recompile;

  beforeEach(() => {
    useStore.setState({
      sceneGraph: { nodes: [] },
      selectedNodeId: null,
      lastCompileError: null,
      recompile: async () => undefined,
    } as never);
  });

  afterEach(() => {
    useStore.setState({ recompile: origRecompile } as never);
  });

  // -------------------------------------------------------------------------
  // Item 1: SCREENSHOT scale < 1 with strict Three.js Vector2 target.set()
  // -------------------------------------------------------------------------
  describe('Item 1: SCREENSHOT applyRenderScale passes THREE.Vector2 to gl.getSize()', () => {
    const origWindow = globalThis.window;

    afterEach(() => {
      if (origWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = origWindow;
      }
    });

    it('invokes target.set(w, h) on a THREE.Vector2 without crashing when scale < 1', async () => {
      let dpr = 2;
      const cssW = 800;
      const cssH = 600;
      const composerSizes: Array<[number, number, boolean | undefined]> = [];
      let receivedVector2 = false;

      const domElement = {
        get width() { return Math.round(cssW * dpr); },
        get height() { return Math.round(cssH * dpr); },
        toDataURL: () => `data:image/png;base64,w${Math.round(cssW * dpr)}h${Math.round(cssH * dpr)}`,
      } as unknown as HTMLCanvasElement;

      const gl = {
        domElement,
        render: vi.fn(),
        getPixelRatio: () => dpr,
        setPixelRatio: (r: number) => { dpr = r; },
        // Strict Three.js WebGLRenderer.getSize(target) behavior: calls target.set(w, h)!
        getSize: (target: Vector2) => {
          receivedVector2 = target instanceof Vector2;
          return target.set(cssW, cssH);
        },
        getDrawingBufferSize: (target: Vector2) => target.set(Math.round(cssW * dpr), Math.round(cssH * dpr)),
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
        ok: boolean; width: number; height: number; view: Record<string, unknown>;
      };

      expect(res.ok).toBe(true);
      expect(receivedVector2).toBe(true);
      expect(res.width).toBe(800);
      expect(res.height).toBe(600);
      expect(res.view.scale).toBe(0.5);
      expect(dpr).toBe(2);
      expect(composerSizes).toEqual([[800, 600, false], [800, 600, false]]);
    });
  });

  // -------------------------------------------------------------------------
  // Items 2 & 4: LATTICE_SMOOTH & GET_LATTICE watertight on walled shells + subdiv alias
  // -------------------------------------------------------------------------
  describe('Items 2 & 4: Walled open-shell lattice watertight reporting and subdiv alias', () => {
    it('reports watertight: true, cageWatertight: false, thicknessMm, and subdiv in GET_LATTICE and LATTICE_SMOOTH', async () => {
      // Create an open-top revolved cup with 2 mm wall thickness
      const created = await latticeCommands.CREATE_LATTICE({
        name: 'walled_cup',
        ops: [
          { op: 'revolve', profile: [[0, 0, 0], [20, 0, 0], [20, 0, 40]], axis: 'z', segments: 8 },
        ],
        thicknessMm: 2,
      }, makeCtx()) as { ok: boolean; id: string; watertight: boolean; cageWatertight?: boolean };

      expect(created.ok).toBe(true);
      expect(created.cageWatertight).toBe(false);
      expect(created.watertight).toBe(true);

      // GET_LATTICE before smoothing
      const before = await latticeCommands.GET_LATTICE({ targetId: created.id }, makeCtx()) as {
        ok: boolean; watertight: boolean; cageWatertight: boolean; thicknessMm: number; subdiv: number;
      };
      expect(before.ok).toBe(true);
      expect(before.cageWatertight).toBe(false);
      expect(before.watertight).toBe(true);
      expect(before.thicknessMm).toBe(2);
      expect(before.subdiv).toBe(0);

      // Item 4: LATTICE_SMOOTH accepts `subdiv` alias for `level`
      const smoothed = await latticeCommands.LATTICE_SMOOTH({ targetId: created.id, subdiv: 1 }, makeCtx()) as {
        ok: boolean; level: number; subdiv: number; watertight: boolean; cageWatertight: boolean; thicknessMm: number;
      };
      expect(smoothed.ok).toBe(true);
      expect(smoothed.level).toBe(1);
      expect(smoothed.subdiv).toBe(1);
      expect(smoothed.thicknessMm).toBe(2);
      expect(smoothed.cageWatertight).toBe(false);
      expect(smoothed.watertight).toBe(true);

      // GET_LATTICE after smoothing
      const after = await latticeCommands.GET_LATTICE({ targetId: created.id }, makeCtx()) as {
        ok: boolean; watertight: boolean; cageWatertight: boolean; thicknessMm: number; subdiv: number;
      };
      expect(after.ok).toBe(true);
      expect(after.subdiv).toBe(1);
      expect(after.thicknessMm).toBe(2);
      expect(after.cageWatertight).toBe(false);
      expect(after.watertight).toBe(true);
    });

    it('reports thicknessMm: 0 and cageWatertight: true on a plain closed box lattice', async () => {
      const created = await latticeCommands.CREATE_LATTICE({ name: 'plain_box', sizeMm: 40 }, makeCtx()) as {
        ok: boolean; id: string;
      };
      expect(created.ok).toBe(true);

      const info = await latticeCommands.GET_LATTICE({ targetId: created.id }, makeCtx()) as {
        ok: boolean; watertight: boolean; cageWatertight: boolean; thicknessMm: number; subdiv: number;
      };
      expect(info.ok).toBe(true);
      expect(info.watertight).toBe(true);
      expect(info.cageWatertight).toBe(true);
      expect(info.thicknessMm).toBe(0);
      expect(info.subdiv).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Item 3: ADD_HARDWARE rolls back cleanly when fixTo validation fails
  // -------------------------------------------------------------------------
  describe('Item 3: ADD_HARDWARE does not leave orphan bodies when fixTo fails', () => {
    it('leaves sceneGraph unchanged when fixTo is passed for a nut (no moving piece)', async () => {
      const bracket = boxNode('bracket_body', [0, 0, 0.02], [0.03, 0.03, 0.02]);
      useStore.setState({ sceneGraph: { nodes: [bracket] } });

      const res = await objectCommands.ADD_HARDWARE({
        kind: 'nut',
        size: 'M5',
        at: [0, 0, 40],
        partId: 'nut_head_left',
        fixTo: 'bracket_body',
      }, makeCtx()) as { ok: boolean; error?: string; id?: string };

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/no moving piece/i);
      const nodes = useStore.getState().sceneGraph.nodes;
      expect(nodes.map((n) => n.id)).toEqual(['bracket_body']);
    });

    it('leaves sceneGraph unchanged when fixTo names a nonexistent body on a hinge', async () => {
      const panel = boxNode('panel_a', [0, 0, 0.02], [0.05, 0.05, 0.01]);
      useStore.setState({ sceneGraph: { nodes: [panel] } });

      const res = await objectCommands.ADD_HARDWARE({
        kind: 'butt_hinge',
        size: '75mm',
        at: [50, 0, 20],
        partId: 'hinge_orphan_test',
        fixTo: 'does_not_exist',
      }, makeCtx()) as { ok: boolean; error?: string };

      expect(res.ok).toBe(false);
      expect(res.error).toBeTruthy();
      const nodes = useStore.getState().sceneGraph.nodes;
      expect(nodes.map((n) => n.id)).toEqual(['panel_a']);
    });
  });

  // -------------------------------------------------------------------------
  // Item 5: SET_COLOR accepts CSS hex strings (#rrggbb / #rrggbbaa)
  // -------------------------------------------------------------------------
  describe('Item 5: SET_COLOR accepts CSS hex strings in single and batch modes', () => {
    it('applies #rrggbb (preserving existing alpha) and #rrggbbaa in single mode via rgba or color', async () => {
      const b1 = boxNode('b1', [0, 0, 0.02], [0.02, 0.02, 0.02], [0.1, 0.1, 0.1, 0.6]);
      useStore.setState({ sceneGraph: { nodes: [b1] } });

      // 6-digit hex via `rgba` preserves existing alpha (0.6)
      const r1 = await objectCommands.SET_COLOR({ targetId: 'b1', rgba: '#2A9D8F' }, makeCtx()) as { ok: boolean };
      expect(r1.ok).toBe(true);
      const g1 = useStore.getState().sceneGraph.nodes[0].geoms[0].rgba!;
      expect(g1[0]).toBeCloseTo(0x2a / 255, 4);
      expect(g1[1]).toBeCloseTo(0x9d / 255, 4);
      expect(g1[2]).toBeCloseTo(0x8f / 255, 4);
      expect(g1[3]).toBeCloseTo(0.6, 4);

      // 8-digit hex via `color` updates alpha too
      const r2 = await objectCommands.SET_COLOR({ targetId: 'b1', color: '#E76F51CC' }, makeCtx()) as { ok: boolean };
      expect(r2.ok).toBe(true);
      const g2 = useStore.getState().sceneGraph.nodes[0].geoms[0].rgba!;
      expect(g2[0]).toBeCloseTo(0xe7 / 255, 4);
      expect(g2[1]).toBeCloseTo(0x6f / 255, 4);
      expect(g2[2]).toBeCloseTo(0x51 / 255, 4);
      expect(g2[3]).toBeCloseTo(0xcc / 255, 4);
    });

    it('applies CSS hex strings in batch colors array and rejects malformed hex', async () => {
      const b1 = boxNode('b1', [-0.04, 0, 0.02], [0.02, 0.02, 0.02], [0.5, 0.5, 0.5, 0.8]);
      const b2 = boxNode('b2', [0.04, 0, 0.02], [0.02, 0.02, 0.02], [0.5, 0.5, 0.5, 1.0]);
      useStore.setState({ sceneGraph: { nodes: [b1, b2] } });

      const res = await objectCommands.SET_COLOR({
        colors: [
          { id: 'b1', rgba: '#2A9D8F' },
          { id: 'b2', color: '#F4A26180' },
        ],
      }, makeCtx()) as { ok: boolean; bodiesColored: number; geomsColored: number };
      expect(res.ok).toBe(true);
      expect(res.bodiesColored).toBe(2);
      expect(res.geomsColored).toBe(2);

      const n1 = useStore.getState().sceneGraph.nodes[0].geoms[0].rgba!;
      const n2 = useStore.getState().sceneGraph.nodes[1].geoms[0].rgba!;
      expect(n1[0]).toBeCloseTo(0x2a / 255, 4);
      expect(n1[3]).toBeCloseTo(0.8, 4);
      expect(n2[0]).toBeCloseTo(0xf4 / 255, 4);
      expect(n2[3]).toBeCloseTo(0x80 / 255, 4);

      await expect(
        objectCommands.SET_COLOR({ targetId: 'b1', rgba: '#GGGGGG' }, makeCtx()),
      ).rejects.toThrow(/hex/i);
    });
  });

  // -------------------------------------------------------------------------
  // Items 6 & 7: EXPORT_CUT(kind="unfold") omittedTabsHint & splitSheets
  // -------------------------------------------------------------------------
  describe('Items 6 & 7: Unfold omittedTabsHint for corner-blocked tabs & splitSheets', () => {
    const runCut = (msg: Record<string, unknown>, scene: SceneGraph) => {
      useStore.setState({ sceneGraph: scene });
      return cutCommands.EXPORT_CUT(msg, makeCtx()) as Promise<Record<string, unknown>>;
    };

    it('Item 6: clarifies zero-clearance inside corners instead of suggesting < 2 mm tab_width_mm', async () => {
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

      const res = await runCut(
        { kind: 'unfold', sheetMode: 'papercraft', tabWidthMm: 3 },
        crampedScene,
      );
      expect(res.ok).toBe(true);
      const summary = res.summary as {
        omittedTabs: number;
        cornerBlockedTabs?: number;
        omittedTabsHint?: string;
      };
      expect(summary.omittedTabs).toBeGreaterThan(0);
      expect(summary.omittedTabsHint).toBeDefined();
      // Must NOT mechanically suggest an impracticably tiny width like "1.5 mm"
      expect(summary.omittedTabsHint).not.toMatch(/1\.5\s*mm/i);
      // Should mention tight/zero-clearance inside corners or minimum practical width
      expect(summary.omittedTabsHint).toMatch(/corner|minimum practical/i);
    });

    it('Item 7: splitSheets: true emits one standalone .svg file per sheet with valid single-sheet viewBox', async () => {
      const multiColorScene: SceneGraph = {
        nodes: [
          boxNode('teal_box', [-0.05, 0, 0.02], [0.02, 0.02, 0.02], [0.16, 0.62, 0.56, 1]),
          boxNode('coral_box', [0.05, 0, 0.02], [0.02, 0.02, 0.02], [0.91, 0.44, 0.32, 1]),
        ],
      };

      const res = await runCut(
        {
          kind: 'unfold',
          sheetMode: 'papercraft',
          sheet_preset: 'letter',
          group_by_color: true,
          split_sheets: true,
          includeFiles: true,
        },
        multiColorScene,
      );
      expect(res.ok).toBe(true);
      const summary = res.summary as { sheets: number; splitSheets?: boolean };
      expect(summary.sheets).toBe(2);
      expect(summary.splitSheets).toBe(true);

      const files = res.files as Array<{ name: string; base64?: string; bytes: number }>;
      expect(files).toHaveLength(2);
      expect(files[0].name).toMatch(/_sheet_1_.*\.svg$/);
      expect(files[1].name).toMatch(/_sheet_2_.*\.svg$/);
      expect(files[0].name).not.toBe(files[1].name);

      // Decode both SVGs and verify each is a standalone single-sheet Letter SVG (height 279.4mm, not 558.8mm)
      for (let i = 0; i < files.length; i++) {
        expect(files[i].base64).toBeTruthy();
        const svg = Buffer.from(files[i].base64!, 'base64').toString('utf8');
        expect(svg).toMatch(/^<svg /);
        expect(svg).toContain('viewBox="0 0 215.9 279.4"');
        expect(svg).toContain(`Sheet ${i + 1}`);
        expect(svg).toContain('</svg>');
      }
      const svg0 = Buffer.from(files[0].base64!, 'base64').toString('utf8');
      const svg1 = Buffer.from(files[1].base64!, 'base64').toString('utf8');
      expect(svg0).toContain('teal_box');
      expect(svg0).not.toContain('coral_box');
      expect(svg1).toContain('coral_box');
      expect(svg1).not.toContain('teal_box');

      // Invalid splitSheets type is rejected
      const bad = await runCut({ kind: 'unfold', splitSheets: 'yes' }, multiColorScene);
      expect(bad.ok).toBe(false);
      expect(String(bad.error)).toMatch(/splitSheets/i);
    });
  });

  // -------------------------------------------------------------------------
  // Item 8: mcp-docs.json revolve.profile example & inline description limit
  // -------------------------------------------------------------------------
  describe('Item 8: mcp-docs.json revolve.profile example and inline description limit', () => {
    it('includes a 1-line [x,y,z] revolve.profile example and keeps all inline descriptions <= 1700 chars', () => {
      const docsPath = path.resolve(__dirname, '../mcp-docs.json');
      const docs = JSON.parse(fs.readFileSync(docsPath, 'utf8')) as {
        tools: Record<string, string | { summary: string; details?: Record<string, string> }>;
      };

      const createLattice = docs.tools.physics_create_lattice;
      expect(typeof createLattice).toBe('object');
      const oneCallOps = (createLattice as { details?: Record<string, string> }).details?.one_call_ops ?? '';
      expect(oneCallOps).toMatch(/\[\[0,0,0\],\[25,0,0\],\[25,0,80\]\]/);

      for (const [toolName, entry] of Object.entries(docs.tools)) {
        const inlineDesc = typeof entry === 'string' ? entry : entry.summary;
        expect(inlineDesc.length, `${toolName} inline description exceeds 1700 chars`).toBeLessThanOrEqual(1700);
      }
    });
  });
});
