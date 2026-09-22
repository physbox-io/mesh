# V-HACD (vendored)

Approximate convex decomposition, used by `src/utils/convexDecomposition.ts` to
give concave bodies real collision. See that module for why.

| | |
| --- | --- |
| Upstream | [`vhacd-js`](https://www.npmjs.com/package/vhacd-js) v0.0.1 — an Emscripten build of [kmammou/v-hacd](https://github.com/kmammou/v-hacd) |
| License | BSD-3-Clause (`LICENSE` here, copied from the package) |
| Vendored | 2026-09-20 |

## Why vendored rather than depended on

`vhacd-js` is at 0.0.1, has a single publisher, and its own README imports it
under a name it is not published as. It also unpacks to 42 MB, nearly all of it
C++ sources, test `.obj` meshes and a checked-in `TestVHACD.exe` — none of which
this app needs. Only the five files here are used, and pinning them means a
republish upstream cannot change what runs in a physics build.

## What was copied, and the one change made

From the package's `lib/`: `vhacd.js`, `vhacd.d.ts`, `vhacd-wasm.js`,
`vhacd-wasm-api.js`, `vhacd-wasm-api.d.ts`.

The package splits these across two directories, so `vhacd.js`'s
`import "../lib/vhacd-wasm.js"` was rewritten to `"./vhacd-wasm.js"`. Dangling
`sourceMappingURL` comments were dropped with the maps they pointed at. Nothing
else was touched.

## Why there is no .wasm file here

`vhacd-wasm.js` is a single-file Emscripten build: the binary is embedded as a
base64 data URL. So there is no asset to bundle, no `?url` import, no entry in
`optimizeDeps.exclude`, and — the part that matters for the tests — it loads in
plain Node as readily as in a browser, which is what lets
`tests/vhacdDecompose.test.ts` run the real decomposer without a Worker.

## Updating it

Re-run the copy, re-apply the import rewrite, and run
`npx vitest run tests/vhacdDecompose.test.ts tests/concaveCollision.test.ts`.
The first asserts the decomposer still leaves a cup's cavity empty; the second
asserts MuJoCo still agrees.
