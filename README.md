# PhysBox Studio

A browser-based rigid-body physics simulator and CAD fabrication studio built on MuJoCo WASM, CSG boolean modelling, and WebSerial hardware control. Build, simulate, analyse, and export physical mechanisms in real time.

---

## Key Features

* **MuJoCo WASM physics engine.** Contact dynamics, multi-axis joints, motor actuators, and proximity mechanical constraints (gears, pinion-rack, pulley ropes, welds).
* **3D CSG parametric modelling.** Manifold boolean operations (union, subtract, intersect) and OpenSCAD in a web worker.
* **Mouse spring dragging.** Click and drag live objects in the 3D viewport during playback, with the spring force drawn as a line.
* **Fabrication exporters:**
  * **3D print STL.** Binary `.stl`, centred and Z-up, for OrcaSlicer and PrusaSlicer.
  * **Printability and structural HUD.** Overhang visualiser, thin-wall alert, layer orientation stress visualiser, print time and filament cost estimate.
  * **2D laser cut / CNC.** 3D-to-2D panel layout, finger and mortise-tenon joints, kerf compensation, dogbone reliefs, SVG and G-code output.
  * **Contour slicing.** Stackable relief contour slices for laser, cardboard or foam, as SVG, G-code, or a ZIP package.
  * **Relief carve.** Heightmap roughing and finishing toolpaths with probed mesh levelling.
* **Machine control and work origin.** Jog pad (0.1/1/10 mm steps) to drive the tool to the job origin, `G10 L20` XY zeroing, touch-plate Z probing that refuses to set a datum when the probe makes no contact, and 3×3+ bed probing that warps G-code to follow an untrue bed. GRBL 1.1, FluidNC and grblHAL over WebSerial. See **Docs → Fabrication → Machine Setup &amp; Zeroing** in the app.
* **Hardware primitives.** Heat-set insert bosses (M2 to M8), metric printed threads (M3 to M16), hex nut traps (M3 to M6), bearing pockets, snap-fits, D-shaft motor couplers.
* **AI copilot and MCP bridge.** In-app AI agent panel and a WebSocket MCP server bridge (`physbox_mcp`) for scene generation by external agents.

---

## Simulation Telemetry

The physics worker keeps a rolling history of the simulation state, sampled every
10 steps and capped in length. It is readable from the app or by an external agent over
MCP: `physics_get_telemetry` for the latest sample, `physics_get_history` for the
buffer, and `physics_run_headless` for a trajectory with no viewport at all.

* **Per body:** world position, linear velocity, angular velocity, and the applied 6-DOF force/torque (`xfrc_applied`).
* **Per joint:** articulation angle (`qpos`), rate (`qvel`), and applied force (`qfrc_applied`).
* **Contacts:** the active contact set as MuJoCo resolves it each step.

The bottom status bar carries the scene and machine readouts: component, geom and
vertex counts on the left; machine target, stock material, connection status and
live job progress on the right.

---

## Coming Soon

* **TeknoBox control over objects.** Direct physical device control and hardware manipulation of simulated objects via built-in degree-of-freedom (DOF) motion sensors.
* **Telemetry graphing.** Live curves of the buffer above in the app: energy balance, per-body kinematics, and actuator control signals. The data is recorded today; nothing draws it yet. Signals from real hardware belong in Volt, where a scope node wired to a Heltec pin already plots them live.

---

## Getting Started

```bash
npm install
npm run dev          # dev server on port 5175
```

Open [http://localhost:5175](http://localhost:5175).

### Connecting AI Agents via MCP

```bash
cd ~/physbox_mcp
venv/bin/python server.py --stdio   # stdio mode for Claude Code
# or
venv/bin/python server.py           # HTTP on port 3141
```

Open the app with `?mcpPort=3142` appended to the URL: `http://localhost:5175?mcpPort=3142`.

---

## Preset Demos

| Key | Scene |
|-----|-------|
| `pendulum` | Double pendulum |
| `cubes` | Stacked falling cubes |
| `gears` | Meshing gear system |
| `machine` | Three-gear machine with pusher |
| `rack_pinion` | Rack and pinion converter |
| `inclined_plane` | Wedge with sliding block |
| `pulley_system` | Atwood-style pulley stand |
| `cartpole` | Cart-pole with LQR controller |
| `newtons_cradle` | Newton's cradle |
| `suspension_bridge` | Suspension bridge structure |
| `paper_plane` | Aerodynamic paper plane |
| `monkey_head` | Compound ellipsoid monkey head |
| `golden_gate` | Golden Gate Bridge (simulating, wind-responsive) |
| `golden_gate_mesh` | Golden Gate Bridge (static mesh, visual only) |
| `mesh_collision` | Dynamic mesh pyramid sliding off a ramp |
| `coin_flip` | Bouncy coin flipped into the air with angular spin |

---

## Coordinate System

MuJoCo is **Z-up**: X=right, Y=forward (into screen), Z=up. Ground plane at Z=0.

Static mesh `vertices` are authored in **Three.js Y-up** space (X=right, Y=up, Z=toward camera). The MJCF compiler swaps Y↔Z automatically.

See [GUIDE.md](GUIDE.md) for the full mesh authoring workflow.

---

## Deployment

Deployed as a static build behind nginx, in the same shape as the other PhysBox apps:

```bash
docker build --build-arg GITHUB_TOKEN=$(gh auth token) -t physbox-mesh .
docker run -p 8080:8080 physbox-mesh
```

### GitHub Packages dependency (`@physbox-io/ui`)

Mesh depends on the shared `@physbox-io/ui` design-token package, published to
GitHub Packages rather than the public npm registry (see `.npmrc`). `npm install`,
both locally and inside the Docker build, needs a GitHub token with the
`read:packages` scope:

* **Locally:** `gh auth refresh -h github.com -s read:packages`, then
  `export GITHUB_TOKEN=$(gh auth token)` before `npm install` or `docker build`.
* **In the Dockerfile:** the `builder` stage declares `ARG GITHUB_TOKEN` and
  copies it into `ENV GITHUB_TOKEN` so `.npmrc`'s `${GITHUB_TOKEN}`
  interpolation can find it during `RUN npm install`. It is a build arg and is
  not baked into the final `nginx` stage.

### Cloud Run deploy (Cloud Build trigger, not checked into this repo)

Pushes to `main` deploy automatically via the `physbox-deploy` Cloud Build
trigger (service `phyicssim`, region `us-west1`; see internal infra notes for
the GCP project). The trigger's build steps are not a `cloudbuild.yaml` in this
repo. They were generated by GCP's "Deploy to Cloud Run" flow and live only in
the trigger config. To view or edit them:

```bash
gcloud builds triggers describe physbox-deploy --project=<gcp-project-id>
gcloud builds triggers import --source=<edited-file>.yaml --project=<gcp-project-id>
```

The build step passes `GITHUB_TOKEN` into `docker build --build-arg` from a
Secret Manager secret (`github-packages-token`, a classic GitHub PAT scoped
to `read:packages`, shared with Etch's and Volt's equivalent triggers), via
the trigger's `availableSecrets`/`secretEnv`. Cloud Build's `docker` step args
are not shell-expanded by default, so the step invokes `docker build` through
`sh -c "..."`; that way `$$GITHUB_TOKEN` expands to the secret's value rather
than being passed as the literal string `$GITHUB_TOKEN`. The build also passes
`--network=cloudbuild` to `docker build`.

To rotate the token: create a new classic PAT with `read:packages` scope,
then `gcloud secrets versions add github-packages-token
--project=<gcp-project-id> --data-file=-` (paste the token, Ctrl-D). The
Cloud Build service account already has `roles/secretmanager.secretAccessor`
on this secret.

---

## License

Distributed under the **PhysBox Permissive Public License (PPPL-1.0)**.

Free for personal, academic, educational, research, and commercial use, including the
commercial sale of anything you produce with it: meshes, STLs, CAD models, toolpaths,
G-code, and machined or printed parts. Attribution must be retained. Redistributing,
re-branding, or hosting the software itself as a standalone or competing product or
SaaS requires prior written authorization. See [LICENSE](LICENSE) for full terms,
including the machinery and hardware safety disclaimer.
