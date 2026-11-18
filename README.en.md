<p align="center">
  <img src="https://raw.githubusercontent.com/ising-tech/isingq-toolkit/main/docs/assets/isingq-logo.png" width="500" alt="伊辛智能 · ISING INTELLIGENT">
</p>

<h1 align="center">IsingQ Toolkit</h1>

> This guide covers **0.9.x**. Install only versions actually published on [npm](https://www.npmjs.com/package/@ising-tech/isingq-mcp) or [GitHub Releases](https://github.com/ising-tech/isingq-toolkit/releases). A source checkout does not establish release availability; verify the version loaded by your Host.

<p align="center">
  QUBO modeling and validation for AI Agents, with cloud or private-network local solving
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
  <img src="https://raw.githubusercontent.com/ising-tech/isingq-toolkit/main/docs/assets/isingq-toolkit-capabilities-demo.gif" width="800" alt="Modeling and solving demo (historical workflow)">
</p>

> Historical workflow demos. Use current tool counts.

Supports standard MCP, Codex Plugin, and the native DeepSeek Harness Plugin.

## Quick start

Send this to your current Agent:

```text
Read skills/install-isingq-mcp/SKILL.md in
https://github.com/ising-tech/isingq-toolkit and install IsingQ MCP
only into this Agent. Reconnect and verify the tools for the loaded version and entrypoint.
Local solving needs no cloud API Key. Configure one through the private prompt only for cloud use.
Never request or display my API Key in chat.
```

For manual standard MCP setup, use Node.js 18.17+ and npm:

```bash
npx @ising-tech/isingq-mcp configure-host --name generic --npx
```

Import the returned stdio JSON through your Host's MCP settings and reconnect `isingq`. Restart only if the Host cannot reload dynamically. Replace `generic` with `workbuddy`, `codex`, `claude-code`, `cursor`, or `vscode` to configure that specific Host.

npm/npx installs published packages. Before using the 0.9.x features below, confirm the loaded version is at least 0.9. For an unpublished local candidate, follow the [development guide](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/DEVELOPMENT.md).

Other installation options:

- **Without Node.js**: download the appropriate standalone program from [GitHub Releases](https://github.com/ising-tech/isingq-toolkit/releases), verify it with that Release's `SHA256SUMS`, and register its `serve` entrypoint.
- **Codex Plugin**: run `codex plugin marketplace add ising-tech/isingq-toolkit --ref main`, then `codex plugin add isingq-mcp@isingq-toolkit`. Verify the connection in a new task.
- **DeepSeek Harness**: use the [native Plugin](https://github.com/ising-tech/isingq-toolkit/tree/main/packages/dsh-plugin#readme). Avoid enabling an IsingQ MCP bridge in the same Profile.

### Installation demo

<p align="center">
  <img src="https://raw.githubusercontent.com/ising-tech/isingq-toolkit/main/docs/assets/isingq-toolkit-install-demo.gif" width="800" alt="Installation demo (historical workflow)">
</p>

## Basic use

Describe your problem, for example:

```text
Split A, B, C into two groups to maximize the crossing edge weight:
AB=3, AC=2, BC=1, with no group-size constraint.
Show the variables, objective, constraints, and matrix summary first.
At solve confirmation, let me choose a cloud model or local device and wait for my approval.
```

1. **Model**: the Agent presents the model. Modeling and validation need no cloud API Key.
2. **Choose a target**: cloud models and local devices appear at solve confirmation, with suitability advice before and after selection. Advice does not block your choice.
3. **Confirm and submit**: review the target, data destination, and resource use before explicitly confirming submission.
4. **Check the task**: ask the Agent for the call record or open the actual viewing location attached to that record.

| Target | Initial setup | Resource use | Task viewing location |
| --- | --- | --- | --- |
| Cloud | Create a personal API Key in the [cloud console](https://console.isingq.com/api-keys), then ask the Agent to open the private `isingq_api_key_setup` prompt | Choose a compute voucher or account balance before submission | The cloud entry recorded for that task |
| Local | Ask to add/manage local solvers; enter a connection name and service address on the configuration page and test the connection | Uses the selected device, without cloud vouchers or balance | The locally accessible address recorded for that task |

You can save multiple named local devices. Saving a connection does not submit a task. The public cloud model directory needs no personal Key; cloud task submission does. Keep API Keys out of chat, MCP JSON, and logs.

## Tools and versions

For 0.9.x, verify the entrypoint actually loaded by your Host:

| Entrypoint | Tool count |
| --- | ---: |
| Standard MCP default (`serve`) | 4 |
| Standard MCP technical (`serve --technical`) | 20 |
| Native DSH Plugin | 21 |

Default MCP exposes `isingq_api_key_setup`, `isingq_knowledge_get`, `isingq_modeling_guide_get`, and the unified `isingq_solve`. Normal use does not require the technical entrypoint.

## Updates and help

Toolkit's built-in version check provides notices. Installation and reload depend on your integration method. An expert-managed entrypoint maintains its tools under the expert's compatibility policy.

- **Missing tools or an unchanged version**: check the connection source and loaded version, reconnect, then restart if needed. Avoid duplicate entrypoints.
- **Local device unavailable**: check the network and service address, then test the connection on the management page. A cloud Key is unnecessary.
- **Cloud authentication failure**: replace the Key through the private prompt; never paste it into chat.

[Development and integration](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/DEVELOPMENT.md) · [Solver target API](https://github.com/ising-tech/isingq-toolkit/blob/main/docs/solver-targets.md) · [Core SDK](packages/core/README.md) · [Security](SECURITY.md) · [Apache-2.0](LICENSE)
