# Cast: one flow from master to finished piece

On 2026-10-25 the user made a wax candle from a dragon master. It needed a silicone
mold, the mold poured, and the cast checked. It could only be done by an agent. In the
UI the steps are spread over two buttons and four dialogs, and the one that pours
switches on silently depending on the selection. The pour dialog also re-poured once a
second, which is fixed (f3a0cae). This plan puts every route to a cast object behind
the **Cast** button as one stepped flow, and makes each step hand its result to the
next, so nothing has to be re-selected.

## What exists today

| Piece | Where | What it does |
| --- | --- | --- |
| **Mold** button | `BottomStatusBar.tsx:418` → `ExportMoldModal` | opens one of three things depending on the selection (`OpenMoldModal`, `ExportMoldModal.tsx:146`) |
| Mold designer | `MoldDesigner` in `ExportMoldModal.tsx` (1170 lines) | printed clamshell / open / PVA-liner mold of the scene; STL or 3MF; Add Simulation |
| Silicone pour box | `PourBoxModal.tsx` | base, groove, sleeve and wick pin around a master |
| Pour into selection | `PourIntoSelectionModal.tsx` | finds the cavity of selected mold bodies (`pourSelection`), pours from the best side or the side asked for, to a depth, and adds the cast beside it |
| **Cast** button | `BottomStatusBar.tsx:430` → `ExportCastModal` | metal: sand or lost-PLA pattern with shrink and gating; Prepare for Casting (edge breaks, draft) |
| Casting guide | `CastingGuide.tsx` | the steps and quantities for a printed mold |
| DFM casting check | `DfmHUD.tsx:154` (`analyse('cast')`) | undercut and wall warnings |
| Engines | `moldExporter.ts`, `moldCastSimulation.ts`, `pourCast.ts`, `pourTarget.ts`, `castPatternExporter.ts`, `castPrep.ts` | all stay as they are; this is UI work |
| MCP | `physics_make_pour_box`, `physics_add_simulation` (kind mold / mold_cast), `physics_export_cast`, `physics_set_cast_prep` | unchanged tools; the docs gain the flow |

What goes wrong for a person:

- Nothing says the route is master → mold → pour. Pouring is only reachable by selecting
  the mold bodies and then pressing *Mold*, which reads as "make a mold".
- Each step forgets the last: the pour box does not know it was for this master, and the
  pour does not know which bodies are the mold.
- Metal sits under *Cast* and everything else under *Mold*, though both are casting.
- Nothing tells you which way up the finished piece stands (`MOLDS INVERT` in the MCP docs).

## The flow

The **Cast** button opens `CastFlow`, a modal with a step strip across the top. Each step
shows what it is working on and can be revisited. *Mold* leaves the bottom bar; selecting
mold bodies and pressing Cast opens the flow at **Pour** with them filled in.

1. **Master.** The selected bodies, or the whole scene when nothing is selected, shown
   with size and volume. Prepare for Casting (edge breaks; draft for sand) moves here from
   `ExportCastModal`, since it changes the master whatever the route.
2. **Material** decides the route. Each choice shows one line on what it means:
   - *Wax, resin, plaster, soap, chocolate, concrete* → **printed mold** (rigid or PVA-lined)
     or **silicone mold** (for undercuts or many pours). The default comes from the DFM
     undercut check: no undercuts → printed open mold, undercuts → silicone.
   - *Pewter, aluminium, bronze* → **sand** or **lost PLA** (current `ExportCastModal`).
3. **Mold.** The panel for the route: `MoldDesigner` (printed), the pour-box panel
   (silicone: the box, then the silicone poured into it via the existing mold_cast path, so
   the silicone mold is a body in the scene), or the pattern panel (metal). Each ends with
   *Add to scene*. The flow records which bodies it added.
4. **Pour.** The pour panel (today's `PourIntoSelectionModal`), already pointed at the mold
   from step 3: side, fill depth, plug note, undercut warning. For metal this step is the
   pour report (metal volume and weight, flask temperature) with no simulation.
5. **Result.** The cast stood the way the finished piece is used, not the way it left the
   mold: the flow knows the pour side and flips it (closes `MOLDS INVERT` for people). It
   shows volume, weight of the chosen material (grams of wax), deviation from the master
   (max and mean distance, from the measure code), and the Casting guide's steps for this
   route.

Every step's inputs come from the step before. A person can still change them, but never
has to re-select bodies.

### State

`SceneGraph.castFlow` (optional, like `castPrep`): `{ masterIds, material, route,
moldIds, castId, pourSide, fillMm }`. Kept on the graph so save, reload and undo carry it,
and the flow reopens where it was. Bodies the flow adds keep `simulation.kind` ('mold',
'cast') so the exporters still skip them. Anything that changes only the bodies already
passes `{ ...sceneGraph, nodes }` (CLAUDE.md, *updateScene replaces the whole graph*), and
this field rides along.

## Build order

Each phase is shippable and leaves the app working.

1. **Panels out of modals, no behaviour change.** `MoldDesigner` → `MoldPanel.tsx`,
   `PourBoxModal` → `PourBoxPanel.tsx`, `PourIntoSelectionModal` → `PourPanel.tsx`,
   `ExportCastModal`'s body → `MetalPatternPanel.tsx`. Each existing modal becomes a shell
   around its panel, and `ExportMoldModal.tsx` drops well under 1000 lines (no big files).
   Panels take their inputs as props (`ids`, `onAdded(ids)`), not from the selection.
2. **`CastFlow` shell.** Step strip, Master and Material steps, route choice with the
   DFM-derived default, the panels mounted per step. The Cast button opens it; the Mold
   button goes, and the select-a-mold-then-Cast shortcut opens at Pour.
3. **Hand-offs and `castFlow` state.** Panels report what they added and the flow passes it
   on. The flow reopens at the step it was left on.
4. **Result step.** Orientation flip, deviation from the master, material weight, guide.
5. **Agents.** `mcp-docs.json` and `physbox_mcp/.../physics.json` describe the flow, and
   `systemInstructions.txt` gets the same paragraph. No new tool is needed: an agent already
   has every step. Bump and release physbox-mcp.

## Tests

- Route choice: master with/without undercuts × each material → expected route and mold type.
- Hand-off: a flow run headlessly (pure functions under the panels) from master to cast
  leaves `castFlow` naming the right bodies, and the cast's volume matches the cavity.
- Orientation: a master with its top marked comes out of Result top-up for each pour side.
- The candle: the dragon master → silicone → wax, as the user did it, end to end, measured
  against the master (the battery-of-parts rule: run it like the user would).

UI is checked by hand on :5175 with a test list for the user, not by browser automation.

## Out of scope

Multi-part molds beyond two halves, mold boxes with keys for silicone two-part molds,
and kiln schedules. These are worth a line in the Result step's guide, not a step.
