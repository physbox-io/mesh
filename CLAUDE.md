# CLAUDE.md

Working notes for AI agents in this repo. **`GUIDE.md` is the real reference** — architecture, the
mesh geom modes, the control-scripting API, the MuJoCo conventions. Read the relevant section of it
before a non-trivial change. `README.md` describes what the app does for users. This file covers the
things that are easy to get wrong and expensive to discover.

## Commands

| Task | Command |
| --- | --- |
| Dev server | `npm run dev` (Vite, port 5175; the MCP bridge attaches to it) |
| Typecheck | `npm run typecheck` (`tsc -b --noEmit`) — use this, not `npm run build`, while the dev server is up |
| One test file | `npx vitest run tests/<name>.test.ts` |
| Full suite | `npx vitest run` — 70 files, ~2 minutes; run it in the background |
| Lint | `npm run lint` |
| Export presets for the native app | `npm run export:presets` |

CI runs typecheck, lint and the suite on every push to `main` and every PR
(`.github/workflows/test.yml`); a green push to `main` force-pushes that commit
to the `deploy` branch, which is the only thing Cloud Build builds. Anything you
add to the gate has to be one of those three npm scripts.

**`npx tsc --noEmit` checks nothing here.** The root `tsconfig.json` is
`{"files": [], "references": [...]}`, so without `-b` the compiler is handed no inputs,
reports no errors and exits 0 — on any code at all. It has to be `npx tsc -b --noEmit`
(add `--force` to defeat the incremental cache in `node_modules/.tmp`). Note also that
`tsc -b ... | head` reports `head`'s exit status, not the compiler's, so check
`${PIPESTATUS[0]}` or write to a file. This was found on 2026-09-18 after a clean
`tsc --noEmit` passed a file that referenced an undefined variable and crashed the
page at runtime.

## Layout

- `src/store/useStore.ts` — Zustand scene graph; every mutation goes through here.
- `src/utils/mjcf.ts` — compiles the scene graph to MJCF XML. The graph, not the XML, is the source of truth.
- `src/components/scene/SceneLayer.tsx` — renders one geom. Materials and culling live here.
- `src/hooks/useMCPBridge.ts` — every MCP command, mapped to store mutations/selectors.
- `src/workers/` — physics, OpenSCAD, mold and export workers. Anything slow belongs in one.
- `src/utils/*Exporter.ts` — one per fabrication output (STL, laser cut, contour slice, relief carve,
  solid machining, mold, cast pattern). The carve exporters share a `machineSurface()` core.
- `src/presets/` — scene definitions. `presetScenes.ts` holds the `PRESETS` map; large presets get
  their own module.
- `tests/` — Vitest, no browser. Exporters and geometry are tested by asserting on their output.

## Traps

**Mesh face winding is load-bearing, and gets misread as transparency.** Mesh geoms are drawn with
`side={THREE.FrontSide}` and their normals come from the index winding. A backwards triangle is not
drawn at all, so a surface built backwards looks like a *half-transparent body* — you see through its
near face to the inside of its far wall — rather than like a broken mesh. That sends you to `rgba`
and materials, which is the wrong end of the problem. When something looks see-through, sum the
signed volume first (`physics_get_scene_summary` reports it as `windingInverted`). A positive total
only rules out a *uniform* inversion: a mesh with faces both ways can still sum positive, so derive
each triangle's index order from its face's outward direction rather than writing indices in
ascending order. `californiaRelief.ts` shipped inside out this way.

**Two coordinate spaces, and copying index order between them mirrors it.** Three.js is Y-up
(`vertices`); MuJoCo is Z-up (`renderVertices`); `mjcf.ts` swaps Y↔Z on the way out. Builders differ
in which way their rows run — `utils/heightmapMesh.ts` is Z-up with rows running +Y, while
`presets/californiaRelief.ts` is Y-up with rows running −Z — so a quad's winding cannot be copied
from one to the other unchanged. See GUIDE.md § Mesh Geoms Reference.

**Concave shapes collide as convex pieces now, and the source mesh is demoted asymmetrically.**
MuJoCo hulls every mesh geom, so a cup used to be a solid billet. `utils/convexDecomposition.ts`
measures solidity (true volume / hull volume) and sends anything below ~0.92 through V-HACD. The
trap is in `resolveCsgGeoms`: once a body has colliders, a **dynamic** source mesh is dropped from
the model entirely (it draws from the body transform), while a **static** one must stay emitted with
contact zeroed — drop it and `geomId` is -1, the renderer falls back to identity, and the body jumps
to the origin. See GUIDE.md § Concave collision.

**`rgba`'s alpha hides nothing from the physics.** Alpha below 1 draws a geom translucent
(`SceneLayer.tsx`, depthWrite off), and 0 draws nothing, but the geom still collides and has mass.
To get rid of something, delete it.

**Some presets are generated, and the generator owns the code too.** `scripts/gen_california_relief.py`
emits `src/presets/californiaRelief.ts` — and carries that module's *TypeScript builder* as its output
template, not just the data. A fix to the preset must land in the script as well, or the next run
reverts it. Check for a "Regenerated by scripts/..." banner before editing any preset by hand.

**Two analysis engines, and only one of them is testable.** `utils/dfm.ts` (the
DFM overlay) is pure: a `SceneGraph` in, numbers out, no store. The
older `utils/printAnalysis.ts` imports `useStore` at module scope and reads live
MuJoCo state, so it only runs on the main thread — its tests pass only because a
default store has no model loaded. New analysis belongs in `dfm.ts`. See GUIDE.md § DFM.

**Body and geom names are made unique for you, and not always to what you wrote.** The
viewport finds MuJoCo bodies and geoms by the graph's names, so a clash used to draw one body
at another's transform. `utils/uniqueNames.ts` now renames the later of any clash to
`name_2`, `name_3` … — in the store's `set` middleware *and* in `mjcf.ts`, by the same rule, so
both agree. Look a geom up by its owning body and name (`sceneTree.patchGeom`), not by name
across the whole tree, and don't write `sceneGraph` through `useStore.setState`, which
skips the middleware.

**Several things must be edited in more than one place:**

- A new preset: only the `PRESETS` map in `presets/presetScenes.ts` — the header dropdown
  is built from it.
- MCP docs: `mcp-docs.json` here (the server loads it from `~/mesh/` at import) *and* the standalone
  fallback at `physbox_mcp/physbox_mcp/mcp-docs/physics.json`. A new command also needs a handler in
  `useMCPBridge.ts`. **The MCP server must be restarted before any of it takes effect.**
- The in-app copilot has its own prompt, `src/components/systemInstructions.txt`, which does not read
  `mcp-docs.json`. Guidance for agents usually belongs in both.
- Presets are also consumed by a native desktop app via `npm run export:presets`, which keeps a golden
  MJCF XML per preset so the TypeScript and C++ compilers cannot drift.

## Working here

- Do not run automated browser tests during a pair-programming session; present UI changes for manual
  approval instead (GUIDE.md § Conventions).
- Presets use real mechanics — no floating pegs or visual-only joints — and the engine stays generic:
  no preset-specific flags in `useStore.ts` or `App.tsx`.
- Other agents commit to this repo concurrently. Stage explicit paths, never `git add -A`, and leave
  changes you did not make alone.
