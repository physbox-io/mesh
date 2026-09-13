---
name: physics-app-rules
description: Rules for interacting with the physics app and OpenSCAD state
---

# Physics App Interaction Rules

Rules for interacting with the physics simulator and its environment:

1. **Never use a separate browser**
   - The user already has the physics app open at `http://localhost:5175/?mcpPort=3142` or `https://mesh.physbox.io`.
   - Do not spawn, open, or run code in a separate or new browser instance.
   - All browser operations, evaluations, and state checks target the user's existing page.

2. **Never use SCAD from local files, only the app**
   - Do not inspect or read `.scad` files from the local filesystem to find or modify the design.
   - Access and modify all OpenSCAD (SCAD) definitions and scene configurations through the running app, using MCP tools such as `physics_get_scene`, `physics_get_object`, and `physics_update_object`.

3. **Use only MCP**
   - Use the MCP tools defined in your mcp_config.json file to interact with the physics app.
