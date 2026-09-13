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

### 5. 3D multi-axis rotation (Euler representation)
* Rotation is set as an explicit `[X, Y, Z]` Euler array.
* Any stale `node.quat` is deleted on update so the MuJoCo compiler resolves rotation from the Euler array alone.

---

## Key Files and Directories

* `src/App.tsx`: main user interface, sidebar, environment configuration, and documentation modal.
* `src/store/useStore.ts`: state management and scene node mutation actions.
* `src/utils/mjcf.ts`: compiles the Zustand scene node graph into MJCF XML.
* `src/presets/presetScenes.ts`: initial scene definitions and configurations.

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

### Dynamic mesh geoms (`dynamic: true`)

Full physics simulation and collision. MuJoCo takes the **convex hull** of the mesh, so a concave shape will not collide correctly as a single mesh.

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

**Face winding:** use outward-facing normals (CCW winding viewed from outside). Wrong winding gives inside-out contact normals and sinking.

**Child bodies:** for compound mesh objects (mesh plus child bodies), the child `pos` offset is in MuJoCo Z-up relative to the **parent body's MuJoCo origin** (the volume centroid, not the mesh base). Measure with the `_mesh_xpos` debug log.

**Reference** (from `meshCollisionPreset`):
- Pyramid (base 0.6×0.6×0.6, height 0.5): MuJoCo origin at Z≈0 when resting on the floor (`xpos.z ≈ 0`).
- Ramp (fixed): `body_pos = [0,0,0]`, base flush with the ground.

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
