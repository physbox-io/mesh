# Plan: Touch-Probe Reverse Engineering (CNC as a 3D Contact Scanner)

Noted for later: turning a connected GRBL / FluidNC / grblHAL machine from output-only into a physical coordinate picker and surface digitiser inside Mesh, landing probed geometry directly in active `G54` work coordinates so a replacement part, mating bracket, or inlay can be cut without unclamping.

## Hardware Modes (No Hand-Moved Touch Puck)

A standard alligator-clip + brass zeroing puck only completes a circuit on bare metal. Three practical tiers cover non-conductive parts (wood, plastic, plaster, stone):

1. **Zero-hardware "Paper-Slip Coordinate Picker" (any material, $0):**
   - Chuck a known dowel pin (e.g. `Ø6 mm`) in the collet, jog until a strip of paper pinches against 3 points on a mystery bore or corners around a flange, and press **Space** (`Record Point`) to capture `wpos` offset inward by pin radius (`3 mm`) along the approach normal.
   - Fits exact circles, lines, planes, and bolt-hole patterns directly into the scene.
2. **Kitchen-Foil / Copper-Tape 2.5D Surface Mode (wood/plastic reliefs, $0):**
   - Smooth heavy-duty aluminium foil over a curved non-conductive surface (guitar top, carved seat, live-edge slab), clip ground to the foil and probe lead to a ball-nose / dowel pin, and run adaptive `Z`-only probing (`G38.2` / `G38.3`).
3. **3-Axis Kinematic Stylus Probe (unattended 3D + side walls on any material):**
   - Uses a 3-pins-on-6-balls Normally-Closed (`NC`, `$6=1`) stylus probe wired to the existing GRBL probe input — touching plastic, wood, or metal from `-Z` or sideways (`±X, ±Y`) lifts a pin by microns and opens the loop with zero electrical connection to the workpiece.
   - **Printable Mesh Preset:** Ship the printable 3-pin kinematic probe housing (`6× Ø4 mm` bearing balls + `3×` dowel pins + pen spring + M3 stylus) as a built-in project, plus an automatic **608 Bearing Calibration** wizard (probe N/S/E/W inside a clamped `608` skate bearing's `Ø22 mm` / `Ø8 mm` race to solve spindle runout and effective stylus ball radius $r_{\text{eff}}$).

## Changes Needed in `src/utils/machineProbing.ts`

1. **`G38.3` (No-Alarm Probe) Alongside `G38.2`:**
   - `probeOnce` currently issues `G38.2`, which puts GRBL into `ALARM:4/5` whenever a move finishes without contact — right for bed levelling, wrong for silhouette/edge marching where open air means *"step inward"*.
   - Add `probeToward(dx, dy, dz, feedrate)` using `G91 G38.3 X.. Y.. Z.. F..` and parse the `:0` vs `:1` suffix of `[PRB:x,y,z:1]` without alarming on open air.
2. **NC (`$6=1`) Fail-Safe Continuity Check:**
   - Update `probeCircuitFault()` to distinguish NO puck mode from NC kinematic stylus mode (where an open circuit in free air means a broken wire and refuses to start).
3. **Adaptive Silhouette & Bore Follower (`src/utils/probeScanner.ts`):**
   - **Bore / Boss Finder:** Drop inside a hole (or outside a boss), probe `±X` then `±Y` from chord midpoint, compensate by $r_{\text{eff}}$, and emit an exact cylinder/cut in `G54` coordinates.
   - **Marching-Contour Perimeter Trace:** Walk around an unknown part's outline at constant `Z` with adaptive step size (coarse on straights, fine on tight corners) instead of pecking an entire empty bounding-box grid, extruding or lofting the closed loop into a `manifold-3d` solid in the scene.
