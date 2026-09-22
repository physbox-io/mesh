# PhysBox: Mesh Development Guide

Technical decisions, conventions, and architecture notes for the **PhysBox: Mesh** codebase.

---

## Conventions

1. **Physical realism, no magic items**
   * Presets rely on real structural mechanics. Do not use floating pegs, visual-only guide joints, or floating physics hacks in presets.
   * If parts are aligned on a plane (e.g. `Y = -0.25`), give every relevant object that exact coordinate so they make physical contact without clipping.
2. **Explicit physics settings**
   * Settings such as `contype`/`conaffinity`, sliding friction coefficients, and joint equality constraints are exposed with clear labels and `(i)` info icons that link to the on-screen reference guide.
3. **Pair-programming workflow**
   * Do not run automated browser testing scripts during pair-programming sessions. Present layout changes, UI changes, and functional updates directly for manual approval.
4. **Data-driven presets**
   * Presets are compositions of standard geoms and joints in `src/presets/presetScenes.ts`.
   * Do not add preset-specific logic (custom `isCoin` type flags, special rendering blocks in `App.tsx`, special component types in `useStore.ts`). The simulator engine and type definitions stay generic.

---

## Architecture and Core Mechanics

### 1. Proximity-aware joint coupling (pinions and gears)
* Gear and pinion-rack pairs are coupled with joint equality constraints (`<equality><joint ... /></equality>`) rather than tooth-on-tooth collision.
* The compiler computes the world positions of gears and pinions relative to their parent bodies and couples them only when they are close enough:
  * **Pinion-rack:** coupled when centre-to-centre distance $\le 0.5$ metres.
  * **Gears:** coupled when centre-to-centre distance $\le (r_1 + r_2) \times 1.15$.
* Each node has an `allowCoupling` property. Unchecking "Allow Mechanical Coupling" in the sidebar bypasses the proximity solver and leaves the parts to direct physical contact.

### 2. Gravity and DOF (degrees of freedom)
* **Static bodies:** nodes with `joints: []` have infinite mass and are welded to the world frame. Gravity does not act on them.
* **Hinge joints:** 1-DOF axial rotation. A symmetrical component with its centre of mass on the pivot axis has zero gravity torque.
* **Free joints:** unconstrained 6-DOF movement with free-fall acceleration. The initial velocity state is a 6-element array `[vx, vy, vz, wx, wy, wz]`: indices 0 to 2 are linear velocity ($m/s$) and indices 3 to 5 are angular velocity (roll, pitch, yaw in $rad/s$). Both are adjustable in the properties panel under "Launch Velocity" and "Launch Spin". For non-deterministic launches (e.g. a coin toss), add a control script that runs on the first step (`api.getTime() === 0`) and perturbs the velocities through the state setter API (`api.setAngularVelocity`).
* **Free joint damping:** MuJoCo has no joint-level damping for free joints. The step loop applies drag forces ($F = -c \cdot m \cdot v$) and drag torques ($T = -c \cdot I \cdot \omega$), scaled by mass and principal moments of inertia, so linear velocity and spin both decay at the configured rate ($e^{-ct}$).

### 3. Nested sub-geometries and selection
* **Hierarchy view:** a compound body with `node.geoms.length > 1` shows its sub-geometries as nested nodes in the left sidebar tree.
* **Per-geom editing:** clicking a sub-geometry in the tree highlights it in indigo, opens the properties panel on the right, and binds the controls (Dimensions, Mass, Collisions, Material, Appearance, Position Offset) to that geom.

### 4. Solid vs ephemeral collisions
* Maps directly to MuJoCo's `contype` and `conaffinity` attributes.
* **Solid (Solid check active):** `contype="1" conaffinity="1"`. Enters the contact solver.
* **Ephemeral (Solid check inactive):** `contype="0" conaffinity="0"`. Visual guide only; other bodies pass through.

### 4a. Making scenery movable
* A body whose every geom is ephemeral can touch nothing at all. That is right while it is welded in
  place — the convex hull of a tree is a dome nothing should bump into — and it means that the moment
  the body is given a joint it can only do one thing: accelerate through the floor forever. The oak
  tree preset did exactly that the first time anyone switched it to 6-DOF.
* So `restoreCollisionWhenMadeMovable` (`store/useStore.ts`) clears those flags at the moment a
  **jointless** body is given its first joint, from the properties panel or over MCP.
* Only when nothing in the body collides, and only on that transition. A body that already has one
  colliding geom has been given a collider deliberately — a trunk cylinder under visual-only meshes,
  say — and a body that *ships* jointed and ephemeral is nearly always a mechanism part that must not
  collide: gear teeth that mesh by engine rather than by contact, rotor blades, a Newton's cradle rod.
  Neither is touched, which is why the rule is not applied as a sweep at load time.

### 4b. What a mesh body weighs
* MuJoCo's default (`inertia="legacy"`) takes a mesh geom's mass and inertia from its **convex hull**.
  For a box, a bracket or a building that is the same answer. For anything that mostly encloses air it
  is not: the oak's 0.87 m³ of timber sits inside a crown-sized hull, which made the tree weigh 274
  tonnes with its centre of mass 3.7 m up in mid-air between the branches.
* `mjcf.ts` therefore emits `inertia="exact"` for any mesh that is closed and wound outward — checked
  per mesh by `utils/meshIntegrity.ts`, which is also what `physics_get_scene_summary` reports
  `watertight` from. An open or inside-out mesh keeps the hull behaviour, because an exact integral
  over it would be meaningless or negative.
* Volume is only half of it: MuJoCo assumes a density of 1000, water. A geom says what it is made of
  with `density` (kg/m³) and lets its size do the rest — this is what distinguishes a tree from a
  building of the same shape, and unlike an explicit `mass` it survives a rescale. Oak timber is 700,
  concrete 2400, and a crown of leaves, being mostly the air between them, is single digits.

### 5. 3D multi-axis rotation (Euler representation)
* Rotation is set as an explicit `[X, Y, Z]` Euler array.
* Any stale `node.quat` is deleted on update so the MuJoCo compiler resolves rotation from the Euler array alone.

---

## Key Files and Directories

* `src/App.tsx`: main user interface, sidebar, environment configuration, and documentation modal.
* `src/store/useStore.ts`: state management and scene node mutation actions.
* `src/utils/mjcf.ts`: compiles the Zustand scene node graph into MJCF XML.
* `src/presets/presetScenes.ts`: initial scene definitions and configurations.
* `src/utils/webSerialManager.ts`: the GRBL link and the job streamer. Holds the program and the
  line it has reached; `resumeFromLine` replays the program without sending it to rebuild the modal
  state, then streams a preamble plus the tail.
* `src/utils/jobCheckpoint.ts`: what makes that survive the tab. The program is written to
  localStorage when a job starts and the reached line every two seconds after, so an interrupted job
  can be offered back on the next load. On PhysBox Pro the same two records go to the account under
  the `physics-job` app id — the only route for a program over `MAX_LOCAL_BYTES`, and the only one
  that reaches a second computer. `src/utils/jobRestore.ts` joins the two halves (the manager may not
  import back into the checkpoint store); `main.tsx` asks once at start-up and
  `components/JobRestoreModal.tsx` renders whatever resume point turns up.

---

## Control Scripting API Reference

Each dynamic body can run a JavaScript control script inside the physics step loop. The script has access to a global `api` object.

### API methods
- **`api.isKeyPressed(keyName)`**: whether a key (e.g. `'space'`, `'w'`, `'arrowup'`, `'enter'`) is currently pressed. Case-insensitive. Matches both `e.key` and `e.code`.
- **`api.getPosition(bodyName)`**: the 3D position `[x, y, z]` of the body (defaults to the current body).
- **`api.getVelocity(bodyName)`**: the 3D linear velocity `[vx, vy, vz]`.
- **`api.getAngularVelocity(bodyName)`**: the 3D angular velocity `[wx, wy, wz]`.
- **`api.setPosition(pos, bodyName)`**: sets the 3D position `[x, y, z]` (or 1D position for hinge/slide joints).
- **`api.setVelocity(vel, bodyName)`**: sets the 3D linear velocity `[vx, vy, vz]` (or 1D velocity).
- **`api.setAngularVelocity(angvel, bodyName)`**: sets the 3D angular velocity `[wx, wy, wz]` (or 1D angular velocity).
- **`api.getMass(bodyName)`**: the mass of the body.
- **`api.getJointPosition(jointName)`**: the 1D position of a hinge or slide joint.
- **`api.getJointVelocity(jointName)`**: the 1D velocity of a hinge or slide joint.
- **`api.applyForce(forceVec, bodyName)`**: applies a 3D force `[fx, fy, fz]` to the body.
- **`api.applyTorque(torqueVec, bodyName)`**: applies a 3D torque `[tx, ty, tz]` to the body.
- **`api.applyJointForce(jointName, forceVal)`**: applies a 1D force/torque along or around the joint axis.
- **`api.setActuatorControl(actuatorName, ctrlVal)`**: sets the control value for the named actuator.
- **`api.getTime()`**: the current simulation time.
- **`api.getWind()`**: the current wind vector `[windX, windY]`.
- **`api.log(msg)`**: logs a debug message to the console.

---

## LQR Control Law and Non-Minimum Phase Dynamics (Cartpole)

### 1. Hierarchical dynamic modelling in MuJoCo
* **Body tree structure:** the cartpole is built as parent-child bodies (`pole` capsule body with a `pole_weight` child sphere body) rather than one body with several geoms. This allows modular editing in the scene tree and changes the multi-body dynamic tree in MuJoCo.
* **Mass and inertia integration:** MuJoCo computes composite body mass, centre of mass, and the multi-body inertia matrix at the parent body's hinge.

### 2. Coordinate alignment and sign consistency
* **Right-handed system:** in MuJoCo, $+X$ is right, $+Y$ is forward (into screen), and $+Z$ is up.
* **Hinge rotation:** for a hinge about the Y-axis `[0, 1, 0]`, a positive rotation $\theta > 0$ tilts the pole to the **right (+X)**.
* **Corrective sign:** to catch a pole tilting right ($\theta > 0$), the cart must accelerate right ($F > 0$), so the angle gains $k_\theta$ and $k_\omega$ are **positive**.

### 3. Non-minimum phase centring feedback
* **Centring:** driving the cart straight to the centre ($x > 0 \implies F < 0$) fights the catching force. To return left to the centre, the cart first accelerates further right to tilt the pole left, then rides that tilt back.
* **Gains:** positive position gains ($k_x > 0, k_v > 0$) with dominant vertical tracking gains ($k_\theta > 0, k_\omega > 0$) give stable, centring asymptotic decay:
  * **$k_x = 22.0$** (centring stiffness)
  * **$k_v = 15.0$** (cart velocity damping)
  * **$k_\theta = 80.0$** (vertical catch)
  * **$k_\omega = 20.0$** (angular rate damping)

---

## WSL Development and Simulation Workflow

### 1. Windows/WSL path mappings and command execution
* **Path resolution:** the workspace is reachable from Windows via UNC paths (`\\wsl.localhost\Ubuntu-20.04\home\boab\physics`). Windows `npm`/`npx` fail on UNC paths with `ERR_INVALID_URL` or similar.
* **Host leakage:** calling `npm` on the Windows host from a WSL workspace directory can run Windows `npm.cmd` via `cmd.exe`, giving errors like `'tsc' is not recognized as an internal or external command`.
* **WSL NVM environment:** Node and npm are managed by NVM inside WSL (`~/.nvm/`). NVM is initialised in `.bashrc` / `.bash_profile`, so non-interactive shells cannot find node or npm. Run builds, dev servers, and diagnostic scripts in an **interactive** bash shell (`-i`) inside the WSL distribution:
  ```bash
  # Dev server:
  wsl -d Ubuntu-20.04 -e bash -i -c "cd /home/boab/physics && npm run dev"

  # Build:
  wsl -d Ubuntu-20.04 -e bash -i -c "cd /home/boab/physics && npm run build"
  ```

### 2. Running TypeScript and ESM in WSL Node
* **ESM compatibility:** Node v20.20.0 in WSL cannot load `.ts` module imports from `.mjs` scripts (`ERR_UNKNOWN_FILE_EXTENSION`).
* **Use `npx tsx`** inside the WSL interactive environment for diagnostic scratch scripts:
  ```bash
  wsl bash -i -l -c "npx tsx scratch/test_your_script.mjs"
  ```

### 3. Grid search and decay evaluation
* **Early termination:** in MuJoCo grid searches, stop stepping as soon as the state leaves reasonable bounds ($|x| > 1.9$m or $|\theta| > 0.6$ rad).
* **Interval decay analysis:** to separate limit-cycle oscillation from asymptotic centring decay, split each simulation into 10-second intervals (Phase 1: 0 to 10s, Phase 2: 10 to 20s, Phase 3: 20 to 30s). A set of gains is stable and centring if:
  $$\text{Max}(|x|)_{\text{Phase 3}} < \text{Max}(|x|)_{\text{Phase 2}} < \text{Max}(|x|)_{\text{Phase 1}}$$
  $$\text{Max}(|\theta|)_{\text{Phase 3}} < \text{Max}(|\theta|)_{\text{Phase 2}} < \text{Max}(|\theta|)_{\text{Phase 1}}$$

---

## Mesh Geoms Reference

Mesh geoms (`type: 'mesh'`) come in two modes: **static** (visual only) and **dynamic** (full physics and collision).

---

### Coordinate systems

- **Three.js** is Y-up: X=right, Y=up, Z=toward camera. Ground plane is Y=0.
- **MuJoCo** is Z-up: X=right, Y=forward (into screen), Z=up. Ground plane is Z=0.
- The `mjcf.ts` builder **swaps Y↔Z** when emitting mesh vertices into the `<mesh>` asset XML. Always author `vertices` in Three.js Y-up space.
- Primitive geoms live inside a `<group rotation={[-π/2, 0, 0]}>` in `App.tsx` that converts MuJoCo Z-up world positions into Three.js Y-up for rendering.

---

### Static mesh geoms (default)

`dynamic` field absent or `false`. Vertices are baked in Three.js Y-up world space. The mesh renders at a fixed position and never moves or collides. It is rendered **outside** the rotated group, with no `ref` and no `useFrame` tracking.

Good for: scenery, decorative structures, visual shells around primitive collision proxies.

```ts
{ name: 'deck', type: 'mesh', size: [1], rgba: [...], vertices: [...], faces: [...] }
```

The `box()` helper used in `goldenGateMeshPreset` (Three.js Y-up coords):
```ts
// box(cx, cy, cz, hx, hy, hz); cy/hy = height
box(0, 0.3, 0,  4.8, 0.06, 0.3)  // flat deck: wide in X, thin in Y
box(cx, 1.5, 0, 0.08, 1.5, 0.08) // tall post: large hy
```

---

### Concave collision

MuJoCo collides every mesh geom as its **convex hull**. For a bracket or a boulder that is the same
answer; for anything that encloses air it is not. A cup, bowl, open-top box, funnel or housing
collides as the solid billet it fits inside, so a ball dropped into it rests on an invisible lid at
the rim — and nothing about the scene says why.

`utils/convexDecomposition.ts` decides what to do about it, per body, from **solidity**: true volume
over convex-hull volume. A box and a sphere are 1.0. A cup is nearer 0.3, and that gap is the size of
the lie. Below ~0.92 the mesh is broken into convex pieces by V-HACD (`utils/vhacd.ts`, vendored —
see `src/vendor/vhacd/PROVENANCE.md`), each emitted as its own mesh geom tagged
`csgDerived: 'collider'`. Above it, the hull is kept, because it is exact and cheaper.

This applies to **any** body with a mesh geom — imported STL, sculpt, lattice part, relief,
hand-written SCAD, boolean. `node.collision` (`'auto' | 'hull' | 'decompose' | 'primitives'`)
overrides it; `csgCollision` is the old boolean-only field, still read so existing scenes behave as
they did, never written. Read both through `collisionModeOf()`.

Three things about it are load-bearing:

* **Derived colliders are ordinary geoms**, replaced wholesale by `applyNodeColliders` and
  fingerprinted by `collisionHash` so the decomposition runs once per real edit rather than per
  keystroke. Same pattern as `csgHash`, and deliberately a separate field.
* **Demoting the source mesh is not symmetric.** A *dynamic* mesh is drawn from the body transform,
  so it is dropped from the model entirely. A *static* mesh is drawn from `data.geom_xpos` via its
  geom id, so dropping it makes the body jump to the origin — it stays, with contact and mass zeroed.
* **A decomposed hollow body gets lighter**, because it is weighed by what is there rather than by
  its hull. Often by a factor of three. Correct, the same defect `inertia="exact"` fixed for the oak
  tree, and surfaced in the panel rather than applied silently.

A boolean body with a hole that *pierces* it keeps the older, exact sector slicer (`utils/csg.ts`
`decomposeAroundAxis`), whose error is known in closed form. Everything else goes to V-HACD.

---

### Dynamic mesh geoms (`dynamic: true`)

Full physics simulation and collision. MuJoCo takes the **convex hull** of the mesh — so a concave
shape would not collide as the shape it looks like. See § Concave collision below: the app measures
that and fixes it, and you do not have to do anything.

Requires two extra fields:
```ts
{
  type: 'mesh',
  vertices: [...],        // Three.js Y-up space; the mjcf builder swaps Y and Z for MuJoCo
  faces: [...],
  dynamic: true,
  renderVertices: [...],  // Raw MuJoCo Z-up space (Y and Z swapped only, NO centroid subtraction)
}
```

**Rendering path for dynamic meshes:**
- Rendered **inside** the `rotation={[-π/2, 0, 0]}` group alongside primitives.
- Position is tracked every frame from `data.xpos[bodyId]` / `data.xmat[bodyId]` (the **body** transform).
- `renderVertices` are in raw Z-up space. MuJoCo recentres the mesh internally and `xpos` tracks the recentred body frame, so render and physics stay aligned.

---

### Computing renderVertices

Swap Y and Z on each Y-up vertex. No centroid subtraction is needed; MuJoCo recentres internally.

```js
function toRenderVerts(yupVerts) {
  const out = [];
  for (let i = 0; i < yupVerts.length; i += 3) {
    const x = yupVerts[i], y = yupVerts[i+1], z = yupVerts[i+2];
    out.push(x, -z, y);  // Y-up (x,y,z) to Z-up (x,-z,y)
  }
  return out;
}
```

**Setting body pos:** `body_pos = [0, 0, 0]` places the mesh where its vertices are in Y-up space. To start an object at a given height, set `body_pos.z` to the desired height of the body's MuJoCo origin (the mesh's volume centroid). For a mesh whose Y-up base is at Y=0 and centroid at Y=0.125, set `body_pos.z = 0.125` for the base to sit flush with the ground. With `body_pos.z = 0` the MuJoCo origin sits at ground level, which puts the base at Z = -centroid_height, slightly below ground. Verify by checking `xpos[2]` via the `_mesh_xpos` debug object.

**Face winding:** use outward-facing normals (CCW viewed from outside, so each triangle's `(v1-v0) x (v2-v0)` points away from the interior). Wrong winding gives inside-out contact normals and sinking.

It also has a visual symptom that does not look like a winding bug. `SceneLayer.tsx` draws mesh geoms with `side={THREE.FrontSide}` and takes their normals from this winding, so a backwards triangle is not drawn at all and a surface built backwards reads as a **half-transparent body** — you see through its near face to the inside of its far wall. `californiaRelief.ts` shipped that way. When a body looks see-through, sum the signed volume before looking at `rgba` or materials; `physics_get_scene_summary` reports it as `windingInverted`. Note that a positive total only rules out a *uniform* inversion: a mesh with faces both ways can still sum positive, so derive each triangle's order from its face's outward direction rather than writing indices in ascending order.

**Child bodies:** for compound mesh objects (mesh plus child bodies), the child `pos` offset is in MuJoCo Z-up relative to the **parent body's MuJoCo origin** (the volume centroid, not the mesh base). Measure with the `_mesh_xpos` debug log.

**Reference** (from `meshCollisionPreset`):
- Pyramid (base 0.6×0.6×0.6, height 0.5): MuJoCo origin at Z≈0 when resting on the floor (`xpos.z ≈ 0`).
- Ramp (fixed): `body_pos = [0,0,0]`, base flush with the ground.

---

### DFM (design for manufacturing)

`utils/dfm.ts` answers one question: what happens when someone tries to actually
make this shape. The **DFM** toggle in the bottom-right viewport controls turns it
on; `components/scene/DfmHeatmap.tsx` paints the surface and
`components/DfmHUD.tsx` says it in words.

**There is no process picker.** The lens follows `machineTarget` from the bottom
bar via `dfmLensFor` — a printer gets the print lens, a router the CNC one — and
a laser gets `null`, because it has no Z depth and overhang, undercut and reach
mean nothing to it. Asking for the process again would let this control disagree
with the one beside it.

**Casting is the one exception**, because it is a real Mesh workflow and not a
machine. It sits at the bottom of the panel in a section that is collapsed by
default (`dfmCastOpen`), and expanding it switches the heat map to the cast lens
too — reading about undercuts while the viewport is still shaded for overhangs
is worse than showing neither.

**The panel drags and rolls up** like a note card, on the same pointer-event
pattern as `NoteCardOverlay` in `App.tsx`, with its position and minimised state
in the store (`dfmPanel`) so it survives being closed and reopened. Rolled up, it
stops sampling the scene altogether.

| Lens | What it measures | What it flags |
| --- | --- | --- |
| 3D print | Face angle from vertical; wall thickness through all three axes | Overhang the loaded filament will not hold; walls under its minimum; ceilings it cannot bridge; shrinkage on a large flat |
| 3-axis CNC | Column top down to the stock bottom, against real material | Material under an overhang the cutter cannot reach; pockets narrower than the bit; depth no standard bit reaches; ribs too thin for the stock |
| Casting (engine only) | Face angle relative to a ±Z pull about a mid-height parting plane | Undercuts that lock the pattern in; walls with no draft on a part deep enough to drag |

**The limits come from the bench, not from `dfm.ts`.** `dfmLimitsFor` reads the
store's `material`, `filament` and `stock`: overhang angle, minimum wall,
bridging and warping come off `FilamentSpec`, the minimum *cut* wall off
`MaterialSpec`, and the reach from the largest entry in `STANDARD_BIT_DIAS` under
the same stickout rule `reliefCarveExporter` sizes real tooling with. So
switching PLA to TPU tightens the overhang limit and forbids bridging, and
switching aluminium to MDF triples the thin-wall threshold. Adding a filament or
a material means adding its DFM numbers alongside its cutting numbers.

**It judges the selected body, not the scene.** A Mesh scene is usually a
simulation — a pendulum, a gear train, a bridge — and asking "will this make?" of
all of it at once gives true but worthless answers: the Golden Gate does not fit
on a 150 mm board, and two bodies hanging in space are trivially under an
overhang with respect to each other. `analyseDfm` takes a `nodeId` and the
components pass `selectedNodeId`. Fabrication is per part, so the question is.

**It is deliberately hard to set off.** The thresholds live in one `T` block at
the top of `dfm.ts` with the reasoning attached. Support material is normal in
FDM; inside corners having the bit's radius is normal in CNC. Neither is a
written finding — both show in the heat map, which informs without interrupting.
A panel that complains about every part is one people switch off, and then the
real problem goes unseen too. `tests/dfm.test.ts` has a block asserting silence
on ordinary parts; keep it passing when adding a check.

Three things worth knowing before changing it:

* **It is pure and store-free**, unlike `utils/printAnalysis.ts`, which reads live
  MuJoCo state at module scope and can only run on the main thread. Everything in
  `dfm.ts` takes a `SceneGraph` and returns numbers, which is why it is tested
  directly and could move to a worker unchanged.
* **The heat map and the analysis share one triangle soup.** `analyseDfm` returns
  the `tris` it measured alongside one `heat` value per triangle, and the overlay
  draws that same array. Re-collecting the scene on the render side would be a
  second traversal and a second chance for the colours to land on the wrong
  faces.
* **The CNC check measures down to the stock, not to the column's own bottom.** A
  floating arm measured against itself reads as perfectly reachable; measured
  against the stock it correctly reports the void underneath as material the
  machine cannot clear. Same figure `solidMachiningExporter` reports for a real
  job.

The structural checks (buckling, thin pins, gear clearance) still come from
`utils/printAnalysis.ts` and ride along with whichever lens is open, since a
column that buckles buckles however it was made. That is where the old **Weak
Spots** button's findings went.

---

### Adding a new preset

Two places to update:

1. **`src/presets/presetScenes.ts`**: add the `export const myPreset` and add it to the `PRESETS` map at the bottom.
2. **`src/App.tsx`**: add `<option value="my_preset">My Preset</option>` to the hardcoded `<select>` dropdown (Built-in Presets list). It does not populate from `PRESETS`.

---

### Keeping MCP documentation and schemas in sync

The MCP server loads tool descriptions and simulator schemas from JSON documentation. When tool capabilities, presets, or schema fields change, update:
1. **`mcp-docs.json`** at the root of the simulator repository (e.g. `physics/mcp-docs.json`).
2. **`mcp-docs/physics.json`** inside the MCP server repository (`physbox_mcp/mcp-docs/physics.json`). This is a fallback copy committed to the MCP repo so users can run it standalone without cloning the simulator.

If you also change the React hook commands, update **`src/hooks/useMCPBridge.ts`** to handle the new command and map it to Zustand store mutations or selectors.

Stale bridge documentation or schemas cause external agent copilots to generate invalid scene graphs or make broken calls.

---

### Ellipsoid rendering
Ellipsoids are rendered as a unit sphere scaled by `[rx, ry, rz]` (the three semi-axes from `geom_size`). Normals are distorted under non-uniform scale, so lighting looks slightly off on very squashed shapes. Collision is physically correct (MuJoCo uses the real ellipsoid).
