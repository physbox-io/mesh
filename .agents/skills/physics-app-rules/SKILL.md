---
name: physics-app-rules
description: Crucial rules for interacting with the physics app and OpenSCAD state
---

# Physics App Interaction Rules

This skill documents and enforces two critical rules when interacting with the physics simulator and its environment:

1. **Never use a separate browser**
   - The user already has the physics app open at `http://localhost:5175/?mcpPort=3142` or `https://mesh.physbox.io`.
   - Never spawn, open, or run code in a separate, isolated, or new browser instance.
   - All browser operations, evaluations, and state checks should target the user's existing active page.

2. **Never use SCAD from local files, only the app**
   - Do not inspect or read `.scad` files from the local filesystem to find or modify the design.
   - All OpenSCAD (SCAD) definitions and scene configurations must be accessed, modified, and updated directly via the active application using MCP tools (such as `physics_get_scene`, `physics_get_object`, `physics_update_object`, etc.) or by executing scripts on the running app.

3. **Use only MCP**
   - Use the MCP tools defined in your mcp_config.json file to interact with the physics app.
   
