# Add Simulation: put the part, as cut, into the scene

Every machining modal gets an **Add Simulation** button next to its start button. It adds
a body to the main scene showing what the program will actually produce: the stock with
the toolpath cut out of it, or the sheet parts as cut. The operator can then look at it,
measure it, and compare it with the model before committing wood and an afternoon.

This grows out of a one-off on 2026-10-11, when two relief programs (old and new finishing
order) were cut out of a virtual block in numpy and loaded next to the giraffe model.
That proved the new order finished the same surface. The feature makes the same check a
button.

## Where it applies

| Modal | Output | Simulation |
| --- | --- | --- |
| Relief Carve | one 3-axis program, rough → `T2 M6` → finish | mill the program out of a block |
| Solid Machining | side A, then side B flipped | mill A from the top, B from the bottom, one solid |
| Laser Cut (laser or router) | 2D sheet cuts | extrude the panels at sheet thickness; router rounds inside corners |
| Contour Slice (laser or router) | stacked sheets | extrude each layer's loops and stack them |
| Cast, Mold | STL only, no machine | not a simulation: an **Add to scene** for the pattern or mold halves (optional, see the end) |

The start buttons are all `<JobTransport>` (`MachineJobControls.tsx:394`), so the new button
goes into that component. It is offered whenever there is a result, whether or not a machine
is connected.

## 1. The milling simulator (`src/utils/cutSimulation.ts`)

Promote `tests/helpers/cutStock.ts` into `src/` and grow it. The tests then import it from
there, so the tests and the feature share one simulator.

- **Exact rather than pessimistic.** `StockModel` overstates what is left on purpose, because
  its job is keeping rapids out of the stock. A simulation that shows phantom fins (the edge
  cusps seen today) would be wrong in the other direction. Use centre sampling like
  `cutStock`, which matched the model on the giraffe.
- **A tool table, not one radius.** Take the tools from the export options for each op: T1
  and T2, flat, ball or V-bit with its angle. Switch at each `T<n> M6` line, not at the
  comment. The profiles already exist in `stockModel.ts` (`ballProfile`, `vProfile`).
- **Cell size from the stock.** Aim for about 0.1 mm, capped at about 4 M cells, so a
  600 × 400 board drops to about 0.25 mm. Report the cell size on the body.
- **Fast enough.** The sweep visits each cell under the cutter along a 0.05 mm step. Use
  typed arrays and precompute the cutter footprint once per tool. The giraffe took 22 s in
  numpy; the target is a few seconds in TS.
- Runs in the export worker as a new job kind `simulate`, with progress, the same way
  `runExportJob` (`exportJobs.ts:45`) runs the exports.

**Two-sided parts.** Keep two heightmaps: the top surface cut by side A, and the bottom
surface cut by side B, mirrored back into A's frame. Use the flip the exporter defines
(`solidMachiningExporter.ts:899-918`, column `c` ↔ `cols-1-c`). A cell where the top falls
to the bottom is empty, so holes and the tabs holding the part show as they will come off
the machine.

## 2. Heightmaps to a solid mesh (`src/utils/simulationMesh.ts`)

- **One side.** Top grid, side walls down the boundary ring, and a bottom.
- **Two sides.** Top and bottom grids, with walls along every edge where a cell turns empty.
- **Winding from geometry.** Derive each face's winding from its outward direction (see
  CLAUDE.md § face winding). Check with `analyzeMesh`: watertight, positive volume, no mixed
  winding.
- **Decimate the flats.** A flat background is most of the triangles. Merge coplanar cells
  (quadtree) so a board stays well under about 300 k triangles.

## 3. Sheet parts (laser, contour)

- **Laser.** Each panel's `outerPolygon2D` minus `innerCutouts2D`, extruded by its
  `thickness`, placed by its `origin3D`/`uAxis3D`/`vAxis3D`/`normal3D` frame. Assembled is
  the default; laid out on the sheet (`placedPos2D`, `sheetIndex`) is the option. In router
  mode, offset by the tool radius with `polygonOffset` so inside corners come out round,
  the way the cutter leaves them. Kerf comes from `compensationMm`.
- **Contour.** Each layer's `loops`, extruded at the material thickness and stacked at its
  `z`.
- Polygon-with-holes extrusion needs a triangulator. Check what `laserCutExporter.ts` or
  three's `ShapeUtils` already gives before adding one.

## 4. Putting it in the scene

- **The model-to-stock transform has to be returned.** The relief result lacks the model's
  plan centre, its top Z and `zScale` (`reliefCarveExporter.ts:3242`). The solid result
  lacks the orientation and `topZ` (`solidMachiningExporter.ts:770`). Add a
  `stockTransform` to both results, so the simulated part can be put back in model space.
- **Placement.** Beside the original by default, offset along +X by its width plus a gap.
  **Overlay** is a second choice: it puts the simulation exactly over the model, which
  makes an over-cut or a missed area obvious. A relief's vertical exaggeration has to be
  undone for the overlay.
- **The body.** A store action `addSimulatedBody`, through the `set` middleware so its
  name is made unique, with `prepareForDiscreteChange()` for undo. Copy the pattern from
  `splitBodyForPrint` (`useStore.ts:3189`).
  - Name it `Simulated: Relief carve 2026-10-11 14:05`. It is static: no free joint, so it
    does not fall.
  - Mark it so it is skipped by collision decomposition, because V-HACD on a 300 k triangle
    board is wasted work. Confirm there is a per-geom way to do that (contype/conaffinity
    0); add one if not.
  - Wood-coloured, slightly different from the model's own colour.
- **Note card.** The body gets one with the job name, tools, cell size and estimated time,
  so the simulation can be told apart from the model later.

## 5. MCP

- `ADD_SIMULATION` in `useMCPBridge.ts`, taking the kind (`relief`, `machining`, `laser`,
  `contour`), the same option overrides as `EXPORT_RELIEF`/`EXPORT_MACHINING` (the dialog's
  last plan by default), and `placement`. It returns the body name and a volume-vs-model
  figure.
- Docs in both `mcp-docs.json` and `physbox_mcp/.../physics.json`, plus the tool in
  physbox-mcp: a version bump and a GitHub release. Restart the MCP server.
- Guidance in `src/components/systemInstructions.txt`.

## 6. Tests

- **The simulator against analytic cuts.** A flat slot is exactly its depth and width. A
  ball's scallop height matches `r - sqrt(r² - (s/2)²)`. A V-bit groove matches its angle.
  The tool switches at `T2 M6`.
- **Relief end to end.** Within a bound of the model surface wherever the tool can reach,
  never below it, and no G0 removing material. The `vsmodel.py` check from 2026-10-11,
  made a test.
- **Solid two-sided.** A 60 mm sphere simulates to within a few percent of the sphere's
  volume, with no step at the A/B seam. Registration errors show up here.
- **The mesh.** Watertight, positive volume, no mixed winding, triangle count under the cap.
- **Sheets.** The extruded panel volume equals the polygon area × thickness; in router mode,
  inside corners have the tool's radius.
- Move the existing tests' `cutStock` imports to the promoted module.

## Order of work

1. Simulator plus mesh, relief only, with the button in the Relief Carve dialog and the
   `stockTransform` on its result. This is the version already proven by hand.
2. Solid machining, two-sided.
3. Laser and contour extrusion.
4. MCP command and docs.
5. Optional: **Add to scene** for the Cast and Mold outputs, which are already geometry.

## Sheet, tube and timber (added 2026-10-26, built the same day)

Status: relief, solid machining (both sides and multi-face), laser, contour, rigid mold, every
Mold tab's cast chain, and now Sheet Unfold, the pipe frame and Timber Breakdown all simulate, in
the dialogs and through `physics_add_simulation` (kinds `sheet`, `tube` (the pipe frame),
`timber`; physbox-mcp v0.47.0). Each found a fault in its exporter, fixed in its own commit:
sheet-metal flats with no setback (3.3 mm long per bend on a 50 mm box), a cope template that
hit the target mid-wall (0.07 mm), and timber window sheets whose fence face the part could
not be put against, which milled off-centre mortises mirrored. See GUIDE.md § Add Simulation.
Left as notes on the body, not simulated: glue tabs, mitred tenon tips (sawn square), the
pipe hubs (the dialog adds the printable ones), and hand-cut mortises. Tube coping and wire bending were removed from the Pipes dialog on 2026-10-26, at the user's
call, with their simulations. The original plan:

| Dialog | Output | Simulation |
| --- | --- | --- |
| Sheet Unfold | flat net: papercraft, sheet metal (K-factor bends), soft goods | fold the exported net back up, from the file's own bend lines and allowances, and set it against the model: a wrong allowance or a missing relief shows as a gap or overlap at the seams |
| Tube & Wire | cut lengths, cope templates, wire bend schedule, jig | cut each tube to its listed length, cope its ends from the template profile, bend the wire from the schedule (springback included), and assemble: a short tube or a wrong cope angle shows as a gap at the joint |
| Timber Breakdown | cut list, joinery, mortise G-code | cut each member from its board on the list, mill the joinery from the G-code with the cut simulator, and assemble: a tenon that does not reach its mortise shows |

Each is a new `kind` on `ADD_SIMULATION` (`sheet`, `tube`, `timber`) and an Add Simulation
button in its dialog, the same `<JobTransport>`-side placement as the others. Like the rest,
each is built **from the exported file**, not from the model, or it proves nothing. Report
the largest deviation from the model as the mold chain does.

3D printing (3MF, print split) is left out: the slicer, not Mesh, makes the toolpath, so
there is nothing of ours to replay. The split's pieces are already geometry in the scene.

## Later

- **Simulate to a line.** Drive the simulator from the toolpath view's playhead, to show
  the part as it stands at any point in the program.
- **As cut so far.** During a job, show the simulation up to the line being cut (reliable
  now that progress is read off the cut line), so a remote operator sees the part as it
  is now.
