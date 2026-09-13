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
- **Scoped Verification**: Use targeted type checking and tests on your assigned files rather than editing out-of-scope files to satisfy global build scripts.
