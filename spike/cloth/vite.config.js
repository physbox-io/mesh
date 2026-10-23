import { defineConfig } from 'vite';

export default defineConfig({
  // MuJoCo finds its .wasm by import.meta.url; pre-bundling breaks that.
  optimizeDeps: { exclude: ['@mujoco/mujoco'] },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
