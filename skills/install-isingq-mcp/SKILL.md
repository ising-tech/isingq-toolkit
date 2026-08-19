---
name: install-isingq-mcp
description: Install, update, connect, or diagnose IsingQ tools through standard MCP, Codex Plugin, or the native DeepSeek Harness Plugin. Use when a user wants IsingQ available in an Agent Host.
---

# Install IsingQ MCP

中文版本：[SKILL.zh-CN.md](SKILL.zh-CN.md)

## Outcome

Make IsingQ available in the one Agent Host named by the user. Select exactly one distribution path, configure a personal API Key through private local input, verify native tools inside that Host, report the observed version and stop.

Host-specific config boundaries and fallbacks are in [HOSTS.md](HOSTS.md). Read only the section for the selected Host.

## Non-negotiable boundaries

- Never receive an IsingQ API Key in chat, command arguments, environment variables, logs, Host config, or Agent-visible output.
- If the user has no Key, direct them to `https://console.isingq.com/` and **Settings → API → Create API**. Never register, read, copy, or expose it for them.
- Ask before opening the operating system's private API Key prompt. Use `force=true` only when the user explicitly asks to replace an existing Key.
- Configure only the Host from the current request. Do not detect installed apps and configure all of them.
- Never bypass a Host sandbox or move credentials into a project directory. Request access only to the exact user install, private config, and selected Host config locations required by the chosen path.
- Use only the official npm organization and `https://github.com/ising-tech/isingq-toolkit` as distribution origins.
- Do not submit a real solve as an installation test. A hand-written NDJSON call proves process reachability, not Host integration.
- `isingq_solve_start` submits immediately after the Host permits it. Before calling it, the Agent must show the model summary and matrix SHA-256 and obtain explicit user confirmation.

## Choose one distribution path

Preserve an already working distribution when updating. Switch paths only when the user requests it or the existing path is unavailable.

Use this decision order:

1. **Codex Plugin** — current Codex session already exposes the Plugin's native `isingq_api_key_setup` tool.
2. **DSH Plugin** — the selected Host is DeepSeek Harness.
3. **npx** — the selected Host is a standard stdio MCP Host and Node.js 18+ with npm is available.
4. **Release** — the selected Host is a standard stdio MCP Host but Node.js 18+ is unavailable or the user prefers a standalone binary.
5. **source** — the user explicitly requests source development, or npm and Release are unavailable and an official checkout is already available.

After one path reaches its acceptance criteria, stop. Do not install another Plugin, MCP bridge, binary, or npm runtime as a second path.

## Codex Plugin path

1. Do not download a binary or edit Codex MCP configuration. The installed Plugin already registers its bundled source MCP.
2. Verify seven native `isingq` tools and obtain the loaded server or Plugin version.
3. With user approval, call parameter-free `isingq_api_key_setup`. Existing readable local configuration may return `already_configured`.
4. Call `isingq_knowledge_get` with `topic="company"` as the non-network smoke test.

If the native tool is not already visible, this path is not selected. Do not infer that a Plugin is installed merely from files on disk.

## DSH Plugin path

1. Identify the exact active Profile; do not assume `web`, `tui`, or `headless`.
2. Run `dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin`. Add an explicit version only for reproduction or rollback.
3. Restart that Profile and verify nine `isingq_*` tools, including `isingq_resource_list` and `isingq_resource_read`. Record the installed package version.
4. With user approval, call `isingq_api_key_setup`, then call `isingq_knowledge_get` with `topic="company"`.

Do not enable the native Plugin and the legacy MCP bridge in the same Profile. Removing an old bridge is a separate mutation and requires user approval.

## Standard MCP with npx

1. Confirm Node.js 18+ and npm without changing global packages.
2. For a supported named Host, run `npx @ising-tech/isingq-mcp configure-host --name <host> --npx`.
3. For a Host that requires manual registration, run `npx @ising-tech/isingq-mcp config --json --npx` and import the exact stdio JSON through its official MCP settings.
4. Reconnect `isingq`. Restart the Host only if it cannot reload MCP dynamically or still exposes a stale version.
5. Verify seven native tools and the server version inside the Host. Then, with user approval, call `isingq_api_key_setup` and run the local knowledge smoke test.

Do not run `setup`, pass a Key through stdin, or place a Key in the MCP JSON. The loaded tool owns private Key setup.

## Standard MCP with a Release binary

1. Select the current OS and architecture asset from the official GitHub Release: macOS arm64/x64, Linux arm64/x64, or Windows x64.
2. Download the fixed-version binary and that Release's `SHA256SUMS`. Verify the binary before execution; stop on any mismatch.
3. Install it in a user-owned program directory. Do not require administrator privileges or add broad PATH changes.
4. Register its absolute path with the `serve` argument in only the selected Host. If the Host cannot be written automatically, import the exact JSON through its official MCP settings.
5. Reconnect, verify seven native tools and the binary/server version, then configure the Key through `isingq_api_key_setup` with user approval.

Checksum verification belongs only to the Release path. Never claim that npm, Plugin, or source installation was Release-hash-verified.

## Source path

Use source only for development or as the declared fallback above. If the Skill was read remotely and source is selected, clone the official repository and reopen this local file; never reconstruct scripts from documentation.

Run the repository script for the current desktop OS with exactly one target Host:

- macOS: `ISINGQ_MCP_TARGET_HOST='<target-host>' sh scripts/install-macos.sh`
- Linux desktop: `ISINGQ_MCP_TARGET_HOST='<target-host>' sh scripts/install-linux.sh`
- Windows PowerShell: `$env:ISINGQ_MCP_TARGET_HOST='<target-host>'; powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-windows.ps1`

The source scripts require Node.js 18+ and npm, install only the checked-out tree, preserve local records, and may open the private Key prompt. They do not perform Release checksum verification.

## Acceptance state

Report one final object using this path-neutral schema:

```json
{
  "distribution_mode": "codex-plugin | dsh-plugin | npx | release | source",
  "runtime_available": true,
  "api_key_configured": true,
  "host_registered": true,
  "tools_loaded": true,
  "loaded_version": "<observed-version>",
  "blocked_by": null,
  "next_action": null
}
```

- `runtime_available`: the selected Plugin/package/binary/server can actually initialize; it does not mean a native binary exists.
- `api_key_configured`: a non-empty local Key is privately stored and readable. It does not prove that the Key is accepted by the remote API.
- `host_registered`: the selected Host accepted the source configuration, manual import, or native Plugin registration.
- `tools_loaded`: the Host exposes seven standard MCP tools or nine native DSH tools. A CLI or NDJSON harness test cannot set this to true.
- `loaded_version`: the version observed from the loaded server, Plugin manager, or binary. Do not substitute a version merely read from repository files.
- `blocked_by`: a stable machine-readable blocker, or null.
- `next_action`: the smallest user-approved action that can clear the blocker, or null.

Say **connected** only when `runtime_available`, `host_registered`, and `tools_loaded` are true. Say **ready to solve** only when those three fields and `api_key_configured` are true and `loaded_version` was observed.

If the user declines private Key setup, report the tools as connected but not ready to solve. Never mark a configured Key as remotely valid until a user-requested API operation actually succeeds.

## Verification and updates

1. Reconnect before restarting. Let the user approve any Host trust prompt.
2. Confirm tool count and typed schemas in the actual Host.
3. Run `isingq_knowledge_get(topic="company")` and `isingq_modeling_guide_get`; both are local, non-network checks.
4. For updates, preserve the current distribution mode and local data. Verify the loaded version after reload; a package-manager or repository version alone is insufficient.

## Failure handling

- **Sandbox denial**: request access only to the exact path and operation; never change credential location as a workaround.
- **npm unavailable or Node too old**: select the Release path instead of installing Node without the user's request.
- **Host config write denied**: output the exact stdio JSON and use the Host's official MCP settings.
- **Checksum mismatch**: delete the untrusted download and stop; do not execute it or switch to an unverified mirror.
- **No tools or stale version**: inspect the Host's source config and MCP log, reconnect, then restart only if needed.
- **API Key configured but rejected**: report the remote authentication error and direct the user to replace or revoke the Key in IsingQ Cloud.
