import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';

const costCache = new Map<string, number>();

/**
 * Cold-cache runtime estimate (ms-scale) for CI and fresh worktrees, where
 * Vitest's default BaseSequencer falls back to source file byte size and puts
 * tiny multi-minute simulation loops (`clothCrossings`, `garmentsDrape*`) last.
 */
function coldCostEstimate(moduleId: string): number {
  const cached = costCache.get(moduleId);
  if (cached !== undefined) return cached;
  let score = 0;
  try {
    const src = fs.readFileSync(moduleId, 'utf8');
    score += src.length;
    const hasLoop = /\bit\.each\b|\bfor\s*\(\s*const\b/.test(src);
    let timeoutSum = 0;
    for (const m of src.matchAll(/\},\s*([\d_]+)\s*\)/g)) {
      const ms = Number(m[1].replaceAll('_', ''));
      if (Number.isFinite(ms) && ms >= 15_000) timeoutSum += ms;
    }
    score += timeoutSum * (hasLoop ? 1.0 : 0.35);
    if (src.includes('clothSimHarness')) score += hasLoop ? 300_000 : 90_000;
    if (src.includes('reliefCarveExporter') || src.includes('solidMachining') || src.includes('cutSimulation')) score += 70_000;
    if (src.includes('moldLiner') || src.includes('slipCast') || src.includes('pourBox')) score += 60_000;
    if (src.includes('utils/cloth/garment')) score += 50_000;
    if (src.includes('@mujoco/mujoco') || src.includes('manifold-3d') || src.includes('vhacd')) score += 20_000;
  } catch {
    score = 10_000;
  }
  costCache.set(moduleId, score);
  return score;
}

class SlowFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const cache = this.ctx.cache;
    const root = this.ctx.config.root;
    return [...files].sort((a, b) => {
      const groupOrderDiff = a.project.config.sequence.groupOrder - b.project.config.sequence.groupOrder;
      if (groupOrderDiff !== 0) return groupOrderDiff;
      if (a.project.name !== b.project.name) return a.project.name < b.project.name ? -1 : 1;
      const keyA = `${a.project.name}:${path.relative(root, a.moduleId)}`;
      const keyB = `${b.project.name}:${path.relative(root, b.moduleId)}`;
      const aState = cache.getFileTestResults(keyA);
      const bState = cache.getFileTestResults(keyB);
      if (aState && bState) {
        if (aState.failed && !bState.failed) return -1;
        if (!aState.failed && bState.failed) return 1;
        return bState.duration - aState.duration;
      }
      return coldCostEstimate(b.moduleId) - coldCostEstimate(a.moduleId);
    });
  }
}

function defaultMaxWorkers(): number {
  const envOverride = Number(process.env.VITEST_MAX_WORKERS);
  if (Number.isFinite(envOverride) && envOverride >= 1) return Math.floor(envOverride);
  const cpus = os.availableParallelism();
  if (process.env.CI) return Math.max(1, Math.min(4, cpus));
  // Each file gets its own worker process so MuJoCo's wasm heap (up to 2 GB)
  // never accumulates across files; cap by both ~2.2 GB/worker RAM and cores.
  const byMem = Math.floor(os.totalmem() / (2.2 * 1024 ** 3));
  return Math.max(2, Math.min(8, cpus - 2, byMem));
}

// Unit tests for the pure logic in src/utils — geometry, the OpenSCAD emitter,
// the MJCF builder. They run in plain Node with no DOM: nothing under test
// touches the browser, which is why src/utils/csg.ts imports ./openscad lazily
// rather than at module scope (a static import pulls in the Zustand store, the
// physics worker client and the MuJoCo wasm glue).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // The preset behaviour tests load the MuJoCo wasm module and simulate tens of
    // seconds of physics, which is slower than vitest's 5s default allows.
    testTimeout: 60000,
    hookTimeout: 60000,
    fileParallelism: true,
    maxWorkers: defaultMaxWorkers(),
    sequence: {
      sequencer: SlowFirstSequencer,
    },
  },
});
