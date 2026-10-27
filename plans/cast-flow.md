# Mold and Cast: fix the journey, don't add to it

**Status (2026-10-26):** phases 1-7 built, uncommitted, each checked by a validator from a
user's and an MCP agent's side. Where the build differs from the text below:

- One `PatternPanel` with a `method` prop, not separate Sand and Lost PLA files.
- The Silicone tab's Draft is fixed at 0 (or the model's baked draft), not editable: a
  silicone cavity is the master's own shape, so there is nothing for draft to act on.
- Rigid's materials include the mold silicones (casting silicone parts in a PLA mold is
  real); only the Silicone tab leaves them out.
- MCP never follows the UI selection: `master_id`, else every body. An agent cannot see
  the selection, and adding a body moves it.
- A pour box's base and sleeve are tagged (`pourBox`) and never molded; a cast records
  what it was poured in (`simulation.material`), so silicone is not offered into silicone.
- Found on the way and fixed: the pour simulation snapped only primitives to its grid,
  which kept a cylinder master out of the union, so silicone filled the master.
- Over MCP the chains are `physics_add_simulation` kind `mold_cast` with `method`.
- physbox-mcp is bumped to 0.46.0 locally; the release waits for the app to deploy.

The rule for this plan: **no job gets longer than it is today**, counted in dialogs,
decisions and re-selects, and checked per job below. Most casting jobs are already one
screen. The mold designer designs the mold *and* simulates the cast
(`ExportMoldModal.tsx:1134`, *Add Simulation*), and the metal dialog shows pattern,
quantities and guide together. That stays. The plan fixes the places where the journey
breaks, so that every job has the same shape whatever is being cast: **press Mold, check
the tab it opened on, export or simulate.** **Cast** pours into a mold you already have.

## What breaks today

1. **Mold guesses from the selection.** With bodies selected it first tries to pour into
   them (`ExportMoldModal.tsx:146-153`). A part that holds liquid, such as a planter, a
   tray or a cup, gets a pour dialog instead of a mold. If a pour into a real mold fails on
   the first try, it silently jumps to the designer and molds the whole scene
   (`PourIntoSelectionModal.tsx:71,87`).
2. **Three kinds of mold are in three places:** the designer behind Mold, the pour box
   behind a link in the designer (`:845`), and the metal pattern behind Cast.
3. **The silicone route takes 4 dialogs, ~3 decisions and 2 re-selects.** The person must
   know to select master + sleeve + base to pour silicone. They must type a fill depth, or
   it fills to the rim. Then they select the silicone mold and pour again. The pour box
   selects nothing it adds (`pourBoxScene.ts`).
4. **Three material lists that don't know about each other:** `CAST_MATERIALS`
   (`moldLiner.ts:43`), `SILICONES` (`siliconeMold.ts:65`) and `CAST_METALS`
   (`castPatternExporter.ts:55`). There are also two material-name branches:
   `moldLiner.ts:94` (epoxy, by volume) and `:100` (wax).
5. **The silicone box's only pin is a candle wick.** It runs from the master's highest point
   (`siliconeMold.ts:9`), and its id and tooltip say so: `wickpin_` (`pourBoxScene.ts:118`),
   "a wick hole for a candle" (`PourBoxModal.tsx:137`).
6. **Nothing says which way up the cast stands** (`MOLDS INVERT` in the MCP docs), or how
   far it is from the master.

## Mold: one dialog, one row of tabs

**Rigid · Silicone · Sand · Lost PLA**

| Tab | What gets printed | Today |
| --- | --- | --- |
| Rigid | the mold: open or clamshell (Auto picks, as today), with the PVA-liner checkbox as today | the designer |
| Silicone | a box round the master; silicone poured into it makes the mold | the pour box |
| Sand | the pattern, with shrink and sand gating | Cast → Sand |
| Lost PLA | the pattern, with shrink, sprue, cup and vents | Cast → Lost PLA |

The method is the tab, so there is no separate method field and no material trigger.

**Which tab it opens on:**

- **The last tab used for this scene**, if there is one. Someone casting metal lands on
  Sand or Lost PLA every time after the first.
- **Otherwise Rigid.** The tab never switches itself. When the designer's own auto choice
  (`moldExporter.ts:1096`) still loses more of the master than `OPEN_MOLD_ALLOWANCE` (1%,
  `:1039`) in its `lostFraction` (`:144`), Rigid shows one line: "A rigid mold would lock
  on here: tick the PVA liner, or use Silicone". Either option is one click, the same as
  today's liner tick.

The hint does not come from the DFM undercut check, which flags an undercut along any one
axis even when another direction pulls clean, and arrives late from a worker. The first
metal job costs one tab click more than pressing Cast does today. Every later one costs
nothing extra.

**What Mold molds:** the selected part (with its children), or the whole scene when
nothing is selected. That is one rule on every tab, as the silicone box already does
(`ExportMoldModal.tsx:155-158`). The dialog names what it is molding ("Molding: dragon",
or "Molding: whole scene (3 parts)"). Simulated bodies (earlier molds and casts) are always
left out, as they already are (`contourSliceExporter.ts:225`). The selection now only ever
means *mold this*, never *pour into this*, which removes today's guessing.

This is new work for Rigid and for the pattern tabs. The designer and the pattern exporter
read the whole scene today (`moldExporter.ts:1132`, `collectSceneTriangles`), so both take
the ids and mold only those subtrees, in their world positions.

**The top of every tab is the same**, and it is all that most people look at:

- **Material**: what the piece is cast in, from one list (below), filtered to what the tab
  can take. Sand and Lost PLA show only metals, defaulting to `aluminium` (as
  `castPatternExporter.ts:113-115` does today). Rigid and Silicone show no metals and no
  silicones, defaulting to `epoxy` (as `ExportMoldModal.tsx:955` does today). The mold's own
  silicone is a separate field under Silicone's Advanced. It is remembered with the tab. Picking the wrong material on
  Rigid is not possible, so no refusal is needed.
- **Draft**: one field, always shown and always changeable. It applies only to what this
  tab makes: the mold cavity on Rigid, the printed pattern on Sand and Lost PLA, the
  silicone cavity on Silicone. It never rewrites the scene. Defaults by tab:
  - **Rigid:** 0°, as today (`moldExporter.ts:110`). There it is a slope limit that costs
    detail, and the dialog's existing warning stays (`ExportMoldModal.tsx:913`).
  - **Sand:** 2°, so the pattern draws from the sand. This is a deliberate change: today a
    sand pattern has no draft unless Prepare for Casting was baked in.
  - **Silicone:** 0°, because it stretches off.
  - **Lost PLA:** 0°, because the pattern burns out.

  If Prepare for Casting is baked into the model, the field shows the baked angle and is
  locked, so draft is never applied twice (`moldExporter.ts:1236` already warns about
  that).
- **Export** and **Add Simulation**, as today.

Everything else goes under the tab's `Advanced` (`ExportFields.tsx:239`), closed, with
today's automatic values:

- gating sizes, and sprue and vent diameters;
- shrink override and edge breaks;
- liner skin;
- the box's walls and clearances;
- the mold silicone (platinum by default; tin);
- the designer's "Keep 3D undercuts" option (`ExportMoldModal.tsx:937`).

The PVA liner checkbox is not hidden: it stays where it is on Rigid, because it is the
rigid answer to a part that locks in.

Prepare for Casting stays as an explicit **Bake into model** action under Advanced on Sand
and Lost PLA, for someone who wants the draft and edge breaks in the model itself. Its
state badge moves from the Cast button (`BottomStatusBar.tsx:419-428`) to the Mold button
("Mold · Cast prep"), since that is now where it is switched off.

**Add Simulation runs the chain to the finished piece, in one click, on every tab:**

- **Rigid:** pours the material into the mold, as today.
- **Silicone:** pours silicone into the box, turns the silicone mold over, and pours the
  material in through its open base. Vents are placed automatically at the high points of
  the turned-over cavity, using the same high-point search the rigid mold and lost-PLA
  pattern use. If the open base is too small to pour through (a master on a narrow foot),
  it refuses in one sentence and points to Rigid with the PVA liner.
- **Sand:** builds the smallest flask round pattern and gating, parted where the pattern
  engine already parts it (least trapped, `castPatternExporter.ts:543-564`). Sand cover is
  25 mm round the sides and below, and the sprue head above. It fills the flask, removes
  the pattern, and pours the metal.
- **Lost PLA:** the same, with the cylinder flask the engine sizes today (12 mm cover).

The flasks are illustrative. A real flask is probably larger, which changes only how much
sand or investment is used, and the guide says so in one line.

**Each finished piece** is placed beside the master the way the master stands, not upside
down as it left the mold. It reports:

- volume;
- weight in the chosen material, split into part and gating where there is gating (cut off
  and remelted);
- deviation from the master: max and mean, in mm.

The tab's casting guide follows, as today.

**Selection after Add:** the next useful thing, not every new body.

| After adding | Selected |
| --- | --- |
| a silicone chain | the silicone mold, so Cast pours into it again |
| a pour box alone | master, base and sleeve, so Cast pours the silicone. When the selection is a pour box, Cast's fill defaults to the box's fill line (`fillZ`), not the rim |
| rigid mold halves (laid flat for printing) | nothing |

**Hole through the mold** (Silicone tab, Advanced) replaces the wick pin. It is off by
default. You pick a point on the master (default: its highest point) and a purpose: wick,
pour or fixing. A pour hole becomes the pour side. A wick or fixing hole is plugged during
the pour, as `pourCast.ts:194` already handles. Ids and labels lose the word wick:
`wickpin_` and `_wick_pin` (`pourBoxScene.ts:118-126,145`), its header (`:3`), and
`PourBoxModal.tsx:48` and `:137-139`.

## Cast: pour into what is selected

Today's `PourIntoSelectionModal`, moved off the Mold button. It covers:

- a mold made outside Mesh;
- a different material, side or fill depth in a mold that already exists;
- another pour into a silicone mold.

It shows the same Material field. With nothing selected it says in one line what to select.
It keeps its own button (decided 2026-10-25): *Mold makes molds, Cast pours into them*
matches the real process, and an imported mold carries no mold tag to hang an inspector
action on.

## One material list

`castMaterials.ts`, data only. Each entry has:

- label, density and shrink %;
- pour temperature;
- mix: an A:B ratio, or powder to water;
- whether it is water-based;
- the hottest mold it is safe in;
- warnings as data, with a threshold where one applies. Epoxy's warning ("above 200 ml the
  exotherm softens PLA") becomes a volume threshold, not a branch.

It is today's three lists merged, plus water and chocolate, which cost one line each. The
`epoxy` and `wax` branches in `moldLiner.ts` go.

## Jobs, today vs after

Each cell is dialogs / decisions / re-selects, with today's figures taken from the code.

| Job | Today | After |
| --- | --- | --- |
| Ice tray / chocolate, nothing selected | 1/0/0 | 1/0/0 (Rigid, pick a material for a true weight) |
| The same with the part selected | 1/0/0 (falls through to the designer) | 1/0/0 |
| Concrete planter, nothing selected | 1/0/0 | 1/1/0: choosing concrete gives a true weight and the PVA water check. It is optional; the dialog works without it |
| Concrete planter, selected | 2/1/0: it pours *into* the planter | 1/0/0 |
| Resin copy of an undercut sculpture (silicone) | 4/~3/2 | 1/1/0 (Silicone tab, following Rigid's hint), one click for both pours |
| Sand-cast aluminium cog | 1/0/0 under Cast | 1/1/0 the first time (Sand tab), then 1/0/0 |
| Lost-PLA bronze figure | 1/2/0 (Lost PLA, Bronze) | 1/2/0 (Lost PLA tab, Bronze) the first time, then 1/0/0 (both remembered) |
| Print a PVA-lined rigid mold of an undercut part | 1/1/0 (tick the liner) | 1/1/0 (tick the liner; Rigid's hint points at it) |
| Pour into an imported mold | 1/0/0 via Mold; a failure silently molds the whole scene | 1/0/0 via Cast; a failure says why |

Only two cells are longer than today. The first metal job costs one tab click, after which
the tab is remembered. The planter costs one optional field. Neither adds a dialog. Nothing gets longer by a dialog, a required
decision or a re-select.

## Build order

Each phase ships on its own and leaves the app working.

1. **One material list.** `castMaterials.ts` from the three lists, which the three dialogs
   now read. The branches become data. No visible change apart from the extra entries.
2. **Panels out of modals, no behaviour change.** `MoldDesigner` → `RigidMoldPanel.tsx`,
   `PourBoxModal` → `SiliconeBoxPanel.tsx`, `ExportCastModal` →
   `SandPatternPanel.tsx` / `LostPlaPatternPanel.tsx` (shared core),
   `PourIntoSelectionModal` → `PourPanel.tsx`. `ExportMoldModal.tsx` drops well under 1000
   lines (no big files).
3. **Mold with four tabs; Cast as pour.**
   - Mold opens on the remembered tab, else Rigid, with the lock-in hint above
     `OPEN_MOLD_ALLOWANCE`.
   - Every tab molds the selection, or the whole scene when nothing is selected. The mold
     and pattern engines take ids.
   - Material and Draft sit at the top of each tab, the rest under Advanced.
   - Draft on the pattern tabs applies to the printed pattern only, using `draftTriangles`
     from `castPrep.ts`. Bake into model stays under Advanced.
   - Cast opens the pour panel.
4. **Selection after Add**, per the table above.
5. **One-click chains.** Silicone (turn over, auto vents, narrow-base refusal), Sand and Lost
   PLA flasks, the piece set upright beside the master, deviation, gating weight.
6. **Hole through the mold**, with a purpose, replacing the wick pin.
7. **Agents.** `mcp-docs.json`, `physbox_mcp/.../physics.json` and
   `systemInstructions.txt` describe Mold (four tabs) and Cast (pour into). No new tool.
   Bump and release physbox-mcp.

## Tests

- **Journey defaults, one test per row of the jobs table.** For a given master, scene and
  remembered tab, the pure function behind the dialog's defaults (tab, material, draft,
  method) returns values that need no more decisions than the "after" column.
- **Materials:** every entry yields a weight. Refusals and warnings come from data. A grep
  test finds no material name in a branch in the casting code.
- **Chains:** a battery of masters (block, undercut part, thin wall, organic, cog, a master
  on a narrow foot) through each tab's one-click simulation. Checks:
  - the piece matches the master within shrink, and stands the way the master does;
  - weight splits into part and gating where there is gating;
  - the silicone chain leaves no downward pocket without a vent, and refuses the narrow foot.
- **Flasks:** the cover holds on every side, and there is no more than that.
- **Selection after Add:** each case matches the table.
- **What is molded:** with one part selected in a scene of several, each tab's mold or
  pattern contains only that part (and its children), placed where it is. With nothing
  selected, it contains every non-simulated body.

UI is checked by hand on :5175 with a test list for the user, not by browser automation.

## Out of scope

Molds of more than two parts, keyed two-part silicone molds, kiln and burnout schedules.
