# Agent Guidelines

## 1. Browser testing and telemetry
- **Pair-Programming Rule**: Never execute automated browser testing scripts during pair-programming sessions. Always present layout changes, UI enhancements, and functional updates directly for manual approval.
- **No External Browser/Puppeteer Spawning**: Do not launch Puppeteer, Playwright, or separate headless browser instances to test web apps or inspect state. Use the MCP tools instead.
- **Use MCP Endpoints First**: Use the MCP tools (e.g. `detect_apps`, `physics_get_state`, `physics_get_scene_summary`, `circuit_get_state`, `send_command`) to verify simulation state.
- **Use Viewport Screenshots**: To check layout, alignment, or rendering, call `physics_get_screenshot`.
- **No Source Hacks for Debugging**: Do not modify application source files to inject temporary telemetry or debug logs. Use the MCP protocol surface.

## 2. Shell environment (WSL on a Windows host)
- **PowerShell vs Bash Redirection**: When executing commands via `run_command` (default shell is PowerShell on Windows), do not use `> /dev/null` in top-level commands; PowerShell treats `/dev/null` as the Windows file `C:\dev\null`. Wrap bash redirections inside `wsl -e bash -c "..."` or use `| Out-Null` / `$null`.
- **Statement Separators**: Do not use `&&` in top-level PowerShell command strings. Wrap chained bash commands in `wsl -e bash -c "cmd1 && cmd2"`.
- **WSL Path & Context**: Run Linux/WSL operations through `wsl -e bash -c "..."` or target `/Ubuntu-20.04/home/boab/...` WSL paths.
- **No `npx` Usage**: Do not use `npx` to execute commands. Run local binaries directly (e.g. `./node_modules/.bin/vitest`) or package scripts via `npm run <script>` inside the WSL environment.

## 3. Task boundaries in multi-agent runs
- **Do Not Touch Unrelated Broken Code**: If a build command (e.g. `npm run build` or `tsc`) fails on type or syntax errors in files outside your assigned task, do not fix, modify, or patch those files.
- **Immediate Reversion**: If unrelated files are modified by accident, revert them with `git checkout <file>`.
- **Scoped Verification**: Use targeted type checking (`./node_modules/.bin/tsc -b --noEmit` — never bare `tsc --noEmit`, because the root `tsconfig.json` uses project `references` with `"files": []`) and tests on your assigned files rather than editing out-of-scope files to satisfy global build scripts. Stage explicit paths/hunks only (never `git add -A`), as other agents may have concurrent uncommitted changes.

## 4. Companion MCP server (`~/physbox_mcp`) & repo conventions
- **Read `CLAUDE.md` and `GUIDE.md`**: Consult `CLAUDE.md` at the repo root for repo-wide traps and multi-file sync checklists.
- **Keep `~/physbox_mcp` Aligned**: The companion MCP server lives at `~/physbox_mcp` (`/home/boab/physbox_mcp`, **not** `~/physics`). Whenever you add or modify MCP commands, tool arguments, or `mcp-docs.json` in `~/mesh`:
  1. Update `~/physbox_mcp/physbox_mcp/mcp-docs/physics.json` to stay aligned with `mcp-docs.json`.
  2. Update `~/physbox_mcp/physbox_mcp/server.py` if tool signatures, docstrings, or payload mappings changed, and run `~/physbox_mcp/venv/bin/pytest ~/physbox_mcp/tests`.
  3. Check `src/components/systemInstructions.txt` so the in-app copilot prompt stays consistent with MCP docs.
  4. Restart the running `server.py` process if live MCP tool schemas/docs need to reload.
