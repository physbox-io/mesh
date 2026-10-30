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
| Full suite | `npx vitest run` — 110+ files, several minutes; run it in the background |
| Lint | `npm run lint` |
| Export presets for the native app | `npm run export:presets` |

CI runs typecheck, lint, the suite and a production build (`npm run build:image`)
on every push to `main` and every PR (`.github/workflows/test.yml`); a green push
to `main` force-pushes that commit to the `deploy` branch, which is the only thing
Cloud Build builds. Anything you add to the gate has to be one of those npm
scripts. The build step is there because nothing else bundles: twice a
worker-bundling error passed CI and failed every Cloud Build for days. Green CI
is still not a deploy - check `gcloud builds list` after a push to `main`.

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
- `src/workers/` — physics, OpenSCAD, mold, export, fracture, sculpt-cut and V-HACD workers. Anything
  slow belongs in one.
- `src/utils/*Exporter.ts` — one per fabrication output (G-code, 3MF, laser cut, contour slice, relief
  carve, solid machining, mold, cast pattern); STL and 3MF go through `hooks/useMeshExport.tsx`.
  Solid machining reuses `machineSurface()` from `reliefCarveExporter.ts`.
- `src/presets/` — scene definitions. `presetScenes.ts` holds the `PRESETS` map; large presets get
  their own module.
- `tests/` — Vitest, no browser. Exporters and geometry are tested by asserting on their output.

## Traps

**Mesh face winding is load-bearing, and gets misread as transparency.** Mesh geoms are drawn with
`side={THREE.FrontSide}` and their normals come from the index winding. A backwards triangle is not
drawn at all, so a surface built backwards looks like a *half-transparent body* — you see through its
near face to the inside of its far wall — rather than like a broken mesh. That sends you to `rgba`
and materials, which is the wrong end of the problem. When something looks see-through, check the
winding first: `physics_get_scene_summary` reports `windingInverted` (negative signed volume) and
`windingMixed` (faces wound both ways, which a positive total does not rule out). Derive
each triangle's index order from its face's outward direction rather than writing indices in
ascending order. `californiaRelief.ts` shipped inside out this way.

**Two coordinate spaces, and builders whose rows run opposite ways.** Three.js is Y-up
(`vertices`); MuJoCo is Z-up (`renderVertices`); `mjcf.ts` rotates one into the other,
`(x,y,z)→(x,−z,y)`, which keeps winding. The trap is the builders: `utils/heightmapMesh.ts` is Z-up
with rows running −Y (+Z once converted), while `presets/californiaRelief.ts` is Y-up with rows
running −Z — so a quad's winding cannot be copied from one to the other unchanged. See GUIDE.md § Mesh Geoms Reference.

**Concave shapes collide as convex pieces now, and the source mesh is demoted asymmetrically.**
MuJoCo hulls every mesh geom, so a cup used to be a solid billet. `utils/convexDecomposition.ts`
measures solidity (true volume / hull volume) and sends anything below ~0.92 through V-HACD. The
trap is in `resolveCsgGeoms`: once a body has colliders, the source mesh stays emitted with contact
zeroed and carries the body's mass (exact inertia; the pieces are massless), unless MuJoCo cannot
weigh it exactly — then a **dynamic** one is dropped (it draws from the body transform) while a
**static** one must still stay, massless — drop it and `geomId` is -1, the renderer falls back to
identity, and the body jumps to the origin. See GUIDE.md § Concave collision.

**A safe toolpath can still waste the afternoon.** The carve tests mostly check safety: no rapid
through stock, no gouge, no dive. Twice a roughing pass passed all of them and went to the machine
while leaving most of the material to the small finishing bit, and hopping across the stock between
pockets. `tests/reliefPathEfficiency.test.ts` measures what roughing leaves, what share of the
material it removes, and how far it flies between cuts, against figures taken on the old and new
paths. Finishing had the same fault (runs cut in scan order, a lift and a flight between every
two), and the same file now measures its lifts and air travel. Any change to roughing or
finishing order in `reliefCarveExporter.ts` (which also drives solid machining through
`machineSurface()`) has to keep it green. Don't loosen a bound without
a measurement.

**`rgba`'s alpha hides nothing from the physics.** Alpha below 1 draws a geom translucent
(`SceneLayer.tsx`, depthWrite off), and 0 draws nothing, but the geom still collides and has mass.
To get rid of something, delete it.

**Some presets are generated, and the generator owns the code too.** `scripts/gen_california_relief.py`
emits `src/presets/californiaRelief.ts` — and carries that module's *TypeScript builder* as its output
template, not just the data. A fix to the preset must land in the script as well, or the next run
reverts it. Check for a "Regenerated by scripts/..." banner before editing any preset by hand.

**The DFM analyses run on a worker; keep them store-free.** `utils/dfm.ts` and the
older `utils/printAnalysis.ts` (structural weak spots) both run in
`workers/dfmWorker.ts`, and the views read them through
`utils/dfmWorkerClient.ts`. A `useStore` import anywhere under either pulls the
store into the worker bundle. New analysis belongs in `dfm.ts`. See GUIDE.md § DFM.

**Body and geom names are made unique for you, and not always to what you wrote.** The
viewport finds MuJoCo bodies and geoms by the graph's names, so a clash used to draw one body
at another's transform. `utils/uniqueNames.ts` now renames the later of any clash to
`name_2`, `name_3` … — in the store's `set` middleware *and* in `mjcf.ts`, by the same rule, so
both agree. Look a geom up by its owning body and name (`sceneTree.patchGeom`), not by name
across the whole tree, and don't write `sceneGraph` through `useStore.setState`, which
skips the middleware.

**`updateScene` replaces the whole graph.** `updateScene({ nodes })` drops everything the scene
says about itself — `simFidelity`, `castPrep`, `referenceImages`, its `name`. Anything that only
changes the bodies passes `{ ...sceneGraph, nodes }`; only building a new scene starts clean.

**Several things must be edited in more than one place:**

- A new preset: the `PRESETS` map in `presets/presetScenes.ts`, and a shelf for it in
  `PRESET_SHELF` (`utils/sceneCatalog.ts`) — the scene browser (`components/files/`) is built
  from both, and `tests/sceneCatalog.test.ts` fails for a preset with no shelf.
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
