# IsingQ Toolkit

English | [简体中文](README.md)

IsingQ Toolkit is a public, local-first Agent toolkit maintained by Beijing Ising Intelligence Technology Co., Ltd. It helps an Agent formulate scheduling, routing, portfolio, graph, and other optimization problems as QUBO models and, after user confirmation, solve them with the user's own IsingQ API Key.

- Modeling guidance, QUBO generation, validation, and result storage run on the user's computer.
- Only a user-confirmed solve matrix is sent to IsingQ over HTTPS.
- Supports WorkBuddy, Codex, Claude Code, Cursor, VS Code, Trae, and DeepSeek Harness.
- The standard MCP exposes seven tools and 13 local Resources; the native DSH Plugin exposes nine tools.
- The cloud API currently supports up to 2,048 QUBO binary variables.

## Before installation: get an IsingQ API Key

A personal IsingQ API Key is required for real solving. Knowledge lookup, modeling guidance, and QUBO validation do not require a Key.

1. Open the [IsingQ Cloud Console](https://console.isingq.com/) and register or sign in.
2. Go to **Settings → API**.
3. Select **Create API**, enter a recognizable API name, and complete creation.
4. During installation, store the API Key through the operating system's secure input prompt.

The same creation path is documented in the “Settings” section of the [IsingQ Cloud privacy policy](https://docs.isingq.com/privacy_policy.html).

Never paste an API Key into an Agent chat, command argument, MCP JSON, issue, or log. If a Key is exposed, delete it under **Settings → API** in the cloud console and create a replacement.

## Recommended: ask your Agent to read the Skill

Send this prompt to the Agent you want to configure:

```text
Read skills/install-isingq-mcp/SKILL.md from https://github.com/ising-tech/isingq-toolkit and follow it exactly. Install IsingQ MCP and connect only the current Agent. Never ask for or display my API Key in chat; use the operating system's secure input prompt when a Key is required. After installation, wait for me to restart the Agent, then verify that seven MCP tools are loaded.
```

The Skill selects the current operating system and current Agent. It does not configure every Agent merely because multiple applications are installed. Trae requires importing the generated stdio JSON through its MCP settings UI.

A successful installation means:

- The executable is installed and hash-verified.
- A valid API Key exists locally.
- The current Agent has registered the MCP.
- After restart, the standard MCP exposes seven tools, or the native DSH Plugin exposes nine.

## Install from GitHub source

The public repository can be tested directly. Node.js 18 or newer is required:

```bash
git clone https://github.com/ising-tech/isingq-toolkit.git
cd isingq-toolkit
npm ci
npm install -g .
isingq-mcp setup
isingq-mcp self-check --json
```

`isingq-mcp setup` reads the API Key without echoing it. Configure only the Agent you use:

```bash
isingq-mcp configure-host --name workbuddy
```

Supported names are `workbuddy`, `codex`, `claude-code`, `cursor`, `vscode`, and `generic`. For Trae or another Host, print standard MCP configuration and import it manually:

```bash
isingq-mcp config --json
```

Generic stdio configuration:

```json
{
  "mcpServers": {
    "isingq": {
      "command": "isingq-mcp",
      "args": ["serve"]
    }
  }
}
```

Fully quit and restart the Agent after configuration.

## npm, Releases, and DSH

With Node.js 18 or newer, install and configure directly through npm/npx:

```bash
npx @ising-tech/isingq-mcp setup
npx @ising-tech/isingq-mcp configure-host --name generic --npx
```

Replace `generic` with the Agent you actually use: `workbuddy`, `codex`, `claude-code`, `cursor`, or `vscode`. Keep `generic` for Trae and import the generated stdio JSON.

Users who do not want Node.js can download a fixed-version executable from [GitHub Releases](https://github.com/ising-tech/isingq-toolkit/releases) and verify it with `SHA256SUMS`. Builds are provided for macOS arm64/x64, Linux arm64/x64, and Windows x64.

DeepSeek Harness uses the native Plugin without an MCP bridge:

```bash
dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin
```

Do not enable both the native IsingQ Plugin and the legacy MCP bridge in the same DSH Profile.

## Use it

After installation and restart, describe the problem in natural language; tool names do not need to be memorized:

```text
Formulate this scheduling problem as a QUBO. Explain the variables, objective, constraints, and penalties first. Wait for my confirmation before submitting it to IsingQ:

Exactly one of tasks A and B may be selected. A has value 8 and B has value 5.
```

The Agent should model and validate first, then show the variable mapping, objective, constraints, penalties, matrix summary, and SHA-256. A solve is submitted only after explicit confirmation and an operating-system confirmation prompt.

The local public knowledge package can also answer questions:

```text
What capabilities does IsingQ Cloud currently provide? Include the knowledge version, sources, and answer boundaries.
```

## Tools

| Tool | Purpose | Network |
| --- | --- | --- |
| `isingq_api_key_setup` | Open a secure OS prompt to configure or replace a personal API Key | No |
| `isingq_knowledge_get` | Query public company, product, technology, case, FAQ, and source knowledge | No |
| `isingq_modeling_guide_get` | Return QUBO modeling steps and constraints | No |
| `isingq_qubo_validate` | Validate a QUBO and produce a matrix summary | No |
| `isingq_solve_start` | Submit to IsingQ after user confirmation | Yes |
| `isingq_solve_poll` | Poll task state once and store the result locally | Yes |
| `isingq_solve_result_get` | Read a locally stored solve result | No |

Solve results retain both:

- IsingQ provider energy: `E(s) = -1/2 · Σ_i Σ_j J_ij s_i s_j - Σ_i h_i s_i`.
- The objective recomputed from the QUBO: `f(x) = offset + Σ_i Q_ii x_i + Σ_{i<j} Q_ij x_i x_j`.

They can differ because of variable conversion, constant offsets, or coefficient conventions. A minimum energy does not by itself establish business feasibility, global optimality, or specific hardware performance.

## Data and security

- The API Key is stored only in a private local file and is never a tool parameter or chat value.
- Modeling guidance, QUBO validation, and public knowledge lookup run locally.
- Only `isingq_solve_start` sends a matrix, after user confirmation.
- API traffic uses HTTPS; matrix upload uses short-lived credentials and does not carry the personal API Key.
- Local records contain models, task IDs, and results, but never the API Key.

See the [Security Policy](SECURITY.md) for additional boundaries.

## Upgrade and multiple Agents

- Rerun the installation Skill or reinstall the npm/Release package to upgrade.
- Existing API Keys and local solve records are preserved.
- One executable per computer is enough; register the same executable separately with each Agent.
- Fully restart an Agent after changing its MCP configuration.

## Troubleshooting

- **No API Key**: open [IsingQ Cloud](https://console.isingq.com/) and use **Settings → API → Create API**.
- **No tools in the Agent**: verify the configuration, fully restart the Agent, and approve its MCP trust prompt.
- **Sandbox blocks writes**: approve only the exact install and user configuration directories; never move the API Key into the project.
- **Trae cannot register automatically**: run `isingq-mcp config --json` and import it through Trae's MCP settings.
- **Only an NDJSON response was tested**: that proves process reachability only; integration is complete only when the Agent exposes seven native tools.

## Developer documentation

Architecture, package boundaries, the QUBO data contract, builds, and releases are documented in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

This project is licensed under the [Apache License 2.0](LICENSE). The license does not grant rights to IsingQ or Ising Intelligence trademarks.
