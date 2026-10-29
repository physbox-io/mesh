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
* **Hierarchy view:** a compound body with `node.geoms.length > 1` shows its sub-geometries as nested nodes in the left sidebar tree. Bodies with children or sub-geometries fold with a chevron. The eye hides a body and its descendants from the view only (`hiddenNodeIds` in the store): they still collide and have mass, and hiding is not saved or compiled.
* **Adding parts:** a part added from the Components palette (click or drag) goes under the selected body, and the parent stays selected so repeated adds land side by side. With Worldbody selected it goes at the top level and is selected. MCP adds pass no parent and always land at the top level.
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

### 4c. Breaking under load, and joint blobs

Two general mechanisms, both built in the compiled model only (the scene graph keeps whole
parts, and Reset puts everything back). The spaghetti presets are their demo, not their scope.

- **`loadStrength`** on a body: the material's flexural and tensile strength, its modulus and
  whether it is ductile (`utils/deformMaterials.ts` gives every material one; Dry pasta is just
  another material). Only a free, long, thin body uses it: one cylinder, capsule or box at least
  8 times as long as it is thick (`utils/memberStrength.ts`). `utils/breakModel.ts` compiles it
  as two halves joined at mid-span: a breakable weld for a brittle material, a ball joint with
  friction equal to the yield moment (held by a lock that gives on overload) for a ductile one.
  The limits are the cross-section's: bending `σ·S`, pull `σ·A`, buckling `π²EI/L²`. A bar is
  judged by which way it is bent (on edge it is far stronger than flat). The second half exists
  only in the model, as geom `<name>~2`; the viewport draws it as part of its member.
- **`joinMaterial`** on a sphere/ellipsoid body makes it a joint blob (`utils/joinMaterials.ts`).
  At compile time every rod whose end is inside it, and anything pressed a tenth of the way
  in, is attached. Glue-like materials weld it, rigid until it lets go. Putty-like materials
  hold it on a pin (a `<connect>`), and the blob gets slide joints instead of a free one so it
  cannot spin. A free-spinning blob acted as a wheel and walked a standing tower apart. Rods held
  on a pin get rolling friction for the same reason. Limits scale with how much of the part is
  buried, and a rod's pull-out only counts pulling, not pushing it further in.

Every limit is written into the model as a `<numeric>` named like its equality (`member:<id>`,
`join:<blob>><id>`, `pin:<blob>><id>`, see `utils/breakKeys.ts`), and the physics worker reads
them from there. Nothing breaks in the first 0.25 s (`BREAK_ARM_S`): a load set down at t = 0
spikes every joint under it. A weld's angular rows read twice the true torque (quaternion
half-angle), so torque is `weldTorque()` = half their length, everywhere.

MuJoCo softens a constraint in proportion to the mass of what it joins, so light parts
carrying heavy loads sag more than real ones (a 12 g plank holding 5.4 kg sags 9 mm where oak
sags 4); the break loads are unaffected. Scenes with break limits get
`<compiler boundinertia="1e-8">`: a strand's inertia about its own axis is almost nothing, and
that alone made its welds' rotation soft. `tests/breakHarness.ts` runs the worker's break check
headless; `tests/loadBreakGeneric.test.ts` checks each case against a hand calculation.

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
- **`api.setActuatorControl(actuatorName, ctrlVal)`**: sets the control value for the named actuator. `mjcf.ts` names a joint's actuator `<jointName>_actuator`; an unknown name is ignored silently. For a velocity actuator `ctrlVal` is the target speed (rad/s hinge, m/s slide; the joint settles at `ctrlVal/gear`), for a motor the torque (N·m) or force (N). With a `forceLimit`, a velocity actuator on a light part cannot hold its speed unless the joint carries `armature` ≥ 1.5·kv·dt (`motorArmature` in `utils/motionParts.ts`); unclamped, implicitfast holds it. Steppers, the mechanism builders and MCP's `fillJointDefaults` (`withMotorArmature`) add it.
- **`api.getTime()`**: the current simulation time.
- **`api.getWind()`**: the current wind vector `[windX, windY]`.
- **`api.log(msg)`**: logs a debug message to the console.
- **`api.state`**: this body's own persistent object. The script body runs afresh every step, so its local variables do not survive; anything that has to last (an integral, a phase, a timer) goes on `api.state` — `api.state.integral = (api.state.integral || 0) + err * dt`. It survives edits made mid-play and worker recycles (it travels in the seed with qpos/qvel), and is cleared by Reset and by a preset load. The object is fixed: assigning `api.state = …` is ignored. Keep it to plain values, arrays and objects, or it cannot be carried across a worker restart. Implemented in `src/utils/scriptState.ts`; the native desktop app implements the same contract and also rewinds it with its run-ahead buffer.

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

Mesh geoms (`type: 'mesh'`) come in two render modes: **static** (drawn once from world-space vertices) and **dynamic** (drawn from the body transform every frame). Both collide alike; `dynamic` decides only how the mesh is drawn.

---

### Coordinate systems

- **Three.js** is Y-up: X=right, Y=up, Z=toward camera. Ground plane is Y=0.
- **MuJoCo** is Z-up: X=right, Y=forward (into screen), Z=up. Ground plane is Z=0.
- The `mjcf.ts` builder **swaps Y↔Z** when emitting mesh vertices into the `<mesh>` asset XML. Always author `vertices` in Three.js Y-up space.
- Primitive geoms live inside a `<group rotation={[-π/2, 0, 0]}>` in `App.tsx` that converts MuJoCo Z-up world positions into Three.js Y-up for rendering.

---

### Static mesh geoms (`dynamic` absent or false)

`dynamic` field absent or `false`. Absent means static only in the type and in preset files: everything that makes a mesh geom over MCP (`fillGeomDefaults` / `normalizeMeshGeomData`) or in the store sets `dynamic: true`, and `promoteJointedMeshGeomsDeep` / `promoteMeshGeomsToDynamic` flip a jointed body's meshes when a preset loads or a joint is added. Vertices are baked in Three.js Y-up world space. The mesh renders at a fixed position and is never re-drawn (no `useFrame` tracking), but it **still collides**: `mjcf.ts` emits it like any mesh geom, so MuJoCo hulls it. If its body is decomposed, the pieces collide and the static mesh stays as a contactless visual (§ Concave collision).

Good for: scenery and decorative structures. A visual shell around primitive collision proxies also needs `role: 'visual'`, or it collides too.

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

These things about it are load-bearing:

* **Derived colliders are ordinary geoms**, replaced wholesale by `applyNodeColliders` and
  fingerprinted by `collisionHash` so the decomposition runs once per real edit rather than per
  keystroke. Same pattern as `csgHash`, and deliberately a separate field.
* **Demoting the source mesh is not symmetric.** A *dynamic* mesh is drawn from the body transform,
  so it is dropped from the model entirely. A *static* mesh is drawn from `data.geom_xpos` via its
  geom id, so dropping it makes the body jump to the origin — it stays, with contact and mass zeroed.
* **A decomposed hollow body gets lighter**, because it is weighed by what is there rather than by
  its hull. Often by a factor of three. Correct, the same defect `inertia="exact"` fixed for the oak
  tree, and surfaced in the panel rather than applied silently.

* **Each colliding mesh is decomposed on its own, where its geom puts it.** MuJoCo hulls each mesh
  geom separately, so a body's verdict is per mesh: a wheel's two rims are two rings, a box beside a
  cup stays a box. The source is taken into the body frame by the geom's `pos` and `quat`/`euler`
  (`bodyFrameMesh`) — skip that and the pieces land where the mesh would be with its pose taken
  away. Each piece names its mesh in `colliderOf`, and only the named meshes are demoted; older
  colliders, which name none, stand for every colliding mesh. A mesh with `contype` and
  `conaffinity` both 0 is not a source at all, and pieces inherit their mesh's filtering.
* **Long thin parts get a budget scaled to them** (`scaledBudget`): pieces in proportion to length
  over wall thickness (twice volume over area), voxels so a wall is two thick. V-HACD cuts along the
  axes, so on a sloping U-channel every piece holding a wall and some floor fills the corner between
  them: the 440 mm coaster track needs ~450 pieces before its channel is clear, and gets them on the
  first run. A compact part keeps the old defaults and, when a cavity is found, one retry at up to
  64 pieces.
* **Filled cavities are found two ways** (`utils/filledCavities.ts`): a region of filled air that
  fills most of the empty space in its bounding box (a slot, a cup), and a piece that is mostly air
  reaching 1.5 wall thicknesses from any surface — which is how a channel filled along its length is
  caught, when its bounding box is mostly sky.

A boolean body with a hole that *pierces* it keeps the older, exact sector slicer (`utils/csg.ts`
`decomposeAroundAxis`), whose error is known in closed form. Everything else goes to V-HACD.

---

### Sculpt scissors

The sculpt brushes (`utils/sculptMesh.ts`) only move, split and merge triangles inside a closed
surface, so on their own they cannot make a hole or cut a piece off. The **Scissors** tool (key 7)
can. You draw a loop on screen, and it is swept along the view into a prism that is then subtracted
from the mesh (or intersected with it, with Ctrl held). An agent does the same with
`physics_sculpt_cut`, passing a polygon in the body's frame and a direction.

* **The boolean is `manifold-3d`**, not OpenSCAD. That is why the body stays a sculpt afterwards:
  `physics_cut` adds a negative to the boolean program and sets `csgEnabled`, which ends sculpting.
  The package is pinned to 3.2.x, because from 3.3 it pulls in its CAD CLI's dependency tree (sharp,
  gltf-transform, esbuild) with it. The cut runs in `workers/sculptCutWorker.ts`: building Manifold's
  half-edge structure takes about a second at 160 k vertices. `utils/sculptCut.ts` stays Worker-free,
  so the tests call it directly.
* **Leaving a cut open is done by filtering, not by clipping.** Every input to the boolean carries its
  own original ID, and each output triangle reports which input it came from. An open cut drops the
  prism's triangles. Manifold only accepts closed input, so a sculpt that is already open has each rim
  temporarily fanned shut first (as a third ID), and that fill is dropped as well.
* **A cut that splits the clay makes one body per piece** (`separateSculpt` in the store, as one
  undo step). The largest piece stays on the body, and the rest become new sculpt bodies at the same
  pose, in the same frame. While the pieces were one mesh, none of them could be deleted, and a brush
  reached across the gap and dragged the neighbouring piece too. The split is a document change, so
  it drops `SculptSurface`'s own stroke history, and Ctrl+Z falls through to the app's undo.
* **An open sculpt draws a darker back face**, in both `SculptSurface` and `SceneLayer`, so its inside
  reads as an inside wall. This applies to open *sculpts* only. Everywhere else a missing back face
  is how an inside-out mesh gives itself away (see Traps in CLAUDE.md).
* **Physics on an open sculpt is best-effort.** Solidity is volume over hull volume, and an open shell
  has no volume, so the concave-collision decision above is unreliable for one. Leave the cut
  filled if the body has to collide properly.

---

### Rounded and bevelled edges

Any part but a sculpt — primitives, booleans, lattice, OpenSCAD and imported parts — can have edges rounded (fillet) or bevelled (chamfer): E, the mode menu, or
the Edges card; `physics_get_edges` / `physics_round_edges` for agents. A rounding is a feature on the
body, `node.edgeRounds: { mode, size, edges }[]`, and it is realised **in the boolean program**, which
is what makes it cheap: the drawn mesh, the colliders, mass and every exporter get it for nothing.

* **Edges are found on the unrounded part** (`utils/featureEdges.ts`, via `utils/edgeRoundBase.ts`,
  which compiles `csgProgram(node, { rounds: false, always: true })`). Weld the STL soup, group facets
  into surfaces by the 20° crease angle, and chain the seams between two surfaces, breaking wherever
  the pair of surfaces changes. A straight chain is a `line`; a closed, flat ring is a `circle` (a
  hole's or a boss's rim, fitted with `detectCircle`). Anything else is reported but not offered.
* **Each edge is stored self-sufficiently**, in the source frame: the two outward normals and the two
  in-face directions away from the edge. That is all the cross-section needs, so emission never goes
  back to a mesh. Anything drawn over the compiled body shifts by `csgFrameOffset`, like the cut ghosts.
* **A convex edge is a cutter and a concave one a filler** (`utils/edgeRound.ts`): the region between
  the corner and the arc (or flat), swept along the edge — `linear_extrude` for a line,
  `rotate_extrude` for a rim, with the rim's own facet count and phase so the facets line up. Fillers
  are unioned before cutters are subtracted, and both after the part's own booleans.
* **Meshes go in shell by shell.** A lattice part can be several closed shells pushed into each other
  (the Wall Bracket's gusset is buried 1 mm in its plates). `primitiveToScad` hands each shell to
  OpenSCAD as its own polyhedron inside a `union()` (`meshShells`), or the buried faces survive and
  get rounded — which cut grooves into the plates.
* **Straight edges stop where they should** (`stops`). An outside edge that rises away from a face (a
  gusset leaving the floor) is cut short at that face, not carried on square into it. An inside
  corner's filler is cut short at every face at its ends, so it never pokes through the part. Where an
  outside edge runs into an inside corner that is also rounded, it stops at the top of that fillet
  (`stopShortOfFillers`): the last few millimetres stay sharp, because two roundings made separately
  cannot blend. 'All' therefore means outside edges; inside corners are their own pick.
* **Roundings whose edges have gone are dropped.** Before each compile of a rounded body,
  `compileCsgNodes` checks its roundings against the edges the part now has (`keepFoundEdges`), so an
  OpenSCAD part whose source was edited, or a part whose hole moved, loses the rounding on an edge that
  is not there instead of being cut where it was. The Edges card says how many (`edgeRoundsLost`).
* **Box corners get a patch.** Three edge cutters meeting square leave a blunt point; where three
  fillets of one size meet at right angles (across features, too), the corner cube less a ball is cut.
* **Tangent booleans leave collapsed slivers.** `evaluateNodeCsg` drops triangles whose corners weld
  to one point (`dropCollapsedTriangles`); without that a filleted cube reads as not watertight.
* **A rounded part with no hole collides as its own hull** when it fills ≥ 90% of it. Otherwise
  'auto' would fall back to the square source primitives, the one thing the rounding meant to change.
* **Size limits** (`maxSetback`): half the narrower face beside the edge, or half the gap to the next
  edge on that face, so a rounding cannot run into its neighbour or into a hole.
* **Resizing moves the edges** (`reconcileEdgeRounds`, beside `reconcileCuts` in `updateNodeGeom`), by
  the change in the positive geoms' bounding box. Other kinds of reshaping do not.
* **The tool edits the body live.** A session writes its draft onto the node so the real boolean shows
  the result; Apply makes it one undo step and Cancel puts the session's base back.

---

### Text on a face

Lettering is a surface pattern (`utils/textPattern.ts`, id `text`), so it goes on any face the
way the T-key patterns do (`utils/surfaceTexture.ts`): wrapped round a cylinder, drawn and
exported with the part, engraved on the laser's engrave layer, carved by the CNC exporters,
and never seen by the physics. Shift+T, "Text on a face" in the mode menu or the Texture tab
opens the pattern editor on it.

- **The font is needed once.** `PatternSpec.prepare` fetches the font, lays the text out
  (`utils/textOutline.ts`) and saves the outline in the pattern's options as a string
  (`outline`, with `outlineSig` naming what it was laid out from). `build` only fills that
  outline in, so the texture worker, exporters, reloaded scenes and tests need no font and no
  network. Anything that writes a text texture (the editor's Apply, `applySinglePatternToBody`
  for MCP) must call `prepare` first.
- **Fonts come from Google as static files** (`utils/fontLibrary.ts`): the fonts.googleapis.com
  CSS API names one file per weight and script subset on fonts.gstatic.com, and only the
  subsets the text uses are fetched. A browser gets woff2, decoded by `woff2-encoder`
  (WebAssembly, lazily loaded). Not the variable TTFs in the google/fonts repository: opentype.js
  misapplies some glyphs' variation deltas (Montserrat's bold "o" came out a wobbling
  hairline). Only the picker's catalogue of names comes from Fontsource's mirror, because
  Google's own is served without CORS.
- **Filled by the nonzero rule.** Glyphs overlap their own pieces; even-odd punches holes.
- **A figure, not a texture.** `PatternSpec.figure` marks a pattern whose 1s are the figure:
  engraving sinks them rather than the ground, and round a full wrap it is placed once on the
  point picked instead of being resized to repeat.
- Text on a path: straight (lines, alignment, optional box), round a circle (`top` reads
  clockwise over it, `bottom` left to right under the same ring), a wave, or any SVG path in
  mm. Each glyph is turned rigidly to the path at its middle.

### Mold and Cast

**Mold** is one dialog with a tab per kind of mold: Rigid (the printed mold designer, with the PVA
liner), Silicone (the pour box), Sand and Lost PLA (the metal pattern). Every tab molds the selected
part, children included, where it stands, or every non-simulated body when nothing is selected
(`utils/moldSubject.ts`, which hands the engines a SceneGraph of just that). The tab opens on the one
last used for the scene, else Rigid, and the material per tab is remembered (`store/castDialogStore.ts`).
Each tab shows Material and Draft first and the rest under Advanced; `utils/moldTabs.ts` holds the
defaults and which materials a tab can take. Draft on Sand and Lost PLA tapers the printed pattern
only (`CastOptions.draftDeg`); if Prepare for Casting has drafted the model, the field shows that
angle, locked, and nothing is added. **Cast** pours into the selection (a mold, or a master with its
pour box) and says why when the selection holds nothing. Every material is one entry in
`utils/castMaterials.ts`, data only: density, shrink, pour temperature, mix and warnings.

### Prepare for Casting (draft and edge breaks)

The **Prepare for Casting** switch (Mold > Sand or Lost PLA > Advanced, and `SET_CAST_PREP`) puts what a pattern needs onto
every part, in the model itself, so the viewport and the plain STL export carry it too.
`utils/castPrep.ts` is the pure half and `utils/castPrepRunner.ts` drives it through the store.

* **Edges first, as ordinary roundings.** Outside edges get a chamfer and inside corners a fillet 1.5×
  as big, sized per edge (`planEdgeRounds`) so one short edge does not cap the rest. For sand, the
  parting face's edges stay sharp, because a break there leaves sand overhanging it.
* **Then draft, baked in.** Draft has no parametric form, so each body's drawn shape (roundings
  included) becomes mesh geoms (`draftTriangles`). Every vertex moves sideways by an amount that is
  linear in its distance from the parting plane, along a miter of the walls around it. That leans
  outside walls out toward the plane and pocket walls in toward their floor. Lost PLA gets no draft.
* **Originals are on the graph.** `sceneGraph.castPrep.originals` holds each body's shape fields
  (`SHAPE_KEYS`, the generator flags included, so that a baked wedge is not regenerated). Switching
  off restores a body only if its `shapeSignature` still matches what prep left there; otherwise the
  body is kept as it is and named. The whole prep is one undo step.
* **Edits are refused while draft is baked in.** The store's set middleware drops a scene write that
  changes a body when it follows `recordInteraction` or `prepareForDiscreteChange` in the same tick,
  and opens `CastPrepGuardModal` (Cancel / Leave Casting Prep / Bake It In). Internal writes, such as
  a compile landing, are let through. Over MCP, the command fails and its error names the way out.
  Prep with edges only is not guarded, because its roundings are still editable.

---

### Split for Print

The **Split** button in the FDM bottom bar (and `SPLIT_FOR_PRINT`) cuts the selected body into
sections that each fit the printer's bed, turns each to print with the least support, and puts
joinery on the cut faces. The bed is a workshop setting beside the stock (`store.printBed`,
`utils/printBedSettings.ts`); the print lens reports `print_exceeds_bed` against it.

* **The engine is pure.** `utils/printSplit.ts` takes the body as triangle soups (body frame, Z-up,
  metres; `bodySoups` in `printSplitClient.ts` collects them) and works in millimetres in Manifold.
  `workers/printSplitWorker.ts` runs it, and `tests/printSplit.test.ts` runs it directly.
* **Which way up.** `bestPose` tries the six axes, the piece's cut faces and its 24 largest hull
  faces. It finds the footprint by rotating calipers and costs a pose by `supportArea`, which lives in
  `utils/printSupport.ts` so the DFM lens measures support the same way.
* **Where to cut.** A piece with no pose that fits is cut in two. Planes square to the world axes and
  to its principal axes are tried at the first of n even slabs, ±15%. A sliver (under 2% of the
  piece) is refused, and a face too thin to glue is heavily penalised. The fewest predicted sections
  wins, then the least support and the smallest seam, then the cut nearest the even split.
* **Joinery goes on per joint.** A joint is the patch of a cut plane two final sections actually
  share; an early cut is later cut again. Pins go as deep in the patch as they fit, two when it is
  wider than four diameters. Pegs go on whichever side's pose minds them least, measured on the real
  geometry, which is what keeps a section from being printed standing on its pegs.
* **What the scene gets.** `splitBodyForPrint` keeps the body's id for section 1 and adds siblings
  `<name>_part2`… Each section has one mesh geom with `colliderVertices`/`colliderFaces`, which hold the
  section before its holes and pegs, plus `contactClass` pin and socket geoms, and `printPose` on the
  node. Recipe fields (wedge, lattice, sculpt, CSG, roundings) are dropped, because the sections are
  the geometry now. The 3MF export offers to stand posed sections the way they print and pack them
  on the bed (`layoutOnBed` in `utils/printPlate.ts`), with no size prompt.

**Print fidelity** (`sceneGraph.simFidelity: 'print'`, the Environment panel's switch, or
`physics_set_environment(fidelity)`) is generic, not specific to the split:

* **Stiffer contact.** Contact uses `solref 0.002`, the stiffest the 1 ms timestep allows, so a resting
  part sinks about 0.04 mm rather than 4 mm.
* **Bodies collide as their plain mesh.** `mjcf.ts` emits a mesh with a collider source as its own
  plain-mesh collision geom, and draws the original visual-only. A hull of the drilled section would
  fill the holes, and a hull of the pegged one would wrap a cone round each peg that the next section
  then hits. This holds in both fidelities.
* **Exact pins and sockets.** In print fidelity a **pin** (dowel, peg: contype 2) meets pins and
  sockets, and a **socket** (16-sided hole lining, its cap, and box plates covering the face round
  the holes: contype 4, conaffinity 2) meets only pins. Neither meets a body hull (contype 1). The
  floor has every bit. Sockets must not meet sockets: two parts' face plates coincide, and coincident
  slabs in contact rock and slide a part a tenth of a millimetre off its seat. That is also why
  rectangular plate cells are boxes, not thin mesh prisms.
* **Standard fidelity.** Pins and sockets are inert and massless, and a scene without them compiles
  byte for byte as before. That byte-identical output is what protects the native app's golden XML.
* **The limit.** Anything else, a ball say, does not see the holes. Contact between arbitrary concave
  shapes below a millimetre is only as good as V-HACD, and sections with solidity below 0.92 are
  flagged as approximate.

**The assembly test** (`utils/printAssembly.ts`) builds a separate print-fidelity scene per stage.
The user's scene is never touched.

* **Stage order.** It follows the cut tree: both sides of a cut are assembled, then joined. The
  negative side is held static, and the positive side is dropped as one free body, with the scene
  turned so the cut normal points up. It starts 1.5 pin lengths above its seat, nudged sideways by
  0.3× the clearance. Dowels get a stage of their own first.
* **What it measures.**
  * **Gap and alignment:** the seated gap (signed) and the lateral and angular error. These are
    measured at the middle of the moving sections, not at the body origin, which can be half a metre
    away.
  * **Play:** the moving part is pushed both ways along two axes and twisted both ways. The push is
    applied at the joint face, as a force plus its moment, so a tall part slides on its pins instead
    of tipping.
  * **Stability:** whether MuJoCo diverged.
* **Where it runs.** The main thread compiles the stage XML with `compileToMJCF`, and the split worker
  steps MuJoCo. The worker never bundles `mjcf.ts`.
* **Exact checks.** `checkSplit` does in Manifold what MuJoCo cannot resolve: overlap between printed
  sections, how far the plain sections differ from the original, and whether every pin has a partner
  on the same axis.

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

* **It runs on a worker, so it has to stay pure and store-free.** Everything in
  `dfm.ts` takes a `SceneGraph` and returns numbers. `workers/dfmWorker.ts` runs
  it, and the structural checks, off the main thread; the views ask through
  `useDfmReport` / `useStructuralWeakSpots` in `utils/dfmWorkerClient.ts`, which
  run each analysis once per scene and lens, drop jobs a newer edit has
  overtaken, and keep the last answer on screen until the new one is in. A
  `useStore` import anywhere under `dfm.ts` or `printAnalysis.ts` drags the
  whole store into the worker.
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
`utils/printAnalysis.ts` (`structuralWeakSpots`), judged as drawn, and ride along with whichever lens is open, since a
column that buckles buckles however it was made. That is where the old **Weak
Spots** button's findings went.

---

### Drawing views and Dims

**Top Down**, **Front** and **Side** (`cameraView` `'topDown' | 'front' | 'side'`) are
orthographic: `CameraController` mounts a drei `OrthographicCamera` while one is chosen
and drei hands the perspective camera back when it unmounts. Axes, framing and the
`DrawingView` type are in `utils/cameraViews.ts` (document frame, Z-up): Front looks
along +Y from the −Y side, Side is the right-hand view from +X, Top looks down −Z
with +Y up the screen. They frame the scene's content at the same 160 mm default
scale as the perspective view. Orbiting is still allowed. Choosing the view you are
in poses it again (`setCameraView` bumps `cameraResetToken`), after dropping any
orbit momentum. An explicit pose (`setCameraOverride`, MCP `position`, a scene
load's framing) goes back to perspective.

* **Anything sized in pixels must not read `fov`.** An orthographic camera has none,
  and a band computed from `undefined` is NaN and snaps nothing. Use
  `metresPerPixel(camera, distance, height)` from `utils/cameraScale.ts`, which
  gives the frustum height over zoom for ortho. Points (`PointsMaterial`) draw
  `size` in plain pixels under ortho.
* **Dims** (`dimsEnabled`) is `components/scene/DimensionOverlay.tsx` over the pure
  `utils/viewDimensions.ts`. It measures the parts as drawn: shadow-casting meshes
  under each body's `<group name>`, world space, back to the document frame, so
  booleans, poses and instanced static boxes are already applied. Feature edges
  come from `findFeatureEdges`. Straight edges square to the sheet become chain
  stops, along with the centres of circles seen end-on. Those circles also get ⌀
  leaders, equal ones counted (`2× ⌀8`). Bodies over 60k triangles get the overall
  size only. Nothing is drawn unless the camera is within 1° of the view's axis.
  `physics_get_camera` reports what is drawn (`utils/liveDimensions.ts`).
* **Every figure is a true size.** A part is measured along its own axes
  (`BodyMesh.frame`, the frame of its biggest non-sphere piece), not the sheet's:
  `sheetAxes` takes the axis nearest the line of sight as depth and the other two
  as u and v. A part turned in the view gets aligned dimensions; one tilted in depth
  is dimensioned isometric-style, a foreshortened line carrying the true figure.
  When the long axis lies in the view's plane and is turned, an angle arc gives it
  against the sheet's horizontal or vertical. A projected outline is never
  printed: it is a number nobody can build to.
* **Rounds seen side on** add their silhouette (that span reads ⌀) and the rim where
  they step, but only bosses, never holes (`bossTest`), and only rims that show: a
  rim with material on both sides in the drawn view is a hidden line and is left
  out. Capsules come in exactly from `CapsuleGeometry` (`rods`), like spheres.
* **Locations**, in a second colour: each body's origin (MuJoCo `xpos`) from its
  parent body's, or from the world origin, across and up the sheet. Left out with
  nothing selected and more than 12 bodies.

---

### Add Simulation (the part as cut)

**Add Simulation** in a machining dialog's footer adds what the job will leave to the scene as a
body, beside the model at its real size or laid over the model (the second half of the button
switches between the two). It is offered whenever there is a result, with or without a machine.
Agents use `physics_add_simulation` (`ADD_SIMULATION`), which plans the job with the same options
as the matching export.

| Dialog | What is simulated |
| --- | --- |
| Relief Carve | the program, milled out of a block |
| Solid Machining | side A from the top, side B mirrored back from the bottom (`cols-1-c`), one solid; with setups on the block's sides, every setup in its own frame (below) |
| Laser Cut | the panels, extruded at their sheet's thickness, back in their place in the assembly |
| Contour Slice | the layers, stacked at the sheet thickness |
| Cast, Mold | **Add to Scene**: the pattern or mold halves, as exported, beside the model |
| Sheet Unfold | the net folded back up along its own lines, fitted to the model and measured |
| Pipes | the cut list made up: every tube cut to its length and seated hub to hub |
| Timber Breakdown | each window's program milled in the frame the part sits in on the bed, each tenon pushed into what it leaves |

* **One simulator for the feature and the tests.** `utils/cutSimulation.ts` sweeps each cutter
  (flat, ball or V, switched at `T<n> M6`) along every G0/G1 through a heightmap, exactly at cell
  centres: each move is swept in closed form, not stepped. `cutStock`/`cutStockMap` are the tests'
  shorthand for it. A cell grazed within 0.01 mm of the cutter's rim is cut but does not count
  towards a move's depth (G-code rounding otherwise reads a micron sliver as a dive). It is not
  `StockModel`, which overstates what is left on purpose to keep rapids out of the stock.
* **Two sides need a cell that divides the width**, so side B's mirrored columns land on side
  A's; `simulateStock` picks one.
* **The mesh** (`utils/simulationMesh.ts`) is a top and a bottom surface with walls wherever
  material stops, each surface merged by quadtree where it is planar, and closed where big blocks
  meet small ones. Kept under 200 000 triangles by relaxing the merge tolerance, which the note
  card reports.
* **Sheet parts** (`utils/sheetSimulation.ts`) are outlines extruded in a frame. A router's are
  closed by its bit (grown and shrunk back by the radius): inside corners keep the radius, and a
  slot narrower than the bit is never cut. A laser's are as drawn. A panel the packer turned a
  quarter on the sheet says so (`turnedOnSheet`), which is how it is turned back into place.
* **Putting it back on the model** needs the fit the exporter used, so the relief, solid and
  contour results carry a `stockTransform` (work = scale * (rotation . (model - origin)) +
  workOrigin). Overlay inverts it: a relief's vertical exaggeration, a solid part's turn onto its
  side, a contour layer's share of the model's height.
* **The body is marked** `node.simulation`. `collectSceneTriangles` leaves it out, so simulating a
  job never changes the next plan. It has no joint and does not collide (`contype`/`conaffinity` 0,
  `collision: 'hull'` so it is never decomposed).
* The work runs on its own export worker (job kinds `simulate`, `simulateSheets` and
  `simulateTimber`, with progress), started for the job and stopped after it. The sheet fold and
  the pipe frame are quick and run on the page.
* **Built from the output, measured against the model.** Sheet, pipe frame and timber are
  each made from what the dialog hands over, never from the model, or they would prove nothing;
  the model comes in only to fit the result to and measure it. Sheet and timber each found a
  fault in their exporter: sheet-metal flats that kept the full outside size (no setback), and
  timber window sheets that put the wrong face against the fence.
* **Sheet fold** (`utils/sheetFoldSimulation.ts`): a bend's arc is the neutral length
  (R + K·T)·θ centred on the drawn bend line, about an axis R in from the inside of the bend; the
  rest of the drawn zone stays flat. The model is the part's outside. The fit is by face normals
  and edge directions (rotation), then face planes and cut-edge lines (position): none of those
  move with a setback, which corners do. Each unfolded face carries `model3DMm` for this.
* **Pipe frame** (`utils/tubeSimulation.ts`): each tube seated against its start hub's shoulder;
  the gap to the far shoulder and tubes clashing inside a hub are what it reports. Frames are
  built from a sketch or any solid by `utils/pipeSkeleton.ts` (plans/pipe-frame-from-shape.md).
* **Timber** (`utils/timberSimulation.ts`): with the sheet's face up and the top end at the Y0
  stop the part lies only one way, so machine X = Y × Z fixes the face at the fence; a sheet
  naming another is a `setupFault`. Mortises on parts too big for the CNC have no program and
  are counted, not simulated.
* **Setups on the block's sides** (`utils/multiSetupMesh.ts`): each setup is cut in its own frame,
  and the part is where `f(p) = min(box, min_k H_k(R_k p + t_k) - z'_k) >= 0`, meshed with surface
  nets. Only plans that stand the block on a side go this way; one setup and the top/flip pair
  keep the height-map pair above, unchanged.
* **Step by step** (`utils/solidSimulationSteps.ts`, `hooks/useSimulationSteps.ts`): the Solid
  dialog's "Watch it being made" strip and each setup card add the job one body at a time. Step 0
  is the stock with only setup 1's `OP 0` registration pins bored (`registrationPrelude`); step k
  is the same simulation over setups 1..k (`SimulationJobOptions.stage`), stood as the block
  stands for setup k (`simulatedBody`'s `machineFrame`, setup k's rotation). A datum notch is part
  of setup 1's surface, so it first shows at step 1. Each body carries `simulation.stage`,
  `stages` and `planKey` (a hash of the programs); the next step is read from the scene, so a
  re-plan starts over and a deleted step is added again. MCP: `stage` on `physics_add_simulation`
  (a number, or `'all'`).

---

### Solid machining from any face

`setups: 'auto'` (the dialog's default) plans the setups a part needs; `1` and `2` are the old
`sides`, byte for byte. Faces are named as the block stands for setup 1: `+z` top, `-y` front,
`-x` left end.

* **Frames** (`utils/orient.ts`). `setupFrame(face, stock)` turns setup 1's work frame so a face
  is up, always a rotation (det +1); the yaw keeps setup 1's top/front edge at the new near-left
  on a turn onto an end. `-z` is side B's flip left to right. `describeTurn` names two faces
  ("on its left end, right end up, with the front towards you") so it cannot go down mirrored.
* **Planning** (`utils/setupPlanner.ts`). The part is cast into exact solid spans per column and
  coarse voxels (`utils/columnSolid.ts`, rays nudged off the grid). What a face can reach is an
  opening of its first-hit depth by the cutter's disc (the centre may stand off the part, in the
  channel), within its reach (`toolStickoutMm`, else 8 D). Every air voxel goes to the face it is
  shallowest under; every subset of faces is scored: setups, depth in diameters, time, and what
  is left in units of 0.05% of the part's volume. Air no face reaches (corners sharper than the
  cutter) is reported as a fillet, never chased. The top is the setup that frees the part, last,
  unless the flip does.
* **Building** (`utils/solidSetups.ts`). The six ways up are tried and the asked-for one kept
  unless another is clearly cheaper; the top and flip come from the old exporter; each side setup
  is a windowed `machineSurface` job in its own frame, never below the part plus a skin for the
  turn's error (touch-off, a quarter degree of tilt), and only as deep as the plan gave it, widened
  by the cutter's diameter so it can get down there.
* **Running.** The runner knows which setup a job is (`JobSetup`). A later setup will not start
  until Z, and X and Y unless it sits on pins, have been set since the previous one ended, and
  never over MCP or a relayed device. `setWorkPosition` touches off a face with the bit's side
  (allowing for paper); `parkHigh` lifts out of the way. `SetupChangeDialog` walks the operator
  through it; `setupDiagram.ts` draws each setup.
* **Relief stays one face.** A relief with an undercut as modelled offers *Machine as a part
  instead*, which opens solid machining with the same block and bits. A feature that runs off the
  model's edge below the top face is cut past the board edge (`machineSurface`'s `runOff`).

---

### Adding a new preset

Two places to update:

1. **`src/presets/presetScenes.ts`**: add the `export const myPreset` and add it to the `PRESETS` map at the bottom.
2. **`src/utils/sceneCatalog.ts`**: put its id on a shelf in `PRESET_SHELF`, which decides where the scene browser lists it under Examples. `tests/sceneCatalog.test.ts` fails for a preset with no shelf.

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
