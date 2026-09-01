import { defineConfig, type Plugin } from 'vite'
import type { Connect } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { mcpBridgePlugin } from './vite-plugin-mcp-bridge'


/**
 * Serves the sign-in page without the isolation headers.
 *
 * Everything else gets `Cross-Origin-Opener-Policy: same-origin`, which is what
 * earns `SharedArrayBuffer` for the physics worker — and which severs
 * `window.opener` for Google's sign-in popup, leaving it blank. `public/signin.html`
 * is the one document that needs the opposite, so it is the one document that
 * gets it. See the comment at the top of that file.
 *
 * Vite's `server.headers` applies to every response, so the exception has to be
 * a middleware that runs after them and strips them back off.
 */
function signInWithoutIsolation(): Plugin {
  const strip = (server: { middlewares: Connect.Server }) => {
    /*
     * Intercepts the header rather than trying to unset it afterwards.
     *
     * Two earlier attempts failed for the same reason: ordering. `server.headers`
     * is applied by one of Vite's own middlewares, and the static handler that
     * serves `public/signin.html` ends the chain before anything registered
     * after it runs. So there is no position in the stack that reliably sees the
     * response with the headers already on it and still gets to change them.
     *
     * Patching `setHeader` for this one path sidesteps the question: whenever
     * anything downstream tries to set the isolation headers on this request,
     * the call is simply dropped.
     */
    server.middlewares.use((req, res, next) => {
      if (req.url && req.url.split('?')[0] === '/signin.html') {
        const original = res.setHeader.bind(res);
        res.setHeader = ((name: string, value: never) => {
          if (/^cross-origin-(opener|embedder)-policy$/i.test(name)) return res;
          return original(name, value);
        }) as typeof res.setHeader;
      }
      next();
    });
  };

  return {
    name: 'signin-without-isolation',
    configureServer: strip,
    configurePreviewServer: strip,
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), mcpBridgePlugin(), signInWithoutIsolation()],
  server: {
    port: 5175,
    strictPort: true,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
      },
      '/api/gemini': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gemini/, ''),
      }
    }
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/anthropic/, ''),
      },
      '/api/gemini': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gemini/, ''),
      }
    }
  },
  optimizeDeps: {
    exclude: ['@mujoco/mujoco']
  }
})
