# PhysBox: Mesh

A browser-based rigid-body physics simulator powered by MuJoCo WASM. Build, simulate and interact with physics scenes in real time.

## Features

- **MuJoCo WASM** — full contact dynamics, joints, actuators, equality constraints
- **Primitive geoms** — box, sphere, capsule, cylinder, ellipsoid
- **Dynamic mesh geoms** — arbitrary convex polyhedra with full collision
- **Static mesh geoms** — visual-only scenery (decorative, no physics)
- **Compound bodies** — multiple geoms per body for complex shapes (nested and selectable directly in Hierarchy)
- **Joints** — free (with physical damping/drag decay), hinge, slide, ball (with stiffness/damping/limits/actuators)
- **Constraints** — gear coupling, rack-and-pinion, pulley ropes, weld, connect
- **Aerodynamics** — lift/drag model for winged bodies
- **Control scripts** — per-body JavaScript running at 1000 Hz with API support for reading/writing positions/velocities and tracking keyboard input (`api.isKeyPressed`)
- **Headless simulation** — run N ticks and return trajectory data without disturbing the live view
- **MCP server integration** — external AI agents can build and control scenes via WebSocket

## Running

```bash
npm install
npm run dev          # dev server on port 5175
```

Open [http://localhost:5175](http://localhost:5175).

To connect an AI agent via MCP:

```bash
cd ~/expt_mcp
venv/bin/python server.py --stdio   # stdio mode for Claude Code
# or
venv/bin/python server.py           # HTTP on port 3141
```

Open the app with `?mcpPort=3142` appended to the URL so the browser connects to the MCP WebSocket relay:

```
http://localhost:5175?mcpPort=3142
```

## Presets

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

## Coordinate System

MuJoCo is **Z-up**: X=right, Y=forward (into screen), Z=up. Ground plane at Z=0.

Static mesh `vertices` are authored in **Three.js Y-up** space (X=right, Y=up, Z=toward camera). The MJCF compiler swaps Y↔Z automatically.

Dynamic mesh `renderVertices` are in **raw MuJoCo Z-up** space (Y↔Z swap from Y-up, no centroid subtraction needed — MuJoCo recenters the mesh internally and `xpos` tracks the recentered body frame).

See [GUIDE.md](GUIDE.md) for full mesh authoring workflow.

## Architecture

```
src/
  App.tsx              — UI, Three.js canvas, geom renderers
  store/useStore.ts    — Zustand state, scene mutations, recompile
  hooks/useMuJoCo.ts   — MuJoCo WASM init
  hooks/useMCPBridge.ts— WebSocket bridge to MCP server
  utils/mjcf.ts        — SceneGraph → MJCF XML compiler
  presets/             — Built-in scene presets
  types/scene.ts       — SceneNode / SceneGeom / SceneJoint types
```
