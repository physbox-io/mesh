import { defineConfig } from 'vitest/config';

// Unit tests for the pure logic in src/utils — geometry, the OpenSCAD emitter,
// the MJCF builder. They run in plain Node with no DOM: nothing under test
// touches the browser, which is why src/utils/csg.ts imports ./openscad lazily
// rather than at module scope (a static import pulls in the Zustand store, the
// physics worker client and the MuJoCo wasm glue).
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // The preset behaviour tests load the MuJoCo wasm module and simulate tens of
    // seconds of physics, which is slower than vitest's 5s default allows.
    testTimeout: 60000,
    hookTimeout: 60000,
    // One process for the whole run: MuJoCo's wasm heap only ever grows (it has a
    // hard 2GB ceiling), and each worker would pay the module load again.
    fileParallelism: false,
  },
});
