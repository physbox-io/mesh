# PhysBox Studio

A browser-based rigid-body physics simulator and CAD fabrication studio powered by MuJoCo WASM, CSG boolean modeling, and WebSerial hardware control. Build, simulate, analyze, and export physical mechanisms in real time.

---

## 🌟 Key Features

* **MuJoCo WASM Physics Engine** — Full contact dynamics, multi-axis joints, motor actuators, proximity mechanical constraints (gears, pinion-rack, pulley ropes, welds).
* **3D CSG Parametric Modeling** — Manifold boolean operations (Union, Subtract, Intersect) and OpenSCAD web worker integration.
* **Interactive 3D Mouse Spring Dragging** — Click and drag live objects in the 3D viewport during playback with real-time spring force lines.
* **Fabrication Exporters**:
  * **3D Print STL Exporter** — Binary `.stl` export centered and Z-up oriented for OrcaSlicer / PrusaSlicer.
  * **3D Printability & Structural HUD** — Overhang visualizer, thin-wall alert, layer orientation stress visualizer, print time & filament cost estimator.
  * **2D Laser Cut / CNC Exporter** — 3D-to-2D panel layout, finger/mortise-tenon joints, kerf compensation, dogbone reliefs, SVG & G-code output.
  * **Contour Slicing Exporter** — Stackable relief contour slicing for laser/cardboard/foam, exporting SVG, G-code, and ZIP packages.
  * **Relief Carve Exporter** — Heightmap roughing/finishing toolpaths with probed mesh levelling.
* **Machine Control & Work Origin** — Jog pad (0.1/1/10 mm steps) to drive the tool to the job origin, `G10 L20` XY zeroing, touch-plate Z probing that refuses to set a datum when the probe never makes contact, and 3×3+ bed probing that warps G-code to follow an untrue bed. GRBL 1.1 / FluidNC / grblHAL over WebSerial. See **Docs → Fabrication → Machine Setup &amp; Zeroing** in the app.
* **Hardware Primitives** — Heat-set insert bosses (M2–M8), metric printed threads (M3–M16), hex nut traps (M3–M6), bearing pockets, snap-fits, D-shaft motor couplers.
* **Hardware-in-the-Loop (HIL) WebSerial Control** — Direct browser serial connection to ESP32 / microcontrollers at configurable baud rates.
* **AI Copilot & MCP Bridge** — In-app AI agent panel and WebSocket MCP server bridge (`physbox_mcp`) for external agent scene generation.

---

## 📈 Real-Time Telemetry & Oscilloscope Graphing Dock

PhysBox Studio exposes real-time time-series telemetry streams from the MuJoCo WASM simulation state and incoming WebSerial HIL hardware streams:

* **Energy Balance Curves** — Continuous tracking of system kinetic energy ($E_k = \frac{1}{2} m v^2 + \frac{1}{2} I \omega^2$), gravitational potential energy ($E_p = m g z$), and total mechanical energy dissipation over time ($\Delta t$).
* **Kinematics & Dynamics Plotting** — Real-time signal graphing of individual rigid-body 6-DOF positions $(x, y, z)$, linear velocities $(v_x, v_y, v_z)$, angular rates $(\omega_x, \omega_y, \omega_z)$, and joint articulation angles.
* **Actuator & Control Signals** — Plotting motor control inputs (`ctrl`), LQR cart-pole balancing forces, and user-scripted 1000 Hz outputs.
* **HIL Hardware Oscilloscope** — Live graphing of real-world serial telemetry feeds (IMU orientation angles, encoder counts, strain gauge readings, potentiometer inputs) streamed directly over WebSerial.

---

## 🔮 Coming Soon

* **TeknoBox Control Over Objects** — Direct physical device control and hardware manipulation over simulated objects via built-in Degree-of-Freedom (DOF) motion sensors.

---

## 📌 TODO

* **System Status Dock** — Unify real-time FPS counter, MuJoCo WASM engine status, active collision solver pair count, WebSerial HIL serial connection indicator (`115200 baud`), and AI Copilot status into a sleek bottom status bar dock.

---

## 🚀 Getting Started

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

## 📂 Preset Demos

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

## 📐 Coordinate System

MuJoCo is **Z-up**: X=right, Y=forward (into screen), Z=up. Ground plane at Z=0.

Static mesh `vertices` are authored in **Three.js Y-up** space (X=right, Y=up, Z=toward camera). The MJCF compiler swaps Y↔Z automatically.

See [GUIDE.md](GUIDE.md) for full mesh authoring workflow.

---

## 📜 License

Distributed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)** License.

Free for personal, academic, educational, and non-commercial research use with mandatory attribution. Commercial licensing requires prior authorization. See [LICENSE](LICENSE) for full terms.
