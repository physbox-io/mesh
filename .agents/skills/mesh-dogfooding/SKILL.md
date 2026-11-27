---
name: mesh-dogfooding
description: >-
  Run a multi-subagent Mesh dogfooding session where N subagents each get an isolated
  git worktree, Vite dev server, and headless Chromium tab, build assigned parts using
  only Mesh MCP tools (no local code generation), fix bugs/workflow issues as they go,
  and report back for a coordinator audit of tool usage, MCP docs, and final screenshots.
  Use when the user asks for a dogfooding session or parallel end-to-end Mesh workflow testing.
---

# Mesh Multi-Agent Dogfooding Workflow

## 1. Coordinator Setup & Subagent Launch

1. Check that ports `5181..518N` are free (`ss -tlnp | grep -E "518[0-9]"`), and locate the Linux Chromium binary (e.g. `/home/boab/.cache/ms-playwright/chromium-1140/chrome-linux/chrome`).
2. Launch all `N` subagents in parallel via `invoke_subagent` with `TypeName: "self"` and `Workspace: "share"` (creates an isolated git worktree per subagent).
3. Assign each subagent:
   - A distinct **project brief** (design + fabrication workflow to exercise).
   - A unique **Vite port** (`5181`, `5182`, ...), **CDP port** (`9221`, `9222`, ...), and **Chrome profile dir** (`/tmp/mesh-dogfood-518X`).
   - An export output folder under `<artifactDir>/scratch/<slug>/`.

## 2. Subagent Environment & Isolation Rules

Include these exact setup steps in every subagent prompt:

1. **Symlink `node_modules`** (untracked in git worktrees):
   ```bash
   [ -e node_modules ] || ln -s /home/boab/mesh/node_modules node_modules
   ```
2. **Start Vite** as a background daemon (`IsDaemon: true`):
   ```bash
   ./node_modules/.bin/vite --port 518X --strictPort
   ```
3. **Launch headless Chromium** with SwiftShader WebGL and MCP bridge port `3142` (`IsDaemon: true`):
   ```bash
   /home/boab/.cache/ms-playwright/chromium-1140/chrome-linux/chrome \
     --headless=new --no-sandbox --disable-gpu-sandbox \
     --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
     --window-size=1280,800 --remote-debugging-port=922X \
     --user-data-dir=/tmp/mesh-dogfood-518X "http://localhost:518X/?mcpPort=3142"
   ```
4. **Session routing (critical):**
   - Call `list_sessions` and pick the `sessionId` whose `href` contains `localhost:518X`.
   - **Never** call `use_session` (pinning is global across agents).
   - **Always** pass `session: "<sessionId>"` on every `physics_*` MCP tool call.
   - **Never** touch the user's live tab (`mesh.physbox.io` or `localhost:5175`).

## 3. Subagent Dogfooding Rules

- **Mesh MCP tools only:** Build, inspect, DFM-check, simulate, and export strictly through Mesh MCP tools. Do not write local Python/Node/SCAD scripts to generate geometry or meshes.
- **Fix bugs and workflow issues live:** When hitting a bug, crash, broken export/geometry, or confusing workflow blocker, diagnose and fix it in the worktree, add/run targeted Vitest tests (`./node_modules/.bin/vitest run tests/<file>.test.ts`), verify `./node_modules/.bin/tsc -b --noEmit`, confirm the fix in the live tab, and commit with explicit `git add <paths>`.
- **Finish state:** Frame a clean showcase view (`physics_set_camera`, `physics_get_screenshot` with `clean: true`), add a scene note card (`physics_set_note_cards`), and **leave Vite + headless Chrome running** until the coordinator captures final screenshots.
- **Report back:** `sessionId`, worktree path & branch, tool sequence & DFM/export summary, bugs hit & commits made, and MCP documentation gaps noticed.

## 4. Coordinator Audit, Screenshots & Wrap-Up

Once all subagents report back:

1. **Capture final PNGs** of each agent's viewport into `<artifactDir>/<slug>.png` (via CDP `Page.captureScreenshot` on port `922X` after framing cleanly, or via `physics_get_screenshot` inspection) so they can be embedded in a visual report artifact for the user.
2. **Audit each agent:**
   - Did they use the right native Mesh tools (vs. workarounds)?
   - What bugs/workflow issues did they fix? Review diffs, merge/cherry-pick verified fixes onto `main`, and run `./node_modules/.bin/tsc -b --noEmit` + targeted tests.
   - What MCP doc gaps or prompt improvements surfaced? Update `mcp-docs.json`, `~/physbox_mcp/physbox_mcp/mcp-docs/physics.json`, and `src/components/systemInstructions.txt` as needed.
3. **Clean up:** Terminate the temporary Vite and headless Chrome processes and present the audit + embedded screenshot gallery artifact to the user.
