---
name: install-isingq-mcp
description: Installs, upgrades, configures, verifies, and connects IsingQ through standard MCP, Codex Plugin, or the native DeepSeek Harness Plugin. Use when a user asks to install, update, configure, reconnect, or diagnose IsingQ tools in DSH, Codex, WorkBuddy, Claude Code, Cursor, VS Code, Trae, or another stdio MCP Host.
---

# Install IsingQ MCP

中文版本：[SKILL.zh-CN.md](SKILL.zh-CN.md)

## Safety and interpretation rules

- Never receive an IsingQ API Key in chat, arguments, environment variables, logs, Host config, or Agent-visible output. If no valid local Key exists, the bundled script opens an OS-native hidden-input dialog.
- If the user has no API Key, direct them to sign in at `https://console.isingq.com/` and use **Settings → API → Create API**. Never register on the user's behalf or read, copy, or expose the Key.
- Never bypass a Host sandbox. Before running, request user approval for the script to write the user installation, private config, and selected Host config directories. If denied, stop and report the blocked stage.
- Identify the target Host from the current user request/session, not from which apps happen to be installed. Configure only that Host.
- Treat every Host's user source config, generated runtime state, and proxy/cache as different layers. Never infer one product's config path from another product, and never edit generated state to register MCP.
- A hand-written NDJSON call proves server reachability only. Installation succeeds only after standard MCP registers seven tools or the native DSH Plugin registers nine tools.

Host-specific boundaries and fallbacks: [HOSTS.md](HOSTS.md).

## Codex Plugin path

If the current Codex session already exposes the native `isingq_api_key_setup` tool from the installed IsingQ Plugin:

1. Do not download a binary and do not edit Codex MCP configuration; the Plugin already bundles and registers the source MCP.
2. Ask for explicit confirmation to open the operating-system private input dialog, then call `isingq_api_key_setup` without an API Key argument. Use `force=true` only when the user explicitly asks to replace an existing Key.
3. Confirm seven native `isingq` tools, call `isingq_knowledge_get` with `topic="company"`, and report that solving remains gated by model confirmation.

Never fall through to the standalone installer after the Plugin path succeeds.

## DeepSeek Harness native Plugin path

When the target Host is DSH, prefer its native package and do not configure `dsh-mcp-client`:

1. Identify the exact active Profile; do not assume `web` when the user runs `tui` or `headless`.
2. Run `dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin` from the user's desktop session. Use an explicit version only for reproduction or rollback.
3. Completely restart that Profile and verify nine `isingq_*` tools, including `isingq_resource_list` and `isingq_resource_read`.
4. Ask for confirmation before calling `isingq_api_key_setup` when no valid local Key exists.

Do not load the native Plugin and the old MCP bridge in the same Profile. If both are present, verify the native path first and request approval before removing the old bridge through the official `dsh plugin` command.

## Standalone install or upgrade

If only the remote Skill page was loaded, clone the official `https://github.com/ising-tech/isingq-toolkit.git` repository first and reopen this local file. Never reconstruct or concatenate install scripts from the remote document.

Resolve scripts relative to this file. Replace `<target-host>` below with the Host for the current request: exactly one of `workbuddy`, `codex`, `claude-code`, `cursor`, `vscode`, `trae`, or `generic`. Then run the matching script yourself:

- macOS: `ISINGQ_MCP_TARGET_HOST='<target-host>' sh scripts/install-macos.sh`
- Linux desktop: `ISINGQ_MCP_TARGET_HOST='<target-host>' sh scripts/install-linux.sh`
- Windows PowerShell: `$env:ISINGQ_MCP_TARGET_HOST='<target-host>'; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1`

These repository-bundled scripts install the checked-out package with Node.js 18+ and npm; they do not download or execute a remote script. Do not ask the user to operate a terminal. Run in the user's desktop session. The scripts reuse an existing valid Key, prompt securely only when missing, and preserve local solve records. The equivalent portable command is `npx -y @ising-tech/isingq-mcp config --json --npx`.

For WorkBuddy, Codex, Claude Code, Cursor, and VS Code, the script writes only the selected Host config. For Trae or `generic`, it prints the direct stdio JSON but does not guess or write a private Host path; import it through that Host's MCP settings.

## Interpret the final state

Read the final JSON object and report every stage separately:

- `binary_installed`: native executable installed and hash-verified.
- `api_key_configured`: local Key exists and `self-check` passes.
- `host_registered`: selected Host source config was written/imported.
- `native_tools_loaded`: set true only after standard MCP exposes seven tools or native DSH exposes nine tools.
- `blocked_by` and `next_action`: exact blocker and user-approved next step.

Never say “installation complete” unless all four booleans are true. A Trae run normally returns `host_registered=false` until its MCP settings import is completed.

## Host verification

1. Completely restart the selected Host and let the user approve any trust prompt.
2. Confirm seven standard MCP tools with `outputSchema.type="object"`, or nine native DSH tools with typed outputs.
3. Call `isingq_knowledge_get` with `topic="company"`, then call `isingq_modeling_guide_get`; both are non-network smoke tests.
4. Do not submit a real solve only to test installation.

## Failure handling

- Sandbox denial: request the Host's explicit permission/allowlist for the exact script and user directories; never move the Key into the workspace as a workaround.
- `local_source_install_failed`: verify Node.js 18+, npm, and write permission for the user installation directory.
- npm package unavailable: use the checked-out local scripts or an official fixed-version Release; never invent a download origin.
- `host_config_write_denied`: show `isingq-mcp config --json` and use the Host MCP settings UI.
- Red dot/no tools: verify version and configured absolute path, restart the Host, approve trust, then inspect its MCP log.

The user only needs to say: “读取 `install-isingq-mcp` Skill，帮我安装并接入当前 Agent。”
