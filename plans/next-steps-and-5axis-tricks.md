# Plan: Remaining Backlog & 3-Axis CNC Software Tricks Toward 5-Axis

Generated: 2026-10-21 (following commit `19c52ad`)

## Status of Recently Completed Work
- **Multi-Face Solid Machining & Worker Memoisation (`fa8a1f8`)**:
  - `collectSceneTriangles`, `castColumnSpans`, `voxelize`, `planSetups`, `orientPart`, `placeInStock`, `sampleColumns`, `toSetupTris`, and `placeAndSample` are memoised via `WeakMap` so changing feeds/RPM/safeZ/stepdowns does not recompute geometry.
  - `analyseCnc` in `src/utils/dfm.ts` grades overhangs by underside (`-Z`, `0.6`) vs side-setup (`±X, ±Y`, `0.8`) vs completely enclosed (`1.0`) reachability and points the user to `Setups: Auto`.
- **Mold Cast Simulation & Optimal Mold Axis (`b948f28`, `fa8a1f8`, `19c52ad`)**:
  - `ExportMoldModal.tsx` now includes a **Cast Part** 3D preview tab with a **Trim sprue & vents** toggle, live cast volume readout, **Simulate Cast** scene insertion, and inverted surface texture transfer (`setGeomTextures`).
  - `moldExporter.ts` picks the best parting axis and simplest mold type automatically.
- **Shared GRBL Machine Migration (`bbcacc5`, `e29c1c7`)**:
  - `src/utils/webSerialManager.ts` is on `GrblMachine` (`@physbox-io/machining ^0.5.5`). (Note: the old local branch `feat/machining-migration` at `93328e4` is superseded by `main` and can be deleted once verified.)

---

## Part 1: Remaining Core Backlog

### 1. Timber Joinery Breakdown Modal & Scene/Export Integration
**Current state:**
- `src/utils/timberBreakdown.ts` (1,073 lines) and `tests/timberBreakdown.test.ts` (16 tests) implement hollow-shell decomposition of large solids into machinable timber planks with interlocking rabbet, miter, finger/box, or butt joints, alignment dowel holes, and glued-assembly explosion vectors.
- Currently it is only reachable via headless code/tests — there is no UI modal or MCP command.

**Tasks:**
1. **`src/components/ExportTimberBreakdownModal.tsx`**:
   - 3D WebGL preview with an **Assembled ↔ Exploded** slider (using `plank.explodedOffsetMm`) and a **Plank Lay-Flat Sheet** view.
   - Controls for `boardThicknessMm`, `maxBoardWidthMm`, `maxBoardLengthMm`, `jointType` (`rabbet` | `miter` | `finger` | `butt`), `fingerWidthMm`, `dowelDiaMm`, `wallThicknessMm`, and `hollowInterior`.
   - Per-plank bill of materials (dimensions, grain axis, volume, joint summary).
   - Actions:
     - **Split into Scene Bodies**: replaces or places beside the target body the individual timber planks as scene nodes so each plank can be sent to **Solid Machining** or **Laser / Router Cut**.
     - **Machine Selected Plank**: hands a chosen plank straight to `ExportSolidMachiningModal`.
     - **Download All Planks (STL / ZIP)**.
2. **MCP Endpoint (`physics_timber_breakdown`)**:
   - Wire into `src/hooks/useMCPBridge.ts` and `mcp-docs.json` so agents can decompose oversized architectural/furniture solids into millable boards.

---

### 2. Multi-Face Setup Registration: 90°-Turn Dowel Pins & Datum Notches
**Current state (from `plans/multi-face-machining.md` § Part 2.D):**
- Top/flip (`+Z` / `-Z`) setups support `locate: 'pins'`, while side setups (`±X, ±Y`) currently use `locate: 'knownSpot'` on the block's near-left corner (`src/utils/solidSetups.ts`).

**Tasks:**
1. **Datum Notch (`2D × 2D × 5 mm`) in Setup 1**:
   - When a side setup's bearing face has had its outer stock skin machined away or when stock dimensions are rough-sawn, have Setup 1 mill a reference datum notch at the corner that becomes the new near-left origin after the 90° turn (`src/utils/solidSetups.ts`).
   - Update `datum.touches` and `SetupChangeDialog.tsx` instructions to reference the machined datum step when present, tightening the turn allowance `allowanceMm` from `0.1 + D·tan(0.25°)` down to the machined datum tolerance.
2. **Pins on 90° Turns (Optional Spoilboard Prelude)**:
   - Allow Setup 1 to bore registration pin holes into the frame faces that will sit against the spoilboard in later setups when the frame is wide enough, with a spoilboard pin-bore prelude (`OP 0`).

---

### 3. Playhead-Driven "Simulate to Line" & Live Cut Progress Mesh
**Current state (from `plans/add-simulation.md` § Later):**
- `simulateMilling` (`src/utils/cutSimulation.ts`) simulates an entire G-code program from start to end.
- `ToolpathView.tsx` already has an interactive playhead scrubber (`playheadLine`), and `webSerialManager.ts` tracks the live executed G-code line during a job.

**Tasks:**
1. **Line-Bounded Simulation (`maxLine` in `SimulationJobOptions`)**:
   - Allow `cutSimulation.ts` to stop at `maxLine` so the operator can scrub the playhead in `ToolpathView` and click **Preview Stock at Playhead** (or inspect where a tool change / roughing pass leaves the block).
2. **Toolpath Viewport Stock Preview Toggle**:
   - Render the decimated `simulationMesh` directly inside `ToolpathView` as a toggleable "Cut Surface" mode alongside the wireframe toolpath lines.

---

### 4. Hardware Verification Checklist & Housekeeping
1. **On-Machine Checklist** (`plans/machining-bugs.md` § Batch 8):
   - Connect, auto-reconnect after page reload, jog (including merged rapid clicks), zero XY/Z, bed probe (`probeOnce` / `probeGrid`), run a job with `T2 M6` tool change (lift, park, re-zero Z gate, resume), feed hold & resume, and e-stop.
   - Stream a short job while logged into Pro and verify `physbox_get_run_gcode` retrieves the stored program (`mesh-run-program-<id>`).
2. **Branch & Worktree Cleanup**:
   - Remove the obsolete worktree `/home/boab/mesh-stale-build` and merged local branches (`fix/stale-build-notice`, `feat/stock-rack-splitting-facing`, `feat/timber-joinery-breakdown`, `viewport-fidelity`, `feat/machining-migration`).

---

## Part 2: 3-Axis CNC Software Tricks Toward 5-Axis

How close a 3-axis router can get to 5-axis capability through pure software, geometry, and self-machined workholding:

### Trick 1: Arbitrary-Angle Tilted Setups via Self-Machined V-Cradles / Sine Jigs ("3+2 Indexed CNC")
**Why:**
- Orthogonal 6-face indexing (`±X, ±Y, ±Z` in `src/utils/orient.ts` and `src/utils/setupPlanner.ts`) handles 90° turns, but features leaning at an oblique angle (e.g. a 30° angled bore, a bevelled guitar neck heel, or a compound-miter tenon) still see stair-stepping or unreachable shadow zones from the 6 cube faces.

**How to build it:**
1. **Candidate Normal Discovery (`src/utils/setupPlanner.ts`)**:
   - Cluster the normals of triangles that remain unreached (or high-slope) after the 6 cardinal faces, or search a discrete icosahedral/tilt ring of directions $(\theta, \phi)$.
2. **Generalised `Rotation3` Setup Frame (`src/utils/orient.ts`)**:
   - Extend `setupFrame` beyond the 24 cube rotations to accept an arbitrary unit vector $\hat{n}$ as the setup's $+Z$ spindle axis, computing the tilted bounding box and standing height (`standingHeightMm`) to check spindle clearance (`clearanceMm`).
3. **Self-Machined V-Block / Cradle G-code (`generateCradleFixture`)**:
   - Generate a companion 1-setup G-code program that mills a matching angled V-cradle pocket with a positive stop lip out of scrap MDF bolted to the spoilboard. Because the router cuts the cradle in its own coordinate system, the cradle's X/Y/Z datum is automatically known to sub-0.1 mm without a sine bar or indicator.

---

### Trick 2: Undercut Cutter Profiles (Lollipop / Spherical, T-Slot, Dovetail)
**Why:**
- Standard 3-axis CAM assumes a cylindrical shadow column: if $(x, y)$ has solid material at $z_{\text{roof}}$, no point below $z_{\text{roof}}$ can be cut from $+Z$.
- A **lollipop (undercutting ball)** cutter (shaft diameter $d_{\text{shank}} < D_{\text{ball}}$) or **T-slot / keyseat** cutter can enter from the side of an overhang while the spindle stays vertical along $+Z$, cutting undercuts, snap-fit lips, O-ring grooves, and curved organic under-chins in a **single setup** without flipping the block.

**How to build it:**
1. **Tool Geometry (`src/utils/feedsAndSpeeds.ts` & `src/utils/reliefCarveExporter.ts`)**:
   - Add tool types `'lollipop'` (`ballDiaMm`, `neckDiaMm`, `neckLengthMm`) and `'tslot'` (`cutterDiaMm`, `CompleteCuttingHeightMm`, `neckDiaMm`, `neckLengthMm`).
2. **Lateral Reach & Shank-Collision Check (`src/utils/columnSolid.ts` & `src/utils/setupPlanner.ts`)**:
   - Using `ColumnSpans`, an undercut point $(x, y, z)$ inside an air interval $[z_{\text{floor}}, z_{\text{roof}})$ is reachable from $+Z$ with an undercutting tool if:
     - The ball/disk at $(x, y, z)$ clears the solid spans; AND
     - The narrower shank of radius $r_{\text{neck}} = d_{\text{neck}} / 2$ extending upward from $z$ to $z + L_{\text{neck}}$ clears all solid spans above $z$; AND
     - There is a collision-free lateral entry/exit path from the stock channel (`moat`) into $(x, y, z)$ at constant $z$ so the tool never plunges or retracts through the overhanging roof!
3. **Undercut Waterline Pass**:
   - Emit safe lateral lead-in/lead-out moves from the moat into the undercut contour and back out before any Z retract.

---

### Trick 3: True 3D Equidistant Scallop (Geodesic) Finishing (`src/utils/finishingPaths.ts`)
**Why:**
- Constant-XY raster passes pack tightly on flats and spread far apart on steep walls ($\Delta z = \Delta xy \cdot \tan\alpha$), while constant-Z waterlines pack tightly on steep walls and leave wide terraces on shallow slopes.
- Even our current `hybrid` strategy (raster + waterline below a threshold angle) has a transition seam where the two patterns meet.
- 5-axis finishing looks smooth because the stepover is constant **along the 3D surface arc length** rather than in XY projection.

**How to build it:**
1. **Surface-Metric Distance Transform on `Heightmap`**:
   - Compute a weighted Fast Marching / Dijkstra distance field on the heightmap grid where edge weights between adjacent cells are the 3D surface arc lengths $\sqrt{\Delta x^2 + \Delta y^2 + \Delta z^2}$ (or curvature-adjusted effective cusp stepover $s(\alpha, \kappa)$ for a ball nose of radius $R$ targeting a constant scallop height $h$).
2. **Iso-Distance Contour Extraction**:
   - Extract iso-contours of the surface distance field at integer multiples of the target 3D stepover using marching squares (`src/utils/marchingSquares.ts`), producing continuous, uniform-scallop 3D toolpaths over both steep walls and shallow domes with zero transition seams.

---

### Trick 4: Conformal Soft-Jaw / Negative-Mold Workholding for Side B (`src/utils/solidMachiningExporter.ts`)
**Why:**
- On organic or fully sculpted 3D parts (statues, ergonomic grips, aerofoils) with no flat faces and fragile edges where holding tabs leave unwanted witness marks, clamping or tabbing for the final freeing setup is the hardest part of 3-axis CNC.

**How to build it:**
1. **Negative-Cavity Fixture Pass**:
   - Using the already-machined Side A heightmap (`top`), generate a quick rough-pocketed negative cradle ("soft jaw") in a sacrificial MDF board on the spoilboard with 0.05 mm press-fit clearance on vertical walls.
2. **Tabless Side B Finishing**:
   - The operator flips the half-machined part into the conformal MDF pocket (held by friction, tape/CA glue, or vacuum) and Side B machines the entire outer perimeter clean off with `tabCount: 0`.

