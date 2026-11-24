import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { runPictureToPart, type PartLoopDeps } from '../src/utils/pictureToPart';
import { bestViewOffThread } from '../src/utils/silhouetteClient';
import { normalizeMask } from '../src/utils/silhouette';
import { settle, fitOutlineCanvas, MAX_OUTLINE_CANVAS_SIDE } from '../src/components/copilot/usePictureToPart';
import type { RawNode } from '../src/utils/sceneNodes';

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const c = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 1, 2, 3], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
  const out: number[] = [];
  for (const [a, b, cc, d] of quads) out.push(...c[a], ...c[b], ...c[cc], ...c[a], ...c[cc], ...c[d]);
  return out;
}

const SAMPLE_TRIS = [...box(0, 0, 0, 0.02, 0.01, 0.1), ...box(0.02, 0, 0, 0.08, 0.01, 0.02)];
const SAMPLE_MASK = normalizeMask(
  (() => {
    const m = new Uint8Array(100 * 100);
    for (let y = 10; y < 90; y++) {
      for (let x = 10; x < 30; x++) m[y * 100 + x] = 1;
    }
    for (let y = 70; y < 90; y++) {
      for (let x = 30; x < 90; x++) m[y * 100 + x] = 1;
    }
    return m;
  })(),
  100,
  100,
)!;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Section 6B: Picture-to-Part external-edit guard & finish("stopped")', () => {
  it('aborts cleanly without calling apply or render when sceneChanged() trips between rounds', async () => {
    let externalEdit = false;
    let current: RawNode[] = [];
    const applied: RawNode[][] = [];
    let renderCalls = 0;
    let b = 0;

    const deps: PartLoopDeps = {
      async llm(system) {
        if (system.startsWith('You are an inspector')) {
          return { text: '```json\n{"differences":["add hole"],"match":7}\n```', truncated: false };
        }
        b++;
        if (b === 2) externalEdit = true;
        return {
          text: '```json\n' + JSON.stringify({ nodes: [{ id: `part_${b}`, name: `part_${b}` }], view: { azimuthDeg: 0, elevationDeg: 0 } }) + '\n```',
          truncated: false,
        };
      },
      async apply(nodes) {
        current = nodes;
        applied.push(nodes);
        return { ok: true };
      },
      sceneChanged: () => externalEdit,
      partNodes: () => current,
      partTriangles: () => SAMPLE_TRIS,
      render: async () => {
        renderCalls++;
        return { mediaType: 'image/jpeg', data: 'R' };
      },
    };

    const r = await runPictureToPart(
      { request: 'build', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: null, sceneSystem: 'S' },
      deps,
    );
    expect(r.stoppedBecause).toBe('stopped');
    expect(applied).toHaveLength(1);
    // Only round 1 rendered; finish('stopped') did NOT flash a final render.
    expect(renderCalls).toBe(1);
  });

  it('does not roll back best.nodes in finish("stopped") if user edited the scene mid-round', async () => {
    let externalEdit = false;
    let current: RawNode[] = [];
    const applied: RawNode[][] = [];
    let b = 0;

    const deps: PartLoopDeps = {
      async llm(system) {
        if (system.startsWith('You are an inspector')) {
          if (b === 2) externalEdit = true;
          return { text: '```json\n{"differences":["still off"],"match":4}\n```', truncated: false };
        }
        b++;
        return {
          text: '```json\n' + JSON.stringify({ nodes: [{ id: `part_${b}`, name: `part_${b}` }], view: { azimuthDeg: 0, elevationDeg: 0 } }) + '\n```',
          truncated: false,
        };
      },
      async apply(nodes) {
        current = nodes;
        applied.push(nodes);
        return { ok: true };
      },
      sceneChanged: () => externalEdit,
      partNodes: () => current,
      partTriangles: () => SAMPLE_TRIS,
      render: async () => ({ mediaType: 'image/jpeg', data: 'R' }),
    };

    const r = await runPictureToPart(
      { request: 'build', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: null, sceneSystem: 'S' },
      deps,
    );
    expect(r.stoppedBecause).toBe('stopped');
    // Round 1 apply + Round 2 apply; NO 3rd rollback apply after externalEdit became true.
    expect(applied).toHaveLength(2);
    expect(applied[1][0].id).toBe('part_2');
  });

  it('skips final deps.render(best.view) on finish("stopped")', async () => {
    const ctl = new AbortController();
    let renderCalls = 0;
    const deps: PartLoopDeps = {
      async llm(system) {
        if (system.startsWith('You are an inspector')) {
          return { text: '```json\n{"differences":["x"],"match":7}\n```', truncated: false };
        }
        return {
          text: '```json\n{"nodes":[{"id":"p","name":"p"}],"view":{"azimuthDeg":0,"elevationDeg":0}}\n```',
          truncated: false,
        };
      },
      apply: async () => ({ ok: true }),
      partNodes: () => [{ id: 'p', name: 'p' }],
      partTriangles: () => SAMPLE_TRIS,
      render: async () => {
        renderCalls++;
        return { mediaType: 'image/jpeg', data: 'R' };
      },
      onProgress: (p) => {
        if (p.round === 2 && p.stage === 'revising') ctl.abort();
      },
      signal: ctl.signal,
    };

    const r = await runPictureToPart(
      { request: 'build', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: null, sceneSystem: 'S' },
      deps,
    );
    expect(r.stoppedBecause).toBe('stopped');
    expect(renderCalls).toBe(1);
  });
});

describe('Section 6B: SCORE_EPS (0.02) rollback threshold', () => {
  it('does not roll back a tiny score drop within SCORE_EPS (0.02), but rolls back a drop > 0.02', async () => {
    let roundIdx = 0;
    const ious = [0.80, 0.79, 0.75];
    const applied: RawNode[][] = [];
    let current: RawNode[] = [];

    const deps: PartLoopDeps = {
      async llm(system) {
        if (system.startsWith('You are an inspector')) {
          return { text: '```json\n{"differences":["refine chamfer"],"match":8}\n```', truncated: false };
        }
        roundIdx++;
        return {
          text: '```json\n' + JSON.stringify({ nodes: [{ id: `r${roundIdx}`, name: `r${roundIdx}` }], view: { azimuthDeg: 0, elevationDeg: 0 } }) + '\n```',
          truncated: false,
        };
      },
      async apply(nodes) {
        current = nodes;
        applied.push(nodes);
        return { ok: true };
      },
      partNodes: () => current,
      partTriangles: () => SAMPLE_TRIS,
      render: async () => ({ mediaType: 'image/jpeg', data: 'R' }),
      bestView: async () => ({ azimuthDeg: 0, elevationDeg: 0, iou: ious[Math.min(roundIdx - 1, ious.length - 1)] }),
    };

    const r = await runPictureToPart(
      { request: 'build', photos: [{ mediaType: 'image/jpeg', data: 'P' }], photoMask: SAMPLE_MASK, sceneSystem: 'S', maxRounds: 5 },
      deps,
    );
    // Round 1: 0.80 (kept)
    // Round 2: 0.79 (within 0.02 of 0.80 -> NOT rolled back, stale=1, becomes best)
    // Round 3: 0.75 (< 0.79 - 0.02 = 0.77 -> rolled back to r2, stale=2 -> stops with no improvement)
    expect(r.rounds).toHaveLength(3);
    expect(r.rounds[1].rolledBack).toBe(false);
    expect(r.rounds[2].rolledBack).toBe(true);
    expect(r.bestRound).toBe(2);
    expect(r.stoppedBecause).toBe('no improvement');
    expect(applied[applied.length - 1][0].id).toBe('r2');
  });
});

describe('Section 6B: fitOutlineCanvas bounds', () => {
  it('fits extreme 1:50 and 50:1 aspect parts into <= 256 px preserving aspect', () => {
    const tall = fitOutlineCanvas(400, 20_000)!;
    expect(tall.height).toBeLessThanOrEqual(MAX_OUTLINE_CANVAS_SIDE);
    expect(tall.width).toBeLessThanOrEqual(MAX_OUTLINE_CANVAS_SIDE);
    expect(tall.height).toBe(MAX_OUTLINE_CANVAS_SIDE);
    expect(tall.width).toBeGreaterThanOrEqual(4);
    expect(tall.width).toBeLessThan(20);

    const wide = fitOutlineCanvas(20_000, 400)!;
    expect(wide.width).toBe(MAX_OUTLINE_CANVAS_SIDE);
    expect(wide.height).toBeLessThan(20);

    expect(fitOutlineCanvas(0, 100)).toBeNull();
    expect(fitOutlineCanvas(-10, 100)).toBeNull();
    expect(fitOutlineCanvas(NaN, 100)).toBeNull();
  });
});

describe('Section 6B: settle() and bestViewOffThread() instant abort', () => {
  it('settle() returns immediately if signal is already aborted without scheduling rAF', async () => {
    const raf = vi.fn(() => 42);
    const caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);

    const ctl = new AbortController();
    ctl.abort();
    await settle(3, ctl.signal);
    expect(raf).not.toHaveBeenCalled();
  });

  it('settle() cancels pending requestAnimationFrame when aborted mid-wait', async () => {
    const raf = vi.fn(() => 99);
    const caf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', caf);

    const ctl = new AbortController();
    const p = settle(3, ctl.signal);
    expect(raf).toHaveBeenCalledTimes(1);
    ctl.abort();
    await p;
    expect(caf).toHaveBeenCalledWith(99);
  });

  it('bestViewOffThread() resolves null immediately when already aborted', async () => {
    const ctl = new AbortController();
    ctl.abort();
    const res = await bestViewOffThread(SAMPLE_TRIS, SAMPLE_MASK, undefined, ctl.signal);
    expect(res).toBeNull();
  });

  it('bestViewOffThread() terminates wedged worker and resolves null promptly on abort', async () => {
    const terminated: number[] = [];
    let instances = 0;

    class FakeWorker {
      id = ++instances;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onmessageerror: (() => void) | null = null;
      postMessage(req: { id: number }) {
        // First worker hangs forever; second worker answers immediately.
        if (this.id > 1) {
          queueMicrotask(() => {
            this.onmessage?.({
              data: { type: 'BEST_VIEW_DONE', id: req.id, match: { azimuthDeg: 15, elevationDeg: 10, iou: 0.92 } },
            } as MessageEvent);
          });
        }
      }
      terminate() {
        terminated.push(this.id);
      }
    }

    vi.stubGlobal('Worker', FakeWorker);

    const ctl1 = new AbortController();
    const ctl2 = new AbortController();
    const p1 = bestViewOffThread(SAMPLE_TRIS, SAMPLE_MASK, undefined, ctl1.signal);
    const p2 = bestViewOffThread(SAMPLE_TRIS, SAMPLE_MASK, undefined, ctl2.signal);
    // Abort queued p2 first: should resolve null without terminating worker 1.
    ctl2.abort();
    expect(await p2).toBeNull();
    expect(terminated).toEqual([]);

    // Now abort active p1: should terminate worker 1 and resolve null promptly.
    ctl1.abort();
    expect(await p1).toBeNull();
    expect(terminated).toEqual([1]);

    // Subsequent job spawns a fresh worker and succeeds.
    const p3 = bestViewOffThread(SAMPLE_TRIS, SAMPLE_MASK);
    expect(await p3).toEqual({ azimuthDeg: 15, elevationDeg: 10, iou: 0.92 });
  });
});

describe('Section 6B: usePictureToPart wiring invariants', () => {
  const hookSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/copilot/usePictureToPart.ts'),
    'utf8',
  );

  it('does not import or call compileSCAD directly (relies on settleScene scadErrors)', () => {
    expect(hookSrc).not.toMatch(/compileSCAD/);
    expect(hookSrc).toMatch(/res\.scadErrors/);
  });

  it('gates photoOutline with usablePhotoMask before normalizeMask', () => {
    const usableIdx = hookSrc.indexOf('usablePhotoMask(');
    const normIdx = hookSrc.indexOf('normalizeMask(');
    expect(usableIdx).toBeGreaterThan(-1);
    expect(normIdx).toBeGreaterThan(usableIdx);
  });

  it('guards run() re-entrancy and cleans round-1 scene via replacesScene', () => {
    expect(hookSrc).toMatch(/abort\.current\?\.abort\(\)/);
    expect(hookSrc).toMatch(/if\s*\(\s*abort\.current\s*===\s*ctl\s*\)/);
    expect(hookSrc).toMatch(/replacesScene/);
    expect(hookSrc).toMatch(/expectedNodes/);
  });
});

describe('Section 6B: systemInstructions.txt schema parity & cleanup', () => {
  const promptText = fs.readFileSync(
    path.resolve(process.cwd(), 'src/components/systemInstructions.txt'),
    'utf8',
  );

  it('documents hydrostatics, flexures/mechanisms, sand flask height, cloth overrides, piercing/deformCollision, curves/composites/static', () => {
    expect(promptText).toContain('waterFill');
    expect(promptText).toContain('waterLevel');
    expect(promptText).toContain('flexure:');
    expect(promptText).toContain('bend:');
    expect(promptText).toContain('physics_build_mechanism');
    expect(promptText).toContain('cope_drag_height_mm');
    expect(promptText).toContain('copeDragHeightMm');
    expect(promptText).toContain('materialOverrides');
    expect(promptText).toContain('bendFactor');
    expect(promptText).toContain('pierceImpulseNs');
    expect(promptText).toContain('deformCollision');
    expect(promptText).toContain('isCurve');
    expect(promptText).toContain('curvePoints');
    expect(promptText).toContain('isComposite');
    expect(promptText).toContain('weldLastToId');
    expect(promptText).toContain('static: true');
  });

  it('has a single merged initialVelocity entry in SCENEJOINT SCHEMA', () => {
    const start = promptText.indexOf('SCENEJOINT SCHEMA');
    const end = promptText.indexOf('CONTROL SCRIPT API', start);
    const jointSection = promptText.slice(start, end);
    const matches = jointSection.match(/^\s*initialVelocity:/gm) ?? [];
    expect(matches).toHaveLength(1);
  });
});
