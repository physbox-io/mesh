# Plan: the machining audit (bugs.md, 41 items) and the shared GRBL module

The items are grouped by the code they touch, so that each batch is one area and one kind of
verification. Each fix is its own commit, and each comes with a test that fails before the fix.
Line numbers in bugs.md are out of date, so find code by symbol name. CI is the gate: run only
the test file you are working on.

Do the batches in order: the first ones can break a cutter or crash the gantry.

## Batch 1: controller protocol hygiene (`webSerialManager.ts`) — DONE 748fa7f (also took 1.2.1, resumeFromPark)
Fixes the base that batch 2 relies on.
- **One `afterSoftReset()` helper** for 1.3 and 1.2.3: drop the ack queue, set `jobBytesInFlight = 0`,
  send `0x18`, wait for the `Grbl` banner (with a timeout of about 500 ms), and only then send
  anything else. `eStop`, `cancelJob` and `parkJob` all use it. Restore `$32=1` after the unlock,
  not into the reset.
- **1.4**: await `guideSpotOff()` before the queue is cleared, in both `startJob` and `resumeFromLine`.
  `resumeFromLine` also gets the stale-ack clearing that `startJob` has.
- **1.1.4 / 1.2.1**: any line sent ahead of `pumpJobQueue()` goes through `sendAndWait`. Grep for
  the pattern `sendLine(...)` followed by `pump`, and fix every place it occurs.
- **1.7**: parse `ALARM:` in `handleIncomingLine` with `describeGrblAlarm`. `probeOnce` sends no
  `G90` while alarmed. `unlockAlarm` sends `$X` and then `G90 G21`.
- **1.5**: allow one jog in flight. Clicks that arrive while a jog waits for its `ok` are merged
  into one pending jog.
- Tests: the injectable `machineTransport` fake. Script GRBL's reset, which swallows input, and
  assert on the ack-queue length and the bytes in flight.

## Batch 2: pause, park and resume (`webSerialManager.ts`, `jobResume.ts`, `MachineJobControls.tsx`) — DONE c6c8001..149b7db (deployed)
- **1.1**: write a `restoreAfterProgramPause()` that uses `scanModalState` at the pause line. It
  restores units, plane and WCS, lifts to the safe Z, rapids back over the paused XY, and restarts
  the spindle (with a dwell on a CNC) if the program does not re-issue M3/M4 before its next cut.
  Then it restores F and G91. Every step uses `sendAndWait`, and the pump starts only after all of
  them. This must keep c6475fe's rule: drain first, then lift.
- **1.2.1**: `resumeFromPark` sends nothing itself. `resumeFromLine`'s preamble already does all
  of it. **1.2.2**: no Z move on a laser.
- **1.8**: `locateExecutedLine` measures to the segment, not the endpoint. The resume clearance has
  a floor above Z0. `isLaser` is passed in explicitly, not inferred from the Z words.
- **1.11**: clamp `abandonJob`'s rewind at `cutFloorLine`.
- **1.9**: gate the three Resume buttons on `requiresZZero` / `showZTools`.
- Tests: extend the `jobResume` tests and the transport-fake tests. Assert that no XY move happens
  below the safe Z, and that the laser preamble has no Z words.

## Batch 3: relief and solid CAM safety (`reliefCarveExporter.ts`, `adaptiveClearing.ts`, `finishingPaths.ts`, `solidMachiningExporter.ts`) — DONE 665d619..def017a (deployed 2026-10-15)
2.2/4.3 went the fallback way: each ring's engagement is measured on the stock model (a region at
`layerZ` is the old rule that `layerRegion`'s comment records leaving a terrace between layers; not re-measured). 2.8.3 was already covered by `toolBodyClearance`
when stickout and holder are entered; with them unset there is no reach to cap against.
2.1(b) flies traverses over 30 mm at `safeZ`. The tool-change park does not move the planner's
start point (from the corner, the dome's finishing lifted 73 times against 56).
Verify every fix by cutting the program back out of a block (`cutSimulation.ts`) on a set of parts:
a sloped relief, a stepped shelf, a pocket with an island, and a two-sided solid. Also keep
`reliefPathEfficiency.test.ts` green.
- **2.2 (critical)**: adaptive rings ride the surface but are fed and stepped down as if they were
  flat. Build `layerRegion` at `layerZ`, so that the rings on every terrace really reach `layerZ`.
  Only fall back to measuring each ring's engagement if that costs too much material left in place.
  Fix **4.3** (repeated passes in air) in the same change: it is the same ring-thickness calculation.
- **2.3**: tell island loops from outer loops by their signed area. Wind island loops `'outside'`
  and build the parent tree in the right direction.
- **2.4**: within a group, a waterline level becomes selectable only once every level above it is
  done.
- **2.6**: a link move goes through `squareUpWalls`, and `linkRimMm` is bounded even when roughing
  is on.
- **2.7, 2.8**: peck the pin bore when `r` is about 0. Check each pin centre against the moat with
  `dist[k]`. Keep tabs apart from each other, and place them only where the part spans the tab's
  Z. Cap cavity depth at the cutter's reach. Seed holding tabs from cells at least `tab.heightMm`
  thick.
- **2.9**: clamp the roughing feed to the machine maximum. Park at X0 Y0 after the lift at `T2 M6`.
- **2.1 needs your decision** (see the bottom of this file). Fix the mesh-leveling span being
  clipped by `safeZ` regardless.

## Batch 4: sheet output, laser and CNC (`gcodeExporter.ts`, `contourSliceExporter.ts`, `laserCutExporter.ts`, the two modals)
- **3.1 (critical)**: `sheetIndex` goes on `ContourLayer`, and positions stay local to their sheet.
  G-code pauses between sheets, not between layers.
- **3.2 (critical)**: cut innermost loops first (from `nestingDepths`), and put tabs only on outer
  loops.
- **3.3**: cut depth per sheet from `sheetStockThicknessMm`.
- **3.4**: pass `kerf: 0` in CNC mode. Offset the slice loops by half the kerf on a laser, and leave
  dowel holes at their nominal size.
- **2.5**: lift Z before framing. Pause for a tool change after facing (`pauseOnToolChange` is
  defined but never read). The facing pass steps evenly, and its bounds cover the facing bit.
  **4.5.3**: start the cuts after facing at `-removalMm`.
- **3.6**: default to dogbone corner relief in CNC mode, and use a circumscribed polygon for the
  relief circle.
- **3.7**: mirror the panel frame for underside engraving. Stop the ghost Sheet 0. Mirror the
  probe grid for Side B.
- **3.5**: decision needed on M4 (below). Whichever way that goes, cross a tab with `S0` instead
  of `M5`/`M3`.
- Efficiency: **4.4** and **4.5.1-2** (order engraving lines, holes and loops nearest first,
  reversing open lines; start each loop near the head on a straight edge; make `simplify` drop
  loops that collapse to nothing). **4.6** (modal F and Z; total distance × number of passes).
- Tests: `facingPass.test.ts` expectations will change, as bugs.md warns. Assert on the G-code
  itself: Y range per sheet, loop order, and that no `F` appears on a `G0`.

## Batch 5: rapids, framing and program reading (`webSerialManager.ts`, `timeEstimate.ts`, `livePlayhead.ts`, `ToolpathView.tsx`, `workEnvelope.ts`, `RemoteMachiningModal.tsx`) — DONE a05dfd1..35186f4 (unpushed)
- **1.6**: refuse to frame a CNC job while `needsZZero` is set; send `guidePowerAsS`; end with
  `M5 S0`; remove `F3000` from every `G0` (also `gotoWorkOrigin` and `probeGrid`).
- **1.10**: strip `(...)` before `;`, in both parsers.
- **1.14**: make `motion` modal across lines, and count G2/G3 as cuts.
- **1.13**: add `hasHomed` to `MachineState`, and skip the envelope check until the machine has
  homed. Fix `axisRange` at MPos 0.
- **1.15**: tag moves with their pass instead of comparing feeds. **1.16**: try a tight snap
  first, then the wide one.
- **1.12**: check where `item.status` comes from first (it may be API run data, not
  `MachineState`), then compare without regard to case.

## Batch 6: relief efficiency (`reliefCarveExporter.ts`, `stockModel.ts`, `finishingPaths.ts`) — DONE (2026-10-15)
Each one is measured with `reliefPathEfficiency.test.ts`, with new figures added for ramps and
retracts between bites.
- **4.1**: query `highestUnder` within the cutter radius, using the cutter's profile. When moving
  to the next bite (`bite > 1`), ramp straight down, without a retract and rapid.
- **4.2**: a closed-loop ramp continues forward around the loop instead of reversing twice.
- **4.7**: no centre strip left in concentric passes; resample spiral bridges; simplify each run
  once instead of twice.

## Batch 7: geometry helpers and leftovers — DONE 44b4355..(2026-10-15, unpushed)
- **2.10**: interleaved crossings in `splitLoops`; a canonical edge key in marching squares (this
  one can silently drop contours anywhere, so it could be moved forward); the mold sprue and vents
  placed at the cavity and the grid cell kept open; cast gating extended down to Z0.
  - Done as: `splitLoops` reconnects at every crossing (oriented smoothing). Marching squares joins
    segment ends by integer grid-edge ID, not quantised coordinates; most drops were two crossings
    near one corner merging, not the 1-ULP split. Mold sprue/vents are placed on the footprint by a
    distance transform, snapped to grid columns, so they always break through (no forced-open cell
    needed: one void corner already opens a cell). Sand sprue and riser stand on Z0; runner/gate
    beams bridge between them.
- **4.8**: the `prev` fix in `simplifyPolygon2D` and the simplify after `applyEdgeFeatures`. The
  binary search for auto-scale and the shelf packing are features, so they come last or not at all.
  - Done: `prev` is the last kept point. The simplify after `applyEdgeFeatures` was not needed: it
    already merges same-depth runs, and the presets show no vertex under 2 degrees of turn in any
    joint mode. Auto-scale binary search and shelf packing not done (features).

## Batch 8: the shared GRBL module (`../machining`, published as `@physbox-io/machining`) — IN PROGRESS
**Done 2026-10-16 (machining 0.4.0, released):** checked every Batch 1-2 item against
`GrblMachine`. Ported what failed, each with a transport-fake test that failed first: banner wait
after `0x18` (a05c8b8), `G90 G21` after unlock and no `G90` into an alarm (59badbe), one jog in
flight with merged clicks and a cancel that drops them (7795702), `G4 P0` before a program pause is
announced (5dc6f46), and auto-connect (12f6224; `autoConnect()`, wired on open in Etch d248c64 and
Volt 786ec7a). Etch and Volt are bumped to 0.4.0 (Etch d1f8706 drops its now-duplicate `G21 G90`;
Volt 7da2849 queues its e-stop `M5`). Mesh is bumped to 0.3.7 (ceab23e, unpushed) and not yet to 0.4.0.
Nothing to port, because the package has none of the code: guide spot (Etch awaits its `M5` before a
job and never abandons the queue), park, resume-from-line, `locateExecutedLine`, abandon (1.2.x, 1.8,
1.11 are Mesh-only features, and they move with Mesh). Etch audit items: all clear in the package
(180 s ack timeout, `probeDown` rejects a refused line, and Etch's exporter re-raises Z and the spindle
after `M6`). Volt's double `processQueue`: fixed by `queueRun` (269d645).

**What remains: move Mesh onto `GrblMachine`.** Mesh's manager is a synchronous pump with its own
`ackQueue`, and the package streams through an async `LineQueue`. Keep the package's shape: it now has
the hold, generation and `queueRun` guards that make it safe. Package work first, released as 0.5.0:
  - a send-with-timeout that gives the slot up without shifting later acks (Mesh's `sendAndWait`).
  - the controller-silence watchdog (`CONTROLLER_SILENCE_MS`); the package has only the 180 s ack timeout.
  - homed-state tracking (`Home`→`Idle`, dropped on alarm), for the `G53` ceiling of the pause lift.
  - an async hook that runs before a resumed stream restarts (Mesh's `restoreAfterProgramPause`),
    and the program comment passed to `describePause` (the sheet number, the tool note).
  - per-ack program-line credit for a resumed stream (`lineNumberFor` covers most of it).
  - `LineQueue.abandon()` at job start (it is written but nothing calls it).
  - maybe: the guide spot (about 160 lines shared between Mesh and Etch) as a second entry point.
Then Mesh, one commit per area, keeping `machineTransport`, `machineJobControl`, `machineFaults` and
`webSerialProbe` green: connection and line parsing (→ `parseLine` hooks), status (→ `onStatusReport`),
jog, zero, unlock and home, probing (`probeOnce`→`probeDown`, `probeGrid`→`probeGridCycle`),
streaming (`runJob`/pump → `processQueue`, `triggerPause` → `describePause` + `onStreamPaused`),
then park, resume-from-line and checkpoints rebuilt on top. Telemetry and remote commands stay in
Mesh. When it is done, move the transport-fake tests into the package; Mesh keeps wiring tests only.

Batches 1 and 2 fixed the controller protocol in Mesh's own `webSerialManager.ts` (3,543 lines).
Etch and Volt do not use that code. They extend the package's `GrblMachine`
(`machining/src/machine/grblMachine.ts`, 1,394 lines), so the same faults are probably still
there. Mesh takes only constants, `describeGrblAlarm`, `parseStatusReport`, the transport and
`warpGcode` from the package, and is pinned at 0.3.4 against the current 0.3.7.
- **Check first, then port.** Run each Batch 1-2 fix against `GrblMachine` and its `LineQueue`,
  using the package's tests and the same transport-fake scripts as Mesh's `machineTransport`
  tests. Port only what fails:
  - wait for the `Grbl` banner after `0x18` before sending anything (1.3, 1.2.3)
  - put the guide spot out (awaited) before a job (1.4)
  - parse `ALARM:` lines, send no `G90` while alarmed, send `$X` then `G90 G21` on unlock (1.7)
  - one jog in flight, with later clicks merged (1.5)
  - drain before lifting at a pause; then restore units, plane, WCS, XY, spindle and dwell,
    F and G91 on resume (1.1)
  - resume preambles that send nothing twice and no Z on a laser (1.2.1, 1.2.2)
  - `locateExecutedLine` measured to the segment, and the resume floor above Z0 (1.8)
  - abandon's rewind clamped at `cutFloorLine` (1.11)
- **Etch items from the 2026-09 audit.** Re-check each against the package before fixing,
  since Etch has moved onto `GrblMachine` since then:
  - no ack timeout on job lines
  - `failPendingWaiters` resolving a refused `G38.2` as success
  - the unbounded `G91 G0 Z5` lift at a pause, and a resume that sends only `~`
- **Volt:** `pauseJob` / `resumeJob` could start a second `processQueue` while the first waits
  (a duplicated line). Check whether `GrblMachine` still has this.
- **Auto-connect to the last machine.** None of the apps calls `navigator.serial.getPorts()`.
  Store `{usbVendorId, usbProductId}`, match it on mount, connect without a gesture. Put it in
  the transport so all three get it.
- **Move Mesh onto `GrblMachine`** once the package carries Mesh's fixes. This is the large
  step. The package's split is the target: protocol, pump and pause in the package; probing,
  heightmaps, resume planning and tool-change wording in the app. Bump Mesh to the current
  version first, on its own.
- **Release.** Version bump, a GitHub *release* (a push publishes nothing), then bump the
  dependency in each app. Each app goes through its own CI and Cloud Build.
- Tests: the package's own suite carries the transport-fake tests that Mesh's
  `machineTransport.test.ts`, `machineJobControl.test.ts` and `machineFaults.test.ts` have now.
  An app test should only check that the app wires the package up.

## Decisions (all agreed 2026-10-14: 2.1 = (a)+(b), 3.5 = M4, fix Section 1 in Mesh now)
1. **2.1, traverse height.** `traverseZ = min(safeZ, 1 mm above the stock swept along the path)`
   is intentional: it is the low-hop design that `reliefPathEfficiency` rewards, and the stock model
   cannot be wrong about the stock. It cannot see clamps or screws, though. Options:
   (a) keep it and fix only the leveling clip; (b) use `safeZ` for rapids longer than N mm;
   (c) add a "fixture clearance" setting. Recommendation: **(a) + (b)**.
2. **3.5, M3 or M4 on the laser.** M4 (dynamic power) is the GRBL norm for cutting and engraving,
   and it stops corners charring. Etch has its own laser output and should match. Recommendation:
   **M4**.
3. **Section 1 and `@physbox-io/grbl`.** Most of batches 1 and 2 are the protocol code that the
   shared GRBL module plan would take out. Recommendation: fix it in Mesh now (that is where the
   machine is), and port it when the package is built. The same faults are likely in Etch and Volt.
