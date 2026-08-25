<p align="center">
  <img src="docs/assets/isingq-logo.png" width="500" alt="Beijing Ising Intelligent Technology">
</p>

<h1 align="center">IsingQ Toolkit</h1>

<p align="center">
  QUBO modeling, validation, and IsingQ solving for AI Agents
</p>

<p align="center">
  <a href="README.md">简体中文</a> · English ·
  <a href="#quick-start">Quick start</a> ·
  <a href="https://console.isingq.com/">Get an API Key</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@ising-tech/isingq-dsh-plugin"><img src="https://img.shields.io/npm/v/@ising-tech/isingq-dsh-plugin?label=DSH%20Plugin" alt="IsingQ DSH Plugin npm version"></a>
</p>

<p align="center">
  <img src="docs/assets/isingq-toolkit-capabilities-demo.gif" width="800" alt="An Agent modeling and solving a QUBO with IsingQ Toolkit">
</p>

IsingQ Toolkit is a local Agent toolkit maintained publicly by Beijing Ising Intelligent Technology Co., Ltd.

Describe a scheduling, routing, portfolio, or graph optimization problem in natural language. Your Agent can help formulate a QUBO and solve it with your own IsingQ API Key.

- Modeling guidance, QUBO validation, and result records stay on your computer.
- A matrix is sent to IsingQ over HTTPS only when the solve tool is called.
- The API Key is stored in a private local file by default. A Headless administrator may instead inject it before the Agent process starts; the Agent must never request, set, or display it.
- Standard MCP, Codex Plugin, and native DeepSeek Harness Plugin integrations are supported.

## Quick start

If you do not want to manage terminals or MCP configuration, send this prompt to your current Agent:

```text
Read skills/install-isingq-mcp/SKILL.md from
https://github.com/ising-tech/isingq-toolkit and follow it exactly.
Install IsingQ MCP and connect only the current Agent.
Never ask for or display my API Key in chat; use the operating system's secure input prompt.
After installation, reconnect the isingq MCP first.
If the current Agent cannot reload MCP dynamically, wait for me to restart it,
then verify that seven MCP tools are loaded.
```

The installation Skill selects one integration for the current Agent and operating system. It does not modify every Agent installed on the computer. If a Host cannot register automatically, the Skill outputs stdio JSON for manual import.

A standard MCP Host should expose seven `isingq_*` tools after setup. The native DSH Plugin exposes nine tools.

### Installation demo

<p align="center">
  <img src="docs/assets/isingq-toolkit-install-demo.gif" width="800" alt="An Agent installing IsingQ Toolkit from the installation Skill">
</p>

## First solve

Public knowledge lookup, modeling guidance, and QUBO validation do not require an API Key. A personal IsingQ API Key is required only when submitting a real solve task.

1. Sign in or create an account at [IsingQ Cloud](https://console.isingq.com/).
2. Open **Settings → API → Create API** and create a personal API Key with a recognizable name.
3. Ask the Agent to call `isingq_api_key_setup`, then enter the Key in the operating system's secure input prompt.
4. Describe the optimization problem to the Agent.

Never paste an API Key into Agent chat, command arguments, MCP JSON, issues, or logs. If a Key is exposed, delete it in IsingQ Cloud and create a replacement.

When a Headless deployment cannot open a system prompt, its administrator may set `ISINGQ_API_KEY` before the Agent process starts. This is not an Agent installation step; the Agent must never read, set, or echo that variable.

Start with this example:

```text
Formulate the following problem as a QUBO. Explain the variables, objective, constraints, and penalties, and show the matrix summary. Wait for my confirmation before submitting it to IsingQ:

Exactly one of tasks A and B may be selected. A has value 8 and B has value 5.
```

The Agent should show the variable mapping, objective, constraints, penalties, matrix summary, and SHA-256 first. It should call `isingq_solve_start` only after you confirm.

Once the Host permits that tool call, it creates the remote task immediately. The MCP does not open an additional operating-system solve prompt; another confirmation appears only if the Host's tool-permission policy requires it.

## More capabilities

The Toolkit also includes local public knowledge and QUBO modeling guidance. For example:

```text
What capabilities does IsingQ Cloud currently provide? Include the knowledge version, official sources, and statement boundaries.
```

```text
Check this QUBO's dimensions, symmetry, coefficient range, and matrix summary. Do not submit it for solving.
```

The current cloud API supports up to 2,048 QUBO binary variables. Whether a problem fits depends on its formulation and the variables introduced by its constraints.

## Compatibility

| Integration | Intended Hosts | Node.js required |
| --- | --- | --- |
| Standard MCP | WorkBuddy, Claude Code, Cursor, VS Code, and other MCP Hosts | Node.js 18+ for npx; not required for Releases |
| Codex Plugin | Built-in Codex Plugin integration | No |
| Native DSH Plugin | DeepSeek Harness | Managed by DSH |

Standard MCP Release binaries support macOS arm64/x64, Linux arm64/x64, and Windows x64. One runtime per computer is sufficient; multiple Agents can register it independently.

## Other installation methods

The Agent Skill in Quick start is the recommended path for most users. The commands below are for users who want to manage installation or configuration manually.

### npm / npx

Requires Node.js 18 or later:

```bash
npx @ising-tech/isingq-mcp setup
npx @ising-tech/isingq-mcp configure-host --name generic --npx
```

Replace `generic` with a supported Host name when appropriate. Keep `generic` for Hosts that require manual registration, then import the generated stdio JSON through their MCP settings.

### GitHub Release

To run without Node.js, download the fixed-version binary for your system from [GitHub Releases](https://github.com/ising-tech/isingq-toolkit/releases) and verify it with the accompanying `SHA256SUMS` file.

### DeepSeek Harness

DSH uses its native Plugin and does not need an MCP bridge. Review the [npm package](https://www.npmjs.com/package/@ising-tech/isingq-dsh-plugin) and [complete usage guide](packages/dsh-plugin/README.md) before installation:

```bash
dsh plugin --profile <profile> add @ising-tech/isingq-dsh-plugin
```

Uninstall:

```bash
dsh plugin --profile <profile> remove @ising-tech/isingq-dsh-plugin
```

The minimum supported DeepSeek Harness baseline is `0.1.0-rc.7`, and the current development validation version is `0.1.0-rc.8`. The supported `@deepseek-ai/dsh-tools` range is `>=0.1.0-rc.7 <0.2.0-0`.

Do not enable both the native IsingQ Plugin and the legacy MCP bridge in the same DSH Profile. See the [DSH Plugin README](packages/dsh-plugin/README.md) for details.

### Source development

Source execution, architecture, package boundaries, and the Release process are documented in the [developer guide](docs/DEVELOPMENT.md). Source installation is not recommended for regular users.

## Tools

| Tool | Purpose | Network |
| --- | --- | --- |
| `isingq_api_key_setup` | Open a secure OS prompt to configure or replace a personal API Key | No |
| `isingq_knowledge_get` | Query public company, product, technology, case, FAQ, and source knowledge | No |
| `isingq_modeling_guide_get` | Return QUBO modeling steps and constraint guidance | No |
| `isingq_qubo_validate` | Validate a QUBO and produce a matrix summary | No |
| `isingq_solve_start` | Submit to IsingQ immediately after the Host permits the call | Yes |
| `isingq_solve_poll` | Query task status once and save the result | Yes |
| `isingq_solve_result_get` | Read a locally stored solve result | No |

The native DSH Plugin also provides `isingq_resource_list` and `isingq_resource_read` to list and read local, versioned public knowledge resources.

## Data and result conventions

- The API Key is read from a private local file by default. A Headless administrator may inject `ISINGQ_API_KEY` before process startup; the runtime does not persist that variable.
- The Agent must not receive, set, or print an API Key. The Key never enters tool arguments, chat, Host configuration, or logs.
- Production API traffic is pinned to `https://api.isingq.com`.
- Modeling guidance, QUBO validation, and public knowledge lookup run locally.
- `isingq_solve_start` sends the solve matrix after the Host permits the call.
- API traffic uses HTTPS; matrix upload uses short-lived credentials and does not carry the personal API Key.
- Local records contain models, task IDs, and results, but never the API Key.

Solve results retain two values.

**IsingQ provider energy**

```math
E(s) = -\frac{1}{2}\sum_i\sum_j J_{ij}s_i s_j - \sum_i h_i s_i
```

**Objective recomputed by the MCP**

```math
f(x) = \mathrm{offset} + \sum_i Q_{ii}x_i + \sum_{i \lt j} Q_{ij}x_i x_j
```

They can differ because of variable conversion, constant offsets, or coefficient conventions. The lowest energy does not automatically establish business feasibility, a global optimum, or specific hardware performance.

See the [Security Policy](SECURITY.md) for additional boundaries.

## Updates and troubleshooting

- **Update**: rerun the installation Skill, or update the npm package, Release binary, Codex Plugin, or DSH Plugin currently in use.
- **Existing data**: updates preserve the local API Key and solve records.
- **Tools are missing**: reconnect `isingq` and approve the Host's trust prompt; fully restart the Agent only if tools still do not load.
- **The Host cannot register automatically**: run `isingq-mcp config --json` and import the result through the Host's MCP settings.
- **Sandbox blocks writes**: approve only the exact installation and user configuration directories; never move the API Key into the project.
- **Only an NDJSON response was tested**: that proves process reachability only. Standard MCP integration is complete when the Agent exposes seven native tools.

## Project and development

Architecture, package boundaries, QUBO data contracts, builds, and the Release process are covered in the [developer guide](docs/DEVELOPMENT.md).

Report issues or suggestions through [GitHub Issues](https://github.com/ising-tech/isingq-toolkit/issues).

This project is licensed under the [Apache License 2.0](LICENSE). The license does not grant rights to IsingQ or Ising Intelligent trademarks.
