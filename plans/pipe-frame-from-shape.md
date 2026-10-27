# Pipe frame from a shape

The Pipes dialog plans a frame from struts the user has already laid out end to end: one
cylinder per length of pipe, every length worked out by hand. That makes it a calculator. This
plan has the app build the frame instead, from either of two things the user already makes:

- **A sketch**: a lattice body's wires (Line, Freehand, Bézier) and its cage edges. The lines are
  where the pipes go; the app adds what holds them up.
- **A solid**: any body. Its surface is framed: flat regions become panels, their edges pipes,
  and a curved surface is first brought down to flat facets about a span across, so a sphere
  becomes a geodesic dome.

The examples built from real pipes (greenhouse, yard pub, carport, dome) stay as they are.

## Max span

How far a pipe may run between two joints that hold it. Manufacturers' support-spacing tables
for PVC come out at about L/140 sag with the pipe full of water, simply supported; the same
sum from each standard's own stiffness gives every pipe its default:
`L = (384 E I / (5 w 140))^(1/3)`, w the pipe and the water in it. PVC E 2.8 GPa, steel EMT
200 GPa. 3/4" Schedule 40 PVC comes out near 1.5 m, the tables' 5 ft. It is a setting.

## The skeleton (`src/utils/pipeSkeleton.ts`)

One graph, nodes in mm (Z up, world) and members between them, whatever it came from.

1. **From a sketch**: every cage edge and wire segment, in world mm through the body's
   transform. Collinear runs are kept as one member with joints only where something meets.
2. **From a solid**: the body's triangles, welded; flat regions grouped (the sheet unfold's
   coplanar clustering); if that leaves more faces than the surface needs at this span, the mesh
   is simplified to about one triangle per span² and grouped again. Members are the faces'
   edges.
3. **Support**:
   - A face wider than the span gets members across it: horizontal rails on a wall, and on a
     roof or floor members along its longest edge, as many as keep every gap under the span;
     where those run longer than the span, a second set crosses them. Members end where they
     meet the face's edges, which gain joints there. A face lying on the floor is not filled.
   - A sketch standing off the floor gets posts down to it from its corners, and from points
     along any member longer than the span. Post feet under the same member are joined by a
     base rail, so the frame stands on itself rather than on stakes.
   - **Diagonals**, off by default: one across every four-sided panel.
4. **Joints**: nodes closer than a fitting can separate are merged. Pipes longer than a stock
   stick are left to the cut list, which already splits them with a coupler.

## Into the scene

The skeleton becomes the same struts and fittings the examples have (`pipeStructureScene`'s
second half), replacing the shape (one undo step) or beside it. From there the existing cut
list, hubs and Add Simulation all work on it unchanged.

- Dialog: the Pipe Frame tab gets **Frame the selection**: the body it will use, max span (the
  pipe's default, editable), diagonals, and Replace / Beside.
- Bridge: `BUILD_PIPE_FRAME` (`bodyId`, `maxSpanMm`, `diagonals`, `pipeStandardId`,
  `placement`). There is no pipes MCP tool yet; adding one is the six-step chain.

## Tests

- A box frames to 12 pipes and 8 three-way corners; at a span shorter than its sides, its walls
  get rails and the cut list has no piece over the span.
- A sphere frames to triangles near the span, every joint on the surface.
- A rectangle sketched 750 mm up gets four posts and a base; a 4 m side gets intermediate posts.
- Diagonals add one member per quad panel, and only when asked.
- Every frame passes through the cut list and Add Simulation with no gap.

## Learned on the birdhouse (2026-10-26)

- A model's parts are often children of one body: every pipe scan now walks the whole tree.
- A shape too small for the pipe asked for (under six diameters across) is framed in the
  largest tube that suits it (eight diameters, else six), down to 6 mm aluminium tube, and the
  dialog's cut list switches to it. Refusing was wrong: a 120 mm birdhouse is a real size.
- Curved or flat is told by the angle between neighbouring faces, not the face count, which
  took a many-part flat model for a curve and simplified it to a tetrahedron.
- Holes cut into a shape are not framed: a frame goes round a window, not along its edge.
- A joint within a quarter span of support along members is held: an eave is a cantilever,
  not a joint wanting a post.

- Only pipes are pipes: plain boxes are no longer read as a frame (twelve edges each), which
  made the birdhouse a flat-roofed cube with PVC hubs on its corners. Frame a Shape is the way
  in, and the dialog has that one action; Add Simulation and Add Hubs are gone from it (the
  frame carries its fittings; the cut list's fit check is a line under it).
- Stock down to 3 mm dowel and dry spaghetti (1.8 mm, 250 mm strands); rod under 4 mm is glued,
  with no printed fittings. Joints within three diameters merge, so no piece is shorter than
  anyone would cut; a ridge on shallow rafters is held by them (an apex), not given a post.

## Next, if wanted

A load test for the classroom noodle bridge: pin-jointed truss analysis under a load, each
member's force against its strength (Euler buckling in compression, breaking in tension), and
the first to fail named, with the load it fails at.

## Not in v1

Centre-line skeletons for branching shapes (a tree, a chair). Pipes are on the shape's surface
line, not inset by their radius.
