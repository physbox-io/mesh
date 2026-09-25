// Where the copilot reaches the model providers.
//
// The Vite dev server proxies /api/anthropic and /api/gemini (vite.config.ts).
// Production has no such proxy: nginx answers every unknown path with
// index.html, so a proxied call came back as a 405 HTML page and the copilot
// failed on "Unexpected token '<'". Outside dev, call the providers directly;
// both accept browser requests (Anthropic with the direct-access header).

const PROXIED = import.meta.env.DEV;

export const anthropicUrl = (path: string): string =>
  PROXIED ? `/api/anthropic${path}` : `https://api.anthropic.com${path}`;

export const geminiUrl = (path: string): string =>
  PROXIED ? `/api/gemini${path}` : `https://generativelanguage.googleapis.com${path}`;
