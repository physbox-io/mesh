# Comprehensive Audit of Machining Bugs & Toolpath Optimizations (CNC + Laser)

This document lists all identified bugs causing erratic or unsafe behavior during CNC and laser machining, as well as sub-optimal G-code generation and toolpath inefficiencies across the codebase.

---

## Section 1: Machine Control, WebSerial/GRBL Protocol, Pause/Resume & Safety

### 1.1 CRITICAL: Pause & Resume After Tool Change (`M6`) or Material Swap (`M0`/`M1`) Leaves Spindle/Laser OFF and Fails to Return XY to Cut Position
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 2128–2160 (`triggerPause`) and lines 2199–2256 (`resumeJob`, `retractToProgramClearZ`)
- **Bug & Real-World Effect:**
  1. **XY position not restored when next move omits X or Y:** During `triggerPause`, line 2160 parks the head at `G0 X0.000 Y0.000` so the operator can reach the collet or swap sheets, and the operator is also encouraged to jog anywhere (`JobPauseBanner` lines 108–123). On `resumeJob()`, only `retractToProgramClearZ()` is called (`G0 Z...`), which does **not** return X/Y to the coordinates the program had reached before the pause. If the first motion after `M6`/`M0` only specifies one axis (e.g. `G1 Z-2 F300` plunge at the previous XY, or a raster scanline `G1 X120`), the tool plunges at `X0 Y0` (or wherever the operator jogged it) or cuts a diagonal scar across the workpiece.
  2. **Spindle / Laser stays OFF if the program does not re-issue `M3`/`M4` after `M0`:** `triggerPause` unconditionally sends `M5` (line 2128) to turn off the spindle/laser. While a tool change (`M6`) is usually followed by `M3 S...` in exported G-code, a programmed stop (`M0`/`M1` for material/clamp swap or inspection) often does *not* repeat `M3 S...`. When `resumeJob` runs (lines 2199–2224), it never restarts the spindle/laser (`M3`/`M4`), driving a dead bit into the stock.
  3. **Distance mode (`G91`) and Units (`G20`) corrupted on resume:** `triggerPause` sends `G90` (line 2159), and if the operator jogged or zeroed Z (`zeroZHere` / `zeroZ`), `G21` and `G90` were sent. If the paused program was in `G20` (inches) or `G91` (incremental), `retractToProgramClearZ` sends `G0 Z<inch_value>` while the controller is in `G21` (mm) and leaves the controller in `G90`/`G21` when `pumpJobQueue()` resumes.
  4. **Un-awaited `sendLine` before `pumpJobQueue` overflows `RX_FILL_BYTES`:** In `resumeJob` (line 2215), `retractToProgramClearZ()` calls `await this.sendLine(...)` which only pushes `{ kind: 'other' }` (0 bytes tracked in `jobBytesInFlight`) and does not wait for `ok`, and then `this.pumpJobQueue()` immediately fills 112 bytes of `jobBytesInFlight` on top of the unacknowledged `G0 Z...` line in GRBL's 128-byte RX buffer.
- **Suggested Fix:**
  - In `retractToProgramClearZ()` (or a full `restoreAfterProgramPause()` helper in `webSerialManager.ts`), use `scanModalState(this.program.map(l => l.code), at)` to:
    1. Restore `scan.units` (`G20`/`G21`), `G90`, `scan.plane`, `scan.wcs` via `sendAndWait`.
    2. Retract to `Math.max(scan.safeZ, currentZ)` via `sendAndWait`.
    3. If `scan.position.x !== null || scan.position.y !== null`, rapid back over `X${scan.position.x} Y${scan.position.y}` at safe Z before resuming the queue.
    4. If `type === 'PAUSED_MATERIAL'` (or if the next lines in the queue do not contain `M3`/`M4` before the next `G1`/`G2`/`G3`) and `scan.spindle` was active, re-enable `scan.spindle` (`M3`/`M4 S...`) and dwell if CNC, then restore `scan.feed` and `scan.distance` (`G91` if needed), all via `sendAndWait` before calling `this.pumpJobQueue()`.

---

### 1.2 CRITICAL: `parkJob`, `resumeFromPark`, and `resumeFromLine` Double-Execute Preamble Moves, Overflow GRBL RX Buffer, and Move Z on Lasers
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 2295–2374 (`parkJob`, `resumeFromPark`), lines 1853–1907 (`resumeFromLine`)
  - `src/utils/jobResume.ts`: lines 245–315 (`buildResumePreamble`)
- **Bug & Real-World Effect:**
  1. **`resumeFromPark` + `resumeFromLine` duplicate positioning & un-tracked serial buffer flood:**
     In `resumeFromPark()` (lines 2363–2374):
     ```ts
     await this.sendLine('G21 G90');
     const resumeRetractZ = await this.clampedRetractZ(5);
     await this.sendLine(`G0 Z${resumeRetractZ.toFixed(3)}`);
     await this.sendLine(`G0 X${park.at.x.toFixed(3)} Y${park.at.y.toFixed(3)}`);
     this.updateState({ park: null, pauseMessage: undefined });
     return this.resumeFromLine(park.fromLine).ok;
     ```
     `sendLine` does *not* wait for `ok` and does *not* add to `jobBytesInFlight` (it pushes `{ kind: 'other' }`). Those 3 lines (~50 bytes) are still in GRBL's 128-byte serial RX buffer when `resumeFromLine` immediately calls `pumpJobQueue()`, which sends another `RX_FILL_BYTES` (112 bytes) of preamble + G-code—overflowing GRBL's 128-byte RX buffer (162+ bytes in flight) and corrupting G-code lines (`error:2` / `error:24`). Furthermore, `buildResumePreamble` in `resumeFromLine` already generates its own `G21`, `G90`, `G0 Z<clearZ>`, and `G0 X... Y...`.
  2. **`parkJob()` and `resumeFromPark()` command a Z retract on a laser job:**
     At lines 2347–2349 (`parkJob`) and 2364–2366 (`resumeFromPark`), the code unconditionally runs `G0 Z${retractZ.toFixed(3)}` (5 mm). On a laser cutter where Z is either absent or used for manual focus height, `G0 Z5.000` drives the laser head 5 mm out of focus, and `buildResumePreamble` for a laser never moves Z back to 0 because `state.position.z === null && state.safeZ === null`.
  3. **`parkJob()` sends `G21 G90` immediately after `0x18` (Ctrl-X soft reset) without waiting for GRBL's reboot:**
     At line 2329, `await this.writeRealtime(0x18)` sends a soft reset, and at line 2347–2349 it immediately calls `sendLine('G21 G90')` and `clampedRetractZ(5)`. GRBL takes ~50–250 ms to reset its state machine and emit the `Grbl 1.1f ['$' for help]` banner, discarding serial input received during reset initialization—or `clampedRetractZ(5)`'s `nextStatusReport()` receives a stale `<Hold:0|...>` status frame that was already in flight before the reset.
- **Suggested Fix:**
  - After sending `0x18` (Ctrl-X) in `parkJob()` and `eStop()`, wait ~250 ms (or wait for the `Grbl` welcome line / `nextStatusReport`) before sending post-reset commands.
  - Only retract Z in `parkJob()` if the program actually uses Z (`scanModalState` has `safeZ !== null` or `!this.laserModeEnabled()`).
  - In `resumeFromPark()`, remove the redundant `sendLine('G21 G90')`, `G0 Z...`, and `G0 X... Y...` entirely—`resumeFromLine(park.fromLine)` already constructs the complete preamble and streams it through the byte-counted job queue.

---

### 1.3 CRITICAL: `eStop()` and `cancelJob()` Race Condition with GRBL Soft Reset (`0x18`) Leaving Orphaned `ackQueue` Slots and Unprocessed `$32=1`
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 3317–3334 (`eStop`), lines 2463–2469 (`cancelJob`), lines 2929–2935 (`restoreLaserMode`)
- **Bug & Real-World Effect:**
  - In `eStop()`:
    ```ts
    await this.transport.writeRealtime(0x18); // Ctrl+X soft reset
    await this.sendLine('M5');
    if (this.state.guideSpot) this.updateState({ guideSpot: false });
    this.restoreLaserMode(); // sends '$32=1'
    ```
  - Immediately after receiving `0x18` (soft reset), GRBL clears its serial RX buffer as part of its reset initialization (`mc_reset` -> `serial_reset_read_buffer()`). Any bytes arriving on the UART right behind `0x18` (`M5\n` and `$32=1\n`) are wiped out by GRBL's reset routine, and their `ackQueue` slots (`{ kind: 'other', resolve: null }`) are never answered (`ok` never arrives).
  - Because `ackQueue` now has 1 or 2 orphaned `{ kind: 'other' }` slots whose `ok` was swallowed by the reset, when the user subsequently runs a probe or `refreshMachineSettings()`, the first 1–2 `ok` responses from GRBL are consumed by those stale `ackQueue` slots instead of the actual command.
  - Furthermore, if `cancelJob()` or `eStop()` is called while the machine is in motion, GRBL enters `ALARM:3` (Reset while in motion). In `ALARM` state, GRBL rejects `M5` (`error:9`), overwriting `lastError` with `Machine Error: error:9`.
- **Suggested Fix:**
  - In `eStop()`, clear `this.ackQueue = []` and `this.jobBytesInFlight = 0`, send `0x18`, wait ~200 ms for GRBL to complete its reset and flush its RX buffer, and only if `this.guideSpotRestoreLaserMode` is true, wait until status is `IDLE` (or send `$32=1` after unlock).

---

### 1.4 HIGH: Un-awaited `guideSpotOff()` in `startJob()` Injects `M5`, `S0`, and `$32=1` Into the Running Job Stream (`error:8` Job Abort)
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 1698–1715 (`startJob`), lines 1853–1900 (`resumeFromLine`), lines 2889–2903 (`guideSpotOff`)
- **Bug & Real-World Effect:**
  1. **`startJob` vs `guideSpotOff` race condition (lines 1698–1705):**
     In `startJob()`:
     ```ts
     const stale = this.ackQueue;
     this.ackQueue = [];
     this.jobBytesInFlight = 0;
     for (const s of stale) if (s.kind === 'other') s.resolve?.();

     if (this.state.guideSpot) void this.guideSpotOff();
     ```
     `guideSpotOff()` is `async` (`await this.awaitJiggleStopped(); await this.sendLine('M5'); await this.sendLine('S0'); this.restoreLaserMode();`) and is called with `void` (not awaited). `startJob()` immediately calls `this.pumpJobQueue()`, which fills GRBL's RX buffer with 112 bytes of job lines and puts GRBL into `Run` state. Milliseconds later, `guideSpotOff()` resumes and injects `M5`, `S0`, and `$32=1` right into the middle of the running job stream.
     - `$32=1` is an EEPROM setting write: GRBL refuses `$32=1` when not `Idle` (`error:8` — setting can only be changed while idle). Because `pumpJobQueue()` already put GRBL into `Run` state, `$32=1` returns `error:8`, which hits `handleIncomingLine`'s `else if (line.startsWith('error:'))` (line 1253) and **immediately aborts the newly started job** with `"The machine refused line ... (error:8)"` and leaves `$32=0` (laser mode OFF).
  2. **`resumeFromLine` does not clear stale `ackQueue` or turn off `guideSpot` (lines 1853–1900):**
     Unlike `startJob()`, `resumeFromLine()` never clears stale `ackQueue` entries, never sets `this.jobBytesInFlight = 0`, and never turns off `guideSpot` if it was lit.
- **Suggested Fix:**
  - Await `await this.guideSpotOff()` before clearing `ackQueue` and starting `pumpJobQueue()` in both `runJob()`/`startJob()` and `resumeFromLine()`.

---

### 1.5 HIGH: Runaway Jogging / Unbounded Jog Queue Build-Up (`JogPad.tsx` & `webSerialManager.ts`)
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 2729–2737 (`jog`), lines 1162–1167 (`sendLine`)
  - `src/components/JogPad.tsx`: lines 27–32 (`jog`)
- **Bug & Real-World Effect:**
  - `webSerialManager.jog()` calls `this.sendLine('$J=G91 G21 ...')`, which unconditionally pushes onto `this.ackQueue` and writes to the serial port without checking how many commands or jogs are already in flight or how full GRBL's RX/planner buffer is.
  - When an operator clicks a jog button rapidly (e.g., clicking `X +10mm` 15 times), all 15 `$J=` commands are blasted into the serial port immediately.
  - More than 5–6 `$J=G91 G21 X10.000 F1000\n` lines (~150 bytes) overflows GRBL's 128-byte RX buffer, truncating and merging two `$J=` lines together and causing `error:16` / `error:2` or erratic motion.
  - Even when below 128 bytes, GRBL queues all jog blocks in its planner, so the machine continues moving long after the user stops clicking ("runaway jogging").
- **Suggested Fix:**
  - Track in-flight jogs or pace `jog()` so new jog clicks are coalesced/ignored while a jog command is still awaiting `ok` (or cancel prior jogs with `0x85`).

---

### 1.6 HIGH: `frameJob()` Laser Power Scaling Bug (`S5` vs `$30=10000`), Missing `S0`, Modal `F3000` on `G0`, and Missing `needsZZero` Guard on CNC
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 3269–3314 (`frameJob`)
  - `src/components/ExportLaserCutModal.tsx`: lines 505–510
  - `src/components/ExportContourSliceModal.tsx`: lines 403–408
  - `src/utils/machineMcp.ts`: lines 205–208 (`frameJob` handler)
- **Bug & Real-World Effect:**
  1. **Raw `guidePower` vs `$30` PWM scale:** In `webSerialManager.ts` line 3302, `frameJob` sends `await this.sendLine('M3 S${Math.round(guidePower)}')` (`M3 S5`). Whereas `guideSpotOn()` scales `guidePower` (a percentage 0.1–10%) by `$30` (`spindlePwmMax`, default `1000` or `10000`) via `this.guidePowerAsS(power)`, `frameJob()` sends `5` literally as `S5`. On a `$30=10000` laser controller, `S5` is `0.05%` duty cycle (completely invisible).
  2. **No `S0` after `M5` in `frameJob`:** Line 3306 sends `await this.sendLine('M5')` without `S0`, unlike `guideSpotOff()` (line 2897).
  3. **Modal `F3000` on `G0` rapid lines:** At lines 3292 and 3311 (`frameJob`), line 3053 (`gotoWorkOrigin`), and lines 3193/3220/3236 (`probeGrid`), the code sends `G0 X... Y... F3000`. While GRBL ignores `F` for the `G0` rapid speed itself, **it overwrites the controller's active modal `F` feedrate register to 3000 mm/min**.
  4. **No `needsZZero` check before framing on CNC:** On a CNC router (`!laserMode`), `frameJob()` (lines 3286–3290) computes `const retractZ = Math.max(safeZMm, this.state.wpos.z)`. If `needsZZero` is `true` (e.g. stale G54 offset has `wpos.z = +50` when the bit is touching the stock), `Math.max(5, 50)` is `50` (no lift at all), dragging the bit across the stock.
- **Suggested Fix:**
  - Refuse `frameJob()` when `!laserMode && this.state.needsZZero`.
  - Scale `guidePower` via `this.guidePowerAsS(guidePower)` and send `M5 S0` when done.
  - Remove `F3000` from all `G0` rapid commands.

---

### 1.7 HIGH: `probeOnce()` Failure Sends `G90` During `ALARM:5` (`error:9`), Leaving GRBL in `G91` Relative Mode After Unlock, and `handleIncomingLine` Ignores `ALARM:` Lines
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 1536–1562 (`probeOnce`), lines 1170–1270 (`handleIncomingLine`), lines 2657–2658 (`unlockAlarm`), lines 3068–3110 (`zeroZ`)
- **Bug & Real-World Effect:**
  1. When `G91 G38.2 Z-...` reaches the end of its travel without touching the probe plate, GRBL outputs `[PRB:0.000,0.000,0.000:0]`, `ALARM:5`, `ok` and enters `ALARM` state. `probeOnce()` then immediately sends `await this.sendAndWait('G90', timeoutMs)` (line 1556). Because GRBL is in `ALARM:5`, it rejects `G90` with `error:9` ("G-code locked out during alarm or jog state"), overwriting `lastError` with `Machine Error: error:9`. When the operator subsequently clicks `Unlock ($X)` (`unlockAlarm()`, line 2657), GRBL unlocks into `Idle` **still in `G91` (relative distance mode)**!
  2. `handleIncomingLine` (lines 1170–1270) checks `<...>`, `[PRB:`, `$`, `ok`, and `error:`, but **never** parses `ALARM:1` .. `ALARM:9` lines, even though `@physbox-io/machining` exports `describeGrblAlarm(line)`.
- **Suggested Fix:**
  - In `probeOnce()`, check if contact failed or `this.state.status === 'ALARM'` before sending `G90`, and in `unlockAlarm()`, send `$X` followed by `G90 G21`.
  - In `handleIncomingLine()`, parse `line.startsWith('ALARM:')` using `describeGrblAlarm(line)`.

---

### 1.8 HIGH: `jobResume.ts` Modal Scanner & Line-Locator Bugs (`locateExecutedLine`, `safeZ <= 0`, Laser Detection)
- **Files & Lines:**
  - `src/utils/jobResume.ts`: lines 88–193 (`word`, `stepModalLine`, `scanModalState`), lines 245–315 (`buildResumePreamble`), lines 386–423 (`locateExecutedLine`)
- **Bug & Real-World Effect:**
  1. **`locateExecutedLine` checks distance to line *endpoints* instead of *line segments*:** In `jobResume.ts` (lines 400–420), `locateExecutedLine` only measures Euclidean distance from `at` (`this.state.wpos`) to `state.position` (the endpoint of each G-code line). If the machine is executing a 200 mm straight cut (`G1 X200 Y0`) and the operator hits **Park** in the middle of that move at `X100 Y0`, both endpoints `(0,0)` and `(200,0)` are 100 mm away, while a short raster move 40 lines later at `(100, 5)` has an endpoint only 5 mm away. `locateExecutedLine` misidentifies the executed line as the move 40 lines later, **skipping 40 lines of the program on resume**.
  2. **`scanModalState` `safeZ` can be `<= 0` or corrupted by `G91`:** In `scanModalState` (lines 183–186), `safeZ` is the max raw `Z` word across lines. If all Z coordinates up to `fromLine` are `<= 0` (e.g. `Z0` at surface), `wantedZ = (state.safeZ ?? 5) + opt.extraClearance` evaluates to `0.000` when `extraClearance = 0`—traversing across the stock at `Z0.000` (scraping the surface) instead of lifting to a safe clearance height.
  3. **`isLaser` detection in `buildResumePreamble` fails if a laser job has any Z move:** Line 258 checks `const isLaser = state.position.z === null && state.safeZ === null;`. If a laser job includes a focus height command (e.g. `G0 Z0`), `isLaser` evaluates to `false`, and `buildResumePreamble` treats the laser as a CNC router: turning the **laser beam ON (`M3`/`M4`) and dwelling for 2 seconds (`G4 P2`) BEFORE traversing `G0 X... Y...` to the resume point**.
- **Suggested Fix:**
  - In `locateExecutedLine()`, compute point-to-segment distance between `at` and the segment `(prevPos -> nextPos)`.
  - In `buildResumePreamble()`, enforce a minimum clearance floor above Z0 for CNC (`Math.max(minClear, state.safeZ ?? defaultSafeZ) + opt.extraClearance`), and pass an explicit `isLaser?: boolean` into `ResumeOptions`.

---

### 1.9 MEDIUM: `JobResumeBanner` and `JobTransport` Block Laser Jobs From Resuming When `needsZZero` Is True
- **Files & Lines:**
  - `src/components/MachineJobControls.tsx`:
    - Line 365 (`JobResumeBanner`): `disabled={!machineState.connected || machineState.needsZZero}`
    - Line 574 (`JobTransport` parked resume button): `disabled={machineState.needsZZero}`
    - Line 611 (`JobTransport` paused resume button): `disabled={machineState.needsZZero}`
- **Bug & Real-World Effect:**
  - On a laser cutter (`showZTools = false` in `JobResumeBanner`, `requiresZZero = false` in `JobTransport`), there is no Z probe or Z zeroing panel shown to the user, so `machineState.needsZZero` remains `true` for the entire session.
  - Because `JobResumeBanner` line 365 and `JobTransport` lines 574 and 611 check raw `machineState.needsZZero` without gating on `showZTools` / `requiresZZero`, **a laser cutter user can never click Resume in `JobResumeBanner`, never click `Resume Here` when parked, and never click `Resume` from `JobTransport` when paused**.
- **Suggested Fix:**
  - Change line 365 to `disabled={!machineState.connected || (showZTools && machineState.needsZZero)}`, and change lines 574 and 611 to `disabled={blockedByZZero}` (`requiresZZero && machineState.needsZZero`).

---

### 1.10 MEDIUM: `prepareJobLines()` and `timeEstimate.ts` (`readProgram`) Comment Parsing Bugs
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 312–338 (`prepareJobLines`)
  - `src/utils/timeEstimate.ts`: lines 346–352 (`readProgram`)
- **Bug & Real-World Effect:**
  1. In `prepareJobLines`, `const semi = raw.indexOf(';')` runs *before* stripping `(...)` parenthetical comments. If a parenthetical comment contains a semicolon (e.g. `(Tool 1; 3mm flat) G0 Z5`), `raw.indexOf(';')` slices before the closing `)`, leaving `code = "(Tool 1"`, which fails the `/\(([^)]*)\)/g` regex and gets sent to GRBL as malformed G-code `(Tool 1` (`error:1` / `error:2`).
  2. In `timeEstimate.ts` (`readProgram`, lines 347–352), `readProgram` strips `;` comments, but **never strips `(...)` parenthetical comments**. When a line has a parenthetical comment like `M0 (PAUSE: Insert Material Sheet 2 of 3)` or `(Pass 1 of 3: Z-2.0mm) G0 X10`, `line.match(/[A-Z]-?\d*\.?\d*/g)` matches every capital letter and number inside the comment (e.g. `Z-2.0` or `G0` inside comments)!
- **Suggested Fix:**
  - Strip parenthetical comments `.replace(/\([^)]*\)/g, ' ')` *before* splitting on `;` in both `prepareJobLines` and `readProgram`.

---

### 1.11 MEDIUM: `abandonJob` Rewind Window Can Rewind Past `cutFloorLine` During a Resumed Job
- **Files & Lines:**
  - `src/utils/webSerialManager.ts`: lines 2588–2613 (`abandonJob`)
- **Bug & Real-World Effect:**
  - When a job is resumed via `resumeFromLine(fromLine)` (lines 1874–1880), `this.jobLineBase = plan.fromLine - preamble.length`. If the job is stopped, alarmed, or disconnected early in the resume, `abandonJob` (line 2601) subtracts `PARK_LOOKBACK_LINES` (64) from `sent`, which rewinds `fromLine` up to **64 lines earlier than the `fromLine` (`this.cutFloorLine`) the user explicitly resumed from**.
- **Suggested Fix:**
  - Clamp `stoppedAt` in `abandonJob` so it never rewinds earlier than `this.cutFloorLine`.

---

### 1.12 MEDIUM: `RemoteMachiningModal.tsx` Status Comparison Mismatch (`'running'` vs `'RUNNING'`)
- **Files & Lines:**
  - `src/components/RemoteMachiningModal.tsx`: line 117
- **Bug & Real-World Effect:**
  - Line 117 checks `const isRunning = item.status === 'running' || item.status === 'Run';`, whereas `webSerialManager.ts` publishes `state.status` as `'RUNNING'` (uppercase). Consequently, `isRunning` is always `false` for jobs streamed from Mesh.
- **Suggested Fix:**
  - Check `const isRunning = item.status?.toUpperCase() === 'RUNNING' || item.status === 'Run';`.

---

### 1.13 HIGH: `workEnvelope.ts` Infers Homing Direction From `machinePos > 1e-6` (Failing at `MPos == 0`) and Runs Placement Checks When `hasHomed === false`
- **Files & Lines:**
  - `src/utils/workEnvelope.ts`: lines 101–103 (`axisRange`), lines 154–176 (`checkJobEnvelope`)
- **Bug & Real-World Effect:**
  1. `axisRange` (`return currentPos > 1e-6 ? { lo: 0, hi: travel } : { lo: -travel, hi: 0 };`) flips the assumed axis range from `[0, travel]` to `[-travel, 0]` whenever a positive-space machine is parked at `MPos = 0`, falsely flagging the job as running off the bed.
  2. `checkJobEnvelope` (line 155) only checks `if (!profile.homingEnabled)` (`$22=1`), without checking whether the operator has actually homed the machine in this session (`hasHomed`). Before homing, `MPos` is arbitrary power-on coordinates.
- **Suggested Fix:**
  - Expose `hasHomed` on `MachineState` and skip the placement check in `checkJobEnvelope` when `!hasHomed`.

---

### 1.14 MEDIUM: `timeEstimate.ts` (`readProgram`) Resets Modal `G0`/`G1` on Every Line and Ignores `G2`/`G3` Arcs
- **Files & Lines:**
  - `src/utils/timeEstimate.ts`: lines 332–421 (`readProgram`)
- **Bug & Real-World Effect:**
  1. `let motion: 0 | 1 | null = null;` is declared **inside** the `for (let index = 0; ...)` loop (line 355) and reset to `null` on every single line. Any G-code line that uses modal `G0`/`G1` (omitting `G0`/`G1` on consecutive coordinate lines) is completely skipped by `readProgram` (`if (motion === null ...) continue;` at line 398), corrupting both time estimates and `locateCut` progress tracking.
  2. `value === 2` and `value === 3` (`G2`/`G3` arcs) are ignored at lines 366–368, so arc moves are completely skipped and their endpoint coordinates `(nx, ny, nz)` are never updated.
- **Suggested Fix:**
  - Hoist `let motion: 0 | 1 | null = null;` outside the line loop in `readProgram`, and treat `G2`/`G3` as `motion = 1`.

---

### 1.15 MEDIUM: `ToolpathView.tsx` Colours Roughing vs Finishing by `m.feed === options.roughingFeedrate`
- **Files & Lines:**
  - `src/components/ToolpathView.tsx`: lines 35, 84–86 (`buildPreviewPath`), line 420
- **Bug & Real-World Effect:**
  - Line 420 distinguishes roughing from finishing via `const c = m.feed === options.roughingFeedrate ? ROUGH : FINISH;`. Whenever `roughingFeedrate === finishingFeedrate`, every finishing move is coloured as roughing (`ROUGH`), and plunge moves on roughing segments (timed with `finishingPlungeRate` on line 86) are coloured as `FINISH`.
- **Suggested Fix:**
  - Tag `TimedMove` / `ClockedMove` with `pass?: 'roughing' | 'finishing'` from `seg.type` in `buildPreviewPath`.

---

### 1.16 LOW: `livePlayhead.ts` Can Jump Forward Across Adjacent Scanlines/Passes Within `LIVE_SEARCH_WINDOW`
- **Files & Lines:**
  - `src/utils/livePlayhead.ts`: lines 12–15 (`LIVE_SNAP_TOLERANCE_MM = 6`, `LIVE_SEARCH_WINDOW = 4000`), lines 43–74 (`nearestWithin`)
- **Bug & Real-World Effect:**
  - `nearestWithin` picks the global minimum `distanceSqToMove` across the next 4,000 moves within a 6 mm radius without penalizing index jump distance. On dense relief scanlines (0.2–0.5 mm apart), the playhead can jump several scanlines ahead if a later move is slightly closer to a discretized status report or un-modeled lead-in ramp.
- **Suggested Fix:**
  - Prefer the earliest move within tight tolerance (`<= 0.5 mm`) before falling back to the wider `6 mm` tolerance.

---

## Section 2: 3D & 2.5D CNC Toolpath Generation Bugs

### 2.1 CRITICAL: `opts.safeZ` Completely Ignored on All Mid-Job Rapid Traverses in `reliefCarveExporter.ts`
- **Files & Lines:**
  - `src/utils/reliefCarveExporter.ts`: lines 2043–2044, 2110–2119 (`leadIn`)
- **Bug & Real-World Effect:**
  - Line 2114 computes the rapid traverse height between passes as:
    ```ts
    const traverseZ = Math.min(opts.safeZ, Math.min(0, highest) + TRAVERSE_CLEARANCE_MM);
    ```
    Because `Math.min(0, highest)` is **always `<= 0`**, `Math.min(0, highest) + TRAVERSE_CLEARANCE_MM` is **at most `TRAVERSE_CLEARANCE_MM` (`1.0 mm` when mesh leveling is off)**. Whenever `opts.safeZ > 1.0` (default is `5.0 mm`, and users often set `15–25 mm` to clear clamps, screws, or warped stock), `Math.min(opts.safeZ, ...)` **clamps every rapid traverse in the job to `Z <= 1.0 mm`**, completely ignoring `opts.safeZ`! Worse, when `applyMeshLeveling` is enabled on a bed with `spanZ > opts.safeZ - 1`, `Math.min(opts.safeZ, ...)` clips away the mesh-leveling span clearance that line 2044 added.
- **Suggested Fix:**
  - Never cap the mesh-leveling `spanZ` expansion with `Math.min(opts.safeZ, ...)`, and for rapid traverses over uncut stock (`highest >= -1e-6`) or long XY rapid moves between pockets/islands, retract to `Math.max(opts.safeZ, TRAVERSE_CLEARANCE_MM)`.

---

### 2.2 CRITICAL: Catastrophic Tool Overload in 3D Adaptive Roughing on Sloped/Stepped Surfaces
- **Files & Lines:**
  - `src/utils/reliefCarveExporter.ts`: lines 2384–2385, 2522, 2543–2585 (`emitAdaptiveLayer`)
  - `src/utils/adaptiveClearing.ts`: lines 135–138, 175–221 (`clearingRings`, `stepdownForEngagement`, `feedForEngagement`)
- **Bug & Real-World Effect:**
  - `clearingRings` assumes each slab is a flat-bottomed 2.5D pocket where Ring 0 (the outermost slotting ring, `engagement = 1`) clears all the way down to `layerZ`, leaving open air on the outside of Ring 1, Ring 2, etc. (`engagement = stepover / toolDia`, e.g. `0.2`). Based on that assumption:
    - `stepdownForEngagement` boosts the layer stepdown `layerStep` by up to `3.4x` (or `1.5 * toolDia`),
    - Ring 0 is split into `bites = 3..4` shallow depth passes at a reduced feedrate, while
    - Ring 1+ are cut in **1 single full-depth pass (`bites = 1`) at up to `160%` boosted feedrate (`feedForEngagement`)**.
  - **However**, `emitAdaptiveLayer` builds `layerRegion(layerTop)` and sets each vertex's Z to `slabZ(x, y, layerZ, layerTop)` (line 2565), which rides up onto the 3D surface! On any sloped wall or stepped shelf inside `layerRegion(layerTop)`, Ring 0 sits near the top of the slope (`z ≈ layerTop`, cutting almost `0 mm` deep), while Ring 1 (`stepover` further inward) drops down the slope toward `layerZ`. Because Ring 0 did NOT cut below `slabZ(Ring 0)`, the material outside Ring 1 below `slabZ(Ring 0)` is **100% solid uncut stock**. Ring 1 then plunges to the full `3.4x`-boosted `layerZ` in a single bite (`bites = 1`) and drives into a full-width slot at `160%` feedrate, snapping the cutter.
- **Suggested Fix:**
  - Either build `layerRegion` at `layerZ` (constant-Z 2.5D terrace clearing down to `layerZ`, where `roughTargetAt(x, y) <= layerZ` is guaranteed across the entire region so outer rings always clear down to `layerZ`), or measure actual radial/axial engagement of each ring segment against `stock.deepestCut` before boosting stepdown or feedrate.

---

### 2.3 HIGH: Adaptive Roughing Rings Around Islands Are Cut Backwards (Conventional Milling + Inside-Out Order)
- **Files & Lines:**
  - `src/utils/adaptiveClearing.ts`: lines 81–94, 148–154
  - `src/utils/reliefCarveExporter.ts`: lines 2503–2515 (`emitAdaptiveLayer`)
- **Bug & Real-World Effect:**
  - When a pocket contains an interior island/boss (`mask[i] === 0`), `clearanceField` measures distance from both the outer pocket boundary and the island boundary.
    1. At `inset = k * step`, `isoContours` emits an outer loop (shrinking inward as `k` increases) and an island loop (growing **outward** as `k` increases).
    2. In `emitAdaptiveLayer` (line 2510), `const parent = previous.find((p) => insideLoop(loop[0], p.loop))` assumes child rings (`k`) lie *inside* parent rings (`k - 1`). For island loops, ring `k` is *larger* than ring `k - 1`, so `insideLoop` is false against the `k - 1` island loop and instead attaches the `k >= 1` island loops to the outer pocket loop, while leaving the `k = 0` island loop as a separate root cut *after* all the `k >= 1` island loops.
    3. In `adaptiveClearing.ts:148`, `orientForClimb(loop, 'inside')` winds every loop assuming uncut stock is on the interior of the loop. For an island loop expanding outward from the island, the uncut stock is on the *outside* of the loop, so `orientForClimb(..., 'inside')` forces **conventional milling** instead of climb milling.
- **Suggested Fix:**
  - Distinguish outer pocket contours from inner island contours (via `nestingDepths` or signed area of marching squares), orient island loops with `'outside'`, and build the containment hierarchy accurately.

---

### 2.4 HIGH: Finishing Waterline (`contour` & `hybrid`) Cuts Deep Wall Levels Before Upper Levels
- **Files & Lines:**
  - `src/utils/finishingPaths.ts`: lines 374–445 (`contourPasses`), lines 555–563, 600 (`hybridPassGroups`)
  - `src/utils/reliefCarveExporter.ts`: lines 2893, 2968–2984 (`machineSurface`)
- **Bug & Real-World Effect:**
  - `contourPasses` (`finishingPaths.ts:374`) and `hybridPassGroups` (`finishingPaths.ts:555`) flatten all waterline Z levels (`-step, -2*step, ..., floorZ`) into a **single group** (`Point2D[][]`).
  - Then `machineSurface` (`reliefCarveExporter.ts:2968–2984`) reorders all runs within a group using a **purely 2D `(x, y)` nearest-neighbor greedy search** (`Math.hypot(runs[i][k].x - atX, runs[i][k].y - atY)`), completely ignoring Z. When moving from the bottom of one steep wall to a neighboring steep wall (or across split segments of a wall), the tool picks the **deepest** waterline (`floorZ`) of the next wall first and machines upward from bottom to top, burying the finishing cutter under all the uncut stair-step material of the upper levels.
- **Suggested Fix:**
  - Return each waterline Z level as its own sub-group (ordered top-down from `-step` to `floorZ`), or restrict the greedy nearest-neighbor selector in `machineSurface` so a waterline run at level `z` can only be selected after all runs at higher levels (`> z`) have been completed.

---

### 2.5 HIGH: Missing Z Retract Before Initial XY Rapid in CNC Framing & Missing Facing-to-Profile Tool Change in `gcodeExporter.ts`
- **Files & Lines:**
  - `src/utils/gcodeExporter.ts`: lines 827–838 (`generateFramingGcode`), lines 71, 88, 148, 155, 161, 558–585 (`generateLaserCutGcode`)
- **Bug & Real-World Effect:**
  1. **Missing Z retract before initial XY rapid in `generateFramingGcode` (lines 827–838):** Line 827 emits `G0 X${formatNum(minX)} Y${formatNum(minY)} F${options.travelFeedrate}` **before** checking `options.machineMode`. Only on line 838 (inside the `else` branch for CNC mode) does it emit `G0 Z${formatNum(options.safeZ)}`. If the operator has just zeroed the bit on the stock surface (`Z = 0`), clicking Frame rapids across the stock to `(minX, minY)` with the bit touching the surface before lifting to `safeZ`.
  2. **Missing tool change between facing cutter (`25 mm`) and profile cutter (`3.175 mm`) (lines 558–585):** `options.pauseOnToolChange` is defined (line 88) and defaulted to `true` (line 155), but is **never read anywhere in `gcodeExporter.ts`**. When `faceToThickness` is enabled in CNC mode (lines 558–579), `facingLines` surfaces the panels using `facingBitDiameterMm` (default `25 mm`), and then at line 581 the program immediately plunges into interior cutouts and panel outlines sized for `bitDiameterMm` (default `3.175 mm`) without stopping the spindle or pausing for a tool change.
  3. **Facing pass goes to negative XY (`-12.5 mm`) and under-reports bounds (lines 402–405, 470–473, 714–719):** `facingLines` starts at `x0 = pos.x - r, y0 = pos.y - r` (`r = 12.5 mm`), driving into negative X/Y coordinates outside work origin `(0, 0)`, while `bounds` only expands by `bitDiameterMm / 2` (`1.588 mm`).
  4. **Facing pass leaves an uncut strip up to `stepover` (`15 mm`) wide at `y1` (lines 415–428):** In `for (let y = y0; y <= y1 + 1e-6; y += stepover)`, if `y1 - y0` is not an exact multiple of `stepover`, the loop terminates before reaching `y1`, leaving an uncut strip up to `stepover` wide along the top edge of the panel.
- **Suggested Fix:**
  - Emit `G0 Z${formatNum(options.safeZ)}` before `G0 X... Y...` in `generateFramingGcode`.
  - Emit a tool-change pause (`M5`, `G0 Z<safeZ>`, `G0 X0 Y0`, `T2 M6` / `M0`) after facing when `options.pauseOnToolChange` is enabled and tool diameters differ.
  - Step evenly from `y0` to `y1` using `steps = Math.max(1, Math.ceil((y1 - y0) / stepover))` in `facingLines`, and include `facingBitDiameterMm / 2` in `bounds`.

---

### 2.6 HIGH: Surface Link Moves (`link`) Omit `squareUpWalls` and Ignore Outer-Radius Stock Collisions When Roughing Is Enabled
- **Files & Lines:**
  - `src/utils/reliefCarveExporter.ts`: lines 2868, 3001–3030 (`link`)
- **Bug & Real-World Effect:**
  1. Line 3013 builds `candidate = simplifyPass([{ x: atX, y: atY, z: atZ }, ...pts], PATH_SIMPLIFY_MM)` **without calling `squareUpWalls`**. If a link crosses a steep step between two passes, it drives diagonally through the top edge of the wall, gouging it.
  2. Line 2868 sets `const linkRimMm = opts.roughingEnabled ? Infinity : linkBiteMm;`, and line 3018 only checks `stock.deepestCut` within `cutter.radius / 2`. Whenever roughing used a larger bit (e.g. `6.35 mm`) that could not enter a narrow valley or corner, full-height uncut stock remains where the outer half (`r/2 .. r`) of the finishing cutter passes during a link move, and `linkRimMm = Infinity` allows the link to plow straight through it without lifting.
- **Suggested Fix:**
  - Pass `[{ x: atX, y: atY, z: atZ }, ...pts]` through `squareUpWalls` before `simplifyPass`, and bound `linkRimMm` even when `roughingEnabled` is true (e.g. `Math.max(linkBiteMm, roughingStepdownMm + roughingAllowanceMm)`).

---

### 2.7 HIGH: `pinBore` Plunges Blind Holes at `4x` Plunge Feedrate When `pinDiaMm ≈ toolDiaMm` and Ignores Cutter Flute/Stickout Reach in `solidMachiningExporter.ts`
- **Files & Lines:**
  - `src/utils/solidMachiningExporter.ts`: lines 636–667 (`pinBore`), lines 918–934, 1054–1070
- **Bug & Real-World Effect:**
  1. When `pinDiaMm === toolDiaMm` (e.g. `6.35 mm` cutter and `6.35 mm` pin), `r = (pinDiaMm - toolDiaMm) / 2 = 0`. `pinBore` (lines 656–663) emits **312 collinear vertical moves straight down at `feedRate` (`1200 mm/min`, 4x the `300 mm/min` plunge rate)** with zero pecking to `Z = -(stockT + pinDepthMm)`, followed by 24 duplicate zero-length moves at the bottom of the hole.
  2. `pinBore` goes to `-(stockT + opts.pinDepthMm)` (e.g. `-30 mm` on a `22 mm` block), which is more than twice `depthA` (`11.5 mm`), without checking whether the roughing tool's flute length or collet stickout (`toolStickoutMm`) can reach `stockT + pinDepthMm` without crashing the collet nut into the stock.
  3. Registration pin placement (line 924) only checks `!frameMask[k]` at the single center cell `k` of the pin, allowing an `8 mm` pin hole to overlap the moat or part when `stockWidthMm` is tight.
- **Suggested Fix:**
  - When `r < 0.25 mm`, emit a peck-drilling cycle at `plungeRate` instead of 312 moves at `feedRate`; check `stockT + opts.pinDepthMm` against tool flute length/stickout; verify `dist[k] * res >= moat + opts.pinDiaMm / 2 + 1` for pin centers; and record pin bore segments in `segments` and `cutDistance`.

---

### 2.8 HIGH: Duplicate Coincident Tabs, Midplane-Disconnected Tabs, and Unclamped Deep Cavities in Two-Sided Solid Machining
- **Files & Lines:**
  - `src/utils/solidMachiningExporter.ts`: lines 572–624 (`placeTabs`), lines 912–914, 976–988 (`surfaceFor`)
  - `src/utils/reliefCarveExporter.ts`: lines 3142, 3228–3259, 3317–3330 (`addHoldingTabs`)
- **Bug & Real-World Effect:**
  1. **Coincident tabs in `placeTabs`:** When searching around the outline for `count` tabs, there is no minimum distance check preventing two target bearings `i` from selecting the exact same or adjacent outline cells, falsely reporting `4` tabs placed when multiple tabs overlap on the same spot.
  2. **Midplane tabs floating in air:** On a two-sided job, `tabTopZ` is placed at the stock midplane `-(stockT / 2 - tabThicknessMm / 2)` (line 913). If the part's outer edge at `(p.c, p.r)` does not span the midplane (e.g. a tapered part, hemisphere, or stepped flange where `[bottom[k], top[k]]` at the outline is entirely above or below `-stockT / 2`), the tab is machined at the midplane while the part next to it is machined away at the midplane—leaving the tab connected to empty air.
  3. **Unclamped cavity depth in `surfaceFor` (line 982):** `h = side === 'A' ? top[src] : -stockT - bottom[src]` allows either side to cut all the way down to `-stockT` inside a deep pocket or thin top/bottom feature, exceeding cutter stickout/flute reach.
  4. **Paper-thin rim tabs in `addHoldingTabs` (`reliefCarveExporter.ts:3142`):** `isCutThrough` checks `z <= stockBottomZ + 1e-6`. If a tapered edge has `z = stockBottomZ + 0.1 mm`, `addHoldingTabs` anchors the tab to that `0.1 mm` foil instead of spanning into material at least `tab.heightMm` thick.
- **Suggested Fix:**
  - Filter `outline` candidates in `placeTabs` to cells whose `[bottom[k], top[k]]` overlaps the tab Z span (or adjust tab Z per cell) and enforce minimum spacing between tab centers; cap cavity depth per side to cutter reach; and seed `addHoldingTabs` distance from cells with `z >= stockBottomZ + tab.heightMm`.

---

### 2.9 MEDIUM: Roughing Cutter Surface Speed Not Checked Against `spindleRpm` & Tool Change Does Not Park XY at `(0, 0)`
- **Files & Lines:**
  - `src/utils/reliefCarveExporter.ts`: lines 682–684 (`deriveReliefFeeds`), lines 793–796 (`recommendReliefTooling`), lines 1786–1806, 2708–2731 (`machineSurface`)
- **Bug & Real-World Effect:**
  1. `deriveReliefFeeds` sets `spindleRpm` from the smaller finishing tool (`finish.rpm`) and scales `roughFeed` up proportionally (`rough.feedMmMin * (rpm / rough.rpm)`). When cutting aluminium or acrylic with a `1.5–3.175 mm` finishing bit (`18,000 RPM`) and a `6.35 mm` roughing bit (whose surface-speed limit in aluminium is `~7,500 RPM`), the roughing bit runs at `2.4x` its maximum surface speed and `roughFeed` is never clamped to `maxFeedMmMin`.
  2. At `T2 M6` (lines 2708–2731), the spindle stops in-place at `(atX, atY)` over the carved roughing pocket instead of parking at `G0 X0 Y0` where uncut reference stock or the corner touch-plate sits.
- **Suggested Fix:**
  - Clamp `roughFeed` to `maxFeedMmMin`, check `opts.roughingToolDiaMm` against `maxSurfaceSpeedMMin` (or emit separate `M3 S<roughRpm>` and `M3 S<finishRpm>`), and park at `G0 X0 Y0` after lifting to `safeZ` on tool change.

---

### 2.10 MEDIUM: Geometry & Mesh Helper Bugs (`polygonOffset.ts`, `marchingSquares.ts`, `moldExporter.ts`, `castPatternExporter.ts`)
- **Files & Lines:**
  - `src/utils/polygonOffset.ts`: lines 238, 358–427 (`segmentIntersection`, `splitLoops`)
  - `src/utils/marchingSquares.ts`: lines 50–53, 104–111, 143–192 (`key`, `isoContours`, `chainSegments`)
  - `src/utils/moldExporter.ts`: lines 506–530, 727, 833–843
  - `src/utils/castPatternExporter.ts`: lines 764–792
- **Bug & Real-World Effect:**
  1. **Interleaved self-crossings (`A ... B ... A ... B`) in `polygonOffset.ts` (`splitLoops`):** Popping `A ... B ... A` from the single vertex stack deletes `B` from `seenAt` without splitting at `B`, leaving figure-8 self-intersections or causing Stage 3 (`distToLoops < keepDist`) to discard valid offset loops.
  2. **1-ULP key mismatch across adjacent cells in `marchingSquares.ts`:** Edge 2 is interpolated `c + 1 -> c` while the neighbor's Edge 0 is interpolated `c -> c + 1`. Near half-integer boundaries of `Math.round(p.x * 4096)` (e.g. `t = 0.5`), `key(p)` differs by 1 between adjacent cells, causing `chainSegments` to see an open contour and silently drop the entire loop.
  3. **`moldExporter.ts` sprue/vent placement & coarse-grid sealing:** Sprue at `(0, 0)` and vents at `(±0.6 * halfW, ∓0.6 * halfD)` miss ring/hollow/circular cavities; and `buildHalf` requires all 4 corners of a grid cell to have `d <= ch.innerR` (`0.75 mm` for a `1.5 mm` vent) on a `0.8–1.5 mm` grid, sealing the vent holes shut with solid triangles.
  4. **`castPatternExporter.ts` floating gating when `partingZ > 0`:** Downsprue, runner, gate, and riser start at `z0 = partingZ` instead of extending down to the `Z = 0` print bed, floating in mid-air.
- **Suggested Fix:**
  - Trace planar intersection cycles in `splitLoops`; interpolate marching-squares edges in canonical `(c -> c + 1, r -> r + 1)` order or key by integer grid-edge ID; place mold sprue/vents at cavity `hit === 1` extrema and mark the nearest grid cell open; and extend casting sprue/riser bases to `Z = 0`.

---

## Section 3: Laser Cutting, Contour Slicing & Sheet CNC Bugs

### 3.1 CRITICAL: Multi-Sheet Y-Coordinate Accumulation & Per-Layer (Instead of Per-Sheet) Pause Bug in Contour Slicing
- **Files & Lines:**
  - `src/utils/contourSliceExporter.ts`: lines 81–101, 1219–1231, 1278–1294
  - `src/utils/gcodeExporter.ts`: lines 908–933, 957–963 (`generateContourSliceGcode`)
- **Bug & Real-World Effect:**
  1. **Runaway Y coordinates on Sheet 2+:** `contourSliceExporter.ts` line 1226 bakes `+ sheetIndex * sheetHeightMm` directly into `layer.placedPos2D.y`:
     ```ts
     layer.placedPos2D = { x: currentX, y: currentY + sheetIndex * sheetHeightMm };
     ```
     and never stores `sheetIndex` on `ContourLayer`. When `generateContourSliceGcode` (`gcodeExporter.ts` lines 957–963) offsets every loop point by `layer.placedPos2D.y`, every sheet after Sheet 0 has its G-code Y coordinates shifted by `+sheetIndex * sheetHeightMm` (e.g. `+400 mm`, `+800 mm`, `+1200 mm`), driving the gantry into the rear hard stop or triggering a soft-limit alarm as soon as Sheet 2 starts.
  2. **Spurious `M0` pause & park between every layer on the same sheet:** In `gcodeExporter.ts` lines 908–933, `generateContourSliceGcode` iterates over `layers` (`lIdx`) rather than sheets (`sheetIndex`) and emits `G0 X0 Y0` + `M0 (PAUSE: Insert Slice Layer ...)` before **every single layer** (`if (lIdx > 0)`), even when multiple contour layers are nested side-by-side on the same physical sheet.
- **Suggested Fix:**
  - Add `sheetIndex?: number` to `ContourLayer`, keep `layer.placedPos2D = { x: currentX, y: currentY }` in sheet-local coordinates (only adding `sheetIndex * (sheetHeightMm + SHEET_GAP_MM)` when rendering the stacked SVG), and group `layers` by `sheetIndex` in `generateContourSliceGcode` so `M0` pauses only occur between physical sheets.

---

### 3.2 CRITICAL: Contour Slicing Cuts Outer Perimeter Before Inner Holes & Dowel Pin Holes (and Places Holding Tabs on Inner Holes)
- **Files & Lines:**
  - `src/utils/contourSliceExporter.ts`: lines 703–713, 1085–1087
  - `src/utils/polygonOffset.ts`: lines 609–631 (`offsetNestedLoops`)
  - `src/utils/gcodeExporter.ts`: lines 945–991 (`generateContourSliceGcode`)
- **Bug & Real-World Effect:**
  - `contourSliceExporter.ts` appends alignment dowel pin holes at the very end of `layer.loops` (line 1086), and `offsetNestedLoops` (`polygonOffset.ts:618`, called from `gcodeExporter.ts:947`) pushes outer contours *before* child holes.
  - `generateContourSliceGcode` then cuts `cutPaths` in that order—cutting the **outer boundary of each slice first** (freeing the part to drop or shift on the bed) and **then** attempting to cut interior holes and alignment dowel pin holes inside the loose part.
  - Additionally, line 987 calls `planAttachments` on every loop in `cutPaths`, putting holding tabs on interior holes and dowel holes.
- **Suggested Fix:**
  - Compute `depths = nestingDepths(cutPaths)` in `generateContourSliceGcode` and sort `cutPaths` by `depth` **descending** (innermost holes and dowel holes first, outer boundary last), and only apply `planAttachments` to even-depth (`depths[i] % 2 === 0`) outer contours.

---

### 3.3 HIGH: Multi-Thickness Stock Rack Cut Depth Bug in CNC Mode
- **Files & Lines:**
  - `src/components/ExportLaserCutModal.tsx`: lines 385–408, 1361–1363
  - `src/utils/gcodeExporter.ts`: lines 521–670, 777–788 (`generateLaserCutGcode`)
- **Bug & Real-World Effect:**
  - While `ExportLaserCutModal.tsx` line 1362 passes `sheetStockThicknessMm: exportResult.sheets?.map(s => s.thicknessMm)` to `simulateSheetCut` for the 3D preview, lines 389–407 fail to pass `sheetStockThicknessMm` to `generateLaserCutGcode`. `generateLaserCutGcode` uses a single global `options.cutDepthZ` (Row 1 of the stock rack) for every sheet—either failing to cut through thicker sheets or plunging deep into the spoilboard on thinner sheets.
- **Suggested Fix:**
  - Add `sheetStockThicknessMm?: number[]` to `GcodeExportOptions`, pass it from `ExportLaserCutModal.tsx`, and override `cutDepthZ` per sheet in `generateLaserCutGcode`.

---

### 3.4 HIGH: Kerf Compensation Missing on Contour Slice Loops in Laser Mode & Double-Compensated on Dowel Holes in CNC Mode
- **Files & Lines:**
  - `src/utils/contourSliceExporter.ts`: lines 43, 1067–1088
  - `src/components/ExportContourSliceModal.tsx`: lines 289, 628–644
  - `src/utils/gcodeExporter.ts`: lines 227–231, 945–955
  - `src/utils/laserCutExporter.ts`: lines 1909–1915, 2482–2488
  - `src/components/ExportLaserCutModal.tsx`: line 338
- **Bug & Real-World Effect:**
  1. **Zero kerf offset on contour slice loops in Laser mode:** `contourSliceExporter.ts` only subtracts `options.kerf / 2` from dowel pin hole radii (line 1067) and never offsets `layer.loops`, while `compensationRadius(options)` in `gcodeExporter.ts` returns `0` when `machineMode === 'laser'`.
  2. **Double offset of dowel pin holes in CNC mode:** `ExportContourSliceModal.tsx` line 289 passes `kerf: f.kerfMm / 1000` even in CNC mode. `contourSliceExporter.ts` shrinks pin holes by `kerfMm / 2`, and then `generateContourSliceGcode` shrinks all loops (including pin holes) again by `bitDiameterMm / 2`. Similarly, `ExportLaserCutModal.tsx` line 338 passes `kerf: f.kerfMm / 1000` in CNC mode even though `offsetRegion` already compensates by `bitDiameterMm / 2`.
- **Suggested Fix:**
  - Keep dowel pin holes at nominal `pinRadiusMm` in `contourSliceExporter.ts` and offset all `layer.loops` uniformly by `kerf / 2` in laser mode or `bitDiameterMm / 2` in CNC mode; and pass `kerf: 0` when `machineMode === 'cnc'`.

---

### 3.5 HIGH: Laser `M3` Constant Power Corner Over-Burning & `M5` Planner Sync Dwell at Holding Tabs
- **Files & Lines:**
  - `src/utils/gcodeExporter.ts`: lines 620–626, 756–774, 831–836
- **Bug & Real-World Effect:**
  1. **`M3` vs `M4`:** `generateLaserCutGcode` and `generateContourSliceGcode` emit `M3 S...` (constant laser power mode) instead of `M4 S...` (GRBL dynamic laser power mode). When the motion planner decelerates into tight finger-joint corners or dense contour vertices, `M3` keeps the laser at 100% power at near-zero speed, charring corners.
  2. **`M5` stop at every holding tab:** At lines 766–770, skipping across an attachment gap emits `M5 ; attachment`, `G1 X... Y...`, `M3 S...`. In GRBL (`$32=1`), `M5` and `M3` force a full planner buffer sync (bringing the head to a complete stop before and after every tab), scorching both sides of every holding tab.
- **Suggested Fix:**
  - Use `M4 S${sValue}` for laser cutting/engraving, modulate across holding tabs in-flight with `G1 X... Y... S0 ; attachment` and `G1 X... Y... S${sValue}`, and finish with `M5 S0`.

---

### 3.6 HIGH: CNC Corner Relief (`dogbone` / `tbone`) Inscribed Polygon Collapses Under `offsetRegion` & Defaults to `'none'` in CNC Mode
- **Files & Lines:**
  - `src/utils/laserCutExporter.ts`: lines 2271–2462 (`applyCornerRelief`)
  - `src/utils/gcodeExporter.ts`: lines 227–231, 591–595
  - `src/components/ExportLaserCutModal.tsx`: lines 179, 695–705, 900–910
- **Bug & Real-World Effect:**
  1. `cornerRelief` defaults to `'none'` in `ExportLaserCutModal.tsx` (line 179) even when switching `machineMode` to `'cnc'`, leaving all internal finger-joint corners rounded by `bitRadius` unless the user finds the setting under `Joints -> Advanced`.
  2. When `'dogbone'` or `'tbone'` *is* selected, `applyCornerRelief` (`laserCutExporter.ts:2404–2410`) unions a circle of radius `R = bitDiameter / 2` approximated by a coarse 4–8 segment inscribed polygon (`apothem = R * cos(π / steps) < R`). When `generateLaserCutGcode` subsequently calls `offsetRegion(..., R)`, offsetting the narrower inscribed polygon inward by `R` pinches off short of the dogbone center `r.c`, leaving an unrelieved corner stub.
- **Suggested Fix:**
  - Auto-select `cornerRelief: 'dogbone'` when switching `machineMode` to `'cnc'` (if currently `'none'`), and in `applyCornerRelief` increase arc steps and circumscribe the polygon radius by `R / Math.cos(Math.PI / steps) + 1e-3`.

---

### 3.7 MEDIUM: Underside Engraving Unmirrored Panel Bug, Ghost Empty Sheet 0 in Contour Slicing, and Un-Flipped Side B Bed Leveling
- **Files & Lines:**
  - `src/utils/laserCutExporter.ts`: lines 664–688, 2926–2935 (`attachPatternEngraving`)
  - `src/utils/contourSliceExporter.ts`: lines 1132–1140, 1215–1224
  - `src/components/ExportSolidMachiningModal.tsx`: lines 134–142
  - `src/components/ExportContourSliceModal.tsx`: lines 321–341
- **Bug & Real-World Effect:**
  1. **Underside engraving (`attachPatternEngraving`):** When a textured face has `facing < 0` (on `-normal3D`), it is engraved onto the `+normal3D` face without mirroring the panel's 2D frame (`u -> -u`), and the user is told to flip the panel over during assembly—which mirror-inverts any asymmetric panel outline, cutouts, or finger joints so the box cannot assemble.
  2. **Empty Ghost Sheet 0 (`contourSliceExporter.ts:1135, 1219`):** If the very first layer on Sheet 0 has `h + 2 * marginMm > sheetHeightMm` (when `autoScaleToFit` is off), `if (currentY + h + marginMm > sheetHeightMm)` triggers when `currentX === marginMm && currentY === marginMm`, incrementing `sheetIndex++` and leaving Sheet 0 completely empty.
  3. **Bed Leveling (`probedGrid` / `warpGcode`):** `ExportContourSliceModal.tsx` lacks `probedGrid` / `warpGcode` support in CNC mode. In `ExportSolidMachiningModal.tsx` (lines 134–142), `warpGcode(res.sideBGcode, probedGrid)` applies the un-mirrored `probedGrid` to `sideBGcode` (and `solidMachiningExporter.ts` itself does not yet consume `meshLevelGrid` when invoking `machineSurface` for Side A / Side B).
- **Suggested Fix:**
  - Flip `uAxis3D` and `normal3D` before 2D projection when a panel's only textured face is on `-normal3D`; guard sheet advance in `contourSliceExporter.ts` with `(currentX > marginMm || currentY > marginMm)`; and add `probedGrid` support to `ExportContourSliceModal.tsx` and proper Side B grid handling in `solidMachiningExporter.ts`.

---

## Section 4: Sub-Optimal G-Code Paths & Toolpath Inefficiencies

### 4.1 HIGH: Pessimistic `StockModel.highestUnder` Defeats `expectedEntryZ` Near Any Wall or Boundary, Causing Massive Air-Ramping and Unnecessary Retracts
- **Files & Lines:**
  - `src/utils/reliefCarveExporter.ts`: lines 2088–2090, 2570–2578, 3049–3050 (`leadIn`, `emitAdaptiveLayer`, `machineSurface`)
  - `src/utils/stockModel.ts`: lines 154–160 (`cut`), lines 203–214 (`highestUnder`)
- **Sub-Optimality & Real-World Effect:**
  - `StockModel.cut` (`stockModel.ts:154`) only lowers a cell when its **farthest corner** is within `radius`, while `StockModel.highestUnder` (`stockModel.ts:210`) queries all cells whose centers are within **`radius + cell * Math.SQRT1_2`** and ignores the cutter profile (`FLAT_PROFILE` vs `ballProfile`/`vProfile`).
  - Consequently, around the perimeter of every pocket, on every waterline pass, and between consecutive depth bites (`bite = 1 .. bites`) of the exact same adaptive ring (`lines 2570–2578`), `stock.highestUnder(head.x, head.y, cutter.radius)` touches the 1-cell unlowered halo just outside `radius` and returns **`0` (`Z = 0`, the uncut top of the stock)**.
  - As a result, `entryZ` is forced back to `0`, completely defeating `expectedEntryZ`! On multi-bite adaptive rings, instead of staying down in the slot at `(head.x, head.y)` between Bite 1 and Bite 2, the tool retracts all the way above `Z = 0`, emits a zero-length `G0 X<head.x> Y<head.y>`, and ramps through empty air from `Z = 0` all the way back down to Bite 2.
- **Suggested Fix:**
  - In `emitAdaptiveLayer` (lines 2570–2585), when `bite > 1`, ramp directly from `above` to `biteFloor` along `path` without calling a full retract/rapid `leadIn`.
  - In `leadIn`, query `stock` within `cutter.radius` (accounting for `cutter.profile`) rather than `radius + cell * Math.SQRT1_2`.

---

### 4.2 HIGH: Two 180° Direction Reversals and Triple-Cutting on Every Closed-Loop Ramp in `leadIn`
- **Files & Lines:**
  - `src/utils/reliefCarveExporter.ts`: lines 2147–2203 (`leadIn`)
- **Sub-Optimality & Real-World Effect:**
  - When `leadIn` ramps into a closed loop (every adaptive clearing ring, concentric ring, and closed waterline contour), it ramps forward along the first `rampLen` (lines 2177–2181), **stops and reverses 180°** to cut backward to `head` (lines 2197–2202, switching from climb to conventional milling), and then **stops and reverses 180° again** to trace the entire closed loop forward—traversing `rampLen` **three times** with two full stops.
- **Suggested Fix:**
  - When `path` is a closed loop (`hypot(path[0] - path[last]) < 1e-6`), ramp continuously forward along the loop from `0` to `rampLen`, continue forward around the rest of the loop back to `path[0]`, and then finish the first `rampLen` at full depth `z = pz` in the same forward direction.

---

### 4.3 HIGH: Repeated Empty-Air Passes on Multi-Bite Adaptive Rings Over Sloped Ground
- **Files & Lines:**
  - `src/utils/reliefCarveExporter.ts`: lines 2548, 2562–2585 (`emitAdaptiveLayer`)
- **Sub-Optimality & Real-World Effect:**
  - In `emitAdaptiveLayer`, `bites` is computed from the full slab thickness `layerTop - layerZ` (line 2548). However, `onSurface` clamps each point's Z to `slabZ(x, y, layerZ, layerTop)` (line 2565). On a ring near the outer boundary of a sloped region where `min(onSurface.z)` is near `layerTop` (e.g. `-0.3 mm` when `layerTop = 0, layerZ = -4.5 mm, bites = 3`), Bite 1, Bite 2, and Bite 3 all clamp `path.z = Math.max(biteFloor, p.z)` to the exact same `-0.3 mm`, causing the machine to cut the exact same ring 3 times in a row (2 of them in empty air).
- **Suggested Fix:**
  - Compute the ring's actual maximum depth drop `const ringThickness = Math.max(0, layerTop - Math.min(...onSurface.map((p) => p.z)))` and set `const bites = Math.max(1, Math.ceil((ringThickness - 1e-6) / ringStep))`.

---

### 4.4 HIGH: Engraving Path Thrashing (Unordered Marching-Squares Polylines, No Bidirectional Chaining, and 2-Point Zero-Length Burns)
- **Files & Lines:**
  - `src/utils/patternEngrave.ts`: lines 30–34, 45, 104–125, 129–157 (`reliefContours`, `contourAt`, `simplify`)
  - `src/utils/gcodeExporter.ts`: lines 614–627 (`generateLaserCutGcode`)
- **Sub-Optimality & Real-World Effect:**
  1. `reliefContours` extracts iso-contours in grid/hash order, and `generateLaserCutGcode` (lines 619–627) iterates `for (const line of engraving)` in raw array order without nearest-neighbor sorting or reversing open polylines (`line.reverse()`) when the current head position is closer to the end of a polyline—increasing rapid travel distance and engraving time by **2x–5x**.
  2. In `patternEngrave.ts` (`simplify`, lines 129–157), because closed loops have `line[0] === line[last]`, the initial baseline has zero length (`l2 === 0`). If all vertices of a small closed loop lie within `tolerance` of `line[0]`, `simplify` drops every interior point and returns `[line[0], line[0]]` (`length === 2`), causing the laser to rapid to `line[0]`, fire `M3`, execute a zero-length `G1`, and turn off `M5`, burning stationary pits.
- **Suggested Fix:**
  - Order `engraving` polylines using greedy nearest-neighbor with open-polyline reversal in `generateLaserCutGcode`, and split closed loops at their farthest vertex in `simplify` (filtering out zero-length loops in `patternEngrave.ts`).

---

### 4.5 HIGH: Unordered Cutouts, Contour Loops & Sub-Optimal Start Vertices (`loop[0]` Corner Plunging) + Air-Cutting After Facing
- **Files & Lines:**
  - `src/utils/gcodeExporter.ts`: lines 538–540, 560–579, 633–646, 734–811, 964–991
- **Sub-Optimality & Real-World Effect:**
  1. **Unordered cutouts & contour loops:** `holePaths` within each panel (lines 633–646) and same-depth loops in `generateContourSliceGcode` (lines 964–991) are cut in raw array order instead of nearest-neighbor order.
  2. **Piercing/plunging at `loop[0]` (sharp corners):** `generateLoopGcode` (line 743) always starts at `loop[0]` (typically a 90° corner or finger-joint root), dwelling at that corner at both the start and end of every pass instead of rotating the loop to the point closest to `(curX, curY)` on a straight segment.
  3. **Air-cutting from `Z = 0` after `faceToThickness`:** After `facingLines` removes `removalMm` from a panel (lines 560–579), `generateLoopGcode` still starts stepping down from `Z = 0` instead of `Z = -removalMm`, cutting empty air for the first pass(es).
- **Suggested Fix:**
  - Order sibling holes/loops by greedy nearest-neighbor; rotate closed loops to start near `(curX, curY)` on a straight edge; and start faced panel cuts from `z = -removalMm`.

---

### 4.6 MEDIUM: Redundant `F` Word on Every `G1` Line, Invalid `F` Word on `G0` Rapids, Duplicate `G0 Z<safeZ>` Retracts, and Single-Pass `totalCutDistanceMm`
- **Files & Lines:**
  - `src/utils/gcodeExporter.ts`: lines 420–432, 513, 620, 623, 644, 666, 677, 681, 686, 756, 770, 784–785, 801, 803, 807, 827, 989, 1000
- **Sub-Optimality & Real-World Effect:**
  1. **Modal `F` repeated on every `G1` vertex:** Appending ` F1200` (6 bytes) to every 24-byte `G1 X... Y...` line inflates serial volume by ~25% in GRBL's 128-byte RX buffer, reducing buffered lookahead blocks and causing motion stutter on dense curves.
  2. **`F` word on `G0` rapid lines:** `G0 X... Y... F3000` is non-standard and overwrites GRBL's active modal `G1` feedrate register.
  3. **Back-to-back duplicate `G0 Z<safeZ>` lines:** `generateLoopGcode` emits `G0 Z<safeZ>` at both the start (line 784) and end (line 807) of every loop.
  4. **`totalCutDistanceMm` ignores CNC multi-pass stepdown:** Lines 644, 666, and 989 add single-pass loop perimeters without multiplying by `passes`.
- **Suggested Fix:**
  - Track modal `F` and `Z` in `gcodeExporter.ts`, strip `F` from `G0` lines, and multiply CNC loop perimeter by `passes` in `totalCutDistanceMm`.

---

### 4.7 MEDIUM: Concentric / Spiral Finishing Uncut Center Strip & Unsampled Inter-Ring Bridges (`finishingPaths.ts`), plus Double `simplifyPass(squareUpWalls)` (`reliefCarveExporter.ts`)
- **Files & Lines:**
  - `src/utils/finishingPaths.ts`: lines 266–335 (`concentricPasses`, `spiralPasses`)
  - `src/utils/reliefCarveExporter.ts`: lines 2927–2932, 2995 (`machineSurface`)
- **Sub-Optimality & Real-World Effect:**
  1. `concentricPasses` calls `offsetRings(rect, 0, stepover)` on an axis-aligned rectangle `bounds`. When the narrower span has a remainder between `stepover` and `2 * stepover`, the final inward offset collapses to empty, leaving an **uncut strip up to `2 * stepover` wide** down the center line of the relief.
  2. In `spiralPasses` (line 330), the bridge segment between adjacent rings (`<= 3 * stepover`) is concatenated directly without calling `resamplePolyline`, cutting a straight chord across the 3D surface without sampling intermediate Z heights.
  3. In `machineSurface` (`reliefCarveExporter.ts:2927`), `flush()` runs `simplifyPass(squareUpWalls(run), PATH_SIMPLIFY_MM)` just to measure `runLen`, discards the result, and recomputes `simplifyPass(squareUpWalls(r), PATH_SIMPLIFY_MM)` again at line 2995.
- **Suggested Fix:**
  - Generate rectangular concentric insets analytically (adding a center spine pass when a remainder exists), resample spiral bridges at `input.resolution`, and measure `runLen` directly on `run` in `flush()`.

---

### 4.8 LOW: Collinear Segment Bloat After `applyEdgeFeatures` & Flawed `prev` Reference in `simplifyPolygon2D` (`laserCutExporter.ts`) and Sub-Optimal Contour Slice Shelf Packing
- **Files & Lines:**
  - `src/utils/laserCutExporter.ts`: lines 331–375 (`simplifyPolygon2D`), lines 2482–2508
  - `src/utils/contourSliceExporter.ts`: lines 1149, 1201–1231
- **Sub-Optimality & Real-World Effect:**
  1. In `simplifyPolygon2D` (`laserCutExporter.ts:352`), `prev` is read from `cleaned[(i - 1 + cleaned.length) % cleaned.length]` instead of the last kept vertex in `result`, and `simplifyPolygon2D` is not run after `applyEdgeFeatures` (line 2493), leaving collinear segment bloat along straight panel edges.
  2. In `contourSliceExporter.ts`, `evaluateScale` (line 1149) uses a 195-step linear loop (`s -= 0.01`) instead of binary search, and shelf packing (lines 1201–1230) neither sorts layers by height descending nor rotates rectangular layers by 90° to fit the sheet.
- **Suggested Fix:**
  - Use `result[result.length - 1]` as `prev` in `simplifyPolygon2D` and run it after `applyEdgeFeatures`; use binary search for `autoScaleToFit` and support 90° rotation / height-descending shelf packing in `contourSliceExporter.ts`.

---

## Section 5: Independent Flash Sub-Agent Verification Summary

All 41 items in Sections 1.1–1.16, 2.1–2.10, 3.1–3.7, and 4.1–4.8 were independently audited against the source files and test suite:
- **Confirmed:** 39 / 41 items verified as exact matches.
- **Confirmed with Line/Scope Refinements (applied above):** 2 / 41 items (3.4 line citations in `ExportContourSliceModal.tsx:289` and `ExportLaserCutModal.tsx:338`; 3.7 `solidMachiningExporter.ts` does not yet consume `meshLevelGrid` internally, while `ExportSolidMachiningModal.tsx:134–142` calls `warpGcode(res.sideBGcode, probedGrid)` with an un-mirrored grid).
- **False Positives:** 0 / 41 items.
- **Test Suite Precautions Noted During Audit:**
  1. `tests/facingPass.test.ts` asserts specific G-code lines (`X10.000`, `Facing pass 1 of 4`); updating facing stepover or adding a facing-to-profile tool change pause will require updating those test expectations.
  2. `tests/reliefCarveLeadIn.test.ts` checks background approach heights `< -5mm`; closed-loop ramp and `StockModel.highestUnder` fixes should preserve background entry behavior.
  3. `tests/solidMachining.test.ts` verifies `tabsPlaced === DEFAULT_SOLID_OPTIONS.tabCount` (`4`) and registration pin coordinates.
