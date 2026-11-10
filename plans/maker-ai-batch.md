# Plan: maker + AI batch (agreed 2026-11-09)

Audience: the AI crowd (agents over MCP, the in-app copilot) and makers / small
shops. Not SolidWorks users. Each item lands as its own commit, UI and MCP with
the same defaults ([[ui-mcp-parity]]). Pushes coalesced.

## 1. Profile import: SVG, and outlines traced from a photo
- `utils/profileImport.ts` (pure): SVG text → loops in mm (fills via their fill
  rule; stroke-only closed paths read as part edges, nested even-odd, since a
  laser file draws its cuts as strokes); image luminance → loops by marching
  squares at a threshold, RDP-simplified, specks dropped; loops → shapes
  (outline + its holes) → OpenSCAD: `thickness` customizer variable,
  `scale(0.001) linear_extrude(thickness) union() { polygon(...) ... }`.
- The body is a SCAD node, so the thickness is a slider, the compile is the scad
  worker's, overlapping fills union, and cutting it into a part is the existing
  Combine → difference. No new worker, no new geometry engine.
- UI: `ImportProfileModal` — SVG or image; for an image which tone is the
  part (auto/dark/light), threshold, detail and size-from-a-known-width. Header button; a dropped `.svg` opens it;
  the relief dialog offers "Trace outline instead".
- MCP: `physics_import_profile` (svg text or path, or image path/data; width,
  thickness, threshold, subject, detail).

## 2. Images in the copilot
Paste / drop / attach an image in `AICopilotPanel`; sent as inline image parts
to Gemini and Claude. `systemInstructions.txt`: reading written dimensions off
a sketch.

## 3. Picture-to-part build/critique loop (copilot)
Builder builds; matches the camera to the photo; a critic call that never saw
the builder's reasoning lists differences between photo and render; a
silhouette-overlap score decides whether a round helped (roll back if not);
measured dimensions checked against written ones; 4-6 rounds, a round counter
and Stop; ends showing photo vs render and what is still off.

## 4. Telemetry summary
Option on the existing telemetry/headless MCP commands for a compact summary:
per body peak speed / displacement / whether it left the scene, per joint peak
force and travel, breaks, settle time. Raw samples stay the default.

## 5. Send to slicer
Open the print export straight in Orca / Bambu Studio / PrusaSlicer.

## 6. Snap-fits and clips
Cantilever snap hook + its catch, lid clip; sized for FDM, placed like the other
hardware cuts.

## Status
(updated as each lands)
- 1 done: 67f0132 + validator fixes 087c7f5 (corner loss in loopSimplify,
  shared with the contour slicer; sheet of paper; knockouts; hidden layers;
  near-closed/segmented strokes; small holes; transparent margins; root
  size; <use href>; text).
- 2 done: 275686d. 3 done: f65c83b + validator fixes 76e83fe (stop restores
  the kept round, unfenced critic, worker view search, hidden-tab hang,
  thumbnails in chat, builder notes/questions/note card). Not yet run
  against a real model in the browser.
- 4 done: acf329c. 6 done: 29a2291. Validator running on both.
- 5 PARKED for a decision: needs a public https URL ending .3mf (new
  physbox_api route, sign-in, deploy first) and the slicers' URL handlers
  may only accept their own sites' domains (PrusaSlicer: printables.com).
- physbox_mcp: 89bb245, f2be205, fb89bc8, 56c2666 unreleased, on top of
  someone else's unpushed 60bb2bc (v0.68.0). New tool physics_import_profile
  needs the count test + website + minor bump + release.
- Suggested by a validator: physics_match_photo (photo -> view + overlap,
  camera turned there) for agents; not built.
