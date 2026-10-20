# Plan: Solid machining from any face, open ends cut through, stored programs, multi-setup simulation

## Context
This started from `oak_tray` (135×138×19 mm). Its phone groove runs along X, 12 mm deep, leaning
back 15°.

**What went wrong yesterday.** Run `run_657c196aa4ac76bec5` cut it as a relief.
- The groove stopped about 2.6 mm short of each end.
- The groove's front wall overhangs, so a top-down cut leaves a sliver. A ray check found 0% of it
  reachable from top, front, back or bottom, and 100% from either end.
- The run's program can't be inspected, because a browser-streamed job never stores its program.

**What the user wants.**
1. A feature that is open at the part's edge comes out open. That is the base case.
2. Shapes that need more than one face, e.g. this tray, or the name "Tom" standing upright from a
   block, are machined from whichever faces they need. Between setups the machine tells the
   operator to turn the block. The operator locates it with **pins** (as today) **or a known spot**
   on the part, chosen per job.
3. Add Simulation shows the true part after every setup.
4. A run's program is stored whenever the user is logged in.

**Decided:**
- Multi-face machining lives in **Solid machining** (`solidMachiningExporter.ts`). That is the "make
  this shape" path: true size, part outline, frame and tabs, and today one or two sides with pins.
- **Relief carve stays single-face art on a board.** When a true-size relief has an undercut, its
  warning offers "Machine as a part", which opens Solid with the same stock and bits.

Three reviews of an earlier draft are folded in: safety and algorithm, usability, and
performance/geometry.

## Part 0: Store the program of a browser-streamed run (Mesh + physbox_api)
**Today.**
- A browser-streamed run's record is built server-side from telemetry (`webSerialManager.ts:781`
  posting to `/api/telemetry`, then `physbox_api/src/machine/runs.ts`).
- `GET /api/runs/:id/gcode` (`physbox_api/src/routes/runs.ts:352`) only serves queued jobs
  (`machine_jobs.gcode`).
- The job checkpoint already uploads the program to `/api/documents`. But its id is the same for
  every job on an install (`jobCheckpoint.ts:352`), and `clearCheckpoint` deletes it when the job
  finishes.

**Mesh.**
- In `beginCheckpoint` (`jobCheckpoint.ts:377`), when `cloudAvailable()`, also PUT the program under
  an id unique to the run, `mesh-run-program-${program.id}`, with app id `physics-run-program`.
  `clearCheckpoint` never deletes it.
- Send `programDocumentId` in the telemetry frame (`webSerialManager.ts:795`).
- The checkpoint's own copy could later be folded into this one to avoid uploading the program
  twice. That is optional.

**physbox_api.**
- Add a `machine_runs.program_document_id` column (a migration in `db/db.ts`).
- Read the field in `routes/telemetry.ts:94`. Thread it through `RunContext`, `openRun` and the
  COALESCE update (`machine/runs.ts:214`, `:315`).
- In `routes/runs.ts:352`, when `job_id` is null, fall back to that document. Check `user_id`, and
  return `data.gcode`.
- Documents allow 32 MB and gzip, against the 10 MB body limit for `machine_jobs`.

**Gating.** Telemetry and runs are Pro-gated (`apiClient.ts:388`), so "logged in" here means Pro.
Say so in the UI wherever "program stored" appears.

**Etch and Volt** can adopt the same telemetry field later. The machining package doesn't change.

## Part 1: Open-ended features run out (Mesh, relief and solid)
- **Reproduce first, as a red test.** New `tests/openEnds.test.ts`.
  - A block with a through-groove along X, using the tray's profile, upright and leaning.
  - Two stock cases: stock the same size as the footprint (as yesterday), and stock with a 7.5 mm
    margin.
  - Relief: background `skip` and `carve`, height modes `model` and `fill`. Solid: one side.
  - Cut each program back out with `simulateMilling` (`cutSimulation.ts:119`). Assert that the floor
    at the part's end faces is within one cell plus the tool profile of the model's depth.
- **Likely causes.** The test decides which apply.
  - **(a)** Edge rays that graze the end face read `-Infinity`, become background (Z0 in `skip`,
    `reliefCarveExporter.ts:4227`), and hold every dilated cutter up within its radius of the edge.
  - **(b)** Cut extents are clamped to [r, W−r], so the cutter never runs off the stock.
  - **(c)** In `skip`, the uncut board margin closes the ends.
- **Fixes.**
  - A grazing miss at the footprint edge takes the height of its covered neighbour.
  - Where the target at the stock edge is below Z0, let the path run past the edge by r + 0.5 mm.
    Grow the Frame Job bounds and the preflight extent to match, and warn in one line: "runs N mm
    past the board edge at …, keep clamps clear".
  - In `skip`, extend the part's edge heights out through the margin wherever they are below Z0, and
    report it.
  - A model with no open edges must produce byte-identical G-code. Assert this against the existing
    relief and solid fixtures.

## Part 2: Solid machining from any face, located by pins or a known spot

### A. Frames: new `src/utils/orient.ts`
- Move `ORIENT_MATRIX`, `orient` and `UpAxis` here from `solidMachiningExporter.ts:280–298`.
- Add `setupFrame(face, stock)`, which returns R (det +1) plus a yaw for each face. The yaw puts the
  edge where setup 1's top and front faces meet at the new near-left. The reviewer worked out
  `-x → [y,-z,-x]` and `-y → [-z,x,-y]`; `+x` and `+y` stay as they are.
- It returns `work_k = R·work_1 + t` and Rᵀ. Side B's existing flip becomes the −Z case. Its
  "flip LEFT TO RIGHT" text (:1235) must agree with whatever matrix is chosen; test it.

### B. What has to come off
- **Target** = stock − part. Use the frame-1 column intervals from a refactored `hiddenGap` →
  `hiddenIntervals()` (`reliefCarveExporter.ts:1238`; `hiddenGap` becomes their sum, so its output
  is unchanged).
- Add the `NUDGE` off-grid ray offset (`solidMachiningExporter.ts:366`) to `buildHeightmap` too.
- For each face F, the first-hit heightmap `T_F` of the part in frame F gives what F can see. Air
  above `T_F`, within reach L, after an *opening* by the tool's tip map, is reachable from F. Areas
  outside the stock are no-go.
- Keep the part footprint, frame and tabs (`PartFootprint`) for the setup that cuts the part free.

### C. Choosing faces: new `src/utils/setupPlanner.ts`
- **Candidates.** All six faces, +Z included, so setup 1 is the planner's choice, not always the
  top. When only the front has work, the job is a single setup: "lay it front face up".
- **Search.** Try every subset and order, up to `maxSetups` (default 4). Assign each target voxel to
  the face where it sits shallowest; opposite pairs then split at the middle, with an overlap of
  1 mm plus the allowance.
- **Cost** = setups + an L/D penalty + time + 10× the unreached share. A face must clear at least
  max(20 mm³, 5%). Ties go to fewer setups, then lower L/D, then lower standing height.
- **Workholding.** Every setup needs a bearing face and a pair of opposite jaw faces that are still
  uncut stock faces when it runs.
  - This is a hard constraint on order, checked against the outer skin each earlier setup has cut.
  - The setup that frees the part goes last and gets tabs, as solid machining does today.
  - −Z bears on a carved face, so it needs at least 60% of that face still flat. Otherwise it must
    use a frame or tabs.
- **Hard limits.**
  - Reach over 8×D (`MAX_AVAILABLE_REACH_DIAMETERS`, `reliefCarveExporter.ts:528`), unless a
    long-reach bit is declared.
  - Standing height plus stickout over the clearance under the spindle.
  - A dropped face says why.
- **What each setup is.** Each setup is a full surface job from its face: roughing plus finishing,
  a tool change where needed, per-setup cutters, and fine detail picking a fine bit. Run
  `machineSurface` with that face's window as `bounds`, plus:
  - walls `'clear'`;
  - the bit's flute length, stickout and holder (the holder is required whenever depth > 2×D);
  - `applyMeshLeveling` only on the setup whose up-face was probed;
  - the reach derate (:717/:830), plus a chip-clearing retract every 3×D of depth.
- **Allowance.** `a = touch 0.1 + D·tan 0.25° + R·tan 0.25°`, plus 0.3 for an unmachined datum.
  Pins replace the touch and tilt terms with the pin clearance. Report the skin left and the tilt
  limit.
- **No gouge.** Each target is `max(inflate(T_F, a), −D_F)` inside the window and 0 outside, so it
  is never below the part. State this in a comment and a test.
- **Search speed.** Score faces from the intervals without re-sampling the mesh. Re-sample only the
  chosen faces, windowed, at `min(0.6, D/15)` mm.

### D. Locating each setup: the operator picks pins or a known spot
`locate: 'pins' | 'knownSpot'` sets the default for the job, and each setup can override it.

- **Pins** (today's mechanism, `registrationPins`, `pinDiaMm`, `pinDepthMm`).
  - On a −Z flip they work as now.
  - On a 90° turn, setup 1 bores pin holes into the faces that will bear in later setups (two per
    face). The operator drops dowels into matching holes in the spoilboard; Mesh bores those first,
    as a spoilboard prelude, using the existing OP 0 pattern (:1250).
  - Where pins can't be placed (bearing face too small, or holes would hit the part), that setup
    falls back to a known spot and says why.
- **Known spot**, in this order:
  1. A feature an earlier setup machined that can be seen on the new up-face. For the tray after
     Part 1, that is the groove's corner at the end.
  2. A 2D×2D×5 mm datum notch cut by setup 1 at the corner nearest the next window.
  3. The setup-1 corner edges, with that error added to the allowance a.
- **Touching off.** The operator touches the bit's side to each wall with a paper feeler. A new
  runner call, `setWorkPosition({x:±r, y:±r})` (G10 L20 P1), applies the radius, and Z goes on the
  up-face. The exporter supplies the numbers in `datum.touches`.
- Back, right and bottom faces are never used as the datum unless the stock has been measured.

### E. Programs: one per setup, run as a gated sequence
**Result.** Generalise `sides: SolidSideResult[]` to `setups[]`. Each setup carries:
- `index`, `of`, `upFace`, `rotation`, `translation`
- `standingHeightMm`, `tools`, `LD`
- `locate`, `datum {description, touches}` or `pins`
- `windowBounds`, `upFaceBounds`
- `clearedMm3`, `gcode`, `estimatedTimeSeconds`, `segments`, `instructions[]`

The result also carries `remaining {mm3, bounds, text}` and `redesignHint` (for the tray: "make the
front wall vertical; one setup"). `sides: 1|2` stays as an input alias: 2 means {+Z, −Z} with pins.

**Runner** (`webSerialManager.ts`).
- `runJob(…, {setup:{sequenceId,index,of}})`.
- When a setup with a successor finishes, set `setupPending`, `xyStale` and `needsZZero`.
- `runJob` and `frameJob` refuse setup ≥ 2 until XY and Z have been zeroed from the UI. With pins, Z
  only, plus a "pins seated" confirmation.
- Setup ≥ 2 is refused over MCP and over cloud.
- `parkHigh()`.
- Checkpoints carry the setup, and resume-from-line in setup ≥ 2 asks the operator to confirm the
  datum.
- This also closes today's hole where side B can start on the old datum.

### F. Relief hand-off
- In `reliefCarveExporter.ts:4207`, the undercut warning gains an action, "Machine as a part (N
  setups)". It opens `ExportSolidMachiningModal` with the same stock, bits and material.
- Relief gets no setups of its own.

## Part 3: Add Simulation shows the true part across every setup
- A 3-axis cut from one face removes everything above that face's cutter envelope. So setup k is
  simulated as today: `simulateMilling` in its own frame, on its own up-face grid, gives `H_k`.
- The part left is the stock box where `f(p) = min_k ( H_k(x'_k,y'_k) − z'_k(p) ) ≥ 0`. That field is
  continuous and exact at the heightmap's resolution, with no voxel cutting.
- New `src/utils/multiSetupMesh.ts` meshes `f` with surface nets over the stock grid, refining only
  near sign changes, with the cell sized to `maxTriangles`. It runs on the export worker.
- `SimulationJobOptions` gains `setups: {gcode, frame, tools}[]`.
  - A single setup keeps `simulationMesh.ts`, so its output is byte-identical.
  - `gcodeB` maps onto the new path. Its result must match today's volume.
- Volume, `measureRect` and `measureMask` come from `f`. `simulatedBody`'s overlay and beside
  placements work as before, since everything is in the setup-1 frame.
- `physics_add_simulation` picks this up without changes. Simulate offers "all setups" (the default)
  or a single setup.
- Rapids are still checked per setup on a fresh block. That is conservative; document it.

## UI
**`ExportSolidMachiningModal.tsx`:**
- The "Sides" choice becomes **Setups: Auto / 1 / 2 (flip)**. The default is Auto, which is 1 when
  everything is reachable from the top.
- A **Locate with: Pins / Known spot** choice, plus clearance under the spindle (remembered in
  Machine Setup and checked against `$132`). Per-setup bits are in Advanced.
- One card per setup: a diagram, face, standing height, bits, L/D, time and how much it clears, with
  Download, Simulate and Run. These cards replace the Side A/B toggle.
- The preflight row before setup 1 names the later setups and what they need.

**`src/utils/setupDiagram.ts`:** an isometric SVG of the turned stock, with the up-face shaded, the
carved faces labelled, and the datum or pins marked.

**`SetupChangeDialog`.** Steps:
1. Park high.
2. Clearance check.
3. Stand the block as pictured. The text names two faces, so it can't be put in mirrored.
4. Fit the bit.
5. Seat the pins, or touch off X, Y and Z.
6. Trace the up-face edge.
7. Frame the window.
8. Start.

It has no "Z is already set" override and never says "Material change".

**`ToolpathView`:** per-setup stock dimensions and a `datum` marker.

**Relief modal:** the hand-off button in the warning, nothing else.

## Performance
- **`exportWorkerClient.ts`:** keep one request in flight and one latest-pending; drop the stale ones
  in between.
- **`exportWorker.ts`:** memoise the placed triangles, intervals and per-face heightmaps by scene,
  stock and grid, and the plan by tool options. Feed, RPM and safe Z edits then never recompute
  geometry.
- Window every per-setup `machineSurface`.

## MCP and docs
- **`physics_export_machining`** (`useMCPBridge.ts`, plus `machineMcp.ts` for running): add
  `setups` ('auto'|1|2|faces), `locate`, the per-setup tool overrides and `clearance`. Check how
  physbox_mcp maps parameter names first. The summary gives a per-setup plan, `remaining` and
  `redesignHint`. `out_dir` writes `solid.setup-k.nc`. Running starts setup 1 only; setup ≥ 2 is
  refused as local-operator only.
- **`physics_export_relief`:** the undercut summary carries the hand-off hint.
- **Run tools:** `physbox_get_run_gcode` now works for streamed runs (no MCP change).
- **Docs:** `mcp-docs.json` and the physbox_mcp fallback, with a version bump and a release.
- **`systemInstructions.txt`:** a redesign first, then hand finishing, then setups; never resume a
  setup stop.
- **GUIDE.md:** a "Solid machining from any face" section.

## Later (record in project memory)
- A DFM overlay coloured by the face that reaches each triangle, replacing the wrong "flip the part"
  fix (`dfm.ts:581`).
- Etch and Volt adopting stored programs.
- A dovetail cutter model.

## Build order (each its own commit; physbox_api changes in that repo)
1. **Part 0** (stored programs): the physbox_api column and routes, then Mesh's telemetry and upload.
2. **Part 1**: the open-ends test (red), the fix, and a byte-identical check for closed models.
3. `orient.ts`, plus the setup datum gate on the existing side B.
4. `hiddenIntervals`, the ray nudge, and worker coalescing and memoising.
5. `setupPlanner.ts` and the generalised solid exporter (setups, locate: pins/known spot, notch,
   spoilboard pin prelude).
6. Part 3, the multi-setup simulation.
7. The runner sequence gate, `setWorkPosition` and `parkHigh`.
8. UI, including the relief hand-off.
9. MCP, docs, copilot, and the MCP release.

## Tests
- **`openEnds`** (Part 1): red first, then green.
- **physbox_api:** a streamed run with `programDocumentId` returns its G-code, and another user's
  document is refused.
- **`orient`:** det +1, the datum edge lands near-left for all six faces, and the instruction text
  matches the matrix.
- **`setupPlanner`:**
  - The tray at true size picks {+Z, ±X} with ends split mid-way (stock 150×150×20, 6 mm bit with
    80 mm stickout).
  - An **upright "Tom"** (extruded letters standing on a base) picks {+Z, −Y}. The "o" counter and
    the space under the T's bar are cleared, and the order respects workholding.
  - A part whose only detail is on its front picks one setup, front up.
  - A plain block with a top pocket picks one setup.
  - Today's two-sided fixtures choose {+Z, −Z} with pins and their G-code is unchanged.
  - Limits: reach over 8D, stickout, clearance, and nothing cut outside the stock.
- **`multiSetupSimulation`:**
  - No point inside the model has f > 0 (the field must never mark it as removed), including with
    datum, tilt and yaw errors inside the budget. Errors beyond the budget are detected.
  - The undercut is cleared to within the skin.
  - A single setup is byte-identical.
  - `gcodeB` volume matches.
  - The overlay sits on the model.
- **`setupSequence`** (runner):
  - Setup 2 is refused until zeroed; with pins, Z plus confirmation.
  - Refused over MCP and cloud.
  - Checkpoints carry the setup.
- `reliefPathEfficiency`, `reliefTrueSize` and the solid suites stay green.

## Verification
1. `npx vitest run` on the new and affected files. Typecheck, lint and the full suite are left to
   CI.
2. **Run archive:** stream a short job while logged in (Pro), then `physbox_get_run_gcode` returns
   it.
3. **MCP on `oak_tray`:** cut yesterday's relief settings back out with the simulator. The groove
   runs out at X = 0 and X = 135.
4. **MCP solid machining, setups auto:** check the plan (faces, datum or pins, reach, clearance,
   redesign hint), then Add Simulation overlaid on the model with the leaning slot fully cleared.
   Repeat with an upright "Tom" built in the scene.
5. **The user, in the browser:**
   - the setup cards and diagram;
   - Add Simulation with all setups;
   - the `SetupChangeDialog` with pins and with a known spot;
   - an air-cut dry run, then the real cut.

## Progress (2026-10-19, end of planning session)
- Plan approved by the user. Nothing in Mesh changed yet.
- Part 0 started in **/home/boab/physbox_api**. These edits are uncommitted and untested; there is
  no local DB, so `tests/runs.test.ts` skips:
  - `src/db/db.ts`: `ALTER TABLE machine_runs ADD COLUMN IF NOT EXISTS program_document_id TEXT`.
  - `src/routes/telemetry.ts`: reads `programDocumentId` / `program_document_id` and passes it in
    the run context.
  - `src/machine/runs.ts`: `RunContext.programDocumentId`, written by `openRun` and filled late by
    the COALESCE update.
  - Still to do in physbox_api:
    - the `GET /api/runs/:id/gcode` fallback to `user_documents` (`routes/runs.ts:352`), checking
      `user_id` and `NOT is_deleted`, returning `JSON.parse(data).gcode`;
    - deleting the program document when its run is deleted (`routes/runs.ts:376`);
    - tests in `tests/runs.test.ts`.
  - Still to do in Mesh: the per-run program upload in `beginCheckpoint` (`jobCheckpoint.ts:377`) and
    `programDocumentId` in `publishTelemetry` (`webSerialManager.ts:795`).
- Evidence for Part 1: run `run_657c196aa4ac76bec5`, 2026-10-18 23:53.
  - Stock was 135×138 (the tray's own size), tools 3.175 flat + 1.5875 ball, 11.5 mm deep.
  - Its sampled trace shows the deep groove cuts spanning X 2.6–132.4 only.
  - The trace is sampled about every 2 s, so it is suggestive, not exact; the red test is the
    proof.
- The MCP `physics_export_relief` call ignored `vertical_scale_mode` this session and came back in
  fill mode. The MCP server may need restarting.

## Progress (2026-10-18, implementation session)
Committed, unpushed:
- **Part 0**: physbox_api `ae44f6f` (gcode route falls back to the program document, deleted
  with the run; tests need Postgres, so CI runs them). Mesh `e1af026` (per-run upload
  `mesh-run-program-<id>`, `programDocumentId` in telemetry).
- **Part 1** `aa1d808`: `machineSurface` `runOff`; relief runs 0.5 mm past an edge the *model*
  reaches below Z0 (a carved background reaching every edge does not count), skip carries
  end faces out through the margin (`endFaces`: 90% of samples one row in), grazing misses
  on end faces filled. Closed models byte-identical vs HEAD. `tests/openEnds.test.ts`.
- **Step 3** `e4f4d22`: `orient.ts` (`setupFrame`, `describeTurn`), runner setup gate
  (`JobSetup`, `setupPending`, refuses setup ≥ 2 until re-zeroed / pins confirmed, never
  MCP or relayed). Solid modal passes setups and has an interim "sitting on both pins"
  checkbox (replaced by SetupChangeDialog in step 8).
- **Step 5** `dd87d7c`: `columnSolid.ts`, `setupPlanner.ts`, `solidSetups.ts`;
  `setups: 'auto' | 1 | 2 | faces`. Side setups are knownSpot only so far.

Changed from the plan:
- `hiddenIntervals` was not needed: the planner casts its own spans (`castColumnSpans`).
  The ray nudge is in that caster only; relief `buildHeightmap` is unchanged so its output
  is too.
- Leftover cost is in units of 0.05% of the part's volume, not "10× the share": the
  tray's undercut is ~13% of the groove's air, which 10× did not pay two setups for.
- A side setup's need is widened by D + 2 mm, or the skin on the walls leaves the cutter
  no room to get down (the tray's ends cut 9 mm instead of 75).

Later the same session (all committed, unpushed):
- `6636042` planner: the cutter may stand in the channel (a front-pocket plate went from 3
  setups to 1, front up). Auto-orientation tested.
- **Part 3** `4692836`: `multiSetupMesh.ts` (field + surface nets), `runSimulationJob({setups})`;
  top/flip unchanged. Modal and MCP pass setups.
- `87f4654` runner `setWorkPosition` (paper allowance) and `parkHigh`; X and Y tracked apart.
- **UI** `ca835ad`: Setups Auto/1/2 (Auto default), Which Way Up Auto, Room Under Spindle,
  `SetupCards` with `setupDiagram.ts` pictures, `SetupChangeDialog` (8 ticked steps, no Z
  override), relief "Machine as a part instead" hand-off. 1/2 also return `setups`.
- **MCP/docs** Mesh `c51ce96`, physbox_mcp `df0361b` (no version bump or release yet).
- `764d9f9` export worker coalescing.

Still to do:
- Pins on 90° turns (bores in bearing faces + spoilboard prelude) and the 2D×2D×5 datum
  notch; side setups are knownSpot only, on the block's corner.
- Worker memoising of geometry by scene/stock/grid.
- Live check on the app (the Mesh tab was on old code; needs a reload), then the user's
  manual pass on the dialog, the cards, the turn dialog, the relief hand-off.
- Push physbox_api, Mesh, physbox_mcp (+ version bump and GitHub release), watch CI and
  Cloud Build. The Mesh tab's SCAD worker had crashed (validate_scad on a cube failed);
  unrelated to this work.
