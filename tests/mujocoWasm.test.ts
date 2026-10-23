import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// scripts/optimize-mujoco-wasm.mjs re-inlines the MuJoCo wasm on install, and
// the image ships that binary, so CI has to have tested it rather than the
// stock one. Only in CI: a worktree that has not reinstalled since the script
// landed still holds the stock wasm, which works, just slower.
describe.runIf(process.env.CI)('MuJoCo wasm', () => {
  it('is the re-inlined build', () => {
    const wasm = createRequire(import.meta.url).resolve('@mujoco/mujoco/mujoco.wasm');
    const stamp = `${wasm}.optimized`;
    expect(existsSync(stamp), 'postinstall did not run: no mujoco.wasm.optimized').toBe(true);
    const hash = createHash('sha256').update(readFileSync(wasm)).digest('hex');
    expect(hash).toBe(JSON.parse(readFileSync(stamp, 'utf8')).output);
  });
});
